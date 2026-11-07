'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client';
import { Button } from '@/components/ui/button';
import {
  TripMeasurementSummary,
  type TripSummary,
} from './trip-measurement-summary';
type Trip = {
  id: string;
  participantId: string;
  state: string;
  phase: string;
  confidence: string;
  provider: string | null;
  receivedAt: string;
  startedAt: number;
  endedAt: number | null;
  firstQualifiedAt: number | null;
  reason: string | null;
  shadow: boolean;
  flight: {
    flightNumber?: string;
    departure?: string;
    arrival?: string;
    expectedMinutes?: number;
  };
  used: { transfers: number; diagnostics: number; uploads: number };
  uploadComplete: boolean;
  missingSegments: number[];
  segmentCount: number;
  segments: { index: number; sessionId: string; uploaded: boolean }[];
  summary?: TripSummary;
};
export function Trips({ openSession }: { openSession(id: string): void }) {
  const [confidence, setConfidence] = useState('');
  const [provider, setProvider] = useState('');
  const [page, setPage] = useState(0);
  const path = `/research/trips?offset=${
    page * 20
  }&limit=20&confidence=${encodeURIComponent(
    confidence,
  )}&provider=${encodeURIComponent(provider)}`;
  const query = useQuery<{ total: number; items: Trip[] }>({
    queryKey: [path],
    queryFn: ({ signal }) => api(path, { signal }),
    refetchInterval: 15000,
    retry: false,
  });
  return (
    <section className="space-y-5">
      <h2 className="text-xl font-semibold">Trips and received segments</h2>
      <p>
        Last reported collection state is not a live-phone indicator.
        Network-only evidence does not establish an airborne flight. Flight
        details are participant-reported.
      </p>
      <div className="flex flex-wrap gap-3">
        <label>
          Latest confidence{' '}
          <select
            className="field"
            value={confidence}
            onChange={e => {
              setConfidence(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All</option>
            <option value="unconfirmed">Unconfirmed</option>
            <option value="network_only">Network-only</option>
            <option value="gps_supported">GPS-supported</option>
          </select>
        </label>
        <label>
          Latest provider{' '}
          <select
            className="field"
            value={provider}
            onChange={e => {
              setProvider(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All</option>
            {[
              'Starlink',
              'Inmarsat',
              'Intelsat',
              'Panasonic',
              'SITA',
              'ViaSat',
            ].map(p => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <Button onClick={() => query.refetch()}>Refresh</Button>
      </div>
      {query.isPending && <p>Loading received trips…</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data?.items.length === 0 && (
        <p>No received trips match these filters.</p>
      )}
      {query.data?.items.map(t => (
        <article key={t.id} className="panel p-6 space-y-3">
          <h3 className="font-semibold">
            {t.flight.flightNumber || 'Flight not entered'} ·{' '}
            {t.flight.departure || 'Unknown departure'} →{' '}
            {t.flight.arrival || 'Unknown arrival'}
          </h3>
          <p>
            Participant {t.participantId} ·{' '}
            {t.shadow ? 'Researcher shadow test' : 'Automatic collection'}
          </p>
          <p>
            Started {new Date(t.startedAt).toLocaleString()} · latest receipt{' '}
            {new Date(t.receivedAt).toLocaleString()}
          </p>
          <p>
            {t.provider || 'Provider unavailable'} ·{' '}
            {t.confidence.replaceAll('_', ' ')} · last reported {t.state} /{' '}
            {t.phase}
          </p>
          <p>
            {t.firstQualifiedAt == null
              ? 'Never qualified'
              : `First qualification ${new Date(
                  t.firstQualifiedAt,
                ).toLocaleString()}`}{' '}
            · ending reason: {t.reason || 'Not reported'}
          </p>
          <p>
            {t.uploadComplete ? 'Upload complete' : 'Partial upload'} ·{' '}
            {t.missingSegments.length} incomplete or missing of {t.segmentCount}{' '}
            reported segments
          </p>
          <p>
            Reserved payload: transfers{' '}
            {(t.used.transfers / 1048576).toFixed(2)} MiB; probes/context{' '}
            {(t.used.diagnostics / 1048576).toFixed(2)} MiB; live uploads{' '}
            {(t.used.uploads / 1048576).toFixed(2)} MiB
          </p>
          <TripMeasurementSummary
            summary={t.summary}
            startedAt={t.startedAt}
            endedAt={t.endedAt}
          />
          <details>
            <summary>
              Open segment evidence, detection timeline and downloads
            </summary>
            <div className="flex flex-wrap gap-2 pt-3">
              {t.segments.map(s => (
                <Button key={s.index} onClick={() => openSession(s.sessionId)}>
                  Segment {s.index + 1} · {s.uploaded ? 'uploaded' : 'partial'}
                </Button>
              ))}
            </div>
          </details>
        </article>
      ))}
      <div className="flex gap-3">
        <Button disabled={!page} onClick={() => setPage(p => p - 1)}>
          Previous
        </Button>
        <span>Page {page + 1}</span>
        <Button
          disabled={!query.data || (page + 1) * 20 >= query.data.total}
          onClick={() => setPage(p => p + 1)}
        >
          Next
        </Button>
      </div>
      <a href="/measurements/flight-collection.md">
        How flight evidence and budgets are measured
      </a>
    </section>
  );
}
