// The Phase-0.5 TestStore — projection and DEV-13/DEV-17 teardown.
//
// THE PROPERTIES UNDER TEST, in the module's own words:
//  * DEV-17 — "never delete under a non-terminal instance run. The store
//    re-probes `sys_atf_test_suite_result` itself and refuses rather than
//    trusting that core got there legitimately", and the probe is read "fail
//    closed: an unrecognised status counts as still running";
//  * ARCH-26 — "the run-id prefix on `sys_atf_test.name` is a contract, not
//    decoration" (core builds the orphan probe `nameSTARTSWITH<runId>` from it);
//  * DEV-13 — teardown "deletes in a pinned order";
//  * the default of `deleteSuiteResults` is FALSE because "those rows are the
//    run's evidence (QA-17/DEV-21), and a teardown that erases its own evidence
//    is not a teardown".
//
// `teardown()` resolving is the store's way of telling core "the namespace is
// clean". Nothing downstream re-checks it, so the tests below assert what was
// actually deleted, never merely that teardown did not throw.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { specKey } from "@tessera/core";

import { ATF_TABLES, SCRIPT_INCLUDE_TABLE } from "../build/atf.js";
import { SkeletonInfrastructureError } from "../build/errors.js";
import { S5_SPEC_ID, S5_TARGET_NAME } from "../build/fixtures.js";
import { createS5Spec } from "../build/spec.js";
import {
  createS5TestStore,
  SkeletonNonTerminalRunError,
} from "../build/testStore.js";
import { context, harness } from "./support.js";

const RUN_ID = "run-store-0001";
const TARGET = {
  table: SCRIPT_INCLUDE_TABLE,
  sysId: "1111111111111111111111111111aaaa",
  name: S5_TARGET_NAME,
};

const opened = [];
after(() => {
  for (const h of opened) h.restore();
});

function open(options) {
  const h = harness(options);
  opened.push(h);
  return h;
}

/** Project the one hardcoded spec and hand back the store plus its map. */
async function project(store, ctx = context({ runId: RUN_ID })) {
  const spec = createS5Spec(TARGET);
  const map = await store.project(ctx, [spec]);
  return { spec, map };
}

/** Record an instance-side suite run in `status`. */
function seedSuiteResult(fake, suiteSysId, status) {
  fake.tables.insert(ATF_TABLES.suiteResult, {
    test_suite: suiteSysId,
    status,
  });
}

