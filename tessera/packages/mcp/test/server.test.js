// The MCP server, end to end: bytes on stdin → a delegated `tess` run against
// the QA-18 fake → bytes on stdout.
//
// `tools.test.js` proves the contract is derived from one list. This file proves
// the two things that list cannot: that a message reaches the ONE composition
// root (ARCH-1) rather than a second wiring of the pipeline, and that every way
// a run can fail arrives as something a model cannot read as an empty answer.
//
// Five properties are the whole contract, and each has its own section.
//
//   * **stdout is the protocol.** Every response is exactly one line; the
//     delegated command's own report never lands on the channel; a chunked or
//     unterminated stream is framed the same as a tidy one.
//   * **A failure is never an empty answer** (DEV-1). Exits 2, 3 and 4 produce
//     `isError: true` with NO `structuredContent` — asserted as the ABSENCE of
//     the key, because a caller destructuring `counts.nodes` out of a fault is
//     precisely the failure this package exists to prevent.
//   * **Exit 5 is not an error, and is not clean either.** The report comes
//     through, and it comes through carrying a banner that names the shortfall
//     the way THAT report names it. Not always `incomplete: true`, which is what
//     this line used to promise: `resolve` and its neighbours publish
//     `incomplete` and `notes`, while `doctor` and `preflight` publish neither
//     and carry the same fact in an undecided roll-up `status`. The banner is
//     asserted against both shapes below, because a sentence true of one shape
//     and printed over the other sends a caller to a key nobody wrote.
//   * **TM-1 survives the third output surface.** A canary in a script body must
//     not appear anywhere in the serialised session — not in a result, not in a
//     diagnostics block, not in an error message.
//   * **The one mutating tool is guarded by the thing it delegates to.** The §11
//     TargetGuard lives behind `main`, so the assertions here are about what
//     reaches the wire either way: a refusal that reads as a refusal, and — on
//     EVERY apply path, refused or not — `writes(runner)` still empty. A guard
//     test that only checked the exit code would pass with the write landed.
//
// Two instances stand behind a host-dispatching `fetch`, because the preflight
// tools bind the RUNNER role and the analysis tools bind the SOURCE role, and a
// single fake answering both would let a topology bug pass unnoticed.
//
// The source fixture is `cli/test/coverage.test.js`'s and the runner fixture is
// `cli/test/preflight.test.js`'s, both deliberately duplicated rather than
// exported: those scripts and properties are tuned to falsify claims about the
// analyzer and the doctor, and a shared fixture would make an edit for either
// suite silently change what this one is testing.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import {
  ERROR_CODES,
  LATEST_PROTOCOL_VERSION,
  SERVER_INFO,
  serve,
  TOOLS,
} from "../build/index.js";

// ── fixtures: the instance ──────────────────────────────────────────────────

const SOURCE_HOST = "dev-mcp-source.service-now.com";

/**
 * The runner lives on its own host, and the name is not decoration: §11.2 reads
 * the first label for a non-prod marker, so a host without one would make every
 * apply test below refuse for the wrong reason.
 */
const RUNNER_HOST = "dev-mcp-runner.service-now.com";

/** A 32-character lowercase-hex sys_id that stays readable in a diff. */
const hex = (prefix) => prefix.padEnd(32, "0");

const SCOPE_NAME = "x_tessera_demo";
const SCOPE_ID = hex("5c09e");

const AMOUNT_ID = hex("aaa1");
const TOTALS_ID = hex("bbb2");
const RULE_ID = hex("ccc3");
const ACTION_ID = hex("ddd4");

/**
 * A string that exists only inside a script body. TM-1 says a body is
 * attacker-authored text; the assertion that matters is not "the result is tidy"
 * but "this exact sequence of characters never reached stdout".
 */
const CANARY = "canary-9f31-never-print-this";

const AMOUNT_SCRIPT = [
  "var AmountCalculator = Class.create();",
  "AmountCalculator.prototype = {",
  "  total: function (items) {",
  "    return items.length;",
  "  },",
  "};",
].join("\n");

const TOTALS_SCRIPT = [
  `// ${CANARY}: this line must never reach a tool result`,
  "var OrderTotals = Class.create();",
  "OrderTotals.prototype = {",
  "  sum: function (order) {",
  "    return new AmountCalculator().total(order.items);",
  "  },",
  "};",
].join("\n");

const RULE_SCRIPT = [
  "(function executeRule(current, previous) {",
  "  var calculator = AmountCalculator;",
  "  current.total = calculator.total(current.items);",
  "})(current, previous);",
].join("\n");

const ACTION_SCRIPT = [
  "// TODO: call AmountCalculator here instead of duplicating the maths",
  "current.total = current.items.length;",
].join("\n");

/**
 * Two Script Includes the scope adapter enumerates and two consumers that earn
 * an edge — four impacted artifacts, the denominator every count below is
 * stated against.
 */
