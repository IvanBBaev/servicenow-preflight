// `tess benchmark` public surface + the generation-prompt identity pin.
//
// 1. The `--restore` path is reachable from the barrel. `composeInstanceRestore`
//    and `BENCHMARK_RESTORE_RESULT_KIND` were only importable from
//    `build/benchmarkRun.js`; the barrel is explicit (no `export *`), so each
//    name is a decision and is pinned here — as the SAME binding the module
//    exports, not a look-alike. The seam types `BenchmarkSeams` refers to are
//    type-only and erased at runtime, so they are pinned syntactically against
//    the barrel's source.
//
// 2. GOLDEN — `instructionHash`. A benchmark's pinned `genConfig.promptHash` is
//    the generator's `RenderedPrompt.instructionHash`, and it is part of every
//    S5 record's result key (DESIGN §13.4). An edit to `GENERATION_INSTRUCTION`
//    (or to `PROMPT_VERSION`, the per-kind suffix, or the channel hashing)
//    moves it, and a recorded S5 run then silently stops being comparable with
//    new ones. CHANGING A VALUE BELOW INVALIDATES COMPARABILITY WITH EVERY
//    RECORDED RUN: it must be a deliberate re-baseline (bump `PROMPT_VERSION`,
//    re-run S5, say so in the change), never an update to make a red suite
//    green. The benchmark package's own identity hashes (`mutantSetHash`,
//    `keyHash`) are pinned in `packages/benchmark/test/identity-golden.test.js`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

import {
  GENERATION_INSTRUCTION,
  PROMPT_VERSION,
  buildGenerationPrompt,
  renderPrompt,
} from "@tessera/generate";
import { untrusted } from "@tessera/types";

import * as barrel from "../build/index.js";
import * as benchmarkRun from "../build/benchmarkRun.js";

describe("the barrel re-exports the benchmark restore surface", () => {
  for (const name of [
    "composeInstanceRestore",
    "BENCHMARK_RESTORE_RESULT_KIND",
  ]) {
    it(`${name} is the same binding as build/benchmarkRun.js`, () => {
      assert.ok(name in barrel, `${name} is missing from the cli barrel`);
      assert.notEqual(barrel[name], undefined);
      assert.equal(barrel[name], benchmarkRun[name]);
    });
  }

  it("the restore result kind is the documented string", () => {
    assert.equal(
      barrel.BENCHMARK_RESTORE_RESULT_KIND,
      "tessera.benchmark-restore",
    );
    assert.equal(typeof barrel.composeInstanceRestore, "function");
  });

  it("the seam types BenchmarkSeams names are exported by the barrel source", () => {
    const file = new URL("../src/index.ts", import.meta.url);
    const source = ts.createSourceFile(
      "index.ts",
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const typeNames = new Set();
    for (const statement of source.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        statement.isTypeOnly &&
        statement.moduleSpecifier?.getText(source) === '"./benchmarkRun.js"' &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const el of statement.exportClause.elements) {
          typeNames.add(el.name.text);
        }
      }
    }
    for (const name of [
      "BenchmarkRestoreComposeInput",
      "BenchmarkRestoreComposition",
      "BenchmarkRestoreOptions",
      "BenchmarkSeams",
      "BenchmarkSignal",
      "BenchmarkSignalSource",
    ]) {
      assert.ok(typeNames.has(name), `type ${name} is not re-exported`);
    }
  });
});

const EMPTY_GRAPH = Object.freeze({
  nodes: [],
  edges: [],
  unanalyzable: [],
  demanded: [],
});

/** GOLDEN — re-baseline deliberately; see the header. */
const INSTRUCTION_HASH_BY_KIND = Object.freeze({
  unit: "b3325cb583e4782b4122bcdc39e2e3d870d3459f2b34c35d54280831f1dbba60",
  e2e: "e46850c189ffdc85a58fcaea0aa7bd9bb2b3925072c0e1fe15820e45323e1266",
  ui: "7228938154bcc1dec905ba6e1fedfad7564a22c228a0acc066a6c6b3224d4087",
});

describe("generation instructionHash is pinned (golden — S5 comparability)", () => {
  it("PROMPT_VERSION is hashed into every instructionHash", () => {
    assert.equal(PROMPT_VERSION, "tessera-generate/1");
  });

  it("GENERATION_INSTRUCTION text is unchanged", () => {
    assert.equal(
      createHash("sha256").update(GENERATION_INSTRUCTION).digest("hex"),
      "58681a8b311fdb7c95220145c0d1139e26f10211b9decf2df61d68186dce7323",
    );
  });

  for (const [kind, expected] of Object.entries(INSTRUCTION_HASH_BY_KIND)) {
    it(`instructionHash for kind ${kind}`, () => {
      const rendered = renderPrompt(buildGenerationPrompt(kind, EMPTY_GRAPH));
      assert.equal(rendered.instructionHash, expected);
      assert.equal(rendered.promptVersion, PROMPT_VERSION);
    });
  }

  it("instructionHash does not depend on the data channel", () => {
    const withData = renderPrompt({
      instruction: buildGenerationPrompt("unit", EMPTY_GRAPH).instruction,
      data: [{ label: "golden", body: untrusted("anything at all") }],
    });
    assert.equal(withData.instructionHash, INSTRUCTION_HASH_BY_KIND.unit);
  });
});
