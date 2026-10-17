import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import { loadTrashBinEvents, restoreTrashBinEvent } from './trashBin';

const originalFetch = globalThis.fetch;
const eventId = '507f1f77bcf86cd799439011';
const entityId = '507f1f77bcf86cd799439012';
const actorId = '507f1f77bcf86cd799439013';

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('loads strict paginated Trash Bin events and maps server fields to the UI model', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const page = url.includes('page=2') ? 2 : 1;
    return Response.json({
      items: [{
        id: page === 1 ? eventId : '507f1f77bcf86cd799439014',
        entityId,
        entityType: page === 1 ? 'medicine' : 'profile',
        action: 'deleted',
        displayName: 'Example medicine',
        actorId,
        actorName: 'Manager User',
        role: page === 1 ? 'admin' : 'cashier',
        occurredAt: '2026-10-17T12:00:00.000Z',
        reason: null,
        canRestore: true,
      }],
      page,
      pageSize: 1,
      total: 2,
    });
  };

  const events = await loadTrashBinEvents();
  assert.equal(urls.length, 2);
  assert.equal(events[0]?.id, eventId);
  assert.equal(events[0]?.entity_id, entityId);
  assert.equal(events[0]?.actor_name, 'Manager User');
  assert.equal(events[1]?.entity_role, 'cashier');
});

test('rejects unexpected Trash Bin response fields', async () => {
  globalThis.fetch = async () => Response.json({
    items: [],
    page: 1,
    pageSize: 200,
    total: 0,
    rawDocument: {},
  });
  await assert.rejects(loadTrashBinEvents(), /invalid response/i);
});

test('restores API Trash Bin entities through their authorized endpoints', async () => {
  let request: { url: string; method: string } | null = null;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), method: init?.method ?? 'GET' };
    return Response.json({ id: entityId, name: 'Example medicine' });
  };
  await restoreTrashBinEvent({
    id: eventId,
    actor_id: actorId,
    actor_name: 'Manager User',
    entity_type: 'medicine',
    entity_id: entityId,
    entity_role: null,
    action: 'deleted',
    display_name: 'Example medicine',
    reason: null,
    created_at: '2026-10-17T12:00:00.000Z',
    can_restore: true,
  });
  assert.deepEqual(request, { url: `/api/medicines/${entityId}/restore`, method: 'POST' });
});

test('reactivates deactivated products with a whitelisted API patch', async () => {
  let request: { url: string; method: string; body: string } | null = null;
  globalThis.fetch = async (input, init) => {
    request = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    };
    return Response.json({ id: entityId, name: 'Example medicine', isActive: true });
  };
  await restoreTrashBinEvent({
    id: eventId,
    actor_id: actorId,
    actor_name: 'Manager User',
    entity_type: 'medicine',
    entity_id: entityId,
    entity_role: null,
    action: 'deactivated',
    display_name: 'Example medicine',
    reason: null,
    created_at: '2026-10-17T12:00:00.000Z',
    can_restore: true,
  });
  assert.deepEqual(request, {
    url: `/api/medicines/${entityId}`,
    method: 'PATCH',
    body: JSON.stringify({ isActive: true }),
  });
});
