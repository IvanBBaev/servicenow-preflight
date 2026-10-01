// `tess run --live` never yields GO over an incomplete impact analysis.
//
// The sibling of liveResolutionIncomplete.test.js, one stage further on. The
// resolution here is COMPLETE — the scope adapter enumerates every
// script-bearing table without a single warning (bar the `acl` case, where the
// ACL-trimmed consumer is also named by the resolver) — and the one tested
// Script Include passes. What is partial is the impact graph: a business rule
// in the same scope hides its call target at runtime (`gs.include(...)`), or
// cannot be addressed at all (a field-level read ACL blanks its `sys_id`), so
// the where-used search cannot say what uses the changed artifact. The reducer
// only ever listed such an artifact as a warning and let the gate say GO; the
// run loop now downgrades that GO to INCONCLUSIVE (exit 5) and mints no token.
//
// A control brackets it: the same scope WITHOUT the business rule leaves the
// run GO with a token, so the INCONCLUSIVE comes from the consumer and nothing
// else. Since wave 14 the CLI traces Business Rules (`sys_script`) as impact
// subjects, so a plain, readable rule in the scope DEMANDS its own unit spec:
// GO when that spec exists and passes, NO_GO/missing when it does not. A rule
// the analysis cannot place — a `global` collection, a refused lookup read —
// stays INCONCLUSIVE (exit 5), and a transport fault on that read is exit 3.

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

import { EXIT_CODES, main } from "../build/index.js";

const tempRoots = [];
after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const hex = (prefix) => prefix.padEnd(32, "0");

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

/** A business rule in the scope — since wave 14 a traced impact subject. */
const CONSUMER_TABLE = "sys_script";
const CONSUMER_ID = hex("b0b1");
const CONSUMER_NAME = "Order audit";
/** DESIGN §4's path for the rule's unit spec (`pathSegment` of its name). */
const RULE_SPEC_PATH = `${SCOPE_NAME}/${CONSUMER_TABLE}/Order_audit/Order_audit.unit.ts`;
const RULE_BODY = `(function (outputs, steps, params, stepResult, assertEqual) {
  assertEqual({ name: "the rule's spec runs", shouldbe: 1, value: 1 });
})(outputs, steps, params, stepResult, assertEqual);
`;
/** The Business Rule lookup's read, and only it: `sys_script` by these fields. */
const RULE_LOOKUP_FIELDS = "sys_id,sys_name,collection";

/** A server-side UI Action in the scope — since wave 15 a traced subject. */
const ACTION_TABLE = "sys_ui_action";
const ACTION_ID = hex("ac71");
const ACTION_NAME = "Recalculate order";
const ACTION_SPEC_PATH = `${SCOPE_NAME}/${ACTION_TABLE}/Recalculate_order/Recalculate_order.unit.ts`;
/** The UI Action lookup's read, and only it: `sys_ui_action` by these fields. */
const ACTION_LOOKUP_FIELDS = "sys_id,sys_name,table,client,action_name";

/** A scheduled job in the scope — since wave 16 a traced subject. */
const JOB_TABLE = "sysauto_script";
const JOB_ID = hex("70b5");
const JOB_NAME = "Nightly discount";
const JOB_SPEC_PATH = `${SCOPE_NAME}/${JOB_TABLE}/Nightly_discount/Nightly_discount.unit.ts`;
/**
 * The standalone-script lookup's `sys_script_include` read, and only it: the
 * scope enumeration asks for `sys_id,name,sys_scope`, the where-used search
 * for `sys_id,sys_name,script`.
 */
const INCLUDE_LOOKUP_FIELDS = "sys_id,sys_name,name";

/**
 * A transform script in the scope — since wave 16 a traced subject; since
 * wave 17 the lookup also reads its map's `target_table` and the rules on it.
 */
const TRANSFORM_TABLE = "sys_transform_script";
const TRANSFORM_ID = hex("7a75");
const TRANSFORM_NAME = "Order import";
const TRANSFORM_SPEC_PATH = `${SCOPE_NAME}/${TRANSFORM_TABLE}/Order_import/Order_import.unit.ts`;
const MAP_TABLE = "sys_transform_map";
const MAP_ID = hex("3a9");
/** The standalone-script lookup's `sys_transform_map` read (the only one). */
const MAP_LOOKUP_FIELDS = "sys_id,target_table";

