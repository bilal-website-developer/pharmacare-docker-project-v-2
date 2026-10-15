import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import { loadShopSettings, updateShopSettings } from './shopSettings';

const originalFetch = globalThis.fetch;

function settingsResponse() {
  return {
    id: '0123456789abcdef01234567',
    slug: 'demo-shop',
    name: 'Demo Pharmacy',
    profile: { displayName: 'Demo Pharmacy', address: 'Main Street', phone: '03000000000', city: 'Lahore' },
    receiptSettings: { format: 'thermal80', template: 'pharmacy-memo' },
    memoSettings: {
      storeName: 'Demo Pharmacy',
      address: 'Main Street',
      phone: '03000000000',
      notes: ['Note one', 'Note two', 'Note three'],
      terminalName: 'Front counter',
      showBatchExpiry: true,
      roundNet: '5',
      printTax: false,
      duplicateLabel: false,
      numberDigits: 6,
      autoPrint: false,
    },
    timeZone: 'Asia/Karachi',
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads and validates server-owned shop settings', async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), '/api/shop/settings');
    return Response.json(settingsResponse());
  };

  const settings = await loadShopSettings();

  assert.equal(settings.memoSettings.roundNet, '5');
  assert.equal(settings.receiptSettings.format, 'thermal80');
  assert.equal(settings.timeZone, 'Asia/Karachi');
});

test('rejects shop settings responses with unexpected fields', async () => {
  globalThis.fetch = async () => Response.json({
    ...settingsResponse(),
    memoSettings: { ...settingsResponse().memoSettings, unitCostPaisa: '1000' },
  });

  await assert.rejects(loadShopSettings(), /invalid response/i);
});

test('updates only the requested shop settings fields and parses the server result', async () => {
  let requestedBody: unknown;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/shop/settings');
    assert.equal(init?.method, 'PATCH');
    requestedBody = JSON.parse(String(init?.body)) as unknown;
    const headers = new Headers(init?.headers);
    assert.ok(headers.get('Idempotency-Key'));
    const updated = settingsResponse();
    updated.memoSettings.roundNet = '10';
    return Response.json(updated);
  };

  const settings = await updateShopSettings({ memoSettings: { roundNet: '10' } });

  assert.deepEqual(requestedBody, { memoSettings: { roundNet: '10' } });
  assert.equal(settings.memoSettings.roundNet, '10');
});
