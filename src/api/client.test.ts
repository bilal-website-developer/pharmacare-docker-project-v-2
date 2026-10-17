import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { apiRequest, ApiError, clearApiAccessToken, setApiAccessToken } from './client';
import { getBackend } from './config';

const originalFetch = globalThis.fetch;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

test('API backend is the default when VITE_BACKEND is unset', () => {
  assert.equal(getBackend(), 'api');
});

test('retries one unauthorized API request after rotating the refresh cookie', async () => {
  const calls: Array<{ url: string; authorization: string | null; credentials: RequestCredentials | undefined }> = [];
  setApiAccessToken('expired-access-token');
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      authorization: headers.get('Authorization'),
      credentials: init?.credentials,
    });
    if (url === '/api/stock/alerts/summary?limit=10' && headers.get('Authorization') === 'Bearer expired-access-token') {
      return Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    }
    if (url === '/api/auth/refresh') {
      return Response.json({ accessToken: 'rotated-access-token' });
    }
    if (url === '/api/stock/alerts/summary?limit=10' && headers.get('Authorization') === 'Bearer rotated-access-token') {
      return Response.json({ lowCount: 2 });
    }
    return Response.json({ error: 'UNEXPECTED_REQUEST' }, { status: 500 });
  };

  const result = await apiRequest<{ lowCount: number }>('/api/stock/alerts/summary?limit=10');

  assert.equal(result.lowCount, 2);
  assert.deepEqual(calls.map(({ url }) => url), [
    '/api/stock/alerts/summary?limit=10',
    '/api/auth/refresh',
    '/api/stock/alerts/summary?limit=10',
  ]);
  assert.equal(calls[0].credentials, 'include');
  assert.equal(calls[1].credentials, 'include');
  assert.equal(calls[2].authorization, 'Bearer rotated-access-token');
});

test('adds one idempotency key to writes and preserves it across an auth retry', async () => {
  const keys: Array<string | null> = [];
  setApiAccessToken('expired-access-token');
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === '/api/suppliers') {
      keys.push(headers.get('Idempotency-Key'));
      if (headers.get('Authorization') === 'Bearer expired-access-token') {
        return Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
      }
      return Response.json({ id: 'supplier-1' }, { status: 201 });
    }
    if (url === '/api/auth/refresh') {
      return Response.json({ accessToken: 'rotated-access-token' });
    }
    return Response.json({ error: 'UNEXPECTED_REQUEST' }, { status: 500 });
  };

  const result = await apiRequest<{ id: string }>('/api/suppliers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Example supplier' }),
  });

  assert.equal(result.id, 'supplier-1');
  assert.match(keys[0] ?? '', /^[0-9a-f-]{36}$/i);
  assert.equal(keys[1], keys[0]);
});

test('uses a single refresh request for concurrent unauthorized calls', async () => {
  setApiAccessToken('expired-access-token');
  let refreshCount = 0;
  let releaseRefresh: (() => void) | undefined;
  const refreshWait = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === '/api/auth/refresh') {
      refreshCount += 1;
      await refreshWait;
      return Response.json({ accessToken: 'rotated-access-token' });
    }
    if (url.startsWith('/api/data/')) {
      if (refreshCount === 0) return Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
      return Response.json({ value: url });
    }
    return Response.json({ error: 'UNEXPECTED_REQUEST' }, { status: 500 });
  };

  const first = apiRequest<{ value: string }>('/api/data/first');
  const second = apiRequest<{ value: string }>('/api/data/second');
  await new Promise((resolve) => setImmediate(resolve));
  releaseRefresh?.();
  const results = await Promise.all([first, second]);

  assert.equal(refreshCount, 1);
  assert.deepEqual(results.map((result) => result.value), ['/api/data/first', '/api/data/second']);
});

test('normalizes API errors and does not expose server details', async () => {
  globalThis.fetch = async () => Response.json({
    error: 'FORBIDDEN',
    message: 'database collection and stack details',
  }, { status: 403 });

  await assert.rejects(
    apiRequest('/api/protected'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'FORBIDDEN');
      assert.equal(error.status, 403);
      assert.equal(error.message, 'You do not have permission to perform this action.');
      return true;
    },
  );
});

test('notifies the application shell when the API transport is unavailable', async () => {
  const events: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: (event: Event) => { events.push(event.type); return true; } },
  });
  globalThis.fetch = async () => {
    throw new TypeError('network details must not be exposed');
  };

  await assert.rejects(
    apiRequest('/api/health'),
    (error: unknown) => error instanceof ApiError
      && error.code === 'API_UNAVAILABLE'
      && error.status === 0,
  );
  assert.deepEqual(events, ['pharma-care:api-unavailable']);
});
