import {
  calculateFeatureEnvyMetrics,
  createFeatureEnvyModel,
  finalizeFeatureEnvyModel,
  indexFeatureEnvySource,
} from "./feature-envy.ts";
import type { FeatureEnvyModel } from "./feature-envy.ts";

export type Thresholds = {
  longLoc: number;
  longCompound: boolean;
  longCyclo: number;
  longNesting: number;
  complexCyclo: number;
  conditionalOps: number;
  conditionalLogicalOpsMax: number;
  few: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  longLoc: 31,
  longCompound: false,
  longCyclo: 10,
  longNesting: 5,
  complexCyclo: 10,
  conditionalOps: 5,
  conditionalLogicalOpsMax: 3,
  few: 3,
};

export type SourceCategory =
  | "production"
  | "test"
  | "fixture"
  | "vendor"
  | "benchmark"
  | "maintenance";

export function classifySourceCategory(relativePath: string): SourceCategory {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/");
  const fileName = parts.at(-1) ?? normalized;
  if (parts.includes("fixtures") || parts.includes("fixture")) return "fixture";
  if (parts.includes("vendor")) return "vendor";
  if (parts.includes("benchmarks") || parts.includes("benchmark") || fileName.includes(".bench.")) {
    return "benchmark";
  }
  if (
    parts.some((part) => ["spec", "specs", "test", "tests", "__tests__"].includes(part)) ||
    /\.(spec|test)\.(?:js|jsx|mjs|cjs)$/i.test(fileName)
  ) {
    return "test";
  }
  if (parts.includes("script") || parts.includes("scripts")) return "maintenance";
  return "production";
}

export type SourceDescriptor = {
  project: string;
  fileName: string;
  relativePath: string;
};

export type MethodResult = {
  id: string;
  project: string;
  fileName: string;
  relativePath: string;
  codeCategory: SourceCategory;
  functionName: string;
  functionType: string;
  startLine: number;
  endLine: number;
  contextStartLine: number;
  contextEndLine: number;
  startOffset: number;
  endOffset: number;
  loc: number;
  spanLoc: number;
  commentLines: number;
  blankLines: number;
  delimiterLines: number;
  cyclo: number;
  maxNesting: number;
  nop: number;
  nolv: number;
  condOpsMax: number;
  logicalOpsMax: number;
  condNesting: number;
  numConditions: number;
  atd: number;
  atfd: number;
  localAccessCount: number;
  laa: number;
  fdp: number;
  foreignProviders: string[];
  couplingTuples: string[];
  typeInferenceCoverage: number;
  unknownAccessCount: number;
  feInferenceMode: string;
  feMaxIterations: number;
  feTypeSetLimit: number;
  feBatchId: string;
  feBatchFileCount: number;
  feBatchSizeLimit: number;
  feScope: string;
  feIndexedFileCount: number;
  foreignMemberCalls: number;
  foreignCallProviders: string[];
  isLongMethod: boolean;
  isComplexMethod: boolean;
  isComplexConditional: boolean;
  isComplexConditionalSonar: boolean;
  isFeatureEnvy: boolean;
  isSmelly: boolean;
  smellCount: number;
  smellTypes: string[];
  source: string;
  sourceContext: string;
};

export type AstNode = {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
};

type FunctionCandidate = {
  functionNode: AstNode;
  segmentNode: AstNode;
  functionType: string;
  functionName: string;
};

type AstComment = {
  start: number;
  end: number;
};

type SourceLineKind = "code" | "comment" | "blank" | "delimiter";

export type ParsedSource = {
  ast: AstNode;
  comments: AstComment[];
  source: string;
  descriptor: SourceDescriptor;
};

export type ProjectAnalysisModel = FeatureEnvyModel;

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const STRUCTURAL_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "CatchClause",
  "ConditionalExpression",
]);

const CYCLO_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
  "ConditionalExpression",
]);

const COMPARISON_OPERATORS = new Set([
  "==", "===", "!=", "!==", "<", ">", "<=", ">=",
]);

