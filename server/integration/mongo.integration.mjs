import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Long, MongoClient, ObjectId } from 'mongodb';
import { createAccessToken } from '../dist/auth-crypto.js';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { MongoStockRepository } from '../dist/stock-repository.js';
import { MongoSalesRepository } from '../dist/sales-repository.js';

let client;
let database;
let config;
const enabled = Boolean(
  process.env.MONGO_HOST
  && process.env.MONGO_APP_DB
  && process.env.MONGO_APP_USERNAME
  && process.env.MONGO_APP_PASSWORD
  && process.env.JWT_ACCESS_SECRET
  && process.env.REFRESH_TOKEN_PEPPER,
);

before(async () => {
  if (!enabled) return;
  config = loadConfig();
  client = new MongoClient(config.mongoUri, {
    appName: 'pharma-care-mongo-integration-test',
    promoteLongs: false,
  });
  await client.connect();
  database = client.db(config.mongoDbName);
  const hello = await database.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0', 'integration tests require the real rs0 replica set');
  assert.equal(hello.isWritablePrimary, true);
});

after(async () => {
  if (client) await client.close();
});

async function cleanShop(shopId) {
  for (const name of [
    'users',
    'refreshSessions',
    'idempotencyRecords',
    'categories',
    'brands',
    'medicines',
    'medicineUnits',
    'suppliers',
    'barcodeClaims',
    'stockBatches',
    'stockMovements',
    'purchases',
    'supplierLedger',
    'cashBookEntries',
    'sales',
    'salePayments',
    'customerLedger',
    'auditLogs',
    'trashEvents',
  ]) {
    await database.collection(name).deleteMany({ shopId });
  }
  await database.collection('counters').deleteMany({ shopId });
  await database.collection('shops').deleteOne({ _id: shopId });
}

