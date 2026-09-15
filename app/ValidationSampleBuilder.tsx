import { FormEvent, useEffect, useMemo, useState } from "react";
import type { MethodResult, SourceCategory } from "./analyzer";
import {
  SAMPLING_SMELLS,
  buildValidationSamplePackage,
  downloadSamplingPackage,
  previewSamplingPopulation,
  resolveProjectGrouping,
  samplingProjectFor,
} from "./validation-sampling";
import type {
  ProjectGrouping,
  SamplingBuildContext,
  SamplingPreset,
  ValidationSamplingConfig,
} from "./validation-sampling";

type Props = {
  results: MethodResult[];
  context: SamplingBuildContext;
  onClose: () => void;
};

const CATEGORY_OPTIONS: Array<{ value: SourceCategory; label: string }> = [
  { value: "production", label: "Production" },
  { value: "test", label: "Tests and specs" },
  { value: "fixture", label: "Fixtures" },
  { value: "vendor", label: "Vendor" },
  { value: "benchmark", label: "Benchmarks" },
  { value: "maintenance", label: "Maintenance scripts" },
];

const PRESETS: Array<{ value: SamplingPreset; label: string; detail: string }> = [
  { value: "pilot", label: "Pilot calibration", detail: "Positive, clean, multi-smell, and boundary coverage." },
  { value: "representative", label: "Representative", detail: "Natural distribution with project-proportional sampling." },
  { value: "audit", label: "Detector audit", detail: "Controlled predicted-smelly/clean balance for error analysis." },
];

function projectNames(results: MethodResult[], grouping: ProjectGrouping): string[] {
  const resolved = resolveProjectGrouping(results, grouping);
  return [...new Set(results.map((result) => samplingProjectFor(result, resolved)))].sort();
}

function presetConfig(results: MethodResult[], preset: SamplingPreset): ValidationSamplingConfig {
  const size = Math.min(results.length, preset === "pilot" ? 120 : 400);
  const projects = projectNames(results, "auto");
  const pilotMinimum = Math.min(15, Math.max(0, Math.floor(size / 8)));
  const auditMinimum = Math.min(25, Math.max(0, Math.floor(size / 10)));
  const minimum = preset === "representative" ? 0 : preset === "pilot" ? pilotMinimum : auditMinimum;
  return {
    preset,
    phase: preset === "representative" ? "main" : preset,
    title: preset === "pilot"
      ? "UPM JavaScript Code Smell Validation Pilot"
      : preset === "representative"
        ? "UPM JavaScript Code Smell Main Validation"
        : "UPM JavaScript Code Smell Detector Audit",
    sampleSize: size,
    seed: `UPM-JS-${preset.toUpperCase()}-2026`,
    classDistribution: preset === "representative" ? "natural" : "custom",
    smellyPercent: preset === "pilot" ? 60 : 50,
    projectGrouping: "auto",
    projectAllocation: preset === "representative" ? "proportional" : "equal",
    includedProjects: projects,
    minimumPerProject: 0,
    maximumPerProject: 0,
    smellMinimums: {
      longMethod: minimum,
      complexMethod: minimum,
      complexConditional: minimum,
      featureEnvy: minimum,
    },
    multiSmellMinimum: preset === "pilot" ? Math.min(10, Math.floor(size * 0.08)) : 0,
    boundaryPercent: preset === "representative" ? 0 : 20,
    includedCategories: ["production"],
    excludeGenerated: true,
    excludeExamples: true,
    excludeEmpty: true,
    minimumLoc: 1,
    deduplicateSource: true,
    includeNearbyContext: true,
    validatorCount: 2,
    annotationsPerMethod: 2,
  };
}

