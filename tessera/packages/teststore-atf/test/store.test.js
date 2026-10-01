// ATF TestStore adapter — project/teardown against @tessera/fake-instance
// (ADR-007, DEV-13, DEV-17, C3/C4/C5; delegated decision 2026-09-23).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";

import { specKey } from "@tessera/core";
import { W2_AUTHORING_ROLE } from "@tessera/fake-instance";

import {
  AUTHORING_CHANNEL_ROLE,
  RUN_SERVER_SIDE_SCRIPT_STEP_CONFIG,
  TEST_SCRIPT_INPUT_VARIABLE,
  TestStoreInfrastructureError,
  TestStoreRefusalError,
  assertTableApiPath,
  compareChannelVersion,
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

// These suites project and tear down WITHOUT ever triggering the suite, so
// the DEV-17 gate sees a suite with no sys_atf_test_suite_result row. Since
// the 2026-09-25 fix that refuses unless the caller asserts the suite was
// never triggered — which is literally true here, so every such teardown
// passes `neverTriggered: true` (core does the same for pre-`running` faults).
const untriggered = (options = {}) =>
  makeCtx({ ...options, neverTriggered: true });

let lock;
beforeEach(() => {
  lock = tempLock();
});
afterEach(() => lock.cleanup());

function storeFor(instance, options = {}) {
  const client = options.client ?? fakeClient(instance);
  const store = createAtfTestStore({
    client,
    lockPath: lock.lockPath,
    onWarning: () => {},
    ...options,
  });
  return { store, client };
}

describe("project()", () => {
  test("creates suite, tests, links, steps and step inputs, namespaced by run id", async () => {
    const instance = makeInstance();
    const { store } = storeFor(instance);
    const specs = [
      spec("alpha", "gs.info('a');"),
      spec("beta", "gs.info('b');"),
    ];

    const map = await store.project(makeCtx(), specs);

    assert.deepEqual(rowCounts(instance), {
      sys_atf_test: 2,
      sys_atf_step: 2,
      sys_variable_value: 2,
      sys_atf_test_suite: 1,
      sys_atf_test_suite_test: 2,
    });
    const [suite] = instance.tables.all("sys_atf_test_suite");
    assert.equal(suite.name, `${RUN_ID}:suite`);
    for (const [index, s] of specs.entries()) {
      const record = map[specKey(s.ref)];
      assert.ok(record, `map entry for ${s.ref.id}`);
      assert.equal(record.runId, RUN_ID);
      assert.equal(record.suiteSysId, suite.sys_id);
      const testRow = instance.tables.get("sys_atf_test", record.testSysId);
      // ARCH-26: core's W1/W2 probe is nameSTARTSWITH<runId>.
      assert.equal(testRow.name, `${RUN_ID}:${s.ref.id}`);
      assert.ok(testRow.name.startsWith(RUN_ID));
      const [step] = instance.tables
        .all("sys_atf_step")
        .filter((row) => row.test === record.testSysId);
      assert.equal(step.step_config, RUN_SERVER_SIDE_SCRIPT_STEP_CONFIG);
      const [input] = instance.tables
        .all("sys_variable_value")
        .filter((row) => row.document_key === step.sys_id);
      assert.equal(input.document, "sys_atf_step");
      assert.equal(input.variable, TEST_SCRIPT_INPUT_VARIABLE);
      assert.equal(input.value, s.payload.script);
      const [link] = instance.tables
        .all("sys_atf_test_suite_test")
        .filter((row) => row.test === record.testSysId);
      assert.equal(link.test_suite, suite.sys_id);
      assert.equal(link.order, String(index + 1));
    }
    assert.equal(store.lastChannelCheck().outcome, "compatible");
    store.release();
  });

  test("Spike 0: an auto-created step input is updated, not duplicated", async () => {
    const instance = makeInstance();
    // Simulate the platform auto-creating the input when the step lands.
    const base = fakeClient(instance);
    const client = {
      async request(args) {
        const response = await base.request(args);
        if (
          args.method === "POST" &&
          args.path === "/api/now/table/sys_atf_step"
        ) {
          instance.tables.insert("sys_variable_value", {
            document: "sys_atf_step",
            document_key: response.data.result.sys_id,
            variable: TEST_SCRIPT_INPUT_VARIABLE,
            value: "",
          });
        }
        return response;
      },
    };
    const { store } = storeFor(instance, { client });
    await store.project(makeCtx(), [spec("alpha", "gs.info('x');")]);
    const inputs = instance.tables.all("sys_variable_value");
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].value, "gs.info('x');");
    store.release();
  });

  test("an empty spec list projects nothing and returns an empty map", async () => {
    const instance = makeInstance();
    const { store } = storeFor(instance);
    assert.deepEqual(await store.project(makeCtx(), []), {});
    assert.equal(rowCounts(instance).sys_atf_test_suite, 0);
    store.release();
  });

  test("refuses the persistent lifecycle before any I/O (§4a/DEV-12)", async () => {
    const instance = makeInstance();
    const { store, client } = storeFor(instance);
    await assert.rejects(
      store.project(makeCtx({ lifecycle: "persistent" }), [spec("alpha")]),
      refusal("lifecycle"),
    );
    assert.equal(client.calls.length, 0);
    assert.equal(fs.existsSync(lock.lockPath), false);
  });

  test("refuses a spec without a script payload, and duplicate spec keys", async () => {
    const instance = makeInstance();
    const { store, client } = storeFor(instance);
    await assert.rejects(
      store.project(makeCtx(), [
        { ...spec("alpha"), payload: { script: " " } },
      ]),
      refusal("payload"),
    );
    await assert.rejects(
      store.project(makeCtx(), [spec("alpha"), spec("alpha")]),
      refusal("payload"),
    );
    assert.equal(client.calls.length, 0);
  });

  test("refuses when the run's namespace already holds records", async () => {
    const instance = makeInstance({
      state: { sys_atf_test: [{ name: `${RUN_ID}:leftover` }] },
    });
    const { store } = storeFor(instance);
    await assert.rejects(
      store.project(makeCtx(), [spec("alpha")]),
      refusal("namespace-occupied"),
    );
    assert.equal(rowCounts(instance).sys_atf_test_suite, 0);
    assert.equal(
      fs.existsSync(lock.lockPath),
      false,
      "lock released on refusal",
    );
  });

  test("a sibling run's namespace (r-1 vs r-10) does not count as occupied", async () => {
    const instance = makeInstance({
      state: { sys_atf_test: [{ name: "r-10:alpha" }] },
    });
    const { store } = storeFor(instance);
    await store.project(makeCtx({ runId: "r-1" }), [spec("alpha")]);
    await store.teardown(untriggered({ runId: "r-1" }));
    assert.deepEqual(
      instance.tables.all("sys_atf_test").map((row) => row.name),
      ["r-10:alpha"],
    );
  });

  test("an aborted signal stops the projection and releases the lock", async () => {
    const instance = makeInstance();
    const { store } = storeFor(instance);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      store.project(makeCtx({ signal: controller.signal }), [spec("alpha")]),
    );
    assert.equal(rowCounts(instance).sys_atf_test, 0);
    assert.equal(fs.existsSync(lock.lockPath), false);
  });
});

