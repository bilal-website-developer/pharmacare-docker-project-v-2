# Pharma Care Security Audit

- **Date:** 2026-10-14
- **Branch:** `security/label-escaping`
- **HEAD:** `a10e6ee462ee163e6bb359b71f4c2e148aba8042`
- **Scope:** Checked-out application, SQL baseline/migrations/rollbacks, Supabase Edge Function source, tests, and build output.
- **Method:** Read-only source review; static searches; local lint/tests/build/dependency audit; and review of owner-supplied live catalog/ACL results dated 2026-10-14. The assistant ran no SQL.
- **Limitations:** No live API request, deployment, authenticated browser test, or external penetration test was performed. The owner now reports running the anon-EXECUTE migration, but the three post-migration query outputs and app-test outcome were not included. Migration history, full function definitions, RLS policy definitions, and exploit testing remain unavailable. See [OWNER_QUERY_PACK.md](./OWNER_QUERY_PACK.md).

## Executive result

The source includes meaningful authorization controls: the browser uses the public Supabase URL/anon-key variables; session restoration checks the authenticated user and active, non-deleted profile; sale and return write paths are server RPCs; and the `manage-users` Edge Function validates a bearer token and its caller's active profile/permission before administrative operations. The service-role key is read only inside the Edge Function source, not the browser client.

The largest security/compliance concern is that the actual POS checkout has no prescription capture or enforcement for medicines marked prescription-required. Earlier supplied live results resolve direct API table access for the three return tables (RLS on; anon/authenticated table privileges false), but showed anon EXECUTE on 16 SECURITY DEFINER functions and authenticated table grants whose RLS policies were not supplied. The owner reports running an anon-EXECUTE migration, but no post-migration query output was included, so DB-06 remains open; the effect of the prior grants is not known. Two timestamped rollback scripts also sit in the forward migration directory; whether they were applied is unknown without migration history.

### Findings

| # | Severity | Status | File | Lines | Finding | Confidence |
|---|----------|--------|------|-------|---------|------------|
| 1 | 🔴 HIGH | STILL-OPEN | `src/components/POSBillingView.tsx`; `supabase/migrations/20261013160000_persist_sales_and_returns.sql` | POS checkout; `post_sale` | No prescription data or server-side prescription-required check is present in the active POS sale path. | 9/10 |
| 2 | 🟡 MEDIUM | VERIFIED-LIVE | `supabase/migrations/20261013160000_persist_sales_and_returns.sql` | 36-87 | Creation migration omits explicit RLS/grants, but supplied live results show RLS on and anon/authenticated CRUD privileges false for all three return tables. | 10/10 |
| 3 | 🔴 HIGH | STILL-OPEN | Live public function ACLs | See DB-06 in `DATABASE_AUDIT.md` | Earlier results showed anon EXECUTE true for 16 SECURITY DEFINER functions; owner reports running a migration, but post-migration query output was not provided. | 10/10 |
| 4 | 🟡 MEDIUM | NOT-VERIFIED | Live public table ACLs/RLS | See DB-07 in `DATABASE_AUDIT.md` | Authenticated has direct SELECT and/or DML privileges on several tables; RLS is on, but policy and column grants are unreviewed. | 9/10 |
| 5 | ⚪ LOW | STILL-OPEN | `src/components/RepositoryReviewView.tsx` | 23-37, 423-467 | Dormant GitHub-token helper builds and displays/copies a command embedding the token in a persistent Git remote URL. The component has no import/reference in the current app. | 9/10 |

### Verification method for each finding

No vulnerability finding was confirmed by executing an exploit or making a live request. Live grant facts below are from owner-supplied query output; they establish execute/table privilege metadata, not whether anonymous calls succeed past function guards or which rows/columns authenticated users can reach.

| Finding | Method | What was actually verified |
|---------|--------|----------------------------|
| SEC-01 | Read code/migration | Traced the active POS component, catalog shape, and `post_sale` signature/body; no prescription fields or `requires_prescription` enforcement appeared in that path. No sale attempt was made. |
| SEC-02 | Read migration; owner-supplied live query | Migration has no explicit setup; live output shows all three return tables RLS-on and anon/authenticated CRUD false. |
| SEC-03 | Read code and app references | Inspected the token input, component state, generated command/copy handlers, and searched for app imports/references. No token was entered, copied, or persisted, and the component was not rendered. |
| SEC-04 | Earlier owner-supplied live ACL query; post-migration output missing | Earlier output showed anon EXECUTE true for 16 SECURITY DEFINER functions. Owner reports running a migration, but no post-migration query or app-test result was supplied; function guards and anonymous call results remain untested. |
| SEC-05 | Owner-supplied live table ACL/RLS query | Authenticated table privileges are true for several business tables and RLS is on; policy definitions and column privileges were not supplied, so effective access is unresolved. |

