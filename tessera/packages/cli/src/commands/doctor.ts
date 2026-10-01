// `tess doctor` — read-only readiness diagnosis.
//
// The one command that constructs no writer, no ledger and no guard, because it
// performs no write of any kind. That is exactly what earns it the right to
// point at any role in the topology, `target` included (ARCH-8): there is no
// single-writer rule to protect when nothing can write.
//
// It diagnoses one or two instances. Two is not the ARCH-29 alias — see the
// header of `options.ts` for why `--instance` binds to key `runner` here — but
// a genuine "tell me about both ends of this topology" read.
//
// Exit codes are the three states, not two: `unknown` USUALLY gets its own code
// (5) rather than being folded into `not-ready`. A precondition nobody could
// decide is a different operational problem from one that decided "no", and a CI
// job that treats them the same will eventually retry the wrong one forever.
//
// "Usually", because `exitCodeForDoctor` below folds it on one documented path:
// a hard failure short-circuits to `noGo` (1), and `hardFailureOf` in
// `@tessera/doctor` raises one for a kind-gated precondition whose status is
// merely `!== "ready"` — `unknown` included (DEV-2). On that path the document
// and the number disagree on purpose: the rolled-up `status` reads "unknown"
// while the exit code says 1, and `hardFailure` is the field that names why.
// The same hedge is carried on the MCP surface (`DOCTOR_TOOL` in
// `packages/mcp/src/tools.ts`) and pinned there; this comment is the CLI half
// of the same claim, so the two must not drift apart.

import {
  formatResolvedConfig,
  resolveConfig,
  ConfigError,
} from "@tessera/config";
import {
  createDefaultPreconditions,
  createEnvironmentDoctor,
  createSnInstanceProbe,
  formatDoctorReport,
  type DoctorReport,
  type DoctorStatus,
} from "@tessera/doctor";
import type { InstanceRole } from "@tessera/guard";
import type { TestKind } from "@tessera/types";

import type { CliContext } from "../context.js";
import { EXIT_CODES, type ExitCode } from "../exitCodes.js";
import { DOCTOR_OPTIONS } from "../options.js";
import { bindProbe, bindRole, TopologyError } from "../topology.js";

/** One diagnosed role, ready to print. */
interface RoleReport {
  readonly role: InstanceRole;
  readonly profile: string;
  readonly host: string;
  readonly report: DoctorReport;
}

/** Fail-closed: `unknown` outranks `not-ready`, which outranks `ready`. */
function worst(statuses: readonly DoctorStatus[]): DoctorStatus {
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("not-ready")) return "not-ready";
  return "ready";
}

/**
 * Every role's hard failure rolled into one line, or `undefined` for none.
 *
 * One function with two callers on purpose. The exit code branches on whether a
 * hard failure exists and the `--json` document reports which one it was; if
 * each asked the question in its own words, the two could drift and the
 * document would start disagreeing with the number the process exited with —
 * and the number is the half a CI job cannot ignore.
 *
 * Prefixed by role because this command diagnoses up to two instances and
 * either can be the one that failed. `DoctorReport.hardFailure` names the kind
 * and the missing precondition; it does not name the instance, because nothing
 * below this file knows there is more than one.
 */
