// `tess run --live` carries the spec inventory's `incomplete` flag.
//
// `loadLiveSpecs` returned `incomplete`, and `runLive` dropped it: a live run
// over an inventory that could not be fully read printed and persisted exactly
// what a run over a complete one did, and returned GO (exit 0) whenever no
// dropped spec was demanded by the impact analysis. `runPipeline` now takes
// `inventoryIncomplete` and never yields GO over a partial inventory (it is
// downgraded to INCONCLUSIVE, exit 5); this file pins that end to end, the
// flag in the persisted record, the `--json` document and the human report,
// and the one `loadLiveSpecs` branch that dropped a spec without saying the
// inventory was incomplete (a non-unit spec is not projected).

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
import { reloadCredentialsFromEnv } from "@tessera/sn-client";
import {
  AUTHORING_CHANNEL_VERSION,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
} from "@tessera/teststore-atf";

import {
  EXIT_CODES,
  liveRunRecord,
  loadLiveSpecs,
  main,
} from "../build/index.js";

const tempRoots = [];
after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-inv-"));
  tempRoots.push(root);
  return root;
}

const hex = (prefix) => prefix.padEnd(32, "0");

// ── loadLiveSpecs ───────────────────────────────────────────────────────────

describe("loadLiveSpecs marks the inventory incomplete when it drops a spec", () => {
  async function root(entries) {
    const testsRoot = path.join(await tempRoot(), "tests");
    await fs.mkdir(testsRoot, { recursive: true });
    for (const entry of entries) {
      await fs.writeFile(path.join(testsRoot, entry.path), "gs.info('x');\n");
    }
    await fs.writeFile(
      path.join(testsRoot, ".manifest.json"),
      JSON.stringify({ version: 1, specs: entries }),
    );
    return testsRoot;
  }
  const targets = [{ table: "sys_script_include", sysId: hex("a"), name: "X" }];

  it("a non-unit spec is not projected, and the load says incomplete", async () => {
    const load = await loadLiveSpecs(
      await root([
        { id: "U", path: "u.unit.ts", kind: "unit", targets },
        { id: "E", path: "e.e2e.atf.yaml", kind: "e2e", targets },
      ]),
    );
    assert.equal(load.kind, "loaded");
    assert.deepEqual(
      load.specs.map((spec) => spec.ref.id),
      ["U"],
    );
    assert.equal(load.incomplete, true);
    assert.ok(load.notes.some((note) => /not projected/.test(note.message)));
  });

  it("an all-unit inventory stays complete", async () => {
    const load = await loadLiveSpecs(
      await root([{ id: "U", path: "u.unit.ts", kind: "unit", targets }]),
    );
    assert.equal(load.kind, "loaded");
    assert.equal(load.incomplete, false);
  });
});

// ── liveRunRecord ───────────────────────────────────────────────────────────

describe("liveRunRecord persists inventoryIncomplete", () => {
  const report = {
    runId: "r",
    state: "done",
    transitions: [],
    verdict: { status: "GO", rows: [], warnings: [], overrides: [] },
    result: {},
    planned: [],
    impact: { nodes: [], edges: [], unanalyzable: [], demanded: [] },
    coverage: {},
    teardown: "completed",
  };
  for (const flag of [true, false]) {
    it(String(flag), () => {
      assert.equal(
        liveRunRecord(report, { inventoryIncomplete: flag })
          .inventoryIncomplete,
        flag,
      );
    });
  }
});

// ── end to end, against the QA-18 fake runner ───────────────────────────────

