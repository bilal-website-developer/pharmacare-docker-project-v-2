import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import type { HTTPMethods } from 'fastify';
import pino from 'pino';
import { MongoClient, ObjectId } from 'mongodb';
import { createAccessToken } from './auth-crypto.js';
import { createApp, registeredApiRoutes } from './app.js';
import { MODULE_KEYS, POS_PRINT_PERMISSION_KEYS } from './permissions.js';
import type { UserRecord } from './models.js';
import {
  hasSensitiveCashierField,
  hasSensitiveCashierErrorText,
  hasSensitiveCsvColumn,
  hasUnsafeMongoKey,
  LOGGER_REDACT_PATHS,
  type RequestRateLimitStore,
} from './security.js';
import { MemoryCatalogRepository } from './test-support/memory-catalog-repository.js';
import { MemoryIdempotencyStore } from './test-support/memory-idempotency-store.js';
import { MemoryRepository } from './test-support/memory-repository.js';
import { MemorySalesRepository } from './test-support/memory-sales-repository.js';
import { MemoryStockRepository } from './test-support/memory-stock-repository.js';
import { testConfig } from './test-support/test-config.js';

class MemoryRequestRateLimitStore implements RequestRateLimitStore {
  private readonly counts = new Map<string, number>();

  async consume(key: string): Promise<number> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count;
  }
}

interface SecurityApp {
  app: ReturnType<typeof createApp>;
  client: MongoClient;
  auth: MemoryRepository;
  cashier: UserRecord;
  rateLimits: MemoryRequestRateLimitStore;
}

async function setup(
  permissions: UserRecord['permissions'] = [],
): Promise<SecurityApp> {
  const auth = new MemoryRepository();
  const shop = auth.addShop();
  const cashier = auth.addUser(shop, {
    username: 'cashier',
    email: 'cashier@example.test',
    role: 'cashier',
    permissions,
  });
  const rateLimits = new MemoryRequestRateLimitStore();
  const client = new MongoClient('mongodb://127.0.0.1:1', { serverSelectionTimeoutMS: 50 });
  const app = createApp(
    client,
    testConfig,
    auth,
    new MemoryCatalogRepository(),
    new MemoryStockRepository(),
    new MemoryIdempotencyStore(),
    new MemorySalesRepository(),
    rateLimits,
  );
  return { app, client, auth, cashier, rateLimits };
}

function authHeader(user: UserRecord): string {
  return createAccessToken({
    id: user._id.toHexString(),
    shopId: user.shopId.toHexString(),
    role: user.role,
  }, {
    accessSecret: testConfig.accessTokenSecret,
    refreshPepper: testConfig.refreshTokenPepper,
    accessTokenTtlSeconds: testConfig.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: testConfig.refreshTokenTtlSeconds,
  }).token;
}

function routeUrl(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '000000000000000000000001').replace(/\*/g, 'wildcard');
}

