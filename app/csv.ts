import { DEFAULT_THRESHOLDS } from "./analyzer.ts";
import type { MethodResult, Thresholds } from "./analyzer.ts";

export const CSV_SCHEMA_VERSION = "2.4.0";
export const DETECTOR_VERSION = "0.6.0";

export type ProjectGroupingMode = "single-project" | "direct-subfolders";

export type CsvExportContext = {
  thresholds: Thresholds;
  parserVersion: string;
  selectedFileCount: number;
  successfulFileCount: number;
  parseFailureCount: number;
  resourceExclusionCount: number;
  projectGrouping: ProjectGroupingMode;
};

export type ParseFailureExport = {
  project?: string;
  file: string;
  message: string;
};

export type AnalysisExclusionExport = {
  project?: string;
  file: string;
  ruleId: string;
  reason: string;
};

export const CSV_HEADERS = [
  "ID",
  "PROJECT",
  "FILE",
  "CODE_CATEGORY",
  "FUNCTION",
  "FUNCTION_TYPE",
  "START_LINE",
  "END_LINE",
  "LOC",
  "SPAN_LOC",
  "COMMENT_LINES",
  "BLANK_LINES",
  "DELIMITER_LINES",
  "CYCLO",
  "MAXNESTING",
  "NOP",
  "NOLV",
  "CONDOPS_MAX",
  "LOGICAL_OPS_MAX",
  "COND_NESTING",
  "NUM_CONDITIONS",
  "ATD",
  "ATFD",
  "LOCAL_ACCESS_COUNT",
  "LAA",
  "LAA_EXACT",
  "FDP",
  "FOREIGN_PROVIDERS",
  "COUPLING_TUPLES",
  "TYPE_INFERENCE_COVERAGE",
  "UNKNOWN_ACCESS_COUNT",
  "FE_INFERENCE_MODE",
  "FE_MAX_ITERATIONS",
  "FE_TYPE_SET_LIMIT",
  "FE_BATCH_ID",
  "FE_BATCH_FILE_COUNT",
  "FE_BATCH_SIZE_LIMIT",
  "FE_BATCH_BYTE_LIMIT",
  "FE_SCOPE",
  "FE_INDEXED_FILE_COUNT",
  "FOREIGN_MEMBER_CALLS",
  "FOREIGN_CALL_PROVIDERS",
  "CSV_SCHEMA_VERSION",
  "DETECTOR_VERSION",
  "PARSER_VERSION",
  "FILES_SELECTED",
  "FILES_ANALYZED",
  "PARSE_FAILURE_COUNT",
  "RESOURCE_EXCLUSION_COUNT",
  "PROJECT_GROUPING",
  "LONG_LOC_THRESHOLD",
  "LONG_COMPOUND_ENABLED",
  "LONG_CYCLO_THRESHOLD",
  "LONG_NESTING_THRESHOLD",
  "COMPLEX_CYCLO_THRESHOLD",
  "CONDITIONAL_OPS_THRESHOLD",
  "CONDITIONAL_LOGICAL_OPS_MAX_ALLOWED",
  "FEW_THRESHOLD",
  "is_long_method",
  "is_complex_method",
  "is_complex_conditional",
  "is_complex_conditional_sonar",
  "is_feature_envy",
  "is_smelly",
  "SMELL_COUNT",
  "SMELL_TYPES",
] as const;

export const PARSE_FAILURE_HEADERS = [
  "PROJECT",
  "FILE",
  "PARSER_VERSION",
  "CSV_SCHEMA_VERSION",
  "DETECTOR_VERSION",
  "PROJECT_GROUPING",
  "ERROR_MESSAGE",
] as const;

export const ANALYSIS_EXCLUSION_HEADERS = [
  "PROJECT",
  "FILE",
  "RULE_ID",
  "REASON",
  "PARSER_VERSION",
  "CSV_SCHEMA_VERSION",
  "DETECTOR_VERSION",
  "PROJECT_GROUPING",
] as const;

const SMELL_EXPORT_NAMES: Record<string, string> = {
  "Long Method": "LongMethod",
  "Complex Method": "ComplexMethod",
  "Complex Conditional": "ComplexConditional",
  "Feature Envy": "FeatureEnvy",
};

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function defaultContext(results: MethodResult[]): CsvExportContext {
  return {
    thresholds: DEFAULT_THRESHOLDS,
    parserVersion: "Acorn 8+",
    selectedFileCount: new Set(results.map((result) => result.relativePath)).size,
    successfulFileCount: new Set(results.map((result) => result.relativePath)).size,
    parseFailureCount: 0,
    resourceExclusionCount: 0,
    projectGrouping: "single-project",
  };
}

