import {
  MongoClient,
  ObjectId,
  type ClientSession,
  type Db,
  type Filter,
} from 'mongodb';
import type {
  AuditRecord,
  PharmacyRepository,
  RefreshSessionRecord,
  ShopRecord,
  UserRecord,
  UserWriteTransaction,
} from './models.js';
import type { Role } from './permissions.js';

type UserDocument = UserRecord;
type RefreshDocument = RefreshSessionRecord;

class MongoUserWriteTransaction implements UserWriteTransaction {
  constructor(
    private readonly database: Db,
    private readonly session: ClientSession,
    private readonly shopId: ObjectId,
  ) {}

  async findUser(id: ObjectId, includeDeleted = false): Promise<UserRecord | null> {
    const filter: Filter<UserDocument> = { _id: id, shopId: this.shopId };
    if (!includeDeleted) filter.deletedAt = null;
    return this.database.collection<UserDocument>('users').findOne(filter, { session: this.session });
  }

  async listUsers(includeDeleted: boolean): Promise<UserRecord[]> {
    const filter: Filter<UserDocument> = { shopId: this.shopId };
    if (!includeDeleted) filter.deletedAt = null;
    return this.database.collection<UserDocument>('users')
      .find(filter, { session: this.session }).sort({ createdAt: 1 }).toArray();
  }

  async countUsers(includeDeleted = false): Promise<number> {
    const filter: Filter<UserDocument> = { shopId: this.shopId };
    if (!includeDeleted) filter.deletedAt = null;
    return this.database.collection<UserDocument>('users').countDocuments(filter, { session: this.session });
  }

  async countRole(role: Role, activeOnly: boolean): Promise<number> {
    const filter: Filter<UserDocument> = { shopId: this.shopId, role, deletedAt: null };
    if (activeOnly) filter.isActive = true;
    return this.database.collection<UserDocument>('users').countDocuments(filter, { session: this.session });
  }

  async findDuplicate(
    field: 'usernameNormalized' | 'emailNormalized',
    value: string,
    exceptId?: ObjectId,
  ): Promise<boolean> {
    const filter: Filter<UserDocument> = { shopId: this.shopId, [field]: value };
    if (exceptId) filter._id = { $ne: exceptId };
    return (await this.database.collection<UserDocument>('users').findOne(
      filter,
      { projection: { _id: 1 }, session: this.session },
    )) !== null;
  }

  async insertUser(user: UserRecord): Promise<void> {
    await this.database.collection<UserDocument>('users').insertOne(user, { session: this.session });
  }

  async updateUser(id: ObjectId, update: Partial<UserRecord>): Promise<boolean> {
    const result = await this.database.collection<UserDocument>('users')
      .updateOne({ _id: id, shopId: this.shopId }, { $set: update }, { session: this.session });
    return result.matchedCount === 1;
  }

  async writeAudit(event: AuditRecord): Promise<void> {
    await this.database.collection<AuditRecord>('auditLogs').insertOne(event, { session: this.session });
  }

  async writeTrash(event: {
    shopId: ObjectId;
    actorId: ObjectId;
    entityId: ObjectId;
    action: 'deleted' | 'restored';
    displayName: string;
    role: Role;
    occurredAt: Date;
  }): Promise<void> {
    await this.database.collection('trashEvents').insertOne({
      ...event,
      entityType: 'profile',
    }, { session: this.session });
  }
}

export class MongoPharmacyRepository implements PharmacyRepository {
  private readonly database: Db;

  constructor(private readonly client: MongoClient, databaseName: string) {
    this.database = client.db(databaseName);
  }

  async findShopBySlug(slug: string): Promise<ShopRecord | null> {
    return this.database.collection<ShopRecord>('shops').findOne({ slug });
  }

  async findShopById(id: ObjectId): Promise<ShopRecord | null> {
    return this.database.collection<ShopRecord>('shops').findOne({ _id: id });
  }

  async findUserByLogin(shopId: ObjectId, usernameOrEmail: string): Promise<UserRecord | null> {
    return this.database.collection<UserDocument>('users').findOne({
      shopId,
      $or: [{ usernameNormalized: usernameOrEmail }, { emailNormalized: usernameOrEmail }],
      deletedAt: null,
    });
  }

  async findUserById(id: ObjectId): Promise<UserRecord | null> {
    return this.database.collection<UserDocument>('users').findOne({ _id: id, deletedAt: null });
  }

  async listUsers(shopId: ObjectId, includeDeleted: boolean): Promise<UserRecord[]> {
    const filter: Filter<UserDocument> = { shopId };
    if (!includeDeleted) filter.deletedAt = null;
    return this.database.collection<UserDocument>('users')
      .find(filter).sort({ createdAt: includeDeleted ? -1 : 1 }).toArray();
  }

