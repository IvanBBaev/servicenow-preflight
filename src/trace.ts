import { AsyncLocalStorage } from "node:async_hooks";
import { channel, type Channel } from "node:diagnostics_channel";

/**
 * Local-only run diagnostics (F-X-5). The client and the runner publish on
 * `node:diagnostics_channel`, so they stay decoupled from whoever listens —
 * `--timings`, `--trace`, or a library caller. With no subscriber, nothing is
 * built: every publisher checks `hasSubscribers` first.
 *
 * Nothing here leaves the machine. The trace is allowlisted field by field:
 * it never carries query values, row data, headers, credentials or user
 * names — only the table (or a templated path), timings and statuses.
 */

/** A Table API request or a read served from the run's read cache. */
export interface HttpMessage {
  method: string;
  /** The request path, without the query string. */
  path: string;
  /** HTTP status; absent on a cache hit or a request that never got one. */
  status?: number;
  /** Request duration in milliseconds (0 for a cache hit). */
  ms: number;
  /** 1 for the first try, 2+ for a `429` retry; absent on a cache hit. */
  attempt?: number;
  /** The `Retry-After` wait a `429` asked for. */
  retryAfterMs?: number;
  /** `hit`: served from the read cache; `miss`: loaded into it; `off`: uncached. */
  cache: "hit" | "miss" | "off";
  /** Why no status came back. */
  error?: "network" | "timeout" | "aborted";
}

/** A check starting or ending. */
export type CheckMessage =
  | { phase: "start"; check: string }
  | { phase: "end"; check: string; status: string; ms: number };

/** A run starting or ending. */
export type RunMessage =
  | { phase: "start"; checks: number; concurrency: number }
  | {
      phase: "end";
      ms: number;
      summary: { pass: number; warn: number; fail: number };
    };

/** Channel names, for subscribers outside this package. */
export const TRACE_CHANNELS = {
  http: "snpf:http",
  check: "snpf:check",
  run: "snpf:run",
} as const;

const httpChannel: Channel = channel(TRACE_CHANNELS.http);
const checkChannel: Channel = channel(TRACE_CHANNELS.check);
const runChannel: Channel = channel(TRACE_CHANNELS.run);

/** The check the current async flow runs under; set by the runner. */
export const checkScope = new AsyncLocalStorage<string>();

/** `miss` while a read-cache load runs, so its requests are marked as such. */
export const cacheScope = new AsyncLocalStorage<"miss">();

/** Whether anyone listens for request events (build nothing otherwise). */
export function httpTraced(): boolean {
  return httpChannel.hasSubscribers;
}

/** Publish a request event, tagged with the current check. */
export function publishHttp(message: Omit<HttpMessage, "cache">): void {
  if (!httpChannel.hasSubscribers) return;
  httpChannel.publish({
    ...message,
    cache: cacheScope.getStore() ?? "off",
    check: checkScope.getStore(),
  });
}

/** Publish a read the cache answered, tagged with the current check. */
export function publishCacheHit(method: string, path: string): void {
  if (!httpChannel.hasSubscribers) return;
  httpChannel.publish({
    method,
    path,
    ms: 0,
    cache: "hit",
    check: checkScope.getStore(),
  });
}

export function publishCheck(message: CheckMessage): void {
  if (checkChannel.hasSubscribers) checkChannel.publish(message);
}

export function publishRun(message: RunMessage): void {
  if (runChannel.hasSubscribers) runChannel.publish(message);
}

/** Subscribe `on` to every trace channel; returns the unsubscribe. */
function subscribeAll(on: {
  http: (m: Record<string, unknown>) => void;
  check: (m: Record<string, unknown>) => void;
  run: (m: Record<string, unknown>) => void;
}): () => void {
  const pairs: [Channel, (m: unknown) => void][] = [
    [httpChannel, (m) => on.http(m as Record<string, unknown>)],
    [checkChannel, (m) => on.check(m as Record<string, unknown>)],
    [runChannel, (m) => on.run(m as Record<string, unknown>)],
  ];
  for (const [ch, fn] of pairs) ch.subscribe(fn);
  return () => {
    for (const [ch, fn] of pairs) ch.unsubscribe(fn);
  };
}

// --- allowlist ---------------------------------------------------------------