### Positive controls and related hardening

- `src/utils/auth.ts` rejects a missing, disabled, deleted, or invalid-role profile after Supabase Auth identifies the user. `src/App.tsx` rechecks the profile periodically. UI permission checks are useful navigation controls, but are not treated as the authorization boundary.
- `supabase/functions/manage-users/index.ts` checks the bearer token and profile authorization server-side before using Auth Admin. Its service-role credential comes from Edge Function environment configuration. CORS currently allows `*`; the function still authenticates and authorizes requests, but production origin restriction is a reasonable hardening item.
- `post_sale` requires an active profile and `pos` permission and its returned item shape sets `costPaisaPerUnit` to `null`. `stock_alerts_summary` contains only stock/name/reorder fields and no cost, MRP, supplier, or cost-derived values. The supplied current ACL result reports anon EXECUTE false for the listed sales/return functions and stock alert summary. It reports anon EXECUTE true for the separate functions listed under SEC-04; their authorization guards need immediate live review.
- Label and receipt HTML paths use escaping helpers, and receipt tests include hostile text/attribute cases. The earlier label-escaping fix is in the current history.
- A scan of the generated `dist` files found no source maps, service-role string, Gemini-key-prefix, or Supabase-secret-prefix matches. One JWT-shaped string is present, consistent with a public Supabase client key embedded by Vite. This narrow pattern scan is not a proof that no credential exists. `.env.local` was not opened, and no credential values were printed or written into this report.
- `npm audit --omit=dev` returned `found 0 vulnerabilities` on the audited dependency graph.
- No Content Security Policy or other hosting response-header configuration was found in the inspected application entry/build configuration. The hosting/CDN may configure headers separately; verify there.

## Detail

### SEC-01 — Prescription-required medicines can reach the active checkout without prescription proof

**Status:** `STILL-OPEN`
**Severity:** HIGH
**Evidence:** `src/App.tsx` routes the POS page to `POSBillingView`, which posts through `post_sale`. The active catalog type carries `drugClass`, but not `requiresPrescription` or prescription/doctor/patient identifiers (`src/data/posCatalogLogic.ts`, `supabase/migrations/20261013150000_pos_catalog.sql`). The `post_sale` signature and validation in `20261013160000_persist_sales_and_returns.sql` check profile/permission, sale inputs, unit conversion, prices, stock, discount, and payment, but do not require prescription evidence or check the medicine's `requires_prescription` flag. `POSScreen.tsx` contains a controlled-drug modal, but no source reference imports or renders `POSScreen`; it is not the active checkout path.

**Impact:** A staff member can potentially post a sale of a prescription-required medicine without the app recording or validating the prescription information. This is a compliance and patient-safety control gap, not a claim about local legal requirements.

**Recommendation:** Confirm the pharmacy's applicable prescription-recording rules with the owner/regulatory adviser. Enforce the rule in the sale RPC (not only the browser), include the required prescription fields in a validated, access-controlled audit record, and provide a safe correction/exception workflow. Test direct RPC attempts as well as the UI. No code or database change was made during this audit.

### SEC-02 — Return tables do not declare their own RLS/ACL policy

**Status:** `VERIFIED-LIVE`
**Severity:** MEDIUM (migration does not declare the protection explicitly)
**Evidence:** The return migration creates `return_policy_settings`, `sale_returns`, and `sale_return_items` without `ENABLE ROW LEVEL SECURITY` or explicit `GRANT`/`REVOKE` statements. The earlier `20261012141000_revoke_authenticated_table_dml.sql` lists only older tables. Earlier lockdown migrations revoke default grants for selected creator roles, which may protect the new tables if those migrations were applied and the return tables were created by one of those roles. The checked-in code does not prove the live object owner/default ACL.

**Live result:** Owner-supplied output shows RLS enabled (not forced) and anon/authenticated SELECT/INSERT/UPDATE/DELETE all false for the three tables. Thus direct access by those API roles is absent in the supplied result. This does not assess function-mediated access or migration history.

