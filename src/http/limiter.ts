import { abortReason, sleep as abortableSleep } from "./abort.js";

/**
 * Client-side request limiter: an in-flight cap plus an optional token bucket
 * (F-X-1), so a run cannot trip an instance's inbound REST rate limit or starve
 * its other integrations. Grants are FIFO. The bucket holds one token and
 * refills on demand at `rps` — there is no interval timer; a single wake-up is
 * scheduled only while a caller is actually waiting.
 */

/** Gives back the slot an {@link Limiter.acquire} granted. Idempotent. */
export type Release = () => void;

export interface Limiter {
  /**
   * Wait for a slot (and a token, when `rps` is set). Rejects with the abort
   * reason — and leaves the queue — if `signal` aborts first.
   */
  acquire(signal?: AbortSignal): Promise<Release>;
  /** Grant nothing new for `ms` milliseconds (a 429's `Retry-After`). */
  pause(ms: number): void;
}

export interface LimiterOptions {
  /** Most requests in flight at once (default: unlimited). */
  maxInFlight?: number;
  /** Requests started per second (default: unlimited). */
  rps?: number;
  /** Clock, injectable for tests (default `Date.now`). */
  now?: () => number;
  /** Timer, injectable for tests (default `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
}

interface Waiter {
  grant: (release: Release) => void;
}

export function createLimiter(opts: LimiterOptions = {}): Limiter {
  const maxInFlight = opts.maxInFlight ?? Number.POSITIVE_INFINITY;
  const rps = opts.rps;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? ((ms: number) => abortableSleep(ms));

  const queue: Waiter[] = [];
  let inFlight = 0;
  let tokens = 1;
  let refilledAt = now();
  let pausedUntil = 0;
  let waking = false;

  function release(): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      inFlight -= 1;
      pump();
    };
  }

  /** Milliseconds until the next grant is possible, or 0 when it is now. */
  function delay(at: number): number {
    if (at < pausedUntil) return pausedUntil - at;
    if (rps === undefined) return 0;
    tokens = Math.min(1, tokens + ((at - refilledAt) / 1000) * rps);
    refilledAt = at;
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) / rps) * 1000);
  }

  function pump(): void {
    while (queue.length > 0 && inFlight < maxInFlight) {
      const ms = delay(now());
      if (ms > 0) {
        if (!waking) {
          waking = true;
          void wait(ms).then(() => {
            waking = false;
            pump();
          });
        }
        return;
      }
      if (rps !== undefined) tokens -= 1;
      inFlight += 1;
      (queue.shift() as Waiter).grant(release());
    }
  }

  return {
    acquire(signal?: AbortSignal): Promise<Release> {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      return new Promise<Release>((resolve, reject) => {
        const onAbort = (): void => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          reject(abortReason(signal as AbortSignal));
        };
        const waiter: Waiter = {
          grant: (r) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(r);
          },
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(waiter);
        pump();
      });
    },
    pause(ms: number): void {
      if (!(ms > 0)) return;
      pausedUntil = Math.max(pausedUntil, now() + ms);
    },
  };
}

/** Bounds of {@link LimiterOptions.maxInFlight}. */
export const MAX_IN_FLIGHT_RANGE = { min: 1, max: 64 } as const;
/** Bounds of {@link LimiterOptions.rps}. */
export const RPS_RANGE = { min: 0.5, max: 100 } as const;

/**
 * Why `value` is not a valid `name` limit, or `undefined` when it is. Shared by
 * the client (which throws `SnError`) and the CLI / config (`UsageError`).
 */
export function limitProblem(
  name: "maxInFlight" | "rps",
  value: number,
): string | undefined {
  if (name === "maxInFlight") {
    const { min, max } = MAX_IN_FLIGHT_RANGE;
    return Number.isInteger(value) && value >= min && value <= max
      ? undefined
      : `must be a whole number between ${min} and ${max}`;
  }
  const { min, max } = RPS_RANGE;
  return Number.isFinite(value) && value >= min && value <= max
    ? undefined
    : `must be a number between ${min} and ${max}`;
}
