// Ported from syncrona @ 73cae76 (packages/core/src/tests/collaborationLock.test.ts).
// Upstream mocks ConfigManager/Logger with jest.unstable_mockModule and reaches the
// primitives through pushCommand's __lockInternals; here the factory takes the temp
// dir directly, so the same scenarios run with no module mocking at all.
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createCollaborationLock,
  isCollaborationLockStale,
  isProcessAlive,
  isEvictionClaimAbandoned,
  COLLABORATION_LOCK_FUTURE_SKEW_MS,
} from "../build/index.js";

// A pid that is essentially guaranteed not to be running. process.kill(pid, 0)
// on it throws ESRCH, which the liveness check reads as "owner is gone".
const DEAD_PID = 2 ** 22; // ~4.19M, well above any real pid on the test host

// Mirrors of the module's private eviction constants, spelled out on purpose.
// A value re-derived from the module under test moves *with* a mutant, so the
// assertion stays true while measuring nothing (see upstream CONTRIBUTING, "a
// table-completeness fixture must be a literal list inside the test file").
const EVICT_MAX_AGE_MS = 10 * 1000;
const EVICT_MAX_GENERATIONS = 8;
const EVICT_PREFIX = "sync.collaboration.evict.";
const STAGING_PREFIX = "sync.collaboration.staging.";

