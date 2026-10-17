import assert from 'node:assert/strict';
import test from 'node:test';
import { filterTrashBinEvents, parseTrashBinEvent, TrashBinEvent } from './trashBin';

const events: TrashBinEvent[] = [
  {
    id: '1',
    actor_id: 'admin-id',
    actor_name: 'Admin',
    entity_type: 'medicine',
    entity_id: 'medicine-id',
    entity_role: null,
    action: 'deactivated',
    display_name: 'Panadol',
    reason: null,
    created_at: '2026-10-12T12:00:00Z',
    can_restore: true,
  },
  {
    id: '2',
    actor_id: null,
    actor_name: 'Unknown user',
    entity_type: 'purchase',
    entity_id: 'purchase-id',
    entity_role: null,
    action: 'voided',
    display_name: 'PR-10001',
    reason: 'Duplicate',
    created_at: '2026-10-12T11:00:00Z',
    can_restore: false,
  },
];

test('filters Trash Bin events by entity type', () => {
  assert.deepEqual(filterTrashBinEvents(events, 'all'), events);
  assert.deepEqual(filterTrashBinEvents(events, 'medicine'), [events[0]]);
  assert.deepEqual(filterTrashBinEvents(events, 'purchase'), [events[1]]);
  const catalogEvent = { ...events[0], id: '3', entity_type: 'category' as const };
  assert.deepEqual(filterTrashBinEvents([...events, catalogEvent], 'medicine'), [events[0], catalogEvent]);
});

test('parses events and applies safe display fallbacks', () => {
  assert.equal(parseTrashBinEvent({ ...events[0], actor_name: '  ', display_name: '' }).actor_name, 'Unknown user');
  assert.equal(parseTrashBinEvent({ ...events[0], actor_name: 'Admin', display_name: '' }).display_name, 'Unknown item');
  assert.throws(() => parseTrashBinEvent({ ...events[0], action: 'removed' }), /invalid fields/);
});
