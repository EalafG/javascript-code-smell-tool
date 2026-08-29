export const FEATURE_ENVY_INFERENCE_MODE = "project-static-object-type-inference-v2";
export const FEATURE_ENVY_MAX_ITERATIONS = 12;
export const FEATURE_ENVY_TYPE_SET_LIMIT = 12;
// Retained in the export schema for backward compatibility. Zero means that
// inference is unbounded and uses every successfully parsed project file.
export const FEATURE_ENVY_BATCH_SIZE_LIMIT = 0;

export type InferenceAstNode = {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
};

type TypeTerm =
  | { kind: "direct"; types: string[] }
  | { kind: "variable"; key: string }
  | { kind: "this"; functionId: string }
  | { kind: "property"; object: TypeTerm; property: PropertyDescriptor }
  | { kind: "call"; callId: string }
  | { kind: "union"; terms: TypeTerm[] };

type PropertyDescriptor = {
  name: string;
  computed: boolean;
  indexLike: boolean;
};

type TypeTarget =
  | { kind: "variable"; key: string }
  | { kind: "return"; functionId: string }
  | { kind: "property"; object: TypeTerm; property: PropertyDescriptor; initial: boolean };

type TypeConstraint = {
  target: TypeTarget;
  value: TypeTerm;
};

type CallConstraint = {
  callId: string;
  callee: TypeTerm;
  receiver: TypeTerm | null;
  arguments: TypeTerm[];
  constructType: string | null;
};

type ThisConstraint = {
  functionId: string;
  owner: TypeTerm;
};

type FunctionInfo = {
  id: string;
  name: string;
  parameterKeys: string[][];
  isArrow: boolean;
  parentFunctionId: string | null;
};

type SourceScopeInfo = {
  rootScope: string;
  scopeParents: Map<string, string | null>;
  scopeBindings: Map<string, Set<string>>;
};

export type FeatureEnvyModel = {
  variableTypes: Map<string, Set<string>>;
  variableAliases: Map<string, string>;
  returnTypes: Map<string, Set<string>>;
  callReturnTypes: Map<string, Set<string>>;
  propertyTypes: Map<string, Set<string>>;
  knownProperties: Map<string, Set<string>>;
  initialProperties: Map<string, Set<string>>;
  thisTypes: Map<string, Set<string>>;
  parentTypes: Map<string, Set<string>>;
  functions: Map<string, FunctionInfo>;
  bindingLabels: Map<string, string>;
  sourceScopes: Map<string, SourceScopeInfo>;
  indexedSources: Set<string>;
  batchId: string;
  constraints: TypeConstraint[];
  calls: CallConstraint[];
  thisConstraints: ThisConstraint[];
  solved: boolean;
};

export type FeatureEnvyMetrics = {
  atd: number;
  atfd: number;
  localAccessCount: number;
  laa: number;
  fdp: number;
  foreignProviders: string[];
  couplingTuples: string[];
  typeInferenceCoverage: number;
  unknownAccessCount: number;
  foreignMemberCalls: number;
  foreignCallProviders: string[];
  feInferenceMode: string;
  feMaxIterations: number;
  feTypeSetLimit: number;
  feBatchId: string;
  feBatchFileCount: number;
  feBatchSizeLimit: number;
  feScope: string;
  feIndexedFileCount: number;
};

type WalkContext = {
  relativePath: string;
  source: string;
  scopeId: string;
  currentFunctionId: string | null;
  classOwnerType: string | null;
  objectOwnerType: string | null;
  ownerHint: TypeTerm | null;
};

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const MAX_INFERRED_TYPES_PER_SET = FEATURE_ENVY_TYPE_SET_LIMIT;

function isNode(value: unknown): value is InferenceAstNode {
  return Boolean(value && typeof value === "object" && typeof (value as InferenceAstNode).type === "string");
}

function isFunctionNode(node: InferenceAstNode): boolean {
  return FUNCTION_TYPES.has(node.type);
}

function childNodes(node: InferenceAstNode): InferenceAstNode[] {
  const children: InferenceAstNode[] = [];
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

function direct(...types: string[]): TypeTerm {
  return { kind: "direct", types };
}

function functionId(relativePath: string, node: InferenceAstNode): string {
  return `${relativePath}::function@${node.start}`;
}

function rootScopeId(relativePath: string): string {
  return `${relativePath}::root`;
}

function variableKey(scopeId: string, name: string): string {
  return `${scopeId}::binding:${name}`;
}

function objectType(relativePath: string, node: InferenceAstNode): string {
  return `object:${relativePath}@${node.start}`;
}

function arrayType(relativePath: string, node: InferenceAstNode): string {
  return `array:${relativePath}@${node.start}`;
}

function prototypeType(name: string): string {
  return `prototype:${name}`;
}

function constructorType(name: string): string {
  return `constructor:${name}`;
}

function propertyKey(type: string, property: string): string {
  return `${type}\u0000${property}`;
}

function setFor<K>(map: Map<K, Set<string>>, key: K): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  return set;
}