describe("teardown()", () => {
  test("removes every projected row; a second teardown is a no-op", async () => {
    const instance = makeInstance({
      state: {
        // Rows that are NOT the run's and must survive.
        sys_atf_test: [{ name: "someone-else" }],
        sys_variable_value: [
          { document: "sys_atf_step", document_key: "x", value: "keep" },
        ],
      },
    });
    const { store, client } = storeFor(instance);
    await store.project(makeCtx(), [spec("alpha"), spec("beta")]);
    await store.teardown(untriggered());

    assert.deepEqual(rowCounts(instance), {
      sys_atf_test: 1,
      sys_atf_step: 0,
      sys_variable_value: 1,
      sys_atf_test_suite: 0,
      sys_atf_test_suite_test: 0,
    });
    assert.equal(fs.existsSync(lock.lockPath), false, "lock released");

    const before = client.calls.length;
    await store.teardown(untriggered());
    const second = client.calls.slice(before);
    assert.ok(second.length > 0);
    assert.deepEqual(
      second.filter((call) => call.method !== "GET"),
      [],
      "the second teardown writes nothing",
    );
  });

  test("deletes in DEV-13 order: links, inputs, steps, tests, suite", async () => {
    const instance = makeInstance();
    const { store, client } = storeFor(instance);
    await store.project(makeCtx(), [spec("alpha")]);
    const before = client.calls.length;
    await store.teardown(untriggered());
    const order = client.calls
      .slice(before)
      .filter((call) => call.method === "DELETE")
      .map((call) => call.path.split("/")[4]);
    assert.deepEqual(order, [
      "sys_atf_test_suite_test",
      "sys_variable_value",
      "sys_atf_step",
      "sys_atf_test",
      "sys_atf_test_suite",
    ]);
  });

  test("works from a fresh store (discovery, not memory) and reclaims orphans", async () => {
    const instance = makeInstance();
    const first = storeFor(instance).store;
    await first.project(makeCtx(), [spec("alpha")]);
    first.release();
    const fresh = storeFor(instance).store;
    await fresh.teardown(untriggered());
    assert.equal(rowCounts(instance).sys_atf_test, 0);
    assert.equal(rowCounts(instance).sys_variable_value, 0);
  });

  test("DEV-17: refuses (deleting nothing) while a suite result is not terminal", async () => {
    const instance = makeInstance();
    const { store } = storeFor(instance);
    const map = await store.project(makeCtx(), [spec("alpha")]);
    const { suiteSysId } = Object.values(map)[0];
    const result = instance.tables.insert("sys_atf_test_suite_result", {
      test_suite: suiteSysId,
      status: "running",
    });
    const counts = rowCounts(instance);
    await assert.rejects(
      store.teardown(makeCtx()),
      refusal("non-terminal-run"),
    );
    assert.deepEqual(rowCounts(instance), counts);

    instance.tables.update("sys_atf_test_suite_result", result.sys_id, {
      status: "success",
    });
    await store.teardown(makeCtx());
    assert.equal(rowCounts(instance).sys_atf_test_suite, 0);
    assert.equal(
      instance.tables.count("sys_atf_test_suite_result"),
      1,
      "suite results are evidence and stay",
    );
  });
});

