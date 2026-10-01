// The ConfirmToken override policy, asserted as PROPERTIES of the reducer
// rather than pinned as bytes. The golden fixtures next door record whatever
// aggregateVerdict happens to produce, so they move whenever the behaviour
// moves — which is the wrong direction for a ratified policy. These tests
// state the policy itself, so a change to the reducer has to argue with them.
//
// Ratified policy (2026-08-29):
//   1. A ConfirmToken is minted iff status === "GO".
//   2. `overridden` is derived from what an override DID, not from what was
//      asked for: `overrides.some(o => o.affectedRows > 0)`.
//   3. The record survives in `overrides` — and in verdictHash — even when it
//      affected nothing and `overridden` is therefore false.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregateVerdict } from "../build/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Input builder. Everything is explicit and hermetic: no clock, no instance.
// ---------------------------------------------------------------------------

const spec = (n) => ({ id: `spec-0${n}`, path: `specs/spec-0${n}.yaml` });
const target = (n) => ({
  table: "sys_script_include",
  sysId: `sysid_0${n}`,
  name: `ScriptInclude${n}`,
});
const plan = (n) => ({ spec: spec(n), kind: "unit", target: target(n) });

const ALLOW_SKIPPED = {
  flag: "allow-skipped",
  // Deliberately wrong: the reducer recomputes affectedRows and must not
  // trust this number.
  affectedRows: 99,
  actor: "cli:ivan",
};

/**
 * Build a VerdictInput from a list of raw outcomes, one planned spec each.
 * `opts.overrides` defaults to none; `opts.demanded` lets a caller break
 * ARCH-30 parity on purpose; `opts.coverage`/`coverageFloor` drive the
 * coverage rung.
 */
function makeInput(raws, opts = {}) {
  const planned = raws.map((_, i) => plan(i + 1));
  return {
    planned,
    results: [
      {
        runId: "run-0001",
        outcomes: raws.map((raw, i) => ({
          spec: spec(i + 1),
          raw,
          evidence: { kind: "atf-result", ref: `atfres_0${i + 1}` },
        })),
      },
    ],
    impact: {
      nodes: planned.map((p) => p.target),
      edges: [],
      unanalyzable: [],
      demanded: opts.demanded ?? planned,
    },
    coverage: opts.coverage ?? { confirmedArtifacts: 1, impactedArtifacts: 1 },
    coverageFloor: opts.coverageFloor ?? 0.8,
    runId: "run-0001",
    topology: { source: "repo", runner: "dev000000", target: "dev000000" },
    overrides: opts.overrides ?? [],
    now: "2026-07-31T12:00:00.000Z",
    tokenTtlMs: 3600000,
  };
}

// One representative input per member of the VerdictStatus union, plus the
// distinct ladder paths that reach INCONCLUSIVE — the token rule has to hold
// on every rung, not just on the one a fixture happens to exercise.
const BY_STATUS = {
  GO: [
    ["clean GO", makeInput(["pass", "pass"])],
    [
      "GO under an override",
      makeInput(["pass", "skipped"], { overrides: [ALLOW_SKIPPED] }),
    ],
  ],
  NO_GO: [
    ["a failing row", makeInput(["fail"])],
    // Planned, but no result came back for it — the reducer synthesizes
    // raw "missing", which resolves to a blocking fail.
    [
      "a missing row",
      {
        ...makeInput(["pass"]),
        results: [{ runId: "run-0001", outcomes: [] }],
      },
    ],
    [
      "a failing row with an override applied",
      makeInput(["fail", "skipped"], { overrides: [ALLOW_SKIPPED] }),
    ],
  ],
  INCONCLUSIVE: [
    ["empty checklist", makeInput([])],
    ["parity breach", makeInput(["pass"], { demanded: [] })],
    ["a blocking inconclusive row", makeInput(["pass", "skipped"])],
    [
      "coverage below the floor",
      makeInput(["pass"], {
        coverage: { confirmedArtifacts: 1, impactedArtifacts: 10 },
        coverageFloor: 0.8,
      }),
    ],
  ],
};

