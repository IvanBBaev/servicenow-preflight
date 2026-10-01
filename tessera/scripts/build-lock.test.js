// The lock's contract, exercised through its real entry point.
//
// Every case runs `node scripts/build-lock.mjs …` as a child process, because
// the things worth enforcing here are process-level: the exit code, whether
// the wrapped command ran at all, and what is left on disk afterwards. A test
// that imported internals could not observe any of those.
// The one exception is the Linux /proc branch of the start-time signature,
// which no entry-point run on a non-Linux box can reach; that branch alone is
// driven in-process, through an explicit platform and proc root.
//
// Each case gets its own mkdtemp directory and points TESSERA_BUILD_LOCK at a
// file inside it. The real workspace lock is never touched, so a failing run
// cannot wedge the repo it is testing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The two functions that decide a holder's identity, imported for the one
// branch the entry point cannot be steered into off-Linux — see "the Linux
// /proc start-time signature" below. Importing is safe: the module runs main()
// only when it is itself the entry point.
import { holderLiveness, processStartSignature } from "./build-lock.mjs";

const LOCK_SCRIPT = fileURLToPath(new URL("./build-lock.mjs", import.meta.url));
// The same script as an import specifier. A handful of cases below drive the
// module directly, from inside a child process of their own, because the state
// they judge (holding the lock with no child running) has no command line that
// produces it.
const LOCK_SCRIPT_URL = new URL("./build-lock.mjs", import.meta.url).href;

// Asserted as a literal, not imported from the script: the point of this code
// is that it is a stable, documented number a caller can branch on. Importing
// it would make the test agree with whatever the script currently says.
const EXIT_LOCK_HELD = 75;
const EXIT_LOCK_PATH_UNUSABLE = 78;
const EXIT_USAGE = 64;
const EXIT_SPAWN_FAILED = 127;

/** The refusal a lock path whose bytes cannot be read must produce. */
const UNREADABLE_REFUSAL = (code) =>
  new RegExp(`REFUSED — the lock path cannot be read \\(${code}\\)`);

// ── harness ─────────────────────────────────────────────────────────────────

/** A throwaway directory plus the three paths every case needs inside it. */
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-build-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    lockFile: path.join(dir, "build.lock"),
    sentinel: path.join(dir, "ran.txt"),
    snapshot: path.join(dir, "snapshot.json"),
    foreign: path.join(dir, "foreign-ran.txt"),
  };
}

/**
 * @param {object} [extra] additional environment for the wrapper under test.
 *   TESSERA_BUILD_LOCK_OWNER is DELETED first, every time: this suite itself
 *   runs inside the workspace hold (root `test` is wrapped), so the real
 *   token is in our environment and would otherwise be inherited by every
 *   case. A case that means to exercise an inherited token sets its own here,
 *   which is the only way a token reaches the wrapper from these tests.
 *   TESSERA_BUILD_LOCK_WAIT is deleted for the same reason.
 */
function runLock(box, args, extra = {}) {
  const env = {
    ...process.env,
    TESSERA_BUILD_LOCK: box.lockFile,
    SCRIPT: LOCK_SCRIPT,
    SENTINEL: box.sentinel,
    SNAPSHOT: box.snapshot,
    FOREIGN: box.foreign,
  };
  delete env.TESSERA_BUILD_LOCK_OWNER;
  // Same reason, for the opt-in wait: a lane that exports it for its own
  // builds would otherwise turn every contention case below into a wait.
  delete env.TESSERA_BUILD_LOCK_WAIT;
  return spawnSync(process.execPath, [LOCK_SCRIPT, ...args], {
    cwd: box.dir,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
}

/**
 * A wrapped command that records the fact that it ran, then exits with a
 * chosen code. The sentinel is written first and unconditionally, so "did it
 * run?" stays observable independently of "what did it return?" — the two
 * questions this lock exists to keep apart.
 */
const touch = (code) => [
  process.execPath,
  "-e",
  `require("node:fs").writeFileSync(process.env.SENTINEL, "ran");` +
    `process.exitCode = ${code};`,
];

/**
 * A wrapped command that replaces the lock with a DIFFERENT hold recorded
 * under the SAME pid as the run that is holding it — the shape a recycled pid
 * produces, and the one a pid comparison cannot tell from our own hold.
 */
const usurpUnderTheSamePid = [
  process.execPath,
  "-e",
  `const fs = require("node:fs");` +
    `const lock = process.env.TESSERA_BUILD_LOCK;` +
    `const held = JSON.parse(fs.readFileSync(lock, "utf8"));` +
    `fs.rmSync(lock);` +
    `fs.writeFileSync(lock, JSON.stringify({ pid: held.pid,` +
    ` owner: "a-different-hold-entirely",` +
    ` acquiredAt: new Date().toISOString(),` +
    ` command: "someone else entirely" }));`,
];

/** A wrapped command that overwrites the lock with a different live owner. */
const usurp = (pid) => [
  process.execPath,
  "-e",
  `require("node:fs").writeFileSync(process.env.TESSERA_BUILD_LOCK,` +
    ` JSON.stringify({ pid: ${pid}, acquiredAt: new Date().toISOString(),` +
    ` command: "someone else entirely" }));`,
];

function writeLock(box, payload) {
  fs.writeFileSync(
    box.lockFile,
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
  );
}

const ranCommand = (box) => fs.existsSync(box.sentinel);
const foreignRan = (box) => fs.existsSync(box.foreign);
const snapshotOf = (box) => JSON.parse(fs.readFileSync(box.snapshot, "utf8"));
const lockExists = (box) => fs.existsSync(box.lockFile);
const lockPayload = (box) => JSON.parse(fs.readFileSync(box.lockFile, "utf8"));

/**
 * A PID that has certainly exited: start a process and wait for it to finish.
 * (PID reuse inside the microseconds that follow is not a real hazard, and no
 * cheaper source of a provably-dead PID exists that is portable.)
 */
function deadPid() {
  const done = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(done.status, 0, "helper process did not exit cleanly");
  assert.ok(Number.isInteger(done.pid), "helper process reported no pid");
  return done.pid;
}

// ── the happy path ──────────────────────────────────────────────────────────

describe("acquire → run → release", () => {
  it("runs the command and leaves no lock file behind", (t) => {
    const box = sandbox(t);
    assert.equal(lockExists(box), false, "sandbox started dirty");

    const run = runLock(box, touch(0));

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    // The release, not merely the absence of a crash. A lock left behind here
    // is invisible until the NEXT run has to break it.
    assert.equal(lockExists(box), false, "the lock outlived the run");
  });

  it("records pid, an ISO-8601 acquiredAt and the command in the lock", (t) => {
    const box = sandbox(t);

    // Snapshot the lock from inside the wrapped command, i.e. while it is
    // genuinely held. This is the observable consequence of the atomic
    // create: the file is never present without naming its owner, which is
    // the only reason staleness detection can be more than a guess.
    const run = runLock(box, [
      process.execPath,
      "-e",
      `require("node:fs").copyFileSync(process.env.TESSERA_BUILD_LOCK,` +
        ` process.env.SNAPSHOT);`,
    ]);

    assert.equal(run.status, 0, run.stderr);
    const held = JSON.parse(fs.readFileSync(box.snapshot, "utf8"));
    assert.ok(Number.isInteger(held.pid) && held.pid > 0, "no usable pid");
    assert.equal(
      new Date(held.acquiredAt).toISOString(),
      held.acquiredAt,
      "acquiredAt is not ISO-8601",
    );
    assert.match(held.command, /copyFileSync/, "the command was not recorded");
  });
});

// ── pass-through ────────────────────────────────────────────────────────────

describe("the child's exit code", () => {
  for (const code of [0, 1, 3, 42]) {
    it(`passes ${code} through unchanged`, (t) => {
      const box = sandbox(t);

      const run = runLock(box, touch(code));

      assert.equal(run.status, code, run.stderr);
      // Without this the assertion above would also pass if the wrapper had
      // refused and coincidentally exited the same number.
      assert.equal(ranCommand(box), true, "the wrapped command never ran");
      assert.equal(lockExists(box), false, "the lock outlived the run");
    });
  }
});

// ── contention ──────────────────────────────────────────────────────────────

describe("a live holder", () => {
  it("is refused with the contention code, and nothing runs", (t) => {
    const box = sandbox(t);
    // This test runner is, definitionally, alive and owned by this user.
    writeLock(box, {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      command: "npm run build:all",
    });

    const run = runLock(box, touch(0));

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    // The property that matters most: a refusal that still ran the command
    // would be worse than no lock, because it would also look safe.
    assert.equal(ranCommand(box), false, "the command ran despite the lock");
    assert.match(run.stderr, new RegExp(`held by PID ${process.pid}`));
    assert.match(run.stderr, /npm run build:all/);
    // A refusal must not disturb the holder's lock.
    assert.equal(lockExists(box), true, "the refusal removed the live lock");
    assert.equal(lockPayload(box).pid, process.pid, "the lock was rewritten");
  });

  it("counts as alive when probing it raises EPERM, not ESRCH", (t) => {
    const box = sandbox(t);
    // PID 1 exists on every POSIX host and is owned by root, so an unprivileged
    // process.kill(1, 0) raises EPERM — the code that means "exists, but not
    // yours", and the one an over-eager reading of errno turns into "dead".
    // If this suite ever runs as root the probe simply succeeds instead, and
    // the expectation below is unchanged either way: alive, therefore refused.
    writeLock(box, {
      pid: 1,
      acquiredAt: new Date().toISOString(),
      command: "init",
    });

    const run = runLock(box, touch(0));

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "EPERM was mistaken for a dead pid");
    assert.equal(lockExists(box), true, "a live root-owned lock was broken");
  });
});

// ── staleness ───────────────────────────────────────────────────────────────

describe("a stale lock", () => {
  it("is broken when its holder is gone, and the command runs", (t) => {
    const box = sandbox(t);
    const gone = deadPid();
    writeLock(box, {
      pid: gone,
      acquiredAt: new Date("2020-01-01T00:00:00.000Z").toISOString(),
      command: "a build that died",
    });

    const run = runLock(box, touch(0));

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "a dead holder still blocked the run");
    assert.equal(lockExists(box), false, "the lock outlived the run");
    // Breaking someone's lock silently is how a lock stops being trustworthy;
    // the reason and the dead PID both have to reach the operator.
    assert.match(run.stderr, /STALE/);
    assert.match(run.stderr, new RegExp(String(gone)));
  });

  for (const [label, payload] of [
    ["truncated JSON", '{"pid": 12'],
    ["empty file", ""],
    ["JSON that is not an object", '["not", "an", "object"]'],
    ["an object with no pid", '{"acquiredAt": "2020-01-01T00:00:00.000Z"}'],
    ["a non-numeric pid", '{"pid": "nope"}'],
    ["a nonsensical pid", '{"pid": -7}'],
  ]) {
    it(`is broken when the payload is ${label}`, (t) => {
      const box = sandbox(t);
      writeLock(box, payload);

      const run = runLock(box, touch(0));

      // The bytes were read and name no holder, so nobody can ever be proved
      // dead behind them; honouring them would wedge the repo permanently. It
      // has to be stale — and it is SAFE to break, because the bytes are in
      // hand to prove the file unchanged at the unlink. That is what separates
      // it from the unreadable path below, which must be refused instead.
      assert.equal(run.status, 0, run.stderr);
      assert.equal(ranCommand(box), true, "a malformed lock blocked the run");
      assert.equal(lockExists(box), false, "the lock outlived the run");
      assert.match(run.stderr, /STALE/);
      assert.doesNotMatch(
        run.stderr,
        /lock path cannot be read/,
        "a readable lock was refused as unreadable",
      );
    });
  }
});

// ── a lock path whose bytes cannot be read ──────────────────────────────────
//
// "Malformed" and "unreadable" are different facts. Malformed bytes were READ,
// so a break can re-read them and prove nothing changed before the unlink —
// that is what makes breaking safe. Unreadable bytes were not: nobody can say
// who holds the lock, whether they are alive, or whether an unlink would hit
// the hold that was judged. Breaking blind there is unlinking a hold that may
// be live — on a shared checkout with umask 077 the first user's live lock is
// mode 0600 and the second user reads EACCES — which is the interleave this
// file exists to prevent. So the wrapper must refuse, say so honestly (no
// "breaking STALE" for a break that cannot happen), leave the path exactly as
// found, and exit a code that is neither "retry later" nor "bug in this
// script".

describe("a lock path that cannot be read", () => {
  it("is refused when it is a directory — not broken, not reported as a bug", (t) => {
    const box = sandbox(t);
    // Empty on purpose: an empty directory is what a blind rmdir CAN remove,
    // so its survival below is evidence; a non-empty one would survive any
    // unlink regardless and prove nothing about the wrapper.
    fs.mkdirSync(box.lockFile);

    const run = runLock(box, touch(0));

    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(
      ranCommand(box),
      false,
      "the command ran beside a lock nobody read",
    );
    assert.match(run.stderr, UNREADABLE_REFUSAL("EISDIR"));
    assert.match(run.stderr, /must be a regular file or absent/);
    // The transcript must not claim a break that did not happen, and must not
    // call an environment fault at the configured path a bug in the script.
    assert.doesNotMatch(
      run.stderr,
      /breaking STALE/,
      "a break was announced for a lock that cannot be broken",
    );
    assert.doesNotMatch(
      run.stderr,
      /unexpected failure/,
      "a fault at the lock path was reported as an internal failure",
    );
    assert.ok(
      fs.statSync(box.lockFile).isDirectory(),
      "the directory at the lock path was removed or replaced",
    );
  });

  it("is refused when it is a file this user cannot read, and the file is left byte for byte", (t) => {
    const box = sandbox(t);
    if (process.getuid?.() === 0) {
      t.skip("running as root, which reads every file regardless of its mode");
      return;
    }
    // A live-looking hold behind a mode this user cannot open: the shape of
    // another user's lock on a shared checkout under umask 077. Its bytes are
    // the property — a blind break would unlink them and let two builds run.
    const payload = `${JSON.stringify(
      {
        pid: process.pid,
        owner: "a-hold-behind-a-mode-0000-file",
        acquiredAt: new Date().toISOString(),
        command: "another user's live build",
      },
      null,
      2,
    )}\n`;
    writeLock(box, payload);
    fs.chmodSync(box.lockFile, 0o000);
    t.after(() => {
      try {
        fs.chmodSync(box.lockFile, 0o600);
      } catch {
        /* already gone or already readable */
      }
    });

    const run = runLock(box, touch(0));

    // The no-blind-break property first: it is what this case exists for.
    assert.equal(lockExists(box), true, "an unreadable lock was broken blind");
    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(
      ranCommand(box),
      false,
      "the command ran beside a lock nobody read",
    );
    assert.match(run.stderr, UNREADABLE_REFUSAL("EACCES"));
    assert.doesNotMatch(
      run.stderr,
      /breaking STALE/,
      "a break was announced for a lock that cannot be broken",
    );
    assert.doesNotMatch(
      run.stderr,
      /unexpected failure/,
      "a fault at the lock path was reported as an internal failure",
    );
    fs.chmodSync(box.lockFile, 0o600);
    assert.equal(
      fs.readFileSync(box.lockFile, "utf8"),
      payload,
      "the unreadable lock was rewritten",
    );
  });
});

