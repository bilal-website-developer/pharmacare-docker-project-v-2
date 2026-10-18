import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collection, MongoClient } from 'mongodb';
import type { AppConfig } from './config.js';
import { verifyAccessToken } from './auth-crypto.js';
import { evaluateLicenceState, verifyLicence, type LicenceStateResult, type SignedLicence } from './licence.js';

export interface LocalControlPlaneRecord {
  _id: 'control-plane';
  controlPlaneShopId: string;
  deviceKeyHash: string;
  licence: SignedLicence;
  lastSeenAt: Date;
  status: 'active' | 'suspended';
}

interface SaleDraftClaims {
  shopId: string;
  openedAt: number;
  expiresAt: number;
}

const MINUTE_MS = 60_000;

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function signature(value: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(value).digest();
}

export function createSaleDraftToken(shopId: string, config: AppConfig, now = Date.now()): string {
  const payload = encode(JSON.stringify({ shopId, openedAt: now, expiresAt: now + 60 * MINUTE_MS }));
  return `${payload}.${signature(payload, config.accessTokenSecret).toString('base64url')}`;
}

export function verifySaleDraftToken(
  token: unknown,
  shopId: string,
  config: AppConfig,
  now = Date.now(),
  inactiveAt?: number,
): boolean {
  if (typeof token !== 'string') return false;
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra !== undefined) return false;
  const expected = signature(payload, config.accessTokenSecret);
  const actual = Buffer.from(supplied, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  let claims: SaleDraftClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SaleDraftClaims;
  } catch {
    return false;
  }
  return claims.shopId === shopId
    && Number.isSafeInteger(claims.openedAt)
    && Number.isSafeInteger(claims.expiresAt)
    && claims.openedAt <= now
    && claims.expiresAt >= now
    && claims.expiresAt - claims.openedAt === 60 * MINUTE_MS
    && (inactiveAt === undefined || claims.openedAt < inactiveAt);
}

export async function readVerifiedLicenceState(
  states: Collection<LocalControlPlaneRecord>,
  config: AppConfig,
  now = new Date(),
): Promise<{ record: LocalControlPlaneRecord; decision: LicenceStateResult } | null> {
  const record = await states.findOne({ _id: 'control-plane' });
  if (!record || !config.licencePublicKey
    || (record.status !== 'active' && record.status !== 'suspended')
    || !(record.lastSeenAt instanceof Date) || !Number.isFinite(record.lastSeenAt.getTime())
    || !await verifyLicence(record.licence, config.licencePublicKey, record.controlPlaneShopId)) {
    return null;
  }
  return {
    record,
    decision: evaluateLicenceState(
      record.licence.payload,
      now,
      record.lastSeenAt,
      record.status === 'suspended',
    ),
  };
}

function controlledWrite(method: string, path: string): boolean {
  if (method === 'POST' && (path === '/api/sales' || path === '/api/purchases')) return true;
  if (method === 'POST' && /^\/api\/purchases\/[^/]+\/void$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/sales\/[^/]+\/(void|returns)$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/returns\/[^/]+\/process$/.test(path)) return true;
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && path.startsWith('/api/stock/');
}

export function createLicenceWriteGuard(
  client: MongoClient,
  config: AppConfig,
  collectionName = 'controlPlaneState',
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const states = client.db(config.mongoDbName).collection<LocalControlPlaneRecord>(collectionName);
  return async (request, reply) => {
    if (!controlledWrite(request.method, request.routeOptions.url ?? request.url.split('?')[0] ?? '')) return;
    if (config.nodeEnv === 'test' && !config.licencePublicKey) return;
    const token = request.headers.authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
    const claims = token ? verifyAccessToken(token, config.accessTokenSecret) : null;
    if (!claims) return;

    const current = await readVerifiedLicenceState(states, config);
    if (!current) {
      if (config.nodeEnv === 'test') return;
      await reply.code(503).send({ error: 'LICENCE_UNAVAILABLE' });
      return;
    }
    const blocked = current.decision.state === 'inactive' || current.decision.state === 'suspended';
    if (!blocked) return;
    if (current.decision.state === 'inactive' && request.routeOptions.url === '/api/sales'
      && !current.decision.clockWarning) {
      const payload = current.record.licence.payload;
      const inactiveAt = payload.expires_at
        ? Date.parse(payload.expires_at) + payload.warning_days * 24 * 60 * 60 * 1000
        : undefined;
      if (verifySaleDraftToken(
        (request.body as Record<string, unknown> | null)?.saleDraftToken,
        claims.shopId,
        config,
        current.decision.effectiveNow.getTime(),
        inactiveAt,
      )) return;
    }
    await reply.code(423).send({
      error: current.decision.state === 'suspended' ? 'LICENCE_SUSPENDED' : 'LICENCE_INACTIVE',
    });
  };
}
