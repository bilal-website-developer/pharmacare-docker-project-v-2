import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, clearApiAccessToken } from '../api';
import { completeFirstRunSetup, loadSetupStatus } from './setup';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('validates the public first-run setup status DTO', async () => {
  globalThis.fetch = async () => Response.json({ needsSetup: true });
  assert.deepEqual(await loadSetupStatus(), { needsSetup: true });

  globalThis.fetch = async () => Response.json({ needsSetup: true, shopId: 'not-allowed' });
  await assert.rejects(loadSetupStatus(), /invalid response/);
});

test('posts setup details and accepts only the created acknowledgement', async () => {
  const calls: Array<{ url: string; body: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return Response.json({ created: true }, { status: 201 });
  };
  const setupCode = 'random-one-time-setup-code-value-0123456789';
  await completeFirstRunSetup({
    setupCode,
    shopName: 'Example Pharmacy',
    phone: '',
    address: '',
    timeZone: 'Asia/Karachi',
    username: 'owner',
    email: 'owner@example.test',
    fullName: 'Example Owner',
    password: 'Strong-Setup-Password-47!',
  });
  assert.equal(calls[0].url, '/api/setup');
  assert.equal(JSON.parse(calls[0].body ?? '{}').setupCode, setupCode);

  globalThis.fetch = async () => Response.json({ error: 'SETUP_ALREADY_COMPLETED' }, { status: 409 });
  await assert.rejects(
    completeFirstRunSetup({
      setupCode,
      shopName: 'Example Pharmacy',
      phone: '',
      address: '',
      timeZone: 'Asia/Karachi',
      username: 'owner',
      email: 'owner@example.test',
      fullName: 'Example Owner',
      password: 'Strong-Setup-Password-47!',
    }),
    (error: unknown) => error instanceof ApiError
      && error.code === 'SETUP_ALREADY_COMPLETED'
      && error.message === 'Initial setup has already been completed.',
  );
});