function isNode(value: unknown): value is AstNode {
  return Boolean(value && typeof value === "object" && typeof (value as AstNode).type === "string");
}

function isFunctionNode(node: AstNode): boolean {
  return FUNCTION_TYPES.has(node.type);
}

function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const value = node[key];
    if (isNode(value)) children.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    }
  }
  return children;
}

function propertyName(node: unknown, source: string): string {
  if (!isNode(node)) return "unknown";
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
    return String(node.name ?? "unknown");
  }
  if (node.type === "Literal") return String(node.value ?? "unknown");
  return source.slice(node.start, node.end).trim() || "computed";
}

function patternName(node: unknown, source: string): string {
  if (!isNode(node)) return "anonymous";
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "MemberExpression") return propertyName(node.property, source);
  return source.slice(node.start, node.end).replace(/\s+/g, " ").slice(0, 48) || "anonymous";
}

function inferFunctionName(
  node: AstNode,
  parent: AstNode | null,
  source: string,
): string {
  if (isNode(node.id) && node.id.type === "Identifier") return String(node.id.name);
  if (parent?.type === "VariableDeclarator") return patternName(parent.id, source);
  if (parent?.type === "AssignmentExpression") return patternName(parent.left, source);
  if (parent?.type === "PropertyDefinition") return propertyName(parent.key, source);
  const line = node.loc?.start.line ?? 1;
  const column = (node.loc?.start.column ?? 0) + 1;
  return `anonymous@L${line}:C${column}`;
}

function collectFunctions(ast: AstNode, source: string): FunctionCandidate[] {
  const candidates: FunctionCandidate[] = [];
  const ownedFunctionNodes = new WeakSet<object>();

  function visit(node: AstNode, parent: AstNode | null) {
    if (node.type === "MethodDefinition" && isNode(node.value) && isFunctionNode(node.value)) {
      ownedFunctionNodes.add(node.value);
      candidates.push({
        functionNode: node.value,
        segmentNode: node,
        functionType: "MethodDefinition",
        functionName: propertyName(node.key, source),
      });
    } else if (node.type === "Property" && isNode(node.value) && isFunctionNode(node.value)) {
      ownedFunctionNodes.add(node.value);
      candidates.push({
        functionNode: node.value,
        segmentNode: node,
        functionType: node.method ? "ObjectMethod" : node.value.type,
        functionName: propertyName(node.key, source),
      });
    } else if (isFunctionNode(node) && !ownedFunctionNodes.has(node)) {
      candidates.push({
        functionNode: node,
        segmentNode: node,
        functionType: node.type,
        functionName: inferFunctionName(node, parent, source),
      });
    }

    for (const child of childNodes(node)) visit(child, node);
  }

  visit(ast, null);
  return candidates.sort((a, b) =>
    a.segmentNode.start - b.segmentNode.start || a.segmentNode.end - b.segmentNode.end,
  );
}

function countConditionOperators(expression: AstNode): number {
  let count = 0;
  function visit(node: AstNode) {
    if (node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||")) {
      count += 1;
    } else if (node.type === "UnaryExpression" && node.operator === "!") {
      count += 1;
    } else if (node.type === "BinaryExpression" && COMPARISON_OPERATORS.has(String(node.operator))) {
      count += 1;
    }
    for (const child of childNodes(node)) {
      if (!isFunctionNode(child)) visit(child);
    }
  }
  visit(expression);
  return count;
}

function countLogicalConditionOperators(expression: AstNode): number {
  let count = 0;
  function visit(node: AstNode) {
    if (node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||")) {
      count += 1;
    } else if (node.type === "ConditionalExpression") {
      count += 1;
    }
    for (const child of childNodes(node)) {
      if (!isFunctionNode(child)) visit(child);
    }
  }
  visit(expression);
  return count;
}

function conditionExpression(node: AstNode): AstNode | null {
  if (["IfStatement", "WhileStatement", "DoWhileStatement", "ConditionalExpression"].includes(node.type)) {
    return isNode(node.test) ? node.test : null;
  }
  if (node.type === "ForStatement") return isNode(node.test) ? node.test : null;
  return null;
}

