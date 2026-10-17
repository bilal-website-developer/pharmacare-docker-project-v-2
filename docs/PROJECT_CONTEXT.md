# Project Context

## Quick start for any AI

Read this whole file before doing anything. If the code and this file disagree, the code is right: fix this file.

## Project summary

Pharma Care is a pharmacy point-of-sale (POS), inventory, purchasing, customer/accounting, and staff-management web app. On `feature/mongo-migration`, a Node 22/Fastify/MongoDB API and Docker packaging are being added while legacy Supabase paths remain available. Phases 0–7 have server-side implementation; Phase 8 has API wiring for auth/session, Stock Alerts, Products/Stock Products, Suppliers, POS catalog/settings/sales, Customer Ledger, Sales History, Master Data, Cash Book/expenses, Print Requests, Manage Users, Returns, Purchases/History, Dashboard/Business Analytics, and Trash Bin. Full print/label parity, manual UI acceptance, and production verification remain open.

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
- `src/components/CustomerLedgerScreen.tsx`, `Customers`-related screens in `src/components/`: customer balances, ledger, and payment slips. Some data remains demo/in-memory; inspect the current page before assuming persistence.
- `src/components/ManageUsersView.tsx`, `src/permissions.tsx`, `src/utils/auth.ts`: staff, roles, UI permission checks, and profile/auth helpers.
- Other feature screens in `src/components/` include Dashboard, Reports, Suppliers, Cash Book, Controlled Drugs, Master Data, and print-request administration.
- `src/utils/`, `src/types/`, `src/data/`: reusable logic, TypeScript domain shapes, API data adapters, and mock pharmacy data.
- `supabase/migrations/`, `supabase/functions/`, `supabase/baseline/`: database migrations, Edge Functions, and a supplied schema snapshot.
- `server/`: Fastify/TypeScript API, MongoDB replica-set initializer, auth/user/catalog/purchase/stock/sales/customer/Phase 7 routes, transaction repositories, first-run super-admin CLI, and a Compose-only real-Mongo test runner.
- `docker/`, `docker-compose.yml`, `Dockerfile`: local Mongo/API/web container setup and Nginx configuration. See `docs/DOCKER.md`.
- `docs/`: database references, `MASTER_PLAN.md`, `MULTI_SHOP_FULL_PLAN.md`, execution progress, redesign notes, and this context.
- `scripts/`, `.githooks/`: context generation and commit-hook tooling.
- `public/`: static assets and fonts.

## Data and storage

- Supabase Auth/Postgres: shared across clients connected to the same configured project. Products, Stock Inventory, and purchase workflows use server RPCs; Suppliers still has direct table reads/writes. Authorization and persistence are not uniform across every screen.
- Supabase Edge Functions: the `manage-users` function exists; print approval, requester-name listing, audited receipt-only modification, and profile Trash Bin events use database RPCs/Edge Functions.
- Browser `localStorage`: per-browser/device preferences, saved inventory views, purchase drafts, receipt settings, per-user stock-alert keys seen, and other UI settings. These do not synchronize across counters.
- Mixed persistence: `VITE_BACKEND=supabase` retains the legacy Supabase behavior. API-mode adapters cover auth/session, Stock Alerts, Products/Stock Products, Suppliers, POS catalog, Settings, Sales/POS/Customer Ledger/Sales History, Master Data, Cash Book/expenses, Print Requests, Manage Users, Returns, Purchases/History, Dashboard/Business Analytics, and Trash Bin. Some print/label parity remains open; production and manual UI behavior remain unverified.
- Other storage: unknown; no general file/object-storage workflow is established by the checked-in frontend docs.
- Shared production data behavior depends on Supabase deployment and the live schema, which may differ from checked-in migrations.
- The local Docker stack contains authenticated MongoDB on a private network and a Fastify API with health, auth, Manage Users, catalog, purchase, stock, sales, and Phase 7 routes. Local Compose startup, Mongo initialization/index creation, service health checks, `/api/health` proxy, and the targeted real-Mongo integration suite have passed. This is not production or manual UI acceptance. Legacy Supabase paths remain available.

## Roles and permissions

Role names in `src/types/pharmacy.ts`: `admin`, `super_admin`, `manager`, `cashier`, `accountant`.

