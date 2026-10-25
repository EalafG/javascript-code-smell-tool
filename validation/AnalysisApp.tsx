import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { SyntaxCode } from "../app/code-viewer";
import {
  ANALYSIS_SMELLS,
  agreementMetrics,
  binaryMetrics,
  buildComparisons,
  parseAnnotationCsv,
  parseReferenceCsv,
} from "./analysis";
import type { DetectorReference, ImportedAnnotation, MethodComparison, SourceSample } from "./analysis";
import type { Decision, SmellKey } from "./types";

function asset(fileName: string) {
  return new URL(`../${fileName}`, window.location.href).toString();
}

function formatRatio(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(3);
}

function formatPercent(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}

function decisionLabel(value: Decision | "tie" | "eligible" | "ineligible" | null) {
  if (!value) return "Missing";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function decisionClass(value: Decision | "tie" | "eligible" | "ineligible" | null) {
  return `analysis-decision analysis-decision--${value ?? "missing"}`;
}

function parseSources(value: unknown): SourceSample[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { samples?: unknown }).samples)) {
    throw new Error("The selected JSON must contain a samples array.");
  }
  const datasetSha256 = String((value as { study?: { datasetSha256?: unknown } }).study?.datasetSha256 ?? "");
  return ((value as { samples: Array<Record<string, unknown>> }).samples).map((sample) => ({
    sampleId: String(sample.sampleId ?? ""),
    datasetSha256,
    sourceSegment: String(sample.sourceSegment ?? ""),
    sourceContext: String(sample.sourceContext ?? sample.sourceSegment ?? ""),
  })).filter((sample) => sample.sampleId);
}

