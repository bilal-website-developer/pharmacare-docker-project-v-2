# MongoDB Migration Inventory

**Phase:** 0 — read-only inventory  
**Branch:** `feature/mongo-migration` (created from the clean `security/revoke-public-execute` checkout)  
**Scope:** checked-in frontend, Supabase migrations/baseline, and `manage-users` Edge Function. No SQL was run and no live Supabase project was queried. `.env` files were not read.

This is a source inventory, not proof that the live Supabase project has the same schema or permissions. In particular, `supabase/baseline/00_baseline_schema.sql` says it is reconstructed from a schema summary and omits grants, triggers, views, extensions, and other metadata. SQL migrations may also be unapplied or differ from the live deployment.

## 1. Supabase use in `src/`

There are **68 Supabase call sites across 18 source files**: 12 direct table-query starts, 42 RPC call sites (41 literal RPC names plus one shared dynamic RPC wrapper), 13 Auth calls, and one Edge Function invocation. No Supabase Storage or Realtime call site was found.

| Screen/module | Call sites | What they do |
|---|---:|---|
| App shell (`App.tsx`) | 9 | Session/user reads, auth-state subscription, sign-out, and `pending_print_count`. |
| Login (`LoginView.tsx`) | 1 | Password sign-in. |
| Navigation (`TopNav.tsx`) | 1 | Authenticated-user lookup. |
| User management (`ManageUsersView.tsx`) | 3 | `manage-users` Edge Function; re-authenticates and updates the current user's password. |
| Auth/profile helper (`utils/auth.ts`) | 2 | Reads the caller's `profiles` row and signs out. |
| Products / Stock Products (`InventoryScreen.tsx`) | 14 | Reads categories, brands, and medicine units; product list/stats/import, bulk update, medicine save, and barcode RPCs. |
| Master Data (`MasterDataView.tsx`) | 3 | Master-data overview RPC and direct reads of medicines/units. |
| Stock Inventory (`inventory/StockInventory.tsx`) | 12 | Batch/stats/expiry/movement reads, stock adjustment, and expired-stock write-off. |
| Suppliers (`SuppliersView.tsx`) | 3 | Supplier table read, save, and deactivate. |
| Purchase entry (`StockPurchaseView.tsx`) | 3 | Purchase catalog, supplier table read, and purchase posting. |
| Purchase History (`PurchaseHistoryView.tsx`) | 4 | Purchase history/detail reads and purchase void. |
| POS customer/sale data (`data/sales.ts`) | 1 | Shared dynamic `callSupabaseRpc(name, args, ...)` wrapper; exported flows call the customer, ledger, sale, history, and return RPCs through this one site. |
| POS catalog (`data/posCatalog.ts`) | 1 | `pos_catalog`. |
| Stock alerts (`data/stockAlerts.ts`) | 1 | `stock_alerts_summary`. |
| Trash Bin (`TrashBinView.tsx`) | 3 | Lists events and restores medicine/supplier. |
| Print requests (`MyPrintRequestsView.tsx`) | 1 | Reads the caller's `print_requests`. |
| Print request administration (`PrintRequestsAdminView.tsx`) | 4 | Reads print requests/profiles and modifies/decides requests. |
| Print workflow (`data/printWorkflow.ts`) | 2 | Creates a print request and marks it printed. |

There are **12 direct table-query call sites**. They touch `profiles`, `categories`, `brands`, `medicines`, `medicine_units`, `suppliers`, and `print_requests`. Most other persisted workflows call RPCs. The `data/sales.ts` wrapper is one source call site, not one business operation; it fronts the following RPC family: `pos_customers`, `save_customer`, `record_customer_payment`, `customer_accounts_summary`, `post_sale`, `sales_history`, `sale_for_return`, `request_sale_return`, `pending_sale_returns`, `reject_sale_return`, `process_sale_return`, and return-policy reads/writes.

`POSScreen.tsx` is legacy/unreferenced and has no Supabase data call. `CustomerLedgerScreen`, Cash Book, Dashboard sample KPIs, and other screens have local/mock/in-memory behavior that still needs migration or replacement; see the rebuild matrix below.

## 2. Supabase schema and server-function inventory

### 2.1 Tables and views

The baseline defines 14 tables. Migrations contain 25 `CREATE TABLE` statements for 10 additional distinct table names plus a repeated `audit_logs` declaration (`IF NOT EXISTS`). Thus the checked-in files describe **24 distinct table names** and **zero views**.

| Origin | Table | Purpose / notable additions |
|---|---|---|
| Baseline | `profiles` | Auth-linked user profile, role, active/deleted state, permissions. Later migration extends the allowed permission array. |
| Baseline | `customers` | Contact details, credit limit and running balance; later gains store-credit balance. |
| Baseline | `suppliers` | Supplier identity, contact, terms and active state; later gains payable balance. |
| Baseline | `medicines` | Product master, code/barcode, classification, storage, active state; later gains strength. |
| Baseline | `medicine_units` | Product-specific unit, conversion factor, sale price, barcode. |
| Baseline | `purchases` | Purchase header; later gains PR number, subtotal/discount/payment type and void reason. |
| Baseline | `stock_batches` | Batch expiry, quantities, cost/MRP and status; later gains return quantity and a revised quantity check. |
| Baseline | `sales` | Invoice header, totals/status; later gains rounding, tender and change. |
| Baseline | `sale_items` | Sale item snapshots, pricing, discount and unit conversion; later gains line adjustments and unit reference. |
| Baseline | `sale_item_batch_allocations` | Per-sale-line allocation to the original stock batch. |
| Baseline | `sale_payments` | One or more tender rows per sale. |
| Baseline | `purchase_items` | Purchase item and batch reference; later gains bonus quantity. |
| Baseline | `stock_movements` | Batch quantity movement ledger. |
| Baseline | `khata_entries` | Customer ledger entries. |
| Migrations | `purchase_number_state` | Singleton purchase-number counter (`id = 1`); currently global, not shop-scoped. |
| Migrations | `supplier_ledger` | Supplier purchase/void balance entries. |
| Migrations | `categories` | Medicine categories. |
| Migrations | `brands` | Manufacturer/brand lookup. |
| Migrations | `audit_logs` | Actor/action/entity audit records. Declared in two migrations, with the latter guarded by `IF NOT EXISTS`. |
| Migrations | `print_requests` | Sale/payment print request, snapshot payload, decision and status. |
| Migrations | `trash_bin_events` | User/product/supplier/purchase soft-delete, deactivate, void and restore event history. |
| Migrations | `return_policy_settings` | Single-row return-window and restock-shelf-life policy (`id = 1`). |
| Migrations | `sale_returns` | Return request/decision header and refund information. |
| Migrations | `sale_return_items` | Batch-allocation-specific returned quantity, disposition and refund. |