// ── release safety ──────────────────────────────────────────────────────────

describe("release", () => {
  it("does not remove a lock that now belongs to a different PID", (t) => {
    const box = sandbox(t);

    // Simulates the one sequence that makes a blind unlink dangerous: our
    // lock is judged stale and broken while we are still running, and someone
    // else acquires. Releasing on the way out would then delete a live
    // holder's lock — the exact failure the whole script exists to prevent.
    const run = runLock(box, usurp(process.pid));

    assert.equal(run.status, 0, run.stderr);
    assert.equal(lockExists(box), true, "release deleted someone else's lock");
    const left = lockPayload(box);
    assert.equal(left.pid, process.pid);
    assert.equal(left.command, "someone else entirely");
    assert.match(run.stderr, /not releasing/);
  });

  it("removes only the hold it took, not any lock recording the same PID", (t) => {
    const box = sandbox(t);

    // Same sequence as above — our lock is gone and someone else's hold is on
    // disk — except that the new hold carries OUR pid. That is what a hold
    // written in another pid namespace (a container sharing this checkout) or
    // one restored under a running build looks like from here, and it is the
    // case where "the file records my pid" stops meaning "the file is mine".
    // A pid comparison unlinks a live holder's lock; the token does not,
    // because a token names one hold and is never minted twice.
    const run = runLock(box, usurpUnderTheSamePid);

    assert.equal(run.status, 0, run.stderr);
    assert.equal(lockExists(box), true, "release deleted a hold it never took");
    const left = lockPayload(box);
    assert.equal(left.owner, "a-different-hold-entirely");
    assert.equal(left.command, "someone else entirely");
    assert.match(run.stderr, /not releasing/);
  });
});

// ── usage ───────────────────────────────────────────────────────────────────

describe("no command", () => {
  it("is a usage error, distinct from contention, and takes no lock", (t) => {
    const box = sandbox(t);

    const run = runLock(box, []);

    assert.equal(run.status, EXIT_USAGE, run.stderr);
    assert.notEqual(run.status, EXIT_LOCK_HELD);
    assert.equal(lockExists(box), false, "a usage error left a lock behind");
  });
});

// ── re-entrancy ─────────────────────────────────────────────────────────────
//
// Every build path is wrapped, so the wrapped paths nest: root `check` calls
// wrapped `build` calls twenty wrapped per-package `build`s. The inner ones
// must proceed under a hold their own tree took, and must still be refused
// under anyone else's. These cases exist because getting that wrong is silent
// in the dangerous direction: a check that always answers "already held"
// deadlocks nothing, breaks no test, and leaves the workspace unlocked while
// the wrapper sits on every path reporting success. So the assertions below
// are deliberately about the FILE and about a FOREIGN process — things an
// unconditional "yes" cannot fake — rather than about the wrapper's own
// opinion of itself.

/** Snapshot the live lock from inside the wrapped command. */
const snapshotLock = [
  process.execPath,
  "-e",
  `require("node:fs").copyFileSync(process.env.TESSERA_BUILD_LOCK,` +
    ` process.env.SNAPSHOT);` +
    `require("node:fs").writeFileSync(process.env.SENTINEL, "ran");`,
];

/**
 * From inside a held run, launch the wrapper again with the inherited token
 * STRIPPED — i.e. as a genuinely unrelated process tree — and record what it
 * did. This is the case a boolean "a lock exists" flag gets right and an
 * unconditional re-entrancy check gets catastrophically wrong.
 */
const foreignRerun = [
  process.execPath,
  "-e",
  `const { spawnSync } = require("node:child_process");` +
    `const env = { ...process.env };` +
    `delete env.TESSERA_BUILD_LOCK_OWNER;` +
    `const r = spawnSync(process.execPath, [process.env.SCRIPT,` +
    ` process.execPath, "-e",` +
    ` 'require("node:fs").writeFileSync(process.env.FOREIGN, "ran")'],` +
    ` { env, encoding: "utf8" });` +
    `require("node:fs").writeFileSync(process.env.SNAPSHOT,` +
    ` JSON.stringify({ status: r.status, stderr: r.stderr }));`,
];

/** From inside a held run, re-enter the wrapper, then look at the lock. */
const nestedThenInspect = [
  process.execPath,
  "-e",
  `const { spawnSync } = require("node:child_process");` +
    `const fs = require("node:fs");` +
    `const r = spawnSync(process.execPath, [process.env.SCRIPT,` +
    ` process.execPath, "-e",` +
    ` 'require("node:fs").writeFileSync(process.env.SENTINEL, "ran")'],` +
    ` { encoding: "utf8" });` +
    `fs.copyFileSync(process.env.TESSERA_BUILD_LOCK, process.env.SNAPSHOT);` +
    `fs.writeFileSync(process.env.SNAPSHOT + ".status", String(r.status));`,
];

describe("a top-level run", () => {
  it("actually takes the lock — the file exists while the command runs", (t) => {
    const box = sandbox(t);

    const run = runLock(box, snapshotLock);

    // If re-entrancy ever answers "yes" unconditionally, no lock is ever
    // created and this copyFileSync fails with ENOENT. That is the point of
    // asserting on the file rather than on the exit code alone.
    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    const held = snapshotOf(box);
    assert.ok(
      typeof held.owner === "string" && held.owner.length > 0,
      "the lock was taken without an owner token, so nothing can re-enter it",
    );
    assert.match(held.owner, /^\d+-/, "the token does not name its minter");
    assert.doesNotMatch(run.stderr, /re-entrant/, "a top-level run re-entered");
  });
});

describe("a nested wrapper", () => {
  it("runs under our own hold instead of deadlocking on it", (t) => {
    const box = sandbox(t);

    // The shape of `npm run check` → `npm run build` → per-package `build`.
    // Without re-entrancy the inner acquire hits EEXIST against its own
    // parent and exits 75 — a self-deadlock indistinguishable from real
    // contention.
    const run = runLock(box, [process.execPath, LOCK_SCRIPT, ...touch(0)]);

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "the nested command never ran");
    assert.match(
      run.stderr,
      /re-entrant/,
      "the pass-through was not announced",
    );
    assert.equal(lockExists(box), false, "the lock outlived the run");
  });

  it("does not release the hold it did not take", (t) => {
    const box = sandbox(t);

    const run = runLock(box, nestedThenInspect);

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "the nested command never ran");
    assert.equal(
      fs.readFileSync(`${box.snapshot}.status`, "utf8"),
      "0",
      "the nested run did not exit 0",
    );
    // The lock still existed AFTER the nested run finished. A re-entrant run
    // that released on its way out would unlock the workspace twenty times
    // over during a root build, while the outer build kept going.
    const stillHeld = snapshotOf(box);
    assert.ok(stillHeld.owner.length > 0, "the surviving lock has no owner");
  });
});

describe("a foreign tree", () => {
  it("is still refused while a re-entrant subtree is mid-flight", (t) => {
    const box = sandbox(t);

    const run = runLock(box, foreignRerun);

    assert.equal(run.status, 0, run.stderr);
    const foreign = snapshotOf(box);
    // The crux. Re-entrancy must admit our own subtree and no one else. An
    // unconditional "already held" admits this process too, and then the lock
    // protects nothing while every gate stays green.
    assert.equal(
      foreign.status,
      EXIT_LOCK_HELD,
      `a foreign run was not refused: ${foreign.stderr}`,
    );
    assert.equal(
      foreignRan(box),
      false,
      "a foreign command ran under our lock",
    );
    assert.match(foreign.stderr, /REFUSED/);
  });
});

describe("an inherited token", () => {
  it("is ignored when the lock file names a different owner", (t) => {
    const box = sandbox(t);
    writeLock(box, {
      pid: process.pid, // this test runner: definitionally alive
      owner: "the-owner-actually-on-disk",
      acquiredAt: new Date().toISOString(),
      command: "npm run build:all",
    });

    const run = runLock(box, touch(0), {
      TESSERA_BUILD_LOCK_OWNER: "a-token-from-some-other-hold",
    });

    // The token is a name checked against the live file, never a permission
    // slip. A token that does not match the file buys exactly nothing.
    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "a stale token waived the lock");
  });

  it("is ignored when the lock file carries no owner at all", (t) => {
    const box = sandbox(t);
    writeLock(box, {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      command: "a lock written by hand",
    });

    const run = runLock(box, touch(0), {
      TESSERA_BUILD_LOCK_OWNER: "",
    });

    // Empty on both sides must not compare equal into a pass-through.
    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "an ownerless lock was re-entered");
  });

  it("does not waive the acquire when no lock file exists", (t) => {
    const box = sandbox(t);
    const claimed = "a-token-left-over-in-someones-shell";

    const run = runLock(box, snapshotLock, {
      TESSERA_BUILD_LOCK_OWNER: claimed,
    });

    assert.equal(run.status, 0, run.stderr);
    // The leftover-export scenario: the claim is present, the hold is not.
    // The run must take a real lock of its own, under a NEW token.
    const held = snapshotOf(box);
    assert.notEqual(held.owner, claimed, "a leftover token became the hold");
    assert.ok(held.owner.length > 0, "no lock was taken");
    assert.doesNotMatch(run.stderr, /re-entrant/);
  });

  it("does not re-enter a hold whose recorded pid is gone", (t) => {
    const box = sandbox(t);
    const token = "orphaned-hold-token";
    const gone = deadPid();
    writeLock(box, {
      pid: gone,
      owner: token,
      acquiredAt: new Date().toISOString(),
      command: "a build that was SIGKILLed",
    });

    const run = runLock(box, snapshotLock, {
      TESSERA_BUILD_LOCK_OWNER: token,
    });

    // Our own tree, orphaned: the outer wrapper was killed, so its lock is now
    // breakable-as-stale by any third party. Passing through would mean
    // building beside whoever breaks it. Take a fresh hold instead.
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /STALE/);
    assert.doesNotMatch(
      run.stderr,
      /re-entrant/,
      "an orphaned hold was re-entered",
    );
    assert.notEqual(snapshotOf(box).owner, token, "the dead hold was reused");
  });
});

// ── the contention code is a signal, not just a number ──────────────────────

describe("the contention code", () => {
  it("is not the code that same command returns when it merely fails", (t) => {
    const box = sandbox(t);

    // Same wrapper, same command; the ONLY difference is whether the lock is
    // held. If these two produce the same number, a caller and CI can no
    // longer tell "the build broke" from "the build never started" — which is
    // the entire reason this code is 75 and not 1.
    const failed = runLock(box, touch(1));
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    fs.rmSync(box.sentinel);

    writeLock(box, {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      command: "npm run build:all",
    });
    const refused = runLock(box, touch(1));

    assert.equal(refused.status, EXIT_LOCK_HELD, refused.stderr);
    assert.equal(ranCommand(box), false, "the command ran despite the lock");
    assert.notEqual(
      refused.status,
      failed.status,
      "contention and failure now report the same code",
    );
    assert.equal(EXIT_LOCK_HELD, 75, "EX_TEMPFAIL, per sysexits.h");
  });
});

describe("the unreadable-lock code", () => {
  it("is not the code that same command returns when it fails, nor the contention code", (t) => {
    const box = sandbox(t);

    // Same shape as the case above, for the other "nothing ran" refusal. A
    // caller has to be able to tell three things apart from one number: the
    // build failed, the build never started and a retry will do, and the
    // build never started and a retry will NOT do — the lock path itself has
    // to be fixed. Collapsing the last onto either of the first two hides it.
    const failed = runLock(box, touch(1));
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    fs.rmSync(box.sentinel);

    fs.mkdirSync(box.lockFile);
    const refused = runLock(box, touch(1));

    assert.equal(refused.status, EXIT_LOCK_PATH_UNUSABLE, refused.stderr);
    assert.equal(
      ranCommand(box),
      false,
      "the command ran beside a lock nobody read",
    );
    assert.notEqual(
      refused.status,
      failed.status,
      "an unreadable lock path and a failure now report the same code",
    );
    assert.notEqual(
      EXIT_LOCK_PATH_UNUSABLE,
      EXIT_LOCK_HELD,
      "an unreadable lock path and contention now report the same code",
    );
    assert.equal(EXIT_LOCK_PATH_UNUSABLE, 78, "EX_CONFIG, per sysexits.h");
  });
});

describe("a refusal code returned by the wrapped command itself", () => {
  // The header once claimed that neither `tsc`, `node --test` nor `npm` exits
  // 75 or 78, "so it never collides with a real child code". Measured on
  // 2026-09-22 that is false for npm, which hands back a script's own code
  // verbatim — and `npm run …` is what this wrapper wraps at every wired
  // path. These cases pin what is actually true: the child's code comes back
  // untouched, and within ONE wrapper it is this process's own transcript
  // that tells a refusal from a pass-through. (Only within one wrapper: the
  // child's stderr is inherited, so a nested wrapper's REFUSED lines reach
  // the top of a real build too. The child here is a bare `node -e`, which
  // prints nothing, so this case judges only the wrapper's own output.)
  for (const code of [EXIT_LOCK_HELD, EXIT_LOCK_PATH_UNUSABLE]) {
    it(`passes ${code} through unchanged, and the command did run`, (t) => {
      const box = sandbox(t);

      const run = runLock(box, touch(code));

      assert.equal(run.status, code, run.stderr);
      assert.equal(ranCommand(box), true, "the wrapped command never ran");
      assert.doesNotMatch(
        run.stderr,
        /REFUSED/,
        "a command that ran was reported as a refusal",
      );
      assert.equal(lockExists(box), false, "the lock outlived the child");
    });
  }

  it("is told from a real refusal by the transcript, not by the number", (t) => {
    const box = sandbox(t);

    // A child that chose 75 itself, having run.
    const passed = runLock(box, touch(EXIT_LOCK_HELD));
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    fs.rmSync(box.sentinel);

    // The wrapper choosing 75 itself, having run nothing.
    writeLock(box, {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      command: "npm run build:all",
    });
    const refused = runLock(box, touch(EXIT_LOCK_HELD));
    assert.equal(ranCommand(box), false, "the command ran despite the lock");

    // The number does NOT separate them. Asserted rather than lamented: the
    // day it stops being true the contract has changed, and the header
    // section "75 and 78 are not reserved" has to change with it.
    assert.equal(
      passed.status,
      refused.status,
      "the code now separates a child's 75 from a refusal — update the header",
    );
    // The transcript does separate them, and here it is the only thing that
    // does. Both halves matter: the refusal says so, the pass-through does
    // not say so.
    assert.match(refused.stderr, /REFUSED/);
    assert.match(refused.stderr, /The command did NOT run/);
    assert.doesNotMatch(
      passed.stderr,
      /REFUSED/,
      "a command that ran was reported as a refusal",
    );
    assert.doesNotMatch(
      passed.stderr,
      /The command did NOT run/,
      "a command that ran was reported as never having started",
    );
  });
});

