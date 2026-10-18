import { z } from 'zod';

export const ROLES = ['cashier', 'manager', 'accountant', 'admin'] as const;
export const MODULE_KEYS = [
  'pos',
  'products',
  'categories',
  'suppliers',
  'customers',
  'sales_history',
  'purchase_history',
  'purchases',
  'expenses',
  'stock_inventory',
  'reports',
  'manage_users',
  'stock_alerts',
] as const;
export const POS_PRINT_PERMISSION_KEYS = ['pos_print_sale', 'pos_print_payment'] as const;
export const PERMISSION_KEYS = [...MODULE_KEYS, ...POS_PRINT_PERMISSION_KEYS] as const;

export const roleSchema = z.enum(ROLES);
export const permissionSchema = z.enum(PERMISSION_KEYS);
export const permissionsSchema = z.array(permissionSchema).max(PERMISSION_KEYS.length);

export type Role = (typeof ROLES)[number];
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export function normalizePermissions(permissions: readonly PermissionKey[]): PermissionKey[] {
  const unique = [...new Set(permissions)];
  return unique.includes('pos')
    ? unique
    : unique.filter((permission) => !POS_PRINT_PERMISSION_KEYS.includes(
      permission as (typeof POS_PRINT_PERMISSION_KEYS)[number],
    ));
}

export function effectivePermissions(role: Role, permissions: readonly PermissionKey[]): PermissionKey[] {
  return role === 'admin' ? [...MODULE_KEYS] : [...permissions];
}
