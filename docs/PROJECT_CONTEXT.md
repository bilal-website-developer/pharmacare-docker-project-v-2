# Project Context

## Quick start for any AI

Read this whole file before doing anything. If the code and this file disagree, the code is right: fix this file.

## Project summary

Pharma Care is a pharmacy point-of-sale (POS), inventory, purchasing, customer/accounting, and staff-management web app. Its users include cashiers, managers, accountants, admins, and super admins. It is a Vite + React + TypeScript frontend with Tailwind CSS, Supabase Auth/Postgres/Edge Functions, and SQL migrations. Current maturity: actively developed; several core catalog and stock workflows are server-backed, while other screens still use mock, in-memory, or browser-local data. This checkout is not a complete production backend/API.

## How to run

Commands below are defined by `package.json`; run from the repository root:

```sh
npm install
npm run dev
npm run lint
npm test
npm run build
```

Vite serves on port 3000. `npm test` runs the project's registered unit tests; see the generated test-file list below for coverage.

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
- `src/utils/`, `src/types/`, `src/data/`: reusable logic, TypeScript domain shapes, and mock pharmacy data.
- `supabase/migrations/`, `supabase/functions/`, `supabase/baseline/`: database migrations, Edge Functions, and a supplied schema snapshot.
- `docs/`: database references, `MASTER_PLAN.md`, `MULTI_SHOP_FULL_PLAN.md`, execution progress, redesign notes, and this context.
- `scripts/`, `.githooks/`: context generation and commit-hook tooling.
- `public/`: static assets and fonts.

## Data and storage

- Supabase Auth/Postgres: shared across clients connected to the same configured project. Products, Stock Inventory, and purchase workflows use server RPCs; Suppliers still has direct table reads/writes. Authorization and persistence are not uniform across every screen.
- Supabase Edge Functions: the `manage-users` function exists; print approval, requester-name listing, audited receipt-only modification, and profile Trash Bin events use database RPCs/Edge Functions.
- Browser `localStorage`: per-browser/device preferences, saved inventory views, purchase drafts, receipt settings, per-user stock-alert keys seen, and other UI settings. These do not synchronize across counters.
- Mixed persistence: the active POS catalog and sales use `pos_catalog()` and `post_sale()` RPCs; customer/ledger and sales-history paths also use RPCs. Dashboard stock/expiry KPIs still use `INITIAL_PRODUCTS` sample data, and Cash Book transactions/expenses remain React in-memory state. `POSScreen` and controlled-drug sample types are legacy/unreferenced paths; confirm each active page before relying on its data source.
- Other storage: unknown; no general file/object-storage workflow is established by the checked-in frontend docs.
- Shared production data behavior depends on Supabase deployment and the live schema, which may differ from checked-in migrations.

## Roles and permissions

Role names in `src/types/pharmacy.ts`: `admin`, `super_admin`, `manager`, `cashier`, `accountant`.

Permission keys in `src/permissions.tsx`: `pos`, `products`, `categories`, `suppliers`, `customers`, `sales_history`, `purchase_history`, `purchases`, `expenses`, `stock_inventory`, `reports`, `manage_users`, plus POS print toggles `pos_print_sale` and `pos_print_payment`.

UI defaults: Admin and Super Admin get every module. Manager gets POS, Products, Categories, Suppliers, Customers, Sales History, Purchase History, Purchases, Stock Inventory, and Reports. Cashier gets POS and Customers. Accountant gets Customers, Suppliers, Sales History, Purchase History, Expenses, and Reports. Non-admin permissions can be configured; admin roles use their full defaults. Dashboard/help and personal print requests are available to all in the UI; Settings, Trash Bin, and print-request administration are admin-only. UI checks do not replace database/server authorization.

Cost visibility decision: Admin and Super Admin may view cost; Manager may view it only with at least one of `products`, `stock_inventory`, `purchases`, or `purchase_history`; Accountant may view it read-only through `purchase_history` or `reports`; Cashier never may. There is no Pharmacist role in the current app. The server rule exists in migrations; its effective production definition and table grants still require live verification.

## Business rules