describe("the spawn-failure code", () => {
  it("is 127 when the command cannot be spawned at all — the command and the errno are named, and the lock is released", (t) => {
    const box = sandbox(t);
    // A name that is on nobody's PATH: nothing has ever created it, and the
    // suffix is fresh for every run. Not a real binary that happens to be
    // absent here, which would make the case true or false per host. Only
    // letters, digits and hyphens, so it can go into a RegExp as it is.
    const command = `no-such-command-${randomUUID()}`;

    const run = runLock(box, [command]);

    // 127 by shell convention — "command not found", which is what happened.
    // Not 70: nothing in the script failed. Not the child's code: there was
    // no child. And not either refusal: the lock WAS taken.
    assert.equal(run.status, EXIT_SPAWN_FAILED, run.stderr);
    assert.equal(EXIT_SPAWN_FAILED, 127, "the shell's command-not-found code");
    // The operator has to see WHICH command and WHY from the transcript
    // alone: the name as given, and the errno the OS answered with.
    assert.match(
      run.stderr,
      new RegExp(`could not run \`${command}\`: .*ENOENT`),
      "the failed spawn does not name the command and its errno",
    );
    // The lock was acquired before the spawn and the spawn failed after it.
    // The release still has to happen, or a typo in one build script wedges
    // the next real build behind a hold nobody is holding.
    assert.equal(lockExists(box), false, "the lock outlived the failed spawn");
    assert.doesNotMatch(
      run.stderr,
      /REFUSED/,
      "a spawn failure was reported as a refusal to run",
    );
    assert.doesNotMatch(
      run.stderr,
      /unexpected failure/,
      "a command that does not exist was reported as a bug in the script",
    );
    assert.deepEqual(
      fs.readdirSync(box.dir).filter((name) => name.endsWith(".tmp")),
      [],
      "the acquire left its staging file behind",
    );
  });
});

// ── the holder's identity ───────────────────────────────────────────────────
//
// A pid alone is not an identity: the kernel hands the same number out again
// once its owner is reaped, and on a busy CI box that happens within minutes.
// A lock that trusts the bare number therefore becomes immortal the moment
// anything else lands on that pid — the wrapper then refuses every build, for
// as long as the recycled process happens to live. The second half of the
// identity is the process's start time, which a recycled pid cannot carry.
//
// The cases below are written around the two ways that discriminator can be
// wrong, because they cost opposite things: a start time that is ignored
// wedges the repo, and a start time that drifts (with the timezone, say)
// breaks a live builder's lock out from under it.

/**
 * A start-time signature that no live process can ever produce. It is not in
 * either of the two shapes the script emits ("proc:<ticks>" on Linux,
 * "ps:<lstart>" elsewhere), so "the live pid does not match this" is true on
 * every platform, without the test having to know which one it is on.
 */
const NOT_ANY_LIVE_PROCESS = "start-time-of-a-process-that-is-not-this-one";

/**
 * The environment `runLock` builds, for the cases that need to spawn
 * something other than the wrapper (an observer, a helper that imports the
 * module). Mirrors `runLock`, including the deletion of the inherited token.
 */
function lockEnv(box, extra = {}) {
  const env = {
    ...process.env,
    TESSERA_BUILD_LOCK: box.lockFile,
    SCRIPT: LOCK_SCRIPT,
    SENTINEL: box.sentinel,
    SNAPSHOT: box.snapshot,
    FOREIGN: box.foreign,
  };
  delete env.TESSERA_BUILD_LOCK_OWNER;
  delete env.TESSERA_BUILD_LOCK_WAIT;
  return { ...env, ...extra };
}

describe("a hold whose pid was recycled", () => {
  it("is broken, even though that pid is alive right now", (t) => {
    const box = sandbox(t);

    // The defect this whole identity scheme exists to fix, in the only form
    // that can be built deterministically: a pid that is certainly alive
    // (ours — this test process is running) recorded next to a start time
    // that is certainly not its own. That is precisely what the file looks
    // like after the real holder died and the number was handed out again.
    writeLock(box, {
      pid: process.pid,
      owner: "the-hold-of-a-process-that-has-since-died",
      holderStart: NOT_ANY_LIVE_PROCESS,
      acquiredAt: new Date().toISOString(),
      command: "npm run build:all",
    });

    const run = runLock(box, touch(0));

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "a recycled pid wedged the build");
    assert.match(run.stderr, /STALE/);
    assert.match(run.stderr, /recycled/);
    // Not merely "it ran": the run must also have taken and released a lock of
    // its own, so the file left behind is nobody's.
    assert.equal(lockExists(box), false, "the recycled hold outlived the run");
  });

  it("is what makes it breakable — the same live pid without one is honoured", (t) => {
    const box = sandbox(t);

    // The control for the case above. Identical lock, identical live pid, the
    // start time removed. If this one is also broken, the case above proves
    // nothing about the start time: it would only be showing that this suite
    // can break any lock at all.
    writeLock(box, {
      pid: process.pid,
      owner: "the-hold-of-a-process-that-has-since-died",
      acquiredAt: new Date().toISOString(),
      command: "npm run build:all",
    });

    const run = runLock(box, touch(0));

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "a live holder was ignored");
    assert.equal(lockExists(box), true, "a live holder's lock was removed");
  });

  it("is not confused with a holder that is genuinely gone", (t) => {
    const box = sandbox(t);

    // The other half of the discriminator: a start time is recorded AND the
    // pid is gone. The two pieces of evidence must not cancel each other out
    // — a lock whose holder is dead is reclaimable whether or not it carries
    // a start time, or every SIGKILLed build wedges the repo permanently.
    writeLock(box, {
      pid: deadPid(),
      owner: "the-hold-of-a-SIGKILLed-build",
      holderStart: NOT_ANY_LIVE_PROCESS,
      acquiredAt: new Date().toISOString(),
      command: "npm run build:all",
    });

    const run = runLock(box, touch(0));

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "a dead holder's lock was honoured");
    assert.match(run.stderr, /STALE/);
    assert.match(run.stderr, /gone|ESRCH/);
    assert.equal(lockExists(box), false, "the dead hold outlived the run");
  });
});

/** Poll until `condition` holds, failing the test after `ms`. */
async function until(condition, ms, what) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Kill by pid, tolerating a process that is already gone. */
function killQuietly(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

// ── the opt-in bounded wait (TESSERA_BUILD_LOCK_WAIT) ───────────────────────
//
// Off by default, and the default must stay the immediate refusal byte for
// byte. When asked for, it may only ever end in a real acquire or in the same
// 75 refusal — never in the command running without the lock — and a nested
// run must never wait, least of all on its own parent.

const WAITING_LINE = /waiting up to \d+s for it to free/g;
const countWaitingLines = (stderr) => (stderr.match(WAITING_LINE) ?? []).length;

/** A live, hand-written hold: this test runner is definitionally alive. */
const LIVE_HOLD = {
  pid: process.pid,
  owner: "a-live-hold-this-run-must-not-enter",
  acquiredAt: "2026-01-02T03:04:05.000Z",
  command: "npm run build:all",
};

/** Start the wrapper without blocking, collecting its stderr as it arrives. */
function startLock(box, args, extra = {}) {
  const child = spawn(process.execPath, [LOCK_SCRIPT, ...args], {
    cwd: box.dir,
    env: lockEnv(box, extra),
    stdio: ["ignore", "ignore", "pipe"],
  });
  const state = { stderr: "", status: undefined };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk;
  });
  state.done = new Promise((resolve) => {
    child.on("close", (code) => {
      state.status = code;
      resolve(state);
    });
  });
  state.child = child;
  return state;
}

