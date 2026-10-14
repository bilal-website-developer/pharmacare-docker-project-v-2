# Owner Query Pack — SELECT Only

- **Date:** 2026-10-14
- **Branch:** `security/label-escaping`
- **HEAD:** `a10e6ee462ee163e6bb359b71f4c2e148aba8042`
- **Scope:** Read-only Supabase SQL checks for migration state, function security/ACLs, table RLS/grants, and return consistency.
- **Method:** Queries below are SELECT-only and were not run by the assistant.
- **Limitations:** Run against the intended project using a read-only review process. SQL Editor role visibility can affect metadata; these checks report database facts but do not mutate objects or data.

Do **not** run any migration/rollback as part of these checks. The owner supplied function ACL, table privilege, and RLS query results on 2026-10-14; their interpretation is recorded below. The assistant did not execute these queries.

## Owner-supplied result summary (2026-10-14)

- The return tables `return_policy_settings`, `sale_returns`, and `sale_return_items` exist, have RLS enabled (not forced), and report anon/authenticated SELECT/INSERT/UPDATE/DELETE false.
- Expected sales/return RPC names are present. The supplied results show anon EXECUTE false for those listed sales/return functions and `stock_alerts_summary`; this does not verify their live bodies or end-to-end behavior.
- The function result also reports anon EXECUTE true for 16 SECURITY DEFINER functions: `deactivate_supplier`, `has_any_permission`, `is_admin`, `is_staff`, `master_data_overview`, `post_purchase`, `purchase_catalog`, `purchase_detail`, `purchase_history`, `save_supplier`, `stock_adjustments_log`, `stock_batches_list`, `stock_expiry_buckets`, `stock_overview_stats`, `void_purchase`, and `write_off_expired_batch`. It reports anon EXECUTE true for non-definer `ean13_check_digit`. These grants need function-body/guard review; grant metadata alone does not prove a successful unauthorized call.
- Authenticated SELECT and/or DML privileges are reported for `audit_logs`, `brands`, `categories`, `customers`, `khata_entries`, `medicine_units`, `medicines`, `print_requests`, `profiles`, `sale_payments`, `sales`, `stock_movements`, `supplier_ledger`, and `suppliers`; RLS is enabled but not forced. The policy definitions and column grants were not supplied, so effective row/column access remains unverified.
- Anon SELECT/INSERT/UPDATE/DELETE are false on the five sensitive base tables `stock_batches`, `purchases`, `purchase_items`, `sale_items`, and `sale_item_batch_allocations`.
- Expected return tables/functions exist in the current project, but no migration-history query result was supplied. Whether `20261013160000_persist_sales_and_returns.sql` is recorded as applied remains unverified.

## 1. Applied migration history

```sql
select version, name
from supabase_migrations.schema_migrations
order by version;
```

Confirm the expected versions are recorded, particularly stock alerts, POS catalog, sales/returns, and the two timestamped barcode rollback files. If the migration schema/table is unavailable, stop and use the project's documented migration-history method; do not infer applied status from local filenames.

## 2. All public SECURITY DEFINER functions and API-role execute grants

```sql
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  p.prosecdef as security_definer,
  coalesce(array_to_string(p.proconfig, ', '), '') as function_settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
order by p.proname, identity_arguments;
```

Review every row for a fixed `search_path=public` (or safer qualified references), expected active-profile/permission guards, `anon_execute=false`, and only intended authenticated execution.

## 3. Required sales/return and stock-alert function ACLs

```sql
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  p.prosecdef as security_definer,
  coalesce(array_to_string(p.proconfig, ', '), '') as function_settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'stock_alerts_summary', 'pos_catalog', 'post_sale', 'sale_for_return',
    'request_sale_return', 'pending_sale_returns', 'process_sale_return',
    'reject_sale_return', 'get_return_policy_settings', 'update_return_policy_settings'
  )
order by p.proname, identity_arguments;
```

## 4. Return table RLS and effective API-role privileges

```sql
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
  has_table_privilege('anon', c.oid, 'INSERT') as anon_insert,
  has_table_privilege('anon', c.oid, 'UPDATE') as anon_update,
  has_table_privilege('anon', c.oid, 'DELETE') as anon_delete,
  has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
  has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_insert,
  has_table_privilege('authenticated', c.oid, 'UPDATE') as authenticated_update,
  has_table_privilege('authenticated', c.oid, 'DELETE') as authenticated_delete
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and c.relname in ('return_policy_settings', 'sale_returns', 'sale_return_items')
order by c.relname;
```

## 5. Cost-bearing table privileges

```sql
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
  has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
  has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_insert,
  has_table_privilege('authenticated', c.oid, 'UPDATE') as authenticated_update,
  has_table_privilege('authenticated', c.oid, 'DELETE') as authenticated_delete
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and c.relname in (
    'stock_batches', 'purchases', 'purchase_items', 'sale_items',
    'sale_item_batch_allocations'
  )
order by c.relname;
```

The expected result is no direct API-role access to the listed cost-bearing tables, consistent with the approved policy. Do not grant direct access as a quick fix for a page.

## 6. Default privileges that affect newly created public objects

```sql
select
  r.rolname as owner_role,
  n.nspname as schema_name,
  d.defaclobjtype as object_type,
  d.defaclacl as default_acl
from pg_default_acl d
join pg_roles r on r.oid = d.defaclrole
join pg_namespace n on n.oid = d.defaclnamespace
where n.nspname = 'public'
order by r.rolname, d.defaclobjtype;
```

## 7. Return table policies

```sql
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('return_policy_settings', 'sale_returns', 'sale_return_items')
order by tablename, policyname;
```

## 8. Compare live stock summary function definitions

```sql
select
  'products_overview_stats' as function_name,
  pg_get_functiondef('public.products_overview_stats()'::regprocedure) as definition
union all
select
  'stock_alerts_summary' as function_name,
  pg_get_functiondef('public.stock_alerts_summary(integer)'::regprocedure) as definition;
```

Compare the active definitions with `20261010055000_sellable_stock_status_alignment.sql` and `20261013140000_stock_alerts_summary.sql`. Verify the returned stock predicate and the intentional `min_stock_alert > 0` difference for out-of-stock counts.

## 9. Return status totals (aggregate only)

```sql
select status, count(*) as return_count
from public.sale_returns
group by status
order by status;
```

This returns aggregate counts only and avoids exposing customer names, invoice numbers, reasons, or other personal details.

## 10. Manual console checks outside SQL

- Confirm the active migration history includes the expected files and that rollback-named files were not treated as forward deployments.
- Confirm deployed Edge Function version/configuration, allowed origins, and server-only secret configuration without copying any secret values.
- Verify Supabase Auth settings (providers, email/phone confirmation, MFA policy, password policy, session policy) and production hosting response headers.
- Do not paste credentials, JWTs, customer rows, invoice numbers, or prescription details into an audit report.
