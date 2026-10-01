// The Provisioner — PLAN Phase 1.
//
// Two halves, for the same reason the doctor's suite has two.
//
//  * The PLAN/APPLY half stubs the doctor, the probe and the writer. What is
//    under test there is the decision logic — which findings become steps,
//    which become blockers, what `apply()` refuses, and what it does when a
//    write succeeds but the instance disagrees. A real instance would only add
//    ways for those assertions to pass for the wrong reason.
//
//  * The LIVE half runs the real doctor, the real probe and the real
//    `@tessera/sn-client` write path against the QA-18 stateful fake. Those
//    assertions are about the mutation channel: that the PATCH lands on the row
//    the plan named, that it is journalled (DEV-15), and that a provisioner in
//    the default mode never puts a write on the wire at all.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ATF_AUTHORING_TABLES,
  ATF_RUNNER_ENABLED_PROPERTY,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
  PRECONDITION_IDS,
  SYS_PROPERTIES_TABLE,
  createDefaultPreconditions,
  createEnvironmentDoctor,
  createSnInstanceProbe,
} from "@tessera/doctor";
import { computePlanHash } from "@tessera/core";
import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import {
  ProvisionApplyError,
  ProvisionRefusedError,
  ProvisionVerificationError,
  createPreflightProvisioner,
  createSnInstanceWriter,
  defineRecipe,
  enableAtfRunnerRecipe,
  formatProvisionPlan,
  isExecutable,
} from "../build/index.js";

// ── plan/apply half ─────────────────────────────────────────────────────────

function finding(precondition, status, applicability, extra = {}) {
  return {
    precondition,
    status,
    applicability,
    evidence: `stub says ${status}`,
    ...extra,
  };
}

function report(status, findings, hardFailure) {
  return {
    status,
    findings,
    ...(hardFailure === undefined ? {} : { hardFailure }),
  };
}

/**
 * A doctor that answers with the given reports in order (the last one repeats).
 * `calls` is what proves apply() re-diagnoses — or does not.
 */
function queuedDoctor(...reports) {
  const calls = [];
  return {
    calls,
    diagnose(options = {}) {
      const next = reports[Math.min(calls.length, reports.length - 1)];
      calls.push(options);
      return Promise.resolve(next);
    },
  };
}

/** A probe that answers `readProperty` and nothing else — the recipe's whole diet. */
function stubProbe(read) {
  return {
    readProperty: () => Promise.resolve(read),
    readTable: () => assert.fail("the recipe must not read tables"),
    reachApi: () => assert.fail("the recipe must not reach an API"),
  };
}

/** A well-formed sys_id (32 lowercase hex) — `apply()` refuses anything else. */
const ROW_1 = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01";

const FOUND_FALSE = {
  outcome: "found",
  value: "false",
  sysId: ROW_1,
  detail: `${ATF_RUNNER_ENABLED_PROPERTY}=false`,
};

function recordingWriter(onWrite) {
  const writes = [];
  return {
    writes,
    async updateRecord(table, sysId, fields) {
      writes.push({ table, sysId, fields });
      if (onWrite) await onWrite(writes.length);
      return { table, sysId, record: { sys_id: sysId, ...fields } };
    },
  };
}

function ctx(signal) {
  return { runId: "run-1", signal: signal ?? new AbortController().signal };
}

/** The default catalogue's shape, expressed as stub findings. */
function runnerDisabledReport(hardFailure) {
  return report(
    "not-ready",
    [
      finding(PRECONDITION_IDS.atfRunnerEnabled, "not-ready", "required"),
      finding(PRECONDITION_IDS.cicdApi, "ready", "required"),
      finding(PRECONDITION_IDS.browserTestRunner, "unknown", "deferred"),
    ],
    hardFailure,
  );
}

describe("plan — from findings to bound writes", () => {
  it("binds the step to the row the probe answered with", async () => {
    const doctor = queuedDoctor(runnerDisabledReport());
    const writer = recordingWriter();
    const provisioner = createPreflightProvisioner({
      doctor,
      probe: stubProbe(FOUND_FALSE),
      writer,
    });

    const plan = await provisioner.plan(ctx());

    assert.equal(plan.steps.length, 1);
    assert.deepEqual(plan.steps[0].write, {
      kind: "update-record",
      table: SYS_PROPERTIES_TABLE,
      sysId: ROW_1,
      fields: { value: "true" },
    });
    assert.equal(plan.steps[0].precondition, PRECONDITION_IDS.atfRunnerEnabled);
    assert.equal(plan.steps[0].observed, FOUND_FALSE.detail);
    // The inspectable half mirrors the executable one — one plan, two views.
    assert.deepEqual(
      plan.actions,
      plan.steps.map((s) => s.action),
    );
    assert.match(plan.actions[0].description, new RegExp(ROW_1));
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.readiness, "not-ready");
    // ARCH-2: planning is read-only, whatever the mode.
    assert.deepEqual(writer.writes, []);
  });

  it("never writes while planning, even in apply mode", async () => {
    const writer = recordingWriter();
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport()),
      probe: stubProbe(FOUND_FALSE),
      writer,
      mode: "apply",
    });

    await provisioner.plan(ctx());
    assert.deepEqual(writer.writes, []);
  });

  it("skips ready findings and leaves deferred ones alone", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(
        report("ready", [
          finding(PRECONDITION_IDS.atfRunnerEnabled, "ready", "required"),
          // Not ready, but nobody asked for it: planning a write for a
          // precondition this phase cannot evaluate would be writing on a guess.
          finding(PRECONDITION_IDS.browserTestRunner, "unknown", "deferred"),
        ]),
      ),
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
    });

    const plan = await provisioner.plan(ctx());
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.readiness, "ready");
  });

  it("carries the doctor's hard failure onto the plan (DEV-2)", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport("ui cannot run")),
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
      kinds: ["ui"],
    });

    const plan = await provisioner.plan(ctx());
    // Applying every step will not make it go away, and the plan says so.
    assert.equal(plan.hardFailure, "ui cannot run");
    assert.equal(plan.steps.length, 1);
  });

  it("passes the requested kinds and the run's signal to the doctor", async () => {
    const doctor = queuedDoctor(runnerDisabledReport());
    const controller = new AbortController();
    const provisioner = createPreflightProvisioner({
      doctor,
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
      kinds: ["unit", "server"],
    });

    await provisioner.plan(ctx(controller.signal));
    assert.deepEqual(doctor.calls[0].kinds, ["unit", "server"]);
    assert.equal(doctor.calls[0].signal, controller.signal);
  });
});

