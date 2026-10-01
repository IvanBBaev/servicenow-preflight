// The tests-as-code repo read — DESIGN §4, PLAN Phase 4 read side.
//
// `readSpecInventory` touches a real filesystem, so every fixture here is a
// real temporary directory rather than a stubbed `fs`. That is deliberate: the
// behaviour under test is almost entirely about what the filesystem does at
// the edges — an ENOENT that is a legitimate repo state, an EISDIR that is
// not, a path that resolves out of the tree — and a stub would be asserting
// this file's idea of those errnos instead of the platform's.
//
// The assertions that matter most are the ones about what must NOT happen. A
// manifest that cannot be read must not come back as an inventory of nothing
// (`SpecStoreFaultError`: an empty inventory is a claim, and the worst wrong
// one this package can make); a dropped entry must not be dropped quietly; and
// no file on disk may become a spec, because a spec-looking path carries no
// declared targets and QA-16 forbids inventing them.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SpecInputError,
  SpecStoreFaultError,
  readSpecInventory,
} from "../build/index.js";

const roots = [];

after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A tests root on disk. `files` maps root-relative paths to contents;
 * `manifest` is written as JSON unless it is already a string.
 */
async function makeRoot({ manifest, files = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tessera-specs-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  if (manifest !== undefined) {
    await writeFile(
      path.join(root, ".manifest.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
  return root;
}

/** A 32-hex sys_id from a short prefix — the fixtures read by name, not by id. */
function sysId(prefix) {
  return prefix.padEnd(32, "0");
}

const CALCULATOR = {
  table: "sys_script_include",
  sysId: sysId("ca1c"),
  name: "AmountCalculator",
};
const ZONE = {
  table: "sys_script_include",
  sysId: sysId("20ne"),
  name: "ZoneLookup",
};

function entry(id, file, { kind = "unit", targets = [CALCULATOR] } = {}) {
  return { id, path: file, kind, targets };
}

function manifestOf(specs, version = 1) {
  return { version, specs };
}

function messages(inventory, level) {
  return inventory.notes
    .filter((note) => level === undefined || note.level === level)
    .map((note) => note.message);
}

function ids(inventory) {
  return inventory.specs.map((spec) => spec.ref.id);
}

/** `chmod 000` is not a permission barrier for uid 0, so those tests skip. */
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("a manifest that reads cleanly", () => {
  it("returns one spec per entry, with its declared targets", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("calc", "sys_script_include/AmountCalculator/calc.unit.ts", {
          targets: [CALCULATOR, ZONE],
        }),
        entry("flow", "ui/checkout.spec.ts", { kind: "ui", targets: [ZONE] }),
      ]),
      files: {
        "sys_script_include/AmountCalculator/calc.unit.ts": "// spec",
        "ui/checkout.spec.ts": "// spec",
      },
    });

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(inventory.specs, [
      {
        ref: {
          id: "calc",
          path: "sys_script_include/AmountCalculator/calc.unit.ts",
        },
        kind: "unit",
        targets: [CALCULATOR, ZONE],
      },
      {
        ref: { id: "flow", path: "ui/checkout.spec.ts" },
        kind: "ui",
        targets: [ZONE],
      },
    ]);
    // Nothing was dropped and nothing on disk went unclaimed, so there is
    // nothing to say — and `incomplete` follows from that, not from a flag set
    // by hand in the happy branch.
    assert.deepEqual(inventory.notes, []);
    assert.equal(inventory.incomplete, false);
  });

  it("leaves `payload` undefined — the inventory never opens the file", async () => {
    const root = await makeRoot({
      manifest: manifestOf([entry("calc", "a.unit.ts")]),
      files: { "a.unit.ts": "steps: [not, read, by, this, package]" },
    });

    const [spec] = (await readSpecInventory({ root })).specs;
    assert.equal(spec.payload, undefined);
    assert.equal("payload" in spec, false);
  });

  it("sorts by id in codepoint order, not the runner's locale", async () => {
    const root = await makeRoot({
      // `localeCompare` in an en locale orders these a, B, Z; codepoint order
      // is B, Z, a. Only the second is the same on every CI runner.
      manifest: manifestOf([
        entry("a-spec", "a.unit.ts"),
        entry("Z-spec", "z.unit.ts"),
        entry("B-spec", "b.unit.ts"),
      ]),
      files: {
        "a.unit.ts": "//",
        "z.unit.ts": "//",
        "b.unit.ts": "//",
      },
    });

    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["B-spec", "Z-spec", "a-spec"]);
  });

  it("produces byte-identical output across runs", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("b", "b.unit.ts"),
        entry("a", "a.unit.ts"),
        entry("b", "b2.unit.ts"),
        entry("gone", "missing.unit.ts"),
      ]),
      files: {
        "a.unit.ts": "//",
        "b.unit.ts": "//",
        "b2.unit.ts": "//",
        "stray.unit.ts": "//",
      },
    });

    const first = await readSpecInventory({ root });
    const second = await readSpecInventory({ root });
    assert.deepEqual(first, second);
    assert.equal(
      JSON.stringify(first),
      JSON.stringify(second),
      "note order must be stable, or a CI log cannot be diffed",
    );
  });
});