describe("ConfirmToken issuance: a token exists iff the verdict is GO", () => {
  // The union is type-only, so there is no runtime constant to iterate. Read
  // it out of the emitted declaration instead: if a fourth status is ever
  // added, this fails until the case list covers it.
  it("the case list covers every member of the VerdictStatus union", () => {
    const dts = readFileSync(
      join(here, "..", "..", "types", "build", "verdict.d.ts"),
      "utf8",
    );
    const declaration = /export type VerdictStatus = ([^;]+);/.exec(dts);
    assert.ok(
      declaration,
      "VerdictStatus declaration not found in verdict.d.ts",
    );
    const members = declaration[1]
      .split("|")
      .map((m) => m.trim().replace(/^"|"$/g, ""));
    assert.deepEqual([...members].sort(), Object.keys(BY_STATUS).sort());
  });

  for (const [status, cases] of Object.entries(BY_STATUS)) {
    for (const [label, input] of cases) {
      it(`${status} via ${label}: token ${status === "GO" ? "present" : "absent"}`, () => {
        const verdict = aggregateVerdict(input);
        assert.equal(verdict.status, status);
        assert.equal(verdict.confirmToken !== undefined, status === "GO");
      });
    }
  }
});

describe("ConfirmToken.overridden denotes rows affected, not flags passed", () => {
  it("false on a GO reached with no override records", () => {
    const verdict = aggregateVerdict(makeInput(["pass", "pass"]));
    assert.equal(verdict.status, "GO");
    assert.deepEqual(verdict.overrides, []);
    assert.equal(verdict.confirmToken.overridden, false);
  });

  it("true on a GO where an accepted override affected a row", () => {
    const verdict = aggregateVerdict(
      makeInput(["pass", "skipped"], { overrides: [ALLOW_SKIPPED] }),
    );
    assert.equal(verdict.status, "GO");
    assert.equal(verdict.overrides.length, 1);
    // Recomputed, not the caller's 99.
    assert.equal(verdict.overrides[0].affectedRows, 1);
    assert.equal(verdict.confirmToken.overridden, true);
  });

  // The case that motivated the ruling: the flag was passed, accepted and
  // journalled, and it changed nothing.
  it("false when the accepted override affected zero rows", () => {
    const verdict = aggregateVerdict(
      makeInput(["pass", "pass"], { overrides: [ALLOW_SKIPPED] }),
    );
    assert.equal(verdict.status, "GO");
    assert.equal(verdict.overrides.length, 1);
    assert.equal(verdict.overrides[0].affectedRows, 0);
    assert.equal(verdict.confirmToken.overridden, false);
  });

  it("false when the record was rejected and never entered overrides", () => {
    const verdict = aggregateVerdict(
      makeInput(["pass", "pass"], {
        overrides: [{ flag: "nogo-override", affectedRows: 1, actor: "x" }],
      }),
    );
    assert.equal(verdict.status, "GO");
    assert.deepEqual(verdict.overrides, []);
    assert.equal(verdict.confirmToken.overridden, false);
    assert.ok(
      verdict.warnings.some((w) => w.startsWith("unknown override flag")),
    );
  });
});

describe("a zero-effect override survives in the audit trail", () => {
  const withRecord = aggregateVerdict(
    makeInput(["pass", "pass"], { overrides: [ALLOW_SKIPPED] }),
  );
  const withoutRecord = aggregateVerdict(makeInput(["pass", "pass"]));

  it("the record stays in overrides even though it flipped nothing", () => {
    assert.deepEqual(withRecord.overrides, [
      { flag: "allow-skipped", affectedRows: 0, actor: "cli:ivan" },
    ]);
    assert.equal(withRecord.confirmToken.overridden, false);
  });

  it("the rows are identical, so only overrides can move the digest", () => {
    assert.deepEqual(withRecord.rows, withoutRecord.rows);
    assert.deepEqual(withRecord.counts, withoutRecord.counts);
  });

  it("overrides are inside verdictHash: the digest differs anyway", () => {
    assert.notEqual(
      withRecord.confirmToken.verdictHash,
      withoutRecord.confirmToken.verdictHash,
    );
  });

  it("the actor is inside verdictHash too", () => {
    const other = aggregateVerdict(
      makeInput(["pass", "pass"], {
        overrides: [{ ...ALLOW_SKIPPED, actor: "cli:someone-else" }],
      }),
    );
    assert.notEqual(
      withRecord.confirmToken.verdictHash,
      other.confirmToken.verdictHash,
    );
  });
});

