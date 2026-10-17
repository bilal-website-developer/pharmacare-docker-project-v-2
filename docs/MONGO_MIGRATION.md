# MongoDB Migration Phase Tracker

This file tracks migration phase deliverables and verification. It does not authorize database access, deployment, data deletion, or cut-over.

## Phase status

| Phase | Deliverable | Status | Verification / gate |
|---:|---|---|---|
| 0 | Read-only source inventory | Complete, committed as `eb9dd0c` | [`MONGO_MIGRATION_INVENTORY.md`](./MONGO_MIGRATION_INVENTORY.md); source-only. Live Supabase state remains unverified. |
| 1 | Mongo collection/API design and threat model | Drafted; awaiting owner approval | [`MONGO_DESIGN.md`](./MONGO_DESIGN.md), [`MONGO_THREAT_MODEL.md`](./MONGO_THREAT_MODEL.md). No code or database changes. |
| 2 | Docker/API foundation | Local Compose startup and health verified | Mongo reports healthy, `mongo-init` exits 0, API reports healthy, web reports healthy, and the proxied health endpoint returns HTTP 200. This is local development verification, not production deployment verification. |
| 3 | Authentication and Manage Users API | Implemented locally; setup transaction exercised against Compose Mongo; installer handoff remains open | Auth/session routes, authorization middleware, policy-aligned user routes, bootstrap CLI, first-run setup API/UI, and tests are in `server/`. Setup-code generation/display by the installer and shop-PC acceptance remain open. |
| 4 | Catalog, product, and supplier API | Implemented; selected Mongo indexes verified | Per-shop code/barcode uniqueness has real replica-set coverage; full catalog CRUD/runtime acceptance and frontend cut-over remain open. |
| 5 | Purchases and stock API | Implemented; selected Mongo transactions verified | Purchase post/void rollback and competing stock adjustment paths have real replica-set coverage; full route and operational acceptance remain open. |
| 5b | Mongo replica-set verification and write idempotency | Real-Mongo suite passed locally | The latest Compose integration suite has 13 tests, 13 passed, 0 failed/skipped. This is local Docker verification, not production acceptance. Auth/session write routes remain outside persisted business idempotency for the documented credential-safety reason. |
| 6 | POS sales and customer APIs | Implemented; selected Mongo transactions verified | Real replica-set tests cover sale rollback, unique customer ledger references, concurrent last-unit sale, and idempotency. Full route and operational acceptance remain open. |
| 6b | Real Mongo verification and timezone consistency | Verified in local Compose integration suite | Shop-local “today” is used through stock, expiry, alert, purchase, adjustment, write-off, and sales logic. Karachi midnight boundary tests and real Mongo transactional cases pass; this is not production acceptance. |
| 7 | Returns, voids, print requests, settings, expenses, cash book, reports, dashboard, audit-log read | Implemented; targeted Mongo tests passed | `server/src/phase7-routes.ts`; transactional business writes, role-safe aggregates, and admin/`manage_users`-gated `/api/audit-logs` with shop scope and an allowlisted projection. Phase 8 frontend migration remains manual-acceptance pending; Supabase paths remain intact. |
| 8 | Frontend API client and module-by-module switch | API mode wired across tracked feature modules; transport-unavailable retry screen added; manual UI checks remain | Access tokens remain in memory and refresh cookies remain httpOnly; API errors are normalized; labels/receipts use allowlisted data and escaping. Supabase fallback remains. Browser acceptance and production runtime checks remain open. |
| 9 | Security hardening | Local checks complete; production security acceptance open | [`MONGO_SECURITY_REPORT.md`](./MONGO_SECURITY_REPORT.md) records source/test, audit, Compose health, and CORS evidence. This is not a penetration test. |
| 10 | Backups and production deployment | Not started | Backup/restore proof, production Compose, TLS proxy, and deployment documentation remain open. |
| 11 | Demo data and manual test plan | Not started | Demo-only seed and per-role manual test plan remain open. |
| 12 | Cut-over and Supabase cleanup | Blocked on explicit approval after all manual tests pass | Never delete `supabase/` or migrations; cut-over plan requires owner approval. |

## Autopilot step 0 — housekeeping

**Status: VERIFIED (local checks only).** In this session, branch `feature/mongo-migration` was clean before work and 29 commits ahead of its upstream; there was no earlier uncommitted batch to commit. `src/App.tsx` contains API-mode shell wiring; `vite.config.ts` defaults to Compose API port 3000 and allows a documented host-mode override to 3001. Added `.gitattributes` rules for LF `.sh` and CRLF `.ps1` files. Current command evidence:

- `npm.cmd run lint`: exit 0.
- `npm.cmd test`: 264 tests total, 253 passed, 0 failed, 11 skipped. The root runner skips the real-Mongo integration tests.
- `npm.cmd run build`: exit 0. Existing Vite `__dirname` and large-chunk warnings remain.
- `npm.cmd --prefix server run test:security`: 9 passed, 0 failed, 0 skipped.
- `docker compose run --rm --no-deps api-test`: 11 real-Mongo integration tests passed, 0 failed, 0 skipped.
- Manual UI tests and production checks remain outstanding.

## Autopilot step 1 — Mongo initialization and local Compose health

**Status: VERIFIED (local development stack only).** Root cause: Mongo users are created in the application database, but the application client's connection URI incorrectly specified `authSource=admin`. The initializer now authenticates that client against its application database; root initialization continues to authenticate against `admin`.

- Current-session rerun: `docker compose build mongo-init` succeeded. `docker compose up --no-deps --force-recreate mongo-init` logged `replica_set_and_app_user_ready` and `application_indexes_ready`, then exited 0.
- `docker compose up --detach --build api web` completed; `docker compose ps --all` showed Mongo healthy, mongo-init Exited (0), API healthy, and web healthy.
- `curl.exe --silent --show-error --include http://localhost:8080/api/health` returned HTTP 200 with `{"status":"ok","database":"ok"}`.
- No volumes were removed or reset. No environment values were printed.
- `docker compose build mongo-init` completed successfully.
- `npm --prefix server run lint` and `npm --prefix server run build` passed. `npm --prefix server test` reported 65 tests: 58 passed, 0 failed, 7 skipped (the real-Mongo integration tests are exercised in step 2).
- `docker compose up --no-deps --force-recreate mongo-init` logged `replica_set_and_app_user_ready` and `application_indexes_ready`, then exited with code 0.
- `docker compose up --detach --build api web` completed. `docker compose ps -a` showed Mongo healthy, mongo-init Exited (0), API healthy, and web healthy.
- `curl.exe --silent --show-error --include http://localhost:8080/api/health` returned HTTP 200 and `{"status":"ok","database":"ok"}`.
- The initial safe diagnostic captured the failing `connecting to Mongo as application user` step with Mongo code 18 / `AuthenticationFailed` and a generic errmsg; no URI or environment values were logged.
- No volumes were deleted or reset. Business transaction behavior still depends on the real-Mongo integration tests in step 2.

