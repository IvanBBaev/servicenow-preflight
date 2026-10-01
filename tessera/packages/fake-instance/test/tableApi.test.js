// QA-18 — the Table API request surface, in the exact shape
// `@tessera/sn-client`'s `api/table.ts` + `core/http.ts` speak.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "../build/index.js";

let fake;
beforeEach(() => {
  fake = createFakeInstance({
    state: {
      sys_atf_test: [
        { sys_id: "aaa1", name: "tessera-RUN1 alpha", active: "true" },
        { sys_id: "aaa2", name: "tessera-RUN1 beta", active: "false" },
        { sys_id: "aaa3", name: "persistent gamma", active: "true" },
      ],
    },
  });
});

const get = (path, params) => fake.handle({ method: "GET", path, params });

/** Verbatim from `@tessera/sn-client`'s api/plugin.ts — the wording that marks
 * a whole REST namespace (and therefore its backing plugin) absent. */
const NAMESPACE_404 = /does not represent any resource|invalid uri/i;

describe("GET list", () => {
  it("answers { result: rows } with X-Total-Count", async () => {
    const res = await get("/api/now/table/sys_atf_test");
    assert.equal(res.status, 200);
    assert.equal(res.body.result.length, 3);
    assert.equal(res.headers["x-total-count"], "3");
    assert.equal(res.headers["content-type"], "application/json");
  });

  it("applies sysparm_query", async () => {
    const res = await get("/api/now/table/sys_atf_test", {
      sysparm_query: "nameSTARTSWITHtessera-RUN1",
    });
    assert.equal(res.body.result.length, 2);
    assert.equal(res.headers["x-total-count"], "2");
  });

  it("applies sysparm_limit/sysparm_offset and still totals the full match", async () => {
    const res = await get("/api/now/table/sys_atf_test", {
      sysparm_limit: "1",
      sysparm_offset: "2",
    });
    assert.equal(res.body.result.length, 1);
    assert.equal(res.body.result[0].sys_id, "aaa3");
    // X-Total-Count is the pre-paging count, which is what fetchAll relies on.
    assert.equal(res.headers["x-total-count"], "3");
  });

  it("omits X-Total-Count under sysparm_no_count, as a real instance does", async () => {
    // `sysparm_no_count=true` suppresses the count query on a real instance and
    // the header goes with it. sn-client's fetchAll branches on exactly that
    // (api/table.ts: `total !== undefined ? records.length < total : hitCap`),
    // so while the fake always sends the header that fallback is unreachable
    // and every `truncated` assertion is measuring one half of the contract.
    const counted = await get("/api/now/table/sys_atf_test");
    assert.equal(counted.headers["x-total-count"], "3");

    const res = await get("/api/now/table/sys_atf_test", {
      sysparm_no_count: "true",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.length, 3);
    assert.equal(
      Object.keys(res.headers).includes("x-total-count"),
      false,
      "the header must be absent, not zero or empty",
    );
  });

  it("projects sysparm_fields", async () => {
    const res = await get("/api/now/table/sys_atf_test", {
      sysparm_fields: "sys_id,name",
    });
    assert.deepEqual(Object.keys(res.body.result[0]), ["sys_id", "name"]);
  });

  it("accepts a query string baked into the path", async () => {
    const res = await get("/api/now/table/sys_atf_test?sysparm_limit=2");
    assert.equal(res.body.result.length, 2);
  });

  it("serves the fetchAll paging loop to exhaustion", async () => {
    // api/table.ts appends ^ORDERBYsys_id and stops on a short page.
    const pages = [];
    for (let offset = 0; ; offset += 2) {
      const res = await get("/api/now/table/sys_atf_test", {
        sysparm_query: "^ORDERBYsys_id",
        sysparm_limit: "2",
        sysparm_offset: String(offset),
      });
      pages.push(res.body.result);
      if (res.body.result.length < 2) break;
    }
    assert.deepEqual(
      pages.map((page) => page.length),
      [2, 1],
    );
    assert.deepEqual(
      pages.flat().map((row) => row.sys_id),
      ["aaa1", "aaa2", "aaa3"],
    );
  });

  it("returns an empty page for an unknown table rather than a 404", async () => {
    const res = await get("/api/now/table/nope");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, []);
  });
});

describe("GET record", () => {
  it("returns the single row", async () => {
    const res = await get("/api/now/table/sys_atf_test/aaa2");
    assert.equal(res.status, 200);
    assert.equal(res.body.result.name, "tessera-RUN1 beta");
  });

  it("404s with the record-level body, not the namespace body", async () => {
    const res = await get("/api/now/table/sys_atf_test/missing");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.message, "No Record found");
    assert.equal(res.body.status, "failure");
  });
});

