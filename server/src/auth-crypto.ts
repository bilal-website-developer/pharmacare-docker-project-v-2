import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import type { Role, PermissionKey } from './permissions.js';

const issuer = 'pharma-care-api';
const audience = 'pharma-care-web';
const claimsSchema = z.object({
  iss: z.literal(issuer),
  aud: z.literal(audience),
  sub: z.string().regex(/^[a-f\d]{24}$/i),
  shopId: z.string().regex(/^[a-f\d]{24}$/i),
  role: z.enum(['cashier', 'manager', 'accountant', 'admin', 'super_admin']),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(16),
}).strict();

export interface AccessClaims {
  sub: string;
  shopId: string;
  role: Role;
  iat: number;
  exp: number;
}

export interface TokenConfig {
  accessSecret: string;
  refreshPepper: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(value: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(value).digest();
}

export function createAccessToken(
  user: { id: string; shopId: string; role: Role },
  config: TokenConfig,
  now = Date.now(),
): { token: string; claims: AccessClaims } {
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    iss: issuer,
    aud: audience,
    sub: user.id,
    shopId: user.shopId,
    role: user.role,
    iat: issuedAt,
    exp: issuedAt + config.accessTokenTtlSeconds,
    jti: randomBytes(16).toString('base64url'),
  };
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  return {
    token: `${signingInput}.${sign(signingInput, config.accessSecret).toString('base64url')}`,
    claims: {
      sub: claims.sub,
      shopId: claims.shopId,
      role: claims.role,
      iat: claims.iat,
      exp: claims.exp,
    },
  };
}

export function verifyAccessToken(token: string, secret: string, now = Date.now()): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return null;

  let header: unknown;
  let payload: unknown;
  let providedSignature: Buffer;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    providedSignature = Buffer.from(signaturePart, 'base64url');
  } catch {
    return null;
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    !('alg' in header) ||
    header.alg !== 'HS256' ||
    !('typ' in header) ||
    header.typ !== 'JWT'
  ) return null;

  const expectedSignature = sign(`${headerPart}.${payloadPart}`, secret);
  if (providedSignature.length !== expectedSignature.length
    || !timingSafeEqual(providedSignature, expectedSignature)) return null;

  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success || parsed.data.exp <= Math.floor(now / 1000)
    || parsed.data.iat > Math.floor(now / 1000) + 30
    || parsed.data.exp - parsed.data.iat > 15 * 60) return null;
  return parsed.data;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

export function newRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

export function userDto(user: {
  id: string;
  shopId: string;
  username: string;
  email: string;
  fullName: string;
  role: Role;
  permissions: readonly PermissionKey[];
  isActive: boolean;
}) {
  return {
    id: user.id,
    shopId: user.shopId,
    username: user.username,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    isActive: user.isActive,
    permissions: [...user.permissions],
  };
}
