// Wave 14 — the documented contract of the two equality opt-ins, as a matrix.
//
// README "Equality semantics opt-ins" states exactly what
// `caseInsensitiveEquals` and `notEqualsExcludesEmpty` change and what they
// leave alone. Every row below is one query; every column one of the four
// on/off combinations. The defaults (both off) are pinned here too, so a
// change that silently flips either default fails this file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance, matchQuery, parseQuery } from "../build/index.js";

const TABLE = "u_matrix";

// `gamma` never carries `tag`: an absent field reads as "" (query.ts
// `fieldValue`), so it must behave exactly like Beta's explicit "".
const rows = () => [
  { sys_id: "1".repeat(32), name: "Alpha", tag: "x" },
  { sys_id: "2".repeat(32), name: "alpha", tag: "X" },
  { sys_id: "3".repeat(32), name: "Beta", tag: "" },
  { sys_id: "4".repeat(32), name: "gamma" },
];
const ALL = ["Alpha", "Beta", "alpha", "gamma"];

const MODES = {
  default: {},
  ci: { caseInsensitiveEquals: true },
  nee: { notEqualsExcludesEmpty: true },
  both: { caseInsensitiveEquals: true, notEqualsExcludesEmpty: true },
};

// query -> expected (sorted) names per mode.
const MATRIX = [
  // caseInsensitiveEquals: = / != / IN / NOT IN
  {
    query: "name=alpha",
    default: ["alpha"],
    ci: ["Alpha", "alpha"],
    nee: ["alpha"],
    both: ["Alpha", "alpha"],
  },
  {
    query: "name!=alpha",
    default: ["Alpha", "Beta", "gamma"],
    ci: ["Beta", "gamma"],
    nee: ["Alpha", "Beta", "gamma"],
    both: ["Beta", "gamma"],
  },
  {
    query: "nameINALPHA,beta",
    default: [],
    ci: ["Alpha", "Beta", "alpha"],
    nee: [],
    both: ["Alpha", "Beta", "alpha"],
  },
  {
    query: "nameNOT INALPHA,beta",
    default: ALL,
    ci: ["gamma"],
    nee: ALL,
    both: ["gamma"],
  },
  // notEqualsExcludesEmpty: != only, explicit "" and absent field alike
  {
    query: "tag!=x",
    default: ["Beta", "alpha", "gamma"],
    ci: ["Beta", "gamma"],
    nee: ["alpha"],
    both: [],
  },
  // ... but NOT IN keeps matching empty values in every mode
  {
    query: "tagNOT INx",
    default: ["Beta", "alpha", "gamma"],
    ci: ["Beta", "gamma"],
    nee: ["Beta", "alpha", "gamma"],
    both: ["Beta", "gamma"],
  },
  // Unaffected operators: identical in every mode.
  { query: "nameLIKEALPH", every: ["Alpha", "alpha"] },
  { query: "nameNOT LIKEALPH", every: ["Beta", "gamma"] },
  { query: "nameSTARTSWITHa", every: ["Alpha", "alpha"] },
  { query: "nameENDSWITHA", every: ["Alpha", "Beta", "alpha", "gamma"] },
  // Ordering compares code units: "alpha" > "B" > "Alpha".
  { query: "name>B", every: ["Beta", "alpha", "gamma"] },
  { query: "tagISEMPTY", every: ["Beta", "gamma"] },
  { query: "tagISNOTEMPTY", every: ["Alpha", "alpha"] },
];

const expected = (row, mode) => row.every ?? row[mode];

async function listNames(fake, query) {
  const res = await fake.handle({
    method: "GET",
    path: `/api/now/table/${TABLE}`,
    params: { sysparm_query: query },
  });
  assert.equal(res.status, 200);
  const names = res.body.result.map((row) => row.name).sort();
  assert.equal(
    res.headers["x-total-count"],
    String(names.length),
    `X-Total-Count agrees with the rows for ${query}`,
  );
  return names;
}

describe("equality opt-ins — documented matrix (wave 14)", () => {
  for (const [mode, options] of Object.entries(MODES)) {
    it(`Table API reads match the README contract with ${mode} semantics`, async () => {
      const fake = createFakeInstance({
        state: { [TABLE]: rows() },
        ...options,
      });
      for (const row of MATRIX) {
        assert.deepEqual(
          await listNames(fake, row.query),
          expected(row, mode),
          `${mode}: ${row.query}`,
        );
      }
    });

    it(`matchQuery agrees with the Table API with ${mode} semantics`, () => {
      for (const row of MATRIX) {
        const parsed = parseQuery(row.query);
        const names = rows()
          .filter((record) => matchQuery(record, parsed, options))
          .map((record) => record.name)
          .sort();
        assert.deepEqual(names, expected(row, mode), `${mode}: ${row.query}`);
      }
    });
  }

  it("the defaults are exact = and inclusive != (both knobs off)", async () => {
    const implicit = createFakeInstance({ state: { [TABLE]: rows() } });
    const explicit = createFakeInstance({
      state: { [TABLE]: rows() },
      caseInsensitiveEquals: false,
      notEqualsExcludesEmpty: false,
    });
    for (const row of MATRIX) {
      assert.deepEqual(
        await listNames(implicit, row.query),
        expected(row, "default"),
        row.query,
      );
      assert.deepEqual(
        await listNames(explicit, row.query),
        await listNames(implicit, row.query),
        row.query,
      );
    }
  });

  it("an API-created row is matched by the same rules as a seeded one", async () => {
    // Semantics live in the store, not in the seeding path.
    const fake = createFakeInstance({ caseInsensitiveEquals: true });
    const created = await fake.handle({
      method: "POST",
      path: `/api/now/table/${TABLE}`,
      body: { name: "Delta", tag: "" },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await listNames(fake, "name=DELTA"), ["Delta"]);
  });
});