describe("POST", () => {
  it("creates a row, returns 201 and the generated sys_id", async () => {
    const res = await fake.handle({
      method: "POST",
      path: "/api/now/table/sys_atf_test",
      body: { name: "tessera-RUN2 delta" },
    });
    assert.equal(res.status, 201);
    assert.match(res.body.result.sys_id, /^[0-9a-f]{32}$/);
    // The write is visible to the next read: state, not replay.
    const after = await get(
      `/api/now/table/sys_atf_test/${res.body.result.sys_id}`,
    );
    assert.equal(after.body.result.name, "tessera-RUN2 delta");
    assert.equal(
      (await get("/api/now/table/sys_atf_test")).body.result.length,
      4,
    );
  });

  it("rejects a non-object body", async () => {
    const res = await fake.handle({
      method: "POST",
      path: "/api/now/table/sys_atf_test",
      body: "nope",
    });
    assert.equal(res.status, 400);
  });

  it("405s when aimed at a record path", async () => {
    const res = await fake.handle({
      method: "POST",
      path: "/api/now/table/sys_atf_test/aaa1",
      body: {},
    });
    assert.equal(res.status, 405);
  });
});

describe("PATCH / PUT", () => {
  for (const method of ["PATCH", "PUT"]) {
    it(`${method} updates the row`, async () => {
      const res = await fake.handle({
        method,
        path: "/api/now/table/sys_atf_test/aaa1",
        body: { active: "false" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.result.active, "false");
      assert.equal(res.body.result.name, "tessera-RUN1 alpha");
      assert.equal(fake.tables.get("sys_atf_test", "aaa1").active, "false");
    });

    it(`${method} 404s on an absent row`, async () => {
      const res = await fake.handle({
        method,
        path: "/api/now/table/sys_atf_test/missing",
        body: { active: "false" },
      });
      assert.equal(res.status, 404);
    });

    it(`${method} 405s without a sys_id`, async () => {
      const res = await fake.handle({
        method,
        path: "/api/now/table/sys_atf_test",
        body: {},
      });
      assert.equal(res.status, 405);
    });
  }
});

describe("DELETE", () => {
  it("removes the row and answers 204 with no body", async () => {
    const res = await fake.handle({
      method: "DELETE",
      path: "/api/now/table/sys_atf_test/aaa1",
    });
    assert.equal(res.status, 204);
    assert.equal(res.body, undefined);
    assert.equal(fake.tables.get("sys_atf_test", "aaa1"), undefined);
  });

  it("404s on a second delete", async () => {
    await fake.handle({
      method: "DELETE",
      path: "/api/now/table/sys_atf_test/aaa1",
    });
    const res = await fake.handle({
      method: "DELETE",
      path: "/api/now/table/sys_atf_test/aaa1",
    });
    assert.equal(res.status, 404);
  });

  it("405s without a sys_id", async () => {
    const res = await fake.handle({
      method: "DELETE",
      path: "/api/now/table/sys_atf_test",
    });
    assert.equal(res.status, 405);
  });
});

describe("routing", () => {
  it("serves the import set path with the same table semantics", async () => {
    const res = await fake.handle({
      method: "POST",
      path: "/api/now/import/u_imp_test",
      body: { u_name: "row" },
    });
    assert.equal(res.status, 201);
    assert.equal(fake.tables.count("u_imp_test"), 1);
  });

  it("url-decodes the table and sys_id segments", async () => {
    fake.tables.insert("weird table", {}, "id 1");
    const res = await get("/api/now/table/weird%20table/id%201");
    assert.equal(res.status, 200);
  });

  it("never reports the core /api/now namespace as absent", async () => {
    // The Aggregate API is core REST — sn-client's api/aggregate.ts calls
    // /api/now/stats/<table>. The fake models only its count (wave 16,
    // `sysparm_count=true`); this request sends none, so it is unmodelled —
    // and answering an unmodelled /api/now path with
    // the namespace-404 wording would assert that /api/now itself is missing:
    // impossible on a real instance, cached by api/plugin.ts as "the plugin is
    // inactive" for five minutes, and read by doctor's probe as proof the API
    // is absent. Assert against the classifier the consumers actually use.
    const res = await get("/api/now/stats/sys_atf_test");
    assert.equal(res.status, 404);
    for (const field of ["message", "detail"]) {
      assert.equal(
        NAMESPACE_404.test(String(res.body.error[field])),
        false,
        `error.${field} claimed the /api/now namespace does not exist`,
      );
    }
  });

  it("answers an unknown namespace with the namespace-404 wording", async () => {
    const res = await get("/api/sn_devops/whatever");
    assert.equal(res.status, 404);
    // api/plugin.ts keys "plugin inactive" on exactly this phrasing.
    assert.match(res.body.error.message, /does not represent any resource/i);
  });

  it("logs every request it served", async () => {
    await get("/api/now/table/sys_atf_test", { sysparm_limit: "1" });
    await fake.handle({
      method: "POST",
      path: "/api/now/table/sys_atf_test",
      body: { name: "x" },
    });
    const log = fake.requests();
    assert.equal(log.length, 2);
    assert.deepEqual(log[0], {
      method: "GET",
      path: "/api/now/table/sys_atf_test",
      params: { sysparm_limit: "1" },
      status: 200,
    });
    assert.equal(log[1].status, 201);
    assert.deepEqual(log[1].body, { name: "x" });
  });
});
