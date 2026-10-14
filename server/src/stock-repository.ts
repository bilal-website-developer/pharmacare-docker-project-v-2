import {
  Long,
  ObjectId,
  type Db,
  type Document,
  type MongoClient,
} from 'mongodb';
import type { AuditRecord, UserRecord } from './models.js';
import {
  addUtcDays,
  dateOnly,
  derivedExpiryStatus,
  longFromBigInt,
  objectId,
  roundDividePositive,
  utcDate,
  type PostPurchaseInput,
  type PurchaseHistoryQuery,
  type PurchaseRecord,
  type StockAdjustmentQuery,
  type StockBatchQuery,
  type StockBatchRecord,
  type StockListRow,
  type StockMovementRecord,
  type StockMovementRow,
} from './stock-domain.js';

export interface PurchaseListOptions extends PurchaseHistoryQuery {
  shopId: ObjectId;
}

export interface StockListOptions extends StockBatchQuery {
  shopId: ObjectId;
  canViewCost: boolean;
}

export interface StockLogOptions extends StockAdjustmentQuery {
  shopId: ObjectId;
}

export interface StockStats {
  stockValueCostPaisa?: string;
  stockValueMrpPaisa: string;
  expiring30: number;
  expiredBatches: number;
  expiredValueAtRiskPaisa?: string;
}

export interface ExpiryBucket {
  key: 'expired' | '0-30' | '31-60' | '61-90' | '90+';
  label: string;
  count: number;
  quantityRemainingBaseUnits: string;
}

export interface StockAlertItem {
  medicineId: string;
  name: string;
  strength: string | null;
  genericName: string;
  stockBaseUnits: string;
  minStockAlert: number;
  kind: 'low' | 'out';
}

export interface StockAlertsSummary {
  lowCount: number;
  outCount: number;
  generatedAt: string;
  items: StockAlertItem[];
}

export interface StockRepository {
  activePurchaseCatalog(shopId: ObjectId, canViewCost: boolean): Promise<{
    items: Record<string, unknown>[];
    suppliers: Array<{ id: string; name: string; contact: string }>;
  }>;
  stockAlertsSummary(shopId: ObjectId, limit: number): Promise<StockAlertsSummary>;
  postPurchase(input: PostPurchaseInput, actor: UserRecord, audit: AuditRecord): Promise<PurchaseRecord>;
  voidPurchase(shopId: ObjectId, purchaseId: ObjectId, actor: UserRecord, reason: string, audit: AuditRecord): Promise<PurchaseRecord | null>;
  listPurchases(options: PurchaseListOptions): Promise<{ rows: PurchaseRecord[]; total: number }>;
  getPurchase(shopId: ObjectId, purchaseId: ObjectId): Promise<PurchaseRecord | null>;
  stockStats(shopId: ObjectId, canViewCost: boolean): Promise<StockStats>;
  expiryBuckets(shopId: ObjectId): Promise<ExpiryBucket[]>;
  listStock(options: StockListOptions): Promise<{ rows: StockListRow[]; total: number }>;
  listAdjustments(options: StockLogOptions): Promise<{ rows: StockMovementRow[]; total: number }>;
  adjustStock(shopId: ObjectId, batchId: ObjectId, actor: UserRecord, delta: Long, reason: string, audit: AuditRecord): Promise<StockBatchRecord | null>;
  writeOffExpired(shopId: ObjectId, batchId: ObjectId, actor: UserRecord, audit: AuditRecord): Promise<{ before: Long; batch: StockBatchRecord } | null>;
  refreshStatuses(shopId: ObjectId, today?: Date): Promise<void>;
}

function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function maxLong(): bigint {
  return 9_223_372_036_854_775_807n;
}

function requireLong(value: bigint, field: string): Long {
  if (value < 0n || value > maxLong()) throw new RangeError(`${field} exceeds the supported Int64 range`);
  return Long.fromString(value.toString());
}

