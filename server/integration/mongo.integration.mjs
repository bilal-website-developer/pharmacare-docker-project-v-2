import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Long, MongoClient, ObjectId } from 'mongodb';
import { createAccessToken } from '../dist/auth-crypto.js';
import { createApp } from '../dist/app.js';
import { timezoneToday } from '../dist/business-time.js';
import { loadConfig } from '../dist/config.js';
import { MongoCatalogRepository } from '../dist/catalog-repository.js';
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
    'saleReturns',
    'returnPolicySettings',
    'expenses',
    'printRequests',
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
    permissions: [
      'purchases', 'purchase_history', 'stock_inventory', 'pos', 'customers',
      'sales_history', 'expenses', 'reports', 'pos_print_sale', 'pos_print_payment',
    ],
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

function shopToday() {
  return timezoneToday('Asia/Karachi');
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
    customerName: '',
    items: [{ medicineId: medicineId.toHexString(), unitId: unitId.toHexString(), quantityInUnit: 1 }],
    discountPaisa: '0',
    payments: [{ method: 'CASH', amountPaisa: '150' }],
    amountTenderedPaisa: '150',
  };
}

test('Mongo sale transaction rolls back stock and records after an injected mid-transaction failure', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, medicineId, unitId }) => {
    const stockRepository = new MongoStockRepository(client, config.mongoDbName);
    await stockRepository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday());
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

test('Mongo sale calculates memo rounding from persisted shop settings', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, medicineId, unitId }) => {
    const stockRepository = new MongoStockRepository(client, config.mongoDbName);
    await stockRepository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday());
    await database.collection('medicineUnits').updateOne(
      { _id: unitId, shopId },
      { $set: { pricePaisa: Long.fromNumber(1234) } },
    );
    await database.collection('shops').updateOne(
      { _id: shopId },
      { $set: { memoSettings: { roundNet: '5' }, receiptSettings: { template: 'pharmacy-memo' } } },
    );
    const app = createApp(client, config);
    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/api/sales',
        headers: {
          authorization: `Bearer ${accessToken(actor, config)}`,
          'idempotency-key': randomUUID(),
        },
        payload: {
          ...saleInput(medicineId, unitId),
          payments: [{ method: 'CASH', amountPaisa: '1000' }],
          amountTenderedPaisa: '1000',
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json().subtotalPaisa, '1234');
      assert.equal(response.json().roundingPaisa, '-234');
      assert.equal(response.json().totalPaisa, '1000');
      const saved = await database.collection('sales').findOne({ shopId });
      assert.equal(saved.roundingPaisa.toString(), '-234');
      assert.equal(saved.totalPaisa.toString(), '1000');
      assert.doesNotMatch(response.body, /(cost|profit|margin)/i);
    } finally {
      await app.close();
    }
  });
});

test('Mongo credit sales and customer payments keep distinct unique ledger references', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, medicineId, unitId }) => {
    const stockRepository = new MongoStockRepository(client, config.mongoDbName);
    await stockRepository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday());
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
    await stockRepository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday());
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
      repository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday()),
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
    const purchase = await repository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday());
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

test('Mongo product cost lookup applies the shop-local expiry date', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, medicineId }) => {
    await database.collection('stockBatches').insertOne({
      _id: new ObjectId(),
      shopId,
      medicineId,
      quantityRemainingBaseUnits: Long.ONE,
      expiryDate: new Date('2026-10-14T00:00:00.000Z'),
      receivedDate: new Date('2026-01-01T00:00:00.000Z'),
      unitCostPaisaPerBaseUnit: Long.fromInt(1234),
    });
    const repository = new MongoCatalogRepository(client, config.mongoDbName);
    const beforeMidnight = await repository.latestCosts(
      shopId,
      [medicineId],
      timezoneToday('Asia/Karachi', new Date('2026-10-14T18:59:59.999Z')),
    );
    const afterMidnight = await repository.latestCosts(
      shopId,
      [medicineId],
      timezoneToday('Asia/Karachi', new Date('2026-10-14T19:00:00.000Z')),
    );
    assert.equal(beforeMidnight.get(medicineId.toHexString()), '1234');
    assert.equal(afterMidnight.has(medicineId.toHexString()), false);
  });
});

