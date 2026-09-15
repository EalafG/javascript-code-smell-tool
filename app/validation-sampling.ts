import type { MethodResult, SourceCategory, Thresholds } from "./analyzer.ts";
import { CSV_SCHEMA_VERSION, DETECTOR_VERSION } from "./csv.ts";

export type SamplingPreset = "pilot" | "representative" | "audit";
export type SamplingPhase = "pilot" | "main" | "audit";
export type ClassDistribution = "natural" | "custom";
export type ProjectAllocation = "proportional" | "equal";
export type ProjectGrouping = "auto" | "dataset" | "first-folder" | "second-folder";
export type SamplingSmellKey = "longMethod" | "complexMethod" | "complexConditional" | "featureEnvy";

export const SAMPLING_SMELLS: Array<{ key: SamplingSmellKey; label: string }> = [
  { key: "longMethod", label: "Long Method" },
  { key: "complexMethod", label: "Complex Method" },
  { key: "complexConditional", label: "Complex Conditional" },
  { key: "featureEnvy", label: "Feature Envy" },
];

export type ValidationSamplingConfig = {
  preset: SamplingPreset;
  phase: SamplingPhase;
  title: string;
  sampleSize: number;
  seed: string;
  classDistribution: ClassDistribution;
  smellyPercent: number;
  projectGrouping: ProjectGrouping;
  projectAllocation: ProjectAllocation;
  includedProjects: string[];
  minimumPerProject: number;
  maximumPerProject: number;
  smellMinimums: Record<SamplingSmellKey, number>;
  multiSmellMinimum: number;
  boundaryPercent: number;
  includedCategories: SourceCategory[];
  excludeGenerated: boolean;
  excludeExamples: boolean;
  excludeEmpty: boolean;
  minimumLoc: number;
  deduplicateSource: boolean;
  includeNearbyContext: boolean;
  validatorCount: number;
  annotationsPerMethod: number;
};

export type SamplingBuildContext = {
  thresholds: Thresholds;
  parserVersion: string;
  selectedFileCount: number;
  successfulFileCount: number;
  parseFailureCount: number;
  resourceExclusionCount: number;
  projectGrouping: "single-project" | "direct-subfolders";
};

export type SamplingArtifact = {
  name: string;
  contents: string;
};

export type SamplingPackage = {
  artifacts: SamplingArtifact[];
  zipFileName: string;
  selectedCount: number;
  eligibleCount: number;
  warnings: string[];
  datasetSha256: string;
};

export type PopulationPreview = {
  eligibleCount: number;
  excludedCount: number;
  predictedSmellyCount: number;
  predictedCleanCount: number;
  projectCounts: Record<string, number>;
  exclusionCounts: Record<string, number>;
  resolvedProjectGrouping: Exclude<ProjectGrouping, "auto">;
};

type PreparedMethod = {
  result: MethodResult;
  samplingProject: string;
};

type ExcludedMethod = PreparedMethod & {
  ruleId: string;
  reason: string;
};

type Selection = PreparedMethod & {
  role: string;
  poolProjectN: number;
};

type SamplingPlan = {
  selected: Selection[];
  warnings: string[];
  projectTargets: Record<string, number>;
};

const GENERATED_PATH_PARTS = new Set(["generated", "compiled", "third-party", "third_party", "externals"]);
const EXAMPLE_PATH_PARTS = new Set(["demo", "demos", "example", "examples", "playground", "sample", "samples", "debug"]);
const UMBRELLA_FOLDER_NAMES = new Set(["dataset", "datasets", "project", "projects", "repo", "repos", "repositories", "sample", "samples", "source", "sources"]);

function clampInteger(value: number, minimum: number, maximum: number): number {
  const safe = Number.isFinite(value) ? Math.round(value) : minimum;
  return Math.min(maximum, Math.max(minimum, safe));
}