describe("the opt-in wait", () => {
  it("is not taken when unset or 0 — the refusal is immediate and byte for byte the contract", (t) => {
    const box = sandbox(t);
    writeLock(box, LIVE_HOLD);
    const when = new Date(LIVE_HOLD.acquiredAt);
    const hhmm =
      `${String(when.getHours()).padStart(2, "0")}:` +
      `${String(when.getMinutes()).padStart(2, "0")}`;
    const expected =
      [
        `build-lock: REFUSED — lock held by PID ${process.pid} since ${hhmm}.`,
        "build-lock:   it is running: npm run build:all",
        `build-lock:   lock file: ${box.lockFile}`,
        "build-lock: The command did NOT run. Exiting 75 (lock held, nothing " +
          "started) — distinct from the codes this wrapper's own failures use.",
        "build-lock: Nothing waits by design; re-run once the other job finishes.",
      ].join("\n") + "\n";

    for (const extra of [
      {},
      { TESSERA_BUILD_LOCK_WAIT: "" },
      { TESSERA_BUILD_LOCK_WAIT: "0" },
    ]) {
      const run = runLock(box, touch(0), extra);
      assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
      assert.equal(ranCommand(box), false, "the command ran despite the lock");
      assert.equal(run.stderr, expected, JSON.stringify(extra));
    }
    assert.deepEqual(lockPayload(box), LIVE_HOLD, "a refusal touched the hold");
  });

  it("waits for a live holder to release, then acquires and runs", async (t) => {
    const box = sandbox(t);
    const go = path.join(box.dir, "go");
    // A real wrapper holding the real lock until told to finish. The held
    // command also ends itself after 30 s, so a failing case cannot leave an
    // orphan holding this runner's stderr pipe open forever.
    const holder = startLock(
      box,
      [
        process.execPath,
        "-e",
        `const fs = require("node:fs");` +
          `fs.writeFileSync(process.env.SNAPSHOT, "held");` +
          `const t = setInterval(() => {` +
          ` if (fs.existsSync(process.env.GO)) clearInterval(t); }, 20);` +
          `setTimeout(() => process.exit(0), 30000).unref();`,
      ],
      { GO: go },
    );
    const stop = (run) => {
      killQuietly(run.child.pid, "SIGKILL");
      run.child.stderr.destroy();
    };
    t.after(() => {
      try {
        fs.writeFileSync(go, "");
      } catch {
        // The sandbox may already be gone; the 30 s self-exit still holds.
      }
      stop(holder);
    });
    await until(() => fs.existsSync(box.snapshot), 10000, "the holder to hold");

    const waiter = startLock(box, touch(0), { TESSERA_BUILD_LOCK_WAIT: "60" });
    t.after(() => stop(waiter));
    await until(
      () => countWaitingLines(waiter.stderr) > 0,
      10000,
      "the waiter to announce its wait",
    );
    // Held for a while longer: several polls must come and go without
    // running the command or breaking the live hold.
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(
      waiter.status,
      undefined,
      `the waiter gave up: ${waiter.stderr}`,
    );
    assert.equal(ranCommand(box), false, "the waiter ran under a live hold");
    assert.match(waiter.stderr, new RegExp(`held by PID ${holder.child.pid}`));

    fs.writeFileSync(go, "");
    const [held, waited] = await Promise.all([holder.done, waiter.done]);

    assert.equal(held.status, 0, held.stderr);
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(ranCommand(box), true, "the waiter never ran its command");
    assert.equal(countWaitingLines(waited.stderr), 1, waited.stderr);
    assert.match(waited.stderr, /acquired after waiting \d+\.\ds/);
    assert.doesNotMatch(waited.stderr, /REFUSED|STALE/);
    assert.equal(lockExists(box), false, "the lock outlived the waiter");
  });

  it("refuses 75 on the deadline, exactly as without a wait, and says how long it waited", (t) => {
    const box = sandbox(t);
    writeLock(box, LIVE_HOLD);
    const before = fs.readFileSync(box.lockFile, "utf8");

    const started = Date.now();
    const run = runLock(box, touch(0), { TESSERA_BUILD_LOCK_WAIT: "1" });
    const elapsed = Date.now() - started;

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran after the deadline");
    assert.ok(
      elapsed >= 1000,
      `gave up after ${elapsed} ms, before the deadline`,
    );
    assert.equal(countWaitingLines(run.stderr), 1, run.stderr);
    assert.match(run.stderr, /waiting up to 1s .*TESSERA_BUILD_LOCK_WAIT=1/);
    assert.match(
      run.stderr,
      new RegExp(`REFUSED — lock held by PID ${process.pid}`),
    );
    assert.match(run.stderr, /The command did NOT run\. Exiting 75/);
    assert.match(
      run.stderr,
      /Waited \d+\.\ds \(TESSERA_BUILD_LOCK_WAIT=1\) and the lock was not freed in time\./,
    );
    assert.doesNotMatch(run.stderr, /Nothing waits by design/);
    assert.equal(
      fs.readFileSync(box.lockFile, "utf8"),
      before,
      "the hold was touched",
    );
  });

  it("is a usage error, not contention, when the value is not 0..1800 whole seconds", (t) => {
    const invalid = [
      "-1",
      "1.5",
      "5s",
      " 5",
      "5 ",
      "+5",
      "0x10",
      "1e3",
      "abc",
      "1801",
      "99999999999999999999",
    ];
    // Unheld first: a value wrongly accepted here runs the command and exits
    // 0 at once, instead of waiting out a live hold for up to that long.
    const free = sandbox(t);
    for (const value of invalid) {
      const run = runLock(free, touch(0), { TESSERA_BUILD_LOCK_WAIT: value });
      assert.equal(
        run.status,
        EXIT_USAGE,
        `${JSON.stringify(value)}: ${run.stderr}`,
      );
      assert.equal(
        ranCommand(free),
        false,
        `${JSON.stringify(value)} ran the command`,
      );
      assert.equal(lockExists(free), false, "a usage error left a lock behind");
      assert.match(
        run.stderr,
        /TESSERA_BUILD_LOCK_WAIT must be a whole number of seconds from 0 to 1800/,
      );
    }

    // Held: the usage error wins over contention — 64, never 75.
    const box = sandbox(t);
    writeLock(box, LIVE_HOLD);
    for (const value of invalid) {
      const run = runLock(box, touch(0), { TESSERA_BUILD_LOCK_WAIT: value });
      assert.equal(
        run.status,
        EXIT_USAGE,
        `${JSON.stringify(value)}: ${run.stderr}`,
      );
      assert.equal(ranCommand(box), false);
      assert.doesNotMatch(run.stderr, /REFUSED|waiting up to/);
    }
    assert.deepEqual(
      lockPayload(box),
      LIVE_HOLD,
      "a usage error touched the hold",
    );
  });

  it("accepts the ceiling itself, and an uncontended run never waits", (t) => {
    const box = sandbox(t);
    const run = runLock(box, touch(0), { TESSERA_BUILD_LOCK_WAIT: "1800" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true);
    assert.equal(countWaitingLines(run.stderr), 0, run.stderr);
  });

  it("does not wait on a stale lock — it is broken at once, as without a wait", (t) => {
    const box = sandbox(t);
    writeLock(box, { ...LIVE_HOLD, pid: deadPid() });
    const run = runLock(box, touch(0), { TESSERA_BUILD_LOCK_WAIT: "30" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true);
    assert.match(run.stderr, /breaking STALE lock/);
    assert.equal(countWaitingLines(run.stderr), 0, run.stderr);
  });

  it("does not wait on a lock path that cannot be read — 78 at once", (t) => {
    const box = sandbox(t);
    fs.mkdirSync(box.lockFile);
    const started = Date.now();
    const run = runLock(box, touch(0), { TESSERA_BUILD_LOCK_WAIT: "20" });
    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(ranCommand(box), false);
    assert.equal(countWaitingLines(run.stderr), 0, run.stderr);
    assert.ok(Date.now() - started < 10000, "waited on an unusable path");
  });

  it("is never taken by a re-entrant child — it passes through under its parent's hold", (t) => {
    const box = sandbox(t);
    // The outer run carries the variable, so the nested wrapper inherits it.
    const started = Date.now();
    const run = runLock(box, [process.execPath, LOCK_SCRIPT, ...touch(0)], {
      TESSERA_BUILD_LOCK_WAIT: "20",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "the nested command never ran");
    assert.match(run.stderr, /re-entrant/);
    assert.equal(countWaitingLines(run.stderr), 0, run.stderr);
    assert.ok(
      Date.now() - started < 10000,
      "the nested run waited on its parent",
    );
  });

  it("is never taken by a nested run whose tree lost the hold — it refuses 75 at once and says why", (t) => {
    const box = sandbox(t);
    writeLock(box, LIVE_HOLD);
    const started = Date.now();
    const run = runLock(box, touch(0), {
      TESSERA_BUILD_LOCK_WAIT: "20",
      TESSERA_BUILD_LOCK_OWNER: "a-token-of-a-hold-that-is-over",
    });
    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false);
    assert.equal(countWaitingLines(run.stderr), 0, run.stderr);
    assert.match(run.stderr, /TESSERA_BUILD_LOCK_WAIT=20 was NOT honoured/);
    assert.ok(Date.now() - started < 10000, "a nested run waited");
  });
});

describe("a holder that was SIGKILLed mid-hold", () => {
  it("is reclaimed by the next run, which breaks its lock as stale and proceeds", async (t) => {
    const box = sandbox(t);
    const childPid = path.join(box.dir, "child.pid");

    // Every other stale case stages a payload that names a dead pid. This one
    // runs the real thing: a wrapper takes the lock for a child that will
    // outlive it, and is then SIGKILLed — no handler, no `exit` listener, the
    // lock left exactly as a crashed build leaves it. The liveness check is
    // the backstop for precisely this, and until here it was only inferred.
    const wrapper = spawn(
      process.execPath,
      [
        LOCK_SCRIPT,
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(process.env.CHILD_PID,` +
          ` String(process.pid));` +
          `setTimeout(() => {}, 10000);`,
      ],
      {
        cwd: box.dir,
        stdio: "ignore",
        env: lockEnv(box, { CHILD_PID: childPid }),
      },
    );
    const exited = new Promise((resolve) => wrapper.once("exit", resolve));
    t.after(() => {
      killQuietly(wrapper.pid, "SIGKILL");
      // The orphan may or may not have been re-parented by now; kill it by
      // the pid it wrote down, and tolerate its already being gone.
      if (fs.existsSync(childPid)) {
        killQuietly(Number(fs.readFileSync(childPid, "utf8")), "SIGKILL");
      }
    });

    await until(
      () =>
        fs.existsSync(childPid) &&
        lockExists(box) &&
        lockPayload(box).pid === wrapper.pid,
      10000,
      "the wrapper to take the lock and start its child",
    );
    process.kill(wrapper.pid, "SIGKILL");
    await exited;

    // Nothing ran on the way out: the lock is still there, naming a pid that
    // no longer exists.
    assert.equal(lockExists(box), true, "SIGKILL somehow released the lock");
    assert.equal(lockPayload(box).pid, wrapper.pid, "the lock was rewritten");

    const run = runLock(box, touch(0));

    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      ranCommand(box),
      true,
      "a SIGKILLed holder's lock blocked the next run",
    );
    // The break is announced with the ESRCH clause — the pid is gone — not
    // the recycled-pid clause, and not silently.
    assert.match(
      run.stderr,
      new RegExp(
        `breaking STALE lock .* holder PID ${wrapper.pid} is gone \\(ESRCH\\)`,
      ),
      "the dead holder was not reported as gone",
    );
    assert.equal(lockExists(box), false, "the reclaimed lock outlived the run");
  });
});

/**
 * From inside a held run, launch the wrapper again as an unrelated tree — the
 * token stripped, exactly like `foreignRerun` — but under a DIFFERENT
 * timezone and locale than the run that recorded the hold.
 */
const foreignRerunUnder = (tz, locale) => [
  process.execPath,
  "-e",
  `const { spawnSync } = require("node:child_process");` +
    `const env = { ...process.env, TZ: ${JSON.stringify(tz)},` +
    ` LC_ALL: ${JSON.stringify(locale)}, LANG: ${JSON.stringify(locale)} };` +
    `delete env.TESSERA_BUILD_LOCK_OWNER;` +
    `const r = spawnSync(process.execPath, [process.env.SCRIPT,` +
    ` process.execPath, "-e",` +
    ` 'require("node:fs").writeFileSync(process.env.FOREIGN, "ran")'],` +
    ` { env, encoding: "utf8" });` +
    `require("node:fs").writeFileSync(process.env.SNAPSHOT,` +
    ` JSON.stringify({ status: r.status, stderr: r.stderr }));`,
];

describe("a start-time signature", () => {
  it("does not drift with the timezone or locale of the process reading it", (t) => {
    const box = sandbox(t);

    // The expensive failure in the opposite direction. The signature is
    // rendered by an external tool on most platforms, and that tool prints a
    // local, locale-formatted timestamp. If the rendering followed the
    // reader's environment, the same live pid would look like two different
    // processes to two builders — and the second would read that as a
    // recycled pid and break the first one's lock while it was still writing
    // to the tree.
    //
    // Driven end to end: the outer run records its own start time under one
    // timezone; while it is still holding, an unrelated tree challenges the
    // hold under another. The only correct answer is a refusal.
    const run = runLock(box, foreignRerunUnder("Asia/Tokyo", "de_DE.UTF-8"), {
      TZ: "UTC",
      LC_ALL: "C",
      LANG: "C",
    });

    assert.equal(run.status, 0, run.stderr);
    const foreign = snapshotOf(box);
    assert.equal(
      foreign.status,
      EXIT_LOCK_HELD,
      `a live hold was not honoured from another timezone: ${foreign.stderr}`,
    );
    assert.equal(foreignRan(box), false, "two builders ran at once");
    assert.doesNotMatch(
      foreign.stderr,
      /recycled/,
      "a live holder was read as a recycled pid",
    );
    assert.doesNotMatch(foreign.stderr, /STALE/);
  });

  it("is recorded in the lock the wrapper takes", (t) => {
    const box = sandbox(t);

    // Without this the cases above would still pass on an implementation that
    // never writes a start time at all: every lock would simply fall back to
    // the bare pid probe, which is the behaviour they exist to rule out.
    const run = runLock(box, snapshotLock);

    assert.equal(run.status, 0, run.stderr);
    const held = snapshotOf(box);
    assert.equal(typeof held.holderStart, "string");
    assert.notEqual(held.holderStart, "", "the hold carries no start time");
  });
});

// ── the create is the whole lock ────────────────────────────────────────────
//
// Creating the name and filling it are two steps, and between them the lock
// file exists while saying nothing. Any reader arriving in that window sees a
// lock it cannot attribute — and an unattributable lock is classified as
// stale, so the gap does not merely confuse a reader, it invites it to break
// a hold that was being taken correctly. Publishing has to be one step: the
// content is written somewhere else and the NAME appears already complete.

/**
 * Watch the lock file as fast as the filesystem will answer, and record every
 * observation that is not a complete, attributable hold. Runs as its own
 * process so that it is genuinely concurrent with the acquires it watches.
 */
const OBSERVER_SOURCE = [
  `import fs from "node:fs";`,
  `const lockFile = process.env.TESSERA_BUILD_LOCK;`,
  `const bad = [];`,
  `let observations = 0;`,
  `const deadline = Date.now() + 30000;`,
  `while (!fs.existsSync(process.env.STOP) && Date.now() < deadline) {`,
  `  let raw;`,
  `  try {`,
  `    raw = fs.readFileSync(lockFile, "utf8");`,
  `  } catch {`,
  `    continue;`, // no lock right now: nothing to judge
  `  }`,
  `  observations += 1;`,
  `  let held;`,
  `  try {`,
  `    held = JSON.parse(raw);`,
  `  } catch {`,
  `    bad.push("unparseable, " + raw.length + " bytes");`,
  `    continue;`,
  `  }`,
  `  if (!held || typeof held.owner !== "string" || held.owner === "") {`,
  `    bad.push("no owner, " + raw.length + " bytes");`,
  `  } else if (!Number.isInteger(held.pid)) {`,
  `    bad.push("no pid, " + raw.length + " bytes");`,
  `  }`,
  `}`,
  `fs.writeFileSync(`,
  `  process.env.OBSERVATIONS,`,
  `  JSON.stringify({ observations, bad: bad.slice(0, 5), badCount: bad.length }),`,
  `);`,
].join("\n");

describe("the acquire", () => {
  it("never leaves the lock name carrying partial or unattributable content", async (t) => {
    const box = sandbox(t);
    const observer = path.join(box.dir, "observer.mjs");
    const stop = path.join(box.dir, "stop");
    const observations = path.join(box.dir, "observations.json");
    fs.writeFileSync(observer, OBSERVER_SOURCE);

    const watching = spawn(process.execPath, [observer], {
      cwd: box.dir,
      stdio: "ignore",
      env: lockEnv(box, { STOP: stop, OBSERVATIONS: observations }),
    });
    const watched = new Promise((resolve) => watching.on("close", resolve));
    t.after(() => watching.kill("SIGKILL"));

    // A very wide argument makes the recorded command — and so the payload —
    // about 100 KB. The point is to widen the create-then-fill window until
    // an observer at this speed cannot miss it: an implementation with that
    // window loses this test by hundreds of observations, not by one.
    const wide = "x".repeat(100_000);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const run = runLock(box, [process.execPath, "-e", "0", wide]);
      assert.equal(run.status, 0, run.stderr);
    }
    fs.writeFileSync(stop, "");
    await watched;

    const seen = JSON.parse(fs.readFileSync(observations, "utf8"));
    // Non-vacuity first: a watcher that saw nothing proves nothing.
    assert.ok(
      seen.observations > 0,
      "the observer never caught the lock file in place",
    );
    assert.deepEqual(
      seen.bad,
      [],
      `the lock name existed without a complete hold ` +
        `(${seen.badCount} of ${seen.observations} observations)`,
    );
  });

  it("is won by exactly one of several concurrent runs", async (t) => {
    const box = sandbox(t);

    // The property the whole file is for, stated without any staging: six
    // wrappers, one tree. Every wrapped command marks its own arrival and
    // then holds for long enough that the others must overlap it, so "one
    // exit code was 0" and "one command ran" are checked separately — an
    // implementation that let two through would fail both.
    const hold =
      `require("node:fs").writeFileSync(process.env.SENTINEL, "ran", ` +
      `{ flag: "a" });` +
      `const until = Date.now() + 300; while (Date.now() < until);`;
    const codes = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise((resolve) => {
            const child = spawn(
              process.execPath,
              [LOCK_SCRIPT, process.execPath, "-e", hold],
              { cwd: box.dir, stdio: "ignore", env: lockEnv(box) },
            );
            child.on("close", (code) => resolve(code));
          }),
      ),
    );

    const won = codes.filter((code) => code === 0);
    const refused = codes.filter((code) => code === EXIT_LOCK_HELD);
    assert.equal(won.length, 1, `codes were ${codes.join(", ")}`);
    assert.equal(refused.length, 5, `codes were ${codes.join(", ")}`);
    assert.equal(
      fs.readFileSync(box.sentinel, "utf8"),
      "ran",
      "more than one wrapped command ran",
    );
    assert.equal(lockExists(box), false, "the winner did not release");
    assert.deepEqual(
      fs.readdirSync(box.dir).filter((name) => name.endsWith(".tmp")),
      [],
      "an acquire left its staging file behind",
    );
  });
});

// ── a filesystem without hard links degrades loudly, not silently ───────────
//
// When link() is not available the create falls back to the two-step shape
// the header spends a section warning about. That is allowed, on two terms:
// the operator is told, every time, and the fallback still excludes — what is
// lost is the microsecond window, not the lock.

/**
 * Preloaded into the WRAPPER with `node --import`, this makes every link()
 * fail the way a filesystem without hard links does. The script calls
 * `fs.linkSync` on the default `node:fs` export, an object shared by every
 * importer, so the patch reaches it without this suite importing anything
 * from the module. The wrapped command is spawned without the preload.
 */
const NO_HARD_LINKS_SOURCE = [
  `import fs from "node:fs";`,
  `fs.linkSync = () => {`,
  `  const error = new Error("ENOTSUP: operation not supported, link");`,
  `  error.code = "ENOTSUP";`,
  `  error.syscall = "link";`,
  `  throw error;`,
  `};`,
].join("\n");

/** `runLock`, with the wrapper's link() disabled. */
function runLockWithoutHardLinks(box, args) {
  const patch = path.join(box.dir, "no-hard-links.mjs");
  fs.writeFileSync(patch, NO_HARD_LINKS_SOURCE);
  return spawnSync(
    process.execPath,
    ["--import", patch, LOCK_SCRIPT, ...args],
    { cwd: box.dir, encoding: "utf8", env: lockEnv(box, { PATCH: patch }) },
  );
}

/**
 * From inside a held run, launch the wrapper again as an unrelated tree —
 * exactly like `foreignRerun` — with the same link() patch preloaded, so both
 * holders are on the degraded path.
 */
const foreignRerunWithoutHardLinks = [
  process.execPath,
  "-e",
  `const { spawnSync } = require("node:child_process");` +
    `const env = { ...process.env };` +
    `delete env.TESSERA_BUILD_LOCK_OWNER;` +
    `const r = spawnSync(process.execPath, ["--import", process.env.PATCH,` +
    ` process.env.SCRIPT, process.execPath, "-e",` +
    ` 'require("node:fs").writeFileSync(process.env.FOREIGN, "ran")'],` +
    ` { env, encoding: "utf8" });` +
    `require("node:fs").writeFileSync(process.env.SNAPSHOT,` +
    ` JSON.stringify({ status: r.status, stderr: r.stderr }));`,
];

const DEGRADED_WARNING = /WARNING: .* cannot hard-link \(ENOTSUP\)/;

describe("a filesystem that cannot hard-link", () => {
  it("is announced on stderr, and the run still locks, runs and releases", (t) => {
    const box = sandbox(t);

    const run = runLockWithoutHardLinks(box, touch(0));

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    assert.equal(lockExists(box), false, "the lock outlived the run");
    // The whole terms of the fallback: it may happen, but never quietly.
    assert.match(
      run.stderr,
      DEGRADED_WARNING,
      "the protection degraded without saying so",
    );
    assert.deepEqual(
      fs.readdirSync(box.dir).filter((name) => name.endsWith(".tmp")),
      [],
      "the fallback left its staging file behind",
    );
  });

  it("still admits exactly one holder — a second wrapper is refused", (t) => {
    const box = sandbox(t);

    const run = runLockWithoutHardLinks(box, foreignRerunWithoutHardLinks);

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, DEGRADED_WARNING);
    const foreign = snapshotOf(box);
    // The fallback is O_EXCL: it gives up the atomic content, not the
    // exclusion. A second holder getting through here is the two-builders
    // failure, reached through the code that exists to prevent it.
    assert.equal(
      foreign.status,
      EXIT_LOCK_HELD,
      `a second holder got in on the degraded path: ${foreign.stderr}`,
    );
    assert.equal(foreignRan(box), false, "two builders ran at once");
    assert.match(foreign.stderr, DEGRADED_WARNING);
    assert.match(foreign.stderr, /REFUSED/);
    assert.equal(lockExists(box), false, "the lock outlived the run");
  });

  it("is not what a working link() reports — neither on a create nor on a refusal", (t) => {
    const box = sandbox(t);

    // The negative half, without which the cases above cannot tell a warning
    // that fires when it should from one that fires always.
    const created = runLock(box, touch(0));
    assert.equal(created.status, 0, created.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    assert.doesNotMatch(
      created.stderr,
      /cannot hard-link/,
      "a working link() was reported as degraded",
    );
    fs.rmSync(box.sentinel);

    // And an EEXIST from link() means "held", not "unsupported": it must be a
    // refusal, with no warning and no trip through the non-atomic fallback.
    writeLock(box, {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      command: "npm run build:all",
    });
    const refused = runLock(box, touch(0));
    assert.equal(refused.status, EXIT_LOCK_HELD, refused.stderr);
    assert.equal(ranCommand(box), false, "the command ran despite the lock");
    assert.doesNotMatch(
      refused.stderr,
      /cannot hard-link/,
      "an EEXIST from link() was reported as an unsupported link()",
    );
  });
});

// ── breaking a stale lock is itself a race ──────────────────────────────────
//
// Proving a lock stale takes time, and the file can change while the proof is
// being made: the holder releases, someone else acquires, and the unlink that
// follows deletes a hold that was never examined. The window cannot be closed
// without an OS primitive this script does not have, but it can be narrowed
// to the instruction before the unlink by re-reading and refusing on any
// difference.
//
// Driving that deterministically needs a lock file whose two reads differ by
// construction, which is what a FIFO is: every read consumes one queued
// payload. The wrapper cannot tell it from a slow filesystem.

/** Run the wrapper with a hard time limit — these cases can only hang. */
function runLockBounded(box, args, extra = {}) {
  return spawnSync(process.execPath, [LOCK_SCRIPT, ...args], {
    cwd: box.dir,
    encoding: "utf8",
    env: lockEnv(box, extra),
    timeout: 15000,
    killSignal: "SIGKILL",
  });
}

/**
 * Replace the lock path with a FIFO that answers each read with the next of
 * `payloads`, in order. Returns false where FIFOs are not available, so the
 * case can skip rather than fail for the wrong reason.
 */
function queueLockReads(t, box, payloads) {
  if (spawnSync("mkfifo", [box.lockFile]).status !== 0) return false;
  const env = { ...process.env, FIFO: box.lockFile };
  const script = payloads
    .map((payload, index) => {
      const file = path.join(box.dir, `read-${index}.json`);
      fs.writeFileSync(file, payload);
      env[`READ_${index}`] = file;
      return `cat "$READ_${index}" > "$FIFO"`;
    })
    // The pause is what keeps one read to one payload. The wrapper reads to
    // EOF, and EOF only arrives once no writer holds the FIFO open: a `cat`
    // that opens it before the reader has seen the previous one close joins
    // the same read, and two payloads arrive as one invalid JSON document
    // (the 2026-09-23 flake — "payload is not valid JSON", then a hang on a
    // read nobody answers). A new reader still blocks until the next `cat`
    // opens, so the pause only costs time, never ordering.
    .join("; sleep 0.25; ");
  const writer = spawn("sh", ["-c", script], {
    detached: true,
    stdio: "ignore",
    env,
  });
  // Detached, and killed as a group: a `cat` blocked opening a FIFO that has
  // since been unlinked can never be woken, and would outlive the run.
  t.after(() => {
    try {
      process.kill(-writer.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  });
  return true;
}

const staleHold = () =>
  `${JSON.stringify(
    {
      pid: deadPid(),
      owner: "the-hold-of-a-build-that-was-killed",
      holderStart: NOT_ANY_LIVE_PROCESS,
      acquiredAt: new Date().toISOString(),
      command: "npm run build:all",
    },
    null,
    2,
  )}\n`;

const liveHold = () =>
  `${JSON.stringify(
    {
      pid: process.pid,
      owner: "the-hold-of-a-builder-that-just-arrived",
      acquiredAt: new Date().toISOString(),
      command: "a live builder that arrived",
    },
    null,
    2,
  )}\n`;

describe("breaking a stale lock", () => {
  it("goes ahead when the file is unchanged between the proof and the unlink", (t) => {
    const box = sandbox(t);
    // Two reads: the one the staleness verdict is made on, and the re-read
    // immediately before the unlink. Identical, so the verdict still holds.
    const stale = staleHold();
    if (!queueLockReads(t, box, [stale, stale])) {
      t.skip("mkfifo is unavailable here");
      return;
    }

    const run = runLockBounded(box, touch(0));

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "a proven-stale lock was not broken");
    assert.match(run.stderr, /STALE/);
    assert.equal(lockExists(box), false, "the run left a lock behind");
    assert.doesNotMatch(
      run.stderr,
      /NOT broken/,
      "a break that went ahead was reported as abandoned",
    );
  });

  it("is abandoned when the file changed between the proof and the unlink", (t) => {
    const box = sandbox(t);
    // The dangerous interleaving, made deterministic: the verdict is made on
    // a dead holder's payload, and by the re-read a live builder holds the
    // lock. Unlinking now would delete a hold nobody ever examined. The third
    // payload is what the refusal message is written from.
    const live = liveHold();
    if (!queueLockReads(t, box, [staleHold(), live, live])) {
      t.skip("mkfifo is unavailable here");
      return;
    }

    const run = runLockBounded(box, touch(0));

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran beside a live hold");
    assert.match(run.stderr, /STALE/, "the staleness verdict was never made");
    assert.match(run.stderr, /REFUSED/);
    assert.equal(
      lockExists(box),
      true,
      "the unlink went ahead on a file that had changed",
    );
    // The verdict was announced BEFORE the attempt, so the abandonment has to
    // be announced too — after it — or the transcript claims an unlink that
    // never happened, to a reader who cannot tell.
    assert.match(
      run.stderr,
      /NOT broken — .* changed between the proof and the unlink/,
      "the abandoned break was not announced",
    );
    assert.ok(
      run.stderr.indexOf("NOT broken") > run.stderr.indexOf("breaking STALE"),
      "the abandonment was not reported as a follow-up to the verdict",
    );
  });

  it("does not break a second lock when the re-create loses the race", (t) => {
    const box = sandbox(t);
    // The same abandoned break as above, and then the re-create finds a lock
    // there again. That second EEXIST is somebody real, arriving inside a
    // window this process cannot see into. One break per acquire is the whole
    // rule: a wrapper that kept breaking whatever looked stale would walk the
    // entire queue of waiting builders, one lock at a time.
    //
    // Three reads are queued, which is every read a correct run makes. A run
    // that goes back for a fourth is asking for a payload nobody will write.
    if (!queueLockReads(t, box, [staleHold(), liveHold(), staleHold()])) {
      t.skip("mkfifo is unavailable here");
      return;
    }

    const run = runLockBounded(box, touch(0));

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran anyway");
    assert.equal(
      (run.stderr.match(/breaking STALE/g) ?? []).length,
      1,
      "one acquire broke more than one lock",
    );
    assert.match(run.stderr, /REFUSED — lock held by PID/);
    assert.equal(lockExists(box), true, "the second lock was broken too");
  });
});

// ── a caught signal must not leave the process running ──────────────────────
//
// Ctrl-C on a build has to release the lock, or the next build refuses
// against a holder that is already gone. But releasing and CONTINUING is
// worse than not releasing at all: the tree would then be written by a
// process that no longer holds the lock, beside whoever takes it next. So the
// handler has to do both, and the second half is the one a test can forget to
// check — the lock is gone either way.
//
// The state being judged — holding the lock with no child running — has no
// command line that produces it, so these two cases drive the module itself
// inside a child process of their own. What is asserted is still entirely
// process-level: how the child died, and what is on disk afterwards.

const signalHelper = ({ usurped, signal }) =>
  [
    `import { acquire, installSignalHandlers, mintToken } from ${JSON.stringify(
      LOCK_SCRIPT_URL,
    )};`,
    `import fs from "node:fs";`,
    `const lockFile = process.env.TESSERA_BUILD_LOCK;`,
    `installSignalHandlers(lockFile);`,
    `const token = mintToken();`,
    `if (!acquire(lockFile, "a hold with no child", [], token).ok) {`,
    `  process.exit(3);`,
    `}`,
    usurped
      ? `fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid,` +
        ` owner: "a-different-hold-entirely",` +
        ` acquiredAt: new Date().toISOString(),` +
        ` command: "someone else entirely" }));`
      : ``,
    `fs.writeFileSync(process.env.SENTINEL, "held");`,
    // Registered BEFORE the signal, and long enough after it that only a
    // process which survived the handler can still be there to write it.
    `setTimeout(() => {`,
    `  fs.writeFileSync(process.env.FOREIGN, "still running");`,
    `}, 500);`,
    `process.kill(process.pid, ${JSON.stringify(signal)});`,
  ]
    .filter((line) => line !== "")
    .join("\n");

function runSignalHelper(box, options) {
  const helper = path.join(box.dir, "held-with-no-child.mjs");
  fs.writeFileSync(helper, signalHelper(options));
  return spawnSync(process.execPath, [helper], {
    cwd: box.dir,
    encoding: "utf8",
    env: lockEnv(box),
    timeout: 15000,
    killSignal: "SIGKILL",
  });
}

describe("a caught signal", () => {
  // Both signals are wired to one handler in the source, but "they share a
  // handler" is a claim about the source; whether each one is actually caught
  // is measured here, one signal at a time.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    it(`${signal}: releases the lock and dies of that signal, rather than carrying on`, (t) => {
      const box = sandbox(t);

      const run = runSignalHelper(box, { usurped: false, signal });

      assert.equal(ranCommand(box), true, "the helper never took the lock");
      // The disposition, not just the exit code: the process must be reported
      // as killed by the signal it was sent. Exiting 0 — or exiting 128+n by
      // hand — would mean the wrapper had swallowed a signal its own caller is
      // entitled to see.
      assert.equal(run.signal, signal, `status was ${String(run.status)}`);
      assert.equal(run.status, null);
      assert.equal(
        lockExists(box),
        false,
        "the signal did not release the lock",
      );
      assert.equal(
        foreignRan(box),
        false,
        "the process kept running after releasing the lock",
      );
    });

    it(`${signal}: still dies when the lock it holds has already been taken by someone else`, (t) => {
      const box = sandbox(t);

      // The two halves of the handler are independent: refusing to unlink a
      // lock that is no longer ours must not turn into refusing to die. A
      // process that survives here is a process writing to the tree while
      // somebody else holds the lock.
      const run = runSignalHelper(box, { usurped: true, signal });

      assert.equal(ranCommand(box), true, "the helper never took the lock");
      assert.equal(run.signal, signal, `status was ${String(run.status)}`);
      assert.equal(lockExists(box), true, "it deleted a hold it did not own");
      assert.equal(lockPayload(box).owner, "a-different-hold-entirely");
      assert.equal(
        foreignRan(box),
        false,
        "the process kept running after the signal",
      );
      assert.match(run.stderr, /not releasing/);
    });
  }
});

// ── faults at the lock path itself ──────────────────────────────────────────

/**
 * Preloaded into the WRAPPER with `node --import`: scripts what the default
 * `node:fs` export answers for the LOCK PATH ONLY — one call at a time, in
 * order, per method — and passes everything else through, including every
 * call for any other path (the temp sibling, the sentinel). A step is
 * `{ returns }`, or `{ throws: "<CODE>" }` for an error shaped the way the OS
 * raises them (a string `code` and a `syscall`), optionally with
 * `unlinkFirst` so the fault is also true on disk. Once a method's steps are
 * used up its real implementation answers again, so the release at the end
 * sees the real file. The wrapped command is spawned without the preload.
 *
 * @param {{ [method: string]: Array<{ returns?: string, throws?: string,
 *   unlinkFirst?: boolean }> }} spec
 */
function faultSource(spec) {
  return [
    `import fs from "node:fs";`,
    `const lockFile = process.env.TESSERA_BUILD_LOCK;`,
    `const spec = ${JSON.stringify(spec)};`,
    `const realUnlink = fs.unlinkSync;`,
    `for (const [method, steps] of Object.entries(spec)) {`,
    `  const real = fs[method];`,
    // link(existing, NEW): the lock path is the second argument there.
    `  const target = method === "linkSync" ? 1 : 0;`,
    `  fs[method] = (...args) => {`,
    `    if (args[target] !== lockFile || steps.length === 0) {`,
    `      return real.apply(fs, args);`,
    `    }`,
    `    const step = steps.shift();`,
    `    if (step.unlinkFirst) realUnlink(lockFile);`,
    `    if (step.throws) {`,
    `      const error = new Error(step.throws + ": " + method + " faulted by the test");`,
    `      error.code = step.throws;`,
    `      error.syscall = method.replace(/Sync$/, "");`,
    `      throw error;`,
    `    }`,
    `    return step.returns;`,
    `  };`,
    `}`,
  ].join("\n");
}

/** `runLock`, with the wrapper's `fs` scripted at the lock path per `spec`. */
function runLockFaulted(box, spec, args, extra = {}) {
  const patch = path.join(box.dir, "fault.mjs");
  fs.writeFileSync(patch, faultSource(spec));
  return spawnSync(
    process.execPath,
    ["--import", patch, LOCK_SCRIPT, ...args],
    { cwd: box.dir, encoding: "utf8", env: lockEnv(box, extra) },
  );
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The refusal a lock path where no lock can be created must produce. */
const UNCREATABLE_REFUSAL = (code) =>
  new RegExp(`REFUSED — no lock can be created at the lock path \\(${code}\\)`);
/** The refusal a stale lock the path will not let go of must produce. */
const UNREMOVABLE_REFUSAL = (code) =>
  new RegExp(`proved stale but cannot be removed \\(${code}\\)`);
/** Every refusal names the path it is about, verbatim. */
const NAMES_LOCK_FILE = (lockFile) =>
  new RegExp(`lock file: ${escapeRegExp(lockFile)}`);

/** The two indices a transcript-order assertion needs, both proven present. */
function orderOf(stderr, first, second) {
  const a = stderr.indexOf(first);
  const b = stderr.indexOf(second);
  assert.notEqual(a, -1, `"${first}" is missing from: ${stderr}`);
  assert.notEqual(b, -1, `"${second}" is missing from: ${stderr}`);
  return { first: a, second: b };
}

describe("a symlink loop at the lock path", () => {
  it("is refused as unreadable, the command does not run, and the link is left pointing where it did", (t) => {
    const box = sandbox(t);
    // A link to itself: every open() of the lock path ends in ELOOP, which is
    // neither ENOENT (absent) nor bytes (a hold) — the third thing a path can
    // be, and the one an over-eager "gone" reading would break blind.
    fs.symlinkSync(box.lockFile, box.lockFile);

    const run = runLock(box, touch(0));

    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(
      ranCommand(box),
      false,
      "the command ran beside a lock nobody read",
    );
    assert.match(run.stderr, UNREADABLE_REFUSAL("ELOOP"));
    assert.match(run.stderr, NAMES_LOCK_FILE(box.lockFile));
    assert.doesNotMatch(
      run.stderr,
      /breaking STALE/,
      "a break was announced for a link nobody could read through",
    );
    assert.doesNotMatch(
      run.stderr,
      /unexpected failure/,
      "a loop at the configured path was reported as a bug in the script",
    );
    assert.equal(
      fs.lstatSync(box.lockFile).isSymbolicLink(),
      true,
      "the link was replaced or removed",
    );
    assert.equal(
      fs.readlinkSync(box.lockFile),
      box.lockFile,
      "the link now points somewhere else",
    );
  });
});

describe("an inherited token at a lock path nobody can read", () => {
  it("does not re-enter: the run is refused as unreadable and the command does not run", (t) => {
    const box = sandbox(t);
    fs.mkdirSync(box.lockFile);

    // A plausible token in the environment and no readable file to check it
    // against. Re-entry is three checks, and the second — the file carries
    // this very token — cannot pass on bytes that cannot be read.
    const run = runLock(box, touch(0), {
      TESSERA_BUILD_LOCK_OWNER: "12345-plausible-token",
    });

    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(
      ranCommand(box),
      false,
      "the command ran on a token nobody could check against the file",
    );
    assert.doesNotMatch(
      run.stderr,
      /re-entrant/,
      "an unreadable lock path was passed through as our own hold",
    );
    assert.match(run.stderr, UNREADABLE_REFUSAL("EISDIR"));
    assert.equal(
      fs.statSync(box.lockFile).isDirectory(),
      true,
      "what was at the lock path was removed or replaced",
    );
  });
});

/** A wrapped command that records that it ran, then does `mutation` to the lock. */
const runThenMutateLock = (mutation, code) => [
  process.execPath,
  "-e",
  `const fs = require("node:fs");` +
    `const lock = process.env.TESSERA_BUILD_LOCK;` +
    `fs.writeFileSync(process.env.SENTINEL, "ran");` +
    `${mutation}` +
    `process.exitCode = ${code};`,
];

describe("release, when the wrapped command changed what is at the lock path", () => {
  for (const code of [0, 1]) {
    it(`passes ${code} through, silently, when the command removed the lock — nothing left to release is not an error`, (t) => {
      const box = sandbox(t);

      const run = runLock(box, runThenMutateLock(`fs.rmSync(lock);`, code));

      assert.equal(run.status, code, run.stderr);
      assert.equal(ranCommand(box), true, "the wrapped command never ran");
      assert.equal(lockExists(box), false, "a lock reappeared after the run");
      // A gone lock at release is the desired end state, reached by another
      // route. There is nothing to report, and reporting something would
      // invite the reader to go looking for a problem that does not exist.
      assert.equal(run.stderr, "", "a correct outcome was reported as trouble");
    });
  }

  it("keeps the child's exit code and does not unlink bytes that are no longer a lock payload — nor call them a hold", (t) => {
    const box = sandbox(t);

    const run = runLock(
      box,
      runThenMutateLock(`fs.writeFileSync(lock, "not json\\n");`, 3),
    );

    assert.equal(run.status, 3, run.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    assert.equal(
      fs.readFileSync(box.lockFile, "utf8"),
      "not json\n",
      "bytes the wrapper could not prove its own were unlinked or rewritten",
    );
    assert.match(run.stderr, /not releasing/);
    assert.match(
      run.stderr,
      /no longer a lock payload \(payload is not valid JSON\)/,
    );
    // Bytes with no pid in them are nobody's hold; the transcript must not
    // invent one — "PID undefined" is a hold that does not exist.
    assert.doesNotMatch(
      run.stderr,
      /hold of PID/,
      "unparseable bytes were described as somebody's hold",
    );
    assert.doesNotMatch(run.stderr, /unexpected failure/);
    // The line says what the next run will do about it; hold it to that.
    const next = runLock(box, touch(0));
    assert.equal(next.status, 0, next.stderr);
    assert.match(
      next.stderr,
      /breaking STALE lock .* payload is not valid JSON/,
    );
    assert.equal(lockExists(box), false, "the lock outlived the next run");
  });

  it("leaves a lock path it can no longer read exactly as found, says so once, and still reports the child's exit code", (t) => {
    const box = sandbox(t);

    // The lock is gone and a directory stands in its place when the release
    // runs: EISDIR on the re-read, so whether the path still carries our
    // token cannot be established — and an unlink without that proof is the
    // blind delete the release exists to avoid.
    const run = runLock(
      box,
      runThenMutateLock(`fs.rmSync(lock); fs.mkdirSync(lock);`, 3),
    );

    // The child finished and exited 3; that number is the build's result and
    // the wrapper's housekeeping trouble afterwards must not replace it —
    // not with 70 ("a bug in this script": it is not), not with 78 ("the
    // command never ran": it did).
    assert.equal(run.status, 3, run.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    // existsSync first: a release that removed the directory blind must fail
    // this assertion, not throw ENOENT out of its operand.
    assert.equal(
      fs.existsSync(box.lockFile) && fs.statSync(box.lockFile).isDirectory(),
      true,
      "what was at the lock path was removed or replaced",
    );
    assert.match(
      run.stderr,
      /not releasing .*: the lock path cannot be read \(EISDIR\)/,
    );
    assert.match(run.stderr, /left exactly as found/);
    assert.match(run.stderr, /The next run will refuse it \(exit 78\)/);
    assert.doesNotMatch(
      run.stderr,
      /unexpected failure/,
      "a fault at the configured path was reported as a bug in the script",
    );
    assert.doesNotMatch(
      run.stderr,
      /EISDIR: illegal operation/,
      "a raw exception escaped the release",
    );
    // `finally` and the `exit` listener both release; the finding is said once.
    assert.equal(
      run.stderr.match(/not releasing/g).length,
      1,
      "the release reported the same finding twice",
    );
    // The claim about the next run is true.
    const next = runLock(box, touch(0));
    assert.equal(next.status, EXIT_LOCK_PATH_UNUSABLE, next.stderr);
    assert.match(next.stderr, UNREADABLE_REFUSAL("EISDIR"));
  });

  it("leaves its own hold in place when the path will not let it unlink, says so, and still reports the child's exit code", (t) => {
    const box = sandbox(t);
    if (process.getuid?.() === 0) {
      t.skip(
        "running as root, which unlinks regardless of the directory's mode",
      );
      return;
    }

    // The lock's directory loses its write bit while the command runs, so the
    // release re-reads its own hold fine (x on the directory, r on the file)
    // and then cannot unlink it. Restored right after the run, before any
    // assertion, so the sandbox can be removed whatever happens below.
    const run = runLock(
      box,
      runThenMutateLock(
        `fs.chmodSync(require("node:path").dirname(lock), 0o500);`,
        3,
      ),
    );
    fs.chmodSync(box.dir, 0o700);

    assert.equal(run.status, 3, run.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    assert.equal(lockExists(box), true, "the lock was unlinked regardless");
    assert.equal(
      lockPayload(box).pid,
      run.pid,
      "the hold left on disk is not the wrapper's own",
    );
    assert.match(run.stderr, /could not release .* \(EACCES on unlink\)/);
    assert.match(run.stderr, new RegExp(`naming PID ${run.pid}`));
    assert.doesNotMatch(
      run.stderr,
      /unexpected failure/,
      "a fault at the configured path was reported as a bug in the script",
    );
    // The line says what the next run will do once the path lets it; it does.
    const next = runLock(box, touch(0));
    assert.equal(next.status, 0, next.stderr);
    assert.match(
      next.stderr,
      new RegExp(`breaking STALE lock .* holder PID ${run.pid} is gone`),
    );
    assert.equal(lockExists(box), false, "the lock outlived the next run");
  });
});

describe("a lock path where no lock can be created", () => {
  it("is refused when its directory does not exist: the command does not run, and the transcript names the path and the errno", (t) => {
    const box = sandbox(t);
    const lockFile = path.join(box.dir, "no-such-dir", "build.lock");

    const run = runLock(box, touch(0), { TESSERA_BUILD_LOCK: lockFile });

    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran with no lock held");
    assert.match(run.stderr, UNCREATABLE_REFUSAL("ENOENT"));
    assert.match(run.stderr, NAMES_LOCK_FILE(lockFile));
    assert.match(run.stderr, /The command did NOT run/);
    assert.doesNotMatch(
      run.stderr,
      /unexpected failure/,
      "a missing directory at the configured path was reported as a bug in the script",
    );
    assert.equal(
      fs.existsSync(path.dirname(lockFile)),
      false,
      "the wrapper created the missing directory",
    );
  });

  it("is refused when its directory is not writable: the command does not run, and no temp file is left behind", (t) => {
    const box = sandbox(t);
    if (process.getuid?.() === 0) {
      t.skip(
        "running as root, which writes regardless of the directory's mode",
      );
      return;
    }
    const readOnly = path.join(box.dir, "read-only");
    fs.mkdirSync(readOnly);
    fs.chmodSync(readOnly, 0o500);
    const lockFile = path.join(readOnly, "build.lock");

    const run = runLock(box, touch(0), { TESSERA_BUILD_LOCK: lockFile });
    fs.chmodSync(readOnly, 0o700);

    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran with no lock held");
    assert.match(run.stderr, UNCREATABLE_REFUSAL("EACCES"));
    assert.match(run.stderr, NAMES_LOCK_FILE(lockFile));
    assert.match(run.stderr, /The command did NOT run/);
    assert.doesNotMatch(run.stderr, /unexpected failure/);
    assert.deepEqual(fs.readdirSync(readOnly), [], "litter was left behind");
  });

  it("is refused when link() is forbidden there — before any fallback: the command does not run, and no temp file is left behind", (t) => {
    const box = sandbox(t);

    // EACCES from link() is not in the "this filesystem cannot hard-link"
    // set, so the non-atomic fallback must NOT be tried: the path is refusing
    // this user, not the primitive.
    const run = runLockFaulted(
      box,
      { linkSync: [{ throws: "EACCES" }] },
      touch(0),
    );

    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran with no lock held");
    assert.match(run.stderr, UNCREATABLE_REFUSAL("EACCES"));
    assert.match(run.stderr, NAMES_LOCK_FILE(box.lockFile));
    assert.doesNotMatch(
      run.stderr,
      DEGRADED_WARNING,
      "an EACCES from link() was taken for a filesystem without hard links",
    );
    assert.doesNotMatch(run.stderr, /unexpected failure/);
    assert.equal(lockExists(box), false, "a lock was created regardless");
    assert.deepEqual(
      fs.readdirSync(box.dir),
      ["fault.mjs"],
      "litter was left behind",
    );
  });

  it("is refused when the non-atomic fallback is refused too: the degradation is announced, then the refusal, and the command does not run", (t) => {
    const box = sandbox(t);

    const run = runLockFaulted(
      box,
      {
        linkSync: [{ throws: "ENOTSUP" }],
        writeFileSync: [{ throws: "EACCES" }],
      },
      touch(0),
    );

    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran with no lock held");
    assert.match(run.stderr, DEGRADED_WARNING);
    assert.match(run.stderr, UNCREATABLE_REFUSAL("EACCES"));
    assert.match(run.stderr, NAMES_LOCK_FILE(box.lockFile));
    const order = orderOf(run.stderr, "WARNING:", "REFUSED");
    assert.ok(
      order.first < order.second,
      "the refusal came before the degradation it followed from",
    );
    assert.doesNotMatch(run.stderr, /unexpected failure/);
    assert.equal(lockExists(box), false, "a lock was created regardless");
    assert.deepEqual(
      fs.readdirSync(box.dir),
      ["fault.mjs"],
      "litter was left behind",
    );
  });

  it("stays an internal failure when what link() threw is not an errno — a bug is not a misconfigured path", (t) => {
    const box = sandbox(t);
    // Not an OS error: no `syscall`, no errno-shaped `code`. The 70 row of the
    // header promises "a bug in here", and a refusal dressed as 78 would tell
    // the operator to fix a path that is fine.
    const patch = path.join(box.dir, "bug.mjs");
    fs.writeFileSync(
      patch,
      [
        `import fs from "node:fs";`,
        `const real = fs.linkSync;`,
        `fs.linkSync = (existing, created) => {`,
        `  if (created === process.env.TESSERA_BUILD_LOCK) {`,
        `    throw new TypeError("a bug in the script");`,
        `  }`,
        `  return real(existing, created);`,
        `};`,
      ].join("\n"),
    );

    const run = spawnSync(
      process.execPath,
      ["--import", patch, LOCK_SCRIPT, ...touch(0)],
      { cwd: box.dir, encoding: "utf8", env: lockEnv(box) },
    );

    assert.equal(run.status, 70, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran with no lock held");
    assert.match(
      run.stderr,
      /unexpected failure — TypeError: a bug in the script/,
    );
    assert.doesNotMatch(
      run.stderr,
      /REFUSED/,
      "a bug in the script was reported as a misconfigured lock path",
    );
    assert.equal(lockExists(box), false, "a lock was created regardless");
  });
});

describe("breaking a stale lock, when the path stops cooperating", () => {
  it("withdraws the announced break — in that order — when malformed bytes changed under the proof, and honours what is there now", (t) => {
    const box = sandbox(t);
    const live = liveHold();
    writeLock(box, live);

    // What the wrapper reads: garbage, then different garbage. What is on
    // disk throughout: a live hold. The break is announced on the first
    // read and must be withdrawn on the second, and the live hold must then
    // be honoured — the refusal names its pid.
    const run = runLockFaulted(
      box,
      {
        readFileSync: [
          { returns: "not json\n" },
          { returns: "still not json\n" },
        ],
      },
      touch(0),
    );

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran beside a live hold");
    const order = orderOf(run.stderr, "breaking STALE lock", "NOT broken");
    assert.ok(
      order.first < order.second,
      "the withdrawal was printed before the announcement it withdraws",
    );
    assert.match(run.stderr, /payload is not valid JSON/);
    assert.match(run.stderr, /changed between the proof and the unlink/);
    assert.match(
      run.stderr,
      new RegExp(`REFUSED — lock held by PID ${process.pid}`),
    );
    assert.equal(
      fs.readFileSync(box.lockFile, "utf8"),
      live,
      "the live hold was unlinked or rewritten",
    );
  });

  it("never proceeds blind — a re-read that fails abandons the break, says so, and refuses the path; the file survives", (t) => {
    const box = sandbox(t);
    const live = liveHold();
    writeLock(box, live);

    const run = runLockFaulted(
      box,
      { readFileSync: [{ returns: "not json\n" }, { throws: "EACCES" }] },
      touch(0),
    );

    // 78, and its header row is true here: nothing ran, the path was left as
    // found, the errno is printed. Not 70: nothing in the script failed.
    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran beside a live hold");
    const order = orderOf(run.stderr, "breaking STALE lock", "NOT broken");
    assert.ok(
      order.first < order.second,
      "the withdrawal was printed before the announcement it withdraws",
    );
    assert.match(
      run.stderr,
      /NOT broken — .* could not be re-read at the unlink \(EACCES\)/,
    );
    assert.match(run.stderr, UNREADABLE_REFUSAL("EACCES"));
    assert.match(run.stderr, NAMES_LOCK_FILE(box.lockFile));
    assert.doesNotMatch(
      run.stderr,
      /unexpected failure/,
      "a fault at the configured path was reported as a bug in the script",
    );
    assert.equal(
      fs.readFileSync(box.lockFile, "utf8"),
      live,
      "a break proceeded without its proof",
    );
  });

  it("never proceeds past an unlink the path refuses — the stale lock stays, the break is withdrawn, and the path is refused", (t) => {
    const box = sandbox(t);
    const stale = staleHold();
    writeLock(box, stale);

    const run = runLockFaulted(
      box,
      { unlinkSync: [{ throws: "EACCES" }] },
      touch(0),
    );

    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran with no lock held");
    const order = orderOf(run.stderr, "breaking STALE lock", "NOT broken");
    assert.ok(
      order.first < order.second,
      "the withdrawal was printed before the announcement it withdraws",
    );
    assert.match(run.stderr, /is gone \(ESRCH\)/);
    assert.match(
      run.stderr,
      /NOT broken — .* could not be unlinked \(EACCES\)/,
    );
    assert.match(run.stderr, UNREMOVABLE_REFUSAL("EACCES"));
    assert.match(run.stderr, NAMES_LOCK_FILE(box.lockFile));
    assert.doesNotMatch(run.stderr, /unexpected failure/);
    assert.equal(
      fs.readFileSync(box.lockFile, "utf8"),
      stale,
      "the stale lock was rewritten or removed after all",
    );
  });
});

describe("a lock released between the failed create and the read", () => {
  it("is retried, not refused: the command runs and the lock is released at the end", (t) => {
    const box = sandbox(t);
    writeLock(box, liveHold());

    // The race the "gone" state exists for, made deterministic: link() finds
    // the file (EEXIST), and by the time the holder is read it is gone — the
    // preload unlinks it and answers ENOENT in the same call.
    const run = runLockFaulted(
      box,
      { readFileSync: [{ throws: "ENOENT", unlinkFirst: true }] },
      touch(0),
    );

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    assert.equal(lockExists(box), false, "the lock outlived the run");
    assert.doesNotMatch(
      run.stderr,
      /REFUSED|STALE|NOT broken/,
      "a lock that was simply released was reported as contention",
    );
  });
});

describe("a holder whose start time cannot be read", () => {
  it("is honoured while its pid is alive — unknown resolves to alive, never to stale", (t) => {
    // Same guard as the non-zero-exit sibling below: on Linux the signature
    // comes from /proc before `ps` is ever consulted, so an empty PATH hides
    // nothing and the recorded start time is proved wrong.
    if (process.platform === "linux") {
      t.skip("/proc answers first on Linux, so `ps` is never consulted");
      return;
    }
    const box = sandbox(t);
    // With PATH pointing at an empty directory the wrapper cannot run `ps`,
    // so the live signature is unobtainable — the one input that would
    // otherwise prove this recorded start time wrong. The wrapped command is
    // an absolute path and needs no PATH, so a run would still be visible.
    const emptyBin = path.join(box.dir, "empty-bin");
    fs.mkdirSync(emptyBin);
    const payload = `${JSON.stringify(
      {
        pid: process.pid,
        holderStart: NOT_ANY_LIVE_PROCESS,
        owner: "live-owner",
        acquiredAt: new Date().toISOString(),
        command: "a live builder",
      },
      null,
      2,
    )}\n`;
    writeLock(box, payload);

    const run = runLock(box, touch(0), { PATH: emptyBin });

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran beside a live hold");
    assert.match(run.stderr, new RegExp(`held by PID ${process.pid}`));
    assert.doesNotMatch(
      run.stderr,
      /STALE|recycled/,
      "a signature nobody could read was treated as a mismatch",
    );
    assert.equal(
      fs.readFileSync(box.lockFile, "utf8"),
      payload,
      "the live hold was broken or rewritten",
    );

    // Control: with `ps` reachable the same lock IS broken — the signature is
    // what decides, and the case above honoured the hold for lack of it, not
    // for any other reason.
    const control = runLock(box, touch(0));
    assert.equal(control.status, 0, control.stderr);
    assert.match(control.stderr, /breaking STALE lock .* the pid was recycled/);
  });

  it("is still broken when its pid is dead — ESRCH alone proves the holder gone, signature or no signature", (t) => {
    const box = sandbox(t);
    const emptyBin = path.join(box.dir, "empty-bin");
    fs.mkdirSync(emptyBin);
    const gone = deadPid();
    writeLock(box, {
      pid: gone,
      holderStart: NOT_ANY_LIVE_PROCESS,
      owner: "stale-owner",
      acquiredAt: new Date("2020-01-01T00:00:00.000Z").toISOString(),
      command: "a build that died",
    });

    const run = runLock(box, touch(0), { PATH: emptyBin });

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    assert.match(
      run.stderr,
      new RegExp(
        `breaking STALE lock .* holder PID ${gone} is gone \\(ESRCH\\)`,
      ),
    );
    assert.equal(lockExists(box), false, "the lock outlived the run");
  });

  it("is honoured while its pid is alive when `ps` runs but exits non-zero", (t) => {
    // `ps` absent (ENOENT, the first case) and `ps` present but failing are
    // distinct inputs that land in the same catch. This one pins the second:
    // a failing `ps` has still told us nothing, so it must resolve to alive.
    if (process.platform === "linux") {
      t.skip("/proc answers first on Linux, so `ps` is never consulted");
      return;
    }
    const box = sandbox(t);
    const fakeBin = path.join(box.dir, "failing-bin");
    const psRan = path.join(box.dir, "ps-ran.txt");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "ps"),
      `#!/bin/sh\necho ran > '${psRan}'\nexit 1\n`,
      { mode: 0o755 },
    );
    const payload = `${JSON.stringify({
      pid: process.pid,
      holderStart: NOT_ANY_LIVE_PROCESS,
      owner: "live-owner",
      acquiredAt: new Date().toISOString(),
      command: "a live builder",
    })}\n`;
    writeLock(box, payload);

    const run = runLock(box, touch(0), { PATH: fakeBin });

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran beside a live hold");
    assert.match(run.stderr, new RegExp(`held by PID ${process.pid}`));
    assert.doesNotMatch(run.stderr, /STALE|recycled/);
    assert.equal(fs.readFileSync(box.lockFile, "utf8"), payload);
    // Without this the case is indistinguishable from the ENOENT one above.
    assert.equal(fs.existsSync(psRan), true, "the fake `ps` never ran");
  });
});