## Autopilot step 2 — replica-set tests and write invariants

**Status: VERIFIED (local Docker replica set; not production).** The current `docker compose run --build --rm api-test` run reported 11 tests, 11 passed, 0 failed, 0 skipped. It exercised sale/purchase transaction rollback, distinct customer ledger references, concurrent last-unit sale, per-shop unique indexes, competing stock adjustments, idempotent replay, return/cash reconciliation, expense/settings/print/sale-void persistence, and the product-cost shop-timezone expiry boundary.

- Transaction callbacks returning `undefined` were incorrectly treated as absent results; valid callbacks now preserve their completion independently of their value.
- Purchase void passed a valid negative Int64 payable delta through a nonnegative-only converter; signed Int64 bounds are now applied to the decrement.
- The expected stock-concurrency conflict response was sent without being returned from its async route, which caused Fastify to log a duplicate-send error. The response helper now returns the reply. A later full integration run passed with no duplicate-send warning.
- This run's first attempt found an incorrect expected drawer total in the integration test. Because the expense date had been moved to an earlier day, voiding it creates a current-day cash inflow; the test now verifies inflow 1250, outflow 650, and expected drawer 600 paisa, matching the persisted entries.

Authenticated business writes use a per-shop/route/key-hash idempotency record with a 24-hour expiry, including self-service password changes. A route-by-route review found business mutation routes use `requireAuth` with the Mongo idempotency store. Auth login, refresh, and logout are intentionally excluded because their responses/cookie side effects involve credentials; see `docs/MONGO_DECISIONS.md`. The known crash window remains: after the business transaction commits but before the idempotency response is stored, a retry remains blocked until the record expires but cannot replay the response.

Stock status refresh, stock batches, expiry buckets, stock alerts, sales, and product latest-cost expiry filtering use the authenticated shop's timezone (default `Asia/Karachi`). Unit coverage checks 18:59:59.999Z and 19:00:00.000Z; the Compose integration test also verifies product cost lookup across that boundary. `docs/OWNER_STEPS.md` contains the owner-run PowerShell commands to create the initial shop and super-admin interactively without exposing the password.

Validation after the current fixes: `npm.cmd run lint` passed; `npm.cmd test` reported 244 tests, 233 passed, 0 failed, 11 skipped (the real-Mongo cases are skipped by the non-Compose runner); `npm.cmd run build` passed with the existing Vite `__dirname` and large-chunk warnings. The separately invoked Compose integration suite passed all 11 tests with 0 skips.
- `docker compose up --detach --build api` rebuilt/restarted the API on the updated source. After startup, `docker compose ps --all` showed Mongo, API, and web healthy and mongo-init Exited (0); the proxied `/api/health` returned HTTP 200 with database `ok`. The initial request during API startup returned 502; the health check and retry after startup passed.

## Phase 1 verification and open items

- Design documents specify collection fields/types, per-shop indexes, transaction boundaries, numbering, role/permission requirements, endpoint contracts, DTO redaction, and the requested top 15 threats/controls.
- No API, MongoDB collection/index, Docker service, Supabase migration, or application code was created or changed.
- Design decisions still requiring approval are listed in `MONGO_DESIGN.md`, especially sale-void policy, purchase-void authorization, naming uniqueness, prescription evidence/retention, external cash refund settlement, user cap/return defaults, and role defaults.
- Frontend `npm run lint`, `npm test` (18 scripts, 122 tests), and `npm run build` passed on the unchanged application baseline; the build reports existing Vite `__dirname` and large-chunk warnings. These checks do not exercise or verify the proposed API, database, Docker, or threat controls.
- No live database checks, container checks, or threat-control implementation have been performed for this documentation phase.

## Phase 2 status

- Added a replica-set MongoDB service with keyfile authentication, root credentials from `.env`, no published Mongo port, named data volume, and healthcheck.
- Added a one-shot initializer for replica set setup, app-only `readWrite` user, and shop-scoped indexes; API health-only skeleton; Nginx web proxy; and PowerShell secret generator. Existing Supabase frontend code remains unchanged.
- Local `npm run lint`, `npm test` (126 tests across 20 test files), and `npm run build` passed. `npm audit --prefix server` reported zero vulnerabilities; `docker compose config --quiet` passed with fake process-only values; and the secret-generator PowerShell syntax parse passed. The frontend build still reports its pre-existing Vite `__dirname` and large-chunk warnings.
- No Docker image was built and no container was started. Mongo replica-set/auth initialization, container networking, Nginx proxying, and the HTTP health response remain unverified until the owner runs Compose and supplies output. Do not claim Docker works before that verification.

## Phase 3 status

- Implemented Mongo-backed login, refresh rotation/reuse detection, logout, `/me`, access-token authentication, role/permission checks, user list/create/update/delete/restore/reset-password routes, Manage Users policy safeguards, audit/trash records, and an interactive `seed:superadmin` command. The command refuses to bootstrap a shop that already has users and persists only an Argon2id hash.
- API DTOs are built from explicit field allowlists; login failures are generic; refresh tokens are stored as keyed hashes; user writes and corresponding audit events use Mongo transactions. Shop scope comes from the authenticated user, not request input.
- `npm run lint`, `npm test` (152 tests across frontend and API), and `npm run build` passed locally; `npm audit --prefix server` reported 0 vulnerabilities. The Vite build emitted the existing `__dirname` and large-chunk warnings. Route tests use an in-memory repository and do not prove Mongo transaction/runtime behavior.
- No Compose container, live database, or deployment was run. Owner-run Docker health/auth checks remain open. Existing React screens continue to use Supabase; cut-over is not part of this phase.

## Phase 4 status

- Implemented shop-scoped CRUD, paging/search/filter/sort, and allowlisted DTOs for categories, brands, medicines, medicine units, and suppliers. Soft-delete/restore writes trash history and audit events; barcode assignment uses EAN-13 and a shared per-shop claim registry; bounded product CSV import reports row errors and export redacts cost for callers without cost access.
- Mongo index initialization now includes per-shop normalized medicine-name and medicine-unit-name uniqueness. `medicineUnits` is a separate collection (rather than the embedded units in the original proposal) to support requested independent CRUD, barcode ownership, and per-medicine uniqueness; see `MONGO_DESIGN.md`.
- Local root lint, complete tests, and frontend/API build pass. The focused catalog suite covers input validation, duplicate handling, cost DTO/CSV filtering, CSV row errors, soft-delete/restore, and concurrent barcode assignment. Frontend build retains the existing `__dirname` and large-chunk warnings.
- No MongoDB container, live database, or Docker Compose runtime was used. Transaction behavior, installed indexes, and network/runtime behavior remain unverified pending owner-run Docker checks; this phase does not cut over the Supabase frontend.

## Phase 5 status

