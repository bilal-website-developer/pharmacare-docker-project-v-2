import assert from 'node:assert/strict';
import test from 'node:test';
import { Long, MongoClient, ObjectId } from 'mongodb';
import { createAccessToken } from './auth-crypto.js';
import { createApp } from './app.js';
import { MemoryCatalogRepository } from './test-support/memory-catalog-repository.js';
import { MemoryIdempotencyStore } from './test-support/memory-idempotency-store.js';
import { MemoryRepository } from './test-support/memory-repository.js';
import { MemoryStockRepository } from './test-support/memory-stock-repository.js';
import { testConfig } from './test-support/test-config.js';
import { derivedExpiryStatus, type StockBatchRecord } from './stock-domain.js';
import type { UserRecord } from './models.js';

function bearer(user: UserRecord): string {
  return createAccessToken({
    id: user._id.toHexString(),
    shopId: user.shopId.toHexString(),
    role: user.role,
  }, {
    accessSecret: testConfig.accessTokenSecret,
    refreshPepper: testConfig.refreshTokenPepper,
    accessTokenTtlSeconds: testConfig.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: testConfig.refreshTokenTtlSeconds,
  }).token;
}

function headers(user: UserRecord) {
  return {
    authorization: `Bearer ${bearer(user)}`,
    'idempotency-key': new ObjectId().toHexString(),
  };
}

function dateFromToday(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function setup() {
  const auth = new MemoryRepository();
  const shop = auth.addShop();
  const admin = auth.addUser(shop, {
    username: 'admin',
    email: 'admin@example.test',
    role: 'admin',
    permissions: [],
  });
  const manager = auth.addUser(shop, {
    username: 'manager',
    email: 'manager@example.test',
    role: 'manager',
    permissions: ['purchases', 'purchase_history', 'stock_inventory', 'stock_alerts'],
  });
  const cashier = auth.addUser(shop, {
    username: 'cashier',
    email: 'cashier@example.test',
    role: 'cashier',
    permissions: ['purchases', 'purchase_history', 'stock_inventory', 'stock_alerts'],
  });
  const accountant = auth.addUser(shop, {
    username: 'accountant',
    email: 'accountant@example.test',
    role: 'accountant',
    permissions: ['purchase_history'],
  });
  const stock = new MemoryStockRepository();
  const supplierId = stock.seedSupplier(shop._id);
  const medicine = stock.seedMedicine(shop._id, 'Paracetamol', 10);
  const client = new MongoClient('mongodb://127.0.0.1:1');
  const idempotency = new MemoryIdempotencyStore();
  const app = createApp(
    client, testConfig, auth, new MemoryCatalogRepository(), stock, idempotency,
  );
  await app.ready();
  return { app, client, auth, shop, admin, manager, cashier, accountant, stock, supplierId, medicine, idempotency };
}

function purchaseBody(
  supplierId: ObjectId,
  medicineId: ObjectId,
  unitId: ObjectId,
  overrides: Record<string, unknown> = {},
) {
  return {
    supplierId: supplierId.toHexString(),
    paymentType: 'credit',
    discountPaisa: '2',
    items: [{
      medicineId: medicineId.toHexString(),
      unitId: unitId.toHexString(),
      batchNumber: 'BATCH-001',
      expiryDate: dateFromToday(120),
      quantity: 2,
      bonusQuantity: 1,
      unitCostPaisa: '101',
      mrpPaisa: '150',
    }],
    ...overrides,
  };
}

function stockBatch(
  shopId: ObjectId,
  medicineId: ObjectId,
  values: { batchNumber: string; daysToExpiry: number; quantity: number; status?: StockBatchRecord['status'] },
): StockBatchRecord {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const expiryDate = new Date(today);
  expiryDate.setUTCDate(expiryDate.getUTCDate() + values.daysToExpiry);
  const quantity = Long.fromNumber(values.quantity);
  return {
    _id: new ObjectId(),
    shopId,
    medicineId,
    supplierId: new ObjectId(),
    purchaseId: new ObjectId(),
    purchaseItemId: new ObjectId(),
    batchNumber: values.batchNumber,
    expiryDate,
    receivedDate: today,
    quantityReceivedBaseUnits: quantity,
    quantityReturnedBaseUnits: Long.ZERO,
    quantityRemainingBaseUnits: quantity,
    unitCostPaisaPerBaseUnit: Long.fromInt(3),
    mrpPaisaPerBaseUnit: Long.fromInt(8),
    status: values.status ?? derivedExpiryStatus(expiryDate, quantity, today),
    createdAt: today,
    updatedAt: today,
  };
}

test('posting purchase commits batches, receipt movements, supplier ledger, counter, and audit together', async () => {
  const { app, client, shop, manager, stock, supplierId, medicine } = await setup();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/purchases',
      headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId),
    });
    assert.equal(response.statusCode, 201, response.body);
    const result = response.json();
    assert.equal(result.purchaseNumber, 'PR-000001');
    assert.equal(result.subtotalPaisa, '202');
    assert.equal(result.discountPaisa, '2');
    assert.equal(result.totalPaisa, '200');
    assert.equal(result.paidPaisa, '0');
    assert.equal(stock.purchases.length, 1);
    assert.equal(stock.batches.length, 1);
    assert.equal(stock.batches[0]!.quantityReceivedBaseUnits.toString(), '30');
    assert.equal(stock.batches[0]!.unitCostPaisaPerBaseUnit.toString(), '10');
    assert.equal(stock.movements.length, 1);
    assert.equal(stock.movements[0]!.movementType, 'RECEIPT');
    assert.equal(stock.ledger.length, 1);
    assert.equal(stock.ledger[0]!.balanceAfterPaisa?.toString(), '200');
    assert.equal(stock.auditEvents.length, 1);
    assert.equal(stock.purchases[0]!.shopId.toHexString(), shop._id.toHexString());
  } finally {
    await app.close();
    await client.close();
  }
});

