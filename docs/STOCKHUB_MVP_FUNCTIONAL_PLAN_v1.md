# StockHub MVP Functional Plan v1.0

**Status:** Locked baseline for Sprints 1–3  
**Product:** Inventory Receiving & Management for Shopify

This document records the user-approved MVP contract. Implementation must preserve these decisions. A serious contradiction discovered in the repository must be reported and resolved explicitly; do not silently alter the business rules.

## Product vision

StockHub helps a Shopify merchant plan incoming goods, receive a shipment over one or more visits, import and match item data, inspect physical goods, safely record exceptions, and prepare accepted quantities for later Shopify inventory synchronization.

## MVP scope

- One authenticated Shopify shop per request context; multiple Shopify Locations per shop.
- Modules: Overview, Products, Inventory, Receiving (Shipments, Receipt/Import History, Exceptions), and Current Store.
- Receiving is the central workflow. Shipment, Receipt, inspection, and import history are related domain concepts, not separate applications.
- All shop-owned rows and operations must be scoped to the authenticated shop. A shop must never read or mutate another shop's data.

Explicitly deferred: multi-store connector (including five-store support), staff management/roles, automatic cross-store sync, advanced purchase orders, barcode scanning, Google Sheets/FTP, automatic publishing, supplier refund automation, full Resolution workflow (Sprint 5), and Shopify write/sync execution (Sprint 4).

## Shipment contract

A Shipment is a supplier delivery lot. It has a StockHub-generated immutable ID, authenticated shop ownership, reference type and original reference value, issuer (carrier or supplier), and status `OPEN`, `RECEIVING`, or `CLOSED`. Expected SKU/quantities and notes are optional.

A Shipment can have multiple Receipts, including Receipts at different Locations. A closed Shipment cannot accept a new Receipt until explicitly reopened. Reopen requires a reason and creates an append-only event; prior closure history is retained.

Duplicate reference checks are scoped by shop, reference type, issuer, and controlled normalized reference value. Preserve original display text. A match must not silently create or merge a Shipment; reused supplier references require explicit exception resolution.

Expected quantity may be unknown (`null`). Unknown is not zero and must not imply completion. The merchant may close a Shipment without expected quantities.

## Receipt and quantities

A Receipt is one physical receiving event and belongs to exactly one Shipment, one shop, and exactly one Shopify Location. It records its source/import references, physical receiving time, received items, inspection decisions, confirmation state, and prepared inventory-operation references.

For identified/countable goods: `Received = Accepted + Damaged + On Hold`. Wrong Items are separately recorded physical lines/exceptions and must not be folded into the expected SKU line. No quantity may be negative or fractional in the MVP.

Only Accepted quantity may become a future Shopify Available adjustment. Damaged, Wrong Item, and On Hold quantities remain StockHub records and are never included in the proposed Shopify delta. Damaged goods are not automatically represented in Shopify inventory.

## CSV import and matching

Support Expected Goods and Received Goods as explicitly distinct modes. Minimum input is SKU plus quantity. Extended columns may include product name/group code, size, color, price, and barcode. Preserve original values and source row numbers. Column mappings may be suggested or manually overridden; unused columns can be ignored. Mapping templates are out of scope.

File-level parse/mapping uncertainty blocks the file. Row-level validation/matching errors permit Partial Import: valid rows continue, while invalid rows remain linked to the import attempt and Shipment/Receipt context with source values, row number, error reason, and later review state. Errors must not disappear or trigger Shopify writes.

Match only within the authenticated shop. Outcomes include existing variant, proposed new variant/product, needs review, or blocked. Ambiguous SKU/variant matches never auto-select the first result. Existing product title/price are not silently rewritten. New Product/Variant decisions require user confirmation; Sprints 1–3 prepare proposals only and do not create Shopify products or variants.

Duplicate SKU source rows may be merged only after explicit user decision and only when their target and product data do not conflict; preserve original rows. Same SKU across different shipments and distinct receipts is valid. SKU is not a Shopify technical identity.

## Duplicate safety and legacy data

Submitting one form/Receipt twice must be idempotent. Retrying one future Shopify operation must never create a second adjustment. Use stable operation identity and retain auditable status. Re-uploading the same CSV produces a warning, not an automatic conclusion that it is the same physical delivery.

Existing ImportBatch/ImportLine rows are historical facts. Do not rewrite, reinterpret, resume, or mutate existing batches. In particular, `nhap_hang_001` is not a test fixture; preserve its current recorded status and associated product-operation history. New schema must be additive and migrations must be tested against a disposable temporary database only.

## Confirmation, exceptions, and Resolution boundary

Inspection must balance quantities before confirmation. `Mark All Accepted` is an intentional user action, not an upload default, and excludes blocked/unmatched rows. Wrong Items have a separate actual description, quantity, reason, optional suspected SKU, and hold/return decision.

After confirmation, receipt source/count data is immutable. Double/concurrent confirm creates one confirmation and one set of future operations. Corrections to confirmed receipts belong to a future Resolution/Adjustment linked to the original Receipt, never a new Receipt unless new goods physically arrived. Preserve source Receipt quantities and do not count them again.

Shipment closure ends receiving only. Open exceptions, uncertain Shopify outcomes, and operation history remain visible. Closure does not erase history, auto-resolve issues, mark operations synced, or retry Shopify writes. Draft Receipts must be processed or validly cancelled, counted items classified, and material discrepancies given reasons before close.

## Shopify inventory boundary (Sprint 1–3)

Shopify authentication and per-shop authorization remain mandatory. Current inventory may be read for preview when authorized. Sprints 1–3 must not execute inventory mutations, product/variant creation, activation, retries, or historical Merge/Resume actions. Prepared operations retain shop, Receipt/source line, target variant/inventory item, exactly one Location, accepted delta, stable identity, and an explicitly pending/not-executed status. UI must state that Shopify sync is pending/not enabled and must not claim success.

No scope changes, app deployment/config changes, or permission changes are included. No live Shopify mutation, DB migration against the existing `prisma/dev.sqlite`, data reset, commit, push, or deploy is authorized.

## Deferred workflows

- Sprint 4: execute approved Shopify product/inventory synchronization with idempotent operation handling.
- Sprint 5: complete exception resolution and immutable post-confirmation Resolution/Adjustment UI.
- Later: multi-store, staff permissions, barcode workflows, integrations, supplier returns/refunds, advanced purchasing.
