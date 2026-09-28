import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { sessionExportFiles } from '../src/export/serialize.ts';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error(
    'Usage: node --experimental-strip-types scripts/export-session.mjs session.json output-directory',
  );
  process.exit(1);
}
const data = JSON.parse(await readFile(resolve(input), 'utf8'));
if (
  !data.session ||
  !Array.isArray(data.measurements) ||
  !Array.isArray(data.events) ||
  !Array.isArray(data.snapshots)
) {
  throw new Error(
    'Expected an app session JSON export with session, measurements, events and snapshots.',
  );
}
const directory = resolve(output);
await mkdir(directory, { recursive: true });
for (const file of sessionExportFiles(data)) {
  const path = join(directory, file.name);
  if (path === resolve(input))
    throw new Error(
      'Choose an output directory that will not overwrite the input JSON.',
    );
  await writeFile(path, file.content, 'utf8');
  console.log(path);
}
