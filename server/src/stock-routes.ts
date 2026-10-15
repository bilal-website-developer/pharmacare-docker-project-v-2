import { Long, ObjectId } from 'mongodb';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditRecord, PharmacyRepository, UserRecord } from './models.js';
import { canViewCost } from './catalog-domain.js';
import { requireAuth, requirePermission, requireRole } from './auth-routes.js';
import type { TokenConfig } from './auth-crypto.js';
import type { IdempotencyStore } from './idempotency.js';
import { timezoneToday } from './business-time.js';
import {
  adjustStockSchema,
  objectId,
  postPurchaseSchema,
  purchaseHistoryQuerySchema,
  purchaseIdSchema,
  stockAdjustmentQuerySchema,
  stockBatchQuerySchema,
  writeOffSchema,
  type PurchaseRecord,
  type StockBatchRecord,
  type StockListRow,
  type StockMovementRow,
} from './stock-domain.js';
import type { StockRepository } from './stock-repository.js';

const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
const alertQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

function callerFor(request: FastifyRequest, reply: FastifyReply): UserRecord | null {
  if (!request.authUser) {
    void reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return null;
  }
  return request.authUser;
}

async function todayForShop(
  request: FastifyRequest,
  reply: FastifyReply,
  authRepository: PharmacyRepository,
  user: UserRecord,
): Promise<Date | null> {
  const shop = await authRepository.findShopById(user.shopId);
  if (!shop || shop.status !== 'ACTIVE') {
    void reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return null;
  }
  try {
    return timezoneToday(shop.timeZone ?? 'Asia/Karachi');
  } catch {
    request.log.error({ event: 'invalid_shop_timezone', shopId: user.shopId.toHexString() });
    void reply.code(500).send({ error: 'INTERNAL_ERROR' });
    return null;
  }
}

function audit(
  actor: UserRecord,
  event: string,
  entityType: string,
  entityId?: ObjectId,
): AuditRecord {
  return {
    shopId: actor.shopId,
    actorId: actor._id,
    ...(entityId ? { entityId } : {}),
    event,
    entityType,
    occurredAt: new Date(),
  };
}

function roleCostView(user: UserRecord): boolean {
  return canViewCost(user.role, user.permissions);
}

function purchaseListDto(purchase: PurchaseRecord, showCost: boolean): Record<string, unknown> {
  return {
    id: purchase._id.toHexString(),
    purchaseNumber: purchase.purchaseNumber,
    supplierId: purchase.supplierId.toHexString(),
    supplierName: purchase.supplierNameSnapshot,
    invoiceNumber: purchase.invoiceNumber,
    purchaseDate: purchase.purchaseDate.toISOString().slice(0, 10),
    status: purchase.status,
    paymentType: purchase.paymentType,
    itemCount: purchase.items.length,
    ...(showCost ? {
      subtotalPaisa: purchase.subtotalPaisa.toString(),
      discountPaisa: purchase.discountPaisa.toString(),
      totalPaisa: purchase.totalPaisa.toString(),
      paidPaisa: purchase.paidPaisa.toString(),
    } : {}),
    createdAt: purchase.createdAt.toISOString(),
  };
}

function purchaseDetailDto(purchase: PurchaseRecord, showCost: boolean): Record<string, unknown> {
  return {
    ...purchaseListDto(purchase, showCost),
    notes: purchase.notes,
    createdBy: purchase.createdBy.toHexString(),
    ...(purchase.voidReason ? { voidReason: purchase.voidReason } : {}),
    ...(purchase.voidedAt ? { voidedAt: purchase.voidedAt.toISOString() } : {}),
    items: purchase.items.map((item) => ({
      id: item.purchaseItemId.toHexString(),
      medicineId: item.medicineId.toHexString(),
      medicineName: item.medicineNameSnapshot,
      medicineCode: item.medicineCodeSnapshot,
      unitId: item.unitId.toHexString(),
      unitName: item.unitNameSnapshot,
      quantity: item.quantityInUnits,
      bonusQuantityBaseUnits: item.bonusQuantityBaseUnits.toString(),
      quantityReceivedBaseUnits: item.quantityReceivedBaseUnits.toString(),
      batchId: item.batchId.toHexString(),
      batchNumber: item.batchNumber,
      expiryDate: item.expiryDate.toISOString().slice(0, 10),
      ...(showCost ? {
        unitCostPaisa: item.unitCostPaisa.toString(),
        mrpPaisa: item.mrpPaisa.toString(),
        lineTotalPaisa: item.lineTotalPaisa.toString(),
      } : {}),
    })),
  };
}