// ── the Linux /proc branch, driven off-Linux ───────────────────────────────
//
// On Linux the holder's start time comes from /proc/<pid>/stat field 22, and
// `ps` is consulted only when that read fails. This box — and every darwin
// box — never takes that branch through the entry point, so a green run here
// would say nothing about the platform CI runs on. These cases therefore drive
// the two functions that decide it in-process, with the platform and the proc
// root handed in explicitly and a fake proc tree built in the sandbox. The
// live pid is this process's own, so `kill(pid, 0)` answers "exists" for real
// and only the signature is scripted.

/** A /proc/<pid>/stat line: `comm` verbatim, field 22 = `startTicks`. */
function procStatLine(pid, comm, startTicks) {
  // Fields 3..52 after the comm. Every one but field 22 is a distinct value
  // that is NOT the start time, so an off-by-one field index reads something
  // recognisably wrong instead of an accidental match.
  const rest = Array.from({ length: 50 }, (_, i) => String(9000 + i));
  rest[0] = "S";
  rest[19] = String(startTicks);
  return `${pid} (${comm}) ${rest.join(" ")}\n`;
}

/** A fake proc root holding `/<pid>/stat` with `contents`, or no stat at all. */
function fakeProc(t, pid, contents) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "tessera-build-lock-proc-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (contents !== undefined) {
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), "stat"), contents);
  }
  return { platform: "linux", procRoot: root };
}

