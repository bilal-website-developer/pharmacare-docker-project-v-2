import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().trim().min(1).max(80).default('0.1.0'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_ORIGIN: z.string().url().optional(),
  CONTROL_PLANE_URL: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),
  LICENCE_PUBLIC_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
  SUPPORT_TOKEN_PUBLIC_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
  MONGO_HOST: z.string().min(1),
  MONGO_PORT: z.coerce.number().int().min(1).max(65535).default(27017),
  MONGO_APP_DB: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/),
  MONGO_APP_USERNAME: z.string().min(3).max(64),
  MONGO_APP_PASSWORD: strongSecret(32),
  JWT_ACCESS_SECRET: strongSecret(48),
  REFRESH_TOKEN_PEPPER: strongSecret(48),
  BOOTSTRAP_SHOP_SLUG: z.string().trim().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/).default('main'),
  SETUP_CODE_HASH: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  ),
  SETUP_CODE_EXPIRES_AT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().datetime({ offset: true }).optional(),
  ),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  appVersion: string;
  host: string;
  port: number;
  mongoUri: string;
  mongoDbName: string;
  webOrigin: string;
  controlPlaneUrl: string | null;
  licencePublicKey: string | null;
  supportTokenPublicKey: string | null;
  accessTokenSecret: string;
  refreshTokenPepper: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  bootstrapShopSlug: string;
  setupCodeHash: string | null;
  setupCodeExpiresAt: Date | null;
};

function encodeCredential(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function strongSecret(minimumLength: number) {
  return z
    .string()
    .min(minimumLength)
    .refine((value) => new Set(value).size >= 12, 'must contain sufficient character diversity')
    .refine(
      (value) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length >= 3,
      'must contain sufficient character-class diversity',
    );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const missingOrInvalid = parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .join(', ');
    throw new Error(`Invalid server configuration: ${missingOrInvalid}`);
  }

  const values = parsed.data;
  const configuredOrigin = values.WEB_ORIGIN ?? 'http://localhost:8080';
  let webOrigin: string;
  try {
    const url = new URL(configuredOrigin);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.pathname !== '/'
      || url.search
      || url.hash
      || url.username
      || url.password) {
      throw new Error('invalid origin');
    }
    webOrigin = url.origin;
  } catch {
    throw new Error('Invalid server configuration: WEB_ORIGIN');
  }
  const username = encodeCredential(values.MONGO_APP_USERNAME);
  const password = encodeCredential(values.MONGO_APP_PASSWORD);

  return {
    nodeEnv: values.NODE_ENV,
    appVersion: values.APP_VERSION,
    host: values.HOST,
    port: values.PORT,
    mongoUri: `mongodb://${username}:${password}@${values.MONGO_HOST}:${values.MONGO_PORT}/${values.MONGO_APP_DB}?authSource=${values.MONGO_APP_DB}&replicaSet=rs0`,
    mongoDbName: values.MONGO_APP_DB,
    webOrigin,
    controlPlaneUrl: values.CONTROL_PLANE_URL?.replace(/\/+$/, '') ?? null,
    licencePublicKey: values.LICENCE_PUBLIC_KEY ?? null,
    supportTokenPublicKey: values.SUPPORT_TOKEN_PUBLIC_KEY ?? null,
    accessTokenSecret: values.JWT_ACCESS_SECRET,
    refreshTokenPepper: values.REFRESH_TOKEN_PEPPER,
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
    bootstrapShopSlug: values.BOOTSTRAP_SHOP_SLUG.toLowerCase(),
    setupCodeHash: values.SETUP_CODE_HASH?.toLowerCase() ?? null,
    setupCodeExpiresAt: values.SETUP_CODE_EXPIRES_AT
      ? new Date(values.SETUP_CODE_EXPIRES_AT)
      : null,
  };
}
