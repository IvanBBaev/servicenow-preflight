// Teardown ownership (fix 2026-09-26, F2): a namespace match is not proof of
// ownership. Every sys_atf_test / sys_atf_test_suite teardown deletes must
// carry the store's own `Tessera run <runId> — ` description marker, every
// suite→test link it deletes must hang off a run-owned suite, and the DEV-17
// gate must cover tests that have no namespaced suite. Anything else refuses
// the WHOLE teardown before the first DELETE.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  TestStoreRefusalError,
  createAtfTestStore,
  runOwnershipMarker,
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

const untriggered = (options = {}) =>
  makeCtx({ ...options, neverTriggered: true });

let lock;
beforeEach(() => {
  lock = tempLock();
});
afterEach(() => lock.cleanup());

function storeFor(instance) {
  const client = fakeClient(instance);
  const store = createAtfTestStore({
    client,
    lockPath: lock.lockPath,
    onWarning: () => {},
  });
  return { store, client };
}

const deletes = (client) =>
  client.calls.filter((call) => call.method === "DELETE");

describe("runOwnershipMarker()", () => {
  test("is the exact description prefix project() writes", async () => {
    assert.equal(runOwnershipMarker("r-1"), "Tessera run r-1 — ");
    const instance = makeInstance();
    const { store } = storeFor(instance);
    await store.project(makeCtx(), [spec("alpha")]);
    for (const table of ["sys_atf_test", "sys_atf_test_suite"]) {
      for (const row of instance.tables.all(table)) {
        assert.ok(
          row.description.startsWith(runOwnershipMarker(RUN_ID)),
          `${table}: ${row.description}`,
        );
      }
    }
    store.release();
  });
});

