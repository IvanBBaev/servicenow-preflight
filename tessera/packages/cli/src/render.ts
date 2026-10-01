// Rendering the `tess run --skeleton` report. Moved verbatim from the
// Phase-0.5 skeleton CLI; the output is frozen along with the command.
//
// Deliberately plain text: no colour, no spinner, no progress bar. This output
// is read far more often out of a CI log than off a terminal, and the §6a
// checklist is evidence — evidence that survives being copied into a ticket.
//
// The display fields are passed as their own record rather than as the parsed
// CliOptions, so this module does not depend on the run command's parser and
// the dependency runs one way: commands -> render.

import type { ChecklistRow, Lifecycle } from "@tessera/types";

import { runExitDisposition } from "./exitCodes.js";
import type { SkeletonRunResult } from "./skeletonRun.js";

/** What the report says about the run, over and above the pipeline's own report. */
export interface RunDisplay {
  readonly instanceName: string;
  readonly instanceHost: string;
  readonly lifecycle: Lifecycle;
  readonly ledgerRoot: string;
  /**
   * Whether the ledger root was created by this run rather than found.
   *
   * `stage()` answers it before the `mkdirSync` that makes it unanswerable, and
   * the answer is the difference between reporting a path and reporting a write
   * to the caller's own disk.
   */
  readonly ledgerRootCreated: boolean;
}

function formatRow(row: ChecklistRow): string {
  const evidence =
    row.evidence === undefined
      ? "none"
      : `${row.evidence.kind}:${row.evidence.ref}`;
  const flags = [
    row.blocking ? "blocking" : "non-blocking",
    ...(row.overridden ? ["overridden"] : []),
  ].join(", ");
  return [
    `  [${row.status.toUpperCase().padEnd(12)}] ${row.spec.id} (${row.kind})`,
    `      target:   ${row.target.table}/${row.target.sysId} — ${row.target.name}`,
    `      raw:      ${row.raw} (${flags})`,
    `      evidence: ${evidence}`,
  ].join("\n");
}

export function formatRunReport(
  result: SkeletonRunResult,
  display: RunDisplay,
): string {
  const { report } = result;
  const counts = report.verdict.counts;
  const lines: string[] = [
    "",
    `run id:    ${report.runId}`,
    `instance:  ${display.instanceName} <${display.instanceHost}>`,
    `runner:    ${result.runner.cls} (role ${result.runner.role})`,
    `lifecycle: ${display.lifecycle}`,
    `ledger:    ${display.ledgerRoot}${display.ledgerRootCreated ? " (created by this run)" : ""}`,
    `state:     ${report.state} — ${report.transitions.join(" → ")}`,
    "",
    "checklist (§6a)",
  ];

  if (report.verdict.rows.length === 0) {
    lines.push("  (no rows — nothing was planned)");
  } else {
    for (const row of report.verdict.rows) lines.push(formatRow(row));
  }

  if (result.failures.length > 0) {
    lines.push("", "failed assertions (Spike 2b attribution)");
    for (const failure of result.failures) {
      lines.push(`  - ${failure.spec.id}: ${failure.assertion}`);
    }
  }
  if (result.errors.length > 0) {
    lines.push("", "infrastructure errors (DEV-1)");
    for (const cause of result.errors) lines.push(`  - ${cause}`);
  }
  if (report.failure !== undefined) {
    lines.push(
      "",
      `stage failure: [${report.failure.stage}] ${report.failure.message}`,
    );
  }
  if (report.reporterEventFaults !== undefined) {
    // Rendered next to `failure` and never instead of it: the two are
    // independent facts, and a run can carry both. Without this block the
    // faults are recorded on the report and read by nobody — the artifact is
    // short a row and the only place that says so is a field no consumer
    // touches, which is the defect one level up from the one this closes.
    lines.push("", "reporter faults (events that reached no artifact)");
    for (const fault of report.reporterEventFaults) {
      lines.push(
        `  - ${fault.reporter} refused ${fault.event}: ${fault.message}`,
      );
    }
  }
  if (report.verdict.warnings.length > 0) {
    lines.push("", "warnings");
    for (const warning of report.verdict.warnings) lines.push(`  - ${warning}`);
  }
  if (result.acknowledgements.length > 0) {
    lines.push("", "acknowledge-prod (§11.4, journalled)");
    for (const record of result.acknowledgements) lines.push(`  - ${record}`);
  }

  // The number this command is about to exit with, taken from the same
  // function the command itself returns — not re-derived here. The two
  // branches of this file and `runCommand` all read one answer, so the report
  // cannot describe an exit the process does not perform.
  const exit = runExitDisposition(report.verdict.status);

  lines.push(
    "",
    `counts:    pass=${counts.pass} fail=${counts.fail} inconclusive=${counts.inconclusive} blocking=${counts.blocking} missing=${counts.missing}`,
    `teardown:  ${report.teardown} (${result.created.length} record(s) created, ${result.deleted.length} deleted)`,
    "",
    `VERDICT:   ${report.verdict.status}`,
    `exit:      ${exit.code}${exit.collapsed ? " (collapsed — see NOTE)" : ""}`,
  );

  // QA-9, stated where the number is. A reader who sees INCONCLUSIVE above and
  // a 1 in the CI log has no way, from the exit code alone, to tell this run
  // from one that genuinely failed — so the report says so rather than leaving
  // it to be inferred from a header comment in `run.ts` that nothing reads.
  if (exit.collapsed) {
    lines.push(
      "",
      "NOTE",
      `  exit ${exit.code} is the frozen Phase-0.5 code for "not GO". This run's`,
      `  verdict is ${report.verdict.status}, not NO_GO: the exit code alone cannot tell`,
      '  "the target failed" from "we could not tell". Read VERDICT above — or',
      "  verdict.exitCodeCollapsed under --json — before treating this as a",
      "  failing target.",
    );
  }

  lines.push("");
  return lines.join("\n");
}

