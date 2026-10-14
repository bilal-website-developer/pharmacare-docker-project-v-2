# Pharma Care Business-Logic Audit

- **Date:** 2026-10-14
- **Branch:** `security/label-escaping`
- **HEAD:** `a10e6ee462ee163e6bb359b71f4c2e148aba8042`
- **Scope:** POS, products/stock, sales, reports, cash book, customer accounts, and returns.
- **Method:** Read-only trace of active app routes, UI data sources, data/RPC wrappers, SQL validation, and existing tests.
- **Limitations:** No browser session, test account, live database, stock transaction, or customer record was used. Conclusions are source-level unless marked otherwise.

## Summary

The active POS is not the old mock `POSScreen`: `App.tsx` renders `POSBillingView`, and checkout calls the server `post_sale` RPC. Products and Stock Inventory also use server-backed RPCs. However, the Dashboard still derives all product/stock KPIs from `INITIAL_PRODUCTS`, a fixed sample dataset; the Cash Book receives an in-memory `transactions` array; and return records are not included in the sales reports. These paths can show plausible but incorrect business totals.

The sale-return workflow exists in source and the owner reports the SQL migration applied. The source checks request quantities, cumulative returned quantities, caller roles/permissions, inventory disposition, and refund arithmetic. It is not an end-to-end verified accounting workflow: cash refunds are recorded as a method/amount but not paid/posted into a cash ledger, and report/receipt paths are not connected to return data.

## Findings

### LOG-01 — The active POS does not capture or enforce prescription proof

**Status:** `STILL-OPEN`
**Severity:** HIGH
**Location:** `src/App.tsx` POS route; `src/components/POSBillingView.tsx`; `src/data/posCatalogLogic.ts`; `supabase/migrations/20261013150000_pos_catalog.sql`; `supabase/migrations/20261013160000_persist_sales_and_returns.sql`.

The active `POSBillingView` does not include prescription fields. The `pos_catalog` response and typed client product model carry `drugClass`, not `requiresPrescription`/prescription proof. The `post_sale` RPC accepts customer, sale items, discount/rounding, tender, and payments; it does not validate `medicines.requires_prescription` or persist prescriber/prescription details. A controlled-drug modal appears in the separate `POSScreen.tsx`, but that component is not imported/rendered by the app.

**Risk:** Prescription-required and controlled products may be sold without the intended documented control.
**Next:** Decide the jurisdiction/business policy, then implement and test the check in the server RPC and persistent audit record. Do not rely on a UI-only prompt.

### LOG-02 — Dashboard stock metrics are based on sample data

**Status:** `STILL-OPEN`
**Severity:** MEDIUM
**Location:** `src/App.tsx` (`INITIAL_PRODUCTS`) and `src/components/DashboardView.tsx`.

`App.tsx` assigns `products = INITIAL_PRODUCTS` and passes it to the Dashboard. Dashboard low-stock, near-expiry, and expired counts are calculated from those product/batch objects. This differs from Products/Stock Inventory, which load database data. Dashboard sales/customer figures have separate, server-backed sources, so the dashboard is a mixed-data screen rather than entirely fake.

**Risk:** Staff may act on sample stock counts instead of the live stock position.
**Next:** Feed these metrics from the same server-backed stock summary used by Products/Stock Inventory, with loading/error states.

### LOG-03 — Cash Book and expense entries are browser-session state

**Status:** `STILL-OPEN`
**Severity:** MEDIUM
**Location:** `src/App.tsx` transactions state and `CashBookScreen`; `src/components/CashBookScreen.tsx`.

Transactions initialize with `useState<CashTransaction[]>([])`. POS cash sales and expenses are appended through React state; `CashBookScreen` itself calls `onAddTransaction` and has no database operation. A reload/new session therefore drops these entries. Dashboard expenses and expected cash are also derived from this transient state.

**Risk:** Drawer reconciliation and expenses cannot be treated as a persistent accounting record.
**Next:** Persist cash movements through an authorized, audited transactional RPC; load the day ledger from the server and test multi-counter/concurrent updates.

