// Property tests for the §6b plan hash. These assert the PROPERTY the hash
// exists to provide — same writes ⇒ same digest, different writes ⇒ different
// digest — not the digest the current code happens to produce. Changing the
// hashed input set must break these, which is the point; a change that leaves
// them green has not changed what the hash means.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PLAN_HASH_VERSION,
  canonicalJson,
  computePlanHash,
  planHashPreimage,
  sha256Hex,
} from "../build/index.js";

/** A plan carrying every field the real `PreflightProvisionPlan` carries. */
function plan(overrides = {}) {
  return {
    actions: [
      {
        kind: "update",
        table: "sys_properties",
        description: "set sn_atf.runner.enabled to true (DR-3)",
      },
    ],
    steps: [
      {
        precondition: "atf-runner-enabled",
        action: {
          kind: "update",
          table: "sys_properties",
          description: "set sn_atf.runner.enabled to true (DR-3)",
        },
        write: {
          kind: "update-record",
          table: "sys_properties",
          sysId: "aaaa1111",
          fields: { value: "true" },
        },
        observed: "sys_properties/aaaa1111 reads value=false",
      },
    ],
    blockers: [],
    readiness: "degraded",
    ...overrides,
  };
}

/** Replace a single field on the plan's one step. */
function withStep(patch) {
  const base = plan();
  const [step] = base.steps;
  return { ...base, steps: [{ ...step, ...patch }] };
}

/** Replace a single field on the plan's one write. */
function withWrite(patch) {
  const base = plan();
  const [step] = base.steps;
  return {
    ...base,
    steps: [{ ...step, write: { ...step.write, ...patch } }],
  };
}

describe("computePlanHash — shape of the digest", () => {
  it("is a lowercase hex sha256 of the expected width", () => {
    assert.match(computePlanHash(plan()), /^[0-9a-f]{64}$/);
  });

  it("is stable across two calls in the same process", () => {
    const p = plan();
    assert.equal(computePlanHash(p), computePlanHash(p));
  });

  it("is stable across two structurally identical plan objects", () => {
    assert.equal(computePlanHash(plan()), computePlanHash(plan()));
  });

  it("gives an empty plan a real digest rather than a special case", () => {
    assert.match(computePlanHash({ steps: [] }), /^[0-9a-f]{64}$/);
    assert.notEqual(computePlanHash({ steps: [] }), computePlanHash(plan()));
  });
});

describe("computePlanHash — fields that change the writes MUST change it", () => {
  // Each of these is a different mutation reaching the instance. If any of
  // them hashes the same as the baseline, a changed plan can replay as the
  // reviewed one — the dangerous direction.
  const baseline = computePlanHash(plan());

  it("changes when the written table changes", () => {
    assert.notEqual(
      computePlanHash(withWrite({ table: "sys_user" })),
      baseline,
    );
  });

  it("changes when the written sys_id changes", () => {
    assert.notEqual(
      computePlanHash(withWrite({ sysId: "bbbb2222" })),
      baseline,
    );
  });

  it("changes when a written field VALUE changes", () => {
    assert.notEqual(
      computePlanHash(withWrite({ fields: { value: "false" } })),
      baseline,
    );
  });

  it("changes when a written field NAME changes", () => {
    assert.notEqual(
      computePlanHash(withWrite({ fields: { other: "true" } })),
      baseline,
    );
  });

  it("changes when an extra written field is added", () => {
    assert.notEqual(
      computePlanHash(withWrite({ fields: { value: "true", note: "x" } })),
      baseline,
    );
  });

  it("changes when the write kind changes", () => {
    assert.notEqual(
      computePlanHash(withWrite({ kind: "create-record" })),
      baseline,
    );
  });

  it("changes when the precondition changes (it selects what apply verifies)", () => {
    assert.notEqual(
      computePlanHash(withStep({ precondition: "atf-plugin-active" })),
      baseline,
    );
  });

  it("changes when a step is added", () => {
    const base = plan();
    const [step] = base.steps;
    const two = {
      ...base,
      steps: [
        step,
        {
          ...step,
          precondition: "second",
          write: { ...step.write, sysId: "cccc3333" },
        },
      ],
    };
    assert.notEqual(computePlanHash(two), baseline);
  });

  it("changes when two steps are reordered (apply writes sequentially)", () => {
    const base = plan();
    const [step] = base.steps;
    const second = {
      ...step,
      precondition: "second",
      write: { ...step.write, sysId: "cccc3333" },
    };
    const forward = { ...base, steps: [step, second] };
    const reversed = { ...base, steps: [second, step] };
    assert.notEqual(computePlanHash(forward), computePlanHash(reversed));
  });
});