const NAME = /^[A-Za-z0-9_.:$-]{1,200}$/;
const METHOD = /^[A-Z]{1,10}$/;
const SYS_ID = /^[0-9a-f]{32}$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9_.$-]{1,80}$/;

const str = (v: unknown, re: RegExp): string | undefined =>
  typeof v === "string" && re.test(v) ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const oneOf = <T extends string>(
  v: unknown,
  allowed: readonly T[],
): T | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined;

/** Copy only the defined values, in a fixed key order. */
function compact(
  entries: [string, unknown][],
): Record<string, string | number | object> {
  const out: Record<string, string | number | object> = {};
  for (const [key, value] of entries) {
    if (value !== undefined) out[key] = value as string | number | object;
  }
  return out;
}

/**
 * Where a request went, with nothing identifying a record: a Table API path
 * becomes its table; any other path keeps its fixed segments, a sys_id becomes
 * `:id` and anything else variable becomes `:value`.
 */
export function requestTarget(path: string): {
  table?: string;
  path?: string;
} {
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  const table = /^\/api\/now\/table\/([^/]+)/.exec(bare)?.[1];
  if (table !== undefined) {
    let name: string;
    try {
      name = decodeURIComponent(table);
    } catch {
      name = "";
    }
    return SAFE_SEGMENT.test(name) ? { table: name } : { path: ":table" };
  }
  const template = bare
    .split("/")
    .map((seg) =>
      seg === "" || (SAFE_SEGMENT.test(seg) && !SYS_ID.test(seg))
        ? seg
        : SYS_ID.test(seg)
          ? ":id"
          : ":value",
    )
    .join("/");
  return { path: template };
}

/** The allowlisted trace line for a request event. */
export function httpEvent(m: Record<string, unknown>, ts: string) {
  const target = requestTarget(typeof m.path === "string" ? m.path : "");
  return compact([
    ["type", "http"],
    ["ts", ts],
    ["check", str(m.check, NAME)],
    ["method", str(m.method, METHOD)],
    ["table", target.table],
    ["path", target.path],
    ["status", num(m.status)],
    ["ms", num(m.ms)],
    ["attempt", num(m.attempt)],
    ["retryAfterMs", num(m.retryAfterMs)],
    ["cache", oneOf(m.cache, ["hit", "miss", "off"] as const)],
    ["error", oneOf(m.error, ["network", "timeout", "aborted"] as const)],
  ]);
}

function checkEvent(m: Record<string, unknown>, ts: string) {
  const phase = oneOf(m.phase, ["start", "end"] as const);
  if (!phase) return undefined;
  return compact([
    ["type", `check.${phase}`],
    ["ts", ts],
    ["check", str(m.check, NAME)],
    ["status", oneOf(m.status, ["pass", "warn", "fail"] as const)],
    ["ms", num(m.ms)],
  ]);
}

function runEvent(
  m: Record<string, unknown>,
  ts: string,
  fields: TraceRunFields,
) {
  const phase = oneOf(m.phase, ["start", "end"] as const);
  if (!phase) return undefined;
  const summary = m.summary as Record<string, unknown> | undefined;
  return compact([
    ["type", `run.${phase}`],
    ["ts", ts],
    ...(phase === "start"
      ? ([
          ["version", str(fields.version, NAME)],
          ["instanceHost", str(fields.instanceHost, NAME)],
          ["checks", num(m.checks)],
          ["concurrency", num(m.concurrency)],
        ] as [string, unknown][])
      : ([
          ["ms", num(m.ms)],
          [
            "summary",
            summary
              ? {
                  pass: num(summary.pass) ?? 0,
                  warn: num(summary.warn) ?? 0,
                  fail: num(summary.fail) ?? 0,
                }
              : undefined,
          ],
        ] as [string, unknown][])),
  ]);
}

/** Static fields the `run.start` event carries. */
export interface TraceRunFields {
  version?: string;
  /** The instance host name (no scheme, port or path). */
  instanceHost?: string;
}

export interface Tracer {
  /** Set the fields the next `run.start` carries (one run per instance). */
  setRun(fields: TraceRunFields): void;
  /** Stop listening. Idempotent. */
  close(): void;
}

