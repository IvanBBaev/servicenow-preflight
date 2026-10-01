// Writer/reader agreement (delegated decisions 2026-09-25). Every value the
// writer accepts must decode when read back: a record the decoder rejects,
// once written, turns every later read of that log or run into `corrupt` for
// good. Each case below asserts the refusal AND that nothing was written —
// the log/run still reads cleanly and a follow-up write still works.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  INFRA_DIRNAME,
  LedgerError,
  RUN_ID_PATTERN,
  createInfraLedger,
  createIntentLedger,
} from "../build/index.js";
import {
  RUN,
  auditLogPath,
  createIntent,
  ledgerLogPath,
  newLedger,
  openProvisioning,
  runDirPath,
  runStatePath,
  tempRoot,
  updateIntent,
} from "./helpers.js";

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof LedgerError, `not a LedgerError: ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

function readOrEmpty(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Refused, log byte-identical, and the run still accepts a good write. */
async function assertRefusedCleanly(ledger, rootDir, runId, attempt) {
  const before = readOrEmpty(ledgerLogPath(rootDir, runId));
  await assert.rejects(attempt, expectCode("protocol"));
  assert.equal(readOrEmpty(ledgerLogPath(rootDir, runId)), before);
  await ledger.entries(runId);
  const next = await ledger.intend(createIntent(runId, `after-${Date.now()}`));
  assert.equal(next.state, "intended");
  await ledger.recover(runId);
}

describe("intend refuses what the decoder would reject", () => {
  it("an empty target.sysId", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await assertRefusedCleanly(ledger, rootDir, "run-1", () =>
      ledger.intend(
        createIntent("run-1", "k1", {
          target: { table: "sys_atf_test", sysId: "" },
        }),
      ),
    );
  });

  it("an empty compensation.sysId on a delete", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await assertRefusedCleanly(ledger, rootDir, "run-1", () =>
      ledger.intend(
        createIntent("run-1", "k1", {
          compensation: { op: "delete", table: "sys_atf_test", sysId: "" },
        }),
      ),
    );
  });

  it("a restore without its fields snapshot", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await assertRefusedCleanly(ledger, rootDir, "run-1", () =>
      ledger.intend(
        updateIntent("run-1", "k1", "abc", {
          compensation: { op: "restore", table: "sys_user", sysId: "abc" },
        }),
      ),
    );
  });

  it("a probe without a key, or with an unknown key", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    for (const key of [undefined, "made-up"]) {
      await assertRefusedCleanly(ledger, rootDir, "run-1", () =>
        ledger.intend(
          createIntent("run-1", `k-${String(key)}`, {
            probe: { table: "sys_atf_test", query: "q", key },
          }),
        ),
      );
    }
  });

  it("an unknown compensation op", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await assertRefusedCleanly(ledger, rootDir, "run-1", () =>
      ledger.intend(
        createIntent("run-1", "k1", {
          compensation: { op: "archive", table: "sys_atf_test" },
        }),
      ),
    );
  });
});

describe("the decode-before-write gate itself", () => {
  // Inputs that pass every targeted field check but whose ENCODED form the
  // decoder rejects — only `assertDecodable` stands between them and disk.
  it("a compensation whose JSON form differs from the object (toJSON)", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await assertRefusedCleanly(ledger, rootDir, "run-1", () =>
      ledger.intend(
        createIntent("run-1", "k1", {
          compensation: {
            op: "delete",
            table: "sys_atf_test",
            toJSON: () => ({ op: "delete" }),
          },
        }),
      ),
    );
  });

  it("a restore snapshot that cannot be encoded (BigInt)", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    await assertRefusedCleanly(ledger, rootDir, "run-1", () =>
      ledger.intend(
        updateIntent("run-1", "k1", "abc", {
          compensation: {
            op: "restore",
            table: "sys_user",
            sysId: "abc",
            fields: { n: 1n },
          },
        }),
      ),
    );
  });

  it("openRun with a lifecycle outside the vocabulary writes no run.json", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await assert.rejects(
      ledger.openRun({ runId: "run-1", ...RUN, lifecycle: "forever" }),
      expectCode("protocol"),
    );
    assert.equal(existsSync(runStatePath(rootDir, "run-1")), false);
    assert.deepEqual(await ledger.listRuns(), []);
    await ledger.openRun({ runId: "run-1", ...RUN });
    assert.equal((await ledger.readRun("run-1")).lifecycle, RUN.lifecycle);
  });

  it("the infra namespace refuses the same way", async (t) => {
    const rootDir = tempRoot(t);
    const infra = createInfraLedger({ rootDir, host: "dev1.service-now.com" });
    await assert.rejects(
      infra.intend({
        planHash: "a".repeat(64),
        intent: "create",
        idempotencyKey: "k1",
        target: { table: "sys_properties", sysId: "abc" },
        compensation: {
          op: "delete",
          table: "sys_properties",
          toJSON: () => ({ op: "delete" }),
        },
      }),
      expectCode("protocol"),
    );
    assert.deepEqual(await infra.entries(), []);
  });
});

describe("confirm / compensate refuse an empty result.sysId", () => {
  for (const method of ["confirm", "compensate"]) {
    it(method, async (t) => {
      const { rootDir, ledger } = newLedger(t);
      await openProvisioning(ledger, "run-1");
      const entry = await ledger.intend(createIntent("run-1", "k1"));
      await assertRefusedCleanly(ledger, rootDir, "run-1", () =>
        ledger[method]("run-1", entry.seq, { sysId: "" }),
      );
      assert.equal(
        (await ledger.entries("run-1")).find((e) => e.seq === entry.seq).state,
        "intended",
      );
    });
  }
});

describe("openRun refuses a pid the decoder would reject", () => {
  for (const pid of [1.5, Number.NaN, -1, "123"]) {
    it(`pid=${String(pid)}`, async (t) => {
      const { rootDir, ledger } = newLedger(t);
      await assert.rejects(
        ledger.openRun({ runId: "run-1", ...RUN, pid }),
        expectCode("protocol"),
      );
      assert.equal(existsSync(runStatePath(rootDir, "run-1")), false);
      assert.equal(await ledger.readRun("run-1"), undefined);
      assert.deepEqual(await ledger.listRuns(), []);
      const opened = await ledger.openRun({ runId: "run-1", ...RUN, pid: 42 });
      assert.equal(opened.pid, 42);
      assert.equal((await ledger.readRun("run-1")).pid, 42);
    });
  }
});

describe("appendAudit validates `at` and decodes before appending", () => {
  for (const at of ["", 42, "not a date"]) {
    it(`at=${JSON.stringify(at)}`, async (t) => {
      const { rootDir, ledger } = newLedger(t);
      const input = { kind: "token-consumed", runId: "run-1", at };
      await assert.rejects(
        ledger.appendAudit({ ...input, verdictHash: "h1" }),
        expectCode("protocol"),
      );
      assert.throws(
        () => ledger.appendAuditSync({ ...input, verdictHash: "h1" }),
        expectCode("protocol"),
      );
      assert.equal(readOrEmpty(auditLogPath(rootDir)), "");
      await ledger.appendAudit({
        kind: "token-consumed",
        runId: "run-1",
        verdictHash: "h2",
      });
      const records = await ledger.readAudit();
      assert.deepEqual(
        records.map((r) => r.verdictHash),
        ["h2"],
      );
    });
  }
});

describe("run ids are lowercase-only (case-insensitive filesystems)", () => {
  it("the pattern refuses any uppercase letter", () => {
    for (const id of ["Run1", "run-1T000000Z", "RUN"]) {
      assert.equal(RUN_ID_PATTERN.test(id), false, id);
    }
    assert.equal(RUN_ID_PATTERN.test("run-20260925t000000-ab12cd34"), true);
  });

  it("openRun refuses a mixed-case id without creating a directory", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await assert.rejects(
      ledger.openRun({ runId: "Run1", ...RUN }),
      expectCode("invalid-run-id"),
    );
    assert.equal(existsSync(runDirPath(rootDir, "Run1")), false);
  });

  it("readRun throws corrupt when run.json names a different run", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await ledger.openRun({ runId: "run-a", ...RUN });
    mkdirSync(runDirPath(rootDir, "run-b"), { recursive: true });
    writeFileSync(
      runStatePath(rootDir, "run-b"),
      readFileSync(runStatePath(rootDir, "run-a"), "utf8"),
    );
    await assert.rejects(ledger.readRun("run-b"), expectCode("corrupt"));
    await assert.rejects(
      ledger.openRun({ runId: "run-b", ...RUN }),
      expectCode("corrupt"),
    );
  });
});

describe("infra host is case-folded", () => {
  const input = {
    planHash: "a".repeat(64),
    intent: "create",
    idempotencyKey: "k1",
    target: { table: "sys_properties", sysId: "abc" },
    compensation: { op: "delete", table: "sys_properties" },
  };

  it("two spellings of one host share one namespace and one dedupe", async (t) => {
    const rootDir = tempRoot(t);
    const lower = createInfraLedger({ rootDir, host: "dev1.service-now.com" });
    const upper = createInfraLedger({ rootDir, host: "DEV1.Service-Now.com" });
    assert.equal(upper.host, "dev1.service-now.com");
    const first = await lower.intend(input);
    const second = await upper.intend(input);
    assert.deepEqual(second, first);
    assert.equal((await upper.entries()).length, 1);
    assert.equal(
      existsSync(join(rootDir, INFRA_DIRNAME, "dev1.service-now.com")),
      true,
    );
  });

  it("an infra confirm with an empty sysId is refused, not written", async (t) => {
    const rootDir = tempRoot(t);
    const infra = createInfraLedger({ rootDir, host: "dev1.service-now.com" });
    const entry = await infra.intend(input);
    await assert.rejects(
      infra.confirm(entry.seq, { sysId: "" }),
      expectCode("protocol"),
    );
    const again = await infra.intend({ ...input, idempotencyKey: "k2" });
    assert.equal(again.seq, 2);
    assert.equal((await infra.entries()).length, 2);
  });
});

describe("openRun is exclusive across ledger instances", () => {
  it("two instances racing on one id with different params: exactly one wins", async (t) => {
    const rootDir = tempRoot(t);
    for (let round = 0; round < 10; round += 1) {
      const runId = `race-${round}`;
      const a = createIntentLedger({ rootDir });
      const b = createIntentLedger({ rootDir });
      const results = await Promise.allSettled([
        a.openRun({ runId, ...RUN, scope: "scope_a" }),
        b.openRun({ runId, ...RUN, scope: "scope_b", lifecycle: "persistent" }),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      assert.equal(won.length, 1, `round ${round}: ${JSON.stringify(results)}`);
      assert.equal(lost.length, 1);
      assert.equal(lost[0].reason.code, "run-exists");
      assert.equal((await a.readRun(runId)).scope, won[0].value.scope);
    }
  });

  it("two instances racing with the SAME params both resolve to one record", async (t) => {
    const rootDir = tempRoot(t);
    const a = createIntentLedger({ rootDir });
    const b = createIntentLedger({ rootDir });
    const [x, y] = await Promise.all([
      a.openRun({ runId: "same", ...RUN }),
      b.openRun({ runId: "same", ...RUN }),
    ]);
    assert.deepEqual(x, y);
  });
});
