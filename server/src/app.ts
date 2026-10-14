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

export function createApp(
  mongoClient: MongoClient,
  config?: AppConfig,
  repository?: PharmacyRepository,
  catalogRepository?: CatalogRepository,
  stockRepository?: StockRepository,
): FastifyInstance {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 6 * 1024 * 1024,
    logger: {
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.set-cookie',
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
    registerAuthRoutes(app, pharmacyRepository, tokenConfig);
    registerUserRoutes(app, pharmacyRepository, tokenConfig);
    registerCatalogRoutes(
      app,
      catalogRepository ?? new MongoCatalogRepository(mongoClient, config.mongoDbName),
      pharmacyRepository,
      tokenConfig,
    );
    registerStockRoutes(
      app,
      stockRepository ?? new MongoStockRepository(mongoClient, config.mongoDbName),
      pharmacyRepository,
      tokenConfig,
    );
  }

  return app;
}
