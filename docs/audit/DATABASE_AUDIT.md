# Pharma Care Database Audit

- **Date:** 2026-10-14
- **Branch:** `security/label-escaping`
- **HEAD:** `a10e6ee462ee163e6bb359b71f4c2e148aba8042`
- **Scope:** `supabase/baseline/`, all SQL migration and rollback files, database-facing frontend calls, and the project database notes.
- **Method:** Static SQL/source inspection and object-name inventory, supplemented by owner-supplied live catalog/ACL results dated 2026-10-14. The assistant ran no SQL and did not connect to the database.
- **Limitations:** `00_baseline_schema.sql` is explicitly a reconstructed reference, not an authoritative live schema export. Supplied results omit migration history, RLS policy definitions, full function bodies/settings, and runtime authorization tests.

## Owner-supplied live evidence (2026-10-14)

- **Sales/returns migration:** The live catalog output contains the expected return tables and sales/return functions, but no `supabase_migrations.schema_migrations` result was supplied. Therefore the migration's recorded/applied status is **NOT-VERIFIED**; object presence does not prove the whole migration ran.
- **Return-table access (DB-02): VERIFIED-LIVE, direct API access absent in supplied results.** `return_policy_settings`, `sale_returns`, and `sale_return_items` report `rls_on=true`, `rls_forced=false`; anon and authenticated SELECT/INSERT/UPDATE/DELETE are all false. Their RLS policies were not included.
- **Anon function execution (DB-06): VERIFIED-LIVE exposure.** Anon EXECUTE is true for the 16 SECURITY DEFINER functions and `ean13_check_digit` listed in [FINDINGS.csv](./FINDINGS.csv). Whether calls can read or mutate data depends on function guards, which were not tested or included in the supplied result.
- **Post-remediation status (owner update):** The owner says the anon-EXECUTE migration was run, but the three post-migration query results were not included in the message. DB-06 therefore remains **STILL-OPEN**, not VERIFIED-LIVE-FIXED. The app-test outcome was also not supplied.
- **Authenticated table grants (DB-07): grants verified; effective data access NOT-VERIFIED.** The output shows authenticated SELECT and/or DML privileges on `audit_logs`, `brands`, `categories`, `customers`, `khata_entries`, `medicine_units`, `medicines`, `print_requests`, `profiles`, `sale_payments`, `sales`, `stock_movements`, `supplier_ledger`, and `suppliers`, with RLS enabled but not forced. Policy definitions and column grants were not supplied; customer/supplier privacy and cashier visibility of medicine cost columns remain unverified.
- The output shows anon has no SELECT/INSERT/UPDATE/DELETE privilege on `stock_batches`, `purchases`, `purchase_items`, `sale_items`, or `sale_item_batch_allocations`. This does not resolve anon execution on SECURITY DEFINER RPCs that may access those tables.

## Snapshot from checked-in SQL

- The baseline defines 14 tables. Later migration files add 10 named tables, for 24 distinct application table names in the checked-in SQL history: `profiles`, `customers`, `suppliers`, `medicines`, `medicine_units`, `purchases`, `stock_batches`, `sales`, `sale_items`, `sale_item_batch_allocations`, `sale_payments`, `purchase_items`, `stock_movements`, `khata_entries`, `categories`, `brands`, `audit_logs`, `print_requests`, `purchase_number_state`, `supplier_ledger`, `trash_bin_events`, `return_policy_settings`, `sale_returns`, and `sale_return_items`.
- Static inventory found 32 SQL files in `supabase/migrations/`, 10 in `supabase/rollback/`, and two rollback-named SQL files inside `supabase/migrations/`. The latter are valid timestamped filenames and contain destructive drop operations; see DB-01.
- The static declaration scan found 58 unique public function names across the baseline, migration, and rollback history. This is a historical-source count, **not** a live function count. The baseline enables RLS for its 14 tables; migrations add RLS setup for several later tables. Live verification is partial: see DB-02, DB-06, and DB-07; other policy/grant details remain unverified.
- The high-sensitivity tables include `stock_batches`, `purchases`, `purchase_items`, `sale_items`, and `sale_item_batch_allocations`. Do not grant these base tables to `anon` or `authenticated`; the intended access pattern is permission-checked RPCs.

## Stock statistics definitions — side by side

The active `products_overview_stats()` definition is the replacement in `20261010055000_sellable_stock_status_alignment.sql`; the earlier definition is in `20261010040000_products_redesign_rpc.sql`. `stock_alerts_summary(integer)` is in `20261013140000_stock_alerts_summary.sql`.

