import Fastify, { type FastifyInstance } from 'fastify';
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
import { MongoSalesRepository, type SalesRepository } from './sales-repository.js';
import { registerSalesRoutes } from './sales-routes.js';
import { registerPhaseSevenRoutes } from './phase7-routes.js';

export function createApp(
  mongoClient: MongoClient,
  config?: AppConfig,
  repository?: PharmacyRepository,
  catalogRepository?: CatalogRepository,
  stockRepository?: StockRepository,
  idempotencyStore?: IdempotencyStore,
  salesRepository?: SalesRepository,
): FastifyInstance {
  const resolvedIdempotencyStore = idempotencyStore
    ?? (config ? new MongoIdempotencyStore(mongoClient.db(config.mongoDbName)) : null);
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 6 * 1024 * 1024,
    logger: {
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.set-cookie',
          'req.headers.idempotency-key',
          'req.body.password',
          'req.body.refreshToken',
          'password',
          '*.password',
          '*.passwordHash',
          '*.token',
          '*.accessToken',
          '*.refreshToken',
          '*.secret',
          '*.key',
          '*.uri',
        ],
        censor: '[REDACTED]',
      },
    },
  });
  app.decorateRequest('authUser', null);
  app.register(cookie);
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
    request.log.error({
      event: 'request_failed',
      errorName: error instanceof Error ? error.name : 'unknown_error',
    });
    void reply.code(500).send({ error: 'INTERNAL_ERROR' });
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
