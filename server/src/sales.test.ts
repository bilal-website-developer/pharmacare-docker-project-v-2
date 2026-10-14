import assert from 'node:assert/strict';
import test from 'node:test';
import { Long, MongoClient, ObjectId } from 'mongodb';
import { createAccessToken } from './auth-crypto.js';
import { createApp } from './app.js';
import { MemoryIdempotencyStore } from './test-support/memory-idempotency-store.js';
import { MemoryRepository } from './test-support/memory-repository.js';
import { MemorySalesRepository } from './test-support/memory-sales-repository.js';
import { testConfig } from './test-support/test-config.js';
import type { UserRecord } from './models.js';

function token(user: UserRecord): string {
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

function requestHeaders(user: UserRecord, key = new ObjectId().toHexString()) {
  return {
    authorization: `Bearer ${token(user)}`,
    'idempotency-key': key,
  };
}

async function setup() {
  const auth = new MemoryRepository();
  const shop = auth.addShop();
  shop.timeZone = 'Asia/Karachi';
  const cashier = auth.addUser(shop, {
    username: 'cashier',
    email: 'cashier@example.test',
    fullName: 'Test Cashier',
    role: 'cashier',
    permissions: ['pos', 'customers', 'sales_history'],
  });
  const manager = auth.addUser(shop, {
    username: 'manager',
    email: 'manager@example.test',
    fullName: 'Test Manager',
    role: 'manager',
    permissions: ['pos', 'customers', 'sales_history'],
  });
  const admin = auth.addUser(shop, {
    username: 'admin',
    email: 'admin@example.test',
    fullName: 'Test Admin',
    role: 'admin',
    permissions: [],
  });
  const accountant = auth.addUser(shop, {
    username: 'accountant',
    email: 'accountant@example.test',
    fullName: 'Test Accountant',
    role: 'accountant',
    permissions: ['pos', 'sales_history', 'customers'],
  });
  const sales = new MemorySalesRepository();
  const client = new MongoClient('mongodb://127.0.0.1:1');
  const app = createApp(
    client,
    testConfig,
    auth,
    undefined,
    undefined,
    new MemoryIdempotencyStore(),
    sales,
  );
  await app.ready();
  return { app, client, auth, shop, cashier, manager, admin, accountant, sales };
}

function seedSaleStock(
  sales: MemorySalesRepository,
  shopId: ObjectId,
  medicineValues: Record<string, unknown> = {},
  quantities: number[] = [10],
  unitPrice = 1000,
) {
  const medicine = sales.seedMedicine(shopId, medicineValues);
  sales.units[0]!.pricePaisa = Long.fromNumber(unitPrice);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const expiry = new Date(today);
  expiry.setUTCDate(expiry.getUTCDate() + 365);
  const batches = quantities.map((quantity, index) => sales.seedBatch(shopId, medicine.medicineId, {
    quantity,
    expiryDate: new Date(expiry.getTime() + index * 86_400_000),
    daysReceivedAgo: quantities.length - index,
  }));
  return { ...medicine, batches };
}

function salePayload(
  medicineId: ObjectId,
  unitId: ObjectId,
  quantity: number,
  totalPaisa: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    items: [{ medicineId: medicineId.toHexString(), unitId: unitId.toHexString(), quantityInUnit: quantity }],
    discountPaisa: '0',
    payments: [{ method: 'CASH', amountPaisa: String(totalPaisa) }],
    amountTenderedPaisa: String(totalPaisa),
    ...overrides,
  };
}

async function close(app: Awaited<ReturnType<typeof setup>>['app'], client: MongoClient) {
  await app.close();
  await client.close();
}

test('sale FEFO-allocates batches and persists split payment methods as separate payment records', async () => {
  const context = await setup();
  try {
    const fixture = seedSaleStock(context.sales, context.shop._id, {}, [1, 2], 1000);
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/sales',
      headers: requestHeaders(context.cashier),
      payload: salePayload(fixture.medicineId, fixture.unitId, 2, 1800, {
        discountPaisa: '200',
        payments: [
          { method: 'CASH', amountPaisa: '1000' },
          { method: 'CARD', amountPaisa: '800' },
        ],
      }),
    });
    assert.equal(response.statusCode, 201, response.body);
    const sale = response.json();
    assert.equal(sale.subtotalPaisa, '2000');
    assert.equal(sale.discountPaisa, '200');
    assert.equal(sale.totalPaisa, '1800');
    assert.equal(sale.paymentMethod, 'SPLIT');
    assert.equal(sale.items[0].batchAllocations.length, 2);
    assert.equal(sale.items[0].batchAllocations[0].batchId, fixture.batches[0]!.toHexString());
    assert.equal(context.sales.paymentRecords.length, 2);
    assert.deepEqual(context.sales.paymentRecords.map((payment) => payment.method), ['CASH', 'CARD']);
    assert.equal(context.sales.movementRecords.length, 2);
    assert.equal(JSON.stringify(sale).includes('cost'), false);
    assert.equal(JSON.stringify(sale).includes('profit'), false);
  } finally {
    await close(context.app, context.client);
  }
});

