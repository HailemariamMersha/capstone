'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';

type Payment = {
  tripId: string;
  participantId: string;
  netId: string;
  flight: { flightNumber?: string };
  startedAt: number;
  receivedAt: string;
};
/** Mount only for administrators. Server authorization is independently enforced. */
export function PaymentReconciliation() {
  const [offset, setOffset] = useState(0);
  const data = useQuery<{ items: Payment[]; total: number }>({
    queryKey: ['admin-payments', offset],
    queryFn: ({ signal }) =>
      api(`/admin/payments?offset=${offset}&limit=25`, { signal }),
    retry: false,
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    gcTime: 0,
  });
  return (
    <section className="panel p-6 space-y-4">
      <h2 className="text-xl font-semibold">Payment reconciliation</h2>
      <p className="muted">
        Administrator-only, participant-reported NetIDs. These do not verify
        flight attendance or payment eligibility.
      </p>
      {data.isPending ? (
        <p role="status">Loading payment details…</p>
      ) : data.error ? (
        <p role="alert">Payment details could not be loaded.</p>
      ) : (
        <DataTable
          rows={data.data?.items ?? []}
          columns={[
            { accessorKey: 'netId', header: 'NetID' },
            { accessorKey: 'participantId', header: 'Participant' },
            { accessorKey: 'tripId', header: 'Trip' },
            {
              id: 'flight',
              header: 'Reported flight',
              cell: c => c.row.original.flight.flightNumber ?? 'Unavailable',
            },
            {
              accessorKey: 'startedAt',
              header: 'Started',
              cell: c => new Date(Number(c.getValue())).toLocaleString(),
            },
          ]}
        />
      )}
      <div className="flex gap-3">
        <Button
          variant="outline"
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 25))}
        >
          Previous payments
        </Button>
        <Button
          variant="outline"
          disabled={offset + 25 >= (data.data?.total ?? 0)}
          onClick={() => setOffset(offset + 25)}
        >
          Next payments
        </Button>
      </div>
    </section>
  );
}
