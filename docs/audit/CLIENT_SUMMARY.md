# Client Handover Audit Summary

- **Date:** 2026-10-14
- **Branch:** `security/label-escaping`
- **HEAD:** `a10e6ee462ee163e6bb359b71f4c2e148aba8042`
- **Scope:** Read-only security, database, codebase, business-logic, and medicine-return audit.
- **Method:** Static source/migration review, local typecheck/test/build/dependency audit, and review of owner-supplied live catalog/ACL query results dated 2026-10-14. The assistant did not run SQL.
- **Limitations:** The owner reports running the anon-EXECUTE migration, but the three post-migration query outputs and app-test result were not included. No migration-history result, live API call, authenticated browser walkthrough, customer data, demo-data insertion, or exploit test was provided/performed.

## Overall outcome

**Not ready for real customer data or production handover.** The repository has source for server-backed POS sales and a permission-controlled partial medicine-return workflow. Supplied live results confirm the return tables have RLS enabled and no direct anon/authenticated table privileges. Earlier live results showed anon EXECUTE on multiple SECURITY DEFINER functions; the owner reports running a migration intended to address this, but omitted the post-migration query outputs, so the fix is not verified. Authenticated table privileges are present on several tables, but the relevant RLS policies and column grants were not supplied.

## Findings by severity

| Severity | Open / not verified | Main themes |
|----------|----------------------|-------------|
| 🔴 HIGH | 3 | Prescription-required sale enforcement; rollback migration-history uncertainty; anon EXECUTE on SECURITY DEFINER operations. |
| 🟡 MEDIUM | 6 | Dashboard sample stock KPIs; non-persistent Cash Book; returns missing from sales reporting; cash refunds not posted as disbursements; no multi-shop isolation; authenticated table grants with unreviewed policies. |
| ⚪ LOW | 2 | Unreachable PAT-to-Git-command component; return test/integration coverage gap. |

The conditional direct-return-table-access concern is **VERIFIED-LIVE as closed for the reported API roles** (RLS on and anon/authenticated CRUD privileges false); see F-03. Severity totals exclude this closed concern and include the newly identified F-11 and F-12. Details/statuses are in [FINDINGS.csv](./FINDINGS.csv), [SECURITY_AUDIT.md](./SECURITY_AUDIT.md), [DATABASE_AUDIT.md](./DATABASE_AUDIT.md), and [REMEDIATION_PLAN.md](./REMEDIATION_PLAN.md).

## Medicine return answer

**Yes, the return option exists in source.** Cashier/POS users can request a return against a saved invoice; Manager/Admin with `sales_history` can review it, and `stock_inventory` is additionally required for restocking. Partial returns are supported but cannot cumulatively exceed the original sold quantity. Quarantine and write-off do not increase sellable stock; eligible restock targets the original sale batch.

**Migration status: NOT-VERIFIED as an applied migration.** The owner-supplied live results show the expected return tables and functions exist in the current project, but no migration-history/version result was supplied; object presence alone cannot prove that the migration ran or that its full contents are deployed. The three return tables have RLS enabled (not forced), and supplied effective privileges show anon and authenticated SELECT/INSERT/UPDATE/DELETE are all false. The listed return/sales functions have anon EXECUTE false. These are owner-supplied results, not independently queried or functionally tested.

The 16-row checklist in [RETURNS_AUDIT.md](./RETURNS_AUDIT.md) totals **11 DONE in source + 3 PARTIAL + 2 MISSING = 16**. “DONE” is a source-code assessment, not a claim of live execution.

**Important gaps:** cash refund records are not tied to a cashbook payout; interaction with sale voids is not implemented or demonstrated; sales reports do not net returns; the return UI does not invoke the available return receipt renderer; and no return RPC/database integration test was found.

## Verification method and limits

