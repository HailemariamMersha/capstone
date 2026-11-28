#!/usr/bin/env node
/** Offline, private, self-contained per-test evidence for researcher review. */
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import net from 'node:net';
import { zipSync } from 'fflate';
import { PAPER_REGISTRY } from '../../src/measurements/paperSuite.ts';
import { measurementOutcome } from '../../src/measurements/outcome.ts';
import { endpointOf, loadSessions, readInputs } from './compare.mjs';
import {
  createPrivateDirectory,
  fingerprint,
  sealEvidence,
  verifyEvidence,
  writePrivate,
} from './evidence.mjs';

const FAMILIES = {
  icmp: ['icmp_burst', 'icmp_rtt'],
  udp: ['udp_echo'],
  tcp: ['tcp_connect'],
  traceroute: ['traceroute'],
  cdn: ['cdn_fetch'],
  resolver: ['dns_resolver'],
  mlab: ['ndt7_download', 'ndt7_upload'],
};
const familyOf = type =>
  Object.keys(FAMILIES).find(k => FAMILIES[k].includes(type)) ?? 'other';
const canonical = key => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const IDENTITIES = new Set([
  'ownerid',
  'userid',
  'participantid',
  'accountid',
  'username',
  'netid',
  'email',
  'displayname',
  'flight',
  'flightdetails',
  'reportedflight',
  'account',
  'profile',
  'latitude',
  'longitude',
  'coordinates',
  'rawlocation',
]);
const SECRET =
  /^(?:authorization|proxyauthorization|cookie|setcookie|accesstoken|refreshtoken|idtoken|token|jwt|password|apikey|apisecret|clientsecret|servicerolekey|licensekey|privatekey|secret)$/;
