# Medicine Returns Audit

- **Date:** 2026-10-14
- **Branch:** `security/label-escaping`
- **HEAD:** `a10e6ee462ee163e6bb359b71f4c2e148aba8042`
- **Scope:** Sale-return UI/data helpers, `20261013160000_persist_sales_and_returns.sql`, its rollback, sales reporting, and related tests.
- **Method:** Static inspection, the current full test suite, and review of owner-supplied live catalog/ACL output dated 2026-10-14. The assistant ran no SQL and performed no live sale or return.
- **Limitations:** No migration-history/version result or end-to-end return result was supplied. Live metadata is owner-provided, not independently queried.

## Verdict

**The medicine-return option is implemented in source.** A user with POS permission can find a saved invoice, select sold quantities, enter a reason, and submit a return request. Manager/Admin review and processing are separate.

**Migration status: NOT-VERIFIED as an applied migration.** The supplied live catalog includes the expected return tables and functions, but no migration-history/version result was provided. Object presence alone does not prove the full migration was applied.

**Return table access: VERIFIED-LIVE from the supplied results.** `return_policy_settings`, `sale_returns`, and `sale_return_items` each have RLS enabled (not forced); anon and authenticated SELECT/INSERT/UPDATE/DELETE are all false. The listed return/sales RPCs have anon EXECUTE false. These results do not demonstrate a successful live return or validate the full set of function bodies.

The table below has **16 checklist areas**: **11 DONE in source, 3 PARTIAL, and 2 MISSING** (11 + 3 + 2 = 16). “DONE in source” means the inspected code implements the described behavior; it does not mean the assistant exercised the live RPC or verified the applied database.

### What changed since the previous count

The earlier **9 DONE / 4 PARTIAL / 2 MISSING** result was published only as an aggregate; it did not preserve a numbered 15-row checklist. A complete row-by-row mapping therefore cannot be reconstructed without guessing. The one row-level status change supported by the earlier audit narrative and the current source review is:

| Current row | Old status | New status | File and line evidence |
|---|---|---|---|
| 14 — Interaction with sale-void workflow | PARTIAL | MISSING | The current migration defines the sale/return operations at `supabase/migrations/20261013160000_persist_sales_and_returns.sql:843, 915, 1082, 1130`; none is a sale-void operation. A source search across `src/` and `supabase/` found no sale-void workflow. |

The aggregate difference (**+2 DONE, -1 PARTIAL, unchanged MISSING, and one additional checklist area**) is not evidence that two areas were upgraded; it reflects that the previous aggregate has no recoverable row mapping and was inconsistent with the subsequently itemized checklist. No other old row status is asserted here. Current DONE statuses remain based on the source evidence listed in the checklist, not on the count change.

| # | Checklist area | Status | Evidence / remaining limitation |
|---|----------------|--------|--------------------------------|
| 1 | POS sale persistence | DONE | Active POS calls `post_sale`; the expected objects appear in owner-supplied live results, but migration-history status is unverified. No live sale was performed. |
| 2 | Sale-unit conversion and FEFO allocation | DONE | Client and server source validate configured units and allocate eligible batches in FEFO order. |
| 3 | Discount, rounding, and tender validation | DONE | `post_sale` source validates these values and writes sale/payment records. |
| 4 | Return lookup against a saved sale | DONE | `sale_for_return` looks up the persisted invoice and original allocations. |
| 5 | Return request reason and quantity validation | DONE | Source requires a reason and positive quantities from the original sale allocation. |
| 6 | Request/review permission separation | DONE | Request requires POS; review/rejection require Manager/Admin and `sales_history`; server checks enforce this. |
| 7 | Cumulative partial-return cap | DONE | Source reserves pending/completed quantities and locks/checks allocation; parallel behavior was not exercised. |
| 8 | Refund proration and rounding | DONE | Source calculates cumulative integer-paisa refund portions against original line totals. |
| 9 | Credit-sale return accounting | DONE | Source adjusts store credit and creates a customer ledger entry. Live balances were not checked. |
| 10 | RESTOCK eligibility and package evidence | PARTIAL | Window, shelf life, medicine class/storage, sealed assertion, and divisibility are checked; “sealed” is staff-asserted, and exact original packaging is not proven. |
| 11 | RESTOCK batch target | DONE | Source increments the original sale allocation batch, not a new sellable batch. |
| 12 | QUARANTINE and WRITE_OFF stock handling | DONE | Quarantine uses a separate non-sellable batch; write-off does not add sellable quantity. |
| 13 | Cash refund payout and cashbook settlement | MISSING | Return processing records a CASH method/amount but creates no durable cash disbursement or payout confirmation. |
| 14 | Interaction with sale-void workflow | MISSING | The return migration has no sale-void operation or demonstrated reconciliation behavior. |
| 15 | Return reporting and receipt workflow | PARTIAL | Reports omit returns; a RETURN memo renderer exists but successful return processing does not invoke it. |
| 16 | Return-specific automated and live end-to-end validation | PARTIAL | Pure helper tests exist but are outside `npm test`; no RPC/database integration tests or live workflow were run. |

