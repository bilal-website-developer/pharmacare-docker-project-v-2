# Pharma Care MongoDB and API Design

**Phase:** 1 — design only  
**Status:** Proposed contract for owner review; no API, collection, index, or database has been implemented.  
**Basis:** [Phase 0 inventory](./MONGO_MIGRATION_INVENTORY.md), the current role and permission decisions in [Project Context](./PROJECT_CONTEXT.md), and the approved one-user/one-shop model. The existing Supabase behavior is not proof of deployed behavior.

## 1. Design invariants

- Browser requests go only to the typed API client. Browser code never connects to MongoDB.
- Fastify authenticates first, derives `userId`, `shopId`, role, and permissions from the verified server-side user record, then authorizes the route. Ignore or reject client-supplied `shopId`; every business read/write filters by authenticated `shopId`.
- Every route validates path, query, headers, and body with Zod. Deny by default. Errors are generic and contain no stack, database document, cost data, token, or secret.
- MongoDB is a replica set with authentication, on the private Docker network, and has no published host port. Multi-document writes use sessions/transactions.
- All monetary fields ending in `Paisa` are integer BSON `Long` (Int64); do not use floating point for money. Quantities and conversion factors are positive/nonnegative integer base units. Rates such as percentage are integer basis points where feasible; never use binary floating-point arithmetic for monetary calculations.
- Discount calculation uses integer arithmetic: `min(floor(subtotalPaisa * roleCapBasisPoints / 10000), 20000, subtotalPaisa)`. Sale has 1–100 items and 1–4 distinct payment methods; credit is the sole payment method and requires a customer; cash tender covers the total and non-cash/split tender equals it.
- Every outward response is a purpose-built DTO allowlist. Never serialize a Mongo document. Cashier DTOs and all customer-facing receipt/label/QR/print/error output exclude cost, purchase price, profit, and margin, including nested or export fields.
- Business events and audit records are append-only through the API. No application route updates or deletes audit/ledger/movement history.
- Writes accept an `Idempotency-Key` (UUID) and persist a scoped request fingerprint/result within the write transaction. Reusing a key with different input returns a generic conflict; retries with the same key return the original safe DTO.
- Transactions use snapshot reads and majority write concern. On transient transaction errors retry the whole callback with the same idempotency key; never retry only part of a workflow. Do not send email, print, or call external services inside a transaction.

### BSON type conventions

`ObjectId` = BSON ObjectId; `Long` = signed BSON Int64 integer; `Int32` = bounded integer; `String` = normalized/validated UTF-8 text; `Boolean` = boolean; `Date` = UTC BSON date; `Decimal128` is not used for money or quantities. IDs referenced across collections are ObjectIds. Timestamps are UTC. `shopId` is always server-populated on shop-owned documents. Perform monetary arithmetic with JavaScript `bigint`, converting to/from BSON `Long` only at the database boundary. Serialize paisa and any potentially unsafe Int64 quantity/totals to JSON as base-10 integer strings (no decimal point); bounded quantities may be JSON integers only when validated as safe integers. Never coerce an Int64 through JavaScript `number`.

## 2. Collection schemas

Fields listed below are the persisted application schema; `_id: ObjectId` is implicit on every collection. Required fields are marked **required**. Optional/nullable fields are explicitly identified. All fields are validated at the API boundary and, where supported, by MongoDB collection validators. Embedded arrays have bounded sizes.

