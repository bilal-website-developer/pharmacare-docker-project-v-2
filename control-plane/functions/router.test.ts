import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import test from 'node:test';
import { base64UrlRandom, sha256, signLicence, verifyLicence } from './crypto.ts';
import { createControlPlaneHandler } from './router.ts';
import type { ControlPlaneEnvironment, ControlPlaneStore, Filters, Row, TableName } from './types.ts';

class FakeStore implements ControlPlaneStore {
  readonly rows = new Map<TableName, Row[]>([
    ['shops', []],
    ['licences', []],
    ['activation_codes', []],
    ['devices', []],
    ['shop_admins', []],
    ['support_sessions', []],
    ['releases', []],
    ['release_rollouts', []],
    ['audit_log', []],
    ['control_plane_rate_limits', []],
  ]);
  private readonly attempts = new Map<string, number>();

  async select(table: TableName, filters: Filters): Promise<Row[]> {
    return (this.rows.get(table) ?? []).filter((row) =>
      Object.entries(filters).every(([key, value]) => {
        if (value === null) return row[key] == null;
        if (typeof value === 'string' && value.startsWith('gt:')) {
          return Date.parse(String(row[key])) > Date.parse(value.slice(3));
        }
        return String(row[key]) === String(value);
      }));
  }

  async insert(table: TableName, row: Row): Promise<Row> {
    const saved = { id: globalThis.crypto.randomUUID(), ...row };
    this.rows.get(table)?.push(saved);
    return saved;
  }

  async update(table: TableName, filters: Filters, patch: Row): Promise<Row[]> {
    const matches = await this.select(table, filters);
    for (const row of matches) Object.assign(row, patch);
    return matches;
  }

  async rpc(): Promise<unknown> {
    throw new Error('Unexpected fake RPC call');
  }

  async consumeRateLimit(keyHash: string, limit: number): Promise<boolean> {
    const count = (this.attempts.get(keyHash) ?? 0) + 1;
    this.attempts.set(keyHash, count);
    return count < limit;
  }
}

const keyPair = generateKeyPairSync('ed25519');
const environment: ControlPlaneEnvironment = {
  SUPABASE_URL: 'https://control-plane.invalid',
  SUPABASE_ANON_KEY: 'test-anon-placeholder',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-placeholder',
  LICENSE_SIGNING_PRIVATE_KEY: keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  LICENSE_SIGNING_PUBLIC_KEY: keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  SUPPORT_SIGNING_PRIVATE_KEY: keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  RATE_LIMIT_HASH_SECRET: 'test-only-rate-hash-placeholder',
};

