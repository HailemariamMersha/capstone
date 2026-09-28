// Bundle pinned upstream sources locally; no remote script execution or CDN dependency.
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(require.resolve('@m-lab/ndt7/package.json'));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const assets = {
  version: JSON.parse(read('package.json')).version,
  license: read('LICENSE'),
  client: read('src/ndt7.js'),
  runner: fs.readFileSync(path.join(__dirname, 'ndt7-browser.js'), 'utf8'),
  download: read('src/ndt7-download-worker.js'),
  upload: read('src/ndt7-upload-worker.js'),
};
fs.writeFileSync(
  path.join(__dirname, '../src/reference/ndt7Assets.json'),
  JSON.stringify(assets, null, 2) + '\n',
);
