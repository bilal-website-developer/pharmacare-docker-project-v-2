import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MongoClient, ObjectId } from 'mongodb';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { hashPassword } from './auth-crypto.js';
import { verifyLicence, type SignedLicence } from './licence.js';
import type { UserRecord } from './models.js';
import { MODULE_KEYS } from './permissions.js';

export interface SetupCollectionNames {
  shops: string;
  users: string;
  setupState: string;
  auditLogs: string;
  controlPlaneState?: string;
}

export interface ControlPlaneActivationResponse {
  device_key: string;
  licence: SignedLicence;
}

export type ControlPlaneActivator = (activationCode: string) => Promise<ControlPlaneActivationResponse>;

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

interface ControlPlaneStateRecord {
  _id: 'control-plane';
  controlPlaneShopId: string;
  deviceKeyHash: string;
  licence: SignedLicence;
  lastSeenAt: Date;
  status: 'active' | 'suspended';
}

const DEFAULT_COLLECTIONS: SetupCollectionNames = {
  shops: 'shops',
  users: 'users',
  setupState: 'setupState',
  auditLogs: 'auditLogs',
  controlPlaneState: 'controlPlaneState',
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
  activationCode: z.string().trim().min(12).max(128),
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

class SetupActivationError extends Error {
  constructor(readonly statusCode: number, readonly errorCode: string) {
    super(errorCode);
  }
}

async function activateAtControlPlane(
  config: AppConfig,
  activationCode: string,
  fetcher: typeof fetch = fetch,
): Promise<ControlPlaneActivationResponse> {
  if (!config.controlPlaneUrl) throw new SetupActivationError(503, 'CONTROL_PLANE_UNAVAILABLE');
  let response: Response;
  try {
    response = await fetcher(new URL('/functions/v1/control-plane/activate', config.controlPlaneUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activation_code: activationCode, device_name: 'shop-server' }),
    });
  } catch {
    throw new SetupActivationError(503, 'CONTROL_PLANE_UNAVAILABLE');
  }
  if (response.status === 403) throw new SetupActivationError(403, 'ACTIVATION_CODE_INVALID');
  if (!response.ok) throw new SetupActivationError(502, 'CONTROL_PLANE_ACTIVATION_FAILED');

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new SetupActivationError(502, 'CONTROL_PLANE_ACTIVATION_FAILED');
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new SetupActivationError(502, 'CONTROL_PLANE_ACTIVATION_FAILED');
  }
  const activation = result as Record<string, unknown>;
  if (typeof activation.device_key !== 'string'
    || typeof activation.licence !== 'object' || activation.licence === null || Array.isArray(activation.licence)) {
    throw new SetupActivationError(502, 'CONTROL_PLANE_ACTIVATION_FAILED');
  }
  return {
    device_key: activation.device_key,
    licence: activation.licence as SignedLicence,
  };
}

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

