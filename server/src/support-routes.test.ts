import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMaskedDiagnosticsReport, supportScopeAllows } from './support-routes.js';

test('support scopes permit only their assigned access levels', () => {
  assert.equal(supportScopeAllows('diagnostics', 'diagnostics'), true);
  assert.equal(supportScopeAllows('diagnostics', 'read_only'), false);
  assert.equal(supportScopeAllows('diagnostics', 'admin_actions'), false);
  assert.equal(supportScopeAllows('read_only', 'diagnostics'), true);
  assert.equal(supportScopeAllows('read_only', 'read_only'), true);
  assert.equal(supportScopeAllows('read_only', 'admin_actions'), false);
  assert.equal(supportScopeAllows('admin_actions', 'diagnostics'), true);
  assert.equal(supportScopeAllows('admin_actions', 'read_only'), true);
  assert.equal(supportScopeAllows('admin_actions', 'admin_actions'), true);
});

test('masked diagnostics contains only service status and aggregate health counts', () => {
  const input = Object.assign({
    generatedAt: '2026-10-18T12:00:00.000Z',
    appVersion: '0.1.0',
    database: 'reachable',
    licence: 'active',
    lastHeartbeatAt: '2026-10-18T06:00:00.000Z',
    counts: { users: 4, products: 120, sales: 800, purchases: 40 },
  }, {
    customerName: 'Customer Sentinel Name',
    customerPhone: 'Phone Sentinel 03000000000',
    saleAmount: 'Amount Sentinel 123456789',
    password: 'Password Sentinel',
    token: 'Token Sentinel',
    secret: 'Secret Sentinel',
  });
  const report = buildMaskedDiagnosticsReport(input);
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'Customer Sentinel Name',
    'Phone Sentinel 03000000000',
    'Amount Sentinel 123456789',
    'Password Sentinel',
    'Token Sentinel',
    'Secret Sentinel',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(report.counts, { users: 4, products: 120, sales: 800, purchases: 40 });
});
