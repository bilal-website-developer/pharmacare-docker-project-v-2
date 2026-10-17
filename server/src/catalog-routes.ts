import { Long, ObjectId } from 'mongodb';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditRecord, PharmacyRepository, UserRecord } from './models.js';
import {
  barcodeAssignSchema,
  bulkBarcodeSchema,
  canViewCost,
  type CatalogRecord,
  csvImportSchema,
  CSV_HEADERS,
  csvMedicineRowSchema,
  escapeCsvCell,
  listQuerySchema,
  medicineInputSchema,
  medicineUnitInputSchema,
  medicineUnitUpdateSchema,
  medicineUpdateSchema,
  namedRecordSchema,
  normalizeName,
  parseCsv,
  supplierSchema,
  trashQuerySchema,
  type CatalogCollection,
  type CatalogEntityType,
} from './catalog-domain.js';
import { requireAuth, requirePermission, requireRole } from './auth-routes.js';
import type { CatalogListOptions, CatalogRepository } from './catalog-repository.js';
import type { TokenConfig } from './auth-crypto.js';
import type { IdempotencyStore } from './idempotency.js';
import { timezoneToday } from './business-time.js';

const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
const medicineCreateSchema = medicineInputSchema.extend({
  units: z.array(medicineUnitInputSchema).min(1).max(100),
}).strict();
const namedUpdateSchema = namedRecordSchema.partial().strict();
const supplierUpdateSchema = supplierSchema.partial().strict();
const mergeSchema = z.object({ targetId: idSchema }).strict();

type NamedResource = 'categories' | 'brands';

function objectId(value: string): ObjectId {
  return new ObjectId(value);
}

function auditRecord(
  actor: UserRecord,
  event: string,
  entityType: string,
  entityId: ObjectId | undefined,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  occurredAt = new Date(),
): AuditRecord {
  return {
    shopId: actor.shopId,
    actorId: actor._id,
    ...(entityId ? { entityId } : {}),
    event,
    entityType,
    before,
    after,
    occurredAt,
  };
}

function snapshot(record: CatalogRecord): Record<string, unknown> {
  const allowed = [
    '_id', 'name', 'code', 'genericName', 'strength', 'categoryId', 'brandId',
    'drugClass', 'storageCondition', 'rackLocation', 'minStockAlert',
    'requiresPrescription', 'isActive', 'barcode', 'contact', 'address',
    'licenceOrTaxNumber', 'paymentTerms', 'medicineId', 'conversionFactorBaseUnits',
    'pricePaisa', 'isDefaultSaleUnit', 'deletedAt',
  ];
  return Object.fromEntries(allowed
    .filter((key) => record[key] !== undefined)
    .map((key) => [key, record[key] instanceof ObjectId ? record[key].toHexString() : record[key]]));
}

function toDto(
  record: CatalogRecord,
  collection: CatalogCollection,
  cost?: string | null,
): Record<string, unknown> {
  const keys: Record<CatalogCollection, readonly string[]> = {
    categories: ['name', 'isActive'],
    brands: ['name', 'isActive'],
    medicines: [
      'code', 'name', 'genericName', 'strength', 'categoryId', 'brandId', 'drugClass',
      'storageCondition', 'rackLocation', 'minStockAlert', 'requiresPrescription',
      'isActive', 'barcode', 'categoryName', 'brandName', 'defaultUnitName',
      'defaultUnitConversionFactor', 'defaultUnitPricePaisa',
    ],
    medicineUnits: [
      'medicineId', 'name', 'conversionFactorBaseUnits', 'pricePaisa',
      'isDefaultSaleUnit', 'barcode',
    ],
    suppliers: ['name', 'contact', 'address', 'licenceOrTaxNumber', 'paymentTerms', 'isActive'],
  };
  const dto: Record<string, unknown> = {
    id: record._id.toHexString(),
    ...Object.fromEntries(keys[collection]
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, record[key] instanceof ObjectId
        ? record[key].toHexString()
        : key === 'pricePaisa' || key === 'defaultUnitPricePaisa'
          ? record[key]?.toString()
          : record[key]])),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
  if (record.deletedAt instanceof Date) dto.deletedAt = record.deletedAt.toISOString();
  if (collection === 'medicines' && cost !== undefined) {
    dto.latestCostPaisa = cost;
    const price = record.defaultUnitPricePaisa;
    const conversion = record.defaultUnitConversionFactor;
    if (cost === null || price === undefined || conversion === undefined) {
      dto.marginBasisPoints = null;
    } else {
      const pricePaisa = BigInt(String(price));
      const conversionFactorNumber = Number(conversion);
      if (!Number.isSafeInteger(conversionFactorNumber) || conversionFactorNumber < 1) {
        throw new Error('Invalid medicine unit conversion factor.');
      }
      const conversionFactor = BigInt(conversionFactorNumber);
      dto.marginBasisPoints = pricePaisa === 0n
        ? null
        : ((pricePaisa - BigInt(cost) * conversionFactor) * 10_000n / pricePaisa).toString();
    }
  }
  return dto;
}

