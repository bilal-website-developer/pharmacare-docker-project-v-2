import { ObjectId } from 'mongodb';
import type { AuditRecord } from '../models.js';
import {
  generateInternalEan13,
  type CatalogCollection,
  type CatalogRecord,
  type CatalogEntityType,
} from '../catalog-domain.js';
import type {
  CatalogListOptions,
  CatalogRepository,
  MasterDataOverview,
  MasterDataUnit,
  TrashRecord,
} from '../catalog-repository.js';
import type { Role } from '../permissions.js';

function duplicateError(): Error & { code: number } {
  return Object.assign(new Error('duplicate'), { code: 11000 });
}

export class MemoryCatalogRepository implements CatalogRepository {
  private readonly records = new Map<CatalogCollection, Map<string, CatalogRecord>>(
    (['categories', 'brands', 'medicines', 'medicineUnits', 'suppliers'] as const)
      .map((collection) => [collection, new Map()]),
  );
  readonly audits: AuditRecord[] = [];
  readonly trash: TrashRecord[] = [];
  readonly costs = new Map<string, string>();
  private readonly barcodes = new Set<string>();

  private map(collection: CatalogCollection): Map<string, CatalogRecord> {
    return this.records.get(collection)!;
  }

  private active(collection: CatalogCollection, shopId: ObjectId): CatalogRecord[] {
    return [...this.map(collection).values()].filter((record) =>
      record.shopId.equals(shopId) && record.deletedAt === null,
    );
  }

  private reserveBarcode(record: CatalogRecord): void {
    const barcode = record.barcode;
    if (typeof barcode !== 'string' || barcode.length === 0) return;
    const key = `${record.shopId.toHexString()}:${barcode}`;
    if (this.barcodes.has(key)) throw duplicateError();
    this.barcodes.add(key);
  }

  private assertUnique(collection: CatalogCollection, record: CatalogRecord, exceptId?: ObjectId): void {
    if (collection !== 'medicineUnits' && this.active(collection, record.shopId).some((existing) =>
      existing._id.toHexString() !== exceptId?.toHexString()
      && record.normalizedName
      && existing.normalizedName === record.normalizedName,
    )) throw duplicateError();
    if (collection === 'medicines' && this.active(collection, record.shopId).some((existing) =>
      existing._id.toHexString() !== exceptId?.toHexString()
      && existing.normalizedCode === record.normalizedCode,
    )) throw duplicateError();
    if (collection === 'medicineUnits' && this.active(collection, record.shopId).some((existing) =>
      existing._id.toHexString() !== exceptId?.toHexString()
      && existing.medicineId?.equals(record.medicineId ?? new ObjectId())
      && existing.normalizedName === record.normalizedName,
    )) throw duplicateError();
  }

  async list(options: CatalogListOptions): Promise<{ rows: CatalogRecord[]; total: number }> {
    const search = options.search?.toLocaleLowerCase('en-US');
    const filtered = this.active(options.collection, options.shopId).filter((record) =>
      Object.entries(options.filter).every(([key, value]) => {
        const actual = record[key];
        if (actual instanceof ObjectId && value instanceof ObjectId) return actual.equals(value);
        return actual === value;
      }) && (!search || options.searchFields.some((field) =>
        String(record[field] ?? '').toLocaleLowerCase('en-US').includes(search),
      )),
    );
    filtered.sort((left, right) => {
      const a = left[options.sortField];
      const b = right[options.sortField];
      const result = String(a ?? '').localeCompare(String(b ?? ''), 'en');
      return (options.order === 'asc' ? result : -result) || left._id.toHexString().localeCompare(right._id.toHexString());
    });
    const start = (options.page - 1) * options.pageSize;
    return { rows: filtered.slice(start, start + options.pageSize), total: filtered.length };
  }

  async get(collection: CatalogCollection, shopId: ObjectId, id: ObjectId, includeDeleted = false): Promise<CatalogRecord | null> {
    const record = this.map(collection).get(id.toHexString());
    return record && record.shopId.equals(shopId) && (includeDeleted || record.deletedAt === null) ? record : null;
  }