- Implemented purchase catalog/history/detail, purchase posting and guarded voiding, stock overview/expiry buckets/batches/adjustment log, stock adjustment, expired-batch write-off, and permission-gated stock-alert summaries. Business reads use the authenticated user's shop ID; DTOs are allowlisted, and cost-bearing fields are omitted unless role-and-permission policy allows them.
- Mongo purchase, void, adjustment, and write-off mutations use one Mongo session transaction for their stock/supplier/ledger/cash-book/audit writes. Purchase numbering uses an atomic per-shop counter in that transaction; sequential uniqueness is promised, not gap-free numbering. Purchase void is restricted to Admin/Super Admin with `purchases` and is rejected after any post-receipt movement or quantity change.
- Stock statuses are lazily refreshed on stock overview, expiry-bucket, and batch reads. The current expiry-day boundary is UTC; `NEAR_EXPIRY` means through 90 days inclusive. Purchase expiry must be after the purchase date; negative stock and writing off non-expired batches are rejected.
- Local tests use the in-memory repository, including injected mid-write failure/rollback simulation. They do not exercise a Mongo replica set or prove server transaction rollback, installed indexes, or API/container runtime behavior. Docker was not started and no live database was accessed. Owner-run Docker/HTTP proof remains required; Supabase frontend paths are unchanged.
- Root `npm run lint`, `npm test`, and `npm run build` passed. The build retains existing Vite `__dirname` and large-chunk warnings.
- Phase 5b adds required `Idempotency-Key` headers to authenticated write routes, scoped by authenticated shop and route. Only a SHA-256 hash of the key is stored; successful response status/body are retained for 24 hours and replayed for a matching request. Reusing a key with a different request or while its first request is processing returns a generic conflict. Failed responses release the reservation. Login, refresh, and logout are excluded because they involve credential responses or cookie side effects; other authenticated writes, including password changes, use the store.
- `mongo-init` removes the obsolete `shop_idempotency_unique` index before creating the new shop/route/key-hash unique index. Existing records are not deleted.
- Idempotency reservation/completion currently brackets, but is not part of, the business Mongo transaction. A process failure after a business transaction commits but before its response is saved leaves the key in `PROCESSING` until its 24-hour expiry; retry is denied rather than re-executed, but the original response cannot be replayed. This crash window must be closed before production write traffic.
- `server/integration/mongo.integration.mjs` contains replica-set integration tests for mid-transaction purchase post/void rollback, per-shop code/barcode uniqueness, competing stock adjustments, and successful idempotency replay. Run `docker compose run --rm api npm run test:mongo-integration` after rebuilding the API image and applying `mongo-init`. `npm test` includes this test file but skips its database cases when required Mongo environment variables are not configured.
- An earlier Compose test attempt failed before fixture setup because Mongo authentication was unhealthy. This blocker was later fixed without deleting any volume; see Autopilot step 1 and step 2 verification above.

## Phase 6 status

- `POST /api/sales` validates an allowlisted cart, loads current medicine/unit prices and shop timezone server-side, computes discount limits in integer paisa, requires prescription details for controlled/prescription medicines, allocates eligible stock FEFO, and writes stock, movements, sale, separate tender rows, customer credit ledger, counter, and audit in one Mongo transaction.
- Stock decrements use conditional quantity/status/expiry filters. Customer CRUD, account summary, customer payment, POS catalog, and sales history routes are permission-gated and shop-scoped. Sale/customer/history response DTOs are assembled from explicit fields; cost, profit, and margin are omitted.
- Split Cash/Card is saved as distinct payment rows. Credit requires a registered customer and is the sole payment method. `Idempotency-Key` remains required for the write routes.
- Local tests cover FEFO, last-unit concurrency using the in-memory repository, discount caps, tampered totals, rollback hooks, prescription requirements, split payment, customer ledger/payment, and cashier history redaction. The replica-set suite now also contains a real Mongo rollback-on-failure and competing-sale test; both were skipped in this run because Mongo runtime credentials were unavailable.
- This run's `npm run lint`, `npm test`, and `npm run build` completed successfully. The seven replica-set integration tests in the full test run were skipped; therefore no real Mongo sale transaction, ledger uniqueness, or oversell behavior is verified. The existing Vite `__dirname` and large-chunk warnings remain.
- Full `npm test` output: 187 tests total, 180 passed, 0 failed, 7 skipped. All seven skipped cases are the real-replica-set Mongo integration tests; they are not counted as Mongo verification.
- “Today” for sales and stock operations uses the selected shop IANA timezone, defaulting to `Asia/Karachi`. Phase 6b applies the same value to stock status refresh, overview/list/expiry buckets, stock alerts, purchase batch status, adjustments, and write-off eligibility.

## Phase 6b: run replica-set integration tests

The repository-root `.env` is read by Docker Compose automatically and is git-ignored. Do not print or paste it. The test runner receives these environment variable names from Compose: `MONGO_APP_DB`, `MONGO_APP_USERNAME`, `MONGO_APP_PASSWORD`, `JWT_ACCESS_SECRET`, and `REFRESH_TOKEN_PEPPER`. Starting Mongo/init additionally requires `MONGO_ROOT_USERNAME`, `MONGO_ROOT_PASSWORD`, and `MONGO_REPLICA_KEY`. Use the values already in the local `.env`; do not put them on the command line or in shell history.

From `E:\PHARMCYYYY` in PowerShell, run:

```powershell
docker compose up -d mongo
docker compose run --build --rm mongo-init
docker compose run --build --rm api-test
```

`api-test` uses the Node/TypeScript build stage with the integration suite included and connects to `mongo:27017` over the private Compose database network. It checks that Mongo reports replica set `rs0`; no Mongo port is published to the host. The step-2 suite passed 7/7 at that time; Phase 7 later expanded it to 9 tests. Do not remove volumes or reset credentials if startup fails; share redacted output for diagnosis.

## Expiry timezone decision

**Owner decision:** per-shop IANA timezone, defaulting to `Asia/Karachi`. Phase 6b now derives one shop-local calendar date and passes it to sale sellability, stock status refresh, stock stats, expiry buckets, stock lists, stock alerts, purchase receipt status, stock adjustments, and expired write-off checks. The boundary unit test covers Karachi midnight at 19:00 UTC. Real Mongo runtime verification remains an owner-run step above.

## Autopilot step 3 — Phase 7 business APIs

**Status: VERIFIED for the targeted local Mongo replica-set integration paths; frontend/manual acceptance remains open.** Added return policy, sale lookup and return request, manager/admin approve/reject, disposition processing and return memo DTO; sale void; persisted print request/list/count/decision/snapshot-edit/printed workflow; own-shop settings with Super Admin-only identity changes; persisted expenses and compensating cash-book entries; cash-book, sales/stock reports, and live dashboard summary.

