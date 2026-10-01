// The console `Reporter` — the `tess run --live` deliverable (PLAN Phase 7),
// and in the MVP the only interactive surface there is: DESIGN §12.2 defers
// the web dashboard and §12.3 row 7 fixes the reporter at "live console +
// `--json`/JUnit for CI. No SSE/web."
//
// Deliberately plain text: no colour, no spinner, no progress bar. That is the
// existing house rationale in `@tessera/cli`'s `render.ts` — this output is
// read far more often out of a CI log than off a terminal, and a checklist is
// evidence, evidence that survives being copied into a ticket. It is also why
// control characters are stripped rather than passed through: an ESC sequence
// in an assertion string is an instance-authored string repainting somebody's
// terminal.
//
// TWO MODES, ONE SUMMARY. `live: true` writes one line per event as it
// arrives; `live: false` (the default) writes nothing until `close()`. Both
// then render the SAME summary from the SAME collector snapshot — the modes
// differ in what they stream, never in what they conclude. `verbose` only ever
// ADDS lines (the `start`/`log` stream, artifact refs, the per-outcome table);
// it changes no count and no verdict.
//
// TM-1. Every line is built from declared `TestEvent` fields, one at a time.
// Nothing here stringifies an event, an outcome or a `RunResult`, so a
// property the union does not declare has no route to stdout.
//
// The caller owns line termination: `write` is handed one line without a
// trailing newline (`console.log` is the intended shape).

import type { Reporter } from "@tessera/core";
import { RAW_OUTCOMES } from "@tessera/types";
import type {
  ArtifactRef,
  RunId,
  TestEvent,
  TestSpecRef,
} from "@tessera/types";

import {
  asText,
  createEventCollector,
  escapeInvisibleFormatChars,
  projectArtifacts,
  projectSpecRef,
} from "./collect.js";
import type { CollectedRun } from "./collect.js";

/**
 * Longest rendered `assertion` / `cause` / `message`. A single ATF failure can
 * carry a whole server-side stack; past this the line stops being readable in
 * a CI log and the full text belongs in an artifact file (QA-11) or the JSON
 * report, both of which are uncapped.
 */
export const MAX_RENDERED_TEXT_LENGTH = 500;

/** C0 and C1 controls plus DEL — includes ESC, i.e. every ANSI sequence. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * One line of untrusted text: controls collapsed to spaces (so the line stays
 * one line and cannot repaint a terminal), runs of whitespace collapsed, and a
 * hard cap. A cut that lands between a surrogate pair drops the orphan rather
 * than emitting half a character.
 */
