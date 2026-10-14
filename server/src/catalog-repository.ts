import { randomInt } from 'node:crypto';
import {
  MongoClient,
  ObjectId,
  type ClientSession,
  type Collection,
  type Db,
  type Filter,
  type Sort,
} from 'mongodb';
import type { AuditRecord } from './models.js';
import { generateInternalEan13, type CatalogCollection, type CatalogRecord, type CatalogEntityType } from './catalog-domain.js';
import type { Role } from './permissions.js';

export interface CatalogListOptions {
  collection: CatalogCollection;
  shopId: ObjectId;
  filter: Record<string, unknown>;
  searchFields: readonly string[];
  search?: string;
  sortField: string;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface TrashRecord {
  shopId: ObjectId;
  actorId: ObjectId;
  entityId: ObjectId;
  entityType: CatalogEntityType;
  action: 'deleted' | 'restored';
  displayName: string;
  role: Role;
  occurredAt: Date;
}

export interface CatalogRepository {
  list(options: CatalogListOptions): Promise<{ rows: CatalogRecord[]; total: number }>;
  get(collection: CatalogCollection, shopId: ObjectId, id: ObjectId, includeDeleted?: boolean): Promise<CatalogRecord | null>;
  getByName(collection: 'categories' | 'brands', shopId: ObjectId, normalizedName: string): Promise<CatalogRecord | null>;
  create(collection: CatalogCollection, record: CatalogRecord, actorId: ObjectId, audit: AuditRecord): Promise<CatalogRecord>;
  createMedicine(medicine: CatalogRecord, units: CatalogRecord[], actorId: ObjectId, audits: AuditRecord[]): Promise<void>;
  update(
    collection: CatalogCollection,
    shopId: ObjectId,
    id: ObjectId,
    updates: Record<string, unknown>,
    actorId: ObjectId,
    audit: (before: CatalogRecord, after: CatalogRecord) => AuditRecord[],
  ): Promise<CatalogRecord | null>;
  saveUnit(
    unit: CatalogRecord,
    actorId: ObjectId,
    audit: (before: CatalogRecord | null, after: CatalogRecord) => AuditRecord[],
  ): Promise<CatalogRecord>;
  softDelete(
    collection: CatalogCollection,
    shopId: ObjectId,
    id: ObjectId,
    actorId: ObjectId,
    role: Role,
    entityType: CatalogEntityType,
    audit: (before: CatalogRecord) => AuditRecord,
  ): Promise<CatalogRecord | null>;
  restore(
    collection: CatalogCollection,
    shopId: ObjectId,
    id: ObjectId,
    actorId: ObjectId,
    role: Role,
    entityType: CatalogEntityType,
    audit: (before: CatalogRecord, after: CatalogRecord) => AuditRecord,
  ): Promise<CatalogRecord | null>;
  listTrash(shopId: ObjectId, entityType: CatalogEntityType | undefined, page: number, pageSize: number): Promise<{ rows: TrashRecord[]; total: number }>;
  latestCosts(shopId: ObjectId, medicineIds: ObjectId[]): Promise<Map<string, string>>;
  defaultUnits(shopId: ObjectId, medicineIds: ObjectId[]): Promise<Map<string, CatalogRecord>>;
  assignBarcode(shopId: ObjectId, medicineId: ObjectId, unitId: ObjectId | undefined, actorId: ObjectId, audit: AuditRecord): Promise<string>;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function collectionName(collection: CatalogCollection): string {
  return collection;
}

function barcodeClaim(
  shopId: ObjectId,
  collection: CatalogCollection,
  record: CatalogRecord,
  barcode: string,
  createdAt: Date,
  actorId: ObjectId,
): Record<string, unknown> {
  const isUnit = collection === 'medicineUnits';
  return {
    shopId,
    normalizedBarcode: barcode,
    barcode,
    ownerType: isUnit ? 'UNIT' : 'MEDICINE',
    ownerId: isUnit ? record.medicineId : record._id,
    ...(isUnit ? { unitId: record._id } : { unitId: null }),
    createdAt,
    createdBy: actorId,
  };
}

export class MongoCatalogRepository implements CatalogRepository {
  private readonly database: Db;

