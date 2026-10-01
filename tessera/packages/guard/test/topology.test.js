// §11.5 per topology role, and the composition-time gate resolvePipeline runs
// before any adapter is constructed (§11.1 step zero).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GuardViolation, createTargetGuard } from "../build/index.js";

const ref = (host, name = host) => ({ name, host });
const cleanProbe = () =>
  Promise.resolve({ productionProperty: false, atfRunnerEnabled: true });

const SUB_PROD = "dev12345.service-now.com";
const SUB_PROD_2 = "test999.service-now.com";
const SUSPECT = "acme-sub.service-now.com";
const PROD = "acme.service-now.com";

const ACK = {
  reason: "clone renamed the instance; allowlist entry re-verified by hand",
  actor: "ivan@example.com",
  surface: "cli",
};

function build(extra = {}) {
  const entries = [];
  const guard = createTargetGuard(
    {
      nonProdAllowlist: [SUB_PROD, SUB_PROD_2, SUSPECT],
      prodInstances: [PROD],
      ...extra,
    },
    {
      probe: cleanProbe,
      audit: { record: (e) => entries.push(e) },
      runId: "run-42",
      now: () => "2026-08-07T00:00:00.000Z",
    },
  );
  return { guard, entries };
}

function refusal(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof GuardViolation,
      `not a GuardViolation: ${error}`,
    );
    return error;
  }
  return assert.fail("expected a GuardViolation");
}

describe("classifyTopology", () => {
  it("classifies all three §2a roles", async () => {
    const { guard } = build();
    const roles = await guard.classifyTopology({
      source: ref(SUB_PROD),
      runner: ref(SUB_PROD_2),
      target: ref(PROD),
    });
    assert.equal(roles.source.cls, "sub-prod");
    assert.equal(roles.source.role, "source");
    assert.equal(roles.runner.cls, "sub-prod");
    assert.equal(roles.target.cls, "prod");
    assert.equal(roles.target.role, "target");
  });

  it("omits target when the topology has none (ARCH-8)", async () => {
    const { guard } = build();
    const roles = await guard.classifyTopology({
      source: ref(SUB_PROD),
      runner: ref(SUB_PROD),
    });
    assert.equal(roles.target, undefined);
    assert.equal(guard.pinned().length, 2);
  });

  it("classifies a collapsed source = runner topology per role", async () => {
    const { guard } = build();
    const roles = await guard.classifyTopology({
      source: ref(SUB_PROD),
      runner: ref(SUB_PROD),
    });
    // Same instance, two pinned classifications — classification is per
    // instance + role (§11.1).
    assert.notEqual(roles.source, roles.runner);
    assert.equal(roles.source.role, "source");
    assert.equal(roles.runner.role, "runner");
  });

  it("keeps an unclassified instance unknown in every role", async () => {
    const { guard } = build();
    const roles = await guard.classifyTopology({
      source: ref("nowhere.service-now.com"),
      runner: ref("nowhere.service-now.com"),
      target: ref("nowhere.service-now.com"),
    });
    assert.deepEqual(
      [roles.source.cls, roles.runner.cls, roles.target.cls],
      ["unknown", "unknown", "unknown"],
    );
  });
});

describe("§11.5 assertRunnerWritable — the composition gate", () => {
  it("passes a sub-prod runner", async () => {
    const { guard } = build();
    const c = await guard.classify(ref(SUB_PROD), "runner");
    assert.equal(guard.assertRunnerWritable(c), undefined);
  });

  it("fails a declared-prod runner — no override lifts it", async () => {
    const { guard } = build();
    const c = await guard.classify(ref(PROD), "runner");
    const error = refusal(() => guard.assertRunnerWritable(c));
    assert.equal(error.detail.reason, "runner-not-writable");
    assert.match(error.message, /can never be prod\/unknown/);
    assert.equal(error.detail.intent, undefined);
  });

  it("fails an unknown runner", async () => {
    const { guard } = build();
    const c = await guard.classify(ref("nowhere.service-now.com"), "runner");
    const error = refusal(() => guard.assertRunnerWritable(c));
    assert.equal(error.detail.reason, "runner-not-writable");
  });

  it("fails a declared-prod runner even with an acknowledge-prod present", async () => {
    const { guard, entries } = build({ acknowledgeProd: ACK });
    const c = await guard.classify(ref(PROD), "runner");
    assert.equal(
      refusal(() => guard.assertRunnerWritable(c)).detail.reason,
      "runner-not-writable",
    );
    assert.deepEqual(entries, []);
  });

  it("fails a prod-suspect runner with no acknowledgement", async () => {
    const { guard } = build();
    const c = await guard.classify(ref(SUSPECT), "runner");
    const error = refusal(() => guard.assertRunnerWritable(c));
    assert.equal(error.detail.reason, "unacknowledged-suspect");
  });

  it("passes a prod-suspect runner covered by an acknowledgement, journalling it first", async () => {
    const { guard, entries } = build({ acknowledgeProd: ACK });
    const c = await guard.classify(ref(SUSPECT), "runner");
    assert.equal(guard.assertRunnerWritable(c), undefined);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "acknowledge-prod");
    // The composition-time entry is the same one the first write reuses.
    guard.assertWrite(c, { op: "create", table: "sys_atf_test" });
    assert.equal(entries.length, 1);
  });

  it("refuses a classification that is not the runner's", async () => {
    const { guard } = build();
    const c = await guard.classify(ref(SUB_PROD), "target");
    const error = refusal(() => guard.assertRunnerWritable(c));
    assert.equal(error.detail.reason, "role-forbids-write");
  });
});