function logicalConditionExpression(node: AstNode): AstNode | null {
  if (node.type === "ConditionalExpression") return node;
  return conditionExpression(node);
}

function countPatternBindings(node: unknown): number {
  if (!isNode(node)) return 0;
  if (node.type === "Identifier") return 1;
  if (node.type === "RestElement") return countPatternBindings(node.argument);
  if (node.type === "AssignmentPattern") return countPatternBindings(node.left);
  if (node.type === "ArrayPattern") {
    return Array.isArray(node.elements)
      ? node.elements.reduce<number>((count, element) => count + countPatternBindings(element), 0)
      : 0;
  }
  if (node.type === "ObjectPattern") {
    if (!Array.isArray(node.properties)) return 0;
    return node.properties.reduce<number>((count, property) => {
      if (!isNode(property)) return count;
      if (property.type === "RestElement") return count + countPatternBindings(property.argument);
      if (property.type === "Property") return count + countPatternBindings(property.value);
      return count;
    }, 0);
  }
  return 0;
}

function classifySourceLines(source: string, comments: AstComment[]): SourceLineKind[] {
  const sortedComments = [...comments].sort((a, b) => a.start - b.start || a.end - b.end);
  const strippedParts: string[] = [];
  let cursor = 0;

  for (const comment of sortedComments) {
    const start = Math.max(cursor, comment.start);
    const end = Math.max(start, comment.end);
    strippedParts.push(source.slice(cursor, start));
    strippedParts.push(source.slice(start, end).replace(/[^\r\n]/g, " "));
    cursor = end;
  }
  strippedParts.push(source.slice(cursor));

  const originalLines = source.split(/\r\n|\r|\n/);
  const commentStrippedLines = strippedParts.join("").split(/\r\n|\r|\n/);
  return originalLines.map((line, index) => {
    if (!line.trim()) return "blank";
    const commentStrippedLine = (commentStrippedLines[index] ?? "").trim();
    if (!commentStrippedLine) return "comment";
    if (/^[()[\]{};,]+$/.test(commentStrippedLine)) return "delimiter";
    return "code";
  });
}

function measureSegmentLines(segmentNode: AstNode, sourceLineKinds: SourceLineKind[]) {
  const startLine = segmentNode.loc?.start.line ?? 1;
  const endLine = segmentNode.loc?.end.line ?? startLine;
  let loc = 0;
  let commentLines = 0;
  let blankLines = 0;
  let delimiterLines = 0;

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const kind = sourceLineKinds[lineNumber - 1] ?? "code";
    if (kind === "blank") blankLines += 1;
    else if (kind === "comment") commentLines += 1;
    else if (kind === "delimiter") delimiterLines += 1;
    else loc += 1;
  }

  return {
    startLine,
    endLine,
    startOffset: segmentNode.start,
    endOffset: segmentNode.end,
    loc: Math.max(1, loc),
    spanLoc: Math.max(1, endLine - startLine + 1),
    commentLines,
    blankLines,
    delimiterLines,
  };
}

