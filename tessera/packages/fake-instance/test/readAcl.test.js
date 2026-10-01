// W6a L3 — opt-in read-ACL simulation.
//
// A real instance evaluates row read ACLs AFTER the database page is fetched:
// the denied rows are dropped from that page, yet `X-Total-Count` still
// reports every matching row. A field read ACL leaves the row but blanks the
// field. This is what `@tessera/sn-client`'s `fetchAll` truncation logic
// (api/table.ts) has to survive, so the fake must be able to produce it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "../build/index.js";

const rows = () =>
  Array.from({ length: 5 }, (_, i) => ({
    sys_id: `r${i}`,
    name: `row-${i}`,
    secret: `s${i}`,
    restricted: i % 2 === 1 ? "true" : "false",
  }));

const list = (fake, params = {}) =>
  fake.handle({ method: "GET", path: "/api/now/table/t", params });

describe("readAcl (L3)", () => {
  it("is off by default: every row and field is readable", async () => {
    const fake = createFakeInstance({ state: { t: rows() } });
    const res = await list(fake);
    assert.equal(res.body.result.length, 5);
    assert.equal(res.body.result[1].secret, "s1");
  });

  it("a hidden row shortens the page while X-Total-Count keeps the full count", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      readAcl: {
        rules: [{ table: "t", when: (row) => row["restricted"] === "true" }],
      },
    });
    const res = await list(fake, { sysparm_limit: "4", sysparm_offset: "0" });
    assert.equal(res.status, 200);
    // Page 0..3 holds r0-r3; r1 and r3 are ACL-denied.
    assert.deepEqual(
      res.body.result.map((row) => row.sys_id),
      ["r0", "r2"],
    );
    assert.equal(res.headers["x-total-count"], "5");

    const next = await list(fake, { sysparm_limit: "4", sysparm_offset: "4" });
    assert.deepEqual(
      next.body.result.map((row) => row.sys_id),
      ["r4"],
    );
    assert.equal(next.headers["x-total-count"], "5");
  });

  it("a hidden row reads as 404 by sys_id", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      readAcl: {
        rules: [{ table: "t", when: (row) => row["sys_id"] === "r1" }],
      },
    });
    const res = await fake.handle({
      method: "GET",
      path: "/api/now/table/t/r1",
    });
    assert.equal(res.status, 404);
    const visible = await fake.handle({
      method: "GET",
      path: "/api/now/table/t/r0",
    });
    assert.equal(visible.status, 200);
  });

  it("a field rule blanks the field but keeps the row", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      readAcl: {
        rules: [
          {
            table: "t",
            fields: ["secret"],
            when: (row) => row["restricted"] === "true",
          },
        ],
      },
    });
    const res = await list(fake);
    assert.equal(res.body.result.length, 5);
    assert.equal(res.headers["x-total-count"], "5");
    assert.equal(res.body.result[0].secret, "s0");
    assert.equal(res.body.result[1].secret, "");
    const one = await fake.handle({
      method: "GET",
      path: "/api/now/table/t/r3",
      params: { sysparm_fields: "sys_id,secret" },
    });
    assert.deepEqual(one.body.result, { sys_id: "r3", secret: "" });
  });

  it("a field rule never invents a column the row does not have", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      readAcl: { rules: [{ table: "t", fields: ["secret", "u_missing"] }] },
    });
    const res = await list(fake);
    assert.equal(res.body.result[0].secret, "");
    assert.equal(Object.hasOwn(res.body.result[0], "u_missing"), false);
  });

  it("the query still filters on the stored value of a blanked field", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      readAcl: { rules: [{ table: "t", fields: ["secret"] }] },
    });
    const res = await list(fake, { sysparm_query: "secret=s2" });
    assert.deepEqual(
      res.body.result.map((row) => [row.sys_id, row.secret]),
      [["r2", ""]],
    );
  });

  it("rules for other tables do not apply", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      readAcl: { rules: [{ table: "other" }] },
    });
    assert.equal((await list(fake)).body.result.length, 5);
  });

  it("the stored state is untouched by read ACLs", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      readAcl: { rules: [{ table: "t", fields: ["secret"] }] },
    });
    await list(fake);
    assert.equal(fake.tables.get("t", "r1").secret, "s1");
  });
});
