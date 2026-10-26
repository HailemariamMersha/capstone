'use client';
import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import {
  filterMeasurements,
  measurementLabel,
  parentOutcome,
  present,
  sampleRows,
  type Evidence,
} from '@/lib/evidence';

import {
  measurementFields,
  probeFields,
  scheduleFields,
  type Field,
} from '@/lib/variable-reference';
const display = (v: unknown) => (present(v) ? String(v) : 'Unavailable');
function columns(fields: Field[]): ColumnDef<Evidence>[] {
  return fields.map(([key, label, description]) => ({
    id: key,
    accessorFn: row => row[key] ?? undefined,
    header: label,
    meta: { description },
    sortUndefined: 'last',
    cell: c =>
      key === 'type' || key === 'protocol'
        ? measurementLabel(String(c.getValue()))
        : display(c.getValue()),
  }));
}
const measurementColumns = columns(measurementFields);
const probeColumns = columns(probeFields);
const scheduleColumns = columns(scheduleFields);

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="text-sm font-medium space-y-2 block">
      {label}
      <select
        aria-label={label}
        className="block w-full"
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}
export function SessionEvidence({ data }: { data: Evidence }) {
  const measurements: Evidence[] = data.measurements;
  const [type, setType] = useState('');
  const [outcome, setOutcome] = useState('');
  const [search, setSearch] = useState('');
  const [phase, setPhase] = useState('');
  const [sampleStatus, setSampleStatus] = useState('');
  const [probeSearch, setProbeSearch] = useState('');
  const allProbes = useMemo(() => sampleRows(measurements), [measurements]);
  const matched = useMemo(
    () => filterMeasurements(measurements, type, outcome, search),
    [measurements, type, outcome, search],
  );
  const matchedProbes = useMemo(
    () =>
      sampleRows(matched).filter(
        s =>
          (!phase || s.phase === phase) &&
          (!sampleStatus || s.outcome === sampleStatus) &&
          (!probeSearch.trim() ||
            [
              s.parent,
              s.target,
              s.address,
              s.kind,
              s.errorType,
              s.sequence,
              s.hop,
            ].some(v =>
              String(v ?? '')
                .toLowerCase()
                .includes(probeSearch.trim().toLowerCase()),
            )),
      ),
    [matched, phase, sampleStatus, probeSearch],
  );
  const parentRows = useMemo(
    () =>
      matched.map(m => ({
        ...m,
        outcome: parentOutcome(m),
        target: m.targetHost ?? m.probeServer,
        medianMs: m.details?.summary?.medianMs,
        p95Ms: m.details?.summary?.p95Ms,
        differenceMs: m.details?.summary?.successiveDifferenceMs,
        replies: m.details?.summary?.replies,
        lossPercent: m.details?.lossPercent ?? m.details?.nonResponsePercent,
        baselineMs: m.details?.baselineSummary?.medianMs,
        loadMbps: m.details?.load?.value,
        loadBytes: m.details?.load?.transferredBytes,
        library: m.raw?.library,
        network: m.networkSnapshot?.type,
        signal: m.networkSnapshot?.signalStrength,
        battery: m.networkSnapshot?.batteryPercent,
      })),
    [matched],
  );
  const scheduling = useMemo(
    () =>
      matched.map(m => {
        const delay = Date.parse(m.timestamp) - Date.parse(m.scheduledAt);
        return {
          type: m.type,
          scheduled: m.scheduledAt,
          executed: m.timestamp,
          delayMs: Number.isFinite(delay) ? delay : null,
        };
      }),
    [matched],
  );
  const timing: Evidence[] = matched
    .filter(m => m.unit === 'ms')
    .map(m => ({
      time: new Date(m.timestamp).toLocaleTimeString(),
      [m.type]: m.value ?? null,
    }));
  const methods = [
    ...new Set(matched.filter(m => m.unit === 'ms').map(m => String(m.type))),
  ];
  function reset() {
    setType('');
    setOutcome('');
    setSearch('');
    setPhase('');
    setSampleStatus('');
    setProbeSearch('');
  }
  return (
    <div className="space-y-6">
      <section aria-label="Session filters" className="panel p-6 space-y-4">
        <div className="flex flex-wrap justify-between gap-3 items-center">
          <h2 className="text-xl font-semibold">Explore measurements</h2>
          <Button variant="ghost" onClick={reset}>
            Reset filters
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Select label="Measurement type" value={type} onChange={setType}>
            <option value="">All measurement types</option>
            {[...new Set(measurements.map(m => String(m.type)))]
              .sort()
              .map(t => (
                <option key={t} value={t}>
                  {measurementLabel(t)}
                </option>
              ))}
          </Select>
          <Select
            label="Whole-measurement outcome"
            value={outcome}
            onChange={setOutcome}
          >
            <option value="">All outcomes</option>
            <option value="success">Successful</option>
            <option value="failure">Unsuccessful</option>
            <option value="unavailable">Unavailable</option>
          </Select>
          <label className="block text-sm font-medium space-y-2">
            Search measurements
            <input
              className="block w-full"
              placeholder="Target, method or measurement ID"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </label>
        </div>
        <p className="text-sm muted">
          These filters apply to the chart, measurement table, samples and
          scheduling. A successful burst can contain timeouts; use Sample
          outcome below to find them.
        </p>
        <p role="status" className="font-medium">
          {matched.length} of {measurements.length} measurements ·{' '}
          {matchedProbes.length} of {allProbes.length} samples shown
        </p>
      </section>
      <section aria-label="Timing observations" className="panel p-6">
        <h2 className="text-xl font-semibold">Timing observations</h2>
        <p className="muted text-sm mt-2 mb-6">
          One point per matching measurement. Echo RTT, TCP connection duration
          and HTTP latency have different timing scopes. Missing values are
          gaps; sample-only filters below do not change this chart.
        </p>
        {timing.some(t => methods.some(m => present(t[m]))) ? (
          <div className="h-72">
            <ResponsiveContainer>
              <LineChart data={timing}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="time" />
                <YAxis unit=" ms" />
                <Tooltip />
                <Legend />
                {methods.map((method, i) => (
                  <Line
                    key={method}
                    dataKey={method}
                    name={measurementLabel(method)}
                    stroke={['#087f79', '#355b91', '#986422', '#7b4c94'][i % 4]}
                    connectNulls={false}
                    dot={true}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p>No timing values match these filters.</p>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">
          Transfers and measurement outcomes
        </h2>
        <p className="text-sm muted">
          One row per complete measurement. Choose columns for throughput, loss,
          baseline latency or network context.
        </p>
        <DataTable
          paginate
          name="Measurement results"
          rows={parentRows}
          columns={measurementColumns}
          defaultColumns={[
            'type',
            'value',
            'unit',
            'outcome',
            'timestamp',
            'target',
            'durationMs',
            'method',
          ]}
          exportName={`${data.session.id}-filtered-measurements.csv`}
        />
      </section>
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">
          Individual probes and traceroute hops
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Select label="Sample phase" value={phase} onChange={setPhase}>
            <option value="">All phases</option>
            <option value="probe">Ordinary / during-transfer probes</option>
            <option value="baseline">Before-transfer baseline</option>
            <option value="traceroute">Traceroute hops</option>
          </Select>
          <Select
            label="Sample outcome"
            value={sampleStatus}
            onChange={setSampleStatus}
          >
            <option value="">All sample outcomes</option>
            <option value="response">Response observed</option>
            <option value="timeout">Timeout</option>
            <option value="error">Error</option>
            <option value="unavailable">Unavailable</option>
          </Select>
          <label className="block text-sm font-medium space-y-2">
            Search samples
            <input
              className="block w-full"
              placeholder="Address, label, sequence or parent ID"
              value={probeSearch}
              onChange={e => setProbeSearch(e.target.value)}
            />
          </label>
        </div>
        <p className="text-sm muted">
          These three controls filter only the samples. Traceroute labels are
          library classifications, not decoded ICMP types; “host_unreachable”
          can be ambiguous response evidence. Blank source addresses or TTLs
          stay unavailable.
        </p>
        <DataTable
          paginate
          name="Individual samples"
          rows={matchedProbes}
          columns={probeColumns}
          defaultColumns={[
            'protocol',
            'phase',
            'sequence',
            'rttMs',
            'outcome',
            'hop',
            'address',
            'kind',
          ]}
          exportName={`${data.session.id}-filtered-samples.csv`}
        />
      </section>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Scheduling observations</h2>
        <DataTable
          paginate
          name="Scheduling results"
          rows={scheduling}
          columns={scheduleColumns}
          exportName={`${data.session.id}-filtered-scheduling.csv`}
        />
        <p className="text-sm muted">
          Start delay uses two wall-clock timestamps; clock changes can affect
          it. It is not packet RTT.
        </p>
      </section>
    </div>
  );
}
