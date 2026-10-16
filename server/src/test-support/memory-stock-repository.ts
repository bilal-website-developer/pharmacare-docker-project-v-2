import { Long, ObjectId } from 'mongodb';
import type { AuditRecord, UserRecord } from '../models.js';
import {
  addUtcDays,
  dateOnly,
  derivedExpiryStatus,
  longFromBigInt,
  objectId,
  roundDividePositive,
  utcDate,
  type PostPurchaseInput,
  type PurchaseRecord,
  type StockBatchRecord,
  type StockListRow,
  type StockMovementRecord,
  type StockMovementRow,
} from '../stock-domain.js';
import type {
  ExpiryBucket,
  PurchaseListOptions,
  PurchaseSummary,
  PurchaseSummaryOptions,
  StockListOptions,
  StockLogOptions,
  StockRepository,
  StockStats,
  StockAlertsSummary,
} from '../stock-repository.js';

interface MemoryState {
  purchases: Map<string, PurchaseRecord>;
  batches: Map<string, StockBatchRecord>;
  movements: StockMovementRecord[];
  supplierLedger: Array<Record<string, unknown>>;
  audits: AuditRecord[];
  supplierBalances: Map<string, bigint>;
  purchaseNumbers: Map<string, number>;
}

function initialState(): MemoryState {
  return {
    purchases: new Map(),
    batches: new Map(),
    movements: [],
    supplierLedger: [],
    audits: [],
    supplierBalances: new Map(),
    purchaseNumbers: new Map(),
  };
}

function recordCopy<T extends object>(value: T): T {
  return { ...value };
}

