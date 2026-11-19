import { useEffect, useRef, useState } from "react";
import type { DetectorReference, ImportedAnnotation, MethodComparison, SourceSample } from "./analysis";
import { ANALYSIS_SMELLS } from "./analysis";
import { ANALYSIS_VERSION, latestEligibility, methodKey, parseEligibilityCsv, reviewerGroups, summaryRows, validateEligibility } from "./research-analysis";
import type { AnalysisMode, BootstrapResult, EligibilityDecision, ReviewerMapping } from "./research-analysis";

export type InputEvidence = { name: string; kind: string; sha256: string; bytes: number };
export async function fingerprint(file: File, kind: string): Promise<InputEvidence> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return { name: file.name, kind, bytes: file.size, sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}
function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function metricLabel(key: string) {
  if (key === "macroF1") return "Macro-average F1";
  const [smell, metric] = key.split(".");
  const labels: Record<string, string> = { accuracy: "Accuracy", precision: "Precision", recall: "Recall", specificity: "Specificity", f1: "F1", balancedAccuracy: "Balanced accuracy", mcc: "MCC", krippendorffAlpha: "Krippendorff’s α", percentAgreement: "Pairwise agreement", fleissKappa: "Fleiss’ κ" };
  return `${ANALYSIS_SMELLS.find((s) => s.key === smell)?.label ?? smell} · ${labels[metric] ?? metric}`;
}

