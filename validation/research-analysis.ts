import { ANALYSIS_SMELLS, agreementMetrics, binaryMetrics, parseCsv } from "./analysis.ts";
import type { ImportedAnnotation, MethodComparison } from "./analysis.ts";

export const ANALYSIS_VERSION = "1.1.0";
export type AnalysisMode = "original" | "screened";
export type ReviewerMapping = Record<string, string>;
export const identityKey = (row: Pick<ImportedAnnotation, "sourceFile" | "validatorId">) => JSON.stringify([row.sourceFile, row.validatorId]);
export const methodKey = (row: { datasetSha256: string; sampleId: string }) => JSON.stringify([row.datasetSha256, row.sampleId]);

export function reviewerGroups(rows: ImportedAnnotation[]) {
  const groups = new Map<string, { key: string; sourceFile: string; validatorId: string }>();
  for (const row of rows) groups.set(identityKey(row), { key: identityKey(row), sourceFile: row.sourceFile, validatorId: row.validatorId });
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function mapReviewers(rows: ImportedAnnotation[], mapping: ReviewerMapping) {
  return rows.map((row) => {
    const reviewerId = mapping[identityKey(row)]?.trim();
    if (!reviewerId) throw new Error(`Assign a reviewer to ${row.sourceFile} (${row.validatorId}).`);
    return { ...row, reviewerId };
  });
}

export type EligibilityDecision = {
  datasetSha256: string;
  sampleId: string;
  disposition: "include" | "exclude";
  reason: string;
  reviewer: string;
  reviewedAt: string;
};

export function validateEligibility(decision: EligibilityDecision): EligibilityDecision {
  if (!decision.sampleId.trim() || !decision.reason.trim() || !decision.reviewer.trim()) throw new Error("Sample ID, reason and reviewer are required for each eligibility decision.");
  if (!["include", "exclude"].includes(decision.disposition)) throw new Error("Eligibility disposition must be include or exclude.");
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(decision.reviewedAt) || !Number.isFinite(Date.parse(decision.reviewedAt))) throw new Error("Eligibility date must be an ISO date or timestamp.");
  return decision;
}

export function parseEligibilityCsv(text: string): EligibilityDecision[] {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("The eligibility CSV is empty.");
  return rows.map((r) => validateEligibility({ datasetSha256: (r.DATASET_SHA256 ?? "").trim(), sampleId: (r.SAMPLE_ID ?? "").trim(),
    disposition: (r.DISPOSITION ?? "").trim().toLowerCase() as EligibilityDecision["disposition"], reason: (r.REASON ?? "").trim(), reviewer: (r.REVIEWER ?? "").trim(), reviewedAt: (r.REVIEWED_AT ?? "").trim() }));
}

/** Append order is the audit order. Later include decisions revoke earlier exclusions. */
export function latestEligibility(history: EligibilityDecision[]) {
  const map = new Map<string, EligibilityDecision>();
  for (const item of history) map.set(methodKey(item), validateEligibility(item));
  return map;
}

export function selectAnalysis(comparisons: MethodComparison[], history: EligibilityDecision[], mode: AnalysisMode) {
  const known = new Set(comparisons.map(methodKey));
  const decisions = latestEligibility(history);
  for (const key of decisions.keys()) if (!known.has(key)) throw new Error("An eligibility decision does not match the imported dataset and method. Check DATASET_SHA256 and SAMPLE_ID.");
  return mode === "original" ? comparisons : comparisons.filter((m) => decisions.get(methodKey(m))?.disposition !== "exclude");
}

export function summaryRows(comparisons: MethodComparison[]) {
  return ANALYSIS_SMELLS.map((smell) => ({ ...smell, performance: binaryMetrics(comparisons, smell.key), agreement: agreementMetrics(comparisons, smell.key) }));
}

export function metricValues(comparisons: MethodComparison[]): Record<string, number | null> {
  const values: Record<string, number | null> = {};
  for (const row of summaryRows(comparisons)) {
    for (const metric of ["accuracy", "precision", "recall", "specificity", "f1", "balancedAccuracy", "mcc"] as const) values[`${row.key}.${metric}`] = row.performance[metric];
    for (const metric of ["krippendorffAlpha", "percentAgreement", "fleissKappa"] as const) values[`${row.key}.${metric}`] = row.agreement[metric];
  }
  const f1 = ANALYSIS_SMELLS.map(({ key }) => values[`${key}.f1`]);
  values.macroF1 = f1.every((v) => v !== null) ? (f1 as number[]).reduce((a, b) => a + b, 0) / f1.length : null;
  return values;
}

export function linearQuantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position); const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** Versioned deterministic 32-bit generator. Not NumPy PCG64. */
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type BootstrapSettings = { repetitions: number; seed: number; mode: AnalysisMode };
export type BootstrapInterval = { metric: string; estimate: number | null; lower: number | null; upper: number | null; valid: number; undefined: number };
export type BootstrapResult = {
  version: string; settings: BootstrapSettings; generator: string; method: string; projectSizes: Record<string, number>;
  intervals: BootstrapInterval[]; replicates: Record<string, Array<number | null>>;
};

export function bootstrap(comparisons: MethodComparison[], settings: BootstrapSettings, progress?: (completed: number) => void): BootstrapResult {
  if (!Number.isInteger(settings.repetitions) || settings.repetitions < 100 || settings.repetitions > 50000) throw new Error("Use 100–50,000 bootstrap repetitions.");
  if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 4294967295) throw new Error("Seed must be an integer between 0 and 4294967295.");
  if (!comparisons.length) throw new Error("No methods in the selected analysis.");
  const strata = new Map<string, MethodComparison[]>();
  for (const method of comparisons) {
    if (!method.reference?.project.trim()) throw new Error("Every method needs a matched detector record with a project before project-stratified bootstrap.");
    const key = JSON.stringify([method.datasetSha256, method.reference.project]);
    const group = strata.get(key) ?? []; group.push(method); strata.set(key, group);
  }
  const groups = [...strata].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => [key, [...group].sort((a, b) => methodKey(a).localeCompare(methodKey(b)))] as const);
  const estimates = metricValues(comparisons);
  const replicates = Object.fromEntries(Object.keys(estimates).map((key) => [key, [] as Array<number | null>]));
  const random = seededRandom(settings.seed);
  for (let iteration = 0; iteration < settings.repetitions; iteration++) {
    // Sample methods, not individual ratings. Do not deduplicate sampled IDs.
    const sample = groups.flatMap(([, group]) => Array.from({ length: group.length }, () => group[Math.floor(random() * group.length)]));
    const values = metricValues(sample);
    for (const key of Object.keys(estimates)) replicates[key].push(values[key]);
    if ((iteration + 1) % 100 === 0 || iteration + 1 === settings.repetitions) progress?.(iteration + 1);
  }
  const intervals = Object.entries(replicates).map(([metric, values]) => {
    const finite = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
    return { metric, estimate: estimates[metric], lower: linearQuantile(finite, .025), upper: linearQuantile(finite, .975), valid: finite.length, undefined: values.length - finite.length };
  });
  return { version: ANALYSIS_VERSION, settings, generator: "Mulberry32-v1", method: "95% percentile; linear quantiles; methods resampled within fixed dataset/project strata", projectSizes: Object.fromEntries(groups.map(([key, group]) => [key, group.length])), intervals, replicates };
}