describe("an absent manifest", () => {
  it("is an empty repo state, reported as info and not as a warning", async () => {
    const root = await makeRoot();

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(inventory.specs, []);
    assert.equal(inventory.incomplete, false);
    assert.deepEqual(messages(inventory, "warning"), []);
    const [info, ...rest] = messages(inventory, "info");
    assert.deepEqual(rest, []);
    // The note has to name the case, so an empty list in a log can never be
    // confused with a read that failed.
    assert.match(info, /\.manifest\.json/);
    assert.match(info, /registers no specs yet/);
  });

  it("says something different from a manifest that registers nothing", async () => {
    const absent = await readSpecInventory({ root: await makeRoot() });
    const empty = await readSpecInventory({
      root: await makeRoot({ manifest: manifestOf([]) }),
    });

    assert.deepEqual(empty.specs, []);
    assert.equal(empty.incomplete, false);
    assert.notDeepEqual(messages(absent, "info"), messages(empty, "info"));
    assert.match(messages(empty, "info")[0], /registers no specs/);
  });

  it("limits its claim to the registry, because the tree is never scanned", async () => {
    // This branch returns before the disk walk, so its note cannot be a
    // statement about what is on disk — and the proof is that the note does
    // not move when the disk does. What it must therefore do is say so;
    // otherwise a reader takes the same sentence as "there is nothing here"
    // for a root that is full of unregistered spec files.
    const bare = await readSpecInventory({ root: await makeRoot() });
    const populated = await readSpecInventory({
      root: await makeRoot({
        files: {
          "sys_script/Alpha/alpha.unit.ts": "//",
          "ui/checkout.spec.ts": "//",
        },
      }),
    });

    assert.deepEqual(populated.specs, []);
    assert.equal(populated.incomplete, false);
    assert.deepEqual(messages(populated, "warning"), []);

    const stripRoot = (message) => message.replace(/ in \/\S+:/, " in <root>:");
    assert.deepEqual(
      messages(populated, "info").map(stripRoot),
      messages(bare, "info").map(stripRoot),
    );
    assert.match(messages(populated, "info")[0], /not scanned/);
  });
});

describe("a manifest that exists and cannot be used", () => {
  /** Each fixture builds a root whose manifest is present and unusable. */
  const FAULTS = {
    "unreadable (a directory in its place)": async () => {
      const root = await makeRoot();
      await mkdir(path.join(root, ".manifest.json"));
      return root;
    },
    "not JSON": () => makeRoot({ manifest: "{ specs: [" }),
    "JSON that is an array": () => makeRoot({ manifest: "[]" }),
    "JSON that is a string": () => makeRoot({ manifest: '"tests"' }),
    "no version": () => makeRoot({ manifest: { specs: [] } }),
    "a version that is not a number": () =>
      makeRoot({ manifest: { version: "1", specs: [] } }),
    "a future version": () => makeRoot({ manifest: manifestOf([], 2) }),
    "no specs": () => makeRoot({ manifest: { version: 1 } }),
    "specs that are not an array": () =>
      makeRoot({ manifest: { version: 1, specs: {} } }),
  };

  for (const [label, fixture] of Object.entries(FAULTS)) {
    it(`throws SpecStoreFaultError: ${label}`, async () => {
      const root = await fixture();
      await assert.rejects(
        () => readSpecInventory({ root }),
        SpecStoreFaultError,
      );
    });
  }

  it("can NEVER answer an empty inventory instead of throwing", async () => {
    // The single most important assertion in this file. An empty inventory is
    // a claim — "this repo intends to test nothing" — and every fault above
    // has an empty inventory sitting one `catch` away from it. If any of these
    // ever returns `{specs: [], incomplete: false}`, every impacted artifact
    // downstream becomes a gap, or worse, a clean slate.
    for (const [label, fixture] of Object.entries(FAULTS)) {
      const root = await fixture();
      let returned;
      try {
        returned = await readSpecInventory({ root });
      } catch (error) {
        assert.ok(
          error instanceof SpecStoreFaultError,
          `${label}: threw ${String(error)}`,
        );
        continue;
      }
      assert.fail(
        `${label}: returned an inventory of ${returned.specs.length} spec(s) with incomplete=${String(returned.incomplete)} instead of throwing`,
      );
    }
  });

  it("names the version it refused, so the fix is in the message", async () => {
    const root = await makeRoot({ manifest: manifestOf([], 2) });
    await assert.rejects(
      () => readSpecInventory({ root }),
      (error) => {
        assert.ok(error instanceof SpecStoreFaultError);
        assert.match(error.message, /version 2/);
        assert.match(error.message, /version 1 only/);
        return true;
      },
    );
  });

  it("keeps the underlying failure as `cause`", async () => {
    const root = await makeRoot({ manifest: "{ oops" });
    await assert.rejects(
      () => readSpecInventory({ root }),
      (error) => {
        assert.ok(error.cause instanceof Error);
        return true;
      },
    );
  });
});

