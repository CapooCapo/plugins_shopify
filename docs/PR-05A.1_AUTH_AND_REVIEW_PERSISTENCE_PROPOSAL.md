# StockHub PR-05A.1 — Authentication Findings & Review Persistence Proposal

**Status:** review proposal only. No schema migration has been applied or created under `prisma/migrations/` for this proposal.

## 1. Authentication findings

### Application implementation inspected

- `app/shopify.server.ts` uses Shopify's supported `@shopify/shopify-app-react-router` `shopifyApp()` integration, pinned in code to Admin API `2026-10`.
- It configures `authPathPrefix: "/auth"`, Prisma-backed `PrismaSessionStorage`, and Shopify's expiring offline access token support. It does not implement custom OAuth.
- `app/routes/auth.$.tsx` calls `authenticate.admin(request)` and delegates headers to Shopify's `boundary`; `app/routes/app.tsx` and the catalog routes also authenticate with `authenticate.admin`.
- The Prisma `Session` model contains the standard Shopify session fields, including access/refresh tokens. This review did not read or print any session credential values.

### App configuration and local environment

`shopify.app.toml` parses as TOML and currently declares:

- Embedded app: enabled.
- Application URL: `https://stockhub-mjnz.onrender.com`.
- Callback URL: `https://stockhub-mjnz.onrender.com/auth/callback`.
- `automatically_update_urls_on_dev = false`.
- Existing scopes include `read_products`, plus existing product/inventory write and location scopes. This task added no scope.

The checked local `.env` contains only `DATABASE_URL`; the current shell has no Shopify API environment variables, and no `shopify app dev` process was running during inspection. The configured app/callback URLs are the hosted Render URLs. Therefore a local embedded OAuth callback/runtime could not be exercised from this checkout as-is. Whether the hosted Render environment has the required variables or is healthy was not inspected.

### Store CLI authentication and exact failure boundary

At this check, `shopify store auth list` returned: **“No stores are authenticated directly with `shopify store auth`.”** This CLI authorization store is separate from the app's Prisma-backed sessions.

The preceding PR-05A attempt was recorded as a `shopify store execute` read-only query whose CLI stored-token retrieval failed with `ETIMEDOUT` **before the GraphQL request was sent**. Thus the timeout did not originate in the catalog GraphQL resolver, catalog comparison service, or a Shopify mutation. The current checkout has no CLI store authorization to reuse.

**Root-cause conclusion:** The observed failure is at the external Shopify CLI credential/session retrieval boundary, with the current environment also lacking a direct-store CLI session. Available evidence does not distinguish a transient network/Shopify CLI credential-service timeout from another credential-store/environment issue. No evidence establishes an application `authenticate.admin` defect; that app flow could not be live-exercised without an authenticated Shopify Admin session and configured runtime credentials.

The auth command that would be needed to resume live tests is:

```sh
shopify store auth --store demo-app-d0c6tdk6.myshopify.com --scopes read_products
```

It would request only `read_products` and persist an online CLI token locally; it could open Shopify authorization. It was **not run**. The Shopify CLI skill requires separate explicit confirmation before running an auth command that requests access. After authorization, the planned read-only checks are current granted scopes, `shop { myshopifyDomain }`, a minimal paginated product/variant query, then the PR-05A comparison against that same store. No mutation would be sent. Cross-shop isolation is covered locally by mocked route tests, not by a live second store.

### Live verification status

| Check | Result |
|---|---|
| App implementation uses Shopify's supported auth library | Verified by code inspection |
| App TOML syntax and configured URLs/scopes | TOML parse passed; values inspected |
| Shopify CLI direct-store session available | No — auth list is empty |
| Previous CLI token retrieval | `ETIMEDOUT` before GraphQL, per prior run result |
| Current live `authenticate.admin` route access | **Not verified** |
| Current live granted scopes and shop identity | **Not verified** |
| Live Products/Variants query and pagination | **Not verified** |
| Live cross-shop behavior | **Not verified** |
| Shopify mutations during this task | None |

## 2. Merchant review persistence proposal

### Design choice

Add one append-by-draft-version `CatalogImportReview` record per catalog group. Store the relevant Shopify snapshot and merchant field decisions as validated JSON, while indexing and constraining the tenant/batch/group/version identity relationally. This is the smallest additive model that persists all requested review information without introducing Shopify execution or changing inventory models.

