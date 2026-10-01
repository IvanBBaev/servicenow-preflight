// `tess run --live` never yields GO over an incomplete artifact resolution (H1).
//
// H1 was the gap between the resolver's report and the verdict: the composite
// resolver's `resolveWithReport` could say "one artifact table answered 403, so
// this list is partial", but the run loop only called the bare `resolve()`
// list, so the hole vanished and the run could still reach GO — and mint a
// confirm token for a change it had not fully seen. `runPipeline` now prefers
// `resolveWithReport` and downgrades GO to INCONCLUSIVE (exit 5) when the
// report carries a warning; this file pins that end to end through the real
// composition (`REAL_PIPELINE`, whose resolver `registries.ts` registers
// directly), in the human report and in the `--json` document.
//
// The partial answer is a field-level read ACL that hides one untested Script
// Include from the resolver (see `liveRun`). Two controls bracket it: without
// that Script Include the same run is GO with a token (so the INCONCLUSIVE is
// not from anything else), and with it readable the run is NO_GO (so the GO
// the gate would otherwise have minted over the gap is a GO on a change that
// is really rejected). Since wave 13 the live run enumerates every
// script-bearing table, so a 403 on `sys_script_include` is no longer a total
// failure: the other tables answered, the list is partial, and the run is
// INCONCLUSIVE (exit 5) with the refused table named — pinned below.

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

/** The scope adapter's (only) artifact table — the one both gaps hit. */
const DENIED_TABLE = "sys_script_include";

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
 * A second Script Include in the same scope, with NO spec. Fully readable, it
 * is a resolved artifact nothing tests, so the honest verdict is NO_GO. Hidden
 * from the resolver, the only artifact left is the tested one and the gate
 * alone would say GO — which is exactly the GO H1 must not let through.
 */
const HIDDEN_ID = hex("bbb2");
const HIDDEN_NAME = "ZoneLookup";

/**
 * @param {{ gap: "absent" | "none" | "acl" | "deny", json: boolean }} options
 *   `absent` — the untested Script Include is not on the instance at all.
 *   `none` — it is there and readable.
 *   `acl`  — a field-level read ACL blanks `sys_id` on one of the two Script
 *            Includes: the table answers, one row is unaddressable, so the
 *            resolution is PARTIAL (the H1 case).
 *   `deny` — `sys_script_include` answers 403 to the resolver: the other
 *            script-bearing tables answer, so the resolution is PARTIAL and
 *            the refused table is named (wave 13).
 */