/**
 * Write every trace event as one allowlisted NDJSON line to `write`. Events
 * that do not fit the allowlist lose the offending fields, never gain any.
 */
export function createTracer(
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): Tracer {
  let fields: TraceRunFields = {};
  const emit = (event: object | undefined): void => {
    if (event) write(`${JSON.stringify(event)}\n`);
  };
  const ts = (): string => now().toISOString();
  let stop: (() => void) | undefined = subscribeAll({
    http: (m) => emit(httpEvent(m, ts())),
    check: (m) => emit(checkEvent(m, ts())),
    run: (m) => emit(runEvent(m, ts(), fields)),
  });
  return {
    setRun(next) {
      fields = { ...next };
    },
    close() {
      stop?.();
      stop = undefined;
    },
  };
}

// --- timings -----------------------------------------------------------------

/** One check's share of a run (F-X-5 `--timings`). */
export interface CheckTiming {
  check: string;
  /** Wall-clock milliseconds from the check's start to its verdict. */
  ms: number;
  /** HTTP requests sent (cache hits excluded, retries included). */
  requests: number;
  /** Requests that were a `429` retry. */
  retries: number;
  /** Reads answered by the run's read cache. */
  cacheHits: number;
}

/** Per-check and whole-run timings for one instance. */
export interface RunTimings {
  /** Wall-clock milliseconds for the whole run. */
  ms: number;
  requests: number;
  retries: number;
  cacheHits: number;
  /** One entry per check that started, in registry order. */
  checks: CheckTiming[];
}

export interface TimingsCollector {
  /** Stop listening and return what was seen; `order` sorts the checks. */
  stop(order?: readonly string[]): RunTimings;
}

/** Collect {@link RunTimings} from the trace channels until `stop()`. */
export function collectTimings(): TimingsCollector {
  const checks = new Map<string, CheckTiming>();
  const totals = { ms: 0, requests: 0, retries: 0, cacheHits: 0 };
  const entry = (name: string): CheckTiming => {
    let found = checks.get(name);
    if (!found) {
      found = { check: name, ms: 0, requests: 0, retries: 0, cacheHits: 0 };
      checks.set(name, found);
    }
    return found;
  };
  const unsubscribe = subscribeAll({
    http: (m) => {
      const own = typeof m.check === "string" ? entry(m.check) : undefined;
      if (m.cache === "hit") {
        totals.cacheHits += 1;
        if (own) own.cacheHits += 1;
        return;
      }
      const retry = typeof m.attempt === "number" && m.attempt > 1 ? 1 : 0;
      totals.requests += 1;
      totals.retries += retry;
      if (own) {
        own.requests += 1;
        own.retries += retry;
      }
    },
    check: (m) => {
      if (typeof m.check !== "string") return;
      const own = entry(m.check);
      if (m.phase === "end" && typeof m.ms === "number") own.ms = m.ms;
    },
    run: (m) => {
      if (m.phase === "end" && typeof m.ms === "number") totals.ms += m.ms;
    },
  });
  return {
    stop(order) {
      unsubscribe();
      const list = [...checks.values()];
      if (order) {
        const at = new Map(order.map((name, i) => [name, i]));
        list.sort(
          (a, b) =>
            (at.get(a.check) ?? Number.MAX_SAFE_INTEGER) -
            (at.get(b.check) ?? Number.MAX_SAFE_INTEGER),
        );
      }
      return { ...totals, checks: list.map((c) => ({ ...c })) };
    },
  };
}

/** Render {@link RunTimings} as a fixed-width table (stderr `--timings`). */
export function formatTimings(timings: RunTimings, title?: string): string {
  const header = ["check", "ms", "requests", "retries", "cache hits"];
  const rows = timings.checks.map((c) => [
    c.check,
    String(Math.round(c.ms)),
    String(c.requests),
    String(c.retries),
    String(c.cacheHits),
  ]);
  rows.push([
    "total",
    String(Math.round(timings.ms)),
    String(timings.requests),
    String(timings.retries),
    String(timings.cacheHits),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) =>
        i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0),
      )
      .join("  ")
      .trimEnd();
  const out = [line(header), ...rows.map(line)];
  return `${title ? `Timings (${title}):\n` : "Timings:\n"}${out.join("\n")}\n`;
}
