import { Long, ObjectId, type ClientSession, type Db, type Document, type MongoClient } from 'mongodb';
import type { AuditRecord, UserRecord } from './models.js';
import type {
  CustomerInput,
  CustomerListQuery,
  CustomerPaymentInput,
  CustomerRecord,
  CustomerUpdateInput,
  PostSaleInput,
  SaleItemRecord,
  SaleRecord,
  SalesHistoryQuery,
  SalePaymentRecord,
} from './sales-domain.js';
import { normalizedCustomerName } from './sales-domain.js';

export interface SalesRepository {
  posCatalog(shopId: ObjectId, today: Date): Promise<{ items: Array<Record<string, unknown>> }>;
  listCustomers(shopId: ObjectId, options: CustomerListQuery): Promise<{ rows: CustomerRecord[]; total: number }>;
  customerAccountsSummary(shopId: ObjectId): Promise<{ customers: CustomerRecord[]; ledgerEntries: Record<string, unknown>[] }>;
  createCustomer(shopId: ObjectId, actorId: ObjectId, input: CustomerInput, audit: AuditRecord): Promise<CustomerRecord>;
  updateCustomer(shopId: ObjectId, id: ObjectId, actorId: ObjectId, input: CustomerUpdateInput, audit: AuditRecord): Promise<CustomerRecord | null>;
  deleteCustomer(shopId: ObjectId, id: ObjectId, actorId: ObjectId, audit: AuditRecord): Promise<boolean>;
  recordCustomerPayment(shopId: ObjectId, id: ObjectId, actor: UserRecord, input: CustomerPaymentInput, audit: AuditRecord): Promise<Record<string, unknown> | null>;
  postSale(input: PostSaleInput, actor: UserRecord, audit: AuditRecord, today: Date): Promise<SaleRecord>;
  listSales(shopId: ObjectId, options: SalesHistoryQuery, cashierId?: ObjectId): Promise<{ rows: SaleRecord[]; total: number }>;
}

