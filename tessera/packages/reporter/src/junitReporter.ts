// The JUnit XML `Reporter` — the CI half of DESIGN §12.3 row 7 ("live console
// + `--json`/JUnit for CI"). One document, written once, at the ARCH-24 flush
// boundary.
//
// ESCAPING IS PORTED, NOT IMPORTED. The technique comes from this repo's
// `src/report/junit.ts`: strip the C0 controls XML 1.0 forbids even when
// numerically escaped (all but tab/LF/CR), strip the two BMP noncharacters and
// any UNPAIRED surrogate (a lone surrogate cannot be serialised as UTF-8 at
// all — truncating a message mid-astral-character is the usual way one appears),
// then escape the five predefined entities. Only the technique could be
// reused: those functions are typed against the root package's
// `PreflightReport`/`CheckResult`, which have nothing to do with Tessera's
// `RunResult`/`SpecOutcome`. No CDATA is used anywhere, so a `]]>` in an
// assertion is inert text that the entity escaping handles like any other.
//
// OUTCOME → ELEMENT. `RawOutcome` has seven members and JUnit has three
// elements, so the mapping is a decision. It follows @tessera/core's §6a
// fail-closed resolution table (`aggregateVerdict.ts`) so the report and the
// verdict describe the same run:
//
//   raw              §6a status        JUnit                 why
//   ---------------- ----------------- --------------------- --------------------------------
//   pass             pass              <testcase/>           nothing to report
//   fail             fail              <failure>             an assertion failed; the text is
//                                                            the `assertion` from the event
//   missing          fail              <failure>             §6a resolves `missing` to status
//                                                            fail; there is no assertion, so
//                                                            the message says exactly that
//   error            inconclusive      <error>               DEV-1 infra fault — not evidence
//                                                            about the test
//   waiting-timeout  inconclusive      <error>               DEV-2 grace window expired; no
//                                                            outcome was ever observed
//   flaky            inconclusive      <error>               re-run disagreement (QA-7): the
//                                                            result is not trustworthy, which
//                                                            is not the same as "it failed"
//   skipped          inconclusive      <skipped/>            the one JUnit element that means
//                                                            this
//
// The `skipped` row carries a caveat worth stating out loud: in JUnit a
// `<skipped/>` testcase is not red, but under §6a a `skipped` row is BLOCKING
// unless the `allow-skipped` override was applied. (The override is an
// `OverrideRecord` — @tessera/core's `aggregateVerdict` flips `blocking` on
// `raw === "skipped"` rows and on nothing else. There is no `--allow-skipped`
// FLAG today: @tessera/config's Phase-1 option table records it as still owed,
// so a message that told a reader to pass one would be sending them to a
// usage error.) THE JUNIT FILE IS NOT THE GATE — the `PreflightVerdict` (and
// `tess run`'s exit code) is. A CI job that decides go/no-go from this file
// alone is reading the wrong artifact.
//
// That caveat used to be the whole answer, and it is not enough, so: the row
// stays `<skipped/>` and only its MESSAGE names the consequence. Promoting it
// to `<error>` was considered and rejected — it would misreport what happened
// in order to report what it means, which is the same class of lie in the other
// direction. JUnit's vocabulary describes what the runner did; it has no words
// for what the policy concludes, and the verdict layer owns blocking-ness.
//
// WHAT THE STRING-ONLY FIX RESTS ON IS NOT THE EXIT CODE, and until 2026-09-01
// this comment said it was. It claimed a blocking `skipped` resolves to
// INCONCLUSIVE and `tess run` exits 5, and concluded "a gate that reads the
// exit code cannot miss it". Both halves were false, and the second was
// backwards. `tess run`'s mapping is frozen at Phase 0.5's two outcomes
// (@tessera/cli's `runExitDisposition`: GO → 0, everything else → 1), so a
// blocking `skipped` exits 1 — the SAME 1 a genuine NO_GO exits with. A gate
// reading the exit code alone does not merely risk missing this case; it
// cannot tell it from a real failure at all.
//
// So the honest safety position is the uncomfortable one: this message's
// accuracy matters MORE than that comment claimed, not less, because the exit
// code is not carrying the distinction on its behalf. What does carry it is
// the run report — `tess run` prints VERDICT and an `exit:` line that says
// when the code collapsed a distinction, and `--json` publishes
// `verdict.exitCode` and `verdict.exitCodeCollapsed`. Those are the names the
// message points at.
//
// And it is why NO EXIT-CODE NUMBER IS NAMED IN THIS FILE. @tessera/reporter
// does not depend on @tessera/cli — the edge runs the other way — so any
// number written here is a claim this package has no way to check, which is
// exactly how the wrong one survived. The rule is enforced by a test rather
// than by this paragraph. A gate that reads only this file still cannot decide
// go/no-go, and no wording here fixes that: this file is one input to a gate
// and never the sole one.
//
// Counts are derived from what is emitted, never from a separate summary
// field, so `tests`/`failures`/`errors`/`skipped` can never disagree with the
// elements actually emitted.
//
// SYNTHETIC HARNESS ROWS. Six run-level conditions — a run-level `error`
// event, a missing terminal `end`, unreadable result rows, specs that
// started and never appeared, (since 2026-09-25) specs whose `fail`/`error`
// event has no result row, and (since 2026-09-26) specs whose `fail`/`error`
// event is contradicted by a `pass` row — used to be reported ONLY as `<system-err>`
// prose. The rationale was that a `<testcase>` is a planned spec and inventing
// one puts an unplanned row in the report. That premise is true of our usage
// of the format and not of the format: in JUnit XML a `<testcase>` is the unit
// of RESULT ACCOUNTING, not the unit of intent, which is why Surefire reports
// suite-setup failures and pytest reports collection errors as cases. Neither
// was planned either, and both must carry numeric weight. So each of the six
// also emits a case with the stable marker `classname="tessera.harness"`,
// counted into `tests` and `errors`. The marker is what keeps the denominator
// honest, and it is asserted in the tests: a consumer separates harness rows
// from spec rows by that string, not by this paragraph.
//
// The `<system-err>` prose is KEPT alongside the rows, deliberately. The row is
// what a machine counts; the note is what a human reads. Moving the detail to
// gain the count would be the same defect in the other direction — a consumer
// that CAN notice an absence losing the thing it would have noticed.
//
// Nothing outside this package parses this document (the only consumer wires
// `write`; QA-16 reconciliation joins on the spec manifest), so no downstream
// denominator is inflated by the harness rows. If one ever reads `tests=` as a
// spec count it must exclude `classname="tessera.harness"`, and that exclusion
// needs its own test — otherwise this trades a silent undercount for a silent
// overcount, which is the same bug wearing the other sign.

