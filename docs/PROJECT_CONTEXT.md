# Project Context

## Quick start for any AI

Read this whole file before doing anything. If the code and this file disagree, the code is right: fix this file.

## Project summary

Pharma Care is a pharmacy point-of-sale (POS), inventory, purchasing, customer/accounting, and staff-management web app. On `feature/mongo-migration`, a Node 22/Fastify/MongoDB API and Docker packaging coexist with the legacy Supabase implementation. Phases 0–7 are implemented in source; Phase 8 has API-mode wiring for auth/session and the listed business screens, including Products, Stock Inventory, Trash Bin, labels, receipts, and first-run setup. The setup transaction has a real-Mongo test, but installer code provisioning and browser/shop-PC acceptance remain open. Phases 9–11 require production/manual acceptance or additional deliverables; Phase 12 is preparation only.

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
- `supabase/migrations/`, `supabase/functions/`, `supabase/baseline/`: database migrations, Edge Functions, and a supplied schema snapshot.
- `server/`: Fastify/TypeScript API, MongoDB replica-set initializer, auth/user/catalog/purchase/stock/sales/customer/Phase 7/setup routes, transaction repositories, first-run Super Admin CLI, fictional starter catalog import CLI/data, and a Compose-only real-Mongo test runner.
- `docker/`, `docker-compose.yml`, `Dockerfile`: local Mongo/API/web container setup, loopback-only single-PC installer, and Nginx configuration. See `docs/DOCKER.md` and `docs/INSTALLER.md`.
- `docs/`: database references, `MASTER_PLAN.md`, `MULTI_SHOP_FULL_PLAN.md`, execution progress, redesign notes, and this context.
- `scripts/`, `.githooks/`: context generation and commit-hook tooling.
- `public/`: static assets and fonts.

## Data and storage

- Supabase Auth/Postgres: shared across clients connected to the same configured project. Products, Stock Inventory, and purchase workflows use server RPCs; Suppliers still has direct table reads/writes. Authorization and persistence are not uniform across every screen.
- Supabase Edge Functions: the `manage-users` function exists; print approval, requester-name listing, audited receipt-only modification, and profile Trash Bin events use database RPCs/Edge Functions.
- Browser `localStorage`: UI-only preferences, saved inventory views, purchase drafts, per-user stock-alert keys seen, and other device settings. API-mode shop identity, memo settings, and receipt settings are server-backed.
- Mixed persistence: `VITE_BACKEND=supabase` retains the legacy Supabase behavior. API-mode adapters cover auth/session, Stock Alerts, Products/Stock Inventory, Suppliers, POS catalog/sales, Settings, Customer Ledger/Sales History, Master Data, Cash Book/expenses, Print Requests, Manage Users, Returns, Purchases/History, Dashboard/Business Analytics, and Trash Bin. Barcode labels and sale/payment/return receipts use safe API-fed DTOs and local HTML renderers. Manual UI and production acceptance remain unverified.
- Other storage: unknown; no general file/object-storage workflow is established by the checked-in frontend docs.
- Shared production data behavior depends on Supabase deployment and the live schema, which may differ from checked-in migrations.
- The local Docker stack contains authenticated MongoDB on a private network and a Fastify API with health, auth, Manage Users, catalog, purchase, stock, sales, Phase 7, and first-run setup routes. Local Compose startup, Mongo initialization/index creation, service health checks, `/api/health` proxy, and targeted real-Mongo integration tests have passed in prior/current sessions. The setup wizard still depends on installer-provisioned `SETUP_CODE_HASH` and `SETUP_CODE_EXPIRES_AT`; this is not production or manual UI acceptance. Legacy Supabase paths remain available.

## Roles and permissions

Role names in `src/types/pharmacy.ts`: `admin`, `super_admin`, `manager`, `cashier`, `accountant`.

Frontend permission keys in `src/permissions.tsx`: `pos`, `products`, `categories`, `suppliers`, `customers`, `sales_history`, `purchase_history`, `purchases`, `expenses`, `stock_inventory`, `reports`, `manage_users`, plus POS print toggles `pos_print_sale` and `pos_print_payment`. The new API additionally allows `stock_alerts` to meet the migration contract.

UI defaults: Admin and Super Admin get every module. Manager gets POS, Products, Categories, Suppliers, Customers, Sales History, Purchase History, Purchases, Stock Inventory, and Reports. Cashier gets POS and Customers. Accountant gets Customers, Suppliers, Sales History, Purchase History, Expenses, and Reports. Non-admin permissions can be configured; admin roles use their full defaults. Dashboard/help and personal print requests are available to all in the UI; Settings, Trash Bin, and print-request administration are admin-only. UI checks do not replace database/server authorization.

Cost visibility decision: Admin and Super Admin may view cost; Manager may view it only with at least one of `products`, `stock_inventory`, `purchases`, or `purchase_history`; Accountant may view it read-only through `purchase_history` or `reports`; Cashier never may. There is no Pharmacist role in the current app. The server rule exists in migrations; its effective production definition and table grants still require live verification.

## Business rules

