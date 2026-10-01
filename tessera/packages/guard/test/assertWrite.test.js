// §11.3 enforcement at the single mutation channel (ARCH-3) and the §11.5
// per-role floors. Every refusal is a GuardViolation, never a silent skip.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GuardViolation,
  createTargetGuard,
  formatGuardViolation,
} from "../build/index.js";

const ref = (host, name = host) => ({ name, host });
const cleanProbe = () =>
  Promise.resolve({ productionProperty: false, atfRunnerEnabled: true });

const SUB_PROD = "dev12345.service-now.com";
const SUSPECT = "acme-sub.service-now.com"; // allowlisted, no non-prod marker
const PROD = "acme.service-now.com";

const guardWith = (overrides = {}) =>
  createTargetGuard(
    {
      nonProdAllowlist: [SUB_PROD, SUSPECT],
      prodInstances: [PROD],
      ...overrides,
    },
    { probe: cleanProbe },
  );

const intent = {
  op: "create",
  table: "sys_atf_test",
  description: "project spec tessera/skeleton",
};

/** Assert a GuardViolation and hand back its structured detail. */
function refusal(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof GuardViolation,
      `not a GuardViolation: ${error}`,
    );
    assert.equal(error.name, "GuardViolation");
    return error;
  }
  return assert.fail("expected a GuardViolation");
}

describe("§11.3 assertWrite on the mutation channel", () => {
  it("admits a write to a sub-prod runner", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(SUB_PROD), "runner");
    assert.equal(guard.assertWrite(c, intent), undefined);
  });

  it("refuses a write to an unknown instance — no flag upgrades it", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref("mystery.service-now.com"), "runner");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "unknown-instance");
    assert.match(error.detail.remedy, /no runtime option upgrades/);
  });

  it("refuses a write to a declared prod runner", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(PROD), "runner");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "declared-prod");
  });

  it("refuses a write to an unacknowledged prod-suspect runner", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(SUSPECT), "runner");
    assert.equal(c.cls, "prod-suspect");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "unacknowledged-suspect");
    assert.match(error.detail.remedy, /--acknowledge-prod <reason>/);
  });

  it("carries the full structured detail of the refusal", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(PROD), "runner");
    const { detail } = refusal(() => guard.assertWrite(c, intent));
    assert.equal(detail.instance.host, PROD);
    assert.equal(detail.role, "runner");
    assert.equal(detail.cls, "prod");
    assert.equal(detail.intent, intent);
    assert.ok(detail.evidence.some((s) => s.kind === "prod-declaration"));
    assert.ok(detail.design.includes("§11.4"));
    assert.ok(detail.remedy.length > 0);
  });

  it("renders the refusal for the CLI/verdict surface", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(SUSPECT), "runner");
    const text = formatGuardViolation(
      refusal(() => guard.assertWrite(c, intent)),
    );
    assert.match(text, /GuardViolation \[unacknowledged-suspect\]/);
    assert.match(text, /class: {4}prod-suspect/);
    assert.match(text, /refused: {2}create sys_atf_test — project spec/);
    assert.match(text, /\[downgrade\] name-pattern/);
    assert.match(text, /remedy:/);
  });

  it("exposes no read entry point — reads are never gated (§11.3)", () => {
    const guard = guardWith();
    assert.deepEqual(Object.keys(guard).sort(), [
      "acknowledgements",
      "assertRunnerWritable",
      "assertWrite",
      "classify",
      "classifyTopology",
      "pinned",
    ]);
  });
});

describe("§11.5 role floors", () => {
  it("refuses a write bound to the source role", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(SUB_PROD), "source");
    assert.equal(c.cls, "sub-prod");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "role-forbids-write");
  });

  it("refuses a write bound to the target role even when it is sub-prod", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(SUB_PROD), "target");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "role-forbids-write");
    assert.match(error.message, /never receives pipeline writes/);
  });

  it("refuses a prod target on the role floor, before the class floor", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(PROD), "target");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "role-forbids-write");
  });

  it("notes the read-only target policy on the classification evidence", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(PROD), "target");
    const note = c.evidence.find((s) => s.kind === "role-policy");
    assert.equal(note.effect, "warning");
    assert.match(note.detail, /target is read-only/);
  });

  it("notes that a prod source is allowed but discouraged", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(PROD), "source");
    assert.match(
      c.evidence.find((s) => s.kind === "role-policy").detail,
      /allowed but discouraged/,
    );
  });

  it("notes that a prod runner is a hard config error", async () => {
    const guard = guardWith();
    const c = await guard.classify(ref(PROD), "runner");
    assert.match(
      c.evidence.find((s) => s.kind === "role-policy").detail,
      /runner can never be prod\/unknown/,
    );
  });
});

describe("fail-closed on a classification the guard did not issue", () => {
  const forged = {
    cls: "sub-prod",
    role: "runner",
    instance: { name: "forged", host: SUB_PROD },
    host: SUB_PROD,
    evidence: [],
  };

  it("refuses a hand-built classification", () => {
    const error = refusal(() => guardWith().assertWrite(forged, intent));
    assert.equal(error.detail.reason, "malformed-classification");
  });

  it("refuses a classification issued by a different guard", async () => {
    const other = guardWith();
    const c = await other.classify(ref(SUB_PROD), "runner");
    const error = refusal(() => guardWith().assertWrite(c, intent));
    assert.equal(error.detail.reason, "malformed-classification");
  });

  it("refuses structurally broken input without throwing a TypeError", () => {
    for (const bad of [null, undefined, {}, { cls: "safe", role: "runner" }]) {
      const error = refusal(() => guardWith().assertWrite(bad, intent));
      assert.equal(error.detail.reason, "malformed-classification");
      assert.equal(error.detail.cls, "unknown");
    }
  });

  it("marks a role it had to invent, instead of reporting it as observed", () => {
    // `InstanceRole` is a closed union, so a violation over an unreadable
    // classification has to name SOME role to stay renderable. `instance`
    // already says `<unclassified>` out loud; leaving `role` as the only
    // unmarked fabrication would let a reader take one printed line as an
    // observation and the two beside it as placeholders.
    for (const bad of [null, undefined, {}, { cls: "sub-prod" }]) {
      const error = refusal(() => guardWith().assertWrite(bad, intent));
      const invented = error.detail.evidence.find((s) =>
        /placeholder, not an observation/.test(s.detail),
      );
      assert.ok(
        invented,
        `no evidence records the invented role for ${JSON.stringify(bad)}`,
      );
      assert.equal(invented.effect, "warning");
      assert.match(formatGuardViolation(error), /placeholder/);
    }
  });

  it("says nothing about an invented role when the role WAS readable", () => {
    // The mirror of the test above: a fabrication note on a role that really
    // was read off the input would be as false as the silence it replaced.
    const error = refusal(() =>
      guardWith().assertWrite({ cls: "safe", role: "source" }, intent),
    );
    assert.equal(error.detail.role, "source");
    assert.deepEqual(error.detail.evidence, []);
  });

  it("refuses the composition-time check for a foreign classification", () => {
    const error = refusal(() => guardWith().assertRunnerWritable(forged));
    assert.equal(error.detail.reason, "malformed-classification");
  });
});
