#!/usr/bin/env node
// Stage the Tessera release closure into this package's build output, so the
// ONE published servicenow-preflight tarball carries `tess` and `tessera-mcp`
// (ADR-001 Option B: one package, one release train; delegated decision
// 2026-09-23).
//
// Why a staging step and not `bundleDependencies`: the @tessera/* packages are
// workspaces of the separate `tessera/` root, so here they could only appear as
// `file:` symlinks — and npm packs a bundled symlink's TARGET at its real path
// (`tessera/packages/<pkg>/…`), not at `node_modules/@tessera/<pkg>`, so an
// installed copy cannot resolve a single bare `@tessera/*` import. Staging real
// directories under `build/tessera/node_modules/` needs no root dependency, no
// root lockfile change and no `npm install`, and Node's ordinary bare-specifier
// lookup resolves every `@tessera/*` import from inside the staged tree.
//
// The closure is computed, not listed: every package reachable from the entry
// points through `dependencies` (never `devDependencies`). That leaves out
// `@tessera/store` (contested licence) and `@tessera/fake-instance` (Tier-2 test
// double, a devDependency reached only by `tess run --fake`); the run fails if
// either ever becomes a runtime dependency, rather than shipping it silently.
//
// Only `package.json` (scripts and devDependencies stripped), `build/` (minus
// source maps, whose `src/` targets are not shipped) and `bin/` are copied.
//
// Fail-closed (delegated decision 2026-09-26, W6b review):
//   * No `--if-present` skip. It let `prepack` print "nothing staged" and pack
//     a tarball whose `tess`/`tessera-mcp` bins point at a tree that is not in
//     it. A checkout without tessera/ now fails to pack, which is correct: the
//     root package.json declares those bins unconditionally.
//   * A post-condition: after staging, every root bin backed by
//     bin/tessera-launcher.cjs must resolve inside the staged tree — the entry
//     package is staged, its manifest declares that bin with the file the
//     launcher opens, and the file exists. `tess` and `tessera-mcp`, when
//     declared, must be launcher-backed. The launcher arguments are read from
//     the bin files themselves, so this cannot drift from what ships.
//   * `--out` is replaced wholesale, so it must resolve (symlinks followed)
//     strictly inside `<root>/build/`, and an existing non-empty `--out` must
//     carry a valid staging marker (below).
//
// Delegated decision 2026-09-30 (wave 15, TODO wave-13 residual):
//   * The marker lives INSIDE `--out` (`.stage-tessera.json`), so it survives
//     a `node_modules` wipe — the wave-13 out-of-tree marker under
//     `node_modules/.cache/` did not, and the next stage then refused its own
//     output. A nested `.npmignore` next to it keeps both files out of the
//     tarball (npm honours a subdirectory .npmignore even under `files`).
//   * The marker is a proof, not a flag: it records a sha256 digest over every
//     path, type and file content of the staged tree (the marker excluded).
//     A re-stage replaces `--out` only when the recomputed digest matches, so
//     foreign files, edits, a copied marker or a tampered/partial/digest-less
//     marker (including the pre-wave-13 `{stagedBy}` one) are all refused.
//     Wave-13 out-of-tree markers are no longer read — fail closed: such a
//     tree is refused once, and `npm run build` (which recreates build/)
//     clears it.
//
// Delegated decision 2026-09-28 (wave 13, TODO wave-11 residuals):
//   * Staging is transactional: the closure is staged and verified in a
//     sibling temp dir, and only a verified tree replaces `--out` (by rename).
//     Any failure removes the temp dir in a `finally`, leaving `--out` exactly
//     as it was found (absent, empty, or the previous staged tree).
//
// Usage: node scripts/stage-tessera.mjs [--from <tessera dir>] [--out <dir>]
//   --from  the Tessera workspace root (default: ./tessera)
//   --out   where to stage (default: ./build/tessera; must be under ./build/)

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

/** The in-tree staging marker (a digest proof; see the header). */
const MARKER = ".stage-tessera.json";
const MARKER_BY = "scripts/stage-tessera.mjs";
const MARKER_FORMAT = 2;

