// The instance BenchmarkSubstrate adapter (DESIGN §13.4 SUB-1..SUB-5), tested
// against the real @tessera/sn-client transport wired to @tessera/fake-instance
// — the same pattern @tessera/doctor's test suite uses (`withFake`): credentials
// flow through the environment because that is the only door `@tessera/sn-client`
// accepts them through, and every assertion here is about HTTP shape (a 403 is
// a refusal, a missing property is a void, a held lease is `null`), never about
// a real instance.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";
import { createSnInstanceProbe } from "@tessera/doctor";

import {
  BenchmarkSubstrateError,
  DEFAULT_LEASE_TABLE,
  DESIGN_GATE_POLICY,
  runBenchmark,
  assertBenchmarkTableApiPath,
  createInstanceBenchmarkSubstrate,
  createMemoryRestoreJournal,
  createSnBenchmarkClient,
  toSubstrateFault,
} from "../build/index.js";

/**
 * The live substrate as these suites use it: an in-memory restore journal and
 * an empty bound catalog (so capture is allowed; F4's catalog refusal is
 * covered in restore-journal.test.js). `runBenchmark` re-binds its own.
 */
function testSubstrate(options) {
  return createInstanceBenchmarkSubstrate({
    journal: createMemoryRestoreJournal(),
    catalog: { mutants: [], baselines: [] },
    ...options,
  });
}

const HOST = "dev-benchmark.service-now.com";
const SCRIPT_TABLE = "sys_script_include";
const ARTIFACT_SYS_ID = "fx-artifact-0001";

const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH",
  "SN_DOCS_DIR",
  "SN_READONLY",
  "SN_ACTIVE_PROFILE",
  "SN_ALLOWED_HOSTS",
  "SN_MAX_RETRIES",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
];

/** Seed a fake instance with a platform stamp and one scriptable artifact. */
function seed({
  platformVersion = "FIXTURE-build",
  platformProperty = "glide.buildname",
} = {}) {
  const state = {
    [SCRIPT_TABLE]: [{ sys_id: ARTIFACT_SYS_ID, script: "(x) => x + 1" }],
  };
  if (platformVersion !== null) {
    state.sys_properties = [{ name: platformProperty, value: platformVersion }];
  } else {
    state.sys_properties = [];
  }
  return state;
}