Existing `CatalogImportBatch.draftVersion` is the source-data version. `reviewVersion` is an independent optimistic-concurrency token for decisions made against one comparison. Existing `CatalogImportGroup` identity is stable within a batch; the composite foreign key prevents review rows from referring to a group in another shop or batch.

### Proposed Prisma diff (not applied)

```prisma
model CatalogImportGroup {
  // Existing fields remain unchanged.
  reviewRecords CatalogImportReview[]
}

model CatalogImportReview {
  id                  String             @id
  shop                String
  batchId             String
  groupId             String
  draftVersion        Int
  reviewVersion       Int                @default(0)
  operation           String             // CREATE | UPDATE | SKIP | CONFLICT
  status              String             @default("PENDING") // PENDING | CONFIRMED | SKIPPED | CONFLICT | STALE
  snapshotFingerprint String
  snapshot            Json               // relevant product/variant fields and option relationships only
  shopifyProductId    String?
  matchedVariantIds   Json               // Shopify GIDs observed for this group; [] for no match
  decisions           Json               // validated group + per-field/per-line KEEP/APPLY/SKIP decisions
  snapshotCapturedAt  DateTime           @default(now())
  reviewedAt          DateTime?
  createdAt           DateTime           @default(now())
  updatedAt           DateTime           @updatedAt
  group               CatalogImportGroup @relation(fields: [shop, batchId, groupId], references: [shop, batchId, id], onDelete: Cascade)

  @@unique([shop, batchId, groupId, draftVersion])
  @@index([shop, batchId, draftVersion, status])
  @@index([shop, shopifyProductId])
}
```

Decision JSON should be schema-validated server-side, for example:

```json
{
  "group": "CONFIRM | SKIP",
  "productFields": {
    "title": "KEEP_CURRENT | APPLY_PROPOSED",
    "description": "KEEP_CURRENT | APPLY_PROPOSED",
    "vendor": "KEEP_CURRENT | APPLY_PROPOSED",
    "productType": "KEEP_CURRENT | APPLY_PROPOSED"
  },
  "variants": {
    "<catalogLineId>": {
      "operation": "CREATE | UPDATE | SKIP",
      "fields": {
        "sku": "KEEP_CURRENT | APPLY_PROPOSED",
        "price": "KEEP_CURRENT | APPLY_PROPOSED",
        "size": "KEEP_CURRENT | APPLY_PROPOSED",
        "color": "KEEP_CURRENT | APPLY_PROPOSED"
      }
    }
  }
}
```

No `CLEAR` decision is proposed in this iteration: current comparison behavior intentionally treats unmapped and empty values as preserve. Explicit clearing needs a separate, deliberate product decision and UI affordance.

### Proposed PostgreSQL migration SQL (review only; not applied)

```sql
CREATE TABLE "CatalogImportReview" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "draftVersion" INTEGER NOT NULL,
    "reviewVersion" INTEGER NOT NULL DEFAULT 0,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "snapshotFingerprint" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "shopifyProductId" TEXT,
    "matchedVariantIds" JSONB NOT NULL,
    "decisions" JSONB NOT NULL,
    "snapshotCapturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogImportReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogImportReview_shop_batchId_groupId_draftVersion_key"
    ON "CatalogImportReview"("shop", "batchId", "groupId", "draftVersion");
CREATE INDEX "CatalogImportReview_shop_batchId_draftVersion_status_idx"
    ON "CatalogImportReview"("shop", "batchId", "draftVersion", "status");
CREATE INDEX "CatalogImportReview_shop_shopifyProductId_idx"
    ON "CatalogImportReview"("shop", "shopifyProductId");

ALTER TABLE "CatalogImportReview"
    ADD CONSTRAINT "CatalogImportReview_shop_batchId_groupId_fkey"
    FOREIGN KEY ("shop", "batchId", "groupId")
    REFERENCES "CatalogImportGroup"("shop", "batchId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
```

### Required service behavior if approved later