function seed() {
  const include = (sysId, name, script) => ({
    sys_id: sysId,
    name,
    sys_name: name,
    sys_scope: SCOPE_ID,
    script,
  });

  return {
    sys_scope: [{ sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Tessera Demo" }],
    sys_script_include: [
      include(AMOUNT_ID, "AmountCalculator", AMOUNT_SCRIPT),
      include(TOTALS_ID, "OrderTotals", TOTALS_SCRIPT),
    ],
    sys_script: [
      {
        sys_id: RULE_ID,
        name: "Recalculate totals",
        sys_name: "Recalculate totals",
        sys_scope: SCOPE_ID,
        script: RULE_SCRIPT,
      },
    ],
    sys_ui_action: [
      {
        sys_id: ACTION_ID,
        name: "Recalculate",
        sys_name: "Recalculate",
        sys_scope: SCOPE_ID,
        script: ACTION_SCRIPT,
      },
    ],
  };
}

// ── fixtures: the runner instance ───────────────────────────────────────────

const ATF_RUNNER_PROPERTY = "sn_atf.runner.enabled";
const PRODUCTION_PROPERTY = "glide.installation.production";

/**
 * The two `sys_properties` rows the doctor and the §11.2 guard probe read, and
 * nothing else. No ATF records: an unseeded table still answers 200 with an
 * empty result set, which is exactly the "readable" the doctor asks about.
 */
function runnerSeed({ atfRunner = true, production = false } = {}) {
  return {
    sys_properties: [
      { name: ATF_RUNNER_PROPERTY, value: String(atfRunner) },
      { name: PRODUCTION_PROPERTY, value: String(production) },
    ],
  };
}

// ── fixtures: the repo ──────────────────────────────────────────────────────

const AMOUNT_SPEC_PATH =
  "x_tessera_demo/sys_script_include/AmountCalculator/AmountCalculator.unit.ts";

/** One registered spec, so the clean run has one declared artifact and three gaps. */
const ONE_SPEC = {
  manifest: {
    version: 1,
    specs: [
      {
        id: "amount-unit",
        path: AMOUNT_SPEC_PATH,
        kind: "unit",
        targets: [
          {
            table: "sys_script_include",
            sysId: AMOUNT_ID,
            name: "AmountCalculator",
          },
        ],
      },
    ],
  },
  files: [AMOUNT_SPEC_PATH],
};

/** Everything the vendored transport reads, staged and restored per test. */
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
  "SN_PROFILE_SOURCE_INSTANCE",
  "SN_PROFILE_SOURCE_USER",
  "SN_PROFILE_SOURCE_PASSWORD",
];

// ── harness ─────────────────────────────────────────────────────────────────

const tempRoots = [];

async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-mcp-"));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function writeTestsRoot(root, { dir = "tests", manifest, files = [] }) {
  const testsRoot = path.join(root, dir);
  await fs.mkdir(testsRoot, { recursive: true });
  for (const file of files) {
    const full = path.join(testsRoot, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, "// a spec body the inventory never opens\n");
  }
  if (manifest !== undefined) {
    await fs.writeFile(
      path.join(testsRoot, ".manifest.json"),
      typeof manifest === "string"
        ? manifest
        : `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  return testsRoot;
}

/**
 * Stand the two instances up behind a host-dispatching `fetch`, stage the two
 * credential profiles they answer to, and hand back an injectable
 * `ServerContext`.
 *
 * The dispatcher is hand-written rather than `fake.install()` because the fake
 * resolves relative URLs against its own host but otherwise ignores the
 * hostname — installed directly, both profiles would reach the same instance
 * and a topology that had collapsed would still look right.
 *
 * No `default` profile is configured, on purpose: if the profile binding ever
 * stopped working, every read has to fail rather than be served from whatever
 * instance happens to be ambient (ARCH-19).
 */
async function harness(options = {}) {
  const fake = createFakeInstance({ host: SOURCE_HOST, state: seed() });
  for (const rule of options.faults ?? []) fake.faults.add(rule);

  const runner = createFakeInstance({
    host: RUNNER_HOST,
    state: runnerSeed(options.runner ?? {}),
  });
  for (const rule of options.runnerFaults ?? []) runner.faults.add(rule);

  const routes = { [SOURCE_HOST]: fake, [RUNNER_HOST]: runner };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const instance = routes[new URL(href).host];
    if (instance === undefined) {
      return Promise.reject(new Error(`no fake instance for ${href}`));
    }
    return instance.fetch(input, init);
  };

  const root = await tempRoot();
  const testsRoot =
    options.specs === undefined
      ? undefined
      : await writeTestsRoot(root, options.specs);

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(root, "sn-docs");
  process.env.SN_MAX_RETRIES = "0";
  // `tess run` takes a HOST rather than a profile name (see `RUN_INSTANCE_FIELD`
  // in `tools.ts`), so it resolves the DEFAULT credentials instead of a
  // profile's. Opt-in rather than always on: no other tool here may reach an
  // instance without naming a profile, and an ambient default credential would
  // hide it if one ever did (ARCH-19, the same reason there is no `default`
  // profile above).
  if (options.credentials === true) {
    process.env.SN_USER = "tessera";
    process.env.SN_PASSWORD = "tessera";
  }
  process.env.SN_PROFILE_SOURCE_INSTANCE = SOURCE_HOST;
  process.env.SN_PROFILE_SOURCE_USER = "tessera";
  process.env.SN_PROFILE_SOURCE_PASSWORD = "tessera";
  process.env.SN_PROFILE_RUNNER_INSTANCE = RUNNER_HOST;
  process.env.SN_PROFILE_RUNNER_USER = "tessera";
  process.env.SN_PROFILE_RUNNER_PASSWORD = "tessera";
  reloadCredentialsFromEnv();

  const logs = [];
  return {
    fake,
    runner,
    root,
    testsRoot,
    logs,
    /** Diagnostics the server wrote to its stderr channel. */
    log: () => logs.join("\n"),
    server: {
      now: () => new Date("2026-02-02T03:04:05.000Z"),
      actor: "test",
      cwd: root,
      env: options.env ?? {},
      log: (line) => logs.push(line),
    },
    restore() {
      globalThis.fetch = realFetch;
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

/** Feed the whole stream at once, or in fixed-size slices when asked. */
async function* chunksOf(text, size) {
  if (size === undefined) {
    yield text;
    return;
  }
  for (let index = 0; index < text.length; index += size) {
    yield text.slice(index, index + size);
  }
}

const line = (message) =>
  typeof message === "string" ? message : JSON.stringify(message);

/**
 * Drive one session and hand back everything that came out of it.
 *
 * `terminated: false` drops the final newline, which is the case a host that
 * closes the pipe after its last message produces.
 */
async function speak(messages, options = {}) {
  const h = await harness(options);
  const written = [];
  const body =
    messages.map(line).join("\n") + (options.terminated === false ? "" : "\n");

  try {
    await serve(
      {
        input: chunksOf(body, options.chunkSize),
        write: (text) => written.push(text),
      },
      h.server,
    );
  } finally {
    h.restore();
  }

  return {
    h,
    written,
    /** The raw session as it went over the wire — what TM-1 is asserted against. */
    wire: () => written.join("\n"),
    responses: written.map((text) => JSON.parse(text)),
  };
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

const request = (method, params, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

const callTool = (name, args, id = "call") =>
  request("tools/call", { name, arguments: args }, id);

/** The handshake plus one message; the reply to that message is `last`. */
async function session(messages, options = {}) {
  const result = await speak([HELLO, READY, ...messages], options);
  return { ...result, last: result.responses[result.responses.length - 1] };
}

const IMPACT_ARGS = { source: "source", scope: SCOPE_NAME };

/** The runner-role arguments the two preflight tools take. */
const PLAN_ARGS = { runner: "runner" };

/** The same profile, reaching `tess doctor --instance` (see `tools.ts`). */
const DOCTOR_ARGS = { runner: "runner" };

/** Every HTTP method the fake served — these tools may only ever produce GET. */
function methods(fake) {
  return [...new Set(fake.requests().map((entry) => entry.method))].sort();
}

/**
 * Every non-GET the fake served — i.e. every mutation that was ATTEMPTED. The
 * claim "nothing was written" is only falsifiable against a stateful fake that
 * records what it was asked to do, so every apply path below asserts it.
 */
function writes(fake) {
  return fake.requests().filter((entry) => entry.method !== "GET");
}

/** A GET fault on one table, expressed the way the fault registry wants it. */
function faultOn(table, mode) {
  return { match: { method: "GET", table }, mode };
}

// ── the handshake ───────────────────────────────────────────────────────────

describe("@tessera/mcp — the handshake", () => {
  it("echoes a supported revision and declares the tools primitive alone", async () => {
    const { responses } = await speak([HELLO, READY]);

    // TWO messages in, ONE response out: `notifications/initialized` is a
    // notification, and a notification is never answered.
    assert.equal(responses.length, 1);

    const { result } = responses[0];
    assert.equal(responses[0].id, "init");
    assert.equal(result.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(result.serverInfo, { ...SERVER_INFO });
    // DR-6: declaring a primitive this server does not implement is how a host
    // discovers it the expensive way.
    assert.equal("resources" in result.capabilities, false);
    assert.equal("prompts" in result.capabilities, false);
  });

  it("puts every reading rule in the instructions", async () => {
    const { responses } = await speak([HELLO]);
    const { instructions } = responses[0].result;

    assert.match(instructions, /READ-ONLY/);
    assert.match(instructions, /An error is never an empty answer.*DEV-1/s);
    assert.match(
      instructions,
      /DECLARED INTENT, not confirmed coverage.*QA-8/s,
    );
  });

  it("says which tool writes before any tool list is rendered", async () => {
    const { responses } = await speak([HELLO]);
    const { instructions } = responses[0].result;

    // The handshake is the earliest moment a host can learn this, and learning
    // it by calling the tool is the outcome the whole `writeClass` machinery
    // exists to prevent.
    assert.match(instructions, /preflight_apply is the exception: it WRITES/);
    assert.match(instructions, /REFUSED means NOTHING WAS WRITTEN/);
    // And that a refusal is not a lock an argument can pick.
    assert.match(
      instructions,
      /nothing you can pass as a tool argument lifts it/,
    );
  });

  it("negotiates down to the newest revision it speaks when asked for another", async () => {
    const { responses } = await speak([
      { ...HELLO, params: { ...HELLO.params, protocolVersion: "1999-01-01" } },
    ]);

    // Offered rather than refused: the specification lets the client decide
    // whether it can live with the answer, and this server never claims to
    // speak a revision it does not.
    assert.equal(responses[0].result.protocolVersion, LATEST_PROTOCOL_VERSION);
  });

  it("still speaks an older revision when the client asks for one", async () => {
    const { responses } = await speak([
      { ...HELLO, params: { ...HELLO.params, protocolVersion: "2024-11-05" } },
    ]);

    assert.equal(responses[0].result.protocolVersion, "2024-11-05");
  });

  it("refuses everything except ping before initialize", async () => {
    const { responses } = await speak([
      request("tools/list", {}, 7),
      request("ping", {}, 8),
    ]);

    assert.equal(responses[0].id, 7);
    assert.equal(responses[0].error.code, ERROR_CODES.invalidRequest);
    assert.match(responses[0].error.message, /before `initialize`/);
    // A liveness check that requires liveness to have been established is useless.
    assert.deepEqual(responses[1].result, {});
  });

  it("answers an unimplemented method with method-not-found, naming the reason", async () => {
    const { last } = await session([request("resources/list", {}, 9)]);

    assert.equal(last.error.code, ERROR_CODES.methodNotFound);
    assert.match(last.error.message, /tools primitive only \(DR-6\)/);
  });
});

// ── framing ─────────────────────────────────────────────────────────────────

describe("@tessera/mcp — framing", () => {
  it("reassembles messages split across arbitrary chunk boundaries", async () => {
    const { responses } = await speak(
      [HELLO, READY, request("tools/list", {}, 3)],
      {
        chunkSize: 7,
      },
    );

    assert.equal(responses.length, 2);
    assert.equal(responses[1].result.tools.length, TOOLS.length);
  });

  it("processes a final message the host never terminated", async () => {
    const { responses } = await speak([HELLO], { terminated: false });

    // A host that closes the pipe after writing its last message has SENT that
    // message; dropping it would look exactly like the server hanging.
    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, "init");
  });

  it("tolerates CRLF and blank lines", async () => {
    const { responses } = await speak([
      `${JSON.stringify(HELLO)}\r`,
      "",
      "   ",
    ]);

    assert.equal(responses.length, 1);
    assert.equal(responses[0].result.protocolVersion, LATEST_PROTOCOL_VERSION);
  });

  it("answers unparseable input at a null id", async () => {
    const { responses } = await speak(["{not json"]);

    assert.equal(responses[0].id, null);
    assert.equal(responses[0].error.code, ERROR_CODES.parse);
  });

  it("refuses a batch and says which revision removed it", async () => {
    const { responses } = await speak([JSON.stringify([HELLO])]);

    assert.equal(responses[0].error.code, ERROR_CODES.invalidRequest);
    assert.match(responses[0].error.message, /batches are not supported/);
    assert.match(responses[0].error.message, /2025-06-18/);
  });

  it("refuses a null id rather than treating it as a notification", async () => {
    const { responses } = await speak([{ ...HELLO, id: null }]);

    assert.equal(responses[0].error.code, ERROR_CODES.invalidRequest);
    assert.match(responses[0].error.message, /MCP forbids a null id/);
  });

  it("refuses positional params", async () => {
    const { responses } = await speak([
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: ["x"] },
    ]);

    assert.equal(responses[0].id, 4);
    assert.equal(responses[0].error.code, ERROR_CODES.invalidParams);
  });

  it("ignores an unknown notification without answering it", async () => {
    const { responses } = await session([
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      },
    ]);

    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, "init");
  });

  it("drops a malformed notification silently, and logs it", async () => {
    // Delegated decision 2026-09-25: a message with no `id` member is a
    // notification even when malformed, and JSON-RPC forbids answering one.
    const { h, responses } = await session([
      { jsonrpc: "1.0", method: "notifications/foo" },
      { jsonrpc: "2.0" },
      { jsonrpc: "2.0", method: "notifications/foo", params: ["x"] },
    ]);

    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, "init");
    assert.match(h.log(), /dropping a malformed message sent without an id/);
  });

  it("still answers a malformed request that carries an id", async () => {
    const { responses } = await speak([{ jsonrpc: "1.0", id: 7, method: "x" }]);

    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 7);
    assert.equal(responses[0].error.code, ERROR_CODES.invalidRequest);
  });

  it("drops an id-less tools/call before it can charge the operator a search", async () => {
    const { h, responses } = await session([
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "preflight_impact" },
      },
    ]);

    // The rule is JSON-RPC's, and here it is load-bearing: answering would be
    // impossible, so running would mean a full where-used search against a live
    // instance whose answer is then thrown away.
    assert.equal(responses.length, 1);
    assert.deepEqual(h.fake.requests(), []);
    assert.match(h.log(), /sent without an id/);
  });
});

// ── tools/list ──────────────────────────────────────────────────────────────

describe("@tessera/mcp — tools/list", () => {
  it("advertises exactly the intended thirteen tools, with closed schemas", async () => {
    const { last } = await session([request("tools/list", {}, 3)]);

    // Pinned as a list rather than a count: a fourteenth tool appearing here is a
    // new capability handed to every host that has ever connected, and it must
    // not be possible to ship one without this line changing.
    assert.deepEqual(
      last.result.tools.map((tool) => tool.name),
      [
        "preflight_resolve",
        "preflight_impact",
        "preflight_coverage",
        "preflight_generate",
        "preflight_doctor",
        "preflight_plan",
        "preflight_apply",
        "preflight_run",
        "preflight_run_status",
        "preflight_confirm_ready",
        "preflight_cleanup_plan",
        "preflight_cleanup_apply",
        "preflight_cleanup_legacy_plan",
      ],
    );
    // The three run-state reads touch only local files (decision 16).
    const localOnly = new Set([
      "preflight_run_status",
      "preflight_confirm_ready",
      "preflight_cleanup_plan",
    ]);
    for (const tool of last.result.tools) {
      assert.equal(tool.annotations.openWorldHint, !localOnly.has(tool.name));
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    // No `nextCursor`: the list is a handful of entries and fits in one page.
    assert.equal("nextCursor" in last.result, false);
  });

  it("declares which of them writes, in the listing itself", async () => {
    const { last } = await session([request("tools/list", {}, 3)]);

    const byName = new Map(last.result.tools.map((tool) => [tool.name, tool]));
    const mutating = last.result.tools.filter(
      (tool) => tool.annotations.readOnlyHint === false,
    );

    // Four tools write, they are the four named for it, and a host learns
    // that from the listing rather than from the aftermath of a call. They
    // write different things: three an instance (one of them by deleting),
    // one the working copy.
    assert.deepEqual(
      mutating.map((tool) => tool.name),
      [
        "preflight_generate",
        "preflight_apply",
        "preflight_run",
        "preflight_cleanup_apply",
      ],
    );
    const apply = byName.get("preflight_apply");
    assert.equal(apply.annotations.destructiveHint, true);
    // A key makes a retry a replay only for the caller who sends one, so the
    // tool as a whole is still not advertised idempotent.
    assert.equal(apply.annotations.idempotentHint, false);
    assert.match(apply.title, /WRITES/);
    assert.match(apply.description, /^THIS TOOL WRITES\./);
    // And the privileged word is a one-value enum, not an open text box.
    assert.deepEqual(apply.inputSchema.required, ["mode"]);
    assert.deepEqual(apply.inputSchema.properties.mode.enum, ["apply"]);

    // Its read-only twin says the opposite, and says why it cannot drift.
    const plan = byName.get("preflight_plan");
    assert.equal(plan.annotations.readOnlyHint, true);
    assert.equal("mode" in plan.inputSchema.properties, false);
    assert.match(plan.description, /NOTHING IS WRITTEN/);
  });

  it("declares generation's egress in the listing, not on the wire after it", async () => {
    const { last, h } = await session([request("tools/list", {}, 3)]);

    const generate = last.result.tools.find(
      (tool) => tool.name === "preflight_generate",
    );

    // Everything an operator would want to know BEFORE the first call: that it
    // writes files, that instance-derived text can leave the machine, and that
    // whether it does is their configuration rather than the caller's argument.
    assert.match(generate.title, /WRITES the repo, MAY transmit off-box/);
    assert.match(generate.description, /^THIS TOOL WRITES FILES/);
    assert.match(
      generate.description,
      /SEND INSTANCE CONTENT TO A THIRD PARTY/,
    );
    assert.match(generate.description, /the artifact NAMES/);
    assert.match(generate.description, /none of them is an argument of this/);
    // Listing costs nothing and reveals it anyway — no call, no instance read.
    assert.deepEqual(h.fake.requests(), []);
  });

  it("puts the same egress warning in the handshake, before any tool list", async () => {
    // A host that reads `instructions` and never renders a description still
    // learns it, because the alternative is discovering egress by having done
    // it. The apply tool's rules are checked here too, so a rewrite of this
    // block cannot quietly drop one of them.
    const { responses } = await speak([HELLO]);
    const instructions = responses[0].result.instructions;

    assert.match(instructions, /MAY SEND INSTANCE CONTENT OFF THIS MACHINE/);
    assert.match(instructions, /WRITES FILES into the repository/);
    assert.match(instructions, /a call cannot switch it on or redirect it/);
    assert.match(instructions, /PROPOSAL, not a test/);
    assert.match(instructions, /DEV-4/);
    assert.match(instructions, /REFUSED means NOTHING WAS WRITTEN/);
  });

  it("keeps the §11 knobs off every schema", async () => {
    const { last } = await session([request("tools/list", {}, 3)]);

    // SEC-2: `allow` is the ONLY source of writability, so a model that could
    // set it could manufacture the classification authorising its own write.
    for (const tool of last.result.tools) {
      for (const knob of ["allow", "prod", "acknowledgeProd"]) {
        assert.equal(
          knob in tool.inputSchema.properties,
          false,
          `${tool.name} must not accept \`${knob}\``,
        );
      }
    }
  });

  it("lists without touching either instance", async () => {
    const { h } = await session([request("tools/list", {}, 3)]);

    assert.deepEqual(h.fake.requests(), []);
    assert.deepEqual(h.runner.requests(), []);
  });
});