  async getByName(collection: 'categories' | 'brands', shopId: ObjectId, normalizedName: string): Promise<CatalogRecord | null> {
    return this.active(collection, shopId).find((record) => record.normalizedName === normalizedName) ?? null;
  }

  async masterDataOverview(shopId: ObjectId, _today: Date, _showCost: boolean): Promise<MasterDataOverview> {
    const categories = this.active('categories', shopId);
    const manufacturers = this.active('brands', shopId);
    const medicines = this.active('medicines', shopId);
    const units = this.active('medicineUnits', shopId);
    const summarize = (record: CatalogRecord, field: 'categoryId' | 'brandId') => {
      const related = medicines.filter((medicine) => (medicine[field] as ObjectId | undefined)?.equals(record._id));
      return {
        id: record._id.toHexString(),
        name: String(record.name),
        is_active: record.isActive === true,
        product_count: related.length,
        low_count: 0,
        out_count: 0,
        expiring_count: 0,
        stock_value_paisa: null,
      };
    };
    return {
      categories: categories.map((record) => summarize(record, 'categoryId')),
      manufacturers: manufacturers.map((record) => summarize(record, 'brandId')),
      summary: {
        category_count: categories.length,
        active_category_count: categories.filter((record) => record.isActive === true).length,
        manufacturer_count: manufacturers.length,
        active_manufacturer_count: manufacturers.filter((record) => record.isActive === true).length,
        product_count: medicines.length,
        unit_count: units.length,
      },
    };
  }

