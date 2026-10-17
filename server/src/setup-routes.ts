import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { MongoClient, ObjectId } from 'mongodb';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { hashPassword } from './auth-crypto.js';
import type { UserRecord } from './models.js';
import { MODULE_KEYS } from './permissions.js';

export interface SetupCollectionNames {
  shops: string;
  users: string;
  setupState: string;
  auditLogs: string;
}

interface SetupShopRecord {
  _id: ObjectId;
  slug: string;
  [key: string]: unknown;
}

interface SetupStateRecord {
  _id: string;
  shopId: ObjectId;
  consumedAt: Date;
}

const DEFAULT_COLLECTIONS: SetupCollectionNames = {
  shops: 'shops',
  users: 'users',
  setupState: 'setupState',
  auditLogs: 'auditLogs',
};

const passwordSchema = z.string().min(12).max(1024).superRefine((password, context) => {
  const characterClasses = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (characterClasses < 3 || new Set(password).size < 8) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Password does not meet strength requirements.' });
  }
});

const setupSchema = z.object({
  setupCode: z.string().min(32).max(128),
  shopName: z.string().trim().min(1).max(160),
  phone: z.string().trim().max(80).default(''),
  address: z.string().trim().max(1000).default(''),
  timeZone: z.string().trim().min(1).max(100).default('Asia/Karachi')
    .refine((timeZone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return true;
      } catch {
        return false;
      }
    }),
  username: z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}._-]+$/u),
  email: z.string().trim().email().max(254),
  fullName: z.string().trim().min(1).max(160),
  password: passwordSchema,
}).strict();

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 11000;
}

function setupCodeMatches(code: string, expectedHash: string): boolean {
  const supplied = createHash('sha256').update(code, 'utf8').digest();
  const expected = Buffer.from(expectedHash, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function registerSetupRoutes(
  app: FastifyInstance,
  client: MongoClient,
  config: AppConfig,
  collections: SetupCollectionNames = DEFAULT_COLLECTIONS,
): void {
  const database = client.db(config.mongoDbName);
  const shops = database.collection<SetupShopRecord>(collections.shops);
  const users = database.collection<UserRecord>(collections.users);
  const setupState = database.collection<SetupStateRecord>(collections.setupState);
  const auditLogs = database.collection(collections.auditLogs);

  app.get('/api/setup/status', async (_request, reply) => {
    const [shopCount, consumed] = await Promise.all([
      shops.countDocuments({}, { limit: 1 }),
      setupState.findOne({ _id: 'initial-setup' }, { projection: { _id: 1 } }),
    ]);
    return reply.send({ needsSetup: shopCount === 0 && consumed === null });
  });

  app.post('/api/setup', async (request, reply) => {
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    if (!config.setupCodeHash || !config.setupCodeExpiresAt) {
      return reply.code(503).send({ error: 'SETUP_UNAVAILABLE' });
    }
    if (config.setupCodeExpiresAt.getTime() <= Date.now()
      || !setupCodeMatches(parsed.data.setupCode, config.setupCodeHash)) {
      return reply.code(403).send({ error: 'SETUP_CODE_INVALID' });
    }

    const now = new Date();
    const shopId = new ObjectId();
    const userId = new ObjectId();
    const usernameNormalized = parsed.data.username.toLocaleLowerCase('en-US');
    const emailNormalized = parsed.data.email.toLocaleLowerCase('en-US');
    const passwordHash = await hashPassword(parsed.data.password);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        if (await shops.countDocuments({}, { session }) > 0
          || await setupState.findOne({ _id: 'initial-setup' }, { session })) {
          throw new Error('SETUP_ALREADY_COMPLETED');
        }
        await setupState.insertOne({
          _id: 'initial-setup',
          shopId,
          consumedAt: now,
        }, { session });
        await shops.insertOne({
          _id: shopId,
          slug: config.bootstrapShopSlug,
          name: parsed.data.shopName,
          status: 'ACTIVE',
          timeZone: parsed.data.timeZone,
          profile: {
            displayName: parsed.data.shopName,
            address: parsed.data.address,
            phone: parsed.data.phone,
            city: '',
          },
          memoSettings: {
            storeName: parsed.data.shopName,
            address: parsed.data.address,
            phone: parsed.data.phone,
            notes: ['', '', ''],
            terminalName: '',
            showBatchExpiry: true,
            roundNet: 'none',
            printTax: false,
            duplicateLabel: false,
            autoPrint: false,
            numberDigits: 6,
          },
          receiptSettings: { format: 'thermal80', template: 'pharmacy-memo' },
          createdAt: now,
          updatedAt: now,
          userWriteVersion: 0,
        }, { session });
        const user: UserRecord = {
          _id: userId,
          shopId,
          username: parsed.data.username,
          usernameNormalized,
          email: parsed.data.email,
          emailNormalized,
          fullName: parsed.data.fullName,
          role: 'super_admin',
          isActive: true,
          permissions: [...MODULE_KEYS],
          passwordHash,
          failedLogins: 0,
          lockedUntil: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await users.insertOne(user, { session });
        await auditLogs.insertMany([
          {
            shopId,
            actorId: userId,
            entityId: shopId,
            entityType: 'shop',
            event: 'setup.completed',
            after: { slug: config.bootstrapShopSlug, name: parsed.data.shopName },
            occurredAt: now,
          },
          {
            shopId,
            actorId: userId,
            entityId: userId,
            entityType: 'user',
            event: 'user.bootstrap_super_admin',
            after: {
              username: parsed.data.username,
              email: parsed.data.email,
              fullName: parsed.data.fullName,
              role: 'super_admin',
            },
            occurredAt: now,
          },
        ], { session });
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'SETUP_ALREADY_COMPLETED') {
        return reply.code(409).send({ error: 'SETUP_ALREADY_COMPLETED' });
      }
      if (isDuplicateKey(error)) return reply.code(409).send({ error: 'SETUP_ALREADY_COMPLETED' });
      throw error;
    } finally {
      await session.endSession();
    }
    return reply.code(201).send({ created: true });
  });
}
