import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import {
  formatPaisa,
  loadDashboardSummary,
  loadSalesReportSummary,
  parseDashboardSummary,
  parseSalesReportSummary,
} from './businessReports';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads role-safe dashboard activity and reports financial totals as integer paisa', async () => {
  const responses = [
    {
      today: '2026-10-17',
      saleCount: 3,
      sellableStockBaseUnits: '9007199254740993',
      lowStockMedicines: 2,
      nearExpiryBatches: 4,
      expiredBatches: 1,
      todaySalesPaisa: '12345',
      grossSalesPaisa: '15000',
      returnsPaisa: '2655',
      expensesPaisa: '500',
      monthNetSalesPaisa: '-100',
      cashSalesPaisa: '60000',
      creditSalesPaisa: '20000',
      receivablesPaisa: '30000',
      cashPurchasesPaisa: '4000',
      expectedDrawerPaisa: '11000',
    },
    {
      dateFrom: null,
      dateTo: null,
      grossSalesPaisa: '15000',
      returnsPaisa: '2655',
      netSalesPaisa: '12345',
      saleCount: 3,
      returnCount: 1,
    },
  ];
  globalThis.fetch = async () => Response.json(responses.shift());

  const dashboard = await loadDashboardSummary();
  const report = await loadSalesReportSummary();
  assert.equal(dashboard.sellableStockBaseUnits, '9007199254740993');
  assert.equal(dashboard.monthNetSalesPaisa, '-100');
  assert.equal(dashboard.expectedDrawerPaisa, '11000');
  assert.equal(report.netSalesPaisa, '12345');
  assert.equal(report.returnCount, 1);
  assert.equal(formatPaisa(report.netSalesPaisa), 'Rs. 123.45');
  assert.equal(formatPaisa(dashboard.monthNetSalesPaisa), '-Rs. 1.00');
});

test('accepts activity-only dashboard DTOs without financial fields', () => {
  assert.deepEqual(parseDashboardSummary({
    today: '2026-10-17',
    saleCount: 2,
    sellableStockBaseUnits: '10',
    lowStockMedicines: 1,
    nearExpiryBatches: 3,
    expiredBatches: 0,
  }), {
    today: '2026-10-17',
    saleCount: 2,
    sellableStockBaseUnits: '10',
    lowStockMedicines: 1,
    nearExpiryBatches: 3,
    expiredBatches: 0,
  });
});

test('rejects extra fields, malformed dates, and unsafe report counts', () => {
  assert.throws(() => parseDashboardSummary({
    today: '2026-10-17',
    saleCount: 2,
    sellableStockBaseUnits: '10',
    lowStockMedicines: 1,
    nearExpiryBatches: 3,
    expiredBatches: 0,
    costPaisa: '1',
  }), /invalid response/i);
  assert.throws(() => parseDashboardSummary({
    today: 'not-a-date',
    saleCount: 2,
    sellableStockBaseUnits: '10',
    lowStockMedicines: 1,
    nearExpiryBatches: 3,
    expiredBatches: 0,
  }), /invalid response/i);
  assert.throws(() => parseSalesReportSummary({
    dateFrom: null,
    dateTo: null,
    grossSalesPaisa: '100',
    returnsPaisa: '0',
    netSalesPaisa: '100',
    saleCount: Number.MAX_SAFE_INTEGER + 1,
    returnCount: 0,
  }), /invalid response/i);
});
