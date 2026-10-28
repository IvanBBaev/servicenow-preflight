import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runPreflight } from "../build/index.js";
import { defaultChecks } from "../build/checks/index.js";
import {
  BASIC_AUTH_PROPERTIES,
  BASIC_AUTH_ROLE,
  doctorChecks,
  tablesOf,
} from "../build/doctor.js";
import { createFakeSnClient } from "../build/http/fake.js";
import { SnAuthError } from "../build/http/client.js";
import { reportOf } from "./helpers/json-report.js";

const INSTANCE = "https://dev12345.service-now.com";
const BASIC = { kind: "basic", user: "ci.user", pass: "secret" };
const USER_ID = "0123456789abcdef0123456789abcdef";
const ROLE_ROW = "fedcba9876543210fedcba9876543210";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);

/** Restriction properties as an instance with enforcement switched on has them. */
function restrictionOn() {
  return [
    { sys_id: "p1", name: BASIC_AUTH_PROPERTIES.active, value: "true" },
    { sys_id: "p2", name: BASIC_AUTH_PROPERTIES.enforce, value: "false" },
    {
      sys_id: "p3",
      name: BASIC_AUTH_PROPERTIES.enforcementDate,
      value: "2027-01-01",
    },
  ];
}

/**
 * Wrap a client so every call is recorded as "METHOD what" and selected
 * tables answer HTTP 403 the way the real client raises it.
 */
function recording(http, { forbidden = [] } = {}) {
  const calls = [];
  const deny = new Set(forbidden);
  return {
    calls,
    client: {
      table(name) {
        const inner = http.table(name);
        return new Proxy(inner, {
          get(target, prop) {
            const value = target[prop];
            if (typeof value !== "function") return value;
            return (...args) => {
              const read = ["get", "query", "queryWithMeta"].includes(prop);
              calls.push(`${read ? "GET" : String(prop)} ${name}`);
              if (deny.has(name)) {
                return Promise.reject(
                  new SnAuthError(`Forbidden reading ${name}`, 403),
                );
              }
              return value.apply(target, args);
            };
          },
        });
      },
      get cicd() {
        calls.push("POST cicd");
        return http.cicd;
      },
      request(method, path, opts) {
        calls.push(`${method} ${path}`);
        return http.request(method, path, opts);
      },
    },
  };
}

async function doctor({
  http,
  auth = BASIC,
  instanceUrl = INSTANCE,
  selected = defaultChecks,
  forbidden,
  nodeVersion,
}) {
  const rec = recording(http, { forbidden });
  const checks = doctorChecks({
    selected,
    version: "9.9.9",
    instanceSource: "flag",
    lookup: async () => ({ address: "127.0.0.1", family: 4 }),
    env: {},
    ...(nodeVersion ? { nodeVersion } : {}),
  });
  const report = await runPreflight(
    {
      instanceUrl,
      ...(auth ? { auth } : {}),
      http: rec.client,
    },
    checks,
  );
  const row = (name) => report.results.find((r) => r.name === name);
  return { report, row, calls: rec.calls };
}

function account({ webServiceOnly = false } = {}) {
  return [
    {
      sys_id: USER_ID,
      user_name: "ci.user",
      web_service_access_only: webServiceOnly,
    },
  ];
}

test("doctor warns with remediation when enforcement is on and the basic account lacks the role", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_properties: restrictionOn(),
      sys_user: account(),
      sys_user_has_role: [],
    },
  });
  const { report, row } = await doctor({ http });
  const basic = row("doctor-basic-auth");
  assert.equal(basic.status, "warn");
  assert.match(basic.message, /will be enforced on 2027-01-01/);
  assert.match(
    basic.message,
    new RegExp(`Grant the account the ${BASIC_AUTH_ROLE}`),
  );
  const acct = row("doctor-account");
  assert.equal(acct.status, "warn");
  assert.match(acct.message, /Web Service Access Only/);
  assert.match(acct.message, /Grant/);
  // A warn is not a failure: the doctor still exits 0.
  assert.equal(report.ok, true);
});

test("doctor passes the basic-auth and account rows when the role is present", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_properties: restrictionOn(),
      sys_user: account(),
      sys_user_has_role: [{ sys_id: ROLE_ROW }],
    },
  });
  const { row } = await doctor({ http });
  assert.equal(row("doctor-basic-auth").status, "pass");
  assert.match(row("doctor-basic-auth").message, /stays allowed/);
  assert.equal(row("doctor-account").status, "pass");
  assert.match(row("doctor-account").message, new RegExp(BASIC_AUTH_ROLE));
});

test("doctor treats a Web Service Access Only account as exempt", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_properties: restrictionOn(),
      sys_user: account({ webServiceOnly: true }),
      sys_user_has_role: [],
    },
  });
  const { row } = await doctor({ http });
  assert.equal(row("doctor-basic-auth").status, "pass");
  assert.equal(row("doctor-account").status, "pass");
});

