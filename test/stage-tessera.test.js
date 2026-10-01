import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-001 Option B (delegated decision 2026-09-23): the Tessera release closure
// is staged into build/tessera at pack time. These tests drive the staging
// script against a synthetic workspace, never the real tessera/ tree.
//
// Delegated decision 2026-09-26 (W6b review): the script only stages under
// `<root>/build/`, where `<root>` is the directory above the script. So each
// test copies the script (and the real `tess`/`tessera-mcp` launchers it
// verifies against) into a throwaway root, and stages there.
const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_SRC = join(REPO, "scripts", "stage-tessera.mjs");
const MARKER = ".stage-tessera.json";

/** The in-tree staging marker of `out` (parsed), if any. */
function markerFor(out) {
  const path = join(out, MARKER);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The wave-13 out-of-tree marker store under a fixture root. */
function cacheDir(root) {
  return join(root, "node_modules", ".cache", "stage-tessera");
}

/** Every path under `dir` (recursive, relative), for leak assertions. */
function walk(dir) {
  return readdirSync(dir, { recursive: true }).map(String);
}

/** Write one synthetic @tessera/<short> workspace package. */
function writePackage(root, short, manifest, { built = true } = {}) {
  const dir = join(root, "packages", short);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `@tessera/${short}`,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: { build: "tsc" },
      ...manifest,
    }),
  );
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  if (built) {
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(join(dir, "build", "index.js"), "export {};\n");
    writeFileSync(join(dir, "build", "index.js.map"), "{}");
  }
  for (const rel of Object.values(manifest.bin ?? {})) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, rel), "#!/usr/bin/env node\n");
  }
}

/**
 * A throwaway package root shaped like this repo: scripts/stage-tessera.mjs, a
 * package.json declaring the four real bins, the real bin/ launchers, and a
 * tessera/ workspace with two entries, a shared dep and two excluded extras.
 */
function fixtureRoot({ bins } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "snpf-stage-")));
  mkdirSync(join(root, "scripts"));
  copyFileSync(SCRIPT_SRC, join(root, "scripts", "stage-tessera.mjs"));
  mkdirSync(join(root, "bin"));
  for (const file of [
    "servicenow-preflight.cjs",
    "tess.cjs",
    "tessera-mcp.cjs",
    "tessera-launcher.cjs",
  ]) {
    copyFileSync(join(REPO, "bin", file), join(root, "bin", file));
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "0.0.0",
      bin: bins ?? {
        "servicenow-preflight": "./bin/servicenow-preflight.cjs",
        tess: "./bin/tess.cjs",
        "tessera-mcp": "./bin/tessera-mcp.cjs",
      },
    }),
  );
  const ws = join(root, "tessera");
  writePackage(ws, "types", {});
  writePackage(ws, "core", { dependencies: { "@tessera/types": "*" } });
  writePackage(ws, "cli", {
    bin: { tess: "bin/tess.mjs" },
    dependencies: { "@tessera/core": "*" },
    devDependencies: { "@tessera/fake-instance": "*" },
  });
  writePackage(ws, "mcp", {
    bin: { "tessera-mcp": "bin/tessera-mcp.mjs" },
    dependencies: { "@tessera/cli": "*" },
  });
  writePackage(ws, "fake-instance", {});
  writePackage(ws, "store", {});
  return { root, ws, out: join(root, "build", "tessera") };
}

function stage(root, args = []) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts", "stage-tessera.mjs"), ...args],
    { cwd: root, encoding: "utf8" },
  );
}

function withRoot(body, options) {
  const fx = fixtureRoot(options);
  try {
    body(fx);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

test("stage-tessera stages exactly the runtime closure of cli + mcp", () => {
  withRoot(({ root, out }) => {
    const res = stage(root);
    assert.equal(res.status, 0, res.stderr);
    const mods = join(out, "node_modules", "@tessera");
    for (const name of ["cli", "core", "mcp", "types"]) {
      assert.ok(existsSync(join(mods, name, "build", "index.js")), name);
    }
    // devDependencies and unreachable packages never ship.
    assert.equal(existsSync(join(mods, "fake-instance")), false);
    assert.equal(existsSync(join(mods, "store")), false);
    assert.ok(existsSync(join(mods, "cli", "bin", "tess.mjs")));
    assert.ok(existsSync(join(mods, "mcp", "bin", "tessera-mcp.mjs")));
    // Source maps point at an unshipped src/; sources themselves stay out.
    assert.equal(existsSync(join(mods, "cli", "build", "index.js.map")), false);
    assert.equal(existsSync(join(mods, "cli", "src")), false);
    const manifest = JSON.parse(
      readFileSync(join(mods, "cli", "package.json"), "utf8"),
    );
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.deepEqual(manifest.dependencies, { "@tessera/core": "*" });
    // The staging marker is what licenses a later re-stage to delete `out`.
    const marker = markerFor(out);
    assert.equal(marker?.stagedBy, "scripts/stage-tessera.mjs");
    assert.match(marker?.digest ?? "", /^[0-9a-f]{64}$/);
    assert.match(res.stderr, /verified bins: tess, tessera-mcp/);
  });
});

test("stage-tessera refuses when an excluded package enters the runtime closure", () => {
  withRoot(({ root, ws }) => {
    writePackage(ws, "core", {
      dependencies: { "@tessera/types": "*", "@tessera/store": "*" },
    });
    const res = stage(root);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /@tessera\/store is in the runtime closure/);
  });
});

test("stage-tessera refuses a third-party runtime dependency", () => {
  withRoot(({ root, ws }) => {
    writePackage(ws, "types", { dependencies: { zod: "^3" } });
    const res = stage(root);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /depends on "zod"/);
  });
});

