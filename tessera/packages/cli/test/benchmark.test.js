// `tess benchmark` — the operator surface over `@tessera/benchmark`.
//
// What this file can falsify that the package's own suites cannot:
//
//   * **Inputs before instances.** A catalog the loader refuses is exit 4 and
//     an unpinned generation config is exit 2 — both before composition, so
//     the compose seam is never reached.
//   * **§11 in front of the substrate.** With the real composition, a runner
//     declared production is refused (exit 4) and the fake served no request
//     but GETs: the classification probe reads, nothing writes.
//   * **The exit mapping.** Over the benchmark package's own FIXTURE substrate
//     (injected through the compose seam): a fixture GO exits 5, never 0; a
//     blind catalog misses (1); a red substrate control voids (5).
//
// Every catalog here is the benchmark package's FIXTURE — not the benchmark
// set, and it says so (`fixture: true`).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import {
  buildGenerationPrompt,
  createTemplateProvider,
  renderPrompt,
} from "@tessera/generate";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import {
  BENCHMARK_RESULT_KIND,
  EXIT_CODES,
  benchmarkExitCode,
  composeInstanceBenchmark,
  main,
  parseBenchmarkArgs,
} from "../build/index.js";
import {
  countSuiteTriggers,
  currentInstructionHash,
  promptHashDrift,
} from "../build/benchmarkRun.js";
import { createFakeBench } from "../../benchmark/test/fixtures/fake-substrate.js";
import {
  FIXTURE_GEN_CONFIG,
  buildFixtureCatalog,
} from "../../benchmark/test/fixtures/fixture-catalog.js";

const RUNNER_HOST = "dev-bench.service-now.com";
const RUN_ID = "bench-run-0001";

/** This build's unit instructionHash, computed from the generator itself. */
const UNIT_INSTRUCTION_HASH = renderPrompt(
  buildGenerationPrompt("unit", {
    nodes: [],
    edges: [],
    unanalyzable: [],
    demanded: [],
  }),
).instructionHash;

// Wave 15: FIXTURE_GEN_CONFIG now derives its promptHash from the generator,
// so a stale pin has to be made explicitly.
const STALE_GEN_CONFIG = Object.freeze({
  ...FIXTURE_GEN_CONFIG,
  promptHash: "a".repeat(64),
});

