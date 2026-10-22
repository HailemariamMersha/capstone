/* Only public configuration is bundled. Refuse secret-looking Supabase keys. */
const fs = require('node:fs');
const fields = {
  supabaseUrl: 'SKYMEASURE_SUPABASE_URL',
  supabasePublishableKey: 'SKYMEASURE_SUPABASE_PUBLISHABLE_KEY',
  apiUrl: 'SKYMEASURE_API_URL',
  probeUrl: 'SKYMEASURE_PROBE_URL',
  udpHost: 'SKYMEASURE_UDP_IPV4',
  probeRegion: 'SKYMEASURE_PROBE_REGION',
};
const target = 'src/config/public.json';
const config = JSON.parse(fs.readFileSync(target, 'utf8'));
for (const [key, env] of Object.entries(fields)) {
  if (!process.env[env])
    throw new Error(`Set ${env} before configuring a participant build`);
  config[key] = process.env[env];
}
if (!/^[a-z][a-z0-9-]{1,31}$/.test(config.probeRegion))
  throw new Error(
    'Set SKYMEASURE_PROBE_REGION to the actual probe region, such as lon1',
  );
for (const key of ['supabaseUrl', 'apiUrl', 'probeUrl']) {
  const url = new URL(config[key]);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      `${key} must use HTTPS without credentials or query parameters`,
    );
  config[key] = config[key].replace(/\/$/, '');
}
if (!config.supabasePublishableKey.startsWith('sb_publishable_'))
  throw new Error(
    'Use a Supabase public publishable key, never a service_role/secret key',
  );
if (
  !/^\d{1,3}(\.\d{1,3}){3}$/.test(config.udpHost) ||
  config.udpHost.split('.').some(x => Number(x) > 255)
)
  throw new Error('The UDP probe needs the controlled server IPv4 address');
fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
console.log(
  'Public SkyMeasure configuration written. No private credentials were read.',
);
