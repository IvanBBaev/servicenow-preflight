#!/usr/bin/env node
// Pack-and-install smoke for the core package (A-14): "does the tarball npm
// would publish install and work for a consumer?" Part of `npm run check`.
//
// The heavier SDIST smoke (scripts/sdist-smoke.mjs) also covers the Tessera
// bins and needs a Tessera build; this one needs only the root build/ and runs
// in a few seconds, so every gate run covers the published shape.
//
// Steps:
//   1. `npm pack --ignore-scripts` into a temp dir (no Tessera staging; the
//      root `files` list decides the tarball contents).
//   2. Install that tarball into a fresh consumer project offline, with an
//      empty cache and HOME and a registry on a closed port. The package has
//      zero runtime dependencies, so the install must not need the network.
//   3. From the consumer only:
//        - the tarball ships build/index.js, build/index.d.ts, the schemas and
//          the bin launcher, and no test/, docs/ or build staging leftovers;
//        - `import("servicenow-preflight")` exposes `runPreflight` and
//          `defaultChecks`, every code subpath export imports and is
//          non-empty, and the `./schemas/*` subpath exports resolve;
//        - the `snpf` and `servicenow-preflight` bins answer `--version` with
//          the package version and `--help` with exit 0.
//   4. Removes the temp dir (unless --keep) and prints one line to stdout:
//      `PACK_SMOKE_RESULT {json}`.
//
// Usage: node scripts/pack-smoke.mjs [--keep]   (run `npm run build` first)
// Exit: 0 every assertion held; 1 an assertion failed; 2 no build/.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const IS_WINDOWS = process.platform === "win32";
const KEEP = process.argv.includes("--keep");
const TIMEOUT_MS = 120_000;

class SmokeFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

function log(message) {
  console.error(`pack-smoke: ${message}`);
}

/** The npm this node ships with: `npm_execpath` under `npm run`, else PATH. */
function npm(args, options) {
  const cli = process.env.npm_execpath;
  const viaNode = cli && /\.[cm]?js$/.test(cli) && existsSync(cli);
  return run(
    viaNode ? process.execPath : IS_WINDOWS ? "npm.cmd" : "npm",
    viaNode ? [cli, ...args] : args,
    { ...options, shell: !viaNode && IS_WINDOWS },
  );
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    ...options,
  });
  return {
    code: res.status ?? 128,
    stdout: res.stdout ?? "",
    stderr: `${res.stderr ?? ""}${res.error ? res.error.message : ""}`,
  };
}

function describe(res) {
  const tail = (text) => text.trim().split("\n").slice(-15).join("\n");
  return `exit ${res.code}\n--- stdout ---\n${tail(res.stdout)}\n--- stderr ---\n${tail(res.stderr)}`;
}

/** An environment that keeps npm away from the user's config and the network. */
function isolatedEnv(dir) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const userrc = join(dir, "user.npmrc");
  const globalrc = join(dir, "global.npmrc");
  writeFileSync(userrc, "");
  writeFileSync(globalrc, "");
  const env = {};
  for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    npm_config_userconfig: userrc,
    npm_config_globalconfig: globalrc,
    npm_config_cache: join(dir, "cache"),
    npm_config_registry: "http://127.0.0.1:9/",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

const CONSUMER_PROBE = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const lib = await import("servicenow-preflight");
assert.equal(typeof lib.runPreflight, "function", "runPreflight export");
assert.ok(Array.isArray(lib.defaultChecks) && lib.defaultChecks.length > 0, "defaultChecks export");
const pkg = JSON.parse(process.argv[3]);
for (const sub of Object.keys(pkg.exports)) {
  if (sub === "." || sub.endsWith(".json")) continue;
  const mod = await import("servicenow-preflight" + sub.slice(1));
  assert.ok(Object.keys(mod).length > 0, sub + " exports nothing");
}
const require = createRequire(import.meta.url);
for (const name of ["report.v1.json", "finding.v1.json", "preflight.config.v1.json"]) {
  const schema = require("servicenow-preflight/schemas/" + name);
  assert.equal(typeof schema, "object", name);
}
assert.equal(require("servicenow-preflight/package.json").version, process.argv[2]);
console.log("probe ok");
`;

async function main() {
  if (!existsSync(join(ROOT, "build", "index.js"))) {
    log("build/ is missing — run `npm run build` first");
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), "snpf-pack-smoke-"));
  const env = isolatedEnv(dir);
  const checks = [];
  try {
    const packDir = join(dir, "pack");
    mkdirSync(packDir);
    const pack = npm(
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
      { cwd: ROOT, env },
    );
    assert(pack.code === 0, `npm pack failed\n${describe(pack)}`);
    const [info] = JSON.parse(pack.stdout);
    const files = info.files.map((f) => f.path);
    for (const needed of [
      "build/index.js",
      "build/index.d.ts",
      "build/cli.js",
      "bin/servicenow-preflight.cjs",
      "schemas/report.v1.json",
      "package.json",
    ]) {
      assert(files.includes(needed), `tarball lacks ${needed}`);
    }
    const stray = files.filter((f) => /^(test|docs|coverage|\.build-)/.test(f));
    assert(stray.length === 0, `tarball ships ${stray.slice(0, 5).join(", ")}`);
    checks.push(`tarball (${files.length} files)`);

    const consumer = join(dir, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "consumer", private: true, type: "module" }),
    );
    const install = npm(
      ["install", "--ignore-scripts", join(packDir, info.filename)],
      { cwd: consumer, env },
    );
    assert(install.code === 0, `offline install failed\n${describe(install)}`);
    checks.push("offline install");

    writeFileSync(join(consumer, "probe.mjs"), CONSUMER_PROBE);
    const probe = run(
      process.execPath,
      [
        "probe.mjs",
        PACKAGE.version,
        JSON.stringify({ exports: PACKAGE.exports }),
      ],
      {
        cwd: consumer,
        env,
      },
    );
    assert(probe.code === 0, `library import failed\n${describe(probe)}`);
    checks.push("library import + every subpath export");

    const binDir = join(consumer, "node_modules", ".bin");
    const bins = readdirSync(binDir);
    for (const bin of ["snpf", "servicenow-preflight"]) {
      assert(
        bins.some((b) => b === bin || b === `${bin}.cmd`),
        `bin ${bin} not linked`,
      );
      const launcher = join(
        consumer,
        "node_modules",
        "servicenow-preflight",
        PACKAGE.bin[bin],
      );
      const version = run(process.execPath, [launcher, "--version"], {
        cwd: consumer,
        env,
      });
      assert(
        version.code === 0 && version.stdout.trim() === PACKAGE.version,
        `${bin} --version\n${describe(version)}`,
      );
      const help = run(process.execPath, [launcher, "--help"], {
        cwd: consumer,
        env,
      });
      assert(help.code === 0, `${bin} --help\n${describe(help)}`);
    }
    checks.push("bins --version / --help");

    process.stdout.write(
      `PACK_SMOKE_RESULT ${JSON.stringify({ ok: true, checks })}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`FAILED: ${message}`);
    process.stdout.write(
      `PACK_SMOKE_RESULT ${JSON.stringify({ ok: false, checks, error: message.split("\n")[0] })}\n`,
    );
    return 1;
  } finally {
    if (KEEP) log(`kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
