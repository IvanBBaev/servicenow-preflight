// QA-18 — the store is *stateful*: reads must reflect prior writes, deletes
// must mutate. These are the properties a response replayer cannot have.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TABLE_LIMIT,
  createIdGenerator,
  createLogicalClock,
  createTableStore,
} from "../build/index.js";

let store;
beforeEach(() => {
  store = createTableStore({
    ids: createIdGenerator("tier2"),
    clock: createLogicalClock(),
  });
});

describe("create", () => {
  it("mints a sys_id and stores the row", () => {
    const created = store.insert("sys_atf_test", { name: "alpha" });
    assert.match(created.sys_id, /^[0-9a-f]{32}$/);
    assert.equal(store.get("sys_atf_test", created.sys_id).name, "alpha");
    assert.equal(store.count("sys_atf_test"), 1);
  });

  it("stamps the audit fields from the logical clock", () => {
    const created = store.insert("t", { name: "a" });
    assert.equal(created.sys_created_on, "2020-01-01 00:00:00");
    assert.equal(created.sys_updated_on, "2020-01-01 00:00:00");
    assert.equal(created.sys_mod_count, "0");
  });

  it("coerces every field to a string, like the real Table API", () => {
    const created = store.insert("t", {
      active: true,
      order: 100,
      nothing: null,
      nested: { a: 1 },
    });
    assert.equal(created.active, "true");
    assert.equal(created.order, "100");
    assert.equal(created.nothing, "");
    assert.equal(created.nested, '{"a":1}');
  });

  it("honours a caller-supplied sys_id (fixtures replay real ids)", () => {
    const explicit = "0000000000000000000000000000aaa1";
    assert.equal(store.insert("t", { sys_id: explicit }).sys_id, explicit);
    assert.equal(store.insert("t", {}, explicit + "x").sys_id, explicit + "x");
  });

  it("is reproducible: same seed, same call order, same ids", () => {
    const other = createTableStore({
      ids: createIdGenerator("tier2"),
      clock: createLogicalClock(),
    });
    const a = [store.insert("t", {}).sys_id, store.insert("t", {}).sys_id];
    const b = [other.insert("t", {}).sys_id, other.insert("t", {}).sys_id];
    assert.deepEqual(a, b);
  });

  it("keeps an unencodable value visible instead of storing an empty field", () => {
    // JSON.stringify refuses a cycle and answers undefined for a function or a
    // symbol. Coercing any of those to "" would make a caller's mistake
    // indistinguishable from a null field: a fault reported as data, and the
    // opposite of what the coercion note promises ("keep visible ... not
    // silently lose").
    const cyclic = { name: "loop" };
    cyclic.self = cyclic;
    const row = store.insert("t", {
      cyclic,
      fn: () => 1,
      sym: Symbol("marker"),
      genuinelyEmpty: null,
    });
    assert.equal(row.genuinelyEmpty, "");
    assert.notEqual(row.cyclic, "");
    assert.notEqual(row.fn, "");
    assert.notEqual(row.sym, "");
    assert.match(row.sym, /marker/);
  });

  it("returns a copy, so a caller cannot mutate the store in place", () => {
    const created = store.insert("t", { name: "a" });
    created.name = "tampered";
    assert.equal(store.get("t", created.sys_id).name, "a");
  });
});

describe("read", () => {
  it("returns undefined for an absent row", () => {
    assert.equal(store.get("t", "missing"), undefined);
    assert.equal(store.get("never-seen-table", "x"), undefined);
  });
});

