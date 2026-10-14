import { createInterface, emitKeypressEvents } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { MongoClient, ObjectId } from 'mongodb';
import { z } from 'zod';
import { hashPassword } from '../auth-crypto.js';
import { loadConfig } from '../config.js';
import type { UserRecord } from '../models.js';
import { MODULE_KEYS } from '../permissions.js';

const identitySchema = z.object({
  shopSlug: z.string().trim().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/),
  shopName: z.string().trim().min(1).max(160),
  username: z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}._-]+$/u),
  email: z.string().trim().email().max(254),
  fullName: z.string().trim().min(1).max(160),
}).strict();

function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    terminal.question(question, (answer) => {
      terminal.close();
      resolve(answer);
    });
  });
}

function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('The super-admin seed command requires an interactive terminal.'));
  }
  return new Promise((resolve, reject) => {
    stdout.write(question);
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('keypress', onKeypress);
      stdin.setRawMode(false);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        finish(new Error('Seed command cancelled.'));
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
      } else if (key.name === 'backspace' || key.name === 'delete') {
        value = value.slice(0, -1);
      } else if (!key.ctrl && character && character.length === 1) {
        value += character;
      }
    };
    stdin.on('keypress', onKeypress);
  });
}

function log(event: string): void {
  stdout.write(`${JSON.stringify({ event })}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const values = identitySchema.parse({
    shopSlug: (await ask(`Shop slug [${config.bootstrapShopSlug}]: `)).trim() || config.bootstrapShopSlug,
    shopName: await ask('Shop name: '),
    username: await ask('Super-admin username: '),
    email: await ask('Super-admin email: '),
    fullName: await ask('Super-admin full name: '),
  });
  const password = await askSecret('Super-admin password (input hidden): ');
  const confirmation = await askSecret('Confirm password (input hidden): ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  if (password.length < 8 || password.length > 1024) {
    throw new Error('Password must be between 8 and 1024 characters.');
  }

  const client = new MongoClient(config.mongoUri, {
    appName: 'pharma-care-superadmin-seed',
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const database = client.db(config.mongoDbName);
    const now = new Date();
    const shopId = new ObjectId();
    const userId = new ObjectId();
    const slug = values.shopSlug.toLowerCase();
    const usernameNormalized = values.username.toLocaleLowerCase('en-US');
    const emailNormalized = values.email.toLocaleLowerCase('en-US');
    const passwordHash = await hashPassword(password);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const shops = database.collection('shops');
        const existingShop = await shops.findOne({ slug }, { session });
        const targetShopId = existingShop?._id ?? shopId;
        if (!existingShop) {
          await shops.insertOne({
            _id: shopId,
            slug,
            name: values.shopName,
            status: 'ACTIVE',
            createdAt: now,
            updatedAt: now,
            userWriteVersion: 0,
          }, { session });
        }
        await shops.updateOne(
          { _id: targetShopId, status: 'ACTIVE' },
          { $inc: { userWriteVersion: 1 } },
          { session },
        );
        const users = database.collection<UserRecord>('users');
        if (await users.countDocuments({ shopId: targetShopId }, { session }) > 0) {
          throw new Error('This shop already has users; refusing to create another bootstrap account.');
        }
        const user: UserRecord = {
          _id: userId,
          shopId: targetShopId,
          username: values.username,
          usernameNormalized,
          email: values.email,
          emailNormalized,
          fullName: values.fullName,
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
        await database.collection('auditLogs').insertOne({
          shopId: targetShopId,
          actorId: userId,
          entityId: userId,
          entityType: 'user',
          event: 'user.bootstrap_super_admin',
          after: {
            username: values.username,
            email: values.email,
            fullName: values.fullName,
            role: 'super_admin',
          },
          occurredAt: now,
        }, { session });
      });
    } finally {
      await session.endSession();
    }
    log('superadmin_seeded');
  } finally {
    await client.close();
  }
}

try {
  await main();
} catch (error) {
  const reason = error instanceof Error ? error.message : 'unknown_error';
  process.stderr.write(`${JSON.stringify({ event: 'superadmin_seed_failed', reason })}\n`);
  process.exitCode = 1;
}
