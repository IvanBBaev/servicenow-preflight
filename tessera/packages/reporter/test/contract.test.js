// The `Reporter` port contract, asserted against all three adapters at once.
//
// These are not tests about formatting. They are tests about the two promises
// `@tessera/core`'s `runPipeline` already relies on and cannot check for
// itself:
//
//   1. `onEvent` is SYNCHRONOUS and NEVER THROWS. Core calls it inside
//      `try { reporter.onEvent(event) } catch {}` — "a reporter fault is never
//      allowed to change the verdict" — so a throw is not a failure a caller
//      sees, it is evidence disappearing. The malformed inputs below are the
//      point: an unknown event kind must be counted and skipped, not crash the
//      stream that follows it.
//   2. `close()` is IDEMPOTENT and safe with no `end` event. Core closes
//      reporters on the normal path and again in a `finally`, and an aborted
//      run still owes the ARCH-24 boundary a report.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createConsoleReporter,
  createJUnitReporter,
  createJsonReporter,
} from "../build/index.js";

import { RUN_ID, malformedEvents, spec } from "./support.js";

/** One factory per adapter, each returning `{ reporter, writes }`. */
const adapters = {
  console: () => {
    const writes = [];
    return {
      reporter: createConsoleReporter({
        write: (line) => writes.push(line),
        live: true,
        verbose: true,
      }),
      writes,
    };
  },
  junit: () => {
    const writes = [];
    return {
      reporter: createJUnitReporter({ write: (xml) => writes.push(xml) }),
      writes,
    };
  },
  json: () => {
    const writes = [];
    return {
      reporter: createJsonReporter({ write: (json) => writes.push(json) }),
      writes,
    };
  },
};

describe("Reporter contract", () => {
  for (const [name, make] of Object.entries(adapters)) {
    describe(name, () => {
      it("onEvent returns synchronously — no promise, no thenable", () => {
        const { reporter } = make();
        const returned = reporter.onEvent({
          kind: "pass",
          runId: RUN_ID,
          spec: spec("a"),
        });
        assert.equal(returned, undefined);
      });

      it("onEvent applies its effect before the next statement", () => {
        const { reporter, writes } = make();
        reporter.onEvent({ kind: "pass", runId: RUN_ID, spec: spec("a") });
        // Only the streaming adapter writes here; the others must at minimum
        // not have deferred anything to a microtask.
        assert.equal(writes.length, name === "console" ? 1 : 0);
      });

      it("onEvent never throws, whatever it is handed", () => {
        const { reporter } = make();
        for (const event of malformedEvents()) {
          assert.doesNotThrow(
            () => reporter.onEvent(event),
            `event: ${String(event)}`,
          );
        }
        // …and the stream still works afterwards.
        assert.doesNotThrow(() =>
          reporter.onEvent({ kind: "pass", runId: RUN_ID, spec: spec("a") }),
        );
      });

      it("close() is idempotent", async () => {
        const { reporter, writes } = make();
        reporter.onEvent({
          kind: "end",
          runId: RUN_ID,
          result: {
            runId: RUN_ID,
            outcomes: [{ spec: spec("a"), raw: "pass" }],
          },
        });
        const before = writes.length;
        await reporter.close(RUN_ID);
        const afterFirst = writes.length;
        await reporter.close(RUN_ID);
        await reporter.close(RUN_ID);
        assert.ok(afterFirst > before, "the first close produced output");
        assert.equal(writes.length, afterFirst, "later closes produced none");
      });

      it("close() still reports when no `end` event ever arrived", async () => {
        const { reporter, writes } = make();
        reporter.onEvent({ kind: "start", runId: RUN_ID, spec: spec("a") });
        const before = writes.length;
        await reporter.close(RUN_ID);
        assert.ok(
          writes.length > before,
          "an aborted run still produced a report",
        );
        assert.ok(
          writes.slice(before).join("\n").includes(RUN_ID),
          "the report names the run it is about (ARCH-16)",
        );
      });

      it("close() reports for a run that produced no events at all", async () => {
        const { reporter, writes } = make();
        await reporter.close(RUN_ID);
        assert.ok(writes.length > 0);
      });
    });
  }

  it("the console reporter survives a write that throws", () => {
    const reporter = createConsoleReporter({
      write: () => {
        throw new Error("EPIPE");
      },
      live: true,
    });
    assert.doesNotThrow(() =>
      reporter.onEvent({ kind: "pass", runId: RUN_ID, spec: spec("a") }),
    );
    assert.doesNotThrow(() => reporter.close(RUN_ID));
  });

  it("a file reporter's write fault REJECTS — core turns it into a stage failure", async () => {
    const reporter = createJsonReporter({
      write: () => Promise.reject(new Error("ENOSPC")),
    });
    await assert.rejects(() => reporter.close(RUN_ID), /ENOSPC/);
  });
});