Frontend permission keys in `src/permissions.tsx`: `pos`, `products`, `categories`, `suppliers`, `customers`, `sales_history`, `purchase_history`, `purchases`, `expenses`, `stock_inventory`, `reports`, `manage_users`, plus POS print toggles `pos_print_sale` and `pos_print_payment`. The new API additionally allows `stock_alerts` to meet the migration contract.

UI defaults: Admin and Super Admin get every module. Manager gets POS, Products, Categories, Suppliers, Customers, Sales History, Purchase History, Purchases, Stock Inventory, and Reports. Cashier gets POS and Customers. Accountant gets Customers, Suppliers, Sales History, Purchase History, Expenses, and Reports. Non-admin permissions can be configured; admin roles use their full defaults. Dashboard/help and personal print requests are available to all in the UI; Settings, Trash Bin, and print-request administration are admin-only. UI checks do not replace database/server authorization.

Cost visibility decision: Admin and Super Admin may view cost; Manager may view it only with at least one of `products`, `stock_inventory`, `purchases`, or `purchase_history`; Accountant may view it read-only through `purchase_history` or `reports`; Cashier never may. There is no Pharmacist role in the current app. The server rule exists in migrations; its effective production definition and table grants still require live verification.

## Business rules

- Persisted money columns and calculation fields use integer paisa; `sale_items.discount_percent` is numeric.
- Batch sale allocation in `src/utils/fefo.ts` uses FEFO: positive eligible stock only, `ACTIVE`/`NEAR_EXPIRY`, expiry today or later, then received date and ID for tie-breaking. It rejects an insufficient allocation rather than returning a partial sale. Server-side enforcement depends on the deployed RPC/schema and must be verified there.
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

- **Current checkout:** `feature/mongo-migration`. Phase 8 coverage and current test evidence are tracked in `docs/MONGO_MIGRATION.md`; all manual UI and production acceptance remain outstanding.
- The Supabase implementation remains intact as the alternate backend. Owner-reported migration/ACL state and source-only barcode/Trash Bin changes are historical context, not live verification; do not run Supabase operations as part of the Mongo migration.
- Existing UI behavior includes POS split tender, customer credit, cashier print requests, audited receipt-only print edits, role-based cost visibility, barcode/label workflows, stock alerts, and Trash Bin; API-mode replacements are still incomplete for several screens.
- Security and runtime gates still open: verify the production Supabase ACL only if separately authorized, complete Mongo route-wide security checks, and obtain manual API-mode acceptance before cut-over. Keep Supabase code and migrations untouched.

## Known issues and Later

- Multi-shop decisions are captured in `docs/MULTI_SHOP_FULL_PLAN.md` and `docs/MASTER_PLAN.md`; they are design references, not authority for unimplemented access paths or database changes.
- Legacy Supabase schema, migrations, RPCs, and ACLs may differ from checked-in source. No live verification was performed in this work; leave `supabase/` and its migrations untouched until approved cut-over.
- The Supabase baseline SQL is reconstructed, not a complete dump; timestamped rollback scripts are not forward migrations. Legacy barcode uniqueness, Supabase print/Trash Bin deployments, and physical scanner/printer behavior remain unverified; QR labels and direct ESC/POS support are not implemented.
- Existing application screens still include mock/in-memory data. Dashboard/Business Analytics, Products/Stock Products, and Trash Bin use API data in API mode; remaining print/label parity is open, and Mongo screen cut-over is incomplete.
- Mongo API routes and targeted tests exist, but route-wide security hardening, backup/restore proof, production deployment, full screen migration, and manual UI acceptance remain open.

## Assumptions

- Split payments are represented by separate payment rows in `post_sale()` source; live tender settlement/reconciliation still needs staging verification.
- Admin modifications to pending print requests change the receipt snapshot for printing only; they do not rewrite the completed sale, inventory, or accounting records.
- Trash Bin records user soft-deletes/restores, product/supplier active-state changes, and purchase voids. Purchase records are not physically deleted or directly restorable.

## Changelog

- 2026-10-17 — Products/Stock Products API wiring, CSV unit barcodes, and server-computed margin DTOs added. Root tests: 250 total, 239 passed, 0 failed, 11 skipped; lint/build passed. Manual UI acceptance remains open.
- 2026-10-17 — Trash Bin API wiring and transactional deactivation/purchase-void events added. Root tests: 254 total, 243 passed, 0 failed, 11 skipped; Compose tests: 11 passed, 0 failed, 0 skipped; lint/build passed. Manual UI acceptance remains open.
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
Generated at (UTC): 2026-10-17T09:39:43.099Z
Git branch: feature/mongo-migration

