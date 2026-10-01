// QA-18 — the encoded-query subset. Sweep scoping (§4a/§4b) is expressed as a
// query, so filtering has to be real rather than a canned response.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { matchQuery, parseQuery, sortRecords } from "../build/index.js";

const row = (fields) => ({ sys_id: "x", ...fields });
const matches = (record, query) => matchQuery(record, parseQuery(query));

describe("parseQuery", () => {
  it("treats an absent or empty query as match-all", () => {
    for (const empty of [undefined, null, "", "   "]) {
      const parsed = parseQuery(empty);
      assert.equal(parsed.groups.length, 0);
      assert.equal(matchQuery(row({ a: "1" }), parsed), true);
    }
  });

  it("splits AND terms on ^", () => {
    const parsed = parseQuery("active=true^name=alpha");
    assert.equal(parsed.groups.length, 1);
    assert.equal(parsed.groups[0].length, 2);
  });

  it("attaches ^OR to the preceding term, not the whole query", () => {
    const parsed = parseQuery("a=1^b=2^ORc=3");
    assert.equal(parsed.groups[0].length, 2);
    assert.equal(parsed.groups[0][1].length, 2);
    assert.equal(matches(row({ a: "1", b: "2" }), "a=1^b=2^ORc=3"), true);
    assert.equal(matches(row({ a: "1", c: "3" }), "a=1^b=2^ORc=3"), true);
    assert.equal(matches(row({ a: "9", c: "3" }), "a=1^b=2^ORc=3"), false);
    assert.equal(matches(row({ a: "1", b: "9" }), "a=1^b=2^ORc=3"), false);
  });

  it("splits top-level alternatives on ^NQ", () => {
    const q = "a=1^b=2^NQc=3";
    assert.equal(parseQuery(q).groups.length, 2);
    assert.equal(matches(row({ a: "1", b: "2" }), q), true);
    assert.equal(matches(row({ c: "3" }), q), true);
    assert.equal(matches(row({ a: "1" }), q), false);
  });

  it("extracts ORDERBY and ORDERBYDESC without treating them as conditions", () => {
    const parsed = parseQuery("active=true^ORDERBYname");
    assert.deepEqual(parsed.sort, [{ field: "name", direction: "asc" }]);
    assert.equal(parsed.groups[0].length, 1);

    const desc = parseQuery("ORDERBYDESCsys_updated_on");
    assert.deepEqual(desc.sort, [
      { field: "sys_updated_on", direction: "desc" },
    ]);
    assert.equal(desc.groups[0].length, 0);
  });

  it("parses the exact query api/table.ts appends for fetchAll", () => {
    const parsed = parseQuery("name=alpha^ORDERBYsys_id");
    assert.deepEqual(parsed.sort, [{ field: "sys_id", direction: "asc" }]);
    assert.equal(parsed.groups[0][0][0].field, "name");
  });

  it("drops unparseable tokens instead of throwing", () => {
    const parsed = parseQuery("garbage^a=1");
    assert.equal(parsed.groups[0].length, 1);
    assert.equal(parsed.groups[0][0][0].field, "a");
  });

  it("prefers the longest operator at the earliest position", () => {
    assert.equal(parseQuery("a!=1").groups[0][0][0].operator, "!=");
    assert.equal(parseQuery("a>=1").groups[0][0][0].operator, ">=");
    assert.equal(parseQuery("aNOT INx,y").groups[0][0][0].operator, "NOT IN");
    assert.equal(parseQuery("aNOT LIKEx").groups[0][0][0].operator, "NOT LIKE");
  });
});

describe("matchCondition semantics", () => {
  const r = row({ name: "Tessera-RUN42", count: "10", empty: "" });

  it("compares = and != exactly (stricter than SN collation, by design)", () => {
    assert.equal(matches(r, "name=Tessera-RUN42"), true);
    assert.equal(matches(r, "name=tessera-run42"), false);
    assert.equal(matches(r, "name!=other"), true);
  });

  it("treats a missing field as empty", () => {
    assert.equal(matches(r, "nope="), true);
    assert.equal(matches(r, "nopeISEMPTY"), true);
    assert.equal(matches(r, "emptyISEMPTY"), true);
    assert.equal(matches(r, "nameISNOTEMPTY"), true);
    assert.equal(matches(r, "nameISEMPTY"), false);
  });

  it("compares numerically when both sides are numbers", () => {
    assert.equal(matches(r, "count>9"), true);
    assert.equal(matches(r, "count>9.5"), true);
    assert.equal(matches(r, "count<100"), true);
    assert.equal(matches(r, "count>=10"), true);
    assert.equal(matches(r, "count<=10"), true);
    assert.equal(matches(r, "count>10"), false);
  });

  it("falls back to lexicographic comparison for non-numbers", () => {
    assert.equal(matches(r, "name>Tessera-RUN41"), true);
    assert.equal(matches(r, "name<Tessera-RUN43"), true);
  });

  it("runs the LIKE family case-insensitively", () => {
    assert.equal(matches(r, "nameLIKErun42"), true);
    assert.equal(matches(r, "nameNOT LIKErun99"), true);
    assert.equal(matches(r, "nameSTARTSWITHtessera-"), true);
    assert.equal(matches(r, "nameENDSWITHrun42"), true);
    assert.equal(matches(r, "nameSTARTSWITHrun"), false);
  });

  it("handles IN and NOT IN", () => {
    assert.equal(matches(r, "countIN9,10,11"), true);
    assert.equal(matches(r, "countIN9,11"), false);
    assert.equal(matches(r, "countNOT IN9,11"), true);
  });

  it("matches everything with ANYTHING", () => {
    assert.equal(matches(r, "nameANYTHING"), true);
  });
});

describe("sortRecords", () => {
  const rows = [
    row({ name: "c", n: "2" }),
    row({ name: "a", n: "10" }),
    row({ name: "b", n: "2" }),
  ];

  it("returns a copy in input order when nothing is sorted", () => {
    const out = sortRecords(rows, []);
    assert.deepEqual(
      out.map((entry) => entry.name),
      ["c", "a", "b"],
    );
    assert.notEqual(out, rows);
  });

  it("sorts ascending and descending", () => {
    assert.deepEqual(
      sortRecords(rows, [{ field: "name", direction: "asc" }]).map(
        (entry) => entry.name,
      ),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      sortRecords(rows, [{ field: "name", direction: "desc" }]).map(
        (entry) => entry.name,
      ),
      ["c", "b", "a"],
    );
  });

  it("is stable on ties and compares numerically", () => {
    assert.deepEqual(
      sortRecords(rows, [{ field: "n", direction: "asc" }]).map(
        (entry) => entry.name,
      ),
      ["c", "b", "a"],
    );
  });
});