describe("a root that is not a tests root", () => {
  it("throws SpecInputError when the directory does not exist", async () => {
    const root = path.join(await makeRoot(), "nowhere");
    await assert.rejects(() => readSpecInventory({ root }), SpecInputError);
  });

  it("throws SpecInputError when the path is a file", async () => {
    const parent = await makeRoot({ files: { "tests.txt": "not a tree" } });
    await assert.rejects(
      () => readSpecInventory({ root: path.join(parent, "tests.txt") }),
      SpecInputError,
    );
  });

  it("throws SpecInputError on a blank root rather than reading the cwd", async () => {
    // `path.resolve("")` is the process working directory — an accident every
    // time (`--root "$UNSET"`) and a request never.
    await assert.rejects(() => readSpecInventory({ root: "" }), SpecInputError);
    await assert.rejects(
      () => readSpecInventory({ root: "   " }),
      SpecInputError,
    );
  });
});

describe("an entry that does not validate", () => {
  it("is dropped and named, and the entries around it survive", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("good", "good.unit.ts"),
        entry("rotten", "rotten.unit.ts", { kind: 7 }),
        entry("also-good", "also.unit.ts"),
      ]),
      files: {
        "good.unit.ts": "//",
        "rotten.unit.ts": "//",
        "also.unit.ts": "//",
      },
    });

    const inventory = await readSpecInventory({ root });

    // One rotten entry must not blind the reader to the others.
    assert.deepEqual(ids(inventory), ["also-good", "good"]);
    const [warning, ...rest] = messages(inventory, "warning");
    assert.deepEqual(rest, []);
    assert.match(warning, /`rotten`/);
    assert.match(warning, /kind/);
    assert.equal(inventory.incomplete, true);
  });

  it("falls back to the array index when the id itself is unusable", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("good", "good.unit.ts"),
        { path: "nameless.unit.ts", kind: "unit", targets: [] },
        { id: "   ", path: "blank.unit.ts", kind: "unit", targets: [] },
        "not even an object",
      ]),
      files: { "good.unit.ts": "//" },
    });

    const warned = messages(await readSpecInventory({ root }), "warning");
    // A warning about "the entry with no id" is unactionable in a manifest
    // with forty of them; the index is the only handle left.
    assert.ok(warned.some((message) => /#1/.test(message)));
    assert.ok(warned.some((message) => /#2/.test(message)));
    assert.ok(warned.some((message) => /#3/.test(message)));
  });

  const MALFORMED = {
    "a path that is absent": { id: "x", kind: "unit", targets: [] },
    "a path that is blank": { id: "x", path: "  ", kind: "unit", targets: [] },
    "a kind outside TEST_KINDS": {
      id: "x",
      path: "x.unit.ts",
      kind: "smoke",
      targets: [],
    },
    "targets that are not an array": {
      id: "x",
      path: "x.unit.ts",
      kind: "unit",
      targets: "sys_script_include/AmountCalculator",
    },
    "a target that is not an object": {
      id: "x",
      path: "x.unit.ts",
      kind: "unit",
      targets: ["AmountCalculator"],
    },
    "a target with no sysId": {
      id: "x",
      path: "x.unit.ts",
      kind: "unit",
      targets: [{ table: "sys_script_include", name: "AmountCalculator" }],
    },
    "a target with a blank table": {
      id: "x",
      path: "x.unit.ts",
      kind: "unit",
      targets: [{ table: "", sysId: sysId("ca1c"), name: "A" }],
    },
  };

  for (const [label, malformed] of Object.entries(MALFORMED)) {
    it(`drops an entry with ${label}, with a warning naming it`, async () => {
      const root = await makeRoot({
        manifest: manifestOf([malformed]),
        files: { "x.unit.ts": "//" },
      });

      const inventory = await readSpecInventory({ root });

      assert.deepEqual(inventory.specs, []);
      assert.equal(inventory.incomplete, true);
      const warned = messages(inventory, "warning");
      assert.ok(warned.some((message) => /`x`/.test(message)));
    });
  }

  it("keeps an entry whose targets are an empty array", async () => {
    // Valid wire data. It declares nothing, so it joins to nothing and cannot
    // inflate a gap count — a review comment, not a defect in the reader.
    const root = await makeRoot({
      manifest: manifestOf([entry("blank", "blank.unit.ts", { targets: [] })]),
      files: { "blank.unit.ts": "//" },
    });

    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["blank"]);
    assert.deepEqual(inventory.specs[0].targets, []);
    assert.equal(inventory.incomplete, false);
  });
});

describe("a duplicated id", () => {
  it("keeps the first entry, drops the later one, and says so", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("calc", "first.unit.ts"),
        entry("calc", "second.unit.ts", { targets: [ZONE] }),
      ]),
      files: { "first.unit.ts": "//", "second.unit.ts": "//" },
    });

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(ids(inventory), ["calc"]);
    // Identity that is not unique is not identity: last-wins would make the
    // inventory depend on the order two manifest edits happened to merge in.
    assert.equal(inventory.specs[0].ref.path, "first.unit.ts");
    assert.equal(inventory.incomplete, true);
    assert.match(messages(inventory, "warning")[0], /`calc`/);
  });
});