## What works in the source

The behaviors marked DONE above are implemented in the checked-in UI/RPC source. Tests cover selected pure helpers, not the database transaction or live permissions.

The sales/return code inspected does not return cost to the cashier: `post_sale` sets `costPaisaPerUnit` to `null`, and the return completion payload contains refund details rather than cost. The active cashier UI receives a refund amount/method message.

## Partial or missing workflow pieces

### Cash refund and accounting

`process_sale_return` stores the refund amount and labels a non-credit refund `CASH`. The UI says the return is completed, but the flow does not write a cashbook/payment disbursement or obtain confirmation that cash was actually paid. Credit returns do update store credit/ledger. Mixed cash/online tenders do not appear to be refunded back according to the original tender split.

**Required before using cash returns as accounting evidence:** post an audited cash-out transaction in the same database transaction (or a clearly defined two-step settlement workflow), record the actor/time/reference, and reconcile tender-method behavior.

### Reports and receipt

`salesReport.ts` explicitly says no return records are connected and labels net sales before untracked returns. The return UI shows a completion notice but does not invoke the RETURN memo renderer/print workflow, even though that renderer supports a negative return memo.

### Restock assessment

The server prevents inappropriate classes/cold-chain and requires the requested base-unit count to divide into a configured sale unit. The UI's “sealed/intact” value is a staff assertion, not an independently verified fact. The code does not prove that the selected restock package is the exact package originally dispensed; confirm whether the business rule needs exact original packaging rather than any configured divisible unit.

### Tests and live proof

- Pure tests cover refund proration and restock helper rules in `src/data/returnLogic.test.ts`, but that file is not included in the `npm test` script chain.
- No return RPC/database integration test was found.
- The owner's current query output reports `SECURITY DEFINER`, anon EXECUTE false, and authenticated EXECUTE true for the listed sales/return RPCs. Earlier selected metadata showed `search_path=public`; the current full ACL output does not include settings for every function. The same current output shows anon EXECUTE true for other SECURITY DEFINER functions; see [SECURITY_AUDIT.md](./SECURITY_AUDIT.md).
- Real sale → partial return → additional return → duplicate/over-return → cash/credit accounting has not been exercised against a live or staging database.

## Staging manual test plan

Use test-only medicines/customers and non-production records.

1. Create a saved sale with at least two sale allocations and a known integer-paisa total. Record its invoice, item, unit, and batch allocation.
2. As a cashier with POS permission, request one base unit from a multi-unit line and a partial amount from another line. Verify a reason is required, request is pending, and cashier cannot approve/reject.
3. As a Manager/Admin with `sales_history`, load the pending request. Without `stock_inventory`, verify RESTOCK is rejected. With it, test RESTOCK conditions and verify only the original sale batch quantity increases.
4. Process `QUARANTINE` and `WRITE_OFF` cases. Verify neither increases sellable stock and movements/disposition/history are recorded.
5. Return the remaining eligible quantity in a second partial request. Attempt one extra unit and a concurrent duplicate request; server must reject the over-return.
6. Test credit sale return: verify store credit and khata/ledger entries equal the prorated refund.
7. Test cash and split-tender sale returns: verify actual cash disbursement and cashbook reconciliation. Current source does not demonstrate this settlement, so do not treat this step as already passed.
8. After each return, compare original sale, refund amount, sales history, dashboard, printable report, and customer ledger. Current report/receipt integration is incomplete.
9. Test expired, near-expiry, cold-chain, controlled, narcotic, unsealed, and divisible/non-divisible package cases at the server boundary.
10. Confirm cost fields are absent for cashier RPC results and that direct table reads/writes are denied for `anon` and `authenticated`.