- Persisted money columns and calculation fields use integer paisa; `sale_items.discount_percent` is numeric.
- Batch sale allocation in `src/utils/fefo.ts` uses FEFO: positive eligible stock only, `ACTIVE`/`NEAR_EXPIRY`, expiry today or later, then received date and ID for tie-breaking. It rejects an insufficient allocation rather than returning a partial sale. Server-side enforcement depends on the deployed RPC/schema and must be verified there.
- Expiry is a stock-batch field, not a medicine/product-master field. Product setup does not require expiry, but every purchase batch currently requires a future expiry date; no-expiry batches are not supported by the schema or sale/alert rules.
- Do not permit negative stock. Verify the server transaction and constraints as well as frontend allocation before relying on this in production.
- Stock alerts use sellable stock from positive, unexpired (`expiry_date >= current_date`), `ACTIVE`/`NEAR_EXPIRY` batches for active medicines. Alert low/out counts require `min_stock_alert > 0`; the alert RPC returns no cost, MRP, supplier, or cost-derived value and is available to every active, non-deleted profile regardless of module permission. The existing Products `out_of_stock` KPI does not apply the positive-reorder-threshold condition, so its count may exceed alert out counts. Owner-supplied live results show `stock_alerts_summary` exists with anon EXECUTE false/authenticated true; no migration-history result or end-to-end behavior was supplied.
- Cost and profit/margin are internal data, not Pharmacy Memo print fields. Receipt rendering displays sale amounts/totals and is styled black on white. Do not add cost, purchase price, profit, or margin to customer-facing slips.
- Cost-bearing base tables stay inaccessible to `anon` and `authenticated`; read cost only through permission-checked RPCs. Do not grant direct `SELECT` on `stock_batches`, because its RLS read policy includes `pos` and exposes all selectable columns to Cashier.
- Pharmacy Memo supports 58mm and 80mm thermal layouts (and A4); black text on white background. Return/payment memo rendering exists. A source-level sale-return request/review workflow is wired in POS; live end-to-end behavior remains unverified.
- Implemented return policy in source and migration: only sealed, intact, same-sale-batch units meeting configured shelf-life/window/class/storage rules may be restocked; a Manager/Admin must approve, with `sales_history` and `stock_inventory` required for restock. Cashiers with POS may request returns but cannot approve. `QUARANTINE` and `WRITE_OFF` do not increase sellable stock. Refunds use original line totals in integer paisa; credit-sale returns update customer credit/ledger. Cumulative returns cannot exceed sold quantity, while multiple partial-return transactions are allowed. Owner reports the migration applied; runtime and accounting reconciliation remain unverified.
- Invoice, memo, and purchase numbers are planned to be sequential and unique per shop. Gap-free numbering is not promised unless concurrency, rollback, retry, and failure tests prove it. Current checkout does not establish persisted server-side invoice/memo allocators; enforcement remains unknown.

## Conventions and decisions

- Keep business logic in reusable pure helpers when practical, with tests alongside the helper.
- Use server RPCs for workflows needing atomic multi-table writes or server-side filtering/authorization; use Supabase directly only where the current code does so intentionally.
- Keep client-facing cost fields nullable/redacted by the server when visibility is denied; never turn unknown cost into zero in UI.
- Date: 2026-10-10 — Inventory lists, statistics, movements, adjustments, and write-offs use stock RPCs to keep paging/filtering and mutations server-side.
- Date: 2026-10-10 — Product data uses server-side list/stat/import RPCs; cost visibility is decided server-side rather than trusted to client hiding.
- Date: 2026-10-13 — Stock alerts are server-counted, visible to every active signed-in profile, and never include cost-bearing fields. Navigation is permission-gated in the header; seen alert keys are per-user and browser-local. Owner reports the `stock_alerts_summary(integer)` RPC metadata is verified: `SECURITY DEFINER`, `search_path=public`, anon execute false, authenticated execute true.
- Date: 2026-10-13 — Owner reports the corrected `20261013160000_persist_sales_and_returns.sql` migration applied. Owner-shared metadata query verified `SECURITY DEFINER`, `search_path=public`, `anon EXECUTE=false`, and `authenticated EXECUTE=true` for its 13 RPCs and `pos_catalog()`. End-to-end behavior remains unverified. Return totals are capped cumulatively at the sold quantity; multiple partial-return transactions remain possible.
- Date: 2026-10-12 — Cost access is role-and-permission scoped by `can_view_cost()`; Cashier is always denied, Accountants are read-only, and Manager access requires a relevant module permission. Verify the deployed function and table grants in Supabase.
- Date: 2026-10-09 — Pharmacy Memo uses a shared sanitized renderer for 58mm/80mm and A4; template and paper preferences remain browser-local because shared settings storage is not implemented.

