// The run loop (DESIGN §4b + §6/§6a) end to end. These tests drive the REAL
// TargetGuard, the REAL intent ledger against a temp directory on disk and the
// REAL gate — only the instance-facing ports are fakes, because the write-ahead
// ordering, the state machine and the ARCH-24 flush boundary are precisely what
// is under test. Nothing here reads the wall clock: `deps.now` is injected.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTargetGuard } from "@tessera/guard";
import { createIntentLedger } from "@tessera/ledger";

import {
  RunConcurrencyRefusedError,
  createGateEvaluator,
  runPipeline,
  specKey,
} from "../build/index.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** Allowlisted AND non-prod by the §11.2 name heuristic → the clean write path. */
const SUB_PROD_HOST = "dev12345.service-now.com";
/** Declared prod: `assertRunnerWritable` refuses it, no override lifts it. */
const PROD_HOST = "prod01.service-now.com";

/** Injected clock — deterministic ledger stamps and token timestamps. */
const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");

/** A stalled runner must never be able to pin the test process. */
const STALL_GUARD_MS = 5000;

/**
 * DEV-2 deadline for the poll-timeout test. It must be comfortably longer than
 * the loop's own pre-`running` half (openRun + three transitions + intend +
 * confirm, every one of them fsynced), or the deadline would fire on the wrong
 * edge. The test asserts `running` was actually reached, so a machine slow
 * enough to break that assumption fails loudly instead of passing by accident.
 */
const DEADLINE_MS = 1000;

const ARTIFACT = {
  table: "sys_script",
  sysId: "a1",
  name: "BR: order validation",
};
const EXTRA_ARTIFACT = {
  table: "sys_script",
  sysId: "a2",
  name: "BR: order pricing",
};

const SPEC = {
  ref: { id: "spec-order", path: "tests/order.test.ts" },
  kind: "unit",
  targets: [ARTIFACT],
};
const SPEC_KEY = specKey(SPEC.ref);

/** The PlannedSpec the impact analysis would demand for `SPEC`. */
const DEMANDED_SPEC = { spec: SPEC.ref, kind: SPEC.kind, target: ARTIFACT };
/** Demanded by the analysis, produced by nobody (ARCH-30). */
const DEMANDED_ONLY = {
  spec: { id: "spec-pricing", path: "tests/pricing.test.ts" },
  kind: "unit",
  target: EXTRA_ARTIFACT,
};

const HAPPY_PATH = [
  "planned",
  "provisioning",
  "projecting",
  "running",
  "collecting",
  "tearing-down",
  "done",
];

// ── harness ─────────────────────────────────────────────────────────────────

const tempRoots = [];

async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-core-"));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function passingRunner(calls, hooks) {
  return {
    kinds: ["unit"],
    supports: () => true,
    async run(ctx, specs, emit) {
      calls.run += 1;
      if (hooks.onRun) await hooks.onRun(ctx, specs, emit);
      const outcomes = [];
      for (const spec of specs) {
        emit({ kind: "start", runId: ctx.runId, spec: spec.ref });
        const raw = hooks.raw ? hooks.raw(spec) : "pass";
        outcomes.push({
          spec: spec.ref,
          raw,
          evidence: { kind: "log", ref: `${ctx.runId}/${spec.ref.id}.log` },
        });
      }
      return { runId: ctx.runId, outcomes };
    },
  };
}

/** Never reaches a terminal state on its own — only an interruption ends it. */
function stallingRunner(calls, hooks) {
  return {
    kinds: ["unit"],
    supports: () => true,
    run(ctx, specs, emit) {
      calls.run += 1;
      return new Promise((resolve, reject) => {
        const guardTimer = setTimeout(() => {
          reject(
            new Error(
              "stalling runner was never interrupted — the loop failed to bound the wait",
            ),
          );
        }, STALL_GUARD_MS);
        const stop = () => {
          clearTimeout(guardTimer);
          reject(new Error("runner interrupted"));
        };
        if (ctx.signal.aborted) stop();
        else ctx.signal.addEventListener("abort", stop, { once: true });
        if (hooks.onRun) {
          Promise.resolve(hooks.onRun(ctx, specs, emit)).catch(reject);
        }
      });
    },
  };
}

/** DEV-1: an adapter that cannot talk to the instance REJECTS. */
function faultingRunner(calls, message) {
  return {
    kinds: ["unit"],
    supports: () => true,
    async run() {
      calls.run += 1;
      throw new Error(message);
    },
  };
}

function traceReporter(trace, calls, hooks) {
  return {
    onEvent(event) {
      trace.push({ at: "event", kind: event.kind, event });
      if (hooks.onEvent) hooks.onEvent(event);
    },
    async close(runId) {
      calls.close += 1;
      trace.push({ at: "close", runId });
      if (hooks.onClose) await hooks.onClose(runId);
    },
  };
}

/**
 * One composed run loop: real guard, real ledger on a real temp dir, real gate.
 * Tests tweak behaviour through the mutable `hooks` bag (so the ports stay
 * wired) or by swapping an entry of `ports` outright.
 */
async function scaffold(config = {}) {
  const rootDir = await tempRoot();
  const ledger = createIntentLedger({ rootDir, now: FIXED_NOW });
  const guard = createTargetGuard({
    nonProdAllowlist: [SUB_PROD_HOST],
    prodInstances: [PROD_HOST],
  });
  const host = config.host ?? SUB_PROD_HOST;
  // The guard refuses hand-built classifications, so the pinned object it
  // returns here is the only thing the loop will accept (§11.1).
  const runner = await guard.classify(
    { name: "runner-instance", host },
    "runner",
  );

  const trace = [];
  const calls = { resolve: 0, project: 0, run: 0, teardown: 0, close: 0 };
  const hooks = {};
  const scope = config.scope ?? "x_acme_orders";

  const ports = {
    resolver: {
      async resolve() {
        calls.resolve += 1;
        return [{ ref: ARTIFACT, resolvedBy: "scope" }];
      },
    },
    store: {
      async project(ctx, specs) {
        calls.project += 1;
        if (hooks.onProject) await hooks.onProject(ctx, specs);
        const projection = {};
        for (const spec of specs) {
          projection[specKey(spec.ref)] = {
            testSysId: `test-${spec.ref.id}`,
            suiteSysId: "suite-1",
            runId: ctx.runId,
          };
        }
        return projection;
      },
      async teardown(ctx) {
        calls.teardown += 1;
        if (hooks.onTeardown) await hooks.onTeardown(ctx);
      },
    },
    runners: [passingRunner(calls, hooks)],
    reporters: [traceReporter(trace, calls, hooks)],
    provisioner: {
      async plan() {
        return { actions: [] };
      },
      async apply() {},
    },
    gate: createGateEvaluator(),
  };

  const runOptions = {
    runId: config.runId ?? "run-1",
    scope,
    topology: {
      source: "src12345.service-now.com",
      runner: host,
      target: "tgt12345.service-now.com",
    },
    lifecycle: config.lifecycle ?? "ephemeral",
    input: { scope },
    specs: config.specs ?? [SPEC],
  };

  return {
    rootDir,
    ledger,
    guard,
    trace,
    calls,
    hooks,
    ports,
    deps: { guard, ledger, runner, now: FIXED_NOW, ports },
    runOptions,
  };
}

const endEvents = (trace) =>
  trace.filter((entry) => entry.at === "event" && entry.kind === "end");

// ── 1. happy path ───────────────────────────────────────────────────────────

describe("runPipeline — green run (§4b happy path)", () => {
  it("walks the state machine, lands GO and reports what it emitted", async () => {
    const s = await scaffold({ runId: "run-green" });

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.state,
      "done",
      "a fully green run must land in the §4b terminal state `done`",
    );
    assert.deepEqual(
      [...report.transitions],
      HAPPY_PATH,
      "the §4b path must be walked edge by edge, in order",
    );
    assert.equal(
      report.verdict.status,
      "GO",
      "one passing spec covering the only impacted artifact is a GO",
    );
    assert.ok(
      report.verdict.confirmToken,
      "a GO must mint a ConfirmToken (§6a/A-1)",
    );
    assert.equal(
      report.teardown,
      "completed",
      "an ephemeral run must tear its projection down (§4a)",
    );
    assert.equal(
      report.failure,
      undefined,
      "a green run records no stage failure",
    );

    const ends = endEvents(s.trace);
    assert.equal(ends.length, 1, "core owes the caller one terminal `end`");
    assert.deepEqual(
      report.result,
      ends[0].event.result,
      "report.result must BE the payload of the terminal `end` event (ARCH-24)",
    );
    assert.equal(
      report.result.outcomes.length,
      1,
      "the one planned spec must produce exactly one outcome row",
    );
    assert.equal(
      report.result.outcomes[0].raw,
      "pass",
      "the runner's raw outcome must survive folding untouched",
    );

    const run = await s.ledger.readRun("run-green");
    assert.equal(
      run.state,
      "done",
      "the durable run record must agree with the in-memory report (§4b)",
    );
    const entries = await s.ledger.entries("run-green");
    assert.equal(
      entries.length,
      2,
      "one projection intent + one run-trigger intent were journalled",
    );
    assert.ok(
      entries.every((entry) => entry.state === "compensated"),
      `every ledger entry must be settled after a completed teardown, got ${JSON.stringify(
        entries.map((entry) => entry.state),
      )}`,
    );
  });
});