function asLong(value: unknown): Long {
  if (Long.isLong(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return Long.fromNumber(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Long.fromString(value);
  throw new Error('INVALID_STORED_INTEGER');
}

function longFromBigInt(value: bigint): Long {
  if (value < 0n || value > 9_223_372_036_854_775_807n) throw new Error('SALE_TOTAL_LIMIT_EXCEEDED');
  return Long.fromString(value.toString());
}

function signedLongFromBigInt(value: bigint): Long {
  if (value < -9_223_372_036_854_775_807n || value > 9_223_372_036_854_775_807n) {
    throw new Error('SALE_TOTAL_LIMIT_EXCEEDED');
  }
  return Long.fromString(value.toString());
}

function roleDiscountPercent(role: UserRecord['role']): bigint {
  switch (role) {
    case 'cashier': return 10n;
    case 'manager': return 15n;
    case 'admin':
    case 'super_admin': return 30n;
    case 'accountant': return 0n;
  }
}

function allocateDiscount(discount: bigint, lineGrosses: bigint[], subtotal: bigint): bigint[] {
  let allocated = 0n;
  return lineGrosses.map((gross, index) => {
    if (index === lineGrosses.length - 1) return discount - allocated;
    const part = subtotal === 0n ? 0n : discount * gross / subtotal;
    allocated += part;
    return part;
  });
}

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

export class MongoSalesRepository implements SalesRepository {
  private readonly database: Db;

  constructor(private readonly client: MongoClient, databaseName: string) {
    this.database = client.db(databaseName);
  }

  protected async transactionCheckpoint(_stage: string): Promise<void> {}

  private async transact<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      let result: { value: T } | undefined;
      await session.withTransaction(async () => {
        result = { value: await operation(session) };
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      if (result === undefined) throw new Error('SALE_TRANSACTION_RESULT_MISSING');
      return result.value;
    } finally {
      await session.endSession();
    }
  }

  async posCatalog(shopId: ObjectId, today: Date): Promise<{ items: Array<Record<string, unknown>> }> {
    const medicines = await this.database.collection('medicines').find({
      shopId, isActive: true, deletedAt: null,
    }).sort({ name: 1, _id: 1 }).toArray();
    if (medicines.length === 0) return { items: [] };
    const ids = medicines.map((medicine) => medicine._id as ObjectId);
    const [units, batchTotals] = await Promise.all([
      this.database.collection('medicineUnits').find({
        shopId, medicineId: { $in: ids }, deletedAt: null,
      }).sort({ isDefaultSaleUnit: -1, name: 1 }).toArray(),
      this.database.collection('stockBatches').aggregate([
        {
          $match: {
            shopId,
            medicineId: { $in: ids },
            quantityRemainingBaseUnits: { $gt: Long.ZERO },
            expiryDate: { $gte: today },
            status: { $in: ['ACTIVE', 'NEAR_EXPIRY'] },
          },
        },
        { $group: { _id: '$medicineId', quantity: { $sum: '$quantityRemainingBaseUnits' } } },
      ]).toArray(),
    ]);
    const unitsByMedicine = new Map<string, Array<Record<string, unknown>>>();
    for (const unit of units) {
      const medicineId = (unit.medicineId as ObjectId).toHexString();
      const values = unitsByMedicine.get(medicineId) ?? [];
      values.push({
        id: (unit._id as ObjectId).toHexString(),
        name: String(unit.name),
        conversionFactorBaseUnits: Number(unit.conversionFactorBaseUnits),
        pricePaisa: asLong(unit.pricePaisa).toString(),
        isDefaultSaleUnit: unit.isDefaultSaleUnit === true,
        barcode: typeof unit.barcode === 'string' ? unit.barcode : null,
      });
      unitsByMedicine.set(medicineId, values);
    }
    const stockByMedicine = new Map(batchTotals.map((row) => [
      (row._id as ObjectId).toHexString(),
      asLong(row.quantity).toString(),
    ]));
    return {
      items: medicines.map((medicine) => ({
        id: (medicine._id as ObjectId).toHexString(),
        code: String(medicine.code),
        barcode: typeof medicine.barcode === 'string' ? medicine.barcode : null,
        name: String(medicine.name),
        genericName: String(medicine.genericName ?? ''),
        strength: String(medicine.strength ?? ''),
        drugClass: String(medicine.drugClass ?? 'OTC'),
        requiresPrescription: medicine.requiresPrescription === true,
        stockBaseUnits: stockByMedicine.get((medicine._id as ObjectId).toHexString()) ?? '0',
        units: unitsByMedicine.get((medicine._id as ObjectId).toHexString()) ?? [],
      })),
    };
  }

  async listCustomers(shopId: ObjectId, options: CustomerListQuery): Promise<{ rows: CustomerRecord[]; total: number }> {
    const filter: Document = { shopId, deletedAt: null };
    if (options.search) {
      const search = options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }
    const customers = this.database.collection<CustomerRecord>('customers');
    const [rows, total] = await Promise.all([
      customers.find(filter).sort({ name: 1, _id: 1 }).skip((options.page - 1) * options.pageSize).limit(options.pageSize).toArray(),
      customers.countDocuments(filter),
    ]);
    return { rows, total };
  }

  async customerAccountsSummary(shopId: ObjectId): Promise<{ customers: CustomerRecord[]; ledgerEntries: Record<string, unknown>[] }> {
    const [customers, entries] = await Promise.all([
      this.database.collection<CustomerRecord>('customers').find({ shopId, deletedAt: null }).sort({ name: 1, _id: 1 }).toArray(),
      this.database.collection('customerLedger').find({ shopId }).sort({ createdAt: 1, _id: 1 }).toArray(),
    ]);
    const balances = new Map<string, bigint>();
    const ledgerEntries = entries.map((entry) => {
      const customerId = (entry.customerId as ObjectId).toHexString();
      const balance = (balances.get(customerId) ?? 0n)
        + BigInt(asLong(entry.debitPaisa).toString())
        - BigInt(asLong(entry.creditPaisa).toString());
      balances.set(customerId, balance);
      return {
        id: (entry._id as ObjectId).toHexString(),
        customerId,
        date: (entry.createdAt as Date).toISOString(),
        type: String(entry.entryType),
        referenceNo: String(entry.referenceNumber),
        description: String(entry.description ?? ''),
        debitPaisa: asLong(entry.debitPaisa).toString(),
        creditPaisa: asLong(entry.creditPaisa).toString(),
        runningBalancePaisa: balance.toString(),
      };
    }).reverse();
    return { customers, ledgerEntries };
  }

  async createCustomer(
    shopId: ObjectId,
    actorId: ObjectId,
    input: CustomerInput,
    audit: AuditRecord,
  ): Promise<CustomerRecord> {
    const now = new Date();
    const customer: CustomerRecord = {
      _id: new ObjectId(),
      shopId,
      name: input.name,
      normalizedName: normalizedCustomerName(input.name),
      phone: input.phone,
      cnic: input.cnic ?? null,
      address: input.address,
      creditLimitPaisa: Long.fromString(input.creditLimitPaisa),
      currentBalancePaisa: Long.ZERO,
      storeCreditPaisa: Long.ZERO,
      createdBy: actorId,
      updatedBy: actorId,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.transact(async (session) => {
      await this.database.collection<CustomerRecord>('customers').insertOne(customer, { session });
      await this.database.collection<AuditRecord>('auditLogs').insertOne(audit, { session });
    });
    return customer;
  }

  async updateCustomer(
    shopId: ObjectId,
    id: ObjectId,
    actorId: ObjectId,
    input: CustomerUpdateInput,
    audit: AuditRecord,
  ): Promise<CustomerRecord | null> {
    return this.transact(async (session) => {
      const customers = this.database.collection<CustomerRecord>('customers');
      const before = await customers.findOne({ _id: id, shopId, deletedAt: null }, { session });
      if (!before) return null;
      const updates: Document = {
        ...input,
        updatedBy: actorId,
        ...(input.name ? { normalizedName: normalizedCustomerName(input.name) } : {}),
        ...(input.creditLimitPaisa ? { creditLimitPaisa: Long.fromString(input.creditLimitPaisa) } : {}),
        updatedAt: new Date(),
      };
      await customers.updateOne({ _id: id, shopId, deletedAt: null }, { $set: updates }, { session });
      await this.database.collection<AuditRecord>('auditLogs').insertOne(audit, { session });
      const after = await customers.findOne({ _id: id, shopId }, { session });
      if (!after) throw new Error('CUSTOMER_UPDATE_LOST');
      return after;
    });
  }

  async deleteCustomer(shopId: ObjectId, id: ObjectId, actorId: ObjectId, audit: AuditRecord): Promise<boolean> {
    return this.transact(async (session) => {
      const customers = this.database.collection<CustomerRecord>('customers');
      const customer = await customers.findOne({ _id: id, shopId, deletedAt: null }, { session });
      if (!customer) return false;
      if (BigInt(asLong(customer.currentBalancePaisa).toString()) > 0n) {
        throw new Error('CUSTOMER_HAS_BALANCE');
      }
      const result = await customers.updateOne(
        {
          _id: id,
          shopId,
          deletedAt: null,
          currentBalancePaisa: Long.ZERO,
        },
        { $set: { deletedAt: new Date(), updatedAt: new Date(), deletedBy: actorId } },
        { session },
      );
      if (result.modifiedCount !== 1) throw new Error('CUSTOMER_CHANGED_CONCURRENTLY');
      await this.database.collection<AuditRecord>('auditLogs').insertOne(audit, { session });
      return true;
    });
  }

  async recordCustomerPayment(
    shopId: ObjectId,
    id: ObjectId,
    actor: UserRecord,
    input: CustomerPaymentInput,
    audit: AuditRecord,
  ): Promise<Record<string, unknown> | null> {
    return this.transact(async (session) => {
      const customers = this.database.collection<CustomerRecord>('customers');
      const customer = await customers.findOne({ _id: id, shopId, deletedAt: null }, { session });
      if (!customer) return null;
      const amount = BigInt(input.amountPaisa);
      const balance = BigInt(asLong(customer.currentBalancePaisa).toString());
      if (amount > balance) throw new Error('PAYMENT_EXCEEDS_CUSTOMER_BALANCE');
      const nextBalance = balance - amount;
      const now = new Date();
      const paymentId = new ObjectId();
      const paymentNumber = await this.nextNumber(session, shopId, 'PAYMENT', 'RCP-');
      const result = await customers.updateOne(
        { _id: id, shopId, deletedAt: null, currentBalancePaisa: asLong(customer.currentBalancePaisa) },
        { $inc: { currentBalancePaisa: Long.fromString((-amount).toString()) }, $set: { updatedAt: now } },
        { session },
      );
      if (result.modifiedCount !== 1) throw new Error('CUSTOMER_CHANGED_CONCURRENTLY');
      await this.database.collection('customerLedger').insertOne({
        _id: paymentId,
        shopId,
        customerId: id,
        referenceType: 'CUSTOMER_PAYMENT',
        referenceId: paymentId,
        entryType: 'PAYMENT',
        referenceNumber: paymentNumber,
        description: input.note || 'Customer payment',
        debitPaisa: Long.ZERO,
        creditPaisa: longFromBigInt(amount),
        runningBalancePaisa: longFromBigInt(nextBalance),
        paymentMethod: input.method,
        createdBy: actor._id,
        createdAt: now,
      }, { session });
      if (input.method === 'CASH') {
        await this.database.collection('cashBookEntries').insertOne({
          _id: new ObjectId(),
          shopId,
          entryType: 'CUSTOMER_PAYMENT',
          direction: 'IN',
          amountPaisa: longFromBigInt(amount),
          referenceType: 'CUSTOMER_PAYMENT',
          referenceId: paymentId,
          paymentMethod: 'CASH',
          actorId: actor._id,
          createdAt: now,
        }, { session });
      }
      await this.database.collection<AuditRecord>('auditLogs').insertOne(audit, { session });
      return {
        referenceNo: paymentNumber,
        dateTime: now.toISOString(),
        balanceAfterPaisa: nextBalance.toString(),
        storeCreditPaisa: asLong(customer.storeCreditPaisa).toString(),
      };
    });
  }

  private async nextNumber(
    session: ClientSession,
    shopId: ObjectId,
    kind: 'SALE' | 'PAYMENT',
    prefix: string,
  ): Promise<string> {
    const counter = await this.database.collection('counters').findOneAndUpdate(
      { shopId, kind },
      { $inc: { lastValue: Long.ONE }, $setOnInsert: { shopId, kind } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false, session },
    );
    if (!counter) throw new Error('NUMBER_SEQUENCE_UNAVAILABLE');
    return `${prefix}${asLong(counter.lastValue).toString().padStart(6, '0')}`;
  }

  async postSale(input: PostSaleInput, actor: UserRecord, audit: AuditRecord, today: Date): Promise<SaleRecord> {
    try {
      return await this.transact(async (session) => {
        const now = new Date();
        const medicines = this.database.collection('medicines');
        const units = this.database.collection('medicineUnits');
        const customers = this.database.collection<CustomerRecord>('customers');
        const customerId = input.customerId ? new ObjectId(input.customerId) : null;
        const customer = customerId
          ? await customers.findOne({ _id: customerId, shopId: actor.shopId, deletedAt: null }, { session })
          : null;
        if (customerId && !customer) throw new Error('CUSTOMER_NOT_FOUND');
        if (!customerId && input.payments.some((payment) => payment.method === 'CREDIT')) {
          throw new Error('CREDIT_REQUIRES_CUSTOMER');
        }

        const loaded: Array<{
          medicine: Document;
          unit: Document;
          quantityBaseUnits: bigint;
          gross: bigint;
          prescription?: PostSaleInput['items'][number]['prescription'];
        }> = [];
        let subtotal = 0n;
        for (const item of input.items) {
          const medicineId = new ObjectId(item.medicineId);
          const unitId = new ObjectId(item.unitId);
          const medicine = await medicines.findOne(
            { _id: medicineId, shopId: actor.shopId, isActive: true, deletedAt: null },
            { session },
          );
          const unit = await units.findOne(
            { _id: unitId, medicineId, shopId: actor.shopId, deletedAt: null },
            { session },
          );
          if (!medicine || !unit) throw new Error('MEDICINE_OR_UNIT_UNAVAILABLE');
          const requiresPrescription = medicine.requiresPrescription === true
            || ['CONTROLLED', 'NARCOTIC'].includes(String(medicine.drugClass));
          if (requiresPrescription && !item.prescription) throw new Error('PRESCRIPTION_REQUIRED');
          const factor = Number(unit.conversionFactorBaseUnits);
          if (!Number.isSafeInteger(factor) || factor < 1) throw new Error('INVALID_UNIT_CONVERSION');
          const quantityBaseUnits = BigInt(item.quantityInUnit) * BigInt(factor);
          if (quantityBaseUnits > 2_147_483_647n) throw new Error('SALE_QUANTITY_LIMIT_EXCEEDED');
          const price = BigInt(asLong(unit.pricePaisa).toString());
          const gross = BigInt(item.quantityInUnit) * price;
          subtotal += gross;
          if (subtotal > 9_223_372_036_854_775_807n) throw new Error('SALE_TOTAL_LIMIT_EXCEEDED');
          loaded.push({ medicine, unit, quantityBaseUnits, gross, ...(item.prescription ? { prescription: item.prescription } : {}) });
        }

        const rolePercent = roleDiscountPercent(actor.role);
        const maxDiscount = [
          20_000n,
          subtotal * rolePercent / 100n,
          subtotal,
        ].reduce((lowest, amount) => amount < lowest ? amount : lowest);
        const requestedDiscount = BigInt(input.discountPaisa);
        if (requestedDiscount > maxDiscount) throw new Error('DISCOUNT_EXCEEDS_ROLE_LIMIT');
        const total = subtotal - requestedDiscount;
        if (total < 0n) throw new Error('INVALID_SALE_TOTAL');

        const payments = input.payments.map((payment) => BigInt(payment.amountPaisa));
        const paymentTotal = payments.reduce((sum, amount) => sum + amount, 0n);
        if (payments.some((amount) => amount <= 0n) || paymentTotal !== total) {
          throw new Error('PAYMENTS_MUST_EQUAL_TOTAL');
        }
        const creditAmount = input.payments.reduce(
          (sum, payment) => sum + (payment.method === 'CREDIT' ? BigInt(payment.amountPaisa) : 0n),
          0n,
        );
        if (creditAmount > 0n && (
          creditAmount !== total || input.payments.length !== 1 || !customerId
        )) throw new Error('CREDIT_MUST_BE_SOLE_PAYMENT');
        const tendered = BigInt(input.amountTenderedPaisa);
        if (creditAmount > 0n) {
          if (tendered !== 0n) throw new Error('CREDIT_TENDER_MUST_BE_ZERO');
        } else if (input.payments.length === 1 && input.payments[0]!.method === 'CASH') {
          if (tendered < total) throw new Error('CASH_TENDER_BELOW_TOTAL');
        } else if (tendered !== total) {
          throw new Error('TENDER_MUST_EQUAL_TOTAL');
        }

        const discountShares = allocateDiscount(requestedDiscount, loaded.map((item) => item.gross), subtotal);
        const saleId = new ObjectId();
        const invoiceNumber = await this.nextNumber(session, actor.shopId, 'SALE', 'INV-');
        const items: SaleItemRecord[] = [];
        for (const [index, item] of loaded.entries()) {
          let remaining = item.quantityBaseUnits;
          const allocations: SaleItemRecord['batchAllocations'] = [];
          const batches = await this.database.collection('stockBatches').find({
            shopId: actor.shopId,
            medicineId: item.medicine._id,
            quantityRemainingBaseUnits: { $gt: Long.ZERO },
            expiryDate: { $gte: today },
            status: { $in: ['ACTIVE', 'NEAR_EXPIRY'] },
          }, { session }).sort({ expiryDate: 1, receivedDate: 1, _id: 1 }).toArray();
          for (const batch of batches) {
            if (remaining === 0n) break;
            const before = asLong(batch.quantityRemainingBaseUnits);
            const available = BigInt(before.toString());
            const take = remaining < available ? remaining : available;
            const after = available - take;
            const updated = await this.database.collection('stockBatches').updateOne({
              _id: batch._id,
              shopId: actor.shopId,
              medicineId: item.medicine._id,
              status: { $in: ['ACTIVE', 'NEAR_EXPIRY'] },
              expiryDate: { $gte: today },
              quantityRemainingBaseUnits: { $gte: longFromBigInt(take) },
            }, {
              $set: {
                quantityRemainingBaseUnits: longFromBigInt(after),
                ...(after === 0n ? { status: 'SOLD_OUT' } : {}),
                updatedAt: now,
              },
            }, { session });
            if (updated.modifiedCount !== 1) throw new Error('STOCK_CHANGED_CONCURRENTLY');
            allocations.push({
              batchId: batch._id as ObjectId,
              batchNumber: String(batch.batchNumber),
              expiryDate: batch.expiryDate as Date,
              quantityBaseUnits: longFromBigInt(take),
            });
            remaining -= take;
          }
          if (remaining > 0n) throw new Error('INSUFFICIENT_SELLABLE_STOCK');
          const itemDiscount = discountShares[index]!;
          const lineTotal = item.gross - itemDiscount;
          const saleItemId = new ObjectId();
          items.push({
            _id: saleItemId,
            medicineId: item.medicine._id as ObjectId,
            medicineCode: String(item.medicine.code),
            medicineName: String(item.medicine.name),
            genericName: String(item.medicine.genericName ?? ''),
            drugClass: String(item.medicine.drugClass ?? 'OTC'),
            storageCondition: String(item.medicine.storageCondition ?? 'ROOM_TEMPERATURE'),
            unitId: item.unit._id as ObjectId,
            unitName: String(item.unit.name),
            conversionFactorBaseUnits: Number(item.unit.conversionFactorBaseUnits),
            quantityInUnit: input.items[index]!.quantityInUnit,
            quantityBaseUnits: longFromBigInt(item.quantityBaseUnits),
            pricePaisaPerUnit: asLong(item.unit.pricePaisa),
            lineDiscountPaisa: longFromBigInt(itemDiscount),
            lineTotalPaisa: longFromBigInt(lineTotal),
            ...(item.prescription ? { prescription: item.prescription } : {}),
            batchAllocations: allocations,
          });
          await this.database.collection('stockMovements').insertMany(allocations.map((allocation) => ({
            _id: new ObjectId(),
            shopId: actor.shopId,
            batchId: allocation.batchId,
            medicineId: item.medicine._id,
            movementType: 'SALE',
            quantityDeltaBaseUnits: signedLongFromBigInt(-BigInt(allocation.quantityBaseUnits.toString())),
            referenceType: 'SALE',
            referenceId: saleId,
            reason: `POS sale ${invoiceNumber}`,
            actorId: actor._id,
            createdAt: now,
          })), { session });
        }
        await this.transactionCheckpoint('sale.after_stock');

        const paymentMethod = creditAmount > 0n
          ? 'CREDIT'
          : input.payments.length > 1
            ? 'SPLIT'
            : input.payments[0]!.method;
        const sale: SaleRecord = {
          _id: saleId,
          shopId: actor.shopId,
          invoiceNumber,
          cashierId: actor._id,
          cashierName: actor.fullName,
          customerId,
          customerName: customer?.name ?? (input.customerName.trim() || 'Walk-in Customer'),
          customerPhone: customer?.phone ?? '',
          soldAt: now,
          subtotalPaisa: longFromBigInt(subtotal),
          discountPaisa: longFromBigInt(requestedDiscount),
          totalPaisa: longFromBigInt(total),
          amountTenderedPaisa: longFromBigInt(tendered),
          changePaisa: longFromBigInt(
            input.payments.length === 1 && input.payments[0]!.method === 'CASH' && creditAmount === 0n
              ? tendered - total
              : 0n,
          ),
          paymentMethod,
          status: 'COMPLETED',
          items,
        };
        await this.database.collection<SaleRecord>('sales').insertOne(sale, { session });
        await this.transactionCheckpoint('sale.after_sale');
        const paymentRecords: SalePaymentRecord[] = input.payments.map((payment) => ({
          _id: new ObjectId(),
          shopId: actor.shopId,
          saleId,
          method: payment.method,
          amountPaisa: Long.fromString(payment.amountPaisa),
          createdAt: now,
        }));
        await this.database.collection<SalePaymentRecord>('salePayments').insertMany(paymentRecords, { session });
        const cashEntries = paymentRecords.filter((payment) => payment.method === 'CASH').map((payment) => ({
          _id: new ObjectId(),
          shopId: actor.shopId,
          entryType: 'SALE_PAYMENT',
          direction: 'IN',
          amountPaisa: payment.amountPaisa,
          referenceType: 'SALE_PAYMENT',
          referenceId: payment._id,
          paymentMethod: 'CASH',
          actorId: actor._id,
          createdAt: now,
        }));
        if (cashEntries.length > 0) {
          await this.database.collection('cashBookEntries').insertMany(cashEntries, { session });
        }
        await this.transactionCheckpoint('sale.after_payments');

        if (customer && creditAmount > 0n) {
          const beforeBalance = BigInt(asLong(customer.currentBalancePaisa).toString());
          const nextBalance = beforeBalance + creditAmount;
          const changed = await customers.updateOne({
            _id: customer._id,
            shopId: actor.shopId,
            currentBalancePaisa: asLong(customer.currentBalancePaisa),
            deletedAt: null,
          }, {
            $inc: { currentBalancePaisa: longFromBigInt(creditAmount) },
            $set: { updatedAt: now },
          }, { session });
          if (changed.modifiedCount !== 1) throw new Error('CUSTOMER_CHANGED_CONCURRENTLY');
          await this.database.collection('customerLedger').insertOne({
            _id: new ObjectId(),
            shopId: actor.shopId,
            customerId: customer._id,
            saleId,
            referenceType: 'SALE',
            referenceId: saleId,
            entryType: 'INVOICE',
            referenceNumber: invoiceNumber,
            description: 'POS credit sale',
            debitPaisa: longFromBigInt(creditAmount),
            creditPaisa: Long.ZERO,
            runningBalancePaisa: longFromBigInt(nextBalance),
            createdBy: actor._id,
            createdAt: now,
          }, { session });
        }
        await this.transactionCheckpoint('sale.after_ledger');
        await this.database.collection<AuditRecord>('auditLogs').insertOne(audit, { session });
        if (requestedDiscount > 0n) {
          await this.database.collection<AuditRecord>('auditLogs').insertOne({
            ...audit,
            event: 'sale.discount_applied',
            after: { discountPaisa: requestedDiscount.toString() },
          }, { session });
        }
        return sale;
      });
    } catch (error) {
      if (duplicateKey(error)) throw new Error('SALE_NUMBER_CONFLICT');
      throw error;
    }
  }

  async listSales(
    shopId: ObjectId,
    options: SalesHistoryQuery,
    cashierId?: ObjectId,
  ): Promise<{ rows: SaleRecord[]; total: number }> {
    const filter: Document = { shopId };
    if (cashierId) filter.cashierId = cashierId;
    if (options.dateFrom || options.dateTo) {
      filter.soldAt = {
        ...(options.dateFrom ? { $gte: dateOnly(options.dateFrom) } : {}),
        ...(options.dateTo ? { $lt: new Date(dateOnly(options.dateTo).getTime() + 86_400_000) } : {}),
      };
    }
    if (options.search) {
      const expression = options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { invoiceNumber: { $regex: expression, $options: 'i' } },
        { customerName: { $regex: expression, $options: 'i' } },
      ];
    }
    const sales = this.database.collection<SaleRecord>('sales');
    const [rows, total] = await Promise.all([
      sales.find(filter).sort({ soldAt: -1, _id: -1 }).skip((options.page - 1) * options.pageSize).limit(options.pageSize).toArray(),
      sales.countDocuments(filter),
    ]);
    return { rows, total };
  }
}
