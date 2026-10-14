import Fastify, { type FastifyInstance } from 'fastify';
import type { MongoClient } from 'mongodb';

export function createApp(mongoClient: MongoClient): FastifyInstance {
  const app = Fastify({
    logger: {
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.set-cookie',
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

  app.get('/api/health', async (_request, reply) => {
    try {
      await mongoClient.db().command({ ping: 1 });
      return { status: 'ok', database: 'ok' };
    } catch {
      app.log.warn({ event: 'mongo_health_check_failed' });
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