test("doctor warns (never fails) when sys_properties cannot be read", async () => {
  const http = createFakeSnClient({
    tables: { sys_user: account(), sys_user_has_role: [] },
  });
  const { row, report } = await doctor({
    http,
    forbidden: ["sys_properties"],
  });
  const basic = row("doctor-basic-auth");
  assert.equal(basic.status, "warn");
  assert.match(basic.message, /Cannot read sys_properties \(HTTP 403\)/);
  assert.match(basic.message, /ask an admin to confirm/);
  assert.equal(report.ok, true);
});

test("doctor warns with 'ask an admin' when the role table cannot be read", async () => {
  const http = createFakeSnClient({
    tables: { sys_properties: restrictionOn(), sys_user: account() },
  });
  const { row } = await doctor({ http, forbidden: ["sys_user_has_role"] });
  assert.equal(row("doctor-account").status, "warn");
  assert.match(row("doctor-account").message, /ask an admin to confirm/);
  assert.equal(row("doctor-basic-auth").status, "warn");
});

test("doctor names the checks a refused table affects", async () => {
  const http = createFakeSnClient({ tables: { sys_user: account() } });
  const readers = tablesOf(defaultChecks).get("sys_update_set");
  assert.ok(readers && readers.length > 0);
  const { row } = await doctor({ http, forbidden: ["sys_update_set"] });
  const access = row("doctor-table-access");
  assert.equal(access.status, "warn");
  assert.match(access.message, /HTTP 403/);
  assert.ok(
    access.message.includes(`sys_update_set (${readers.join(", ")})`),
    access.message,
  );
  assert.match(access.message, /--skip/);
});

test("doctor passes table access when every selected table reads", async () => {
  const http = createFakeSnClient({ tables: { sys_user: account() } });
  const { row } = await doctor({ http });
  assert.equal(row("doctor-table-access").status, "pass");
});

test("doctor only sends GET requests", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_properties: restrictionOn(),
      sys_user: account(),
      sys_user_has_role: [],
    },
  });
  const { calls } = await doctor({ http });
  assert.ok(calls.length > 0);
  for (const call of calls) assert.match(call, /^GET /);
  // One probe per selected table, plus the sys_properties / account reads.
  assert.ok(calls.includes("GET sys_user_has_role"));
  assert.ok(calls.includes("GET sys_properties"));
});

test("doctor finishes in under a second on the fake with every row warning carrying a remediation", async () => {
  const http = createFakeSnClient({
    tables: { sys_properties: restrictionOn(), sys_user: account() },
  });
  const started = performance.now();
  const { report } = await doctor({
    http,
    forbidden: ["sys_user_has_role", "sys_update_set"],
    nodeVersion: "18.19.0",
  });
  assert.ok(performance.now() - started < 1000);
  const warns = report.results.filter((r) => r.status === "warn");
  assert.ok(warns.length >= 3);
  for (const w of warns) {
    assert.match(
      w.message,
      /\b(Grant|ask an admin|Activate|Upgrade|Use https|Pass --instance|skip)\b/,
      `${w.name}: ${w.message}`,
    );
  }
});

test("doctor reports the runtime and passes non-basic auth rows as not applicable", async () => {
  const http = createFakeSnClient({ tables: { sys_user: account() } });
  const { row } = await doctor({
    http,
    auth: { kind: "oauth", token: "t" },
    nodeVersion: "22.1.0",
  });
  assert.equal(row("doctor-runtime").status, "pass");
  assert.match(
    row("doctor-runtime").message,
    /Node 22\.1\.0; servicenow-preflight 9\.9\.9/,
  );
  assert.equal(row("doctor-basic-auth").status, "pass");
  assert.equal(row("doctor-account").status, "pass");
  assert.match(row("doctor-account").message, /Not applicable/);
});

test("doctor without an instance fails the config row and skips the network rows", async () => {
  const http = createFakeSnClient();
  const { report, row, calls } = await doctor({ http, instanceUrl: "" });
  assert.equal(report.ok, false);
  assert.equal(row("doctor-config").status, "fail");
  for (const name of [
    "doctor-reachability",
    "connectivity-auth",
    "doctor-basic-auth",
    "doctor-account",
    "doctor-table-access",
  ]) {
    assert.equal(row(name).status, "warn", name);
    assert.match(row(name).message, /Skipped: no instance URL/);
  }
  assert.deepEqual(calls, []);
});

