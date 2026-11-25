/** Private, non-overwriting evidence bundles shared by the runner and comparison. */
import { createReadStream } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { csvCell } from '../../src/export/serialize.ts';

export async function createPrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length)
    throw new Error(
      `Output directory is not empty: ${directory}. Choose a new directory.`,
    );
  await chmod(directory, 0o700);
  // A second writer must not be able to claim this same directory.
  await writeFile(path.join(directory, '.evidence-lock'), `${process.pid}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

export async function writePrivate(directory, name, value) {
  const file = path.join(directory, name);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(
    temp,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await rename(temp, file);
}

export const csv = (columns, rows) =>
  [
    columns.map(csvCell).join(','),
    ...rows.map(row => columns.map(key => csvCell(row[key])).join(',')),
  ].join('\r\n') + '\r\n';

export async function fingerprint(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** Call only after writers (including tcpdump) have stopped. The manifest excludes itself. */
export async function sealEvidence(directory, metadata = {}) {
  const files = [];
  async function walk(relative = '') {
    const entries = await readdir(path.join(directory, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (name === 'manifest.json' || entry.name === '.evidence-lock') continue;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile())
        files.push({
          path: name,
          ...(await fingerprint(path.join(directory, name))),
        });
      else throw new Error(`Evidence contains a non-regular file: ${name}`);
    }
  }
  await walk();
  const manifest = {
    schema: 'skymeasure-evidence-1',
    sealedAt: new Date().toISOString(),
    ...metadata,
    files,
  };
  await writePrivate(directory, 'manifest.json', manifest);
  return manifest;
}

/** Hashes detect accidental changes; this is not a signed authenticity claim. */
export async function verifyEvidence(directory) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, 'manifest.json'), 'utf8'),
  );
  if (
    manifest.schema !== 'skymeasure-evidence-1' ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Unrecognised evidence manifest');
  const issues = [],
    expected = new Set(),
    regularFiles = new Set();
  // Inventory without following symlinks before opening anything named by a manifest.
  async function walk(relative = '') {
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = path.posix.join(relative, entry.name);
      if (name === 'manifest.json' || entry.name === '.evidence-lock') continue;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) regularFiles.add(name);
      else issues.push({ path: name, reason: 'nonregular_file' });
    }
  }
  await walk();
  for (const file of manifest.files) {
    const name = file.path;
    if (
      typeof name !== 'string' ||
      path.isAbsolute(name) ||
      name.split('/').some(p => !p || p === '.' || p === '..') ||
      expected.has(name)
    ) {
      issues.push({ path: name, reason: 'invalid_or_duplicate_path' });
      continue;
    }
    expected.add(name);
    if (!regularFiles.has(name)) {
      issues.push({ path: name, reason: 'missing_file' });
      continue;
    }
    try {
      const actual = await fingerprint(path.join(directory, name));
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
        issues.push({ path: name, reason: 'content_changed' });
    } catch (error) {
      issues.push({
        path: name,
        reason: error.code === 'ENOENT' ? 'missing_file' : 'unreadable_file',
      });
    }
  }
  for (const name of regularFiles)
    if (!expected.has(name))
      issues.push({ path: name, reason: 'unlisted_file' });
  return { ok: issues.length === 0, files: expected.size, issues };
}
