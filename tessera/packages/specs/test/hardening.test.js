// Review findings M2 and L4 (2026-09-26), pinned.
//
// M2: the unregistered-file sweep walked `<root>/proposed/` — the directory
// `tess generate` writes into — so the first generated spec turned every
// inventory incomplete, `coverage` exited 5 and a live run went INCONCLUSIVE.
//
// L4: `validateEntry` accepted any path under any kind and never compared paths
// across ids, so `A.unit.ts` + `a.unit.ts` (one file on APFS), a second id on
// the same path and `.manifest.json` registered as a unit spec all read back
// as a complete inventory. The manifest read was also unbounded.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  access,
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
  KIND_SPEC_SUFFIXES,
  PROPOSED_SPECS_DIRNAME,
  SPEC_FILE_SUFFIXES,
  SPEC_MANIFEST_MAX_BYTES,
  SpecStoreFaultError,
  readSpecInventory,
} from "../build/index.js";

const roots = [];

after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeRoot({ manifest, files = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tessera-specs-h-"));
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

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("M2: the generator's proposed/ directory", () => {
  it("is named as `tess generate` names it", () => {
    // Mirrors PROPOSED_DIRNAME in @tessera/generate's writer.ts.
    assert.equal(PROPOSED_SPECS_DIRNAME, "proposed");
  });

  it("does not make the inventory incomplete, and is reported as info", async () => {
    const root = await makeRoot({
      manifest: manifestOf([entry("known", "known.unit.ts")]),
      files: {
        "known.unit.ts": "//",
        "proposed/Gen.unit.ts": "//",
        "proposed/sub/Flow.spec.ts": "//",
        "proposed/notes.md": "not a spec",
      },
    });

    const inventory = await readSpecInventory({ root });

    assert.deepEqual(ids(inventory), ["known"]);
    assert.equal(inventory.incomplete, false);
    assert.deepEqual(messages(inventory, "warning"), []);
    const infos = messages(inventory, "info").filter((message) =>
      /proposed\//.test(message),
    );
    assert.equal(infos.length, 1);
    assert.match(infos[0], /^2 /);
  });

  it("says nothing when proposed/ holds no spec-looking file", async () => {
    const root = await makeRoot({
      manifest: manifestOf([]),
      files: { "proposed/readme.md": "x" },
    });
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(
      messages(inventory).filter((message) => /proposed\//.test(message)),
      [],
    );
    assert.equal(inventory.incomplete, false);
  });

  it("is exempt only at the tests root — a nested proposed/ is still swept", async () => {
    const root = await makeRoot({
      manifest: manifestOf([]),
      files: { "sys_script/proposed/x.unit.ts": "//" },
    });
    const inventory = await readSpecInventory({ root });
    assert.equal(inventory.incomplete, true);
    assert.match(
      messages(inventory, "warning")[0],
      /sys_script\/proposed\/x\.unit\.ts/,
    );
  });

  it("does not exempt a symlink named proposed pointing at live specs", async (t) => {
    const root = await makeRoot({
      manifest: manifestOf([]),
      files: { "live/x.unit.ts": "//" },
    });
    try {
      await symlink(path.join(root, "live"), path.join(root, "proposed"));
    } catch {
      t.skip("symlinks unavailable");
      return;
    }
    const inventory = await readSpecInventory({ root });
    // live/x.unit.ts is still found through its real directory.
    assert.equal(inventory.incomplete, true);
    assert.match(messages(inventory, "warning")[0], /live\/x\.unit\.ts/);
  });

  it(
    "an unlistable proposed/ is an info note, not a warning",
    { skip: asRoot ? "chmod 000 does not bind uid 0" : false },
    async () => {
      const root = await makeRoot({
        manifest: manifestOf([]),
        files: { "proposed/x.unit.ts": "//" },
      });
      const dir = path.join(root, "proposed");
      await chmod(dir, 0o000);
      try {
        const inventory = await readSpecInventory({ root });
        assert.equal(inventory.incomplete, false);
        assert.ok(
          messages(inventory, "info").some((message) =>
            /proposed\/.*could not be listed/.test(message),
          ),
        );
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );
});

describe("L4: the path suffix must match the kind", () => {
  it("covers every sweep suffix and nothing else", () => {
    assert.deepEqual(Object.keys(KIND_SPEC_SUFFIXES).sort(), [
      "e2e",
      "ui",
      "unit",
    ]);
    assert.deepEqual(
      Object.values(KIND_SPEC_SUFFIXES).flat().sort(),
      [...SPEC_FILE_SUFFIXES].sort(),
    );
  });

  it("accepts each kind with each of its suffixes", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("u", "a.unit.ts", "unit"),
        entry("e1", "b.e2e.atf.yaml", "e2e"),
        entry("e2", "c.e2e.atf.yml", "e2e"),
        entry("w", "d.spec.ts", "ui"),
      ]),
      files: {
        "a.unit.ts": "//",
        "b.e2e.atf.yaml": "//",
        "c.e2e.atf.yml": "//",
        "d.spec.ts": "//",
      },
    });
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["e1", "e2", "u", "w"]);
    assert.equal(inventory.incomplete, false);
  });

  for (const [label, file, kind] of [
    ["the manifest itself as a unit spec", ".manifest.json", "unit"],
    ["a file with no spec suffix", "helper.ts", "unit"],
    ["a ui file registered as unit", "flow.spec.ts", "unit"],
    ["a unit file registered as e2e", "calc.unit.ts", "e2e"],
    ["a suffix in the wrong case", "calc.UNIT.TS", "unit"],
  ]) {
    it(`refuses ${label}`, async () => {
      const root = await makeRoot({
        manifest: manifestOf([
          entry("bad", file, kind),
          entry("ok", "ok.unit.ts"),
        ]),
        files: { [file]: "//", "ok.unit.ts": "//" },
      });
      const inventory = await readSpecInventory({ root });
      assert.deepEqual(ids(inventory), ["ok"]);
      assert.equal(inventory.incomplete, true);
      const warned = messages(inventory, "warning");
      // One accusation, naming the entry — not a second "unregistered" one.
      assert.equal(warned.length, 1);
      assert.match(warned[0], /`bad`/);
      assert.match(warned[0], /suffix/);
    });
  }
});

