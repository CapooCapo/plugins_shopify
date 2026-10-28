# Catalog Change Review Contract (PR-05A)

The comparison and P1 review are read-only. P2 adds a separate guarded execution action for a persisted, confirmed proposal. Creation defaults to Draft. Product/variant deletion and inventory quantity changes are never part of catalog execution.

## Matching and outcomes

- SKU comparison trims surrounding whitespace but remains case-sensitive; Shopify SKU is not treated as globally unique.
- No exact SKU match proposes `CREATE`; same-title candidates without exact SKU identity are `CONFLICT`.
- One exact match is an `UPDATE` candidate only after the product title identity agrees.
- Duplicate exact SKU matches, a group whose matches span multiple products, or a duplicate option combination are `CONFLICT`.
- A group with a new compatible Size/Color combination on an existing product proposes a reviewed variant addition. Unsupported/inconsistent option structure is `CONFLICT`.
- Unconfirmed groups are `SKIP` and never execution-eligible. Quality and change disposition remain separate values.
- The P2 executor reads the authenticated catalog again immediately before execution and requires the reviewed group's fingerprint to match. A mismatch marks the review `STALE` and sends no mutation.
- Execution requires the current `read_products` and `write_products` grant, an authenticated shop matching the explicitly pinned development store, the running API key matching the explicitly pinned Development App ID, and an explicitly enabled loopback PostgreSQL `stockhub_regression` target whose live connection identity is checked. These gates are disabled by default; Shopify CLI/Vite runtime readiness does not establish app/store identity or enable writes.
- `CatalogExecutionOperation` is unique per shop, logical review ID, and `reviewVersion`; new operation idempotency keys also include that version. A review keeps its logical ID across snapshot versions, while each operation remains pinned to the exact review version and fingerprint it represents. Tenant-scoped `CatalogExecutionItem` rows store each line's approved fields and result identity. Append-only `CatalogExecutionAttempt` rows record each allowlisted GraphQL mutation, request hash, outcome and sanitized error. Composite foreign keys prevent cross-shop/group/review/line associations; delete and update restrictions retain execution history without reattributing an old operation to a changed review.
- Create operations require a mapped CSV title plus explicit `USE_CSV` decisions for each active variant's SKU and price. They create the product as `DRAFT`, attach an app-owned operation marker, use only confirmed Size/Color option combinations, update Shopify's auto-created standalone variant to the first approved combination, and add remaining combinations with `PRESERVE_STANDALONE_VARIANT`. The executor does not delete the standalone variant or any other variant.
- Create/Update plans with more than 250 active variants are durably recorded as `CONFLICT` without mutation; split the proposal into smaller groups before execution.
- Update operations require each active CSV row to resolve to one exact current SKU in the matched product. They send only product/variant fields explicitly approved as `USE_CSV`; `KEEP_SHOPIFY`, `SKIP`, empty, unmapped and unspecified fields are not sent. A missing or ambiguous target is `CONFLICT`, never an implicit create.
- Skip and Conflict plans are durably recorded without GraphQL mutations. GraphQL mutations are limited to `productCreate`, `productUpdate`, `productVariantsBulkUpdate`, and `productVariantsBulkCreate`; the bulk APIs use non-partial behavior where supported. Product/variant deletion and inventory mutations are excluded by both code and database attempt allowlist.
- Before a mutation, an attempt is persisted as `PREPARED`. Definite Shopify `userErrors` with no returned write result become `FAILED` and can be retried after all gates and the fresh compare are rechecked. Transport failures, malformed/partial responses, or errors where acceptance is uncertain become `UNKNOWN`. Retry never blindly re-sends an unknown mutation: a read-only reconciliation checks the operation marker and resulting Draft product/variants (or explicitly approved Update values). Only a complete verified result becomes `SUCCEEDED`; missing or ambiguous results return to `UNKNOWN` with no automatic resend.
- An unknown operation must atomically claim a persisted `RECONCILING` lease before reconciliation. Catalog Safe Resume performs read-only status reconciliation only; it does not retry or send Shopify mutations. Concurrent requests that lose the compare-and-swap cannot reconcile; an expired lease returns to `UNKNOWN`, and any still-prepared attempt is marked uncertain before a later claim. An interrupted `RUNNING` operation older than five minutes is conservatively changed to `UNKNOWN` and reconciled; no mutation is resent automatically.
- The embedded review card shows operation ID, status, per-item counts, API attempt count and Shopify product ID, and offers execution, retry only for a definite failure, or reconciliation for an unknown/in-progress outcome.