describe("computePlanHash — deliberately excluded fields MUST NOT change it", () => {
  // These are commentary or roll-ups. `provisioner.apply()` reads none of them
  // ("Blockers do NOT cancel the applicable steps"), so a plan that differs
  // only here executes byte-identically and must stay appliable — otherwise
  // ordinary instance churn makes every outstanding plan read as stale.
  const baseline = computePlanHash(plan());

  it("ignores the human-readable action description", () => {
    const base = plan();
    const [step] = base.steps;
    const reworded = {
      ...base,
      steps: [
        {
          ...step,
          action: { ...step.action, description: "completely different prose" },
        },
      ],
    };
    assert.equal(computePlanHash(reworded), baseline);
  });

  it("ignores the `observed` probe evidence", () => {
    assert.equal(
      computePlanHash(withStep({ observed: "some other evidence string" })),
      baseline,
    );
  });

  it("ignores the projected `actions` list", () => {
    assert.equal(computePlanHash({ ...plan(), actions: [] }), baseline);
  });

  it("ignores blockers appearing or clearing", () => {
    assert.equal(
      computePlanHash({
        ...plan(),
        blockers: [
          {
            precondition: "atf-plugin-active",
            status: "blocked",
            evidence: "plugin not installed",
            why: "no write can fix this",
          },
        ],
      }),
      baseline,
    );
  });

  it("ignores the readiness roll-up", () => {
    assert.equal(
      computePlanHash({ ...plan(), readiness: "blocked" }),
      baseline,
    );
  });

  it("ignores hardFailure", () => {
    assert.equal(
      computePlanHash({ ...plan(), hardFailure: "unit kind cannot run here" }),
      baseline,
    );
  });
});

describe("computePlanHash — construction order is not content", () => {
  it("is insensitive to key insertion order on the step", () => {
    const a = {
      steps: [
        {
          precondition: "p",
          write: {
            kind: "update-record",
            table: "t",
            sysId: "s",
            fields: { a: "1", b: "2" },
          },
        },
      ],
    };
    const b = {
      steps: [
        {
          write: {
            fields: { b: "2", a: "1" },
            sysId: "s",
            table: "t",
            kind: "update-record",
          },
          precondition: "p",
        },
      ],
    };
    assert.equal(computePlanHash(a), computePlanHash(b));
  });

  it("is insensitive to field key insertion order across many keys", () => {
    const keys = ["z", "m", "a", "q", "b"];
    const forward = Object.fromEntries(keys.map((k) => [k, k]));
    const backward = Object.fromEntries([...keys].reverse().map((k) => [k, k]));
    assert.equal(
      computePlanHash(withWrite({ fields: forward })),
      computePlanHash(withWrite({ fields: backward })),
    );
  });
});

// Delegated decision 2026-09-23 (planHash ambiguity #3): the definition is
// versioned, and the version rides in the preimage so the 64-hex output format
// other packages pin is unchanged. These pin the tag itself — bumping it must
// be a deliberate edit here, not a side effect.
describe("computePlanHash version tag", () => {
  it("pins the version tag to tessera-plan/v1", () => {
    assert.equal(PLAN_HASH_VERSION, "tessera-plan/v1");
  });

  it("prefixes the preimage with the version tag and a newline", () => {
    const preimage = planHashPreimage(plan());
    assert.ok(preimage.startsWith("tessera-plan/v1\n"), preimage);
    // The rest is exactly one canonical JSON document: the projected steps.
    const body = preimage.slice("tessera-plan/v1\n".length);
    assert.equal(canonicalJson(JSON.parse(body)), body);
  });

  it("digests the versioned preimage and keeps the 64-hex format", () => {
    const p = plan();
    const hash = computePlanHash(p);
    assert.equal(hash, sha256Hex(planHashPreimage(p)));
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("differs from the unversioned digest of the same projection", () => {
    const p = plan();
    const body = planHashPreimage(p).slice(PLAN_HASH_VERSION.length + 1);
    assert.notEqual(computePlanHash(p), sha256Hex(body));
  });
});
