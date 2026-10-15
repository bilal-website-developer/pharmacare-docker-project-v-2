import { Long, ObjectId } from 'mongodb';
import type { AuditRecord, UserRecord } from '../models.js';
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
} from '../sales-domain.js';
import { normalizedCustomerName } from '../sales-domain.js';
import type { SalesRepository } from '../sales-repository.js';

interface MemoryState {
  customers: CustomerRecord[];
  sales: SaleRecord[];
  payments: Array<Record<string, unknown>>;
  ledger: Array<Record<string, unknown>>;
  movements: Array<Record<string, unknown>>;
  audits: AuditRecord[];
  counters: Map<string, number>;
}

function copy<T>(value: T): T {
  if (value instanceof Date) return new Date(value) as T;
  if (value instanceof ObjectId) return new ObjectId(value) as T;
  if (Long.isLong(value)) return Long.fromString(value.toString()) as T;
  if (value instanceof Map) return new Map([...value.entries()].map(([key, nested]) => [copy(key), copy(nested)])) as T;
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, copy(nested)])) as T;
  }
  return value;
}

function long(value: bigint): Long {
  if (value < -9_223_372_036_854_775_807n || value > 9_223_372_036_854_775_807n) {
    throw new Error('SALE_TOTAL_LIMIT_EXCEEDED');
  }
  return Long.fromString(value.toString());
}

function page<T>(rows: T[], index: number, size: number): T[] {
  return rows.slice((index - 1) * size, index * size);
}

export class MemorySalesRepository implements SalesRepository {
  private state: MemoryState = {
    customers: [],
    sales: [],
    payments: [],
    ledger: [],
    movements: [],
    audits: [],
    counters: new Map(),
  };
  readonly medicines: Array<Record<string, unknown>> = [];
  readonly units: Array<Record<string, unknown>> = [];
  readonly batches: Array<Record<string, unknown>> = [];
  failNextSaleAt: 'afterStockDecrement' | 'afterSaleInsert' | null = null;
  private serial = Promise.resolve();

  private async transaction<T>(run: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = this.serial;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await turn;
    const previous = this.state;
    const previousBatches = copy(this.batches);
    this.state = copy(previous);
    try {
      return await run();
    } catch (error) {
      this.state = previous;
      this.batches.splice(0, this.batches.length, ...previousBatches);
      throw error;
    } finally {
      release();
    }
  }

  seedMedicine(shopId: ObjectId, values: Record<string, unknown> = {}): { medicineId: ObjectId; unitId: ObjectId } {
    const medicineId = new ObjectId();
    const unitId = new ObjectId();
    this.medicines.push({
      _id: medicineId,
      shopId,
      code: `MED-${medicineId.toHexString().slice(-6)}`,
      name: 'Test Medicine',
      genericName: 'Test ingredient',
      drugClass: 'OTC',
      requiresPrescription: false,
      isActive: true,
      deletedAt: null,
      ...values,
    });
    this.units.push({
      _id: unitId,
      shopId,
      medicineId,
      name: 'Tablet',
      conversionFactorBaseUnits: 1,
      pricePaisa: Long.fromInt(100),
      isDefaultSaleUnit: true,
      deletedAt: null,
    });
    return { medicineId, unitId };
  }

  seedBatch(
    shopId: ObjectId,
    medicineId: ObjectId,
    values: { quantity: number; expiryDate: Date; daysReceivedAgo?: number; status?: string; unitCostPaisa?: number },
  ): ObjectId {
    const id = new ObjectId();
    const received = new Date();
    received.setUTCDate(received.getUTCDate() - (values.daysReceivedAgo ?? 1));
    this.batches.push({
      _id: id,
      shopId,
      medicineId,
      batchNumber: `B-${id.toHexString().slice(-6)}`,
      quantityRemainingBaseUnits: Long.fromNumber(values.quantity),
      expiryDate: values.expiryDate,
      receivedDate: received,
      status: values.status ?? 'ACTIVE',
      unitCostPaisaPerBaseUnit: Long.fromNumber(values.unitCostPaisa ?? 30),
    });
    return id;
  }

  seedCustomer(shopId: ObjectId, values: Partial<CustomerRecord> = {}): CustomerRecord {
    const now = new Date();
    const customer: CustomerRecord = {
      _id: new ObjectId(),
      shopId,
      name: 'Test Customer',
      normalizedName: 'test customer',
      phone: '',
      cnic: null,
      address: '',
      creditLimitPaisa: Long.ZERO,
      currentBalancePaisa: Long.ZERO,
      storeCreditPaisa: Long.ZERO,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      ...values,
    };
    this.state.customers.push(customer);
    return customer;
  }