async function liveRun({ gap, json }) {
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
        ...(gap === "absent"
          ? []
          : [
              {
                sys_id: HIDDEN_ID,
                name: HIDDEN_NAME,
                sys_name: HIDDEN_NAME,
                api_name: `${SCOPE_NAME}.${HIDDEN_NAME}`,
                sys_scope: SCOPE_ID,
                active: "true",
                script: "var ZoneLookup = {};",
              },
            ]),
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
    // Delegated decision 2026-09-26: the partial case is a field-level read
    // ACL, not a 403. (Written when the live run enumerated only
    // `sys_script_include`; since wave 13 a 403 there is a partial answer too,
    // pinned separately below.) A blanked
    // `sys_id` is what ACL trimming really renders on the wire: the table
    // answers, one row cannot be addressed, the resolver drops it out loud.
    ...(gap === "acl"
      ? {
          readAcl: {
            rules: [
              {
                table: DENIED_TABLE,
                fields: ["sys_id"],
                when: (row) => row.name === HIDDEN_NAME,
              },
            ],
          },
        }
      : {}),
  });
  if (gap === "deny") {
    // The 403 fires ONCE, on the first GET of the artifact table. Resolution
    // is the first stage of the run and the scope adapter's enumeration is
    // the first read of that table, so exactly the resolver is denied.
    // `SN_MAX_RETRIES=0` keeps the transport from retrying the one denied
    // read into a clean answer.
    fake.faults.add({
      match: { method: "GET", table: DENIED_TABLE, times: 1 },
      mode: { kind: "http-error", status: 403 },
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

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-res-"));
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
  const runId = `live-res-${gap}-${json ? "j" : "h"}`;
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
  return { code, out: out.join("\n"), err: err.join("\n"), fired };
}

/** The resolver's own warning, as `runPipeline` copies it onto the verdict. */
const RESOLVER_NOTE = new RegExp(
  `resolution: ${DENIED_TABLE}: skipped a row with no readable sys_id`,
);
/** `RESOLUTION_INCOMPLETE_WARNING` from `@tessera/core`. */
const INCOMPLETE = /artifact resolution is incomplete/;
/** The downgrade itself: the gate said GO, and the loop narrowed it. */
const DOWNGRADE =
  /a GO over a partial resolution is downgraded to INCONCLUSIVE/;

describe("tess run --live over an incomplete artifact resolution (H1)", () => {
  it("control: with only the tested Script Include the run is GO, exit 0, with a token", async () => {
    const run = await liveRun({ gap: "absent", json: true });
    const doc = JSON.parse(run.out);
    assert.equal(doc.verdict.status, "GO", run.err);
    assert.equal(run.code, EXIT_CODES.ok);
    assert.ok(doc.verdict.confirmToken, "a GO mints its token");
  });

  it("control: with the untested one readable too, the run is NO_GO, exit 1", async () => {
    // What the hidden row below would have masked: seen, it is a resolved
    // artifact with no spec, and the change is rejected.
    const run = await liveRun({ gap: "none", json: true });
    const doc = JSON.parse(run.out);
    assert.equal(doc.verdict.status, "NO_GO", run.err);
    assert.equal(run.code, EXIT_CODES.noGo);
    assert.equal(doc.verdict.confirmToken, undefined);
  });

  it("--json: INCONCLUSIVE, exit 5, no token, and the resolver's warning", async () => {
    const run = await liveRun({ gap: "acl", json: true });
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, run.err);
    assert.equal(doc.exitCode, EXIT_CODES.inconclusive);
    assert.equal(doc.verdict.status, "INCONCLUSIVE", run.err);
    assert.equal(doc.verdict.confirmToken, undefined);
    // Every spec that ran passed: the INCONCLUSIVE is the resolution's alone.
    assert.equal(doc.verdict.counts.blocking, 0);
    assert.match(doc.verdictReason ?? "", INCOMPLETE);
    assert.match(doc.verdictReason ?? "", DOWNGRADE);
    const warnings = doc.verdict.warnings ?? [];
    assert.ok(
      warnings.some((w) => INCOMPLETE.test(w)),
      JSON.stringify(warnings),
    );
    assert.ok(
      warnings.some((w) => RESOLVER_NOTE.test(w)),
      JSON.stringify(warnings),
    );
  });

  it("human: the report says INCONCLUSIVE, exit 5, and names the resolution gap", async () => {
    const run = await liveRun({ gap: "acl", json: false });
    assert.equal(run.code, EXIT_CODES.inconclusive, `${run.out}\n${run.err}`);
    assert.match(run.out, /VERDICT: INCONCLUSIVE/, run.out);
    assert.doesNotMatch(run.out, /VERDICT: GO/, run.out);
    assert.doesNotMatch(run.out, /confirm token|confirmToken/i, run.out);
    assert.match(
      run.out,
      /VERDICT: INCONCLUSIVE\n {2}reason: artifact resolution is incomplete/,
      run.out,
    );
    assert.match(run.out, DOWNGRADE, run.out);
    assert.match(run.out, RESOLVER_NOTE, run.out);
    assert.match(run.out, /exit: 5/, run.out);
  });

  it("a 403 on sys_script_include is INCONCLUSIVE (exit 5) and names the table, never a GO", async () => {
    const run = await liveRun({ gap: "deny", json: true });
    assert.equal(run.fired, 1, "the 403 was served to the resolver");
    const doc = JSON.parse(run.out);
    assert.equal(run.code, EXIT_CODES.inconclusive, run.err);
    assert.equal(doc.verdict.status, "INCONCLUSIVE");
    assert.equal(doc.verdict.confirmToken, undefined);
    assert.deepEqual(
      (doc.artifactTablesRefused ?? []).map((entry) => entry.table),
      [DENIED_TABLE],
    );
    assert.match(doc.artifactTablesRefused[0].reason, /read refused \(403\)/);
    assert.match(
      run.err,
      new RegExp(
        `warning: live artifact enumeration is incomplete — 1 of \\d+ table\\(s\\) refused.*${DENIED_TABLE}`,
      ),
      run.err,
    );
  });
});