export function doctorHardFailure(
  reports: readonly RoleReport[],
): string | undefined {
  const parts: string[] = [];
  for (const entry of reports) {
    if (entry.report.hardFailure === undefined) continue;
    parts.push(`${entry.role}: ${entry.report.hardFailure}`);
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}

export function exitCodeForDoctor(reports: readonly RoleReport[]): ExitCode {
  // DEV-2: a requested kind whose runner is unreachable is a hard failure — a
  // definite "no", not an undecided one, so it maps to noGo rather than to
  // inconclusive even though the underlying findings may be `unknown`.
  if (doctorHardFailure(reports) !== undefined) {
    return EXIT_CODES.noGo;
  }
  switch (worst(reports.map((entry) => entry.report.status))) {
    case "ready":
      return EXIT_CODES.ok;
    case "not-ready":
      return EXIT_CODES.noGo;
    case "unknown":
      return EXIT_CODES.inconclusive;
  }
}

export async function doctorCommand(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  let resolved;
  try {
    resolved = resolveConfig({
      argv,
      env: context.env,
      cwd: context.cwd,
      options: DOCTOR_OPTIONS,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      context.stderr(`tess doctor: ${error.message}`);
      context.stderr("");
      context.stderr("Run `tess doctor --help` for usage.");
      return EXIT_CODES.usage;
    }
    throw error;
  }

  const json = resolved.values.json === true;
  const kinds = (resolved.values.kinds ?? []) as readonly TestKind[];

  // The precedence log goes to stdout before anything is probed, so an operator
  // staring at a surprising result can see which layer chose the instance.
  if (!json) {
    context.stdout(formatResolvedConfig(resolved));
    context.stdout("");
  }

  const requested: { role: InstanceRole; value: string }[] = [];
  if (typeof resolved.values.runner === "string") {
    requested.push({ role: "runner", value: resolved.values.runner });
  }
  if (typeof resolved.values.target === "string") {
    requested.push({ role: "target", value: resolved.values.target });
  }
  if (requested.length === 0) {
    context.stderr(
      "tess doctor: no instance — pass --instance <profile> (and optionally --target <profile>)",
    );
    return EXIT_CODES.usage;
  }

  const reports: RoleReport[] = [];
  for (const { role, value } of requested) {
    let binding;
    try {
      binding = bindRole(role, value);
    } catch (error) {
      if (error instanceof TopologyError) {
        context.stderr(`tess doctor: ${error.message}`);
        return EXIT_CODES.usage;
      }
      throw error;
    }

    const probe = bindProbe(createSnInstanceProbe(), binding.profile);
    const doctor = createEnvironmentDoctor(createDefaultPreconditions(probe));
    reports.push({
      role,
      profile: binding.profile,
      host: binding.ref.host,
      report: await doctor.diagnose({ kinds }),
    });
  }

  if (json) {
    context.stdout(
      JSON.stringify(
        {
          kinds,
          instances: reports.map((entry) => ({
            role: entry.role,
            profile: entry.profile,
            host: entry.host,
            status: entry.report.status,
            findings: entry.report.findings,
            ...(entry.report.hardFailure === undefined
              ? {}
              : { hardFailure: entry.report.hardFailure }),
          })),
          status: worst(reports.map((entry) => entry.report.status)),
          // The second half of the exit-code decision, rolled up to the root
          // where the first half already was. `exitCodeForDoctor` reads TWO
          // predicates — any hard failure at all, then the worst status — and
          // only `status` was ever published. The DEV-2 path is precisely the
          // one where they disagree: `status` reads "unknown" while the exit
          // code says NOT READY, and the doctor tool's own description tells a
          // host to "READ `status` AND `hardFailure` in the returned document".
          // A host that obeyed found `status: "unknown"` and no `hardFailure`,
          // concluded "undecided, retry later", and retried a definite no.
          //
          // Unconditional and nullable, unlike the per-instance field above:
          // this is the one a caller is instructed to read, and an ABSENT key
          // is exactly what produced the defect — it cannot be told apart from
          // a producer that has no such field. `null` says "asked, and there is
          // none". Computed by the same function the exit code branches on, so
          // the two cannot drift.
          hardFailure: doctorHardFailure(reports) ?? null,
        },
        null,
        2,
      ),
    );
  } else {
    for (const entry of reports) {
      context.stdout(`${entry.role}: ${entry.profile} <${entry.host}>`);
      context.stdout(formatDoctorReport(entry.report));
      context.stdout("");
    }
  }

  return exitCodeForDoctor(reports);
}