1. Create the review only after a complete read-only snapshot and verified current `read_products` grant. Never store access tokens.
2. Filter all queries/mutations by `shop`, `batchId`, `groupId`, and current `draftVersion`.
3. Save decisions with compare-and-swap: update where the expected `reviewVersion`, `draftVersion`, `shop`, batch, and group match; increment `reviewVersion` atomically.
4. Any draft/group source change increments `CatalogImportBatch.draftVersion`; previous-version reviews become stale (explicit status update or derived as stale on read) and cannot be treated as confirmed.
5. Before any future execution, re-read current Shopify product/variant state and compare the relevant fingerprint. A changed/missing match invalidates confirmation and returns the group to review. Never delete existing variants or alter unspecified fields.
6. Keep this design isolated from `ImportBatch`, Inventory Merge, and inventory quantities. This proposal provides persistence only; it does not authorize execution.

## 3. Verification run for PR-05A.1

No application/database schema was changed. A temporary loopback PostgreSQL 16 database was used for the route regression test, then its container was stopped/removed. The existing `prisma/dev.sqlite` and the `.env` database were not used by that integration run.

- Full test suite: **216 passed, 0 failed, 0 skipped**.
- Focused catalog comparison/PostgreSQL tests: **11 passed, 0 failed, 0 skipped**.
- ESLint, typecheck, build, Prisma validation, and `git diff --check`: **passed**.
- Desktop/mobile screenshots and UI evidence remain fixture-based; live Shopify access was not available.

## 4. Review and safety boundary

This document is a proposal, not an applied schema change. No migration was applied for review persistence. No Shopify write mutation, inventory operation, OAuth-scope change, commit, push, or deployment occurred. The working tree already contained PR-01 through PR-05A uncommitted changes before this proposal; those were preserved.

## 5. PR-05A.2 live verification and final design review (2026-10-27)

### Shopify CLI read verification

- The explicitly approved `shopify store auth --store demo-app-d0c6tdk6.myshopify.com --scopes read_products` flow completed successfully. The CLI now lists that store as connected. No token, secret, or authorization header was printed or recorded here.
- A read-only Admin GraphQL query at API version `2026-10` returned the shop domain `demo-app-d0c6tdk6.myshopify.com` and name `demo-app`. `currentAppInstallation.accessScopes` returned `read_products` for the CLI authorization context. This is **not evidence of StockHub's own installed-app grant**.
- The same query returned the first three products and `pageInfo.hasNextPage: true`. A bounded `productVariants(first: 3)` query followed by a second request using its `endCursor` returned the next three variants and a valid next-page cursor. Both pages reported the expected shop domain. This verifies live cursor pagination over a small sample, not an exhaustive full-catalog comparison.
- The live first-page product `The Inventory Not Tracked Snowboard` had variant SKU `sku-untracked-1`, price `950`, vendor `demo-app`, and product type `snowboard`. A local dry run of `compareCatalogGroups` against that observed variant returned an exact-SKU `UPDATE` proposal with zero field changes; a candidate price of `955` yielded exactly one price diff (`950` → `955`). The comparator remains `eligible: false`; this did not invoke the embedded route or enable execution.
- All Shopify requests in this phase were GraphQL queries. No mutation or inventory operation was issued.

### Embedded app and deployment status

- Local code inspection still shows Shopify's supported `@shopify/shopify-app-react-router` authentication, `authenticate.admin(request)`, and Prisma-backed session storage; no custom OAuth implementation exists.
- `shopify.app.toml` points to `https://stockhub-mjnz.onrender.com` and its `/auth/callback`. A single bounded HTTP HEAD request to the configured Render root timed out after 20 seconds without response headers. No deployment metadata or live app version could be obtained from that request.
- No browser-control tool was available in this session to inspect an existing Shopify Admin session or open the embedded app. The CLI authorization is separate from StockHub's embedded session. Therefore **StockHub installation on the target store, deployed PR-05A code/version, `authenticate.admin` live behavior, StockHub-granted scopes, and live Products/Catalog Change Review routes remain unverified**. The CLI's `read_products` result must not be represented as StockHub's app grant.

### Persistence proposal review

The `CatalogImportReview` Prisma diff and PostgreSQL SQL above remain a review-only proposal; they match the repository's `provider = "postgresql"` datasource and existing `CatalogImportGroup` composite unique key. The design covers shop/batch/group isolation, stable group identity, draft version, Shopify product/variant IDs, snapshot plus SHA-256 fingerprint, field-level decisions, explicit confirmation/status, timestamps, and review-version compare-and-swap. No session token is stored and no inventory model/field is involved.

