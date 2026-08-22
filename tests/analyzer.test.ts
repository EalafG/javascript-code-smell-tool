import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { Parser } from "acorn";
import jsx from "acorn-jsx";
import {
  analyzeSource,
  assignDeterministicIds,
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
  assert.equal(results[1].fdp, 1);
  assert.deepEqual(results[1].foreignProviders, ["customer"]);
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

test("parses JSX and analyzes callbacks independently", () => {
  const results = analyze(
    "const View = ({ items }) => <section>{items.map(item => <span>{item.name}</span>)}</section>;",
    "src/View.jsx",
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].functionName, "View");
  assert.match(results[1].functionName, /^anonymous@L1:C/);
  assert.equal(results[0].atfd, 1, "the nested callback is excluded but items.map belongs to View");
  assert.equal(results[1].atfd, 1);
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
