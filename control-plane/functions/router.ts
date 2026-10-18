import { base64UrlRandom, sha256, signDocument, signLicence, verifyLicence } from './crypto.ts';
import type {
  ControlPlaneDependencies,
  ControlPlaneEnvironment,
  ControlPlaneStore,
  Filters,
  Row,
  SignedLicence,
  TableName,
} from './types.ts';

type FunctionName =
  | 'activate'
  | 'heartbeat'
  | 'get-licence'
  | 'get-release'
  | 'support-token'
  | 'create-shop'
  | 'extend-licence'
  | 'suspend'
  | 'change-plan'
  | 'approve-release'
  | 'withdraw-release'
  | 'support-allow'
  | 'support-end'
  | 'panel-data'
  | 'create-release';

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, x-device-key-hash',
      'access-control-allow-methods': 'POST, OPTIONS',
    },
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_REQUEST');
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new HttpError(400, 'INVALID_REQUEST');
}

function selectFields(rows: Row[], fields: readonly string[]): Row[] {
  return rows.map((row) => Object.fromEntries(
    fields.filter((field) => field in row).map((field) => [field, row[field]]),
  ));
}

function stringField(value: unknown, min = 1, max = 200): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new HttpError(400, 'INVALID_REQUEST');
  }
  return value.trim();
}

function integerField(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new HttpError(400, 'INVALID_REQUEST');
  }
  return Number(value);
}

function isoDate(value: unknown, field: string): string {
  const parsed = stringField(value, 10, 40);
  const time = Date.parse(parsed);
  if (!Number.isFinite(time)) throw new HttpError(400, `INVALID_${field.toUpperCase()}`);
  return new Date(time).toISOString();
}

function validatePlan(value: unknown): SignedLicence['payload']['plan_type'] {
  if (value !== 'monthly' && value !== 'yearly' && value !== 'one_time') {
    throw new HttpError(400, 'INVALID_PLAN_TYPE');
  }
  return value;
}

function validateLicenceFields(value: Record<string, unknown>, now: Date) {
  const planType = validatePlan(value.plan_type);
  const startsAt = value.starts_at === undefined ? now.toISOString() : isoDate(value.starts_at, 'starts_at');
  const expiresAt = value.expires_at === null || value.expires_at === undefined
    ? null
    : isoDate(value.expires_at, 'expires_at');
  if ((planType === 'one_time' && expiresAt !== null)
    || (planType !== 'one_time' && (!expiresAt || Date.parse(expiresAt) <= Date.parse(startsAt)))) {
    throw new HttpError(400, 'INVALID_EXPIRY');
  }
  return {
    plan_type: planType,
    starts_at: startsAt,
    expires_at: expiresAt,
    max_pcs: integerField(value.max_pcs, 1, 1000),
    offline_grace_days: integerField(value.offline_grace_days ?? 14, 1, 60),
    warning_days: integerField(value.warning_days ?? 7, 0, 30),
    renewal_notice_days: integerField(value.renewal_notice_days ?? 7, 0, 30),
  };
}

async function makeSignedLicence(
  shopId: string,
  fields: ReturnType<typeof validateLicenceFields>,
  environment: ControlPlaneEnvironment,
  now: Date,
): Promise<SignedLicence> {
  const payload: SignedLicence['payload'] = {
    shop_id: shopId,
    ...fields,
    issued_at: now.toISOString(),
    nonce: base64UrlRandom(globalThis.crypto.getRandomValues(new Uint8Array(24))),
  };
  return signLicence(payload, environment.LICENSE_SIGNING_PRIVATE_KEY);
}

async function recordSignedLicence(
  store: ControlPlaneStore,
  shopId: string,
  licence: SignedLicence,
  now: Date,
  existingId?: string,
): Promise<void> {
  const row = {
    shop_id: shopId,
    plan_type: licence.payload.plan_type,
    starts_at: licence.payload.starts_at,
    expires_at: licence.payload.expires_at,
    max_pcs: licence.payload.max_pcs,
    offline_grace_days: licence.payload.offline_grace_days,
    warning_days: licence.payload.warning_days,
    renewal_notice_days: licence.payload.renewal_notice_days,
    status: 'active',
    signed_payload: licence.payload,
    signature: licence.signature,
    updated_at: now.toISOString(),
  };
  if (existingId) {
    const updated = await store.update('licences', { id: existingId }, row);
    if (updated.length !== 1) throw new HttpError(404, 'LICENCE_NOT_FOUND');
  } else {
    await store.insert('licences', row);
  }
}

