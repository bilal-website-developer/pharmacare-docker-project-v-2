import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { hashPassword } from './auth-crypto.js';
import { createApp } from './app.js';
import { MemoryRepository } from './test-support/memory-repository.js';
import { MemoryIdempotencyStore } from './test-support/memory-idempotency-store.js';
import { testConfig } from './test-support/test-config.js';

const PASSWORD = 'correct-horse-battery-staple';

async function setup() {
  const repository = new MemoryRepository();
  const shop = repository.addShop();
  shop.slug = 'test-shop';
  const user = repository.addUser(shop, {
    username: 'cashier',
    email: 'cashier@example.test',
    role: 'cashier',
    permissions: ['pos', 'customers'],
    passwordHash: await hashPassword(PASSWORD),
  });
  const client = new MongoClient('mongodb://127.0.0.1:1');
  const app = createApp(
    client, testConfig, repository, undefined, undefined, new MemoryIdempotencyStore(),
  );
  await app.ready();
  return { app, client, repository, shop, user };
}

function tokenFromCookie(setCookie: string | string[] | undefined): string {
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(cookie);
  const match = cookie.match(/pharma_refresh=([^;]+)/);
  assert.ok(match);
  return match[1];
}

test('login succeeds with argon2id and issues short access JWT plus secure HttpOnly refresh cookie', async () => {
  const { app, client, repository, user } = await setup();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { shopSlug: 'test-shop', usernameOrEmail: 'cashier', password: PASSWORD },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().user.id, user._id.toHexString());
    assert.equal(response.json().expiresInSeconds, 900);
    assert.equal('refreshToken' in response.json(), false);
    const cookie = response.headers['set-cookie'];
    assert.match(Array.isArray(cookie) ? cookie[0] : cookie ?? '', /HttpOnly/i);
    assert.match(Array.isArray(cookie) ? cookie[0] : cookie ?? '', /Secure/i);
    assert.match(Array.isArray(cookie) ? cookie[0] : cookie ?? '', /SameSite=Strict/i);
    assert.equal(repository.sessions.size, 1);
    assert.ok([...repository.sessions.values()][0].tokenHash);
    assert.equal([...repository.sessions.values()][0].tokenHash.includes(tokenFromCookie(cookie)), false);

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${response.json().accessToken}` },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.id, user._id.toHexString());
    assert.equal(JSON.stringify(me.json()).includes('passwordHash'), false);
  } finally {
    await app.close();
    await client.close();
  }
});

test('login failures use a generic response and lock out after five failed passwords', async () => {
  const { app, client, repository, user } = await setup();
  try {
    let lastResponse;
    for (let index = 0; index < 5; index += 1) {
      lastResponse = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { shopSlug: 'test-shop', usernameOrEmail: 'cashier', password: 'wrong-password' },
      });
      assert.equal(lastResponse.statusCode, 401);
      assert.deepEqual(lastResponse.json(), { error: 'INVALID_CREDENTIALS' });
    }
    assert.equal(user.failedLogins, 5);
    assert.ok(user.lockedUntil && user.lockedUntil.getTime() > Date.now());

    const lockedCorrectPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { shopSlug: 'test-shop', usernameOrEmail: 'cashier', password: PASSWORD },
    });
    assert.equal(lockedCorrectPassword.statusCode, 401);
    assert.deepEqual(lockedCorrectPassword.json(), lastResponse?.json());
    assert.equal(repository.audits.filter((entry) => entry.event === 'auth.login.failure').length, 6);
  } finally {
    await app.close();
    await client.close();
  }
});

test('unknown user and incorrect password have identical public failure responses', async () => {
  const { app, client } = await setup();
  try {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { shopSlug: 'test-shop', usernameOrEmail: 'cashier', password: 'wrong-password' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { shopSlug: 'test-shop', usernameOrEmail: 'unknown-user', password: 'wrong-password' },
    });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownUser.statusCode, 401);
    assert.deepEqual(unknownUser.json(), wrongPassword.json());
  } finally {
    await app.close();
    await client.close();
  }
});

test('refresh rotates the cookie and reuse of the old token revokes its full family', async () => {
  const { app, client, repository } = await setup();
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { shopSlug: 'test-shop', usernameOrEmail: 'cashier', password: PASSWORD },
    });
    const oldToken = tokenFromCookie(login.headers['set-cookie']);
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: `pharma_refresh=${oldToken}` },
    });
    assert.equal(refreshed.statusCode, 200);
    const newToken = tokenFromCookie(refreshed.headers['set-cookie']);
    assert.notEqual(newToken, oldToken);
    const oldSession = [...repository.sessions.values()].find((session) =>
      session.rotatedAt !== undefined,
    );
    assert.ok(oldSession);

    const reused = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: `pharma_refresh=${oldToken}` },
    });
    assert.equal(reused.statusCode, 401);
    assert.ok([...repository.sessions.values()].every((session) => session.revokedAt !== undefined));
    const newTokenAfterReuse = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: `pharma_refresh=${newToken}` },
    });
    assert.equal(newTokenAfterReuse.statusCode, 401);
    assert.ok(repository.audits.some((entry) => entry.event === 'auth.refresh.reuse_detected'));
  } finally {
    await app.close();
    await client.close();
  }
});

test('logout revokes the refresh family and clears the secure cookie', async () => {
  const { app, client, repository } = await setup();
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { shopSlug: 'test-shop', usernameOrEmail: 'cashier', password: PASSWORD },
    });
    const token = tokenFromCookie(login.headers['set-cookie']);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        authorization: `Bearer ${login.json().accessToken}`,
        'idempotency-key': randomUUID(),
        cookie: `pharma_refresh=${token}`,
      },
    });
    assert.equal(logout.statusCode, 200);
    assert.ok([...repository.sessions.values()].every((session) => session.revokedAt !== undefined));
    assert.match(Array.isArray(logout.headers['set-cookie'])
      ? logout.headers['set-cookie'][0]
      : logout.headers['set-cookie'] ?? '', /Max-Age=0/i);
    assert.ok(repository.audits.some((entry) => entry.event === 'auth.logout'));
  } finally {
    await app.close();
    await client.close();
  }
});

test('NoSQL operator objects in username or password are rejected by the login schema', async () => {
  const { app, client, repository } = await setup();
  try {
    for (const payload of [
      { shopSlug: 'test-shop', usernameOrEmail: { $ne: null }, password: PASSWORD },
      { shopSlug: 'test-shop', usernameOrEmail: 'cashier', password: { $ne: null } },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: 'VALIDATION_FAILED' });
    }
    assert.equal(repository.sessions.size, 0);
  } finally {
    await app.close();
    await client.close();
  }
});

test('cross-shop user identity is rejected even when the access token is validly signed', async () => {
  const { app, client, repository, user } = await setup();
  try {
    const otherShop = repository.addShop('Other Shop');
    const { createAccessToken } = await import('./auth-crypto.js');
    const access = createAccessToken({
      id: user._id.toHexString(),
      shopId: otherShop._id.toHexString(),
      role: user.role,
    }, {
      accessSecret: testConfig.accessTokenSecret,
      refreshPepper: testConfig.refreshTokenPepper,
      accessTokenTtlSeconds: testConfig.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: testConfig.refreshTokenTtlSeconds,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${access.token}` },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    await client.close();
  }
});
