// PLAN Phase 5 — the bounded progress loop (DEV-2).
//
// DEV-2: a runner that waits on an instance must wait with a deadline. An ATF
// suite can stay "Running" forever (a hung step, a paused instance, a revoked
// session), and an unbounded poll turns one stuck suite into a stuck pipeline
// that never reaches a verdict. So the loop below can end in exactly three
// ways — the run went terminal, the budget ran out, or the caller aborted —
// and it never throws for a non-terminal run: "we stopped waiting" is a
// *result*, not an error, and the caller converts it into `waiting-timeout`
// outcomes (§6a resolves those to INCONCLUSIVE, blocking — fail-closed).
//
// Determinism: `now` and `sleep` are injected, so a test drives the whole
// schedule without wall-clock time. The default `sleep` uses a REF'd timer on
// purpose — an `unref`'d one lets Node's event loop drain while a run is in
// flight, and `node --test` then cancels the suite with "the event loop has
// already resolved".
//
// Termination is guaranteed by two independent bounds: the injected clock
// (`deadlineMs`) and a hard poll ceiling (`maxPolls`). The ceiling exists so a
// frozen injected clock — a plausible test-harness bug — still cannot produce
// an infinite loop.
//
// ARCH-28: abort is checked before every round-trip and after every response.
// It stops the loop; it never cancels or deletes the instance-side run, which
// belongs to the orphan sweep (DEV-17).
//
// "Non-terminal" means a RECOGNISED non-terminal state (0 Pending, 1 Running).
// A status the loop cannot classify is not evidence that the suite is still
// running, so it rejects as a DEV-1 fault instead of waiting out the budget.
// Likewise a non-finite budget or poll ceiling is a caller bug that would
// disable both termination bounds, so it throws `TypeError` at entry.

import {
  AtfInfrastructureError,
  asRecord,
  fieldString,
  requestOrFault,
  unwrapResult,
  type AtfHttpClient,
} from "./client.js";

/** CI/CD progress endpoint; the execution id is appended, URL-encoded. */
export const CICD_PROGRESS_PATH_PREFIX = "/api/sn_cicd/progress/";

/**
 * Terminal CI/CD status codes: 2 Successful, 3 Failed, 4 Canceled (0 Pending,
 * 1 Running). Codes come from the public CI/CD API docs, not from a live
 * capture in this repo — hence the label fallback below.
 */
export const TERMINAL_STATUS_CODES: ReadonlySet<string> = new Set([
  "2",
  "3",
  "4",
]);

/**
 * Label fallback for an instance whose numeric code we did not anticipate.
 * Matching both spellings of "cancelled" is deliberate: a missed terminal
 * state costs a whole deadline of waiting.
 */
export const TERMINAL_STATUS_LABEL = /^(successful|failed|cancell?ed)$/i;

export type AtfRunState =
  "pending" | "running" | "successful" | "failed" | "canceled" | "unknown";

const STATE_BY_CODE: Readonly<Record<string, AtfRunState>> = {
  "0": "pending",
  "1": "running",
  "2": "successful",
  "3": "failed",
  "4": "canceled",
};

/** One observed progress sample. */
export interface AtfProgress {
  readonly executionId: string;
  readonly state: AtfRunState;
  readonly status: string;
  readonly statusLabel: string;
  readonly statusMessage: string;
  readonly percentComplete: number;
  readonly terminal: boolean;
  /**
   * `result.links.results.id` — the `sys_atf_test_suite_result` sys_id of THIS
   * execution, the only key that links a `sys_atf_test_result` row (through
   * its `test_suite_result` reference) to the run this adapter started. The
   * CI/CD API emits it on a completed run; `""` when the payload carries none.
   */
  readonly resultsId: string;
}

