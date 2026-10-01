// The Phase-0.5 Provisioner — the ARCH-33 "verified, never created" half.
//
// THE PROPERTY UNDER TEST, in the module's own words: "`sn_atf.runner.enabled`
// must already be true on the runner instance (DR-3) — ATF silently refuses to
// execute otherwise, and the run would come back green-looking with no result
// rows", and, at the read site, "Fail closed: an unreadable property is NOT an
// enabled runner."
//
// An EMPTY plan is this port's way of saying "standing infrastructure checks
// out", and core proceeds on it. That is a claim the caller cannot audit, so
// every way of producing an empty plan without evidence is tested here: a
// refused read, a transport failure, an absent row, an uninterpretable value.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  ATF_RUNNER_ENABLED_PROPERTY,
  SYS_PROPERTIES_TABLE,
} from "../build/atf.js";
import {
  SkeletonInfrastructureError,
  SkeletonUnsupportedActionError,
} from "../build/errors.js";
import { createS5Provisioner } from "../build/provisioner.js";
import { context, harness } from "./support.js";

const opened = [];
after(() => {
  for (const h of opened) h.restore();
});

function open(options) {
  const h = harness(options);
  opened.push(h);
  return h;
}

/** Seed state whose only content is the DR-3 property, set to `value`. */
function runnerProperty(value) {
  return {
    [SYS_PROPERTIES_TABLE]:
      value === undefined ? [] : [{ name: ATF_RUNNER_ENABLED_PROPERTY, value }],
  };
}

