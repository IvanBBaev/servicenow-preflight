// The write journal must never be written INTO THE SOURCE TREE by a test.
//
// DEV-15 journals every applied write to
// `<SN_DOCS_DIR>/<profile>/write-journal.{jsonl,md}`, and `getDocsDir()`
// falls back to `docs/instance` relative to the CURRENT WORKING DIRECTORY.
// `npm test` runs with the cwd set to the package, so any suite here that
// drives the vendored transport with a non-GET and without staging
// `SN_DOCS_DIR` silently appends to `packages/runner-atf/docs/instance/`.
//
// That is what happened: `client.test.js`'s POST test deleted `SN_DOCS_DIR`
// along with the rest of the `SN_*` environment and never re-set it, so every
// run from 2026-08-25 onward added one row to a tracked-looking file. The
// journal exists precisely because this client has no AI Control Tower
// backstop, and its row format carries no field that could mark a row as
// synthetic — so a reader cannot tell fixture traffic from a real mutation.
// Nothing failed, nothing warned, and the append is best-effort by design
// (`appendWriteJournal` catches and logs), which is exactly why a week of it
// went unnoticed.
//
// This suite is the thing that was missing. It re-runs every OTHER test file
// in this package the way the gate does — child process, cwd at the package
// root, `SN_DOCS_DIR` explicitly removed from the environment — and asserts
// that not one byte under the package changed. Two guards keep it from
// passing for the wrong reason: it asserts the child actually executed the
// test that used to pollute (a child that fails to start writes nothing and
// would otherwise look identical to a clean run), and it proves its own
// change detector can see a new file before trusting it to report none.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(TEST_DIR, "..");
const SELF = path.basename(fileURLToPath(import.meta.url));

/** Generated or vendored trees a test run is allowed to leave alone. */
const IGNORED = new Set(["node_modules", "build", "coverage", ".git"]);

/**
 * Every file under `dir`, as `relative path -> sha256`. Content-hashed rather
 * than mtime-compared: an append that happens to preserve a timestamp is still
 * an append, and the journal is opened in append mode.
 */
function snapshot(dir) {
  const files = new Map();
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) {
        files.set(
          rel,
          createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
        );
      }
    }
  };
  walk(dir, "");
  return files;
}

/** Paths that differ between two snapshots, in either direction. */
function diff(before, after) {
  const changed = [];
  for (const [rel, hash] of after) {
    if (!before.has(rel)) changed.push(`created: ${rel}`);
    else if (before.get(rel) !== hash) changed.push(`modified: ${rel}`);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) changed.push(`deleted: ${rel}`);
  }
  return changed.sort();
}

describe("snapshot (the detector this suite's verdict rests on)", () => {
  it("reports a created, a modified and a deleted file — a blind detector would report a clean tree forever", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-snapshot-"));
    try {
      fs.mkdirSync(path.join(root, "nested"), { recursive: true });
      fs.writeFileSync(path.join(root, "kept.txt"), "same");
      fs.writeFileSync(path.join(root, "nested", "edited.txt"), "before");
      fs.writeFileSync(path.join(root, "removed.txt"), "gone soon");
      const before = snapshot(root);

      fs.appendFileSync(path.join(root, "nested", "edited.txt"), "after");
      fs.writeFileSync(path.join(root, "nested", "added.txt"), "new");
      fs.rmSync(path.join(root, "removed.txt"));

      assert.deepEqual(diff(before, snapshot(root)), [
        "created: nested/added.txt",
        "deleted: removed.txt",
        "modified: nested/edited.txt",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores build output, so a stale build/ cannot mask a real change", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-snapshot-"));
    try {
      const before = snapshot(root);
      fs.mkdirSync(path.join(root, "build"), { recursive: true });
      fs.writeFileSync(path.join(root, "build", "index.js"), "compiled");
      assert.deepEqual(diff(before, snapshot(root)), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("write-journal containment", () => {
  it("leaves the package source tree byte-identical when the whole suite runs with SN_DOCS_DIR unset", () => {
    const siblings = fs
      .readdirSync(TEST_DIR)
      .filter((name) => name.endsWith(".test.js") && name !== SELF)
      .sort()
      .map((name) => path.join("test", name));
    // A shrinking file list would quietly shrink what this guard covers.
    assert.ok(
      siblings.length >= 5,
      `expected the package's suites to be discovered, got ${siblings.length}`,
    );

    // The gate's exact conditions: cwd at the package root, and SN_DOCS_DIR
    // removed rather than merely absent — an inherited value from a parent
    // harness would relocate the journal and hide the very bug this catches.
    //
    // NODE_TEST_CONTEXT goes too. `node --test` sets it, and a nested runner
    // that sees it prints "run() is being called recursively ... skipping
    // running files" to stderr, exits 0, and runs nothing. That is a silent
    // pass for this guard — an empty tree because nothing executed looks
    // exactly like an empty tree because nothing polluted — which is why the
    // assertions below demand positive proof that the child really ran.
    const env = { ...process.env };
    delete env.SN_DOCS_DIR;
    delete env.NODE_TEST_CONTEXT;

    const before = snapshot(PKG_ROOT);
    const child = spawnSync(process.execPath, ["--test", ...siblings], {
      cwd: PKG_ROOT,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    const changed = diff(before, snapshot(PKG_ROOT));

    // Instrument check, not a duplicate of the sibling suites' own verdicts:
    // a child that never started writes nothing, and "wrote nothing" is the
    // same observation as "ran clean". Require positive evidence that the one
    // test known to drive a journalled write actually executed.
    assert.equal(
      child.error,
      undefined,
      `child runner failed to start: ${child.error?.message}`,
    );
    const passed = /^# pass (\d+)$/m.exec(child.stdout ?? "");
    assert.ok(
      passed && Number(passed[1]) > 0,
      `child runner produced no passing tests; stdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
    );
    assert.match(
      child.stdout ?? "",
      /lets a POST through/,
      "the POST test that exercises the journalled write path did not run",
    );

    assert.deepEqual(
      changed,
      [],
      `running the suite mutated the source tree:\n${changed.join("\n")}`,
    );
  });
});