/** Keeps the marker (and itself) out of `npm pack`; part of the digest. */
const NPMIGNORE = ".npmignore";
const NPMIGNORE_BODY = `${MARKER}\n${NPMIGNORE}\n`;

/** Sibling-name infixes of the transactional temp / backup directories. */
const TMP_INFIX = ".stage-tmp-";
const OLD_INFIX = ".stage-old-";

/** Root bins that must be backed by the Tessera launcher when declared. */
const REQUIRED_LAUNCHER_BINS = ["tess", "tessera-mcp"];

/** `require("./tessera-launcher.cjs")("<bin>", "<pkg>", "<file>")`. */
const LAUNCH_CALL =
  /require\(\s*["']\.\/tessera-launcher\.cjs["']\s*\)\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/;

/** The packages whose bins the root package exposes. */
const ENTRY_PACKAGES = ["@tessera/cli", "@tessera/mcp"];

/** Packages that must never ship inside the published tarball. */
const EXCLUDED_PACKAGES = ["@tessera/store", "@tessera/fake-instance"];

/** A staging refusal; caught at the top level (exit 1) after cleanup ran. */
class StageError extends Error {}

function fail(message) {
  throw new StageError(message);
}

function parseArgs(argv) {
  const opts = {
    from: join(ROOT, "tessera"),
    out: join(ROOT, "build", "tessera"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--from" || arg === "--out") {
      const value = argv[i + 1];
      if (!value) fail(`${arg} needs a value`);
      opts[arg.slice(2)] = resolve(value);
      i += 1;
    } else fail(`unknown argument "${arg}"`);
  }
  return opts;
}

/** Map every workspace package name under `<from>/packages` to its dir/manifest. */
function readWorkspace(from) {
  const packagesDir = join(from, "packages");
  if (!existsSync(packagesDir)) fail(`no packages/ under ${from}`);
  const byName = new Map();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    byName.set(manifest.name, { dir, manifest });
  }
  return byName;
}

/** Every package reachable from the entries through runtime `dependencies`. */
function releaseClosure(byName) {
  const closure = new Set();
  const queue = [...ENTRY_PACKAGES];
  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    const pkg = byName.get(name);
    if (!pkg) fail(`${name} is required but not in the workspace`);
    closure.add(name);
    for (const dep of Object.keys(pkg.manifest.dependencies ?? {})) {
      if (!dep.startsWith("@tessera/")) {
        fail(
          `${name} depends on "${dep}"; only @tessera/* runtime dependencies ` +
            `can be staged (a third-party dependency would need a real ` +
            `root dependency instead)`,
        );
      }
      queue.push(dep);
    }
  }
  for (const excluded of EXCLUDED_PACKAGES) {
    if (closure.has(excluded)) {
      fail(`${excluded} is in the runtime closure and must not ship`);
    }
  }
  return [...closure].sort();
}

function stagePackage(pkg, outModules) {
  const { dir, manifest } = pkg;
  const buildDir = join(dir, "build");
  if (!existsSync(join(buildDir, "index.js"))) {
    fail(`${manifest.name} is not built (${buildDir}); build tessera first`);
  }
  const target = join(outModules, ...manifest.name.split("/"));
  mkdirSync(target, { recursive: true });
  const staged = { ...manifest };
  delete staged.scripts;
  delete staged.devDependencies;
  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify(staged, null, 2)}\n`,
  );
  cpSync(buildDir, join(target, "build"), {
    recursive: true,
    filter: (src) => !src.endsWith(".map") && !src.endsWith(".tsbuildinfo"),
  });
  for (const rel of Object.values(manifest.bin ?? {})) {
    if (!existsSync(join(dir, rel)))
      fail(`${manifest.name} bin ${rel} missing`);
  }
  if (existsSync(join(dir, "bin"))) {
    cpSync(join(dir, "bin"), join(target, "bin"), { recursive: true });
  }
}

/**
 * `path` with symlinks resolved as far as it exists: the deepest existing
 * ancestor goes through realpath, the not-yet-created rest is appended.
 */
function realpathLoose(path) {
  let existing = path;
  const rest = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

/**
 * Refuse an `--out` the recursive delete must not touch. Delegated decision
 * 2026-09-26 (W6b review): only strictly inside `<root>/build/` (never
 * build/ itself, which holds the product), and an existing non-empty dir only
 * when it carries our marker — so a typo cannot `rm -rf` a real directory.
 */
function guardOut(out) {
  const buildRoot = join(ROOT, "build");
  const real = realpathLoose(out);
  const rel = relative(realpathLoose(buildRoot), real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    fail(
      `refusing --out ${out}: it must resolve strictly inside ${buildRoot}` +
        (real !== resolve(out) ? ` (it resolves to ${real})` : ""),
    );
  }
  if (!existsSync(out)) return;
  const stat = lstatSync(out);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`refusing --out ${out}: not a plain directory`);
  }
  if (readdirSync(out).length === 0) return;
  if (!hasValidMarker(out)) {
    fail(
      `refusing --out ${out}: it is not empty and carries no valid staging ` +
        `marker (${MARKER} with a matching digest), so it is not an ` +
        `unmodified tree staged by this script; remove it by hand (or run ` +
        `\`npm run build\`, which recreates build/)`,
    );
  }
}