- Multi-document changes use Mongo transactions. Return requests reserve against a sale-document version so concurrent partial requests cannot exceed sold allocation quantities; processing is single-use, and a forced duplicate cash-book insert proved returned stock/movement/status changes roll back together.
- Cash/card/credit sales and customer cash payments now produce cash-book records; return payouts are apportioned to original tender methods, cash totals include cash tender only, expense amount/date edits append compensating entries, and voids append reversals.
- Receipt request payloads use a strict allowlist, are checked against persisted sale/payment references, and use server-stored memo/receipt settings. Admin snapshot edits are audited and do not alter the sale.
- Current real-Mongo run `docker compose run --build --rm api-test`: 11 tests, 11 passed, 0 failed, 0 skipped. The return workflow case covers over-return rejection, concurrent return requests, approval, process rollback/double-process rejection, net sales after returns, cash reconciliation, cashier denial of return/expense routes, activity-only cashier dashboard output, cost-free POS catalog output, and live dashboard KPIs (net sales and sellable stock). The expense/settings/print/sale-void case verifies persisted cash inflow/outflow totals.
- Current root `npm.cmd run lint` and `npm.cmd run build` passed. `npm.cmd test` reported 244 total tests, 233 passed, 0 failed, 11 skipped (the replica-set cases are skipped by the non-Compose runner). Build retains existing Vite `__dirname` and large-chunk warnings.
- Remaining: Phase 8 must connect React screens to these APIs. Manual browser/UI tests are not yet supplied; backup/deployment and security-hardening phases are not started. The idempotency reservation/transaction crash window recorded above remains a production risk.

Implemented route paths include `/api/returns/policy`, `/api/returns/sales/:invoiceNumber`, `/api/sales/:id/returns`, `/api/returns/:id/approve|reject|process`, `/api/returns/:id/memo`, `/api/sales/:id/void`, `/api/print-requests*`, `/api/admin/print-requests*`, `/api/shop/settings`, `/api/expenses*`, `/api/cash-book`, `/api/reports/sales|stock`, and `/api/dashboard/summary`.

## Autopilot step 4 progress — Suppliers frontend module

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** `SuppliersView` now reads, creates, edits, and deactivates suppliers through the typed API adapter when `VITE_BACKEND=api`; `VITE_BACKEND=supabase` retains the Supabase implementation. Deactivation uses `PATCH isActive=false`, not the API soft-delete route, so inactive suppliers remain visible as in the existing UI. The shared API client now adds a unique `Idempotency-Key` to write requests and reuses it on an auth retry.

- Focused tests: `npm run test:suppliers` passed 3/3; `npm run test:api-client` passed 5/5.
- Full checks: `npm run lint` passed; `npm test` passed 197 tests, failed 0, skipped 9 (all Mongo replica-set integration tests are intentionally skipped outside Compose); `npm run build` passed with the existing Vite `__dirname` and large-chunk warnings.
- Manual checklist (not yet run): with `VITE_BACKEND=api`, sign in as a user with `suppliers`; verify all active and inactive suppliers load and refresh; add a supplier; edit its contact/address/licence/payment terms; deactivate it and verify it remains listed as Inactive after refresh. Then set `VITE_BACKEND=supabase` and confirm the legacy list and write behavior still works. Purchase-selection behavior should be verified after the purchase screen is migrated.
- Still open after these Step 4 batches: Trash Bin, remaining label/receipt parity checks, and manual UI acceptance.

## Autopilot step 4 progress — POS catalog adapter

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** The API branch of `loadPosCatalog()` calls `/api/pos/catalog`, validates the exact safe DTO shape (rejecting unexpected fields), and maps decimal-free paisa/base-unit strings to the existing POS catalog model only within JavaScript's safe-integer range. The response includes server-derived shop-local `today`, which the existing POS FEFO preview uses instead of the workstation date. The repository returns only active medicines with positive, unexpired `ACTIVE`/`NEAR_EXPIRY` batches and safe batch/unit fields; the real-Mongo cashier response assertion checks those keys and excludes cost/profit/margin. The Supabase fallback and POS sale submission are unchanged.

- `npm.cmd run test:pos-catalog`: passed 6/6, failed 0, skipped 0.
- `npm.cmd run lint`: passed. `npm.cmd test`: 200 tests, 191 passed, 0 failed, 9 skipped (the real-Mongo integration tests are intentionally skipped outside Compose). `npm.cmd run build`: passed with the existing Vite `__dirname` and large-chunk warnings.
- `docker compose run --build --rm api-test`: passed 9/9 real Mongo replica-set tests, failed 0, skipped 0.
- Manual checklist (not yet run): with `VITE_BACKEND=api`, sign in as a POS user; confirm sellable products and their units, prices, and remaining batches load; confirm batches are shown in FEFO order and products without sellable batches are absent; verify adding a cart item previews enough stock and that the existing server-side sale validation remains authoritative. Repeat in Supabase mode to confirm fallback behavior. Exercise controlled/prescription-required medicines separately when the POS prescription-capture UI is wired; backend refusal remains in force.
- Remaining work: migrate POS sale/billing and the remaining screens listed above; no browser/manual acceptance was performed for this adapter.

## Autopilot step 4 progress — Settings module

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** In API mode, shop identity, profile, receipt preferences, memo settings, and timezone load from `/api/shop/settings`; updates use `PATCH /api/shop/settings`. Shop identity edits remain super-admin-only, other shop settings follow the server's admin/`manage_users` policy, and non-super-admin UI fields mirror those restrictions. Settings writes use the shared API client's idempotency key and strict response validation; the Supabase/local-storage fallback remains intact. API mode caps memo number digits at the server's 16-digit limit while legacy mode retains its 20-digit UI limit.

- `npm.cmd run test:shop-settings`: passed 3/3, failed 0, skipped 0.
- Full checks: `npm.cmd run lint` passed; `npm.cmd test` reported 203 total, 194 passed, 0 failed, 9 skipped (the Mongo replica-set integration cases are skipped outside Compose); `npm.cmd run build` passed with existing Vite configuration/chunk-size warnings.
- Manual checklist (not yet run): in API mode, confirm shop identity and memo/receipt settings load from the server after refresh; as an authorized settings editor, change and save memo rounding, number digits (including 16), receipt format/template, then reload and confirm persistence; verify number digits cannot exceed 16. As a non-super-admin, confirm shop identity controls are disabled and cannot be changed. As super-admin, verify shop name/profile changes persist. Switch to Supabase mode and confirm legacy settings behavior remains unchanged.
- POS checkout now uses the POS sales API; the server owns final totals and applies persisted `roundNet` settings. No browser/manual acceptance was performed for Settings.

## Autopilot step 4 progress — POS sales and checkout

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** In API mode, POS loads its customer options from the shop-scoped `/api/pos/customers` route and submits checkout through the typed `/api/sales` adapter. The request sends identifiers, quantities, requested discount, payments, tender, and optional prescription details; the server re-reads prices, recomputes discounts and totals, applies persisted memo rounding, selects FEFO batches, and stores sale/payment/ledger/audit writes transactionally. A new validation allows signed rounding adjustments in completed-sale DTOs (nearest rounding can reduce the total). API response parsing is strict and rejects unapproved fields, including cost-bearing extras. Controlled and prescription-required medicines prompt for prescriber, patient, and reference; the API still enforces the requirement. The Supabase checkout path remains available.

