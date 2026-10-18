import { Long, ObjectId, type Db, type Document, type MongoClient } from 'mongodb';
import { normalizeName } from './catalog-domain.js';

export const DEMO_CATEGORIES = ['DEMO - General', 'DEMO - Prescription'] as const;
export const DEMO_BRANDS = ['DEMO - Sample Labs', 'DEMO - Fictional Pharma'] as const;

export const DEMO_MEDICINES = [
  {
    code: 'DEMO-OTC-001',
    name: 'DEMO - Paracetamol Tablets',
    genericName: 'Paracetamol',
    strength: '500 mg',
    categoryName: DEMO_CATEGORIES[0],
    brandName: DEMO_BRANDS[0],
    drugClass: 'OTC',
    requiresPrescription: false,
    unitName: 'Tablet',
    conversionFactorBaseUnits: 1,
    pricePaisa: '500',
  },
  {
    code: 'DEMO-OTC-002',
    name: 'DEMO - Oral Rehydration Sachets',
    genericName: 'Oral rehydration salts',
    strength: 'Standard',
    categoryName: DEMO_CATEGORIES[0],
    brandName: DEMO_BRANDS[1],
    drugClass: 'OTC',
    requiresPrescription: false,
    unitName: 'Sachet',
    conversionFactorBaseUnits: 1,
    pricePaisa: '2500',
  },
  {
    code: 'DEMO-RX-001',
    name: 'DEMO - Amoxicillin Capsules',
    genericName: 'Amoxicillin',
    strength: '500 mg',
    categoryName: DEMO_CATEGORIES[1],
    brandName: DEMO_BRANDS[0],
    drugClass: 'RX',
    requiresPrescription: true,
    unitName: 'Capsule',
    conversionFactorBaseUnits: 1,
    pricePaisa: '1800',
  },
  {
    code: 'DEMO-RX-002',
    name: 'DEMO - Cetirizine Tablets',
    genericName: 'Cetirizine',
    strength: '10 mg',
    categoryName: DEMO_CATEGORIES[1],
    brandName: DEMO_BRANDS[1],
    drugClass: 'RX',
    requiresPrescription: true,
    unitName: 'Tablet',
    conversionFactorBaseUnits: 1,
    pricePaisa: '1200',
  },
  {
    code: 'DEMO-CTRL-001',
    name: 'DEMO - Controlled Medicine Example',
    genericName: 'Fictional controlled ingredient',
    strength: '10 mg',
    categoryName: DEMO_CATEGORIES[1],
    brandName: DEMO_BRANDS[1],
    drugClass: 'CONTROLLED',
    requiresPrescription: true,
    unitName: 'Tablet',
    conversionFactorBaseUnits: 1,
    pricePaisa: '3000',
  },
] as const;

export const DEMO_SUPPLIERS = [
  { name: 'DEMO - Example Wholesale A', paymentTerms: 'Due on receipt' },
  { name: 'DEMO - Example Wholesale B', paymentTerms: 'Net 30' },
] as const;

export const DEMO_CUSTOMERS = [
  'DEMO - Ayesha Sample',
  'DEMO - Bilal Example',
  'DEMO - Customer Three',
] as const;

export function assertDemoSeedAllowed(env: NodeJS.ProcessEnv): string {
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error('DEMO_SEED_NONDEVELOPMENT_FORBIDDEN');
  }
  if (env.DEMO_MODE !== 'true') throw new Error('DEMO_SEED_MODE_REQUIRED');
  const databaseName = env.MONGO_APP_DB ?? '';
  if (!/(?:^|[_-])demo$/i.test(databaseName)) throw new Error('DEMO_DATABASE_REQUIRED');
  return databaseName;
}

