import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import { deactivateSupplier, listSuppliers, saveSupplier } from './suppliers';

const originalFetch = globalThis.fetch;

function supplier(id: string) {
  return {
    id,
    name: `Supplier ${id}`,
    contact: '',
    address: '',
    licenceOrTaxNumber: '',
    paymentTerms: 'CASH',
    isActive: true,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads all supplier pages and maps API DTO fields to the current UI model', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const page = url.includes('page=2') ? 2 : 1;
    return Response.json({
      items: [supplier(`page-${page}`)],
      page,
      pageSize: 1,
      total: 2,
    });
  };

  const result = await listSuppliers();

  assert.equal(calls.length, 2);
  assert.match(calls[0], /active=all/);
  assert.deepEqual(result.map((item) => item.id), ['page-1', 'page-2']);
  assert.equal(result[0].licence_or_tax_number, '');
  assert.equal(result[0].payment_terms, 'CASH');
  assert.equal(result[0].is_active, true);
});

test('creates, edits, and deactivates suppliers with idempotent API writes', async () => {
  const calls: Array<{ url: string; method: string; key: string | null; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      key: headers.get('Idempotency-Key'),
      body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
    });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json(supplier('supplier-1'));
  };
  const values = {
    name: 'Supplier 1',
    contact: '03000000000',
    address: 'Main Road',
    licence_or_tax_number: 'LIC-1',
    payment_terms: '7 days',
  };

  await saveSupplier(null, values);
  await saveSupplier('supplier-1', values);
  await deactivateSupplier('supplier-1');

  assert.deepEqual(calls.map(({ method }) => method), ['POST', 'PATCH', 'PATCH']);
  assert.deepEqual(calls.map(({ url }) => url), [
    '/api/suppliers',
    '/api/suppliers/supplier-1',
    '/api/suppliers/supplier-1',
  ]);
  assert.equal(calls[0].body && (calls[0].body as Record<string, unknown>).licenceOrTaxNumber, 'LIC-1');
  assert.deepEqual(calls[2].body, { isActive: false });
  assert.ok(calls.every(({ key }) => key !== null && /^[0-9a-f-]{36}$/i.test(key)));
  assert.equal(new Set(calls.map(({ key }) => key)).size, 3);
});

test('rejects malformed API supplier data instead of displaying it as a valid record', async () => {
  globalThis.fetch = async () => Response.json({ items: [{ id: 'missing-fields' }], page: 1, pageSize: 200, total: 1 });
  await assert.rejects(listSuppliers(), /invalid response/i);
});