// ── 2. a failing test is DATA ───────────────────────────────────────────────

describe("runPipeline — failing spec (DEV-1)", () => {
  it("still reaches `done` but renders NO_GO", async () => {
    const s = await scaffold({ runId: "run-red" });
    s.hooks.raw = () => "fail";

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.state,
      "done",
      "a failing TEST is data, not an infra fault — the run still completes (DEV-1)",
    );
    assert.deepEqual(
      [...report.transitions],
      HAPPY_PATH,
      "a red run takes exactly the same §4b path as a green one",
    );
    assert.equal(
      report.failure,
      undefined,
      "a test failure must never be recorded as a stage failure",
    );
    assert.equal(
      report.teardown,
      "completed",
      "a red ephemeral run still tears down — the runner reached a terminal state",
    );
    assert.equal(
      report.verdict.status,
      "NO_GO",
      "a blocking `fail` row is a NO_GO (§6a resolution table)",
    );
    assert.equal(
      report.verdict.confirmToken,
      undefined,
      "only a GO mints a ConfirmToken",
    );
    const [row] = report.verdict.rows;
    assert.equal(
      row.raw,
      "fail",
      "the row keeps the raw outcome the runner gave",
    );
    assert.equal(row.blocking, true, "a `fail` row blocks");
  });
});

// ── 3. runner rejects → infra fault ─────────────────────────────────────────

describe("runPipeline — runner rejection (DEV-1 infra fault)", () => {
  it("abandons the run without throwing and skips teardown", async () => {
    const s = await scaffold({ runId: "run-infra" });
    s.ports.runners = [
      faultingRunner(s.calls, "ATF trigger failed: 503 Service Unavailable"),
    ];

    const report = await runPipeline(s.deps, s.runOptions);

    assert.ok(
      report.failure,
      "a rejected runner is an infra fault and must be reported as a stage failure",
    );
    assert.equal(
      report.failure.stage,
      "run",
      "the failure must name the stage that produced it",
    );
    assert.match(
      report.failure.message,
      /503 Service Unavailable/,
      "the adapter's own message must survive into the report",
    );
    assert.equal(
      report.state,
      "abandoned",
      "a rejection proves nothing about the instance run — §4b's only edge out of `running` is `abandoned`",
    );
    assert.equal(
      report.teardown,
      "skipped-non-terminal",
      "ARCH-32: nothing is deleted while the instance run is not provably terminal",
    );
    assert.equal(
      s.calls.teardown,
      0,
      "the store's teardown must never be called after an infra fault",
    );
    assert.equal(
      report.result.outcomes[0].raw,
      "error",
      "DEV-1: an unobservable outcome becomes an explicit `error` row, never an absence",
    );
    assert.equal(
      report.verdict.status,
      "INCONCLUSIVE",
      "an `error` row is blocking-inconclusive, never a quiet green",
    );

    const entries = await s.ledger.entries("run-infra");
    const trigger = entries.find((entry) => entry.intent.startsWith("run "));
    assert.equal(
      trigger.state,
      "intended",
      "the trigger intent stays `intended` on purpose — we cannot prove it did not land (W2)",
    );
  });
});

// ── 4. abort mid-run ────────────────────────────────────────────────────────

describe("runPipeline — abort during the run stage (ARCH-28/DEV-17)", () => {
  it("abandons the run and never touches the instance", async () => {
    const s = await scaffold({ runId: "run-abort" });
    s.ports.runners = [stallingRunner(s.calls, s.hooks)];
    const operator = new AbortController();
    s.runOptions.signal = operator.signal;
    s.hooks.onRun = () => operator.abort(new Error("operator cancelled"));

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.state,
      "abandoned",
      "an abort under a live instance run is terminal-abandoned (ARCH-28)",
    );
    assert.equal(
      report.teardown,
      "skipped-non-terminal",
      "DEV-17: teardown is skipped entirely, not merely attempted",
    );
    assert.equal(
      s.calls.teardown,
      0,
      "the store's teardown must NOT have been called once — deleting under a live run is the one forbidden act",
    );
    assert.equal(
      report.result.outcomes[0].raw,
      "error",
      "an abort yields `error` rows; only a DEV-2 deadline yields `waiting-timeout`",
    );
    assert.equal(
      report.verdict.status,
      "INCONCLUSIVE",
      "an abandoned run can never be a GO",
    );
    assert.equal(
      report.failure,
      undefined,
      "cancellation is the caller's own decision — reporting it back as a stage failure would be a lie",
    );

    const entries = await s.ledger.entries("run-abort");
    assert.ok(
      entries.every((entry) => entry.state !== "compensated"),
      "no compensation may run while the instance run is not provably terminal",
    );
    const projection = entries.find((entry) =>
      entry.intent.startsWith("project "),
    );
    assert.equal(
      projection.state,
      "applied",
      "the projection landed and stays `applied` — reclamation is cleanup's job, not the loop's",
    );
  });
});

// ── 5. poll deadline ────────────────────────────────────────────────────────

describe("runPipeline — bounded polling deadline (DEV-2)", () => {
  it("stops waiting, abandons, and synthesizes `waiting-timeout` rows", async () => {
    const s = await scaffold({ runId: "run-deadline" });
    s.ports.runners = [stallingRunner(s.calls, s.hooks)];
    s.runOptions.runTimeoutMs = DEADLINE_MS;

    const report = await runPipeline(s.deps, s.runOptions);

    assert.ok(
      report.transitions.includes("running"),
      "the deadline must fire while the runner is in flight, otherwise this test proves nothing",
    );
    assert.equal(
      report.state,
      "abandoned",
      "an expired deadline leaves the instance run non-terminal → `abandoned` (DEV-2/ARCH-32)",
    );
    assert.equal(
      report.teardown,
      "skipped-non-terminal",
      "a timed-out run must not tear down — the run may still be executing",
    );
    assert.equal(
      s.calls.teardown,
      0,
      "the store's teardown must not be called after a deadline",
    );
    assert.equal(
      report.result.outcomes[0].raw,
      "waiting-timeout",
      "DEV-2's distinct cause must be preserved — a timeout is not a generic adapter error",
    );
    assert.equal(
      report.verdict.status,
      "INCONCLUSIVE",
      "`waiting-timeout` is blocking-inconclusive (§6a)",
    );
    const errorEvent = s.trace.find(
      (entry) => entry.at === "event" && entry.kind === "error",
    );
    assert.match(
      errorEvent.event.cause,
      /DEV-2/,
      "the emitted cause must name the bounded-polling rule that stopped the wait",
    );
    assert.equal(
      report.failure?.stage,
      "run",
      "a deadline is the same hole as a rejection — the runner owed evidence and delivered none — so it carries a `failure` too",
    );
    assert.match(
      report.failure.message,
      /DEV-2/,
      "the failure must name the rule, not read as a generic run-stage error",
    );
  });
});

// ── 6. lifecycle decides teardown ───────────────────────────────────────────

