import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptsDirectory, '..');
const helperPath = join(scriptsDirectory, 'release-signature.mjs');
const signerPath = join(scriptsDirectory, 'sign-release.ps1');

function runNode(args) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runSigner(manifestPath, privateKeyPath, signaturePath) {
  return spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', signerPath,
    '-ManifestPath', manifestPath,
    '-PrivateKeyPath', privateKeyPath,
    '-SignaturePath', signaturePath,
  ], { encoding: 'utf8', windowsHide: true });
}

test('Ed25519 signature accepts a valid bundle and rejects tampering and wrong keys', async (t) => {
  assert.equal(process.platform, 'win32', 'PowerShell signer tests require Windows');
  const directory = await mkdtemp(join(tmpdir(), 'pharmacare-signature-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const bundlePath = join(directory, 'images.tar');
  const manifestPath = join(directory, 'release-manifest.json');
  const signaturePath = join(directory, 'release-manifest.json.sig');
  const privateKeyPath = join(directory, 'test-private.pem');
  const publicKeyPath = join(directory, 'test-public.pem');
  const wrongPublicKeyPath = join(directory, 'wrong-public.pem');
  const bundle = Buffer.from('throwaway release bundle');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const wrongKeys = generateKeyPairSync('ed25519');

  await writeFile(bundlePath, bundle);
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(wrongPublicKeyPath, wrongKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(manifestPath, `${JSON.stringify({
    version: 'throwaway-test',
    bundle_file: 'images.tar',
    images_sha256: createHash('sha256').update(bundle).digest('hex'),
  })}\n`);

  const signing = runSigner(manifestPath, privateKeyPath, signaturePath);
  assert.equal(signing.status, 0, `${signing.stdout}\n${signing.stderr}`);
  assert.match(signing.stdout, /signed and verified with Node\.js Ed25519/);

  const valid = runNode(['verify', manifestPath, signaturePath, publicKeyPath, directory]);
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);

  await writeFile(bundlePath, 'tampered throwaway bundle');
  const tampered = runNode(['verify', manifestPath, signaturePath, publicKeyPath, directory]);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /SHA256 does not match/);
  await writeFile(bundlePath, bundle);

  const wrongKey = runNode(['verify', manifestPath, signaturePath, wrongPublicKeyPath, directory]);
  assert.equal(wrongKey.status, 1);
  assert.match(wrongKey.stderr, /signature verification failed/);

  const verifiedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(verifiedManifest.bundle_file, 'images.tar');
});