test("stage-tessera refuses an unbuilt package in the closure", () => {
  withRoot(({ root, ws }) => {
    rmSync(join(ws, "packages", "types", "build"), {
      recursive: true,
      force: true,
    });
    const res = stage(root);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /@tessera\/types is not built/);
  });
});

// --- finding 1: a pack must never ship broken `tess` / `tessera-mcp` bins ---

test("stage-tessera fails (never a silent no-op) when the workspace is absent", () => {
  withRoot(({ root, ws, out }) => {
    rmSync(ws, { recursive: true, force: true });
    const res = stage(root);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /does not exist/);
    assert.equal(existsSync(out), false);
  });
});

test("stage-tessera no longer accepts --if-present (the prepack skip is gone)", () => {
  withRoot(({ root, ws }) => {
    rmSync(ws, { recursive: true, force: true });
    const res = stage(root, ["--if-present"]);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /unknown argument "--if-present"/);
  });
});

test("the prepack hook stages without --if-present", () => {
  const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.equal(manifest.scripts.prepack, "node scripts/stage-tessera.mjs");
});

test("stage-tessera refuses when a declared bin's entry package does not ship its bin", () => {
  withRoot(({ root, ws }) => {
    // @tessera/mcp exists and builds, but no longer declares `tessera-mcp`.
    writePackage(ws, "mcp", { dependencies: { "@tessera/cli": "*" } });
    const res = stage(root);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /tessera-mcp/);
    assert.match(res.stderr, /@tessera\/mcp/);
  });
});

test("stage-tessera refuses when a staged bin file is missing", () => {
  withRoot(({ root, ws }) => {
    // The manifest points at bin/tess.mjs, but the launcher wants another file.
    const launcher = join(root, "bin", "tess.cjs");
    writeFileSync(
      launcher,
      readFileSync(launcher, "utf8").replace('"tess.mjs"', '"tess-v2.mjs"'),
    );
    assert.ok(existsSync(join(ws, "packages", "cli", "bin", "tess.mjs")));
    const res = stage(root);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /tess-v2\.mjs/);
  });
});

test("stage-tessera refuses a tess/tessera-mcp bin that is not a Tessera launcher", () => {
  withRoot(({ root }) => {
    writeFileSync(join(root, "bin", "tess.cjs"), "#!/usr/bin/env node\n");
    const res = stage(root);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /"tess"/);
    assert.match(res.stderr, /launcher/);
  });
});

test("stage-tessera verifies nothing Tessera-shaped when no Tessera bin is declared", () => {
  withRoot(
    ({ root }) => {
      const res = stage(root);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /verified bins: \(none declared\)/);
    },
    { bins: { "servicenow-preflight": "./bin/servicenow-preflight.cjs" } },
  );
});

// --- finding 6: the recursive delete of --out is guarded -------------------

test("stage-tessera refuses an --out outside <root>/build/", () => {
  withRoot(({ root }) => {
    const victim = join(root, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "precious");
    // Never an ancestor of the fixture root here: a regressed guard would
    // delete it for real.
    for (const out of [
      victim,
      join(root, "build", "..", "victim"),
      join(root, "build"),
      root,
    ]) {
      const res = stage(root, ["--out", out]);
      assert.equal(res.status, 1, `${out}: ${res.stderr}`);
      assert.match(res.stderr, /--out/);
    }
    assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "precious");
    assert.ok(existsSync(join(root, "package.json")));
  });
});

test("stage-tessera refuses an --out that escapes build/ through a symlink", () => {
  withRoot(({ root }) => {
    const victim = join(root, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "precious");
    mkdirSync(join(root, "build"));
    symlinkSync(victim, join(root, "build", "link"), "dir");
    const res = stage(root, ["--out", join(root, "build", "link")]);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /--out/);
    assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "precious");
  });
});