export interface PollOptions {
  /**
   * Wall budget for this loop, measured from entry with the injected clock.
   * A finite value <= 0 returns the `deadline` arm without issuing a request
   * (a caller's remaining budget can legitimately be spent). A non-finite
   * value (`NaN`, `Infinity`) throws `TypeError`.
   */
  readonly deadlineMs: number;
  /** First wait between polls. Default 2000 ms. Must be finite. */
  readonly initialIntervalMs?: number;
  /** Backoff ceiling. Default 15000 ms. Must be finite. */
  readonly maxIntervalMs?: number;
  /**
   * Hard ceiling on round-trips, independent of the clock. Default 1000.
   * Must be a positive integer; anything else throws `TypeError`.
   */
  readonly maxPolls?: number;
  /** ARCH-28 cancellation. */
  readonly signal?: AbortSignal;
  /** Injected for determinism. Default a REF'd `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected for determinism. Default `Date.now`. */
  readonly now?: () => number;
}

/** Why the loop stopped waiting. */
export type PollStopReason = "time" | "max-polls";

export type PollResult =
  | { readonly outcome: "terminal"; readonly run: AtfProgress }
  | {
      readonly outcome: "deadline";
      readonly lastRun?: AtfProgress;
      readonly polls: number;
      readonly elapsedMs: number;
      readonly reason: PollStopReason;
    }
  | {
      readonly outcome: "aborted";
      readonly lastRun?: AtfProgress;
      readonly polls: number;
      readonly elapsedMs: number;
    };

export const DEFAULT_INITIAL_INTERVAL_MS = 2_000;
export const DEFAULT_MAX_INTERVAL_MS = 15_000;
export const DEFAULT_MAX_POLLS = 1_000;

/** REF'd on purpose — see the header note about `node --test`. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse one progress envelope; `undefined` means "not the shape we speak". */
export function parseProgress(
  executionId: string,
  body: unknown,
): AtfProgress | undefined {
  const result = asRecord(unwrapResult(body));
  if (result === undefined) return undefined;
  const status = fieldString(result, "status");
  const statusLabel = fieldString(result, "status_label");
  const percent = Number(fieldString(result, "percent_complete"));
  const state = STATE_BY_CODE[status] ?? "unknown";
  const links = asRecord(result["links"]);
  const results = asRecord(links?.["results"]);
  const terminal =
    TERMINAL_STATUS_CODES.has(status) ||
    TERMINAL_STATUS_LABEL.test(statusLabel.trim());
  return {
    executionId,
    state,
    status,
    statusLabel,
    statusMessage: fieldString(result, "status_message"),
    percentComplete: Number.isFinite(percent) ? percent : 0,
    terminal,
    resultsId: results === undefined ? "" : fieldString(results, "id").trim(),
  };
}

/**
 * One progress round-trip. Rejects with {@link AtfInfrastructureError} both
 * when the body is unparseable and when the transport fails — the latter
 * normalised by {@link requestOrFault}, original on `cause`. Both are DEV-1
 * infra faults, and a fault here stops the loop rather than being mistaken for
 * a non-terminal sample: an unknown state is not "still running".
 */
export async function fetchProgress(
  client: AtfHttpClient,
  executionId: string,
): Promise<AtfProgress> {
  const path = `${CICD_PROGRESS_PATH_PREFIX}${encodeURIComponent(executionId)}`;
  const response = await requestOrFault<unknown>(
    client,
    { method: "GET", path },
    `GET ${path} (progress of execution ${executionId})`,
  );
  const progress = parseProgress(executionId, response.data);
  if (progress === undefined) {
    throw new AtfInfrastructureError(
      `CI/CD progress for execution ${executionId} was unparseable ` +
        `(HTTP ${response.status}); the suite state is unknown`,
    );
  }
  return progress;
}

/**
 * Validate the loop's numeric knobs before anything is issued.
 *
 * Delegated decision 2026-09-25: a non-finite `deadlineMs` (NaN never compares
 * `>=`, so the clock bound silently vanished) or a `maxPolls` that is not a
 * positive integer (NaN disabled the ceiling; 0 was silently raised to 1)
 * throws `TypeError` instead of being defaulted — fail closed. A finite
 * `deadlineMs <= 0` stays legal: it is how a caller hands over a budget that
 * is already spent. Intervals must be finite (negatives are still clamped).
 */
