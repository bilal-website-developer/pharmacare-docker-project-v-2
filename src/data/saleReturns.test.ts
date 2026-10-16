import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import {
  approveSaleReturn,
  getReturnPolicySettings,
  loadPendingSaleReturns,
  loadSaleForReturn,
  processSaleReturn,
  rejectSaleReturn,
  requestSaleReturn,
  updateReturnPolicySettings,
} from './saleReturns';

const originalFetch = globalThis.fetch;
const saleId = '507f1f77bcf86cd799439011';
const returnId = '507f1f77bcf86cd799439012';
const itemId = '507f1f77bcf86cd799439013';

function returnDto(status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'COMPLETED') {
  return {
    id: returnId,
    returnNumber: 'RTN-00001',
    saleId,
    invoiceNumber: 'INV-00001',
    status,
    reason: 'Wrong item',
    requestedAt: '2026-10-17T10:00:00.000Z',
    requestedByName: 'Cashier',
    decidedAt: status === 'PENDING' ? null : '2026-10-17T10:05:00.000Z',
    decidedByName: status === 'PENDING' ? null : 'Manager',
    note: null,
    refundPaisa: '1250',
    refundMethod: status === 'COMPLETED' ? 'SPLIT' : null,
    items: [{
      id: itemId,
      saleItemId: '507f1f77bcf86cd799439014',
      allocationId: '507f1f77bcf86cd799439014:507f1f77bcf86cd799439015',
      medicineName: 'Example Medicine',
      unitName: 'Strip',
      batchNumber: 'B-01',
      expiryDate: '2027-01-01',
      drugClass: 'OTC',
      storageCondition: 'ROOM_TEMPERATURE',
      quantityBaseUnits: '2',
      refundPaisa: '1250',
      disposition: status === 'COMPLETED' ? 'QUARANTINE' : null,
      reason: '',
    }],
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('maps policy, sale details, and pending requests from exact API DTOs', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    calls.push(path);
    if (path === '/api/returns/policy') {
      return Response.json({
        returnWindowDays: 7,
        minimumRestockShelfLifeDays: 90,
        today: '2026-10-17',
      });
    }
    if (path === '/api/returns/sales/INV%2F1') {
      return Response.json({
        id: saleId,
        invoiceNumber: 'INV/1',
        saleDate: '2026-10-17',
        customerId: null,
        customerName: 'Walk-in customer',
        totalPaisa: '1250',
        items: [{
          saleItemId: '507f1f77bcf86cd799439014',
          medicineId: '507f1f77bcf86cd799439016',
          productName: 'Example Medicine',
          genericName: 'Example Generic',
          unitName: 'Strip',
          conversionFactor: 10,
          quantityInUnit: 1,
          quantityBaseUnits: '10',
          lineTotalPaisa: '1250',
          drugClass: 'OTC',
          storageCondition: 'ROOM_TEMPERATURE',
          allocations: [{
            allocationId: '507f1f77bcf86cd799439014:507f1f77bcf86cd799439015',
            batchId: '507f1f77bcf86cd799439015',
            batchNumber: 'B-01',
            expiryDate: '2027-01-01',
            quantityBaseUnits: '10',
            alreadyReturnedBaseUnits: '2',
          }],
        }],
      });
    }
    return Response.json({
      items: [{
        id: returnId,
        saleId,
        status: 'PENDING',
        invoiceNumber: 'INV-00001',
        saleDate: '2026-10-17',
        customerName: 'Walk-in customer',
        reason: 'Wrong item',
        requestedBy: 'Cashier',
        requestedAt: '2026-10-17T10:00:00.000Z',
        items: [{
          id: itemId,
          saleItemId: '507f1f77bcf86cd799439014',
          medicineId: '507f1f77bcf86cd799439016',
          productName: 'Example Medicine',
          unitName: 'Strip',
          conversionFactor: 10,
          quantityBaseUnits: '2',
          batchId: '507f1f77bcf86cd799439015',
          batchNumber: 'B-01',
          expiryDate: '2027-01-01',
          drugClass: 'OTC',
          storageCondition: 'ROOM_TEMPERATURE',
          medicineUnits: [{ id: '507f1f77bcf86cd799439017', name: 'Strip', conversionFactor: 10 }],
        }],
      }],
    });
  };

  assert.deepEqual(await getReturnPolicySettings(), {
    returnWindowDays: 7,
    minimumRestockShelfLifeDays: 90,
    today: '2026-10-17',
  });
  const sale = await loadSaleForReturn('INV/1');
  assert.equal(sale.items[0]?.allocations[0]?.alreadyReturnedBaseUnits, 2);
  assert.equal(sale.items[0]?.lineTotalPaisa, 1250);
  const pending = await loadPendingSaleReturns();
  assert.equal(pending[0]?.status, 'PENDING');
  assert.equal(pending[0]?.items[0]?.quantityBaseUnits, 2);
  assert.deepEqual(calls, [
    '/api/returns/policy',
    '/api/returns/sales/INV%2F1',
    '/api/returns/pending',
  ]);
});

