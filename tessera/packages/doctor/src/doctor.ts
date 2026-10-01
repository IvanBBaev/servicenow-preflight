// EnvironmentDoctor — deterministic three-state readiness (PLAN Phase 1).
//
// The whole package exists to make ONE guarantee: `diagnose` never rejects and
// never returns a green it did not earn. Every way a probe can fail — throwing,
// timing out, being cancelled, returning a malformed finding — lands as an
// `unknown` finding, and `unknown` dominates the roll-up. There is no path
// through this file that turns an absent answer into `ready`.

import type { TestKind } from "@tessera/types";

import { DoctorContractError } from "./errors.js";
import { DOCTOR_STATUSES } from "./types.js";
import type {
  Applicability,
  DoctorFinding,
  DoctorReport,
  DoctorRequest,
  DoctorStatus,
  Precondition,
} from "./types.js";

export interface EnvironmentDoctor {
  diagnose(request?: DoctorRequest): Promise<DoctorReport>;
}

export interface EnvironmentDoctorOptions {
  /**
   * How long ONE probe may take before its finding is resolved `unknown`.
   * Must be a finite number of milliseconds, greater than 0 and no larger
   * than a timer can hold (2^31 - 1). Defaults to
   * {@link DEFAULT_PROBE_TIMEOUT_MS}.
   */
  readonly probeTimeoutMs?: number;
}

/**
 * Delegated decision 2026-09-25: two minutes per probe. The transport retries
 * idempotent reads with backoff on top of its own per-request timeout, so a
 * bound much tighter than that would report a slow-but-honest instance as
 * `unknown`; a bound much looser leaves a gate hanging on a probe that ignores
 * its signal. Either way the timed-out finding is `unknown` — fail closed.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 120_000;

/** The largest delay `setTimeout` honours; beyond it the timer fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * @throws DoctorContractError when two preconditions share an id — a duplicate
 * would make findings ambiguous to key on, and it is a wiring bug, not a
 * runtime condition, so it fails at construction rather than at diagnose time.
 */
export function createEnvironmentDoctor(
  preconditions: readonly Precondition[],
  options: EnvironmentDoctorOptions = {},
): EnvironmentDoctor {
  assertUniqueIds(preconditions);
  const timeoutMs = probeTimeoutOf(options);
  const catalogue = [...preconditions];

  return {
    async diagnose(request: DoctorRequest = {}): Promise<DoctorReport> {
      const kinds = request.kinds ?? [];
      // Probes run concurrently but report in catalogue order: readiness output
      // is compared across runs, so a race must not reorder it.
      const findings = await Promise.all(
        catalogue.map(async (precondition): Promise<DoctorFinding> => {
          const applicability = applicabilityOf(precondition, kinds);
          const probed = await runProbe(
            precondition,
            request.signal,
            timeoutMs,
          );
          return { ...probed, applicability };
        }),
      );

      const required = findings.filter((f) => f.applicability === "required");
      const status = rollUp(required);
      const hardFailure = hardFailureOf(catalogue, findings, kinds);

      return {
        status,
        findings,
        ...(hardFailure === undefined ? {} : { hardFailure }),
      };
    },
  };
}

/**
 * Fail-closed precedence: any `unknown` wins, then any `not-ready`, else
 * `ready`.
 *
 * Delegated decision 2026-09-25: `ready` is earned POSITIVELY — only when every
 * finding says exactly `ready`. A status outside {@link DOCTOR_STATUSES}
 * (`"READY"`, `"ok"`, `undefined`, …) can only reach here from a caller that
 * bypassed `validate`, and it rolls up `unknown`: the roll-up used to return
 * `ready` by elimination, so any string that was neither `unknown` nor
 * `not-ready` was a green nobody earned.
 *
 * `unknown` outranks `not-ready` on purpose. "Not ready" is the STRONGER claim
 * — it asserts something specific about the instance — and you cannot make it
 * while another probe came back blind. Reporting the weaker, honest state costs
 * nothing at the gate (both block) and stops a real outage from being described
 * as a known, tidy misconfiguration.
 *
 * An empty required set is `ready`: nothing was asked, nothing blocks. The full
 * findings list still ships in the report, so a caller that wants to see the
 * deferred rows always can.
 */
export function rollUp(findings: readonly DoctorFinding[]): DoctorStatus {
  if (findings.every((f) => f.status === "ready")) return "ready";
  const decided = findings.every(
    (f) => f.status === "ready" || f.status === "not-ready",
  );
  return decided ? "not-ready" : "unknown";
}