/** What `ps` says about `pid` — the signature the Linux branch falls back to. */
const psSignature = (pid) =>
  processStartSignature(pid, { platform: "darwin", procRoot: "/proc" });

describe("the Linux /proc start-time signature", () => {
  it("reads field 22 after the LAST ')' — a comm with spaces and parentheses cannot shift it", (t) => {
    const pid = process.pid;
    for (const comm of ["node", "a b", "x) (y", ") 1 2 3 )", "tricky) S 7 7"]) {
      const probe = fakeProc(t, pid, procStatLine(pid, comm, 4242424242));
      assert.equal(
        processStartSignature(pid, probe),
        "proc:4242424242",
        `comm ${JSON.stringify(comm)} shifted the field count`,
      );
    }
  });

  it("falls through to `ps` when the stat file is missing, and never invents a /proc signature", (t) => {
    const pid = process.pid;
    const probe = fakeProc(t, pid, undefined);
    const signature = processStartSignature(pid, probe);
    assert.doesNotMatch(String(signature), /^proc:/);
    assert.equal(signature, psSignature(pid));
  });

  it("fails closed on malformed content — no signature is parsed out of it", (t) => {
    const pid = process.pid;
    const fields = Array.from({ length: 50 }, (_, i) => String(100 + i));
    const malformed = {
      "empty file": "",
      // No ')' at all, but digits everywhere: a parser that does not insist
      // on the comm terminator reads SOME number out of this.
      "no comm terminator": `${pid} node S ${fields.join(" ")}\n`,
      "no space after the comm": `${pid} (node)S ${fields.join(" ")}\n`,
      "truncated before field 22": `${pid} (node) S 1 2 3 4 5\n`,
      "a non-numeric field 22": procStatLine(pid, "node", "12a"),
      "an empty field 22": procStatLine(pid, "node", ""),
    };
    for (const [label, contents] of Object.entries(malformed)) {
      const probe = fakeProc(t, pid, contents);
      const signature = processStartSignature(pid, probe);
      assert.doesNotMatch(
        String(signature),
        /^proc:/,
        `${label}: a start time was read out of malformed /proc content`,
      );
    }
  });

  it("never treats malformed or missing /proc content as a different process", (t) => {
    // The recorded hold was taken on Linux, so it carries a proc: signature.
    // If /proc cannot answer now, the fallback is a `ps` rendering — a
    // different KIND of signature, which proves nothing about identity. A
    // live pid must then be honoured, never broken as recycled.
    const pid = process.pid;
    const recorded = "proc:4242424242";
    const shapes = {
      missing: undefined,
      empty: "",
      "no comm terminator": `${pid} node S ${Array(50).fill("7").join(" ")}\n`,
      "non-numeric field 22": procStatLine(pid, "node", "soon"),
    };
    for (const [label, contents] of Object.entries(shapes)) {
      const verdict = holderLiveness(pid, recorded, fakeProc(t, pid, contents));
      assert.deepEqual(
        verdict,
        { alive: true, reason: "" },
        `${label}: a live holder was judged gone`,
      );
    }
  });

  it("treats the hold as stale only on a certain mismatch — two /proc start times that differ", (t) => {
    const pid = process.pid;
    const probe = fakeProc(t, pid, procStatLine(pid, "node (worker)", 555));

    assert.deepEqual(holderLiveness(pid, "proc:555", probe), {
      alive: true,
      reason: "",
    });
    const recycled = holderLiveness(pid, "proc:554", probe);
    assert.equal(recycled.alive, false, "a recycled pid was honoured");
    assert.match(
      recycled.reason,
      new RegExp(
        `PID ${pid} is alive but is NOT the holder — it started at proc:555, the hold recorded proc:554; the pid was recycled`,
      ),
    );
    // A `ps` rendering recorded (an acquire whose /proc read failed) is not
    // comparable to a /proc start time: unknown, therefore alive.
    assert.deepEqual(holderLiveness(pid, psSignature(pid), probe), {
      alive: true,
      reason: "",
    });
    // No signature recorded: the bare pid probe decides, and the pid exists.
    assert.deepEqual(holderLiveness(pid, "", probe), {
      alive: true,
      reason: "",
    });
    // A dead pid is gone whatever /proc says — ESRCH is positive evidence.
    const gone = deadPid();
    const dead = holderLiveness(
      gone,
      "proc:555",
      fakeProc(t, gone, procStatLine(gone, "node", 555)),
    );
    assert.equal(dead.alive, false);
    assert.match(dead.reason, /is gone \(ESRCH\)/);
  });

  it("keeps the default probe identical to the live platform and /proc", () => {
    const pid = process.pid;
    assert.equal(
      processStartSignature(pid),
      processStartSignature(pid, {
        platform: process.platform,
        procRoot: "/proc",
      }),
    );
    if (process.platform === "linux") {
      assert.match(processStartSignature(pid), /^proc:\d+$/);
    }
  });
});

