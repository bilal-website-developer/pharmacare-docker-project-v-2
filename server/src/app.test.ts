import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { createApp } from './app.js';

test('health endpoint returns a generic unavailable response when MongoDB cannot be reached', async () => {
  const client = new MongoClient('mongodb://127.0.0.1:1', {
    serverSelectionTimeoutMS: 100,
  });
  const app = createApp(client);

  try {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: 'unavailable' });
    assert.doesNotMatch(response.body, /127\.0\.0\.1|mongodb:\/\//);
  } finally {
    await app.close();
    await client.close();
  }
});
