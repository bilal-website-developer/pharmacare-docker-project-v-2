import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from './types/pharmacy';
import {
  canAccessModule,
  canAccessPage,
  hasPosPrintToggles,
  isPermissionKey,
  MODULES,
  normalizePermissionSelection,
  setModulePermission,
  setPosPrintPermission,
  ROLE_DEFAULT_PERMISSIONS,
} from './permissions';

test('role defaults preserve limited roles and give both admin roles full module access', () => {
  assert.equal(isPermissionKey('stock_alerts'), true);
  assert.deepEqual(ROLE_DEFAULT_PERMISSIONS[UserRole.CASHIER], ['pos', 'customers']);
  assert.deepEqual(ROLE_DEFAULT_PERMISSIONS[UserRole.MANAGER], [
    'pos', 'products', 'categories', 'suppliers', 'customers',
    'sales_history', 'purchase_history', 'purchases', 'stock_inventory', 'reports',
  ]);
  assert.deepEqual(ROLE_DEFAULT_PERMISSIONS[UserRole.ACCOUNTANT], [
    'customers', 'suppliers', 'sales_history', 'purchase_history', 'expenses', 'reports',
  ]);
  assert.deepEqual(ROLE_DEFAULT_PERMISSIONS[UserRole.ADMIN], MODULES.map(({ key }) => key));
  assert.deepEqual(ROLE_DEFAULT_PERMISSIONS[UserRole.SUPER_ADMIN], MODULES.map(({ key }) => key));
});

test('POS print toggles are visible only with POS Billing and default new POS users to sale-only printing', () => {
  const withPos = setModulePermission(['customers'], 'pos', true, true);
  assert.equal(hasPosPrintToggles(withPos), true);
  assert.deepEqual(withPos, ['customers', 'pos', 'pos_print_sale']);
  assert.equal(withPos.includes('pos_print_sale'), true);
  assert.equal(withPos.includes('pos_print_payment'), false);

  const withPaymentPrint = setPosPrintPermission(withPos, 'pos_print_payment', true);
  assert.equal(withPaymentPrint.includes('pos_print_payment'), true);
  assert.deepEqual(setModulePermission(withPaymentPrint, 'pos', false), ['customers']);
  assert.equal(hasPosPrintToggles(['customers']), false);
  assert.deepEqual(normalizePermissionSelection(['customers', 'pos_print_sale', 'pos_print_payment']), ['customers']);
});

test('admin roles override assigned permissions while limited roles remain permission-scoped', () => {
  for (const { key } of MODULES) {
    assert.equal(canAccessModule(UserRole.ADMIN, [], key), true);
    assert.equal(canAccessModule(UserRole.ADMIN, ['pos'], key), true);
    assert.equal(canAccessModule(UserRole.SUPER_ADMIN, [], key), true);
  }
  assert.equal(canAccessModule(UserRole.CASHIER, ['pos'], 'pos'), true);
  assert.equal(canAccessModule(UserRole.CASHIER, ['pos'], 'purchases'), false);
  assert.equal(canAccessPage(UserRole.ADMIN, [], 'manage-users'), true);
  assert.equal(canAccessPage(UserRole.SUPER_ADMIN, [], 'manage-users'), true);
  assert.equal(canAccessPage(UserRole.SUPER_ADMIN, [], 'settings'), true);
  assert.equal(canAccessPage(UserRole.ADMIN, [], 'expenses'), true);
  assert.equal(canAccessPage(UserRole.ADMIN, ['expenses'], 'expenses'), true);
  assert.equal(canAccessPage(UserRole.ADMIN, [], 'manage-users'), true);
  assert.equal(canAccessPage(UserRole.ADMIN, ['purchases'], 'purchases'), true);
  assert.equal(canAccessPage(UserRole.ADMIN, ['purchases'], 'purchase-history'), true);
  assert.equal(canAccessPage(UserRole.ADMIN, ['purchase_history'], 'purchase-history'), true);
  assert.equal(canAccessPage(UserRole.ADMIN, ['purchase_history'], 'purchases'), true);
  assert.equal(canAccessPage(UserRole.CASHIER, ['pos'], 'manage-users'), false);
  assert.equal(canAccessPage(UserRole.MANAGER, ['manage_users'], 'manage-users'), true);
  assert.equal(canAccessPage(UserRole.MANAGER, [], 'manage-users'), false);
  assert.equal(canAccessPage(UserRole.MANAGER, ['manage_users'], 'settings'), false);
  assert.equal(canAccessPage(UserRole.MANAGER, ['manage_users'], 'trash-bin'), false);
  assert.equal(canAccessPage(UserRole.CASHIER, [], 'my-print-requests'), true);
  assert.equal(canAccessPage(UserRole.CASHIER, [], 'print-requests'), false);
  assert.equal(canAccessPage(UserRole.ADMIN, [], 'print-requests'), true);
  assert.equal(canAccessPage(UserRole.CASHIER, ['pos'], 'purchases'), false);
  assert.equal(canAccessPage(UserRole.CASHIER, ['customers'], 'customer-ledger'), true);
  assert.equal(canAccessPage(UserRole.CASHIER, [], 'dashboard'), true);
  assert.equal(canAccessPage(UserRole.CASHIER, [], 'help-support'), true);
});