## Current status

- **Current checkout:** branch `feature/mongo-migration`, based on the clean `security/revoke-public-execute` checkout at `17dfc05` (`blabla`). Phase 0 Mongo migration inventory is in `docs/MONGO_MIGRATION_INVENTORY.md`; no application code, SQL, live database, or deployment was changed.
- **Added; migration owner-reported applied and RPC ACL checked:** Header Stock Alert Bell, accessible alert panel, per-user unseen indicators, permission-aware Products/Stock Inventory navigation, and stock-change refresh events. `stock_alerts_summary(integer)` and its rollback are in `supabase/migrations/20261013140000_stock_alerts_summary.sql` and `supabase/rollback/rollback_20261013140000_stock_alerts_summary.sql`; alert counts/data and UI behavior still need runtime testing.
- **Verified in history:** The low-stock alert feature is committed as `da7ed5d` on `feature/low-stock-alerts`; it is present in that commit, not missing from the repository history.
- **Fixed in `b62b547`:** Product-controlled label text is HTML-escaped in generated print markup using the shared receipt helper; hostile markup and quoted attribute payloads are covered by tests. The existing receipt/memo rendering behavior is unchanged.
- **Done:** Phase 1 barcode validation and server-side generation work for `medicines.barcode`: reusable EAN-13 validation helpers, barcode renderer error handling, and product-page bulk generation actions. The corresponding migration files are staged under `supabase/migrations/20261012180000_assign_medicine_barcodes.sql` and the companion unique-index migration.
- **Done:** Product barcode labels now open a dedicated print dialog with size/copies/field controls and a live preview; the old raw popup path was replaced by the reusable label dialog while preserving the product-page barcode generation flow.
- **Done:** Products and Master Data redesigns; Stock Inventory UI and server-function consumers; shared receipt renderer, POS printing, and print-request approval workflow. The owner reported Phase 4a migrations were run and verified. `docs/REDESIGN_PROGRESS.md` still labels Phase 4 pending; the newer source and owner report supersede that stale status.
- **Added:** Barcode/labeling agent prompt at `docs/barcode-labels-agent-prompt.md` for follow-up product barcode generation, assignment, and print workflow work. UI and server-function consumers; shared receipt renderer, POS printing, and print-request approval workflow. The owner reported Phase 4a migrations were run and verified. `docs/REDESIGN_PROGRESS.md` still labels Phase 4 pending; the newer source and owner report supersede that stale status.
- **In progress:** Purchases and Purchase History use RPCs. The owner reports that 4c's direct-table revokes are applied and verified in the test-data Supabase project. Verify the deployed `can_view_cost()` definition and table grants before release.
- **In progress:** Products compact filter toolbar: debounced search, wrapping filter pills, removable active-filter chips, and a tested clear-all/reset helper. No RPC or database behavior changed.
- **Done:** Manage Users list handling now falls back safely when response fields are absent and reports a likely stale `manage-users` deployment instead of crashing.
- **Owner-reported applied; source verified:** POS checkout posts sales through `post_sale`, supports server-recorded cash/online/credit/split payments, and updates customer credit state. Owner reports `20261013160000_persist_sales_and_returns.sql` applied successfully after fixing two SQL syntax errors, and shared query results verify selected RPC ACL/security metadata. Runtime sale/return behavior has not yet been verified.
- **SQL Editor corrections:** Fixed the apostrophe in the payment exception text (`customer''s`) and the missing empty-array fallback closing expression in `pending_sale_returns()`.
- **Done in source (migration pending deployment):** Cashier print requests submit without a confirmation prompt; admin review displays requester names and can modify pending sale receipt snapshots with audited server-side validation. Changes are receipt-only and do not change completed sale records.
- **Done in source (migration/Edge Function deployment pending):** Admin Trash Bin lists user deletions/restorations, product/supplier deactivations/restorations, and purchase voids with actor names, time, reason, entity filters, and only safe restore actions.
- **Implemented locally:** Barcode validation, medicine-level EAN-13 generation and bulk assignment RPC files, and barcode printing are present. Client package commit `818af6c` adds Edit/Print/Make actions on product rows, cards, and a product-details dialog; per-product label quantities (1–200) with a 1,000-label job cap; a scanner test dialog; and fast keyboard-scanner handling in Products search and POS. Label printing requires an assigned barcode; it no longer falls back to the product code. Missing barcode-generation RPCs show an explicit notice. This package changed no SQL/schema and applied no migration. Real scanner/printer hardware remains untested.
- **W6 TypeScript baseline:** `strict` and `noUnusedParameters` are enabled after both command-line measurements returned zero diagnostics. `noUnusedLocals` remains disabled because its 16 remaining diagnostics are in preserved components and the retained `RepositoryReviewView` import. The broader source cleanup is committed as `cce45bb`; ESLint packages/config remain pending owner approval and TypeScript 7 compatibility review. Details and release-date evidence are in `docs/EXECUTION_PROGRESS.md`.
- **W7 client bundle optimization:** Sidebar screens and modal views load on demand (Dashboard, login, and shell remain eager); Purchase History XLSX, receipt print workflow, and barcode label code are deferred until used. Loading and retryable screen-error states are present. First-load production gzip measured 172.26 kB, down from 418.24 kB and below the 200 kB target. Lint, tests, and build pass; see `docs/EXECUTION_PROGRESS.md` for emitted chunk sizes. Physical slow/offline-network and route-refresh checks remain manual.
- **Security ACL plan:** Owner-reported live ACL audit found `stock_batches` and the other four 4c cost-bearing tables revoked; a later `stock_batches` grant had undone its revoke once. Reassert revokes in the new lockdown migration. Staged files A-D and rollback scripts are proposals only and have not been applied. The owner reports profile DML already revoked; file D reasserts that state.
- **Next:** Mongo migration work is gated by owner review of `docs/MONGO_MIGRATION_INVENTORY.md` and its open questions. The pre-migration Supabase branch remains unchanged. Existing staging bootstrap and hardware verification items remain open on their respective branches.