| Rule | `products_overview_stats()` | `stock_alerts_summary(p_limit)` |
|------|-----------------------------|---------------------------------|
| Active medicines | Only active medicines contribute to low/out counts. The RPC also requires an active, non-deleted profile and `products` permission. | Only active medicines contribute. The RPC requires an active, non-deleted profile; no module permission is required by design. |
| Sellable stock | Sum `quantity_remaining` where it is `> 0`, `expiry_date >= current_date`, and batch `status` is `ACTIVE` or `NEAR_EXPIRY`. | Same predicate and sum. |
| Low stock | `min_stock_alert > 0`, sellable stock `> 0`, and sellable stock `<= min_stock_alert`. | Same predicate; `kind = 'low'`. |
| Out of stock | Sellable stock `= 0` for an active medicine; this KPI does **not** require a positive reorder threshold. | `min_stock_alert > 0` and sellable stock `= 0`; `kind = 'out'`. Medicines with no reorder level are excluded to avoid noise. |
| Returned data | KPI JSON includes active count, low/out counts, expiring count, and a cost stock-value field only when `can_view_cost()` allows it. | `low_count`, `out_count`, `generated_at`, and limited medicine rows with `medicine_id`, `name`, `strength`, `generic_name`, `stock`, `min_stock_alert`, and `kind`. No cost, MRP, supplier, or cost-derived field is built. |
| Ordering/limit | Not an alert-item list. | Out rows first, then largest reorder deficit, then name. `p_limit` is clamped to 1–200; totals are computed before limiting the item list. |
| Shop scope | No shop column/filter exists. | The future filter is explicitly commented at the `medicine_stock` CTE; no `shop_id` column is present or added. |

**Interpretation:** The shared sellable-stock predicate is aligned. The intentional behavioral difference is that the Products KPI's `out_of_stock` includes active medicines with a zero reorder threshold, while the alerts RPC excludes those rows. Therefore the two out-of-stock counts may differ without a stock-calculation mismatch.

## Database findings

### DB-01 — Rollback SQL is stored in the forward migration directory

**Status:** `NOT-VERIFIED`
**Severity:** HIGH operational risk if a timestamp-based migration runner is used
**Files:** `20261012180001_assign_medicine_barcodes_rollback.sql` and `20261012181001_medicines_barcode_unique_index_rollback.sql` under `supabase/migrations/`.

The first revokes and drops barcode-assignment functions and a sequence. The second drops `medicines_barcode_unique`. When a migration runner processes all unapplied timestamped `.sql` files, these scripts are treated as forward migrations and undo the immediately preceding barcode migrations. The owner should inspect the migration ledger before any `db push`/automated migration run; do not blindly apply or move them without checking whether the versions have already been recorded.

### DB-02 — Return tables rely on effective defaults rather than explicit table policy

**Status:** `VERIFIED-LIVE` — no direct anon/authenticated table privileges in supplied results
**Severity:** MEDIUM (creation migration omits explicit setup; live direct access appears closed)

`20261013160000_persist_sales_and_returns.sql` creates `return_policy_settings`, `sale_returns`, and `sale_return_items` without enabling RLS or setting explicit table grants. The earlier `20261012140000_lockdown_anon_public_access.sql` revokes default privileges for objects created by `postgres`, and `20261012140500_optional_lockdown_supabase_admin_defaults.sql` addresses `supabase_admin`. The owner-supplied 2026-10-14 result resolves the direct API-role privilege question for the current project: all three tables report RLS enabled and anon/authenticated SELECT/INSERT/UPDATE/DELETE false. RLS is not forced. The policy definitions were not included; preserve RPC-only access and recheck grants after schema changes.

This verifies no direct table access for the reported API roles, not all function-mediated access or the migration ledger state.

### DB-03 — Multi-shop isolation is not implemented

**Status:** `STILL-OPEN`
**Severity:** MEDIUM release gate before a second shop is onboarded

No `shop_id` or `tenant_id` column/filter exists in the checked-in baseline/migrations. The approved multi-shop plan itself says staging bootstrap and a two-shop isolation test are prerequisites. Current code should be treated as single-shop; adding another shop to the same project before tenant scoping and authorization is unsafe.

### DB-04 — Cost visibility depends on RPC code, column grants, and live policies

**Status:** `NOT-VERIFIED`
**Severity:** MEDIUM assurance gap

The supplied results show authenticated SELECT on `medicines` and `can_view_cost` EXECUTE false for anon and authenticated. This does not prove cost columns are hidden: RLS filters rows, not columns, and policy/column grants and RPC payloads were not supplied. Do not claim cashier cost confidentiality is live-verified until column-level and API-response checks are performed.

### DB-06 — Anonymous EXECUTE on SECURITY DEFINER functions