- `npm.cmd run test:sales`: passed 3/3, failed 0, skipped 0. `npm.cmd run test:pos-catalog`: passed 6/6, failed 0, skipped 0. `npm.cmd --prefix server run test:sales`: passed 9/9, failed 0, skipped 0.
- `docker compose run --build --rm api-test`: passed 10/10 real Mongo replica-set tests, failed 0, skipped 0. Coverage includes server-owned rounding using persisted shop settings.
- Full root suite: 209 tests, 199 passed, 0 failed, 10 skipped (Mongo replica-set cases skipped by the non-Compose runner). Root lint and build passed; existing Vite `__dirname` and large-chunk warnings remain.
- Manual checklist (not yet run): sign in with POS permission in API mode; verify customer choices and POS catalog are loaded from the API; sell ordinary and controlled/prescription-required items; verify missing prescription details are refused and complete a sale with prescriber, patient, and reference; try cash, card, credit, and split tenders; verify discount limits and memo rounding (including a rounding reduction) match persisted shop settings after refresh; verify completed receipt/memo data reflects the server's sale result; confirm sale completion updates stock/customer balance. Repeat a representative checkout in Supabase mode to confirm its fallback remains. Manual browser acceptance has not been run.
- Still open after these Step 4 batches: Trash Bin, remaining label/receipt parity checks, and manual UI acceptance.

## Autopilot step 4 progress — Customer Ledger and accounts

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** In API mode, `loadCustomerAccountsSummary()` reads the shop-scoped `/api/customers/accounts/summary` response, validates the customer and ledger DTO allowlists, converts integer-paisa strings safely, and groups the server's flat ledger rows by customer ID for the existing screen. Customer creation uses `POST /api/customers`; recording a counter payment uses `/api/customers/:id/payments` with the existing cash workflow. These write requests use the shared API client's idempotency key. Server payment validation, balances, ledger writes, cash-book entry, and audit logging remain authoritative; the legacy Supabase RPC path remains unchanged.

- `npm.cmd run test:customer-ledger`: passed 4/4, failed 0, skipped 0. Coverage: strict summary parsing/grouping, rejection of unapproved fields, customer creation payload/idempotency, and payment payload/result parsing.
- `npm.cmd run lint`: passed. `npm.cmd test`: 213 tests, 203 passed, 0 failed, 10 skipped (Mongo replica-set cases are skipped outside Compose). `npm.cmd run build`: passed with the existing Vite `__dirname` and chunk-size warnings.
- Manual checklist (not yet run): with `VITE_BACKEND=api` and `customers` permission, confirm customer accounts and invoice/payment/return ledger rows load and running balances match; add a customer with phone, CNIC and credit limit and confirm it persists after reload; record a cash payment within the outstanding balance and verify the generated receipt, updated balance and cash-book entry; attempt a payment larger than the balance and confirm the server rejects it. Repeat account loading and creation in Supabase mode to check fallback behavior. No browser/manual acceptance was run.
- Scope note: the existing UI supports customer creation and payments, but does not expose edit/delete customer controls. The API continues to enforce those routes independently; the current UI module does not claim full CRUD coverage.

- Still open after these Step 4 batches: Trash Bin, remaining label/receipt parity checks, and manual UI acceptance.

## Autopilot step 4 progress — Sales History

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** `loadSalesHistory()` now uses the authenticated `/api/sales/history` endpoint in API mode, validates each paginated response and sale/item allowlist, supports the server's 200-row page limit, and caps the requested history at 500. The server scopes cashier results to the caller and returns no cost fields; the client rejects unexpected fields, including cost-bearing extras. Sale status is retained so voids remain visible as void, while revenue, invoice counts, and end-of-day totals exclude voided sales. The Supabase RPC path remains unchanged.

- `npm.cmd run test:sales`: passed 6/6, failed 0, skipped 0. Tests cover mapping, signed rounding, void status, two-page retrieval at the API limit, and rejection of unapproved cost fields.
- `npm.cmd run lint`: passed. `npm.cmd test`: 216 tests, 206 passed, 0 failed, 10 skipped (Mongo replica-set cases are skipped outside Compose). `npm.cmd run build`: passed with existing Vite `__dirname` and large-chunk warnings.
- Manual checklist (not yet run): in API mode with `sales_history` permission, check recent bills, split/card/credit method labels, customer/cashier names, item quantities, and totals; verify cashier only sees their own bills; void a sale and confirm it remains labeled VOID but does not count toward revenue/invoice totals or end-of-day totals; check histories beyond 200 rows fetch the next page; repeat a representative lookup in Supabase mode. No browser/manual acceptance was run.
- Limitation: the history DTO is cost-free for all roles. Existing client profit KPIs therefore remain unavailable in API mode until the dedicated role-filtered Mongo reports endpoint is wired; no cost is exposed to Cashier.

## Autopilot step 4 progress — Master Data API

**Status: VERIFIED (targeted route and adapter checks only).** `server/src/catalog-routes.ts` now exposes `/api/master-data/overview`, `/api/master-data/units`, and per-collection merge routes behind authenticated permission checks. The server route uses the shop-local tz-aware date, keeps cost visibility behind `canViewCost`, and rejects unsafe merge attempts when the caller cannot update products. The client-side adapter in `src/data/masterData.ts` validates exact DTO shapes and converts integer-paisa strings to JavaScript-safe integers without permitting cost-bearing extras. `MasterDataView.tsx` routes all overview, save, delete, and merge operations through the API when `VITE_BACKEND=api`; the Supabase path remains available for the legacy fallback.

- Verification: `npm.cmd run test:master-data-api` passed 3/3, failed 0, skipped 0; `npm.cmd --prefix server run test:catalog` passed 9/9, failed 0, skipped 0; `npm.cmd run lint` passed; `npm.cmd run build` passed with the existing Vite `__dirname` and chunk-size warnings.
- Full root-suite result: `npm.cmd test` = 220 tests, 210 passed, 0 failed, 10 skipped.
- Manual checklist (not yet run): in API mode with `categories`/`products` permissions, load the overview for categories/manufacturers, confirm low/out/expiring counts and stock values are shown without exposing cashiers to cost fields, check unit listing, create/edit a category or brand, and merge two records while confirming the products are reassigned to the target record and the source record is archived. Repeat one representative path in Supabase mode. No browser/manual acceptance was run.

## Autopilot step 4 progress — Cash Book and expense creation

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** In API mode, the Expenses/Cash Book screen now loads persisted entries from `/api/cash-book`, validates the exact safe DTO shape, pages through the response, and parses money from integer-paisa strings. Cash expense submission uses `/api/expenses` with integer paisa and a unique idempotency key; the displayed ledger refreshes from persisted data rather than optimistically inventing an entry. Legacy non-API behavior remains in memory. Expense amounts are parsed from decimal text into integer paisa without floating-point arithmetic.

