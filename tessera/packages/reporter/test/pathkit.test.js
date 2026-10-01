// `pathkit.ts` — the helpers this package reimplemented when it stopped
// depending on `@tessera/store` (delegated decision 2026-09-23).
//
// Written from the behavioural contract, not ported: the upstream suites these
// replace are GPL-3.0, and copying them would carry the licence back in.
//
// The two groups that matter most are the ones the rest of this package's
// suite CANNOT see. Nothing else here exercises a backslash or a retry, so a
// rewrite of `isUnderPath` as `path.relative` over raw strings, or a
// `withRetry` that gave up after one attempt, would pass every other reporter
// test and ship a containment guard that is silently broken on Windows.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createDirRecursively,
  isSafePathComponent,
  isUnderPath,
  pathExists,
  withRetry,
} from "../build/pathkit.js";

describe("isUnderPath — cross-platform separators (#19)", () => {
  it("treats / and \\ as the same separator in either argument", () => {
    assert.equal(isUnderPath("C:\\work\\src", "C:/work/src/app/x.js"), true);
    assert.equal(isUnderPath("C:/work/src", "C:\\work\\src\\app\\x.js"), true);
    assert.equal(isUnderPath("/work/src", "/work\\src/app\\x.js"), true);
  });

  it("refuses a foreign-separator sibling that shares a string prefix", () => {
    // A string-prefix or path.relative-on-raw-strings rewrite gets this wrong
    // in one direction or the other on a mixed path.
    assert.equal(isUnderPath("C:\\work\\src", "C:/work/srcx/app.js"), false);
    assert.equal(isUnderPath("/work/src", "\\work\\other\\app.js"), false);
  });

  it("ignores trailing and doubled separators of either kind", () => {
    assert.equal(isUnderPath("/work/src/", "/work/src/a"), true);
    assert.equal(isUnderPath("/work//src\\\\", "/work/src//a"), true);
  });

  it("compares by segment, not by string prefix, and case-sensitively", () => {
    assert.equal(isUnderPath("/a/b", "/a/bc"), false);
    assert.equal(isUnderPath("/a/b", "/a/B/c"), false);
    assert.equal(isUnderPath("/a/b/c", "/a/b"), false);
    // A path is under itself; the artifact store excludes equality itself.
    assert.equal(isUnderPath("/a/b", "/a/b"), true);
  });
});

describe("withRetry — bounded constant-delay retry", () => {
  it("succeeds on the third attempt and never makes a fourth", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error(`transient ${calls}`);
        return "ok";
      },
      { delayMs: 0 },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("gives up after three attempts and rethrows the LAST error unchanged", async () => {
    let calls = 0;
    const errors = [];
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          const error = new Error(`attempt ${calls}`);
          errors.push(error);
          throw error;
        },
        { delayMs: 0 },
      ),
      (thrown) => thrown === errors[2],
    );
    assert.equal(calls, 3);
  });
});

describe("isSafePathComponent — INJ-1 single segment", () => {
  it("accepts an ordinary name and refuses every escape shape", () => {
    assert.equal(isSafePathComponent("run-7.a"), true);
    for (const bad of ["", ".", "..", "...", "a/b", "a\\b", "/", "\\"]) {
      assert.equal(isSafePathComponent(bad), false, JSON.stringify(bad));
    }
    assert.equal(isSafePathComponent(undefined), false);
  });
});

describe("pathExists / createDirRecursively", () => {
  const roots = [];
  after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  it("creates every missing level, tolerates an existing directory, and reports presence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tessera-pathkit-"));
    roots.push(root);
    const deep = path.join(root, "a", "b", "c");
    assert.equal(await pathExists(deep), false);
    await createDirRecursively(deep);
    await createDirRecursively(deep);
    assert.equal((await stat(deep)).isDirectory(), true);
    assert.equal(await pathExists(deep), true);
    const file = path.join(deep, "f.txt");
    await writeFile(file, "");
    assert.equal(await pathExists(file), true);
    // A path beneath a regular file errors (ENOTDIR); every error reads false.
    assert.equal(await pathExists(path.join(file, "x")), false);
  });
});