describe("a path that leaves the tests root", () => {
  it("drops an entry escaping via `..`", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("escapee", "../outside.unit.ts"),
        entry("inside", "inside.unit.ts"),
      ]),
      files: { "inside.unit.ts": "//" },
    });
    // A real file at the escaped location, so the drop cannot be an accident
    // of the existence check downstream.
    await writeFile(path.join(root, "..", "outside.unit.ts"), "//");

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(ids(inventory), ["inside"]);
    assert.equal(inventory.incomplete, true);
    assert.match(messages(inventory, "warning")[0], /`escapee`/);
    assert.match(messages(inventory, "warning")[0], /outside the tests root/);
  });

  it("drops an absolute path", async () => {
    const root = await makeRoot({
      manifest: manifestOf([entry("abs", path.join(os.tmpdir(), "x.unit.ts"))]),
    });

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(inventory.specs, []);
    assert.match(messages(inventory, "warning")[0], /absolute/);
  });

  it("keeps a `..` that stays inside the root", async () => {
    const root = await makeRoot({
      manifest: manifestOf([entry("winding", "ui/../a/b.unit.ts")]),
      files: { "a/b.unit.ts": "//" },
    });

    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["winding"]);
    // The declared string is what a reviewer greps for and what the diff
    // showed them, so it travels verbatim rather than normalised.
    assert.equal(inventory.specs[0].ref.path, "ui/../a/b.unit.ts");
  });

  // Delegated decision 2026-09-25: containment is checked on the resolved
  // path too, so a link inside the root cannot register a file outside it.
  it("drops an entry whose file is a symlink to outside the root", async (t) => {
    if (process.platform === "win32") return t.skip("symlinks need privilege");
    const outside = await mkdtemp(path.join(os.tmpdir(), "tessera-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.unit.ts"), "//");
    const root = await makeRoot({
      manifest: manifestOf([
        entry("linked", "linked.unit.ts"),
        entry("inside", "inside.unit.ts"),
      ]),
      files: { "inside.unit.ts": "//" },
    });
    await symlink(
      path.join(outside, "secret.unit.ts"),
      path.join(root, "linked.unit.ts"),
    );

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(ids(inventory), ["inside"]);
    assert.equal(inventory.incomplete, true);
    const warning = messages(inventory, "warning").find((m) =>
      m.includes("`linked`"),
    );
    assert.ok(warning, messages(inventory).join("\n"));
    assert.match(warning, /symbolic link to a file outside the tests root/);
  });

  it("drops an entry reached through a symlinked directory that leaves the root", async (t) => {
    if (process.platform === "win32") return t.skip("symlinks need privilege");
    const outside = await mkdtemp(path.join(os.tmpdir(), "tessera-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "x.unit.ts"), "//");
    const root = await makeRoot({
      manifest: manifestOf([entry("via-dir", "ext/x.unit.ts")]),
    });
    await symlink(outside, path.join(root, "ext"));

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(inventory.specs, []);
    assert.equal(inventory.incomplete, true);
  });

  it("keeps an entry whose symlink stays inside the root", async (t) => {
    if (process.platform === "win32") return t.skip("symlinks need privilege");
    const root = await makeRoot({
      manifest: manifestOf([entry("aliased", "alias/a.unit.ts")]),
      files: { "real/a.unit.ts": "//" },
    });
    await symlink(path.join(root, "real"), path.join(root, "alias"));

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(ids(inventory), ["aliased"]);
  });
});

