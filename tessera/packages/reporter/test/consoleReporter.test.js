// The console reporter — `tess run --live` and its quiet default.
//
// The assertion that carries the most weight is the last one in the first
// block: the two modes must produce the SAME summary. A `--live` run and a CI
// run reading the same stream that disagreed about how many things failed
// would make the flag a correctness switch instead of a display one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RENDERED_TEXT_LENGTH,
  createConsoleReporter,
  sanitizeLine,
} from "../build/index.js";

import { RUN_ID, spec } from "./support.js";

const STREAM = [
  { kind: "start", runId: RUN_ID, spec: spec("alpha") },
  { kind: "pass", runId: RUN_ID, spec: spec("alpha") },
  { kind: "start", runId: RUN_ID, spec: spec("beta") },
  {
    kind: "fail",
    runId: RUN_ID,
    spec: spec("beta"),
    assertion: "expected 3, got 4",
    artifacts: [{ kind: "atf-result", ref: `${RUN_ID}/beta.json` }],
  },
  { kind: "log", runId: RUN_ID, message: "polling sys_atf_test_result" },
  { kind: "error", runId: RUN_ID, cause: "CI/CD API unreachable" },
  {
    kind: "end",
    runId: RUN_ID,
    result: {
      runId: RUN_ID,
      outcomes: [
        { spec: spec("alpha"), raw: "pass" },
        { spec: spec("beta"), raw: "fail" },
      ],
    },
  },
];

function drive(options) {
  const lines = [];
  const reporter = createConsoleReporter({
    write: (line) => lines.push(line),
    ...options,
  });
  for (const event of STREAM) reporter.onEvent(event);
  return { reporter, lines };
}

