import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MONGO_HOST: z.string().min(1),
  MONGO_PORT: z.coerce.number().int().min(1).max(65535).default(27017),
  MONGO_APP_DB: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/),
  MONGO_APP_USERNAME: z.string().min(3).max(64),
  MONGO_APP_PASSWORD: strongSecret(32),
  JWT_ACCESS_SECRET: strongSecret(48),
  REFRESH_TOKEN_PEPPER: strongSecret(48),
  BOOTSTRAP_SHOP_SLUG: z.string().trim().min(1).max(63).regex(/^[a-zA-Z0-9-]+$/).default('main'),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  mongoUri: string;
  mongoDbName: string;
  accessTokenSecret: string;
  refreshTokenPepper: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  bootstrapShopSlug: string;
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
  const username = encodeCredential(values.MONGO_APP_USERNAME);
  const password = encodeCredential(values.MONGO_APP_PASSWORD);

  return {
    nodeEnv: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    mongoUri: `mongodb://${username}:${password}@${values.MONGO_HOST}:${values.MONGO_PORT}/${values.MONGO_APP_DB}?authSource=${values.MONGO_APP_DB}&replicaSet=rs0`,
    mongoDbName: values.MONGO_APP_DB,
    accessTokenSecret: values.JWT_ACCESS_SECRET,
    refreshTokenPepper: values.REFRESH_TOKEN_PEPPER,
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
    bootstrapShopSlug: values.BOOTSTRAP_SHOP_SLUG.toLowerCase(),
  };
}
