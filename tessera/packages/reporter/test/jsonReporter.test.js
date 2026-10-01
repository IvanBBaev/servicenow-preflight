// The `--json` reporter — the machine-readable half of DESIGN §12.3 row 7.
//
// Two properties carry this file, and almost every assertion below is one of
// them.
//
// The first is the FIXED KEY SET. The same twelve keys appear whatever happened,
// including a run that produced no events at all, because a consumer that has
// to test for the presence of a key before reading it is a consumer that will
// eventually read the wrong thing. That is why the "produced nothing" case
// asserts counts that are ZEROED rather than absent — the same assertion the
// JUnit suite makes about `tests="0" failures="0"`, for the same reason.
//
// Six of those twelve are the caveat block, and they are the ones this suite
// works hardest on. A `--json` consumer reads no prose: it cannot notice that a
// warning is missing the way a human reading a summary can. So every way this
// package silently decides something on the stream's behalf — dropping an
// event, dropping a result row, resolving an unknown outcome to `error`,
// accepting a result that omits a spec we saw start — has a test here proving
// the document says so.
//
// The second is that the counts are DERIVED. Nothing here compares a count to
// a number written out by hand: every assertion recomputes it from the rows in
// the SAME document, so a report whose summary drifts from its own rows fails
// here rather than in somebody's CI dashboard.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildJsonReport, createJsonReporter } from "../build/index.js";

import { RUN_ID, eventsFor, spec } from "./support.js";

/**
 * One row per member of the closed `RawOutcome` union — all seven. The first
 * row carries an `evidence` ref as well, so the document is asserted against a
 * row that has every optional field populated and not only the minimum.
 */
const ALL_OUTCOMES = [
  {
    spec: spec("a"),
    raw: "pass",
    evidence: { kind: "atf-result", ref: "8f31a0c4de11" },
  },
  { spec: spec("b"), raw: "fail" },
  { spec: spec("c"), raw: "error" },
  { spec: spec("d"), raw: "skipped" },
  { spec: spec("e"), raw: "waiting-timeout" },
  { spec: spec("f"), raw: "flaky" },
  { spec: spec("g"), raw: "missing" },
];

/** The union, in the order the rows above declare it. */
const RAW_OUTCOMES = ALL_OUTCOMES.map((outcome) => outcome.raw);

/**
 * The keys the document promises, in the order `buildJsonReport` writes them.
 * The last six are the caveat block: every one of them describes a way the
 * `counts` above it can be wrong, and a `--json` consumer has no other channel
 * to learn it from.
 */
const KEYS = [
  "runId",
  "ended",
  "outcomes",
  "failures",
  "errors",
  "counts",
  "dropped",
  "droppedOutcomeRows",
  "coercedOutcomes",
  "startedWithoutOutcome",
  "faultedWithoutOutcome",
  "faultedContradictedByOutcome",
];

/**
 * The `fail`/`error`/`log` events whose text the document carries beside the
 * rows. The last `error` deliberately has no `spec`: a run-level fault must
 * stay unattributed rather than be given an invented one.
 */
const EXTRAS = [
  {
    kind: "fail",
    runId: RUN_ID,
    spec: spec("b"),
    assertion: "expected 3, got 4",
    artifacts: [{ kind: "atf-result", ref: `${RUN_ID}/b.json` }],
  },
  {
    kind: "error",
    runId: RUN_ID,
    spec: spec("c"),
    cause: "CI/CD API returned 503",
  },
  { kind: "error", runId: RUN_ID, cause: "instance unreachable" },
  { kind: "log", runId: RUN_ID, message: "polling sys_atf_test_result" },
];

/** Drive a reporter over `events`, recording what was written and when. */
async function drive(events, closeWith = RUN_ID) {
  const writes = [];
  const reporter = createJsonReporter({ write: (json) => writes.push(json) });
  for (const event of events) reporter.onEvent(event);
  const beforeClose = writes.length;
  await reporter.close(closeWith);
  return { writes, beforeClose, document: writes[writes.length - 1] };
}

/** The parsed document — every consumer reads it this way, so the tests do too. */
async function report(events, closeWith = RUN_ID) {
  const { document } = await drive(events, closeWith);
  return JSON.parse(document);
}