function downloadComparison(comparisons: MethodComparison[]) {
  const headers = [
    "SAMPLE_ID", "DATASET_METHOD_ID", "PROJECT", "FILE", "FUNCTION", "VALIDATOR_ID",
    "SAMPLE_DISPOSITION", "INELIGIBILITY_REASON", "INELIGIBILITY_DETAILS",
    ...ANALYSIS_SMELLS.flatMap((smell) => [
      `DETECTOR_${smell.detectorColumn}`,
      `VALIDATOR_${smell.annotationColumn}`,
      `CONSENSUS_${smell.annotationColumn}`,
    ]),
    "NOTES", "SUBMITTED_AT",
  ];
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = comparisons.flatMap((method) => method.annotations.map((annotation) => [
    method.sampleId,
    method.reference?.datasetMethodId ?? annotation.datasetMethodId,
    method.reference?.project ?? "",
    method.reference?.file ?? "",
    method.reference?.functionName ?? "",
    annotation.validatorId,
    annotation.sampleDisposition,
    annotation.ineligibilityReason,
    annotation.ineligibilityDetails,
    ...ANALYSIS_SMELLS.flatMap((smell) => [
      method.reference?.detector[smell.key] ?? "",
      annotation.decisions[smell.key],
      method.consensus[smell.key] ?? "",
    ]),
    annotation.notes,
    annotation.submittedAt,
  ]));
  const blob = new Blob([[headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "upm-validation-comparison.csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function OutcomeBadge({ method, smell }: { method: MethodComparison; smell: SmellKey }) {
  const consensus = method.consensus[smell];
  const detector = method.reference?.detector[smell];
  if (!method.annotations.some((annotation) => annotation.sampleDisposition === "eligible")) {
    return <span className={decisionClass("ineligible")}>Ineligible</span>;
  }
  if (consensus === "uncertain" || consensus === "tie" || consensus === null || detector === undefined) {
    return <span className={decisionClass(consensus)}>{decisionLabel(consensus)}</span>;
  }
  const observed = consensus === "present" ? 1 : 0;
  const outcome = detector === 1 && observed === 1 ? "TP" : detector === 0 && observed === 0 ? "TN" : detector === 1 ? "FP" : "FN";
  return <span className={`outcome-badge outcome-badge--${outcome.toLowerCase()}`}>{outcome}</span>;
}

export default function AnalysisApp() {
  const [annotations, setAnnotations] = useState<ImportedAnnotation[]>([]);
  const [references, setReferences] = useState<DetectorReference[]>([]);
  const [sources, setSources] = useState<SourceSample[]>([]);
  const [annotationFiles, setAnnotationFiles] = useState<string[]>([]);
  const [referenceFiles, setReferenceFiles] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [smellFilter, setSmellFilter] = useState<SmellKey | "all">("all");
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "agreement" | "disagreement" | "uncertain" | "ineligible">("all");

  const comparisons = useMemo(() => buildComparisons(annotations, references, sources), [annotations, references, sources]);
  const validators = useMemo(() => [...new Set(annotations.map((row) => row.validatorId))].sort(), [annotations]);
  const datasets = useMemo(() => [...new Set(annotations.map((row) => row.datasetSha256).filter(Boolean))], [annotations]);
  const matched = comparisons.filter((method) => method.reference).length;
  const latestJudgments = comparisons.flatMap((method) => method.annotations);
  const ineligibleReports = latestJudgments.filter((annotation) => annotation.sampleDisposition === "ineligible").length;
  const ineligibleMethods = comparisons.filter((method) => !method.annotations.some((annotation) => annotation.sampleDisposition === "eligible")).length;
  const metricRows = ANALYSIS_SMELLS.map((smell) => ({
    ...smell,
    performance: binaryMetrics(comparisons, smell.key),
    agreement: agreementMetrics(comparisons, smell.key),
  }));
  const availableF1 = metricRows.map((row) => row.performance.f1).filter((value): value is number => value !== null);
  const availableAlpha = metricRows.map((row) => row.agreement.krippendorffAlpha).filter((value): value is number => value !== null);
  const macroF1 = availableF1.length ? availableF1.reduce((sum, value) => sum + value, 0) / availableF1.length : null;
  const meanAlpha = availableAlpha.length ? availableAlpha.reduce((sum, value) => sum + value, 0) / availableAlpha.length : null;
  const filtered = comparisons.filter((method) => {
    const query = search.trim().toLowerCase();
    const searchable = `${method.sampleId} ${method.reference?.datasetMethodId ?? ""} ${method.reference?.project ?? ""} ${method.reference?.file ?? ""} ${method.reference?.functionName ?? ""}`.toLowerCase();
    if (query && !searchable.includes(query)) return false;
    const smells = smellFilter === "all" ? ANALYSIS_SMELLS.map((smell) => smell.key) : [smellFilter];
    if (outcomeFilter === "all") return true;
    if (outcomeFilter === "ineligible") return method.annotations.some((annotation) => annotation.sampleDisposition === "ineligible");
    return smells.some((smell) => {
      const consensus = method.consensus[smell];
      const detector = method.reference?.detector[smell];
      if (outcomeFilter === "uncertain") return consensus === "uncertain" || consensus === "tie" || consensus === null;
      if (detector === undefined || (consensus !== "present" && consensus !== "absent")) return false;
      const agrees = detector === (consensus === "present" ? 1 : 0);
      return outcomeFilter === "agreement" ? agrees : !agrees;
    });
  });

  async function loadAnnotations(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    if (!files.length) return;
    setError("");
    try {
      const parsed = (await Promise.all(files.map(async (file) => parseAnnotationCsv(await file.text(), file.name)))).flat();
      setAnnotations(parsed);
      setAnnotationFiles(files.map((file) => file.name));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The annotation files could not be read.");
    }
    event.target.value = "";
  }

  async function loadReferences(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    if (!files.length) return;
    setError("");
    try {
      const parsed = (await Promise.all(files.map(async (file) => parseReferenceCsv(await file.text(), file.name)))).flat();
      setReferences(parsed);
      setReferenceFiles(files.map((file) => file.name));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The detector reference could not be read.");
    }
    event.target.value = "";
  }

  async function loadSources(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      setSources(parseSources(JSON.parse(await file.text()) as unknown));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The blinded JSON could not be read.");
    }
    event.target.value = "";
  }

  return (
    <div className="analysis-app">
      <header className="analysis-topbar">
        <a className="brand" href="./" aria-label="Return to validation tool">
          <img src={asset("upm-logo.jpg")} alt="" />
          <span><strong>Validation Analysis</strong><small>Detector performance and inter-rater agreement</small></span>
        </a>
        <div className="topbar__actions">
          <span className="mode-badge mode-badge--local">Private browser analysis</span>
          <a className="button button--quiet" href="./">Validator workspace</a>
          <a className="button button--quiet" href="../">Detection tool</a>
        </div>
      </header>

      <main className="analysis-main">
        <section className="analysis-hero">
          <div>
            <p className="kicker">VALIDATION EVIDENCE</p>
            <h1>Compare expert judgments with detector predictions</h1>
            <p>Files are processed locally in this browser. Upload the private sampling manifest and every completed annotation CSV from the same validation study.</p>
          </div>
          {comparisons.length > 0 && <button className="button button--primary" type="button" onClick={() => downloadComparison(comparisons)}>Export merged comparison</button>}
        </section>

        <section className="analysis-imports" aria-label="Analysis inputs">
          <label className="analysis-upload">
            <span>1</span><strong>Detector evidence</strong>
            <small>Private sampling-manifest.csv or detector dataset CSV</small>
            <input type="file" accept=".csv,text/csv" multiple onChange={loadReferences} />
            <em>{referenceFiles.length ? `${referenceFiles.length} file${referenceFiles.length === 1 ? "" : "s"} loaded` : "Choose CSV file(s)"}</em>
          </label>
          <label className="analysis-upload">
            <span>2</span><strong>Validated datasets</strong>
            <small>Select all exported annotation CSV files together</small>
            <input type="file" accept=".csv,text/csv" multiple onChange={loadAnnotations} />
            <em>{annotationFiles.length ? `${annotationFiles.length} file${annotationFiles.length === 1 ? "" : "s"} · ${validators.length} validator${validators.length === 1 ? "" : "s"}` : "Choose multiple CSV files"}</em>
          </label>
          <label className="analysis-upload analysis-upload--optional">
            <span>3</span><strong>Source segments</strong>
            <small>Optional blinded validation-sample JSON for code display</small>
            <input type="file" accept=".json,application/json" onChange={loadSources} />
            <em>{sources.length ? `${sources.length} source segments loaded` : "Choose optional JSON"}</em>
          </label>
        </section>
        {error && <p className="analysis-error" role="alert">{error}</p>}

        {annotations.length > 0 && (
          <>
            <section className="analysis-cards" aria-label="Dataset summary">
              <article><span>Methods reviewed</span><strong>{comparisons.length.toLocaleString()}</strong></article>
              <article><span>Validator files</span><strong>{annotationFiles.length}</strong></article>
              <article><span>Unique validators</span><strong>{validators.length}</strong></article>
              <article><span>Dataset versions</span><strong>{datasets.length || 1}</strong></article>
              <article><span>Matched to detector</span><strong>{matched.toLocaleString()} <small>· {formatPercent(comparisons.length ? matched / comparisons.length : null)}</small></strong></article>
              <article><span>Latest judgments</span><strong>{latestJudgments.length.toLocaleString()}</strong></article>
              <article><span>Ineligible reports</span><strong>{ineligibleReports.toLocaleString()} <small>· {ineligibleMethods.toLocaleString()} method{ineligibleMethods === 1 ? "" : "s"} fully excluded</small></strong></article>
              <article><span>Macro F1</span><strong>{formatRatio(macroF1)}</strong></article>
              <article><span>Mean Krippendorff’s α</span><strong>{formatRatio(meanAlpha)}</strong></article>
            </section>

            <section className="analysis-panel">
              <div className="analysis-panel__heading"><div><p className="kicker">PERFORMANCE</p><h2>Detector versus expert consensus</h2></div><p>Uncertain judgments, tied consensus, and methods reported as ineligible are retained but excluded from binary metrics.</p></div>
              <div className="analysis-table-wrap">
                <table className="analysis-table">
                  <thead><tr><th>Smell</th><th>TP</th><th>TN</th><th>FP</th><th>FN</th><th>Excluded</th><th>Accuracy</th><th>Precision</th><th>Recall</th><th>Specificity</th><th>F1</th><th>Balanced accuracy</th><th>MCC</th></tr></thead>
                  <tbody>{metricRows.map((row) => <tr key={row.key}>
                    <th>{row.label}</th><td>{row.performance.tp}</td><td>{row.performance.tn}</td><td>{row.performance.fp}</td><td>{row.performance.fn}</td><td>{row.performance.uncertain + row.performance.ties + row.performance.ineligible}</td>
                    <td>{formatRatio(row.performance.accuracy)}</td><td>{formatRatio(row.performance.precision)}</td><td>{formatRatio(row.performance.recall)}</td><td>{formatRatio(row.performance.specificity)}</td><td>{formatRatio(row.performance.f1)}</td><td>{formatRatio(row.performance.balancedAccuracy)}</td><td>{formatRatio(row.performance.mcc)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </section>

            <section className="analysis-panel">
              <div className="analysis-panel__heading"><div><p className="kicker">RELIABILITY</p><h2>Inter-rater agreement</h2></div><p>Present, Absent, and Uncertain are retained as nominal categories. Ineligible reports are excluded. At least two eligible ratings per method are required.</p></div>
              <div className="analysis-table-wrap">
                <table className="analysis-table analysis-table--compact">
                  <thead><tr><th>Smell</th><th>Methods with 2+ ratings</th><th>Total ratings</th><th>Pairwise agreement</th><th>Krippendorff’s α</th><th>Fleiss’ κ</th></tr></thead>
                  <tbody>{metricRows.map((row) => <tr key={row.key}><th>{row.label}</th><td>{row.agreement.units}</td><td>{row.agreement.ratings}</td><td>{formatPercent(row.agreement.percentAgreement)}</td><td>{formatRatio(row.agreement.krippendorffAlpha)}</td><td>{formatRatio(row.agreement.fleissKappa)}</td></tr>)}</tbody>
                </table>
              </div>
            </section>

            <section className="analysis-panel">
              <div className="analysis-panel__heading analysis-panel__heading--filters">
                <div><p className="kicker">METHOD REVIEW</p><h2>Every judgment, method by method</h2></div>
                <div className="analysis-filters">
                  <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search method, file, project, or ID" aria-label="Search comparisons" />
                  <select value={smellFilter} onChange={(event) => setSmellFilter(event.target.value as SmellKey | "all")} aria-label="Filter by smell"><option value="all">All smells</option>{ANALYSIS_SMELLS.map((smell) => <option value={smell.key} key={smell.key}>{smell.label}</option>)}</select>
                  <select value={outcomeFilter} onChange={(event) => setOutcomeFilter(event.target.value as typeof outcomeFilter)} aria-label="Filter by outcome"><option value="all">All outcomes</option><option value="agreement">Agreement only</option><option value="disagreement">Disagreement only</option><option value="uncertain">Uncertain, tied, or missing</option><option value="ineligible">Reported sample issues</option></select>
                </div>
              </div>
              <div className="method-comparisons">
                {filtered.map((method) => (
                  <details className="method-comparison" key={`${method.datasetSha256}:${method.sampleId}`}>
                    <summary>
                      <span><strong>{method.sampleId} · {method.reference?.functionName || method.annotations[0]?.datasetMethodId}</strong><small>{method.reference?.project || "Unmatched"} · {method.reference?.file || "No detector reference"}{method.datasetSha256 ? ` · dataset ${method.datasetSha256.slice(0, 12)}…` : ""}</small></span>
                      <span className="method-outcomes">{ANALYSIS_SMELLS.map((smell) => <span key={smell.key}><small>{smell.label}</small><OutcomeBadge method={method} smell={smell.key} /></span>)}</span>
                    </summary>
                    <div className="method-comparison__body">
                      <div className="judgment-grid">
                        <table className="analysis-table">
                          <thead><tr><th>Validator</th><th>Sample status</th>{ANALYSIS_SMELLS.map((smell) => <th key={smell.key}>{smell.label}</th>)}<th>Sample issue / notes</th><th>Submitted</th></tr></thead>
                          <tbody>
                            <tr className="detector-row"><th>Detector</th><td>Prediction</td>{ANALYSIS_SMELLS.map((smell) => <td key={smell.key}><span className={decisionClass(method.reference ? method.reference.detector[smell.key] ? "present" : "absent" : null)}>{method.reference ? method.reference.detector[smell.key] ? "Present" : "Absent" : "Missing"}</span></td>)}<td>{method.reference?.smellTypes || "—"}</td><td>—</td></tr>
                            {method.annotations.map((annotation) => <tr key={annotation.annotationId}><th>{annotation.validatorId}</th><td><span className={decisionClass(annotation.sampleDisposition)}>{decisionLabel(annotation.sampleDisposition)}</span></td>{ANALYSIS_SMELLS.map((smell) => <td key={smell.key}>{annotation.sampleDisposition === "ineligible" ? <span className={decisionClass(null)}>Not rated</span> : <span className={decisionClass(annotation.decisions[smell.key])}>{decisionLabel(annotation.decisions[smell.key])}</span>}</td>)}<td className="notes-cell">{annotation.sampleDisposition === "ineligible" ? `${annotation.ineligibilityReason.replaceAll("_", " ")}${annotation.ineligibilityDetails ? `: ${annotation.ineligibilityDetails}` : ""}` : annotation.notes || "—"}</td><td>{annotation.submittedAt ? new Date(annotation.submittedAt).toLocaleString() : "—"}</td></tr>)}
                            <tr className="consensus-row"><th>Consensus</th><td>{method.annotations.some((annotation) => annotation.sampleDisposition === "eligible") ? "Eligible ratings" : "Excluded"}</td>{ANALYSIS_SMELLS.map((smell) => <td key={smell.key}><span className={decisionClass(method.annotations.some((annotation) => annotation.sampleDisposition === "eligible") ? method.consensus[smell.key] : "ineligible")}>{method.annotations.some((annotation) => annotation.sampleDisposition === "eligible") ? decisionLabel(method.consensus[smell.key]) : "Ineligible"}</span></td>)}<td colSpan={2}>Simple modal category; ties remain unresolved.</td></tr>
                          </tbody>
                        </table>
                      </div>
                      {method.source?.sourceSegment && <div className="analysis-source"><h3>Source segment</h3><SyntaxCode source={method.source.sourceSegment} startLine={method.reference?.startLine ?? 1} theme="light" label={`Source segment for ${method.sampleId}`} /></div>}
                    </div>
                  </details>
                ))}
                {!filtered.length && <p className="analysis-empty">No methods match the current filters.</p>}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

