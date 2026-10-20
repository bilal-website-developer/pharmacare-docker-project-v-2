# Project Context

## Quick start for any AI

Read this whole file before doing anything. If the code and this file disagree, the code is right: fix this file.

## Project summary

Pharma Care is a pharmacy point-of-sale (POS), inventory, purchasing, customer/accounting, and staff-management web app. On `feature/control-plane`, a Node 22/Fastify/MongoDB API and Docker packaging coexist with the legacy Supabase implementation. Control-plane schema, release tooling, first-run updater provisioning, and local updater/LAN/restore scaffolding are present; operational update integration and shop hardware acceptance remain in progress. Fake-control-plane Playwright tests pass in Chromium. The Supabase-backed product paths and shop hardware/production acceptance remain unverified.

- Latest modules: Products, Stock Inventory, and Trash Bin use typed API adapters; the Vite proxy targets Compose API `:3000` by default with a `VITE_API_PROXY_TARGET` override for host Fastify `:3001`. Supabase fallback remains available.

## How to run

Commands below are defined by `package.json`; run from the repository root:

```sh
npm install
npm run dev
npm run lint
npm test
npm run build
```

Vite serves on port 3000. For local API development, run `npm --prefix server run dev` separately; Fastify defaults to port 3001 and Vite proxies `/api` there. Compose explicitly runs the private API service on port 3000. `npm test` runs the project's registered unit tests, including the API client test.

The local MongoDB/Fastify API stack is documented in `docs/DOCKER.md`; it requires Docker Desktop. MongoDB backs API auth, user, catalog, purchase, and stock routes; the frontend still uses the existing Supabase paths.

## Folder map

- `src/App.tsx`: eager app shell, navigation state, demo/mock data and page routing; non-Dashboard screens and modal views are lazy-loaded with visible loading/error states.
- `src/components/POSBillingView.tsx`: active POS workflow, cart, and completed-sale printing. `POSScreen.tsx` is a legacy, unreferenced component.
- `src/utils/receipt.ts`, `printSnapshot.ts`, `printWorkflow.ts`: Pharmacy Memo rendering, safe print snapshots, and print-request workflow.
- `src/components/SettingsView.tsx`, `TemplatePreviewModal.tsx`: receipt template/paper settings and preview.
- `src/components/InventoryScreen.tsx`, `src/components/inventory/`: Products and Stock Inventory UI, shared inventory UI, and pure logic.
- `src/components/StockPurchaseView.tsx`, `PurchaseHistoryView.tsx`: purchasing and purchase history.
- `src/components/CustomerLedgerScreen.tsx`, `Customers`-related screens in `src/components/`: customer balances, ledger, and payment slips; API mode uses typed Mongo-backed adapters.
- `src/components/ManageUsersView.tsx`, `src/permissions.tsx`, `src/utils/auth.ts`: staff, roles, UI permission checks, and profile/auth helpers.
- Other feature screens in `src/components/` include Dashboard, Reports, Suppliers, Cash Book, Controlled Drugs, Master Data, and print-request administration.
- `src/utils/`, `src/types/`, `src/data/`: reusable logic, TypeScript domain shapes, API data adapters, and mock pharmacy data.
- `control-plane/`: Postgres migrations and SQL checks plus the shared Supabase Edge Function router, support session operations and fake-store tests; no live project is configured.
- `supabase/migrations/`, `supabase/functions/`, `supabase/baseline/`: database migrations, Edge Functions, and a supplied schema snapshot.
- `server/`: Fastify/TypeScript API, MongoDB replica-set initializer, auth/user/catalog/purchase/stock/sales/customer/Phase 7/setup/support routes, signed licence state/heartbeat/write guard, transactional legacy-role migration, fictional starter catalog and guarded demo seed CLIs/data, and a Compose real-Mongo test runner.
- `docker/`, `docker-compose.yml`, `docker-compose.prod.yml`, `Dockerfile`: local Mongo/API/web container setup, scheduled backup and scratch restore services, loopback-only installer, and Caddy/Nginx configuration. See `docs/DOCKER.md`, `docs/INSTALLER.md`, and `docs/DEPLOYMENT.md`.
- `docs/`: database references, `MASTER_PLAN.md`, `MULTI_SHOP_FULL_PLAN.md`, execution progress, redesign notes, and this context.
- `scripts/`, `.githooks/`: context generation and commit-hook tooling.
- `scripts/update.ps1`, `scripts/update-engine.ps1`, `installer/restore.ps1`, and `docker-compose.lan.yml`: host-side update orchestration, injected transaction tests, archive restore/external-copy helpers, and an optional internal-TLS LAN stack. First-run activation provisions updater configuration under the host-mounted `updates/` directory; real Docker update/rollback rehearsal is in progress.
- `e2e/`, `playwright.config.ts`: Chromium browser tests with intercepted local fake API routes; no live control plane is contacted.
- `public/`: static assets and fonts.