const RUNNER_HOST = "dev-live.service-now.com";
const SCOPE_NAME = "x_tessera_live";
const SCOPE_ID = hex("5c0be");
const TARGET_ID = hex("a11ce");
const TARGET_NAME = "LiveDiscount";
const SOURCE = [
  "var LiveDiscount = Class.create();",
  "LiveDiscount.prototype = {",
  "  apply: function (units, price) {",
  "    var total = units * price;",
  "    if (units >= 100) total = total * 0.9;",
  "    return Math.round(total * 100) / 100;",
  "  },",
  "  type: 'LiveDiscount',",
  "};",
].join("\n");
const SPEC_PATH = `${SCOPE_NAME}/sys_script_include/${TARGET_NAME}/${TARGET_NAME}.unit.ts`;
const BODY = `(function (outputs, steps, params, stepResult, assertEqual) {
  var d = new LiveDiscount();
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

/**
 * The live spec that reaches GO, plus a manifest entry the inventory itself
 * drops (a symlink escaping the tests root) — so `incomplete` comes from
 * `@tessera/specs`, independent of the non-unit branch above.
 */
async function writeTestsRoot(root, { escape }) {
  const testsRoot = path.join(root, "tests");
  const file = path.join(testsRoot, SPEC_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, BODY);
  const target = {
    table: "sys_script_include",
    sysId: TARGET_ID,
    name: TARGET_NAME,
  };
  const specs = [
    {
      id: `sys_script_include/${TARGET_ID}`,
      path: SPEC_PATH,
      kind: "unit",
      targets: [target],
    },
  ];
  if (escape) {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "o.unit.ts"), "gs.info('o');\n");
    await fs.symlink(outside, path.join(testsRoot, "linkdir"));
    specs.push({
      id: "ESC",
      path: "linkdir/o.unit.ts",
      kind: "unit",
      targets: [target],
    });
  }
  await fs.writeFile(
    path.join(testsRoot, ".manifest.json"),
    JSON.stringify({ version: 1, specs }),
  );
  return testsRoot;
}

async function liveRun({ escape, json }) {
  const fake = createFakeInstance({
    host: RUNNER_HOST,
    state: {
      sys_scope: [
        { sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Tessera Live" },
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
          sys_id: hex("c4a2"),
          name: AUTHORING_CHANNEL_VERSION_PROPERTY,
          value: AUTHORING_CHANNEL_VERSION,
        },
      ],
    },
    acl: { roles: [W2_AUTHORING_ROLE], rules: W2_AUTHORING_CHANNEL_ACL_RULES },
    cicdSuiteParams: ["test_suite_sys_id", "sys_id"],
  });
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

  const root = await tempRoot();
  const testsRoot = await writeTestsRoot(root, { escape });
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
  const runId = `live-inv-${escape ? "esc" : "ok"}-${json ? "j" : "h"}`;
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
        runId,
        "--run-timeout-ms",
        "30000",
        ...(json ? ["--json"] : []),
      ],
      {
        now: () => new Date("2026-09-26T10:00:00.000Z"),
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
  const persisted = JSON.parse(
    await fs
      .readFile(
        path.join(root, ".tessera", "runs", runId, "result.json"),
        "utf8",
      )
      .catch(() => "null"),
  );
  return { code, out: out.join("\n"), err: err.join("\n"), persisted };
}

describe("tess run --live reports an incomplete inventory", () => {
  it("--json carries inventoryIncomplete: true", async () => {
    const run = await liveRun({ escape: true, json: true });
    const doc = JSON.parse(run.out);
    assert.equal(doc.inventoryIncomplete, true, run.err);
    assert.match(run.err, /ESC/);
    assert.match(run.err, /spec inventory under .* is incomplete/);
    // The one live spec passed, and the dropped one was never demanded, so
    // the reducer alone would say GO. Over a partial inventory that GO is
    // downgraded: INCONCLUSIVE, exit 5, no token, and the reason is named.
    assert.equal(doc.verdict.status, "INCONCLUSIVE", run.err);
    assert.equal(doc.exitCode, EXIT_CODES.inconclusive);
    assert.equal(run.code, EXIT_CODES.inconclusive);
    assert.equal(doc.verdict.confirmToken, undefined);
    assert.equal(doc.verdict.counts.blocking, 0, "every read spec passed");
    assert.ok(
      doc.verdict.warnings.some((w) => /spec inventory is incomplete/.test(w)),
      JSON.stringify(doc.verdict.warnings),
    );
    assert.match(doc.verdictReason ?? "", /spec inventory is incomplete/);
  });

  it("a complete inventory over the same spec is still GO, exit 0", async () => {
    const run = await liveRun({ escape: false, json: true });
    const doc = JSON.parse(run.out);
    assert.equal(doc.verdict.status, "GO", run.err);
    assert.equal(run.code, EXIT_CODES.ok);
    assert.ok(doc.verdict.confirmToken, "a GO mints its token");
    assert.equal(doc.verdictReason, undefined);
  });

  it("--json carries inventoryIncomplete: false on a complete inventory", async () => {
    const run = await liveRun({ escape: false, json: true });
    const doc = JSON.parse(run.out);
    assert.equal(doc.inventoryIncomplete, false, run.err);
  });

  it("the human report says the inventory is incomplete", async () => {
    const run = await liveRun({ escape: true, json: false });
    assert.match(run.out, /inventory: INCOMPLETE/, run.out);
    assert.match(run.out, /VERDICT: INCONCLUSIVE/, run.out);
    assert.match(
      run.out,
      /VERDICT: INCONCLUSIVE\n {2}reason: .*spec inventory is incomplete/,
      run.out,
    );
    assert.match(run.out, /exit: 5/, run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive);
  });

  it("the persisted result carries the flag", async () => {
    // result.json wraps the record: `{ runId, at, result: LiveRunRecord }`.
    const run = await liveRun({ escape: true, json: true });
    assert.notEqual(run.persisted, null, "result.json was written");
    assert.equal(run.persisted.result.inventoryIncomplete, true);
    assert.equal(run.persisted.result.verdict.status, "INCONCLUSIVE");
    assert.equal(run.persisted.result.exitCode, EXIT_CODES.inconclusive);
    assert.match(
      run.persisted.result.verdictReason ?? "",
      /spec inventory is incomplete/,
    );
  });
});
