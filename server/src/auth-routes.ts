import { createHmac, randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createAccessToken,
  hashPassword,
  hashRefreshToken,
  newRefreshToken,
  userDto,
  verifyAccessToken,
  verifyPassword,
  type TokenConfig,
} from './auth-crypto.js';
import type { AuditRecord, PharmacyRepository, RefreshSessionRecord, UserRecord } from './models.js';
import { MODULE_KEYS, permissionSchema, type PermissionKey, type Role } from './permissions.js';
import {
  beginWriteIdempotency,
  requestUsesIdempotency,
  validateIdempotencyHeader,
  type IdempotencyStore,
} from './idempotency.js';
import { LOGIN_RATE_LIMIT } from './security.js';

const loginSchema = z.object({
  shopSlug: z.string().trim().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/),
  usernameOrEmail: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
}).strict();
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(8).max(1024),
}).strict();

const REFRESH_COOKIE = 'pharma_refresh';
const RATE_WINDOW_MS = 60_000;
const FAILURE_LIMIT = 5;
const LOCK_DURATION_MS = 15 * 60_000;
let dummyHashPromise: Promise<string> | undefined;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHashPromise;
}

function safePermissions(user: UserRecord): PermissionKey[] {
  if (user.role === 'admin') return [...MODULE_KEYS];
  return user.permissions.filter((permission) => permissionSchema.safeParse(permission).success);
}

function issuePublicAuth(user: UserRecord, shopName: string, config: TokenConfig) {
  const id = user._id.toHexString();
  const shopId = user.shopId.toHexString();
  const access = createAccessToken({ id, shopId, role: user.role }, config);
  return {
    accessToken: access.token,
    expiresInSeconds: config.accessTokenTtlSeconds,
    user: userDto({
      id,
      shopId,
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      permissions: safePermissions(user),
      isActive: user.isActive,
    }),
    shop: { id: shopId, name: shopName },
  };
}

function auditEvent(
  event: string,
  user?: UserRecord | null,
  extra: Pick<AuditRecord, 'before' | 'after'> = {},
  now = new Date(),
): AuditRecord {
  return {
    event,
    entityType: 'auth',
    ...(user ? { shopId: user.shopId, actorId: user._id, entityId: user._id } : {}),
    occurredAt: now,
    ...extra,
  };
}

function setRefreshCookie(reply: FastifyReply, token: string, ttlSeconds: number): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: ttlSeconds,
  });
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/api/auth',
  });
}

function clientRateKey(request: FastifyRequest, pepper: string, now: Date): { key: string; expiresAt: Date } {
  const window = Math.floor(now.getTime() / RATE_WINDOW_MS);
  const key = createHmac('sha256', pepper)
    .update(`${request.ip}:${window}`)
    .digest('hex');
  return { key, expiresAt: new Date((window + 2) * RATE_WINDOW_MS) };
}

async function authenticateRequest(
  request: FastifyRequest,
  repository: PharmacyRepository,
  tokenConfig: TokenConfig,
): Promise<UserRecord | null> {
  const authorization = request.headers.authorization;
  const accessToken = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!accessToken) return null;
  const claims = verifyAccessToken(accessToken, tokenConfig.accessSecret);
  if (!claims) return null;
  const id = new ObjectId(claims.sub);
  const user = await repository.findUserById(id);
  if (
    !user ||
    !user.isActive ||
    user.deletedAt !== null ||
    user.shopId.toHexString() !== claims.shopId
  ) return null;
  const shop = await repository.findShopById(user.shopId);
  if (!shop || shop.status !== 'ACTIVE') return null;
  return user;
}

export function requireAuth(
  repository: PharmacyRepository,
  tokenConfig: TokenConfig,
  idempotencyStore?: IdempotencyStore,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    if (reply.sent) return;
    request.authUser = await authenticateRequest(request, repository, tokenConfig);
    if (!request.authUser) {
      await reply.code(401).send({ error: 'UNAUTHENTICATED' });
      return;
    }
    if (!requestUsesIdempotency(request)) return;
    const validationError = validateIdempotencyHeader(request);
    if (validationError) {
      await reply.code(400).send({ error: validationError });
      return;
    }
    if (!idempotencyStore) throw new Error('Idempotency store is not configured');
    const shouldContinue = await beginWriteIdempotency(
      request,
      reply,
      request.authUser.shopId,
      idempotencyStore,
    );
    if (!shouldContinue) return;
  };
}

