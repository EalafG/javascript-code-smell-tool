import type { MethodResult } from "./analyzer.ts";

export const CSV_HEADERS = [
  "ID",
  "PROJECT",
  "FILE",
  "FUNCTION",
  "FUNCTION_TYPE",
  "START_LINE",
  "END_LINE",
  "LOC",
  "SPAN_LOC",
  "COMMENT_LINES",
  "BLANK_LINES",
  "CYCLO",
  "MAXNESTING",
  "NOP",
  "NOLV",
  "CONDOPS_MAX",
  "COND_NESTING",
  "NUM_CONDITIONS",
  "ATFD",
  "LAA",
  "FDP",
  "FOREIGN_PROVIDERS",
  "is_long_method",
  "is_complex_method",
  "is_complex_conditional",
  "is_feature_envy",
  "is_smelly",
  "SMELL_COUNT",
  "SMELL_TYPES",
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

export function toCsv(results: MethodResult[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const result of results) {
    const row: Array<string | number> = [
      result.id,
      result.project,
      result.relativePath,
      result.functionName,
      result.functionType,
      result.startLine,
      result.endLine,
      result.loc,
      result.spanLoc,
      result.commentLines,
      result.blankLines,
      result.cyclo,
      result.maxNesting,
      result.nop,
      result.nolv,
      result.condOpsMax,
      result.condNesting,
      result.numConditions,
      result.atfd,
      result.laa.toFixed(4),
      result.fdp,
      result.foreignProviders.join("|"),
      Number(result.isLongMethod),
      Number(result.isComplexMethod),
      Number(result.isComplexConditional),
      Number(result.isFeatureEnvy),
      Number(result.isSmelly),
      result.smellCount,
      result.smellTypes.map((name) => SMELL_EXPORT_NAMES[name]).join("|"),
    ];
    lines.push(row.map(csvEscape).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function downloadCsv(results: MethodResult[], filename: string) {
  const blob = new Blob([toCsv(results)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