- `npm.cmd run test:finance`: passed 4/4, failed 0, skipped 0. `npm.cmd --prefix server run test:business-time`: passed 3/3, failed 0, skipped 0.
- API cash-book and expense date filters now use shop-timezone calendar bounds; omitted cash-book dates default to shop-local today. Karachi midnight and a daylight-saving transition are covered by the timezone helper tests.
- `npm.cmd run lint`: passed. `npm.cmd run build`: passed; existing Vite `__dirname` and large-chunk warnings remain.
- Manual checklist (not yet run): in API mode with `expenses` permission, compare today's cash inflows/outflows and expected drawer with persisted sales, customer cash payments, returns, and expenses; submit an expense such as Rs 12.50, reload and confirm it appears exactly once; verify decimal precision, validation, and failure feedback; repeat basic viewing in Supabase mode. No browser/manual acceptance was run.

## Autopilot step 4 progress — Print Requests

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** Personal/admin lists, pending count, submit, approve/reject, audited snapshot modification, and post-print tracking now call the existing `/api/print-requests` endpoints when `VITE_BACKEND=api`. The adapter strictly validates the response allowlists and the existing Supabase path remains intact. Client-side print money input uses integer-paisa parsing. Server mark-printed now succeeds idempotently when an approved request was already marked printed, so “Print again” does not fail after opening the browser print dialog.

- `npm.cmd run test:print-requests-api`: passed 3/3; `npm.cmd run test:print-snapshot`: passed 4/4; `npm.cmd run test:print-request-editor`: passed 3/3. All had 0 failed and 0 skipped.
- `npm.cmd run lint` and `npm.cmd run build` passed; Vite emitted existing config/chunk-size warnings.
- Manual checklist (not yet run): in API mode, submit a cashier sale/payment print request and verify it appears in My Print Requests; as an admin, verify requester identity, approve/print, reject with a note, edit a pending sale receipt and confirm the sale is unchanged; print an approved request twice and verify both print attempts track without a duplicate-processing error; verify the nav pending count updates; repeat a representative Supabase fallback path. No browser/manual acceptance was run.

## Autopilot step 4 progress — Manage Users

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** In API mode, Manage Users now maps the existing screen's list/create/edit/delete/reset-password actions to the authenticated Mongo user endpoints, validates exact DTO fields, and retains the Supabase Edge Function fallback. The own-password modal now posts the current and new password to an authenticated server route; the server verifies the current Argon2 hash, writes a new Argon2id hash, and audits the change without recording password material. The API permission type now includes the server's `stock_alerts` grant.

- `npm.cmd run lint`: passed. `npm.cmd test`: 234 tests, 224 passed, 0 failed, 10 skipped (real-Mongo tests skipped by the non-Compose runner). `npm.cmd run build`: passed with existing Vite `__dirname` and large-chunk warnings.
- Focused Manage Users adapter and auth route tests: 11 passed, 0 failed, 0 skipped.
- Manual checklist (not yet run): in API mode, as an authorized manager/admin, list users and confirm self/super-admin restrictions; create a user, edit profile/permissions, reset their password, and remove them; verify the last-admin and self-role protections remain enforced; use Change My Password with a wrong current password then a valid one and sign in using the new password. Repeat a representative list/create/edit flow with `VITE_BACKEND=supabase`. No browser/manual acceptance or Compose API runtime test was run.

## Autopilot step 4 progress — Returns

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** API mode now uses the Mongo return policy, shop-local `today`, sale lookup, return request, pending list, approval, rejection, and processing routes. DTOs are strictly allowlisted and integer-paisa/base-unit strings are checked before converting to UI-safe integers; the sale DTO rejects unexpected cost fields. The review screen now exposes the server's PENDING → APPROVED → COMPLETED state sequence; Supabase behavior remains unchanged.

- `npm.cmd run test:sale-returns-api`: passed 3/3, failed 0, skipped 0. Full `npm.cmd test`: 237 tests, 227 passed, 0 failed, 10 skipped. `npm.cmd run lint` and `npm.cmd run build` passed; Vite retains its existing `__dirname` and large-chunk warnings.
- `server/src/phase7-routes.ts` now returns the sale fields and safe unit options needed by the screen; refund DTOs report the original tender category without exposing cost data. The return eligibility preview takes `today` from the shop timezone.
- Manual checklist (not yet run): in API mode, submit a partial return from a saved sale; approve it as a manager, process it as quarantine/write-off/restock as allowed, verify status and stock/cash-book/customer-ledger effects, reject a second request, and check exact package conversions and return-window policy near shop midnight. Confirm cashier responses and receipts contain no cost/profit/margin. Repeat a representative legacy Supabase return. No browser/manual acceptance or Compose API runtime test was run.

## Autopilot step 4 progress — Purchases and Purchase History

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** Purchase entry now loads its catalog, suppliers, and shop-local today from the API and posts integer-paisa/base-unit values through the transactional purchase endpoint. Purchase History now uses API pagination, details, voids, filtered export, and server-computed summaries; the Supabase fallback remains. API DTOs are strictly allowlisted, cost fields and export are omitted/denied for callers without cost visibility, and the UI hides cost totals, printing, and export when the server does not return cost fields.

- `npm.cmd run test:purchases-api`: 5 passed, 0 failed, 0 skipped. `npm.cmd --prefix server run test:stock`: 14 passed, 0 failed, 0 skipped; includes filtered summaries across pages, full export details, and cashier cost exclusions.
- `npm.cmd run lint` passed. `npm.cmd test`: 243 tests, 233 passed, 0 failed, 10 skipped (real-Mongo cases are skipped by the non-Compose runner). `npm.cmd run build` passed; the existing Vite `__dirname` and large-chunk warnings remain.
- Manual checklist (not yet run): in API mode, create cash and credit purchases with a supplier, multiple units, bonus quantities, batch/expiry, discount, and notes; refresh and verify received stock; inspect purchase history filters, summary cards, detail, print, Excel export, and admin void; verify voided stock/ledger behavior and retry feedback. With a cashier account granted `purchase_history`, confirm history contains no purchase totals/costs and export/print are unavailable. Repeat a representative purchase and history lookup in Supabase mode. No browser/manual or Compose runtime acceptance was performed.

## Autopilot step 4 progress — Dashboard and Business Analytics

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** API mode now loads dashboard and sales-report aggregates from the Mongo API instead of deriving business totals from a capped browser sales list or the legacy sample inventory. The dashboard uses the shop-timezone date, live active-medicine stock counts, sales/returns/expenses, month net sales, cash/credit receipts, receivables and persisted expected drawer totals. The End-of-Day summary uses those same values and displays the shop-local date. Cashiers receive activity-only dashboard fields; report-authorized roles receive financial aggregates. Sales report DTOs are exact-key validated and preserve paisa as decimal strings, including negative net sales when period returns exceed sales. The current report API does not return COGS, so API-mode profit and margin remain unavailable rather than being inferred from client-side or incomplete history data. Supabase mode remains unchanged.

