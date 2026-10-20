import { randomBytes, randomUUID, createPrivateKey, sign } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

const configPath = process.env.TEST_CONTROL_PLANE_CONFIG;
if (!configPath) throw new Error('Test control-plane config path is required.');

const config = JSON.parse(await readFile(configPath, 'utf8'));
const privateKey = createPrivateKey(await readFile(config.privateKeyPath));
const usedActivationCodes = new Set();

function signedLicence(shopId) {
  const payload = {
    shop_id: shopId,
    plan_type: 'one_time',
    starts_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: null,
    max_pcs: 3,
    offline_grace_days: 14,
    warning_days: 7,
    renewal_notice_days: 7,
    issued_at: new Date().toISOString(),
    nonce: randomUUID(),
  };
  const canonical = JSON.stringify(payload);
  return {
    payload,
    signature: sign(null, Buffer.from(canonical), privateKey).toString('base64url'),
  };
}

const licence = signedLicence(config.shopId);

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

const controlPlane = createHttpServer(async (request, response) => {
  try {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'POST' && path === '/functions/v1/control-plane/activate') {
      const body = await readJson(request);
      if (typeof body.activation_code !== 'string' || usedActivationCodes.has(body.activation_code)) {
        sendJson(response, 403, { error: 'ACTIVATION_CODE_INVALID' });
        return;
      }
      usedActivationCodes.add(body.activation_code);
      sendJson(response, 200, {
        device_key: randomBytes(32).toString('base64url'),
        licence,
      });
      return;
    }
    if (request.method === 'POST' && path === '/functions/v1/control-plane/heartbeat') {
      await readJson(request);
      sendJson(response, 200, {
        received: true,
        licence: { status: 'active', ...licence },
      });
      return;
    }
    if (request.method === 'POST' && path === '/functions/v1/control-plane/get-release') {
      await readJson(request);
      try {
        const release = JSON.parse(await readFile(config.releaseIndexPath, 'utf8'));
        sendJson(response, 200, release);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          sendJson(response, 404, { error: 'NO_APPROVED_RELEASE' });
          return;
        }
        throw error;
      }
      return;
    }
    sendJson(response, 404, { error: 'NOT_FOUND' });
  } catch {
    sendJson(response, 400, { error: 'INVALID_TEST_REQUEST' });
  }
});

const releaseServer = createHttpsServer({
  pfx: await readFile(config.certificatePath),
  passphrase: process.env.TEST_RELEASE_CERT_PASSWORD,
}, async (request, response) => {
  try {
    const path = new URL(request.url ?? '/', 'https://localhost').pathname;
    if (request.method !== 'GET' || !path.startsWith('/releases/')) {
      response.writeHead(404).end();
      return;
    }
    const fileName = basename(path);
    if (!['release-manifest.json', 'images.tar'].includes(fileName)) {
      response.writeHead(404).end();
      return;
    }
    const release = JSON.parse(await readFile(config.releaseIndexPath, 'utf8'));
    const releaseDirectory = resolve(release.testReleaseDirectory);
    const candidate = resolve(releaseDirectory, fileName);
    if (!candidate.startsWith(`${releaseDirectory}${sep}`)) {
      response.writeHead(400).end();
      return;
    }
    const fileInfo = await stat(candidate);
    response.writeHead(200, {
      'content-length': fileInfo.size,
      'content-type': fileName.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    });
    response.end(await readFile(candidate));
  } catch {
    response.writeHead(404).end();
  }
});

let listening = 0;
function close() {
  for (const server of [controlPlane, releaseServer]) {
    if (server.listening) server.close();
  }
}

for (const server of [controlPlane, releaseServer]) {
  server.on('listening', () => {
    listening += 1;
    if (listening === 2) console.log('READY');
  });
  server.on('error', () => {
    close();
    process.exitCode = 1;
  });
}

controlPlane.listen(config.controlPlanePort, '0.0.0.0');
releaseServer.listen(config.releasePort, '127.0.0.1');
process.once('SIGINT', close);
process.once('SIGTERM', close);
