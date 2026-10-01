// FIXTURE — not the benchmark set.
//
// Test-side adapters proving the harness wiring against @tessera/fake-instance:
// the benchmark "scope" is the fake instance's tables (target source in
// `sys_script_include.script`, the platform stamp in `sys_properties`, staged
// specs in `sys_atf_test`, the lease in `u_benchmark_lease`), and SUB-5's
// fresh scope is the fake's own `reset()` back to its seeded state. The runner
// evaluates the toy source with node:vm; nothing contacts a real instance.

import vm from "node:vm";

import { createFakeInstance } from "@tessera/fake-instance";

import { correctSources } from "./fixture-catalog.js";

const SCRIPT_TABLE = "sys_script_include";
const LEASE_TABLE = "u_benchmark_lease";
const SPEC_TABLE = "sys_atf_test";
const PROBE_INPUT = 1;

// Delegated decision 2026-09-30 (wave 14): no `timeout` on the vm call.
// `timeout` is a WALL-CLOCK watchdog; under parallel CPU load compiling a
// fresh context occasionally exceeded 100 ms and threw "Script execution timed
// out", which surfaced as a random drift-smoke-red / inconclusive-run / void in
// whichever harness test happened to be running. Every script evaluated here is
// fixture-authored, loop-free arithmetic (`(x) => x + K` and the diffs in
// fixture-catalog.js), so the guard bought nothing and made the verdict depend
// on scheduler timing. Compiled functions are memoised per source string (they
// are pure), which also removes almost all of the per-call context cost.
const compiled = new Map();

function evaluate(script, input) {
  let fn = compiled.get(script);
  if (fn === undefined) {
    fn = vm.runInNewContext(script, {});
    if (typeof fn !== "function") {
      throw new TypeError("fixture source did not evaluate to a function");
    }
    compiled.set(script, fn);
  }
  return fn(input);
}

function applyDiff(diff) {
  if (!diff.startsWith("replace:")) throw new Error(`unknown diff form`);
  return diff.slice("replace:".length);
}

/**
 * Build a fake substrate + pipeline for a raw fixture catalog.
 *
 * @param {object} raw fixture catalog (see fixture-catalog.js)
 * @param {object} [o] behaviour switches, each defaulting to healthy
 */