async function withFixture(run) {
  const suffix = randomUUID();
  const shopId = new ObjectId();
  const shop = {
    _id: shopId,
    slug: `it-${suffix}`,
    name: `Integration ${suffix}`,
    status: 'ACTIVE',
  };
  const supplierId = new ObjectId();
  const medicineId = new ObjectId();
  const unitId = new ObjectId();
  const userId = new ObjectId();
  const now = new Date();
  await database.collection('shops').insertOne(shop);
  await database.collection('suppliers').insertOne({
    _id: supplierId,
    shopId,
    name: `Supplier ${suffix}`,
    normalizedName: `supplier ${suffix}`,
    contact: '',
    address: '',
    licenceOrTaxNumber: '',
    paymentTerms: 'Due on receipt',
    isActive: true,
    payableBalancePaisa: Long.ZERO,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await database.collection('medicines').insertOne({
    _id: medicineId,
    shopId,
    code: suffix,
    normalizedCode: suffix,
    name: `Medicine ${suffix}`,
    normalizedName: `medicine ${suffix}`,
    genericName: 'Integration ingredient',
    isActive: true,
    deletedAt: null,
    minStockAlert: 0,
    createdAt: now,
    updatedAt: now,
  });
  await database.collection('medicineUnits').insertOne({
    _id: unitId,
    shopId,
    medicineId,
    name: 'Pack',
    normalizedName: 'pack',
    conversionFactorBaseUnits: 1,
    pricePaisa: Long.fromInt(150),
    isDefaultSaleUnit: true,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const actor = {
    _id: userId,
    shopId,
    username: 'integration-manager',
    usernameNormalized: 'integration-manager',
    email: `${suffix}@example.test`,
    emailNormalized: `${suffix}@example.test`,
    fullName: 'Integration Manager',
    role: 'manager',
    isActive: true,
    permissions: ['purchases', 'purchase_history', 'stock_inventory', 'pos', 'customers', 'sales_history'],
    passwordHash: '$argon2id$integration-only',
    failedLogins: 0,
    lockedUntil: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await database.collection('users').insertOne(actor);
  const input = {
    supplierId: supplierId.toHexString(),
    invoiceNumber: '',
    purchaseDate: now.toISOString().slice(0, 10),
    paymentType: 'credit',
    discountPaisa: '0',
    notes: '',
    items: [{
      medicineId: medicineId.toHexString(),
      unitId: unitId.toHexString(),
      batchNumber: `B-${suffix}`,
      expiryDate: new Date(now.getTime() + 180 * 86_400_000).toISOString().slice(0, 10),
      quantity: 10,
      bonusQuantity: 0,
      unitCostPaisa: '100',
      mrpPaisa: '150',
    }],
  };
  try {
    await run({ shopId, supplierId, medicineId, unitId, actor, input, suffix });
  } finally {
    await cleanShop(shopId);
  }
}

function audit(actor, event, entityType, entityId) {
  return {
    shopId: actor.shopId,
    actorId: actor._id,
    ...(entityId ? { entityId } : {}),
    event,
    entityType,
    occurredAt: new Date(),
  };
}

class InjectedFailureStockRepository extends MongoStockRepository {
  failAt = '';

  async transactionCheckpoint(stage) {
    if (stage === this.failAt) throw new Error(`INTEGRATION_INJECTED_FAILURE:${stage}`);
  }
}

class InjectedFailureSalesRepository extends MongoSalesRepository {
  failAt = '';

  async transactionCheckpoint(stage) {
    if (stage === this.failAt) throw new Error(`INTEGRATION_INJECTED_FAILURE:${stage}`);
  }
}

function accessToken(actor, config) {
  return createAccessToken({
    id: actor._id.toHexString(),
    shopId: actor.shopId.toHexString(),
    role: actor.role,
  }, {
    accessSecret: config.accessTokenSecret,
    refreshPepper: config.refreshTokenPepper,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
  }).token;
}

function saleInput(medicineId, unitId) {
  return {
    items: [{ medicineId: medicineId.toHexString(), unitId: unitId.toHexString(), quantityInUnit: 1 }],
    discountPaisa: '0',
    payments: [{ method: 'CASH', amountPaisa: '150' }],
    amountTenderedPaisa: '150',
  };
}

test('Mongo sale transaction rolls back stock and records after an injected mid-transaction failure', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, medicineId, unitId }) => {
    const stockRepository = new MongoStockRepository(client, config.mongoDbName);
    await stockRepository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'));
    const batch = await database.collection('stockBatches').findOne({ shopId, medicineId });
    assert.ok(batch);

    const repository = new InjectedFailureSalesRepository(client, config.mongoDbName);
    repository.failAt = 'sale.after_stock';
    await assert.rejects(
      repository.postSale(saleInput(medicineId, unitId), actor, audit(actor, 'sale.completed', 'sale'), new Date()),
      /INTEGRATION_INJECTED_FAILURE/,
    );
    const batchAfter = await database.collection('stockBatches').findOne({ _id: batch._id, shopId });
    assert.equal(batchAfter.quantityRemainingBaseUnits.toString(), '10');
    assert.equal(await database.collection('sales').countDocuments({ shopId }), 0);
    assert.equal(await database.collection('salePayments').countDocuments({ shopId }), 0);
    assert.equal(await database.collection('stockMovements').countDocuments({ shopId, movementType: 'SALE' }), 0);
    assert.equal(await database.collection('auditLogs').countDocuments({ shopId, event: 'sale.completed' }), 0);
  });
});

test('Mongo credit sales and customer payments keep distinct unique ledger references', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, medicineId, unitId }) => {
    const stockRepository = new MongoStockRepository(client, config.mongoDbName);
    await stockRepository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'));
    const repository = new MongoSalesRepository(client, config.mongoDbName);
    const customer = await repository.createCustomer(shopId, actor._id, {
      name: 'Ledger Integration Customer',
      phone: '',
      cnic: null,
      address: '',
      creditLimitPaisa: '0',
    }, audit(actor, 'customer.created', 'customer'));
    const creditSale = {
      ...saleInput(medicineId, unitId),
      customerId: customer._id.toHexString(),
      payments: [{ method: 'CREDIT', amountPaisa: '150' }],
      amountTenderedPaisa: '0',
    };
    await repository.postSale(creditSale, actor, audit(actor, 'sale.posted', 'sale'), new Date());
    await repository.postSale(creditSale, actor, audit(actor, 'sale.posted', 'sale'), new Date());
    await repository.recordCustomerPayment(shopId, customer._id, actor, {
      amountPaisa: '100',
      method: 'CASH',
      note: 'First integration payment',
    }, audit(actor, 'customer.payment_recorded', 'customer'));
    await repository.recordCustomerPayment(shopId, customer._id, actor, {
      amountPaisa: '50',
      method: 'CARD',
      note: 'Second integration payment',
    }, audit(actor, 'customer.payment_recorded', 'customer'));

    const balance = await database.collection('customers').findOne({ _id: customer._id, shopId });
    assert.equal(balance.currentBalancePaisa.toString(), '150');
    assert.equal(await database.collection('customerLedger').countDocuments({
      shopId,
      customerId: customer._id,
      entryType: 'INVOICE',
    }), 2);
    assert.equal(await database.collection('customerLedger').countDocuments({
      shopId,
      customerId: customer._id,
      entryType: 'PAYMENT',
    }), 2);
  });
});