describe("runPipeline — teardown per lifecycle mode (§4a/DEV-20)", () => {
  it("ephemeral: deletes the projection and compensates every entry", async () => {
    const s = await scaffold({
      runId: "run-ephemeral",
      lifecycle: "ephemeral",
    });

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.teardown,
      "completed",
      "an ephemeral run owes a completed teardown",
    );
    assert.equal(
      s.calls.teardown,
      1,
      "the store's teardown must be called exactly once",
    );
    assert.equal(report.state, "done", "a completed teardown reaches `done`");
    const entries = await s.ledger.entries("run-ephemeral");
    assert.ok(
      entries.every((entry) => entry.state === "compensated"),
      "every journalled write must be compensated once the store deleted the namespace",
    );
  });

  it("persistent: keeps the definitions and never calls the store", async () => {
    const s = await scaffold({
      runId: "run-persistent",
      lifecycle: "persistent",
    });

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.teardown,
      "skipped-persistent",
      "persistent test definitions are never deleted (§4a/DEV-20)",
    );
    assert.equal(
      s.calls.teardown,
      0,
      "the store's teardown must NOT be called for a persistent run",
    );
    assert.equal(
      report.state,
      "done",
      "skipping teardown still walks `tearing-down → done` (§4b)",
    );
    const entries = await s.ledger.entries("run-persistent");
    assert.ok(
      entries.every((entry) => entry.state === "applied"),
      "nothing is compensated in persistent mode — the manifest owns those records",
    );
    const projection = entries.find((entry) =>
      entry.intent.startsWith("project "),
    );
    assert.equal(
      projection.compensation.op,
      "none",
      "a persistent projection must journal an explicit non-compensation, not a delete",
    );
  });

  // Delegated decision 2026-09-25: a store's DEV-17 gate refuses a suite with
  // no result row unless the caller asserts no trigger happened. Core may
  // assert that ONLY when the fault came before the `running` stage.
  it("asserts neverTriggered only when teardown follows a pre-`running` fault", async () => {
    const seen = [];
    const failed = await scaffold({ runId: "run-project-fault" });
    failed.hooks.onProject = () => {
      throw new Error("projection broke half-way");
    };
    failed.hooks.onTeardown = (ctx) => seen.push(ctx.neverTriggered);
    await runPipeline(failed.deps, failed.runOptions);

    const green = await scaffold({ runId: "run-triggered" });
    green.hooks.onTeardown = (ctx) => seen.push(ctx.neverTriggered);
    await runPipeline(green.deps, green.runOptions);

    assert.deepEqual(
      seen,
      [true, undefined],
      "a projection fault never reached a trigger; a run that ran must not claim so",
    );
  });

  // DEV-17 (wave 13): teardown always carries the ledger's recorded trigger
  // count — one entry per runner group on the run-trigger table — so a store
  // can refuse while a second execution is still queued.
  it("passes recordedTriggers = the trigger entries the ledger records", async () => {
    const seen = [];
    const failed = await scaffold({ runId: "run-count-fault" });
    failed.hooks.onProject = () => {
      throw new Error("projection broke half-way");
    };
    failed.hooks.onTeardown = (ctx) =>
      seen.push([ctx.neverTriggered, ctx.recordedTriggers]);
    await runPipeline(failed.deps, failed.runOptions);

    const one = await scaffold({ runId: "run-count-one" });
    one.hooks.onTeardown = (ctx) =>
      seen.push([ctx.neverTriggered, ctx.recordedTriggers]);
    await runPipeline(one.deps, one.runOptions);

    const two = await scaffold({
      runId: "run-count-two",
      specs: [
        SPEC,
        { ...SPEC, ref: { id: "spec-order-2", path: "tests/order2.test.ts" } },
      ],
    });
    const first = passingRunner(two.calls, two.hooks);
    const second = passingRunner(two.calls, two.hooks);
    first.supports = (spec) => spec.ref.id === SPEC.ref.id;
    two.ports.runners = [first, second];
    two.hooks.onTeardown = (ctx) =>
      seen.push([ctx.neverTriggered, ctx.recordedTriggers]);
    await runPipeline(two.deps, two.runOptions);
    assert.equal(two.calls.run, 2, "two runner groups ran");

    assert.deepEqual(seen, [
      [true, 0],
      [undefined, 1],
      [undefined, 2],
    ]);
  });

  it("passes recordedTriggers = null (never omits it) when the ledger cannot be read", async () => {
    const s = await scaffold({ runId: "run-count-unreadable" });
    let broken = false;
    const ledger = s.deps.ledger;
    s.deps = {
      ...s.deps,
      ledger: {
        ...ledger,
        async entries(runId) {
          if (broken) throw new Error("ledger log unreadable");
          return ledger.entries(runId);
        },
      },
    };
    s.hooks.onRun = () => {
      broken = true;
    };
    const seen = [];
    s.hooks.onTeardown = (ctx) => {
      seen.push(Object.hasOwn(ctx, "recordedTriggers"), ctx.recordedTriggers);
      broken = false;
    };
    await runPipeline(s.deps, s.runOptions);
    assert.deepEqual(seen, [true, null]);
  });
});

// ── 7. guard refusal precedes every write ───────────────────────────────────

describe("runPipeline — non-writable runner (§11.5)", () => {
  it("throws before the run record exists, leaving nothing on disk", async () => {
    const s = await scaffold({ runId: "run-prod", host: PROD_HOST });

    await assert.rejects(
      () => runPipeline(s.deps, s.runOptions),
      (error) => {
        assert.equal(
          error.name,
          "GuardViolation",
          "composition must be refused by the guard, not by a downstream adapter",
        );
        assert.equal(
          error.detail.reason,
          "runner-not-writable",
          "a prod runner is refused for exactly one reason and no override lifts it",
        );
        return true;
      },
      "a prod-classified runner must never be composed (§11.5)",
    );

    assert.deepEqual(
      await s.ledger.listRuns(),
      [],
      "a refused composition must not open a run record",
    );
    assert.equal(
      await exists(path.join(s.rootDir, "runs", "run-prod")),
      false,
      "§11: the refusal happens BEFORE a single byte is written — no run directory may exist",
    );
    assert.equal(
      s.calls.resolve + s.calls.project + s.calls.run,
      0,
      "not one port may be touched after a guard refusal",
    );
  });
});

// ── 8. write-ahead ordering ─────────────────────────────────────────────────

describe("runPipeline — write-ahead protocol (§4b step 1)", () => {
  it("probes an ephemeral projection by the DELIMITED run-id prefix", async () => {
    const runId = "run-1";
    const s = await scaffold({ runId, lifecycle: "ephemeral" });
    const seen = {};
    s.hooks.onProject = async () => {
      seen.atProject = await s.ledger.entries(runId);
    };

    await runPipeline(s.deps, s.runOptions);

    assert.ok(seen.atProject, "TestStore.project must have been called");
    const [intendedProjection] = seen.atProject;
    assert.equal(intendedProjection.probe.key, "run-id-prefix");
    assert.equal(
      intendedProjection.probe.query,
      "nameSTARTSWITHrun-1:",
      "an undelimited prefix would let run-1's W2 probe claim run-10's rows",
    );
  });

  it("makes the intent durable BEFORE the write and confirms it after", async () => {
    const runId = "run-writeahead";
    // Persistent, so teardown cannot flip the entries to `compensated` and hide
    // the `applied` end state this test is about.
    const s = await scaffold({ runId, lifecycle: "persistent" });
    const seen = {};
    s.hooks.onProject = async () => {
      seen.atProject = await s.ledger.entries(runId);
    };
    s.hooks.onRun = async () => {
      seen.atRun = await s.ledger.entries(runId);
    };

    const report = await runPipeline(s.deps, s.runOptions);

    // ── the projection write ──
    assert.ok(
      seen.atProject,
      "TestStore.project must have been called — the ordering assertions below depend on it",
    );
    assert.equal(
      seen.atProject.length,
      1,
      "exactly the projection intent must be on disk when the store is asked to write",
    );
    const [intendedProjection] = seen.atProject;
    assert.equal(
      intendedProjection.state,
      "intended",
      "the intent is durable and still UNCONFIRMED at the moment of the write (§4b step 1 → 2)",
    );
    assert.match(
      intendedProjection.intent,
      /^project unit spec spec-order$/,
      "the intent must describe the write it precedes",
    );
    assert.equal(
      intendedProjection.idempotencyKey,
      `${runId}:project:${SPEC_KEY}`,
      "the intent must be keyed so a host retry dedupes instead of double-writing",
    );
    assert.equal(
      intendedProjection.target.sysId,
      undefined,
      "a create has no sys_id at intend time — that gap is what the W2 probe closes",
    );
    assert.equal(
      intendedProjection.probe.key,
      "natural-key",
      "a persistent create probes its natural key so W2 recovery can ADOPT it (QA-25)",
    );

    // ── the run trigger ──
    assert.ok(
      seen.atRun,
      "the runner must have been called — the ordering assertions below depend on it",
    );
    assert.equal(
      seen.atRun.length,
      2,
      "the trigger intent must be on disk before the runner is invoked",
    );
    const confirmedProjection = seen.atRun.find(
      (entry) => entry.seq === intendedProjection.seq,
    );
    assert.equal(
      confirmedProjection.state,
      "applied",
      "step 3: the projection intent is confirmed once the write returned",
    );
    assert.equal(
      confirmedProjection.target.sysId,
      "test-spec-order",
      "confirm must record the sys_id the store actually created",
    );
    const intendedTrigger = seen.atRun.find(
      (entry) => entry.seq !== intendedProjection.seq,
    );
    assert.equal(
      intendedTrigger.state,
      "intended",
      "the trigger's intent is durable and unconfirmed while the runner runs",
    );
    assert.ok(
      intendedTrigger.seq > intendedProjection.seq,
      "seq must be monotonic — reverse seq IS the pinned teardown order (DEV-13/ARCH-37)",
    );
    assert.equal(
      intendedTrigger.compensation.op,
      "none",
      "a triggered suite run cannot be un-triggered, so the ledger records why (§4b)",
    );

    // ── after the loop ──
    const entries = await s.ledger.entries(runId);
    assert.deepEqual(
      entries.map((entry) => entry.state),
      ["applied", "applied"],
      "every write that landed must end `applied` — an unsettled entry is an orphan",
    );
    assert.equal(report.state, "done", "the run itself is unaffected");
  });
});

// ── 9. ARCH-24 flush boundary ───────────────────────────────────────────────

describe("runPipeline — terminal event and flush boundary (ARCH-24)", () => {
  it("emits `end` exactly once and closes reporters strictly after it", async () => {
    const s = await scaffold({ runId: "run-flush" });

    await runPipeline(s.deps, s.runOptions);

    assert.equal(
      endEvents(s.trace).length,
      1,
      "`end` is terminal: emitted once by core, never by the runner, never twice",
    );
    const endIndex = s.trace.findIndex(
      (entry) => entry.at === "event" && entry.kind === "end",
    );
    const closeIndex = s.trace.findIndex((entry) => entry.at === "close");
    assert.ok(closeIndex > endIndex, "close() must come strictly after `end`");
    assert.equal(
      s.calls.close,
      1,
      "each reporter is closed exactly once, even though the finally block re-asserts the boundary",
    );
    assert.equal(
      s.trace.slice(closeIndex).filter((entry) => entry.at === "event").length,
      0,
      "nothing may be emitted past the flush boundary — a late event would miss the flushed reporters",
    );
  });

  it("records a throwing close() as a `collect` failure without losing the report", async () => {
    const s = await scaffold({ runId: "run-flush-fault" });
    s.hooks.onClose = () => {
      throw new Error("reporter disk full");
    };

    const report = await runPipeline(s.deps, s.runOptions);

    assert.ok(report.failure, "a reporter that cannot flush is a real failure");
    assert.equal(
      report.failure.stage,
      "collect",
      "a flush fault belongs to the collect stage",
    );
    assert.match(
      report.failure.message,
      /reporter close failed: .*reporter disk full/,
      "the reporter's own message must be surfaced",
    );
    assert.equal(
      report.state,
      "done",
      "a reporter fault must not change the run's fate",
    );
    assert.equal(
      report.verdict.status,
      "GO",
      "a reporter fault is never allowed to change the verdict",
    );
    assert.equal(
      report.result.outcomes.length,
      1,
      "the collected results survive the reporter fault",
    );
  });
});