describe("plan — what cannot be planned becomes a blocker", () => {
  it("refuses to create a sys_properties row it cannot see", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport()),
      probe: stubProbe({
        outcome: "absent",
        detail: `${ATF_RUNNER_ENABLED_PROPERTY} not found`,
      }),
      writer: recordingWriter(),
    });

    const plan = await provisioner.plan(ctx());
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.blockers.length, 1);
    // Both readings of an absent row, because the Table API renders them
    // identically and a create would be a blind write under one of them.
    assert.match(plan.blockers[0].why, /genuinely unset or ACL-trimmed/);
    assert.match(plan.blockers[0].why, /blind write/);
    assert.equal(
      plan.blockers[0].precondition,
      PRECONDITION_IDS.atfRunnerEnabled,
    );
    assert.equal(plan.blockers[0].status, "not-ready");
  });

  it("blocks on an undecidable read rather than writing on a guess", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport()),
      probe: stubProbe({ outcome: "undecidable", detail: "HTTP 500" }),
      writer: recordingWriter(),
    });

    const plan = await provisioner.plan(ctx());
    assert.deepEqual(plan.steps, []);
    assert.match(plan.blockers[0].why, /could not read: HTTP 500/);
  });

  // ── duplicate sys_properties rows ─────────────────────────────────────────
  const ROW_2 = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f02";

  it("blocks on differing duplicate runner rows and names them", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport()),
      probe: stubProbe({
        outcome: "undecidable",
        duplicates: "differing",
        rows: [
          { sysId: ROW_1, value: "true" },
          { sysId: ROW_2, value: "false" },
        ],
        detail: `${ATF_RUNNER_ENABLED_PROPERTY} has 2 rows with differing values`,
      }),
      writer: recordingWriter(),
    });

    const plan = await provisioner.plan(ctx());
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.blockers.length, 1);
    assert.match(plan.blockers[0].why, /duplicate/);
    assert.ok(plan.blockers[0].why.includes(ROW_1));
    assert.ok(plan.blockers[0].why.includes(ROW_2));
  });

  it("blocks on identical duplicate runner rows: one write would split them", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport()),
      probe: stubProbe({
        ...FOUND_FALSE,
        duplicates: "identical",
        rows: [
          { sysId: ROW_1, value: "false" },
          { sysId: ROW_2, value: "false" },
        ],
      }),
      writer: recordingWriter(),
    });

    const plan = await provisioner.plan(ctx());
    assert.deepEqual(plan.steps, []);
    assert.match(plan.blockers[0].why, /duplicate/);
    assert.ok(plan.blockers[0].why.includes(ROW_2));
  });

  it("blocks a finding no recipe covers, and says whether a remedy was even claimed", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(
        report("not-ready", [
          finding(PRECONDITION_IDS.cicdApi, "not-ready", "required"),
          finding(PRECONDITION_IDS.atfTables, "not-ready", "required", {
            remedy: {
              action: {
                kind: "update",
                table: "sys_user_role",
                description: "grant the role",
              },
            },
          }),
        ]),
      ),
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
    });

    const plan = await provisioner.plan(ctx());
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.blockers.length, 2);
    assert.match(plan.blockers[0].why, /outside the Table API/);
    // A remedy is a description. Turning one into a write without a recipe is
    // the blind ensure ARCH-2 rules out.
    assert.match(plan.blockers[1].why, /no recipe for/);
  });

  it("keeps the steps it can plan alongside the blockers it cannot", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(
        report("not-ready", [
          finding(PRECONDITION_IDS.atfRunnerEnabled, "not-ready", "required"),
          finding(PRECONDITION_IDS.cicdApi, "not-ready", "required"),
        ]),
      ),
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
    });

    const plan = await provisioner.plan(ctx());
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.blockers.length, 1);
  });
});

