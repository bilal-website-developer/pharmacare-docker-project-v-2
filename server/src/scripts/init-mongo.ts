import { MongoClient, type Db, type IndexDescription } from 'mongodb';
import { z } from 'zod';

const initSchema = z.object({
  MONGO_HOST: z.string().min(1),
  MONGO_PORT: z.coerce.number().int().min(1).max(65535),
  MONGO_APP_DB: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/),
  MONGO_APP_USERNAME: z.string().min(3).max(64),
  MONGO_APP_PASSWORD: strongSecret(32),
  MONGO_ROOT_USERNAME: z.string().min(3).max(64),
  MONGO_ROOT_PASSWORD: strongSecret(32),
});

function strongSecret(minimumLength: number) {
  return z
    .string()
    .min(minimumLength)
    .refine((value) => new Set(value).size >= 12, 'must contain sufficient character diversity')
    .refine(
      (value) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length >= 3,
      'must contain sufficient character-class diversity',
    );
}

function encodeCredential(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function makeUri(
  username: string,
  password: string,
  database: string,
  directConnection: boolean,
): string {
  const host = process.env.MONGO_HOST;
  const port = process.env.MONGO_PORT;
  const direct = directConnection ? '&directConnection=true' : '&replicaSet=rs0';
  return `mongodb://${encodeCredential(username)}:${encodeCredential(password)}@${host}:${port}/${database}?authSource=admin${direct}`;
}

function log(event: string): void {
  process.stdout.write(`${JSON.stringify({ event })}\n`);
}

async function waitForPrimary(client: MongoClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const hello = await client.db('admin').command({ hello: 1 });
      if (hello.isWritablePrimary === true) {
        return;
      }
    } catch {
      // Retry until the replica set elects its initial primary.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Replica set primary did not become available');
}

async function ensureReplicaSet(client: MongoClient, hostname: string): Promise<void> {
  const admin = client.db('admin');
  const hello = await admin.command({ hello: 1 });
  if (hello.setName === 'rs0' && hello.isWritablePrimary === true) {
    return;
  }

  try {
    await admin.command({
      replSetInitiate: {
        _id: 'rs0',
        members: [{ _id: 0, host: `${hostname}:${process.env.MONGO_PORT}` }],
      },
    });
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 23
    ) {
      throw error;
    }
  }
  await waitForPrimary(client, 60_000);
}

async function ensureAppUser(
  adminClient: MongoClient,
  databaseName: string,
  username: string,
  password: string,
): Promise<void> {
  const database = adminClient.db(databaseName);
  const existing = await database.command({ usersInfo: username });
  if (Array.isArray(existing.users) && existing.users.length > 0) {
    await database.command({
      updateUser: username,
      pwd: password,
      roles: [{ role: 'readWrite', db: databaseName }],
    });
    return;
  }
  await database.command({
    createUser: username,
    pwd: password,
    roles: [{ role: 'readWrite', db: databaseName }],
  });
}