function routeHeaders(method: string, authorization?: string) {
  return {
    ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
    ...(['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
      ? { 'idempotency-key': new ObjectId().toHexString() }
      : {}),
  };
}

const ROUTE_TEST_PREFIX = '/api/__security-test';
const AUTH_ROUTE_TEST_PREFIX = '/api/auth/__security-test';
const PUBLIC_ROUTE_PREFIXES = [
  'GET:/api/health',
  'HEAD:/api/health',
  'POST:/api/auth/login',
];
const AUTHENTICATED_SELF_SERVICE = new Set([
  'GET:/api/auth/me',
  'HEAD:/api/auth/me',
  'POST:/api/auth/refresh',
  'POST:/api/auth/logout',
  'POST:/api/auth/password',
]);

test('every registered protected API route rejects requests without a token', async () => {
  const { app, client } = await setup();
  await app.ready();
  try {
    const routes = registeredApiRoutes(app).filter((route) =>
      !route.url.startsWith(ROUTE_TEST_PREFIX)
      && !route.url.startsWith(AUTH_ROUTE_TEST_PREFIX)
      && route.method !== 'OPTIONS'
      && !PUBLIC_ROUTE_PREFIXES.includes(`${route.method}:${route.url}`),
    );
    assert.ok(routes.length > 0);
    for (const route of routes) {
      const response = await app.inject({
        method: route.method as HTTPMethods,
        url: routeUrl(route.url),
        headers: routeHeaders(route.method),
      });
      assert.equal(response.statusCode, 401, `${route.method} ${route.url} must require authentication`);
    }
  } finally {
    await app.close();
    await client.close();
  }
});

test('protected business API routes deny a cashier without the required permission', async () => {
  const { app, client, cashier } = await setup();
  await app.ready();
  try {
    const token = authHeader(cashier);
    const routes = registeredApiRoutes(app).filter((route) =>
      !route.url.startsWith(ROUTE_TEST_PREFIX)
      && !route.url.startsWith(AUTH_ROUTE_TEST_PREFIX)
      && route.method !== 'OPTIONS'
      && !PUBLIC_ROUTE_PREFIXES.includes(`${route.method}:${route.url}`)
      && !AUTHENTICATED_SELF_SERVICE.has(`${route.method}:${route.url}`),
    );
    assert.ok(routes.length > 0);
    for (const route of routes) {
      const response = await app.inject({
        method: route.method as HTTPMethods,
        url: routeUrl(route.url),
        headers: routeHeaders(route.method, token),
      });
      assert.equal(response.statusCode, 403, `${route.method} ${route.url} must deny the role/permission`);
    }
  } finally {
    await app.close();
    await client.close();
  }
});

test('cashier response sweep blocks cost-bearing fields and error text across registered API routes', async () => {
  const allPermissions = [...MODULE_KEYS, ...POS_PRINT_PERMISSION_KEYS];
  const { app, client, cashier } = await setup(allPermissions);
  await app.ready();
  try {
    const token = authHeader(cashier);
    const routes = registeredApiRoutes(app).filter((route) =>
      route.method !== 'OPTIONS'
      && route.url.startsWith('/api/')
      && !route.url.startsWith(ROUTE_TEST_PREFIX)
      && !route.url.startsWith(AUTH_ROUTE_TEST_PREFIX)
      && !route.url.includes('/health'),
    );
    assert.ok(routes.length > 0);
    for (const route of routes) {
      const response = await app.inject({
        method: route.method as HTTPMethods,
        url: routeUrl(route.url),
        headers: routeHeaders(route.method, token),
        ...(['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)
          ? { payload: {} }
          : {}),
      });
      const contentType = String(response.headers['content-type'] ?? '');
      if (contentType.includes('text/csv')) {
        assert.equal(hasSensitiveCsvColumn(response.body), false, `${route.url} returned sensitive CSV columns`);
      } else if (contentType.includes('application/json') && response.body) {
        assert.equal(
          hasSensitiveCashierField(response.json()),
          false,
          `${route.url} returned a cost-bearing JSON field`,
        );
        if (response.statusCode >= 400) {
          assert.equal(
            hasSensitiveCashierErrorText(response.json()),
            false,
            `${route.url} returned sensitive error text`,
          );
        }
      }
    }
  } finally {
    await app.close();
    await client.close();
  }
});

test('request limits cover all API routes and are stricter for auth and writes', async () => {
  const { app, client } = await setup();
  app.get(`${ROUTE_TEST_PREFIX}/read`, async () => ({ ok: true }));
  app.get(`${AUTH_ROUTE_TEST_PREFIX}/rate-check`, async () => ({ ok: true }));
  app.post(`${ROUTE_TEST_PREFIX}/write`, async () => ({ ok: true }));
  await app.ready();
  try {
    let response;
    for (let index = 0; index < 120; index += 1) {
      response = await app.inject({ method: 'GET', url: `${ROUTE_TEST_PREFIX}/read` });
    }
    assert.equal(response?.statusCode, 200);
    response = await app.inject({ method: 'GET', url: `${ROUTE_TEST_PREFIX}/read` });
    assert.equal(response.statusCode, 429);
    assert.equal(response.json().error, 'RATE_LIMITED');
    assert.ok(Number(response.headers['retry-after']) > 0);

    for (let index = 0; index < 30; index += 1) {
      response = await app.inject({ method: 'GET', url: `${AUTH_ROUTE_TEST_PREFIX}/rate-check` });
    }
    assert.equal(response?.statusCode, 200);
    response = await app.inject({ method: 'GET', url: `${AUTH_ROUTE_TEST_PREFIX}/rate-check` });
    assert.equal(response.statusCode, 429);

    for (let index = 0; index < 60; index += 1) {
      response = await app.inject({ method: 'POST', url: `${ROUTE_TEST_PREFIX}/write` });
    }
    assert.equal(response?.statusCode, 200);
    response = await app.inject({ method: 'POST', url: `${ROUTE_TEST_PREFIX}/write` });
    assert.equal(response.statusCode, 429);
  } finally {
    await app.close();
    await client.close();
  }
});

test('API CORS allows only the configured origin and security headers are attached', async () => {
  const { app, client } = await setup();
  app.get(`${ROUTE_TEST_PREFIX}/headers`, async () => ({ ok: true }));
  await app.ready();
  try {
    const allowed = await app.inject({
      method: 'GET',
      url: `${ROUTE_TEST_PREFIX}/headers`,
      headers: { origin: testConfig.webOrigin },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], testConfig.webOrigin);
    assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
    assert.equal(allowed.headers['x-content-type-options'], 'nosniff');
    assert.equal(allowed.headers['x-frame-options'], 'DENY');
    assert.equal(allowed.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal(allowed.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(allowed.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
    assert.equal(allowed.headers['cache-control'], 'no-store');
    assert.equal(allowed.headers['x-frame-options'], 'DENY');
    assert.equal(allowed.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");

    const denied = await app.inject({
      method: 'GET',
      url: `${ROUTE_TEST_PREFIX}/headers`,
      headers: { origin: 'https://untrusted.example.test' },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: `${ROUTE_TEST_PREFIX}/headers`,
      headers: {
        origin: testConfig.webOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,idempotency-key',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], testConfig.webOrigin);
  } finally {
    await app.close();
    await client.close();
  }
});

test('operator keys and oversized bodies fail with generic client errors', async () => {
  const { app, client } = await setup();
  app.post(`${ROUTE_TEST_PREFIX}/body`, async () => ({ ok: true }));
  await app.ready();
  try {
    const injection = await app.inject({
      method: 'POST',
      url: `${ROUTE_TEST_PREFIX}/body`,
      payload: { filter: { $ne: null } },
    });
    assert.equal(injection.statusCode, 400);
    assert.deepEqual(injection.json(), { error: 'VALIDATION_FAILED' });

    const oversized = await app.inject({
      method: 'POST',
      url: `${ROUTE_TEST_PREFIX}/body`,
      headers: { 'content-type': 'application/json' },
      payload: `"${'x'.repeat(6 * 1024 * 1024)}"`,
    });
    assert.equal(oversized.statusCode, 413);
    assert.deepEqual(oversized.json(), { error: 'REQUEST_TOO_LARGE' });
    assert.equal(oversized.headers['x-content-type-options'], 'nosniff');
    assert.doesNotMatch(oversized.body, /stack|Fastify|PayloadTooLarge/);
  } finally {
    await app.close();
    await client.close();
  }
});

test('cashier-sensitive JSON, CSV headers, and error text are replaced with a generic error', async () => {
  const { app, client, cashier } = await setup();
  app.get(`${ROUTE_TEST_PREFIX}/sensitive-json`, async (request) => {
    request.authUser = cashier;
    return { sale: { marginBasisPoints: '100' } };
  });
  app.get(`${ROUTE_TEST_PREFIX}/sensitive-error`, async (request, reply) => {
    request.authUser = cashier;
    return reply.code(400).send({ error: 'cost calculation failed' });
  });
  app.get(`${ROUTE_TEST_PREFIX}/sensitive-csv`, async (request, reply) => {
    request.authUser = cashier;
    return reply.type('text/csv').send('code,latestCostPaisa\r\nA-1,100');
  });
  await app.ready();
  try {
    for (const suffix of ['sensitive-json', 'sensitive-error', 'sensitive-csv']) {
      const response = await app.inject({ method: 'GET', url: `${ROUTE_TEST_PREFIX}/${suffix}` });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { error: 'INTERNAL_ERROR' });
      assert.doesNotMatch(response.body, /margin|cost|100|A-1/i);
    }
  } finally {
    await app.close();
    await client.close();
  }
});

test('Pino redaction removes credentials, tokens, request keys, and error stacks', () => {
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const logger = pino({
    redact: { paths: [...LOGGER_REDACT_PATHS], censor: '[REDACTED]' },
  }, output);
  logger.error({
    req: {
      headers: {
        authorization: 'fixture-auth',
        cookie: 'fixture-cookie',
        'idempotency-key': 'fixture-idempotency',
        'x-csrf-token': 'fixture-csrf',
      },
      body: {
        password: 'fixture-password',
        currentPassword: 'fixture-current-password',
        newPassword: 'fixture-new-password',
        refreshToken: 'fixture-refresh',
        accessToken: 'fixture-access',
      },
    },
    token: 'fixture-token',
    uri: 'fixture-uri',
    MONGO_APP_PASSWORD: 'fixture-mongo-app-password',
    MONGO_ROOT_PASSWORD: 'fixture-mongo-root-password',
    MONGO_REPLICA_KEY: 'fixture-mongo-replica-key',
    JWT_ACCESS_SECRET: 'fixture-jwt-access-secret',
    REFRESH_TOKEN_PEPPER: 'fixture-refresh-pepper',
    mongoUri: 'fixture-mongo-uri',
    accessTokenSecret: 'fixture-access-token-secret',
    refreshTokenPepper: 'fixture-refresh-token-pepper',
    err: { message: 'fixture-error-message', stack: 'fixture-error-stack' },
  }, 'redaction test');
  logger.flush();
  const log = lines.join('');
  for (const secret of [
    'fixture-auth',
    'fixture-cookie',
    'fixture-idempotency',
    'fixture-csrf',
    'fixture-password',
    'fixture-current-password',
    'fixture-new-password',
    'fixture-refresh',
    'fixture-access',
    'fixture-token',
    'fixture-uri',
    'fixture-mongo-app-password',
    'fixture-mongo-root-password',
    'fixture-mongo-replica-key',
    'fixture-jwt-access-secret',
    'fixture-refresh-pepper',
    'fixture-mongo-uri',
    'fixture-access-token-secret',
    'fixture-refresh-token-pepper',
    'fixture-error-message',
    'fixture-error-stack',
  ]) {
    assert.equal(log.includes(secret), false, `${secret} leaked into the log`);
  }
  assert.match(log, /\[REDACTED\]/);
});

test('operator-key detection and sensitive-field helpers inspect nested structures', () => {
  assert.equal(hasUnsafeMongoKey({ items: [{ '$where': 'true' }] }), true);
  assert.equal(hasUnsafeMongoKey({ items: [{ name: 'ordinary text' }] }), false);
  assert.equal(hasSensitiveCashierField({ items: [{ purchasePricePaisa: '1' }] }), true);
  assert.equal(hasSensitiveCashierField({ items: [{ pricePaisa: '1' }] }), false);
  assert.equal(hasSensitiveCashierErrorText({ error: 'margin was omitted' }), true);
  assert.equal(hasSensitiveCsvColumn('"code","latestCostPaisa"\r\nA-1,100'), true);
  assert.equal(hasSensitiveCsvColumn('"code","name"\r\nA-1,Example'), false);
});
