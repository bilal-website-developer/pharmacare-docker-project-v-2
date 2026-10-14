import type { AppConfig } from '../config.js';

export const testConfig: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  mongoUri: 'mongodb://127.0.0.1:27017/test',
  mongoDbName: 'test',
  accessTokenSecret: 'a'.repeat(64),
  refreshTokenPepper: 'b'.repeat(64),
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
  bootstrapShopSlug: 'test-shop',
};
