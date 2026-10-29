const CATALOG_EXECUTING = new Set(["RUNNING", "RECONCILING"]);
const CATALOG_ATTENTION = new Set(["FAILED", "CONFLICT"]);
const CATALOG_TERMINAL = new Set(["SUCCEEDED", "SKIPPED"]);

/** Summary labels preserve catalog kind: product-draft execution is not inventory receipt completion. */
export function summarizeCatalogExecution(batchStatus: string, operationStatuses: string[]) {
  if (!operationStatuses.length) return batchStatus === "MAPPING" ? "CATALOG_MAPPING" : "CATALOG_DRAFT";
  if (operationStatuses.includes("UNKNOWN")) return "CATALOG_UNCERTAIN";
  if (operationStatuses.some((status) => CATALOG_EXECUTING.has(status))) return "CATALOG_IN_PROGRESS";
  if (operationStatuses.some((status) => CATALOG_ATTENTION.has(status))) return "CATALOG_ATTENTION";
  if (operationStatuses.includes("READY")) return "CATALOG_DRAFT";
  if (operationStatuses.every((status) => CATALOG_TERMINAL.has(status))) return "CATALOG_EXECUTION_COMPLETE";
  return "CATALOG_DRAFT";
}