describe("createS5TestStore().project", () => {
  it("authors the three DR-1 rows plus the DEV-19 suite and link", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      const { spec, map } = await project(store);

      assert.deepEqual(
        store.created().map((record) => record.table),
        [
          ATF_TABLES.suite,
          ATF_TABLES.test,
          ATF_TABLES.suiteTest,
          ATF_TABLES.step,
          ATF_TABLES.stepInput,
        ],
      );

      const projected = map[specKey(spec.ref)];
      assert.notEqual(projected, undefined, "the spec must be in the map");
      assert.equal(projected.runId, RUN_ID);
      assert.equal(
        projected.testSysId,
        h.fake.tables.all(ATF_TABLES.test)[0]["sys_id"],
      );
      assert.equal(
        projected.suiteSysId,
        h.fake.tables.all(ATF_TABLES.suite)[0]["sys_id"],
      );
    } finally {
      h.restore();
    }
  });

  it("prefixes the test name with the run id — the ARCH-26 probe key", async () => {
    const h = open();
    try {
      await project(createS5TestStore());
      const name = h.fake.tables.all(ATF_TABLES.test)[0]["name"];
      assert.ok(
        String(name).startsWith(RUN_ID),
        `"${name}" must start with the run id, or the orphan probe finds nothing`,
      );
    } finally {
      h.restore();
    }
  });

  it("namespaces test AND suite names with the delimited `<runId>:` prefix", async () => {
    // Same convention as @tessera/teststore-atf. A bare `<runId>` prefix lets
    // run "run-1" claim "run-10 …" — the delimiter is what bounds the namespace.
    const h = open();
    try {
      await project(createS5TestStore());
      for (const table of [ATF_TABLES.test, ATF_TABLES.suite]) {
        const name = String(h.fake.tables.all(table)[0]["name"]);
        assert.ok(
          name.startsWith(`${RUN_ID}:`),
          `${table} "${name}" must start with "${RUN_ID}:"`,
        );
      }
    } finally {
      h.restore();
    }
  });

  it("refuses an unsafe run id before any request", async () => {
    for (const runId of [
      "",
      "run^ORname=x",
      "a=b",
      "a@b",
      "a\rb",
      "a\nb",
      "a:b",
    ]) {
      const h = open();
      try {
        await assert.rejects(
          () => project(createS5TestStore(), context({ runId })),
          (error) => {
            assert.ok(error instanceof SkeletonInfrastructureError);
            assert.match(error.message, /not safe to splice/);
            return true;
          },
          `run id ${JSON.stringify(runId)} must be refused`,
        );
        assert.deepEqual(h.fake.requests(), [], "nothing may be written first");
      } finally {
        h.restore();
      }
    }
  });

  it("writes the script to the step's sys_variable_value row (DR-1)", async () => {
    const h = open();
    try {
      const { spec } = await project(createS5TestStore());
      const [input] = h.fake.tables.all(ATF_TABLES.stepInput);
      assert.equal(input["value"], spec.payload.script);
      assert.equal(
        input["document_key"],
        h.fake.tables.all(ATF_TABLES.step)[0]["sys_id"],
      );
    } finally {
      h.restore();
    }
  });

  it("refuses a non-ephemeral lifecycle instead of leaking records", async () => {
    const h = open();
    try {
      await assert.rejects(
        () =>
          project(createS5TestStore(), context({ lifecycle: "persistent" })),
        (error) => {
          assert.ok(error instanceof SkeletonInfrastructureError);
          assert.match(error.message, /ephemeral lifecycle/);
          return true;
        },
      );
      assert.deepEqual(h.fake.requests(), [], "nothing may be written first");
    } finally {
      h.restore();
    }
  });

  it("refuses anything but exactly one spec", async () => {
    const h = open();
    try {
      const spec = createS5Spec(TARGET);
      await assert.rejects(
        () => createS5TestStore().project(context(), []),
        /exactly one hardcoded spec \(got 0\)/,
      );
      await assert.rejects(
        () => createS5TestStore().project(context(), [spec, spec]),
        /exactly one hardcoded spec \(got 2\)/,
      );
    } finally {
      h.restore();
    }
  });

  it("refuses a spec carrying no ATF payload", async () => {
    const h = open();
    try {
      const spec = { ...createS5Spec(TARGET), payload: { script: 42 } };
      await assert.rejects(
        () => createS5TestStore().project(context(), [spec]),
        /carries no ATF payload/,
      );
    } finally {
      h.restore();
    }
  });

  it("names the step-input finding when that write is refused", async () => {
    // Spike 0: this row is not Table-API-writable on every instance. The store
    // promises to name that finding rather than surface an opaque 403 — and it
    // must not return a projection map for a test with no script in it.
    const h = open();
    h.fake.faults.add({
      match: { method: "POST", table: ATF_TABLES.stepInput },
      mode: { kind: "http-error", status: 403, message: "ACL" },
    });
    try {
      await assert.rejects(
        () => project(createS5TestStore()),
        (error) => {
          assert.ok(error instanceof SkeletonInfrastructureError);
          assert.match(error.message, /Scripted REST authoring channel/);
          return true;
        },
      );
    } finally {
      h.restore();
    }
  });
});

