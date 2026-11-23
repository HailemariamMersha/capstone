'use client';
import { useEffect, useState } from 'react';
type Airport = {
  code: string;
  icao: string;
  name: string;
  city: string;
  x: number;
  y: number;
};
type Reference = { airports: Airport[]; land: string[] };
const norm = (v: string) =>
  v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
export function resolveAirport(
  airports: Airport[],
  text?: string,
): Airport | undefined {
  if (!text) return undefined;
  const key = norm(text);
  const codes = airports.filter(
    a => norm(a.code) === key || norm(a.icao) === key,
  );
  if (codes.length === 1) return codes[0];
  const names = airports.filter(
    a => norm(a.name) === key || norm(a.city) === key,
  );
  return names.length === 1 ? names[0] : undefined;
}
export function RouteMap({ from, to }: { from?: string; to?: string }) {
  const [ref, setRef] = useState<Reference | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/reference/route-reference.json')
      .then(r => (r.ok ? r.json() : null))
      .then(v => {
        if (alive) setRef(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const a = ref ? resolveAirport(ref.airports, from) : undefined,
    b = ref ? resolveAirport(ref.airports, to) : undefined;
  if (!a || !b)
    return (
      <p className="text-xs muted">
        Reported route: {from || '—'} → {to || '—'}. A map appears when both
        airport endpoints can be identified unambiguously.
      </p>
    );
  const point = (p: Airport) => ({ x: p.x + 180, y: 90 - p.y });
  const start = point(a),
    end = point(b);
  let dx = end.x - start.x;
  if (dx > 180) dx -= 360;
  if (dx < -180) dx += 360;
  const path = `M${start.x},${start.y} Q${start.x + dx / 2},${Math.max(
    3,
    (start.y + end.y) / 2 - Math.abs(dx) * 0.18,
  )} ${start.x + dx},${end.y}`;
  return (
    <details className="panel p-5">
      <summary className="cursor-pointer font-semibold">
        Reported route · {a.code} → {b.code}
      </summary>
      <svg
        className="w-full max-h-64 mt-4 rounded-lg bg-slate-50"
        viewBox="0 0 360 180"
        role="img"
        aria-label={`Illustration between reported airports ${a.name} and ${b.name}; not a recorded flight path`}
      >
        <g fill="#dae4e8" stroke="#fff" strokeWidth="0.2">
          {ref?.land.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
        {[-360, 0, 360].map(shift => (
          <path
            key={shift}
            d={path}
            transform={`translate(${shift},0)`}
            fill="none"
            stroke="#087f79"
            strokeWidth="1.3"
          />
        ))}
        {[start, end].map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="2" fill="#087f79" />
        ))}
      </svg>
      <p className="text-xs muted mt-3">
        Illustration of participant-reported endpoints, not a recorded flight
        path. Public airport reference: OurAirports; basemap: Natural Earth.
      </p>
    </details>
  );
}