function addAll(target: Set<string>, values: Iterable<string>): boolean {
  let changed = false;
  for (const value of values) {
    if (!target.has(value)) {
      target.add(value);
      changed = true;
    }
  }
  return changed;
}

function addInferredTypes(target: Set<string>, values: Iterable<string>): boolean {
  let changed = false;
  for (const value of values) {
    if (target.has(value)) continue;
    const concreteSize = target.has("unknown:widened") ? target.size - 1 : target.size;
    if (concreteSize >= MAX_INFERRED_TYPES_PER_SET) {
      if (!target.has("unknown:widened")) {
        target.add("unknown:widened");
        changed = true;
      }
      break;
    }
    target.add(value);
    changed = true;
  }
  return changed;
}

function nameOf(node: unknown, source: string): string {
  if (!isNode(node)) return "anonymous";
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") return String(node.name ?? "anonymous");
  if (node.type === "Literal") return String(node.value ?? "unknown");
  return source.slice(node.start, node.end).replace(/\s+/g, " ").slice(0, 64) || "anonymous";
}

function functionName(node: InferenceAstNode, parent: InferenceAstNode | null, source: string): string {
  if (isNode(node.id) && node.id.type === "Identifier") return String(node.id.name);
  if (parent?.type === "VariableDeclarator") return nameOf(parent.id, source);
  if (parent?.type === "AssignmentExpression") return nameOf(parent.left, source);
  if (parent?.type === "Property" || parent?.type === "MethodDefinition") return nameOf(parent.key, source);
  const line = node.loc?.start.line ?? 1;
  return `anonymous@L${line}`;
}

function patternNames(node: unknown): string[] {
  if (!isNode(node)) return [];
  if (node.type === "Identifier") return [String(node.name)];
  if (node.type === "RestElement") return patternNames(node.argument);
  if (node.type === "AssignmentPattern") return patternNames(node.left);
  if (node.type === "ArrayPattern" && Array.isArray(node.elements)) {
    return node.elements.flatMap((element) => patternNames(element));
  }
  if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
    return node.properties.flatMap((property) => {
      if (!isNode(property)) return [];
      return property.type === "Property" ? patternNames(property.value) : patternNames(property.argument);
    });
  }
  return [];
}

function calleeName(node: unknown, source: string): string | null {
  if (!isNode(node)) return null;
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "MemberExpression") return nameOf(node.property, source);
  return null;
}

function propertyDescriptor(node: InferenceAstNode, source: string): PropertyDescriptor {
  const computed = Boolean(node.computed);
  const property = isNode(node.property) ? node.property : null;
  const rawName = nameOf(property, source);
  const literalValue = property?.type === "Literal" ? property.value : undefined;
  const indexLike = computed && (
    typeof literalValue === "number" ||
    (typeof literalValue === "string" && /^\d+$/.test(literalValue)) ||
    property?.type !== "Literal"
  );
  return {
    name: computed ? `[${rawName}]` : rawName,
    computed,
    indexLike,
  };
}

function normalizedProperty(type: string, property: PropertyDescriptor): string {
  return type.startsWith("array:") && property.computed && property.indexLike
    ? "IDX"
    : property.name;
}

function unwrapChain(node: InferenceAstNode): InferenceAstNode {
  let current = node;
  while (current.type === "ChainExpression" && isNode(current.expression)) current = current.expression;
  return current;
}

function resolveBinding(model: FeatureEnvyModel, relativePath: string, scopeId: string, name: string): string {
  const sourceInfo = model.sourceScopes.get(relativePath);
  let current: string | null = scopeId;
  while (current && sourceInfo) {
    if (sourceInfo.scopeBindings.get(current)?.has(name)) return variableKey(current, name);
    current = sourceInfo.scopeParents.get(current) ?? null;
  }
  const key = `global::binding:${name}`;
  model.bindingLabels.set(key, name);
  return key;
}

function literalType(value: unknown): string {
  if (value === null) return "builtin:Null";
  if (typeof value === "string") return "builtin:String";
  if (typeof value === "number") return "builtin:Number";
  if (typeof value === "boolean") return "builtin:Boolean";
  if (typeof value === "bigint") return "builtin:BigInt";
  if (value instanceof RegExp) return "builtin:RegExp";
  return "builtin:Primitive";
}