describe("plan hash — the §6b identity of the write set", () => {
  it("carries the digest of the steps it just planned", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport()),
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
    });

    const plan = await provisioner.plan(ctx());

    assert.equal(plan.steps.length, 1);
    // Recomputed from the plan that came back, so this pins WHICH value was
    // hashed. A shape assertion alone would pass for the digest of anything.
    assert.equal(plan.planHash, computePlanHash({ steps: plan.steps }));
    assert.match(plan.planHash, /^[0-9a-f]{64}$/);
  });

  it("gives a plan with nothing to do a real digest, not an empty string", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(
        report("ready", [
          finding(PRECONDITION_IDS.atfRunnerEnabled, "ready", "required"),
        ]),
      ),
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
    });

    const plan = await provisioner.plan(ctx());

    // "nothing to do" is a legal plan — applying it is a no-op — and it has an
    // identity like any other. An empty string here would collapse every
    // step-less plan onto one value that also reads as "no hash".
    assert.deepEqual(plan.steps, []);
    assert.notEqual(plan.planHash, "");
    assert.equal(plan.planHash, computePlanHash({ steps: [] }));
  });

  it("is indifferent to the blockers and hard failure reported beside the steps", async () => {
    function provisionerFor(doctor) {
      return createPreflightProvisioner({
        doctor,
        probe: stubProbe(FOUND_FALSE),
        writer: recordingWriter(),
      });
    }

    const stepOnly = provisionerFor(
      queuedDoctor(
        report("not-ready", [
          finding(PRECONDITION_IDS.atfRunnerEnabled, "not-ready", "required"),
        ]),
      ),
    );
    const alsoBlocked = provisionerFor(
      queuedDoctor(
        report(
          "not-ready",
          [
            finding(PRECONDITION_IDS.atfRunnerEnabled, "not-ready", "required"),
            finding(PRECONDITION_IDS.cicdApi, "not-ready", "required"),
          ],
          "ui cannot run",
        ),
      ),
    );

    const plain = await stepOnly.plan(ctx());
    const blocked = await alsoBlocked.plan(ctx());

    assert.deepEqual(plain.blockers, []);
    assert.equal(blocked.blockers.length, 1);
    assert.equal(blocked.hardFailure, "ui cannot run");
    assert.deepEqual(plain.steps, blocked.steps);
    // Both plans PATCH the same row with the same fields, so both are the same
    // apply and share an identity. `computePlanHash` excludes blockers and
    // readiness on purpose (its header says why); the consequence — two
    // materially different dry-runs can share a hash — is pinned here rather
    // than left to be discovered by an operator.
    assert.equal(plain.planHash, blocked.planHash);
  });
});