For a future implementation, treat a review as current only when its `shop`, `batchId`, `groupId`, and `draftVersion` all match the authenticated session and current batch/group. Save decisions in a transaction that checks the current batch draft version and performs `reviewVersion` compare-and-swap; use serializable isolation or an equivalent row-lock/conditional-write strategy so a concurrent draft edit cannot make a stale confirmation appear current. On reads, derive `STALE` whenever the review draft version differs from the current batch version; old confirmations must never be eligible. Before any later execution, re-read Shopify and compare the relevant snapshot fingerprint. Empty or unmapped values continue to preserve current Shopify fields; clearing is not proposed. Product creation/update and inventory execution remain outside this proposal.

**Approval requested:** review the Prisma diff and PostgreSQL SQL in sections 2–3 only. No Prisma schema file or migration directory was changed for this proposal, and no migration was applied. No Shopify write, deployment, commit, or push occurred. Git remains on `staging/merge-reliability` ahead of origin by one commit; the broader PR-01–05A worktree remains uncommitted and was preserved.

## 6. PR-05A.3 runtime investigation and persistence finalization (2026-10-27)

### Runtime / installation evidence

- A bounded HTTPS GET (15 second maximum) to the configured `https://stockhub-mjnz.onrender.com/` returned HTTP 200 in 0.69 seconds. Thus the earlier HEAD timeout does not establish that Render is unavailable.
- The returned page is the stock Shopify app scaffold: generic “A short heading about [your app]” copy, a shop-domain login form, and generic feature bullets. The response exposes React Router asset manifest version `b546291c`; this is a build-manifest identifier, not a source commit or proof of which PR is deployed. The response is not the StockHub UI observed in this checkout. Render deployment metadata/log access was not available, so its service/revision and whether the app is installed on the development store remain unverified.
- No browser/Admin session control is available in this session. A GET of the public root cannot verify an embedded Shopify session, Prisma session persistence, app-specific `currentAppInstallation.accessScopes`, or authenticated Catalog routes. The existing CLI grant is separate and is not substituted for app authentication.
- `shopify.app.toml` still points to the hosted Render URL/callback and retains its existing scopes. No preview config was changed. Local `.env` exposes only the `DATABASE_URL` key; its value is deliberately not included here. It points at a non-local managed PostgreSQL endpoint, so it must not be used for local smoke testing. No Shopify secrets were read. There is no prepared local OAuth/database runtime because the required app credentials and an isolated local DB URL are not available. Use a separate local PostgreSQL database and locally supplied app credentials before starting; do not copy the managed `DATABASE_URL`.
- To route Shopify CLI development preview to a local app, the exact prospective external change is to set the development preview URL to the CLI-generated HTTPS tunnel URL and add that URL's `/auth/callback` to the development app's redirect URLs. This changes the Shopify development app's preview/callback configuration, not the production TOML values. No command was run to make that change; provide the exact CLI-generated URL/diff and request approval before doing so.

### Final persistence contract (proposal only)

The Prisma and SQL proposal in sections 2–3 is retained. It adds one review row per `(shop, batchId, groupId, draftVersion)`. The existing group unique key `(shop, batchId, id)` makes the composite FK enforce all three isolation keys. The proposal intentionally does not attempt a FK to the mutable batch draft version; version validity is guarded transactionally against the batch row.

Status transitions:

```text
PENDING  -> CONFIRMED | SKIPPED | CONFLICT | STALE
CONFIRMED -> PENDING | SKIPPED | CONFLICT | STALE
SKIPPED   -> PENDING | STALE
CONFLICT  -> PENDING | STALE
STALE     -> (terminal; create a new record for the current draft version)
```

Every accepted decision/status change requires explicit merchant confirmation for `CONFIRMED`, increments `reviewVersion`, and updates `reviewedAt`. Snapshot drift or a draft version mismatch invalidates confirmation; do not silently turn `STALE` back into a current review. Group/source edits increment `CatalogImportBatch.draftVersion` in the same transaction and invalidate all older-version reviews (or derive stale on read while ensuring all write predicates reject old versions).

Decision JSON is a versioned, server-validated object: `{schemaVersion, group: CONFIRM|SKIP, productFields: {field: KEEP_CURRENT|APPLY_PROPOSED}, variants: {catalogLineId: {operation: CREATE|UPDATE|SKIP, fields: {field: KEEP_CURRENT|APPLY_PROPOSED}}}}`. Reject unknown fields/decisions, line IDs outside the group, and confirmation when conflicts/errors remain. Empty/unmapped draft values mean `KEEP_CURRENT`; there is no `CLEAR` decision.