function expressionTerm(model: FeatureEnvyModel, nodeValue: unknown, context: WalkContext, depth = 0): TypeTerm {
  if (!isNode(nodeValue) || depth > 12) return direct();
  const node = unwrapChain(nodeValue);
  if (node.type === "Identifier") {
    return { kind: "variable", key: resolveBinding(model, context.relativePath, context.scopeId, String(node.name)) };
  }
  if (node.type === "ThisExpression" || node.type === "Super") {
    return context.currentFunctionId ? { kind: "this", functionId: context.currentFunctionId } : direct("unknown:this");
  }
  if (node.type === "Literal") return direct(literalType(node.value));
  if (node.type === "ObjectExpression") return direct(objectType(context.relativePath, node));
  if (node.type === "ArrayExpression") return direct(arrayType(context.relativePath, node));
  if (isFunctionNode(node)) return direct(`function:${functionId(context.relativePath, node)}`);
  if (node.type === "ClassExpression") return direct(constructorType(nameOf(node.id, context.source)));
  if (node.type === "NewExpression") {
    const name = calleeName(node.callee, context.source);
    return name ? direct(prototypeType(name)) : direct(`object:${context.relativePath}@${node.start}`);
  }
  if (node.type === "MemberExpression" && isNode(node.object)) {
    if (
      !node.computed &&
      isNode(node.property) &&
      node.property.type === "Identifier" &&
      node.property.name === "prototype" &&
      isNode(node.object) &&
      node.object.type === "Identifier"
    ) {
      return direct(prototypeType(String(node.object.name)));
    }
    return {
      kind: "property",
      object: expressionTerm(model, node.object, context, depth + 1),
      property: propertyDescriptor(node, context.source),
    };
  }
  if (node.type === "CallExpression") {
    if (
      isNode(node.callee) && node.callee.type === "Identifier" && node.callee.name === "require" &&
      Array.isArray(node.arguments) && isNode(node.arguments[0]) && node.arguments[0].type === "Literal"
    ) {
      return direct(`module:${String(node.arguments[0].value)}`);
    }
    if (
      isNode(node.callee) && node.callee.type === "MemberExpression" &&
      isNode(node.callee.object) && node.callee.object.type === "Identifier" && node.callee.object.name === "Object" &&
      nameOf(node.callee.property, context.source) === "create" && Array.isArray(node.arguments) && node.arguments[0]
    ) {
      return expressionTerm(model, node.arguments[0], context, depth + 1);
    }
    return { kind: "call", callId: `${context.relativePath}::call@${node.start}` };
  }
  if (node.type === "AwaitExpression" || node.type === "YieldExpression" || node.type === "SpreadElement") {
    return expressionTerm(model, node.argument, context, depth + 1);
  }
  if (node.type === "AssignmentExpression") return expressionTerm(model, node.right, context, depth + 1);
  if (node.type === "SequenceExpression" && Array.isArray(node.expressions)) {
    return expressionTerm(model, node.expressions.at(-1), context, depth + 1);
  }
  if (node.type === "ConditionalExpression") {
    return {
      kind: "union",
      terms: [
        expressionTerm(model, node.consequent, context, depth + 1),
        expressionTerm(model, node.alternate, context, depth + 1),
      ],
    };
  }
  if (node.type === "LogicalExpression") {
    return {
      kind: "union",
      terms: [
        expressionTerm(model, node.left, context, depth + 1),
        expressionTerm(model, node.right, context, depth + 1),
      ],
    };
  }
  if (node.type === "TemplateLiteral" || node.type === "TaggedTemplateExpression") return direct("builtin:String");
  if (node.type === "BinaryExpression" || node.type === "UnaryExpression" || node.type === "UpdateExpression") {
    return direct("builtin:Primitive");
  }
  return direct();
}

function evaluateTerm(model: FeatureEnvyModel, term: TypeTerm, includeUnknown: boolean): Set<string> {
  if (term.kind === "direct") return new Set(term.types);
  if (term.kind === "variable") {
    let key = term.key;
    const seen = new Set<string>();
    while (!seen.has(key)) {
      seen.add(key);
      const values = model.variableTypes.get(key);
      if (values?.size) return new Set(values);
      const alias = model.variableAliases.get(key);
      if (!alias || alias === key) break;
      key = alias;
    }
    if (!includeUnknown) return new Set();
    return new Set([`unknown:${model.bindingLabels.get(key) ?? model.bindingLabels.get(term.key) ?? "binding"}`]);
  }
  if (term.kind === "this") {
    const values = model.thisTypes.get(term.functionId);
    if (values?.size) return new Set(values);
    return includeUnknown ? new Set(["unknown:this"]) : new Set();
  }
  if (term.kind === "call") {
    const values = model.callReturnTypes.get(term.callId);
    if (values?.size) return new Set(values);
    return includeUnknown ? new Set([`unknown:call@${term.callId.split("@").at(-1) ?? "result"}`]) : new Set();
  }
  if (term.kind === "union") {
    const values = new Set<string>();
    for (const child of term.terms) addInferredTypes(values, evaluateTerm(model, child, includeUnknown));
    return values;
  }

  const objectTypes = evaluateTerm(model, term.object, includeUnknown);
  const values = new Set<string>();
  for (const type of objectTypes) {
    const property = normalizedProperty(type, term.property);
    const known = model.propertyTypes.get(propertyKey(type, property));
    if (known?.size) addInferredTypes(values, known);
    else if (includeUnknown || !type.startsWith("unknown:")) addInferredTypes(values, [`property:${type}.${property}`]);
  }
  return values;
}

function addPropertyPresence(map: Map<string, Set<string>>, type: string, property: string): boolean {
  const properties = map.get(type) ?? new Set<string>();
  if (!map.has(type)) map.set(type, properties);
  if (properties.has(property)) return false;
  properties.add(property);
  return true;
}