/** Wire the real transport at the fake and hand back a restorer (doctor's pattern). */
function withFake(options = {}) {
  const fake = createFakeInstance({ host: HOST, state: seed(options) });
  const restoreFetch = fake.install();

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SN_INSTANCE = HOST;
  process.env.SN_USER = "tessera";
  process.env.SN_PASSWORD = "tessera";
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(os.tmpdir(), "tessera-benchmark-docs");
  // One shot per probe/write: the transport retries idempotent GETs twice by
  // default, which would let a single-fire fault be papered over by the retry.
  process.env.SN_MAX_RETRIES = "0";
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  delete process.env.SN_TABLES_ALLOW;
  delete process.env.SN_TABLES_DENY;
  reloadCredentialsFromEnv();

  const client = createSnBenchmarkClient();
  const probe = createSnInstanceProbe();
  const substrate = testSubstrate({ client, probe });

  return {
    fake,
    client,
    probe,
    substrate,
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

/**
 * A bare in-memory Table API behind the `BenchmarkHttpClient` port. It
 * IGNORES `sysparm_query` on purpose — the worst case a transport can be —
 * so the adapter's client-side safety nets are what the tests exercise.
 * `hooks` inject one-shot faults: `getListFailsOn` (the nth list GET
 * rejects), `postNoSysId` (the row is created but the answer has no sys_id),
 * `deleteRejects` (every DELETE rejects).
 */
function memoryClient(tables, hooks = {}) {
  let n = 0;
  let listGets = 0;
  const client = {
    async request({ method, path: apiPath, body }) {
      const [, , , , table, id] = apiPath.split("/");
      const rows = (tables[table] ??= []);
      if (method === "GET" && id === undefined) {
        listGets += 1;
        if (listGets === hooks.getListFailsOn) throw new Error("boom GET");
        return { status: 200, data: { result: rows.map((r) => ({ ...r })) } };
      }
      if (method === "GET") {
        return {
          status: 200,
          data: { result: { ...rows.find((r) => r.sys_id === id) } },
        };
      }
      if (method === "POST") {
        n += 1;
        const row = { sys_id: `r${n}`, ...body };
        rows.push(row);
        return {
          status: 201,
          data: { result: hooks.postNoSysId ? {} : { ...row } },
        };
      }
      if (method === "PATCH") {
        Object.assign(
          rows.find((r) => r.sys_id === id),
          body,
        );
        return { status: 200, data: { result: {} } };
      }
      if (hooks.deleteRejects) throw new Error("boom DELETE");
      tables[table] = rows.filter((r) => r.sys_id !== id);
      return { status: 204, data: {} };
    },
  };
  return client;
}

const memoryProbe = {
  async readTable() {
    return { outcome: "readable", detail: "ok" };
  },
  async readProperty() {
    return { outcome: "found", value: "build-1", detail: "" };
  },
};

async function withFakeRun(options, run) {
  const h = withFake(options);
  try {
    await run(h);
  } finally {
    h.restore();
  }
}

// ── the Table-API-only guard ────────────────────────────────────────────────

describe("assertBenchmarkTableApiPath", () => {
  it("accepts a Table API path", () => {
    assert.doesNotThrow(() =>
      assertBenchmarkTableApiPath("/api/now/table/sys_properties"),
    );
  });

  it("refuses a non-Table-API path", () => {
    assert.throws(
      () => assertBenchmarkTableApiPath("/api/now/table_stats/sys_properties"),
      BenchmarkSubstrateError,
    );
  });

  it("refuses a path carrying an inline query string", () => {
    assert.throws(
      () =>
        assertBenchmarkTableApiPath(
          "/api/now/table/sys_properties?sysparm_limit=1",
        ),
      BenchmarkSubstrateError,
    );
  });
});

describe("toSubstrateFault", () => {
  it("is idempotent for its own error type", () => {
    const original = new BenchmarkSubstrateError("already ours");
    assert.equal(toSubstrateFault("ctx", original), original);
  });

  it("carries a numeric status through from the underlying error", () => {
    const fault = toSubstrateFault("ctx", { status: 403, message: "denied" });
    assert.equal(fault.status, 403);
    assert.match(fault.message, /ctx \(HTTP 403\) failed/);
  });

  it("omits status when the underlying error carries none", () => {
    const fault = toSubstrateFault("ctx", new Error("boom"));
    assert.equal(fault.status, undefined);
    assert.match(fault.message, /^ctx failed: Error: boom$/);
  });
});

// ── SUB-1 checkHealthy ───────────────────────────────────────────────────────

describe("createInstanceBenchmarkSubstrate — checkHealthy (SUB-1)", () => {
  it("is ok when sys_properties reads cleanly", async () => {
    await withFakeRun({}, async ({ substrate }) => {
      const result = await substrate.checkHealthy(new AbortController().signal);
      assert.equal(result.ok, true);
    });
  });

  it("is not ok when the instance answers with a refusal", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      fake.faults.add({
        match: { method: "GET", table: "sys_properties" },
        mode: { kind: "http-error", status: 403 },
      });
      const result = await substrate.checkHealthy(new AbortController().signal);
      assert.equal(result.ok, false);
    });
  });
});

// ── SUB-3 checkAttributionJoinPinned ────────────────────────────────────────

describe("createInstanceBenchmarkSubstrate — checkAttributionJoinPinned (SUB-3)", () => {
  it("is ok when the write-then-read round trip preserves the marker", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      const result = await substrate.checkAttributionJoinPinned(
        new AbortController().signal,
      );
      assert.equal(result.ok, true);
      // The probe cleans up after itself: no leftover lease-table row.
      assert.equal(fake.tables.all(DEFAULT_LEASE_TABLE).length, 0);
    });
  });

  it("is not ok when the read-back does not match what was written", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      fake.faults.add({
        match: { method: "GET", table: DEFAULT_LEASE_TABLE },
        mode: {
          kind: "http-error",
          status: 200,
          body: { result: { sys_id: "whatever", holder: "not-the-nonce" } },
        },
      });
      const result = await substrate.checkAttributionJoinPinned(
        new AbortController().signal,
      );
      assert.equal(result.ok, false);
      assert.match(result.detail, /join field not pinned/);
    });
  });

  it("is not ok when the probe row cannot be cleaned up", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      fake.faults.add({
        match: { method: "DELETE", table: DEFAULT_LEASE_TABLE },
        mode: { kind: "http-error", status: 500 },
      });
      const result = await substrate.checkAttributionJoinPinned(
        new AbortController().signal,
      );
      assert.equal(result.ok, false);
      assert.match(result.detail, /^join-probe row .* could not be cleaned up/);
    });
  });

  it("is not ok without touching the wire once the signal is aborted", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      const controller = new AbortController();
      controller.abort();
      const result = await substrate.checkAttributionJoinPinned(
        controller.signal,
      );
      assert.equal(result.ok, false);
      assert.equal(fake.requests().length, 0);
    });
  });
});

// ── SUB-2 acquireRunnerLease ─────────────────────────────────────────────────