| Collection | Fields and types |
|---|---|
| `shops` | `_id: ObjectId` is the tenant's `shopId`; `slug: String` required; `name: String` required; `status: "ACTIVE" \| "SUSPENDED"`; `profile: { displayName: String, address: String, phone: String, licenceNumber?: String }`; `receiptSettings: { paper: "58mm" \| "80mm" \| "A4", templateId: String, showLogo: Boolean }`; `createdAt: Date`; `updatedAt: Date`. This is the tenant root and does not contain credentials. |
| `users` | `shopId: ObjectId` required; `username: String`; `usernameNormalized: String`; `email: String`; `emailNormalized: String`; `displayName: String`; `passwordHash: String` (argon2id); `role: "cashier" \| "manager" \| "accountant" \| "admin" \| "super_admin"`; `permissions: String[]`; `isActive: Boolean`; `deletedAt?: Date`; `failedLoginCount: Int32`; `lockedUntil?: Date`; `passwordChangedAt: Date`; `createdAt: Date`; `updatedAt: Date`; `createdBy: ObjectId`; `updatedBy: ObjectId`. Never return password hashes or lockout secrets. One user belongs to exactly one shop; Super Admin does not receive ordinary cross-shop business access. |
| `refreshSessions` | `shopId: ObjectId`; `userId: ObjectId`; `tokenHash: String` (hash of opaque random refresh token); `familyId: ObjectId`; `issuedAt: Date`; `expiresAt: Date`; `rotatedAt?: Date`; `replacedBySessionId?: ObjectId`; `revokedAt?: Date`; `revocationReason?: String`; `createdAt: Date`. Store no raw refresh token. Access tokens are short-lived and not persisted here. |
| `counters` | `shopId: ObjectId`; `kind: "SALE" \| "PURCHASE" \| "PAYMENT" \| "RETURN"`; `lastValue: Long`; `updatedAt: Date`. One document per shop and numbering kind. |
| `categories` | `shopId: ObjectId`; `name: String`; `normalizedName: String`; `isActive: Boolean`; `createdAt: Date`; `updatedAt: Date`; `createdBy: ObjectId`; `updatedBy: ObjectId`. |
| `brands` | Same shape as `categories`; `shopId` required. |
| `suppliers` | `shopId: ObjectId`; `name: String`; `normalizedName: String`; `contact: String`; `address: String`; `licenceOrTaxNumber?: String`; `paymentTerms?: String`; `isActive: Boolean`; `payableBalancePaisa: Long`; `createdAt: Date`; `updatedAt: Date`; `createdBy: ObjectId`; `updatedBy: ObjectId`. |
| `medicines` | `shopId: ObjectId`; `code: String`; `normalizedCode: String`; `name: String`; `normalizedName: String`; `genericName?: String`; `categoryId?: ObjectId`; `brandId?: ObjectId`; `manufacturer?: String`; `strength?: String`; `drugClass: "OTC" \| "RX" \| "CONTROLLED" \| "NARCOTIC"`; `requiresPrescription: Boolean`; `storageCondition: "ROOM_TEMPERATURE" \| "COOL" \| "COLD_REFRIGERATED"`; `minStockAlert: Int32`; `isActive: Boolean`; `units: Unit[]` (bounded, max 100); `createdAt: Date`; `updatedAt: Date`; `createdBy: ObjectId`; `updatedBy: ObjectId`. `Unit = { unitId: ObjectId, name: String, conversionFactorBaseUnits: Int32, salePricePaisa: Long, barcode?: String, normalizedBarcode?: String }`. Unit setup is embedded because it is bounded and is read/updated with the product; batches and movements are separate because they change independently and grow without bound. |
| `barcodeClaims` | `shopId: ObjectId`; `normalizedBarcode: String`; `barcode: String`; `ownerType: "MEDICINE" \| "UNIT"`; `ownerId: ObjectId`; `unitId?: ObjectId`; `createdAt: Date`; `createdBy: ObjectId`. Registry enforces one barcode namespace across medicine and unit barcodes per shop. |
| `stockBatches` | `shopId: ObjectId`; `medicineId: ObjectId`; `purchaseId: ObjectId`; `purchaseItemId: ObjectId`; `batchNumber?: String`; `expiryDate: Date`; `receivedDate: Date`; `quantityReceivedBaseUnits: Long`; `quantityReturnedBaseUnits: Long`; `quantityRemainingBaseUnits: Long`; `unitCostPaisaPerBaseUnit: Long`; `mrpPaisaPerBaseUnit: Long`; `status: "ACTIVE" \| "NEAR_EXPIRY" \| "EXPIRED" \| "QUARANTINE" \| "DAMAGED" \| "RETURNED" \| "RECALLED" \| "SOLD_OUT"`; `createdAt: Date`; `updatedAt: Date`. Enforce nonnegative quantities and `remaining <= received + returned`; computed status is updated transactionally. |
| `stockMovements` | `shopId: ObjectId`; `batchId: ObjectId`; `medicineId: ObjectId`; `movementType: "RECEIPT" \| "SALE" \| "SALE_RETURN" \| "ADJUSTMENT" \| "WRITE_OFF" \| "PURCHASE_RETURN"`; `quantityDeltaBaseUnits: Long` (nonzero signed integer); `referenceType: String`; `referenceId: ObjectId`; `reason?: String`; `actorId: ObjectId`; `createdAt: Date`. Append-only; the transaction writes the movement with the quantity change. |
| `purchases` | `shopId: ObjectId`; `purchaseNumber: String`; `supplierId: ObjectId`; `supplierNameSnapshot: String`; `invoiceNumber?: String`; `purchaseDate: Date`; `status: "POSTED" \| "VOID"`; `items: PurchaseItem[]` (max 200); `subtotalPaisa: Long`; `discountPaisa: Long`; `totalPaisa: Long`; `paidPaisa: Long`; `paymentType: "CASH" \| "CREDIT"`; `notes?: String`; `voidReason?: String`; `createdAt: Date`; `createdBy: ObjectId`; `voidedAt?: Date`; `voidedBy?: ObjectId`. `PurchaseItem = { purchaseItemId: ObjectId, medicineId: ObjectId, medicineNameSnapshot: String, unitId: ObjectId, unitNameSnapshot: String, conversionFactorBaseUnits: Int32, quantityInUnits: Int32, bonusQuantityBaseUnits: Long, quantityReceivedBaseUnits: Long, unitCostPaisa: Long, mrpPaisa: Long, batchId: ObjectId, expiryDate: Date }`. Embed bounded immutable item snapshots; referenced stock and supplier ledger remain separate. |
| `supplierLedger` | `shopId: ObjectId`; `supplierId: ObjectId`; `referenceType: "PURCHASE" \| "PURCHASE_VOID" \| "PAYMENT" \| "ADJUSTMENT"`; `referenceId: ObjectId`; `debitPaisa: Long`; `creditPaisa: Long`; `balanceAfterPaisa: Long`; `actorId: ObjectId`; `createdAt: Date`; `note?: String`. Append-only, inserted with balance changes in the same transaction. |
| `sales` | `shopId: ObjectId`; `invoiceNumber: String`; `customerId?: ObjectId`; `customerNameSnapshot?: String`; `status: "COMPLETED" \| "VOIDED" \| "PARTIALLY_RETURNED" \| "RETURNED"`; `items: SaleItem[]` (1–100); `payments: Payment[]` (1–4 distinct methods); `subtotalPaisa: Long`; `discountPaisa: Long`; `roundingPaisa: Long`; `totalPaisa: Long`; `tenderedPaisa: Long`; `changePaisa: Long`; `soldAt: Date`; `createdBy: ObjectId`; `voidReason?: String`; `voidedAt?: Date`; `voidedBy?: ObjectId`; `idempotencyKey: String`. `SaleItem = { saleItemId: ObjectId, medicineId: ObjectId, medicineNameSnapshot: String, codeSnapshot: String, unitId: ObjectId, unitNameSnapshot: String, conversionFactorBaseUnits: Int32, quantityInUnits: Int32, quantityBaseUnits: Long, unitPricePaisa: Long, unitCostPaisaPerBaseUnit: Long (internal only), discountPercentBasisPoints: Int32, discountPaisa: Long, lineTotalPaisa: Long, allocations: { batchId: ObjectId, quantityBaseUnits: Long }[], prescriptionEvidence?: { reference: String, prescriber?: String, patient?: String, recordedAt: Date } }`. `Payment = { paymentId: ObjectId, method: "CASH" \| "CARD" \| "EASYPAISA" \| "JAZZCASH" \| "CREDIT", amountPaisa: Long, reference?: String }`. Immutable sold-price/quantity/cost snapshots and bounded allocations live with the sale; cost is internal only and excluded from receipt/customer DTOs. |
| `saleReturns` | `shopId: ObjectId`; `saleId: ObjectId`; `returnNumber: String`; `status: "PENDING" \| "COMPLETED" \| "REJECTED"`; `reason: String`; `requestedBy: ObjectId`; `requestedAt: Date`; `items: ReturnItem[]` (max 100); `refundTotalPaisa: Long`; `refundMethod?: "CASH" \| "CREDIT"`; `decisionReason?: String`; `decidedBy?: ObjectId`; `decidedAt?: Date`; `idempotencyKey: String`. `ReturnItem = { saleItemId: ObjectId, batchId: ObjectId, quantityBaseUnits: Long, disposition?: "RESTOCK" \| "QUARANTINE" \| "WRITE_OFF", sealedAndIntact?: Boolean, refundPaisa: Long }`. A bounded return operation references its sale/batches and records review state in this separate lifecycle document. |
| `customers` | `shopId: ObjectId`; `name: String`; `normalizedName: String`; `phone?: String`; `cnic?: String`; `address?: String`; `creditLimitPaisa: Long`; `currentBalancePaisa: Long`; `storeCreditPaisa: Long`; `createdAt: Date`; `updatedAt: Date`; `createdBy: ObjectId`; `updatedBy: ObjectId`. Balances are cached projections reconciled against ledger entries in each transaction. |
| `customerLedger` | `shopId: ObjectId`; `customerId: ObjectId`; `entryType: "SALE" \| "PAYMENT" \| "RETURN" \| "ADJUSTMENT"`; `referenceType: String`; `referenceId: ObjectId`; `debitPaisa: Long`; `creditPaisa: Long`; `balanceAfterPaisa: Long`; `actorId: ObjectId`; `createdAt: Date`; `note?: String`. Append-only and transactionally coupled to customer balance changes. |
| `expenses` | `shopId: ObjectId`; `category: String`; `description: String`; `amountPaisa: Long`; `occurredAt: Date`; `paymentMethod: "CASH" \| "CARD" \| "EASYPAISA" \| "JAZZCASH"`; `createdBy: ObjectId`; `createdAt: Date`; `updatedAt: Date`; `voidedAt?: Date`; `voidedBy?: ObjectId`; `voidReason?: String`. No hard delete; edits/voids are audited. |
| `cashBookEntries` | `shopId: ObjectId`; `entryType: "SALE" \| "CUSTOMER_PAYMENT" \| "PURCHASE_PAYMENT" \| "EXPENSE" \| "RETURN_PAYOUT" \| "ADJUSTMENT"`; `direction: "IN" \| "OUT"`; `amountPaisa: Long`; `referenceType: String`; `referenceId: ObjectId`; `paymentMethod: String`; `actorId: ObjectId`; `createdAt: Date`; `note?: String`. Append-only accounting events, written with the corresponding internal ledger operation. External payout settlement is separately recorded; a Mongo transaction cannot atomically transfer external funds. |
| `returnPolicySettings` | `shopId: ObjectId`; `returnWindowDays: Int32` (0–365; default 7); `minimumRestockShelfLifeDays: Int32` (0–3650; default 90); `updatedAt: Date`; `updatedBy: ObjectId`. |
| `printRequests` | `shopId: ObjectId`; `type: "SALE" \| "PAYMENT"`; `referenceId: ObjectId`; `receiptSnapshot: CustomerSafeReceiptSnapshot`; `requesterId: ObjectId`; `status: "PENDING" \| "APPROVED" \| "REJECTED" \| "PRINTED"`; `decisionNote?: String`; `decidedBy?: ObjectId`; `decidedAt?: Date`; `createdAt: Date`; `printedAt?: Date`. Snapshot schema is allowlisted and cannot store cost/profit/margin. |
| `auditLogs` | `shopId?: ObjectId` (required for all shop business events; absent only for a pre-authentication event where no shop can be resolved); `actorId?: ObjectId` (absent only for unauthenticated login failure); `action: String`; `entityType: String`; `entityId?: ObjectId`; `occurredAt: Date`; `requestId: String`; `reason?: String`; `metadata: safe allowlisted object`. Never include passwords, tokens, raw request bodies, or cost data in metadata. Insert-only, with no update/delete route. |
| `trashEvents` | `shopId: ObjectId`; `entityType: String`; `entityId: ObjectId`; `action: "DELETED" \| "DEACTIVATED" \| "VOIDED" \| "RESTORED"`; `actorId: ObjectId`; `reason?: String`; `occurredAt: Date`; `snapshot: safe allowlisted object`. Append-only. |
| `idempotencyRecords` | `shopId: ObjectId`; `userId: ObjectId`; `key: String`; `route: String`; `requestHash: String`; `responseStatus: Int32`; `responseDto: safe allowlisted object`; `createdAt: Date`; `expiresAt: Date`. Stored in the same transaction as the successful mutation; DTO payload excludes secrets and fields caller is not entitled to see. |

