import { csvCell, measurementCsv } from '../src/export/serialize';
test('CSV escapes multiline text, quotes and spreadsheet formulas', () => {
  expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  expect(csvCell('=1+1')).toBe('"\'=1+1"');
  expect(csvCell(null)).toBe('""');
  const csv = measurementCsv([
    { id: 'm', success: false, errorMessage: 'offline' },
  ]);
  expect(csv).toContain('"false"');
  expect(csv).toContain('"offline"');
  expect(csv.endsWith('\r\n')).toBe(true);
});