async function ensureIndexes(database: Db): Promise<void> {
  const idempotencyCollectionExists = await database
    .listCollections({ name: 'idempotencyRecords' }, { nameOnly: true })
    .hasNext();
  if (idempotencyCollectionExists) {
    const idempotencyCollection = database.collection('idempotencyRecords');
    const existingIndexes = await idempotencyCollection.listIndexes().toArray();
    if (existingIndexes.some((index) => index.name === 'shop_idempotency_unique')) {
      await idempotencyCollection.dropIndex('shop_idempotency_unique');
    }
  }

  const indexes: Record<string, IndexDescription[]> = {
    shops: [
      { key: { slug: 1 }, unique: true, name: 'shop_slug_unique' },
    ],
    users: [
      { key: { shopId: 1, usernameNormalized: 1 }, unique: true, name: 'shop_username_unique' },
      { key: { shopId: 1, emailNormalized: 1 }, unique: true, name: 'shop_email_unique' },
      { key: { shopId: 1, role: 1, isActive: 1 }, name: 'shop_role_active' },
    ],
    authRateLimits: [
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'auth_rate_limit_expiry_ttl' },
    ],
    refreshSessions: [
      { key: { tokenHash: 1 }, unique: true, name: 'refresh_token_hash_unique' },
      { key: { shopId: 1, userId: 1, revokedAt: 1, expiresAt: 1 }, name: 'refresh_user_state' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'refresh_expiry_ttl' },
    ],
    counters: [
      { key: { shopId: 1, kind: 1 }, unique: true, name: 'shop_counter_kind_unique' },
    ],
    categories: [
      { key: { shopId: 1, normalizedName: 1 }, unique: true, name: 'shop_category_name_unique' },
      { key: { shopId: 1, isActive: 1, normalizedName: 1 }, name: 'shop_category_active_name' },
    ],
    brands: [
      { key: { shopId: 1, normalizedName: 1 }, unique: true, name: 'shop_brand_name_unique' },
      { key: { shopId: 1, isActive: 1, normalizedName: 1 }, name: 'shop_brand_active_name' },
    ],
    suppliers: [
      { key: { shopId: 1, normalizedName: 1 }, unique: true, name: 'shop_supplier_name_unique' },
      { key: { shopId: 1, isActive: 1, normalizedName: 1 }, name: 'shop_supplier_active_name' },
    ],
    medicines: [
      { key: { shopId: 1, normalizedCode: 1 }, unique: true, name: 'shop_medicine_code_unique' },
      { key: { shopId: 1, normalizedName: 1 }, unique: true, name: 'shop_medicine_name_unique' },
      { key: { shopId: 1, isActive: 1, normalizedName: 1 }, name: 'shop_medicine_active_name' },
      { key: { shopId: 1, categoryId: 1, isActive: 1 }, name: 'shop_medicine_category' },
      { key: { shopId: 1, brandId: 1, isActive: 1 }, name: 'shop_medicine_brand' },
      { key: { shopId: 1, drugClass: 1, isActive: 1 }, name: 'shop_medicine_class' },
    ],
    medicineUnits: [
      { key: { shopId: 1, medicineId: 1, normalizedName: 1 }, unique: true, name: 'shop_medicine_unit_name_unique' },
      { key: { shopId: 1, medicineId: 1, isDefaultSaleUnit: 1 }, name: 'shop_medicine_unit_default' },
    ],
    barcodeClaims: [
      { key: { shopId: 1, normalizedBarcode: 1 }, unique: true, name: 'shop_barcode_unique' },
      {
        key: { shopId: 1, ownerType: 1, ownerId: 1, unitId: 1 },
        unique: true,
        name: 'shop_barcode_owner_unique',
      },
    ],
    stockBatches: [
      {
        key: { shopId: 1, medicineId: 1, status: 1, expiryDate: 1, receivedDate: 1, _id: 1 },
        name: 'shop_batch_fefo',
      },
      { key: { shopId: 1, status: 1, expiryDate: 1 }, name: 'shop_batch_expiry' },
      { key: { shopId: 1, purchaseId: 1 }, name: 'shop_batch_purchase' },
    ],
    stockMovements: [
      { key: { shopId: 1, batchId: 1, createdAt: -1, _id: -1 }, name: 'shop_batch_movements' },
      { key: { shopId: 1, referenceType: 1, referenceId: 1 }, name: 'shop_movement_reference' },
    ],
    purchases: [
      { key: { shopId: 1, purchaseNumber: 1 }, unique: true, name: 'shop_purchase_number_unique' },
      { key: { shopId: 1, purchaseDate: -1, _id: -1 }, name: 'shop_purchase_date' },
      { key: { shopId: 1, supplierId: 1, purchaseDate: -1 }, name: 'shop_purchase_supplier_date' },
    ],
    supplierLedger: [
      { key: { shopId: 1, supplierId: 1, createdAt: -1, _id: -1 }, name: 'shop_supplier_ledger' },
      {
        key: { shopId: 1, referenceType: 1, referenceId: 1 },
        unique: true,
        name: 'shop_supplier_ledger_reference_unique',
      },
    ],
    sales: [
      { key: { shopId: 1, invoiceNumber: 1 }, unique: true, name: 'shop_invoice_number_unique' },
      { key: { shopId: 1, soldAt: -1, _id: -1 }, name: 'shop_sale_date' },
      { key: { shopId: 1, customerId: 1, soldAt: -1 }, name: 'shop_customer_sales' },
    ],
    saleReturns: [
      { key: { shopId: 1, returnNumber: 1 }, unique: true, name: 'shop_return_number_unique' },
      { key: { shopId: 1, saleId: 1, status: 1, requestedAt: -1 }, name: 'shop_sale_returns' },
      { key: { shopId: 1, status: 1, requestedAt: -1 }, name: 'shop_pending_returns' },
    ],
    customers: [
      { key: { shopId: 1, normalizedName: 1 }, name: 'shop_customer_name' },
      { key: { shopId: 1, phone: 1 }, name: 'shop_customer_phone' },
    ],
    customerLedger: [
      { key: { shopId: 1, customerId: 1, createdAt: -1, _id: -1 }, name: 'shop_customer_ledger' },
      {
        key: { shopId: 1, referenceType: 1, referenceId: 1, entryType: 1 },
        unique: true,
        name: 'shop_customer_ledger_reference_unique',
      },
    ],
    expenses: [
      { key: { shopId: 1, occurredAt: -1, _id: -1 }, name: 'shop_expense_date' },
    ],
    cashBookEntries: [
      { key: { shopId: 1, createdAt: -1, _id: -1 }, name: 'shop_cash_book_date' },
      {
        key: { shopId: 1, referenceType: 1, referenceId: 1, entryType: 1 },
        unique: true,
        name: 'shop_cash_book_reference_unique',
      },
    ],
    returnPolicySettings: [
      { key: { shopId: 1 }, unique: true, name: 'shop_return_policy_unique' },
    ],
    printRequests: [
      { key: { shopId: 1, status: 1, createdAt: -1 }, name: 'shop_print_status' },
      { key: { shopId: 1, requesterId: 1, createdAt: -1 }, name: 'shop_print_requester' },
    ],
    auditLogs: [
      { key: { shopId: 1, occurredAt: -1, _id: -1 }, name: 'shop_audit_date' },
      { key: { shopId: 1, actorId: 1, occurredAt: -1 }, name: 'shop_audit_actor' },
      { key: { shopId: 1, entityType: 1, entityId: 1, occurredAt: -1 }, name: 'shop_audit_entity' },
    ],
    trashEvents: [
      { key: { shopId: 1, occurredAt: -1, _id: -1 }, name: 'shop_trash_date' },
      { key: { shopId: 1, actorId: 1, occurredAt: -1 }, name: 'shop_trash_actor' },
      { key: { shopId: 1, entityType: 1, entityId: 1, occurredAt: -1 }, name: 'shop_trash_entity' },
    ],
    idempotencyRecords: [
      {
        key: { shopId: 1, route: 1, keyHash: 1 },
        unique: true,
        name: 'shop_route_idempotency_unique',
      },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'idempotency_expiry_ttl' },
    ],
  };

  for (const [collectionName, descriptions] of Object.entries(indexes)) {
    await database.collection(collectionName).createIndexes(descriptions);
  }
}