  async consumeLoginRateLimit(bucketKey: string, expiresAt: Date): Promise<number> {
    const result = await this.database.collection<{ _id: string; count: number; expiresAt: Date }>('authRateLimits').findOneAndUpdate(
      { _id: bucketKey },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false },
    );
    if (!result) throw new Error('Could not record login rate-limit attempt');
    return result.count as number;
  }

  async clearExpiredLock(id: ObjectId, now: Date): Promise<void> {
    await this.database.collection<UserDocument>('users').updateOne(
      { _id: id, lockedUntil: { $lte: now, $ne: null } },
      { $set: { failedLogins: 0, lockedUntil: null, updatedAt: now } },
    );
  }

  async recordLoginFailure(
    id: ObjectId,
    now: Date,
    failureLimit: number,
    lockDurationMs: number,
  ): Promise<UserRecord | null> {
    const activeLock = { $gt: ['$lockedUntil', now] };
    const nextCount = { $add: [{ $ifNull: ['$failedLogins', 0] }, 1] };
    const result = await this.database.collection<UserDocument>('users').findOneAndUpdate(
      { _id: id },
      [{
        $set: {
          failedLogins: { $cond: [activeLock, '$failedLogins', nextCount] },
          lockedUntil: {
            $cond: [
              activeLock,
              '$lockedUntil',
              {
                $cond: [
                  { $gte: [nextCount, failureLimit] },
                  new Date(now.getTime() + lockDurationMs),
                  null,
                ],
              },
            ],
          },
          updatedAt: now,
        },
      }],
      { returnDocument: 'after', includeResultMetadata: false },
    );
    return result;
  }

  async clearLoginFailures(id: ObjectId, now: Date): Promise<void> {
    await this.database.collection<UserDocument>('users').updateOne(
      { _id: id },
      { $set: { failedLogins: 0, lockedUntil: null, updatedAt: now } },
    );
  }

  async findRefreshSessionByHash(tokenHash: string): Promise<RefreshSessionRecord | null> {
    return this.database.collection<RefreshDocument>('refreshSessions').findOne({ tokenHash });
  }

  async createLoginSession(session: RefreshSessionRecord, audit: AuditRecord): Promise<void> {
    const mongoSession = this.client.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        await this.database.collection<RefreshDocument>('refreshSessions').insertOne(session, { session: mongoSession });
        await this.database.collection<AuditRecord>('auditLogs').insertOne(audit, { session: mongoSession });
      });
    } finally {
      await mongoSession.endSession();
    }
  }

  async rotateLoginSession(
    oldSession: RefreshSessionRecord,
    newSession: RefreshSessionRecord,
    now: Date,
    audit: AuditRecord,
  ): Promise<boolean> {
    const mongoSession = this.client.startSession();
    let rotated = false;
    try {
      await mongoSession.withTransaction(async () => {
        const result = await this.database.collection<RefreshDocument>('refreshSessions').updateOne(
          {
            _id: oldSession._id,
            rotatedAt: { $exists: false },
            revokedAt: { $exists: false },
            expiresAt: { $gt: now },
          },
          { $set: { rotatedAt: now, replacedBySessionId: newSession._id } },
          { session: mongoSession },
        );
        if (result.modifiedCount !== 1) return;
        await this.database.collection<RefreshDocument>('refreshSessions').insertOne(newSession, { session: mongoSession });
        await this.database.collection<AuditRecord>('auditLogs').insertOne(audit, { session: mongoSession });
        rotated = true;
      });
      return rotated;
    } finally {
      await mongoSession.endSession();
    }
  }

  async revokeRefreshFamily(familyId: ObjectId, now: Date, reason: string, audit: AuditRecord): Promise<void> {
    const mongoSession = this.client.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        await this.database.collection<RefreshDocument>('refreshSessions').updateMany(
          { familyId, revokedAt: { $exists: false } },
          { $set: { revokedAt: now, revocationReason: reason } },
          { session: mongoSession },
        );
        await this.database.collection<AuditRecord>('auditLogs').insertOne(audit, { session: mongoSession });
      });
    } finally {
      await mongoSession.endSession();
    }
  }

  async logoutRefreshSession(session: RefreshSessionRecord, now: Date, audit: AuditRecord): Promise<void> {
    await this.revokeRefreshFamily(session.familyId, now, 'logout', audit);
  }

  async writeAudit(event: AuditRecord): Promise<void> {
    await this.database.collection<AuditRecord>('auditLogs').insertOne(event);
  }

  async withShopTransaction<T>(
    shopId: ObjectId,
    operation: (transaction: UserWriteTransaction) => Promise<T>,
  ): Promise<T> {
    const session = this.client.startSession();
    let response: T | undefined;
    try {
      await session.withTransaction(async () => {
        const lock = await this.database.collection('shops').updateOne(
          { _id: shopId, status: 'ACTIVE' },
          { $inc: { userWriteVersion: 1 } },
          { session },
        );
        if (lock.matchedCount !== 1) throw new Error('Shop is unavailable');
        response = await operation(new MongoUserWriteTransaction(this.database, session, shopId));
      });
      if (response === undefined) throw new Error('User transaction did not produce a result');
      return response;
    } finally {
      await session.endSession();
    }
  }
}

export { ObjectId };