test('purchase transaction rolls back every staged write after an injected mid-transaction failure', async () => {
  const { app, client, manager, stock, supplierId, medicine } = await setup();
  try {
    stock.failNextPurchaseAt = 'afterMovements';
    const failed = await app.inject({
      method: 'POST',
      url: '/api/purchases',
      headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId),
    });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(stock.purchases, []);
    assert.deepEqual(stock.batches, []);
    assert.deepEqual(stock.movements, []);
    assert.deepEqual(stock.ledger, []);
    assert.deepEqual(stock.auditEvents, []);
    assert.equal(stock.supplierBalanceValues.get(supplierId.toHexString()), 0n);

    const successful = await app.inject({
      method: 'POST',
      url: '/api/purchases',
      headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId),
    });
    assert.equal(successful.statusCode, 201, successful.body);
    assert.equal(successful.json().purchaseNumber, 'PR-000001');
  } finally {
    await app.close();
    await client.close();
  }
});

test('purchase idempotency replays saved response and rejects the same key with changed input', async () => {
  const { app, client, manager, stock, supplierId, medicine } = await setup();
  try {
    const key = new ObjectId().toHexString();
    const payload = purchaseBody(supplierId, medicine.medicineId, medicine.unitId);
    const first = await app.inject({
      method: 'POST',
      url: '/api/purchases',
      headers: { ...headers(manager), 'idempotency-key': key },
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/purchases',
      headers: { ...headers(manager), 'idempotency-key': key },
      payload,
    });
    assert.equal(first.statusCode, 201);
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.json(), first.json());
    assert.equal(stock.purchases.length, 1);
    assert.equal(stock.batches.length, 1);

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/purchases',
      headers: { ...headers(manager), 'idempotency-key': key },
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId, { notes: 'Different input' }),
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(stock.purchases.length, 1);
  } finally {
    await app.close();
    await client.close();
  }
});

