import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from '../types/pharmacy';
import {
  buildPrintSnapshot,
  canPrintReceipt,
  isPrintSnapshotSafe,
  parsePrintSnapshot,
  snapshotWithDuplicateLabel,
} from './printSnapshot';
import { DEFAULT_PHARMACY_MEMO_SETTINGS, PHARMACY_MEMO_TEST_FIXTURE } from './receipt';

test('receipt snapshots contain only explicitly allowed receipt fields', () => {
  const safe = buildPrintSnapshot(
    PHARMACY_MEMO_TEST_FIXTURE,
    DEFAULT_PHARMACY_MEMO_SETTINGS,
    'thermal80',
  );
  const snapshot = parsePrintSnapshot({
    ...safe,
    data: {
      ...safe.data,
      costPricePaisa: 123,
      profitPaisa: 456,
      lines: [{ ...safe.data.lines[0], purchase_price: 99, margin: 20 }],
    },
  });

  assert.equal(isPrintSnapshotSafe(snapshot), true);
  assert.equal('costPricePaisa' in snapshot.data, false);
  assert.equal('purchase_price' in snapshot.data.lines[0], false);
  assert.deepEqual(parsePrintSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);

  const benignProductName = buildPrintSnapshot({
    ...PHARMACY_MEMO_TEST_FIXTURE,
    lines: [{ ...PHARMACY_MEMO_TEST_FIXTURE.lines[0], name: 'Profit Margin Cream' }],
  }, DEFAULT_PHARMACY_MEMO_SETTINGS, 'thermal80');
  assert.equal(isPrintSnapshotSafe(benignProductName), true);
});

test('admin duplicate snapshots always enable the duplicate label', () => {
  const original = buildPrintSnapshot(
    PHARMACY_MEMO_TEST_FIXTURE,
    { ...DEFAULT_PHARMACY_MEMO_SETTINGS, duplicateLabel: false },
    'thermal58',
  );
  const duplicate = snapshotWithDuplicateLabel(original);
  assert.equal(duplicate.data.isDuplicate, true);
  assert.equal(duplicate.settings.duplicateLabel, true);
  assert.equal(original.settings.duplicateLabel, false);
});

test('only POS users with the kind-specific key can print directly; admins always can', () => {
  assert.equal(canPrintReceipt(UserRole.CASHIER, ['pos', 'pos_print_sale'], 'sale'), true);
  assert.equal(canPrintReceipt(UserRole.CASHIER, ['pos', 'pos_print_sale'], 'payment'), false);
  assert.equal(canPrintReceipt(UserRole.MANAGER, ['pos_print_payment'], 'payment'), false);
  assert.equal(canPrintReceipt(UserRole.ADMIN, [], 'payment'), true);
  assert.equal(canPrintReceipt(UserRole.ADMIN, [], 'sale'), true);
});

test('snapshot parser rejects malformed data rather than returning a success-shaped fallback', () => {
  const safe = buildPrintSnapshot(
    PHARMACY_MEMO_TEST_FIXTURE,
    DEFAULT_PHARMACY_MEMO_SETTINGS,
    'thermal80',
  );
  assert.throws(
    () => parsePrintSnapshot({ ...safe, data: { ...safe.data, kind: 'BAD' } }),
    /unsupported memo kind/,
  );
});