### 2.1 Indexes

Every business index begins with `shopId`, except the tenant-root `shops.slug` and global token-hash lookup. Unique constraints include `shopId` so independent shops can reuse names and numbers. Use case-folded/trimmed normalized values generated server-side, not client values.

| Collection | Indexes |
|---|---|
| `shops` | Unique `{ slug: 1 }`. |
| `users` | Unique `{ shopId: 1, usernameNormalized: 1 }` and `{ shopId: 1, emailNormalized: 1 }` for all records including deleted records, preventing identity reuse that would block safe restoration; `{ shopId: 1, role: 1, isActive: 1 }`. |
| `refreshSessions` | Unique `{ tokenHash: 1 }`; `{ shopId: 1, userId: 1, revokedAt: 1, expiresAt: 1 }`; TTL `{ expiresAt: 1 }` only after application-level expiry/revocation validation is implemented. |
| `counters` | Unique `{ shopId: 1, kind: 1 }`. |
| `categories`, `brands` | Unique `{ shopId: 1, normalizedName: 1 }`; `{ shopId: 1, isActive: 1, normalizedName: 1 }`. |
| `suppliers` | Unique `{ shopId: 1, normalizedName: 1 }` (duplicate names are prohibited by this proposal); `{ shopId: 1, isActive: 1, normalizedName: 1 }`. |
| `medicines` | Unique `{ shopId: 1, normalizedCode: 1 }`; `{ shopId: 1, isActive: 1, normalizedName: 1 }`; `{ shopId: 1, categoryId: 1, isActive: 1 }`; `{ shopId: 1, brandId: 1, isActive: 1 }`; `{ shopId: 1, drugClass: 1, isActive: 1 }`. |
| `barcodeClaims` | Unique `{ shopId: 1, normalizedBarcode: 1 }`; unique `{ shopId: 1, ownerType: 1, ownerId: 1, unitId: 1 }`. |
| `stockBatches` | FEFO `{ shopId: 1, medicineId: 1, status: 1, expiryDate: 1, receivedDate: 1, _id: 1 }`; alert/expiry `{ shopId: 1, status: 1, expiryDate: 1 }`; `{ shopId: 1, purchaseId: 1 }`. |
| `stockMovements` | `{ shopId: 1, batchId: 1, createdAt: -1, _id: -1 }`; `{ shopId: 1, referenceType: 1, referenceId: 1 }`. |
| `purchases` | Unique `{ shopId: 1, purchaseNumber: 1 }`; `{ shopId: 1, purchaseDate: -1, _id: -1 }`; `{ shopId: 1, supplierId: 1, purchaseDate: -1 }`. |
| `supplierLedger` | `{ shopId: 1, supplierId: 1, createdAt: -1, _id: -1 }`; unique `{ shopId: 1, referenceType: 1, referenceId: 1 }` where one ledger entry per source event is expected. |
| `sales` | Unique `{ shopId: 1, invoiceNumber: 1 }`; `{ shopId: 1, soldAt: -1, _id: -1 }`; `{ shopId: 1, customerId: 1, soldAt: -1 }`. |
| `saleReturns` | Unique `{ shopId: 1, returnNumber: 1 }`; `{ shopId: 1, saleId: 1, status: 1, requestedAt: -1 }`; `{ shopId: 1, status: 1, requestedAt: -1 }`. |
| `customers` | `{ shopId: 1, normalizedName: 1 }` (not unique); `{ shopId: 1, phone: 1 }`. Duplicate customers may be valid unless a later approved decision changes this. |
| `customerLedger` | `{ shopId: 1, customerId: 1, createdAt: -1, _id: -1 }`; unique `{ shopId: 1, referenceType: 1, referenceId: 1, entryType: 1 }`. |
| `expenses`, `cashBookEntries` | `{ shopId: 1, occurredAt: -1, _id: -1 }` for expenses; `{ shopId: 1, createdAt: -1, _id: -1 }` for cash book; unique `{ shopId: 1, referenceType: 1, referenceId: 1, entryType: 1 }` for cash-book source events. |
| `returnPolicySettings` | Unique `{ shopId: 1 }`. |
| `printRequests` | `{ shopId: 1, status: 1, createdAt: -1 }`; `{ shopId: 1, requesterId: 1, createdAt: -1 }`. |
| `auditLogs`, `trashEvents` | `{ shopId: 1, occurredAt: -1, _id: -1 }`; `{ shopId: 1, actorId: 1, occurredAt: -1 }`; `{ shopId: 1, entityType: 1, entityId: 1, occurredAt: -1 }`. |
| `idempotencyRecords` | Unique `{ shopId: 1, userId: 1, key: 1, route: 1 }`; TTL `{ expiresAt: 1 }` after replay window requirements are finalized. |