function authorizationToken(request: Request): string {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED');
  return token;
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const encoded = token.split('.')[1];
  if (!encoded) throw new HttpError(401, 'UNAUTHENTICATED');
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    return objectValue(JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))));
  } catch {
    throw new HttpError(401, 'UNAUTHENTICATED');
  }
}

async function authorizeDeveloper(
  request: Request,
  dependencies: ControlPlaneDependencies,
): Promise<string> {
  const token = authorizationToken(request);
  const claims = decodeJwtClaims(token);
  if (claims.aal !== 'aal2') throw new HttpError(403, 'TWO_FACTOR_REQUIRED');
  const response = await (dependencies.fetcher ?? fetch)(
    `${dependencies.environment.SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: dependencies.environment.SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) throw new HttpError(401, 'UNAUTHENTICATED');
  const user = objectValue(await response.json());
  const appMetadata = objectValue(user.app_metadata);
  if (appMetadata.control_plane_role !== 'developer' || typeof user.id !== 'string') {
    throw new HttpError(403, 'FORBIDDEN');
  }
  return user.id;
}

async function authorizeDevice(
  request: Request,
  store: ControlPlaneStore,
): Promise<Row> {
  const rawKey = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const deviceKeyHash = request.headers.get('x-device-key-hash');
  if ((!rawKey && !deviceKeyHash) || (rawKey && deviceKeyHash)) {
    throw new HttpError(401, 'DEVICE_UNAUTHORIZED');
  }
  if (deviceKeyHash && !/^[a-f0-9]{64}$/.test(deviceKeyHash)) {
    throw new HttpError(401, 'DEVICE_UNAUTHORIZED');
  }
  let keyHash: string;
  if (deviceKeyHash) keyHash = deviceKeyHash;
  else if (rawKey) keyHash = await sha256(rawKey);
  else throw new HttpError(401, 'DEVICE_UNAUTHORIZED');
  const devices = await store.select('devices', { device_key_hash: keyHash, status: 'active' });
  const device = devices[0];
  if (!device || typeof device.shop_id !== 'string' || typeof device.id !== 'string') {
    throw new HttpError(401, 'DEVICE_UNAUTHORIZED');
  }
  return device;
}

function rateIdentity(request: Request, device?: Row): string {
  const source = device?.device_key_hash
    ? `device:${String(device.device_key_hash)}`
    : `ip:${request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'}`;
  return source;
}

async function applyRateLimit(
  request: Request,
  dependencies: ControlPlaneDependencies,
  limit: number,
  windowSeconds: number,
  lockSeconds: number,
  device?: Row,
): Promise<void> {
  const keyHash = await sha256(`${dependencies.environment.RATE_LIMIT_HASH_SECRET}:${rateIdentity(request, device)}`);
  if (!await dependencies.store.consumeRateLimit(keyHash, limit, windowSeconds, lockSeconds)) {
    throw new HttpError(429, 'RATE_LIMITED');
  }
}

function audit(actor: string, action: string, shopId: string | null, now: Date, detail: Row = {}): Row {
  return { actor, action, shop_id: shopId, detail, created_at: now.toISOString() };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return objectValue(await request.json());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON');
  }
}

async function performFunction(
  name: FunctionName,
  request: Request,
  dependencies: ControlPlaneDependencies,
): Promise<unknown> {
  const { store, environment } = dependencies;
  const now = (dependencies.now ?? (() => new Date()))();
  const body = await readBody(request);

  if (name === 'activate') {
    requireExactKeys(body, ['activation_code', 'device_name']);
    await applyRateLimit(request, dependencies, 5, 3600, 3600);
    const code = stringField(body.activation_code, 12, 128);
    const nowString = now.toISOString();
    const codes = await store.update('activation_codes', {
      code_hash: await sha256(code),
      used_at: null,
      expires_at: `gt:${nowString}`,
    }, { used_at: nowString });
    const activation = codes[0];
    if (!activation || typeof activation.shop_id !== 'string') {
      throw new HttpError(403, 'ACTIVATION_CODE_INVALID_OR_EXPIRED');
    }
    const licences = await store.select('licences', { shop_id: activation.shop_id, status: 'active' });
    const current = licences.sort((left, right) =>
      String(right.updated_at).localeCompare(String(left.updated_at)))[0];
    if (!current || typeof current.signed_payload !== 'object' || typeof current.signature !== 'string') {
      throw new HttpError(409, 'LICENCE_UNAVAILABLE');
    }
    const currentLicence = {
      payload: current.signed_payload as SignedLicence['payload'],
      signature: current.signature,
    };
    if (!await verifyLicence(currentLicence, environment.LICENSE_SIGNING_PUBLIC_KEY, activation.shop_id)) {
      throw new HttpError(409, 'LICENCE_INVALID');
    }
    const activeDevices = await store.select('devices', { shop_id: activation.shop_id, status: 'active' });
    if (activeDevices.length >= currentLicence.payload.max_pcs) {
      throw new HttpError(409, 'MAX_DEVICES_REACHED');
    }
    const rawDeviceKey = base64UrlRandom(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const device = await store.insert('devices', {
      shop_id: activation.shop_id,
      device_key_hash: await sha256(rawDeviceKey),
      device_name: stringField(body.device_name, 1, 120),
      status: 'active',
      created_at: nowString,
    });
    await store.insert('audit_log', audit('device', 'device.activated', activation.shop_id, now, {
      device_id: device.id,
    }));
    return {
      device_key: rawDeviceKey,
      licence: { payload: current.signed_payload, signature: current.signature },
    };
  }

  if (name === 'heartbeat' || name === 'get-licence' || name === 'get-release'
    || name === 'support-allow' || name === 'support-end') {
    await applyRateLimit(request, dependencies, 60, 60, 900);
    const device = await authorizeDevice(request, store);
    await applyRateLimit(request, dependencies, 120, 60, 900, device);
    const shopId = String(device.shop_id);
    if (name === 'support-allow') {
      requireExactKeys(body, ['code', 'scope']);
      const code = stringField(body.code, 6, 6);
      if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'INVALID_SUPPORT_CODE');
      const scope = stringField(body.scope, 1, 20);
      if (!['diagnostics', 'read_only', 'admin_actions'].includes(scope)) {
        throw new HttpError(400, 'INVALID_SCOPE');
      }
      const admins = await store.select('shop_admins', { shop_id: shopId, status: 'active' });
      const approvedBy = admins.find((admin) => typeof admin.id === 'string');
      if (!approvedBy || typeof approvedBy.id !== 'string') throw new HttpError(409, 'SHOP_ADMIN_NOT_REGISTERED');
      const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
      const session = await store.insert('support_sessions', {
        shop_id: shopId,
        scope,
        code_hash: await sha256(code),
        token_hash: null,
        expires_at: expiresAt,
        approved_by_shop_admin: approvedBy.id,
        started_by_developer: null,
        ended_at: null,
        created_at: now.toISOString(),
      });
      await store.insert('audit_log', audit('device', 'support.allowed', shopId, now, {
        support_session_id: session.id,
        scope,
      }));
      return { session_id: session.id, expires_at: expiresAt };
    }
    if (name === 'support-end') {
      requireExactKeys(body, ['session_id']);
      const sessionId = stringField(body.session_id, 36, 36);
      const ended = await store.update('support_sessions', {
        id: sessionId,
        shop_id: shopId,
        ended_at: null,
      }, { ended_at: now.toISOString() });
      if (ended.length !== 1) throw new HttpError(404, 'SUPPORT_SESSION_NOT_FOUND');
      await store.insert('audit_log', audit('device', 'support.ended', shopId, now, {
        support_session_id: sessionId,
      }));
      return { ended: true };
    }
    if (name === 'heartbeat') {
      requireExactKeys(body, ['app_version', 'health_counts']);
      const appVersion = stringField(body.app_version, 1, 80);
      const health = objectValue(body.health_counts);
      requireExactKeys(health, ['users', 'products', 'sales', 'purchases']);
      const healthCounts = Object.fromEntries(Object.entries(health).map(([key, value]) => [
        key,
        integerField(value, 0, 10_000_000),
      ]));
      await store.update('devices', { id: String(device.id), shop_id: shopId }, {
        app_version: appVersion,
        health_counts: healthCounts,
        last_seen_at: now.toISOString(),
      });
      await store.insert('audit_log', audit('device', 'device.heartbeat', shopId, now));
      const licences = await store.select('licences', { shop_id: shopId });
      const current = licences.sort((left, right) =>
        String(right.updated_at).localeCompare(String(left.updated_at)))[0];
      if (!current) throw new HttpError(404, 'LICENCE_NOT_FOUND');
      return {
        received: true,
        licence: { status: current.status, payload: current.signed_payload, signature: current.signature },
      };
    }
    if (name === 'get-licence') {
      requireExactKeys(body, []);
      const licences = await store.select('licences', { shop_id: shopId });
      const current = licences.sort((left, right) =>
        String(right.updated_at).localeCompare(String(left.updated_at)))[0];
      if (!current) throw new HttpError(404, 'LICENCE_NOT_FOUND');
      return { payload: current.signed_payload, signature: current.signature };
    }
    if (name === 'get-release') {
      requireExactKeys(body, ['channel']);
      const channel = body.channel === 'pilot' || body.channel === 'stable'
        ? body.channel
        : (() => { throw new HttpError(400, 'INVALID_CHANNEL'); })();
      const releases = await store.select('releases', { channel, status: 'approved' });
      const release = releases.sort((left, right) =>
        String(right.created_at).localeCompare(String(left.created_at)))[0];
      if (!release) throw new HttpError(404, 'RELEASE_NOT_FOUND');
      return release;
    }
  }

  await applyRateLimit(request, dependencies, 30, 60, 900);
  const actor = await authorizeDeveloper(request, dependencies);
  await applyRateLimit(request, dependencies, 120, 60, 900);

  if (name === 'panel-data') {
    requireExactKeys(body, ['section']);
    const section = stringField(body.section, 1, 20);
    if (section === 'shops') {
      const [shops, licences, admins, devices] = await Promise.all([
        store.select('shops', {}),
        store.select('licences', {}),
        store.select('shop_admins', {}),
        store.select('devices', {}),
      ]);
      const visibleLicences = selectFields(licences, [
        'id', 'shop_id', 'plan_type', 'starts_at', 'expires_at', 'max_pcs',
        'offline_grace_days', 'warning_days', 'renewal_notice_days', 'status', 'updated_at',
      ]);
      const visibleAdmins = selectFields(admins, ['id', 'shop_id', 'email', 'full_name', 'status']);
      const visibleDevices = selectFields(devices, [
        'id', 'shop_id', 'device_name', 'app_version', 'last_seen_at', 'status', 'health_counts',
      ]);
      return {
        shops: selectFields(shops, [
          'id', 'name', 'slug', 'owner_name', 'phone', 'city', 'timezone', 'status', 'created_at',
        ]).map((shop) => ({
          ...shop,
          licences: visibleLicences.filter((licence) => licence.shop_id === shop.id),
          admins: visibleAdmins.filter((admin) => admin.shop_id === shop.id),
          devices: visibleDevices.filter((device) => device.shop_id === shop.id),
        })),
      };
    }
    if (section === 'releases') {
      return {
        releases: selectFields(await store.select('releases', {}), [
          'id', 'version', 'channel', 'bundle_path', 'sha256', 'signature', 'notes',
          'status', 'approved_at', 'created_at',
        ]),
      };
    }
    if (section === 'audit') {
      return {
        audit_log: selectFields(await store.select('audit_log', {}), [
          'id', 'actor', 'action', 'shop_id', 'created_at',
        ]),
      };
    }
    throw new HttpError(400, 'INVALID_PANEL_SECTION');
  }

  if (name === 'support-token') {
    requireExactKeys(body, ['shop_id', 'code', 'scope']);
    const shopId = stringField(body.shop_id, 36, 36);
    const code = stringField(body.code, 6, 6);
    if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'INVALID_SUPPORT_CODE');
    const scope = stringField(body.scope, 1, 20);
    if (!['diagnostics', 'read_only', 'admin_actions'].includes(scope)) {
      throw new HttpError(400, 'INVALID_SCOPE');
    }
    const sessions = await store.select('support_sessions', {
      shop_id: shopId,
      code_hash: await sha256(code),
      scope,
      ended_at: null,
    });
    const session = sessions.find((item) => Date.parse(String(item.expires_at)) > now.getTime()
      && item.approved_by_shop_admin != null && item.started_by_developer == null
      && item.token_hash == null);
    if (!session || typeof session.id !== 'string') throw new HttpError(403, 'SUPPORT_CODE_INVALID');
    const tokenPayload = {
      sub: session.id,
      shop_id: shopId,
      scope,
      issued_at: now.toISOString(),
      expires_at: String(session.expires_at),
    };
    const token = `${base64UrlRandom(new TextEncoder().encode(JSON.stringify(tokenPayload)))}.${await signDocument(tokenPayload, environment.SUPPORT_SIGNING_PRIVATE_KEY)}`;
    const claimed = await store.update('support_sessions', {
      id: session.id,
      started_by_developer: null,
      token_hash: null,
      ended_at: null,
      expires_at: `gt:${now.toISOString()}`,
    }, {
      started_by_developer: actor,
      token_hash: await sha256(token),
    });
    if (claimed.length !== 1) throw new HttpError(403, 'SUPPORT_CODE_INVALID');
    await store.insert('audit_log', audit(actor, 'support.started', shopId, now, {
      support_session_id: session.id,
      scope,
    }));
    return { token };
  }

  if (name === 'create-shop') {
    requireExactKeys(body, ['shop', 'admin', 'licence']);
    const shopInput = objectValue(body.shop);
    const adminInput = objectValue(body.admin);
    const licenceInput = objectValue(body.licence);
    requireExactKeys(shopInput, ['name', 'slug', 'owner_name', 'phone', 'city', 'timezone']);
    requireExactKeys(adminInput, ['email', 'full_name']);
    requireExactKeys(licenceInput, [
      'plan_type', 'starts_at', 'expires_at', 'max_pcs', 'offline_grace_days',
      'warning_days', 'renewal_notice_days',
    ]);
    const timezone = stringField(shopInput.timezone ?? 'Asia/Karachi', 1, 100);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new HttpError(400, 'INVALID_TIMEZONE');
    }
    const shop = {
      name: stringField(shopInput.name, 1, 160),
      slug: stringField(shopInput.slug, 2, 63).toLowerCase(),
      owner_name: stringField(shopInput.owner_name, 1, 160),
      phone: stringField(shopInput.phone, 1, 80),
      city: stringField(shopInput.city, 1, 120),
      timezone,
      status: 'active',
    };
    const email = stringField(adminInput.email, 3, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'INVALID_ADMIN_EMAIL');
    const licenceFields = validateLicenceFields(licenceInput, now);
    const rawCode = base64UrlRandom(globalThis.crypto.getRandomValues(new Uint8Array(24)));
    const insertedShop = await store.insert('shops', shop);
    if (typeof insertedShop.id !== 'string') throw new Error('Shop insert did not return an id');
    const signed = await makeSignedLicence(insertedShop.id, licenceFields, environment, now);
    await store.insert('shop_admins', {
      shop_id: insertedShop.id,
      email,
      full_name: stringField(adminInput.full_name, 1, 160),
      status: 'active',
    });
    await store.insert('activation_codes', {
      shop_id: insertedShop.id,
      code_hash: await sha256(rawCode),
      expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await recordSignedLicence(store, insertedShop.id, signed, now);
    await store.insert('audit_log', audit(actor, 'shop.created', insertedShop.id, now));
    return { shop: insertedShop, activation_code: rawCode };
  }

  if (name === 'extend-licence' || name === 'change-plan' || name === 'suspend') {
    requireExactKeys(body, name === 'suspend'
      ? ['shop_id']
      : name === 'extend-licence' ? ['shop_id', 'expires_at'] : [
        'shop_id', 'plan_type', 'starts_at', 'expires_at', 'max_pcs',
        'offline_grace_days', 'warning_days', 'renewal_notice_days',
      ]);
    const shopId = stringField(body.shop_id, 36, 36);
    const licences = await store.select('licences', { shop_id: shopId, status: 'active' });
    const current = licences.sort((left, right) =>
      String(right.updated_at).localeCompare(String(left.updated_at)))[0];
    if (!current || typeof current.id !== 'string') throw new HttpError(404, 'LICENCE_NOT_FOUND');
    if (name === 'suspend') {
      await store.update('licences', { id: current.id }, { status: 'suspended', updated_at: now.toISOString() });
      await store.update('shops', { id: shopId }, { status: 'suspended' });
      await store.insert('audit_log', audit(actor, 'licence.suspended', shopId, now));
      return { suspended: true };
    }
    const fields = name === 'extend-licence'
      ? (() => {
        if (current.plan_type === 'one_time') throw new HttpError(409, 'ONE_TIME_LICENCE_CANNOT_BE_EXTENDED');
        const expiresAt = isoDate(body.expires_at, 'expires_at');
        if (Date.parse(expiresAt) <= Date.parse(String(current.expires_at))) {
          throw new HttpError(400, 'EXPIRY_MUST_INCREASE');
        }
        return {
          plan_type: validatePlan(current.plan_type),
          starts_at: String(current.starts_at),
          expires_at: expiresAt,
          max_pcs: integerField(current.max_pcs, 1, 1000),
          offline_grace_days: integerField(current.offline_grace_days, 1, 60),
          warning_days: integerField(current.warning_days, 0, 30),
          renewal_notice_days: integerField(current.renewal_notice_days, 0, 30),
        };
      })()
      : validateLicenceFields(body, now);
    const signed = await makeSignedLicence(shopId, fields, environment, now);
    await recordSignedLicence(store, shopId, signed, now, current.id);
    await store.update('shops', { id: shopId }, { status: 'active' });
    await store.insert('audit_log', audit(actor, name === 'extend-licence' ? 'licence.extended' : 'licence.plan_changed', shopId, now));
    return { licence: signed };
  }

  if (name === 'approve-release' || name === 'withdraw-release') {
    requireExactKeys(body, name === 'approve-release' ? ['release_id', 'channel'] : ['release_id']);
    const releaseId = stringField(body.release_id, 36, 36);
    const patch = name === 'withdraw-release'
      ? { status: 'withdrawn' }
      : {
        status: 'approved',
        channel: body.channel === 'pilot' || body.channel === 'stable'
          ? body.channel
          : (() => { throw new HttpError(400, 'INVALID_CHANNEL'); })(),
        approved_at: now.toISOString(),
      };
    const updated = await store.update('releases', { id: releaseId }, patch);
    if (updated.length !== 1) throw new HttpError(404, 'RELEASE_NOT_FOUND');
    await store.insert('audit_log', audit(actor, name === 'approve-release' ? 'release.approved' : 'release.withdrawn', null, now, {
      release_id: releaseId,
    }));
    return { release: updated[0] };
  }

  if (name === 'create-release') {
    requireExactKeys(body, ['version', 'bundle_path', 'sha256', 'signature', 'notes']);
    const version = stringField(body.version, 1, 80);
    const bundlePath = stringField(body.bundle_path, 1, 1000);
    const sha256Hash = stringField(body.sha256, 64, 64);
    if (!/^[a-f0-9]{64}$/.test(sha256Hash)) throw new HttpError(400, 'INVALID_SHA256');
    const signature = stringField(body.signature, 1, 1000);
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : '';
    const release = await store.insert('releases', {
      version,
      channel: 'pilot',
      bundle_path: bundlePath,
      sha256: sha256Hash,
      signature,
      notes,
      status: 'draft',
    });
    await store.insert('audit_log', audit(actor, 'release.created', null, now, {
      release_id: release.id,
      version,
    }));
    return { release };
  }

  throw new HttpError(404, 'FUNCTION_NOT_FOUND');
}

export function createControlPlaneHandler(
  name: FunctionName,
  dependencies: ControlPlaneDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method === 'OPTIONS') return json(204, {});
    if (request.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
    try {
      const result = await performFunction(name, request, dependencies);
      return json(200, result);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.code });
      throw error;
    }
  };
}

export async function createEnvironmentStore(
  environment: ControlPlaneEnvironment,
  fetcher?: typeof fetch,
) {
  const { PostgrestControlPlaneStore } = await import('./store.ts');
  return new PostgrestControlPlaneStore(environment, fetcher);
}

export type { FunctionName };