- `npm.cmd run test:business-reports`: 3 passed, 0 failed, 0 skipped. `npm.cmd run lint` and `npm.cmd run build` passed.
- `docker compose run --build --rm api-test`: 11 passed, 0 failed, 0 skipped; verifies cashier dashboard activity-only DTO, dashboard net sales after returns, live sellable-stock/cash-book metrics, and a sale immediately before versus exactly at shop-local midnight.
- `npm.cmd test`: 247 tests, 236 passed, 0 failed, 11 skipped (the root runner skips real-Mongo tests; those passed separately in Compose). Existing Vite `__dirname` and chunk-size warnings remain.
- Manual checklist (not yet run): in API mode, compare dashboard sales/returns, monthly net sales, payment totals, receivables, near-expiry/expired and low-stock counts to persisted data; verify the same figures after a return and near shop-local midnight. Open End-of-Day and reconcile cash, returns, expenses, cash purchases and expected drawer against Cash Book; enter a decimal counted-cash amount and verify the difference. Sign in as Cashier and confirm only activity counts appear in Dashboard and no report access is granted without permission. As a report-authorized role, check gross/returns/net and invoice totals in Business Analytics; confirm COGS/profit/margin display as unavailable, not derived in the browser. Repeat dashboard and report screens in Supabase mode. No browser/manual acceptance was run.

## Autopilot step 4 progress — Products and Stock Products

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** API mode now loads Products/Stock Products through typed product, master-data, and stock adapters. Product list/filter/stat flows, product create/edit and unit changes, CSV preview/import/export, bulk edits/deactivation, and medicine/unit barcode operations call the Mongo API; Supabase branches remain available. Cost and margin are only included by the server when its role/permission policy permits them. Margin basis points are computed server-side using integer arithmetic. CSV import now supports a unit barcode and the server registers imported medicine/unit barcodes through its per-shop claim registry.

- `npm.cmd run test:products-api`: 3 passed, 0 failed, 0 skipped. `npm.cmd --prefix server run test:catalog`: 9 passed, 0 failed, 0 skipped; includes cost/margin role filtering, barcode clearing, and CSV unit-barcode import/export.
- Current root checks: `npm.cmd run lint` passed; `npm.cmd test` ran 250 tests: 239 passed, 0 failed, 11 skipped; `npm.cmd run build` passed. The 11 skipped tests are the real-Mongo cases skipped by the ordinary root runner. Existing Vite `__dirname` and large-chunk warnings remain. The most recent Compose Mongo integration result remains 11 passed, 0 failed, 0 skipped from the preceding Phase 7 verification.
- Open caveats: browser/manual acceptance has not been supplied. Product edits update the medicine and its units with separate API writes, so a failed later write can leave a partial edit; bulk edits also report per-request failures rather than running atomically. Product list composition currently consumes category/master-data and stock endpoints, so custom users granted only `products` may need additional permissions or a narrower server summary endpoint. Large-catalog sorting/filtering fetches all relevant medicine/batch pages and may be expensive.
- Manual checklist (not yet run): in API mode, list/search/filter/sort active and inactive products; create/edit a medicine with multiple units and medicine/unit barcodes; clear and regenerate barcodes; import valid and invalid CSV rows (including unit barcode) and export; run category, bulk deactivate and other bulk actions; confirm stock and expiry KPIs agree with Stock Inventory; verify cashier responses and exports omit cost/margin while an authorized manager sees permitted cost fields. Reload to confirm persistence, then repeat representative reads and edits in Supabase mode. No browser/manual acceptance was run.

## Autopilot step 4 progress — Trash Bin

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** In API mode, Trash Bin now reads strict, paginated safe event DTOs from `/api/trash`, including shop-scoped actor display names. Product/supplier/category/brand deactivation and soft-delete/restore records are stored transactionally. Purchase voids append a reason-bearing, non-restorable event in the same transaction as the purchase reversal. The screen restores users, products, suppliers, categories, and manufacturers through their existing authorized API routes; voided purchases remain non-restorable. Supabase mode continues using the original RPC/Edge Function paths.

- Verification: `npm.cmd run lint` passed; `npm.cmd test` ran 254 tests (243 passed, 0 failed, 11 skipped); `npm.cmd run build` passed with existing Vite `__dirname` and large-chunk warnings. `docker compose run --build --rm api-test` reported 11 tests, 11 passed, 0 failed, 0 skipped; the real-Mongo purchase test confirms failed voids roll back Trash Bin events and a committed void produces exactly one event.
- `npm.cmd run test:trash-bin-api`: 4 passed, 0 failed, 0 skipped. `npm.cmd run test:trash-bin`: 2 passed, 0 failed, 0 skipped. The server catalog and stock route suites are included in the root run.
- Remaining: no browser/manual acceptance was supplied. The API history only covers events generated by the Mongo API; any pre-migration Supabase Trash Bin history is not imported. UI display and role-specific restore checks still need manual validation.
- Manual checklist (not yet run): in API mode, review the all-activity and Users/Products/Suppliers/Purchases filters; verify actor, date, reason and action; deactivate and restore a medicine/supplier/category, soft-delete and restore a product/user, and confirm each item disappears/reappears after refresh. Confirm purchase void appears with its reason and has no restore button. Verify unauthorized roles cannot list or restore, and repeat representative flows in Supabase mode.

## Autopilot step 4 progress — Barcode labels and receipts

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** In API mode, label data is mapped from the Mongo-backed product catalog into an explicit `LabelPrintItem` allowlist (name, generic, strength, code/barcode, retail price, expiry), excluding cost/profit/margin even when the catalog caller may view cost. The existing local barcode renderer escapes dynamic label text and attributes. Sale/payment/return memo data is built from safe sale/ledger DTOs; print requests, decisions, edits, and printed-state updates use the typed API adapter. `parsePrintSnapshot` rejects unknown snapshot fields, the snapshot safety check rejects cost/profit/margin keys, and receipt/memo renderers HTML-escape user/shop/product text. Supabase behavior remains available.

- Source tests: `npm.cmd run test:receipt`, `npm.cmd run test:print-snapshot`, `npm.cmd run test:print-requests-api`, and `npm.cmd run test:labels` cover escaping, snapshot allowlisting, cost-field exclusion, barcode validation, and API DTO validation. The latest full root run for the Trash Bin batch reported 254 tests: 243 passed, 0 failed, 11 skipped; Compose real-Mongo tests reported 11 passed, 0 failed, 0 skipped. Lint and build passed; Vite's existing `__dirname` and chunk-size warnings remain.
- Manual checklist (not yet run): in API mode, print labels for a product with medicine and unit barcodes and verify selected fields, MRP, expiry, copy counts, and page sizes; test hostile product/shop text and confirm it renders as text. Print sale, payment, and return memos; verify request/approval/edit/printed flow and ensure no cost/profit/margin appears. Repeat representative flows in Supabase mode. No browser/printer acceptance was performed.