**Status:** `VERIFIED-LIVE`
**Severity:** HIGH pending review

The earlier supplied function ACL output reports anon EXECUTE true for SECURITY DEFINER functions `deactivate_supplier`, `has_any_permission`, `is_admin`, `is_staff`, `master_data_overview`, `post_purchase`, `purchase_catalog`, `purchase_detail`, `purchase_history`, `save_supplier`, `stock_adjustments_log`, `stock_batches_list`, `stock_expiry_buckets`, `stock_overview_stats`, `void_purchase`, and `write_off_expired_batch`. It also reports anon EXECUTE true for non-definer `ean13_check_digit`. The listed sales/return RPCs show anon EXECUTE false. The owner subsequently reports running an anon-EXECUTE migration, but supplied no post-migration result for the required anon-executable SECURITY DEFINER query; the earlier exposure is not yet verified fixed.

The earlier grant exposure is confirmed by the supplied result; the owner now reports a remediation migration was run, but its post-migration query output is missing. Do not mark the issue fixed until the first verification query returns no rows. The grant results do **not** prove an anonymous caller can bypass checks or access data. Function definitions, guards, `search_path` settings for this full set, and behavior under an anon JWT were not provided. Review and test unless there is a documented public requirement.

### DB-07 — Authenticated table privileges require policy and column review

**Status:** `NOT-VERIFIED`
**Severity:** HIGH before customer data

The supplied output reports authenticated SELECT and/or DML privileges for `audit_logs`, `brands`, `categories`, `customers`, `khata_entries`, `medicine_units`, `medicines`, `print_requests`, `profiles`, `sale_payments`, `sales`, `stock_movements`, `supplier_ledger`, and `suppliers`; RLS is enabled but not forced. Because applicable policy definitions and column-level grants are absent, the output alone cannot establish whether each role's access is properly constrained. Verify customer/supplier-data isolation and cashier visibility of medicine cost fields before loading real data.

### DB-05 — Baseline is not a migration plan or live catalog

**Status:** `STILL-OPEN`

`supabase/baseline/00_baseline_schema.sql` states it is a reference snapshot. It also includes an early `post_purchase` movement-type constraint that is replaced by a later migration. Do not replay the baseline against a populated project. Use the Supabase migration history and SELECT-only catalog checks.

## Migration/rollback notes

- The 10 rollback files under `supabase/rollback/` are not a complete one-to-one rollback set for all 32 migration files.
- The rollback for `20261013160000_persist_sales_and_returns.sql` drops return objects/data; running it after real returns are recorded is destructive. It also does not recreate the previous `stock_batches_check` constraint that the migration drops.
- The rollback for the global anonymous-access lockdown restores broad privileges. Treat it as a privileged security change, not a routine undo.
- The supplied live catalog contains expected sales/return tables and functions, but no migration-history/version result was supplied. Whether `20261013160000_persist_sales_and_returns.sql` is recorded as applied remains **NOT-VERIFIED**.
- The newer owner-provided function ACL output reports anon EXECUTE true for the functions listed in DB-06. It omits `search_path` and body checks for that full set. Earlier selected sale/return and stock-alert metadata showed `search_path=public`, anon EXECUTE false, and authenticated EXECUTE true; do not generalize that to every function.

## Relevant static public-function names

Historical SQL declarations (not guaranteed to exist live): `adjust_stock`, `assign_medicine_barcode`, `assign_missing_barcodes`, `can_view_cost`, `capture_trash_bin_event`, `customer_accounts_summary`, `deactivate_supplier`, `decide_print_request`, `delete_brand`, `delete_category`, `ean13_check_digit`, `get_return_policy_settings`, `has_any_permission`, `is_admin`, `is_staff`, `list_print_requests`, `mark_printed_request`, `master_data_overview`, `merge_brands`, `merge_categories`, `modify_print_request`, `pending_print_count`, `pending_sale_returns`, `pos_catalog`, `pos_customers`, `post_purchase`, `post_sale`, `process_sale_return`, `products_bulk_import`, `products_bulk_update`, `products_import_preview`, `products_list`, `products_overview_stats`, `purchase_catalog`, `purchase_detail`, `purchase_history`, `record_customer_payment`, `reject_sale_return`, `request_print`, `request_sale_return`, `restore_trash_medicine`, `restore_trash_supplier`, `sale_for_return`, `sales_history`, `save_brand`, `save_category`, `save_customer`, `save_medicine`, `save_supplier`, `stock_adjustments_log`, `stock_alerts_summary`, `stock_batches_list`, `stock_expiry_buckets`, `stock_overview_stats`, `trash_bin_events_list`, `update_return_policy_settings`, `void_purchase`, and `write_off_expired_batch`.
