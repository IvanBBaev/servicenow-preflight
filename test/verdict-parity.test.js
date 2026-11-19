// RR-12 (ARC-1): the CLI and the library decide a run through one verdict
// pipeline. For every combination of severity policy, baseline and --fail-on,
// against three instance scenarios, the CLI's JSON envelope (`ok`,
// `runs[0].report`) and exit code must equal `runGate(...)` for the same
// inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSnClient, defaultChecks, runGate } from "../build/index.js";
import { baselineFromReport } from "../build/api/report.js";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);
const SCOPE = "x_acme_app";
const ONLY = ["instance-url-configured", "cors-rules"];
const CREDS = { SNPF_USER: "parity-user", SNPF_PASS: "parity-pass" };

/**
 * Instance scenarios. On an http loopback URL `instance-url-configured` warns;
 * `cors-rules` passes, fails or cannot read (an `error` row).
 */
const SCENARIOS = {
  clean: () => ({ status: 200, rows: [] }),
  finding: () => ({
    status: 200,
    rows: [
      {
        sys_id: "r1",
        name: "Open Door",
        domain: "*",
        active: "true",
        "sys_scope.scope": SCOPE,
      },
    ],
  }),
  "read-error": () => ({ status: 403 }),
};

async function startInstance(scenario) {
  const server = createServer((req, res) => {
    const table = new URL(req.url, "http://127.0.0.1").pathname.replace(
      "/api/now/table/",
      "",
    );
    if (table === "sys_scope") {
      const rows = [{ sys_id: "a".repeat(32), scope: SCOPE }];
      res.writeHead(200, {
        "content-type": "application/json",
        "x-total-count": String(rows.length),
      });
      res.end(JSON.stringify({ result: rows }));
      return;
    }
    const answer =
      table === "sys_cors_rule"
        ? SCENARIOS[scenario]()
        : { status: 200, rows: [] };
    if (answer.status !== 200) {
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "User Not Authorized" } }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "x-total-count": String(answer.rows.length),
    });
    res.end(JSON.stringify({ result: answer.rows }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

function runCli(args, cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SNPF_")) delete env[key];
  }
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...env, ...CREDS },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function libraryContext(url) {
  const auth = { kind: "basic", user: CREDS.SNPF_USER, pass: CREDS.SNPF_PASS };
  return {
    instanceUrl: url,
    auth,
    http: createSnClient({ instanceUrl: url, auth }),
    scope: SCOPE,
    select: { only: ONLY },
  };
}

const POLICIES = {
  off: undefined,
  on: { "cors-rules": "warn" },
};

/** The four baseline cases, built from the scenario's post-policy report. */
function baselineFor(kind, report, url) {
  if (kind === "none") return undefined;
  const b = baselineFromReport(
    report,
    undefined,
    new Date("2026-01-01T00:00:00Z"),
    url,
  );
  if (kind === "changed") {
    b.entries = b.entries.map((e) => ({ ...e, message: "an older message" }));
  }
  if (kind === "expired") {
    b.entries = b.entries.map((e) => ({ ...e, expires: "2000-01-01" }));
  }
  return b;
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

test("CLI and runGate agree on every policy × baseline × failOn case", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-parity-"));
  writeFileSync(
    join(dir, "preflight.config.json"),
    JSON.stringify({ scope: SCOPE }),
  );
  const instances = {};
  try {
    for (const name of Object.keys(SCENARIOS)) {
      instances[name] = await startInstance(name);
    }
    const cases = [];
    for (const scenario of Object.keys(SCENARIOS)) {
      for (const policyKey of Object.keys(POLICIES)) {
        for (const baselineKind of ["none", "match", "changed", "expired"]) {
          for (const failOn of ["fail", "warn"]) {
            cases.push({ scenario, policyKey, baselineKind, failOn });
          }
        }
      }
    }
    assert.equal(cases.length, 48);

    const seen = { ok: 0, notOk: 0, baselined: 0, expired: 0 };
    await inBatches(cases, 6, async (c) => {
      const { url } = instances[c.scenario];
      const policy = POLICIES[c.policyKey];
      const label = JSON.stringify(c);
      const unbaselined = await runGate(libraryContext(url), defaultChecks, {
        ...(policy ? { policy } : {}),
      });
      const baseline = baselineFor(c.baselineKind, unbaselined.report, url);

      const args = [
        "run",
        "--instance",
        url,
        "--only",
        ONLY.join(","),
        "--json",
        "--fail-on",
        c.failOn,
      ];
      for (const [name, level] of Object.entries(policy ?? {})) {
        args.push("--severity", `${name}=${level}`);
      }
      if (baseline) {
        const file = join(dir, `baseline-${cases.indexOf(c)}.json`);
        writeFileSync(file, JSON.stringify(baseline));
        args.push(`--baseline=${file}`);
      }
      const cli = await runCli(args, dir);
      const verdict = await runGate(libraryContext(url), defaultChecks, {
        ...(policy ? { policy } : {}),
        ...(baseline ? { baseline } : {}),
        failOn: c.failOn,
      });

      assert.ok(cli.stdout.length > 0, `${label}: ${cli.stderr}`);
      const envelope = JSON.parse(cli.stdout);
      assert.equal(envelope.ok, verdict.ok, label);
      assert.deepEqual(
        envelope.runs[0].report,
        JSON.parse(JSON.stringify(verdict.report)),
        label,
      );
      assert.equal(cli.status, verdict.ok ? 0 : 1, `${label}: ${cli.stderr}`);
      seen[verdict.ok ? "ok" : "notOk"] += 1;
      seen.baselined += verdict.baselined;
      seen.expired += verdict.expired;
    });
    // The matrix exercises both outcomes and both baseline paths.
    assert.ok(seen.ok > 0 && seen.notOk > 0, JSON.stringify(seen));
    assert.ok(seen.baselined > 0 && seen.expired > 0, JSON.stringify(seen));
  } finally {
    for (const i of Object.values(instances)) i.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