## 3. Numbering

For each committed sale, purchase, payment, or return, allocate a shop-local counter in the same transaction as the corresponding write:

1. `findOneAndUpdate({ shopId, kind }, { $inc: { lastValue: Long(1) }, $setOnInsert: { ... } }, { upsert: true, returnDocument: "after", session })` on `counters`.
2. Format the returned integer server-side as `INV-000001`, `PR-000001`, `PAY-000001`, or `RET-000001`; format and prefix are configuration/constants, never request input.
3. Enforce a unique `{ shopId, numberField: 1 }` index on the target collection. A duplicate is a transaction failure and retries the whole idempotent operation.

Number values are sequentially allocated per shop and kind, unique, and increasing. **Gap-free numbering is not promised**: voids, cancellations, business-level abandoned references, recovery/retry scenarios, or a committed record later voided retain their number. An aborted Mongo transaction rolls back its counter increment, but the design does not promise gaplessness under all operational failure modes.

## 4. Transaction boundaries

All listed transactions include the domain records, counter where relevant, derived balance changes, stock/customer/supplier/cash-book ledgers, audit event, and idempotency result. Validate authorization and payload before opening the transaction, then recheck mutable state inside it. Each transaction is shop-scoped and uses conditional updates (`quantityRemaining >= requested`) to prevent overselling. Apply the existing FEFO rule: active medicine, eligible positive quantity, expiry on/after shop-local business date, status `ACTIVE`/`NEAR_EXPIRY`, ordered expiry, received date, stable ID.

