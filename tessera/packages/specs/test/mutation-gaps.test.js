// Wave 14 mutation pass (2026-09-30): behaviour that surviving mutants showed
// no test pinned. The one-file-two-ids dedupe is driven through
// `readSpecInventoryWithSeams` — an internal seam imported from
// `build/inventory.js` by path, NOT part of the package API — because on APFS
// `realpath` canonicalises case and Unicode normalisation, which made the
// case fold and the lexical key unobservable on a macOS machine.

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
  SPEC_MANIFEST_MAX_BYTES,
  SpecStoreFaultError,
  readSpecInventory,
} from "../build/index.js";
import { readSpecInventoryWithSeams } from "../build/inventory.js";

const roots = [];

after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeRoot({ manifest, files = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tessera-specs-m-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  if (manifest !== undefined) {
    await writeFile(
      path.join(root, ".manifest.json"),
      JSON.stringify(manifest),
    );
  }
  return root;
}

const TARGET = {
  table: "sys_script_include",
  sysId: "ca1c".padEnd(32, "0"),
  name: "AmountCalculator",
};

function entry(id, file, kind = "unit") {
  return { id, path: file, kind, targets: [TARGET] };
}

function manifestOf(specs) {
  return { version: 1, specs };
}

function messages(inventory, level) {
  return inventory.notes
    .filter((note) => level === undefined || note.level === level)
    .map((note) => note.message);
}

function ids(inventory) {
  return inventory.specs.map((spec) => spec.ref.id);
}

/**
 * A `realpath` that does not canonicalise — what ext4 does — with optional
 * per-basename redirects standing in for symlinks. Only paths under `root`
 * are redirected; the root itself resolves to itself.
 */
function fakeRealpath(root, redirects = {}) {
  return async (target) => {
    const name = path.relative(root, target);
    return Object.hasOwn(redirects, name)
      ? path.join(root, redirects[name])
      : target;
  };
}

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("one file under two ids, on a filesystem that does not canonicalise", () => {
  it("drops a case alias whose real paths differ (lexical key, folded)", async () => {
    // `A.unit.ts` and `a.unit.ts` are links to two different files: two real
    // files on ext4, ONE path once the repo is checked out on macOS. Neither
    // real path matches either key of the other entry, so only the folded
    // lexical key can catch it.
    const root = await makeRoot({
      manifest: manifestOf([
        entry("a1", "A.unit.ts"),
        entry("a2", "a.unit.ts"),
      ]),
      files: { "A.unit.ts": "//", "a.unit.ts": "//" },
    });
    const inventory = await readSpecInventoryWithSeams(
      { root },
      {
        realpath: fakeRealpath(root, {
          "A.unit.ts": "z.unit.ts",
          "a.unit.ts": "y.unit.ts",
        }),
      },
    );
    assert.deepEqual(ids(inventory), ["a1"]);
    const warned = messages(inventory, "warning").filter((message) =>
      message.includes("same file"),
    );
    assert.equal(warned.length, 1);
    assert.match(warned[0], /`a2`.*`a1`/);
  });

  it("drops an alias whose real paths differ only in case (real key, folded)", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("plain", "a.unit.ts"),
        entry("link", "link.unit.ts"),
      ]),
      files: { "a.unit.ts": "//", "link.unit.ts": "//" },
    });
    const inventory = await readSpecInventoryWithSeams(
      { root },
      { realpath: fakeRealpath(root, { "link.unit.ts": "A.unit.ts" }) },
    );
    assert.deepEqual(ids(inventory), ["plain"]);
    assert.match(
      messages(inventory, "warning").join("\n"),
      /`link`.*same file/,
    );
  });

  it("drops an NFD spelling of an NFC-registered path", async () => {
    const nfc = "café.unit.ts";
    const nfd = "café.unit.ts";
    const root = await makeRoot({
      manifest: manifestOf([entry("nfc", nfc), entry("nfd", nfd)]),
      files: { [nfc]: "//" },
    });
    // On a normalisation-sensitive filesystem the NFD name is its own file.
    await writeFile(path.join(root, nfd), "//");
    const inventory = await readSpecInventoryWithSeams(
      { root },
      { realpath: fakeRealpath(root) },
    );
    assert.deepEqual(ids(inventory), ["nfc"]);
    assert.match(messages(inventory, "warning").join("\n"), /`nfd`.*same file/);
  });

  it("the production entry point uses the real realpath", async () => {
    const root = await makeRoot({
      manifest: manifestOf([entry("a", "a.unit.ts")]),
      files: { "a.unit.ts": "//" },
    });
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["a"]);
    assert.equal(inventory.incomplete, false);
  });
});