## Phase 8 progress — backend unavailable retry

**Status: WRITTEN-UNVERIFIED for browser acceptance.** Fetch failures and gateway/service responses `502`, `503`, and `504` notify the app shell. In API mode the shell shows a themed, accessible backend-unavailable screen with a retry button; retry restores the existing cookie-backed auth session and returns to login or the workspace as appropriate. Supabase mode is unchanged.

- `npm.cmd run test:api-client`: 6 passed, 0 failed, 0 skipped, including offline event notification and generic transport error handling.
- `npm.cmd run lint`: exit 0. `npm.cmd run build`: exit 0 with existing Vite `__dirname` and large-chunk warnings.
- Manual test still needed: stop/restart the API from a shop PC, check the retry screen appears without exposing server details, retry after health recovers, and confirm the user's session/login state is restored correctly.

## Autopilot step 5 — security hardening

**Status: VERIFIED for the recorded local checks only; not a penetration test.** Fastify enforces the configured exact web origin, request-size limits, HMAC-keyed per-IP/route rate windows, recursive Mongo operator-key rejection, generic error responses, security headers, and cashier-sensitive response screening. Nginx applies the matching request-size limit and static/API response headers. API rate windows are 120 reads, 60 writes, and 30 auth requests per minute; login has an additional 10-per-minute cap and account lockout after five consecutive failures. Persisted rate-limit records use the Mongo TTL index. Login/refresh/logout remain the documented credential-safe idempotency exceptions.

- `npm.cmd run lint`: passed. `npm.cmd test`: 264 tests across 44 file summaries, 253 passed, 0 failed, 11 skipped (real-Mongo cases are skipped by the local runner).
- `npm.cmd run build`: passed; existing Vite `__dirname` and large-chunk warnings remain. `npm.cmd --prefix server run test:security`: 9 passed, 0 failed, 0 skipped; the test walks every registered non-OPTIONS API route for missing-token and cashier response checks. `npm.cmd --prefix server run test:catalog`: 9 passed, 0 failed, 0 skipped, including foreign-shop read/delete and `shopId` mass-assignment rejection.
- `npm.cmd audit --omit=dev` and `npm.cmd --prefix server audit --omit=dev`: each reported 0 vulnerabilities.
- `docker compose up --no-deps --force-recreate mongo-init`: initializer exited 0 after logging `application_indexes_ready`. `docker compose run --build --rm api-test`: 11 passed, 0 failed, 0 skipped against the local authenticated replica set.
- `docker compose up --detach --build --no-deps --force-recreate api web` and `docker compose ps --all`: Mongo healthy, initializer Exited (0), API healthy, web healthy. Through Nginx, allowed-origin `/api/health` returned 200 and `{"status":"ok","database":"ok"}`; an unapproved origin returned 403 `ORIGIN_NOT_ALLOWED`. Nginx frontend/API responses included the configured security headers without duplicate overlapping headers.
- Open: Mongo-backed distributed rate-limit load/race behavior was not exercised; the route sweeps are automated test-app checks rather than production traffic; production domain/CORS/TLS and deployment configuration remain unvalidated; no penetration test or browser/manual workflow acceptance was performed. See [`MONGO_SECURITY_REPORT.md`](./MONGO_SECURITY_REPORT.md).

## First-run shop setup — local implementation evidence

**Status: VERIFIED for the setup API transaction against the local authenticated Mongo replica set; installer and browser acceptance remain unverified.** API mode checks `/api/setup/status` before attempting session restoration and shows a first-run wizard only while the database has no shop and the one-time marker is unused. The API validates the expiring setup code, shop identity/time zone, first Super Admin fields, and password strength; one Mongo transaction creates the shop, Super Admin, server-side profile/memo/receipt defaults, one-time marker, and audit entries. A unique marker and transaction make concurrent submissions single-winner. Setup hash/code fields are redacted from request logs.

- `docker compose run --build --rm --no-deps api-test`: 12 tests passed, 0 failed, 0 skipped. The first-run case covered empty status, wrong/expired code, weak password, concurrent submissions, one shop and Super Admin, Argon2id password storage, default settings, two audit records, closed status after setup, and rejection of a second setup.
- `npm.cmd test`: 269 total, 257 passed, 0 failed, 12 skipped (real-Mongo tests run separately by Compose). `npm.cmd run lint` and `npm.cmd run build` exited 0. `npm.cmd --prefix server run test:security`: 9 passed, 0 failed, 0 skipped.
- Test-fixture correction: the expense-date assertion now derives the query date in `Asia/Karachi` instead of slicing UTC; the audit-log test reflects that admins receive all module permissions by role.
- Open: `SETUP_CODE_HASH` and `SETUP_CODE_EXPIRES_AT` must be provisioned before setup. The installer that generates/displays the plaintext one-time code is not implemented yet; do not treat the current wizard as a complete shop-PC installation experience. Browser acceptance, backup/restore, production TLS/deployment, and owner-side shop setup remain open.

## Starter catalog import — local implementation evidence

**Status: VERIFIED for schema/unit and local Compose replica-set tests; production/shop-PC use remains unverified.** The checked-in starter file contains exactly 20 synthetic examples with no price, cost, on-hand stock, batch, or expiry fields. Import is Super Admin-only, verifies the active shop and actor in the transaction, scopes all documents to the selected shop, creates only missing categories/manufacturers, and skips existing medicine codes without updating them. New medicines are inactive and receive a single default sale unit at zero paisa so they cannot be sold before an owner reviews/sets pricing and activates them. No stock batches are created.

- `npm.cmd --prefix server run test:starter-catalog`: 2 passed, 0 failed, 0 skipped; confirms the file shape and rejects financial/inventory fields and duplicate codes.
- `docker compose run --build --rm --no-deps api-test`: 13 passed, 0 failed, 0 skipped. The real-Mongo test covers Super Admin denial, rollback on a mid-import failure, category/manufacturer creation, import/re-import by code, inactive/zero-price defaults, audit writes, and no stock records.
- `npm.cmd test`: 272 total, 259 passed, 0 failed, 13 skipped. The root command includes API client/data unit tests; real-Mongo tests are exercised separately through Compose.
- `npm.cmd run lint` and `npm.cmd run build` exited 0; `npm.cmd --prefix server run test:security` reported 9 passed, 0 failed, 0 skipped.
- `docker compose run --build --rm --no-deps --entrypoint node api -e "import('node:fs/promises').then(async ({readFile}) => { const rows = JSON.parse(await readFile('/app/data/starter-catalog.json', 'utf8')); console.log(JSON.stringify({starterCatalogEntries: rows.length})); })"` returned `{"starterCatalogEntries":20}`, confirming the file is present in the production runtime image. Do not run the seed command against a shop before verifying the configured shop slug and confirming these demo-named inactive records are wanted.
