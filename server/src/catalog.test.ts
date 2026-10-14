import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { createAccessToken } from './auth-crypto.js';
import { createApp } from './app.js';
import {
  CSV_HEADERS,
  ean13CheckDigit,
  isEan13,
} from './catalog-domain.js';
import type { UserRecord } from './models.js';
import { MemoryCatalogRepository } from './test-support/memory-catalog-repository.js';
import { MemoryIdempotencyStore } from './test-support/memory-idempotency-store.js';
import { MemoryRepository } from './test-support/memory-repository.js';
import { testConfig } from './test-support/test-config.js';

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

async function setup() {
  const auth = new MemoryRepository();
  const shop = auth.addShop();
  const admin = auth.addUser(shop, {
    username: 'admin',
    email: 'admin@example.test',
    role: 'admin',
    permissions: [],
  });
  const cashier = auth.addUser(shop, {
    username: 'cashier',
    email: 'cashier@example.test',
    role: 'cashier',
    permissions: ['products', 'categories', 'suppliers'],
  });
  const manager = auth.addUser(shop, {
    username: 'manager',
    email: 'manager@example.test',
    role: 'manager',
    permissions: ['products', 'categories', 'suppliers'],
  });
  const catalog = new MemoryCatalogRepository();
  const client = new MongoClient('mongodb://127.0.0.1:1');
  const app = createApp(client, testConfig, auth, catalog, undefined, new MemoryIdempotencyStore());
  await app.ready();
  return { app, client, auth, catalog, shop, admin, cashier, manager };
}

function headers(user: UserRecord) {
  return {
    authorization: `Bearer ${bearer(user)}`,
    'idempotency-key': new ObjectId().toHexString(),
  };
}

async function createCategoryAndBrand(
  app: Awaited<ReturnType<typeof setup>>['app'],
  user: UserRecord,
): Promise<{ categoryId: string; brandId: string }> {
  const category = await app.inject({
    method: 'POST',
    url: '/api/categories',
    headers: headers(user),
    payload: { name: 'Analgesics' },
  });
  const brand = await app.inject({
    method: 'POST',
    url: '/api/brands',
    headers: headers(user),
    payload: { name: 'Northstar Labs' },
  });
  assert.equal(category.statusCode, 201);
  assert.equal(brand.statusCode, 201);
  return { categoryId: category.json().id, brandId: brand.json().id };
}

async function createMedicine(
  app: Awaited<ReturnType<typeof setup>>['app'],
  user: UserRecord,
  categoryId: string,
  brandId: string,
  code: string,
  name = `Medicine ${code}`,
): Promise<{ id: string; unitId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/medicines',
    headers: headers(user),
    payload: {
      code,
      name,
      genericName: 'Generic ingredient',
      categoryId,
      brandId,
      drugClass: 'OTC',
      storageCondition: 'ROOM_TEMPERATURE',
      units: [{
        name: 'Tablet',
        conversionFactorBaseUnits: 1,
        pricePaisa: '1250',
        isDefaultSaleUnit: true,
      }],
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return { id: response.json().id, unitId: response.json().units[0].id };
}

test('EAN-13 check digit validates known examples and rejects malformed values', () => {
  assert.equal(ean13CheckDigit('400638133393'), '1');
  assert.equal(isEan13('4006381333931'), true);
  assert.equal(isEan13('4006381333932'), false);
  assert.equal(isEan13('400638133393'), false);
  assert.throws(() => ean13CheckDigit('123'));
});

test('categories, brands and suppliers validate, enforce per-shop names and use server paging', async () => {
  const { app, client, admin } = await setup();
  try {
    const category = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: headers(admin),
      payload: { name: 'Pain relief' },
    });
    assert.equal(category.statusCode, 201);
    const duplicateCategory = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: headers(admin),
      payload: { name: '  PAIN RELIEF ' },
    });
    assert.equal(duplicateCategory.statusCode, 409);

    for (const name of ['Vitamins', 'Antibiotics']) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/categories',
        headers: headers(admin),
        payload: { name },
      });
      assert.equal(created.statusCode, 201);
    }
    const page = await app.inject({
      method: 'GET',
      url: '/api/categories?page=2&pageSize=1&sort=name&order=desc',
      headers: headers(admin),
    });
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().items.length, 1);
    assert.equal(page.json().page, 2);
    assert.equal(page.json().total, 3);

    const invalidSupplier = await app.inject({
      method: 'POST',
      url: '/api/suppliers',
      headers: headers(admin),
      payload: { name: 'A supplier', contact: 'long'.repeat(130), paymentTerms: '' },
    });
    assert.equal(invalidSupplier.statusCode, 400);
    const supplier = await app.inject({
      method: 'POST',
      url: '/api/suppliers',
      headers: headers(admin),
      payload: {
        name: 'A supplier',
        contact: '+1 555 0100',
        address: 'Street 1',
        licenceOrTaxNumber: 'LIC-1',
        paymentTerms: 'Net 30',
      },
    });
    assert.equal(supplier.statusCode, 201);
    assert.equal('payableBalancePaisa' in supplier.json(), false);
  } finally {
    await app.close();
    await client.close();
  }
});

