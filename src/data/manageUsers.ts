import { apiRequest } from '../api';
import type { PermissionKey } from '../permissions';
import type { UserRole } from '../types/pharmacy';

interface ManagedUserDto {
  id: string;
  username: string;
  email: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  permissions: PermissionKey[];
  can_manage: boolean;
}

interface ManagedUserListDto {
  users: ManagedUserDto[];
  userLimit: number;
  currentCount: number;
  assignable_roles: UserRole[];
  grantable_permissions: PermissionKey[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function parseRole(value: unknown): value is UserRole {
  return value === 'cashier' || value === 'manager' || value === 'accountant'
    || value === 'admin' || value === 'super_admin';
}

function parsePermission(value: unknown): value is PermissionKey {
  return typeof value === 'string'
    && ['pos', 'products', 'categories', 'suppliers', 'customers', 'sales_history',
      'purchase_history', 'purchases', 'expenses', 'stock_inventory', 'reports',
      'manage_users', 'pos_print_sale', 'pos_print_payment', 'stock_alerts'].includes(value);
}

function parseManagedUser(value: unknown): ManagedUserDto {
  const keys = ['id', 'shopId', 'username', 'email', 'fullName', 'role', 'isActive', 'permissions', 'can_manage'];
  if (!isRecord(value) || !exactKeys(value, keys)
    || typeof value.id !== 'string' || typeof value.username !== 'string'
    || typeof value.email !== 'string' || typeof value.fullName !== 'string'
    || !parseRole(value.role) || typeof value.isActive !== 'boolean'
    || !Array.isArray(value.permissions) || !value.permissions.every(parsePermission)
    || typeof value.can_manage !== 'boolean') {
    throw new Error('The user service returned an invalid response.');
  }
  return {
    id: value.id,
    username: value.username,
    email: value.email,
    fullName: value.fullName,
    role: value.role,
    isActive: value.isActive,
    permissions: value.permissions,
    can_manage: value.can_manage,
  };
}

function parseUserList(value: unknown): ManagedUserListDto {
  const keys = ['users', 'userLimit', 'currentCount', 'assignable_roles', 'grantable_permissions'];
  if (!isRecord(value) || !exactKeys(value, keys)
    || !Array.isArray(value.users) || !Array.isArray(value.assignable_roles)
    || !value.assignable_roles.every(parseRole)
    || !Array.isArray(value.grantable_permissions) || !value.grantable_permissions.every(parsePermission)
    || !Number.isSafeInteger(value.userLimit) || !Number.isSafeInteger(value.currentCount)
    || Number(value.userLimit) < 1 || Number(value.currentCount) < 0) {
    throw new Error('The user service returned an invalid response.');
  }
  return {
    users: value.users.map(parseManagedUser),
    userLimit: Number(value.userLimit),
    currentCount: Number(value.currentCount),
    assignable_roles: value.assignable_roles,
    grantable_permissions: value.grantable_permissions,
  };
}

function parseMessage(value: unknown): { message: string } {
  if (!isRecord(value) || typeof value.message !== 'string') {
    throw new Error('The user service returned an invalid response.');
  }
  return { message: value.message };
}

export async function invokeManageUsersApi<T>(body: Record<string, unknown>): Promise<T> {
  const action = body.action;
  if (action === 'list') {
    const result = parseUserList(await apiRequest<unknown>('/api/users'));
    return {
      users: result.users.map((user) => ({
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.fullName,
        role: user.role,
        is_active: user.isActive,
        permissions: user.permissions,
        can_manage: user.can_manage,
      })),
      currentCount: result.currentCount,
      assignable_roles: result.assignable_roles,
      grantable_permissions: result.grantable_permissions,
    } as T;
  }
  if (action === 'create') {
    return await apiRequest<unknown>('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: body.username,
        email: body.email,
        fullName: body.full_name,
        password: body.password,
        role: body.role,
        permissions: body.permissions,
        isActive: body.is_active,
      }),
    }).then((result) => parseMessage(result)) as T;
  }
  if (action === 'update') {
    if (typeof body.id !== 'string') throw new Error('A user ID is required.');
    return await apiRequest<unknown>(`/api/users/${encodeURIComponent(body.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        username: body.username,
        email: body.email,
        fullName: body.full_name,
        role: body.role,
        permissions: body.permissions,
        isActive: body.is_active,
      }),
    }).then((result) => parseMessage(result)) as T;
  }
  if (action === 'reset_password') {
    if (typeof body.id !== 'string') throw new Error('A user ID is required.');
    return await apiRequest<unknown>(`/api/users/${encodeURIComponent(body.id)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password: body.password }),
    }).then((result) => parseMessage(result)) as T;
  }
  if (action === 'delete' || action === 'restore') {
    if (typeof body.id !== 'string') throw new Error('A user ID is required.');
    const path = `/api/users/${encodeURIComponent(body.id)}${action === 'restore' ? '/restore' : ''}`;
    return await apiRequest<unknown>(path, {
      method: action === 'delete' ? 'DELETE' : 'POST',
    }).then((result) => parseMessage(result)) as T;
  }
  throw new Error('Unsupported user-management action.');
}

export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
  const response = await apiRequest<unknown>('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  parseMessage(response);
}
