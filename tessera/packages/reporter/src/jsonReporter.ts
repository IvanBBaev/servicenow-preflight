// The `--json` `Reporter` — the machine-readable half of DESIGN §12.3 row 7.
//
// ONE DOCUMENT, ONE WRITE. `close()` calls `write` exactly once with a single
// `JSON.stringify(doc, null, 2)`. That is the existing convention in
// `@tessera/cli`'s `coverage.ts` ("One document, one write. A consumer piping
// stdout into a parser must not have to reassemble it, and a second `stdout`
// call is how that breaks") and it holds here for the same reason: this
// document is meant to be piped.
//
// FIXED KEY SET — `runId`, `ended`, `outcomes`, `failures`, `errors`, `counts`,
// `dropped`, `droppedOutcomeRows`, `coercedOutcomes`, `startedWithoutOutcome`,
// `faultedWithoutOutcome`, `faultedContradictedByOutcome`. The same twelve keys
// appear whatever happened, including a run that produced no
// events at all: a consumer that has to test for the presence of a key before
// reading it is a consumer that will eventually read the wrong thing. Empty
// arrays and zeroed counts are the honest encoding of "nothing arrived".
//
// THE LAST SIX ARE THE CAVEAT BLOCK, and they are here for the QA-9 reason
// — they are the keys a machine consumer cannot do without. The console
// reporter warns in prose and JUnit says so in `<system-err>`; a `--json`
// consumer reads neither, and unlike a human reading a summary it cannot
// notice that a caveat is absent. Without them an aborted run, a run whose
// result rows were unreadable, and a clean run with nothing to report all
// serialise to the same document — precisely the "unreadable is not empty"
// collapse the design forbids. A zeroed `counts` is only honest if the reader
// can also see whether the stream that produced it was whole.
//
// The block was originally just `ended` + `dropped`, which was not enough:
// `dropped` counts whole events, and the three shapes that actually corrupt
// the numbers beside it are row-level. `droppedOutcomeRows` is subtracted from
// `counts.total`, `coercedOutcomes` is hiding inside `counts.error`, and
// `startedWithoutOutcome` can be nonzero while `ended` is true — a document
// asserting its own completeness with the evidence of incompleteness already
// deleted. See `collect.ts`'s header for why they are separate fields and not one.
// `faultedWithoutOutcome` joined the block on 2026-09-25 (delegated decision):
// a `fail` event the result then omitted left `counts` all-zero and no key said
// so. `faultedContradictedByOutcome` joined on 2026-09-26 (delegated decision):
// a `fail` event followed by a `pass` row for the same spec left `counts`
// reading all-pass, and no key said so either.
//
// This is deliberately NOT the `PreflightVerdict` wire shape. That document
// (USER-JOURNEY §10, the `confirm_ready` shape) is the GateEvaluator's to
// emit, and it is what a gate reads. This one is the event stream's own record
// — what the runner said, before anything resolved it into a status.
//
// TM-1. Every value comes from the collector, which rebuilds objects from
// declared fields only. Nothing here stringifies a `TestEvent`, a `RunResult`
// or a `SpecOutcome` that came off the wire, so an undeclared property cannot
// ride into the document on a spread.
//
// Counts are derived from `outcomes` by the collector on every snapshot, so
// `counts.total` and `outcomes.length` are the same number by construction.

import type { Reporter } from "@tessera/core";
import type { RunId, TestEvent } from "@tessera/types";

import { createEventCollector } from "./collect.js";
import type { CollectedRun, OutcomeCounts } from "./collect.js";

/** The exact document `createJsonReporter` writes. */
export interface JsonReport {
  runId: RunId;
  /** False when no terminal `end` event arrived — an aborted or crashed run. */
  ended: boolean;
  outcomes: CollectedRun["outcomes"];
  failures: CollectedRun["failures"];
  errors: CollectedRun["errors"];
  counts: OutcomeCounts;
  /** Whole events that could not be read as their declared shape. */
  dropped: number;
  /** Result rows lost inside a valid `end` — these ARE missing from `counts`. */
  droppedOutcomeRows: number;
  /** Rows whose `raw` was replaced with `error`; they sit inside `counts.error`. */
  coercedOutcomes: number;
  /** Specs that emitted `start` and appear in no outcome row. */
  startedWithoutOutcome: number;
  /** Specs that emitted `fail`/`error` and appear in no outcome row. */
  faultedWithoutOutcome: number;
  /** Specs that emitted `fail`/`error` and whose outcome row reads `pass`. */
  faultedContradictedByOutcome: number;
}

/** Pure — exported so a caller can embed the same shape without a reporter. */
export function buildJsonReport(run: CollectedRun): JsonReport {
  return {
    runId: run.runId,
    ended: run.ended,
    outcomes: run.outcomes,
    failures: run.failures,
    errors: run.errors,
    counts: run.counts,
    dropped: run.dropped,
    droppedOutcomeRows: run.droppedOutcomeRows,
    coercedOutcomes: run.coercedOutcomes,
    startedWithoutOutcome: run.startedWithoutOutcome,
    faultedWithoutOutcome: run.faultedWithoutOutcome,
    faultedContradictedByOutcome: run.faultedContradictedByOutcome,
  };
}

export interface JsonReporterOptions {
  /** Receives the whole document exactly once, at `close()`. */
  write(json: string): Promise<void> | void;
}

export function createJsonReporter(options: JsonReporterOptions): Reporter {
  const collector = createEventCollector();
  let closed = false;

  return {
    onEvent(event: TestEvent): void {
      // Collect only. All I/O belongs in `close()` — `onEvent` is synchronous
      // and must not throw (core swallows what it throws).
      collector.record(event);
    },

    async close(runId: RunId): Promise<void> {
      // Idempotent, and it still writes when no `end` event ever arrived: an
      // aborted run owes the ARCH-24 boundary a document, and `counts.total: 0`
      // with an empty `outcomes` is what it has to say.
      if (closed) return;
      closed = true;
      const document = buildJsonReport(collector.snapshot(runId));
      await options.write(JSON.stringify(document, null, 2));
    },
  };
}
