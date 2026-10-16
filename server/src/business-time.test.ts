import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timezoneDateBounds, timezoneToday } from './business-time.js';

test('shop-local day bounds align the Karachi midnight boundary', () => {
  const bounds = timezoneDateBounds('Asia/Karachi', '2026-10-17');
  assert.equal(bounds.start.toISOString(), '2026-10-16T19:00:00.000Z');
  assert.equal(bounds.end.toISOString(), '2026-10-17T19:00:00.000Z');
});

test('timezone date bounds account for daylight-saving transitions', () => {
  const bounds = timezoneDateBounds('America/New_York', '2026-03-08');
  assert.equal(bounds.start.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(bounds.end.toISOString(), '2026-03-09T04:00:00.000Z');
});

test('timezone today and bounds reject invalid timezone or calendar dates', () => {
  assert.throws(() => timezoneToday('Unknown/Timezone'), /INVALID_SHOP_TIMEZONE/);
  assert.throws(() => timezoneDateBounds('Asia/Karachi', '2026-02-30'), /INVALID_CALENDAR_DATE/);
  assert.throws(() => timezoneDateBounds('Unknown/Timezone', '2026-10-17'));
});