function applyTarget(model: FeatureEnvyModel, target: TypeTarget, values: Set<string>): boolean {
  if (target.kind === "variable") return addInferredTypes(setFor(model.variableTypes, target.key), values);
  if (target.kind === "return") return addInferredTypes(setFor(model.returnTypes, target.functionId), values);

  let changed = false;
  const objectTypes = evaluateTerm(model, target.object, false);
  for (const type of objectTypes) {
    const property = normalizedProperty(type, target.property);
    changed = addPropertyPresence(model.knownProperties, type, property) || changed;
    if (target.initial) changed = addPropertyPresence(model.initialProperties, type, property) || changed;
    changed = addInferredTypes(setFor(model.propertyTypes, propertyKey(type, property)), values) || changed;
  }
  return changed;
}

function addConstraint(model: FeatureEnvyModel, target: TypeTarget, value: TypeTerm) {
  model.constraints.push({ target, value });
}

function registerPatternAssignments(
  model: FeatureEnvyModel,
  pattern: unknown,
  value: TypeTerm,
  context: WalkContext,
) {
  if (!isNode(pattern)) return;
  if (pattern.type === "Identifier") {
    const key = resolveBinding(model, context.relativePath, context.scopeId, String(pattern.name));
    if (value.kind === "variable" && value.key !== key) model.variableAliases.set(key, value.key);
    addConstraint(model, {
      kind: "variable",
      key,
    }, value);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    registerPatternAssignments(model, pattern.left, value, context);
    return;
  }
  if (pattern.type === "RestElement") {
    registerPatternAssignments(model, pattern.argument, value, context);
    return;
  }
  if (pattern.type === "ObjectPattern" && Array.isArray(pattern.properties)) {
    for (const property of pattern.properties) {
      if (!isNode(property)) continue;
      if (property.type === "RestElement") registerPatternAssignments(model, property.argument, value, context);
      else if (property.type === "Property") {
        registerPatternAssignments(model, property.value, {
          kind: "property",
          object: value,
          property: {
            name: property.computed ? `[${nameOf(property.key, context.source)}]` : nameOf(property.key, context.source),
            computed: Boolean(property.computed),
            indexLike: Boolean(property.computed),
          },
        }, context);
      }
    }
    return;
  }
  if (pattern.type === "ArrayPattern" && Array.isArray(pattern.elements)) {
    pattern.elements.forEach((element, index) => registerPatternAssignments(model, element, {
      kind: "property",
      object: value,
      property: { name: `[${index}]`, computed: true, indexLike: true },
    }, context));
  }
}

function propertyTarget(model: FeatureEnvyModel, node: InferenceAstNode, context: WalkContext, initial: boolean): TypeTarget | null {
  if (node.type !== "MemberExpression" || !isNode(node.object)) return null;
  return {
    kind: "property",
    object: expressionTerm(model, node.object, context),
    property: propertyDescriptor(node, context.source),
    initial,
  };
}

function isPrototypeReference(node: unknown): node is InferenceAstNode {
  return Boolean(
    isNode(node) && node.type === "MemberExpression" && !node.computed &&
    isNode(node.object) && node.object.type === "Identifier" &&
    isNode(node.property) && node.property.type === "Identifier" && node.property.name === "prototype",
  );
}

function objectCreatePrototype(node: unknown, source: string): string | null {
  if (!isNode(node) || node.type !== "CallExpression" || !isNode(node.callee) || node.callee.type !== "MemberExpression") return null;
  if (!isNode(node.callee.object) || node.callee.object.type !== "Identifier" || node.callee.object.name !== "Object") return null;
  if (nameOf(node.callee.property, source) !== "create" || !Array.isArray(node.arguments) || !isPrototypeReference(node.arguments[0])) return null;
  return prototypeType(String((node.arguments[0].object as InferenceAstNode).name));
}

