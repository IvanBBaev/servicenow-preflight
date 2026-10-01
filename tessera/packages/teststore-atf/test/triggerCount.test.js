// DEV-17 queued-second-execution gap (wave 13): teardown reads the ledger's
// recorded suite-trigger count and refuses while fewer result rows exist than
// recorded triggers — a second execution may still be queued with no row.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  DEFAULT_SUITE_TRIGGER_TABLE,
  TestStoreRefusalError,
  countRecordedSuiteTriggers,
  createAtfTestStore,
} from "../build/index.js";
import {
  RUN_ID,
  fakeClient,
  makeCtx,
  makeInstance,
  rowCounts,
  spec,
  tempLock,
} from "./support.js";

const refusal = (code) => (error) =>
  error instanceof TestStoreRefusalError && error.code === code;

let lock;
beforeEach(() => {
  lock = tempLock();
});
afterEach(() => lock.cleanup());

function storeFor(instance, options = {}) {
  const client = fakeClient(instance);
  const store = createAtfTestStore({
    client,
    lockPath: lock.lockPath,
    onWarning: () => {},
    ...options,
  });
  return { store, client };
}

/** Project one spec and return the fake instance, store, and suite sys_id. */
async function projected(options = {}) {
  const instance = makeInstance();
  const { store, client } = storeFor(instance, options);
  const map = await store.project(makeCtx(), [spec("alpha"), spec("beta")]);
  const { suiteSysId } = Object.values(map)[0];
  return { instance, store, client, suiteSysId };
}

function execution(instance, suiteSysId, status) {
  return instance.tables.insert("sys_atf_test_suite_result", {
    test_suite: suiteSysId,
    status,
  });
}

describe("DEV-17 recorded trigger count (wave 13)", () => {
  test("single trigger, one terminal row: teardown proceeds unchanged", async () => {
    const { instance, store, suiteSysId } = await projected();
    execution(instance, suiteSysId, "success");
    await store.teardown(makeCtx({ recordedTriggers: 1 }));
    assert.equal(rowCounts(instance).sys_atf_test_suite, 0);
    assert.equal(rowCounts(instance).sys_atf_test, 0);
  });

  test("two triggers, second still queued (no row): refused, nothing deleted", async () => {
    const { instance, store, suiteSysId } = await projected();
    execution(instance, suiteSysId, "success");
    const counts = rowCounts(instance);
    await assert.rejects(
      store.teardown(makeCtx({ recordedTriggers: 2 })),
      (error) => {
        assert.ok(refusal("non-terminal-run")(error), String(error));
        assert.match(error.message, /records 2 suite trigger\(s\)/);
        assert.match(error.message, /only 1 sys_atf_test_suite_result/);
        return true;
      },
    );
    assert.deepEqual(rowCounts(instance), counts, "nothing was deleted");
    store.release();
  });

  test("two triggers, second running: refused by the terminal-status rule", async () => {
    const { instance, store, suiteSysId } = await projected();
    execution(instance, suiteSysId, "success");
    execution(instance, suiteSysId, "running");
    const counts = rowCounts(instance);
    await assert.rejects(
      store.teardown(makeCtx({ recordedTriggers: 2 })),
      (error) => {
        assert.ok(refusal("non-terminal-run")(error), String(error));
        assert.match(error.message, /not provably terminal/);
        return true;
      },
    );
    assert.deepEqual(rowCounts(instance), counts);
    store.release();
  });

  test("two triggers, both terminal: teardown proceeds", async () => {
    const { instance, store, suiteSysId } = await projected();
    execution(instance, suiteSysId, "success");
    const second = execution(instance, suiteSysId, "running");
    await assert.rejects(
      store.teardown(makeCtx({ recordedTriggers: 2 })),
      refusal("non-terminal-run"),
    );
    instance.tables.update("sys_atf_test_suite_result", second.sys_id, {
      status: "failed",
    });
    await store.teardown(makeCtx({ recordedTriggers: 2 }));
    assert.equal(rowCounts(instance).sys_atf_test_suite, 0);
    assert.equal(rowCounts(instance).sys_atf_test, 0);
    assert.equal(
      instance.tables.count("sys_atf_test_suite_result"),
      2,
      "results are evidence and stay",
    );
  });

  for (const unknown of [null, Number.NaN, -1, 1.5, "2", Infinity, 2n, {}]) {
    test(`unknown count ${typeof unknown === "object" ? JSON.stringify(unknown) : String(unknown)}: refused before any request`, async () => {
      const { instance, store, client, suiteSysId } = await projected();
      execution(instance, suiteSysId, "success");
      const counts = rowCounts(instance);
      const before = client.calls.length;
      await assert.rejects(
        store.teardown(makeCtx({ recordedTriggers: unknown })),
        (error) => {
          assert.ok(refusal("non-terminal-run")(error), String(error));
          assert.match(error.message, /count is unknown/);
          return true;
        },
      );
      assert.equal(client.calls.length, before, "no request was made");
      assert.deepEqual(rowCounts(instance), counts);
      store.release();
    });
  }

  test("requireRecordedTriggers: a missing count is refused before any request", async () => {
    const { instance, store, client, suiteSysId } = await projected({
      requireRecordedTriggers: true,
    });
    execution(instance, suiteSysId, "success");
    const before = client.calls.length;
    await assert.rejects(store.teardown(makeCtx()), (error) => {
      assert.ok(refusal("non-terminal-run")(error), String(error));
      assert.match(error.message, /supplied none/);
      return true;
    });
    assert.equal(client.calls.length, before);
    await store.teardown(makeCtx({ recordedTriggers: 1 }));
    assert.equal(rowCounts(instance).sys_atf_test_suite, 0);
  });

  test("legacy caller (no count, not required) keeps the pre-wave-13 gate", async () => {
    // Pins the documented residual: without a count, one terminal row still
    // passes even though a second execution may be queued.
    const { instance, store, suiteSysId } = await projected();
    execution(instance, suiteSysId, "success");
    await store.teardown(makeCtx());
    assert.equal(rowCounts(instance).sys_atf_test_suite, 0);
  });

  test("neverTriggered contradicted by a recorded trigger: refused", async () => {
    const { instance, store } = await projected();
    const counts = rowCounts(instance);
    await assert.rejects(
      store.teardown(makeCtx({ neverTriggered: true, recordedTriggers: 1 })),
      (error) => {
        assert.ok(refusal("non-terminal-run")(error), String(error));
        assert.match(error.message, /contradictory/);
        return true;
      },
    );
    assert.deepEqual(rowCounts(instance), counts);
    // A zero count agrees with neverTriggered: the escape hatch still works.
    await store.teardown(
      makeCtx({ neverTriggered: true, recordedTriggers: 0 }),
    );
    assert.equal(rowCounts(instance).sys_atf_test_suite, 0);
  });

  test("a zero count does not by itself bypass the zero-result gate", async () => {
    const { instance, store } = await projected();
    const counts = rowCounts(instance);
    await assert.rejects(
      store.teardown(makeCtx({ recordedTriggers: 0 })),
      refusal("non-terminal-run"),
    );
    assert.deepEqual(rowCounts(instance), counts);
    store.release();
  });
});

