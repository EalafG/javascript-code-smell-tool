import test from "node:test";
import assert from "node:assert/strict";
import { agreementMetrics, binaryMetrics, buildComparisons, parseAnnotationCsv, parseReferenceCsv } from "../validation/analysis.ts";
import { bootstrap, identityKey, linearQuantile, mapReviewers, parseEligibilityCsv, selectAnalysis } from "../validation/research-analysis.ts";
import type { EligibilityDecision } from "../validation/research-analysis.ts";

const header = "VALIDATOR_ID,SAMPLE_ID,DATASET_SHA256,REVISION,SUBMITTED_AT,LONG_METHOD,COMPLEX_METHOD,COMPLEX_CONDITIONAL,FEATURE_ENVY";
function ratings(votes: string[], sample = "S1", file = "a.csv") {
  return parseAnnotationCsv([header, ...votes.map((vote, i) => `R${i},${sample},hash,1,2026-01-01,${vote},${vote},${vote},${vote}`)].join("\n"), file);
}
function reference(sample = "S1", prediction = 1, project = "project") {
  return parseReferenceCsv(`SAMPLE_ID,DATASET_METHOD_ID,DATASET_SHA256,PROJECT,is_long_method,is_complex_method,is_complex_conditional,is_feature_envy\n${sample},M-${sample},hash,${project},${prediction},${prediction},${prediction},${prediction}`, "manifest.csv");
}
test("reused IDs cannot silently collapse independent source files", () => {
  const a = ratings(["present"], "S1", "a.csv"); const b = ratings(["absent"], "S1", "b.csv"); const c = ratings(["absent"], "S1", "c.csv");
  assert.throws(() => buildComparisons([...a, ...b, ...c], reference()), /mapping/);
  const mapping = Object.fromEntries([a[0], b[0], c[0]].map((r, i) => [identityKey(r), `Expert ${i}`]));
  const result = buildComparisons(mapReviewers([...a, ...b, ...c], mapping), reference());
  assert.equal(result[0].annotations.length, 3); assert.equal(result[0].consensus.longMethod, "absent");
  assert.equal(a[0].reviewerId, undefined); assert.equal(result[0].annotations[0].validatorId, "R0");
});
test("explicit same-person mapping preserves latest revision but rejects ambiguous equal revisions", () => {
  const a = ratings(["present"], "S1", "a.csv"); const b = ratings(["absent"], "S1", "b.csv");
  const mapping = { [identityKey(a[0])]: "A", [identityKey(b[0])]: "A" };
  assert.throws(() => buildComparisons(mapReviewers([...a, ...b], mapping), reference()), /Conflicting/);
  b[0].revision = 2;
  const result = buildComparisons(mapReviewers([...a, ...b], mapping), reference());
  assert.equal(result[0].annotations.length, 1); assert.equal(result[0].consensus.longMethod, null);
  assert.equal(binaryMetrics(result, "longMethod").insufficient, 1);
});
test("strict majority needs two ratings and does not confuse plurality with majority", () => {
  assert.equal(buildComparisons(ratings(["present"]), reference())[0].consensus.longMethod, null);
  assert.equal(buildComparisons(ratings(["present", "absent"]), reference())[0].consensus.longMethod, "tie");
  assert.equal(buildComparisons(ratings(["present", "present", "absent"]), reference())[0].consensus.longMethod, "present");
  assert.equal(buildComparisons(ratings(["present", "present", "absent", "uncertain"]), reference())[0].consensus.longMethod, "tie");
});
test("zero F1 is zero when errors exist and undefined when no positive cases exist", () => {
  const falsePositive = buildComparisons(ratings(["absent", "absent"]), reference());
  assert.equal(binaryMetrics(falsePositive, "longMethod").f1, 0);
  const allNegative = buildComparisons(ratings(["absent", "absent"]), reference("S1", 0));
  assert.equal(binaryMetrics(allNegative, "longMethod").f1, null);
});
test("eligibility screening changes the population, not the original votes", () => {
  const original = buildComparisons([...ratings(["present", "present"]), ...ratings(["absent", "absent"], "S2")], [...reference(), ...reference("S2", 1)]);
  const history: EligibilityDecision[] = [{ datasetSha256: "hash", sampleId: "S2", disposition: "exclude", reason: "Bundled library", reviewer: "Researcher", reviewedAt: "2026-11-19" }];
  const before = JSON.stringify(original);
  assert.equal(selectAnalysis(original, history, "original").length, 2);
  assert.equal(binaryMetrics(selectAnalysis(original, history, "screened"), "longMethod").f1, 1);
  assert.equal(JSON.stringify(original), before);
  assert.equal(selectAnalysis(original, [...history, { ...history[0], disposition: "include" }], "screened").length, 2);
  assert.throws(() => selectAnalysis(original, [{ ...history[0], datasetSha256: "wrong" }], "screened"), /does not match/);
  assert.throws(() => parseEligibilityCsv("SAMPLE_ID,DISPOSITION,REASON,REVIEWER,REVIEWED_AT\nS1,exclude,,,wrong"), /required/);
});
test("dataset hash conflicts never fall back to matching sample IDs", () => {
  const ref = reference(); ref[0].datasetSha256 = "other";
  const rows = buildComparisons(ratings(["present", "present"]), ref);
  assert.equal(rows[0].reference, null); assert.equal(binaryMetrics(rows, "longMethod").unmatched, 1);
  assert.throws(() => buildComparisons(ratings(["present", "present"]), [...reference(), ...reference()]), /Ambiguous/);
});
test("Fleiss kappa is not reported for unequal rating counts", () => {
  const rows = buildComparisons([...ratings(["present", "present"]), ...ratings(["absent", "absent", "absent"], "S2")], []);
  assert.equal(agreementMetrics(rows, "longMethod").fleissKappa, null);
  assert.equal(agreementMetrics(rows, "longMethod").krippendorffAlpha, 1);
});
test("bootstrap preserves project sizes and whole-method ratings with deterministic repetitions", () => {
  const rows = buildComparisons([...ratings(["present", "present"]), ...ratings(["absent", "absent"], "S2")], [...reference("S1", 1, "positive"), ...reference("S2", 0, "negative")]);
  const settings = { repetitions: 100, seed: 77, mode: "original" as const };
  const result = bootstrap(rows, settings);
  assert.deepEqual(result, bootstrap([...rows].reverse(), settings));
  assert.deepEqual(Object.values(result.projectSizes), [1, 1]);
  const f1 = result.intervals.find((r) => r.metric === "longMethod.f1")!;
  assert.deepEqual([f1.estimate, f1.lower, f1.upper, f1.valid, f1.undefined], [1, 1, 1, 100, 0]);
  assert.ok(result.replicates["longMethod.krippendorffAlpha"].every((v) => v === 1));
  assert.equal(linearQuantile([0, 10], .025), .25);
});
test("bootstrap reports undefined repetitions without replacing them with zero", () => {
  const rows = buildComparisons(ratings(["absent", "absent"]), reference("S1", 0));
  const result = bootstrap(rows, { repetitions: 100, seed: 1, mode: "screened" });
  const f1 = result.intervals.find((r) => r.metric === "longMethod.f1")!;
  assert.deepEqual([f1.lower, f1.upper, f1.valid, f1.undefined], [null, null, 0, 100]);
  assert.equal(result.intervals.find((r) => r.metric === "longMethod.accuracy")!.estimate, 1);
  assert.throws(() => bootstrap(rows, { repetitions: 99, seed: 1, mode: "original" }), /repetitions/);
  rows[0].reference = null;
  assert.throws(() => bootstrap(rows, { repetitions: 100, seed: 1, mode: "original" }), /project/);
});
