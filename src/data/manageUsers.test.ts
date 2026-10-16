import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import { changeOwnPassword, invokeManageUsersApi } from './manageUsers';

const originalFetch = globalThis.fetch;
const userId = '507f1f77bcf86cd799439011';

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('lists users and translates the API DTO into the existing view model', async () => {
  globalThis.fetch = async () => Response.json({
    users: [{
      id: userId,
      shopId: '507f1f77bcf86cd799439012',
      username: 'cashier',
      email: 'cashier@example.test',
      fullName: 'Test Cashier',
      role: 'cashier',
      isActive: true,
      permissions: ['pos', 'stock_alerts'],
      can_manage: false,
    }],
    userLimit: 99,
    currentCount: 1,
    assignable_roles: ['cashier', 'manager'],
    grantable_permissions: ['pos', 'stock_alerts'],
  });

  const result = await invokeManageUsersApi<{
    users: Array<Record<string, unknown>>;
    currentCount: number;
    assignable_roles: string[];
    grantable_permissions: string[];
  }>({ action: 'list' });

  assert.deepEqual(result, {
    users: [{
      id: userId,
      username: 'cashier',
      email: 'cashier@example.test',
      full_name: 'Test Cashier',
      role: 'cashier',
      is_active: true,
      permissions: ['pos', 'stock_alerts'],
      can_manage: false,
    }],
    currentCount: 1,
    assignable_roles: ['cashier', 'manager'],
    grantable_permissions: ['pos', 'stock_alerts'],
  });
});

test('rejects user list DTOs containing unexpected fields', async () => {
  globalThis.fetch = async () => Response.json({
    users: [{
      id: userId,
      shopId: '507f1f77bcf86cd799439012',
      username: 'cashier',
      email: 'cashier@example.test',
      fullName: 'Test Cashier',
      role: 'cashier',
      isActive: true,
      permissions: ['pos'],
      can_manage: false,
      passwordHash: 'must-not-be-returned',
    }],
    userLimit: 99,
    currentCount: 1,
    assignable_roles: ['cashier'],
    grantable_permissions: ['pos'],
  });

  await assert.rejects(invokeManageUsersApi({ action: 'list' }), /invalid response/i);
});

test('maps user mutations to API routes with idempotency keys and changes own password', async () => {
  const calls: Array<{ path: string; method: string; body: unknown; key: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      path: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
      key: headers.get('Idempotency-Key'),
    });
    return Response.json({ message: 'User saved.' });
  };

  await invokeManageUsersApi({
    action: 'create',
    username: 'new-user',
    email: 'new@example.test',
    full_name: 'New User',
    password: 'strong-password',
    role: 'cashier',
    permissions: ['pos'],
    is_active: true,
  });
  await invokeManageUsersApi({
    action: 'update',
    id: userId,
    username: 'edited-user',
    email: 'edited@example.test',
    full_name: 'Edited User',
    role: 'manager',
    permissions: ['pos', 'products'],
    is_active: false,
  });
  await invokeManageUsersApi({ action: 'reset_password', id: userId, password: 'new-password' });
  await invokeManageUsersApi({ action: 'delete', id: userId });
  await changeOwnPassword('old-password', 'new-password');

  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    ['/api/users', 'POST'],
    [`/api/users/${userId}`, 'PATCH'],
    [`/api/users/${userId}/reset-password`, 'POST'],
    [`/api/users/${userId}`, 'DELETE'],
    ['/api/auth/password', 'POST'],
  ]);
  assert.deepEqual(calls[0].body, {
    username: 'new-user',
    email: 'new@example.test',
    fullName: 'New User',
    password: 'strong-password',
    role: 'cashier',
    permissions: ['pos'],
    isActive: true,
  });
  assert.deepEqual(calls[1].body, {
    username: 'edited-user',
    email: 'edited@example.test',
    fullName: 'Edited User',
    role: 'manager',
    permissions: ['pos', 'products'],
    isActive: false,
  });
  assert.ok(calls.every(({ key }) => key && /^[0-9a-f-]{36}$/i.test(key)));
});