import { specKey } from "@tessera/core";
import type { Reporter } from "@tessera/core";
import type { RawOutcome, RunId, TestEvent } from "@tessera/types";

import {
  assertionsBySpec,
  causesBySpec,
  createEventCollector,
  escapeInvisibleFormatChars,
} from "./collect.js";
import type { CollectedRun } from "./collect.js";

// Characters XML 1.0 forbids even when numerically escaped: all C0 controls
// except tab (0x09), LF (0x0A) and CR (0x0D). A raw one — easily present in
// ATF or script output folded into an assertion — makes the whole document
// unparseable, so they are dropped before the entities are escaped.
// eslint-disable-next-line no-control-regex
const XML_INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

// The rest of what XML 1.0's Char production excludes: the two BMP
// noncharacters, plus any unpaired surrogate. A valid pair matches neither
// alternative and survives — it is legal XML.
const XML_INVALID_UNICODE =
  /[\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Safe inside both element text and a double-quoted attribute value. Exported
 * because the tests assert on the technique, not only on its result.
 */
export function escapeXml(value: string): string {
  // Invisible bidi/zero-width characters are legal XML, so nothing below
  // would touch them. They are replaced with a visible `<U+XXXX>` token — then
  // entity-escaped with everything else, so the parsed text reads `<U+202E>`
  // (delegated decision 2026-09-25, see `escapeInvisibleFormatChars`).
  return escapeInvisibleFormatChars(value)
    .replace(XML_INVALID_CHARS, "")
    .replace(XML_INVALID_UNICODE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

type JUnitElement = "none" | "failure" | "error" | "skipped";

/** The table documented in the file header, in executable form. */
const ELEMENT_FOR: Readonly<Record<RawOutcome, JUnitElement>> = {
  pass: "none",
  fail: "failure",
  missing: "failure",
  error: "error",
  "waiting-timeout": "error",
  flaky: "error",
  skipped: "skipped",
};

/** Message used when the event stream carried no text for an outcome. */
const DEFAULT_MESSAGE: Readonly<Record<RawOutcome, string>> = {
  pass: "",
  fail: "the runner reported a failure but no assertion text was captured",
  missing:
    "planned, but no result row was produced for this spec (§6a: missing)",
  error: "the adapter reported an infrastructure fault (DEV-1)",
  "waiting-timeout":
    "the run stayed `waiting` past the DEV-2 grace window; no outcome was observed",
  flaky: "re-run disagreement (QA-7); the result is not trustworthy",
  // Not red in JUnit, blocking under §6a. The message is the only place this
  // document can say so — and it names no exit code, because the exit code
  // does not separate this case from a real failure and this package is in no
  // position to state one anyway. See the header.
  skipped:
    "planned, deliberately not executed — §6a resolves this to a BLOCKING inconclusive unless the allow-skipped override was applied. The exit code does not separate it from a genuine failure: `tess run` returns the same code for this as for a NO_GO, so read the run report's VERDICT — or verdict.exitCodeCollapsed under --json — before treating either as the other. This file is not the gate",
};

/**
 * `classname` for the synthetic run-level rows. A stable, dotted, non-path
 * string: it cannot collide with a spec's `classname`, which is always the
 * spec's file path.
 */
const HARNESS_CLASSNAME = "tessera.harness";

function messageFor(
  raw: RawOutcome,
  key: string,
  assertions: ReadonlyMap<string, readonly string[]>,
  causes: ReadonlyMap<string, readonly string[]>,
): string {
  // A `fail` row's text is the assertion captured from the `fail` event; an
  // error-shaped row's text is the `cause` from the `error` event. Both are
  // joined rather than truncated: a spec that failed twice failed twice.
  const captured = raw === "fail" ? assertions.get(key) : causes.get(key);
  const text = (captured ?? []).filter((entry) => entry.length > 0).join("\n");
  return text.length > 0 ? text : DEFAULT_MESSAGE[raw];
}

function renderTestcase(
  name: string,
  classname: string,
  raw: RawOutcome,
  message: string,
): string {
  const open = `    <testcase name="${escapeXml(name)}" classname="${escapeXml(classname)}"`;
  const element = ELEMENT_FOR[raw];
  if (element === "none") return `${open} />`;
  const escaped = escapeXml(message);
  if (element === "skipped") {
    return `${open}>\n      <skipped message="${escaped}" />\n    </testcase>`;
  }
  return (
    `${open}>\n` +
    `      <${element} message="${escaped}" type="${escapeXml(raw)}">${escaped}</${element}>\n` +
    `    </testcase>`
  );
}

/**
 * A run-level condition, as a counted `<error>` row. Separate from
 * `renderTestcase` on purpose: that one is keyed on a `RawOutcome` a spec
 * actually produced, and this one has no spec and no outcome. Always `<error>`
 * — every condition it reports is a fault in the harness or the stream, never
 * a statement about a test.
 */
function renderHarnessCase(
  name: string,
  type: string,
  message: string,
): string {
  const escaped = escapeXml(message);
  return (
    `    <testcase name="${escapeXml(name)}" classname="${HARNESS_CLASSNAME}">\n` +
    `      <error message="${escaped}" type="${escapeXml(type)}">${escaped}</error>\n` +
    `    </testcase>`
  );
}

/** Render the whole document. Pure — the reporter only supplies the snapshot. */
export function renderJUnit(run: CollectedRun): string {
  const assertions = assertionsBySpec(run);
  const causes = causesBySpec(run);

  let failures = 0;
  let errors = 0;
  let skipped = 0;
  const cases: string[] = [];

  for (const outcome of run.outcomes) {
    const element = ELEMENT_FOR[outcome.raw];
    if (element === "failure") failures += 1;
    else if (element === "error") errors += 1;
    else if (element === "skipped") skipped += 1;
    const key = specKey(outcome.spec);
    cases.push(
      renderTestcase(
        outcome.spec.id,
        outcome.spec.path,
        outcome.raw,
        messageFor(outcome.raw, key, assertions, causes),
      ),
    );
  }

  // Each run-level condition gets BOTH a counted row and its prose note. The
  // row carries the numeric weight a machine reads; the note carries the detail
  // a human reads. See the header for why neither replaces the other.
  const harness: string[] = [];
  const runLevel = run.errors.filter((error) => error.spec === undefined);
  const notes: string[] = runLevel.map((error) => error.cause);
  if (runLevel.length > 0) {
    // Joined, not truncated — the same rule `messageFor` applies to a spec that
    // failed twice.
    const causes = notes.filter((cause) => cause.length > 0);
    harness.push(
      renderHarnessCase(
        "run-level-error",
        "run-level-error",
        causes.length > 0 ? causes.join("\n") : DEFAULT_MESSAGE.error,
      ),
    );
  }
  if (!run.ended) {
    // ARCH-24: no terminal event means the outcome list is incomplete. A CI
    // reader must not take a short report for a complete one.
    const message =
      "no terminal `end` event arrived — this run was cut short and the case list is incomplete";
    notes.push(message);
    harness.push(
      renderHarnessCase("run-incomplete", "no-terminal-end", message),
    );
  }
  if (run.dropped > 0) {
    // Events, not rows: nothing was subtracted from the counts below, so this
    // is a note and not a row. Rows change the denominator; events do not.
    notes.push(
      `${run.dropped} event(s) did not match a declared TestEvent shape and were dropped`,
    );
  }
  if (run.droppedOutcomeRows > 0) {
    // Rows. Each one is a result the run produced and this report does not
    // show, so `tests=` would otherwise be quietly short by exactly this many.
    const message = `${run.droppedOutcomeRows} result row(s) in the terminal \`end\` event were not readable as a SpecOutcome and are absent from this report`;
    notes.push(message);
    harness.push(
      renderHarnessCase(
        "unreadable-outcome-rows",
        "dropped-outcome-row",
        message,
      ),
    );
  }
  if (run.startedWithoutOutcome > 0) {
    // §6a has `missing` for exactly this shape, so a nonzero count means the
    // result did not use it — the spec vanished rather than being marked.
    const message = `${run.startedWithoutOutcome} spec(s) emitted a start event and appear in no outcome row; they were neither reported nor marked missing (§6a)`;
    notes.push(message);
    harness.push(
      renderHarnessCase(
        "specs-started-without-outcome",
        "started-without-outcome",
        message,
      ),
    );
  }
  if (run.faultedWithoutOutcome > 0) {
    // Delegated decision 2026-09-25: the stream reported a failure or fault
    // for these specs and the result carries no row for them. Without this row
    // a `fail` event followed by an empty result rendered `failures="0"
    // errors="0"` — green. Counted, so the document can never be green while
    // a reported failure is unaccounted for.
    const message = `${run.faultedWithoutOutcome} spec(s) emitted a fail/error event and appear in no outcome row; the failure is not reflected in any testcase above`;
    notes.push(message);
    harness.push(
      renderHarnessCase(
        "specs-faulted-without-outcome",
        "faulted-without-outcome",
        message,
      ),
    );
  }
  if (run.faultedContradictedByOutcome > 0) {
    // Delegated decision 2026-09-26: the stream reported a failure or fault
    // for these specs and their result row reads `pass`, which renders as a
    // bare green `<testcase/>`. The spec row is left as the result says — this
    // file reports what the runner said, it does not rewrite it — and the
    // contradiction becomes its own counted `<error>`, so the document can
    // never be green while it stands.
    const message = `${run.faultedContradictedByOutcome} spec(s) emitted a fail/error event but their outcome row reads pass; the testcase above reads green against the stream's own evidence`;
    notes.push(message);
    harness.push(
      renderHarnessCase(
        "specs-faulted-contradicted-by-outcome",
        "faulted-contradicted-by-outcome",
        message,
      ),
    );
  }
  if (run.coercedOutcomes > 0) {
    // Note only: these rows ARE in the report and ARE counted. What is wrong is
    // which bucket they landed in, and a synthetic row would not fix that.
    notes.push(
      `${run.coercedOutcomes} outcome row(s) carried a raw value outside the closed union and were resolved to \`error\`; they are inside errors="" above and are not distinguishable from genuine DEV-1 faults`,
    );
  }
  const systemErr =
    notes.length === 0
      ? ""
      : `    <system-err>${escapeXml(notes.join("\n"))}</system-err>\n`;

  // The harness rows are `<error>` elements, so they count as errors — the
  // header's "counts can never disagree with the elements emitted" holds only
  // if they are added here as well as to `tests`.
  errors += harness.length;
  const tests = run.outcomes.length + harness.length;

  const rows = [...cases, ...harness];
  const body = rows.length > 0 ? `${rows.join("\n")}\n` : "";
  const attributes = `tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}"`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="tessera" ${attributes}>\n` +
    `  <testsuite name="${escapeXml(run.runId)}" ${attributes}>\n` +
    `${body}${systemErr}` +
    `  </testsuite>\n` +
    `</testsuites>\n`
  );
}

export interface JUnitReporterOptions {
  /** Receives the whole document exactly once, at `close()`. */
  write(xml: string): Promise<void> | void;
}

export function createJUnitReporter(options: JUnitReporterOptions): Reporter {
  const collector = createEventCollector();
  let closed = false;

  return {
    onEvent(event: TestEvent): void {
      // No I/O here by design: the document needs the `end` event's outcomes,
      // and core forbids a reporter from throwing mid-stream.
      collector.record(event);
    },

    async close(runId: RunId): Promise<void> {
      // Idempotent — one run, one document. A second close writes nothing
      // rather than a second (or truncated) file.
      if (closed) return;
      closed = true;
      // A write fault is NOT swallowed: core's `closeReporters` turns a
      // rejecting close into a visible `collect` stage failure, and a JUnit
      // file that silently failed to appear is worse than a loud one.
      await options.write(renderJUnit(collector.snapshot(runId)));
    },
  };
}