describe("W2 ACL (fake-instance acl option)", () => {
  test("without the role the step-input write is a 403 infrastructure fault", async () => {
    const instance = makeInstance({ acl: { roles: [] } });
    const { store } = storeFor(instance);
    await assert.rejects(store.project(makeCtx(), [spec("alpha")]), (error) => {
      assert.ok(error instanceof TestStoreInfrastructureError);
      assert.equal(error.status, 403);
      assert.match(error.message, /sys_variable_value/);
      return true;
    });
    assert.equal(rowCounts(instance).sys_variable_value, 0);
    assert.equal(fs.existsSync(lock.lockPath), false);
  });

  test("with the role the projection and teardown succeed", async () => {
    assert.equal(W2_AUTHORING_ROLE, AUTHORING_CHANNEL_ROLE);
    const instance = makeInstance({ acl: { roles: [AUTHORING_CHANNEL_ROLE] } });
    const { store } = storeFor(instance);
    await store.project(makeCtx(), [spec("alpha")]);
    assert.equal(rowCounts(instance).sys_variable_value, 1);
    await store.teardown(untriggered());
    assert.equal(rowCounts(instance).sys_variable_value, 0);
  });
});

describe("projection lock", () => {
  test("a second store on the same lock path is refused while the first holds it", async () => {
    const instance = makeInstance();
    const a = storeFor(instance).store;
    const b = storeFor(instance).store;
    await a.project(makeCtx(), [spec("alpha")]);
    const bRuns = makeCtx({ runId: "run-2026-09-23-000002" });
    await assert.rejects(b.project(bRuns, [spec("beta")]), (error) => {
      assert.ok(refusal("lock-held")(error));
      assert.match(error.message, new RegExp(RUN_ID));
      return true;
    });
    assert.equal(rowCounts(instance).sys_atf_test, 1, "b wrote nothing");

    await a.teardown(untriggered());
    await b.project(bRuns, [spec("beta")]);
    b.release();
    b.release(); // idempotent
    assert.equal(fs.existsSync(lock.lockPath), false);
  });

  test("the same store refuses a second project() before teardown", async () => {
    const instance = makeInstance();
    const { store } = storeFor(instance);
    await store.project(makeCtx(), [spec("alpha")]);
    await assert.rejects(
      store.project(makeCtx({ runId: "other" }), [spec("beta")]),
      refusal("lock-held"),
    );
    store.release();
  });
});