// ── tools/call: the reports ─────────────────────────────────────────────────

describe("@tessera/mcp — preflight_resolve", () => {
  it("returns the resolved artifact list as structured content and as text", async () => {
    const { last } = await session([
      callTool("preflight_resolve", { source: "source", scope: SCOPE_NAME }),
    ]);

    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, false);

    const report = last.result.structuredContent;
    assert.equal(report.source.host, SOURCE_HOST);
    // The scope adapter's default surface is Script Includes (DESIGN §12.3),
    // and the seed has two of them.
    assert.equal(report.count, 2);
    assert.deepEqual(report.artifacts.map((artifact) => artifact.name).sort(), [
      "AmountCalculator",
      "OrderTotals",
    ]);
    // Every row says which adapter claimed it — the ARCH-5 label is the whole
    // reason an operator can look at this list before a gate is built on it.
    assert.deepEqual(
      [...new Set(report.artifacts.map((artifact) => artifact.resolvedBy))],
      ["scope"],
    );
    assert.equal(report.incomplete, false);
    assert.deepEqual(JSON.parse(last.result.content[0].text), report);
  });

  it("reaches the source with reads only and never touches the runner", async () => {
    const { h } = await session([
      callTool("preflight_resolve", { source: "source", scope: SCOPE_NAME }),
    ]);

    assert.deepEqual(methods(h.fake), ["GET"]);
    // ARCH-19 in the strongest available form: the runner is configured and
    // reachable, and resolution still has no reason to speak to it.
    assert.deepEqual(h.runner.requests(), []);
  });

  it("refuses a wrongly typed argument before anything runs", async () => {
    const { last, h } = await session([
      callTool("preflight_resolve", {
        source: "source",
        scope: SCOPE_NAME,
        artifactTables: "sys_script_include",
      }),
    ]);

    assert.equal(last.error.code, ERROR_CODES.invalidParams);
    assert.match(last.error.message, /invalid arguments for preflight_resolve/);
    assert.match(last.error.message, /must be an array of strings/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("maps a usage refusal to an error with the pipeline's own wording", async () => {
    const { last, h } = await session([
      callTool("preflight_resolve", { scope: SCOPE_NAME }),
    ]);

    // No source anywhere — not in the call, not in the environment. The schema
    // lets it through because config may supply it; the pipeline says no.
    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, true);
    assert.match(last.result.content[0].text, /INVALID REQUEST \(exit 2\)/);
    assert.match(last.result.content[1].text, /no source instance/);
    assert.equal("structuredContent" in last.result, false);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("maps an unreadable source to a fault, never to an empty list", async () => {
    const { last } = await session(
      [callTool("preflight_resolve", { source: "source", scope: SCOPE_NAME })],
      { faults: [faultOn("sys_scope", { kind: "http-error", status: 500 })] },
    );

    assert.equal(last.result.isError, true);
    assert.equal("structuredContent" in last.result, false);

    const text = last.result.content[0].text;
    assert.match(text, /INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/);
    assert.match(text, /absence of evidence is a fault, never a finding/);
    // "resolved 0 artifacts" and "the instance never answered" are the same
    // number of rows and must never be the same result.
    assert.equal(JSON.stringify(last.result).includes("artifacts"), false);
  });
});

describe("@tessera/mcp — preflight_impact", () => {
  it("returns the impact graph as structured content and as text", async () => {
    const { last } = await session([callTool("preflight_impact", IMPACT_ARGS)]);

    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, false);

    const structured = last.result.structuredContent;
    assert.equal(structured.source.host, SOURCE_HOST);
    // Two Script Includes plus the two consumers that earned an edge.
    assert.equal(structured.counts.nodes, 4);
    assert.equal(structured.incomplete, false);

    // The specification asks a tool returning structured content to return it as
    // text too — a host that ignores `structuredContent` must not show the caller
    // an empty answer to a successful read.
    assert.deepEqual(JSON.parse(last.result.content[0].text), structured);
  });

  it("reaches the instance with reads only", async () => {
    const { h } = await session([callTool("preflight_impact", IMPACT_ARGS)]);

    assert.deepEqual(methods(h.fake), ["GET"]);
  });

  it("never lets a script body reach the wire (TM-1)", async () => {
    const { wire } = await session([callTool("preflight_impact", IMPACT_ARGS)]);

    // Asserted against the WHOLE session, not against the report: a canary that
    // arrived in a diagnostics block or an error message would be just as leaked.
    assert.equal(wire().includes(CANARY), false);
    // The artifact that carries it is still in the graph — proving the check
    // above is not passing because the analysis found nothing.
    assert.match(wire(), /OrderTotals/);
  });

  it("carries a story through to the resolver", async () => {
    const { h } = await session([
      callTool("preflight_impact", { ...IMPACT_ARGS, story: "STRY0001234" }),
    ]);

    // The resolver looks the story up; the fake has no rm_story rows, so what is
    // asserted is the round trip, not the answer.
    assert.equal(
      h.fake.requests().some((entry) => entry.path.endsWith("/rm_story")),
      true,
    );
  });
});

describe("@tessera/mcp — preflight_coverage", () => {
  it("joins the graph against the registry and reports gaps without failing", async () => {
    const { last } = await session(
      [callTool("preflight_coverage", { ...IMPACT_ARGS, testsRoot: "tests" })],
      { specs: ONE_SPEC },
    );

    assert.equal(last.result.isError, false);

    const counts = last.result.structuredContent.counts;
    assert.equal(counts.impacted, 4);
    assert.equal(counts.withSpec, 1);
    // Three gaps and still not an error: a gap is a hole in somebody's PLAN, and
    // this report holds no evidence with which to fail anything (QA-8).
    assert.equal(counts.gaps, 3);
    assert.equal(counts.specsInRoot, 1);
  });

  it("resolves a relative tests root against the directory the server runs in", async () => {
    const { last, h } = await session(
      [callTool("preflight_coverage", { ...IMPACT_ARGS, testsRoot: "tests" })],
      { specs: ONE_SPEC },
    );

    assert.equal(last.result.structuredContent.testsRoot, h.testsRoot);
  });

  it("says nothing about a run having happened", async () => {
    const { last } = await session(
      [callTool("preflight_coverage", { ...IMPACT_ARGS, testsRoot: "tests" })],
      { specs: ONE_SPEC },
    );

    // The join is declared intent. A field named for a result would be the first
    // step toward a caller reading "has a spec" as "passes".
    const document = last.result.structuredContent;
    assert.equal("passed" in document, false);
    assert.equal("results" in document, false);
  });
});

// ── tools/call: the one that writes the repo ────────────────────────────────

const GENERATE_ARGS = { ...IMPACT_ARGS, testsRoot: "tests", kind: "unit" };

describe("@tessera/mcp — preflight_generate", () => {
  it("proposes specs into an inert tree, reading the instance and nothing more", async () => {
    const { last, h } = await session(
      [callTool("preflight_generate", GENERATE_ARGS)],
      {
        specs: ONE_SPEC,
      },
    );

    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, false);

    const document = last.result.structuredContent;
    assert.equal(document.counts.impacted, 4);
    assert.equal(document.counts.proposed > 0, true);
    // The offline backend, which is what the operator gets unless they went and
    // configured another one: no third party was reached on this call.
    assert.equal(document.provider.name, "template");
    assert.equal(document.testsRoot, h.testsRoot);
    assert.equal(document.proposedDir, path.join(h.testsRoot, "proposed"));

    // The claim "it wrote the repo and not an instance" is only falsifiable
    // against a fake that records what it was asked to do (ARCH-19).
    assert.deepEqual(methods(h.fake), ["GET"]);
    assert.deepEqual(h.runner.requests(), []);
  });

  it("leaves the live manifest exactly as it found it (DEV-4)", async () => {
    const { last, h } = await session(
      [callTool("preflight_generate", GENERATE_ARGS)],
      {
        specs: ONE_SPEC,
      },
    );

    const live = JSON.parse(
      await fs.readFile(path.join(h.testsRoot, ".manifest.json"), "utf8"),
    );
    const proposed = JSON.parse(
      await fs.readFile(last.result.structuredContent.manifestPath, "utf8"),
    );

    // The manifest the inventory joins on still names one spec — the one the
    // fixture registered — so nothing generated here counts as coverage, is
    // scheduled to run, or retires anything (QA-16).
    assert.deepEqual(
      live.specs.map((spec) => spec.id),
      ["amount-unit"],
    );
    // The proposal is real and it is somewhere else entirely.
    assert.equal(proposed.specs.length > 0, true);
    assert.equal(
      proposed.specs.every((spec) => spec.path.startsWith("proposed/")),
      true,
    );
    assert.equal(
      last.result.structuredContent.manifestPath,
      path.join(h.testsRoot, ".manifest.proposed.json"),
    );
  });

  it("says a human step is owed, which the JSON document alone does not", async () => {
    const { last } = await session(
      [callTool("preflight_generate", GENERATE_ARGS)],
      {
        specs: ONE_SPEC,
      },
    );

    // `tess generate --json` drops the "NOTHING HAS BEEN RUN" sentence its human
    // report prints, so a host reading only the document would see a list of
    // paths and no reason not to run them. The banner puts it back — keyed off
    // the write class, not off a tool name, and with no state kept between calls.
    const banner = last.result.content.at(-1).text;
    assert.match(banner, /PROPOSAL, NOT AN ARTIFACT TO RUN \(DEV-4\)/);
    assert.match(banner, /none of them is armed/);
    assert.match(banner, /HUMAN one/);
    assert.match(banner, /do not describe it as ready, passing or promoted/);

    // And the first block is still a parseable document, as every other tool's
    // first block is: the banner is added, never substituted.
    JSON.parse(last.result.content[0].text);
  });

  it("reports nothing that could be read as a result of running them", async () => {
    const { last } = await session(
      [callTool("preflight_generate", GENERATE_ARGS)],
      {
        specs: ONE_SPEC,
      },
    );

    // No field named for an outcome, and no verdict: a generated spec is not
    // evidence with which to fail a build, so this tool never returns 1 (QA-8).
    const document = last.result.structuredContent;
    assert.equal("passed" in document, false);
    assert.equal("results" in document, false);
    assert.equal("status" in document, false);
    assert.equal(last.result.isError, false);
  });

  it("maps an unreadable source to a fault, never to an empty batch", async () => {
    const { last, h } = await session(
      [callTool("preflight_generate", GENERATE_ARGS)],
      {
        specs: ONE_SPEC,
        faults: [faultOn("sys_scope", { kind: "http-error", status: 500 })],
      },
    );

    assert.equal(last.result.isError, true);
    assert.equal("structuredContent" in last.result, false);
    assert.match(
      last.result.content[0].text,
      /INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );

    // "proposed 0 specs" and "the instance never answered" are the same number
    // of files and must never be the same result — and a fault must not leave
    // half a proposal behind for somebody to promote.
    await assert.rejects(
      fs.access(path.join(h.testsRoot, ".manifest.proposed.json")),
    );
    // The success banner belongs to a write that happened; there was none.
    assert.equal(
      JSON.stringify(last.result).includes("PROPOSAL, NOT AN ARTIFACT"),
      false,
    );
  });

  it("refuses the generation backend as an argument, before any round trip", async () => {
    const { last, h } = await session(
      [
        callTool("preflight_generate", {
          ...GENERATE_ARGS,
          provider: "anthropic",
        }),
      ],
      { specs: ONE_SPEC },
    );

    // The egress switch is the operator's. A caller that could set it would be
    // choosing where instance-derived text goes, which is the decision SEC-2
    // keeps out of a model's hands — so it is refused as a protocol error,
    // without the instance being opened at all.
    assert.equal(last.result, undefined);
    assert.equal(last.error.code, ERROR_CODES.invalidParams);
    assert.match(
      last.error.message,
      /invalid arguments for preflight_generate/,
    );
    assert.match(last.error.message, /unknown argument `provider`/);
    assert.deepEqual(h.fake.requests(), []);
  });
});

describe("@tessera/mcp — preflight_doctor", () => {
  it("diagnoses a ready instance and touches nothing else", async () => {
    const { last, h } = await session([
      callTool("preflight_doctor", DOCTOR_ARGS),
    ]);

    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, false);

    const report = last.result.structuredContent;
    assert.equal(report.status, "ready");
    assert.deepEqual(
      report.instances.map((entry) => entry.role),
      ["runner"],
    );
    assert.equal(report.instances[0].host, RUNNER_HOST);
    assert.deepEqual(JSON.parse(last.result.content[0].text), report);
    // The claim the tool makes about itself, falsifiable against the fake: it
    // constructs no writer, so nothing but a GET may have reached the instance.
    assert.deepEqual(methods(h.runner), ["GET"]);
    // And it was asked about ONE instance, so the other was never opened.
    assert.deepEqual(h.fake.requests(), []);
  });

  it("diagnoses the promotion target too, because nothing here can write", async () => {
    const { last, h } = await session([
      callTool("preflight_doctor", { ...DOCTOR_ARGS, target: "source" }),
    ]);

    // ARCH-8's single-writer rule has nothing to protect against a command that
    // constructs no writer, which is what makes the second role legal here.
    assert.deepEqual(
      last.result.structuredContent.instances.map((entry) => entry.role),
      ["runner", "target"],
    );
    assert.deepEqual(writes(h.runner), []);
    assert.deepEqual(writes(h.fake), []);
  });

  it("returns NOT READY as an error result that still carries the findings", async () => {
    const { last } = await session(
      [callTool("preflight_doctor", DOCTOR_ARGS)],
      {
        runner: { atfRunner: false },
      },
    );

    // A verdict about the ENVIRONMENT, and an error for the same reason the
    // gate's is: a caller branching on the success flag alone must not read NOT
    // READY as a pass.
    assert.equal(last.result.isError, true);
    assert.equal(last.result.structuredContent.status, "not-ready");
    assert.deepEqual(JSON.parse(last.result.content[0].text), {
      ...last.result.structuredContent,
    });
    assert.match(last.result.content[1].text, /NOT READY \(exit 1\)/);
  });

  it("keeps `unknown` as its own outcome rather than folding it into a no", async () => {
    const { last } = await session(
      [callTool("preflight_doctor", DOCTOR_ARGS)],
      {
        runnerFaults: [
          faultOn("sys_atf_test", { kind: "http-error", status: 500 }),
        ],
      },
    );

    // QA-9, and the reason the doctor has three exit codes and not two: a CI job
    // that retries a "no" forever is the failure this distinction prevents.
    assert.equal(last.result.isError, false);
    assert.equal(last.result.structuredContent.status, "unknown");
    JSON.parse(last.result.content[0].text);
    assert.match(last.result.content[1].text, /INCOMPLETE \(exit 5\)/);
    // The banner is asserted against the REAL document, which is where the
    // false version of it survived: `tess doctor --json` emits no `notes` and
    // no `incomplete`, and the banner promised both to every exit 5. Every
    // suite stayed green, because nothing read the document.
    assert.equal("notes" in last.result.structuredContent, false);
    assert.equal("incomplete" in last.result.structuredContent, false);
    assert.doesNotMatch(last.result.content[1].text, /\bin `notes`\b/);
    // What it says instead names a field this document really has.
    assert.match(last.result.content[1].text, /ROLL-UP instead: status\b/);
  });

  it("lets a missing instance through to the pipeline, which names the flag", async () => {
    const { last, h } = await session([callTool("preflight_doctor", {})]);

    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, true);
    assert.match(last.result.content[0].text, /INVALID REQUEST \(exit 2\)/);
    assert.match(last.result.content[1].text, /no instance/);
    assert.equal("structuredContent" in last.result, false);
    assert.deepEqual(h.runner.requests(), []);
  });

  it("names the flag spelling instead of silently dropping it", async () => {
    const { last, h } = await session([
      callTool("preflight_doctor", { instance: "runner" }),
    ]);

    // The property is the CLI's KEY, `runner`; `--instance` is the flag it
    // becomes. Dropped silently, this call would run with no instance at all and
    // read back as a configuration problem.
    assert.equal(last.error.code, ERROR_CODES.invalidParams);
    assert.match(last.error.message, /invalid arguments for preflight_doctor/);
    assert.match(last.error.message, /unknown argument `instance`/);
    assert.deepEqual(h.runner.requests(), []);
  });
});

