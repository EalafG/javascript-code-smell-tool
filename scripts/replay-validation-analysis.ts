import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildComparisons } from "../validation/analysis.ts";
import type { ImportedAnnotation, DetectorReference, SourceSample } from "../validation/analysis.ts";
import { ANALYSIS_VERSION, bootstrap, mapReviewers, selectAnalysis, summaryRows } from "../validation/research-analysis.ts";
import type { AnalysisMode, BootstrapResult, EligibilityDecision, ReviewerMapping } from "../validation/research-analysis.ts";

const [, , input, output] = process.argv;
if (!input || !output) throw new Error("Usage: node --experimental-strip-types scripts/replay-validation-analysis.ts input.json output.json");
const saved = JSON.parse(readFileSync(input, "utf8")) as {
  schemaVersion: string; analysisVersion: string; annotations: ImportedAnnotation[]; references: DetectorReference[]; sources: SourceSample[];
  settings: { reviewerMapping: ReviewerMapping; reviewerMappingConfirmed: boolean; mode: AnalysisMode };
  eligibilityHistory: EligibilityDecision[]; selectedSummary: ReturnType<typeof summaryRows>; bootstrap: BootstrapResult | null;
};
assert.equal(saved.schemaVersion, "1.0.0", "Unsupported report schema");
assert.equal(saved.analysisVersion, ANALYSIS_VERSION, "Use the analysis version recorded in the export");
assert.equal(saved.settings.reviewerMappingConfirmed, true, "Reviewer mapping must be confirmed");
const all = buildComparisons(mapReviewers(saved.annotations, saved.settings.reviewerMapping), saved.references, saved.sources);
const selected = selectAnalysis(all, saved.eligibilityHistory, saved.settings.mode);
const summary = summaryRows(selected);
assert.deepEqual(summary, saved.selectedSummary, "Saved summary does not reproduce");
const intervals = saved.bootstrap ? bootstrap(selected, saved.bootstrap.settings) : null;
assert.deepEqual(intervals, saved.bootstrap, "Saved bootstrap does not reproduce");
writeFileSync(output, JSON.stringify({ analysisVersion: ANALYSIS_VERSION, reproduced: true, selectedSummary: summary, bootstrap: intervals }, null, 2));
console.log("Summary metrics and any bootstrap repetitions reproduced exactly.");
