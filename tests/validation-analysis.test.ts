import assert from "node:assert/strict";
import test from "node:test";
import {
  agreementMetrics,
  binaryMetrics,
  buildComparisons,
  parseAnnotationCsv,
  parseCsv,
  parseReferenceCsv,
} from "../validation/analysis.ts";

test("CSV parsing preserves commas, quotes, and line breaks", () => {
  const rows = parseCsv('A,B\r\n1,"note, with ""quotes""\nand a line"\r\n');
  assert.deepEqual(rows, [{ A: "1", B: 'note, with "quotes"\nand a line' }]);
});

test("multiple validator files join to the private manifest and keep latest revisions", () => {
  const header = "ANNOTATION_ID,VALIDATOR_ID,SAMPLE_ID,DATASET_METHOD_ID,REVISION,LONG_METHOD,COMPLEX_METHOD,COMPLEX_CONDITIONAL,FEATURE_ENVY,NOTES,SUBMITTED_AT";
  const first = parseAnnotationCsv(`${header}\nA1,VAL-1,V-1,V-1,1,present,absent,absent,uncertain,old,2026-01-01\nA2,VAL-1,V-1,V-1,2,absent,absent,absent,uncertain,new,2026-01-02`, "one.csv");
  const second = parseAnnotationCsv(`${header}\nA3,VAL-2,V-1,V-1,1,present,absent,absent,absent,,2026-01-03`, "two.csv");
  const reference = parseReferenceCsv("SAMPLE_ID,DATASET_METHOD_ID,PROJECT,FILE,FUNCTION,is_long_method,is_complex_method,is_complex_conditional,is_feature_envy\nV-1,M-9,p,f.js,work,1,0,0,0", "manifest.csv");
  const comparisons = buildComparisons([...first, ...second], reference);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].annotations.length, 2);
  assert.equal(comparisons[0].reference?.datasetMethodId, "M-9");
  assert.equal(comparisons[0].annotations.find((row) => row.validatorId === "VAL-1")?.notes, "new");
  assert.equal(comparisons[0].consensus.longMethod, "tie");
  assert.equal(comparisons[0].consensus.featureEnvy, "tie");
});

test("binary metrics exclude uncertain consensus and count confusion outcomes", () => {
  const header = "ANNOTATION_ID,VALIDATOR_ID,SAMPLE_ID,REVISION,LONG_METHOD,COMPLEX_METHOD,COMPLEX_CONDITIONAL,FEATURE_ENVY";
  const annotations = parseAnnotationCsv(`${header}\nA1,V1,S1,1,present,absent,absent,absent\nA2,V1,S2,1,absent,absent,absent,absent\nA3,V1,S3,1,uncertain,absent,absent,absent`, "a.csv");
  const reference = parseReferenceCsv("SAMPLE_ID,DATASET_METHOD_ID,is_long_method,is_complex_method,is_complex_conditional,is_feature_envy\nS1,M1,1,0,0,0\nS2,M2,1,0,0,0\nS3,M3,0,0,0,0", "m.csv");
  const metrics = binaryMetrics(buildComparisons(annotations, reference), "longMethod");
  assert.deepEqual({ tp: metrics.tp, fp: metrics.fp, uncertain: metrics.uncertain, evaluated: metrics.evaluated }, { tp: 1, fp: 1, uncertain: 1, evaluated: 2 });
  assert.equal(metrics.precision, 0.5);
  assert.equal(metrics.recall, 1);
  assert.ok(Math.abs((metrics.f1 ?? 0) - 2 / 3) < 1e-12);
});

test("perfect inter-rater agreement produces alpha and kappa of one", () => {
  const header = "ANNOTATION_ID,VALIDATOR_ID,SAMPLE_ID,REVISION,LONG_METHOD,COMPLEX_METHOD,COMPLEX_CONDITIONAL,FEATURE_ENVY";
  const annotations = parseAnnotationCsv(`${header}\nA1,V1,S1,1,present,absent,absent,absent\nA2,V2,S1,1,present,absent,absent,absent\nA3,V1,S2,1,absent,absent,absent,absent\nA4,V2,S2,1,absent,absent,absent,absent`, "a.csv");
  const agreement = agreementMetrics(buildComparisons(annotations, []), "longMethod");
  assert.equal(agreement.percentAgreement, 1);
  assert.equal(agreement.krippendorffAlpha, 1);
  assert.equal(agreement.fleissKappa, 1);
});

