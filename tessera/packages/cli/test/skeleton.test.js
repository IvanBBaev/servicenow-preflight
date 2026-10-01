// The PLAN Phase 0.5 walking skeleton, end to end against the stateful fake
// (QA-18 Tier-2). Everything here is REAL except the instance: the real
// TargetGuard, the real on-disk intent ledger, the real gate, the real run loop
// and the real hardcoded adapters. Only `@tessera/fake-instance` (plus the
// Tier-2 ATF execution engine that makes its CI/CD endpoint actually execute a
// step script) stands in for ServiceNow.
//
// The centrepiece is the green/red pair. It is worth being precise about what
// makes it meaningful: the fake is seeded with the reviewed s5-probe Script
// Include, the projected ATF step script is evaluated in `node:vm` against
// whatever bytes are in `sys_script_include.script`, and the assertion outcomes
// are derived from that evaluation. So the red run is red because the mutant
// source computes a different number — not because a fixture said "failed".
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { GuardViolation } from "@tessera/guard";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import {
  ATF_TABLES,
  createLedgerGuardAuditSink,
  failedAssertionNames,
  installAtfExecutionEngine,
  parseAssertionOutput,
  S5_ASSERTION_COUNT,
  S5_SPEC_ID,
  S5_THRESHOLD_ASSERTION,
  seedS5Instance,
  SCRIPT_INCLUDE_TABLE,
  TEST_RESULT_STATUS_FAIL,
  TEST_RESULT_STATUS_PASS,
} from "@tessera/phase05";

// `runSkeleton` moved with the composition root: the hand-wiring it used to do
// inside `@tessera/skeleton` is exactly what the ARCH-1 exception covered, and
// discharging that exception meant moving the wiring here. The adapters it
// wires still come from the frozen Phase-0.5 package above.
import { main, runSkeleton } from "../build/index.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * Allowlisted AND non-prod by the §11.2 name heuristic. The default host of the
 * fake ("fake-instance...") would NOT do: its first label carries no dev/test
 * marker, so the heuristic downgrades it to `prod-suspect` and every green run
 * would need an override.
 */
const HOST = "dev-skeleton.service-now.com";
const INSTANCE = { name: "skeleton-fake", host: HOST };

/** Injected clock — no `Date.now()` anywhere below the CLI. */
const FIXED_NOW = () => new Date("2026-02-02T03:04:05.000Z");

/** The five tables an ephemeral run projects and must therefore reclaim. */
const PROJECTED_TABLES = [
  ATF_TABLES.suite,
  ATF_TABLES.test,
  ATF_TABLES.suiteTest,
  ATF_TABLES.step,
  ATF_TABLES.stepInput,
];

const HAPPY_PATH = [
  "planned",
  "provisioning",
  "projecting",
  "running",
  "collecting",
  "tearing-down",
  "done",
];

/** Everything `@tessera/sn-client` reads out of the environment (ARCH-7/18). */
const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH",
  "SN_DOCS_DIR",
  "SN_READONLY",
  "SN_ACTIVE_PROFILE",
  "SN_ALLOWED_HOSTS",
];

// ── harness ─────────────────────────────────────────────────────────────────

const tempRoots = [];

async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-skeleton-"));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Build a fake instance, install the Tier-2 execution engine over the global
 * `fetch`, and stage the environment the vendored client reads. Returns the
 * pieces a test needs plus the restorer — the library itself reads no env, so
 * SOMETHING has to write it, and in the real product that is the CLI.
 */
