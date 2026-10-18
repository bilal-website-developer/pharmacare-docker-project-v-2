# Pharma Care Manual Acceptance Plan

This checklist is for an isolated, disposable demo shop only. Do not use live or
real customer/patient data. Seed records are fictional and prefixed `DEMO -`.
The seed command intentionally refuses production mode and any database name
that does not end in `demo`. Never enable demo seeding against a shop's real
database.

## Test setup

1. Create an isolated Mongo/Compose project and database whose name ends in
   `_demo` or `-demo`. Configure its own app user, credentials, and shop; do not
   reuse production data or a production `.env`.
2. Start the stack and confirm the web, API, Mongo health and `mongo-init`
   status using the local instructions in `docs/DOCKER.md`.
3. Create the first Super Admin with `npm.cmd run seed:superadmin` or the
   approved first-run setup flow. Do not put credentials in screenshots or
   test notes.
4. In this isolated development setup only, set `DEMO_MODE=true` and
   `NODE_ENV=development`, build the server image and run
   `npm.cmd run seed:demo`. Confirm the output reports synthetic record counts;
   rerun once and confirm it reports no second insertion. The fixtures contain
   no stock batches: use the purchase workflow below to create saleable stock.
5. Use `VITE_BACKEND=api` for Mongo acceptance. Repeat a representative smoke
   test with `VITE_BACKEND=supabase` only in a separately configured legacy
   test environment. Do not change production configuration to perform tests.
6. For each role, sign out and sign in as a separate account. Prepare accounts
   with the role/permission settings in the matrix below. Use only fake names,
   identifiers, and contact details. Record pass/fail, date, app build, role,
   shop timezone, and sanitized screenshots; redact all tokens and personal
   data.

## Permission matrix

Check both visible navigation/actions and the actual API result. UI hiding is
not server authorization. Where the UI permits customization, exercise both a
granted and a revoked permission.

| Role | Positive checks | Denial checks |
|---|---|---|
| Cashier | POS and customer lookup; own sales/history; own print requests; permitted sale/payment print toggles | Products/cost, purchases, stock adjustment, expenses, reports, user administration, settings, trash, other users' print requests |
| Manager | POS, products, categories, suppliers, customers, sales and purchase history, purchases, stock inventory, reports when granted | Manage Users, admin settings/trash, admin print-request decisions, permissions not granted; cost only when a cost-authorizing module permission is granted |
| Accountant | Customers, suppliers, sales/purchase history, expenses, reports when granted | POS, stock mutation, product cost unless specifically permitted by policy, Manage Users, admin settings/trash |
| Admin | Full regular module access, user management within policy, print-request administration, settings and trash | Create/edit/delete admins; change own role; remove the last admin/Super Admin; any action explicitly reserved for Super Admin |
| Super Admin | All modules, bootstrap/role governance, shop identity and settings | Change own role; remove the last admin/Super Admin; cross-shop access |

For every denial, confirm the UI does not complete the operation, the API
returns a generic authorization response, and no sensitive document or stack
trace is returned.

## Feature walkthrough

### Session, navigation, and preferences

1. Sign in with a valid test account; reload the page and confirm the session
   restores through the httpOnly refresh cookie. Confirm no access or refresh
   token appears in local storage, browser storage, URLs, or console output.
2. Sign out and confirm protected pages and API calls require authentication.
   Exercise an expired access token and confirm one refresh retry, then a
   visible sign-in/error state if refresh is revoked.
3. Check role-based navigation, mint theme / Light Mint / Emerald Night,
   Normal/Large UI, and the animations toggle. Reload and confirm preference
   behavior is unchanged.
4. Revoke an API permission while signed in; confirm the next protected API
   request is denied rather than trusting stale client state.

### Products, master data, labels, and stock

1. As a manager/admin, browse Products and Stock Inventory; create and edit a
   fictional category, brand, medicine, and sale unit. Check validation,
   barcode uniqueness per shop, archive/trash behavior, and restore behavior.
2. Create two medicine batches with different expiry dates by receiving stock
   in Purchases. Confirm inventory totals, low/out-of-stock and expiry buckets
   update from live data after reload.
3. Attempt to sell an expired, inactive, quarantined, or zero-quantity batch;
   confirm the server rejects it. For eligible batches, confirm sales allocate
   FEFO (earliest eligible expiry first).
4. Adjust stock and record a write-off using the required reason/approval.
   Reload inventory and inspect the stock movement history.
5. Generate barcode labels with a name containing HTML-special characters.
   Preview/print and confirm the text is displayed literally, not interpreted
   as markup. Confirm cashier label output contains no cost/margin fields.
6. Try a cross-shop medicine/batch identifier in a permitted request; confirm
   the API returns no other shop's record.

### Suppliers, purchases, and purchase history

1. Create/edit a fictional supplier and confirm it appears in selectors and
   purchase history.
