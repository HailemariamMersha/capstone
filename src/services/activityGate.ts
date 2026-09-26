// Serializes measurement and ingestion traffic even across rapid UI callbacks.
let activity: 'measurement' | 'sync' | null = null;
export const currentActivity = () => activity;
export function acquireActivity(next: 'measurement' | 'sync'): () => void {
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