function calculateMetrics(
  functionNode: AstNode,
  segmentNode: AstNode,
  source: string,
  sourceLineKinds: SourceLineKind[],
  relativePath: string,
  featureEnvyModel: FeatureEnvyModel,
) {
  let cyclo = 1;
  let maxNesting = 0;
  let nolv = 0;
  let condOpsMax = 0;
  let logicalOpsMax = 0;
  let condNesting = 0;
  let numConditions = 0;

  function visit(
    node: AstNode,
    nesting: number,
    conditionalDepth: number,
  ) {
    if (node !== functionNode && isFunctionNode(node)) return;

    if (CYCLO_TYPES.has(node.type)) cyclo += 1;
    if (node.type === "SwitchCase" && isNode(node.test)) cyclo += 1;
    if (node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||")) {
      cyclo += 1;
    }
    if (node.type === "VariableDeclarator") nolv += countPatternBindings(node.id);
    if (node.type === "CatchClause") nolv += countPatternBindings(node.param);

    const expression = conditionExpression(node);
    const hasCondition = Boolean(expression);
    const nextConditionalDepth = conditionalDepth + (hasCondition ? 1 : 0);
    if (expression) {
      numConditions += 1;
      condOpsMax = Math.max(condOpsMax, countConditionOperators(expression));
      const logicalExpression = logicalConditionExpression(node);
      if (logicalExpression) {
        logicalOpsMax = Math.max(logicalOpsMax, countLogicalConditionOperators(logicalExpression));
      }
      condNesting = Math.max(condNesting, nextConditionalDepth);
    }

    const nextNesting = nesting + (STRUCTURAL_TYPES.has(node.type) ? 1 : 0);
    maxNesting = Math.max(maxNesting, nextNesting);
    for (const child of childNodes(node)) {
      const isElseIf =
        node.type === "IfStatement" &&
        child === node.alternate &&
        child.type === "IfStatement";
      visit(
        child,
        isElseIf ? nesting : nextNesting,
        isElseIf ? conditionalDepth : nextConditionalDepth,
      );
    }
  }

  visit(functionNode, 0, 0);
  const params = Array.isArray(functionNode.params) ? functionNode.params.length : 0;
  const featureEnvy = calculateFeatureEnvyMetrics(
    featureEnvyModel,
    functionNode,
    source,
    relativePath,
  );
  return {
    ...measureSegmentLines(segmentNode, sourceLineKinds),
    cyclo,
    maxNesting,
    nop: params,
    nolv,
    condOpsMax,
    logicalOpsMax,
    condNesting,
    numConditions,
    ...featureEnvy,
    source: source.slice(segmentNode.start, segmentNode.end),
  };
}

export function classifyResult(result: MethodResult, thresholds: Thresholds): MethodResult {
  const isLongMethod = thresholds.longCompound
    ? result.loc >= thresholds.longLoc &&
      (result.cyclo >= thresholds.longCyclo || result.maxNesting >= thresholds.longNesting)
    : result.loc >= thresholds.longLoc;
  const isComplexMethod = result.cyclo >= thresholds.complexCyclo;
  const isComplexConditional = result.condOpsMax >= thresholds.conditionalOps;
  const isComplexConditionalSonar =
    result.logicalOpsMax > thresholds.conditionalLogicalOpsMax;
  const isFeatureEnvy =
    result.atfd > thresholds.few &&
    result.localAccessCount * 3 < result.atd &&
    result.fdp <= thresholds.few;

  const smellTypes = [
    isLongMethod ? "Long Method" : null,
    isComplexMethod ? "Complex Method" : null,
    isComplexConditional ? "Complex Conditional" : null,
    isFeatureEnvy ? "Feature Envy" : null,
  ].filter((value): value is string => Boolean(value));

  return {
    ...result,
    isLongMethod,
    isComplexMethod,
    isComplexConditional,
    isComplexConditionalSonar,
    isFeatureEnvy,
    isSmelly: smellTypes.length > 0,
    smellCount: smellTypes.length,
    smellTypes,
  };
}

export function parseJavaScriptSource(
  parser: { parse: (source: string, options: Record<string, unknown>) => AstNode },
  source: string,
  descriptor: SourceDescriptor,
): ParsedSource {
  let ast: AstNode;
  let comments: AstComment[];
  const baseOptions = {
    ecmaVersion: "latest",
    locations: true,
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
  };
  try {
    comments = [];
    ast = parser.parse(source, { ...baseOptions, sourceType: "module", onComment: comments });
  } catch (moduleError) {
    try {
      comments = [];
      ast = parser.parse(source, {
        ...baseOptions,
        sourceType: "script",
        allowReturnOutsideFunction: true,
        onComment: comments,
      });
    } catch {
      throw moduleError;
    }
  }

  return { ast, comments, source, descriptor };
}

export function createProjectAnalysisModel(batchId = "P-0001"): ProjectAnalysisModel {
  return createFeatureEnvyModel(batchId);
}

