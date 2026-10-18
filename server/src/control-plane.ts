import { MongoClient } from 'mongodb';
import type { AppConfig } from './config.js';
import { verifyLicence, type SignedLicence } from './licence.js';

interface LocalControlPlaneRecord {
  _id: 'control-plane';
  controlPlaneShopId: string;
  deviceKeyHash: string;
  licence: SignedLicence;
  lastSeenAt: Date;
  status: 'active' | 'suspended';
}

export type HeartbeatOutcome = 'updated' | 'offline' | 'licence-rejected' | 'not-configured';

export async function sendControlPlaneHeartbeat(
  client: MongoClient,
  config: AppConfig,
  fetcher: typeof fetch = fetch,
  collectionName = 'controlPlaneState',
): Promise<HeartbeatOutcome> {
  if (!config.controlPlaneUrl) return 'not-configured';
  const database = client.db(config.mongoDbName);
  const states = database.collection<LocalControlPlaneRecord>(collectionName);
  const localState = await states.findOne({ _id: 'control-plane' });
  if (!localState) return 'not-configured';

  const [users, products, sales, purchases] = await Promise.all([
    database.collection('users').countDocuments({}),
    database.collection('medicines').countDocuments({}),
    database.collection('sales').countDocuments({}),
    database.collection('purchases').countDocuments({}),
  ]);

  let response: Response;
  try {
    response = await fetcher(new URL('/functions/v1/control-plane/heartbeat', config.controlPlaneUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-key-hash': localState.deviceKeyHash,
      },
      body: JSON.stringify({
        app_version: config.appVersion,
        health_counts: { users, products, sales, purchases },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return 'offline';
  }
  if (!response.ok) return 'offline';

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return 'licence-rejected';
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)
    || !('received' in body) || body.received !== true
    || !('licence' in body) || typeof body.licence !== 'object'
    || body.licence === null || Array.isArray(body.licence)) {
    return 'licence-rejected';
  }
  const licenceResponse = body.licence as Record<string, unknown>;
  if ((licenceResponse.status !== 'active' && licenceResponse.status !== 'suspended')
    || typeof licenceResponse.signature !== 'string'
    || typeof licenceResponse.payload !== 'object'
    || licenceResponse.payload === null || Array.isArray(licenceResponse.payload)) return 'licence-rejected';
  const signedLicence: SignedLicence = {
    payload: licenceResponse.payload as SignedLicence['payload'],
    signature: licenceResponse.signature,
  };
  if (!await verifyLicence(
    signedLicence,
    config.licencePublicKey ?? '',
    localState.controlPlaneShopId,
  )) return 'licence-rejected';

  await states.updateOne({ _id: 'control-plane' }, {
    $set: {
      licence: signedLicence,
      status: licenceResponse.status,
      lastSeenAt: new Date(),
    },
  });
  return 'updated';
}

export function startControlPlaneHeartbeat(
  client: MongoClient,
  config: AppConfig,
  onLicenceRejected: () => void,
  onFailure: () => void,
): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      if (await sendControlPlaneHeartbeat(client, config) === 'licence-rejected') onLicenceRejected();
    } catch {
      onFailure();
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), 6 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