The SQL schema is single-shop: the checked-in business tables do not consistently contain a `shop_id`, and current unique constraints/counters are global. That differs from the migration target's required per-shop scoping.

### 2.2 RLS policies

The baseline has 56 policies: each of its 14 tables has the conventional four-policy set `add by permission`, `admin can delete`, `edit by permission`, and `read by permission`, with the actual names below. Migrations add 10 policy declarations (9 distinct names; `audit_logs_admin_select` is declared twice). Total: **66 policy declarations / 65 distinct policy names** in the checked files.

| Table | Baseline policy names and intent |
|---|---|
| `customers` | `customers add by permission` (customers or POS); `customers admin can delete`; `customers edit by permission` (customers or POS); `customers read by permission` (customers or POS). |
| `khata_entries` | `khata_entries add by permission` (customers or POS); `khata_entries admin can delete`; `khata_entries edit by permission` and `khata_entries read by permission` use an empty permission array, which the helper resolves to Admin/Super Admin only. |
| `medicine_units` | `medicine_units add by permission` (products); `medicine_units admin can delete`; `medicine_units edit by permission` (products); `medicine_units read by permission` (a broad configured module list). |
| `medicines` | `medicines add by permission` (products); `medicines admin can delete`; `medicines edit by permission` (products); `medicines read by permission` (a broad configured module list). |
| `profiles` | `profiles admin can add profiles`; `profiles admin can delete profiles`; `profiles admin can edit profiles`; `profiles read own profile or admin reads all`. |
| `purchase_items` | `purchase_items add by permission` (purchases); `purchase_items admin can delete`; `purchase_items edit by permission` (purchases); `purchase_items read by permission` (purchases, purchase history or reports). |
| `purchases` | `purchases add by permission` (purchases); `purchases admin can delete`; `purchases edit by permission` (purchases); `purchases read by permission` (purchases, purchase history or reports). Superseded by purchase-history read-only policy in the purchase migration. |
| `sale_item_batch_allocations` | `sale_item_batch_allocations add by permission` (POS); `sale_item_batch_allocations admin can delete`; `sale_item_batch_allocations edit by permission` (POS); `sale_item_batch_allocations read by permission` (POS, sales history or reports). |
| `sale_items` | `sale_items add by permission` (POS); `sale_items admin can delete`; `sale_items edit by permission` (POS); `sale_items read by permission` (POS, sales history or reports). |
| `sale_payments` | `sale_payments add by permission` (POS); `sale_payments admin can delete`; `sale_payments edit by permission` (POS); `sale_payments read by permission` (POS, sales history or reports). |
| `sales` | `sales add by permission` (POS); `sales admin can delete`; `sales edit by permission` (POS); `sales read by permission` (POS, sales history or reports). |
| `stock_batches` | `stock_batches add by permission` (purchases or stock inventory); `stock_batches admin can delete`; `stock_batches edit by permission` (POS, purchases or stock inventory); `stock_batches read by permission` (stock inventory, POS, purchases, purchase history, products or reports). Direct reads are a cost-leakage risk unless the later table revokes are in effect. |
| `stock_movements` | `stock_movements add by permission` (POS, purchases or stock inventory); `stock_movements admin can delete`; `stock_movements edit by permission` (empty permission array, therefore Admin/Super Admin only); `stock_movements read by permission` (stock inventory or reports). |
| `suppliers` | `suppliers add by permission` (suppliers); `suppliers admin can delete`; `suppliers edit by permission` (suppliers); `suppliers read by permission` (suppliers). Later supplier migration changes writes to RPC-only. |

Migration policies:

- `supplier ledger read by purchase history` — `purchase_history` permission.
- `purchase history read` and `purchase history items read` — `purchase_history` permission; replaces broad purchase-table client access.
- `categories read by active staff` and `brands read by active staff` — active staff; corresponding `categories write by permission` / `brands write by permission` use the categories permission.
- `audit_logs_admin_select` — admin read access; created in the audit migration and guarded/repeated in the print-request migration.
- `print_requests_read_own_or_admin` — requester-owned rows or admin access.

The return tables and Trash Bin table do not have a corresponding checked-in RLS policy declaration in the reviewed migration text; their intended paths are permission-checked RPCs. Direct table grants/RLS effectiveness still require runtime/live metadata verification. Lockdown migrations revoke browser table privileges and anon function execution but are proposals in source until deployment is verified.

### 2.3 Triggers

Three SQL triggers are declared by `20261012170000_trash_bin_history.sql`:

- `medicines_trash_bin_event`
- `suppliers_trash_bin_event`
- `purchases_trash_bin_event`

They call `capture_trash_bin_event()` to append Trash Bin events for relevant deactivation/restore/void state changes. The trigger function also handles profile-related events in its logic, but there is no profile trigger declaration in this migration; `manage-users` writes profile events directly.

### 2.4 CHECK constraints

There are **70 CHECK clauses/declarations** across the baseline and migrations. Three baseline constraints are replaced later (`stock_batches_check`, `profiles_permissions_valid`, and `purchases_status_check`), leaving **67 effective checks** if the entire applicable migration chain is applied. Names below are SQL identifiers; inline unnamed checks are described by field/expression.

