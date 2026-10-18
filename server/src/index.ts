import { MongoClient } from 'mongodb';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrateLegacySuperAdminRoles } from './migrate-roles.js';
import { startControlPlaneHeartbeat } from './control-plane.js';

const config = loadConfig();
const mongoClient = new MongoClient(config.mongoUri, {
  appName: 'pharma-care-api',
  serverSelectionTimeoutMS: 5000,
});

const app = createApp(mongoClient, config);
let isShuttingDown = false;
let stopControlPlaneHeartbeat: (() => void) | undefined;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  stopControlPlaneHeartbeat?.();
  app.log.info({ signal }, 'Shutting down');

  let shutdownFailed = false;
  try {
    await app.close();
  } catch {
    app.log.error({ event: 'http_server_shutdown_failed' });
    shutdownFailed = true;
  }
  try {
    await mongoClient.close();
  } catch {
    app.log.error({ event: 'mongo_client_shutdown_failed' });
    shutdownFailed = true;
  }
  process.exitCode = shutdownFailed ? 1 : 0;
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

try {
  await mongoClient.connect();
  const migratedRoles = await migrateLegacySuperAdminRoles(mongoClient, config.mongoDbName);
  if (migratedRoles > 0) app.log.info({ migratedRoles }, 'Migrated legacy elevated shop roles to admin');
  stopControlPlaneHeartbeat = startControlPlaneHeartbeat(mongoClient, config, () => {
    app.log.error({ event: 'control_plane_licence_rejected' });
  }, () => {
    app.log.warn({ event: 'control_plane_heartbeat_failed' });
  });
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error({ event: 'server_start_failed' });
  await mongoClient.close();
  process.exitCode = 1;
}