// ── tools/call: the gate ────────────────────────────────────────────────────
//
// One note applies to every case below, and it is a limitation of what the
// pipeline can be made to do rather than of what is asserted here: `tess
// preflight` has no reachable exit-3 path against the fake. The doctor turns an
// unreadable precondition into `unknown` (exit 5, QA-9), parity turns an
// unfingerprintable artifact into `undecidable` (exit 5), and the §11.2 probe
// catches its own transport failures and downgrades the classification instead
// of throwing. So DEV-1's fault mapping is exercised end to end through
// `preflight_resolve` above, and per write class — including exit 3 for the
// mutating tool — in `results.test.js`.

describe("@tessera/mcp — preflight_plan", () => {
  it("passes a ready runner and reports the empty plan as a result", async () => {
    const { last, h } = await session([callTool("preflight_plan", PLAN_ARGS)]);

    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, false);

    const report = last.result.structuredContent;
    assert.equal(report.mode, "plan");
    assert.equal(report.plan.applied, false);
    assert.equal(report.plan.steps.length, 0);
    assert.equal(report.verdict.exitCode, 0);
    // Parity is stated as not-applicable rather than shown as a pass: no
    // artifacts were named, so nothing was compared (ARCH-20).
    assert.equal(report.parity.status, "not-applicable");
    assert.deepEqual(JSON.parse(last.result.content[0].text), report);
    assert.deepEqual(writes(h.runner), []);
  });

  it("returns NOT READY as an error result that still carries the report", async () => {
    const { last, h } = await session([callTool("preflight_plan", PLAN_ARGS)], {
      runner: { atfRunner: false },
    });

    // `isError: true` on a verdict the tool was asked for, and argued in
    // `results.ts`: of the two ways to be wrong, an error that was really a
    // verdict costs a second look, and a pass that was really a NO_GO ships.
    assert.equal(last.result.isError, true);

    const report = last.result.structuredContent;
    assert.equal(report.verdict.exitCode, 1);
    assert.equal(report.plan.steps.length, 1);
    assert.equal(report.plan.steps[0].write.table, "sys_properties");
    // Nothing was thrown away: the document is intact in BOTH places.
    assert.deepEqual(JSON.parse(last.result.content[0].text), report);
    assert.match(last.result.content[1].text, /NOT READY \(exit 1\)/);
    assert.match(
      last.result.content[1].text,
      /IS the answer and not a failure/,
    );
    // A plan is a plan.
    assert.deepEqual(writes(h.runner), []);
  });

  it("cannot be turned into an apply by the host's environment", async () => {
    const { last, h } = await session([callTool("preflight_plan", PLAN_ARGS)], {
      // Both knobs set exactly as an apply would need them. If `--mode plan`
      // were the CLI's default rather than a pin on the argv, this call would
      // classify the runner and refuse (exit 4) instead of planning.
      env: { TESSERA_MODE: "apply", TESSERA_ALLOW: RUNNER_HOST },
      runner: { atfRunner: false },
    });

    const report = last.result.structuredContent;
    assert.equal(report.mode, "plan");
    // No `--mode apply`, so no classification was performed at all — the guard
    // was never even asked, because there was nothing to ask it about.
    assert.equal(report.runnerClassification, undefined);
    assert.deepEqual(writes(h.runner), []);
  });

  it("returns an undecided precondition as inconclusive, not as ready", async () => {
    const { last } = await session([callTool("preflight_plan", PLAN_ARGS)], {
      runnerFaults: [
        faultOn("sys_atf_test", { kind: "http-error", status: 500 }),
      ],
    });

    // QA-9: "I could not tell" is never rounded up to "I checked and it is fine".
    assert.equal(last.result.isError, false);
    assert.equal(last.result.structuredContent.doctor.status, "unknown");
    JSON.parse(last.result.content[0].text);
    assert.match(last.result.content[1].text, /INCOMPLETE \(exit 5\)/);
    // The second document that carries neither field, and it carries two
    // roll-ups rather than one — the precondition nobody could establish and
    // the gate that therefore reached no verdict. Both are named, because a
    // caller sent to one of them would go looking for the other in `notes`.
    assert.equal("incomplete" in last.result.structuredContent, false);
    assert.doesNotMatch(last.result.content[1].text, /\bin `notes`\b/);
    assert.match(last.result.content[1].text, /doctor\.status/);
    assert.match(last.result.content[1].text, /verdict\.status/);
  });

  it("lets a missing runner through to the pipeline, which names the flag", async () => {
    const { last, h } = await session([callTool("preflight_plan", {})]);

    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, true);
    assert.match(last.result.content[0].text, /INVALID REQUEST \(exit 2\)/);
    assert.match(last.result.content[1].text, /no runner/);
    assert.equal("structuredContent" in last.result, false);
    assert.deepEqual(h.runner.requests(), []);
  });

  it("names a misspelled argument instead of silently dropping it", async () => {
    const { last, h } = await session([
      callTool("preflight_plan", { ...PLAN_ARGS, kind: ["unit"] }),
    ]);

    // `kinds`, not `kind`. Dropped silently, the caller would read a report
    // computed over the DEFAULT kinds as an answer about the one they named.
    assert.equal(last.error.code, ERROR_CODES.invalidParams);
    assert.match(last.error.message, /invalid arguments for preflight_plan/);
    assert.match(last.error.message, /unknown argument `kind`/);
    assert.deepEqual(h.runner.requests(), []);
  });
});

