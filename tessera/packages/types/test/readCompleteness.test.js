// incompleteRead — the one fail-closed completeness rule for bounded reads,
// shared by @tessera/doctor and @tessera/phase05 (wave 15).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  incompletePropertyRead,
  incompleteRead,
  PROPERTY_READ_LIMIT,
  PROPERTY_ROW_LIMIT,
  SYS_PROPERTIES_TABLE,
} from "../build/index.js";

function read(returned, total) {
  return incompleteRead({
    table: "sys_properties",
    what: "p",
    returned,
    total,
    rowLimit: 10,
  });
}

describe("incompleteRead", () => {
  for (const [returned, total] of [
    [0, undefined],
    [0, 0],
    [1, 1],
    [10, undefined],
    [10, 10],
    [3, 2],
  ]) {
    it(`${returned} rows with X-Total-Count ${String(total)} are complete`, () => {
      assert.equal(read(returned, total), undefined);
    });
  }

  it("more rows than the limit are incomplete, with or without a count", () => {
    assert.equal(
      read(11, undefined),
      "sys_properties read for p matched more than 10 rows (the instance sent no X-Total-Count); only 10 are compared, so a row past them could disagree unseen",
    );
    assert.match(read(11, 11), /\(X-Total-Count reports 11\)/);
    assert.match(read(11, 3), /\(X-Total-Count reports 3\)/);
  });

  it("fewer rows than X-Total-Count is a short read", () => {
    assert.equal(
      read(10, 11),
      "sys_properties read for p came back short: X-Total-Count reports 11 matching rows but only 10 were returned (rows removed by read ACLs, or an inconsistent count; raising SN_MAX_RECORDS will not help)",
    );
  });

  it("zero rows under a positive X-Total-Count is a short read, not an absence", () => {
    assert.match(
      read(0, 1),
      /came back short: X-Total-Count reports 1 matching rows but only 0 were returned/,
    );
    assert.match(read(0, 40), /reports 40 matching rows but only 0/);
  });

  it("the row limit is the caller's", () => {
    const at = (returned, rowLimit) =>
      incompleteRead({
        table: "t",
        what: "w",
        returned,
        total: undefined,
        rowLimit,
      });
    assert.equal(at(1, 1), undefined);
    assert.match(at(2, 1), /^t read for w matched more than 1 rows/);
  });
});

// The sys_properties binding of the rule (wave 16). @tessera/doctor and
// @tessera/phase05 each used to declare their own row limit, read limit and
// table-bound wrapper; they now re-export these, so there is one of each.
describe("incompletePropertyRead and the property read limits", () => {
  it("compares ten rows and reads exactly one more", () => {
    assert.equal(PROPERTY_ROW_LIMIT, 10);
    assert.equal(PROPERTY_READ_LIMIT, 11);
    assert.equal(PROPERTY_READ_LIMIT, PROPERTY_ROW_LIMIT + 1);
  });

  it("names the sys_properties table", () => {
    assert.equal(SYS_PROPERTIES_TABLE, "sys_properties");
  });

  it("is incompleteRead bound to sys_properties and the property row limit", () => {
    for (const [returned, total] of [
      [0, undefined],
      [0, 3],
      [PROPERTY_ROW_LIMIT, undefined],
      [PROPERTY_ROW_LIMIT, PROPERTY_ROW_LIMIT + 1],
      [PROPERTY_READ_LIMIT, undefined],
      [PROPERTY_READ_LIMIT, 40],
    ]) {
      assert.equal(
        incompletePropertyRead("some.prop", returned, total),
        incompleteRead({
          table: "sys_properties",
          what: "some.prop",
          returned,
          total,
          rowLimit: 10,
        }),
        `${returned} rows, X-Total-Count ${String(total)}`,
      );
    }
  });

  it("the read limit row is the one that proves overflow", () => {
    assert.equal(
      incompletePropertyRead("p", PROPERTY_ROW_LIMIT, undefined),
      undefined,
    );
    assert.equal(
      incompletePropertyRead("p", PROPERTY_READ_LIMIT, undefined),
      "sys_properties read for p matched more than 10 rows (the instance sent no X-Total-Count); only 10 are compared, so a row past them could disagree unseen",
    );
  });
});