function requiredCaller(request: FastifyRequest, reply: FastifyReply): UserRecord | null {
  if (!request.authUser) {
    void reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return null;
  }
  return request.authUser;
}

async function callerShopToday(
  request: FastifyRequest,
  reply: FastifyReply,
  authRepository: PharmacyRepository,
  caller: UserRecord,
): Promise<Date | null> {
  const shop = await authRepository.findShopById(caller.shopId);
  if (!shop || shop.status !== 'ACTIVE') {
    await reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return null;
  }
  try {
    return timezoneToday(shop.timeZone ?? 'Asia/Karachi');
  } catch {
    request.log.error({ event: 'invalid_shop_timezone', shopId: caller.shopId.toHexString() });
    await reply.code(500).send({ error: 'INTERNAL_ERROR' });
    return null;
  }
}

function duplicateResponse(error: unknown, reply: FastifyReply): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
    void reply.code(409).send({ error: 'DUPLICATE_VALUE' });
    return true;
  }
  return false;
}

function namedSearchFields(collection: CatalogCollection): string[] {
  if (collection === 'medicines') {
    return ['name', 'genericName', 'code', 'strength', 'barcode', 'rackLocation', 'categoryName', 'brandName'];
  }
  if (collection === 'suppliers') return ['name', 'contact', 'licenceOrTaxNumber'];
  return ['name'];
}

function queryFilters(
  collection: CatalogCollection,
  query: z.infer<typeof listQuerySchema>,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (collection !== 'medicineUnits' && collection !== 'medicines' && query.active !== 'all') {
    filter.isActive = query.active === 'true';
  } else if (collection === 'medicines' && query.active !== 'all') {
    filter.isActive = query.active === 'true';
  }
  if (collection === 'medicines') {
    if (query.categoryId) filter.categoryId = objectId(query.categoryId);
    if (query.brandId) filter.brandId = objectId(query.brandId);
    if (query.drugClass) filter.drugClass = query.drugClass;
  }
  return filter;
}

function sortField(collection: CatalogCollection, requested: string | undefined): string {
  const fields: Record<CatalogCollection, readonly string[]> = {
    categories: ['name', 'createdAt', 'updatedAt'],
    brands: ['name', 'createdAt', 'updatedAt'],
    medicines: ['name', 'code', 'genericName', 'createdAt', 'updatedAt'],
    medicineUnits: ['name', 'conversionFactorBaseUnits', 'pricePaisa', 'createdAt'],
    suppliers: ['name', 'paymentTerms', 'createdAt', 'updatedAt'],
  };
  return requested && fields[collection].includes(requested) ? requested : 'name';
}

function makeListOptions(
  collection: CatalogCollection,
  shopId: ObjectId,
  query: z.infer<typeof listQuerySchema>,
  extraFilter: Record<string, unknown> = {},
): CatalogListOptions {
  return {
    collection,
    shopId,
    filter: { ...queryFilters(collection, query), ...extraFilter },
    searchFields: namedSearchFields(collection),
    search: query.search,
    sortField: sortField(collection, query.sort),
    order: query.order,
    page: query.page,
    pageSize: query.pageSize,
  };
}

