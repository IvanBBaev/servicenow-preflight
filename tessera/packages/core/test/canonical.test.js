import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, sha256Hex, specKey } from "../build/index.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it("preserves array order (arrays are positional, not sets)", () => {
    assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  });

  it("sorts keys inside array elements", () => {
    assert.equal(canonicalJson([{ z: 1, a: 2 }]), '[{"a":2,"z":1}]');
  });

  it("drops undefined object entries like JSON.stringify does", () => {
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  });

  it("is insensitive to source key insertion order", () => {
    const one = { x: 1, y: [{ k: 1, j: 2 }] };
    const two = { y: [{ j: 2, k: 1 }], x: 1 };
    assert.equal(canonicalJson(one), canonicalJson(two));
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of the empty string", () => {
    assert.equal(
      sha256Hex(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("specKey", () => {
  it("joins id and path with a NUL separator (collision-free)", () => {
    assert.equal(specKey({ id: "a", path: "b" }), "a\u0000b");
    // Without NUL these two would collide on a naive join.
    assert.notEqual(
      specKey({ id: "a-b", path: "c" }),
      specKey({ id: "a", path: "b-c" }),
    );
  });
});