test("stage-tessera refuses a non-empty --out without a staging marker", () => {
  withRoot(({ root, out }) => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "keep.txt"), "precious");
    const res = stage(root);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /marker/);
    assert.equal(readFileSync(join(out, "keep.txt"), "utf8"), "precious");
  });
});

test("stage-tessera re-stages over its own marked output", () => {
  withRoot(({ root, ws, out }) => {
    assert.equal(stage(root).status, 0);
    // The workspace moved on: the re-stage replaces the previous tree.
    writeFileSync(join(ws, "packages", "core", "build", "extra.js"), "1;\n");
    const res = stage(root);
    assert.equal(res.status, 0, res.stderr);
    const core = join(out, "node_modules", "@tessera", "core", "build");
    assert.ok(existsSync(join(core, "extra.js")));
    assert.ok(markerFor(out));
  });
});

test("stage-tessera accepts an empty or absent --out under build/", () => {
  withRoot(({ root }) => {
    const empty = join(root, "build", "empty");
    mkdirSync(empty, { recursive: true });
    assert.equal(stage(root, ["--out", empty]).status, 0);
    const fresh = join(root, "build", "nested", "fresh");
    const res = stage(root, ["--out", fresh]);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(markerFor(fresh));
  });
});

// --- wave 13 (TODO wave-11 residuals) ----------------------------------------
// Delegated decision 2026-09-28 (wave 13): the marker lives outside the packed
// tree, and a failed stage leaves --out exactly as it was found.

test("stage-tessera keeps its marker with the tree but out of the tarball", () => {
  withRoot(({ root, out }) => {
    const res = stage(root);
    assert.equal(res.status, 0, res.stderr);
    // The marker lives with the staged tree (it survives a node_modules wipe)
    // and nothing is written to the old out-of-tree store any more.
    assert.ok(markerFor(out));
    assert.equal(existsSync(cacheDir(root)), false);
    // A nested .npmignore keeps the marker (and itself) out of `npm pack`,
    // which otherwise packs all of build/ (`files`).
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ ...manifest, files: ["build"] }),
    );
    const pack = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"],
      {
        cwd: root,
        encoding: "utf8",
        shell: process.platform === "win32",
        env: { ...process.env, npm_config_update_notifier: "false" },
      },
    );
    assert.equal(pack.status, 0, pack.stderr);
    const packed = JSON.parse(pack.stdout)[0].files.map((f) => f.path);
    assert.ok(
      packed.includes("build/tessera/node_modules/@tessera/cli/package.json"),
      packed.join("\n"),
    );
    const leaked = packed.filter(
      (p) => p.includes("stage-tessera") || p.endsWith(".npmignore"),
    );
    assert.deepEqual(leaked, []);
  });
});

// --- wave 15 (TODO wave-13 residual) -----------------------------------------
// Delegated decision 2026-09-30 (wave 15): the marker lives inside --out and
// carries a digest of the staged tree, so it survives a node_modules wipe and
// still licenses only an unmodified tree this script produced.

test("a node_modules wipe does not lose the right to re-stage", () => {
  withRoot(({ root, out }) => {
    assert.equal(stage(root).status, 0);
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    const res = stage(root);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(markerFor(out));
  });
});

test("stage-tessera refuses foreign content added to its own staged tree", () => {
  withRoot(({ root, out }) => {
    assert.equal(stage(root).status, 0);
    writeFileSync(join(out, "keep.txt"), "precious");
    const res = stage(root);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /marker/);
    assert.equal(readFileSync(join(out, "keep.txt"), "utf8"), "precious");
  });
});

test("stage-tessera refuses a staged tree whose files were edited", () => {
  withRoot(({ root, out }) => {
    assert.equal(stage(root).status, 0);
    const file = join(
      out,
      "node_modules",
      "@tessera",
      "cli",
      "build",
      "index.js",
    );
    writeFileSync(file, "export const edited = true;\n");
    const res = stage(root);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /marker/);
    assert.equal(readFileSync(file, "utf8"), "export const edited = true;\n");
  });
});

test("stage-tessera refuses a tampered, partial or legacy marker", () => {
  withRoot(({ root, out }) => {
    assert.equal(stage(root).status, 0);
    const path = join(out, MARKER);
    const good = readFileSync(path, "utf8");
    const parsed = JSON.parse(good);
    const flipped = parsed.digest.startsWith("0") ? "1" : "0";
    for (const body of [
      JSON.stringify({ ...parsed, digest: flipped + parsed.digest.slice(1) }),
      JSON.stringify({ ...parsed, stagedBy: "someone-else" }),
      JSON.stringify({ ...parsed, format: 1 }),
      // The pre-wave-13 in-tree marker: no digest, so no proof.
      JSON.stringify({ stagedBy: "scripts/stage-tessera.mjs" }),
      good.slice(0, Math.floor(good.length / 2)),
      "",
    ]) {
      writeFileSync(path, body);
      const res = stage(root);
      assert.equal(res.status, 1, `${body}: ${res.stderr}`);
      assert.match(res.stderr, /marker/);
      assert.equal(readFileSync(path, "utf8"), body);
    }
    // Restored, it licenses the re-stage again.
    writeFileSync(path, good);
    assert.equal(stage(root).status, 0);
  });
});