const pointer = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
const validTime = value =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
};
async function destinationPath(value) {
  let parent = path.resolve(value);
  const tail = [];
  for (;;) {
    try {
      return path.join(await realpath(parent), ...tail.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      tail.push(path.basename(parent));
      parent = path.dirname(parent);
    }
  }
}

/** Keep technical fields and raw text unchanged unless an explicit redaction applies. */
export function sanitizeEvidence(value, redactions, location = '') {
  const note = (where, reason) => redactions.push({ path: where, reason });
  function string(text, where, key) {
    // curl JSON and NDT7 JSONL can contain sensitive fields inside stdout strings.
    if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
      const lines = text.split('\n');
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          const before = redactions.length;
          const cleaned = visit(parsed, `${where}/~json`, '');
          if (redactions.length > before) return JSON.stringify(cleaned);
        }
      } catch {
        /* Plain command output or JSONL; preserve it unless necessary. */
      }
      if (
        /^(?:raw)?std(?:out|err)$/i.test(key) &&
        lines.filter(l => l.trim()).length > 1
      ) {
        try {
          const parsed = lines.map(l => (l.trim() ? JSON.parse(l) : null));
          const before = redactions.length;
          const cleaned = parsed.map((v, i) =>
            v === null ? null : visit(v, `${where}/~jsonl/${i}`, ''),
          );
          if (redactions.length > before)
            return cleaned
              .map(v => (v === null ? '' : JSON.stringify(v)))
              .join('\n');
        } catch {
          /* Non-JSON command output. */
        }
      }
    }
    let changed = false;
    const cleaned = text
      .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, address => {
        try {
          const url = new URL(address);
          let secret = false;
          if (url.username || url.password) {
            url.username = '';
            url.password = '';
            secret = true;
          }
          for (const name of [...url.searchParams.keys()])
            if (SECRET.test(canonical(name))) {
              url.searchParams.set(name, '[REDACTED]');
              secret = true;
            }
          if (secret) {
            changed = true;
            return url.href;
          }
        } catch {
          /* Not a complete URL. */
        }
        return address;
      })
      .replace(
        /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n"']+/gi,
        '$1: [REDACTED]',
      )
      .replace(
        /("(?:authorization|proxy[-_]authorization|cookie|set[-_]cookie|access[-_]token|refresh[-_]token|id[-_]token|password|api[-_]key|client[-_]secret|token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
        '$1"[REDACTED]"',
      )
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        '[REDACTED]',
      );
    if (changed || cleaned !== text)
      note(where, 'authentication_text_redacted');
    return cleaned;
  }
  function visit(v, where, key) {
    if (Array.isArray(v))
      return v.map((item, i) => visit(item, `${where}/${i}`, key));
    if (v && typeof v === 'object') {
      const result = {};
      for (const [name, item] of Object.entries(v)) {
        const at = `${where}/${pointer(name)}`,
          nameKey = canonical(name);
        if (IDENTITIES.has(nameKey)) {
          note(at, 'nonmeasurement_identity_omitted');
          continue;
        }
        if (
          (SECRET.test(nameKey) ||
            /^(?:url|urle)(?:user|password)$/.test(nameKey) ||
            /(?:^|[._-])(?:password|secret|access_token|refresh_token)$/i.test(
              name,
            )) &&
          item != null &&
          item !== ''
        ) {
          result[name] = '[REDACTED]';
          note(at, 'authentication_field_redacted');
        } else {
          Object.defineProperty(result, name, {
            value: visit(item, at, name),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
      }
      return result;
    }
    return typeof v === 'string' ? string(v, where, key) : v;
  }
  return visit(value, location, '');
}

function configuredTarget(m, config) {
  const family = familyOf(m.type);
  if (family === 'mlab') return 'ndt7_auto_selection';
  if (family === 'resolver') return 'nextdns';
  if (m.targetId) return m.targetId;
  if (family === 'cdn' && m.paper?.provider) return m.paper.provider;
  let target =
    m.targetHost ??
    m.details?.targetHost ??
    {
      icmp: config.icmpHost,
      udp: config.udpHost,
      tcp: config.tcpServerUrl,
      traceroute: config.tracerouteHost,
    }[family];
  let port =
    m.details?.targetPort ??
    m.raw?.request?.port ??
    (family === 'udp' ? config.udpPort : null);
  if (typeof target !== 'string' || !target) return 'unknown_target';
  if (target.includes('://')) {
    try {
      const url = new URL(target);
      target = url.hostname;
      port ??= url.port
        ? Number(url.port)
        : url.protocol === 'https:'
        ? 443
        : url.protocol === 'http:'
        ? 80
        : null;
    } catch {
      return 'unknown_target';
    }
  }
  if (family === 'tcp')
    port ??=
      m.raw?.callbacks?.map(c => c.value?.remotePort).find(Number.isInteger) ??
      443;
  return port == null ? target : `${target}:${port}`;
}

function benchmarkKey(m, sessionId) {
  const explicit = m.reference?.runId ?? m.raw?.request?.runId;
  if (typeof explicit === 'string' && explicit)
    return `${sessionId}:run:${explicit}`;
  if (m.raw?.request?.outputFile)
    return `${sessionId}:command:${m.raw.request.outputFile}`;
  // Both directions created by runTripMlab share the same scheduled execution slot.
  if (validTime(m.scheduledAt))
    return `${sessionId}:scheduled:${m.scheduledAt}`;
  if (validTime(m.scheduling?.startedAt) && validTime(m.scheduling?.callbackAt))
    return `${sessionId}:execution:${m.scheduling.startedAt}:${m.scheduling.callbackAt}`;
  return null;
}

function emptyCounts() {
  return {
    measurements: 0,
    attempts: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    unavailable: 0,
    unpairedDirections: 0,
  };
}

export function repetitionReport(sources, minimumRepeats) {
  const groups = new Map();
  const get = (source, family, type, target) => {
    const key = JSON.stringify([source, family, type, target]);
    if (!groups.has(key))
      groups.set(key, {
        source,
        test: family,
        measurementType: type,
        target,
        ...emptyCounts(),
        resolvedIpCounts: {},
        mixedDestinationMeasurements: 0,
        unknownDestinationMeasurements: 0,
        benchmarks: new Map(),
      });
    return groups.get(key);
  };
  for (const [source, sessions] of Object.entries(sources)) {
    for (const s of sessions) {
      const config = s.session.config ?? {};
      const registry =
        config.paperRegistry ??
        (config.measurementSuiteVersion === PAPER_REGISTRY.version
          ? PAPER_REGISTRY
          : null);
      for (const [family, type, targets] of [
        ['traceroute', 'traceroute', registry?.traces],
        ['cdn', 'cdn_fetch', registry?.cdns],
      ])
        for (const target of targets ?? [])
          get(source, family, type, target.id);
      for (const m of s.measurements) {
        const family = familyOf(m.type),
          target = configuredTarget(m, config);
        const group = get(
          source,
          family,
          family === 'mlab' ? 'ndt7_pair' : m.type,
          target,
        );
        group.measurements++;
        const addresses = new Set(
          [
            m.resolvedAddress,
            m.baseline?.resolvedAddress,
            m.paper?.remoteAddress,
            endpointOf(m).address,
            ...(m.details?.samples ?? []).flatMap(sample => [
              sample.resolvedAddress,
              sample.packet?.resolvedAddress,
            ]),
          ].filter(ip => typeof ip === 'string' && net.isIP(ip)),
        );
        for (const ip of addresses)
          group.resolvedIpCounts[ip] = (group.resolvedIpCounts[ip] ?? 0) + 1;
        if (addresses.size > 1) group.mixedDestinationMeasurements++;
        if (!addresses.size) group.unknownDestinationMeasurements++;
        if (family === 'mlab') {
          const key = benchmarkKey(m, s.session.id);
          if (!key) {
            group.unpairedDirections++;
            continue;
          }
          if (!group.benchmarks.has(key)) group.benchmarks.set(key, []);
          group.benchmarks.get(key).push(m);
        } else {
          group.attempts++;
          const outcome = measurementOutcome(m);
          group[
            {
              success: 'succeeded',
              failure: 'failed',
              interrupted: 'interrupted',
              unavailable: 'unavailable',
            }[outcome]
          ]++;
          if (outcome === 'success' || outcome === 'failure') group.completed++;
        }
      }
    }
    for (const family of Object.keys(FAMILIES))
      if (
        ![...groups.values()].some(
          g => g.source === source && g.test === family,
        )
      )
        get(
          source,
          family,
          family === 'mlab' ? 'ndt7_pair' : FAMILIES[family][0],
          family === 'mlab'
            ? 'ndt7_auto_selection'
            : family === 'resolver'
            ? 'nextdns'
            : 'unknown_target',
        );
  }
  return {
    schemaVersion: 1,
    minimumRepeats,
    definition:
      'One execution per configured target and device; terminal failures count as completed attempts. Interruptions and unavailable outcomes do not. M-Lab counts linked download/upload pairs, not direction records.',
    timingComparability:
      'Configured-target counts do not establish matching destination IPs, simultaneous timing or measurement accuracy. Resolved-IP counts are separate.',
    groups: [...groups.values()]
      .map(group => {
        if (group.test === 'mlab')
          for (const rows of group.benchmarks.values()) {
            group.attempts++;
            if (
              rows.length !== 2 ||
              new Set(rows.map(m => m.type)).size !== 2
            ) {
              group.unavailable++;
              group.unpairedDirections += rows.length;
              continue;
            }
            const outcomes = rows.map(measurementOutcome);
            if (outcomes.includes('interrupted')) group.interrupted++;
            else if (outcomes.includes('unavailable')) group.unavailable++;
            else {
              group.completed++;
              group[
                outcomes.every(o => o === 'success') ? 'succeeded' : 'failed'
              ]++;
            }
          }
        const result = { ...group };
        delete result.benchmarks;
        return {
          ...result,
          remaining:
            group.target === 'unknown_target'
              ? minimumRepeats
              : Math.max(0, minimumRepeats - group.completed),
        };
      })
      .sort((a, b) =>
        `${a.source}:${a.test}:${a.target}:${a.measurementType}`.localeCompare(
          `${b.source}:${b.test}:${b.target}:${b.measurementType}`,
        ),
      ),
  };
}

function validateRecords(sessions, source) {
  const seen = new Set();
  for (const s of sessions)
    for (const m of s.measurements) {
      if (
        typeof m.id !== 'string' ||
        !m.id ||
        typeof m.type !== 'string' ||
        !m.type
      )
        throw new Error(`${source} has a measurement without an ID or type.`);
      if (m.sessionId != null && m.sessionId !== s.session.id)
        throw new Error(
          `${source} measurement ${m.id} has a different parent session.`,
        );
      if (seen.has(m.id))
        throw new Error(`${source} has a duplicate measurement ID: ${m.id}`);
      seen.add(m.id);
    }
}

async function commandEvidence(root, filename) {
  if (
    typeof filename !== 'string' ||
    path.isAbsolute(filename) ||
    !within(root, path.resolve(root, filename))
  )
    throw new Error(
      'Mac command reference escapes the selected run directory.',
    );
  const file = path.resolve(root, filename);
  if (!(await lstat(file)).isFile() || !within(root, await realpath(file)))
    throw new Error(
      'Mac command reference is a symlink, non-file or outside the run.',
    );
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(value.runs))
    throw new Error('Mac raw command evidence has no runs array.');
  return value;
}

function interval(sessions) {
  const starts = sessions
    .map(s => s.session.startedAt)
    .filter(validTime)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const ends = sessions
    .map(s => s.session.endedAt)
    .filter(validTime)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    startedAt: starts[0] ?? null,
    endedAt: ends.at(-1) ?? null,
    hasOpenSessions: sessions.some(s => !s.session.endedAt),
  };
}