describe("update", () => {
  it("mutates the stored row and bumps sys_mod_count", () => {
    const created = store.insert("t", { name: "a", keep: "yes" });
    const updated = store.update("t", created.sys_id, { name: "b" });
    assert.equal(updated.name, "b");
    assert.equal(updated.keep, "yes");
    assert.equal(updated.sys_mod_count, "1");
    assert.equal(store.get("t", created.sys_id).name, "b");
  });

  it("keeps sys_created_on and advances sys_updated_on", () => {
    const created = store.insert("t", {});
    const updated = store.update("t", created.sys_id, { x: "1" });
    assert.equal(updated.sys_created_on, created.sys_created_on);
    assert.notEqual(updated.sys_updated_on, created.sys_updated_on);
  });

  it("ignores every reserved field carried in an update body", () => {
    // The neighbouring test patches an unrelated field, so it cannot falsify
    // the claim in its own name. This one supplies the reserved fields: a real
    // instance drops sys_created_on / sys_updated_on / sys_mod_count out of a
    // PATCH body (they are platform-owned) and echoes the stored values back.
    // If the fake is the kinder of the two, a consumer can steer an audit stamp
    // here that no instance would let it steer, and nothing goes red.
    const created = store.insert("t", { name: "a" });
    const forged = "1999-01-01 00:00:00";
    const updated = store.update("t", created.sys_id, {
      name: "b",
      sys_created_on: forged,
      sys_updated_on: forged,
      sys_mod_count: "999",
    });
    assert.equal(updated.name, "b");
    assert.equal(updated.sys_created_on, created.sys_created_on);
    assert.notEqual(updated.sys_updated_on, forged);
    assert.equal(updated.sys_mod_count, "1");
    // The stored row, not just the echoed copy.
    const stored = store.get("t", created.sys_id);
    assert.equal(stored.sys_created_on, created.sys_created_on);
    assert.notEqual(stored.sys_updated_on, forged);
    assert.equal(stored.sys_mod_count, "1");
  });

  it("ignores an attempt to change sys_id", () => {
    const created = store.insert("t", {});
    const updated = store.update("t", created.sys_id, { sys_id: "hijack" });
    assert.equal(updated.sys_id, created.sys_id);
    assert.equal(store.get("t", "hijack"), undefined);
  });

  it("returns undefined for an absent row", () => {
    assert.equal(store.update("t", "missing", { a: "1" }), undefined);
  });
});

describe("delete", () => {
  it("removes the row so later reads no longer see it", () => {
    const created = store.insert("t", { name: "a" });
    assert.equal(store.remove("t", created.sys_id), true);
    assert.equal(store.get("t", created.sys_id), undefined);
    assert.equal(store.query("t").total, 0);
  });

  it("is idempotent: a second delete reports 'already gone'", () => {
    const created = store.insert("t", {});
    store.remove("t", created.sys_id);
    assert.equal(store.remove("t", created.sys_id), false);
  });
});

describe("query", () => {
  beforeEach(() => {
    store.insert("sys_atf_test", { name: "tessera-RUN1 a", active: true });
    store.insert("sys_atf_test", { name: "tessera-RUN1 b", active: false });
    store.insert("sys_atf_test", { name: "persistent suite", active: true });
  });

  it("reflects every prior write", () => {
    assert.equal(store.query("sys_atf_test").total, 3);
    store.insert("sys_atf_test", { name: "fresh" });
    assert.equal(store.query("sys_atf_test").total, 4);
  });

  it("filters on an encoded query", () => {
    const found = store.query("sys_atf_test", {
      query: "nameSTARTSWITHtessera-RUN1",
    });
    assert.equal(found.total, 2);
  });

  it("filters on a coerced boolean", () => {
    assert.equal(
      store.query("sys_atf_test", { query: "active=true" }).total,
      2,
    );
  });

  it("reports total before paging and pages with limit/offset", () => {
    const page = store.query("sys_atf_test", { limit: 2, offset: 1 });
    assert.equal(page.total, 3);
    assert.equal(page.records.length, 2);
    assert.equal(page.records[0].name, "tessera-RUN1 b");
  });

  it("projects sysparm_fields", () => {
    const page = store.query("sys_atf_test", { fields: ["name", "nope"] });
    assert.deepEqual(Object.keys(page.records[0]), ["name"]);
  });

  it("sorts by ORDERBY", () => {
    const page = store.query("sys_atf_test", { query: "ORDERBYname" });
    assert.equal(page.records[0].name, "persistent suite");
  });

  it("defaults to a generous page size", () => {
    assert.ok(DEFAULT_TABLE_LIMIT >= 1000);
    assert.equal(store.query("sys_atf_test").records.length, 3);
  });

  it("returns an empty page for an unknown table", () => {
    assert.deepEqual(store.query("nope"), { records: [], total: 0 });
  });
});

