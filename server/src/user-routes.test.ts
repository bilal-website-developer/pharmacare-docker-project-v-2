import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { createAccessToken } from './auth-crypto.js';
import { createApp } from './app.js';
import type { UserRecord } from './models.js';
import { MemoryRepository } from './test-support/memory-repository.js';
import { MemoryIdempotencyStore } from './test-support/memory-idempotency-store.js';
import { testConfig } from './test-support/test-config.js';

function bearer(user: UserRecord, shopId = user.shopId.toHexString()): string {
  return createAccessToken({
    id: user._id.toHexString(),
    shopId,
    role: user.role,
  }, {
    accessSecret: testConfig.accessTokenSecret,
    refreshPepper: testConfig.refreshTokenPepper,
    accessTokenTtlSeconds: testConfig.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: testConfig.refreshTokenTtlSeconds,
  }).token;
}

async function makeApp(repository: MemoryRepository) {
  const client = new MongoClient('mongodb://127.0.0.1:1');
  const app = createApp(client, testConfig, repository, undefined, undefined, new MemoryIdempotencyStore());
  await app.ready();
  return { app, client };
}

function headers(user: UserRecord) {
  return {
    authorization: `Bearer ${bearer(user)}`,
    'idempotency-key': new ObjectId().toHexString(),
  };
}

test('user list returns policy capabilities and never returns password or lockout internals', async () => {
  const repository = new MemoryRepository();
  const shop = repository.addShop();
  const manager = repository.addUser(shop, {
    username: 'manager',
    email: 'manager@example.test',
    role: 'manager',
    permissions: ['manage_users', 'customers', 'pos', 'pos_print_sale'],
  });
  const managed = repository.addUser(shop, {
    username: 'cashier',
    email: 'cashier@example.test',
    role: 'cashier',
    permissions: ['pos'],
    passwordHash: 'secret-hash-not-for-dto',
  });
  const { app, client } = await makeApp(repository);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: headers(manager),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().assignable_roles, ['cashier', 'manager', 'accountant']);
    assert.deepEqual(response.json().grantable_permissions, ['customers', 'pos', 'pos_print_sale']);
    assert.equal(response.json().users.find((user: { id: string }) => user.id === managed._id.toHexString()).can_manage, true);
    assert.equal(response.body.includes('secret-hash-not-for-dto'), false);
    assert.equal(response.body.includes('failedLogins'), false);
    assert.equal(response.body.includes('lockedUntil'), false);
  } finally {
    await app.close();
    await client.close();
  }
});

