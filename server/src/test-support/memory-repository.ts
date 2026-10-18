import { ObjectId } from 'mongodb';
import type {
  AuditRecord,
  PharmacyRepository,
  RefreshSessionRecord,
  ShopRecord,
  UserRecord,
  UserWriteTransaction,
} from '../models.js';
import type { Role } from '../permissions.js';

export class MemoryRepository implements PharmacyRepository {
  readonly shops = new Map<string, ShopRecord>();
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, RefreshSessionRecord>();
  readonly audits: AuditRecord[] = [];
  readonly trash: unknown[] = [];
  private readonly limits = new Map<string, number>();

  addShop(name = 'Test Pharmacy'): ShopRecord {
    const shop: ShopRecord = {
      _id: new ObjectId(),
      slug: 'test-shop',
      name,
      status: 'ACTIVE',
    };
    this.shops.set(shop._id.toHexString(), shop);
    return shop;
  }

  addUser(shop: ShopRecord, values: Partial<UserRecord> = {}): UserRecord {
    const now = new Date();
    const username = values.username ?? 'owner';
    const user: UserRecord = {
      _id: new ObjectId(),
      shopId: shop._id,
      username,
      usernameNormalized: username.toLowerCase(),
      email: values.email ?? 'owner@example.test',
      emailNormalized: (values.email ?? 'owner@example.test').toLowerCase(),
      fullName: values.fullName ?? 'Test Owner',
      role: values.role ?? 'admin',
      isActive: values.isActive ?? true,
      permissions: values.permissions ?? ['pos', 'manage_users'],
      passwordHash: values.passwordHash ?? '',
      failedLogins: values.failedLogins ?? 0,
      lockedUntil: values.lockedUntil ?? null,
      deletedAt: values.deletedAt ?? null,
      createdAt: values.createdAt ?? now,
      updatedAt: values.updatedAt ?? now,
    };
    this.users.set(user._id.toHexString(), user);
    return user;
  }

  async findShopBySlug(slug: string): Promise<ShopRecord | null> {
    return [...this.shops.values()].find((shop) => shop.slug === slug) ?? null;
  }

  async findShopById(id: ObjectId): Promise<ShopRecord | null> {
    return this.shops.get(id.toHexString()) ?? null;
  }

  async findUserByLogin(shopId: ObjectId, usernameOrEmail: string): Promise<UserRecord | null> {
    return [...this.users.values()].find((user) =>
      user.shopId.equals(shopId) &&
      (user.usernameNormalized === usernameOrEmail || user.emailNormalized === usernameOrEmail) &&
      user.deletedAt === null,
    ) ?? null;
  }

  async findUserById(id: ObjectId): Promise<UserRecord | null> {
    const user = this.users.get(id.toHexString());
    return user && user.deletedAt === null ? user : null;
  }

  async listUsers(shopId: ObjectId, includeDeleted: boolean): Promise<UserRecord[]> {
    return [...this.users.values()].filter((user) =>
      user.shopId.equals(shopId) && (includeDeleted || user.deletedAt === null),
    );
  }

  async consumeLoginRateLimit(bucketKey: string): Promise<number> {
    const count = (this.limits.get(bucketKey) ?? 0) + 1;
    this.limits.set(bucketKey, count);
    return count;
  }

  async clearExpiredLock(id: ObjectId, now: Date): Promise<void> {
    const user = this.users.get(id.toHexString());
    if (user?.lockedUntil && user.lockedUntil.getTime() <= now.getTime()) {
      user.lockedUntil = null;
      user.failedLogins = 0;
    }
  }

  async recordLoginFailure(id: ObjectId, now: Date, limit: number, lockMs: number): Promise<UserRecord | null> {
    const user = this.users.get(id.toHexString());
    if (!user) return null;
    if (!user.lockedUntil || user.lockedUntil.getTime() <= now.getTime()) {
      user.failedLogins += 1;
      user.lockedUntil = user.failedLogins >= limit ? new Date(now.getTime() + lockMs) : null;
    }
    return user;
  }

  async clearLoginFailures(id: ObjectId): Promise<void> {
    const user = this.users.get(id.toHexString());
    if (user) {
      user.failedLogins = 0;
      user.lockedUntil = null;
    }
  }

  async findRefreshSessionByHash(tokenHash: string): Promise<RefreshSessionRecord | null> {
    return [...this.sessions.values()].find((session) => session.tokenHash === tokenHash) ?? null;
  }

  async createLoginSession(session: RefreshSessionRecord, audit: AuditRecord): Promise<void> {
    this.sessions.set(session._id.toHexString(), session);
    this.audits.push(audit);
  }

  async rotateLoginSession(
    oldSession: RefreshSessionRecord,
    newSession: RefreshSessionRecord,
    now: Date,
    audit: AuditRecord,
  ): Promise<boolean> {
    const current = this.sessions.get(oldSession._id.toHexString());
    if (!current || current.rotatedAt || current.revokedAt || current.expiresAt <= now) return false;
    current.rotatedAt = now;
    current.replacedBySessionId = newSession._id;
    this.sessions.set(newSession._id.toHexString(), newSession);
    this.audits.push(audit);
    return true;
  }

  async revokeRefreshFamily(familyId: ObjectId, now: Date, reason: string, audit: AuditRecord): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.familyId.equals(familyId) && !session.revokedAt) {
        session.revokedAt = now;
        session.revocationReason = reason;
      }
    }
    this.audits.push(audit);
  }

  async logoutRefreshSession(session: RefreshSessionRecord, now: Date, audit: AuditRecord): Promise<void> {
    await this.revokeRefreshFamily(session.familyId, now, 'logout', audit);
  }

  async writeAudit(event: AuditRecord): Promise<void> {
    this.audits.push(event);
  }

  async withShopTransaction<T>(
    shopId: ObjectId,
    operation: (transaction: UserWriteTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction: UserWriteTransaction = {
      findUser: async (id, includeDeleted = false) => {
        const user = this.users.get(id.toHexString());
        return user && user.shopId.equals(shopId) && (includeDeleted || user.deletedAt === null) ? user : null;
      },
      listUsers: async (includeDeleted) =>
        [...this.users.values()].filter((user) =>
          user.shopId.equals(shopId) && (includeDeleted || user.deletedAt === null),
        ),
      countUsers: async (includeDeleted = false) =>
        [...this.users.values()].filter((user) =>
          user.shopId.equals(shopId) && (includeDeleted || user.deletedAt === null),
        ).length,
      countRole: async (role: Role, activeOnly: boolean) =>
        [...this.users.values()].filter((user) =>
          user.shopId.equals(shopId) &&
          user.role === role &&
          user.deletedAt === null &&
          (!activeOnly || user.isActive),
        ).length,
      findDuplicate: async (field, value, exceptId) =>
        [...this.users.values()].some((user) =>
          user.shopId.equals(shopId) &&
          user._id.toHexString() !== exceptId?.toHexString() &&
          user[field] === value,
        ),
      insertUser: async (user) => {
        this.users.set(user._id.toHexString(), user);
      },
      updateUser: async (id, update) => {
        const user = this.users.get(id.toHexString());
        if (!user || !user.shopId.equals(shopId)) return false;
        Object.assign(user, update);
        return true;
      },
      writeAudit: async (event) => {
        this.audits.push(event);
      },
      writeTrash: async (event) => {
        this.trash.push(event);
      },
    };
    return operation(transaction);
  }
}
