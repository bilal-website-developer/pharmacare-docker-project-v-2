import { MODULE_KEYS, POS_PRINT_PERMISSION_KEYS, ROLES, type Role } from './permissions.js';

export { ROLES };
export type { Role };

export function normalizePolicyPermissions(permissions: readonly string[]): string[] {
  const unique = [...new Set(permissions)];
  return unique.includes('pos')
    ? unique
    : unique.filter((permission) =>
      !POS_PRINT_PERMISSION_KEYS.includes(permission as (typeof POS_PRINT_PERMISSION_KEYS)[number]),
    );
}

export function canUseManageUsers(callerRole: Role, callerPermissions: readonly string[]): boolean {
  return callerRole === 'admin' || callerRole === 'super_admin'
    || callerPermissions.includes('manage_users');
}

const ROLE_LEVEL: Record<Role, number> = {
  cashier: 0,
  manager: 1,
  accountant: 1,
  admin: 2,
  super_admin: 3,
};

export function assignableRolesFor(callerRole: Role, callerPermissions: readonly string[] = []): Role[] {
  return callerRole === 'super_admin'
    ? [...ROLES]
    : callerRole === 'admin'
      ? ['cashier', 'manager', 'accountant']
      : callerPermissions.includes('manage_users')
        ? ['cashier', 'manager', 'accountant']
        : [];
}

export function canAssignRole(
  callerRole: Role,
  role: Role,
  callerPermissions: readonly string[] = [],
): boolean {
  return assignableRolesFor(callerRole, callerPermissions).includes(role);
}

export function grantablePermissionsFor(
  callerRole: Role,
  callerPermissions: readonly string[],
  permissionKeys: readonly string[],
): string[] {
  if (callerRole === 'admin' || callerRole === 'super_admin') return [...permissionKeys];
  if (!callerPermissions.includes('manage_users')) return [];
  return callerPermissions.filter((permission) => permission !== 'manage_users');
}

export function permissionGrantDenial(
  callerRole: Role,
  callerPermissions: readonly string[],
  requestedPermissions: readonly string[],
  currentPermissions: readonly string[] = [],
): string | null {
  if (callerRole === 'admin' || callerRole === 'super_admin') return null;
  if (!callerPermissions.includes('manage_users')) return 'You do not have permission to manage users.';
  if (requestedPermissions.includes('manage_users') && !currentPermissions.includes('manage_users')) {
    return 'Only admin or super_admin may grant Manage Users.';
  }
  if (requestedPermissions.some((permission) =>
    !callerPermissions.includes(permission) && !currentPermissions.includes(permission),
  )) {
    return 'You may only grant permissions that you hold.';
  }
  return null;
}

export function canManageTarget(
  callerRole: Role,
  callerId: string,
  targetId: string,
  targetRole: Role,
  targetPermissions: readonly string[] = [],
  callerPermissions: readonly string[] = [],
): boolean {
  if (callerId === targetId) return true;
  if (callerRole === 'super_admin') return true;
  if (callerRole === 'admin') return ROLE_LEVEL[targetRole] < ROLE_LEVEL.admin;
  return callerPermissions.includes('manage_users')
    && ROLE_LEVEL[targetRole] < ROLE_LEVEL.admin
    && !targetPermissions.includes('manage_users');
}

interface ProfileChangePolicy {
  action: 'update' | 'delete';
  callerRole: Role;
  callerId: string;
  targetId: string;
  targetRole: Role;
  nextRole?: Role;
  targetPermissions: readonly string[];
  nextPermissions?: readonly string[];
  targetActive: boolean;
  nextActive?: boolean;
  activeAdminCount: number;
  superAdminCount: number;
  activeSuperAdminCount: number;
  callerPermissions?: readonly string[];
}

function samePermissions(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return new Set(left).size === rightSet.size && left.every((permission) => rightSet.has(permission));
}

export function profileChangeDenial(change: ProfileChangePolicy): string | null {
  const isSelf = change.callerId === change.targetId;
  if (change.action === 'delete' && isSelf) return 'Cannot delete your own account.';

  if (change.action === 'update') {
    const nextRole = change.nextRole;
    const nextPermissions = change.nextPermissions ?? [];
    const nextActive = change.nextActive;
    if (!nextRole || nextActive === undefined) return 'Profile role and active status are required.';
    if (isSelf && (
      nextRole !== change.targetRole
      || !samePermissions(nextPermissions, change.targetPermissions)
      || nextActive !== change.targetActive
    )) {
      return 'Cannot change your own role, permissions, or active status.';
    }
    if (nextRole !== change.targetRole && !canAssignRole(change.callerRole, nextRole, change.callerPermissions)) {
      return 'You are not allowed to assign this role.';
    }
    const permissionDenial = permissionGrantDenial(
      change.callerRole,
      change.callerPermissions ?? [],
      nextPermissions,
      change.targetPermissions,
    );
    if (permissionDenial) return permissionDenial;
  }

  if (!canManageTarget(
    change.callerRole,
    change.callerId,
    change.targetId,
    change.targetRole,
    change.targetPermissions,
    change.callerPermissions,
  )) {
    return 'You are not allowed to manage this user.';
  }

  const nextRole = change.nextRole ?? change.targetRole;
  const isDemoting = nextRole !== change.targetRole;
  const isDeactivating = change.nextActive === false && change.targetActive;
  if (change.targetRole === 'admin' && change.activeAdminCount <= 1
    && ((change.targetActive && (change.action === 'delete' || isDemoting)) || isDeactivating)) {
    return change.action === 'delete'
      ? 'Cannot delete the last active admin.'
      : 'Cannot demote or deactivate the last active admin.';
  }
  if (change.targetRole === 'super_admin') {
    if (change.action === 'delete'
      && (change.superAdminCount <= 1 || (change.targetActive && change.activeSuperAdminCount <= 1))) {
      return 'Cannot delete the last super_admin.';
    }
    if (isDemoting && (change.superAdminCount <= 1 || (change.targetActive && change.activeSuperAdminCount <= 1))) {
      return 'Cannot demote the last super_admin.';
    }
    if (isDeactivating && change.activeSuperAdminCount <= 1) {
      return 'Cannot deactivate the last super_admin.';
    }
  }
  return null;
}

export const POLICY_PERMISSION_KEYS = [...MODULE_KEYS, ...POS_PRINT_PERMISSION_KEYS] as const;
