type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(object) : [];

// Prefix spreadsheet formula characters, then apply RFC 4180 quoting.
export function csvCell(value: unknown): string {
  let text =
    value == null
      ? ''
      : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  if (typeof value === 'string' && /^[=+@\-\t\r\n]/.test(text))
    text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function csv(columns: string[], records: Row[]): string {
  return (
    [
      columns.map(csvCell).join(','),
      ...records.map(row => columns.map(key => csvCell(row[key])).join(',')),
    ].join('\r\n') + '\r\n'
  );
}
const contextColumns = [
  'networkSnapshotId',
  'networkType',
  'isConnected',
  'isInternetReachable',
  'ssid',
  'bssid',
  'signalStrength',
  'batteryPercent',
  'isCharging',
  'publicIp',
  'asn',
];
function context(value: unknown): Row {
  const n = object(value);
  return { ...n, networkSnapshotId: n.id, networkType: n.type };
}
function pingOutput(raw: Row): Row {
  const callbacks = rows(raw.callbacks);
  const value = object(callbacks[callbacks.length - 1]?.value);
  return {
    nativeStatus: value.status,
    nativeRttMs: value.rtt,
    nativeReplyTtl: value.ttl,
    rawStdout: value.rawStdout,
    rawStderr: value.rawStderr,
  };
}
const measurementColumns = [
  'id',
  'sessionId',
  'type',
  'method',
  'targetHost',
  'scheduledAt',
  'timestamp',
  'state',
  'success',
  'value',
  'unit',
  'durationMs',
  'requestedBytes',
  'transferredBytes',
  'httpStatus',
  'errorType',
  'errorMessage',
  'probeServer',
  'probeRegion',
  'ttl',
  'library',
  'libraryVersion',
  'rawSource',
  'sampleCount',
  'replyCount',
  'medianMs',
  'p95Ms',
  'successiveDifferenceMs',
  'nonResponsePercent',
  'lossPercent',
  'sentCount',
  'duplicateCount',
  'reorderedCount',
  'targetPort',
  'routeReached',
  'reachedHop',
  'routeStopReason',
  'loadTransferredBytes',
  'loadMbps',
  ...contextColumns,
  'networkSnapshot',
  'details',
  'reference',
  'route',
  'speedchecker',
  'raw',
  'rawRecordJson',
];
export function measurementCsv(records: Row[]): string {
  return csv(
    measurementColumns,
    records.map(m => {
      const d = object(m.details),
        summary = object(d.summary),
        route = object(m.route),
        load = object(d.load);
      const raw = object(m.raw);
      return {
        ...context(m.networkSnapshot),
        ...m,
        library: raw.library ?? route.library,
        libraryVersion: raw.version ?? route.version,
        rawSource: raw.source,
        sampleCount: Array.isArray(d.samples)
          ? d.samples.length
          : Array.isArray(route.samples)
          ? route.samples.length
          : null,
        replyCount: summary.replies,
        medianMs: summary.medianMs,
        p95Ms: summary.p95Ms,
        successiveDifferenceMs: summary.successiveDifferenceMs,
        nonResponsePercent: d.nonResponsePercent,
        lossPercent: d.lossPercent,
        sentCount: d.sentCount,
        duplicateCount: d.duplicateCount,
        reorderedCount: d.reorderedCount,
        targetPort: d.targetPort,
        routeReached: route.reached,
        reachedHop: route.reachedHop,
        routeStopReason: route.stopReason,
        loadTransferredBytes: load.transferredBytes,
        loadMbps: load.value,
        rawRecordJson: m,
      };
    }),
  );
}
const sampleColumns = [
  'sessionId',
  'measurementId',
  'measurementType',
  'method',
  'sampleGroup',
  'sequence',
  'measurementScheduledAt',
  'measurementTimestamp',
  'sampleTimestamp',
  'observedAtMs',
  'targetHost',
  'targetPort',
  'hop',
  'probeTtl',
  'replyTtl',
  'responderAddress',
  'remote',
  'rttMs',
  'durationMs',
  'outcome',
  'errorType',
  'errorMessage',
  'icmpType',
  'icmpCode',
  'probeBytes',
  'overheadBytes',
  'library',
  'libraryVersion',
  'rawSource',
  'nativeVariant',
  'elapsedUsec',
  'errno',
  'errorInfo',
  'nativeStatus',
  'nativeRttMs',
  'nativeReplyTtl',
  'rawStdout',
  'rawStderr',
  'replyDataBase64',
  ...contextColumns,
  'rawSampleJson',
];
/** One row per recorded sample, including timeout/error outcomes. No invented packets. */
export function sampleCsv(records: Row[]): string {
  const samples: Row[] = [];
  for (const m of records) {
    const d = object(m.details),
      route = object(m.route),
      parentRaw = object(m.raw);
    for (const [group, values] of [
      ['probe', d.samples],
      ['baseline', d.baselineSamples],
      ['traceroute', route.samples],
    ] as const) {
      for (const s of rows(values)) {
        const raw = object(s.raw ?? m.raw),
          request = object(raw.request),
          native = object(s.rawResult);
        const trace = group === 'traceroute';
        samples.push({
          ...context(m.networkSnapshot),
          sessionId: m.sessionId,
          measurementId: m.id,
          measurementType: m.type,
          method: m.method,
          sampleGroup: group,
          sequence: s.sequence,
          measurementScheduledAt: m.scheduledAt,
          measurementTimestamp: m.timestamp,
          sampleTimestamp: s.timestamp,
          observedAtMs: s.observedAtMs,
          targetHost: m.targetHost,
          targetPort: d.targetPort,
          hop: s.hop,
          probeTtl: trace ? s.hop : request.ttl,
          replyTtl: trace ? native.ttl : s.ttl,
          responderAddress: s.address,
          remote: s.remote,
          rttMs: s.rttMs,
          durationMs: s.durationMs,
          outcome: trace
            ? s.kind
            : s.errorType ?? (s.rttMs != null ? 'reply' : 'unavailable'),
          errorType: s.errorType,
          errorMessage: s.errorMessage,
          icmpType: s.icmpType,
          icmpCode: s.icmpCode,
          probeBytes: s.probeBytes ?? request.packetSize,
          overheadBytes: s.overheadBytes,
          library: raw.library ?? parentRaw.library ?? route.library,
          libraryVersion: raw.version ?? parentRaw.version ?? route.version,
          rawSource: raw.source,
          nativeVariant: native.variant,
          elapsedUsec: native.elapsedUsec,
          errno: native.errNo,
          errorInfo: native.errInfo,
          ...pingOutput(raw),
          replyDataBase64: native.dataBase64,
          rawSampleJson: s,
        });
      }
    }
    // A standalone ICMP result is itself one probe; historical records remain exportable.
    if (m.type === 'icmp_rtt' && !rows(d.samples).length) {
      samples.push({
        ...context(m.networkSnapshot),
        sessionId: m.sessionId,
        measurementId: m.id,
        measurementType: m.type,
        method: m.method,
        sampleGroup: 'probe',
        sequence: 0,
        measurementScheduledAt: m.scheduledAt,
        measurementTimestamp: m.timestamp,
        sampleTimestamp: m.timestamp,
        targetHost: m.targetHost,
        replyTtl: m.ttl,
        rttMs: m.value,
        durationMs: m.durationMs,
        outcome: m.errorType ?? (m.success ? 'reply' : 'unavailable'),
        errorType: m.errorType,
        errorMessage: m.errorMessage,
        library: parentRaw.library,
        libraryVersion: parentRaw.version,
        rawSource: parentRaw.source,
        probeTtl: object(parentRaw.request).ttl,
        probeBytes: object(parentRaw.request).packetSize,
        ...pingOutput(parentRaw),
        rawSampleJson: m,
      });
    }
  }
  return csv(sampleColumns, samples);
}
export interface ExportFile {
  name: string;
  content: string;
}
export function sessionJson(data: Row): string {
  return JSON.stringify({ ...data, exportFormatVersion: 2 }, null, 2);
}
/** Raw JSON is authoritative; CSVs are convenient, explicitly versioned projections. */
export function sessionExportFiles(data: Row): ExportFile[] {
  const measurements = rows(data.measurements),
    session = object(data.session);
  return [
    {
      name: 'session.json',
      content: sessionJson(data),
    },
    { name: 'measurements.csv', content: measurementCsv(measurements) },
    { name: 'samples.csv', content: sampleCsv(measurements) },
    {
      name: 'events.csv',
      content: csv(
        ['sessionId', 'id', 'timestamp', 'kind', 'details', 'rawRecordJson'],
        rows(data.events).map(e => ({
          ...e,
          sessionId: session.id,
          rawRecordJson: e,
        })),
      ),
    },
    {
      name: 'network-context.csv',
      content: csv(
        [
          'sessionId',
          'timestamp',
          ...contextColumns,
          'contextError',
          'publicIpObservedAt',
          'rawRecordJson',
        ],
        rows(data.snapshots).map(n => ({
          ...context(n),
          sessionId: session.id,
          rawRecordJson: n,
        })),
      ),
    },
    {
      name: 'README.txt',
      content: `Capstone export format 2\n\nsession.json preserves the complete saved session, measurements, events and context.\nCSVs are derived views, not packet captures. rawRecordJson/rawSampleJson retain nested fields.\nRows include failures and timeouts; empty fields mean unavailable/not applicable, never zero.\nSample sequence is an application/library index, not necessarily the ICMP header sequence.\nprobeTtl (outgoing hop limit) and replyTtl (received TTL) are different.\nRTT is round-trip, not one-way or link-by-link latency. observedAtMs is native callback wall-clock time.\nRaw callbacks contain only fields the library supplied; absent ICMP codes are never inferred.\nLibrary versions are recorded at collection where available; old records are not relabeled.\nAndroid ping stdout/stderr are text output, not original packet bytes; line endings are normalized.\nCSV cells that could be spreadsheet formulas are prefixed with an apostrophe; JSON is unchanged.\nNetwork identity and IP addresses are retained as collected. Review before distributing research data.\n`,
    },
  ];
}
