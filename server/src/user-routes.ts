import { ObjectId } from 'mongodb';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from './auth-routes.js';
import { hashPassword } from './auth-crypto.js';
import type { AuditRecord, PharmacyRepository, UserRecord } from './models.js';
import {
  MODULE_KEYS,
  PERMISSION_KEYS,
  permissionsSchema,
  roleSchema,
  type PermissionKey,
  type Role,
} from './permissions.js';
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

const MAX_USERS = 99;
const usernameSchema = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}._-]+$/u);
const emailSchema = z.string().trim().email().max(254);
const fullNameSchema = z.string().trim().min(1).max(160);
const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
const createSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  fullName: fullNameSchema,
  password: z.string().min(8).max(1024),
  role: roleSchema,
  permissions: permissionsSchema,
  isActive: z.boolean().optional(),
}).strict();
const updateSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  fullName: fullNameSchema,
  role: roleSchema,
  permissions: permissionsSchema,
  isActive: z.boolean(),
  password: z.never().optional(),
}).strict();
const passwordSchema = z.object({ password: z.string().min(8).max(1024) }).strict();

function validStoredRole(role: unknown): role is Role {
  return roleSchema.safeParse(role).success;
}

function storedPermissions(user: UserRecord): PermissionKey[] {
  return user.role === 'super_admin'
    ? [...MODULE_KEYS]
    : user.permissions.filter((permission) => PERMISSION_KEYS.includes(permission));
}

function userDto(user: UserRecord, includeDeletedAt = false) {
  return {
    id: user._id.toHexString(),
    shopId: user.shopId.toHexString(),
    username: user.username,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    isActive: user.isActive,
    permissions: storedPermissions(user),
    ...(includeDeletedAt ? { deletedAt: user.deletedAt?.toISOString() ?? null } : {}),
  };
}

function audit(
  actor: UserRecord,
  targetId: ObjectId | undefined,
  event: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  now: Date,
): AuditRecord {
  return {
    shopId: actor.shopId,
    actorId: actor._id,
    ...(targetId ? { entityId: targetId } : {}),
    event,
    entityType: 'user',
    before,
    after,
    occurredAt: now,
  };
}

function canManageUsers(user: UserRecord): boolean {
  return validStoredRole(user.role) && canUseManageUsers(user.role, user.permissions);
}