| Table / object | Constraints and conditions |
|---|---|
| `profiles` | `profiles_role_check`: role in cashier/manager/accountant/admin/super_admin. `profiles_permissions_valid`: permission array limited to SQL's allowed keys; replaced in `20261009201000_add_pos_print_permissions.sql` to add `manage_users` and print toggles, with a rule that print toggles require POS. |
| `customers` | `customers_credit_limit_paisa_check` and `customers_current_balance_paisa_check`: nonnegative. `customers_store_credit_paisa_check`: store credit nonnegative. |
| `medicines` | `medicines_drug_class_check`: OTC/RX/CONTROLLED/NARCOTIC; `medicines_min_stock_alert_check`: nonnegative; `medicines_storage_condition_check`: ROOM_TEMPERATURE/COOL/COLD_REFRIGERATED. |
| `medicine_units` | `medicine_units_conversion_factor_check`: positive; `medicine_units_price_paisa_check`: nonnegative. |
| `purchases` | `purchases_paid_paisa_check`, `purchases_total_paisa_check`, and later `purchases_subtotal_paisa_check`/`purchases_discount_paisa_check`: nonnegative. `purchases_payment_status_check`: unpaid/partial/paid. `purchases_payment_type_check`: cash/credit. `purchases_status_check`: baseline posted/cancelled, replaced by posted/void/cancelled. |
| `purchase_items` | `purchase_items_conversion_factor_check`: positive; `purchase_items_mrp_paisa_check` and `purchase_items_unit_cost_paisa_check`: nonnegative; `purchase_items_quantity_check`: positive; later `purchase_items_bonus_qty_check`: nonnegative. |
| `stock_batches` | Baseline `stock_batches_check`: remaining <= received; `stock_batches_cost_paisa_per_base_unit_check` and `stock_batches_mrp_paisa_per_base_unit_check`: nonnegative; `stock_batches_quantity_received_check` and `stock_batches_quantity_remaining_check`: nonnegative; `stock_batches_status_check`: ACTIVE/NEAR_EXPIRY/EXPIRED/QUARANTINE/DAMAGED/RETURNED/RECALLED/SOLD_OUT. The return migration drops the old received/remaining relation and adds `stock_batches_received_and_returned_check`: received >= 0, returned >= 0, remaining <= received + returned. |
| `sales` | `sales_discount_paisa_check`, `sales_subtotal_paisa_check`, `sales_total_paisa_check`: nonnegative; `sales_status_check`: COMPLETED/VOIDED/PARTIALLY_RETURNED/RETURNED. |
| `sale_items` | `sale_items_conversion_factor_check`: positive; `sale_items_cost_paisa_per_base_unit_check` and `sale_items_price_paisa_per_unit_check`: nonnegative; `sale_items_discount_percent_check`: 0–100; `sale_items_line_total_paisa_check`: nonnegative; `sale_items_quantity_base_units_check` and `sale_items_quantity_in_unit_check`: positive. |
| `sale_item_batch_allocations` | `sale_item_batch_allocations_cost_paisa_per_base_unit_check`: nonnegative; `sale_item_batch_allocations_quantity_base_units_check`: positive. |
| `sale_payments` | `sale_payments_amount_paisa_check`: nonnegative; `sale_payments_payment_method_check`: CASH/CARD/EASYPAISA/JAZZCASH/CREDIT. |
| `stock_movements` | `stock_movements_movement_type_check`: RECEIPT/SALE/SALE_RETURN/ADJUSTMENT/WRITE_OFF/PURCHASE_RETURN; `stock_movements_quantity_delta_check`: nonzero. |
| `khata_entries` | `khata_entries_credit_paisa_check` and `khata_entries_debit_paisa_check`: nonnegative; `khata_entries_entry_type_check`: INVOICE/PAYMENT/RETURN/ADJUSTMENT. |
| `purchase_number_state` | Singleton `id = 1`; `last_number >= 0`. |
| `supplier_ledger` | `entry_type` is purchase/void; `amount_paisa` is nonzero. |
| `print_requests` | `type` is sale/payment; `payload` has the expected JSON shape; `status` is pending/approved/rejected. |
| `trash_bin_events` | `entity_type` is profile/medicine/supplier/purchase; `action` is deleted/deactivated/voided/restored. |
| `return_policy_settings` | Singleton `id = 1`; return window 0–365 days; minimum restock shelf life 0–3650 days. |
| `sale_returns` | Status PENDING/COMPLETED/REJECTED; refund method CASH/CREDIT; refund total nonnegative. |
| `sale_return_items` | Positive base-unit quantity; disposition RESTOCK/QUARANTINE/WRITE_OFF; refund nonnegative. |

### 2.5 SQL functions and RPC behavior

The checked files contain **71 `CREATE OR REPLACE FUNCTION` definitions and 58 distinct function names**, because migrations replace earlier versions. The final signature below is the newest checked-in definition where there are overrides. Function writes execute as one PostgreSQL function call; mutating calls have no explicit nested `BEGIN/COMMIT` and are statement-atomic when invoked as a Supabase RPC. No live transaction behavior was exercised.

#### Signatures, result type, authorization, and effect