test('rejects unexpected cost fields in API return-sale DTOs', async () => {
  globalThis.fetch = async () => Response.json({
    id: saleId,
    invoiceNumber: 'INV-00001',
    saleDate: '2026-10-17',
    customerId: null,
    customerName: 'Walk-in customer',
    totalPaisa: '1250',
    costPaisa: '500',
    items: [],
  });
  await assert.rejects(loadSaleForReturn('INV-00001'), /invalid sale details/i);
});

test('submits, approves, processes, and rejects returns through idempotent API writes', async () => {
  const calls: Array<{ path: string; method: string; key: string | null; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    calls.push({
      path,
      method: init?.method ?? 'GET',
      key: new Headers(init?.headers).get('Idempotency-Key'),
      body,
    });
    if (path.endsWith('/process')) return Response.json(returnDto('COMPLETED'));
    if (path.endsWith('/approve')) return Response.json(returnDto('APPROVED'));
    if (path.endsWith('/reject')) return Response.json(returnDto('REJECTED'));
    if (path === '/api/returns/policy') return Response.json({
      returnWindowDays: 14,
      minimumRestockShelfLifeDays: 120,
    });
    return Response.json(returnDto('PENDING'), { status: 201 });
  };

  const updated = await updateReturnPolicySettings({
    returnWindowDays: 14,
    minimumRestockShelfLifeDays: 120,
  });
  const requested = await requestSaleReturn(saleId, 'Wrong item', [{
    saleItemId: '507f1f77bcf86cd799439014',
    allocationId: '507f1f77bcf86cd799439014:507f1f77bcf86cd799439015',
    quantityBaseUnits: 2,
  }]);
  await approveSaleReturn(returnId);
  const completed = await processSaleReturn(returnId, [{
    id: itemId,
    disposition: 'QUARANTINE',
    sealedIntact: false,
    restockUnitId: null,
    reason: 'Opened package',
  }]);
  await rejectSaleReturn(returnId, 'Rejected as duplicate');

  assert.deepEqual(updated, { returnWindowDays: 14, minimumRestockShelfLifeDays: 120 });
  assert.equal(requested.status, 'PENDING');
  assert.equal(completed.refundTotalPaisa, 1250);
  assert.equal(completed.refundMethod, 'SPLIT');
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    ['/api/returns/policy', 'PATCH'],
    [`/api/sales/${saleId}/returns`, 'POST'],
    [`/api/returns/${returnId}/approve`, 'POST'],
    [`/api/returns/${returnId}/process`, 'POST'],
    [`/api/returns/${returnId}/reject`, 'POST'],
  ]);
  assert.ok(calls.every(({ key }) => key && /^[0-9a-f-]{36}$/i.test(key)));
});
