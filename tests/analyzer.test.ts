import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { Parser } from "acorn";
import jsx from "acorn-jsx";
import {
  analyzeProjectSources,
  analyzeSource,
  assignDeterministicIds,
  deduplicateMethodResults,
} from "../app/analyzer.ts";
import type { MethodResult, Thresholds } from "../app/analyzer.ts";
import { CSV_HEADERS, toCsv } from "../app/csv.ts";

const JsxParser = Parser.extend(jsx());
const parser = {
  parse(source: string, options: Record<string, unknown>) {
    return JsxParser.parse(source, options as never) as never;
  },
};

const thresholds: Thresholds = {
  longLoc: 31,
  longCompound: false,
  longCyclo: 10,
  longNesting: 5,
  complexCyclo: 10,
  conditionalOps: 5,
  few: 3,
};

function analyze(source: string, relativePath = "src/example.js") {
  return analyzeSource(parser, source, {
    project: "research-project",
    fileName: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
  }, thresholds);
}

test("recognizes class methods, nested arrows, and optional chains without duplicates", () => {
  const results = analyze(`class Checkout {
  calculate(customer) {
    const nested = () => customer.name + customer.age + customer.address.city;
    return this.total + nested();
  }
}
const top = (value) => value?.profile?.name;`);

  assert.deepEqual(results.map((result) => result.functionName), ["calculate", "nested", "top"]);
  assert.deepEqual(results.map((result) => result.functionType), [
    "MethodDefinition",
    "ArrowFunctionExpression",
    "ArrowFunctionExpression",
  ]);
  assert.equal(new Set(results.map((result) => `${result.startLine}:${result.endLine}:${result.functionName}`)).size, 3);
  assert.equal(results[0].atfd, 0, "nested member accesses must not contribute to the parent method");
  assert.equal(results[1].atfd, 4);
  assert.equal(results[1].fdp, 2);
  assert.deepEqual(results[1].foreignProviders, ["unknown:customer", "unresolved:unknown:customer.address"]);
  assert.equal(results[1].isFeatureEnvy, true);
  assert.equal(results[2].atfd, 2);
});

test("calculates cyclomatic and conditional metrics from explicit operators", () => {
  const [result] = analyze(`function decide(a, b, c, d, e, f) {
  if (a && b || !c && d >= 4 && e !== f) {
    while (d) { d--; }
  }
  return a ? b : c;
}`);

  assert.equal(result.cyclo, 8);
  assert.equal(result.maxNesting, 2);
  assert.equal(result.condOpsMax, 7);
  assert.equal(result.condNesting, 2);
  assert.equal(result.numConditions, 3);
  assert.equal(result.nop, 6);
  assert.equal(result.isComplexConditional, true);
});

test("covers every documented cyclomatic decision construct", () => {
  const [result] = analyze(`function decisions(a, b, c, d, object, values) {
  if (a) {}
  else if (b) {}
  for (; c;) { break; }
  for (const key in object) { void key; }
  for (const value of values) { void value; }
  while (c) { break; }
  do { break; } while (d);
  try {} catch (error) { void error; }
  switch (a) { case 1: break; case 2: break; default: break; }
  const selected = a ? b : c;
  return selected && b || c;
}`);

  assert.equal(result.cyclo, 14);
  assert.equal(result.maxNesting, 1);
  assert.equal(result.numConditions, 6);
  assert.equal(result.condNesting, 1);
});

test("does not treat switch case labels as conditional-expression sites", () => {
  const [result] = analyze(`function route(value) {
  switch (value) {
    case 1: return "one";
    case 2: return "two";
    default: return "other";
  }
}`);

  assert.equal(result.cyclo, 3, "non-default cases still contribute to cyclomatic complexity");
  assert.equal(result.numConditions, 0);
  assert.equal(result.condNesting, 0);
  assert.equal(result.condOpsMax, 0);
});

test("treats an else-if chain as one nesting level", () => {
  const [result] = analyze(`function category(value) {
  if (value > 10) return "high";
  else if (value > 5) return "medium";
  else if (value > 0) return "low";
  return "none";
}`);

  assert.equal(result.cyclo, 4);
  assert.equal(result.numConditions, 3);
  assert.equal(result.maxNesting, 1);
  assert.equal(result.condNesting, 1);
});

