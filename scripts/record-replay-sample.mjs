#!/usr/bin/env node
/**
 * Re-record `test/fixtures/replay-sample/`: the credential-free recording the
 * GitHub Action self-test (`.github/workflows/action-selftest.yml`) replays.
 * It runs the CLI with `--record` against a loopback stub that answers every
 * Table API read with an empty page, so the recording holds no instance data.
 *
 *   npm run build && node scripts/record-replay-sample.mjs
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_CHECKS = [
  "instance-url-configured",
  "connectivity-auth",
  "acl-role-sanity",
];

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);
const OUT = fileURLToPath(
  new URL("../test/fixtures/replay-sample", import.meta.url),
);

const server = createServer((req, res) => {
  res.writeHead(200, {
    "content-type": "application/json",
    "x-total-count": "0",
  });
  res.end(JSON.stringify({ result: [] }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = /** @type {import("node:net").AddressInfo} */ (
  server.address()
);

rmSync(OUT, { recursive: true, force: true });
// An empty cwd, so no local config file or `.env` is read.
const cwd = mkdtempSync(join(tmpdir(), "snpf-sample-"));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("SNPF_")) delete env[key];
}
env.SNPF_USER = "sample";
env.SNPF_PASS = "sample";
const child = spawn(
  process.execPath,
  [
    BIN,
    "run",
    "--instance",
    `http://127.0.0.1:${port}`,
    "--only",
    SAMPLE_CHECKS.join(","),
    "--record",
    OUT,
    "--no-summary",
  ],
  { cwd, env, stdio: "inherit" },
);
const [code] = await once(child, "exit");
server.close();
rmSync(cwd, { recursive: true, force: true });
process.exitCode = code ?? 1;
