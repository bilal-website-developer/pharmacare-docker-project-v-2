import type {
  IdempotencyDecision,
  IdempotencyReservation,
  IdempotencyStore,
  StoredIdempotencyResponse,
} from '../idempotency.js';

interface StoredRecord extends IdempotencyReservation {
  response?: StoredIdempotencyResponse;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly records = new Map<string, StoredRecord>();

  private recordKey(reservation: IdempotencyReservation): string {
    return `${reservation.shopId.toHexString()}:${reservation.route}:${reservation.keyHash}`;
  }

  async reserve(reservation: IdempotencyReservation): Promise<IdempotencyDecision> {
    const key = this.recordKey(reservation);
    const existing = this.records.get(key);
    if (existing && existing.expiresAt > new Date()) {
      if (existing.requestHash !== reservation.requestHash) return { kind: 'conflict' };
      if (existing.response) return { kind: 'replay', response: existing.response };
      return { kind: 'in_progress' };
    }
    this.records.set(key, { ...reservation });
    return { kind: 'reserved' };
  }

  async complete(
    reservation: IdempotencyReservation,
    response: StoredIdempotencyResponse,
  ): Promise<void> {
    const record = this.records.get(this.recordKey(reservation));
    if (!record || record.requestHash !== reservation.requestHash) {
      throw new Error('IDEMPOTENCY_RESULT_NOT_STORED');
    }
    record.response = response;
  }

  async abandon(reservation: IdempotencyReservation): Promise<void> {
    const key = this.recordKey(reservation);
    const record = this.records.get(key);
    if (record?.requestHash === reservation.requestHash && !record.response) {
      this.records.delete(key);
    }
  }
}