  async posCatalog(shopId: ObjectId, today: Date): Promise<{ today: string; items: Array<Record<string, unknown>> }> {
    return {
      today: today.toISOString().slice(0, 10),
      items: this.medicines.filter((medicine) =>
        (medicine.shopId as ObjectId).equals(shopId) && medicine.isActive === true,
      ).map((medicine) => {
        const medicineId = medicine._id as ObjectId;
        const stock = this.batches.filter((batch) =>
          (batch.shopId as ObjectId).equals(shopId)
          && (batch.medicineId as ObjectId).equals(medicineId)
          && (batch.quantityRemainingBaseUnits as Long).greaterThan(Long.ZERO)
          && (batch.expiryDate as Date) >= today
          && ['ACTIVE', 'NEAR_EXPIRY'].includes(String(batch.status)),
        ).reduce((sum, batch) => sum + BigInt((batch.quantityRemainingBaseUnits as Long).toString()), 0n);
        return {
          id: medicineId.toHexString(),
          code: medicine.code,
          barcode: medicine.barcode ?? null,
          name: medicine.name,
          genericName: medicine.genericName ?? '',
          strength: medicine.strength ?? '',
          drugClass: medicine.drugClass,
          requiresPrescription: medicine.requiresPrescription,
          stockBaseUnits: stock.toString(),
          units: this.units.filter((unit) =>
            (unit.shopId as ObjectId).equals(shopId)
            && (unit.medicineId as ObjectId).equals(medicineId)
            && unit.deletedAt === null,
          ).map((unit) => ({
            id: (unit._id as ObjectId).toHexString(),
            name: unit.name,
            conversionFactorBaseUnits: unit.conversionFactorBaseUnits,
            pricePaisa: (unit.pricePaisa as Long).toString(),
            isDefaultSaleUnit: unit.isDefaultSaleUnit,
            barcode: unit.barcode ?? null,
          })),
        };
      }),
    };
  }

  async listCustomers(shopId: ObjectId, options: CustomerListQuery): Promise<{ rows: CustomerRecord[]; total: number }> {
    const rows = this.state.customers.filter((customer) =>
      customer.shopId.equals(shopId)
      && customer.deletedAt === null
      && (!options.search || `${customer.name} ${customer.phone}`.toLowerCase().includes(options.search.toLowerCase())),
    ).sort((left, right) => left.name.localeCompare(right.name));
    return { rows: page(rows, options.page, options.pageSize), total: rows.length };
  }

  async customerAccountsSummary(shopId: ObjectId): Promise<{ customers: CustomerRecord[]; ledgerEntries: Record<string, unknown>[] }> {
    const entries = this.state.ledger.filter((entry) => (entry.shopId as ObjectId).equals(shopId))
      .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
    const balances = new Map<string, bigint>();
    const ledgerEntries = entries.map((entry) => {
      const id = (entry.customerId as ObjectId).toHexString();
      const balance = (balances.get(id) ?? 0n)
        + BigInt((entry.debitPaisa as Long).toString())
        - BigInt((entry.creditPaisa as Long).toString());
      balances.set(id, balance);
      return {
        id: (entry._id as ObjectId).toHexString(),
        customerId: id,
        date: (entry.createdAt as Date).toISOString(),
        type: entry.entryType,
        referenceNo: entry.referenceNumber,
        description: entry.description,
        debitPaisa: (entry.debitPaisa as Long).toString(),
        creditPaisa: (entry.creditPaisa as Long).toString(),
        runningBalancePaisa: balance.toString(),
      };
    }).reverse();
    return {
      customers: this.state.customers.filter((customer) => customer.shopId.equals(shopId) && customer.deletedAt === null),
      ledgerEntries,
    };
  }

  async createCustomer(shopId: ObjectId, actorId: ObjectId, input: CustomerInput, audit: AuditRecord): Promise<CustomerRecord> {
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
    this.state.customers.push(customer);
    this.state.audits.push(audit);
    return customer;
  }

  async updateCustomer(
    shopId: ObjectId,
    id: ObjectId,
    actorId: ObjectId,
    input: CustomerUpdateInput,
    audit: AuditRecord,
  ): Promise<CustomerRecord | null> {
    const customer = this.state.customers.find((entry) =>
      entry._id.equals(id) && entry.shopId.equals(shopId) && entry.deletedAt === null,
    );
    if (!customer) return null;
    Object.assign(customer, input, {
      ...(input.name ? { normalizedName: normalizedCustomerName(input.name) } : {}),
      ...(input.creditLimitPaisa ? { creditLimitPaisa: Long.fromString(input.creditLimitPaisa) } : {}),
      updatedBy: actorId,
      updatedAt: new Date(),
    });
    this.state.audits.push(audit);
    return customer;
  }

