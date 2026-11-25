const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const target = process.argv[2];
if (!target) throw new Error('Expected generated asset destination');
const moduleUrl = pathToFileURL(
  path.join(root, 'src/measurements/paperSuite.ts'),
).href;
const json = execFileSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `import {PAPER_REGISTRY} from ${JSON.stringify(
      moduleUrl,
    )};process.stdout.write(JSON.stringify(PAPER_REGISTRY));`,
  ],
  { encoding: 'utf8' },
);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, json + '\n');
