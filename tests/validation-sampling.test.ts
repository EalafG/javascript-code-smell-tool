import assert from "node:assert/strict";
import test from "node:test";
import { Parser } from "acorn";
import jsx from "acorn-jsx";
import {
  DEFAULT_THRESHOLDS,
  analyzeSource,
} from "../app/analyzer.ts";
import type { MethodResult } from "../app/analyzer.ts";
import {
  buildValidationSamplePackage,
  createStoredZip,
  previewSamplingPopulation,
  resolveProjectGrouping,
} from "../app/validation-sampling.ts";
import type { ValidationSamplingConfig } from "../app/validation-sampling.ts";

const JsxParser = Parser.extend(jsx());
const parser = {
  parse(source: string, options: Record<string, unknown>) {
    return JsxParser.parse(source, options as never) as never;
  },
};

const base = analyzeSource(parser, "function base(value) { return value + 1; }", {
  project: "base",
  fileName: "base.js",
  relativePath: "base/base.js",
}, DEFAULT_THRESHOLDS)[0];

function method(
  index: number,
  project: string,
  labels: Partial<Pick<MethodResult, "isLongMethod" | "isComplexMethod" | "isComplexConditional" | "isFeatureEnvy">> = {},
  relativePath = `${project}/src/file-${index}.js`,
): MethodResult {
  const enabled = {
    isLongMethod: false,
    isComplexMethod: false,
    isComplexConditional: false,
    isFeatureEnvy: false,
    ...labels,
  };
  const smellTypes = [
    enabled.isLongMethod && "LongMethod",
    enabled.isComplexMethod && "ComplexMethod",
    enabled.isComplexConditional && "ComplexConditional",
    enabled.isFeatureEnvy && "FeatureEnvy",
  ].filter(Boolean) as string[];
  const source = `function method${index}(value) { return value + ${index}; }`;
  return {
    ...base,
    id: `M-${String(index).padStart(6, "0")}`,
    project,
    fileName: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    functionName: `method${index}`,
    source,
    contextBefore: "",
    contextAfter: "",
    isLongMethod: enabled.isLongMethod,
    isComplexMethod: enabled.isComplexMethod,
    isComplexConditional: enabled.isComplexConditional,
    isFeatureEnvy: enabled.isFeatureEnvy,
    isSmelly: smellTypes.length > 0,
    smellCount: smellTypes.length,
    smellTypes,
  };
}

function config(results: MethodResult[]): ValidationSamplingConfig {
  return {
    preset: "audit",
    phase: "audit",
    title: "Deterministic audit",
    sampleSize: 8,
    seed: "UPM-TEST-SEED",
    classDistribution: "custom",
    smellyPercent: 50,
    projectGrouping: "dataset",
    projectAllocation: "equal",
    includedProjects: [...new Set(results.map((result) => result.project))],
    minimumPerProject: 0,
    maximumPerProject: 0,
    smellMinimums: { longMethod: 1, complexMethod: 1, complexConditional: 1, featureEnvy: 1 },
    multiSmellMinimum: 1,
    boundaryPercent: 0,
    includedCategories: ["production"],
    excludeGenerated: true,
    excludeExamples: true,
    excludeEmpty: true,
    minimumLoc: 1,
    deduplicateSource: true,
    includeNearbyContext: true,
    validatorCount: 3,
    annotationsPerMethod: 2,
  };
}

const context = {
  thresholds: DEFAULT_THRESHOLDS,
  parserVersion: "Acorn 8.15.0",
  analysisProfile: "authored-source-v1" as const,
  discoveredFileCount: 16,
  selectedFileCount: 16,
  successfulFileCount: 16,
  parseFailureCount: 0,
  resourceExclusionCount: 0,
  resourceSafeguardEnabled: true,
  ignoredFolders: ["build", "coverage", "dist", "node_modules"],
  excludedCategories: [],
  projectGrouping: "direct-subfolders" as const,
};

