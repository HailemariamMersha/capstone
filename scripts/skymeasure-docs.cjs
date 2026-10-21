const fs = require('node:fs');
fs.mkdirSync('dashboard/public/measurements', { recursive: true });
fs.cpSync('docs/measurements/audits', 'dashboard/public/measurements/audits', {
  recursive: true,
});
for (const name of fs.readdirSync('docs/measurements')) {
  if (name.endsWith('.md'))
    fs.copyFileSync(
      `docs/measurements/${name}`,
      `dashboard/public/measurements/${name}`,
    );
}
fs.copyFileSync(
  'scripts/measurements/columns.json',
  'dashboard/public/measurements/columns.json',
);
fs.writeFileSync(
  'dashboard/public/measurement-guide.md',
  fs.readFileSync('docs/skymeasure/combined-csv.md'),
);
console.log(
  'Dashboard measurement documentation refreshed from the repository dictionary.',
);
