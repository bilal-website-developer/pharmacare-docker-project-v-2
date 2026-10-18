import type { SignedLicence } from './types.ts';

const encoder = new TextEncoder();

function pemBytes(pem: string): Uint8Array {
  const base64 = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, '');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (character) =>
    character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function canonicalPayload(payload: SignedLicence['payload']): string {
  return JSON.stringify({
    shop_id: payload.shop_id,
    plan_type: payload.plan_type,
    starts_at: payload.starts_at,
    expires_at: payload.expires_at,
    max_pcs: payload.max_pcs,
    offline_grace_days: payload.offline_grace_days,
    warning_days: payload.warning_days,
    renewal_notice_days: payload.renewal_notice_days,
    issued_at: payload.issued_at,
    nonce: payload.nonce,
  });
}

export async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signDocument(document: unknown, privateKeyPem: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    toArrayBuffer(pemBytes(privateKeyPem)),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'Ed25519' },
    key,
    encoder.encode(JSON.stringify(document)),
  );
  return base64Url(new Uint8Array(signature));
}

export async function signLicence(
  payload: SignedLicence['payload'],
  privateKeyPem: string,
): Promise<SignedLicence> {
  return { payload, signature: await signDocument(payload, privateKeyPem) };
}

export async function verifyLicence(
  licence: SignedLicence,
  publicKeyPem: string,
  expectedShopId?: string,
): Promise<boolean> {
  if (!isLicencePayload(licence.payload) || typeof licence.signature !== 'string') return false;
  if (expectedShopId && licence.payload.shop_id !== expectedShopId) return false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'spki',
      toArrayBuffer(pemBytes(publicKeyPem)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      toArrayBuffer(fromBase64Url(licence.signature)),
      encoder.encode(canonicalPayload(licence.payload)),
    );
  } catch {
    return false;
  }
}

function isLicencePayload(value: unknown): value is SignedLicence['payload'] {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.shop_id === 'string'
    && ['monthly', 'yearly', 'one_time'].includes(String(payload.plan_type))
    && typeof payload.starts_at === 'string'
    && (payload.expires_at === null || typeof payload.expires_at === 'string')
    && Number.isInteger(payload.max_pcs)
    && Number.isInteger(payload.offline_grace_days)
    && Number.isInteger(payload.warning_days)
    && Number.isInteger(payload.renewal_notice_days)
    && typeof payload.issued_at === 'string'
    && typeof payload.nonce === 'string';
}

export function base64UrlRandom(bytes: Uint8Array): string {
  return base64Url(bytes);
}
