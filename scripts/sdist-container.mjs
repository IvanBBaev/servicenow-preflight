#!/usr/bin/env node
// SDIST smoke on a clean machine: runs scripts/sdist-smoke.mjs inside a fresh
// Linux container per Node version, from a clean checkout of HEAD, with the
// network switched off for the smoke itself.
//
// What it does, per Node version (default: 20 and 22):
//   1. `git archive HEAD` streamed into a new Docker volume through stdin —
//      exactly the committed tree, no node_modules, no build/, nothing of the
//      author's machine (no bind mount, so it works on any Docker host).
//   2. Build phase, in `node:<version>-bookworm-slim` WITH network: `npm ci` +
//      `npm run build` at the root and in tessera/ (the smoke builds nothing).
//   3. Smoke phase, in a second container of the same image with
//      `--network none`: `node scripts/sdist-smoke.mjs`. The pack, the offline
//      install into a fresh prefix, `tess doctor` against the fake instance and
//      `tessera-mcp` all run with no route off the box.
//   4. Removes the volume in `finally` and prints one machine-readable line to
//      stdout: `SDIST_CONTAINER_RESULT {json}` (one entry per Node version,
//      carrying that run's SDIST_SMOKE_RESULT). Progress goes to stderr.
//
// Uncommitted changes are NOT tested — it says so when the tree is dirty.
//
// Usage: node scripts/sdist-container.mjs [--node 20,22] [--keep]
//   --node  comma-separated Node major versions (image node:<v>-bookworm-slim)
//   --keep  leave the volumes in place and print their names (for debugging)
//
// Exit: 0 every run passed; 1 a build or smoke failed; 2 a prerequisite is
// missing (no docker, no git work tree, a bad argument).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_NODES = ["20", "22"];
const BUILD_TIMEOUT_MS = 900_000;
const SMOKE_TIMEOUT_MS = 600_000;

function log(message) {
  console.error(`sdist-container: ${message}`);
}

