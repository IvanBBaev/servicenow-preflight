// The four run-state tools, end to end: a REAL `tess run --live` record on
// disk → a JSON-RPC session through `serve` → the delegated `tess status` /
// `confirm` / `cleanup` → bytes on the wire.
//
// `tools.test.js` and `results.test.js` pin the argv and the exit mapping one
// half at a time, against hand-written outcomes. What only this file can
// falsify is the join between them: that the record `tess run --live`
// actually leaves behind (`<root>/.tessera/runs/<runId>/events.jsonl` +
// `result.json`) is the record these tools read back, through the one
// composition root, with the run id round-tripping and the document on the
// wire being the one on disk.
//
// **Why a real run rather than a ledger written by hand.** The alternative —
// `createRunEventLog(...).writeResult(...)` with a fabricated payload — would
// test these tools against this file's idea of a live result, and the one
// thing `tess confirm` refuses is a result that is not `LIVE_RESULT_KIND`. So
// the GO and NO_GO records here come from `tess run --live` against the QA-18
// fake with the Tier-2 ATF engine installed, exactly as
// `cli/test/liveRun.test.js` produces them (fixture duplicated rather than
// shared, for the reason `server.test.js` gives). Only the in-flight run — a
// run that opened its §4b record and persisted no result — is written through
// `@tessera/ledger`'s public API, because "a run that has not finished" is not
// a state a finished `tess run` can be made to leave.
//
// **Every tool call happens with the instance unreachable** except the
// cleanup apply, where a recording fake runner stands behind `fetch` so that
// "NOTHING WAS DELETED" is asserted against what the runner was actually
// asked to do rather than against the wording alone.
//
// **On "the spawned argv".** The server does not spawn: `dispatch.ts` hands the
// argv to `@tessera/cli`'s `main` in-process, built by `toArgv(spec,
// validateArguments(spec, args).values)`. The argv assertions below rebuild it
// with those same two exported functions from the same call arguments, and
// the wire-level half is behavioural: the §11 knobs and `--ledger-root` are
// refused as protocol errors before anything runs, the record is found under
// the SERVER's working directory (no ledger root was sent), and the cleanup
// apply is refused by the guard even with `TESSERA_ALLOW` naming the runner —
// which it could not be if `--allow` had reached the argv.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { main } from "@tessera/cli";
import {
  createFakeInstance,
  W2_AUTHORING_CHANNEL_ACL_RULES,
  W2_AUTHORING_ROLE,
} from "@tessera/fake-instance";
import { createIntentLedger } from "@tessera/ledger";
import { createAtfExecutionEngine } from "@tessera/phase05";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";
import {
  AUTHORING_CHANNEL_VERSION,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
} from "@tessera/teststore-atf";

import {
  ERROR_CODES,
  LATEST_PROTOCOL_VERSION,
  findTool,
  serve,
  toArgv,
  validateArguments,
} from "../build/index.js";

// ── fixtures: the instance (cli/test/liveRun.test.js's, duplicated) ─────────

/** Non-prod marker + vendor domain: the §11.2 heuristic reads it as sub-prod. */
const RUNNER_HOST = "dev-mcp-live.service-now.com";

const hex = (prefix) => prefix.padEnd(32, "0");

const SCOPE_NAME = "x_tessera_live";
const SCOPE_ID = hex("5c0be");
const TARGET_ID = hex("a11ce");
const TARGET_NAME = "LiveDiscount";