function readingGuide(repetitions, totals, files, redactionCount) {
  const escape = value =>
    String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = repetitions.groups.map(
    g =>
      `| ${g.source} | ${g.test} | ${escape(g.target)} | ${g.completed} | ${
        g.succeeded
      } | ${g.failed} | ${g.interrupted} | ${g.remaining} |`,
  );
  return `# Supervisor measurement evidence\n\nThis bundle contains ${
    totals.app
  } app and ${
    totals.mac
  } Mac measurement records. Entire runs are included; differing durations and targets must not be interpreted as a reliability comparison. No additional tests were launched.\n\n## Files and JSON fields\n\n${files
    .map(name => `- [${name}](${name})`)
    .join(
      '\n',
    )}\n\nEach test JSON has metadata, measurements and commandOutputs. Measurements retain the stored technical record, including unfamiliar fields. metadata.sessions contains parent configuration and technical snapshots; metadata.origins links measurement IDs to source sessions. For Mac measurements, raw.request.outputFile is an original provenance key into commandOutputs, whose records embed argv, stdout, stderr, exit status, timings and outputCapture flags. No external files are needed to read those command records.\n\nTraceroute uses route.samples (hop, sequence, responder address, RTT, outcome and available library fields). ICMP/UDP/TCP use details.samples and raw callbacks where recorded. CDN/resolver results use paper for phases, bytes, hashes and available HTTP headers. M-Lab contains both direction records, byte counters, elapsed times and retained callbacks/terminal messages.\n\n## Availability and interpretation\n\n- Null, absent fields and original unavailable markers remain unavailable, never fabricated zeros. Nanosecond timestamp strings stay strings. Scheduled, execution and callback times have different meanings.\n- HTTP headers were allowlisted during collection. Complete IP/TCP/UDP wire headers, discarded HTTP bodies and kernel/hardware timestamps cannot be reconstructed. Packet evidence that was actually stored remains intact.\n- Mac outputCapture and app droppedCallbacks/unavailable flags describe collection limits; the bundle does not repair truncated evidence.\n- A completed traceroute operation does not imply destination reachability: inspect route.reached. Failed and interrupted observations remain present.\n- This package includes ${redactionCount} documented identity/authentication redactions. See redactions.json for paths and reasons, never original secret values. Technical IPs, network identifiers and times remain sensitive; share privately, not through the public repository. Account/payment/flight details and unrelated events are not part of this package.\n\n## Repetitions toward ${
    repetitions.minimumRepeats
  } per target and device\n\n${
    repetitions.definition
  }\n\nTen ICMP probes or twenty UDP datagrams in a burst count as one execution, not ten or twenty runs. Each complete traceroute to one destination counts once; hops do not count as repeats. DNS nonce hostnames share the resolver test configuration. M-Lab uses its automatic-server-selection profile, with known destinations retained in the source records; unmatched direction records are reported rather than paired by guesswork. Actual resolved IPs appear separately in repetitions.json.\n\n| Device | Test | Configured target | Completed | Succeeded | Failed | Interrupted | Remaining |\n| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |\n${rows.join(
    '\n',
  )}\n\nThese counts do not establish statistical independence or numerical accuracy. Different Google addresses cannot establish paired ICMP/TCP agreement; separate-time or different-server M-Lab tests are not a simultaneous capacity comparison.\n\n## Integrity\n\nmanifest.json records source fingerprints and SHA-256/byte lengths for every packaged file except itself. The ZIP includes that same manifest. Hashes detect changes; they do not prove who collected the observations. Originals remain unchanged and outside this sharing bundle.\n`;
}

