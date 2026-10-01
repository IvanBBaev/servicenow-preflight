// The QA-11 run-id-keyed artifact directory.
//
// This is the only module in the package that touches a filesystem, so every
// fixture below is a real temporary directory rather than a stubbed `fs`. The
// two behaviours that matter most here ARE filesystem behaviours — INJ-1
// containment (what `path.resolve` makes of a hostile name, and what
// `isUnderPath` then says about the result) and the tmp+rename atomicity — and
// a stub would only assert this file's beliefs about them.
//
// The assertions that carry the most weight are the ones about what must NOT
// happen:
//
//   * a name that escapes the run directory is REFUSED, never clamped back
//     into it. Clamping silently writes a file the caller did not ask for and
//     then hands back a ref that points at it;
//   * a write that cannot complete REJECTS. QA-9: unreadable is not empty. An
//     `ArtifactRef` returned for an artifact that is not on disk is a dangling
//     verdict, which the module header calls worse than a missing one — it
//     reads as evidence;
//   * a failed or in-flight write leaves no partial file under the FINAL name.
//     Content is staged at `<target>.<pid>.<uuid>.tmp` and renamed, so a reader can
//     never pick up a truncated payload and take it for the real one;
//   * on the READ side, `missing`, `unreadable` and a genuinely empty artifact
//     stay three distinct outcomes, and neither failure ever presents as an
//     empty payload. That is QA-9 stated as a fence: an edit that collapses
//     any pair of them fails here.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createArtifactStore } from "../build/index.js";

import { RUN_ID } from "./support.js";

const roots = [];