/** Spawn and collect; never throws for a non-zero exit. */
function runProcess(command, args, options = {}) {
  const { stdinFrom, timeoutMs = 120_000 } = options;
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: [stdinFrom ? "pipe" : "ignore", "pipe", "pipe"],
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
    if (stdinFrom) {
      stdinFrom.stdout.pipe(child.stdin);
      child.stdin.on("error", () => {});
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: 127, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[killed after ${timeoutMs} ms]\n`;
      done({ code: code ?? 128, stdout, stderr });
    });
  });
}

function tail(text, lines = 25) {
  return text.trim().split("\n").slice(-lines).join("\n");
}

function parseArgs(argv) {
  const options = { nodes: DEFAULT_NODES, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--node" && i + 1 < argv.length) {
      options.nodes = argv[(i += 1)].split(",").map((v) => v.trim());
    } else return { error: `unknown argument: ${arg}` };
  }
  const bad = options.nodes.filter((v) => !/^\d{2}$/.test(v));
  if (options.nodes.length === 0 || bad.length > 0) {
    return { error: `--node takes Node major versions, got: ${bad.join(",")}` };
  }
  return options;
}

/** The build phase, as one shell script run in the container. */
const BUILD_SCRIPT = [
  "set -e",
  "cd /work",
  "tar -xf -",
  'step() { name=$1; shift; echo "== $name" >&2;',
  '  if ! "$@" >/tmp/step.log 2>&1; then tail -40 /tmp/step.log >&2; exit 1; fi; }',
  "step 'root npm ci' npm ci --no-audit --no-fund",
  "step 'root build' npm run build",
  "cd tessera",
  "step 'tessera npm ci' npm ci --no-audit --no-fund",
  "step 'tessera build' npm run build",
].join("\n");

async function runOne(node, commit, keep) {
  const image = `node:${node}-bookworm-slim`;
  const volume = `snpf-sdist-${node}-${randomBytes(4).toString("hex")}`;
  // Named, so a timed-out `docker run` (killing the client does not stop the
  // container) can still be removed before its volume.
  const containers = [`${volume}-build`, `${volume}-smoke`];
  const entry = { node, image, ok: false };
  const started = Date.now();
  try {
    const created = await runProcess("docker", ["volume", "create", volume]);
    if (created.code !== 0) {
      entry.error = `docker volume create: ${tail(created.stderr)}`;
      return entry;
    }

    log(`node ${node}: build phase (${image}, network on) ...`);
    const archive = spawn("git", ["archive", "--format=tar", commit], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const build = await runProcess(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        containers[0],
        "-i",
        "-v",
        `${volume}:/work`,
        image,
        "sh",
        "-c",
        BUILD_SCRIPT,
      ],
      { stdinFrom: archive, timeoutMs: BUILD_TIMEOUT_MS },
    );
    // A container that died early leaves git blocked on a full pipe.
    const archived =
      archive.exitCode !== null
        ? archive.exitCode
        : await new Promise((done) => {
            archive.once("close", (code) => done(code));
            archive.kill("SIGKILL");
          });
    if (build.code === 0 && archived !== 0) {
      entry.error = `git archive ${commit} failed (exit ${archived})`;
      return entry;
    }
    if (build.code !== 0) {
      entry.error = `build phase failed (exit ${build.code}):\n${tail(build.stderr)}`;
      return entry;
    }

    log(`node ${node}: smoke phase (--network none) ...`);
    const smoke = await runProcess(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        containers[1],
        "--network",
        "none",
        "-v",
        `${volume}:/work`,
        "-w",
        "/work",
        image,
        "node",
        "scripts/sdist-smoke.mjs",
      ],
      { timeoutMs: SMOKE_TIMEOUT_MS },
    );
    const line = smoke.stdout
      .split("\n")
      .find((l) => l.startsWith("SDIST_SMOKE_RESULT "));
    if (line) {
      try {
        entry.smoke = JSON.parse(line.slice("SDIST_SMOKE_RESULT ".length));
      } catch {
        entry.smoke = undefined;
      }
    }
    if (smoke.code !== 0 || entry.smoke?.ok !== true) {
      entry.error = `smoke phase failed (exit ${smoke.code}):\n${tail(smoke.stderr)}`;
      return entry;
    }
    entry.ok = true;
    return entry;
  } finally {
    entry.ms = Date.now() - started;
    if (keep) log(`kept volume ${volume}`);
    else {
      await runProcess("docker", ["rm", "-f", ...containers]);
      await runProcess("docker", ["volume", "rm", "-f", volume]);
    }
    log(`node ${node}: ${entry.ok ? "ok" : "FAILED"} (${entry.ms} ms)`);
  }
}

async function main(summary) {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) {
    log(options.error);
    return 2;
  }
  const docker = await runProcess("docker", [
    "info",
    "--format",
    "{{.OSType}}/{{.Architecture}}",
  ]);
  if (docker.code !== 0) {
    log(`docker is not available: ${tail(docker.stderr, 5)}`);
    return 2;
  }
  summary.host = docker.stdout.trim();
  const head = await runProcess("git", ["rev-parse", "--short", "HEAD"]);
  if (head.code !== 0) {
    log(`not a git work tree: ${tail(head.stderr, 5)}`);
    return 2;
  }
  summary.commit = head.stdout.trim();
  const status = await runProcess("git", ["status", "--porcelain"]);
  if (status.stdout.trim() !== "") {
    log(`work tree is dirty — testing committed ${summary.commit} only`);
  }

  for (const node of options.nodes) {
    const entry = await runOne(node, summary.commit, options.keep);
    summary.runs.push(entry);
    if (!entry.ok) log(entry.error);
  }
  return summary.runs.every((r) => r.ok) ? 0 : 1;
}

const started = Date.now();
const summary = { runs: [] };
let code;
try {
  code = await main(summary);
} catch (error) {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  code = 1;
}
summary.ok = code === 0;
summary.exit = code;
summary.ms = Date.now() - started;
console.log(`SDIST_CONTAINER_RESULT ${JSON.stringify(summary)}`);
process.exitCode = code;