export function assertPollOptions(options: PollOptions): void {
  if (!Number.isFinite(options.deadlineMs)) {
    throw new TypeError(
      `pollUntilTerminal: deadlineMs must be a finite number, got ${String(options.deadlineMs)}`,
    );
  }
  if (
    options.maxPolls !== undefined &&
    !(Number.isInteger(options.maxPolls) && options.maxPolls > 0)
  ) {
    throw new TypeError(
      `pollUntilTerminal: maxPolls must be a positive integer, got ${String(options.maxPolls)}`,
    );
  }
  for (const key of ["initialIntervalMs", "maxIntervalMs"] as const) {
    const value = options[key];
    if (value !== undefined && !Number.isFinite(value)) {
      throw new TypeError(
        `pollUntilTerminal: ${key} must be a finite number, got ${String(value)}`,
      );
    }
  }
}

/**
 * Poll `executionId` until it reaches a terminal state, the budget is spent, or
 * the caller aborts. Never throws for a RECOGNISED non-terminal run; rejects
 * with {@link AtfInfrastructureError} for a status it cannot classify, and
 * with `TypeError` for invalid options (see {@link assertPollOptions}).
 */
export async function pollUntilTerminal(
  client: AtfHttpClient,
  executionId: string,
  options: PollOptions,
): Promise<PollResult> {
  assertPollOptions(options);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxIntervalMs = Math.max(
    0,
    options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS,
  );
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  let interval = Math.max(
    0,
    Math.min(
      options.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS,
      maxIntervalMs,
    ),
  );

  const startedAt = now();
  const deadlineAt = startedAt + options.deadlineMs;
  let lastRun: AtfProgress | undefined;
  let polls = 0;

  // A function call, not an inline read: control-flow narrowing would otherwise
  // remember the first check's `false` across the loop's awaits.
  const aborted = (): boolean => options.signal?.aborted === true;

  const stopped = (
    outcome: "deadline" | "aborted",
    reason: PollStopReason,
  ): PollResult => {
    const base = {
      polls,
      elapsedMs: now() - startedAt,
      ...(lastRun === undefined ? {} : { lastRun }),
    };
    return outcome === "aborted"
      ? { outcome: "aborted", ...base }
      : { outcome: "deadline", ...base, reason };
  };

  for (;;) {
    if (aborted()) return stopped("aborted", "time");
    if (now() >= deadlineAt) return stopped("deadline", "time");
    if (polls >= maxPolls) return stopped("deadline", "max-polls");

    lastRun = await fetchProgress(client, executionId);
    polls += 1;
    if (lastRun.terminal) return { outcome: "terminal", run: lastRun };
    // Delegated decision 2026-09-25: an unclassifiable status (neither a known
    // code nor a terminal label) rejects immediately as a DEV-1 fault. The
    // rejected alternative — tolerating up to N consecutive unknowns — still
    // guesses "running" for a state we cannot read; failing on the first one
    // is the fail-closed choice and costs no deadline of waiting.
    if (lastRun.state === "unknown") {
      throw new AtfInfrastructureError(
        `CI/CD progress for execution ${executionId} reported an unrecognised ` +
          `status ${JSON.stringify(lastRun.status)} (label ` +
          `${JSON.stringify(lastRun.statusLabel)}); the suite state is unknown`,
      );
    }

    if (aborted()) return stopped("aborted", "time");
    const remaining = deadlineAt - now();
    if (remaining <= 0) return stopped("deadline", "time");

    await sleep(Math.max(0, Math.min(interval, remaining)));
    interval = Math.min(maxIntervalMs, interval === 0 ? 1 : interval * 2);
  }
}
