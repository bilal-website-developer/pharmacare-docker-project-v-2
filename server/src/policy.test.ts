import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignableRolesFor,
  canAssignRole,
  canManageTarget,
  canUseManageUsers,
  grantablePermissionsFor,
  normalizePolicyPermissions,
  permissionGrantDenial,
  profileChangeDenial,
} from './policy.js';
import { PERMISSION_KEYS } from './permissions.js';

const baseChange = {
  callerRole: 'super_admin' as const,
  callerId: 'actor',
  targetId: 'target',
  targetRole: 'cashier' as const,
  targetPermissions: ['pos'],
  targetActive: true,
  activeAdminCount: 2,
  superAdminCount: 2,
  activeSuperAdminCount: 2,
};

test('Manage Users gate and assignable role lists match the Edge Function policy', () => {
  assert.equal(canUseManageUsers('cashier', []), false);
  assert.equal(canUseManageUsers('manager', ['manage_users']), true);
  assert.equal(canUseManageUsers('admin', []), true);
  assert.deepEqual(assignableRolesFor('admin'), ['cashier', 'manager', 'accountant']);
  assert.deepEqual(assignableRolesFor('super_admin'), ['cashier', 'manager', 'accountant', 'admin', 'super_admin']);
  assert.deepEqual(assignableRolesFor('manager', ['manage_users']), ['cashier', 'manager', 'accountant']);
  assert.equal(canAssignRole('admin', 'admin'), false);
  assert.equal(canAssignRole('super_admin', 'admin'), true);
});

test('grantable permissions and restrictions match caller-held permission policy', () => {
  const held = ['manage_users', 'customers', 'pos'];
  assert.deepEqual(grantablePermissionsFor('manager', held, PERMISSION_KEYS), ['customers', 'pos']);
  assert.deepEqual(grantablePermissionsFor('admin', [], PERMISSION_KEYS), [...PERMISSION_KEYS]);
  assert.equal(permissionGrantDenial('manager', held, ['customers', 'pos']), null);
  assert.match(permissionGrantDenial('manager', held, ['reports']) ?? '', /only grant permissions that you hold/);
  assert.match(permissionGrantDenial('manager', held, ['manage_users']) ?? '', /Only admin or super_admin/);
  assert.equal(permissionGrantDenial('admin', [], ['manage_users']), null);
});

test('print permissions are removed unless POS is granted, and duplicates are normalized', () => {
  assert.deepEqual(
    normalizePolicyPermissions(['customers', 'pos_print_sale', 'pos_print_sale']),
    ['customers'],
  );
  assert.deepEqual(
    normalizePolicyPermissions(['pos', 'pos_print_sale', 'pos_print_sale', 'pos_print_payment']),
    ['pos', 'pos_print_sale', 'pos_print_payment'],
  );
});

test('only Super Admin can manage admin and super-admin targets', () => {
  assert.equal(canManageTarget('admin', 'actor', 'target', 'admin'), false);
  assert.equal(canManageTarget('admin', 'actor', 'target', 'super_admin'), false);
  assert.equal(canManageTarget('super_admin', 'actor', 'target', 'admin'), true);
  assert.equal(canManageTarget('manager', 'actor', 'target', 'cashier', ['manage_users'], ['manage_users']), false);
  assert.equal(canManageTarget('manager', 'actor', 'target', 'cashier', [], ['manage_users']), true);
});

test('nobody may change their own role, permissions, active state, or delete own account', () => {
  const ownUpdate = {
    ...baseChange,
    callerId: 'same',
    targetId: 'same',
    targetRole: 'super_admin' as const,
    targetPermissions: ['pos'],
    nextRole: 'super_admin' as const,
    nextPermissions: ['pos'],
    nextActive: true,
  };
  assert.equal(profileChangeDenial({ ...ownUpdate, action: 'update' }), null);
  assert.match(profileChangeDenial({ ...ownUpdate, action: 'update', nextRole: 'admin' }) ?? '', /own role/);
  assert.match(profileChangeDenial({ ...ownUpdate, action: 'update', nextPermissions: ['reports'] }) ?? '', /own role/);
  assert.match(profileChangeDenial({ ...ownUpdate, action: 'update', nextActive: false }) ?? '', /own role/);
  assert.match(profileChangeDenial({ ...ownUpdate, action: 'delete' }) ?? '', /Cannot delete your own account/);
});

test('a Manage Users holder cannot grant Manage Users or permissions they do not hold', () => {
  assert.match(profileChangeDenial({
    ...baseChange,
    callerRole: 'manager',
    callerPermissions: ['manage_users', 'customers'],
    action: 'update',
    nextRole: 'cashier',
    nextPermissions: ['manage_users'],
    nextActive: true,
  }) ?? '', /Only admin or super_admin/);
  assert.match(profileChangeDenial({
    ...baseChange,
    callerRole: 'manager',
    callerPermissions: ['manage_users', 'customers'],
    action: 'update',
    nextRole: 'cashier',
    nextPermissions: ['reports'],
    nextActive: true,
  }) ?? '', /only grant permissions that you hold/);
});

test('protects the last active admin from deletion, demotion, and deactivation', () => {
  for (const change of [
    { action: 'delete' as const },
    { action: 'update' as const, nextRole: 'cashier' as const, nextActive: true },
    { action: 'update' as const, nextRole: 'admin' as const, nextActive: false },
  ]) {
    assert.match(profileChangeDenial({
      ...baseChange,
      targetRole: 'admin',
      activeAdminCount: 1,
      ...change,
      ...(change.action === 'update' ? { nextPermissions: [] } : {}),
    }) ?? '', /last active admin/);
  }
});

test('protects the last Super Admin including inactive Super Admin deletion rules', () => {
  const deleteLast = profileChangeDenial({
    ...baseChange,
    targetRole: 'super_admin',
    action: 'delete',
    superAdminCount: 1,
    activeSuperAdminCount: 1,
  });
  const demoteLast = profileChangeDenial({
    ...baseChange,
    targetRole: 'super_admin',
    action: 'update',
    nextRole: 'admin',
    nextPermissions: [],
    nextActive: true,
    superAdminCount: 1,
    activeSuperAdminCount: 1,
  });
  const deactivateLast = profileChangeDenial({
    ...baseChange,
    targetRole: 'super_admin',
    action: 'update',
    nextRole: 'super_admin',
    nextPermissions: ['pos'],
    nextActive: false,
    superAdminCount: 2,
    activeSuperAdminCount: 1,
  });
  assert.match(deleteLast ?? '', /last super_admin/);
  assert.match(demoteLast ?? '', /last super_admin/);
  assert.match(deactivateLast ?? '', /last super_admin/);
});

test('Super Admin can assign admin role; admin cannot manage another admin', () => {
  assert.equal(profileChangeDenial({
    ...baseChange,
    action: 'update',
    targetRole: 'cashier',
    nextRole: 'admin',
    nextPermissions: [],
    nextActive: true,
  }), null);
  assert.equal(profileChangeDenial({
    ...baseChange,
    callerRole: 'admin',
    action: 'update',
    targetRole: 'admin',
    nextRole: 'admin',
    nextPermissions: [],
    nextActive: true,
  }), 'You are not allowed to manage this user.');
});
