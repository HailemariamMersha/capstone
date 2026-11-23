/** Compose cancellation and timeout while preserving the first cancellation cause. */
export function deadline(timeoutMs: number, parent?: AbortSignal | null) {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    expired = true;
    controller.abort();
  }, timeoutMs);
  const cancel = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (parent?.aborted) cancel();
  else parent?.addEventListener('abort', cancel);
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', cancel);
    },
  };
}
