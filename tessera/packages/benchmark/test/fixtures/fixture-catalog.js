// FIXTURE — not the benchmark set.
//
// A synthetic catalog built only to exercise the loader, the scorer and the
// harness. Every entry is machine-generated arithmetic over a toy "script"
// (`(x) => x + K`); none of it is a ServiceNow fault, none of it was reviewed,
// and the sign-offs name a fixture, not a person. The real catalog is
// hand-authored by the human QA owner (DESIGN §13.4) and is never produced by
// code. Every catalog built here carries `fixture: true`, which forces any
// finding built from it to `open`.
//
// This file lives under test/fixtures/ and is not a `*.test.js`, so the
// package's test glob never runs it, and nothing in src/ references it.

import { instructionHashFor } from "@tessera/generate";

export const FIXTURE_LABEL = "FIXTURE — not the benchmark set";

export const FIXTURE_SIGN_OFF = Object.freeze({
  by: "FIXTURE (not a reviewer)",
  at: "2026-09-23",
});

export const CATEGORIES = [
  "business-rule",
  "acl",
  "client-script-ui-policy",
  "flow-subflow",
  "script-include",
  "data-reference-integrity",
];

/** The toy correct source of a target: adds its own constant. */
export function correctSource(k) {
  return `(x) => x + ${k}`;
}

/**
 * Build a raw (unvalidated) fixture catalog.
 *
 * @param {object} [options]
 * @param {number} [options.perCategory=5] mutants per category
 * @param {number} [options.baselines=35]  correct-code baselines
 * @param {Iterable<string>} [options.blind] mutant ids whose fault only shows
 *   on an input the fixture generator never tests (they will NOT be caught)
 */
export function buildFixtureCatalog(options = {}) {
  const perCategory = options.perCategory ?? 5;
  const baselineCount = options.baselines ?? 35;
  const blind = new Set(options.blind ?? []);
  const mutants = [];
  let k = 0;
  for (const category of CATEGORIES) {
    for (let i = 0; i < perCategory; i += 1) {
      k += 1;
      const id = `fx-m-${category}-${i}`;
      mutants.push({
        id,
        category,
        baseArtifact: {
          table: "sys_script_include",
          sysId: `fxm${String(k).padStart(4, "0")}`,
          name: `FixtureMutantTarget${k}`,
        },
        behaviour: "adds its constant",
        diff: blind.has(id)
          ? `replace:(x) => (x === 999 ? 0 : x + ${k})`
          : `replace:(x) => x + ${k} + 1`,
        expectedVerdict: "red",
        signOff: { ...FIXTURE_SIGN_OFF },
      });
    }
  }
  const baselines = [];
  for (let i = 0; i < baselineCount; i += 1) {
    const n = 1000 + i;
    baselines.push({
      id: `fx-b-${i}`,
      artifact: {
        table: "sys_script_include",
        sysId: `fxb${String(n).padStart(4, "0")}`,
        name: `FixtureBaselineTarget${n}`,
      },
      behaviour: "adds its constant",
      detonator: {
        diff: `replace:(x) => { throw new Error("detonated ${n} " + x); }`,
        signOff: { ...FIXTURE_SIGN_OFF },
      },
      signOff: { ...FIXTURE_SIGN_OFF },
    });
  }
  return {
    catalogVersion: `${FIXTURE_LABEL} v1`,
    fixture: true,
    mutants,
    baselines,
  };
}

/** The correct source of every target in a raw fixture catalog, by sysId. */
export function correctSources(raw) {
  const sources = {};
  for (const m of raw.mutants) {
    sources[m.baseArtifact.sysId] = correctSource(
      Number(m.baseArtifact.sysId.slice(3)),
    );
  }
  for (const b of raw.baselines) {
    sources[b.artifact.sysId] = correctSource(
      Number(b.artifact.sysId.slice(3)),
    );
  }
  return sources;
}

/**
 * A pinned generation config for fixture runs (no model is called).
 *
 * `promptHash` is DERIVED from this build's generator, never hand-written: a
 * literal went stale the moment the generation prompt changed, and
 * `tess benchmark` refuses a promptHash that is not the build's unit
 * instructionHash (wave 14). `test/fixture-gen-config.test.js` fails if the
 * two ever diverge.
 */
// Delegated decision 2026-09-30 (wave 15): derive from `instructionHashFor`
// rather than pin a literal. `@tessera/generate` does not depend on
// `@tessera/benchmark` (its closure is core/impact/specs/types), so a test-only
// devDependency adds no cycle; the kind is "unit" because that is the one kind
// `tess benchmark` runs (cli `BENCHMARK_KIND`).
export const FIXTURE_GEN_CONFIG = Object.freeze({
  modelId: "fixture-model-2026-09-01",
  temperature: 0,
  maxTokens: 4096,
  promptHash: instructionHashFor("unit"),
  promptVersion: "fixture-prompt/1",
});
