// Concurrent runs must not clobber each other (ARCH-16), and a retried call
// must not double-intend (§4b concurrency).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  RUN,
  acknowledgeProd,
  createIntent,
  ledgerLogPath,
  newLedger,
  openProvisioning,
  reopen,
} from "./helpers.js";

describe("concurrent runs in one ledger root", () => {
  it("keeps each run's entries in its own log, numbered from 1", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-a");
    await openProvisioning(ledger, "run-b");

    await Promise.all([
      ledger.intend(createIntent("run-a", "a1")),
      ledger.intend(createIntent("run-b", "b1")),
      ledger.intend(createIntent("run-a", "a2")),
      ledger.intend(createIntent("run-b", "b2")),
    ]);

    const a = await ledger.entries("run-a");
    const b = await ledger.entries("run-b");

    assert.deepEqual(
      a.map((entry) => [entry.seq, entry.idempotencyKey]),
      [
        [1, "a1"],
        [2, "a2"],
      ],
    );
    assert.deepEqual(
      b.map((entry) => [entry.seq, entry.idempotencyKey]),
      [
        [1, "b1"],
        [2, "b2"],
      ],
    );
    // Physically separate logs — one run's teardown cannot touch the other's.
    assert.ok(existsSync(ledgerLogPath(rootDir, "run-a")));
    assert.ok(existsSync(ledgerLogPath(rootDir, "run-b")));
    assert.ok(
      !readFileSync(ledgerLogPath(rootDir, "run-a"), "utf8").includes("run-b"),
    );
  });

  it("keeps run state records independent", async (t) => {
    const { ledger } = newLedger(t);
    await openProvisioning(ledger, "run-a");
    await openProvisioning(ledger, "run-b", { lifecycle: "persistent" });
    await ledger.transition("run-a", "projecting");

    const runs = await ledger.listRuns();

    assert.deepEqual(
      runs.map((run) => [run.runId, run.state, run.lifecycle]),
      [
        ["run-a", "projecting", "ephemeral"],
        ["run-b", "provisioning", "persistent"],
      ],
    );
  });

  it("gives concurrent intends on the SAME run unique, gap-free seqs", async (t) => {
    const { ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");

    const keys = ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"];
    const entries = await Promise.all(
      keys.map((key) => ledger.intend(createIntent("run-1", key))),
    );

    assert.deepEqual(
      entries.map((entry) => entry.seq).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.deepEqual(
      (await ledger.entries("run-1")).map((entry) => entry.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  });

  it("makes a concurrent retry resolve to one entry, not two", async (t) => {
    const { ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");

    const [first, retry] = await Promise.all([
      ledger.intend(createIntent("run-1", "same")),
      ledger.intend(createIntent("run-1", "same")),
    ]);

    assert.deepEqual(retry, first);
    assert.equal((await ledger.entries("run-1")).length, 1);
  });

  it("makes a concurrent openRun resolve to one run record", async (t) => {
    const { ledger } = newLedger(t);

    const opened = await Promise.all([
      ledger.openRun({ runId: "run-1", ...RUN }),
      ledger.openRun({ runId: "run-1", ...RUN }),
      ledger.openRun({ runId: "run-1", ...RUN }),
    ]);

    assert.deepEqual(opened[1], opened[0]);
    assert.deepEqual(opened[2], opened[0]);
    assert.equal((await ledger.listRuns()).length, 1);
  });

  it("serializes concurrent confirms without losing a flip", async (t) => {
    const { ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    for (const key of ["a", "b", "c"]) {
      await ledger.intend(createIntent("run-1", key));
    }

    await Promise.all([
      ledger.confirm("run-1", 1, { sysId: "sys-1" }),
      ledger.confirm("run-1", 2, { sysId: "sys-2" }),
      ledger.confirm("run-1", 3, { sysId: "sys-3" }),
    ]);

    assert.deepEqual(
      (await ledger.entries("run-1")).map((entry) => [
        entry.state,
        entry.target.sysId,
      ]),
      [
        ["applied", "sys-1"],
        ["applied", "sys-2"],
        ["applied", "sys-3"],
      ],
    );
  });
});

describe("two ledger instances over the same root", () => {
  it("append to the same run log without losing records", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await ledger.intend(createIntent("run-1", "first"));

    // A second process picks the run up where the first left it.
    const second = reopen(rootDir);
    await second.intend(createIntent("run-1", "second"));
    await second.confirm("run-1", 1, { sysId: "sys-1" });

    // And the original instance still reads the full, folded truth.
    assert.deepEqual(
      (await ledger.entries("run-1")).map((entry) => [
        entry.seq,
        entry.idempotencyKey,
        entry.state,
      ]),
      [
        [1, "first", "applied"],
        [2, "second", "intended"],
      ],
    );
  });

  it("see each other's audit records", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await ledger.appendAudit(
      acknowledgeProd("run-1", { reason: "release window" }),
    );

    const second = reopen(rootDir);
    await second.appendAudit({
      kind: "token-consumed",
      runId: "run-1",
      verdictHash: "sha256:abc",
    });

    assert.equal((await ledger.readAudit()).length, 2);
    assert.equal((await second.readAudit()).length, 2);
  });

  it("keep separate roots fully isolated", async (t) => {
    const one = newLedger(t);
    const two = newLedger(t);
    await openProvisioning(one.ledger, "run-1");
    await one.ledger.intend(createIntent("run-1", "a"));

    assert.deepEqual(await two.ledger.listRuns(), []);
    assert.equal(await two.ledger.readRun("run-1"), undefined);
  });
});