const CORRECT_SOURCE = [
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

/** The seeded-bug half: `>` for `>=`, so the threshold assertion goes red. */
const MUTANT_SOURCE = CORRECT_SOURCE.replace(">= 100", "> 100");

function seed({ mutant = false } = {}) {
  return {
    sys_scope: [{ sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Tessera Live" }],
    sys_script_include: [
      {
        sys_id: TARGET_ID,
        name: TARGET_NAME,
        sys_name: TARGET_NAME,
        api_name: `${SCOPE_NAME}.${TARGET_NAME}`,
        sys_scope: SCOPE_ID,
        active: "true",
        script: mutant ? MUTANT_SOURCE : CORRECT_SOURCE,
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
  };
}

const SPEC_PATH = `${SCOPE_NAME}/sys_script_include/${TARGET_NAME}/${TARGET_NAME}.unit.ts`;

const GOOD_BODY = `(function (outputs, steps, params, stepResult, assertEqual) {
  var d = new LiveDiscount();
  assertEqual({ name: "below threshold pays full price", shouldbe: 990, value: d.apply(99, 10) });
  assertEqual({ name: "the threshold itself discounts", shouldbe: 900, value: d.apply(100, 10) });
})(outputs, steps, params, stepResult, assertEqual);
`;

async function writeTestsRoot(root) {
  const testsRoot = path.join(root, "tests");
  const file = path.join(testsRoot, SPEC_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, GOOD_BODY);
  await fs.writeFile(
    path.join(testsRoot, ".manifest.json"),
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  );
  return testsRoot;
}

// ── fixtures: the three recorded runs ───────────────────────────────────────

const GO_RUN = "mcp-e2e-go-0001";
const NO_GO_RUN = "mcp-e2e-nogo-0001";
/** Opened, never finished: no `result.json`, state `planned`. */
const IN_FLIGHT_RUN = "mcp-e2e-inflight-0001";

const NOW = () => new Date("2026-09-23T10:00:00.000Z");

/**
 * No local record and not the shape `tess run` mints, so the F2d gate refuses
 * an apply of it unless `--confirm-unrecorded` repeats it (decision 17).
 */
const UNRECORDED_RUN = "mcp-e2e-unrecorded-0001";

/**
 * The §11 knobs, the audit-trail flags and the F2d human confirmation no
 * run-state tool may send.
 */
const FORBIDDEN_FLAGS = [
  "--allow",
  "--prod",
  "--acknowledge-prod",
  "--ledger-root",
  "--actor",
  "--confirm-unrecorded",
];

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

// ── harness ─────────────────────────────────────────────────────────────────

/** Route `fetch` for RUNNER_HOST to `handler`; anything else is a failure. */
function routeFetch(handler) {
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
    return handler(input, init);
  };
}

/** From here on a request is a test failure: these tools answer from disk. */
function forbidFetch() {
  globalThis.fetch = () =>
    Promise.reject(new Error("a run-state read must not touch the network"));
}

/** `tess run --live --json` against a fresh fake; hands back the document. */
async function liveRun(root, testsRoot, runId, { mutant = false } = {}) {
  const fake = createFakeInstance({
    host: RUNNER_HOST,
    state: seed({ mutant }),
    acl: {
      roles: [W2_AUTHORING_ROLE],
      rules: W2_AUTHORING_CHANNEL_ACL_RULES,
    },
    cicdSuiteParams: ["test_suite_sys_id", "sys_id"],
  });
  routeFetch(createAtfExecutionEngine(fake));
  const out = [];
  const err = [];
  const code = await main(
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
      "--json",
    ],
    {
      now: NOW,
      actor: "test",
      cwd: root,
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  );
  return { code, document: JSON.parse(out.join("\n")), stderr: err };
}

/** sha256 of every file under `dir`, keyed by relative path. */
async function snapshot(dir) {
  const files = {};
  for (const entry of await fs.readdir(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    files[path.relative(dir, full)] = createHash("sha256")
      .update(await fs.readFile(full))
      .digest("hex");
  }
  return files;
}

const HELLO = {
  jsonrpc: "2.0",
  id: "init",
  method: "initialize",
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test-host", version: "0" },
  },
};

const READY = { jsonrpc: "2.0", method: "notifications/initialized" };

const toolCall = (name, args, id = "call") => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

/** The argv `dispatch.ts` hands to `main` for these arguments (see header). */
function argvFor(name, args) {
  const spec = findTool(name);
  assert.ok(spec, `no tool ${name}`);
  const validation = validateArguments(spec, args);
  assert.equal(validation.ok, true, validation.message);
  return toArgv(spec, validation.values);
}

function assertNoForbiddenFlag(argv) {
  for (const flag of FORBIDDEN_FLAGS) {
    assert.equal(argv.includes(flag), false, `${flag} in ${argv.join(" ")}`);
  }
}

// ── the suite ───────────────────────────────────────────────────────────────

describe("@tessera/mcp — run-state tools over a real `tess run --live` record", () => {
  let root;
  let ledgerRoot;
  let goRun;
  let noGoRun;
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const realFetch = globalThis.fetch;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-mcp-runstate-"));
    ledgerRoot = path.join(root, ".tessera");
    const testsRoot = await writeTestsRoot(root);

    for (const key of ENV_KEYS) delete process.env[key];
    process.env.SN_AUTH = "basic";
    process.env.SN_DOCS_DIR = path.join(root, "sn-docs");
    process.env.SN_MAX_RETRIES = "0";
    process.env.SN_PROFILE_RUNNER_INSTANCE = RUNNER_HOST;
    process.env.SN_PROFILE_RUNNER_USER = "tessera";
    process.env.SN_PROFILE_RUNNER_PASSWORD = "tessera";
    reloadCredentialsFromEnv();

    goRun = await liveRun(root, testsRoot, GO_RUN);
    assert.equal(goRun.code, 0, goRun.stderr.join("\n"));
    assert.equal(goRun.document.verdict.status, "GO");
    noGoRun = await liveRun(root, testsRoot, NO_GO_RUN, { mutant: true });
    assert.equal(noGoRun.code, 1, noGoRun.stderr.join("\n"));
    assert.equal(noGoRun.document.verdict.status, "NO_GO");

    await createIntentLedger({ rootDir: ledgerRoot, now: NOW }).openRun({
      runId: IN_FLIGHT_RUN,
      scope: SCOPE_NAME,
      runner: "runner",
      lifecycle: "ephemeral",
    });

    forbidFetch();
  });

  after(async () => {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadCredentialsFromEnv();
    if (root !== undefined) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /** One handshake plus `calls`, served with this root as the server's cwd. */
  async function session(calls, { env = {} } = {}) {
    const written = [];
    const logs = [];
    const body = `${[HELLO, READY, ...calls].map((m) => JSON.stringify(m)).join("\n")}\n`;
    await serve(
      {
        input: (async function* () {
          yield body;
        })(),
        write: (text) => written.push(text),
      },
      {
        now: NOW,
        actor: "test",
        cwd: root,
        env,
        log: (line) => logs.push(line),
      },
    );
    const responses = written.map((text) => JSON.parse(text));
    // One response per request, and every one of them a single line.
    assert.equal(responses.length, calls.length + 1, logs.join("\n"));
    return { responses: responses.slice(1), wire: written.join("\n") };
  }

  async function call(name, args, options) {
    const { responses, wire } = await session([toolCall(name, args)], options);
    return { response: responses[0], wire };
  }

  it("preflight_run_status reads the recorded run back, events and all", async () => {
    const args = { runId: GO_RUN };
    assert.deepEqual(argvFor("preflight_run_status", args), [
      "status",
      "--json",
      "--run-id",
      GO_RUN,
    ]);
    const before = await snapshot(ledgerRoot);

    const { response } = await call("preflight_run_status", args);

    assert.equal(response.error, undefined);
    const { result } = response;
    assert.equal(result.isError, false);
    const status = result.structuredContent;
    assert.deepEqual(JSON.parse(result.content[0].text), status);
    assert.equal(status.run.runId, GO_RUN);
    assert.equal(status.run.state, "done");
    assert.equal(status.run.scope, SCOPE_NAME);
    assert.equal(status.terminal, true);
    assert.deepEqual(status.result, {
      verdict: "GO",
      exitCode: 0,
      teardown: goRun.document.teardown,
      // `tess status --json` carries the record's completeness (wave 16);
      // a clean live run records a complete inventory.
      inventoryIncomplete: false,
    });

    // The events ARE the recorded log, line for line.
    const lines = (
      await fs.readFile(
        path.join(ledgerRoot, "runs", GO_RUN, "events.jsonl"),
        "utf8",
      )
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    assert.ok(lines.length > 0);
    assert.deepEqual(status.events, lines);
    assert.ok(status.events.every((event) => event.runId === GO_RUN));
    assert.equal(status.cursor, lines[lines.length - 1].cursor);
    assert.equal(status.lastCursor, status.cursor);

    // A read leaves the record byte-for-byte as it found it.
    assert.deepEqual(await snapshot(ledgerRoot), before);
  });

  it("preflight_run_status resumes from `since`: the cursor round-trips as an empty page", async () => {
    const first = await call("preflight_run_status", { runId: GO_RUN });
    const cursor = first.response.result.structuredContent.cursor;
    const args = { runId: GO_RUN, since: cursor };
    assert.deepEqual(argvFor("preflight_run_status", args), [
      "status",
      "--json",
      "--run-id",
      GO_RUN,
      "--since",
      String(cursor),
    ]);

    const { response } = await call("preflight_run_status", args);

    assert.equal(response.result.isError, false);
    assert.deepEqual(response.result.structuredContent.events, []);
    assert.equal(response.result.structuredContent.cursor, cursor);
    assert.equal(response.result.structuredContent.run.runId, GO_RUN);
  });

  it("preflight_confirm_ready relays a GO with the recorded verdict and its token", async () => {
    const args = { runId: GO_RUN };
    assert.deepEqual(argvFor("preflight_confirm_ready", args), [
      "confirm",
      "--json",
      "--run-id",
      GO_RUN,
    ]);
    const persisted = JSON.parse(
      await fs.readFile(
        path.join(ledgerRoot, "runs", GO_RUN, "result.json"),
        "utf8",
      ),
    );

    const { response } = await call("preflight_confirm_ready", args);

    assert.equal(response.error, undefined);
    const { result } = response;
    assert.equal(result.isError, false);
    // A GO carries no banner: the document, and nothing that reads as a caveat.
    assert.equal(result.content.length, 1);
    const doc = result.structuredContent;
    assert.deepEqual(JSON.parse(result.content[0].text), doc);
    assert.equal(doc.runId, GO_RUN);
    assert.equal(doc.exitCode, 0);
    assert.equal(doc.state, "done");
    // The document is the RECORDED one — on disk and as the run printed it.
    assert.equal(doc.persistedAt, persisted.at);
    assert.deepEqual(doc.verdict, persisted.result.verdict);
    assert.deepEqual(doc.verdict, goRun.document.verdict);
    assert.deepEqual(doc.failures, persisted.result.failures);
    assert.equal(doc.verdict.status, "GO");
    assert.equal(typeof doc.verdict.confirmToken.verdictHash, "string");
    assert.equal(
      doc.verdict.confirmToken.verdictHash,
      goRun.document.verdict.confirmToken.verdictHash,
    );
  });

  it("preflight_confirm_ready relays a recorded NO_GO as a verdict, document attached", async () => {
    const { response } = await call("preflight_confirm_ready", {
      runId: NO_GO_RUN,
    });

    const { result } = response;
    assert.equal(result.isError, true);
    const doc = result.structuredContent;
    assert.equal(doc.runId, NO_GO_RUN);
    assert.equal(doc.exitCode, 1);
    assert.equal(doc.verdict.status, "NO_GO");
    assert.deepEqual(doc.verdict, noGoRun.document.verdict);
    assert.equal(doc.verdict.confirmToken, undefined);
    assert.match(result.content[1].text, /NOT READY|NO_GO/);
  });

  it("preflight_confirm_ready on a run with no persisted result is exit 5 with the recorded-inconclusive banner", async () => {
    const { response } = await call("preflight_confirm_ready", {
      runId: IN_FLIGHT_RUN,
    });

    const { result } = response;
    // Exit 5 is not an error — and not clean either.
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, {
      runId: IN_FLIGHT_RUN,
      state: "planned",
      exitCode: 5,
    });
    const banner = result.content[1].text;
    assert.match(
      banner,
      /^INCONCLUSIVE \(exit 5\) — `tess confirm` read the run's record, and it does not confirm a verdict\./,
    );
    assert.match(banner, /Nothing was re-run to find out/);
    assert.match(banner, /Do not report the run as ready/);
    // Not the generic incomplete banner, which would send the caller looking
    // for `incomplete` / `notes` keys this document never carries.
    assert.doesNotMatch(banner, /INCOMPLETE/);
    // The CLI's own INCONCLUSIVE line arrives as diagnostics.
    assert.ok(
      result.content.some((block) =>
        /INCONCLUSIVE: run mcp-e2e-inflight-0001 is planned/.test(block.text),
      ),
    );
  });

  it("preflight_confirm_ready on an unknown run is a usage error, never an empty answer", async () => {
    const { response } = await call("preflight_confirm_ready", {
      runId: "mcp-e2e-no-such-run",
    });

    assert.equal(response.result.isError, true);
    assert.equal("structuredContent" in response.result, false);
    assert.match(response.result.content[0].text, /INVALID REQUEST \(exit 2\)/);
    assert.match(
      response.result.content[1].text,
      /no run "mcp-e2e-no-such-run"/,
    );
  });

  it("preflight_cleanup_plan plans the recorded run's teardown and deletes nothing", async () => {
    const args = { runId: GO_RUN, runner: "runner" };
    const argv = argvFor("preflight_cleanup_plan", args);
    assert.deepEqual(argv, [
      "cleanup",
      "--json",
      "--mode",
      "plan",
      "--run-id",
      GO_RUN,
      "--runner",
      "runner",
    ]);
    assertNoForbiddenFlag(argv);
    const before = await snapshot(ledgerRoot);

    const { response } = await call("preflight_cleanup_plan", args);

    assert.equal(response.result.isError, false);
    const plan = response.result.structuredContent;
    assert.equal(plan.runId, GO_RUN);
    assert.equal(plan.mode, "plan");
    assert.equal(plan.runner, "runner");
    assert.equal(plan.runnerHost, RUNNER_HOST);
    assert.equal(plan.namespace, `${GO_RUN}:`);
    // The run tore itself down: it is `done`, so there is no transition left.
    assert.equal(plan.localState, "done");
    assert.deepEqual(plan.transitions, []);
    assert.equal(typeof plan.ledgerEntriesToSettle, "number");
    assert.deepEqual(await snapshot(ledgerRoot), before);
  });

  it("preflight_cleanup_plan refuses an in-flight run (DEV-17) with the lifecycle reading, not the §11 one", async () => {
    const { response } = await call("preflight_cleanup_plan", {
      runId: IN_FLIGHT_RUN,
      runner: "runner",
    });

    const { result } = response;
    assert.equal(result.isError, true);
    assert.equal("structuredContent" in result, false);
    assert.match(
      result.content[0].text,
      /^REFUSED \(exit 4\) — `tess cleanup` declined before it acted\./,
    );
    assert.match(result.content[0].text, /NOTHING WAS DELETED/);
    assert.doesNotMatch(result.content[0].text, /§11/);
    assert.ok(
      result.content.some((block) =>
        /REFUSED \(DEV-17\): run mcp-e2e-inflight-0001 is planned/.test(
          block.text,
        ),
      ),
    );
  });

  it("preflight_cleanup_apply is REFUSED today — NOTHING WAS DELETED — even with TESSERA_ALLOW naming the runner", async () => {
    const args = { mode: "apply", runId: GO_RUN, runner: "runner" };
    const argv = argvFor("preflight_cleanup_apply", args);
    assert.deepEqual(argv, [
      "cleanup",
      "--json",
      "--mode",
      "apply",
      "--run-id",
      GO_RUN,
      "--runner",
      "runner",
    ]);
    assertNoForbiddenFlag(argv);

    // A recording runner, so "nothing was deleted" is a fact about requests.
    const runner = createFakeInstance({ host: RUNNER_HOST, state: seed() });
    routeFetch((input, init) => runner.fetch(input, init));
    let response;
    try {
      ({ response } = await call("preflight_cleanup_apply", args, {
        env: { TESSERA_ALLOW: RUNNER_HOST },
      }));
    } finally {
      forbidFetch();
    }

    const { result } = response;
    assert.equal(result.isError, true);
    assert.equal("structuredContent" in result, false);
    assert.match(result.content[0].text, /^REFUSED \(exit 4\)/);
    assert.match(result.content[0].text, /NOTHING WAS DELETED/);
    assert.deepEqual(
      runner.requests().filter((entry) => entry.method !== "GET"),
      [],
    );
    // The run the refusal was about is exactly as the run left it.
    const status = await call("preflight_run_status", { runId: GO_RUN });
    assert.equal(status.response.result.structuredContent.run.state, "done");
    assert.equal(
      status.response.result.structuredContent.events.some(
        (event) => event.type === "cleanup",
      ),
      false,
    );
  });

  it("an unrecorded, non-minted run: the plan says the apply will refuse, and the apply does — nothing contacted", async () => {
    const planArgs = { runId: UNRECORDED_RUN, runner: "runner" };
    assertNoForbiddenFlag(argvFor("preflight_cleanup_plan", planArgs));
    const plan = await call("preflight_cleanup_plan", planArgs);
    assert.equal(plan.response.result.isError, false);
    assert.equal(plan.response.result.structuredContent.localState, null);
    assert.equal(
      plan.response.result.structuredContent.unrecordedSweep,
      "refused",
    );

    // The F2d gate refuses before any instance is contacted, so the fetch
    // stays forbidden: a request would fail the call as a fault (exit 3).
    const applyArgs = { mode: "apply", ...planArgs };
    assertNoForbiddenFlag(argvFor("preflight_cleanup_apply", applyArgs));
    const before = await snapshot(ledgerRoot);
    const { response } = await call("preflight_cleanup_apply", applyArgs, {
      env: { TESSERA_ALLOW: RUNNER_HOST },
    });

    const { result } = response;
    assert.equal(result.isError, true);
    assert.equal("structuredContent" in result, false);
    assert.match(result.content[0].text, /^REFUSED \(exit 4\)/);
    assert.match(result.content[0].text, /NOTHING WAS DELETED/);
    // The reading owns up to the CLI's remedy having no counterpart here.
    assert.match(
      result.content[0].text,
      /`--confirm-unrecorded`[^.]*has no counterpart here/,
    );
    assert.ok(
      result.content.some((block) =>
        /REFUSED \(unrecorded namespace\)/.test(block.text),
      ),
    );
    assert.deepEqual(await snapshot(ledgerRoot), before);
  });

  it("no cleanup tool accepts the F2d confirmation, in any spelling or type", async () => {
    const spellings = [
      ["confirmUnrecorded", UNRECORDED_RUN],
      ["confirmUnrecorded", true],
      ["confirm_unrecorded", UNRECORDED_RUN],
      ["confirm-unrecorded", UNRECORDED_RUN],
      ["--confirm-unrecorded", UNRECORDED_RUN],
    ];
    const calls = [];
    for (const [name, args] of [
      ["preflight_cleanup_plan", { runId: UNRECORDED_RUN }],
      ["preflight_cleanup_apply", { mode: "apply", runId: UNRECORDED_RUN }],
    ]) {
      spellings.forEach(([key, value], index) => {
        calls.push(
          toolCall(name, { ...args, [key]: value }, `${name}:${index}`),
        );
      });
    }

    const { responses } = await session(calls);

    assert.equal(responses.length, calls.length);
    for (const response of responses) {
      const [key] = spellings[Number(response.id.split(":")[1])];
      assert.equal(response.result, undefined, `${response.id} ran`);
      assert.equal(response.error.code, ERROR_CODES.invalidParams);
      assert.ok(
        response.error.message.includes(`unknown argument \`${key}\``),
        response.error.message,
      );
    }
  });

  it("preflight_cleanup_legacy_plan inventories pre-marker rows with GETs only (decision 18)", async () => {
    const args = { runner: "runner", runIds: ["bench-01"] };
    const argv = argvFor("preflight_cleanup_legacy_plan", args);
    assert.deepEqual(argv, [
      "cleanup",
      "--json",
      "--legacy",
      "--mode",
      "plan",
      "--runner",
      "runner",
      "--run-id",
      "bench-01",
    ]);
    assertNoForbiddenFlag(argv);

    const legacyTest = "a".repeat(32);
    const explicitTest = "b".repeat(32);
    const runner = createFakeInstance({
      host: RUNNER_HOST,
      state: {
        ...seed(),
        sys_atf_test: [
          {
            sys_id: legacyTest,
            name: "run-20260920t101500-abcdef01:alpha",
            description: "projected from spec alpha",
          },
          {
            sys_id: explicitTest,
            name: "bench-01:beta",
            description: "projected by a benchmark",
          },
          { sys_id: "c".repeat(32), name: "smoke:login", description: "x" },
        ],
      },
    });
    routeFetch((input, init) => runner.fetch(input, init));
    const before = await snapshot(ledgerRoot);
    let response;
    try {
      ({ response } = await call("preflight_cleanup_legacy_plan", args));
    } finally {
      forbidFetch();
    }

    const { result } = response;
    assert.equal(result.isError, false, result.content?.[0]?.text);
    const report = result.structuredContent;
    assert.equal(report.kind, "tessera.atf-legacy-report/v1");
    assert.deepEqual(report.candidates.map((c) => c.sysId).sort(), [
      legacyTest,
      explicitTest,
    ]);
    // An inventory, not a cleanup: the runner saw reads only, and the local
    // record is untouched.
    assert.ok(runner.requests().length > 0);
    assert.deepEqual(
      runner.requests().filter((entry) => entry.method !== "GET"),
      [],
    );
    assert.deepEqual(await snapshot(ledgerRoot), before);
  });

  it("no tool accepts the legacy apply's report or confirmation", async () => {
    const calls = [
      { confirm: "a".repeat(32) },
      { report: "legacy.json" },
      { mode: "apply" },
      { sysIds: ["a".repeat(32)] },
    ].map((extra, index) =>
      toolCall(
        "preflight_cleanup_legacy_plan",
        { runner: "runner", ...extra },
        `legacy:${index}`,
      ),
    );
    const { responses } = await session(calls);
    assert.equal(responses.length, calls.length);
    for (const response of responses) {
      assert.equal(response.result, undefined, `${response.id} ran`);
      assert.equal(response.error.code, ERROR_CODES.invalidParams);
      assert.match(response.error.message, /unknown argument/);
    }
  });

  it("no run-state tool accepts a §11 knob or a ledger root as an argument", async () => {
    const cases = [
      ["preflight_run_status", { runId: GO_RUN }],
      ["preflight_confirm_ready", { runId: GO_RUN }],
      ["preflight_cleanup_plan", { runId: GO_RUN, runner: "runner" }],
      [
        "preflight_cleanup_apply",
        { mode: "apply", runId: GO_RUN, runner: "runner" },
      ],
    ];
    const knobs = {
      allow: RUNNER_HOST,
      prod: RUNNER_HOST,
      acknowledgeProd: "because",
      ledgerRoot: root,
      actor: "someone-else",
    };
    const calls = [];
    for (const [name, args] of cases) {
      assertNoForbiddenFlag(argvFor(name, args));
      for (const [knob, value] of Object.entries(knobs)) {
        calls.push(
          toolCall(name, { ...args, [knob]: value }, `${name}:${knob}`),
        );
      }
    }

    const { responses } = await session(calls);

    assert.equal(responses.length, calls.length);
    for (const response of responses) {
      const knob = response.id.split(":")[1];
      assert.equal(response.result, undefined, `${response.id} ran`);
      assert.equal(response.error.code, ERROR_CODES.invalidParams);
      assert.match(
        response.error.message,
        new RegExp(`unknown argument \`${knob}\``),
      );
    }
  });
});