test("counts destructured local bindings and catch bindings in NOLV", () => {
  const [result] = analyze(`function collect(input) {
  const { first, second: renamed } = input;
  const [third, , fourth] = input.items;
  try {
    return first + renamed + third + fourth;
  } catch ({ message }) {
    let fallback;
    return fallback || message;
  }
}`);

  assert.equal(result.nolv, 6);
});

test("includes member calls in distinct coupling tuples, as the paper does", () => {
  const [result] = analyze(`function process(service, customer) {
  service.save(customer);
  console.log(customer.name);
  return customer.profile.id;
}`);

  assert.equal(result.atfd, 5);
  assert.equal(result.fdp, 4);
  assert.ok(result.foreignProviders.includes("unknown:service"));
  assert.ok(result.couplingTuples.includes("F:unknown:service#save"));
  assert.equal(result.foreignMemberCalls, 2);
  assert.deepEqual(result.foreignCallProviders, ["unknown:console", "unknown:service"]);
  assert.equal(result.isFeatureEnvy, false);
});

test("parses JSX and analyzes callbacks independently", () => {
  const results = analyze(
    "const View = ({ items }) => <section>{items.map(item => <span>{item.name}</span>)}</section>;",
    "src/View.jsx",
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].functionName, "View");
  assert.match(results[1].functionName, /^anonymous@L1:C/);
  assert.equal(results[0].atfd, 1, "the nested callback is excluded while items.map remains a coupling tuple");
  assert.equal(results[0].foreignMemberCalls, 1);
  assert.deepEqual(results[0].foreignCallProviders, ["unknown:items"]);
  assert.equal(results[1].atfd, 1);
});

test("counts distinct inferred type/property tuples rather than repeated AST occurrences", () => {
  const [result] = analyze(`function repeated(customer) {
  return customer.name + customer.name + customer.name + customer.name;
}`);

  assert.equal(result.atd, 1);
  assert.equal(result.atfd, 1);
  assert.equal(result.fdp, 1);
  assert.equal(result.isFeatureEnvy, false);
  assert.deepEqual(result.couplingTuples, ["F:unknown:customer#name"]);
});

test("detects Feature Envy from many foreign properties on one inferred provider", () => {
  const [result] = analyze(`function inspect(customer) {
  return customer.name + customer.age + customer.email + customer.status;
}`);

  assert.equal(result.atfd, 4);
  assert.equal(result.laa, 0);
  assert.equal(result.fdp, 1);
  assert.equal(result.isFeatureEnvy, true);
});

test("uses call-site parameter flow and this-type hierarchy for locality", () => {
  const results = analyze(`class Point {
  x = 0;
  static MP = 2;
  midpoint(other) {
    return this.x + other.x + Point.MP;
  }
}
const first = new Point();
const second = new Point();
first.midpoint(second);`);
  const result = results.find((item) => item.functionName === "midpoint");
  assert.ok(result);
  assert.equal(result.atd, 2);
  assert.equal(result.atfd, 1);
  assert.equal(result.laa, 0.5);
  assert.equal(result.fdp, 1);
  assert.deepEqual(result.foreignProviders, ["constructor:Point"]);
  assert.equal(result.typeInferenceCoverage, 1);
});

test("keeps syntactic this access local when its concrete type is unresolved", () => {
  const [result] = analyze("function currentState() { return this.value; }");
  assert.equal(result.atd, 1);
  assert.equal(result.atfd, 0);
  assert.equal(result.laa, 1);
  assert.deepEqual(result.couplingTuples, ["L:unknown:this#value"]);
});

test("propagates constructor arguments into instance property types", () => {
  const results = analyze(`class Customer {
  constructor(profile) { this.profile = profile; }
  displayName() { return this.profile.name; }
}
const profile = { name: "Ada" };
const customer = new Customer(profile);
customer.displayName();`);
  const result = results.find((item) => item.functionName === "displayName");
  assert.ok(result);
  assert.equal(result.atfd, 1);
  assert.equal(result.unknownAccessCount, 0);
  assert.equal(result.typeInferenceCoverage, 1);
  assert.match(result.foreignProviders[0], /^object:src\/example\.js@/);
});