describe("a stale lock whose file is immutable", () => {
  it("is refused with 78 on the real EPERM an immutable flag raises — not simulated", (t) => {
    // The EPERM row of the header, measured rather than argued: darwin lets a
    // file's OWNER set the user-immutable flag, and unlink() of such a file
    // fails EPERM from the kernel. (Linux's chattr +i needs root, and the
    // sticky-directory shape needs a second uid; neither is available here.)
    if (process.platform !== "darwin") {
      t.skip("only darwin lets an unprivileged owner set an immutable flag");
      return;
    }
    const box = sandbox(t);
    const stale = staleHold();
    writeLock(box, stale);
    const flag = spawnSync("chflags", ["uchg", box.lockFile], {
      encoding: "utf8",
    });
    assert.equal(flag.status, 0, flag.stderr);
    let run;
    try {
      run = runLock(box, touch(0));
    } finally {
      spawnSync("chflags", ["nouchg", box.lockFile]);
    }

    assert.equal(run.status, EXIT_LOCK_PATH_UNUSABLE, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran with no lock held");
    assert.match(run.stderr, /is gone \(ESRCH\)/);
    assert.match(run.stderr, /NOT broken — .* could not be unlinked \(EPERM\)/);
    assert.match(run.stderr, UNREMOVABLE_REFUSAL("EPERM"));
    assert.match(run.stderr, NAMES_LOCK_FILE(box.lockFile));
    assert.doesNotMatch(run.stderr, /unexpected failure/);
    assert.equal(fs.readFileSync(box.lockFile, "utf8"), stale);
  });
});

describe("a relative lock path override", () => {
  it("is resolved against the wrapper's cwd once, held there, and handed to the child absolute", (t) => {
    const box = sandbox(t);
    fs.mkdirSync(path.join(box.dir, "rel"));

    // The child records what it was handed and what it found there while the
    // hold was live — the two facts a relative override would corrupt if it
    // travelled down unresolved into a child with a different cwd.
    const run = runLock(
      box,
      [
        process.execPath,
        "-e",
        `const fs = require("node:fs");` +
          `const lock = process.env.TESSERA_BUILD_LOCK;` +
          `fs.writeFileSync(process.env.SENTINEL, "ran");` +
          `fs.writeFileSync(process.env.SNAPSHOT, JSON.stringify({` +
          ` lockPath: lock, held: JSON.parse(fs.readFileSync(lock, "utf8")) }));`,
      ],
      { TESSERA_BUILD_LOCK: path.join("rel", "build.lock") },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    const seen = snapshotOf(box);
    assert.ok(
      path.isAbsolute(seen.lockPath),
      `the child was handed a relative lock path: ${seen.lockPath}`,
    );
    // A child's cwd is the physical path (/private/var/… on macOS for a
    // /var/… mkdtemp), so the comparison is on realpaths, not on spelling.
    assert.equal(
      seen.lockPath,
      path.join(fs.realpathSync(box.dir), "rel", "build.lock"),
      "the override was resolved against something other than the wrapper's cwd",
    );
    assert.equal(
      seen.held.pid,
      run.pid,
      "the lock held during the run was not the wrapper's",
    );
    assert.equal(
      fs.existsSync(path.join(box.dir, "rel", "build.lock")),
      false,
      "the lock outlived the run",
    );
  });
});

describe("a blank lock path override", () => {
  it("falls back to the default beside the script's own workspace root, not to a path spelled from the blank", (t) => {
    const box = sandbox(t);
    // The default lives one directory above the script, so a byte-for-byte
    // copy of the script under <sandbox>/scripts/ has <sandbox>/.tessera-build.lock
    // as its default — the real workspace lock is never in play. The copy is
    // run from yet another directory, so a blank resolved against the cwd
    // would land somewhere else again and be caught.
    fs.mkdirSync(path.join(box.dir, "scripts"));
    fs.mkdirSync(path.join(box.dir, "elsewhere"));
    const relocated = path.join(box.dir, "scripts", "build-lock.mjs");
    fs.copyFileSync(LOCK_SCRIPT, relocated);
    const expectedDefault = path.join(
      fs.realpathSync(box.dir),
      ".tessera-build.lock",
    );

    const env = {
      ...process.env,
      TESSERA_BUILD_LOCK: "   ",
      SENTINEL: box.sentinel,
      SNAPSHOT: box.snapshot,
    };
    delete env.TESSERA_BUILD_LOCK_OWNER;
    delete env.TESSERA_BUILD_LOCK_WAIT;
    const run = spawnSync(
      process.execPath,
      [
        relocated,
        process.execPath,
        "-e",
        `const fs = require("node:fs");` +
          `const lock = process.env.TESSERA_BUILD_LOCK;` +
          `fs.writeFileSync(process.env.SENTINEL, "ran");` +
          `fs.writeFileSync(process.env.SNAPSHOT, JSON.stringify({` +
          ` lockPath: lock, held: JSON.parse(fs.readFileSync(lock, "utf8")) }));`,
      ],
      { cwd: path.join(box.dir, "elsewhere"), encoding: "utf8", env },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.equal(ranCommand(box), true, "the wrapped command never ran");
    const seen = snapshotOf(box);
    assert.equal(
      seen.lockPath,
      expectedDefault,
      "a blank override was not replaced by the default beside the workspace root",
    );
    assert.equal(
      seen.held.pid,
      run.pid,
      "the lock held at the default path during the run was not the wrapper's",
    );
    assert.equal(
      fs.existsSync(expectedDefault),
      false,
      "the default lock outlived the run",
    );
    assert.equal(
      fs.existsSync(path.join(box.dir, "elsewhere", "   ")),
      false,
      "the blank override was resolved against the cwd into a lock of its own",
    );
  });
});

// ── the lock re-taken while a stale one was being broken ────────────────────
//
// acquire() makes two create attempts at most. When the second one also finds
// the name taken, the file there is whoever won the window between our unlink
// and our re-create — real contention, refused under 75. Its holder is read
// once more for the report, and that read can find nothing to report: the
// winner may already have released. The refusal must then still be 75, still
// be worded for a re-take, and never wear a fictitious "held by PID".
//
// Two EEXISTs from link() are scripted at the lock path: the first is what the
// real stale file on disk would have produced anyway; the second is the
// re-take, made without leaving a file, so the report's read finds the path
// bare exactly as a released re-taker would leave it.

describe("a stale lock re-taken while it was being broken", () => {
  it("is refused as contention even when the re-taker has since released — no second break, no invented holder", (t) => {
    const box = sandbox(t);
    writeLock(box, staleHold());

    const run = runLockFaulted(
      box,
      { linkSync: [{ throws: "EEXIST" }, { throws: "EEXIST" }] },
      touch(0),
    );

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(ranCommand(box), false, "the command ran with no lock held");
    assert.equal(
      (run.stderr.match(/breaking STALE/g) ?? []).length,
      1,
      "the re-taken lock was broken as well",
    );
    assert.match(
      run.stderr,
      /REFUSED — the lock was re-taken while we were breaking a stale one\./,
    );
    assert.doesNotMatch(
      run.stderr,
      /lock held by PID/,
      "a holder was reported where none could be read",
    );
    assert.match(run.stderr, NAMES_LOCK_FILE(box.lockFile));
    assert.match(run.stderr, /Exiting 75 \(lock held, nothing started\)/);
    assert.doesNotMatch(run.stderr, /unexpected failure/);
    assert.equal(lockExists(box), false, "a lock was left behind");
    assert.deepEqual(
      fs.readdirSync(box.dir).filter((name) => name.endsWith(".tmp")),
      [],
      "a temp file from the refused create was left behind",
    );
  });
});

// ── a stale lock that reappears STALE the instant it is broken ──────────────
//
// One break per acquire is the rule, and "breaking a stale lock" above proves
// it against a lock that reappears LIVE. This is the harder shape: the lock
// that reappears is STALE again — a dead pid, breakable by every rule that
// broke the first — and the second attempt must still refuse it rather than
// break it. Otherwise a lock that keeps coming back stale (a supervisor
// restarting a builder that dies on start; a sync tool restoring the file)
// would be broken forever, and the wrapper would never return to say so.
//
// The hostile helper has a finite budget of reappearances, on purpose. A
// wrapper that keeps breaking then WINS the create and runs the command, and
// the assertions below catch that as an exit code, a sentinel and a count —
// never as a hang the harness has to kill. The budget is what bounds an
// unbounded breaker; the spawn timeout is only a guard.

/**
 * Preloaded into the WRAPPER with `node --import`: every unlink of the LOCK
 * PATH goes ahead and is immediately followed by the next of `payloads`
 * being written there. Once they are used up the real unlink is all that
 * happens. Every other path (the temp sibling, the sentinel) passes through.
 */
function reappearingLockSource(payloads) {
  return [
    `import fs from "node:fs";`,
    `const lockFile = process.env.TESSERA_BUILD_LOCK;`,
    `const payloads = ${JSON.stringify(payloads)};`,
    `const realUnlink = fs.unlinkSync;`,
    `fs.unlinkSync = (...args) => {`,
    `  const result = realUnlink.apply(fs, args);`,
    `  if (args[0] === lockFile && payloads.length > 0) {`,
    `    fs.writeFileSync(lockFile, payloads.shift());`,
    `  }`,
    `  return result;`,
    `};`,
  ].join("\n");
}

/** `runLock`, with a lock that reappears as each of `payloads` when unlinked. */
function runLockReappearing(box, payloads, args) {
  const patch = path.join(box.dir, "reappearing.mjs");
  fs.writeFileSync(patch, reappearingLockSource(payloads));
  return spawnSync(
    process.execPath,
    ["--import", patch, LOCK_SCRIPT, ...args],
    {
      cwd: box.dir,
      encoding: "utf8",
      env: lockEnv(box),
      timeout: 15000,
      killSignal: "SIGKILL",
    },
  );
}

/**
 * The hold the helper writes back: as dead as the one just broken, and
 * numbered so the transcript shows WHICH reappearance a refusal was made on.
 */
const reappearedStaleHold = (n) => ({
  pid: deadPid(),
  owner: `the-hold-that-reappeared-${n}`,
  holderStart: NOT_ANY_LIVE_PROCESS,
  acquiredAt: new Date().toISOString(),
  command: `a stale hold that reappeared (${n})`,
});

describe("a stale lock that reappears STALE the instant it is broken", () => {
  it("is refused after exactly two attempts — the reappeared hold is as dead as the first, and is not broken", (t) => {
    const box = sandbox(t);
    writeLock(box, staleHold());
    // Three reappearances: two more than a correct run ever consumes, and
    // enough for a breaker without the cap to exhaust before it wins.
    const holds = [1, 2, 3].map(reappearedStaleHold);
    const payloads = holds.map((hold) => `${JSON.stringify(hold, null, 2)}\n`);

    const run = runLockReappearing(box, payloads, touch(0));

    assert.equal(run.status, EXIT_LOCK_HELD, run.stderr);
    assert.equal(
      ranCommand(box),
      false,
      "the command ran — the reappearing lock was broken through",
    );
    // Exactly one break: the first attempt's. The second attempt found the
    // path taken again and stopped there, without judging what it found —
    // a dead pid it would have broken on the first attempt.
    assert.equal(
      (run.stderr.match(/breaking STALE/g) ?? []).length,
      1,
      "a hold that reappeared stale was broken as well",
    );
    // The refusal is made on the FIRST reappearance — what the second
    // attempt found — and never on one only a third attempt could have seen.
    assert.match(
      run.stderr,
      new RegExp(`REFUSED — lock held by PID ${holds[0].pid} since`),
    );
    assert.match(
      run.stderr,
      /it is running: a stale hold that reappeared \(1\)/,
    );
    assert.doesNotMatch(
      run.stderr,
      /reappeared \([23]\)/,
      "a third attempt was made",
    );
    assert.match(run.stderr, NAMES_LOCK_FILE(box.lockFile));
    assert.match(run.stderr, /Exiting 75 \(lock held, nothing started\)/);
    assert.doesNotMatch(run.stderr, /unexpected failure/);
    // Left exactly as the second attempt found it.
    assert.equal(
      fs.readFileSync(box.lockFile, "utf8"),
      payloads[0],
      "the reappeared hold was broken or rewritten",
    );
    assert.deepEqual(
      fs.readdirSync(box.dir).filter((name) => name.endsWith(".tmp")),
      [],
      "a temp file from the refused create was left behind",
    );
  });
});

// ── the three package lists ─────────────────────────────────────────────────
//
// The chain this lock exists to serialise is a HAND-WRITTEN list: `build:all`
// names its 20 targets one `-w` at a time. Three statements of one fact —
// that list, the `workspaces` globs, and `packages/` on disk — and until now
// only prose said they agree (this script's own header, build-lock.mjs:13).
// A package added to `packages/` but not to `build:all` is simply never built,
// and every suite that imports from its `build/` then fails as the
// `ERR_MODULE_NOT_FOUND` / `suites 0` shape the lock was written to abolish.
//
// NOT an argument for `--workspaces`: the order of `build:all` IS the
// topological build order, which `--workspaces` (directory order) would
// discard. Assert the SET, never the order, and leave the hand list alone.

/** `packages/*` → the directories it matches. Only that shape is expanded. */
function expandWorkspaceGlob(pattern) {
  const literal = /^([^*?[\]]+)\/\*$/.exec(pattern);
  assert.ok(
    literal,
    `workspaces pattern "${pattern}" is not the "<dir>/*" shape this test expands`,
  );
  const dir = fileURLToPath(new URL(`../${literal[1]}/`, import.meta.url));
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

describe("the workspace package lists", () => {
  const root = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const built = [
    ...root.scripts["build:all"].matchAll(/\bnpm run build -w (\S+)/g),
  ].map((m) => m[1]);
  const matched = root.workspaces.flatMap(expandWorkspaceGlob);

  it("names each package exactly once in build:all", () => {
    assert.ok(built.length > 0, "no `-w` target parsed out of build:all");
    assert.deepEqual(
      built.filter((name, i) => built.indexOf(name) !== i),
      [],
      "build:all builds a package twice",
    );
  });

  it("gives every directory the workspaces globs match a package.json", () => {
    for (const dir of matched) {
      assert.ok(
        fs.existsSync(path.join(dir, "package.json")),
        `${dir} matches a workspaces glob but has no package.json — npm ignores it and build:all cannot name it`,
      );
    }
  });

  it("matches packages/ on disk with the workspaces globs", () => {
    const onDisk = fs
      .readdirSync(fileURLToPath(new URL("../packages/", import.meta.url)), {
        withFileTypes: true,
      })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.deepEqual(
      matched.map((dir) => path.basename(dir)).sort(),
      onDisk.sort(),
      "the workspaces globs no longer cover exactly packages/ — a package outside them is never installed, built or tested",
    );
  });

  it("builds exactly the set the workspaces globs match (set equality; the ORDER of build:all is the build order and is deliberately not asserted)", () => {
    const names = matched.map(
      (dir) =>
        JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
          .name,
    );
    assert.deepEqual(
      [...built].sort(),
      [...names].sort(),
      "build:all and the workspaces globs name different package sets",
    );
  });

  it("gives every member both a build and a test script", () => {
    for (const dir of matched) {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      assert.equal(
        typeof pkg.scripts?.build,
        "string",
        `${pkg.name} defines no "build" script — build:all fails on it`,
      );
      assert.equal(
        typeof pkg.scripts?.test,
        "string",
        `${pkg.name} defines no "test" script — \`npm run test --workspaces --if-present\` skips it in silence`,
      );
    }
  });
});
