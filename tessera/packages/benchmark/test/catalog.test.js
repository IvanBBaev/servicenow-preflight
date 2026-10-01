// DESIGN §13.4 — the catalog loader refuses, it never repairs.
//
// Every catalog here is built from test/fixtures/fixture-catalog.js —
// FIXTURE — not the benchmark set.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { sha256Hex } from "@tessera/core";

import * as api from "../build/index.js";
import {
  CatalogError,
  DESIGN_GATE_POLICY,
  loadCatalog,
  readCatalogFile,
} from "../build/index.js";
import { buildFixtureCatalog } from "./fixtures/fixture-catalog.js";

const load = (raw) => loadCatalog(raw, DESIGN_GATE_POLICY);

/** Assert refusal and return the problem list. */
function refused(raw) {
  let problems;
  assert.throws(
    () => load(raw),
    (error) => {
      assert.ok(error instanceof CatalogError);
      problems = error.problems;
      return true;
    },
  );
  return problems;
}

describe("loadCatalog — accepts", () => {
  test("a complete fixture catalog, content-addressed", () => {
    const raw = buildFixtureCatalog();
    const catalog = load(raw);
    assert.equal(catalog.fixture, true);
    assert.equal(catalog.mutants.length, 30);
    assert.equal(catalog.baselines.length, 35);
    const m = catalog.mutants[0];
    assert.equal(m.diffSha256, sha256Hex(raw.mutants[0].diff));
    const b = catalog.baselines[0];
    assert.equal(b.detonatorSha256, sha256Hex(raw.baselines[0].detonator.diff));
    assert.match(catalog.mutantSetHash, /^[0-9a-f]{64}$/);
  });

  test("a correct recorded diffSha256 is accepted", () => {
    const raw = buildFixtureCatalog();
    raw.mutants[0].diffSha256 = sha256Hex(raw.mutants[0].diff);
    assert.equal(load(raw).mutants.length, 30);
  });
});

describe("mutantSetHash", () => {
  test("is order-independent and ignores sign-off provenance", () => {
    const base = load(buildFixtureCatalog()).mutantSetHash;
    const shuffled = buildFixtureCatalog();
    shuffled.mutants.reverse();
    shuffled.baselines.reverse();
    assert.equal(load(shuffled).mutantSetHash, base);
    const resigned = buildFixtureCatalog();
    resigned.mutants[4].signOff = { by: "Someone Else", at: "2026-09-24" };
    assert.equal(load(resigned).mutantSetHash, base);
  });

  test("changes on any fault, detonator, target or version edit", () => {
    const base = load(buildFixtureCatalog()).mutantSetHash;
    const edits = [
      (raw) => {
        raw.mutants[3].diff += " ";
      },
      (raw) => {
        raw.baselines[2].detonator.diff += " ";
      },
      (raw) => {
        raw.mutants[0].behaviour = "subtracts";
      },
      (raw) => {
        raw.catalogVersion = "other";
      },
      (raw) => {
        raw.fixture = false;
      },
    ];
    for (const edit of edits) {
      const raw = buildFixtureCatalog();
      edit(raw);
      assert.notEqual(load(raw).mutantSetHash, base, edit.toString());
    }
  });
});