describe("teardown refuses rows the run does not own (F2)", () => {
  test("R2: a customer test named <runId>:… is not deleted, nor its steps or customer-suite link", async () => {
    const instance = makeInstance({
      state: {
        sys_atf_test: [
          { sys_id: "1".repeat(32), name: "smoke:login (customer-owned)" },
        ],
        sys_atf_step: [{ sys_id: "2".repeat(32), test: "1".repeat(32) }],
        sys_variable_value: [
          {
            sys_id: "5".repeat(32),
            document: "sys_atf_step",
            document_key: "2".repeat(32),
            value: "customer script",
          },
        ],
        sys_atf_test_suite: [
          { sys_id: "3".repeat(32), name: "Customer regression suite" },
        ],
        sys_atf_test_suite_test: [
          {
            sys_id: "4".repeat(32),
            test_suite: "3".repeat(32),
            test: "1".repeat(32),
          },
        ],
      },
    });
    const { store, client } = storeFor(instance);
    const counts = rowCounts(instance);
    await assert.rejects(
      store.teardown(untriggered({ runId: "smoke" })),
      (error) => {
        assert.ok(refusal("not-run-owned")(error), String(error));
        assert.match(error.message, /1{32}/);
        assert.match(error.message, /nothing was deleted/);
        return true;
      },
    );
    assert.deepEqual(deletes(client), []);
    assert.deepEqual(rowCounts(instance), counts);
  });

  test("a namespaced test carrying ANOTHER run's marker is refused", async () => {
    const instance = makeInstance({
      state: {
        sys_atf_test: [
          {
            name: `${RUN_ID}:alpha`,
            description: "Tessera run someone-else — projected from spec alpha",
          },
        ],
      },
    });
    const { store, client } = storeFor(instance);
    await assert.rejects(
      store.teardown(untriggered()),
      refusal("not-run-owned"),
    );
    assert.deepEqual(deletes(client), []);
  });

  test("a namespaced suite without the marker is refused", async () => {
    const instance = makeInstance({
      state: { sys_atf_test_suite: [{ name: `${RUN_ID}:suite` }] },
    });
    const { store, client } = storeFor(instance);
    await assert.rejects(
      store.teardown(untriggered()),
      refusal("not-run-owned"),
    );
    assert.deepEqual(deletes(client), []);
  });

  test("one foreign namespaced row refuses the WHOLE teardown, the run's own rows included", async () => {
    const instance = makeInstance();
    const { store, client } = storeFor(instance);
    await store.project(makeCtx(), [spec("alpha"), spec("beta")]);
    instance.tables.insert("sys_atf_test", { name: `${RUN_ID}:intruder` });
    const counts = rowCounts(instance);
    await assert.rejects(
      store.teardown(untriggered()),
      refusal("not-run-owned"),
    );
    assert.deepEqual(deletes(client), []);
    assert.deepEqual(rowCounts(instance), counts);
    store.release();
  });

  test("a FOREIGN suite linking a run-owned test is refused, and the link survives", async () => {
    const instance = makeInstance();
    const { store, client } = storeFor(instance);
    const map = await store.project(makeCtx(), [spec("alpha")]);
    const { testSysId } = Object.values(map)[0];
    const customerSuite = instance.tables.insert("sys_atf_test_suite", {
      name: "Customer nightly",
    });
    const link = instance.tables.insert("sys_atf_test_suite_test", {
      test_suite: customerSuite.sys_id,
      test: testSysId,
    });
    const counts = rowCounts(instance);
    await assert.rejects(store.teardown(untriggered()), (error) => {
      assert.ok(refusal("not-run-owned")(error), String(error));
      assert.match(error.message, new RegExp(link.sys_id));
      assert.match(error.message, new RegExp(customerSuite.sys_id));
      return true;
    });
    assert.deepEqual(deletes(client), []);
    assert.deepEqual(rowCounts(instance), counts);
    store.release();
  });

  test("a link from a run-owned suite to a customer test is deleted; the customer test is not", async () => {
    const instance = makeInstance();
    const { store } = storeFor(instance);
    const map = await store.project(makeCtx(), [spec("alpha")]);
    const { suiteSysId } = Object.values(map)[0];
    const customerTest = instance.tables.insert("sys_atf_test", {
      name: "Customer login",
    });
    instance.tables.insert("sys_atf_test_suite_test", {
      test_suite: suiteSysId,
      test: customerTest.sys_id,
    });
    await store.teardown(untriggered());
    assert.deepEqual(rowCounts(instance), {
      sys_atf_test: 1,
      sys_atf_step: 0,
      sys_variable_value: 0,
      sys_atf_test_suite: 0,
      sys_atf_test_suite_test: 0,
    });
    assert.equal(instance.tables.all("sys_atf_test")[0].name, "Customer login");
  });

  test("a link to a suite that no longer exists is not provably run-owned: refused", async () => {
    const instance = makeInstance();
    const { store, client } = storeFor(instance);
    const map = await store.project(makeCtx(), [spec("alpha")]);
    const { testSysId } = Object.values(map)[0];
    instance.tables.insert("sys_atf_test_suite_test", {
      test_suite: "9".repeat(32),
      test: testSysId,
    });
    await assert.rejects(
      store.teardown(untriggered()),
      refusal("not-run-owned"),
    );
    assert.deepEqual(deletes(client), []);
    store.release();
  });
});

describe("DEV-17 covers run-owned tests with no namespaced suite (F2c)", () => {
  function orphanTests() {
    const instance = makeInstance();
    for (const id of ["alpha", "beta"]) {
      instance.tables.insert("sys_atf_test", {
        name: `${RUN_ID}:${id}`,
        description: `${runOwnershipMarker(RUN_ID)}projected from spec ${id}`,
      });
    }
    return instance;
  }

  test("refuses, deleting nothing, unless the caller asserts neverTriggered", async () => {
    const instance = orphanTests();
    const { store, client } = storeFor(instance);
    await assert.rejects(store.teardown(makeCtx()), (error) => {
      assert.ok(refusal("non-terminal-run")(error), String(error));
      assert.match(error.message, /no run-owned sys_atf_test_suite/);
      return true;
    });
    assert.deepEqual(deletes(client), []);
    assert.equal(rowCounts(instance).sys_atf_test, 2);

    await store.teardown(untriggered());
    assert.equal(rowCounts(instance).sys_atf_test, 0);
  });
});