async function writeTestsRoot(
  root,
  { ruleSpec, actionSpec = false, jobSpec = false, transformSpec = false },
) {
  const testsRoot = path.join(root, "tests");
  const specs = [
    {
      id: `sys_script_include/${TARGET_ID}`,
      path: SPEC_PATH,
      kind: "unit",
      targets: [
        { table: "sys_script_include", sysId: TARGET_ID, name: TARGET_NAME },
      ],
    },
  ];
  const bodies = [[SPEC_PATH, BODY]];
  if (ruleSpec) {
    specs.push({
      id: `${CONSUMER_TABLE}/${CONSUMER_ID}`,
      path: RULE_SPEC_PATH,
      kind: "unit",
      targets: [
        { table: CONSUMER_TABLE, sysId: CONSUMER_ID, name: CONSUMER_NAME },
      ],
    });
    bodies.push([RULE_SPEC_PATH, RULE_BODY]);
  }
  if (actionSpec) {
    specs.push({
      id: `${ACTION_TABLE}/${ACTION_ID}`,
      path: ACTION_SPEC_PATH,
      kind: "unit",
      targets: [{ table: ACTION_TABLE, sysId: ACTION_ID, name: ACTION_NAME }],
    });
    bodies.push([ACTION_SPEC_PATH, RULE_BODY]);
  }
  if (jobSpec) {
    specs.push({
      id: `${JOB_TABLE}/${JOB_ID}`,
      path: JOB_SPEC_PATH,
      kind: "unit",
      targets: [{ table: JOB_TABLE, sysId: JOB_ID, name: JOB_NAME }],
    });
    bodies.push([JOB_SPEC_PATH, RULE_BODY]);
  }
  if (transformSpec) {
    specs.push({
      id: `${TRANSFORM_TABLE}/${TRANSFORM_ID}`,
      path: TRANSFORM_SPEC_PATH,
      kind: "unit",
      targets: [
        { table: TRANSFORM_TABLE, sysId: TRANSFORM_ID, name: TRANSFORM_NAME },
      ],
    });
    bodies.push([TRANSFORM_SPEC_PATH, RULE_BODY]);
  }
  for (const [specPath, body] of bodies) {
    const file = path.join(testsRoot, specPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  await fs.writeFile(
    path.join(testsRoot, ".manifest.json"),
    JSON.stringify({ version: 1, specs }),
  );
  return testsRoot;
}

/** Is this request the UI Action lookup's `sys_ui_action` read? */
function isActionLookup(href) {
  const url = new URL(href);
  return (
    url.pathname === `/api/now/table/${ACTION_TABLE}` &&
    url.searchParams.get("sysparm_fields") === ACTION_LOOKUP_FIELDS
  );
}

/** Is this request the standalone-script lookup's `sys_script_include` read? */
function isIncludeLookup(href) {
  const url = new URL(href);
  return (
    url.pathname === "/api/now/table/sys_script_include" &&
    url.searchParams.get("sysparm_fields") === INCLUDE_LOOKUP_FIELDS
  );
}

/** Is this request the standalone-script lookup's `sys_transform_map` read? */
function isMapLookup(href) {
  const url = new URL(href);
  return (
    url.pathname === `/api/now/table/${MAP_TABLE}` &&
    url.searchParams.get("sysparm_fields") === MAP_LOOKUP_FIELDS
  );
}

/** Is this request the Business Rule lookup's `sys_script` read? */
function isRuleLookup(href) {
  const url = new URL(href);
  return (
    url.pathname === `/api/now/table/${CONSUMER_TABLE}` &&
    url.searchParams.get("sysparm_fields") === RULE_LOOKUP_FIELDS
  );
}

/**
 * @param {{
 *   gap: "none" | "clean" | "dynamic" | "acl",
 *   json: boolean,
 *   ruleSpec?: boolean,
 *   collection?: string,
 *   ruleRead?: "ok" | "refused" | "fault",
 * }} options
 *   `none`    — no business rule in the scope at all.
 *   `clean`   — the business rule is readable and its script is plain.
 *   `dynamic` — its script names a call target at runtime (`gs.include`), so
 *               the where-used search marks it unanalyzable.
 *   `acl`     — a field-level read ACL blanks its `sys_id`: the row cannot be
 *               addressed, so the search is incomplete and the changed Script
 *               Include is unanalyzable ("could not be fully traced").
 *   `ruleSpec`   — the tests root also carries the rule's own unit spec.
 *   `collection` — the rule's trigger table (default `x_tessera_live_order`).
 *   `ruleRead`   — the Business Rule lookup's read answers normally, is
 *                  refused (403), or never gets an HTTP answer at all.
 *   `action`     — the scope also ships a server-side UI Action.
 *   `actionSpec` — the tests root also carries the action's own unit spec.
 *   `actionRead` — the UI Action lookup's read, as `ruleRead`.
 *   `job`        — the scope also ships a scheduled job calling the include.
 *   `jobSpec`    — the tests root also carries the job's own unit spec.
 *   `includeRead` — the standalone-script lookup's `sys_script_include`
 *                  read, as `ruleRead`.
 *   `transform`  — the scope also ships a transform script calling the
 *                  include, on a map targeting the rule's collection.
 *   `transformSpec` — the tests root also carries its own unit spec.
 *   `mapRead`    — the standalone-script lookup's `sys_transform_map` read,
 *                  as `ruleRead`.
 */
async function liveRun({
  gap,
  json,
  ruleSpec = false,
  collection = "x_tessera_live_order",
  ruleRead = "ok",
  action = false,
  actionSpec = false,
  actionRead = "ok",
  job = false,
  jobSpec = false,
  includeRead = "ok",
  transform = false,
  transformSpec = false,
  mapRead = "ok",
}) {
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
      [CONSUMER_TABLE]: (gap === "none" ? [] : [0]).map(() => ({
        sys_id: CONSUMER_ID,
        name: CONSUMER_NAME,
        sys_name: CONSUMER_NAME,
        collection,
        sys_scope: SCOPE_ID,
        active: "true",
        script:
          gap === "dynamic"
            ? "(function () { gs.include(current.getValue('helper')); })();"
            : "(function () { gs.info('order saved'); })();",
      })),
      [ACTION_TABLE]: action
        ? [
            {
              sys_id: ACTION_ID,
              name: ACTION_NAME,
              sys_name: ACTION_NAME,
              table: "x_tessera_live_order",
              client: "false",
              action_name: "x_tessera_recalc",
              sys_scope: SCOPE_ID,
              active: "true",
              script: "current.update();",
            },
          ]
        : [],
      [JOB_TABLE]: job
        ? [
            {
              sys_id: JOB_ID,
              name: JOB_NAME,
              sys_name: JOB_NAME,
              sys_scope: SCOPE_ID,
              active: "true",
              script: "var d = new LiveDiscount();\nd.apply(1, 1);",
            },
          ]
        : [],
      [TRANSFORM_TABLE]: transform
        ? [
            {
              sys_id: TRANSFORM_ID,
              name: TRANSFORM_NAME,
              sys_name: TRANSFORM_NAME,
              sys_scope: SCOPE_ID,
              active: "true",
              map: MAP_ID,
              script: "var d = new LiveDiscount();\nd.apply(1, 1);",
            },
          ]
        : [],
      [MAP_TABLE]: transform
        ? [
            {
              sys_id: MAP_ID,
              name: "Order map",
              target_table: collection,
              sys_scope: SCOPE_ID,
            },
          ]
        : [],
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
    // The ACL targets the CONSUMER table only: the Script Include resolves
    // cleanly, while the resolver's own read of the consumer table comes back
    // trimmed and is named as a refused artifact table.
    ...(gap === "acl"
      ? {
          readAcl: {
            rules: [{ table: CONSUMER_TABLE, fields: ["sys_id"] }],
          },
        }
      : {}),
  });
  const engine = createAtfExecutionEngine(fake);
  const realFetch = globalThis.fetch;
  let lookupHits = 0;
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
    const faulted =
      ruleRead !== "ok" && isRuleLookup(href)
        ? ruleRead
        : actionRead !== "ok" && isActionLookup(href)
          ? actionRead
          : includeRead !== "ok" && isIncludeLookup(href)
            ? includeRead
            : mapRead !== "ok" && isMapLookup(href)
              ? mapRead
              : "ok";
    if (faulted !== "ok") {
      lookupHits += 1;
      if (faulted === "fault") {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "Insufficient rights" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return engine(input, init);
  };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-imp-"));
  tempRoots.push(root);
  const testsRoot = await writeTestsRoot(root, {
    ruleSpec,
    actionSpec,
    jobSpec,
    transformSpec,
  });
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
  const runId = `live-imp-${gap}-${ruleSpec ? "s" : "n"}-${ruleRead}-${action ? "a" : "x"}${actionSpec ? "s" : "n"}${actionRead}-${job ? "j" : "x"}${jobSpec ? "s" : "n"}${includeRead}-${transform ? "t" : "x"}${transformSpec ? "s" : "n"}${mapRead}-${json ? "j" : "h"}`;
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
  const fired = fake.faults.list().reduce((sum, rule) => sum + rule.fired, 0);
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    fired,
    lookupHits,
    root,
    runId,
  };
}

