// `tess benchmark` restore journal (review-w7a F4/F5) — the CLI side.
//
// What this file can falsify that the benchmark package's suites cannot:
//
//   * **Refusal before instances.** A pending (unrestored) journal for the
//     same run id, for an artifact the catalog touches, or one that cannot be
//     read refuses the run with exit 4 before the compose seam is reached; a
//     journal for disjoint artifacts only warns.
//   * **`--restore <run-id>`** writes the journaled sources back, verifies
//     them, removes the journal and releases only the crashed run's lease row
//     (exit 0); a live writer, a corrupt journal or a different instance is
//     refused (4); no journal is usage (2); an artifact that stays unrestored
//     keeps the journal (3).
//   * **Signals.** A SIGINT through the signal seam aborts the run, the final
//     restore still runs, a second signal is acknowledged (not a skip), and
//     the handlers are removed afterwards.
//   * **Unrestored surfacing.** Entries still journaled after the run are
//     named on stderr and in the `--json` document, and the exit is 3.
//
// Every catalog here is the benchmark package's FIXTURE — not the benchmark set.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RESTORE_JOURNAL_SCHEMA,
  createFileRestoreJournal,
  createMemoryRestoreJournal,
  readRestoreJournal,
  restoreJournalPath,
} from "@tessera/benchmark";

import { EXIT_CODES, main, parseBenchmarkArgs } from "../build/index.js";
import {
  BENCHMARK_RESTORE_RESULT_KIND,
  benchmarkCommand,
} from "../build/benchmarkRun.js";
import { createFakeBench } from "../../benchmark/test/fixtures/fake-substrate.js";
import {
  FIXTURE_GEN_CONFIG,
  buildFixtureCatalog,
} from "../../benchmark/test/fixtures/fixture-catalog.js";

const RUNNER_HOST = "dev-bench.service-now.com";
const RUN_ID = "bench-run-0001";
const CRASHED = "crashed-run";
const T = "sys_script_include";
const LEASE = "u_benchmark_lease";
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const noSleep = async () => {};