describe("@tessera/mcp — preflight_apply", () => {
  it("refuses to run at all without the literal confirmation", async () => {
    const { last, h } = await session([callTool("preflight_apply", PLAN_ARGS)]);

    // Refused HERE, not by the pipeline: a privileged act that a forgotten
    // argument could still perform is not a confirmation. Decision 3's "config
    // may supply it" leniency deliberately does not reach this one field.
    assert.equal(last.result, undefined);
    assert.equal(last.error.code, ERROR_CODES.invalidParams);
    assert.match(last.error.message, /`mode` is required for preflight_apply/);
    assert.match(last.error.message, /must be "apply"/);
    assert.deepEqual(h.runner.requests(), []);
  });

  for (const [label, mode] of [
    ["a different mode", "plan"],
    ["a null the host serialised for an omitted argument", null],
  ]) {
    it(`refuses ${label} before a byte reaches the instance`, async () => {
      const { last, h } = await session([
        callTool("preflight_apply", { ...PLAN_ARGS, mode }),
      ]);

      assert.equal(last.error.code, ERROR_CODES.invalidParams);
      assert.match(last.error.message, /"apply"/);
      assert.deepEqual(h.runner.requests(), []);
    });
  }

  it("surfaces a §11 refusal as a refusal, and proves nothing was written", async () => {
    const { last, h } = await session([
      callTool("preflight_apply", { ...PLAN_ARGS, mode: "apply" }),
    ]);

    // The runner is on no allowlist, so §11.1 classifies it `unknown` and §11.2
    // never grants writability. The refusal happens before the writer exists.
    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, true);
    assert.equal("structuredContent" in last.result, false);

    const text = last.result.content[0].text;
    assert.match(text, /^REFUSED \(§11, exit 4\)/);
    assert.match(text, /NOTHING WAS WRITTEN/);
    assert.match(text, /This is a REFUSAL, not a failure/);
    // The guard's own reasoning comes through verbatim, in its own block.
    assert.match(last.result.content[1].text, /REFUSED \(§11\)/);
    assert.match(
      last.result.content[1].text,
      /the runner classifies "unknown"/,
    );

    // The claim the wording makes, checked against the stateful fake rather
    // than trusted — and stronger than "no writes": an unlisted host is
    // `unknown` without anything being probed, so §11 refused this run before
    // it cost the operator a single round trip.
    assert.deepEqual(writes(h.runner), []);
    assert.deepEqual(h.runner.requests(), []);
  });

  it("keeps a refusal distinguishable from a failure", async () => {
    const { last } = await session([
      callTool("preflight_apply", { ...PLAN_ARGS, mode: "apply" }),
    ]);

    const text = last.result.content[0].text;
    // Not a fault: nothing broke, and telling the caller to fix the cause and
    // call again would send them looking for an outage that never happened.
    assert.equal(/INFRASTRUCTURE FAULT/.test(text), false);
    assert.equal(/NOT READY/.test(text), false);
    assert.match(text, /Retrying it unchanged changes nothing/);
    // And it says where the answer actually lives, which is not here.
    assert.match(text, /operator's §11\.2 configuration/);
    assert.match(text, /not reachable from any tool argument here/);
    assert.match(text, /SEC-2/);
  });

  it("still refuses an allowlisted runner the §11.2 probe disagrees about", async () => {
    const { last, h } = await session(
      [callTool("preflight_apply", { ...PLAN_ARGS, mode: "apply" })],
      { env: { TESSERA_ALLOW: RUNNER_HOST }, runner: { atfRunner: false } },
    );

    // The one runner state that gives the provisioner a step to perform is also
    // the state the probe reads as a production signal, so it downgrades to
    // `prod-suspect` and the allowlist does not save it. Pinned deliberately:
    // this is why no reachable call below actually writes.
    assert.equal(last.result.isError, true);
    assert.match(last.result.content[0].text, /^REFUSED \(§11, exit 4\)/);
    assert.match(last.result.content[1].text, /prod-suspect/);
    assert.match(
      last.result.content[1].text,
      /no acknowledge-prod covers this run/,
    );
    assert.deepEqual(writes(h.runner), []);
  });

  it("classifies an allowlisted runner and finds nothing to do", async () => {
    const { last, h } = await session(
      [callTool("preflight_apply", { ...PLAN_ARGS, mode: "apply" })],
      { env: { TESSERA_ALLOW: RUNNER_HOST } },
    );

    assert.equal(last.result.isError, false);

    const report = last.result.structuredContent;
    assert.equal(report.mode, "apply");
    // The guard was consulted and answered — this is the shape of a permitted
    // apply, and it is the only one this surface can currently produce.
    assert.equal(report.runnerClassification.cls, "sub-prod");
    assert.equal(report.plan.steps.length, 0);
    assert.equal(report.plan.applied, false);
    // Apply mode over an empty plan is still a read-only run.
    assert.deepEqual(writes(h.runner), []);
  });

  it("cannot be made to write without the guard being consulted", async () => {
    // Every configuration of the two §11 knobs a host could conceivably be
    // launched with, crossed with both runner states. The property is not "it
    // refuses" — one of these is permitted — but that a write is unreachable
    // except THROUGH a classification the guard produced.
    const configurations = [
      { label: "no allowlist, ready runner", env: {}, runner: {} },
      {
        label: "no allowlist, runner needing a write",
        env: {},
        runner: { atfRunner: false },
      },
      {
        label: "allowlisted, ready runner",
        env: { TESSERA_ALLOW: RUNNER_HOST },
        runner: {},
      },
      {
        label: "allowlisted, runner needing a write",
        env: { TESSERA_ALLOW: RUNNER_HOST },
        runner: { atfRunner: false },
      },
      {
        label: "allowlisted and named as production",
        env: { TESSERA_ALLOW: RUNNER_HOST, TESSERA_PROD: RUNNER_HOST },
        runner: {},
      },
      {
        label: "flagged production by the instance itself",
        env: { TESSERA_ALLOW: RUNNER_HOST },
        runner: { production: true },
      },
    ];

    for (const configuration of configurations) {
      const { last, h } = await session(
        [callTool("preflight_apply", { ...PLAN_ARGS, mode: "apply" })],
        { env: configuration.env, runner: configuration.runner },
      );

      assert.deepEqual(
        writes(h.runner),
        [],
        `${configuration.label}: a write escaped`,
      );

      if (last.result.isError === true) {
        assert.match(
          last.result.content[0].text,
          /^REFUSED \(§11, exit 4\)/,
          `${configuration.label}: not refused in §11's words`,
        );
        continue;
      }

      // Permitted, therefore classified: there is no branch on which apply mode
      // proceeds with `runnerClassification` absent.
      assert.equal(
        last.result.structuredContent.runnerClassification.cls,
        "sub-prod",
        `${configuration.label}: permitted without a classification`,
      );
    }
  });
});