export function createFakeBench(raw, o = {}) {
  const sources = correctSources(raw);
  const drifted = new Set(o.drifted ?? []);
  const state = {
    [SCRIPT_TABLE]: Object.entries(sources).map(([sysId, script]) => ({
      sys_id: sysId,
      // A drifted baseline's UNCHANGED source on the instance is not the
      // catalog's correct source — what an upgrade would do.
      script: drifted.has(sysId) ? "(x) => x - 1" : script,
    })),
    sys_properties: [
      {
        sys_id: "fxprop0001",
        name: "glide.buildname",
        value: o.platformVersion ?? "FIXTURE-build",
      },
    ],
  };
  const instance = createFakeInstance({ state, seed: "benchmark-fixture" });
  // The lease lives OUTSIDE the resettable scope: resetting the benchmark
  // scope must never drop another run's ownership marker.
  let leaseHolder = o.leaseHeldBy ?? null;
  const calls = {
    resets: 0,
    resetRunIds: [],
    resetsAtRelease: null,
    applied: [],
    runIds: [],
    generateRunIds: [],
    released: 0,
    leaseAcquired: 0,
    smoked: 0,
  };
  const scriptOf = (sysId) =>
    instance.tables.all(SCRIPT_TABLE).find((r) => r.sys_id === sysId)?.script;

  const substrate = {
    async checkHealthy() {
      if (o.healthCheckRejects) throw new Error("ECONNRESET (hibernating)");
      return o.unhealthy
        ? { ok: false, detail: "wake interstitial served (FIXTURE)" }
        : { ok: true, detail: "awake" };
    },
    async checkAttributionJoinPinned() {
      return o.joinUnpinned
        ? { ok: false, detail: "join field not pinned (FIXTURE)" }
        : { ok: true, detail: "pinned" };
    },
    async acquireRunnerLease(runId) {
      if (leaseHolder !== null) return null;
      leaseHolder = runId;
      calls.leaseAcquired += 1;
      instance.tables.insert(LEASE_TABLE, { holder: runId });
      return {
        async release() {
          calls.released += 1;
          calls.resetsAtRelease = calls.resets;
          leaseHolder = null;
          if (o.releaseRejects) throw new Error("release failed (FIXTURE)");
        },
      };
    },
    async resetScope(runId) {
      if (o.resetFailsOn !== undefined && runId.includes(o.resetFailsOn)) {
        throw new Error("scope reinstall failed (FIXTURE)");
      }
      calls.resets += 1;
      calls.resetRunIds.push(runId);
      instance.reset();
    },
    async platformVersion() {
      return instance.tables
        .all("sys_properties")
        .find((r) => r.name === "glide.buildname").value;
    },
    async applySource(target, _behaviour, variant) {
      calls.applied.push({ sysId: target.sysId, kind: variant.kind });
      const row = instance.tables
        .all(SCRIPT_TABLE)
        .find((r) => r.sys_id === target.sysId);
      if (row === undefined) throw new Error(`no source row ${target.sysId}`);
      const script =
        variant.kind === "correct"
          ? sources[target.sysId]
          : applyDiff(variant.diff);
      instance.tables.update(SCRIPT_TABLE, target.sysId, { script });
    },
    async smokeBaseline(baseline) {
      calls.smoked += 1;
      const script = scriptOf(baseline.artifact.sysId);
      const expected = evaluate(sources[baseline.artifact.sysId], PROBE_INPUT);
      return evaluate(script, PROBE_INPUT) === expected ? "green" : "red";
    },
  };

  const vacuous = new Set(o.vacuous ?? []);
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
      async generate(ctx, graph, kind) {
        calls.generateRunIds.push(ctx.runId);
        return graph.nodes.map((node) => {
          // A vacuous suite asserts nothing; `vacuousOnRep` makes a target
          // vacuous in one rep only (a nondeterministic generator).
          const repTag = /:r(\d+):/.exec(ctx.runId)?.[1];
          const isVacuous =
            vacuous.has(node.sysId) ||
            (o.vacuousOnRep?.[node.sysId] !== undefined &&
              String(o.vacuousOnRep[node.sysId]) === repTag);
          return {
            ref: { id: `fx-${node.sysId}`, path: `bench/${node.sysId}.js` },
            kind,
            targets: [node],
            payload: {
              sysId: node.sysId,
              input: PROBE_INPUT,
              // Expected value read from the CORRECT source on the instance.
              expected: evaluate(scriptOf(node.sysId), PROBE_INPUT),
              assert: !isVacuous,
            },
          };
        });
      },
    },
    store: {
      async project(ctx, specs) {
        const map = {};
        for (const spec of specs) {
          const row = instance.tables.insert(SPEC_TABLE, {
            name: spec.ref.id,
            u_run_id: ctx.runId,
          });
          map[`${spec.ref.id}\u0000${spec.ref.path}`] = {
            testSysId: row.sys_id,
            suiteSysId: "fxsuite",
            runId: ctx.runId,
          };
        }
        return map;
      },
      async teardown(ctx) {
        for (const row of instance.tables.all(SPEC_TABLE)) {
          if (row.u_run_id === ctx.runId) {
            instance.tables.remove(SPEC_TABLE, row.sys_id);
          }
        }
        if (o.teardownRejects) throw new Error("teardown failed (FIXTURE)");
      },
    },
    runner: {
      kinds: ["unit"],
      supports: () => true,
      async run(ctx, specs, emit) {
        calls.runIds.push(ctx.runId);
        if (o.runnerRejects) throw new Error("runner offline (FIXTURE)");
        if (
          o.runnerRejectsOn !== undefined &&
          ctx.runId.endsWith(o.runnerRejectsOn)
        ) {
          throw new Error("runner offline (FIXTURE)");
        }
        if (ctx.projection === undefined) throw new Error("not staged");
        const outcomes = specs.map((spec) => {
          if (o.rawOverride !== undefined) {
            return { spec: spec.ref, raw: o.rawOverride };
          }
          let raw = "pass";
          if (spec.payload.assert) {
            try {
              const actual = evaluate(
                scriptOf(spec.payload.sysId),
                spec.payload.input,
              );
              raw = actual === spec.payload.expected ? "pass" : "fail";
            } catch {
              raw = "fail";
            }
          }
          emit({ kind: raw, runId: ctx.runId, spec: spec.ref, assertion: "" });
          return { spec: spec.ref, raw };
        });
        if (o.abortController !== undefined && calls.runIds.length === 3) {
          o.abortController.abort(new Error("operator abort (FIXTURE)"));
        }
        return {
          runId: o.wrongRunId ? `${ctx.runId}-other` : ctx.runId,
          outcomes,
        };
      },
    },
  };
  return {
    instance,
    substrate,
    pipeline,
    calls,
    leaseHolder: () => leaseHolder,
    /** True when every target's live source is its catalog-correct source. */
    allSourcesCorrect: () =>
      instance.tables
        .all(SCRIPT_TABLE)
        .every((row) => row.script === sources[row.sys_id]),
    specRows: () => instance.tables.all(SPEC_TABLE).length,
  };
}
