import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccessToken, hashRefreshToken, verifyAccessToken } from './auth-crypto.js';

const config = {
  accessSecret: 'access-secret-that-is-long-enough-for-unit-tests',
  refreshPepper: 'refresh-pepper-that-is-long-enough-for-unit-tests',
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
};

test('access JWT verifies signatures, tenant claims, and expiration', () => {
  const now = Date.UTC(2026, 9, 14, 0, 0, 0);
  const { token, claims } = createAccessToken({
    id: '507f1f77bcf86cd799439011',
    shopId: '507f1f77bcf86cd799439012',
    role: 'cashier',
  }, config, now);
  assert.equal(verifyAccessToken(token, config.accessSecret, now)?.sub, claims.sub);
  assert.equal(verifyAccessToken(token, `${config.accessSecret}x`, now), null);
  assert.equal(verifyAccessToken(token, config.accessSecret, now + 16 * 60_000), null);
  assert.equal(verifyAccessToken(`${token}x`, config.accessSecret, now), null);
});

test('refresh token hashing is keyed, deterministic, and does not preserve the raw token', () => {
  const rawToken = 'opaque-refresh-token-value';
  const digest = hashRefreshToken(rawToken, config.refreshPepper);
  assert.equal(digest, hashRefreshToken(rawToken, config.refreshPepper));
  assert.notEqual(digest, hashRefreshToken(rawToken, `${config.refreshPepper}different`));
  assert.notEqual(digest, rawToken);
});
