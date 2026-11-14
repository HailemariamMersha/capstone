const fs = require('node:fs');
fs.mkdirSync('dashboard/public/measurements', { recursive: true });
fs.cpSync('docs/measurements/audits', 'dashboard/public/measurements/audits', {
  recursive: true,
});
for (const name of fs.readdirSync('docs/measurements')) {
  if (name.endsWith('.md'))
    fs.writeFileSync(
      `dashboard/public/measurements/${name}`,
      fs.readFileSync(`docs/measurements/${name}`, 'utf8').replaceAll(
        '(../skymeasure/',
        '(https://github.com/HailemariamMersha/capstone/blob/feature/skymeasure-participant-dashboard/docs/skymeasure/',
      ),
    );
}
fs.copyFileSync(
  'scripts/measurements/columns.json',
  'dashboard/public/measurements/columns.json',
);
fs.writeFileSync(
  'dashboard/public/measurement-guide.md',
  fs
    .readFileSync('docs/skymeasure/combined-csv.md', 'utf8')
    .replaceAll('(../measurements/', '(/measurements/')
    .replaceAll('(../../scripts/measurements/', '(/measurements/')
    .replaceAll('(dashboard-filters.md)', '(/dashboard-filters.md)'),
);
fs.writeFileSync(
  'dashboard/public/dashboard-filters.md',
  fs
    .readFileSync('docs/skymeasure/dashboard-filters.md', 'utf8')
    .replaceAll('(../measurements/', '(/measurements/')
    .replaceAll('(combined-csv.md)', '(/measurement-guide.md)'),
);
console.log(
  'Dashboard measurement documentation refreshed from the repository dictionary.',
);
