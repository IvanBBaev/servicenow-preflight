import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeSnClient } from "../../build/http/fake.js";
import {
  applyEncodedQuery,
  FakeQueryError,
  parseEncodedQuery,
} from "../../build/http/fake-query.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");

const read = (row, field) => String(row[field] ?? "");

const ROWS = [
  { id: "1", a: "1", b: "2", name: "Alpha", at: "2026-10-29 11:59:30" },
  { id: "2", a: "1", b: "3", name: "beta", at: "2026-10-29 11:00:00" },
  { id: "3", a: "2", b: "2", name: "Alpine", at: "2026-10-29 10:59:59" },
  { id: "4", a: "2", b: "4", name: "", at: "" },
];

/** The ids `query` selects from `ROWS`, in result order. */
function ids(query, rows = ROWS) {
  return applyEncodedQuery(query, rows, read, NOW)
    .map((r) => r.id)
    .join(",");
}

// Hand-verified against ServiceNow's documented encoded-query grammar.
const CASES = [
  ["=", "a=1", "1,2"],
  ["= on a case-different value", "name=ALPHA", "1"],
  ["= against the empty value", "name=", "4"],
  ["!=", "a!=1", "3,4"],
  ["!= leaves an empty value out", "name!=Alpha", "2,3"],
  ["!= keeps empties only when asked", "name!=Alpha^ORnameISEMPTY", "2,3,4"],
  ["IN", "bIN3,4", "2,4"],
  ["IN on a case-different value", "nameINalpha,BETA", "1,2"],
  ["STARTSWITH", "nameSTARTSWITHal", "1,3"],
  ["LIKE", "nameLIKEPH", "1"],
  ["ISEMPTY", "nameISEMPTY", "4"],
  ["ISNOTEMPTY", "nameISNOTEMPTY", "1,2,3"],
  ["RELATIVEGE by minute", "atRELATIVEGE@minute@ago@60", "1,2"],
  ["RELATIVEGE by hour", "atRELATIVEGE@hour@ago@1", "1,2"],
  ["RELATIVEGE by day", "atRELATIVEGE@day@ago@1", "1,2,3"],
  ["^ intersects", "a=1^b=2", "1"],
  ["^OR unions two terms", "a=1^ORb=4", "1,2,4"],
  ["^OR binds tighter than ^", "a=1^b=2^ORb=3", "1,2"],
  ["^OR on the left of ^", "b=3^ORb=4^a=2", "4"],
  ["^NQ adds a whole query", "a=1^b=2^NQa=2^b=4", "1,4"],
  ["^NQ binds looser than ^OR", "a=1^b=4^ORb=3^NQb=2", "1,2,3"],
  ["^EQ ends the query", "a=1^EQ", "1,2"],
  ["ORDERBY alone keeps every row", "ORDERBYb", "1,3,2,4"],
  ["ORDERBY after a filter", "a=2^ORDERBYb", "3,4"],
  ["ORDERBYDESC", "a=1^ORDERBYDESCb", "2,1"],
  ["a later key breaks ties", "ORDERBYa^ORDERBYDESCb", "2,1,4,3"],
  ["ORDERBY then ^EQ", "ORDERBYDESCb^EQ", "4,2,1,3"],
];

for (const [name, query, expected] of CASES) {
  test(`encoded query: ${name} (${query})`, () => {
    assert.equal(ids(query), expected);
  });
}

test("a field without a seeded value reads empty, so it matches no filter", () => {
  assert.equal(ids("missing=1"), "");
  assert.equal(ids("missing!=1"), "");
  assert.equal(ids("missingISEMPTY"), "1,2,3,4");
});

test("parseEncodedQuery keeps the three precedence levels apart", () => {
  const { branches, order } = parseEncodedQuery(
    "a=1^b=2^ORc=3^NQd=4^ORDERBYDESCe",
  );
  assert.deepEqual(
    branches.map((groups) => groups.map((g) => g.map((t) => t.field))),
    [[["a"], ["b", "c"]], [["d"]]],
  );
  assert.deepEqual(order, [{ field: "e", descending: true }]);
});

const UNSUPPORTED = [
  ["an unknown operator", "aNOT INb"],
  ["a comparison the model lacks", "a>1"],
  ["a bare field", "active"],
  ["an upper-case field", "Active=true"],
  ["an empty term", "a=1^^b=2"],
  ["an empty query branch", "a=1^NQ"],
  ["a leading ^OR", "ORa=1"],
  ["an ISEMPTY with a value", "aISEMPTYx"],
  ["an ISNOTEMPTY with a value", "aISNOTEMPTYx"],
  ["an unknown relative unit", "aRELATIVEGE@week@ago@1"],
  ["a future relative date", "aRELATIVEGE@day@ahead@1"],
];

for (const [name, query] of UNSUPPORTED) {
  test(`encoded query: ${name} throws (${query})`, () => {
    assert.throws(
      () => applyEncodedQuery(query, ROWS, read, NOW),
      (err) => err instanceof FakeQueryError && err.message.includes(query),
    );
  });
}

// --- through the fake -------------------------------------------------------

test("the fake selects rows by sysparm_query before it pages", async () => {
  const http = createFakeSnClient({
    tables: {
      t: [
        { sys_id: "a", active: "false" },
        { sys_id: "b", active: "true" },
        { sys_id: "c", active: "true" },
      ],
    },
  });
  const rows = await http.table("t").query({
    sysparm_query: "active=true",
    sysparm_limit: "1",
  });
  assert.deepEqual(
    rows.map((r) => r.sys_id),
    ["b"],
  );
});

test("the fake compares a reference by its value and a boolean as a string", async () => {
  const http = createFakeSnClient({
    tables: {
      t: [
        { sys_id: "a", sys_scope: { link: "x", value: "s1" }, active: true },
        { sys_id: "b", sys_scope: "s2", active: false },
      ],
    },
  });
  const read = (query) => http.table("t").query({ sysparm_query: query });
  assert.equal((await read("sys_scope=s1"))[0].sys_id, "a");
  assert.equal((await read("sys_scope=s2"))[0].sys_id, "b");
  assert.equal((await read("active=true"))[0].sys_id, "a");
});

test("the fake raises FakeQueryError on a query it cannot model", () => {
  const http = createFakeSnClient({ tables: { t: [{ sys_id: "a" }] } });
  assert.throws(
    () => http.table("t").query({ sysparm_query: "a>1" }),
    FakeQueryError,
  );
});

test("the fake resolves relative dates against the now fixture", async () => {
  const http = createFakeSnClient({
    tables: { t: [{ sys_id: "a", sys_updated_on: "2026-10-29 11:30:00" }] },
    now: new Date(NOW),
  });
  const rows = (minutes) =>
    http.table("t").query({
      sysparm_query: `sys_updated_onRELATIVEGE@minute@ago@${minutes}`,
    });
  assert.equal((await rows(31)).length, 1);
  assert.equal((await rows(29)).length, 0);
});

test("queryFilter injects a fault on the rows the query already selected", async () => {
  const seen = [];
  const http = createFakeSnClient({
    tables: {
      t: [
        { sys_id: "a", active: "false" },
        { sys_id: "b", active: "true" },
      ],
    },
    queryFilter(_table, rows) {
      seen.push(...rows.map((r) => r.sys_id));
      return [];
    },
  });
  const rows = await http.table("t").query({ sysparm_query: "active=true" });
  assert.deepEqual(seen, ["b"]);
  assert.deepEqual(rows, []);
});