test('parallel Mongo sales for the last unit allow exactly one complete sale', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, medicineId, unitId }) => {
    const stockRepository = new MongoStockRepository(client, config.mongoDbName);
    await stockRepository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'));
    const batch = await database.collection('stockBatches').findOne({ shopId, medicineId });
    assert.ok(batch);
    await database.collection('stockBatches').updateOne(
      { _id: batch._id, shopId },
      { $set: { quantityRemainingBaseUnits: Long.fromInt(1) } },
    );

    const app = createApp(client, config);
    const authorization = `Bearer ${accessToken(actor, config)}`;
    try {
      await app.ready();
      const sendSale = () => app.inject({
        method: 'POST',
        url: '/api/sales',
        headers: { authorization, 'idempotency-key': randomUUID() },
        payload: saleInput(medicineId, unitId),
      });
      const results = await Promise.all([sendSale(), sendSale()]);
      assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409]);
      const remaining = await database.collection('stockBatches').findOne({ _id: batch._id, shopId });
      assert.equal(remaining.quantityRemainingBaseUnits.toString(), '0');
      assert.equal(await database.collection('sales').countDocuments({ shopId }), 1);
      assert.equal(await database.collection('salePayments').countDocuments({ shopId }), 1);
      assert.equal(await database.collection('stockMovements').countDocuments({ shopId, movementType: 'SALE' }), 1);
    } finally {
      await app.close();
    }
  });
});

test('Mongo transactions roll back purchase post and void after mid-transaction failures', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, supplierId }) => {
    const repository = new InjectedFailureStockRepository(client, config.mongoDbName);
    repository.failAt = 'purchase.after_movements';
    await assert.rejects(
      repository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase')),
      /INTEGRATION_INJECTED_FAILURE/,
    );
    assert.equal(await database.collection('purchases').countDocuments({ shopId }), 0);
    assert.equal(await database.collection('stockBatches').countDocuments({ shopId }), 0);
    assert.equal(await database.collection('stockMovements').countDocuments({ shopId }), 0);
    assert.equal(await database.collection('supplierLedger').countDocuments({ shopId }), 0);
    assert.equal(await database.collection('auditLogs').countDocuments({ shopId }), 0);
    const supplierAfterFailedPost = await database.collection('suppliers').findOne({ _id: supplierId, shopId });
    assert.equal(supplierAfterFailedPost.payableBalancePaisa.toString(), '0');

    repository.failAt = '';
    const purchase = await repository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'));
    const stockBeforeVoid = await database.collection('stockBatches').findOne({
      shopId,
      purchaseId: purchase._id,
    });
    assert.ok(stockBeforeVoid);
    repository.failAt = 'purchase_void.after_supplier_ledger';
    await assert.rejects(
      repository.voidPurchase(
        shopId,
        purchase._id,
        actor,
        'integration rollback test',
        audit(actor, 'purchase.voided', 'purchase', purchase._id),
      ),
      /INTEGRATION_INJECTED_FAILURE/,
    );
    const purchaseAfterFailedVoid = await database.collection('purchases').findOne({ _id: purchase._id, shopId });
    const stockAfterFailedVoid = await database.collection('stockBatches').findOne({ _id: stockBeforeVoid._id, shopId });
    assert.equal(purchaseAfterFailedVoid.status, 'posted');
    assert.equal(stockAfterFailedVoid.quantityRemainingBaseUnits.toString(), '10');
    assert.equal(await database.collection('stockMovements').countDocuments({ shopId }), 1);
    assert.equal(await database.collection('supplierLedger').countDocuments({ shopId }), 1);
    assert.equal(await database.collection('auditLogs').countDocuments({ shopId }), 1);
  });
});

test('Mongo unique indexes enforce per-shop medicine codes and barcode claims', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId }) => {
    const medicineIndexes = await database.collection('medicines').listIndexes().toArray();
    const barcodeIndexes = await database.collection('barcodeClaims').listIndexes().toArray();
    const idempotencyIndexes = await database.collection('idempotencyRecords').listIndexes().toArray();
    assert.ok(medicineIndexes.some((index) => index.name === 'shop_medicine_code_unique'));
    assert.ok(barcodeIndexes.some((index) => index.name === 'shop_barcode_unique'));
    assert.ok(!idempotencyIndexes.some((index) => index.name === 'shop_idempotency_unique'));

    const first = {
      shopId,
      code: 'DUPLICATE-CODE',
      normalizedCode: 'duplicate-code',
      name: 'Unique Test Medicine',
      normalizedName: 'unique test medicine',
      isActive: true,
    };
    await database.collection('medicines').insertOne(first);
    await assert.rejects(
      database.collection('medicines').insertOne({
        ...first,
        _id: new ObjectId(),
        name: 'Another Medicine',
        normalizedName: 'another medicine',
      }),
      (error) => error.code === 11000,
    );

    await database.collection('barcodeClaims').insertOne({
      shopId,
      normalizedBarcode: '0123456789012',
      barcode: '0123456789012',
      ownerType: 'MEDICINE',
      ownerId: new ObjectId(),
      unitId: null,
      createdAt: new Date(),
      createdBy: new ObjectId(),
    });
    await assert.rejects(
      database.collection('barcodeClaims').insertOne({
        shopId,
        normalizedBarcode: '0123456789012',
        barcode: '0123456789012',
        ownerType: 'UNIT',
        ownerId: new ObjectId(),
        unitId: new ObjectId(),
        createdAt: new Date(),
        createdBy: new ObjectId(),
      }),
      (error) => error.code === 11000,
    );

    const otherShopId = new ObjectId();
    await database.collection('shops').insertOne({
      _id: otherShopId,
      slug: `it-other-${randomUUID()}`,
      name: 'Other integration shop',
      status: 'ACTIVE',
    });
    try {
      await database.collection('medicines').insertOne({ ...first, _id: new ObjectId(), shopId: otherShopId });
      await database.collection('barcodeClaims').insertOne({
        shopId: otherShopId,
        normalizedBarcode: '0123456789012',
        barcode: '0123456789012',
        ownerType: 'MEDICINE',
        ownerId: new ObjectId(),
        unitId: null,
        createdAt: new Date(),
        createdBy: new ObjectId(),
      });
    } finally {
      await cleanShop(otherShopId);
    }
  });
});

