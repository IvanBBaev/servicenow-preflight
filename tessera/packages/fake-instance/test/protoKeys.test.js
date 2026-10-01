// W6a L1 + L2 — prototype-named keys and malformed percent-encoding.
//
// L1: a field or table literally named after an Object.prototype member
// (`constructor`, `toString`, `__proto__`) must behave like any other name —
// never throw, never match through inheritance, never vanish silently.
// L2: a path segment that is not valid percent-encoding answers a 400 in the
// ServiceNow error shape instead of throwing a URIError out of `handle`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createFakeInstance,
  fixtureToSeed,
  matchQuery,
  parseQuery,
  projectFields,
  sortRecords,
} from "../build/index.js";

const A = "a".repeat(32);
const B = "b".repeat(32);

describe("prototype-named fields (L1)", () => {
  const record = { sys_id: A, name: "x" };

  it("a LIKE on `constructor` does not throw and matches nothing", () => {
    assert.equal(matchQuery(record, parseQuery("constructorLIKEx")), false);
  });

  it("ISNOTEMPTY on `toString` does not match through inheritance", () => {
    assert.equal(matchQuery(record, parseQuery("toStringISNOTEMPTY")), false);
    assert.equal(matchQuery(record, parseQuery("toStringISEMPTY")), true);
  });

  it("sorting on an inherited name treats it as empty", () => {
    const rows = [
      { sys_id: "2", name: "b" },
      { sys_id: "1", name: "a" },
    ];
    assert.deepEqual(
      sortRecords(rows, [{ field: "constructor", direction: "asc" }]).map(
        (row) => row.sys_id,
      ),
      ["2", "1"],
    );
  });

  it("projection never copies an inherited member", () => {
    const out = projectFields(record, [
      "sys_id",
      "constructor",
      "toString",
      "__proto__",
    ]);
    assert.deepEqual(Object.keys(out), ["sys_id"]);
    assert.equal(Object.hasOwn(out, "constructor"), false);
  });

  it("the Table API survives the r1/r2 repro queries", async () => {
    const fake = createFakeInstance({
      state: { t: [{ sys_id: A, name: "x" }] },
    });
    for (const unknownQueryField of ["ignore", "no-rows", "legacy-empty"]) {
      const strict = createFakeInstance({
        state: { t: [{ sys_id: A, name: "x" }] },
        unknownQueryField,
      });
      const res = await strict.handle({
        method: "GET",
        path: "/api/now/table/t",
        params: { sysparm_query: "constructorLIKEx" },
      });
      assert.equal(res.status, 200, unknownQueryField);
    }
    const legacy = createFakeInstance({
      state: { t: [{ sys_id: A, name: "x" }] },
      unknownQueryField: "legacy-empty",
    });
    const notEmpty = await legacy.handle({
      method: "GET",
      path: "/api/now/table/t",
      params: { sysparm_query: "toStringISNOTEMPTY" },
    });
    assert.equal(notEmpty.body.result.length, 0);
    const projected = await fake.handle({
      method: "GET",
      path: "/api/now/table/t",
      params: { sysparm_fields: "sys_id,constructor,__proto__,toString" },
    });
    assert.deepEqual(Object.keys(projected.body.result[0]), ["sys_id"]);
  });
});

describe("a `__proto__` table (L1)", () => {
  it("state seeded under `__proto__` is stored and served, not crashed on", async () => {
    const fake = createFakeInstance({
      state: JSON.parse(`{"__proto__":[{"sys_id":"${B}","name":"p"}],"u":[]}`),
    });
    const res = await fake.handle({
      method: "GET",
      path: "/api/now/table/__proto__",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.result.map((row) => row.sys_id),
      [B],
    );
    fake.reset();
    assert.equal(fake.tables.count("__proto__"), 1);
  });

  it("tables.snapshot() keeps a `__proto__` table as an own key", () => {
    const fake = createFakeInstance({
      state: JSON.parse(`{"__proto__":[{"sys_id":"${B}"}]}`),
    });
    const snap = fake.tables.snapshot();
    assert.equal(Object.hasOwn(snap, "__proto__"), true);
    assert.deepEqual(
      snap["__proto__"].map((row) => row.sys_id),
      [B],
    );
    assert.equal(Object.getPrototypeOf(snap), Object.prototype);
  });

  it("fixtureToSeed keeps a `__proto__` table as an own key", () => {
    const seed = fixtureToSeed({
      version: 1,
      tables: JSON.parse(`{"__proto__":[{"sys_id":"${B}"}]}`),
      exchanges: [
        {
          path: "/api/now/table/__proto__",
          body: { result: [{ sys_id: A }] },
        },
      ],
    });
    assert.equal(Object.hasOwn(seed.tables, "__proto__"), true);
    assert.deepEqual(
      seed.tables["__proto__"].map((row) => row.sys_id),
      [B, A],
    );
    assert.equal(Object.getPrototypeOf(seed.tables), Object.prototype);
  });

  it("a fixture bundle with a `__proto__` table seeds the instance", async () => {
    const fake = createFakeInstance({
      fixture: `{"version":1,"tables":{"__proto__":[{"sys_id":"${B}"}]}}`,
    });
    assert.equal(fake.tables.count("__proto__"), 1);
  });

  it("POST/GET/DELETE round-trip on a `__proto__` table", async () => {
    const fake = createFakeInstance();
    const created = await fake.handle({
      method: "POST",
      path: "/api/now/table/__proto__",
      body: { name: "n" },
    });
    assert.equal(created.status, 201);
    const sysId = created.body.result.sys_id;
    const got = await fake.handle({
      method: "GET",
      path: `/api/now/table/__proto__/${sysId}`,
    });
    assert.equal(got.body.result.name, "n");
    const gone = await fake.handle({
      method: "DELETE",
      path: `/api/now/table/__proto__/${sysId}`,
    });
    assert.equal(gone.status, 204);
    assert.equal({}.name, undefined);
  });
});

describe("malformed percent-encoding (L2)", () => {
  const paths = [
    "/api/now/table/%E0%A4%A",
    "/api/now/table/t/%E0%A4%A",
    "/api/now/v2/table/%ZZ",
    "/api/sn_cicd/progress/%E0%A4%A",
  ];

  for (const path of paths) {
    it(`answers 400 in the ServiceNow error shape for ${path}`, async () => {
      const fake = createFakeInstance();
      const res = await fake.handle({ method: "GET", path });
      assert.equal(res.status, 400);
      assert.equal(res.body.status, "failure");
      assert.match(res.body.error.message, /invalid|malformed/i);
      assert.match(res.body.error.detail, /percent-encoding/i);
      assert.equal(fake.requests().at(-1).status, 400);
    });
  }

  it("also answers 400 through the fetch adapter", async () => {
    const fake = createFakeInstance();
    const res = await fake.fetch("/api/now/table/%E0%A4%A");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.status, "failure");
  });

  it("fixtureToSeed reports a malformed exchange path instead of throwing", () => {
    const seed = fixtureToSeed({
      version: 1,
      exchanges: [
        { path: "/api/now/table/%E0%A4%A", body: { result: [{ sys_id: A }] } },
      ],
    });
    assert.deepEqual(seed.tables, {});
    assert.equal(seed.ignored.length, 1);
    assert.match(seed.ignored[0].reason, /percent-encoding/);
  });
});
