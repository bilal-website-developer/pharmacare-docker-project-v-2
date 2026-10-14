import { MongoClient } from 'mongodb';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const mongoClient = new MongoClient(config.mongoUri, {
  appName: 'pharma-care-api',
  serverSelectionTimeoutMS: 5000,
});

const app = createApp(mongoClient);
let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
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
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error({ event: 'server_start_failed' });
  await mongoClient.close();
  process.exitCode = 1;
}
