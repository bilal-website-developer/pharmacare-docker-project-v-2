export type LicencePlanType = 'monthly' | 'yearly' | 'one_time';
export type LicenceState = 'active' | 'renewal_notice' | 'warning' | 'inactive' | 'suspended';
export type LicenceViewerRole = 'admin' | 'manager' | 'cashier' | 'accountant';

export interface LicencePayload {
  shop_id: string;
  plan_type: LicencePlanType;
  starts_at: string;
  expires_at: string | null;
  max_pcs: number;
  offline_grace_days: number;
  warning_days: number;
  renewal_notice_days: number;
  issued_at: string;
  nonce: string;
}

export interface SignedLicence {
  payload: LicencePayload;
  signature: string;
}

export interface LicenceStateResult {
  state: LicenceState;
  effectiveNow: Date;
  clockWarning: boolean;
  offlineWarning: boolean;
  canCreateSales: boolean;
  canChangeStock: boolean;
  canPurchase: boolean;
  canView: true;
  canPrint: true;
  canViewReports: true;
  canBackup: true;
  banners: {
    renewal_notice: boolean;
    warning: boolean;
    inactive: boolean;
    offline_warning: boolean;
    clock_warning: boolean;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function payloadBytes(payload: LicencePayload): Uint8Array {
  return encoder.encode(JSON.stringify({
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
  }));
}

function decodeSignature(signature: string): Uint8Array {
  const normalized = signature.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function pemBytes(pem: string): Uint8Array {
  const normalizedPem = pem.replace(/\\n/g, '\n');
  const encoded = normalizedPem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, '');
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function validPayload(value: unknown): value is LicencePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const startsAt = Date.parse(String(payload.starts_at));
  const expiresAt = payload.expires_at === null ? null : Date.parse(String(payload.expires_at));
  return typeof payload.shop_id === 'string'
    && payload.shop_id.length > 0
    && (payload.plan_type === 'monthly' || payload.plan_type === 'yearly' || payload.plan_type === 'one_time')
    && Number.isFinite(startsAt)
    && ((payload.plan_type === 'one_time' && expiresAt === null)
      || (payload.plan_type !== 'one_time' && expiresAt !== null
        && Number.isFinite(expiresAt) && expiresAt > startsAt))
    && Number.isInteger(payload.max_pcs) && Number(payload.max_pcs) > 0
    && Number.isInteger(payload.offline_grace_days)
    && Number(payload.offline_grace_days) >= 1 && Number(payload.offline_grace_days) <= 60
    && Number.isInteger(payload.warning_days)
    && Number(payload.warning_days) >= 0 && Number(payload.warning_days) <= 30
    && Number.isInteger(payload.renewal_notice_days)
    && Number(payload.renewal_notice_days) >= 0 && Number(payload.renewal_notice_days) <= 30
    && Number.isFinite(Date.parse(String(payload.issued_at)))
    && typeof payload.nonce === 'string' && payload.nonce.length > 0;
}

export async function verifyLicence(
  licence: SignedLicence,
  publicKeyPem: string,
  expectedShopId?: string,
): Promise<boolean> {
  if (!validPayload(licence.payload) || typeof licence.signature !== 'string') return false;
  if (expectedShopId && licence.payload.shop_id !== expectedShopId) return false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'spki',
      asArrayBuffer(pemBytes(publicKeyPem)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      asArrayBuffer(decodeSignature(licence.signature)),
      asArrayBuffer(payloadBytes(licence.payload)),
    );
  } catch {
    return false;
  }
}

export function evaluateLicenceState(
  payload: LicencePayload,
  now: Date,
  lastSeenAt: Date | null,
  suspended = false,
): LicenceStateResult {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Current time must be a valid date');
  if (lastSeenAt && !Number.isFinite(lastSeenAt.getTime())) throw new TypeError('Last-seen time must be a valid date');

  const clockWarning = lastSeenAt !== null && now.getTime() < lastSeenAt.getTime() - DAY_MS;
  const effectiveNow = clockWarning && lastSeenAt ? new Date(lastSeenAt) : new Date(now);
  const offlineWarning = lastSeenAt !== null
    && effectiveNow.getTime() - lastSeenAt.getTime() > payload.offline_grace_days * DAY_MS;

  let state: LicenceState;
  if (suspended) {
    state = 'suspended';
  } else if (payload.plan_type === 'one_time') {
    state = 'active';
  } else {
    const expiresAt = payload.expires_at ? Date.parse(payload.expires_at) : Number.NaN;
    if (!Number.isFinite(expiresAt)) throw new TypeError('Expiring licence requires a valid expiry date');
    const time = effectiveNow.getTime();
    const renewalStartsAt = expiresAt - payload.renewal_notice_days * DAY_MS;
    const warningEndsAt = expiresAt + payload.warning_days * DAY_MS;
    if (time >= warningEndsAt) state = 'inactive';
    else if (time >= expiresAt) state = 'warning';
    else if (payload.renewal_notice_days > 0 && time >= renewalStartsAt) state = 'renewal_notice';
    else state = 'active';
  }

  const blocked = state === 'inactive' || state === 'suspended';
  return {
    state,
    effectiveNow,
    clockWarning,
    offlineWarning,
    canCreateSales: !blocked,
    canChangeStock: !blocked,
    canPurchase: !blocked,
    canView: true,
    canPrint: true,
    canViewReports: true,
    canBackup: true,
    banners: {
      renewal_notice: state === 'renewal_notice',
      warning: state === 'warning',
      inactive: state === 'inactive' || state === 'suspended',
      offline_warning: offlineWarning,
      clock_warning: clockWarning,
    },
  };
}

export function licenceBannerVisibleToRole(
  banner: 'renewal_notice' | 'warning' | 'inactive' | 'offline_warning' | 'clock_warning',
  role: LicenceViewerRole,
): boolean {
  if (banner === 'renewal_notice') return role === 'admin';
  if (banner === 'warning') return role === 'admin' || role === 'manager';
  return true;
}
