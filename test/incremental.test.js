import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  changedTables,
  declaredTables,
  INCREMENTAL_ROW,
  planIncremental,
  selectByTables,
  STATE_TABLES,
  tableOfUpdateName,
  updatedSinceClause,
} from "../build/incremental.js";
import { defaultChecks } from "../build/checks/index.js";
import { createFakeSnClient } from "../build/http/fake.js";
import { SnTruncationError } from "../build/http/client.js";
import { reportOf } from "./helpers/json-report.js";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);
const SET = "0123456789abcdef0123456789abcdef";
const CHILD = "11111111111111111111111111111111";
const GRANDCHILD = "22222222222222222222222222222222";
const SCOPE_ID = "33333333333333333333333333333333";
const HEX = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2026-10-29T12:00:00Z");
const SINCE = new Date("2026-10-28T12:00:00Z");
const KNOWN = declaredTables(defaultChecks);

const check = (name, meta) => ({ name, meta, run: async () => ({}) });

function ctxOf(tables, extra = {}) {
  const http = createFakeSnClient({
    tables,
    queryFilter(table, rows, params) {
      const query = params?.sysparm_query ?? "";
      if (table === "sys_update_set") {
        return rows.filter((r) => query.includes(r.parent));
      }
      if (table === "sys_update_xml") {
        return rows.filter((r) => query.includes(r.update_set));
      }
      return rows;
    },
  });
  return { instanceUrl: "https://x.service-now.com", http, ...extra };
}

// --- pure helpers -----------------------------------------------------------

test("tableOfUpdateName maps names to the longest known table", () => {
  assert.equal(
    tableOfUpdateName("sys_dictionary_x_app_task_u_notes", KNOWN),
    "sys_dictionary",
  );
  assert.equal(
    tableOfUpdateName(`sys_security_acl_role_${HEX}`, KNOWN),
    "sys_security_acl_role",
  );
  assert.equal(
    tableOfUpdateName(`sys_security_acl_${HEX}`, KNOWN),
    "sys_security_acl",
  );
  assert.equal(
    tableOfUpdateName(`x_custom_table_${HEX}`, KNOWN),
    "x_custom_table",
  );
  assert.equal(tableOfUpdateName("weird", KNOWN), "weird");
});

test("updatedSinceClause is relative and rounds minutes up", () => {
  assert.equal(
    updatedSinceClause(SINCE, NOW),
    "sys_updated_onRELATIVEGE@minute@ago@1440",
  );
  assert.equal(
    updatedSinceClause(new Date(NOW.getTime() - 61_000), NOW),
    "sys_updated_onRELATIVEGE@minute@ago@2",
  );
  assert.equal(
    updatedSinceClause(NOW, NOW),
    "sys_updated_onRELATIVEGE@minute@ago@1",
  );
});

test("every default check declares tables or always runs", () => {
  for (const c of defaultChecks) {
    const tables = c.meta?.tables ?? [];
    assert.ok(
      tables.length > 0 || c.meta?.requires === "ALWAYS",
      `${c.name} declares no tables`,
    );
  }
});

test("selectByTables keeps always/no-table/state checks and changed ones, in order", () => {
  const checks = [
    check("always", { requires: "ALWAYS", tables: ["sys_user"] }),
    check("bare", {}),
    check("journal", { tables: ["sys_update_set"] }),
    check("atf", { tables: ["sys_atf_test_result"] }),
    check("acl", { tables: ["sys_security_acl"] }),
    check("pages", { tables: ["sys_ui_page"] }),
  ];
  const { selected, reasons } = selectByTables(checks, ["sys_security_acl"]);
  assert.deepEqual(
    selected.map((c) => c.name),
    ["always", "bare", "journal", "atf", "acl"],
  );
  assert.deepEqual(Object.fromEntries(reasons), {
    always: "always",
    bare: "no-tables",
    journal: "state",
    atf: "state",
    acl: "changed",
  });
  assert.ok(STATE_TABLES.includes("sys_atf_test_suite_result"));
});

// --- change reads -----------------------------------------------------------

test("changedTables reads the update set and its batched children", async () => {
  const ctx = ctxOf(
    {
      sys_update_set: [
        { sys_id: CHILD, parent: SET },
        { sys_id: GRANDCHILD, parent: CHILD },
      ],
      sys_update_xml: [
        { sys_id: "1", update_set: SET, name: `sys_ui_page_${HEX}` },
        {
          sys_id: "2",
          update_set: GRANDCHILD,
          name: `sys_security_acl_${HEX}`,
        },
        { sys_id: "3", update_set: "other", name: `sysauto_script_${HEX}` },
        { sys_id: "4", update_set: CHILD, name: "" },
      ],
    },
    { updateSetId: SET },
  );
  const change = await changedTables(ctx, SINCE, { known: KNOWN, now: NOW });
  assert.deepEqual(change, {
    tables: ["sys_security_acl", "sys_ui_page"],
    source: "update set",
  });
});