describe("containment edges", () => {
  it("calls a path that resolves to the root itself outside, not a bad suffix", async () => {
    const root = await makeRoot({ manifest: manifestOf([entry("dot", ".")]) });
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(inventory.specs, []);
    const [warning] = messages(inventory, "warning");
    assert.match(warning, /`dot`.*resolves outside the tests root/);
  });

  it("refuses a lexical `..` escape by the lexical rule, not the link rule", async () => {
    const root = await makeRoot({
      manifest: manifestOf([entry("escapee", "../w14-outside.unit.ts")]),
    });
    await writeFile(path.join(root, "..", "w14-outside.unit.ts"), "//");
    try {
      const inventory = await readSpecInventory({ root });
      const [warning] = messages(inventory, "warning");
      assert.match(warning, /resolves outside the tests root/);
      assert.doesNotMatch(warning, /symbolic link/);
    } finally {
      await rm(path.join(root, "..", "w14-outside.unit.ts"), { force: true });
    }
  });

  it("keeps a file whose name merely starts with `..`", async () => {
    const root = await makeRoot({
      manifest: manifestOf([entry("dots", "..config.unit.ts")]),
      files: { "..config.unit.ts": "//" },
    });
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["dots"]);
    assert.equal(inventory.incomplete, false);
  });
});

describe("the unregistered-file sweep", () => {
  it("does not count a symlink with a spec suffix (links are not followed)", async (t) => {
    const root = await makeRoot({
      manifest: manifestOf([entry("real", "real.unit.ts")]),
      files: { "real.unit.ts": "//" },
    });
    try {
      await symlink("real.unit.ts", path.join(root, "alias.unit.ts"));
    } catch {
      t.skip("symlinks unavailable");
      return;
    }
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(messages(inventory, "warning"), []);
    assert.equal(inventory.incomplete, false);
  });

  it(
    "names the root itself as `.` when the root will not list",
    {
      skip: asRoot ? "chmod does not bind uid 0" : false,
    },
    async () => {
      const root = await makeRoot({ manifest: manifestOf([]) });
      // Search but no read: the manifest still opens, `readdir` is refused.
      await chmod(root, 0o300);
      try {
        const inventory = await readSpecInventory({ root });
        const floor = messages(inventory, "warning").find((message) =>
          message.includes("could not be listed"),
        );
        assert.ok(floor, "expected an unlistable-directory warning");
        assert.match(floor, /: \. \(/);
      } finally {
        await chmod(root, 0o755);
      }
    },
  );

  it("lists exactly the cap without a zero tail", async () => {
    const files = {};
    for (let i = 0; i < 10; i += 1) files[`s${i}.unit.ts`] = "//";
    const root = await makeRoot({ manifest: manifestOf([]), files });
    const inventory = await readSpecInventory({ root });
    const [warning] = messages(inventory, "warning");
    assert.match(warning, /^10 /);
    assert.doesNotMatch(warning, /and 0 more/);
  });

  // A depth-first walk visits directory `a` (and so `a/x.unit.ts`) before
  // `a-b.unit.ts` and `a.unit.ts`, whatever order a directory lists in; the
  // full relative paths sort `-` < `.` < `/`, so walk order is never sorted
  // order here. Mixed case pins code-unit order over locale order.
  const SWEEP_NAMES = [
    "a.unit.ts",
    "a/x.unit.ts",
    "a-b.unit.ts",
    "Zeta.unit.ts",
    "alpha.unit.ts",
  ];
  const SWEEP_SORTED = [
    "Zeta.unit.ts",
    "a-b.unit.ts",
    "a.unit.ts",
    path.join("a", "x.unit.ts"),
    "alpha.unit.ts",
  ];
  const tail = (message) =>
    message.slice(message.lastIndexOf(": ") + 2).split(", ");

  it("lists unregistered names in code-unit order, not walk or locale order", async () => {
    const root = await makeRoot({
      manifest: manifestOf([]),
      files: Object.fromEntries(SWEEP_NAMES.map((name) => [name, "//"])),
    });
    const inventory = await readSpecInventory({ root });
    const [warning] = messages(inventory, "warning");
    assert.deepEqual(tail(warning), SWEEP_SORTED);
  });

  it("lists proposed/ names in code-unit order too", async () => {
    const root = await makeRoot({
      manifest: manifestOf([]),
      files: Object.fromEntries(
        SWEEP_NAMES.map((name) => [path.join("proposed", name), "//"]),
      ),
    });
    const inventory = await readSpecInventory({ root });
    const info = messages(inventory, "info").find((message) =>
      message.includes("awaiting review"),
    );
    assert.deepEqual(
      tail(info),
      SWEEP_SORTED.map((name) => path.join("proposed", name)),
    );
  });

  it(
    "lists unlistable directories in code-unit order",
    {
      skip: asRoot ? "chmod does not bind uid 0" : false,
    },
    async () => {
      const root = await makeRoot({
        manifest: manifestOf([]),
        files: { "a/x/k.unit.ts": "//", "a-b/k.unit.ts": "//" },
      });
      const sealed = [path.join(root, "a", "x"), path.join(root, "a-b")];
      for (const dir of sealed) await chmod(dir, 0o000);
      try {
        const inventory = await readSpecInventory({ root });
        const floor = messages(inventory, "warning").find((message) =>
          message.includes("could not be listed"),
        );
        const named = floor
          .slice(floor.indexOf("answer: ") + "answer: ".length)
          .split(/ \([^)]*\)(?:, )?/)
          .filter(Boolean);
        assert.deepEqual(named, ["a-b", path.join("a", "x")]);
      } finally {
        for (const dir of sealed) await chmod(dir, 0o755);
      }
    },
  );
});

