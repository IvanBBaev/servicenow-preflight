// The JUnit reporter — the document a CI server parses.
//
// The escaping block is the one that matters. Every string in it is text a
// ServiceNow instance chose (an ATF assertion, a script's console output), and
// an XML document that a CI server cannot parse is a test run whose evidence
// vanished. `]]>` gets its own case because CDATA is the usual way a reporter
// tries to avoid escaping, and the usual way it then breaks.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createJUnitReporter, escapeXml, renderJUnit } from "../build/index.js";

import { RUN_ID, assertWellFormedXml, eventsFor, spec } from "./support.js";

function render(events) {
  let document = "";
  const reporter = createJUnitReporter({
    write: (xml) => {
      document = xml;
    },
  });
  for (const event of events) reporter.onEvent(event);
  return reporter.close(RUN_ID).then(() => document);
}

/** Every attribute of the first `<testcase>` whose name matches. */
function testcaseFor(xml, id) {
  // The self-closing alternative has to be its OWN branch: inside a single
  // `[^>]*(?:/>|>...)` the greedy class swallows the `/` and then matches the
  // open-tag branch, running the capture on into the NEXT testcase.
  const match = new RegExp(
    `<testcase name="${id}"[^>]*/>|<testcase name="${id}"[^>]*>[\\s\\S]*?</testcase>`,
  ).exec(xml);
  assert.ok(match, `no <testcase name="${id}"> in:\n${xml}`);
  return match[0];
}

/**
 * Tokens that carry a digit and are not a claim about a number: DESIGN section
 * refs (§6a) and decision ids (DEV-1, QA-9, ARCH-24, TM-3). Stripped before
 * the rule below looks for one, so citing §6a is not mistaken for stating a
 * code.
 */
const NOT_A_NUMERIC_CLAIM = /§\d+[a-z]?|\b(?:ARCH|DEV|QA|TM|DR)-\d+/gi;

/**
 * THE RULE: a message that talks about `tess run` or about an exit code may
 * not carry a number.
 *
 * Phrased as proximity to the SUBJECT rather than as a list of wordings,
 * because the wordings are unbounded. A first attempt matched "exit(s|ed)
 * <digit>" and was itself a fixture in disguise: `tess run` returns 5 for
 * this` slipped straight through it, since the digit was nowhere near the word
 * "exit". What is actually forbidden is this package quantifying the CLI's
 * behaviour at all — so the trigger is the subject being mentioned, and the
 * violation is any number left once the citations are removed.
 */
function statesANumberAboutTheCli(text) {
  if (!/\btess run\b|\bexit\b/i.test(text)) return false;
  return /\d/.test(text.replace(NOT_A_NUMERIC_CLAIM, ""));
}

/** Every string this document actually shows a reader. */
function emittedMessages(xml) {
  const messages = [...xml.matchAll(/message="([^"]*)"/g)].map((m) => m[1]);
  for (const [, body] of xml.matchAll(/<system-err>([\s\S]*?)<\/system-err>/g))
    messages.push(body);
  return messages;
}

const ALL_OUTCOMES = [
  { spec: spec("a"), raw: "pass" },
  { spec: spec("b"), raw: "fail" },
  { spec: spec("c"), raw: "error" },
  { spec: spec("d"), raw: "skipped" },
  { spec: spec("e"), raw: "waiting-timeout" },
  { spec: spec("f"), raw: "flaky" },
  { spec: spec("g"), raw: "missing" },
];