test('parallel Mongo stock adjustments allow exactly one request to consume the remaining stock', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, suffix }) => {
    const repository = new MongoStockRepository(client, config.mongoDbName);
    const purchase = await repository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'));
    const batchId = purchase.items[0].batchId;
    const shop = await database.collection('shops').findOne({ _id: shopId });
    assert.ok(shop);
    const app = createApp(client, config);
    try {
      const token = createAccessToken({
        id: actor._id.toHexString(),
        shopId: shopId.toHexString(),
        role: actor.role,
      }, {
        accessSecret: config.accessTokenSecret,
        refreshPepper: config.refreshTokenPepper,
        accessTokenTtlSeconds: config.accessTokenTtlSeconds,
        refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
      }).token;
      await app.ready();
      const headers = () => ({
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),
      });
      const results = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/stock/batches/${batchId.toHexString()}/adjust`,
          headers: headers(),
          payload: { deltaBaseUnits: '-8', reason: `Concurrent ${suffix}` },
        }),
        app.inject({
          method: 'POST',
          url: `/api/stock/batches/${batchId.toHexString()}/adjust`,
          headers: headers(),
          payload: { deltaBaseUnits: '-8', reason: `Concurrent ${suffix}` },
        }),
      ]);
      assert.equal(results.filter((result) => result.statusCode === 200).length, 1);
      assert.equal(results.filter((result) => result.statusCode === 409).length, 1);
      const batch = await database.collection('stockBatches').findOne({ _id: batchId, shopId });
      assert.equal(batch.quantityRemainingBaseUnits.toString(), '2');
      assert.equal(await database.collection('stockMovements').countDocuments({
        shopId,
        movementType: 'ADJUSTMENT',
      }), 1);
    } finally {
      await app.close();
    }
  });
});

test('Mongo idempotency replays the saved successful response without a second stock write', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input }) => {
    const repository = new MongoStockRepository(client, config.mongoDbName);
    const purchase = await repository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'));
    const batchId = purchase.items[0].batchId;
    const app = createApp(client, config);
    const key = randomUUID();
    try {
      const token = createAccessToken({
        id: actor._id.toHexString(),
        shopId: shopId.toHexString(),
        role: actor.role,
      }, {
        accessSecret: config.accessTokenSecret,
        refreshPepper: config.refreshTokenPepper,
        accessTokenTtlSeconds: config.accessTokenTtlSeconds,
        refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
      }).token;
      await app.ready();
      const request = () => app.inject({
        method: 'POST',
        url: `/api/stock/batches/${batchId.toHexString()}/adjust`,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
        payload: { deltaBaseUnits: '-1', reason: 'Idempotent integration adjustment' },
      });
      const first = await request();
      const replay = await request();
      assert.equal(first.statusCode, 200);
      assert.equal(replay.statusCode, 200);
      assert.deepEqual(replay.json(), first.json());
      const batch = await database.collection('stockBatches').findOne({ _id: batchId, shopId });
      assert.equal(batch.quantityRemainingBaseUnits.toString(), '9');
      assert.equal(await database.collection('stockMovements').countDocuments({
        shopId,
        movementType: 'ADJUSTMENT',
      }), 1);
      assert.equal(await database.collection('idempotencyRecords').countDocuments({
        shopId,
        route: 'POST /api/stock/batches/:id/adjust',
        state: 'COMPLETED',
      }), 1);
    } finally {
      await app.close();
    }
  });
});