describe("collaboration lock (#18) — real filesystem", () => {
  let dir;
  let lock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-lock-"));
    lock = createCollaborationLock({ stateDir: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes an atomic lock file on the real filesystem and releases it", async () => {
    const res = await lock.acquireCollaborationLock("push", "dev");
    assert.equal(res.acquired, true);

    // The lock physically exists and records THIS process as the owner.
    const lockPath = lock.getCollaborationLockPath();
    assert.equal(fs.existsSync(lockPath), true);
    const loaded = await lock.loadCollaborationLock();
    assert.equal(loaded?.command, "push");
    assert.equal(loaded?.pid, process.pid);
    assert.equal(loaded?.instanceProfile, "dev");

    await lock.releaseCollaborationLock();
    assert.equal(fs.existsSync(lockPath), false);
  });

  it("refuses to acquire when a LIVE lock (current process) already holds it", async () => {
    // First acquire wins; the owner (this process) is alive and the lock is
    // fresh, so a second attempt must be denied rather than stealing it.
    const first = await lock.acquireCollaborationLock("push");
    assert.equal(first.acquired, true);

    const second = await lock.acquireCollaborationLock("push");
    assert.equal(second.acquired, false);
    assert.ok(second.reason.includes(`pid ${process.pid}`));

    // The original lock file is untouched.
    assert.equal(fs.existsSync(lock.getCollaborationLockPath()), true);
  });

  it("reclaims a lock whose owning process is DEAD, even inside the age window (pid-liveness)", async () => {
    // Plant a young lock owned by a dead pid — created "now", so the age check
    // alone would NOT consider it stale. Only pid-liveness reclaims it.
    // Written on THIS host: since W5a #4 the pid is consulted only for a lock
    // that names the local hostname (a hostless lock is foreign, age-only).
    const stalePayload = {
      command: "push",
      pid: DEAD_PID,
      createdAt: new Date().toISOString(),
      hostname: os.hostname(),
    };
    fs.writeFileSync(
      lock.getCollaborationLockPath(),
      JSON.stringify(stalePayload),
      "utf8",
    );

    // Sanity: the planted lock is fresh by age but its owner is gone.
    assert.equal(isProcessAlive(DEAD_PID), false);
    assert.equal(isCollaborationLockStale(stalePayload), true);

    // Acquire must succeed by removing the dead-owner lock and taking it over.
    const res = await lock.acquireCollaborationLock("push");
    assert.equal(res.acquired, true);
    const loaded = await lock.loadCollaborationLock();
    assert.equal(loaded?.pid, process.pid);
  });

  it("treats a lock older than the max age as stale regardless of pid", () => {
    const oldLock = {
      command: "push",
      pid: process.pid, // alive, but ancient
      createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    };
    assert.equal(isCollaborationLockStale(oldLock), true);
  });

  it("treats a lock with an unparseable timestamp as stale", () => {
    assert.equal(
      isCollaborationLockStale({
        command: "push",
        pid: process.pid,
        createdAt: "not-a-date",
      }),
      true,
    );
  });

  it("considers the current process alive and an absent/invalid pid alive (age is authority)", () => {
    assert.equal(isProcessAlive(process.pid), true);
    // Undefined or non-positive pids can't be checked, so they must not be
    // wrongly reclaimed by liveness — the age window governs those.
    assert.equal(isProcessAlive(undefined), true);
    assert.equal(isProcessAlive(0), true);
    assert.equal(isProcessAlive(-1), true);
  });

  it("release is a no-op when no lock file exists (idempotent)", async () => {
    assert.equal(await lock.releaseCollaborationLock(), undefined);
  });

  // Finding 6: stale reclaim must never destroy a LIVE lock a racing push
  // created in the window after we observed the stale one. The old blind unlink
  // did exactly that, letting two pushes both acquire.
  describe("atomic stale-lock reclaim (Finding 6)", () => {
    it("discards a genuinely stale lock and leaves no reclaim temp behind", async () => {
      const stalePayload = {
        command: "push",
        pid: DEAD_PID,
        createdAt: new Date().toISOString(),
        hostname: os.hostname(), // same-host dead owner (W5a #4)
      };
      const lockPath = lock.getCollaborationLockPath();
      fs.writeFileSync(lockPath, JSON.stringify(stalePayload), "utf8");

      await lock.reclaimStaleLock();

      // The stale lock is gone, and no `.reclaim` sidecar was orphaned.
      assert.equal(fs.existsSync(lockPath), false);
      const leftovers = fs
        .readdirSync(dir)
        .filter((f) => f.includes(".reclaim"));
      assert.deepEqual(leftovers, []);
    });

    it("restores (never deletes) a LIVE lock found at the path instead of the stale one", async () => {
      // Simulate the race: by the time reclaim runs, a racing push has replaced
      // the observed stale lock with its own LIVE lock (this process, fresh).
      const livePayload = {
        command: "push",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      const lockPath = lock.getCollaborationLockPath();
      fs.writeFileSync(lockPath, JSON.stringify(livePayload), "utf8");

      await lock.reclaimStaleLock();

      // The live lock must survive untouched — its owner keeps mutual exclusion.
      assert.equal(fs.existsSync(lockPath), true);
      const loaded = await lock.loadCollaborationLock();
      assert.equal(loaded?.pid, process.pid);
      const leftovers = fs
        .readdirSync(dir)
        .filter((f) => f.includes(".reclaim"));
      assert.deepEqual(leftovers, []);
    });

    it("is a no-op when the lock has already been removed by another racer", async () => {
      // Nothing at the path — the ENOENT branch returns without throwing.
      assert.equal(await lock.reclaimStaleLock(), undefined);
      assert.equal(fs.existsSync(lock.getCollaborationLockPath()), false);
    });

    it("discards an unparseable (corrupt) lock file", async () => {
      const lockPath = lock.getCollaborationLockPath();
      fs.writeFileSync(lockPath, "{ this is not json", "utf8");

      await lock.reclaimStaleLock();

      assert.equal(fs.existsSync(lockPath), false);
    });
  });

  // REV-205: reclaim was hardened against destroying a lock it does not own
  // (Finding 6 above), but RELEASE was not — it unlinked whatever file sat at
  // the lock path. The two halves of the same invariant must both hold, because
  // a lock can legitimately change hands WHILE its original owner is still
  // running: the age window (30 min) declares a long push stale even though its
  // process is alive, so a collaborator reclaims the path and takes the lock.
  // When the long push then finishes, its `finally` release deleted the
  // collaborator's live lock, and the next push walked straight in — two pushes
  // writing the same records with no mutual exclusion.
  describe("release is ownership-checked (REV-205)", () => {
    /** The lock a collaborator holds after reclaiming a path we had aged out of. */
    const otherOwnersLock = () =>
      JSON.stringify({
        command: "push",
        // Deliberately this process's pid: the point is that pid alone cannot
        // establish ownership, so the check must rest on the lock's identity.
        pid: process.pid,
        createdAt: new Date().toISOString(),
        instanceProfile: "collaborator",
      });

    it("does not delete a lock another push acquired after ours was reclaimed as stale", async () => {
      const lockPath = lock.getCollaborationLockPath();
      const ours = await lock.acquireCollaborationLock("push");
      assert.equal(ours.acquired, true);

      // Our push runs past the age window; a collaborator judges our lock stale,
      // reclaims the path and installs its own live lock.
      fs.writeFileSync(lockPath, otherOwnersLock(), "utf8");

      await lock.releaseCollaborationLock();

      // The collaborator must still hold the lock.
      assert.equal(fs.existsSync(lockPath), true);
      assert.equal(
        (await lock.loadCollaborationLock())?.instanceProfile,
        "collaborator",
      );
    });

    it("still removes the lock it does own, so the path is never left blocked", async () => {
      const lockPath = lock.getCollaborationLockPath();
      assert.equal(
        (await lock.acquireCollaborationLock("push", "mine")).acquired,
        true,
      );

      await lock.releaseCollaborationLock();

      assert.equal(fs.existsSync(lockPath), false);
      // And the freed path is immediately re-acquirable.
      assert.equal(
        (await lock.acquireCollaborationLock("push", "next")).acquired,
        true,
      );
    });

    it("forgets the released lock, so a repeated release cannot reach the next owner", async () => {
      const lockPath = lock.getCollaborationLockPath();
      assert.equal(
        (await lock.acquireCollaborationLock("push")).acquired,
        true,
      );
      await lock.releaseCollaborationLock();
      assert.equal(fs.existsSync(lockPath), false);

      // A collaborator now takes the freed path. A second (buggy or retried)
      // release from us must not touch it.
      fs.writeFileSync(lockPath, otherOwnersLock(), "utf8");
      assert.equal(await lock.releaseCollaborationLock(), undefined);

      assert.equal(fs.existsSync(lockPath), true);
      assert.equal(
        (await lock.loadCollaborationLock())?.instanceProfile,
        "collaborator",
      );
    });
  });

  // REV-233: emptying the lock path is the one operation that can break mutual
  // exclusion, so it is mediated by an eviction claim — a file named after the
  // exact bytes being removed. The multi-process harness (`npm run race:lock`
  // upstream) proves the scheme end to end but cannot reach its failure branches
  // on demand: a claim that is abandoned, contended, unreadable, or exhausted
  // needs the filesystem put into that exact state first. These do that, still
  // against a real directory, because the primitives are the kernel's (link,
  // stat, mtime).
  describe("eviction claims (REV-233)", () => {
    /** Bytes of a lock that every reader agrees is stale: its owner is gone. */
    const staleLockBytes = () =>
      JSON.stringify({
        command: "push",
        pid: DEAD_PID,
        createdAt: new Date().toISOString(),
        hostname: os.hostname(), // same-host dead owner (W5a #4)
      });

    // `host` defaults to this host so a dead pid is positive evidence; pass null
    // for a legacy claim written before claims recorded a hostname (W5a #4 parity).
    const claimBytes = (pid, ageMs = 0, host = os.hostname()) =>
      JSON.stringify({
        pid,
        createdAt: new Date(Date.now() - ageMs).toISOString(),
        ...(host === null ? {} : { hostname: host }),
      });

    /** Everything the eviction scheme wrote and did not clean up. */
    const litter = () =>
      fs
        .readdirSync(dir)
        .filter(
          (f) => f.startsWith(EVICT_PREFIX) || f.startsWith(STAGING_PREFIX),
        );

    describe("isEvictionClaimAbandoned — only positive evidence counts", () => {
      // The whole point of this predicate is that "I cannot tell" must never read
      // as "abandoned": 'wx' creates a claim and fills it in two steps, so a racer
      // legitimately sees an empty or half-written claim, and judging that
      // abandoned is exactly what puts two evictors on the same lock. Every
      // unjudgeable shape below therefore has to fall back to the file's own
      // mtime, which a claim being written right now cannot fake.
      const FRESH = Date.now();
      const ANCIENT = Date.now() - 10 * EVICT_MAX_AGE_MS;

      const unjudgeable = [
        ["half-written (invalid JSON)", '{ "pid": 12'],
        ["JSON null", "null"],
        ["JSON scalar, not an object", "5"],
        ["object without createdAt", JSON.stringify({ pid: 12 })],
        [
          "object whose pid is not a number",
          JSON.stringify({ pid: "12", createdAt: new Date().toISOString() }),
        ],
        [
          "object whose createdAt is unparseable",
          JSON.stringify({ pid: 12, createdAt: "whenever" }),
        ],
      ];
      for (const [label, raw] of unjudgeable) {
        it(`falls back to mtime for a claim it cannot judge: ${label}`, () => {
          assert.equal(isEvictionClaimAbandoned(raw, FRESH), false);
          assert.equal(isEvictionClaimAbandoned(raw, ANCIENT), true);
        });
      }

      it("treats a claim with no usable mtime as live, never as abandoned", () => {
        // stat() failed, so there is no evidence at all — and absence of evidence
        // must not free the claim.
        assert.equal(
          isEvictionClaimAbandoned("{ truncated", Number.NaN),
          false,
        );
        assert.equal(
          isEvictionClaimAbandoned("{ truncated", Number.POSITIVE_INFINITY),
          false,
        );
      });

      it("abandons a claim whose holder is gone, however young the claim is", () => {
        assert.equal(
          isEvictionClaimAbandoned(claimBytes(DEAD_PID), FRESH),
          true,
        );
      });

      it("does not abandon a fresh claim from ANOTHER host whose pid is absent locally", () => {
        // A pid means nothing outside the process table of the host that issued
        // it, so a foreign claim is judged by age alone — the same rule as the lock.
        assert.equal(
          isEvictionClaimAbandoned(
            claimBytes(DEAD_PID, 0, `not-${os.hostname()}`),
            FRESH,
          ),
          false,
        );
      });

      it("treats a legacy claim without a hostname as foreign (age only)", () => {
        assert.equal(
          isEvictionClaimAbandoned(claimBytes(DEAD_PID, 0, null), FRESH),
          false,
        );
      });

      it("still abandons foreign and legacy claims once past the age backstop", () => {
        const aged = 2 * EVICT_MAX_AGE_MS;
        assert.equal(
          isEvictionClaimAbandoned(
            claimBytes(DEAD_PID, aged, `not-${os.hostname()}`),
            FRESH,
          ),
          true,
        );
        assert.equal(
          isEvictionClaimAbandoned(claimBytes(DEAD_PID, aged, null), FRESH),
          true,
        );
      });

      it("keeps a live holder's fresh claim and steps over its aged one", () => {
        assert.equal(
          isEvictionClaimAbandoned(claimBytes(process.pid), FRESH),
          false,
        );
        assert.equal(
          isEvictionClaimAbandoned(
            claimBytes(process.pid, 6 * EVICT_MAX_AGE_MS),
            FRESH,
          ),
          true,
        );
      });
    });

    describe("evictLockFile", () => {
      it("records this host in the eviction claim it writes", async () => {
        const raw = staleLockBytes();
        fs.writeFileSync(lock.getCollaborationLockPath(), raw, "utf8");
        const claims = [];
        const realWriteFile = fs.promises.writeFile;
        const spy = mock.method(fs.promises, "writeFile", (p, data, opts) => {
          if (path.basename(String(p)).includes(EVICT_PREFIX)) {
            claims.push(JSON.parse(String(data)));
          }
          return realWriteFile.call(fs.promises, p, data, opts);
        });
        try {
          assert.equal(await lock.evictLockFile(raw), true);
        } finally {
          spy.mock.restore();
        }
        assert.equal(claims.length, 1);
        assert.equal(claims[0].hostname, os.hostname());
        assert.equal(claims[0].pid, process.pid);
      });

      it("does not step over a fresh foreign-host claim whose pid is absent locally", async () => {
        const raw = staleLockBytes();
        fs.writeFileSync(lock.getCollaborationLockPath(), raw, "utf8");
        const claimPath = lock.getEvictionClaimPath(raw, 0);
        const foreign = claimBytes(DEAD_PID, 0, `not-${os.hostname()}`);
        fs.writeFileSync(claimPath, foreign, "utf8");

        assert.equal(await lock.evictLockFile(raw), false);

        assert.equal(
          fs.readFileSync(lock.getCollaborationLockPath(), "utf8"),
          raw,
        );
        assert.equal(fs.readFileSync(claimPath, "utf8"), foreign);
        assert.equal(fs.existsSync(lock.getEvictionClaimPath(raw, 1)), false);
      });

      it("removes exactly the content it claimed, and leaves no claim behind", async () => {
        const raw = staleLockBytes();
        fs.writeFileSync(lock.getCollaborationLockPath(), raw, "utf8");

        assert.equal(await lock.evictLockFile(raw), true);

        assert.equal(fs.existsSync(lock.getCollaborationLockPath()), false);
        assert.deepEqual(litter(), []);
      });

      it("leaves the path alone when its content changed under the claim", async () => {
        // The only process allowed to remove these bytes is us, so different bytes
        // at the path mean their owner released and someone else took it — there is
        // nothing here for this eviction to remove, and removing it would be the
        // two-winners bug the claim exists to prevent.
        const raw = staleLockBytes();
        const successor = JSON.stringify({
          command: "push",
          pid: process.pid,
          createdAt: new Date().toISOString(),
        });
        fs.writeFileSync(lock.getCollaborationLockPath(), successor, "utf8");

        assert.equal(await lock.evictLockFile(raw), true);

        assert.equal(
          fs.readFileSync(lock.getCollaborationLockPath(), "utf8"),
          successor,
        );
        assert.deepEqual(litter(), []);
      });

      it("reports success when the lock is already gone", async () => {
        assert.equal(await lock.evictLockFile(staleLockBytes()), true);
        assert.deepEqual(litter(), []);
      });

      it("backs off while another process actively holds the claim", async () => {
        const raw = staleLockBytes();
        fs.writeFileSync(lock.getCollaborationLockPath(), raw, "utf8");
        const claimPath = lock.getEvictionClaimPath(raw, 0);
        const otherEvictor = claimBytes(process.pid);
        fs.writeFileSync(claimPath, otherEvictor, "utf8");

        assert.equal(await lock.evictLockFile(raw), false);

        // Neither the lock nor the other evictor's claim was touched.
        assert.equal(
          fs.readFileSync(lock.getCollaborationLockPath(), "utf8"),
          raw,
        );
        assert.equal(fs.readFileSync(claimPath, "utf8"), otherEvictor);
      });

      it("steps to the next generation over an abandoned claim rather than stealing it", async () => {
        // A claim whose holder was killed mid-eviction would otherwise wedge the
        // path forever. Every racer that agrees it is abandoned steps to the SAME
        // next generation, where the atomic create again admits exactly one.
        const raw = staleLockBytes();
        fs.writeFileSync(lock.getCollaborationLockPath(), raw, "utf8");
        const wedged = lock.getEvictionClaimPath(raw, 0);
        fs.writeFileSync(wedged, claimBytes(DEAD_PID), "utf8");

        assert.equal(await lock.evictLockFile(raw), true);

        assert.equal(fs.existsSync(lock.getCollaborationLockPath()), false);
        // The abandoned claim is stepped over, never removed — unlinking another
        // process's claim is the one thing this scheme must not do.
        assert.equal(fs.existsSync(wedged), true);
        assert.equal(fs.existsSync(lock.getEvictionClaimPath(raw, 1)), false);
      });

      it("gives up after the generation budget, leaving the lock for the caller to retry", async () => {
        const raw = staleLockBytes();
        fs.writeFileSync(lock.getCollaborationLockPath(), raw, "utf8");
        for (
          let generation = 0;
          generation < EVICT_MAX_GENERATIONS;
          generation += 1
        ) {
          fs.writeFileSync(
            lock.getEvictionClaimPath(raw, generation),
            claimBytes(DEAD_PID),
            "utf8",
          );
        }

        assert.equal(await lock.evictLockFile(raw), false);

        assert.equal(
          fs.readFileSync(lock.getCollaborationLockPath(), "utf8"),
          raw,
        );
        // It stopped at the budget instead of minting a ninth generation.
        assert.equal(
          fs.existsSync(lock.getEvictionClaimPath(raw, EVICT_MAX_GENERATIONS)),
          false,
        );
      });

      it("retries a claim it cannot read at the same generation, then gives up", async () => {
        // A claim that exists for the atomic create but is unreadable a moment
        // later (here: not a regular file at all) may simply have been released.
        // Stepping to the next generation would let a racer win the freed name
        // while we win the next one — two evictors, which is the whole hazard — so
        // this case must re-race the SAME name until the step budget stops it.
        const raw = staleLockBytes();
        fs.writeFileSync(lock.getCollaborationLockPath(), raw, "utf8");
        fs.mkdirSync(lock.getEvictionClaimPath(raw, 0));

        assert.equal(await lock.evictLockFile(raw), false);

        assert.equal(
          fs.readFileSync(lock.getCollaborationLockPath(), "utf8"),
          raw,
        );
        assert.equal(fs.existsSync(lock.getEvictionClaimPath(raw, 1)), false);
        // Every staging file it wrote on the way was cleaned up.
        assert.deepEqual(
          fs.readdirSync(dir).filter((f) => f.startsWith(STAGING_PREFIX)),
          [],
        );
      });
    });

    describe("sweepEvictionClaims", () => {
      it("clears finished claims and aged staging files, and nothing else", async () => {
        const aged = (name) => {
          const full = path.join(dir, name);
          fs.writeFileSync(full, "x", "utf8");
          const past = (Date.now() - 6 * EVICT_MAX_AGE_MS) / 1000;
          fs.utimesSync(full, past, past);
          return full;
        };
        const fresh = (name) => {
          const full = path.join(dir, name);
          fs.writeFileSync(full, "x", "utf8");
          return full;
        };

        const finishedClaim = fresh(`${EVICT_PREFIX}deadbeefdeadbeef.0.json`);
        // Same prefix, wrong suffix: not a claim, so the sweep must not touch it.
        const notAClaim = fresh(`${EVICT_PREFIX}deadbeefdeadbeef.0.tmp`);
        // A staging file belongs to a link() a syscall or two from finishing, so
        // it is removed on age and never on sight.
        const liveStaging = fresh(`${STAGING_PREFIX}${process.pid}.in-flight`);
        const abandonedStaging = aged(`${STAGING_PREFIX}999999.crashed`);
        const unrelated = fresh("sync.push.checkpoint.json");

        assert.equal(await lock.sweepEvictionClaims(), undefined);

        assert.equal(fs.existsSync(finishedClaim), false);
        assert.equal(fs.existsSync(abandonedStaging), false);
        assert.equal(fs.existsSync(notAClaim), true);
        assert.equal(fs.existsSync(liveStaging), true);
        assert.equal(fs.existsSync(unrelated), true);
      });

      it("ignores a staging entry that cannot be stat'd", async () => {
        // Removed by its own owner between our readdir and our stat: already
        // cleaned up, nothing to do. A dangling symlink reproduces it exactly,
        // since stat() follows the link.
        const dangling = path.join(
          dir,
          `${STAGING_PREFIX}${process.pid}.vanished`,
        );
        fs.symlinkSync(path.join(dir, "no-such-target"), dangling);

        assert.equal(await lock.sweepEvictionClaims(), undefined);

        assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
      });

      it("is a no-op when the state directory cannot be listed", async () => {
        const missing = createCollaborationLock({
          stateDir: path.join(dir, "never-created"),
        });
        assert.equal(await missing.sweepEvictionClaims(), undefined);
      });
    });

    describe("acquireCollaborationLock — paths only the eviction scheme reaches", () => {
      it("retries, then fails honestly, when the lock path is occupied but unreadable", async () => {
        // Occupied for the atomic create yet unreadable a moment later: the lock
        // may have been released and re-created, so the loop re-races the path
        // rather than deciding anything about content it never saw.
        fs.mkdirSync(lock.getCollaborationLockPath());

        const res = await lock.acquireCollaborationLock("push");

        assert.equal(res.acquired, false);
        assert.equal(res.reason, "Could not acquire collaboration lock.");
        assert.deepEqual(litter(), []);
      });

      it("never evicts a live lock that is merely too malformed to describe", async () => {
        // A legacy lock, written before the `command` field existed: unparseable
        // for reporting, but its createdAt is fresh and its owner is alive.
        // Refusing to name the holder is the correct outcome; evicting it is not.
        const legacy = JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        });
        fs.writeFileSync(lock.getCollaborationLockPath(), legacy, "utf8");

        const res = await lock.acquireCollaborationLock("push");

        assert.equal(res.acquired, false);
        assert.equal(res.reason, "Detected an active collaboration lock.");
        assert.equal(
          fs.readFileSync(lock.getCollaborationLockPath(), "utf8"),
          legacy,
        );
      });

      it("waits out a competing evictor instead of racing it, and reports failure", async () => {
        // The lock is stale, so we are entitled to it — but another process holds
        // the claim on those exact bytes. Every attempt must back off and re-read
        // rather than remove a lock someone else is already removing.
        const raw = staleLockBytes();
        fs.writeFileSync(lock.getCollaborationLockPath(), raw, "utf8");
        const claimPath = lock.getEvictionClaimPath(raw, 0);
        const otherEvictor = claimBytes(process.pid);
        fs.writeFileSync(claimPath, otherEvictor, "utf8");

        const res = await lock.acquireCollaborationLock("push");

        assert.equal(res.acquired, false);
        assert.equal(res.reason, "Could not acquire collaboration lock.");
        assert.equal(
          fs.readFileSync(lock.getCollaborationLockPath(), "utf8"),
          raw,
        );
        assert.equal(fs.readFileSync(claimPath, "utf8"), otherEvictor);
      });
    });
  });
});