async function writeUpdaterConfiguration(
  config: AppConfig,
  deviceKeyHash: string,
  timeZone: string,
): Promise<void> {
  if (!config.updaterConfigPath) return;
  if (!config.controlPlaneUrl || !config.licencePublicKey) {
    throw new SetupActivationError(503, 'UPDATER_CONFIGURATION_UNAVAILABLE');
  }

  const directory = dirname(config.updaterConfigPath);
  const publicKeyPath = join(directory, 'licence-public.pem');
  const temporaryConfigPath = `${config.updaterConfigPath}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(publicKeyPath, config.licencePublicKey.replace(/\\n/g, '\n').trim() + '\n', {
    encoding: 'utf8',
    mode: 0o644,
  });
  try {
    await writeFile(temporaryConfigPath, `${JSON.stringify({
      controlPlaneUrl: config.controlPlaneUrl,
      deviceKeyHash,
      channel: 'stable',
      timezone: timeZone,
      publicKeyPath: 'licence-public.pem',
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryConfigPath, config.updaterConfigPath);
  } finally {
    await rm(temporaryConfigPath, { force: true });
  }
}

export function registerSetupRoutes(
  app: FastifyInstance,
  client: MongoClient,
  config: AppConfig,
  collections: SetupCollectionNames = DEFAULT_COLLECTIONS,
  activator: ControlPlaneActivator = (activationCode) => activateAtControlPlane(config, activationCode),
): void {
  const database = client.db(config.mongoDbName);
  const shops = database.collection<SetupShopRecord>(collections.shops);
  const users = database.collection<UserRecord>(collections.users);
  const setupState = database.collection<SetupStateRecord>(collections.setupState);
  const auditLogs = database.collection(collections.auditLogs);
  const controlPlaneState = database.collection<ControlPlaneStateRecord>(
    collections.controlPlaneState ?? 'controlPlaneState',
  );

  app.get('/api/setup/status', async (_request, reply) => {
    const [shopCount, consumed] = await Promise.all([
      shops.countDocuments({}, { limit: 1 }),
      setupState.findOne({ _id: 'initial-setup' }, { projection: { _id: 1 } }),
    ]);
    return reply.send({ needsSetup: shopCount === 0 && consumed === null });
  });

  app.post('/api/setup', async (request, reply) => {
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path.join('.');
        if (field && !fields[field]) fields[field] = issue.message;
      }
      return reply.code(400).send({ error: 'VALIDATION_FAILED', fields });
    }
    if (!config.setupCodeHash || !config.setupCodeExpiresAt) {
      return reply.code(503).send({ error: 'SETUP_UNAVAILABLE' });
    }
    if (config.setupCodeExpiresAt.getTime() <= Date.now()
      || !setupCodeMatches(parsed.data.setupCode, config.setupCodeHash)) {
      return reply.code(403).send({ error: 'SETUP_CODE_INVALID' });
    }

    const now = new Date();
    if (await shops.countDocuments({}, { limit: 1 }) > 0
      || await setupState.findOne({ _id: 'initial-setup' }, { projection: { _id: 1 } })) {
      return reply.code(409).send({ error: 'SETUP_ALREADY_COMPLETED' });
    }
    if (!config.licencePublicKey) return reply.code(503).send({ error: 'LICENCE_VERIFICATION_UNAVAILABLE' });
    if (config.updaterConfigPath && !config.controlPlaneUrl) {
      return reply.code(503).send({ error: 'UPDATER_CONFIGURATION_UNAVAILABLE' });
    }
    let activation: ControlPlaneActivationResponse;
    try {
      activation = await activator(parsed.data.activationCode);
    } catch (error) {
      if (error instanceof SetupActivationError) {
        return reply.code(error.statusCode).send({ error: error.errorCode });
      }
      throw error;
    }
    if (!activation.device_key || !await verifyLicence(
      activation.licence,
      config.licencePublicKey,
      activation.licence.payload?.shop_id,
    )) {
      return reply.code(502).send({ error: 'LICENCE_SIGNATURE_INVALID' });
    }
    const deviceKeyHash = createHash('sha256').update(activation.device_key).digest('hex');
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
          controlPlaneShopId: activation.licence.payload.shop_id,
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
          role: 'admin',
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
        await controlPlaneState.insertOne({
          _id: 'control-plane',
          controlPlaneShopId: activation.licence.payload.shop_id,
          deviceKeyHash,
          licence: activation.licence,
          lastSeenAt: now,
          status: 'active',
        }, { session });
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
            event: 'user.bootstrap_admin',
            after: {
              username: parsed.data.username,
              email: parsed.data.email,
              fullName: parsed.data.fullName,
              role: 'admin',
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
    try {
      await writeUpdaterConfiguration(config, deviceKeyHash, parsed.data.timeZone);
    } catch (error) {
      request.log.error({ err: error }, 'Failed to provision host updater configuration after setup.');
      return reply.code(500).send({ error: 'UPDATER_CONFIGURATION_FAILED' });
    }
    return reply.code(201).send({ created: true });
  });
}
