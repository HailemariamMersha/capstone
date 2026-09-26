// Prefix spreadsheet formula characters, then apply RFC 4180 quoting.
export function csvCell(value: unknown): string {
  let text =
    value == null
      ? ''
      : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  if (/^[=+@\-\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}
export function measurementCsv(records: Record<string, unknown>[]): string {
  const columns = [
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
    'networkSnapshot',
  ];
  return (
    [
      columns.map(csvCell).join(','),
      ...records.map(row => columns.map(key => csvCell(row[key])).join(',')),
    ].join('\r\n') + '\r\n'
  );
}