/**
 * `requiredForKinds: undefined` = the MVP baseline, always required.
 * A listed kind promotes the precondition; an empty list never does.
 */
function applicabilityOf(
  precondition: Precondition,
  kinds: readonly TestKind[],
): Applicability {
  const gate = precondition.requiredForKinds;
  if (gate === undefined) return "required";
  return kinds.some((kind) => gate.includes(kind)) ? "required" : "deferred";
}

/**
 * DEV-2 generalised. A kind-gated precondition is one the run CANNOT route
 * around: asking for `ui` without a Test Runner is not a degraded run, it is a
 * run that would hang until the deadline and then report nothing. So when such
 * a precondition is promoted and does not come back `ready`, the report says
 * "hard failure" and the caller must refuse — a `not-ready` roll-up alone would
 * leave the choice open.
 */
function hardFailureOf(
  catalogue: readonly Precondition[],
  findings: readonly DoctorFinding[],
  kinds: readonly TestKind[],
): string | undefined {
  if (kinds.length === 0) return undefined;
  const gated = new Set(
    catalogue.filter((p) => p.requiredForKinds !== undefined).map((p) => p.id),
  );
  const blocking = findings.filter(
    (f) =>
      f.applicability === "required" &&
      gated.has(f.precondition) &&
      f.status !== "ready",
  );
  if (blocking.length === 0) return undefined;
  const detail = blocking
    .map((f) => `${f.precondition} is ${f.status} (${f.evidence})`)
    .join("; ");
  return `requested kind(s) ${kinds.join(", ")} cannot run: ${detail}`;
}

/**
 * The containment boundary. A probe that throws, or that returns a finding this
 * module cannot trust, becomes `unknown` — never an exception out of
 * `diagnose`, and never a silent pass.
 *
 * Delegated decision 2026-09-25: the probe is RACED against the caller's abort
 * and a per-probe timeout, either of which resolves the finding `unknown`. A
 * probe is handed the signal but nothing obliges it to honour it — and the
 * live adapter cannot pass it on (`snRequest` takes no signal) — so without
 * the race an abort left `diagnose` pending forever, against the contract in
 * `DoctorRequest.signal`. The abandoned probe keeps running in the background;
 * its late answer is ignored. Listener and timer are removed in `finally`.
 */