async function harness(options = {}) {
  const ledgerRoot = await tempRoot();
  const fake = createFakeInstance({
    host: options.host ?? HOST,
    state: seedS5Instance({
      variant: options.variant ?? "correct",
      ...(options.atfRunnerEnabled === undefined
        ? {}
        : { atfRunnerEnabled: options.atfRunnerEnabled }),
      ...(options.productionProperty === undefined
        ? {}
        : { productionProperty: options.productionProperty }),
    }),
  });
  const restoreFetch = installAtfExecutionEngine(fake);

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SN_INSTANCE = options.host ?? HOST;
  process.env.SN_USER = "tessera";
  process.env.SN_PASSWORD = "tessera";
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(ledgerRoot, "sn-docs");
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  reloadCredentialsFromEnv();

  return {
    fake,
    ledgerRoot,
    restore() {
      restoreFetch();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

function baseOptions(h, overrides = {}) {
  return {
    runId: "run-skeleton-test",
    instance: INSTANCE,
    now: FIXED_NOW,
    ledgerRoot: h.ledgerRoot,
    nonProdAllowlist: [HOST],
    pollIntervalMs: 1,
    ...overrides,
  };
}

/** Every non-GET request the fake served — i.e. every attempted mutation. */
function writes(fake) {
  return fake.requests().filter((entry) => entry.method !== "GET");
}

/** The ledger's audit log (§4b/ARCH-43). An absent log reads as no records. */
const auditLogPath = (ledgerRoot) => path.join(ledgerRoot, "audit.jsonl");

function auditRecords(ledgerRoot) {
  let raw;
  try {
    raw = readFileSync(auditLogPath(ledgerRoot), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Everything under the ledger root that looks like a second audit journal.
 *
 * The §11.4 record used to be written twice — the whole fact to a sibling
 * `guard-audit.jsonl` and a `{reason, actor}` stub to the ledger's own log —
 * and the failure mode of "unify them" is to add the fields to one writer and
 * leave the other running, which duplicates the fact rather than unifying it.
 * So this asserts the ABSENCE of any second journal by shape, not the absence
 * of one remembered filename.
 */
async function strayAuditLogs(ledgerRoot) {
  const entries = await fs.readdir(ledgerRoot, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /audit/i.test(entry.name) &&
        path.join(entry.parentPath ?? entry.path, entry.name) !==
          auditLogPath(ledgerRoot),
    )
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

/** The surviving DR-4 evidence rows, newest last. */
function testResults(fake) {
  return fake.tables.all(ATF_TABLES.testResult);
}

// ── the green / red pair ────────────────────────────────────────────────────

describe("walking skeleton: the hardcoded change, end to end", () => {
  it("goes GREEN on the correct source and returns GO", async () => {
    const h = await harness({ variant: "correct" });
    try {
      const result = await runSkeleton(baseOptions(h));

      assert.equal(result.report.state, "done");
      assert.deepEqual(result.report.transitions, HAPPY_PATH);
      assert.equal(result.report.verdict.status, "GO");
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.errors, []);

      // One spec, one row, and it passed on real evidence (DR-4).
      assert.equal(result.report.verdict.rows.length, 1);
      const [row] = result.report.verdict.rows;
      assert.equal(row.spec.id, S5_SPEC_ID);
      assert.equal(row.status, "pass");
      assert.equal(row.raw, "pass");
      assert.equal(row.blocking, false);
      assert.equal(row.target.table, SCRIPT_INCLUDE_TABLE);
      assert.ok(row.evidence, "a passing row must carry evidence");

      // The evidence is the sys_atf_test_result row the run actually produced.
      const results = testResults(h.fake);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, TEST_RESULT_STATUS_PASS);
      assert.equal(row.evidence.ref, results[0].sys_id);

      // All six assertions ran and all six passed. The wording is the ONE
      // guessed contract in this package (see `src/atfOutput.ts`), so the test
      // reads it through the same parser the Runner uses rather than hardcoding
      // a second copy of the guess.
      const parsed = parseAssertionOutput(results[0].output ?? "");
      assert.deepEqual(parsed.unparsed, []);
      assert.equal(parsed.assertions.length, S5_ASSERTION_COUNT);
      assert.deepEqual(failedAssertionNames(parsed), []);
      assert.ok(
        parsed.assertions.some(
          (entry) => entry.name === S5_THRESHOLD_ASSERTION,
        ),
        `the threshold assertion must be among them:\n${results[0].output}`,
      );
    } finally {
      h.restore();
    }
  });

  it("goes RED on the mutant source and names the assertion that broke", async () => {
    const h = await harness({ variant: "mutant" });
    try {
      const result = await runSkeleton(baseOptions(h));

      // The run itself is healthy — a failing test is not an infra fault
      // (DEV-1): the pipeline completes and the GATE is what says no.
      assert.equal(result.report.state, "done");
      assert.deepEqual(result.report.transitions, HAPPY_PATH);
      assert.deepEqual(result.errors, []);
      assert.equal(result.report.verdict.status, "NO_GO");

      const [row] = result.report.verdict.rows;
      assert.equal(row.status, "fail");
      assert.equal(row.blocking, true);

      // THE POINT OF THE PAIR: the failure is attributed to one NAMED
      // assertion, not to "the suite failed" (Spike 2b).
      assert.equal(result.failures.length, 1);
      assert.equal(result.failures[0].spec.id, S5_SPEC_ID);
      assert.equal(result.failures[0].assertion, S5_THRESHOLD_ASSERTION);

      // ...and exactly one assertion broke: the other five still pass, which is
      // what makes the mutant a boundary bug rather than a broken fixture.
      const results = testResults(h.fake);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, TEST_RESULT_STATUS_FAIL);
      const parsed = parseAssertionOutput(results[0].output ?? "");
      assert.deepEqual(parsed.unparsed, []);
      assert.equal(parsed.assertions.length, S5_ASSERTION_COUNT);
      assert.deepEqual(failedAssertionNames(parsed), [S5_THRESHOLD_ASSERTION]);

      // The mutant drops the `>=` to `>`, so 100 units pay full price: the
      // detail carries the actual arithmetic, not a canned message.
      const failed = parsed.assertions.find((entry) => !entry.passed);
      assert.equal(failed.detail, "expected 900, got 1000");
    } finally {
      h.restore();
    }
  });

  it("derives green vs red from the target source alone", async () => {
    // Same run id, same options, same everything: only the seeded bytes differ.
    const green = await harness({ variant: "correct" });
    let greenStatus;
    try {
      greenStatus = (await runSkeleton(baseOptions(green))).report.verdict
        .status;
    } finally {
      green.restore();
    }

    const red = await harness({ variant: "mutant" });
    let redStatus;
    try {
      redStatus = (await runSkeleton(baseOptions(red))).report.verdict.status;
    } finally {
      red.restore();
    }

    assert.equal(greenStatus, "GO");
    assert.equal(redStatus, "NO_GO");
  });
});

// ── §11 — the guard refuses before anything is written ──────────────────────

describe("§11 TargetGuard gates the run before the first write", () => {
  it("refuses a declared-prod runner and writes nothing", async () => {
    const h = await harness();
    try {
      await assert.rejects(
        runSkeleton(baseOptions(h, { prodInstances: [HOST] })),
        (error) => {
          assert.ok(error instanceof GuardViolation);
          // §11.5 refuses before §11.4's declared-prod path is ever reached:
          // `assertRunnerWritable` rejects a prod-OR-unknown runner at
          // composition time and reports the rule that actually fired.
          // `declared-prod` is `assertWrite`'s code, one layer further in.
          assert.equal(error.detail.reason, "runner-not-writable");
          assert.equal(error.detail.cls, "prod");
          assert.equal(error.detail.role, "runner");
          return true;
        },
      );

      // Nothing was projected, and no ledger entry for the run exists: the
      // refusal happens before `openRun`.
      assert.deepEqual(writes(h.fake), []);
      for (const table of PROJECTED_TABLES) {
        assert.equal(h.fake.tables.all(table).length, 0, table);
      }
      await assert.rejects(
        fs.access(path.join(h.ledgerRoot, "runs", "run-skeleton-test")),
      );
    } finally {
      h.restore();
    }
  });

  it("does not let --acknowledge-prod lift a declared-prod runner (§11.4)", async () => {
    const h = await harness();
    try {
      await assert.rejects(
        runSkeleton(
          baseOptions(h, {
            prodInstances: [HOST],
            acknowledgeProd: {
              reason: "I really mean it",
              actor: "tester",
              surface: "cli",
            },
          }),
        ),
        (error) => {
          // Byte-for-byte the refusal from the test above, flag or no flag:
          // the §11.5 runner floor throws before `authorizeSuspect` is
          // reached, so the acknowledgement is never even read. It only ever
          // covers a heuristic downgrade of an allowlisted instance (§11.4).
          assert.equal(error.detail.reason, "runner-not-writable");
          assert.equal(error.detail.cls, "prod");
          return true;
        },
      );
      assert.deepEqual(writes(h.fake), []);

      // The override was refused, not honoured. Journalling happens only on
      // the path that GRANTS one, so nothing was audited at all — an audited
      // override of a declared-prod runner does not exist.
      //
      // This used to assert the absence of `guard-audit.jsonl`. That file no
      // longer exists on any path, so the assertion would have passed for the
      // wrong reason forever: it names the ledger's audit log now, which IS
      // written when an override is granted, so the case can still fail.
      assert.deepEqual(auditRecords(h.ledgerRoot), []);
      await assert.rejects(fs.access(auditLogPath(h.ledgerRoot)));
    } finally {
      h.restore();
    }
  });

  it("refuses an un-acknowledged prod-suspect runner", async () => {
    // Allowlisted, but `glide.installation.production` is true, so the §11.2
    // probe downgrades it. Downgrades only ever subtract permission.
    const h = await harness({ productionProperty: true });
    try {
      await assert.rejects(runSkeleton(baseOptions(h)), (error) => {
        assert.ok(error instanceof GuardViolation);
        assert.equal(error.detail.reason, "unacknowledged-suspect");
        assert.equal(error.detail.cls, "prod-suspect");
        return true;
      });
      assert.deepEqual(writes(h.fake), []);
    } finally {
      h.restore();
    }
  });

  // ── the §11.4 record: ONE append, carrying the whole fact ─────────────────
  //
  // RATIFIED BEHAVIOUR CHANGE (2026-08-31), not a fixture repair. Until this
  // date the acknowledgement was journalled TWICE: the guard's sink wrote the
  // whole record to a sibling `guard-audit.jsonl`, and the composition root
  // separately appended a `{kind, runId, reason, actor, at}` stub of the SAME
  // event to the ledger's audit log. The tests below asserted that both files
  // existed — i.e. they pinned the split in place, because they were written
  // to describe the behaviour rather than the property.
  //
  // The property has NOT changed and is what they still assert: the §11.4
  // acknowledgement is durably journalled BEFORE the write is allowed to
  // proceed. Only its location did — one record, in the ledger's own audit log.
  const ACK = {
    reason: "PDI mirrors prod properties",
    actor: "ivan",
    surface: "cli",
  };

  /** A whole §11.4 record, as the guard hands one to the sink. */
  const ackRecord = () => ({
    kind: "acknowledge-prod",
    runId: "run-skeleton-test",
    at: FIXED_NOW().toISOString(),
    instance: { name: INSTANCE.name, host: HOST },
    role: "runner",
    cls: "prod-suspect",
    evidence: [
      {
        kind: "production-property",
        effect: "downgrade",
        detail: "glide.installation.production reads true",
      },
    ],
    ...ACK,
  });

  it("lets an audited acknowledgement through and journals the whole §11.4 fact", async () => {
    const h = await harness({ productionProperty: true });
    try {
      const result = await runSkeleton(
        baseOptions(h, { acknowledgeProd: ACK }),
      );

      assert.equal(result.runner.cls, "prod-suspect");
      assert.equal(result.report.verdict.status, "GO");
      assert.equal(result.acknowledgements.length, 1);
      assert.match(result.acknowledgements[0], /PDI mirrors prod properties/);

      const acks = auditRecords(h.ledgerRoot).filter(
        (record) => record.kind === "acknowledge-prod",
      );

      // ONE append. Two would mean the split reopened as a duplicate, which is
      // worse than the split: two accounts of one event that can disagree.
      assert.equal(
        acks.length,
        1,
        `the §11.4 acknowledgement must be journalled exactly once; got:\n${JSON.stringify(acks, null, 2)}`,
      );

      // ...carrying every field §11.4 names. Asserted as a field SET, so a
      // field silently dropped by the sink fails here by name.
      const [ack] = acks;
      assert.deepEqual(Object.keys(ack).sort(), [
        "actor",
        "at",
        "cls",
        "evidence",
        "instance",
        "kind",
        "reason",
        "role",
        "runId",
        "surface",
      ]);
      assert.equal(ack.runId, "run-skeleton-test");
      assert.equal(ack.reason, ACK.reason);
      assert.equal(ack.actor, ACK.actor);
      assert.equal(ack.surface, ACK.surface);
      assert.equal(ack.role, "runner");
      assert.equal(ack.cls, "prod-suspect");
      assert.deepEqual(ack.instance, { name: INSTANCE.name, host: HOST });

      // The evidence is the guard's actual case, not a placeholder: the run is
      // prod-suspect BECAUSE `glide.installation.production` reads true, and
      // that downgrade has to be legible in the record.
      assert.deepEqual(ack.evidence, result.runner.evidence);
      assert.ok(
        ack.evidence.some(
          (signal) =>
            signal.kind === "production-property" &&
            signal.effect === "downgrade",
        ),
        `the downgrade that made the override necessary must be journalled:\n${JSON.stringify(ack.evidence, null, 2)}`,
      );
    } finally {
      h.restore();
    }
  });

  it("propagates a failed append instead of swallowing it", () => {
    // §11.6 closes the loop only if the sink is honest about failing: the guard
    // turns a THROW from `record()` into an `override-not-journalled` violation
    // and refuses the write (covered end to end in the guard's own suite,
    // `acknowledgeProd.test.js`). A sink that caught its own append error would
    // leave that machinery intact and unreachable — the run would proceed on an
    // acknowledgement that is on nobody's disk.
    //
    // The sink is exercised directly here because `@tessera/phase05` carries no
    // suite of its own and this composition root is its only consumer; a stub
    // ledger is the only way to make a real fsync fail on demand.
    const boom = new Error("audit.jsonl is not writable");
    const sink = createLedgerGuardAuditSink({
      appendAuditSync() {
        throw boom;
      },
    });

    assert.throws(() => sink.record(ackRecord()), boom);

    // ...and nothing it failed to journal is reported as journalled. An
    // in-memory echo of a record that never reached the disk is exactly the
    // second, disagreeing account of the event this whole change removes.
    assert.deepEqual(sink.records(), []);
  });

  it("writes the §11.4 record to the ledger's audit log and nowhere else", async () => {
    const h = await harness({ productionProperty: true });
    try {
      await runSkeleton(baseOptions(h, { acknowledgeProd: ACK }));

      assert.deepEqual(
        await strayAuditLogs(h.ledgerRoot),
        [],
        "a second audit journal alongside the ledger's is the split reopened",
      );
    } finally {
      h.restore();
    }
  });

  it("has the §11.4 acknowledgement on disk before the first mutation reaches the instance", async () => {
    // THE property. `assertRunnerWritable` is synchronous (§11.6) and the sink
    // it calls must have fsynced by the time it returns — so the record is
    // durable before the guard permits anything, not merely present once the
    // run is over. A sink that deferred its append would still leave a correct
    // file behind and pass every assertion above.
    const h = await harness({ productionProperty: true });
    const inner = globalThis.fetch;
    let atFirstWrite;
    globalThis.fetch = (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (atFirstWrite === undefined && method !== "GET") {
        // Synchronous read: whatever it sees was already fsynced.
        atFirstWrite = auditRecords(h.ledgerRoot);
      }
      return inner(input, init);
    };

    try {
      const result = await runSkeleton(
        baseOptions(h, { acknowledgeProd: ACK }),
      );
      assert.equal(result.report.verdict.status, "GO");

      assert.ok(atFirstWrite, "the run must have written something");
      const acks = atFirstWrite.filter(
        (record) => record.kind === "acknowledge-prod",
      );
      assert.equal(
        acks.length,
        1,
        `the acknowledgement must be durable before the first mutation; the audit log then held:\n${JSON.stringify(atFirstWrite, null, 2)}`,
      );
      assert.equal(acks[0].reason, ACK.reason);
      assert.equal(acks[0].cls, "prod-suspect");
    } finally {
      globalThis.fetch = inner;
      h.restore();
    }
  });
});

// ── §4b — write-ahead ordering ──────────────────────────────────────────────

describe("§4b the intent ledger is durable before the first projected record", () => {
  it("has an intended write on disk before the first mutation reaches the instance", async () => {
    const h = await harness();
    const runId = "run-write-ahead";
    const ledgerFile = path.join(h.ledgerRoot, "runs", runId, "ledger.jsonl");

    // Sit between the execution engine and the instance and photograph the
    // ledger the instant the first non-GET request is about to be served. This
    // is a SYNCHRONOUS read: whatever it sees was already fsynced to disk.
    const inner = globalThis.fetch;
    let firstWrite;
    globalThis.fetch = (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (firstWrite === undefined && method !== "GET") {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        let ledger;
        try {
          ledger = readFileSync(ledgerFile, "utf8");
        } catch {
          // The photograph is taken before the ledger file necessarily
          // exists, and an absent file is itself the finding the assertion
          // below reports — so it reads as an empty ledger, not an error.
          ledger = "";
        }
        firstWrite = { url, method, ledger };
      }
      return inner(input, init);
    };

    try {
      const result = await runSkeleton(baseOptions(h, { runId }));
      assert.equal(result.report.verdict.status, "GO");

      assert.ok(firstWrite, "the run must have written something");
      assert.equal(firstWrite.method, "POST");
      assert.match(firstWrite.url, /\/api\/now\/table\//);

      const entries = firstWrite.ledger
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
      const intended = entries.filter(
        (entry) => entry.kind === "write" && entry.state === "intended",
      );
      assert.ok(
        intended.length >= 1,
        `an intended write must precede the first projected record; ledger was:\n${firstWrite.ledger}`,
      );
      assert.equal(intended[0].runId, runId);
    } finally {
      globalThis.fetch = inner;
      h.restore();
    }
  });
});

// ── §4a — ephemeral teardown ────────────────────────────────────────────────

describe("§4a ephemeral teardown reclaims what the run created", () => {
  it("deletes every projected record and keeps the evidence", async () => {
    const h = await harness();
    try {
      const result = await runSkeleton(baseOptions(h));

      assert.equal(result.report.teardown, "completed");
      assert.ok(result.created.length > 0);
      // Everything created is accounted for by a delete (DEV-13).
      assert.deepEqual(
        [...result.deleted].sort(byRecord),
        [...result.created].sort(byRecord),
      );

      for (const table of PROJECTED_TABLES) {
        assert.equal(
          h.fake.tables.all(table).length,
          0,
          `${table} still holds rows after teardown`,
        );
      }

      // ARCH-26: nothing anywhere still carries the run-id namespace.
      const orphans = h.fake.tables.find((record) =>
        Object.values(record).some(
          (value) =>
            typeof value === "string" && value.includes("run-skeleton-test"),
        ),
      );
      assert.deepEqual(
        orphans.filter(
          (orphan) =>
            orphan.table !== ATF_TABLES.testResult &&
            orphan.table !== ATF_TABLES.suiteResult,
        ),
        [],
      );

      // The DR-4 evidence row is NOT teardown's to delete: it is the proof the
      // verdict was built from, and the run keeps it on purpose.
      assert.equal(testResults(h.fake).length, 1);

      // The target itself was never touched — the skeleton tests a change, it
      // does not make one.
      const includes = h.fake.tables.all(SCRIPT_INCLUDE_TABLE);
      assert.equal(includes.length, 1);
    } finally {
      h.restore();
    }
  });

  it("refuses the persistent lifecycle at the project stage (DEV-20)", async () => {
    const h = await harness();
    try {
      const result = await runSkeleton(
        baseOptions(h, { lifecycle: "persistent" }),
      );
      // §4a `persistent` needs the manifest + natural-key upsert; Phase 0.5
      // has neither, so the store refuses rather than leaking records it
      // could never reclaim. The verdict is the honest one: no evidence was
      // gathered, so INCONCLUSIVE — never a green.
      assert.equal(result.report.failure.stage, "project");
      assert.match(result.report.failure.message, /ephemeral/);
      assert.equal(result.report.verdict.status, "INCONCLUSIVE");

      // The run still lands on `done`, and that is not a contradiction:
      // DESIGN §4b defines `failed` as "non-compensated entries remain;
      // cleanup prescribed". Nothing was projected, so nothing is owed, so
      // there is nothing for `tess cleanup` to re-enter. The stage fault is
      // reported on `failure` and in the verdict, not by the run state.
      assert.equal(result.report.state, "done");
      assert.deepEqual(result.report.transitions, [
        "planned",
        "provisioning",
        "projecting",
        "tearing-down",
        "done",
      ]);
      assert.equal(result.report.teardown, "skipped-persistent");
      for (const table of PROJECTED_TABLES) {
        assert.equal(h.fake.tables.all(table).length, 0, table);
      }
    } finally {
      h.restore();
    }
  });
});

// ── DR-3 / DEV-1 — the two ways a run legitimately produces no verdict ──────

describe("standing infrastructure and infra faults", () => {
  it("classifies an ATF-disabled runner prod-suspect before provisioning (DR-3, §11.2)", async () => {
    // A disabled ATF runner is a §11.2 DOWNGRADE signal, not merely missing
    // infrastructure: production instances are exactly where ATF is off. So
    // the guard refuses one layer earlier than the provisioner would, and the
    // run never gets far enough to discover the property for itself.
    const h = await harness({ atfRunnerEnabled: false });
    try {
      await assert.rejects(runSkeleton(baseOptions(h)), (error) => {
        assert.ok(error instanceof GuardViolation);
        assert.equal(error.detail.reason, "unacknowledged-suspect");
        assert.equal(error.detail.cls, "prod-suspect");
        // The refusal must name the signal that caused it — "prod-suspect"
        // alone would send the reader hunting for a prod declaration that
        // does not exist.
        const downgrades = error.detail.evidence
          .filter((signal) => signal.effect === "downgrade")
          .map((signal) => signal.kind);
        assert.deepEqual(downgrades, ["atf-runner-disabled"]);
        return true;
      });
      assert.deepEqual(writes(h.fake), []);
    } finally {
      h.restore();
    }
  });

  it("still refuses at the provision stage once the suspicion is acknowledged (DR-3, ARCH-33)", async () => {
    // With the §11.4 acknowledgement the guard steps aside, which is what
    // makes the provisioner's own DR-3 check reachable at all. It refuses for
    // the second, independent reason: the standing infrastructure is absent.
    const h = await harness({ atfRunnerEnabled: false });
    try {
      const result = await runSkeleton(
        baseOptions(h, {
          acknowledgeProd: {
            reason: "ATF is off on purpose in this fixture",
            actor: "tester",
            surface: "cli",
          },
        }),
      );

      assert.equal(result.report.failure.stage, "provision");
      assert.equal(result.report.verdict.status, "INCONCLUSIVE");
      assert.equal(result.acknowledgements.length, 1);

      // ARCH-33: the run loop reports missing standing infrastructure and
      // prescribes preflight_apply — it never writes it itself. So the
      // property is still false and not one mutation was attempted.
      assert.match(result.report.failure.message, /ARCH-33/);
      assert.match(result.report.failure.message, /sys_properties/);
      assert.deepEqual(writes(h.fake), []);
      assert.equal(result.report.teardown, "not-reached");
      for (const table of PROJECTED_TABLES) {
        assert.equal(h.fake.tables.all(table).length, 0, table);
      }
    } finally {
      h.restore();
    }
  });
});

// ── the frozen exit mapping, through the wired command ──────────────────────
//
// The renderers are pinned against a literal fixture in `cli.test.js`. That
// proves the fixture. This proves the product: `main` -> `runCommand` ->
// `stage` -> the real pipeline -> the real `aggregateVerdict` -> the real
// renderers, with only the instance faked, and the number asserted is the one
// `main` actually returns. A field that the real path dropped — because the
// pipeline builds its verdict somewhere the double never goes — would pass
// there and fail here.

describe("tess run --skeleton, the exit code it returns", () => {
  /** Run the wired command against the QA-18 fake and keep what it printed. */
  async function tess(...extra) {
    const ledgerRoot = await tempRoot();
    const out = [];
    const code = await main(
      ["run", "--skeleton", "--fake", "--ledger-root", ledgerRoot, ...extra],
      {
        now: FIXED_NOW,
        actor: "test",
        cwd: ledgerRoot,
        env: {},
        stdout: (line) => out.push(line),
        stderr: () => {},
      },
    );
    return { code, text: out.join("\n") };
  }

  /**
   * The lever for an undecided run: a deadline of 1ms cannot be met by any
   * machine, so DEV-2 interrupts the pipeline and `synthesize` fills every
   * planned spec with an outcome the RESOLUTION table resolves to
   * `inconclusive` + blocking — the §6a rung that yields INCONCLUSIVE. A slower
   * machine makes this MORE reliable, not less, so there is no flake in the
   * direction that would matter.
   */
  const UNDECIDABLE = ["--run-timeout-ms", "1"];

  it("returns 1 for an INCONCLUSIVE run, exactly as it does for a NO_GO one", async () => {
    // The freeze itself, through the product. If this test ever goes red with a
    // 5, the mapping has been widened and every CI job pinned to this command
    // has silently changed meaning.
    const undecided = await tess(...UNDECIDABLE, "--json");
    const failed = await tess("--mutant", "--json");
    const green = await tess("--json");

    assert.equal(JSON.parse(undecided.text).verdict.status, "INCONCLUSIVE");
    assert.equal(JSON.parse(failed.text).verdict.status, "NO_GO");
    assert.equal(JSON.parse(green.text).verdict.status, "GO");

    assert.equal(undecided.code, 1);
    assert.equal(failed.code, 1);
    assert.equal(green.code, 0);
  });

  it("tells a machine which of the two answers that 1 is (QA-9)", async () => {
    // The exit code is frozen, so this is the only thing standing between a
    // consumer and reading "we could not tell" as "the target failed".
    const undecided = JSON.parse((await tess(...UNDECIDABLE, "--json")).text);
    assert.equal(undecided.verdict.exitCode, 1);
    assert.equal(undecided.verdict.exitCodeCollapsed, true);

    const failed = JSON.parse((await tess("--mutant", "--json")).text);
    assert.equal(failed.verdict.exitCode, 1);
    assert.equal(failed.verdict.exitCodeCollapsed, false);

    const green = JSON.parse((await tess("--json")).text);
    assert.equal(green.verdict.exitCode, 0);
    assert.equal(green.verdict.exitCodeCollapsed, false);
  });

  it("reports the same code it returns, in whichever branch was asked for", async () => {
    // Three numbers that must be one number: what the process returns, what the
    // document says, and what the human report prints.
    for (const extra of [UNDECIDABLE, ["--mutant"], []]) {
      const human = await tess(...extra);
      const machine = await tess(...extra, "--json");
      const verdict = JSON.parse(machine.text).verdict;

      assert.equal(machine.code, verdict.exitCode, verdict.status);
      assert.equal(human.code, verdict.exitCode, verdict.status);

      const printed = /^exit: +(\d+)/m.exec(human.text);
      assert.notEqual(printed, null, `no exit line for ${verdict.status}`);
      assert.equal(Number(printed[1]), human.code, verdict.status);
      assert.equal(
        /^NOTE$/m.test(human.text),
        verdict.exitCodeCollapsed,
        verdict.status,
      );
    }
  });

  it("tells a human reading the log, not only a parser", async () => {
    const undecided = await tess(...UNDECIDABLE);
    assert.match(undecided.text, /^VERDICT: +INCONCLUSIVE$/m);
    assert.match(undecided.text, /^exit: +1 \(collapsed — see NOTE\)$/m);
    assert.match(undecided.text, /^NOTE$/m);
    assert.match(undecided.text, /cannot tell/);

    // And says nothing of the sort when the answer really is no: a caveat
    // printed on every red run is a caveat nobody reads on the one that needs
    // it.
    const failed = await tess("--mutant");
    assert.match(failed.text, /^VERDICT: +NO_GO$/m);
    assert.match(failed.text, /^exit: +1$/m);
    assert.doesNotMatch(failed.text, /^NOTE$/m);
  });
});

function byRecord(a, b) {
  return `${a.table}/${a.sysId}`.localeCompare(`${b.table}/${b.sysId}`);
}

// ── F1: a reused, non-fresh run id is refused (exit 4) ──────────────────────
// Delegated decision 2026-09-26: before the gate, `tess run --skeleton --fake
// --run-id <existing>` printed a stage failure plus INCONCLUSIVE, exited 1 and
// rewrote run.json to `done` with nothing torn down. The run is now refused
// before any stage: exit 4, the ledger byte-for-byte unchanged, and the
// operator pointed at `tess cleanup` / `tess status`.

describe("tess run --skeleton with a run id that is already used (F1)", () => {
  /** The r2 repro's seeding, verbatim in shape. */
  async function seed(ledgerRoot, runId, final) {
    const { createIntentLedger } = await import("@tessera/ledger");
    const ledger = createIntentLedger({ rootDir: ledgerRoot });
    await ledger.openRun({
      runId,
      scope: "global",
      runner: HOST,
      lifecycle: "ephemeral",
    });
    await ledger.transition(runId, "provisioning");
    await ledger.transition(runId, "projecting");
    const entry = await ledger.intend({
      runId,
      instance: HOST,
      intent: "project",
      target: { table: "sys_atf_test" },
      compensation: { op: "delete", table: "sys_atf_test" },
      idempotencyKey: "k1",
      probe: {
        table: "sys_atf_test",
        query: `nameSTARTSWITH${runId}:`,
        key: "run-id-prefix",
      },
    });
    await ledger.confirm(runId, entry.seq, { sysId: "t1" });
    await ledger.transition(runId, "running");
    await ledger.intend({
      runId,
      instance: HOST,
      intent: "trigger",
      target: { table: "sys_atf_test_suite_result" },
      compensation: { op: "none", reason: "r" },
      idempotencyKey: "k2",
    });
    if (final !== "running") await ledger.transition(runId, final);
  }

  async function snapshot(root) {
    const out = {};
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else out[path.relative(root, full)] = await fs.readFile(full, "utf8");
      }
    }
    await walk(root);
    return out;
  }

  for (const final of ["abandoned", "collecting"]) {
    it(`exits 4 for a ${final} run and leaves its ledger untouched`, async () => {
      const ledgerRoot = await tempRoot();
      const runId = `run-reused-${final}`;
      await seed(ledgerRoot, runId, final);
      const runDir = path.join(ledgerRoot, "runs", runId);
      const before = await snapshot(runDir);
      const out = [];
      const err = [];

      const code = await main(
        [
          "run",
          "--skeleton",
          "--fake",
          "--ledger-root",
          ledgerRoot,
          "--run-id",
          runId,
        ],
        {
          now: FIXED_NOW,
          actor: "test",
          cwd: ledgerRoot,
          env: {},
          stdout: (line) => out.push(line),
          stderr: (line) => err.push(line),
        },
      );

      const text = err.join("\n");
      assert.equal(code, 4, `${text}\n${out.join("\n")}`);
      assert.match(text, /^REFUSED \(§4b\): /m);
      assert.match(text, new RegExp(`state ${final}`));
      assert.match(text, new RegExp(`tess cleanup --run-id ${runId}`));
      assert.match(text, new RegExp(`tess status --run-id ${runId}`));
      assert.doesNotMatch(out.join("\n"), /VERDICT/);
      assert.deepEqual(
        await snapshot(runDir),
        before,
        "the refusal must not touch run.json or the ledger",
      );
    });
  }
});

// ── §4b concurrency refusal and the corrupt-record hard stop ────────────────
// Delegated decision 2026-09-26: a second run on the same scope+runner is a
// REFUSAL (exit 4, its own `REFUSED (§4b concurrency)` prefix), not a DEV-1
// fault. A corrupt record under the ledger root stays a hard stop (exit 3) —
// nothing is quarantined or renamed — but the fault names every offending run
// and file and carries a remedy line.

describe("tess run --skeleton against a busy or damaged ledger root", () => {
  async function tess(argv) {
    const out = [];
    const err = [];
    const cwd = await tempRoot();
    const code = await main(argv, {
      now: FIXED_NOW,
      actor: "test",
      cwd,
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  async function openInFlight(ledgerRoot, runId, scope = "global") {
    const { createIntentLedger } = await import("@tessera/ledger");
    const ledger = createIntentLedger({ rootDir: ledgerRoot });
    await ledger.openRun({
      runId,
      scope,
      runner: HOST,
      lifecycle: "ephemeral",
    });
    await ledger.transition(runId, "provisioning");
  }

  async function snapshot(root) {
    const out = {};
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else out[path.relative(root, full)] = await fs.readFile(full, "utf8");
      }
    }
    await walk(root);
    return out;
  }

  it("exits 4 with a §4b concurrency refusal naming the run in flight", async () => {
    const ledgerRoot = await tempRoot();
    await openInFlight(ledgerRoot, "run-holder");
    const before = await snapshot(ledgerRoot);

    const r = await tess([
      "run",
      "--skeleton",
      "--fake",
      "--ledger-root",
      ledgerRoot,
      "--run-id",
      "run-second",
    ]);

    assert.equal(r.code, 4, `${r.err}\n${r.out}`);
    assert.match(r.err, /^REFUSED \(§4b concurrency\): /m);
    assert.doesNotMatch(r.err, /^REFUSED \(§4b\): /m);
    assert.doesNotMatch(r.err, /§11/);
    assert.doesNotMatch(r.err, /INFRASTRUCTURE FAULT/);
    assert.match(r.err, /run "run-holder" is already in flight/);
    assert.match(r.err, /state provisioning/);
    assert.match(r.err, /tess status --run-id run-holder/);
    assert.doesNotMatch(r.out, /VERDICT/);
    assert.deepEqual(
      await snapshot(ledgerRoot),
      before,
      "the refused run must not open a record or touch the holder's",
    );
  });

  it("exits 3 naming every corrupt record, with a remedy line", async () => {
    const ledgerRoot = await tempRoot();
    const bad = [];
    for (const runId of ["run-bad-a", "run-bad-b"]) {
      await openInFlight(ledgerRoot, runId, "x_elsewhere");
      const file = path.join(ledgerRoot, "runs", runId, "run.json");
      await fs.writeFile(file, "{not json");
      bad.push({ runId, file });
    }
    const before = await snapshot(ledgerRoot);

    const r = await tess([
      "run",
      "--skeleton",
      "--fake",
      "--ledger-root",
      ledgerRoot,
      "--run-id",
      "run-new",
    ]);

    assert.equal(r.code, 3, `${r.err}\n${r.out}`);
    assert.match(r.err, /^INFRASTRUCTURE FAULT \(DEV-1\): /m);
    for (const { runId, file } of bad) {
      assert.ok(r.err.includes(runId), `the fault must name ${runId}`);
      assert.ok(r.err.includes(file), `the fault must name ${file}`);
    }
    assert.match(r.err, /not valid JSON/);
    assert.match(
      r.err,
      /^ {2}remedy: .*inspect.*move .* out of the ledger root/m,
    );
    assert.deepEqual(
      await snapshot(ledgerRoot),
      before,
      "nothing may be quarantined, renamed or rewritten",
    );
  });

  it("tess status --run-id <healthy> still works beside a corrupt record", async () => {
    const ledgerRoot = await tempRoot();
    await openInFlight(ledgerRoot, "run-healthy");
    await openInFlight(ledgerRoot, "run-broken", "x_elsewhere");
    await fs.writeFile(
      path.join(ledgerRoot, "runs", "run-broken", "run.json"),
      "{not json",
    );

    const r = await tess([
      "status",
      "--ledger-root",
      ledgerRoot,
      "--run-id",
      "run-healthy",
    ]);

    assert.equal(r.code, 0, `${r.err}\n${r.out}`);
    assert.match(r.out, /run-healthy/);
    assert.match(r.out, /provisioning/);
  });
});
