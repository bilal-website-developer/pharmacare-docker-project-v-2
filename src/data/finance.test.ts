import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import { createCashExpense, loadCashBook, parsePaisaInput } from './finance';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads paginated shop cash-book entries and parses integer paisa', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    const page = new URL(String(input), 'http://localhost').searchParams.get('page');
    return Response.json({
      items: page === '1' ? [{
        id: 'entry-1',
        type: 'SALE_PAYMENT',
        direction: 'IN',
        amountPaisa: '12000',
        description: 'Invoice M-1',
        paymentMethod: 'CASH',
        createdAt: '2026-10-17T08:30:00.000Z',
        referenceType: 'SALE_PAYMENT',
        referenceId: 'sale-1',
      }] : [],
      totals: { inflowPaisa: '12000', outflowPaisa: '2500', expectedDrawerPaisa: '9500' },
      total: 1,
      page: Number(page),
      pageSize: 200,
    });
  };

  const result = await loadCashBook();
  assert.equal(urls.length, 1);
  assert.equal(result.inflowPaisa, 12000);
  assert.equal(result.outflowPaisa, 2500);
  assert.equal(result.expectedDrawerPaisa, 9500);
  assert.equal(result.transactions[0]?.type, 'SALE');
  assert.equal(result.transactions[0]?.amountPaisa, 12000);
  assert.equal(result.transactions[0]?.isOutflow, false);
});

test('rejects cash-book payloads with unexpected fields or unsafe totals', async () => {
  globalThis.fetch = async () => Response.json({
    items: [{
      id: 'entry-1', type: 'EXPENSE', direction: 'OUT', amountPaisa: '1',
      description: 'Rent', paymentMethod: 'CASH', createdAt: '2026-10-17T08:30:00.000Z',
      referenceType: 'EXPENSE', referenceId: 'expense-1', costPaisa: '999',
    }],
    totals: { inflowPaisa: '0', outflowPaisa: '1', expectedDrawerPaisa: '-1' },
    total: 1, page: 1, pageSize: 200,
  });
  await assert.rejects(loadCashBook(), /invalid response/i);

  globalThis.fetch = async () => Response.json({
    items: [],
    totals: { inflowPaisa: '9007199254740992', outflowPaisa: '0', expectedDrawerPaisa: '9007199254740992' },
    total: 0, page: 1, pageSize: 200,
  });
  await assert.rejects(loadCashBook(), /invalid response/i);
});

test('records expense amounts in integer paisa with idempotency', async () => {
  let receivedBody: unknown;
  let idempotencyKey: string | null = null;
  globalThis.fetch = async (_input, init) => {
    receivedBody = JSON.parse(String(init?.body)) as unknown;
    idempotencyKey = new Headers(init?.headers).get('Idempotency-Key');
    const body = receivedBody as { description: string; amountPaisa: string; category: string; occurredAt: string };
    return Response.json({
      id: 'expense-1',
      category: body.category,
      description: body.description,
      amountPaisa: body.amountPaisa,
      occurredAt: body.occurredAt,
      status: 'ACTIVE',
    }, { status: 201 });
  };

  await createCashExpense('Tea and cleaning supplies', 1250);
  assert.deepEqual(
    { ...(receivedBody as object), occurredAt: 'checked' },
    { category: 'Operating', description: 'Tea and cleaning supplies', amountPaisa: '1250', occurredAt: 'checked' },
  );
  assert.ok(idempotencyKey && /^[0-9a-f-]{36}$/i.test(idempotencyKey));
});

test('parses PKR input as integer paisa without floating-point conversion', () => {
  assert.equal(parsePaisaInput('12.5'), 1250);
  assert.equal(parsePaisaInput('0.01'), 1);
  assert.equal(parsePaisaInput('0'), 0);
  assert.equal(parsePaisaInput('1.234'), null);
  assert.equal(parsePaisaInput('90071992547409.92'), null);
});