Fingerprint only the deterministic, relevant Shopify snapshot (shop domain, product GID, product identity fields used by matching, sorted variant GIDs/SKUs/prices/options, and pagination-completeness marker). Normalize nullable values consistently, sort by stable GID, serialize canonical JSON with stable key order, and SHA-256 the UTF-8 bytes. Store the canonical snapshot and fingerprint together; capture time is informational, not part of the digest. Before any future execution, re-read the same fields and recompute the digest.

Decision save must run in a transaction: lock or conditionally update the batch row only where `(shop,id,draftVersion)` matches; conditionally update the review row where `(shop,batchId,groupId,draftVersion,reviewVersion,status)` matches the submitted expected values; increment `reviewVersion` atomically; require exactly one affected row at each step. If either compare-and-swap fails, return a conflict and reload—never overwrite newer choices. Use serializable isolation or equivalent row locks/conditional writes to serialize against draft edits. Before execution, repeat the version and Shopify fingerprint checks; persistence alone grants no write authorization.

No `CatalogImportReview` model or migration SQL was applied. This proposal does not alter the existing `prisma/schema.prisma` or any migration directory.

## 7. PR-05A.4 development environment and persistence review (2026-10-27)

### Local PostgreSQL database (created; no migrations applied)

Read-only inspection identified container `my-postgres-db` (`postgis/postgis:16-3.4-alpine`), healthy/running, host port `5432` published on IPv4/IPv6, backed by a named volume. Its actual default database identity is `app_db`, role `admin`; existing databases included `app_db`, `postgres`, and `stockhub_regression`. The first generic `postgres`-role probe failed because that role does not exist; no database was changed by that failed probe.

After confirming the requested target name did not exist, I created a new empty database `stockhub_pr05a_dev` using `template0`. Verification returned current database `stockhub_pr05a_dev`, role `admin`, and zero user tables. Existing databases were not reset, dropped, or modified. This is isolated at the database level inside the existing local container/volume, not a separate container or volume. Do not remove the container/volume as cleanup: it also holds the other databases.

Use a process-level override for any future local Prisma/app command; do not edit `.env` or echo credentials:

```sh
DATABASE_URL='postgresql://admin:<local-password>@127.0.0.1:5432/stockhub_pr05a_dev?schema=public' <local-command>
```

The placeholder must be supplied from the local secret source; no password was printed or recorded. Shell-exported `DATABASE_URL` must override the managed URL loaded from `.env`. The local PostgreSQL role's TCP password/authentication was not tested, so host connectivity remains unverified. No Prisma command using either database was run and no migration was applied.

### Separate development Shopify app/config proposal

`shopify.app.toml` is currently the only `shopify.app*.toml`. `.shopify/project.json` associates its current client ID with `demo-app-d0c6tdk6.myshopify.com`; this establishes the existing project/store association, not whether the app is installed. No separate development app client ID or named development config is present. Do not reuse the production-associated client ID as a supposedly isolated app. The Shopify CLI is version `4.9.4`; local `shopify help app dev --json` confirms `--config`, `--client-id`, `--store`, and `--no-update` flags. No dev command was started.

Proposed future `shopify.app.development.toml` template (not written or CLI-validated because the separate development app ID and tunnel URL are not yet known):

```toml
client_id = "<SEPARATE_DEVELOPMENT_APP_CLIENT_ID>"
name = "stockhub-development"
application_url = "https://<SHOPIFY_CLI_TUNNEL_HOST>"
embedded = true

[build]
automatically_update_urls_on_dev = false

[access_scopes]
scopes = "read_products"

[auth]
redirect_urls = ["https://<SHOPIFY_CLI_TUNNEL_HOST>/auth/callback"]
```

The scope is limited to `read_products` for the planned read-only comparison; it is not a request to alter the existing app's scopes. Existing app code reads `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL`, and `DATABASE_URL`; `SHOP_CUSTOM_DOMAIN` is optional and unnecessary for the target `.myshopify.com` store. For the dev run, the first four must correspond to the separate development app/tunnel; `DATABASE_URL` must point only to `stockhub_pr05a_dev`. Supply credentials through the CLI's app environment/secret store and process environment, never commit them or copy them into this doc. Authentication callback path is `/auth/callback` because `authPathPrefix` is `/auth`.