describe("@tessera/mcp — preflight_run", () => {
  it("advertises one optional host and nothing else a caller could aim", async () => {
    const { last } = await session([request("tools/list", {}, 3)]);

    const run = last.result.tools.find((tool) => tool.name === "preflight_run");

    // The whole surface, on the wire: one property. `tess run` parses eighteen
    // flags, and the seventeen that are missing here are missing on purpose —
    // four of them (`--fake`, `--mutant`, `--fake-production-property`,
    // `--keep`) do not configure a run, they fabricate one, and a GO produced
    // that way is indistinguishable in the report from a real one.
    assert.deepEqual(Object.keys(run.inputSchema.properties), ["runner"]);
    assert.equal("required" in run.inputSchema, false);
    assert.equal(run.inputSchema.additionalProperties, false);
    // Declared as a writer BEFORE the first call, like the apply tool.
    assert.equal(run.annotations.readOnlyHint, false);
    assert.equal(run.annotations.destructiveHint, true);
    assert.equal(run.annotations.idempotentHint, false);
    assert.match(run.title, /WRITES/);
    assert.match(run.description, /^THIS TOOL WRITES/);
    // And the two things a caller gets wrong otherwise: that exit 1 is the
    // answer rather than a malfunction, and that it is two answers.
    assert.match(run.description, /that is a FINDING/);
    assert.match(run.description, /READ `verdict\.status`/);
  });

  it("names a misspelled argument instead of silently dropping it", async () => {
    const { last, h } = await session([
      callTool("preflight_run", { instance: RUNNER_HOST }),
    ]);

    // `runner`, not `instance` — the property is named for the ROLE on every
    // tool here, and the flag it becomes is `tools.ts`'s problem. Dropped
    // silently, this call would have run against whatever SN_INSTANCE said.
    assert.equal(last.result, undefined);
    assert.equal(last.error.code, ERROR_CODES.invalidParams);
    assert.match(last.error.message, /invalid arguments for preflight_run/);
    assert.match(last.error.message, /unknown argument `instance`/);
    assert.deepEqual(h.runner.requests(), []);
  });

  it("refuses the harness switches that would forge a verdict", async () => {
    for (const knob of ["fake", "mutant", "skeleton", "runId", "ledgerRoot"]) {
      const { last, h } = await session([
        callTool("preflight_run", { runner: RUNNER_HOST, [knob]: "x" }),
      ]);

      assert.equal(
        last.error.code,
        ERROR_CODES.invalidParams,
        `${knob} was accepted`,
      );
      assert.match(
        last.error.message,
        new RegExp(`unknown argument \`${knob}\``),
      );
      assert.deepEqual(h.runner.requests(), []);
    }
  });

  it("lets a missing runner through to the pipeline, which names the flag", async () => {
    const { last, h } = await session([callTool("preflight_run", {})]);

    // Decision 3's leniency: an omitted instance is configuration's job, not a
    // protocol error, and the pipeline owns the wording either way.
    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, true);
    assert.match(last.result.content[0].text, /INVALID REQUEST \(exit 2\)/);
    assert.match(last.result.content[1].text, /no instance/);
    assert.equal("structuredContent" in last.result, false);
    assert.deepEqual(h.runner.requests(), []);
  });

  it("takes the instance from SN_INSTANCE, as the `tess` binary does", async () => {
    // `captureContext` built its CliContext without `instance`, so the MCP
    // server ignored SN_INSTANCE entirely and answered "no instance" (exit 2).
    const { last, h } = await session([callTool("preflight_run", {})], {
      env: { SN_INSTANCE: RUNNER_HOST },
    });

    assert.equal(last.result.isError, true);
    assert.doesNotMatch(last.result.content[1].text, /no instance/);
    assert.match(
      last.result.content[0].text,
      /INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );
    assert.match(last.result.content[1].text, /SN_USER and SN_PASSWORD/);
    assert.deepEqual(writes(h.runner), []);
  });

  it("refuses a malformed or flag-like runId as invalid params", async () => {
    for (const runId of ["x^ORsys_idISNOTEMPTY^name!=", "../x", "--help"]) {
      const { last } = await session([
        callTool("preflight_run_status", { runId }),
      ]);
      assert.equal(last.error.code, ERROR_CODES.invalidParams, runId);
    }
  });

  it("cannot be made to write by anything the host can configure", async () => {
    // The apply tool's property test, asked of the second writer, and the only
    // form in which it can honestly be asked here. `tess run` is argv-only by
    // its own header's argument — dev-harness flags must not acquire env and
    // config layers — so `TESSERA_ALLOW`, which `options.ts` honours for every
    // other guarded command, does NOT reach it. Decision 5 forbids this tool
    // from sending `--allow`, and nothing else can supply it, so the §11.2
    // allowlist arriving at the guard is empty in every row below. The property
    // is therefore not "one of these writes" but that NONE of them can: not a
    // permissive environment, not a runner the operator declared writable, not
    // a credentialled session.
    const configurations = [
      { label: "no allowlist, no credentials", options: {} },
      { label: "no allowlist, credentialled", options: { credentials: true } },
      {
        label: "operator allowlisted the runner",
        options: { credentials: true, env: { TESSERA_ALLOW: RUNNER_HOST } },
      },
      {
        label: "operator allowlisted it and named it non-prod",
        options: {
          credentials: true,
          env: { TESSERA_ALLOW: RUNNER_HOST, TESSERA_PROD: SOURCE_HOST },
        },
      },
    ];

    for (const configuration of configurations) {
      const { last, h } = await session(
        [callTool("preflight_run", { runner: RUNNER_HOST })],
        configuration.options,
      );

      assert.deepEqual(
        writes(h.runner),
        [],
        `${configuration.label}: a write escaped`,
      );
      // And no configuration turns it into an answer either: a success here
      // would mean a verdict had been reached without the guard consenting.
      assert.equal(
        last.result.isError,
        true,
        `${configuration.label}: reported an outcome`,
      );
      assert.equal(
        "structuredContent" in last.result,
        false,
        `${configuration.label}: returned a report`,
      );
    }
  });

  it("cannot reach a write without going through the pipeline's own guard", async () => {
    const { last, h } = await session(
      [callTool("preflight_run", { runner: RUNNER_HOST })],
      { credentials: true },
    );

    // NOT a §11 refusal, and the reason is worth pinning rather than hiding:
    // `runSkeleton` classifies the runner at step zero but only ASSERTS
    // writability at the first write, and the skeleton resolves its Phase-0.5
    // artifacts off the instance before it gets there. This fake carries the
    // MCP suite's runner seed rather than `seedS5Instance`'s, so the resolve
    // fails first and the run faults having written nothing. That is the honest
    // outcome of this harness and it is recorded as such: the exit-4 wording is
    // asserted where this package actually owns it, over a refused outcome, in
    // `results.test.js`.
    assert.match(
      last.result.content[0].text,
      /INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );
    assert.match(last.result.content[1].text, /TesseraS5Target/);
    // A fault says nothing about the tests, and it says nothing about §11.
    assert.match(last.result.content[1].text, /this is not a NO_GO/);
    assert.equal(/REFUSED/.test(JSON.stringify(last.result)), false);
    // Reads happened; writes did not. Both halves matter — the first is why
    // "refused before it cost a round trip" is true of `preflight_apply` and
    // NOT of this tool, and the second is the claim §11 actually makes.
    assert.notDeepEqual(h.runner.requests(), []);
    assert.deepEqual(methods(h.runner), ["GET"]);
    assert.deepEqual(writes(h.runner), []);
  });

  it("faults rather than answering when it cannot resolve credentials", async () => {
    const { last, h } = await session([
      callTool("preflight_run", { runner: RUNNER_HOST }),
    ]);

    // Without `credentials: true` there is no default credential for a HOST,
    // and the staging step fails before §11 is consulted at all. Worth pinning
    // twice over: it is the ordering (a fault can precede the guard, and writes
    // nothing either way), and it is DEV-1 — a run that produced no evidence
    // must not come back looking like a test result.
    assert.equal(last.result.isError, true);
    assert.equal("structuredContent" in last.result, false);
    assert.match(
      last.result.content[0].text,
      /INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );
    assert.match(last.result.content[1].text, /SN_USER and SN_PASSWORD/);
    assert.match(last.result.content[1].text, /this is not a NO_GO/);
    // A fault is not a refusal, and the two must never be readable as one.
    assert.equal(/REFUSED/.test(JSON.stringify(last.result)), false);
    assert.deepEqual(writes(h.runner), []);
  });

  it("says so in the description rather than letting a host discover it", async () => {
    const { last } = await session([request("tools/list", {}, 3)]);

    const run = last.result.tools.find((tool) => tool.name === "preflight_run");

    // A tool that cannot currently reach a GO and does not admit it reads as a
    // broken instance. The listing says which it is before anyone calls.
    assert.match(run.description, /EXPECT NO INSTANCE WRITE TODAY/);
    assert.match(run.description, /never authorise one/);
    assert.match(run.description, /cannot come back as a GO/);
    // And the other half of the same honesty: "no instance write" is not "no
    // write". `stage()` mkdirs the §4b ledger root before the run starts, so
    // the listing must declare the local disk separately — and, since `stage()`
    // now removes a root it created and nothing wrote into, must say which of
    // the two outcomes a host is getting rather than leaving it to be guessed.
    //
    // Anchored on the nouns, not the sentence: this pair replaced assertions
    // that went red when the prose was corrected, which is the one reason a
    // test must never fail. `packages/mcp/test/tools.test.js` pins the full
    // contract; what belongs HERE is only that it survives the trip out through
    // `tools/list`, so a host reading the listing gets it too.
    assert.match(run.description, /LOCAL DISK/);
    assert.match(run.description, /REMOVED AGAIN/);
    assert.match(run.description, /outlive the process/);
  });
});