describe("apply — what it refuses", () => {
  it("refuses outright in the default mode", async () => {
    const writer = recordingWriter();
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport()),
      probe: stubProbe(FOUND_FALSE),
      writer,
    });

    assert.equal(provisioner.mode, "plan");
    const plan = await provisioner.plan(ctx());
    await assert.rejects(
      provisioner.apply(ctx(), plan),
      (error) =>
        error instanceof ProvisionRefusedError &&
        /mode "plan"/.test(error.message) &&
        /--mode apply/.test(error.message),
    );
    assert.deepEqual(writer.writes, []);
  });

  it("refuses a plan that is only a description of writes", async () => {
    const writer = recordingWriter();
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport()),
      probe: stubProbe(FOUND_FALSE),
      writer,
      mode: "apply",
    });

    // A `ProvisionPlan` off the wire: inspectable, unexecutable.
    await assert.rejects(
      provisioner.apply(ctx(), {
        actions: [
          { kind: "update", table: "sys_properties", description: "flip it" },
        ],
      }),
      (error) =>
        error instanceof ProvisionRefusedError &&
        /no executable steps/.test(error.message),
    );
    assert.deepEqual(writer.writes, []);
  });

  it("refuses a context that was already aborted", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport()),
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
      mode: "apply",
    });
    const plan = await provisioner.plan(ctx());

    await assert.rejects(
      provisioner.apply(ctx(AbortSignal.abort()), plan),
      (error) =>
        error instanceof ProvisionRefusedError &&
        /aborted before the first write/.test(error.message),
    );
  });

  describe("a plan it did not produce (tampered or hand-built)", () => {
    /** A real plan, then a mutated copy — the mutation is the only variable. */
    async function tamper(mutate, { rehash = true } = {}) {
      const writer = recordingWriter();
      const doctor = queuedDoctor(runnerDisabledReport());
      const provisioner = createPreflightProvisioner({
        doctor,
        probe: stubProbe(FOUND_FALSE),
        writer,
        mode: "apply",
      });
      const genuine = await provisioner.plan(ctx());
      const steps = genuine.steps.map((step) => structuredClone(step));
      const plan = { ...genuine, steps: mutate(steps) ?? steps };
      if (rehash) plan.planHash = computePlanHash({ steps: plan.steps });
      return { writer, doctor, provisioner, plan };
    }

    async function assertRefusedBeforeAnyWrite(h, pattern) {
      await assert.rejects(
        h.provisioner.apply(ctx(), h.plan),
        (error) =>
          error instanceof ProvisionRefusedError &&
          pattern.test(error.message) &&
          /nothing was written/.test(error.message),
      );
      assert.deepEqual(h.writer.writes, []);
      // Refused at the gate: no re-diagnosis was needed to catch it.
      assert.equal(h.doctor.calls.length, 1);
    }

    it("refuses the review repro: unknown precondition, foreign table, fake hash", async () => {
      const writer = recordingWriter();
      const provisioner = createPreflightProvisioner({
        doctor: queuedDoctor(report("ready", [])),
        probe: {},
        writer,
        mode: "apply",
      });
      await assert.rejects(
        provisioner.apply(ctx(), {
          actions: [
            { kind: "update", table: "sys_user", description: "enable" },
          ],
          steps: [
            {
              precondition: "not-a-recipe",
              action: {
                kind: "update",
                table: "sys_properties",
                description: "set sn_atf.runner.enabled",
              },
              write: {
                table: "sys_user_has_role",
                sysId: "6816f79cc0a8016401c5a33be04be441",
                fields: { role: "admin" },
              },
            },
          ],
          planHash: "0000-not-the-real-hash",
        }),
        ProvisionRefusedError,
      );
      assert.deepEqual(writer.writes, []);
    });

    it("refuses a plan with no hash", async () => {
      const h = await tamper(() => undefined, { rehash: false });
      delete h.plan.planHash;
      await assertRefusedBeforeAnyWrite(h, /carries no plan hash/);
    });

    it("refuses a plan whose hash does not match its steps", async () => {
      const h = await tamper(
        (steps) => {
          steps[0].write.sysId = "f".repeat(32);
        },
        { rehash: false },
      );
      await assertRefusedBeforeAnyWrite(h, /hash does not match/);
    });

    it("refuses a step whose precondition no recipe remedies, even re-hashed", async () => {
      const h = await tamper((steps) => {
        steps[0].precondition = "not-a-recipe";
      });
      await assertRefusedBeforeAnyWrite(h, /no recipe remedies/);
    });

    it("does not let a prototype key pose as a recipe", async () => {
      const h = await tamper((steps) => {
        steps[0].precondition = "constructor";
      });
      await assertRefusedBeforeAnyWrite(h, /no recipe remedies/);
    });

    it("refuses a table outside the recipe's allowlist, even re-hashed", async () => {
      const h = await tamper((steps) => {
        steps[0].write.table = "sys_user_has_role";
        steps[0].action.table = "sys_user_has_role";
      });
      await assertRefusedBeforeAnyWrite(
        h,
        /"sys_user_has_role".+does not allow/,
      );
    });

    it("refuses fields the recipe would not produce, even re-hashed", async () => {
      const extra = await tamper((steps) => {
        steps[0].write.fields = { value: "true", name: "glide.security.x" };
      });
      await assertRefusedBeforeAnyWrite(extra, /does not produce/);
      const changed = await tamper((steps) => {
        steps[0].write.fields = { value: "false" };
      });
      await assertRefusedBeforeAnyWrite(changed, /does not produce/);
    });

    it("refuses an action that describes a different table than it writes", async () => {
      const h = await tamper((steps) => {
        steps[0].action.table = "sys_user";
      });
      await assertRefusedBeforeAnyWrite(h, /action does not describe/);
    });

    it("refuses a step whose recipe declares no writes", async () => {
      const writer = recordingWriter();
      const provisioner = createPreflightProvisioner({
        doctor: queuedDoctor(runnerDisabledReport()),
        probe: stubProbe(FOUND_FALSE),
        writer,
        mode: "apply",
        // A bare function: can plan, can never be applied (fail closed).
        recipes: {
          [PRECONDITION_IDS.atfRunnerEnabled]: (probe, signal) =>
            enableAtfRunnerRecipe(probe, signal),
        },
      });
      const plan = await provisioner.plan(ctx());
      assert.equal(plan.steps.length, 1);
      await assert.rejects(
        provisioner.apply(ctx(), plan),
        (error) =>
          error instanceof ProvisionRefusedError &&
          /declares no writes/.test(error.message),
      );
      assert.deepEqual(writer.writes, []);
    });

    it("refuses a plan that writes the same row twice, even re-hashed", async () => {
      const h = await tamper((steps) => [steps[0], structuredClone(steps[0])]);
      await assertRefusedBeforeAnyWrite(h, /more than once/);
    });

    it("refuses a sys_id that is not 32 lowercase hex, even re-hashed", async () => {
      for (const sysId of ["row-1", "A".repeat(32), "a".repeat(31), " "]) {
        const h = await tamper((steps) => {
          steps[0].write.sysId = sysId;
        });
        await assertRefusedBeforeAnyWrite(h, /sys_id/);
      }
    });

    it("writes only what it validated: a getter cannot swap the table after the gate", async () => {
      // The review repro. `write.table` reads as the allowed table for the gate
      // and the hash, then as a role table at write time. The plan is
      // snapshotted ONCE, before validation, and everything after reads the
      // snapshot — so the accessor is consulted exactly once.
      const h = await tamper(() => undefined);
      const step = h.plan.steps[0];
      let reads = 0;
      Object.defineProperty(step.write, "table", {
        enumerable: true,
        get: () => (++reads <= 2 ? SYS_PROPERTIES_TABLE : "sys_user_has_role"),
      });
      h.plan.planHash = computePlanHash({ steps: h.plan.steps });
      reads = 0;
      await assert.rejects(
        h.provisioner.apply(ctx(), h.plan),
        ProvisionVerificationError,
      );
      assert.deepEqual(
        h.writer.writes.map((w) => w.table),
        [SYS_PROPERTIES_TABLE],
      );
      assert.equal(reads, 1, "the plan was read more than once");
    });

    it("still applies the untampered plan", async () => {
      const h = await tamper(() => undefined);
      await assert.rejects(
        h.provisioner.apply(ctx(), h.plan),
        ProvisionVerificationError,
      );
      assert.equal(h.writer.writes.length, 1);
    });
  });

  it("treats an empty plan as a no-op and does not re-diagnose", async () => {
    const doctor = queuedDoctor(
      report("ready", [
        finding(PRECONDITION_IDS.atfRunnerEnabled, "ready", "required"),
      ]),
    );
    const writer = recordingWriter();
    const provisioner = createPreflightProvisioner({
      doctor,
      probe: stubProbe(FOUND_FALSE),
      writer,
      mode: "apply",
    });

    const plan = await provisioner.plan(ctx());
    await provisioner.apply(ctx(), plan);

    // "Nothing to do" is a valid plan; verifying nothing would be a wasted round
    // trip and a second chance to fail for an unrelated reason.
    assert.deepEqual(writer.writes, []);
    assert.equal(doctor.calls.length, 1);
  });
});

