// QA-18 / DESIGN §4b — fault injection.
//
// The Tier-2 crash-injection suite needs the fake to fail in the two windows
// the write-ahead intent ledger defines:
//
//   §4b W1 — after intend, before write: the mutation must NOT land. Express
//            with `http-error` or `transport-error`.
//   §4b W2 — after write, before confirm: the mutation MUST land while the
//            caller never learns the sys_id. Express with `crash-after-write`.
//
// A third mode, `hang`, models DEV-2's poll deadline (`running → abandoned`).
//
// Everything is opt-in per rule and deterministic: rules are evaluated in
// insertion order, the first match wins, and each rule may carry a `times`
// budget. No randomness, no wall-clock scheduling decisions.

import { FakeAbortError, FakeTransportError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type FaultMode =
  /** Answer with an HTTP error; state is untouched (§4b W1). */
  | { kind: "http-error"; status: number; message?: string; body?: unknown }
  /** Reject like a dropped connection; state is untouched (§4b W1). */
  | { kind: "transport-error"; message?: string }
  /**
   * Apply the mutation, THEN fail (§4b W2). With `status` the caller sees an
   * HTTP error; without it the connection drops — both leave the instance
   * holding a record the caller cannot name.
   */
  | { kind: "crash-after-write"; status?: number; message?: string }
  /**
   * Stall. With `ms` the request completes normally after the delay (a slow
   * instance); without `ms` it never settles until the caller's `AbortSignal`
   * fires, which is how a poll deadline is exercised.
   */
  | { kind: "hang"; ms?: number };

export interface FaultMatch {
  /** One method or a set; absent matches every method. */
  method?: HttpMethod | readonly HttpMethod[];
  /** String = path prefix, RegExp = tested against the path. */
  path?: string | RegExp;
  /** Table name for `/api/now/table/<table>[/<sysId>]` requests. */
  table?: string;
  /** Row id for `/api/now/table/<table>/<sysId>` requests. */
  sysId?: string;
  /** Fire at most this many times (default: unlimited). */
  times?: number;
}

export interface FaultRule {
  /** Caller-supplied id; one is derived from the insertion ordinal if absent. */
  id?: string;
  match: FaultMatch;
  mode: FaultMode;
}

/** What the registry matches against — filled in by the router. */
export interface FaultTarget {
  method: HttpMethod;
  path: string;
  table?: string;
  sysId?: string;
}

export interface RegisteredFault extends FaultRule {
  id: string;
  /** How many times this rule has fired. */
  fired: number;
  /** Remaining budget; `Infinity` when `times` was absent. */
  remaining: number;
}

export interface FaultRegistry {
  /** Register a rule; returns its id. */
  add(rule: FaultRule): string;
  /** Remove a rule by id; `false` when it was not registered. */
  remove(id: string): boolean;
  /** Every rule, in evaluation order. */
  list(): RegisteredFault[];
  /**
   * First rule matching `target` that still has budget, consuming one unit.
   * Called exactly once per request by the router.
   */
  take(target: FaultTarget): FaultMode | undefined;
  /** Rule ids in the order they fired — an assertion aid. */
  history(): string[];
  clear(): void;
}

function methodMatches(match: FaultMatch, method: HttpMethod): boolean {
  if (match.method === undefined) return true;
  return typeof match.method === "string"
    ? match.method === method
    : match.method.includes(method);
}

function pathMatches(match: FaultMatch, path: string): boolean {
  if (match.path === undefined) return true;
  return typeof match.path === "string"
    ? path.startsWith(match.path)
    : match.path.test(path);
}

export function createFaultRegistry(): FaultRegistry {
  const rules: RegisteredFault[] = [];
  const fired: string[] = [];
  let ordinal = 0;

  return {
    add(rule) {
      ordinal += 1;
      const id = rule.id ?? `fault-${ordinal}`;
      if (rules.some((existing) => existing.id === id)) {
        throw new Error(`fault rule "${id}" is already registered`);
      }
      rules.push({
        ...rule,
        id,
        fired: 0,
        remaining: rule.match.times ?? Number.POSITIVE_INFINITY,
      });
      return id;
    },

    remove(id) {
      const at = rules.findIndex((rule) => rule.id === id);
      if (at < 0) return false;
      rules.splice(at, 1);
      return true;
    },

    list() {
      return rules.map((rule) => ({ ...rule }));
    },

    take(target) {
      for (const rule of rules) {
        if (rule.remaining <= 0) continue;
        if (!methodMatches(rule.match, target.method)) continue;
        if (!pathMatches(rule.match, target.path)) continue;
        if (
          rule.match.table !== undefined &&
          rule.match.table !== target.table
        ) {
          continue;
        }
        if (
          rule.match.sysId !== undefined &&
          rule.match.sysId !== target.sysId
        ) {
          continue;
        }
        rule.fired += 1;
        rule.remaining -= 1;
        fired.push(rule.id);
        return rule.mode;
      }
      return undefined;
    },

    history() {
      return [...fired];
    },

    clear() {
      rules.length = 0;
      fired.length = 0;
      ordinal = 0;
    },
  };
}

/**
 * Wait for `ms`, or (when `ms` is absent) until `signal` aborts. Rejects with
 * the signal's own reason when it is an `Error`, so the transport sees the same
 * `TimeoutError` a real `AbortSignal.timeout` produces.
 */
export function stall(
  ms: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abortReason = (): Error => {
      const reason: unknown = signal?.reason;
      return reason instanceof Error ? reason : new FakeAbortError();
    };
    if (signal?.aborted) {
      reject(abortReason());
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      reject(abortReason());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (ms !== undefined) {
      // The timer is deliberately NOT unref'd: the router awaits this promise,
      // and an unref'd timer lets the event loop drain while a request is still
      // in flight, which node:test reports as an unsettled promise.
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
    }
  });
}

/** Turn a `transport-error` / status-less `crash-after-write` into a rejection. */
export function transportFailure(message?: string): FakeTransportError {
  return new FakeTransportError(message);
}