## Known issues and Later

- Owner-approved multi-shop decisions and the detailed implementation plan are in `docs/MULTI_SHOP_FULL_PLAN.md` and `docs/MASTER_PLAN.md`: one user per shop; Super Admin has a separate audited target-shop catalog-seeding write but no general business-data access; emergency-only, explicitly audited support access where technically possible; suspension blocks sign-in and business operations; licence/billing dates deferred; staff-selectable Settings, while shop Admins retain all own-shop modules and cannot edit identity. Shop identity/receipt details must use one server-backed profile. No implementation or database changes have been made for these decisions.
- Current code still grants Admin roles every module and keeps Settings Admin-only; the approved staff Settings checkbox, per-shop profile, and Super Admin-only identity editing are plan-only and unimplemented. Apply only after the staging and ACL gates.
- DBCode VS Code extension reported a SQL language-server startup timeout followed by closed connections in editor logs on 2026-10-13; the exact cause is unknown and no database operation or project runtime failure is indicated by those log lines.
- Live Supabase schema/RPC availability may lag behind checked-in migrations; verify migration state before diagnosing app behavior.
- Readiness: owner-supplied live catalog/ACL results (2026-10-14) show expected return tables/functions exist; no migration-history result was supplied, so applied status for the sales/returns migration remains unverified. Return tables have RLS enabled (not forced) and anon/authenticated direct CRUD privileges false. Earlier results showed anon EXECUTE true for 16 SECURITY DEFINER functions; owner now reports running the anon-EXECUTE migration, but the post-migration query output is missing, so the fix remains unverified. Authenticated privileges on several RLS-protected tables remain pending policy/column review. Cashier cost-column access, prescription enforcement, Cash Book persistence, Dashboard sample stock data, return payout recording and return reporting remain open.
- A previous sign-in error was reported, but current authentication/runtime status was not tested in this audit. POS source requires active medicine, configured units, and positive eligible stock; the stock alert function requires `min_stock_alert > 0` for both low and out alerts.
- The print-request requester-name and modify RPCs in `20261012160000_modify_print_requests.sql` are local until that migration is applied to the target Supabase project.
- Trash Bin event schema/triggers/listing/restore RPCs in `20261012170000_trash_bin_history.sql` and the updated `manage-users` Edge Function are local until migration and function deployment.
- Barcode workflow is partial: assignment targets `medicines.barcode`; the checked-in unique index is global and does not cover `medicine_units.barcode` or future shops. Client actions, per-product label quantities, scanner test, and POS/Products keyboard scanning are implemented, but live RPC availability, unit-barcode scanning, cross-shop uniqueness, and physical scanner/printer output are unverified. Product label printing supports linear formats only; QR-code generation is not implemented. Owner reported manually running the legacy barcode SQL, but no live schema query was performed in this checkout.
- Supabase bootstrap hazard: `supabase/baseline/00_baseline_schema.sql` is a reconstructed schema reference, not a complete dump. The migration directory also contains timestamped barcode rollback files; do not apply them as forward migrations. Bootstrap instructions and metadata-only comparison queries are in `docs/STAGING_BOOTSTRAP.md`.
- Approved business rule: positive stock in `ACTIVE`/`NEAR_EXPIRY` batches for an active medicine remains sellable through expiry (`expiry_date >= current_date`). `src/utils/fefo.ts` uses this boundary; verify the deployed RPC uses the same rule.
- Trash Bin tracks app product/supplier deactivation and purchase-void workflows; out-of-band physical deletions made through another client or dashboard are not captured.
- Print requests are stored in `public.print_requests`; the admin UI has no permanent-delete action. Removing a request row does not remove its related audit-log history.
- Shared settings across counters are not implemented; receipt templates and some preferences are browser-local.
- Sale-return request/review is implemented in source and the owner reports its SQL migration applied, but end-to-end sale/return behavior is not yet verified against the database. Sales History reprint is not implemented; return memo rendering and print-request review are separate.
- Direct ESC/POS printer-driver support is not implemented; browser printing uses the browser print dialog.
- Several screens still use mock/in-memory data; identify persistence from the current component before changing it.
- Supplier contact insert/update/deactivation is still performed directly by the browser; consider a permission-checked RPC plan.
- Backend role/permission enforcement, API/RPC integration testing, backup, persistent store details, and printer controls need validation/completion.
- POS product browsing uses the permission-checked `pos_catalog()` RPC and its response excludes cost data. Sale posting uses `post_sale()` and sales/customer summaries use RPCs. Dashboard stock KPIs still use sample `INITIAL_PRODUCTS`; Cash Book transactions/expenses remain in memory; sales reports do not yet reconcile persisted return records. The active POS/server sale path does not capture or enforce prescription proof for `requires_prescription` medicines; see `docs/audit/LOGIC_AUDIT.md`.
- Future public tables must explicitly grant only required privileges to `authenticated` and enable appropriate RLS; anon table/sequence privileges are removed by the planned lockdown. Default function EXECUTE privileges are unchanged in this round and remain an optional hardening item.
- Sale and purchase identifiers are generated in source and constrained by the current single-shop schema; verify uniqueness and retry/concurrency behavior against the deployed database. Per-shop numbering awaits tenant scoping; gap-free guarantees are deferred unless concurrency, rollback, retry, and failure tests prove them.
- Discount rules to enforce inside the future post_sale RPC: per-role maximum percent, discount never above the bill, never below batch cost (cashier only sees a generic 'Discount not allowed'), discount stored in paisa with the sale, audit_logs entry for discounts above a threshold.
- Enforce the Rs 200 maximum discount and the role percent caps inside the future post_sale RPC; make the Rs 200 limit editable in Settings.

