export class ShipmentDomainError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ShipmentError";
    this.code = code;
  }
}

export function normalizeReference(value) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleUpperCase("en-US");
}

export function formatUtcDateTime(value) {
  return new Date(value).toISOString().replace("T", " ").slice(0, 19);
}

export function assertReceiptCanStart(status) {
  if (status === "CLOSED") throw new ShipmentDomainError("Reopen this Shipment before creating another Receipt.", "SHIPMENT_CLOSED");
}

export function assertShipmentCanClose({ status, hasDraftReceipt, hasExpectedQuantities, reason }) {
  if (status === "CLOSED") return;
  if (hasDraftReceipt) throw new ShipmentDomainError("Process or cancel all draft Receipts before closing this Shipment.", "DRAFT_RECEIPTS_REMAIN");
  if (hasExpectedQuantities && !reason?.trim()) {
    throw new ShipmentDomainError("Add a reason when closing a Shipment with expected quantities; receipt reconciliation is not available yet.", "CLOSURE_REASON_REQUIRED");
  }
}

export function assertShipmentCanReopen(status, reason) {
  if (!reason?.trim()) throw new ShipmentDomainError("Reopen reason is required.", "INVALID_INPUT");
  if (status !== "CLOSED") throw new ShipmentDomainError("Only a closed Shipment can be reopened.", "NOT_CLOSED");
}