export function sanitizeLine(value: string): string {
  // Invisible bidi/zero-width characters become a visible `<U+XXXX>` token
  // (delegated decision 2026-09-25, see `escapeInvisibleFormatChars`): a
  // U+202E would otherwise reverse the rest of this line in a CI log.
  const flattened = escapeInvisibleFormatChars(value)
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length <= MAX_RENDERED_TEXT_LENGTH) return flattened;
  let cut = flattened.slice(0, MAX_RENDERED_TEXT_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}… (truncated)`;
}

function describeSpec(spec: TestSpecRef | undefined): string {
  if (spec === undefined) return "(no spec)";
  return `${sanitizeLine(spec.id)} (${sanitizeLine(spec.path)})`;
}

function describeArtifacts(artifacts: readonly ArtifactRef[]): string {
  if (artifacts.length === 0) return "";
  const refs = artifacts
    .map(
      (artifact) =>
        `${sanitizeLine(artifact.kind)}:${sanitizeLine(artifact.ref)}`,
    )
    .join(", ");
  return ` [artifacts: ${refs}]`;
}

/**
 * One event, one line — or `undefined` for the events a non-verbose stream
 * deliberately does not carry. Used only in `live` mode; the summary below is
 * what both modes share.
 */
function renderEventLine(
  event: TestEvent,
  runId: RunId,
  verbose: boolean,
): string | undefined {
  const prefix = `[${sanitizeLine(runId)}]`;
  switch (event.kind) {
    case "start":
      return verbose
        ? `${prefix} start ${describeSpec(projectSpecRef(event.spec))}`
        : undefined;
    case "pass":
      return `${prefix} pass  ${describeSpec(projectSpecRef(event.spec))}`;
    case "fail":
      return (
        `${prefix} FAIL  ${describeSpec(projectSpecRef(event.spec))}: ` +
        `${sanitizeLine(asText(event.assertion))}` +
        (verbose ? describeArtifacts(projectArtifacts(event.artifacts)) : "")
      );
    case "error":
      return (
        `${prefix} ERROR ${describeSpec(projectSpecRef(event.spec))}: ` +
        `${sanitizeLine(asText(event.cause))}` +
        (verbose ? describeArtifacts(projectArtifacts(event.artifacts)) : "")
      );
    case "log":
      return verbose
        ? `${prefix} log   ${sanitizeLine(asText(event.message))}`
        : undefined;
    case "end":
      // ARCH-24's run boundary. The numbers come from the summary below, which
      // is rendered from the collector — never from this event's payload, so
      // the streamed line and the summary cannot disagree.
      return `${prefix} end`;
    default:
      return undefined;
  }
}

/** The summary both modes end with, rendered from one snapshot. */
export function renderSummary(run: CollectedRun, verbose: boolean): string[] {
  const lines: string[] = ["", `run ${sanitizeLine(run.runId)}`];

  if (!run.ended) {
    // ARCH-24 says core emits `end` after run() resolves; if it never arrived
    // the run was cut short. Saying so is the honest report — a summary of
    // zero outcomes must not read like a run that produced none.
    lines.push(
      "  WARNING: no terminal `end` event arrived — this run was cut short and the",
      "           outcome list below is incomplete.",
    );
  }

  lines.push(
    `  outcomes: ${run.counts.total}`,
    `  ${RAW_OUTCOMES.map((outcome) => `${outcome}=${run.counts[outcome]}`).join(" ")}`,
  );

  if (verbose && run.outcomes.length > 0) {
    lines.push("  outcomes (raw):");
    for (const outcome of run.outcomes) {
      lines.push(
        `    - ${outcome.raw.padEnd(15)} ${describeSpec(outcome.spec)}`,
      );
    }
  }

  if (run.failures.length > 0) {
    lines.push("  failed assertions:");
    for (const failure of run.failures) {
      lines.push(
        `    - ${describeSpec(failure.spec)}: ${sanitizeLine(failure.assertion)}`,
      );
      if (verbose && failure.artifacts.length > 0) {
        lines.push(`     ${describeArtifacts(failure.artifacts)}`);
      }
    }
  }

  if (run.errors.length > 0) {
    // DEV-1: an infra fault is not evidence about the test, so it is listed
    // apart from the assertions rather than mixed in with them.
    lines.push("  infrastructure errors (DEV-1):");
    for (const error of run.errors) {
      lines.push(
        `    - ${describeSpec(error.spec)}: ${sanitizeLine(error.cause)}`,
      );
      if (verbose && error.artifacts.length > 0) {
        lines.push(`     ${describeArtifacts(error.artifacts)}`);
      }
    }
  }

  if (verbose && run.logs.length > 0) {
    lines.push("  log:");
    for (const message of run.logs)
      lines.push(`    - ${sanitizeLine(message)}`);
  }

  // Malformed input is counted, never guessed at. Reporting the counts is the
  // difference between "nothing happened" and "we could not read it" — and the
  // six are separate because they damage the summary above in six different
  // ways. Only the first leaves the numbers intact.
  if (run.dropped > 0) {
    lines.push(
      `  NOTE: ${run.dropped} event(s) did not match a declared TestEvent shape and were dropped.`,
    );
  }
  if (run.droppedOutcomeRows > 0) {
    lines.push(
      `  NOTE: ${run.droppedOutcomeRows} result row(s) were unreadable; \`outcomes: ${run.counts.total}\` above is short by that many.`,
    );
  }
  if (run.coercedOutcomes > 0) {
    lines.push(
      `  NOTE: ${run.coercedOutcomes} row(s) carried an unknown raw value and were resolved to \`error\`;`,
      "        they are inside the error count above and look like genuine DEV-1 faults.",
    );
  }
  if (run.startedWithoutOutcome > 0) {
    // The one caveat that can appear under `ended: true`, so it must not be
    // conditioned on the WARNING above: a complete-looking run can still have
    // dropped a unit it had already announced.
    lines.push(
      `  NOTE: ${run.startedWithoutOutcome} spec(s) started and appear in no outcome row —`,
      "        neither reported nor marked `missing` (§6a).",
    );
  }
  if (run.faultedWithoutOutcome > 0) {
    // Delegated decision 2026-09-25: an ERROR line, not a NOTE — the stream
    // reported a failure or fault for these specs and the result dropped it,
    // so the counts above understate what went wrong.
    lines.push(
      `  ERROR: ${run.faultedWithoutOutcome} spec(s) emitted a fail/error event and appear in no outcome row;`,
      "         the counts above do not include them (harness error).",
    );
  }
  if (run.faultedContradictedByOutcome > 0) {
    // Delegated decision 2026-09-26: an ERROR line, like the one above — the
    // stream reported a failure or fault and the result row says `pass`, so
    // the pass count above includes specs the stream said did not pass.
    lines.push(
      `  ERROR: ${run.faultedContradictedByOutcome} spec(s) emitted a fail/error event but their outcome row reads pass;`,
      "         the pass count above includes them (harness error).",
    );
  }

  lines.push("");
  return lines;
}

export interface ConsoleReporterOptions {
  /**
   * One line, no trailing newline — `console.log` is the intended shape.
   * `this: void`: the sink is destructured out of the options object below, so
   * it must be callable detached from it.
   */
  write(this: void, line: string): void;
  /** Stream a line per event as it arrives (`tess run --live`). Default false. */
  live?: boolean;
  /** Add the `start`/`log` stream, artifact refs and the per-outcome table. Default false. */
  verbose?: boolean;
}

export function createConsoleReporter(
  options: ConsoleReporterOptions,
): Reporter {
  const { write, live = false, verbose = false } = options;
  const collector = createEventCollector();
  let closed = false;

  return {
    onEvent(event: TestEvent): void {
      // Synchronous and total. Core wraps this call in its own try/catch
      // ("a reporter fault is never allowed to change the verdict"), which
      // means a throw here would be swallowed and the evidence lost silently —
      // so it is caught where it can still be counted.
      try {
        collector.record(event);
        if (!live) return;
        const runId = asText((event as { runId?: unknown }).runId);
        const line = renderEventLine(event, runId, verbose);
        if (line !== undefined) write(line);
      } catch {
        // Includes a `write` that throws: a broken pipe on stdout is not a
        // reason to change a run's outcome.
      }
    },

    close(runId: RunId): Promise<void> {
      // Idempotent: core closes reporters on the normal path AND in a
      // `finally`, so a second call must print nothing rather than a second
      // summary.
      if (closed) return Promise.resolve();
      closed = true;
      try {
        for (const line of renderSummary(collector.snapshot(runId), verbose)) {
          write(line);
        }
      } catch {
        // As above — the console is not the gate.
      }
      return Promise.resolve();
    },
  };
}