describe("countRecordedSuiteTriggers", () => {
  // Shaped like `@tessera/ledger` `LedgerEntry` records from
  // `IntentLedger.entries(runId)`: core intends one entry per runner group on
  // the trigger table (compensation `none`), plus projection entries.
  const entry = (seq, table, state, runId = RUN_ID) => ({
    seq,
    runId,
    instance: "dev12345.service-now.com",
    intent: `write ${seq}`,
    target: { table },
    compensation: { op: "none", reason: "test" },
    state,
    idempotencyKey: `${runId}:${seq}`,
  });

  test("counts trigger entries in every state, ignores other tables", () => {
    const entries = [
      entry(1, "sys_atf_test", "applied"),
      entry(2, DEFAULT_SUITE_TRIGGER_TABLE, "applied"),
      entry(3, DEFAULT_SUITE_TRIGGER_TABLE, "intended"),
      entry(4, DEFAULT_SUITE_TRIGGER_TABLE, "compensated"),
    ];
    assert.equal(DEFAULT_SUITE_TRIGGER_TABLE, "sys_atf_test_suite_run");
    assert.equal(countRecordedSuiteTriggers(RUN_ID, entries), 3);
    assert.equal(countRecordedSuiteTriggers(RUN_ID, []), 0);
    assert.equal(
      countRecordedSuiteTriggers(RUN_ID, entries, "x_custom_trigger"),
      0,
    );
  });

  test("an entry of another run throws instead of being skipped", () => {
    assert.throws(
      () =>
        countRecordedSuiteTriggers(RUN_ID, [
          entry(1, DEFAULT_SUITE_TRIGGER_TABLE, "applied", "other-run"),
        ]),
      TypeError,
    );
  });
});
