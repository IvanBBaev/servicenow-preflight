// The public surface of @tessera/types, asserted as a SET.
//
// The two constant tests at the bottom pin VALUES. They never pinned the
// surface: a rogue export could be added, or an export deleted, and nothing
// here would have failed — the only other suite in this package imports four
// names from `build/index.js` and would have caught the removal of those four
// by accident. This package's entire job is to be an API, so the set of names
// it hands out is the thing worth enforcing, and enforcing it means asserting
// what IS exported, not merely that some particular name still is.
//
// Type-only exports have no runtime existence, so they are read off the
// emitted declarations instead. That is why these tests read `build/` twice
// over: once by importing it, once by parsing it.

import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RAW_OUTCOMES, TEST_KINDS } from "../build/index.js";

const BUILD = new URL("../build/", import.meta.url);

/** Names a `.d.ts` declares with a top-level `export`, in file order. */
function declaredExports(file) {
  const source = readFileSync(new URL(file, BUILD), "utf8");
  const declaration =
    /^export (?:declare (?:const|function|class|enum) |interface |type |enum |class |const |function )([A-Za-z_$][\w$]*)/;
  const names = [];
  for (const line of source.split("\n")) {
    const match = declaration.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

describe("@tessera/types public surface", () => {
  it("re-exports every built module from the barrel, and nothing else", () => {
    const barrel = readFileSync(new URL("index.d.ts", BUILD), "utf8");
    // tsc emits each re-export on one line, so one regex covers the value and
    // type halves; a module re-exported by both counts once.
    const reExported = [
      ...new Set(
        [
          ...barrel.matchAll(
            /^export (?:type )?\{[^}]*\} from "\.\/(.+)\.js";$/gm,
          ),
        ].map((match) => match[1]),
      ),
    ].sort();

    const built = readdirSync(BUILD)
      .filter((file) => file.endsWith(".d.ts"))
      .map((file) => file.slice(0, -".d.ts".length))
      .filter((name) => name !== "index")
      .sort();

    // Both directions matter. A module added to `src/` and left out of
    // `index.ts` is a type nobody can import; a barrel line pointing at a
    // module that no longer exists is a broken import for every consumer.
    assert.deepEqual(reExported, built);
    assert.deepEqual(reExported, [
      "propertyRows",
      "readCompleteness",
      "run",
      "untrusted",
      "verdict",
    ]);
  });

  it("exports exactly these runtime values", async () => {
    const surface = await import("../build/index.js");
    assert.deepEqual(Object.keys(surface).sort(), [
      "ATF_RUNNER_ENABLED_PROPERTY",
      "ATF_RUNNER_SAFE_DIRECTION",
      "PRODUCTION_PROPERTY",
      "PRODUCTION_SAFE_DIRECTION",
      "PROPERTY_READ_LIMIT",
      "PROPERTY_ROW_LIMIT",
      "RAW_OUTCOMES",
      "SYS_PROPERTIES_TABLE",
      "TEST_KINDS",
      "decidePropertyRows",
      "incompletePropertyRead",
      "incompleteRead",
      "isUntrusted",
      "mapUntrusted",
      "normalisePropertyValue",
      "readsSafeDirection",
      "untrusted",
      "unwrapUntrusted",
    ]);
  });

  it("exports exactly these names, types included", () => {
    // The API. Changing this list is meant to be a deliberate act with a
    // reviewer attached — every consumer package imports from here, and a name
    // silently added or removed is a change to a contract that no compiler in
    // this workspace re-checks across package boundaries until something else
    // breaks.
    const declared = [
      ...declaredExports("propertyRows.d.ts"),
      ...declaredExports("readCompleteness.d.ts"),
      ...declaredExports("run.d.ts"),
      ...declaredExports("untrusted.d.ts"),
      ...declaredExports("verdict.d.ts"),
    ].sort();

    assert.deepEqual(declared, [
      "ATF_RUNNER_ENABLED_PROPERTY",
      "ATF_RUNNER_SAFE_DIRECTION",
      "AffectedArtifact",
      "ArtifactRef",
      "ChecklistRow",
      "ConfirmToken",
      "CountedRead",
      "CoverageReport",
      "EvidenceRef",
      "ImpactConfidence",
      "ImpactEdge",
      "ImpactGraph",
      "Lifecycle",
      "OverrideRecord",
      "PRODUCTION_PROPERTY",
      "PRODUCTION_SAFE_DIRECTION",
      "PROPERTY_READ_LIMIT",
      "PROPERTY_ROW_LIMIT",
      "PipelineContext",
      "PipelineTopology",
      "PlannedSpec",
      "PreflightVerdict",
      "ProjectedRecord",
      "ProjectionMap",
      "PropertyRowsDecision",
      "PropertySafeDirection",
      "ProvisionAction",
      "ProvisionPlan",
      "RAW_OUTCOMES",
      "RawOutcome",
      "ResolverSource",
      "RowStatus",
      "RunId",
      "RunLifecycle",
      "RunResult",
      "SYS_PROPERTIES_TABLE",
      "SpecOutcome",
      "TEST_KINDS",
      "TargetArtifactRef",
      "TargetInput",
      "TestEvent",
      "TestKind",
      "TestSpec",
      "TestSpecRef",
      "UnanalyzableArtifact",
      "Untrusted",
      "VerdictStatus",
      "decidePropertyRows",
      "incompletePropertyRead",
      "incompleteRead",
      "isUntrusted",
      "mapUntrusted",
      "normalisePropertyValue",
      "readsSafeDirection",
      "untrusted",
      "unwrapUntrusted",
    ]);
  });

  it("exports the closed RawOutcome union in §6a order", () => {
    assert.deepEqual(RAW_OUTCOMES, [
      "pass",
      "fail",
      "error",
      "skipped",
      "waiting-timeout",
      "flaky",
      "missing",
    ]);
  });

  it("exports the TestKind union", () => {
    assert.deepEqual(TEST_KINDS, ["unit", "e2e", "ui"]);
  });
});
