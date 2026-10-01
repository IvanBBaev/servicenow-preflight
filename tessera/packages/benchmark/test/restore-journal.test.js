// review-w7a F4/F5 — a benchmark run that dies mid-mutant must never let the
// next run adopt the live mutant as "correct", and a final restore must try
// every artifact, verify it, and keep a durable record of what it could not
// put back.
//
// Every catalog here is FIXTURE — not the benchmark set.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BenchmarkSubstrateError,
  CatalogError,
  DEFAULT_LEASE_TABLE,
  DESIGN_GATE_POLICY,
  RESTORE_JOURNAL_FILENAME,
  RestoreJournalError,
  createFileRestoreJournal,
  createInstanceBenchmarkSubstrate,
  createMemoryRestoreJournal,
  findRestoreJournals,
  loadCatalog,
  readRestoreJournal,
  restoreFromJournal,
  restoreJournalPath,
  runBenchmark,
} from "../build/index.js";
import { buildFixtureCatalog } from "./fixtures/fixture-catalog.js";

const T = "sys_script_include";
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const signOff = { by: "QA", at: "2026-09-01" };
const noSleep = async () => {};

const probe = {
  async readTable() {
    return { outcome: "readable", detail: "ok" };
  },
  async readProperty() {
    return { outcome: "found", value: "build-1", detail: "" };
  },
};

/**
 * An in-memory Table API behind the port. `hooks.patch(table, id, body, n)`
 * may throw (a failed PATCH) or return "drop" (answer 200 but write nothing —
 * the silent-no-op a verify read must catch). Every call is logged.
 */
function memoryClient(tables, hooks = {}) {
  const calls = [];
  let n = 0;
  let patches = 0;
  const client = {
    async request({ method, path: apiPath, params, body }) {
      calls.push({ method, path: apiPath, body });
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
      if (method === "POST") {
        n += 1;
        const row = { sys_id: `r${n}`, ...body };
        rows.push(row);
        return { status: 201, data: { result: { ...row } } };
      }
      if (method === "PATCH") {
        patches += 1;
        const verdict = hooks.patch?.(table, id, body, patches);
        if (verdict !== "drop") {
          Object.assign(
            rows.find((r) => r.sys_id === id),
            body,
          );
        }
        return { status: 200, data: { result: {} } };
      }
      tables[table] = rows.filter((r) => r.sys_id !== id);
      return { status: 204, data: {} };
    },
  };
  return { client, calls };
}

function tableWith(rows) {
  return {
    [T]: rows.map(([sys_id, script]) => ({ sys_id, script })),
    [DEFAULT_LEASE_TABLE]: [],
  };
}

const live = (tables, id) => tables[T].find((r) => r.sys_id === id).script;

/** A two-artifact catalog shape the substrate accepts (not loader-validated). */
function smallCatalog(extra = {}) {
  return {
    mutants: [
      {
        id: "m1",
        category: "script-include",
        baseArtifact: { table: T, sysId: "a1", name: "a1" },
        behaviour: "b",
        diff: "replace:MUTANT1()",
        expectedVerdict: "red",
        signOff,
        diffSha256: sha("replace:MUTANT1()"),
        ...(extra.m1 ?? {}),
      },
    ],
    baselines: [
      {
        id: "b1",
        artifact: { table: T, sysId: "a2", name: "a2" },
        behaviour: "b",
        detonator: { diff: "replace:BROKEN2()", signOff },
        signOff,
        detonatorSha256: sha("replace:BROKEN2()"),
        ...(extra.b1 ?? {}),
      },
    ],
  };
}

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tessera-journal-"));
}

const a1 = { table: T, sysId: "a1", name: "a1" };
const a2 = { table: T, sysId: "a2", name: "a2" };