export async function packageEvidence({ app, mac, out, minimumRepeats = 15 }) {
  if (!Number.isSafeInteger(minimumRepeats) || minimumRepeats < 1)
    throw new Error('minimum-repeats must be a positive safe integer.');
  const appFile = await realpath(app),
    macRoot = await realpath(mac),
    output = await destinationPath(out);
  if (!(await lstat(appFile)).isFile() || !(await lstat(macRoot)).isDirectory())
    throw new Error('Provide one app JSON file and one Mac run directory.');
  if (
    within(macRoot, output) ||
    within(output, appFile) ||
    within(output, macRoot)
  )
    throw new Error(
      'Output must be separate from the original source evidence.',
    );
  const archive = `${output}.zip`;
  if (existsSync(archive))
    throw new Error('ZIP output already exists; choose a new directory.');
  const integrity = await verifyEvidence(macRoot);
  if (!integrity.ok)
    throw new Error(
      'Mac evidence integrity verification failed; run baseline:verify.',
    );
  const provenance = [];
  const sources = {
    app: loadSessions(await readInputs([appFile], provenance), 'phone'),
    mac: loadSessions(
      await readInputs([path.join(macRoot, 'baseline.json')], provenance),
      'baseline',
    ),
  };
  for (const source of Object.keys(sources))
    validateRecords(sources[source], source);
  // Load and confine raw references before writing any deliverable.
  const commands = new Map();
  for (const s of sources.mac)
    for (const m of s.measurements) {
      const name = m.raw?.request?.outputFile;
      if (name != null && !commands.has(name))
        commands.set(name, await commandEvidence(macRoot, name));
      if (name != null) {
        const raw = commands.get(name);
        const sharedMlab =
          m.type === 'ndt7_upload' &&
          raw.type === 'ndt7_download' &&
          s.measurements.some(
            sibling =>
              sibling.type === 'ndt7_download' &&
              sibling.id === raw.measurementId &&
              sibling.raw?.request?.outputFile === name,
          );
        if (
          (raw.measurementId && raw.measurementId !== m.id && !sharedMlab) ||
          (raw.type && raw.type !== m.type && !sharedMlab)
        )
          throw new Error(
            'Mac command evidence belongs to a different measurement.',
          );
      }
    }
  const originalApp = JSON.parse(await readFile(appFile, 'utf8'));
  const run = JSON.parse(
    await readFile(path.join(macRoot, 'run.json'), 'utf8'),
  );
  const familyNames = Object.keys(FAMILIES);
  if (
    Object.values(sources).some(ss =>
      ss.some(s => s.measurements.some(m => familyOf(m.type) === 'other')),
    )
  )
    familyNames.push('other');
  const redactions = [],
    contents = new Map(),
    totals = {};
  const fingerprints = {
    app: { file: 'app-export.json', ...(await fingerprint(appFile)) },
    mac: {
      file: 'baseline.json',
      ...(await fingerprint(path.join(macRoot, 'baseline.json'))),
    },
    macManifest: await fingerprint(path.join(macRoot, 'manifest.json')),
  };
  for (const [source, sessions] of Object.entries(sources)) {
    totals[source] = sessions.reduce((n, s) => n + s.measurements.length, 0);
    for (const family of familyNames) {
      const filename = `${family}_${source}.json`,
        measurements = [],
        origins = [],
        linked = [];
      const commandOutputs = {};
      for (const s of sessions) {
        const selected = s.measurements.filter(
          m => familyOf(m.type) === family,
        );
        if (selected.length)
          linked.push({ session: s.session, snapshots: s.snapshots ?? [] });
        for (const m of selected) {
          measurements.push(m);
          origins.push({ measurementId: m.id, sessionId: s.session.id });
          const name = m.raw?.request?.outputFile;
          if (source === 'mac' && name != null)
            Object.defineProperty(commandOutputs, name, {
              value: commands.get(name),
              enumerable: true,
              configurable: true,
              writable: true,
            });
        }
      }
      const payload = {
        schemaVersion: 1,
        source,
        test: family,
        metadata: {
          sourceFingerprint: fingerprints[source],
          collectionInterval: interval(sessions),
          provenance:
            source === 'mac'
              ? {
                  platform: run.environment?.platform ?? null,
                  collectorVersion: run.config?.collectorVersion ?? null,
                  validationMode: run.config?.validationMode ?? null,
                  toolVersions: run.environment?.versions ?? {},
                }
              : {
                  sourceScope:
                    originalApp.sourceScope ??
                    'Stored app export; unrelated events/account/flight metadata excluded from this bundle',
                },
          sessions: linked,
          origins,
          measurementCount: measurements.length,
          libraries: [
            ...new Map(
              measurements.map(m => [
                JSON.stringify([
                  m.raw?.library ?? m.route?.library,
                  m.raw?.version ?? m.route?.version,
                ]),
                {
                  library: m.raw?.library ?? m.route?.library ?? null,
                  version: m.raw?.version ?? m.route?.version ?? null,
                },
              ]),
            ).values(),
          ],
          coverage: {
            measurementsWithoutRaw: measurements.filter(m => !m.raw).length,
            macMeasurementsWithoutCommandReference:
              source === 'mac'
                ? measurements.filter(m => !m.raw?.request?.outputFile).length
                : null,
            truncatedCommandStreams: Object.values(commandOutputs)
              .flatMap(r => r.runs)
              .filter(
                r =>
                  r.outputCapture?.stdoutTruncated ||
                  r.outputCapture?.stderrTruncated,
              ).length,
            measurementsWithDroppedCallbacks: measurements.filter(
              m =>
                (m.raw?.droppedCallbacks ?? 0) > 0 ||
                m.details?.samples?.some(
                  s => (s.raw?.droppedCallbacks ?? 0) > 0,
                ),
            ).length,
          },
          limitations: [
            'No complete wire packet capture; preserve the packet fields actually returned.',
            'HTTP response headers are allowlisted, not complete raw header blocks.',
            'All recorded outcomes retained; repeat counts are not accuracy validation.',
          ],
        },
        measurements,
        commandOutputs,
      };
      contents.set(
        filename,
        sanitizeEvidence(payload, redactions, `/${filename}`),
      );
    }
  }
  const repetitions = sanitizeEvidence(
    repetitionReport(sources, minimumRepeats),
    redactions,
    '/repetitions.json',
  );
  contents.set('repetitions.json', repetitions);
  contents.set(
    'README.md',
    readingGuide(repetitions, totals, [...contents.keys()], redactions.length),
  );
  contents.set('redactions.json', {
    schemaVersion: 1,
    policy:
      'Omit unrelated identity/flight fields; mask authentication secrets. Keep technical network evidence. Original sources remain private and unchanged.',
    entries: redactions,
  });
  await createPrivateDirectory(output);
  for (const [name, value] of contents) await writePrivate(output, name, value);
  const manifest = await sealEvidence(output, {
    kind: 'supervisor-test-evidence',
    schemaVersion: 1,
    minimumRepeats,
    sources: fingerprints,
    sourceMacEvidenceFilesVerified: integrity.files,
    measurementCounts: totals,
  });
  const verification = await verifyEvidence(output);
  if (!verification.ok)
    throw new Error('Generated bundle failed integrity verification.');
  const zipFiles = {};
  for (const name of [...contents.keys(), 'manifest.json'])
    zipFiles[name] = [
      new Uint8Array(await readFile(path.join(output, name))),
      { mtime: new Date('2000-01-01T00:00:00Z') },
    ];
  await writeFile(archive, zipSync(zipFiles, { level: 6 }), {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    directory: output,
    archive,
    files: manifest.files.length + 1,
    measurements: totals,
    redactions: redactions.length,
    repetitions,
  };
}

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      mac: { type: 'string' },
      out: { type: 'string' },
      'minimum-repeats': { type: 'string', default: '15' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.app || !values.mac || !values.out) {
    console.log(
      'Usage: npm run baseline:package -- --app TRIP_OR_SESSION.json --mac SEALED_RUN_DIRECTORY --out NEW_DIRECTORY [--minimum-repeats 15]',
    );
    if (!values.help) process.exitCode = 1;
    return;
  }
  const result = await packageEvidence({
    app: values.app,
    mac: values.mac,
    out: values.out,
    minimumRepeats: Number(values['minimum-repeats']),
  });
  console.log(
    JSON.stringify(
      { ...result, repetitions: `${result.directory}/repetitions.json` },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(error => {
    console.error(`Could not package evidence: ${error.message}`);
    process.exitCode = 1;
  });