test("propagates aliases without inventing an additional provider", () => {
  const [result] = analyze(`function alias(customer) {
  const sameCustomer = customer;
  return sameCustomer.name + customer.age;
}`);

  assert.equal(result.atfd, 2);
  assert.equal(result.fdp, 1);
  assert.deepEqual(result.foreignProviders, ["unknown:customer"]);
});

test("normalizes all array index accesses to one IDX tuple", () => {
  const results = analyze(`function firstThree(items, index) {
  return items[0] + items[1] + items[index];
}
const values = [1, 2, 3];
firstThree(values, 2);`);
  const result = results.find((item) => item.functionName === "firstThree");
  assert.ok(result);
  assert.equal(result.atfd, 1);
  assert.equal(result.fdp, 1);
  assert.equal(result.couplingTuples.length, 1);
  assert.match(result.couplingTuples[0], /^F:array:src\/example\.js@\d+#IDX$/);
});

test("excludes a newly added property but counts a later update/read coupling", () => {
  const additionResults = analyze("const record = {}; function add(target) { target.created = 1; } add(record);");
  const addition = additionResults.find((item) => item.functionName === "add");
  assert.ok(addition);
  assert.equal(addition.atfd, 0);

  const results = analyze(`function update(target) {
  target.created = 1;
  target.created = 2;
  return target.created;
}
const record = {};
update(record);`);
  const update = results.find((item) => item.functionName === "update");
  assert.ok(update);
  assert.equal(update.atfd, 1);
});

test("reports uncertainty separately from the smell metrics", () => {
  const [unknown] = analyze("function read(customer) { return customer.name; }");
  assert.equal(unknown.unknownAccessCount, 1);
  assert.equal(unknown.typeInferenceCoverage, 0);
  assert.equal(unknown.feInferenceMode, "batched-project-static-object-type-inference-v1");
  assert.equal(unknown.feMaxIterations, 12);
  assert.equal(unknown.feTypeSetLimit, 12);
  assert.equal(unknown.feBatchId, "B-0001");
  assert.equal(unknown.feBatchFileCount, 1);
  assert.equal(unknown.feBatchSizeLimit, 200);

  const projectResults = analyzeProjectSources(parser, [{
    source: "const customer = { name: 'A' }; function read(value) { return value.name; } read(customer);",
    descriptor: { project: "research-project", fileName: "resolved.js", relativePath: "src/resolved.js" },
  }], thresholds);
  const resolved = projectResults.find((item) => item.functionName === "read");
  assert.ok(resolved);
  assert.equal(resolved.unknownAccessCount, 0);
  assert.equal(resolved.typeInferenceCoverage, 1);
});

test("sorts files into deterministic bounded inference batches", () => {
  const entries = Array.from({ length: 201 }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, "0");
    return {
      source: `function method${ordinal}() { return this.value; }`,
      descriptor: {
        project: "batched-project",
        fileName: `file-${ordinal}.js`,
        relativePath: `src/file-${ordinal}.js`,
      },
    };
  }).reverse();
  const results = analyzeProjectSources(parser, entries, thresholds);
  const first = results.find((result) => result.relativePath === "src/file-001.js");
  const last = results.find((result) => result.relativePath === "src/file-201.js");
  assert.ok(first);
  assert.ok(last);
  assert.equal(first.feBatchId, "B-0001");
  assert.equal(first.feBatchFileCount, 200);
  assert.equal(last.feBatchId, "B-0002");
  assert.equal(last.feBatchFileCount, 1);
});

test("handles empty and anonymous functions safely", () => {
  const results = analyze("const empty = function () {}; [1].map(() => 1);");
  assert.equal(results.length, 2);
  assert.equal(results[0].functionName, "empty");
  assert.equal(results[0].loc, 1);
  assert.equal(results[0].spanLoc, 1);
  assert.equal(results[0].commentLines, 0);
  assert.equal(results[0].blankLines, 0);
  assert.equal(results[0].cyclo, 1);
  assert.equal(results[0].laa, 1);
  assert.match(results[1].functionName, /^anonymous@L1:C/);
});

