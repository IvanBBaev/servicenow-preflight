// TM-1 at the output surface, and the fault isolation core relies on.
//
// TM-1 says the instance is not trusted. By the time a `TestEvent` reaches this
// package almost every string on it was authored on the other side of the
// wire — the ATF assertion text, the DEV-1 failure cause, an artifact ref, the
// spec id and path. A reporter is the last hop before that text becomes a
// terminal line, an XML document a CI server parses, or a JSON file something
// else consumes, so it is the last place the claim can be checked at all.
//
// The method is a canary. Every untrusted field carries the same marker plus a
// padding run of ONE character unique to that field, so a per-line count of
// that character attributes to exactly one field even when several fields are
// rendered into the same line. Each surface must then either OMIT the field or
// render it harmlessly. The assertion that matters is not "the report is tidy",
// it is "this exact sequence of characters never left as a live escape
// sequence, an unescaped tag, or an uncapped flood".
//
// The second half is `runPipeline`'s side of the contract. Core calls `onEvent`
// inside a bare try/catch — "a reporter fault is never allowed to change the
// verdict" — and collects `close()` faults without letting one stop the next.
// That only helps if the reporters really are independent, which is what the
// isolation block asserts: a reporter that throws must not change one byte of
// what the others produce.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RENDERED_TEXT_LENGTH,
  createConsoleReporter,
  createJUnitReporter,
  createJsonReporter,
} from "../build/index.js";

import { RUN_ID, assertWellFormedXml } from "./support.js";

const CANARY = "canary-6c24-never-print-this";

/** A property no `TestEvent` declares. Nothing may carry it to a surface. */
const SMUGGLED = "smuggled-6c24-never-print-this";

/** C0 and C1 controls plus DEL — includes ESC, i.e. every ANSI sequence. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/** What XML 1.0 forbids outright, even numerically escaped. */
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/**
 * What JSON must carry as a `\uXXXX` escape rather
 * than as a raw byte. LF is excluded: the pretty-printer's own newlines are
 * the one control character the document is allowed to contain.
 */
// eslint-disable-next-line no-control-regex
const JSON_RAW_CONTROL = /[\u0000-\u0009\u000B-\u001F]/;

/**
 * One untrusted field: the canary, an ANSI colour sequence, a BEL, an XML
 * attribute breakout, a CDATA terminator, a NUL — and then a flood of `pad`
 * twice as long as the console's cap.
 */
function hostile(label, pad) {
  return (
    `\u001b[31m${CANARY}:${label}\u0007 <breakout attr="x"> ]]> & ' \u0000 ` +
    pad.repeat(2 * MAX_RENDERED_TEXT_LENGTH)
  );
}

const ASSERTION = hostile("assertion", "z");
const CAUSE = hostile("cause", "y");
const ARTIFACT_REF = hostile("artifact", "w");
const SPEC_ID = hostile("spec-id", "q");
const SPEC_PATH = hostile("spec-path", "p");
const LOG_MESSAGE = hostile("log", "m");

/** Every pad character, so one sweep covers all six fields. */
const PADS = ["z", "y", "w", "q", "p", "m"];

const EVIL_SPEC = { id: SPEC_ID, path: SPEC_PATH, note: SMUGGLED };

/** A whole run in which every instance-authored string is hostile. */
function hostileStream() {
  return [
    { kind: "start", runId: RUN_ID, spec: EVIL_SPEC },
    {
      kind: "fail",
      runId: RUN_ID,
      spec: EVIL_SPEC,
      assertion: ASSERTION,
      artifacts: [{ kind: "atf-result", ref: ARTIFACT_REF, note: SMUGGLED }],
      note: SMUGGLED,
    },
    // No spec: a run-level DEV-1 fault, which is the route a `cause` takes to
    // JUnit's <system-err> rather than into a testcase.
    {
      kind: "error",
      runId: RUN_ID,
      cause: CAUSE,
      artifacts: [{ kind: "log", ref: ARTIFACT_REF }],
      note: SMUGGLED,
    },
    { kind: "log", runId: RUN_ID, message: LOG_MESSAGE },
    {
      kind: "end",
      runId: RUN_ID,
      result: {
        runId: RUN_ID,
        outcomes: [
          {
            spec: EVIL_SPEC,
            raw: "fail",
            evidence: { kind: "atf-result", ref: ARTIFACT_REF },
            note: SMUGGLED,
          },
        ],
        note: SMUGGLED,
      },
    },
  ];
}

/** Occurrences of a single character. */
const countOf = (text, character) => text.split(character).length - 1;

