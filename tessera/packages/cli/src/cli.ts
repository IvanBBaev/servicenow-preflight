// The dispatcher — split argv, run a command, classify what escapes it.
//
// Commands return an exit code for outcomes they understand and THROW for the
// two they do not get to interpret:
//
//   * `GuardViolation` — a §11 refusal. Exit 4, and the message is the guard's
//     verbatim: the guard is the only thing that decides writability, so the CLI
//     renders its reasoning rather than paraphrasing it.
//   * anything else — a DEV-1 infrastructure fault. Exit 3, NOT 1. A run that
//     could not reach the instance produced no evidence about any test, and
//     reporting that as "not ready" would be a verdict we never earned.
//
// Note what is missing: a catch that returns 0. There is no path through this
// file on which an error becomes a green exit.
//
// Both branches used to render an error's `message` and nothing else, and in
// both cases the message was the smaller half of what the error carried. A
// refusal arrived with a closed-union reason code and a classification that the
// prose embedded only sometimes; a failed apply arrived knowing how many writes
// had already landed. Neither reached the operator, and a fault that does not
// say "two of five writes are already on the instance" reads as "nothing
// happened, try again".

import { formatGuardViolation, type GuardViolation } from "@tessera/guard";

import { splitArgv } from "./args.js";
import { benchmarkCommand } from "./benchmarkRun.js";
import { coverageCommand } from "./commands/coverage.js";
import { doctorCommand } from "./commands/doctor.js";
import { generateCommand } from "./commands/generate.js";
import { impactCommand } from "./commands/impact.js";
import { preflightCommand } from "./commands/preflight.js";
import { resolveCommand } from "./commands/resolve.js";
import { runCommand } from "./commands/run.js";
import {
  cleanupCommand,
  confirmCommand,
  statusCommand,
} from "./commands/runState.js";
import { describe, defaultContext, type CliContext } from "./context.js";
import { EXIT_CODES } from "./exitCodes.js";
import { commandHelp, TOP_LEVEL_HELP } from "./help.js";

/** Structural, not `instanceof`: the error may have crossed a package boundary. */
function isGuardViolation(error: unknown): error is Error {
  return error instanceof Error && error.name === "GuardViolation";
}

/** Structural, for `isGuardViolation`'s reason. */
function named(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}

/** A structural read of `LedgerError.code` (the error may cross a package boundary). */
function ledgerCode(error: Error): unknown {
  return (error as { readonly code?: unknown }).code;
}

/**
 * The structured half of a refusal, rendered — or nothing when the error is not
 * carrying one.
 *
 * Deliberately NOT folded into `isGuardViolation`. The name check is what
 * decides exit 4 and must keep deciding it alone: an error that calls itself a
 * GuardViolation without its detail is still a refusal, and demoting it to the
 * DEV-1 branch would turn "the guard said no" into "something broke" — the one
 * confusion this whole file exists to prevent. But `formatGuardViolation` reads
 * `detail` and iterates two of its arrays unchecked, and a throw from inside a
 * catch block would replace a clean exit 4 with a stack trace. So the shape is
 * verified here, and its absence costs only the extra lines.
 *
 * Exported so the pure-function suite can drive the reasons the wired suite
 * cannot reach. Five of the eight `GUARD_VIOLATION_REASONS` are raised only by
 * `assertWrite`, which the pipeline reaches after `assertRunnerWritable` has
 * already cleared the runner — so no argv produces them, and a renderer tested
 * only through argv would be tested on two reasons out of eight.
 */
export function guardReasoning(error: Error): string | undefined {
  const detail: unknown = (error as Partial<GuardViolation>).detail;
  if (typeof detail !== "object" || detail === null) return undefined;
  const { evidence, design } = detail as Partial<GuardViolation["detail"]>;
  if (!Array.isArray(evidence) || !Array.isArray(design)) return undefined;
  return formatGuardViolation(error as GuardViolation);
}

