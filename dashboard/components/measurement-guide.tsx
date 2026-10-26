'use client';
import { useState } from 'react';
import {
  measurementFields,
  probeFields,
  scheduleFields,
  variableDefinition,
} from '@/lib/variable-reference';

const methods = [
  [
    'ICMP echo',
    'icmpenguin 1.0.0-rc.3 through the Android adapter',
    'The library sends an echo and reports RTT and received ICMP bytes. We validate the echo type, sequence and payload, decode header fields, and summarize valid replies in a burst.',
    'RTT is in milliseconds. Reply TTL is a remaining hop limit, not a direct hop count. Captured bytes contain the ICMP message, not the outer IP header or every packet on the phone.',
  ],
  [
    'TCP connection',
    'react-native-tcp-socket 6.4.3',
    'performance.now() at connection initiation is subtracted from the time of the connected callback. The socket is then closed.',
    'Includes name resolution, native dispatch and callback delay. This is not isolated SYN RTT, TLS time, congestion window or kernel RTT.',
  ],
  [
    'UDP echo',
    'react-native-udp 4.1.7',
    'Send 128-byte payloads carrying a run identifier and sequence to the echo service. Match replies and subtract the application send timestamp from callback receipt time. Track unique replies, timeouts, duplicates and reordering.',
    'RTT includes callback scheduling. Loss is non-response to this echo service within the test deadline; it does not locate the dropped packet or establish an outage.',
  ],
  [
    'Traceroute',
    'icmpenguin 1.0.0-rc.3 through the Android adapter',
    'The library sends UDP probes with increasing hop limits and reports probe RTT, hop, responder/offender address and result classification. We retain its results through a thin adapter.',
    'Hop RTT is the round trip to that responding hop, not just one link. host_unreachable and port_unreachable are qualified library labels; they are not independently decoded ICMP type/code or proof that the destination was reached.',
  ],
  [
    'HTTP latency',
    'React Native fetch and TypeScript timing',
    'Measure performance.now() from starting the /ping request through consuming and validating the complete response body.',
    'Includes applicable DNS, TCP/TLS setup, server processing and body delivery. Connection reuse changes the scope. This is an HTTP transaction, not pure packet RTT.',
  ],
  [
    'Download and upload throughput',
    'fetch; @dr.pogodin/react-native-fs 2.40.3 for downloads larger than 8 MiB',
    'Download a configured payload (large downloads stream to a file), or upload a prepared payload and validate the server byte acknowledgement. Mbps = confirmed payload bytes × 8 / elapsed milliseconds / 1000.',
    'Application throughput includes operation overhead; payload bytes exclude IP/TCP/TLS headers. MiB = 1,048,576 bytes; Mbps uses decimal millions of bits per second.',
  ],
  [
    'Latency under load',
    'The same HTTP libraries and TypeScript coordinator',
    'Collect HTTP baseline probes, start a bounded download or upload, and collect HTTP probes during the transfer. Only probes fully inside the transfer interval enter the loaded summary.',
    'The parent result is loaded median latency in ms, not transfer Mbps. The embedded load has separate byte and throughput fields. A transfer that finishes too quickly may have no usable overlapping samples.',
  ],
  [
    'Network, battery and schedule context',
    'NetInfo, react-native-device-info and the application scheduler',
    'Read connection type and optional Wi-Fi details from NetInfo; read battery level and charging state from DeviceInfo. Save wall-clock scheduled and actual execution times and associate a context snapshot with measurements.',
    'Wi-Fi strength is a 0–100 score, not dBm or satellite signal strength. Repeated context is not a new reading for each packet. Schedule delay can include prior tests and OS scheduling, and wall-clock changes affect it.',
  ],
];
const groups = {
  Measurements: measurementFields,
  Samples: probeFields,
  Scheduling: scheduleFields,
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
          current collector does not supply TCP congestion windows, kernel RTT,
          retransmission counters or full IP/TCP headers.
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
          These describe the current library collector. For historical sessions,
          check their saved method and library/version provenance.
        </p>
        {methods.map(([name, library, how, limits]) => (
          <details key={name} className="panel p-5">
            <summary className="cursor-pointer font-semibold py-2">
              {name}
            </summary>
            <p className="text-sm text-teal-800 my-3">{library}</p>
            <p>{how}</p>
            <p className="muted mt-3">{limits}</p>
          </details>
        ))}
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