describe("apply — writing and believing", () => {
  it("writes the plan and confirms it with a fresh diagnosis", async () => {
    const doctor = queuedDoctor(
      runnerDisabledReport(),
      report("ready", [
        finding(PRECONDITION_IDS.atfRunnerEnabled, "ready", "required"),
      ]),
    );
    const writer = recordingWriter();
    const provisioner = createPreflightProvisioner({
      doctor,
      probe: stubProbe(FOUND_FALSE),
      writer,
      mode: "apply",
    });

    const plan = await provisioner.plan(ctx());
    await provisioner.apply(ctx(), plan);

    assert.deepEqual(writer.writes, [
      {
        table: SYS_PROPERTIES_TABLE,
        sysId: ROW_1,
        fields: { value: "true" },
      },
    ]);
    assert.equal(doctor.calls.length, 2);
  });

  it("throws when the write succeeded and the instance still says no", async () => {
    const doctor = queuedDoctor(
      runnerDisabledReport(),
      report("not-ready", [
        finding(PRECONDITION_IDS.atfRunnerEnabled, "not-ready", "required"),
      ]),
    );
    const provisioner = createPreflightProvisioner({
      doctor,
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
      mode: "apply",
    });

    const plan = await provisioner.plan(ctx());
    // A 200 on a PATCH is the transport's opinion about a request; only the
    // re-diagnosis is the instance's opinion about itself.
    await assert.rejects(
      provisioner.apply(ctx(), plan),
      (error) =>
        error instanceof ProvisionVerificationError &&
        /the instance disagrees/.test(error.message) &&
        new RegExp(PRECONDITION_IDS.atfRunnerEnabled).test(error.message),
    );
  });

  it("refuses to believe a write the re-diagnosis never mentioned", async () => {
    // The verification used to filter `after.findings` for a remedied
    // precondition that came back not-ready. A precondition the second
    // diagnosis does not report on at all is absent from that list, so the
    // filter came back empty and `apply()` resolved — an unverified write
    // reported as verified. `EnvironmentDoctor` is an injected interface and
    // `isExecutable()` is purely structural, so a plan whose preconditions
    // this doctor's catalogue does not cover reaches `apply()` unimpeded.
    // DEV-1: absence of evidence is not a pass.
    const doctor = queuedDoctor(
      runnerDisabledReport(),
      report("ready", [finding(PRECONDITION_IDS.cicdApi, "ready", "required")]),
    );
    const provisioner = createPreflightProvisioner({
      doctor,
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
      mode: "apply",
    });

    const plan = await provisioner.plan(ctx());
    await assert.rejects(
      provisioner.apply(ctx(), plan),
      (error) =>
        error instanceof ProvisionVerificationError &&
        /was not re-diagnosed at all/.test(error.message) &&
        // Not "the instance disagrees": nothing disagreed, nobody answered.
        /unconfirmed rather than refuted/.test(error.message) &&
        new RegExp(PRECONDITION_IDS.atfRunnerEnabled).test(error.message),
    );
  });

  it("hedges instead of blaming the instance when the re-read came back unknown", async () => {
    // `unknown` is not a contradiction. An operator told the instance
    // disagreed goes looking for what overwrote their change; on this path
    // there is nothing to find, because nothing was read back.
    const doctor = queuedDoctor(
      runnerDisabledReport(),
      report("unknown", [
        finding(PRECONDITION_IDS.atfRunnerEnabled, "unknown", "required"),
      ]),
    );
    const provisioner = createPreflightProvisioner({
      doctor,
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
      mode: "apply",
    });

    const plan = await provisioner.plan(ctx());
    await assert.rejects(
      provisioner.apply(ctx(), plan),
      (error) =>
        error instanceof ProvisionVerificationError &&
        /unconfirmed rather than refuted/.test(error.message) &&
        /came back unknown/.test(error.message) &&
        /the instance disagrees/.test(error.message) === false,
    );
  });

  it("verifies only what it remedied", async () => {
    const doctor = queuedDoctor(
      runnerDisabledReport(),
      report("not-ready", [
        finding(PRECONDITION_IDS.atfRunnerEnabled, "ready", "required"),
        // Reported at plan time as a blocker; still broken, still not this
        // apply's failure to claim.
        finding(PRECONDITION_IDS.cicdApi, "not-ready", "required"),
      ]),
    );
    const provisioner = createPreflightProvisioner({
      doctor,
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
      mode: "apply",
    });

    const plan = await provisioner.plan(ctx());
    await provisioner.apply(ctx(), plan);
  });
});

