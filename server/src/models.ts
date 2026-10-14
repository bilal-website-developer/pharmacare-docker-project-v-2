import type { ObjectId } from 'mongodb';
import type { Role, PermissionKey } from './permissions.js';

export interface ShopRecord {
  _id: ObjectId;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
}

export interface UserRecord {
  _id: ObjectId;
  shopId: ObjectId;
  username: string;
  usernameNormalized: string;
  email: string;
  emailNormalized: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  permissions: PermissionKey[];
  passwordHash: string;
  failedLogins: number;
  lockedUntil: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshSessionRecord {
  _id: ObjectId;
  shopId: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  familyId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
  rotatedAt?: Date;
  replacedBySessionId?: ObjectId;
  revokedAt?: Date;
  revocationReason?: string;
}

export interface AuditRecord {
  shopId?: ObjectId;
  actorId?: ObjectId;
  event: string;
  entityType: string;
  entityId?: ObjectId;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  occurredAt: Date;
}

export interface UserWriteTransaction {
  findUser(id: ObjectId, includeDeleted?: boolean): Promise<UserRecord | null>;
  listUsers(includeDeleted: boolean): Promise<UserRecord[]>;
  countUsers(includeDeleted?: boolean): Promise<number>;
  countRole(role: Role, activeOnly: boolean): Promise<number>;
  findDuplicate(field: 'usernameNormalized' | 'emailNormalized', value: string, exceptId?: ObjectId): Promise<boolean>;
  insertUser(user: UserRecord): Promise<void>;
  updateUser(id: ObjectId, update: Partial<UserRecord>): Promise<boolean>;
  writeAudit(event: AuditRecord): Promise<void>;
  writeTrash(event: {
    shopId: ObjectId;
    actorId: ObjectId;
    entityId: ObjectId;
    action: 'deleted' | 'restored';
    displayName: string;
    role: Role;
    occurredAt: Date;
  }): Promise<void>;
}

export interface PharmacyRepository {
  findShopBySlug(slug: string): Promise<ShopRecord | null>;
  findShopById(id: ObjectId): Promise<ShopRecord | null>;
  findUserByLogin(shopId: ObjectId, usernameOrEmail: string): Promise<UserRecord | null>;
  findUserById(id: ObjectId): Promise<UserRecord | null>;
  listUsers(shopId: ObjectId, includeDeleted: boolean): Promise<UserRecord[]>;
  consumeLoginRateLimit(bucketKey: string, expiresAt: Date): Promise<number>;
  clearExpiredLock(id: ObjectId, now: Date): Promise<void>;
  recordLoginFailure(id: ObjectId, now: Date, failureLimit: number, lockDurationMs: number): Promise<UserRecord | null>;
  clearLoginFailures(id: ObjectId, now: Date): Promise<void>;
  findRefreshSessionByHash(tokenHash: string): Promise<RefreshSessionRecord | null>;
  createLoginSession(session: RefreshSessionRecord, audit: AuditRecord): Promise<void>;
  rotateLoginSession(
    oldSession: RefreshSessionRecord,
    newSession: RefreshSessionRecord,
    now: Date,
    audit: AuditRecord,
  ): Promise<boolean>;
  revokeRefreshFamily(familyId: ObjectId, now: Date, reason: string, audit: AuditRecord): Promise<void>;
  logoutRefreshSession(session: RefreshSessionRecord, now: Date, audit: AuditRecord): Promise<void>;
  writeAudit(event: AuditRecord): Promise<void>;
  withShopTransaction<T>(shopId: ObjectId, operation: (transaction: UserWriteTransaction) => Promise<T>): Promise<T>;
}