describe("L4: one file registered twice", () => {
  it("drops a second id on the same path", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("a1", "a.unit.ts"),
        entry("a2", "a.unit.ts"),
      ]),
      files: { "a.unit.ts": "//" },
    });
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["a1"]);
    assert.equal(inventory.incomplete, true);
    const [warning] = messages(inventory, "warning");
    assert.match(warning, /`a2`/);
    assert.match(warning, /`a1`/);
  });

  it("drops a lexical alias (./a.unit.ts vs a.unit.ts)", async () => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("a1", "a.unit.ts"),
        entry("a2", "./sub/../a.unit.ts"),
      ]),
      files: { "a.unit.ts": "//" },
    });
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["a1"]);
    assert.equal(inventory.incomplete, true);
  });

  it("drops a case alias (A.unit.ts vs a.unit.ts), on any filesystem", async () => {
    const root = await makeRoot({ files: { "A.unit.ts": "//" } });
    let caseInsensitive = true;
    try {
      await access(path.join(root, "a.unit.ts"));
    } catch {
      caseInsensitive = false;
    }
    if (!caseInsensitive) await writeFile(path.join(root, "a.unit.ts"), "//");
    await writeFile(
      path.join(root, ".manifest.json"),
      JSON.stringify(
        manifestOf([entry("a1", "A.unit.ts"), entry("a2", "a.unit.ts")]),
      ),
    );
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["a1"]);
    assert.equal(inventory.incomplete, true);
    assert.match(messages(inventory, "warning")[0], /`a2`/);
  });

  it("drops a symlink alias that stays inside the root", async (t) => {
    const root = await makeRoot({
      manifest: manifestOf([
        entry("real", "real.unit.ts"),
        entry("link", "link.unit.ts"),
      ]),
      files: { "real.unit.ts": "//" },
    });
    try {
      await symlink("real.unit.ts", path.join(root, "link.unit.ts"));
    } catch {
      t.skip("symlinks unavailable");
      return;
    }
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["real"]);
    assert.equal(inventory.incomplete, true);
    assert.match(messages(inventory, "warning")[0], /`link`/);
  });

  it("the repro manifest is no longer complete", async () => {
    const root = await makeRoot({ files: { "A.unit.ts": "//" } });
    await writeFile(
      path.join(root, ".manifest.json"),
      JSON.stringify(
        manifestOf([
          entry("a1", "A.unit.ts"),
          entry("a2", "a.unit.ts"),
          entry("m", ".manifest.json"),
          { id: "p", path: "A.unit.ts", kind: "unit", targets: [] },
        ]),
      ),
    );
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(ids(inventory), ["a1"]);
    assert.equal(inventory.incomplete, true);
  });
});

describe("L4 INFO: the manifest read is bounded", () => {
  it("is generous", () => {
    assert.ok(SPEC_MANIFEST_MAX_BYTES >= 1024 * 1024);
  });

  it("reads a manifest of exactly the cap", async () => {
    const body = JSON.stringify(manifestOf([]));
    const root = await makeRoot({
      manifest: body + " ".repeat(SPEC_MANIFEST_MAX_BYTES - body.length),
    });
    const inventory = await readSpecInventory({ root });
    assert.deepEqual(inventory.specs, []);
  });

  it("refuses a manifest one byte over the cap, as a store fault", async () => {
    const body = JSON.stringify(manifestOf([]));
    const root = await makeRoot({
      manifest: body + " ".repeat(SPEC_MANIFEST_MAX_BYTES - body.length + 1),
    });
    await assert.rejects(
      readSpecInventory({ root }),
      (error) =>
        error instanceof SpecStoreFaultError &&
        /exceeds/.test(error.message) &&
        // The size is judged on the handle before any read: the exact byte
        // count is only known from `stat`, not from the bounded read.
        error.message.includes(`is ${SPEC_MANIFEST_MAX_BYTES + 1} bytes`),
    );
  });
});