/**
 * What a failed provisioning left on the instance — the fact that decides
 * whether "call again" is safe advice.
 *
 * `@tessera/provisioner` throws two errors that mean very different things and
 * used to render as one wall of prose. `ProvisionApplyError` knows exactly how
 * far it got and carries the numbers; `ProvisionVerificationError` means every
 * write claimed success and the instance disagreed, which is worse than partial
 * — nothing about the current state has been established at all. Both used to
 * reach the caller as a bare message under a banner whose next line reads "no
 * evidence was produced", which a reader is entitled to hear as "nothing
 * happened".
 *
 * Structural checks and read-only field access, so the CLI states what the
 * error carried and derives nothing of its own.
 *
 * Exported for the same reason as `guardReasoning`: reaching these two errors
 * through argv means getting a real provisioner to half-apply a real plan, so
 * the suite drives the renderer with the errors themselves instead.
 */
export function provisionAftermath(error: unknown): readonly string[] {
  if (named(error, "ProvisionApplyError")) {
    const { applied, total } = error as Partial<{
      applied: number;
      total: number;
    }>;
    if (typeof applied !== "number" || typeof total !== "number") return [];
    return [
      `  PARTIAL APPLY: ${applied} of ${total} planned write(s) already landed on the instance; the rest were not attempted.`,
      "  The instance is in neither the state it started in nor the state the plan described. Re-read it (`tess doctor`) before calling again — a retry re-plans against what is there NOW, it does not undo what landed.",
    ];
  }
  if (named(error, "ProvisionVerificationError")) {
    return [
      "  APPLY UNVERIFIED: every planned write reported success and the instance did not agree afterwards, so how much of the plan is really in place is UNKNOWN — which is not the same as partly applied, and not the same as nothing.",
      "  Re-read the instance (`tess doctor`) before calling again. A write that answered 200 without taking effect is one no retry can be relied on to notice.",
    ];
  }
  return [];
}