| Function (latest signature; result) | Checks / output / writes / transaction |
|---|---|
| `is_admin() -> boolean` | Active Admin or Super Admin profile lookup in the later override; no write. |
| `has_any_permission(perms text[]) -> boolean` | Requires active, non-deleted profile; admin or any requested permission; no write. |
| `is_staff() -> boolean` | Active, non-deleted profile lookup; no write. |
| `can_view_cost() -> boolean` | Active, non-deleted Admin/Super Admin; Manager with products/stock_inventory/purchases/purchase_history; Accountant with purchase_history/reports; cashier is denied; no write. |
| `post_purchase(p_supplier_id uuid, p_invoice_number text, p_purchase_date date, p_paid_paisa integer, p_notes text, p_items jsonb, p_discount_paisa integer, p_payment_type text) -> jsonb` | Requires purchases permission and cost visibility. Validates supplier, payment type, quantities, units, costs/MRP, expiry after purchase date, discount <= subtotal, and integer bounds. Writes purchase, batches, movements, items, supplier balance/ledger and audit data in one call. |
| `purchase_catalog() -> jsonb` | Requires purchases permission; product/unit/supplier purchase catalog, with cost fields gated by `can_view_cost`; read-only. |
| `purchase_history(p_search text, p_payment_type text, p_date_from date, p_date_to date, p_page integer, p_page_size integer, p_export boolean) -> jsonb` | Requires purchase_history and cost visibility in the latest definition; validates filters/date range and pages/exports purchase rows. Read-only. |
| `purchase_detail(p_purchase_id uuid) -> jsonb` | Requires purchase_history and cost visibility in the latest definition; returns a purchase and items, or not found. Read-only. |
| `void_purchase(p_purchase_id uuid, p_reason text) -> void` | Authenticated active Admin/Super Admin with cost visibility; requires reason, posted status, complete batch references, and no stock sold from the purchase. Reverses remaining batch quantities, movements, supplier balance/ledger and audit. One call. |
| `save_category(p_category_id uuid, p_name text, p_is_active boolean) -> uuid` | Requires categories permission; changing a category used by medicines additionally requires products permission; validates/creates or updates category. Mutating call. |
| `delete_category(p_category_id uuid) -> void` | Requires categories permission; checks category usage before removal/deactivation. Mutating call. |
| `save_brand(p_brand_id uuid, p_name text, p_is_active boolean) -> uuid` | Requires categories permission; changing a brand used by medicines additionally requires products permission; validates/creates or updates brand. Mutating call. |
| `delete_brand(p_brand_id uuid) -> void` | Requires categories permission; checks brand usage before removal/deactivation. Mutating call. |
| `adjust_stock(p_batch_id uuid, p_quantity_delta integer, p_reason text) -> integer` | Requires stock_inventory; validates reason and prevents negative stock; updates batch, movement log and audit. One call. |
| `save_medicine(p_medicine_id uuid, p_values jsonb, p_units jsonb) -> uuid` | Requires products permission; validates product/unit values and saves medicine plus units (including strength in the later override). Mutating call. |
| `products_overview_stats() -> jsonb` | Requires active products permission; stock/expiry statistics. Cost-derived totals are nullable/returned only when `can_view_cost`; read-only. |
| `products_list(p_search text, p_category text, p_manufacturer text, p_class text, p_status text, p_low_only boolean, p_sort_col text, p_sort_dir text, p_page integer, p_page_size integer) -> jsonb` | Requires active products permission; validates sort/status/class and paging; list rows include cost/margin only when `can_view_cost`; read-only. |
| `products_import_preview(rows jsonb) -> jsonb` | Requires active products permission; 1–2000 rows, reports duplicate checks; no write. |
| `products_bulk_update(ids uuid[], action text, value text) -> integer` | Requires active products permission; validates IDs/action/category, updates medicines and appends audit event. One call. |
| `products_bulk_import(rows jsonb) -> jsonb` | Requires active products permission; validates 1–2000 rows and duplicates, may create categories/brands and medicines/units; one call. |
| `master_data_overview() -> jsonb` | Requires active categories permission; returns category/brand/product summaries; stock value is gated by cost visibility; read-only. |
| `merge_categories(p_source_category_id uuid, p_target_category_id uuid) -> integer` | Requires categories permission and products permission for affected medicines; repoints medicines, removes source and audits. One call. |
| `merge_brands(p_source_brand_id uuid, p_target_brand_id uuid) -> integer` | Requires categories permission and products permission for affected medicines; repoints medicines, removes source and audits. One call. |
| `stock_overview_stats() -> jsonb` | Requires active stock_inventory permission; stock/expiry counts and values; cost values gated by `can_view_cost`; read-only. |
| `stock_batches_list(p_tab text, p_search text, p_sort text, p_page integer, p_page_size integer, p_medicine_id uuid, p_expiry_bucket text) -> jsonb` | Requires active stock_inventory permission; validates tabs/buckets/sort; blocks cost sorts and nulls cost fields without cost permission; read-only. |
| `stock_expiry_buckets() -> jsonb` | Requires active stock_inventory permission; expiry bucket counts; read-only. |
| `stock_adjustments_log(p_page integer, p_page_size integer, p_date_from date, p_date_to date, p_reason text, p_batch_id uuid) -> jsonb` | Requires active stock_inventory permission; filtered/paged movement log; read-only. |
| `write_off_expired_batch(p_batch_id uuid, p_reason text) -> jsonb` | Requires stock_inventory; validates eligible expired batch/reason, sets quantity/status, writes movement and audit. One call. |
| `save_supplier(p_supplier_id uuid, p_name text, p_contact text, p_address text, p_licence_or_tax_number text, p_payment_terms text) -> uuid` | Requires suppliers permission; validates and creates/updates supplier, audits. One call. |
| `deactivate_supplier(p_supplier_id uuid) -> uuid` | Requires suppliers permission; deactivates supplier and audits. One call. |
| `request_print(p_type text, p_receipt_ref text, p_payload jsonb) -> jsonb` | Requires the matching `pos_print_sale` or `pos_print_payment` permission and validates request payload. Creates print request and audit row. One call. |
| `decide_print_request(p_request_id uuid, p_decision text, p_note text) -> jsonb` | Admin permission; validates pending state/decision, records decision and audit. One call. |
| `pending_print_count() -> bigint` | Active Admin/Super Admin only; returns pending count and appends a `print_request_count_viewed` audit row. One call. |
| `mark_printed_request(p_request_id uuid) -> timestamptz` | Checks caller/permission and request status; updates printed state/time and audit. One call. |
| `list_print_requests() -> jsonb` | Admin-only in the migration; returns queue and requester identity data; read-only. |
| `modify_print_request(p_request_id uuid, p_lines jsonb, p_discount_paisa bigint) -> jsonb` | Active admin; validates pending sale request, item/discount data and bounds; changes the receipt snapshot only and writes audit, not the completed sale. One call. |
| `capture_trash_bin_event() -> trigger` | Trigger-only state-change capture; appends a `trash_bin_events` row. Runs in the originating database transaction. |
| `trash_bin_events_list() -> jsonb` | Active admin; filters/history result is read-only. |
| `restore_trash_supplier(p_supplier_id uuid) -> uuid` | Active admin; restores/deactivates supplier state and records an event/audit. One call. |
| `restore_trash_medicine(p_medicine_id uuid) -> uuid` | Active admin; restores medicine state and records an event/audit. One call. |
| `ean13_check_digit(payload12 text) -> text` | Pure EAN-13 check-digit calculation; no auth-dependent write. |
| `assign_medicine_barcode(p_medicine_id uuid, p_barcode text, p_replace boolean) -> text` | Requires products permission; validates/generates barcode, checks collisions, updates medicine and audits. One call. |
| `assign_missing_barcodes(p_medicine_ids uuid[]) -> jsonb` | Requires products permission; assigns generated EAN-13 values to selected medicines, collision-aware, updates/audits in one call. |
| `stock_alerts_summary(p_limit integer) -> jsonb` | Active, non-deleted signed-in profile; no module permission required; counts sellable low/out stock and returns no cost/MRP/supplier/cost-derived field. Read-only. |
| `pos_catalog() -> jsonb` | Requires POS permission; active medicines and configured sale units with sellable stock; cost-free output. Read-only. |
| `pos_customers() -> jsonb` | Requires POS permission; customer options including balances/store credit; read-only. |
| `save_customer(p_name text, p_phone text, p_cnic text, p_address text, p_credit_limit_paisa integer) -> jsonb` | Requires customers permission; validates name/credit limit, creates customer and audit row. One call. |
| `record_customer_payment(p_customer_id uuid, p_amount_paisa integer, p_note text) -> jsonb` | Requires customers permission; locks customer, requires positive payment not exceeding balance, reduces balance, adds ledger/audit and returns receipt/balance. One call. |
| `customer_accounts_summary() -> jsonb` | Requires customers permission; returns customers and calculated ledger history; read-only. |
| `get_return_policy_settings() -> jsonb` | Requires POS permission; returns the single return-policy row; read-only. |
| `update_return_policy_settings(p_return_window_days integer, p_minimum_restock_shelf_life_days integer) -> jsonb` | Active Admin only; validates 0–365 day return window and 0–3650 shelf-life threshold; updates setting and audit. One call. |
| `post_sale(p_customer_id uuid, p_customer_name text, p_items jsonb, p_discount_paisa integer, p_rounding_paisa integer, p_tendered_paisa integer, p_payments jsonb) -> jsonb` | Active POS permission; validates cart, current prices, stock, tender and payment split, customer/credit, discount cap and integer bounds. Writes sale/items/FEFO allocations, batch decrements/movements, payment rows, customer credit/ledger and audit in one call. |
| `sales_history(p_limit integer) -> jsonb` | Requires sales_history; returns history with cost fields gated by `can_view_cost`; read-only. |
| `sale_for_return(p_invoice_number text) -> jsonb` | Requires POS permission; locates eligible sale and original batch allocations for return request; read-only. |
| `request_sale_return(p_sale_id uuid, p_reason text, p_items jsonb) -> jsonb` | Requires POS permission; locks sale/lines/allocations, rejects duplicate allocations and quantities exceeding sold units including pending/completed returns; creates request/items and audit. One call. |
| `pending_sale_returns() -> jsonb` | Requires Manager/Admin role and sales_history permission; returns pending queue; read-only. |
| `reject_sale_return(p_return_id uuid, p_reason text) -> jsonb` | Manager/Admin with sales_history; only pending request and nonblank decision reason; marks rejected and audits. One call. |
| `process_sale_return(p_return_id uuid, p_decisions jsonb) -> jsonb` | Manager/Admin with sales_history; every request line decided exactly once. Restock additionally requires stock_inventory and sealed/intact original package, non-controlled/non-narcotic/non-refrigerated product, in-window date, enough shelf life, original batch and whole restock package. Updates batch or creates quarantine/write-off batch, movement, refund/credit ledger, statuses and audit. One call. |