test('cashier receives no cost values in purchase or stock DTOs even with explicit read permissions', async () => {
  const { app, client, manager, cashier, stock, supplierId, medicine } = await setup();
  try {
    const posted = await app.inject({
      method: 'POST', url: '/api/purchases', headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId),
    });
    assert.equal(posted.statusCode, 201);
    const purchaseId = posted.json().id as string;

    const history = await app.inject({
      method: 'GET', url: '/api/purchases/history', headers: headers(cashier),
    });
    assert.equal(history.statusCode, 200);
    const purchaseDto = history.json().items[0] as Record<string, unknown>;
    assert.equal(Object.keys(purchaseDto).some((key) => key.toLowerCase().includes('cost')), false);
    assert.equal('totalPaisa' in purchaseDto, false);

    const detail = await app.inject({
      method: 'GET', url: `/api/purchases/${purchaseId}`, headers: headers(cashier),
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(JSON.stringify(detail.json()).toLowerCase().includes('unitcost'), false);
    assert.equal(JSON.stringify(detail.json()).toLowerCase().includes('lineTotal'), false);
    assert.equal('totalPaisa' in detail.json(), false);

    const purchaseCatalog = await app.inject({
      method: 'GET', url: '/api/purchases/catalog', headers: headers(cashier),
    });
    assert.equal(purchaseCatalog.statusCode, 200);
    assert.equal(JSON.stringify(purchaseCatalog.json()).toLowerCase().includes('lastcost'), false);

    const stockList = await app.inject({
      method: 'GET', url: '/api/stock/batches', headers: headers(cashier),
    });
    assert.equal(stockList.statusCode, 200);
    const batch = stockList.json().items[0] as Record<string, unknown>;
    assert.equal(Object.keys(batch).some((key) => key.toLowerCase().includes('cost')), false);

    const stats = await app.inject({
      method: 'GET', url: '/api/stock/overview', headers: headers(cashier),
    });
    assert.equal(stats.statusCode, 200);
    assert.equal('stockValueCostPaisa' in stats.json(), false);
    assert.equal('expiredValueAtRiskPaisa' in stats.json(), false);
    assert.equal(JSON.stringify(stats.json()).toLowerCase().includes('cost'), false);
    assert.equal(stock.purchases.length, 1);
  } finally {
    await app.close();
    await client.close();
  }
});

test('purchase and stock APIs enforce permission and cost-gated mutation policy', async () => {
  const { app, client, accountant, cashier, manager, supplierId, medicine } = await setup();
  try {
    const noStockPermission = await app.inject({
      method: 'GET', url: '/api/stock/batches', headers: headers(accountant),
    });
    assert.equal(noStockPermission.statusCode, 403);
    const cashierPost = await app.inject({
      method: 'POST', url: '/api/purchases', headers: headers(cashier),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId),
    });
    assert.equal(cashierPost.statusCode, 403);
    const posted = await app.inject({
      method: 'POST', url: '/api/purchases', headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId),
    });
    assert.equal(posted.statusCode, 201);
    const accountantHistory = await app.inject({
      method: 'GET', url: '/api/purchases/history', headers: headers(accountant),
    });
    assert.equal(accountantHistory.statusCode, 200);
    assert.equal('totalPaisa' in accountantHistory.json().items[0], true);
    const noAuth = await app.inject({ method: 'GET', url: '/api/stock/overview' });
    assert.equal(noAuth.statusCode, 401);
    const costSortDenied = await app.inject({
      method: 'GET', url: '/api/stock/batches?sort=cost_asc', headers: headers(cashier),
    });
    assert.equal(costSortDenied.statusCode, 403);
    const allowed = await app.inject({
      method: 'GET', url: '/api/stock/batches', headers: headers(manager),
    });
    assert.equal(allowed.statusCode, 200);
  } finally {
    await app.close();
    await client.close();
  }
});

test('purchase expiry, discount, and base-unit quantity rules are enforced', async () => {
  const { app, client, manager, stock, supplierId, medicine } = await setup();
  try {
    const invalidExpiry = await app.inject({
      method: 'POST', url: '/api/purchases', headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId, {
        purchaseDate: dateFromToday(120),
      }),
    });
    assert.equal(invalidExpiry.statusCode, 400);
    assert.equal(invalidExpiry.json().error, 'EXPIRY_NOT_AFTER_PURCHASE_DATE');
    const invalidDiscount = await app.inject({
      method: 'POST', url: '/api/purchases', headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId, { discountPaisa: '203' }),
    });
    assert.equal(invalidDiscount.statusCode, 400);
    assert.equal(invalidDiscount.json().error, 'DISCOUNT_EXCEEDS_SUBTOTAL');
    const invalidMoney = await app.inject({
      method: 'POST', url: '/api/purchases', headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId, { discountPaisa: 0.1 }),
    });
    assert.equal(invalidMoney.statusCode, 400);
    assert.equal(stock.purchases.length, 0);
  } finally {
    await app.close();
    await client.close();
  }
});