test("a marker copied into a foreign directory licenses nothing", () => {
  withRoot(({ root, out }) => {
    assert.equal(stage(root).status, 0);
    const other = join(root, "build", "other");
    mkdirSync(other);
    writeFileSync(join(other, "keep.txt"), "precious");
    copyFileSync(join(out, MARKER), join(other, MARKER));
    copyFileSync(join(out, ".npmignore"), join(other, ".npmignore"));
    const res = stage(root, ["--out", other]);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /marker/);
    assert.equal(readFileSync(join(other, "keep.txt"), "utf8"), "precious");
  });
});

test("a wave-13 out-of-tree marker alone no longer licenses a re-stage", () => {
  withRoot(({ root, out }) => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "keep.txt"), "precious");
    mkdirSync(cacheDir(root), { recursive: true });
    writeFileSync(
      join(cacheDir(root), "x.json"),
      JSON.stringify({
        stagedBy: "scripts/stage-tessera.mjs",
        out: realpathSync(out),
        id: "0:0:0",
      }),
    );
    const res = stage(root);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /npm run build/);
    assert.equal(readFileSync(join(out, "keep.txt"), "utf8"), "precious");
  });
});

test("a marker does not license a re-created directory at the same path", () => {
  withRoot(({ root, out }) => {
    assert.equal(stage(root).status, 0);
    // Move the staged dir away (so its inode stays taken) and put an
    // unrelated, non-empty directory at the same path.
    renameSync(out, `${out}-moved`);
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "precious");
    const res = stage(root);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /marker/);
    assert.equal(readFileSync(join(out, "keep.txt"), "utf8"), "precious");
  });
});

/** Entries of build/ other than `out` itself (temp/backup leftovers). */
function buildSiblings(root, out) {
  const build = join(root, "build");
  const base = out.slice(build.length + 1);
  return readdirSync(build).filter((n) => n !== base);
}

test("a failed verify leaves no staged tree when --out was absent", () => {
  withRoot(({ root, ws, out }) => {
    // @tessera/mcp builds but no longer declares `tessera-mcp`: verify fails
    // after every package was already copied.
    writePackage(ws, "mcp", { dependencies: { "@tessera/cli": "*" } });
    const res = stage(root);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /^stage-tessera: /m);
    assert.equal(existsSync(out), false);
    assert.deepEqual(buildSiblings(root, out), []);
    assert.equal(existsSync(cacheDir(root)), false);
  });
});

test("a failed verify restores the previous staged tree untouched", () => {
  withRoot(({ root, ws, out }) => {
    assert.equal(stage(root).status, 0);
    const before = walk(out).sort();
    writePackage(ws, "mcp", { dependencies: { "@tessera/cli": "*" } });
    const res = stage(root);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /tessera-mcp/);
    // The prior tree is intact and still re-stageable (marker still valid).
    assert.deepEqual(walk(out).sort(), before);
    assert.deepEqual(buildSiblings(root, out), []);
    assert.ok(markerFor(out));
    writePackage(ws, "mcp", {
      bin: { "tessera-mcp": "bin/tessera-mcp.mjs" },
      dependencies: { "@tessera/cli": "*" },
    });
    const again = stage(root);
    assert.equal(again.status, 0, again.stderr);
  });
});

test("a mid-copy failure (unbuilt package) leaves the previous tree in place", () => {
  withRoot(({ root, ws, out }) => {
    assert.equal(stage(root).status, 0);
    const before = walk(out).sort();
    rmSync(join(ws, "packages", "types", "build"), {
      recursive: true,
      force: true,
    });
    const res = stage(root);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /@tessera\/types is not built/);
    assert.deepEqual(walk(out).sort(), before);
    assert.deepEqual(buildSiblings(root, out), []);
  });
});

test("stage-tessera sweeps temp/backup siblings a killed run left behind", () => {
  withRoot(({ root, out }) => {
    // PID 0 never names a live stager, so these read as abandoned.
    for (const name of ["tessera.stage-tmp-0", "tessera.stage-old-x"]) {
      mkdirSync(join(root, "build", name, "node_modules"), { recursive: true });
    }
    writeFileSync(join(root, "build", "unrelated.txt"), "keep");
    const res = stage(root);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(buildSiblings(root, out), ["unrelated.txt"]);
  });
});