  async deleteCustomer(shopId: ObjectId, id: ObjectId, actorId: ObjectId, audit: AuditRecord): Promise<boolean> {
    const customer = this.state.customers.find((entry) =>
      entry._id.equals(id) && entry.shopId.equals(shopId) && entry.deletedAt === null,
    );
    if (!customer) return false;
    if (customer.currentBalancePaisa.greaterThan(Long.ZERO)) throw new Error('CUSTOMER_HAS_BALANCE');
    customer.deletedAt = new Date();
    customer.updatedBy = actorId;
    customer.updatedAt = new Date();
    this.state.audits.push(audit);
    return true;
  }

  async recordCustomerPayment(
    shopId: ObjectId,
    id: ObjectId,
    actor: UserRecord,
    input: CustomerPaymentInput,
    audit: AuditRecord,
  ): Promise<Record<string, unknown> | null> {
    return this.transaction(async () => {
      const customer = this.state.customers.find((entry) =>
        entry._id.equals(id) && entry.shopId.equals(shopId) && entry.deletedAt === null,
      );
      if (!customer) return null;
      const amount = BigInt(input.amountPaisa);
      const balance = BigInt(customer.currentBalancePaisa.toString());
      if (amount > balance) throw new Error('PAYMENT_EXCEEDS_CUSTOMER_BALANCE');
      customer.currentBalancePaisa = Long.fromString((balance - amount).toString());
      const referenceNumber = this.nextNumber(shopId, 'PAYMENT', 'RCP-');
      const now = new Date();
      const paymentId = new ObjectId();
      this.state.ledger.push({
        _id: paymentId, shopId, customerId: id,
        referenceType: 'CUSTOMER_PAYMENT', referenceId: paymentId,
        entryType: 'PAYMENT',
        referenceNumber, description: input.note || 'Customer payment',
        debitPaisa: Long.ZERO, creditPaisa: Long.fromString(amount.toString()),
        runningBalancePaisa: customer.currentBalancePaisa,
        paymentMethod: input.method, createdBy: actor._id, createdAt: now,
      });
      this.state.audits.push(audit);
      return {
        referenceNo: referenceNumber,
        dateTime: now.toISOString(),
        balanceAfterPaisa: customer.currentBalancePaisa.toString(),
        storeCreditPaisa: customer.storeCreditPaisa.toString(),
      };
    });
  }

  private nextNumber(shopId: ObjectId, kind: string, prefix: string): string {
    const key = `${shopId.toHexString()}:${kind}`;
    const number = (this.state.counters.get(key) ?? 0) + 1;
    this.state.counters.set(key, number);
    return `${prefix}${String(number).padStart(6, '0')}`;
  }

