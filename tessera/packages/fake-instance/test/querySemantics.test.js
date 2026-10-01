// W6a M1 + L3 — the fake's query semantics against a real instance's.
//
// M1: a condition on a field the table does not have. A real instance never
// answers 400 for it: it drops the term (so the term matches every row), or —
// with `glide.invalid_query.returns_no_rows=true` — answers zero rows.
// L3: `=`/`IN` case-insensitivity and `!=` vs. empty values, both opt-in.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UNKNOWN_QUERY_FIELD,
  applyUnknownFieldPolicy,
  createFakeInstance,
  matchQuery,
  parseQuery,
} from "../build/index.js";

const S = "s".repeat(32);
const T = "t".repeat(32);

const seedRows = () => ({
  sys_update_set: [
    { sys_id: "a".repeat(32), name: "US-1", story: S },
    { sys_id: "b".repeat(32), name: "US-2", story: T },
    { sys_id: "c".repeat(32), name: "us-3", story: "" },
  ],
});

const list = async (fake, query, table = "sys_update_set") => {
  const res = await fake.handle({
    method: "GET",
    path: `/api/now/table/${table}`,
    params: { sysparm_query: query },
  });
  return {
    status: res.status,
    total: res.headers["x-total-count"],
    names: res.body.result.map((row) => row.name),
  };
};

describe("unknownQueryField (M1)", () => {
  // Delegated decision 2026-09-26: the default is a real instance's — an
  // unknown term is dropped, so the query answers as if unfiltered.
  it("defaults to 'ignore', as a real instance does", async () => {
    assert.equal(DEFAULT_UNKNOWN_QUERY_FIELD, "ignore");
    const fake = createFakeInstance({ state: seedRows() });
    const res = await list(fake, `stroy=${S}`);
    assert.equal(res.status, 200);
    assert.equal(res.total, "3");
    assert.deepEqual(res.names, ["US-1", "US-2", "us-3"]);
  });

  it("'ignore': a term on an unknown field matches every row", async () => {
    const fake = createFakeInstance({
      state: seedRows(),
      unknownQueryField: "ignore",
    });
    const res = await list(fake, `stroy=${S}`);
    assert.equal(res.status, 200);
    assert.equal(res.total, "3");
    assert.deepEqual(res.names, ["US-1", "US-2", "us-3"]);
  });

  it("'ignore' drops only the unknown term; the known terms still filter", async () => {
    const fake = createFakeInstance({
      state: seedRows(),
      unknownQueryField: "ignore",
    });
    assert.deepEqual((await list(fake, `stroy=${S}^name=US-2`)).names, [
      "US-2",
    ]);
    // An unknown alternative inside an OR term is dropped from that term.
    assert.deepEqual((await list(fake, `name=US-1^ORbogus=x`)).names, ["US-1"]);
  });

  it("'no-rows' answers an empty page (glide.invalid_query.returns_no_rows)", async () => {
    const fake = createFakeInstance({
      state: seedRows(),
      unknownQueryField: "no-rows",
    });
    const res = await list(fake, `stroy=${S}^name=US-2`);
    assert.equal(res.status, 200);
    assert.equal(res.total, "0");
    assert.deepEqual(res.names, []);
    // A query naming only known fields is unaffected.
    assert.deepEqual((await list(fake, "name=US-2")).names, ["US-2"]);
  });

  it("'legacy-empty' keeps the pre-W6a behaviour (unknown field reads as empty)", async () => {
    const fake = createFakeInstance({
      state: seedRows(),
      unknownQueryField: "legacy-empty",
    });
    assert.deepEqual((await list(fake, `stroy=${S}`)).names, []);
    assert.deepEqual((await list(fake, "stroyISEMPTY")).names, [
      "US-1",
      "US-2",
      "us-3",
    ]);
  });

  it("never answers 400 in any mode", async () => {
    for (const mode of ["ignore", "no-rows", "legacy-empty"]) {
      const fake = createFakeInstance({
        state: seedRows(),
        unknownQueryField: mode,
      });
      assert.equal((await list(fake, "nopeLIKEx^ORDERBYnope")).status, 200);
    }
  });

  it("a field set on ANY row of the table is known, even where a row lacks it", async () => {
    const fake = createFakeInstance({
      state: {
        t: [
          { sys_id: "1", name: "a", extra: "x" },
          { sys_id: "2", name: "b" },
        ],
      },
      unknownQueryField: "no-rows",
    });
    assert.deepEqual((await list(fake, "extraISEMPTY", "t")).names, ["b"]);
  });

  it("a field carried only by a later row is still known", async () => {
    const fake = createFakeInstance({
      state: {
        t: [
          { sys_id: "1", name: "a" },
          { sys_id: "2", name: "b" },
          { sys_id: "3", name: "c", extra: "x" },
        ],
      },
      unknownQueryField: "ignore",
    });
    assert.deepEqual((await list(fake, "extra=x", "t")).names, ["c"]);
  });

  it("a declared tableSchema field is known although no row carries it", async () => {
    const fake = createFakeInstance({
      state: { t: [{ sys_id: "1", name: "a" }] },
      tableSchema: { t: ["name", "active"] },
      unknownQueryField: "ignore",
    });
    // `active` is declared, so it filters (empty != true) instead of vanishing.
    assert.deepEqual((await list(fake, "active=true", "t")).names, []);
    assert.deepEqual((await list(fake, "bogus=true", "t")).names, ["a"]);
  });

  it("an inherited Object.prototype name is never a known field", () => {
    const parsed = parseQuery("constructor=x^name=a");
    const resolved = applyUnknownFieldPolicy(
      parsed,
      new Set(["name"]),
      "ignore",
    );
    assert.equal(resolved.groups[0].length, 1);
    assert.equal(resolved.groups[0][0][0].field, "name");
    assert.equal(
      applyUnknownFieldPolicy(parsed, new Set(["name"]), "no-rows"),
      null,
    );
  });
});