## Data and storage

- Supabase Auth/Postgres: shared across clients connected to the same configured project. Products, Stock Inventory, and purchase workflows use server RPCs; Suppliers still has direct table reads/writes. Authorization and persistence are not uniform across every screen.
- Supabase Edge Functions: the `manage-users` function exists; print approval, requester-name listing, audited receipt-only modification, and profile Trash Bin events use database RPCs/Edge Functions.
- Browser `localStorage`: UI-only preferences, saved inventory views, purchase drafts, per-user stock-alert keys seen, and other device settings. API-mode shop identity, memo settings, and receipt settings are server-backed.
- Mongo `controlPlaneState`: the shop's control-plane shop ID, device-key hash, public signed licence, connection last-seen time and suspension status. Raw device keys are not persisted. Heartbeats send app version and aggregate user/product/sale/purchase counts only.
- Mongo `supportSessions`: local shop/user IDs, control-plane session ID, scope, approval/expiry/end timestamps, and hashes of the one-time support code and first accepted signed token. Raw support codes/tokens are not persisted in the session record or the API idempotency cache. Support audit events are stored in the local audit log.
- Mixed persistence: `VITE_BACKEND=supabase` retains the legacy Supabase behavior. API-mode adapters cover auth/session, Stock Alerts, Products/Stock Inventory, Suppliers, POS catalog/sales, Settings, Customer Ledger/Sales History, Master Data, Cash Book/expenses, Print Requests, Manage Users, Returns, Purchases/History, Dashboard/Business Analytics, and Trash Bin. Barcode labels and sale/payment/return receipts use safe API-fed DTOs and local HTML renderers. Manual UI and production acceptance remain unverified.
- Demo fixture seeding is available only in `NODE_ENV=development|test`, with `DEMO_MODE=true` and an app database ending in `-demo` or `_demo`; the Compose runner defaults to production mode. Fixtures contain no stock batches; use the purchase module to create saleable stock. See `docs/MANUAL_TEST_PLAN.md`.
- Other storage: unknown; no general file/object-storage workflow is established by the checked-in frontend docs.
- Mongo backup archives use a separate Compose volume; the backup identity is limited to database `read`. Production Caddy certificate data is persisted in a named volume. No off-host archive copy or production restore is proven.
- Shared production data behavior depends on Supabase deployment and the live schema, which may differ from checked-in migrations.
- The local Docker stack contains authenticated MongoDB on a private network and a Fastify API with health, auth, Manage Users, catalog, purchase, stock, sales, Phase 7, and first-run setup routes. Local Compose startup, Mongo initialization/index creation, service health checks, `/api/health` proxy, and targeted real-Mongo integration tests have passed in prior/current sessions. The setup wizard still depends on installer-provisioned `SETUP_CODE_HASH` and `SETUP_CODE_EXPIRES_AT`; this is not production or manual UI acceptance. Legacy Supabase paths remain available.

## Roles and permissions

Role names in `src/types/pharmacy.ts`: `admin`, `manager`, `cashier`, `accountant`. Legacy `super_admin` records are transactionally converted to `admin` at API startup and audited; the old role literal remains only in that migration.

Frontend permission keys in `src/permissions.tsx`: `pos`, `products`, `categories`, `suppliers`, `customers`, `sales_history`, `purchase_history`, `purchases`, `expenses`, `stock_inventory`, `reports`, `manage_users`, plus POS print toggles `pos_print_sale` and `pos_print_payment`. The new API additionally allows `stock_alerts` to meet the migration contract.

UI defaults: Admin gets every module. Manager gets POS, Products, Categories, Suppliers, Customers, Sales History, Purchase History, Purchases, Stock Inventory, and Reports. Cashier gets POS and Customers. Accountant gets Customers, Suppliers, Sales History, Purchase History, Expenses, and Reports. Non-admin permissions can be configured; admin has full defaults. Dashboard/help and personal print requests are available to all in the UI; Settings, Trash Bin, and print-request administration are admin-only. UI checks do not replace database/server authorization.

Cost visibility decision: Admin may view cost; Manager may view it only with at least one of `products`, `stock_inventory`, `purchases`, or `purchase_history`; Accountant may view it read-only through `purchase_history` or `reports`; Cashier never may. There is no Pharmacist role in the current app. The server rule exists in migrations; its effective production definition and table grants still require live verification.