test("doctor fails reachability when the host does not resolve", async () => {
  const checks = doctorChecks({
    selected: [],
    version: "1",
    env: {},
    lookup: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });
  const reach = checks.find((c) => c.name === "doctor-reachability");
  const result = await reach.run({
    instanceUrl: INSTANCE,
    http: createFakeSnClient(),
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /Cannot resolve dev12345\.service-now\.com/);
});

test("doctor probes the CI/CD API only when atf-run is selected", async () => {
  const atf = defaultChecks.filter((c) => c.name === "atf-run");
  assert.equal(atf.length, 1);
  const probe = "GET /api/sn_cicd/progress/00000000000000000000000000000000";

  const off = await doctor({
    http: createFakeSnClient({ tables: { sys_user: account() } }),
    selected: defaultChecks.filter((c) => c.name !== "atf-run"),
  });
  assert.equal(off.row("doctor-cicd").status, "pass");
  assert.ok(!off.calls.includes(probe));

  const missing = await doctor({
    http: createFakeSnClient({ tables: { sys_user: account() } }),
    selected: atf,
  });
  assert.equal(missing.row("doctor-cicd").status, "warn");
  assert.match(
    missing.row("doctor-cicd").message,
    /com\.glide\.continuousdelivery/,
  );
  assert.ok(missing.calls.includes(probe));

  const answers = await doctor({
    http: createFakeSnClient({
      tables: { sys_user: account() },
      requests: {
        [probe]: {
          status: 404,
          body: { error: { message: "No record found" } },
        },
      },
    }),
    selected: atf,
  });
  assert.equal(answers.row("doctor-cicd").status, "pass");

  const refused = await doctor({
    http: createFakeSnClient({
      tables: { sys_user: account() },
      requests: { [probe]: { status: 403, body: null } },
    }),
    selected: atf,
  });
  assert.equal(refused.row("doctor-cicd").status, "warn");
  assert.match(
    refused.row("doctor-cicd").message,
    /sn_cicd\.sys_ci_automation/,
  );
});

// --- CLI ------------------------------------------------------------------

function runCliAsync(args, { cwd, env } = {}) {
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith("SNPF_")) delete cleanEnv[key];
  }
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: cwd ?? tmpdir(),
    env: { ...cleanEnv, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** A Table API stub that records every request method. */
async function startInstance(tables) {
  const methods = [];
  const server = createHttpServer((req, res) => {
    methods.push(req.method);
    const url = new URL(req.url, "http://127.0.0.1");
    const table = url.pathname.replace("/api/now/table/", "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: tables[table] ?? [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    methods,
    async stop() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

test("CLI doctor --json prints a well-formed envelope and makes only GETs", async () => {
  const instance = await startInstance({
    sys_properties: restrictionOn(),
    sys_user: account(),
    sys_user_has_role: [{ sys_id: ROLE_ROW }],
  });
  try {
    const res = await runCliAsync(
      ["doctor", "-i", instance.url, "--only", "update-set-state", "--json"],
      { env: { SNPF_USER: "ci.user", SNPF_PASS: "secret" } },
    );
    assert.equal(res.status, 0, res.stderr);
    const report = reportOf(res.stdout);
    assert.deepEqual(
      report.results.map((r) => r.name),
      [
        "doctor-config",
        "doctor-reachability",
        "connectivity-auth",
        "doctor-basic-auth",
        "doctor-account",
        "doctor-table-access",
        "doctor-cicd",
        "doctor-runtime",
      ],
    );
    const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
    assert.equal(byName["doctor-config"].status, "pass");
    assert.match(byName["doctor-config"].message, /from --instance/);
    assert.equal(byName["connectivity-auth"].status, "pass");
    assert.equal(byName["doctor-account"].status, "pass");
    // Plain http is reachable but flagged.
    assert.equal(byName["doctor-reachability"].status, "warn");
    assert.ok(instance.methods.length > 0);
    assert.ok(
      instance.methods.every((m) => m === "GET"),
      instance.methods,
    );
  } finally {
    await instance.stop();
  }
});

test("CLI doctor exits 1 without an instance URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-doctor-"));
  try {
    const res = await runCliAsync(["doctor", "--json"], { cwd: dir });
    assert.equal(res.status, 1, res.stderr);
    const report = reportOf(res.stdout);
    assert.equal(
      report.results.find((r) => r.name === "doctor-config").status,
      "fail",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI doctor rejects init-only flags and --all", async () => {
  const flag = await runCliAsync(["doctor", "--check"]);
  assert.equal(flag.status, 2);
  const all = await runCliAsync(["doctor", "--all"]);
  assert.equal(all.status, 2);
  assert.match(all.stderr, /doctor checks one instance/);
});

test("CLI init --check runs doctor against the scaffolded config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-init-check-"));
  const instance = await startInstance({ sys_user: account() });
  try {
    writeFileSync(join(dir, ".keep"), "");
    const res = await runCliAsync(
      ["init", "--yes", "--instance", instance.url, "--check"],
      { cwd: dir, env: { SNPF_USER: "ci.user", SNPF_PASS: "secret" } },
    );
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /Created preflight\.config\.json/);
    assert.match(res.stdout, /servicenow-preflight doctor\n/);
    assert.match(
      res.stdout,
      /✓ doctor-config: Instance http:\/\/127\.0\.0\.1:\d+ from the config file/,
    );
    assert.match(res.stdout, /✓ connectivity-auth/);
  } finally {
    await instance.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