test("changedTables reads sys_metadata for a scope", async () => {
  const seen = [];
  const http = createFakeSnClient({
    tables: {
      sys_scope: [{ sys_id: SCOPE_ID, scope: "x_app" }],
      sys_metadata: [
        { sys_id: "1", sys_class_name: "sys_script_include" },
        { sys_id: "2", sys_class_name: "sys_script_include" },
        { sys_id: "3", sys_class_name: "sp_widget" },
      ],
    },
    queryFilter(table, rows, params) {
      seen.push([table, params?.sysparm_query]);
      return rows;
    },
  });
  const change = await changedTables(
    { instanceUrl: "https://x", http, scope: "x_app" },
    SINCE,
    { known: KNOWN, now: NOW },
  );
  assert.deepEqual(change, {
    tables: ["sp_widget", "sys_script_include"],
    source: "scope",
  });
  const metadata = seen.find(([t]) => t === "sys_metadata");
  assert.match(metadata[1], new RegExp(`sys_scope=${SCOPE_ID}`));
  assert.match(metadata[1], /RELATIVEGE@minute@ago@1440/);
});

test("changedTables flags a truncated read and needs a source", async () => {
  const http = {
    table: () => ({
      query: async () => {
        throw new SnTruncationError("cap", 10);
      },
    }),
  };
  const change = await changedTables(
    { instanceUrl: "https://x", http, updateSetId: SET },
    SINCE,
    { known: KNOWN },
  );
  assert.equal(change.truncated, true);
  assert.equal(change.source, "update set");
  await assert.rejects(
    changedTables({ instanceUrl: "https://x", http }, SINCE, { known: KNOWN }),
    /needs an update set/,
  );
  const failing = {
    table: () => ({
      query: async () => {
        throw new Error("boom");
      },
    }),
  };
  await assert.rejects(
    changedTables(
      { instanceUrl: "https://x", http: failing, scope: "x" },
      SINCE,
      {
        known: KNOWN,
      },
    ),
    /boom/,
  );
});

test("changedTables rejects a malformed update set id", async () => {
  await assert.rejects(
    changedTables(ctxOf({}, { updateSetId: "a^ORb" }), SINCE, { known: KNOWN }),
  );
});

// --- planning ---------------------------------------------------------------

test("planIncremental skips checks whose tables did not change", async () => {
  const ctx = ctxOf(
    {
      sys_update_xml: [
        { sys_id: "1", update_set: SET, name: `sys_ui_page_${HEX}` },
      ],
    },
    { updateSetId: SET },
  );
  const plan = await planIncremental(ctx, defaultChecks, SINCE, {
    known: KNOWN,
    now: NOW,
    label: "dev",
  });
  assert.equal(plan.empty, false);
  assert.equal(plan.row, undefined);
  for (const kept of [
    "instance-url-configured",
    "connectivity-auth",
    "update-set-state",
    "default-set-leakage",
    "atf-run",
    "ui-page-acl",
  ]) {
    assert.ok(!plan.skip.includes(kept), `${kept} must run`);
  }
  assert.ok(plan.skip.includes("deprecated-apis"));
  assert.ok(plan.skip.includes("table-namespace"));
  assert.match(
    plan.preamble,
    /^Incremental \(dev\): \d+ of 30 checks selected \(changed tables: sys_ui_page\)\.$/,
  );
});

test("planIncremental with no changes keeps the always-run checks and warns", async () => {
  const ctx = ctxOf({ sys_update_xml: [] }, { updateSetId: SET });
  const plan = await planIncremental(ctx, defaultChecks, SINCE, {
    known: KNOWN,
    now: NOW,
  });
  assert.equal(plan.empty, false);
  assert.equal(plan.row.name, INCREMENTAL_ROW);
  assert.equal(plan.row.status, "warn");
  assert.equal(plan.row.kind, "runner");
  assert.match(plan.row.message, /only the checks that always run/);
  assert.match(
    plan.preamble,
    /no changes since 2026-10-28T12:00:00\.000Z in the update set/,
  );
  assert.ok(plan.skip.includes("ui-page-acl"));
});