test('admin can manage another admin account', async () => {
  const repository = new MemoryRepository();
  const shop = repository.addShop();
  const admin = repository.addUser(shop, {
    username: 'admin-one',
    email: 'admin-one@example.test',
    role: 'admin',
    permissions: [],
  });
  const otherAdmin = repository.addUser(shop, {
    username: 'admin-two',
    email: 'admin-two@example.test',
    role: 'admin',
    permissions: [],
  });
  const { app, client } = await makeApp(repository);
  try {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/users/${otherAdmin._id.toHexString()}`,
      headers: headers(admin),
      payload: {
        username: otherAdmin.username,
        email: otherAdmin.email,
        fullName: 'Updated Admin',
        role: 'manager',
        permissions: ['customers'],
        isActive: true,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((await repository.findUserById(otherAdmin._id))?.role, 'manager');
  } finally {
    await app.close();
    await client.close();
  }
});

test('permission-gated manager cannot grant permissions not held and Zod rejects operator objects', async () => {
  const repository = new MemoryRepository();
  const shop = repository.addShop();
  const manager = repository.addUser(shop, {
    username: 'manager',
    email: 'manager@example.test',
    role: 'manager',
    permissions: ['manage_users', 'customers'],
  });
  const { app, client } = await makeApp(repository);
  try {
    const body = {
      username: 'new-cashier',
      email: 'new@example.test',
      fullName: 'New Cashier',
      password: 'long-enough-password',
      role: 'cashier',
      permissions: ['reports'],
    };
    const denied = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: headers(manager),
      payload: body,
    });
    assert.equal(denied.statusCode, 403);

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: headers(manager),
      payload: { ...body, username: { $ne: null } },
    });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(malformed.json(), { error: 'VALIDATION_FAILED' });
  } finally {
    await app.close();
    await client.close();
  }
});

test('an admin cannot change their own role', async () => {
  const repository = new MemoryRepository();
  const shop = repository.addShop();
  const root = repository.addUser(shop, {
    username: 'root',
    email: 'root@example.test',
    role: 'admin',
    permissions: ['pos'],
  });
  const admin = repository.addUser(shop, {
    username: 'last-admin',
    email: 'last-admin@example.test',
    role: 'manager',
    permissions: ['pos'],
  });
  const { app, client } = await makeApp(repository);
  try {
    const selfEdit = await app.inject({
      method: 'PATCH',
      url: `/api/users/${root._id.toHexString()}`,
      headers: headers(root),
      payload: {
        username: root.username,
        email: root.email,
        fullName: root.fullName,
        role: 'manager',
        permissions: ['pos'],
        isActive: true,
      },
    });
    assert.equal(selfEdit.statusCode, 403);

    assert.equal(admin.role, 'manager');
  } finally {
    await app.close();
    await client.close();
  }
});

test('cross-shop target user is indistinguishable from a missing user', async () => {
  const repository = new MemoryRepository();
  const shop = repository.addShop('Primary');
  const otherShop = repository.addShop('Other');
  const manager = repository.addUser(shop, {
    username: 'manager',
    email: 'manager@example.test',
    role: 'admin',
    permissions: [],
  });
  const foreignUser = repository.addUser(otherShop, {
    username: 'foreign',
    email: 'foreign@example.test',
    role: 'cashier',
    permissions: ['pos'],
  });
  const { app, client } = await makeApp(repository);
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/users/${foreignUser._id.toHexString()}`,
      headers: headers(manager),
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'NOT_FOUND' });
    assert.equal(foreignUser.deletedAt, null);
  } finally {
    await app.close();
    await client.close();
  }
});

test('successful create stores only an Argon2id password hash and appends an audit event', async () => {
  const repository = new MemoryRepository();
  const shop = repository.addShop();
  const admin = repository.addUser(shop, {
    username: 'admin',
    email: 'admin@example.test',
    role: 'admin',
    permissions: [],
  });
  const { app, client } = await makeApp(repository);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: headers(admin),
      payload: {
        username: 'new-cashier',
        email: 'new@example.test',
        fullName: 'New Cashier',
        password: 'long-enough-password',
        role: 'cashier',
        permissions: ['pos'],
      },
    });
    assert.equal(response.statusCode, 201);
    const created = [...repository.users.values()].find((user) => user.username === 'new-cashier');
    assert.ok(created);
    assert.match(created.passwordHash, /^\$argon2id\$/);
    assert.equal(created.passwordHash.includes('long-enough-password'), false);
    assert.equal(repository.audits.at(-1)?.event, 'user.create');
    assert.equal(JSON.stringify(repository.audits.at(-1)).includes('password'), false);
  } finally {
    await app.close();
    await client.close();
  }
});

test('unauthenticated access and invalid ObjectId paths are denied', async () => {
  const repository = new MemoryRepository();
  repository.addShop();
  const { app, client } = await makeApp(repository);
  try {
    const noAuth = await app.inject({ method: 'GET', url: '/api/users' });
    assert.equal(noAuth.statusCode, 401);
    const invalidId = await app.inject({
      method: 'DELETE',
      url: '/api/users/not-an-object-id',
      headers: { authorization: 'Bearer malformed' },
    });

    assert.equal(invalidId.statusCode, 401);
  } finally {
    await app.close();
    await client.close();
  }
});

test('authenticated user without Manage Users permission is denied user administration', async () => {
  const repository = new MemoryRepository();
  const shop = repository.addShop();
  const cashier = repository.addUser(shop, {
    username: 'cashier',
    email: 'cashier@example.test',
    role: 'cashier',
    permissions: ['pos'],
  });
  const { app, client } = await makeApp(repository);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: headers(cashier),
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { error: 'FORBIDDEN' });
  } finally {
    await app.close();
    await client.close();
  }
});