describe("createInstanceBenchmarkSubstrate — acquireRunnerLease (SUB-2)", () => {
  it("acquires the lease and release() clears it", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      const lease = await substrate.acquireRunnerLease("run-1");
      assert.notEqual(lease, null);
      assert.equal(fake.tables.all(DEFAULT_LEASE_TABLE).length, 1);
      await lease.release();
      assert.equal(fake.tables.all(DEFAULT_LEASE_TABLE).length, 0);
    });
  });

  it("is null (fail-closed) when another run already holds the lease", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      fake.tables.insert(DEFAULT_LEASE_TABLE, { holder: "run-0" });
      const lease = await substrate.acquireRunnerLease("run-1");
      assert.equal(lease, null);
      // Fail-closed, no stale eviction: the other run's row is untouched.
      assert.equal(fake.tables.all(DEFAULT_LEASE_TABLE).length, 1);
    });
  });

  it("ignores a stray SUB-3 join-probe row (never a held lease)", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      fake.tables.insert(DEFAULT_LEASE_TABLE, {
        holder: "join-probe:00000000-0000-0000-0000-000000000000",
      });
      const lease = await substrate.acquireRunnerLease("run-1");
      assert.notEqual(lease, null);
      await lease.release();
      assert.equal(fake.tables.all(DEFAULT_LEASE_TABLE).length, 1);
    });
  });

  it("ignores join-probe rows client-side too, even behind a query-blind transport", async () => {
    const tables = {
      [DEFAULT_LEASE_TABLE]: [{ sys_id: "p1", holder: "join-probe:x" }],
    };
    const substrate = testSubstrate({
      client: memoryClient(tables),
      probe: memoryProbe,
    });
    const lease = await substrate.acquireRunnerLease("run-1");
    assert.notEqual(lease, null);
    // …but a real holder behind a probe row is still seen (no limit=1).
    const other = testSubstrate({
      client: memoryClient(tables),
      probe: memoryProbe,
    });
    assert.equal(await other.acquireRunnerLease("run-2"), null);
  });

  it("asks the instance for every row except join probes, holder-less rows included", async () => {
    const tables = { [DEFAULT_LEASE_TABLE]: [] };
    const inner = memoryClient(tables);
    const queries = [];
    const client = {
      async request(req) {
        if (req.method === "GET" && req.path.endsWith(DEFAULT_LEASE_TABLE)) {
          queries.push(req.params?.get("sysparm_query"));
        }
        return inner.request(req);
      },
    };
    const substrate = testSubstrate({
      client,
      probe: memoryProbe,
    });
    const lease = await substrate.acquireRunnerLease("run-1");
    await lease.release();
    assert.deepEqual(queries, [
      "holderNOT LIKEjoin-probe:^ORholderISEMPTY",
      "holderNOT LIKEjoin-probe:^ORholderISEMPTY",
    ]);
  });

  it("still treats a holder-less row as held (fail-closed)", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      fake.tables.insert(DEFAULT_LEASE_TABLE, { holder: "" });
      assert.equal(await substrate.acquireRunnerLease("run-1"), null);
    });
  });

  it("deletes its row when the post-insert race check rejects", async () => {
    const tables = { [DEFAULT_LEASE_TABLE]: [] };
    const substrate = testSubstrate({
      client: memoryClient(tables, { getListFailsOn: 2 }),
      probe: memoryProbe,
    });
    await assert.rejects(
      () => substrate.acquireRunnerLease("run-1"),
      /runner-lease race check failed: Error: boom GET/,
    );
    assert.deepEqual(tables[DEFAULT_LEASE_TABLE], []);
  });

  it("finds and deletes a row the server created but answered without a sys_id", async () => {
    const tables = {
      [DEFAULT_LEASE_TABLE]: [{ sys_id: "keep", holder: "join-probe:y" }],
    };
    const substrate = testSubstrate({
      client: memoryClient(tables, { postNoSysId: true }),
      probe: memoryProbe,
    });
    await assert.rejects(
      () => substrate.acquireRunnerLease("run-1"),
      /returned no sys_id/,
    );
    // Only this run's row is removed; nothing else is touched.
    assert.deepEqual(tables[DEFAULT_LEASE_TABLE], [
      { sys_id: "keep", holder: "join-probe:y" },
    ]);
  });

  it("deletes a row a crashed insert applied (fake-instance crash-after-write)", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      fake.faults.add({
        match: { method: "POST", table: DEFAULT_LEASE_TABLE, times: 1 },
        mode: { kind: "crash-after-write", status: 500 },
      });
      await assert.rejects(
        () => substrate.acquireRunnerLease("run-1"),
        BenchmarkSubstrateError,
      );
      assert.equal(fake.tables.all(DEFAULT_LEASE_TABLE).length, 0);
    });
  });

  it("says a lease row may be left behind when the cleanup also fails", async () => {
    const tables = { [DEFAULT_LEASE_TABLE]: [] };
    const substrate = testSubstrate({
      client: memoryClient(tables, { getListFailsOn: 2, deleteRejects: true }),
      probe: memoryProbe,
    });
    await assert.rejects(
      () => substrate.acquireRunnerLease("run-1"),
      (error) =>
        error instanceof BenchmarkSubstrateError &&
        /boom GET; lease-row cleanup also failed \(a lease row may be left behind\)/.test(
          error.message,
        ),
    );
  });

  it("refuses (throws) rather than silently acquiring under SN_READONLY", async () => {
    await withFakeRun({}, async ({ substrate }) => {
      process.env.SN_READONLY = "1";
      reloadCredentialsFromEnv();
      await assert.rejects(
        () => substrate.acquireRunnerLease("run-1"),
        BenchmarkSubstrateError,
      );
    });
  });
});

