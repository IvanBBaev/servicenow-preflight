// QA-18 — logical (not wall) clock. Every `sys_created_on` / `sys_updated_on`
// the fake writes must be reproducible across CI runs, so time advances by a
// fixed step per observation instead of reading `Date.now()`.

/** Returns the current instance time in the ServiceNow datetime format. */
export interface FakeClock {
  /** Read and advance: "YYYY-MM-DD HH:mm:ss" (the Table API's format). */
  now(): string;
  /** Ticks elapsed since construction/reset — a deterministic ordering key. */
  ticks(): number;
  reset(): void;
}

/** Fixed logical epoch: 2020-01-01T00:00:00Z. Arbitrary, but never "today". */
export const LOGICAL_EPOCH_MS = Date.UTC(2020, 0, 1, 0, 0, 0);

/** Format epoch millis the way the Table API renders a glide_date_time. */
export function formatSnDateTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * A clock that advances `stepMs` on every read, starting at `startMs`.
 * Two runs that issue the same sequence of writes see the same timestamps.
 */
export function createLogicalClock(
  startMs: number = LOGICAL_EPOCH_MS,
  stepMs = 1000,
): FakeClock {
  let tick = 0;
  return {
    now(): string {
      const value = formatSnDateTime(startMs + tick * stepMs);
      tick += 1;
      return value;
    },
    ticks(): number {
      return tick;
    },
    reset(): void {
      tick = 0;
    },
  };
}
