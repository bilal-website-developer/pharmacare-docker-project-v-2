import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import {
  deleteMasterDataName,
  loadMasterDataOverview,
  loadMasterDataUnits,
  mergeMasterDataNames,
  saveMasterDataName,
} from './masterData';

const originalFetch = globalThis.fetch;
const objectId = '507f1f77bcf86cd799439011';

function overviewResponse() {
  return {
    categories: [{
      id: objectId,
      name: 'Pain relief',
      is_active: true,
      product_count: 2,
      low_count: 1,
      out_count: 0,
      expiring_count: 1,
      stock_value_paisa: '12345',
    }],
    manufacturers: [],
    summary: {
      category_count: 1,
      active_category_count: 1,
      manufacturer_count: 0,
      active_manufacturer_count: 0,
      product_count: 2,
      unit_count: 1,
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads master data and maps integer-paisa overview and unit DTOs', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    calls.push(path);
    if (path.endsWith('/overview')) return Response.json(overviewResponse());
    return Response.json({
      items: [{
        id: objectId,
        medicine_id: '507f1f77bcf86cd799439012',
        name: 'Tablet',
        conversion_factor: 1,
        is_default_sale_unit: true,
        price_paisa: '1250',
        barcode: null,
        medicine_name: 'Medicine · Generic (MED-1)',
      }],
    });
  };

  const overview = await loadMasterDataOverview();
  const units = await loadMasterDataUnits();
  assert.deepEqual(calls, ['/api/master-data/overview', '/api/master-data/units']);
  assert.equal(overview.categories[0].stock_value_paisa, 12345);
  assert.equal(units[0].price_paisa, 1250);
  assert.equal(units[0].medicine_name, 'Medicine · Generic (MED-1)');
});

test('rejects unexpected cost fields and unsafe integer-paisa totals', async () => {
  globalThis.fetch = async () => Response.json({
    ...overviewResponse(),
    categories: [{
      ...overviewResponse().categories[0],
      latestCostPaisa: '999',
    }],
  });
  await assert.rejects(loadMasterDataOverview(), /invalid response/i);

  globalThis.fetch = async () => Response.json({
    ...overviewResponse(),
    categories: [{
      ...overviewResponse().categories[0],
      stock_value_paisa: '9007199254740992',
    }],
  });
  await assert.rejects(loadMasterDataOverview(), /invalid response/i);
});

test('saves, deletes, and merges master names through idempotent API writes', async () => {
  const calls: Array<{ path: string; method: string; body: unknown; key: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      path: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
      key: headers.get('Idempotency-Key'),
    });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (String(input).endsWith('/merge')) return Response.json({ productCount: 3 });
    return Response.json({
      id: objectId,
      name: 'Pain relief',
      isActive: true,
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
    });
  };

  await saveMasterDataName('category', null, 'Pain relief', true);
  await saveMasterDataName('category', objectId, 'Pain relief', false);
  await deleteMasterDataName('brand', objectId);
  assert.equal(await mergeMasterDataNames('brand', objectId, '507f1f77bcf86cd799439013'), 3);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'PATCH', 'DELETE', 'POST']);
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/categories',
    `/api/categories/${objectId}`,
    `/api/brands/${objectId}`,
    `/api/brands/${objectId}/merge`,
  ]);
  assert.ok(calls.every((call) => call.key !== null && /^[0-9a-f-]{36}$/i.test(call.key)));
  assert.equal(new Set(calls.map((call) => call.key)).size, calls.length);
  assert.deepEqual(calls[3].body, { targetId: '507f1f77bcf86cd799439013' });
});