describe("a registered file that is not there", () => {
  it("drops the entry with a warning, because rot is not intent", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("here", "here.unit.ts"),
        entry("gone", "sys_script/Old/gone.unit.ts"),
      ]),
      files: { "here.unit.ts": "//" },
    });

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(ids(inventory), ["here"]);
    assert.equal(inventory.incomplete, true);
    const [warning] = messages(inventory, "warning");
    assert.match(warning, /`gone`/);
    assert.match(warning, /no file at "sys_script\/Old\/gone\.unit\.ts"/);
  });

  it("does not call a directory a spec file", async () => {
    const root = await makeRoot({
      manifest: manifestOf([entry("dir", "a.unit.ts")]),
    });
    await mkdir(path.join(root, "a.unit.ts"));

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(inventory.specs, []);
    assert.match(messages(inventory, "warning")[0], /not a regular file/);
  });

  it(
    "says unreadable rather than absent when the stat itself fails",
    { skip: asRoot ? "chmod 000 does not bind uid 0" : false },
    async () => {
      const root = await makeRoot({
        manifest: manifestOf([entry("locked", "locked/a.unit.ts")]),
        files: { "locked/a.unit.ts": "//" },
      });
      const locked = path.join(root, "locked");
      await chmod(locked, 0o000);
      try {
        const inventory = await readSpecInventory({ root });

        assert.deepEqual(inventory.specs, []);
        const [warning] = messages(inventory, "warning").filter((message) =>
          /`locked`/.test(message),
        );
        // Unreadable is not absent. A note that conflates the two sends
        // somebody to write a spec that is already sitting in the repo.
        assert.match(warning, /could not be read/);
        assert.doesNotMatch(warning, /no file at/);
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );
});

