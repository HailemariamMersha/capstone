'use client';
import { useState } from 'react';
import { measurementMethods } from '@/lib/measurement-methods';
import {
  measurementFields,
  probeFields,
  scheduleFields,
  variableDefinition,
  type Field,
} from '@/lib/variable-reference';

const groups = {
  Measurements: [
    ...measurementFields,
    [
      'success',
      'Succeeded',
      'Boolean parent result; individual probes can still time out.',
    ],
    [
      'targetHost',
      'Target host',
      'Current trip-table target column; uses probeServer when targetHost is absent.',
    ],
    [
      'probeServer',
      'Probe endpoint',
      'Service URL saved with the measurement.',
    ],
    [
      'replyCount',
      'Replies',
      'Current trip-table name for the valid reply count.',
    ],
    [
      'port',
      'Port',
      'Destination port from the measurement details or library request.',
    ],
  ] as Field[],
  Samples: [
    ...probeFields,
    [
      'measurementId',
      'Measurement ID',
      'Trip-table parent identifier; the older filtered view calls this parent.',
    ],
    [
      'timestamp',
      'Observed (UTC)',
      'Sample time when available; can inherit parent time when absent.',
    ],
  ] as Field[],
  Scheduling: scheduleFields,
  Events: [
    ['timestamp', 'Observed (UTC)', 'Time the event was recorded.'],
    ['kind', 'Event', 'Collector activity or decision category.'],
    [
      'details',
      'Details',
      'Structured reasons, scheduling or detector evidence.',
    ],
    [
      'sessionId',
      'Segment ID',
      'The collection segment containing this event.',
    ],
  ] as Field[],
};