describe("console reporter", () => {
  it("live:true streams a line per event as it arrives", () => {
    const lines = [];
    const reporter = createConsoleReporter({
      write: (line) => lines.push(line),
      live: true,
    });
    reporter.onEvent(STREAM[0]);
    assert.equal(lines.length, 0, "a non-verbose stream omits `start`");
    reporter.onEvent(STREAM[1]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /pass\s+alpha/);
    reporter.onEvent(STREAM[3]);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /FAIL\s+beta .*: expected 3, got 4/);
  });

  it("live:false stays silent until close(), then prints the summary", async () => {
    const { reporter, lines } = drive({ live: false });
    assert.deepEqual(lines, [], "nothing before close()");
    await reporter.close(RUN_ID);
    assert.ok(lines.length > 0);
    assert.ok(lines.some((line) => line.includes(`run ${RUN_ID}`)));
  });

  it("both modes agree on the summary", async () => {
    const live = drive({ live: true });
    const quiet = drive({ live: false });
    await live.reporter.close(RUN_ID);
    await quiet.reporter.close(RUN_ID);

    assert.ok(
      live.lines.length > quiet.lines.length,
      "live streamed extra lines",
    );
    assert.deepEqual(
      live.lines.slice(-quiet.lines.length),
      quiet.lines,
      "the tail of the live output is exactly the quiet output",
    );
  });

  it("the summary reports counts, failed assertions and DEV-1 errors apart", async () => {
    const { reporter, lines } = drive({ live: false });
    await reporter.close(RUN_ID);
    const text = lines.join("\n");
    assert.match(text, /outcomes: 2/);
    assert.match(text, /pass=1/);
    assert.match(text, /fail=1/);
    assert.match(text, /failed assertions:/);
    assert.match(text, /expected 3, got 4/);
    assert.match(text, /infrastructure errors \(DEV-1\):/);
    assert.match(text, /CI\/CD API unreachable/);
  });

  it("verbose adds lines without changing a single count", async () => {
    const plain = drive({ live: false });
    const loud = drive({ live: false, verbose: true });
    await plain.reporter.close(RUN_ID);
    await loud.reporter.close(RUN_ID);
    const countLine = (lines) => lines.find((line) => line.includes("pass="));
    assert.equal(countLine(loud.lines), countLine(plain.lines));
    assert.ok(loud.lines.length > plain.lines.length);
    assert.ok(loud.lines.join("\n").includes("outcomes (raw):"));
  });

  it("warns loudly when no terminal `end` event arrived (ARCH-24)", async () => {
    const lines = [];
    const reporter = createConsoleReporter({
      write: (line) => lines.push(line),
    });
    reporter.onEvent({ kind: "pass", runId: RUN_ID, spec: spec("alpha") });
    await reporter.close(RUN_ID);
    assert.match(lines.join("\n"), /no terminal `end` event arrived/);
  });

  it("counts malformed events instead of guessing at them", async () => {
    const lines = [];
    const reporter = createConsoleReporter({
      write: (line) => lines.push(line),
    });
    reporter.onEvent({ kind: "not-a-kind", runId: RUN_ID });
    reporter.onEvent(null);
    await reporter.close(RUN_ID);
    assert.match(
      lines.join("\n"),
      /2 event\(s\) did not match a declared TestEvent shape/,
    );
  });

  it("says which caveat applies rather than folding them into one count", async () => {
    const lines = [];
    const reporter = createConsoleReporter({
      write: (line) => lines.push(line),
    });
    reporter.onEvent({ kind: "not-a-kind", runId: RUN_ID });
    reporter.onEvent({ kind: "start", runId: RUN_ID, spec: spec("vanished") });
    reporter.onEvent({
      kind: "end",
      runId: RUN_ID,
      result: {
        runId: RUN_ID,
        outcomes: [{ spec: spec("alpha"), raw: "who-knows" }, null],
      },
    });
    await reporter.close(RUN_ID);
    const text = lines.join("\n");
    // Four different damages to the summary above, four different sentences.
    // A single "2 dropped" would have been true of none of them.
    assert.match(text, /1 event\(s\) did not match a declared TestEvent shape/);
    assert.match(text, /1 result row\(s\) were unreadable/);
    assert.match(text, /1 row\(s\) carried an unknown raw value/);
    assert.match(text, /1 spec\(s\) started and appear in no outcome row/);
  });

  it("reports a vanished spec even when the run ended cleanly", async () => {
    const lines = [];
    const reporter = createConsoleReporter({
      write: (line) => lines.push(line),
    });
    reporter.onEvent({ kind: "start", runId: RUN_ID, spec: spec("alpha") });
    reporter.onEvent({ kind: "start", runId: RUN_ID, spec: spec("vanished") });
    reporter.onEvent({
      kind: "end",
      runId: RUN_ID,
      result: {
        runId: RUN_ID,
        outcomes: [{ spec: spec("alpha"), raw: "pass" }],
      },
    });
    await reporter.close(RUN_ID);
    const text = lines.join("\n");
    // The ARCH-24 warning does NOT fire here, which is the point: the caveat
    // must not be conditioned on `ended`, or a run that looks complete hides
    // the one unit it deleted.
    assert.equal(text.includes("no terminal `end` event arrived"), false);
    assert.match(text, /1 spec\(s\) started and appear in no outcome row/);
  });

  it("reports a spec that failed and appears in no outcome row (2026-09-25)", async () => {
    const lines = [];
    const reporter = createConsoleReporter({
      write: (line) => lines.push(line),
    });
    reporter.onEvent({ kind: "start", runId: RUN_ID, spec: spec("alpha") });
    reporter.onEvent({
      kind: "fail",
      runId: RUN_ID,
      spec: spec("alpha"),
      assertion: "expected 1, got 2",
    });
    reporter.onEvent({
      kind: "end",
      runId: RUN_ID,
      result: { runId: RUN_ID, outcomes: [] },
    });
    await reporter.close(RUN_ID);
    assert.match(
      lines.join("\n"),
      /ERROR: 1 spec\(s\) emitted a fail\/error event and appear in no outcome row/,
    );
  });

  it("prints an ERROR line when a fail event is contradicted by a pass row (2026-09-26)", async () => {
    const lines = [];
    const reporter = createConsoleReporter({
      write: (line) => lines.push(line),
    });
    reporter.onEvent({
      kind: "fail",
      runId: RUN_ID,
      spec: spec("alpha"),
      assertion: "expected 1, got 2",
    });
    reporter.onEvent({
      kind: "end",
      runId: RUN_ID,
      result: {
        runId: RUN_ID,
        outcomes: [{ spec: spec("alpha"), raw: "pass" }],
      },
    });
    await reporter.close(RUN_ID);
    assert.match(
      lines.join("\n"),
      /ERROR: 1 spec\(s\) emitted a fail\/error event but their outcome row reads pass/,
    );
  });

  describe("sanitizeLine", () => {
    it("strips ANSI escapes and every other control character", () => {
      const painted = "\u001b[31mred\u001b[0m\u0007bell";
      const clean = sanitizeLine(painted);
      // eslint-disable-next-line no-control-regex
      assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(clean), false);
      assert.ok(clean.includes("red"));
    });

    it("renders bidi and zero-width characters as a visible escape (2026-09-25)", () => {
      assert.equal(sanitizeLine("a\u202Eb"), "a<U+202E>b");
      assert.equal(sanitizeLine("a\u200Bb"), "a<U+200B>b");
      assert.equal(sanitizeLine("a\uFEFFb"), "a<U+FEFF>b");
      assert.equal(sanitizeLine("\u2066x\u2069"), "<U+2066>x<U+2069>");
      assert.equal(
        /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(
          sanitizeLine(
            "\u200B\u200C\u200D\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\uFEFF",
          ),
        ),
        false,
      );
    });

    it("escapes the whole invisible-format family, astral ones by code point (2026-09-26)", () => {
      // Every range endpoint the widened set promises. Before 2026-09-26 all of
      // these except the three already listed passed through untouched.
      const points = [
        0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e,
        0x180f, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2063, 0x206a, 0x206f,
        0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0xe0000, 0xe0001, 0xe0061,
        0xe007f, 0xe0100, 0xe01ef,
      ];
      for (const point of points) {
        const token = `<U+${point.toString(16).toUpperCase().padStart(4, "0")}>`;
        assert.equal(
          sanitizeLine(`a${String.fromCodePoint(point)}b`),
          `a${token}b`,
          `U+${point.toString(16)}`,
        );
      }
      // One token per astral character — never a pair of surrogate halves.
      assert.equal(sanitizeLine("x\u{E0061}y"), "x<U+E0061>y");
      assert.equal(sanitizeLine("x\u{E0061}y").includes("DB40"), false);
      // Neighbours of the ranges stay as they are.
      assert.equal(
        sanitizeLine("a\u00AEb\u{1F600}c\u3165d"),
        "a\u00AEb\u{1F600}c\u3165d",
      );
    });

    it("keeps a rendered line on one line", () => {
      assert.equal(sanitizeLine("a\nb\r\nc"), "a b c");
    });

    it("caps at MAX_RENDERED_TEXT_LENGTH without splitting a surrogate pair", () => {
      const long = "x".repeat(MAX_RENDERED_TEXT_LENGTH - 1) + "\u{1F600}tail";
      const clean = sanitizeLine(long);
      assert.ok(clean.endsWith("… (truncated)"));
      const body = clean.slice(0, -"… (truncated)".length);
      assert.ok(body.length <= MAX_RENDERED_TEXT_LENGTH);
      assert.equal(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body),
        false,
        "no dangling high surrogate",
      );
    });

    it("caps an assertion rendered into the stream", () => {
      const lines = [];
      const reporter = createConsoleReporter({
        write: (line) => lines.push(line),
        live: true,
      });
      reporter.onEvent({
        kind: "fail",
        runId: RUN_ID,
        spec: spec("beta"),
        assertion: "y".repeat(5000),
      });
      assert.ok(lines[0].length < 5000);
      assert.ok(lines[0].endsWith("… (truncated)"));
    });
  });
});