  constructor(private readonly client: MongoClient, databaseName: string) {
    this.database = client.db(databaseName);
  }

  private records(collection: CatalogCollection): Collection<CatalogRecord> {
    return this.database.collection<CatalogRecord>(collectionName(collection));
  }

  async list(options: CatalogListOptions): Promise<{ rows: CatalogRecord[]; total: number }> {
    const filter: Filter<CatalogRecord> = {
      shopId: options.shopId,
      deletedAt: null,
      ...options.filter,
    };
    if (options.search) {
      const expression = new RegExp(escapeRegex(options.search), 'i');
      filter.$or = options.searchFields.map((field) => ({ [field]: expression }));
    }
    const sort: Sort = { [options.sortField]: options.order === 'asc' ? 1 : -1, _id: 1 };
    const collection = this.records(options.collection);
    const [rows, total] = await Promise.all([
      collection.find(filter).sort(sort).skip((options.page - 1) * options.pageSize).limit(options.pageSize).toArray(),
      collection.countDocuments(filter),
    ]);
    return { rows, total };
  }

  async get(
    collection: CatalogCollection,
    shopId: ObjectId,
    id: ObjectId,
    includeDeleted = false,
  ): Promise<CatalogRecord | null> {
    const filter: Filter<CatalogRecord> = { _id: id, shopId };
    if (!includeDeleted) filter.deletedAt = null;
    return this.records(collection).findOne(filter);
  }

  async getByName(collection: 'categories' | 'brands', shopId: ObjectId, normalizedName: string): Promise<CatalogRecord | null> {
    return this.records(collection).findOne({ shopId, normalizedName, deletedAt: null });
  }

  async defaultUnits(shopId: ObjectId, medicineIds: ObjectId[]): Promise<Map<string, CatalogRecord>> {
    if (medicineIds.length === 0) return new Map();
    const units = await this.records('medicineUnits').find({
      shopId,
      medicineId: { $in: medicineIds },
      isDefaultSaleUnit: true,
      deletedAt: null,
    }).toArray();
    return new Map(units.map((unit) => [unit.medicineId!.toHexString(), unit]));
  }

  private async addBarcodeClaim(
    session: ClientSession,
    shopId: ObjectId,
    collection: CatalogCollection,
    record: CatalogRecord,
    barcode: string,
    actorId: ObjectId,
    now: Date,
  ): Promise<void> {
    await this.database.collection('barcodeClaims').insertOne(
      barcodeClaim(shopId, collection, record, barcode, now, actorId),
      { session },
    );
  }

