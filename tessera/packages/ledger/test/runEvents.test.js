// Run-state persistence for `run_status` (DESIGN §6b / QA-29) — delegated
// decision 2026-09-23. The cursor is read back from disk, so it must stay
// monotonic and gap-free across a reopen, and a new process must be able to
// answer "what happened since cursor N" with nothing but the disk.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import {
  LedgerError,
  RUN_EVENTS_FILENAME,
  createRunEventLog,
} from "../build/index.js";
import { newLedger, RUN } from "./helpers.js";

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof LedgerError, `not a LedgerError: ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}`);
    return true;
  };
}

async function openRunWithLog(t, runId = "run-ev") {
  const { rootDir, ledger, clock } = newLedger(t);
  await ledger.openRun({ runId, ...RUN });
  const events = createRunEventLog({ rootDir, now: () => clock.now });
  return { rootDir, ledger, clock, events, runId };
}

describe("run event log — cursors", () => {
  it("stays monotonic and gap-free across a reopen", async (t) => {
    const { rootDir, events, runId } = await openRunWithLog(t);

    const a = await events.appendEvent(runId, { type: "planned" });
    const b = await events.appendEvent(runId, {
      type: "log",
      data: { message: "hello" },
    });
    assert.deepEqual([a.cursor, b.cursor], [1, 2]);
    assert.equal(a.at, "2026-07-01T00:00:00.000Z");

    // A new instance over the same root: another process.
    const reopened = createRunEventLog({ rootDir });
    const c = await reopened.appendEvent(runId, {
      type: "end",
      at: "2026-07-02T00:00:00.000Z",
    });
    assert.equal(c.cursor, 3);

    const page = await createRunEventLog({ rootDir }).readEvents(runId);
    assert.deepEqual(
      page.events.map((e) => [e.cursor, e.type]),
      [
        [1, "planned"],
        [2, "log"],
        [3, "end"],
      ],
    );
    assert.equal(page.cursor, 3);
    assert.deepEqual(page.events[1].data, { message: "hello" });
  });

  it("reads only what came after a cursor, and echoes the cursor when nothing did", async (t) => {
    const { events, runId } = await openRunWithLog(t);
    for (const type of ["a", "b", "c"]) {
      await events.appendEvent(runId, { type });
    }
    const since = await events.readEvents(runId, 1);
    assert.deepEqual(
      since.events.map((e) => e.cursor),
      [2, 3],
    );
    assert.equal(since.cursor, 3);
    const idle = await events.readEvents(runId, 3);
    assert.deepEqual(idle, { events: [], cursor: 3 });
    await assert.rejects(events.readEvents(runId, -1), expectCode("protocol"));
    await assert.rejects(events.readEvents(runId, 1.5), expectCode("protocol"));
  });

  it("reuses the cursor of a torn tail that never committed", async (t) => {
    const { rootDir, events, runId } = await openRunWithLog(t);
    await events.appendEvent(runId, { type: "a" });
    appendFileSync(
      join(rootDir, "runs", runId, RUN_EVENTS_FILENAME),
      '{"cursor":2,"runId":"run-ev","ty',
    );
    // The torn line is invisible to a reader…
    assert.equal((await events.readEvents(runId)).cursor, 1);
    // …and the next append repairs it and takes its number.
    const next = await createRunEventLog({ rootDir }).appendEvent(runId, {
      type: "b",
    });
    assert.equal(next.cursor, 2);
  });

  it("refuses an unknown run and non-serializable data", async (t) => {
    const { events, runId } = await openRunWithLog(t);
    await assert.rejects(
      events.appendEvent("run-nope", { type: "a" }),
      expectCode("run-not-found"),
    );
    await assert.rejects(
      events.appendEvent(runId, { type: "a", data: { n: 1n } }),
      expectCode("protocol"),
    );
  });
});

describe("run event log — persisted state and result", () => {
  it("exposes run state, last cursor and result to a new process", async (t) => {
    const { rootDir, ledger, events, runId } = await openRunWithLog(t);
    assert.equal(
      await createRunEventLog({ rootDir }).readStatus("run-nope"),
      undefined,
    );

    await events.appendEvent(runId, { type: "planned" });
    let status = await createRunEventLog({ rootDir }).readStatus(runId);
    assert.equal(status.run.state, "planned");
    assert.equal(status.lastCursor, 1);
    assert.equal("result" in status, false);
    assert.equal(await events.readResult(runId), undefined);

    await ledger.transition(runId, "provisioning");
    const written = await events.writeResult(runId, {
      status: "GO",
      rows: 3,
    });
    assert.deepEqual(written.result, { status: "GO", rows: 3 });

    const reopened = createRunEventLog({ rootDir });
    status = await reopened.readStatus(runId);
    assert.equal(status.run.state, "provisioning");
    assert.deepEqual(status.result, written);
    assert.deepEqual(await reopened.readResult(runId), written);
  });
});
