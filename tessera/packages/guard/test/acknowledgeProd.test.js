// §11.4 audited override — what it clears, what it can never clear, and the
// write-ahead ledger entry that has to land before the first write (§4b).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GuardViolation, createTargetGuard } from "../build/index.js";

const ref = (host, name = host) => ({ name, host });
const cleanProbe = () =>
  Promise.resolve({ productionProperty: false, atfRunnerEnabled: true });

const SUB_PROD = "dev12345.service-now.com";
const SUSPECT = "acme-sub.service-now.com"; // allowlisted, unmarked name
const PROD = "acme.service-now.com";

const CLI_ACK = {
  reason: "heuristic investigated: instance renamed after a clone",
  actor: "ivan@example.com",
  surface: "cli",
};

function sink() {
  const entries = [];
  return { entries, record: (entry) => entries.push(entry) };
}

function build({ ack = CLI_ACK, audit = sink(), runId = "run-1" } = {}) {
  const guard = createTargetGuard(
    {
      nonProdAllowlist: [SUB_PROD, SUSPECT],
      prodInstances: [PROD],
      ...(ack === null ? {} : { acknowledgeProd: ack }),
    },
    {
      probe: cleanProbe,
      ...(audit === null ? {} : { audit }),
      ...(runId === null ? {} : { runId }),
      now: () => "2026-08-07T00:00:00.000Z",
    },
  );
  return { guard, audit };
}

const intent = { op: "create", table: "sys_atf_test" };

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

describe("§11.4 override accepts a prod-suspect runner", () => {
  it("admits the write and journals the opening ledger entry", async () => {
    const { guard, audit } = build();
    const c = await guard.classify(ref(SUSPECT), "runner");
    assert.equal(c.cls, "prod-suspect");
    guard.assertWrite(c, intent);

    assert.equal(audit.entries.length, 1);
    const entry = audit.entries[0];
    assert.equal(entry.kind, "acknowledge-prod");
    assert.equal(entry.runId, "run-1");
    assert.equal(entry.instance.host, SUSPECT);
    assert.equal(entry.role, "runner");
    assert.equal(entry.cls, "prod-suspect");
    assert.equal(entry.reason, CLI_ACK.reason);
    assert.equal(entry.actor, CLI_ACK.actor);
    assert.equal(entry.surface, "cli");
    assert.equal(entry.at, "2026-08-07T00:00:00.000Z");
    assert.ok(entry.evidence.some((s) => s.kind === "name-pattern"));
  });

  it("journals once per instance+role, however many writes follow", async () => {
    const { guard, audit } = build();
    const c = await guard.classify(ref(SUSPECT), "runner");
    guard.assertWrite(c, intent);
    guard.assertWrite(c, { op: "update", table: "sys_variable_value" });
    guard.assertWrite(c, { op: "delete", table: "sys_atf_test" });
    assert.equal(audit.entries.length, 1);
  });

  it("surfaces the override on the run record (§11.6)", async () => {
    const { guard } = build();
    const c = await guard.classify(ref(SUSPECT), "runner");
    assert.deepEqual(guard.acknowledgements(), []);
    guard.assertWrite(c, intent);
    assert.equal(guard.acknowledgements().length, 1);
    assert.equal(guard.acknowledgements()[0].reason, CLI_ACK.reason);
  });

  it("accepts an MCP override that carries the §9.5 human confirmation", async () => {
    const { guard, audit } = build({
      ack: { ...CLI_ACK, surface: "mcp", humanConfirmed: true },
    });
    const c = await guard.classify(ref(SUSPECT), "runner");
    guard.assertWrite(c, intent);
    assert.equal(audit.entries.length, 1);
  });

  it("accepts a config-sourced override", async () => {
    const { guard, audit } = build({ ack: { ...CLI_ACK, surface: "config" } });
    const c = await guard.classify(ref(SUSPECT), "runner");
    guard.assertWrite(c, intent);
    assert.equal(audit.entries.length, 1);
  });

  it("does not journal anything for a clean sub-prod runner", async () => {
    const { guard, audit } = build();
    const c = await guard.classify(ref(SUB_PROD), "runner");
    guard.assertWrite(c, intent);
    assert.deepEqual(audit.entries, []);
  });
});