function integerValue(value: string, fallback = 0): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ValidationSampleBuilder({ results, context, onClose }: Props) {
  const [step, setStep] = useState(1);
  const [config, setConfig] = useState<ValidationSamplingConfig>(() => presetConfig(results, "pilot"));
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !building) onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [building, onClose]);

  const projects = useMemo(() => {
    const resolved = resolveProjectGrouping(results, config.projectGrouping);
    const counts: Record<string, number> = {};
    for (const result of results) {
      const project = samplingProjectFor(result, resolved);
      counts[project] = (counts[project] ?? 0) + 1;
    }
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  }, [config.projectGrouping, results]);

  const preview = useMemo(
    () => previewSamplingPopulation(results, config),
    [config, results],
  );

  function applyPreset(preset: SamplingPreset) {
    setConfig(presetConfig(results, preset));
    setError("");
    setMessage("");
  }

  function setGrouping(projectGrouping: ProjectGrouping) {
    setConfig((current) => ({
      ...current,
      projectGrouping,
      includedProjects: projectNames(results, projectGrouping),
    }));
  }

  function toggleProject(project: string) {
    setConfig((current) => ({
      ...current,
      includedProjects: current.includedProjects.includes(project)
        ? current.includedProjects.filter((name) => name !== project)
        : [...current.includedProjects, project].sort(),
    }));
  }

  function toggleCategory(category: SourceCategory) {
    setConfig((current) => ({
      ...current,
      includedCategories: current.includedCategories.includes(category)
        ? current.includedCategories.filter((name) => name !== category)
        : [...current.includedCategories, category],
    }));
  }

  async function generate(event: FormEvent) {
    event.preventDefault();
    setBuilding(true);
    setError("");
    setMessage("");
    try {
      const output = await buildValidationSamplePackage(results, config, context);
      downloadSamplingPackage(output);
      setMessage(
        `Created ${output.selectedCount.toLocaleString()} blinded samples from ${output.eligibleCount.toLocaleString()} eligible methods. ` +
        (output.warnings.length ? `${output.warnings.length} design warning${output.warnings.length === 1 ? "" : "s"} are recorded in the private report.` : "All requested constraints were met."),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The validation package could not be created.");
    } finally {
      setBuilding(false);
    }
  }

  const canGenerate = preview.eligibleCount >= config.sampleSize && config.sampleSize > 0 && config.includedProjects.length > 0;

  return (
    <div className="sample-builder-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !building) onClose();
    }}>
      <section className="sample-builder" role="dialog" aria-modal="true" aria-labelledby="sample-builder-title">
        <header className="sample-builder__header">
          <div>
            <p className="section-kicker">VALIDATION SAMPLE BUILDER</p>
            <h2 id="sample-builder-title">Create a reproducible blinded sample</h2>
            <p>Configure the design, check coverage, then download one research package.</p>
          </div>
          <button className="sample-builder__close" type="button" onClick={onClose} disabled={building} aria-label="Close sample builder">×</button>
        </header>

        <nav className="sample-builder__steps" aria-label="Sample builder steps">
          {["Study design", "Coverage", "Eligibility & output"].map((label, index) => (
            <button
              key={label}
              type="button"
              className={step === index + 1 ? "active" : ""}
              onClick={() => setStep(index + 1)}
            >
              <span>{index + 1}</span>{label}
            </button>
          ))}
        </nav>

        <form onSubmit={generate}>
          <div className="sample-builder__body">
            {step === 1 && (
              <div className="builder-step">
                <div className="builder-preset-grid" aria-label="Research design presets">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      className={config.preset === preset.value ? "active" : ""}
                      onClick={() => applyPreset(preset.value)}
                    >
                      <strong>{preset.label}</strong>
                      <span>{preset.detail}</span>
                    </button>
                  ))}
                </div>

                <div className="builder-field-grid builder-field-grid--two">
                  <label className="builder-field builder-field--wide">
                    <span>Study title</span>
                    <input value={config.title} maxLength={120} onChange={(event) => setConfig((current) => ({ ...current, title: event.target.value }))} />
                  </label>
                  <label className="builder-field">
                    <span>Study phase</span>
                    <select value={config.phase} onChange={(event) => setConfig((current) => ({ ...current, phase: event.target.value as ValidationSamplingConfig["phase"] }))}>
                      <option value="pilot">Pilot</option>
                      <option value="main">Main validation</option>
                      <option value="audit">Detector audit</option>
                    </select>
                  </label>
                  <label className="builder-field">
                    <span>Total methods</span>
                    <input type="number" min="1" max={results.length} value={config.sampleSize} onChange={(event) => setConfig((current) => ({ ...current, sampleSize: integerValue(event.target.value, 1) }))} />
                  </label>
                  <label className="builder-field builder-field--wide">
                    <span>Deterministic seed</span>
                    <input value={config.seed} maxLength={120} onChange={(event) => setConfig((current) => ({ ...current, seed: event.target.value }))} />
                    <small>The same dataset, settings, and seed reproduce the same selection and order.</small>
                  </label>
                  <label className="builder-field">
                    <span>Predicted class distribution</span>
                    <select value={config.classDistribution} onChange={(event) => setConfig((current) => ({ ...current, classDistribution: event.target.value as ValidationSamplingConfig["classDistribution"] }))}>
                      <option value="natural">Natural eligible distribution</option>
                      <option value="custom">Controlled target</option>
                    </select>
                  </label>
                  {config.classDistribution === "custom" && (
                    <label className="builder-field">
                      <span>Predicted-smelly target (%)</span>
                      <input type="number" min="0" max="100" value={config.smellyPercent} onChange={(event) => setConfig((current) => ({ ...current, smellyPercent: integerValue(event.target.value) }))} />
                    </label>
                  )}
                </div>

                {config.classDistribution === "custom" && (
                  <div className="builder-note builder-note--gold">
                    A controlled ratio improves diagnostic coverage but does not estimate real-world smell prevalence without sampling weights.
                  </div>
                )}
              </div>
            )}

            {step === 2 && (
              <div className="builder-step">
                <div className="builder-field-grid builder-field-grid--three">
                  <label className="builder-field">
                    <span>Project grouping</span>
                    <select value={config.projectGrouping} onChange={(event) => setGrouping(event.target.value as ProjectGrouping)}>
                      <option value="auto">Automatic</option>
                      <option value="dataset">Detector project field</option>
                      <option value="first-folder">First path folder</option>
                      <option value="second-folder">Second path folder</option>
                    </select>
                  </label>
                  <label className="builder-field">
                    <span>Project allocation</span>
                    <select value={config.projectAllocation} onChange={(event) => setConfig((current) => ({ ...current, projectAllocation: event.target.value as ValidationSamplingConfig["projectAllocation"] }))}>
                      <option value="proportional">Proportional to eligible methods</option>
                      <option value="equal">Approximately equal</option>
                    </select>
                  </label>
                  <label className="builder-field">
                    <span>Boundary methods (%)</span>
                    <input type="number" min="0" max="100" value={config.boundaryPercent} onChange={(event) => setConfig((current) => ({ ...current, boundaryPercent: integerValue(event.target.value) }))} />
                  </label>
                  <label className="builder-field">
                    <span>Minimum per project</span>
                    <input type="number" min="0" value={config.minimumPerProject} onChange={(event) => setConfig((current) => ({ ...current, minimumPerProject: integerValue(event.target.value) }))} />
                  </label>
                  <label className="builder-field">
                    <span>Maximum per project</span>
                    <input type="number" min="0" value={config.maximumPerProject} onChange={(event) => setConfig((current) => ({ ...current, maximumPerProject: integerValue(event.target.value) }))} />
                    <small>Use 0 for no maximum.</small>
                  </label>
                  <label className="builder-field">
                    <span>Minimum multi-smell methods</span>
                    <input type="number" min="0" value={config.multiSmellMinimum} onChange={(event) => setConfig((current) => ({ ...current, multiSmellMinimum: integerValue(event.target.value) }))} />
                  </label>
                </div>

                <fieldset className="builder-fieldset">
                  <legend>Minimum detector-positive coverage per smell</legend>
                  <div className="builder-smell-minimums">
                    {SAMPLING_SMELLS.map((smell) => (
                      <label key={smell.key}>
                        <span>{smell.label}</span>
                        <input
                          type="number"
                          min="0"
                          value={config.smellMinimums[smell.key]}
                          onChange={(event) => setConfig((current) => ({
                            ...current,
                            smellMinimums: { ...current.smellMinimums, [smell.key]: integerValue(event.target.value) },
                          }))}
                        />
                      </label>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="builder-fieldset">
                  <legend>Included projects · {config.includedProjects.length} of {projects.length}</legend>
                  <div className="builder-project-actions">
                    <button type="button" onClick={() => setConfig((current) => ({ ...current, includedProjects: projects.map(([project]) => project) }))}>Select all</button>
                    <button type="button" onClick={() => setConfig((current) => ({ ...current, includedProjects: [] }))}>Clear</button>
                    <small>Resolved grouping: {preview.resolvedProjectGrouping.replace("-", " ")}</small>
                  </div>
                  <div className="builder-project-list">
                    {projects.map(([project, count]) => (
                      <label key={project}>
                        <input type="checkbox" checked={config.includedProjects.includes(project)} onChange={() => toggleProject(project)} />
                        <span>{project}</span>
                        <small>{count.toLocaleString()}</small>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            )}

            {step === 3 && (
              <div className="builder-step">
                <fieldset className="builder-fieldset">
                  <legend>Eligible source categories</legend>
                  <div className="builder-check-grid">
                    {CATEGORY_OPTIONS.map((category) => (
                      <label key={category.value}>
                        <input type="checkbox" checked={config.includedCategories.includes(category.value)} onChange={() => toggleCategory(category.value)} />
                        <span>{category.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="builder-field-grid builder-field-grid--three">
                  <label className="builder-field">
                    <span>Minimum substantive LOC</span>
                    <input type="number" min="1" value={config.minimumLoc} onChange={(event) => setConfig((current) => ({ ...current, minimumLoc: integerValue(event.target.value, 1) }))} />
                    <small>Keep at 1 for an all-smell sample; short methods may still exhibit Feature Envy.</small>
                  </label>
                  <label className="builder-field">
                    <span>Number of validators</span>
                    <input type="number" min="1" max="50" value={config.validatorCount} onChange={(event) => setConfig((current) => ({ ...current, validatorCount: integerValue(event.target.value, 1) }))} />
                  </label>
                  <label className="builder-field">
                    <span>Annotations per method</span>
                    <input type="number" min="1" max={Math.max(1, config.validatorCount)} value={config.annotationsPerMethod} onChange={(event) => setConfig((current) => ({ ...current, annotationsPerMethod: integerValue(event.target.value, 1) }))} />
                  </label>
                </div>

                <div className="builder-toggle-list">
                  {([
                    ["excludeGenerated", "Exclude generated, bundled, external, and minified layouts"],
                    ["excludeExamples", "Exclude examples, samples, demos, playgrounds, and debug code"],
                    ["excludeEmpty", "Exclude empty function bodies"],
                    ["deduplicateSource", "Remove identical source segments"],
                    ["includeNearbyContext", "Include two nearby lines before and after each method"],
                  ] as const).map(([key, label]) => (
                    <label key={key}>
                      <input type="checkbox" checked={config[key]} onChange={(event) => setConfig((current) => ({ ...current, [key]: event.target.checked }))} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>

                <div className="builder-preview-grid" aria-label="Eligible population preview">
                  <article><span>Analyzed</span><strong>{results.length.toLocaleString()}</strong></article>
                  <article><span>Eligible</span><strong>{preview.eligibleCount.toLocaleString()}</strong></article>
                  <article><span>Predicted smelly</span><strong>{preview.predictedSmellyCount.toLocaleString()}</strong></article>
                  <article><span>Predicted clean</span><strong>{preview.predictedCleanCount.toLocaleString()}</strong></article>
                </div>

                <div className="builder-output-note">
                  <strong>One ZIP, two privacy levels</strong>
                  <p>Give validators only their files from <code>validator-payloads/</code>. Keep the manifests under <code>private/</code> with the research team because they contain detector labels, metrics, strata, and ID mappings.</p>
                </div>
              </div>
            )}
          </div>

          {(error || message) && <p className={`sample-builder__message ${error ? "sample-builder__message--error" : ""}`} role="status">{error || message}</p>}
          <footer className="sample-builder__footer">
            <span>{preview.eligibleCount.toLocaleString()} eligible · {config.sampleSize.toLocaleString()} requested</span>
            <div>
              {step > 1 && <button className="secondary-button" type="button" onClick={() => setStep((current) => current - 1)}>Back</button>}
              {step < 3
                ? <button className="primary-button" type="button" onClick={() => setStep((current) => current + 1)}>Continue</button>
                : <button className="primary-button" type="submit" disabled={!canGenerate || building}>{building ? "Building package…" : "Create validation package"}</button>}
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