**Transaction qualification:** mutating functions listed above run as one database function statement and therefore roll back their statement effects on an uncaught error. This is the current SQL pattern, not evidence about MongoDB transactions. Cross-service Supabase Auth + Postgres Edge Function operations in `manage-users` are not one database transaction; the function uses compensating actions for some failures.

### 2.6 Migration files reviewed

There are 32 SQL files in `supabase/migrations` and one baseline file. `*_rollback.sql` files in the migrations directory are rollback scripts, not forward migrations.

| File | Main subject |
|---|---|
| `20261008220000_allow_super_admin_admin_override.sql` | Role/permission helper behavior. |
| `20261008230000_complete_purchase_workflow.sql` | Purchase schema, numbering, ledger and workflow RPCs. |
| `20261009190000_add_medicine_categories_and_brands.sql` | Categories/brands and merge/save/delete RPCs. |
| `20261009191000_add_stock_adjustment_rpc.sql` | Stock adjustment RPC. |
| `20261009192000_save_medicine_rpc.sql` | Medicine save RPC. |
| `20261009200000_create_audit_logs.sql` | Audit table/policy. |
| `20261009201000_add_pos_print_permissions.sql` | Profile permission constraint and print permission keys. |
| `20261009202000_create_print_requests.sql` | Print request table, RPCs and audit events. |
| `20261010035000_add_medicine_strength.sql` | Adds medicine strength and replaces save RPC. |
| `20261010040000_products_redesign_rpc.sql` | Cost visibility, product list/stats/import/bulk RPCs. |
| `20261010050000_master_data_overview_merge.sql` | Master-data summary and merge RPCs. |
| `20261010055000_sellable_stock_status_alignment.sql` | Product/master summary revisions for sellable stock. |
| `20261010060000_stock_inventory_functions.sql` | Stock inventory queries and movement log. |
| `20261010061000_write_off_expired_batch.sql` | Expired-batch write-off. |
| `20261010070000_purchase_cost_visibility.sql` | Replaces purchase RPCs with cost-gated versions. |
| `20261010080000_revoke_direct_table_access.sql` | Removes direct access to cost-bearing tables. |
| `20261012130000_scope_cost_visibility.sql` | Role/permission-scoped `can_view_cost`. |
| `20261012140000_lockdown_anon_public_access.sql` | Anon/table/sequence privilege revokes. |
| `20261012140500_optional_lockdown_supabase_admin_defaults.sql` | Optional default-privilege lockdown; review deployment assumptions. |
| `20261012141000_revoke_authenticated_table_dml.sql` | Revokes authenticated direct table DML. |
| `20261012142000_supplier_write_rpcs.sql` | Supplier save/deactivate RPCs. |
| `20261012143000_revoke_authenticated_supplier_dml.sql` | Supplier direct-write revoke. |
| `20261012144000_lockdown_profile_dml.sql` | Profile direct-write revoke. |
| `20261012160000_modify_print_requests.sql` | Admin print-request list and receipt-snapshot modification. |
| `20261012170000_trash_bin_history.sql` | Trash events, capture trigger and restore/list RPCs. |
| `20261012180000_assign_medicine_barcodes.sql` | EAN check digit and barcode assignment RPCs. |
| `20261012180001_assign_medicine_barcodes_rollback.sql` | Rollback script; do not apply as a forward migration. |
| `20261012181000_medicines_barcode_unique_index.sql` | Barcode unique index (legacy/global scope). |
| `20261012181001_medicines_barcode_unique_index_rollback.sql` | Rollback script; do not apply as a forward migration. |
| `20261013140000_stock_alerts_summary.sql` | Cost-free stock alert summary. |
| `20261013150000_pos_catalog.sql` | POS catalog. |
| `20261013160000_persist_sales_and_returns.sql` | Persistent sale/customer/return workflows and policy. |