// ── 10. ARCH-30 parity ──────────────────────────────────────────────────────

describe("runPipeline — planned/demanded parity (ARCH-30)", () => {
  it("turns a demanded-but-unproduced spec into a blocking `missing` row", async () => {
    const s = await scaffold({ runId: "run-parity-missing" });
    s.runOptions.impact = {
      nodes: [ARTIFACT, EXTRA_ARTIFACT],
      edges: [],
      unanalyzable: [],
      demanded: [DEMANDED_SPEC, DEMANDED_ONLY],
    };

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.planned.length,
      2,
      "a demanded spec nothing produced still joins the checklist (ARCH-30)",
    );
    const row = report.verdict.rows.find(
      (entry) => entry.spec.id === "spec-pricing",
    );
    assert.ok(row, "the demanded spec must have a checklist row of its own");
    assert.equal(
      row.raw,
      "missing",
      "no outcome for a planned spec is synthesized as `missing` by the reducer",
    );
    assert.equal(
      row.blocking,
      true,
      "a `missing` row blocks — an untested demanded artifact is not evidence of safety",
    );
    assert.notEqual(
      report.verdict.status,
      "GO",
      "a missing row can never be a GO",
    );
    assert.equal(
      report.verdict.status,
      "NO_GO",
      "`missing` resolves to a blocking fail (§6a resolution table)",
    );
    assert.equal(
      report.verdict.warnings.filter((warning) =>
        warning.startsWith("parity breach"),
      ).length,
      0,
      "planned ⊇ demanded here, so the parity check itself must stay silent",
    );
  });

  it("flags a planned spec the analysis never demanded as a parity breach", async () => {
    const s = await scaffold({ runId: "run-parity-breach" });
    s.runOptions.impact = {
      nodes: [ARTIFACT],
      edges: [],
      unanalyzable: [],
      demanded: [],
    };

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.verdict.status,
      "INCONCLUSIVE",
      "plan and analysis drifting apart is INCONCLUSIVE, never a quiet green (ARCH-30)",
    );
    assert.ok(
      report.verdict.warnings.some((warning) =>
        warning.includes("planned spec not demanded"),
      ),
      "the breach must name the direction it broke in",
    );
    assert.equal(
      report.result.outcomes[0].raw,
      "pass",
      "the spec itself still passed — the parity breach is about the plan, not the test",
    );
  });
});

// ── 11. results before deletion ─────────────────────────────────────────────

describe("runPipeline — results persisted before deletion (DEV-13)", () => {
  it("has emitted and flushed everything before the store deletes a record", async () => {
    const runId = "run-dev13";
    const s = await scaffold({ runId });
    const observed = {};
    s.hooks.onTeardown = async () => {
      observed.trace = s.trace.map((entry) => ({
        at: entry.at,
        kind: entry.kind,
      }));
      observed.state = (await s.ledger.readRun(runId)).state;
    };

    const report = await runPipeline(s.deps, s.runOptions);

    assert.ok(
      observed.trace,
      "the store's teardown must have run — this test observes DEV-13 from inside it",
    );
    assert.ok(
      observed.trace.some(
        (entry) => entry.at === "event" && entry.kind === "end",
      ),
      "the results were emitted before the first delete (DEV-13)",
    );
    assert.ok(
      observed.trace.some((entry) => entry.at === "close"),
      "every reporter was FLUSHED before the first delete (DEV-13/ARCH-24)",
    );
    assert.equal(
      observed.state,
      "tearing-down",
      "the durable state at delete time must already be `tearing-down` (§4b)",
    );
    assert.ok(
      report.transitions.indexOf("collecting") <
        report.transitions.indexOf("tearing-down"),
      "collecting must precede tearing-down in the persisted transition path",
    );
    assert.equal(
      report.result.outcomes.length,
      1,
      "the outcomes were folded before anything was deleted",
    );
  });
});

// ── 12. concurrency refusal ─────────────────────────────────────────────────

describe("runPipeline — concurrent runs on one scope+runner (§4b)", () => {
  it("refuses the second run and names the one already in flight", async () => {
    const s = await scaffold({ runId: "run-a", scope: "x_acme_orders" });
    s.ports.runners = [stallingRunner(s.calls, s.hooks)];
    const inFlight = deferred();
    s.hooks.onRun = () => inFlight.resolve();
    const operator = new AbortController();
    s.runOptions.signal = operator.signal;

    const runA = runPipeline(s.deps, s.runOptions);
    await inFlight.promise;

    const second = { ...s.runOptions, runId: "run-b", signal: undefined };
    await assert.rejects(
      () => runPipeline(s.deps, second),
      (error) => {
        assert.match(
          error.message,
          /run "run-a" is already in flight/,
          "the refusal must name the conflicting runId",
        );
        assert.match(
          error.message,
          /x_acme_orders/,
          "the refusal must name the scope half of the §4b concurrency key",
        );
        assert.match(
          error.message,
          /dev12345\.service-now\.com/,
          "the refusal must name the runner half of the §4b concurrency key",
        );
        // Delegated decision 2026-09-26: a named refusal, not a plain Error,
        // so the CLI can render it as exit 4 instead of a DEV-1 fault.
        assert.equal(error.name, "RunConcurrencyRefusedError");
        assert.ok(error instanceof RunConcurrencyRefusedError);
        assert.equal(error.runId, "run-b");
        assert.equal(error.scope, "x_acme_orders");
        assert.equal(error.runner, "dev12345.service-now.com");
        assert.deepEqual(
          error.conflicts.map((c) => [c.runId, c.state]),
          [["run-a", "running"]],
        );
        assert.match(error.message, /state running/);
        assert.match(
          error.message,
          /tess status --run-id run-a/,
          "the refusal must point the operator at `tess status`",
        );
        assert.doesNotMatch(error.message, /§11/);
        return true;
      },
      "a second run on the same scope+runner must be refused while the first is in flight",
    );

    assert.equal(
      await s.ledger.readRun("run-b"),
      undefined,
      "the refused run must not leave a half-open run record behind",
    );
    assert.equal(
      s.calls.project,
      1,
      "the refused run must not have touched the instance at all",
    );

    operator.abort(new Error("stop run A"));
    const reportA = await runA;
    assert.equal(
      reportA.state,
      "abandoned",
      "the first run still owns its own terminal state",
    );
  });

  // Delegated decision 2026-09-26: a corrupt record anywhere under the root
  // keeps blocking the concurrency check (hard stop, no auto-quarantine), but
  // the stop names every offending run and path.
  it("stops on a corrupt record and names it, touching nothing", async () => {
    const s = await scaffold({ runId: "run-new" });
    for (const runId of ["run-bad-1", "run-bad-2"]) {
      await s.ledger.openRun({
        runId,
        scope: "x_other_scope",
        runner: s.runOptions.topology.runner,
        lifecycle: s.runOptions.lifecycle,
      });
      await fs.writeFile(
        path.join(s.rootDir, "runs", runId, "run.json"),
        "{not json",
      );
    }

    await assert.rejects(
      () => runPipeline(s.deps, s.runOptions),
      (error) => {
        assert.equal(error.name, "LedgerError");
        assert.equal(error.code, "corrupt");
        assert.deepEqual(
          error.corruptRecords.map((record) => record.runId),
          ["run-bad-1", "run-bad-2"],
        );
        assert.match(error.message, /run-bad-1/);
        assert.match(error.message, /run-bad-2/);
        return true;
      },
    );
    assert.equal(
      await s.ledger.readRun("run-new"),
      undefined,
      "the stop happens before `openRun`",
    );
    assert.deepEqual(
      { ...s.calls },
      { resolve: 0, project: 0, run: 0, teardown: 0, close: 0 },
    );
  });
});

// ── 13. a retry that resolves to an existing run ─────────────────────────────

describe("runPipeline — a retry that resolves to an existing run (§4b)", () => {
  it("never reports a state the ledger did not hand it", async () => {
    const s = await scaffold({ runId: "run-retry" });
    // A first attempt got as far as `provisioning` and then died. `openRun` is
    // idempotent, so the retry below RESOLVES TO THAT RECORD rather than
    // creating a fresh one — `planned` is a state this loop never sees.
    await s.ledger.openRun({
      runId: "run-retry",
      scope: s.runOptions.scope,
      runner: s.runOptions.topology.runner,
      lifecycle: s.runOptions.lifecycle,
    });
    await s.ledger.transition("run-retry", "provisioning");

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.transitions[0],
      "provisioning",
      "`transitions` must open with the state `openRun` resolved to, not with the literal `planned`",
    );
    assert.ok(
      !report.transitions.includes("planned"),
      "a run already past `planned` never made that edge in this loop, so the report must not claim it",
    );
    assert.deepEqual(
      [...report.transitions],
      HAPPY_PATH.slice(1),
      "everything from the resumed state onwards is a real, observed edge",
    );
    assert.equal(
      report.state,
      "done",
      "the resumed run still finishes on the §4b terminal state",
    );
  });
});