function asLong(value: unknown): Long {
  if (Long.isLong(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return Long.fromNumber(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Long.fromString(value);
  throw new Error('Invalid stored integer value');
}

function purchaseNumber(value: Long): string {
  return `PR-${value.toString().padStart(6, '0')}`;
}

export class MongoStockRepository implements StockRepository {
  private readonly database: Db;

  constructor(private readonly client: MongoClient, databaseName: string) {
    this.database = client.db(databaseName);
  }

  private batchCollection() {
    return this.database.collection<StockBatchRecord>('stockBatches');
  }

  private purchaseCollection() {
    return this.database.collection<PurchaseRecord>('purchases');
  }

  async activePurchaseCatalog(shopId: ObjectId, canViewCost: boolean): Promise<{
    items: Record<string, unknown>[];
    suppliers: Array<{ id: string; name: string; contact: string }>;
  }> {
    const medicines = await this.database.collection('medicines').find({
      shopId, isActive: true, deletedAt: null,
    }).sort({ name: 1, _id: 1 }).toArray();
    const medicineIds = medicines.map((medicine) => medicine._id);
    const [units, suppliers, latestCosts] = await Promise.all([
      this.database.collection('medicineUnits').find({
        shopId, medicineId: { $in: medicineIds }, deletedAt: null,
      }).sort({ isDefaultSaleUnit: -1, name: 1 }).toArray(),
      this.database.collection('suppliers').find({
        shopId, isActive: true, deletedAt: null,
      }).sort({ name: 1, _id: 1 }).project({ name: 1, contact: 1 }).toArray(),
      canViewCost && medicineIds.length
        ? this.database.collection('stockBatches').aggregate([
          { $match: { shopId, medicineId: { $in: medicineIds } } },
          { $sort: { createdAt: -1, _id: -1 } },
          { $group: { _id: '$medicineId', cost: { $first: '$unitCostPaisaPerBaseUnit' } } },
        ]).toArray()
        : Promise.resolve([]),
    ]);
    const unitsByMedicine = new Map<string, Record<string, unknown>[]>();
    for (const unit of units) {
      const id = (unit.medicineId as ObjectId).toHexString();
      const records = unitsByMedicine.get(id) ?? [];
      records.push({
        id: unit._id.toHexString(),
        name: unit.name,
        conversionFactorBaseUnits: unit.conversionFactorBaseUnits,
        isDefaultSaleUnit: unit.isDefaultSaleUnit,
        pricePaisa: asLong(unit.pricePaisa).toString(),
      });
      unitsByMedicine.set(id, records);
    }
    const costByMedicine = new Map(latestCosts.map((entry) => [
      (entry._id as ObjectId).toHexString(),
      asLong(entry.cost).toString(),
    ]));
    const stockByMedicine = new Map<string, bigint>();
    for await (const batch of this.batchCollection().find({ shopId })) {
      const id = batch.medicineId.toHexString();
      stockByMedicine.set(id, (stockByMedicine.get(id) ?? 0n) + BigInt(batch.quantityRemainingBaseUnits.toString()));
    }
    return {
      items: medicines.map((medicine) => ({
      id: medicine._id.toHexString(),
      code: medicine.code,
      barcode: medicine.barcode ?? null,
      name: medicine.name,
      genericName: medicine.genericName ?? '',
      manufacturer: medicine.manufacturer ?? '',
      stockBaseUnits: (stockByMedicine.get(medicine._id.toHexString()) ?? 0n).toString(),
      units: unitsByMedicine.get(medicine._id.toHexString()) ?? [],
      ...(canViewCost
        ? { lastCostPaisaPerBaseUnit: costByMedicine.get(medicine._id.toHexString()) ?? null }
        : {}),
      })),
      suppliers: suppliers.map((supplier) => ({
        id: supplier._id.toHexString(),
        name: String(supplier.name),
        contact: String(supplier.contact ?? ''),
      })),
    };
  }

  async stockAlertsSummary(shopId: ObjectId, limit: number): Promise<StockAlertsSummary> {
    const today = utcDate(new Date());
    const medicines = await this.database.collection('medicines').find({
      shopId, isActive: true, deletedAt: null,
    }).toArray();
    const ids = medicines.map((medicine) => medicine._id);
    const stockByMedicine = new Map<string, bigint>();
    for await (const batch of this.batchCollection().find({
      shopId,
      medicineId: { $in: ids },
      quantityRemainingBaseUnits: { $gt: Long.ZERO },
      expiryDate: { $gte: today },
      status: { $in: ['ACTIVE', 'NEAR_EXPIRY'] as const },
    }).project({ medicineId: 1, quantityRemainingBaseUnits: 1 })) {
      const id = batch.medicineId.toHexString();
      stockByMedicine.set(id, (stockByMedicine.get(id) ?? 0n) + BigInt(batch.quantityRemainingBaseUnits.toString()));
    }
    const alerts = medicines.flatMap((medicine) => {
      const threshold = Number(medicine.minStockAlert ?? 0);
      if (!Number.isSafeInteger(threshold) || threshold <= 0) return [];
      const stock = stockByMedicine.get(medicine._id.toHexString()) ?? 0n;
      if (stock > BigInt(threshold)) return [];
      return [{
        medicineId: medicine._id.toHexString(),
        name: String(medicine.name),
        strength: typeof medicine.strength === 'string' ? medicine.strength : null,
        genericName: String(medicine.genericName ?? ''),
        stockBaseUnits: stock.toString(),
        minStockAlert: threshold,
        kind: stock === 0n ? 'out' as const : 'low' as const,
      }];
    }).sort((left, right) => {
      const outOrder = Number(right.kind === 'out') - Number(left.kind === 'out');
      if (outOrder) return outOrder;
      const leftShortage = BigInt(left.minStockAlert) - BigInt(left.stockBaseUnits);
      const rightShortage = BigInt(right.minStockAlert) - BigInt(right.stockBaseUnits);
      if (leftShortage !== rightShortage) return leftShortage > rightShortage ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return {
      lowCount: alerts.filter((item) => item.kind === 'low').length,
      outCount: alerts.filter((item) => item.kind === 'out').length,
      generatedAt: new Date().toISOString(),
      items: alerts.slice(0, limit),
    };
  }

  async postPurchase(input: PostPurchaseInput, actor: UserRecord, audit: AuditRecord): Promise<PurchaseRecord> {
    const session = this.client.startSession();
    let posted: PurchaseRecord | undefined;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const purchaseDate = input.purchaseDate ? dateOnly(input.purchaseDate) : utcDate(now);
        const today = utcDate(now);
        if (!input.items.length || input.items.length > 200) throw new Error('INVALID_PURCHASE');
        if (input.items.some((item) => dateOnly(item.expiryDate) <= purchaseDate)) throw new Error('EXPIRY_NOT_AFTER_PURCHASE_DATE');

        const supplier = await this.database.collection('suppliers').findOne({
          _id: objectId(input.supplierId), shopId: actor.shopId, isActive: true, deletedAt: null,
        }, { session });
        if (!supplier) throw new Error('ACTIVE_SUPPLIER_REQUIRED');

        const items: PurchaseRecord['items'] = [];
        const batches: StockBatchRecord[] = [];
        const movements: StockMovementRecord[] = [];
        let subtotal = 0n;
        for (const item of input.items) {
          const medicineId = objectId(item.medicineId);
          const unitId = objectId(item.unitId);
          const medicine = await this.database.collection('medicines').findOne({
            _id: medicineId, shopId: actor.shopId, isActive: true, deletedAt: null,
          }, { session });
          const unit = await this.database.collection('medicineUnits').findOne({
            _id: unitId, shopId: actor.shopId, medicineId, deletedAt: null,
          }, { session });
          if (!medicine || !unit) throw new Error('ACTIVE_MEDICINE_AND_UNIT_REQUIRED');
          const factor = Number(unit.conversionFactorBaseUnits);
          if (!Number.isSafeInteger(factor) || factor < 1) throw new Error('INVALID_UNIT_CONVERSION');
          const baseQuantity = BigInt(item.quantity + item.bonusQuantity) * BigInt(factor);
          if (baseQuantity < 1n || baseQuantity > 2_147_483_647n) throw new Error('QUANTITY_LIMIT_EXCEEDED');
          const unitCost = BigInt(item.unitCostPaisa);
          const unitMrp = BigInt(item.mrpPaisa);
          const lineTotal = BigInt(item.quantity) * unitCost;
          subtotal += lineTotal;
          if (subtotal > maxLong()) throw new Error('PURCHASE_TOTAL_LIMIT_EXCEEDED');
          const received = requireLong(baseQuantity, 'quantity');
          const batchId = new ObjectId();
          const itemId = new ObjectId();
          const expiryDate = dateOnly(item.expiryDate);
          const batch: StockBatchRecord = {
            _id: batchId,
            shopId: actor.shopId,
            medicineId,
            supplierId: supplier._id,
            purchaseId: new ObjectId(),
            purchaseItemId: itemId,
            batchNumber: item.batchNumber,
            expiryDate,
            receivedDate: purchaseDate,
            quantityReceivedBaseUnits: received,
            quantityReturnedBaseUnits: Long.ZERO,
            quantityRemainingBaseUnits: received,
            unitCostPaisaPerBaseUnit: requireLong(roundDividePositive(unitCost, BigInt(factor)), 'unit cost'),
            mrpPaisaPerBaseUnit: requireLong(roundDividePositive(unitMrp, BigInt(factor)), 'MRP'),
            status: derivedExpiryStatus(expiryDate, received, today),
            createdAt: now,
            updatedAt: now,
          };
          batches.push(batch);
          items.push({
            purchaseItemId: itemId,
            medicineId,
            medicineNameSnapshot: String(medicine.name),
            medicineCodeSnapshot: String(medicine.code),
            unitId,
            unitNameSnapshot: String(unit.name),
            conversionFactorBaseUnits: factor,
            quantityInUnits: item.quantity,
            bonusQuantityBaseUnits: requireLong(BigInt(item.bonusQuantity) * BigInt(factor), 'bonus quantity'),
            quantityReceivedBaseUnits: received,
            unitCostPaisa: requireLong(unitCost, 'unit cost'),
            mrpPaisa: requireLong(unitMrp, 'MRP'),
            lineTotalPaisa: requireLong(lineTotal, 'line total'),
            batchId,
            batchNumber: item.batchNumber,
            expiryDate,
          });
        }
        const discount = BigInt(input.discountPaisa);
        if (discount > subtotal) throw new Error('DISCOUNT_EXCEEDS_SUBTOTAL');
        const total = subtotal - discount;
        const paid = input.paymentType === 'cash' ? total : 0n;
        const payableDelta = total - paid;
        const counter = await this.database.collection<{ shopId: ObjectId; kind: string; lastValue: Long }>('counters')
          .findOneAndUpdate(
            { shopId: actor.shopId, kind: 'PURCHASE' },
            { $inc: { lastValue: Long.ONE }, $setOnInsert: { shopId: actor.shopId, kind: 'PURCHASE' } },
            { upsert: true, returnDocument: 'after', includeResultMetadata: false, session },
          );
        if (!counter) throw new Error('PURCHASE_NUMBER_ALLOCATION_FAILED');
        const purchaseId = new ObjectId();
        for (const batch of batches) batch.purchaseId = purchaseId;
        const purchase: PurchaseRecord = {
          _id: purchaseId,
          shopId: actor.shopId,
          purchaseNumber: purchaseNumber(counter.lastValue),
          supplierId: supplier._id,
          supplierNameSnapshot: String(supplier.name),
          invoiceNumber: input.invoiceNumber,
          purchaseDate,
          status: 'posted',
          paymentType: input.paymentType,
          subtotalPaisa: requireLong(subtotal, 'subtotal'),
          discountPaisa: requireLong(discount, 'discount'),
          totalPaisa: requireLong(total, 'total'),
          paidPaisa: requireLong(paid, 'paid'),
          notes: input.notes,
          items,
          createdBy: actor._id,
          createdAt: now,
        };
        for (const batch of batches) {
          movements.push({
            _id: new ObjectId(),
            shopId: actor.shopId,
            batchId: batch._id,
            medicineId: batch.medicineId,
            movementType: 'RECEIPT',
            quantityDeltaBaseUnits: batch.quantityReceivedBaseUnits,
            referenceType: 'PURCHASE',
            referenceId: purchaseId,
            reason: `Purchase ${purchase.purchaseNumber}`,
            actorId: actor._id,
            createdAt: now,
          });
        }

        const batchCollection = this.batchCollection();
        await this.purchaseCollection().insertOne(purchase, { session });
        await batchCollection.insertMany(batches, { session });
        await this.database.collection<StockMovementRecord>('stockMovements').insertMany(movements, { session });
        const supplierUpdate = await this.database.collection('suppliers').updateOne(
          { _id: supplier._id, shopId: actor.shopId, isActive: true, deletedAt: null },
          { $inc: { payableBalancePaisa: requireLong(payableDelta, 'supplier balance') } },
          { session },
        );
        if (supplierUpdate.matchedCount !== 1) throw new Error('SUPPLIER_CHANGED_DURING_PURCHASE');
        const supplierAfter = await this.database.collection('suppliers').findOne(
          { _id: supplier._id, shopId: actor.shopId },
          { session },
        );
        if (!supplierAfter) throw new Error('SUPPLIER_CHANGED_DURING_PURCHASE');
        await this.database.collection('supplierLedger').insertOne({
          shopId: actor.shopId,
          supplierId: supplier._id,
          referenceType: 'PURCHASE',
          referenceId: purchaseId,
          debitPaisa: requireLong(paid, 'paid'),
          creditPaisa: requireLong(total, 'total'),
          balanceAfterPaisa: asLong(supplierAfter.payableBalancePaisa),
          actorId: actor._id,
          createdAt: now,
          note: `Purchase ${purchase.purchaseNumber}`,
        }, { session });
        if (paid > 0n) {
          await this.database.collection('cashBookEntries').insertOne({
            shopId: actor.shopId,
            entryType: 'PURCHASE_PAYMENT',
            direction: 'OUT',
            amountPaisa: requireLong(paid, 'paid'),
            referenceType: 'PURCHASE',
            referenceId: purchaseId,
            paymentMethod: 'CASH',
            actorId: actor._id,
            createdAt: now,
          }, { session });
        }
        await this.database.collection<AuditRecord>('auditLogs').insertOne({
          ...audit,
          event: 'purchase.posted',
          entityType: 'purchase',
          entityId: purchaseId,
          after: {
            purchaseNumber: purchase.purchaseNumber,
            supplierId: supplier._id.toHexString(),
            totalPaisa: purchase.totalPaisa.toString(),
            itemCount: items.length,
          },
          occurredAt: now,
        }, { session });
        posted = purchase;
      });
      if (!posted) throw new Error('PURCHASE_TRANSACTION_DID_NOT_COMPLETE');
      return posted;
    } catch (error) {
      if (isDuplicate(error)) throw new Error('DUPLICATE_PURCHASE_VALUE');
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async voidPurchase(
    shopId: ObjectId,
    purchaseId: ObjectId,
    actor: UserRecord,
    reason: string,
    audit: AuditRecord,
  ): Promise<PurchaseRecord | null> {
    const session = this.client.startSession();
    let voided: PurchaseRecord | null = null;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const purchase = await this.purchaseCollection().findOne(
          { _id: purchaseId, shopId, status: 'posted' },
          { session },
        );
        if (!purchase) return;
        const batchIds = purchase.items.map((item) => item.batchId);
        if (batchIds.length === 0 || batchIds.some((id) => !id)) throw new Error('PURCHASE_BATCH_REFERENCES_INCOMPLETE');
        const batches = await this.batchCollection().find(
          { _id: { $in: batchIds }, shopId, purchaseId },
          { session },
        ).toArray();
        if (batches.length !== purchase.items.length) throw new Error('PURCHASE_BATCH_REFERENCES_INCOMPLETE');
        for (const batch of batches) {
          const changedMovement = await this.database.collection<StockMovementRecord>('stockMovements').findOne({
            shopId,
            batchId: batch._id,
            movementType: { $ne: 'RECEIPT' },
          }, { session, projection: { _id: 1 } });
          if (!batch.quantityRemainingBaseUnits.equals(batch.quantityReceivedBaseUnits) || changedMovement) {
            throw new Error('PURCHASE_STOCK_ALREADY_CHANGED');
          }
        }
        for (const batch of batches) {
          const update = await this.batchCollection().updateOne(
            {
              _id: batch._id,
              shopId,
              purchaseId,
              quantityRemainingBaseUnits: batch.quantityReceivedBaseUnits,
            },
            {
              $set: { quantityRemainingBaseUnits: Long.ZERO, status: 'RETURNED', updatedAt: now },
            },
            { session },
          );
          if (update.modifiedCount !== 1) throw new Error('PURCHASE_STOCK_CHANGED_CONCURRENTLY');
          await this.database.collection<StockMovementRecord>('stockMovements').insertOne({
            _id: new ObjectId(),
            shopId,
            batchId: batch._id,
            medicineId: batch.medicineId,
            movementType: 'PURCHASE_RETURN',
            quantityDeltaBaseUnits: Long.fromString(`-${batch.quantityRemainingBaseUnits.toString()}`),
            referenceType: 'PURCHASE_VOID',
            referenceId: purchaseId,
            reason: reason.trim(),
            actorId: actor._id,
            createdAt: now,
          }, { session });
        }
        const originalLedger = await this.database.collection('supplierLedger').findOne(
          { shopId, supplierId: purchase.supplierId, referenceType: 'PURCHASE', referenceId: purchaseId },
          { session },
        );
        if (!originalLedger) throw new Error('PURCHASE_SUPPLIER_LEDGER_MISSING');
        const debit = asLong(originalLedger.debitPaisa);
        const credit = asLong(originalLedger.creditPaisa);
        const netOwed = BigInt(credit.toString()) - BigInt(debit.toString());
        const supplierUpdate = await this.database.collection('suppliers').updateOne(
          { _id: purchase.supplierId, shopId, payableBalancePaisa: { $gte: requireLong(netOwed, 'supplier balance') } },
          { $inc: { payableBalancePaisa: requireLong(-netOwed, 'supplier balance') } },
          { session },
        );
        if (supplierUpdate.matchedCount !== 1) throw new Error('SUPPLIER_BALANCE_RECONCILIATION_FAILED');
        const supplierAfter = await this.database.collection('suppliers').findOne(
          { _id: purchase.supplierId, shopId },
          { session },
        );
        if (!supplierAfter) throw new Error('SUPPLIER_NOT_FOUND');
        await this.database.collection('supplierLedger').insertOne({
          shopId,
          supplierId: purchase.supplierId,
          referenceType: 'PURCHASE_VOID',
          referenceId: purchaseId,
          debitPaisa: credit,
          creditPaisa: debit,
          balanceAfterPaisa: asLong(supplierAfter.payableBalancePaisa),
          actorId: actor._id,
          createdAt: now,
          note: `Void ${purchase.purchaseNumber}: ${reason.trim()}`,
        }, { session });
        if (purchase.paidPaisa.greaterThan(Long.ZERO)) {
          await this.database.collection('cashBookEntries').insertOne({
            shopId,
            entryType: 'PURCHASE_PAYMENT',
            direction: 'IN',
            amountPaisa: purchase.paidPaisa,
            referenceType: 'PURCHASE_VOID',
            referenceId: purchaseId,
            paymentMethod: 'CASH',
            actorId: actor._id,
            createdAt: now,
          }, { session });
        }
        const result = await this.purchaseCollection().updateOne(
          { _id: purchaseId, shopId, status: 'posted' },
          { $set: { status: 'void', voidReason: reason.trim(), voidedAt: now, voidedBy: actor._id } },
          { session },
        );
        if (result.modifiedCount !== 1) throw new Error('PURCHASE_CHANGED_CONCURRENTLY');
        const after = { ...purchase, status: 'void' as const, voidReason: reason.trim(), voidedAt: now, voidedBy: actor._id };
        await this.database.collection<AuditRecord>('auditLogs').insertOne({
          ...audit,
          event: 'purchase.voided',
          entityType: 'purchase',
          entityId: purchaseId,
          before: { status: purchase.status },
          after: { status: after.status, reason: after.voidReason },
          occurredAt: now,
        }, { session });
        voided = after;
      });
      return voided;
    } finally {
      await session.endSession();
    }
  }

  async listPurchases(options: PurchaseListOptions): Promise<{ rows: PurchaseRecord[]; total: number }> {
    const filter: Document = { shopId: options.shopId };
    if (options.paymentType) filter.paymentType = options.paymentType;
    if (options.status) filter.status = options.status;
    if (options.dateFrom || options.dateTo) {
      filter.purchaseDate = {
        ...(options.dateFrom ? { $gte: dateOnly(options.dateFrom) } : {}),
        ...(options.dateTo ? { $lte: dateOnly(options.dateTo) } : {}),
      };
    }
    if (options.search) {
      const expression = new RegExp(options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { purchaseNumber: expression },
        { invoiceNumber: expression },
        { supplierNameSnapshot: expression },
      ];
    }
    const collection = this.purchaseCollection();
    const [rows, total] = await Promise.all([
      collection.find(filter).sort({ purchaseDate: -1, _id: -1 })
        .skip((options.page - 1) * options.pageSize).limit(options.pageSize).toArray(),
      collection.countDocuments(filter),
    ]);
    return { rows, total };
  }

  getPurchase(shopId: ObjectId, purchaseId: ObjectId): Promise<PurchaseRecord | null> {
    return this.purchaseCollection().findOne({ _id: purchaseId, shopId });
  }

  async stockStats(shopId: ObjectId, canViewCost: boolean): Promise<StockStats> {
    const today = utcDate(new Date());
    const near30 = addUtcDays(today, 30);
    const activeIds = new Set((await this.database.collection('medicines')
      .find({ shopId, isActive: true, deletedAt: null }, { projection: { _id: 1 } })
      .toArray()).map((medicine) => medicine._id.toHexString()));
    let sellableCost = 0n;
    let sellableMrp = 0n;
    let expiredCost = 0n;
    let expiring30 = 0;
    let expiredBatches = 0;
    for await (const batch of this.batchCollection().find({ shopId, quantityRemainingBaseUnits: { $gt: Long.ZERO } })) {
      const quantity = BigInt(batch.quantityRemainingBaseUnits.toString());
      const expiry = utcDate(batch.expiryDate);
      const expired = expiry < today;
      const activeMedicine = activeIds.has(batch.medicineId.toHexString());
      const sellable = activeMedicine
        && expiry >= today
        && (batch.status === 'ACTIVE' || batch.status === 'NEAR_EXPIRY');
      if (sellable) {
        sellableMrp += quantity * BigInt(batch.mrpPaisaPerBaseUnit.toString());
        if (canViewCost) sellableCost += quantity * BigInt(batch.unitCostPaisaPerBaseUnit.toString());
        if (expiry <= near30) expiring30 += 1;
      }
      if (expired) {
        expiredBatches += 1;
        if (canViewCost) expiredCost += quantity * BigInt(batch.unitCostPaisaPerBaseUnit.toString());
      }
    }
    return {
      stockValueMrpPaisa: requireLong(sellableMrp, 'stock MRP value').toString(),
      expiring30,
      expiredBatches,
      ...(canViewCost ? {
        stockValueCostPaisa: requireLong(sellableCost, 'stock value').toString(),
        expiredValueAtRiskPaisa: requireLong(expiredCost, 'expired value').toString(),
      } : {}),
    };
  }

  async expiryBuckets(shopId: ObjectId): Promise<ExpiryBucket[]> {
    const today = utcDate(new Date());
    const boundaries = [addUtcDays(today, 30), addUtcDays(today, 60), addUtcDays(today, 90)];
    const activeIds = new Set((await this.database.collection('medicines')
      .find({ shopId, isActive: true, deletedAt: null }, { projection: { _id: 1 } })
      .toArray()).map((medicine) => medicine._id.toHexString()));
    const buckets = new Map<ExpiryBucket['key'], { count: number; quantity: bigint }>([
      ['expired', { count: 0, quantity: 0n }],
      ['0-30', { count: 0, quantity: 0n }],
      ['31-60', { count: 0, quantity: 0n }],
      ['61-90', { count: 0, quantity: 0n }],
      ['90+', { count: 0, quantity: 0n }],
    ]);
    for await (const batch of this.batchCollection().find({ shopId, quantityRemainingBaseUnits: { $gt: Long.ZERO } })) {
      const expiry = utcDate(batch.expiryDate);
      const isEligibleStatus = batch.status === 'ACTIVE' || batch.status === 'NEAR_EXPIRY';
      let key: ExpiryBucket['key'] | undefined;
      if (expiry < today) key = 'expired';
      else if (activeIds.has(batch.medicineId.toHexString()) && isEligibleStatus) {
        if (expiry <= boundaries[0]!) key = '0-30';
        else if (expiry <= boundaries[1]!) key = '31-60';
        else if (expiry <= boundaries[2]!) key = '61-90';
        else key = '90+';
      }
      if (key) {
        const bucket = buckets.get(key)!;
        bucket.count += 1;
        bucket.quantity += BigInt(batch.quantityRemainingBaseUnits.toString());
      }
    }
    const labels: Record<ExpiryBucket['key'], string> = {
      expired: 'Expired', '0-30': '0-30 days', '31-60': '31-60 days',
      '61-90': '61-90 days', '90+': '90+ days',
    };
    return [...buckets].map(([key, value]) => ({
      key,
      label: labels[key],
      count: value.count,
      quantityRemainingBaseUnits: requireLong(value.quantity, 'expiry bucket quantity').toString(),
    }));
  }

  async listStock(options: StockListOptions): Promise<{ rows: StockListRow[]; total: number }> {
    const today = utcDate(new Date());
    const search = options.search?.trim();
    const sortField: Record<StockBatchQuery['sort'], string> = {
      medicine_asc: 'medicine.name', medicine_desc: 'medicine.name',
      batch_asc: 'batchNumber', batch_desc: 'batchNumber',
      expiry_asc: 'expiryDate', expiry_desc: 'expiryDate',
      quantity_asc: 'quantityRemainingBaseUnits', quantity_desc: 'quantityRemainingBaseUnits',
      cost_asc: 'unitCostPaisaPerBaseUnit', cost_desc: 'unitCostPaisaPerBaseUnit',
      value_asc: 'stockValueCostPaisa', value_desc: 'stockValueCostPaisa',
    };
    const direction = options.sort.endsWith('_desc') ? -1 : 1;
    const tabMatch: Document[] = [];
    if (options.tab === 'near-expiry') {
      tabMatch.push({
        'medicine.isActive': true,
        $expr: {
          $and: [
            { $gte: ['$expiryDate', today] },
            { $lte: ['$expiryDate', addUtcDays(today, 90)] },
            { $gt: ['$quantityRemainingBaseUnits', Long.ZERO] },
            { $in: ['$status', ['ACTIVE', 'NEAR_EXPIRY']] },
          ],
        },
      });
    } else if (options.tab === 'expired') {
      tabMatch.push({ $expr: { $and: [{ $lt: ['$expiryDate', today] }, { $gt: ['$quantityRemainingBaseUnits', Long.ZERO] }] } });
    } else if (options.tab === 'low-stock') {
      tabMatch.push({
        'medicine.isActive': true,
        'medicine.minStockAlert': { $gt: 0 },
        $expr: { $and: [{ $gt: ['$sellableStockBaseUnits', Long.ZERO] }, { $lte: ['$sellableStockBaseUnits', '$medicine.minStockAlert'] }] },
      });
    } else if (!search && !options.medicineId) {
      tabMatch.push({ quantityRemainingBaseUnits: { $gt: Long.ZERO } });
    }
    if (options.expiryBucket === 'expired') {
      tabMatch.push({ $expr: { $and: [{ $lt: ['$expiryDate', today] }, { $gt: ['$quantityRemainingBaseUnits', Long.ZERO] }] } });
    } else if (options.expiryBucket) {
      const lower = options.expiryBucket === '0-30' ? today
        : options.expiryBucket === '31-60' ? addUtcDays(today, 30)
          : options.expiryBucket === '61-90' ? addUtcDays(today, 60) : addUtcDays(today, 90);
      const lowerExclusive = options.expiryBucket !== '0-30';
      const upper = options.expiryBucket === '0-30' ? addUtcDays(today, 30)
        : options.expiryBucket === '31-60' ? addUtcDays(today, 60)
          : options.expiryBucket === '61-90' ? addUtcDays(today, 90) : undefined;
      tabMatch.push({
        'medicine.isActive': true,
        $expr: { $and: [
          ...(lowerExclusive ? [{ $gt: ['$expiryDate', lower] }] : [{ $gte: ['$expiryDate', lower] }]),
          ...(upper ? [{ $lte: ['$expiryDate', upper] }] : []),
          { $gt: ['$quantityRemainingBaseUnits', Long.ZERO] },
          { $in: ['$status', ['ACTIVE', 'NEAR_EXPIRY']] },
        ] },
      });
    }
    if (options.medicineId) tabMatch.push({ medicineId: objectId(options.medicineId) });
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      tabMatch.push({ $or: [
        { batchNumber: regex },
        { 'medicine.name': regex },
        { 'medicine.genericName': regex },
        { 'medicine.code': regex },
        { 'medicine.barcode': regex },
      ] });
    }
    const pipeline: Document[] = [
      { $match: { shopId: options.shopId } },
      { $lookup: {
        from: 'medicines',
        let: { medicineId: '$medicineId', tenantId: '$shopId' },
        pipeline: [{ $match: { $expr: { $and: [
          { $eq: ['$_id', '$$medicineId'] },
          { $eq: ['$shopId', '$$tenantId'] },
        ] } } }],
        as: 'medicine',
      } },
      { $unwind: '$medicine' },
      { $lookup: {
        from: 'suppliers',
        let: { supplierId: '$supplierId', tenantId: '$shopId' },
        pipeline: [{ $match: { $expr: { $and: [
          { $eq: ['$_id', '$$supplierId'] },
          { $eq: ['$shopId', '$$tenantId'] },
        ] } } }],
        as: 'supplier',
      } },
      { $unwind: { path: '$supplier', preserveNullAndEmptyArrays: true } },
      { $lookup: {
        from: 'stockBatches',
        let: { medId: '$medicineId', tenantId: '$shopId' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$shopId', '$$tenantId'] },
            { $eq: ['$medicineId', '$$medId'] },
            { $gt: ['$quantityRemainingBaseUnits', Long.ZERO] },
            { $gte: ['$expiryDate', today] },
            { $in: ['$status', ['ACTIVE', 'NEAR_EXPIRY']] },
          ] } } },
          { $group: {
            _id: null,
            total: { $sum: { $toDecimal: '$quantityRemainingBaseUnits' } },
          } },
        ],
        as: 'sellableTotals',
      } },
      { $addFields: {
        sellableStockBaseUnits: {
          $ifNull: [{ $arrayElemAt: ['$sellableTotals.total', 0] }, Long.ZERO],
        },
        isSellable: { $and: [
          '$medicine.isActive',
          { $gt: ['$quantityRemainingBaseUnits', Long.ZERO] },
          { $gte: ['$expiryDate', today] },
          { $in: ['$status', ['ACTIVE', 'NEAR_EXPIRY']] },
        ] },
        stockValueCostPaisa: {
          $multiply: [
            { $toDecimal: '$quantityRemainingBaseUnits' },
            { $toDecimal: '$unitCostPaisaPerBaseUnit' },
          ],
        },
      } },
      ...(tabMatch.length ? [{ $match: { $and: tabMatch } }] : []),
      { $sort: { [sortField[options.sort]]: direction, _id: 1 } },
      { $facet: {
        rows: [
          { $skip: (options.page - 1) * options.pageSize },
          { $limit: options.pageSize },
          { $project: {
            _id: 1,
            medicineId: 1,
            supplierId: 1,
            purchaseId: 1,
            purchaseItemId: 1,
            batchNumber: 1,
            expiryDate: 1,
            receivedDate: 1,
            quantityReceivedBaseUnits: 1,
            quantityReturnedBaseUnits: 1,
            quantityRemainingBaseUnits: 1,
            mrpPaisaPerBaseUnit: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            sellableStockBaseUnits: 1,
            isSellable: 1,
            medicineName: '$medicine.name',
            genericName: '$medicine.genericName',
            medicineCode: '$medicine.code',
            barcode: '$medicine.barcode',
            medicineIsActive: '$medicine.isActive',
            minStockAlert: '$medicine.minStockAlert',
            supplierName: '$supplier.name',
            ...(options.canViewCost ? {
              unitCostPaisaPerBaseUnit: 1,
              stockValueCostPaisa: 1,
            } : {}),
          } },
        ],
        count: [{ $count: 'total' }],
      } },
    ];
    const [result] = await this.batchCollection().aggregate<{
      rows: StockListRow[];
      count: Array<{ total: number }>;
    }>(pipeline).toArray();
    return { rows: result?.rows ?? [], total: result?.count[0]?.total ?? 0 };
  }

  async listAdjustments(options: StockLogOptions): Promise<{ rows: StockMovementRow[]; total: number }> {
    const filter: Document = { shopId: options.shopId };
    filter.movementType = { $in: ['ADJUSTMENT', 'WRITE_OFF'] };
    if (options.batchId) filter.batchId = objectId(options.batchId);
    if (options.dateFrom || options.dateTo) {
      const start = options.dateFrom ? dateOnly(options.dateFrom) : new Date(0);
      const end = options.dateTo ? addUtcDays(dateOnly(options.dateTo), 1) : new Date('9999-12-31T00:00:00.000Z');
      filter.createdAt = { $gte: start, $lt: end };
    }
    if (options.reason) filter.reason = new RegExp(`^${options.reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const pipeline: Document[] = [
      { $match: filter },
      { $lookup: {
        from: 'stockBatches',
        let: { batchId: '$batchId', tenantId: '$shopId' },
        pipeline: [{ $match: { $expr: { $and: [
          { $eq: ['$_id', '$$batchId'] },
          { $eq: ['$shopId', '$$tenantId'] },
        ] } } }],
        as: 'batch',
      } },
      { $unwind: '$batch' },
      { $lookup: {
        from: 'medicines',
        let: { medicineId: '$medicineId', tenantId: '$shopId' },
        pipeline: [{ $match: { $expr: { $and: [
          { $eq: ['$_id', '$$medicineId'] },
          { $eq: ['$shopId', '$$tenantId'] },
        ] } } }],
        as: 'medicine',
      } },
      { $unwind: '$medicine' },
      { $lookup: {
        from: 'users',
        let: { actorId: '$actorId', tenantId: '$shopId' },
        pipeline: [{ $match: { $expr: { $and: [
          { $eq: ['$_id', '$$actorId'] },
          { $eq: ['$shopId', '$$tenantId'] },
        ] } } }],
        as: 'actor',
      } },
      { $unwind: { path: '$actor', preserveNullAndEmptyArrays: true } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $facet: {
        rows: [
          { $skip: (options.page - 1) * options.pageSize },
          { $limit: options.pageSize },
          { $project: {
            _id: 1,
            shopId: 1,
            batchId: 1,
            medicineId: 1,
            movementType: 1,
            quantityDeltaBaseUnits: 1,
            referenceType: 1,
            referenceId: 1,
            reason: 1,
            actorId: 1,
            createdAt: 1,
            batchNumber: '$batch.batchNumber',
            medicineName: '$medicine.name',
            genericName: '$medicine.genericName',
            actorName: { $ifNull: ['$actor.fullName', '$actor.username'] },
          } },
        ],
        count: [{ $count: 'total' }],
      } },
    ];
    const [result] = await this.database.collection<StockMovementRecord>('stockMovements')
      .aggregate<{ rows: StockMovementRow[]; count: Array<{ total: number }> }>(pipeline).toArray();
    return { rows: result?.rows ?? [], total: result?.count[0]?.total ?? 0 };
  }

  async adjustStock(
    shopId: ObjectId,
    batchId: ObjectId,
    actor: UserRecord,
    delta: Long,
    reason: string,
    audit: AuditRecord,
  ): Promise<StockBatchRecord | null> {
    const session = this.client.startSession();
    let updated: StockBatchRecord | null = null;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const before = await this.batchCollection().findOne({ _id: batchId, shopId }, { session });
        if (!before) return;
        if (!['ACTIVE', 'NEAR_EXPIRY', 'EXPIRED'].includes(before.status)) throw new Error('BATCH_STATUS_NOT_ADJUSTABLE');
        const nextQty = BigInt(before.quantityRemainingBaseUnits.toString()) + BigInt(delta.toString());
        if (nextQty < 0n || nextQty > maxLong()) throw new Error('INSUFFICIENT_STOCK');
        const nextQuantity = longFromBigInt(nextQty);
        const status = derivedExpiryStatus(before.expiryDate, nextQuantity, utcDate(now));
        const result = await this.batchCollection().updateOne(
          {
            _id: batchId,
            shopId,
            quantityRemainingBaseUnits: before.quantityRemainingBaseUnits,
            status: before.status,
          },
          { $set: { quantityRemainingBaseUnits: nextQuantity, status, updatedAt: now } },
          { session },
        );
        if (result.modifiedCount !== 1) throw new Error('BATCH_CHANGED_CONCURRENTLY');
        const after = { ...before, quantityRemainingBaseUnits: nextQuantity, status, updatedAt: now };
        await this.database.collection<StockMovementRecord>('stockMovements').insertOne({
          _id: new ObjectId(),
          shopId,
          batchId,
          medicineId: before.medicineId,
          movementType: 'ADJUSTMENT',
          quantityDeltaBaseUnits: delta,
          referenceType: 'STOCK_ADJUSTMENT',
          referenceId: batchId,
          reason: reason.trim(),
          actorId: actor._id,
          createdAt: now,
        }, { session });
        await this.database.collection<AuditRecord>('auditLogs').insertOne({
          ...audit,
          event: 'stock.adjusted',
          entityType: 'stock_batch',
          entityId: batchId,
          before: { quantityRemainingBaseUnits: before.quantityRemainingBaseUnits.toString(), status: before.status },
          after: { quantityRemainingBaseUnits: nextQuantity.toString(), status },
          occurredAt: now,
        }, { session });
        updated = after;
      });
      return updated;
    } finally {
      await session.endSession();
    }
  }

  async writeOffExpired(
    shopId: ObjectId,
    batchId: ObjectId,
    actor: UserRecord,
    audit: AuditRecord,
  ): Promise<{ before: Long; batch: StockBatchRecord } | null> {
    const session = this.client.startSession();
    let outcome: { before: Long; batch: StockBatchRecord } | null = null;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const today = utcDate(now);
        const before = await this.batchCollection().findOne({ _id: batchId, shopId }, { session });
        if (!before) return;
        if (utcDate(before.expiryDate) >= today) throw new Error('BATCH_NOT_EXPIRED');
        if (before.quantityRemainingBaseUnits.lessThanOrEqual(Long.ZERO)) throw new Error('BATCH_HAS_NO_REMAINING_STOCK');
        const update = await this.batchCollection().updateOne(
          { _id: batchId, shopId, quantityRemainingBaseUnits: before.quantityRemainingBaseUnits },
          { $set: { quantityRemainingBaseUnits: Long.ZERO, status: 'SOLD_OUT', updatedAt: now } },
          { session },
        );
        if (update.modifiedCount !== 1) throw new Error('BATCH_CHANGED_CONCURRENTLY');
        await this.database.collection<StockMovementRecord>('stockMovements').insertOne({
          _id: new ObjectId(),
          shopId,
          batchId,
          medicineId: before.medicineId,
          movementType: 'WRITE_OFF',
          quantityDeltaBaseUnits: Long.fromString(`-${before.quantityRemainingBaseUnits.toString()}`),
          referenceType: 'STOCK_WRITE_OFF',
          referenceId: batchId,
          reason: 'expired',
          actorId: actor._id,
          createdAt: now,
        }, { session });
        await this.database.collection<AuditRecord>('auditLogs').insertOne({
          ...audit,
          event: 'stock_batch.write_off',
          entityType: 'stock_batch',
          entityId: batchId,
          before: {
            quantityRemainingBaseUnits: before.quantityRemainingBaseUnits.toString(),
            expiryDate: before.expiryDate.toISOString(),
          },
          after: { quantityRemainingBaseUnits: '0', status: 'SOLD_OUT', reason: 'expired' },
          occurredAt: now,
        }, { session });
        outcome = {
          before: before.quantityRemainingBaseUnits,
          batch: { ...before, quantityRemainingBaseUnits: Long.ZERO, status: 'SOLD_OUT', updatedAt: now },
        };
      });
      return outcome;
    } finally {
      await session.endSession();
    }
  }

  async refreshStatuses(shopId: ObjectId, today = utcDate(new Date())): Promise<void> {
    const batches = this.batchCollection();
    const activeExpiryStatuses = { $in: ['ACTIVE', 'NEAR_EXPIRY'] as const };
    await batches.updateMany(
      { shopId, status: activeExpiryStatuses, quantityRemainingBaseUnits: { $lte: Long.ZERO } },
      { $set: { status: 'SOLD_OUT', updatedAt: new Date() } },
    );
    await batches.updateMany(
      {
        shopId,
        status: activeExpiryStatuses,
        quantityRemainingBaseUnits: { $gt: Long.ZERO },
        expiryDate: { $lt: today },
      },
      { $set: { status: 'EXPIRED', updatedAt: new Date() } },
    );
    await batches.updateMany(
      {
        shopId,
        status: activeExpiryStatuses,
        quantityRemainingBaseUnits: { $gt: Long.ZERO },
        expiryDate: { $gte: today, $lte: addUtcDays(today, 90) },
      },
      { $set: { status: 'NEAR_EXPIRY', updatedAt: new Date() } },
    );
    await batches.updateMany(
      {
        shopId,
        status: 'NEAR_EXPIRY',
        quantityRemainingBaseUnits: { $gt: Long.ZERO },
        expiryDate: { $gt: addUtcDays(today, 90) },
      },
      { $set: { status: 'ACTIVE', updatedAt: new Date() } },
    );
  }
}