describe("createS5TestStore().teardown", () => {
  it("deletes in the pinned DEV-13 order once the run is terminal", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      const { map } = await project(store);
      seedSuiteResult(
        h.fake,
        map[Object.keys(map)[0]].suiteSysId,
        "successful",
      );

      await store.teardown(context({ runId: RUN_ID }));

      assert.deepEqual(
        store.deleted().map((record) => record.table),
        [
          ATF_TABLES.suiteTest,
          ATF_TABLES.stepInput,
          ATF_TABLES.step,
          ATF_TABLES.test,
          ATF_TABLES.suite,
        ],
      );
      assert.equal(h.fake.tables.count(ATF_TABLES.test), 0);
      assert.equal(h.fake.tables.count(ATF_TABLES.suite), 0);
    } finally {
      h.restore();
    }
  });

  it("refuses under a non-terminal run and deletes NOTHING", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      const { map } = await project(store);
      seedSuiteResult(h.fake, map[Object.keys(map)[0]].suiteSysId, "running");

      await assert.rejects(
        () => store.teardown(context({ runId: RUN_ID })),
        (error) => {
          assert.ok(error instanceof SkeletonNonTerminalRunError);
          assert.match(error.message, /not provably terminal/);
          return true;
        },
      );
      // The refusal is only worth anything if it happened BEFORE the deletes.
      assert.deepEqual(store.deleted(), []);
      assert.equal(h.fake.tables.count(ATF_TABLES.test), 1);
    } finally {
      h.restore();
    }
  });

  it("fails closed on an UNRECOGNISED status", async () => {
    // The status vocabulary is marked GUESSED in `atf.ts`. A word this build
    // has never seen is not evidence the run finished, and treating it as
    // terminal would delete the records out from under a live run.
    const h = open();
    try {
      const store = createS5TestStore();
      const { map } = await project(store);
      seedSuiteResult(
        h.fake,
        map[Object.keys(map)[0]].suiteSysId,
        "partially_succeeded",
      );

      await assert.rejects(
        () => store.teardown(context({ runId: RUN_ID })),
        SkeletonNonTerminalRunError,
      );
      assert.deepEqual(store.deleted(), []);
    } finally {
      h.restore();
    }
  });

  it("fails closed on a MISSING status column", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      const { map } = await project(store);
      h.fake.tables.insert(ATF_TABLES.suiteResult, {
        test_suite: map[Object.keys(map)[0]].suiteSysId,
      });

      await assert.rejects(
        () => store.teardown(context({ runId: RUN_ID })),
        SkeletonNonTerminalRunError,
      );
    } finally {
      h.restore();
    }
  });

  it("refuses when ONE of several suite results is still running", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      const { map } = await project(store);
      const suite = map[Object.keys(map)[0]].suiteSysId;
      seedSuiteResult(h.fake, suite, "successful");
      seedSuiteResult(h.fake, suite, "running");

      await assert.rejects(
        () => store.teardown(context({ runId: RUN_ID })),
        SkeletonNonTerminalRunError,
      );
      assert.deepEqual(store.deleted(), []);
    } finally {
      h.restore();
    }
  });

  it("a suite that never ran leaves no result row and tears down", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      await project(store);
      await store.teardown(context({ runId: RUN_ID }));
      assert.equal(store.deleted().length, 5);
    } finally {
      h.restore();
    }
  });

  it("keeps the run's evidence by default", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      const { map } = await project(store);
      seedSuiteResult(
        h.fake,
        map[Object.keys(map)[0]].suiteSysId,
        "successful",
      );

      await store.teardown(context({ runId: RUN_ID }));
      assert.equal(
        h.fake.tables.count(ATF_TABLES.suiteResult),
        1,
        "QA-17/DEV-21: teardown must not erase the run's own evidence",
      );
      assert.deepEqual(
        store.deleted().filter((r) => r.table === ATF_TABLES.suiteResult),
        [],
      );
    } finally {
      h.restore();
    }
  });

  it("deletes the evidence only when explicitly asked", async () => {
    const h = open();
    try {
      const store = createS5TestStore({ deleteSuiteResults: true });
      const { map } = await project(store);
      seedSuiteResult(
        h.fake,
        map[Object.keys(map)[0]].suiteSysId,
        "successful",
      );

      await store.teardown(context({ runId: RUN_ID }));
      assert.equal(h.fake.tables.count(ATF_TABLES.suiteResult), 0);
    } finally {
      h.restore();
    }
  });

  it("sweeps a W1/W2 orphan this process did not create", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      const { map } = await project(store);
      seedSuiteResult(
        h.fake,
        map[Object.keys(map)[0]].suiteSysId,
        "successful",
      );
      // A record written between `intend` and `confirm` by a process that then
      // died: in the run's namespace, unknown to this store's creation log.
      h.fake.tables.insert(ATF_TABLES.test, {
        name: `${RUN_ID}: orphaned test`,
        active: "true",
      });

      await store.teardown(context({ runId: RUN_ID }));

      assert.equal(h.fake.tables.count(ATF_TABLES.test), 0);
      assert.equal(
        store.deleted().filter((r) => r.what.startsWith("orphan")).length,
        1,
      );
    } finally {
      h.restore();
    }
  });

  it("leaves another run's records alone", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      const { map } = await project(store);
      seedSuiteResult(
        h.fake,
        map[Object.keys(map)[0]].suiteSysId,
        "successful",
      );
      h.fake.tables.insert(ATF_TABLES.test, {
        name: "run-other-9999 someone else's test",
        active: "true",
      });

      await store.teardown(context({ runId: RUN_ID }));

      const survivors = h.fake.tables.all(ATF_TABLES.test);
      assert.equal(survivors.length, 1);
      assert.match(String(survivors[0]["name"]), /^run-other-9999/);
    } finally {
      h.restore();
    }
  });

  it("never sweeps a run whose id merely starts with this one, nor a user's row", async () => {
    // Reviewer repro r6: run "run-1" used to delete "run-10 …" and a
    // hand-written "run-1-regression …" test because the sweep matched the
    // bare run id and deleted every row it did not create itself.
    const h = open();
    try {
      const store = createS5TestStore();
      const ctx = context({ runId: "run-1" });
      const { map } = await project(store, ctx);
      seedSuiteResult(
        h.fake,
        map[Object.keys(map)[0]].suiteSysId,
        "successful",
      );
      const foreign = [
        "run-10 S5 projected test",
        "run-10: S5 projected test",
        "run-1-regression Customer checkout (hand-written)",
        "run-1 legacy undelimited name",
      ];
      for (const name of foreign) {
        h.fake.tables.insert(ATF_TABLES.test, { name, active: "true" });
      }
      h.fake.tables.insert(ATF_TABLES.suite, {
        name: "run-10: throwaway suite",
        active: "true",
      });

      await store.teardown(ctx);

      assert.deepEqual(
        h.fake.tables
          .all(ATF_TABLES.test)
          .map((row) => row["name"])
          .sort(),
        [...foreign].sort(),
      );
      assert.deepEqual(
        h.fake.tables.all(ATF_TABLES.suite).map((row) => row["name"]),
        ["run-10: throwaway suite"],
      );
      assert.deepEqual(
        store.deleted().filter((r) => r.what.startsWith("orphan")),
        [],
      );
    } finally {
      h.restore();
    }
  });

  it("attributes orphans case-sensitively — STARTSWITH is only a pre-filter", async () => {
    // ServiceNow (and the fake) match STARTSWITH case-insensitively, so
    // "RUN-STORE-0001: …" comes back from the query; it is not this run's row.
    const h = open();
    try {
      const store = createS5TestStore();
      const { map } = await project(store);
      seedSuiteResult(
        h.fake,
        map[Object.keys(map)[0]].suiteSysId,
        "successful",
      );
      const upper = `${RUN_ID.toUpperCase()}: someone else's test`;
      h.fake.tables.insert(ATF_TABLES.test, { name: upper, active: "true" });

      await store.teardown(context({ runId: RUN_ID }));

      assert.deepEqual(
        h.fake.tables.all(ATF_TABLES.test).map((row) => row["name"]),
        [upper],
      );
    } finally {
      h.restore();
    }
  });

  it("refuses an unsafe run id at teardown before any request", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      await project(store);
      const before = h.fake.requests().length;
      await assert.rejects(
        () => store.teardown(context({ runId: "run-store-0001^ORname=x" })),
        /not safe to splice/,
      );
      assert.equal(h.fake.requests().length, before, "no probe, no delete");
      assert.deepEqual(store.deleted(), []);
    } finally {
      h.restore();
    }
  });

  it("does nothing at all when nothing was projected", async () => {
    const h = open();
    try {
      const store = createS5TestStore();
      await store.teardown(context({ runId: RUN_ID }));
      assert.deepEqual(store.deleted(), []);
      assert.deepEqual(h.fake.requests(), [], "no probe, no sweep, no delete");
    } finally {
      h.restore();
    }
  });

  it("the spec id travels into the projected records' descriptions", async () => {
    const h = open();
    try {
      await project(createS5TestStore());
      const [test] = h.fake.tables.all(ATF_TABLES.test);
      assert.match(String(test["description"]), new RegExp(S5_SPEC_ID));
    } finally {
      h.restore();
    }
  });
});