// ── platform stamp ───────────────────────────────────────────────────────────

describe("createInstanceBenchmarkSubstrate — platformVersion", () => {
  it("reads glide.buildname when present", async () => {
    await withFakeRun(
      { platformProperty: "glide.buildname", platformVersion: "orlando-08-12" },
      async ({ substrate }) => {
        assert.equal(await substrate.platformVersion(), "orlando-08-12");
      },
    );
  });

  it("falls back to glide.war when glide.buildname is absent", async () => {
    await withFakeRun(
      { platformProperty: "glide.war", platformVersion: "glide-orlando-08-12" },
      async ({ substrate }) => {
        assert.equal(await substrate.platformVersion(), "glide-orlando-08-12");
      },
    );
  });

  it("refuses (throws) rather than guessing when neither property is readable", async () => {
    await withFakeRun({ platformVersion: null }, async ({ substrate }) => {
      await assert.rejects(
        () => substrate.platformVersion(),
        BenchmarkSubstrateError,
      );
    });
  });
});

// ── applySource / resetScope ─────────────────────────────────────────────────

describe("createInstanceBenchmarkSubstrate — applySource / resetScope (SUB-5)", () => {
  const target = {
    table: SCRIPT_TABLE,
    sysId: ARTIFACT_SYS_ID,
    name: "fixture",
  };

  it("captures the live source on first touch, then restores it on resetScope", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      // First touch of "correct" captures whatever is live right now.
      await substrate.applySource(target, "behaviour", { kind: "correct" });
      assert.equal(
        fake.tables.get(SCRIPT_TABLE, ARTIFACT_SYS_ID).script,
        "(x) => x + 1",
      );

      // Apply a mutant: the live text changes.
      await substrate.applySource(target, "behaviour", {
        kind: "mutant",
        id: "m1",
        diff: "replace:(x) => x - 1",
      });
      assert.equal(
        fake.tables.get(SCRIPT_TABLE, ARTIFACT_SYS_ID).script,
        "(x) => x - 1",
      );

      // resetScope restores the captured-on-first-touch correct source.
      await substrate.resetScope("run-1");
      assert.equal(
        fake.tables.get(SCRIPT_TABLE, ARTIFACT_SYS_ID).script,
        "(x) => x + 1",
      );
    });
  });

  it("captures the live source even when the FIRST touch is a non-correct variant", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      await substrate.applySource(target, "behaviour", {
        kind: "mutant",
        id: "m1",
        diff: "replace:(x) => x - 1",
      });
      assert.equal(
        fake.tables.get(SCRIPT_TABLE, ARTIFACT_SYS_ID).script,
        "(x) => x - 1",
      );

      // resetScope must know the artifact and restore the pre-touch source.
      await substrate.resetScope("run-1");
      assert.equal(
        fake.tables.get(SCRIPT_TABLE, ARTIFACT_SYS_ID).script,
        "(x) => x + 1",
      );
    });
  });

  it("resetScope is a no-op when nothing has been touched yet", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      await substrate.resetScope("run-1");
      assert.equal(fake.requests().length, 0);
    });
  });

  it("refuses (throws) a write under SN_READONLY rather than silently skipping it", async () => {
    await withFakeRun({}, async ({ substrate }) => {
      process.env.SN_READONLY = "1";
      reloadCredentialsFromEnv();
      await assert.rejects(
        () => substrate.applySource(target, "behaviour", { kind: "correct" }),
        BenchmarkSubstrateError,
      );
    });
  });
});

// ── smokeBaseline ─────────────────────────────────────────────────────────

describe("createInstanceBenchmarkSubstrate — smokeBaseline", () => {
  const baseline = {
    id: "b1",
    artifact: { table: SCRIPT_TABLE, sysId: ARTIFACT_SYS_ID, name: "fixture" },
    behaviour: "behaviour",
    detonator: {
      diff: "replace:(x) => x - 1",
      signOff: { by: "x", at: "2026-01-01" },
    },
    signOff: { by: "x", at: "2026-01-01" },
    detonatorSha256: "irrelevant-for-this-test",
  };

  it("is green when the live source is not sitting in its detonator's broken state", async () => {
    await withFakeRun({}, async ({ substrate }) => {
      assert.equal(await substrate.smokeBaseline(baseline, "run-1"), "green");
    });
  });

  it("is red when the live source equals the detonator's own replacement text", async () => {
    await withFakeRun({}, async ({ substrate, fake }) => {
      fake.tables.update(SCRIPT_TABLE, ARTIFACT_SYS_ID, {
        script: "(x) => x - 1",
      });
      assert.equal(await substrate.smokeBaseline(baseline, "run-1"), "red");
    });
  });
});

