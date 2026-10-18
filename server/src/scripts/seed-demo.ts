import { MongoClient, ObjectId } from 'mongodb';
import { loadConfig } from '../config.js';
import { assertDemoSeedAllowed, seedDemoData } from '../demo-seed.js';

async function main(): Promise<void> {
  assertDemoSeedAllowed(process.env);
  const config = loadConfig();
  const client = new MongoClient(config.mongoUri, {
    appName: 'pharma-care-demo-seed',
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const database = client.db(config.mongoDbName);
    const shop = await database.collection('shops').findOne({
      slug: config.bootstrapShopSlug,
      status: 'ACTIVE',
    }, { projection: { _id: 1 } });
    if (!shop) throw new Error('DEMO_SEED_SHOP_NOT_FOUND');
    const actor = await database.collection('users').findOne({
      shopId: shop._id,
      role: 'admin',
      isActive: true,
      deletedAt: null,
    }, { projection: { _id: 1 } });
    if (!actor) throw new Error('DEMO_SEED_ADMIN_REQUIRED');

    const result = await seedDemoData(
      client,
      database,
      shop._id as ObjectId,
      actor._id as ObjectId,
    );
    process.stdout.write(`${JSON.stringify({
      event: result.seeded ? 'demo_seed_completed' : 'demo_seed_already_present',
      ...result,
    })}\n`);
  } finally {
    await client.close();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const reason = message.startsWith('DEMO_') ? message : error instanceof Error ? error.name : 'unknown_error';
  process.stderr.write(`${JSON.stringify({ event: 'demo_seed_failed', reason })}\n`);
  process.exitCode = 1;
}