after(async () => {
  for (const root of roots) {
    // A permission test may have left a run directory unwritable; restoring
    // the mode is the only way the cleanup can remove it.
    await chmod(path.join(root, RUN_ID), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tessera-reporter-"));
  roots.push(root);
  return root;
}

/** A store over a fresh root, plus the root itself. */
async function makeStore(runId = RUN_ID) {
  const root = await makeRoot();
  return { root, store: createArtifactStore({ root, runId }) };
}

/** Read an artifact back the way a holder of an `ArtifactRef` has to. */
function readRef(root, ref) {
  return readFile(path.join(root, ref.ref), "utf8");
}

/** Directory listing, or `[]` when the directory was never created. */
const listing = (dir) =>
  readdir(dir).then(
    (entries) => entries.sort(),
    () => [],
  );

/** `chmod 500` is not a permission barrier for uid 0, so that test skips. */
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

/**
 * Why a permission-denied READ cannot be staged here, when it cannot. The
 * "unreadable" outcome is also proved WITHOUT permissions (a directory in the
 * artifact's place yields a non-`ENOENT` error everywhere), so the skip below
 * costs coverage of one errno, not coverage of the outcome.
 */
const cannotDenyRead = asRoot
  ? "chmod 0 does not bind uid 0"
  : process.platform === "win32"
    ? "POSIX permission bits do not deny a read on win32"
    : false;

/** Creating a symlink on win32 needs a privileged account or developer mode. */
const cannotSymlink =
  process.platform === "win32"
    ? "creating a symlink on win32 needs elevation"
    : false;

/**
 * Assert a read succeeded and hand back its payload. On failure the store's own
 * `reason` is the message, so a broken test says what the store observed.
 */
function okValue(result) {
  assert.equal(
    result.status,
    "ok",
    `expected a readable artifact, got ${result.status}: ${result.reason}`,
  );
  return result.value;
}

describe("artifact store", () => {
  describe("QA-11: the directory is keyed by run id", () => {
    it("puts every artifact under `<root>/<runId>`", async () => {
      const { root, store } = await makeStore();
      assert.equal(store.dir, path.join(root, RUN_ID));
      const ref = await store.put("atf.json", "{}", "atf-result");
      assert.deepEqual(ref, { kind: "atf-result", ref: `${RUN_ID}/atf.json` });
    });

    it("two run ids never collide, even for the same artifact name", async () => {
      const root = await makeRoot();
      const first = createArtifactStore({ root, runId: "run-first" });
      const second = createArtifactStore({ root, runId: "run-second" });

      const a = await first.put("atf.json", "FIRST", "atf-result");
      const b = await second.put("atf.json", "SECOND", "atf-result");

      assert.notEqual(first.dir, second.dir);
      assert.notEqual(a.ref, b.ref);
      assert.equal(await readRef(root, a), "FIRST");
      assert.equal(await readRef(root, b), "SECOND");
      assert.deepEqual(await listing(root), ["run-first", "run-second"]);
    });

    it("refuses a run id that is not a single path component", async () => {
      const root = await makeRoot();
      for (const runId of ["../evil", "a/b", "a\\b", "..", ".", ""]) {
        assert.throws(
          () => createArtifactStore({ root, runId }),
          /a runId must be a single path component/,
          `runId: ${JSON.stringify(runId)}`,
        );
      }
      assert.deepEqual(
        await listing(root),
        [],
        "no directory was created either",
      );
    });

    it("refuses a root that was never injected", () => {
      assert.throws(
        () => createArtifactStore({ root: "", runId: RUN_ID }),
        /`root` must be a non-empty path/,
      );
    });

    it("creates nothing until something is actually captured", async () => {
      const { root, store } = await makeStore();
      assert.deepEqual(
        await listing(root),
        [],
        "constructing a store made a directory",
      );
      await store.put("late.log", "captured", "log");
      assert.deepEqual(await listing(root), [RUN_ID]);
    });
  });

  describe("writes land under the root and read back", () => {
    it("round-trips text", async () => {
      const { root, store } = await makeStore();
      const ref = await store.put("console.log", "line one\nline two\n", "log");
      assert.equal(await readRef(root, ref), "line one\nline two\n");
    });

    it("round-trips bytes", async () => {
      const { root, store } = await makeStore();
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      const ref = await store.put("shot.png", bytes, "screenshot");
      assert.deepEqual(
        Uint8Array.from(await readFile(path.join(root, ref.ref))),
        bytes,
      );
    });

    it("round-trips a JSON payload — the materialised ATF rows (DEV-13)", async () => {
      const { root, store } = await makeStore();
      const rows = [{ sys_id: "8f31a0c4de11", status: "failure" }];
      const ref = await store.putJson("atf-result.json", rows, "atf-result");
      assert.deepEqual(JSON.parse(await readRef(root, ref)), rows);
    });

    it("nests through a `/` in the name and keeps the ref portable", async () => {
      const { root, store } = await makeStore();
      const ref = await store.put("specs/beta/trace.txt", "T", "trace");
      assert.equal(ref.ref, `${RUN_ID}/specs/beta/trace.txt`);
      assert.equal(
        path.isAbsolute(ref.ref),
        false,
        "an absolute ref would be a fact about one laptop",
      );
      assert.equal(
        ref.ref.includes("\\"),
        false,
        "separators are normalised to `/`",
      );
      assert.equal(await readRef(root, ref), "T");
    });

    it("replaces an existing artifact wholly, leaving no tail of the old one", async () => {
      const { root, store } = await makeStore();
      await store.put(
        "atf.json",
        "a much longer original payload",
        "atf-result",
      );
      const ref = await store.put("atf.json", "short", "atf-result");
      assert.equal(await readRef(root, ref), "short");
    });
  });

  describe("the read side returns exactly what the write side produced", () => {
    it("round-trips text — newlines and non-ASCII included", async () => {
      const { store } = await makeStore();
      const text = "line one\nline two\r\n\tотчёт — ✅ 日本語   tail\n";
      const ref = await store.put("console.log", text, "log");

      assert.equal(okValue(await store.readText(ref)), text);
      // And byte-identically, not merely "decodes to a string that matches":
      // a lossy round-trip would still satisfy the check above for some inputs.
      assert.deepEqual(
        okValue(await store.read(ref)),
        new TextEncoder().encode(text),
      );
    });

    it("round-trips bytes, including sequences that are not valid UTF-8", async () => {
      const { store } = await makeStore();
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
      const ref = await store.put("shot.png", bytes, "screenshot");

      const read = okValue(await store.read(ref));
      assert.deepEqual(read, bytes);
      assert.ok(
        read instanceof Uint8Array,
        "a Buffer would compare unequal to the Uint8Array that went in",
      );
    });

    it("round-trips the JSON payload putJson wrote (DEV-13)", async () => {
      const { store } = await makeStore();
      const rows = [{ sys_id: "8f31a0c4de11", status: "failure", note: "ä\n" }];
      const ref = await store.putJson("atf-result.json", rows, "atf-result");

      assert.deepEqual(okValue(await store.readJson(ref)), rows);
    });

    it("accepts the `ArtifactRef` put handed back, and its bare `.ref` string", async () => {
      const { store } = await makeStore();
      const ref = await store.put("specs/beta/trace.txt", "T", "trace");

      assert.equal(okValue(await store.readText(ref)), "T");
      assert.equal(okValue(await store.readText(ref.ref)), "T");
    });

    it("resolves a ref against the injected root — no caller rebuilds a path", async () => {
      const root = await makeRoot();
      const ref = await createArtifactStore({ root, runId: RUN_ID }).put(
        "atf.json",
        "{}",
        "atf-result",
      );
      assert.equal(path.isAbsolute(ref.ref), false);

      // The ref outlives the store that made it: a fresh store over the same
      // root reads it, which is what unpacking a run directory elsewhere is.
      const reopened = createArtifactStore({ root, runId: RUN_ID });
      assert.equal(okValue(await reopened.readText(ref)), "{}");
    });

    it("reads the replacement after an overwrite, never a tail of the old one", async () => {
      const { store } = await makeStore();
      await store.put(
        "atf.json",
        "a much longer original payload",
        "atf-result",
      );
      const ref = await store.put("atf.json", "short", "atf-result");

      assert.equal(okValue(await store.readText(ref)), "short");
    });
  });

  describe("INJ-1 containment: an escaping ref is refused, not clamped", () => {
    const escapes = [
      ["a parent traversal", "../escape.txt"],
      ["a traversal hidden behind a real segment", "specs/../../escape.txt"],
      ["a traversal deeper than the tree", "../../../../../../escape.txt"],
      [
        "a sibling run directory sharing a prefix",
        `../${RUN_ID}-evil/escape.txt`,
      ],
      ["the run directory itself", "."],
    ];

    for (const [label, name] of escapes) {
      it(`refuses ${label}`, async () => {
        const { root, store } = await makeStore();
        await store.put("real.log", "keep", "log");

        await assert.rejects(
          () => store.put(name, "OWNED", "file"),
          /resolves outside the run directory/,
          `name: ${JSON.stringify(name)}`,
        );

        // Refused, not clamped: the payload landed nowhere — not at the target
        // it aimed for (the root gained no entry), and not at some sanitised
        // name inside the run directory either.
        assert.deepEqual(await listing(root), [RUN_ID]);
        assert.deepEqual(await listing(store.dir), ["real.log"]);
      });
    }

    it("refuses an absolute ref, even one pointing at the store's own root", async () => {
      const { root, store } = await makeStore();
      await assert.rejects(
        () => store.put(path.join(root, "escape.txt"), "OWNED", "file"),
        /resolves outside the run directory/,
      );
      assert.deepEqual(await listing(root), [], "nothing was written at all");
    });

    it("refuses an empty name rather than writing to the directory itself", async () => {
      const { root, store } = await makeStore();
      await assert.rejects(
        () => store.put("", "OWNED", "file"),
        /must be a non-empty string/,
      );
      assert.deepEqual(await listing(root), []);
    });

    it("applies the same guard to putJson", async () => {
      const { root, store } = await makeStore();
      await assert.rejects(
        () => store.putJson("../escape.json", { owned: true }, "file"),
        /resolves outside the run directory/,
      );
      assert.deepEqual(await listing(root), []);
    });
  });

  describe("INJ-1 containment: the read path refuses an escaping ref too", () => {
    // A read is the sharper half of INJ-1: a write that escapes corrupts a
    // file, a read that escapes puts the file's CONTENTS into a verdict. Every
    // case below plants recognisable bytes outside the run directory and
    // asserts they never come back.
    const escapes = [
      ["a parent traversal", "../outside.txt"],
      ["a traversal out of the run directory", `${RUN_ID}/../outside.txt`],
      [
        "a traversal hidden behind a real segment",
        `${RUN_ID}/x/../../outside.txt`,
      ],
      [
        "a sibling run sharing the run id as a prefix",
        `${RUN_ID}-evil/outside.txt`,
      ],
      ["a path under the root but outside the run", "outside.txt"],
      ["another run's evidence", "run-someone-else/atf.json"],
      ["the run directory itself", RUN_ID],
      ["the run directory with a trailing separator", `${RUN_ID}/`],
    ];

    for (const [label, ref] of escapes) {
      it(`refuses ${label}`, async () => {
        const { root, store } = await makeStore();
        await store.put("real.log", "keep", "log");
        await writeFile(path.join(root, "outside.txt"), "OWNED");

        await assert.rejects(
          () => store.read(ref),
          /refusing to read .+ resolves outside the run directory/,
          `ref: ${JSON.stringify(ref)}`,
        );
        // Refused, not degraded into a `missing`/`unreadable` result: an
        // escaping ref is a fact about the ref, and a status can be ignored.
        await assert.rejects(() => store.readText(ref));
        await assert.rejects(() => store.readJson(ref));
      });
    }

    it("refuses an absolute ref that lands outside the run directory", async () => {
      const { root, store } = await makeStore();
      const ref = await store.put("atf.json", "{}", "atf-result");
      await writeFile(path.join(root, "outside.txt"), "OWNED");

      await assert.rejects(
        () => store.read(path.join(root, "outside.txt")),
        /refusing to read/,
      );
      // There is ONE rule here — containment — and it is the write path's
      // rule. An absolute SPELLING of an artifact that is inside the run
      // directory is not a second thing to ban: it resolves to the same
      // contained target, and refusing it would be a rule that only this side
      // enforces, i.e. exactly the drift the module header warns against.
      assert.equal(
        okValue(await store.readText(path.join(store.dir, "atf.json"))),
        "{}",
      );
      assert.equal(okValue(await store.readText(ref)), "{}");
    });

    it("refuses a ref that is not a non-empty string", async () => {
      const { store } = await makeStore();
      for (const ref of [
        "",
        null,
        undefined,
        42,
        {},
        { ref: "" },
        { ref: 7 },
      ]) {
        await assert.rejects(
          () => store.read(ref),
          /`ref` must be a non-empty string/,
          `ref: ${JSON.stringify(ref)}`,
        );
      }
    });

    it(
      "refuses a symlink that leaves the run directory rather than following it",
      { skip: cannotSymlink },
      async () => {
        const { root, store } = await makeStore();
        await store.put("real.log", "keep", "log");
        await writeFile(path.join(root, "outside.txt"), "OWNED");
        await symlink(
          path.join(root, "outside.txt"),
          path.join(store.dir, "leak.txt"),
        );

        // The ref is textually impeccable — `<runId>/leak.txt` resolves inside
        // the run directory. Only resolving the link exposes the escape, which
        // is why containment is re-checked after `realpath` and not only on
        // the string.
        await assert.rejects(
          () => store.read(`${RUN_ID}/leak.txt`),
          /refusing to read .+ resolves outside the run directory/,
        );
      },
    );

    it(
      "refuses an escape through a symlinked directory inside the run directory",
      { skip: cannotSymlink },
      async () => {
        const { root, store } = await makeStore();
        await store.put("real.log", "keep", "log");
        await writeFile(path.join(root, "outside.txt"), "OWNED");
        await symlink(root, path.join(store.dir, "up"));

        await assert.rejects(
          () => store.read(`${RUN_ID}/up/outside.txt`),
          /refusing to read .+ resolves outside the run directory/,
        );
      },
    );

    it(
      "still reads a symlink that stays inside — the rule is containment, not a symlink ban",
      { skip: cannotSymlink },
      async () => {
        const { store } = await makeStore();
        await store.put("real/data.txt", "INSIDE", "file");
        await symlink(
          path.join(store.dir, "real", "data.txt"),
          path.join(store.dir, "alias.txt"),
        );

        assert.equal(
          okValue(await store.readText(`${RUN_ID}/alias.txt`)),
          "INSIDE",
        );
      },
    );
  });

  describe("INJ-1 containment: the write path resolves links too", () => {
    it(
      "refuses a put through a symlinked directory that leaves the run directory",
      { skip: cannotSymlink },
      async () => {
        const { root, store } = await makeStore();
        await store.put("real.log", "keep", "log");
        const outside = path.join(root, "OUTSIDE");
        await mkdir(outside);
        await symlink(outside, path.join(store.dir, "evidence"));

        // Lexically `<runId>/evidence/pwned.txt` is inside the run directory;
        // only resolving `evidence` exposes the escape — the same reason the
        // read side re-checks after `realpath`.
        await assert.rejects(
          () => store.put("evidence/pwned.txt", "escaped", "log"),
          /refusing to write .+ resolves outside the run directory/,
        );
        // A nested name must not even create directories out there on its
        // way to the refusal.
        await assert.rejects(
          () => store.put("evidence/a/b/pwned.txt", "escaped", "log"),
          /refusing to write .+ resolves outside the run directory/,
        );
        await assert.rejects(
          () => store.putJson("evidence/pwned.json", {}, "atf-result"),
          /refusing to write .+ resolves outside the run directory/,
        );
        assert.deepEqual(await listing(outside), []);
      },
    );

    it(
      "refuses a put whose target name is itself a symlink",
      { skip: cannotSymlink },
      async () => {
        const { root, store } = await makeStore();
        await store.put("real.log", "keep", "log");
        await writeFile(path.join(root, "outside.txt"), "UNTOUCHED");
        await symlink(
          path.join(root, "outside.txt"),
          path.join(store.dir, "leak.txt"),
        );

        await assert.rejects(
          () => store.put("leak.txt", "overwrite", "log"),
          /refusing to write .+ symbolic link/,
        );
        assert.equal(
          await readFile(path.join(root, "outside.txt"), "utf8"),
          "UNTOUCHED",
        );
      },
    );

    it(
      "still writes through a symlinked directory that stays inside — containment, not a ban",
      { skip: cannotSymlink },
      async () => {
        const { store } = await makeStore();
        await store.put("real/keep.txt", "k", "file");
        await symlink(
          path.join(store.dir, "real"),
          path.join(store.dir, "alias"),
        );

        const ref = await store.put("alias/data.txt", "INSIDE", "file");
        assert.equal(okValue(await store.readText(ref)), "INSIDE");
        assert.equal(
          await readFile(path.join(store.dir, "real", "data.txt"), "utf8"),
          "INSIDE",
        );
      },
    );
  });

  describe("QA-9: unreadable is not empty", () => {
    it("a value with no JSON representation is refused, not written as an empty file", async () => {
      const { store } = await makeStore();
      for (const value of [undefined, () => {}, Symbol("nope")]) {
        await assert.rejects(
          () => store.putJson("atf.json", value, "atf-result"),
          /has no JSON representation/,
          `value: ${String(value)}`,
        );
      }
      assert.deepEqual(
        await listing(store.dir),
        [],
        "an empty file here would be indistinguishable from a captured empty one",
      );
    });

    it(
      "a write that cannot complete REJECTS — no ref is handed back for an absent artifact",
      { skip: asRoot ? "chmod 500 does not bind uid 0" : false },
      async () => {
        const { store } = await makeStore();
        await store.put("first.log", "captured", "log");
        await chmod(store.dir, 0o500);
        try {
          await assert.rejects(() => store.put("second.log", "lost", "log"));
          assert.deepEqual(
            await listing(store.dir),
            ["first.log"],
            "the artifact that could not be written is absent, not empty",
          );
        } finally {
          await chmod(store.dir, 0o700);
        }
      },
    );

    it("a refused artifact does not poison the ones after it", async () => {
      const { root, store } = await makeStore();
      await assert.rejects(() => store.put("../escape.txt", "OWNED", "file"));
      const ref = await store.put("after.log", "still works", "log");
      assert.equal(await readRef(root, ref), "still works");
    });
  });

  describe("QA-9 read side: missing, unreadable and empty are three outcomes", () => {
    it("a genuinely empty artifact reads `ok` with zero bytes", async () => {
      const { store } = await makeStore();
      const ref = await store.put("empty.log", "", "log");

      assert.deepEqual(okValue(await store.read(ref)), new Uint8Array(0));
      assert.equal(okValue(await store.readText(ref)), "");
    });

    it("an absent artifact reads `missing`, with no payload to fall through to", async () => {
      const { store } = await makeStore();
      await store.put("real.log", "keep", "log");

      const result = await store.read(`${RUN_ID}/never-captured.log`);
      assert.equal(result.status, "missing");
      assert.equal("value" in result, false);
      assert.match(result.reason, /no artifact exists at/);
    });

    it("an absent artifact is `missing` even when the run directory was never created", async () => {
      const { store } = await makeStore();
      assert.equal((await store.read(`${RUN_ID}/atf.json`)).status, "missing");
    });

    it("a directory in the artifact's place is `unreadable`, not `missing` and not empty", async () => {
      const { store } = await makeStore();
      await store.put("nested/trace.txt", "T", "trace");

      // Portable on purpose: this proves the outcome without a permissions
      // trick, so it holds as root and on any filesystem. The errno differs by
      // platform (EISDIR on POSIX); what must not differ is that it is not
      // ENOENT, because ENOENT is the only code allowed to claim `missing`.
      const result = await store.read(`${RUN_ID}/nested`);
      assert.equal(result.status, "unreadable", `code: ${result.code}`);
      assert.notEqual(result.code, "ENOENT");
      assert.equal("value" in result, false);
    });

    it(
      "an artifact whose permissions deny the read is `unreadable`, never `missing` or empty",
      { skip: cannotDenyRead },
      async () => {
        const { store } = await makeStore();
        const ref = await store.put("secret.log", "captured evidence", "log");
        const target = path.join(store.dir, "secret.log");
        await chmod(target, 0o000);
        try {
          const result = await store.read(ref);
          assert.equal(result.status, "unreadable");
          assert.equal("value" in result, false);
          assert.match(result.code, /^E(ACCES|PERM)$/);
        } finally {
          await chmod(target, 0o600);
        }
      },
    );

    it("the three outcomes stay three — collapsing any pair fails here", async () => {
      const { store } = await makeStore();
      await store.put("empty.log", "", "log");
      await store.put("nested/trace.txt", "T", "trace");

      const empty = await store.read(`${RUN_ID}/empty.log`);
      const absent = await store.read(`${RUN_ID}/never-captured.log`);
      const blocked = await store.read(`${RUN_ID}/nested`);

      const statuses = [empty.status, absent.status, blocked.status];
      assert.deepEqual(statuses, ["ok", "missing", "unreadable"]);
      assert.equal(
        new Set(statuses).size,
        3,
        "two outcomes collapsed into one",
      );

      // The exact defect QA-9 names: neither failure may present as an empty
      // payload. Rendering "" for an unreadable artifact asserts "the run
      // produced no output" — a claim the store is in no position to make.
      for (const failed of [absent, blocked]) {
        assert.equal(
          "value" in failed,
          false,
          `${failed.status} has a payload`,
        );
        assert.notEqual(failed.value, "");
        assert.notEqual(failed.value, null);
        assert.ok(failed.reason.length > 0, "a failure must say what happened");
      }
      // …and the converse: an empty artifact is not reported as a failure.
      assert.deepEqual(empty.value, new Uint8Array(0));
    });

    it('readText and readJson report the same three outcomes, never `""`', async () => {
      const { store } = await makeStore();
      await store.put("nested/trace.txt", "T", "trace");

      for (const [label, readOne] of [
        ["readText", (ref) => store.readText(ref)],
        ["readJson", (ref) => store.readJson(ref)],
      ]) {
        const absent = await readOne(`${RUN_ID}/never-captured.json`);
        assert.equal(absent.status, "missing", label);
        assert.equal("value" in absent, false, `${label} returned a payload`);

        const blocked = await readOne(`${RUN_ID}/nested`);
        assert.equal(blocked.status, "unreadable", label);
        assert.equal("value" in blocked, false, `${label} returned a payload`);
      }
    });

    it("bytes that are not JSON read `malformed` — present, readable, not a document", async () => {
      const { store } = await makeStore();
      const body = "<html>504 Gateway Timeout</html>";
      const ref = await store.put("atf-result.json", body, "atf-result");

      const result = await store.readJson(ref);
      assert.equal(result.status, "malformed");
      assert.equal("value" in result, false);
      // `malformed` is a statement about the document, not about the file: the
      // bytes are still there and still recoverable, which is how a reporter
      // can quote what the instance actually returned.
      assert.equal(okValue(await store.readText(ref)), body);
    });

    it("an empty artifact read as JSON is `malformed`, not `ok` with null", async () => {
      const { store } = await makeStore();
      const ref = await store.put("atf-result.json", "", "atf-result");

      const result = await store.readJson(ref);
      assert.equal(result.status, "malformed");
      assert.equal(okValue(await store.read(ref)).length, 0);
    });

    it("never reports a decoded character count as a byte count", async () => {
      const { store } = await makeStore();

      // The `malformed` reason quantifies the artifact — "holds N byte(s)" —
      // to a reader who does not have the file and so cannot check N. Until
      // 2026-09-03 N was the decoded string's `.length`: UTF-16 code units of
      // a lossy decode, which is smaller than the file for any multi-byte
      // character and much smaller when the bytes are not valid UTF-8 at all.
      // Both fixtures below separate the two numbers; the notEqual guard is
      // what keeps this test from passing vacuously if they ever stop doing so.
      for (const { name, body } of [
        { name: "multibyte.json", body: "504 — a naïve façade, not JSON" },
        { name: "truncated.json", body: new Uint8Array([0xe2, 0x80]) },
      ]) {
        const ref = await store.put(name, body, "atf-result");
        const onDisk = await readFile(path.join(store.dir, name));
        const decoded = new TextDecoder().decode(onDisk);
        assert.notEqual(
          decoded.length,
          onDisk.byteLength,
          `${name}: fixture does not separate characters from bytes`,
        );

        const result = await store.readJson(ref);
        assert.equal(result.status, "malformed", name);
        assert.match(
          result.reason,
          new RegExp(`\\b${onDisk.byteLength} byte\\(s\\)`),
          `${name}: the reason did not name the bytes that were read`,
        );
        assert.equal(
          new RegExp(`\\b${decoded.length} byte\\(s\\)`).test(result.reason),
          false,
          `${name}: the reason named the decoded length as a byte count`,
        );
      }
    });

    it("a JSON artifact holding `null` reads `ok` with null — a document, not a failure", async () => {
      const { store } = await makeStore();
      const ref = await store.putJson("atf-result.json", null, "atf-result");

      const result = await store.readJson(ref);
      assert.equal(result.status, "ok");
      assert.equal(result.value, null);
    });

    it(
      "a dangling symlink is `missing` — nothing was read, so nothing escaped",
      { skip: cannotSymlink },
      async () => {
        const { root, store } = await makeStore();
        await store.put("real.log", "keep", "log");
        await symlink(
          path.join(root, "never-existed.txt"),
          path.join(store.dir, "dangling.txt"),
        );

        // The link exists; its target does not. Any reader sees ENOENT, so
        // `missing` is the honest answer — and no bytes crossed the boundary,
        // which is what containment has to guarantee.
        const result = await store.read(`${RUN_ID}/dangling.txt`);
        assert.equal(result.status, "missing");
        assert.equal("value" in result, false);
      },
    );

    it(
      "a symlink loop is `unreadable`, not `missing`",
      { skip: cannotSymlink },
      async () => {
        const { store } = await makeStore();
        await store.put("real.log", "keep", "log");
        await symlink("loop.txt", path.join(store.dir, "loop.txt"));

        // ELOOP on POSIX. The assertion pins the OUTCOME, not the errno.
        const result = await store.read(`${RUN_ID}/loop.txt`);
        assert.equal(result.status, "unreadable", `code: ${result.code}`);
        assert.notEqual(result.code, "ENOENT");
      },
    );

    it("a refused read does not poison the reads after it", async () => {
      const { store } = await makeStore();
      const ref = await store.put("after.log", "still works", "log");

      await assert.rejects(() => store.read("../outside.txt"));
      assert.equal((await store.read(`${RUN_ID}/gone.log`)).status, "missing");
      assert.equal(okValue(await store.readText(ref)), "still works");
    });
  });

  describe("writes are atomic (tmp + rename)", () => {
    it("leaves no `.tmp` sibling behind on the happy path", async () => {
      const { store } = await makeStore();
      await store.put("atf.json", "{}", "atf-result");
      await store.put("nested/trace.txt", "T", "trace");
      assert.deepEqual(await listing(store.dir), ["atf.json", "nested"]);
      assert.deepEqual(await listing(path.join(store.dir, "nested")), [
        "trace.txt",
      ]);
    });

    it("cannot leave a truncated payload under the final name", async () => {
      const { root, store } = await makeStore();
      const original = "the original payload, whole and intact";
      const ref = await store.put("atf.json", original, "atf-result");

      // The staging name is unique per attempt since 2026-09-25
      // (`<target>.<pid>.<uuid>.tmp`), so it can no longer be pre-blocked by
      // name. Denying writes to the run directory makes the STAGING write
      // fail instead, which pins the same claim: the final name is touched
      // only by the rename, which never ran.
      if (asRoot || process.platform === "win32") return;
      await chmod(store.dir, 0o500);
      try {
        await assert.rejects(() =>
          store.put("atf.json", "X".repeat(4096), "atf-result"),
        );
      } finally {
        await chmod(store.dir, 0o700);
      }

      assert.equal(
        await readRef(root, ref),
        original,
        "the previous artifact was truncated, emptied or replaced",
      );
      assert.deepEqual(await listing(store.dir), ["atf.json"]);
    });

    it("concurrent puts of the same name all succeed — each stages under its own name", async () => {
      // Until 2026-09-25 every put in one process staged at the same
      // `<target>.<pid>.tmp`: the first rename moved it away and most of the
      // others failed with ENOENT (17 of 20 in the review repro).
      const { root, store } = await makeStore();
      const payloads = Array.from(
        { length: 20 },
        (_, index) => `v${index}${"x".repeat(100_000)}`,
      );
      const results = await Promise.allSettled(
        payloads.map((payload) => store.put("same.txt", payload, "log")),
      );
      assert.deepEqual(
        results.map((result) =>
          result.status === "fulfilled" ? "ok" : result.reason.code,
        ),
        payloads.map(() => "ok"),
      );
      const final = await readRef(root, { ref: `${RUN_ID}/same.txt` });
      assert.ok(
        payloads.includes(final),
        "the final artifact is not one whole payload",
      );
      assert.deepEqual(await listing(store.dir), ["same.txt"]);
    });

    it("a concurrent reader sees one whole payload or the other, never a seam", async () => {
      const { store } = await makeStore();
      // Pre-seed the name, so a non-atomic writer (open-truncate-write) would
      // expose an empty or short file the instant it opened it, and an
      // unlink-then-write one would expose an ENOENT. Neither is allowed: every
      // observation below must be one of the two WHOLE payloads.
      const first = "A".repeat(64 * 1024);
      const second = "B".repeat(96 * 1024);
      await store.put("big.log", first, "log");

      const target = path.join(store.dir, "big.log");
      const seen = [];
      const reads = (async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          seen.push(
            await readFile(target, "utf8").then(
              (text) =>
                text === first ? "first" : text === second ? "second" : text,
              (error) =>
                `the final name was momentarily unreadable: ${error.code}`,
            ),
          );
        }
      })();
      await Promise.all([store.put("big.log", second, "log"), reads]);

      for (const observation of seen) {
        assert.ok(
          observation === "first" || observation === "second",
          typeof observation === "string" && observation.length > 32
            ? `observed a partial artifact of ${observation.length} byte(s)`
            : observation,
        );
      }
      assert.equal(await readFile(target, "utf8"), second);
    });

    it("does not mistake an unrelated `.tmp` name for a staged write", async () => {
      const { root, store } = await makeStore();
      await store.put("atf.json", "{}", "atf-result");
      // A `.tmp`-suffixed artifact is a legitimate name to capture; only the
      // writer's own `<target>.<pid>.tmp` is special, and only in flight.
      const ref = await store.put("atf.json.tmp", "not staging", "file");
      assert.equal(await readRef(root, ref), "not staging");
      assert.equal(await readRef(root, { ref: `${RUN_ID}/atf.json` }), "{}");
    });
  });
});
