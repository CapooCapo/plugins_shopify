# Catalog Change Review Contract (PR-05A)

This is a read-only preview of confirmed Catalog Draft product groups against the authenticated Shopify Admin catalog. It does not create, update, delete, or adjust inventory.

## Matching and outcomes

- SKU comparison trims surrounding whitespace but remains case-sensitive; Shopify SKU is not treated as globally unique.
- No exact SKU match proposes `CREATE`; same-title candidates without exact SKU identity are `CONFLICT`.
- One exact match is an `UPDATE` candidate only after the product title identity agrees.
- Duplicate exact SKU matches, a group whose matches span multiple products, or a duplicate option combination are `CONFLICT`.
- A group with a new compatible Size/Color combination on an existing product proposes a reviewed variant addition. Unsupported/inconsistent option structure is `CONFLICT`.
- Unconfirmed groups are `SKIP` and never execution-eligible. Quality and change disposition remain separate values.
- No proposal is execution-eligible in PR-05A. A future executor must compare again immediately before mutation.

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
- The client preview includes draft version, snapshot time, and SHA-256 fingerprint of the deterministically sorted snapshot. The route checks the version before and after the Shopify read to reject concurrent draft changes.
- Merchant “accept proposal”/“skip proposal” choices are in-memory UI state only and do not enable execution.

## Verification limitations

Live OAuth/Admin API verification was attempted against the linked development store but token retrieval timed out. No live verification is claimed; local route tests use authenticated-session and Shopify GraphQL mocks. PR-05B must add durable decision storage/recovery as needed and a fresh-state compare gate before any future write workflow.
