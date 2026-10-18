import { MongoClient } from 'mongodb';

interface LegacyRoleRecord {
  _id: unknown;
  shopId: unknown;
}

export interface RoleMigrationCollections {
  users: string;
  auditLogs: string;
}

const DEFAULT_COLLECTIONS: RoleMigrationCollections = {
  users: 'users',
  auditLogs: 'auditLogs',
};

export async function migrateLegacySuperAdminRoles(
  client: MongoClient,
  databaseName: string,
  collections: RoleMigrationCollections = DEFAULT_COLLECTIONS,
): Promise<number> {
  const database = client.db(databaseName);
  const users = database.collection<LegacyRoleRecord & Record<string, unknown>>(collections.users);
  const auditLogs = database.collection(collections.auditLogs);
  const session = client.startSession();
  let migrated = 0;
  const now = new Date();

  try {
    await session.withTransaction(async () => {
      const legacyUsers = await users.find(
        { role: 'super_admin' },
        { session, projection: { _id: 1, shopId: 1 } },
      ).toArray();
      if (legacyUsers.length === 0) return;

      const update = await users.updateMany(
        { role: 'super_admin' },
        { $set: { role: 'admin', updatedAt: now } },
        { session },
      );
      if (update.modifiedCount !== legacyUsers.length) {
        throw new Error('Legacy role migration changed an unexpected number of users');
      }
      await auditLogs.insertMany(legacyUsers.map((user) => ({
        shopId: user.shopId,
        entityId: user._id,
        entityType: 'user',
        event: 'user.role_migrated_to_admin',
        before: { role: 'super_admin' },
        after: { role: 'admin' },
        occurredAt: now,
      })), { session });
      migrated = update.modifiedCount;
    });
  } finally {
    await session.endSession();
  }

  return migrated;
}
