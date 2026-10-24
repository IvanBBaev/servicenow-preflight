import { abortReason, raceAbort } from "./abort.js";

/**
 * Run-scoped, in-memory, single-flight read cache (F-X-2). Identical Table API
 * reads made by different checks share one fetch. Only settled successes stay
 * cached: a rejected load is evicted, so a later caller fetches again. Nothing
 * is ever written to disk; the cache lives and dies with its client.
 *
 * Cancellation is per caller. Each caller races the shared load against its
 * own signal, and the load itself is aborted only once every caller still
 * waiting on it has given up — so one check's timeout never fails another
 * check's identical read.
 */

export interface ReadCacheStats {
  /** Reads answered from an existing (settled or in-flight) entry. */
  hits: number;
  /** Reads that started a load. */
  misses: number;
}

export interface ReadCache {
  /**
   * The value cached under `key`, loading it with `load` on a miss. Rejects
   * with the abort reason when `signal` aborts first.
   */
  get<T>(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  /** Hit / miss counters since the cache was created. */
  stats(): ReadCacheStats;
}

interface Entry {
  promise: Promise<unknown>;
  controller: AbortController;
  settled: boolean;
  /** Callers waiting on the load that can still abort; `Infinity` once one cannot. */
  waiting: number;
}

export function createReadCache(): ReadCache {
  const entries = new Map<string, Entry>();
  const counts: ReadCacheStats = { hits: 0, misses: 0 };

  function start(key: string, load: (signal: AbortSignal) => Promise<unknown>) {
    const controller = new AbortController();
    const entry: Entry = {
      promise: Promise.resolve(),
      controller,
      settled: false,
      waiting: 0,
    };
    entry.promise = load(controller.signal).then(
      (value) => {
        entry.settled = true;
        return value;
      },
      (err: unknown) => {
        entry.settled = true;
        if (entries.get(key) === entry) entries.delete(key);
        throw err;
      },
    );
    // Callers observe the rejection through their own race; keep the shared
    // promise itself from surfacing as unhandled.
    entry.promise.catch(() => undefined);
    entries.set(key, entry);
    return entry;
  }

  return {
    get<T>(
      key: string,
      load: (signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      let entry = entries.get(key);
      if (entry) counts.hits += 1;
      else {
        counts.misses += 1;
        entry = start(key, load);
      }
      const promise = entry.promise as Promise<T>;
      if (entry.settled) return promise;
      if (!signal) {
        // A caller that cannot abort keeps the load alive for good.
        entry.waiting = Number.POSITIVE_INFINITY;
        return promise;
      }
      const current = entry;
      current.waiting += 1;
      const onAbort = (): void => {
        current.waiting -= 1;
        if (current.waiting > 0 || current.settled) return;
        // Nobody wants this load any more: drop it before aborting, so a
        // caller arriving next starts a fresh one instead of joining a corpse.
        if (entries.get(key) === current) entries.delete(key);
        current.controller.abort(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const done = (): void => signal.removeEventListener("abort", onAbort);
      promise.then(done, done);
      return raceAbort(promise, signal);
    },
    stats: () => ({ ...counts }),
  };
}

/**
 * The cache key of a Table API read: the table plus every `sysparm_*`
 * parameter, in a canonical order. `sysparm_fields` is order-insensitive, so
 * its list is trimmed and sorted; blank parameters are dropped.
 */
export function readKey(
  table: string,
  params: Record<string, string> | undefined,
): string {
  const canonical: [string, string][] = [];
  for (const [name, raw] of Object.entries(params ?? {})) {
    let value = String(raw).trim();
    if (value === "") continue;
    if (name === "sysparm_fields") {
      value = value
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f !== "")
        .sort()
        .join(",");
    }
    canonical.push([name, value]);
  }
  canonical.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([table, canonical]);
}

/** Freeze `value` and every plain object / array inside it. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