describe("apply — partial failure stays diagnosable", () => {
  /**
   * Two recipes, so a plan can fail halfway through. Each declares its write
   * scope, or `apply()` would refuse its steps before the first write.
   */
  const TWO_STEP_RECIPES = {
    [PRECONDITION_IDS.atfRunnerEnabled]: defineRecipe(
      { kind: "update-record", table: "t1", fields: { v: "1" } },
      () =>
        Promise.resolve({
          outcome: "step",
          step: {
            precondition: PRECONDITION_IDS.atfRunnerEnabled,
            action: { kind: "update", table: "t1", description: "first write" },
            write: {
              kind: "update-record",
              table: "t1",
              sysId: "a".repeat(32),
              fields: { v: "1" },
            },
            observed: "t1/a",
          },
        }),
    ),
    [PRECONDITION_IDS.cicdApi]: defineRecipe(
      { kind: "update-record", table: "t2", fields: { v: "2" } },
      () =>
        Promise.resolve({
          outcome: "step",
          step: {
            precondition: PRECONDITION_IDS.cicdApi,
            action: {
              kind: "update",
              table: "t2",
              description: "second write",
            },
            write: {
              kind: "update-record",
              table: "t2",
              sysId: "b".repeat(32),
              fields: { v: "2" },
            },
            observed: "t2/b",
          },
        }),
    ),
  };

  function twoStepProvisioner(writer) {
    return createPreflightProvisioner({
      doctor: queuedDoctor(
        report("not-ready", [
          finding(PRECONDITION_IDS.atfRunnerEnabled, "not-ready", "required"),
          finding(PRECONDITION_IDS.cicdApi, "not-ready", "required"),
        ]),
      ),
      probe: stubProbe(FOUND_FALSE),
      writer,
      mode: "apply",
      recipes: TWO_STEP_RECIPES,
    });
  }

  it("reports how far it got when a write fails", async () => {
    const boom = new Error("403 from the instance");
    const writer = recordingWriter((n) => {
      if (n === 2) throw boom;
    });
    const provisioner = twoStepProvisioner(writer);
    const plan = await provisioner.plan(ctx());
    assert.equal(plan.steps.length, 2);

    await assert.rejects(
      provisioner.apply(ctx(), plan),
      (error) =>
        error instanceof ProvisionApplyError &&
        error.applied === 1 &&
        error.total === 2 &&
        error.cause === boom &&
        /second write failed after 1 of 2/.test(error.message),
    );
  });

  it("stops mid-sequence when the run is cancelled", async () => {
    const controller = new AbortController();
    const writer = recordingWriter(() => controller.abort());
    const provisioner = twoStepProvisioner(writer);
    const plan = await provisioner.plan(ctx());

    await assert.rejects(
      provisioner.apply({ runId: "run-1", signal: controller.signal }, plan),
      (error) =>
        error instanceof ProvisionApplyError &&
        error.applied === 1 &&
        error.total === 2 &&
        /aborted after 1 of 2/.test(error.message),
    );
    assert.equal(writer.writes.length, 1);
  });
});

describe("isExecutable / formatProvisionPlan", () => {
  it("recognises an executable plan structurally, empty steps included", () => {
    assert.equal(isExecutable({ actions: [], steps: [] }), true);
    assert.equal(isExecutable({ actions: [] }), false);
    assert.equal(isExecutable({ actions: [], steps: "nope" }), false);
  });

  it("renders steps, blockers and the hard failure", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(
        report(
          "not-ready",
          [
            finding(PRECONDITION_IDS.atfRunnerEnabled, "not-ready", "required"),
            finding(PRECONDITION_IDS.cicdApi, "not-ready", "required"),
          ],
          "ui cannot run",
        ),
      ),
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
    });

    const text = formatProvisionPlan(await provisioner.plan(ctx()));
    assert.match(text, /^readiness: not-ready — 1 step\(s\), 1 blocker\(s\)$/m);
    assert.match(text, /\+ set sn_atf\.runner\.enabled to true/);
    assert.match(
      text,
      new RegExp(`write: update-record sys_properties/${ROW_1}`),
    );
    assert.match(text, /! \[not-ready\] sn_cicd\.api/);
    assert.match(text, /HARD FAILURE: ui cannot run/);
  });

  it("prints the plan's own hash on a line of its own", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(runnerDisabledReport()),
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
    });

    const plan = await provisioner.plan(ctx());
    const text = formatProvisionPlan(plan);

    // The digest an operator would copy out, and a qualifier after it. The
    // wording of the qualifier is not pinned — its presence is, because a bare
    // digest under the readiness roll-up reads as an identity of that roll-up.
    assert.match(
      text,
      new RegExp(`^plan hash: ${plan.planHash} \\(.+\\)$`, "m"),
    );
  });

  it("says so when there is nothing to do", async () => {
    const provisioner = createPreflightProvisioner({
      doctor: queuedDoctor(
        report("ready", [
          finding(PRECONDITION_IDS.atfRunnerEnabled, "ready", "required"),
        ]),
      ),
      probe: stubProbe(FOUND_FALSE),
      writer: recordingWriter(),
    });

    const text = formatProvisionPlan(await provisioner.plan(ctx()));
    assert.match(text, /nothing to do/);
  });
});