// ── tools/call: the failure surface ─────────────────────────────────────────

describe("@tessera/mcp — a failure is never an empty answer", () => {
  it("maps a usage refusal to an error with the pipeline's own wording", async () => {
    const { last, h } = await session([
      callTool("preflight_impact", { source: "source" }),
    ]);

    assert.equal(last.result.isError, true);
    assert.match(last.result.content[0].text, /INVALID REQUEST \(exit 2\)/);
    // The reason belongs to the layer that owns it, and it comes through verbatim.
    assert.match(last.result.content[1].text, /no scope — pass --scope/);
    // Nothing to destructure a zero out of.
    assert.equal("structuredContent" in last.result, false);
    // Refused before the first round trip, so the caller pays nothing for it.
    assert.deepEqual(h.fake.requests(), []);
  });

  it("maps an unreadable instance to a fault that cannot be read as an empty graph", async () => {
    const { last } = await session(
      [callTool("preflight_impact", IMPACT_ARGS)],
      {
        faults: [faultOn("sys_scope", { kind: "http-error", status: 500 })],
      },
    );

    assert.equal(last.result.isError, true);
    assert.equal("structuredContent" in last.result, false);

    const text = last.result.content[0].text;
    assert.match(text, /INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/);
    // Said in words, because the reader is a model: "nothing is impacted" is the
    // wrong conclusion and it is the convenient one.
    assert.match(text, /NOT an empty result/);
    assert.match(text, /absence of evidence is a fault, never a finding/);
    // And the graph is nowhere in the result to be mistaken for one.
    assert.equal(JSON.stringify(last.result).includes("counts"), false);
  });

  it("survives a transport failure the same way", async () => {
    const { last } = await session(
      [callTool("preflight_impact", IMPACT_ARGS)],
      {
        faults: [
          faultOn("sys_scope", {
            kind: "transport-error",
            message: "socket hang up",
          }),
        ],
      },
    );

    assert.equal(last.result.isError, true);
    assert.equal("structuredContent" in last.result, false);
    assert.match(
      last.result.content[0].text,
      /INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );
  });

  it("returns a partial report as a result, banner-flagged rather than errored", async () => {
    const { last } = await session(
      [callTool("preflight_coverage", { ...IMPACT_ARGS, testsRoot: "tests" })],
      {
        specs: ONE_SPEC,
        faults: [faultOn("sys_ui_policy", { kind: "http-error", status: 403 })],
      },
    );

    // Exit 5 is evidence, and collapsing it into exit 3 would throw away the
    // more useful of the two facts.
    assert.equal(last.result.isError, false);
    assert.equal(last.result.structuredContent.incomplete, true);
    assert.equal(last.result.structuredContent.notes.length > 0, true);

    // The banner is SECOND: `content[0].text` stays a parseable document, because
    // parsing the first block is a real client pattern and the incompleteness is
    // carried by the document either way.
    JSON.parse(last.result.content[0].text);
    assert.match(last.result.content[1].text, /INCOMPLETE \(exit 5\)/);
    assert.match(last.result.content[1].text, /is NOT a measurement/);
    // The other half of the pair the doctor and plan cases above make: THIS
    // document does publish both fields, so the banner names both — the
    // sentence is kept where it is true rather than dropped for being false
    // elsewhere.
    assert.match(
      last.result.content[1].text,
      /said so in `notes`, and `incomplete` is true/,
    );
  });
});