/** The three adapters, each in its loudest configuration. */
function makeAdapters() {
  const outputs = { console: [], junit: [], json: [] };
  const reporters = [
    createConsoleReporter({
      write: (line) => outputs.console.push(line),
      live: true,
      verbose: true,
    }),
    createJUnitReporter({ write: (xml) => outputs.junit.push(xml) }),
    createJsonReporter({ write: (json) => outputs.json.push(json) }),
  ];
  return { outputs, reporters };
}

/** `runPipeline.emit()` — a reporter fault never changes the verdict. */
function emit(reporters, event) {
  for (const reporter of reporters) {
    try {
      reporter.onEvent(event);
    } catch {
      // Exactly what core does with it.
    }
  }
}

/** `runPipeline.closeReporters()` — every reporter closes, faults collected. */
async function closeReporters(reporters, runId) {
  const faults = [];
  for (const reporter of reporters) {
    try {
      await reporter.close(runId);
    } catch (error) {
      faults.push(error instanceof Error ? error.message : String(error));
    }
  }
  return faults;
}

/** Drive the three adapters over the hostile stream the way core would. */
async function renderAll(extra = {}) {
  const { outputs, reporters } = makeAdapters();
  const chain = [...(extra.before ?? []), ...reporters, ...(extra.after ?? [])];
  for (const event of hostileStream()) emit(chain, event);
  const faults = await closeReporters(chain, RUN_ID);
  return { outputs, faults };
}