- Persisted money columns and calculation fields use integer paisa; `sale_items.discount_percent` is numeric.
- Batch sale allocation uses FEFO: positive eligible stock only, `ACTIVE`/`NEAR_EXPIRY`, expiry today or later, then received date and ID for tie-breaking. Mongo sale and stock paths enforce shop-local sellability and are covered by unit/replica-set tests; legacy Supabase behavior still depends on the deployed RPC/schema.
- Expiry is a stock-batch field, not a medicine/product-master field. Product setup does not require expiry, but every purchase batch currently requires a future expiry date; no-expiry batches are not supported by the schema or sale/alert rules.
- Per-shop IANA timezones default to `Asia/Karachi`; sales and stock expiry/status/alert calculations receive one shop-local “today” value. The Karachi midnight boundary is tested at 19:00 UTC, including the local Mongo integration setup.
- Do not permit negative stock. Conditional stock updates and replica-set concurrency tests cover the API path; production operation remains unverified.
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

## Current status

- **Current checkout:** `feature/mongo-migration`. Phase 8 API coverage and Phase 9 local verification evidence are tracked in `docs/MONGO_MIGRATION.md`; manual UI and production security acceptance remain outstanding.
- The Supabase implementation remains intact as the alternate backend. Owner-reported migration/ACL state and source-only barcode/Trash Bin changes are historical context, not live verification; do not run Supabase operations as part of the Mongo migration.
- Existing UI behavior includes POS split tender, customer credit, cashier print requests, audited receipt-only print edits, role-based cost visibility, barcode/label workflows, stock alerts, and Trash Bin; API-mode adapters are implemented while manual acceptance remains pending.
- Security and runtime gates still open: production CORS/TLS and Mongo rate-limit load behavior, backup/restore proof, production deployment, demo data, and manual API-mode acceptance. Local security checks are recorded in `docs/MONGO_SECURITY_REPORT.md`; no penetration test was performed. Keep Supabase code and migrations untouched.

## Known issues and Later

- Multi-shop decisions are captured in `docs/MULTI_SHOP_FULL_PLAN.md` and `docs/MASTER_PLAN.md`; they are design references, not authority for unimplemented access paths or database changes.
- Legacy Supabase schema, migrations, RPCs, and ACLs may differ from checked-in source. No live verification was performed in this work; leave `supabase/` and its migrations untouched until approved cut-over.
- The Supabase baseline SQL is reconstructed, not a complete dump; timestamped rollback scripts are not forward migrations. Legacy barcode uniqueness, Supabase print/Trash Bin deployments, and physical scanner/printer behavior remain unverified; QR labels and direct ESC/POS support are not implemented.
- Existing Supabase mode and demo features may still use legacy or in-memory data. In API mode, listed modules use the Mongo API; backup/restore proof, production deployment, and manual UI acceptance remain open.

## Assumptions

- Split payments are represented by separate payment rows in `post_sale()` source; live tender settlement/reconciliation still needs staging verification.
- Admin modifications to pending print requests change the receipt snapshot for printing only; they do not rewrite the completed sale, inventory, or accounting records.
- Trash Bin records user soft-deletes/restores, product/supplier active-state changes, and purchase voids. Purchase records are not physically deleted or directly restorable.

## Changelog

- 2026-10-17 — Phase 8 API transport failures now show a themed retry screen in API mode; retry restores the cookie-backed session. Client test 6/6, lint/build passed; browser/shop-PC recovery remains unverified.
- 2026-10-17 — Added first-run setup status and wizard plus a one-transaction shop/Super Admin/settings/audit bootstrap guarded by expiring, hash-checked setup code. Setup batch root tests: 269 total (257 passed, 0 failed, 12 skipped); security tests 9/9; Compose Mongo integration 12/12; lint/build passed. Installer code generation/display and browser acceptance remain open.
- 2026-10-17 — Added a 20-entry fictional starter catalog and Super Admin-only transactional/idempotent importer; new entries are inactive, zero-priced, and have no stock. Current root tests: 272 total (259 passed, 0 failed, 13 skipped); focused catalog tests 2/2; security 9/9; Compose Mongo 13/13; lint/build passed; runtime image contains all 20 entries. Production and shop-PC use remain unverified.
- 2026-10-17 — Added a loopback-only single-PC installer with isolated Compose project naming and expiring one-time setup code provisioning. PowerShell parser, Compose config, root tests (272 total; 259 passed, 0 failed, 13 skipped), lint/build, and Compose Mongo (13/13) passed. The installer has not been run against an actual shop; LAN HTTPS/production remains unverified.
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

<!-- AUTO:START -->
Generated at (UTC): 2026-10-18T08:23:12.510Z
Git branch: feature/mongo-migration

Last 5 commit subjects:
- docs: record catalog verification status
- feat: add safe starter catalog import
- feat: add first-run pharmacy setup
- feat: add API unavailable retry screen
- feat: expose scoped admin audit log

Validation commands: `npm run lint`, `npm test`, and `npm run build`.

Environment variable names from .env.example files (values are not read into this block):
- APP_URL
- BOOTSTRAP_SHOP_SLUG
- COMPOSE_PROJECT_NAME
- DEMO_MODE
- GEMINI_API_KEY
- JWT_ACCESS_SECRET
- MONGO_APP_DB
- MONGO_APP_PASSWORD
- MONGO_APP_USERNAME
- MONGO_REPLICA_KEY
- MONGO_ROOT_PASSWORD
- MONGO_ROOT_USERNAME
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
