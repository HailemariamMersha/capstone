// Serializes measurement and ingestion traffic even across rapid UI callbacks.
type Activity = 'measurement' | 'sync' | 'reference' | 'account';
let tripArmed = false;
export const isTripArmed = () => tripArmed;
export const setTripArmed = (value: boolean) => {
  tripArmed = value;
};
type Lease = { kind: Activity; interrupt?: () => void };
let active: Lease | null = null;
let handoff: ((release: () => void) => void) | null = null;
export const currentActivity = () => active?.kind ?? null;
export function acquireActivity(
  next: Activity,
  interrupt?: () => void,
): () => void {
  if (tripArmed && next !== 'measurement' && next !== 'sync')
    throw new Error('Stop the trip first.');
  if (active)
    throw new Error(
      `Wait for ${active.kind} to finish before starting ${next}.`,
    );
  const lease: Lease = { kind: next, interrupt };
  active = lease;
  let released = false;
  return () => {
    if (released || active !== lease) return;
    released = true;
    active = null;
    if (handoff) {
      const ready = handoff;
      handoff = null;
      // Transfer the lease synchronously: another upload cannot take the gap.
      ready(acquireActivity('measurement'));
    }
  };
}
/** A user starting collection takes priority over cancellable background uploads. */
export function acquireMeasurementActivity(): Promise<() => void> {
  if (!active) return Promise.resolve(acquireActivity('measurement'));
  if (handoff) return Promise.reject(new Error('A trip is already starting.'));
  if (active.kind !== 'sync' || !active.interrupt)
    return Promise.reject(
      new Error(
        `Wait for ${active.kind} to finish before starting measurement.`,
      ),
    );
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      handoff = null;
      // Never force-unlock a request that has not actually stopped.
      reject(
        new Error(
          'The upload is still stopping. Your data is saved; try Start again shortly.',
        ),
      );
    }, 5000);
    handoff = release => {
      clearTimeout(timeout);
      resolve(release);
    };
    try {
      active!.interrupt!();
    } catch {
      clearTimeout(timeout);
      handoff = null;
      reject(
        new Error('Could not pause the upload. Your saved data is retained.'),
      );
    }
  });
}