describe("restore journal — durable file", () => {
  it("is written before the first PATCH, with table/sys_id/field/sha256/source", async () => {
    const root = await tmpRoot();
    const file = restoreJournalPath(root, "run-1");
    const tables = tableWith([["a1", "CORRECT1()"]]);
    const seenAtPatch = [];
    const { client } = memoryClient(tables, {
      patch() {
        seenAtPatch.push(
          // Synchronous: the file as it stood when the PATCH reached the wire.
          JSON.parse(readFileSync(file, "utf8")).entries.map((e) => e.sysId),
        );
      },
    });
    const journal = createFileRestoreJournal({
      file,
      runId: "run-1",
      runnerProfile: "runner",
      instance: "dev.example.com",
    });
    const substrate = createInstanceBenchmarkSubstrate({
      client,
      probe,
      journal,
      catalog: smallCatalog(),
    });
    await substrate.applySource(a1, "b", {
      kind: "mutant",
      id: "m1",
      diff: "replace:MUTANT1()",
    });
    assert.deepEqual(seenAtPatch, [["a1"]]);
    const doc = await readRestoreJournal(file);
    assert.equal(doc.runId, "run-1");
    assert.equal(doc.instance, "dev.example.com");
    assert.equal(doc.pid, process.pid);
    assert.deepEqual(doc.entries, [
      {
        table: T,
        sysId: "a1",
        field: "script",
        sha256: sha("CORRECT1()"),
        source: "CORRECT1()",
      },
    ]);
    assert.equal(path.basename(file), RESTORE_JOURNAL_FILENAME);
  });

  it("a second journal for the same file refuses (exclusive create) and leaves the first intact", async () => {
    const root = await tmpRoot();
    const file = restoreJournalPath(root, "run-1");
    const opts = { file, runId: "run-1", runnerProfile: "p", instance: null };
    const first = createFileRestoreJournal(opts);
    const entry = {
      table: T,
      sysId: "a1",
      field: "script",
      sha256: sha("X"),
      source: "X",
    };
    await first.record(entry);
    const second = createFileRestoreJournal(opts);
    await assert.rejects(
      () => second.record({ ...entry, source: "Y", sha256: sha("Y") }),
      RestoreJournalError,
    );
    assert.equal((await readRestoreJournal(file)).entries[0].source, "X");
  });

  it("a journal whose entry does not match its sha256 is refused as corrupt", async () => {
    const root = await tmpRoot();
    const file = restoreJournalPath(root, "run-1");
    const j = createFileRestoreJournal({
      file,
      runId: "run-1",
      runnerProfile: "p",
      instance: null,
    });
    await j.record({
      table: T,
      sysId: "a1",
      field: "script",
      sha256: sha("X"),
      source: "X",
    });
    const doc = JSON.parse(await fs.readFile(file, "utf8"));
    doc.entries[0].source = "tampered";
    await fs.writeFile(file, JSON.stringify(doc));
    await assert.rejects(() => readRestoreJournal(file), RestoreJournalError);
    const found = await findRestoreJournals(root);
    assert.equal(found.length, 1);
    assert.ok(found[0].error instanceof RestoreJournalError);
  });

  it("findRestoreJournals is empty (and creates nothing) for a missing ledger root", async () => {
    const root = path.join(await tmpRoot(), "absent");
    assert.deepEqual(await findRestoreJournals(root), []);
    await assert.rejects(() => fs.stat(root));
  });
});

