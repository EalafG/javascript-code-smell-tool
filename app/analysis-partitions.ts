export const INFERENCE_PARTITION_FILE_LIMIT = 100;
export const INFERENCE_PARTITION_BYTE_LIMIT = 512 * 1024;
export const RESOURCE_SAFETY_FILE_LIMIT = 1024 * 1024;
export const RESOURCE_SAFETY_LINE_LIMIT = 5000;

export type ResourceRisk = {
  ruleId: "OVERSIZED_SOURCE_FILE" | "MINIFIED_OR_BUNDLED_FILE" | "MINIFIED_LAYOUT";
  reason: string;
};

export function resourceRiskFor(
  relativePath: string,
  size: number,
  source?: string,
): ResourceRisk | null {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  const fileName = normalized.split("/").at(-1) ?? normalized;
  if (size > RESOURCE_SAFETY_FILE_LIMIT) {
    return {
      ruleId: "OVERSIZED_SOURCE_FILE",
      reason: `Source size ${size} bytes exceeds the browser-safe ${RESOURCE_SAFETY_FILE_LIMIT}-byte limit.`,
    };
  }
  if (
    fileName.includes(".min.") || fileName.includes(".bundle.") ||
    fileName.endsWith("-bundle.js") || fileName.endsWith(".bundled.js")
  ) {
    return {
      ruleId: "MINIFIED_OR_BUNDLED_FILE",
      reason: "The filename identifies minified or bundled generated code.",
    };
  }
  if (source !== undefined) {
    let physicalLineLength = 0;
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      if (code === 10 || code === 13) physicalLineLength = 0;
      else {
        physicalLineLength += 1;
        if (physicalLineLength > RESOURCE_SAFETY_LINE_LIMIT) {
          return {
            ruleId: "MINIFIED_LAYOUT",
            reason: `A physical line exceeds the browser-safe ${RESOURCE_SAFETY_LINE_LIMIT}-character limit.`,
          };
        }
      }
    }
  }
  return null;
}

export function partitionForInference<T extends { size: number }>(entries: T[]): T[][] {
  const partitions: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const entry of entries) {
    const startsNewPartition = current.length > 0 && (
      current.length >= INFERENCE_PARTITION_FILE_LIMIT ||
      currentBytes + Math.max(0, entry.size) > INFERENCE_PARTITION_BYTE_LIMIT
    );
    if (startsNewPartition) {
      partitions.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += Math.max(0, entry.size);
  }

  if (current.length) partitions.push(current);
  return partitions;
}
