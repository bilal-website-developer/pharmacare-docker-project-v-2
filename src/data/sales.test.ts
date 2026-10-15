import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import { PaymentMethod } from '../types/pharmacy';
import { loadPosCustomers, postSale } from './sales';

const originalFetch = globalThis.fetch;

function apiSale() {
  return {
    id: '0123456789abcdef01234567',
    invoiceNumber: 'INV-000001',
    timestamp: '2026-10-15T12:00:00.000Z',
    cashierName: 'Test Cashier',
    customerId: null,
    customerName: 'Walk-in Customer',
    customerPhone: '',
    subtotalPaisa: '1234',
    discountPaisa: '0',
    roundingPaisa: '-234',
    totalPaisa: '1000',
    amountTenderedPaisa: '1000',
    changePaisa: '0',
    paymentMethod: 'CARD',
    status: 'COMPLETED',
    items: [{
      id: '1123456789abcdef01234567',
      medicineId: '2123456789abcdef01234567',
      medicineCode: 'MED-001',
      productName: 'Controlled Medicine',
      genericName: 'Example ingredient',
      drugClass: 'CONTROLLED',
      unitId: '3123456789abcdef01234567',
      unitName: 'Pack',
      conversionFactor: 10,
      quantityInUnit: 1,
      quantityBaseUnits: '10',
      pricePaisaPerUnit: '1234',
      lineDiscountPaisa: '0',
      lineTotalPaisa: '1234',
      prescription: { prescriber: 'Dr Example', patient: 'Patient Example', reference: 'RX-1' },
      batchAllocations: [{
        batchId: '4123456789abcdef01234567',
        batchNumber: 'BATCH-1',
        expiryDate: '2027-12-31',
        quantityBaseUnits: '10',
      }],
    }],
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads strict POS customer DTOs from the API', async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), '/api/pos/customers');
    return Response.json({
      items: [{
        id: '0123456789abcdef01234567',
        name: 'Test Customer',
        phone: '03000000000',
        address: '',
        creditLimitPaisa: '100000',
        currentBalancePaisa: '5000',
        storeCreditPaisa: '0',
      }],
    });
  };

  const customers = await loadPosCustomers();

  assert.deepEqual(customers, [{
    id: '0123456789abcdef01234567',
    name: 'Test Customer',
    phone: '03000000000',
    address: '',
    creditLimitPaisa: 100000,
    currentBalancePaisa: 5000,
    storeCreditPaisa: 0,
  }]);
});

test('posts only sale inputs and maps online payments to API card', async () => {
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/sales');
    assert.equal(init?.method, 'POST');
    assert.ok(new Headers(init?.headers).get('Idempotency-Key'));
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json(apiSale(), { status: 201 });
  };

  const sale = await postSale({
    customerId: null,
    customerName: 'Walk-in Customer',
    items: [{
      medicineId: '2123456789abcdef01234567',
      unitId: '3123456789abcdef01234567',
      quantityInUnit: 1,
      prescription: { prescriber: 'Dr Example', patient: 'Patient Example', reference: 'RX-1' },
    }],
    discountPaisa: 0,
    roundingPaisa: -234,
    tenderedPaisa: 1000,
    payments: [{ paymentMethod: PaymentMethod.EASYPAISA, amountPaisa: 1000 }],
  });

  assert.deepEqual(body, {
    customerName: 'Walk-in Customer',
    items: [{
      medicineId: '2123456789abcdef01234567',
      unitId: '3123456789abcdef01234567',
      quantityInUnit: 1,
      prescription: { prescriber: 'Dr Example', patient: 'Patient Example', reference: 'RX-1' },
    }],
    discountPaisa: '0',
    payments: [{ method: 'CARD', amountPaisa: '1000' }],
    amountTenderedPaisa: '1000',
  });
  assert.equal(sale.roundingPaisa, -234);
  assert.equal(sale.paymentMethod, PaymentMethod.EASYPAISA);
  assert.equal(sale.items[0]?.costPaisaPerUnit, null);
  assert.equal(sale.items[0]?.batchAllocations?.[0]?.quantitySmallestUnit, 10);
});

test('rejects sale DTOs containing cost-bearing fields', async () => {
  globalThis.fetch = async () => {
    const sale = apiSale();
    Object.assign(sale.items[0], { costPaisaPerUnit: '1000' });
    return Response.json(sale, { status: 201 });
  };

  await assert.rejects(postSale({
    customerId: null,
    customerName: 'Walk-in Customer',
    items: [{
      medicineId: '2123456789abcdef01234567',
      unitId: '3123456789abcdef01234567',
      quantityInUnit: 1,
    }],
    discountPaisa: 0,
    roundingPaisa: 0,
    tenderedPaisa: 1000,
    payments: [{ paymentMethod: PaymentMethod.CASH, amountPaisa: 1000 }],
  }), /invalid response/i);
});