export function indexParsedSource(model: ProjectAnalysisModel, parsed: ParsedSource) {
  indexFeatureEnvySource(model, parsed.ast, parsed.source, parsed.descriptor.relativePath);
}

export function finalizeProjectAnalysisModel(model: ProjectAnalysisModel) {
  finalizeFeatureEnvyModel(model);
}

export function analyzeParsedSource(
  parsed: ParsedSource,
  thresholds: Thresholds,
  featureEnvyModel: ProjectAnalysisModel,
): MethodResult[] {
  const { ast, comments, source, descriptor } = parsed;
  const sourceLineKinds = classifySourceLines(source, comments);
  const sourceLines = source.split(/\r\n|\n|\r/);
  return collectFunctions(ast, source).map((candidate) => {
    const metrics = calculateMetrics(
      candidate.functionNode,
      candidate.segmentNode,
      source,
      sourceLineKinds,
      descriptor.relativePath,
      featureEnvyModel,
    );
    const contextStartLine = Math.max(1, metrics.startLine - 2);
    const contextEndLine = Math.min(sourceLines.length, metrics.endLine + 2);
    const unclassified: MethodResult = {
      id: "",
      project: descriptor.project,
      fileName: descriptor.fileName,
      relativePath: descriptor.relativePath,
      codeCategory: classifySourceCategory(descriptor.relativePath),
      functionName: candidate.functionName,
      functionType: candidate.functionType,
      ...metrics,
      contextStartLine,
      contextEndLine,
      sourceContext: sourceLines.slice(contextStartLine - 1, contextEndLine).join("\n"),
      isLongMethod: false,
      isComplexMethod: false,
      isComplexConditional: false,
      isComplexConditionalSonar: false,
      isFeatureEnvy: false,
      isSmelly: false,
      smellCount: 0,
      smellTypes: [],
    };
    return classifyResult(unclassified, thresholds);
  });
}

export function analyzeSource(
  parser: { parse: (source: string, options: Record<string, unknown>) => AstNode },
  source: string,
  descriptor: SourceDescriptor,
  thresholds: Thresholds,
): MethodResult[] {
  const parsed = parseJavaScriptSource(parser, source, descriptor);
  const model = createProjectAnalysisModel();
  indexParsedSource(model, parsed);
  finalizeProjectAnalysisModel(model);
  return analyzeParsedSource(parsed, thresholds, model);
}

export function analyzeProjectSources(
  parser: { parse: (source: string, options: Record<string, unknown>) => AstNode },
  entries: Array<{ source: string; descriptor: SourceDescriptor }>,
  thresholds: Thresholds,
): MethodResult[] {
  const sortedEntries = [...entries].sort((a, b) => a.descriptor.relativePath.localeCompare(b.descriptor.relativePath));
  const parsedSources = sortedEntries.map((entry) => parseJavaScriptSource(parser, entry.source, entry.descriptor));
  const model = createProjectAnalysisModel("P-0001");
  for (const parsed of parsedSources) indexParsedSource(model, parsed);
  finalizeProjectAnalysisModel(model);
  return parsedSources.flatMap((parsed) => analyzeParsedSource(parsed, thresholds, model));
}

export function assignDeterministicIds(results: MethodResult[]): MethodResult[] {
  return [...results]
    .sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath) ||
      a.startOffset - b.startOffset ||
      a.endOffset - b.endOffset ||
      a.startLine - b.startLine ||
      a.endLine - b.endLine ||
      a.functionName.localeCompare(b.functionName),
    )
    .map((result, index) => ({ ...result, id: `M-${String(index + 1).padStart(6, "0")}` }));
}

export function deduplicateMethodResults(results: MethodResult[]): MethodResult[] {
  const unique = new Map<string, MethodResult>();
  for (const result of results) {
    const key = [
      result.relativePath,
      result.functionType,
      result.startOffset,
      result.endOffset,
      result.functionName,
    ].join("\u0000");
    if (!unique.has(key)) unique.set(key, result);
  }
  return [...unique.values()];
}