export function MeasurementGuide() {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const query = search.trim().toLowerCase();
  const rows = Object.entries(groups)
    .flatMap(([scope, fields]) =>
      fields.map(([key, label, meaning]) => ({
        scope,
        key,
        label,
        meaning,
        ...variableDefinition(scope, key),
      })),
    )
    .filter(
      row =>
        (!group || row.scope === group) &&
        (!query || Object.values(row).join(' ').toLowerCase().includes(query)),
    );
  return (
    <div className="space-y-6">
      <section className="panel p-6 space-y-3">
        <h2 className="text-xl font-semibold">How to read the evidence</h2>
        <p>
          A measurement is a whole test, burst or traceroute. A sample is one
          observation within it. An HTTP sample is a transaction, not an
          individual network packet.
        </p>
        <p>
          <strong>Unavailable does not mean zero.</strong> A blank may be
          inapplicable, not exposed by the library, or missing after a timeout.
          A burst can succeed while some probes time out. A dashboard loading
          timeout describes fetching saved data, not a measured packet failure.
        </p>
        <p>
          Our Android adapter exposes an existing ICMP/traceroute library. It
          does not turn these results into a complete packet capture. The
          current collector does not read the phone’s TCP congestion windows,
          kernel RTT, retransmission counters or full IP/TCP headers. M-Lab
          callbacks can include server TCPInfo; that describes the remote
          server, not the phone’s kernel state.
        </p>
        <p>
          When using the complete combined CSV, count distinct measurement IDs:
          parent values repeat on every sample row. Do not sum repeated transfer
          bytes or count them as additional tests.
        </p>
      </section>
      <section className="space-y-3" aria-label="Collection methods">
        <h2 className="text-xl font-semibold">What we measure and how</h2>
        <p className="muted text-sm">
          These describe the current Android collector and pilot defaults. The
          saved configuration and provenance for each trip take precedence. The
          app makes library calls and network requests; it does not execute
          shell commands. Code excerpts below omit validation/cancellation
          bookkeeping; linked source files contain the complete implementation.
        </p>
        {measurementMethods.map(method => (
          <details key={method.name} className="panel min-w-0 p-5">
            <summary className="cursor-pointer font-semibold py-2">
              {method.name}
            </summary>
            <p className="text-sm text-teal-800 my-3">{method.library}</p>
            <p className="text-sm muted mb-3">{method.schedule}</p>
            <p>{method.how}</p>
            <h3 className="font-semibold mt-5 mb-2">
              Actual target and request
            </h3>
            <p className="text-sm whitespace-pre-wrap break-words">
              {method.request}
            </p>
            <h3 className="font-semibold mt-5 mb-2">App call (abridged)</h3>
            <pre
              aria-label={`${method.name} app call`}
              className="max-w-full overflow-x-auto rounded-xl bg-slate-950 p-4 text-xs leading-relaxed text-slate-50"
            >
              <code>{method.appCall}</code>
            </pre>
            <dl className="space-y-4 mt-5 text-sm">
              <div>
                <dt className="font-semibold">When timing starts and stops</dt>
                <dd>{method.timing}</dd>
              </div>
              <div>
                <dt className="font-semibold">
                  Calculation and reported value
                </dt>
                <dd>{method.calculation}</dd>
              </div>
              <div>
                <dt className="font-semibold">
                  Where to find the saved evidence
                </dt>
                <dd>{method.evidence}</dd>
              </div>
              <div>
                <dt className="font-semibold">Limitations</dt>
                <dd>{method.limits}</dd>
              </div>
            </dl>
            {method.terminal && (
              <div className="mt-5 space-y-2">
                <h3 className="font-semibold">Linux comparison command</h3>
                <p className="text-sm muted">
                  A comparison command, not a command executed by the app. Use
                  the same network, resolved destination and time window; tool
                  timing, payloads, headers and probe spacing can differ. These
                  commands do not reproduce the app’s Wi-Fi binding or all
                  response validation.
                </p>
                <pre className="max-w-full overflow-x-auto rounded-xl bg-slate-100 p-4 text-xs">
                  <code>{method.terminal}</code>
                </pre>
              </div>
            )}
            <div className="mt-5 space-y-1 text-xs">
              <p className="font-semibold">Implementation source</p>
              {method.sources.map(path => (
                <a
                  key={path}
                  className="block underline break-all"
                  href={`https://github.com/HailemariamMersha/capstone/blob/feature/skymeasure-participant-dashboard/${path}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {path}
                </a>
              ))}
            </div>
          </details>
        ))}
      </section>
      <section
        className="panel p-6 space-y-3"
        aria-label="Shared statistical calculations"
      >
        <h2 className="text-xl font-semibold">How summaries are calculated</h2>
        <p>
          Only non-null, finite, nonnegative RTT values enter the sorted
          summary; zero remains valid. For n valid values sorted from smallest
          to largest, the app uses:
        </p>
        <pre className="max-w-full overflow-x-auto rounded-xl bg-slate-100 p-4 text-xs">
          <code>{`medianMs = middle value, or mean of the two middle values when n is even
p95Ms = sorted[Math.ceil(0.95 * n) - 1]  // nearest-rank percentile
successiveDifferenceMs = mean(abs(RTT[i] - RTT[i-1]))
  // only consecutive sequence numbers with both RTTs available
no valid replies => medianMs and p95Ms are null
no valid consecutive pair => successiveDifferenceMs is null`}</code>
        </pre>
        <p className="text-sm">
          The successive-difference field is our documented jitter statistic; it
          is not an RFC jitter estimator. Missing probes are not bridged. ICMP
          non-response and UDP loss percentages use their complete-burst rules
          described above, rather than treating an interrupted burst as a full
          experiment.
        </p>
        <p className="text-sm">
          A trip summary pools valid individual samples for its exact median;
          timeline points normally show each recorded burst’s median. Dense
          timeline bins summarize parent points, not a new pooled packet
          measurement. Parent rows can repeat in the combined CSV, so count
          distinct measurement IDs.
        </p>
        <p className="text-sm">
          Wall-clock timestamps locate observations in time; monotonic clocks
          measure durations where available. The collector compares Android
          elapsed time with callback duration and marks a detected timing gap
          invalid, retaining the original observations. A valid timing flag does
          not independently establish network measurement accuracy.
        </p>
        <a
          className="text-xs underline"
          href="https://github.com/HailemariamMersha/capstone/blob/feature/skymeasure-participant-dashboard/src/measurements/statistics.ts"
          target="_blank"
          rel="noreferrer"
        >
          Source: src/measurements/statistics.ts
        </a>
      </section>
      <section aria-label="Variable definitions" className="space-y-4">
        <h2 className="text-xl font-semibold">Variable reference</h2>
        <p className="muted">
          Every selectable dashboard column is defined here. Field keys match
          the filtered CSV headers. Expand a variable for its source and
          calculation.
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            Search variables
            <input
              className="block w-full mt-2"
              placeholder="RTT, TTL, loss, battery, checksum…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </label>
          <label className="block">
            Table
            <select
              aria-label="Variable table"
              className="block w-full mt-2"
              value={group}
              onChange={e => setGroup(e.target.value)}
            >
              <option value="">All tables</option>
              {Object.keys(groups).map(name => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        </div>
        <p role="status">{rows.length} variables match</p>
        {!rows.length && <p>No variables match. Try another term or table.</p>}
        {rows.map(row => (
          <details className="panel p-5" key={`${row.scope}.${row.key}`}>
            <summary className="cursor-pointer py-2">
              <strong>{row.label}</strong>
              <span className="muted text-sm ml-3">
                {row.scope} · {row.key}
              </span>
            </summary>
            <p className="my-3">{row.meaning}</p>
            <dl className="space-y-3 text-sm break-words">
              <div>
                <dt className="font-semibold">Datatype and units</dt>
                <dd>
                  {row.datatype} · {row.units}
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Saved source</dt>
                <dd className="font-mono text-xs">{row.source}</dd>
              </div>
              <div>
                <dt className="font-semibold">
                  How it is measured or calculated
                </dt>
                <dd>{row.calculation}</dd>
              </div>
              <div>
                <dt className="font-semibold">Why it may be empty</dt>
                <dd>{row.blank}</dd>
              </div>
            </dl>
          </details>
        ))}
      </section>
      <section className="panel p-6 space-y-3">
        <h2 className="text-xl font-semibold">Complete export dictionary</h2>
        <p>
          The complete CSV and JSON can include additional fields and historical
          native-only values. Their definitions, examples, units and formulas
          are in the full dictionary; inclusion there does not mean the current
          libraries provide them.
        </p>
        <div className="flex flex-wrap gap-4">
          <a
            className="underline"
            href="/measurements/columns.md"
            target="_blank"
            rel="noreferrer"
          >
            All export column definitions
          </a>
          <a
            className="underline"
            href="/measurements/guide.md"
            target="_blank"
            rel="noreferrer"
          >
            Measurement and interpretation guide
          </a>
          <a className="underline" href="/measurements/columns.json" download>
            Download dictionary JSON
          </a>
        </div>
      </section>
    </div>
  );
}