describe("F4 — a crash mid-mutant never becomes the next run's 'correct'", () => {
  it("crash, then refusal at capture, then restoreFromJournal recovers the original", async () => {
    const root = await tmpRoot();
    const file = restoreJournalPath(root, "crashed");
    const tables = tableWith([["a1", "CORRECT1()"]]);
    tables[DEFAULT_LEASE_TABLE].push(
      { sys_id: "L1", holder: "crashed" },
      { sys_id: "L2", holder: "someone-else" },
    );
    const { client, calls } = memoryClient(tables);

    // Process 1: applies the mutant and dies (no restore).
    const s1 = createInstanceBenchmarkSubstrate({
      client,
      probe,
      journal: createFileRestoreJournal({
        file,
        runId: "crashed",
        runnerProfile: "p",
        instance: "dev.example.com",
      }),
      catalog: smallCatalog(),
    });
    await s1.applySource(a1, "b", {
      kind: "mutant",
      id: "m1",
      diff: "replace:MUTANT1()",
    });
    assert.equal(live(tables, "a1"), "MUTANT1()");

    // Process 2: a fresh substrate refuses to capture the mutant as correct.
    const s2 = createInstanceBenchmarkSubstrate({
      client,
      probe,
      journal: createMemoryRestoreJournal(),
      catalog: smallCatalog(),
    });
    const patchesBefore = calls.filter((c) => c.method === "PATCH").length;
    await assert.rejects(
      () => s2.applySource(a1, "b", { kind: "correct" }),
      (error) =>
        error instanceof BenchmarkSubstrateError &&
        /mutant/.test(error.message) &&
        /--restore/.test(error.message),
    );
    assert.equal(
      calls.filter((c) => c.method === "PATCH").length,
      patchesBefore,
      "a refused capture writes nothing",
    );
    // The drift smoke-test also reads a live mutant text as red.
    assert.equal(
      await s2.smokeBaseline(
        { ...smallCatalog().baselines[0], artifact: a1 },
        "run-2",
      ),
      "red",
    );

    // Recovery.
    const result = await restoreFromJournal({
      client,
      document: await readRestoreJournal(file),
      file,
      sleep: noSleep,
    });
    assert.deepEqual(result.unrestored, []);
    assert.deepEqual(result.restored, [`${T}/a1`]);
    assert.equal(result.cleared, true);
    assert.deepEqual(result.lease, { status: "released", rows: 1 });
    assert.equal(live(tables, "a1"), "CORRECT1()");
    assert.deepEqual(
      tables[DEFAULT_LEASE_TABLE].map((r) => r.holder),
      ["someone-else"],
      "only the crashed run's own lease row is released",
    );
    assert.equal(await readRestoreJournal(file), null);
  });

  it("restoreFromJournal keeps the journal and the lease when an artifact stays unrestored", async () => {
    const root = await tmpRoot();
    const file = restoreJournalPath(root, "crashed");
    const tables = tableWith([
      ["a1", "MUTANT1()"],
      ["a2", "BROKEN2()"],
    ]);
    tables[DEFAULT_LEASE_TABLE].push({ sys_id: "L1", holder: "crashed" });
    const { client } = memoryClient(tables, {
      patch(_t, id) {
        if (id === "a1") throw new Error("403 forbidden");
      },
    });
    const j = createFileRestoreJournal({
      file,
      runId: "crashed",
      runnerProfile: "p",
      instance: null,
    });
    for (const [id, src] of [
      ["a1", "CORRECT1()"],
      ["a2", "CORRECT2()"],
    ]) {
      await j.record({
        table: T,
        sysId: id,
        field: "script",
        sha256: sha(src),
        source: src,
      });
    }
    const result = await restoreFromJournal({
      client,
      document: await readRestoreJournal(file),
      file,
      sleep: noSleep,
    });
    assert.deepEqual(result.restored, [`${T}/a2`]);
    assert.equal(result.unrestored.length, 1);
    assert.equal(result.unrestored[0].artifact, `${T}/a1`);
    assert.equal(result.cleared, false);
    assert.equal(result.lease.status, "kept");
    assert.equal(tables[DEFAULT_LEASE_TABLE].length, 1);
    assert.equal(live(tables, "a2"), "CORRECT2()");
    assert.equal((await readRestoreJournal(file)).entries.length, 2);
  });

  it("refuses to capture a live detonator text as correct", async () => {
    const tables = tableWith([["a2", "BROKEN2()"]]);
    const { client } = memoryClient(tables);
    const s = createInstanceBenchmarkSubstrate({
      client,
      probe,
      journal: createMemoryRestoreJournal(),
      catalog: smallCatalog(),
    });
    await assert.rejects(
      () => s.applySource(a2, "b", { kind: "correct" }),
      /detonator/,
    );
  });

  it("refuses a capture whose sha256 contradicts the catalog's correctSha256", async () => {
    const tables = tableWith([["a1", "SOMETHING-ELSE()"]]);
    const { client } = memoryClient(tables);
    const catalog = smallCatalog({ m1: { correctSha256: sha("CORRECT1()") } });
    const s = createInstanceBenchmarkSubstrate({
      client,
      probe,
      journal: createMemoryRestoreJournal(),
      catalog,
    });
    await assert.rejects(
      () => s.applySource(a1, "b", { kind: "correct" }),
      /correctSha256/,
    );
    tables[T][0].script = "CORRECT1()";
    await s.applySource(a1, "b", { kind: "correct" });
  });

  it("refuses any capture while no catalog is bound (fail closed)", async () => {
    const tables = tableWith([["a1", "CORRECT1()"]]);
    const { client, calls } = memoryClient(tables);
    const s = createInstanceBenchmarkSubstrate({
      client,
      probe,
      journal: createMemoryRestoreJournal(),
    });
    await assert.rejects(
      () => s.applySource(a1, "b", { kind: "correct" }),
      /catalog/,
    );
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
    s.bindCatalog(smallCatalog());
    await s.applySource(a1, "b", { kind: "correct" });
  });
});