async function main(): Promise<void> {
  const parsed = initSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid Mongo initialization configuration: ${fields}`);
  }
  const config = parsed.data;
  const rootUri = makeUri(
    config.MONGO_ROOT_USERNAME,
    config.MONGO_ROOT_PASSWORD,
    'admin',
    true,
  );
  const adminClient = new MongoClient(rootUri, {
    appName: 'pharma-care-mongo-init',
    serverSelectionTimeoutMS: 10_000,
  });

  try {
    await adminClient.connect();
    await ensureReplicaSet(adminClient, config.MONGO_HOST);
    await ensureAppUser(
      adminClient,
      config.MONGO_APP_DB,
      config.MONGO_APP_USERNAME,
      config.MONGO_APP_PASSWORD,
    );
    log('replica_set_and_app_user_ready');
  } finally {
    await adminClient.close();
  }

  const appUri = makeUri(
    config.MONGO_APP_USERNAME,
    config.MONGO_APP_PASSWORD,
    config.MONGO_APP_DB,
    false,
  );
  const appClient = new MongoClient(appUri, {
    appName: 'pharma-care-index-init',
    serverSelectionTimeoutMS: 10_000,
  });
  try {
    await appClient.connect();
    await ensureIndexes(appClient.db(config.MONGO_APP_DB));
    log('application_indexes_ready');
  } finally {
    await appClient.close();
  }
}

try {
  await main();
} catch (error) {
  const reason = error instanceof Error ? error.name : 'unknown_error';
  process.stderr.write(`${JSON.stringify({ event: 'mongo_init_failed', reason })}\n`);
  process.exitCode = 1;
}