function collectSourceScopes(
  model: FeatureEnvyModel,
  ast: InferenceAstNode,
  source: string,
  relativePath: string,
): SourceScopeInfo {
  const rootScope = rootScopeId(relativePath);
  const info: SourceScopeInfo = {
    rootScope,
    scopeParents: new Map([[rootScope, null]]),
    scopeBindings: new Map([[rootScope, new Set<string>()]]),
  };

  function declare(scopeId: string, name: string) {
    const bindings = info.scopeBindings.get(scopeId) ?? new Set<string>();
    info.scopeBindings.set(scopeId, bindings);
    bindings.add(name);
    model.bindingLabels.set(variableKey(scopeId, name), name);
  }

  function visit(node: InferenceAstNode, scopeId: string, parentFunctionId: string | null, parent: InferenceAstNode | null) {
    if (node.type === "FunctionDeclaration" && isNode(node.id) && node.id.type === "Identifier") {
      declare(scopeId, String(node.id.name));
    }
    if (node.type === "ClassDeclaration" && isNode(node.id) && node.id.type === "Identifier") {
      declare(scopeId, String(node.id.name));
    }
    if (node.type === "ImportDeclaration" && Array.isArray(node.specifiers)) {
      for (const specifier of node.specifiers) {
        if (isNode(specifier) && isNode(specifier.local) && specifier.local.type === "Identifier") declare(scopeId, String(specifier.local.name));
      }
    }
    if (node.type === "VariableDeclarator") {
      for (const name of patternNames(node.id)) declare(scopeId, name);
    }
    if (node.type === "CatchClause") {
      for (const name of patternNames(node.param)) declare(scopeId, name);
    }

    if (isFunctionNode(node)) {
      const id = functionId(relativePath, node);
      info.scopeParents.set(id, scopeId);
      info.scopeBindings.set(id, new Set<string>());
      for (const param of Array.isArray(node.params) ? node.params : []) {
        for (const name of patternNames(param)) declare(id, name);
      }
      if (isNode(node.id) && node.id.type === "Identifier") declare(id, String(node.id.name));
      const parameterKeys = (Array.isArray(node.params) ? node.params : []).map((param) =>
        patternNames(param).map((name) => variableKey(id, name))
      );
      model.functions.set(id, {
        id,
        name: functionName(node, parent, source),
        parameterKeys,
        isArrow: node.type === "ArrowFunctionExpression",
        parentFunctionId,
      });
      for (const child of childNodes(node)) visit(child, id, id, node);
      return;
    }
    for (const child of childNodes(node)) visit(child, scopeId, parentFunctionId, node);
  }

  visit(ast, rootScope, null, null);
  model.sourceScopes.set(relativePath, info);
  return info;
}

function bindFunctionDeclaration(model: FeatureEnvyModel, node: InferenceAstNode, context: WalkContext) {
  if (node.type !== "FunctionDeclaration" || !isNode(node.id) || node.id.type !== "Identifier") return;
  const key = resolveBinding(model, context.relativePath, context.scopeId, String(node.id.name));
  addConstraint(model, { kind: "variable", key }, direct(`function:${functionId(context.relativePath, node)}`));
}

function indexCall(model: FeatureEnvyModel, node: InferenceAstNode, context: WalkContext) {
  if ((node.type !== "CallExpression" && node.type !== "NewExpression") || !isNode(node.callee)) return;
  let calleeNode = unwrapChain(node.callee);
  let receiver: TypeTerm | null = null;
  let args = Array.isArray(node.arguments)
    ? node.arguments.filter(isNode).map((argument) => expressionTerm(model, argument, context))
    : [];

  if (node.type === "CallExpression" && calleeNode.type === "MemberExpression" && isNode(calleeNode.object)) {
    const method = nameOf(calleeNode.property, context.source);
    if ((method === "call" || method === "apply") && isNode(calleeNode.object)) {
      calleeNode = unwrapChain(calleeNode.object);
      receiver = args[0] ?? null;
      args = method === "call" ? args.slice(1) : [];
    } else {
      receiver = expressionTerm(model, calleeNode.object, context);
    }
  }

  const constructorName = node.type === "NewExpression" ? calleeName(calleeNode, context.source) : null;
  model.calls.push({
    callId: `${context.relativePath}::call@${node.start}`,
    callee: expressionTerm(model, calleeNode, context),
    receiver,
    arguments: args,
    constructType: constructorName ? prototypeType(constructorName) : null,
  });
}