function withinPage<T>(rows: T[], page: number, pageSize: number): T[] {
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

export class MemoryStockRepository implements StockRepository {
  private state = initialState();
  readonly medicines: Array<Record<string, unknown>> = [];
  readonly units: Array<Record<string, unknown>> = [];
  readonly suppliers: Array<Record<string, unknown>> = [];
  failNextPurchaseAt: 'afterPurchase' | 'afterBatches' | 'afterMovements' | 'afterSupplierLedger' | null = null;
  private purchaseSerial = Promise.resolve();

  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const current = this.purchaseSerial;
    this.purchaseSerial = new Promise<void>((resolve) => { release = resolve; });
    await current;
    const previous = this.state;
    this.state = {
      purchases: new Map(previous.purchases),
      batches: new Map(previous.batches),
      movements: [...previous.movements],
      supplierLedger: [...previous.supplierLedger],
      audits: [...previous.audits],
      supplierBalances: new Map(previous.supplierBalances),
      purchaseNumbers: new Map(previous.purchaseNumbers),
    };
    try {
      return await operation();
    } catch (error) {
      this.state = previous;
      throw error;
    } finally {
      release();
    }
  }

  async activePurchaseCatalog(shopId: ObjectId, canViewCost: boolean): Promise<{
    items: Record<string, unknown>[];
    suppliers: Array<{ id: string; name: string; contact: string }>;
  }> {
    const items = this.medicines.filter((medicine) =>
      (medicine.shopId as ObjectId).equals(shopId) && medicine.isActive === true,
    ).map((medicine) => ({
      id: (medicine._id as ObjectId).toHexString(),
      code: medicine.code,
      name: medicine.name,
      stockBaseUnits: [...this.state.batches.values()]
        .filter((batch) => batch.shopId.equals(shopId) && batch.medicineId.equals(medicine._id as ObjectId))
        .reduce((sum, batch) => sum + BigInt(batch.quantityRemainingBaseUnits.toString()), 0n).toString(),
      units: this.units.filter((unit) =>
        (unit.shopId as ObjectId).equals(shopId) && (unit.medicineId as ObjectId).equals(medicine._id as ObjectId),
      ).map((unit) => ({ id: (unit._id as ObjectId).toHexString(), name: unit.name })),
      ...(canViewCost && medicine.lastCostPaisaPerBaseUnit !== undefined
        ? { lastCostPaisaPerBaseUnit: String(medicine.lastCostPaisaPerBaseUnit) }
        : {}),
    }));
    const suppliers = this.suppliers.filter((supplier) =>
      (supplier.shopId as ObjectId).equals(shopId) && supplier.isActive === true,
    ).map((supplier) => ({
      id: (supplier._id as ObjectId).toHexString(),
      name: String(supplier.name),
      contact: String(supplier.contact ?? ''),
    }));
    return { items, suppliers };
  }

  async stockAlertsSummary(shopId: ObjectId, limit: number, today: Date): Promise<StockAlertsSummary> {
    const alerts = this.medicines.filter((medicine) =>
      (medicine.shopId as ObjectId).equals(shopId) && medicine.isActive === true,
    ).flatMap((medicine) => {
      const id = medicine._id as ObjectId;
      const stock = [...this.state.batches.values()].filter((batch) =>
        batch.shopId.equals(shopId)
        && batch.medicineId.equals(id)
        && batch.quantityRemainingBaseUnits.greaterThan(Long.ZERO)
        && utcDate(batch.expiryDate) >= today
        && ['ACTIVE', 'NEAR_EXPIRY'].includes(batch.status),
      ).reduce((sum, batch) => sum + BigInt(batch.quantityRemainingBaseUnits.toString()), 0n);
      const minStockAlert = Number(medicine.minStockAlert ?? 0);
      if (minStockAlert <= 0 || stock > BigInt(minStockAlert)) return [];
      return [{
        medicineId: id.toHexString(),
        name: String(medicine.name),
        strength: typeof medicine.strength === 'string' ? medicine.strength : null,
        genericName: String(medicine.genericName ?? ''),
        stockBaseUnits: stock.toString(),
        minStockAlert,
        kind: stock === 0n ? 'out' as const : 'low' as const,
      }];
    }).sort((left, right) => {
      const outOrder = Number(right.kind === 'out') - Number(left.kind === 'out');
      if (outOrder) return outOrder;
      const leftGap = BigInt(left.minStockAlert) - BigInt(left.stockBaseUnits);
      const rightGap = BigInt(right.minStockAlert) - BigInt(right.stockBaseUnits);
      if (leftGap !== rightGap) return leftGap > rightGap ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return {
      lowCount: alerts.filter((item) => item.kind === 'low').length,
      outCount: alerts.filter((item) => item.kind === 'out').length,
      generatedAt: new Date().toISOString(),
      items: alerts.slice(0, limit),
    };
  }

  async postPurchase(input: PostPurchaseInput, actor: UserRecord, audit: AuditRecord, today: Date): Promise<PurchaseRecord> {
    return this.transaction(async () => {
      const now = new Date();
      const purchaseDate = input.purchaseDate ? dateOnly(input.purchaseDate) : today;
      const supplierId = objectId(input.supplierId);
      const supplier = this.suppliers.find((record) =>
        (record._id as ObjectId).equals(supplierId)
        && (record.shopId as ObjectId).equals(actor.shopId)
        && record.isActive === true,
      );
      if (!supplier) throw new Error('ACTIVE_SUPPLIER_REQUIRED');
      if (input.items.some((item) => dateOnly(item.expiryDate) <= purchaseDate)) {
        throw new Error('EXPIRY_NOT_AFTER_PURCHASE_DATE');
      }
      const numberKey = actor.shopId.toHexString();
      const sequence = (this.state.purchaseNumbers.get(numberKey) ?? 0) + 1;
      this.state.purchaseNumbers.set(numberKey, sequence);
      const purchaseId = new ObjectId();
      const items: PurchaseRecord['items'] = [];
      const batches: StockBatchRecord[] = [];
      let subtotal = 0n;
      for (const inputItem of input.items) {
        const medicineId = objectId(inputItem.medicineId);
        const unitId = objectId(inputItem.unitId);
        const medicine = this.medicines.find((record) =>
          (record._id as ObjectId).equals(medicineId)
          && (record.shopId as ObjectId).equals(actor.shopId)
          && record.isActive === true,
        );
        const unit = this.units.find((record) =>
          (record._id as ObjectId).equals(unitId)
          && (record.shopId as ObjectId).equals(actor.shopId)
          && (record.medicineId as ObjectId).equals(medicineId),
        );
        if (!medicine || !unit) throw new Error('ACTIVE_MEDICINE_AND_UNIT_REQUIRED');
        const factor = Number(unit.conversionFactorBaseUnits);
        const qtyBase = BigInt(inputItem.quantity + inputItem.bonusQuantity) * BigInt(factor);
        if (qtyBase > 2_147_483_647n) throw new Error('QUANTITY_LIMIT_EXCEEDED');
        const cost = BigInt(inputItem.unitCostPaisa);
        const mrp = BigInt(inputItem.mrpPaisa);
        const lineTotal = BigInt(inputItem.quantity) * cost;
        subtotal += lineTotal;
        const itemId = new ObjectId();
        const batchId = new ObjectId();
        const qty = longFromBigInt(qtyBase);
        const expiryDate = dateOnly(inputItem.expiryDate);
        items.push({
          purchaseItemId: itemId,
          medicineId,
          medicineNameSnapshot: String(medicine.name),
          medicineCodeSnapshot: String(medicine.code),
          unitId,
          unitNameSnapshot: String(unit.name),
          conversionFactorBaseUnits: factor,
          quantityInUnits: inputItem.quantity,
          bonusQuantityBaseUnits: longFromBigInt(BigInt(inputItem.bonusQuantity) * BigInt(factor)),
          quantityReceivedBaseUnits: qty,
          unitCostPaisa: longFromBigInt(cost),
          mrpPaisa: longFromBigInt(mrp),
          lineTotalPaisa: longFromBigInt(lineTotal),
          batchId,
          batchNumber: inputItem.batchNumber,
          expiryDate,
        });
        batches.push({
          _id: batchId,
          shopId: actor.shopId,
          medicineId,
          supplierId,
          purchaseId,
          purchaseItemId: itemId,
          batchNumber: inputItem.batchNumber,
          expiryDate,
          receivedDate: purchaseDate,
          quantityReceivedBaseUnits: qty,
          quantityReturnedBaseUnits: Long.ZERO,
          quantityRemainingBaseUnits: qty,
          unitCostPaisaPerBaseUnit: longFromBigInt(roundDividePositive(cost, BigInt(factor))),
          mrpPaisaPerBaseUnit: longFromBigInt(roundDividePositive(mrp, BigInt(factor))),
          status: derivedExpiryStatus(expiryDate, qty, today),
          createdAt: now,
          updatedAt: now,
        });
      }
      const discount = BigInt(input.discountPaisa);
      if (discount > subtotal) throw new Error('DISCOUNT_EXCEEDS_SUBTOTAL');
      const total = subtotal - discount;
      const paid = input.paymentType === 'cash' ? total : 0n;
      const balanceDelta = total - paid;
      const purchase: PurchaseRecord = {
        _id: purchaseId,
        shopId: actor.shopId,
        purchaseNumber: `PR-${String(sequence).padStart(6, '0')}`,
        supplierId,
        supplierNameSnapshot: String(supplier.name),
        invoiceNumber: input.invoiceNumber,
        purchaseDate,
        status: 'posted',
        paymentType: input.paymentType,
        subtotalPaisa: longFromBigInt(subtotal),
        discountPaisa: longFromBigInt(discount),
        totalPaisa: longFromBigInt(total),
        paidPaisa: longFromBigInt(paid),
        notes: input.notes,
        items,
        createdBy: actor._id,
        createdAt: now,
      };
      this.state.purchases.set(purchaseId.toHexString(), purchase);
      this.fail('afterPurchase');
      for (const batch of batches) this.state.batches.set(batch._id.toHexString(), batch);
      this.fail('afterBatches');
      for (const batch of batches) this.state.movements.push({
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
      this.fail('afterMovements');
      const balance = (this.state.supplierBalances.get(supplierId.toHexString()) ?? 0n) + balanceDelta;
      this.state.supplierBalances.set(supplierId.toHexString(), balance);
      this.state.supplierLedger.push({
        shopId: actor.shopId, supplierId, referenceType: 'PURCHASE', referenceId: purchaseId,
        debitPaisa: longFromBigInt(paid), creditPaisa: longFromBigInt(total),
        balanceAfterPaisa: longFromBigInt(balance), actorId: actor._id, createdAt: now,
      });
      this.fail('afterSupplierLedger');
      this.state.audits.push({
        ...audit, event: 'purchase.posted', entityType: 'purchase', entityId: purchaseId,
        after: { purchaseNumber: purchase.purchaseNumber, totalPaisa: total.toString() },
      });
      return purchase;
    });
  }

  private fail(stage: NonNullable<MemoryStockRepository['failNextPurchaseAt']>): void {
    if (this.failNextPurchaseAt === stage) {
      this.failNextPurchaseAt = null;
      throw new Error(`SIMULATED_FAILURE_${stage}`);
    }
  }

  async voidPurchase(
    shopId: ObjectId,
    purchaseId: ObjectId,
    actor: UserRecord,
    reason: string,
    audit: AuditRecord,
  ): Promise<PurchaseRecord | null> {
    return this.transaction(async () => {
      const purchase = this.state.purchases.get(purchaseId.toHexString());
      if (!purchase || !purchase.shopId.equals(shopId) || purchase.status !== 'posted') return null;
      const batches = purchase.items.map((item) => this.state.batches.get(item.batchId.toHexString()));
      if (batches.some((batch) => !batch || !batch.shopId.equals(shopId)
        || !batch.quantityRemainingBaseUnits.equals(batch.quantityReceivedBaseUnits)
        || this.state.movements.some((movement) => movement.batchId.equals(batch._id)
          && movement.movementType !== 'RECEIPT'))) {
        throw new Error('PURCHASE_STOCK_ALREADY_CHANGED');
      }
      const now = new Date();
      for (const batch of batches) {
        if (!batch) throw new Error('PURCHASE_BATCH_REFERENCES_INCOMPLETE');
        const returned: StockBatchRecord = {
          ...batch,
          quantityRemainingBaseUnits: Long.ZERO,
          status: 'RETURNED',
          updatedAt: now,
        };
        this.state.batches.set(batch._id.toHexString(), returned);
        this.state.movements.push({
          _id: new ObjectId(), shopId, batchId: batch._id, medicineId: batch.medicineId,
          movementType: 'PURCHASE_RETURN',
          quantityDeltaBaseUnits: Long.fromString(`-${batch.quantityRemainingBaseUnits.toString()}`),
          referenceType: 'PURCHASE_VOID', referenceId: purchaseId, reason,
          actorId: actor._id, createdAt: now,
        });
      }
      const oldLedger = this.state.supplierLedger.find((entry) =>
        (entry.referenceId as ObjectId).equals(purchaseId) && entry.referenceType === 'PURCHASE',
      );
      if (!oldLedger) throw new Error('PURCHASE_SUPPLIER_LEDGER_MISSING');
      const debit = BigInt((oldLedger.debitPaisa as Long).toString());
      const credit = BigInt((oldLedger.creditPaisa as Long).toString());
      const net = credit - debit;
      const balance = (this.state.supplierBalances.get(purchase.supplierId.toHexString()) ?? 0n) - net;
      if (balance < 0n) throw new Error('SUPPLIER_BALANCE_RECONCILIATION_FAILED');
      this.state.supplierBalances.set(purchase.supplierId.toHexString(), balance);
      this.state.supplierLedger.push({
        shopId, supplierId: purchase.supplierId, referenceType: 'PURCHASE_VOID',
        referenceId: purchaseId, debitPaisa: longFromBigInt(credit), creditPaisa: longFromBigInt(debit),
        balanceAfterPaisa: longFromBigInt(balance), actorId: actor._id, createdAt: now, note: reason,
      });
      const after: PurchaseRecord = {
        ...purchase, status: 'void', voidReason: reason, voidedAt: now, voidedBy: actor._id,
      };
      this.state.purchases.set(purchaseId.toHexString(), after);
      this.state.audits.push({
        ...audit, event: 'purchase.voided', entityType: 'purchase', entityId: purchaseId,
        before: { status: purchase.status }, after: { status: 'void', reason },
      });
      return after;
    });
  }

  async listPurchases(options: PurchaseListOptions): Promise<{ rows: PurchaseRecord[]; total: number }> {
    const search = options.search?.toLocaleLowerCase('en-US');
    const rows = [...this.state.purchases.values()].filter((purchase) =>
      purchase.shopId.equals(options.shopId)
      && (!options.paymentType || purchase.paymentType === options.paymentType)
      && (!options.status || purchase.status === options.status)
      && (!options.dateFrom || purchase.purchaseDate >= dateOnly(options.dateFrom))
      && (!options.dateTo || purchase.purchaseDate < addUtcDays(dateOnly(options.dateTo), 1))
      && (!search || `${purchase.purchaseNumber} ${purchase.invoiceNumber} ${purchase.supplierNameSnapshot}`
        .toLocaleLowerCase('en-US').includes(search)),
    ).sort((left, right) => right.purchaseDate.getTime() - left.purchaseDate.getTime()
      || right._id.toHexString().localeCompare(left._id.toHexString()));
    return { rows: withinPage(rows, options.page, options.pageSize), total: rows.length };
  }

  async purchaseSummary(options: PurchaseSummaryOptions): Promise<PurchaseSummary> {
    const search = options.search?.toLocaleLowerCase('en-US');
    const rows = [...this.state.purchases.values()].filter((purchase) =>
      purchase.shopId.equals(options.shopId)
      && (!options.paymentType || purchase.paymentType === options.paymentType)
      && (!options.status || purchase.status === options.status)
      && (!options.dateFrom || purchase.purchaseDate >= dateOnly(options.dateFrom))
      && (!options.dateTo || purchase.purchaseDate < addUtcDays(dateOnly(options.dateTo), 1))
      && (!search || `${purchase.purchaseNumber} ${purchase.invoiceNumber} ${purchase.supplierNameSnapshot}`
        .toLocaleLowerCase('en-US').includes(search)),
    );
    const cash = rows.filter((purchase) => purchase.paymentType === 'cash');
    const credit = rows.filter((purchase) => purchase.paymentType === 'credit');
    const sum = (items: PurchaseRecord[]) => items.reduce(
      (total, purchase) => total + BigInt(purchase.totalPaisa.toString()),
      0n,
    ).toString();
    return {
      totalPaisa: sum(rows),
      cashPaisa: sum(cash),
      cashCount: cash.length,
      creditPaisa: sum(credit),
      creditCount: credit.length,
    };
  }

  async getPurchase(shopId: ObjectId, purchaseId: ObjectId): Promise<PurchaseRecord | null> {
    const purchase = this.state.purchases.get(purchaseId.toHexString());
    return purchase?.shopId.equals(shopId) ? purchase : null;
  }

  async stockStats(shopId: ObjectId, canViewCost: boolean, today: Date): Promise<StockStats> {
    const near30 = addUtcDays(today, 30);
    const activeMedicineIds = new Set(this.medicines.filter((medicine) =>
      (medicine.shopId as ObjectId).equals(shopId) && medicine.isActive === true,
    ).map((medicine) => (medicine._id as ObjectId).toHexString()));
    let cost = 0n;
    let mrp = 0n;
    let expiredCost = 0n;
    let expiring30 = 0;
    let expiredBatches = 0;
    for (const batch of this.state.batches.values()) {
      if (!batch.shopId.equals(shopId) || batch.quantityRemainingBaseUnits.lessThanOrEqual(Long.ZERO)) continue;
      const qty = BigInt(batch.quantityRemainingBaseUnits.toString());
      const expiry = utcDate(batch.expiryDate);
      const expired = expiry < today;
      const sellable = activeMedicineIds.has(batch.medicineId.toHexString())
        && expiry >= today && ['ACTIVE', 'NEAR_EXPIRY'].includes(batch.status);
      if (sellable) {
        mrp += qty * BigInt(batch.mrpPaisaPerBaseUnit.toString());
        if (canViewCost) cost += qty * BigInt(batch.unitCostPaisaPerBaseUnit.toString());
        if (expiry <= near30) expiring30 += 1;
      }
      if (expired) {
        expiredBatches += 1;
        if (canViewCost) expiredCost += qty * BigInt(batch.unitCostPaisaPerBaseUnit.toString());
      }
    }
    return {
      stockValueMrpPaisa: longFromBigInt(mrp).toString(),
      expiring30,
      expiredBatches,
      ...(canViewCost ? {
        stockValueCostPaisa: longFromBigInt(cost).toString(),
        expiredValueAtRiskPaisa: longFromBigInt(expiredCost).toString(),
      } : {}),
    };
  }

  async expiryBuckets(shopId: ObjectId, today: Date): Promise<ExpiryBucket[]> {
    const [d30, d60, d90] = [30, 60, 90].map((days) => addUtcDays(today, days));
    const activeIds = new Set(this.medicines.filter((medicine) =>
      (medicine.shopId as ObjectId).equals(shopId) && medicine.isActive === true,
    ).map((medicine) => (medicine._id as ObjectId).toHexString()));
    const groups = new Map<ExpiryBucket['key'], { count: number; quantity: bigint }>(
      (['expired', '0-30', '31-60', '61-90', '90+'] as const)
        .map((key) => [key, { count: 0, quantity: 0n }]),
    );
    for (const batch of this.state.batches.values()) {
      if (!batch.shopId.equals(shopId) || batch.quantityRemainingBaseUnits.lessThanOrEqual(Long.ZERO)) continue;
      const expiry = utcDate(batch.expiryDate);
      let key: ExpiryBucket['key'] | undefined;
      if (expiry < today) key = 'expired';
      else if (activeIds.has(batch.medicineId.toHexString()) && ['ACTIVE', 'NEAR_EXPIRY'].includes(batch.status)) {
        if (expiry <= d30!) key = '0-30';
        else if (expiry <= d60!) key = '31-60';
        else if (expiry <= d90!) key = '61-90';
        else key = '90+';
      }
      if (key) {
        const group = groups.get(key)!;
        group.count += 1;
        group.quantity += BigInt(batch.quantityRemainingBaseUnits.toString());
      }
    }
    const labels: Record<ExpiryBucket['key'], string> = {
      expired: 'Expired', '0-30': '0-30 days', '31-60': '31-60 days',
      '61-90': '61-90 days', '90+': '90+ days',
    };
    return [...groups].map(([key, group]) => ({
      key, label: labels[key], count: group.count,
      quantityRemainingBaseUnits: longFromBigInt(group.quantity).toString(),
    }));
  }

  async listStock(options: StockListOptions, today: Date): Promise<{ rows: StockListRow[]; total: number }> {
    const medicineMap = new Map(this.medicines.filter((medicine) =>
      (medicine.shopId as ObjectId).equals(options.shopId),
    ).map((medicine) => [(medicine._id as ObjectId).toHexString(), medicine]));
    const supplierMap = new Map(this.suppliers.filter((supplier) =>
      (supplier.shopId as ObjectId).equals(options.shopId),
    ).map((supplier) => [(supplier._id as ObjectId).toHexString(), supplier]));
    const rows: StockListRow[] = [];
    for (const batch of this.state.batches.values()) {
      const medicine = medicineMap.get(batch.medicineId.toHexString());
      if (!batch.shopId.equals(options.shopId) || !medicine) continue;
      const search = options.search?.toLocaleLowerCase('en-US');
      if (options.medicineId && !batch.medicineId.equals(objectId(options.medicineId))) continue;
      if (search && !`${batch.batchNumber} ${medicine.name} ${medicine.genericName ?? ''} ${medicine.code} ${medicine.barcode ?? ''}`
        .toLocaleLowerCase('en-US').includes(search)) continue;
      const expiry = utcDate(batch.expiryDate);
      const qty = batch.quantityRemainingBaseUnits;
      const active = medicine.isActive === true;
      const statusEligible = ['ACTIVE', 'NEAR_EXPIRY'].includes(batch.status);
      const isSellable = active && qty.greaterThan(Long.ZERO) && expiry >= today && statusEligible;
      if (options.tab === 'near-expiry' && !(isSellable && expiry <= addUtcDays(today, 90))) continue;
      if (options.tab === 'expired' && !(qty.greaterThan(Long.ZERO) && expiry < today)) continue;
      const sellableStock = [...this.state.batches.values()].filter((candidate) =>
        candidate.shopId.equals(options.shopId)
        && candidate.medicineId.equals(batch.medicineId)
        && candidate.quantityRemainingBaseUnits.greaterThan(Long.ZERO)
        && utcDate(candidate.expiryDate) >= today
        && ['ACTIVE', 'NEAR_EXPIRY'].includes(candidate.status),
      ).reduce((sum, candidate) => sum + BigInt(candidate.quantityRemainingBaseUnits.toString()), 0n);
      const threshold = Number(medicine.minStockAlert ?? 0);
      if (options.tab === 'low-stock' && !(active && threshold > 0 && sellableStock > 0n && sellableStock <= BigInt(threshold))) continue;
      if (options.tab === 'all' && qty.lessThanOrEqual(Long.ZERO) && !search && !options.medicineId) continue;
      if (options.expiryBucket === 'expired' && !(qty.greaterThan(Long.ZERO) && expiry < today)) continue;
      if (options.expiryBucket && options.expiryBucket !== 'expired') {
        const lower = options.expiryBucket === '0-30' ? today
          : options.expiryBucket === '31-60' ? addUtcDays(today, 30)
            : options.expiryBucket === '61-90' ? addUtcDays(today, 60) : addUtcDays(today, 90);
        const upper = options.expiryBucket === '0-30' ? addUtcDays(today, 30)
          : options.expiryBucket === '31-60' ? addUtcDays(today, 60)
            : options.expiryBucket === '61-90' ? addUtcDays(today, 90) : null;
        if (!(active && statusEligible && qty.greaterThan(Long.ZERO)
          && (options.expiryBucket === '0-30' ? expiry >= lower : expiry > lower)
          && (upper === null || expiry <= upper))) continue;
      }
      rows.push({
        ...recordCopy(batch),
        ...(!options.canViewCost ? { unitCostPaisaPerBaseUnit: undefined } : {}),
        medicineName: String(medicine.name),
        genericName: String(medicine.genericName ?? ''),
        medicineCode: String(medicine.code ?? ''),
        barcode: String(medicine.barcode ?? ''),
        medicineIsActive: active,
        minStockAlert: threshold,
        supplierName: String(supplierMap.get(batch.supplierId.toHexString())?.name ?? ''),
        sellableStockBaseUnits: longFromBigInt(sellableStock),
        isSellable,
      });
    }
    if (options.sort.startsWith('cost_') || options.sort.startsWith('value_')) {
      if (!options.canViewCost) throw new Error('COST_SORT_FORBIDDEN');
      rows.sort((a, b) => {
        const left = BigInt((options.sort.startsWith('cost_') ? a.unitCostPaisaPerBaseUnit : a.quantityRemainingBaseUnits).toString());
        const right = BigInt((options.sort.startsWith('cost_') ? b.unitCostPaisaPerBaseUnit : b.quantityRemainingBaseUnits).toString());
        const result = left < right ? -1 : left > right ? 1 : 0;
        return options.sort.endsWith('_desc') ? -result : result;
      });
    } else {
      const sortKey = options.sort.split('_')[0]!;
      rows.sort((left, right) => {
        const result = sortKey === 'medicine'
          ? left.medicineName.localeCompare(right.medicineName)
          : sortKey === 'batch'
            ? left.batchNumber.localeCompare(right.batchNumber)
            : sortKey === 'quantity'
              ? BigInt(left.quantityRemainingBaseUnits.toString()) < BigInt(right.quantityRemainingBaseUnits.toString()) ? -1 : 1
              : left.expiryDate.getTime() - right.expiryDate.getTime();
        return options.sort.endsWith('_desc') ? -result : result;
      });
    }
    return { rows: withinPage(rows, options.page, options.pageSize), total: rows.length };
  }

  async listAdjustments(options: StockLogOptions): Promise<{ rows: StockMovementRow[]; total: number }> {
    const batches = new Map([...this.state.batches.values()].map((batch) => [batch._id.toHexString(), batch]));
    const medicines = new Map(this.medicines.map((medicine) => [(medicine._id as ObjectId).toHexString(), medicine]));
    const filtered = this.state.movements.filter((movement) => {
      if (!movement.shopId.equals(options.shopId)) return false;
      if (options.batchId ? !movement.batchId.equals(objectId(options.batchId))
        : !['ADJUSTMENT', 'WRITE_OFF'].includes(movement.movementType)) return false;
      if (options.dateFrom && movement.createdAt < dateOnly(options.dateFrom)) return false;
      if (options.dateTo && movement.createdAt >= addUtcDays(dateOnly(options.dateTo), 1)) return false;
      return !options.reason || movement.reason.toLocaleLowerCase('en-US') === options.reason.toLocaleLowerCase('en-US');
    }).flatMap((movement) => {
      const batch = batches.get(movement.batchId.toHexString());
      const medicine = medicines.get(movement.medicineId.toHexString());
      return batch && medicine && (medicine.shopId as ObjectId).equals(options.shopId)
        ? [{
          ...movement,
          batchNumber: batch.batchNumber,
          medicineName: String(medicine.name),
          genericName: String(medicine.genericName ?? ''),
          actorName: 'Test User',
        }]
        : [];
    }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { rows: withinPage(filtered, options.page, options.pageSize), total: filtered.length };
  }

  async adjustStock(
    shopId: ObjectId,
    batchId: ObjectId,
    actor: UserRecord,
    delta: Long,
    reason: string,
    audit: AuditRecord,
    today: Date,
  ): Promise<StockBatchRecord | null> {
    return this.transaction(async () => {
      const before = this.state.batches.get(batchId.toHexString());
      if (!before || !before.shopId.equals(shopId)) return null;
      if (!['ACTIVE', 'NEAR_EXPIRY', 'EXPIRED'].includes(before.status)) throw new Error('BATCH_STATUS_NOT_ADJUSTABLE');
      const nextValue = BigInt(before.quantityRemainingBaseUnits.toString()) + BigInt(delta.toString());
      if (nextValue < 0n) throw new Error('INSUFFICIENT_STOCK');
      const now = new Date();
      const after = {
        ...before,
        quantityRemainingBaseUnits: longFromBigInt(nextValue),
        status: derivedExpiryStatus(before.expiryDate, longFromBigInt(nextValue), today),
        updatedAt: now,
      };
      this.state.batches.set(batchId.toHexString(), after);
      this.state.movements.push({
        _id: new ObjectId(), shopId, batchId, medicineId: before.medicineId,
        movementType: 'ADJUSTMENT', quantityDeltaBaseUnits: delta,
        referenceType: 'STOCK_ADJUSTMENT', referenceId: batchId,
        reason, actorId: actor._id, createdAt: now,
      });
      this.state.audits.push({
        ...audit, event: 'stock.adjusted', entityType: 'stock_batch', entityId: batchId,
        before: { quantityRemainingBaseUnits: before.quantityRemainingBaseUnits.toString() },
        after: { quantityRemainingBaseUnits: after.quantityRemainingBaseUnits.toString() },
      });
      return after;
    });
  }

  async writeOffExpired(
    shopId: ObjectId,
    batchId: ObjectId,
    actor: UserRecord,
    audit: AuditRecord,
    today: Date,
  ): Promise<{ before: Long; batch: StockBatchRecord } | null> {
    return this.transaction(async () => {
      const before = this.state.batches.get(batchId.toHexString());
      if (!before || !before.shopId.equals(shopId)) return null;
      const now = new Date();
      if (utcDate(before.expiryDate) >= today) throw new Error('BATCH_NOT_EXPIRED');
      if (before.quantityRemainingBaseUnits.lessThanOrEqual(Long.ZERO)) throw new Error('BATCH_HAS_NO_REMAINING_STOCK');
      const batch = { ...before, quantityRemainingBaseUnits: Long.ZERO, status: 'SOLD_OUT' as const, updatedAt: now };
      this.state.batches.set(batchId.toHexString(), batch);
      this.state.movements.push({
        _id: new ObjectId(), shopId, batchId, medicineId: before.medicineId,
        movementType: 'WRITE_OFF',
        quantityDeltaBaseUnits: Long.fromString(`-${before.quantityRemainingBaseUnits.toString()}`),
        referenceType: 'STOCK_WRITE_OFF', referenceId: batchId, reason: 'expired',
        actorId: actor._id, createdAt: now,
      });
      this.state.audits.push({
        ...audit, event: 'stock_batch.write_off', entityType: 'stock_batch', entityId: batchId,
        before: { quantityRemainingBaseUnits: before.quantityRemainingBaseUnits.toString() },
        after: { quantityRemainingBaseUnits: '0', reason: 'expired' },
      });
      return { before: before.quantityRemainingBaseUnits, batch };
    });
  }

  async refreshStatuses(shopId: ObjectId, today: Date): Promise<void> {
    for (const [id, batch] of this.state.batches) {
      if (!batch.shopId.equals(shopId) || !['ACTIVE', 'NEAR_EXPIRY'].includes(batch.status)) continue;
      const status = derivedExpiryStatus(batch.expiryDate, batch.quantityRemainingBaseUnits, today);
      this.state.batches.set(id, { ...batch, status, updatedAt: new Date() });
    }
  }

  seedSupplier(shopId: ObjectId, name = 'Test Supplier'): ObjectId {
    const id = new ObjectId();
    this.suppliers.push({ _id: id, shopId, name, isActive: true });
    this.state.supplierBalances.set(id.toHexString(), 0n);
    return id;
  }

  seedMedicine(shopId: ObjectId, name = 'Test Medicine', factor = 1): { medicineId: ObjectId; unitId: ObjectId } {
    const medicineId = new ObjectId();
    const unitId = new ObjectId();
    this.medicines.push({
      _id: medicineId, shopId, name, code: 'TEST-001', genericName: 'Generic',
      isActive: true, minStockAlert: 5, lastCostPaisaPerBaseUnit: '25',
    });
    this.units.push({
      _id: unitId, shopId, medicineId, name: 'Tablet',
      conversionFactorBaseUnits: factor, isDefaultSaleUnit: true, pricePaisa: Long.fromInt(100),
    });
    return { medicineId, unitId };
  }

  seedBatch(batch: StockBatchRecord): void {
    this.state.batches.set(batch._id.toHexString(), batch);
  }

  get purchases(): PurchaseRecord[] { return [...this.state.purchases.values()]; }
  get batches(): StockBatchRecord[] { return [...this.state.batches.values()]; }
  get movements(): StockMovementRecord[] { return [...this.state.movements]; }
  get ledger(): Array<Record<string, unknown>> { return [...this.state.supplierLedger]; }
  get auditEvents(): AuditRecord[] { return [...this.state.audits]; }
  get supplierBalanceValues(): ReadonlyMap<string, bigint> { return this.state.supplierBalances; }
}