describe("JUnit reporter", () => {
  it("writes one well-formed document, exactly once, at close()", async () => {
    const writes = [];
    const reporter = createJUnitReporter({ write: (xml) => writes.push(xml) });
    for (const event of eventsFor(ALL_OUTCOMES)) reporter.onEvent(event);
    assert.equal(writes.length, 0, "no I/O before close()");
    await reporter.close(RUN_ID);
    assert.equal(writes.length, 1);
    assertWellFormedXml(writes[0]);
    assert.ok(writes[0].startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  });

  describe("outcome to element mapping", () => {
    const expected = {
      a: { raw: "pass", element: "none" },
      b: { raw: "fail", element: "failure" },
      c: { raw: "error", element: "error" },
      d: { raw: "skipped", element: "skipped" },
      e: { raw: "waiting-timeout", element: "error" },
      f: { raw: "flaky", element: "error" },
      g: { raw: "missing", element: "failure" },
    };

    for (const [id, { raw, element }] of Object.entries(expected)) {
      it(`${raw} renders ${element === "none" ? "a bare testcase" : `<${element}>`}`, async () => {
        const xml = await render(eventsFor(ALL_OUTCOMES));
        const testcase = testcaseFor(xml, id);
        if (element === "none") {
          assert.ok(testcase.endsWith("/>"), testcase);
          assert.equal(/<(failure|error|skipped)/.test(testcase), false);
        } else {
          assert.ok(testcase.includes(`<${element}`), testcase);
        }
      });
    }

    it('the `type` attribute carries the raw outcome, so "flaky" is not read as a plain error', async () => {
      const xml = await render(eventsFor(ALL_OUTCOMES));
      assert.ok(testcaseFor(xml, "f").includes('type="flaky"'));
      assert.ok(testcaseFor(xml, "e").includes('type="waiting-timeout"'));
    });

    it("classname is the spec path, name is the spec id", async () => {
      const xml = await render(eventsFor([{ spec: spec("b"), raw: "fail" }]));
      assert.ok(xml.includes('<testcase name="b" classname="tests/b.unit.ts"'));
    });

    it("an outcome outside the closed union is reported as an error, not printed", async () => {
      const xml = await render(
        eventsFor([{ spec: spec("x"), raw: "totally-fine-trust-me" }]),
      );
      assert.equal(xml.includes("totally-fine-trust-me"), false);
      assert.ok(testcaseFor(xml, "x").includes("<error"));
      assert.ok(xml.includes('errors="1"'));
    });
  });

  describe("counts", () => {
    it("derive from the outcome array", async () => {
      const xml = await render(eventsFor(ALL_OUTCOMES));
      // 7 outcomes: 2 failures (fail, missing), 3 errors (error,
      // waiting-timeout, flaky), 1 skipped, 1 pass.
      assert.ok(
        xml.includes('tests="7" failures="2" errors="3" skipped="1"'),
        xml,
      );
    });

    it("are zeroed — not absent — for a run that ended with nothing to report", async () => {
      // A run that reached its terminal `end` and had no specs. This is the
      // only shape that legitimately reads as all-zero, and it is worth an
      // explicit case now that the aborted shape below does NOT.
      const xml = await render(eventsFor([]));
      assert.ok(
        xml.includes('tests="0" failures="0" errors="0" skipped="0"'),
        xml,
      );
      assertWellFormedXml(xml);
    });

    it("do not read as all-zero for a run that never ended", async () => {
      // This assertion used to expect the all-zero attributes, which encoded
      // the defect as the expectation: an aborted run and a clean empty run
      // serialised to the same numbers, and `tests="0" errors="0"` is what a CI
      // dashboard reads as "green, nothing to do". The `<system-err>` note said
      // otherwise, but nothing that counts was reading it.
      const xml = await render([]);
      assert.ok(
        xml.includes('tests="1" failures="0" errors="1" skipped="0"'),
        xml,
      );
      assertWellFormedXml(xml);
    });

    it("count elements actually emitted, so they cannot disagree", async () => {
      const xml = await render(eventsFor(ALL_OUTCOMES));
      const count = (needle) => xml.split(needle).length - 1;
      assert.equal(count("<testcase "), 7);
      assert.equal(count("<failure "), 2);
      assert.equal(count("<error "), 3);
      assert.equal(count("<skipped "), 1);
    });

    it("count a harness row into both tests and errors", async () => {
      // The invariant the header claims — attributes never disagree with the
      // elements emitted — has to hold for synthetic rows too, or adding them
      // trades a silent undercount for a silent inconsistency.
      const xml = await render([
        { kind: "error", runId: RUN_ID, cause: "instance unreachable" },
      ]);
      const count = (needle) => xml.split(needle).length - 1;
      // Two harness rows: the run-level error, and the missing `end`.
      assert.equal(count("<testcase "), 2);
      assert.equal(count("<error "), 2);
      assert.ok(
        xml.includes('tests="2" failures="0" errors="2" skipped="0"'),
        xml,
      );
    });
  });

  describe("message text", () => {
    it("a fail carries the assertion captured from its event", async () => {
      const xml = await render(
        eventsFor(
          [{ spec: spec("b"), raw: "fail" }],
          [
            {
              kind: "fail",
              runId: RUN_ID,
              spec: spec("b"),
              assertion: "expected 3, got 4",
            },
          ],
        ),
      );
      assert.ok(testcaseFor(xml, "b").includes("expected 3, got 4"));
    });

    it("a spec failing twice keeps both assertions", async () => {
      const xml = await render(
        eventsFor(
          [{ spec: spec("b"), raw: "fail" }],
          [
            {
              kind: "fail",
              runId: RUN_ID,
              spec: spec("b"),
              assertion: "first",
            },
            {
              kind: "fail",
              runId: RUN_ID,
              spec: spec("b"),
              assertion: "second",
            },
          ],
        ),
      );
      const testcase = testcaseFor(xml, "b");
      assert.ok(testcase.includes("first"));
      assert.ok(testcase.includes("second"));
    });

    it("an error-shaped outcome carries the DEV-1 cause, not an assertion", async () => {
      const xml = await render(
        eventsFor(
          [{ spec: spec("c"), raw: "error" }],
          [
            {
              kind: "error",
              runId: RUN_ID,
              spec: spec("c"),
              cause: "CI/CD API returned 503",
            },
          ],
        ),
      );
      assert.ok(testcaseFor(xml, "c").includes("CI/CD API returned 503"));
    });

    it("falls back to a stated default rather than an empty message", async () => {
      const xml = await render(
        eventsFor([{ spec: spec("g"), raw: "missing" }]),
      );
      assert.ok(testcaseFor(xml, "g").includes("no result row was produced"));
    });

    // ── the skipped row's message ────────────────────────────────────────
    //
    // RATIFIED BEHAVIOUR CHANGE (2026-09-01), not a fixture repair. Until this
    // date the emitted message ended "...and `tess run` exits 5", and this
    // test asserted `/exits 5/`. `tess run` cannot exit 5: its mapping is
    // frozen at Phase 0.5's two outcomes (@tessera/cli's `runExitDisposition`
    // — GO → 0, everything else → 1), so a blocking `skipped` exits 1, the
    // same 1 a genuine NO_GO exits with. The claim shipped to CI readers in
    // the XML itself, and the exit code it named was not merely the wrong
    // number: it was the number that would have made the case
    // distinguishable, when the real one does not.
    //
    // This is the FOURTH instance in this repo of the same rule: A TEST
    // WRITTEN TO ASSERT THE BEHAVIOUR JUST PINS WHATEVER THE BEHAVIOUR WAS.
    // `/exits 5/` did not check that the message was true; it checked that the
    // message had not changed, and so it held the false claim in place through
    // every run of the suite. (Compare `packages/cli/test/skeleton.test.js`'s
    // §11.4 block and `packages/mcp/test/tools.test.js:454`, where the same
    // class was found and fixed before.)
    //
    // The PROPERTY has not changed and is what the assertions below still
    // check: the element stays `<skipped/>` and the message names the
    // consequence the element cannot carry. Only the claim about the exit code
    // was wrong — so it is gone, and no number replaces it (see the
    // invariant test after this one for why a number cannot come back).
    it("a skipped row names the blocking consequence its element cannot carry", async () => {
      const xml = await render(
        eventsFor([{ spec: spec("d"), raw: "skipped" }]),
      );
      const testcase = testcaseFor(xml, "d");
      const message = /<skipped message="([^"]*)"/.exec(testcase)?.[1] ?? "";
      // Non-empty first: every assertion below is a `match`, and a match
      // against an empty message is a test that cannot fail for the reason it
      // exists.
      assert.ok(message.length > 0, "the skipped row carries a message");
      // The escape hatch a reader can act on, and the §6a consequence.
      assert.match(message, /allow-skipped/);
      assert.match(message, /BLOCKING inconclusive/);
      // Where the distinction the exit code loses is actually published. A
      // message that says "do not trust the exit code" and stops has told a CI
      // reader they have a problem and not where the answer is.
      assert.match(message, /VERDICT/);
      assert.match(message, /verdict\.exitCodeCollapsed/);
      // The element stays as it is — promoting it to `<error>` would misreport
      // what happened in order to report what it means.
      assert.ok(testcase.includes("<skipped "), "the element is unchanged");
      assert.equal(testcase.includes("<error "), false);
    });

    it("names no process exit code anywhere in the document", async () => {
      // The invariant, not the string. A test that asserted the corrected
      // wording verbatim would be the same trap one level over: it would pin
      // today's sentence exactly as `/exits 5/` pinned yesterday's, and go on
      // passing when the sentence became false again.
      //
      // Scanned over the MESSAGES rather than the whole document: `tests="7"`
      // is a count, not a claim, and a rule that could not tell them apart
      // would be dropped the first time it cried wolf.
      //
      // What is actually being asserted is that this package makes NO claim it
      // cannot check. @tessera/reporter does not depend on @tessera/cli (the
      // dependency edge runs cli → reporter, so importing `runExitDisposition`
      // here would invert it), which means no exit code written into this
      // document is verifiable from inside this package — which is precisely
      // how "exits 5" survived. The self-consistent rule is therefore that the
      // document names none, and that IS checkable here.
      //
      // The cross-package property this stands in for — "the number the XML
      // names is one `tess run` can produce" — belongs in a test under
      // packages/cli, which may legally import both sides. Proposed, not
      // written here: that package is outside this one's reach.
      const documents = [
        // Every default message, plus a run-level harness row and the
        // dropped-event note.
        await render([
          { kind: "error", runId: RUN_ID, cause: "instance unreachable" },
          { kind: "unknown-kind", runId: RUN_ID },
          ...eventsFor(ALL_OUTCOMES),
        ]),
        // Cut short: the run-incomplete and started-without-outcome rows.
        await render([{ kind: "start", runId: RUN_ID, spec: spec("h") }]),
        // Unreadable result rows and a raw value outside the closed union.
        await render(
          eventsFor([null, 5, { spec: spec("x"), raw: "not-an-outcome" }]),
        ),
      ];
      let subjects = 0;
      for (const xml of documents) {
        for (const message of emittedMessages(xml)) {
          if (/\btess run\b|\bexit\b/i.test(message)) subjects += 1;
          assert.equal(
            statesANumberAboutTheCli(message),
            false,
            `this message states a number about the CLI that nothing in this package can check:\n${message}`,
          );
        }
      }
      // Not vacuous: at least one emitted message DOES discuss `tess run` /
      // the exit code, so the rule above was actually applied to something. A
      // reworded document that stopped mentioning the subject would otherwise
      // pass this test by saying nothing.
      assert.ok(subjects > 0, "no emitted message mentions the subject");
    });
  });

  // Run-level conditions get BOTH a counted `<testcase>` and their prose note.
  // The earlier rule here was "system-err, never a fake testcase", on the
  // premise that a `<testcase>` is a planned spec. That premise describes our
  // usage of the format, not the format: in JUnit a `<testcase>` is the unit of
  // result accounting (Surefire reports suite-setup failures this way, pytest
  // reports collection errors), so a run-level fault with no numeric weight is
  // a fault no counting consumer can see.
  describe("run-level conditions are counted AND described", () => {
    it("an error with no spec becomes a marked harness row, keeping its note", async () => {
      const xml = await render(
        eventsFor(
          [{ spec: spec("a"), raw: "pass" }],
          [{ kind: "error", runId: RUN_ID, cause: "instance unreachable" }],
        ),
      );
      // The note is kept, not moved. Dropping the human-readable detail to gain
      // the count would be the same defect in the other direction.
      assert.ok(xml.includes("<system-err>"));
      assert.ok(xml.includes("instance unreachable"));
      assert.ok(
        xml.includes('tests="2" failures="0" errors="1" skipped="0"'),
        "the run-level error carries numeric weight",
      );
      assertWellFormedXml(xml);
    });

    it("marks harness rows with a stable classname a consumer can filter on", async () => {
      const xml = await render(
        eventsFor(
          [{ spec: spec("a"), raw: "pass" }],
          [{ kind: "error", runId: RUN_ID, cause: "instance unreachable" }],
        ),
      );
      // Distinguishability is asserted, not merely documented. If the only
      // thing separating a harness row from a spec row were the prose above
      // this test, we would have replaced one unenforced invariant with
      // another — and a stated invariant is not an enforced one.
      assert.match(
        xml,
        /<testcase name="run-level-error" classname="tessera\.harness">/,
      );
      assert.match(xml, /type="run-level-error"/);
      // A spec row must NOT carry the marker: the filter has to be exact.
      assert.equal(testcaseFor(xml, "a").includes("tessera.harness"), false);
    });

    it("joins several run-level causes into one row rather than truncating", async () => {
      const xml = await render([
        { kind: "error", runId: RUN_ID, cause: "first fault" },
        { kind: "error", runId: RUN_ID, cause: "second fault" },
        ...eventsFor([]),
      ]);
      const row = xml.slice(xml.indexOf('name="run-level-error"'));
      assert.ok(row.includes("first fault"));
      assert.ok(row.includes("second fault"));
      assert.equal(xml.split('classname="tessera.harness"').length - 1, 1);
    });

    it("a missing `end` event is called out (ARCH-24) and counted", async () => {
      const xml = await render([
        { kind: "start", runId: RUN_ID, spec: spec("a") },
      ]);
      assert.match(xml, /no terminal `end` event arrived/);
      assert.match(
        xml,
        /<testcase name="run-incomplete" classname="tessera\.harness">/,
      );
      assert.match(xml, /type="no-terminal-end"/);
    });

    it("dropped events are reported rather than hidden, but add no row", async () => {
      const xml = await render([
        { kind: "who-knows", runId: RUN_ID },
        ...eventsFor([{ spec: spec("a"), raw: "pass" }]),
      ]);
      assert.match(
        xml,
        /1 event\(s\) did not match a declared TestEvent shape/,
      );
      // Rows change the denominator; events do not. A dropped event was never
      // going to be one of the `tests`, so inventing a row for it would make
      // the count wrong in the opposite direction.
      assert.ok(xml.includes('tests="1"'), xml);
      assert.equal(xml.includes("tessera.harness"), false);
    });

    it("unreadable result rows add a row, because they left a hole in tests=", async () => {
      const xml = await render([
        {
          kind: "end",
          runId: RUN_ID,
          result: {
            runId: RUN_ID,
            outcomes: [{ spec: spec("a"), raw: "pass" }, null, 42],
          },
        },
      ]);
      assert.match(xml, /2 result row\(s\) in the terminal/);
      assert.match(
        xml,
        /<testcase name="unreadable-outcome-rows" classname="tessera\.harness">/,
      );
      assert.match(xml, /type="dropped-outcome-row"/);
      // 1 real outcome + 1 harness row. Without the harness row this document
      // would say `tests="1"` for a run that reported three results.
      assert.ok(xml.includes('tests="2" failures="0" errors="1"'), xml);
    });

    it("a spec that started and never appeared is counted, under ended: true", async () => {
      const xml = await render([
        { kind: "start", runId: RUN_ID, spec: spec("a") },
        { kind: "start", runId: RUN_ID, spec: spec("vanished") },
        ...eventsFor([{ spec: spec("a"), raw: "pass" }]),
      ]);
      // Nothing else in this document is wrong: it ended, nothing was dropped,
      // the one row passed. The unit that disappeared is visible only here.
      assert.equal(xml.includes("no terminal `end` event arrived"), false);
      assert.match(
        xml,
        /1 spec\(s\) emitted a start event and appear in no outcome row/,
      );
      assert.match(
        xml,
        /<testcase name="specs-started-without-outcome" classname="tessera\.harness">/,
      );
      assert.ok(xml.includes('tests="2" failures="0" errors="1"'), xml);
    });

    it("an end whose outcomes is not an array is a harness error, never a clean empty run", async () => {
      // Repro 06: this used to render `tests="0" errors="0"` — green.
      const xml = await render([
        { kind: "start", runId: RUN_ID, spec: spec("a") },
        {
          kind: "fail",
          runId: RUN_ID,
          spec: spec("a"),
          assertion: "expected 1, got 2",
        },
        {
          kind: "end",
          runId: RUN_ID,
          result: { runId: RUN_ID, outcomes: { not: "an array" } },
        },
      ]);
      assert.equal(xml.includes('errors="0"'), false, xml);
      assert.match(xml, /no terminal `end` event arrived/);
      assertWellFormedXml(xml);
    });

    it("a spec that failed and appears in no outcome row is a harness error", async () => {
      // Repro 06b: a fail event followed by a well-formed but empty end.
      const xml = await render([
        { kind: "start", runId: RUN_ID, spec: spec("a") },
        {
          kind: "fail",
          runId: RUN_ID,
          spec: spec("a"),
          assertion: "expected 1, got 2",
        },
        ...eventsFor([]),
      ]);
      assert.match(
        xml,
        /<testcase name="specs-faulted-without-outcome" classname="tessera\.harness">/,
      );
      assert.match(
        xml,
        /1 spec\(s\) emitted a fail\/error event and appear in no outcome row/,
      );
      assert.equal(xml.includes('errors="0"'), false, xml);
      assertWellFormedXml(xml);
    });

    it("a fail/error event contradicted by a pass row is a harness error, never green (2026-09-26)", async () => {
      const xml = await render(
        eventsFor(
          [
            { spec: spec("x"), raw: "pass" },
            { spec: spec("y"), raw: "pass" },
          ],
          [
            {
              kind: "fail",
              runId: RUN_ID,
              spec: spec("x"),
              assertion: "expected 1 got 2",
            },
            { kind: "error", runId: RUN_ID, spec: spec("y"), cause: "boom" },
          ],
        ),
      );
      assert.match(
        xml,
        /<testcase name="specs-faulted-contradicted-by-outcome" classname="tessera\.harness">/,
      );
      assert.match(
        xml,
        /2 spec\(s\) emitted a fail\/error event but their outcome row reads pass/,
      );
      assert.ok(xml.includes('tests="3" failures="0" errors="1"'), xml);
      assertWellFormedXml(xml);
    });

    it("a coerced outcome is noted but adds no row — its row is already counted", async () => {
      const xml = await render(
        eventsFor([{ spec: spec("x"), raw: "totally-fine-trust-me" }]),
      );
      assert.match(xml, /1 outcome row\(s\) carried a raw value outside/);
      // The row IS in the report and IS counted; what is wrong is the bucket it
      // landed in, and a synthetic row would not fix that.
      assert.ok(xml.includes('tests="1" failures="0" errors="1"'), xml);
      assert.equal(xml.includes("tessera.harness"), false);
    });

    it("is omitted entirely when there is nothing to say", async () => {
      const xml = await render(eventsFor([{ spec: spec("a"), raw: "pass" }]));
      assert.equal(xml.includes("<system-err>"), false);
      assert.equal(xml.includes("tessera.harness"), false);
    });
  });

  describe("escaping (untrusted, instance-authored text)", () => {
    const HOSTILE =
      "CDATA close ]]> & < > \" '" +
      " \u0000 NUL \u001b ESC \ud800 lone-high \udfff lone-low " +
      "\ufffe noncharacter \u{1f600} astral";

    it("a hostile assertion round-trips into a document that still parses", async () => {
      const xml = await render(
        eventsFor(
          [{ spec: spec("b"), raw: "fail" }],
          [
            {
              kind: "fail",
              runId: RUN_ID,
              spec: spec("b"),
              assertion: HOSTILE,
            },
          ],
        ),
      );
      assertWellFormedXml(xml);
      assert.equal(xml.includes("<![CDATA["), false, "no CDATA is used at all");
      assert.ok(xml.includes("]]&gt;"), "]]> survives as inert escaped text");
      assert.ok(xml.includes("\u{1f600}"), "a valid astral pair is preserved");
    });

    it("a hostile spec id and path cannot break out of an attribute", async () => {
      const evil = { id: 'a" onload="x', path: "tests/<script>.ts" };
      const xml = await render(eventsFor([{ spec: evil, raw: "pass" }]));
      assertWellFormedXml(xml);
      assert.equal(xml.includes('onload="x'), false);
      assert.ok(xml.includes("&quot;"));
      assert.ok(xml.includes("&lt;script&gt;"));
    });

    describe("escapeXml", () => {
      it("escapes all five predefined entities", () => {
        assert.equal(escapeXml("&<>\"'"), "&amp;&lt;&gt;&quot;&apos;");
      });

      it("escapes & first, so an entity is never double-escaped into nonsense", () => {
        assert.equal(escapeXml("&lt;"), "&amp;lt;");
      });

      it("drops the C0 controls XML 1.0 forbids even numerically", () => {
        assert.equal(escapeXml("a\u0000\u0008\u001fbcd"), "abcd");
      });

      it("keeps tab, LF and CR — they are legal XML characters", () => {
        assert.equal(escapeXml("a\tb\nc\rd"), "a\tb\nc\rd");
      });

      it("drops unpaired surrogates but keeps valid pairs", () => {
        assert.equal(escapeXml("a\ud800b"), "ab");
        assert.equal(escapeXml("a\udc00b"), "ab");
        assert.equal(escapeXml("a\u{1f600}b"), "a\u{1f600}b");
      });

      it("renders bidi and zero-width characters as a visible escape (2026-09-25)", () => {
        assert.equal(escapeXml("a\u202Eb"), "a&lt;U+202E&gt;b");
        assert.equal(escapeXml("a\u200Bb"), "a&lt;U+200B&gt;b");
        assert.equal(escapeXml("a\uFEFFb"), "a&lt;U+FEFF&gt;b");
        assert.equal(
          escapeXml("\u2066x\u2069"),
          "&lt;U+2066&gt;x&lt;U+2069&gt;",
        );
      });

      it("escapes astral tag characters by code point and stays well-formed (2026-09-26)", async () => {
        assert.equal(escapeXml("a\u{E0061}b"), "a&lt;U+E0061&gt;b");
        assert.equal(
          escapeXml("a\u00ADb\uFE0Fc"),
          "a&lt;U+00AD&gt;b&lt;U+FE0F&gt;c",
        );
        // A lone surrogate is still dropped, not tokenised.
        assert.equal(escapeXml("a\uDB40b"), "ab");
        const xml = await render(
          eventsFor(
            [{ spec: spec("b"), raw: "fail" }],
            [
              {
                kind: "fail",
                runId: RUN_ID,
                spec: spec("b"),
                assertion: "tag\u{E0061}\u{E007F} vs\u{E0100} \uDB40 \u3164",
              },
            ],
          ),
        );
        assertWellFormedXml(xml);
        assert.ok(xml.includes("&lt;U+E0061&gt;&lt;U+E007F&gt;"), xml);
        assert.ok(xml.includes("&lt;U+E0100&gt;"), xml);
        assert.ok(xml.includes("&lt;U+3164&gt;"), xml);
      });

      it("drops the two BMP noncharacters", () => {
        assert.equal(escapeXml("a\ufffeb\uffffc"), "abc");
      });
    });
  });

  it("renderJUnit is pure — the same snapshot renders the same bytes", () => {
    const snapshot = {
      runId: RUN_ID,
      ended: true,
      outcomes: [{ spec: spec("a"), raw: "pass" }],
      failures: [],
      errors: [],
      logs: [],
      started: [],
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
    assert.equal(renderJUnit(snapshot), renderJUnit(snapshot));
  });
});