Last 5 commit subjects:
- feat: wire Products module to Mongo API
- feat: wire dashboard and business analytics
- test: verify phase seven dashboard and cash controls
- fix: align product expiry dates with shop timezone
- docs: record mongo init runtime verification

npm scripts:
- - `dev`: `vite --port=3000 --host=0.0.0.0`
- - `build:web`: `vite build`
- - `build`: `npm run build:web && npm --prefix server run build`
- - `seed:superadmin`: `docker compose exec api npm run seed:superadmin`
- - `preview`: `vite preview`
- - `clean`: `rm -rf dist server.js`
- - `prepare`: `node scripts/setup-hooks.mjs`
- - `context:update`: `node scripts/update-context.mjs`
- - `lint`: `tsc --noEmit && npm --prefix server run lint`
- - `test:fefo`: `tsx --test src/utils/fefo.test.ts`
- - `test:receipt`: `tsx --test src/utils/receipt.test.ts`
- - `test:inventory-ui`: `tsx --test src/components/inventory/inventoryUiLogic.test.ts`
- - `test:stock-inventory`: `tsx --test src/components/inventory/stockInventoryLogic.test.ts`
- - `test:inventory-products`: `tsx --test src/components/inventory/productImportLogic.test.ts`
- - `test:stock-alerts`: `tsx --test src/data/stockAlertLogic.test.ts`
- - `test:pos-catalog`: `tsx --test src/data/posCatalogLogic.test.ts`
- - `test:sales`: `tsx --test src/data/sales.test.ts`
- - `test:finance`: `tsx --test src/data/finance.test.ts`
- - `test:business-reports`: `tsx --test src/data/businessReports.test.ts`
- - `test:products-api`: `tsx --test src/data/products.test.ts`
- - `test:customer-ledger`: `tsx --test src/data/customerLedger.test.ts`
- - `test:shop-settings`: `tsx --test src/data/shopSettings.test.ts`
- - `test:product-filters`: `tsx --test src/components/inventory/productFilterLogic.test.ts`
- - `test:master-data`: `tsx --test src/components/masterDataSimilarity.test.ts`
- - `test:master-data-api`: `tsx --test src/data/masterData.test.ts`
- - `test:suppliers`: `tsx --test src/data/suppliers.test.ts`
- - `test:print-snapshot`: `tsx --test src/utils/printSnapshot.test.ts`
- - `test:print-requests-api`: `tsx --test src/data/printRequests.test.ts`
- - `test:manage-users-api`: `tsx --test src/data/manageUsers.test.ts`
- - `test:sale-returns-api`: `tsx --test src/data/saleReturns.test.ts`
- - `test:purchases-api`: `tsx --test src/data/purchases.test.ts`
- - `test:print-request-editor`: `tsx --test src/utils/printRequestEditor.test.ts`
- - `test:trash-bin`: `tsx --test src/utils/trashBin.test.ts`
- - `test:trash-bin-api`: `tsx --test src/data/trashBin.test.ts`
- - `test:report`: `tsx --test src/utils/salesReport.test.ts`
- - `test:discount`: `tsx --test src/utils/discount.test.ts`
- - `test:barcode-scanner`: `tsx --test src/utils/useBarcodeScanner.test.ts`
- - `test:labels`: `tsx --test src/utils/labelUtils.test.ts`
- - `test:permissions`: `tsx --test src/permissions.test.ts`
- - `test:manage-users-policy`: `tsx --test supabase/functions/manage-users/policy.test.ts`
- - `test:api-client`: `tsx --test src/api/client.test.ts`
- - `test:server`: `npm --prefix server test`
- - `test`: `npm run test:fefo && npm run test:receipt && npm run test:inventory-ui && npm run test:stock-inventory && npm run test:inventory-products && npm run test:stock-alerts && npm run test:pos-catalog && npm run test:sales && npm run test:finance && npm run test:business-reports && npm run test:products-api && npm run test:customer-ledger && npm run test:shop-settings && npm run test:product-filters && npm run test:master-data && npm run test:master-data-api && npm run test:suppliers && npm run test:print-snapshot && npm run test:print-requests-api && npm run test:manage-users-api && npm run test:sale-returns-api && npm run test:purchases-api && npm run test:print-request-editor && npm run test:trash-bin && npm run test:trash-bin-api && npm run test:report && npm run test:discount && npm run test:barcode-scanner && npm run test:labels && npm run test:permissions && npm run test:manage-users-policy && npm run test:api-client && npm run test:server`