// ── end to end: runBenchmark over the instance adapter ─────────────────────

describe("runBenchmark over the instance adapter — final restore (decision #21)", () => {
  const signOff = { by: "QA", at: "2026-09-01" };
  const catalog = {
    catalogVersion: "memory v1",
    fixture: true,
    mutantSetHash: "h",
    mutants: [
      {
        id: "m1",
        category: "script-include",
        baseArtifact: { table: SCRIPT_TABLE, sysId: "si1", name: "a" },
        behaviour: "b",
        diff: "replace:MUTANT1",
        expectedVerdict: "red",
        signOff,
        diffSha256: "x",
      },
    ],
    baselines: [
      {
        id: "b1",
        artifact: { table: SCRIPT_TABLE, sysId: "si2", name: "c" },
        behaviour: "b",
        detonator: { diff: "replace:BROKEN2", signOff },
        signOff,
        detonatorSha256: "y",
      },
    ],
  };
  const genConfig = {
    modelId: "m-2026",
    temperature: 0,
    maxTokens: 10,
    promptHash: "a".repeat(64),
    promptVersion: "1",
  };

  function world() {
    const tables = {
      [SCRIPT_TABLE]: [
        { sys_id: "si1", script: "CORRECT1" },
        { sys_id: "si2", script: "CORRECT2" },
      ],
      [DEFAULT_LEASE_TABLE]: [],
    };
    const client = memoryClient(tables);
    const live = (id) =>
      tables[SCRIPT_TABLE].find((r) => r.sys_id === id).script;
    let failMutantRuns = false;
    const pipeline = {
      kind: "unit",
      impact: {
        async analyze(_ctx, artifacts) {
          return {
            nodes: artifacts.map((a) => a.ref),
            edges: [],
            unanalyzable: [],
            demanded: [],
          };
        },
      },
      generator: {
        async generate(_ctx, graph) {
          return graph.nodes.map((node) => ({
            ref: { id: node.sysId, path: "p" },
            payload: { sysId: node.sysId, expected: live(node.sysId) },
          }));
        },
      },
      store: {
        async project() {
          return {};
        },
        async teardown() {},
      },
      runner: {
        async run(ctx, specs) {
          if (failMutantRuns && ctx.runId.endsWith(":mutant")) {
            throw new Error("runner offline");
          }
          return {
            runId: ctx.runId,
            outcomes: specs.map((spec) => ({
              spec: spec.ref,
              raw:
                live(spec.payload.sysId) === spec.payload.expected
                  ? "pass"
                  : "fail",
            })),
          };
        },
      },
    };
    const go = (runId) =>
      runBenchmark({
        runId,
        catalog,
        genConfig,
        policy: DESIGN_GATE_POLICY,
        repetitions: 3,
        // A fresh adapter per run, as the CLI constructs one.
        substrate: testSubstrate({
          client,
          probe: memoryProbe,
        }),
        pipeline,
      });
    return {
      tables,
      live,
      go,
      failMutants: (on) => {
        failMutantRuns = on;
      },
    };
  }

  it("a mid-mutant void restores the source, so the next run still catches", async () => {
    const w = world();
    w.failMutants(true);
    const a = await w.go("runA");
    assert.deepEqual(
      a.result.reasons.map((r) => r.code),
      ["inconclusive-run"],
    );
    assert.equal(w.live("si1"), "CORRECT1");
    w.failMutants(false);
    const b = await w.go("runB");
    assert.deepEqual(b.mutants, [
      {
        id: "m1",
        category: "script-include",
        caughtPerRep: [true, true, true],
      },
    ]);
    assert.deepEqual(w.tables[DEFAULT_LEASE_TABLE], []);
  });

  it("a clean run leaves no detonator live, so the next run is not drift-voided", async () => {
    const w = world();
    const first = await w.go("run1");
    assert.equal(first.result.status === "void", false);
    assert.equal(w.live("si2"), "CORRECT2");
    const second = await w.go("run2");
    assert.equal(
      second.result.reasons.some((r) => r.code === "drift-smoke-red"),
      false,
    );
    assert.equal(second.mutants.length, 1);
  });
});

// ── review-w4b F1: a script field that cannot be read is never "" ──────────

/**
 * A port that answers every single-record GET with `record` (verbatim, so a
 * test can hand back an absent, inherited or non-string field) and logs every
 * call, so a test can prove no PATCH ever reached the wire.
 */
function recordClient(record) {
  const calls = [];
  const client = {
    async request(req) {
      calls.push(req);
      if (req.method === "GET")
        return { status: 200, data: { result: record } };
      return { status: 200, data: { result: {} } };
    },
  };
  return { client, calls };
}

