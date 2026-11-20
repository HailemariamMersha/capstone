/** Foreground wake-ups complement Android's opportunistic background jobs. */
export function createRetryScheduler(deps: {
  nextAttempt(): Promise<number | null>;
  run(): Promise<void>;
  now(): number;
}) {
  let active = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  async function schedule() {
    const current = generation;
    if (!active || running) return;
    if (timer !== undefined) clearTimeout(timer);
    try {
      const next = await deps.nextAttempt();
      if (!active || current !== generation) return;
      // New consent/identity or a just-closed trip can create pending work
      // without another network/AppState event. Discover it while visible.
      if (next == null) {
        timer = setTimeout(() => void schedule(), 30000);
        return;
      }
      timer = setTimeout(async () => {
        if (!active || current !== generation || running) return;
        running = true;
        try {
          await deps.run();
        } catch {
          /* Durable queue retains errors/backoff. */
        } finally {
          running = false;
          if (active) void schedule();
        }
      }, Math.max(1000, Math.min(3600000, next - deps.now())));
    } catch {
      if (active && current === generation)
        timer = setTimeout(() => void schedule(), 30000);
    }
  }
  return {
    setActive(value: boolean) {
      active = value;
      generation++;
      if (timer !== undefined) clearTimeout(timer);
      if (active) void schedule();
    },
    wake() {
      generation++;
      if (active) void schedule();
    },
  };
}
