#!/usr/bin/env node
// Atomic build (E-2): compile into a private sibling directory, then swap it in
// with two renames. `build/` is never left half-written or missing while tsc
// runs, so a concurrent `import("./build/index.js")` (a test run, gen:site, a
// second build) sees the old tree or the new one, not ERR_MODULE_NOT_FOUND.
//
// The temp directory sits next to build/ at the same depth, so the relative
// `sources` paths in the emitted source and declaration maps stay valid after
// the rename (c8 maps coverage back to src/ through them).
//
// Usage: node scripts/build.mjs   (extra arguments are passed to tsc)
// Exit: tsc's exit code on a compile error (build/ untouched), else 0.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "build");
const PREFIX = ".build-";
const tag = `${process.pid}-${Date.now().toString(36)}`;
const staging = join(ROOT, `${PREFIX}${tag}`);
const retired = join(ROOT, `${PREFIX}old-${tag}`);

/** Remove leftovers of builds that died before their own cleanup. */
function sweepStale() {
  for (const name of readdirSync(ROOT)) {
    if (!name.startsWith(PREFIX)) continue;
    const pid = Number(/^\.build-(?:old-)?(\d+)-/.exec(name)?.[1]);
    if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid)) continue;
    rmSync(join(ROOT, name), { recursive: true, force: true });
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

sweepStale();

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const result = spawnSync(
  process.execPath,
  [tsc, "--outDir", staging, ...process.argv.slice(2)],
  { cwd: ROOT, stdio: "inherit" },
);
if (result.status !== 0) {
  rmSync(staging, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

if (existsSync(OUT)) renameSync(OUT, retired);
renameSync(staging, OUT);
rmSync(retired, { recursive: true, force: true });
