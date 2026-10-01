// GOLDEN — the hashes that make up an S5 record's identity.
//
// A recorded S5 run is comparable with a later one ONLY on an exact match of
// its result key `{platformVersion, mutantSetHash, genConfig}` (DESIGN §13.4),
// and the record names that key by `keyHash = resultKeyHash(key)`. The two
// hashes computed HERE — `computeMutantSetHash` and `resultKeyHash` — are
// therefore part of every recorded run's identity. Any change to either
// algorithm (the canonical-JSON encoding, the field list, the sort order, the
// optional-pin rule, `CATALOG_SCHEMA`) silently gives the SAME inputs a
// DIFFERENT identity, and every recorded run stops matching its own key.
//
// CHANGING A VALUE BELOW INVALIDATES COMPARABILITY WITH EVERY RECORDED RUN. It
// must be a deliberate re-baseline — bump the schema / version string that the
// change affects, re-run S5, and say so in the change — never a test update to
// make a red suite green.
//
// The third identity hash, `genConfig.promptHash` (the generator's
// `instructionHash`), lives in `@tessera/generate`, which this package builds
// before and does not depend on at runtime (only its tests do); it is pinned in
// `packages/cli/test/benchmarkExports.test.js`, where both are in reach.
//
// The inputs are hash-input VECTORS, not a catalog: nothing here is loaded,
// validated or run, and none of it is a mutant or a baseline (§13.1 — the real
// catalog is human-authored only).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CATALOG_SCHEMA,
  computeMutantSetHash,
  resultKeyHash,
} from "../build/index.js";

const VECTOR = Object.freeze({
  catalogVersion: "golden-vector-1",
  fixture: true,
  // Deliberately NOT in id order: the hash sorts by id, and the pin covers it.
  mutants: [
    {
      id: "gv-m-2",
      category: "acl",
      baseArtifact: {
        table: "sys_security_acl",
        sysId: "gvm0002",
        name: "GoldenAclTarget",
      },
      behaviour: "denies read",
      diffSha256: "2".repeat(64),
      expectedVerdict: "red",
    },
    {
      id: "gv-m-1",
      category: "business-rule",
      baseArtifact: {
        table: "sys_script",
        sysId: "gvm0001",
        name: "GoldenRuleTarget",
      },
      behaviour: "sets state",
      diffSha256: "1".repeat(64),
      expectedVerdict: "red",
    },
  ],
  baselines: [
    {
      id: "gv-b-1",
      artifact: {
        table: "sys_script_include",
        sysId: "gvb0001",
        name: "GoldenBaselineTarget",
      },
      behaviour: "adds one",
      detonatorSha256: "3".repeat(64),
    },
  ],
});

const KEY = Object.freeze({
  platformVersion: "glide-golden-vector",
  mutantSetHash: "a".repeat(64),
  genConfig: Object.freeze({
    modelId: "golden-model-2026-01-01",
    temperature: 0,
    maxTokens: 4096,
    promptHash: "b".repeat(64),
    promptVersion: "tessera-generate/1",
  }),
});

describe("S5 identity hashes are pinned (golden — re-baseline deliberately)", () => {
  test("CATALOG_SCHEMA is hashed into every mutantSetHash", () => {
    assert.equal(CATALOG_SCHEMA, "tessera-benchmark-catalog/1");
  });

  test("computeMutantSetHash — no correct-source pins", () => {
    assert.equal(
      computeMutantSetHash(VECTOR),
      "4d9bf9f9abde7d1b4dd1a418fb094d7cb595e1db0ed3b48add1f03449db42983",
    );
  });

  test("computeMutantSetHash — with correctSha256 pins and a baseline category", () => {
    const pinned = {
      ...VECTOR,
      mutants: [
        { ...VECTOR.mutants[0], correctSha256: "4".repeat(64) },
        VECTOR.mutants[1],
      ],
      baselines: [
        {
          ...VECTOR.baselines[0],
          category: "script-include",
          correctSha256: "5".repeat(64),
        },
      ],
    };
    assert.equal(
      computeMutantSetHash(pinned),
      "d0bae10cec5cdc6e717873783cbd5eead75f44dd0bbf786616b59bf09daa836a",
    );
  });

  test("computeMutantSetHash ignores sign-offs (provenance, not content)", () => {
    const signed = {
      ...VECTOR,
      mutants: VECTOR.mutants.map((m) => ({
        ...m,
        signOff: { by: "golden vector", at: "2026-09-28" },
      })),
    };
    assert.equal(computeMutantSetHash(signed), computeMutantSetHash(VECTOR));
  });

  test("resultKeyHash (the S5 record's keyHash)", () => {
    assert.equal(
      resultKeyHash(KEY),
      "deaf1cb7a67345395505f53db78d136bcfab404fc09c061d596285506223d966",
    );
  });
});