function indexRelations(model: FeatureEnvyModel, ast: InferenceAstNode, source: string, relativePath: string) {
  const sourceInfo = model.sourceScopes.get(relativePath);
  if (!sourceInfo) return;

  function walk(node: InferenceAstNode, context: WalkContext, parent: InferenceAstNode | null) {
    void parent;
    bindFunctionDeclaration(model, node, context);

    if (isFunctionNode(node)) {
      const id = functionId(relativePath, node);
      if (context.ownerHint) model.thisConstraints.push({ functionId: id, owner: context.ownerHint });
      if (node.type === "ArrowFunctionExpression" && context.currentFunctionId) {
        model.thisConstraints.push({ functionId: id, owner: { kind: "this", functionId: context.currentFunctionId } });
      }
      const functionContext: WalkContext = {
        ...context,
        scopeId: id,
        currentFunctionId: id,
        ownerHint: null,
      };
      for (const param of Array.isArray(node.params) ? node.params : []) {
        if (isNode(param) && param.type === "AssignmentPattern") walk(param.right as InferenceAstNode, functionContext, param);
      }
      if (isNode(node.body)) walk(node.body, functionContext, node);
      return;
    }

    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      const className = nameOf(node.id, source);
      const classType = prototypeType(className);
      if (node.type === "ClassDeclaration" && isNode(node.id) && node.id.type === "Identifier") {
        const key = resolveBinding(model, relativePath, context.scopeId, String(node.id.name));
        const constructorMethod = isNode(node.body) && Array.isArray(node.body.body)
          ? node.body.body.find((item) => isNode(item) && item.type === "MethodDefinition" && item.kind === "constructor")
          : null;
        const constructorFunction = isNode(constructorMethod) && isNode(constructorMethod.value)
          ? `function:${functionId(relativePath, constructorMethod.value)}`
          : null;
        addConstraint(model, { kind: "variable", key }, direct(
          constructorType(className),
          ...(constructorFunction ? [constructorFunction] : []),
        ));
      }
      if (isNode(node.superClass)) {
        const superName = calleeName(node.superClass, source);
        if (superName) setFor(model.parentTypes, classType).add(prototypeType(superName));
      }
      if (isNode(node.body)) walk(node.body, { ...context, classOwnerType: classType }, node);
      return;
    }

    if (node.type === "ClassBody") {
      for (const child of childNodes(node)) walk(child, context, node);
      return;
    }

    if (node.type === "MethodDefinition" && isNode(node.value)) {
      const ownerType = node.static
        ? constructorType(context.classOwnerType?.replace(/^prototype:/, "") ?? "anonymous")
        : context.classOwnerType;
      if (ownerType) {
        const property: PropertyDescriptor = { name: nameOf(node.key, source), computed: Boolean(node.computed), indexLike: false };
        addPropertyPresence(model.initialProperties, ownerType, property.name);
        addPropertyPresence(model.knownProperties, ownerType, property.name);
        addAll(setFor(model.propertyTypes, propertyKey(ownerType, property.name)), [`function:${functionId(relativePath, node.value)}`]);
        walk(node.value, { ...context, ownerHint: direct(ownerType) }, node);
      } else walk(node.value, context, node);
      return;
    }

    if (node.type === "PropertyDefinition" && context.classOwnerType) {
      const ownerType = node.static
        ? constructorType(context.classOwnerType.replace(/^prototype:/, ""))
        : context.classOwnerType;
      const property: PropertyDescriptor = { name: nameOf(node.key, source), computed: Boolean(node.computed), indexLike: false };
      addConstraint(model, { kind: "property", object: direct(ownerType), property, initial: true }, expressionTerm(model, node.value, context));
      if (isNode(node.value)) walk(node.value, context, node);
      return;
    }

    if (node.type === "ObjectExpression") {
      const ownerType = objectType(relativePath, node);
      if (Array.isArray(node.properties)) {
        for (const propertyNode of node.properties) {
          if (!isNode(propertyNode)) continue;
          if (propertyNode.type === "SpreadElement") {
            if (isNode(propertyNode.argument)) walk(propertyNode.argument, context, propertyNode);
            continue;
          }
          if (propertyNode.type !== "Property") continue;
          const property: PropertyDescriptor = {
            name: propertyNode.computed ? `[${nameOf(propertyNode.key, source)}]` : nameOf(propertyNode.key, source),
            computed: Boolean(propertyNode.computed),
            indexLike: Boolean(propertyNode.computed),
          };
          addConstraint(model, { kind: "property", object: direct(ownerType), property, initial: true }, expressionTerm(model, propertyNode.value, context));
          if (isNode(propertyNode.value)) {
            walk(propertyNode.value, {
              ...context,
              objectOwnerType: ownerType,
              ownerHint: isFunctionNode(propertyNode.value) ? direct(ownerType) : null,
            }, propertyNode);
          }
        }
      }
      return;
    }

    if (node.type === "ArrayExpression") {
      const ownerType = arrayType(relativePath, node);
      addPropertyPresence(model.initialProperties, ownerType, "length");
      addPropertyPresence(model.knownProperties, ownerType, "length");
      if (Array.isArray(node.elements) && node.elements.some(isNode)) {
        addPropertyPresence(model.initialProperties, ownerType, "IDX");
        addPropertyPresence(model.knownProperties, ownerType, "IDX");
        for (const element of node.elements) {
          if (!isNode(element)) continue;
          addConstraint(model, {
            kind: "property",
            object: direct(ownerType),
            property: { name: "IDX", computed: true, indexLike: true },
            initial: true,
          }, expressionTerm(model, element, context));
          walk(element, context, node);
        }
      }
      return;
    }

    if (node.type === "VariableDeclarator") {
      const value = expressionTerm(model, node.init, context);
      registerPatternAssignments(model, node.id, value, context);
      if (isNode(node.init)) walk(node.init, context, node);
      return;
    }

    if (node.type === "AssignmentExpression" && isNode(node.left)) {
      const value = expressionTerm(model, node.right, context);
      if (node.left.type === "Identifier") registerPatternAssignments(model, node.left, value, context);
      else if (isPrototypeReference(node.left)) {
        const parent = objectCreatePrototype(node.right, source);
        const constructor = node.left.object as InferenceAstNode;
        if (parent) setFor(model.parentTypes, prototypeType(String(constructor.name))).add(parent);
      } else {
        const target = propertyTarget(model, node.left, context, false);
        if (target) addConstraint(model, target, value);
      }
      walk(node.left, context, node);
      if (isNode(node.right)) {
        const owner = node.left.type === "MemberExpression" && isNode(node.left.object)
          ? expressionTerm(model, node.left.object, context)
          : null;
        walk(node.right, { ...context, ownerHint: isFunctionNode(node.right) ? owner : null }, node);
      }
      return;
    }

    if (node.type === "ReturnStatement" && context.currentFunctionId && isNode(node.argument)) {
      addConstraint(model, { kind: "return", functionId: context.currentFunctionId }, expressionTerm(model, node.argument, context));
    }

    if (node.type === "ImportDeclaration" && Array.isArray(node.specifiers)) {
      const moduleName = isNode(node.source) && node.source.type === "Literal" ? String(node.source.value) : "external";
      for (const specifier of node.specifiers) {
        if (!isNode(specifier) || !isNode(specifier.local) || specifier.local.type !== "Identifier") continue;
        const localName = String(specifier.local.name);
        const importedName = specifier.type === "ImportDefaultSpecifier"
          ? "default"
          : specifier.type === "ImportNamespaceSpecifier"
            ? "namespace"
            : nameOf(specifier.imported, source);
        const key = resolveBinding(model, relativePath, context.scopeId, localName);
        addConstraint(model, { kind: "variable", key }, direct(`module:${moduleName}#${importedName}`));
      }
    }

    indexCall(model, node, context);
    for (const child of childNodes(node)) walk(child, context, node);
  }

  walk(ast, {
    relativePath,
    source,
    scopeId: sourceInfo.rootScope,
    currentFunctionId: null,
    classOwnerType: null,
    objectOwnerType: null,
    ownerHint: null,
  }, null);
}

