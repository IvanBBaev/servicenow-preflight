// QA-18 / PLAN Phase 0.5 — recorded fixtures seed the initial state, but the
// fake (not replay) answers writes. The loader is JSON in, state out.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  createFakeInstance,
  fixtureToSeed,
  parseFixtureBundle,
  readFixtureFile,
} from "../build/index.js";

const SHIPPED = join(import.meta.dirname, "..", "fixtures", "tier2-seed.json");

const bundle = (extra) => ({ version: 1, ...extra });

describe("parseFixtureBundle", () => {
  it("accepts an object and an equivalent JSON string", () => {
    const asObject = bundle({ name: "b", tables: { t: [] } });
    assert.deepEqual(parseFixtureBundle(asObject), asObject);
    assert.deepEqual(parseFixtureBundle(JSON.stringify(asObject)), asObject);
  });

  it("rejects a non-object", () => {
    assert.throws(() => parseFixtureBundle(null), /must be a JSON object/);
    assert.throws(() => parseFixtureBundle("[]"), /must be a JSON object/);
    assert.throws(() => parseFixtureBundle(42), /must be a JSON object/);
  });

  it("rejects an unsupported version", () => {
    assert.throws(
      () => parseFixtureBundle({ version: 2 }),
      /unsupported fixture bundle version/,
    );
    assert.throws(() => parseFixtureBundle({}), /unsupported fixture bundle/);
  });

  it("rejects malformed tables and exchanges", () => {
    assert.throws(
      () => parseFixtureBundle(bundle({ tables: [] })),
      /'tables' must be an object of arrays/,
    );
    assert.throws(
      () => parseFixtureBundle(bundle({ tables: { t: {} } })),
      /table "t" must be an array/,
    );
    assert.throws(
      () => parseFixtureBundle(bundle({ exchanges: {} })),
      /'exchanges' must be an array/,
    );
  });
});

describe("fixtureToSeed", () => {
  it("takes `tables` entries verbatim", () => {
    const seed = fixtureToSeed(
      bundle({ tables: { sys_user: [{ sys_id: "u1", user_name: "a" }] } }),
    );
    assert.deepEqual(seed.tables.sys_user, [{ sys_id: "u1", user_name: "a" }]);
    assert.deepEqual(seed.ignored, []);
  });

  it("harvests rows out of recorded Table API reads", () => {
    const seed = fixtureToSeed(
      bundle({
        exchanges: [
          {
            method: "GET",
            path: "/api/now/table/sys_atf_test",
            status: 200,
            body: { result: [{ sys_id: "t1" }, { sys_id: "t2" }] },
          },
          {
            path: "/api/now/table/sys_atf_test/t3",
            body: { result: { sys_id: "t3" } },
          },
        ],
      }),
    );
    assert.deepEqual(
      seed.tables.sys_atf_test.map((row) => row.sys_id),
      ["t1", "t2", "t3"],
    );
    assert.deepEqual(seed.ignored, []);
  });

  it("ignores recorded writes, errors, non-table paths and resultless bodies", () => {
    const seed = fixtureToSeed(
      bundle({
        exchanges: [
          { method: "POST", path: "/api/now/table/sys_atf_test", body: {} },
          { path: "/api/now/table/sys_atf_test", status: 404, body: {} },
          {
            path: "/api/sn_cicd/progress/x",
            body: { result: { status: "2" } },
          },
          { path: "/api/now/table/sys_atf_test", body: { nope: true } },
        ],
      }),
    );
    assert.deepEqual(seed.tables, {});
    assert.deepEqual(
      seed.ignored.map((entry) => entry.reason),
      [
        "recorded POST is not replayed (QA-18: the fake answers writes)",
        "non-2xx status 404",
        "not a Table API path",
        "body has no 'result'",
      ],
    );
  });

  it("dedups by sys_id, later capture wins", () => {
    const seed = fixtureToSeed(
      bundle({
        tables: { t: [{ sys_id: "x", v: "old" }] },
        exchanges: [
          {
            path: "/api/now/table/t",
            body: { result: [{ sys_id: "x", v: "new" }] },
          },
        ],
      }),
    );
    assert.deepEqual(seed.tables.t, [{ sys_id: "x", v: "new" }]);
  });

  it("keeps sys_id-less rows apart instead of collapsing them", () => {
    const seed = fixtureToSeed(
      bundle({ tables: { t: [{ v: "a" }, { v: "b" }] } }),
    );
    assert.equal(seed.tables.t.length, 2);
  });
});

