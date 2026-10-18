import { readFile } from 'node:fs/promises';
import { MongoClient, ObjectId } from 'mongodb';
import { loadConfig } from '../config.js';
import { importStarterCatalog, parseStarterCatalog } from '../starter-catalog.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const catalogText = await readFile(new URL('../../data/starter-catalog.json', import.meta.url), 'utf8');
  let catalogValue: unknown;
  try {
    catalogValue = JSON.parse(catalogText);
  } catch {
    throw new Error('STARTER_CATALOG_FILE_INVALID');
  }
  const entries = parseStarterCatalog(catalogValue);
  const client = new MongoClient(config.mongoUri, {
    appName: 'pharma-care-starter-catalog-seed',
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const database = client.db(config.mongoDbName);
    const shop = await database.collection('shops').findOne({
      slug: config.bootstrapShopSlug,
      status: 'ACTIVE',
    }, { projection: { _id: 1 } });
    if (!shop) throw new Error('STARTER_CATALOG_SHOP_NOT_FOUND');
    const actor = await database.collection('users').findOne({
      shopId: shop._id,
      role: 'admin',
      isActive: true,
      deletedAt: null,
    }, { projection: { _id: 1 } });
    if (!actor) throw new Error('STARTER_CATALOG_ADMIN_REQUIRED');

    const result = await importStarterCatalog(
      client,
      config.mongoDbName,
      shop._id as ObjectId,
      actor._id as ObjectId,
      entries,
    );
    process.stdout.write(`${JSON.stringify({ event: 'starter_catalog_imported', ...result })}\n`);
  } finally {
    await client.close();
  }
}

try {
  await main();
} catch (error) {
  const reason = error instanceof Error && error.message.startsWith('STARTER_CATALOG_')
    ? error.message
    : error instanceof Error
      ? error.name
      : 'unknown_error';
  process.stderr.write(`${JSON.stringify({ event: 'starter_catalog_import_failed', reason })}\n`);
  process.exitCode = 1;
}