/**
 * sha256 over every entry under `dir` except the top-level marker: sorted
 * relative paths with their type, symlink target or file-content hash. Any
 * added, removed, renamed or edited entry changes it.
 */
function treeDigest(dir) {
  const hash = createHash("sha256");
  const visit = (abs, rel) => {
    const names = readdirSync(abs).sort();
    for (const name of names) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (childRel === MARKER) continue;
      const child = join(abs, name);
      const st = lstatSync(child);
      if (st.isSymbolicLink()) {
        hash.update(`L\0${childRel}\0${readlinkSync(child)}\n`);
      } else if (st.isDirectory()) {
        hash.update(`D\0${childRel}\n`);
        visit(child, childRel);
      } else if (st.isFile()) {
        const content = createHash("sha256")
          .update(readFileSync(child))
          .digest("hex");
        hash.update(`F\0${childRel}\0${content}\n`);
      } else {
        hash.update(`O\0${childRel}\n`);
      }
    }
  };
  visit(dir, "");
  return hash.digest("hex");
}

/**
 * Whether `out` (an existing, non-empty directory) is an unmodified tree this
 * script staged: its marker parses, names this script and the current format,
 * and its digest matches the tree as it is now. Anything else fails closed.
 */
function hasValidMarker(out) {
  const path = join(out, MARKER);
  let marker;
  try {
    if (!lstatSync(path).isFile()) return false;
    marker = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  return (
    marker !== null &&
    typeof marker === "object" &&
    marker.stagedBy === MARKER_BY &&
    marker.format === MARKER_FORMAT &&
    typeof marker.digest === "string" &&
    /^[0-9a-f]{64}$/.test(marker.digest) &&
    marker.digest === treeDigest(out)
  );
}

/** Seal a freshly staged (still temp) tree: the .npmignore, then the marker. */
function writeMarker(dir) {
  writeFileSync(join(dir, NPMIGNORE), NPMIGNORE_BODY);
  const body = {
    stagedBy: MARKER_BY,
    format: MARKER_FORMAT,
    digest: treeDigest(dir),
  };
  writeFileSync(join(dir, MARKER), `${JSON.stringify(body)}\n`);
}

function pidAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Remove temp/backup siblings of `out` a hard-killed earlier run left behind
 * (the `finally` cleanup cannot run on SIGKILL). They sit under build/, which
 * ships, so they must not linger. A live run's own siblings are left alone.
 */
function sweepLeftovers(out) {
  const parent = dirname(out);
  if (!existsSync(parent)) return;
  const base = basename(out);
  for (const name of readdirSync(parent)) {
    for (const infix of [TMP_INFIX, OLD_INFIX]) {
      const prefix = `${base}${infix}`;
      if (!name.startsWith(prefix)) continue;
      const pid = Number(name.slice(prefix.length));
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) continue;
      rmSync(join(parent, name), { recursive: true, force: true });
    }
  }
}