export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (reply.sent) return;
    if (!request.authUser) {
      await reply.code(401).send({ error: 'UNAUTHENTICATED' });
      return;
    }
    if (!roles.includes(request.authUser.role)) {
      await reply.code(403).send({ error: 'FORBIDDEN' });
    }
  };
}

export function requirePermission(permission: PermissionKey) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (reply.sent) return;
    if (!request.authUser) {
      await reply.code(401).send({ error: 'UNAUTHENTICATED' });
      return;
    }
    const permissions: readonly PermissionKey[] =
      request.authUser.role === 'admin'
      ? [
        ...MODULE_KEYS,
        ...safePermissions(request.authUser).filter((permission) =>
          permission === 'pos_print_sale' || permission === 'pos_print_payment',
        ),
      ]
      : safePermissions(request.authUser);
    if (!permissions.includes(permission)) {
      await reply.code(403).send({ error: 'FORBIDDEN' });
    }
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  repository: PharmacyRepository,
  tokenConfig: TokenConfig,
  idempotencyStore: IdempotencyStore,
): void {
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });

    const now = new Date();
    const rate = clientRateKey(request, tokenConfig.refreshPepper, now);
    const attempts = await repository.consumeLoginRateLimit(rate.key, rate.expiresAt);
    if (attempts > LOGIN_RATE_LIMIT) {
      await repository.writeAudit(auditEvent('auth.login.rate_limited', null, {}, now));
      return reply.code(429).send({ error: 'RATE_LIMITED' });
    }

    const input = parsed.data;
    const shop = await repository.findShopBySlug(input.shopSlug.toLowerCase());
    const normalized = input.usernameOrEmail.toLowerCase();
    const user = shop?.status === 'ACTIVE'
      ? await repository.findUserByLogin(shop._id, normalized)
      : null;
    if (user) await repository.clearExpiredLock(user._id, now);
    if (user?.lockedUntil && user.lockedUntil.getTime() <= now.getTime()) {
      user.failedLogins = 0;
      user.lockedUntil = null;
    }
    const hash = user?.passwordHash ?? await dummyHash();
    let passwordMatches = false;
    try {
      passwordMatches = await verifyPassword(hash, input.password);
    } catch {
      request.log.error({ event: 'password_hash_verification_failed' });
    }

    const isLocked = user?.lockedUntil !== null
      && user?.lockedUntil !== undefined
      && user.lockedUntil.getTime() > now.getTime();
    if (!shop || shop.status !== 'ACTIVE' || !user || !user.isActive || user.deletedAt !== null
      || isLocked || !passwordMatches) {
      if (user && !isLocked) {
        await repository.recordLoginFailure(user._id, now, FAILURE_LIMIT, LOCK_DURATION_MS);
      }
      await repository.writeAudit(auditEvent(
        'auth.login.failure',
        user,
        { after: { reason: isLocked ? 'locked' : 'invalid_credentials' } },
        now,
      ));
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    await repository.clearLoginFailures(user._id, now);
    const refreshToken = newRefreshToken();
    const session: RefreshSessionRecord = {
      _id: new ObjectId(),
      shopId: user.shopId,
      userId: user._id,
      tokenHash: hashRefreshToken(refreshToken, tokenConfig.refreshPepper),
      familyId: new ObjectId(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + tokenConfig.refreshTokenTtlSeconds * 1000),
    };
    await repository.createLoginSession(session, auditEvent('auth.login.success', user, {}, now));
    setRefreshCookie(reply, refreshToken, tokenConfig.refreshTokenTtlSeconds);
    return reply.send(issuePublicAuth(user, shop.name, tokenConfig));
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (!token || token.length > 256) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    }
    const now = new Date();
    const oldSession = await repository.findRefreshSessionByHash(
      hashRefreshToken(token, tokenConfig.refreshPepper),
    );
    if (!oldSession) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    }
    if (oldSession.rotatedAt || oldSession.revokedAt) {
      await repository.revokeRefreshFamily(
        oldSession.familyId,
        now,
        'refresh_reuse',
        auditEvent('auth.refresh.reuse_detected', null, {
          after: { familyId: oldSession.familyId.toHexString() },
        }, now),
      );
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    }
    if (oldSession.expiresAt.getTime() <= now.getTime()) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    }

    const user = await repository.findUserById(oldSession.userId);
    const shop = await repository.findShopById(oldSession.shopId);
    if (!user || !user.isActive || user.deletedAt !== null || !shop || shop.status !== 'ACTIVE'
      || !user.shopId.equals(oldSession.shopId)) {
      await repository.revokeRefreshFamily(
        oldSession.familyId,
        now,
        'account_unavailable',
        auditEvent('auth.refresh.denied', user, {}, now),
      );
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    }

    const refreshToken = newRefreshToken();
    const replacement: RefreshSessionRecord = {
      _id: new ObjectId(),
      shopId: oldSession.shopId,
      userId: oldSession.userId,
      tokenHash: hashRefreshToken(refreshToken, tokenConfig.refreshPepper),
      familyId: oldSession.familyId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + tokenConfig.refreshTokenTtlSeconds * 1000),
    };
    const rotated = await repository.rotateLoginSession(
      oldSession,
      replacement,
      now,
      auditEvent('auth.refresh.rotated', user, {}, now),
    );
    if (!rotated) {
      await repository.revokeRefreshFamily(
        oldSession.familyId,
        now,
        'refresh_reuse',
        auditEvent('auth.refresh.reuse_detected', null, {
          after: { familyId: oldSession.familyId.toHexString() },
        }, now),
      );
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    }

    setRefreshCookie(reply, refreshToken, tokenConfig.refreshTokenTtlSeconds);
    return reply.send(issuePublicAuth(user, shop.name, tokenConfig));
  });

  app.post('/api/auth/logout', {
    preHandler: requireAuth(repository, tokenConfig, idempotencyStore),
  }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const token = request.cookies[REFRESH_COOKIE];
    if (token && token.length <= 256) {
      const session = await repository.findRefreshSessionByHash(
        hashRefreshToken(token, tokenConfig.refreshPepper),
      );
      if (session && session.userId.equals(user._id) && session.shopId.equals(user.shopId)) {
        await repository.logoutRefreshSession(
          session,
          new Date(),
          auditEvent('auth.logout', user),
        );
      } else {
        await repository.writeAudit(auditEvent('auth.logout', user));
      }
    } else {
      await repository.writeAudit(auditEvent('auth.logout', user));
    }
    clearRefreshCookie(reply);
    return reply.send({ ok: true });
  });

  app.post('/api/auth/password', {
    preHandler: requireAuth(repository, tokenConfig, idempotencyStore),
  }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const result = await repository.withShopTransaction(user.shopId, async (transaction) => {
      const current = await transaction.findUser(user._id);
      if (!current || !current.isActive || current.deletedAt !== null) return 'not_found' as const;
      if (!await verifyPassword(current.passwordHash, parsed.data.currentPassword)) return 'invalid_password' as const;
      const now = new Date();
      const passwordHash = await hashPassword(parsed.data.newPassword);
      await transaction.updateUser(current._id, { passwordHash, updatedAt: now });
      await transaction.writeAudit(auditEvent('auth.password_changed', current, {
        before: { updatedAt: current.updatedAt.toISOString() },
        after: { updatedAt: now.toISOString() },
      }, now));
      return 'changed' as const;
    });
    if (result === 'not_found') return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    if (result === 'invalid_password') return reply.code(403).send({ error: 'INVALID_CURRENT_PASSWORD' });
    return reply.send({ message: 'Password changed successfully.' });
  });

  app.get('/api/auth/me', {
    preHandler: requireAuth(repository, tokenConfig, idempotencyStore),
  }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const shop = await repository.findShopById(user.shopId);
    if (!shop || shop.status !== 'ACTIVE') return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return reply.send({
      user: userDto({
        id: user._id.toHexString(),
        shopId: user.shopId.toHexString(),
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        permissions: safePermissions(user),
        isActive: user.isActive,
      }),
      shop: { id: shop._id.toHexString(), name: shop.name },
    });
  });
}
