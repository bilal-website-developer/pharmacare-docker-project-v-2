# MongoDB Migration Phase Tracker

This file tracks migration phase deliverables and verification. It does not authorize database access, deployment, data deletion, or cut-over.

## Phase status

| Phase | Deliverable | Status | Verification / gate |
|---:|---|---|---|
| 0 | Read-only source inventory | Complete, committed as `eb9dd0c` | [`MONGO_MIGRATION_INVENTORY.md`](./MONGO_MIGRATION_INVENTORY.md); source-only. Live Supabase state remains unverified. |
| 1 | Mongo collection/API design and threat model | Drafted; awaiting owner approval | [`MONGO_DESIGN.md`](./MONGO_DESIGN.md), [`MONGO_THREAT_MODEL.md`](./MONGO_THREAT_MODEL.md). No code or database changes. |
| 2 | Docker/API foundation | Local Compose startup and health verified | Mongo reports healthy, `mongo-init` exits 0, API reports healthy, web reports healthy, and the proxied health endpoint returns HTTP 200. This is local development verification, not production deployment verification. |
| 3 | Authentication and Manage Users API | Implemented locally; awaiting owner-run Docker/runtime verification | Auth/session routes, authorization middleware, policy-aligned user routes, bootstrap CLI, and tests are in `server/`. This does not cut over the frontend or implement business modules. |
| 4 | Catalog, product, and supplier API | Implemented; selected Mongo indexes verified | Per-shop code/barcode uniqueness has real replica-set coverage; full catalog CRUD/runtime acceptance and frontend cut-over remain open. |
| 5 | Purchases and stock API | Implemented; selected Mongo transactions verified | Purchase post/void rollback and competing stock adjustment paths have real replica-set coverage; full route and operational acceptance remain open. |
| 5b | Mongo replica-set verification and write idempotency | Real-Mongo suite passed locally | The original seven-case suite passed 7/7, 0 failed/skipped. Current expanded suite has 9 tests. This is local Docker verification, not production acceptance. Auth/session write routes remain outside persisted business idempotency for the documented credential-safety reason. |
| 6 | POS sales and customer APIs | Implemented; selected Mongo transactions verified | Real replica-set tests cover sale rollback, unique customer ledger references, concurrent last-unit sale, and idempotency. Full route and operational acceptance remain open. |
| 6b | Real Mongo verification and timezone consistency | Verified in local Compose integration suite | Shop-local “today” is used through stock, expiry, alert, purchase, adjustment, write-off, and sales logic. Karachi midnight boundary tests and real Mongo transactional cases pass; this is not production acceptance. |
| 7 | Returns, voids, print requests, settings, expenses, cash book, reports, dashboard | Implemented; targeted Mongo tests passed | `server/src/phase7-routes.ts`; transactional business writes. The frontend remains on legacy paths pending Phase 8. |
| 8 | Frontend API client and module-by-module switch | Batch 1, Suppliers, POS catalog, and Settings adapters implemented; manual UI checks remain | Auth/session, Stock Alerts, Suppliers, POS catalog, and server-backed Settings use the API behind `VITE_BACKEND`; Supabase fallback remains. Remaining feature screens are not yet switched. |
| 9 | Security hardening | Not started | Strict CORS/rate-limit sweep, route authorization sweep, npm audit report, and cashier cost-exclusion sweep remain open. |
| 10 | Backups and production deployment | Not started | Backup/restore proof, production Compose, TLS proxy, and deployment documentation remain open. |
| 11 | Demo data and manual test plan | Not started | Demo-only seed and per-role manual test plan remain open. |
| 12 | Cut-over and Supabase cleanup | Blocked on explicit approval after all manual tests pass | Never delete `supabase/` or migrations; cut-over plan requires owner approval. |

## Autopilot step 0 — housekeeping

**Status: VERIFIED (local checks only).** `npm run lint` and `npm run build` passed. `npm run test:api-client` passed 4/4. `npm test` passed 184 tests, failed 0, skipped 7 (all real-Mongo integration tests; not Mongo runtime verification). The Vite build emitted existing `__dirname` and large-chunk warnings. Manual UI tests and live Mongo/Docker verification remain outstanding.

## Autopilot step 1 — Mongo initialization and local Compose health

**Status: VERIFIED (local development stack only).** Root cause: Mongo users are created in the application database, but the application client's connection URI incorrectly specified `authSource=admin`. The initializer now authenticates that client against its application database; root initialization continues to authenticate against `admin`.

- `docker compose build mongo-init` completed successfully.
- `npm --prefix server run lint` and `npm --prefix server run build` passed. `npm --prefix server test` reported 65 tests: 58 passed, 0 failed, 7 skipped (the real-Mongo integration tests are exercised in step 2).
- `docker compose up --no-deps --force-recreate mongo-init` logged `replica_set_and_app_user_ready` and `application_indexes_ready`, then exited with code 0.
- `docker compose up --detach --build api web` completed. `docker compose ps -a` showed Mongo healthy, mongo-init Exited (0), API healthy, and web healthy.
- `curl.exe --silent --show-error --include http://localhost:8080/api/health` returned HTTP 200 and `{"status":"ok","database":"ok"}`.
- The initial safe diagnostic captured the failing `connecting to Mongo as application user` step with Mongo code 18 / `AuthenticationFailed` and a generic errmsg; no URI or environment values were logged.
- No volumes were deleted or reset. Business transaction behavior still depends on the real-Mongo integration tests in step 2.

