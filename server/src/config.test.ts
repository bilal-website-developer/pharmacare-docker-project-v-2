import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.js';

const validEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  MONGO_HOST: 'mongo',
  MONGO_PORT: '27017',
  MONGO_APP_DB: 'pharmacare',
  MONGO_APP_USERNAME: 'pharmacare_api',
  MONGO_APP_PASSWORD: 'Abcdef0123456789-_'.repeat(3),
  JWT_ACCESS_SECRET: 'Abcdef0123456789-_'.repeat(4),
  REFRESH_TOKEN_PEPPER: 'Qwerty9876543210-_'.repeat(4),
};

test('loads valid configuration and safely encodes MongoDB credentials', () => {
  const config = loadConfig({
    ...validEnv,
    MONGO_APP_USERNAME: 'api user',
    MONGO_APP_PASSWORD: 'p@ssword-Longer-0123456789-QWERTYuiop',
  });

  assert.equal(config.mongoDbName, 'pharmacare');
  assert.match(config.mongoUri, /api%20user:p%40ssword/);
  assert.equal(config.port, 3001);
});

test('refuses missing or weak secrets without echoing values', () => {
  assert.throws(
    () => loadConfig({ ...validEnv, JWT_ACCESS_SECRET: 'x'.repeat(64) }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /JWT_ACCESS_SECRET/);
      assert.doesNotMatch(error.message, /x{12}/);
      return true;
    },
  );

  assert.throws(
    () => loadConfig({ ...validEnv, MONGO_APP_PASSWORD: undefined }),
    /MONGO_APP_PASSWORD/,
  );
});

test('rejects an invalid database name and invalid port', () => {
  assert.throws(
    () => loadConfig({ ...validEnv, MONGO_APP_DB: 'bad/name' }),
    /MONGO_APP_DB/,
  );
  assert.throws(
    () => loadConfig({ ...validEnv, PORT: '70000' }),
    /PORT/,
  );
});

test('normalizes a valid web origin and rejects origins with paths or credentials', () => {
  assert.equal(
    loadConfig({ ...validEnv, WEB_ORIGIN: 'https://pharma.example.test/' }).webOrigin,
    'https://pharma.example.test',
  );
  assert.throws(
    () => loadConfig({ ...validEnv, WEB_ORIGIN: 'https://pharma.example.test/app' }),
    /WEB_ORIGIN/,
  );
  assert.throws(
    () => loadConfig({ ...validEnv, WEB_ORIGIN: 'https://pharma.example.test/app?mode=one' }),
    /WEB_ORIGIN/,
  );
});

test('accepts only a SHA-256 setup-code hash and an offset-aware expiry', () => {
  const setup = loadConfig({
    ...validEnv,
    SETUP_CODE_HASH: 'a'.repeat(64),
    SETUP_CODE_EXPIRES_AT: '2030-01-01T00:00:00.000Z',
  });

  test('accepts the host updater configuration path without exposing it as a secret', () => {
    assert.equal(
      loadConfig({ ...validEnv, UPDATER_CONFIG_PATH: '/app/updates/update-config.json' }).updaterConfigPath,
      '/app/updates/update-config.json',
    );
    assert.equal(loadConfig(validEnv).updaterConfigPath, null);
  });
  assert.equal(setup.setupCodeHash, 'a'.repeat(64));
  assert.equal(setup.setupCodeExpiresAt?.toISOString(), '2030-01-01T00:00:00.000Z');
  assert.equal(loadConfig(validEnv).setupCodeHash, null);

  assert.throws(
    () => loadConfig({ ...validEnv, SETUP_CODE_HASH: 'not-a-hash' }),
    /SETUP_CODE_HASH/,
  );
  assert.throws(
    () => loadConfig({ ...validEnv, SETUP_CODE_EXPIRES_AT: 'not-a-date' }),
    /SETUP_CODE_EXPIRES_AT/,
  );
});