// ── 14. a §4b edge refused after the flush boundary ──────────────────────────

describe("runPipeline — a refused §4b edge after the flush boundary", () => {
  it("reports the refused tearing-down edge, which no reporter can be told about", async () => {
    const s = await scaffold({ runId: "run-refused" });
    const refusal = new Error("run state file is unwritable");
    const deps = {
      ...s.deps,
      ledger: {
        ...s.ledger,
        async transition(runId, to) {
          if (to === "tearing-down") throw refusal;
          return await s.ledger.transition(runId, to);
        },
      },
    };

    const report = await runPipeline(deps, s.runOptions);

    assert.equal(
      report.state,
      "collecting",
      "the refused edge leaves the run where it was — the report must show that state, not a terminal one",
    );
    assert.ok(
      report.projection !== undefined,
      "this run DID project: `teardown: not-reached` alone would read as `nothing was ever projected`",
    );
    assert.equal(
      report.teardown,
      "not-reached",
      "no teardown pass ran, so nothing was compensated",
    );
    assert.equal(
      report.failure?.stage,
      "teardown",
      "the refusal belongs to the teardown half of the loop",
    );
    assert.match(
      report.failure.message,
      /tearing-down edge was refused/,
      "the report must say WHY teardown never started",
    );
    assert.equal(
      report.failure.cause,
      refusal,
      "the ledger's own refusal is the cause, carried unwrapped",
    );

    const logs = s.trace.filter(
      (entry) => entry.at === "event" && entry.kind === "log",
    );
    assert.ok(
      !logs.some((entry) => /tearing-down/.test(entry.event.message)),
      "ARCH-24: the log announcing the refusal is emitted past the flush boundary, so it reaches no reporter — which is exactly why `failure` has to carry it",
    );
  });
});

// ── 15. a terminal §4b edge refused AFTER a teardown that did run ────────────

describe("runPipeline — a refused terminal edge after teardown", () => {
  it("reports the refused done edge instead of letting `teardown: completed` stand alone", async () => {
    const s = await scaffold({ runId: "run-refused-done" });
    const refusal = new Error("run state file is unwritable");
    const deps = {
      ...s.deps,
      ledger: {
        ...s.ledger,
        async transition(runId, to) {
          if (to === "done") throw refusal;
          return await s.ledger.transition(runId, to);
        },
      },
    };

    const report = await runPipeline(deps, s.runOptions);

    assert.equal(
      report.teardown,
      "completed",
      "teardown really did run and compensate — that part of the report is true",
    );
    assert.equal(
      report.state,
      "tearing-down",
      "the record was left mid-machine; a report claiming a terminal state would be the lie",
    );
    assert.ok(
      report.failure,
      "`teardown: completed` next to a non-terminal `state` and no failure is indistinguishable from a clean run to every consumer that reads the disposition",
    );
    assert.equal(report.failure.stage, "teardown");
    assert.match(
      report.failure.message,
      /left in tearing-down: the §4b tearing-down → done edge was refused/,
      "the report must name the edge that was refused, not just that something went wrong",
    );
    assert.equal(
      report.failure.cause,
      refusal,
      "the ledger's own refusal is the cause, carried unwrapped",
    );

    const logs = s.trace.filter(
      (entry) => entry.at === "event" && entry.kind === "log",
    );
    assert.ok(
      !logs.some((entry) => /→ done/.test(entry.event.message)),
      "ARCH-24: this edge is driven past the flush boundary, so the log reaches no reporter — `failure` is the only channel left",
    );
  });

  it("reports the refused abandoned edge on a run the runner never finished", async () => {
    const s = await scaffold({ runId: "run-refused-abandon" });
    const refusal = new Error("run state file is unwritable");
    const deps = {
      ...s.deps,
      ledger: {
        ...s.ledger,
        async transition(runId, to) {
          if (to === "abandoned") throw refusal;
          return await s.ledger.transition(runId, to);
        },
      },
      ports: {
        ...s.ports,
        runners: [faultingRunner(s.calls, "runner host unreachable")],
      },
    };

    const report = await runPipeline(deps, s.runOptions);

    assert.equal(
      report.teardown,
      "skipped-non-terminal",
      "ARCH-32: nothing is deleted under a run that was never proved terminal",
    );
    assert.equal(
      report.state,
      "running",
      "the refused edge leaves the record in `running`, which is what `cleanup --run` will find",
    );
    assert.equal(
      report.failure.stage,
      "run",
      "DEV-1: the infrastructure fault that started this is a `run` fault and still owns the slot",
    );
    assert.match(
      report.failure.message,
      /runner host unreachable/,
      "the first, more specific cause wins — the refusal must not overwrite it",
    );
  });
});

// ── 16. a reporter that rejects an event (ARCH-24) ───────────────────────────

describe("runPipeline — a reporter that throws on an event", () => {
  /** A reporter that refuses exactly one event kind and is otherwise inert. */
  const refusing = (kind, message) => ({
    onEvent(event) {
      if (event.kind === kind) throw new Error(message);
    },
    async close() {},
  });

  /** An attached reporter that never has an opinion about anything. */
  const quiet = () => ({
    onEvent() {},
    async close() {},
  });

  it("leaves the verdict and the run's fate exactly where the gate put them", async () => {
    const s = await scaffold({ runId: "run-event-fault-verdict" });
    s.hooks.onEvent = () => {
      throw new Error("reporter socket closed");
    };

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.verdict.status,
      "GO",
      "an attached output channel does not get to veto a verdict the gate legitimately reached",
    );
    assert.ok(
      report.verdict.confirmToken,
      "the GO still mints its ConfirmToken — the evidence behind it is intact",
    );
    assert.equal(
      report.state,
      "done",
      "a reporter fault must not change the run's fate",
    );
    assert.equal(report.teardown, "completed", "nor what the run cleaned up");
    assert.equal(
      report.result.outcomes.length,
      1,
      "the outcome rows are the gate's evidence and are untouched by who failed to print them",
    );
    assert.ok(
      report.reporterEventFaults?.length > 0,
      "unchanged verdict is not the same as unrecorded — the dropped rows must still be on the report",
    );
  });

  it("records WHICH reporter refused the event", async () => {
    // Same throw, same event, two different attached reporters. If the record
    // cannot tell the two runs apart it cannot answer the only question a
    // reader has — which artifact is short a row — with console, json and
    // junit all wired at once.
    const first = await scaffold({ runId: "run-which-reporter-a" });
    first.ports.reporters = [
      quiet(),
      refusing("end", "reporter socket closed"),
      quiet(),
    ];
    const a = await runPipeline(first.deps, first.runOptions);

    const second = await scaffold({ runId: "run-which-reporter-b" });
    second.ports.reporters = [
      quiet(),
      quiet(),
      refusing("end", "reporter socket closed"),
    ];
    const b = await runPipeline(second.deps, second.runOptions);

    assert.equal(
      second.trace.length,
      0,
      "the swap really did replace the scaffold's own reporter — otherwise this test proves nothing about three attached reporters",
    );
    assert.equal(
      a.reporterEventFaults?.length,
      1,
      "exactly one of the three reporters threw, so exactly one fault is owed",
    );
    assert.equal(b.reporterEventFaults?.length, 1);
    assert.notEqual(
      a.reporterEventFaults[0].reporter,
      b.reporterEventFaults[0].reporter,
      "two different reporters threw the same error; a record that names them identically has not recorded which one",
    );
    assert.equal(
      a.reporterEventFaults[0].event,
      "end",
      "the fault still names the event kind that never landed",
    );
    assert.match(
      a.reporterEventFaults[0].message,
      /reporter socket closed/,
      "and the reporter's own message must survive into the report",
    );
  });

  it("reports a reporter fault AND an earlier stage failure, not whichever got there first", async () => {
    const s = await scaffold({ runId: "run-both-faults" });
    s.ports.runners = [
      faultingRunner(s.calls, "ATF trigger failed: 503 Service Unavailable"),
    ];
    s.hooks.onEvent = (event) => {
      if (event.kind === "end") throw new Error("reporter socket closed");
    };

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.failure?.stage,
      "run",
      "the infra fault is the run's own failure and keeps that slot",
    );
    assert.match(
      report.failure.message,
      /503 Service Unavailable/,
      "the adapter's message must survive",
    );
    assert.equal(
      report.reporterEventFaults?.length,
      1,
      "these are two independent facts; a report that can hold only one of them drops a diagnostic about a dropped event",
    );
    assert.equal(report.reporterEventFaults[0].event, "end");
    assert.match(
      report.reporterEventFaults[0].message,
      /reporter socket closed/,
    );
  });

  it("records a throw on the terminal `end` event as an `end` fault", async () => {
    const s = await scaffold({ runId: "run-event-fault" });
    s.hooks.onEvent = (event) => {
      if (event.kind === "end") throw new Error("reporter socket closed");
    };

    const report = await runPipeline(s.deps, s.runOptions);

    assert.deepEqual(
      report.reporterEventFaults?.map((fault) => fault.event),
      ["end"],
      "`end` is emitted once (emitEnd latches `ended` before emitting), so one refusal is one fault and it names `end` — an artifact with no `end` row reads like a run that was cut short, not like a reporter that threw",
    );
    assert.equal(
      report.failure,
      undefined,
      "a reporter is an output channel: it does not manufacture a stage failure for a run whose stages all succeeded",
    );
    assert.equal(
      report.state,
      "done",
      "a reporter fault must not change the run's fate",
    );
    assert.equal(
      report.verdict.status,
      "GO",
      "a reporter fault is never allowed to change the verdict",
    );
  });

  it("keeps handing the event to the reporters behind the one that threw", async () => {
    const s = await scaffold({ runId: "run-event-fault-fanout" });
    const seen = [];
    s.ports.reporters.unshift({
      onEvent() {
        throw new Error("reporter socket closed");
      },
      async close() {},
    });
    s.ports.reporters.push({
      onEvent(event) {
        seen.push(event.kind);
      },
      async close() {},
    });

    const report = await runPipeline(s.deps, s.runOptions);

    assert.ok(
      seen.includes("end"),
      "one reporter throwing must not cost the others their events",
    );
    assert.equal(endEvents(s.trace).length, 1, "`end` is still terminal");
    assert.equal(
      report.verdict.status,
      "GO",
      "a reporter fault is never allowed to change the verdict",
    );
  });
});

