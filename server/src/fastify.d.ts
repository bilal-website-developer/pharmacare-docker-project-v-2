import type { UserRecord } from './models.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser: UserRecord | null;
  }
}