// ── live half — the real transport against the QA-18 fake ───────────────────

const HOST = "dev-provisioner.service-now.com";

const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH",
  "SN_DOCS_DIR",
  "SN_READONLY",
  "SN_ACTIVE_PROFILE",
  "SN_ALLOWED_HOSTS",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
  "SN_MAX_RETRIES",
];

function seed(atfRunnerEnabled, duplicateRunnerValue) {
  const state = {};
  for (const table of ATF_AUTHORING_TABLES) state[table] = [];
  state.sys_properties = [
    { name: ATF_RUNNER_ENABLED_PROPERTY, value: String(atfRunnerEnabled) },
    // ADR-007 C3 is promoted: a `unit` run also needs the W2 authoring
    // channel installed, which is an admin's job and never a remedy here.
    { name: AUTHORING_CHANNEL_VERSION_PROPERTY, value: "1.0.0" },
  ];
  // A second row for the runner property, appended AFTER the authoring row so
  // `property()` (row 0) still answers for the first runner row.
  if (duplicateRunnerValue !== undefined) {
    state.sys_properties.push({
      name: ATF_RUNNER_ENABLED_PROPERTY,
      value: duplicateRunnerValue,
    });
  }
  return state;
}

/** Wire the real transport at the fake; hand back the pieces and a restorer. */
function withFake({
  atfRunnerEnabled = false,
  duplicateRunnerValue,
  mode = "apply",
  // The fake mints sys_ids from (seed, table, ordinal), so two instances seeded
  // differently hand the recipe a different row to bind to — which is the only
  // way this suite can vary a PRODUCED plan without hand-writing the id the
  // probe is supposed to discover.
  idSeed = "tessera",
} = {}) {
  const fake = createFakeInstance({
    host: HOST,
    seed: idSeed,
    state: seed(atfRunnerEnabled, duplicateRunnerValue),
  });
  const restoreFetch = fake.install();

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-provision-"));
  process.env.SN_INSTANCE = HOST;
  process.env.SN_USER = "tessera";
  process.env.SN_PASSWORD = "tessera";
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = docsDir;
  // One shot per request: a retried PATCH would let a single-fire fault be
  // papered over, and the test would assert the retry rather than the failure.
  process.env.SN_MAX_RETRIES = "0";
  // DEV-24: writes are gated at the transport. This suite is the one that must
  // be allowed through it.
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  delete process.env.SN_TABLES_ALLOW;
  delete process.env.SN_TABLES_DENY;
  reloadCredentialsFromEnv();

  const probe = createSnInstanceProbe();
  return {
    fake,
    docsDir,
    provisioner: createPreflightProvisioner({
      doctor: createEnvironmentDoctor(createDefaultPreconditions(probe)),
      probe,
      writer: createSnInstanceWriter(),
      mode,
      kinds: ["unit"],
    }),
    /** The one seeded property row, as the fake currently holds it. */
    property() {
      return fake.tables.all(SYS_PROPERTIES_TABLE)[0];
    },
    restore() {
      restoreFetch();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
      fs.rmSync(docsDir, { recursive: true, force: true });
    },
  };
}

function methods(fake) {
  return [...new Set(fake.requests().map((r) => r.method))];
}

/** DEV-15 — the journal the single mutation channel writes for each mutation. */
function journalEntries(docsDir, profile = "default") {
  const file = path.join(docsDir, profile, "write-journal.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("live — duplicate runner rows", () => {
  for (const [first, second] of [
    [true, "false"],
    [false, "true"],
  ]) {
    it(`never plans a write over differing rows ${first}/${second}`, async () => {
      const h = withFake({
        atfRunnerEnabled: first,
        duplicateRunnerValue: second,
        mode: "plan",
      });
      try {
        const plan = await h.provisioner.plan(ctx());
        assert.equal(plan.readiness, "not-ready");
        assert.deepEqual(plan.steps, []);
        const blocker = plan.blockers.find(
          (b) => b.precondition === PRECONDITION_IDS.atfRunnerEnabled,
        );
        assert.ok(blocker, "the runner finding is a blocker");
        assert.match(blocker.why, /duplicate/);
        assert.deepEqual(methods(h.fake), ["GET"]);
      } finally {
        h.restore();
      }
    });
  }
});

