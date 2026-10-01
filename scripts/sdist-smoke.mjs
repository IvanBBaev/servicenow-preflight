#!/usr/bin/env node
// SDIST smoke: "does the tool install and pass EnvironmentDoctor on a clean
// machine?" — the offline half of it, runnable on any developer box or CI
// runner without Docker.
//
// What it does, in order:
//   1. `npm pack` of this package into a temp dir. The `prepack` hook stages
//      the Tessera runtime closure (scripts/stage-tessera.mjs, ADR-001 Option
//      B), so the tarball is exactly what `npm publish` would upload. The pack
//      runs under tessera/scripts/build-lock.mjs, because staging reads
//      tessera/packages/*/build and a concurrent Tessera build deletes it.
//      The same lock hold also covers the in-process import of
//      @tessera/fake-instance (used by the `tess doctor --fake` bridge).
//   2. Installs that tarball globally into a FRESH temp prefix, with an empty
//      npm cache, an empty HOME, empty user/global npmrc files, `--offline` and
//      a registry that points at a closed local port. The product has zero
//      runtime dependencies, so the install must not need the network; if it
//      ever does, it fails here with ENOTCACHED instead of reaching out.
//   3. From the installed copy only (its bin links, a PATH holding nothing but
//      the node binary's dir and the prefix):
//        - `servicenow-preflight --help` and `tess --help` exit 0;
//        - `tess doctor --instance default --json` against a
//          @tessera/fake-instance started here: a seeded instance reports
//          `ready` / exit 0, and one with the ATF runner disabled reports
//          `not-ready` / exit 1 — both legs, so a doctor that never reached the
//          fake cannot pass. The fake is served over a loopback HTTP bridge;
//          the vendored transport always speaks `https://<host>` on 443, so a
//          zero-import `--import` preload in the doctor process rewrites the
//          two fake hosts to that bridge and refuses every other host;
//        - `tessera-mcp` answers `initialize` and `tools/list` over stdio;
//        - the installed tree carries no @tessera/store and no
//          @tessera/fake-instance (they must stay out of the release closure).
//   4. Removes every temp dir in `finally` and prints one machine-readable
//      line to stdout: `SDIST_SMOKE_RESULT {json}`. Progress goes to stderr.
//
// PREREQUISITES — this script builds nothing (the same convention as
// stage-tessera.mjs, which refuses an unbuilt workspace):
//   npm run build                    # root build/ (what the tarball ships)
//   (cd tessera && npm run build)    # the Tessera closure + the fake instance
//
// Usage: node scripts/sdist-smoke.mjs [--keep]
//   --keep  leave the temp dir in place and print its path (for debugging)
//
// Exit: 0 every assertion held; 1 an assertion failed; 2 a prerequisite is
// missing (nothing was packed or installed).

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TESSERA = join(ROOT, "tessera");
const BUILD_LOCK = join(TESSERA, "scripts", "build-lock.mjs");
const FAKE_INSTANCE = join(
  TESSERA,
  "packages",
  "fake-instance",
  "build",
  "index.js",
);
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const IS_WINDOWS = process.platform === "win32";

/** Packages that must never be inside the installed tree. */
const EXCLUDED_PACKAGES = ["@tessera/store", "@tessera/fake-instance"];

/** Hosts the fake answers to. Non-prod markers + vendor domain (§11.2). */
const READY_HOST = "dev-sdist-ready.service-now.com";
const RUNNER_OFF_HOST = "dev-sdist-off.service-now.com";

/** build-lock.mjs: the lock was held and the command never ran. */
const LOCK_BUSY = 75;
const LOCK_RETRIES = 40;
const LOCK_RETRY_MS = 3000;

const STEP_TIMEOUT_MS = 120_000;

const steps = [];

function log(message) {
  console.error(`sdist-smoke: ${message}`);
}

class SmokeFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Spawn and collect; never throws for a non-zero exit. */
function runProcess(command, args, options = {}) {
  const { env, cwd, input, timeoutMs = STEP_TIMEOUT_MS, shell } = options;
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: 127, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[killed after ${timeoutMs} ms]\n`;
      done({ code: code ?? 128, signal, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Run one named step, time it, and record it for the summary line. */
async function step(name, body) {
  const started = Date.now();
  log(`${name} ...`);
  const entry = { name, ok: false };
  steps.push(entry);
  try {
    const detail = await body();
    entry.ok = true;
    if (detail !== undefined) entry.detail = detail;
    return detail;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    entry.ms = Date.now() - started;
    log(`${name} ${entry.ok ? "ok" : "FAILED"} (${entry.ms} ms)`);
  }
}

function describeRun(res) {
  const tail = (text) => text.trim().split("\n").slice(-15).join("\n");
  return `exit ${res.code}\n--- stdout ---\n${tail(res.stdout)}\n--- stderr ---\n${tail(res.stderr)}`;
}

/** The npm this node ships with: `npm_execpath` under `npm run`, else PATH. */
function npmCommand() {
  const cli = process.env.npm_execpath;
  if (cli && /\.[cm]?js$/.test(cli) && existsSync(cli)) {
    return { command: process.execPath, prefix: [cli] };
  }
  return { command: IS_WINDOWS ? "npm.cmd" : "npm", prefix: [] };
}

function checkPrerequisites() {
  const missing = [];
  if (!existsSync(join(ROOT, "build", "index.js"))) {
    missing.push("root build/ — run `npm run build`");
  }
  if (!existsSync(TESSERA)) {
    missing.push("tessera/ — the SDIST smoke needs the Tessera workspace");
  } else {
    for (const pkg of ["cli", "mcp", "doctor", "fake-instance"]) {
      const entry = join(TESSERA, "packages", pkg, "build", "index.js");
      if (!existsSync(entry)) {
        missing.push(
          `tessera/packages/${pkg}/build — run \`npm run build\` in tessera/`,
        );
      }
    }
  }
  return missing;
}

/**
 * The process that sits inside a build-lock hold: it reports the hold's token
 * and lock path (build-lock.mjs exports both to its child) on one stdout line,
 * then lives until its stdin closes. Closing stdin — or this process dying,
 * which closes the pipe — ends the child and so releases the lock.
 */
const HOLDER_SOURCE = [
  "process.stdout.write(JSON.stringify({",
  "  owner: process.env.TESSERA_BUILD_LOCK_OWNER || '',",
  "  lock: process.env.TESSERA_BUILD_LOCK || '',",
  "}) + '\\n');",
  "process.stdin.resume();",
  "process.stdin.on('end', () => process.exit(0));",
  "process.stdin.on('error', () => process.exit(0));",
].join("\n");

/**
 * Take the Tessera build lock and keep it until `release()`.
 *
 * Delegated decision 2026-09-26 (W6b review): the lock must cover BOTH readers of
 * tessera/packages/*\/build in this script — the `npm pack` (whose prepack
 * stages from it) and the in-process import of @tessera/fake-instance. A
 * concurrent Tessera build deletes build/ first, so an import outside the hold
 * can fail as ERR_MODULE_NOT_FOUND, or load a half-written module. The hold is
 * taken through build-lock.mjs itself (a holder child); `env` carries the
 * hold's token, so a nested build-lock.mjs run is re-entrant (its RE-ENTRANCY
 * rule: inherited token == owner on disk, holder alive) instead of refusing.
 *
 * Retries while the lock is busy (exit 75, "REFUSED"), like the pack used to.
 * Without tessera/scripts/build-lock.mjs there is nothing to hold.
 */