test('concurrent sales competing for the last unit allow exactly one sale', async () => {
  const context = await setup();
  try {
    const fixture = seedSaleStock(context.sales, context.shop._id, {}, [1], 1000);
    const payload = salePayload(fixture.medicineId, fixture.unitId, 1, 1000);
    const responses = await Promise.all([1, 2].map(() => context.app.inject({
      method: 'POST',
      url: '/api/sales',
      headers: requestHeaders(context.cashier),
      payload,
    })));
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
    assert.equal((await context.sales.listSales(context.shop._id, {
      page: 1, pageSize: 20,
    })).total, 1);
    assert.equal(String(context.sales.batches[0]!.quantityRemainingBaseUnits), '0');
    assert.equal(context.sales.movementRecords.length, 1);
  } finally {
    await close(context.app, context.client);
  }
});

test('discount cap is enforced per role using the minimum of percent cap, Rs 200, and bill amount', async () => {
  const context = await setup();
  try {
    const fixture = seedSaleStock(context.sales, context.shop._id, {}, [500], 1000);
    const cases: Array<{ user: UserRecord; cap: number }> = [
      { user: context.cashier, cap: 5000 },
      { user: context.manager, cap: 7500 },
      { user: context.admin, cap: 15_000 },
      { user: context.accountant, cap: 0 },
    ];
    for (const { user, cap } of cases) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/sales',
        headers: requestHeaders(user),
        payload: salePayload(fixture.medicineId, fixture.unitId, 50, 50_000 - cap - 1, {
          discountPaisa: String(cap + 1),
          payments: [{ method: 'CASH', amountPaisa: String(50_000 - cap - 1) }],
        }),
      });
      assert.equal(response.statusCode, 400, `${user.role}: ${response.body}`);
      assert.equal(response.json<{ error: string }>().error, 'DISCOUNT_EXCEEDS_ROLE_LIMIT');
    }
    const cappedByFlatMaximum = await context.app.inject({
      method: 'POST',
      url: '/api/sales',
      headers: requestHeaders(context.admin),
      payload: salePayload(fixture.medicineId, fixture.unitId, 100, 80_000, {
        discountPaisa: '20000',
        payments: [{ method: 'CASH', amountPaisa: '80000' }],
      }),
    });
    assert.equal(cappedByFlatMaximum.statusCode, 201, cappedByFlatMaximum.body);
    assert.equal(cappedByFlatMaximum.json<{ totalPaisa: string }>().totalPaisa, '80000');
  } finally {
    await close(context.app, context.client);
  }
});

test('client-supplied totals and prices are rejected and cannot affect server calculations', async () => {
  const context = await setup();
  try {
    const fixture = seedSaleStock(context.sales, context.shop._id);
    const payload = salePayload(fixture.medicineId, fixture.unitId, 1, 1, {
      totalPaisa: '1',
      items: [{
        medicineId: fixture.medicineId.toHexString(),
        unitId: fixture.unitId.toHexString(),
        quantityInUnit: 1,
        pricePaisa: '1',
      }],
    });
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/sales',
      headers: requestHeaders(context.cashier),
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal((await context.sales.listSales(context.shop._id, { page: 1, pageSize: 10 })).total, 0);
    assert.equal(String(context.sales.batches[0]!.quantityRemainingBaseUnits), '10');
  } finally {
    await close(context.app, context.client);
  }
});

test('sale failure midway rolls back stock, movements, payments, sale, ledger, and audit state', async () => {
  const context = await setup();
  try {
    const fixture = seedSaleStock(context.sales, context.shop._id);
    context.sales.failNextSaleAt = 'afterStockDecrement';
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/sales',
      headers: requestHeaders(context.cashier),
      payload: salePayload(fixture.medicineId, fixture.unitId, 1, 1000),
    });
    assert.equal(response.statusCode, 500);
    assert.equal((await context.sales.listSales(context.shop._id, { page: 1, pageSize: 10 })).total, 0);
    assert.equal(String(context.sales.batches[0]!.quantityRemainingBaseUnits), '10');
    assert.equal(context.sales.movementRecords.length, 0);
    assert.equal(context.sales.paymentRecords.length, 0);
    assert.equal(context.sales.auditEvents.length, 0);
  } finally {
    await close(context.app, context.client);
  }
});

