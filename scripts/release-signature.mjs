import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function readRelease(manifestPath, bundleDirectory) {
  const manifestBytes = await readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Release manifest is not valid JSON.');
  }
  if (typeof manifest.bundle_file !== 'string'
    || basename(manifest.bundle_file) !== manifest.bundle_file
    || typeof manifest.images_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(manifest.images_sha256)) {
    throw new Error('Release manifest has invalid bundle metadata.');
  }
  const resolvedBundle = resolve(bundleDirectory ?? dirname(manifestPath), manifest.bundle_file);
  const bundleBytes = await readFile(resolvedBundle);
  if (sha256(bundleBytes) !== manifest.images_sha256) {
    throw new Error('Release bundle SHA256 does not match the manifest.');
  }
  return { manifestBytes, bundleBytes };
}

async function signManifest(manifestPath, privateKeyPath, signaturePath) {
  const { manifestBytes } = await readRelease(manifestPath);
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Signing key must be Ed25519.');
  }
  const signature = sign(null, manifestBytes, privateKey);
  if (!verify(null, manifestBytes, createPublicKey(privateKey), signature)) {
    throw new Error('New release signature failed local verification.');
  }
  await writeFile(signaturePath, `${signature.toString('base64url')}\n`, { flag: 'wx' });
  console.log('Release manifest signed and verified with Node.js Ed25519.');
}

async function verifyRelease(manifestPath, signaturePath, publicKeyPath, bundleDirectory) {
  const { manifestBytes, bundleBytes } = await readRelease(manifestPath, bundleDirectory);
  const publicKey = createPublicKey(await readFile(publicKeyPath));
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Verification key must be Ed25519.');
  }
  const encodedSignature = (await readFile(signaturePath, 'utf8')).trim();
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (!encodedSignature || signature.toString('base64url') !== encodedSignature
    || !verify(null, manifestBytes, publicKey, signature)) {
    throw new Error('Release signature verification failed.');
  }
  console.log(`Release verification passed; bundle SHA256 ${sha256(bundleBytes)}.`);
}

async function main(args) {
  const [command, ...values] = args;
  if (command === 'sign' && values.length === 3) {
    await signManifest(...values);
    return;
  }
  if (command === 'verify' && values.length === 4) {
    await verifyRelease(...values);
    return;
  }
  throw new Error(
    'Usage: release-signature.mjs sign <manifest> <private-key> <signature> | '
    + 'verify <manifest> <signature> <public-key> <bundle-directory>',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Release verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
