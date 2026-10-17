import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { MongoClient } from 'mongodb';
import { registerAuthRoutes } from './auth-routes.js';
import { MongoPharmacyRepository } from './mongo-repository.js';
import type { PharmacyRepository } from './models.js';
import type { AppConfig } from './config.js';
import { registerUserRoutes } from './user-routes.js';
import { MongoCatalogRepository, type CatalogRepository } from './catalog-repository.js';
import { registerCatalogRoutes } from './catalog-routes.js';
import { MongoStockRepository, type StockRepository } from './stock-repository.js';
import { registerStockRoutes } from './stock-routes.js';
import {
  finishWriteIdempotency,
  MongoIdempotencyStore,
  type IdempotencyStore,
} from './idempotency.js';
import {
  addSecurityHeaders,
  enforceRequestRateLimit,
  hasSensitiveCashierField,
  hasSensitiveCashierErrorText,
  hasSensitiveCsvColumn,
  hasUnsafeMongoKey,
  LOGGER_REDACT_PATHS,
  MongoRequestRateLimitStore,
  type RequestRateLimitRecord,
  type RequestRateLimitStore,
} from './security.js';
import { MongoSalesRepository, type SalesRepository } from './sales-repository.js';
import { registerSalesRoutes } from './sales-routes.js';
import { registerPhaseSevenRoutes } from './phase7-routes.js';

export interface RegisteredApiRoute {
  method: string;
  url: string;
}

const API_ROUTE_MANIFEST = new WeakMap<FastifyInstance, RegisteredApiRoute[]>();

export function registeredApiRoutes(app: FastifyInstance): readonly RegisteredApiRoute[] {
  return API_ROUTE_MANIFEST.get(app) ?? [];
}

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function clientErrorStatus(error: unknown): number {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return 500;
  const statusCode = error.statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : 500;
}