| Operation | Single MongoDB transaction contents and invariants |
|---|---|
| Sale | Allocate invoice counter; load current shop prices/customer and eligible FEFO batches; recompute all item/discount/payment totals on server; enforce role discount caps (Cashier 10%, Manager 15%, Admin 30%, Super Admin 30%, Accountant 0%) and maximum Rs 200 / 20,000 paisa per bill; conditionally decrement all batches; insert sale with allocations/payments; update customer credit + `customerLedger` for credit sale; insert `stockMovements`, cash-book entries for internally recorded tender, audit, and idempotency record. Any shortage, invalid tender, stale price, or failed write aborts everything. |
| Sale void | Proposed route; currently no sale-void RPC was found in the reviewed migrations. Require Admin/Super Admin role plus `sales_history`, reason, completed sale, and no completed return. In one transaction conditionally mark sale void, restore each original allocated quantity to its original batch (recompute sellable status; never route stock to a different batch), reverse customer credit/ledger and internal cash-book entries, add stock movements/audit/idempotency. For external tender, record a refund obligation/state; do not claim an external payout happened atomically. Void authorization/reversibility policy is an owner approval point. |
| Return request | One transaction loads and locks/rechecks sale allocation state, sums pending and completed units to prevent cumulative returns above sold units, allocates return number, inserts pending return lines and audit/idempotency. No stock or refund changes occur until approval. |
| Return decision/processing | One transaction rechecks pending request, sale and quantities; requires each line decision exactly once; applies window/shelf-life/class/storage/sealed-intact/whole-package policy for restock; restocks original eligible batch or creates/updates quarantine/write-off state; writes stock movements; updates sale/return state; updates customer credit/store credit and ledger for credit returns; records cash refund obligation/cash-book entry as applicable; appends audit and idempotency result. Non-restock dispositions do not increase sellable stock. |
| Purchase | Allocate purchase number; recompute subtotal/discount/total and validate paid amount, unit conversion, positive integer quantities, future expiry relative to purchase date, supplier and cost/MRP; insert purchase and embedded item snapshots; insert stock batches and receipt movements; update supplier balance + supplier ledger; insert cash-book entry for recorded payment; append audit/idempotency. Abort all on any error. |
| Purchase void | Admin/Super Admin plus `purchases` permission (and `purchase_history` for view); require reason, posted purchase, complete batch references, and no units from those batches sold/returned or otherwise changed incompatibly. In one transaction mark void, reverse remaining received stock and movements, reverse supplier balance/ledger and internal cash-book entry, append audit/idempotency. Refuse if stock history makes safe reversal impossible. |
| Product price/barcode update | In one transaction update the shop-scoped medicine/unit fields, claim/release `barcodeClaims` (unique per shop across medicine and unit barcodes), append `auditLogs` for price changes and idempotency result. Validate integer price and current barcode ownership inside the transaction. |
| Stock adjustment | `stock_inventory`; require batch in caller shop, reason and integer delta; conditional update prevents negative quantity; recompute status; append adjustment movement, audit and idempotency in one transaction. |
| Expired write-off | `stock_inventory`; require expired/non-sellable batch in shop, positive remaining quantity and reason; set remaining to zero/status `SOLD_OUT` or designated write-off terminal state; append negative movement, audit and idempotency in one transaction. |
| Customer payment | `customers`; positive integer amount not exceeding current debt; update customer balance, append `customerLedger` payment and cash-book entry, receipt reference/counter if issued, audit/idempotency in one transaction. |
| Customer ledger adjustment | Admin/Super Admin plus `customers`; reason required; update balance only with a signed, validated ledger event, append ledger/cashbook as applicable, audit/idempotency in one transaction. No ledger-edit/delete route. |
| Expense create/edit/void | Require `expenses` (Admin/Super Admin additionally required to void). In one transaction insert/update the expense, append a compensating cash-book entry rather than editing prior cash-book events, audit the change, and persist idempotency. No hard-delete. |
| Customer read/history | Read-only snapshot query using `shopId` + customer ID; no transaction needed for a consistent single-document view. Paginated ledger reads are read-only and scoped. |

Do not combine a Mongo transaction with printer, email, payment gateway, or other remote side effect. Persist an outbox/refund obligation in the transaction if later integration requires reliable delivery; that integration needs its own idempotent protocol.

## 5. Roles, permissions, and DTO classes

Every protected route requires a valid authenticated active user, active shop, `shopId` scope, and permission key. A role-only restriction is an additional requirement, not a replacement for permission. Admin and Super Admin receive all own-shop permissions but still pass route role guards. Permissions are resolved from the server-side `users` document, not token/client claims alone. Permission keys: `pos`, `products`, `categories`, `suppliers`, `customers`, `sales_history`, `purchase_history`, `purchases`, `expenses`, `stock_inventory`, `reports`, `manage_users`, `pos_print_sale`, `pos_print_payment`, `stock_alerts`.

| Role | Default module permissions in this design |
|---|---|
| Cashier | `pos`, `customers`; `pos_print_sale` and `pos_print_payment` only if explicitly granted and POS is granted; no cost access. |
| Manager | `pos`, `products`, `categories`, `suppliers`, `customers`, `sales_history`, `purchase_history`, `purchases`, `stock_inventory`, `reports`, `stock_alerts`; configurable subset; cost only on allowed modules when at least one of `products`, `stock_inventory`, `purchases`, `purchase_history` is granted. |
| Accountant | `customers`, `suppliers`, `sales_history`, `purchase_history`, `expenses`, `reports`, `stock_alerts`; configurable subset; read-only cost only through `purchase_history`/`reports`. |
| Admin | All module keys within own shop; cost access. Certain sensitive actions require Admin/Super Admin role. |
| Super Admin | All module keys for its assigned shop; cost access. No general cross-shop business-data access. |