// ── 17. a §4b edge refused BEFORE the flush boundary ─────────────────────────

describe("runPipeline — a §4b edge refused before the flush boundary", () => {
  it("tells the reporters about a refusal while they can still be told", async () => {
    const s = await scaffold({ runId: "run-refused-collecting" });
    const refusal = new Error("run state file is unwritable");
    const deps = {
      ...s.deps,
      ledger: {
        ...s.ledger,
        async transition(runId, to) {
          if (to === "collecting") throw refusal;
          return await s.ledger.transition(runId, to);
        },
      },
    };

    const report = await runPipeline(deps, s.runOptions);

    const logs = s.trace.filter(
      (entry) => entry.at === "event" && entry.kind === "log",
    );
    assert.ok(
      logs.some((entry) =>
        /running → collecting refused: .*run state file is unwritable/.test(
          entry.event.message,
        ),
      ),
      "this edge is driven while the reporters are still open, so the log channel is the one that works — silence here is a refusal nobody downstream could notice",
    );
    assert.equal(
      report.state,
      "running",
      "the refused edge left the record in `running`",
    );
    assert.equal(
      report.failure.stage,
      "teardown",
      "§4b then refuses `running → tearing-down` as well, and THAT one is past the boundary, so it also lands on the report",
    );
  });
});

// ── failures[]: every fault, not just the one that won the slot ─────────────
// Delegated decision 2026-09-23 (additive): `failure` keeps its one-slot
// semantics; `failures` carries every fault in the order it was recorded.

describe("runPipeline — failures[] carries every fault", () => {
  it("is absent on a clean run, exactly as `failure` is", async () => {
    const s = await scaffold({ runId: "run-failures-clean" });

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(report.failure, undefined);
    assert.equal("failures" in report, false);
  });

  it("keeps the refused done edge that a throwing close() used to hide", async () => {
    const s = await scaffold({ runId: "run-failures-both" });
    s.hooks.onClose = () => {
      throw new Error("reporter disk full");
    };
    const refusal = new Error("run state file is unwritable");
    const deps = {
      ...s.deps,
      ledger: {
        ...s.ledger,
        async transition(runId, to) {
          if (to === "done") throw refusal;
          return await s.ledger.transition(runId, to);
        },
      },
    };

    const report = await runPipeline(deps, s.runOptions);

    assert.ok(Array.isArray(report.failures));
    assert.deepEqual(
      report.failures.map((f) => f.stage),
      ["collect", "teardown"],
      "both faults, in the order they happened",
    );
    assert.equal(
      report.failure,
      report.failures[0],
      "the one-slot `failure` is unchanged: the earliest guarded fault",
    );
    assert.match(report.failures[0].message, /reporter disk full/);
    assert.match(
      report.failures[1].message,
      /tearing-down → done edge was refused/,
    );
    assert.equal(report.failures[1].cause, refusal);
  });

  it("carries the refused abandoned edge behind the run fault that owns the slot", async () => {
    const s = await scaffold({ runId: "run-failures-abandon" });
    const refusal = new Error("run state file is unwritable");
    const deps = {
      ...s.deps,
      ledger: {
        ...s.ledger,
        async transition(runId, to) {
          if (to === "abandoned") throw refusal;
          return await s.ledger.transition(runId, to);
        },
      },
      ports: {
        ...s.ports,
        runners: [faultingRunner(s.calls, "runner host unreachable")],
      },
    };

    const report = await runPipeline(deps, s.runOptions);

    assert.equal(report.failure.stage, "run");
    assert.ok(
      report.failures.includes(report.failure),
      "`failure` is always one of `failures`",
    );
    assert.ok(report.failures.length >= 2, JSON.stringify(report.failures));
    assert.ok(
      report.failures.some((f) => f.cause === refusal),
      "the refused abandoned edge is no longer dropped",
    );
  });
});

// ── 18. a run id that is not fresh (F1) ─────────────────────────────────────
// Delegated decision 2026-09-26: `openRun` is idempotent, so reusing a run id
// hands the loop an existing record. Anything but a fresh one is REFUSED before
// the main try — no stage runs, no edge is driven, the ledger is not touched —
// because a used run may still own live instance state, and only `tess cleanup`
// re-enters it (DEV-17/ARCH-35).