test('controlled and prescription-required medicines require prescriber, patient, and reference', async () => {
  const context = await setup();
  try {
    const fixture = seedSaleStock(context.sales, context.shop._id, {
      drugClass: 'CONTROLLED',
      requiresPrescription: false,
    });
    const payload = salePayload(fixture.medicineId, fixture.unitId, 1, 1000);
    const denied = await context.app.inject({
      method: 'POST',
      url: '/api/sales',
      headers: requestHeaders(context.cashier),
      payload,
    });
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.json<{ error: string }>().error, 'PRESCRIPTION_REQUIRED');
    assert.equal(String(context.sales.batches[0]!.quantityRemainingBaseUnits), '10');
    const allowed = await context.app.inject({
      method: 'POST',
      url: '/api/sales',
      headers: requestHeaders(context.cashier),
      payload: {
        ...payload,
        items: [{
          ...payload.items[0],
          prescription: { prescriber: 'Dr Example', patient: 'Patient Example', reference: 'RX-123' },
        }],
      },
    });
    assert.equal(allowed.statusCode, 201, allowed.body);
    assert.equal(allowed.json<{ items: Array<{ prescription: { reference: string } }> }>().items[0]!.prescription.reference, 'RX-123');
  } finally {
    await close(context.app, context.client);
  }
});

test('customer CRUD, credit ledger, customer payment, and cashier history scope work by shop and actor', async () => {
  const context = await setup();
  try {
    const customerResponse = await context.app.inject({
      method: 'POST',
      url: '/api/customers',
      headers: requestHeaders(context.manager),
      payload: { name: 'Khata Customer', creditLimitPaisa: '10000' },
    });
    assert.equal(customerResponse.statusCode, 201, customerResponse.body);
    const customer = customerResponse.json();
    const fixture = seedSaleStock(context.sales, context.shop._id);
    const creditSale = await context.app.inject({
      method: 'POST',
      url: '/api/sales',
      headers: requestHeaders(context.cashier),
      payload: salePayload(fixture.medicineId, fixture.unitId, 1, 1000, {
        customerId: customer.id,
        payments: [{ method: 'CREDIT', amountPaisa: '1000' }],
        amountTenderedPaisa: '0',
      }),
    });
    assert.equal(creditSale.statusCode, 201, creditSale.body);
    const pay = await context.app.inject({
      method: 'POST',
      url: `/api/customers/${customer.id}/payments`,
      headers: requestHeaders(context.manager),
      payload: { amountPaisa: '1000', method: 'CASH', note: 'received' },
    });
    assert.equal(pay.statusCode, 200, pay.body);
    assert.equal(pay.json<{ balanceAfterPaisa: string }>().balanceAfterPaisa, '0');
    assert.match(pay.json<{ referenceNo: string }>().referenceNo, /^RCP-/);
    const summary = await context.app.inject({
      method: 'GET',
      url: '/api/customers/accounts/summary',
      headers: requestHeaders(context.manager),
    });
    assert.equal(summary.statusCode, 200);
    assert.deepEqual(
      summary.json<{ ledgerEntries: Array<{ type: string }> }>().ledgerEntries.map((entry) => entry.type),
      ['PAYMENT', 'INVOICE'],
    );
    const history = await context.app.inject({
      method: 'GET',
      url: '/api/sales/history',
      headers: requestHeaders(context.cashier),
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json<{ items: unknown[] }>().items.length, 1);
    assert.equal(JSON.stringify(history.json()).includes('cost'), false);
    assert.equal(JSON.stringify(history.json()).includes('profit'), false);
    const updated = await context.app.inject({
      method: 'PATCH',
      url: `/api/customers/${customer.id}`,
      headers: requestHeaders(context.manager),
      payload: { phone: '03000000000' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json<{ phone: string }>().phone, '03000000000');
    const cannotDelete = await context.app.inject({
      method: 'DELETE',
      url: `/api/customers/${customer.id}`,
      headers: requestHeaders(context.manager),
    });
    assert.equal(cannotDelete.statusCode, 200);
  } finally {
    await close(context.app, context.client);
  }
});