export function toCsv(results: MethodResult[], context: CsvExportContext = defaultContext(results)): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const result of results) {
    const row: Array<string | number> = [
      result.id,
      result.project,
      result.relativePath,
      result.codeCategory,
      result.functionName,
      result.functionType,
      result.startLine,
      result.endLine,
      result.loc,
      result.spanLoc,
      result.commentLines,
      result.blankLines,
      result.delimiterLines,
      result.cyclo,
      result.maxNesting,
      result.nop,
      result.nolv,
      result.condOpsMax,
      result.logicalOpsMax,
      result.condNesting,
      result.numConditions,
      result.atd,
      result.atfd,
      result.localAccessCount,
      result.laa.toFixed(10),
      result.atd === 0 ? "1/1" : `${result.localAccessCount}/${result.atd}`,
      result.fdp,
      result.foreignProviders.join("|"),
      result.couplingTuples.join("|"),
      result.typeInferenceCoverage.toFixed(4),
      result.unknownAccessCount,
      result.feInferenceMode,
      result.feMaxIterations,
      result.feTypeSetLimit,
      result.feBatchId,
      result.feBatchFileCount,
      result.feBatchSizeLimit,
      result.feBatchByteLimit,
      result.feScope,
      result.feIndexedFileCount,
      result.foreignMemberCalls,
      result.foreignCallProviders.join("|"),
      CSV_SCHEMA_VERSION,
      DETECTOR_VERSION,
      context.parserVersion,
      context.selectedFileCount,
      context.successfulFileCount,
      context.parseFailureCount,
      context.resourceExclusionCount,
      context.projectGrouping,
      context.thresholds.longLoc,
      Number(context.thresholds.longCompound),
      context.thresholds.longCyclo,
      context.thresholds.longNesting,
      context.thresholds.complexCyclo,
      context.thresholds.conditionalOps,
      context.thresholds.conditionalLogicalOpsMax,
      context.thresholds.few,
      Number(result.isLongMethod),
      Number(result.isComplexMethod),
      Number(result.isComplexConditional),
      Number(result.isComplexConditionalSonar),
      Number(result.isFeatureEnvy),
      Number(result.isSmelly),
      result.smellCount,
      result.smellTypes.map((name) => SMELL_EXPORT_NAMES[name]).join("|"),
    ];
    lines.push(row.map(csvEscape).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function downloadText(contents: string, filename: string) {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function downloadCsv(results: MethodResult[], filename: string, context?: CsvExportContext) {
  downloadText(toCsv(results, context), filename);
}

export function toParseFailuresCsv(
  project: string,
  failures: ParseFailureExport[],
  parserVersion: string,
  projectGrouping: ProjectGroupingMode = "single-project",
): string {
  const lines = [PARSE_FAILURE_HEADERS.join(",")];
  for (const failure of failures) {
    lines.push([
      failure.project ?? project,
      failure.file,
      parserVersion,
      CSV_SCHEMA_VERSION,
      DETECTOR_VERSION,
      projectGrouping,
      failure.message,
    ].map(csvEscape).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function downloadParseFailuresCsv(
  project: string,
  failures: ParseFailureExport[],
  parserVersion: string,
  filename: string,
  projectGrouping: ProjectGroupingMode = "single-project",
) {
  downloadText(toParseFailuresCsv(project, failures, parserVersion, projectGrouping), filename);
}

export function toAnalysisExclusionsCsv(
  project: string,
  exclusions: AnalysisExclusionExport[],
  parserVersion: string,
  projectGrouping: ProjectGroupingMode = "single-project",
): string {
  const lines = [ANALYSIS_EXCLUSION_HEADERS.join(",")];
  for (const exclusion of exclusions) {
    lines.push([
      exclusion.project ?? project,
      exclusion.file,
      exclusion.ruleId,
      exclusion.reason,
      parserVersion,
      CSV_SCHEMA_VERSION,
      DETECTOR_VERSION,
      projectGrouping,
    ].map(csvEscape).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function downloadAnalysisExclusionsCsv(
  project: string,
  exclusions: AnalysisExclusionExport[],
  parserVersion: string,
  filename: string,
  projectGrouping: ProjectGroupingMode = "single-project",
) {
  downloadText(toAnalysisExclusionsCsv(project, exclusions, parserVersion, projectGrouping), filename);
}