describe("§11.4 override refusals", () => {
  const invalid = [
    ["an empty reason", { ...CLI_ACK, reason: "" }],
    ["a whitespace-only reason", { ...CLI_ACK, reason: "   " }],
    ["a missing reason", { actor: "ivan", surface: "cli" }],
    ["a non-string reason", { ...CLI_ACK, reason: 7 }],
    ["a missing actor", { reason: "because", surface: "cli" }],
    ["an empty actor", { ...CLI_ACK, actor: " " }],
    ["an unrecognised surface", { ...CLI_ACK, surface: "webhook" }],
    ["a missing surface", { reason: "because", actor: "ivan" }],
    ["an unconfirmed MCP override", { ...CLI_ACK, surface: "mcp" }],
    [
      "an MCP override confirmed with a non-true value",
      { ...CLI_ACK, surface: "mcp", humanConfirmed: "yes" },
    ],
  ];

  for (const [label, ack] of invalid) {
    it(`refuses ${label}`, async () => {
      const { guard, audit } = build({ ack });
      const c = await guard.classify(ref(SUSPECT), "runner");
      const error = refusal(() => guard.assertWrite(c, intent));
      assert.equal(error.detail.reason, "override-invalid");
      assert.deepEqual(audit.entries, []);
    });
  }

  it("names the §9.5 confirmation in the MCP refusal", async () => {
    const { guard } = build({ ack: { ...CLI_ACK, surface: "mcp" } });
    const c = await guard.classify(ref(SUSPECT), "runner");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.match(error.message, /out-of-band human confirmation/);
    assert.ok(error.detail.design.includes("§9.5"));
  });

  it("refuses when the override cannot be journalled — no ledger sink", async () => {
    const { guard } = build({ audit: null });
    const c = await guard.classify(ref(SUSPECT), "runner");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "override-not-journalled");
  });

  it("refuses when the override has no run to be scoped to", async () => {
    const { guard } = build({ runId: null });
    const c = await guard.classify(ref(SUSPECT), "runner");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "override-not-journalled");
  });

  it("refuses when the ledger write fails, and keeps no record", async () => {
    const audit = {
      entries: [],
      record: () => {
        throw new Error("disk full");
      },
    };
    const { guard } = build({ audit });
    const c = await guard.classify(ref(SUSPECT), "runner");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "override-not-journalled");
    assert.match(error.message, /disk full/);
    assert.deepEqual(guard.acknowledgements(), []);
    // Still refused on the next attempt — a failed flush is not a pass.
    refusal(() => guard.assertWrite(c, intent));
  });
});

describe("§11.4 hard floors the override can never lift", () => {
  it("never clears a declared prod runner", async () => {
    const { guard, audit } = build();
    const c = await guard.classify(ref(PROD), "runner");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "declared-prod");
    assert.deepEqual(audit.entries, []);
  });

  it("never clears an unknown instance", async () => {
    const { guard, audit } = build();
    const c = await guard.classify(ref("mystery.service-now.com"), "runner");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "unknown-instance");
    assert.deepEqual(audit.entries, []);
  });

  it("never clears a write bound to the target role", async () => {
    const { guard, audit } = build();
    const c = await guard.classify(ref(SUSPECT), "target");
    assert.equal(c.cls, "prod-suspect");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "role-forbids-write");
    assert.deepEqual(audit.entries, []);
  });

  it("never clears a write bound to the source role", async () => {
    const { guard } = build();
    const c = await guard.classify(ref(SUSPECT), "source");
    const error = refusal(() => guard.assertWrite(c, intent));
    assert.equal(error.detail.reason, "role-forbids-write");
  });
});