describe("createS5Provisioner().plan", () => {
  it("plans nothing when the runner is verifiably enabled", async () => {
    const h = open({ state: runnerProperty("true") });
    try {
      const plan = await createS5Provisioner().plan(context(), []);
      assert.deepEqual(plan.actions, []);
    } finally {
      h.restore();
    }
  });

  it("reports a disabled runner as a standing-infra action naming DR-3", async () => {
    const h = open({ state: runnerProperty("false") });
    try {
      const plan = await createS5Provisioner().plan(context(), []);
      assert.equal(plan.actions.length, 1);
      const [action] = plan.actions;
      assert.equal(action.kind, "update");
      assert.equal(action.table, SYS_PROPERTIES_TABLE);
      assert.match(action.description, /sn_atf\.runner\.enabled/);
      assert.match(action.description, /DR-3/);
    } finally {
      h.restore();
    }
  });

  it("treats an ABSENT property as not-enabled, not as verified", async () => {
    // The row's absence is not evidence that ATF will run. An empty plan here
    // would let core start a run that produces no result rows at all and looks
    // like a clean pass to everything downstream.
    const h = open({ state: runnerProperty(undefined) });
    try {
      const plan = await createS5Provisioner().plan(context(), []);
      assert.equal(plan.actions.length, 1);
    } finally {
      h.restore();
    }
  });

  it("treats an uninterpretable value as not-enabled", async () => {
    const h = open({ state: runnerProperty("maybe") });
    try {
      const plan = await createS5Provisioner().plan(context(), []);
      assert.equal(plan.actions.length, 1);
    } finally {
      h.restore();
    }
  });

  it("accepts the documented truthy spellings, and only those", async () => {
    // Delegated decision 2026-09-25: only trimmed lowercase "true" — the guard
    // probe's vocabulary. "1"/"yes" read as unknown there, so they must not
    // read as enabled here.
    for (const value of ["true", "TRUE", " true "]) {
      const h = open({ state: runnerProperty(value) });
      try {
        const plan = await createS5Provisioner().plan(context(), []);
        assert.deepEqual(plan.actions, [], `"${value}" should read as enabled`);
      } finally {
        h.restore();
      }
    }
    for (const value of ["", "0", "no", "false", "enabled", "1", "yes"]) {
      const h = open({ state: runnerProperty(value) });
      try {
        const plan = await createS5Provisioner().plan(context(), []);
        assert.equal(
          plan.actions.length,
          1,
          `"${value}" must not read as enabled`,
        );
      } finally {
        h.restore();
      }
    }
  });

  it("differing duplicate rows are not an enabled runner, in either order (2026-09-26)", async () => {
    // The guard probe (`probe.ts`) reads differing duplicates as unknown. This
    // port used to read only the FIRST row (`limit: 1`), so `true` then
    // `false` planned nothing while the probe could not say the runner was on.
    for (const order of [
      ["true", "false"],
      ["false", "true"],
      ["true", "maybe"],
    ]) {
      const h = open({
        state: {
          [SYS_PROPERTIES_TABLE]: order.map((value) => ({
            name: ATF_RUNNER_ENABLED_PROPERTY,
            value,
          })),
        },
      });
      try {
        const plan = await createS5Provisioner().plan(context(), []);
        assert.equal(plan.actions.length, 1, order.join(","));
      } finally {
        h.restore();
      }
    }
  });

  it("agreeing duplicate rows still read as enabled (2026-09-26)", async () => {
    const h = open({
      state: {
        [SYS_PROPERTIES_TABLE]: [
          { name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" },
          { name: ATF_RUNNER_ENABLED_PROPERTY, value: " TRUE" },
        ],
      },
    });
    try {
      const plan = await createS5Provisioner().plan(context(), []);
      assert.deepEqual(plan.actions, []);
    } finally {
      h.restore();
    }
  });

  it("a REFUSED read faults — it never yields an empty (clean) plan", async () => {
    // Seeded enabled, so the truthful reading would be "fine". The point is
    // that the provisioner must not report ANY verdict it could not read,
    // including the true one.
    const h = open({ state: runnerProperty("true") });
    h.fake.faults.add({
      match: { method: "GET", table: SYS_PROPERTIES_TABLE },
      mode: { kind: "http-error", status: 403, message: "no read access" },
    });
    try {
      await assert.rejects(
        () => createS5Provisioner().plan(context(), []),
        (error) => {
          assert.ok(error instanceof SkeletonInfrastructureError);
          assert.match(error.message, /could not read sn_atf\.runner\.enabled/);
          return true;
        },
      );
    } finally {
      h.restore();
    }
  });

  it("keeps the underlying failure as the cause rather than erasing it", async () => {
    const h = open({ state: runnerProperty("true") });
    h.fake.faults.add({
      match: { method: "GET", table: SYS_PROPERTIES_TABLE },
      mode: { kind: "http-error", status: 500, message: "boom" },
    });
    try {
      await assert.rejects(
        () => createS5Provisioner().plan(context(), []),
        (error) => {
          assert.notEqual(
            error.cause,
            undefined,
            "the read failure must survive the rewrap",
          );
          return true;
        },
      );
    } finally {
      h.restore();
    }
  });

  it("a transport failure faults rather than passing the check", async () => {
    const h = open({ state: runnerProperty("true") });
    h.fake.faults.add({
      match: { method: "GET", table: SYS_PROPERTIES_TABLE },
      mode: { kind: "transport-error", message: "socket hang up" },
    });
    try {
      await assert.rejects(
        () => createS5Provisioner().plan(context(), []),
        SkeletonInfrastructureError,
      );
    } finally {
      h.restore();
    }
  });

  it("skipRunnerPropertyCheck returns an empty plan WITHOUT reading", async () => {
    // The opt-out is honest only if it does not pretend to have checked. If it
    // read and ignored the answer, a caller could not tell the two apart.
    const h = open({ state: runnerProperty("false") });
    try {
      const plan = await createS5Provisioner({
        skipRunnerPropertyCheck: true,
      }).plan(context(), []);
      assert.deepEqual(plan.actions, []);
      assert.deepEqual(h.fake.requests(), []);
    } finally {
      h.restore();
    }
  });

  it("only `true` opts out — a truthy-looking value still checks", async () => {
    const h = open({ state: runnerProperty("false") });
    try {
      const plan = await createS5Provisioner({
        skipRunnerPropertyCheck: 1,
      }).plan(context(), []);
      assert.equal(plan.actions.length, 1);
    } finally {
      h.restore();
    }
  });
});

describe("createS5Provisioner().apply", () => {
  it("refuses every plan, including an empty one", async () => {
    const h = open();
    try {
      const provisioner = createS5Provisioner();
      await assert.rejects(
        () => provisioner.apply(context(), { actions: [] }),
        SkeletonUnsupportedActionError,
      );
      await assert.rejects(
        () =>
          provisioner.apply(context(), {
            actions: [{ kind: "update", table: "x", description: "y" }],
          }),
        (error) => {
          assert.ok(error instanceof SkeletonUnsupportedActionError);
          assert.match(error.message, /never applies anything/);
          assert.match(error.message, /ARCH-33/);
          return true;
        },
      );
      // A refusal that quietly wrote something would be worse than a no-op.
      assert.deepEqual(h.fake.requests(), []);
    } finally {
      h.restore();
    }
  });

  it("names the run whose apply was refused", async () => {
    const h = open();
    try {
      await assert.rejects(
        () =>
          createS5Provisioner().apply(context({ runId: "run-xyz" }), {
            actions: [],
          }),
        /run run-xyz/,
      );
    } finally {
      h.restore();
    }
  });
});