## Assumptions

- Split payments are represented by separate payment rows in `post_sale()` source; live tender settlement/reconciliation still needs staging verification.
- Admin modifications to pending print requests change the receipt snapshot for printing only; they do not rewrite the completed sale, inventory, or accounting records.
- Trash Bin records user soft-deletes/restores, product/supplier active-state changes, and purchase voids. Purchase records are not physically deleted or directly restorable.

## Changelog

- 2026-10-14 — Created `feature/mongo-migration` from the owner-confirmed clean `security/revoke-public-execute` checkout and completed read-only Phase 0 source inventory in `docs/MONGO_MIGRATION_INVENTORY.md`. No SQL, live database, application code, or deployment was changed; live grants/schema and runtime behavior remain unverified.
- 2026-10-14 — Read-only code/database/security/logic/returns audit recorded in `docs/audit/`. Local lint, 18 test scripts (122 tests), build, and production dependency audit pass. No SQL, deployment, demo data, or application-code change was made for the audit. Key current risks: missing active-POS prescription enforcement, forward-folder rollback files, dashboard sample stock KPIs, in-memory Cash Book, and return/report settlement gaps.
- 2026-10-14 — Clarified the return-audit count reconciliation: the earlier aggregate did not have a recoverable numbered checklist, and the only supported row-level status change is the sale-void interaction moving from PARTIAL to MISSING. Documentation only; no code, SQL, or deployment.
- 2026-10-14 — Updated audit findings from owner-supplied live ACL/RLS output: direct return-table privileges are false with RLS enabled; anon EXECUTE is true on 16 SECURITY DEFINER functions; authenticated table grants need policy/column review. Return migration ledger status and runtime authorization remain unverified. No SQL, code, or deployment.
- 2026-10-14 — Owner reports running the anon-EXECUTE migration; the three post-migration query results and app-test outcome were not included. DB-06 remains open pending verification that the first query returns no rows. Other customer-data readiness findings remain open. Documentation only in this workspace.
- 2026-10-13 — Fixed stored XSS in product-label printing by escaping user-controlled text/attributes with the shared HTML helper; added hostile-input tests. Full lint, test suite, and production build pass. Read-only readiness audit confirmed that POS sales/stock deduction, customer accounting, and medicine returns are not yet durable; no SQL or deployment was performed.
- 2026-10-13 — Owner approved the medicine-return safety, refund, approval, and configurable-window policy. Design must be reviewed before implementation; durable sale posting and batch allocations are a prerequisite.
- 2026-10-13 — Removed the POS demo product feed and added the cashier-authorized, cost-free `pos_catalog()` RPC, typed response validation, live stock-event refresh, and empty/loading/error states. Added migration and rollback files; neither has been applied and no SQL was run. POS sales remain local/in-memory.
- 2026-10-13 — Rechecked POS/catalog and low-stock behavior after user reported products/alerts missing. `npm run lint`, `npm test` (120 tests), and `npm run build` pass. Local browser reaches the login screen, but no authenticated page/RPC smoke test was possible because the supplied screenshot shows an expired/invalid JWT. No database/demo rows were added; live migration status remains unknown.
- 2026-10-13 — Confirmed with owner to keep expiry mandatory per received stock batch, with no database rule change. Documented that product setup itself does not need an expiry date.
- 2026-10-13 — Added a cart sale-unit selector to POS. It recalculates the line price and checks FEFO stock in base units when changing unit or quantity; tested 1-tablet, 10-tablet strip, and pack conversions. Type-check, targeted tests, full test suite, and production build pass. Database still must contain the desired sale units/prices and valid batches; authenticated live UI could not be tested due the reported expired JWT.
- 2026-10-13 — Added the header low-stock alert bell and per-user unseen state, permission-aware navigation, and stock-mutation refresh events. Added a SECURITY DEFINER summary RPC and rollback for manual application; no SQL was run and no migration was applied.
- 2026-10-13 — Added `docs/MULTI_SHOP_FULL_PLAN.md` and aligned `MASTER_PLAN.md`/context to the owner's confirmed decisions; clarified staging → ACL reconciliation → staging migrations/tests → production order, compensating Auth/Postgres provisioning, per-shop sequential/unique numbering, staging inventory counts, server-backed shop identity, Settings access rules, support/seeding/suspension decisions. Documentation only; no code, SQL, migration, or deployment changes.
- 2026-10-13 — Initial follow-on plan request captured before the owner confirmed decisions; superseded by the detailed plan and aligned master plan above.
- 2026-10-13 — Recorded reported DBCode SQL language-server timeout/connection-close logs as an editor diagnostic; no project code or database changes.
- 2026-10-13 — Clarified product label capability: the site can print linear barcode labels; QR-code generation is not currently implemented.
- 2026-10-13 — Removed cleanable unused imports/locals in `cce45bb`; enabled TypeScript `strict` and `noUnusedParameters` after both measured zero errors. `noUnusedLocals` remains disabled due protected-file findings; recorded an ESLint proposal pending approval.
- 2026-10-13 — Lazy-loaded non-Dashboard screens, receipt print workflow, barcode label dialog, and Purchase History XLSX. First-load gzip fell from 418.24 kB to 172.26 kB; lint, tests, and build passed. Full output chunk measurements are in `docs/EXECUTION_PROGRESS.md`.
- 2026-10-13 — Recorded production build/gzip, separate TypeScript diagnostic, and unused-code baseline measurements in `docs/EXECUTION_PROGRESS.md`; no source, configuration, or SQL was changed.
- 2026-10-12 — Completed client-only barcode UI/scanner package in `818af6c`: product row/card/details actions, per-product label quantities and print-job limits, scanner test and POS/Products scan handling. Full tests, TypeScript lint/check, and production build passed; no SQL or migrations changed. Commit hook also included its generated context update.
- 2026-10-12 — Recorded owner-approved W1-W7 execution decisions, created `master-plan/implementation` from `barcode/labels` commit `adf3606`, and prepared staging bootstrap/catalog comparison plus execution progress checklist; stopped before SQL execution or multi-shop migration work.
- 2026-10-12 — Added `docs/MASTER_PLAN.md` with evidence-based W1-W7 status, multi-shop security design, staging test plan, and approval-gated execution order; no application code or database operations were performed.
- 2026-10-12 — Added POS barcode scan support for keyboard/scan input: matching by product barcode or internal code, quick add-to-cart behavior, and scanner-mode UI with a manual entry fallback.
- 2026-10-12 — Completed Phase 1 barcode generation work: server-side EAN-13 barcode assignment RPCs, missing-barcode bulk assignment, and product-page generate actions; validation helpers and renderer error states remain in place.
- 2026-10-12 — Completed read-only barcode/label Phase 0 discovery; no application or SQL changes.
- 2026-10-12 — Added actor-attributed Trash Bin event storage, admin listing/filtering, safe product/supplier/user restores, and purchase-void visibility. Migration and Edge Function deployment are pending.
- 2026-10-12 — Documented the Supabase location and current retention behavior for print requests.
- 2026-10-12 — Removed the cashier print-request confirmation, added profile-name display and an audited admin receipt editor for pending sale requests, and added validation/calculation tests. The migration is not applied.
- 2026-10-12 — Added an editable POS cart discount, Rs 200 hard maximum, role-cap clamping, and discounted receipt coverage.
- 2026-10-12 — Guarded the Manage Users page against missing list-response arrays and added a clear stale-service notice; no function, SQL, or deployment changes.
- 2026-10-12 — Redesigned only the Products filter toolbar with a compact responsive layout and debounced search; added tested active-filter chips, removal, and clear-all logic.
- 2026-10-12 — Audited `src/` for direct Supabase queries to the tables in the direct-access revoke migration; none found. This is a source-only audit and does not verify live database state.
- 2026-10-12 — Added a role-and-permission-scoped `can_view_cost()` migration; direct table revokes remain owned by the already-applied 4c migration. The new migration is not applied.
- 2026-10-12 — Recorded owner-reported ACL audit and staged anon/table-DML/profile lockdown proposal. The migrations and rollbacks are files only; no database was accessed or changed.
- 2026-10-10 — Added maintained project context, generator, hook setup, and AI working agreements; `docs/PROJECT_CONTEXT.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `package.json`, `scripts/`, `.githooks/`.

History: Earlier work delivered Products and Master Data redesigns, Pharmacy Memo rendering and print approvals, role/permission UI, and Stock Inventory. See `docs/REDESIGN_PROGRESS.md` and recent Git history for details; that progress document contains some status entries older than the current source.

## Legacy barcode migrations and staging

Do **not** apply `20261012180000_assign_medicine_barcodes.sql` or `20261012181000_medicines_barcode_unique_index.sql` to the current project. They are legacy, pre-multi-shop migrations and are listed only for a clean staging bootstrap to reproduce the checked-in legacy state; see `docs/STAGING_BOOTSTRAP.md`.

The future per-shop barcode cutover must backfill one registry across both `medicines.barcode` and `medicine_units.barcode`, enforce unique `(shop_id, normalized_barcode)`, and replace the global medicine-only index. As part of that cutover, explicitly drop `public.medicines_barcode_unique` with `DROP INDEX IF EXISTS`; replace the old assignment functions and global sequence with shop-scoped registry claims/counters. Do not run the timestamped barcode rollback files as forward migrations. A rollback must not blindly recreate the global index if different shops now share a manufacturer barcode.

## Working agreements with the owner

- Keep messages short.
- Large multi-file changes need a plan and the owner's OK first.
- Updating this file never needs permission.
- Keep factual claims grounded in current code/docs; write **unknown** where verification is missing.

<!-- AUTO:START -->
Generated at (UTC): 2026-10-14T09:38:31.473Z
Git branch: feature/mongo-migration

Last 5 commit subjects:
- blabla
- return bill
- Fix stored XSS in product label printing
- feat: add header low stock alerts
- plan for admin access

npm scripts:
- - `dev`: `vite --port=3000 --host=0.0.0.0`
- - `build`: `vite build`
- - `preview`: `vite preview`
- - `clean`: `rm -rf dist server.js`
- - `prepare`: `node scripts/setup-hooks.mjs`
- - `context:update`: `node scripts/update-context.mjs`
- - `lint`: `tsc --noEmit`
- - `test:fefo`: `tsx --test src/utils/fefo.test.ts`
- - `test:receipt`: `tsx --test src/utils/receipt.test.ts`
- - `test:inventory-ui`: `tsx --test src/components/inventory/inventoryUiLogic.test.ts`
- - `test:stock-inventory`: `tsx --test src/components/inventory/stockInventoryLogic.test.ts`
- - `test:inventory-products`: `tsx --test src/components/inventory/productImportLogic.test.ts`
- - `test:stock-alerts`: `tsx --test src/data/stockAlertLogic.test.ts`
- - `test:pos-catalog`: `tsx --test src/data/posCatalogLogic.test.ts`
- - `test:product-filters`: `tsx --test src/components/inventory/productFilterLogic.test.ts`
- - `test:master-data`: `tsx --test src/components/masterDataSimilarity.test.ts`
- - `test:print-snapshot`: `tsx --test src/utils/printSnapshot.test.ts`
- - `test:print-request-editor`: `tsx --test src/utils/printRequestEditor.test.ts`
- - `test:trash-bin`: `tsx --test src/utils/trashBin.test.ts`
- - `test:report`: `tsx --test src/utils/salesReport.test.ts`
- - `test:discount`: `tsx --test src/utils/discount.test.ts`
- - `test:barcode-scanner`: `tsx --test src/utils/useBarcodeScanner.test.ts`
- - `test:labels`: `tsx --test src/utils/labelUtils.test.ts`
- - `test:permissions`: `tsx --test src/permissions.test.ts`
- - `test:manage-users-policy`: `tsx --test supabase/functions/manage-users/policy.test.ts`
- - `test`: `npm run test:fefo && npm run test:receipt && npm run test:inventory-ui && npm run test:stock-inventory && npm run test:inventory-products && npm run test:stock-alerts && npm run test:pos-catalog && npm run test:product-filters && npm run test:master-data && npm run test:print-snapshot && npm run test:print-request-editor && npm run test:trash-bin && npm run test:report && npm run test:discount && npm run test:barcode-scanner && npm run test:labels && npm run test:permissions && npm run test:manage-users-policy`

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
    src/data/mockPharmacyData.ts
    src/data/posCatalog.ts
    src/data/posCatalogLogic.test.ts
    src/data/posCatalogLogic.ts
    src/data/returnLogic.test.ts
    src/data/returnLogic.ts
    src/data/saleReturns.ts
    src/data/sales.ts
    src/data/stockAlertLogic.test.ts
    src/data/stockAlertLogic.ts
    src/data/stockAlerts.ts
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
- src/components/inventory/inventoryUiLogic.test.ts
- src/components/inventory/productFilterLogic.test.ts
- src/components/inventory/productImportLogic.test.ts
- src/components/inventory/stockInventoryLogic.test.ts
- src/components/masterDataSimilarity.test.ts
- src/data/posCatalogLogic.test.ts
- src/data/returnLogic.test.ts
- src/data/stockAlertLogic.test.ts
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
- DEMO_MODE
- GEMINI_API_KEY
- SUPABASE_ANON_KEY
- SUPABASE_URL
- VITE_SUPABASE_ANON_KEY
- VITE_SUPABASE_URL
<!-- AUTO:END -->