test('void purchase reverses supplier balance and stock only before any stock movement', async () => {
  const { app, client, admin, manager, stock, supplierId, medicine } = await setup();
  try {
    const posted = await app.inject({
      method: 'POST', url: '/api/purchases', headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId),
    });
    const purchaseId = posted.json().id as string;
    const managerVoid = await app.inject({
      method: 'POST', url: `/api/purchases/${purchaseId}/void`, headers: headers(manager),
      payload: { reason: 'Incorrect order' },
    });
    assert.equal(managerVoid.statusCode, 403);
    const voided = await app.inject({
      method: 'POST', url: `/api/purchases/${purchaseId}/void`, headers: headers(admin),
      payload: { reason: 'Incorrect order' },
    });
    assert.equal(voided.statusCode, 200, voided.body);
    assert.equal(voided.json().status, 'void');
    assert.equal(stock.batches[0]!.quantityRemainingBaseUnits.toString(), '0');
    assert.equal(stock.batches[0]!.status, 'RETURNED');
    assert.equal(stock.movements[1]!.movementType, 'PURCHASE_RETURN');
    assert.equal(stock.supplierBalanceValues.get(supplierId.toHexString()), 0n);
    assert.equal(stock.ledger.length, 2);
  } finally {
    await app.close();
    await client.close();
  }
});

test('void purchase refuses batches with any post-receipt stock movement', async () => {
  const { app, client, admin, manager, stock, supplierId, medicine } = await setup();
  try {
    const posted = await app.inject({
      method: 'POST', url: '/api/purchases', headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId),
    });
    const purchaseId = posted.json().id as string;
    await app.inject({
      method: 'POST', url: `/api/stock/batches/${stock.batches[0]!._id.toHexString()}/adjust`,
      headers: headers(manager), payload: { deltaBaseUnits: '-1', reason: 'Count correction' },
    });
    const voided = await app.inject({
      method: 'POST', url: `/api/purchases/${purchaseId}/void`,
      headers: headers(admin), payload: { reason: 'Cancel' },
    });
    assert.equal(voided.statusCode, 409);
    assert.equal(voided.json().error, 'PURCHASE_STOCK_ALREADY_CHANGED');
    assert.equal(stock.purchases[0]!.status, 'posted');
  } finally {
    await app.close();
    await client.close();
  }
});

test('adjustments reject negative stock and write-off only accepts an expired batch', async () => {
  const { app, client, manager, stock, supplierId, medicine } = await setup();
  try {
    const posted = await app.inject({
      method: 'POST', url: '/api/purchases', headers: headers(manager),
      payload: purchaseBody(supplierId, medicine.medicineId, medicine.unitId),
    });
    const batchId = stock.batches[0]!._id.toHexString();
    const negative = await app.inject({
      method: 'POST', url: `/api/stock/batches/${batchId}/adjust`, headers: headers(manager),
      payload: { deltaBaseUnits: '-31', reason: 'Count correction' },
    });
    assert.equal(negative.statusCode, 409);
    assert.equal(negative.json().error, 'INSUFFICIENT_STOCK');
    const futureWriteOff = await app.inject({
      method: 'POST', url: `/api/stock/batches/${batchId}/write-off`, headers: headers(manager),
      payload: { reason: 'expired' },
    });
    assert.equal(futureWriteOff.statusCode, 400);
    assert.equal(futureWriteOff.json().error, 'BATCH_NOT_EXPIRED');
    assert.equal(posted.statusCode, 201);
    assert.equal(stock.batches[0]!.quantityRemainingBaseUnits.toString(), '30');
  } finally {
    await app.close();
    await client.close();
  }
});