## Business rules

- Persisted money columns and calculation fields use integer paisa; `sale_items.discount_percent` is numeric.
- Batch sale allocation uses FEFO: positive eligible stock only, `ACTIVE`/`NEAR_EXPIRY`, expiry today or later, then received date and ID for tie-breaking. Mongo sale and stock paths enforce shop-local sellability and are covered by unit/replica-set tests; legacy Supabase behavior still depends on the deployed RPC/schema.
- Expiry is a stock-batch field, not a medicine/product-master field. Product setup does not require expiry, but every purchase batch currently requires a future expiry date; no-expiry batches are not supported by the schema or sale/alert rules.
- Per-shop IANA timezones default to `Asia/Karachi`; sales and stock expiry/status/alert calculations receive one shop-local “today” value. The Karachi midnight boundary is tested at 19:00 UTC, including the local Mongo integration setup.
- Do not permit negative stock. Conditional stock updates and replica-set concurrency tests cover the API path; production operation remains unverified.
- The signed local licence state machine governs renewal notice, warning, inactivity and suspension. The server blocks new sales, purchases and stock mutations when inactive/suspended, except a one-time server-issued sale-draft token opened before inactivity remains valid for up to 60 minutes. Offline time only raises a warning. Real control-plane synchronization remains unverified.
- Stock alerts use sellable stock from positive, unexpired (`expiry_date >= current_date`), `ACTIVE`/`NEAR_EXPIRY` batches for active medicines. Alert low/out counts require `min_stock_alert > 0`; the alert RPC returns no cost, MRP, supplier, or cost-derived value and is available to every active, non-deleted profile regardless of module permission. The existing Products `out_of_stock` KPI does not apply the positive-reorder-threshold condition, so its count may exceed alert out counts. Owner-supplied live results show `stock_alerts_summary` exists with anon EXECUTE false/authenticated true; no migration-history result or end-to-end behavior was supplied.
- Cost and profit/margin are internal data, not Pharmacy Memo print fields. Receipt rendering displays sale amounts/totals and is styled black on white. Do not add cost, purchase price, profit, or margin to customer-facing slips.
- Cost-bearing base tables stay inaccessible to `anon` and `authenticated`; read cost only through permission-checked RPCs. Do not grant direct `SELECT` on `stock_batches`, because its RLS read policy includes `pos` and exposes all selectable columns to Cashier.
- Pharmacy Memo supports 58mm and 80mm thermal layouts (and A4); black text on white background. Return/payment memo rendering exists. The Mongo API supports return request/review and safe return memo DTOs; React remains on the existing Supabase workflow.
- Implemented return policy in source and migration: only sealed, intact, same-sale-batch units meeting configured shelf-life/window/class/storage rules may be restocked; a Manager/Admin must approve, with `sales_history` and `stock_inventory` required for restock. Cashiers with POS may request returns but cannot approve. `QUARANTINE` and `WRITE_OFF` do not increase sellable stock. Refunds use original line totals in integer paisa; credit-sale returns update customer credit/ledger. Cumulative returns cannot exceed sold quantity, while multiple partial-return transactions are allowed. Owner reports the migration applied; runtime and accounting reconciliation remain unverified.
- Mongo invoice/memo and purchase numbers use atomic per-shop counters in the transaction; uniqueness is sequential, not gap-free. The legacy Supabase schema remains a separate path until cut-over.

## Conventions and decisions

