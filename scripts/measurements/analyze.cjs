/* Offline, additive views. Reuse the phone serializer to preserve legacy semantics. */
const {
  sessionExportFiles,
  csvCell,
} = require('../../src/export/serialize.ts');
const { catalog, dictionaryMarkdown } = require('./dictionary.cjs');
const fs = require('node:fs');
const path = require('node:path');

function parseCsv(text) {
  const records = [];
  let record = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && c === ',') {
      record.push(cell);
      cell = '';
    } else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('Unterminated CSV quote.');
  if (cell || record.length) {
    record.push(cell);
    records.push(record);
  }
  const headers = records.shift() ?? [];
  return {
    headers,
    rows: records.map(values => {
      if (values.length !== headers.length)
        throw new Error('CSV row/header length mismatch.');
      return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    }),
  };
}
const present = v => v !== null && v !== undefined;
const validNumber = v => typeof v === 'number' && Number.isFinite(v);
const rttValid = v => validNumber(v) && v >= 0;
const list = v => (Array.isArray(v) ? v : []);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function typedRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      const type = catalog.fields[k]?.datatype;
      if (v === '') return [k, null];
      if (type === 'JSON object') return [k, JSON.parse(v)];
      if (type === 'number' || type === 'integer') return [k, Number(v)];
      if (type === 'boolean') return [k, v === 'true'];
      // Undo only the exporter's formula protection, not arbitrary apostrophes.
      return [k, v.replace(/^'(?=[=+@\-\t\r\n])/, '')];
    }),
  );
}
function summary(samples) {
  const values = samples
    .map(s => s.rttMs)
    .filter(rttValid)
    .sort((a, b) => a - b);
  const differences = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i];
    if (rttValid(a.rttMs) && rttValid(b.rttMs) && b.sequence === a.sequence + 1)
      differences.push(Math.abs(b.rttMs - a.rttMs));
  }
  const n = values.length;
  return {
    replies: n,
    medianMs: n
      ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2
      : null,
    p95Ms: n ? values[Math.ceil(0.95 * n) - 1] : null,
    successiveDifferenceMs: differences.length
      ? differences.reduce((a, b) => a + b, 0) / differences.length
      : null,
  };
}
function analyze(data) {
  if (
    !object(data) ||
    !object(data.session) ||
    typeof data.session.id !== 'string' ||
    !data.session.id ||
    !['measurements', 'events', 'snapshots'].every(k => Array.isArray(data[k]))
  )
    throw new Error(
      'Expected a complete session JSON with session.id, measurements, events and snapshots.',
    );
  const issues = [],
    checks = {};
  function note(severity, code, recordPath, message) {
    issues.push({ severity, code, recordPath, message });
  }
  function check(code, condition, recordPath, message, severity = 'error') {
    const c = (checks[code] ??= { checked: 0, passed: 0 });
    c.checked++;
    if (condition) c.passed++;
    else note(severity, code, recordPath, message);
  }
  function approx(code, actual, expected, at) {
    if (!present(actual) && !present(expected)) return;
    check(
      code,
      validNumber(actual) &&
        validNumber(expected) &&
        Math.abs(actual - expected) <=
          Math.max(1e-6, Math.abs(expected) * 1e-6),
      at,
      'Recorded value differs from the documented recomputation (relative tolerance 1e-6).',
    );
  }
  const ids = new Set(),
    snapshots = new Set();
  for (const [i, n] of data.snapshots.entries()) {
    if (!object(n)) throw new Error('Context entries must be objects.');
    check(
      'snapshot_id',
      typeof n.id === 'string' && n.id.length > 0 && !snapshots.has(n.id),
      `/snapshots/${i}`,
      'Missing or duplicate context ID.',
    );
    snapshots.add(n.id);
  }
  const eventIds = new Set();
  for (const [i, e] of data.events.entries()) {
    if (!object(e)) throw new Error('Event entries must be objects.');
    check(
      'event_id',
      typeof e.id === 'string' && e.id.length > 0 && !eventIds.has(e.id),
      `/events/${i}`,
      'Missing or duplicate event ID.',
    );
    eventIds.add(e.id);
  }
  // Validate saved types before CSV stringification can conceal string/number mistakes.
  const numeric = new Set([
    'rttMs',
    'durationMs',
    'value',
    'requestedBytes',
    'transferredBytes',
    'replyCount',
    'replies',
    'requestedCount',
    'sentCount',
    'duplicateCount',
    'reorderedCount',
    'nonResponsePercent',
    'lossPercent',
    'medianMs',
    'p95Ms',
    'successiveDifferenceMs',
    'sequence',
    'hop',
    'probeTtl',
    'replyTtl',
    'payloadBytes',
    'sentSocketBytes',
    'receivedSocketBytes',
    'icmpType',
    'icmpCode',
    'icmpIdentifier',
    'icmpSequence',
    'icmpChecksum',
    'targetPort',
    'batteryPercent',
    'signalStrength',
  ]);
  const booleans = new Set([
    'success',
    'complete',
    'reached',
    'isConnected',
    'isInternetReachable',
    'isCharging',
  ]);
  function walk(value, at) {
    if (!object(value) && !Array.isArray(value)) return;
    for (const [k, v] of Object.entries(value)) {
      const p = `${at}/${k}`;
      if (present(v)) {
        // raw callbacks retain provider-specific sentinels, so apply typed checks to normalized records only.
        if (numeric.has(k))
          check('numeric_type', validNumber(v), p, 'Expected a finite number.');
        if (booleans.has(k))
          check(
            'boolean_type',
            typeof v === 'boolean',
            p,
            'Expected a boolean.',
          );
        if (
          /^(send|receive|started)MonotonicNs$|^kernelReceiveRealtimeNs$/.test(
            k,
          )
        )
          check(
            'nanosecond_string',
            typeof v === 'string' && /^\d+$/.test(v),
            p,
            'Nanoseconds must remain decimal strings, never JS numbers.',
          );
        if (
          [
            'timestamp',
            'scheduledAt',
            'startedAt',
            'endedAt',
            'publicIpObservedAt',
          ].includes(k)
        )
          check(
            'timestamp',
            typeof v === 'string' &&
              /^\d{4}-\d\d-\d\dT/.test(v) &&
              Number.isFinite(Date.parse(v)),
            p,
            'Expected an ISO wall-clock timestamp.',
          );
        if (
          [
            'nonResponsePercent',
            'lossPercent',
            'batteryPercent',
            'signalStrength',
          ].includes(k)
        )
          check(
            'percentage_range',
            validNumber(v) && v >= 0 && v <= 100,
            p,
            'Expected a value in [0,100].',
          );
        if (
          [
            'rttMs',
            'durationMs',
            'requestedBytes',
            'transferredBytes',
            'sequence',
            'hop',
            'sentCount',
            'requestedCount',
          ].includes(k)
        )
          check(
            'nonnegative',
            validNumber(v) && v >= 0,
            p,
            'Expected a nonnegative value.',
          );
        if (
          [
            'sequence',
            'hop',
            'sentCount',
            'requestedCount',
            'requestedBytes',
            'transferredBytes',
            'payloadBytes',
            'icmpType',
            'icmpCode',
            'icmpIdentifier',
            'icmpSequence',
            'icmpChecksum',
          ].includes(k)
        )
          check(
            'integer_type',
            Number.isSafeInteger(v),
            p,
            'Expected a safe integer.',
          );
        if (['icmpType', 'icmpCode'].includes(k))
          check(
            'icmp_byte_range',
            Number.isInteger(v) && v >= 0 && v <= 255,
            p,
            'ICMP type/code must fit one byte.',
          );
        if (['icmpIdentifier', 'icmpSequence', 'icmpChecksum'].includes(k))
          check(
            'icmp_word_range',
            Number.isInteger(v) && v >= 0 && v <= 65535,
            p,
            'ICMP echo header value must fit uint16.',
          );
      }
      if (
        ![
          'raw',
          'rawResult',
          'libraryResult',
          'tcpInfoBefore',
          'tcpInfoAfter',
          'ancillary',
        ].includes(k)
      )
        walk(v, p);
    }
  }
  walk(data, '');
  const groups = {};
  function inspectPacket(p, at) {
    if (!object(p)) return;
    const r = p.response ?? {};
    for (const key of ['tcpInfoBefore', 'tcpInfoAfter']) {
      const info = p[key];
      if (!object(info)) continue;
      for (const [field, value] of Object.entries(info))
        if (field.startsWith('tcpi_'))
          check(
            'tcp_info_integer',
            Number.isSafeInteger(value) && value >= 0 && value <= 4294967295,
            at + '/' + key + '/' + field,
            'Expected an unsigned kernel integer.',
          );
    }
    if (r.extendedError && [2, 3].includes(r.extendedError.origin)) {
      for (const [flat, original] of [
        ['icmpType', 'type'],
        ['icmpCode', 'code'],
      ])
        if (present(r[flat]))
          check(
            'error_queue_icmp',
            r[flat] === r.extendedError[original],
            at + '/response/' + flat,
            'ICMP field differs from original error-queue value.',
          );
    }
    for (const [hex, count, loc, truncated] of [
      [p.sendBufferHex, p.sentSocketBytes, at + '/sendBufferHex', false],
      [
        r.receivedHex,
        r.receivedSocketBytes,
        at + '/response/receivedHex',
        r.dataTruncated,
      ],
    ]) {
      if (present(hex)) {
        const valid =
          typeof hex === 'string' && /^(?:[0-9a-fA-F]{2})*$/.test(hex);
        check(
          'hex_encoding',
          valid,
          loc,
          'Expected complete hexadecimal byte pairs.',
        );
        if (valid && present(count) && !truncated)
          check(
            'buffer_length',
            hex.length / 2 === count,
            loc,
            'Retained buffer length differs from socket byte count.',
          );
      }
    }
    if (r.dataTruncated || r.controlTruncated || p.droppedObservations > 0)
      note(
        'warning',
        'truncated_observations',
        at,
        'Some native data or observations were truncated/dropped.',
      );
    if (
      typeof p.sendMonotonicNs === 'string' &&
      /^\d+$/.test(p.sendMonotonicNs) &&
      typeof r.receiveMonotonicNs === 'string' &&
      /^\d+$/.test(r.receiveMonotonicNs)
    ) {
      check(
        'monotonic_order',
        BigInt(r.receiveMonotonicNs) >= BigInt(p.sendMonotonicNs),
        at,
        'Receive precedes send within monotonic clock domain.',
      );
      if (present(r.elapsedUs)) {
        const us =
          Number(BigInt(r.receiveMonotonicNs) - BigInt(p.sendMonotonicNs)) /
          1000;
        check(
          'monotonic_elapsed',
          Math.abs(us - r.elapsedUs) <= 2,
          at,
          'Elapsed microseconds disagree with monotonic timestamps beyond truncation tolerance.',
        );
      }
    } else
      note(
        'unavailable',
        'monotonic_elapsed',
        at,
        'No compatible monotonic send/receive pair; realtime and monotonic clocks are never subtracted.',
      );
    if (p.engine === 'icmpenguin' && r.responderAddress)
      note(
        'warning',
        'historical_target_alias',
        at,
        'Historical ICMP library responderAddress repeats configured remote; focused responder is blank because actual source was not exposed.',
      );
    if (
      typeof r.receivedHex === 'string' &&
      ['icmp_message', 'icmp_message_from_library'].includes(r.receivedScope) &&
      /^(?:[0-9a-fA-F]{2}){8,}$/.test(r.receivedHex)
    ) {
      const b = Buffer.from(r.receivedHex, 'hex');
      for (const [key, expected] of [
        ['icmpType', b[0]],
        ['icmpCode', b[1]],
        ['icmpChecksum', b.readUInt16BE(2)],
      ])
        if (present(r[key]))
          check(
            'icmp_header',
            r[key] === expected,
            at + '/response/' + key,
            'Decoded header field differs from retained bytes.',
          );
      if ([0, 8, 128, 129].includes(b[0])) {
        for (const [key, offset] of [
          ['icmpIdentifier', 4],
          ['icmpSequence', 6],
        ])
          if (present(r[key]))
            check(
              'icmp_header',
              r[key] === b.readUInt16BE(offset),
              at + '/response/' + key,
              'Echo header field differs from retained bytes.',
            );
      }
    }
    const encoded = p.libraryResult?.dataBase64;
    if (typeof encoded === 'string' && typeof r.receivedHex === 'string')
      check(
        'library_bytes',
        Buffer.from(encoded, 'base64').toString('hex') ===
          r.receivedHex.toLowerCase(),
        at,
        'Library base64 bytes differ from retained decoded message.',
      );
  }
  for (const [i, m] of data.measurements.entries()) {
    if (!object(m)) throw new Error('Measurement entries must be objects.');
    const at = `/measurements/${i}`;
    check(
      'measurement_id',
      typeof m.id === 'string' && m.id.length > 0 && !ids.has(m.id),
      at,
      'Missing or duplicate measurement ID.',
    );
    ids.add(m.id);
    check(
      'session_join',
      m.sessionId === data.session.id,
      at,
      'Measurement belongs to a different/missing session.',
    );
    if (m.networkSnapshot?.id)
      check(
        'context_join',
        snapshots.has(m.networkSnapshot.id),
        at,
        'Associated context ID has no snapshot row.',
        'warning',
      );
    if (typeof m.type !== 'string' || !m.type)
      note('error', 'measurement_type', at, 'Measurement type is required.');
    const g = (groups[m.type] ??= {
      attempts: 0,
      successful: 0,
      probes: 0,
      replies: 0,
      methods: [],
      providers: [],
      unavailableDeclarations: [],
    });
    g.attempts++;
    g.successful += Number(m.success === true);
    if (m.method && !g.methods.includes(m.method)) g.methods.push(m.method);
    const d = m.details ?? {};
    const samples = list(d.samples).concat(list(m.route?.samples));
    if (
      samples.some(s => !object(s)) ||
      list(d.baselineSamples).some(s => !object(s))
    )
      throw new Error('Samples must be objects.');
    if (m.route && !Array.isArray(m.route.samples))
      throw new Error('Traceroute samples must be an array.');
    if (
      ![
        'icmp_rtt',
        'icmp_burst',
        'tcp_connect',
        'traceroute',
        'udp_echo',
        'http_rtt',
        'download',
        'upload',
        'loaded_download',
        'loaded_upload',
      ].includes(m.type)
    )
      note(
        'unavailable',
        'focused_view',
        at,
        'This measurement type has no focused projection; consult the original export.',
      );
    g.probes += samples.length;
    g.replies += samples.filter(s => rttValid(s.rttMs)).length;
    for (const { raw, rawPath } of [
      { raw: m.raw, rawPath: at + '/raw' },
      ...list(d.samples).map((s, j) => ({
        raw: s.raw,
        rawPath: at + '/details/samples/' + j + '/raw',
      })),
      ...list(m.route?.samples).map((s, j) => ({
        raw: s.raw,
        rawPath: at + '/route/samples/' + j + '/raw',
      })),
    ]) {
      if (!raw) continue;
      const provider = `${raw.library ?? 'unrecorded'}@${
        raw.version ?? 'unrecorded'
      }`;
      if (!g.providers.includes(provider)) g.providers.push(provider);
      for (const f of list(raw.unavailable))
        if (!g.unavailableDeclarations.includes(f))
          g.unavailableDeclarations.push(f);
      for (const [callbackIndex, callback] of list(raw.callbacks).entries()) {
        const v = callback.value;
        if (!object(v) || !present(v.payloadBase64)) continue;
        const valid =
          typeof v.payloadBase64 === 'string' &&
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            v.payloadBase64,
          );
        check(
          'callback_base64',
          valid,
          rawPath + '/callbacks/' + callbackIndex,
          'Invalid base64 payload encoding.',
        );
        if (valid && present(v.payloadBytes) && !v.payloadTruncated)
          check(
            'callback_payload_length',
            Buffer.from(v.payloadBase64, 'base64').length === v.payloadBytes,
            at,
            'Library callback payload length differs from retained bytes.',
          );
        if (v.payloadTruncated)
          note(
            'warning',
            'truncated_callback_payload',
            at,
            'Library callback retained only a prefix of this datagram.',
          );
      }
      if (raw.droppedCallbacks > 0)
        note(
          'warning',
          'dropped_callbacks',
          at,
          'Library callback log reports dropped callbacks.',
        );
    }
    for (const [key, aggregate] of [
      ['samples', 'summary'],
      ['baselineSamples', 'baselineSummary'],
    ]) {
      if (present(d[key]) && !Array.isArray(d[key]))
        throw new Error(`${at}/details/${key} must be an array.`);
      const ss = list(d[key]);
      const seen = new Set();
      for (const [j, s] of ss.entries()) {
        if (!object(s)) throw new Error('Samples must be objects.');
        check(
          'sample_identity',
          Number.isSafeInteger(s.sequence) && !seen.has(s.sequence),
          `${at}/details/${key}/${j}`,
          'Missing/duplicate sequence within the sample group.',
        );
        seen.add(s.sequence);
        if (s.measurementId)
          check(
            'sample_join',
            s.measurementId === m.id,
            at,
            'Explicit sample parent does not match containing measurement.',
          );
        if (rttValid(s.rttMs))
          check(
            'sample_outcome',
            !s.errorType,
            `${at}/details/${key}/${j}`,
            'A successful normalized latency sample also has an error.',
          );
        inspectPacket(s.packet, `${at}/details/${key}/${j}/packet`);
      }
      if (d[aggregate] && Array.isArray(d[key])) {
        const computed = summary(ss);
        for (const [k, v] of Object.entries(computed))
          approx(
            'summary_' + k,
            d[aggregate][k],
            v,
            `${at}/details/${aggregate}/${k}`,
          );
      }
    }
    const traceIds = new Set();
    for (const [j, s] of list(m.route?.samples).entries()) {
      if (!object(s)) throw new Error('Traceroute samples must be objects.');
      const identity = `${s.hop}:${s.sequence}`;
      check(
        'trace_identity',
        Number.isSafeInteger(s.hop) &&
          s.hop >= 1 &&
          Number.isSafeInteger(s.sequence) &&
          !traceIds.has(identity),
        `${at}/route/samples/${j}`,
        'Invalid or duplicate hop/sequence pair.',
      );
      traceIds.add(identity);
      inspectPacket(s.packet, `${at}/route/samples/${j}/packet`);
      if (
        m.route?.library === 'icmpenguin' &&
        s.kind !== 'reply' &&
        s.kind !== 'timeout'
      )
        note(
          'warning',
          'ambiguous_trace_label',
          `${at}/route/samples/${j}`,
          'Library error class does not establish original ICMP type/code; retain classification without inferring it.',
        );
    }
    inspectPacket(m.packet, at + '/packet');
    if (m.success === true)
      check(
        'success_value',
        rttValid(m.value),
        at,
        'Successful measurement needs a finite nonnegative value.',
      );
    if (m.type === 'traceroute' && m.route?.reached === true) {
      check(
        'trace_reached',
        list(m.route.samples).some(s => s.hop === m.route.reachedHop),
        at,
        'Reached hop has no recorded probe.',
      );
      if (m.success) approx('trace_value', m.value, m.route.reachedHop, at);
    }
    if (d.complete && present(d.requestedCount))
      check(
        'completed_count',
        list(d.samples).length === d.requestedCount,
        at,
        'Completed burst count differs from requestedCount.',
      );
    const field =
      m.type === 'icmp_burst'
        ? 'nonResponsePercent'
        : m.type === 'udp_echo'
        ? 'lossPercent'
        : null;
    if (field) {
      const denominator =
        field === 'lossPercent' ? d.sentCount : d.requestedCount;
      const canCheck =
        d.complete === true &&
        validNumber(denominator) &&
        denominator > 0 &&
        (field === 'lossPercent' ||
          list(d.samples).every(
            s => rttValid(s.rttMs) || s.errorType === 'timeout',
          ));
      if (canCheck)
        approx(
          'loss_formula',
          d[field],
          (100 * (denominator - summary(list(d.samples)).replies)) /
            denominator,
          at + '/details/' + field,
        );
      else
        note(
          'unavailable',
          'loss_formula',
          at,
          'Burst incomplete, denominator unavailable, or outcomes unsuitable for loss calculation.',
        );
      if (m.type === 'udp_echo' && summary(list(d.samples)).replies === 0)
        note(
          'warning',
          'udp_no_replies',
          at,
          'No matching UDP echoes: RTT unavailable; filtering, route or server failure is not evidence of a missing library capability.',
        );
    }
    const transfer = ['download', 'upload'].includes(m.type) ? m : d.load;
    if (
      transfer?.success &&
      validNumber(transfer.transferredBytes) &&
      transfer.durationMs > 0
    )
      approx(
        'throughput_formula',
        transfer.value,
        (8 * transfer.transferredBytes) / (transfer.durationMs * 1000),
        at + (d.load ? '/details/load' : ''),
      );
    if (
      d.summary &&
      m.success &&
      [
        'icmp_burst',
        'udp_echo',
        'loaded_download',
        'loaded_upload',
        'tcp_connect',
      ].includes(m.type)
    )
      approx('primary_summary', m.value, d.summary.medianMs, at + '/value');
  }
  // Generated legacy CSVs provide the exact projection, including historical gaps.
  const tables = {};
  for (const f of sessionExportFiles(data)) {
    if (!catalog.files[f.name]) continue;
    const parsed = parseCsv(f.content);
    check(
      'catalog_headers',
      JSON.stringify(parsed.headers) ===
        JSON.stringify(catalog.files[f.name].columns),
      f.name,
      'CSV headers differ from the documented schema.',
    );
    tables[f.name] = parsed.rows.map(typedRow);
  }
  const byId = new Map(data.measurements.map((m, i) => [m.id, { m, i }]));
  const views = Object.fromEntries(
    Object.entries(catalog.files)
      .filter(([, f]) => f.kind === 'focused')
      .map(([name]) => [name, []]),
  );
  const counters = new Map();
  for (const row of tables['samples.csv']) {
    const parent = byId.get(row.measurementId);
    if (!parent) continue;
    const { m, i } = parent,
      s = row.rawSampleJson ?? {},
      p = s.packet ?? m.packet ?? {},
      raw = s.raw ?? m.raw ?? {};
    const group = row.sampleGroup;
    const countKey = `${i}:${group}`,
      index = counters.get(countKey) ?? 0;
    counters.set(countKey, index + 1);
    const suffix =
      group === 'traceroute'
        ? `route/samples/${index}`
        : group === 'baseline'
        ? `details/baselineSamples/${index}`
        : `details/samples/${index}`;
    const at =
      m.type === 'icmp_rtt'
        ? `/measurements/${i}`
        : `/measurements/${i}/${suffix}`;
    const library = row.library ?? p.engine ?? null;
    const native = library === 'capstone-linux-sockets';
    const alias = library === 'icmpenguin' && String(m.type).startsWith('icmp');
    const send = list(raw.callbacks).find(
      c =>
        c.value?.event === 'send_requested' && c.value?.sequence === s.sequence,
    )?.value;
    const payloadCandidates = [
      [p.payloadBytes, 'packet.payloadBytes'],
      [raw.request?.packetSize, 'raw.request.packetSize'],
      [s.probeBytes, 'sample.probeBytes'],
      [send?.payloadBytes, 'raw.callbacks.send_requested.payloadBytes'],
    ];
    const payload = payloadCandidates.find(([value]) => present(value));
    const focused = {
      ...row,
      recordPath: at,
      library,
      libraryVersion: row.libraryVersion ?? p.engineVersion ?? null,
      timingScope: native
        ? 'native_monotonic_probe'
        : library === 'icmpenguin'
        ? 'library_wall_clock_probe'
        : 'application_callback',
      payloadBytes: payload?.[0] ?? null,
      payloadSizeSource: payload?.[1] ?? null,
      targetPort:
        row.packetTargetPort ?? row.targetPort ?? raw.request?.port ?? null,
      responderAddress: alias ? null : row.responderAddress,
      addressEvidence: alias
        ? 'unavailable_library_target_only'
        : row.responderAddress
        ? native
          ? 'observed_socket_source'
          : 'library_reported_offender'
        : 'unavailable',
      routeReached: m.route?.reached ?? null,
      reachedHop: m.route?.reachedHop ?? null,
    };
    if (
      row.probeBytes === null &&
      payload &&
      native &&
      m.type !== 'tcp_connect'
    )
      note(
        'warning',
        'legacy_size_mapping_gap',
        at,
        'Legacy probeBytes is blank; focused payloadBytes is recovered from packet.payloadBytes.',
      );
    if (String(m.type).startsWith('icmp')) views['icmp.csv'].push(focused);
    else if (m.type === 'traceroute') views['traceroute.csv'].push(focused);
    else if (m.type === 'udp_echo') views['udp.csv'].push(focused);
    else if (['loaded_download', 'loaded_upload'].includes(m.type))
      views['http-latency-samples.csv'].push({
        ...focused,
        httpLatencyMs: row.rttMs,
        timingScope: 'http_full_transaction',
      });
  }
  // TCP is one row per connection even if historical data has no details.samples.
  for (const [i, m] of data.measurements.entries()) {
    const p = m.packet ?? {},
      tcp = p.tcpInfoAfter ?? {},
      raw = m.raw ?? {};
    const base = {
      sessionId: m.sessionId,
      measurementId: m.id,
      measurementType: m.type,
      method: m.method,
      library: raw.library ?? p.engine ?? null,
      libraryVersion: raw.version ?? p.engineVersion ?? null,
      recordPath: `/measurements/${i}`,
      sampleTimestamp: m.timestamp,
      targetHost: m.targetHost ?? m.probeServer,
      outcome: m.errorType ?? (m.success ? 'success' : 'unavailable'),
      errorType: m.errorType,
    };
    if (m.type === 'tcp_connect') {
      const cb =
        list(raw.callbacks).find(c => c.value?.event === 'connected')?.value ??
        {};
      views['tcp.csv'].push({
        ...base,
        targetPort: m.details?.targetPort ?? p.targetPort ?? raw.request?.port,
        connectDurationMs: m.value,
        timingScope:
          p.engine === 'capstone-linux-sockets'
            ? 'native_connect'
            : 'connect_including_resolution_and_callback',
        kernelRttMs: present(tcp.tcpi_rtt) ? tcp.tcpi_rtt / 1000 : null,
        kernelRttVariationMs: present(tcp.tcpi_rttvar)
          ? tcp.tcpi_rttvar / 1000
          : null,
        tcpTotalRetransmissions: tcp.tcpi_total_retrans,
        congestionWindowSegments: tcp.tcpi_snd_cwnd,
        sendMssBytes: tcp.tcpi_snd_mss,
        congestionWindowBytesEstimate:
          present(tcp.tcpi_snd_cwnd) && present(tcp.tcpi_snd_mss)
            ? tcp.tcpi_snd_cwnd * tcp.tcpi_snd_mss
            : null,
        localAddress: p.localAddress ?? cb.localAddress,
        localPort: p.localPort ?? cb.localPort,
        targetAddress: p.targetAddress ?? p.resolvedAddress ?? cb.remoteAddress,
      });
      if (!present(tcp.tcpi_rtt))
        note(
          'unavailable',
          'kernel_tcp_info',
          base.recordPath,
          'No handset TCP_INFO on this record; callback connect time cannot replace kernel RTT.',
        );
    }
    if (
      [
        'http_rtt',
        'download',
        'upload',
        'loaded_download',
        'loaded_upload',
      ].includes(m.type)
    ) {
      const d = m.details ?? {},
        transfer =
          d.load ?? (['download', 'upload'].includes(m.type) ? m : null);
      views['http.csv'].push({
        ...base,
        success: m.success,
        requestedBytes: transfer?.requestedBytes ?? m.requestedBytes,
        transferredBytes: transfer?.transferredBytes ?? m.transferredBytes,
        httpStatus: transfer?.httpStatus ?? m.httpStatus,
        httpLatencyMs: m.unit === 'ms' ? m.value : null,
        transferDurationMs: transfer?.durationMs ?? null,
        throughputMbps: transfer?.value ?? null,
        baselineMedianMs: d.baselineSummary?.medianMs,
        loadedMedianMs: d.summary?.medianMs,
        loadedOverlapCount: d.loadedOverlapCount,
      });
    }
  }
  const availability = {};
  for (const [name, rows] of Object.entries(views))
    availability[name] = {
      rows: rows.length,
      fields: Object.fromEntries(
        catalog.files[name].columns.map(k => [
          k,
          rows.filter(r => present(r[k])).length,
        ]),
      ),
    };
  const totals = Object.fromEntries(
    ['error', 'warning', 'unavailable'].map(s => [
      s,
      issues.filter(i => i.severity === s).length,
    ]),
  );
  const audit = {
    analysisVersion: 1,
    sessionId: data.session.id,
    counts: {
      measurements: data.measurements.length,
      samples: tables['samples.csv'].length,
      events: data.events.length,
      snapshots: data.snapshots.length,
    },
    durationSeconds:
      data.session.endedAt && data.session.startedAt
        ? (Date.parse(data.session.endedAt) -
            Date.parse(data.session.startedAt)) /
          1000
        : null,
    totals,
    checks,
    issues,
    groups,
    availability,
    limitations: [
      'Availability counts describe retained evidence, not support guarantees. Empty values are never converted to zero.',
      'HTTP over a USB-forwarded local endpoint does not measure satellite/internet throughput.',
      'Connect timing, kernel RTT, ICMP RTT and HTTP latency have different scopes.',
      'No full IP/TCP capture or congestion-window time series during a transfer is collected.',
      'Single-run evidence cannot establish library/native superiority; use matched conditions for an endurance comparison.',
    ],
  };
  return { audit, views };
}
function reportMarkdown(audit) {
  const lines = [
    '# Measurement sanity-check report',
    '',
    `Measurements: **${audit.counts.measurements}**; samples: **${audit.counts.samples}**; context snapshots: **${audit.counts.snapshots}**; events: **${audit.counts.events}**.`,
    `Duration: ${audit.durationSeconds ?? 'unavailable'} seconds. Errors: **${
      audit.totals.error
    }**; warnings: **${audit.totals.warning}**; unavailable checks: **${
      audit.totals.unavailable
    }**.`,
    '',
    'See [column meanings and types](column-dictionary.md). Full findings, JSON pointers and check counts are in `sanity-checks.json`. Source JSON remains authoritative.',
    '',
    '| Measurement | Attempts | Successful attempts | Probe samples | Samples with response time |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const [type, g] of Object.entries(audit.groups))
    lines.push(
      `| ${type} | ${g.attempts} | ${g.successful} | ${g.probes} | ${g.replies} |`,
    );
  lines.push(
    '',
    '## Findings',
    '',
    '| Severity | Check | Occurrences | Interpretation |',
    '| --- | --- | ---: | --- |',
  );
  const grouped = new Map();
  for (const i of audit.issues) {
    const key = i.severity + ':' + i.code;
    const g = grouped.get(key) ?? { ...i, count: 0 };
    g.count++;
    grouped.set(key, g);
  }
  for (const g of grouped.values())
    lines.push(`| ${g.severity} | ${g.code} | ${g.count} | ${g.message} |`);
  lines.push(
    '',
    '## Field availability',
    '',
    'Counts are non-null rows, not inferred capabilities. Zero rows means this measurement was not collected. Key fields are shown here; sanity-checks.json contains counts for every column.',
    '',
    '| File | Rows | Non-null values for key fields |',
    '| --- | ---: | --- |',
  );
  for (const [name, a] of Object.entries(audit.availability))
    lines.push(
      `| ${name} | ${a.rows} | ${Object.entries(a.fields)
        .filter(([k]) =>
          [
            'rttMs',
            'httpLatencyMs',
            'connectDurationMs',
            'kernelRttMs',
            'congestionWindowSegments',
            'payloadBytes',
            'receivedSocketBytes',
            'icmpType',
            'responderAddress',
            'throughputMbps',
            'transferDurationMs',
          ].includes(k),
        )
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')} |`,
    );
  lines.push(
    '',
    '## Interpretation limits',
    '',
    ...audit.limitations.map(s => `- ${s}`),
    '',
  );
  return lines.join('\n');
}
function outputFiles(result) {
  const files = {};
  for (const [name, rows] of Object.entries(result.views)) {
    const columns = catalog.files[name].columns;
    files[name] =
      [
        columns.map(csvCell).join(','),
        ...rows.map(r => columns.map(k => csvCell(r[k])).join(',')),
      ].join('\r\n') + '\r\n';
  }
  files['sanity-checks.json'] = JSON.stringify(result.audit, null, 2) + '\n';
  files['report.md'] = reportMarkdown(result.audit);
  files['column-dictionary.md'] = dictionaryMarkdown();
  return files;
}
module.exports = { analyze, parseCsv, summary, outputFiles, reportMarkdown };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--out')
      throw new Error(
        'Usage: npm run measurements:analyze -- --input session.json --out output-directory',
      );
    const input = path.resolve(args[1]),
      out = path.resolve(args[3]);
    const result = analyze(JSON.parse(fs.readFileSync(input, 'utf8'))),
      files = outputFiles(result);
    // Preflight every destination before writing; never clobber source or existing analysis.
    for (const name of Object.keys(files))
      if (fs.existsSync(path.join(out, name)))
        throw new Error(
          `Output already exists: ${path.join(
            out,
            name,
          )}. Choose a new directory.`,
        );
    fs.mkdirSync(out, { recursive: true });
    for (const [name, content] of Object.entries(files))
      fs.writeFileSync(path.join(out, name), content, { flag: 'wx' });
    console.log(
      `Wrote ${Object.keys(files).length} analysis files to ${out}. Errors: ${
        result.audit.totals.error
      }; warnings: ${result.audit.totals.warning}; unavailable: ${
        result.audit.totals.unavailable
      }.`,
    );
    if (result.audit.totals.error) process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