describe("note settlement", () => {
  it("orders by level first, then by message", async () => {
    // The warning's message ("1 spec-looking…") sorts before the info's
    // ("2 generated…"), so a message-only order would put it first.
    const root = await makeRoot({
      manifest: manifestOf([]),
      files: {
        "loose.unit.ts": "//",
        "proposed/g1.unit.ts": "//",
        "proposed/g2.unit.ts": "//",
      },
    });
    const inventory = await readSpecInventory({ root });
    const levels = inventory.notes.map((note) => note.level);
    assert.deepEqual(levels, ["info", "info", "warning"]);
    assert.match(inventory.notes[2].message, /^1 spec-looking/);
  });

  it("orders warnings by message, not by generation order", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("b", "gone-b.unit.ts"),
        entry("a", "gone-a.unit.ts"),
      ]),
    });
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(
      messages(inventory, "warning").map(
        (message) => /`(\w)`/.exec(message)[1],
      ),
      ["a", "b"],
    );
  });

  it("reports an identical note once", async () => {
    const twin = { id: "twin", path: "t.unit.ts", kind: 7, targets: [] };
    const root = await makeRoot({ manifest: manifestOf([twin, twin]) });
    const inventory = await readSpecInventory({ root });
    assert.equal(messages(inventory, "warning").length, 1);
  });
});

/**
 * A manifest handle whose `stat` under-reports — a file that grew after it was
 * measured — serving `total` bytes of a padded, valid, empty manifest in reads
 * of at most `chunk` bytes, as a pipe would.
 */
function growingManifest(total, chunk) {
  const head = Buffer.from(JSON.stringify(manifestOf([])));
  let closed = false;
  return {
    handle: {
      stat: async () => ({ size: 0 }),
      read: async (buffer, offset, length, position) => {
        const n = Math.max(0, Math.min(length, chunk, total - position));
        for (let i = 0; i < n; i += 1) {
          const at = position + i;
          buffer[offset + i] = at < head.length ? head[at] : 0x20;
        }
        return { bytesRead: n };
      },
      close: async () => {
        closed = true;
      },
    },
    closed: () => closed,
  };
}

describe("the bounded manifest read", () => {
  it("catches a manifest that grew past the cap after `stat`", async () => {
    const root = await makeRoot({ manifest: manifestOf([]) });
    // Chunks that land exactly on the cap: the read must still ask for the
    // one byte past it rather than stop at the cap and parse a truncation.
    const source = growingManifest(SPEC_MANIFEST_MAX_BYTES + 4096, 1024 * 1024);
    await assert.rejects(
      readSpecInventoryWithSeams(
        { root },
        { openManifest: async () => source.handle },
      ),
      (error) =>
        error instanceof SpecStoreFaultError &&
        error.message.includes(
          `is more than ${SPEC_MANIFEST_MAX_BYTES} bytes, which exceeds`,
        ),
    );
    assert.equal(source.closed(), true);
  });

  it("reads a short-read source of exactly the cap in full", async () => {
    const root = await makeRoot({ manifest: manifestOf([]) });
    const source = growingManifest(SPEC_MANIFEST_MAX_BYTES, 1000003);
    const inventory = await readSpecInventoryWithSeams(
      { root },
      { openManifest: async () => source.handle },
    );
    assert.deepEqual(inventory.specs, []);
    assert.equal(source.closed(), true);
  });

  it("refuses a manifest that reports size 0 and reads on past the cap", async (t) => {
    // A character device: `fstat` says 0 bytes, so only the bounded read can
    // catch it — the same path a file growing after `stat` takes.
    if (process.platform === "win32") return t.skip("no /dev/zero");
    const root = await makeRoot();
    try {
      await symlink("/dev/zero", path.join(root, ".manifest.json"));
    } catch {
      return t.skip("symlinks unavailable");
    }
    await assert.rejects(
      readSpecInventory({ root }),
      (error) =>
        error instanceof SpecStoreFaultError &&
        error.message.includes(
          `is more than ${SPEC_MANIFEST_MAX_BYTES} bytes, which exceeds`,
        ),
    );
  });
});