// The premise the whole derivation rests on, pinned at the point the
// derivation consumes it. "affectedRows counts skipped rows" equals "rows
// actually flipped" only because a skipped row is ALWAYS blocking when the
// override loop reaches it — a constant in the resolution table, thirty lines
// away from the loop that depends on it. Nothing in the loop rechecks it, so
// if that constant moves, `overridden` stops meaning what its comment says
// while every whole-reducer assertion still passes. These two tests are the
// only thing standing between that constant and a silently false comment.
describe("the resolution-table premise behind affectedRows", () => {
  it("a skipped row reaches the override loop blocking and inconclusive", () => {
    // No override: the row is observed in exactly the state the loop reads,
    // since nothing writes row.blocking between row construction and the loop.
    const verdict = aggregateVerdict(makeInput(["pass", "skipped"]));
    const row = verdict.rows.find((r) => r.raw === "skipped");
    assert.ok(row, "expected a skipped row");
    assert.equal(row.status, "inconclusive");
    assert.equal(row.blocking, true);
    assert.equal(row.overridden, false);
  });

  it("affectedRows equals the number of rows that were blocking before", () => {
    const raws = ["pass", "skipped", "skipped"];
    const before = aggregateVerdict(makeInput(raws));
    const flippable = before.rows.filter(
      (r) => r.raw === "skipped" && r.blocking,
    ).length;
    const after = aggregateVerdict(
      makeInput(raws, { overrides: [ALLOW_SKIPPED] }),
    );
    // Counted ≡ flipped. If a skipped row could arrive already non-blocking,
    // affectedRows would over-count and `overridden` would over-claim.
    assert.equal(after.overrides[0].affectedRows, flippable);
    assert.equal(flippable, 2);
  });
});

// What `overridden: true` is worth relying on, proved by counterfactual
// rather than asserted. Only the GO branch mints a token, and no other rung
// of the ladder is override-sensitive, so on a token "a row was affected" and
// "this run was lifted from INCONCLUSIVE to GO" coincide. Off a token they do
// not, which is why the flag must stay inside the token.
describe("what an override can and cannot promote", () => {
  const raws = ["pass", "skipped"];

  it("INCONCLUSIVE -> GO: the same run flips only because of the override", () => {
    const before = aggregateVerdict(makeInput(raws));
    const after = aggregateVerdict(
      makeInput(raws, { overrides: [ALLOW_SKIPPED] }),
    );
    assert.equal(before.status, "INCONCLUSIVE");
    assert.equal(before.confirmToken, undefined);
    assert.equal(after.status, "GO");
    assert.equal(after.confirmToken.overridden, true);
  });

  it("NO_GO is unreachable: a fail row survives the override", () => {
    const input = makeInput(["fail", "skipped"], {
      overrides: [ALLOW_SKIPPED],
    });
    const verdict = aggregateVerdict(input);
    // The override was accepted and did flip the skipped row...
    assert.equal(verdict.overrides[0].affectedRows, 1);
    assert.equal(verdict.rows.find((r) => r.raw === "skipped").blocking, false);
    // ...and the verdict is still NO_GO, with no token to carry a flag.
    assert.equal(verdict.status, "NO_GO");
    assert.equal(verdict.confirmToken, undefined);
  });

  it("rows can be affected with nothing promoted, off the GO branch", () => {
    // A surviving blocking-inconclusive row (raw "error") keeps the ladder
    // where it was, so affectedRows > 0 does NOT mean the verdict moved.
    const input = makeInput(["skipped", "error"], {
      overrides: [ALLOW_SKIPPED],
    });
    const verdict = aggregateVerdict(input);
    assert.equal(verdict.overrides[0].affectedRows, 1);
    assert.equal(verdict.status, "INCONCLUSIVE");
    assert.equal(verdict.confirmToken, undefined);
  });

  it("nothing promotes implicitly: without the record the run stays put", () => {
    assert.equal(aggregateVerdict(makeInput(raws)).status, "INCONCLUSIVE");
  });
});