  async postSale(input: PostSaleInput, actor: UserRecord, audit: AuditRecord, today: Date): Promise<SaleRecord> {
    return this.transaction(async () => {
      const customer = input.customerId
        ? this.state.customers.find((entry) =>
          entry._id.toHexString() === input.customerId
          && entry.shopId.equals(actor.shopId)
          && entry.deletedAt === null,
        ) ?? null
        : null;
      if (input.customerId && !customer) throw new Error('CUSTOMER_NOT_FOUND');
      if (!customer && input.payments.some((payment) => payment.method === 'CREDIT')) throw new Error('CREDIT_REQUIRES_CUSTOMER');
      const loaded: Array<{
        medicine: Record<string, unknown>;
        unit: Record<string, unknown>;
        base: bigint;
        gross: bigint;
        prescription?: PostSaleInput['items'][number]['prescription'];
      }> = [];
      let subtotal = 0n;
      for (const item of input.items) {
        const medicineId = new ObjectId(item.medicineId);
        const medicine = this.medicines.find((entry) =>
          (entry._id as ObjectId).equals(medicineId)
          && (entry.shopId as ObjectId).equals(actor.shopId)
          && entry.isActive === true
          && entry.deletedAt === null,
        );
        const unit = this.units.find((entry) =>
          entry._id instanceof ObjectId
          && entry._id.toHexString() === item.unitId
          && (entry.shopId as ObjectId).equals(actor.shopId)
          && (entry.medicineId as ObjectId).equals(medicineId)
          && entry.deletedAt === null,
        );
        if (!medicine || !unit) throw new Error('MEDICINE_OR_UNIT_UNAVAILABLE');
        if ((medicine.requiresPrescription === true || ['CONTROLLED', 'NARCOTIC'].includes(String(medicine.drugClass)))
            && !item.prescription) throw new Error('PRESCRIPTION_REQUIRED');
        const base = BigInt(item.quantityInUnit) * BigInt(Number(unit.conversionFactorBaseUnits));
        const gross = BigInt(item.quantityInUnit) * BigInt((unit.pricePaisa as Long).toString());
        subtotal += gross;
        loaded.push({ medicine, unit, base, gross, ...(item.prescription ? { prescription: item.prescription } : {}) });
      }
      const roleLimit = actor.role === 'cashier' ? 10n
        : actor.role === 'manager' ? 15n
          : actor.role === 'admin' || actor.role === 'super_admin' ? 30n : 0n;
      const maxDiscount = [20_000n, subtotal * roleLimit / 100n, subtotal]
        .reduce((min, value) => min < value ? min : value);
      const discount = BigInt(input.discountPaisa);
      if (discount > maxDiscount) throw new Error('DISCOUNT_EXCEEDS_ROLE_LIMIT');
      const total = subtotal - discount;
      const paymentTotal = input.payments.reduce((sum, payment) => sum + BigInt(payment.amountPaisa), 0n);
      if (paymentTotal !== total) throw new Error('PAYMENTS_MUST_EQUAL_TOTAL');
      const credit = input.payments.reduce((sum, payment) =>
        sum + (payment.method === 'CREDIT' ? BigInt(payment.amountPaisa) : 0n), 0n);
      if (credit > 0n && (credit !== total || input.payments.length !== 1 || !customer)) {
        throw new Error('CREDIT_MUST_BE_SOLE_PAYMENT');
      }
      const tendered = BigInt(input.amountTenderedPaisa);
      if (credit > 0n && tendered !== 0n) throw new Error('CREDIT_TENDER_MUST_BE_ZERO');
      if (credit === 0n && input.payments.length === 1 && input.payments[0]!.method === 'CASH' && tendered < total) {
        throw new Error('CASH_TENDER_BELOW_TOTAL');
      }
      if (credit === 0n && !(input.payments.length === 1 && input.payments[0]!.method === 'CASH') && tendered !== total) {
        throw new Error('TENDER_MUST_EQUAL_TOTAL');
      }
      let allocatedDiscount = 0n;
      const saleId = new ObjectId();
      const invoiceNumber = this.nextNumber(actor.shopId, 'SALE', 'INV-');
      const items: SaleItemRecord[] = [];
      for (const [index, entry] of loaded.entries()) {
        const lineDiscount = index === loaded.length - 1
          ? discount - allocatedDiscount
          : subtotal === 0n ? 0n : discount * entry.gross / subtotal;
        allocatedDiscount += lineDiscount;
        let remaining = entry.base;
        const allocations: SaleItemRecord['batchAllocations'] = [];
        const eligible = this.batches.filter((batch) =>
          (batch.shopId as ObjectId).equals(actor.shopId)
          && (batch.medicineId as ObjectId).equals(entry.medicine._id as ObjectId)
          && (batch.quantityRemainingBaseUnits as Long).greaterThan(Long.ZERO)
          && (batch.expiryDate as Date) >= today
          && ['ACTIVE', 'NEAR_EXPIRY'].includes(String(batch.status)),
        ).sort((a, b) =>
          (a.expiryDate as Date).getTime() - (b.expiryDate as Date).getTime()
          || (a.receivedDate as Date).getTime() - (b.receivedDate as Date).getTime()
          || (a._id as ObjectId).toHexString().localeCompare((b._id as ObjectId).toHexString()),
        );
        for (const batch of eligible) {
          if (remaining === 0n) break;
          const quantity = batch.quantityRemainingBaseUnits as Long;
          const available = BigInt(quantity.toString());
          const take = remaining < available ? remaining : available;
          batch.quantityRemainingBaseUnits = Long.fromString((available - take).toString());
          if (available === take) batch.status = 'SOLD_OUT';
          allocations.push({
            batchId: batch._id as ObjectId,
            batchNumber: String(batch.batchNumber),
            expiryDate: batch.expiryDate as Date,
            quantityBaseUnits: long(take),
          });
          remaining -= take;
        }
        if (remaining > 0n) throw new Error('INSUFFICIENT_SELLABLE_STOCK');
        if (this.failNextSaleAt === 'afterStockDecrement') {
          this.failNextSaleAt = null;
          throw new Error('INJECTED_SALE_FAILURE');
        }
        const lineTotal = entry.gross - lineDiscount;
        items.push({
          _id: new ObjectId(),
          medicineId: entry.medicine._id as ObjectId,
          medicineCode: String(entry.medicine.code),
          medicineName: String(entry.medicine.name),
          genericName: String(entry.medicine.genericName ?? ''),
          drugClass: String(entry.medicine.drugClass ?? 'OTC'),
          unitId: entry.unit._id as ObjectId,
          unitName: String(entry.unit.name),
          conversionFactorBaseUnits: Number(entry.unit.conversionFactorBaseUnits),
          quantityInUnit: input.items[index]!.quantityInUnit,
          quantityBaseUnits: long(entry.base),
          pricePaisaPerUnit: entry.unit.pricePaisa as Long,
          lineDiscountPaisa: long(lineDiscount),
          lineTotalPaisa: long(lineTotal),
          ...(entry.prescription ? { prescription: entry.prescription } : {}),
          batchAllocations: allocations,
        });
        this.state.movements.push(...allocations.map((allocation) => ({
          _id: new ObjectId(), shopId: actor.shopId, batchId: allocation.batchId,
          medicineId: entry.medicine._id, movementType: 'SALE',
          quantityDeltaBaseUnits: long(-BigInt(allocation.quantityBaseUnits.toString())),
          referenceType: 'SALE', referenceId: saleId, reason: `POS sale ${invoiceNumber}`,
          actorId: actor._id, createdAt: new Date(),
        })));
      }
      const method = credit > 0n ? 'CREDIT' : input.payments.length > 1 ? 'SPLIT' : input.payments[0]!.method;
      const now = new Date();
      const sale: SaleRecord = {
        _id: saleId, shopId: actor.shopId, invoiceNumber, cashierId: actor._id,
        cashierName: actor.fullName, customerId: customer?._id ?? null,
        customerName: customer?.name ?? (input.customerName.trim() || 'Walk-in Customer'),
        customerPhone: customer?.phone ?? '', soldAt: now,
        subtotalPaisa: long(subtotal), discountPaisa: long(discount), totalPaisa: long(total),
        amountTenderedPaisa: long(tendered),
        changePaisa: long(method === 'CASH' ? tendered - total : 0n),
        paymentMethod: method, status: 'COMPLETED', items,
      };
      this.state.sales.push(sale);
      this.state.payments.push(...input.payments.map((payment) => ({
        _id: new ObjectId(), shopId: actor.shopId, saleId,
        method: payment.method, amountPaisa: Long.fromString(payment.amountPaisa), createdAt: now,
      })));
      if (this.failNextSaleAt === 'afterSaleInsert') {
        this.failNextSaleAt = null;
        throw new Error('INJECTED_SALE_FAILURE');
      }
      if (customer && credit > 0n) {
        customer.currentBalancePaisa = long(BigInt(customer.currentBalancePaisa.toString()) + credit);
        this.state.ledger.push({
          _id: new ObjectId(), shopId: actor.shopId, customerId: customer._id, saleId,
          referenceType: 'SALE', referenceId: saleId,
          entryType: 'INVOICE', referenceNumber: invoiceNumber, description: 'POS credit sale',
          debitPaisa: long(credit), creditPaisa: Long.ZERO,
          runningBalancePaisa: customer.currentBalancePaisa, createdBy: actor._id, createdAt: now,
        });
      }
      this.state.audits.push(audit);
      return sale;
    });
  }

  async listSales(
    shopId: ObjectId,
    options: SalesHistoryQuery,
    cashierId?: ObjectId,
  ): Promise<{ rows: SaleRecord[]; total: number }> {
    const rows = this.state.sales.filter((sale) =>
      sale.shopId.equals(shopId)
      && (!cashierId || sale.cashierId.equals(cashierId))
      && (!options.dateFrom || sale.soldAt >= new Date(`${options.dateFrom}T00:00:00.000Z`))
      && (!options.dateTo || sale.soldAt < new Date(new Date(`${options.dateTo}T00:00:00.000Z`).getTime() + 86_400_000))
      && (!options.search || `${sale.invoiceNumber} ${sale.customerName}`.toLowerCase().includes(options.search.toLowerCase())),
    ).sort((a, b) => b.soldAt.getTime() - a.soldAt.getTime());
    return { rows: page(rows, options.page, options.pageSize), total: rows.length };
  }

  get auditEvents(): readonly AuditRecord[] {
    return this.state.audits;
  }

  get paymentRecords(): readonly Record<string, unknown>[] {
    return this.state.payments;
  }

  get movementRecords(): readonly Record<string, unknown>[] {
    return this.state.movements;
  }
}
