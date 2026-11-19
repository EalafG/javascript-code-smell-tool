import type { Decision, DecisionMap, IneligibilityReason, SampleDisposition, SmellKey } from "./types";

export const ANALYSIS_SMELLS: Array<{
  key: SmellKey;
  label: string;
  annotationColumn: string;
  detectorColumn: string;
}> = [
  { key: "longMethod", label: "Long Method", annotationColumn: "LONG_METHOD", detectorColumn: "is_long_method" },
  { key: "complexMethod", label: "Complex Method", annotationColumn: "COMPLEX_METHOD", detectorColumn: "is_complex_method" },
  { key: "complexConditional", label: "Complex Conditional", annotationColumn: "COMPLEX_CONDITIONAL", detectorColumn: "is_complex_conditional" },
  { key: "featureEnvy", label: "Feature Envy", annotationColumn: "FEATURE_ENVY", detectorColumn: "is_feature_envy" },
];

export type ImportedAnnotation = {
  sourceFile: string;
  annotationId: string;
  validatorId: string;
  /** Researcher-confirmed identity; exported validatorId remains untouched. */
  reviewerId?: string;
  sampleId: string;
  datasetMethodId: string;
  datasetSha256: string;
  revision: number;
  sampleDisposition: SampleDisposition;
  ineligibilityReason: IneligibilityReason | "";
  ineligibilityDetails: string;
  decisions: DecisionMap;
  notes: string;
  submittedAt: string;
  durationSeconds: number | null;
};

export type DetectorReference = {
  sourceFile: string;
  sampleId: string;
  datasetMethodId: string;
  project: string;
  file: string;
  functionName: string;
  functionType: string;
  startLine: number | null;
  endLine: number | null;
  loc: number | null;
  datasetSha256: string;
  detector: Record<SmellKey, 0 | 1>;
  smellTypes: string;
};

export type SourceSample = {
  sampleId: string;
  datasetSha256: string;
  sourceSegment: string;
  sourceContext: string;
};

export type MethodComparison = {
  sampleId: string;
  datasetSha256: string;
  reference: DetectorReference | null;
  source: SourceSample | null;
  annotations: ImportedAnnotation[];
  consensus: Record<SmellKey, Decision | "tie" | null>;
};

export type BinaryMetrics = {
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  uncertain: number;
  ties: number;
  ineligible: number;
  insufficient: number;
  unmatched: number;
  evaluated: number;
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  specificity: number | null;
  f1: number | null;
  balancedAccuracy: number | null;
  mcc: number | null;
};

export type AgreementMetrics = {
  units: number;
  ratings: number;
  percentAgreement: number | null;
  krippendorffAlpha: number | null;
  fleissKappa: number | null;
};

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const normalized = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (quoted) {
      if (char === '"' && normalized[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((value) => value.length)) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function decision(value: string, column: string, rowNumber: number, required: boolean): Decision | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "present" || normalized === "absent" || normalized === "uncertain") return normalized;
  if (!required && !normalized) return null;
  throw new Error(`Row ${rowNumber}: ${column} must be Present, Absent, or Uncertain.`);
}

const INELIGIBILITY_REASONS = new Set<IneligibilityReason>([
  "third_party_or_generated",
  "incomplete_or_incorrect_segment",
  "essential_context_unavailable",
  "parse_or_display_problem",
  "other",
]);

function sampleDisposition(value: string | undefined, rowNumber: number): SampleDisposition {
  const normalized = (value || "eligible").trim().toLowerCase();
  if (normalized === "eligible" || normalized === "ineligible") return normalized;
  throw new Error(`Row ${rowNumber}: SAMPLE_DISPOSITION must be Eligible or Ineligible.`);
}