- Keep business logic in reusable pure helpers when practical, with tests alongside the helper.
- Use server RPCs for workflows needing atomic multi-table writes or server-side filtering/authorization; use Supabase directly only where the current code does so intentionally.
- Keep client-facing cost fields nullable/redacted by the server when visibility is denied; never turn unknown cost into zero in UI.
- Date: 2026-10-14 — The initial Nginx config avoids a restrictive Content Security Policy until active external-service origins are explicitly inventoried, preserving the existing Supabase-backed frontend paths while retaining other security headers.
- Date: 2026-10-10 — Inventory lists, statistics, movements, adjustments, and write-offs use stock RPCs to keep paging/filtering and mutations server-side.
- Date: 2026-10-10 — Product data uses server-side list/stat/import RPCs; cost visibility is decided server-side rather than trusted to client hiding.
- Date: 2026-10-13 — Stock alerts are server-counted, visible to every active signed-in profile, and never include cost-bearing fields. Navigation is permission-gated in the header; seen alert keys are per-user and browser-local. Owner reports the `stock_alerts_summary(integer)` RPC metadata is verified: `SECURITY DEFINER`, `search_path=public`, anon execute false, authenticated execute true.
- Date: 2026-10-13 — Owner reports the corrected `20261013160000_persist_sales_and_returns.sql` migration applied. Owner-shared metadata query verified `SECURITY DEFINER`, `search_path=public`, `anon EXECUTE=false`, and `authenticated EXECUTE=true` for its 13 RPCs and `pos_catalog()`. End-to-end behavior remains unverified. Return totals are capped cumulatively at the sold quantity; multiple partial-return transactions remain possible.
- Date: 2026-10-12 — Cost access is role-and-permission scoped by `can_view_cost()`; Cashier is always denied, Accountants are read-only, and Manager access requires a relevant module permission. Verify the deployed function and table grants in Supabase.
- Date: 2026-10-09 — Pharmacy Memo uses a shared sanitized renderer for 58mm/80mm and A4; template and paper preferences remain browser-local because shared settings storage is not implemented.
- Date: 2026-10-14 — Phase 5b adds Mongo replica-set integration tests and hashed, shop/route-scoped idempotency for authenticated business writes. Login/refresh/logout are excluded; idempotency completion is not atomic with the business transaction, so a post-commit process crash can strand a key as PROCESSING for up to 24 hours. Owner selected per-shop IANA timezones defaulting to `Asia/Karachi`.
- Date: 2026-10-18 — Control-plane steps 1–4 are locally implemented on `feature/control-plane`: private RLS schema/functions, Ed25519 licence verification/state machine, role migration, activation setup, six-hour heartbeat and server-side inactive-mode enforcement. Evidence and remaining verification are in `docs/CONTROL_PLANE_STATE.md`; no live Supabase credentials/project were used.

## Current status

- **Current checkout:** `feature/control-plane`. Phase 8 API coverage and Phase 9 local verification evidence are tracked in `docs/MONGO_MIGRATION.md`; manual UI and production security acceptance remain outstanding.
- **Control plane:** steps 1–8 are locally implemented; updater, LAN, restore, E2E and owner-doc work for steps 9–14 is present. First-run activation now provisions updater config and the public licence key; real Docker updater acceptance, current real-stack E2E and hardware acceptance remain incomplete. Release scanning and Node built-in Ed25519 signing were exercised locally. Tests and evidence are in `docs/CONTROL_PLANE_STATE.md`. No real Supabase project has been accessed.
- The Supabase implementation remains intact as the alternate backend. Owner-reported migration/ACL state and source-only barcode/Trash Bin changes are historical context, not live verification; do not run Supabase operations as part of the Mongo migration.
- Existing UI behavior includes POS split tender, customer credit, cashier print requests, audited receipt-only print edits, role-based cost visibility, barcode/label workflows, stock alerts, and Trash Bin; API-mode adapters are implemented while manual acceptance remains pending.
- Security and runtime gates still open: public production CORS/TLS and Mongo rate-limit load behavior, off-host backup, production deployment, human API-mode acceptance, and manual demo-shop testing. External-folder copy and scratch restore/count parity passed with synthetic data in a unique disposable Mongo project; no off-host or production restore was done. A disposable LAN stack answered host HTTPS curl with certificate validation bypassed; Windows trust-store validation and a real shop login/cookie exchange remain open. Local security checks are recorded in `docs/MONGO_SECURITY_REPORT.md`; no penetration test was performed. The Phase 12 checklist is preparation only; keep Supabase code and migrations untouched until separate owner approval.
- Support endpoints validate Ed25519 tokens and scopes locally. Only diagnostics/aggregate reporting and licence refresh are implemented; a direct support relay, full read-only screens, password reset, backup trigger and service restart remain unimplemented. `SUPPORT_TOKEN_PUBLIC_KEY` must be configured from the matching public key before support tokens can be accepted.

## Known issues and Later

- Multi-shop decisions are captured in `docs/MULTI_SHOP_FULL_PLAN.md` and `docs/MASTER_PLAN.md`; they are design references, not authority for unimplemented access paths or database changes.
- Legacy Supabase schema, migrations, RPCs, and ACLs may differ from checked-in source. No live verification was performed in this work; leave `supabase/` and its migrations untouched until approved cut-over.
- The Supabase baseline SQL is reconstructed, not a complete dump; timestamped rollback scripts are not forward migrations. Legacy barcode uniqueness, Supabase print/Trash Bin deployments, and physical scanner/printer behavior remain unverified; QR labels and direct ESC/POS support are not implemented.
- Existing Supabase mode and demo features may still use legacy or in-memory data. In API mode, listed modules use the Mongo API; off-host backup, production deployment, and manual UI acceptance remain open.