describe("createInstanceBenchmarkSubstrate — strict script-field read (review-w4b F1)", () => {
  const target = { table: SCRIPT_TABLE, sysId: "abc", name: "fixture" };
  const baseline = {
    id: "b1",
    artifact: target,
    behaviour: "b",
    detonator: { diff: "replace:broken()", signOff: { by: "x", at: "x" } },
    signOff: { by: "x", at: "x" },
    detonatorSha256: "x",
  };
  // [label, record, the refusal the strict read must name]
  const ABSENT = /answered without the "script" field/;
  const NOT_STRING = /field "script" is not a string/;
  const unreadable = [
    ["absent", { sys_id: "abc" }, ABSENT],
    ["inherited", Object.create({ script: "live()" }), ABSENT],
    ["null", { sys_id: "abc", script: null }, NOT_STRING],
    ["a number", { sys_id: "abc", script: 5 }, NOT_STRING],
    ["a reference with no value", { sys_id: "abc", script: {} }, NOT_STRING],
    [
      "a reference with an inherited value",
      { sys_id: "abc", script: Object.create({ value: "live()" }) },
      NOT_STRING,
    ],
    [
      "a reference with a non-string value",
      { script: { value: 7 } },
      NOT_STRING,
    ],
  ];

  for (const [label, record, refusal] of unreadable) {
    it(`capture refuses when the field is ${label}, and never PATCHes`, async () => {
      const { client, calls } = recordClient(record);
      const substrate = testSubstrate({
        client,
        probe: memoryProbe,
      });
      await assert.rejects(
        () => substrate.applySource(target, "b", { kind: "correct" }),
        (error) =>
          error instanceof BenchmarkSubstrateError &&
          refusal.test(error.message),
      );
      await substrate.resetScope("run-1");
      assert.deepEqual(
        calls.filter((c) => c.method !== "GET"),
        [],
      );
    });

    it(`smokeBaseline is never green when the field is ${label}`, async () => {
      const { client } = recordClient(record);
      const substrate = testSubstrate({
        client,
        probe: memoryProbe,
      });
      await assert.rejects(
        () => substrate.smokeBaseline(baseline, "run-1"),
        (error) =>
          error instanceof BenchmarkSubstrateError &&
          refusal.test(error.message),
      );
    });
  }

  it("capture refuses when the result itself is missing", async () => {
    const calls = [];
    const substrate = testSubstrate({
      client: {
        async request(req) {
          calls.push(req);
          return { status: 200, data: {} };
        },
      },
      probe: memoryProbe,
    });
    await assert.rejects(
      () => substrate.applySource(target, "b", { kind: "correct" }),
      BenchmarkSubstrateError,
    );
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET"],
    );
  });

  for (const blank of ["", "   \n\t "]) {
    it(`capture refuses a blank correct source (${JSON.stringify(blank)})`, async () => {
      const { client, calls } = recordClient({ sys_id: "abc", script: blank });
      const substrate = testSubstrate({
        client,
        probe: memoryProbe,
      });
      await assert.rejects(
        () => substrate.applySource(target, "b", { kind: "correct" }),
        (error) =>
          error instanceof BenchmarkSubstrateError &&
          /blank/.test(error.message),
      );
      // Not cached either, and a later variant also refuses (it captures
      // first), so nothing — neither the variant nor "" — is ever written.
      await assert.rejects(
        () =>
          substrate.applySource(target, "b", {
            kind: "variant",
            diff: "replace:broken()",
          }),
        BenchmarkSubstrateError,
      );
      await substrate.resetScope("run-1");
      assert.deepEqual(
        calls.filter((c) => c.method === "PATCH").map((c) => c.body),
        [],
      );
    });

    it(`smokeBaseline is never green on a blank live source (${JSON.stringify(blank)})`, async () => {
      const { client } = recordClient({ sys_id: "abc", script: blank });
      const substrate = testSubstrate({
        client,
        probe: memoryProbe,
      });
      await assert.rejects(
        () => substrate.smokeBaseline(baseline, "run-1"),
        BenchmarkSubstrateError,
      );
    });
  }

  it("still unwraps an own {value} reference and restores it verbatim", async () => {
    const { client, calls } = recordClient({ script: { value: "live()" } });
    const substrate = testSubstrate({
      client,
      probe: memoryProbe,
    });
    await substrate.applySource(target, "b", { kind: "correct" });
    await substrate.resetScope("run-1");
    assert.deepEqual(
      calls.filter((c) => c.method === "PATCH").map((c) => c.body),
      [{ script: "live()" }, { script: "live()" }],
    );
    assert.equal(await substrate.smokeBaseline(baseline, "run-1"), "green");
  });

  it("runBenchmark voids (never scores) when the baseline script is unreadable", async () => {
    const { client, calls } = recordClient({ sys_id: "abc" });
    const substrate = testSubstrate({
      client: {
        async request(req) {
          // Lease/probe traffic goes to a working in-memory table.
          if (req.path.includes(DEFAULT_LEASE_TABLE))
            return leaseSide.request(req);
          return client.request(req);
        },
      },
      probe: memoryProbe,
    });
    const leaseSide = memoryClient({ [DEFAULT_LEASE_TABLE]: [] });
    const record = await runBenchmark({
      runId: "run-f1",
      catalog: {
        catalogVersion: "v",
        fixture: true,
        mutantSetHash: "h",
        mutants: [],
        baselines: [baseline],
      },
      genConfig: {
        modelId: "m",
        temperature: 0,
        maxTokens: 1,
        promptHash: "a".repeat(64),
        promptVersion: "1",
      },
      policy: DESIGN_GATE_POLICY,
      repetitions: 3,
      substrate,
      pipeline: {
        kind: "unit",
        impact: {
          async analyze() {
            return { nodes: [], edges: [], unanalyzable: [], demanded: [] };
          },
        },
        generator: {
          async generate() {
            return [];
          },
        },
        store: {
          async project() {
            return {};
          },
          async teardown() {},
        },
        runner: {
          async run(ctx) {
            return { runId: ctx.runId, outcomes: [] };
          },
        },
      },
    });
    assert.equal(record.result.status, "void");
    assert.deepEqual(
      record.result.reasons.map((r) => r.code),
      ["drift-smoke-red"],
    );
    assert.deepEqual(
      calls.filter((c) => c.method === "PATCH"),
      [],
    );
  });
});

