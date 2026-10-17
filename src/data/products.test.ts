import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import { loadProductCatalog, saveProduct } from './products';

const originalFetch = globalThis.fetch;
const medicineId = '507f1f77bcf86cd799439011';
const unitId = '507f1f77bcf86cd799439012';

function masterOverview() {
  return {
    categories: [{
      id: '507f1f77bcf86cd799439013',
      name: 'Pain relief',
      is_active: true,
      product_count: 1,
      low_count: 1,
      out_count: 0,
      expiring_count: 2,
      stock_value_paisa: '1250',
    }],
    manufacturers: [],
    summary: {
      category_count: 1,
      active_category_count: 1,
      manufacturer_count: 0,
      active_manufacturer_count: 0,
      product_count: 1,
      unit_count: 1,
    },
  };
}

function medicineDto() {
  return {
    id: medicineId,
    code: 'MED-1',
    name: 'Pain Relief',
    genericName: 'Analgesic',
    strength: '500mg',
    categoryId: '507f1f77bcf86cd799439013',
    brandId: '507f1f77bcf86cd799439014',
    drugClass: 'OTC',
    storageCondition: 'ROOM_TEMPERATURE',
    rackLocation: 'A-1',
    minStockAlert: 10,
    requiresPrescription: false,
    isActive: true,
    barcode: null,
    categoryName: 'Pain relief',
    brandName: 'Example Labs',
    defaultUnitName: 'Tablet',
    defaultUnitConversionFactor: 1,
    defaultUnitPricePaisa: '100',
    latestCostPaisa: '50',
    marginBasisPoints: '5000',
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads product DTOs, safe stock batches, unit prices, and server overview totals', async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('/api/medicines?')) {
      const pageSize = url.includes('pageSize=1') ? 1 : 25;
      return Response.json({ items: [medicineDto()], page: 1, pageSize, total: 1 });
    }
    if (url === '/api/master-data/overview') return Response.json(masterOverview());
    if (url === '/api/master-data/units') {
      return Response.json({
        items: [{
          id: unitId,
          medicine_id: medicineId,
          name: 'Tablet',
          conversion_factor: 1,
          is_default_sale_unit: true,
          price_paisa: '100',
          barcode: null,
          medicine_name: 'Pain Relief · Analgesic (MED-1)',
        }],
      });
    }
    if (url.startsWith('/api/stock/batches?')) {
      return Response.json({
        items: [{
          id: '507f1f77bcf86cd799439015',
          medicineId,
          medicineName: 'Pain Relief',
          genericName: 'Analgesic',
          medicineCode: 'MED-1',
          barcode: null,
          medicineIsActive: true,
          minStockAlert: 10,
          supplierId: '507f1f77bcf86cd799439016',
          supplierName: 'Supplier',
          purchaseId: '507f1f77bcf86cd799439017',
          batchNumber: 'B-1',
          expiryDate: '2026-12-31',
          receivedDate: '2026-01-01',
          quantityReceivedBaseUnits: '12',
          quantityReturnedBaseUnits: '0',
          quantityRemainingBaseUnits: '8',
          status: 'ACTIVE',
          isSellable: true,
          sellableStockBaseUnits: '8',
          mrpPaisaPerBaseUnit: '100',
        }],
        total: 1,
        page: 1,
        pageSize: 500,
      });
    }
    throw new Error(`Unexpected API request ${url}`);
  };

  const result = await loadProductCatalog({
    page: 1,
    pageSize: 25,
    search: '',
    active: 'true',
    lowStockOnly: false,
    sort: 'name',
    order: 'asc',
  });

  assert.equal(result.total, 1);
  assert.equal(result.canViewCost, true);
  assert.equal(result.rows[0]?.brand_name, 'Pain Relief');
  assert.equal(result.rows[0]?.units[0]?.price_paisa, 100);
  assert.equal(result.rows[0]?.stock, 8);
  assert.equal(result.rows[0]?.nearest_expiry, '2026-12-31');
  assert.equal(result.rows[0]?.latest_cost_paisa, 50);
  assert.equal(result.rows[0]?.margin_percent, '50.00');
  assert.equal(result.stats.low_stock, 1);
  assert.equal(result.stats.stock_value_cost_paisa, '1250');
});

test('creates medicines through the API with integer-paisa units and idempotent writes', async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const idempotencyKeys: Array<string | null> = [];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    idempotencyKeys.push(new Headers(init?.headers).get('Idempotency-Key'));
    return Response.json({ id: medicineId });
  };

  await saveProduct({
    id: null,
    code: 'MED-1',
    barcode: null,
    name: 'Pain Relief',
    genericName: 'Analgesic',
    strength: null,
    categoryId: '507f1f77bcf86cd799439013',
    brandId: '507f1f77bcf86cd799439014',
    drugClass: 'OTC',
    storageCondition: 'ROOM_TEMPERATURE',
    rackLocation: '',
    minStockAlert: 0,
    requiresPrescription: false,
    isActive: true,
    units: [{
      name: 'Tablet',
      conversionFactorBaseUnits: 1,
      isDefaultSaleUnit: true,
      pricePaisa: 1250,
      barcode: null,
    }],
    existingUnitIds: [],
  });

  assert.match(idempotencyKeys[0] ?? '', /^[0-9a-f-]{36}$/i);
  const requestBody = requestBodies[0];
  assert.equal(requestBody?.barcode, null);
  const units = requestBody?.units as Array<Record<string, unknown>>;
  assert.equal(units[0]?.pricePaisa, '1250');
  assert.equal(units[0]?.barcode, null);
});

test('rejects unexpected fields in the product API DTO', async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('/api/medicines?')) {
      return Response.json({
        items: [{ ...medicineDto(), secretCostPaisa: '900' }],
        page: 1,
        pageSize: url.includes('pageSize=1') ? 1 : 25,
        total: 1,
      });
    }
    if (url === '/api/master-data/overview') return Response.json(masterOverview());
    if (url === '/api/master-data/units') return Response.json({ items: [] });
    throw new Error(`Unexpected API request ${url}`);
  };

  await assert.rejects(loadProductCatalog({
    page: 1,
    pageSize: 25,
    search: '',
    active: 'true',
    lowStockOnly: false,
    sort: 'name',
    order: 'asc',
  }), /invalid response/i);
});