// W5a findings 4 and 5 (review-w5a/lock1.mjs). Both failed before the fix.
describe("collaboration lock — host identity and staging (W5a #4, #5)", () => {
  let dir;
  let lock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-lock-w5a-"));
    lock = createCollaborationLock({ stateDir: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const plant = (payload) =>
    fs.writeFileSync(
      lock.getCollaborationLockPath(),
      JSON.stringify(payload),
      "utf8",
    );

  it("records this host in the lock it writes", async () => {
    assert.equal((await lock.acquireCollaborationLock("push")).acquired, true);
    const loaded = await lock.loadCollaborationLock();
    assert.equal(loaded?.hostname, os.hostname());
    await lock.releaseCollaborationLock();
  });

  it("does not steal a fresh lock written on ANOTHER host whose pid is absent locally", async () => {
    plant({
      command: "push",
      pid: DEAD_PID,
      createdAt: new Date().toISOString(),
      hostname: `not-${os.hostname()}`,
    });

    const res = await lock.acquireCollaborationLock("push");

    assert.equal(res.acquired, false);
    assert.equal(
      JSON.parse(fs.readFileSync(lock.getCollaborationLockPath(), "utf8"))
        .hostname,
      `not-${os.hostname()}`,
    );
  });

  it("treats a legacy lock without a hostname as foreign (age is the only authority)", async () => {
    plant({
      command: "push",
      pid: DEAD_PID,
      createdAt: new Date().toISOString(),
    });

    const res = await lock.acquireCollaborationLock("push");

    assert.equal(res.acquired, false);
    assert.equal(
      isCollaborationLockStale({
        command: "push",
        pid: DEAD_PID,
        createdAt: new Date().toISOString(),
      }),
      false,
    );
  });

  it("still reclaims a foreign-host lock once it is past the age window", async () => {
    plant({
      command: "push",
      pid: DEAD_PID,
      createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      hostname: `not-${os.hostname()}`,
    });

    assert.equal((await lock.acquireCollaborationLock("push")).acquired, true);
    await lock.releaseCollaborationLock();
  });

  it("still reclaims a same-host lock whose pid is dead, inside the age window", () => {
    assert.equal(
      isCollaborationLockStale({
        command: "push",
        pid: DEAD_PID,
        createdAt: new Date().toISOString(),
        hostname: os.hostname(),
      }),
      true,
    );
  });

  it("stages exclusively (wx) under a per-call unique name", async () => {
    const seen = [];
    const realWriteFile = fs.promises.writeFile;
    const spy = mock.method(fs.promises, "writeFile", (p, data, opts) => {
      seen.push({ p: String(p), opts });
      return realWriteFile.call(fs.promises, p, data, opts);
    });
    try {
      assert.equal((await lock.acquireCollaborationLock("a")).acquired, true);
      await lock.releaseCollaborationLock();
      assert.equal((await lock.acquireCollaborationLock("b")).acquired, true);
      await lock.releaseCollaborationLock();
    } finally {
      spy.mock.restore();
    }
    const staged = seen.filter((c) =>
      path.basename(c.p).startsWith(STAGING_PREFIX),
    );
    assert.ok(staged.length >= 2);
    assert.equal(new Set(staged.map((c) => c.p)).size, staged.length);
    for (const c of staged) assert.equal(c.opts?.flag, "wx");
  });

  it("two handles in one process never share a staging file", async () => {
    // Before the fix both handles staged at `staging.<pid>.<lock name>`: one
    // handle's finally-unlink removed the other's staging bytes, and the winner's
    // lock could carry the loser's owner token, wedging the path after release.
    for (let round = 0; round < 60; round += 1) {
      const roundDir = fs.mkdtempSync(path.join(dir, "r-"));
      const a = createCollaborationLock({ stateDir: roundDir });
      const b = createCollaborationLock({ stateDir: roundDir });
      const [ra, rb] = await Promise.all([
        a.acquireCollaborationLock("a"),
        b.acquireCollaborationLock("b"),
      ]);
      assert.equal(
        Number(ra.acquired) + Number(rb.acquired),
        1,
        `round ${round}: exactly one handle must acquire`,
      );
      const winner = ra.acquired ? a : b;
      const held = await winner.loadCollaborationLock();
      assert.equal(held?.command, ra.acquired ? "a" : "b");
      await winner.releaseCollaborationLock();
      assert.equal(
        fs.existsSync(winner.getCollaborationLockPath()),
        false,
        `round ${round}: release must remove the winner's lock`,
      );
      assert.deepEqual(
        fs.readdirSync(roundDir).filter((n) => n.startsWith(STAGING_PREFIX)),
        [],
      );
    }
  });
});

// W7b review lane (L6/L7, 2026-09-26). L6: a foreign-host lock is reclaimable by
// age alone, so a createdAt in the future (a clock-skewed or corrupt writer) made
// it permanently immovable — `Date.now() - createdAt` never exceeds the window.
// L7: release ignored evictLockFile returning false (a live eviction claim on our
// own lock) and reported success while our lock stayed on disk. Each failed
// before the fix.
describe("collaboration lock — future timestamps and release outcome (W7b L6/L7)", () => {
  let dir;
  let lock;
  let warnings;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-lock-w7b-"));
    warnings = [];
    lock = createCollaborationLock({
      stateDir: dir,
      warn: (m) => warnings.push(m),
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const foreign = (createdAt) => ({
    command: "push",
    pid: DEAD_PID,
    createdAt,
    hostname: `not-${os.hostname()}`,
  });
  const plant = (payload) =>
    fs.writeFileSync(
      lock.getCollaborationLockPath(),
      JSON.stringify(payload),
      "utf8",
    );
  const minutesFromNow = (m) =>
    new Date(Date.now() + m * 60 * 1000).toISOString();

  it("exports the future-skew tolerance as five minutes", () => {
    assert.equal(COLLABORATION_LOCK_FUTURE_SKEW_MS, 5 * 60 * 1000);
  });

  it("treats a foreign-host lock dated far in the future as stale", () => {
    assert.equal(
      isCollaborationLockStale(foreign("2999-01-01T00:00:00.000Z")),
      true,
    );
    assert.equal(isCollaborationLockStale(foreign(minutesFromNow(6))), true);
  });

  it("tolerates ordinary clock skew: a lock one minute in the future is live", () => {
    assert.equal(isCollaborationLockStale(foreign(minutesFromNow(1))), false);
    assert.equal(isCollaborationLockStale(foreign(minutesFromNow(4))), false);
  });

  it("reclaims a future-dated foreign lock on acquire, and says so", async () => {
    plant(foreign("2999-01-01T00:00:00.000Z"));
    const res = await lock.acquireCollaborationLock("push");
    assert.equal(res.acquired, true);
    assert.equal((await lock.loadCollaborationLock())?.pid, process.pid);
    assert.ok(
      warnings.some((w) => /in the future/.test(w) && /2999-01-01/.test(w)),
      warnings.join("\n"),
    );
    await lock.releaseCollaborationLock();
  });

  it("reclaims an unparseable-timestamp lock on acquire, and says so", async () => {
    plant(foreign("not-a-date"));
    const res = await lock.acquireCollaborationLock("push");
    assert.equal(res.acquired, true);
    assert.ok(
      warnings.some((w) => /unparseable/.test(w) && /not-a-date/.test(w)),
      warnings.join("\n"),
    );
    await lock.releaseCollaborationLock();
  });

  it("warns on reclaimStaleLock of a future-dated lock too", async () => {
    plant(foreign("2999-01-01T00:00:00.000Z"));
    await lock.reclaimStaleLock();
    assert.equal(fs.existsSync(lock.getCollaborationLockPath()), false);
    assert.ok(warnings.some((w) => /in the future/.test(w)));
  });

  it("does not warn when an ordinary stale lock is reclaimed", async () => {
    plant(foreign(new Date(Date.now() - 31 * 60 * 1000).toISOString()));
    assert.equal((await lock.acquireCollaborationLock("push")).acquired, true);
    assert.deepEqual(warnings, []);
    await lock.releaseCollaborationLock();
  });

  const liveClaim = () =>
    JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      hostname: os.hostname(),
    });

  it("throws, and keeps holding the lock, when a live claim blocks release", async () => {
    assert.equal((await lock.acquireCollaborationLock("push")).acquired, true);
    const lockPath = lock.getCollaborationLockPath();
    const raw = fs.readFileSync(lockPath, "utf8");
    const claimPath = lock.getEvictionClaimPath(raw, 0);
    fs.writeFileSync(claimPath, liveClaim(), "utf8");

    await assert.rejects(lock.releaseCollaborationLock(), /could not release/i);
    assert.equal(fs.readFileSync(lockPath, "utf8"), raw);

    // Still held: once the blocker is gone, a retried release removes it.
    fs.unlinkSync(claimPath);
    await lock.releaseCollaborationLock();
    assert.equal(fs.existsSync(lockPath), false);
  });

  it("returns cleanly when the lock disappears while release is blocked", async () => {
    assert.equal((await lock.acquireCollaborationLock("push")).acquired, true);
    const lockPath = lock.getCollaborationLockPath();
    const raw = fs.readFileSync(lockPath, "utf8");
    fs.writeFileSync(lock.getEvictionClaimPath(raw, 0), liveClaim(), "utf8");

    let lockReads = 0;
    const realReadFile = fs.promises.readFile;
    const spy = mock.method(fs.promises, "readFile", (p, ...rest) => {
      if (String(p) === lockPath) {
        lockReads += 1;
        // The first read is release's own; any later one is the re-check after
        // the blocked eviction. The blocker's eviction completes in between.
        if (lockReads === 2) fs.rmSync(lockPath, { force: true });
      }
      return realReadFile.call(fs.promises, p, ...rest);
    });
    try {
      await lock.releaseCollaborationLock();
    } finally {
      spy.mock.restore();
    }
    assert.ok(lockReads >= 2);
    // No longer held: a later collaborator's lock is not ours to release.
    plant(foreign(new Date().toISOString()));
    await lock.releaseCollaborationLock();
    assert.equal(fs.existsSync(lockPath), true);
  });
});