describe("caseInsensitiveEquals (L3, r1 B)", () => {
  it("is off by default: = and IN compare exactly", async () => {
    const fake = createFakeInstance({ state: seedRows() });
    assert.deepEqual((await list(fake, "name=us-1")).names, []);
    assert.deepEqual((await list(fake, "nameINus-1,us-2")).names, []);
  });

  it("when on, = / != / IN / NOT IN fold case like a real instance", async () => {
    const fake = createFakeInstance({
      state: seedRows(),
      caseInsensitiveEquals: true,
    });
    assert.deepEqual((await list(fake, "name=us-1")).names, ["US-1"]);
    assert.deepEqual((await list(fake, "nameINus-1,US-3")).names, [
      "US-1",
      "us-3",
    ]);
    assert.deepEqual((await list(fake, "name!=us-1")).names, ["US-2", "us-3"]);
    assert.deepEqual((await list(fake, "nameNOT INus-1,us-2")).names, ["us-3"]);
  });

  it("is honoured by matchQuery directly", () => {
    const record = { sys_id: "x", name: "ABC" };
    assert.equal(matchQuery(record, parseQuery("name=abc")), false);
    assert.equal(
      matchQuery(record, parseQuery("name=abc"), {
        caseInsensitiveEquals: true,
      }),
      true,
    );
  });
});

describe("notEqualsExcludesEmpty (L3, r1 C — plausible, opt-in)", () => {
  it("is off by default: != matches empty values", async () => {
    const fake = createFakeInstance({ state: seedRows() });
    assert.deepEqual((await list(fake, `story!=${S}`)).names, ["US-2", "us-3"]);
  });

  it("when on, != excludes rows whose value is empty", async () => {
    const fake = createFakeInstance({
      state: seedRows(),
      notEqualsExcludesEmpty: true,
    });
    assert.deepEqual((await list(fake, `story!=${S}`)).names, ["US-2"]);
  });
});