describe("readFixtureFile", () => {
  it("loads and validates the shipped Tier-2 seed", async () => {
    const shipped = await readFixtureFile(SHIPPED);
    assert.equal(shipped.version, 1);
    assert.equal(shipped.name, "tier2-seed");
    // The placeholder must keep saying so until a live capture replaces it.
    assert.match(shipped.description, /No live capture exists yet/i);
  });

  it("rejects a file that is not a valid bundle", async () => {
    await assert.rejects(
      readFixtureFile(join(import.meta.dirname, "..", "package.json")),
      /unsupported fixture bundle version/,
    );
  });
});

describe("seeding an instance", () => {
  it("boots from the shipped fixture, harvesting reads and skipping writes", async () => {
    const fixture = await readFixtureFile(SHIPPED);
    const fake = createFakeInstance({ fixture });

    assert.equal(fake.tables.count("sys_atf_test_suite"), 1);
    assert.equal(fake.tables.count("sys_atf_test"), 1);
    assert.equal(fake.tables.count("sys_user"), 1);
    // Harvested out of the two recorded GETs.
    assert.equal(fake.tables.count("sys_properties"), 1);
    assert.equal(fake.tables.count("sys_atf_test_suite_test"), 1);
    // The recorded POST response is NOT replayed into state.
    assert.equal(
      fake.tables.get("sys_atf_test", "0000000000000000000000000000fff1"),
      undefined,
    );

    const res = await fake.handle({
      method: "GET",
      path: "/api/now/table/sys_properties",
      params: { sysparm_query: "name=sn_atf.runner.enabled" },
    });
    assert.equal(res.body.result[0].value, "true");
  });

  it("accepts a JSON string fixture and reports what it ignored", () => {
    const fake = createFakeInstance({ state: { t: [{ v: "pre" }] } });
    const seed = fake.seedFrom(
      JSON.stringify(
        bundle({
          tables: { t: [{ sys_id: "s1", v: "seeded" }] },
          exchanges: [{ method: "DELETE", path: "/api/now/table/t/s9" }],
        }),
      ),
    );
    assert.deepEqual(Object.keys(seed.tables), ["t"]);
    assert.equal(seed.ignored.length, 1);
    assert.equal(fake.tables.count("t"), 2);
    assert.equal(fake.tables.get("t", "s1").v, "seeded");
  });

  it("throws on a bad fixture instead of booting an empty instance", () => {
    assert.throws(
      () => createFakeInstance({ fixture: { version: 99 } }),
      /unsupported fixture bundle version/,
    );
  });

  it("reset() restores exactly the seeded state", async () => {
    const fake = createFakeInstance({
      state: { sys_atf_test: [{ sys_id: "aaa1", name: "persistent" }] },
    });
    const before = fake.tables.snapshot();

    await fake.handle({
      method: "POST",
      path: "/api/now/table/sys_atf_test",
      body: { name: "tessera-RUN1 ephemeral" },
    });
    await fake.handle({
      method: "DELETE",
      path: "/api/now/table/sys_atf_test/aaa1",
    });
    fake.faults.add({ match: {}, mode: { kind: "hang", ms: 1 } });

    fake.reset();

    assert.deepEqual(fake.tables.snapshot(), before);
    assert.deepEqual(fake.faults.list(), []);
    assert.deepEqual(fake.requests(), []);
    assert.deepEqual(fake.cicd.runs(), []);

    // Ids and the clock restart too, so a replay produces identical bytes.
    const replay = await fake.handle({
      method: "POST",
      path: "/api/now/table/sys_atf_test",
      body: { name: "tessera-RUN1 ephemeral" },
    });
    const other = createFakeInstance({
      state: { sys_atf_test: [{ sys_id: "aaa1", name: "persistent" }] },
    });
    const fresh = await other.handle({
      method: "POST",
      path: "/api/now/table/sys_atf_test",
      body: { name: "tessera-RUN1 ephemeral" },
    });
    assert.deepEqual(replay.body.result, fresh.body.result);
  });
});