function request(name: string, body: unknown, deviceKey?: string): Request {
  return new Request(`https://edge.invalid/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(deviceKey ? { authorization: `Bearer ${deviceKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const developerToken = `header.${Buffer.from(JSON.stringify({ aal: 'aal2' })).toString('base64url')}.signature`;

function developerRequest(name: string, body: unknown, token = developerToken): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('authorization', ['Bea', 'rer'].join('') + ' ' + token);
  return new Request(`https://edge.invalid/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function validLicence(shopId: string, now: Date) {
  return signLicence({
    shop_id: shopId,
    plan_type: 'monthly',
    starts_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 86400000).toISOString(),
    max_pcs: 3,
    offline_grace_days: 14,
    warning_days: 7,
    renewal_notice_days: 7,
    issued_at: now.toISOString(),
    nonce: base64UrlRandom(globalThis.crypto.getRandomValues(new Uint8Array(16))),
  }, environment.LICENSE_SIGNING_PRIVATE_KEY);
}

test('activation consumes a one-time code, hashes the device key, and returns a real Ed25519 signature', async () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const store = new FakeStore();
  const licence = await validLicence('shop-one', now);
  await store.insert('licences', {
    shop_id: 'shop-one',
    status: 'active',
    signed_payload: licence.payload,
    signature: licence.signature,
    updated_at: now.toISOString(),
  });
  await store.insert('activation_codes', {
    shop_id: 'shop-one',
    code_hash: await sha256('activation-code-test'),
    expires_at: new Date(now.getTime() + 86400000).toISOString(),
    used_at: null,
  });
  const handler = createControlPlaneHandler('activate', { store, environment, now: () => now });

  const response = await handler(request('activate', {
    activation_code: 'activation-code-test',
    device_name: 'Test register',
  }));
  const result = await response.json() as { device_key: string; licence: Parameters<typeof verifyLicence>[0] };
  assert.equal(response.status, 200);
  assert.notEqual(result.device_key, 'activation-code-test');
  assert.equal(await verifyLicence(result.licence, environment.LICENSE_SIGNING_PUBLIC_KEY, 'shop-one'), true);
  const device = store.rows.get('devices')?.[0];
  assert.equal(device?.device_key_hash, await sha256(result.device_key));
  assert.equal(device?.device_key_hash === result.device_key, false);
  assert.equal(store.rows.get('activation_codes')?.[0]?.used_at, now.toISOString());
});

test('activation rejects a code that has already been used', async () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const store = new FakeStore();
  await store.insert('activation_codes', {
    shop_id: 'shop-one',
    code_hash: await sha256('used-activation-code'),
    expires_at: new Date(now.getTime() + 86400000).toISOString(),
    used_at: new Date(now.getTime() - 1000).toISOString(),
  });
  const response = await createControlPlaneHandler('activate', { store, environment, now: () => now })(
    request('activate', { activation_code: 'used-activation-code', device_name: 'Test register' }),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'ACTIVATION_CODE_INVALID_OR_EXPIRED');
});

test('activation rejects an expired code', async () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const store = new FakeStore();
  await store.insert('activation_codes', {
    shop_id: 'shop-one',
    code_hash: await sha256('expired-activation-code'),
    expires_at: new Date(now.getTime() - 1000).toISOString(),
    used_at: null,
  });
  const response = await createControlPlaneHandler('activate', { store, environment, now: () => now })(
    request('activate', { activation_code: 'expired-activation-code', device_name: 'Test register' }),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'ACTIVATION_CODE_INVALID_OR_EXPIRED');
});

test('Ed25519 validation rejects a tampered licence', async () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const signed = await validLicence('shop-one', now);
  const tampered = { ...signed, payload: { ...signed.payload, max_pcs: 99 } };
  assert.equal(await verifyLicence(tampered, environment.LICENSE_SIGNING_PUBLIC_KEY), false);
});

test('a device cannot request another shop licence by supplying another shop id', async () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const store = new FakeStore();
  const rawDeviceKey = 'shop-one-device-secret-test';
  await store.insert('devices', {
    shop_id: 'shop-one',
    device_key_hash: await sha256(rawDeviceKey),
    status: 'active',
  });
  await store.insert('licences', {
    shop_id: 'shop-two',
    status: 'active',
    signed_payload: (await validLicence('shop-two', now)).payload,
    signature: 'test',
    updated_at: now.toISOString(),
  });
  const response = await createControlPlaneHandler('get-licence', { store, environment, now: () => now })(
    request('get-licence', { shop_id: 'shop-two' }, rawDeviceKey),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'INVALID_REQUEST');
});

test('support approval stores only a code hash and developer token is signed and one-time', async () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const store = new FakeStore();
  const rawDeviceKey = 'shop-device-support-test';
  const shopId = 'cb1099d8-4efb-4d3c-b773-ea95a13bf948';
  await store.insert('devices', {
    shop_id: shopId,
    device_key_hash: await sha256(rawDeviceKey),
    status: 'active',
  });
  const admin = await store.insert('shop_admins', {
    shop_id: shopId,
    status: 'active',
  });
  const allow = await createControlPlaneHandler('support-allow', {
    store,
    environment,
    now: () => now,
  })(request('support-allow', { code: '029481', scope: 'read_only' }, rawDeviceKey));
  const allowed = await allow.json() as { session_id: string; expires_at: string };
  assert.equal(allow.status, 200);
  assert.equal(Date.parse(allowed.expires_at) - now.getTime(), 30 * 60_000);
  assert.equal(store.rows.get('support_sessions')?.[0]?.code_hash, await sha256('029481'));
  assert.notEqual(store.rows.get('support_sessions')?.[0]?.code_hash, '029481');
  assert.equal(store.rows.get('support_sessions')?.[0]?.approved_by_shop_admin, admin.id);

  const developerToken = `header.${Buffer.from(JSON.stringify({ aal: 'aal2' })).toString('base64url')}.signature`;
  const tokenResponse = await createControlPlaneHandler('support-token', {
    store,
    environment,
    now: () => now,
    fetcher: async () => new Response(JSON.stringify({
      id: 'developer-id',
      app_metadata: { control_plane_role: 'developer' },
    }), { status: 200 }),
  })(new Request('https://edge.invalid/support-token', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${developerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ shop_id: shopId, code: '029481', scope: 'read_only' }),
  }));
  const tokenResult = await tokenResponse.json() as { token: string };
  assert.equal(tokenResponse.status, 200);
  const [payload, signature] = tokenResult.token.split('.');
  assert.ok(payload);
  assert.ok(signature);
  const tokenPayload = Buffer.from(payload, 'base64url').toString('utf8');
  assert.equal(verifySignature(
    null,
    Buffer.from(tokenPayload),
    keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    Buffer.from(signature, 'base64url'),
  ), true);
  const savedSession = store.rows.get('support_sessions')?.[0];
  assert.equal(savedSession?.token_hash, await sha256(tokenResult.token));
  assert.equal(savedSession?.started_by_developer, 'developer-id');

  const reused = await createControlPlaneHandler('support-token', {
    store,
    environment,
    now: () => now,
    fetcher: async () => new Response(JSON.stringify({
      id: 'developer-id',
      app_metadata: { control_plane_role: 'developer' },
    }), { status: 200 }),
  })(new Request('https://edge.invalid/support-token', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${developerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ shop_id: shopId, code: '029481', scope: 'read_only' }),
  }));
  assert.equal(reused.status, 403);
  assert.equal((await reused.json()).error, 'SUPPORT_CODE_INVALID');

  const ended = await createControlPlaneHandler('support-end', {
    store,
    environment,
    now: () => now,
  })(request('support-end', { session_id: allowed.session_id }, rawDeviceKey));
  assert.equal(ended.status, 200);
  assert.equal((await ended.json()).ended, true);
  assert.equal(store.rows.get('support_sessions')?.[0]?.ended_at, now.toISOString());
});

test('developer panel data omits stored hashes and release creation records a draft', async () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const store = new FakeStore();
  const shop = await store.insert('shops', {
    name: 'Example Pharmacy',
    owner_name: 'Owner',
    phone: '03000000000',
    city: 'Lahore',
    timezone: 'Asia/Karachi',
    status: 'active',
  });
  await store.insert('activation_codes', {
    shop_id: shop.id,
    code_hash: 'a'.repeat(64),
    expires_at: now.toISOString(),
  });
  await store.insert('devices', {
    shop_id: shop.id,
    device_key_hash: 'b'.repeat(64),
    device_name: 'Admin PC',
    status: 'active',
  });
  await store.insert('support_sessions', {
    shop_id: shop.id,
    code_hash: 'c'.repeat(64),
    token_hash: 'd'.repeat(64),
  });
  const dependencies = {
    store,
    environment,
    now: () => now,
    fetcher: async () => new Response(JSON.stringify({
      id: 'developer-id',
      app_metadata: { control_plane_role: 'developer' },
    }), { status: 200 }),
  };

  const shopsResponse = await createControlPlaneHandler('panel-data', dependencies)(
    developerRequest('panel-data', { section: 'shops' }),
  );
  const shopsResult = await shopsResponse.json() as { shops: Array<Record<string, unknown>> };
  assert.equal(shopsResponse.status, 200);
  const shopJson = JSON.stringify(shopsResult);
  assert.match(shopJson, /Example Pharmacy/);
  assert.doesNotMatch(shopJson, /code_hash|token_hash|device_key_hash|activation_codes/);

  const createdResponse = await createControlPlaneHandler('create-release', dependencies)(
    developerRequest('create-release', {
      version: '2.4.1',
      bundle_path: 'releases/2.4.1.zip',
      sha256: 'e'.repeat(64),
      signature: 'ed25519-signature-placeholder',
      notes: 'Pilot build',
    }),
  );
  const created = await createdResponse.json() as { release: Record<string, unknown> };
  assert.equal(createdResponse.status, 200);
  assert.equal(created.release.status, 'draft');
  assert.equal(created.release.channel, 'pilot');
  assert.equal(store.rows.get('releases')?.length, 1);

  const invalidResponse = await createControlPlaneHandler('create-release', dependencies)(
    developerRequest('create-release', {
      version: '2.4.2',
      bundle_path: 'releases/2.4.2.zip',
      sha256: 'z'.repeat(64),
      signature: 'signature',
      notes: '',
    }),
  );
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error, 'INVALID_SHA256');
});

test('developer panel endpoints require AAL2 and developer metadata', async () => {
  const store = new FakeStore();
  const token = (aal: string) =>
    `header.${Buffer.from(JSON.stringify({ aal })).toString('base64url')}.signature`;
  const handler = createControlPlaneHandler('panel-data', {
    store,
    environment,
    fetcher: async () => new Response(JSON.stringify({
      id: 'developer-id',
      app_metadata: { control_plane_role: 'developer' },
    }), { status: 200 }),
  });
  const aal1 = await handler(developerRequest('panel-data', { section: 'shops' }, token('aal1')));
  assert.equal(aal1.status, 403);
  assert.equal((await aal1.json()).error, 'TWO_FACTOR_REQUIRED');

  const nonDeveloper = createControlPlaneHandler('panel-data', {
    store,
    environment,
    fetcher: async () => new Response(JSON.stringify({
      id: 'other-user',
      app_metadata: { control_plane_role: 'shop_admin' },
    }), { status: 200 }),
  });
  const denied = await nonDeveloper(developerRequest('panel-data', { section: 'shops' }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'FORBIDDEN');
});