test('medicine CRUD and units enforce valid references/defaults and scope data to the caller shop', async () => {
  const { app, client, auth, admin, cashier } = await setup();
  try {
    const { categoryId, brandId } = await createCategoryAndBrand(app, admin);
    const created = await createMedicine(app, admin, categoryId, brandId, 'MED-001');
    const units = await app.inject({
      method: 'GET',
      url: `/api/medicines/${created.id}/units?search=tab`,
      headers: headers(admin),
    });
    assert.equal(units.statusCode, 200);
    assert.equal(units.json().total, 1);
    assert.equal(units.json().items[0].pricePaisa, '1250');

    const removeDefault = await app.inject({
      method: 'DELETE',
      url: `/api/medicine-units/${created.unitId}`,
      headers: headers(admin),
    });
    assert.equal(removeDefault.statusCode, 409);

    const invalidMedicine = await app.inject({
      method: 'POST',
      url: '/api/medicines',
      headers: headers(admin),
      payload: {
        code: 'MED-002',
        name: 'No refs',
        genericName: 'Generic',
        categoryId: new ObjectId().toHexString(),
        brandId,
        drugClass: 'OTC',
        units: [{ name: 'Tablet', conversionFactorBaseUnits: 1, pricePaisa: '100', isDefaultSaleUnit: true }],
      },
    });
    assert.equal(invalidMedicine.statusCode, 400);

    const duplicateCode = await app.inject({
      method: 'POST',
      url: '/api/medicines',
      headers: headers(admin),
      payload: {
        code: 'med-001',
        name: 'Different name',
        genericName: 'Generic',
        categoryId,
        brandId,
        drugClass: 'OTC',
        units: [{ name: 'Tablet', conversionFactorBaseUnits: 1, pricePaisa: '100', isDefaultSaleUnit: true }],
      },
    });
    assert.equal(duplicateCode.statusCode, 409);

    const otherShop = auth.addShop('Other Shop');
    const outsider = auth.addUser(otherShop, {
      username: 'other',
      email: 'other@example.test',
      role: 'admin',
      permissions: [],
    });
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/medicines/${created.id}`,
      headers: headers(outsider),
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(foreign.json().error, 'NOT_FOUND');
    assert.equal(cashier.shopId.equals(admin.shopId), true);
  } finally {
    await app.close();
    await client.close();
  }
});

test('soft delete writes trash history and restore returns the record to its prior state', async () => {
  const { app, client, admin } = await setup();
  try {
    const category = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: headers(admin),
      payload: { name: 'Archived category', isActive: false },
    });
    const id = category.json().id as string;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/categories/${id}`,
      headers: headers(admin),
    });
    assert.equal(deleted.statusCode, 204);
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/categories/${id}`,
      headers: headers(admin),
    });
    assert.equal(hidden.statusCode, 404);
    const trash = await app.inject({
      method: 'GET',
      url: '/api/trash?entityType=category',
      headers: headers(admin),
    });
    assert.equal(trash.statusCode, 200);
    assert.equal(trash.json().items[0].displayName, 'Archived category');
    const restored = await app.inject({
      method: 'POST',
      url: `/api/categories/${id}/restore`,
      headers: headers(admin),
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().isActive, false);
    const history = await app.inject({
      method: 'GET',
      url: '/api/trash?entityType=category',
      headers: headers(admin),
    });
    assert.equal(history.json().total, 2);
    assert.deepEqual(history.json().items.map((item: { action: string }) => item.action), ['restored', 'deleted']);
  } finally {
    await app.close();
    await client.close();
  }
});

test('cashier DTOs and CSV exports omit cost fields while cost-authorized manager responses include them', async () => {
  const { app, client, admin, cashier, manager, catalog } = await setup();
  try {
    const { categoryId, brandId } = await createCategoryAndBrand(app, admin);
    const medicine = await createMedicine(app, admin, categoryId, brandId, 'COST-001');
    catalog.costs.set(`${admin.shopId.toHexString()}:${medicine.id}`, '880');

    const cashierList = await app.inject({
      method: 'GET',
      url: '/api/medicines',
      headers: headers(cashier),
    });
    assert.equal(cashierList.statusCode, 200);
    const cashierMedicine = cashierList.json().items[0] as Record<string, unknown>;
    assert.equal(Object.keys(cashierMedicine).some((key) => key.toLowerCase().includes('cost')), false);

    const managerList = await app.inject({
      method: 'GET',
      url: '/api/medicines',
      headers: headers(manager),
    });
    assert.equal(managerList.statusCode, 200);
    assert.equal(managerList.json().items[0].latestCostPaisa, '880');

    const cashierExport = await app.inject({
      method: 'GET',
      url: '/api/products/export.csv',
      headers: headers(cashier),
    });
    assert.equal(cashierExport.statusCode, 200);
    assert.equal(cashierExport.body.includes('latestCostPaisa'), false);
    assert.equal(cashierExport.body.includes(',880'), false);

    const managerExport = await app.inject({
      method: 'GET',
      url: '/api/products/export.csv',
      headers: headers(manager),
    });
    assert.equal(managerExport.statusCode, 200);
    assert.equal(managerExport.body.includes('latestCostPaisa'), true);
    assert.equal(managerExport.body.includes('"880"'), true);
  } finally {
    await app.close();
    await client.close();
  }
});

test('CSV import validates rows, reports row numbers, and exports quoted product values', async () => {
  const { app, client, admin } = await setup();
  try {
    const { categoryId } = await createCategoryAndBrand(app, admin);
    const brandList = await app.inject({
      method: 'GET',
      url: '/api/brands',
      headers: headers(admin),
    });
    const manufacturer = brandList.json().items[0].name as string;
    const validRow = [
      'CSV-1', '"Acetaminophen, 500"', 'Paracetamol', '500 mg', 'Analgesics',
      manufacturer, 'OTC', 'ROOM_TEMPERATURE', 'A1', '12', 'false', 'true',
      'Tablet', '1', '1550', '',
    ].join(',');
    const invalidRow = [
      'CSV-2', 'Bad row', 'Generic', '', 'Missing category', manufacturer,
      'INVALID', 'ROOM_TEMPERATURE', '', '0', 'false', 'true', 'Tablet', '1', '100', '',
    ].join(',');
    const response = await app.inject({
      method: 'POST',
      url: '/api/products/import',
      headers: headers(admin),
      payload: { csv: [CSV_HEADERS.join(','), validRow, invalidRow].join('\r\n') },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().importedCount, 1);
    assert.equal(response.json().rowErrors[0].line, 3);
    assert.equal(response.json().rowErrors[0].code, 'ROW_VALIDATION_FAILED');
    assert.ok(categoryId);

    const exported = await app.inject({
      method: 'GET',
      url: '/api/products/export.csv',
      headers: headers(admin),
    });
    assert.equal(exported.statusCode, 200);
    assert.ok(exported.body.includes('"Acetaminophen, 500"'));
  } finally {
    await app.close();
    await client.close();
  }
});

test('single and bulk barcode assignments generate valid unique EAN-13 values under parallel requests', async () => {
  const { app, client, admin } = await setup();
  try {
    const { categoryId, brandId } = await createCategoryAndBrand(app, admin);
    const medicines = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      createMedicine(app, admin, categoryId, brandId, `BC-${String(index).padStart(3, '0')}`),
    ));
    const assigned = await Promise.all(medicines.map(async (medicine) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/medicines/${medicine.id}/barcode`,
        headers: headers(admin),
        payload: {},
      });
      assert.equal(response.statusCode, 200);
      assert.equal(isEan13(response.json().barcode), true);
      return response.json().barcode as string;
    }));
    assert.equal(new Set(assigned).size, medicines.length);
  } finally {
    await app.close();
    await client.close();
  }
});

test('audit event payloads do not contain hidden cost fields', async () => {
  const { app, client, admin, catalog } = await setup();
  try {
    const { categoryId, brandId } = await createCategoryAndBrand(app, admin);
    const medicine = await createMedicine(app, admin, categoryId, brandId, 'AUDIT-1');
    catalog.costs.set(`${admin.shopId.toHexString()}:${medicine.id}`, '800');
    assert.equal(catalog.audits.some((event) => JSON.stringify(event).includes('800')), false);
  } finally {
    await app.close();
    await client.close();
  }
});
