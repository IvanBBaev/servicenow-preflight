// The one place a ServiceNow row's `unknown` fields are narrowed: every shape
// the Table API can return reduces to a string, and anything else is absent —
// never `undefined` smuggled into a sys_id.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readField, requireField, requireSysId } from "../build/index.js";
import { SkeletonInfrastructureError } from "../build/errors.js";

describe("readField", () => {
  it("reads flat strings, numbers and booleans as strings", () => {
    const row = { name: "x", order: 3, active: false };
    assert.equal(readField(row, "name"), "x");
    assert.equal(readField(row, "order"), "3");
    assert.equal(readField(row, "active"), "false");
  });

  it("reduces a { value, link } reference to its value", () => {
    const row = {
      test: { value: "abc", link: "https://i/api/now/table/x/abc" },
    };
    assert.equal(readField(row, "test"), "abc");
  });

  it("is undefined for a missing column, null, or a non-string reference value", () => {
    const row = { none: null, ref: { value: 7 }, obj: { link: "l" } };
    for (const field of ["absent", "none", "ref", "obj"]) {
      assert.equal(readField(row, field), undefined, field);
    }
  });
});

describe("requireField / requireSysId", () => {
  it("returns a usable value", () => {
    assert.equal(requireField({ n: "v" }, "n", "reading"), "v");
    assert.equal(requireSysId({ sys_id: { value: "s1" } }, "reading"), "s1");
  });

  it("refuses a missing or blank value as an infrastructure fault naming the read", () => {
    for (const row of [{}, { sys_id: "" }, { sys_id: { value: 1 } }]) {
      assert.throws(
        () => requireSysId(row, "resolving the suite"),
        (error) =>
          error instanceof SkeletonInfrastructureError &&
          /^resolving the suite: .*"sys_id"/.test(error.message),
      );
    }
  });
});