Admin/Super Admin are not cross-shop principals. Shop provisioning/seeding and any exceptional support access require separately designed, explicitly audited workflows and are excluded from these ordinary routes. `stock_alerts` is included as a migration-target permission although it is absent from the current UI/SQL allowlists.

DTO shorthand used in the route table:

- **PublicAuth:** only access token, expiry, and non-sensitive user/shop display identifiers; refresh is an HttpOnly cookie and is never in JSON.
- **UserDTO:** own shop user identity, role, permissions and active state; never password hash, tokens, lockout internals.
- **CatalogDTO:** medicine/catalog identifiers, display name, category/brand, classification, barcode, unit conversion/retail price, sellable quantity as authorized; no cost for Cashier.
- **CostDTO:** CatalogDTO plus cost/MRP/margin only when role+permission cost policy allows it; never returned to Cashier or customer-facing routes. Accountant only on read-only permitted reports/history.
- **SaleDTO / ReceiptDTO:** invoice, sale/customer-safe line snapshots, discounts, tender/payment summary; no cost/profit/margin for any role in receipt/print/customer response. Manager/Admin/Accountant history responses may separately include cost fields only where explicitly authorized.
- **StockDTO:** batches, expiry, quantities, status and movements; cost fields only via CostDTO access; cashier never receives cost.
- **LedgerDTO:** customer/supplier balances and entries within shop; monetary amounts only, no product cost unless endpoint explicitly uses CostDTO.
- **AdminDTO:** safe operational details permitted to Admin/Super Admin; still excludes password hashes, refresh/session tokens, secrets and raw documents.
- For every endpoint below, “Allowed caller” means all named role/permission combinations still require the named module permission; `admin`/`super_admin` have the module permission by default, subject to extra role restrictions.

## 6. API endpoints

All paths are under `/api/v1`. Body/query fields shown are logical Zod-validated inputs (limits and detailed field formats are mandatory implementation details). All IDs are validated ObjectId strings. All mutation routes accept `Idempotency-Key` where marked. API responses use the named DTO only; pagination is `{ items, page, pageSize, total? }`.

