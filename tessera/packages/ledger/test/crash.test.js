// Crash windows W1/W2 (§4b) and on-disk damage tolerance.
//
// A crash is simulated the only honest way available in-process: stop calling
// the ledger at the point the process would have died, then build a NEW ledger
// instance over the same root — the restarted process sees nothing but the
// bytes on disk. Every assertion below is therefore about what SURVIVED.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { LedgerError } from "../build/index.js";
import {
  RUN,
  createIntent,
  ledgerLogPath,
  newLedger,
  openProvisioning,
  reopen,
  runStatePath,
  updateIntent,
} from "./helpers.js";

describe("crash window W1 — after intend, before the write", () => {
  it("leaves a durable intent the restarted process reports as an orphan", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "suite"));
    // <<< kill -9 here: the HTTP call was never issued.

    const restarted = reopen(rootDir);
    const plan = await restarted.recover("run-1");

    assert.equal(plan.orphans.length, 1);
    assert.equal(plan.orphans[0].state, "intended");
    assert.equal(plan.orphans[0].target.sysId, undefined);
    // The orphan carries the query recovery needs to decide (QA-25).
    assert.equal(plan.orphans[0].probe.query, "nameSTARTSWITHtess-run-1");
    assert.equal(plan.orphanDisposition, "compensate");
  });

  it("converges once the probe proves nothing landed (compensation is a no-op)", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "suite"));

    const restarted = reopen(rootDir);
    // Probe found nothing → the entry still has to reach a terminal state, or
    // the run can never converge.
    const settled = await restarted.compensate("run-1", 1);

    assert.equal(settled.state, "compensated");
    assert.deepEqual((await restarted.recover("run-1")).teardownOrder, []);
  });

  it("never loses the intent even if the process dies before any other call", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(updateIntent("run-1", "u1", "sys-user-1"));

    const restarted = reopen(rootDir);
    const [entry] = await restarted.entries("run-1");

    // The `restore` snapshot was captured BEFORE the write, so compensation
    // does not depend on any post-crash read.
    assert.deepEqual(entry.compensation, {
      op: "restore",
      table: "sys_user",
      sysId: "sys-user-1",
      fields: { active: "true" },
    });
  });
});

describe("crash window W2 — after the write, before confirm", () => {
  it("is indistinguishable from W1 on disk, which is why the probe exists", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "suite"));
    // <<< the instance DID create the record; kill -9 before confirm.

    const restarted = reopen(rootDir);
    const plan = await restarted.recover("run-1");

    assert.equal(plan.orphans.length, 1);
    assert.equal(plan.orphans[0].state, "intended");
    assert.equal(plan.orphans[0].target.sysId, undefined);
  });

  it("compensates an ephemeral find with the probed sys_id", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "suite"));

    const restarted = reopen(rootDir);
    const settled = await restarted.compensate("run-1", 1, {
      sysId: "sys-orphan",
    });

    assert.equal(settled.state, "compensated");
    assert.deepEqual(settled.compensation, {
      op: "delete",
      table: "sys_atf_test",
      sysId: "sys-orphan",
    });
  });

  it("adopts a persistent find instead of creating a duplicate (QA-25)", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1", { lifecycle: "persistent" });
    await ledger.intend(createIntent("run-1", "suite"));

    const restarted = reopen(rootDir);
    const plan = await restarted.recover("run-1");
    assert.equal(plan.orphanDisposition, "adopt");

    const adopted = await restarted.confirm("run-1", 1, {
      sysId: "sys-found",
    });

    assert.equal(adopted.state, "applied");
    assert.equal(adopted.target.sysId, "sys-found");
    // Adopted, not orphaned: the next upsert joins this record.
    assert.deepEqual((await restarted.recover("run-1")).orphans, []);
  });

  it("keeps the run diagnosable from the state record alone", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.transition("run-1", "projecting");
    await ledger.intend(createIntent("run-1", "suite"));

    const restarted = reopen(rootDir);
    const run = await restarted.readRun("run-1");

    assert.equal(run.state, "projecting");
    assert.equal(run.scope, RUN.scope);
    assert.equal(run.runner, RUN.runner);
  });

  it("lets the sweep infer abandonment and then tear the run down", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "suite"));

    const restarted = reopen(
      rootDir,
      () => new Date("2026-07-01T02:00:00.000Z"),
    );
    const [row] = await restarted.scan({ ttlMs: 30 * 60 * 1000 });
    assert.equal(row.stale, true);
    assert.equal(row.orphanCount, 1);

    await restarted.transition("run-1", "abandoned");
    await restarted.transition("run-1", "tearing-down");
    await restarted.compensate("run-1", 1);
    const done = await restarted.transition("run-1", "done");

    assert.equal(done.state, "done");
    assert.deepEqual(await restarted.scan(), []);
  });
});

