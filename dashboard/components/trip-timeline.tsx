'use client';
import { useState } from 'react';
import {
  CartesianGrid,
  Legend,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from './ui/button';
import {
  type Timeline,
  type TripDetail,
  type Point,
  label,
  when,
  number,
} from '@/lib/trip-types';
const colors: Record<string, string> = {
  icmp_burst: '#007f79',
  icmp_rtt: '#007f79',
  udp_echo: '#3862a1',
  download: '#007f79',
  upload: '#9365ad',
  ndt7_download: '#d47a17',
  ndt7_upload: '#d0454e',
};
export function TripTimeline({
  data,
  timeline,
  healthOnly = false,
}: {
  data: TripDetail;
  timeline?: Timeline;
  healthOnly?: boolean;
}) {
  const [local, setLocal] = useState(false);
  const start = data.startedAt,
    end = Math.max(
      start + 1000,
      data.endedAt ?? start + data.health.reportedDurationMs,
    );
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const domain: [number, number] = zoom ?? [start, end];
  const events = data.events.filter(
    e => (e.end ?? e.at) >= domain[0] && e.at <= domain[1],
  );
  const blocks = events.filter(e =>
    ['collector_gap', 'upload_pause', 'unreceived'].includes(e.kind),
  );
  const time = (n: number) =>
    new Date(n).toLocaleTimeString(undefined, {
      timeZone: local ? undefined : 'UTC',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
  const rtt =
    timeline?.series.filter(s =>
      ['icmp_burst', 'icmp_rtt', 'udp_echo'].includes(s.type),
    ) ?? [];
  const rates =
    timeline?.series.filter(s =>
      ['download', 'upload', 'ndt7_download', 'ndt7_upload'].includes(s.type),
    ) ?? [];
  const failures =
    timeline?.series
      .flatMap(s => s.points)
      .filter(p => p.success === false || p.failures) ?? [];
  function lane(name: string, series: typeof rtt, unit: string) {
    return (
      <section className="panel p-5 min-w-0" aria-label={name}>
        <h3 className="font-semibold mb-2">{name}</h3>
        {!series.some(s => s.points.length) ? (
          <p className="muted py-10">
            No {name.toLowerCase()} in the received evidence.
          </p>
        ) : (
          <>
            <div
              className="h-64 w-full"
              role="img"
              aria-label={`${name} across the received trip. Failed or missing values are not zero.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart
                  margin={{ left: 5, right: 22, top: 20, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e4ebed" />
                  <XAxis
                    type="number"
                    dataKey="at"
                    domain={domain}
                    allowDataOverflow
                    tickFormatter={time}
                    tick={{ fontSize: 11 }}
                    name={local ? 'Local time' : 'UTC'}
                  />
                  <YAxis
                    type="number"
                    dataKey="value"
                    name={unit}
                    unit={` ${unit}`}
                    tick={{ fontSize: 11 }}
                    width={74}
                  />
                  <Tooltip
                    content={({ payload }) => {
                      const p = payload?.[0]?.payload as Point | undefined;
                      return p ? (
                        <div className="panel p-3 text-xs">
                          <b>{label(p.type)}</b>
                          <p>
                            {when(p.at, local)} {local ? 'local' : 'UTC'}
                          </p>
                          <p>
                            {number(p.value)} {unit} ·{' '}
                            {p.target ?? 'Target not recorded'}
                          </p>
                          {p.pointCount && (
                            <p>
                              {p.pointCount} points in this display bin;{' '}
                              {p.failures ?? 0} failures.
                            </p>
                          )}
                        </div>
                      ) : null;
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {blocks.map(e => (
                    <ReferenceArea
                      key={e.id}
                      x1={Math.max(domain[0], e.at)}
                      x2={Math.min(domain[1], e.end ?? e.at)}
                      fill={
                        e.kind === 'collector_gap'
                          ? '#f7b6ab'
                          : e.kind === 'unreceived'
                          ? '#cbd5e1'
                          : '#fce9ad'
                      }
                      fillOpacity={0.35}
                    />
                  ))}
                  {series.map(s => (
                    <Scatter
                      key={s.type}
                      name={label(s.type)}
                      data={s.points.filter(
                        p =>
                          p.value != null &&
                          p.at >= domain[0] &&
                          p.at <= domain[1],
                      )}
                      fill={colors[s.type]}
                      shape={s.type.startsWith('ndt7') ? 'star' : 'circle'}
                      isAnimationActive={false}
                    />
                  ))}
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs muted">
              {unit === 'ms'
                ? 'Each point is a recorded burst median. ICMP and UDP may use different destinations.'
                : 'Controlled fixed-size transfers and M-Lab benchmarks use different methods and endpoints.'}{' '}
              Points are not connected across missing observations.
            </p>
          </>
        )}
      </section>
    );
  }
  return (
    <section className="space-y-4" aria-label="Whole-trip timeline">
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Whole-trip timeline</h2>
          <p className="muted text-sm">
            {time(domain[0])}–{time(domain[1])} ·{' '}
            {local ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'} ·
            received evidence only
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setLocal(v => !v)}>
            {local ? 'Use UTC' : 'Use local time'}
          </Button>
          <Button
            variant="outline"
            disabled={!zoom}
            onClick={() => setZoom(null)}
          >
            Whole trip
          </Button>
        </div>
      </div>
      {timeline?.series.some(s => s.bucketMs > 1) && (
        <p className="text-xs muted">
          Dense series use display bins: each bin shows the median of recorded
          results, not a pooled probe median. Full observations remain in
          Evidence.
        </p>
      )}
      {!healthOnly && (
        <>
          {lane('Latency', rtt, 'ms')}
          {lane('Throughput', rates, 'Mbps')}
        </>
      )}
      <section className="panel p-5">
        <h3 className="font-semibold">Collection events</h3>
        <p className="muted text-xs mt-1">
          Teal: provider state · yellow: upload pause · red: recorded gap or
          failed attempt · gray: unreceived evidence · dotted: segment boundary.
          A gap does not prove the phone slept.
        </p>
        <div
          className="relative h-24 my-5 bg-slate-50 rounded-lg border border-slate-200"
          role="img"
          aria-label="Events aligned to the chart time axis"
        >
          {events
            .filter(e => e.kind !== 'segment')
            .map(e => (
              <button
                key={e.id}
                title={`${e.kind.replaceAll('_', ' ')} · ${when(
                  e.at,
                  local,
                )} · ${e.reason ?? e.provider ?? ''}`}
                aria-label={`${e.kind.replaceAll('_', ' ')} at ${when(
                  e.at,
                  local,
                )}`}
                className="absolute top-3 h-11 rounded-sm opacity-75 focus:opacity-100"
                style={{
                  left: `${Math.max(
                    0,
                    ((e.at - domain[0]) / (domain[1] - domain[0])) * 100,
                  )}%`,
                  width: `${Math.max(
                    0.25,
                    ((Math.min(e.end ?? e.at, domain[1]) -
                      Math.max(e.at, domain[0])) /
                      (domain[1] - domain[0])) *
                      100,
                  )}%`,
                  background:
                    e.kind === 'collector_gap'
                      ? '#c75642'
                      : e.kind === 'unreceived'
                      ? '#94a3b8'
                      : e.kind === 'upload_pause'
                      ? '#d8a123'
                      : '#087f79',
                }}
                onClick={() => {
                  if (e.end && e.end > e.at)
                    setZoom([
                      Math.max(start, e.at - 60000),
                      Math.min(end, e.end + 60000),
                    ]);
                }}
              />
            ))}
          {events
            .filter(e => e.kind === 'segment')
            .map(e => (
              <span
                key={e.id}
                title={`Segment ${(e.index ?? 0) + 1}`}
                className="absolute inset-y-0 border-l border-dashed border-slate-400"
                style={{
                  left: `${
                    ((e.at - domain[0]) / (domain[1] - domain[0])) * 100
                  }%`,
                }}
              />
            ))}
          {failures
            .filter(p => p.at >= domain[0] && p.at <= domain[1])
            .map(p => (
              <span
                key={p.id}
                title={`${label(p.type)} failed: ${
                  p.error ?? 'partial result'
                } at ${when(p.at, local)}`}
                className="absolute bottom-2 text-red-700 text-xs"
                style={{
                  left: `${
                    ((p.at - domain[0]) / (domain[1] - domain[0])) * 100
                  }%`,
                }}
              >
                ▲
              </span>
            ))}
        </div>
        <div className="flex justify-between text-xs muted">
          <span>{time(domain[0])}</span>
          <span>{time(domain[1])}</span>
        </div>
        <details className="mt-5">
          <summary className="cursor-pointer font-medium">
            Inspect event intervals
          </summary>
          <div className="max-h-72 overflow-auto mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th>Time ({local ? 'local' : 'UTC'})</th>
                  <th>Event</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map(e => (
                  <tr key={e.id}>
                    <td>{when(e.at, local)}</td>
                    <td>
                      {e.kind === 'segment'
                        ? `Segment ${(e.index ?? 0) + 1}`
                        : e.kind.replaceAll('_', ' ')}
                    </td>
                    <td>{e.reason ?? e.provider ?? e.phase ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </section>
  );
}