function ensureManager(request: FastifyRequest, reply: FastifyReply): UserRecord | null {
  const caller = request.authUser;
  if (!caller) {
    void reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return null;
  }
  if (!canManageUsers(caller)) {
    void reply.code(403).send({ error: 'FORBIDDEN' });
    return null;
  }
  return caller;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function profileSnapshot(user: UserRecord): Record<string, unknown> {
  return {
    username: user.username,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    permissions: storedPermissions(user),
    isActive: user.isActive,
    deletedAt: user.deletedAt?.toISOString() ?? null,
  };
}

export function registerUserRoutes(
  app: FastifyInstance,
  repository: PharmacyRepository,
  tokenConfig: import('./auth-crypto.js').TokenConfig,
): void {
  const protectedRoute = {
    preHandler: [
      requireAuth(repository, tokenConfig),
      requirePermission('manage_users'),
    ],
  };
  app.get('/api/users', protectedRoute, async (request, reply) => {
    const caller = ensureManager(request, reply);
    if (!caller) return;
    const users = await repository.listUsers(caller.shopId, false);
    const visibleUsers = users.filter((user) => caller.role === 'super_admin' || user.role !== 'super_admin');
    const callerPermissions = caller.permissions.filter((permission) => PERMISSION_KEYS.includes(permission));
    return reply.send({
      users: visibleUsers
        .filter((user) => validStoredRole(user.role))
        .map((user) => ({
          ...userDto(user),
          can_manage: canManageTarget(
            caller.role,
            caller._id.toHexString(),
            user._id.toHexString(),
            user.role,
            storedPermissions(user),
            callerPermissions,
          ),
        })),
      userLimit: MAX_USERS,
      currentCount: visibleUsers.length,
      assignable_roles: assignableRolesFor(caller.role, callerPermissions),
      grantable_permissions: grantablePermissionsFor(caller.role, callerPermissions, PERMISSION_KEYS),
    });
  });

  app.get('/api/users/deleted', protectedRoute, async (request, reply) => {
    const caller = ensureManager(request, reply);
    if (!caller) return;
    if (caller.role !== 'admin' && caller.role !== 'super_admin') {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    const users = await repository.listUsers(caller.shopId, true);
    return reply.send({
      users: users
        .filter((user) => user.deletedAt !== null)
        .filter((user) => caller.role === 'super_admin' || user.role !== 'super_admin')
        .sort((left, right) => (right.deletedAt?.getTime() ?? 0) - (left.deletedAt?.getTime() ?? 0))
        .filter((user) => validStoredRole(user.role))
        .map((user) => userDto(user, true)),
    });
  });

  app.post('/api/users', protectedRoute, async (request, reply) => {
    const caller = ensureManager(request, reply);
    if (!caller) return;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const input = parsed.data;
    const callerPermissions = caller.permissions.filter((permission) => PERMISSION_KEYS.includes(permission));
    if (!canAssignRole(caller.role, input.role, callerPermissions)) {
      return reply.code(403).send({ error: 'ROLE_NOT_ASSIGNABLE' });
    }
    const permissions = normalizePolicyPermissions(input.permissions) as PermissionKey[];
    const denied = permissionGrantDenial(caller.role, callerPermissions, permissions);
    if (denied) return reply.code(403).send({ error: 'PERMISSION_GRANT_DENIED', message: denied });

    const now = new Date();
    const id = new ObjectId();
    const user: UserRecord = {
      _id: id,
      shopId: caller.shopId,
      username: input.username,
      usernameNormalized: normalized(input.username),
      email: input.email,
      emailNormalized: normalized(input.email),
      fullName: input.fullName,
      role: input.role,
      isActive: input.isActive !== false,
      permissions: input.role === 'super_admin' ? [...MODULE_KEYS] : permissions,
      passwordHash: await hashPassword(input.password),
      failedLogins: 0,
      lockedUntil: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await repository.withShopTransaction(caller.shopId, async (transaction) => {
        if (await transaction.countUsers(false) >= MAX_USERS) {
          throw new UserRouteError(409, 'USER_LIMIT_REACHED');
        }
        if (await transaction.findDuplicate('usernameNormalized', user.usernameNormalized)) {
          throw new UserRouteError(409, 'USERNAME_TAKEN');
        }
        if (await transaction.findDuplicate('emailNormalized', user.emailNormalized)) {
          throw new UserRouteError(409, 'EMAIL_TAKEN');
        }
        await transaction.insertUser(user);
        await transaction.writeAudit(audit(caller, id, 'user.create', null, profileSnapshot(user), now));
        return true;
      });
    } catch (error) {
      if (error instanceof UserRouteError) return reply.code(error.statusCode).send({ error: error.code });
      if (isDuplicateKeyError(error)) return reply.code(409).send({ error: 'USER_IDENTIFIER_TAKEN' });
      throw error;
    }
    return reply.code(201).send({ message: 'User created successfully.', id: id.toHexString() });
  });

  app.patch('/api/users/:id', protectedRoute, async (request, reply) => {
    const caller = ensureManager(request, reply);
    if (!caller) return;
    const params = z.object({ id: idSchema }).strict().safeParse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const targetId = new ObjectId(params.data.id);
    const input = parsed.data;
    const callerPermissions = caller.permissions.filter((permission) => PERMISSION_KEYS.includes(permission));
    const nextPermissions = normalizePolicyPermissions(input.permissions) as PermissionKey[];
    const now = new Date();
    try {
      const result = await repository.withShopTransaction(caller.shopId, async (transaction) => {
        const target = await transaction.findUser(targetId);
        if (!target || !validStoredRole(target.role)) return { kind: 'not_found' as const };
        if (!canManageTarget(
          caller.role, caller._id.toHexString(), targetId.toHexString(), target.role,
          storedPermissions(target), callerPermissions,
        )) return { kind: 'forbidden' as const };
        if (await transaction.findDuplicate('usernameNormalized', normalized(input.username), targetId)) {
          return { kind: 'username_taken' as const };
        }
        if (await transaction.findDuplicate('emailNormalized', normalized(input.email), targetId)) {
          return { kind: 'email_taken' as const };
        }
        const denial = profileChangeDenial({
          action: 'update',
          callerRole: caller.role,
          callerId: caller._id.toHexString(),
          targetId: targetId.toHexString(),
          targetRole: target.role,
          nextRole: input.role,
          targetPermissions: storedPermissions(target),
          nextPermissions: input.role === 'super_admin' ? [...MODULE_KEYS] : nextPermissions,
          targetActive: target.isActive,
          nextActive: input.isActive,
          activeAdminCount: await transaction.countRole('admin', true),
          superAdminCount: await transaction.countRole('super_admin', false),
          activeSuperAdminCount: await transaction.countRole('super_admin', true),
          callerPermissions,
        });
        if (denial) return { kind: 'policy_denied' as const, message: denial };
        const updated: Partial<UserRecord> = {
          username: input.username,
          usernameNormalized: normalized(input.username),
          email: input.email,
          emailNormalized: normalized(input.email),
          fullName: input.fullName,
          role: input.role,
          permissions: input.role === 'super_admin' ? [...MODULE_KEYS] : nextPermissions,
          isActive: input.isActive,
          updatedAt: now,
        };
        await transaction.updateUser(targetId, updated);
        const after = { ...profileSnapshot(target), ...updated, deletedAt: null };
        await transaction.writeAudit(audit(caller, targetId, 'user.update', profileSnapshot(target), after, now));
        return { kind: 'updated' as const };
      });
      if (result.kind === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' });
      if (result.kind === 'forbidden') return reply.code(403).send({ error: 'FORBIDDEN' });
      if (result.kind === 'username_taken') return reply.code(409).send({ error: 'USERNAME_TAKEN' });
      if (result.kind === 'email_taken') return reply.code(409).send({ error: 'EMAIL_TAKEN' });
      if (result.kind === 'policy_denied') {
        return reply.code(403).send({ error: 'POLICY_DENIED', message: result.message });
      }
    } catch (error) {
      if (isDuplicateKeyError(error)) return reply.code(409).send({ error: 'USER_IDENTIFIER_TAKEN' });
      throw error;
    }
    return reply.send({ message: 'User updated successfully.' });
  });

  app.delete('/api/users/:id', protectedRoute, async (request, reply) => {
    const caller = ensureManager(request, reply);
    if (!caller) return;
    const params = z.object({ id: idSchema }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const targetId = new ObjectId(params.data.id);
    const now = new Date();
    const callerPermissions = caller.permissions.filter((permission) => PERMISSION_KEYS.includes(permission));
    const result = await repository.withShopTransaction(caller.shopId, async (transaction) => {
      const target = await transaction.findUser(targetId);
      if (!target || !validStoredRole(target.role)) return { kind: 'not_found' as const };
      const denial = profileChangeDenial({
        action: 'delete',
        callerRole: caller.role,
        callerId: caller._id.toHexString(),
        targetId: targetId.toHexString(),
        targetRole: target.role,
        targetPermissions: storedPermissions(target),
        targetActive: target.isActive,
        activeAdminCount: await transaction.countRole('admin', true),
        superAdminCount: await transaction.countRole('super_admin', false),
        activeSuperAdminCount: await transaction.countRole('super_admin', true),
        callerPermissions,
      });
      if (denial) return { kind: 'denied' as const, message: denial };
      const before = profileSnapshot(target);
      await transaction.updateUser(targetId, { isActive: false, deletedAt: now, updatedAt: now });
      await transaction.writeTrash({
        shopId: caller.shopId,
        actorId: caller._id,
        entityId: targetId,
        action: 'deleted',
        displayName: target.fullName || target.username || target.email,
        role: target.role,
        occurredAt: now,
      });
      await transaction.writeAudit(audit(caller, targetId, 'user.delete', before, {
        ...before,
        isActive: false,
        deletedAt: now.toISOString(),
      }, now));
      return { kind: 'deleted' as const };
    });
    if (result.kind === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' });
    if (result.kind === 'denied') return reply.code(403).send({ error: 'POLICY_DENIED', message: result.message });
    return reply.send({ message: 'User moved to Trash Bin.' });
  });

  app.post('/api/users/:id/restore', protectedRoute, async (request, reply) => {
    const caller = ensureManager(request, reply);
    if (!caller) return;
    if (caller.role !== 'admin' && caller.role !== 'super_admin') {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    const params = z.object({ id: idSchema }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const targetId = new ObjectId(params.data.id);
    const now = new Date();
    const callerPermissions = caller.permissions.filter((permission) => PERMISSION_KEYS.includes(permission));
    const result = await repository.withShopTransaction(caller.shopId, async (transaction) => {
      const target = await transaction.findUser(targetId, true);
      if (!target || !validStoredRole(target.role)) return { kind: 'not_found' as const };
      if (!canManageTarget(
        caller.role, caller._id.toHexString(), targetId.toHexString(), target.role,
        storedPermissions(target), callerPermissions,
      )) return { kind: 'forbidden' as const };
      if (target.deletedAt === null) return { kind: 'not_deleted' as const };
      if (await transaction.countUsers(false) >= MAX_USERS) return { kind: 'limit' as const };
      await transaction.updateUser(targetId, { deletedAt: null, isActive: true, updatedAt: now });
      await transaction.writeTrash({
        shopId: caller.shopId,
        actorId: caller._id,
        entityId: targetId,
        action: 'restored',
        displayName: target.fullName || target.username || target.email,
        role: target.role,
        occurredAt: now,
      });
      await transaction.writeAudit(audit(caller, targetId, 'user.restore', profileSnapshot(target), {
        ...profileSnapshot(target),
        isActive: true,
        deletedAt: null,
      }, now));
      return { kind: 'restored' as const };
    });
    if (result.kind === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' });
    if (result.kind === 'forbidden') return reply.code(403).send({ error: 'FORBIDDEN' });
    if (result.kind === 'not_deleted') return reply.code(400).send({ error: 'USER_NOT_DELETED' });
    if (result.kind === 'limit') return reply.code(409).send({ error: 'USER_LIMIT_REACHED' });
    return reply.send({ message: 'User restored successfully.' });
  });

  app.post('/api/users/:id/reset-password', protectedRoute, async (request, reply) => {
    const caller = ensureManager(request, reply);
    if (!caller) return;
    const params = z.object({ id: idSchema }).strict().safeParse(request.params);
    const parsed = passwordSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const targetId = new ObjectId(params.data.id);
    const callerPermissions = caller.permissions.filter((permission) => PERMISSION_KEYS.includes(permission));
    const passwordHash = await hashPassword(parsed.data.password);
    const now = new Date();
    const result = await repository.withShopTransaction(caller.shopId, async (transaction) => {
      const target = await transaction.findUser(targetId);
      if (!target || !validStoredRole(target.role) || !canManageTarget(
        caller.role,
        caller._id.toHexString(),
        targetId.toHexString(),
        target.role,
        storedPermissions(target),
        callerPermissions,
      )) return { kind: 'not_found' as const };
      const before = { role: target.role, permissions: storedPermissions(target) };
      await transaction.updateUser(targetId, {
        passwordHash,
        failedLogins: 0,
        lockedUntil: null,
        updatedAt: now,
      });
      await transaction.writeAudit(audit(caller, targetId, 'user.reset_password', before, before, now));
      return { kind: 'updated' as const };
    });
    if (result.kind === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send({ message: 'Password reset successfully.' });
  });
}

class UserRouteError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
  }
}