export function createFeatureEnvyModel(batchId = "P-0001"): FeatureEnvyModel {
  return {
    variableTypes: new Map(),
    variableAliases: new Map(),
    returnTypes: new Map(),
    callReturnTypes: new Map(),
    propertyTypes: new Map(),
    knownProperties: new Map(),
    initialProperties: new Map(),
    thisTypes: new Map(),
    parentTypes: new Map(),
    functions: new Map(),
    bindingLabels: new Map(),
    sourceScopes: new Map(),
    indexedSources: new Set(),
    batchId,
    constraints: [],
    calls: [],
    thisConstraints: [],
    solved: false,
  };
}

export function indexFeatureEnvySource(
  model: FeatureEnvyModel,
  ast: InferenceAstNode,
  source: string,
  relativePath: string,
) {
  collectSourceScopes(model, ast, source, relativePath);
  indexRelations(model, ast, source, relativePath);
  model.indexedSources.add(relativePath);
  model.solved = false;
}

function functionIds(types: Iterable<string>): string[] {
  return [...types].filter((type) => type.startsWith("function:")).map((type) => type.slice("function:".length));
}

export function finalizeFeatureEnvyModel(model: FeatureEnvyModel) {
  if (model.solved) return;
  const maxIterations = FEATURE_ENVY_MAX_ITERATIONS;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let changed = false;

    for (const constraint of model.constraints) {
      const values = evaluateTerm(model, constraint.value, false);
      changed = applyTarget(model, constraint.target, values) || changed;
    }

    for (const constraint of model.thisConstraints) {
      const ownerTypes = evaluateTerm(model, constraint.owner, false);
      changed = addInferredTypes(setFor(model.thisTypes, constraint.functionId), ownerTypes) || changed;
    }

    for (const call of model.calls) {
      const callees = functionIds(evaluateTerm(model, call.callee, false));
      const callReturns = setFor(model.callReturnTypes, call.callId);
      for (const id of callees) {
        const info = model.functions.get(id);
        if (!info) continue;
        info.parameterKeys.forEach((keys, index) => {
          const argumentTypes = call.arguments[index] ? evaluateTerm(model, call.arguments[index], false) : new Set<string>();
          for (const key of keys) changed = addInferredTypes(setFor(model.variableTypes, key), argumentTypes) || changed;
        });
        if (!info.isArrow && call.receiver) {
          changed = addInferredTypes(setFor(model.thisTypes, id), evaluateTerm(model, call.receiver, false)) || changed;
        }
        if (!info.isArrow && call.constructType) {
          changed = addInferredTypes(setFor(model.thisTypes, id), [call.constructType]) || changed;
        }
        changed = addInferredTypes(callReturns, model.returnTypes.get(id) ?? []) || changed;
      }
    }

    if (!changed) break;
  }
  model.solved = true;
}

function ancestorTypes(model: FeatureEnvyModel, type: string): Set<string> {
  const ancestors = new Set<string>([type]);
  const queue = [type];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const parent of model.parentTypes.get(current) ?? []) {
      if (!ancestors.has(parent)) {
        ancestors.add(parent);
        queue.push(parent);
      }
    }
  }
  return ancestors;
}

function isResolvedType(type: string): boolean {
  return !type.startsWith("unknown:") && !type.startsWith("property:");
}

function isDirectMemberInvocation(node: InferenceAstNode, parent: InferenceAstNode | null): boolean {
  if (!parent) return false;
  if ((parent.type === "CallExpression" || parent.type === "NewExpression") && parent.callee === node) return true;
  return parent.type === "TaggedTemplateExpression" && parent.tag === node;
}

