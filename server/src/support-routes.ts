import { createHash, randomInt, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MongoClient, ObjectId, type Collection } from 'mongodb';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { requireAuth } from './auth-routes.js';
import type { LocalControlPlaneRecord } from './licence-guard.js';
import type { AuditRecord, PharmacyRepository } from './models.js';
import type { IdempotencyStore } from './idempotency.js';
import { sendControlPlaneHeartbeat } from './control-plane.js';

type SupportScope = 'diagnostics' | 'read_only' | 'admin_actions';
type SupportSessionRecord = {
  _id: ObjectId;
  externalSessionId: string;
  controlPlaneShopId: string;
  shopId: ObjectId;
  scope: SupportScope;
  codeHash: string;
  tokenHash: string | null;
  expiresAt: Date;
  approvedBy: ObjectId;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
};

type SupportTokenClaims = {
  sub: string;
  shop_id: string;
  scope: SupportScope;
  issued_at: string;
  expires_at: string;
};

export type SupportRouteOptions = {
  fetcher?: typeof fetch;
  now?: () => Date;
  collections?: Partial<{
    supportSessions: string;
    controlPlaneState: string;
    auditLogs: string;
  }>;
};

type MaskedDiagnosticsInput = {
  generatedAt: string;
  appVersion: string;
  database: string;
  licence: string;
  lastHeartbeatAt: string | null;
  counts: { users: number; products: number; sales: number; purchases: number };
};

const allowSchema = z.object({ scope: z.enum(['diagnostics', 'read_only', 'admin_actions']) }).strict();
const endSchema = z.object({ sessionId: z.string().regex(/^[a-f\d]{24}$/i) }).strict();
const adminActionSchema = z.object({ action: z.literal('refresh-licence') }).strict();
const UUID_PATTERN = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === 32 && rightBytes.length === 32 && timingSafeEqual(leftBytes, rightBytes);
}

function supportCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function auditRecord(
  shopId: ObjectId,
  actorId: ObjectId,
  event: string,
  occurredAt: Date,
  details: Record<string, unknown> = {},
): AuditRecord {
  return {
    shopId,
    actorId,
    event,
    entityType: 'support_session',
    after: details,
    occurredAt,
  };
}