  async create(
    collection: CatalogCollection,
    record: CatalogRecord,
    actorId: ObjectId,
    audit: AuditRecord,
  ): Promise<CatalogRecord> {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        if (typeof record.barcode === 'string' && record.barcode.length > 0) {
          await this.addBarcodeClaim(session, record.shopId, collection, record, record.barcode, actorId, record.createdAt);
        }
        await this.records(collection).insertOne(record, { session });
        await this.database.collection<AuditRecord>('auditLogs').insertOne(audit, { session });
      });
      return record;
    } finally {
      await session.endSession();
    }
  }

  async createMedicine(
    medicine: CatalogRecord,
    units: CatalogRecord[],
    actorId: ObjectId,
    audits: AuditRecord[],
  ): Promise<void> {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        if (typeof medicine.barcode === 'string' && medicine.barcode.length > 0) {
          await this.addBarcodeClaim(session, medicine.shopId, 'medicines', medicine, medicine.barcode, actorId, medicine.createdAt);
        }
        for (const unit of units) {
          if (typeof unit.barcode === 'string' && unit.barcode.length > 0) {
            await this.addBarcodeClaim(session, medicine.shopId, 'medicineUnits', unit, unit.barcode, actorId, unit.createdAt);
          }
        }
        await this.records('medicines').insertOne(medicine, { session });
        if (units.length) await this.records('medicineUnits').insertMany(units, { session });
        if (audits.length) await this.database.collection<AuditRecord>('auditLogs').insertMany(audits, { session });
      });
    } finally {
      await session.endSession();
    }
  }

  async update(
    collection: CatalogCollection,
    shopId: ObjectId,
    id: ObjectId,
    updates: Record<string, unknown>,
    actorId: ObjectId,
    audit: (before: CatalogRecord, after: CatalogRecord) => AuditRecord[],
  ): Promise<CatalogRecord | null> {
    const session = this.client.startSession();
    let updated: CatalogRecord | null = null;
    try {
      await session.withTransaction(async () => {
        const records = this.records(collection);
        const before = await records.findOne({ _id: id, shopId, deletedAt: null }, { session });
        if (!before) return;
        const after = { ...before, ...updates, updatedAt: new Date() } as CatalogRecord;
        if (before.barcode !== after.barcode) {
          if (typeof before.barcode === 'string' && before.barcode.length > 0) {
            await this.database.collection('barcodeClaims').deleteOne({
              shopId,
              normalizedBarcode: before.barcode,
              ownerType: collection === 'medicineUnits' ? 'UNIT' : 'MEDICINE',
              ownerId: collection === 'medicineUnits' ? before.medicineId : id,
              ...(collection === 'medicineUnits' ? { unitId: id } : { unitId: null }),
            }, { session });
          }
          if (typeof after.barcode === 'string' && after.barcode.length > 0) {
            await this.addBarcodeClaim(session, shopId, collection, after, after.barcode, actorId, after.updatedAt);
          }
        }
        await records.updateOne(
          { _id: id, shopId, deletedAt: null },
          { $set: { ...updates, updatedAt: new Date() } },
          { session },
        );
        const stored = await records.findOne({ _id: id, shopId }, { session });
        if (!stored) throw new Error('Catalog record disappeared inside transaction');
        const events = audit(before, stored);
        if ((collection === 'categories' || collection === 'brands') && before.name !== stored.name) {
          await this.records('medicines').updateMany(
            {
              shopId,
              [collection === 'categories' ? 'categoryId' : 'brandId']: id,
              deletedAt: null,
            },
            { $set: { [collection === 'categories' ? 'categoryName' : 'brandName']: stored.name, updatedAt: new Date() } },
            { session },
          );
        }
        if (events.length) await this.database.collection<AuditRecord>('auditLogs').insertMany(events, { session });
        updated = stored;
      });
      return updated;
    } finally {
      await session.endSession();
    }
  }

  async saveUnit(
    unit: CatalogRecord,
    actorId: ObjectId,
    audit: (before: CatalogRecord | null, after: CatalogRecord) => AuditRecord[],
  ): Promise<CatalogRecord> {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        const units = this.records('medicineUnits');
        const parent = await this.records('medicines').findOne(
          { _id: unit.medicineId, shopId: unit.shopId, deletedAt: null },
          { projection: { _id: 1 }, session },
        );
        if (!parent) throw new Error('PARENT_NOT_FOUND');
        const before = await units.findOne({ _id: unit._id, shopId: unit.shopId, deletedAt: null }, { session });
        if (unit.isDefaultSaleUnit === true) {
          await units.updateMany(
            { shopId: unit.shopId, medicineId: unit.medicineId, deletedAt: null, _id: { $ne: unit._id } },
            { $set: { isDefaultSaleUnit: false, updatedAt: new Date() } },
            { session },
          );
        }
        if (before) {
          const merged = { ...before, ...unit, updatedAt: new Date() } as CatalogRecord;
          if (before.barcode !== merged.barcode) {
            if (typeof before.barcode === 'string' && before.barcode.length > 0) {
              await this.database.collection('barcodeClaims').deleteOne({
                shopId: unit.shopId,
                normalizedBarcode: before.barcode,
                ownerType: 'UNIT',
                ownerId: unit.medicineId,
                unitId: unit._id,
              }, { session });
            }
            if (typeof merged.barcode === 'string' && merged.barcode.length > 0) {
              await this.addBarcodeClaim(session, unit.shopId, 'medicineUnits', merged, merged.barcode, actorId, merged.updatedAt);
            }
          }
          await units.updateOne({ _id: unit._id, shopId: unit.shopId }, { $set: { ...unit, updatedAt: merged.updatedAt } }, { session });
          const stored = await units.findOne({ _id: unit._id, shopId: unit.shopId }, { session });
          if (!stored) throw new Error('Medicine unit disappeared inside transaction');
          const defaultUnit = await units.findOne({
            shopId: unit.shopId,
            medicineId: unit.medicineId,
            isDefaultSaleUnit: true,
            deletedAt: null,
          }, { session });
          if (defaultUnit) {
            await this.records('medicines').updateOne(
              { _id: unit.medicineId, shopId: unit.shopId },
              { $set: {
                defaultUnitName: defaultUnit.name,
                defaultUnitConversionFactor: defaultUnit.conversionFactorBaseUnits,
                defaultUnitPricePaisa: defaultUnit.pricePaisa,
                updatedAt: new Date(),
              } },
              { session },
            );
          }
          await this.database.collection<AuditRecord>('auditLogs').insertMany(audit(before, stored), { session });
        } else {
          if (typeof unit.barcode === 'string' && unit.barcode.length > 0) {
            await this.addBarcodeClaim(session, unit.shopId, 'medicineUnits', unit, unit.barcode, actorId, unit.createdAt);
          }
          await units.insertOne(unit, { session });
          if (unit.isDefaultSaleUnit === true) {
            await this.records('medicines').updateOne(
              { _id: unit.medicineId, shopId: unit.shopId },
              { $set: {
                defaultUnitName: unit.name,
                defaultUnitConversionFactor: unit.conversionFactorBaseUnits,
                defaultUnitPricePaisa: unit.pricePaisa,
                updatedAt: new Date(),
              } },
              { session },
            );
          }
          await this.database.collection<AuditRecord>('auditLogs').insertMany(audit(null, unit), { session });
        }
      });
      return unit;
    } finally {
      await session.endSession();
    }
  }

  async softDelete(
    collection: CatalogCollection,
    shopId: ObjectId,
    id: ObjectId,
    actorId: ObjectId,
    role: Role,
    entityType: CatalogEntityType,
    audit: (before: CatalogRecord) => AuditRecord,
  ): Promise<CatalogRecord | null> {
    const session = this.client.startSession();
    let deleted: CatalogRecord | null = null;
    try {
      await session.withTransaction(async () => {
        const records = this.records(collection);
        const before = await records.findOne({ _id: id, shopId, deletedAt: null }, { session });
        if (!before) return;
        const now = new Date();
        const after: CatalogRecord = {
          ...before,
          activeBeforeDelete: typeof before.isActive === 'boolean' ? before.isActive : undefined,
          isActive: false,
          deletedAt: now,
          updatedAt: now,
        };
        await records.updateOne({ _id: id, shopId, deletedAt: null }, {
          $set: {
            deletedAt: now,
            updatedAt: now,
            ...(typeof before.isActive === 'boolean' ? { isActive: false, activeBeforeDelete: before.isActive } : {}),
          },
        }, { session });
        const event: TrashRecord = {
          shopId,
          actorId,
          entityId: id,
          entityType,
          action: 'deleted',
          displayName: String(before.name ?? before.code ?? ''),
          role,
          occurredAt: now,
        };
        await this.database.collection('trashEvents').insertOne(event, { session });
        await this.database.collection<AuditRecord>('auditLogs').insertOne(audit(before), { session });
        deleted = after;
      });
      return deleted;
    } finally {
      await session.endSession();
    }
  }

  async restore(
    collection: CatalogCollection,
    shopId: ObjectId,
    id: ObjectId,
    actorId: ObjectId,
    role: Role,
    entityType: CatalogEntityType,
    audit: (before: CatalogRecord, after: CatalogRecord) => AuditRecord,
  ): Promise<CatalogRecord | null> {
    const session = this.client.startSession();
    let restored: CatalogRecord | null = null;
    try {
      await session.withTransaction(async () => {
        const records = this.records(collection);
        const before = await records.findOne({ _id: id, shopId, deletedAt: { $ne: null } }, { session });
        if (!before) return;
        const now = new Date();
        const updates: Record<string, unknown> = { deletedAt: null, updatedAt: now };
        if (typeof before.activeBeforeDelete === 'boolean') {
          updates.isActive = before.activeBeforeDelete;
          updates.activeBeforeDelete = null;
        }
        await records.updateOne({ _id: id, shopId, deletedAt: { $ne: null } }, { $set: updates }, { session });
        const after = { ...before, ...updates } as CatalogRecord;
        await this.database.collection('trashEvents').insertOne({
          shopId,
          actorId,
          entityId: id,
          entityType,
          action: 'restored',
          displayName: String(before.name ?? before.code ?? ''),
          role,
          occurredAt: now,
        }, { session });
        await this.database.collection<AuditRecord>('auditLogs').insertOne(audit(before, after), { session });
        restored = after;
      });
      return restored;
    } finally {
      await session.endSession();
    }
  }

  async listTrash(
    shopId: ObjectId,
    entityType: CatalogEntityType | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ rows: TrashRecord[]; total: number }> {
    const filter = { shopId, ...(entityType ? { entityType } : {}) };
    const collection = this.database.collection<TrashRecord>('trashEvents');
    const [rows, total] = await Promise.all([
      collection.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      collection.countDocuments(filter),
    ]);
    return { rows, total };
  }

  async latestCosts(shopId: ObjectId, medicineIds: ObjectId[]): Promise<Map<string, string>> {
    if (medicineIds.length === 0) return new Map();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const rows = await this.database.collection<{
      _id: ObjectId;
      unitCostPaisaPerBaseUnit: { toString(): string } | null;
    }>('stockBatches').aggregate([
      { $match: { shopId, medicineId: { $in: medicineIds }, quantityRemainingBaseUnits: { $gt: 0 }, expiryDate: { $gte: today } } },
      { $sort: { receivedDate: -1, _id: -1 } },
      { $group: { _id: '$medicineId', unitCostPaisaPerBaseUnit: { $first: '$unitCostPaisaPerBaseUnit' } } },
    ]).toArray();
    return new Map(rows.map((row) => [row._id.toHexString(), row.unitCostPaisaPerBaseUnit?.toString() ?? '']));
  }

  async assignBarcode(
    shopId: ObjectId,
    medicineId: ObjectId,
    unitId: ObjectId | undefined,
    actorId: ObjectId,
    audit: AuditRecord,
  ): Promise<string> {
    const collection = unitId ? this.records('medicineUnits') : this.records('medicines');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const session = this.client.startSession();
      try {
        let barcode = '';
        await session.withTransaction(async () => {
          const filter = unitId
            ? { _id: unitId, shopId, medicineId, deletedAt: null }
            : { _id: medicineId, shopId, deletedAt: null };
          const record = await collection.findOne(filter, { session });
          if (!record) throw new Error('CATALOG_RECORD_NOT_FOUND');
          if (typeof record.barcode === 'string' && record.barcode.length > 0) {
            barcode = record.barcode;
            return;
          }
          const seed = String(randomInt(0, 1_000_000_000_000)).padStart(12, '0');
          barcode = generateInternalEan13(seed);
          await this.addBarcodeClaim(
            session,
            shopId,
            unitId ? 'medicineUnits' : 'medicines',
            record,
            barcode,
            actorId,
            new Date(),
          );
          await collection.updateOne({ _id: record._id, shopId, deletedAt: null }, {
            $set: { barcode, updatedAt: new Date() },
          }, { session });
          await this.database.collection<AuditRecord>('auditLogs').insertOne({
            ...audit,
            event: 'medicine.barcode_assigned',
            entityType: unitId ? 'medicine_unit' : 'medicine',
            entityId: unitId ?? medicineId,
            after: { barcode },
            occurredAt: new Date(),
          }, { session });
        });
        return barcode;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        if (attempt === 19) throw new Error('BARCODE_ASSIGNMENT_RETRIES_EXHAUSTED');
      } finally {
        await session.endSession();
      }
    }
    throw new Error('BARCODE_ASSIGNMENT_RETRIES_EXHAUSTED');
  }
}