/** `IMPACT_INCOMPLETE_WARNING` from `@tessera/core`. */
const INCOMPLETE = /impact analysis is incomplete/;
/** The downgrade itself: the gate said GO, and the loop narrowed it. */
const DOWNGRADE =
  /a GO over a partial impact analysis is downgraded to INCONCLUSIVE/;
/** Nothing about the resolution may be blamed: it was complete. */
const RESOLUTION_GAP = /artifact resolution is incomplete|^resolution: /;

describe("tess run --live over an incomplete impact analysis", () => {
  it("control: with no business rule in the scope the run is GO, exit 0, with a token", async () => {
    const run = await liveRun({ gap: "none", json: true });
    const doc = JSON.parse(run.out);
    assert.equal(doc.verdict.status, "GO", `${run.err}\n${run.out}`);
    assert.equal(run.code, EXIT_CODES.ok);
    assert.ok(doc.verdict.confirmToken, "a GO mints its token");
    assert.equal(doc.verdictReason, undefined);
    assert.ok(
      !(doc.verdict.warnings ?? []).some((w) => INCOMPLETE.test(w)),
      JSON.stringify(doc.verdict.warnings),
    );
  });

  it("--json: a plain, readable business rule WITH its spec is traced, and the run is GO, exit 0", async () => {
    const run = await liveRun({ gap: "clean", json: true, ruleSpec: true });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.ok, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "GO");
    assert.ok(doc.verdict.confirmToken, "a GO mints its token");
    const rule = doc.verdict.rows.find(
      (row) => row.spec.id === `${CONSUMER_TABLE}/${CONSUMER_ID}`,
    );
    assert.ok(rule, JSON.stringify(doc.verdict.rows));
    assert.equal(rule.spec.path, `tests/${RULE_SPEC_PATH}`);
    assert.equal(rule.status, "pass");
    const warnings = doc.verdict.warnings ?? [];
    assert.ok(
      !warnings.some((w) => INCOMPLETE.test(w) || /^unanalyzable/.test(w)),
      JSON.stringify(warnings),
    );
    assert.equal(doc.artifactTablesRefused, undefined);
  });

  it("--json: a plain, readable business rule WITHOUT its spec is NO_GO/missing, exit 1", async () => {
    const run = await liveRun({ gap: "clean", json: true });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.noGo, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "NO_GO");
    assert.equal(doc.verdict.confirmToken, undefined);
    const rule = doc.verdict.rows.find(
      (row) => row.spec.id === `${CONSUMER_TABLE}/${CONSUMER_ID}`,
    );
    assert.ok(rule, JSON.stringify(doc.verdict.rows));
    assert.equal(rule.raw, "missing");
    assert.equal(rule.blocking, true);
    assert.equal(rule.spec.path, `tests/${RULE_SPEC_PATH}`);
    // The rule was READ in full and traced: nothing is unanalyzable.
    const warnings = doc.verdict.warnings ?? [];
    assert.ok(!warnings.some((w) => /^unanalyzable/.test(w)));
    assert.ok(!warnings.some((w) => RESOLUTION_GAP.test(w)));
    assert.equal(doc.artifactTablesRefused, undefined);
  });

  it("--json: a business rule on the `global` collection is INCONCLUSIVE, exit 5", async () => {
    const run = await liveRun({
      gap: "clean",
      json: true,
      ruleSpec: true,
      collection: "global",
    });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "INCONCLUSIVE");
    assert.equal(doc.verdict.confirmToken, undefined);
    assert.equal(doc.verdict.counts.blocking, 0);
    assert.match(doc.verdictReason ?? "", INCOMPLETE);
    const warnings = doc.verdict.warnings ?? [];
    assert.ok(
      warnings.some(
        (w) =>
          w.startsWith(
            `unanalyzable impact: ${CONSUMER_TABLE}/${CONSUMER_ID}`,
          ) && /global/.test(w),
      ),
      JSON.stringify(warnings),
    );
  });

  it("--json: a refused business-rule lookup read is INCONCLUSIVE, exit 5, naming sys_script", async () => {
    const run = await liveRun({
      gap: "clean",
      json: true,
      ruleSpec: true,
      ruleRead: "refused",
    });
    assert.ok(run.lookupHits >= 1, "the lookup read was made and refused");
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "INCONCLUSIVE");
    assert.equal(doc.verdict.confirmToken, undefined);
    assert.deepEqual(
      (doc.artifactTablesRefused ?? []).map((entry) => entry.table),
      [CONSUMER_TABLE],
    );
    const warnings = doc.verdict.warnings ?? [];
    assert.ok(
      warnings.some(
        (w) =>
          w.startsWith(
            `unanalyzable impact: ${CONSUMER_TABLE}/${CONSUMER_ID}`,
          ) && /could not be established/.test(w),
      ),
      JSON.stringify(warnings),
    );
  });

  it("--json: a lookup-only refusal is recorded and worded as a lookup, not an enumeration", async () => {
    const run = await liveRun({
      gap: "clean",
      json: true,
      ruleSpec: true,
      ruleRead: "refused",
    });
    assert.ok(run.lookupHits >= 1, "the lookup read was made and refused");
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.deepEqual(doc.artifactTablesRefused, [
      {
        table: CONSUMER_TABLE,
        reason: doc.artifactTablesRefused[0].reason,
        read: "lookup",
      },
    ]);
    assert.match(doc.artifactTablesRefused[0].reason, /read refused \(403\)/);
    assert.match(
      run.err,
      new RegExp(
        `warning: impact lookup is incomplete — 1 table\\(s\\) refused the impact analysis's lookup read \\(not the enumeration\\), so the verdict cannot be GO: ${CONSUMER_TABLE} \\(`,
      ),
    );
    assert.doesNotMatch(run.err, /enumeration is incomplete/);
  });

  it("human: a lookup-only refusal is reported under lookups, not artifacts, exit 5", async () => {
    const run = await liveRun({
      gap: "clean",
      json: false,
      ruleSpec: true,
      ruleRead: "refused",
    });
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.match(
      run.out,
      /lookups: INCOMPLETE — 1 artifact table\(s\) refused an impact lookup read \(the enumeration was not refused\); the verdict cannot be GO/,
    );
    assert.match(
      run.out,
      new RegExp(`- ${CONSUMER_TABLE}: .*read refused \\(403\\)`),
    );
    assert.doesNotMatch(run.out, /artifacts: INCOMPLETE/);
    assert.doesNotMatch(run.err, /enumeration is incomplete/);
  });

  it("--json: an enumeration refusal of the rule's table keeps the enumeration wording", async () => {
    const run = await liveRun({ gap: "acl", json: true });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.equal(doc.artifactTablesRefused.length, 1);
    assert.equal(doc.artifactTablesRefused[0].read, undefined);
    assert.match(run.err, /warning: live artifact enumeration is incomplete/);
    assert.doesNotMatch(run.err, /impact lookup is incomplete/);
  });

  it("--json: a server-side UI Action WITHOUT its spec is traced and NO_GO/missing, exit 1", async () => {
    const run = await liveRun({ gap: "none", json: true, action: true });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.noGo, `${run.err}\n${run.out}`);
    const row = doc.verdict.rows.find(
      (candidate) => candidate.spec.id === `${ACTION_TABLE}/${ACTION_ID}`,
    );
    assert.ok(row, JSON.stringify(doc.verdict.rows));
    assert.equal(row.raw, "missing");
    assert.equal(doc.artifactTablesRefused, undefined);
  });

  it("--json: a server-side UI Action WITH its spec is traced, and the run is GO, exit 0", async () => {
    const run = await liveRun({
      gap: "none",
      json: true,
      action: true,
      actionSpec: true,
    });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.ok, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "GO");
    const row = doc.verdict.rows.find(
      (candidate) => candidate.spec.id === `${ACTION_TABLE}/${ACTION_ID}`,
    );
    assert.ok(row, JSON.stringify(doc.verdict.rows));
    assert.equal(row.status, "pass");
    assert.equal(doc.artifactTablesRefused, undefined);
  });

  it("--json: a refused UI Action lookup read is INCONCLUSIVE, exit 5, recorded as a lookup refusal of sys_ui_action", async () => {
    const run = await liveRun({
      gap: "none",
      json: true,
      action: true,
      actionSpec: true,
      actionRead: "refused",
    });
    assert.ok(run.lookupHits >= 1, "the lookup read was made and refused");
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "INCONCLUSIVE");
    assert.equal(doc.verdict.confirmToken, undefined);
    assert.deepEqual(doc.artifactTablesRefused, [
      {
        table: ACTION_TABLE,
        reason: doc.artifactTablesRefused[0].reason,
        read: "lookup",
      },
    ]);
    assert.match(doc.artifactTablesRefused[0].reason, /read refused \(403\)/);
    assert.ok(
      (doc.verdict.warnings ?? []).some(
        (w) =>
          w.startsWith(`unanalyzable impact: ${ACTION_TABLE}/${ACTION_ID}`) &&
          /could not be established/.test(w),
      ),
      JSON.stringify(doc.verdict.warnings),
    );
    assert.match(run.err, /warning: impact lookup is incomplete/);
    assert.doesNotMatch(run.err, /enumeration is incomplete/);
  });

  it("a transport fault on the UI Action lookup read is a fault, exit 3 — never a GO", async () => {
    const run = await liveRun({
      gap: "none",
      json: true,
      action: true,
      actionSpec: true,
      actionRead: "fault",
    });
    assert.ok(run.lookupHits >= 1, "the lookup read was made and faulted");
    assert.equal(run.code, EXIT_CODES.fault, `${run.err}\n${run.out}`);
    assert.doesNotMatch(run.out, /"status": "GO"|VERDICT: GO/);
    assert.doesNotMatch(run.out, /confirmToken/);
  });

  it("--json: a scheduled job WITHOUT its spec is traced and NO_GO/missing, exit 1", async () => {
    const run = await liveRun({ gap: "none", json: true, job: true });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.noGo, `${run.err}\n${run.out}`);
    const row = doc.verdict.rows.find(
      (candidate) => candidate.spec.id === `${JOB_TABLE}/${JOB_ID}`,
    );
    assert.ok(row, JSON.stringify(doc.verdict.rows));
    assert.equal(row.raw, "missing");
    assert.equal(doc.artifactTablesRefused, undefined);
  });

  it("--json: a scheduled job WITH its spec is traced, and the run is GO, exit 0", async () => {
    const run = await liveRun({
      gap: "none",
      json: true,
      job: true,
      jobSpec: true,
    });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.ok, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "GO");
    const row = doc.verdict.rows.find(
      (candidate) => candidate.spec.id === `${JOB_TABLE}/${JOB_ID}`,
    );
    assert.ok(row, JSON.stringify(doc.verdict.rows));
    assert.equal(row.status, "pass");
    assert.equal(doc.artifactTablesRefused, undefined);
  });

  it("--json: a refused standalone-script include lookup read is INCONCLUSIVE, exit 5, recorded as a lookup refusal of sys_script_include", async () => {
    const run = await liveRun({
      gap: "none",
      json: true,
      job: true,
      jobSpec: true,
      includeRead: "refused",
    });
    assert.ok(run.lookupHits >= 1, "the lookup read was made and refused");
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "INCONCLUSIVE");
    assert.equal(doc.verdict.confirmToken, undefined);
    assert.deepEqual(doc.artifactTablesRefused, [
      {
        table: "sys_script_include",
        reason: doc.artifactTablesRefused[0].reason,
        read: "lookup",
      },
    ]);
    assert.match(doc.artifactTablesRefused[0].reason, /read refused \(403\)/);
    assert.ok(
      (doc.verdict.warnings ?? []).some(
        (w) =>
          w.startsWith(`unanalyzable impact: ${JOB_TABLE}/${JOB_ID}`) &&
          /could not be established/.test(w),
      ),
      JSON.stringify(doc.verdict.warnings),
    );
    assert.match(run.err, /warning: impact lookup is incomplete/);
    assert.doesNotMatch(run.err, /enumeration is incomplete/);
  });

  it("status / confirm --json read the lookup refusal and the reason back from disk, named as the run printed them", async () => {
    const run = await liveRun({
      gap: "none",
      json: true,
      job: true,
      jobSpec: true,
      includeRead: "refused",
    });
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    const live = JSON.parse(run.out);
    assert.equal(typeof live.verdictReason, "string");
    assert.equal(typeof live.inventoryIncomplete, "boolean");
    const read = async (command) => {
      const out = [];
      const code = await main([command, "--run-id", run.runId, "--json"], {
        now: () => new Date("2026-09-26T10:00:00.000Z"),
        actor: "test",
        cwd: run.root,
        env: {},
        stdout: (line) => out.push(line),
        stderr: () => {},
      });
      return { code, doc: JSON.parse(out.join("\n")) };
    };
    const confirm = await read("confirm");
    assert.equal(confirm.code, EXIT_CODES.inconclusive);
    const status = await read("status");
    assert.equal(status.code, EXIT_CODES.ok);
    for (const doc of [confirm.doc, status.doc.result]) {
      assert.equal(doc.verdictReason, live.verdictReason);
      assert.equal(doc.inventoryIncomplete, live.inventoryIncomplete);
      assert.deepEqual(doc.artifactTablesRefused, live.artifactTablesRefused);
    }
  });

  it("a transport fault on the standalone-script include lookup read is a fault, exit 3 — never a GO", async () => {
    const run = await liveRun({
      gap: "none",
      json: true,
      job: true,
      jobSpec: true,
      includeRead: "fault",
    });
    assert.ok(run.lookupHits >= 1, "the lookup read was made and faulted");
    assert.equal(run.code, EXIT_CODES.fault, `${run.err}\n${run.out}`);
    assert.doesNotMatch(run.out, /"status": "GO"|VERDICT: GO/);
    assert.doesNotMatch(run.out, /confirmToken/);
  });

  it("--json: a transform script WITH its spec is traced through its map, and the run is GO, exit 0 (wave 17)", async () => {
    const run = await liveRun({
      gap: "none",
      json: true,
      transform: true,
      transformSpec: true,
    });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.ok, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "GO");
    const row = doc.verdict.rows.find(
      (candidate) => candidate.spec.id === `${TRANSFORM_TABLE}/${TRANSFORM_ID}`,
    );
    assert.ok(row, JSON.stringify(doc.verdict.rows));
    assert.equal(row.status, "pass");
    assert.equal(doc.artifactTablesRefused, undefined);
  });

  it("--json: a refused sys_transform_map lookup read is INCONCLUSIVE, exit 5, recorded as a lookup refusal of sys_transform_map (wave 17)", async () => {
    const run = await liveRun({
      gap: "none",
      json: true,
      transform: true,
      transformSpec: true,
      mapRead: "refused",
    });
    assert.ok(run.lookupHits >= 1, "the map lookup read was made and refused");
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.confirmToken, undefined);
    assert.deepEqual(
      (doc.artifactTablesRefused ?? []).map((entry) => [
        entry.table,
        entry.read,
      ]),
      [[MAP_TABLE, "lookup"]],
    );
    assert.match(run.err, /warning: impact lookup is incomplete/);
    assert.doesNotMatch(run.err, /enumeration is incomplete/);
  });

  it("a transport fault on the sys_transform_map lookup read is a fault, exit 3 — never a GO (wave 17)", async () => {
    const run = await liveRun({
      gap: "none",
      json: true,
      transform: true,
      transformSpec: true,
      mapRead: "fault",
    });
    assert.ok(run.lookupHits >= 1, "the map lookup read was made and faulted");
    assert.equal(run.code, EXIT_CODES.fault, `${run.err}\n${run.out}`);
    assert.doesNotMatch(run.out, /"status": "GO"|VERDICT: GO/);
    assert.doesNotMatch(run.out, /confirmToken/);
  });

  it("a transport fault on the business-rule lookup read is a fault, exit 3 — never a GO", async () => {
    const run = await liveRun({
      gap: "clean",
      json: true,
      ruleSpec: true,
      ruleRead: "fault",
    });
    assert.ok(run.lookupHits >= 1, "the lookup read was made and faulted");
    assert.equal(run.code, EXIT_CODES.fault, `${run.err}\n${run.out}`);
    assert.doesNotMatch(run.out, /"status": "GO"|VERDICT: GO/);
    assert.doesNotMatch(run.out, /confirmToken/);
  });

  it("--json: dynamic dispatch in a consumer is INCONCLUSIVE, exit 5, no token", async () => {
    const run = await liveRun({ gap: "dynamic", json: true, ruleSpec: true });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.equal(doc.exitCode, EXIT_CODES.inconclusive);
    assert.equal(doc.verdict.status, "INCONCLUSIVE");
    assert.equal(doc.verdict.confirmToken, undefined);
    // Every spec that ran passed: the INCONCLUSIVE is the impact graph's alone.
    assert.equal(doc.verdict.counts.blocking, 0);
    assert.match(doc.verdictReason ?? "", INCOMPLETE);
    assert.match(doc.verdictReason ?? "", DOWNGRADE);
    const warnings = doc.verdict.warnings ?? [];
    assert.ok(
      warnings.some((w) =>
        w.startsWith(`unanalyzable impact: ${CONSUMER_TABLE}/${CONSUMER_ID}`),
      ),
      JSON.stringify(warnings),
    );
    assert.ok(
      !warnings.some((w) => RESOLUTION_GAP.test(w)),
      `the resolution was complete: ${JSON.stringify(warnings)}`,
    );
  });

  it("--json: a consumer row with no readable sys_id is INCONCLUSIVE, exit 5", async () => {
    const run = await liveRun({ gap: "acl", json: true });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.err}\n${run.out}`);
    assert.equal(doc.verdict.status, "INCONCLUSIVE");
    assert.equal(doc.verdict.confirmToken, undefined);
    assert.equal(doc.verdict.counts.blocking, 0);
    assert.match(doc.verdictReason ?? "", INCOMPLETE);
    const warnings = doc.verdict.warnings ?? [];
    assert.ok(
      warnings.some((w) =>
        w.startsWith(
          `impact: ${CONSUMER_TABLE}: skipped a row with no readable sys_id`,
        ),
      ),
      JSON.stringify(warnings),
    );
    assert.ok(
      warnings.some((w) =>
        w.startsWith(`unanalyzable impact: sys_script_include/${TARGET_ID}`),
      ),
      JSON.stringify(warnings),
    );
    // The resolver read the same trimmed table: it names it, and only it.
    assert.deepEqual(
      (doc.artifactTablesRefused ?? []).map((entry) => entry.table),
      [CONSUMER_TABLE],
    );
    assert.ok(
      warnings
        .filter((w) => /^resolution: /.test(w))
        .every((w) => w.includes(CONSUMER_TABLE)),
      JSON.stringify(warnings),
    );
  });

  it("human: the report says INCONCLUSIVE, exit 5, and names the impact gap", async () => {
    const run = await liveRun({ gap: "dynamic", json: false, ruleSpec: true });
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.out}\n${run.err}`);
    assert.match(run.out, /VERDICT: INCONCLUSIVE/, run.out);
    assert.doesNotMatch(run.out, /VERDICT: GO/, run.out);
    assert.doesNotMatch(run.out, /confirm token|confirmToken/i, run.out);
    assert.match(
      run.out,
      /VERDICT: INCONCLUSIVE\n {2}reason: impact analysis is incomplete/,
      run.out,
    );
    assert.match(run.out, DOWNGRADE, run.out);
    assert.match(run.out, /exit: 5/, run.out);
  });
});
