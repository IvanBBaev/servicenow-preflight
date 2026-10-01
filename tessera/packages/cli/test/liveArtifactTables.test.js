// `tess run --live` enumerates every script-bearing table, and a table that
// will not answer in full can never let the run say GO (wave 13).
//
// Before wave 13 the live run enumerated `sys_script_include` alone, so a
// Business Rule or a UI Action in the scope under test was invisible to the
// gate, and a 403 there was the whole resolution failing (exit 3). The live
// enumeration now reads every table `scriptsApi.SCRIPT_TYPES` names. Per
// table, fail-closed:
//
//   * a refusal (403, a namespace 404 for this caller, ACL-trimmed rows, a
//     truncated read) → INCONCLUSIVE, exit 5, the table named in the warning,
//     the human report and the persisted `--json` record;
//   * any other undecidable read (transport error, 5xx) → a fault, exit 3;
//   * every table refused → nothing about the scope is known → a fault, exit 3.
//
// All against `@tessera/fake-instance`, with faults injected per table through
// its public API; the unit half drives the classifying reader directly.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createFakeInstance,
  W2_AUTHORING_CHANNEL_ACL_RULES,
  W2_AUTHORING_ROLE,
} from "@tessera/fake-instance";
import { createAtfExecutionEngine } from "@tessera/phase05";
import { createSnRecordReader, ResolutionFaultError } from "@tessera/resolvers";
import { reloadCredentialsFromEnv, scriptsApi } from "@tessera/sn-client";
import { createTemplateProvider } from "@tessera/generate";
import {
  AUTHORING_CHANNEL_VERSION,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
} from "@tessera/teststore-atf";

import {
  commandHelp,
  createRealRegistries,
  EXIT_CODES,
  main,
} from "../build/index.js";
import {
  createClassifyingReader,
  formatRefusedLookups,
  formatRefusedTables,
  isRefusal,
  LIVE_ARTIFACT_TABLES,
} from "../build/liveArtifactTables.js";

const tempRoots = [];
after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const hex = (prefix) => prefix.padEnd(32, "0");

const RUNNER_HOST = "dev-tables.service-now.com";
const SCOPE_NAME = "x_tessera_tables";
const SCOPE_ID = hex("5c0bf");
const TARGET_ID = hex("a11cf");
const TARGET_NAME = "TableDiscount";
const SOURCE = [
  "var TableDiscount = Class.create();",
  "TableDiscount.prototype = {",
  "  apply: function (units, price) {",
  "    var total = units * price;",
  "    if (units >= 100) total = total * 0.9;",
  "    return total;",
  "  },",
  "  type: 'TableDiscount'",
  "};",
].join("\n");
const SPEC_PATH = `${SCOPE_NAME}/sys_script_include/${TARGET_NAME}/${TARGET_NAME}.unit.ts`;
const BODY = `(function (outputs, steps, params, stepResult, assertEqual) {
  var d = new TableDiscount();
  assertEqual({ name: "the threshold itself discounts", shouldbe: 900, value: d.apply(100, 10) });
})(outputs, steps, params, stepResult, assertEqual);
`;
const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH",
  "SN_DOCS_DIR",
  "SN_MAX_RETRIES",
  "SN_READONLY",
  "SN_ACTIVE_PROFILE",
  "SN_ALLOWED_HOSTS",
  "SN_HOST_POLICY",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
  "SN_PROFILE_RUNNER_INSTANCE",
  "SN_PROFILE_RUNNER_USER",
  "SN_PROFILE_RUNNER_PASSWORD",
];

const NAMESPACE_404 = {
  kind: "http-error",
  status: 404,
  body: {
    error: {
      message: "Requested URI does not represent any resource",
      detail: null,
    },
    status: "failure",
  },
};

async function writeTestsRoot(root) {
  const testsRoot = path.join(root, "tests");
  const file = path.join(testsRoot, SPEC_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, BODY);
  await fs.writeFile(
    path.join(testsRoot, ".manifest.json"),
    JSON.stringify({
      version: 1,
      specs: [
        {
          id: `sys_script_include/${TARGET_ID}`,
          path: SPEC_PATH,
          kind: "unit",
          targets: [
            {
              table: "sys_script_include",
              sysId: TARGET_ID,
              name: TARGET_NAME,
            },
          ],
        },
      ],
    }),
  );
  return testsRoot;
}

