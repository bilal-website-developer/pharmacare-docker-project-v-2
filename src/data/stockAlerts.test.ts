import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken, setApiAccessToken } from '../api';
import { loadStockAlertsSummary } from './stockAlerts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads and adapts the API stock-alert DTO for the existing UI contract', async () => {
  const calls: string[] = [];
  setApiAccessToken('in-memory-access-token');
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer in-memory-access-token');
    return Response.json({
      lowCount: 1,
      outCount: 1,
      generatedAt: '2026-10-15T06:00:00.000Z',
      items: [
        {
          medicineId: 'medicine-low',
          name: 'Sample Tablets',
          strength: '10 mg',
          genericName: 'Example compound',
          stockBaseUnits: '4',
          minStockAlert: 8,
          kind: 'low',
        },
        {
          medicineId: 'medicine-out',
          name: 'Another Sample',
          strength: null,
          genericName: '',
          stockBaseUnits: '0',
          minStockAlert: 3,
          kind: 'out',
        },
      ],
    });
  };

  const summary = await loadStockAlertsSummary(25);

  assert.deepEqual(calls, ['/api/stock/alerts/summary?limit=25']);
  assert.equal(summary.low_count, 1);
  assert.equal(summary.out_count, 1);
  assert.equal(summary.items[0].medicine_id, 'medicine-low');
  assert.equal(summary.items[0].stock, 4);
  assert.equal(summary.items[1].kind, 'out');
});

test('rejects an API alert DTO with unexpected fields', async () => {
  setApiAccessToken('in-memory-access-token');
  globalThis.fetch = async () => Response.json({
    lowCount: 0,
    outCount: 0,
    generatedAt: '2026-10-15T06:00:00.000Z',
    items: [],
    costPaisa: '99999',
  });

  await assert.rejects(
    loadStockAlertsSummary(),
    /returned an invalid response/,
  );
});

test('rejects alert quantities outside JavaScript safe-integer range', async () => {
  setApiAccessToken('in-memory-access-token');
  globalThis.fetch = async () => Response.json({
    lowCount: 1,
    outCount: 0,
    generatedAt: '2026-10-15T06:00:00.000Z',
    items: [{
      medicineId: 'medicine-large',
      name: 'Large Stock',
      strength: null,
      genericName: '',
      stockBaseUnits: '9007199254740992',
      minStockAlert: 10,
      kind: 'low',
    }],
  });

  await assert.rejects(
    loadStockAlertsSummary(),
    /returned an invalid response/,
  );
});