function stockBatchDto(batch: StockListRow, showCost: boolean): Record<string, unknown> {
  return {
    id: batch._id.toHexString(),
    medicineId: batch.medicineId.toHexString(),
    medicineName: batch.medicineName,
    genericName: batch.genericName,
    medicineCode: batch.medicineCode,
    barcode: batch.barcode,
    medicineIsActive: batch.medicineIsActive,
    minStockAlert: batch.minStockAlert,
    supplierId: batch.supplierId.toHexString(),
    supplierName: batch.supplierName,
    purchaseId: batch.purchaseId.toHexString(),
    batchNumber: batch.batchNumber,
    expiryDate: batch.expiryDate.toISOString().slice(0, 10),
    receivedDate: batch.receivedDate.toISOString().slice(0, 10),
    quantityReceivedBaseUnits: batch.quantityReceivedBaseUnits.toString(),
    quantityReturnedBaseUnits: batch.quantityReturnedBaseUnits.toString(),
    quantityRemainingBaseUnits: batch.quantityRemainingBaseUnits.toString(),
    status: batch.status,
    isSellable: batch.isSellable,
    sellableStockBaseUnits: batch.sellableStockBaseUnits.toString(),
    mrpPaisaPerBaseUnit: batch.mrpPaisaPerBaseUnit.toString(),
    ...(showCost ? {
      unitCostPaisaPerBaseUnit: batch.unitCostPaisaPerBaseUnit.toString(),
      stockValueCostPaisa: (
        BigInt(batch.quantityRemainingBaseUnits.toString())
        * BigInt(batch.unitCostPaisaPerBaseUnit.toString())
      ).toString(),
    } : {}),
  };
}

function movementDto(row: StockMovementRow): Record<string, unknown> {
  return {
    id: row._id.toHexString(),
    batchId: row.batchId.toHexString(),
    batchNumber: row.batchNumber,
    medicineId: row.medicineId.toHexString(),
    medicineName: row.medicineName,
    genericName: row.genericName,
    movementType: row.movementType,
    quantityDeltaBaseUnits: row.quantityDeltaBaseUnits.toString(),
    referenceType: row.referenceType,
    referenceId: row.referenceId.toHexString(),
    reason: row.reason,
    actorName: row.actorName,
    createdAt: row.createdAt.toISOString(),
  };
}

function batchMutationDto(batch: StockBatchRecord, before?: Long): Record<string, unknown> {
  return {
    id: batch._id.toHexString(),
    quantityBeforeBaseUnits: before?.toString(),
    quantityRemainingBaseUnits: batch.quantityRemainingBaseUnits.toString(),
    status: batch.status,
  };
}