| Method and path | Authentication / authorization | Validated input | Output DTO by role |
|---|---|---|---|
| `POST /auth/login` | Public; rate-limited; lockout checks | `{ shopSlug, usernameOrEmail, password }` | `PublicAuth` for all roles, generic failure for unknown shop/user, wrong password, or locked account. No public signup route. |
| `POST /auth/refresh` | Refresh cookie only; rotate + revoke prior token | No body; cookie + CSRF header/origin check | `PublicAuth`; new refresh cookie, no refresh token JSON. |
| `POST /auth/logout` | Access token + refresh cookie; revoke family | No body; CSRF header | `{ ok: true }`; no role-specific fields. |
| `GET /auth/me` | Authenticated | None | Own `UserDTO` for every role. |
| `GET /dashboard/summary` | Authenticated + `pos` for cashier dashboard; `reports` for financial/report summary | Date range | Cashier: safe activity counts only; Manager/Admin/Super Admin: `AdminDTO` summary with role-allowed values; Accountant: read-only financial `LedgerDTO`; never raw docs. |
| `GET /alerts/stock` | Authenticated + `stock_alerts` | `limit`, optional seen keys | Cost-free stock alert DTO for all roles explicitly granted `stock_alerts`. |
| `GET /products` | `products` | Search, filters, sort allowlist, page/pageSize | Cashier: denied unless separately granted `products`; CatalogDTO for authorized non-cost; CostDTO only for authorized Manager/Admin/Super Admin. |
| `GET /products/:id` | `products` | Path ID | Same as `GET /products`, single DTO. |
| `POST /products` / `PATCH /products/:id` | `products`; additionally `categories` if changing category/brand refs | Product fields + bounded units; no server-owned shop/cost override | `CatalogDTO`; CostDTO only to authorized role. |
| `POST /products/:id/barcodes` | `products` | Medicine/unit owner, valid EAN-13 or request to generate; idempotency | `{ barcode, ownerType }`; claim is shop-unique; no cost fields. |
| `GET /products/:id/label` | `products` | Label size, copies (1–200), allowlisted display fields | Cost-free label DTO for print renderer; cost/profit/margin fields are not selectable. |
| `POST /products/import/preview` / `POST /products/import` | `products` | 1–2000 rows; preview or import shape | Preview summary / import results; cost fields only in CostDTO role; row errors sanitized. |
| `PATCH /products/bulk` | `products` | Product IDs, allowlisted action/value | Count + safe changed fields; cost DTO role filtering. |
| `GET /categories` / `GET /brands` | Authenticated + `categories` or `products` | Search/active filters | Safe lookup DTO for all authorized roles; no costs. |
| `POST /categories` / `PATCH /categories/:id` / `DELETE /categories/:id` | `categories`; changing used category also requires `products` | Name/active state/reason | Safe category DTO; no raw document. Delete is logical deactivate where referenced. |
| `POST /brands` / `PATCH /brands/:id` / `DELETE /brands/:id` | `categories`; changing used brand also requires `products` | Name/active state/reason | Safe brand DTO; no raw document. |
| `POST /categories/merge` / `POST /brands/merge` | `categories` and `products` when products are affected | `{ sourceId, targetId }`, idempotency | Merge count + safe IDs; transactionally audited. |
| `GET /stock/summary` / `GET /stock/batches` / `GET /stock/expiry` / `GET /stock/movements` | `stock_inventory` | Filters, date range, allowlisted sort, page/pageSize | StockDTO; cost removed unless role's cost rule permits it; cashier denied absent permission and still never gets cost. |
| `POST /stock/adjustments` | `stock_inventory` | `{ batchId, quantityDeltaBaseUnits, reason }`; idempotency | Safe movement/updated quantity DTO; cost-free by default. |
| `POST /stock/write-offs` | `stock_inventory` | `{ batchId, reason }`; idempotency | Safe movement/updated quantity DTO; cost-free by default. |
| `GET /suppliers` / `GET /suppliers/:id` | `suppliers` | Search/page | Supplier safe DTO; payable balance shown to Manager only with an applicable purchase permission, Accountant only with `purchase_history` or `reports`, and Admin/Super Admin; never to Cashier. |
| `POST /suppliers` / `PATCH /suppliers/:id` / `POST /suppliers/:id/deactivate` | `suppliers` | Whitelisted supplier fields/reason | Safe supplier DTO, financial fields gated as above. |
| `GET /purchases/catalog` | `purchases` | Search/page | Manager/Admin/Super Admin CostDTO when cost access is permitted; Accountant only if explicitly granted `purchases`, read-only and cost-free; Cashier denied. |
| `POST /purchases` | `purchases`; Manager/Admin/Super Admin role + cost access | Supplier, dates, invoice, bounded items, integer paisa, payment fields; idempotency | Purchase result as CostDTO for authorized Manager/Admin/Super Admin; Accountant is read-only and cannot post; Cashier denied. |
| `GET /purchases` / `GET /purchases/:id` / `GET /purchases/export` | `purchase_history` | Search/date/payment filters/page; export column allowlist | Manager/Admin/Super Admin CostDTO; Accountant read-only CostDTO; Cashier denied. |
| `POST /purchases/:id/void` | Admin/Super Admin role + `purchases` + `purchase_history` | `{ reason }`; idempotency | Safe void result; cost data only in separately authorized admin DTO. |
| `GET /pos/catalog` | `pos` | Search/category/class | Cost-free CatalogDTO for every role with `pos`; sellable stock only. |
| `GET /customers` / `GET /customers/:id` | `customers` or `pos` for limited POS picker | Search/page | `customers`: LedgerDTO; POS picker returns minimal ID/name and credit eligibility/balance required for sale, no unrelated customer fields. |
| `POST /customers` / `PATCH /customers/:id` | `customers` | Whitelisted contact/credit-limit fields | Safe customer DTO; only own-shop data. |
| `GET /customers/:id/ledger` | `customers` | Date/page filters | LedgerDTO; cashier only minimal details if `customers` permission. |
| `POST /customers/:id/payments` | `customers`; idempotency | Positive integer amount, note, payment method | Payment receipt + LedgerDTO; transactional customer balance/ledger/cash-book update. |
| `POST /customers/:id/ledger-adjustments` | Admin/Super Admin role + `customers`; idempotency | Signed integer amount, reason, direction | LedgerDTO; no edit/delete of prior entries. |
| `POST /sales` | `pos`; idempotency | Customer, 1–100 item IDs/unit IDs/quantities, requested discount, tender/payment split, prescription evidence where required | Receipt-safe SaleDTO for all POS callers; no cost for any role in receipt DTO. |
| `GET /sales` / `GET /sales/:id` / `GET /sales/export` | `sales_history` | Date/customer/payment filters/page; export allowlist | Cashier: SaleDTO without cost; Manager/Admin/Super Admin: SaleDTO plus cost only if policy permits; Accountant read-only permitted history with authorized cost. |
| `GET /sales/:id/receipt` / `GET /sales/:id/payments/:paymentId/receipt` | `pos` or matching `pos_print_sale` / `pos_print_payment` | Sale/payment ID, paper size | ReceiptDTO only; cost/profit/margin excluded for every role and print output. |
| `GET /customers/:customerId/payments/:paymentId/receipt` | `customers` | Customer/payment-ledger ID, paper size | Customer payment receipt DTO only; cost/profit/margin excluded. |
| `POST /sales/:id/void` | Admin/Super Admin role + `sales_history`; idempotency | `{ reason }` | Safe void result; no receipt/cost leakage. Void feature/policy is proposed because no current SQL RPC was found. |
| `GET /sales/lookup-for-return` | `pos` | Invoice number | Customer-safe SaleDTO and returnable quantities only; no cost. |
| `POST /sales/:id/returns` | `pos`; idempotency | Reason + item/batch allocation IDs and base-unit quantities | Safe pending return DTO; no cost. |
| `GET /returns/pending` | Manager/Admin role + `sales_history` | Date/page filters | Return-review DTO with original sale price/refund only; no cost. |
| `POST /returns/:id/decision` | Manager/Admin role + `sales_history`; `stock_inventory` also required for any restock disposition; idempotency | Per-line disposition, sealed/intact evidence, reason | Safe decision/refund DTO; no cost. |
| `GET /return-policy` | `pos` | None | `{ returnWindowDays, minimumRestockShelfLifeDays }`. |
| `PATCH /return-policy` | Admin role + `pos` | Bounded policy values | Safe policy DTO + audit confirmation. |
| `GET /reports/sales` / `GET /reports/stock` / `GET /reports/purchases` | `reports`; purchase reports additionally `purchase_history` | Date range, grouping and allowlisted dimensions | Cashier receives no report unless explicitly permitted and then cost-free; Manager/Admin/Super Admin get permitted DTO; Accountant read-only; cost fields only under cost policy. |
| `GET /reports/controlled-drugs` | `reports` plus `products` (or `sales_history` when filtered by sold records) | Date range, medicine class, page; no arbitrary export projection | Admin/Manager/Accountant DTO by granted permissions; includes only authorized prescription evidence and sale/dispense records; Cashier denied absent explicit report grant; no cost. |
| `GET /expenses` / `POST /expenses` / `PATCH /expenses/:id` / `POST /expenses/:id/void` | `expenses`; Admin/Super Admin role for void | Date/category/page; integer amount/category/date; edit/void reason; idempotency on writes | Expense DTO, no purchase/product cost. No physical deletion. |
| `GET /cash-book` | `expenses` or `reports` | Date range/page | Cash-book DTO; no product unit cost, margin or profit. |
| `POST /print-requests` | `pos` + matching `pos_print_sale` or `pos_print_payment`; idempotency | Sale/payment reference + safe snapshot fields | Request status DTO and customer-safe snapshot; no cost. |
| `GET /print-requests/mine` | Authenticated + matching `pos_print_sale` or `pos_print_payment` permission for each returned request | Status/page | Own request DTO; safe snapshot only. |
| `GET /admin/print-requests` / `GET /admin/print-requests/pending-count` | Admin/Super Admin role + `pos` | Status/page | AdminDTO queue/count with safe requester identity and customer-safe snapshots. |
| `POST /admin/print-requests/:id/decision` / `PATCH /admin/print-requests/:id/snapshot` | Admin/Super Admin role + `pos`; snapshot mutation requires reason | Decision/note or allowlisted receipt edits + idempotency | Safe request DTO; completed sale remains unchanged. |
| `POST /print-requests/:id/printed` | Authenticated request owner or Admin/Super Admin + matching `pos_print_sale` or `pos_print_payment` permission | None/idempotency | `{ status, printedAt }`; no sensitive snapshot fields. |
| `GET /admin/trash` | Admin/Super Admin role + `manage_users` for user events and relevant module permission for each other entity class | Entity/date/page filters | AdminDTO safe event summary; no raw user credentials or cost payload. |
| `POST /admin/trash/:entityType/:id/restore` | Admin/Super Admin role + relevant module permission; `manage_users` for user restore | Reason where required; idempotency | Safe restored entity summary; audit/trash event appended. |
| `GET /admin/users` / `GET /admin/users/deleted` | `manage_users`; deleted listing Admin/Super Admin only | Search/page/status | UserDTO; non-Super Admin does not see Super Admin accounts. |
| `POST /admin/users` / `PATCH /admin/users/:id` / `POST /admin/users/:id/reset-password` / `POST /admin/users/:id/deactivate` / `POST /admin/users/:id/restore` | `manage_users`; Super Admin role required to create/edit/delete Admin or Super Admin; idempotency for mutations | Whitelisted identity/role/permission fields; password only on reset/create; no self-role/permission/active change | UserDTO/AdminDTO safe view; never credentials/hash/tokens. Preserve last Admin/Super Admin and 99-user cap unless owner changes it. |
| `GET /admin/audit-logs` | Admin/Super Admin role + `manage_users` or matching module permission for filtered own-shop events | Entity/actor/date/page | Safe append-only audit DTO; no raw request, token, secret or cost data. No write/delete endpoint. |
| `GET /shop/profile` / `PATCH /shop/profile` | `manage_users`; Admin role for edit; no Super Admin cross-shop identity edit | Allowlisted shop identity/receipt settings | Shop profile DTO; only caller's shop. |