| Finding | Code/test evidence | Live result supplied by owner | Current status |
|---------|------------------|---------------------------|----------------|
| F-01 prescription enforcement | Active POS, catalog and sale RPC source read. | No sale/exploit result. | STILL-OPEN |
| F-02 rollback scripts in forward migration | Filenames and SQL statements read. | Migration history not supplied. | NOT-VERIFIED |
| F-03 return-table RLS/grants | Creation migration reviewed. | RLS on; anon/authenticated CRUD false for all three return tables. | VERIFIED-LIVE (direct API table access absent in supplied results) |
| F-04 dashboard sample stock data | App/dashboard data flow read. | No page interaction. | STILL-OPEN |
| F-05 in-memory cash book | App state and cashbook component read. | No reload/reconciliation experiment. | STILL-OPEN |
| F-06 reports omit returns | Report/helper source read. | No live-return report generated. | STILL-OPEN |
| F-07 cash refund not posted | Return RPC/UI path read. | No return processed. | STILL-OPEN |
| F-08 tenant isolation absent in schema | Checked-in baseline/migrations read. | No cross-shop test/result. | STILL-OPEN |
| F-09 token helper | Component and reference search. | No token entered/copied/command run. | STILL-OPEN (latent; not app-reachable) |
| F-10 return test coverage | Package scripts and test source inspected. | `npm test` ran; return helper test is not in chain. | STILL-OPEN; no RPC integration test |
| F-11 anon function execution | Earlier live ACL output showed anon EXECUTE true; no function body invocation. | Owner reports running the migration, but no post-migration result was included. | STILL-OPEN; mark VERIFIED-LIVE-FIXED only if the first post-migration query returns no rows. |
| F-12 authenticated table grants | RLS source selectively reviewed. | Authenticated SELECT/DML flags true for business tables and SELECT on other tables; policy definitions not supplied. | NOT-VERIFIED effective row/column access |
| App test after anon-EXECUTE migration | No test details supplied. | Result omitted from the owner message. | NOT-VERIFIED |
| General quality checks | Package and config read. | Earlier lint, registered tests, build, production dependency audit ran. | Repository checks only; not live deployment verification. |

### Audit areas not covered or only partly covered

- **Browser/client storage:** Identified selected `localStorage` usage, but did not conduct a complete storage inventory, shared-device threat model, browser-profile/session test, cache review, or XSS-to-storage exfiltration test.
- **Authentication configuration:** Reviewed source session/profile checks, not live Supabase Auth provider settings, MFA enforcement, password/session policies, email confirmation, recovery flows, or account lockout.
- **Hosting and transport:** No production hosting/CDN inspection; CSP, HSTS, frame/content-type/referrer headers, TLS configuration, WAF, and deployment secrets remain unverified.
- **CORS:** Read the `manage-users` wildcard CORS header in source, but did not perform cross-origin requests or verify deployed Edge Function/CORS settings or other backend endpoints.
- **Customer and supplier privacy:** No exhaustive field-by-field PII inventory, privacy/legal review, retention/deletion analysis, exports/backups/logging trace, or end-to-end access test. Supplied results show authenticated SELECT but no direct DML for `suppliers`, with RLS enabled; the policy and actual row/column access were not reviewed. WhatsApp sharing behavior was not exercised.
- **Database authorization:** Static review was selective, not an exhaustive line-by-line audit of all RPCs, policies, grants, triggers, and live object owners. The owner supplied prior function ACL/table privilege/RLS flags and reports running an anon-EXECUTE migration; no post-migration results were included. The assistant did not run SQL. Function bodies, RLS policy definitions, column grants, and migration history remain outstanding.
- **Shop isolation:** Confirmed that checked-in schema has no `shop_id`/`tenant_id`; did not run two-shop isolation tests or inspect a separate deployed tenant schema.
- **Operational controls:** Backups/restore, monitoring, incident response, audit-log retention, production data quality, concurrency/load, and disaster recovery were not tested.
- **Runtime and regulatory validation:** No authenticated end-to-end browser walkthrough, scanner/printer test, live sale/return, or pharmacy regulatory/clinical compliance review was performed.

## Checks actually run

- `npm run lint` — passed (`tsc --noEmit`).
- `npm test` — passed: 18 registered scripts, 122 tests, 0 failures. The return helper test file is not in this script chain.
- `npm run build` — passed; Vite transformed 1,830 modules. Non-fatal warnings remain for `__dirname` in Vite config and a bundle chunk above 500 kB.
- `npm audit --omit=dev` — `found 0 vulnerabilities`.

## Before real customer data / remaining live evidence

1. Obtain the three post-migration query outputs; DB-06 remains open until the first query returns no rows. Review live definitions, guards, and `search_path` for all previously anon-executable SECURITY DEFINER functions, and test anonymous calls in staging.
2. Inspect authenticated RLS policies and column grants, especially customer/supplier/profile data, medicine cost fields, sales/payments, stock movements, and ledgers. Test each role's direct API reads and writes.
3. Obtain the migration-history result to confirm whether `20261013160000_persist_sales_and_returns` is recorded as applied; expected objects being present is not sufficient evidence.
4. Test actual cashier/manager/admin flows in staging, including prescription-required sale denial, partial/double-return attempts, cash/credit settlement, and post-return reports.
5. Confirm hosting headers, Auth/MFA configuration, Edge Function deployment/origins, backups, and tenant isolation before multi-shop use.

## Scope confirmation

The owner supplied live query output, but the assistant ran no SQL; no migration/rollback was applied; nothing was deployed, committed, or pushed; no demo data was inserted. This is a read-only audit update, not an independently performed penetration test or pharmacy regulatory opinion.