The checked-in baseline is explicitly marked reconstructed, not a full production dump. It should not be treated as an authoritative live schema.

## 3. `manage-users` Edge Function

The `manage-users` function has seven actions:

| Action | Behavior |
|---|---|
| `list` | Lists non-deleted users in creation order; hides super_admin from non-super-admin callers; includes `can_manage`, user limit/count, assignable roles and grantable permissions. |
| `list_deleted` | Admin/Super Admin only; lists soft-deleted profiles; non-super-admin callers do not see super_admin profiles. |
| `reset_password` | Verifies target can be managed, requires password length >= 8, updates Supabase Auth password, writes audit. |
| `create` | Validates user identity, role, active flag and permissions; enforces MAX_USERS=99, case-insensitive username/email uniqueness, creates confirmed Auth user/profile; optionally bans inactive account; writes audit. Uses a compensating Auth-user delete if profile creation fails. |
| `update` | Validates profile and permission changes; forbids password in this action (use reset); synchronizes auth email/ban state, edits role/profile and writes audit. |
| `delete` | Soft-deletes profile, marks inactive, bans Auth account; writes Trash Bin event and audit; attempts compensation if history write fails. |
| `restore` | Admin/Super Admin only; restores soft-deleted profile, reactivates/unbans account, enforces the 99-user limit, writes Trash Bin event and audit; attempts compensation on failure. |

Shared request rules: POST only (plus CORS OPTIONS), requires a valid bearer token validated with Supabase Auth, then requires a current active/non-deleted profile. The caller must be Admin, Super Admin, or have `manage_users`. Unknown actions are rejected. Permissions are checked against the allowlist in the function; `pos_print_sale` and `pos_print_payment` are retained only when caller also has POS. Super Admin profiles are assigned the module key list by default.

`policy.ts` rules:

- Roles and hierarchy: cashier < manager/accountant < admin < super_admin. Super Admin can assign every role. Admin and Manage Users holders can assign only cashier/manager/accountant.
- Admin/Super Admin may grant all listed permissions. A non-admin Manage Users holder can grant only permissions they themselves hold and cannot grant `manage_users`.
- A caller cannot change their own role, permissions, or active state; self-deletion is denied. Super Admin may edit own non-sensitive profile details.
- Admin cannot manage Admin/Super Admin. A Manage Users permission holder can manage only lower-than-admin targets that do not themselves have Manage Users. Super Admin can manage other users, subject to self-change restrictions and last-account protection.
- Cannot delete/demote/deactivate the last active Admin. Cannot delete/demote the last Super Admin; cannot deactivate the last active Super Admin.
- User creation/deletion/restore/password/profile updates have audit writes; create/delete/restore also interact with Auth and the profile/Trash tables outside a shared DB transaction.

Current permission key discrepancy: the intended migration target includes `stock_alerts`. The checked-in UI permission key list and the profile CHECK allowlist do not include it; `stock_alerts_summary` instead permits every active signed-in profile. `manage_users` and print toggle keys are added by a later permission-constraint migration, not by the baseline definition.

## 4. Environment variables

No `.env` file was read. The following names were found by source/config/example inspection:

| Variable | Current consumer / status |
|---|---|
| `VITE_SUPABASE_URL` | Browser Supabase client (`src/utils/supabase.ts`). |
| `VITE_SUPABASE_ANON_KEY` | Browser Supabase client; public/anon client key, not the service-role key. |
| `SUPABASE_URL` | `manage-users` Edge Function server client. |
| `SUPABASE_SERVICE_ROLE_KEY` | `manage-users` server-only client; referenced in code but omitted from the root `.env.example`. Keep secret. |
| `SUPABASE_ANON_KEY` | Present in `.env.example`; no direct code read was found. |
| `DISABLE_HMR` | Vite config controls HMR/watch behavior. |
| `GEMINI_API_KEY` | Documented in `.env.example` for the AI Studio/Gemini runtime; no direct source read found in the searched app code. |
| `APP_URL` | Documented in `.env.example` for the hosted app runtime; no direct source read found in the searched app code. |
| `DEMO_MODE` | Documented in `.env.example`; the example notes the frontend does not read it. |

No Node API/server environment variables exist in the current checkout because there is no `server/` API implementation yet. Future Mongo/API/Docker environment names are a design task, not current variables.

## 5. Feature rebuild matrix

Size estimates are for backend/API replacement while preserving current UX; risk reflects data integrity, authorization, concurrency, or cost exposure.

