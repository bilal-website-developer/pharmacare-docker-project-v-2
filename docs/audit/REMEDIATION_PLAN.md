# Pharma Care Audit Remediation Plan

- **Date:** 2026-10-14
- **Branch:** `security/label-escaping`
- **HEAD:** `a10e6ee462ee163e6bb359b71f4c2e148aba8042`
- **Scope:** Prioritized follow-up for findings F-01 through F-12.
- **Method:** Read-only recommendations based on checked-in source and owner-supplied context; no code or SQL was changed for this plan.
- **Limitations:** Priority/order should be confirmed by the owner and applicable pharmacy rules. The owner reports running the anon-EXECUTE migration, but supplied no post-migration query output or app-test result. Function behavior, policies, migration history, and deployed flows still need verification.

## Priority 0 — release blockers

1. **F-11 / DB-06: Verify the anon-EXECUTE migration.** Obtain the post-migration results. Mark `VERIFIED-LIVE-FIXED` only if the first query returns no rows; until then this remains open. Then inspect the definitions, caller checks, and `search_path` for all 16 functions previously reported anon-executable and test denied anonymous calls in staging. The prior grant output confirms EXECUTE exposure, not a successful exploit.
2. **F-12: Authenticated table grants and RLS policies.** Review every policy and column grant for `audit_logs`, `brands`, `categories`, `customers`, `khata_entries`, `medicine_units`, `medicines`, `print_requests`, `profiles`, `sale_payments`, `sales`, `stock_movements`, `supplier_ledger`, and `suppliers`. Test role-specific read/write boundaries, including customer/supplier privacy and cashier cost-field access. RLS is enabled but not forced; supplied grant flags alone do not show effective rows or columns.
3. **F-01: Prescription-required sale enforcement.** Confirm applicable prescription/controlled-medicine requirements. Add server-side validation to the sale transaction and a validated, protected prescription audit record. Test UI bypass/direct RPC, missing fields, and allowed exceptions. The old `POSScreen` prompt is not the active checkout and is not a control.
4. **F-02: Migration folder/history check.** Inspect `supabase_migrations.schema_migrations` and the deployment procedure. The two rollback-named timestamp files are in the forward directory, but whether they ran is NOT-VERIFIED. Prevent accidental forward execution while preserving recorded migration history.

## Priority 1 — business-record integrity

5. **F-05: Durable Cash Book.** Define a server-side cash movement ledger with caller authorization, audit data, business date, idempotency, and atomic posting. Reconcile POS cash sales, expenses, cash returns, and drawer close.
6. **F-07: Cash refund settlement.** Store actual tender/disbursement confirmation and ensure returned credit/cash/split tender paths reconcile in a single auditable flow.
7. **F-06: Net-return reporting.** Build server-backed report summaries that distinguish gross sales, discounts, returns/refunds, and net sales; cover dashboard and printable exports.
8. **F-04: Dashboard inventory source.** Remove the static product fixture from live dashboard metrics and consume the stock summary RPC; empty/loading/error states should not look like a valid zero.

## Priority 2 — architecture, hygiene, and tests

9. **F-08: Tenant-scoped deployment.** Do not onboard a second shop until approved `shop_id`/tenant ownership is applied to every business table and RPC, with cross-tenant read/write denial tests. Follow `docs/MASTER_PLAN.md` staging gates.
10. **F-10: Regression coverage.** Add `src/data/returnLogic.test.ts` to the npm test chain, then add tests against a staging database for permissions, cumulative/parallel over-return, batch dispositions, cash/credit settlements, and report reconciliation.
11. **F-09: PAT helper.** Remove token-in-URL command generation from the unused component, or replace it with Git Credential Manager/`gh auth login`. If any user entered a real PAT into this component and executed the generated command, revoke it.
12. **Headers and deployment settings.** Verify production CSP, frame/referrer/content-type headers, TLS, auth-provider settings, MFA policy, backups, Edge Function deployment, and origin allow-list outside this repository.

## Completion gates

- Migration history is confirmed; anon SECURITY DEFINER grants, authenticated RLS policies, and column-level grants are reviewed and tested.
- DB-06 is marked `VERIFIED-LIVE-FIXED` only after the post-migration first query returns no rows; record the app-test result separately.
- Prescription-required products cannot be sold without the configured server-enforced evidence.
- Cash book, refunds, sales history, and reports reconcile after sale/return flows.
- Dashboard stock KPIs use live stock; return payout is recorded and audited; migration ledger status is confirmed.
- Two-shop isolation is tested before multi-shop operation.
- Build and registered tests pass, plus staging RPC/integration/manual checks.
- Production backup/restore and hosting security controls are verified.
