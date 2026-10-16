import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import {
  loadPurchaseCatalog,
  loadPurchaseDetail,
  loadPurchaseExport,
  loadPurchaseHistory,
  postPurchase,
  voidPurchase,
} from './purchases';

const originalFetch = globalThis.fetch;
const purchaseId = '507f1f77bcf86cd799439011';
const supplierId = '507f1f77bcf86cd799439012';
const medicineId = '507f1f77bcf86cd799439013';
const unitId = '507f1f77bcf86cd799439014';
const batchId = '507f1f77bcf86cd799439015';
const itemId = '507f1f77bcf86cd799439016';

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

function purchaseDto(overrides: Record<string, unknown> = {}) {
  return {
    id: purchaseId,
    purchaseNumber: 'PR-000123',
    supplierId,
    supplierName: 'Test Supplier',
    invoiceNumber: 'INV-1',
    purchaseDate: '2026-10-17',
    status: 'posted',
    paymentType: 'cash',
    itemCount: 1,
    subtotalPaisa: '1000',
    discountPaisa: '0',
    totalPaisa: '1000',
    paidPaisa: '1000',
    createdByName: 'Test Manager',
    createdAt: '2026-10-17T10:00:00.000Z',
    notes: 'stock receipt',
    items: [{
      id: itemId,
      medicineId,
      medicineName: 'Test Medicine',
      medicineCode: 'MED-1',
      unitId,
      unitName: 'Box',
      conversionFactorBaseUnits: 10,
      quantity: 2,
      bonusQuantityBaseUnits: '10',
      quantityReceivedBaseUnits: '30',
      batchId,
      batchNumber: 'B-1',
      expiryDate: '2027-10-17',
      unitCostPaisa: '500',
      mrpPaisa: '900',
      lineTotalPaisa: '1000',
    }],
    ...overrides,
  };
}

test('purchase catalog maps shop-scoped products and safe cost fields', async () => {
  globalThis.fetch = async () => Response.json({
    today: '2026-10-17',
    items: [{
      id: medicineId,
      code: 'MED-1',
      barcode: null,
      name: 'Test Medicine',
      genericName: 'Generic',
      manufacturer: 'Company',
      stockBaseUnits: '35',
      lastCostPaisaPerBaseUnit: '50',
      units: [{
        id: unitId,
        name: 'Box',
        conversionFactorBaseUnits: 10,
        isDefaultSaleUnit: true,
        pricePaisa: '900',
      }],
    }],
    suppliers: [{ id: supplierId, name: 'Test Supplier', contact: '555' }],
  });

  const catalog = await loadPurchaseCatalog();
  assert.equal(catalog.today, '2026-10-17');
  assert.equal(catalog.products[0]?.stock, 35);
  assert.equal(catalog.products[0]?.last_cost_base_paisa, 50);
  assert.equal(catalog.products[0]?.units[0]?.conversion_factor, 10);
  assert.deepEqual(catalog.suppliers, [{ id: supplierId, name: 'Test Supplier' }]);
});

test('purchase history uses the API filters and maps summary and no-cost DTOs', async () => {
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json({
      items: [{
        id: purchaseId,
        purchaseNumber: 'PR-000123',
        supplierId,
        supplierName: 'Test Supplier',
        invoiceNumber: 'INV-1',
        purchaseDate: '2026-10-17',
        status: 'posted',
        paymentType: 'credit',
        itemCount: 1,
        createdByName: 'Test Manager',
        createdAt: '2026-10-17T10:00:00.000Z',
      }],
      total: 1,
      page: 2,
      pageSize: 25,
    });
  };

  const result = await loadPurchaseHistory({
    search: 'PR-000',
    paymentType: 'credit',
    dateFrom: '2026-10-01',
    dateTo: '2026-10-31',
    page: 2,
    pageSize: 25,
  });
  assert.match(requestedUrl, /search=PR-000/);
  assert.match(requestedUrl, /paymentType=credit/);
  assert.equal(result.rows[0]?.created_by, 'Test Manager');
  assert.equal(result.rows[0]?.total_paisa, undefined);
  assert.equal(result.costVisible, false);
});

test('purchase posting sends integer-paisa values and uses the shared idempotent client', async () => {
  let body: unknown;
  let idempotencyKey: string | null = null;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as unknown;
    idempotencyKey = new Headers(init?.headers).get('Idempotency-Key');
    return Response.json(purchaseDto(), { status: 201 });
  };

  const result = await postPurchase({
    supplierId,
    invoiceNumber: 'INV-1',
    purchaseDate: '2026-10-17',
    paymentType: 'cash',
    discountPaisa: '0',
    notes: 'stock receipt',
    items: [{
      medicineId,
      unitId,
      batchNumber: 'B-1',
      expiryDate: '2027-10-17',
      quantity: 2,
      bonusQuantity: 1,
      unitCostPaisa: '500',
      mrpPaisa: '900',
    }],
  });

  assert.equal(result.id, purchaseId);
  assert.equal(result.total_paisa, 1000);
  assert.ok(idempotencyKey);
  assert.deepEqual(body, {
    supplierId,
    invoiceNumber: 'INV-1',
    purchaseDate: '2026-10-17',
    paymentType: 'cash',
    discountPaisa: '0',
    notes: 'stock receipt',
    items: [{
      medicineId,
      unitId,
      batchNumber: 'B-1',
      expiryDate: '2027-10-17',
      quantity: 2,
      bonusQuantity: 1,
      unitCostPaisa: '500',
      mrpPaisa: '900',
    }],
  });
});

test('purchase detail, export and void map API results and preserve shop-safe DTO validation', async () => {
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    paths.push(path);
    if (path.includes('/export')) return Response.json({ items: [purchaseDto()] });
    return Response.json(path.endsWith('/void')
      ? purchaseDto({ status: 'void', voidReason: 'damaged', voidedAt: '2026-10-17T11:00:00.000Z' })
      : purchaseDto());
  };

  const detail = await loadPurchaseDetail(purchaseId);
  const exported = await loadPurchaseExport({ search: 'PR-000123' });
  const voided = await voidPurchase(purchaseId, 'damaged');
  assert.equal(detail.items[0]?.bonus_qty, 1);
  assert.equal(detail.due_paisa, 0);
  assert.equal(exported[0]?.items[0]?.unit_cost_paisa, 500);
  assert.equal(voided.status, 'void');
  assert.deepEqual(paths, [
    `/api/purchases/${purchaseId}`,
    '/api/purchases/export?search=PR-000123',
    `/api/purchases/${purchaseId}/void`,
  ]);
});

test('purchase DTO parser rejects cost fields outside the server allowlist', async () => {
  globalThis.fetch = async () => Response.json(purchaseDto({ privateCostMargin: 'must-not-be-returned' }));
  await assert.rejects(loadPurchaseDetail(purchaseId), /invalid response/i);
});