function createCatalogRecord(
  shopId: ObjectId,
  actorId: ObjectId,
  values: Record<string, unknown>,
  now: Date,
): CatalogRecord {
  return {
    _id: new ObjectId(),
    shopId,
    ...values,
    createdBy: actorId,
    updatedBy: actorId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function registerNamedRoutes(
  app: FastifyInstance,
  repository: CatalogRepository,
  authRepository: PharmacyRepository,
  tokenConfig: TokenConfig,
  idempotencyStore: IdempotencyStore,
  collection: NamedResource,
  permission: 'categories',
): void {
  const entityType: CatalogEntityType = collection === 'categories' ? 'category' : 'brand';
  const path = collection;
  const preHandler = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission(permission)];

  app.get(`/api/${path}`, { preHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const query = parsed.data;
    const result = await repository.list(makeListOptions(collection, caller.shopId, query));
    return reply.send({
      items: result.rows.map((record) => toDto(record, collection)),
      page: query.page,
      pageSize: query.pageSize,
      total: result.total,
    });
  });

  app.get(`/api/${path}/:id`, { preHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const record = await repository.get(collection, caller.shopId, objectId(parsed.data));
    if (!record) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send(toDto(record, collection));
  });

  app.post(`/api/${path}`, { preHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = namedRecordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const now = new Date();
    const record = createCatalogRecord(caller.shopId, caller._id, {
      ...parsed.data,
      normalizedName: normalizeName(parsed.data.name),
      activeBeforeDelete: null,
    }, now);
    try {
      const saved = await repository.create(collection, record, caller._id, auditRecord(
        caller, `${entityType}.created`, entityType, record._id, null, snapshot(record), now,
      ));
      return reply.code(201).send(toDto(saved, collection));
    } catch (error) {
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });

  app.patch(`/api/${path}/:id`, { preHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const pathParsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    const bodyParsed = namedUpdateSchema.safeParse(request.body);
    if (!pathParsed.success || !bodyParsed.success || Object.keys(bodyParsed.data).length === 0) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    }
    const id = objectId(pathParsed.data);
    const updates: Record<string, unknown> = { ...bodyParsed.data, updatedBy: caller._id };
    if (bodyParsed.data.name) updates.normalizedName = normalizeName(bodyParsed.data.name);
    try {
      const updated = await repository.update(collection, caller.shopId, id, updates, caller._id, (before, after) => [
        auditRecord(caller, `${entityType}.updated`, entityType, id, snapshot(before), snapshot(after)),
      ]);
      if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(toDto(updated, collection));
    } catch (error) {
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });

  app.delete(`/api/${path}/:id`, { preHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const id = objectId(parsed.data);
    const deleted = await repository.softDelete(
      collection,
      caller.shopId,
      id,
      caller._id,
      caller.role,
      entityType,
      (before) => auditRecord(caller, `${entityType}.deleted`, entityType, id, snapshot(before), null),
    );
    if (!deleted) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(204).send();
  });

  app.post(`/api/${path}/:id/restore`, { preHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const id = objectId(parsed.data);
    try {
      const restored = await repository.restore(
        collection,
        caller.shopId,
        id,
        caller._id,
        caller.role,
        entityType,
        (before, after) => auditRecord(caller, `${entityType}.restored`, entityType, id, snapshot(before), snapshot(after)),
      );
      if (!restored) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(toDto(restored, collection));
    } catch (error) {
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });
}

function csvBoolean(value: unknown): string {
  return value === true ? 'true' : 'false';
}

function exportCsvRow(record: CatalogRecord, unitBarcode?: unknown, latestCost?: string): string {
  const fields: unknown[] = [
    record.code,
    record.name,
    record.genericName,
    record.strength,
    record.categoryName,
    record.brandName,
    record.drugClass,
    record.storageCondition,
    record.rackLocation,
    record.minStockAlert,
    csvBoolean(record.requiresPrescription),
    csvBoolean(record.isActive),
    record.defaultUnitName,
    record.defaultUnitConversionFactor,
    record.defaultUnitPricePaisa,
    record.barcode,
    unitBarcode,
  ];
  if (latestCost !== undefined) fields.push(latestCost);
  return fields.map(escapeCsvCell).join(',');
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  repository: CatalogRepository,
  authRepository: PharmacyRepository,
  tokenConfig: TokenConfig,
  idempotencyStore: IdempotencyStore,
): void {
  const productsPreHandler = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('products')];
  const suppliersPreHandler = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('suppliers')];

  registerNamedRoutes(app, repository, authRepository, tokenConfig, idempotencyStore, 'categories', 'categories');
  registerNamedRoutes(app, repository, authRepository, tokenConfig, idempotencyStore, 'brands', 'categories');

  const masterDataPreHandler = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('categories')];
  app.get('/api/master-data/overview', { preHandler: masterDataPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const shop = await authRepository.findShopById(caller.shopId);
    if (!shop || shop.status !== 'ACTIVE') return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    let today: Date;
    try {
      today = timezoneToday(shop.timeZone ?? 'Asia/Karachi');
    } catch {
      request.log.error({ event: 'invalid_shop_timezone', shopId: caller.shopId.toHexString() });
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
    return reply.send(await repository.masterDataOverview(
      caller.shopId,
      today,
      canViewCost(caller.role, caller.permissions),
    ));
  });

  app.get('/api/master-data/units', { preHandler: masterDataPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    return reply.send({ items: await repository.listMasterUnits(caller.shopId) });
  });

  for (const collection of ['categories', 'brands'] as const) {
    app.post(`/api/${collection}/:id/merge`, { preHandler: masterDataPreHandler }, async (request, reply) => {
      const caller = requiredCaller(request, reply);
      if (!caller) return;
      const pathParsed = idSchema.safeParse((request.params as { id?: unknown }).id);
      const bodyParsed = mergeSchema.safeParse(request.body);
      if (!pathParsed.success || !bodyParsed.success) {
        return reply.code(400).send({ error: 'VALIDATION_FAILED' });
      }
      const sourceId = objectId(pathParsed.data);
      const targetId = objectId(bodyParsed.data.targetId);
      try {
        const productCount = await repository.mergeNamed(
          collection,
          caller.shopId,
          sourceId,
          targetId,
          caller._id,
          caller.role === 'admin' || caller.role === 'super_admin' || caller.permissions.includes('products'),
          (source, target, count) => auditRecord(
            caller,
            `${collection === 'categories' ? 'category' : 'brand'}.merged`,
            collection === 'categories' ? 'category' : 'brand',
            sourceId,
            snapshot(source),
            { targetId: target._id.toHexString(), targetName: target.name, productCount: count },
          ),
          (source) => ({
            shopId: caller.shopId,
            actorId: caller._id,
            entityId: source._id,
            entityType: collection === 'categories' ? 'category' : 'brand',
            action: 'deleted',
            displayName: String(source.name),
            role: caller.role,
            occurredAt: new Date(),
          }),
        );
        if (productCount === null) return reply.code(404).send({ error: 'NOT_FOUND' });
        return reply.send({ productCount });
      } catch (error) {
        if (error instanceof Error && error.message === 'MERGE_TARGET_INVALID') {
          return reply.code(400).send({ error: 'VALIDATION_FAILED' });
        }
        if (error instanceof Error && error.message === 'PRODUCTS_PERMISSION_REQUIRED') {
          return reply.code(403).send({ error: 'FORBIDDEN' });
        }
        throw error;
      }
    });
  }

  app.get('/api/suppliers', { preHandler: suppliersPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const query = parsed.data;
    const result = await repository.list(makeListOptions('suppliers', caller.shopId, query));
    return reply.send({
      items: result.rows.map((record) => toDto(record, 'suppliers')),
      page: query.page,
      pageSize: query.pageSize,
      total: result.total,
    });
  });

  app.get('/api/suppliers/:id', { preHandler: suppliersPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const supplier = await repository.get('suppliers', caller.shopId, objectId(parsed.data));
    if (!supplier) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send(toDto(supplier, 'suppliers'));
  });

  app.post('/api/suppliers', { preHandler: suppliersPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = supplierSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const now = new Date();
    const record = createCatalogRecord(caller.shopId, caller._id, {
      ...parsed.data,
      normalizedName: normalizeName(parsed.data.name),
      payableBalancePaisa: Long.ZERO,
      activeBeforeDelete: null,
    }, now);
    try {
      const saved = await repository.create('suppliers', record, caller._id, auditRecord(
        caller, 'supplier.created', 'supplier', record._id, null, snapshot(record), now,
      ));
      return reply.code(201).send(toDto(saved, 'suppliers'));
    } catch (error) {
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });

  app.patch('/api/suppliers/:id', { preHandler: suppliersPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const idParsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    const bodyParsed = supplierUpdateSchema.safeParse(request.body);
    if (!idParsed.success || !bodyParsed.success || Object.keys(bodyParsed.data).length === 0) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    }
    const id = objectId(idParsed.data);
    const updates: Record<string, unknown> = { ...bodyParsed.data, updatedBy: caller._id };
    if (bodyParsed.data.name) updates.normalizedName = normalizeName(bodyParsed.data.name);
    try {
      const updated = await repository.update('suppliers', caller.shopId, id, updates, caller._id, (before, after) => [
        auditRecord(caller, 'supplier.updated', 'supplier', id, snapshot(before), snapshot(after)),
      ]);
      if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(toDto(updated, 'suppliers'));
    } catch (error) {
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });

  app.delete('/api/suppliers/:id', { preHandler: suppliersPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const id = objectId(parsed.data);
    const deleted = await repository.softDelete(
      'suppliers', caller.shopId, id, caller._id, caller.role, 'supplier',
      (before) => auditRecord(caller, 'supplier.deleted', 'supplier', id, snapshot(before), null),
    );
    if (!deleted) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(204).send();
  });

  app.post('/api/suppliers/:id/restore', { preHandler: suppliersPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const id = objectId(parsed.data);
    try {
      const restored = await repository.restore(
        'suppliers', caller.shopId, id, caller._id, caller.role, 'supplier',
        (before, after) => auditRecord(caller, 'supplier.restored', 'supplier', id, snapshot(before), snapshot(after)),
      );
      if (!restored) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(toDto(restored, 'suppliers'));
    } catch (error) {
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });

  app.get('/api/medicines', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const query = parsed.data;
    const result = await repository.list(makeListOptions('medicines', caller.shopId, query));
    const showCost = canViewCost(caller.role, caller.permissions);
    let costMap = new Map<string, string>();
    if (showCost) {
      const today = await callerShopToday(request, reply, authRepository, caller);
      if (!today) return;
      costMap = await repository.latestCosts(caller.shopId, result.rows.map((row) => row._id), today);
    }
    return reply.send({
      items: result.rows.map((record) => toDto(
        record,
        'medicines',
        showCost ? costMap.get(record._id.toHexString()) ?? null : undefined,
      )),
      page: query.page,
      pageSize: query.pageSize,
      total: result.total,
    });
  });

  app.get('/api/medicines/:id', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const medicine = await repository.get('medicines', caller.shopId, objectId(parsed.data));
    if (!medicine) return reply.code(404).send({ error: 'NOT_FOUND' });
    const showCost = canViewCost(caller.role, caller.permissions);
    let cost: Map<string, string> = new Map();
    if (showCost) {
      const today = await callerShopToday(request, reply, authRepository, caller);
      if (!today) return;
      cost = await repository.latestCosts(caller.shopId, [medicine._id], today);
    }
    return reply.send(toDto(medicine, 'medicines', showCost ? cost.get(medicine._id.toHexString()) : undefined));
  });

  app.post('/api/medicines', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = medicineCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const { units: inputUnits, ...input } = parsed.data;
    if (inputUnits.filter((unit) => unit.isDefaultSaleUnit).length !== 1) {
      return reply.code(400).send({ error: 'ONE_DEFAULT_UNIT_REQUIRED' });
    }
    const category = await repository.get('categories', caller.shopId, objectId(input.categoryId));
    const brand = await repository.get('brands', caller.shopId, objectId(input.brandId));
    if (!category?.isActive || !brand?.isActive) return reply.code(400).send({ error: 'ACTIVE_CATEGORY_AND_BRAND_REQUIRED' });
    const now = new Date();
    const medicine = createCatalogRecord(caller.shopId, caller._id, {
      ...input,
      categoryId: objectId(input.categoryId),
      brandId: objectId(input.brandId),
      normalizedName: normalizeName(input.name),
      normalizedCode: normalizeName(input.code),
      categoryName: category.name,
      brandName: brand.name,
      defaultUnitName: inputUnits.find((unit) => unit.isDefaultSaleUnit)!.name,
      defaultUnitConversionFactor: inputUnits.find((unit) => unit.isDefaultSaleUnit)!.conversionFactorBaseUnits,
      defaultUnitPricePaisa: Long.fromString(inputUnits.find((unit) => unit.isDefaultSaleUnit)!.pricePaisa),
      activeBeforeDelete: null,
    }, now);
    const units = inputUnits.map((unit) => createCatalogRecord(caller.shopId, caller._id, {
      medicineId: medicine._id,
      ...unit,
      normalizedName: normalizeName(unit.name),
      pricePaisa: Long.fromString(unit.pricePaisa),
    }, now));
    try {
      await repository.createMedicine(medicine, units, caller._id, [
        auditRecord(caller, 'medicine.created', 'medicine', medicine._id, null, snapshot(medicine), now),
        ...units.map((unit) => auditRecord(caller, 'medicine_unit.created', 'medicine_unit', unit._id, null, snapshot(unit), now)),
      ]);
      return reply.code(201).send({
        ...toDto(medicine, 'medicines'),
        units: units.map((unit) => toDto(unit, 'medicineUnits')),
      });
    } catch (error) {
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });

  app.patch('/api/medicines/:id', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const idParsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    const bodyParsed = medicineUpdateSchema.safeParse(request.body);
    if (!idParsed.success || !bodyParsed.success || Object.keys(bodyParsed.data).length === 0) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    }
    const id = objectId(idParsed.data);
    const updates: Record<string, unknown> = { ...bodyParsed.data, updatedBy: caller._id };
    if (bodyParsed.data.categoryId) {
      const category = await repository.get('categories', caller.shopId, objectId(bodyParsed.data.categoryId));
      if (!category?.isActive) return reply.code(400).send({ error: 'ACTIVE_CATEGORY_AND_BRAND_REQUIRED' });
      updates.categoryId = category._id;
      updates.categoryName = category.name;
    }
    if (bodyParsed.data.brandId) {
      const brand = await repository.get('brands', caller.shopId, objectId(bodyParsed.data.brandId));
      if (!brand?.isActive) return reply.code(400).send({ error: 'ACTIVE_CATEGORY_AND_BRAND_REQUIRED' });
      updates.brandId = brand._id;
      updates.brandName = brand.name;
    }
    if (bodyParsed.data.name) updates.normalizedName = normalizeName(bodyParsed.data.name);
    if (bodyParsed.data.code) updates.normalizedCode = normalizeName(bodyParsed.data.code);
    try {
      const updated = await repository.update('medicines', caller.shopId, id, updates, caller._id, (before, after) => [
        auditRecord(caller, 'medicine.updated', 'medicine', id, snapshot(before), snapshot(after)),
        ...(before.code !== after.code ? [auditRecord(caller, 'medicine.code_changed', 'medicine', id, { code: before.code }, { code: after.code })] : []),
      ]);
      if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(toDto(updated, 'medicines'));
    } catch (error) {
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });

  app.delete('/api/medicines/:id', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const id = objectId(parsed.data);
    const deleted = await repository.softDelete(
      'medicines', caller.shopId, id, caller._id, caller.role, 'medicine',
      (before) => auditRecord(caller, 'medicine.deleted', 'medicine', id, snapshot(before), null),
    );
    if (!deleted) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(204).send();
  });

  app.post('/api/medicines/:id/restore', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const id = objectId(parsed.data);
    try {
      const restored = await repository.restore(
        'medicines', caller.shopId, id, caller._id, caller.role, 'medicine',
        (before, after) => auditRecord(caller, 'medicine.restored', 'medicine', id, snapshot(before), snapshot(after)),
      );
      if (!restored) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(toDto(restored, 'medicines'));
    } catch (error) {
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });

  app.get('/api/medicines/:medicineId/units', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { medicineId?: unknown }).medicineId);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const medicineId = objectId(parsed.data);
    if (!await repository.get('medicines', caller.shopId, medicineId)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const result = await repository.list(makeListOptions(
      'medicineUnits', caller.shopId, query.data, { medicineId },
    ));
    return reply.send({
      items: result.rows.map((record) => toDto(record, 'medicineUnits')),
      page: query.data.page,
      pageSize: query.data.pageSize,
      total: result.total,
    });
  });

  app.get('/api/medicine-units/:id', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const unit = await repository.get('medicineUnits', caller.shopId, objectId(parsed.data));
    if (!unit) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send(toDto(unit, 'medicineUnits'));
  });

  app.post('/api/medicines/:medicineId/units', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const idParsed = idSchema.safeParse((request.params as { medicineId?: unknown }).medicineId);
    const bodyParsed = medicineUnitInputSchema.safeParse(request.body);
    if (!idParsed.success || !bodyParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const medicineId = objectId(idParsed.data);
    if (!await repository.get('medicines', caller.shopId, medicineId)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const now = new Date();
    const unit = createCatalogRecord(caller.shopId, caller._id, {
      medicineId,
      ...bodyParsed.data,
      normalizedName: normalizeName(bodyParsed.data.name),
      pricePaisa: Long.fromString(bodyParsed.data.pricePaisa),
    }, now);
    try {
      const saved = await repository.saveUnit(unit, caller._id, (_before, after) => [
        auditRecord(caller, 'medicine_unit.created', 'medicine_unit', after._id, null, snapshot(after), now),
      ]);
      return reply.code(201).send(toDto(saved, 'medicineUnits'));
    } catch (error) {
      if (error instanceof Error && error.message === 'PARENT_NOT_FOUND') return reply.code(404).send({ error: 'NOT_FOUND' });
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });

  app.patch('/api/medicine-units/:id', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const idParsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    const bodyParsed = medicineUnitUpdateSchema.safeParse(request.body);
    if (!idParsed.success || !bodyParsed.success || Object.keys(bodyParsed.data).length === 0) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    }
    const id = objectId(idParsed.data);
    const before = await repository.get('medicineUnits', caller.shopId, id);
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (before.isDefaultSaleUnit === true && bodyParsed.data.isDefaultSaleUnit === false) {
      return reply.code(409).send({ error: 'DEFAULT_UNIT_REQUIRED' });
    }
    const updates: Record<string, unknown> = { ...bodyParsed.data, updatedBy: caller._id };
    if (bodyParsed.data.name) updates.normalizedName = normalizeName(bodyParsed.data.name);
    if (bodyParsed.data.pricePaisa !== undefined) updates.pricePaisa = Long.fromString(bodyParsed.data.pricePaisa);
    try {
      const after = await repository.saveUnit({ ...before, ...updates, updatedAt: new Date() }, caller._id, (old, next) => [
        ...(old ? [auditRecord(caller, 'medicine_unit.updated', 'medicine_unit', id, snapshot(old), snapshot(next))] : []),
        ...(old && old.pricePaisa?.toString() !== next.pricePaisa?.toString()
          ? [auditRecord(caller, 'medicine_unit.price_changed', 'medicine_unit', id, { pricePaisa: old.pricePaisa?.toString() }, { pricePaisa: next.pricePaisa?.toString() })]
          : []),
      ]);
      return reply.send(toDto(after, 'medicineUnits'));
    } catch (error) {
      if (duplicateResponse(error, reply)) return;
      throw error;
    }
  });

  app.delete('/api/medicine-units/:id', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const id = objectId(parsed.data);
    const unit = await repository.get('medicineUnits', caller.shopId, id);
    if (!unit) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (unit.isDefaultSaleUnit === true) return reply.code(409).send({ error: 'DEFAULT_UNIT_REQUIRED' });
    const deleted = await repository.softDelete(
      'medicineUnits', caller.shopId, id, caller._id, caller.role, 'medicine_unit',
      (before) => auditRecord(caller, 'medicine_unit.deleted', 'medicine_unit', id, snapshot(before), null),
    );
    if (!deleted) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(204).send();
  });

  app.post('/api/medicines/:id/barcode', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const idParsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    const bodyParsed = barcodeAssignSchema.safeParse(request.body ?? {});
    if (!idParsed.success || !bodyParsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const medicineId = objectId(idParsed.data);
    try {
      const barcode = await repository.assignBarcode(
        caller.shopId,
        medicineId,
        bodyParsed.data.unitId ? objectId(bodyParsed.data.unitId) : undefined,
        caller._id,
        auditRecord(caller, 'medicine.barcode_assigned', 'medicine', medicineId, null, null),
      );
      return reply.send({ barcode });
    } catch (error) {
      if (error instanceof Error && error.message === 'CATALOG_RECORD_NOT_FOUND') return reply.code(404).send({ error: 'NOT_FOUND' });
      throw error;
    }
  });

  app.post('/api/medicines/barcodes/assign-missing', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = bulkBarcodeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const limit = parsed.data.limit;
    const [medicines, units] = await Promise.all([
      repository.list(makeListOptions('medicines', caller.shopId, {
        search: undefined,
        active: 'true',
        page: 1,
        pageSize: limit,
        sort: 'code',
        order: 'asc',
        categoryId: undefined,
        brandId: undefined,
        drugClass: undefined,
      })),
      repository.list(makeListOptions('medicineUnits', caller.shopId, {
        search: undefined,
        active: 'all',
        page: 1,
        pageSize: limit,
        sort: 'name',
        order: 'asc',
        categoryId: undefined,
        brandId: undefined,
        drugClass: undefined,
      })),
    ]);
    const candidates = [
      ...medicines.rows.filter((record) => !record.barcode).map((record) => ({ medicineId: record._id, unitId: undefined as ObjectId | undefined })),
      ...units.rows.filter((record) => !record.barcode).map((record) => ({
        medicineId: record.medicineId as ObjectId,
        unitId: record._id,
      })),
    ].slice(0, limit);
    const assigned: Array<{ medicineId: string; unitId?: string; barcode: string }> = [];
    const errors: Array<{ medicineId: string; unitId?: string; code: string }> = [];
    for (const candidate of candidates) {
      try {
        const barcode = await repository.assignBarcode(
          caller.shopId,
          candidate.medicineId,
          candidate.unitId,
          caller._id,
          auditRecord(caller, 'medicine.barcode_assigned', 'medicine', candidate.medicineId, null, null),
        );
        assigned.push({
          medicineId: candidate.medicineId.toHexString(),
          ...(candidate.unitId ? { unitId: candidate.unitId.toHexString() } : {}),
          barcode,
        });
      } catch {
        errors.push({
          medicineId: candidate.medicineId.toHexString(),
          ...(candidate.unitId ? { unitId: candidate.unitId.toHexString() } : {}),
          code: 'ASSIGNMENT_FAILED',
        });
      }
    }
    return reply.send({ assigned, errors, total: candidates.length });
  });

  app.post('/api/products/import', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsedBody = csvImportSchema.safeParse(request.body);
    if (!parsedBody.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    let parsedCsv: ReturnType<typeof parseCsv>;
    try {
      parsedCsv = parseCsv(parsedBody.data.csv.replace(/^\uFEFF/, ''));
    } catch {
      return reply.code(400).send({ error: 'MALFORMED_CSV' });
    }
    const hasCostColumn = parsedCsv.headers.at(-1) === 'latestCostPaisa';
    const callerMaySeeCost = canViewCost(caller.role, caller.permissions);
    if (parsedCsv.rows.length > 2000
      || (hasCostColumn && !callerMaySeeCost)
      || parsedCsv.headers.length !== CSV_HEADERS.length + (hasCostColumn ? 1 : 0)
      || CSV_HEADERS.some((header, index) => parsedCsv.headers[index] !== header)) {
      return reply.code(400).send({ error: 'INVALID_CSV_TEMPLATE' });
    }
    const imported: string[] = [];
    const errors: Array<{ line: number; code: string }> = [];
    for (const row of parsedCsv.rows) {
      if (row.values.length !== parsedCsv.headers.length) {
        errors.push({ line: row.line, code: 'COLUMN_COUNT_MISMATCH' });
        continue;
      }
      const raw = Object.fromEntries(CSV_HEADERS.map((header, index) => [header, row.values[index]]));
      const parsed = csvMedicineRowSchema.safeParse(raw);
      if (!parsed.success) {
        errors.push({ line: row.line, code: 'ROW_VALIDATION_FAILED' });
        continue;
      }
      const category = await repository.getByName('categories', caller.shopId, normalizeName(parsed.data.category));
      const brand = await repository.getByName('brands', caller.shopId, normalizeName(parsed.data.manufacturer));
      if (!category?.isActive || !brand?.isActive) {
        errors.push({ line: row.line, code: 'ACTIVE_CATEGORY_AND_BRAND_REQUIRED' });
        continue;
      }
      const now = new Date();
      const medicine = createCatalogRecord(caller.shopId, caller._id, {
        code: parsed.data.code,
        normalizedCode: normalizeName(parsed.data.code),
        name: parsed.data.name,
        normalizedName: normalizeName(parsed.data.name),
        genericName: parsed.data.genericName,
        strength: parsed.data.strength,
        categoryId: category._id,
        categoryName: category.name,
        brandId: brand._id,
        brandName: brand.name,
        drugClass: parsed.data.drugClass,
        storageCondition: parsed.data.storageCondition,
        rackLocation: parsed.data.rackLocation,
        minStockAlert: parsed.data.minStockAlert,
        requiresPrescription: parsed.data.requiresPrescription,
        isActive: parsed.data.isActive,
        ...(parsed.data.barcode ? { barcode: parsed.data.barcode } : {}),
        defaultUnitName: parsed.data.unitName,
        defaultUnitConversionFactor: parsed.data.conversionFactorBaseUnits,
        defaultUnitPricePaisa: Long.fromString(parsed.data.pricePaisa),
        activeBeforeDelete: null,
      }, now);
      const unit = createCatalogRecord(caller.shopId, caller._id, {
        medicineId: medicine._id,
        name: parsed.data.unitName,
        normalizedName: normalizeName(parsed.data.unitName),
        conversionFactorBaseUnits: parsed.data.conversionFactorBaseUnits,
        pricePaisa: Long.fromString(parsed.data.pricePaisa),
        isDefaultSaleUnit: true,
        ...(parsed.data.unitBarcode ? { barcode: parsed.data.unitBarcode } : {}),
      }, now);
      try {
        await repository.createMedicine(medicine, [unit], caller._id, [
          auditRecord(caller, 'medicine.imported', 'medicine', medicine._id, null, { ...snapshot(medicine), source: 'csv' }, now),
          auditRecord(caller, 'medicine_unit.created', 'medicine_unit', unit._id, null, snapshot(unit), now),
        ]);
        imported.push(medicine._id.toHexString());
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
          errors.push({ line: row.line, code: 'DUPLICATE_VALUE' });
          continue;
        }
        throw error;
      }
    }
    return reply.send({
      importedCount: imported.length,
      importedIds: imported,
      errorCount: errors.length,
      rowErrors: errors,
    });
  });

  app.get('/api/products/export.csv', { preHandler: productsPreHandler }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = listQuerySchema.safeParse({ ...(request.query as object), page: 1, pageSize: 200 });
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const query = parsed.data;
    const showCost = canViewCost(caller.role, caller.permissions);
    const result = await repository.list(makeListOptions('medicines', caller.shopId, query));
    const exportLimit = 10_000;
    if (result.total > exportLimit) return reply.code(413).send({ error: 'EXPORT_LIMIT_EXCEEDED' });
    const records = [...result.rows];
    while (records.length < result.total) {
      const nextPage = await repository.list(makeListOptions('medicines', caller.shopId, {
        ...query,
        page: Math.floor(records.length / query.pageSize) + 1,
      }));
      if (nextPage.rows.length === 0) break;
      records.push(...nextPage.rows);
    }
    let costMap = new Map<string, string>();
    if (showCost) {
      const today = await callerShopToday(request, reply, authRepository, caller);
      if (!today) return;
      costMap = await repository.latestCosts(caller.shopId, records.map((row) => row._id), today);
    }
    const defaultUnits = await repository.defaultUnits(caller.shopId, records.map((row) => row._id));
    const header = [...CSV_HEADERS, ...(showCost ? ['latestCostPaisa'] : [])].map(escapeCsvCell).join(',');
    const lines = records.map((record) => exportCsvRow(
      record,
      defaultUnits.get(record._id.toHexString())?.barcode,
      showCost ? costMap.get(record._id.toHexString()) : undefined,
    ));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="products.csv"')
      .send([header, ...lines].join('\r\n'));
  });

  app.get('/api/trash', {
    preHandler: [
      requireAuth(authRepository, tokenConfig, idempotencyStore),
      requireRole('admin', 'super_admin'),
      requirePermission('products'),
    ],
  }, async (request, reply) => {
    const caller = requiredCaller(request, reply);
    if (!caller) return;
    const parsed = trashQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const result = await repository.listTrash(
      caller.shopId,
      parsed.data.entityType as CatalogEntityType | undefined,
      parsed.data.page,
      parsed.data.pageSize,
    );
    return reply.send({
      items: result.rows.map((row) => ({
        id: row.entityId.toHexString(),
        entityType: row.entityType,
        action: row.action,
        displayName: row.displayName,
        actorId: row.actorId.toHexString(),
        role: row.role,
        occurredAt: row.occurredAt.toISOString(),
      })),
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total: result.total,
    });
  });
}