function scopedError(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

export function supportScopeAllows(
  granted: SupportScope,
  requested: 'diagnostics' | 'read_only' | 'admin_actions',
): boolean {
  return requested === 'diagnostics'
    || (requested === 'read_only' && granted !== 'diagnostics')
    || (requested === 'admin_actions' && granted === 'admin_actions');
}

export function buildMaskedDiagnosticsReport(input: MaskedDiagnosticsInput): MaskedDiagnosticsInput {
  return {
    generatedAt: input.generatedAt,
    appVersion: input.appVersion,
    database: input.database,
    licence: input.licence,
    lastHeartbeatAt: input.lastHeartbeatAt,
    counts: {
      users: input.counts.users,
      products: input.counts.products,
      sales: input.counts.sales,
      purchases: input.counts.purchases,
    },
  };
}

async function callControlPlane(
  config: AppConfig,
  deviceKeyHash: string,
  action: 'support-allow' | 'support-end',
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  if (!config.controlPlaneUrl) throw new Error('CONTROL_PLANE_UNAVAILABLE');
  let response: Response;
  try {
    response = await fetcher(new URL(`/functions/v1/control-plane/${action}`, config.controlPlaneUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-key-hash': deviceKeyHash,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('CONTROL_PLANE_UNAVAILABLE');
  }
  if (!response.ok) throw new Error('CONTROL_PLANE_REQUEST_FAILED');
  const result: unknown = await response.json().catch(() => null);
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('CONTROL_PLANE_INVALID_RESPONSE');
  }
  return result as Record<string, unknown>;
}

function decodeSupportToken(
  token: unknown,
  expectedShopId: string,
  publicKey: string | null,
  now: Date,
): { claims: SupportTokenClaims; hash: string } | null {
  if (typeof token !== 'string' || token.length > 4096 || !publicKey) return null;
  const [encodedPayload, encodedSignature, extra] = token.split('.');
  if (!encodedPayload || !encodedSignature || extra !== undefined
    || !/^[A-Za-z0-9_-]+$/.test(encodedPayload)
    || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) return null;
  let decoded: unknown;
  let signature: Buffer;
  try {
    decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    signature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const claims = decoded as Record<string, unknown>;
  const keys = ['sub', 'shop_id', 'scope', 'issued_at', 'expires_at'];
  if (Object.keys(claims).length !== keys.length || Object.keys(claims).some((key) => !keys.includes(key))
    || typeof claims.sub !== 'string'
    || !UUID_PATTERN.test(claims.sub)
    || !UUID_PATTERN.test(String(claims.shop_id))
    || claims.shop_id !== expectedShopId
    || !['diagnostics', 'read_only', 'admin_actions'].includes(String(claims.scope))
    || typeof claims.issued_at !== 'string'
    || typeof claims.expires_at !== 'string') return null;
  const issuedAt = Date.parse(claims.issued_at);
  const expiresAt = Date.parse(claims.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > now.getTime() || expiresAt <= now.getTime()
    || expiresAt - issuedAt > 30 * 60_000) return null;
  try {
    const valid = verifySignature(
      null,
      Buffer.from(JSON.stringify(claims), 'utf8'),
      publicKey,
      signature,
    );
    if (!valid) return null;
  } catch {
    return null;
  }
  return { claims: claims as SupportTokenClaims, hash: sha256(token) };
}

async function authorizeSupport(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: Collection<SupportSessionRecord>,
  auditLogs: Collection<AuditRecord>,
  config: AppConfig,
  minimumScope: 'diagnostics' | 'read_only' | 'admin_actions',
  now: Date,
): Promise<SupportSessionRecord | null> {
  const token = request.headers['x-support-token'];
  const expectedShopId = request.headers['x-support-shop-id'];
  if (typeof expectedShopId !== 'string' || !UUID_PATTERN.test(expectedShopId)) {
    scopedError(reply, 401, 'SUPPORT_UNAUTHORIZED');
    return null;
  }
  const decoded = decodeSupportToken(token, expectedShopId, config.supportTokenPublicKey, now);
  if (!decoded) {
    scopedError(reply, 401, 'SUPPORT_UNAUTHORIZED');
    return null;
  }
  const scope = decoded.claims.scope;
  if (!supportScopeAllows(scope, minimumScope)) {
    scopedError(reply, 403, 'SUPPORT_SCOPE_REQUIRED');
    return null;
  }
  const session = await sessions.findOne({
    externalSessionId: decoded.claims.sub,
    controlPlaneShopId: expectedShopId,
    scope,
    endedAt: null,
    expiresAt: { $gt: now },
  });
  if (!session || (session.tokenHash !== null && !equalHash(session.tokenHash, decoded.hash))) {
    scopedError(reply, 403, 'SUPPORT_SESSION_ENDED');
    return null;
  }
  if (session.tokenHash === null) {
    const claimedResult = await sessions.updateOne(
      { _id: session._id, tokenHash: null, endedAt: null },
      { $set: { tokenHash: decoded.hash, startedAt: now } },
    );
    const claimed = await sessions.findOne({
      _id: session._id,
      tokenHash: decoded.hash,
      endedAt: null,
      expiresAt: { $gt: now },
    });
    if (!claimed) {
      scopedError(reply, 403, 'SUPPORT_SESSION_ENDED');
      return null;
    }
    if (claimedResult.modifiedCount === 1) {
      await auditLogs.insertOne(auditRecord(
        claimed.shopId,
        claimed.approvedBy,
        'support.session.started',
        now,
        { sessionId: claimed._id.toHexString(), scope: claimed.scope },
      ));
    }
    return claimed;
  }
  if (!session.startedAt) {
    await sessions.updateOne({ _id: session._id, startedAt: null }, { $set: { startedAt: now } });
    session.startedAt = now;
  }
  return session;
}

async function diagnosticsReport(
  database: ReturnType<MongoClient['db']>,
  stateCollection: Collection<LocalControlPlaneRecord>,
  config: AppConfig,
  now: Date,
  shopId: ObjectId,
): Promise<Record<string, unknown>> {
  const [users, products, sales, purchases, state] = await Promise.all([
    database.collection('users').countDocuments({ shopId }),
    database.collection('medicines').countDocuments({ shopId }),
    database.collection('sales').countDocuments({ shopId }),
    database.collection('purchases').countDocuments({ shopId }),
    stateCollection.findOne({ _id: 'control-plane' }),
  ]);
  return buildMaskedDiagnosticsReport({
    generatedAt: now.toISOString(),
    appVersion: config.appVersion,
    database: 'reachable',
    licence: state?.status ?? 'not_activated',
    lastHeartbeatAt: state?.lastSeenAt instanceof Date ? state.lastSeenAt.toISOString() : null,
    counts: { users, products, sales, purchases },
  });
}

export function registerSupportRoutes(
  app: FastifyInstance,
  client: MongoClient,
  config: AppConfig,
  repository: PharmacyRepository,
  tokenConfig: Parameters<typeof requireAuth>[1],
  idempotencyStore: IdempotencyStore,
  options: SupportRouteOptions = {},
): void {
  const database = client.db(config.mongoDbName);
  const sessions = database.collection<SupportSessionRecord>(options.collections?.supportSessions ?? 'supportSessions');
  const controlPlaneState = database.collection<LocalControlPlaneRecord>(
    options.collections?.controlPlaneState ?? 'controlPlaneState',
  );
  const auditLogs = database.collection<AuditRecord>(options.collections?.auditLogs ?? 'auditLogs');
  const authenticate = requireAuth(repository, tokenConfig, idempotencyStore);
  const fetcher = options.fetcher ?? fetch;
  const currentTime = options.now ?? (() => new Date());

  app.post('/api/support/allow', { preHandler: authenticate }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return scopedError(reply, 401, 'UNAUTHENTICATED');
    if (user.role !== 'admin') return scopedError(reply, 403, 'ADMIN_REQUIRED');
    const parsed = allowSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST', fields: parsed.error.flatten().fieldErrors });
    const now = currentTime();
    const existingSession = await sessions.findOne({
      shopId: user.shopId,
      endedAt: null,
      expiresAt: { $gt: now },
    });
    if (existingSession) return scopedError(reply, 409, 'SUPPORT_SESSION_ALREADY_ACTIVE');
    const controlState = await controlPlaneState.findOne({ _id: 'control-plane' });
    if (!controlState || !UUID_PATTERN.test(controlState.controlPlaneShopId)
      || !/^[a-f0-9]{64}$/.test(controlState.deviceKeyHash)) {
      return scopedError(reply, 503, 'CONTROL_PLANE_DEVICE_UNAVAILABLE');
    }
    const code = supportCode();
    let remote: Record<string, unknown>;
    try {
      remote = await callControlPlane(config, controlState.deviceKeyHash, 'support-allow', {
        code,
        scope: parsed.data.scope,
      }, fetcher);
    } catch (error) {
      request.log.warn({
        event: 'support_allow_control_plane_failed',
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      return scopedError(reply, 503, 'CONTROL_PLANE_UNAVAILABLE');
    }
    if (typeof remote.session_id !== 'string'
      || !/^[a-f\d-]{36}$/i.test(remote.session_id)
      || typeof remote.expires_at !== 'string') {
      return scopedError(reply, 502, 'CONTROL_PLANE_INVALID_RESPONSE');
    }
    const expiresAt = new Date(remote.expires_at);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now
      || expiresAt.getTime() - now.getTime() > 30 * 60_000) {
      try {
        await callControlPlane(config, controlState.deviceKeyHash, 'support-end', {
          session_id: remote.session_id,
        }, fetcher);
      } catch (error) {
        request.log.error({
          event: 'support_invalid_session_cleanup_failed',
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      }
      return scopedError(reply, 502, 'CONTROL_PLANE_INVALID_RESPONSE');
    }
    const localId = new ObjectId();
    const session: SupportSessionRecord = {
      _id: localId,
      externalSessionId: remote.session_id,
      controlPlaneShopId: controlState.controlPlaneShopId,
      shopId: user.shopId,
      scope: parsed.data.scope,
      codeHash: sha256(code),
      tokenHash: null,
      expiresAt,
      approvedBy: user._id,
      startedAt: null,
      endedAt: null,
      createdAt: now,
    };
    try {
      await sessions.insertOne(session);
      await auditLogs.insertOne(auditRecord(user.shopId, user._id, 'support.session.allowed', now, {
        sessionId: localId.toHexString(),
        scope: session.scope,
      }));
    } catch (error) {
      try {
        await callControlPlane(config, controlState.deviceKeyHash, 'support-end', {
          session_id: remote.session_id,
        }, fetcher);
      } catch (cleanupError) {
        request.log.error({
          event: 'support_session_cleanup_failed',
          error: cleanupError instanceof Error ? cleanupError.message : 'unknown_error',
        });
      }
      throw error;
    }
    return reply.code(201).send({
      sessionId: localId.toHexString(),
      code,
      scope: session.scope,
      expiresAt: expiresAt.toISOString(),
    });
  });

  app.get('/api/support/sessions', { preHandler: authenticate }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return scopedError(reply, 401, 'UNAUTHENTICATED');
    if (user.role !== 'admin') return scopedError(reply, 403, 'ADMIN_REQUIRED');
    const activeSessions = await sessions.find({
      shopId: user.shopId,
      endedAt: null,
    }).sort({ createdAt: -1 }).limit(10).toArray();
    return {
      sessions: activeSessions.map((session) => ({
        sessionId: session._id.toHexString(),
        scope: session.scope,
        expiresAt: session.expiresAt.toISOString(),
        startedAt: session.startedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post('/api/support/end', { preHandler: authenticate }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return scopedError(reply, 401, 'UNAUTHENTICATED');
    if (user.role !== 'admin') return scopedError(reply, 403, 'ADMIN_REQUIRED');
    const parsed = endSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const now = currentTime();
    const session = await sessions.findOne({
      _id: new ObjectId(parsed.data.sessionId),
      shopId: user.shopId,
      endedAt: null,
    });
    if (!session) return scopedError(reply, 404, 'SUPPORT_SESSION_NOT_FOUND');
    await sessions.updateOne({ _id: session._id, endedAt: null }, { $set: { endedAt: now } });
    await auditLogs.insertOne(auditRecord(user.shopId, user._id, 'support.session.ended', now, {
      sessionId: session._id.toHexString(),
      scope: session.scope,
    }));
    const state = await controlPlaneState.findOne({ _id: 'control-plane' });
    if (state) {
      try {
        await callControlPlane(config, state.deviceKeyHash, 'support-end', {
          session_id: session.externalSessionId,
        }, fetcher);
      } catch (error) {
        request.log.error({
          event: 'support_remote_end_failed',
          sessionId: session._id.toHexString(),
          error: error instanceof Error ? error.message : 'unknown_error',
        });
        return scopedError(reply, 502, 'SUPPORT_ENDED_LOCALLY_REMOTE_PENDING');
      }
    }
    return { ended: true };
  });

  const reportHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const now = currentTime();
    const session = await authorizeSupport(
      request, reply, sessions, auditLogs, config, 'diagnostics', now,
    );
    if (!session) return;
    await auditLogs.insertOne(auditRecord(session.shopId, session.approvedBy, 'support.diagnostics.viewed', now, {
      sessionId: session._id.toHexString(),
      scope: session.scope,
    }));
    return diagnosticsReport(database, controlPlaneState, config, now, session.shopId);
  };
  app.get('/api/support/diagnostics', reportHandler);

  app.get('/api/support/read-only', async (request, reply) => {
    const now = currentTime();
    const session = await authorizeSupport(
      request, reply, sessions, auditLogs, config, 'read_only', now,
    );
    if (!session) return;
    await auditLogs.insertOne(auditRecord(session.shopId, session.approvedBy, 'support.read_only.viewed', now, {
      sessionId: session._id.toHexString(),
      scope: session.scope,
    }));
    return diagnosticsReport(database, controlPlaneState, config, now, session.shopId);
  });

  app.post('/api/support/admin-actions', async (request, reply) => {
    const now = currentTime();
    const session = await authorizeSupport(
      request, reply, sessions, auditLogs, config, 'admin_actions', now,
    );
    if (!session) return;
    const parsed = adminActionSchema.safeParse(request.body);
    if (!parsed.success) return scopedError(reply, 400, 'INVALID_ACTION');
    try {
      const outcome = await sendControlPlaneHeartbeat(client, config, fetcher);
      if (outcome !== 'updated') {
        await auditLogs.insertOne(auditRecord(session.shopId, session.approvedBy, 'support.licence_refresh.failed', now, {
          sessionId: session._id.toHexString(),
          outcome,
        }));
        return scopedError(reply, outcome === 'licence-rejected' ? 502 : 503, 'LICENCE_REFRESH_FAILED');
      }
      await auditLogs.insertOne(auditRecord(session.shopId, session.approvedBy, 'support.licence_refresh.completed', now, {
        sessionId: session._id.toHexString(),
      }));
      return { refreshed: true };
    } catch (error) {
      request.log.warn({
        event: 'support_licence_refresh_failed',
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      return scopedError(reply, 503, 'CONTROL_PLANE_UNAVAILABLE');
    }
  });
}