## Assumptions

- Split payments are represented by separate payment rows in `post_sale()` source; live tender settlement/reconciliation still needs staging verification.
- Admin modifications to pending print requests change the receipt snapshot for printing only; they do not rewrite the completed sale, inventory, or accounting records.
- Trash Bin records user soft-deletes/restores, product/supplier active-state changes, and purchase voids. Purchase records are not physically deleted or directly restorable.

## Changelog

- 2026-10-19 — First-run activation provisions `updates/update-config.json` and a public licence verification key to the host-mounted update directory; the device credential is stored there only as a SHA-256 hash. Compose web port is configurable (default 8080) and updater health checks follow that port. Config tests 6/6, lint passed, and isolated real-Mongo integration passed 18/18, including activation provisioning. Real Docker update/rollback remains pending; no existing stack or non-test volume was touched.
- 2026-10-19 — Continued control-plane work on `feature/control-plane`: reproduced scanner array-binding exit 1 and confirmed comma-separated invocation scans five images; signed/verified a temporary release with Node Ed25519 and rejected tampering/wrong key; exercised fake updater success/rollback/tamper/retry (4/4); copied an external Mongo backup and matched scratch restore collection counts in a unique disposable project; validated Caddy and LAN HTTPS health with host curl. Root tests: 301 total (283 passed, 0 failed, 18 skipped); isolated Mongo integration 18/18; real Chromium E2E 7/7; lint, API/web and panel builds passed; audit 0 vulnerabilities. The browser cookie test uses a fake HTTPS origin; Windows Schannel CA trust, real shop cookie exchange, live Supabase, actual updater deployment, off-host/production DR and hardware acceptance remain unverified. No push.
- 2026-10-20 — Added the proposed licence policy (pending owner/legal review), updated Windows cashier-PC Caddy-root trust instructions, corrected activation/updater documentation, and adjusted the real updater harness to pin its disposable TLS certificate instead of importing into the Windows trust store. Real Docker updater and real-stack Chromium results are pending.
- 2026-10-20 — First real Docker rehearsal built and started unique project `cp-real-c3daae9bcdd5`; its real-stack Playwright test failed before setup completion (1 failed, 0 passed, 0 skipped). Project containers, networks, and project-labeled volumes were checked absent afterward. The failure is being diagnosed; no update or rollback was executed.
- 2026-10-20 — Second unique-project rehearsal completed activation setup and admin login, then the real-stack browser test hit its 30-second test timeout during role creation (0 passed, 1 failed, 0 skipped). Raised the real-stack test budget to 180 seconds. No update/rollback executed yet.
- 2026-10-20 — Third unique-project real-stack run completed setup, role creation, purchase, and purchase export, but the POS sale endpoint returned HTTP 400 (0 passed, 1 failed, 0 skipped). Added diagnostics limited to response error code and request field names; no sensitive request values are printed.
- 2026-10-20 — Fourth throwaway Compose rehearsal failed before API startup because its fresh Mongo container became unhealthy; no browser/update assertions ran. The project was stopped and the unrelated shoptest stack remained healthy.
- 2026-10-20 — Fifth real-stack run reached the discounted POS sale; the server rejected an admin discount with `DISCOUNT_EXCEEDS_ROLE_LIMIT`, as designed (0 passed, 1 failed, 0 skipped). Updated E2E to execute the discounted sale as a manager within the server-enforced limit.
- 2026-10-20 — Sixth real-stack run timed out attempting manager login from an already-authenticated admin browser context (0 passed, 1 failed, 0 skipped). Switched manager and cashier browser sessions to isolated Chromium contexts.
- 2026-10-20 — Seventh real-stack run completed setup/roles/purchase but sale posting returned `SALE_NUMBER_CONFLICT` (0 passed, 1 failed, 0 skipped). Added safe request-count and persisted-sale-count diagnostics to determine whether the issue is duplicate submission or a counter conflict.
- 2026-10-20 — Eighth real-stack run reproduced `SALE_NUMBER_CONFLICT` with one browser POST and zero persisted sales (0 passed, 1 failed, 0 skipped). Added failure-only Mongo diagnostics restricted to sequence metadata and aggregate counts, before throwaway cleanup.
- 2026-10-20 — Ninth run repeated the sale conflict; the diagnostic was not executed because PowerShell truncated the inline Node argument. Changed diagnostics to a script file on the throwaway bind mount, without printing customer data or credentials.
- 2026-10-20 — Tenth run reproduced the sale conflict; the diagnostic failed because `.js` was interpreted as ESM. Renamed the test-only diagnostic to `.cjs` and limited output to unique index metadata and aggregate counts.
- 2026-10-20 — Eleventh run again saw the sale conflict; safe Mongo diagnostics launched but failed without reporting a reason. They now emit only diagnostic error name/code/codeName. The repeated real sale failure remains unresolved; no update/rollback ran.
- 2026-10-20 — Twelfth run repeated the sale conflict; diagnostics revealed Mongo `NamespaceNotFound` (26) while listing indexes on collections not created yet. Updated the diagnostic to accept missing collections and still report existing index metadata.
- 2026-10-20 — Thirteenth run reproduced the single-POST sale conflict; safe DB inspection showed only the `PURCHASE` counter and zero sales. Added duplicate-key logging restricted to index field names and configured the runner to emit only that event, to locate the rejecting unique index.
- 2026-10-20 — Fourteenth run's safe server log narrowed `SALE_NUMBER_CONFLICT` to a duplicate `_id` key but not the collection. Added a stage label to the same value-free log to identify the exact sale transaction write.
- 2026-10-20 — Fifteenth real updater run stopped during Docker image build with `target web: DeadlineExceeded`; no stack/test ran. Frontend/server lint and API build then completed successfully (exit 0).
- 2026-10-20 — Sixteenth image build produced no progress for over ten minutes and was stopped before starting Compose; the exact temporary folder was cleaned and no project volumes were created. Docker showed the pre-existing shoptest Mongo unhealthy (web/API healthy); it was not changed. The runner now builds only the API image, reusing the unchanged web image.
- 2026-10-20 — Seventeenth real-stack attempt stalled at the API image build; `docker.exe ps` returned HTTP 500 from the Docker Desktop Linux-engine API and `docker.exe info` hung. Stopped before Compose startup and removed only its exact GUID-named temp folder. Fresh checks passed: root tests 302 total (284 passed, 0 failed, 18 skipped), lint, web/API and panel builds, fake Chromium E2E 7/7, and production dependency audit (0 vulnerabilities). Real Docker update/rollback, real API/Mongo E2E, LAN trust retry, API Compose test, image scan, and release-folder key audit remain unverified. Continuation changes were committed locally as `889cb90` and `ed58de4`; nothing was pushed.
- 2026-10-18 — Continued control-plane work on the already-checked-out `feature/control-plane` branch, preserving the pre-existing dirty worktree. Step 8 release bundle build completed; all four image scans passed, and scanner negative checks rejected a synthetic JWT-like value and `.env.example`. Current validation: SQL migration/security checks 15 PASS notices; root tests 300 total (282 passed, 0 failed, 18 skipped); Mongo integration 18/18; direct Edge 8/8, licence 8/8, support 2/2, security 9/9, panel 2/2, setup 2/2; lint/build/panel build passed; `npm audit --omit=dev` reported 0 vulnerabilities. OpenSSL signing and steps 9–14 remain unverified/incomplete.
- 2026-10-18 — Step 7 adds a standalone mint-themed developer panel at `control-plane/panel/`: Authenticator enrollment/challenge gates, server-checked AAL2/developer access, shop/licence administration, one-time activation-code display, audit and release workflows. Panel domain tests 2/2, Edge tests 8/8, lint and isolated panel build passed. Real Supabase Auth/RLS and browser acceptance remain unverified; step 8 is in progress.
- 2026-10-18 — Step 6 shop UI/API wired: role-filtered licence banners and admin-only Allow Support UI with end-session flow; setup activation form reports per-field errors; shop Super Admin options remain removed. Security tests 9/9, app test 1/1, licence tests 8/8, support-route tests 2/2, lint and build passed. Browser/Playwright and real Supabase acceptance remain unverified; step 7 is in progress.
- 2026-10-18 — Implemented control-plane steps 1–5 on `feature/control-plane`: nine RLS-protected tables and SQL checks; 13 Edge operations with Ed25519 licence and scoped support tokens; local support approval/end, hashed codes/tokens, scope enforcement, local audits and masked diagnostics; signed licence state, activation setup, aggregate heartbeat, and inactive-mode write guard. Server lint/build passed, support tests passed 8/8, and isolated Mongo integration passed 18/18 with 0 skipped. No live Supabase project was used.
- 2026-10-17 — Phase 8 API transport failures now show a themed retry screen in API mode; retry restores the cookie-backed session. Client test 6/6, lint/build passed; browser/shop-PC recovery remains unverified.
- 2026-10-17 — Added first-run setup status and wizard plus a one-transaction shop/Super Admin/settings/audit bootstrap guarded by expiring, hash-checked setup code. Setup batch root tests: 269 total (257 passed, 0 failed, 12 skipped); security tests 9/9; Compose Mongo integration 12/12; lint/build passed. Installer code generation/display and browser acceptance remain open.
- 2026-10-17 — Added a 20-entry fictional starter catalog and Super Admin-only transactional/idempotent importer; new entries are inactive, zero-priced, and have no stock. Current root tests: 272 total (259 passed, 0 failed, 13 skipped); focused catalog tests 2/2; security 9/9; Compose Mongo 13/13; lint/build passed; runtime image contains all 20 entries. Production and shop-PC use remain unverified.
- 2026-10-17 — Added a loopback-only single-PC installer with isolated Compose project naming and expiring one-time setup code provisioning. PowerShell parser, Compose config, root tests (272 total; 259 passed, 0 failed, 13 skipped), lint/build, and Compose Mongo (13/13) passed. The installer has not been run against an actual shop; LAN HTTPS/production remains unverified.
- 2026-10-18 — Added scheduled gzip Mongo backups with a database-read-only identity, age retention, and a tmpfs-only scratch restore/count comparison. Compose replica-set rehearsal restored the app database and matched collection counts (including 39 customer documents); lint/build and root tests passed (272 total: 259 passed, 0 failed, 13 skipped), Compose Mongo tests 13/13, and production Compose syntax validation passed. Caddy/TLS deployment, DNS/firewall, off-host backups, and owner acceptance remain unverified.
- 2026-10-18 — Added a demo-only transactional seed with development/test, explicit flag, and demo-database guards plus a five-role, module-by-module manual acceptance plan. The Compose runner uses `DEMO_NODE_ENV` and defaults to production; automated seed tests and full validation results are recorded in the migration tracker; no human browser acceptance or production use was performed.
- 2026-10-18 — Prepared `docs/CUTOVER_CHECKLIST.md` for a future owner-approved Phase 12. No Supabase client, folder, migration, live project, or data was removed or changed; cut-over remains unstarted and gated on manual acceptance.
- 2026-10-18 — Ran a clean local installer clone; first run exposed missing `BOOTSTRAP_SHOP_SLUG` Compose wiring, fixed it for API/test runner and added a Mongo integration assertion. Fresh rerun passed setup/login/refresh, loopback binding, and Mongo unpublished-port checks. Test-install credentials are outside the repository; remote push remains owner-pending for HTTPS authentication.
- 2026-10-18 — Re-ran final local checks: lint/build passed, root tests 278 total (265 passed, 0 failed, 13 skipped), API security 9/9, and real-Mongo Compose integration 13/13. Browser sign-in shell rendered; authenticated UI walk-through remains unverified because the browser-control tool could not select the page. Installer proof is an isolated clone, not real shop-PC acceptance.
- 2026-10-17 — Phase 7 completion audit added admin-only, `manage_users`-gated `/api/audit-logs`; Mongo integration test confirms a manager is denied even with that explicit key, admin effective permissions are honored, shop isolation holds, and raw before/after fields are omitted. Root tests then: 264 total (253 passed, 0 failed, 11 skipped); lint/build passed; Compose Mongo 11/11.
- 2026-10-17 — Autopilot baseline re-run: lint/build passed, root tests 264 total (253 passed, 0 failed, 11 skipped), API security 9/9, Compose Mongo integration 11/11; added shell/PowerShell line-ending rules. Worktree was clean before this documentation batch; manual and production acceptance remain open.
- 2026-10-17 — Phase 9 local hardening checks: strict-origin CORS, rate limits, generic errors, redaction, security headers, route/cashier sweeps, and audits; root tests 264 total (253 passed, 0 failed, 11 skipped), Compose Mongo 11/11, audits 0 vulnerabilities. Production acceptance and penetration testing remain open.
- 2026-10-17 — Products/Stock Products API wiring, CSV unit barcodes, and server-computed margin DTOs added. Root tests: 250 total, 239 passed, 0 failed, 11 skipped; lint/build passed. Manual UI acceptance remains open.
- 2026-10-17 — Trash Bin API wiring and transactional deactivation/purchase-void events added. Root tests: 254 total, 243 passed, 0 failed, 11 skipped; Compose tests: 11 passed, 0 failed, 0 skipped; lint/build passed. Manual UI acceptance remains open.
- 2026-10-17 — Reviewed API-mode barcode label and receipt/memo paths: display DTOs are allowlisted and dynamic HTML text is escaped; manual printer/browser acceptance remains open.
- 2026-10-17 — Steps 0–4 revalidated Mongo initialization/health, timezone boundaries, Phase 7 transactions, and API dashboard/report aggregates; Compose tests 11/11 passed, root tests 247 total/236 passed/0 failed/11 skipped, lint/build passed. Manual UI acceptance remains open.
- 2026-10-16–17 — Phase 8 API adapters cover returns, purchases/history, Manage Users, print requests, cash book/expenses, Master Data, customer ledger, sales history, suppliers, settings, POS, stock alerts, dashboard, and reports; detailed evidence and remaining gaps are in `docs/MONGO_MIGRATION.md`.
- 2026-10-10–15 — Phases 0–7 and prior POS/FEFO, multi-shop, barcode/labels, print approvals, and cost-access work are summarized in the migration/history docs; no live Supabase data or schema was changed.

