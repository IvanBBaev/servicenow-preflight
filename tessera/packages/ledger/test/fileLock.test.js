// The cross-process lock under the host and run-event namespaces: a crashed
// holder's residue is broken, a live holder is waited out and then refused
// with nothing written, and no other I/O failure is mistaken for "held".

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LedgerError } from "../build/index.js";
import { withFileLock } from "../build/fileLock.js";
import { tempRoot } from "./helpers.js";

/** A pid that has already exited (a just-reaped child). */
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

/** Back-date `file` past the empty-lock grace period. */
function age(file) {
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
}

describe("withFileLock", () => {
  it("holds the lock with its own pid while working, then removes it", async (t) => {
    const file = join(tempRoot(t), "infra.lock");
    let seen;
    const result = await withFileLock(file, async () => {
      seen = JSON.parse(readFileSync(file, "utf8"));
      return "done";
    });
    assert.equal(result, "done");
    assert.deepEqual(seen, { pid: process.pid });
    assert.equal(existsSync(file), false);
  });

  it("releases the lock when the work throws", async (t) => {
    const file = join(tempRoot(t), "infra.lock");
    await assert.rejects(
      withFileLock(file, async () => {
        throw new Error("work failed");
      }),
      /work failed/,
    );
    assert.equal(existsSync(file), false);
  });

  it("breaks a lock whose holder pid is dead", async (t) => {
    const file = join(tempRoot(t), "infra.lock");
    writeFileSync(file, JSON.stringify({ pid: deadPid() }));
    let ran = false;
    await withFileLock(
      file,
      async () => {
        ran = true;
      },
      200,
    );
    assert.equal(ran, true);
    assert.equal(existsSync(file), false);
  });

  it("breaks an empty or unparsable lock only once it is old", async (t) => {
    const root = tempRoot(t);
    for (const [name, content] of [
      ["empty.lock", ""],
      ["garbage.lock", "{not json"],
      ["no-pid.lock", JSON.stringify({ pid: 0 })],
    ]) {
      const file = join(root, name);
      writeFileSync(file, content);
      age(file);
      let ran = false;
      await withFileLock(
        file,
        async () => {
          ran = true;
        },
        200,
      );
      assert.equal(ran, true, name);
    }
  });

  it("times out on a live holder — or a fresh empty lock — and writes nothing", async (t) => {
    const root = tempRoot(t);
    for (const [name, content] of [
      ["live.lock", JSON.stringify({ pid: process.pid })],
      ["fresh-empty.lock", ""],
    ]) {
      const file = join(root, name);
      writeFileSync(file, content);
      let ran = false;
      await assert.rejects(
        withFileLock(
          file,
          async () => {
            ran = true;
          },
          30,
        ),
        (error) =>
          error instanceof LedgerError &&
          error.code === "lock-timeout" &&
          /nothing was written/.test(error.message),
      );
      assert.equal(ran, false, name);
      assert.equal(readFileSync(file, "utf8"), content, name);
    }
  });

  it("propagates an I/O failure other than EEXIST instead of waiting", async (t) => {
    const file = join(tempRoot(t), "absent-dir", "infra.lock");
    const started = Date.now();
    await assert.rejects(
      withFileLock(file, async () => {}, 5_000),
      (error) => error.code === "ENOENT" && !(error instanceof LedgerError),
    );
    assert.ok(Date.now() - started < 1_000);
  });
});