describe("F5 — reset and final restore attempt every artifact", () => {
  async function touched(hooks, journal = createMemoryRestoreJournal()) {
    const tables = tableWith([
      ["a1", "CORRECT1()"],
      ["a2", "CORRECT2()"],
    ]);
    let failing = false;
    const { client } = memoryClient(tables, {
      patch: (t, id, body, n) => (failing ? hooks(t, id, body, n) : undefined),
    });
    const s = createInstanceBenchmarkSubstrate({
      client,
      probe,
      journal,
      catalog: smallCatalog(),
      sleep: noSleep,
    });
    await s.applySource(a1, "b", {
      kind: "mutant",
      id: "m1",
      diff: "replace:MUTANT1()",
    });
    await s.applySource(a2, "b", {
      kind: "detonator",
      id: "b1",
      diff: "replace:BROKEN2()",
    });
    failing = true;
    return { tables, journal, s };
  }

  it("resetScope attempts every artifact and throws one aggregate error", async () => {
    const { tables, s } = await touched((_t, id) => {
      if (id === "a1") throw new Error("boom a1");
    });
    await assert.rejects(
      () => s.resetScope("run-1"),
      (error) =>
        error instanceof BenchmarkSubstrateError &&
        /a1/.test(error.message) &&
        !/\/a2/.test(error.message),
    );
    assert.equal(live(tables, "a2"), "CORRECT2()", "a2 was still attempted");
  });

  it("restoreFinal retries a transient failure and clears the journal on verified success", async () => {
    let a1Fails = 2;
    const { tables, journal, s } = await touched((_t, id) => {
      if (id === "a1" && a1Fails > 0) {
        a1Fails -= 1;
        throw new Error("transient");
      }
    });
    await s.restoreFinal("run-1:final");
    assert.equal(live(tables, "a1"), "CORRECT1()");
    assert.equal(live(tables, "a2"), "CORRECT2()");
    assert.deepEqual(journal.entries(), []);
  });

  it("restoreFinal verifies by re-reading: a silently dropped PATCH is unrestored, journal kept", async () => {
    const file = restoreJournalPath(await tmpRoot(), "run-1");
    const { tables, journal, s } = await touched(
      (_t, id) => (id === "a1" ? "drop" : undefined),
      createFileRestoreJournal({
        file,
        runId: "run-1",
        runnerProfile: "p",
        instance: "dev.example.com",
      }),
    );
    await assert.rejects(
      () => s.restoreFinal("run-1:final"),
      (error) =>
        /UNRESTORED/.test(error.message) &&
        /a1/.test(error.message) &&
        /tess benchmark --restore run-1/.test(error.message),
    );
    assert.equal(live(tables, "a1"), "MUTANT1()");
    assert.equal(live(tables, "a2"), "CORRECT2()");
    assert.deepEqual(
      journal.entries().map((e) => e.sysId),
      ["a1"],
      "the journal keeps exactly the unrestored artifact",
    );
    assert.deepEqual(
      (await readRestoreJournal(file)).entries.map((e) => e.sysId),
      ["a1"],
      "…durably, on disk",
    );
  });

  it("restoreFinal gives up after bounded attempts (3)", async () => {
    let a1Attempts = 0;
    const { s } = await touched((_t, id) => {
      if (id === "a1") {
        a1Attempts += 1;
        throw new Error("down");
      }
    });
    await assert.rejects(() => s.restoreFinal("run-1:final"), /UNRESTORED/);
    assert.equal(a1Attempts, 3);
  });
});

