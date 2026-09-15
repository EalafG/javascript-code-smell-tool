"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_THRESHOLDS,
  MethodResult,
  ParsedSource,
  SourceCategory,
  analyzeParsedSource,
  assignDeterministicIds,
  classifySourceCategory,
  classifyResult,
  createProjectAnalysisModel,
  deduplicateMethodResults,
  finalizeProjectAnalysisModel,
  indexParsedSource,
  parseJavaScriptSource,
} from "./analyzer";
import { downloadCsv, downloadParseFailuresCsv } from "./csv";
import { useCodeThemePreference } from "./code-theme";
import { CodeThemeToggle, SyntaxCode } from "./code-viewer";
import { ValidationSampleBuilder } from "./ValidationSampleBuilder";

type ParserApi = {
  parse: (source: string, options: Record<string, unknown>) => never;
  version?: string;
};

declare global {
  interface Window {
    acorn?: ParserApi;
  }
}

type ParserStatus = "loading" | "ready" | "unavailable" | "parse-error";
type ResultTab = "dataset" | "segments" | "distribution";
type StatusFilter = "all" | "clean" | "smelly";
type SmellFilter = "all" | "long" | "complex" | "conditional" | "envy";

type SelectedFile = {
  file: File;
  relativePath: string;
};

type ParseFailure = {
  file: string;
  message: string;
};

const SUPPORTED_EXTENSION = /\.(js|mjs|cjs|jsx)$/i;
const PAGE_SIZE = 100;
const publicAsset = (fileName: string) => `${import.meta.env.BASE_URL}${fileName}`;
const CATEGORY_LABELS: Record<Exclude<SourceCategory, "production">, string> = {
  test: "Tests and specs",
  fixture: "Fixtures",
  vendor: "Vendor code",
  benchmark: "Benchmarks",
  maintenance: "Maintenance scripts",
};

