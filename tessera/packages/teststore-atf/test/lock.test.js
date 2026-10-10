// `acquireProjectionLock` on its own: the refusal must name the holder when it
// can, degrade to a generic holder when it cannot, and never mistake an I/O
// fault for "someone else holds the lock".

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { TestStoreRefusalError } from "../build/client.js";
import { acquireProjectionLock } from "../build/lock.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-lock-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
const fresh = () => path.join(root, `case-${++n}`, "projection.lock");

function heldBy(pattern) {
  return (error) =>
    error instanceof TestStoreRefusalError &&
    error.code === "lock-held" &&
    pattern.test(error.message);
}

describe("acquireProjectionLock", () => {
  test("creates the parent directory and names the holder in a refusal", () => {
    const lockPath = fresh();
    const lock = acquireProjectionLock(lockPath, { runId: "run-a" });
    assert.match(fs.readFileSync(lockPath, "utf8"), /"runId":"run-a"/);
    assert.throws(
      () => acquireProjectionLock(lockPath, { runId: "run-b" }),
      heldBy(/run-b.*held by \{"runId":"run-a"/),
    );
    lock.release();
    lock.release();
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("an empty lock file is held by an unknown holder", () => {
    const lockPath = fresh();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "  \n");
    assert.throws(
      () => acquireProjectionLock(lockPath, { runId: "run-b" }),
      heldBy(/held by an unknown holder/),
    );
  });

  test("an unreadable lock entry is held by an unknown holder", () => {
    // A directory at the lock path: `wx` reports EEXIST, the read fails.
    const lockPath = fresh();
    fs.mkdirSync(lockPath, { recursive: true });
    assert.throws(
      () => acquireProjectionLock(lockPath, { runId: "run-b" }),
      heldBy(/held by an unknown holder/),
    );
  });

  test(
    "any other write error propagates unchanged, not as lock-held",
    { skip: process.getuid?.() === 0 && "root ignores directory modes" },
    () => {
      // A read-only parent: mkdir passes (it exists), the `wx` write fails
      // with EACCES — an I/O fault, not a held lock.
      const lockPath = fresh();
      const parent = path.dirname(lockPath);
      fs.mkdirSync(parent, { recursive: true });
      fs.chmodSync(parent, 0o555);
      try {
        assert.throws(
          () => acquireProjectionLock(lockPath, { runId: "run-b" }),
          (error) =>
            !(error instanceof TestStoreRefusalError) &&
            error.code === "EACCES",
        );
      } finally {
        fs.chmodSync(parent, 0o755);
      }
    },
  );
});
