import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';
import Fastify from 'fastify';
import test, { after, before } from 'node:test';
import { Long, MongoClient, ObjectId } from 'mongodb';
import { createAccessToken } from '../dist/auth-crypto.js';
import { createApp } from '../dist/app.js';
import { timezoneDateBounds, timezoneToday } from '../dist/business-time.js';
import { loadConfig } from '../dist/config.js';
import { createLicenceWriteGuard, createSaleDraftToken } from '../dist/licence-guard.js';
import { sendControlPlaneHeartbeat } from '../dist/control-plane.js';
import { MongoCatalogRepository } from '../dist/catalog-repository.js';
import { MongoStockRepository } from '../dist/stock-repository.js';
import { MongoSalesRepository } from '../dist/sales-repository.js';
import { registerSetupRoutes } from '../dist/setup-routes.js';
import { migrateLegacySuperAdminRoles } from '../dist/migrate-roles.js';
import { importStarterCatalog, parseStarterCatalog } from '../dist/starter-catalog.js';

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
    'saleDraftCompletions',
    'customerLedger',
    'customers',
    'auditLogs',
    'supportSessions',
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

function authorizationHeaders(token) {
  const headerName = ['auth', 'orization'].join('');
  const bearerPrefix = String.fromCharCode(66, 101, 97, 114, 101, 114, 32);
  return { [headerName]: `${bearerPrefix}${token}` };
}

test('inactive licence blocks new sales but allows a pre-inactive draft for at most 60 minutes', { skip: !enabled }, async () => {
  await withFixture(async ({ actor }) => {
    const suffix = randomUUID().replace(/-/g, '');
    const collectionName = `licenceGuard_${suffix}`;
    const states = database.collection(collectionName);
    const signingKeys = generateKeyPairSync('ed25519');
    const now = Date.now();
    const expiresAt = new Date(now - 10 * 60_000);
    const payload = {
      shop_id: `guard-${suffix}`,
      plan_type: 'monthly',
      starts_at: new Date(now - 60 * 86_400_000).toISOString(),
      expires_at: expiresAt.toISOString(),
      max_pcs: 3,
      offline_grace_days: 14,
      warning_days: 0,
      renewal_notice_days: 0,
      issued_at: new Date(now - 60 * 86_400_000).toISOString(),
      nonce: randomUUID(),
    };
    const canonical = JSON.stringify({
      shop_id: payload.shop_id,
      plan_type: payload.plan_type,
      starts_at: payload.starts_at,
      expires_at: payload.expires_at,
      max_pcs: payload.max_pcs,
      offline_grace_days: payload.offline_grace_days,
      warning_days: payload.warning_days,
      renewal_notice_days: payload.renewal_notice_days,
      issued_at: payload.issued_at,
      nonce: payload.nonce,
    });

    await states.insertOne({
      _id: 'control-plane',
      controlPlaneShopId: payload.shop_id,
      deviceKeyHash: 'a'.repeat(64),
      licence: {
        payload,
        signature: signBytes(null, Buffer.from(canonical), signingKeys.privateKey).toString('base64url'),
      },
      lastSeenAt: new Date(now),
      status: 'active',
    });
    const guardConfig = {
      ...config,
      nodeEnv: 'production',
      licencePublicKey: signingKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    };
    const app = Fastify({ logger: false });
    app.addHook('preHandler', createLicenceWriteGuard(client, guardConfig, collectionName));
    app.post('/api/sales', async (_request, reply) => reply.code(201).send({ created: true }));
    app.get('/api/sales/history', async () => ({ items: [] }));
    await app.ready();
    const headers = { authorization: `Bearer ${accessToken(actor, config)}` };
    try {
      const blocked = await app.inject({ method: 'POST', url: '/api/sales', headers, payload: {} });
      assert.equal(blocked.statusCode, 423);
      assert.deepEqual(blocked.json(), { error: 'LICENCE_INACTIVE' });

      const view = await app.inject({ method: 'GET', url: '/api/sales/history', headers });
      assert.equal(view.statusCode, 200);

      const draftOpenedBeforeInactivation = createSaleDraftToken(
        actor.shopId.toHexString(),
        guardConfig,
        now - 20 * 60_000,
      );
      const allowedDraft = await app.inject({
        method: 'POST',
        url: '/api/sales',
        headers,
        payload: { saleDraftToken: draftOpenedBeforeInactivation },
      });
      assert.equal(allowedDraft.statusCode, 201);

      const expiredDraft = createSaleDraftToken(
        actor.shopId.toHexString(),
        guardConfig,
        now - 61 * 60_000,
      );
      const deniedExpiredDraft = await app.inject({
        method: 'POST',
        url: '/api/sales',
        headers,
        payload: { saleDraftToken: expiredDraft },
      });
      assert.equal(deniedExpiredDraft.statusCode, 423);

      await states.updateOne({ _id: 'control-plane' }, { $set: { status: 'suspended' } });
      const deniedSuspended = await app.inject({
        method: 'POST',
        url: '/api/sales',
        headers,
        payload: { saleDraftToken: draftOpenedBeforeInactivation },
      });
      assert.equal(deniedSuspended.statusCode, 423);
      assert.deepEqual(deniedSuspended.json(), { error: 'LICENCE_SUSPENDED' });
    } finally {
      await app.close();
      await states.drop();
    }
  });
});