describe("JSON reporter", () => {
  describe("close() is the ARCH-24 flush boundary", () => {
    it("writes nothing before it — not even after the terminal `end` event", async () => {
      const writes = [];
      const reporter = createJsonReporter({
        write: (json) => writes.push(json),
      });
      for (const event of eventsFor(ALL_OUTCOMES, EXTRAS)) {
        reporter.onEvent(event);
        assert.deepEqual(writes, [], `wrote during a ${event.kind} event`);
      }
      await reporter.close(RUN_ID);
      assert.equal(writes.length, 1, "one document, one write");
    });

    it("writes everything at it — the whole run is in that single document", async () => {
      const { document } = await drive(eventsFor(ALL_OUTCOMES, EXTRAS));
      const parsed = JSON.parse(document);
      assert.equal(parsed.outcomes.length, ALL_OUTCOMES.length);
      assert.equal(parsed.failures.length, 1);
      assert.equal(parsed.errors.length, 2);
    });
  });

  describe("the document", () => {
    it("is valid JSON and survives a round trip byte for byte", async () => {
      const { document } = await drive(eventsFor(ALL_OUTCOMES, EXTRAS));
      const parsed = JSON.parse(document);
      assert.equal(
        JSON.stringify(parsed, null, 2),
        document,
        "the written bytes are exactly the 2-space form of what parses out of them",
      );
    });

    it("has the same twelve keys, in the same order, whatever happened", async () => {
      const populated = await report(eventsFor(ALL_OUTCOMES, EXTRAS));
      const empty = await report([]);
      assert.deepEqual(Object.keys(populated), KEYS);
      assert.deepEqual(Object.keys(empty), KEYS);
    });

    // QA-9, on the wire. A `--json` consumer reads neither the console's prose
    // warning nor JUnit's `<system-err>`, so without `ended` an aborted run and
    // a clean run with nothing to say serialise identically.
    it("distinguishes an aborted run from a clean one that reported nothing", async () => {
      const whole = await report(eventsFor(ALL_OUTCOMES, EXTRAS));
      const aborted = await report([]);
      assert.equal(whole.ended, true);
      assert.equal(aborted.ended, false);
      assert.deepEqual(
        [whole.counts.total, aborted.counts.total],
        [7, 0],
        "both still carry zeroed-not-absent counts — `ended` is what tells them apart",
      );
    });

    it("reports how many events could not be read as their declared shape", async () => {
      const clean = await report(eventsFor(ALL_OUTCOMES, EXTRAS));
      assert.equal(clean.dropped, 0);
      const lossy = await report([
        ...eventsFor(ALL_OUTCOMES, EXTRAS),
        { kind: "not-an-event-kind", runId: RUN_ID },
      ]);
      assert.equal(lossy.dropped, 1);
      assert.equal(
        lossy.ended,
        true,
        "a dropped event does not un-end a run that reached its terminal event",
      );
    });

    it("names the run it is about (ARCH-16)", async () => {
      const parsed = await report(eventsFor(ALL_OUTCOMES, EXTRAS));
      assert.equal(parsed.runId, RUN_ID);
    });

    it("falls back to the id core passes to close() when no event carried one", async () => {
      const parsed = await report([]);
      assert.equal(parsed.runId, RUN_ID);
    });

    it("keeps the first run id — a second is a caller sharing one reporter", async () => {
      const parsed = await report(
        [
          { kind: "pass", runId: RUN_ID, spec: spec("a") },
          { kind: "pass", runId: "run-somebody-elses", spec: spec("b") },
        ],
        "run-closed-with",
      );
      assert.equal(parsed.runId, RUN_ID);
    });
  });

  describe("a mixed run populates every field", () => {
    it("carries one row per outcome, with its evidence, in stream order", async () => {
      const parsed = await report(eventsFor(ALL_OUTCOMES, EXTRAS));
      assert.deepEqual(parsed.outcomes, ALL_OUTCOMES);
      assert.deepEqual(
        parsed.outcomes.map((outcome) => outcome.raw),
        RAW_OUTCOMES,
        "all seven members of the closed union appear",
      );
    });

    it("carries the failed assertion and the artifacts captured with it (QA-11)", async () => {
      const parsed = await report(eventsFor(ALL_OUTCOMES, EXTRAS));
      assert.deepEqual(parsed.failures, [
        {
          spec: spec("b"),
          assertion: "expected 3, got 4",
          artifacts: [{ kind: "atf-result", ref: `${RUN_ID}/b.json` }],
        },
      ]);
    });

    it("keeps DEV-1 errors apart, and leaves a run-level one unattributed", async () => {
      const parsed = await report(eventsFor(ALL_OUTCOMES, EXTRAS));
      assert.deepEqual(parsed.errors, [
        { spec: spec("c"), cause: "CI/CD API returned 503", artifacts: [] },
        { cause: "instance unreachable", artifacts: [] },
      ]);
      assert.equal(
        "spec" in parsed.errors[1],
        false,
        "a fault with no spec is not given an invented one",
      );
    });

    it("carries no key the fixed set does not declare — `log` events are not in it", async () => {
      const { document } = await drive(eventsFor(ALL_OUTCOMES, EXTRAS));
      assert.equal(document.includes("polling sys_atf_test_result"), false);
      assert.equal(document.includes('"logs"'), false);
    });
  });

  describe("counts", () => {
    it("are derived from the rows in the same document", async () => {
      const parsed = await report(eventsFor(ALL_OUTCOMES, EXTRAS));
      for (const raw of RAW_OUTCOMES) {
        assert.equal(
          parsed.counts[raw],
          parsed.outcomes.filter((outcome) => outcome.raw === raw).length,
          `counts.${raw} disagrees with the rows beside it`,
        );
      }
      assert.equal(parsed.counts.total, parsed.outcomes.length);
    });

    it("hold one key per member of the closed union, plus the total", async () => {
      const parsed = await report(eventsFor(ALL_OUTCOMES, EXTRAS));
      assert.deepEqual(
        Object.keys(parsed.counts).sort(),
        [...RAW_OUTCOMES, "total"].sort(),
      );
    });

    it("cannot disagree when the same spec appears more than once", async () => {
      const parsed = await report(
        eventsFor([
          { spec: spec("a"), raw: "fail" },
          { spec: spec("a"), raw: "fail" },
          { spec: spec("a"), raw: "pass" },
        ]),
      );
      assert.equal(parsed.counts.fail, 2);
      assert.equal(parsed.counts.pass, 1);
      assert.equal(parsed.counts.total, 3);
      assert.equal(parsed.outcomes.length, parsed.counts.total);
    });

    it("are zeroed — not absent — for a run that produced nothing", async () => {
      const parsed = await report([]);
      for (const raw of RAW_OUTCOMES) {
        assert.equal(
          parsed.counts[raw],
          0,
          `counts.${raw} is missing, not zero`,
        );
      }
      assert.equal(parsed.counts.total, 0);
      assert.deepEqual(parsed.outcomes, []);
      assert.deepEqual(parsed.failures, []);
      assert.deepEqual(parsed.errors, []);
    });

    it("stay zeroed for a run whose every event was unreadable", async () => {
      const parsed = await report([
        { kind: "who-knows", runId: RUN_ID },
        null,
        42,
      ]);
      assert.equal(parsed.counts.total, 0);
      assert.deepEqual(parsed.outcomes, []);
    });

    it("count an outcome outside the closed union as an error, never echoing it", async () => {
      const { document } = await drive(
        eventsFor([{ spec: spec("x"), raw: "totally-fine-trust-me" }]),
      );
      assert.equal(document.includes("totally-fine-trust-me"), false);
      const parsed = JSON.parse(document);
      assert.equal(parsed.outcomes[0].raw, "error");
      assert.equal(parsed.counts.error, 1);
      assert.equal(parsed.counts.total, 1);
      // The coercion is right and the count it produces is a lie by itself:
      // `error: 1` here and `error: 1` for a real DEV-1 fault are the same two
      // characters. This field is the only thing that separates them.
      assert.equal(
        parsed.coercedOutcomes,
        1,
        "a fail-closed resolution must be declared, not just performed",
      );
    });
  });

  // The four caveat keys, one test each, against the shape each one exists for.
  // The common failure they prevent: a number that looks like a measurement and
  // is actually an artifact of something this package decided on the stream's
  // behalf.
  describe("the caveat block", () => {
    it("separates lost events from lost result rows, because only one moves the total", async () => {
      const parsed = await report([
        { kind: "who-knows", runId: RUN_ID },
        {
          kind: "end",
          runId: RUN_ID,
          result: {
            runId: RUN_ID,
            outcomes: [{ spec: spec("a"), raw: "pass" }, null, { raw: "pass" }],
          },
        },
      ]);
      assert.equal(parsed.dropped, 1, "the unknown-kind event");
      assert.equal(
        parsed.droppedOutcomeRows,
        2,
        "the null and the spec-less row",
      );
      // The distinction is the point: `total` is 1 when the run reported 3.
      // `dropped` would not have told the reader that, because a dropped event
      // was never going to be in `total` in the first place.
      assert.equal(parsed.counts.total, 1);
      assert.equal(parsed.outcomes.length, 1);
    });

    it("reports a spec that started and never appeared, even under ended: true", async () => {
      const parsed = await report([
        { kind: "start", runId: RUN_ID, spec: spec("a") },
        { kind: "start", runId: RUN_ID, spec: spec("vanished") },
        ...eventsFor([{ spec: spec("a"), raw: "pass" }]),
      ]);
      // Everything a consumer normally checks says this run is fine: it ended,
      // nothing was dropped, and the one outcome passed. The spec that
      // disappeared is visible in exactly one field.
      assert.equal(parsed.ended, true);
      assert.equal(parsed.dropped, 0);
      assert.equal(parsed.droppedOutcomeRows, 0);
      assert.equal(parsed.counts.total, 1);
      assert.equal(
        parsed.startedWithoutOutcome,
        1,
        "a unit announced and then deleted is DEV-1 by deletion, not a clean run",
      );
    });

    it("counts a vanished spec once however many times it started", async () => {
      const start = { kind: "start", runId: RUN_ID, spec: spec("vanished") };
      const parsed = await report([start, start, ...eventsFor([])]);
      // The unit is "a spec that has no row", not "a start event". A retried
      // spec that never reported is one hole in the report, not two.
      assert.equal(parsed.startedWithoutOutcome, 1);
    });

    it("is zeroed — not absent — for a run with nothing to caveat", async () => {
      const parsed = await report(
        eventsFor(
          [{ spec: spec("a"), raw: "pass" }],
          [{ kind: "start", runId: RUN_ID, spec: spec("a") }],
        ),
      );
      assert.deepEqual(
        [
          parsed.dropped,
          parsed.droppedOutcomeRows,
          parsed.coercedOutcomes,
          parsed.startedWithoutOutcome,
          parsed.faultedWithoutOutcome,
          parsed.faultedContradictedByOutcome,
        ],
        [0, 0, 0, 0, 0, 0],
        "the keys are present at zero; a consumer must never have to test for them",
      );
    });
  });

  describe("a malformed or incomplete end (2026-09-25)", () => {
    it("does not read an end whose outcomes is not an array as a clean empty run", async () => {
      const parsed = await report([
        { kind: "start", runId: RUN_ID, spec: spec("a") },
        {
          kind: "end",
          runId: RUN_ID,
          result: { runId: RUN_ID, outcomes: "not-an-array" },
        },
      ]);
      assert.equal(
        parsed.ended,
        false,
        "a malformed end is not a terminal end",
      );
      assert.equal(parsed.dropped, 1, "the malformed end is a dropped event");
    });

    it("reports a spec that failed and appears in no outcome row", async () => {
      const parsed = await report([
        { kind: "start", runId: RUN_ID, spec: spec("a") },
        {
          kind: "fail",
          runId: RUN_ID,
          spec: spec("a"),
          assertion: "expected 1, got 2",
        },
        ...eventsFor([]),
      ]);
      assert.equal(parsed.ended, true);
      assert.equal(parsed.counts.total, 0);
      assert.equal(parsed.faultedWithoutOutcome, 1);
    });

    it("reports a spec that failed and whose outcome row reads pass (2026-09-26)", async () => {
      const parsed = await report([
        {
          kind: "fail",
          runId: RUN_ID,
          spec: spec("a"),
          assertion: "expected 1, got 2",
        },
        { kind: "error", runId: RUN_ID, spec: spec("a"), cause: "again" },
        { kind: "error", runId: RUN_ID, spec: spec("b"), cause: "fault" },
        {
          kind: "fail",
          runId: RUN_ID,
          spec: spec("c"),
          assertion: "agrees with its row",
        },
        ...eventsFor([
          { spec: spec("a"), raw: "pass" },
          { spec: spec("b"), raw: "pass" },
          { spec: spec("c"), raw: "fail" },
        ]),
      ]);
      // Once per spec: `a` has two contradicted events and counts once; `c`'s
      // row agrees with its event and does not count.
      assert.equal(parsed.faultedContradictedByOutcome, 2);
      assert.equal(parsed.faultedWithoutOutcome, 0);
    });
  });

  describe("buildJsonReport", () => {
    const snapshot = {
      runId: RUN_ID,
      ended: true,
      outcomes: [{ spec: spec("a"), raw: "pass" }],
      failures: [],
      errors: [],
      logs: ["a log line the document does not carry"],
      started: [spec("a")],
      counts: {
        pass: 1,
        fail: 0,
        error: 0,
        skipped: 0,
        "waiting-timeout": 0,
        flaky: 0,
        missing: 0,
        total: 1,
      },
      dropped: 0,
      droppedOutcomeRows: 0,
      coercedOutcomes: 0,
      startedWithoutOutcome: 0,
      faultedWithoutOutcome: 0,
      faultedContradictedByOutcome: 0,
    };

    it("is pure — the same snapshot builds the same document", () => {
      assert.deepEqual(buildJsonReport(snapshot), buildJsonReport(snapshot));
      assert.equal(
        JSON.stringify(buildJsonReport(snapshot)),
        JSON.stringify(buildJsonReport(snapshot)),
      );
    });

    it("projects the snapshot onto the fixed key set and nothing else", () => {
      assert.deepEqual(Object.keys(buildJsonReport(snapshot)), KEYS);
    });

    it("builds the same document the reporter writes", async () => {
      const { document } = await drive(
        eventsFor(
          [{ spec: spec("a"), raw: "pass" }],
          [
            { kind: "start", runId: RUN_ID, spec: spec("a") },
            { kind: "log", runId: RUN_ID, message: snapshot.logs[0] },
          ],
        ),
      );
      assert.equal(
        document,
        JSON.stringify(buildJsonReport(snapshot), null, 2),
      );
    });
  });
});
