// Serializes measurement and ingestion traffic even across rapid UI callbacks.
type Activity = 'measurement' | 'sync' | 'reference';
let activity: Activity | null = null;
export const currentActivity = () => activity;
export function acquireActivity(next: Activity): () => void {
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
