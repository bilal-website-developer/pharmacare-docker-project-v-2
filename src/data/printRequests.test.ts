import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import {
  decidePrintRequest,
  loadAdminPrintRequests,
  loadMyPrintRequests,
  loadPendingPrintCount,
  markPrintRequestPrinted,
  modifyPrintRequest,
  submitPrintRequest,
} from './printRequests';
import type { PrintSnapshot } from '../utils/printSnapshot';

const originalFetch = globalThis.fetch;
const request = {
  id: '507f1f77bcf86cd799439011',
  type: 'sale',
  receipt_ref: 'INV-1',
  requested_by: '507f1f77bcf86cd799439012',
  requester_name: 'Cashier',
  requested_at: '2026-10-17T08:30:00.000Z',
  status: 'pending',
  decided_by: null,
  decided_at: null,
  note: null,
  printed_at: null,
  payload: { safe: true },
};
const snapshot: PrintSnapshot = {
  data: {
    kind: 'SALE',
    memoNo: 'INV-1',
    dateTime: '2026-10-17T08:30:00.000Z',
    lines: [{ qty: 1, name: 'Medicine', ratePaisa: 100 }],
    discountPaisa: 0,
    cashier: 'Cashier',
    role: 'cashier',
    terminal: 'Counter 1',
  },
  settings: {
    storeName: 'Demo Pharmacy',
    address: '',
    phone: '',
    notes: ['', '', ''],
    terminalName: '',
    showBatchExpiry: true,
    roundNet: 'none',
    printTax: false,
    duplicateLabel: false,
    numberDigits: 6,
  },
  format: 'thermal80',
  template: 'pharmacy-memo',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads own and admin print-request DTOs and pending count', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/pending-count')) return Response.json({ count: 2 });
    if (url.endsWith('/mine')) {
      const { requester_name: _requesterName, ...mineRequest } = request;
      return Response.json({ items: [mineRequest] });
    }
    return Response.json({ items: [request] });
  };
  assert.equal((await loadMyPrintRequests())[0]?.receipt_ref, 'INV-1');
  assert.equal((await loadAdminPrintRequests())[0]?.requester_name, 'Cashier');
  assert.equal(await loadPendingPrintCount(), 2);
  assert.deepEqual(urls, [
    '/api/print-requests/mine',
    '/api/admin/print-requests',
    '/api/admin/print-requests/pending-count',
  ]);
});

test('rejects unexpected fields from the print-request API', async () => {
  globalThis.fetch = async () => Response.json({
    items: [{ ...request, costPaisa: '900' }],
  });
  await assert.rejects(loadAdminPrintRequests(), /invalid response/i);
});

test('decides, edits, submits, and tracks a print request through idempotent API writes', async () => {
  const calls: Array<{ path: string; method: string; body: unknown; key: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    calls.push({
      path,
      method,
      body,
      key: new Headers(init?.headers).get('Idempotency-Key'),
    });
    if (path.endsWith('/printed')) return Response.json({ status: 'approved', printedAt: '2026-10-17T09:00:00.000Z' });
    if (path === '/api/print-requests') {
      return Response.json({
        id: request.id,
        type: 'sale',
        receipt_ref: 'INV-1',
        requested_by: request.requested_by,
        requested_at: request.requested_at,
        status: 'pending',
      }, { status: 201 });
    }
    const isAdmin = path.startsWith('/api/admin/');
    return Response.json({
      ...request,
      ...(isAdmin ? {} : { requester_name: undefined }),
      ...(path.endsWith('/decision') ? { status: 'approved' } : {}),
    });
  };

  const decided = await decidePrintRequest(request.id, 'approved', null);
  assert.equal(decided.status, 'approved');
  const modified = await modifyPrintRequest(request.id, snapshot);
  assert.equal(modified.id, request.id);
  await submitPrintRequest('sale', 'INV-1', snapshot);
  await markPrintRequestPrinted(request.id);
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    [`/api/admin/print-requests/${request.id}/decision`, 'POST'],
    [`/api/admin/print-requests/${request.id}/snapshot`, 'PATCH'],
    ['/api/print-requests', 'POST'],
    [`/api/print-requests/${request.id}/printed`, 'POST'],
  ]);
  assert.ok(calls.every((call) => call.key !== null));
});