function loadScript(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-parser-source="${source}"]`);
    if (existing?.dataset.loaded === "true") return resolve();
    const script = existing ?? document.createElement("script");
    script.src = source;
    script.async = true;
    script.dataset.parserSource = source;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error(`Unable to load ${source}`)), { once: true });
    if (!existing) document.head.appendChild(script);
  });
}

function numberFromInput(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function MetricPill({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="metric-pill">
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function SmellBadges({ result }: { result: MethodResult }) {
  if (!result.isSmelly) return <span className="badge badge--clean">CLEAN</span>;
  return (
    <div className="badge-row">
      <span className="badge badge--smelly">SMELLY</span>
      {result.smellTypes.map((smell) => (
        <span className="badge badge--smell" key={smell}>{smell}</span>
      ))}
    </div>
  );
}

function ThresholdInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="threshold-field">
      <span>{label}</span>
      <input
        type="number"
        min="1"
        step="1"
        value={value}
        onChange={(event) => onChange(numberFromInput(event.target.value, value))}
      />
    </label>
  );
}

export default function Home() {
  const [parserStatus, setParserStatus] = useState<ParserStatus>("loading");
  const [parserVersion, setParserVersion] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [snippet, setSnippet] = useState("");
  const [projectName, setProjectName] = useState("javascript-project");
  const [ignoredFolders, setIgnoredFolders] = useState<Record<string, boolean>>({
    node_modules: true,
    dist: true,
    build: true,
    coverage: true,
  });
  const [excludedCategories, setExcludedCategories] = useState<Record<Exclude<SourceCategory, "production">, boolean>>({
    test: false,
    fixture: false,
    vendor: false,
    benchmark: false,
    maintenance: false,
  });
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [rawResults, setRawResults] = useState<MethodResult[]>([]);
  const [parseFailures, setParseFailures] = useState<ParseFailure[]>([]);
  const [filesAnalyzed, setFilesAnalyzed] = useState(0);
  const [filesSubmitted, setFilesSubmitted] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [inputMessage, setInputMessage] = useState("");
  const [activeTab, setActiveTab] = useState<ResultTab>("dataset");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [smellFilter, setSmellFilter] = useState<SmellFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showAdvancedMetrics, setShowAdvancedMetrics] = useState(false);
  const [showSampleBuilder, setShowSampleBuilder] = useState(false);
  const [codeTheme, setCodeTheme] = useCodeThemePreference();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function prepareParser() {
      setParserStatus("loading");
      const sources = [
        publicAsset("acorn.min.js"),
        "https://cdn.jsdelivr.net/npm/acorn@8/dist/acorn.min.js",
        "https://unpkg.com/acorn@8/dist/acorn.js",
      ];
      for (const source of sources) {
        try {
          await loadScript(source);
          if (window.acorn?.parse) {
            if (!cancelled) {
              setParserVersion(window.acorn.version ? `Acorn ${window.acorn.version}` : "Acorn 8+");
              setParserStatus("ready");
            }
            return;
          }
        } catch {
          // Continue to the next deterministic parser source.
        }
      }
      if (!cancelled) setParserStatus("unavailable");
    }
    prepareParser();
    return () => { cancelled = true; };
  }, []);

  const results = useMemo(
    () => rawResults.map((result) => classifyResult(result, thresholds)),
    [rawResults, thresholds],
  );

  const activeFiles = useMemo(() => selectedFiles.filter(({ relativePath }) => {
    const pathParts = relativePath.replace(/\\/g, "/").split("/").map((part) => part.toLowerCase());
    if (Object.entries(ignoredFolders).some(([folder, enabled]) => enabled && pathParts.includes(folder))) {
      return false;
    }
    const category = classifySourceCategory(relativePath);
    return category === "production" || !excludedCategories[category];
  }), [selectedFiles, ignoredFolders, excludedCategories]);

  const skippedFileCount = selectedFiles.length - activeFiles.length;

  const exportContext = useMemo(() => ({
    thresholds,
    parserVersion: parserVersion || "Acorn 8+",
    selectedFileCount: filesSubmitted,
    successfulFileCount: filesAnalyzed,
    parseFailureCount: parseFailures.length,
  }), [thresholds, parserVersion, filesSubmitted, filesAnalyzed, parseFailures.length]);

  const stats = useMemo(() => {
    const count = (predicate: (result: MethodResult) => boolean) => results.filter(predicate).length;
    const smelly = count((result) => result.isSmelly);
    return {
      methods: results.length,
      clean: results.length - smelly,
      smelly,
      long: count((result) => result.isLongMethod),
      complex: count((result) => result.isComplexMethod),
      conditional: count((result) => result.isComplexConditional),
      envy: count((result) => result.isFeatureEnvy),
    };
  }, [results]);

  const filteredResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    return results.filter((result) => {
      if (statusFilter === "clean" && result.isSmelly) return false;
      if (statusFilter === "smelly" && !result.isSmelly) return false;
      if (smellFilter === "long" && !result.isLongMethod) return false;
      if (smellFilter === "complex" && !result.isComplexMethod) return false;
      if (smellFilter === "conditional" && !result.isComplexConditional) return false;
      if (smellFilter === "envy" && !result.isFeatureEnvy) return false;
      if (query && !`${result.relativePath} ${result.functionName}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [results, search, smellFilter, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredResults.length / PAGE_SIZE));
  const visibleResults = filteredResults.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function addFiles(event: ChangeEvent<HTMLInputElement>, folderSelection: boolean) {
    const files = Array.from(event.target.files ?? []).filter((file) => SUPPORTED_EXTENSION.test(file.name));
    const incoming = files.map((file) => ({
      file,
      relativePath: folderSelection
        ? ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replace(/\\/g, "/")
        : file.name,
    }));
    setSelectedFiles((current) => {
      const unique = new Map<string, SelectedFile>();
      for (const item of [...current, ...incoming]) {
        unique.set(`${item.relativePath}\u0000${item.file.size}\u0000${item.file.lastModified}`, item);
      }
      return [...unique.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    });
    if (folderSelection && incoming[0]?.relativePath.includes("/")) {
      const inferredProject = incoming[0].relativePath.split("/")[0];
      setProjectName((current) => current === "javascript-project" ? inferredProject : current);
    }
    setInputMessage(files.length ? "" : "No supported JavaScript files were found in that selection.");
    event.target.value = "";
  }

  async function runAnalysis() {
    if (!window.acorn?.parse || parserStatus === "loading" || parserStatus === "unavailable") {
      setInputMessage("The JavaScript parser is not available yet.");
      return;
    }

    const sourceEntries: Array<{
      fileName: string;
      relativePath: string;
      read: () => Promise<string>;
    }> = activeFiles.map(({ file, relativePath }) => ({
      fileName: file.name,
      relativePath,
      read: () => file.text(),
    }));
    if (snippet.trim()) {
      sourceEntries.push({
        fileName: "pasted-snippet.js",
        relativePath: "pasted-snippet.js",
        read: async () => snippet,
      });
    }
    sourceEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    if (!sourceEntries.length) {
      setInputMessage("Select JavaScript files, a project folder, or paste a snippet first.");
      return;
    }

    setIsAnalyzing(true);
    setInputMessage("");
    setParseFailures([]);
    setParserStatus("ready");
    setFilesSubmitted(sourceEntries.length);
    setProgress({ current: 0, total: sourceEntries.length * 2 });

    const failures: ParseFailure[] = [];
    const collected: MethodResult[] = [];
    const parsedSources: ParsedSource[] = [];
    let successfulFiles = 0;
    let completedWork = 0;
    const totalWork = sourceEntries.length * 2;
    const inferenceModel = createProjectAnalysisModel("P-0001");

    for (const entry of sourceEntries) {
      try {
        const source = await entry.read();
        const descriptor = {
          project: projectName.trim() || "javascript-project",
          fileName: entry.fileName,
          relativePath: entry.relativePath,
        };
        const parsed = parseJavaScriptSource(window.acorn, source, descriptor);
        indexParsedSource(inferenceModel, parsed);
        parsedSources.push(parsed);
        completedWork += 1;
      } catch (error) {
        failures.push({
          file: entry.relativePath,
          message: error instanceof Error ? error.message : String(error),
        });
        completedWork += 2;
      }
      setProgress({ current: completedWork, total: totalWork });
      if (completedWork % 12 === 0) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    finalizeProjectAnalysisModel(inferenceModel);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    for (const parsed of parsedSources) {
      try {
        collected.push(...analyzeParsedSource(parsed, thresholds, inferenceModel));
        successfulFiles += 1;
      } catch (error) {
        failures.push({
          file: parsed.descriptor.relativePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      completedWork += 1;
      setProgress({ current: completedWork, total: totalWork });
      if (completedWork % 12 === 0) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    setRawResults(assignDeterministicIds(deduplicateMethodResults(collected)));
    setFilesAnalyzed(successfulFiles);
    setParseFailures(failures);
    setParserStatus(failures.length ? "parse-error" : "ready");
    setIsAnalyzing(false);
    setActiveTab("dataset");
  }

  const parserLabel = {
    loading: "Parser loading",
    ready: "Parser ready",
    unavailable: "Parser unavailable",
    "parse-error": "Parse error",
  }[parserStatus];

  const overviewCards = [
    ["Files analyzed", filesAnalyzed, parseFailures.length ? `${parseFailures.length} parse failure${parseFailures.length === 1 ? "" : "s"} isolated` : filesSubmitted ? "All submitted files parsed" : "Awaiting analysis"],
    ["Methods analyzed", stats.methods, filesAnalyzed ? `${(stats.methods / filesAnalyzed).toFixed(1)} methods per parsed file` : "Method-level dataset rows"],
    ["Clean", stats.clean, stats.methods ? `${((stats.clean / stats.methods) * 100).toFixed(1)}% of methods` : "0.0% of methods"],
    ["Smelly", stats.smelly, stats.methods ? `${((stats.smelly / stats.methods) * 100).toFixed(1)}% of methods` : "0.0% of methods"],
  ] as const;

  const smellCards = [
    ["Long Method", stats.long, "LOC"],
    ["Complex Method", stats.complex, "CYCLO"],
    ["Complex Conditional", stats.conditional, "CONDOPS_MAX"],
    ["Feature Envy", stats.envy, "ATFD · LAA · FDP"],
  ] as const;

  const distribution = [
    ["Long Method", stats.long, "distribution--red"],
    ["Complex Method", stats.complex, "distribution--maroon"],
    ["Complex Conditional", stats.conditional, "distribution--gray"],
    ["Feature Envy", stats.envy, "distribution--dark"],
  ] as const;

  return (
    <main>
      <header className="hero">
        <div className="hero__inner">
          <div className="upm-logo-wrap">
            <img src={publicAsset("upm-logo.jpg")} alt="Universiti Putra Malaysia" className="upm-logo" />
          </div>
          <div className="hero__copy">
            <p className="eyebrow">UPM · RESEARCH SOFTWARE</p>
            <h1>JavaScript Code Smell Detection Tool</h1>
            <p className="subtitle">
              Method-Level Detection of Long Method, Complex Method, Complex Conditional, and Feature Envy
            </p>
          </div>
          <div className="hero__tools">
            <a className="validation-link" href="./validation/">Open validation workspace</a>
            <div className={`parser-status parser-status--${parserStatus}`} role="status">
              <span aria-hidden="true" />
              <div>
                <strong>{parserLabel}</strong>
                <small>{parserStatus === "ready" ? `${parserVersion} · local first` : parserStatus === "parse-error" ? `${parseFailures.length} file failure${parseFailures.length === 1 ? "" : "s"}` : "Local → CDN fallback"}</small>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="page-shell">
        <section className="panel intake-panel" aria-labelledby="source-heading">
          <div className="section-heading">
            <div>
              <p className="section-kicker">01 · SOURCE</p>
              <h2 id="source-heading">Analyze JavaScript locally</h2>
              <p>
                Analyze files, a project folder, or a pasted JavaScript sample. Processing stays on this device.
              </p>
            </div>
            <button
              className="primary-button"
              type="button"
              onClick={runAnalysis}
              disabled={isAnalyzing || parserStatus === "loading" || parserStatus === "unavailable"}
            >
              {isAnalyzing ? `Analyzing ${progress.current}/${progress.total}` : "Analyze source"}
            </button>
          </div>

          <div className="project-row">
            <label>
              <span>Project name</span>
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="projectA" />
            </label>
            <div className="privacy-note"><span aria-hidden="true">●</span> Local browser analysis · no source upload</div>
          </div>

          <div className="input-grid">
            <button className="file-tile" type="button" onClick={() => fileInputRef.current?.click()}>
              <span className="tile-index">FILES</span>
              <strong>Select individual files</strong>
              <span>.js, .mjs, .cjs, .jsx</span>
            </button>
            <input
              className="visually-hidden"
              ref={fileInputRef}
              type="file"
              accept=".js,.mjs,.cjs,.jsx,text/javascript"
              multiple
              onChange={(event) => addFiles(event, false)}
            />
            <button className="file-tile" type="button" onClick={() => folderInputRef.current?.click()}>
              <span className="tile-index">FOLDER</span>
              <strong>Select an entire folder</strong>
              <span>Relative paths are preserved</span>
            </button>
            <input
              className="visually-hidden"
              ref={folderInputRef}
              type="file"
              accept=".js,.mjs,.cjs,.jsx,text/javascript"
              multiple
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(event) => addFiles(event, true)}
            />
            <div className="snippet-tile">
              <div className="snippet-heading">
                <label htmlFor="snippet">Paste JavaScript</label>
                <span>Optional quick test</span>
              </div>
              <textarea
                id="snippet"
                value={snippet}
                onChange={(event) => setSnippet(event.target.value)}
                spellCheck="false"
                placeholder={'function calculateTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}'}
              />
            </div>
          </div>

          <div className="selection-bar">
            <div>
              <strong>{activeFiles.length}</strong> supported file{activeFiles.length === 1 ? "" : "s"} ready
              {skippedFileCount > 0 && <span> · {skippedFileCount} ignored by active exclusion rules</span>}
            </div>
            {(selectedFiles.length > 0 || snippet) && (
              <button type="button" className="text-button" onClick={() => { setSelectedFiles([]); setSnippet(""); }}>
                Clear input
              </button>
            )}
          </div>

          <details className="source-options">
            <summary>
              <span>Exclusion options</span>
              <small>
                {Object.values(ignoredFolders).filter(Boolean).length} folder rules active · {Object.values(excludedCategories).filter(Boolean).length} categories excluded
              </small>
            </summary>
            <div className="source-options__body">
              <fieldset className="ignore-options">
                <legend>Skip dependency and generated directories</legend>
                {Object.keys(ignoredFolders).map((folder) => (
                  <label key={folder}>
                    <input
                      type="checkbox"
                      checked={ignoredFolders[folder]}
                      onChange={(event) => setIgnoredFolders((current) => ({ ...current, [folder]: event.target.checked }))}
                    />
                    <span>{folder}</span>
                  </label>
                ))}
              </fieldset>

              <fieldset className="ignore-options">
                <legend>Optionally exclude source categories</legend>
                {Object.entries(CATEGORY_LABELS).map(([category, label]) => (
                  <label key={category}>
                    <input
                      type="checkbox"
                      checked={excludedCategories[category as Exclude<SourceCategory, "production">]}
                      onChange={(event) => setExcludedCategories((current) => ({
                        ...current,
                        [category]: event.target.checked,
                      }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
            </div>
          </details>

          {isAnalyzing && (
            <div className="progress-track" aria-label={`Analyzed ${progress.current} of ${progress.total} files`}>
              <span style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }} />
            </div>
          )}
          {inputMessage && <p className="inline-message">{inputMessage}</p>}
        </section>

        <section aria-labelledby="rules-heading">
          <div className="section-heading compact-heading">
            <div>
              <p className="section-kicker">02 · DETECTION CONFIGURATION</p>
              <h2 id="rules-heading">Transparent, reproducible rules</h2>
              <p>Threshold changes reclassify the current dataset without changing the extracted metrics.</p>
            </div>
            <button className="secondary-button" type="button" onClick={() => setThresholds(DEFAULT_THRESHOLDS)}>
              Reset defaults
            </button>
          </div>

          <div className="rule-grid">
            <article className="rule-card">
              <div className="rule-card__top"><span>LM</span><small>Method size</small></div>
              <h3>Long Method</h3>
              <p className="formula">LOC ≥ threshold</p>
              <ThresholdInput label="Code LOC threshold" value={thresholds.longLoc} onChange={(longLoc) => setThresholds((value) => ({ ...value, longLoc }))} />
              <p className="rule-note">Substantive code lines only.</p>
              <label className="switch-row">
                <input type="checkbox" checked={thresholds.longCompound} onChange={(event) => setThresholds((value) => ({ ...value, longCompound: event.target.checked }))} />
                <span>Use compound rule</span>
              </label>
              <div className={`compound-fields ${thresholds.longCompound ? "" : "compound-fields--disabled"}`}>
                <ThresholdInput label="CYCLO" value={thresholds.longCyclo} onChange={(longCyclo) => setThresholds((value) => ({ ...value, longCyclo }))} />
                <span className="operator-word">OR</span>
                <ThresholdInput label="Nesting" value={thresholds.longNesting} onChange={(longNesting) => setThresholds((value) => ({ ...value, longNesting }))} />
              </div>
              <details className="methodology-details">
                <summary>Metric definition</summary>
                <p>Blank, comment-only, and delimiter-only lines are excluded. SPAN_LOC and each excluded line category remain available in the detailed view and CSV.</p>
              </details>
            </article>

            <article className="rule-card">
              <div className="rule-card__top"><span>CM</span><small>Control flow</small></div>
              <h3>Complex Method</h3>
              <p className="formula">CYCLO ≥ threshold</p>
              <ThresholdInput label="Cyclomatic complexity" value={thresholds.complexCyclo} onChange={(complexCyclo) => setThresholds((value) => ({ ...value, complexCyclo }))} />
              <p className="rule-note">Counts decision constructs, switch cases, ternaries, and logical AND/OR operators. Baseline = 1.</p>
            </article>

            <article className="rule-card">
              <div className="rule-card__top"><span>CC</span><small>Expressions</small></div>
              <h3>Complex Conditional</h3>
              <p className="formula">CONDOPS_MAX ≥ threshold</p>
              <ThresholdInput label="Condition operators" value={thresholds.conditionalOps} onChange={(conditionalOps) => setThresholds((value) => ({ ...value, conditionalOps }))} />
              <p className="rule-note">Maximum operator count in one condition.</p>
              <details className="methodology-details">
                <summary>Operators and auxiliary comparison</summary>
                <p>The primary label counts !, &amp;&amp;, ||, equality, inequality, and relational operators. Switch cases affect CYCLO, not this metric.</p>
                <p className="formula formula--compact">Auxiliary: LOGICAL_OPS_MAX &gt; allowed maximum</p>
                <ThresholdInput label="Logical operators allowed" value={thresholds.conditionalLogicalOpsMax} onChange={(conditionalLogicalOpsMax) => setThresholds((value) => ({ ...value, conditionalLogicalOpsMax }))} />
                <p>The auxiliary Sonar-compatible comparison counts only &amp;&amp;, ||, and ternary operators. It does not alter CLEAN/SMELLY or the four primary labels.</p>
              </details>
            </article>

            <article className="rule-card">
              <div className="rule-card__top"><span>FE</span><small>Data locality</small></div>
              <h3>Feature Envy</h3>
              <p className="formula">ATFD &gt; FEW ∧ LAA &lt; ⅓ ∧ FDP ≤ FEW</p>
              <ThresholdInput label="FEW" value={thresholds.few} onChange={(few) => setThresholds((value) => ({ ...value, few }))} />
              <p className="rule-note">Project-wide, type-aware data locality.</p>
              <details className="methodology-details">
                <summary>Inference methodology</summary>
                <p>Paper-inspired static object-type inference uses one project-wide model. ATD/ATFD use distinct type-property tuples; member calls are included, array indices become <code>IDX</code>, and nested functions remain independent.</p>
                <p>Coverage, unresolved accesses, exact local-access counts, and inference provenance are exported. This is an approximation—not the paper&apos;s full JIPDA abstract interpreter.</p>
              </details>
            </article>
          </div>
        </section>

        <section className="results-section" aria-labelledby="summary-heading">
          <div className="section-heading compact-heading">
            <div>
              <p className="section-kicker">03 · ANALYSIS SUMMARY</p>
              <h2 id="summary-heading">Dataset overview</h2>
              <p>Counts update with the active thresholds; files with syntax errors are isolated and reported.</p>
            </div>
          </div>

          <div className="summary-grid">
            {overviewCards.map(([label, value, detail], index) => (
              <article className={`summary-card ${index === 3 ? "summary-card--accent" : ""}`} key={label}>
                <span>{label}</span>
                <strong>{value.toLocaleString()}</strong>
                <small>{detail}</small>
              </article>
            ))}
          </div>

          <div className="smell-summary-grid" aria-label="Primary smell counts">
            {smellCards.map(([label, value, metric]) => {
              const percentage = stats.methods ? (value / stats.methods) * 100 : 0;
              return (
                <article className="smell-summary-card" key={label}>
                  <div>
                    <span>{label}</span>
                    <small>{metric}</small>
                  </div>
                  <strong>{value.toLocaleString()}</strong>
                  <span>{percentage.toFixed(1)}%</span>
                </article>
              );
            })}
          </div>

          {parseFailures.length > 0 && (
            <details className="parse-failures" open>
              <summary>{parseFailures.length} source file{parseFailures.length === 1 ? "" : "s"} could not be parsed</summary>
              <p>These failures did not interrupt analysis of the remaining files.</p>
              <ul>
                {parseFailures.map((failure) => (
                  <li key={`${failure.file}-${failure.message}`}><strong>{failure.file}</strong><span>{failure.message}</span></li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="panel results-panel" aria-labelledby="results-heading">
          <div className="results-toolbar">
            <div>
              <p className="section-kicker">04 · METHOD RESULTS</p>
              <h2 id="results-heading">Research dataset</h2>
              <p>{filteredResults.length.toLocaleString()} of {results.length.toLocaleString()} method-level rows shown</p>
            </div>
            <div className="export-actions">
              <button className="secondary-button" type="button" disabled={!results.length} onClick={() => setShowSampleBuilder(true)}>Create validation sample</button>
              {parseFailures.length > 0 && (
                <button className="secondary-button" type="button" onClick={() => downloadParseFailuresCsv(
                  projectName.trim() || "javascript-project",
                  parseFailures,
                  parserVersion || "Acorn 8+",
                  "javascript-code-smell-parse-failures.csv",
                )}>Export parse failures</button>
              )}
              <button className="secondary-button" type="button" disabled={!results.length} onClick={() => downloadCsv(results, "javascript-code-smell-dataset.csv", exportContext)}>Export all CSV</button>
              <button className="primary-button" type="button" disabled={!filteredResults.length} onClick={() => downloadCsv(filteredResults, "javascript-code-smell-dataset-filtered.csv", exportContext)}>Export filtered CSV</button>
            </div>
          </div>

          <div className="tab-list" role="tablist" aria-label="Result views">
            {([
              ["dataset", "Dataset View"],
              ["segments", "Code Segments"],
              ["distribution", "Smell Distribution"],
            ] as const).map(([tab, label]) => (
              <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "active" : ""} onClick={() => { setActiveTab(tab); setPage(1); }}>{label}</button>
            ))}
          </div>

          {activeTab !== "distribution" && (
            <div className="filter-bar">
              <div className="segmented-control" aria-label="Clean or smelly filter">
                {(["all", "clean", "smelly"] as StatusFilter[]).map((filter) => (
                  <button type="button" key={filter} className={statusFilter === filter ? "active" : ""} onClick={() => { setStatusFilter(filter); setPage(1); }}>{filter === "all" ? "All" : filter === "clean" ? "Clean only" : "Smelly only"}</button>
                ))}
              </div>
              <label className="select-filter">
                <span>Smell</span>
                <select value={smellFilter} onChange={(event) => { setSmellFilter(event.target.value as SmellFilter); setPage(1); }}>
                  <option value="all">All four smells</option>
                  <option value="long">Long Method</option>
                  <option value="complex">Complex Method</option>
                  <option value="conditional">Complex Conditional</option>
                  <option value="envy">Feature Envy</option>
                </select>
              </label>
              <label className="search-field">
                <span className="visually-hidden">Search by file or function name</span>
                <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search file or function…" />
              </label>
              {activeTab === "dataset" && (
                <label className="metrics-toggle">
                  <input type="checkbox" checked={showAdvancedMetrics} onChange={(event) => setShowAdvancedMetrics(event.target.checked)} />
                  <span>Advanced metrics</span>
                </label>
              )}
            </div>
          )}

          {!results.length && (
            <div className="empty-state">
              <span>M-000000</span>
              <h3>No methods analyzed yet</h3>
              <p>Select source files or paste a snippet, confirm the thresholds, and run the analysis.</p>
            </div>
          )}

          {results.length > 0 && activeTab === "dataset" && (
            <div className="table-wrap">
              <table className={showAdvancedMetrics ? "table--advanced" : ""}>
                <thead>
                  <tr>
                    <th>ID / Method</th>
                    <th>File</th>
                    <th>Category</th>
                    <th>Type</th>
                    <th>Lines</th>
                    <th title="Substantive code lines">LOC</th>
                    <th>CYCLO</th>
                    <th>MAXNESTING</th>
                    <th>CONDOPS_MAX</th>
                    <th>ATFD</th>
                    <th>LAA</th>
                    <th>FDP</th>
                    {showAdvancedMetrics && (
                      <>
                        <th title="Inclusive physical line span">SPAN_LOC</th>
                        <th>COMMENT_LINES</th>
                        <th>BLANK_LINES</th>
                        <th>DELIMITER_LINES</th>
                        <th>NOP</th>
                        <th>NOLV</th>
                        <th>LOGICAL_OPS_MAX</th>
                        <th title="Auxiliary Sonar-compatible Complex Conditional label">SONAR_CC</th>
                        <th>COND_NESTING</th>
                        <th title="Access to data: distinct local and foreign type-property tuples">ATD</th>
                        <th>LOCAL_ACCESS_COUNT</th>
                        <th title="Resolved coupling tuples / all coupling tuples">TYPE_COVERAGE</th>
                        <th>UNKNOWN_ACCESSES</th>
                        <th>FOREIGN_MEMBER_CALLS</th>
                      </>
                    )}
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleResults.map((result) => (
                    <tr key={result.id}>
                      <td><small>{result.id}</small><strong>{result.functionName}</strong></td>
                      <td className="path-cell" title={result.relativePath}>{result.relativePath}</td>
                      <td>{result.codeCategory}</td>
                      <td>{result.functionType}</td>
                      <td>{result.startLine}–{result.endLine}</td>
                      <td>{result.loc}</td>
                      <td>{result.cyclo}</td>
                      <td>{result.maxNesting}</td>
                      <td>{result.condOpsMax}</td>
                      <td>{result.atfd}</td>
                      <td>{result.laa.toFixed(3)}</td>
                      <td title={result.foreignProviders.join(" | ")}>{result.fdp}</td>
                      {showAdvancedMetrics && (
                        <>
                          <td>{result.spanLoc}</td>
                          <td>{result.commentLines}</td>
                          <td>{result.blankLines}</td>
                          <td>{result.delimiterLines}</td>
                          <td>{result.nop}</td>
                          <td>{result.nolv}</td>
                          <td>{result.logicalOpsMax}</td>
                          <td>{Number(result.isComplexConditionalSonar)}</td>
                          <td>{result.condNesting}</td>
                          <td>{result.atd}</td>
                          <td>{result.localAccessCount}</td>
                          <td>{result.typeInferenceCoverage.toFixed(3)}</td>
                          <td>{result.unknownAccessCount}</td>
                          <td title={result.foreignCallProviders.join(" | ")}>{result.foreignMemberCalls}</td>
                        </>
                      )}
                      <td><SmellBadges result={result} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {results.length > 0 && activeTab === "segments" && (
            <div className="segments-list">
              <div className="segment-view-toolbar">
                <span>JavaScript syntax highlighting</span>
                <CodeThemeToggle theme={codeTheme} onChange={setCodeTheme} />
              </div>
              {visibleResults.map((result) => (
                <article className="segment-card" key={result.id}>
                  <div className="segment-card__header">
                    <div>
                      <p>{result.id} · {result.relativePath} · {result.codeCategory} · Lines {result.startLine}–{result.endLine}</p>
                      <h3>{result.functionName}</h3>
                    </div>
                    <SmellBadges result={result} />
                  </div>
                  <div className="metrics-strip">
                    <MetricPill label="LOC" value={result.loc} />
                    <MetricPill label="CYCLO" value={result.cyclo} />
                    <MetricPill label="MAXNESTING" value={result.maxNesting} />
                    <MetricPill label="CONDOPS_MAX" value={result.condOpsMax} />
                    <MetricPill label="ATFD" value={result.atfd} />
                    <MetricPill label="LAA" value={result.laa.toFixed(3)} />
                    <MetricPill label="FDP" value={result.fdp} />
                  </div>
                  <details className="segment-audit">
                    <summary>Advanced metrics and Feature Envy evidence</summary>
                    <div className="metrics-strip metrics-strip--advanced">
                      <MetricPill label="SPAN_LOC" value={result.spanLoc} />
                      <MetricPill label="COMMENT_LINES" value={result.commentLines} />
                      <MetricPill label="BLANK_LINES" value={result.blankLines} />
                      <MetricPill label="DELIMITER_LINES" value={result.delimiterLines} />
                      <MetricPill label="NOP" value={result.nop} />
                      <MetricPill label="NOLV" value={result.nolv} />
                      <MetricPill label="LOGICAL_OPS_MAX" value={result.logicalOpsMax} />
                      <MetricPill label="SONAR_CC" value={Number(result.isComplexConditionalSonar)} />
                      <MetricPill label="COND_NESTING" value={result.condNesting} />
                      <MetricPill label="ATD" value={result.atd} />
                      <MetricPill label="LOCAL_ACCESS_COUNT" value={result.localAccessCount} />
                      <MetricPill label="TYPE_COVERAGE" value={result.typeInferenceCoverage.toFixed(3)} />
                      <MetricPill label="UNKNOWN_ACCESSES" value={result.unknownAccessCount} />
                      <MetricPill label="FOREIGN_MEMBER_CALLS" value={result.foreignMemberCalls} />
                    </div>
                    {result.foreignProviders.length > 0 && <p className="provider-line"><strong>Foreign providers:</strong> {result.foreignProviders.join(" · ")}</p>}
                    {result.foreignCallProviders.length > 0 && <p className="provider-line"><strong>Foreign call providers:</strong> {result.foreignCallProviders.join(" · ")}</p>}
                    {result.couplingTuples.length > 0 && <p className="provider-line"><strong>Distinct coupling tuples:</strong> {result.couplingTuples.join(" · ")}</p>}
                  </details>
                  <SyntaxCode
                    source={result.source}
                    startLine={result.startLine}
                    theme={codeTheme}
                    label={`JavaScript source for ${result.functionName}`}
                    className="segment-code-view"
                  />
                </article>
              ))}
            </div>
          )}

          {results.length > 0 && activeTab === "distribution" && (
            <div className="distribution-view">
              <div className="distribution-copy">
                <p className="section-kicker">LABEL DISTRIBUTION</p>
                <h3>Smell occurrence by method</h3>
                <p>Counts overlap because one method can carry more than one smell label.</p>
              </div>
              <div className="distribution-bars">
                {distribution.map(([label, count, colorClass]) => {
                  const percentage = stats.methods ? (count / stats.methods) * 100 : 0;
                  return (
                    <div className="distribution-row" key={label}>
                      <div><strong>{label}</strong><span>{count.toLocaleString()} · {percentage.toFixed(1)}%</span></div>
                      <div className="distribution-track"><span className={colorClass} style={{ width: `${percentage}%` }} /></div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {results.length > 0 && activeTab !== "distribution" && totalPages > 1 && (
            <div className="pagination">
              <button type="button" disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button>
              <span>Page {page} of {totalPages} · {PAGE_SIZE} rows per page</span>
              <button type="button" disabled={page === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Next</button>
            </div>
          )}
        </section>

        <footer>
          <strong>JavaScript Code Smell Detection Tool</strong>
          <span>Acorn 8 · Method-level static analysis · Deterministic CSV schema</span>
        </footer>
      </div>
      {showSampleBuilder && (
        <ValidationSampleBuilder
          results={results}
          context={exportContext}
          onClose={() => setShowSampleBuilder(false)}
        />
      )}
    </main>
  );
}
