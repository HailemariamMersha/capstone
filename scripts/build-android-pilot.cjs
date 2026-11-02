/* Configured Android pilot build. Public values are validated inside the APK. */
const fs = require('node:fs');
const { Buffer } = require('node:buffer');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--out');
if (outputIndex !== -1 && !args[outputIndex + 1])
  throw new Error('--out requires a directory');
const out = path.resolve(
  root,
  outputIndex === -1 ? 'build/pilot/current' : args[outputIndex + 1],
);
const configFile = path.join(root, 'src/config/public.json');
const original = fs.readFileSync(configFile);
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const lockPath = path.join(root, 'build/skymeasure-pilot-build.lock');
const lock = fs.openSync(lockPath, 'wx');
fs.writeSync(lock, String(process.pid));
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${path.basename(command)} failed; see build output`);
  return result.stdout;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const envFile = path.join(root, '.env.skymeasure.local');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  process.env.SKYMEASURE_REDIRECT_URL =
    'com.labpracticeapp.flightpilot://auth/callback';
  const sourceCommit = run('git', ['rev-parse', 'HEAD']).trim();
  const sourceDirty = Boolean(
    run('git', ['status', '--porcelain', '--untracked-files=normal']).trim(),
  );
  run(process.execPath, ['scripts/configure-skymeasure.cjs'], {
    stdio: 'inherit',
  });
  const configBytes = fs.readFileSync(configFile);
  const config = JSON.parse(configBytes);
  const tasks = [':app:assembleRelease'];
  if (args.includes('--with-tests'))
    tasks.push(':app:assembleReleaseAndroidTest');
  run(
    path.join(root, 'android/gradlew'),
    [
      '-p',
      'android',
      ...tasks,
      '-PreactNativeArchitectures=arm64-v8a',
      '-PflightPilot=true',
      '--console=plain',
    ],
    { stdio: 'inherit' },
  );
  const builtApk = path.join(
    root,
    'android/app/build/outputs/apk/release/app-release.apk',
  );
  // Inspect the actual packaged Hermes bundle, not just the input file.
  const extracted = spawnSync(
    'unzip',
    ['-p', builtApk, 'assets/index.android.bundle'],
    { maxBuffer: 64 * 1048576 },
  );
  if (extracted.status !== 0 || !Buffer.isBuffer(extracted.stdout))
    throw new Error('Cannot inspect packaged JavaScript');
  for (const key of [
    'supabaseUrl',
    'supabasePublishableKey',
    'apiUrl',
    'probeUrl',
    'redirectUrl',
  ]) {
    if (!extracted.stdout.includes(Buffer.from(config[key])))
      throw new Error(
        `APK verification failed: public ${key} is absent from its bundle`,
      );
  }
  const gradle = fs.readFileSync(
    path.join(root, 'android/app/build.gradle'),
    'utf8',
  );
  const versionName = gradle.match(/versionName "([^"]+)"/)[1];
  const versionCode = Number(gradle.match(/versionCode (\d+)/)[1]);
  fs.mkdirSync(out, { recursive: true });
  const apkName = 'SkyMeasure-pilot-arm64.apk';
  const apk = path.join(out, apkName);
  fs.copyFileSync(builtApk, apk);
  const bytes = fs.readFileSync(apk);
  const manifest = {
    sourceCommit,
    sourceDirty,
    package: 'com.labpracticeapp.flightpilot',
    versionName,
    versionCode,
    apk: apkName,
    bytes: bytes.length,
    sha256: sha(bytes),
    publicConfigSha256: sha(configBytes),
    packagedPublicConfigVerified: true,
    signing: 'development key; private pilot only',
  };
  fs.writeFileSync(
    path.join(out, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log(JSON.stringify({ apk, ...manifest }, null, 2));
} finally {
  fs.writeFileSync(configFile, original);
  fs.closeSync(lock);
  fs.unlinkSync(lockPath);
}
