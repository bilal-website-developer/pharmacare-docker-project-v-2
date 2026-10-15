import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import { loadCustomerAccountsSummary, recordCustomerPayment, saveCustomer } from './sales';

const originalFetch = globalThis.fetch;

const customerDto = {
  id: '0123456789abcdef01234567',
  name: 'Test Customer',
  phone: '03000000000',
  cnic: '12345-1234567-1',
  address: 'Main Street',
  creditLimitPaisa: '1000000',
  currentBalancePaisa: '24000',
  storeCreditPaisa: '0',
  createdAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:00:00.000Z',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads strict customer and ledger DTOs and groups the ledger by customer', async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), '/api/customers/accounts/summary');
    return Response.json({
      customers: [customerDto],
      ledgerEntries: [{
        id: '1123456789abcdef01234567',
        customerId: customerDto.id,
        date: '2026-10-15T12:00:00.000Z',
        type: 'INVOICE',
        referenceNo: 'INV-000001',
        description: 'POS Bill INV-000001',
        debitPaisa: '24000',
        creditPaisa: '0',
        runningBalancePaisa: '24000',
      }],
    });
  };

  const accounts = await loadCustomerAccountsSummary();

  assert.equal(accounts.customers[0]?.creditLimitPaisa, 1_000_000);
  assert.equal(accounts.customers[0]?.cnic, customerDto.cnic);
  assert.deepEqual(accounts.ledgerEntries[customerDto.id], [{
    id: '1123456789abcdef01234567',
    customerId: customerDto.id,
    date: '2026-10-15T12:00:00.000Z',
    type: 'INVOICE',
    referenceNo: 'INV-000001',
    description: 'POS Bill INV-000001',
    debitPaisa: 24_000,
    creditPaisa: 0,
    runningBalancePaisa: 24_000,
  }]);
});

test('rejects customer summaries containing fields outside the response DTO', async () => {
  globalThis.fetch = async () => Response.json({
    customers: [{ ...customerDto, marginPaisa: '100' }],
    ledgerEntries: [],
  });

  await assert.rejects(loadCustomerAccountsSummary(), /invalid response/i);
});

test('creates customers with integer-paisa input and idempotency', async () => {
  let requestedBody: unknown;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/customers');
    assert.equal(init?.method, 'POST');
    requestedBody = JSON.parse(String(init?.body)) as unknown;
    assert.ok(new Headers(init?.headers).get('Idempotency-Key'));
    return Response.json(customerDto, { status: 201 });
  };

  const customer = await saveCustomer({
    name: 'Test Customer',
    phone: '03000000000',
    cnic: customerDto.cnic,
    address: 'Main Street',
    creditLimitPaisa: 1_000_000,
  });

  assert.deepEqual(requestedBody, {
    name: 'Test Customer',
    phone: '03000000000',
    cnic: customerDto.cnic,
    address: 'Main Street',
    creditLimitPaisa: '1000000',
  });
  assert.equal(customer.id, customerDto.id);
});

test('records a cash payment and converts the strict response DTO', async () => {
  let requestedBody: unknown;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `/api/customers/${customerDto.id}/payments`);
    assert.equal(init?.method, 'POST');
    requestedBody = JSON.parse(String(init?.body)) as unknown;
    assert.ok(new Headers(init?.headers).get('Idempotency-Key'));
    return Response.json({
      referenceNo: 'RCP-000001',
      dateTime: '2026-10-15T12:00:00.000Z',
      balanceAfterPaisa: '14000',
      storeCreditPaisa: '0',
    });
  };

  const payment = await recordCustomerPayment(customerDto.id, 10_000, 'Counter payment');

  assert.deepEqual(requestedBody, {
    amountPaisa: '10000',
    method: 'CASH',
    note: 'Counter payment',
  });
  assert.deepEqual(payment, {
    referenceNo: 'RCP-000001',
    dateTime: '2026-10-15T12:00:00.000Z',
    balanceAfterPaisa: 14_000,
    storeCreditPaisa: 0,
  });
});
