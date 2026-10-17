import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contextPath = path.join(root, 'docs', 'PROJECT_CONTEXT.md');
const startMarker = '<!-- AUTO:START -->';
const endMarker = '<!-- AUTO:END -->';
const skippedDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage']);

function gitOutput(args, fallback) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return fallback;
  return result.stdout.trim();
}

function displayPath(value) {
  return value.split(path.sep).join('/');
}

async function walk(directory, visitor) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) await walk(fullPath, visitor);
    } else if (entry.isFile()) {
      await visitor(fullPath);
    }
  }
}

async function envNames() {
  const names = new Set();
  await walk(root, async (filePath) => {
    if (path.basename(filePath) !== '.env.example') return;
    const contents = await readFile(filePath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match) names.add(match[1]);
    }
  });
  return [...names].sort();
}

function bulletList(values, emptyMessage) {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : `- ${emptyMessage}`;
}

const variables = await envNames();
const commitSubjects = gitOutput(['log', '-5', '--pretty=format:%s'], '')
  .split(/\r?\n/)
  .filter(Boolean);
const generatedAt = new Date().toISOString();

const generated = [
  `Generated at (UTC): ${generatedAt}`,
  `Git branch: ${gitOutput(['branch', '--show-current'], 'unknown (git unavailable or no branch)')}`,
  '',
  'Last 5 commit subjects:',
  bulletList(commitSubjects, 'unknown (git unavailable or no commits)'),
  '',
  'Validation commands: `npm run lint`, `npm test`, and `npm run build`.',
  '',
  'Environment variable names from .env.example files (values are not read into this block):',
  bulletList(variables, 'none found'),
].join('\n');

const original = await readFile(contextPath, 'utf8');
const start = original.indexOf(startMarker);
const end = original.indexOf(endMarker);
if (start === -1 || end === -1 || end < start) {
  throw new Error(`Missing or misordered AUTO markers in ${displayPath(path.relative(root, contextPath))}`);
}

const before = original.slice(0, start + startMarker.length);
const after = original.slice(end);
const updated = `${before}\n${generated}\n${after}`;
await writeFile(contextPath, updated, 'utf8');
console.log(`Updated ${displayPath(path.relative(root, contextPath))}`);