// ── review-w4b F2: the lease never fails open on an unverifiable re-read ────

/**
 * A lease-table port whose list GETs answer from `listAnswer(n)` (n = 1-based
 * list-GET count) while POST/DELETE hit a real in-memory table, so a test
 * controls exactly what the post-insert re-read "sees".
 */
function leaseClient(listAnswer) {
  const tables = { [DEFAULT_LEASE_TABLE]: [] };
  const inner = memoryClient(tables);
  let listGets = 0;
  const client = {
    async request(req) {
      if (req.method === "GET" && req.path.endsWith(DEFAULT_LEASE_TABLE)) {
        listGets += 1;
        const answer = listAnswer(listGets, tables[DEFAULT_LEASE_TABLE]);
        if (answer !== undefined) return answer;
      }
      return inner.request(req);
    },
  };
  return { client, tables };
}

describe("createInstanceBenchmarkSubstrate — lease re-read must see our row (review-w4b F2)", () => {
  it("two runners behind a row-hiding ACL: neither acquires, both rows are removed", async () => {
    const tables = { [DEFAULT_LEASE_TABLE]: [] };
    const inner = memoryClient(tables);
    const client = {
      async request(req) {
        if (req.method === "GET") return { status: 200, data: { result: [] } };
        return inner.request(req);
      },
    };
    const a = testSubstrate({ client, probe: memoryProbe });
    const b = testSubstrate({ client, probe: memoryProbe });
    await assert.rejects(
      () => a.acquireRunnerLease("run-a"),
      BenchmarkSubstrateError,
    );
    await assert.rejects(
      () => b.acquireRunnerLease("run-b"),
      BenchmarkSubstrateError,
    );
    assert.deepEqual(tables[DEFAULT_LEASE_TABLE], []);
  });

  it("refuses when the re-read shows one row that is not ours", async () => {
    const { client, tables } = leaseClient((n) =>
      n === 2
        ? {
            status: 200,
            data: { result: [{ sys_id: "other", holder: "run-x" }] },
          }
        : undefined,
    );
    const substrate = testSubstrate({
      client,
      probe: memoryProbe,
    });
    await assert.rejects(
      () => substrate.acquireRunnerLease("run-1"),
      (error) =>
        error instanceof BenchmarkSubstrateError &&
        /could not verify/.test(error.message),
    );
    assert.deepEqual(tables[DEFAULT_LEASE_TABLE], []);
  });

  it("refuses when the re-read shows our holder on a row that is not ours", async () => {
    const { client, tables } = leaseClient((n) =>
      n === 2
        ? {
            status: 200,
            data: { result: [{ sys_id: "ghost", holder: "run-1" }] },
          }
        : undefined,
    );
    const substrate = testSubstrate({
      client,
      probe: memoryProbe,
    });
    await assert.rejects(
      () => substrate.acquireRunnerLease("run-1"),
      BenchmarkSubstrateError,
    );
    assert.deepEqual(tables[DEFAULT_LEASE_TABLE], []);
  });

  it("refuses when our row reads back under a different holder", async () => {
    const { client, tables } = leaseClient((n, rows) =>
      n === 2
        ? {
            status: 200,
            data: { result: rows.map((r) => ({ ...r, holder: "rewritten" })) },
          }
        : undefined,
    );
    const substrate = testSubstrate({
      client,
      probe: memoryProbe,
    });
    await assert.rejects(
      () => substrate.acquireRunnerLease("run-1"),
      BenchmarkSubstrateError,
    );
    assert.deepEqual(tables[DEFAULT_LEASE_TABLE], []);
  });

  it("refuses when our row reads back with no holder at all", async () => {
    const { client, tables } = leaseClient((n, rows) =>
      n === 2
        ? {
            status: 200,
            data: { result: rows.map((r) => ({ sys_id: r.sys_id })) },
          }
        : undefined,
    );
    const substrate = testSubstrate({
      client,
      probe: memoryProbe,
    });
    await assert.rejects(
      () => substrate.acquireRunnerLease("run-1"),
      BenchmarkSubstrateError,
    );
    assert.deepEqual(tables[DEFAULT_LEASE_TABLE], []);
  });

  it("names a left-behind row when the fail-closed delete also fails", async () => {
    const tables = { [DEFAULT_LEASE_TABLE]: [] };
    const inner = memoryClient(tables, { deleteRejects: true });
    const client = {
      async request(req) {
        if (req.method === "GET") return { status: 200, data: { result: [] } };
        return inner.request(req);
      },
    };
    const substrate = testSubstrate({
      client,
      probe: memoryProbe,
    });
    await assert.rejects(
      () => substrate.acquireRunnerLease("run-1"),
      /a lease row may be left behind/,
    );
  });

  it("still backs off (null) on genuine contention: our row plus another", async () => {
    const { client, tables } = leaseClient((n, rows) =>
      n === 2
        ? {
            status: 200,
            data: {
              result: [{ sys_id: "other", holder: "run-x" }, ...rows],
            },
          }
        : undefined,
    );
    const substrate = testSubstrate({
      client,
      probe: memoryProbe,
    });
    assert.equal(await substrate.acquireRunnerLease("run-1"), null);
    assert.deepEqual(tables[DEFAULT_LEASE_TABLE], []);
  });

  for (const [label, data] of [
    ["missing", {}],
    ["an object", { result: {} }],
    ["null", { result: null }],
  ]) {
    it(`a list whose result is ${label} is a fault, never an empty table`, async () => {
      const { client, tables } = leaseClient(() => ({ status: 200, data }));
      const substrate = testSubstrate({
        client,
        probe: memoryProbe,
      });
      await assert.rejects(
        () => substrate.acquireRunnerLease("run-1"),
        (error) =>
          error instanceof BenchmarkSubstrateError &&
          /result/.test(error.message),
      );
      // Refused at the first check: nothing was ever inserted.
      assert.deepEqual(tables[DEFAULT_LEASE_TABLE], []);
    });
  }

  it("a valid empty result still acquires (result: [])", async () => {
    const { client, tables } = leaseClient(() => undefined);
    const substrate = testSubstrate({
      client,
      probe: memoryProbe,
    });
    const lease = await substrate.acquireRunnerLease("run-1");
    assert.notEqual(lease, null);
    assert.equal(tables[DEFAULT_LEASE_TABLE].length, 1);
    await lease.release();
    assert.deepEqual(tables[DEFAULT_LEASE_TABLE], []);
  });

  it("runBenchmark voids when the lease re-read cannot see our row", async () => {
    const tables = { [DEFAULT_LEASE_TABLE]: [] };
    const inner = memoryClient(tables);
    const substrate = testSubstrate({
      client: {
        async request(req) {
          if (req.method === "GET" && req.path.endsWith(DEFAULT_LEASE_TABLE)) {
            return { status: 200, data: { result: [] } };
          }
          return inner.request(req);
        },
      },
      probe: memoryProbe,
    });
    const record = await runBenchmark({
      runId: "run-f2",
      catalog: {
        catalogVersion: "v",
        fixture: true,
        mutantSetHash: "h",
        mutants: [],
        baselines: [],
      },
      genConfig: {
        modelId: "m",
        temperature: 0,
        maxTokens: 1,
        promptHash: "a".repeat(64),
        promptVersion: "1",
      },
      policy: DESIGN_GATE_POLICY,
      repetitions: 3,
      substrate,
      pipeline: {
        kind: "unit",
        impact: {
          async analyze() {
            return { nodes: [], edges: [], unanalyzable: [], demanded: [] };
          },
        },
        generator: {
          async generate() {
            return [];
          },
        },
        store: {
          async project() {
            return {};
          },
          async teardown() {},
        },
        runner: {
          async run(ctx) {
            return { runId: ctx.runId, outcomes: [] };
          },
        },
      },
    });
    assert.equal(record.result.status, "void");
    assert.deepEqual(
      record.result.reasons.map((r) => r.code),
      ["runner-lease-held"],
    );
    assert.match(record.result.reasons[0].detail, /lease acquisition rejected/);
  });
});