## Autopilot step 2 — replica-set tests and write invariants

**Status: VERIFIED (local Docker replica set).** `docker compose run --build --rm api-test` reported 7 tests, 7 passed, 0 failed, 0 skipped. It exercised sales rollback, distinct customer ledger references, concurrent last-unit sale, purchase post/void rollback, per-shop unique indexes, concurrent stock adjustments, and idempotent replay. During the first run, it found and the code fixed:

- Transaction callbacks returning `undefined` were incorrectly treated as absent results; valid callbacks now preserve their completion independently of their value.
- Purchase void passed a valid negative Int64 payable delta through a nonnegative-only converter; signed Int64 bounds are now applied to the decrement.
- The expected stock-concurrency conflict response was sent without being returned from its async route, which caused Fastify to log a duplicate-send error. The response helper now returns the reply. A later full integration run passed with no duplicate-send warning.

Authenticated business writes use a per-shop/route/key-hash idempotency record with expiry. Auth login, refresh, and logout are intentionally excluded from this store because login/refresh responses carry credential material; see `docs/MONGO_DECISIONS.md`. API route review found each authenticated business write route uses the idempotency-aware `requireAuth` pre-handler.

Stock expiry logic and boundary tests consistently use `Asia/Karachi` shop-local dates for the stock operations and sales; the existing unit boundary test checks 18:59:59.999Z and 19:00:00.000Z. `docs/OWNER_STEPS.md` contains the owner-run commands to create the initial shop and super-admin interactively without exposing the password.

Validation after the fixes: `npm run lint` passed; `npm test` reported 191 tests, 184 passed, 0 failed, 7 skipped (only the real-Mongo cases skipped in this non-Compose runner); `npm run build` passed with the existing Vite `__dirname` and large-chunk warnings. The separately invoked Compose integration suite passed all 7 tests with 0 skips.

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
- Phase 5b adds required `Idempotency-Key` headers to authenticated business write routes, scoped by authenticated shop and route. Only a SHA-256 hash of the key is stored; successful response status/body are retained for 24 hours and replayed for a matching request. Reusing a key with a different request or while its first request is processing returns a generic conflict. Failed responses release the reservation. `/api/auth/*` is deliberately excluded because login/refresh responses contain credentials and logout has cookie side effects; session endpoints need a separate credential-safe retry contract.
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
- `docker compose run --build --rm api-test`: 9 tests, 9 passed, 0 failed, 0 skipped. New cases cover concurrent return requests, over-return rejection, approval, process rollback/double-process rejection, net sales after returns, cash reconciliation, cashier permissions/cost exclusion, expense lifecycle, shop settings, print workflow, and sale void.
- `npm run lint`, `npm test`, and `npm run build` passed after implementation; the root test suite reports 193 total tests, 184 passed, 0 failed, 9 skipped (the replica-set cases are skipped by the non-Compose runner). Build retains existing Vite `__dirname` and large-chunk warnings.
- Remaining: Phase 8 must connect React screens to these APIs. Manual browser/UI tests are not yet supplied; backup/deployment and security-hardening phases are not started. The idempotency reservation/transaction crash window recorded above remains a production risk.

Implemented route paths include `/api/returns/policy`, `/api/returns/sales/:invoiceNumber`, `/api/sales/:id/returns`, `/api/returns/:id/approve|reject|process`, `/api/returns/:id/memo`, `/api/sales/:id/void`, `/api/print-requests*`, `/api/admin/print-requests*`, `/api/shop/settings`, `/api/expenses*`, `/api/cash-book`, `/api/reports/sales|stock`, and `/api/dashboard/summary`.

## Autopilot step 4 progress — Suppliers frontend module

**Status: WRITTEN-UNVERIFIED for manual UI acceptance.** `SuppliersView` now reads, creates, edits, and deactivates suppliers through the typed API adapter when `VITE_BACKEND=api`; `VITE_BACKEND=supabase` retains the Supabase implementation. Deactivation uses `PATCH isActive=false`, not the API soft-delete route, so inactive suppliers remain visible as in the existing UI. The shared API client now adds a unique `Idempotency-Key` to write requests and reuses it on an auth retry.

- Focused tests: `npm run test:suppliers` passed 3/3; `npm run test:api-client` passed 5/5.
- Full checks: `npm run lint` passed; `npm test` passed 197 tests, failed 0, skipped 9 (all Mongo replica-set integration tests are intentionally skipped outside Compose); `npm run build` passed with the existing Vite `__dirname` and large-chunk warnings.
- Manual checklist (not yet run): with `VITE_BACKEND=api`, sign in as a user with `suppliers`; verify all active and inactive suppliers load and refresh; add a supplier; edit its contact/address/licence/payment terms; deactivate it and verify it remains listed as Inactive after refresh. Then set `VITE_BACKEND=supabase` and confirm the legacy list and write behavior still works. Purchase-selection behavior should be verified after the purchase screen is migrated.
- Remaining modules include Products, Categories/Brands/Units and Master Data, Stock Inventory, Purchases/History, POS sale/billing, Customers/Ledger, Sales History, Returns, Print Requests, Manage Users, Expenses/Cash Book, Reports/Dashboard, Trash Bin, Settings, and barcode/label/receipt integrations.

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
- POS sale submission is still not API-wired, so server-owned `roundNet` is not yet used to finalize API sales; this is part of the POS sales module. No browser/manual acceptance was performed for Settings.