## Field semantics

- A field not mapped in the uploaded CSV preserves the current Shopify value.
- A mapped but empty source value also preserves the current Shopify value; it is not interpreted as a request to clear.
- A mapped non-empty value is shown as a proposed replacement only when different from the current value.
- Explicit clearing is not offered in this PR; no value can be cleared by this comparison workflow.
- Existing Shopify variants/options are never proposed for deletion.

## Snapshot safety

- Reads use `authenticate.admin` and the app's configured Admin API version, with the authenticated shop domain verified from the Shopify `shop` query field.
- Only a GraphQL query is sent. Variant pages use cursors with 250 items per page. If Shopify reports more than 25,000 variants (the API pagination ceiling) the preview fails closed rather than misclassifying missing SKUs as Create candidates.
- Throttling receives at most two short retries; GraphQL/network failures produce a sanitized UI error.
- Each active product group and draft version has one tenant-scoped `CatalogImportReview` record with its relevant deterministic Shopify snapshot, SHA-256 fingerprint, matched IDs, persisted decisions, and independent `reviewVersion`.
- The route checks the current draft before and after the Shopify read and locks the draft row while persisting reviews or saving/confirming decisions. Draft edits and review writes therefore serialize; review writes do not increment `draftVersion`, and concurrent writes using the same `reviewVersion` admit one winner.
- Explicit confirmation verifies the current `read_products` grant and performs a fresh, read-only Admin API catalog query before opening the confirmation transaction. It derives the reviewed group's fingerprint from the persisted proposal and current draft lines, then locks the draft and compare-and-swap checks the same review version and fingerprint. If Shopify changed, confirmation is rejected, the review becomes `STALE`, and its saved decisions remain intact. Query, scope, identity, or response failures fail closed.
- A re-comparison with a changed snapshot first copies the complete prior review into tenant-scoped `CatalogImportReviewHistory`, then advances the stable logical review's `reviewVersion` into a new pending version with empty decisions. Existing execution rows remain pinned to their prior `reviewVersion` and are not rebound to the new snapshot. The loader exposes both current and archived review records; archived records are display-only/stale. Re-comparison against an unchanged, non-stale snapshot preserves current decisions.
- A fresh authenticated loader reloads saved choices and snapshot details. A record from an older `draftVersion` is displayed as stale and cannot be saved or confirmed.
- Product/variant choices distinguish keeping Shopify values from using proposed CSV values; empty and unmapped CSV fields default to keeping the current Shopify value. Unknown rows, cross-tenant reviews, malformed choices, and `CLEAR` are rejected.
- Saving choices and explicit confirmation are separate actions. Confirmation requires the current review version, an explicitly accepted group, a non-conflicting comparison, complete decisions, and no unresolved group or quality errors. Confirmation records review state only; it does not authorize or perform Shopify writes.
- Reviews are retained. A catalog draft with current or archived review history cannot be deleted, and tenant-scoped relational foreign keys use `ON DELETE RESTRICT` so cascade deletion cannot remove its audit records.
- P1 confirmation remains distinct from execution authorization; P2's separate execution action requires its own identity/scope/database gate and a matching fresh Shopify snapshot before any catalog mutation.

## Verification limitations

No real Shopify mutation or authenticated development-store execution is claimed. Local runtime readiness, mock verification, and authenticated Shopify acceptance are separate states. The execution gate remains closed until explicit Development App ID, development store, and isolated local PostgreSQL identities are configured and verified. The product/variant operations and unknown-outcome paths require mock verification and independent review; real development-store E2E remains unavailable under this local-only implementation task.