The exact URL cannot be supplied until a Shopify CLI tunnel is generated. Expected remote changes are: development app application/preview URL becomes `https://<generated-tunnel-host>` and its allowed redirect URL includes `https://<generated-tunnel-host>/auth/callback`. Because `automatically_update_urls_on_dev = false`, do not assume the CLI changes remote config silently. Show the concrete tunnel URL and exact diff, then obtain approval before running anything that updates the development app preview/callback. Do not touch the current production app URL/callback. Installing the dev app also requires separate approval.

### Persistence review findings / required adjustments before migration approval

- **Composite isolation:** `(shop,batchId,groupId)` correctly references the existing unique key on `CatalogImportGroup`; the database enforces the group tenant/batch relationship. There is intentionally no FK to mutable `draftVersion`; every service write must compare the review and current batch version in one transaction. A direct SQL writer could otherwise leave stale rows.
- **Cascade risk:** proposed `ON DELETE CASCADE` means deleting a group or batch erases its saved merchant decision/snapshot. Current grouping workflows soft-supersede groups, but the route supports hard deletion of an import batch. Confirm that deleting a draft is meant to erase review history; otherwise use soft-delete/retention or `RESTRICT` and provide a reviewed retention path. This behavior is a human policy decision, not safely inferred.
- **Immutable identity:** proposed `ON UPDATE CASCADE` propagates shop/batch/group key changes. Those identities should be immutable; prefer `ON UPDATE RESTRICT`/`NO ACTION` in the eventual SQL.
- **Enum/JSON constraints:** Prisma `String` fields and JSON alone do not constrain operation/status/decision values. Add SQL `CHECK` constraints for allowed operation/status values and nonnegative versions; validate JSON shape, group member line IDs, and allowed field keys in the service. Consider SQL JSON-type/shape checks for `snapshot`, `matchedVariantIds`, and `decisions`. A SHA-256 digest should be validated as 64 lowercase hex characters by service or DB check.
- **CAS/staleness:** transaction predicates in section 6 must include authenticated `shop`, batch/group identity, expected draft and review versions, and allowed source status; require one affected row. On batch source edit/deletion, stale confirmations must cease being actionable in the same transaction. Before any future write, repeat the Shopify read/fingerprint check. These are service invariants, not guaranteed by the currently proposed DDL.
- The proposed table has no inventory fields/FKs, and its migration does not modify inventory tables. JSON decision/audit data is not token storage.

### Git / regression safety inventory

The checkout is on `staging/merge-reliability`, ahead of origin by one commit. The pre-existing worktree contains the PR-01–05A WIP and extensive screenshot/harness artifacts; no Git cleanup or migration was run. File-family inventory from `git status`:

- Shared UI/import flows: modified dashboard/products components, app/import/history routes, CSS, CSV and import-merge utilities, and associated existing tests.
- Catalog PR-05A work: untracked catalog import routes/utilities, contracts/design docs, catalog tests and visual fixtures/screenshots.
- Prisma/catalog groundwork: modified `prisma/schema.prisma` and two untracked catalog-import/grouping migration directories. The `CatalogImportReview` diff is **not** in these files; it remains in this document only.
- Receiving/shipment removals: multiple tracked route/service/test files are marked deleted. These are pre-existing user changes and were left untouched.
- `.agents/` contains untracked skill material and eval artifacts; untouched.

Likely overlap surfaces are `prisma/schema.prisma` plus both catalog migration directories; `app/routes/app.imports*` and `app/styles/stockhub.css`; and `scripts/run-tests.mjs`, import regression tests, and visual-harness fixtures. Git reports roughly 100 changed/untracked entries (including many generated screenshots). PR-by-PR ownership cannot be reliably mapped from Git state alone; no per-PR commit separation exists in this checkout. The exact migration application state of the pre-existing catalog migrations was not queried, to avoid touching any DB.

No Shopify app config was created/linked/installed or changed, no `shopify app dev` was run, no migration was applied, and no commit/push/deployment occurred. The only new non-Git artifact this step created is the empty local database `stockhub_pr05a_dev`; this doc update records its identity and the proposals above.
