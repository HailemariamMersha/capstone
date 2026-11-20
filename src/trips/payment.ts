/** Participant-reported payment identifier; never put it in measurement evidence. */
export function normalizeNetId(value: string): string {
  const netId = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{1,31}$/.test(netId))
    throw new Error('Enter your NYU NetID, such as abc123, without @nyu.edu.');
  return netId;
}