### LOG-04 — Sales reports do not subtract persisted returns

**Status:** `STILL-OPEN`
**Severity:** MEDIUM
**Location:** `src/utils/salesReport.ts`; `src/components/ReportsScreen.tsx`; `src/data/sales.ts`.

The printable sales report explicitly renders “Returns unavailable”/“No return records are connected” and labels net sales as before untracked returns. Sales history is built from the sales RPC; return records are not joined into its totals. After a return, gross sales/profit-oriented reporting can remain overstated relative to net sales.

**Risk:** Managers may rely on revenue or performance figures that ignore returned merchandise/refunds.
**Next:** Add an authorized server summary that nets completed refunds and returns consistently; keep gross sales, discounts, returns, and net sales distinct.

### LOG-05 — Cash refunds are not shown as a completed cash disbursement

**Status:** `STILL-OPEN`
**Severity:** MEDIUM
**Location:** `supabase/migrations/20261013160000_persist_sales_and_returns.sql` (`process_sale_return`); `src/components/returns/SaleReturnsPanel.tsx`; `src/App.tsx` Cash Book state.

For cash returns, the return record stores `refund_method='CASH'` and the refund amount. The UI displays a completed refund notice. The inspected return flow does not create a cash payment/cashbook movement or require staff to confirm an actual cash payout. Credit-sale returns do adjust store credit/ledger.

**Risk:** A database record that says “cash refund” is not evidence that cash was paid or reconciled. Mixed original tenders are also not demonstrably settled back to the original tender split.

### LOG-06 — Multi-shop isolation is only a plan

**Status:** `STILL-OPEN`
**Severity:** MEDIUM release gate before multi-shop use
**Location:** `supabase/baseline/00_baseline_schema.sql`; migrations; `docs/MASTER_PLAN.md`.

No `shop_id`/`tenant_id` exists in the checked-in schema. The project plan explicitly requires a staging bootstrap and two-shop isolation checks before any multi-shop migration. Current workflows are single-shop scoped.

**Risk:** Do not place multiple pharmacies in the same project/schema and assume rows are isolated.
**Next:** Implement tenant keys and server-enforced isolation only after owner-approved design and staging tests.

## Correct behavior present in source

- POS uses `pos_catalog()` and `post_sale()` RPCs rather than the stale mock POS page; server-side stock allocation uses locks and eligible batches.
- POS sale-unit conversion and FEFO allocation are checked in client and server logic; server transaction is authoritative.
- Return request and approval are separate. Requesting requires POS permission; processing/rejection require Manager/Admin and `sales_history`; restocking additionally requires `stock_inventory`.
- Return requests require a reason and positive, sold-allocation quantities. Pending/completed reservations and locking are used to prevent cumulative over-return, including concurrent attempts.
- Refund amount proration uses cumulative integer-paisa arithmetic. Credit returns add customer store credit/ledger.
- `QUARANTINE` creates a distinct non-sellable batch; `WRITE_OFF` does not add saleable quantity; `RESTOCK` increments the original sale batch only.
- Owner-supplied 2026-10-14 output reports anon EXECUTE false for the listed sales/return functions, but true for 16 other SECURITY DEFINER functions. The result does not include all function settings/bodies or demonstrate whether anonymous calls are rejected by guards. Return tables report RLS on and anon/authenticated direct CRUD privileges false; authenticated policies on several other tables remain unreviewed. The assistant did not query the live database.

## Validation and release tests

Use the staging scenarios in [RETURNS_AUDIT.md](./RETURNS_AUDIT.md) and SELECT-only checks in [OWNER_QUERY_PACK.md](./OWNER_QUERY_PACK.md). At minimum test a prescription-required sale, low-stock/empty stock, one-base-unit and configured-pack sales, partial/full return, a duplicate/cumulative return attempt, credit and cash return, and reporting/cash reconciliation after each. Do not run test transactions against customer production data.