describe("bulk state", () => {
  it("seeds rows, preserving supplied sys_ids", () => {
    store.seed({
      sys_atf_test: [{ sys_id: "aaa", name: "a" }, { name: "b" }],
      sys_user: [{ user_name: "runner" }],
    });
    assert.equal(store.count("sys_atf_test"), 2);
    assert.equal(store.get("sys_atf_test", "aaa").name, "a");
    assert.deepEqual(store.tables(), ["sys_atf_test", "sys_user"]);
  });

  it("snapshots and clears", () => {
    store.insert("t", { name: "a" });
    const snapshot = store.snapshot();
    assert.equal(snapshot.t.length, 1);
    snapshot.t[0].name = "tampered";
    assert.equal(store.all("t")[0].name, "a");
    store.clear();
    assert.deepEqual(store.tables(), []);
  });

  it("hides emptied tables from tables()", () => {
    const created = store.insert("t", {});
    store.remove("t", created.sys_id);
    assert.deepEqual(store.tables(), []);
  });
});

describe("run-id scoping (DESIGN 4b sweep criteria)", () => {
  beforeEach(() => {
    store.insert("sys_atf_test", { name: "tessera-RUN_DEAD test", x: "1" });
    store.insert("sys_atf_test_suite", { name: "tessera-RUN_DEAD suite" });
    store.insert("sys_atf_test_suite_test", { run_id: "RUN_DEAD" });
    store.insert("sys_atf_test_suite", { name: "persistent suite" });
    store.insert("sys_atf_test", { name: "tessera-RUN_LIVE test" });
  });

  it("finds every row tagged with a run id, by field value or name prefix", () => {
    const hits = store.recordsForRun("RUN_DEAD");
    assert.equal(hits.length, 3);
    assert.deepEqual([...new Set(hits.map((hit) => hit.table))].sort(), [
      "sys_atf_test",
      "sys_atf_test_suite",
      "sys_atf_test_suite_test",
    ]);
  });

  it("leaves the persistent suite and a live run's rows untouched", () => {
    for (const hit of store.recordsForRun("RUN_DEAD")) {
      store.remove(hit.table, hit.record.sys_id);
    }
    assert.equal(store.recordsForRun("RUN_DEAD").length, 0);
    assert.equal(store.recordsForRun("RUN_LIVE").length, 1);
    assert.equal(
      store.query("sys_atf_test_suite", { query: "name=persistent suite" })
        .total,
      1,
    );
  });

  it("refuses a blank run id instead of reporting the sweep clean", () => {
    // "" is a substring of every field of every row, so [] is not a truthful
    // answer to `recordsForRun("")` — it is the §4b pass criterion ("zero
    // records matching the dead run-id") succeeding because nobody set the run
    // id. The helper must decline the question rather than green-light a sweep
    // it never performed.
    for (const blank of ["", "   ", undefined, null]) {
      assert.throws(
        () => store.recordsForRun(blank),
        /non-empty run id/,
        `recordsForRun(${JSON.stringify(blank)}) must not answer`,
      );
    }
    // ...and it still answers a real one.
    assert.equal(store.recordsForRun("RUN_DEAD").length, 3);
  });

  it("supports an arbitrary predicate", () => {
    const hits = store.find((record, table) => table === "sys_atf_test");
    assert.equal(hits.length, 2);
  });
});