describe("TM-1: instance-authored text at the output surface", () => {
  describe("console", () => {
    it("renders no control character — no line can repaint a terminal", async () => {
      const { outputs } = await renderAll();
      for (const line of outputs.console) {
        assert.equal(
          CONTROL_CHARS.test(line),
          false,
          `a control character survived into: ${JSON.stringify(line.slice(0, 120))}`,
        );
        assert.equal(line.includes("\u001b"), false, "a live ANSI escape");
      }
    });

    it("caps every untrusted field independently, at MAX_RENDERED_TEXT_LENGTH", async () => {
      const { outputs } = await renderAll();
      for (const line of outputs.console) {
        for (const pad of PADS) {
          assert.ok(
            countOf(line, pad) <= MAX_RENDERED_TEXT_LENGTH,
            `a "${pad}" field put ${countOf(line, pad)} characters on one line`,
          );
        }
      }
    });

    it("says a line was cut rather than silently dropping the tail", async () => {
      const { outputs } = await renderAll();
      assert.ok(outputs.console.some((line) => line.endsWith("… (truncated)")));
    });

    it("carries no undeclared property of the event, the spec or the result", async () => {
      const { outputs } = await renderAll();
      assert.equal(outputs.console.join("\n").includes(SMUGGLED), false);
    });

    it("did render the hostile text — the assertions above are not vacuous", async () => {
      const { outputs } = await renderAll();
      const text = outputs.console.join("\n");
      // Without this, every assertion above would pass just as happily on a
      // reporter that printed nothing at all.
      assert.ok(
        text.includes(CANARY),
        "the untrusted text never reached the surface",
      );
      assert.equal(
        text.includes(ASSERTION),
        false,
        "the raw string was printed whole",
      );
      assert.match(text, /failed assertions:/);
      assert.match(text, /infrastructure errors \(DEV-1\):/);
    });
  });

  describe("JUnit", () => {
    it("stays a document a CI server can parse", async () => {
      const { outputs } = await renderAll();
      assert.equal(outputs.junit.length, 1);
      assertWellFormedXml(outputs.junit[0]);
    });

    it("lets nothing out of an attribute or into a tag position", async () => {
      const { outputs } = await renderAll();
      const xml = outputs.junit[0];
      assert.equal(xml.includes("<breakout"), false, "an injected element");
      assert.equal(xml.includes('attr="x"'), false, "an injected attribute");
      assert.ok(
        xml.includes("&lt;breakout"),
        "it survives as inert escaped text",
      );
    });

    it("never reaches for CDATA, so `]]>` is text like any other", async () => {
      const { outputs } = await renderAll();
      assert.equal(outputs.junit[0].includes("<![CDATA["), false);
      assert.ok(outputs.junit[0].includes("]]&gt;"));
    });

    it("drops the characters XML 1.0 forbids even numerically", async () => {
      const { outputs } = await renderAll();
      assert.equal(XML_FORBIDDEN_CHARS.test(outputs.junit[0]), false);
    });

    it("omits artifact refs and log lines — the surest escaping there is", async () => {
      const { outputs } = await renderAll();
      const xml = outputs.junit[0];
      assert.equal(
        xml.includes("w".repeat(20)),
        false,
        "an artifact ref was rendered",
      );
      assert.equal(
        xml.includes("m".repeat(20)),
        false,
        "a log line was rendered",
      );
    });

    it("carries no undeclared property, and does carry the text it should", async () => {
      const { outputs } = await renderAll();
      const xml = outputs.junit[0];
      assert.equal(xml.includes(SMUGGLED), false);
      assert.ok(
        xml.includes(CANARY),
        "the untrusted text never reached the surface",
      );
      assert.ok(
        xml.includes("<system-err>"),
        "the run-level cause was recorded",
      );
    });
  });

  describe("JSON", () => {
    it("stays parseable, with no raw control character in the bytes", async () => {
      const { outputs } = await renderAll();
      assert.doesNotThrow(() => JSON.parse(outputs.json[0]));
      assert.equal(
        JSON_RAW_CONTROL.test(outputs.json[0]),
        false,
        "a control character is in the file rather than its \\u escape",
      );
    });

    it("keeps the values faithful and uncapped — this document is data, not a display", async () => {
      const { outputs } = await renderAll();
      const parsed = JSON.parse(outputs.json[0]);
      // The console truncates because a CI log has to stay readable; the JSON
      // report is the uncapped record the console points at, so equality here
      // is the requirement rather than a leak.
      assert.equal(parsed.failures[0].assertion, ASSERTION);
      assert.equal(parsed.failures[0].artifacts[0].ref, ARTIFACT_REF);
      assert.equal(parsed.errors[0].cause, CAUSE);
      assert.equal(parsed.outcomes[0].spec.id, SPEC_ID);
      assert.equal(parsed.outcomes[0].spec.path, SPEC_PATH);
      assert.equal(parsed.outcomes[0].evidence.ref, ARTIFACT_REF);
    });

    it("rebuilds every object from declared fields — nothing rides in on a spread", async () => {
      const { outputs } = await renderAll();
      assert.equal(outputs.json[0].includes(SMUGGLED), false);
      const parsed = JSON.parse(outputs.json[0]);
      assert.deepEqual(Object.keys(parsed.outcomes[0].spec), ["id", "path"]);
      assert.deepEqual(Object.keys(parsed.outcomes[0]), [
        "spec",
        "raw",
        "evidence",
      ]);
      assert.deepEqual(Object.keys(parsed.failures[0]), [
        "spec",
        "assertion",
        "artifacts",
      ]);
      assert.deepEqual(Object.keys(parsed.failures[0].artifacts[0]), [
        "kind",
        "ref",
      ]);
    });
  });

  describe("reporters are fault-isolated (runPipeline's contract)", () => {
    const throwingReporter = () => ({
      onEvent() {
        throw new Error("reporter fault");
      },
      close: () => Promise.resolve(),
    });

    it("a reporter that throws in onEvent changes no other reporter's output", async () => {
      const baseline = await renderAll();
      const withFaults = await renderAll({
        before: [throwingReporter()],
        after: [throwingReporter()],
      });
      assert.deepEqual(
        withFaults.outputs,
        baseline.outputs,
        "a neighbouring fault altered the evidence",
      );
      assert.deepEqual(withFaults.faults, []);
    });

    it("a throwing reporter does not stop the stream reaching the ones after it", () => {
      const { outputs, reporters } = makeAdapters();
      const chain = [throwingReporter(), ...reporters];
      assert.doesNotThrow(() => {
        for (const event of hostileStream()) emit(chain, event);
      });
      assert.ok(outputs.console.length > 0, "the live stream kept running");
    });

    it("a rejecting close() is collected as a fault, and later reporters still close", async () => {
      const { outputs, reporters } = makeAdapters();
      const rejecting = {
        onEvent() {},
        close: () => Promise.reject(new Error("ENOSPC")),
      };
      const chain = [rejecting, ...reporters];
      for (const event of hostileStream()) emit(chain, event);
      const faults = await closeReporters(chain, RUN_ID);
      assert.deepEqual(faults, ["ENOSPC"]);
      assert.equal(outputs.junit.length, 1, "the JUnit file was still written");
      assert.equal(
        outputs.json.length,
        1,
        "the JSON document was still written",
      );
    });

    it("the three real adapters produce no fault at all over a hostile run", async () => {
      const { faults } = await renderAll();
      assert.deepEqual(faults, []);
    });
  });
});