describe("torn tail tolerance", () => {
  it("ignores an uncommitted trailing record and keeps every committed one", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "a"));
    await ledger.confirm("run-1", 1, { sysId: "sys-a" });

    // kill -9 mid-write(2): a partial record with no terminating newline.
    appendFileSync(ledgerLogPath(rootDir, "run-1"), '{"kind":"write","seq":2');

    const restarted = reopen(rootDir);
    const entries = await restarted.entries("run-1");

    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, "applied");
  });

  it("repairs the tail before the next append so corruption never moves mid-log", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "a"));
    appendFileSync(ledgerLogPath(rootDir, "run-1"), '{"kind":"write","seq":2');

    const restarted = reopen(rootDir);
    const next = await restarted.intend(createIntent("run-1", "b"));

    assert.equal(next.seq, 2);
    const lines = readFileSync(ledgerLogPath(rootDir, "run-1"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    assert.deepEqual(
      (await restarted.entries("run-1")).map((entry) => entry.seq),
      [1, 2],
    );
  });

  it("tolerates a newline-terminated tail of NULs (filesystem zero-fill)", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "a"));
    appendFileSync(
      ledgerLogPath(rootDir, "run-1"),
      Buffer.from([0, 0, 0, 0, 0, 0x0a]),
    );

    const restarted = reopen(rootDir);
    assert.equal((await restarted.entries("run-1")).length, 1);

    await restarted.confirm("run-1", 1, { sysId: "sys-a" });
    assert.equal((await restarted.entries("run-1"))[0].state, "applied");
    assert.ok(
      !readFileSync(ledgerLogPath(rootDir, "run-1"), "utf8").includes("\0"),
    );
  });

  it("tolerates a torn tail that is the only record in the log", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    writeFileSync(ledgerLogPath(rootDir, "run-1"), '{"kind":"wri');

    const restarted = reopen(rootDir);
    assert.deepEqual(await restarted.entries("run-1"), []);

    const entry = await restarted.intend(createIntent("run-1", "a"));
    assert.equal(entry.seq, 1);
  });
});

describe("real corruption is reported, not swallowed", () => {
  it("refuses a damaged record in the MIDDLE of the log", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "a"));
    await ledger.intend(createIntent("run-1", "b"));

    const file = ledgerLogPath(rootDir, "run-1");
    const lines = readFileSync(file, "utf8").split("\n");
    lines[0] = "{not json";
    writeFileSync(file, lines.join("\n"));

    const restarted = reopen(rootDir);
    await assert.rejects(restarted.entries("run-1"), (error) => {
      assert.ok(error instanceof LedgerError);
      assert.equal(error.code, "corrupt");
      return true;
    });
  });

  it("refuses a state line that references an unknown entry", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "a"));
    appendFileSync(
      ledgerLogPath(rootDir, "run-1"),
      `${JSON.stringify({ kind: "state", seq: 7, state: "applied" })}\n${JSON.stringify(
        { kind: "state", seq: 1, state: "applied" },
      )}\n`,
    );

    const restarted = reopen(rootDir);
    await assert.rejects(restarted.entries("run-1"), (error) => {
      assert.equal(error.code, "corrupt");
      return true;
    });
  });

  it("refuses a log holding an entry from another run", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "a"));
    const foreign = { ...createIntent("run-2", "x"), kind: "write", seq: 2 };
    appendFileSync(
      ledgerLogPath(rootDir, "run-1"),
      `${JSON.stringify({ ...foreign, state: "intended" })}\n{}\n`,
    );

    const restarted = reopen(rootDir);
    await assert.rejects(restarted.entries("run-1"), (error) => {
      assert.equal(error.code, "corrupt");
      return true;
    });
  });

  it("refuses an unreadable run state record", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    writeFileSync(runStatePath(rootDir, "run-1"), '{"runId":"run-1"}');

    const restarted = reopen(rootDir);
    await assert.rejects(restarted.readRun("run-1"), (error) => {
      assert.equal(error.code, "corrupt");
      return true;
    });
  });
});