const tempRoots = [];
after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-bench-rj-"));
  tempRoots.push(root);
  await fs.writeFile(
    path.join(root, "catalog.json"),
    JSON.stringify(buildFixtureCatalog()),
  );
  await fs.writeFile(
    path.join(root, "gen.json"),
    JSON.stringify(FIXTURE_GEN_CONFIG),
  );
  const out = [];
  const err = [];
  return {
    root,
    ledgerRoot: path.join(root, ".tessera"),
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    context: {
      now: () => new Date("2026-09-26T10:00:00.000Z"),
      actor: "test",
      cwd: root,
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

function runArgv(extra = []) {
  return [
    "--catalog",
    "catalog.json",
    "--gen-config",
    "gen.json",
    "--scope",
    "x_bench",
    "--run-id",
    RUN_ID,
    "--runner",
    "runner",
    "--allow",
    RUNNER_HOST,
    ...extra,
  ];
}

/** A compose seam over the fixture substrate; counts calls. */
function fixtureCompose(extra = {}) {
  const bench = createFakeBench(buildFixtureCatalog());
  const seen = { composed: 0, released: 0 };
  return {
    bench,
    seen,
    compose: async () => {
      seen.composed += 1;
      return {
        substrate: extra.substrate?.(bench.substrate) ?? bench.substrate,
        pipeline: bench.pipeline,
        notes: ["topology: FIXTURE"],
        ...(extra.journal === undefined ? {} : { journal: extra.journal }),
        release() {
          seen.released += 1;
        },
      };
    },
  };
}

/** A signal source the test fires by hand. */
function fakeSignals() {
  const handlers = new Map();
  const log = [];
  return {
    log,
    count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    fire(name) {
      for (const h of [...(handlers.get(name) ?? [])]) h();
    },
    source: {
      on(name, h) {
        log.push(["on", name]);
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(h);
      },
      off(name, h) {
        log.push(["off", name]);
        handlers.get(name)?.delete(h);
      },
    },
  };
}

/** An in-memory Table API; `hooks.patch` may return "drop" (a silent no-op). */
function memoryClient(tables, hooks = {}) {
  const calls = [];
  const client = {
    async request({ method, path: apiPath, params, body }) {
      calls.push({ method, path: apiPath });
      const [, , , , table, id] = apiPath.split("/");
      const rows = (tables[table] ??= []);
      if (method === "GET" && id === undefined) {
        const query = params?.get("sysparm_query") ?? "";
        const holder = query.startsWith("holder=")
          ? query.slice("holder=".length)
          : undefined;
        const out = rows.filter(
          (r) => holder === undefined || r.holder === holder,
        );
        return { status: 200, data: { result: out.map((r) => ({ ...r })) } };
      }
      if (method === "GET") {
        return {
          status: 200,
          data: { result: { ...rows.find((r) => r.sys_id === id) } },
        };
      }
      if (method === "PATCH") {
        if (hooks.patch?.(table, id, body) !== "drop") {
          Object.assign(
            rows.find((r) => r.sys_id === id),
            body,
          );
        }
        return { status: 200, data: { result: {} } };
      }
      if (method === "DELETE") {
        tables[table] = rows.filter((r) => r.sys_id !== id);
        return { status: 204, data: {} };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { client, calls };
}

/** A crashed run's journal on disk: `a1`'s correct source, mutant now live. */
async function crashedJournal(w, overrides = {}) {
  const file = restoreJournalPath(w.ledgerRoot, overrides.runId ?? CRASHED);
  const journal = createFileRestoreJournal({
    file,
    runId: overrides.runId ?? CRASHED,
    runnerProfile: "runner",
    instance:
      overrides.instance === undefined ? RUNNER_HOST : overrides.instance,
    ...(overrides.pid === undefined ? {} : { pid: overrides.pid }),
  });
  for (const [sysId, source] of overrides.entries ?? [["a1", "CORRECT1()"]]) {
    await journal.record({
      table: overrides.table ?? T,
      sysId,
      field: "script",
      sha256: sha(source),
      source,
    });
  }
  return file;
}

function restoreSeams(tables, options = {}) {
  const { client, calls } = memoryClient(tables, options.hooks);
  const seen = { composed: 0, released: 0, runner: undefined };
  return {
    calls,
    seen,
    seams: {
      liveness: options.liveness ?? (() => "dead"),
      sleep: noSleep,
      async composeRestore({ options: o }) {
        seen.composed += 1;
        seen.runner = o.runner;
        return {
          client,
          instance: options.instance ?? RUNNER_HOST,
          runnerProfile: o.runner,
          notes: [],
          release() {
            seen.released += 1;
          },
        };
      },
    },
  };
}

const crashedTables = () => ({
  [T]: [{ sys_id: "a1", script: "MUTANT1()" }],
  [LEASE]: [
    { sys_id: "L1", holder: CRASHED },
    { sys_id: "L2", holder: "someone-else" },
  ],
});

describe("tess benchmark — a pending restore journal refuses the run", () => {
  it("same run id: exit 4 before composition, nothing created", async () => {
    const w = await workspace();
    await crashedJournal(w, { runId: RUN_ID });
    const before = await fs.readdir(w.ledgerRoot, { recursive: true });
    const fx = fixtureCompose();
    const code = await benchmarkCommand(runArgv(), w.context, {
      compose: fx.compose,
    });
    assert.equal(code, EXIT_CODES.refused);
    assert.equal(fx.seen.composed, 0, "the compose seam is never reached");
    assert.match(w.stderr(), /REFUSED \(F4\)/);
    assert.match(w.stderr(), new RegExp(`--restore ${RUN_ID}`));
    assert.deepEqual(
      await fs.readdir(w.ledgerRoot, { recursive: true }),
      before,
      "the scan is read-only",
    );
  });

  it("another run's journal on an artifact this catalog touches: exit 4", async () => {
    const w = await workspace();
    const ref = buildFixtureCatalog().mutants[0].baseArtifact;
    await crashedJournal(w, {
      table: ref.table,
      entries: [[ref.sysId, "anything()"]],
    });
    const fx = fixtureCompose();
    const code = await benchmarkCommand(runArgv(), w.context, {
      compose: fx.compose,
    });
    assert.equal(code, EXIT_CODES.refused);
    assert.equal(fx.seen.composed, 0);
    assert.match(w.stderr(), new RegExp(`${ref.table}/${ref.sysId}`));
    assert.match(w.stderr(), new RegExp(`--restore ${CRASHED}`));
  });

  it("a corrupt journal anywhere refuses (fail closed)", async () => {
    const w = await workspace();
    const file = restoreJournalPath(w.ledgerRoot, CRASHED);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json");
    const fx = fixtureCompose();
    const code = await benchmarkCommand(runArgv(), w.context, {
      compose: fx.compose,
    });
    assert.equal(code, EXIT_CODES.refused);
    assert.equal(fx.seen.composed, 0);
    assert.match(w.stderr(), /corrupt|invalid|JSON/i);
  });

  it("a journal on disjoint artifacts only warns; the run proceeds", async () => {
    const w = await workspace();
    await crashedJournal(w, { entries: [["not-in-catalog", "x()"]] });
    const fx = fixtureCompose();
    const signals = fakeSignals();
    const code = await benchmarkCommand(runArgv(), w.context, {
      compose: fx.compose,
      signals: signals.source,
    });
    assert.equal(fx.seen.composed, 1);
    assert.notEqual(code, EXIT_CODES.refused);
    assert.match(w.stderr(), /warning: run crashed-run has an unrestored/);
  });
});

describe("tess benchmark --restore", () => {
  it("recovers a crash: sources written back and verified, journal cleared, only its own lease row released", async () => {
    const w = await workspace();
    const file = await crashedJournal(w);
    const tables = crashedTables();
    const r = restoreSeams(tables);
    const code = await benchmarkCommand(
      ["--restore", CRASHED, "--allow", RUNNER_HOST, "--json"],
      w.context,
      r.seams,
    );
    assert.equal(code, EXIT_CODES.ok, w.stderr());
    assert.equal(tables[T][0].script, "CORRECT1()");
    assert.deepEqual(
      tables[LEASE].map((row) => row.holder),
      ["someone-else"],
    );
    assert.equal(await readRestoreJournal(file), null);
    assert.equal(r.seen.runner, "runner", "runner defaults to the journal's");
    assert.equal(r.seen.released, 1);
    const doc = JSON.parse(w.stdout());
    assert.equal(doc.kind, BENCHMARK_RESTORE_RESULT_KIND);
    assert.deepEqual(doc.restored, [`${T}/a1`]);
    assert.deepEqual(doc.lease, { status: "released", rows: 1 });

    // …after which the run is no longer refused.
    const fx = fixtureCompose();
    const again = await benchmarkCommand(
      ["--restore", CRASHED],
      w.context,
      r.seams,
    );
    assert.equal(again, EXIT_CODES.usage, "nothing left to restore");
    const run = await benchmarkCommand(runArgv(), w.context, {
      compose: fx.compose,
      signals: fakeSignals().source,
    });
    assert.notEqual(run, EXIT_CODES.refused);
    assert.equal(fx.seen.composed, 1);
  });

  it("an artifact that stays unrestored keeps the journal and the lease: exit 3", async () => {
    const w = await workspace();
    const file = await crashedJournal(w);
    const tables = crashedTables();
    const r = restoreSeams(tables, { hooks: { patch: () => "drop" } });
    const code = await benchmarkCommand(
      ["--restore", CRASHED],
      w.context,
      r.seams,
    );
    assert.equal(code, EXIT_CODES.fault);
    assert.match(w.stderr(), /UNRESTORED: 1 artifact/);
    assert.notEqual(await readRestoreJournal(file), null);
    assert.equal(tables[LEASE].length, 2);
  });

  it("refuses a live writer (default liveness: this very process), unless --ignore-live-pid", async () => {
    const w = await workspace();
    const file = await crashedJournal(w); // pid = process.pid, this host
    const tables = crashedTables();
    const r = restoreSeams(tables);
    const withDefaultLiveness = { ...r.seams };
    delete withDefaultLiveness.liveness;
    const code = await benchmarkCommand(
      ["--restore", CRASHED],
      w.context,
      withDefaultLiveness,
    );
    assert.equal(code, EXIT_CODES.refused);
    assert.match(w.stderr(), /still running/);
    assert.equal(r.seen.composed, 0);
    assert.equal(tables[T][0].script, "MUTANT1()");

    const forced = await benchmarkCommand(
      ["--restore", CRASHED, "--ignore-live-pid"],
      w.context,
      withDefaultLiveness,
    );
    assert.equal(forced, EXIT_CODES.ok);
    assert.equal(tables[T][0].script, "CORRECT1()");
    assert.equal(await readRestoreJournal(file), null);
  });

  it("refuses a runner that is not the journal's instance; writes nothing", async () => {
    const w = await workspace();
    const file = await crashedJournal(w);
    const tables = crashedTables();
    const r = restoreSeams(tables, { instance: "other.service-now.com" });
    const code = await benchmarkCommand(
      ["--restore", CRASHED],
      w.context,
      r.seams,
    );
    assert.equal(code, EXIT_CODES.refused);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      [],
    );
    assert.equal(r.seen.released, 1, "the composition is still released");
    assert.notEqual(await readRestoreJournal(file), null);
  });

  it("refuses a corrupt journal (4); no journal is usage (2)", async () => {
    const w = await workspace();
    const file = restoreJournalPath(w.ledgerRoot, CRASHED);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ schema: RESTORE_JOURNAL_SCHEMA, runId: CRASHED }),
    );
    const r = restoreSeams(crashedTables());
    assert.equal(
      await benchmarkCommand(["--restore", CRASHED], w.context, r.seams),
      EXIT_CODES.refused,
    );
    assert.equal(r.seen.composed, 0);
    assert.equal(
      await benchmarkCommand(["--restore", "never-ran"], w.context, r.seams),
      EXIT_CODES.usage,
    );
  });

  it("usage (2): run-only flags next to --restore, --ignore-live-pid alone, a bad run id", async () => {
    const w = await workspace();
    for (const argv of [
      ["benchmark", "--restore", CRASHED, "--catalog", "catalog.json"],
      ["benchmark", "--restore", CRASHED, "--repetitions", "5"],
      ["benchmark", "--restore", "../escape"],
      ["benchmark", "--restore"],
      ["benchmark", ...runArgv(["--ignore-live-pid"])],
    ]) {
      assert.equal(
        await main(argv, w.context),
        EXIT_CODES.usage,
        argv.join(" "),
      );
    }
    const parsed = parseBenchmarkArgs(
      ["--restore", CRASHED, "--runner", "r", "--allow", RUNNER_HOST],
      w.context,
    );
    assert.equal(parsed.kind, "restore");
    assert.equal(parsed.options.runner, "r");
    assert.equal(parsed.options.ignoreLivePid, false);
  });

  it("documents --restore and --ignore-live-pid in its help", async () => {
    const w = await workspace();
    await main(["benchmark", "--help"], w.context);
    assert.match(w.stdout(), /--restore <run-id>/);
    assert.match(w.stdout(), /--ignore-live-pid/);
    assert.match(w.stdout(), /second\s+signal/);
  });
});

describe("tess benchmark — signals and unrestored surfacing", () => {
  it("SIGINT mid-run aborts, the final restore still runs, a second signal is acknowledged, handlers are removed", async () => {
    const w = await workspace();
    const signals = fakeSignals();
    let fired = false;
    const fx = fixtureCompose({
      substrate: (inner) => {
        const wrapped = Object.create(inner);
        wrapped.applySource = async (...args) => {
          const result = await inner.applySource(...args);
          if (!fired) {
            fired = true;
            signals.fire("SIGINT");
            signals.fire("SIGTERM");
          }
          return result;
        };
        return wrapped;
      },
    });
    const code = await benchmarkCommand(runArgv(["--json"]), w.context, {
      compose: fx.compose,
      signals: signals.source,
    });
    assert.equal(fired, true);
    assert.equal(code, EXIT_CODES.inconclusive);
    const doc = JSON.parse(w.stdout());
    assert.equal(doc.s5.status, "void");
    assert.match(JSON.stringify(doc.s5), /aborted/);
    assert.ok(
      fx.bench.calls.resetRunIds.includes(`${RUN_ID}:final`),
      "the final restore ran on the abort path",
    );
    assert.match(w.stderr(), /SIGINT received — aborting/);
    assert.match(w.stderr(), /SIGTERM received again — ignored/);
    assert.equal(signals.count(), 0, "every handler was removed");
    assert.deepEqual(
      signals.log.filter(([op]) => op === "off").map(([, s]) => s),
      ["SIGINT", "SIGTERM"],
    );
    assert.equal(fx.seen.released, 1);
  });

  it("entries still journaled after the run are named on stderr and in --json; exit 3", async () => {
    const w = await workspace();
    const journal = createMemoryRestoreJournal(RUN_ID);
    await journal.record({
      table: T,
      sysId: "stuck1",
      field: "script",
      sha256: sha("ok()"),
      source: "ok()",
    });
    const fx = fixtureCompose({ journal });
    const code = await benchmarkCommand(runArgv(["--json"]), w.context, {
      compose: fx.compose,
      signals: fakeSignals().source,
    });
    assert.equal(code, EXIT_CODES.fault);
    const doc = JSON.parse(w.stdout());
    assert.equal(doc.exitCode, EXIT_CODES.fault);
    assert.equal(doc.unrestored.recover, `tess benchmark --restore ${RUN_ID}`);
    assert.deepEqual(
      doc.unrestored.artifacts.map((a) => `${a.table}/${a.sysId}`),
      [`${T}/stuck1`],
    );
    assert.match(w.stderr(), /UNRESTORED: .*1 artifact/);
    assert.match(w.stderr(), new RegExp(`${T}/stuck1`));
  });
});
