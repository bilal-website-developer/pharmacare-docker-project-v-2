import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import test from 'node:test';
import {
  evaluateLicenceState,
  licenceBannerVisibleToRole,
  verifyLicence,
  type SignedLicence,
  type LicencePayload,
} from './licence.js';

const DAY = 24 * 60 * 60 * 1000;
const expiry = Date.parse('2026-11-01T00:00:00.000Z');
const keyPair = generateKeyPairSync('ed25519');
const privateKeyPem = keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicKeyPem = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();

function monthly(overrides: Partial<LicencePayload> = {}): LicencePayload {
  return {
    shop_id: 'test-shop',
    plan_type: 'monthly',
    starts_at: '2026-10-01T00:00:00.000Z',
    expires_at: new Date(expiry).toISOString(),
    max_pcs: 3,
    offline_grace_days: 14,
    warning_days: 7,
    renewal_notice_days: 7,
    issued_at: '2026-10-01T00:00:00.000Z',
    nonce: 'test-nonce',
    ...overrides,
  };
}

function signLicence(payload: LicencePayload): SignedLicence {
  const canonical = JSON.stringify({
    shop_id: payload.shop_id,
    plan_type: payload.plan_type,
    starts_at: payload.starts_at,
    expires_at: payload.expires_at,
    max_pcs: payload.max_pcs,
    offline_grace_days: payload.offline_grace_days,
    warning_days: payload.warning_days,
    renewal_notice_days: payload.renewal_notice_days,
    issued_at: payload.issued_at,
    nonce: payload.nonce,
  });
  return {
    payload,
    signature: signBytes(null, Buffer.from(canonical), privateKeyPem).toString('base64url'),
  };
}

test('licence boundary table uses exact inclusive transition instants', () => {
  const licence = monthly();
  const cases = [
    { name: 'before renewal notice', time: expiry - 7 * DAY - 1, expected: 'active' },
    { name: 'first renewal notice instant', time: expiry - 7 * DAY, expected: 'renewal_notice' },
    { name: 'expiry instant', time: expiry, expected: 'warning' },
    { name: 'last instant in warning', time: expiry + 7 * DAY - 1, expected: 'warning' },
    { name: 'inactive boundary', time: expiry + 7 * DAY, expected: 'inactive' },
  ] as const;

  for (const item of cases) {
    assert.equal(
      evaluateLicenceState(licence, new Date(item.time), null).state,
      item.expected,
      item.name,
    );
  }
});

test('zero-length renewal and warning windows transition at their exact boundaries', () => {
  const noReminder = monthly({ renewal_notice_days: 0 });
  assert.equal(evaluateLicenceState(noReminder, new Date(expiry - 1), null).state, 'active');
  assert.equal(evaluateLicenceState(noReminder, new Date(expiry), null).state, 'warning');

  const noWarning = monthly({ warning_days: 0 });
  assert.equal(evaluateLicenceState(noWarning, new Date(expiry - 1), null).state, 'renewal_notice');
  assert.equal(evaluateLicenceState(noWarning, new Date(expiry), null).state, 'inactive');
});

test('one-time plans never expire and long offline periods only show a warning', () => {
  const oneTime = monthly({
    plan_type: 'one_time',
    expires_at: null,
    offline_grace_days: 14,
  });
  const now = new Date('2036-01-01T00:00:00.000Z');
  const lastSeen = new Date(now.getTime() - 15 * DAY);
  const result = evaluateLicenceState(oneTime, now, lastSeen);
  assert.equal(result.state, 'active');
  assert.equal(result.offlineWarning, true);
  assert.equal(result.canCreateSales, true);
});

test('suspension blocks writes while view, print, reports, and backup remain available', () => {
  const result = evaluateLicenceState(monthly(), new Date('2026-10-15T00:00:00.000Z'), null, true);
  assert.equal(result.state, 'suspended');
  assert.equal(result.canCreateSales, false);
  assert.equal(result.canChangeStock, false);
  assert.equal(result.canPurchase, false);
  assert.equal(result.canView, true);
  assert.equal(result.canPrint, true);
  assert.equal(result.canViewReports, true);
  assert.equal(result.canBackup, true);
});

test('a newly extended signed licence reactivates an expired shop', async () => {
  const expired = monthly({ expires_at: '2026-10-01T00:00:00.000Z' });
  assert.equal(
    evaluateLicenceState(expired, new Date('2026-10-10T00:00:00.000Z'), null).state,
    'inactive',
  );
  const extension = monthly({
    starts_at: '2026-10-10T00:00:00.000Z',
    expires_at: '2026-11-10T00:00:00.000Z',
    issued_at: '2026-10-10T00:00:00.000Z',
    nonce: 'extension-nonce',
  });
  const signed = signLicence(extension);
  assert.equal(await verifyLicence(signed, publicKeyPem, 'test-shop'), true);
  assert.equal(
    evaluateLicenceState(signed.payload, new Date('2026-10-10T00:00:00.000Z'), null).state,
    'active',
  );
});

test('clock rollback over one day uses last-seen time and shows a clock warning', () => {
  const lastSeen = new Date('2026-11-10T00:00:00.000Z');
  const result = evaluateLicenceState(
    monthly({ expires_at: '2026-11-01T00:00:00.000Z' }),
    new Date('2026-11-08T00:00:00.000Z'),
    lastSeen,
  );
  assert.equal(result.clockWarning, true);
  assert.equal(result.effectiveNow.getTime(), lastSeen.getTime());
  assert.equal(result.state, 'inactive');
});

test('server verifier rejects tampering and licences for a different shop', async () => {
  const signed = signLicence(monthly());
  assert.equal(await verifyLicence(signed, publicKeyPem, 'test-shop'), true);
  assert.equal(await verifyLicence(signed, publicKeyPem, 'other-shop'), false);
  assert.equal(await verifyLicence({
    ...signed,
    payload: { ...signed.payload, max_pcs: 500 },
  }, publicKeyPem), false);
});

test('renewal reminder is admin-only and warning banner is shared with managers', () => {
  assert.equal(licenceBannerVisibleToRole('renewal_notice', 'admin'), true);
  assert.equal(licenceBannerVisibleToRole('renewal_notice', 'manager'), false);
  assert.equal(licenceBannerVisibleToRole('warning', 'manager'), true);
  assert.equal(licenceBannerVisibleToRole('inactive', 'cashier'), true);
});