test("builds a deterministic blinded sample and keeps private detector evidence separate", async () => {
  const results = [
    method(1, "alpha", { isLongMethod: true, isComplexMethod: true }),
    method(2, "alpha", { isComplexMethod: true }),
    method(3, "alpha", { isComplexConditional: true }),
    method(4, "alpha", { isFeatureEnvy: true }),
    method(5, "beta", { isLongMethod: true }),
    method(6, "beta", { isComplexMethod: true }),
    method(7, "beta", { isComplexConditional: true }),
    method(8, "beta", { isFeatureEnvy: true }),
    ...Array.from({ length: 8 }, (_, offset) => method(offset + 9, offset % 2 ? "alpha" : "beta")),
  ];

  const first = await buildValidationSamplePackage(results, config(results), context);
  const second = await buildValidationSamplePackage(results, config(results), context);
  const artifact = (name: string, output = first) => output.artifacts.find((item) => item.name === name)?.contents;

  assert.equal(first.selectedCount, 8);
  assert.equal(first.datasetSha256, second.datasetSha256);
  assert.equal(artifact("validation-sample.blinded.json"), artifact("validation-sample.blinded.json", second));
  assert.equal(artifact("private/sampling-manifest.csv"), artifact("private/sampling-manifest.csv", second));
  const manifestLines = artifact("private/sampling-manifest.csv")?.trimEnd().split("\r\n") ?? [];
  assert.ok(manifestLines.length > 1);
  assert.equal(manifestLines[0].split(",").length, manifestLines[1].split(",").length);
  assert.match(manifestLines[0], /FE_BATCH_BYTE_LIMIT/);

  const payload = JSON.parse(artifact("validation-sample.blinded.json") ?? "{}") as {
    samples: Array<Record<string, unknown>>;
  };
  assert.equal(payload.samples.length, 8);
  for (const sample of payload.samples) {
    assert.equal(sample.datasetMethodId, sample.sampleId);
    for (const privateField of ["loc", "cyclo", "atfd", "isSmelly", "smellTypes", "samplingStratum", "sampleRole"]) {
      assert.equal(Object.hasOwn(sample, privateField), false, `${privateField} must not be exposed to validators`);
    }
  }

  const assignedCounts = new Map<string, number>();
  for (const item of first.artifacts.filter(({ name }) => name.startsWith("validator-payloads/"))) {
    const validatorPayload = JSON.parse(item.contents) as { samples: Array<{ sampleId: string }> };
    for (const sample of validatorPayload.samples) {
      assignedCounts.set(sample.sampleId, (assignedCounts.get(sample.sampleId) ?? 0) + 1);
    }
  }
  assert.deepEqual([...assignedCounts.values()].sort(), Array(8).fill(2));
});

test("automatic grouping distinguishes an umbrella dataset from one project", () => {
  const umbrella = [
    method(1, "Sample", {}, "Sample/alpha/src/a.js"),
    method(2, "Sample", {}, "Sample/beta/src/b.js"),
  ];
  const atom = [
    method(1, "atom", {}, "atom/packages/welcome/a.js"),
    method(2, "atom", {}, "atom/src/b.js"),
  ];

  assert.equal(resolveProjectGrouping(umbrella, "auto"), "second-folder");
  assert.equal(resolveProjectGrouping(atom, "auto"), "dataset");
});

test("preview records deterministic exclusion reasons", () => {
  const original = method(1, "alpha");
  const duplicate = { ...method(2, "alpha"), source: original.source };
  const testMethod = { ...method(3, "alpha", {}, "alpha/tests/example.test.js"), codeCategory: "test" as const };
  const options = config([original, duplicate, testMethod]);
  options.sampleSize = 1;
  const preview = previewSamplingPopulation([original, duplicate, testMethod], options);

  assert.equal(preview.eligibleCount, 1);
  assert.equal(preview.exclusionCounts.DUPLICATE_SOURCE, 1);
  assert.equal(preview.exclusionCounts.CATEGORY_EXCLUDED, 1);
});

test("outer collection and repository names do not exclude all production methods", () => {
  const production = method(1, "atom", {}, "Sample/atom/src/main.js");
  const example = method(2, "atom", {}, "Sample/atom/examples/demo.js");
  const atomOptions = config([production, example]);
  atomOptions.sampleSize = 1;
  const atomPreview = previewSamplingPopulation([production, example], atomOptions);

  assert.equal(atomPreview.eligibleCount, 1);
  assert.equal(atomPreview.exclusionCounts.EXAMPLE_OR_DEMO, 1);

  const generatedNamedProject = method(3, "generated", {}, "generated/src/main.js");
  const generatedOptions = config([generatedNamedProject]);
  generatedOptions.sampleSize = 1;
  const generatedPreview = previewSamplingPopulation([generatedNamedProject], generatedOptions);

  assert.equal(generatedPreview.eligibleCount, 1);
  assert.equal(generatedPreview.exclusionCounts.GENERATED_OR_MINIFIED, undefined);
});

test("stored ZIP writer emits a valid deterministic ZIP signature", async () => {
  const artifacts = [{ name: "hello.txt", contents: "research\n" }];
  const first = new Uint8Array(await createStoredZip(artifacts).arrayBuffer());
  const second = new Uint8Array(await createStoredZip(artifacts).arrayBuffer());
  assert.deepEqual(first, second);
  assert.deepEqual([...first.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});