describe("C3/C4 channel version", () => {
  test("absent version row refuses before any write (C3)", async () => {
    const instance = makeInstance({ version: null });
    const { store, client } = storeFor(instance);
    await assert.rejects(
      store.project(makeCtx(), [spec("alpha")]),
      refusal("channel-absent"),
    );
    assert.deepEqual(
      client.calls.map((c) => c.method),
      ["GET"],
    );
    assert.equal(fs.existsSync(lock.lockPath), false);
  });

  test("major mismatch refuses (C4)", async () => {
    const instance = makeInstance({ version: "2.0.0" });
    const { store } = storeFor(instance);
    await assert.rejects(
      store.project(makeCtx(), [spec("alpha")]),
      refusal("channel-incompatible"),
    );
    assert.equal(rowCounts(instance).sys_atf_test, 0);
  });

  test("unparseable version refuses (C4)", async () => {
    const instance = makeInstance({ version: "one" });
    const { store } = storeFor(instance);
    await assert.rejects(
      store.project(makeCtx(), [spec("alpha")]),
      refusal("channel-incompatible"),
    );
  });

  test("minor mismatch warns and proceeds", async () => {
    const instance = makeInstance({ version: "1.3.0" });
    const warnings = [];
    const { store } = storeFor(instance, {
      onWarning: (m) => warnings.push(m),
    });
    await store.project(makeCtx(), [spec("alpha")]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /1\.3\.0/);
    assert.equal(store.lastChannelCheck().outcome, "minor-mismatch");
    store.release();
  });

  test("patch difference is compatible without a warning", () => {
    assert.deepEqual(compareChannelVersion("1.0.7", "1.0.0"), {
      outcome: "compatible",
      installed: "1.0.7",
    });
    assert.deepEqual(compareChannelVersion("1.0", "1.0.0"), {
      outcome: "compatible",
      installed: "1.0",
    });
  });
});

describe("C5: no ACL-free endpoint", () => {
  test("constructing with any channel other than the Table API is refused", () => {
    for (const channel of ["scripted-rest", "api/x_tessera/author", ""]) {
      assert.throws(
        () =>
          createAtfTestStore({
            client: { request: () => Promise.reject(new Error("unused")) },
            lockPath: lock.lockPath,
            authoringChannel: channel,
          }),
        refusal("acl-free-endpoint"),
      );
    }
  });

  test("only /api/now/table/ paths reach the port", () => {
    assert.doesNotThrow(() =>
      assertTableApiPath("/api/now/table/sys_atf_test"),
    );
    for (const bad of [
      "/api/x_tessera/author/step_input",
      "/api/sn_cicd/testsuite/run",
      "/api/now/table/sys_atf_test?sysparm_query=x",
      "/api/now/tablex/sys_atf_test",
    ]) {
      assert.throws(
        () => assertTableApiPath(bad),
        refusal("acl-free-endpoint"),
      );
    }
  });
});