test("separates code LOC from physical span, comment-only lines, and blank lines", () => {
  const [result] = analyze(`function documented(value) {
  // This comment should not count as code.

  const url = "https://example.test"; // A trailing comment remains a code line.
  /*
   * This block is documentation.
   */
  return value + url.length;
}`);

  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 9);
  assert.equal(result.spanLoc, 9);
  assert.equal(result.loc, 4);
  assert.equal(result.commentLines, 4);
  assert.equal(result.blankLines, 1);
  assert.equal(result.isLongMethod, false);
});

test("assigns deterministic IDs after sorting by relative path and location", () => {
  const later = analyze("function second() {}", "z/second.js");
  const earlier = analyze("function first() {}", "a/first.js");
  const results = assignDeterministicIds([...later, ...earlier]);
  assert.equal(results[0].id, "M-000001");
  assert.equal(results[0].functionName, "first");
  assert.equal(results[1].id, "M-000002");
  assert.equal(results[1].functionName, "second");
});

test("deduplicates exact rows without collapsing distinct same-line methods", () => {
  const methods = analyze("const object = { same() {}, same() {} };");
  assert.equal(methods.length, 2);

  const results = deduplicateMethodResults([methods[0], methods[0], methods[1]]);
  assert.equal(results.length, 2);
  assert.notEqual(results[0].startOffset, results[1].startOffset);
});

test("exports the stable research schema and escapes CSV values", () => {
  const [base] = assignDeterministicIds(analyze("function clean() {}", "src/a,b.js"));
  const result: MethodResult = {
    ...base,
    project: 'Research, "A"',
    functionName: 'clean "method"',
  };
  const csv = toCsv([result]);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], CSV_HEADERS.join(","));
  assert.match(lines[1], /"Research, ""A"""/);
  assert.match(lines[1], /"src\/a,b\.js"/);
  assert.match(lines[1], /"clean ""method"""/);
  assert.equal(CSV_HEADERS[8], "SPAN_LOC");
  assert.equal(CSV_HEADERS[9], "COMMENT_LINES");
  assert.equal(CSV_HEADERS[10], "BLANK_LINES");
  assert.ok(CSV_HEADERS.includes("FOREIGN_MEMBER_CALLS"));
  assert.ok(CSV_HEADERS.includes("FOREIGN_CALL_PROVIDERS"));
  assert.ok(CSV_HEADERS.includes("ATD"));
  assert.ok(CSV_HEADERS.includes("COUPLING_TUPLES"));
  assert.ok(CSV_HEADERS.includes("TYPE_INFERENCE_COVERAGE"));
  assert.ok(CSV_HEADERS.includes("UNKNOWN_ACCESS_COUNT"));
  assert.ok(CSV_HEADERS.includes("FE_INFERENCE_MODE"));
  assert.ok(CSV_HEADERS.includes("FE_MAX_ITERATIONS"));
  assert.ok(CSV_HEADERS.includes("FE_TYPE_SET_LIMIT"));
  assert.ok(CSV_HEADERS.includes("FE_BATCH_ID"));
  assert.ok(CSV_HEADERS.includes("FE_BATCH_FILE_COUNT"));
  assert.ok(CSV_HEADERS.includes("FE_BATCH_SIZE_LIMIT"));
  assert.ok(csv.endsWith("\r\n"));
});

test("ships a browser-local Acorn 8 parser with JSX support", async () => {
  const bundle = await readFile(new URL("../public/acorn.min.js", import.meta.url), "utf8");
  const browserGlobal: Record<string, unknown> = {};
  vm.runInNewContext(bundle, browserGlobal);
  const localAcorn = browserGlobal.acorn as {
    version: string;
    parse: (source: string, options: Record<string, unknown>) => unknown;
  };
  assert.match(localAcorn.version, /^8\./);
  assert.doesNotThrow(() => localAcorn.parse(
    "const View = () => <main>{items.map(item => item.name)}</main>",
    { ecmaVersion: "latest", sourceType: "module", locations: true },
  ));
  const comments: unknown[] = [];
  localAcorn.parse(
    "function documented() {\n  // documentation\n  return true;\n}",
    { ecmaVersion: "latest", sourceType: "module", locations: true, onComment: comments },
  );
  assert.equal(comments.length, 1, "the shipped browser parser must expose comments for LOC classification");
});
