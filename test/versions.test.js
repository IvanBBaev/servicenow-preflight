import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVersion, compareVersions } from "../build/versions.js";

// The module was extracted verbatim from the scoped-app-deps check (CC-43) so
// the check and the sync/drift promote gate (OPP-5) compare versions with
// identical semantics. These tests pin that shared behavior directly.

// --- parseVersion ------------------------------------------------------------

test("parseVersion splits a dot-separated version into numeric segments", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("10"), [10]);
  assert.deepEqual(parseVersion("0.0.1"), [0, 0, 1]);
});

test("parseVersion tolerates whitespace around segments", () => {
  assert.deepEqual(parseVersion(" 1 . 2 "), [1, 2]);
});

test("parseVersion returns null for a non-numeric segment (CC-43)", () => {
  assert.equal(parseVersion("Madrid"), null);
  assert.equal(parseVersion("1.2b"), null);
  assert.equal(parseVersion("1.-2"), null);
});

test("parseVersion returns null for empty or degenerate input", () => {
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("1..2"), null);
  assert.equal(parseVersion("."), null);
});

// --- compareVersions ---------------------------------------------------------

test("compareVersions orders plain numeric versions", () => {
  assert.ok(compareVersions("1.2.3", "1.2.4") < 0);
  assert.ok(compareVersions("2.0.0", "1.9.9") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("compareVersions compares numerically, not lexically", () => {
  // Lexically "1.10.0" < "1.9.0"; numerically it is greater.
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
});

test("compareVersions zero-pads shorter versions", () => {
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.ok(compareVersions("1.2", "1.2.1") < 0);
  assert.ok(compareVersions("1.2.1", "1.2") > 0);
});

test("compareVersions returns null when either side cannot be parsed (CC-43)", () => {
  assert.equal(compareVersions("Madrid", "1.0.0"), null);
  assert.equal(compareVersions("1.0.0", "Madrid"), null);
  assert.equal(compareVersions("", "1.0.0"), null);
});