test("planIncremental reports when nothing is left to run", async () => {
  const pages = [check("pages", { tables: ["sys_ui_page"] })];
  const none = await planIncremental(
    ctxOf({ sys_update_xml: [] }, { updateSetId: SET }),
    pages,
    SINCE,
    { known: KNOWN, now: NOW },
  );
  assert.equal(none.empty, true);
  assert.match(none.row.message, /nothing ran/);

  const other = await planIncremental(
    ctxOf(
      {
        sys_update_xml: [
          { sys_id: "1", update_set: SET, name: `sys_script_${HEX}` },
        ],
      },
      { updateSetId: SET },
    ),
    pages,
    SINCE,
    { known: KNOWN, now: NOW },
  );
  assert.equal(other.empty, true);
  assert.match(
    other.row.message,
    /No selected check reads the tables .*sys_script/,
  );

  const empty = await planIncremental(
    ctxOf({ sys_update_xml: [] }, { updateSetId: SET }),
    [],
    SINCE,
    { known: KNOWN, now: NOW },
  );
  assert.equal(empty.empty, false);
});

test("planIncremental runs everything when the change read is truncated", async () => {
  const http = {
    table: () => ({
      query: async () => {
        throw new SnTruncationError("cap", 10);
      },
    }),
  };
  const plan = await planIncremental(
    { instanceUrl: "https://x", http, scope: "x_app" },
    defaultChecks,
    SINCE,
    { known: KNOWN, label: "dev" },
  );
  assert.deepEqual(plan.skip, []);
  assert.equal(plan.empty, false);
  assert.match(plan.preamble, /row cap; running all 30 checks/);
});

// --- CLI --------------------------------------------------------------------

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
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const CREDS = { SNPF_USER: "ci.user", SNPF_PASS: "secret" };

test("CLI rejects a bad --changed-since with exit 2", async () => {
  const cases = [
    [["--changed-since", "HEAD~3"], /Invalid --changed-since "HEAD~3"/],
    [["--changed-since=2999-01-01"], /lies in the future/],
    [
      ["--changed-since", "1d", "--write-baseline", "b.json"],
      /cannot be combined/,
    ],
  ];
  for (const [flags, pattern] of cases) {
    const res = await runCliAsync(
      ["-i", "https://x.service-now.com", ...flags],
      {
        env: CREDS,
      },
    );
    assert.equal(res.status, 2, `${flags.join(" ")}: ${res.stderr}`);
    assert.match(res.stderr, pattern);
  }
});

test("CLI --changed-since needs an update set or a scope", async () => {
  const res = await runCliAsync(
    ["-i", "http://127.0.0.1:9", "--changed-since", "7d"],
    { env: CREDS },
  );
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /needs an update set/);
});

async function startInstance(tables) {
  const paths = [];
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const table = url.pathname.replace("/api/now/table/", "");
    paths.push(table);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: tables[table] ?? [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    async stop() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

test("CLI --changed-since runs only the checks for the changed tables", async () => {
  const instance = await startInstance({
    sys_scope: [{ sys_id: SCOPE_ID, scope: "x_app" }],
    sys_metadata: [{ sys_id: "1", sys_class_name: "sys_ui_page" }],
  });
  const dir = mkdtempSync(join(tmpdir(), "snpf-incr-"));
  try {
    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ scope: "x_app" }),
    );
    const res = await runCliAsync(
      [
        "-i",
        instance.url,
        "--only",
        "ui-page-acl,table-namespace,instance-url-configured",
        "--changed-since",
        "2026-10-01",
        "--json",
      ],
      { cwd: dir, env: CREDS },
    );
    assert.match(
      res.stderr,
      /Incremental: 2 of 3 checks selected \(changed tables: sys_ui_page\)/,
    );
    const names = reportOf(res.stdout).results.map((r) => r.name);
    assert.ok(names.includes("ui-page-acl"), names.join());
    assert.ok(names.includes("instance-url-configured"), names.join());
    assert.ok(!names.includes("table-namespace"), names.join());
    assert.ok(instance.paths.includes("sys_metadata"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await instance.stop();
  }
});

test("CLI --changed-since with nothing to run reports a warn row", async () => {
  const instance = await startInstance({
    sys_scope: [{ sys_id: SCOPE_ID, scope: "x_app" }],
    sys_metadata: [{ sys_id: "1", sys_class_name: "sys_script" }],
  });
  const dir = mkdtempSync(join(tmpdir(), "snpf-incr-"));
  try {
    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ scope: "x_app" }),
    );
    const res = await runCliAsync(
      [
        "-i",
        instance.url,
        "--only",
        "ui-page-acl",
        "--changed-since",
        "3d",
        "--json",
      ],
      { cwd: dir, env: CREDS },
    );
    assert.equal(res.status, 0, res.stderr);
    const report = reportOf(res.stdout);
    assert.deepEqual(
      report.results.map((r) => [r.name, r.status]),
      [[INCREMENTAL_ROW, "warn"]],
    );
    assert.ok(!instance.paths.includes("sys_ui_page"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await instance.stop();
  }
});
