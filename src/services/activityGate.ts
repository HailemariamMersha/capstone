// Serializes measurement and ingestion traffic even across rapid UI callbacks.
type Activity = 'measurement' | 'sync' | 'reference' | 'account';
let tripArmed = false;
export const isTripArmed = () => tripArmed;
export const setTripArmed = (value: boolean) => {
  tripArmed = value;
};
let activity: Activity | null = null;
export const currentActivity = () => activity;
export function acquireActivity(next: Activity): () => void {
  if (tripArmed && next !== 'measurement' && next !== 'sync')
    throw new Error('Stop the trip first.');
  if (activity) {
    throw new Error(`Wait for ${activity} to finish before starting ${next}.`);
  }
  activity = next;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activity = null;
    }
  };
}