function failureResponse(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof Error)) return false;
  const responses: Record<string, { status: number; code: string }> = {
    ACTIVE_SUPPLIER_REQUIRED: { status: 400, code: 'ACTIVE_SUPPLIER_REQUIRED' },
    ACTIVE_MEDICINE_AND_UNIT_REQUIRED: { status: 400, code: 'ACTIVE_MEDICINE_AND_UNIT_REQUIRED' },
    INVALID_UNIT_CONVERSION: { status: 400, code: 'INVALID_UNIT_CONVERSION' },
    EXPIRY_NOT_AFTER_PURCHASE_DATE: { status: 400, code: 'EXPIRY_NOT_AFTER_PURCHASE_DATE' },
    QUANTITY_LIMIT_EXCEEDED: { status: 400, code: 'QUANTITY_LIMIT_EXCEEDED' },
    PURCHASE_TOTAL_LIMIT_EXCEEDED: { status: 400, code: 'PURCHASE_TOTAL_LIMIT_EXCEEDED' },
    DISCOUNT_EXCEEDS_SUBTOTAL: { status: 400, code: 'DISCOUNT_EXCEEDS_SUBTOTAL' },
    DUPLICATE_PURCHASE_VALUE: { status: 409, code: 'DUPLICATE_VALUE' },
    PURCHASE_STOCK_ALREADY_CHANGED: { status: 409, code: 'PURCHASE_STOCK_ALREADY_CHANGED' },
    PURCHASE_BATCH_REFERENCES_INCOMPLETE: { status: 409, code: 'PURCHASE_BATCH_REFERENCES_INCOMPLETE' },
    PURCHASE_SUPPLIER_LEDGER_MISSING: { status: 409, code: 'PURCHASE_SUPPLIER_LEDGER_MISSING' },
    PURCHASE_STOCK_CHANGED_CONCURRENTLY: { status: 409, code: 'STOCK_CHANGED_CONCURRENTLY' },
    SUPPLIER_BALANCE_RECONCILIATION_FAILED: { status: 409, code: 'SUPPLIER_BALANCE_RECONCILIATION_FAILED' },
    SUPPLIER_CHANGED_DURING_PURCHASE: { status: 409, code: 'SUPPLIER_CHANGED_CONCURRENTLY' },
    PURCHASE_CHANGED_CONCURRENTLY: { status: 409, code: 'PURCHASE_CHANGED_CONCURRENTLY' },
    BATCH_STATUS_NOT_ADJUSTABLE: { status: 409, code: 'BATCH_STATUS_NOT_ADJUSTABLE' },
    INSUFFICIENT_STOCK: { status: 409, code: 'INSUFFICIENT_STOCK' },
    BATCH_CHANGED_CONCURRENTLY: { status: 409, code: 'BATCH_CHANGED_CONCURRENTLY' },
    BATCH_NOT_EXPIRED: { status: 400, code: 'BATCH_NOT_EXPIRED' },
    BATCH_HAS_NO_REMAINING_STOCK: { status: 409, code: 'BATCH_HAS_NO_REMAINING_STOCK' },
    COST_SORT_FORBIDDEN: { status: 403, code: 'FORBIDDEN' },
  };
  const response = responses[error.message];
  if (!response) return false;
  void reply.code(response.status).send({ error: response.code });
  return true;
}