type Props = {
  annotations: ImportedAnnotation[]; references: DetectorReference[]; sources: SourceSample[]; inputs: InputEvidence[];
  comparisons: MethodComparison[]; allComparisons: MethodComparison[]; mapping: ReviewerMapping; confirmed: boolean;
  onMapping: (mapping: ReviewerMapping, confirmed: boolean) => void;
  history: EligibilityDecision[]; onHistory: (history: EligibilityDecision[]) => void;
  mode: AnalysisMode; onMode: (mode: AnalysisMode) => void; analysisError: string;
};
export default function ResearchPanel(props: Props) {
  const { annotations, references, sources, inputs, comparisons, allComparisons, mapping, confirmed, onMapping, history, onHistory, mode, onMode, analysisError } = props;
  const [message, setMessage] = useState("");
  const [eligibilityInputs, setEligibilityInputs] = useState<InputEvidence[]>([]);
  const [sample, setSample] = useState(""); const [reason, setReason] = useState(""); const [reviewer, setReviewer] = useState("");
  const [reviewedAt, setReviewedAt] = useState(new Date().toISOString().slice(0, 10));
  const [disposition, setDisposition] = useState<"include" | "exclude">("exclude");
  const [seed, setSeed] = useState(20261117); const [repetitions, setRepetitions] = useState(10000);
  const [completed, setCompleted] = useState<number | null>(null); const [result, setResult] = useState<BootstrapResult | null>(null);
  const worker = useRef<Worker | null>(null);
  const [resultSignature, setResultSignature] = useState("");
  const signature = JSON.stringify([inputs, mapping, history, mode, seed, repetitions, confirmed]);
  const currentResult = resultSignature === signature ? result : null;
  // Invalidate and cancel work when the underlying analysis or settings change.
  useEffect(() => {
    return () => { worker.current?.terminate(); worker.current = null; setCompleted(null); };
  }, [signature]);
  const groups = reviewerGroups(annotations);
  const reused = new Set(groups.filter((g) => groups.filter((other) => other.validatorId === g.validatorId).length > 1).map((g) => g.validatorId));
  const busy = completed !== null && resultSignature === signature;
  const canAnalyze = confirmed && !analysisError && comparisons.length > 0;

  function runBootstrap() {
    worker.current?.terminate(); setMessage(""); setResult(null); setCompleted(0); setResultSignature(signature);
    const task = new Worker(new URL("./bootstrap.worker.ts", import.meta.url), { type: "module" }); worker.current = task;
    task.onmessage = (event) => {
      if (worker.current !== task) return;
      if (event.data.type === "progress") setCompleted(event.data.completed);
      else {
        setCompleted(null); task.terminate(); worker.current = null;
        if (event.data.type === "result") setResult(event.data.result as BootstrapResult);
        else setMessage(String(event.data.message));
      }
    };
    task.onerror = () => { setMessage("The bootstrap worker failed. Try fewer repetitions or reload the page."); setCompleted(null); task.terminate(); worker.current = null; };
    task.postMessage({ comparisons, settings: { seed, repetitions, mode } });
  }
  function saveDecision() {
    try {
      const target = allComparisons.find((m) => methodKey(m) === sample);
      if (!target) throw new Error("Select a method.");
      const decision = validateEligibility({ datasetSha256: target.datasetSha256, sampleId: target.sampleId, disposition, reason: reason.trim(), reviewer: reviewer.trim(), reviewedAt });
      onHistory([...history, decision]); setMessage("Eligibility decision recorded. Original annotations are unchanged."); setReason("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Invalid eligibility decision."); }
  }
  function exportReport() {
    const report = {
      schemaVersion: "1.0.0", analysisVersion: ANALYSIS_VERSION, createdAt: new Date().toISOString(),
      buildRevision: import.meta.env.VITE_BUILD_REVISION || "not supplied", inputs: [...inputs, ...eligibilityInputs],
      analysisSourceSha256: import.meta.env.VITE_ANALYSIS_SOURCE_SHA256 || "not supplied",
      policy: { reference: "Strict majority of all eligible nominal ratings, minimum two; ties unresolved; uncertain references excluded from binary metrics", eligibility: "Original ratings preserved; last recorded researcher decision applied in screened mode", displayFiltersAffectMetrics: false, fleissKappa: "Reported only with equal rating counts per unit" },
      settings: { mode, seed, repetitions, reviewerMapping: mapping, reviewerMappingConfirmed: confirmed },
      eligibilityHistory: history, originalSummary: summaryRows(allComparisons), selectedSummary: summaryRows(comparisons),
      excludedMethods: allComparisons.filter((m) => !comparisons.includes(m)).map((m) => ({ sampleId: m.sampleId, datasetSha256: m.datasetSha256 })),
      bootstrap: currentResult, annotations, references, sources, comparisons: allComparisons,
      limitations: ["Exploratory conditional intervals; fixed projects; enrichment and reference-label correctness are not corrected.", "Mulberry32-v1 differs from the paper's NumPy PCG64 stream. The same seed does not recreate its exact repetitions.", "This file contains private method evidence and annotations; store as research data."]
    };
    download(`validation-analysis-${mode}.json`, JSON.stringify(report, null, 2));
  }
  return <section className="analysis-panel research-panel" aria-label="Research analysis settings">
    <h2>Researcher mapping and analysis scope</h2>
    <p>Assign a distinct identity to each human reviewer. Use the same identity across files only when they are revisions from the same person. Confirm this mapping before viewing results.</p>
    {reused.size > 0 && <p className="analysis-warning" role="status">Reused exported IDs: {[...reused].join(", ")}. These files must not be silently treated as one reviewer.</p>}
    <div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>Source file</th><th>Exported validator ID</th><th>Reviewer identity</th></tr></thead><tbody>{groups.map((group) => <tr key={group.key}><td>{group.sourceFile}</td><td>{group.validatorId}</td><td><input aria-label={`Reviewer for ${group.sourceFile} ${group.validatorId}`} value={mapping[group.key] ?? ""} onChange={(event) => onMapping({ ...mapping, [group.key]: event.target.value }, false)} /></td></tr>)}</tbody></table></div>
    <button type="button" className="button button--primary" disabled={!groups.length || groups.some((g) => !mapping[g.key]?.trim())} onClick={() => onMapping(mapping, true)}>{confirmed ? "Reviewer mapping confirmed" : "Confirm reviewer mapping"}</button>
    {analysisError && <p className="analysis-error" role="alert">{analysisError}</p>}
    <div className="research-controls">
      <label>Analysis population<select value={mode} onChange={(e) => onMode(e.target.value as AnalysisMode)}><option value="original">Original available ratings</option><option value="screened">Researcher-screened subset</option></select></label>
      <p>{allComparisons.length} original methods · {comparisons.length} in the selected analysis. This selection changes summary metrics and bootstrap inputs. Method-search filters below only change the displayed list.</p>
    </div>
    <details><summary>Researcher eligibility decisions ({history.length} audit entries)</summary>
      <p>Record exclusions separately from smell labels. An include decision revokes a prior researcher exclusion; it does not create missing human ratings. CSV imports require DATASET_SHA256, SAMPLE_ID, DISPOSITION (include/exclude), REASON, REVIEWER, REVIEWED_AT.</p>
      <div className="research-controls">
        <label>Method<select value={sample} onChange={(e) => setSample(e.target.value)}><option value="">Choose a method</option>{allComparisons.map((m) => <option key={methodKey(m)} value={methodKey(m)}>{m.sampleId} · {m.reference?.project ?? "unmatched"} · {m.datasetSha256.slice(0, 8)}</option>)}</select></label>
        <label>Decision<select value={disposition} onChange={(e) => setDisposition(e.target.value as "include" | "exclude")}><option value="exclude">Exclude from screened subset</option><option value="include">Include in screened subset</option></select></label>
        <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <label>Reviewer<input value={reviewer} onChange={(e) => setReviewer(e.target.value)} /></label>
        <label>Review date<input type="date" value={reviewedAt} onChange={(e) => setReviewedAt(e.target.value)} /></label>
        <button type="button" className="button" disabled={!confirmed} onClick={saveDecision}>Record decision</button>
        <label>Import eligibility CSV<input type="file" accept=".csv" disabled={!confirmed} onChange={async (e) => {
          const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
          try {
            const decisions = parseEligibilityCsv(await file.text());
            const known = new Set(allComparisons.map(methodKey));
            if (decisions.some((d) => !known.has(methodKey(d)))) throw new Error("Eligibility import contains unmatched dataset/sample IDs; no decisions were imported.");
            const evidence = await fingerprint(file, "eligibility");
            onHistory([...history, ...decisions]); setEligibilityInputs((previous) => [...previous, evidence]); setMessage(`Imported ${decisions.length} eligibility decisions.`);
          } catch (error) { setMessage(error instanceof Error ? error.message : "Import failed."); }
        }} /></label>
      </div>
      {history.length > 0 && <><button className="button" type="button" onClick={() => download("eligibility-history.json", JSON.stringify(history, null, 2))}>Export eligibility audit</button><div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>Sample</th><th>Decision</th><th>Reason</th><th>Reviewer</th><th>Date</th><th>Current?</th></tr></thead><tbody>{history.map((item, index) => <tr key={index}><td>{item.sampleId}</td><td>{item.disposition}</td><td>{item.reason}</td><td>{item.reviewer}</td><td>{item.reviewedAt}</td><td>{latestEligibility(history).get(methodKey(item)) === item ? "Yes" : "Superseded"}</td></tr>)}</tbody></table></div></>}
    </details>
    <h3>Bootstrap confidence intervals</h3>
    <p>Resample methods within fixed projects, keeping all ratings and predictions together. Original and screened analyses are run separately. These exploratory intervals do not correct enrichment or uncertainty in reference-label correctness.</p>
    <div className="research-controls">
      <label>Repetitions<input type="number" min="100" max="50000" value={repetitions} onChange={(e) => setRepetitions(Number(e.target.value))} /></label>
      <label>Random seed<input type="number" min="0" max="4294967295" value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></label>
      <button className="button button--primary" type="button" disabled={!canAnalyze || busy} onClick={runBootstrap}>Calculate 95% intervals</button>
      {busy && <><span role="status">{completed} / {repetitions} repetitions</span><button type="button" className="button" onClick={() => { worker.current?.terminate(); worker.current = null; setCompleted(null); }}>Cancel bootstrap</button></>}
    </div>
    <p className="research-note">Generator: Mulberry32-v1. This uses the same resampling design as the paper, but a different random generator from NumPy PCG64; exact interval endpoints may differ. Fleiss’ κ is shown only for equal rating counts.</p>
    {message && <p role="status">{message}</p>}
    {currentResult && <div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th>Metric</th><th>Estimate</th><th>95% lower</th><th>95% upper</th><th>Defined repeats</th><th>Undefined repeats</th></tr></thead><tbody>{currentResult.intervals.map((row) => <tr key={row.metric}><th>{metricLabel(row.metric)}</th>{[row.estimate, row.lower, row.upper].map((v, i) => <td key={i}>{v === null ? "Undefined" : v.toFixed(3)}</td>)}<td>{row.valid}</td><td>{row.undefined}</td></tr>)}</tbody></table></div>}
    <button type="button" className="button button--primary" disabled={!canAnalyze || busy} onClick={exportReport}>Export reproducible analysis JSON</button>
    <p className="research-note">Includes original annotations, input hashes, reviewer mapping, eligibility history, summary metrics, build version and any current bootstrap repetitions. Source segments are included if loaded. Export each analysis mode before switching; bootstrap results apply only to the settings used to calculate them.</p>
  </section>;
}
