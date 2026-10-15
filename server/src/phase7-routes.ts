import {
  Long,
  ObjectId,
  type ClientSession,
  type Document,
  type MongoClient,
} from 'mongodb';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { AuditRecord, PharmacyRepository, UserRecord } from './models.js';
import type { TokenConfig } from './auth-crypto.js';
import { requireAuth, requirePermission, requireRole } from './auth-routes.js';
import type { IdempotencyStore } from './idempotency.js';
import { timezoneToday } from './business-time.js';
import { derivedExpiryStatus } from './stock-domain.js';

const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
const paisaSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
}).strict();
const returnRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  items: z.array(z.object({
    saleItemId: idSchema,
    allocationId: z.string().min(1).max(100),
    quantityBaseUnits: z.number().int().min(1).max(2_147_483_647),
  }).strict()).min(1).max(100),
}).strict().superRefine((request, context) => {
  const allocationIds = request.items.map((item) => item.allocationId);
  if (new Set(allocationIds).size !== allocationIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'Duplicate sale allocation' });
  }
});
const returnProcessSchema = z.object({
  items: z.array(z.object({
    id: idSchema,
    disposition: z.enum(['RESTOCK', 'QUARANTINE', 'WRITE_OFF']),
    sealedIntact: z.boolean(),
    restockUnitId: idSchema.nullable(),
    reason: z.string().trim().max(500).default(''),
  }).strict()).min(1).max(100),
}).strict();
const returnPolicySchema = z.object({
  returnWindowDays: z.number().int().min(0).max(365),
  minimumRestockShelfLifeDays: z.number().int().min(0).max(3650),
}).strict();
const expenseSchema = z.object({
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(1000),
  amountPaisa: paisaSchema.refine((value) => BigInt(value) > 0n),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();
const expenseUpdateSchema = expenseSchema.partial().extend({
  reason: z.string().trim().min(1).max(500),
}).strict();
const expenseVoidSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const printSnapshotSchema = z.object({
  data: z.object({
    kind: z.enum(['SALE', 'RETURN', 'PAYMENT']),
    memoNo: z.string().max(160),
    originalMemoNo: z.string().max(160).optional(),
    dateTime: z.string().max(80),
    customerName: z.string().max(200).optional(),
    lines: z.array(z.object({
      qty: z.number().safe().int().positive(),
      name: z.string().max(200),
      ratePaisa: z.number().safe().int().nonnegative(),
      batch: z.string().max(100).optional(),
      expiry: z.string().max(40).optional(),
    }).strict()).max(200),
    discountPaisa: z.number().safe().int().nonnegative(),
    roundingPaisa: z.number().safe().int().optional(),
    salesTaxPaisa: z.number().safe().int().optional(),
    paidPaisa: z.number().safe().int().optional(),
    changePaisa: z.number().safe().int().optional(),
    paymentMode: z.string().max(80).optional(),
    isCredit: z.boolean().optional(),
    isDuplicate: z.boolean().optional(),
    cashier: z.string().max(160),
    role: z.string().max(80),
    terminal: z.string().max(160),
    amountReceivedPaisa: z.number().safe().int().optional(),
    balanceAfterPaisa: z.number().safe().int().optional(),
  }).strict(),
  settings: z.object({
    storeName: z.string().max(160),
    address: z.string().max(1000),
    phone: z.string().max(80),
    notes: z.tuple([z.string().max(500), z.string().max(500), z.string().max(500)]),
    terminalName: z.string().max(160),
    showBatchExpiry: z.boolean(),
    roundNet: z.enum(['none', '1', '5', '10']),
    printTax: z.boolean(),
    duplicateLabel: z.boolean(),
    numberDigits: z.number().safe().int().min(1).max(16),
  }).strict(),
  format: z.enum(['thermal58', 'thermal80', 'a4']),
  template: z.enum(['simple', 'classic', 'professional', 'modern', 'pharmacy-memo']),
}).strict();
const printRequestSchema = z.object({
  type: z.enum(['sale', 'payment']),
  receiptRef: z.string().trim().min(1).max(160),
  payload: printSnapshotSchema,
}).strict();
const printDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();
const memoSettingsSchema = z.object({
  storeName: z.string().max(160).optional(),
  address: z.string().max(1000).optional(),
  phone: z.string().max(80).optional(),
  notes: z.tuple([z.string().max(500), z.string().max(500), z.string().max(500)]).optional(),
  terminalName: z.string().max(160).optional(),
  showBatchExpiry: z.boolean().optional(),
  roundNet: z.enum(['none', '1', '5', '10']).optional(),
  printTax: z.boolean().optional(),
  duplicateLabel: z.boolean().optional(),
  autoPrint: z.boolean().optional(),
  numberDigits: z.number().safe().int().min(1).max(16).optional(),
}).strict();
const shopSettingsSchema = z.object({
  shopName: z.string().trim().min(1).max(160).optional(),
  profile: z.object({
    displayName: z.string().trim().max(160).optional(),
    address: z.string().trim().max(1000).optional(),
    phone: z.string().trim().max(80).optional(),
    city: z.string().trim().max(160).optional(),
  }).strict().optional(),
  memoSettings: memoSettingsSchema.optional(),
  receiptSettings: z.object({
    format: z.enum(['thermal58', 'thermal80', 'a4']).optional(),
    template: z.enum(['simple', 'classic', 'professional', 'modern', 'pharmacy-memo']).optional(),
  }).strict().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

type Caller = UserRecord;
type ReturnItemRecord = {
  _id: ObjectId;
  saleItemId: ObjectId;
  batchId: ObjectId;
  medicineId: ObjectId;
  medicineName: string;
  batchNumber: string;
  expiryDate: Date;
  drugClass: string;
  storageCondition: string;
  quantityBaseUnits: Long;
  refundPaisa: Long;
  disposition?: 'RESTOCK' | 'QUARANTINE' | 'WRITE_OFF';
  sealedIntact?: boolean;
  restockUnitId?: ObjectId | null;
  reason?: string;
};

function caller(request: FastifyRequest, reply: FastifyReply): Caller | null {
  const user = request.authUser;
  if (!user) {
    void reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return null;
  }
  return user;
}

function asLong(value: unknown): Long {
  if (Long.isLong(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Long.fromString(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return Long.fromNumber(value);
  throw new Error('INVALID_STORED_INTEGER');
}

function safeLong(value: bigint): Long {
  if (value < 0n || value > 9_223_372_036_854_775_807n) throw new Error('AMOUNT_LIMIT_EXCEEDED');
  return Long.fromString(value.toString());
}

function id(value: unknown): string | null {
  return value instanceof ObjectId ? value.toHexString() : null;
}

function audit(user: Caller, event: string, entityType: string, entityId?: ObjectId): AuditRecord {
  return {
    shopId: user.shopId,
    actorId: user._id,
    ...(entityId ? { entityId } : {}),
    event,
    entityType,
    occurredAt: new Date(),
  };
}

async function transaction<T>(client: MongoClient, action: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = client.startSession();
  try {
    let outcome: { value: T } | undefined;
    await session.withTransaction(async () => {
      outcome = { value: await action(session) };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    if (!outcome) throw new Error('TRANSACTION_RESULT_MISSING');
    return outcome.value;
  } finally {
    await session.endSession();
  }
}

async function nextNumber(
  database: ReturnType<MongoClient['db']>,
  session: ClientSession,
  shopId: ObjectId,
  kind: string,
  prefix: string,
): Promise<string> {
  const counter = await database.collection('counters').findOneAndUpdate(
    { shopId, kind },
    { $inc: { lastValue: Long.ONE }, $setOnInsert: { shopId, kind } },
    { upsert: true, returnDocument: 'after', includeResultMetadata: false, session },
  );
  if (!counter) throw new Error('NUMBER_SEQUENCE_UNAVAILABLE');
  return `${prefix}${asLong(counter.lastValue).toString().padStart(6, '0')}`;
}

function containsCostField(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((entry) => containsCostField(entry, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) =>
    /(cost|profit|margin)/i.test(key) || containsCostField(nested, depth + 1),
  );
}

function canPrint(user: Caller, type: 'sale' | 'payment'): boolean {
  return user.role === 'admin' || user.role === 'super_admin'
    || (user.permissions.includes('pos')
      && user.permissions.includes(type === 'sale' ? 'pos_print_sale' : 'pos_print_payment'));
}

function safeReceiptNumber(value: unknown): number {
  const amount = BigInt(asLong(value).toString());
  if (amount < BigInt(Number.MIN_SAFE_INTEGER) || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('RECEIPT_AMOUNT_LIMIT_EXCEEDED');
  }
  return Number(amount);
}

function serverMemoSettings(shop: Document): Record<string, unknown> {
  const memo = (shop.memoSettings ?? {}) as Document;
  const notes = Array.isArray(memo.notes) && memo.notes.length === 3
    ? memo.notes.map((note) => String(note))
    : ['', '', ''];
  return {
    storeName: String(memo.storeName ?? shop.name ?? ''),
    address: String(memo.address ?? (shop.profile as Document | undefined)?.address ?? ''),
    phone: String(memo.phone ?? (shop.profile as Document | undefined)?.phone ?? ''),
    notes,
    terminalName: String(memo.terminalName ?? ''),
    showBatchExpiry: memo.showBatchExpiry !== false,
    roundNet: ['none', '1', '5', '10'].includes(String(memo.roundNet)) ? memo.roundNet : 'none',
    printTax: memo.printTax === true,
    duplicateLabel: false,
    numberDigits: Number.isSafeInteger(memo.numberDigits) && Number(memo.numberDigits) >= 1 && Number(memo.numberDigits) <= 16
      ? Number(memo.numberDigits)
      : 6,
  };
}

function shopSettingsDto(shop: Document, shopId: ObjectId): Record<string, unknown> {
  const profile = (shop.profile ?? {}) as Document;
  const memoSettings = serverMemoSettings(shop);
  memoSettings.autoPrint = (shop.memoSettings as Document | undefined)?.autoPrint === true;
  const receiptSettings = (shop.receiptSettings ?? {}) as Document;
  return {
    id: shopId.toHexString(),
    slug: String(shop.slug),
    name: String(shop.name),
    profile: {
      displayName: String(profile.displayName ?? ''),
      address: String(profile.address ?? ''),
      phone: String(profile.phone ?? ''),
      city: String(profile.city ?? ''),
    },
    receiptSettings: {
      format: ['thermal58', 'thermal80', 'a4'].includes(String(receiptSettings.format))
        ? receiptSettings.format : 'thermal80',
      template: ['simple', 'classic', 'professional', 'modern', 'pharmacy-memo'].includes(String(receiptSettings.template))
        ? receiptSettings.template : 'pharmacy-memo',
    },
    memoSettings,
    timeZone: String(shop.timeZone ?? 'Asia/Karachi'),
  };
}

function returnDto(record: Document): Record<string, unknown> {
  const items = Array.isArray(record.items) ? record.items as ReturnItemRecord[] : [];
  return {
    id: id(record._id),
    returnNumber: record.returnNumber,
    saleId: id(record.saleId),
    invoiceNumber: record.invoiceNumber,
    status: record.status,
    reason: record.reason,
    requestedAt: record.requestedAt,
    requestedByName: record.requestedByName,
    decidedAt: record.decidedAt ?? null,
    decidedByName: record.decidedByName ?? null,
    note: record.note ?? null,
    refundPaisa: asLong(record.refundPaisa ?? Long.ZERO).toString(),
    items: items.map((item) => ({
      id: id(item._id),
      saleItemId: id(item.saleItemId),
      allocationId: `${id(item.saleItemId)}:${id(item.batchId)}`,
      medicineName: item.medicineName,
      batchNumber: item.batchNumber,
      expiryDate: item.expiryDate,
      drugClass: item.drugClass,
      storageCondition: item.storageCondition,
      quantityBaseUnits: asLong(item.quantityBaseUnits).toString(),
      refundPaisa: asLong(item.refundPaisa).toString(),
      disposition: item.disposition ?? null,
      reason: item.reason ?? '',
    })),
  };
}

function dateRangeFilter(from?: string, to?: string, field = 'occurredAt'): Document {
  return from || to ? {
    [field]: {
      ...(from ? { $gte: new Date(`${from}T00:00:00.000Z`) } : {}),
      ...(to ? { $lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000) } : {}),
    },
  } : {};
}

function isRestockAllowed(
  item: ReturnItemRecord,
  sealedIntact: boolean,
  saleDate: Date,
  today: Date,
  policy: { returnWindowDays: number; minimumRestockShelfLifeDays: number },
): boolean {
  if (!sealedIntact || ['CONTROLLED', 'NARCOTIC'].includes(item.drugClass) || item.storageCondition === 'COLD_REFRIGERATED') {
    return false;
  }
  const returnDeadline = new Date(saleDate.getTime() + policy.returnWindowDays * 86_400_000);
  const minimumExpiry = new Date(today.getTime() + policy.minimumRestockShelfLifeDays * 86_400_000);
  return today.getTime() <= returnDeadline.getTime()
    && item.expiryDate.getTime() >= minimumExpiry.getTime()
    && item.expiryDate.getTime() >= today.getTime();
}

export function registerPhaseSevenRoutes(
  app: FastifyInstance,
  client: MongoClient,
  config: AppConfig,
  authRepository: PharmacyRepository,
  tokenConfig: TokenConfig,
  idempotencyStore: IdempotencyStore,
): void {
  const database = client.db(config.mongoDbName);
  const pos = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('pos')];
  const salesHistory = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('sales_history')];
  const expense = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('expenses')];
  const admin = [requireAuth(authRepository, tokenConfig, idempotencyStore), requireRole('admin', 'super_admin')];

  app.get('/api/returns/policy', { preHandler: pos }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const policy = await database.collection('returnPolicySettings').findOne({ shopId: user.shopId });
    return reply.send({
      returnWindowDays: Number(policy?.returnWindowDays ?? 7),
      minimumRestockShelfLifeDays: Number(policy?.minimumRestockShelfLifeDays ?? 90),
    });
  });

  app.patch('/api/returns/policy', { preHandler: [...admin, requirePermission('pos')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = returnPolicySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const now = new Date();
    await transaction(client, async (session) => {
      await database.collection('returnPolicySettings').updateOne(
        { shopId: user.shopId },
        { $set: { ...parsed.data, updatedAt: now, updatedBy: user._id }, $setOnInsert: { shopId: user.shopId } },
        { upsert: true, session },
      );
      await database.collection('auditLogs').insertOne(audit(user, 'return_policy.updated', 'return_policy'), { session });
    });
    return reply.send(parsed.data);
  });

  app.get('/api/returns/sales/:invoiceNumber', { preHandler: pos }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const invoiceNumber = String((request.params as { invoiceNumber: string }).invoiceNumber).trim();
    if (!invoiceNumber || invoiceNumber.length > 80) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const sale = await database.collection('sales').findOne({
      shopId: user.shopId,
      invoiceNumber,
      status: 'COMPLETED',
    });
    if (!sale) return reply.code(404).send({ error: 'NOT_FOUND' });
    const existing = await database.collection('saleReturns').find({
      shopId: user.shopId,
      saleId: sale._id,
      status: { $in: ['PENDING', 'APPROVED', 'COMPLETED'] },
    }).toArray();
    const returned = new Map<string, bigint>();
    for (const requestRecord of existing) {
      for (const item of (requestRecord.items ?? []) as ReturnItemRecord[]) {
        const key = `${id(item.saleItemId)}:${id(item.batchId)}`;
        returned.set(key, (returned.get(key) ?? 0n) + BigInt(asLong(item.quantityBaseUnits).toString()));
      }
    }
    return reply.send({
      id: id(sale._id),
      invoiceNumber: sale.invoiceNumber,
      saleDate: sale.soldAt,
      customerName: sale.customerName,
      items: ((sale.items ?? []) as Array<Document>).flatMap((saleItem) =>
        ((saleItem.batchAllocations ?? []) as Array<Document>).map((allocation) => {
          const saleItemId = saleItem._id as ObjectId;
          const batchId = allocation.batchId as ObjectId;
          const key = `${saleItemId.toHexString()}:${batchId.toHexString()}`;
          return {
            saleItemId: saleItemId.toHexString(),
            allocationId: key,
            medicineName: saleItem.medicineName,
            batchNumber: allocation.batchNumber,
            expiryDate: allocation.expiryDate,
            quantityBaseUnits: asLong(allocation.quantityBaseUnits).toString(),
            alreadyReturnedBaseUnits: (returned.get(key) ?? 0n).toString(),
          };
        }),
      ),
    });
  });

  app.post('/api/sales/:id/returns', { preHandler: pos }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsed = returnRequestSchema.safeParse(request.body);
    if (!parsedId.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const saleId = new ObjectId(parsedId.data);
    try {
      const created = await transaction(client, async (session) => {
        const sale = await database.collection('sales').findOne({
          _id: saleId, shopId: user.shopId, status: 'COMPLETED',
        }, { session });
        if (!sale) throw new Error('SALE_NOT_FOUND');
        const policy = await database.collection('returnPolicySettings').findOne({ shopId: user.shopId }, { session });
        const returnWindowDays = Number(policy?.returnWindowDays ?? 7);
        const today = timezoneToday((await authRepository.findShopById(user.shopId))?.timeZone ?? 'Asia/Karachi');
        if (today.getTime() > new Date((sale.soldAt as Date).getTime() + returnWindowDays * 86_400_000).getTime()) {
          throw new Error('RETURN_WINDOW_CLOSED');
        }
        const activeReturns = await database.collection('saleReturns').find({
          shopId: user.shopId,
          saleId,
          status: { $in: ['PENDING', 'APPROVED', 'COMPLETED'] },
        }, { session }).toArray();
        const reserved = new Map<string, bigint>();
        for (const previous of activeReturns) {
          for (const item of (previous.items ?? []) as ReturnItemRecord[]) {
            const key = `${id(item.saleItemId)}:${id(item.batchId)}`;
            reserved.set(key, (reserved.get(key) ?? 0n) + BigInt(asLong(item.quantityBaseUnits).toString()));
          }
        }
        const saleItems = (sale.items ?? []) as Array<Document>;
        const items: ReturnItemRecord[] = [];
        for (const requested of parsed.data.items) {
          const saleItem = saleItems.find((item) => id(item._id) === requested.saleItemId);
          if (!saleItem) throw new Error('RETURN_QUANTITY_EXCEEDS_SOLD');
          const allocation = ((saleItem.batchAllocations ?? []) as Array<Document>).find((entry) => {
            return `${id(saleItem._id)}:${id(entry.batchId)}` === requested.allocationId;
          });
          if (!allocation) throw new Error('RETURN_QUANTITY_EXCEEDS_SOLD');
          const key = requested.allocationId;
          const soldQty = BigInt(asLong(allocation.quantityBaseUnits).toString());
          const requestedQty = BigInt(requested.quantityBaseUnits);
          if (requestedQty + (reserved.get(key) ?? 0n) > soldQty) throw new Error('RETURN_QUANTITY_EXCEEDS_SOLD');
          const itemQty = BigInt(asLong(saleItem.quantityBaseUnits).toString());
          const lineTotal = BigInt(asLong(saleItem.lineTotalPaisa).toString());
          const medicine = await database.collection('medicines').findOne({
            _id: saleItem.medicineId, shopId: user.shopId,
          }, { session });
          if (!medicine) throw new Error('RETURN_MEDICINE_NOT_FOUND');
          const drugClasses = [saleItem.drugClass, medicine.drugClass].map((value) => String(value ?? 'OTC'));
          const drugClass = drugClasses.includes('NARCOTIC') ? 'NARCOTIC'
            : drugClasses.includes('CONTROLLED') ? 'CONTROLLED'
              : String(saleItem.drugClass ?? medicine.drugClass ?? 'OTC');
          items.push({
            _id: new ObjectId(),
            saleItemId: saleItem._id as ObjectId,
            batchId: allocation.batchId as ObjectId,
            medicineId: saleItem.medicineId as ObjectId,
            medicineName: String(saleItem.medicineName),
            batchNumber: String(allocation.batchNumber),
            expiryDate: allocation.expiryDate as Date,
            drugClass,
            storageCondition: String(saleItem.storageCondition ?? medicine.storageCondition ?? ''),
            quantityBaseUnits: safeLong(requestedQty),
            refundPaisa: safeLong(lineTotal * requestedQty / itemQty),
          });
        }
        const reservation = await database.collection('sales').updateOne(
          { _id: saleId, shopId: user.shopId, status: 'COMPLETED' },
          { $inc: { returnReservationVersion: Long.ONE } },
          { session },
        );
        if (reservation.modifiedCount !== 1) throw new Error('SALE_CHANGED_DURING_RETURN');
        const now = new Date();
        const returnId = new ObjectId();
        const returnNumber = await nextNumber(database, session, user.shopId, 'RETURN', 'RTN-');
        const refund = items.reduce((sum, item) => sum + BigInt(item.refundPaisa.toString()), 0n);
        const record = {
          _id: returnId,
          shopId: user.shopId,
          saleId,
          invoiceNumber: String(sale.invoiceNumber),
          returnNumber,
          status: 'PENDING',
          reason: parsed.data.reason,
          requestedBy: user._id,
          requestedByName: user.fullName,
          requestedAt: now,
          items,
          refundPaisa: safeLong(refund),
        };
        await database.collection('saleReturns').insertOne(record, { session });
        await database.collection('auditLogs').insertOne(audit(user, 'sale.return_requested', 'sale_return', returnId), { session });
        return record;
      });
      return reply.code(201).send(returnDto(created));
    } catch (error) {
      const status = error instanceof Error && error.message === 'RETURN_QUANTITY_EXCEEDS_SOLD' ? 409
        : error instanceof Error && error.message === 'RETURN_WINDOW_CLOSED' ? 400
          : error instanceof Error && error.message === 'SALE_CHANGED_DURING_RETURN' ? 409
            : error instanceof Error && error.message === 'SALE_NOT_FOUND' ? 404 : 500;
      if (status !== 500) return reply.code(status).send({ error: error instanceof Error ? error.message : 'RETURN_FAILED' });
      throw error;
    }
  });

  app.get('/api/returns/pending', { preHandler: [...salesHistory, requireRole('manager', 'admin', 'super_admin')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const rows = await database.collection('saleReturns').find({
      shopId: user.shopId, status: { $in: ['PENDING', 'APPROVED'] },
    })
      .sort({ requestedAt: 1, _id: 1 }).limit(200).toArray();
    return reply.send({ items: rows.map(returnDto) });
  });

  app.post('/api/returns/:id/approve', { preHandler: [...salesHistory, requireRole('manager', 'admin', 'super_admin')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsed = z.object({ note: z.string().trim().max(500).optional().default('') }).strict().safeParse(request.body);
    if (!parsedId.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const returnId = new ObjectId(parsedId.data);
    const result = await transaction(client, async (session) => {
      const record = await database.collection('saleReturns').findOne({
        _id: returnId, shopId: user.shopId, status: 'PENDING',
      }, { session });
      if (!record) return null;
      const saleUpdate = await database.collection('sales').updateOne(
        { _id: record.saleId, shopId: user.shopId, status: 'COMPLETED' },
        { $inc: { returnReservationVersion: Long.ONE } },
        { session },
      );
      if (saleUpdate.modifiedCount !== 1) throw new Error('SALE_CHANGED_DURING_RETURN');
      const updated = await database.collection('saleReturns').findOneAndUpdate(
        { _id: returnId, shopId: user.shopId, status: 'PENDING' },
        { $set: {
          status: 'APPROVED', note: parsed.data.note, decidedBy: user._id,
          decidedByName: user.fullName, decidedAt: new Date(),
        } },
        { returnDocument: 'after', includeResultMetadata: false, session },
      );
      if (!updated) return null;
      await database.collection('auditLogs').insertOne(audit(user, 'sale.return_approved', 'sale_return', returnId), { session });
      return updated;
    });
    if (!result) return reply.code(409).send({ error: 'RETURN_ALREADY_PROCESSED' });
    return reply.send(returnDto(result));
  });

  app.post('/api/returns/:id/reject', { preHandler: [...salesHistory, requireRole('manager', 'admin', 'super_admin')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsed = expenseVoidSchema.safeParse(request.body);
    if (!parsedId.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const returnId = new ObjectId(parsedId.data);
    const rejected = await transaction(client, async (session) => {
      const result = await database.collection('saleReturns').findOneAndUpdate(
        { _id: returnId, shopId: user.shopId, status: 'PENDING' },
        { $set: { status: 'REJECTED', note: parsed.data.reason, decidedBy: user._id, decidedByName: user.fullName, decidedAt: new Date() } },
        { returnDocument: 'after', includeResultMetadata: false, session },
      );
      if (!result) return null;
      await database.collection('auditLogs').insertOne(audit(user, 'sale.return_rejected', 'sale_return', returnId), { session });
      return result;
    });
    if (!rejected) return reply.code(409).send({ error: 'RETURN_ALREADY_PROCESSED' });
    return reply.send(returnDto(rejected));
  });

  app.post('/api/returns/:id/process', { preHandler: [...salesHistory, requireRole('manager', 'admin', 'super_admin')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsed = returnProcessSchema.safeParse(request.body);
    if (!parsedId.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const returnId = new ObjectId(parsedId.data);
    try {
      const result = await transaction(client, async (session) => {
        const returns = database.collection('saleReturns');
        const record = await returns.findOne({ _id: returnId, shopId: user.shopId, status: 'APPROVED' }, { session });
        if (!record) return null;
        const sale = await database.collection('sales').findOne({ _id: record.saleId, shopId: user.shopId }, { session });
        if (!sale || sale.status !== 'COMPLETED') throw new Error('SALE_NOT_FOUND');
        const decisions = new Map(parsed.data.items.map((item) => [item.id, item]));
        const items = record.items as ReturnItemRecord[];
        if (items.length !== decisions.size || items.some((item) => !decisions.has(item._id.toHexString()))) {
          throw new Error('RETURN_DECISIONS_INCOMPLETE');
        }
        const reservation = await database.collection('sales').updateOne(
          { _id: sale._id, shopId: user.shopId, status: 'COMPLETED' },
          { $inc: { returnReservationVersion: Long.ONE } },
          { session },
        );
        if (reservation.modifiedCount !== 1) throw new Error('SALE_CHANGED_DURING_RETURN');
        const policyDoc = await database.collection('returnPolicySettings').findOne({ shopId: user.shopId }, { session });
        const policy = {
          returnWindowDays: Number(policyDoc?.returnWindowDays ?? 7),
          minimumRestockShelfLifeDays: Number(policyDoc?.minimumRestockShelfLifeDays ?? 90),
        };
        const shop = await authRepository.findShopById(user.shopId);
        const today = timezoneToday(shop?.timeZone ?? 'Asia/Karachi');
        const saleDate = sale.soldAt as Date;
        let refund = 0n;
        const movements: Document[] = [];
        for (const item of items) {
          const decision = decisions.get(item._id.toHexString())!;
          if (decision.disposition === 'RESTOCK') {
            if (!user.permissions.includes('stock_inventory')) throw new Error('STOCK_PERMISSION_REQUIRED');
            if (!isRestockAllowed(item, decision.sealedIntact, saleDate, today, policy)) {
              throw new Error('RESTOCK_NOT_ALLOWED');
            }
            if (!decision.restockUnitId) throw new Error('RESTOCK_UNIT_REQUIRED');
            const unit = await database.collection('medicineUnits').findOne({
              _id: new ObjectId(decision.restockUnitId),
              shopId: user.shopId,
              medicineId: item.medicineId,
              deletedAt: null,
            }, { session });
            const factor = Number(unit?.conversionFactorBaseUnits);
            if (!unit || !Number.isSafeInteger(factor) || factor <= 0
              || BigInt(asLong(item.quantityBaseUnits).toString()) % BigInt(factor) !== 0n) {
              throw new Error('RESTOCK_UNIT_INVALID');
            }
          }
          const batchId = new ObjectId();
          const batchQty = asLong(item.quantityBaseUnits);
          const batchStatus = decision.disposition === 'RESTOCK'
            ? derivedExpiryStatus(item.expiryDate, batchQty, today)
            : 'QUARANTINE';
          const originalBatch = await database.collection('stockBatches').findOne({
            _id: item.batchId, shopId: user.shopId,
          }, { session });
          if (!originalBatch) throw new Error('RETURN_BATCH_NOT_FOUND');
          await database.collection('stockBatches').insertOne({
            ...originalBatch,
            _id: batchId,
            quantityReceivedBaseUnits: batchQty,
            quantityRemainingBaseUnits: batchQty,
            quantityReturnedBaseUnits: Long.ZERO,
            status: batchStatus,
            receivedDate: today,
            purchaseId: originalBatch.purchaseId,
            returnId,
            createdAt: new Date(),
            updatedAt: new Date(),
          }, { session });
          movements.push({
            _id: new ObjectId(), shopId: user.shopId, batchId, medicineId: item.medicineId,
            movementType: 'SALE_RETURN', quantityDeltaBaseUnits: batchQty,
            referenceType: 'SALE_RETURN', referenceId: returnId,
            reason: decision.reason || `Return ${record.returnNumber}`, actorId: user._id, createdAt: new Date(),
          });
          if (decision.disposition === 'WRITE_OFF') {
            await database.collection('stockBatches').updateOne(
              { _id: batchId, shopId: user.shopId },
              { $set: { quantityRemainingBaseUnits: Long.ZERO, status: 'DAMAGED' } },
              { session },
            );
            movements.push({
              _id: new ObjectId(), shopId: user.shopId, batchId, medicineId: item.medicineId,
              movementType: 'WRITE_OFF', quantityDeltaBaseUnits: Long.fromString(`-${batchQty.toString()}`),
              referenceType: 'SALE_RETURN', referenceId: returnId,
              reason: decision.reason || 'Returned item written off', actorId: user._id, createdAt: new Date(),
            });
          }
          item.disposition = decision.disposition;
          item.sealedIntact = decision.sealedIntact;
          item.restockUnitId = decision.restockUnitId ? new ObjectId(decision.restockUnitId) : null;
          item.reason = decision.reason;
          refund += BigInt(asLong(item.refundPaisa).toString());
        }
        const now = new Date();
        if (movements.length) await database.collection('stockMovements').insertMany(movements, { session });
        const salePayments = await database.collection('salePayments').find({ shopId: user.shopId, saleId: sale._id }, { session }).toArray();
        const isCreditSale = salePayments.length === 1 && salePayments[0]?.method === 'CREDIT';
        if (isCreditSale && sale.customerId instanceof ObjectId) {
          const customer = await database.collection('customers').findOne({ _id: sale.customerId, shopId: user.shopId }, { session });
          if (customer) {
            const balance = BigInt(asLong(customer.currentBalancePaisa).toString());
            const applied = refund < balance ? refund : balance;
            const credit = refund - applied;
            const after = balance - applied;
            await database.collection('customers').updateOne(
              { _id: customer._id, shopId: user.shopId },
              { $set: { currentBalancePaisa: safeLong(after), storeCreditPaisa: safeLong(BigInt(asLong(customer.storeCreditPaisa).toString()) + credit), updatedAt: now } },
              { session },
            );
            await database.collection('customerLedger').insertOne({
              shopId: user.shopId, customerId: customer._id, referenceType: 'SALE_RETURN',
              referenceId: returnId, entryType: 'RETURN', description: `Return ${record.returnNumber}`,
              debitPaisa: Long.ZERO, creditPaisa: safeLong(refund), runningBalancePaisa: safeLong(after),
              createdBy: user._id, createdAt: now,
            }, { session });
          }
        } else if (refund > 0n) {
          const saleTotal = BigInt(asLong(sale.totalPaisa).toString());
          let allocated = 0n;
          for (const [index, payment] of salePayments.entries()) {
            const amount = BigInt(asLong(payment.amountPaisa).toString());
            const portion = index === salePayments.length - 1
              ? refund - allocated
              : refund * amount / saleTotal;
            allocated += portion;
            if (portion === 0n) continue;
            await database.collection('cashBookEntries').insertOne({
              shopId: user.shopId, entryType: `SALE_RETURN_PAYOUT_${payment.method}`,
              direction: 'OUT', amountPaisa: safeLong(portion),
              referenceType: 'SALE_RETURN', referenceId: returnId,
              paymentMethod: payment.method, actorId: user._id, createdAt: now,
            }, { session });
          }
        }
        const updated = await returns.findOneAndUpdate(
          { _id: returnId, shopId: user.shopId, status: 'APPROVED' },
          { $set: { status: 'COMPLETED', items, refundPaisa: safeLong(refund), decidedBy: user._id, decidedByName: user.fullName, decidedAt: now } },
          { returnDocument: 'after', includeResultMetadata: false, session },
        );
        if (!updated) throw new Error('RETURN_ALREADY_PROCESSED');
        await database.collection('auditLogs').insertOne(audit(user, 'sale.return_processed', 'sale_return', returnId), { session });
        return updated;
      });
      if (!result) return reply.code(409).send({ error: 'RETURN_ALREADY_PROCESSED' });
      return reply.send(returnDto(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const status = message === 'STOCK_PERMISSION_REQUIRED' ? 403
        : ['RESTOCK_NOT_ALLOWED', 'RESTOCK_UNIT_REQUIRED', 'RESTOCK_UNIT_INVALID', 'RETURN_DECISIONS_INCOMPLETE'].includes(message) ? 400
          : ['RETURN_ALREADY_PROCESSED', 'RETURN_QUANTITY_EXCEEDS_SOLD'].includes(message) ? 409
            : message === 'RETURN_BATCH_NOT_FOUND' || message === 'SALE_NOT_FOUND' ? 404
              : message === 'SALE_CHANGED_DURING_RETURN' ? 409 : 500;
      if (status !== 500) return reply.code(status).send({ error: message });
      throw error;
    }
  });

  app.get('/api/returns/:id/memo', { preHandler: pos }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsedId.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const record = await database.collection('saleReturns').findOne({
      _id: new ObjectId(parsedId.data), shopId: user.shopId, status: 'COMPLETED',
    });
    if (!record) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send({
      ...returnDto(record),
      memo: {
        returnNumber: record.returnNumber,
        invoiceNumber: record.invoiceNumber,
        returnedAt: record.decidedAt,
        refundPaisa: asLong(record.refundPaisa).toString(),
        items: (record.items as ReturnItemRecord[]).map((item) => ({
          medicineName: item.medicineName,
          batchNumber: item.batchNumber,
          quantityBaseUnits: asLong(item.quantityBaseUnits).toString(),
          refundPaisa: asLong(item.refundPaisa).toString(),
          disposition: item.disposition,
        })),
      },
    });
  });

  app.post('/api/sales/:id/void', { preHandler: [...salesHistory, requireRole('admin', 'super_admin')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsed = expenseVoidSchema.safeParse(request.body);
    if (!parsedId.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const saleId = new ObjectId(parsedId.data);
    try {
      const result = await transaction(client, async (session) => {
        const sales = database.collection('sales');
        const sale = await sales.findOne({ _id: saleId, shopId: user.shopId, status: 'COMPLETED' }, { session });
        if (!sale) return null;
        const returns = await database.collection('saleReturns').findOne({
          shopId: user.shopId, saleId, status: { $in: ['PENDING', 'APPROVED', 'COMPLETED'] },
        }, { session });
        if (returns) throw new Error('SALE_HAS_RETURN');
        const now = new Date();
        const shop = await authRepository.findShopById(user.shopId);
        if (!shop) throw new Error('SHOP_NOT_FOUND');
        const today = timezoneToday(shop.timeZone ?? 'Asia/Karachi');
        for (const saleItem of (sale.items ?? []) as Array<Document>) {
          for (const allocation of (saleItem.batchAllocations ?? []) as Array<Document>) {
            const qty = asLong(allocation.quantityBaseUnits);
            const batches = database.collection('stockBatches');
            const before = await batches.findOne({ _id: allocation.batchId, shopId: user.shopId }, { session });
            if (!before) throw new Error('SALE_BATCH_NOT_FOUND');
            const nextQuantity = safeLong(BigInt(asLong(before.quantityRemainingBaseUnits).toString()) + BigInt(qty.toString()));
            const batch = await batches.findOneAndUpdate(
              { _id: allocation.batchId, shopId: user.shopId, quantityRemainingBaseUnits: asLong(before.quantityRemainingBaseUnits) },
              { $set: {
                quantityRemainingBaseUnits: nextQuantity,
                status: derivedExpiryStatus(before.expiryDate as Date, nextQuantity, today),
                updatedAt: now,
              } },
              { returnDocument: 'after', includeResultMetadata: false, session },
            );
            if (!batch) throw new Error('SALE_BATCH_NOT_FOUND');
            await database.collection('stockMovements').insertOne({
              _id: new ObjectId(), shopId: user.shopId, batchId: allocation.batchId,
              medicineId: saleItem.medicineId, movementType: 'SALE_RETURN',
              quantityDeltaBaseUnits: qty, referenceType: 'SALE_VOID', referenceId: saleId,
              reason: parsed.data.reason, actorId: user._id, createdAt: now,
            }, { session });
          }
        }
        const payments = await database.collection('salePayments').find({ shopId: user.shopId, saleId }, { session }).toArray();
        const cashPaid = payments.filter((payment) => payment.method === 'CASH')
          .reduce((sum, payment) => sum + BigInt(asLong(payment.amountPaisa).toString()), 0n);
        if (cashPaid > 0n) {
          await database.collection('cashBookEntries').insertOne({
            shopId: user.shopId, entryType: 'SALE_VOID_PAYOUT', direction: 'OUT', amountPaisa: safeLong(cashPaid),
            referenceType: 'SALE_VOID', referenceId: saleId, paymentMethod: 'CASH', actorId: user._id, createdAt: now,
          }, { session });
        }
        if (sale.paymentMethod === 'CREDIT' && sale.customerId instanceof ObjectId) {
          const customer = await database.collection('customers').findOne({ _id: sale.customerId, shopId: user.shopId }, { session });
          if (customer) {
            const balance = BigInt(asLong(customer.currentBalancePaisa).toString());
            const saleTotal = BigInt(asLong(sale.totalPaisa).toString());
            const applied = saleTotal < balance ? saleTotal : balance;
            const credit = saleTotal - applied;
            const balanceAfter = balance - applied;
            const storeCreditAfter = BigInt(asLong(customer.storeCreditPaisa).toString()) + credit;
            await database.collection('customers').updateOne(
              { _id: customer._id, shopId: user.shopId },
              { $set: { currentBalancePaisa: safeLong(balanceAfter), storeCreditPaisa: safeLong(storeCreditAfter), updatedAt: now } },
              { session },
            );
            await database.collection('customerLedger').insertOne({
              _id: new ObjectId(), shopId: user.shopId, customerId: customer._id,
              referenceType: 'SALE_VOID', referenceId: saleId, entryType: 'SALE_VOID',
              referenceNumber: sale.invoiceNumber, description: parsed.data.reason,
              debitPaisa: Long.ZERO, creditPaisa: safeLong(saleTotal),
              runningBalancePaisa: safeLong(balanceAfter), createdBy: user._id, createdAt: now,
            }, { session });
          }
        }
        const updated = await sales.findOneAndUpdate(
          { _id: saleId, shopId: user.shopId, status: 'COMPLETED' },
          { $set: { status: 'VOID', voidedAt: now, voidedBy: user._id, voidReason: parsed.data.reason } },
          { returnDocument: 'after', includeResultMetadata: false, session },
        );
        if (!updated) throw new Error('SALE_ALREADY_VOID');
        await database.collection('auditLogs').insertOne(audit(user, 'sale.voided', 'sale', saleId), { session });
        return { id: saleId.toHexString(), status: 'VOID' };
      });
      if (!result) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'SALE_HAS_RETURN' || message === 'SALE_ALREADY_VOID') return reply.code(409).send({ error: message });
      if (message === 'SALE_BATCH_NOT_FOUND') return reply.code(409).send({ error: 'SALE_BATCH_NOT_FOUND' });
      throw error;
    }
  });

  app.get('/api/expenses', { preHandler: expense }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = pageSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const filter = { shopId: user.shopId, ...dateRangeFilter(parsed.data.dateFrom, parsed.data.dateTo) };
    const collection = database.collection('expenses');
    const [items, total] = await Promise.all([
      collection.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((parsed.data.page - 1) * parsed.data.pageSize).limit(parsed.data.pageSize).toArray(),
      collection.countDocuments(filter),
    ]);
    return reply.send({
      items: items.map((item) => ({
        id: id(item._id), category: item.category, description: item.description,
        amountPaisa: asLong(item.amountPaisa).toString(), occurredAt: item.occurredAt,
        status: item.status, createdByName: item.createdByName,
      })),
      total, page: parsed.data.page, pageSize: parsed.data.pageSize,
    });
  });

  app.post('/api/expenses', { preHandler: expense }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = expenseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const expenseId = new ObjectId();
    const occurredAt = new Date(parsed.data.occurredAt);
    await transaction(client, async (session) => {
      await database.collection('expenses').insertOne({
        _id: expenseId, shopId: user.shopId, category: parsed.data.category,
        description: parsed.data.description, amountPaisa: Long.fromString(parsed.data.amountPaisa),
        occurredAt, status: 'ACTIVE', createdBy: user._id, createdByName: user.fullName,
        createdAt: new Date(), updatedAt: new Date(),
      }, { session });
      await database.collection('cashBookEntries').insertOne({
        shopId: user.shopId, entryType: 'EXPENSE', direction: 'OUT',
        amountPaisa: Long.fromString(parsed.data.amountPaisa), referenceType: 'EXPENSE',
        referenceId: expenseId, sourceExpenseId: expenseId, paymentMethod: 'CASH', actorId: user._id,
        createdAt: occurredAt, description: parsed.data.description,
      }, { session });
      await database.collection('auditLogs').insertOne(audit(user, 'expense.created', 'expense', expenseId), { session });
    });
    return reply.code(201).send({ id: expenseId.toHexString(), ...parsed.data, status: 'ACTIVE' });
  });

  app.patch('/api/expenses/:id', { preHandler: expense }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsed = expenseUpdateSchema.safeParse(request.body);
    if (!parsedId.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const expenseId = new ObjectId(parsedId.data);
    const updated = await transaction(client, async (session) => {
      const expenses = database.collection('expenses');
      const before = await expenses.findOne({ _id: expenseId, shopId: user.shopId, status: 'ACTIVE' }, { session });
      if (!before) return null;
      const amount = parsed.data.amountPaisa ? BigInt(parsed.data.amountPaisa) : BigInt(asLong(before.amountPaisa).toString());
      const oldAmount = BigInt(asLong(before.amountPaisa).toString());
      const delta = amount - oldAmount;
      const occurredAt = parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : before.occurredAt as Date;
      const dateChanged = occurredAt.getTime() !== (before.occurredAt as Date).getTime();
      const changes = {
        ...(parsed.data.category ? { category: parsed.data.category } : {}),
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        ...(parsed.data.amountPaisa ? { amountPaisa: safeLong(amount) } : {}),
        ...(parsed.data.occurredAt ? { occurredAt } : {}),
        updatedAt: new Date(), updatedBy: user._id, editReason: parsed.data.reason,
      };
      await expenses.updateOne({ _id: expenseId, shopId: user.shopId, status: 'ACTIVE' }, { $set: changes }, { session });
      if (dateChanged) {
        await database.collection('cashBookEntries').insertMany([
          {
            shopId: user.shopId, entryType: 'EXPENSE_DATE_REVERSAL', direction: 'IN',
            amountPaisa: safeLong(oldAmount), referenceType: 'EXPENSE_DATE_ADJUSTMENT',
            referenceId: new ObjectId(), sourceExpenseId: expenseId, paymentMethod: 'CASH', actorId: user._id,
            createdAt: before.occurredAt, description: parsed.data.reason,
          },
          {
            shopId: user.shopId, entryType: 'EXPENSE_DATE_REPLACEMENT', direction: 'OUT',
            amountPaisa: safeLong(amount), referenceType: 'EXPENSE_DATE_ADJUSTMENT',
            referenceId: new ObjectId(), sourceExpenseId: expenseId, paymentMethod: 'CASH', actorId: user._id,
            createdAt: occurredAt, description: parsed.data.reason,
          },
        ], { session });
      } else if (delta !== 0n) {
        await database.collection('cashBookEntries').insertOne({
          shopId: user.shopId, entryType: 'EXPENSE_ADJUSTMENT', direction: delta > 0n ? 'OUT' : 'IN',
          amountPaisa: safeLong(delta > 0n ? delta : -delta), referenceType: 'EXPENSE_ADJUSTMENT',
          referenceId: new ObjectId(), sourceExpenseId: expenseId, paymentMethod: 'CASH', actorId: user._id, createdAt: new Date(),
          description: parsed.data.reason,
        }, { session });
      }
      await database.collection('auditLogs').insertOne(audit(user, 'expense.updated', 'expense', expenseId), { session });
      return { id: expenseId.toHexString(), ...before, ...changes, status: 'ACTIVE', ...(parsed.data.amountPaisa ? { amountPaisa: safeLong(amount) } : {}) };
    });
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send({
      id: updated.id, category: updated.category, description: updated.description,
      amountPaisa: asLong(updated.amountPaisa).toString(), occurredAt: updated.occurredAt, status: updated.status,
    });
  });

  app.post('/api/expenses/:id/void', { preHandler: [...expense, requireRole('admin', 'super_admin')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsed = expenseVoidSchema.safeParse(request.body);
    if (!parsedId.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const expenseId = new ObjectId(parsedId.data);
    const result = await transaction(client, async (session) => {
      const expenses = database.collection('expenses');
      const item = await expenses.findOneAndUpdate(
        { _id: expenseId, shopId: user.shopId, status: 'ACTIVE' },
        { $set: { status: 'VOID', voidReason: parsed.data.reason, voidedAt: new Date(), voidedBy: user._id } },
        { returnDocument: 'after', includeResultMetadata: false, session },
      );
      if (!item) return null;
      await database.collection('cashBookEntries').insertOne({
        shopId: user.shopId, entryType: 'EXPENSE_VOID', direction: 'IN',
        amountPaisa: asLong(item.amountPaisa), referenceType: 'EXPENSE_VOID', referenceId: expenseId,
        paymentMethod: 'CASH', actorId: user._id, createdAt: new Date(), description: parsed.data.reason,
      }, { session });
      await database.collection('auditLogs').insertOne(audit(user, 'expense.voided', 'expense', expenseId), { session });
      return { id: expenseId.toHexString(), status: 'VOID' };
    });
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND_OR_VOID' });
    return reply.send(result);
  });

  app.get('/api/cash-book', { preHandler: [requireAuth(authRepository, tokenConfig), requirePermission('expenses')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = pageSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const filter = { shopId: user.shopId, ...dateRangeFilter(parsed.data.dateFrom, parsed.data.dateTo, 'createdAt') };
    const collection = database.collection('cashBookEntries');
    const [items, total] = await Promise.all([
      collection.find(filter).sort({ createdAt: -1, _id: -1 }).skip((parsed.data.page - 1) * parsed.data.pageSize).limit(parsed.data.pageSize).toArray(),
      collection.countDocuments(filter),
    ]);
    const totals = await collection.aggregate([
      { $match: { ...filter, paymentMethod: 'CASH' } },
      { $group: {
        _id: '$direction',
        total: { $sum: '$amountPaisa' },
      } },
    ]).toArray();
    const inflow = asLong(totals.find((row) => row._id === 'IN')?.total ?? Long.ZERO).toString();
    const outflow = asLong(totals.find((row) => row._id === 'OUT')?.total ?? Long.ZERO).toString();
    return reply.send({
      items: items.map((item) => ({
        id: id(item._id), type: item.entryType, direction: item.direction,
        amountPaisa: asLong(item.amountPaisa).toString(), description: item.description ?? item.entryType,
        paymentMethod: item.paymentMethod, createdAt: item.createdAt, referenceType: item.referenceType,
        referenceId: id(item.referenceId),
      })),
      totals: { inflowPaisa: inflow, outflowPaisa: outflow, expectedDrawerPaisa: (BigInt(inflow) - BigInt(outflow)).toString() },
      total, page: parsed.data.page, pageSize: parsed.data.pageSize,
    });
  });

  app.get('/api/dashboard/summary', { preHandler: [requireAuth(authRepository, tokenConfig), requirePermission('reports')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const shop = await authRepository.findShopById(user.shopId);
    if (!shop) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const today = timezoneToday(shop.timeZone ?? 'Asia/Karachi');
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const [sales, returns, stock, lowStockRows, nearExpiry, expenses] = await Promise.all([
      database.collection('sales').aggregate([
        { $match: { shopId: user.shopId, status: 'COMPLETED', soldAt: { $gte: today, $lt: tomorrow } } },
        { $group: { _id: null, total: { $sum: '$totalPaisa' }, count: { $sum: 1 } } },
      ]).toArray(),
      database.collection('saleReturns').aggregate([
        { $match: { shopId: user.shopId, status: 'COMPLETED', decidedAt: { $gte: today, $lt: tomorrow } } },
        { $group: { _id: null, total: { $sum: '$refundPaisa' } } },
      ]).toArray(),
      database.collection('stockBatches').aggregate([
        { $match: { shopId: user.shopId, quantityRemainingBaseUnits: { $gt: Long.ZERO }, status: { $in: ['ACTIVE', 'NEAR_EXPIRY'] }, expiryDate: { $gte: today } } },
        { $group: { _id: null, quantity: { $sum: '$quantityRemainingBaseUnits' } } },
      ]).toArray(),
      database.collection('stockBatches').aggregate([
        { $match: {
          shopId: user.shopId, quantityRemainingBaseUnits: { $gt: Long.ZERO },
          expiryDate: { $gte: today }, status: { $in: ['ACTIVE', 'NEAR_EXPIRY'] },
        } },
        { $group: { _id: '$medicineId', quantity: { $sum: '$quantityRemainingBaseUnits' } } },
        { $lookup: {
          from: 'medicines', localField: '_id', foreignField: '_id', as: 'medicine',
        } },
        { $unwind: '$medicine' },
        { $match: {
          'medicine.shopId': user.shopId, 'medicine.isActive': true,
          'medicine.minStockAlert': { $gt: 0 },
          $expr: { $lte: ['$quantity', '$medicine.minStockAlert'] },
        } },
        { $count: 'count' },
      ]).toArray(),
      database.collection('stockBatches').countDocuments({
        shopId: user.shopId, quantityRemainingBaseUnits: { $gt: Long.ZERO },
        status: { $in: ['ACTIVE', 'NEAR_EXPIRY'] },
        expiryDate: { $gte: today, $lt: new Date(today.getTime() + 30 * 86_400_000) },
      }),
      database.collection('expenses').aggregate([
        { $match: { shopId: user.shopId, status: 'ACTIVE', occurredAt: { $gte: today, $lt: tomorrow } } },
        { $group: { _id: null, total: { $sum: '$amountPaisa' } } },
      ]).toArray(),
    ]);
    const gross = BigInt(asLong(sales[0]?.total ?? Long.ZERO).toString());
    const refunded = BigInt(asLong(returns[0]?.total ?? Long.ZERO).toString());
    return reply.send({
      todaySalesPaisa: (gross - refunded).toString(),
      grossSalesPaisa: gross.toString(),
      returnsPaisa: refunded.toString(),
      saleCount: Number(sales[0]?.count ?? 0),
      sellableStockBaseUnits: asLong(stock[0]?.quantity ?? Long.ZERO).toString(),
      lowStockMedicines: Number(lowStockRows[0]?.count ?? 0),
      nearExpiryBatches: nearExpiry,
      expensesPaisa: asLong(expenses[0]?.total ?? Long.ZERO).toString(),
    });
  });

  app.get('/api/reports/sales', { preHandler: [requireAuth(authRepository, tokenConfig), requirePermission('reports')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = pageSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const from = parsed.data.dateFrom ? new Date(`${parsed.data.dateFrom}T00:00:00.000Z`) : new Date(0);
    const to = parsed.data.dateTo ? new Date(new Date(`${parsed.data.dateTo}T00:00:00.000Z`).getTime() + 86_400_000) : new Date();
    const filter = { shopId: user.shopId, status: 'COMPLETED', soldAt: { $gte: from, $lt: to } };
    const [sales, returns] = await Promise.all([
      database.collection('sales').aggregate([
        { $match: filter },
        { $group: { _id: null, total: { $sum: '$totalPaisa' }, count: { $sum: 1 } } },
      ]).toArray(),
      database.collection('saleReturns').aggregate([
        { $match: { shopId: user.shopId, status: 'COMPLETED', decidedAt: { $gte: from, $lt: to } } },
        { $group: { _id: null, total: { $sum: '$refundPaisa' }, count: { $sum: 1 } } },
      ]).toArray(),
    ]);
    const gross = BigInt(asLong(sales[0]?.total ?? Long.ZERO).toString());
    const refunded = BigInt(asLong(returns[0]?.total ?? Long.ZERO).toString());
    return reply.send({
      dateFrom: parsed.data.dateFrom ?? null, dateTo: parsed.data.dateTo ?? null,
      grossSalesPaisa: gross.toString(), returnsPaisa: refunded.toString(),
      netSalesPaisa: (gross - refunded).toString(),
      saleCount: Number(sales[0]?.count ?? 0), returnCount: Number(returns[0]?.count ?? 0),
    });
  });

  app.get('/api/reports/stock', { preHandler: [requireAuth(authRepository, tokenConfig), requirePermission('reports')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const today = timezoneToday((await authRepository.findShopById(user.shopId))?.timeZone ?? 'Asia/Karachi');
    const [batches, medicines] = await Promise.all([
      database.collection('stockBatches').aggregate([
        { $match: { shopId: user.shopId, quantityRemainingBaseUnits: { $gt: Long.ZERO } } },
        { $group: {
          _id: '$status', batchCount: { $sum: 1 },
          remainingBaseUnits: { $sum: '$quantityRemainingBaseUnits' },
        } },
      ]).toArray(),
      database.collection('medicines').find({ shopId: user.shopId, isActive: true }).project({
        _id: 1, name: 1, minStockAlert: 1,
      }).toArray(),
    ]);
    const totalSellable = await database.collection('stockBatches').aggregate([
      { $match: { shopId: user.shopId, quantityRemainingBaseUnits: { $gt: Long.ZERO }, expiryDate: { $gte: today }, status: { $in: ['ACTIVE', 'NEAR_EXPIRY'] } } },
      { $group: { _id: null, quantity: { $sum: '$quantityRemainingBaseUnits' } } },
    ]).toArray();
    return reply.send({
      byStatus: batches.map((row) => ({
        status: row._id, batches: row.batchCount,
        quantityBaseUnits: asLong(row.remainingBaseUnits).toString(),
      })),
      activeMedicineCount: medicines.length,
      sellableBaseUnits: asLong(totalSellable[0]?.quantity ?? Long.ZERO).toString(),
    });
  });

  app.get('/api/shop/settings', { preHandler: [requireAuth(authRepository, tokenConfig), requirePermission('pos')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const shop = await database.collection('shops').findOne({ _id: user.shopId, status: 'ACTIVE' });
    if (!shop) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send(shopSettingsDto(shop, user.shopId));
  });

  app.patch('/api/shop/settings', { preHandler: [...admin, requirePermission('manage_users')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = shopSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const memoSettings = parsed.data.memoSettings;
    const memoIdentityChanged = memoSettings
      ? ['storeName', 'address', 'phone'].some((key) => key in memoSettings)
      : false;
    if ((parsed.data.shopName || parsed.data.profile || memoIdentityChanged) && user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    const set: Document = { updatedAt: new Date() };
    if (parsed.data.shopName) set.name = parsed.data.shopName;
    if (parsed.data.profile) {
      for (const [key, value] of Object.entries(parsed.data.profile)) set[`profile.${key}`] = value;
    }
    if (parsed.data.memoSettings) {
      for (const [key, value] of Object.entries(parsed.data.memoSettings)) set[`memoSettings.${key}`] = value;
    }
    if (parsed.data.receiptSettings) {
      for (const [key, value] of Object.entries(parsed.data.receiptSettings)) set[`receiptSettings.${key}`] = value;
    }
    await transaction(client, async (session) => {
      await database.collection('shops').updateOne({ _id: user.shopId, status: 'ACTIVE' }, { $set: set }, { session });
      await database.collection('auditLogs').insertOne(audit(user, 'shop.settings_updated', 'shop', user.shopId), { session });
    });
    const shop = await database.collection('shops').findOne({ _id: user.shopId });
    if (!shop) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send(shopSettingsDto(shop, user.shopId));
  });

  app.post('/api/print-requests', { preHandler: pos }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = printRequestSchema.safeParse(request.body);
    if (!parsed.success || containsCostField(parsed.success ? parsed.data.payload : null)
      || JSON.stringify(parsed.success ? parsed.data.payload : null).length > 128_000) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    }
    if (!canPrint(user, parsed.data.type)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const existing = await database.collection('printRequests').findOne({
      shopId: user.shopId, receiptRef: parsed.data.receiptRef, status: 'pending',
    });
    if (existing) return reply.code(409).send({ error: 'PRINT_REQUEST_ALREADY_PENDING' });
    const now = new Date();
    const requestId = new ObjectId();
    const sourceShop = await database.collection('shops').findOne({ _id: user.shopId, status: 'ACTIVE' });
    if (!sourceShop) return reply.code(404).send({ error: 'NOT_FOUND' });
    const inputData = parsed.data.payload.data;
    if (inputData.kind !== (parsed.data.type === 'sale' ? 'SALE' : 'PAYMENT')
      || inputData.memoNo !== parsed.data.receiptRef) {
      return reply.code(400).send({ error: 'RECEIPT_MISMATCH' });
    }
    let canonicalData: typeof inputData;
    if (parsed.data.type === 'sale') {
      const sale = await database.collection('sales').findOne({
        shopId: user.shopId, invoiceNumber: parsed.data.receiptRef, status: 'COMPLETED',
      });
      if (!sale) return reply.code(404).send({ error: 'RECEIPT_NOT_FOUND' });
      const saleItems = (sale.items ?? []) as Array<Document>;
      const lines = inputData.lines;
      if (lines.length !== saleItems.length || lines.some((line, index) => {
        const expected = saleItems[index]!;
        return line.name !== expected.medicineName
          || line.qty !== Number(expected.quantityInUnit)
          || line.ratePaisa !== safeReceiptNumber(expected.pricePaisaPerUnit);
      }) || inputData.discountPaisa !== safeReceiptNumber(sale.discountPaisa)) {
        return reply.code(400).send({ error: 'RECEIPT_MISMATCH' });
      }
      const cashier = await database.collection('users').findOne({
        _id: sale.cashierId, shopId: user.shopId,
      }, { projection: { role: 1 } });
      const payments = await database.collection('salePayments').find({
        shopId: user.shopId, saleId: sale._id,
      }).toArray();
      const paid = payments.filter((payment) => payment.method !== 'CREDIT')
        .reduce((total, payment) => total + BigInt(asLong(payment.amountPaisa).toString()), 0n);
      canonicalData = {
        ...inputData,
        kind: 'SALE',
        memoNo: String(sale.invoiceNumber),
        dateTime: (sale.soldAt as Date).toISOString(),
        customerName: String(sale.customerName ?? ''),
        lines: saleItems.map((item) => {
          const allocations = (item.batchAllocations ?? []) as Array<Document>;
          const allocation = allocations.length === 1 ? allocations[0] : undefined;
          return {
            qty: Number(item.quantityInUnit),
            name: String(item.medicineName),
            ratePaisa: safeReceiptNumber(item.pricePaisaPerUnit),
            ...(allocation ? {
              batch: String(allocation.batchNumber),
              expiry: (allocation.expiryDate as Date).toISOString().slice(0, 10),
            } : {}),
          };
        }),
        discountPaisa: safeReceiptNumber(sale.discountPaisa),
        paidPaisa: safeReceiptNumber(safeLong(paid)),
        changePaisa: safeReceiptNumber(sale.changePaisa),
        paymentMode: String(sale.paymentMethod),
        isCredit: sale.paymentMethod === 'CREDIT',
        cashier: String(sale.cashierName),
        role: String(cashier?.role ?? 'staff'),
        terminal: String((sourceShop.memoSettings as Document | undefined)?.terminalName ?? ''),
        amountReceivedPaisa: safeReceiptNumber(sale.amountTenderedPaisa),
      };
    } else {
      const payment = await database.collection('customerLedger').findOne({
        shopId: user.shopId,
        referenceNumber: parsed.data.receiptRef,
        entryType: 'PAYMENT',
      });
      if (!payment) return reply.code(404).send({ error: 'RECEIPT_NOT_FOUND' });
      const customer = await database.collection('customers').findOne({
        _id: payment.customerId, shopId: user.shopId,
      });
      if (!customer
        || inputData.amountReceivedPaisa !== safeReceiptNumber(payment.creditPaisa)
        || inputData.balanceAfterPaisa !== safeReceiptNumber(payment.runningBalancePaisa)) {
        return reply.code(400).send({ error: 'RECEIPT_MISMATCH' });
      }
      const cashier = await database.collection('users').findOne({
        _id: payment.createdBy, shopId: user.shopId,
      }, { projection: { fullName: 1, role: 1 } });
      canonicalData = {
        ...inputData,
        kind: 'PAYMENT',
        memoNo: String(payment.referenceNumber),
        dateTime: (payment.createdAt as Date).toISOString(),
        customerName: String(customer.name),
        lines: [],
        discountPaisa: 0,
        paidPaisa: safeReceiptNumber(payment.creditPaisa),
        paymentMode: String(payment.paymentMethod ?? 'PAYMENT'),
        cashier: String(cashier?.fullName ?? ''),
        role: String(cashier?.role ?? 'staff'),
        terminal: String((sourceShop.memoSettings as Document | undefined)?.terminalName ?? ''),
        amountReceivedPaisa: safeReceiptNumber(payment.creditPaisa),
        balanceAfterPaisa: safeReceiptNumber(payment.runningBalancePaisa),
      };
    }
    const receiptSettings = (sourceShop.receiptSettings ?? {}) as Document;
    const record = {
      _id: requestId, shopId: user.shopId, type: parsed.data.type, receiptRef: parsed.data.receiptRef,
      payload: {
        ...parsed.data.payload,
        data: canonicalData,
        settings: serverMemoSettings(sourceShop),
        format: receiptSettings.format ?? 'thermal80',
        template: receiptSettings.template ?? 'pharmacy-memo',
      },
      requesterId: user._id, requesterName: user.username || user.fullName,
      status: 'pending', createdAt: now, updatedAt: now,
    };
    await transaction(client, async (session) => {
      await database.collection('printRequests').insertOne(record, { session });
      await database.collection('auditLogs').insertOne(audit(user, 'print.requested', 'print_request', requestId), { session });
    });
    return reply.code(201).send({ id: requestId.toHexString(), type: record.type, receipt_ref: record.receiptRef, requested_by: user._id.toHexString(), requested_at: now, status: record.status });
  });

  app.get('/api/print-requests/mine', { preHandler: [requireAuth(authRepository, tokenConfig), requirePermission('pos')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const printTypes = [
      ...(canPrint(user, 'sale') ? ['sale'] : []),
      ...(canPrint(user, 'payment') ? ['payment'] : []),
    ];
    const items = await database.collection('printRequests').find({
      shopId: user.shopId, requesterId: user._id, type: { $in: printTypes },
    })
      .sort({ createdAt: -1, _id: -1 }).limit(100).toArray();
    return reply.send({ items: items.map((item) => printRequestDto(item, false)) });
  });

  app.get('/api/admin/print-requests', { preHandler: [...admin, requirePermission('pos')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const items = await database.collection('printRequests').find({ shopId: user.shopId })
      .sort({ createdAt: -1, _id: -1 }).limit(200).toArray();
    return reply.send({ items: items.map((item) => printRequestDto(item, true)) });
  });

  app.get('/api/admin/print-requests/pending-count', { preHandler: [...admin, requirePermission('pos')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    return reply.send({ count: await database.collection('printRequests').countDocuments({ shopId: user.shopId, status: 'pending' }) });
  });

  app.post('/api/admin/print-requests/:id/decision', { preHandler: [...admin, requirePermission('pos')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsed = printDecisionSchema.safeParse(request.body);
    if (!parsedId.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const requestId = new ObjectId(parsedId.data);
    const updated = await transaction(client, async (session) => {
      const record = await database.collection('printRequests').findOneAndUpdate(
        { _id: requestId, shopId: user.shopId, status: 'pending' },
        { $set: { status: parsed.data.decision, note: parsed.data.note ?? null, decidedBy: user._id, decidedByName: user.fullName, decidedAt: new Date(), updatedAt: new Date() } },
        { returnDocument: 'after', includeResultMetadata: false, session },
      );
      if (!record) return null;
      await database.collection('auditLogs').insertOne(audit(user, `print.${parsed.data.decision}`, 'print_request', requestId), { session });
      return record;
    });
    if (!updated) return reply.code(409).send({ error: 'PRINT_REQUEST_ALREADY_DECIDED' });
    return reply.send(printRequestDto(updated, true));
  });

  app.patch('/api/admin/print-requests/:id/snapshot', { preHandler: [...admin, requirePermission('pos')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = z.object({
      payload: printSnapshotSchema,
      reason: z.string().trim().min(1).max(500),
    }).strict().safeParse(request.body);
    if (!parsedId.success || !body.success || containsCostField(body.success ? body.data.payload : null)
      || JSON.stringify(body.success ? body.data.payload : null).length > 128_000) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    }
    const requestId = new ObjectId(parsedId.data);
    const updated = await transaction(client, async (session) => {
      const record = await database.collection('printRequests').findOneAndUpdate(
        { _id: requestId, shopId: user.shopId, status: 'pending', type: 'sale' },
        { $set: { payload: body.data.payload, updatedAt: new Date(), modifiedBy: user._id, modifyReason: body.data.reason } },
        { returnDocument: 'after', includeResultMetadata: false, session },
      );
      if (!record) return null;
      await database.collection('auditLogs').insertOne(audit(user, 'print.snapshot_modified', 'print_request', requestId), { session });
      return record;
    });
    if (!updated) return reply.code(409).send({ error: 'PRINT_REQUEST_NOT_MODIFIABLE' });
    return reply.send(printRequestDto(updated, true));
  });

  app.post('/api/print-requests/:id/printed', { preHandler: [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('pos')] }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsedId.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const requestId = new ObjectId(parsedId.data);
    const record = await database.collection('printRequests').findOne({
      _id: requestId, shopId: user.shopId,
    });
    if (!record || (id(record.requesterId) !== user._id.toHexString() && !['admin', 'super_admin'].includes(user.role))) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    if (!canPrint(user, record.type === 'sale' ? 'sale' : 'payment')) return reply.code(403).send({ error: 'FORBIDDEN' });
    const now = new Date();
    const updated = await transaction(client, async (session) => {
      const printRequest = await database.collection('printRequests').findOneAndUpdate(
        { _id: requestId, shopId: user.shopId, status: 'approved', printedAt: { $exists: false } },
        { $set: { printedAt: now, updatedAt: now } },
        { returnDocument: 'after', includeResultMetadata: false, session },
      );
      if (printRequest) {
        await database.collection('auditLogs').insertOne(audit(user, 'print.marked_printed', 'print_request', requestId), { session });
      }
      return printRequest;
    });
    if (!updated) return reply.code(409).send({ error: 'PRINT_REQUEST_NOT_APPROVED' });
    return reply.send({ status: updated.status, printedAt: now });
  });
}

function printRequestDto(record: Document, includeRequester: boolean): Record<string, unknown> {
  return {
    id: id(record._id),
    type: record.type,
    receipt_ref: record.receiptRef,
    ...(includeRequester ? { requested_by: id(record.requesterId), requester_name: record.requesterName } : { requested_by: id(record.requesterId) }),
    requested_at: record.createdAt,
    status: record.status,
    decided_by: id(record.decidedBy),
    decided_at: record.decidedAt ?? null,
    note: record.note ?? null,
    printed_at: record.printedAt ?? null,
    payload: record.payload,
  };
}
