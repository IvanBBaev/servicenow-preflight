// Wave 16 — the Aggregate (Stats) API count: `GET /api/now/stats/<table>`
// with `sysparm_count=true`, as `@tessera/sn-client`'s `countRows` sends it.
//
// Only the count is modelled. Every other Stats request keeps the
// record-level 404 the router answers for unmodelled `/api/now/` resources.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "../build/index.js";

const rows = () =>
  Array.from({ length: 5 }, (_, i) => ({
    sys_id: String(i + 1).padStart(32, "0"),
    name: `row-${i}`,
    active: i < 3 ? "true" : "false",
    restricted: i === 1 ? "true" : "false",
  }));

const hideRestricted = {
  rules: [{ table: "t", when: (row) => row.restricted === "true" }],
};

const stats = (
  fake,
  params = { sysparm_count: "true" },
  path = "/api/now/stats/t",
) => fake.handle({ method: "GET", path, params });

describe("Stats API count (wave 16)", () => {
  it("answers the real shape: result.stats.count as a STRING", async () => {
    const fake = createFakeInstance({ state: { t: rows() } });
    const res = await stats(fake);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { result: { stats: { count: "5" } } });
    assert.equal(res.headers["x-total-count"], undefined);
  });

  it("filters with sysparm_query through the fake's query engine", async () => {
    const fake = createFakeInstance({ state: { t: rows() } });
    const res = await stats(fake, {
      sysparm_count: "true",
      sysparm_query: "active=true^ORDERBYsys_id",
    });
    assert.deepEqual(res.body, { result: { stats: { count: "3" } } });
  });

  it("counts an unknown table as zero, like an empty list read", async () => {
    const fake = createFakeInstance({ state: { t: rows() } });
    const res = await stats(
      fake,
      { sysparm_count: "true" },
      "/api/now/stats/nope",
    );
    assert.deepEqual(res.body, { result: { stats: { count: "0" } } });
  });

  it("routes the versioned path too", async () => {
    const fake = createFakeInstance({ state: { t: rows() } });
    const res = await stats(
      fake,
      { sysparm_count: "true" },
      "/api/now/v1/stats/t",
    );
    assert.deepEqual(res.body, { result: { stats: { count: "5" } } });
  });

  it("default: the count sees read-ACL-hidden rows (assumption, unverified live)", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      readAcl: hideRestricted,
    });
    const res = await stats(fake);
    assert.deepEqual(res.body, { result: { stats: { count: "5" } } });
  });

  it("opt-in statsCount.aclFiltered: the count excludes read-ACL-hidden rows", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      readAcl: hideRestricted,
      statsCount: { aclFiltered: true },
    });
    const res = await stats(fake);
    assert.deepEqual(res.body, { result: { stats: { count: "4" } } });
    // Without a read-ACL model there is nothing to filter.
    const open = createFakeInstance({
      state: { t: rows() },
      statsCount: { aclFiltered: true },
    });
    assert.deepEqual((await stats(open)).body, {
      result: { stats: { count: "5" } },
    });
  });

  for (const [fault, expected] of [
    ["non-numeric-count", { result: { stats: { count: "many" } } }],
    ["missing-count", { result: { stats: {} } }],
    ["numeric-count", { result: { stats: { count: 5 } } }],
  ]) {
    it(`opt-in statsCount.fault "${fault}" corrupts only the stats body`, async () => {
      const fake = createFakeInstance({
        state: { t: rows() },
        statsCount: { fault },
      });
      const res = await stats(fake);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, expected);
      const list = await fake.handle({
        method: "GET",
        path: "/api/now/table/t",
      });
      assert.equal(list.body.result.length, 5);
    });
  }

  it("the fault registry can fail the stats path by prefix", async () => {
    const fake = createFakeInstance({ state: { t: rows() } });
    fake.faults.add({
      match: { path: "/api/now/stats/", times: 1 },
      mode: { kind: "http-error", status: 500 },
    });
    assert.equal((await stats(fake)).status, 500);
    assert.equal((await stats(fake)).status, 200);
  });

  it("logs the stats request", async () => {
    const fake = createFakeInstance({ state: { t: rows() } });
    await stats(fake);
    assert.deepEqual(fake.requests(), [
      {
        method: "GET",
        path: "/api/now/stats/t",
        params: { sysparm_count: "true" },
        status: 200,
      },
    ]);
  });

  describe("everything else on /api/now/stats stays unmodelled", () => {
    for (const [label, params] of [
      ["no sysparm_count", {}],
      ["sysparm_count=false", { sysparm_count: "false" }],
      ["a group_by", { sysparm_count: "true", sysparm_group_by: "active" }],
      ["an avg field", { sysparm_count: "true", sysparm_avg_fields: "x" }],
      [
        "a having clause",
        { sysparm_count: "true", sysparm_having: "count^>^1" },
      ],
    ]) {
      it(`${label} → record-level 404`, async () => {
        const fake = createFakeInstance({ state: { t: rows() } });
        const res = await stats(fake, params);
        assert.equal(res.status, 404);
        assert.match(res.body.error.message, /No Record found/i);
      });
    }

    it("a non-GET → 405", async () => {
      const fake = createFakeInstance({ state: { t: rows() } });
      const res = await fake.handle({
        method: "POST",
        path: "/api/now/stats/t",
        params: { sysparm_count: "true" },
        body: {},
      });
      assert.equal(res.status, 405);
    });

    it("a nested sub-path → record-level 404", async () => {
      const fake = createFakeInstance({ state: { t: rows() } });
      const res = await stats(
        fake,
        { sysparm_count: "true" },
        "/api/now/stats/t/x",
      );
      assert.equal(res.status, 404);
    });
  });
});
