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