async function acquireBuildLock() {
  if (!existsSync(BUILD_LOCK)) {
    return { env: process.env, release: async () => {} };
  }
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await new Promise((done) => {
      const child = spawn(
        process.execPath,
        [BUILD_LOCK, process.execPath, "-e", HOLDER_SOURCE],
        { cwd: ROOT, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let settled = false;
      const closed = new Promise((resolveClosed) =>
        child.once("close", (code) => resolveClosed(code)),
      );
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (settled || newline < 0) return;
        settled = true;
        let hold;
        try {
          hold = JSON.parse(stdout.slice(0, newline));
        } catch {
          hold = {};
        }
        const release = async () => {
          child.stdin.end();
          await closed;
        };
        if (!hold.owner || !hold.lock) {
          done({
            error: `build lock holder reported no token: ${stdout}`,
            release,
          });
          return;
        }
        done({
          env: {
            ...process.env,
            TESSERA_BUILD_LOCK: hold.lock,
            TESSERA_BUILD_LOCK_OWNER: hold.owner,
          },
          release,
        });
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        done({ code: 127, stderr: `${stderr}${error.message}\n` });
      });
      void closed.then((code) => {
        if (settled) return;
        settled = true;
        done({ code: code ?? 128, stderr });
      });
    });
    if (outcome.env) return outcome;
    if (outcome.error) {
      await outcome.release();
      throw new SmokeFailure(outcome.error);
    }
    const busy = outcome.code === LOCK_BUSY && /REFUSED/.test(outcome.stderr);
    if (!busy || attempt >= LOCK_RETRIES) {
      throw new SmokeFailure(
        `could not take the tessera build lock: exit ${outcome.code}\n${outcome.stderr.trim()}`,
      );
    }
    log(`tessera build lock is busy; retry ${attempt}/${LOCK_RETRIES}`);
    await sleep(LOCK_RETRY_MS);
  }
}

/**
 * `npm pack`, inside the hold `env` names. Still wrapped in build-lock.mjs: the
 * wrapper passes through re-entrantly while our hold stands, and refuses (75)
 * if the hold was lost — which fails the pack instead of racing a build.
 */
async function pack(destination, cache, env) {
  const npm = npmCommand();
  const npmArgs = [
    ...npm.prefix,
    "pack",
    "--pack-destination",
    destination,
    "--cache",
    cache,
    "--offline",
  ];
  const useLock = existsSync(BUILD_LOCK);
  const [command, args] = useLock
    ? [process.execPath, [BUILD_LOCK, npm.command, ...npmArgs]]
    : [npm.command, npmArgs];
  return runProcess(command, args, {
    cwd: ROOT,
    env,
    shell: IS_WINDOWS && !useLock && npm.prefix.length === 0,
  });
}

/** Env for anything run from the installed copy: nothing of the author's. */
function cleanEnv(tmp, prefixBin, extra = {}) {
  const env = {
    PATH: [prefixBin, dirname(process.execPath)].join(delimiter),
    HOME: join(tmp, "home"),
    USERPROFILE: join(tmp, "home"),
    TMPDIR: join(tmp, "tmp"),
    TEMP: join(tmp, "tmp"),
    TMP: join(tmp, "tmp"),
    npm_config_cache: join(tmp, "npm-cache"),
    npm_config_userconfig: join(tmp, "npmrc-user"),
    npm_config_globalconfig: join(tmp, "npmrc-global"),
    npm_config_update_notifier: "false",
    ...extra,
  };
  if (!IS_WINDOWS) env.PATH += `${delimiter}/usr/bin${delimiter}/bin`;
  for (const key of ["SystemRoot", "ComSpec", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/** Every directory under `dir` (no symlink following). */
function walkDirs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    out.push(full);
    walkDirs(full, out);
  }
  return out;
}

/**
 * The fake instances behind a loopback HTTP bridge. The preload in the doctor
 * process forwards `https://<host>/…` here and names the host in a header.
 */
async function startBridge(createFakeInstance) {
  const seed = (atfRunner) => ({
    sys_properties: [
      { name: "sn_atf.runner.enabled", value: String(atfRunner) },
      { name: "glide.installation.production", value: "false" },
    ],
  });
  const fakes = {
    [READY_HOST]: createFakeInstance({ host: READY_HOST, state: seed(true) }),
    [RUNNER_OFF_HOST]: createFakeInstance({
      host: RUNNER_OFF_HOST,
      state: seed(false),
    }),
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const host = String(req.headers["x-sdist-host"] ?? "");
      const fake = fakes[host];
      if (fake === undefined) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`sdist-smoke bridge: no fake instance for "${host}"`);
        return;
      }
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (key === "host" || key === "x-sdist-host") continue;
        if (typeof value === "string") headers[key] = value;
      }
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : Buffer.concat(chunks).toString("utf8");
      fake
        .fetch(`https://${host}${req.url}`, {
          method: req.method,
          headers,
          body,
        })
        .then(async (response) => {
          const payload = Buffer.from(await response.arrayBuffer());
          const out = {};
          response.headers.forEach((value, key) => {
            if (key !== "content-length" && key !== "transfer-encoding") {
              out[key] = value;
            }
          });
          res.writeHead(response.status, out);
          res.end(payload);
        })
        .catch((error) => {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(`sdist-smoke bridge: ${error.message}`);
        });
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    fakes,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