Unknown routes and unsupported methods are denied. No route accepts a caller-selected shop identifier, arbitrary Mongo filter/sort/update expression, raw collection document, unbounded export, or caller-chosen output projection.

For any permission in the endpoint table, a route is available only to a role whose server-stored permission array contains the named key (the defaults above are not a hard-coded bypass). Role-restricted actions add the stated role check. Users may not change their own role, permissions, or active state; only Super Admin may create/edit/delete Admin or Super Admin accounts; protect the final active Admin and Super Admin; preserve the 99-user cap unless explicitly changed. User updates and permission changes are audited.

The auth/session routes (`/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me`) are the only permission-key exceptions: they only establish, rotate, revoke, or return the caller's own session identity and cannot access business records. Every other route requires the named permission key (or one of the explicitly stated alternatives) in addition to authentication and any role guard.

Every login success/failure, logout, user create/edit/delete/restore/password reset, role/permission change, sale, void, return, discount, stock adjustment, write-off, purchase, price change, and print approval/decision appends an audit event. Failed pre-auth events carry no raw username/email/password; use a rate-limit-safe identity fingerprint only if needed. Audit events are in the transaction for business mutations; session/login/logout and user-management events are inserted at their corresponding state transition.

## 7. Error and response policy

Use stable generic error codes (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `RATE_LIMITED`, `UNAVAILABLE`). A not-found response does not reveal whether an ID exists in another shop. Validation output may identify safe field names but never echo secret or cost values. Log a correlation ID and safe internal reason only; do not send stack traces, raw Mongo errors, query filters, tokens, passwords, or internal cost fields to the client.

## 8. Design choices requiring owner review

1. Approve the proposed sequential prefixes (`INV`, `PR`, `PAY`, `RET`) and inclusion of payment/return counters; all remain per-shop and not gap-free.
2. Approve the proposed sale-void eligibility/reversal behavior; current reviewed SQL does not contain a sale-void RPC, and external payout cannot be performed atomically with MongoDB.
3. Confirm whether purchase void should be Admin/Super Admin only (as the current SQL indicates) or be available to other authorized purchase roles.
4. Confirm whether duplicate normalized supplier/category/brand names should be prohibited per shop. This design prohibits them; customer names remain non-unique.
5. Confirm RX/controlled-drug prescription evidence fields and retention/access controls. This design records the sale reference, prescriber/patient where provided, and timestamp, but no prescription image/blob storage is in scope.
6. Confirm cash refund settlement: internal obligation/cash-book event is transactional; actual cash disbursement remains an operator/external event.
7. Confirm whether to retain the existing 99-user limit and the current return-window/restock-shelf-life defaults.
8. Confirm role default permissions and `stock_alerts` policy. `stock_alerts` is a required target key but absent from current UI/SQL allowlists.
