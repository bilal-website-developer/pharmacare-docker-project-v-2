import { createHash } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import type { FastifyReply, FastifyRequest } from 'fastify';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyReservation {
  shopId: ObjectId;
  route: string;
  keyHash: string;
  requestHash: string;
  expiresAt: Date;
}

export interface StoredIdempotencyResponse {
  statusCode: number;
  contentType: string;
  body: string;
}

export type IdempotencyDecision =
  | { kind: 'reserved' }
  | { kind: 'replay'; response: StoredIdempotencyResponse }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

export interface IdempotencyStore {
  reserve(reservation: IdempotencyReservation): Promise<IdempotencyDecision>;
  complete(reservation: IdempotencyReservation, response: StoredIdempotencyResponse): Promise<void>;
  abandon(reservation: IdempotencyReservation): Promise<void>;
}

export interface IdempotencyContext extends IdempotencyReservation {
  completed: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyContext?: IdempotencyContext;
  }
}

export class MongoIdempotencyStore implements IdempotencyStore {
  constructor(private readonly database: Db) {}

  async reserve(reservation: IdempotencyReservation): Promise<IdempotencyDecision> {
    const collection = this.database.collection('idempotencyRecords');
    const query = {
      shopId: reservation.shopId,
      route: reservation.route,
      keyHash: reservation.keyHash,
    };
    const existing = await collection.findOne(query);
    if (existing && existing.expiresAt instanceof Date && existing.expiresAt <= new Date()) {
      await collection.deleteOne({ ...query, expiresAt: existing.expiresAt });
    } else if (existing) {
      if (existing.requestHash !== reservation.requestHash) return { kind: 'conflict' };
      if (existing.state === 'COMPLETED') {
        return {
          kind: 'replay',
          response: {
            statusCode: Number(existing.statusCode),
            contentType: String(existing.contentType),
            body: String(existing.body),
          },
        };
      }
      return { kind: 'in_progress' };
    }

    try {
      await collection.insertOne({
        ...query,
        requestHash: reservation.requestHash,
        state: 'PROCESSING',
        createdAt: new Date(),
        expiresAt: reservation.expiresAt,
      });
      return { kind: 'reserved' };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const concurrent = await collection.findOne(query);
      if (!concurrent || concurrent.expiresAt <= new Date()) {
        return this.reserve(reservation);
      }
      if (concurrent.requestHash !== reservation.requestHash) return { kind: 'conflict' };
      if (concurrent.state === 'COMPLETED') {
        return {
          kind: 'replay',
          response: {
            statusCode: Number(concurrent.statusCode),
            contentType: String(concurrent.contentType),
            body: String(concurrent.body),
          },
        };
      }
      return { kind: 'in_progress' };
    }
  }

  async complete(
    reservation: IdempotencyReservation,
    response: StoredIdempotencyResponse,
  ): Promise<void> {
    const result = await this.database.collection('idempotencyRecords').updateOne(
      {
        shopId: reservation.shopId,
        route: reservation.route,
        keyHash: reservation.keyHash,
        requestHash: reservation.requestHash,
        state: 'PROCESSING',
      },
      {
        $set: {
          state: 'COMPLETED',
          statusCode: response.statusCode,
          contentType: response.contentType,
          body: response.body,
          completedAt: new Date(),
        },
      },
    );
    if (result.modifiedCount !== 1) throw new Error('IDEMPOTENCY_RESULT_NOT_STORED');
  }

  async abandon(reservation: IdempotencyReservation): Promise<void> {
    await this.database.collection('idempotencyRecords').deleteOne({
      shopId: reservation.shopId,
      route: reservation.route,
      keyHash: reservation.keyHash,
      requestHash: reservation.requestHash,
      state: 'PROCESSING',
    });
  }
}

export function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function reservationFor(request: FastifyRequest, shopId: ObjectId, key: string): IdempotencyReservation {
  const route = `${request.method} ${request.routeOptions.url ?? request.url.split('?')[0]}`;
  const keyHash = createHash('sha256').update(key).digest('hex');
  const requestHash = createHash('sha256').update(JSON.stringify(stableValue({
    method: request.method,
    route,
    params: request.params,
    query: request.query,
    body: request.body,
  }))).digest('hex');
  return {
    shopId,
    route,
    keyHash,
    requestHash,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
  };
}

export async function beginWriteIdempotency(
  request: FastifyRequest,
  reply: FastifyReply,
  shopId: ObjectId,
  store: IdempotencyStore,
): Promise<boolean> {
  const header = request.headers['idempotency-key'];
  const key = typeof header === 'string' ? header : '';
  const reservation = reservationFor(request, shopId, key);
  const decision = await store.reserve(reservation);
  if (decision.kind === 'reserved') {
    request.idempotencyContext = { ...reservation, completed: false };
    return true;
  }
  if (decision.kind === 'conflict') {
    await reply.code(409).send({ error: 'IDEMPOTENCY_KEY_REUSED' });
  } else if (decision.kind === 'in_progress') {
    await reply.code(409).send({ error: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
  } else {
    request.idempotencyContext = { ...reservation, completed: true };
    await reply
      .code(decision.response.statusCode)
      .header('content-type', decision.response.contentType)
      .send(decision.response.body);
  }
  return false;
}

export async function finishWriteIdempotency(
  request: FastifyRequest,
  statusCode: number,
  contentType: string,
  body: string,
  store: IdempotencyStore,
): Promise<void> {
  const context = request.idempotencyContext;
  if (!context || context.completed) return;
  context.completed = true;
  if (statusCode >= 200 && statusCode < 300) {
    await store.complete(context, { statusCode, contentType, body });
  } else {
    await store.abandon(context);
  }
}

export function requestUsesIdempotency(request: FastifyRequest): boolean {
  const route = request.routeOptions.url ?? '';
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    && !route.startsWith('/api/auth/');
}

export function validateIdempotencyHeader(request: FastifyRequest): string | null {
  if (!requestUsesIdempotency(request)) return null;
  const value = request.headers['idempotency-key'];
  if (
    typeof value !== 'string'
    || value.length < 8
    || value.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) return 'IDEMPOTENCY_KEY_REQUIRED';
  return null;
}