/** The root bins backed by the Tessera launcher, read from the bin files. */
function launcherBins() {
  const manifestPath = join(ROOT, "package.json");
  if (!existsSync(manifestPath)) fail(`no package.json at ${ROOT}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bins = [];
  for (const [bin, rel] of Object.entries(manifest.bin ?? {})) {
    const file = join(ROOT, rel);
    if (!existsSync(file)) fail(`bin "${bin}" points at missing ${rel}`);
    const source = readFileSync(file, "utf8");
    const call = LAUNCH_CALL.exec(source);
    if (!call) {
      if (REQUIRED_LAUNCHER_BINS.includes(bin)) {
        fail(
          `bin "${bin}" (${rel}) is not a Tessera launcher call; its target ` +
            `cannot be verified against the staged tree`,
        );
      }
      if (source.includes("tessera-launcher")) {
        fail(
          `bin "${bin}" (${rel}) uses tessera-launcher in an unreadable way`,
        );
      }
      continue;
    }
    const [, name, short, binFile] = call;
    if (name !== bin) {
      fail(`bin "${bin}" (${rel}) launches as "${name}"; the names must match`);
    }
    bins.push({ bin, pkg: `@tessera/${short}`, file: `bin/${binFile}` });
  }
  return bins;
}

/** Post-condition: every launcher-backed bin resolves inside the staged tree. */
function verifyStaged(out, shownAs = out) {
  const bins = launcherBins();
  for (const { bin, pkg, file } of bins) {
    const dir = join(out, "node_modules", ...pkg.split("/"));
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      fail(`bin "${bin}" needs ${pkg}, which was not staged into ${shownAs}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const declared = manifest.bin?.[bin];
    const normalise = (p) =>
      typeof p === "string" ? p.replace(/^\.\//, "") : p;
    if (normalise(declared) !== file) {
      fail(
        `bin "${bin}": staged ${pkg} declares ${
          declared === undefined ? "no such bin" : `"${declared}"`
        }, but the launcher opens ${file}`,
      );
    }
    if (!existsSync(join(dir, file))) {
      fail(`bin "${bin}": ${pkg}/${file} is missing from the staged tree`);
    }
    if (!existsSync(join(dir, "build", "index.js"))) {
      fail(
        `bin "${bin}": ${pkg}/build/index.js is missing from the staged tree`,
      );
    }
  }
  return bins.map((b) => b.bin);
}

/**
 * Stage into a sibling temp dir, verify, then swap it in for `out`. Delegated
 * decision 2026-09-28 (wave 13): a failed stage or verify must not leave a
 * half-built or unverified tree where `npm pack` would ship it — the temp dir
 * is removed in `finally`, and `out` is only touched after verification.
 */
function stageInto(out, byName, closure) {
  sweepLeftovers(out);
  const tmp = `${out}${TMP_INFIX}${process.pid}`;
  const old = `${out}${OLD_INFIX}${process.pid}`;
  let swapped = false;
  try {
    mkdirSync(tmp, { recursive: true });
    const outModules = join(tmp, "node_modules");
    for (const name of closure) stagePackage(byName.get(name), outModules);
    const verified = verifyStaged(tmp, out);
    // Sealed before the swap, so `out` never holds an unmarked staged tree.
    writeMarker(tmp);
    const hadOut = existsSync(out);
    if (hadOut) renameSync(out, old);
    try {
      renameSync(tmp, out);
    } catch (err) {
      if (hadOut) renameSync(old, out);
      throw err;
    }
    swapped = true;
    return verified;
  } finally {
    if (swapped) rmSync(old, { recursive: true, force: true });
    else rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.from)) fail(`${opts.from} does not exist`);
  guardOut(opts.out);
  const byName = readWorkspace(opts.from);
  const closure = releaseClosure(byName);
  const verified = stageInto(opts.out, byName, closure);
  console.error(
    `stage-tessera: staged ${closure.length} packages into ${opts.out}: ${closure.join(", ")}; ` +
      `verified bins: ${verified.length > 0 ? verified.join(", ") : "(none declared)"}`,
  );
}

try {
  main();
} catch (err) {
  console.error(
    `stage-tessera: ${err instanceof StageError ? err.message : (err?.stack ?? String(err))}`,
  );
  process.exitCode = 1;
}
