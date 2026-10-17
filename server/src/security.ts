import { createHmac } from 'node:crypto';
import type { Collection } from 'mongodb';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const REQUEST_RATE_WINDOW_MS = 60_000;
export const REQUEST_RATE_LIMIT = 120;
export const AUTH_RATE_LIMIT = 30;
export const WRITE_RATE_LIMIT = 60;
export const LOGIN_RATE_LIMIT = 10;
export const SETUP_RATE_LIMIT = 5;

export const LOGGER_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.set-cookie',
  'req.headers.idempotency-key',
  'req.headers.x-csrf-token',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.secret',
  'req.body.setupCode',
  'req.body.key',
  'MONGO_APP_PASSWORD',
  'MONGO_ROOT_PASSWORD',
  'MONGO_REPLICA_KEY',
  'JWT_ACCESS_SECRET',
  'REFRESH_TOKEN_PEPPER',
  'SETUP_CODE_HASH',
  'SETUP_CODE_EXPIRES_AT',
  'mongoUri',
  'accessTokenSecret',
  'refreshTokenPepper',
  'setupCodeHash',
  'setupCode',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'key',
  'uri',
  'password',
  '*.password',
  '*.passwordHash',
  '*.MONGO_APP_PASSWORD',
  '*.MONGO_ROOT_PASSWORD',
  '*.MONGO_REPLICA_KEY',
  '*.JWT_ACCESS_SECRET',
  '*.REFRESH_TOKEN_PEPPER',
  '*.SETUP_CODE_HASH',
  '*.SETUP_CODE_EXPIRES_AT',
  '*.mongoUri',
  '*.accessTokenSecret',
  '*.refreshTokenPepper',
  '*.setupCodeHash',
  '*.setupCode',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.key',
  '*.uri',
  'err.message',
  'err.stack',
  'error.message',
  'error.stack',
] as const;

export interface RequestRateLimitRecord {
  _id: string;
  count: number;
  expiresAt: Date;
}

export interface RequestRateLimitStore {
  consume(key: string, expiresAt: Date): Promise<number>;
}

export class MongoRequestRateLimitStore implements RequestRateLimitStore {
  constructor(private readonly collection: Collection<RequestRateLimitRecord>) {}

  async consume(key: string, expiresAt: Date): Promise<number> {
    const result = await this.collection.findOneAndUpdate(
      { _id: key },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false },
    );
    if (!result) throw new Error('Could not record request rate limit');
    return result.count;
  }
}

export function hasUnsafeMongoKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsafeMongoKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) =>
    key.startsWith('$')
      || key.includes('.')
      || key === '__proto__'
      || key === 'prototype'
      || key === 'constructor'
      || hasUnsafeMongoKey(nested),
  );
}

const SENSITIVE_FIELD = /cost|profit|margin|purchase.?price/i;

export function hasSensitiveCashierField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveCashierField);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) =>
    SENSITIVE_FIELD.test(key) || hasSensitiveCashierField(nested),
  );
}

export function hasSensitiveCashierErrorText(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveCashierErrorText);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) =>
    (['error', 'message', 'detail', 'details', 'reason'].includes(key.toLowerCase())
      && typeof nested === 'string'
      && SENSITIVE_FIELD.test(nested))
      || hasSensitiveCashierErrorText(nested),
  );
}

export function hasSensitiveCsvColumn(payload: string): boolean {
  const firstLine = payload.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.split(',').some((column) =>
    SENSITIVE_FIELD.test(column.trim().replace(/^"|"$/g, '')),
  );
}

export function requestRateLimit(
  request: FastifyRequest,
  now: Date,
  pepper: string,
): { key: string; expiresAt: Date; limit: number } {
  const window = Math.floor(now.getTime() / REQUEST_RATE_WINDOW_MS);
  const route = request.routeOptions.url ?? request.url.split('?', 1)[0] ?? '/';
  const routeIdentity = `${request.method}:${route}`;
  const key = createHmac('sha256', pepper)
    .update(`${request.ip}\0${routeIdentity}\0${window}`)
    .digest('hex');
  const expiresAt = new Date((window + 2) * REQUEST_RATE_WINDOW_MS);
  const isAuth = route.startsWith('/api/auth/');
  const isSetup = route === '/api/setup';
  const limit = isSetup
    ? SETUP_RATE_LIMIT
    : isAuth
    ? AUTH_RATE_LIMIT
    : ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
      ? WRITE_RATE_LIMIT
      : REQUEST_RATE_LIMIT;
  return { key, expiresAt, limit };
}

export async function enforceRequestRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  store: RequestRateLimitStore,
  pepper: string,
  now = new Date(),
): Promise<void> {
  const rate = requestRateLimit(request, now, pepper);
  const attempts = await store.consume(rate.key, rate.expiresAt);
  if (attempts <= rate.limit) return;
  const retryAfter = Math.max(1, Math.ceil((rate.expiresAt.getTime() - now.getTime()) / 1000));
  reply.header('Retry-After', String(retryAfter));
  await reply.code(429).send({ error: 'RATE_LIMITED' });
}

export function addSecurityHeaders(reply: FastifyReply): void {
  reply
    .header('X-Content-Type-Options', 'nosniff')
    .header('X-Frame-Options', 'DENY')
    .header('Referrer-Policy', 'strict-origin-when-cross-origin')
    .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    .header('Cross-Origin-Resource-Policy', 'same-origin')
    .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    .header('Cache-Control', 'no-store');
}