const tempRoots = [];
after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function workspace({
  catalog = buildFixtureCatalog(),
  gen = FIXTURE_GEN_CONFIG,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-bench-"));
  tempRoots.push(root);
  await fs.writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog));
  await fs.writeFile(path.join(root, "gen.json"), JSON.stringify(gen));
  const out = [];
  const err = [];
  return {
    root,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    context: {
      now: () => new Date("2026-09-24T10:00:00.000Z"),
      actor: "test",
      cwd: root,
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

function argv(extra = []) {
  return [
    "benchmark",
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

/** A compose seam over the benchmark package's fixture substrate. */
function fixtureCompose(raw, benchOptions = {}) {
  const bench = createFakeBench(raw, benchOptions);
  const seen = { composed: 0, released: 0, provider: undefined };
  return {
    bench,
    seen,
    seams: {
      async compose(input) {
        seen.composed += 1;
        seen.provider = input.provider;
        return {
          substrate: bench.substrate,
          pipeline: bench.pipeline,
          notes: ["topology: FIXTURE"],
          release() {
            seen.released += 1;
          },
        };
      },
    },
  };
}

// `main` has no seam parameter; the command itself is called for seam runs.
async function runWithSeams(w, seams, extra = []) {
  const { benchmarkCommand } = await import("../build/index.js");
  return benchmarkCommand(argv(extra).slice(1), w.context, seams);
}

describe("tess benchmark — argv", () => {
  it("requires --catalog, --gen-config, --scope and --run-id", async () => {
    const context = (await workspace()).context;
    const full = argv().slice(1);
    for (const flag of ["--catalog", "--gen-config", "--scope", "--run-id"]) {
      const i = full.indexOf(flag);
      const without = [...full.slice(0, i), ...full.slice(i + 2)];
      const parsed = parseBenchmarkArgs(without, context);
      assert.equal(parsed.kind, "error", flag);
      assert.match(parsed.message, new RegExp(flag));
    }
  });

  it("refuses unknown options, a bad provider and a non-integer k", async () => {
    const w = await workspace();
    for (const extra of [
      ["--nope"],
      ["--provider", "gpt"],
      ["--repetitions", "2.5"],
      ["--acknowledge-prod", " "],
    ]) {
      const code = await main(argv(extra), w.context);
      assert.equal(code, EXIT_CODES.usage, extra.join(" "));
    }
  });

  it("defaults --source to --runner and resolves paths against cwd", async () => {
    const w = await workspace();
    const parsed = parseBenchmarkArgs(argv().slice(1), w.context);
    assert.equal(parsed.kind, "benchmark");
    assert.equal(parsed.options.source, "runner");
    assert.equal(parsed.options.catalogPath, path.join(w.root, "catalog.json"));
    assert.equal(parsed.options.provider, "template");
  });

  it("prints its own help", async () => {
    const w = await workspace();
    const code = await main(["benchmark", "--help"], w.context);
    assert.equal(code, EXIT_CODES.ok);
    assert.match(w.stdout(), /^tess benchmark/);
    assert.match(w.stdout(), /no default/);
  });

  it("documents every value flag the parser accepts, --docs-dir included", async () => {
    const w = await workspace();
    await main(["benchmark", "--help"], w.context);
    assert.match(w.stdout(), /--docs-dir <dir>/);
    const parsed = parseBenchmarkArgs(
      argv(["--docs-dir", "docs"]).slice(1),
      w.context,
    );
    assert.equal(parsed.kind, "benchmark");
    assert.equal(parsed.options.docsDir, "docs");
  });

  it("refuses a --run-id that is not a ledger run id (no path traversal)", async () => {
    const w = await workspace();
    for (const bad of ["../../x", "a/b", ".hidden", "..", "a\\b"]) {
      const full = argv().slice(1);
      full[full.indexOf("--run-id") + 1] = bad;
      const parsed = parseBenchmarkArgs(full, w.context);
      assert.equal(parsed.kind, "error", bad);
      assert.match(parsed.message, /--run-id/);
    }
    const { seams, seen } = fixtureCompose(buildFixtureCatalog());
    const { benchmarkCommand } = await import("../build/index.js");
    const full = argv(["--out", "s5.json"]).slice(1);
    full[full.indexOf("--run-id") + 1] = "../../escape";
    const code = await benchmarkCommand(full, w.context, seams);
    assert.equal(code, EXIT_CODES.usage, w.stderr());
    assert.equal(seen.composed, 0);
    assert.deepEqual((await fs.readdir(w.root)).sort(), [
      "catalog.json",
      "gen.json",
    ]);
  });
});

describe("tess benchmark — inputs before instances", () => {
  it("an unpinned generation config is usage (2), and nothing is composed", async () => {
    const w = await workspace({
      gen: { ...FIXTURE_GEN_CONFIG, promptHash: "" },
    });
    const { seams, seen } = fixtureCompose(buildFixtureCatalog());
    const code = await runWithSeams(w, seams);
    assert.equal(code, EXIT_CODES.usage, w.stderr());
    assert.match(w.stderr(), /not a pin/);
    assert.equal(seen.composed, 0);
  });

  it("repetitions below the §13.1 minimum are usage (2)", async () => {
    const w = await workspace();
    const { seams, seen } = fixtureCompose(buildFixtureCatalog());
    const code = await runWithSeams(w, seams, ["--repetitions", "1"]);
    assert.equal(code, EXIT_CODES.usage, w.stderr());
    assert.equal(seen.composed, 0);
  });

  it("a catalog the loader refuses is exit 4, and nothing is composed or written", async () => {
    const raw = buildFixtureCatalog();
    raw.mutants[0].signOff = undefined;
    const w = await workspace({ catalog: raw });
    const { seams, seen } = fixtureCompose(buildFixtureCatalog());
    const code = await runWithSeams(w, seams, ["--out", "s5.json"]);
    assert.equal(code, EXIT_CODES.refused, w.stderr());
    assert.match(w.stderr(), /REFUSED \(§13\.4\)/);
    assert.equal(seen.composed, 0);
    assert.deepEqual((await fs.readdir(w.root)).sort(), [
      "catalog.json",
      "gen.json",
    ]);
  });

  it("an unwritable --out is usage (2) before anything is composed", async () => {
    const w = await workspace();
    await fs.writeFile(path.join(w.root, "blocker"), "a regular file");
    const { seams, seen } = fixtureCompose(buildFixtureCatalog());
    const code = await runWithSeams(w, seams, ["--out", "blocker/s5.json"]);
    assert.equal(code, EXIT_CODES.usage, w.stderr());
    assert.match(w.stderr(), /--out/);
    assert.equal(seen.composed, 0);
  });

  it("a blank TESSERA_ANTHROPIC_API_KEY falls through to ANTHROPIC_API_KEY", async () => {
    const raw = buildFixtureCatalog();
    const w = await workspace({ catalog: raw });
    w.context.env = {
      TESSERA_ANTHROPIC_API_KEY: "  ",
      ANTHROPIC_API_KEY: "sk-test-not-real",
    };
    const { seams, seen } = fixtureCompose(raw);
    // The fixture pipeline brings its own generator: the provider is built
    // and handed to compose, never called — no network.
    await runWithSeams(w, seams, ["--provider", "anthropic"]);
    assert.equal(seen.composed, 1, w.stderr());
    assert.equal(seen.provider.name, "anthropic");
  });

  it("--provider anthropic without a key is usage (2)", async () => {
    const w = await workspace();
    const { seams, seen } = fixtureCompose(buildFixtureCatalog());
    const code = await runWithSeams(w, seams, ["--provider", "anthropic"]);
    assert.equal(code, EXIT_CODES.usage, w.stderr());
    assert.match(w.stderr(), /ANTHROPIC_API_KEY/);
    assert.equal(seen.composed, 0);
  });
});

describe("tess benchmark — exit mapping over the fixture substrate", () => {
  it("a fixture GO exits 5, never 0, and the lease and composition are released", async () => {
    const raw = buildFixtureCatalog();
    const w = await workspace({ catalog: raw });
    const { seams, seen, bench } = fixtureCompose(raw);
    const code = await runWithSeams(w, seams);
    assert.equal(code, EXIT_CODES.inconclusive, `${w.stdout()}\n${w.stderr()}`);
    assert.match(w.stdout(), /FIXTURE catalog/);
    assert.match(w.stdout(), /exit: 5/);
    assert.equal(seen.released, 1);
    assert.equal(bench.leaseHolder(), null);
  });

  it("builds the provider from the pinned config", async () => {
    const raw = buildFixtureCatalog();
    const w = await workspace({ catalog: raw });
    const { seams, seen } = fixtureCompose(raw);
    await runWithSeams(w, seams);
    assert.equal(seen.provider.config.promptHash, UNIT_INSTRUCTION_HASH);
    assert.equal(seen.provider.config.maxTokens, FIXTURE_GEN_CONFIG.maxTokens);
  });

  it("blind mutants MISS (exit 1)", async () => {
    const raw = buildFixtureCatalog({
      blind: ["fx-m-acl-0", "fx-m-acl-1", "fx-m-acl-2"],
    });
    const w = await workspace({ catalog: raw });
    const { seams } = fixtureCompose(raw);
    const code = await runWithSeams(w, seams);
    assert.equal(code, EXIT_CODES.noGo, `${w.stdout()}\n${w.stderr()}`);
  });

  it("a red substrate control is VOID (exit 5), not a miss", async () => {
    const raw = buildFixtureCatalog();
    const w = await workspace({ catalog: raw });
    const { seams, seen } = fixtureCompose(raw, { unhealthy: true });
    const code = await runWithSeams(w, seams, ["--json"]);
    assert.equal(code, EXIT_CODES.inconclusive, w.stderr());
    const doc = JSON.parse(w.stdout());
    assert.equal(doc.s5.status, "void");
    assert.equal(seen.released, 1);
  });

  it("--json and --out carry the same S5 document", async () => {
    const raw = buildFixtureCatalog();
    const w = await workspace({ catalog: raw });
    const { seams } = fixtureCompose(raw);
    const code = await runWithSeams(w, seams, [
      "--json",
      "--out",
      "out/s5.json",
    ]);
    const doc = JSON.parse(w.stdout());
    assert.equal(doc.kind, BENCHMARK_RESULT_KIND);
    assert.equal(doc.exitCode, code);
    assert.equal(doc.s5.runId, RUN_ID);
    assert.equal(doc.s5.fixture, true);
    assert.equal(doc.s5.finding.outcome, "open");
    const written = JSON.parse(
      await fs.readFile(path.join(w.root, "out", "s5.json"), "utf8"),
    );
    assert.deepEqual(written, doc);
  });

  it("an --out that breaks after the run: the record is on stdout, and the exit is 3", async () => {
    const raw = buildFixtureCatalog();
    const w = await workspace({ catalog: raw });
    const { seams: inner, seen } = fixtureCompose(raw);
    const seams = {
      async compose(input) {
        // The early probe already created out/; replace it with a regular
        // file so only the final write can fail.
        await fs.rm(path.join(w.root, "out"), { recursive: true });
        await fs.writeFile(path.join(w.root, "out"), "now a file");
        return inner.compose(input);
      },
    };
    const code = await runWithSeams(w, seams, [
      "--json",
      "--out",
      "out/s5.json",
    ]);
    assert.equal(code, EXIT_CODES.fault, w.stderr());
    assert.equal(seen.released, 1);
    const doc = JSON.parse(w.stdout());
    assert.equal(doc.kind, BENCHMARK_RESULT_KIND);
    assert.equal(doc.exitCode, EXIT_CODES.inconclusive);
    assert.match(w.stderr(), /could not be written/);
  });

  it("maps a GO on a real catalog to 0", () => {
    assert.equal(
      benchmarkExitCode({
        result: { status: "go" },
        catalog: { fixture: false },
      }),
      EXIT_CODES.ok,
    );
    assert.equal(
      benchmarkExitCode({
        result: { status: "go" },
        catalog: { fixture: true },
      }),
      EXIT_CODES.inconclusive,
    );
  });
});

// ── the real composition, against the fake ─────────────────────────────────

const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH",
  "SN_DOCS_DIR",
  "SN_MAX_RETRIES",
  "SN_READONLY",
  "SN_ACTIVE_PROFILE",
  "SN_ALLOWED_HOSTS",
  "SN_HOST_POLICY",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
  "SN_PROFILE_RUNNER_INSTANCE",
  "SN_PROFILE_RUNNER_USER",
  "SN_PROFILE_RUNNER_PASSWORD",
];

/** A fake runner behind `fetch`, the `runner` profile staged, calls logged. */
function stageRunner(root) {
  const fake = createFakeInstance({
    host: RUNNER_HOST,
    state: {
      sys_properties: [
        {
          sys_id: "b0000000000000000000000000000001",
          name: "glide.installation.production",
          value: "false",
        },
      ],
    },
  });
  const methods = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (new URL(href).host !== RUNNER_HOST) {
      return Promise.reject(new Error(`no fake instance for ${href}`));
    }
    methods.push((init?.method ?? "GET").toUpperCase());
    return fake.fetch(input, init);
  };
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(root, "sn-docs");
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_RUNNER_INSTANCE = RUNNER_HOST;
  process.env.SN_PROFILE_RUNNER_USER = "tessera";
  process.env.SN_PROFILE_RUNNER_PASSWORD = "tessera";
  reloadCredentialsFromEnv();
  return {
    methods,
    restore() {
      globalThis.fetch = realFetch;
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

describe("tess benchmark — the real composition", () => {
  it("refuses a declared-production runner (exit 4) with nothing but GETs sent", async () => {
    const w = await workspace();
    const runner = stageRunner(w.root);
    let code;
    try {
      code = await main(argv(["--prod", RUNNER_HOST]), w.context);
    } finally {
      runner.restore();
    }
    assert.equal(code, EXIT_CODES.refused, `${w.stdout()}\n${w.stderr()}`);
    assert.deepEqual(
      runner.methods.filter((m) => m !== "GET"),
      [],
      "a refusal writes nothing",
    );
  });

  it("composes an allowlisted runner into a unit pipeline and releases it", async () => {
    const w = await workspace();
    const runner = stageRunner(w.root);
    try {
      const parsed = parseBenchmarkArgs(argv().slice(1), w.context);
      assert.equal(parsed.kind, "benchmark");
      const composition = await composeInstanceBenchmark({
        options: parsed.options,
        provider: createTemplateProvider({ config: FIXTURE_GEN_CONFIG }),
        context: w.context,
      });
      try {
        assert.equal(composition.pipeline.kind, "unit");
        assert.ok(composition.pipeline.runner.kinds.includes("unit"));
        assert.deepEqual(composition.topology, {
          source: "runner",
          runner: "runner",
          target: "runner",
        });
        assert.equal(
          typeof composition.substrate.acquireRunnerLease,
          "function",
        );
      } finally {
        composition.release();
      }
    } finally {
      runner.restore();
    }
    assert.deepEqual(
      runner.methods.filter((m) => m !== "GET"),
      [],
      "composition alone writes nothing",
    );
  });
});

// ── DEV-17: the composed store is handed the recorded trigger count ─────────

describe("tess benchmark — the composition counts suite triggers (DEV-17)", () => {
  it("the composed store tears down: the wrapper supplies the count the real store requires", async () => {
    const w = await workspace();
    const runner = stageRunner(w.root);
    try {
      const parsed = parseBenchmarkArgs(argv().slice(1), w.context);
      assert.equal(parsed.kind, "benchmark");
      const composition = await composeInstanceBenchmark({
        options: parsed.options,
        provider: createTemplateProvider({ config: FIXTURE_GEN_CONFIG }),
        context: w.context,
      });
      try {
        // The real ATF store is built with requireRecordedTriggers: a
        // teardown context without a count is refused before any request.
        // Only the countSuiteTriggers wrapper supplies one here (0: no run).
        await composition.pipeline.store.teardown({
          runId: RUN_ID,
          lifecycle: "ephemeral",
          coverageSource: "ephemeral",
          topology: { source: "runner", runner: "runner", target: "runner" },
          signal: new AbortController().signal,
        });
      } finally {
        composition.release();
      }
    } finally {
      runner.restore();
    }
    assert.deepEqual(
      runner.methods.filter((m) => m !== "GET"),
      [],
      "an empty namespace deletes nothing",
    );
  });
});

describe("countSuiteTriggers (DEV-17 wrapper)", () => {
  const RUN = "trig-run-0001";

  function fakes({ runResult = "ran", runThrows } = {}) {
    const calls = { run: [], project: [], teardown: [], supports: [] };
    const store = {
      project: (ctx, specs) => {
        calls.project.push({ ctx, specs });
        return Promise.resolve("projected");
      },
      teardown: (ctx) => {
        calls.teardown.push(ctx);
        return Promise.resolve("torn-down");
      },
    };
    const runner = {
      kinds: ["unit"],
      supports: (spec) => {
        calls.supports.push(spec);
        return spec === "yes";
      },
      run: (ctx, specs, emit) => {
        calls.run.push({ ctx, specs, emit });
        if (runThrows !== undefined) return Promise.reject(runThrows);
        return Promise.resolve(runResult);
      },
    };
    return { calls, ...countSuiteTriggers(store, runner) };
  }

  const projection = (...suites) =>
    Object.fromEntries(
      suites.map((suiteSysId, index) => [`spec-${index}`, { suiteSysId }]),
    );
  const teardownCtx = (runId = RUN) => ({ runId, lifecycle: "ephemeral" });

  it("counts the distinct suites of the projection a run was handed", async () => {
    const f = fakes();
    await f.runner.run(
      { runId: RUN, projection: projection("s1", "s2", "s1") },
      [],
      () => {},
    );
    await f.store.teardown(teardownCtx());
    assert.equal(f.calls.teardown[0].recordedTriggers, 2);
  });

  it("counts at least one trigger for a run with no (or an empty) projection", async () => {
    const f = fakes();
    await f.runner.run({ runId: RUN }, [], () => {});
    await f.store.teardown(teardownCtx());
    assert.equal(f.calls.teardown[0].recordedTriggers, 1);
    await f.runner.run({ runId: RUN, projection: {} }, [], () => {});
    await f.store.teardown(teardownCtx());
    assert.equal(f.calls.teardown[1].recordedTriggers, 2);
  });

  it("accumulates across runs of one run id, and keeps run ids apart", async () => {
    const f = fakes();
    await f.runner.run({ runId: RUN, projection: projection("a") }, [], null);
    await f.runner.run(
      { runId: RUN, projection: projection("a", "b", "c") },
      [],
      null,
    );
    await f.runner.run(
      { runId: "other", projection: projection("x") },
      [],
      null,
    );
    await f.store.teardown(teardownCtx());
    await f.store.teardown(teardownCtx("other"));
    await f.store.teardown(teardownCtx("never-ran"));
    assert.deepEqual(
      f.calls.teardown.map((ctx) => ctx.recordedTriggers),
      [4, 1, 0],
    );
  });

  it("a teardown before any run passes 0 — a number, never an omitted count", async () => {
    const f = fakes();
    assert.equal(await f.store.teardown(teardownCtx()), "torn-down");
    assert.ok("recordedTriggers" in f.calls.teardown[0]);
    assert.equal(f.calls.teardown[0].recordedTriggers, 0);
  });

  it("counts BEFORE delegating: a run that rejects still counts (fail closed)", async () => {
    const boom = new Error("trigger lost");
    const f = fakes({ runThrows: boom });
    await assert.rejects(
      f.runner.run(
        { runId: RUN, projection: projection("s1", "s2") },
        [],
        null,
      ),
      boom,
    );
    await f.store.teardown(teardownCtx());
    assert.equal(f.calls.teardown[0].recordedTriggers, 2);
  });

  it("delegates run, supports, kinds and project unchanged", async () => {
    const f = fakes();
    const ctx = { runId: RUN, projection: projection("s1") };
    const specs = ["spec"];
    const emit = () => {};
    assert.equal(await f.runner.run(ctx, specs, emit), "ran");
    assert.equal(f.calls.run[0].ctx, ctx);
    assert.equal(f.calls.run[0].specs, specs);
    assert.equal(f.calls.run[0].emit, emit);
    assert.deepEqual(f.runner.kinds, ["unit"]);
    assert.equal(f.runner.supports("yes"), true);
    assert.equal(f.runner.supports("no"), false);
    assert.deepEqual(f.calls.supports, ["yes", "no"]);
    assert.equal(await f.store.project(ctx, specs), "projected");
    assert.equal(f.calls.project[0].ctx, ctx);
    assert.equal(f.calls.project[0].specs, specs);
  });

  it("teardown keeps the caller's context fields and does not mutate it", async () => {
    const f = fakes();
    const ctx = { ...teardownCtx(), neverTriggered: true, extra: "kept" };
    await f.store.teardown(ctx);
    assert.equal(f.calls.teardown[0].extra, "kept");
    assert.equal(f.calls.teardown[0].neverTriggered, true);
    assert.equal(f.calls.teardown[0].runId, RUN);
    assert.notEqual(f.calls.teardown[0], ctx);
    assert.equal("recordedTriggers" in ctx, false);
  });
});

// ── wave 14: the pinned promptHash vs this build's instructionHash ──────────

describe("tess benchmark — a pinned promptHash must match the build (§12.3)", () => {
  it("currentInstructionHash is the generator's unit instructionHash", () => {
    assert.equal(currentInstructionHash(), UNIT_INSTRUCTION_HASH);
    assert.equal(currentInstructionHash("unit"), UNIT_INSTRUCTION_HASH);
    assert.notEqual(currentInstructionHash("e2e"), UNIT_INSTRUCTION_HASH);
  });

  it("promptHashDrift: a match and an unpinned (blank) hash pass; anything else names both", () => {
    assert.equal(
      promptHashDrift({ promptHash: UNIT_INSTRUCTION_HASH }),
      undefined,
    );
    assert.equal(promptHashDrift({ promptHash: "" }), undefined);
    const stale = promptHashDrift({ promptHash: "a".repeat(64) });
    assert.equal(typeof stale, "string");
    assert.match(stale, new RegExp(`a{64}`));
    assert.match(stale, new RegExp(UNIT_INSTRUCTION_HASH));
    const e2e = currentInstructionHash("e2e");
    assert.equal(promptHashDrift({ promptHash: e2e }, "e2e"), undefined);
    assert.match(promptHashDrift({ promptHash: e2e }), /unit generation/);
  });

  it("a stale pin is refused (exit 4) before anything is composed or written", async () => {
    const w = await workspace({ gen: STALE_GEN_CONFIG });
    const { seams, seen } = fixtureCompose(buildFixtureCatalog());
    const code = await runWithSeams(w, seams, ["--out", "s5.json"]);
    assert.equal(code, EXIT_CODES.refused, w.stderr());
    assert.match(w.stderr(), /REFUSED \(§12\.3\)/);
    assert.match(w.stderr(), /nothing was staged and nothing was written/);
    assert.match(
      w.stderr(),
      new RegExp(`re-pin promptHash to ${UNIT_INSTRUCTION_HASH}`),
    );
    assert.equal(w.stdout(), "");
    assert.equal(seen.composed, 0);
    assert.deepEqual((await fs.readdir(w.root)).sort(), [
      "catalog.json",
      "gen.json",
    ]);
  });

  it("another kind's real instructionHash is a stale pin too (the benchmark runs unit)", async () => {
    const w = await workspace({
      gen: { ...FIXTURE_GEN_CONFIG, promptHash: currentInstructionHash("e2e") },
    });
    const { seams, seen } = fixtureCompose(buildFixtureCatalog());
    const code = await runWithSeams(w, seams);
    assert.equal(code, EXIT_CODES.refused, w.stderr());
    assert.equal(seen.composed, 0);
  });

  it("is refused through `main` too, with no instance staged (a contact would fault)", async () => {
    const w = await workspace({ gen: STALE_GEN_CONFIG });
    const code = await main(argv(), w.context);
    assert.equal(code, EXIT_CODES.refused, w.stderr());
    assert.match(w.stderr(), /REFUSED \(§12\.3\)/);
  });

  it("the refusal applies to --provider anthropic as well", async () => {
    const w = await workspace({ gen: STALE_GEN_CONFIG });
    w.context.env = { ANTHROPIC_API_KEY: "sk-test-not-real" };
    const { seams, seen } = fixtureCompose(buildFixtureCatalog());
    const code = await runWithSeams(w, seams, ["--provider", "anthropic"]);
    assert.equal(code, EXIT_CODES.refused, w.stderr());
    assert.equal(seen.composed, 0);
  });

  it("a pin that matches composes and runs", async () => {
    const raw = buildFixtureCatalog();
    const w = await workspace({ catalog: raw });
    const { seams, seen } = fixtureCompose(raw);
    const code = await runWithSeams(w, seams);
    assert.equal(code, EXIT_CODES.inconclusive, w.stderr());
    assert.equal(seen.composed, 1);
    assert.doesNotMatch(w.stderr(), /§12\.3/);
  });
});