export function createApp(
  mongoClient: MongoClient,
  config?: AppConfig,
  repository?: PharmacyRepository,
  catalogRepository?: CatalogRepository,
  stockRepository?: StockRepository,
  idempotencyStore?: IdempotencyStore,
  salesRepository?: SalesRepository,
  requestRateLimitStore?: RequestRateLimitStore,
): FastifyInstance {
  const resolvedIdempotencyStore = idempotencyStore
    ?? (config ? new MongoIdempotencyStore(mongoClient.db(config.mongoDbName)) : null);
  const resolvedRateLimitStore = requestRateLimitStore
    ?? (config && config.nodeEnv !== 'test'
      ? new MongoRequestRateLimitStore(
        mongoClient.db(config.mongoDbName).collection<RequestRateLimitRecord>('requestRateLimits'),
      )
      : null);
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 6 * 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      redact: {
        paths: [...LOGGER_REDACT_PATHS],
        censor: '[REDACTED]',
      },
    },
  });
  const routeManifest: RegisteredApiRoute[] = [];
  API_ROUTE_MANIFEST.set(app, routeManifest);
  app.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.url.startsWith('/api')) return;
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const method of methods) routeManifest.push({ method, url: routeOptions.url });
  });
  app.decorateRequest('authUser', null);
  app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return;
    if (!config || origin !== config.webOrigin) {
      return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
    }
    reply
      .header('Access-Control-Allow-Origin', config.webOrigin)
      .header('Access-Control-Allow-Credentials', 'true')
      .header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-CSRF-Token')
      .header('Access-Control-Max-Age', '600')
      .header('Vary', 'Origin');
  });
  app.options('/api/*', async (_request, reply) => reply.code(204).send());
  app.addHook('preValidation', async (request, reply) => {
    if (hasUnsafeMongoKey(request.body)
      || hasUnsafeMongoKey(request.params)
      || hasUnsafeMongoKey(request.query)) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    }
  });
  if (resolvedRateLimitStore && config) {
    app.addHook('preHandler', async (request, reply) => {
      if (!request.routeOptions.url?.startsWith('/api/')) return;
      await enforceRequestRateLimit(
        request,
        reply,
        resolvedRateLimitStore,
        config.refreshTokenPepper,
      );
    });
  }
  app.addHook('onSend', async (request, reply, payload) => {
    addSecurityHeaders(reply);
    if (request.authUser?.role !== 'cashier') return payload;
    const contentType = String(reply.getHeader('content-type') ?? '');
    const text = typeof payload === 'string'
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString('utf8')
        : null;
    if (text === null) return payload;
    let containsSensitiveData = false;
    if (contentType.includes('application/json')) {
      try {
        const body: unknown = JSON.parse(text);
        containsSensitiveData = hasSensitiveCashierField(body)
          || (reply.statusCode >= 400 && hasSensitiveCashierErrorText(body));
      } catch {
        return payload;
      }
    } else if (contentType.includes('text/csv')) {
      containsSensitiveData = hasSensitiveCsvColumn(text);
    }
    if (!containsSensitiveData) return payload;
    request.log.error({
      event: 'cashier_sensitive_response_blocked',
      method: request.method,
      route: request.routeOptions.url,
    });
    reply.code(500).header('content-type', 'application/json; charset=utf-8');
    return JSON.stringify({ error: 'INTERNAL_ERROR' });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.idempotencyContext || !resolvedIdempotencyStore) return payload;
    await finishWriteIdempotency(
      request,
      reply.statusCode,
      String(reply.getHeader('content-type') ?? 'application/json'),
      Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload),
      resolvedIdempotencyStore,
    );
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) {
      request.log.warn({
        event: 'error_after_response',
        errorName: error instanceof Error ? error.name : 'unknown_error',
        errorCode: safeErrorCode(error),
      });
      return;
    }
    const statusCode = clientErrorStatus(error);
    request.log.error({
      event: 'request_failed',
      errorName: error instanceof Error ? error.name : 'unknown_error',
      errorCode: safeErrorCode(error),
      statusCode,
    });
    const errorCode = statusCode === 413 ? 'REQUEST_TOO_LARGE'
      : statusCode === 415 ? 'UNSUPPORTED_MEDIA_TYPE'
        : statusCode === 429 ? 'RATE_LIMITED'
          : statusCode === 400 ? 'REQUEST_FAILED'
            : 'INTERNAL_ERROR';
    void reply.code(statusCode).send({ error: errorCode });
  });

  app.get('/api/health', async (_request, reply) => {
    try {
      await mongoClient.db().command({ ping: 1 });
      return { status: 'ok', database: 'ok' };
    } catch {
      app.log.warn({ event: 'mongo_health_check_failed' });
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  if (config) {
    const pharmacyRepository = repository ?? new MongoPharmacyRepository(mongoClient, config.mongoDbName);
    const tokenConfig = {
      accessSecret: config.accessTokenSecret,
      refreshPepper: config.refreshTokenPepper,
      accessTokenTtlSeconds: config.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
    };
    if (!resolvedIdempotencyStore) throw new Error('Idempotency store is not configured');
    registerAuthRoutes(app, pharmacyRepository, tokenConfig, resolvedIdempotencyStore);
    registerUserRoutes(app, pharmacyRepository, tokenConfig, resolvedIdempotencyStore);
    registerCatalogRoutes(
      app,
      catalogRepository ?? new MongoCatalogRepository(mongoClient, config.mongoDbName),
      pharmacyRepository,
      tokenConfig,
      resolvedIdempotencyStore,
    );
    registerStockRoutes(
      app,
      stockRepository ?? new MongoStockRepository(mongoClient, config.mongoDbName),
      pharmacyRepository,
      tokenConfig,
      resolvedIdempotencyStore,
    );
    registerSalesRoutes(
      app,
      salesRepository ?? new MongoSalesRepository(mongoClient, config.mongoDbName),
      pharmacyRepository,
      tokenConfig,
      resolvedIdempotencyStore,
    );
    registerPhaseSevenRoutes(
      app,
      mongoClient,
      config,
      pharmacyRepository,
      tokenConfig,
      resolvedIdempotencyStore,
    );
  }

  return app;
}
