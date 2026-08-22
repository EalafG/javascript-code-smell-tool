export type Thresholds = {
  longLoc: number;
  longCompound: boolean;
  longCyclo: number;
  longNesting: number;
  complexCyclo: number;
  conditionalOps: number;
  few: number;
};

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
  functionName: string;
  functionType: string;
  startLine: number;
  endLine: number;
  loc: number;
  spanLoc: number;
  commentLines: number;
  blankLines: number;
  cyclo: number;
  maxNesting: number;
  nop: number;
  nolv: number;
  condOpsMax: number;
  condNesting: number;
  numConditions: number;
  atfd: number;
  laa: number;
  fdp: number;
  foreignProviders: string[];
  isLongMethod: boolean;
  isComplexMethod: boolean;
  isComplexConditional: boolean;
  isFeatureEnvy: boolean;
  isSmelly: boolean;
  smellCount: number;
  smellTypes: string[];
  source: string;
};

type AstNode = {
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

type SourceLineKind = "code" | "comment" | "blank";

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

function conditionExpression(node: AstNode): AstNode | null {
  if (["IfStatement", "WhileStatement", "DoWhileStatement", "ConditionalExpression"].includes(node.type)) {
    return isNode(node.test) ? node.test : null;
  }
  if (node.type === "ForStatement") return isNode(node.test) ? node.test : null;
  if (node.type === "SwitchCase") return isNode(node.test) ? node.test : null;
  return null;
}

function unwrapChain(node: AstNode): AstNode {
  let current = node;
  while (current.type === "ChainExpression" && isNode(current.expression)) current = current.expression;
  return current;
}

function memberRoot(node: AstNode): { local: boolean; provider: string } {
  let current = unwrapChain(node);
  while (current.type === "MemberExpression" && isNode(current.object)) {
    current = unwrapChain(current.object);
  }
  if (current.type === "ThisExpression" || current.type === "Super") {
    return { local: true, provider: "this" };
  }
  if (current.type === "Identifier") {
    return { local: false, provider: String(current.name) };
  }
  if (current.type === "CallExpression" && isNode(current.callee)) {
    const callee = memberRoot({
      ...current.callee,
      type: current.callee.type === "MemberExpression" ? "MemberExpression" : current.callee.type,
    });
    if (callee.local) return callee;
    return { local: false, provider: callee.provider === "<expression>" ? "<call>" : callee.provider };
  }
  return { local: false, provider: "<expression>" };
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
    if (!(commentStrippedLines[index] ?? "").trim()) return "comment";
    return "code";
  });
}

function measureSegmentLines(segmentNode: AstNode, sourceLineKinds: SourceLineKind[]) {
  const startLine = segmentNode.loc?.start.line ?? 1;
  const endLine = segmentNode.loc?.end.line ?? startLine;
  let loc = 0;
  let commentLines = 0;
  let blankLines = 0;

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const kind = sourceLineKinds[lineNumber - 1] ?? "code";
    if (kind === "blank") blankLines += 1;
    else if (kind === "comment") commentLines += 1;
    else loc += 1;
  }

  return {
    startLine,
    endLine,
    loc: Math.max(1, loc),
    spanLoc: Math.max(1, endLine - startLine + 1),
    commentLines,
    blankLines,
  };
}

function calculateMetrics(
  functionNode: AstNode,
  segmentNode: AstNode,
  source: string,
  sourceLineKinds: SourceLineKind[],
) {
  let cyclo = 1;
  let maxNesting = 0;
  let nolv = 0;
  let condOpsMax = 0;
  let condNesting = 0;
  let numConditions = 0;
  let localAccesses = 0;
  let foreignAccesses = 0;
  const foreignProviders = new Set<string>();

  function visit(node: AstNode, nesting: number, conditionalDepth: number) {
    if (node !== functionNode && isFunctionNode(node)) return;

    if (CYCLO_TYPES.has(node.type)) cyclo += 1;
    if (node.type === "SwitchCase" && isNode(node.test)) cyclo += 1;
    if (node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||")) {
      cyclo += 1;
    }
    if (node.type === "VariableDeclarator") nolv += 1;

    if (node.type === "MemberExpression") {
      const root = memberRoot(node);
      if (root.local) localAccesses += 1;
      else {
        foreignAccesses += 1;
        foreignProviders.add(root.provider);
      }
    }

    const expression = conditionExpression(node);
    const hasCondition = Boolean(expression);
    const nextConditionalDepth = conditionalDepth + (hasCondition ? 1 : 0);
    if (expression) {
      numConditions += 1;
      condOpsMax = Math.max(condOpsMax, countConditionOperators(expression));
      condNesting = Math.max(condNesting, nextConditionalDepth);
    }

    const nextNesting = nesting + (STRUCTURAL_TYPES.has(node.type) ? 1 : 0);
    maxNesting = Math.max(maxNesting, nextNesting);
    for (const child of childNodes(node)) visit(child, nextNesting, nextConditionalDepth);
  }

  visit(functionNode, 0, 0);
  const params = Array.isArray(functionNode.params) ? functionNode.params.length : 0;
  const totalAccesses = localAccesses + foreignAccesses;
  return {
    ...measureSegmentLines(segmentNode, sourceLineKinds),
    cyclo,
    maxNesting,
    nop: params,
    nolv,
    condOpsMax,
    condNesting,
    numConditions,
    atfd: foreignAccesses,
    laa: totalAccesses === 0 ? 1 : localAccesses / totalAccesses,
    fdp: foreignProviders.size,
    foreignProviders: [...foreignProviders].sort((a, b) => a.localeCompare(b)),
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
  const isFeatureEnvy =
    result.atfd > thresholds.few && result.laa < 1 / 3 && result.fdp <= thresholds.few;

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
    isFeatureEnvy,
    isSmelly: smellTypes.length > 0,
    smellCount: smellTypes.length,
    smellTypes,
  };
}

export function analyzeSource(
  parser: { parse: (source: string, options: Record<string, unknown>) => AstNode },
  source: string,
  descriptor: SourceDescriptor,
  thresholds: Thresholds,
): MethodResult[] {
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

  const sourceLineKinds = classifySourceLines(source, comments);
  return collectFunctions(ast, source).map((candidate) => {
    const metrics = calculateMetrics(
      candidate.functionNode,
      candidate.segmentNode,
      source,
      sourceLineKinds,
    );
    const unclassified: MethodResult = {
      id: "",
      project: descriptor.project,
      fileName: descriptor.fileName,
      relativePath: descriptor.relativePath,
      functionName: candidate.functionName,
      functionType: candidate.functionType,
      ...metrics,
      isLongMethod: false,
      isComplexMethod: false,
      isComplexConditional: false,
      isFeatureEnvy: false,
      isSmelly: false,
      smellCount: 0,
      smellTypes: [],
    };
    return classifyResult(unclassified, thresholds);
  });
}

export function assignDeterministicIds(results: MethodResult[]): MethodResult[] {
  return [...results]
    .sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath) ||
      a.startLine - b.startLine ||
      a.endLine - b.endLine ||
      a.functionName.localeCompare(b.functionName),
    )
    .map((result, index) => ({ ...result, id: `M-${String(index + 1).padStart(6, "0")}` }));
}