History: Earlier work delivered Products and Master Data redesigns, Pharmacy Memo rendering and print approvals, role/permission UI, and Stock Inventory. See `docs/REDESIGN_PROGRESS.md` and recent Git history for details; that progress document contains some status entries older than the current source.

## Legacy barcode migrations and staging

Do **not** apply `20261012180000_assign_medicine_barcodes.sql` or `20261012181000_medicines_barcode_unique_index.sql` to the current project. They are legacy, pre-multi-shop migrations and are listed only for a clean staging bootstrap to reproduce the checked-in legacy state; see `docs/STAGING_BOOTSTRAP.md`.

The future per-shop barcode cutover must backfill one registry across both `medicines.barcode` and `medicine_units.barcode`, enforce unique `(shop_id, normalized_barcode)`, and replace the global medicine-only index. As part of that cutover, explicitly drop `public.medicines_barcode_unique` with `DROP INDEX IF EXISTS`; replace the old assignment functions and global sequence with shop-scoped registry claims/counters. Do not run the timestamped barcode rollback files as forward migrations. A rollback must not blindly recreate the global index if different shops now share a manufacturer barcode.

## Working agreements with the owner

- Keep messages short and seek approval for large multi-file changes; keep claims grounded in code/docs and write **unknown** where verification is missing. Updating this file needs no permission.