// ── tools/call: what is refused without running anything ────────────────────

describe("@tessera/mcp — refused before the pipeline", () => {
  it("answers an unknown tool with a protocol error listing the real ones", async () => {
    const { last, h } = await session([callTool("preflight_deploy", {})]);

    // A fact about this server, not an outcome of running one of its tools.
    assert.equal(last.result, undefined);
    assert.equal(last.error.code, ERROR_CODES.invalidParams);
    assert.match(last.error.message, /unknown tool `preflight_deploy`/);
    assert.match(
      last.error.message,
      /preflight_resolve, preflight_impact, preflight_coverage, preflight_generate, preflight_doctor, preflight_plan, preflight_apply/,
    );
    assert.deepEqual(h.fake.requests(), []);
    assert.deepEqual(h.runner.requests(), []);
  });

  it("answers a missing name with a protocol error", async () => {
    const { last } = await session([
      request("tools/call", { arguments: {} }, 5),
    ]);

    assert.equal(last.error.code, ERROR_CODES.invalidParams);
    assert.match(last.error.message, /requires a `name` string/);
  });

  it("names a misspelled argument instead of silently dropping it", async () => {
    const { last, h } = await session([
      callTool("preflight_coverage", { ...IMPACT_ARGS, testRoot: "tests" }),
    ]);

    assert.equal(last.error.code, ERROR_CODES.invalidParams);
    assert.match(
      last.error.message,
      /invalid arguments for preflight_coverage/,
    );
    assert.match(last.error.message, /unknown argument `testRoot`/);
    // The alternative is the caller reading a report computed against the
    // default tests root as an answer about the one they named.
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses a wrongly typed argument", async () => {
    const { last } = await session([
      callTool("preflight_impact", {
        ...IMPACT_ARGS,
        artifactTables: "sys_script",
      }),
    ]);

    assert.equal(last.error.code, ERROR_CODES.invalidParams);
    assert.match(last.error.message, /must be an array of strings/);
  });

  it("lets a missing scope through to the pipeline, because config may supply it", async () => {
    const { last } = await session([
      callTool("preflight_impact", { source: "source" }),
    ]);

    // Not a protocol error: this layer refuses only what it can prove wrong
    // WITHOUT running anything, and a scope may still arrive from
    // tessera.config.json or TESSERA_SCOPE.
    assert.equal(last.error, undefined);
    assert.equal(last.result.isError, true);
  });

  it("honours a scope that arrives from the environment instead of the call", async () => {
    const { last } = await session(
      [callTool("preflight_impact", { source: "source" })],
      {
        env: { TESSERA_SCOPE: SCOPE_NAME },
      },
    );

    // The other half of the decision above: the same call that failed without a
    // configured scope succeeds with one, which is why the schema does not
    // demand it.
    assert.equal(last.result.isError, false);
    assert.equal(last.result.structuredContent.counts.nodes, 4);
  });
});

// ── the session as a whole ──────────────────────────────────────────────────

describe("@tessera/mcp — the session", () => {
  it("writes one line per response and nothing else", async () => {
    const { written } = await session([
      request("tools/list", {}, 3),
      callTool("preflight_impact", IMPACT_ARGS, 4),
    ]);

    assert.equal(written.length, 3);
    for (const text of written) {
      // The report is multi-line JSON; `JSON.stringify` escapes every newline it
      // emits, so the framing cannot be broken by content.
      assert.equal(text.includes("\n"), false);
      assert.equal(JSON.parse(text).jsonrpc, "2.0");
    }
  });

  it("keeps the delegated command's report off the protocol channel", async () => {
    const { h } = await session([callTool("preflight_impact", IMPACT_ARGS)]);

    // Everything the command printed was captured into arrays; the server's own
    // stderr channel carries diagnostics only, and here there are none.
    assert.equal(h.log(), "");
  });

  it("serves several calls over one session", async () => {
    const { responses } = await session(
      [
        callTool("preflight_impact", IMPACT_ARGS, 1),
        callTool(
          "preflight_coverage",
          { ...IMPACT_ARGS, testsRoot: "tests" },
          2,
        ),
      ],
      { specs: ONE_SPEC },
    );

    assert.deepEqual(
      responses.map((response) => response.id),
      ["init", 1, 2],
    );
    assert.equal(responses[1].result.isError, false);
    assert.equal(responses[2].result.isError, false);
  });
});