test('parallel Mongo stock adjustments allow exactly one request to consume the remaining stock', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, suffix }) => {
    const repository = new MongoStockRepository(client, config.mongoDbName);
    const purchase = await repository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday());
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
    const purchase = await repository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday());
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

test('Mongo returns enforce sold quantities, prevent double processing, and reconcile net sales and cash', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, medicineId, unitId }) => {
    const stockRepository = new MongoStockRepository(client, config.mongoDbName);
    await stockRepository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday());
    const salesRepository = new MongoSalesRepository(client, config.mongoDbName);
    const sale = await salesRepository.postSale(
      saleInput(medicineId, unitId), actor, audit(actor, 'sale.posted', 'sale'), shopToday(),
    );
    const cashier = {
      ...actor,
      _id: new ObjectId(),
      username: `cashier-${randomUUID()}`,
      usernameNormalized: `cashier-${randomUUID()}`,
      email: `cashier-${randomUUID()}@example.test`,
      emailNormalized: `cashier-${randomUUID()}@example.test`,
      role: 'cashier',
      permissions: ['pos', 'customers'],
    };
    await database.collection('users').insertOne(cashier);
    const saleItem = sale.items[0];
    const allocation = saleItem.batchAllocations[0];
    assert.ok(allocation);
    const app = createApp(client, config);
    const headers = () => ({
      authorization: `Bearer ${accessToken(actor, config)}`,
      'idempotency-key': randomUUID(),
    });
    try {
      await app.ready();
      const cashierHeaders = {
        authorization: `Bearer ${accessToken(cashier, config)}`,
      };
      const cashierCatalog = await app.inject({
        method: 'GET', url: '/api/pos/catalog', headers: cashierHeaders,
      });
      assert.equal(cashierCatalog.statusCode, 200, cashierCatalog.body);
      const catalogBody = cashierCatalog.json();
      assert.doesNotMatch(JSON.stringify(catalogBody), /(cost|profit|margin)/i);
      assert.deepEqual(Object.keys(catalogBody).sort(), ['items', 'today']);
      assert.equal(catalogBody.today, shopToday().toISOString().slice(0, 10));
      assert.equal(catalogBody.items.length, 1);
      const catalogProduct = catalogBody.items[0];
      assert.deepEqual(Object.keys(catalogProduct).sort(), [
        'barcode', 'batches', 'category', 'code', 'company', 'drugClass', 'genericName',
        'id', 'name', 'requiresPrescription', 'stockBaseUnits', 'strength', 'units',
      ].sort());
      assert.equal(catalogProduct.units[0].pricePaisa, '150');
      assert.equal(catalogProduct.batches.length, 1);
      assert.deepEqual(Object.keys(catalogProduct.batches[0]).sort(), [
        'batchNumber', 'expiryDate', 'id', 'quantityBaseUnits', 'receivedDate', 'status',
      ].sort());
      assert.equal(typeof catalogProduct.batches[0].quantityBaseUnits, 'string');
      assert.ok(BigInt(catalogProduct.batches[0].quantityBaseUnits) > 0n);
      const cashierReturnQueue = await app.inject({
        method: 'GET', url: '/api/returns/pending', headers: cashierHeaders,
      });
      assert.equal(cashierReturnQueue.statusCode, 403);
      const cashierExpenses = await app.inject({
        method: 'GET', url: '/api/expenses', headers: cashierHeaders,
      });
      assert.equal(cashierExpenses.statusCode, 403);
      const overReturn = await app.inject({
        method: 'POST',
        url: `/api/sales/${sale._id.toHexString()}/returns`,
        headers: headers(),
        payload: {
          reason: 'Over-return attempt',
          items: [{
            saleItemId: saleItem._id.toHexString(),
            allocationId: `${saleItem._id.toHexString()}:${allocation.batchId.toHexString()}`,
            quantityBaseUnits: 2,
          }],
        },
      });
      assert.equal(overReturn.statusCode, 409);

      const requestReturn = () => app.inject({
        method: 'POST',
        url: `/api/sales/${sale._id.toHexString()}/returns`,
        headers: headers(),
        payload: {
          reason: 'Integration return',
          items: [{
            saleItemId: saleItem._id.toHexString(),
            allocationId: `${saleItem._id.toHexString()}:${allocation.batchId.toHexString()}`,
            quantityBaseUnits: 1,
          }],
        },
      });
      const concurrentRequests = await Promise.all([requestReturn(), requestReturn()]);
      assert.deepEqual(concurrentRequests.map((result) => result.statusCode).sort(), [201, 409]);
      const created = concurrentRequests.find((result) => result.statusCode === 201);
      assert.ok(created);
      assert.equal(created.statusCode, 201, created.body);
      const returnRecord = created.json();
      const approved = await app.inject({
        method: 'POST',
        url: `/api/returns/${returnRecord.id}/approve`,
        headers: headers(),
        payload: { note: 'Approved for processing' },
      });
      assert.equal(approved.statusCode, 200, approved.body);
      assert.equal(approved.json().status, 'APPROVED');
      const processBody = {
        items: [{
          id: returnRecord.items[0].id,
          disposition: 'QUARANTINE',
          sealedIntact: false,
          restockUnitId: null,
          reason: 'Quarantine test',
        }],
      };
      await database.collection('cashBookEntries').insertOne({
        shopId,
        entryType: 'SALE_RETURN_PAYOUT_CASH',
        direction: 'OUT',
        amountPaisa: Long.ONE,
        referenceType: 'SALE_RETURN',
        referenceId: new ObjectId(returnRecord.id),
        paymentMethod: 'CASH',
        actorId: actor._id,
        createdAt: new Date(),
      });
      const forcedFailure = await app.inject({
        method: 'POST',
        url: `/api/returns/${returnRecord.id}/process`,
        headers: headers(),
        payload: processBody,
      });
      assert.equal(forcedFailure.statusCode, 500);
      assert.equal(await database.collection('stockBatches').countDocuments({
        shopId, returnId: new ObjectId(returnRecord.id),
      }), 0);
      assert.equal(await database.collection('stockMovements').countDocuments({
        shopId, referenceId: new ObjectId(returnRecord.id), movementType: 'SALE_RETURN',
      }), 0);
      assert.equal((await database.collection('saleReturns').findOne({
        _id: new ObjectId(returnRecord.id), shopId,
      })).status, 'APPROVED');
      await database.collection('cashBookEntries').deleteOne({
        shopId, referenceId: new ObjectId(returnRecord.id), entryType: 'SALE_RETURN_PAYOUT_CASH',
      });
      const processed = await app.inject({
        method: 'POST',
        url: `/api/returns/${returnRecord.id}/process`,
        headers: headers(),
        payload: processBody,
      });
      assert.equal(processed.statusCode, 200, processed.body);
      assert.equal(processed.json().status, 'COMPLETED');
      const duplicateProcess = await app.inject({
        method: 'POST',
        url: `/api/returns/${returnRecord.id}/process`,
        headers: headers(),
        payload: processBody,
      });
      assert.equal(duplicateProcess.statusCode, 409);

      const report = await app.inject({ method: 'GET', url: '/api/reports/sales', headers: headers() });
      assert.equal(report.statusCode, 200, report.body);
      assert.equal(report.json().grossSalesPaisa, '150');
      assert.equal(report.json().returnsPaisa, '150');
      assert.equal(report.json().netSalesPaisa, '0');
      const cashBook = await app.inject({ method: 'GET', url: '/api/cash-book', headers: headers() });
      assert.equal(cashBook.statusCode, 200, cashBook.body);
      assert.equal(cashBook.json().totals.inflowPaisa, '150');
      assert.equal(cashBook.json().totals.outflowPaisa, '150');
      assert.equal(cashBook.json().totals.expectedDrawerPaisa, '0');
      assert.equal(await database.collection('stockMovements').countDocuments({
        shopId, movementType: 'SALE_RETURN',
      }), 1);
    } finally {
      await app.close();
    }
  });
});

