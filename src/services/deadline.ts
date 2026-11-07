/** Compose cancellation and timeout; supplying a parent must never disable a deadline. */
export function deadline(timeoutMs: number, parent?: AbortSignal | null) {
  const controller = new AbortController();
  let expired = false;
  const cancel = () => controller.abort();
  if (parent?.aborted) cancel();
  else parent?.addEventListener('abort', cancel);
  const timer = setTimeout(() => {
    expired = true;
    cancel();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', cancel);
    },
  };
}
