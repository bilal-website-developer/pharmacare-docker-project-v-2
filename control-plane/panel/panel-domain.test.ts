import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addPlanPeriod,
  changePlanDefaults,
  createShopRequest,
  initialShopAdminForm,
  validateShopAdminForm,
} from './src/panel-domain.ts';

test('shop form defaults and plan dates match monthly, yearly and one-time rules', () => {
  const form = initialShopAdminForm('2026-01-31');
  assert.equal(form.timezone, 'Asia/Karachi');
  assert.equal(form.max_pcs, '3');
  assert.equal(form.offline_grace_days, '14');
  assert.equal(form.warning_days, '7');
  assert.equal(form.renewal_notice_days, '7');
  assert.equal(form.expires_at, '2026-02-28');
  assert.equal(addPlanPeriod('2024-02-29', 'yearly'), '2025-02-28');
  assert.equal(changePlanDefaults(form, 'yearly').expires_at, '2027-01-31');
  assert.equal(changePlanDefaults(form, 'one_time').expires_at, '');
});

test('shop form validation identifies fields and enforces licence bounds', () => {
  const form = initialShopAdminForm('2026-10-18');
  form.shop_name = 'Example Pharmacy';
  form.owner_name = 'Owner';
  form.phone = '03000000000';
  form.city = 'Lahore';
  form.admin_full_name = 'Shop Admin';
  form.admin_email = 'invalid';
  form.expires_at = '2026-10-18';
  form.max_pcs = '0';
  form.offline_grace_days = '61';
  form.warning_days = '31';
  form.renewal_notice_days = '-1';
  const errors = validateShopAdminForm(form);
  assert.deepEqual(Object.keys(errors).sort(), [
    'admin_email',
    'expires_at',
    'max_pcs',
    'offline_grace_days',
    'renewal_notice_days',
    'warning_days',
  ]);

  form.plan_type = 'one_time';
  form.admin_email = 'admin@example.test';
  form.expires_at = '';
  form.max_pcs = '3';
  form.offline_grace_days = '14';
  form.warning_days = '7';
  form.renewal_notice_days = '7';
  assert.deepEqual(validateShopAdminForm(form), {});
  assert.equal((createShopRequest(form).licence as { expires_at: string | null }).expires_at, null);
});