test('Mongo expense, settings, print approval and sale void workflows persist with audit and cash reconciliation', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, medicineId, unitId }) => {
    const stockRepository = new MongoStockRepository(client, config.mongoDbName);
    await stockRepository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday());
    const salesRepository = new MongoSalesRepository(client, config.mongoDbName);
    const sale = await salesRepository.postSale(
      saleInput(medicineId, unitId), actor, audit(actor, 'sale.posted', 'sale'), shopToday(),
    );
    const app = createApp(client, config);
    const headers = () => ({
      authorization: `Bearer ${accessToken(actor, config)}`,
      'idempotency-key': randomUUID(),
    });
    try {
      await app.ready();
      const expense = await app.inject({
        method: 'POST',
        url: '/api/expenses',
        headers: headers(),
        payload: {
          category: 'Utilities', description: 'Integration expense',
          amountPaisa: '500', occurredAt: new Date().toISOString(),
        },
      });
      assert.equal(expense.statusCode, 201, expense.body);
      const expenseId = expense.json().id;
      const movedExpenseDate = new Date(Date.now() - 3 * 86_400_000);
      const updatedExpense = await app.inject({
        method: 'PATCH',
        url: `/api/expenses/${expenseId}`,
        headers: headers(),
        payload: {
          amountPaisa: '600',
          occurredAt: movedExpenseDate.toISOString(),
          reason: 'Corrected expense amount and date',
        },
      });
      assert.equal(updatedExpense.statusCode, 200, updatedExpense.body);
      assert.equal(updatedExpense.json().amountPaisa, '600');
      const expenseEntries = await database.collection('cashBookEntries').find({
        shopId, sourceExpenseId: new ObjectId(expenseId),
      }).toArray();
      assert.equal(expenseEntries.length, 3);
      const shiftedDay = movedExpenseDate.toISOString().slice(0, 10);
      const shiftedCashBook = await app.inject({
        method: 'GET',
        url: `/api/cash-book?dateFrom=${shiftedDay}&dateTo=${shiftedDay}`,
        headers: headers(),
      });
      assert.equal(shiftedCashBook.statusCode, 200, shiftedCashBook.body);
      assert.equal(shiftedCashBook.json().totals.outflowPaisa, '600');

      const snapshot = {
        data: {
          kind: 'SALE', memoNo: sale.invoiceNumber, dateTime: sale.soldAt.toISOString(),
          lines: [{
            qty: sale.items[0].quantityInUnit,
            name: sale.items[0].medicineName,
            ratePaisa: Number(sale.items[0].pricePaisaPerUnit.toString()),
          }],
          discountPaisa: 0, cashier: actor.fullName, role: actor.role, terminal: 'Integration',
        },
        settings: {
          storeName: 'Demo Pharmacy', address: '', phone: '', notes: ['', '', ''],
          terminalName: 'Integration', showBatchExpiry: true, roundNet: 'none',
          printTax: false, duplicateLabel: false, numberDigits: 6,
        },
        format: 'thermal80', template: 'pharmacy-memo',
      };
      const requested = await app.inject({
        method: 'POST',
        url: '/api/print-requests',
        headers: headers(),
        payload: { type: 'sale', receiptRef: sale.invoiceNumber, payload: snapshot },
      });
      assert.equal(requested.statusCode, 201, requested.body);
      const printId = requested.json().id;

      const mine = await app.inject({
        method: 'GET', url: '/api/print-requests/mine', headers: headers(),
      });
      assert.equal(mine.statusCode, 200, mine.body);
      assert.equal(mine.json().items.length, 1);
      await database.collection('users').updateOne({ _id: actor._id, shopId }, { $set: { role: 'admin' } });
      actor.role = 'admin';
      const memoSettings = await app.inject({
        method: 'PATCH',
        url: '/api/shop/settings',
        headers: headers(),
        payload: { memoSettings: { showBatchExpiry: false } },
      });
      assert.equal(memoSettings.statusCode, 200, memoSettings.body);
      const identityDenied = await app.inject({
        method: 'PATCH',
        url: '/api/shop/settings',
        headers: headers(),
        payload: { shopName: 'Unauthorized Shop Rename' },
      });
      assert.equal(identityDenied.statusCode, 403);

      const queue = await app.inject({
        method: 'GET', url: '/api/admin/print-requests', headers: headers(),
      });
      assert.equal(queue.statusCode, 200, queue.body);
      assert.equal(queue.json().items.length, 1);
      const pendingCount = await app.inject({
        method: 'GET', url: '/api/admin/print-requests/pending-count', headers: headers(),
      });
      assert.equal(pendingCount.statusCode, 200, pendingCount.body);
      assert.equal(pendingCount.json().count, 1);
      const editedSnapshot = structuredClone(snapshot);
      editedSnapshot.data.customerName = 'Receipt-only edit';
      const modified = await app.inject({
        method: 'PATCH',
        url: `/api/admin/print-requests/${printId}/snapshot`,
        headers: headers(),
        payload: { payload: editedSnapshot, reason: 'Customer display correction' },
      });
      assert.equal(modified.statusCode, 200, modified.body);
      assert.equal(modified.json().payload.data.customerName, 'Receipt-only edit');
      const unchangedSale = await database.collection('sales').findOne({ _id: sale._id, shopId });
      assert.equal(unchangedSale.customerName, sale.customerName);

      const decision = await app.inject({
        method: 'POST',
        url: `/api/admin/print-requests/${printId}/decision`,
        headers: headers(),
        payload: { decision: 'approved', note: 'Approved for test' },
      });
      assert.equal(decision.statusCode, 200, decision.body);
      const printed = await app.inject({
        method: 'POST',
        url: `/api/print-requests/${printId}/printed`,
        headers: headers(),
      });
      assert.equal(printed.statusCode, 200, printed.body);

      const voided = await app.inject({
        method: 'POST',
        url: `/api/sales/${sale._id.toHexString()}/void`,
        headers: headers(),
        payload: { reason: 'Integration void' },
      });
      assert.equal(voided.statusCode, 200, voided.body);
      const voidedSale = await database.collection('sales').findOne({ _id: sale._id, shopId });
      assert.equal(voidedSale.status, 'VOID');
      const batch = await database.collection('stockBatches').findOne({ shopId, medicineId });
      assert.equal(batch.quantityRemainingBaseUnits.toString(), '10');
      const expenseVoid = await app.inject({
        method: 'POST',
        url: `/api/expenses/${expenseId}/void`,
        headers: headers(),
        payload: { reason: 'Integration expense void' },
      });
      assert.equal(expenseVoid.statusCode, 200, expenseVoid.body);
      const cashBook = await app.inject({ method: 'GET', url: '/api/cash-book', headers: headers() });
      assert.equal(cashBook.statusCode, 200, cashBook.body);
      assert.equal(cashBook.json().totals.inflowPaisa, '1250');
      assert.equal(cashBook.json().totals.outflowPaisa, '650');
      assert.equal(cashBook.json().totals.expectedDrawerPaisa, '600');
      assert.equal(await database.collection('auditLogs').countDocuments({
        shopId, event: 'print.marked_printed',
      }), 1);
    } finally {
      await app.close();
    }
  });
});
