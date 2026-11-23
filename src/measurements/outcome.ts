/** Shared by mobile, dashboard and the offline analysis command. Raw success and
 * error fields stay unchanged; cancellations are not network failures. */
export type MeasurementOutcome =
  | 'success'
  | 'failure'
  | 'interrupted'
  | 'unavailable';
export function measurementOutcome(value: {
  success?: unknown;
  errorType?: unknown;
}): MeasurementOutcome {
  if (value.success === true) return 'success';
  if (value.success !== false) return 'unavailable';
  return value.errorType === 'cancelled' || value.errorType === 'interrupted'
    ? 'interrupted'
    : 'failure';
}
