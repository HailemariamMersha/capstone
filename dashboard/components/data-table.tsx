'use client';
import { useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { csvText } from '@/lib/evidence';

export function DataTable<T>({
  rows,
  columns,
  paginate = false,
  name,
  defaultColumns,
  exportName = 'filtered-observations.csv',
}: {
  rows: T[];
  columns: ColumnDef<T>[];
  paginate?: boolean;
  name?: string;
  defaultColumns?: string[];
  exportName?: string;
}) {
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const defaults = () =>
    Object.fromEntries(
      columns.map(c => {
        const id = c.id ?? ('accessorKey' in c ? String(c.accessorKey) : '');
        return [id, !defaultColumns || defaultColumns.includes(id)];
      }),
    );
  const [columnVisibility, setColumnVisibility] =
    useState<VisibilityState>(defaults);
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: paginate ? getPaginationRowModel() : undefined,
    getSortedRowModel: name ? getSortedRowModel() : undefined,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    sortDescFirst: false,
    onColumnVisibilityChange: setColumnVisibility,
    initialState: { pagination: { pageIndex: 0, pageSize: 50 } },
  });
  const visible = table.getVisibleLeafColumns();
  function exportRows() {
    const text = csvText(
      visible.map(c => c.id),
      table
        .getPrePaginationRowModel()
        .rows.map(r => visible.map(c => r.getValue(c.id))),
    );
    const url = URL.createObjectURL(
      new Blob([text], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div
      className="space-y-3"
      role={name ? 'region' : undefined}
      aria-label={name}
    >
      {name && (
        <div className="panel p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm muted" role="status">
              {rows.length} matching rows · {visible.length} columns shown
            </p>
            <Button
              variant="outline"
              onClick={exportRows}
              disabled={!rows.length}
            >
              Download visible columns CSV
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer font-medium py-2">
              Choose columns
            </summary>
            <label className="block mt-3">
              Find a column
              <input
                className="block mt-2 w-full"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="For example: TTL, bytes or timing"
              />
            </label>
            <div className="flex gap-3 my-3">
              <Button
                variant="ghost"
                onClick={() => table.setColumnVisibility({})}
              >
                Show all columns
              </Button>
              <Button
                variant="ghost"
                onClick={() => table.setColumnVisibility(defaults())}
              >
                Restore default columns
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 max-h-80 overflow-y-auto">
              {table
                .getAllLeafColumns()
                .filter(c =>
                  `${c.columnDef.header} ${c.id}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map(c => (
                  <label
                    key={c.id}
                    className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      style={{ minHeight: 20 }}
                      checked={c.getIsVisible()}
                      disabled={c.getIsVisible() && visible.length === 1}
                      onChange={c.getToggleVisibilityHandler()}
                    />
                    <span>
                      {String(c.columnDef.header)}
                      <span className="block muted text-xs mt-1">
                        {(
                          c.columnDef.meta as
                            | { description?: string }
                            | undefined
                        )?.description ?? c.id}
                      </span>
                    </span>
                  </label>
                ))}
            </div>
          </details>
          <p className="text-xs muted">
            CSV includes all matching rows across pages, using the shown columns
            and sort order. Empty cells mean unavailable.
          </p>
        </div>
      )}
      <div className="panel overflow-x-auto">
        <table className="w-full" aria-label={name}>
          <thead>
            {table.getHeaderGroups().map(g => (
              <tr key={g.id}>
                {g.headers.map(h => (
                  <th
                    key={h.id}
                    scope="col"
                    aria-sort={
                      name
                        ? h.column.getIsSorted() === 'asc'
                          ? 'ascending'
                          : h.column.getIsSorted() === 'desc'
                          ? 'descending'
                          : 'none'
                        : undefined
                    }
                  >
                    {name && h.column.getCanSort() ? (
                      <button
                        className="text-left min-h-11"
                        onClick={h.column.getToggleSortingHandler()}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}{' '}
                        {h.column.getIsSorted() === 'asc'
                          ? '↑'
                          : h.column.getIsSorted() === 'desc'
                          ? '↓'
                          : '↕'}
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map(r => (
              <tr key={r.id} className="hover:bg-slate-50">
                {r.getVisibleCells().map(c => (
                  <td key={c.id}>
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {paginate && rows.length > 50 && (
          <div className="flex flex-wrap justify-between items-center gap-4 p-4">
            <Button
              variant="outline"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              Previous observations
            </Button>
            <span className="text-sm muted">
              Page {table.getState().pagination.pageIndex + 1} of{' '}
              {table.getPageCount()}
            </span>
            <Button
              variant="outline"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              Next observations
            </Button>
          </div>
        )}
        {!rows.length && (
          <p className="p-8 muted">
            No received records match this view. Adjust or reset the filters.
          </p>
        )}
      </div>
    </div>
  );
}