describe("F4 — an abort mid-rep still runs the final restore", () => {
  it("SIGINT-style abort between reps: void 'aborted', every artifact restored, lease released", async () => {
    const tables = tableWith([
      ["a1", "CORRECT1()"],
      ["a2", "CORRECT2()"],
    ]);
    const { client } = memoryClient(tables);
    const controller = new AbortController();
    const journal = createMemoryRestoreJournal();
    let generated = 0;
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
          generated += 1;
          return graph.nodes.map((node) => ({
            ref: { id: node.sysId, path: "p" },
            payload: { sysId: node.sysId, expected: live(tables, node.sysId) },
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
          // Abort while the mutant is live, after the first rep's run.
          if (ctx.runId.endsWith(":mutant")) {
            controller.abort(new Error("SIGINT"));
          }
          return {
            runId: ctx.runId,
            outcomes: specs.map((spec) => ({
              spec: spec.ref,
              raw:
                live(tables, spec.payload.sysId) === spec.payload.expected
                  ? "pass"
                  : "fail",
            })),
          };
        },
      },
    };
    const catalog = { catalogVersion: "v", fixture: true, mutantSetHash: "h" };
    const record = await runBenchmark({
      runId: "run-1",
      catalog: { ...catalog, ...smallCatalog() },
      genConfig: {
        modelId: "m",
        temperature: 0,
        maxTokens: 10,
        promptHash: "a".repeat(64),
        promptVersion: "1",
      },
      policy: DESIGN_GATE_POLICY,
      repetitions: 3,
      substrate: createInstanceBenchmarkSubstrate({
        client,
        probe,
        journal,
        sleep: noSleep,
      }),
      pipeline,
      signal: controller.signal,
    });
    assert.equal(record.result.status, "void");
    assert.deepEqual(
      record.result.reasons.map((r) => r.code),
      ["aborted"],
    );
    assert.equal(generated, 1, "the harness stopped at the next rep boundary");
    assert.equal(live(tables, "a1"), "CORRECT1()");
    assert.deepEqual(journal.entries(), []);
    assert.deepEqual(tables[DEFAULT_LEASE_TABLE], []);
  });
});

describe("catalog — optional correctSha256", () => {
  it("is validated, must agree per artifact, and changes the hash only when present", () => {
    const raw = buildFixtureCatalog();
    const base = loadCatalog(raw, DESIGN_GATE_POLICY);
    assert.equal(
      base.mutants.some((m) => "correctSha256" in m),
      false,
    );

    const withSha = structuredClone(raw);
    withSha.mutants[0].correctSha256 = sha("(x) => x + 1");
    const pinned = loadCatalog(withSha, DESIGN_GATE_POLICY);
    assert.equal(pinned.mutants[0].correctSha256, sha("(x) => x + 1"));
    assert.notEqual(pinned.mutantSetHash, base.mutantSetHash);

    const bad = structuredClone(raw);
    bad.baselines[0].correctSha256 = "not-a-hash";
    assert.throws(
      () => loadCatalog(bad, DESIGN_GATE_POLICY),
      (e) =>
        e instanceof CatalogError &&
        e.problems.some((p) => /correctSha256/.test(p)),
    );

    const conflict = structuredClone(raw);
    conflict.mutants[1].baseArtifact = { ...conflict.mutants[0].baseArtifact };
    conflict.mutants[1].behaviour = "another behaviour";
    conflict.mutants[0].correctSha256 = sha("A");
    conflict.mutants[1].correctSha256 = sha("B");
    assert.throws(
      () => loadCatalog(conflict, DESIGN_GATE_POLICY),
      (e) =>
        e instanceof CatalogError &&
        e.problems.some((p) => /conflicting correctSha256/.test(p)),
    );
  });
});