describe("loadCatalog — refuses", () => {
  test("a mutant without a human sign-off", () => {
    const raw = buildFixtureCatalog();
    delete raw.mutants[2].signOff;
    assert.match(refused(raw).join("\n"), /missing human sign-off/);
    const noReviewer = buildFixtureCatalog();
    noReviewer.mutants[2].signOff = { by: " ", at: "2026-09-23" };
    assert.match(refused(noReviewer).join("\n"), /no reviewer/);
    const badDate = buildFixtureCatalog();
    badDate.mutants[2].signOff = { by: "QA", at: "yesterday" };
    assert.match(refused(badDate).join("\n"), /ISO-8601/);
  });

  test("a baseline or detonator without a sign-off", () => {
    const raw = buildFixtureCatalog();
    delete raw.baselines[0].signOff;
    delete raw.baselines[1].detonator.signOff;
    const problems = refused(raw).join("\n");
    assert.match(problems, /baseline "fx-b-0": missing human sign-off/);
    assert.match(
      problems,
      /baseline "fx-b-1" detonator: missing human sign-off/,
    );
  });

  test("a baseline without a detonator", () => {
    const raw = buildFixtureCatalog();
    delete raw.baselines[5].detonator;
    assert.match(refused(raw).join("\n"), /missing detonator/);
  });

  test("overlapping mutant and baseline populations", () => {
    const raw = buildFixtureCatalog();
    raw.baselines[0].artifact = { ...raw.mutants[0].baseArtifact };
    raw.baselines[0].behaviour = raw.mutants[0].behaviour;
    assert.match(refused(raw).join("\n"), /overlaps the mutant population/);
    const sharedId = buildFixtureCatalog();
    sharedId.baselines[0].id = sharedId.mutants[0].id;
    assert.match(refused(sharedId).join("\n"), /duplicate id/);
    const detonatorIsMutant = buildFixtureCatalog();
    detonatorIsMutant.baselines[0].detonator.diff =
      detonatorIsMutant.mutants[0].diff;
    assert.match(
      refused(detonatorIsMutant).join("\n"),
      /held out of the scored set/,
    );
  });

  test("two mutants on one artifact×behaviour target, or one diff", () => {
    const raw = buildFixtureCatalog();
    raw.mutants[1].baseArtifact = { ...raw.mutants[0].baseArtifact };
    assert.match(refused(raw).join("\n"), /same artifact×behaviour target/);
    const sameDiff = buildFixtureCatalog();
    sameDiff.mutants[1].diff = sameDiff.mutants[0].diff;
    assert.match(refused(sameDiff).join("\n"), /identical diff/);
  });

  test("composition below the floors", () => {
    const fewer = buildFixtureCatalog({ perCategory: 4, baselines: 34 });
    const problems = refused(fewer);
    assert.ok(problems.includes("composition: N = 24 mutants < 30"));
    assert.ok(problems.includes("composition: M = 34 baselines < 35"));
    assert.ok(problems.includes("composition: category acl has 4 mutants < 5"));
    // A refused entry never pads its category.
    const padded = buildFixtureCatalog();
    padded.mutants[5].category = "not-a-category";
    const padProblems = refused(padded).join("\n");
    assert.match(padProblems, /category must be one of/);
    assert.match(padProblems, /category acl has 4 mutants < 5/);
  });

  test("a mutant whose expected verdict is not red", () => {
    const raw = buildFixtureCatalog();
    raw.mutants[0].expectedVerdict = "green";
    assert.match(refused(raw).join("\n"), /expectedVerdict must be "red"/);
  });

  test("a fault edited after its hash was recorded", () => {
    const raw = buildFixtureCatalog();
    raw.mutants[0].diffSha256 = sha256Hex(raw.mutants[0].diff);
    raw.mutants[0].diff += "// edited";
    assert.match(refused(raw).join("\n"), /edited after sign-off/);
  });

  test("lists every problem at once", () => {
    const raw = buildFixtureCatalog();
    delete raw.mutants[0].signOff;
    raw.mutants[1].expectedVerdict = "green";
    delete raw.baselines[0].detonator;
    assert.ok(refused(raw).length >= 3);
  });

  test("non-object input", () => {
    assert.throws(() => load(null), CatalogError);
    assert.throws(() => load({ catalogVersion: "x" }), CatalogError);
  });
});

describe("no default catalog", () => {
  test("a path is required and the file is validated", async () => {
    await assert.rejects(
      readCatalogFile("", DESIGN_GATE_POLICY),
      /no default catalog/,
    );
    const dir = await mkdtemp(join(tmpdir(), "bench-catalog-"));
    try {
      const good = join(dir, "catalog.json");
      await writeFile(good, JSON.stringify(buildFixtureCatalog()));
      const catalog = await readCatalogFile(good, DESIGN_GATE_POLICY);
      assert.equal(catalog.mutants.length, 30);
      await assert.rejects(
        readCatalogFile(join(dir, "absent.json"), DESIGN_GATE_POLICY),
        CatalogError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the package exports no catalog content and no fixture", () => {
    for (const name of Object.keys(api)) {
      assert.doesNotMatch(name, /fixture|default_?catalog|mutants$/i, name);
    }
  });
});
