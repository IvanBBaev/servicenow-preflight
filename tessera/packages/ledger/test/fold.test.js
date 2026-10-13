// Folding a decoded log into current entries: every line that cannot be a
// fact of THIS run (or host) — or that breaks the §4b entry machine — makes
// the whole log `corrupt` instead of being skipped or applied out of order.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LedgerError } from "../build/index.js";
import { foldInfraLog, foldRunLog } from "../build/records.js";

const FILE = "ledger.jsonl";

function write(seq, patch = {}) {
  return {
    kind: "write",
    seq,
    runId: "run-1",
    instance: "dev",
    intent: `create-${seq}`,
    target: { table: "sys_user" },
    compensation: { op: "delete", table: "sys_user" },
    state: "intended",
    idempotencyKey: `k${seq}`,
    probe: undefined,
    ...patch,
  };
}

function infra(seq, patch = {}) {
  return {
    kind: "infra-write",
    seq,
    planHash: "h1",
    host: "dev.service-now.com",
    intent: `install-${seq}`,
    target: { table: "sys_properties" },
    compensation: { op: "delete", table: "sys_properties" },
    state: "intended",
    idempotencyKey: `k${seq}`,
    probe: undefined,
    intendedAt: "2026-10-13T00:00:00.000Z",
    ...patch,
  };
}

function flip(seq, state, sysId) {
  return { kind: "state", seq, state, sysId };
}

/** Assert `fn` throws a `corrupt` LedgerError naming the file and `pattern`. */
function assertCorrupt(fn, pattern) {
  assert.throws(
    fn,
    (error) =>
      error instanceof LedgerError &&
      error.code === "corrupt" &&
      error.message.startsWith(`${FILE}: `) &&
      pattern.test(error.message),
  );
}

describe("foldRunLog", () => {
  it("folds flips onto their entries, fills the sysId, and sorts by seq", () => {
    const folded = foldRunLog(FILE, "run-1", [
      write(2),
      write(1, {
        compensation: { op: "restore", table: "t", sysId: "r1", fields: {} },
      }),
      flip(2, "applied", "abc"),
      flip(1, "applied", "zzz"),
      flip(2, "compensated"),
    ]);
    assert.deepEqual(
      folded.map((entry) => entry.seq),
      [1, 2],
    );
    assert.equal(folded[1].state, "compensated");
    assert.deepEqual(folded[1].target, { table: "sys_user", sysId: "abc" });
    assert.deepEqual(folded[1].compensation, {
      op: "delete",
      table: "sys_user",
      sysId: "abc",
    });
    // A restore already names its record; a flip's sysId does not rewrite it.
    assert.equal(folded[0].compensation.sysId, "r1");
    assert.equal(folded[0].target.sysId, "zzz");
  });

  it("returns no entries for an empty log", () => {
    assert.deepEqual(foldRunLog(FILE, "run-1", []), []);
  });

  it("refuses an entry that belongs to another run", () => {
    assertCorrupt(
      () => foldRunLog(FILE, "run-1", [write(1, { runId: "run-2" })]),
      /entry #1 belongs to run run-2, not run-1/,
    );
  });

  it("refuses a duplicate seq", () => {
    assertCorrupt(
      () => foldRunLog(FILE, "run-1", [write(1), write(1)]),
      /duplicate ledger entry #1/,
    );
  });

  it("refuses an entry appended in a state other than intended", () => {
    assertCorrupt(
      () => foldRunLog(FILE, "run-1", [write(1, { state: "applied" })]),
      /entry #1 was appended in state applied/,
    );
  });

  it("refuses a flip for an entry that was never opened", () => {
    assertCorrupt(
      () => foldRunLog(FILE, "run-1", [write(1), flip(2, "applied")]),
      /state line for unknown ledger entry #2/,
    );
  });

  it("refuses a flip the entry machine does not allow", () => {
    assertCorrupt(
      () =>
        foldRunLog(FILE, "run-1", [
          write(1),
          flip(1, "compensated"),
          flip(1, "applied"),
        ]),
      /entry #1 cannot go compensated → applied/,
    );
  });
});

describe("foldInfraLog", () => {
  const HOST = "dev.service-now.com";

  it("folds flips onto their entries and matches the host case-insensitively", () => {
    const folded = foldInfraLog(FILE, "DEV.Service-Now.com", [
      infra(1),
      flip(1, "applied", "p1"),
    ]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].state, "applied");
    assert.equal(folded[0].target.sysId, "p1");
    assert.equal(folded[0].compensation.sysId, "p1");
    assert.equal(folded[0].planHash, "h1");
  });

  it("refuses an entry that belongs to another host", () => {
    assertCorrupt(
      () =>
        foldInfraLog(FILE, HOST, [infra(1, { host: "prod.service-now.com" })]),
      /entry #1 belongs to host prod\.service-now\.com, not dev\.service-now\.com/,
    );
  });

  it("refuses a duplicate seq", () => {
    assertCorrupt(
      () =>
        foldInfraLog(FILE, HOST, [
          infra(1),
          infra(1, { idempotencyKey: "k9" }),
        ]),
      /duplicate infra entry #1/,
    );
  });

  it("refuses one idempotency key opening two entries", () => {
    assertCorrupt(
      () =>
        foldInfraLog(FILE, HOST, [
          infra(1),
          infra(2, { idempotencyKey: "k1" }),
        ]),
      /idempotency key "k1" opens two entries/,
    );
  });

  it("refuses an entry appended in a state other than intended", () => {
    assertCorrupt(
      () => foldInfraLog(FILE, HOST, [infra(1, { state: "compensated" })]),
      /entry #1 was appended in state compensated/,
    );
  });

  it("refuses a flip for an entry that was never opened", () => {
    assertCorrupt(
      () => foldInfraLog(FILE, HOST, [flip(1, "applied")]),
      /state line for unknown infra entry #1/,
    );
  });

  it("refuses a flip the entry machine does not allow", () => {
    assertCorrupt(
      () =>
        foldInfraLog(FILE, HOST, [
          infra(1),
          flip(1, "compensated"),
          flip(1, "compensated"),
        ]),
      /entry #1 cannot go compensated → compensated/,
    );
  });
});