describe("DEV-17: a suite with no result row (fix 2026-09-25)", () => {
  test("refuses, deleting nothing, unless the caller asserts neverTriggered", async () => {
    const instance = makeInstance();
    const { store } = storeFor(instance);
    await store.project(makeCtx(), [spec("alpha"), spec("beta")]);
    // CI/CD accepted the trigger; the execution is queued, so no
    // sys_atf_test_suite_result row exists yet.
    const counts = rowCounts(instance);
    await assert.rejects(store.teardown(makeCtx()), (error) => {
      assert.ok(refusal("non-terminal-run")(error));
      assert.match(error.message, /no sys_atf_test_suite_result row/);
      return true;
    });
    await assert.rejects(
      store.teardown(makeCtx({ neverTriggered: false })),
      refusal("non-terminal-run"),
    );
    assert.deepEqual(rowCounts(instance), counts, "nothing was deleted");

    await store.teardown(untriggered());
    assert.equal(rowCounts(instance).sys_atf_test_suite, 0);
    assert.equal(rowCounts(instance).sys_atf_test, 0);
  });

  test("neverTriggered does not bypass a non-terminal result row", async () => {
    const instance = makeInstance();
    const { store } = storeFor(instance);
    const map = await store.project(makeCtx(), [spec("alpha")]);
    instance.tables.insert("sys_atf_test_suite_result", {
      test_suite: Object.values(map)[0].suiteSysId,
      status: "pending",
    });
    const counts = rowCounts(instance);
    await assert.rejects(
      store.teardown(untriggered()),
      refusal("non-terminal-run"),
    );
    assert.deepEqual(rowCounts(instance), counts);
    store.release();
  });
});

describe("discovery paging (fix 2026-09-25)", () => {
  /** Hide the given sys_atf_test rows from every GET, as a table ACL would. */
  function aclTrimmed(instance, hidden, clientOptions) {
    const base = fakeClient(instance, clientOptions);
    return {
      calls: base.calls,
      async request(args) {
        const response = await base.request(args);
        if (
          args.method === "GET" &&
          args.path === "/api/now/table/sys_atf_test" &&
          Array.isArray(response.data?.result)
        ) {
          return {
            ...response,
            data: {
              result: response.data.result.filter(
                (row) => !hidden.has(row.sys_id),
              ),
            },
          };
        }
        return response;
      },
    };
  }

  test("an ACL-short page does not end discovery (total reported)", async () => {
    const instance = makeInstance();
    const hidden = new Set();
    const client = aclTrimmed(instance, hidden, { withTotal: true });
    const { store } = storeFor(instance, { client, pageSize: 2 });
    await store.project(makeCtx(), [
      spec("a1"),
      spec("a2"),
      spec("a3"),
      spec("a4"),
    ]);
    hidden.add(instance.tables.all("sys_atf_test")[0].sys_id);
    await store.teardown(untriggered());
    // Only the row the session cannot see survives; a3/a4 on page 2 were
    // found although page 1 came back short.
    assert.equal(rowCounts(instance).sys_atf_test, 1);
    assert.equal(rowCounts(instance).sys_atf_step, 1);
  });

  // Wave 16 (updated deliberately): with no total the short page still does
  // not end discovery, but the Stats count (4, unfiltered) no longer matches
  // the 3 rows read, so teardown refuses before any DELETE instead of
  // silently leaving the hidden row behind.
  test("an ACL-short page does not end discovery (total absent) — the Stats count refuses", async () => {
    const instance = makeInstance();
    const hidden = new Set();
    const client = aclTrimmed(instance, hidden, { withTotal: false });
    const { store } = storeFor(instance, { client, pageSize: 2 });
    await store.project(makeCtx(), [
      spec("a1"),
      spec("a2"),
      spec("a3"),
      spec("a4"),
    ]);
    hidden.add(instance.tables.all("sys_atf_test")[0].sys_id);
    const before = rowCounts(instance);
    await assert.rejects(store.teardown(untriggered()), (error) => {
      assert.ok(error instanceof TestStoreInfrastructureError);
      assert.match(error.message, /Stats API counted 4 .*returned 3/);
      return true;
    });
    assert.deepEqual(rowCounts(instance), before);
    store.release();
  });

  test("with a reported total, a fully ACL-trimmed page does not end discovery", async () => {
    const instance = makeInstance();
    const hidden = new Set();
    const client = aclTrimmed(instance, hidden, { withTotal: true });
    const { store } = storeFor(instance, { client, pageSize: 2 });
    await store.project(makeCtx(), [
      spec("a1"),
      spec("a2"),
      spec("a3"),
      spec("a4"),
    ]);
    const ordered = instance.tables
      .all("sys_atf_test")
      .map((row) => row.sys_id)
      .sort();
    hidden.add(ordered[0]);
    hidden.add(ordered[1]);
    await store.teardown(untriggered());
    assert.equal(rowCounts(instance).sys_atf_test, 2);
  });

  test("hitting maxQueryPages throws instead of truncating, deleting nothing", async () => {
    const instance = makeInstance();
    const { store } = storeFor(instance, { pageSize: 1, maxQueryPages: 2 });
    await store.project(makeCtx(), [spec("a1")]);
    for (const id of ["a2", "a3"]) {
      instance.tables.insert("sys_atf_test", { name: `${RUN_ID}:${id}` });
    }
    const counts = rowCounts(instance);
    await assert.rejects(store.teardown(untriggered()), (error) => {
      assert.ok(error instanceof TestStoreInfrastructureError);
      assert.match(error.message, /refusing to continue on a truncated/);
      return true;
    });
    assert.deepEqual(rowCounts(instance), counts);
    store.release();
  });

  test("a non-positive or non-integer pageSize / maxQueryPages is a TypeError", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const name of ["pageSize", "maxQueryPages"]) {
        assert.throws(
          () =>
            createAtfTestStore({
              client: fakeClient(makeInstance()),
              lockPath: lock.lockPath,
              [name]: bad,
            }),
          TypeError,
          `${name}=${bad}`,
        );
      }
    }
  });
});