function namedRecord(
  shopId: ObjectId,
  actorId: ObjectId,
  name: string,
  now: Date,
): Document {
  return {
    _id: new ObjectId(),
    shopId,
    name,
    normalizedName: normalizeName(name),
    isActive: true,
    activeBeforeDelete: null,
    createdBy: actorId,
    updatedBy: actorId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export async function seedDemoData(
  client: MongoClient,
  database: Db,
  shopId: ObjectId,
  actorId: ObjectId,
): Promise<{ seeded: boolean; counts: Record<string, number> }> {
  const now = new Date();
  const markerId = `${shopId.toHexString()}:demo-v1`;
  const categories = DEMO_CATEGORIES.map((name) => namedRecord(shopId, actorId, name, now));
  const brands = DEMO_BRANDS.map((name) => namedRecord(shopId, actorId, name, now));
  const suppliers = DEMO_SUPPLIERS.map((supplier) => ({
    ...namedRecord(shopId, actorId, supplier.name, now),
    contact: 'DEMO ONLY',
    address: 'Fictional test record - not a real supplier',
    licenceOrTaxNumber: '',
    paymentTerms: supplier.paymentTerms,
    payableBalancePaisa: Long.ZERO,
  }));
  const customers = DEMO_CUSTOMERS.map((name) => ({
    _id: new ObjectId(),
    shopId,
    name,
    normalizedName: normalizeName(name),
    phone: 'DEMO ONLY',
    cnic: null,
    address: 'Fictional test record - not a real customer',
    creditLimitPaisa: Long.fromString('1000000'),
    currentBalancePaisa: Long.ZERO,
    storeCreditPaisa: Long.ZERO,
    createdBy: actorId,
    updatedBy: actorId,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
  const categoryByName = new Map(categories.map((record) => [record.name as string, record._id as ObjectId]));
  const brandByName = new Map(brands.map((record) => [record.name as string, record._id as ObjectId]));
  const medicines = DEMO_MEDICINES.map((medicine) => {
    const medicineId = new ObjectId();
    const categoryId = categoryByName.get(medicine.categoryName)!;
    const brandId = brandByName.get(medicine.brandName)!;
    const unit = {
      _id: new ObjectId(),
      shopId,
      medicineId,
      name: medicine.unitName,
      normalizedName: normalizeName(medicine.unitName),
      conversionFactorBaseUnits: medicine.conversionFactorBaseUnits,
      pricePaisa: Long.fromString(medicine.pricePaisa),
      isDefaultSaleUnit: true,
      createdBy: actorId,
      updatedBy: actorId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    return {
      medicineId,
      unit,
      record: {
        _id: medicineId,
        shopId,
        code: medicine.code,
        normalizedCode: normalizeName(medicine.code),
        name: medicine.name,
        normalizedName: normalizeName(medicine.name),
        genericName: medicine.genericName,
        strength: medicine.strength,
        categoryId,
        brandId,
        categoryName: medicine.categoryName,
        brandName: medicine.brandName,
        drugClass: medicine.drugClass,
        storageCondition: 'ROOM_TEMPERATURE',
        rackLocation: 'DEMO',
        minStockAlert: 5,
        requiresPrescription: medicine.requiresPrescription,
        isActive: true,
        defaultUnitName: medicine.unitName,
        defaultUnitConversionFactor: medicine.conversionFactorBaseUnits,
        defaultUnitPricePaisa: Long.fromString(medicine.pricePaisa),
        activeBeforeDelete: null,
        createdBy: actorId,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    };
  });

  const session = client.startSession();
  try {
    const seeded = await session.withTransaction(async () => {
      const shop = await database.collection('shops').findOne({
        _id: shopId,
        status: 'ACTIVE',
      }, { session, projection: { _id: 1 } });
      if (!shop) throw new Error('DEMO_SEED_SHOP_NOT_FOUND');
      const actor = await database.collection('users').findOne({
        _id: actorId,
        shopId,
        role: 'super_admin',
        isActive: true,
        deletedAt: null,
      }, { session, projection: { _id: 1 } });
      if (!actor) throw new Error('DEMO_SEED_SUPER_ADMIN_REQUIRED');
      const demoSeedRuns = database.collection<Document & { _id: string }>('demoSeedRuns');
      if (await demoSeedRuns.findOne({ _id: markerId, shopId }, { session })) {
        return false;
      }
      const namedKeys = [
        ['categories', categories.map((record) => normalizeName(String(record.name)))],
        ['brands', brands.map((record) => normalizeName(String(record.name)))],
        ['suppliers', DEMO_SUPPLIERS.map(({ name }) => normalizeName(name))],
        ['customers', customers.map((record) => normalizeName(String(record.name)))],
        ['medicines', medicines.map(({ record }) => normalizeName(String(record.name)))],
      ] satisfies Array<[string, string[]]>;
      for (const [collectionName, normalizedNames] of namedKeys) {
        if (await database.collection(collectionName).findOne({
          shopId,
          normalizedName: { $in: normalizedNames },
        }, { session })) {
          throw new Error('DEMO_SEED_DATA_CONFLICT');
        }
      }
      if (await database.collection('medicines').findOne({
        shopId,
        normalizedCode: { $in: medicines.map(({ record }) => record.normalizedCode) },
      }, { session })) {
        throw new Error('DEMO_SEED_DATA_CONFLICT');
      }

      await database.collection('categories').insertMany(categories, { session });
      await database.collection('brands').insertMany(brands, { session });
      await database.collection('suppliers').insertMany(suppliers, { session });
      await database.collection('customers').insertMany(customers, { session });
      await database.collection('medicines').insertMany(medicines.map(({ record }) => record), { session });
      await database.collection('medicineUnits').insertMany(medicines.map(({ unit }) => unit), { session });
      await demoSeedRuns.insertOne({
        _id: markerId,
        shopId,
        version: 1,
        actorId,
        seededAt: now,
        counts: {
          categories: categories.length,
          brands: brands.length,
          suppliers: suppliers.length,
          customers: customers.length,
          medicines: medicines.length,
        },
      }, { session });
      await database.collection('auditLogs').insertOne({
        shopId,
        actorId,
        event: 'demo.seeded',
        entityType: 'demo_seed',
        occurredAt: now,
        after: { version: 1, syntheticOnly: true },
      }, { session });
      return true;
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return {
      seeded: seeded === true,
      counts: {
        categories: categories.length,
        brands: brands.length,
        suppliers: suppliers.length,
        customers: customers.length,
        medicines: medicines.length,
      },
    };
  } finally {
    await session.endSession();
  }
}