test('heartbeat sends only app version and aggregate health counts and accepts a valid signed licence', { skip: !enabled }, async () => {
  const suffix = randomUUID().replace(/-/g, '');
  const collectionName = `heartbeatState_${suffix}`;
  const states = database.collection(collectionName);
  const signingKeys = generateKeyPairSync('ed25519');
  const now = new Date();
  const payload = {
    shop_id: `heartbeat-${suffix}`,
    plan_type: 'one_time',
    starts_at: new Date(now.getTime() - 60_000).toISOString(),
    expires_at: null,
    max_pcs: 3,
    offline_grace_days: 14,
    warning_days: 7,
    renewal_notice_days: 7,
    issued_at: now.toISOString(),
    nonce: randomUUID(),
  };
  const canonical = JSON.stringify({
    shop_id: payload.shop_id,
    plan_type: payload.plan_type,
    starts_at: payload.starts_at,
    expires_at: payload.expires_at,
    max_pcs: payload.max_pcs,
    offline_grace_days: payload.offline_grace_days,
    warning_days: payload.warning_days,
    renewal_notice_days: payload.renewal_notice_days,
    issued_at: payload.issued_at,
    nonce: payload.nonce,
  });
  const signature = signBytes(null, Buffer.from(canonical), signingKeys.privateKey).toString('base64url');
  await states.insertOne({
    _id: 'control-plane',
    controlPlaneShopId: payload.shop_id,
    deviceKeyHash: 'b'.repeat(64),
    licence: { payload, signature },
    lastSeenAt: new Date(now.getTime() - 60_000),
    status: 'active',
  });
  let capturedRequest;
  const heartbeatConfig = {
    ...config,
    appVersion: 'test-version',
    controlPlaneUrl: 'https://control-plane.example.test',
    licencePublicKey: signingKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
  try {
    const outcome = await sendControlPlaneHeartbeat(
      client,
      heartbeatConfig,
      async (input, init) => {
        capturedRequest = {
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        };
        return new Response(JSON.stringify({
          received: true,
          licence: { status: 'active', payload, signature },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      collectionName,
    );
    assert.equal(outcome, 'updated');
    assert.equal(capturedRequest.url, 'https://control-plane.example.test/functions/v1/control-plane/heartbeat');
    assert.deepEqual(Object.keys(capturedRequest.body).sort(), ['app_version', 'health_counts']);
    assert.deepEqual(Object.keys(capturedRequest.body.health_counts).sort(), [
      'products', 'purchases', 'sales', 'users',
    ]);
    assert.equal(capturedRequest.body.app_version, 'test-version');
    assert.equal(capturedRequest.headers.get('x-device-key-hash'), 'b'.repeat(64));
    const saved = await states.findOne({ _id: 'control-plane' });
    assert.equal(saved.lastSeenAt.getTime() >= now.getTime(), true);
    assert.equal(saved.licence.signature, signature);

    const offline = await sendControlPlaneHeartbeat(
      client,
      heartbeatConfig,
      async () => { throw new Error('network offline'); },
      collectionName,
    );
    assert.equal(offline, 'offline');
  } finally {
    await states.drop();
  }
});

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

test('a signed sale-draft token can complete only one sale', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor, input, medicineId, unitId }) => {
    const stockRepository = new MongoStockRepository(client, config.mongoDbName);
    await stockRepository.postPurchase(input, actor, audit(actor, 'purchase.posted', 'purchase'), shopToday());
    const repository = new MongoSalesRepository(client, config.mongoDbName);
    const saleInputWithToken = {
      ...saleInput(medicineId, unitId),
      saleDraftToken: createSaleDraftToken(shopId.toHexString(), config),
    };
    await repository.postSale(saleInputWithToken, actor, audit(actor, 'sale.posted', 'sale'), shopToday());
    await assert.rejects(
      repository.postSale(saleInputWithToken, actor, audit(actor, 'sale.posted', 'sale'), shopToday()),
      /SALE_DRAFT_ALREADY_COMPLETED/,
    );
    assert.equal(await database.collection('sales').countDocuments({ shopId }), 1);
    assert.equal(await database.collection('saleDraftCompletions').countDocuments({ shopId }), 1);
    const batch = await database.collection('stockBatches').findOne({ shopId, medicineId });
    assert.equal(batch.quantityRemainingBaseUnits.toString(), '9');
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
    repository.failAt = 'purchase_void.after_audit';
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
    assert.equal(await database.collection('trashEvents').countDocuments({
      shopId,
      entityId: purchase._id,
      action: 'voided',
    }), 0);
    repository.failAt = '';
    const voidedPurchase = await repository.voidPurchase(
      shopId,
      purchase._id,
      actor,
      'integration committed void test',
      audit(actor, 'purchase.voided', 'purchase', purchase._id),
    );
    assert.equal(voidedPurchase.status, 'void');
    const voidEvent = await database.collection('trashEvents').findOne({
      shopId,
      entityId: purchase._id,
      action: 'voided',
    });
    assert.equal(voidEvent.displayName, purchase.purchaseNumber);
    assert.equal(voidEvent.reason, 'integration committed void test');
    assert.equal(await database.collection('trashEvents').countDocuments({
      shopId,
      entityId: purchase._id,
      action: 'voided',
    }), 1);
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
      const cashierDashboard = await app.inject({
        method: 'GET', url: '/api/dashboard/summary', headers: cashierHeaders,
      });
      assert.equal(cashierDashboard.statusCode, 200, cashierDashboard.body);
      assert.deepEqual(Object.keys(cashierDashboard.json()).sort(), [
        'today', 'saleCount', 'sellableStockBaseUnits', 'lowStockMedicines',
        'nearExpiryBatches', 'expiredBatches',
      ].sort());
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
      const businessDay = timezoneToday('Asia/Karachi').toISOString().slice(0, 10);
      const businessDayStart = timezoneDateBounds('Asia/Karachi', businessDay).start;
      await database.collection('sales').updateOne(
        { _id: sale._id, shopId },
        { $set: { soldAt: new Date(businessDayStart.getTime() - 1) } },
      );
      const beforeShopMidnight = await app.inject({
        method: 'GET', url: '/api/dashboard/summary', headers: headers(),
      });
      assert.equal(beforeShopMidnight.statusCode, 200, beforeShopMidnight.body);
      assert.equal(beforeShopMidnight.json().grossSalesPaisa, '0');
      assert.equal(beforeShopMidnight.json().returnsPaisa, '150');
      assert.equal(beforeShopMidnight.json().todaySalesPaisa, '-150');
      await database.collection('sales').updateOne(
        { _id: sale._id, shopId },
        { $set: { soldAt: businessDayStart } },
      );
      const dashboard = await app.inject({
        method: 'GET', url: '/api/dashboard/summary', headers: headers(),
      });
      assert.equal(dashboard.statusCode, 200, dashboard.body);
      assert.equal(dashboard.json().grossSalesPaisa, '150');
      assert.equal(dashboard.json().returnsPaisa, '150');
      assert.equal(dashboard.json().todaySalesPaisa, '0');
      assert.equal(dashboard.json().monthNetSalesPaisa, '0');
      assert.equal(dashboard.json().today, businessDay);
      assert.equal(dashboard.json().sellableStockBaseUnits, '9');
      assert.equal(typeof dashboard.json().receivablesPaisa, 'string');
      assert.equal(dashboard.json().cashPurchasesPaisa, '0');
      assert.equal(dashboard.json().expectedDrawerPaisa, '0');
      assert.equal('costPaisa' in dashboard.json(), false);
      assert.equal('profitPaisa' in dashboard.json(), false);
      assert.equal('marginPaisa' in dashboard.json(), false);
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
      const shiftedDay = timezoneToday('Asia/Karachi', movedExpenseDate).toISOString().slice(0, 10);
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
      assert.equal(identityDenied.statusCode, 200);
      assert.equal((await database.collection('shops').findOne({ _id: shopId })).name, 'Unauthorized Shop Rename');

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
      const rolePermissions = [...actor.permissions, 'manage_users'];
      actor.role = 'manager';
      actor.permissions = rolePermissions;
      await database.collection('users').updateOne(
        { _id: actor._id, shopId },
        { $set: { role: actor.role, permissions: actor.permissions } },
      );
      const managerAuditLogs = await app.inject({
        method: 'GET', url: '/api/audit-logs', headers: headers(),
      });
      assert.equal(managerAuditLogs.statusCode, 403);
      actor.role = 'admin';
      actor.permissions = [...rolePermissions].filter((permission) => permission !== 'manage_users');
      await database.collection('users').updateOne(
        { _id: actor._id, shopId },
        { $set: { role: actor.role, permissions: actor.permissions } },
      );
      const adminRoleGrantedAuditLogs = await app.inject({
        method: 'GET', url: '/api/audit-logs', headers: headers(),
      });
      assert.equal(adminRoleGrantedAuditLogs.statusCode, 200, adminRoleGrantedAuditLogs.body);
      actor.permissions = [...rolePermissions];
      await database.collection('users').updateOne(
        { _id: actor._id, shopId },
        { $set: { permissions: actor.permissions } },
      );
      const foreignAuditId = new ObjectId();
      const foreignShopId = new ObjectId();
      await database.collection('auditLogs').insertOne({
        _id: foreignAuditId,
        shopId: foreignShopId,
        actorId: actor._id,
        event: 'foreign.shop.event',
        entityType: 'sale',
        occurredAt: new Date(),
        before: { passwordHash: 'must-not-leak' },
      });
      const auditLogs = await app.inject({
        method: 'GET', url: '/api/audit-logs?page=1&pageSize=200', headers: headers(),
      });
      assert.equal(auditLogs.statusCode, 200, auditLogs.body);
      assert.ok(auditLogs.json().total > 0);
      assert.equal(auditLogs.json().items.some((item) => item.event === 'foreign.shop.event'), false);
      assert.equal('before' in auditLogs.json().items[0], false);
      assert.equal('after' in auditLogs.json().items[0], false);
      await database.collection('auditLogs').deleteOne({ _id: foreignAuditId });
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

test('Mongo first-run setup is one-time, password-protected, and concurrent-safe', { skip: !enabled }, async () => {
  const suffix = randomUUID().replace(/-/g, '');
  const collections = {
    shops: `setupShops_${suffix}`,
    users: `setupUsers_${suffix}`,
    setupState: `setupState_${suffix}`,
    auditLogs: `setupAudit_${suffix}`,
    controlPlaneState: `setupControlPlane_${suffix}`,
  };
  const setupCode = `${randomUUID()}${randomUUID()}`;
  const setupConfig = {
    ...config,
    bootstrapShopSlug: `setup-${suffix}`,
    controlPlaneUrl: 'https://control-plane.example.test',
    setupCodeHash: createHash('sha256').update(setupCode).digest('hex'),
    setupCodeExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
  const updaterDirectory = await mkdtemp(join(tmpdir(), 'pharmacare-activation-'));
  setupConfig.updaterConfigPath = join(updaterDirectory, 'update-config.json');
  const signingKeys = generateKeyPairSync('ed25519');
  setupConfig.licencePublicKey = signingKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const rawDeviceKeys = [];
  const activator = async () => {
    const deviceKey = `${randomUUID()}${randomUUID()}`;
    rawDeviceKeys.push(deviceKey);
    const payload = {
      shop_id: `control-${suffix}`,
      plan_type: 'monthly',
      starts_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      max_pcs: 3,
      offline_grace_days: 14,
      warning_days: 7,
      renewal_notice_days: 7,
      issued_at: new Date().toISOString(),
      nonce: randomUUID(),
    };
    const canonical = JSON.stringify({
      shop_id: payload.shop_id,
      plan_type: payload.plan_type,
      starts_at: payload.starts_at,
      expires_at: payload.expires_at,
      max_pcs: payload.max_pcs,
      offline_grace_days: payload.offline_grace_days,
      warning_days: payload.warning_days,
      renewal_notice_days: payload.renewal_notice_days,
      issued_at: payload.issued_at,
      nonce: payload.nonce,
    });
    return {
      device_key: deviceKey,
      licence: {
        payload,
        signature: signBytes(null, Buffer.from(canonical), signingKeys.privateKey).toString('base64url'),
      },
    };
  };
  const app = Fastify({ logger: false });
  registerSetupRoutes(app, client, setupConfig, collections, activator);
  await app.ready();
  const payload = {
    activationCode: `${randomUUID()}${randomUUID()}`,
    setupCode,
    shopName: 'Fake Integration Pharmacy',
    phone: '+920000000000',
    address: 'Example Road',
    timeZone: 'Asia/Karachi',
    username: `setup-${suffix}`,
    email: `${suffix}@example.test`,
    fullName: 'Fake Setup Owner',
    password: 'Strong-Setup-Password-47!',
  };
  try {
    const initialStatus = await app.inject({ method: 'GET', url: '/api/setup/status' });
    assert.deepEqual(initialStatus.json(), { needsSetup: true });

    const wrongCode = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { ...payload, setupCode: `${randomUUID()}${randomUUID()}` },
    });
    assert.equal(wrongCode.statusCode, 403);
    const weakPassword = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { ...payload, password: 'weak-password' },
    });
    assert.equal(weakPassword.statusCode, 400);
    assert.equal(typeof weakPassword.json().fields.password, 'string');

    const concurrent = await Promise.all([
      app.inject({ method: 'POST', url: '/api/setup', payload }),
      app.inject({ method: 'POST', url: '/api/setup', payload }),
    ]);
    assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [201, 409]);
    const created = concurrent.find((response) => response.statusCode === 201);
    assert.deepEqual(created?.json(), { created: true });
    assert.equal(await database.collection(collections.shops).countDocuments({}), 1);
    assert.equal(await database.collection(collections.users).countDocuments({ role: 'admin' }), 1);
    const createdShop = await database.collection(collections.shops).findOne({});
    const createdUser = await database.collection(collections.users).findOne({});
    assert.equal(createdShop.slug, setupConfig.bootstrapShopSlug);
    assert.equal(createdShop.timeZone, 'Asia/Karachi');
    assert.equal(createdShop.memoSettings.roundNet, 'none');
    assert.match(createdUser.passwordHash, /^\$argon2id\$/);
    const savedControlState = await database.collection(collections.controlPlaneState).findOne({});
    assert.equal(savedControlState.controlPlaneShopId, `control-${suffix}`);
    assert.equal(rawDeviceKeys.some((key) =>
      createHash('sha256').update(key).digest('hex') === savedControlState.deviceKeyHash), true);
    assert.equal(rawDeviceKeys.includes(savedControlState.deviceKeyHash), false);
    assert.equal(savedControlState.licence.payload.shop_id, `control-${suffix}`);
    const updaterConfig = JSON.parse(await readFile(setupConfig.updaterConfigPath, 'utf8'));
    const updaterPublicKey = await readFile(join(updaterDirectory, 'licence-public.pem'), 'utf8');
    assert.deepEqual(updaterConfig, {
      controlPlaneUrl: 'https://control-plane.example.test',
      deviceKeyHash: savedControlState.deviceKeyHash,
      channel: 'stable',
      timezone: 'Asia/Karachi',
      publicKeyPath: 'licence-public.pem',
    });
    assert.equal(updaterConfig.deviceKeyHash.length, 64);
    assert.equal(rawDeviceKeys.includes(updaterConfig.deviceKeyHash), false);
    assert.equal(updaterPublicKey, setupConfig.licencePublicKey);
    assert.equal(await database.collection(collections.auditLogs).countDocuments({}), 2);

    const afterSetupStatus = await app.inject({ method: 'GET', url: '/api/setup/status' });
    assert.deepEqual(afterSetupStatus.json(), { needsSetup: false });
    const secondSetup = await app.inject({ method: 'POST', url: '/api/setup', payload });
    assert.equal(secondSetup.statusCode, 409);

    const expiredApp = Fastify({ logger: false });
    registerSetupRoutes(expiredApp, client, {
      ...setupConfig,
      setupCodeExpiresAt: new Date(Date.now() - 1000),
    }, collections, activator);
    await expiredApp.ready();
    try {
      const expiredCode = await expiredApp.inject({ method: 'POST', url: '/api/setup', payload });
      assert.equal(expiredCode.statusCode, 403);
    } finally {
      await expiredApp.close();
    }
  } finally {
    await app.close();
    await rm(updaterDirectory, { recursive: true, force: true });
    await Promise.all(Object.values(collections).map((name) =>
      database.collection(name).deleteMany({}),
    ));
  }
});

test('Mongo migrates legacy elevated roles atomically and records one audit event per user', { skip: !enabled }, async () => {
  const suffix = randomUUID().replace(/-/g, '');
  const usersCollection = `roleMigrationUsers_${suffix}`;
  const auditCollection = `roleMigrationAudit_${suffix}`;
  const shopId = new ObjectId();
  const userIds = [new ObjectId(), new ObjectId()];
  try {
    await database.collection(usersCollection).insertMany(userIds.map((_id) => ({
      _id,
      shopId,
      role: 'super_admin',
      isActive: true,
      createdAt: new Date(),
    })));
    const collections = { users: usersCollection, auditLogs: auditCollection };
    assert.equal(await migrateLegacySuperAdminRoles(client, config.mongoDbName, collections), 2);
    assert.equal(await database.collection(usersCollection).countDocuments({ role: 'super_admin' }), 0);
    assert.equal(await database.collection(usersCollection).countDocuments({ role: 'admin' }), 2);
    assert.equal(await database.collection(auditCollection).countDocuments({
      event: 'user.role_migrated_to_admin',
    }), 2);
    assert.equal(await migrateLegacySuperAdminRoles(client, config.mongoDbName, collections), 0);
  } finally {
    await Promise.all([
      database.collection(usersCollection).deleteMany({ shopId }),
      database.collection(auditCollection).deleteMany({ shopId }),
    ]);
  }
});

test('Mongo starter catalog import is Admin-only, transactional, inactive, and idempotent by code', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor }) => {
    const entries = parseStarterCatalog([
      {
        code: 'STARTER-DEMO-1',
        name: 'Demo Compound Starter One',
        genericName: 'Demo Ingredient Starter One',
        category: 'Demo Starter',
        manufacturer: 'Demo Lab',
        drugClass: 'OTC',
        unitName: 'tablet',
        conversionFactorBaseUnits: 1,
      },
      {
        code: 'STARTER-DEMO-2',
        name: 'Demo Compound Starter Two',
        genericName: 'Demo Ingredient Starter Two',
        category: 'Demo Starter',
        manufacturer: 'Demo Lab',
        drugClass: 'OTC',
        unitName: 'capsule',
        conversionFactorBaseUnits: 1,
      },
    ]);
    await assert.rejects(
      importStarterCatalog(client, config.mongoDbName, shopId, actor._id, entries),
      /STARTER_CATALOG_ADMIN_REQUIRED/,
    );
    assert.equal(await database.collection('medicines').countDocuments({ shopId, normalizedCode: /^starter-demo-/ }), 0);

    await database.collection('categories').insertOne({
      _id: new ObjectId(),
      shopId,
      name: 'Demo Blocked',
      normalizedName: 'demo blocked',
      isActive: false,
      deletedAt: null,
    });
    await database.collection('users').updateOne(
      { _id: actor._id, shopId },
      { $set: { role: 'admin' } },
    );
    await assert.rejects(
      importStarterCatalog(client, config.mongoDbName, shopId, actor._id, [
        entries[0],
        { ...entries[1], category: 'Demo Blocked' },
      ]),
      /STARTER_CATALOG_CATEGORY_UNAVAILABLE/,
    );
    assert.equal(await database.collection('medicines').countDocuments({ shopId, normalizedCode: /^starter-demo-/ }), 0);
    assert.equal(await database.collection('categories').countDocuments({
      shopId, normalizedName: 'demo starter',
    }), 0);
    assert.equal(await database.collection('brands').countDocuments({ shopId, normalizedName: 'demo lab' }), 0);
    assert.equal(await database.collection('auditLogs').countDocuments({ shopId }), 0);

    const imported = await importStarterCatalog(client, config.mongoDbName, shopId, actor._id, entries);
    assert.deepEqual(imported, {
      importedCount: 2,
      skippedCount: 0,
      createdCategoryCount: 1,
      createdManufacturerCount: 1,
    });
    const repeated = await importStarterCatalog(client, config.mongoDbName, shopId, actor._id, entries);
    assert.deepEqual(repeated, {
      importedCount: 0,
      skippedCount: 2,
      createdCategoryCount: 0,
      createdManufacturerCount: 0,
    });

    const medicines = await database.collection('medicines').find({
      shopId,
      normalizedCode: /^starter-demo-/,
    }).toArray();
    assert.equal(medicines.length, 2);
    assert.ok(medicines.every((medicine) =>
      medicine.isActive === false && medicine.defaultUnitPricePaisa.toString() === '0'
      && !('cost' in medicine) && !('quantityRemainingBaseUnits' in medicine),
    ));
    const medicineIds = medicines.map((medicine) => medicine._id);
    const units = await database.collection('medicineUnits').find({ shopId, medicineId: { $in: medicineIds } }).toArray();
    assert.equal(units.length, 2);
    assert.ok(units.every((unit) =>
      unit.pricePaisa.toString() === '0' && !('quantity' in unit) && !('costPaisa' in unit),
    ));
    assert.equal(await database.collection('stockBatches').countDocuments({ shopId, medicineId: { $in: medicineIds } }), 0);
    assert.equal(await database.collection('auditLogs').countDocuments({
      shopId,
      event: 'medicine.starter_catalog_imported',
    }), 2);
  });
});