describe("a spec-looking file the manifest does not mention", () => {
  it("is reported by name and count, and never turned into a spec", async () => {
    const root = await makeRoot({
      manifest: manifestOf([entry("known", "known.unit.ts")]),
      files: {
        "known.unit.ts": "//",
        "sys_script/Alpha/alpha.unit.ts": "//",
        "ui/checkout.spec.ts": "//",
        "sys_script/Alpha/alpha.e2e.atf.yaml": "//",
        "README.md": "not a spec",
        "sys_script/Alpha/alpha.ts": "a helper, not a spec",
      },
    });

    const inventory = await readSpecInventory({ root });

    // QA-16: the file has no declared targets and the path is not allowed to
    // supply them, so it is listed for a human — never joined.
    assert.deepEqual(ids(inventory), ["known"]);
    assert.equal(inventory.incomplete, true);
    const [warning] = messages(inventory, "warning");
    assert.match(warning, /^3 spec-looking file\(s\)/);
    assert.match(warning, /sys_script\/Alpha\/alpha\.e2e\.atf\.yaml/);
    assert.match(warning, /sys_script\/Alpha\/alpha\.unit\.ts/);
    assert.match(warning, /ui\/checkout\.spec\.ts/);
    assert.doesNotMatch(warning, /README\.md/);
  });

  it("ignores dot-entries and node_modules", async () => {
    const root = await makeRoot({
      manifest: manifestOf([]),
      files: {
        ".cache/tmp.unit.ts": "//",
        "node_modules/pkg/index.spec.ts": "//",
        ".hidden.unit.ts": "//",
      },
    });

    const inventory = await readSpecInventory({ root });
    assert.deepEqual(messages(inventory, "warning"), []);
    assert.equal(inventory.incomplete, false);
  });

  it("caps the list and keeps the tail count honest", async () => {
    const files = { "known.unit.ts": "//" };
    for (let index = 0; index < 13; index += 1) {
      files[`stray-${String(index).padStart(2, "0")}.unit.ts`] = "//";
    }
    const root = await makeRoot({
      manifest: manifestOf([entry("known", "known.unit.ts")]),
      files,
    });

    const [warning] = messages(await readSpecInventory({ root }), "warning");

    assert.match(warning, /^13 spec-looking file\(s\)/);
    assert.match(warning, /and 3 more/);
    assert.match(warning, /stray-00\.unit\.ts/);
    assert.doesNotMatch(warning, /stray-12\.unit\.ts/);
  });

  it("does not double-report a file a dropped entry already named", async () => {
    const root = await makeRoot({
      manifest: manifestOf([entry("rotten", "rotten.unit.ts", { kind: "x" })]),
      files: { "rotten.unit.ts": "//" },
    });

    const warned = messages(await readSpecInventory({ root }), "warning");

    // The entry warning already names the file precisely; a second accusation
    // sends the reader hunting for two problems where there is one.
    assert.equal(warned.length, 1);
    assert.match(warned[0], /`rotten`/);
    assert.doesNotMatch(warned[0], /spec-looking/);
  });

  it(
    "warns when a directory refuses to list, instead of a shorter list",
    { skip: asRoot ? "chmod 000 does not bind uid 0" : false },
    async () => {
      const root = await makeRoot({
        manifest: manifestOf([]),
        files: { "sealed/hidden.unit.ts": "//" },
      });
      const sealed = path.join(root, "sealed");
      await chmod(sealed, 0o000);
      try {
        const inventory = await readSpecInventory({ root });

        assert.equal(inventory.incomplete, true);
        const warned = messages(inventory, "warning");
        assert.ok(
          warned.some((message) => /could not be listed/.test(message)),
        );
        assert.ok(warned.some((message) => /sealed/.test(message)));
      } finally {
        await chmod(sealed, 0o755);
      }
    },
  );

  it(
    "states the floor it qualifies, even when that floor is zero",
    { skip: asRoot ? "chmod 000 does not bind uid 0" : false },
    async () => {
      // The unregistered-file warning is only emitted when the count is above
      // zero, so a note that qualifies "the count above" qualifies nothing at
      // all in exactly the case where the reader is most likely to conclude
      // that everything on disk is accounted for.
      const root = await makeRoot({
        manifest: manifestOf([]),
        files: { "sealed/hidden.unit.ts": "//" },
      });
      const sealed = path.join(root, "sealed");
      await chmod(sealed, 0o000);
      try {
        const inventory = await readSpecInventory({ root });

        const [warning] = messages(inventory, "warning").filter((message) =>
          /could not be listed/.test(message),
        );
        assert.deepEqual(
          messages(inventory, "warning").filter((message) =>
            /spec-looking file\(s\) under the tests root are not registered/.test(
              message,
            ),
          ),
          [],
          "no unregistered-file note is emitted here, so the floor note must carry the count itself",
        );
        assert.match(warning, /\(0\)/);
      } finally {
        await chmod(sealed, 0o755);
      }
    },
  );
});

describe("`incomplete`", () => {
  it("is true exactly when a warning was recorded", async () => {
    const clean = await readSpecInventory({
      root: await makeRoot({
        manifest: manifestOf([entry("a", "a.unit.ts")]),
        files: { "a.unit.ts": "//" },
      }),
    });
    const infoOnly = await readSpecInventory({
      root: await makeRoot({ manifest: manifestOf([]) }),
    });
    const warned = await readSpecInventory({
      root: await makeRoot({ manifest: manifestOf([entry("a", "a.unit.ts")]) }),
    });

    assert.equal(clean.incomplete, false);
    // An `info` note is a statement, not a defect — it must not flip the flag.
    assert.equal(infoOnly.incomplete, false);
    assert.deepEqual(messages(infoOnly, "warning"), []);
    assert.equal(warned.incomplete, true);

    for (const inventory of [clean, infoOnly, warned]) {
      assert.equal(
        inventory.incomplete,
        inventory.notes.some((note) => note.level === "warning"),
      );
    }
  });
});