  async listMasterUnits(shopId: ObjectId): Promise<MasterDataUnit[]> {
    const medicines = new Map(this.active('medicines', shopId)
      .map((medicine) => [medicine._id.toHexString(), medicine]));
    return this.active('medicineUnits', shopId).flatMap((unit) => {
      const medicineId = unit.medicineId;
      const medicine = medicineId ? medicines.get(medicineId.toHexString()) : undefined;
      if (!medicineId || !medicine) return [];
      return [{
        id: unit._id.toHexString(),
        medicine_id: medicineId.toHexString(),
        name: String(unit.name),
        conversion_factor: Number(unit.conversionFactorBaseUnits),
        is_default_sale_unit: unit.isDefaultSaleUnit === true,
        price_paisa: String(unit.pricePaisa),
        barcode: typeof unit.barcode === 'string' ? unit.barcode : null,
        medicine_name: `${String(medicine.name)} · ${String(medicine.genericName ?? '')} (${String(medicine.code)})`,
      }];
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  async mergeNamed(
    collection: 'categories' | 'brands',
    shopId: ObjectId,
    sourceId: ObjectId,
    targetId: ObjectId,
    actorId: ObjectId,
    mayUpdateProducts: boolean,
    audit: (source: CatalogRecord, target: CatalogRecord, productCount: number) => AuditRecord,
    trash: (source: CatalogRecord) => TrashRecord,
  ): Promise<number | null> {
    if (sourceId.equals(targetId)) throw new Error('MERGE_TARGET_INVALID');
    const source = await this.get(collection, shopId, sourceId);
    const target = await this.get(collection, shopId, targetId);
    if (!source || !target) return null;
    const referenceField = collection === 'categories' ? 'categoryId' : 'brandId';
    const snapshotField = collection === 'categories' ? 'categoryName' : 'brandName';
    const related = this.active('medicines', shopId)
      .filter((medicine) => (medicine[referenceField] as ObjectId | undefined)?.equals(sourceId));
    if (related.length > 0 && !mayUpdateProducts) throw new Error('PRODUCTS_PERMISSION_REQUIRED');
    const now = new Date();
    for (const medicine of related) {
      medicine[referenceField] = targetId;
      medicine[snapshotField] = target.name;
      medicine.updatedBy = actorId;
      medicine.updatedAt = now;
    }
    const deleted: CatalogRecord = {
      ...source,
      activeBeforeDelete: source.isActive,
      isActive: false,
      deletedAt: now,
      updatedBy: actorId,
      updatedAt: now,
    };
    this.map(collection).set(sourceId.toHexString(), deleted);
    this.trash.push(trash(source));
    this.audits.push(audit(source, target, related.length));
    return related.length;
  }

  async create(collection: CatalogCollection, record: CatalogRecord, _actorId: ObjectId, audit: AuditRecord): Promise<CatalogRecord> {
    this.assertUnique(collection, record);
    this.reserveBarcode(record);
    this.map(collection).set(record._id.toHexString(), record);
    this.audits.push(audit);
    return record;
  }

  async createMedicine(medicine: CatalogRecord, units: CatalogRecord[], _actorId: ObjectId, audits: AuditRecord[]): Promise<void> {
    this.assertUnique('medicines', medicine);
    for (const unit of units) this.assertUnique('medicineUnits', unit);
    const pendingBarcodes = new Set<string>();
    for (const record of [medicine, ...units]) {
      if (typeof record.barcode !== 'string' || !record.barcode) continue;
      const key = `${record.shopId.toHexString()}:${record.barcode}`;
      if (this.barcodes.has(key) || pendingBarcodes.has(key)) throw duplicateError();
      pendingBarcodes.add(key);
    }
    for (const key of pendingBarcodes) this.barcodes.add(key);
    this.map('medicines').set(medicine._id.toHexString(), medicine);
    for (const unit of units) this.map('medicineUnits').set(unit._id.toHexString(), unit);
    this.audits.push(...audits);
  }

  async update(
    collection: CatalogCollection,
    shopId: ObjectId,
    id: ObjectId,
    updates: Record<string, unknown>,
    _actorId: ObjectId,
    audit: (before: CatalogRecord, after: CatalogRecord) => AuditRecord[],
  ): Promise<CatalogRecord | null> {
    const before = await this.get(collection, shopId, id);
    if (!before) return null;
    const after = { ...before, ...updates, updatedAt: new Date() } as CatalogRecord;
    this.assertUnique(collection, after, id);
    if (before.barcode !== after.barcode) {
      if (typeof before.barcode === 'string') this.barcodes.delete(`${shopId.toHexString()}:${before.barcode}`);
      if (typeof after.barcode === 'string') this.reserveBarcode(after);
    }
    this.map(collection).set(id.toHexString(), after);
    const events = audit(before, after);
    this.audits.push(...events);
    if ((collection === 'categories' || collection === 'brands') && before.name !== after.name) {
      const foreignKey = collection === 'categories' ? 'categoryId' : 'brandId';
      const nameKey = collection === 'categories' ? 'categoryName' : 'brandName';
      for (const medicine of this.active('medicines', shopId)) {
        if ((medicine[foreignKey] as ObjectId | undefined)?.equals(id)) medicine[nameKey] = after.name;
      }
    }
    return after;
  }

  async saveUnit(
    unit: CatalogRecord,
    _actorId: ObjectId,
    audit: (before: CatalogRecord | null, after: CatalogRecord) => AuditRecord[],
  ): Promise<CatalogRecord> {
    if (!await this.get('medicines', unit.shopId, unit.medicineId!)) throw new Error('PARENT_NOT_FOUND');
    const before = this.map('medicineUnits').get(unit._id.toHexString()) ?? null;
    this.assertUnique('medicineUnits', unit, before?._id);
    if (before?.barcode !== unit.barcode && typeof unit.barcode === 'string') this.reserveBarcode(unit);
    if (unit.isDefaultSaleUnit) {
      for (const record of this.active('medicineUnits', unit.shopId)) {
        if (record.medicineId?.equals(unit.medicineId!) && !record._id.equals(unit._id)) record.isDefaultSaleUnit = false;
      }
    }
    this.map('medicineUnits').set(unit._id.toHexString(), unit);
    const defaultUnit = this.active('medicineUnits', unit.shopId)
      .find((record) => record.medicineId?.equals(unit.medicineId!) && record.isDefaultSaleUnit);
    const medicine = await this.get('medicines', unit.shopId, unit.medicineId!);
    if (medicine && defaultUnit) {
      medicine.defaultUnitName = defaultUnit.name;
      medicine.defaultUnitConversionFactor = defaultUnit.conversionFactorBaseUnits;
      medicine.defaultUnitPricePaisa = defaultUnit.pricePaisa;
    }
    this.audits.push(...audit(before, unit));
    return unit;
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
    const before = await this.get(collection, shopId, id);
    if (!before) return null;
    const now = new Date();
    const after: CatalogRecord = {
      ...before,
      ...(typeof before.isActive === 'boolean' ? { activeBeforeDelete: before.isActive, isActive: false } : {}),
      deletedAt: now,
      updatedAt: now,
    };
    this.map(collection).set(id.toHexString(), after);
    this.trash.push({
      shopId, actorId, entityId: id, entityType, action: 'deleted',
      displayName: String(before.name ?? before.code ?? ''),
      role, occurredAt: now,
    });
    this.audits.push(audit(before));
    return after;
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
    const before = this.map(collection).get(id.toHexString());
    if (!before || !before.shopId.equals(shopId) || !(before.deletedAt instanceof Date)) return null;
    const now = new Date();
    const after = {
      ...before,
      deletedAt: null,
      updatedAt: now,
      ...(typeof before.activeBeforeDelete === 'boolean'
        ? { isActive: before.activeBeforeDelete, activeBeforeDelete: null }
        : {}),
    } as CatalogRecord;
    this.map(collection).set(id.toHexString(), after);
    this.trash.push({
      shopId, actorId, entityId: id, entityType, action: 'restored',
      displayName: String(before.name ?? before.code ?? ''),
      role, occurredAt: now,
    });
    this.audits.push(audit(before, after));
    return after;
  }

  async listTrash(shopId: ObjectId, entityType: CatalogEntityType | undefined, page: number, pageSize: number): Promise<{ rows: TrashRecord[]; total: number }> {
    const rows = this.trash.filter((record) =>
      record.shopId.equals(shopId) && (!entityType || record.entityType === entityType),
    ).sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
    return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
  }

  async latestCosts(shopId: ObjectId, medicineIds: ObjectId[], _today: Date): Promise<Map<string, string>> {
    return new Map(medicineIds.flatMap((id) => {
      const cost = this.costs.get(`${shopId.toHexString()}:${id.toHexString()}`);
      return cost === undefined ? [] : [[id.toHexString(), cost]];
    }));
  }

  async defaultUnits(shopId: ObjectId, medicineIds: ObjectId[]): Promise<Map<string, CatalogRecord>> {
    const ids = new Set(medicineIds.map((id) => id.toHexString()));
    return new Map(this.active('medicineUnits', shopId)
      .filter((unit) => unit.isDefaultSaleUnit && unit.medicineId && ids.has(unit.medicineId.toHexString()))
      .map((unit) => [unit.medicineId!.toHexString(), unit]));
  }

  async assignBarcode(
    shopId: ObjectId,
    medicineId: ObjectId,
    unitId: ObjectId | undefined,
    _actorId: ObjectId,
    audit: AuditRecord,
  ): Promise<string> {
    const collection: CatalogCollection = unitId ? 'medicineUnits' : 'medicines';
    const record = await this.get(collection, shopId, unitId ?? medicineId);
    if (!record || (unitId && !record.medicineId?.equals(medicineId))) throw new Error('CATALOG_RECORD_NOT_FOUND');
    if (typeof record.barcode === 'string' && record.barcode) return record.barcode;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const seed = String(Math.floor(Math.random() * 1_000_000_000_000)).padStart(12, '0');
      const barcode = generateInternalEan13(seed);
      const key = `${shopId.toHexString()}:${barcode}`;
      if (this.barcodes.has(key)) continue;
      this.barcodes.add(key);
      record.barcode = barcode;
      record.updatedAt = new Date();
      this.audits.push({ ...audit, after: { barcode } });
      return barcode;
    }
    throw new Error('BARCODE_ASSIGNMENT_RETRIES_EXHAUSTED');
  }
}