| Feature | Current source state | Size | Risk |
|---|---|---:|---|
| Auth/session/roles/permissions | Supabase Auth plus local permission UI; Edge Function for user administration. | L | Critical |
| User administration | `manage-users` actions and policy above; multi-service compensation, not transactional. | L | Critical |
| Categories/brands/master data | Mixed RPC and direct table reads; merges and product cross-links. | M | High |
| Product CRUD, units, import/export, barcodes | RPC-backed list/save/import/bulk paths, direct lookup reads, legacy global barcode uniqueness. | L | High |
| Stock inventory, FEFO, adjustments, write-off, alerts | RPC-backed inventory reads/mutations; sellable-stock and cost filtering. | L | Critical |
| Suppliers | Direct table read plus write RPCs; deactivation/trash events. | M | High |
| Purchasing/history/void/supplier ledger | Atomic SQL RPCs with supplier and inventory side effects; cost-restricted views. | L | Critical |
| POS catalog/sale/discount/payments | Persistent `post_sale` transaction, FEFO allocation, payment split, customer credit; sale-number strategy differs from target. | L | Critical |
| Customers/ledger/payments | Customer and ledger RPCs; some legacy views may still be local/demo. | L | High |
| Returns and sale void | Return request/review/processing SQL exists; sale-void endpoint was not found in reviewed migrations; cash refund/cashbook integration needs confirmation. | L | Critical |
| Print request/approval/memo | Server-side request/approval/snapshot edits plus existing client-side receipt renderer/settings. | M | High |
| Product labels/scanning | Barcode helpers and print UI; physical hardware and QR behavior are not established. | M | Medium |
| Dashboard/reports/expenses/cash book | Dashboard has sample stock data; Cash Book/expenses are in-memory; reports do not yet reconcile persisted returns fully. | L | High |
| Shop identity/settings/preferences | Some print settings/preferences are browser-local; shop identity is not consistently server-backed. | M | High |
| Audit/trash history | SQL audit functions/tables and Edge Function profile history; needs append-only API boundary and full event coverage. | M | High |
| Docker/API/backup/restore | No API, Mongo, compose topology, scheduled backup, or tested restore exists yet. | L | Critical |
| UI/theme/accessibility/animations | Existing React screens/theme are to be retained; replace the data/auth boundary without redesign. | M | Medium |
| Data migration/seed/test coverage | No Mongo import/cutover plan or Mongo end-to-end suite exists. | L | Critical |

Known current gaps relevant to feature parity: prescription proof is not enforced by `post_sale` even though medicine has `requires_prescription`; no persisted Cash Book/expense flow; sale void RPC absent in reviewed migrations; cashier cost safety depends on all later table-revocation and cost-gated RPC migrations being deployed; and several dashboards/reports still use sample or incomplete return data.

## 6. SQL business rules to preserve

- **Money and quantities:** persisted amounts are integer paisa; stock and sold/returned quantities are integer base units. Some current SQL totals are limited to signed 32-bit integer despite intermediate `bigint` arithmetic; Mongo design must use BSON Int64 for larger totals. `discount_percent` is numeric.
- **Sellable stock:** only active medicines with batch `quantity_remaining > 0`, `expiry_date >= current_date`, and status `ACTIVE` or `NEAR_EXPIRY`. FEFO order is expiry date, received date, then stable ID; allocation refuses an insufficient cart rather than partially completing a sale.
- **Stock integrity/status:** stock cannot be negative; states include ACTIVE, NEAR_EXPIRY, EXPIRED, QUARANTINE, DAMAGED, RETURNED, RECALLED, SOLD_OUT. Expiry is on batches. Purchase batches require expiry after the purchase date.
- **Discounts:** `post_sale` caps percentage by role: Cashier 10%, Manager 15%, Admin 30%, Super Admin 30%, Accountant 0%. Effective discount is the lowest of the role percentage, subtotal, and Rs 200 (`20,000` paisa); calculation floors the percentage cap. Client-submitted totals/prices are not authoritative. Source does not evidence a general manager's configurable discount cap.
- **Purchase discount:** nonnegative and no greater than purchase subtotal. Purchase permission and cost visibility are required.
- **Sale/payment:** sale must have 1–100 items and 1–4 distinct payment methods; server recomputes prices/totals. Credit must be the sole payment method and needs a customer. Cash tender must cover total; online/split tender must equal total. Payment types in SQL are CASH, CARD, EASYPAISA, JAZZCASH, CREDIT.
- **Numbering:** sales currently use `INV-` + UUID without dashes (unique, not sequential). Purchases use `PR-` plus a zero-padded global singleton counter, incremented atomically in the purchase transaction; unique globally, not per shop. Neither meets the new per-shop counter design as-is. Purchase/customer receipt references also include generated UUID fragments.
- **Returns:** default window 7 days (configurable 0–365) and default minimum shelf life for restock 90 days (configurable 0–3650). Only sealed/intact packs may be restocked; controlled/narcotic and cold-refrigerated medicines cannot be restocked; original batch must be eligible and remaining expiry must meet threshold; returned quantity must form whole configured sale packages. Return request requires POS; Manager/Admin with sales_history processes; restock also requires stock_inventory. Requests reserve units; cumulative completed plus pending return units cannot exceed sold quantities. Refund allocation uses original line total with integer floor-difference allocation. Credit-sale returns update customer balance/store credit; non-credit refunds are marked CASH, but persisted cash payout/cash-book reconciliation was not established.
- **Cost visibility:** Admin/Super Admin; Manager only with products/stock_inventory/purchases/purchase_history; Accountant only with purchase_history/reports; Cashier never. Product/stock/purchase RPCs condition cost/margin fields on this server helper. Customer-facing receipt/label output must not include cost, profit or margin. Direct `stock_batches` policy includes POS, so table-revoke status is a critical dependency, not a substitute for role-whitelisted API DTOs.
- **Manage Users:** Admin may manage only lower roles; Super Admin alone creates/edits/deletes Admins and Super Admins; callers cannot change own role/permissions/active status; protect the last active Admin and last Super Admin; user cap is 99 in current Edge Function.
- **Audit and history:** sale, purchase, supplier/product/category changes, discounts, returns, print decisions, write-offs, user mutations and restores have SQL/Edge audit writes in varying paths. They are not uniformly append-only through all direct table policies yet; new API must make audit append-only.
- **Prescription proof:** `requires_prescription` exists, but the reviewed sale RPC does not require prescriber/patient/reference fields; this is a gap to close in the replacement, not an existing enforced SQL rule.
- **Multi-shop:** current schema uniqueness/numbering and queries are single-shop. New API must derive `shopId` from the authenticated user, filter every business query, and scope unique medicine/barcode/name/numbering indexes by shop.

## 7. Proposed MongoDB collections and indexes

