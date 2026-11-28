/** Durable raw evidence, readable projections and explicit run status. */
import { appendFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { measurementOutcome } from '../../src/measurements/outcome.ts';
import { SUMMARY_SCHEMA, summarize } from './summary.mjs';
import { paperComparisons } from './compare.mjs';
import {
  createPrivateDirectory,
  csv,
  sealEvidence,
  writePrivate,
} from './evidence.mjs';

const require = createRequire(import.meta.url);
const number = v =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : 'unavailable';
const escape = v =>
  String(v ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');

export async function createOutput(directory, metadata) {
  await createPrivateDirectory(directory);
  const { runId, config, environment } = metadata;
  const all = [],
    controls = [],
    pauses = [],
    sessions = [];
  const createdAt = new Date().toISOString();
  let segment = null,
    pending = [],
    snapshot = null;
  // The control and worker lanes may both write. Serialise the entire mutation and checkpoint.
  let writes = Promise.resolve();
  const enqueue = fn => {
    const next = writes.then(fn);
    writes = next.catch(() => {});
    return next;
  };
  const journal = row =>
    appendFile(
      path.join(directory, 'journal.jsonl'),
      `${JSON.stringify(row)}\n`,
      { mode: 0o600 },
    );
  const id = () => randomBytes(16).toString('hex');
  const event = (kind, details) => ({
    id: id(),
    timestamp: new Date().toISOString(),
    kind,
    details,
  });
  const attachSnapshot = () => {
    if (
      segment &&
      snapshot &&
      !segment.snapshots.some(s => s.id === snapshot.id)
    )
      segment.snapshots.push(snapshot);
  };
  const checkpoint = async () => {
    if (segment) await writePrivate(directory, 'active-segment.json', segment);
    else if (pending.length)
      await writePrivate(directory, 'trailing-events.json', pending);
  };
  const runState = async (status, extra = {}) =>
    writePrivate(directory, 'run.json', {
      schema: 'skymeasure-baseline-run-2',
      ...metadata,
      status,
      createdAt,
      ...extra,
    });
  await runState('recording');

  async function close(reason) {
    if (!segment) return;
    const at = new Date().toISOString();
    segment.session.state =
      reason === 'baseline_error' ? 'interrupted' : 'completed';
    segment.session.endedAt = segment.session.lastObservedAt = at;
    segment.session.measurementCount = segment.measurements.length;
    const row = event('session_ended', { reason });
    segment.events.push(row);
    await journal({ event: row, sessionId: segment.session.id });
    const name = `segment-${String(
      segment.session.config.segmentIndex,
    ).padStart(3, '0')}.json`;
    await writePrivate(directory, name, segment);
    await journal({ segmentClosed: segment.session, file: name, reason });
    sessions.push(segment);
    segment = null;
    await rm(path.join(directory, 'active-segment.json'), { force: true });
    await writePrivate(directory, 'control.json', {
      runId,
      note: 'Extra router and lab-server probes; the app does not run these.',
      measurements: controls,
    });
  }

  return {
    newId: id,
    all,
    controls,
    get snapshot() {
      return snapshot;
    },
    get sessionId() {
      return segment?.session.id;
    },
    setContext: value =>
      enqueue(async () => {
        snapshot = {
          id: id(),
          timestamp: new Date().toISOString(),
          type: environment.wifi ? 'wifi' : 'other',
          isConnected: true,
          ssid: null,
          bssid: null,
          publicIp: value.publicIp ?? null,
          asn: value.asn ?? null,
          publicIpObservedAt: new Date().toISOString(),
          batteryPercent: null,
          isCharging: null,
          isInternetReachable: true,
          popCode: value.popCode ?? null,
          reverseDns: value.reverseDns ?? null,
        };
        attachSnapshot();
        await journal({ snapshot, sessionId: segment?.session.id ?? null });
        await checkpoint();
      }),
    openSegment: index =>
      enqueue(async () => {
        if (segment) throw new Error('Cannot open a second active segment');
        const at = new Date().toISOString();
        segment = {
          schemaVersion: 3,
          session: {
            id: id(),
            state: 'active',
            startedAt: at,
            endedAt: null,
            lastObservedAt: at,
            resumedFromId: null,
            config: { ...config, segmentIndex: index },
            measurementCount: 0,
          },
          measurements: [],
          events: pending,
          snapshots: [],
        };
        pending = [];
        attachSnapshot();
        await journal({ segmentOpened: segment.session });
        await rm(path.join(directory, 'trailing-events.json'), { force: true });
        await checkpoint();
      }),
    event: (kind, details) =>
      enqueue(async () => {
        const row = event(kind, details);
        if (kind === 'upload_pause') pauses.push(details);
        (segment ? segment.events : pending).push(row);
        await journal({ event: row, sessionId: segment?.session.id ?? null });
        await checkpoint();
      }),
    save: (measurement, isControl) =>
      enqueue(async () => {
        if (isControl) controls.push(measurement);
        else {
          if (!segment)
            throw new Error(
              'Cannot save a measurement without an active segment',
            );
          all.push(measurement);
          segment.measurements.push(measurement);
          segment.session.measurementCount = segment.measurements.length;
          segment.session.lastObservedAt = new Date().toISOString();
          attachSnapshot();
        }
        await journal({ measurement, control: isControl });
        if (isControl)
          await writePrivate(directory, 'control.json', {
            runId,
            measurements: controls,
          });
        await checkpoint();
      }),
    saveRaw: (measurementId, type, runs) =>
      enqueue(async () => {
        if (!/^[a-f0-9]{32}$/.test(measurementId))
          throw new Error('Invalid raw measurement identifier');
        const file = `raw/${measurementId}.json`;
        await writePrivate(directory, file, { measurementId, type, runs });
        return file;
      }),
    closeSegment: reason => enqueue(() => close(reason)),
    finish: (trip, { error = null, helpers = [] } = {}) =>
      enqueue(async () => {
        await close(error ? 'baseline_error' : trip.reason);
        if (pending.length)
          await writePrivate(directory, 'trailing-events.json', pending);
        const summary = {
          schema: SUMMARY_SCHEMA,
          source: 'baseline',
          runId,
          startedAt: new Date(trip.startedAt).toISOString(),
          endedAt: new Date(trip.endedAt ?? Date.now()).toISOString(),
          reason: error ? 'baseline_error' : trip.reason,
          status: error
            ? 'error'
            : trip.reason === 'operator_stop'
            ? 'stopped'
            : 'complete',
          segments: sessions.length,
          uploadPauses: pauses.length,
          transferPairs: trip.transferPairs ?? 0,
          validationMode:
            trip.validationMode ??
            config.validationMode ??
            'standalone_full_suite',
          mlab: trip.mlab?.status ?? 'not_requested',
          config,
          environment,
          measurements: all.length,
          failures: all.filter(m => measurementOutcome(m) === 'failure').length,
          interrupted: all.filter(m => measurementOutcome(m) === 'interrupted')
            .length,
          protocols: summarize(all),
          controls: summarize(controls),
          paper: paperComparisons(all),
        };
        await writePrivate(directory, 'baseline.json', {
          schema: 'skymeasure-baseline-run-2',
          runId,
          source: 'baseline',
          sessions,
        });
        await writePrivate(directory, 'summary.json', summary);
        const { analyze } = require('../measurements/analyze.cjs');
        const {
          catalog,
          dictionaryMarkdown,
        } = require('../measurements/dictionary.cjs');
        const audits = [],
          views = {};
        for (const [index, session] of sessions.entries()) {
          const result = analyze(session);
          audits.push({
            segmentFile: `segment-${String(
              session.session.config.segmentIndex,
            ).padStart(3, '0')}.json`,
            ...result.audit,
          });
          for (const [name, rows] of Object.entries(result.views))
            (views[name] ??= []).push(
              ...rows.map(row => ({
                ...row,
                recordPath: row.recordPath
                  ? `/sessions/${index}${row.recordPath}`
                  : null,
              })),
            );
        }
        for (const [name, rows] of Object.entries(views))
          await writePrivate(
            directory,
            `analysis/${name}`,
            csv(catalog.files[name].columns, rows),
          );
        await writePrivate(
          directory,
          'analysis/records.csv',
          csv(
            [
              'sessionId',
              'measurementId',
              'measurementType',
              'recordPath',
              'segmentFile',
              'rawFile',
              'library',
              'libraryVersion',
              'scheduledAt',
              'startedAt',
              'callbackAt',
              'outcome',
            ],
            sessions.flatMap((session, index) =>
              session.measurements.map((m, position) => ({
                sessionId: session.session.id,
                measurementId: m.id,
                measurementType: m.type,
                recordPath: `/sessions/${index}/measurements/${position}`,
                segmentFile: `segment-${String(
                  session.session.config.segmentIndex,
                ).padStart(3, '0')}.json`,
                rawFile: m.raw?.request?.outputFile ?? null,
                library: m.raw?.library ?? null,
                libraryVersion: m.raw?.version ?? null,
                scheduledAt: m.scheduling?.scheduledAt ?? null,
                startedAt: m.scheduling?.startedAt ?? m.timestamp ?? null,
                callbackAt: m.scheduling?.callbackAt ?? null,
                outcome: measurementOutcome(m),
              })),
            ),
          ),
        );
        const totals = { error: 0, warning: 0, unavailable: 0 };
        for (const audit of audits)
          for (const key of Object.keys(totals))
            totals[key] += audit.totals[key];
        await writePrivate(directory, 'analysis/sanity-checks.json', {
          schema: 'skymeasure-baseline-audits-1',
          totals,
          segments: audits,
        });
        await writePrivate(
          directory,
          'analysis/column-dictionary.md',
          dictionaryMarkdown() +
            '\n## Baseline run scope\n\nIn these aggregated CSVs, recordPath is a JSON pointer into baseline.json, including its /sessions/<index> prefix. Audit pointers remain relative to their named segment JSON. records.csv has one parent measurement per row: IDs identify original records; recordPath locates the parent in baseline.json; segmentFile/rawFile name files relative to the run directory; library/libraryVersion preserve provenance; scheduledAt/startedAt/callbackAt are ISO UTC strings; outcome uses the shared success/failure/interrupted/unavailable classification. Missing fields remain blank.\n',
        );
        const stats = summary.protocols
          .map(
            s =>
              `| ${escape(s.type)} | ${s.attempts} | ${s.successful} | ${
                s.failed
              } | ${s.interrupted} | ${number(
                s.medianMs ?? s.medianValue,
              )} ${escape(s.unit)} | ${number(s.lossPercent)} |`,
          )
          .join('\n');
        const targets = summary.paper
          .map(
            s =>
              `| ${escape(s.type)} | ${escape(s.targetId)} | ${s.successful}/${
                s.attempts
              } | ${number(s.medianPhasesMs.totalMs)} |`,
          )
          .join('\n');
        await writePrivate(
          directory,
          'report.md',
          `# Terminal validation run

Run: ${runId}. Status: **${summary.status}** (${summary.reason}).

${summary.startedAt} to ${summary.endedAt}, in UTC. Mode: **${summary.validationMode}**.

These are reference-computer observations, not flight validation or proof of phone accuracy. Upload pauses are simulated; ASN admission, battery management and phone background behaviour are not exercised.

${summary.validationMode === 'paired_full_shared_load'
  ? 'Full paired suite: both devices share the connection. Concurrent M-Lab, CDN and other traffic can change timings and throughput. Jobs remain serialized on this computer. Compare actual intervals and report known heavy-test overlaps; these results are not independent capacity measurements.'
  : ''}

## Measurements

${all.length} measurements in ${sessions.length} segments. Failure counts exclude interruptions.

| Measurement | Attempts | Successful | Failed | Interrupted | Median | Recorded-probe loss % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${stats}

Different CDN providers and traceroute targets must be compared separately; the generic scalar median is not a pooled CDN result.

| Paper test | Target | Successful | Median total ms |
| --- | --- | ---: | ---: |
${targets}

## Sanity checks

Errors: **${totals.error}**; warnings: **${totals.warning}**; unavailable checks: **${totals.unavailable}**. See [all findings](analysis/sanity-checks.json) and [column definitions](analysis/column-dictionary.md). These checks do not establish measurement accuracy.

## Files

- [Run settings and provenance](run.json), [machine summary](summary.json), [complete session evidence](baseline.json).
- \`segment-NNN.json\`: closed segments. \`active-segment.json\` exists only while a segment is open; a crash preserves its last atomic checkpoint.
- \`raw/<measurement-id>.json\`: exact command arguments, stdout, stderr and process outcomes; measurement raw.request.outputFile links here. NDT7's two directions share one command record.
- \`journal.jsonl\`: append-only measurements, events, context and segment lifecycle records.
- \`analysis/*.csv\`: per-protocol rows for all segments, with parent IDs preserved. CSV blanks mean unavailable, not zero; raw evidence remains authoritative.
- [Record index](analysis/records.csv): connects each measurement ID to its segment, raw command file and JSON pointer in baseline.json.
- [Integrity manifest](manifest.json): sizes and SHA-256 hashes, including a packet capture if one was requested. A missing manifest means finalisation did not finish.

Keep this entire folder private: JSON, CSV and packet captures can contain IP addresses and network identifiers. A local tcpdump capture observes this computer, not the phone; use a controlled gateway to inspect the phone's packets.
`,
        );
        await runState(summary.status, {
          finishedAt: new Date().toISOString(),
          reason: summary.reason,
          error: error ? String(error.message) : null,
          helpers,
          sanity: totals,
        });
        await sealEvidence(directory, {
          kind: 'baseline',
          runId,
          status: summary.status,
        });
        return summary;
      }),
  };
}