async function runProbe(
  precondition: Precondition,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Omit<DoctorFinding, "applicability">> {
  const unknown = (evidence: string): Omit<DoctorFinding, "applicability"> => ({
    precondition: precondition.id,
    status: "unknown",
    evidence,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<Omit<DoctorFinding, "applicability">>(
    (resolve) => {
      const cancelled = (): void =>
        resolve(unknown("cancelled: the probe was aborted before it answered"));
      if (signal?.aborted === true) {
        cancelled();
        return;
      }
      onAbort = cancelled;
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () =>
          resolve(
            unknown(`timed out: the probe did not answer in ${timeoutMs} ms`),
          ),
        timeoutMs,
      );
    },
  );
  // Delegated decision 2026-09-26: a signal that is ALREADY aborted resolves
  // the finding `unknown` without calling the probe at all. Racing it (as
  // before) still started the probe — for a live probe that is a request put
  // on the wire after the caller said stop, and its answer was discarded
  // anyway. Fail closed: cancelled means no probe, not an ignored one.
  if (signal?.aborted === true) {
    return unknown("cancelled: the probe was aborted before it answered");
  }
  try {
    return await Promise.race([probeOnce(precondition, signal), interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

async function probeOnce(
  precondition: Precondition,
  signal: AbortSignal | undefined,
): Promise<Omit<DoctorFinding, "applicability">> {
  try {
    const probed: unknown = await precondition.probe(signal);
    return validate(precondition, probed);
  } catch (error) {
    const detail = describeThrown(error);
    return {
      precondition: precondition.id,
      status: "unknown",
      evidence: `the probe threw: ${detail}`,
    };
  }
}

/**
 * What a probe threw, as text — without ever throwing itself.
 *
 * Delegated decision 2026-09-26: `diagnose` never rejects, and the probes run
 * under `Promise.all`, so an error that cannot even be PRINTED — a
 * null-prototype object (`String()` finds no `toString`), an object whose
 * `toString` throws, an `Error` whose `message` getter throws — used to reject
 * the whole report and lose every other finding with it. Extraction is
 * therefore contained on its own, and anything it cannot render becomes the
 * fixed marker `<unprintable error>`; the finding is `unknown` either way.
 */
function describeThrown(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return "<unprintable error>";
  }
}

/**
 * A probe that answers about a different precondition, with a status outside
 * {@link DOCTOR_STATUSES}, or without non-empty string evidence, has broken
 * its contract. Downgrading to `unknown` (rather than throwing)
 * keeps the report complete and keeps the failure fail-closed — a buggy adapter
 * must not be able to take the whole diagnosis down, nor to slip a bare `ready`
 * past the gate.
 */
function validate(
  precondition: Precondition,
  answer: unknown,
): Omit<DoctorFinding, "applicability"> {
  if (typeof answer !== "object" || answer === null) {
    return {
      precondition: precondition.id,
      status: "unknown",
      evidence: `probe returned ${answer === null ? "null" : typeof answer} instead of a finding`,
    };
  }
  const probed = answer as Omit<DoctorFinding, "applicability">;
  if (probed.precondition !== precondition.id) {
    return {
      precondition: precondition.id,
      status: "unknown",
      evidence: `probe answered for "${probed.precondition}" instead of "${precondition.id}"`,
    };
  }
  // Delegated decision 2026-09-25: a status that is not exactly one of the
  // three is a contract break, not a synonym — "READY", "ok", "green" and a
  // missing status all become `unknown` here, before the roll-up sees them.
  const status: unknown = probed.status;
  if (!(DOCTOR_STATUSES as readonly unknown[]).includes(status)) {
    return {
      precondition: precondition.id,
      status: "unknown",
      evidence: `probe reported ${JSON.stringify(status) ?? "no status"}, which is not one of ${DOCTOR_STATUSES.join(", ")}`,
    };
  }
  const evidence: unknown = probed.evidence;
  if (typeof evidence !== "string" || evidence.trim() === "") {
    return {
      precondition: precondition.id,
      status: "unknown",
      evidence: `probe reported "${String(status)}" with no evidence`,
    };
  }
  // Delegated decision 2026-09-26: return a FRESH plain object built from the
  // values validated above, never the probe's own object. Each field of that
  // object may be an accessor, and one that answered `ready` to the check can
  // answer `READY` (or `ready` after `unknown`) to the roll-up and the report
  // — an unvalidated status leaking past the only gate that checks it. Every
  // field is read exactly once, here.
  const remedy = probed.remedy;
  return {
    precondition: precondition.id,
    status: status as DoctorStatus,
    evidence,
    ...(remedy === undefined ? {} : { remedy }),
  };
}

/**
 * @throws DoctorContractError for a timeout that is not a finite number in
 * (0, 2^31 - 1] ms — `NaN`, `Infinity` or `0` would either disable the bound
 * or fire at once, and both are wiring bugs.
 */
function probeTimeoutOf(options: EnvironmentDoctorOptions): number {
  const value: unknown = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_TIMER_MS
  ) {
    throw new DoctorContractError(
      `probeTimeoutMs must be a finite number of milliseconds in (0, ${MAX_TIMER_MS}], got ${String(value)}`,
    );
  }
  return value;
}

function assertUniqueIds(preconditions: readonly Precondition[]): void {
  const seen = new Set<string>();
  for (const precondition of preconditions) {
    if (seen.has(precondition.id)) {
      throw new DoctorContractError(
        `duplicate precondition id "${precondition.id}"`,
      );
    }
    seen.add(precondition.id);
  }
}

/** Human-readable readiness report for the CLI. Derives nothing new. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`readiness: ${report.status}`];
  for (const finding of report.findings) {
    const marker = finding.applicability === "required" ? " " : "~";
    lines.push(`  ${marker} [${finding.status}] ${finding.precondition}`);
    lines.push(`      ${finding.evidence}`);
    if (finding.remedy !== undefined) {
      const { action } = finding.remedy;
      lines.push(
        `      remedy: ${action.kind} ${action.table} — ${action.description}`,
      );
    }
  }
  if (report.findings.length === 0) lines.push("  (no preconditions declared)");
  lines.push("  (~ = declared but deferred to a later phase; not rolled up)");
  if (report.hardFailure !== undefined) {
    lines.push(`  HARD FAILURE: ${report.hardFailure}`);
  }
  return lines.join("\n");
}