export function jsonRunReport(
  result: SkeletonRunResult,
  display: RunDisplay,
): string {
  // One call, one answer — the same one `formatRunReport` and `runCommand`
  // read. Two calls would be two chances to disagree.
  const exit = runExitDisposition(result.report.verdict.status);
  return JSON.stringify(
    {
      runId: result.report.runId,
      instance: { name: display.instanceName, host: display.instanceHost },
      runner: { cls: result.runner.cls, role: result.runner.role },
      lifecycle: display.lifecycle,
      ledgerRoot: display.ledgerRoot,
      // The local-disk write, stated. `ledgerRoot` on its own is a path and a
      // path is true whether or not this run put anything there — so the one
      // safety property the `preflight_run` tool contract claims about the
      // caller's own filesystem ("it writes to the RUNNER and to nothing else",
      // qualified by this directory) was the one fact the document omitted.
      // `stage()` computes it before the mkdir that makes it undecidable; this
      // is that answer, inverted once and not recomputed.
      ledgerRootCreated: display.ledgerRootCreated,
      state: result.report.state,
      transitions: result.report.transitions,
      teardown: result.report.teardown,
      verdict: {
        ...result.report.verdict,
        // DEV-4, applied to the exit code. The document stated the verdict and
        // said nothing about what the process would do with it, so a consumer
        // reading `status: "INCONCLUSIVE"` next to a shell's `1` had nothing to
        // tell it whether the 1 meant the status or a NO_GO. Named the way
        // `tess preflight --json` names it, so the two commands' verdict blocks
        // answer the same question with the same key (ARCH-30).
        exitCode: exit.code,
        // The frozen mapping's cost, as a value a consumer can branch on. False
        // on a GO and on a real NO_GO; true when this code is standing in for a
        // status it cannot express. A pipeline that wants QA-9's retry-vs-page
        // distinction reads this rather than waiting for the exit code to widen
        // — which it will not, because it is pinned.
        exitCodeCollapsed: exit.collapsed,
      },
      failures: result.failures,
      errors: result.errors,
      acknowledgements: result.acknowledgements,
      created: result.created,
      deleted: result.deleted,
      ...(result.report.failure === undefined
        ? {}
        : {
            failure: {
              stage: result.report.failure.stage,
              message: result.report.failure.message,
            },
          }),
      ...(result.report.reporterEventFaults === undefined
        ? {}
        : {
            reporterEventFaults: result.report.reporterEventFaults.map(
              (fault) => ({
                reporter: fault.reporter,
                event: fault.event,
                message: fault.message,
              }),
            ),
          }),
    },
    null,
    2,
  );
}