**Recommendation:** Preserve the verified RPC-only access and consider declaring RLS/revokes explicitly for maintainability. Continue reviewing each SECURITY DEFINER function separately.

### SEC-04 — Anonymous EXECUTE is enabled on SECURITY DEFINER functions

**Status:** `STILL-OPEN`
**Severity:** HIGH until the exposed function bodies are reviewed

The earlier supplied live function ACL output reports anon EXECUTE true for `deactivate_supplier`, `has_any_permission`, `is_admin`, `is_staff`, `master_data_overview`, `post_purchase`, `purchase_catalog`, `purchase_detail`, `purchase_history`, `save_supplier`, `stock_adjustments_log`, `stock_batches_list`, `stock_expiry_buckets`, `stock_overview_stats`, `void_purchase`, and `write_off_expired_batch`. These 16 functions are marked `SECURITY DEFINER`. It also reports anon EXECUTE true for non-definer `ean13_check_digit`. The listed sale/return functions and `stock_alerts_summary` report anon EXECUTE false. The owner subsequently reports running an anon-EXECUTE migration, but did not provide the post-migration query outputs.

**Verification rule:** Mark this finding `VERIFIED-LIVE-FIXED` only after the first post-migration query returns no rows. That result was not included, so the prior exposure is not verified fixed. The ACL output alone does not prove a data read/write succeeds; function bodies, profile/permission guards, fixed `search_path`, and anonymous call behavior were not provided.

**Recommendation:** Before real customer data, confirm the query result is empty, inspect every affected live definition, verify guards/settings, and test denied anonymous calls in staging. Do not infer safety from RLS on the underlying tables.

### SEC-05 — Authenticated table privileges have unreviewed policies

**Status:** `NOT-VERIFIED`
**Severity:** MEDIUM; resolve before customer data

The supplied output reports authenticated SELECT and/or DML privileges for `audit_logs`, `brands`, `categories`, `customers`, `khata_entries`, `medicine_units`, `medicines`, `print_requests`, `profiles`, `sale_payments`, `sales`, `stock_movements`, `supplier_ledger`, and `suppliers`. RLS is enabled but not forced. Policy definitions and column privileges were not supplied, so the effective role boundary is unknown. In particular, authenticated SELECT on `medicines` does not establish that cashier users are prevented from selecting cost fields.

**Recommendation:** Inventory RLS policies and column-level grants for every listed table; directly test customer and cost-field reads and business-table writes as each role. Keep sensitive mutations behind permission-checked RPCs.

### SEC-03 — Unreachable token-to-Git-command helper can expose a user-entered PAT if used

**Status:** `STILL-OPEN`
**Severity:** LOW (latent)
**Reachability:** No import/reference to `RepositoryReviewView` was found in the active `src` app tree, so it is not reachable through the current app navigation.

**Token handling:** If rendered, the component explicitly asks the user for a GitHub Personal Access Token in a password input. The inspected component holds it in React component state (`userToken`); it does not write that value to `localStorage`, `sessionStorage`, a database, or an application API. It interpolates the token into a command shown on screen and copied to the clipboard. If a user runs `git remote set-url`, Git stores the credential-bearing remote URL in `.git/config`; clipboard managers or shell history may also retain it. No token was entered or persisted during this audit.

**Evidence:** `RepositoryReviewView.tsx` builds and displays/copies the command. A nearby UI statement says the token is not transmitted, but running the command directs Git to authenticate to GitHub. No import or use of `RepositoryReviewView` was found in `src`.

**Impact:** There is no evidence this UI is reachable in the current application. If it is wired into a route later, a user may expose a broad-scope PAT locally or in support screenshots.

**Recommendation:** Do not wire this component into the app in its current form. Since it is unreferenced, delete the dead component if its feature is not intentionally retained; otherwise remove the token field and credential-bearing command before any future use, replacing it with Git Credential Manager / `gh auth login`. If a real token was ever entered and the command was run, revoke it through GitHub.

## What this audit does not certify

- Live grants/RLS facts are owner-supplied and not independently queried; function behavior and policy effectiveness remain unverified.
- No review of Supabase Auth provider settings, MFA enforcement, backups/restore, network allow-lists, hosting TLS, CDN headers, or production logs.
- No test of live cashier/manager/admin accounts, direct API calls, CORS from an unrelated origin, or concurrent return requests.
- No claim that a source migration was applied merely because its file exists.