/**
 * The `--import` preload for the doctor process. Zero imports on purpose: the
 * installed copy must not be able to lean on anything outside its own tree.
 * Every host other than the two fakes is refused — no request leaves the box.
 */
function preloadSource() {
  return `// Generated by scripts/sdist-smoke.mjs — redirects the fake hosts only.
const bridge = process.env.SDIST_SMOKE_BRIDGE;
const hosts = new Set(JSON.parse(process.env.SDIST_SMOKE_HOSTS));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const href =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (!hosts.has(url.host)) {
    return Promise.reject(
      new Error("sdist-smoke: network egress refused for " + url.host),
    );
  }
  const target = bridge + url.pathname + url.search;
  if (typeof input === "string" || input instanceof URL) {
    const headers = new Headers(init?.headers);
    headers.set("x-sdist-host", url.host);
    return realFetch(target, { ...init, headers });
  }
  const request = new Request(target, input);
  request.headers.set("x-sdist-host", url.host);
  return realFetch(request, init);
};
`;
}

async function main() {
  const keep = process.argv.includes("--keep");
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--keep");
  if (unknown.length > 0) {
    log(`unknown argument(s): ${unknown.join(" ")}`);
    return 2;
  }

  const missing = checkPrerequisites();
  if (missing.length > 0) {
    log("prerequisites missing (this script builds nothing):");
    for (const line of missing) log(`  - ${line}`);
    return 2;
  }

  // realpath: macOS hands out /var/… for /private/var/…, and the bin links npm
  // writes resolve through the real path.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "snpf-sdist-")));
  for (const dir of ["home", "tmp", "pack", "prefix", "npm-cache", "work"]) {
    mkdirSync(join(tmp, dir), { recursive: true });
  }
  writeFileSync(join(tmp, "npmrc-user"), "");
  writeFileSync(join(tmp, "npmrc-global"), "");
  const prefix = join(tmp, "prefix");
  const prefixBin = IS_WINDOWS ? prefix : join(prefix, "bin");
  const pkgDir = IS_WINDOWS
    ? join(prefix, "node_modules", PACKAGE.name)
    : join(prefix, "lib", "node_modules", PACKAGE.name);
  const bin = (name) => join(prefixBin, IS_WINDOWS ? `${name}.cmd` : name);
  const work = join(tmp, "work");
  let bridge;
  let tarball;

  let createFakeInstance;

  try {
    // Both readers of tessera/packages/*/build run inside ONE build-lock hold:
    // the pack (prepack staging) and the fake-instance import. Once imported,
    // the module lives in memory, so later steps need no hold.
    const hold = await acquireBuildLock();
    try {
      await step("pack", async () => {
        // `prepack` stages into build/tessera; leave build/ as it was found.
        const staged = join(ROOT, "build", "tessera");
        const hadStaged = existsSync(staged);
        const res = await pack(
          join(tmp, "pack"),
          join(tmp, "pack-cache"),
          hold.env,
        );
        if (!hadStaged) rmSync(staged, { recursive: true, force: true });
        assert(res.code === 0, `npm pack failed: ${describeRun(res)}`);
        const files = readdirSync(join(tmp, "pack")).filter((f) =>
          f.endsWith(".tgz"),
        );
        assert(files.length === 1, `expected one tarball, found ${files}`);
        tarball = join(tmp, "pack", files[0]);
        return { file: files[0], bytes: statSync(tarball).size };
      });
      await step("load fake instance", async () => {
        ({ createFakeInstance } = await import(
          pathToFileURL(FAKE_INSTANCE).href
        ));
        assert(
          typeof createFakeInstance === "function",
          `${FAKE_INSTANCE} exports no createFakeInstance`,
        );
      });
    } finally {
      await hold.release();
    }

    await step("install", async () => {
      const npm = npmCommand();
      const res = await runProcess(
        npm.command,
        [
          ...npm.prefix,
          "install",
          "--global",
          "--prefix",
          prefix,
          "--offline",
          "--no-audit",
          "--no-fund",
          tarball,
        ],
        {
          cwd: work,
          // A closed local port: even a non-offline fetch could not leave.
          env: cleanEnv(tmp, prefixBin, {
            npm_config_registry: "http://127.0.0.1:9/",
          }),
          shell: IS_WINDOWS && npm.prefix.length === 0,
        },
      );
      if (res.code !== 0 && /ENOTCACHED|offline/i.test(res.stderr)) {
        throw new SmokeFailure(
          `install needed the network — servicenow-preflight must have zero ` +
            `runtime dependencies, and this tarball does not. ${describeRun(res)}`,
        );
      }
      assert(res.code === 0, `npm install failed: ${describeRun(res)}`);
      assert(existsSync(pkgDir), `installed package missing at ${pkgDir}`);
      for (const name of Object.keys(PACKAGE.bin)) {
        assert(existsSync(bin(name)), `bin link "${name}" missing`);
      }
    });

    await step("installed-tree", async () => {
      const staged = join(pkgDir, "build", "tessera", "node_modules");
      const present = existsSync(join(staged, "@tessera"))
        ? readdirSync(join(staged, "@tessera")).map((n) => `@tessera/${n}`)
        : [];
      assert(
        present.includes("@tessera/cli") && present.includes("@tessera/mcp"),
        `the Tessera closure is not staged in the tarball (found: ${present.join(", ") || "nothing"})`,
      );
      const topModules = join(pkgDir, "node_modules");
      const deps = existsSync(topModules) ? readdirSync(topModules) : [];
      assert(
        deps.filter((n) => !n.startsWith(".")).length === 0,
        `installed copy pulled runtime dependencies: ${deps.join(", ")}`,
      );
      const leaked = [];
      for (const dir of walkDirs(prefix)) {
        const manifest = join(dir, "package.json");
        if (!existsSync(manifest)) continue;
        let name;
        try {
          name = JSON.parse(readFileSync(manifest, "utf8")).name;
        } catch {
          continue;
        }
        if (EXCLUDED_PACKAGES.includes(name)) leaked.push(`${name} at ${dir}`);
      }
      assert(leaked.length === 0, `excluded packages shipped: ${leaked}`);
      // The stager's in-tree marker and its .npmignore stay out of the tarball
      // (delegated decision 2026-09-30, wave 15).
      const stagedRoot = join(pkgDir, "build", "tessera");
      const sealed = [".stage-tessera.json", ".npmignore"].filter((name) =>
        existsSync(join(stagedRoot, name)),
      );
      assert(
        sealed.length === 0,
        `staging marker files shipped in build/tessera: ${sealed.join(", ")}`,
      );
      return { staged: present.length };
    });

    const runBin = (name, args, extra = {}, input) =>
      runProcess(bin(name), args, {
        cwd: work,
        env: cleanEnv(tmp, prefixBin, extra),
        input,
        shell: IS_WINDOWS,
      });

    await step("servicenow-preflight --help", async () => {
      const res = await runBin("servicenow-preflight", ["--help"]);
      assert(res.code === 0, describeRun(res));
      assert(/servicenow-preflight/i.test(res.stdout), describeRun(res));
    });

    await step("tess --help", async () => {
      const res = await runBin("tess", ["--help"]);
      assert(res.code === 0, describeRun(res));
      assert(/\bdoctor\b/.test(res.stdout), describeRun(res));
    });

    bridge = await startBridge(createFakeInstance);
    const preload = join(tmp, "sdist-preload.mjs");
    writeFileSync(preload, preloadSource());
    const doctorEnv = (host) => ({
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      SDIST_SMOKE_BRIDGE: bridge.origin,
      SDIST_SMOKE_HOSTS: JSON.stringify([READY_HOST, RUNNER_OFF_HOST]),
      SN_INSTANCE: host,
      SN_USER: "sdist",
      SN_PASSWORD: "sdist",
      SN_AUTH: "basic",
      SN_READONLY: "1",
      SN_MAX_RETRIES: "0",
      SN_DOCS_DIR: join(tmp, "sn-docs"),
    });
    const writesTo = (host) =>
      bridge.fakes[host].requests().filter((r) => r.method !== "GET");

    await step("tess doctor (ready)", async () => {
      const res = await runBin(
        "tess",
        ["doctor", "--instance", "default", "--json"],
        doctorEnv(READY_HOST),
      );
      assert(res.code === 0, describeRun(res));
      const report = JSON.parse(res.stdout);
      assert(report.status === "ready", `status ${report.status}`);
      assert(report.instances?.[0]?.host === READY_HOST, "wrong host probed");
      const served = bridge.fakes[READY_HOST].requests().length;
      assert(served > 0, "the doctor never reached the fake instance");
      assert(writesTo(READY_HOST).length === 0, "the doctor wrote");
      return { status: report.status, requests: served };
    });

    await step("tess doctor (runner disabled)", async () => {
      const res = await runBin(
        "tess",
        ["doctor", "--instance", "default", "--json"],
        doctorEnv(RUNNER_OFF_HOST),
      );
      assert(res.code === 1, `expected exit 1, ${describeRun(res)}`);
      const report = JSON.parse(res.stdout);
      assert(report.status === "not-ready", `status ${report.status}`);
      assert(writesTo(RUNNER_OFF_HOST).length === 0, "the doctor wrote");
      return { status: report.status, exit: res.code };
    });

    await step("tessera-mcp initialize + tools/list", async () => {
      const messages = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "sdist-smoke", version: PACKAGE.version },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ];
      const res = await runBin(
        "tessera-mcp",
        [],
        {},
        messages.map((m) => `${JSON.stringify(m)}\n`).join(""),
      );
      assert(res.code === 0, describeRun(res));
      const lines = res.stdout.split("\n").filter((l) => l.trim() !== "");
      let replies;
      try {
        replies = lines.map((l) => JSON.parse(l));
      } catch {
        throw new SmokeFailure(
          `non-JSON on the protocol channel: ${res.stdout}`,
        );
      }
      const init = replies.find((r) => r.id === 1);
      const list = replies.find((r) => r.id === 2);
      assert(
        init?.result?.protocolVersion,
        `no initialize result: ${res.stdout}`,
      );
      const tools = list?.result?.tools ?? [];
      assert(tools.length > 0, `tools/list returned no tools: ${res.stdout}`);
      return { tools: tools.length };
    });

    return 0;
  } catch (error) {
    if (!(error instanceof SmokeFailure)) throw error;
    log(error.message);
    return 1;
  } finally {
    if (bridge) await bridge.close();
    if (keep) log(`kept ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
}

const started = Date.now();
let code;
try {
  code = await main();
} catch (error) {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  code = 1;
}
const summary = {
  ok: code === 0,
  exit: code,
  package: `${PACKAGE.name}@${PACKAGE.version}`,
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  ms: Date.now() - started,
  steps,
};
console.log(`SDIST_SMOKE_RESULT ${JSON.stringify(summary)}`);
process.exitCode = code;
