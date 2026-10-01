// Wave 14 — the opt-in `omitTotalCount`: list reads without X-Total-Count.
//
// `@tessera/sn-client` never sends `sysparm_no_count`, so its fetchAll
// "no X-Total-Count" path is only reachable through the stateful fake when
// the fake itself can drop the header. Default behaviour must not move.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "../build/index.js";

const rows = () =>
  Array.from({ length: 5 }, (_, i) => ({
    sys_id: String(i + 1).padStart(32, "0"),
    name: `row-${i}`,
    restricted: i === 1 ? "true" : "false",
  }));

const list = (fake, params = {}, path = "/api/now/table/t") =>
  fake.handle({ method: "GET", path, params });

describe("omitTotalCount (wave 14, opt-in)", () => {
  it("is off by default: every list read carries X-Total-Count", async () => {
    const fake = createFakeInstance({ state: { t: rows() } });
    const res = await list(fake, { sysparm_limit: "2" });
    assert.equal(res.body.result.length, 2);
    assert.equal(res.headers["x-total-count"], "5");
  });

  it("default: sysparm_no_count=true still drops the header per request", async () => {
    const fake = createFakeInstance({ state: { t: rows() } });
    const res = await list(fake, { sysparm_no_count: "true" });
    assert.equal(res.body.result.length, 5);
    assert.equal(res.headers["x-total-count"], undefined);
  });

  it("when on, list reads never carry X-Total-Count; paging is unchanged", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      omitTotalCount: true,
    });
    const first = await list(fake, { sysparm_limit: "2" });
    const second = await list(fake, {
      sysparm_limit: "2",
      sysparm_offset: "2",
    });
    const last = await list(fake, {
      sysparm_limit: "2",
      sysparm_offset: "4",
    });
    assert.deepEqual(
      [first, second, last].map((res) => res.body.result.length),
      [2, 2, 1],
    );
    for (const res of [first, second, last]) {
      assert.equal(res.status, 200);
      assert.equal(res.headers["x-total-count"], undefined);
    }
    // sysparm_no_count=false cannot bring the header back.
    const forced = await list(fake, { sysparm_no_count: "false" });
    assert.equal(forced.headers["x-total-count"], undefined);
  });

  it("applies to the Import Set path and to the fetch adapter", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      omitTotalCount: true,
    });
    const viaImport = await list(fake, {}, "/api/now/import/t");
    assert.equal(viaImport.status, 200);
    assert.equal(viaImport.headers["x-total-count"], undefined);

    const res = await fake.fetch(
      "https://fake-instance.service-now.com/api/now/table/t?sysparm_limit=2",
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-total-count"), null);
    assert.equal((await res.json()).result.length, 2);
  });

  it("composes with readAcl: a hidden row shortens the page and nothing reports it", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      omitTotalCount: true,
      readAcl: {
        rules: [{ table: "t", when: (row) => row["restricted"] === "true" }],
      },
    });
    const res = await list(fake, { sysparm_limit: "2" });
    assert.deepEqual(
      res.body.result.map((row) => row.name),
      ["row-0"],
    );
    assert.equal(res.headers["x-total-count"], undefined);
  });

  it("single-record reads and writes are unaffected", async () => {
    const fake = createFakeInstance({
      state: { t: rows() },
      omitTotalCount: true,
    });
    const one = await fake.handle({
      method: "GET",
      path: `/api/now/table/t/${"1".padStart(32, "0")}`,
    });
    assert.equal(one.status, 200);
    assert.equal(one.body.result.name, "row-0");
    const created = await fake.handle({
      method: "POST",
      path: "/api/now/table/t",
      body: { name: "new" },
    });
    assert.equal(created.status, 201);
  });
});