Dependencies and versions:
- - `@e965/xlsx` ^0.20.3 (dependency)
- - `@google/genai` ^2.4.0 (dependency)
- - `@supabase/supabase-js` ^2.117.3 (dependency)
- - `@tailwindcss/vite` ^4.3.3 (dependency)
- - `@types/express` ^4.17.21 (devDependency)
- - `@types/node` ^22.14.0 (devDependency)
- - `@types/react-dom` ^19.3.0 (devDependency)
- - `@types/react` ^19.3.0 (devDependency)
- - `@vitejs/plugin-react` ^6.1.1 (dependency)
- - `autoprefixer` ^10.4.21 (devDependency)
- - `dotenv` ^17.2.3 (dependency)
- - `esbuild` ^0.28.0 (devDependency)
- - `express` ^4.21.2 (dependency)
- - `jsbarcode` 3.12.3 (dependency)
- - `lucide-react` ^0.546.0 (dependency)
- - `motion` ^12.23.24 (dependency)
- - `react-dom` ^19.0.1 (dependency)
- - `react` ^19.0.1 (dependency)
- - `tailwindcss` ^4.3.3 (devDependency)
- - `tsx` ^4.21.0 (devDependency)
- - `typescript` ^7.0.2 (devDependency)
- - `vite` ^8.3.0 (dependency)

src/ tree (maximum two directory levels):
```text
src/
  src/api/
    src/api/client.test.ts
    src/api/client.ts
    src/api/config.ts
    src/api/index.ts
  src/App.tsx
  src/components/
    src/components/BarcodeScannerTest.tsx
    src/components/CashBookScreen.tsx
    src/components/ControlledDrugScreen.tsx
    src/components/CustomerLedgerScreen.tsx
    src/components/DashboardView.tsx
    src/components/DiscountBox.tsx
    src/components/EndOfDayModal.tsx
    src/components/GlowCredit.css
    src/components/GlowCredit.tsx
    src/components/HelpSupportView.tsx
    src/components/inventory/
    src/components/InventoryScreen.tsx
    src/components/labels/
    src/components/LoginView.tsx
    src/components/ManageUsersView.tsx
    src/components/masterDataSimilarity.test.ts
    src/components/masterDataSimilarity.ts
    src/components/MasterDataView.tsx
    src/components/MyPrintRequestsView.tsx
    src/components/PharmaLogo.css
    src/components/PharmaLogo.tsx
    src/components/POSBillingView.tsx
    src/components/POSScreen.tsx
    src/components/PrintRequestsAdminView.tsx
    src/components/PrintSalesReport.tsx
    src/components/PurchaseHistoryView.tsx
    src/components/ReportsScreen.tsx
    src/components/RepositoryReviewView.tsx
    src/components/returns/
    src/components/SettingsView.tsx
    src/components/Sidebar.tsx
    src/components/StockAlertBell.tsx
    src/components/StockPurchaseView.tsx
    src/components/SuppliersView.tsx
    src/components/TemplatePreviewModal.tsx
    src/components/TopNav.tsx
    src/components/TrashBinView.tsx
    src/components/WhatsAppRemindersView.tsx
  src/config/
    src/config/developer.ts
  src/constants/
    src/constants/brand.ts
  src/data/
    src/data/businessReports.test.ts
    src/data/businessReports.ts
    src/data/customerLedger.test.ts
    src/data/finance.test.ts
    src/data/finance.ts
    src/data/manageUsers.test.ts
    src/data/manageUsers.ts
    src/data/masterData.test.ts
    src/data/masterData.ts
    src/data/mockPharmacyData.ts
    src/data/posCatalog.ts
    src/data/posCatalogLogic.test.ts
    src/data/posCatalogLogic.ts
    src/data/printRequests.test.ts
    src/data/printRequests.ts
    src/data/products.test.ts
    src/data/products.ts
    src/data/purchases.test.ts
    src/data/purchases.ts
    src/data/returnLogic.test.ts
    src/data/returnLogic.ts
    src/data/saleReturns.test.ts
    src/data/saleReturns.ts
    src/data/sales.test.ts
    src/data/sales.ts
    src/data/shopSettings.test.ts
    src/data/shopSettings.ts
    src/data/stockAlertLogic.test.ts
    src/data/stockAlertLogic.ts
    src/data/stockAlerts.test.ts
    src/data/stockAlerts.ts
    src/data/stockInventory.ts
    src/data/suppliers.test.ts
    src/data/suppliers.ts
    src/data/trashBin.test.ts
    src/data/trashBin.ts
  src/index.css
  src/main.tsx
  src/permissions.test.ts
  src/permissions.tsx
  src/types/
    src/types/pharmacy.ts
  src/utils/
    src/utils/auth.ts
    src/utils/discount.test.ts
    src/utils/discount.ts
    src/utils/fefo.test.ts
    src/utils/fefo.ts
    src/utils/fetchAllSupabaseRows.ts
    src/utils/labelUtils.test.ts
    src/utils/labelUtils.ts
    src/utils/printRequestEditor.test.ts
    src/utils/printRequestEditor.ts
    src/utils/printRequestTypes.ts
    src/utils/printSnapshot.test.ts
    src/utils/printSnapshot.ts
    src/utils/printWorkflow.ts
    src/utils/receipt.test.ts
    src/utils/receipt.ts
    src/utils/salesReport.test.ts
    src/utils/salesReport.ts
    src/utils/stockAlertsEvents.ts
    src/utils/storageMigration.ts
    src/utils/storeSettings.ts
    src/utils/supabase.ts
    src/utils/supabaseError.test.ts
    src/utils/supabaseError.ts
    src/utils/trashBin.test.ts
    src/utils/trashBin.ts
    src/utils/useBarcodeScanner.test.ts
    src/utils/useBarcodeScanner.ts
```