export function registerStockRoutes(
  app: FastifyInstance,
  repository: StockRepository,
  authRepository: PharmacyRepository,
  tokenConfig: TokenConfig,
  idempotencyStore: IdempotencyStore,
): void {
  const purchasePreHandler = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('purchases')];
  const historyPreHandler = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('purchase_history')];
  const stockPreHandler = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('stock_inventory')];
  const stockAlertPreHandler = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('stock_alerts')];

  app.get('/api/purchases/catalog', { preHandler: purchasePreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const showCost = roleCostView(caller);
    const catalog = await repository.activePurchaseCatalog(caller.shopId, showCost);
    const items = catalog.items.map((record) => ({
      id: record.id,
      code: record.code,
      barcode: record.barcode,
      name: record.name,
      genericName: record.genericName,
      manufacturer: record.manufacturer,
      stockBaseUnits: record.stockBaseUnits,
      units: record.units,
      ...(showCost && 'lastCostPaisaPerBaseUnit' in record
        ? { lastCostPaisaPerBaseUnit: record.lastCostPaisaPerBaseUnit }
        : {}),
    }));
    return reply.send({ items, suppliers: catalog.suppliers });
  });

  app.get('/api/purchases/history', { preHandler: historyPreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const parsed = purchaseHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const result = await repository.listPurchases({ ...parsed.data, shopId: caller.shopId });
    const showCost = roleCostView(caller);
    return reply.send({
      items: result.rows.map((purchase) => purchaseListDto(purchase, showCost)),
      total: result.total,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
  });

  app.get('/api/purchases/:id', { preHandler: historyPreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const parsed = purchaseIdSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const purchase = await repository.getPurchase(caller.shopId, objectId(parsed.data));
    if (!purchase) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send(purchaseDetailDto(purchase, roleCostView(caller)));
  });

  app.post('/api/purchases', { preHandler: purchasePreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    if (!roleCostView(caller)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const parsed = postPurchaseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const today = await todayForShop(request, reply, authRepository, caller);
    if (!today) return;
    try {
      const purchase = await repository.postPurchase(
        parsed.data,
        caller,
        audit(caller, 'purchase.posted', 'purchase'),
        today,
      );
      return reply.code(201).send(purchaseDetailDto(purchase, true));
    } catch (error) {
      if (failureResponse(error, reply)) return;
      throw error;
    }
  });

  app.post('/api/purchases/:id/void', {
    preHandler: [
      requireAuth(authRepository, tokenConfig, idempotencyStore),
      requireRole('admin', 'super_admin'),
      requirePermission('purchases'),
    ],
  }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const idParsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    const bodyParsed = z.object({ reason: z.string().trim().min(1).max(500) }).strict().safeParse(request.body);
    if (!idParsed.success || !bodyParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    try {
      const purchase = await repository.voidPurchase(
        caller.shopId,
        objectId(idParsed.data),
        caller,
        bodyParsed.data.reason,
        audit(caller, 'purchase.voided', 'purchase', objectId(idParsed.data)),
      );
      if (!purchase) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(purchaseDetailDto(purchase, roleCostView(caller)));
    } catch (error) {
      if (failureResponse(error, reply)) return;
      throw error;
    }
  });

  app.get('/api/stock/overview', { preHandler: stockPreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const today = await todayForShop(request, reply, authRepository, caller);
    if (!today) return;
    await repository.refreshStatuses(caller.shopId, today);
    const stats = await repository.stockStats(caller.shopId, roleCostView(caller), today);
    const { stockValueCostPaisa, expiredValueAtRiskPaisa, ...publicStats } = stats;
    return reply.send({
      ...publicStats,
      ...(roleCostView(caller) ? { stockValueCostPaisa, expiredValueAtRiskPaisa } : {}),
    });
  });

  app.get('/api/stock/alerts/summary', { preHandler: stockAlertPreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const parsed = alertQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const today = await todayForShop(request, reply, authRepository, caller);
    if (!today) return;
    return reply.send(await repository.stockAlertsSummary(caller.shopId, parsed.data.limit, today));
  });

  app.get('/api/stock/expiry-buckets', { preHandler: stockPreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const today = await todayForShop(request, reply, authRepository, caller);
    if (!today) return;
    await repository.refreshStatuses(caller.shopId, today);
    return reply.send({ buckets: await repository.expiryBuckets(caller.shopId, today) });
  });

  app.get('/api/stock/batches', { preHandler: stockPreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const parsed = stockBatchQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const showCost = roleCostView(caller);
    if (!showCost && ['cost_asc', 'cost_desc', 'value_asc', 'value_desc'].includes(parsed.data.sort)) {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    const today = await todayForShop(request, reply, authRepository, caller);
    if (!today) return;
    await repository.refreshStatuses(caller.shopId, today);
    try {
      const result = await repository.listStock(
        { ...parsed.data, shopId: caller.shopId, canViewCost: showCost },
        today,
      );
      return reply.send({
        items: result.rows.map((row) => stockBatchDto(row, showCost)),
        total: result.total,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      });
    } catch (error) {
      if (failureResponse(error, reply)) return;
      throw error;
    }
  });

  app.get('/api/stock/adjustments', { preHandler: stockPreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const parsed = stockAdjustmentQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const result = await repository.listAdjustments({ ...parsed.data, shopId: caller.shopId });
    return reply.send({
      items: result.rows.map(movementDto),
      total: result.total,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
  });

  app.post('/api/stock/batches/:id/adjust', { preHandler: stockPreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const idParsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    const bodyParsed = adjustStockSchema.safeParse(request.body);
    if (!idParsed.success || !bodyParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const today = await todayForShop(request, reply, authRepository, caller);
    if (!today) return;
    const batchId = objectId(idParsed.data);
    try {
      const batch = await repository.adjustStock(
        caller.shopId,
        batchId,
        caller,
        Long.fromString(bodyParsed.data.deltaBaseUnits),
        bodyParsed.data.reason,
        audit(caller, 'stock.adjusted', 'stock_batch', batchId),
        today,
      );
      if (!batch) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(batchMutationDto(batch));
    } catch (error) {
      if (failureResponse(error, reply)) return;
      throw error;
    }
  });

  app.post('/api/stock/batches/:id/write-off', { preHandler: stockPreHandler }, async (request, reply) => {
    const caller = callerFor(request, reply);
    if (!caller) return;
    const idParsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    const bodyParsed = writeOffSchema.safeParse(request.body);
    if (!idParsed.success || !bodyParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const today = await todayForShop(request, reply, authRepository, caller);
    if (!today) return;
    const batchId = objectId(idParsed.data);
    try {
      const result = await repository.writeOffExpired(
        caller.shopId,
        batchId,
        caller,
        audit(caller, 'stock_batch.write_off', 'stock_batch', batchId),
        today,
      );
      if (!result) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(batchMutationDto(result.batch, result.before));
    } catch (error) {
      if (failureResponse(error, reply)) return;
      throw error;
    }
  });
}