Design proposal only; no collection has been created. Every business document carries server-populated `shopId`. Reads and writes obtain it from authenticated user state, never a request body. Embed data where it is an immutable bounded transaction snapshot; reference mutable/high-volume ledgers and inventory.

| Collection | Embed/reference choice | Required indexes (all shop-scoped where applicable) |
|---|---|---|
| `shops` | Shop identity/settings in one bounded document; settings stay server-backed. | Unique `slug`; unique `_id`. |
| `users` | One user belongs to one `shopId`; include password hash, role, permissions, active/lockout fields. | Unique `{shopId, usernameNormalized}` and `{shopId, emailNormalized}`; `{shopId, role, isActive}`. |
| `refreshSessions` | Separate revocable records; store only token hash and rotation family metadata. | Unique `tokenHash`; `{userId, revokedAt, expiresAt}`; TTL on `expiresAt` only if expiry handling remains explicitly validated. |
| `counters` | One counter per shop and numbering kind; atomic `findOneAndUpdate` inside the write transaction. | Unique `{shopId, kind}`. |
| `categories`, `brands`, `suppliers` | Separate reusable catalog records. | Unique `{shopId, normalizedName}`; active/name search indexes. |
| `medicines` | Embed bounded `units` and stable product properties; keep stock batches separate because they mutate/scale independently. | Unique `{shopId, normalizedCode}`; `{shopId, isActive, normalizedName}`; query/search indexes for barcode/name/category/class. |
| `barcodeClaims` | Separate registry so medicine and unit barcodes share one unique namespace and assignments are race-safe. | Unique `{shopId, normalizedBarcode}`; `{shopId, ownerType, ownerId}`. |
| `stockBatches` | One batch per document for conditional quantity updates and FEFO queries. | `{shopId, medicineId, status, expiryDate, receivedDate, _id}`; `{shopId, expiryDate, status}`; batch identifiers scoped by shop if policy requires uniqueness. |
| `stockMovements` | Append-only events reference batch and source transaction; do not embed unbounded history. | `{shopId, batchId, createdAt}`; `{shopId, referenceType, referenceId}`. |
| `purchases` | Embed bounded item snapshots and received batch IDs; keep supplier ledger separately append-only. | Unique `{shopId, purchaseNumber}`; `{shopId, purchaseDate, createdAt}`; `{shopId, supplierId, purchaseDate}`. |
| `supplierLedger` | Append-only supplier balance movements reference purchase/void. | `{shopId, supplierId, createdAt}`; `{shopId, purchaseId}`. |
| `sales` | Embed immutable item/name/price/discount snapshots, FEFO batch allocations and payment rows; bounded by the sale item/payment limits. | Unique `{shopId, invoiceNumber}`; `{shopId, soldAt}`; `{shopId, customerId, soldAt}`. |
| `saleReturns` | Embed request/decision lines and disposition, reference original sale and batch IDs; bounded per sale. | `{shopId, saleId, status, requestedAt}`; `{shopId, status, requestedAt}`. |
| `customers` | Customer profile and current integer balances; ledger entries remain separate append-only records. | `{shopId, normalizedName}` (unique only if owner confirms); `{shopId, phone}`. |
| `customerLedger` | Append-only sale/payment/return entries with running balance derived/updated transactionally. | `{shopId, customerId, createdAt, _id}`; `{shopId, referenceType, referenceId}`. |
| `expenses`, `cashBookEntries` | Separate persisted money events, not an in-memory projection; return payouts reference return. | `{shopId, occurredAt}`; `{shopId, type, occurredAt}`; `{shopId, referenceType, referenceId}`. |
| `printRequests` | Embed sanitized receipt snapshot, never cost/profit/margin; separate lifecycle/status record. | `{shopId, status, createdAt}`; `{shopId, requesterId, createdAt}`. |
| `auditLogs`, `trashEvents` | Append-only documents; no update/delete application route. | `{shopId, createdAt, _id}`; `{shopId, actorId, createdAt}`; entity/time index for trash events. |
| `returnPolicySettings` | One settings document per shop. | Unique `{shopId}`. |

All paisa fields are integer BSON numeric values; use BSON Int64 (`Long`) for aggregate totals/counters that may exceed signed 32-bit bounds. Quantities remain integer base units. Transaction writes should cover sale + batch decrements + movement + payments + customer ledger + counter + audit; equivalent single transactions are required for return, purchase/void, stock adjustment/write-off, and customer payment. Build role-specific response DTOs from explicit allowlists; never serialize collection documents directly.

## 8. Open questions

1. Is the first Mongo deployment a clean start, or must existing Supabase users, products, batches, balances and history be migrated? If data migration is required, what is the approved reconciliation/cutover window?
2. Confirm the already-recorded multi-shop decision still applies: one user belongs to one shop; Super Admin has no general cross-shop business-data access, with only explicitly audited provisioning/seeding actions.
3. Which exact allowed permissions should be assigned by default to each role in Mongo? Current UI defaults differ from the required `stock_alerts` key, and current SQL/profile allowlists have evolved across migrations.
4. Should product/supplier/category normalized names be strictly unique per shop, or should duplicate names be allowed with code/barcode as the unique identity? Current schema does not consistently enforce name uniqueness.
5. Which return outcomes should be allowed outside the return window: quarantine/write-off only, or reject the request outright? Current SQL restricts window for restock but allows non-restock dispositions.
6. What prescription evidence fields and retention rules are required for RX/CONTROLLED/NARCOTIC sales? The current SQL does not enforce the requirement.
7. How should non-credit cash return payouts enter the new cash book, given the current SQL records the refund but no verified cash payout reconciliation?
8. Should existing local receipt/template preferences be migrated to each shop's server settings, or copied once as a one-time shop setup?
9. What backup retention duration and encryption/key-management mechanism should be used? “Encrypted if possible” needs a deployable key storage/rotation decision.
10. Which hostname/domain and email/contact address should production HTTPS certificate issuance use? Do not put secrets or private values in checked-in configuration.

## Phase 0 verification boundary

- Read-only source inspection only; no SQL execution, live database access, API calls, or `.env` reads.
- No Mongo collections, API routes, Docker services, or frontend changes were implemented.
- Exact runtime RLS/grants, migration application state, live data shape, and Edge Function deployment state remain unverified.