function simpleAssignmentRole(node: InferenceAstNode, parent: InferenceAstNode | null): "none" | "simple-write" | "read-write" {
  if (!parent) return "none";
  if (parent.type === "AssignmentExpression" && parent.left === node) {
    return parent.operator === "=" ? "simple-write" : "read-write";
  }
  if (parent.type === "UpdateExpression" && parent.argument === node) return "read-write";
  return "none";
}

function displayType(type: string): string {
  if (type.startsWith("unknown:")) return type;
  if (type.startsWith("property:")) return `unresolved:${type.slice("property:".length)}`;
  return type;
}

export function calculateFeatureEnvyMetrics(
  model: FeatureEnvyModel,
  functionNode: InferenceAstNode,
  source: string,
  relativePath: string,
): FeatureEnvyMetrics {
  finalizeFeatureEnvyModel(model);
  const id = functionId(relativePath, functionNode);
  const context: WalkContext = {
    relativePath,
    source,
    scopeId: id,
    currentFunctionId: id,
    classOwnerType: null,
    objectOwnerType: null,
    ownerHint: null,
  };
  const thisHierarchy = new Set<string>();
  for (const type of model.thisTypes.get(id) ?? []) addAll(thisHierarchy, ancestorTypes(model, type));

  const localTuples = new Set<string>();
  const foreignTuples = new Set<string>();
  const foreignProviders = new Set<string>();
  const unknownTuples = new Set<string>();
  const couplingTuples = new Set<string>();
  const seenProperties = new Map<string, Set<string>>();
  let foreignMemberCalls = 0;
  const foreignCallProviders = new Set<string>();

  function recordMember(node: InferenceAstNode, parent: InferenceAstNode | null) {
    if (!isNode(node.object)) return;
    const objectNode = unwrapChain(node.object);
    const syntacticThis = objectNode.type === "ThisExpression" || objectNode.type === "Super";
    const types = evaluateTerm(model, expressionTerm(model, objectNode, context), true);
    const role = simpleAssignmentRole(node, parent);

    for (const type of types) {
      const property = normalizedProperty(type, propertyDescriptor(node, source));
      const knownBefore = Boolean(
        model.initialProperties.get(type)?.has(property) || seenProperties.get(type)?.has(property),
      );
      if (role === "simple-write") {
        setFor(seenProperties, type).add(property);
        if (isResolvedType(type) && !knownBefore) continue;
      }
      if (
        role === "none" && !syntacticThis && isResolvedType(type) &&
        !model.knownProperties.get(type)?.has(property) &&
        !type.startsWith("module:") && !type.startsWith("builtin:") && !type.startsWith("array:")
      ) {
        continue;
      }

      const local = syntacticThis || thisHierarchy.has(type);
      const display = displayType(type);
      const tuple = `${local ? "L" : "F"}:${display}#${property}`;
      couplingTuples.add(tuple);
      if (local) localTuples.add(tuple);
      else {
        foreignTuples.add(tuple);
        foreignProviders.add(display);
        if (!isResolvedType(type)) unknownTuples.add(tuple);
      }

      if (isDirectMemberInvocation(node, parent) && !local) {
        foreignMemberCalls += 1;
        foreignCallProviders.add(display);
      }
    }
  }

  function visit(node: InferenceAstNode, parent: InferenceAstNode | null) {
    if (node !== functionNode && isFunctionNode(node)) return;
    if (node.type === "MemberExpression") recordMember(node, parent);
    for (const child of childNodes(node)) visit(child, node);
  }

  visit(functionNode, null);
  const localAccessCount = localTuples.size;
  const atd = localAccessCount + foreignTuples.size;
  const resolvedCount = [...couplingTuples].filter((tuple) => !tuple.includes("unknown:") && !tuple.includes("unresolved:")).length;
  return {
    atd,
    atfd: foreignTuples.size,
    localAccessCount,
    laa: atd === 0 ? 1 : localAccessCount / atd,
    fdp: foreignProviders.size,
    foreignProviders: [...foreignProviders].sort((a, b) => a.localeCompare(b)),
    couplingTuples: [...couplingTuples].sort((a, b) => a.localeCompare(b)),
    typeInferenceCoverage: atd === 0 ? 1 : resolvedCount / atd,
    unknownAccessCount: unknownTuples.size,
    foreignMemberCalls,
    foreignCallProviders: [...foreignCallProviders].sort((a, b) => a.localeCompare(b)),
    feInferenceMode: FEATURE_ENVY_INFERENCE_MODE,
    feMaxIterations: FEATURE_ENVY_MAX_ITERATIONS,
    feTypeSetLimit: FEATURE_ENVY_TYPE_SET_LIMIT,
    feBatchId: model.batchId,
    feBatchFileCount: model.indexedSources.size,
    feBatchSizeLimit: FEATURE_ENVY_BATCH_SIZE_LIMIT,
    feScope: "project",
    feIndexedFileCount: model.indexedSources.size,
  };
}