describe("live — the real doctor, probe and mutation channel", () => {
  it("plans against the minted row and never puts a write on the wire", async () => {
    const h = withFake({ mode: "plan" });
    try {
      const plan = await h.provisioner.plan(ctx());

      assert.equal(plan.steps.length, 1);
      assert.deepEqual(plan.blockers, []);
      assert.equal(plan.readiness, "not-ready");
      // Bound to the row the probe actually saw, not to the property name.
      assert.equal(plan.steps[0].write.sysId, h.property().sys_id);
      assert.deepEqual(methods(h.fake), ["GET"]);
      assert.equal(h.property().value, "false");
    } finally {
      h.restore();
    }
  });

  it("applies the plan, journals the write and re-reads the instance", async () => {
    const h = withFake();
    try {
      const plan = await h.provisioner.plan(ctx());
      await h.provisioner.apply(ctx(), plan);

      assert.equal(h.property().value, "true");
      const patches = h.fake
        .requests()
        .filter((request) => request.method === "PATCH");
      assert.equal(patches.length, 1);
      assert.match(patches[0].path, new RegExp(`${SYS_PROPERTIES_TABLE}/`));

      // ARCH-3: the write went through the single mutation channel, so it is in
      // the journal. A write that is not journalled is a second channel.
      const entries = journalEntries(h.docsDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, "update");
      assert.equal(entries[0].table, SYS_PROPERTIES_TABLE);
      assert.deepEqual(entries[0].fields, { value: "true" });

      // And the verification round trip really happened: the doctor read the
      // property again after the PATCH.
      const reads = h.fake
        .requests()
        .filter((request) => request.method === "GET");
      assert.ok(
        reads.filter((r) => r.path.includes(SYS_PROPERTIES_TABLE)).length >= 2,
      );
    } finally {
      h.restore();
    }
  });

  it("refuses to apply in the default mode, so nothing reaches the instance", async () => {
    const h = withFake({ mode: "plan" });
    try {
      const plan = await h.provisioner.plan(ctx());
      await assert.rejects(
        h.provisioner.apply(ctx(), plan),
        ProvisionRefusedError,
      );
      assert.deepEqual(methods(h.fake), ["GET"]);
      assert.equal(h.property().value, "false");
    } finally {
      h.restore();
    }
  });

  it("surfaces a refused write as an apply failure, not a silent green", async () => {
    const h = withFake();
    try {
      const plan = await h.provisioner.plan(ctx());
      h.fake.faults.add({
        match: { method: "PATCH", table: SYS_PROPERTIES_TABLE },
        mode: { kind: "http-error", status: 403, message: "no write access" },
      });

      await assert.rejects(
        h.provisioner.apply(ctx(), plan),
        (error) =>
          error instanceof ProvisionApplyError &&
          error.applied === 0 &&
          error.total === 1,
      );
      assert.equal(h.property().value, "false");
    } finally {
      h.restore();
    }
  });

  it("is a no-op when the instance is already ready", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      const plan = await h.provisioner.plan(ctx());
      assert.deepEqual(plan.steps, []);
      assert.equal(plan.readiness, "ready");

      await h.provisioner.apply(ctx(), plan);
      assert.deepEqual(methods(h.fake), ["GET"]);
      assert.deepEqual(journalEntries(h.docsDir), []);
    } finally {
      h.restore();
    }
  });
});

// ── live half — the hash over a plan the provisioner actually produced ──────
//
// The unit half above hashes a plan assembled from stubs. These drive the real
// doctor, the real probe and the real recipe against the QA-18 fake, so the
// digest is taken over a plan that was planned rather than written down.
//
// What can be varied here is narrow, and saying so is part of the evidence:
// `DEFAULT_RECIPES` holds exactly one recipe (`enableAtfRunnerRecipe`), so
// every plan this phase can produce is either empty or a single `update-record`
// on `sys_properties`. A different row and no row at all are therefore the
// whole space of produced plans, not a sample of it.

describe("live — the plan hash over a produced plan", () => {
  /** Plan once against a fresh fake, and report the row the fake holds. */
  async function planOnce(options) {
    const h = withFake({ mode: "plan", ...options });
    try {
      return {
        plan: await h.provisioner.plan(ctx()),
        sysId: h.property().sys_id,
      };
    } finally {
      h.restore();
    }
  }

  it("hashes two identical planning runs the same", async () => {
    const h = withFake({ mode: "plan" });
    try {
      const first = await h.provisioner.plan(ctx());
      const second = await h.provisioner.plan(ctx());

      assert.equal(first.steps.length, 1);
      assert.deepEqual(first.steps, second.steps);
      assert.match(first.planHash, /^[0-9a-f]{64}$/);
      assert.equal(first.planHash, second.planHash);
    } finally {
      h.restore();
    }
  });

  it("moves when the planned write binds to a different row", async () => {
    const a = await planOnce({ idSeed: "row-a" });
    const b = await planOnce({ idSeed: "row-b" });

    // Same table, same fields, same precondition: the sys_id the probe
    // discovered is the only thing that differs, and it is the address the
    // PATCH lands on — so these are two different applies.
    assert.notEqual(a.sysId, b.sysId);
    assert.equal(a.plan.steps[0].write.sysId, a.sysId);
    assert.equal(b.plan.steps[0].write.sysId, b.sysId);
    assert.equal(a.plan.steps[0].write.table, b.plan.steps[0].write.table);
    assert.deepEqual(
      a.plan.steps[0].write.fields,
      b.plan.steps[0].write.fields,
    );
    assert.notEqual(a.plan.planHash, b.plan.planHash);
  });

  it("separates a plan with a write from a plan with nothing to do", async () => {
    const pending = await planOnce({});
    const ready = await planOnce({ atfRunnerEnabled: true });

    assert.equal(pending.plan.steps.length, 1);
    assert.deepEqual(ready.plan.steps, []);
    assert.notEqual(pending.plan.planHash, ready.plan.planHash);
  });
});