test('stock alerts summary counts sellable low and out medicines without cost fields', async () => {
  const { app, client, shop, cashier, accountant, stock, medicine } = await setup();
  try {
    stock.seedMedicine(shop._id, 'Ibuprofen', 1);
    stock.seedBatch(stockBatch(shop._id, medicine.medicineId, {
      batchNumber: 'LOW-1', daysToExpiry: 60, quantity: 3,
    }));
    const noPermission = await app.inject({
      method: 'GET', url: '/api/stock/alerts/summary', headers: headers(accountant),
    });
    assert.equal(noPermission.statusCode, 403);
    const response = await app.inject({
      method: 'GET', url: '/api/stock/alerts/summary?limit=1', headers: headers(cashier),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().lowCount, 1);
    assert.equal(response.json().outCount, 1);
    assert.equal(response.json().items.length, 1);
    assert.equal(response.json().items[0].kind, 'out');
    assert.equal(response.json().items[0].stockBaseUnits, '0');
    assert.equal(JSON.stringify(response.json()).toLowerCase().includes('cost'), false);
  } finally {
    await app.close();
    await client.close();
  }
});

test('expired write-off zeros remaining quantity and records a write-off movement', async () => {
  const { app, client, shop, manager, stock, medicine } = await setup();
  try {
    const expired = stockBatch(shop._id, medicine.medicineId, {
      batchNumber: 'EXPIRED-1', daysToExpiry: -1, quantity: 8,
    });
    stock.seedBatch(expired);
    const response = await app.inject({
      method: 'POST',
      url: `/api/stock/batches/${expired._id.toHexString()}/write-off`,
      headers: headers(manager),
      payload: { reason: 'expired' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().quantityBeforeBaseUnits, '8');
    assert.equal(response.json().quantityRemainingBaseUnits, '0');
    assert.equal(response.json().status, 'SOLD_OUT');
    assert.equal(stock.movements[0]!.movementType, 'WRITE_OFF');
    assert.equal(stock.movements[0]!.quantityDeltaBaseUnits.toString(), '-8');
    stock.movements.push({
      ...stock.movements[0]!,
      _id: new ObjectId(),
      movementType: 'RECEIPT',
    });
    const adjustments = await app.inject({
      method: 'GET',
      url: `/api/stock/adjustments?batchId=${expired._id.toHexString()}`,
      headers: headers(manager),
    });
    assert.equal(adjustments.statusCode, 200);
    assert.equal(adjustments.json().items.length, 1);
    assert.equal(adjustments.json().items[0].movementType, 'WRITE_OFF');
  } finally {
    await app.close();
    await client.close();
  }
});

test('lazy expiry status refresh uses today and a 90-day near-expiry boundary', async () => {
  const { app, client, manager, stock, shop, medicine } = await setup();
  try {
    const now = new Date();
    stock.seedBatch(stockBatch(shop._id, medicine.medicineId, {
      batchNumber: 'B-90', daysToExpiry: 90, quantity: 5, status: 'ACTIVE',
    }));
    stock.seedBatch(stockBatch(shop._id, medicine.medicineId, {
      batchNumber: 'B-91', daysToExpiry: 91, quantity: 5, status: 'NEAR_EXPIRY',
    }));
    stock.seedBatch(stockBatch(shop._id, medicine.medicineId, {
      batchNumber: 'B--1', daysToExpiry: -1, quantity: 5, status: 'ACTIVE',
    }));
    const response = await app.inject({
      method: 'GET', url: '/api/stock/expiry-buckets', headers: headers(manager),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(stock.batches.find((batch) => batch.batchNumber === 'B-90')!.status, 'NEAR_EXPIRY');
    assert.equal(stock.batches.find((batch) => batch.batchNumber === 'B-91')!.status, 'ACTIVE');
    assert.equal(stock.batches.find((batch) => batch.batchNumber === 'B--1')!.status, 'EXPIRED');
    const buckets = response.json().buckets as Array<{ key: string; count: number }>;
    assert.equal(buckets.find((bucket) => bucket.key === '0-30')!.count, 0);
    assert.equal(buckets.find((bucket) => bucket.key === '61-90')!.count, 1);
    assert.equal(buckets.find((bucket) => bucket.key === '90+')!.count, 1);
    assert.equal(buckets.find((bucket) => bucket.key === 'expired')!.count, 1);
    const todayDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    assert.equal(derivedExpiryStatus(todayDate, Long.fromInt(1), todayDate), 'NEAR_EXPIRY');
    const day91 = new Date(todayDate);
    day91.setUTCDate(day91.getUTCDate() + 91);
    assert.equal(derivedExpiryStatus(day91, Long.fromInt(1), todayDate), 'ACTIVE');
    assert.equal(derivedExpiryStatus(todayDate, Long.ZERO, todayDate), 'SOLD_OUT');
  } finally {
    await app.close();
    await client.close();
  }
});