Test files:
- server/src/app.test.ts
- server/src/auth-crypto.test.ts
- server/src/auth-routes.test.ts
- server/src/business-time.test.ts
- server/src/catalog.test.ts
- server/src/config.test.ts
- server/src/policy.test.ts
- server/src/sales.test.ts
- server/src/stock.test.ts
- server/src/user-routes.test.ts
- src/api/client.test.ts
- src/components/inventory/inventoryUiLogic.test.ts
- src/components/inventory/productFilterLogic.test.ts
- src/components/inventory/productImportLogic.test.ts
- src/components/inventory/stockInventoryLogic.test.ts
- src/components/masterDataSimilarity.test.ts
- src/data/businessReports.test.ts
- src/data/customerLedger.test.ts
- src/data/finance.test.ts
- src/data/manageUsers.test.ts
- src/data/masterData.test.ts
- src/data/posCatalogLogic.test.ts
- src/data/printRequests.test.ts
- src/data/products.test.ts
- src/data/purchases.test.ts
- src/data/returnLogic.test.ts
- src/data/saleReturns.test.ts
- src/data/sales.test.ts
- src/data/shopSettings.test.ts
- src/data/stockAlertLogic.test.ts
- src/data/stockAlerts.test.ts
- src/data/suppliers.test.ts
- src/data/trashBin.test.ts
- src/permissions.test.ts
- src/utils/discount.test.ts
- src/utils/fefo.test.ts
- src/utils/labelUtils.test.ts
- src/utils/printRequestEditor.test.ts
- src/utils/printSnapshot.test.ts
- src/utils/receipt.test.ts
- src/utils/salesReport.test.ts
- src/utils/supabaseError.test.ts
- src/utils/trashBin.test.ts
- src/utils/useBarcodeScanner.test.ts
- supabase/functions/manage-users/policy.test.ts

Environment variable names from .env.example files (values are not read into this block):
- APP_URL
- BOOTSTRAP_SHOP_SLUG
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
- SUPABASE_ANON_KEY
- SUPABASE_URL
- VITE_BACKEND
- VITE_SHOP_SLUG
- VITE_SUPABASE_ANON_KEY
- VITE_SUPABASE_URL
<!-- AUTO:END -->