function pathParts(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

export function resolveProjectGrouping(
  results: MethodResult[],
  requested: ProjectGrouping,
): Exclude<ProjectGrouping, "auto"> {
  if (requested !== "auto") return requested;
  const datasetProjects = new Set(results.map((result) => result.project).filter(Boolean));
  const firstFolders = new Set(results.map((result) => pathParts(result.relativePath)[0]).filter(Boolean));
  const secondFolders = new Set(results.map((result) => pathParts(result.relativePath)[1]).filter(Boolean));
  if (datasetProjects.size > 1) return "dataset";
  if (firstFolders.size > 1) return "first-folder";
  const onlyFirstFolder = [...firstFolders][0]?.toLowerCase();
  if (onlyFirstFolder && UMBRELLA_FOLDER_NAMES.has(onlyFirstFolder) && secondFolders.size > 1) return "second-folder";
  return "dataset";
}

export function samplingProjectFor(
  result: MethodResult,
  grouping: Exclude<ProjectGrouping, "auto">,
): string {
  const parts = pathParts(result.relativePath);
  if (grouping === "first-folder") return parts[0] ?? result.project ?? "unknown-project";
  if (grouping === "second-folder") return parts[1] ?? parts[0] ?? result.project ?? "unknown-project";
  return result.project || parts[0] || "unknown-project";
}

function isGenerated(result: MethodResult): boolean {
  const parts = pathParts(result.relativePath).map((part) => part.toLowerCase());
  const fileName = parts.at(-1) ?? "";
  return parts.some((part) => GENERATED_PATH_PARTS.has(part)) ||
    fileName.includes(".min.") || fileName.includes(".bundle.") ||
    fileName.endsWith("-bundle.js") || fileName.endsWith(".bundled.js") ||
    fileName.includes("generated") || result.source.split(/\r\n|\n|\r/).some((line) => line.length > 5000);
}

function isExample(result: MethodResult): boolean {
  return pathParts(result.relativePath).some((part) => EXAMPLE_PATH_PARTS.has(part.toLowerCase()));
}

function isEmptyFunction(result: MethodResult): boolean {
  const withoutComments = result.source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .trim();
  return /\{\s*\}[,;]?$/.test(withoutComments);
}

function normalizedSource(result: MethodResult): string {
  return result.source.replace(/\r\n|\r/g, "\n").trim();
}

function sourceWithNearbyContext(result: MethodResult): string {
  return [result.contextBefore, result.source, result.contextAfter].filter(Boolean).join("\n");
}

function preparePopulation(
  results: MethodResult[],
  config: ValidationSamplingConfig,
): {
  eligible: PreparedMethod[];
  excluded: ExcludedMethod[];
  resolvedGrouping: Exclude<ProjectGrouping, "auto">;
} {
  const resolvedGrouping = resolveProjectGrouping(results, config.projectGrouping);
  const includedProjects = new Set(config.includedProjects);
  const includedCategories = new Set(config.includedCategories);
  const eligible: PreparedMethod[] = [];
  const excluded: ExcludedMethod[] = [];
  const seenSources = new Set<string>();

  for (const result of [...results].sort((a, b) => a.id.localeCompare(b.id))) {
    const prepared = { result, samplingProject: samplingProjectFor(result, resolvedGrouping) };
    let ruleId = "";
    let reason = "";
    if (!includedProjects.has(prepared.samplingProject)) {
      ruleId = "PROJECT_EXCLUDED";
      reason = "The project was not selected for this validation sample.";
    } else if (!includedCategories.has(result.codeCategory)) {
      ruleId = "CATEGORY_EXCLUDED";
      reason = `The ${result.codeCategory} source category was excluded.`;
    } else if (config.excludeGenerated && isGenerated(result)) {
      ruleId = "GENERATED_OR_MINIFIED";
      reason = "The path or layout indicates generated, bundled, external, or minified code.";
    } else if (config.excludeExamples && isExample(result)) {
      ruleId = "EXAMPLE_OR_DEMO";
      reason = "The path indicates example, sample, demo, playground, or debug code.";
    } else if (config.excludeEmpty && isEmptyFunction(result)) {
      ruleId = "EMPTY_FUNCTION";
      reason = "The function body is empty after comments are removed.";
    } else if (result.loc < config.minimumLoc) {
      ruleId = "BELOW_MINIMUM_LOC";
      reason = `LOC ${result.loc} is below the configured minimum of ${config.minimumLoc}.`;
    } else if (config.deduplicateSource && seenSources.has(normalizedSource(result))) {
      ruleId = "DUPLICATE_SOURCE";
      reason = "An identical source segment with a lower deterministic method ID is already eligible.";
    }

    if (ruleId) excluded.push({ ...prepared, ruleId, reason });
    else {
      eligible.push(prepared);
      if (config.deduplicateSource) seenSources.add(normalizedSource(result));
    }
  }
  return { eligible, excluded, resolvedGrouping };
}

export function previewSamplingPopulation(
  results: MethodResult[],
  config: ValidationSamplingConfig,
): PopulationPreview {
  const { eligible, excluded, resolvedGrouping } = preparePopulation(results, config);
  const projectCounts: Record<string, number> = {};
  const exclusionCounts: Record<string, number> = {};
  for (const item of eligible) projectCounts[item.samplingProject] = (projectCounts[item.samplingProject] ?? 0) + 1;
  for (const item of excluded) exclusionCounts[item.ruleId] = (exclusionCounts[item.ruleId] ?? 0) + 1;
  const predictedSmellyCount = eligible.filter(({ result }) => result.isSmelly).length;
  return {
    eligibleCount: eligible.length,
    excludedCount: excluded.length,
    predictedSmellyCount,
    predictedCleanCount: eligible.length - predictedSmellyCount,
    projectCounts,
    exclusionCounts,
    resolvedProjectGrouping: resolvedGrouping,
  };
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function stableRank(seed: string, role: string, value: string): string {
  return fnv1a(`${seed}|${role}|${value}`).toString(16).padStart(8, "0");
}

function smellPresent(result: MethodResult, smell: SamplingSmellKey): boolean {
  if (smell === "longMethod") return result.isLongMethod;
  if (smell === "complexMethod") return result.isComplexMethod;
  if (smell === "complexConditional") return result.isComplexConditional;
  return result.isFeatureEnvy;
}

function boundaryScore(result: MethodResult, thresholds: Thresholds): number {
  const scores: number[] = [];
  if (!result.isLongMethod) scores.push(Math.abs(result.loc - thresholds.longLoc) / Math.max(1, thresholds.longLoc));
  if (!result.isComplexMethod) scores.push(Math.abs(result.cyclo - thresholds.complexCyclo) / Math.max(1, thresholds.complexCyclo));
  if (!result.isComplexConditional) scores.push(Math.abs(result.condOpsMax - thresholds.conditionalOps) / Math.max(1, thresholds.conditionalOps));
  if (!result.isFeatureEnvy) {
    scores.push(
      Math.abs(result.atfd - (thresholds.few + 1)) / Math.max(1, thresholds.few + 1) +
      Math.abs(result.laa - (1 / 3)) +
      Math.abs(result.fdp - thresholds.few) / Math.max(1, thresholds.few),
    );
  }
  return scores.length ? Math.min(...scores) : Number.POSITIVE_INFINITY;
}

function allocateProjectTargets(
  eligible: PreparedMethod[],
  sampleSize: number,
  config: ValidationSamplingConfig,
): Record<string, number> {
  const capacities = new Map<string, number>();
  for (const item of eligible) capacities.set(item.samplingProject, (capacities.get(item.samplingProject) ?? 0) + 1);
  const projects = [...capacities.keys()].sort();
  const hardCapacity = (project: string) => Math.min(
    capacities.get(project) ?? 0,
    config.maximumPerProject > 0 ? config.maximumPerProject : Number.POSITIVE_INFINITY,
  );
  const totalCapacity = projects.reduce((sum, project) => sum + hardCapacity(project), 0);
  if (totalCapacity < sampleSize) {
    throw new Error(`The selected projects and maximum-per-project limit provide ${totalCapacity} eligible methods, fewer than the requested ${sampleSize}.`);
  }

  const requiredMinimum = projects.reduce(
    (sum, project) => sum + Math.min(config.minimumPerProject, hardCapacity(project)),
    0,
  );
  if (requiredMinimum > sampleSize) {
    throw new Error(`The per-project minimum requires at least ${requiredMinimum} methods, more than the requested sample size of ${sampleSize}.`);
  }

  const targets = Object.fromEntries(projects.map((project) => [project, 0])) as Record<string, number>;
  let remaining = sampleSize;
  if (config.minimumPerProject > 0) {
    for (const project of projects) {
      if (!remaining) break;
      const addition = Math.min(config.minimumPerProject, hardCapacity(project), remaining);
      targets[project] += addition;
      remaining -= addition;
    }
  }

  while (remaining > 0) {
    const active = projects.filter((project) => targets[project] < hardCapacity(project));
    if (!active.length) break;
    const weightTotal = active.reduce((sum, project) => (
      sum + (config.projectAllocation === "equal" ? 1 : Math.max(1, hardCapacity(project) - targets[project]))
    ), 0);
    const shares = active.map((project) => {
      const weight = config.projectAllocation === "equal" ? 1 : Math.max(1, hardCapacity(project) - targets[project]);
      const exact = remaining * weight / weightTotal;
      return { project, exact, room: hardCapacity(project) - targets[project] };
    });
    let added = 0;
    for (const share of shares) {
      const addition = Math.min(share.room, Math.floor(share.exact), remaining - added);
      targets[share.project] += addition;
      added += addition;
    }
    remaining -= added;
    if (!remaining) break;
    for (const share of shares.sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.project.localeCompare(b.project))) {
      if (!remaining) break;
      if (targets[share.project] < hardCapacity(share.project)) {
        targets[share.project] += 1;
        remaining -= 1;
      }
    }
  }
  return targets;
}

function createSamplingPlan(
  eligible: PreparedMethod[],
  config: ValidationSamplingConfig,
  thresholds: Thresholds,
): SamplingPlan {
  const sampleSize = clampInteger(config.sampleSize, 1, eligible.length || 1);
  if (!eligible.length) throw new Error("No methods remain after applying the eligibility rules.");
  if (config.sampleSize > eligible.length) {
    throw new Error(`Only ${eligible.length} methods are eligible, fewer than the requested ${config.sampleSize}.`);
  }
  if (!config.seed.trim()) throw new Error("Enter a deterministic sampling seed.");

  const projectTargets = allocateProjectTargets(eligible, sampleSize, config);
  const hardCaps = new Map<string, number>();
  for (const item of eligible) hardCaps.set(item.samplingProject, (hardCaps.get(item.samplingProject) ?? 0) + 1);
  if (config.maximumPerProject > 0) {
    for (const [project, capacity] of hardCaps) hardCaps.set(project, Math.min(capacity, config.maximumPerProject));
  }

  const selected: Selection[] = [];
  const selectedIds = new Set<string>();
  const selectedByProject = new Map<string, number>();
  const warnings: string[] = [];

  function pick(
    candidates: PreparedMethod[],
    requestedCount: number,
    role: string,
    score?: (item: PreparedMethod) => number,
  ): number {
    const available = candidates.filter(({ result, samplingProject }) => (
      !selectedIds.has(result.id) &&
      (selectedByProject.get(samplingProject) ?? 0) < (hardCaps.get(samplingProject) ?? 0)
    ));
    const poolProjectCounts = new Map<string, number>();
    const groups = new Map<string, PreparedMethod[]>();
    for (const item of available) {
      poolProjectCounts.set(item.samplingProject, (poolProjectCounts.get(item.samplingProject) ?? 0) + 1);
      const group = groups.get(item.samplingProject) ?? [];
      group.push(item);
      groups.set(item.samplingProject, group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => (
        (score ? score(a) - score(b) : 0) ||
        stableRank(config.seed, role, a.result.id).localeCompare(stableRank(config.seed, role, b.result.id)) ||
        a.result.id.localeCompare(b.result.id)
      ));
    }

    let picked = 0;
    const target = Math.min(requestedCount, sampleSize - selected.length);
    while (picked < target) {
      const projects = [...groups.keys()].filter((project) => (
        (groups.get(project)?.length ?? 0) > 0 &&
        (selectedByProject.get(project) ?? 0) < (hardCaps.get(project) ?? 0)
      ));
      if (!projects.length) break;
      projects.sort((a, b) => {
        const deficitA = (projectTargets[a] ?? 0) - (selectedByProject.get(a) ?? 0);
        const deficitB = (projectTargets[b] ?? 0) - (selectedByProject.get(b) ?? 0);
        return deficitB - deficitA ||
          stableRank(config.seed, `${role}-project`, a).localeCompare(stableRank(config.seed, `${role}-project`, b));
      });
      const project = projects.find((name) => (projectTargets[name] ?? 0) > (selectedByProject.get(name) ?? 0)) ?? projects[0];
      const item = groups.get(project)?.shift();
      if (!item) break;
      selected.push({ ...item, role, poolProjectN: poolProjectCounts.get(project) ?? 0 });
      selectedIds.add(item.result.id);
      selectedByProject.set(project, (selectedByProject.get(project) ?? 0) + 1);
      picked += 1;
    }
    return picked;
  }

  const multiNeeded = Math.max(0, config.multiSmellMinimum);
  const multiPicked = pick(
    eligible.filter(({ result }) => result.smellCount > 1),
    multiNeeded,
    "minimum_multi_smell",
  );
  if (multiPicked < multiNeeded) warnings.push(`Only ${multiPicked} of ${multiNeeded} requested multi-smell methods were available.`);

  for (const smell of SAMPLING_SMELLS) {
    const alreadyCovered = selected.filter(({ result }) => smellPresent(result, smell.key)).length;
    const needed = Math.max(0, config.smellMinimums[smell.key] - alreadyCovered);
    const picked = pick(
      eligible.filter(({ result }) => smellPresent(result, smell.key)),
      needed,
      `minimum_${smell.key}`,
    );
    if (picked < needed) {
      warnings.push(`${smell.label}: selected ${alreadyCovered + picked} of the requested minimum ${config.smellMinimums[smell.key]}.`);
    }
  }

  let targetSmelly = config.classDistribution === "custom"
    ? Math.round(sampleSize * clampInteger(config.smellyPercent, 0, 100) / 100)
    : undefined;
  const selectedSmelly = () => selected.filter(({ result }) => result.isSmelly).length;
  if (targetSmelly !== undefined && selectedSmelly() > targetSmelly) {
    warnings.push(`Per-smell minimums require at least ${selectedSmelly()} predicted-smelly methods, above the requested target of ${targetSmelly}.`);
    targetSmelly = selectedSmelly();
  }

  const boundaryTarget = Math.round(sampleSize * clampInteger(config.boundaryPercent, 0, 100) / 100);
  const cleanLimit = targetSmelly === undefined ? sampleSize : sampleSize - targetSmelly;
  const cleanAlready = selected.length - selectedSmelly();
  const boundaryRequested = Math.min(boundaryTarget, Math.max(0, cleanLimit - cleanAlready));
  const boundaryPicked = pick(
    eligible.filter(({ result }) => !result.isSmelly),
    boundaryRequested,
    "boundary_detector_negative",
    (item) => boundaryScore(item.result, thresholds),
  );
  if (boundaryPicked < boundaryRequested) warnings.push(`Only ${boundaryPicked} of ${boundaryRequested} requested detector-negative boundary methods were available.`);

  if (targetSmelly !== undefined) {
    const smellyNeeded = Math.max(0, targetSmelly - selectedSmelly());
    const smellyPicked = pick(eligible.filter(({ result }) => result.isSmelly), smellyNeeded, "target_predicted_smelly");
    if (smellyPicked < smellyNeeded) warnings.push("The requested predicted-smelly percentage could not be reached with the eligible population.");
    const cleanTarget = sampleSize - selectedSmelly();
    const cleanNeeded = Math.max(0, cleanTarget - (selected.length - selectedSmelly()));
    const cleanPicked = pick(eligible.filter(({ result }) => !result.isSmelly), cleanNeeded, "target_predicted_clean");
    if (cleanPicked < cleanNeeded) warnings.push("The requested predicted-clean percentage could not be reached with the eligible population.");
  }

  pick(eligible, sampleSize - selected.length, "representative_fill");
  if (selected.length < sampleSize) {
    throw new Error(`The configured constraints produced only ${selected.length} of ${sampleSize} requested methods. Increase project limits or include more projects.`);
  }

  const achievedByProject = Object.fromEntries(
    [...selectedByProject.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  for (const [project, target] of Object.entries(projectTargets)) {
    if ((achievedByProject[project] ?? 0) !== target) {
      warnings.push("Per-smell or class constraints caused the final project allocation to differ from its target.");
      break;
    }
  }
  return { selected, warnings: [...new Set(warnings)], projectTargets };
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function createCsv(headers: string[], rows: unknown[][]): string {
  return `${[headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n")}\r\n`;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function datasetFingerprint(results: MethodResult[], context: SamplingBuildContext): Promise<string> {
  const ordered = [...results].sort((a, b) => a.id.localeCompare(b.id));
  const chunkHashes: string[] = [];
  for (let start = 0; start < ordered.length; start += 500) {
    const canonical = ordered.slice(start, start + 500).map((result) => JSON.stringify([
      result.id,
      result.project,
      result.relativePath,
      result.functionName,
      result.functionType,
      result.startLine,
      result.endLine,
      result.source,
      result.loc,
      result.cyclo,
      result.maxNesting,
      result.condOpsMax,
      result.atfd,
      result.laa,
      result.fdp,
      Number(result.isLongMethod),
      Number(result.isComplexMethod),
      Number(result.isComplexConditional),
      Number(result.isFeatureEnvy),
    ])).join("\n");
    chunkHashes.push(await sha256Text(canonical));
  }
  return sha256Text(JSON.stringify({
    csvSchemaVersion: CSV_SCHEMA_VERSION,
    detectorVersion: DETECTOR_VERSION,
    parserVersion: context.parserVersion,
    thresholds: context.thresholds,
    chunkHashes,
  }));
}

function safeFileStem(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "validation-sample";
}

function createAssignments(sampleIds: string[], validatorCount: number, annotationsPerMethod: number, seed: string) {
  const validators = Array.from({ length: validatorCount }, (_, index) => `VAL-${String(index + 1).padStart(2, "0")}`);
  const assignments = validators.map((validatorCode) => ({ validatorCode, sampleIds: [] as string[] }));
  sampleIds.forEach((sampleId, index) => {
    const start = fnv1a(`${seed}|assignment|${sampleId}|${index}`) % validatorCount;
    for (let offset = 0; offset < annotationsPerMethod; offset += 1) {
      assignments[(start + offset) % validatorCount].sampleIds.push(sampleId);
    }
  });
  for (const assignment of assignments) {
    assignment.sampleIds.sort((a, b) => (
      stableRank(seed, `${assignment.validatorCode}-order`, a).localeCompare(stableRank(seed, `${assignment.validatorCode}-order`, b)) || a.localeCompare(b)
    ));
  }
  return assignments;
}

export async function buildValidationSamplePackage(
  results: MethodResult[],
  config: ValidationSamplingConfig,
  context: SamplingBuildContext,
): Promise<SamplingPackage> {
  if (!results.length) throw new Error("Analyze JavaScript methods before creating a validation sample.");
  const validatorCount = clampInteger(config.validatorCount, 1, 50);
  const annotationsPerMethod = clampInteger(config.annotationsPerMethod, 1, validatorCount);
  if (config.annotationsPerMethod > validatorCount) throw new Error("Annotations per method cannot exceed the number of validators.");

  const prepared = preparePopulation(results, config);
  const plan = createSamplingPlan(prepared.eligible, config, context.thresholds);
  const datasetSha256 = await datasetFingerprint(results, context);
  const presentation = [...plan.selected].sort((a, b) => (
    stableRank(config.seed, "presentation", a.result.id).localeCompare(stableRank(config.seed, "presentation", b.result.id)) ||
    a.result.id.localeCompare(b.result.id)
  ));

  const sampleRecords = await Promise.all(presentation.map(async (item, index) => {
    const sampleId = `V-${String(index + 1).padStart(5, "0")}`;
    const segmentSha256 = await sha256Text(item.result.source);
    return { item, sampleId, segmentSha256 };
  }));
  const selectedRoleProjectCounts = countBy(sampleRecords, ({ item }) => `${item.role}\u0000${item.samplingProject}`);
  const sampleById = new Map(sampleRecords.map((record) => [record.sampleId, record]));

  const blindedSamples = sampleRecords.map(({ item, sampleId, segmentSha256 }) => ({
    sampleId,
    datasetMethodId: sampleId,
    project: item.samplingProject,
    file: item.result.relativePath,
    functionName: item.result.functionName,
    functionType: item.result.functionType,
    startLine: item.result.startLine,
    endLine: item.result.endLine,
    contextStartLine: config.includeNearbyContext ? item.result.contextStartLine : item.result.startLine,
    contextEndLine: config.includeNearbyContext ? item.result.contextEndLine : item.result.endLine,
    sourceSegment: item.result.source,
    sourceContext: config.includeNearbyContext ? sourceWithNearbyContext(item.result) : item.result.source,
    segmentSha256,
    protocolVersion: "2.0.0",
  }));

  const study = {
    title: config.title.trim() || "UPM JavaScript Code Smell Validation",
    pilotSize: blindedSamples.length,
    samplingSeed: config.seed,
    datasetSha256,
    csvSchemaVersion: CSV_SCHEMA_VERSION,
    detectorVersion: DETECTOR_VERSION,
    blinded: true,
    phase: config.phase,
    protocolVersion: "2.0.0",
  };
  const masterPayload = { study, samples: blindedSamples };

  const manifestHeaders = [
    "SAMPLE_ID", "DATASET_METHOD_ID", "PROJECT", "DATASET_PROJECT", "FILE", "FUNCTION", "FUNCTION_TYPE",
    "START_LINE", "END_LINE", "LOC", "CYCLO", "MAXNESTING", "CONDOPS_MAX", "COND_NESTING",
    "NUM_CONDITIONS", "ATFD", "LAA", "FDP", "FOREIGN_PROVIDERS", "is_long_method",
    "is_complex_method", "is_complex_conditional", "is_feature_envy", "is_smelly", "SMELL_COUNT",
    "SMELL_TYPES", "SAMPLE_ROLE", "SAMPLING_STRATUM", "STRATUM_POOL_N_PROJECT",
    "STRATUM_SELECTED_N_PROJECT", "CONDITIONAL_INCLUSION_PROBABILITY", "SAMPLING_SEED",
    "FE_INFERENCE_MODE", "FE_BATCH_ID", "FE_BATCH_FILE_COUNT", "FE_BATCH_SIZE_LIMIT",
    "FE_BATCH_BYTE_LIMIT", "FE_SCOPE", "TYPE_INFERENCE_COVERAGE", "UNKNOWN_ACCESS_COUNT",
    "DATASET_SHA256", "SEGMENT_SHA256", "CSV_SCHEMA_VERSION", "DETECTOR_VERSION", "PARSER_VERSION",
  ];
  const manifestRows = sampleRecords.map(({ item, sampleId, segmentSha256 }) => {
    const roleProjectKey = `${item.role}\u0000${item.samplingProject}`;
    const roleProjectSelected = selectedRoleProjectCounts[roleProjectKey] ?? 1;
    const probability = item.poolProjectN ? roleProjectSelected / item.poolProjectN : 0;
    return [
      sampleId, item.result.id, item.samplingProject, item.result.project, item.result.relativePath,
      item.result.functionName, item.result.functionType, item.result.startLine, item.result.endLine,
      item.result.loc, item.result.cyclo, item.result.maxNesting, item.result.condOpsMax,
      item.result.condNesting, item.result.numConditions, item.result.atfd, item.result.laa.toFixed(10),
      item.result.fdp, item.result.foreignProviders.join("|"), Number(item.result.isLongMethod),
      Number(item.result.isComplexMethod), Number(item.result.isComplexConditional),
      Number(item.result.isFeatureEnvy), Number(item.result.isSmelly), item.result.smellCount,
      item.result.smellTypes.join("|"), item.role, `${item.role}|${item.samplingProject}`,
      item.poolProjectN, roleProjectSelected, probability.toFixed(10), config.seed,
      item.result.feInferenceMode, item.result.feBatchId, item.result.feBatchFileCount,
      item.result.feBatchSizeLimit, item.result.feBatchByteLimit, item.result.feScope,
      item.result.typeInferenceCoverage.toFixed(4), item.result.unknownAccessCount,
      datasetSha256, segmentSha256, CSV_SCHEMA_VERSION, DETECTOR_VERSION, context.parserVersion,
    ];
  });

  const exclusionHeaders = ["DATASET_METHOD_ID", "PROJECT", "FILE", "FUNCTION", "FUNCTION_TYPE", "START_LINE", "END_LINE", "RULE_ID", "REASON"];
  const exclusionRows = prepared.excluded.map((item) => [
    item.result.id, item.samplingProject, item.result.relativePath, item.result.functionName,
    item.result.functionType, item.result.startLine, item.result.endLine, item.ruleId, item.reason,
  ]);

  const assignments = createAssignments(blindedSamples.map((sample) => sample.sampleId), validatorCount, annotationsPerMethod, config.seed);
  const assignmentRows: unknown[][] = [];
  const artifacts: SamplingArtifact[] = [{
    name: "validation-sample.blinded.json",
    contents: `${JSON.stringify(masterPayload, null, 2)}\n`,
  }];
  for (const assignment of assignments) {
    const assignedSamples = assignment.sampleIds.map((sampleId) => {
      const record = sampleById.get(sampleId);
      if (!record) throw new Error(`Internal assignment error for ${sampleId}.`);
      return blindedSamples.find((sample) => sample.sampleId === sampleId)!;
    });
    artifacts.push({
      name: `validator-payloads/${assignment.validatorCode}.json`,
      contents: `${JSON.stringify({
        study: { ...study, pilotSize: assignedSamples.length },
        validatorCode: assignment.validatorCode,
        samples: assignedSamples,
      }, null, 2)}\n`,
    });
    assignment.sampleIds.forEach((sampleId, index) => {
      const record = sampleById.get(sampleId)!;
      assignmentRows.push([sampleId, record.item.result.id, assignment.validatorCode, index + 1]);
    });
  }

  const selectedMethods = sampleRecords.map(({ item }) => item.result);
  const report = {
    protocolVersion: "2.0.0",
    generatedAt: new Date().toISOString(),
    dataset: {
      sha256: datasetSha256,
      rowCount: results.length,
      csvSchemaVersion: CSV_SCHEMA_VERSION,
      detectorVersion: DETECTOR_VERSION,
      parserVersion: context.parserVersion,
      filesSelected: context.selectedFileCount,
      filesAnalyzed: context.successfulFileCount,
      parseFailureCount: context.parseFailureCount,
      resourceExclusionCount: context.resourceExclusionCount,
      projectGrouping: context.projectGrouping,
    },
    design: {
      ...config,
      projectGroupingResolved: prepared.resolvedGrouping,
      annotationsPerMethod,
      validatorCount,
      randomizationAlgorithm: "FNV-1a 32-bit deterministic rank with method-ID tie break",
      fingerprintAlgorithm: "SHA-256 tree fingerprint over 500-row canonical chunks",
    },
    population: {
      eligibleMethods: prepared.eligible.length,
      excludedMethods: prepared.excluded.length,
      exclusionRules: countBy(prepared.excluded, (item) => item.ruleId),
      eligibleProjects: countBy(prepared.eligible, (item) => item.samplingProject),
      predictedSmelly: prepared.eligible.filter(({ result }) => result.isSmelly).length,
      predictedClean: prepared.eligible.filter(({ result }) => !result.isSmelly).length,
    },
    sample: {
      selectedMethods: selectedMethods.length,
      predictedSmelly: selectedMethods.filter((result) => result.isSmelly).length,
      predictedClean: selectedMethods.filter((result) => !result.isSmelly).length,
      smellCounts: Object.fromEntries(SAMPLING_SMELLS.map((smell) => [
        smell.label,
        selectedMethods.filter((result) => smellPresent(result, smell.key)).length,
      ])),
      projectTargets: plan.projectTargets,
      selectedProjects: countBy(plan.selected, (item) => item.samplingProject),
      samplingRoles: countBy(plan.selected, (item) => item.role),
      functionTypes: countBy(selectedMethods, (result) => result.functionType),
    },
    thresholdSnapshot: context.thresholds,
    warnings: plan.warnings,
  };

  artifacts.push(
    { name: "private/sampling-manifest.csv", contents: createCsv(manifestHeaders, manifestRows) },
    { name: "private/assignment-manifest.csv", contents: createCsv(["SAMPLE_ID", "DATASET_METHOD_ID", "VALIDATOR_CODE", "SEQUENCE_NO"], assignmentRows) },
    { name: "private/exclusion-manifest.csv", contents: createCsv(exclusionHeaders, exclusionRows) },
    { name: "private/sampling-report.json", contents: `${JSON.stringify(report, null, 2)}\n` },
    {
      name: "README.txt",
      contents: [
        "UPM JavaScript Code Smell Validation Package",
        "",
        "Give each validator only their matching file from validator-payloads/.",
        "validation-sample.blinded.json contains the complete blinded sample for local testing.",
        "Keep every file under private/ restricted to the research team because it contains detector labels and metrics.",
        "Do not place this package in the public website repository.",
        "",
        `Dataset SHA-256: ${datasetSha256}`,
        `Sampling seed: ${config.seed}`,
      ].join("\r\n"),
    },
  );

  return {
    artifacts,
    zipFileName: `${safeFileStem(config.title)}-${config.phase}.zip`,
    selectedCount: sampleRecords.length,
    eligibleCount: prepared.eligible.length,
    warnings: plan.warnings,
    datasetSha256,
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function zipHeader(size: number): Uint8Array {
  return new Uint8Array(size);
}

export function createStoredZip(artifacts: SamplingArtifact[]): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  const dosDate = (1 << 5) | 1;

  for (const artifact of artifacts) {
    const name = encoder.encode(artifact.name.replace(/\\/g, "/"));
    const data = encoder.encode(artifact.contents);
    const checksum = crc32(data);
    const local = zipHeader(30);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    localParts.push(local, name, data);

    const central = zipHeader(46);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const end = zipHeader(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, artifacts.length, true);
  endView.setUint16(10, artifacts.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);
  const zip = concatBytes([...localParts, centralDirectory, end]);
  const buffer = new ArrayBuffer(zip.byteLength);
  new Uint8Array(buffer).set(zip);
  return new Blob([buffer], { type: "application/zip" });
}

export function downloadSamplingPackage(output: SamplingPackage): void {
  const url = URL.createObjectURL(createStoredZip(output.artifacts));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = output.zipFileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
