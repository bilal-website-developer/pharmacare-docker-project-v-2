import { Long, MongoClient, ObjectId } from 'mongodb';
import { z } from 'zod';
import type { AuditRecord, UserRecord } from './models.js';
import { normalizeName, type CatalogRecord } from './catalog-domain.js';

const starterCatalogEntrySchema = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  genericName: z.string().trim().min(1).max(200),
  strength: z.string().trim().max(120).default(''),
  category: z.string().trim().min(1).max(160),
  manufacturer: z.string().trim().min(1).max(160),
  drugClass: z.enum(['OTC', 'RX', 'CONTROLLED', 'NARCOTIC']),
  storageCondition: z.enum(['ROOM_TEMPERATURE', 'COOL', 'COLD_REFRIGERATED'])
    .default('ROOM_TEMPERATURE'),
  rackLocation: z.string().trim().max(120).default(''),
  minStockAlert: z.number().int().min(0).max(2_147_483_647).default(0),
  requiresPrescription: z.boolean().default(false),
  unitName: z.string().trim().min(1).max(120),
  conversionFactorBaseUnits: z.number().int().min(1).max(2_147_483_647),
}).strict();

export const starterCatalogSchema = z.array(starterCatalogEntrySchema).min(1).max(500)
  .superRefine((entries, context) => {
    const codes = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const normalizedCode = normalizeName(entry.code);
      if (codes.has(normalizedCode)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'code'],
          message: 'Starter catalog codes must be unique.',
        });
      }
      codes.add(normalizedCode);
    }
  });

export type StarterCatalogEntry = z.infer<typeof starterCatalogEntrySchema>;

export function parseStarterCatalog(value: unknown): StarterCatalogEntry[] {
  return starterCatalogSchema.parse(value);
}

export interface StarterCatalogImportResult {
  importedCount: number;
  skippedCount: number;
  createdCategoryCount: number;
  createdManufacturerCount: number;
}

function audit(
  shopId: ObjectId,
  actorId: ObjectId,
  event: string,
  entityType: string,
  entityId: ObjectId,
  after: Record<string, unknown>,
  occurredAt: Date,
): AuditRecord {
  return { shopId, actorId, event, entityType, entityId, before: null, after, occurredAt };
}

function catalogRecord(
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

export async function importStarterCatalog(
  client: MongoClient,
  databaseName: string,
  shopId: ObjectId,
  actorId: ObjectId,
  entries: readonly StarterCatalogEntry[],
): Promise<StarterCatalogImportResult> {
  const database = client.db(databaseName);
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      const now = new Date();
      const shop = await database.collection('shops').findOne(
        { _id: shopId, status: 'ACTIVE' },
        { session },
      );
      if (!shop) throw new Error('STARTER_CATALOG_SHOP_NOT_FOUND');
      const actor = await database.collection<UserRecord>('users').findOne(
        { _id: actorId, shopId, role: 'super_admin', isActive: true, deletedAt: null },
        { session },
      );
      if (!actor) throw new Error('STARTER_CATALOG_SUPER_ADMIN_REQUIRED');

      const audits: AuditRecord[] = [];
      const result: StarterCatalogImportResult = {
        importedCount: 0,
        skippedCount: 0,
        createdCategoryCount: 0,
        createdManufacturerCount: 0,
      };
      const namedCollections = {
        category: database.collection<CatalogRecord>('categories'),
        manufacturer: database.collection<CatalogRecord>('brands'),
      };

      const getOrCreateName = async (
        kind: 'category' | 'manufacturer',
        name: string,
      ): Promise<CatalogRecord> => {
        const collection = namedCollections[kind];
        const normalizedName = normalizeName(name);
        const existing = await collection.findOne({ shopId, normalizedName }, { session });
        if (existing) {
          if (existing.deletedAt instanceof Date || existing.isActive !== true) {
            throw new Error(`STARTER_CATALOG_${kind.toUpperCase()}_UNAVAILABLE`);
          }
          return existing;
        }
        const record = catalogRecord(shopId, actorId, {
          name,
          normalizedName,
          isActive: true,
        }, now);
        await collection.insertOne(record, { session });
        audits.push(audit(
          shopId,
          actorId,
          kind === 'category' ? 'category.created' : 'brand.created',
          kind === 'category' ? 'category' : 'brand',
          record._id,
          { name, source: 'starter_catalog' },
          now,
        ));
        if (kind === 'category') result.createdCategoryCount += 1;
        else result.createdManufacturerCount += 1;
        return record;
      };

      const medicines = database.collection<CatalogRecord>('medicines');
      const units = database.collection<CatalogRecord>('medicineUnits');
      for (const entry of entries) {
        const normalizedCode = normalizeName(entry.code);
        const existing = await medicines.findOne({ shopId, normalizedCode }, { session });
        if (existing) {
          result.skippedCount += 1;
          continue;
        }

        const category = await getOrCreateName('category', entry.category);
        const manufacturer = await getOrCreateName('manufacturer', entry.manufacturer);
        const medicine = catalogRecord(shopId, actorId, {
          code: entry.code,
          normalizedCode,
          name: entry.name,
          normalizedName: normalizeName(entry.name),
          genericName: entry.genericName,
          strength: entry.strength,
          categoryId: category._id,
          categoryName: category.name,
          brandId: manufacturer._id,
          brandName: manufacturer.name,
          drugClass: entry.drugClass,
          storageCondition: entry.storageCondition,
          rackLocation: entry.rackLocation,
          minStockAlert: entry.minStockAlert,
          requiresPrescription: entry.requiresPrescription,
          isActive: false,
          defaultUnitName: entry.unitName,
          defaultUnitConversionFactor: entry.conversionFactorBaseUnits,
          defaultUnitPricePaisa: Long.ZERO,
          activeBeforeDelete: null,
        }, now);
        const medicineId = medicine._id;
        const unit = catalogRecord(shopId, actorId, {
          medicineId,
          name: entry.unitName,
          normalizedName: normalizeName(entry.unitName),
          conversionFactorBaseUnits: entry.conversionFactorBaseUnits,
          pricePaisa: Long.ZERO,
          isDefaultSaleUnit: true,
        }, now);
        await medicines.insertOne(medicine, { session });
        await units.insertOne(unit, { session });
        audits.push(audit(
          shopId,
          actorId,
          'medicine.starter_catalog_imported',
          'medicine',
          medicineId,
          { code: entry.code, name: entry.name, isActive: false },
          now,
        ));
        audits.push(audit(
          shopId,
          actorId,
          'medicine_unit.created',
          'medicine_unit',
          unit._id,
          { medicineId: medicineId.toHexString(), name: entry.unitName, isDefaultSaleUnit: true },
          now,
        ));
        result.importedCount += 1;
      }
      if (audits.length) {
        await database.collection<AuditRecord>('auditLogs').insertMany(audits, { session });
      }
      return result;
    });
  } finally {
    await session.endSession();
  }
}