export async function main(
  argv: readonly string[],
  context: CliContext = defaultContext(),
): Promise<number> {
  const split = splitArgv(argv);

  if (split.kind === "help") {
    context.stdout(
      split.command === undefined ? TOP_LEVEL_HELP : commandHelp(split.command),
    );
    return EXIT_CODES.ok;
  }

  if (split.kind === "error") {
    context.stderr(`tess: ${split.message}`);
    context.stderr("");
    context.stderr("Run `tess --help` for usage.");
    return EXIT_CODES.usage;
  }

  try {
    switch (split.name) {
      case "preflight":
        return await preflightCommand(split.rest, context);
      // `resolve` leans on the fault branch below on purpose: a
      // `ResolutionFaultError` is exactly the DEV-1 case this catch was written
      // for, so the command lets it out rather than inventing its own wording.
      case "resolve":
        return await resolveCommand(split.rest, context);
      // Same bargain as `resolve`, one stage further on: `impact` reaches the
      // instance twice (the composite, then the where-used search) and lets a
      // `ResolutionFaultError` out of either. It also never returns 1 — impact
      // analysis answers a question, it does not reach a verdict.
      case "impact":
        return await impactCommand(split.rest, context);
      // `coverage` is `impact` plus a disk read, and inherits both halves of
      // that bargain: a `ResolutionFaultError` or a `SpecStoreFaultError` out of
      // either side lands on the DEV-1 branch below — an unreadable spec tree is
      // as much a missing-evidence fault as an unreachable instance (QA-9). It
      // never returns 1 either, and for a stronger reason than impact's: this
      // report is DECLARED INTENT, and a gap in somebody's plan is not a
      // statement about the code (QA-8).
      case "coverage":
        return await coverageCommand(split.rest, context);
      // `generate` is `coverage`'s analysis with a write on the end, and it is
      // the first command that lets a THIRD party's failure out through this
      // branch: a `GenerationFaultError` — a model that refused, an answer that
      // was truncated, a batch the TM-3 gate or the QA-12(a) bar rejected. All
      // of them mean no spec was produced, which is a DEV-1 fault and not a
      // finding: "the model would not answer" and "your code needs no tests"
      // are the same silence and opposite facts (OPP-1b). It never returns 1
      // either — a proposed spec has not been run, so it settles nothing.
      case "generate":
        return await generateCommand(split.rest, context);
      case "doctor":
        return await doctorCommand(split.rest, context);
      case "run":
        return await runCommand(split.rest, context);
      // The §6b run-state trio. `status` and `confirm` read local disk only;
      // `cleanup --mode apply` is the one that reaches an instance, and its
      // GuardViolation / teardown fault land on the branches below like any
      // other command's.
      case "status":
        return await statusCommand(split.rest, context);
      case "confirm":
        return await confirmCommand(split.rest, context);
      case "cleanup":
        return await cleanupCommand(split.rest, context);
      // The S5 OutcomeGate (§13). Its §11 refusal and faults land on the
      // branches below; a catalog refusal is returned, not thrown.
      case "benchmark":
        return await benchmarkCommand(split.rest, context);
    }
  } catch (error) {
    if (isGuardViolation(error)) {
      context.stderr("");
      // The prefix is unchanged and load-bearing: the MCP verdict surface
      // matches on it, and the message stays first so the sentence a human
      // wrote is the sentence a human reads first.
      context.stderr(`REFUSED (§11): ${error.message}`);
      // The reason code and the classification, which the message carries only
      // by luck. Three of the eight `GUARD_VIOLATION_REASONS` build a message
      // that names the instance class and the rest do not — `role-forbids-write`
      // says "the runner role never receives pipeline writes" and never says
      // whether the instance was prod — and the closed union itself reached a
      // caller through no path at all. `formatGuardViolation` existed to render
      // exactly this and had one call site, in a test.
      const reasoning = guardReasoning(error);
      if (reasoning !== undefined) {
        context.stderr("");
        context.stderr(reasoning);
      }
      context.stderr("");
      return EXIT_CODES.refused;
    }
    // Delegated decision 2026-09-26 (W6b finding 2): a usage mistake found
    // only once staging starts — `--fake` outside the dev workspace — is still
    // a usage error (exit 2), not a DEV-1 fault: nothing was staged or run.
    if (named(error, "UsageError")) {
      context.stderr(`tess: ${error.message}`);
      context.stderr("");
      return EXIT_CODES.usage;
    }
    // Delegated decision 2026-09-26 (F1): a run id that names a used, non-fresh
    // run is a REFUSAL, not a fault — the pipeline declined before any stage
    // and wrote nothing, and the remedy (`tess cleanup` / a new id) is the
    // operator's. Exit 4, with its own §4b prefix so it never reads as the §11
    // guard.
    if (named(error, "RunResumeRefusedError")) {
      context.stderr("");
      context.stderr(`REFUSED (§4b): ${error.message}`);
      context.stderr("");
      return EXIT_CODES.refused;
    }
    // Delegated decision 2026-09-26: a second run on a scope+runner another
    // run holds is a REFUSAL (DESIGN §4b Concurrency: "rejection, not
    // queueing") — nothing was opened or written, and the remedy is the
    // operator's. Exit 4 under its own prefix, so it reads neither as the §11
    // guard nor as the §4b resume refusal above.
    if (named(error, "RunConcurrencyRefusedError")) {
      context.stderr("");
      context.stderr(`REFUSED (§4b concurrency): ${error.message}`);
      context.stderr("");
      return EXIT_CODES.refused;
    }
    context.stderr("");
    context.stderr(`INFRASTRUCTURE FAULT (DEV-1): ${describe(error)}`);
    // Delegated decision 2026-09-26: a corrupt ledger record stays a hard stop
    // (a DEV-1 fault, exit 3). Tessera never quarantines or renames evidence
    // itself, so the fault says what the operator can do about it.
    if (named(error, "LedgerError") && ledgerCode(error) === "corrupt") {
      context.stderr(
        "  remedy: inspect the file(s) named above; if a record is beyond repair, move its run directory out of the ledger root by hand (tessera will not quarantine or rename evidence), then run again",
      );
    }
    // Before the "no evidence" line, not after: a reader scanning a CI log
    // top-down must meet "writes already landed" before they meet a sentence
    // that sounds like "nothing happened".
    for (const line of provisionAftermath(error)) context.stderr(line);
    context.stderr(
      "  no evidence was produced about any test — this is not a NO_GO",
    );
    context.stderr("");
    return EXIT_CODES.fault;
  }
}

/**
 * `process.exitCode` rather than `process.exit()`: stdout may still be draining
 * into a pipe, and a hard exit truncates the report the caller asked for.
 */
export async function run(argv: readonly string[]): Promise<void> {
  process.exitCode = await main(argv);
}