describe("run-id namespace is case-sensitive (fix 2026-09-25)", () => {
  test("nightly-1 neither sees nor deletes Nightly-1's records", async () => {
    const instance = makeInstance();
    const upper = storeFor(instance).store;
    await upper.project(makeCtx({ runId: "Nightly-1" }), [spec("alpha")]);
    upper.release();
    const before = rowCounts(instance);

    const lower = storeFor(instance).store;
    // Not "namespace-occupied": Nightly-1: is not nightly-1:'s namespace.
    await lower.project(makeCtx({ runId: "nightly-1" }), [spec("beta")]);
    await lower.teardown(untriggered({ runId: "nightly-1" }));

    assert.deepEqual(rowCounts(instance), before);
    assert.deepEqual(
      instance.tables.all("sys_atf_test").map((row) => row.name),
      ["Nightly-1:alpha"],
    );
    assert.deepEqual(
      instance.tables.all("sys_atf_test_suite").map((row) => row.name),
      ["Nightly-1:suite"],
    );
  });
});

describe("unsafe run ids (fix 2026-09-25)", () => {
  for (const runId of ["a^b", "a=b", "a@b", "a\nb", "a\rb", "", "r^ORname=x"]) {
    test(`refuses ${JSON.stringify(runId)} before any request`, async () => {
      const instance = makeInstance();
      const { store, client } = storeFor(instance);
      await assert.rejects(
        store.project(makeCtx({ runId }), [spec("alpha")]),
        refusal("unsafe-run-id"),
      );
      await assert.rejects(
        store.teardown(untriggered({ runId })),
        refusal("unsafe-run-id"),
      );
      assert.equal(client.calls.length, 0);
      assert.equal(fs.existsSync(lock.lockPath), false);
    });
  }
});