2. Purchase DEMO OTC and prescription products. Use integer-paisa prices,
   quantities in integer base units, multiple items, and a split cash/credit
   payment where supported. Confirm persisted totals and supplier payable
   balance reconcile after reload.
3. Confirm the created batches are active, have the entered expiry dates, and
   feed the live stock KPIs. Attempt invalid fractional base-unit quantities.
4. Void a permitted purchase and confirm the transaction reverses inventory
   and supplier balance atomically; repeat the void to verify it is blocked or
   handled idempotently without double reversal.
5. Check purchase history filters/details by date, supplier, status, and
   reference. Verify cashier API responses and exports never contain cost.

### POS, customers, sales history, returns, and voids

1. As cashier, sell an eligible DEMO OTC item. Scan/search by barcode, select
   units, and complete a cash sale. Confirm stock decreases and the receipt
   shows correct item, quantity, integer-paisa-derived totals, shop timezone
   date, and no cost/profit/margin.
2. Apply permitted discounts at 0%, the role cap, and the hard Rs 200 bill
   cap. Attempt values above each cap and confirm server rejection. Test a
   split payment and customer-credit payment; reconcile each payment method.
3. Add a controlled-drug example to cart and confirm required prescription
   evidence/approval is enforced. Confirm rejected/abandoned sales leave no
   partial stock or ledger writes.
4. Create a fictional customer, make a credit sale and a customer payment, and
   inspect Customer Ledger and payment slip. Confirm balance and store credit
   reconcile after reload.
5. As each role, open Sales History and inspect role-appropriate fields,
   filters, pagination, cashier scoping, receipt, and status. Confirm voided
   sales remain visibly void but are excluded from net revenue.
6. Submit a return request within sold quantity; approve and process it using
   each supported disposition: restock, quarantine, and write-off. Confirm the
   return memo and audit event. Attempt quantity greater than sold, repeat
   processing, and process before approval; confirm all are denied without
   duplicate payout or stock movement.
7. Void an eligible sale and confirm sale state, inventory, customer ledger,
   cash book, and net sales reconcile. Attempt a second void and confirm it
   cannot reverse twice.
8. Print the sale, payment, and return memo using item names containing
   `<`, `>`, quotes, and ampersands. Confirm all dynamic content is escaped.

### Print Requests

1. As cashier, request a sale/payment print, open My Print Requests, and verify
   pending count and status.
2. As an authorized admin, list requests, approve one and reject another with
   a note. Print an approved memo, mark printed, and print it again; confirm
   status and audit data remain consistent.
3. Modify an allowed pending receipt snapshot. Confirm the original sale and
   financial records remain unchanged. Confirm non-admin roles cannot approve,
   modify, or inspect another user's request.

### Expenses, cash book, reports, and dashboard

1. As an accountant/admin with permission, create an expense such as Rs 12.50
   and confirm it persists exactly once after reload.
2. Compare the cash book for a known date against completed sale receipts,
   customer cash payments, return payouts, and expenses. Confirm inflow,
   outflow, and expected drawer reconcile; inspect non-cash methods separately.
3. Confirm reports and dashboard use persisted transactions, subtract processed
   returns from net sales, exclude voided transactions from sales, and update
   stock KPIs from current inventory. Change date range and shop timezone
   around midnight; verify all stock/expiry/sales date boundaries agree.
4. Confirm cashiers cannot access expense, cash book, report, profit, cost, or
   margin values through pages, API responses, exports, labels, receipts, or
   error messages.

### Manage Users, shop settings, audit, and Trash Bin

1. As an authorized manager/admin, list users, create a cashier, assign only
   allowed permissions, edit profile, reset password, and deactivate/delete
   according to policy. Test wrong current password and valid password change.
2. Confirm nobody can edit their own role; only Super Admin can create/edit/
   delete Admins; last Admin/Super Admin protection is enforced. Confirm
   attempts to cross shops fail.
3. As Super Admin, change permitted shop identity and server-stored memo
   settings; reload another session and confirm settings are shared by the
   shop, not browser-local. As non-Super Admin, attempt shop identity changes
   and confirm denial.
4. Inspect audit history for login/logout, user and permission changes, sale,
   void, return, discount, stock adjustment/write-off, purchase, price change,
   print approval, and settings changes. Confirm ordinary roles cannot modify
   or delete audit rows.
5. Archive a disposable demo record, inspect Trash Bin, restore it, and confirm
   it returns to its original module. Check permission denial for unauthorized
   roles.

## Completion record

Do not mark a case passed until a human has run it against the intended browser
and isolated environment. Record results in the release/acceptance record,
not by editing this checklist to imply execution.

| Run date / build | Role | Case IDs | Pass / fail / blocked | Tester and sanitized evidence |
|---|---|---|---|---|
| Pending owner acceptance | — | All | Not run | No manual browser acceptance has been recorded |