/** The on-disk bytes of every ledger file, keyed by relative path. */
async function snapshotTree(root) {
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

/**
 * The r1 repro's seeding: a first attempt that projected (one applied entry),
 * then walked `path` — intending the trigger when it entered `running`.
 */
async function seedUsedRun(s, runId, walk) {
  await s.ledger.openRun({
    runId,
    scope: s.runOptions.scope,
    runner: s.runOptions.topology.runner,
    lifecycle: s.runOptions.lifecycle,
  });
  await s.ledger.transition(runId, "provisioning");
  await s.ledger.transition(runId, "projecting");
  const entry = await s.ledger.intend({
    runId,
    instance: s.runOptions.topology.runner,
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
  await s.ledger.confirm(runId, entry.seq, { sysId: "t1" });
  for (const to of walk) {
    await s.ledger.transition(runId, to);
    if (to === "running") {
      await s.ledger.intend({
        runId,
        instance: s.runOptions.topology.runner,
        intent: "trigger",
        target: { table: "sys_atf_test_suite_result" },
        compensation: { op: "none", reason: "r" },
        idempotencyKey: "k2",
      });
    }
  }
}

const USED_RUN_WALKS = {
  abandoned: ["running", "abandoned"],
  failed: ["running", "collecting", "tearing-down", "failed"],
  projecting: [],
  collecting: ["running", "collecting"],
  "tearing-down": ["running", "collecting", "tearing-down"],
  done: ["running", "collecting", "tearing-down", "done"],
};

describe("runPipeline — a reused run id that is not fresh (F1)", () => {
  for (const [prior, walk] of Object.entries(USED_RUN_WALKS)) {
    it(`refuses a ${prior} run and leaves its ledger untouched`, async () => {
      const runId = `run-used-${prior}`;
      const s = await scaffold({ runId });
      await seedUsedRun(s, runId, walk);
      const before = await snapshotTree(s.rootDir);

      await assert.rejects(
        runPipeline(s.deps, s.runOptions),
        (error) => {
          assert.equal(error.name, "RunResumeRefusedError");
          assert.equal(error.runId, runId);
          assert.equal(error.state, prior);
          assert.match(error.message, new RegExp(`state ${prior}`));
          assert.match(error.message, /tess cleanup --run-id/);
          assert.match(error.message, /tess status --run-id/);
          return true;
        },
        "a used run id must be refused, never driven to a terminal state",
      );

      assert.deepEqual(
        await snapshotTree(s.rootDir),
        before,
        "the refusal must not mutate run.json or a single ledger entry",
      );
      assert.equal((await s.ledger.readRun(runId)).state, prior);
      assert.deepEqual(
        { ...s.calls },
        { resolve: 0, project: 0, run: 0, teardown: 0, close: 0 },
        "no port may be touched for a refused run",
      );
    });
  }

  it("refuses a provisioning record that already journalled a write", async () => {
    const runId = "run-used-provisioning";
    const s = await scaffold({ runId });
    await s.ledger.openRun({
      runId,
      scope: s.runOptions.scope,
      runner: s.runOptions.topology.runner,
      lifecycle: s.runOptions.lifecycle,
    });
    await s.ledger.transition(runId, "provisioning");
    await s.ledger.intend({
      runId,
      instance: s.runOptions.topology.runner,
      intent: "fabricate seed user",
      target: { table: "sys_user" },
      compensation: { op: "delete", table: "sys_user" },
      idempotencyKey: "seed-1",
      probe: {
        table: "sys_user",
        query: `nameSTARTSWITH${runId}:`,
        key: "run-id-prefix",
      },
    });
    const before = await snapshotTree(s.rootDir);

    await assert.rejects(runPipeline(s.deps, s.runOptions), {
      name: "RunResumeRefusedError",
    });
    assert.deepEqual(await snapshotTree(s.rootDir), before);
  });
});

// Delegated decision 2026-09-26 (defence in depth): even past the fresh-run
// gate, `collectAndTearDown` never settles `done` over unsettled writes.
describe("runPipeline — done is never settled over unsettled writes", () => {
  it("settles failed when a non-fresh record slips past openRun", async () => {
    const runId = "run-lying-open";
    const s = await scaffold({ runId });
    await seedUsedRun(s, runId, []);
    // A ledger port that reports the record as fresh: the F1 gate is
    // bypassed, and the loop meets the illegal provisioning edge exactly as
    // it did before the gate existed.
    const deps = {
      ...s.deps,
      ledger: {
        ...s.ledger,
        async openRun(input) {
          return { ...(await s.ledger.openRun(input)), state: "planned" };
        },
      },
    };

    const report = await runPipeline(deps, s.runOptions);

    assert.equal(
      report.state,
      "failed",
      "an applied entry nothing compensated must not be settled done",
    );
    assert.equal((await s.ledger.readRun(runId)).state, "failed");
    assert.ok(
      report.failures.some((f) => /NOT settled done/.test(f.message)),
      JSON.stringify(report.failures),
    );
    const entries = await s.ledger.entries(runId);
    assert.deepEqual(
      entries.map((e) => e.state),
      ["applied"],
      "nothing is compensated behind the operator's back",
    );
  });

  it("still settles done over a persistent non-compensation left intended", async () => {
    const runId = "run-persistent-orphan";
    const s = await scaffold({ runId, lifecycle: "persistent" });
    s.hooks.onProject = () => {
      throw new Error("projection broke after the intent");
    };

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(report.teardown, "skipped-persistent");
    const entries = await s.ledger.entries(runId);
    assert.ok(
      entries.some(
        (e) => e.state === "intended" && e.compensation.op === "none",
      ),
      "the scenario must leave an intended op:none entry behind",
    );
    assert.equal(
      report.state,
      "done",
      "an op:none entry is one no cleanup could settle differently (DEV-20)",
    );
    assert.ok(
      !report.failures.some((f) => /NOT settled done/.test(f.message)),
      JSON.stringify(report.failures),
    );
  });

  it("settles failed when the ledger cannot be read back before done", async () => {
    const runId = "run-unreadable-ledger";
    const s = await scaffold({ runId, lifecycle: "persistent" });
    const deps = {
      ...s.deps,
      ledger: {
        ...s.ledger,
        async recover() {
          throw new Error("ledger read failed");
        },
      },
    };

    const report = await runPipeline(deps, s.runOptions);

    assert.equal(report.teardown, "skipped-persistent");
    assert.equal(
      report.state,
      "failed",
      "done is claimed only when the ledger proves every write settled",
    );
    assert.ok(
      report.failures.some((f) => /could not be read back/.test(f.message)),
      JSON.stringify(report.failures),
    );
  });
});

// ── an incomplete spec inventory never yields GO ────────────────────────────

describe("runPipeline — an incomplete spec inventory (inventoryIncomplete)", () => {
  const INVENTORY_WARNING = /spec inventory is incomplete/;

  it("downgrades GO to INCONCLUSIVE, names the reason and mints no token", async () => {
    const s = await scaffold({ runId: "run-inv-go" });

    const report = await runPipeline(s.deps, {
      ...s.runOptions,
      inventoryIncomplete: true,
    });

    assert.equal(
      report.verdict.status,
      "INCONCLUSIVE",
      "a GO over a partial inventory covers only what was read — never GO",
    );
    assert.equal(
      report.verdict.confirmToken,
      undefined,
      "a ConfirmToken exists iff the verdict is GO (A-1)",
    );
    assert.equal(
      report.verdict.warnings.filter((w) => INVENTORY_WARNING.test(w)).length,
      1,
      `the downgrade must name the incomplete inventory once, got ${JSON.stringify(report.verdict.warnings)}`,
    );
    assert.ok(
      report.verdict.warnings.some((w) => /downgraded to INCONCLUSIVE/.test(w)),
      "the warning must say that the GO was downgraded",
    );
    assert.equal(report.verdictDowngrade?.from, "GO");
    assert.equal(report.verdictDowngrade?.to, "INCONCLUSIVE");
    assert.equal(
      report.verdictDowngrade?.reason,
      report.verdict.warnings.at(-1),
      "the downgrade's reason is the warning the verdict carries",
    );
    // The rows and counts are the reducer's, untouched.
    assert.equal(report.verdict.rows.length, 1);
    assert.equal(report.verdict.rows[0].status, "pass");
    assert.equal(report.verdict.counts.blocking, 0);
    // Settle and ledger semantics do not move.
    assert.equal(report.state, "done");
    assert.deepEqual([...report.transitions], HAPPY_PATH);
    assert.equal(report.teardown, "completed");
    assert.equal(report.failure, undefined);
    const entries = await s.ledger.entries("run-inv-go");
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.state === "compensated"));
  });

  it("leaves NO_GO a NO_GO, still naming the incomplete inventory", async () => {
    const s = await scaffold({ runId: "run-inv-nogo" });
    s.hooks.raw = () => "fail";

    const report = await runPipeline(s.deps, {
      ...s.runOptions,
      inventoryIncomplete: true,
    });

    assert.equal(
      report.verdict.status,
      "NO_GO",
      "a failing assertion is evidence; an incomplete inventory does not weaken it",
    );
    assert.equal(report.verdict.confirmToken, undefined);
    assert.ok(
      report.verdict.warnings.some((w) => INVENTORY_WARNING.test(w)),
      "the incomplete inventory is reported on every verdict it touched",
    );
    assert.ok(
      !report.verdict.warnings.some((w) => /downgraded/.test(w)),
      "nothing was downgraded, so the warning must not claim it",
    );
    assert.equal(report.verdictDowngrade, undefined);
  });

  it("leaves an INCONCLUSIVE an INCONCLUSIVE", async () => {
    const s = await scaffold({ runId: "run-inv-inc" });
    s.hooks.raw = () => "skipped";

    const report = await runPipeline(s.deps, {
      ...s.runOptions,
      inventoryIncomplete: true,
    });

    assert.equal(report.verdict.status, "INCONCLUSIVE");
    assert.ok(report.verdict.warnings.some((w) => INVENTORY_WARNING.test(w)));
  });

  for (const flag of [false, undefined]) {
    it(`leaves GO unchanged when the flag is ${String(flag)}`, async () => {
      const s = await scaffold({ runId: `run-inv-${String(flag)}` });
      const options = { ...s.runOptions };
      if (flag !== undefined) options.inventoryIncomplete = flag;

      const report = await runPipeline(s.deps, options);

      assert.equal(report.verdict.status, "GO");
      assert.ok(report.verdict.confirmToken, "a GO mints its token");
      assert.equal(report.verdictDowngrade, undefined);
      assert.ok(
        !report.verdict.warnings.some((w) => INVENTORY_WARNING.test(w)),
        "a complete inventory adds no inventory warning",
      );
    });
  }
});

// ── an incomplete artifact resolution never yields GO (H1) ──────────────────

describe("runPipeline — an incomplete resolution (Resolver.resolveWithReport)", () => {
  const RESOLUTION_WARNING = /artifact resolution is incomplete/;
  const INVENTORY_WARNING = /spec inventory is incomplete/;

  /** A resolver whose report carries `notes`; `resolve()` must not be used. */
  const reportingResolver = (s, notes) => ({
    async resolve() {
      throw new Error("runPipeline must prefer resolveWithReport()");
    },
    async resolveWithReport() {
      s.calls.resolve += 1;
      return { artifacts: [{ ref: ARTIFACT, resolvedBy: "scope" }], notes };
    },
  });
  const PARTIAL = [
    { level: "info", message: "sys_script: 2 artifacts" },
    { level: "warning", message: "sys_script_include: read denied (403)" },
  ];

  it("downgrades GO to INCONCLUSIVE, names the reason and mints no token", async () => {
    const s = await scaffold({ runId: "run-res-go" });
    s.ports.resolver = reportingResolver(s, PARTIAL);

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(s.calls.resolve, 1);
    assert.equal(report.verdict.status, "INCONCLUSIVE");
    assert.equal(report.verdict.confirmToken, undefined);
    assert.ok(
      report.verdict.warnings.includes(
        "resolution: sys_script_include: read denied (403)",
      ),
      `the resolver's warning must reach the verdict, got ${JSON.stringify(report.verdict.warnings)}`,
    );
    assert.ok(
      !report.verdict.warnings.some((w) => /2 artifacts/.test(w)),
      "info notes are not evidence gaps and stay off the verdict",
    );
    assert.equal(
      report.verdict.warnings.filter((w) => RESOLUTION_WARNING.test(w)).length,
      1,
    );
    assert.ok(
      !report.verdict.warnings.some((w) => INVENTORY_WARNING.test(w)),
      "the resolution reason is distinct from the inventory reason",
    );
    assert.equal(report.verdictDowngrade?.from, "GO");
    assert.equal(report.verdictDowngrade?.to, "INCONCLUSIVE");
    assert.match(report.verdictDowngrade.reason, RESOLUTION_WARNING);
    assert.match(report.verdictDowngrade.reason, /partial resolution/);
    assert.equal(
      report.verdictDowngrade.reason,
      report.verdict.warnings.at(-1),
    );
    assert.equal(report.state, "done");
    assert.deepEqual([...report.transitions], HAPPY_PATH);
  });

  it("leaves NO_GO a NO_GO, still naming the incomplete resolution", async () => {
    const s = await scaffold({ runId: "run-res-nogo" });
    s.ports.resolver = reportingResolver(s, PARTIAL);
    s.hooks.raw = () => "fail";

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(report.verdict.status, "NO_GO");
    assert.ok(report.verdict.warnings.some((w) => RESOLUTION_WARNING.test(w)));
    assert.ok(!report.verdict.warnings.some((w) => /downgraded/.test(w)));
    assert.equal(report.verdictDowngrade, undefined);
  });

  it("names both reasons when the inventory is incomplete too", async () => {
    const s = await scaffold({ runId: "run-res-both" });
    s.ports.resolver = reportingResolver(s, PARTIAL);

    const report = await runPipeline(s.deps, {
      ...s.runOptions,
      inventoryIncomplete: true,
    });

    assert.equal(report.verdict.status, "INCONCLUSIVE");
    assert.match(report.verdictDowngrade.reason, RESOLUTION_WARNING);
    assert.match(report.verdictDowngrade.reason, INVENTORY_WARNING);
    assert.match(report.verdict.warnings.at(-1), INVENTORY_WARNING);
  });

  it("keeps GO when the report carries only info notes", async () => {
    const s = await scaffold({ runId: "run-res-complete" });
    s.ports.resolver = reportingResolver(s, [
      { level: "info", message: "sys_script: 1 artifact" },
    ]);

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(report.verdict.status, "GO");
    assert.ok(report.verdict.confirmToken);
    assert.equal(report.verdictDowngrade, undefined);
    assert.ok(!report.verdict.warnings.some((w) => RESOLUTION_WARNING.test(w)));
  });

  it("still accepts a resolver with only resolve()", async () => {
    const s = await scaffold({ runId: "run-res-plain" });

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(s.calls.resolve, 1);
    assert.equal(report.verdict.status, "GO");
  });
});

// ── an unanalyzable impact never yields GO ──────────────────────────────────

describe("runPipeline — an incomplete impact analysis (unanalyzable artifacts)", () => {
  const IMPACT_WARNING = /impact analysis is incomplete/;
  const RESOLUTION_WARNING = /artifact resolution is incomplete/;
  const INVENTORY_WARNING = /spec inventory is incomplete/;
  const UNTRACED = {
    artifact: ARTIFACT,
    reason: "usage could not be fully traced: sys_script search refused (403)",
  };

  /** A graph that demands exactly `SPEC`, so ARCH-30 parity holds. */
  const graph = (unanalyzable) => ({
    nodes: [ARTIFACT],
    edges: [],
    unanalyzable,
    demanded: [DEMANDED_SPEC],
  });

  /** An analyzer with only the bare `analyze()` of the port. */
  const bareAnalyzer = (unanalyzable) => ({
    async analyze() {
      return graph(unanalyzable);
    },
  });

  /** An analyzer whose report carries `notes`; `analyze()` must not be used. */
  const reportingAnalyzer = (unanalyzable, notes) => ({
    async analyze() {
      throw new Error("runPipeline must prefer analyzeWithReport()");
    },
    async analyzeWithReport() {
      return { graph: graph(unanalyzable), notes };
    },
  });

  it("control: a fully traced graph keeps GO and its token", async () => {
    const s = await scaffold({ runId: "run-imp-clean" });
    s.ports.impactAnalyzer = bareAnalyzer([]);

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(report.verdict.status, "GO");
    assert.ok(report.verdict.confirmToken, "a GO mints its token");
    assert.equal(report.verdictDowngrade, undefined);
    assert.ok(!report.verdict.warnings.some((w) => IMPACT_WARNING.test(w)));
  });

  it("downgrades GO to INCONCLUSIVE when the graph carries an unanalyzable artifact", async () => {
    const s = await scaffold({ runId: "run-imp-go" });
    s.ports.impactAnalyzer = bareAnalyzer([UNTRACED]);

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(
      report.verdict.status,
      "INCONCLUSIVE",
      "an untraced artifact means the selected tests may miss what the change touches",
    );
    assert.equal(report.verdict.confirmToken, undefined);
    // The reducer's own per-entry warning is still there, exactly once.
    assert.equal(
      report.verdict.warnings.filter((w) =>
        w.startsWith("unanalyzable impact: sys_script/a1"),
      ).length,
      1,
      JSON.stringify(report.verdict.warnings),
    );
    assert.equal(
      report.verdict.warnings.filter((w) => IMPACT_WARNING.test(w)).length,
      1,
    );
    assert.ok(!report.verdict.warnings.some((w) => RESOLUTION_WARNING.test(w)));
    assert.ok(!report.verdict.warnings.some((w) => INVENTORY_WARNING.test(w)));
    assert.equal(report.verdictDowngrade?.from, "GO");
    assert.equal(report.verdictDowngrade?.to, "INCONCLUSIVE");
    assert.match(report.verdictDowngrade.reason, IMPACT_WARNING);
    assert.match(report.verdictDowngrade.reason, /partial impact analysis/);
    assert.equal(
      report.verdictDowngrade.reason,
      report.verdict.warnings.at(-1),
    );
    // The rows and the run's fate are untouched.
    assert.equal(report.verdict.counts.blocking, 0);
    assert.equal(report.state, "done");
    assert.deepEqual([...report.transitions], HAPPY_PATH);
  });

  it("prefers analyzeWithReport and downgrades on a warning note alone", async () => {
    const s = await scaffold({ runId: "run-imp-note" });
    s.ports.impactAnalyzer = reportingAnalyzer(
      [],
      [
        { level: "info", message: "3 where-used edge(s)" },
        {
          level: "warning",
          message: "reference(s) to name(s) never searched for",
        },
      ],
    );

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(report.verdict.status, "INCONCLUSIVE");
    assert.equal(report.verdict.confirmToken, undefined);
    assert.ok(
      report.verdict.warnings.includes(
        "impact: reference(s) to name(s) never searched for",
      ),
      JSON.stringify(report.verdict.warnings),
    );
    assert.ok(
      !report.verdict.warnings.some((w) => /where-used edge/.test(w)),
      "info notes are not evidence gaps and stay off the verdict",
    );
    assert.match(report.verdictDowngrade?.reason ?? "", IMPACT_WARNING);
  });

  it("keeps GO when the report carries only info notes and nothing unanalyzable", async () => {
    const s = await scaffold({ runId: "run-imp-info" });
    s.ports.impactAnalyzer = reportingAnalyzer(
      [],
      [{ level: "info", message: "1 where-used edge(s)" }],
    );

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(report.verdict.status, "GO");
    assert.ok(report.verdict.confirmToken);
    assert.equal(report.verdictDowngrade, undefined);
  });

  it("downgrades a supplied graph (impact stage skipped) that carries an unanalyzable artifact", async () => {
    const s = await scaffold({ runId: "run-imp-supplied" });
    s.runOptions.impact = graph([UNTRACED]);

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(report.verdict.status, "INCONCLUSIVE");
    assert.match(report.verdictDowngrade?.reason ?? "", IMPACT_WARNING);
  });

  it("leaves NO_GO a NO_GO, still naming the incomplete impact analysis", async () => {
    const s = await scaffold({ runId: "run-imp-nogo" });
    s.ports.impactAnalyzer = bareAnalyzer([UNTRACED]);
    s.hooks.raw = () => "fail";

    const report = await runPipeline(s.deps, s.runOptions);

    assert.equal(report.verdict.status, "NO_GO");
    assert.ok(report.verdict.warnings.some((w) => IMPACT_WARNING.test(w)));
    assert.ok(!report.verdict.warnings.some((w) => /downgraded/.test(w)));
    assert.equal(report.verdictDowngrade, undefined);
  });

  it("names all three reasons in stage order: resolution, impact, inventory", async () => {
    const s = await scaffold({ runId: "run-imp-all" });
    s.ports.resolver = {
      async resolve() {
        throw new Error("runPipeline must prefer resolveWithReport()");
      },
      async resolveWithReport() {
        return {
          artifacts: [{ ref: ARTIFACT, resolvedBy: "scope" }],
          notes: [{ level: "warning", message: "sys_script: 403" }],
        };
      },
    };
    s.ports.impactAnalyzer = bareAnalyzer([UNTRACED]);

    const report = await runPipeline(s.deps, {
      ...s.runOptions,
      inventoryIncomplete: true,
    });

    assert.equal(report.verdict.status, "INCONCLUSIVE");
    const reason = report.verdictDowngrade?.reason ?? "";
    const at = (re) => reason.search(re);
    assert.ok(at(RESOLUTION_WARNING) >= 0, reason);
    assert.ok(at(RESOLUTION_WARNING) < at(IMPACT_WARNING), reason);
    assert.ok(at(IMPACT_WARNING) < at(INVENTORY_WARNING), reason);
    assert.match(report.verdict.warnings.at(-1), INVENTORY_WARNING);
  });
});
