# Pharma Care Codebase Analysis

- **Date:** 2026-10-14
- **Branch:** `security/label-escaping`
- **HEAD:** `a10e6ee462ee163e6bb359b71f4c2e148aba8042`
- **Scope:** Frontend structure, data access, authentication/permissions, SQL/Edge Function source, tests, dependencies, build output, and project documentation.
- **Method:** Read-only source review; static inventory; `npm run lint`, `npm test`, `npm run build`, `npm audit --omit=dev`.
- **Limitations:** No authenticated web session, production/staging connection, live RLS/grant inspection, or user-flow/browser test was performed.

## Architecture

- React 19 + TypeScript + Vite + Tailwind v4 frontend; Supabase Auth/Postgres and a `manage-users` Edge Function.
- No `react-router` usage was found; `src/App.tsx` uses history state plus an explicit page switch.
- Vite code-splits screen components and provides loading/error boundaries.
- Supabase client uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The service-role key is read server-side by the Edge Function only.
- The checked-in baseline is a reconstructed schema reference, not a complete production export.

## App page map

The active app switch in `src/App.tsx` includes Dashboard, POS Billing, Products, Master Data, Stock Inventory, Customers, Customer Ledger, WhatsApp Reminders, Sales History, Suppliers, Purchases, Purchase History, Expenses/Cash Book, Reports, Manage Users, My Print Requests, Print Requests, Settings, Trash Bin, and Help/Support. The active POS uses `POSBillingView`; the older `POSScreen` is not referenced by the active app.

## Persistence map

| Area | Checked-in source path | Data behavior |
|------|------------------------|---------------|
| Authentication/profile | `src/utils/auth.ts`, `src/App.tsx` | Supabase Auth session plus active/non-deleted profile lookup and periodic recheck. |
| Products/stock | `src/components/InventoryScreen.tsx`, `src/data/stockAlerts.ts` | Server-backed list, statistics, stock, and alert RPC calls; live database state not verified. |
| POS catalog/sales | `src/data/posCatalog.ts`, `src/data/sales.ts`, `src/components/POSBillingView.tsx` | Typed RPC catalog and `post_sale` persistence path. |
| Customers/ledger/sales history | `src/data/sales.ts`, `src/App.tsx` | RPC-backed reads/writes for the implemented paths; deployment and transaction reconciliation remain unverified. |
| Returns | `src/data/saleReturns.ts`, `src/components/returns/SaleReturnsPanel.tsx` | RPC request/review/processing path. Reports and cash refund disbursement are not wired through. |
| Purchases/stock changes | `src/components/StockPurchaseView.tsx` and SQL RPCs | Server-backed transactional purchase/adjust/write-off/void path in source. |
| Suppliers | `src/components/SuppliersView.tsx` | Contains direct Supabase table operations; authorization depends on live RLS/grants and is not proven here. |
| Cash Book / expenses | `src/App.tsx`, `src/components/CashBookScreen.tsx` | React in-memory transactions; no persistence call found in the screen. |
| Dashboard stock metrics | `src/data/mockPharmacyData.ts`, `src/App.tsx`, `src/components/DashboardView.tsx` | Static `INITIAL_PRODUCTS` sample data; low/expiry counts are not live inventory. |
| UI preferences and drafts | Various settings, `TopNav`, `StockPurchaseView` | Browser `localStorage`; expected to be device-local, not a shared business record. |

## Security and privacy boundaries

- Frontend permission checks control navigation and presentation; they are not a substitute for server checks.
- The SQL source has permission-checked SECURITY DEFINER RPCs and cost-redaction helpers. Direct base-table grants, RLS, function ACLs, and migration application must be verified live.
- The return tables need effective ACL checks; see [DATABASE_AUDIT.md](./DATABASE_AUDIT.md).
- Prescription-required checks are missing from the active sale RPC path; see [LOGIC_AUDIT.md](./LOGIC_AUDIT.md).
- `manage-users` uses server-side service-role configuration, validates the bearer token and active profile, and applies a role/permission policy. Its CORS policy is wildcard and should be narrowed for production hardening.
- Label/receipt HTML uses escaping helpers. A static scan of the built assets found no source maps or service-role/Gemini/Supabase-secret patterns. A public Supabase client key is expected to be bundled. `.env.local` was not opened; no values were copied to audit output.
- The dormant `RepositoryReviewView` contains a user-entered PAT-to-Git-remote command helper; it is not referenced by the active app. See SECURITY_AUDIT.

## SQL inventory and tenancy

The checked-in SQL history includes 24 distinct application table names, 32 migration-directory SQL files, 10 rollback-directory files, and 58 distinct public function declarations across history. Counts are static source counts, not live catalog counts. Two rollback scripts are incorrectly located in the forward migration directory. There are no `shop_id` or `tenant_id` columns in the checked-in schema; the approved multi-shop design remains a plan gated on staging work.

## Tests and local checks

- `npm run lint` (`tsc --noEmit`): **passed**.
- `npm test`: **passed**, 18 registered scripts / 122 test cases / 0 failures.
- `npm run build`: **passed**, 1,830 modules transformed. Non-fatal warnings: Vite config uses `__dirname`; the main bundle is 543.87 kB and Vite reports a chunk over 500 kB.
- `npm audit --omit=dev`: **found 0 vulnerabilities**.
- There are tests for return helper calculations, but `npm test` does not run `src/data/returnLogic.test.ts`; no return-RPC/database integration test was found.
- Unit tests/build are not evidence that live migrations, grants, page navigation, printers, hardware scanners, multi-counter data, or production controls work.

## Handover readiness

**Not certified ready for a client production handover.** Before release, resolve or explicitly accept the high/medium findings, verify live table/function ACLs and migration state, test prescription enforcement at the RPC boundary, persist cash movement data, and reconcile returns in reports. This is a source audit, not a penetration test or clinical/regulatory certification.