- 2026-10-19 — Replaced OpenSSL-dependent release signing with Node built-in Ed25519 and tested valid/tampered/wrong-key cases. Added host updater, Scheduled Task registration, LAN/restore helpers, owner/support guides, and seven fake-control-plane Chromium tests. Final local root tests: 301 total (283 passed, 0 failed, 18 skipped); unique-project API integration 18/18; lint/build/panel build/audit passed (0 vulnerabilities). External-folder archive copy and tmpfs scratch restore/count parity passed with synthetic data; updater rollback is fake-operation tested only. Activation config provisioning, real updater deployment, Windows Schannel CA trust, real shop HTTPS cookie exchange/firewall, complete export workflows, live Supabase, and hardware/regulatory acceptance remain unverified. See `docs/CONTROL_PLANE_STATE.md`.

<!-- AUTO:START -->
Generated at (UTC): 2026-10-20T10:28:06.848Z
Git branch: feature/control-plane

Last 5 commit subjects:
- Document acceptance blockers and licence policy
- Prepare real-stack updater acceptance
- Record final control-plane verification
- Document control-plane operations and verification
- Add Playwright control-plane browser coverage

Validation commands: `npm run lint`, `npm test`, and `npm run build`.

Environment variable names from .env.example files (values are not read into this block):
- ACME_EMAIL
- APP_URL
- BACKUP_INTERVAL_SECONDS
- BACKUP_RETENTION_DAYS
- BOOTSTRAP_SHOP_SLUG
- COMPOSE_PROJECT_NAME
- DEMO_MODE
- DEMO_NODE_ENV
- GEMINI_API_KEY
- JWT_ACCESS_SECRET
- MONGO_APP_DB
- MONGO_APP_PASSWORD
- MONGO_APP_USERNAME
- MONGO_BACKUP_PASSWORD
- MONGO_BACKUP_USERNAME
- MONGO_REPLICA_KEY
- MONGO_ROOT_PASSWORD
- MONGO_ROOT_USERNAME
- PHARMA_API_IMAGE
- PHARMA_WEB_IMAGE
- PUBLIC_DOMAIN
- REFRESH_TOKEN_PEPPER
- SETUP_CODE_EXPIRES_AT
- SETUP_CODE_HASH
- SUPABASE_ANON_KEY
- SUPABASE_URL
- VITE_BACKEND
- VITE_SHOP_SLUG
- VITE_SUPABASE_ANON_KEY
- VITE_SUPABASE_URL
<!-- AUTO:END -->