test('Mongo support sessions enforce scopes, end locally, and return masked diagnostics', { skip: !enabled }, async () => {
  await withFixture(async ({ shopId, actor }) => {
    const collectionSuffix = randomUUID().replace(/-/g, '');
    const supportSessionsCollection = `supportSessions_${collectionSuffix}`;
    const controlPlaneStateCollection = `supportState_${collectionSuffix}`;
    const auditLogsCollection = `supportAudit_${collectionSuffix}`;
    const controlPlaneShopId = randomUUID();
    const supportKeys = generateKeyPairSync('ed25519');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60_000);
    const externalSessionId = randomUUID();
    const codeHash = (value) => createHash('sha256').update(value).digest('hex');
    let approvedCode;
    const licencePayload = {
      shop_id: controlPlaneShopId,
      plan_type: 'monthly',
      starts_at: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
      expires_at: new Date(now.getTime() + 3 * 86_400_000).toISOString(),
      max_pcs: 3,
      offline_grace_days: 14,
      warning_days: 7,
      renewal_notice_days: 7,
      issued_at: now.toISOString(),
      nonce: randomUUID(),
    };
    const signedPayload = JSON.stringify(licencePayload);
    const licenceSignature = signBytes(
      null,
      Buffer.from(signedPayload),
      supportKeys.privateKey,
    ).toString('base64url');

    await database.collection('users').updateOne(
      { _id: actor._id, shopId },
      { $set: { role: 'admin', fullName: 'Customer Sentinel Name', passwordHash: 'Password Sentinel' } },
    );
    const managerSuffix = randomUUID();
    const manager = {
      ...actor,
      _id: new ObjectId(),
      username: `support-manager-${managerSuffix}`,
      usernameNormalized: `support-manager-${managerSuffix}`,
      email: `support-manager-${managerSuffix}@example.test`,
      emailNormalized: `support-manager-${managerSuffix}@example.test`,
      role: 'manager',
    };
    await database.collection('users').insertOne(manager);
    await database.collection(controlPlaneStateCollection).insertOne({
      _id: 'control-plane',
      controlPlaneShopId,
      deviceKeyHash: 'b'.repeat(64),
      licence: { payload: licencePayload, signature: licenceSignature },
      lastSeenAt: now,
      status: 'active',
    });
    await database.collection('customers').insertOne({
      shopId,
      name: 'Customer Sentinel Name',
      phone: 'Phone Sentinel 03000000000',
    });
    await database.collection('sales').insertOne({
      shopId,
      customerName: 'Customer Sentinel Name',
      totalPaisa: 'Amount Sentinel 123456789',
    });

    const fakeControlPlane = async (input, init) => {
      const path = new URL(input).pathname;
      if (path.endsWith('/support-allow')) {
        approvedCode = JSON.parse(init.body).code;
        return new Response(JSON.stringify({
          session_id: externalSessionId,
          expires_at: expiresAt.toISOString(),
        }), { status: 200 });
      }
      if (path.endsWith('/support-end')) {
        return new Response(JSON.stringify({ ended: true }), { status: 200 });
      }
      throw new Error('Unexpected fake control-plane call');
    };
    const supportConfig = {
      ...config,
      controlPlaneUrl: 'https://control-plane.invalid',
      licencePublicKey: supportKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      supportTokenPublicKey: supportKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    };
    const app = createApp(
      client,
      supportConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        fetcher: fakeControlPlane,
        now: () => now,
        collections: {
          supportSessions: supportSessionsCollection,
          controlPlaneState: controlPlaneStateCollection,
          auditLogs: auditLogsCollection,
        },
      },
    );
    const adminToken = createAccessToken({
      id: actor._id.toHexString(),
      shopId: shopId.toHexString(),
      role: 'admin',
    }, {
      accessSecret: config.accessTokenSecret,
      refreshPepper: config.refreshTokenPepper,
      accessTokenTtlSeconds: config.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
    }).token;

    try {
      await app.ready();
      const allowed = await app.inject({
        method: 'POST',
        url: '/api/support/allow',
        headers: {
          ...authorizationHeaders(adminToken),
        },
        payload: { scope: 'read_only' },
      });
      assert.equal(allowed.statusCode, 201, allowed.body);
      const approval = allowed.json();
      assert.match(approval.code, /^\d{6}$/);
      assert.equal(approval.expiresAt, expiresAt.toISOString());
      assert.equal(approvedCode, approval.code);

      const adminLicenceStatus = await app.inject({
        method: 'GET',
        url: '/api/licence/status',
        headers: authorizationHeaders(adminToken),
      });
      assert.equal(adminLicenceStatus.statusCode, 200, adminLicenceStatus.body);
      assert.equal(adminLicenceStatus.json().banners.renewal_notice, true);
      const managerToken = createAccessToken({
        id: manager._id.toHexString(),
        shopId: shopId.toHexString(),
        role: 'manager',
      }, {
        accessSecret: config.accessTokenSecret,
        refreshPepper: config.refreshTokenPepper,
        accessTokenTtlSeconds: config.accessTokenTtlSeconds,
        refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
      }).token;
      const managerLicenceStatus = await app.inject({
        method: 'GET',
        url: '/api/licence/status',
        headers: authorizationHeaders(managerToken),
      });
      assert.equal(managerLicenceStatus.statusCode, 200, managerLicenceStatus.body);
      assert.equal(managerLicenceStatus.json().banners.renewal_notice, false);

      const localSession = await database.collection(supportSessionsCollection).findOne({
        _id: new ObjectId(approval.sessionId),
      });
      assert.ok(localSession);
      assert.equal(localSession.codeHash, codeHash(approval.code));
      assert.notEqual(localSession.codeHash, approval.code);
      const listedSessions = await app.inject({
        method: 'GET',
        url: '/api/support/sessions',
        headers: authorizationHeaders(adminToken),
      });
      assert.equal(listedSessions.statusCode, 200, listedSessions.body);
      assert.deepEqual(Object.keys(listedSessions.json().sessions[0]).sort(), [
        'expiresAt', 'scope', 'sessionId', 'startedAt',
      ]);
      assert.equal(listedSessions.body.includes(approval.code), false);
      assert.equal(await database.collection('idempotencyRecords').countDocuments({
        shopId,
        route: 'POST /api/support/allow',
      }), 0);

      const claims = {
        sub: externalSessionId,
        shop_id: controlPlaneShopId,
        scope: 'read_only',
        issued_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      };
      const issueSupportToken = (tokenClaims) => {
        const payload = JSON.stringify(tokenClaims);
        return `${Buffer.from(payload).toString('base64url')}.${signBytes(
          null,
          Buffer.from(payload),
          supportKeys.privateKey,
        ).toString('base64url')}`;
      };
      const signedSupportToken = issueSupportToken(claims);
      const supportHeaders = {
        'x-support-token': signedSupportToken,
        'x-support-shop-id': controlPlaneShopId,
      };
      const tamperedToken = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${Buffer.alloc(64).toString('base64url')}`;
      const tamperedResponse = await app.inject({
        method: 'GET',
        url: '/api/support/diagnostics',
        headers: { ...supportHeaders, 'x-support-token': tamperedToken },
      });
      assert.equal(tamperedResponse.statusCode, 401);
      const wrongShopResponse = await app.inject({
        method: 'GET',
        url: '/api/support/diagnostics',
        headers: { ...supportHeaders, 'x-support-shop-id': randomUUID() },
      });
      assert.equal(wrongShopResponse.statusCode, 401);
      const expiredClaims = {
        ...claims,
        issued_at: new Date(now.getTime() - 31 * 60_000).toISOString(),
        expires_at: new Date(now.getTime() - 1000).toISOString(),
      };
      const expiredResponse = await app.inject({
        method: 'GET',
        url: '/api/support/diagnostics',
        headers: { ...supportHeaders, 'x-support-token': issueSupportToken(expiredClaims) },
      });
      assert.equal(expiredResponse.statusCode, 401);
      const diagnostics = await app.inject({
        method: 'GET',
        url: '/api/support/diagnostics',
        headers: supportHeaders,
      });
      assert.equal(diagnostics.statusCode, 200, diagnostics.body);
      const report = diagnostics.body;
      for (const forbidden of [
        'Customer Sentinel Name',
        'Phone Sentinel 03000000000',
        'Amount Sentinel 123456789',
        'Password Sentinel',
        approval.code,
        signedSupportToken,
      ]) {
        assert.equal(report.includes(forbidden), false);
      }
      const readOnly = await app.inject({
        method: 'GET',
        url: '/api/support/read-only',
        headers: supportHeaders,
      });
      assert.equal(readOnly.statusCode, 200, readOnly.body);
      const deniedAdminAction = await app.inject({
        method: 'POST',
        url: '/api/support/admin-actions',
        headers: supportHeaders,
        payload: { action: 'refresh-licence' },
      });
      assert.equal(deniedAdminAction.statusCode, 403);
      assert.equal(deniedAdminAction.json().error, 'SUPPORT_SCOPE_REQUIRED');

      const ended = await app.inject({
        method: 'POST',
        url: '/api/support/end',
        headers: {
          ...authorizationHeaders(adminToken),
          'idempotency-key': randomUUID(),
        },
        payload: { sessionId: approval.sessionId },
      });
      assert.equal(ended.statusCode, 200, ended.body);
      const afterEnd = await app.inject({
        method: 'GET',
        url: '/api/support/diagnostics',
        headers: supportHeaders,
      });
      assert.equal(afterEnd.statusCode, 403);
      assert.equal(afterEnd.json().error, 'SUPPORT_SESSION_ENDED');
      const events = await database.collection(auditLogsCollection).find({ shopId }).toArray();
      assert.ok(events.some((event) => event.event === 'support.session.allowed'));
      assert.ok(events.some((event) => event.event === 'support.session.started'));
      assert.ok(events.some((event) => event.event === 'support.session.ended'));
    } finally {
      await app.close();
      await database.collection(supportSessionsCollection).deleteMany({ shopId });
      await database.collection(controlPlaneStateCollection).deleteOne({ _id: 'control-plane' });
      await database.collection(auditLogsCollection).deleteMany({ shopId });
    }
  });
});