/**
 * One live run over a scope holding a single, tested Script Include.
 *
 * @param {{
 *   faults?: readonly { table: string, mode: object }[],
 *   json: boolean,
 *   tag: string,
 * }} options  Each fault fires ONCE, on the first GET of its table. The
 *   resolve stage is the first stage of the run and the scope adapter's
 *   enumeration is the first read of every artifact table, so exactly the
 *   resolver is hit; `SN_MAX_RETRIES=0` keeps the transport from retrying it
 *   into a clean answer.
 */
async function liveRun({ faults = [], json, tag }) {
  const fake = createFakeInstance({
    host: RUNNER_HOST,
    state: {
      sys_scope: [
        { sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Tessera Tables" },
      ],
      sys_script_include: [
        {
          sys_id: TARGET_ID,
          name: TARGET_NAME,
          sys_name: TARGET_NAME,
          api_name: `${SCOPE_NAME}.${TARGET_NAME}`,
          sys_scope: SCOPE_ID,
          active: "true",
          script: SOURCE,
        },
      ],
      sys_properties: [
        { name: "sn_atf.runner.enabled", value: "true" },
        { name: "glide.installation.production", value: "false" },
        {
          sys_id: hex("c4a3"),
          name: AUTHORING_CHANNEL_VERSION_PROPERTY,
          value: AUTHORING_CHANNEL_VERSION,
        },
      ],
    },
    acl: { roles: [W2_AUTHORING_ROLE], rules: W2_AUTHORING_CHANNEL_ACL_RULES },
    cicdSuiteParams: ["test_suite_sys_id", "sys_id"],
  });
  for (const fault of faults) {
    fake.faults.add({
      match: { method: "GET", table: fault.table, times: 1 },
      mode: fault.mode,
    });
  }
  const engine = createAtfExecutionEngine(fake);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (new URL(href).host !== RUNNER_HOST) {
      return Promise.reject(new Error(`no fake instance for ${href}`));
    }
    return engine(input, init);
  };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-tables-"));
  tempRoots.push(root);
  const testsRoot = await writeTestsRoot(root);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(root, "sn-docs");
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_RUNNER_INSTANCE = RUNNER_HOST;
  process.env.SN_PROFILE_RUNNER_USER = "tessera";
  process.env.SN_PROFILE_RUNNER_PASSWORD = "tessera";
  reloadCredentialsFromEnv();

  const out = [];
  const err = [];
  let code;
  try {
    code = await main(
      [
        "run",
        "--live",
        "--runner",
        "runner",
        "--scope",
        SCOPE_NAME,
        "--tests-root",
        testsRoot,
        "--allow",
        RUNNER_HOST,
        "--run-id",
        `live-tables-${tag}-${json ? "j" : "h"}`,
        "--run-timeout-ms",
        "30000",
        ...(json ? ["--json"] : []),
      ],
      {
        now: () => new Date("2026-09-28T10:00:00.000Z"),
        actor: "test",
        cwd: root,
        env: {},
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadCredentialsFromEnv();
  }
  const fired = fake.faults.list().reduce((sum, rule) => sum + rule.fired, 0);
  return { code, out: out.join("\n"), err: err.join("\n"), fired };
}

const forbidden = (table) => ({
  table,
  mode: { kind: "http-error", status: 403 },
});

describe("LIVE_ARTIFACT_TABLES", () => {
  it("is exactly the tables scriptsApi.SCRIPT_TYPES names — de-duplicated, sorted", () => {
    const upstream = [
      ...new Set(Object.values(scriptsApi.SCRIPT_TYPES).map((d) => d.table)),
    ].sort();
    assert.deepEqual([...LIVE_ARTIFACT_TABLES], upstream);
    assert.ok(LIVE_ARTIFACT_TABLES.length > 1, "wider than one table");
    assert.ok(LIVE_ARTIFACT_TABLES.includes("sys_script_include"));
    assert.ok(LIVE_ARTIFACT_TABLES.includes("sys_script"));
  });

  it("is what `tess run --help` lists", () => {
    const help = commandHelp("run");
    for (const table of LIVE_ARTIFACT_TABLES) {
      assert.match(help, new RegExp(`\\b${table}\\b`), table);
    }
    assert.match(help, /INCONCLUSIVE \(exit 5\)/);
  });
});

/** A reader stub answering one fixed TableRead for every artifact table. */
function stubReader(answer) {
  const calls = [];
  return {
    calls,
    reader: {
      profile: "src",
      async queryRecords(request) {
        calls.push(request.table);
        return request.table === "sys_scope"
          ? {
              outcome: "undecidable",
              records: [],
              truncated: false,
              detail: "scope stub",
            }
          : answer;
      },
    },
  };
}

describe("createClassifyingReader", () => {
  const request = (table) => ({ table, query: "", fields: ["sys_id"] });

  it("passes a clean answer through and records nothing", async () => {
    const answer = {
      outcome: "answered",
      records: [{ sys_id: hex("1") }],
      truncated: false,
      detail: "ok",
    };
    const { reader } = stubReader(answer);
    const classifying = createClassifyingReader(reader);
    assert.equal(classifying.profile, "src");
    assert.equal(await classifying.queryRecords(request("sys_script")), answer);
    assert.deepEqual(classifying.refused(), []);
  });

  it("leaves reads of tables it does not watch alone (sys_scope)", async () => {
    const { reader } = stubReader({});
    const classifying = createClassifyingReader(reader);
    const read = await classifying.queryRecords(request("sys_scope"));
    assert.equal(read.detail, "scope stub");
    assert.deepEqual(classifying.refused(), []);
  });

  it("records a truncated read, with its reason and count", async () => {
    const { reader } = stubReader({
      outcome: "answered",
      records: [{ sys_id: hex("1") }],
      truncated: true,
      truncationReason: "cap",
      total: 7,
      detail: "partial",
    });
    const classifying = createClassifyingReader(reader);
    await classifying.queryRecords(request("sys_ui_action"));
    assert.deepEqual(classifying.refused(), [
      {
        table: "sys_ui_action",
        reason: "the read was truncated (cap) — 1 row(s) returned of 7",
      },
    ]);
  });

  it("records rows with no addressable sys_id as ACL-trimmed", async () => {
    const { reader } = stubReader({
      outcome: "answered",
      records: [{ sys_id: hex("1") }, { sys_id: "" }, { sys_id: "  " }, {}],
      truncated: false,
      detail: "trimmed",
    });
    const classifying = createClassifyingReader(reader);
    await classifying.queryRecords(request("sys_script"));
    await classifying.queryRecords(request("sys_script"));
    assert.deepEqual(classifying.refused(), [
      {
        table: "sys_script",
        reason: "3 row(s) came back with no readable sys_id (ACL-trimmed)",
      },
    ]);
  });

  it("throws a ResolutionFaultError for an undecidable read that is not a refusal", async () => {
    const { reader } = stubReader({
      outcome: "undecidable",
      records: [],
      truncated: false,
      detail: "`sys_script on src`: no HTTP answer (connection reset)",
    });
    const classifying = createClassifyingReader(reader);
    await assert.rejects(
      classifying.queryRecords(request("sys_script")),
      (error) =>
        error instanceof ResolutionFaultError &&
        /sys_script could not be enumerated \(transport\/infrastructure fault, not a refusal\)/.test(
          error.message,
        ),
    );
    assert.deepEqual(classifying.refused(), []);
  });

  it("classifies the real reader's 403 and namespace-404 wording as refusals, a 500 as a fault", async () => {
    // The wording is `createSnRecordReader`'s; pinning it against the real
    // reader catches upstream drift (which would otherwise fail closed as
    // exit 3, not open).
    const fake = createFakeInstance({
      host: "dev-wording.service-now.com",
      state: { sys_script: [] },
    });
    fake.faults.add({
      match: { method: "GET", table: "sys_script", times: 1 },
      mode: { kind: "http-error", status: 403 },
    });
    fake.faults.add({
      match: { method: "GET", table: "sys_ui_policy", times: 1 },
      mode: NAMESPACE_404,
    });
    fake.faults.add({
      match: { method: "GET", table: "sys_ui_action", times: 1 },
      mode: { kind: "http-error", status: 500 },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake.fetch;
    const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.SN_AUTH = "basic";
    process.env.SN_MAX_RETRIES = "0";
    process.env.SN_PROFILE_SRC_INSTANCE = "dev-wording.service-now.com";
    process.env.SN_PROFILE_SRC_USER = "tessera";
    process.env.SN_PROFILE_SRC_PASSWORD = "tessera";
    reloadCredentialsFromEnv();
    try {
      const reader = createSnRecordReader("src");
      const forbiddenRead = await reader.queryRecords(request("sys_script"));
      const namespaceRead = await reader.queryRecords(request("sys_ui_policy"));
      const serverRead = await reader.queryRecords(request("sys_ui_action"));
      assert.equal(isRefusal(forbiddenRead), true, forbiddenRead.detail);
      assert.equal(isRefusal(namespaceRead), true, namespaceRead.detail);
      assert.equal(serverRead.outcome, "undecidable", serverRead.detail);
      assert.equal(isRefusal(serverRead), false, serverRead.detail);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SN_PROFILE_SRC_INSTANCE;
      delete process.env.SN_PROFILE_SRC_USER;
      delete process.env.SN_PROFILE_SRC_PASSWORD;
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    }
  });

  it("tags a refusal seen by the lookup view as a lookup refusal", async () => {
    const { reader } = stubReader({
      outcome: "undecidable",
      records: [],
      truncated: false,
      detail: "`sys_script on src`: read refused (403) — Insufficient rights",
    });
    const classifying = createClassifyingReader(reader);
    const lookup = classifying.forLookup();
    assert.equal(lookup.profile, "src");
    await lookup.queryRecords(request("sys_script"));
    assert.deepEqual(classifying.refused(), [
      {
        table: "sys_script",
        reason: "`sys_script on src`: read refused (403) — Insufficient rights",
        read: "lookup",
      },
    ]);
    // The enumeration refusing the same table is the broader statement: the
    // entry becomes an enumeration refusal (one entry per table).
    await classifying.queryRecords(request("sys_script"));
    assert.deepEqual(classifying.refused(), [
      {
        table: "sys_script",
        reason: "`sys_script on src`: read refused (403) — Insufficient rights",
      },
    ]);
  });

  it("keeps an enumeration refusal when the lookup is refused afterwards", async () => {
    const { reader } = stubReader({
      outcome: "undecidable",
      records: [],
      truncated: false,
      detail: "`sys_script on src`: read refused (403) — nope",
    });
    const classifying = createClassifyingReader(reader);
    await classifying.queryRecords(request("sys_script"));
    await classifying.forLookup().queryRecords(request("sys_script"));
    assert.deepEqual(classifying.refused(), [
      {
        table: "sys_script",
        reason: "`sys_script on src`: read refused (403) — nope",
      },
    ]);
  });

  it("words a lookup fault as a lookup, not an enumeration", async () => {
    const { reader } = stubReader({
      outcome: "undecidable",
      records: [],
      truncated: false,
      detail: "`sys_script on src`: no HTTP answer (connection reset)",
    });
    const classifying = createClassifyingReader(reader);
    await assert.rejects(
      classifying.forLookup().queryRecords(request("sys_script")),
      (error) =>
        error instanceof ResolutionFaultError &&
        /sys_script could not be read by the impact lookup \(transport\/infrastructure fault, not a refusal\)/.test(
          error.message,
        ),
    );
    assert.deepEqual(classifying.refused(), []);
  });

  it("formats lookup refusals apart from the enumeration's", () => {
    const refused = [
      { table: "sys_ui_action", reason: "r2" },
      { table: "sys_script", reason: "r1", read: "lookup" },
    ];
    assert.equal(
      formatRefusedTables(refused, 9),
      "live artifact enumeration is incomplete — 1 of 9 table(s) refused, so the verdict cannot be GO: sys_ui_action (r2)",
    );
    assert.equal(
      formatRefusedLookups(refused),
      "impact lookup is incomplete — 1 table(s) refused the impact analysis's lookup read (not the enumeration), so the verdict cannot be GO: sys_script (r1)",
    );
    assert.equal(formatRefusedTables([refused[1]], 9), undefined);
    assert.equal(formatRefusedLookups([refused[0]]), undefined);
  });

  it("formats the refused tables into one warning line", () => {
    assert.equal(
      formatRefusedTables(
        [
          { table: "sys_script", reason: "r1" },
          { table: "sys_ui_action", reason: "r2" },
        ],
        9,
      ),
      "live artifact enumeration is incomplete — 2 of 9 table(s) refused, so the verdict cannot be GO: sys_script (r1); sys_ui_action (r2)",
    );
  });
});

describe("createRealRegistries scopeReader", () => {
  it("refuses a scope reader bound to a profile other than the source (ARCH-19)", () => {
    const options = {
      sourceProfile: "no_such_source_profile",
      runnerProfile: "no_such_runner_profile",
      scope: "x_test_app",
      testsRoot: "/nonexistent/tests",
      provider: createTemplateProvider(),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      console: () => {},
      writeJson: () => {},
      writeJUnit: () => {},
      lockPath: path.join(os.tmpdir(), "tessera-tables-never-taken.lock"),
    };
    assert.throws(
      () =>
        createRealRegistries({
          ...options,
          scopeReader: { profile: "elsewhere", queryRecords: async () => ({}) },
        }),
      /scopeReader is bound to profile "elsewhere", not the source profile "no_such_source_profile"/,
    );
    assert.doesNotThrow(() =>
      createRealRegistries({
        ...options,
        scopeReader: {
          profile: "no_such_source_profile",
          queryRecords: async () => ({}),
        },
      }),
    );
  });
});

describe("tess run --live over the widened artifact enumeration", () => {
  it("all tables readable: GO, exit 0, a token, and nothing refused", async () => {
    const run = await liveRun({ json: true, tag: "clean" });
    const doc = JSON.parse(run.out);
    assert.equal(doc.verdict.status, "GO", `${run.err}\n${run.out}`);
    assert.equal(run.code, EXIT_CODES.ok);
    assert.ok(doc.verdict.confirmToken, "a GO mints its token");
    assert.equal(doc.artifactTablesRefused, undefined);
    assert.doesNotMatch(run.err, /artifact enumeration is incomplete/);
  });

  for (const table of LIVE_ARTIFACT_TABLES) {
    it(`a 403 on ${table} alone: INCONCLUSIVE, exit 5, the table named`, async () => {
      const run = await liveRun({
        faults: [forbidden(table)],
        json: true,
        tag: `403-${table}`,
      });
      assert.equal(run.fired, 1, "the 403 was served to the resolver");
      const doc = JSON.parse(run.out);
      assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
      assert.equal(doc.exitCode, EXIT_CODES.inconclusive);
      assert.equal(doc.verdict.status, "INCONCLUSIVE");
      assert.equal(doc.verdict.confirmToken, undefined);
      assert.equal(doc.artifactTablesRefused.length, 1);
      assert.equal(doc.artifactTablesRefused[0].table, table);
      assert.match(doc.artifactTablesRefused[0].reason, /read refused \(403\)/);
      assert.match(
        run.err,
        new RegExp(
          `warning: live artifact enumeration is incomplete — 1 of ${LIVE_ARTIFACT_TABLES.length} table\\(s\\) refused, so the verdict cannot be GO: ${table} \\(`,
        ),
        run.err,
      );
    });
  }

  it("human: the report names the refused table and says INCONCLUSIVE, exit 5", async () => {
    const run = await liveRun({
      faults: [forbidden("sys_ui_action")],
      json: false,
      tag: "403-human",
    });
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.out}\n${run.err}`);
    assert.match(run.out, /VERDICT: INCONCLUSIVE/, run.out);
    assert.doesNotMatch(run.out, /VERDICT: GO/, run.out);
    assert.match(
      run.out,
      /artifacts: INCOMPLETE — 1 artifact table\(s\) not read in full; the verdict cannot be GO\n {4}- sys_ui_action: .*read refused \(403\)/,
      run.out,
    );
    assert.match(run.out, /exit: 5/, run.out);
  });

  it("two refusals, one a namespace 404: both named, INCONCLUSIVE, exit 5", async () => {
    const run = await liveRun({
      faults: [
        forbidden("sys_script"),
        { table: "sys_transform_script", mode: NAMESPACE_404 },
      ],
      json: true,
      tag: "two",
    });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "INCONCLUSIVE");
    assert.deepEqual(
      doc.artifactTablesRefused.map((entry) => entry.table),
      ["sys_script", "sys_transform_script"],
    );
    assert.match(
      doc.artifactTablesRefused[1].reason,
      /not a resource on this instance for the connected user/,
    );
  });

  it("every table refused: nothing about the scope is known — a fault, exit 3", async () => {
    const run = await liveRun({
      faults: LIVE_ARTIFACT_TABLES.map(forbidden),
      json: true,
      tag: "all",
    });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.fault, `${run.err}\n${run.out}`);
    assert.notEqual(doc.verdict?.status, "GO");
    assert.equal(doc.verdict?.confirmToken, undefined);
  });

  it("a transport error on one table is a fault, exit 3 — never softened to INCONCLUSIVE", async () => {
    const run = await liveRun({
      faults: [{ table: "sys_script", mode: { kind: "transport-error" } }],
      json: true,
      tag: "transport",
    });
    assert.equal(run.fired, 1);
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.fault, `${run.err}\n${run.out}`);
    assert.notEqual(doc.verdict?.status, "GO");
    assert.match(
      `${run.out}\n${run.err}`,
      /sys_script could not be enumerated \(transport\/infrastructure fault, not a refusal\)/,
    );
  });

  it("a 500 on one table is a fault, exit 3", async () => {
    const run = await liveRun({
      faults: [
        { table: "sys_ui_action", mode: { kind: "http-error", status: 500 } },
      ],
      json: true,
      tag: "500",
    });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.fault, `${run.err}\n${run.out}`);
    assert.notEqual(doc.verdict?.status, "GO");
  });
});