function ineligibilityReason(value: string | undefined, disposition: SampleDisposition, rowNumber: number): IneligibilityReason | "" {
  const normalized = (value || "").trim().toLowerCase() as IneligibilityReason | "";
  if (disposition === "eligible") return "";
  if (INELIGIBILITY_REASONS.has(normalized as IneligibilityReason)) return normalized;
  throw new Error(`Row ${rowNumber}: an Ineligible sample requires a valid INELIGIBILITY_REASON.`);
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function binary(value: string | undefined): 0 | 1 {
  if (value?.trim() === "1") return 1;
  if (value?.trim() === "0") return 0;
  throw new Error("Detector predictions must be 0 or 1; missing values cannot be treated as negative.");
}

export function parseAnnotationCsv(text: string, sourceFile: string): ImportedAnnotation[] {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error(`${sourceFile}: the annotation CSV is empty.`);
  const required = ["VALIDATOR_ID", "SAMPLE_ID", ...ANALYSIS_SMELLS.map((smell) => smell.annotationColumn)];
  for (const column of required) {
    if (!(column in rows[0])) throw new Error(`${sourceFile}: missing required column ${column}.`);
  }
  return rows.map((row, index) => {
    const disposition = sampleDisposition(row.SAMPLE_DISPOSITION, index + 2);
    const reason = ineligibilityReason(row.INELIGIBILITY_REASON, disposition, index + 2);
    const details = row.INELIGIBILITY_DETAILS || "";
    if (!row.VALIDATOR_ID.trim() || !row.SAMPLE_ID.trim()) throw new Error(`Row ${index + 2}: reviewer and sample identifiers must not be empty.`);
    if (reason === "other" && !details.trim()) {
      throw new Error(`Row ${index + 2}: INELIGIBILITY_DETAILS is required when the reason is Other.`);
    }
    return {
      sourceFile,
      annotationId: row.ANNOTATION_ID || `${sourceFile}:${index + 2}`,
      validatorId: row.VALIDATOR_ID.trim(),
      sampleId: row.SAMPLE_ID.trim(),
      datasetMethodId: (row.DATASET_METHOD_ID || row.SAMPLE_ID).trim(),
      datasetSha256: (row.DATASET_SHA256 || "").trim(),
      revision: Math.max(1, Number(row.REVISION) || 1),
      sampleDisposition: disposition,
      ineligibilityReason: reason,
      ineligibilityDetails: details,
      decisions: Object.fromEntries(ANALYSIS_SMELLS.map((smell) => [
        smell.key,
        decision(row[smell.annotationColumn], smell.annotationColumn, index + 2, disposition === "eligible"),
      ])) as DecisionMap,
      notes: row.NOTES || "",
      submittedAt: row.SUBMITTED_AT || "",
      durationSeconds: numberOrNull(row.DURATION_SECONDS),
    };
  });
}

export function parseReferenceCsv(text: string, sourceFile: string): DetectorReference[] {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error(`${sourceFile}: the detector/reference CSV is empty.`);
  const hasSampleId = "SAMPLE_ID" in rows[0];
  const hasMethodId = "DATASET_METHOD_ID" in rows[0] || "ID" in rows[0];
  if (!hasMethodId) throw new Error(`${sourceFile}: expected DATASET_METHOD_ID or ID.`);
  for (const smell of ANALYSIS_SMELLS) {
    if (!(smell.detectorColumn in rows[0])) throw new Error(`${sourceFile}: missing ${smell.detectorColumn}.`);
  }
  return rows.map((row) => ({
    sourceFile,
    sampleId: hasSampleId ? row.SAMPLE_ID.trim() : "",
    datasetMethodId: (row.DATASET_METHOD_ID || row.ID).trim(),
    project: row.PROJECT || row.DATASET_PROJECT || "",
    file: row.FILE || "",
    functionName: row.FUNCTION || "",
    functionType: row.FUNCTION_TYPE || "",
    startLine: numberOrNull(row.START_LINE),
    endLine: numberOrNull(row.END_LINE),
    loc: numberOrNull(row.LOC),
    datasetSha256: row.DATASET_SHA256 || "",
    detector: Object.fromEntries(ANALYSIS_SMELLS.map((smell) => [smell.key, binary(row[smell.detectorColumn])])) as Record<SmellKey, 0 | 1>,
    smellTypes: row.SMELL_TYPES || "",
  }));
}

export function latestAnnotations(rows: ImportedAnnotation[]): ImportedAnnotation[] {
  const identities = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.reviewerId) continue;
    const files = identities.get(row.validatorId) ?? new Set<string>();
    files.add(row.sourceFile); identities.set(row.validatorId, files);
  }
  if ([...identities.values()].some((files) => files.size > 1)) {
    throw new Error("A validator ID occurs in multiple files. Confirm a reviewer mapping before analysis.");
  }
  const latest = new Map<string, ImportedAnnotation>();
  for (const row of rows) {
    const key = JSON.stringify([row.datasetSha256, row.reviewerId ?? row.validatorId, row.sampleId]);
    const current = latest.get(key);
    if (current && row.revision === current.revision && row.submittedAt === current.submittedAt &&
      JSON.stringify([row.decisions, row.sampleDisposition, row.ineligibilityReason, row.ineligibilityDetails]) !==
      JSON.stringify([current.decisions, current.sampleDisposition, current.ineligibilityReason, current.ineligibilityDetails])) {
      throw new Error(`Conflicting ratings have the same revision and timestamp for ${row.sampleId}. Resolve the reviewer mapping or input records.`);
    }
    if (!current || row.revision > current.revision || (row.revision === current.revision && row.submittedAt > current.submittedAt)) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

function consensusFor(values: Decision[]): Decision | "tie" | null {
  if (values.length < 2) return null;
  const counts: Record<Decision, number> = { present: 0, absent: 0, uncertain: 0 };
  values.forEach((value) => { counts[value] += 1; });
  const maximum = Math.max(...Object.values(counts));
  const winners = (Object.keys(counts) as Decision[]).filter((key) => counts[key] === maximum);
  return winners.length === 1 && maximum > values.length / 2 ? winners[0] : "tie";
}

export function buildComparisons(
  annotationRows: ImportedAnnotation[],
  references: DetectorReference[],
  sources: SourceSample[] = [],
): MethodComparison[] {
  const annotations = latestAnnotations(annotationRows);
  const referenceByDatasetSample = new Map(references.filter((row) => row.sampleId && row.datasetSha256).map((row) => [`${row.datasetSha256}\u0000${row.sampleId}`, row]));
  const sourceByDatasetSample = new Map(sources.filter((row) => row.datasetSha256).map((row) => [`${row.datasetSha256}\u0000${row.sampleId}`, row]));
  const sourceBySample = new Map(sources.map((row) => [row.sampleId, row]));
  const grouped = new Map<string, ImportedAnnotation[]>();
  for (const annotation of annotations) {
    const key = `${annotation.datasetSha256}\u0000${annotation.sampleId}`;
    const group = grouped.get(key) ?? [];
    group.push(annotation);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((rows) => {
    const sampleId = rows[0].sampleId;
    const datasetSha256 = rows[0].datasetSha256;
    const candidates = references.filter((ref) => (!ref.datasetSha256 || !datasetSha256 || ref.datasetSha256 === datasetSha256) &&
      (ref.sampleId === sampleId || (!ref.sampleId && ref.datasetMethodId === rows[0].datasetMethodId)));
    if (candidates.length > 1) throw new Error(`Ambiguous detector match for ${sampleId}; load one matching manifest.`);
    const reference = referenceByDatasetSample.get(`${datasetSha256}\u0000${sampleId}`) ?? candidates[0] ?? null;
    const eligibleRows = rows.filter((row) => row.sampleDisposition === "eligible");
    return {
      sampleId,
      datasetSha256,
      reference,
      source: sourceByDatasetSample.get(`${datasetSha256}\u0000${sampleId}`) ?? sourceBySample.get(sampleId) ?? null,
      annotations: rows.sort((a, b) => a.validatorId.localeCompare(b.validatorId)),
      consensus: Object.fromEntries(ANALYSIS_SMELLS.map((smell) => [
        smell.key,
        consensusFor(eligibleRows.map((row) => row.decisions[smell.key]).filter((value): value is Decision => value !== null)),
      ])) as Record<SmellKey, Decision | "tie" | null>,
    };
  }).sort((a, b) => a.datasetSha256.localeCompare(b.datasetSha256) || a.sampleId.localeCompare(b.sampleId, undefined, { numeric: true }));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

export function binaryMetrics(comparisons: MethodComparison[], smell: SmellKey): BinaryMetrics {
  let tp = 0; let tn = 0; let fp = 0; let fn = 0; let uncertain = 0; let ties = 0; let ineligible = 0; let insufficient = 0; let unmatched = 0;
  for (const method of comparisons) {
    if (!method.reference) { unmatched += 1; continue; }
    if (!method.annotations.some((row) => row.sampleDisposition === "eligible")) { ineligible += 1; continue; }
    if (method.annotations.filter((row) => row.sampleDisposition === "eligible" && row.decisions[smell] !== null).length < 2) { insufficient += 1; continue; }
    const consensus = method.consensus[smell];
    if (consensus === "uncertain" || consensus === null) { uncertain += 1; continue; }
    if (consensus === "tie") { ties += 1; continue; }
    const predicted = method.reference.detector[smell];
    const observed = consensus === "present" ? 1 : 0;
    if (predicted === 1 && observed === 1) tp += 1;
    else if (predicted === 0 && observed === 0) tn += 1;
    else if (predicted === 1) fp += 1;
    else fn += 1;
  }
  const evaluated = tp + tn + fp + fn;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const specificity = ratio(tn, tn + fp);
  const denominator = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
  return {
    tp, tn, fp, fn, uncertain, ties, ineligible, insufficient, unmatched, evaluated,
    accuracy: ratio(tp + tn, evaluated),
    precision,
    recall,
    specificity,
    f1: ratio(2 * tp, 2 * tp + fp + fn),
    balancedAccuracy: recall !== null && specificity !== null ? (recall + specificity) / 2 : null,
    mcc: denominator ? ((tp * tn) - (fp * fn)) / denominator : null,
  };
}

export function agreementMetrics(comparisons: MethodComparison[], smell: SmellKey): AgreementMetrics {
  const units = comparisons
    .map((method) => method.annotations
      .filter((row) => row.sampleDisposition === "eligible")
      .map((row) => row.decisions[smell])
      .filter((value): value is Decision => value !== null))
    .filter((ratings) => ratings.length >= 2);
  const categories: Decision[] = ["present", "absent", "uncertain"];
  let agreeingPairs = 0;
  let allPairs = 0;
  let observedAgreementTotal = 0;
  const totals: Record<Decision, number> = { present: 0, absent: 0, uncertain: 0 };
  const coincidence = Object.fromEntries(categories.map((left) => [left, Object.fromEntries(categories.map((right) => [right, 0]))])) as Record<Decision, Record<Decision, number>>;
  for (const ratings of units) {
    const counts: Record<Decision, number> = { present: 0, absent: 0, uncertain: 0 };
    ratings.forEach((rating) => { counts[rating] += 1; totals[rating] += 1; });
    const n = ratings.length;
    const agreeing = categories.reduce((sum, category) => sum + counts[category] * (counts[category] - 1), 0);
    agreeingPairs += agreeing / 2;
    allPairs += n * (n - 1) / 2;
    observedAgreementTotal += agreeing / (n * (n - 1));
    for (const left of categories) {
      for (const right of categories) {
        const occurrences = left === right ? counts[left] * (counts[left] - 1) : counts[left] * counts[right];
        coincidence[left][right] += occurrences / (n - 1);
      }
    }
  }
  const ratings = Object.values(totals).reduce((sum, value) => sum + value, 0);
  const totalCoincidences = categories.reduce((sum, left) => sum + categories.reduce((inner, right) => inner + coincidence[left][right], 0), 0);
  const diagonal = categories.reduce((sum, category) => sum + coincidence[category][category], 0);
  const doValue = totalCoincidences ? 1 - diagonal / totalCoincidences : null;
  const marginals = Object.fromEntries(categories.map((left) => [left, categories.reduce((sum, right) => sum + coincidence[left][right], 0)])) as Record<Decision, number>;
  const deValue = totalCoincidences > 1
    ? (totalCoincidences * totalCoincidences - categories.reduce((sum, category) => sum + marginals[category] ** 2, 0)) / (totalCoincidences * (totalCoincidences - 1))
    : null;
  const categoryProportions = categories.map((category) => ratio(totals[category], ratings) ?? 0);
  const expectedAgreement = categoryProportions.reduce((sum, value) => sum + value * value, 0);
  const meanObservedAgreement = units.length ? observedAgreementTotal / units.length : null;
  return {
    units: units.length,
    ratings,
    percentAgreement: ratio(agreeingPairs, allPairs),
    krippendorffAlpha: doValue !== null && deValue ? 1 - doValue / deValue : null,
    fleissKappa: new Set(units.map((unit) => unit.length)).size === 1 && meanObservedAgreement !== null && expectedAgreement < 1
      ? (meanObservedAgreement - expectedAgreement) / (1 - expectedAgreement)
      : null,
  };
}

