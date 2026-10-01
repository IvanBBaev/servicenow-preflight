// `describeReadTruncation` — the public wording of a partial `TableRead`.
//
// Exported so every consumer of the RecordReader port (the resolvers here,
// `@tessera/impact`'s where-used search) words a truncated read through one
// helper instead of re-adapting sn-client's `describeTruncation` locally. The
// contract held here is that the two agree byte for byte on every case, and
// that a frozen (readonly) record array is accepted without being touched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { tableApi } from "@tessera/sn-client";

import { describeReadTruncation } from "../build/index.js";

const rows = (n) =>
  Object.freeze(Array.from({ length: n }, (_, i) => ({ sys_id: `r${i}` })));

describe("describeReadTruncation", () => {
  const cases = [
    {
      name: "cap",
      read: { records: rows(3), total: 10, truncationReason: "cap" },
    },
    {
      name: "short-page",
      read: { records: rows(2), total: 5, truncationReason: "short-page" },
    },
    {
      name: "no-total",
      read: {
        records: rows(4),
        total: undefined,
        truncationReason: "no-total",
      },
    },
    {
      name: "short-page-no-total",
      read: {
        records: rows(3),
        total: undefined,
        truncationReason: "short-page-no-total",
      },
    },
    {
      name: "probe-failed",
      read: {
        records: rows(3),
        total: undefined,
        truncationReason: "probe-failed",
      },
    },
    {
      name: "count-mismatch",
      read: {
        records: rows(2),
        total: undefined,
        count: 5,
        truncationReason: "count-mismatch",
      },
    },
    {
      name: "count-unavailable",
      read: {
        records: rows(2),
        total: undefined,
        truncationReason: "count-unavailable",
      },
    },
    {
      name: "reason-less",
      read: { records: rows(1), total: undefined, truncationReason: undefined },
    },
  ];

  for (const { name, read } of cases) {
    it(`matches sn-client's describeTruncation for the ${name} case`, () => {
      const expected = tableApi.describeTruncation({
        records: [...read.records],
        total: read.total,
        truncationReason: read.truncationReason,
        count: read.count,
      });
      assert.equal(describeReadTruncation(read), expected);
    });
  }

  it("names the counts it was given", () => {
    const clause = describeReadTruncation({
      records: rows(3),
      total: 10,
      truncationReason: "cap",
    });
    assert.match(clause, /3 of 10 matching rows read/);
    assert.match(clause, /^hit the SN_MAX_RECORDS cap/);
  });

  it("an unknown total is shown as '?', never as a number", () => {
    const clause = describeReadTruncation({
      records: rows(2),
      total: undefined,
      truncationReason: "short-page",
    });
    assert.match(clause, /reports \? matching rows but only 2 were returned/);
  });

  // Wave 17: the two Stats API cross-check reasons, worded honestly.
  it("count-mismatch quotes the Stats API count against the rows read", () => {
    const clause = describeReadTruncation({
      records: rows(2),
      total: undefined,
      count: 5,
      truncationReason: "count-mismatch",
    });
    assert.match(
      clause,
      /^came back inconsistent: no X-Total-Count, and the Stats API counts 5 matching rows but only 2 were returned/,
    );
    assert.match(clause, /raising SN_MAX_RECORDS will not help/);
  });

  it("count-mismatch without a count shows '?', never a number", () => {
    const clause = describeReadTruncation({
      records: rows(2),
      total: undefined,
      truncationReason: "count-mismatch",
    });
    assert.match(clause, /Stats API counts \? matching rows but only 2/);
  });

  it("count-unavailable says the end of results is unproven", () => {
    const clause = describeReadTruncation({
      records: rows(4),
      total: undefined,
      truncationReason: "count-unavailable",
    });
    assert.match(
      clause,
      /^returned 4 rows with no X-Total-Count, and the Stats API count that would confirm the end of results could not be obtained, so more rows may exist$/,
    );
  });

  // Fail closed on a reason this package has not reviewed: a stub, an older
  // or newer adapter handing over a string outside `TruncationReason` is still
  // worded as partial, with no guessed cause and no borrowed wording.
  for (const reason of [
    "some-future-reason",
    "cap ",
    "toString",
    "__proto__",
  ]) {
    it(`an unreviewed reason ${JSON.stringify(reason)} is worded as partial`, () => {
      const clause = describeReadTruncation({
        records: rows(3),
        total: 7,
        count: 9,
        truncationReason: reason,
      });
      assert.equal(clause, "stopped before the full result set (3 rows read)");
    });
  }

  it("reads a frozen record array without mutating it", () => {
    const records = rows(2);
    describeReadTruncation({ records, total: 9, truncationReason: "cap" });
    assert.equal(records.length, 2);
    assert.ok(Object.isFrozen(records));
  });

  it("is exported from the package entry point as a function", () => {
    assert.equal(typeof describeReadTruncation, "function");
  });
});
