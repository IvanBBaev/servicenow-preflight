// `tess impact` — ARCH-15's where-used graph, wired, against the QA-18 fake.
//
// The unit suites in `@tessera/impact` already prove what the scanner and the
// graph builder do with a canned read; copying them here would only add slower
// duplicates. What nothing below this layer can prove is the wire: argv, the
// four config layers, §2a role binding, the real transport, the ARCH-5
// composite, the analyzer's own scope read, and the number the process finally
// exits with. That number IS the contract of this command — 0, 2, 3 and 5 are
// reachable, 1 must not be, and a CI job that keys off the wrong one turns a
// hole in the analysis into a green gate.
//
// Three harness properties are load-bearing in nearly every case, borrowed from
// `resolve.test.js` for the same reasons:
//
//   * an injected `env` (empty unless a case says otherwise) and a temp `cwd`.
//     Otherwise an ambient `TESSERA_*` or a `tessera.config.json` somewhere
//     above the repo quietly becomes a config layer.
//   * a hand-written host-routing `fetch` that REJECTS an unknown host. The
//     command binds exactly one profile (ARCH-19), so a read that drifted onto
//     another instance has to fail loudly rather than be answered by the fake.
//   * `SN_MAX_RETRIES=0`. The transport retries idempotent GETs, which would
//     let a single-fire fault be papered over and a fault test pass clean.
//
// The scripts below are real bodies rather than the two words a scanner needs,
// because every confidence level in this command's output is a claim about how
// a name was found — and a fixture that is not code cannot falsify it.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import { EXIT_CODES, main } from "../build/index.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SOURCE_HOST = "dev-impact-source.service-now.com";

/** A 32-character lowercase-hex sys_id that stays readable in a diff. */
const hex = (prefix) => prefix.padEnd(32, "0");

const STORY_NUMBER = "STRY0077";
const STORY_ID = hex("57019");
const UPDATE_SET_ID = hex("5e7a");

const SCOPE_NAME = "x_tessera_demo";
const SCOPE_ID = hex("5c09e");

/** The subject every consumer below reaches, one way or another. */
const AMOUNT_ID = hex("aaa1");
/** A second Script Include — subject AND consumer, which is the include→include edge. */
const TOTALS_ID = hex("bbb2");
const RULE_ID = hex("ccc3");
const ACTION_ID = hex("ddd4");
const DYNAMIC_ID = hex("eee5");

/**
 * A string that exists only inside a script body. TM-1 says a body is
 * attacker-authored text, so the assertion that matters is not "the report is
 * tidy" but "this exact sequence of characters never reached stdout" — and a
 * marker nothing else could plausibly emit is the only way to state it.
 */
const CANARY = "canary-8f31-never-print-this";

/**
 * Mentions its own name three times — as a declaration, as a property access
 * and inside a string. Every one of them is a self-mention, and none of them
 * may become an edge.
 */
const AMOUNT_SCRIPT = [
  "var AmountCalculator = Class.create();",
  "AmountCalculator.prototype = {",
  "  total: function (items) {",
  "    return items.length;",
  "  },",
  '  type: "AmountCalculator",',
  "};",
].join("\n");

/** Calls the subject: `Name(` in call position — the only `high` evidence there is. */
const TOTALS_SCRIPT = [
  `// ${CANARY}: this line must never reach the report`,
  "var OrderTotals = Class.create();",
  "OrderTotals.prototype = {",
  "  sum: function (order) {",
  "    return new AmountCalculator().total(order.items);",
  "  },",
  "};",
].join("\n");

/** Names the subject as a bare identifier — a reference that cannot be shown to be a call. */
const RULE_SCRIPT = [
  "(function executeRule(current, previous) {",
  "  var calculator = AmountCalculator;",
  "  current.total = calculator.total(current.items);",
  "})(current, previous);",
].join("\n");

/** Mentions the subject in a comment. A mention, not a use. */
const ACTION_SCRIPT = [
  "// TODO: call AmountCalculator here instead of duplicating the maths",
  "current.total = current.items.length;",
].join("\n");

/**
 * Builds its call target at runtime and mentions no subject at all, so its
 * silence proves nothing about anything (QA-9).
 */
const DYNAMIC_SCRIPT = [
  'var handler = eval(gs.getProperty("x_tessera_demo.handler"));',
  "handler.run();",
].join("\n");

/**
 * The marker that matters most to THIS command: `gs.include` loads a Script
 * Include by a name computed at runtime, which is precisely the edge a textual
 * search over `sys_script_include` is here to find and cannot see.
 */
const INCLUDE_SCRIPT = [
  "var name = current.getValue('u_calculator');",
  "gs.include(name);",
  "new global[name]().total(current.items);",
].join("\n");

/**
 * One application carrying the whole graph: two Script Includes the scope
 * adapter enumerates, and three consumers spread over three different consumer
 * tables so that one refused read cannot take the whole answer with it.
 *
 * `name` and `sys_name` are both set on every row on purpose — the scope
 * adapter reads `name`, the where-used search reads `sys_name`, and a fixture
 * that supplied one of them would make a label fall back to `table/sys_id`
 * for reasons that have nothing to do with the case under test.
 */
function seed({
  orderTotals = true,
  consumers = true,
  dynamic = false,
  dynamicScript = DYNAMIC_SCRIPT,
  reverse = false,
} = {}) {
  const include = (sysId, name, script) => ({
    sys_id: sysId,
    name,
    sys_name: name,
    sys_scope: SCOPE_ID,
    script,
  });

  const state = {
    rm_story: [{ sys_id: STORY_ID, number: STORY_NUMBER }],
    sys_update_set: [
      {
        sys_id: UPDATE_SET_ID,
        name: `${STORY_NUMBER} work`,
        story: STORY_ID,
      },
    ],
    // Only the Script Include: a Business Rule in the update set would resolve
    // to a non-subject artifact, which is unanalyzable by construction and
    // would make every story case exit 5 for a reason the case is not about.
    sys_update_xml: [
      {
        sys_id: hex("e001"),
        name: `sys_script_include_${AMOUNT_ID}`,
        type: "Script Include",
        target_name: "AmountCalculator",
        action: "INSERT_OR_UPDATE",
        update_set: UPDATE_SET_ID,
      },
    ],
    sys_scope: [{ sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Tessera Demo" }],
    sys_script_include: [
      include(AMOUNT_ID, "AmountCalculator", AMOUNT_SCRIPT),
      ...(orderTotals
        ? [include(TOTALS_ID, "OrderTotals", TOTALS_SCRIPT)]
        : []),
    ],
    sys_script: consumers
      ? [
          {
            sys_id: RULE_ID,
            name: "Recalculate totals",
            sys_name: "Recalculate totals",
            sys_scope: SCOPE_ID,
            script: RULE_SCRIPT,
          },
        ]
      : [],
    sys_ui_action: consumers
      ? [
          {
            sys_id: ACTION_ID,
            name: "Recalculate",
            sys_name: "Recalculate",
            sys_scope: SCOPE_ID,
            script: ACTION_SCRIPT,
          },
        ]
      : [],
    sysauto_script: dynamic
      ? [
          {
            sys_id: DYNAMIC_ID,
            name: "Nightly recalculation",
            sys_name: "Nightly recalculation",
            sys_scope: SCOPE_ID,
            script: dynamicScript,
          },
        ]
      : [],
  };

  if (!reverse) return state;
  // The same instance, described backwards. Every ordering in the report is
  // supposed to come from the queries and the in-memory sorts, so this must
  // change nothing at all about the output.
  return Object.fromEntries(
    Object.entries(state).map(([table, rows]) => [table, [...rows].reverse()]),
  );
}

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
  "SN_PROFILE_SOURCE_INSTANCE",
  "SN_PROFILE_SOURCE_USER",
  "SN_PROFILE_SOURCE_PASSWORD",
];

// ── harness ─────────────────────────────────────────────────────────────────

const tempRoots = [];

async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-impact-"));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Stand the source instance up behind a host-dispatching `fetch`, stage the one
 * credential profile it answers to, and hand back an injectable context.
 *
 * No `default` profile is configured, on purpose: if the profile binding ever
 * stopped working, every read has to fail rather than be served from whatever
 * instance happens to be ambient (ARCH-19).
 */
async function harness(options = {}) {
  const fake = createFakeInstance({
    host: SOURCE_HOST,
    state: seed(options.state ?? {}),
  });
  for (const rule of options.faults ?? []) fake.faults.add(rule);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (new URL(href).host !== SOURCE_HOST) {
      return Promise.reject(new Error(`no fake instance for ${href}`));
    }
    const intercepted = options.intercept?.(new URL(href));
    if (intercepted !== undefined) return intercepted;
    return fake.fetch(input, init);
  };

  const root = await tempRoot();
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(root, "sn-docs");
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_SOURCE_INSTANCE = SOURCE_HOST;
  process.env.SN_PROFILE_SOURCE_USER = "tessera";
  process.env.SN_PROFILE_SOURCE_PASSWORD = "tessera";
  reloadCredentialsFromEnv();

  const out = [];
  const err = [];
  return {
    fake,
    out,
    err,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    /** The single JSON document a `--json` run prints. */
    json: () => JSON.parse(out.join("\n")),
    context: {
      now: () => new Date("2026-02-02T03:04:05.000Z"),
      actor: "test",
      cwd: root,
      // The env LAYER, not the process env: `--scope` has one, and the ARCH-29
      // alias has to be exercisable from somewhere other than argv.
      env: options.env ?? {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
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

/** Run one command against a harness and always tear the harness down. */
async function run(argv, options = {}) {
  const h = await harness(options);
  try {
    const code = await main(argv, h.context);
    return { code, h };
  } finally {
    h.restore();
  }
}

/** Every HTTP method the fake served — impact may only ever produce GET. */
function methods(fake) {
  return [...new Set(fake.requests().map((entry) => entry.method))].sort();
}

/** A GET fault on one table, expressed the way the fault registry wants it. */
function faultOn(table, mode) {
  return { match: { method: "GET", table }, mode };
}

const SOURCE = ["--source", "source"];
const SCOPE = ["--scope", SCOPE_NAME];

/**
 * The human report is printed under the config-precedence block, which is
 * printed before any read (see the command's comment: knowing which layer chose
 * the instance is worthless once the read went to the wrong one). Cases that
 * care about "what the analysis said" want the part after that block.
 */
function reportOf(h) {
  return h.out.slice(2).join("\n");
}

// ── help ────────────────────────────────────────────────────────────────────

describe("tess impact — help", () => {
  it("prints one document, exits 0, and states that 1 is never returned", async () => {
    const { code, h } = await run(["impact", "--help"]);

    assert.equal(code, EXIT_CODES.ok);
    // One write: help piped into a pager must not arrive in fragments.
    assert.equal(h.out.length, 1);
    assert.match(
      h.stdout(),
      /^tess impact — what else does this change reach\?/,
    );
    assert.match(h.stdout(), /^ {2}1 is never returned\./m);
    // Help is not a run. Asking for it must not touch the instance.
    assert.deepEqual(h.fake.requests(), []);
  });

  it("asks for help even when the rest of the argv would have run", async () => {
    const { code, h } = await run(["impact", ...SOURCE, ...SCOPE, "--help"]);

    assert.equal(code, EXIT_CODES.ok);
    assert.deepEqual(h.fake.requests(), []);
  });
});

// ── exit 2 ──────────────────────────────────────────────────────────────────

describe("tess impact — refusals of the request (exit 2)", () => {
  it("refuses when neither --source nor --instance named an instance", async () => {
    const { code, h } = await run(["impact", ...SCOPE]);

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /^tess impact: no source instance/m);
    // Both spellings are offered: the operator who forgot one does not know
    // which of them this command prefers.
    assert.match(h.stderr(), /--source <profile>/);
    assert.match(h.stderr(), /--instance <profile>/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses a run with no scope rather than searching the whole instance", async () => {
    const { code, h } = await run(["impact", ...SOURCE]);

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /^tess impact: no scope/m);
    assert.match(h.stderr(), /confined to a single application scope/);
    // The refusal beats the reads. An unbounded where-used search is a
    // different operation with a different cost, not this one with a flag off.
    assert.deepEqual(h.fake.requests(), []);
  });

  it("does not accept --update-set at all", async () => {
    const { code, h } = await run([
      "impact",
      ...SOURCE,
      ...SCOPE,
      "--update-set",
      "abc",
    ]);

    // `tess resolve` declares and refuses this flag so the deferral is
    // readable; `impact` drops it, so the parser rejects it as unknown.
    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /unknown flag "--update-set"/);
    assert.match(h.stderr(), /Run `tess impact --help` for usage\./);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses --instance and --source naming different instances", async () => {
    const { code, h } = await run([
      "impact",
      "--instance",
      "other",
      ...SOURCE,
      ...SCOPE,
    ]);

    // ARCH-29's alias means "all three §2a roles are this one instance". Two
    // answers to that is a contradiction, not a preference to resolve.
    assert.equal(code, EXIT_CODES.usage);
    assert.match(
      h.stderr(),
      /--instance=other .* conflicts with --source=source/,
    );
    assert.match(h.stderr(), /collapses all three §2a roles onto one instance/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses a story the instance says does not exist", async () => {
    const { code, h } = await run([
      "impact",
      ...SOURCE,
      ...SCOPE,
      "--story",
      "STRY9999",
    ]);

    // The instance ANSWERED and the answer was "no such row" — the user's
    // argument to fix, which is why ResolutionInputError is caught in the
    // command instead of being rendered as an infrastructure fault.
    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /no rm_story matches `number=STRY9999` on source/);
    assert.match(
      h.stderr(),
      /the instance answered, and there is no such story/,
    );
  });

  it("refuses a scope the instance says does not exist", async () => {
    const { code, h } = await run([
      "impact",
      ...SOURCE,
      "--scope",
      "x_not_installed",
    ]);

    assert.equal(code, EXIT_CODES.usage);
    assert.match(
      h.stderr(),
      /no application scope named `x_not_installed` on the source instance/,
    );
    // No graph was printed under a rejected input.
    assert.doesNotMatch(h.stdout(), /^nodes/m);
  });

  it("prints nothing at all on stdout when --json meets a bad request", async () => {
    const { code, h } = await run(["impact", "--json", ...SOURCE]);

    assert.equal(code, EXIT_CODES.usage);
    // A consumer piping stdout into a parser gets an empty stream, not half a
    // document — the diagnosis is on stderr where it cannot corrupt the parse.
    assert.deepEqual(h.out, []);
    assert.match(h.stderr(), /^tess impact: no scope/m);
  });
});

// ── exit 0 ──────────────────────────────────────────────────────────────────

describe("tess impact — a clean graph (exit 0)", () => {
  it("prints nodes, edges, demanded specs and a summary, reading only", async () => {
    const { code, h } = await run(["impact", ...SOURCE, ...SCOPE]);

    assert.equal(code, EXIT_CODES.ok);
    const report = reportOf(h);

    assert.match(
      report,
      /^source: source <dev-impact-source\.service-now\.com>$/m,
    );
    // Two resolved Script Includes plus the two consumers that earned an edge.
    assert.match(report, /^nodes \(4\):$/m);
    assert.match(report, /^ {2}scope {5}sys_script_include\/aaa1/m);
    assert.match(report, /^ {2}consumer {2}sys_script\/ccc3/m);
    assert.match(report, /^edges \(3\):$/m);
    // One unit spec per Script Include node, at DESIGN §4's path — and, since
    // wave 14, one for the in-scope Business Rule the CLI now traces, and since
    // wave 15 one for the in-scope UI Action it traces too.
    assert.match(report, /^specs demanded \(4\):$/m);
    assert.match(
      report,
      /^ {2}unit {2}tests\/x_tessera_demo\/sys_script\/Recalculate_totals\/Recalculate_totals\.unit\.ts$/m,
    );
    assert.match(
      report,
      /^ {2}unit {2}tests\/x_tessera_demo\/sys_script_include\/AmountCalculator\/AmountCalculator\.unit\.ts$/m,
    );
    assert.match(
      report,
      /^ {2}unit {2}tests\/x_tessera_demo\/sys_ui_action\/Recalculate\/Recalculate\.unit\.ts$/m,
    );
    assert.match(
      report,
      /^analyzed 4 artifact\(s\) in scope x_tessera_demo on source: 3 where-used edge\(s\)$/m,
    );
    // Nothing was said to be unanalyzable, so nothing may be listed as such.
    assert.doesNotMatch(report, /^unanalyzable/m);
    assert.doesNotMatch(report, /INCOMPLETE/);
    // ARCH-8: this command binds one role and writes nothing, and the only
    // proof of that is the method log.
    assert.deepEqual(methods(h.fake), ["GET"]);
  });

  it("emits the JSON report as exactly one write and one document", async () => {
    const { code, h } = await run(["impact", "--json", ...SOURCE, ...SCOPE]);

    assert.equal(code, EXIT_CODES.ok);
    // One `stdout` call — a consumer must not have to reassemble the document.
    assert.equal(h.out.length, 1);
    const doc = h.json();

    assert.deepEqual(doc.source, { profile: "source", host: SOURCE_HOST });
    assert.deepEqual(doc.input, { scope: SCOPE_NAME });
    assert.equal(doc.incomplete, false);
    assert.deepEqual(doc.counts, {
      nodes: 4,
      edges: 3,
      unanalyzable: 0,
      demanded: 4,
    });
    // The config-precedence block belongs to the human report only: it is not
    // JSON, and printing it here would break the parse it exists beside.
    assert.doesNotMatch(h.stdout(), /^config file:/m);
  });

  it("labels every node with the source that resolved it, or `consumer`", async () => {
    const { h } = await run(["impact", "--json", ...SOURCE, ...SCOPE]);
    const doc = h.json();

    const by = (table, sysId) =>
      doc.nodes.find((node) => node.table === table && node.sysId === sysId);

    assert.equal(by("sys_script_include", AMOUNT_ID).resolvedBy, "scope");
    assert.equal(by("sys_script_include", TOTALS_ID).resolvedBy, "scope");
    // `null`, not an absent key: a consumer testing `resolvedBy === null` is
    // asking a question with an answer.
    assert.equal(by("sys_script", RULE_ID).resolvedBy, null);
    assert.ok("resolvedBy" in by("sys_ui_action", ACTION_ID));
  });

  it("accepts --instance as the ARCH-29 alias for the source role", async () => {
    const { code, h } = await run(["impact", "--instance", "source", ...SCOPE]);

    assert.equal(code, EXIT_CODES.ok);
    assert.match(reportOf(h), /^source: source </m);
    // The provenance block says which flag actually bound the role, so an
    // operator debugging a topology never has to guess.
    assert.match(h.out[0], /source = source \(from flag via --instance\)/);
  });

  it("takes the scope from the env layer when argv does not carry it", async () => {
    const { code, h } = await run(["impact", ...SOURCE], {
      env: { TESSERA_SCOPE: SCOPE_NAME },
    });

    assert.equal(code, EXIT_CODES.ok);
    assert.match(h.out[0], /scope = x_tessera_demo \(from env\)/);
    assert.match(reportOf(h), /in scope x_tessera_demo on source/);
  });

  it("keeps the story's provenance when the scope resolves the same artifact", async () => {
    const { code, h } = await run([
      "impact",
      ...SOURCE,
      ...SCOPE,
      "--story",
      STORY_NUMBER,
    ]);

    assert.equal(code, EXIT_CODES.ok);
    const report = reportOf(h);
    // ARCH-5 precedence: the story wins the label, and the scope's independent
    // find is still stated rather than silently dropped.
    assert.match(report, /^ {2}story {5}sys_script_include\/aaa1/m);
    assert.match(
      report,
      /sys_script_include\/aaa1.* \(AmountCalculator\) was also resolved by scope; reported as story \(ARCH-5 precedence\)/,
    );
    // `--story` narrows the SUBJECTS, not the SEARCH: the scope still supplies
    // OrderTotals, and the graph is the same size as without it.
    assert.match(report, /^nodes \(4\):$/m);
  });
});

// ── confidence ──────────────────────────────────────────────────────────────

describe("tess impact — confidence is evidence, not opinion", () => {
  it("grades each edge by how the name was found", async () => {
    const { code, h } = await run(["impact", "--json", ...SOURCE, ...SCOPE]);
    assert.equal(code, EXIT_CODES.ok);

    const doc = h.json();
    const to = (table) => doc.edges.find((edge) => edge.to.table === table);

    // `new AmountCalculator()` — the name in call position. This is a use.
    assert.equal(to("sys_script_include").confidence, "high");
    // `var calculator = AmountCalculator;` — a bare identifier. Very likely a
    // reference, and not demonstrably a call.
    assert.equal(to("sys_script").confidence, "medium");
    // The name inside a `//` comment. A mention, and reported as one.
    assert.equal(to("sys_ui_action").confidence, "low");

    for (const edge of doc.edges) {
      assert.equal(edge.via, "where_used");
      // Every edge leaves the changed artifact and points at what reaches it.
      assert.equal(edge.from.name, "AmountCalculator");
    }
  });

  it("reports an include→include edge and never a self-loop", async () => {
    const { h } = await run(["impact", "--json", ...SOURCE, ...SCOPE]);
    const doc = h.json();

    // `OrderTotals` calls `AmountCalculator`, and both are Script Includes.
    // DESIGN §12.3 row 3 exists to report exactly this edge, so a search that
    // skipped subject rows outright would make it structurally unreportable.
    const edge = doc.edges.find(
      (candidate) => candidate.to.sysId === TOTALS_ID,
    );
    assert.ok(edge, "the include→include edge is missing from the graph");
    assert.equal(edge.from.sysId, AMOUNT_ID);

    // `AmountCalculator`'s own body declares, dereferences and quotes its own
    // name. None of that is a use of anything.
    for (const candidate of doc.edges) {
      assert.notEqual(candidate.from.sysId, candidate.to.sysId);
    }
    assert.equal(
      doc.edges.filter((candidate) => candidate.to.sysId === AMOUNT_ID).length,
      0,
    );
  });

  it("keeps the strongest evidence when one consumer both calls and mentions", async () => {
    // The `high` edge above comes from a body whose first line is a comment
    // carrying the canary; a `text` match on the same pair may not demote it.
    const { h } = await run(["impact", "--json", ...SOURCE, ...SCOPE]);
    const doc = h.json();
    const edge = doc.edges.find(
      (candidate) => candidate.to.sysId === TOTALS_ID,
    );

    assert.equal(edge.confidence, "high");
  });
});

// ── exit 3 ──────────────────────────────────────────────────────────────────

describe("tess impact — the instance never answered (exit 3)", () => {
  it("faults rather than reporting an empty graph when sys_scope 500s", async () => {
    const { code, h } = await run(["impact", ...SOURCE, ...SCOPE], {
      faults: [faultOn("sys_scope", { kind: "http-error", status: 500 })],
    });

    // DEV-1: an absence of evidence is an infrastructure fault, never a
    // finding — and never the 5 a partial answer would have earned.
    assert.equal(code, EXIT_CODES.fault);
    assert.match(h.stderr(), /^INFRASTRUCTURE FAULT \(DEV-1\): /m);
    assert.match(
      h.stderr(),
      /could not read sys_scope to resolve `x_tessera_demo`/,
    );
    assert.match(h.stderr(), /no evidence was produced about any test/);
  });

  it("puts nothing on stdout in --json mode when the read never completed", async () => {
    const { code, h } = await run(["impact", "--json", ...SOURCE, ...SCOPE], {
      faults: [
        faultOn("sys_scope", {
          kind: "transport-error",
          message: "socket hang up",
        }),
      ],
    });

    assert.equal(code, EXIT_CODES.fault);
    assert.deepEqual(h.out, []);
    assert.match(h.stderr(), /socket hang up/);
  });

  it("prints the config block but no graph when the human report faults", async () => {
    const { code, h } = await run(["impact", ...SOURCE, ...SCOPE], {
      faults: [faultOn("sys_scope", { kind: "http-error", status: 500 })],
    });

    // Documents current behaviour rather than asserting an ideal: the command
    // writes the config-precedence block BEFORE any read, on purpose, so a
    // human-mode fault leaves those two lines on stdout. What must never
    // appear is anything that reads like an answer.
    assert.equal(code, EXIT_CODES.fault);
    assert.equal(h.out.length, 2);
    assert.match(h.out[0], /^config file:/);
    assert.equal(h.out[1], "");
    assert.doesNotMatch(h.stdout(), /^nodes/m);
    assert.doesNotMatch(h.stdout(), /^edges/m);
    assert.doesNotMatch(h.stdout(), /^analyzed /m);
    assert.doesNotMatch(h.stdout(), /^INCOMPLETE/m);
  });
});

// ── exit 5 ──────────────────────────────────────────────────────────────────

describe("tess impact — incomplete analyses (exit 5)", () => {
  it("is inconclusive when one consumer table refuses the read", async () => {
    const { code, h } = await run(["impact", ...SOURCE, ...SCOPE], {
      faults: [faultOn("sys_ui_policy", { kind: "http-error", status: 403 })],
    });

    assert.equal(code, EXIT_CODES.inconclusive);
    const report = reportOf(h);
    // The rows the other tables returned are still true, so the edges stay —
    // labelled as a partial answer rather than withdrawn or promoted to green.
    assert.match(report, /^edges \(3\):$/m);
    assert.match(report, /^unanalyzable \(2\):$/m);
    assert.match(
      report,
      /usage of `AmountCalculator` could not be fully traced inside scope `x_tessera_demo`/,
    );
    assert.match(
      report,
      /\[WARNING\] impact: sys_ui_policy could not be searched for usage in scope `x_tessera_demo`/,
    );
    assert.match(report, /^INCOMPLETE — 3 edge\(s\) over 4 artifact\(s\)/m);
    assert.match(
      report,
      /an absent edge is not evidence that nothing uses an artifact/,
    );
  });

  it("does not turn an edge lost to a refused table into a clean answer", async () => {
    const { code, h } = await run(["impact", "--json", ...SOURCE, ...SCOPE], {
      faults: [faultOn("sys_script", { kind: "http-error", status: 403 })],
    });

    // The `medium` edge really is gone from the graph — the table that held it
    // said nothing. QA-9 is the whole point: the graph is smaller AND the run
    // refuses to call itself analysed.
    assert.equal(code, EXIT_CODES.inconclusive);
    const doc = h.json();
    assert.equal(doc.counts.edges, 2);
    assert.equal(
      doc.edges.filter((edge) => edge.to.table === "sys_script").length,
      0,
    );
    assert.equal(doc.incomplete, true);
    assert.ok(doc.counts.unanalyzable > 0);
  });

  it("is inconclusive when a consumer builds its call target at runtime", async () => {
    const { code, h } = await run(["impact", ...SOURCE, ...SCOPE], {
      state: { dynamic: true },
    });

    assert.equal(code, EXIT_CODES.inconclusive);
    const report = reportOf(h);
    // Every table answered and every script was read. The hole is in what a
    // textual search can see, and it is stated in the same list and with the
    // same consequence as a table that refused.
    assert.match(report, /^unanalyzable \(1\):$/m);
    assert.match(report, /sysauto_script\/eee5.* {2}Nightly recalculation$/m);
    assert.match(
      report,
      /it names a call target at runtime \(`eval` on line 1\), so a textual search cannot see everything it uses/,
    );
    assert.match(report, /^INCOMPLETE — 3 edge\(s\)/m);
  });

  it("is inconclusive when a consumer resolves an include by name", async () => {
    const { code, h } = await run(["impact", ...SOURCE, ...SCOPE], {
      state: { dynamic: true, dynamicScript: INCLUDE_SCRIPT },
    });

    // Nothing about this body is exotic — it is how a configurable ServiceNow
    // integration is written — and a textual where-used search is blind to it.
    // Saying so is the difference between a graph and a guess.
    assert.equal(code, EXIT_CODES.inconclusive);
    assert.match(
      reportOf(h),
      /it names a call target at runtime \(`gs\.include` on line 2\)/,
    );
  });

  it("never renders an absent edge as `nothing uses this`", async () => {
    const { code, h } = await run(["impact", ...SOURCE, ...SCOPE], {
      state: { orderTotals: false, consumers: false },
      faults: [faultOn("sys_ui_policy", { kind: "http-error", status: 403 })],
    });

    assert.equal(code, EXIT_CODES.inconclusive);
    const report = reportOf(h);
    // Zero edges under a hole in the analysis — the single most dangerous
    // shape this command can print, because it is exactly what a clean scope
    // looks like. It is stated as what was SEARCHED, never as what is true.
    assert.match(
      report,
      /^edges: none — no script searched in scope x_tessera_demo mentioned a resolved artifact$/m,
    );
    // The phrase only ever appears negated. Counting both forms says it
    // sharply: there is no sentence anywhere in the report that claims nothing
    // uses this artifact, and the ones that come close are denials.
    const claims = report.match(/nothing uses/g) ?? [];
    const denials = report.match(/not evidence that nothing uses/g) ?? [];
    assert.equal(claims.length, denials.length);
    assert.ok(denials.length > 0);
    assert.doesNotMatch(report, /^analyzed /m);
    assert.match(report, /^INCOMPLETE — 0 edge\(s\) over 1 artifact\(s\)/m);
    // QA-15: the artifact nobody could trace stays in the node list, because
    // the coverage floor divides by every impacted artifact including this one.
    assert.match(report, /^nodes \(1\):$/m);
  });

  it("keeps a dynamic-dispatch consumer visible even with no edge to hang it on", async () => {
    const { code, h } = await run(["impact", "--json", ...SOURCE, ...SCOPE], {
      state: { orderTotals: false, consumers: false, dynamic: true },
    });

    assert.equal(code, EXIT_CODES.inconclusive);
    const doc = h.json();
    assert.equal(doc.counts.edges, 0);
    // The opaque consumer earned no edge, so it is not a node — and it is
    // still in the report, which is the property that matters.
    assert.equal(
      doc.nodes.filter((node) => node.sysId === DYNAMIC_ID).length,
      0,
    );
    assert.equal(
      doc.unanalyzable.filter((entry) => entry.artifact.sysId === DYNAMIC_ID)
        .length,
      1,
    );
  });
});

// ── TM-1 ────────────────────────────────────────────────────────────────────

describe("tess impact — TM-1: no script text leaves the analyzer", () => {
  for (const [mode, argv] of [
    ["human", ["impact", ...SOURCE, ...SCOPE]],
    ["json", ["impact", "--json", ...SOURCE, ...SCOPE]],
  ]) {
    it(`prints no body, excerpt or marker text in ${mode} mode`, async () => {
      const { code, h } = await run(argv, { state: { dynamic: true } });

      // Not a clean run — the dynamic consumer is deliberately present, so the
      // one message that quotes anything from a body is on the page.
      assert.equal(code, EXIT_CODES.inconclusive);
      const printed = h.stdout();

      // The canary exists in exactly one place in the world: inside a script
      // body on the fake instance.
      assert.doesNotMatch(printed, /canary/);
      assert.equal(printed.includes(CANARY), false);
      // Nor any other fragment of the bodies the analyzer read.
      assert.equal(printed.includes("Class.create"), false);
      assert.equal(printed.includes("new AmountCalculator()"), false);
      assert.equal(printed.includes("gs.getProperty"), false);
      // The marker that IS printed is the constant from the package's own
      // enum, quoted with a line number — identity, never source.
      assert.match(printed, /`eval` on line 1/);
      assert.equal(printed.includes("eval(gs"), false);
    });
  }

  it("carries no script field into the JSON document", async () => {
    const { h } = await run(["impact", "--json", ...SOURCE, ...SCOPE], {
      state: { dynamic: true },
    });
    const doc = h.json();

    for (const node of doc.nodes) {
      assert.deepEqual(Object.keys(node).sort(), [
        "name",
        "resolvedBy",
        "sysId",
        "table",
      ]);
    }
    for (const entry of doc.unanalyzable) {
      assert.deepEqual(Object.keys(entry.artifact).sort(), [
        "name",
        "sysId",
        "table",
      ]);
    }
  });
});

// ── determinism ─────────────────────────────────────────────────────────────

describe("tess impact — the report is reproducible", () => {
  it("prints byte-identical output for two runs of the same instance", async () => {
    const first = await run(["impact", ...SOURCE, ...SCOPE]);
    const second = await run(["impact", ...SOURCE, ...SCOPE]);

    assert.equal(first.code, second.code);
    // A CI log that cannot be diffed against yesterday's is a log nobody reads
    // twice — which is why every stage sorts rather than reporting in the order
    // rows happened to arrive.
    assert.equal(reportOf(first.h), reportOf(second.h));
  });

  it("does not let the order of rows on the instance reorder the report", async () => {
    const forwards = await run(["impact", ...SOURCE, ...SCOPE]);
    const backwards = await run(["impact", ...SOURCE, ...SCOPE], {
      state: { reverse: true },
    });

    assert.equal(forwards.code, backwards.code);
    assert.equal(reportOf(forwards.h), reportOf(backwards.h));
  });
});

// ── the Business Rule lookup (wave 14) ──────────────────────────────────────

/** The Business Rule lookup's read, and only it: `sys_script` by these fields. */
function isRuleLookup(url) {
  return (
    url.pathname === "/api/now/table/sys_script" &&
    url.searchParams.get("sysparm_fields") === "sys_id,sys_name,collection"
  );
}

describe("tess impact — the Business Rule lookup is fail-closed", () => {
  // The scope adapter enumerates `sys_script` too, so the in-scope rule is a
  // SUBJECT and the analyzer has to read its trigger table.
  const RULES_IN_SCOPE = {
    TESSERA_ARTIFACT_TABLES: "sys_script_include,sys_script",
  };

  it("is inconclusive, exit 5, naming sys_script, when the lookup read is refused", async () => {
    let hits = 0;
    const { code, h } = await run(["impact", "--json", ...SOURCE, ...SCOPE], {
      env: RULES_IN_SCOPE,
      intercept: (url) => {
        if (!isRuleLookup(url)) return undefined;
        hits += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "denied" } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });

    assert.ok(hits >= 1, "the lookup read was made");
    assert.equal(code, EXIT_CODES.inconclusive, h.stderr());
    const doc = h.json();
    assert.equal(doc.incomplete, true);
    const rule = doc.unanalyzable.find(
      (entry) => entry.artifact.table === "sys_script",
    );
    assert.ok(rule, JSON.stringify(doc.unanalyzable));
    assert.equal(rule.artifact.sysId, RULE_ID);
    assert.match(rule.reason, /could not be established/);
    assert.match(rule.reason, /sys_script/);
  });

  it("faults, exit 3, when the lookup read never gets an HTTP answer", async () => {
    const { code, h } = await run(["impact", "--json", ...SOURCE, ...SCOPE], {
      env: RULES_IN_SCOPE,
      intercept: (url) =>
        isRuleLookup(url)
          ? Promise.reject(new TypeError("fetch failed"))
          : undefined,
    });

    assert.equal(code, EXIT_CODES.fault, h.stderr());
    assert.deepEqual(h.out, []);
    assert.match(h.stderr(), /sys_script/);
  });
});

// ── the code it must never return ───────────────────────────────────────────

describe("tess impact — never exits 1", () => {
  const CONTRACT = new Set([
    EXIT_CODES.ok,
    EXIT_CODES.usage,
    EXIT_CODES.fault,
    EXIT_CODES.inconclusive,
  ]);

  const CASES = [
    ["--help", ["impact", "--help"], {}],
    ["a clean graph", ["impact", ...SOURCE, ...SCOPE], {}],
    ["the JSON report", ["impact", "--json", ...SOURCE, ...SCOPE], {}],
    ["no source", ["impact", ...SCOPE], {}],
    ["no scope", ["impact", ...SOURCE], {}],
    [
      "an unknown flag",
      ["impact", ...SOURCE, ...SCOPE, "--update-set", "x"],
      {},
    ],
    [
      "a conflicting alias",
      ["impact", "--instance", "other", ...SOURCE, ...SCOPE],
      {},
    ],
    [
      "an absent story",
      ["impact", ...SOURCE, ...SCOPE, "--story", "STRY9"],
      {},
    ],
    ["an absent scope", ["impact", ...SOURCE, "--scope", "x_nope"], {}],
    [
      "a scope read that never answered",
      ["impact", ...SOURCE, ...SCOPE],
      { faults: [faultOn("sys_scope", { kind: "http-error", status: 500 })] },
    ],
    [
      "a consumer table that refused",
      ["impact", ...SOURCE, ...SCOPE],
      {
        faults: [faultOn("sys_ui_policy", { kind: "http-error", status: 403 })],
      },
    ],
    [
      "a script that dispatches dynamically",
      ["impact", ...SOURCE, ...SCOPE],
      { state: { dynamic: true } },
    ],
  ];

  for (const [what, argv, options] of CASES) {
    it(`returns a contract code for ${what}`, async () => {
      const { code } = await run(argv, options);

      // `noGo` is a verdict about a change, and this command renders none: it
      // answers "what does this reach", or it fails to. A 1 out of here would
      // fail a pipeline for a question that was never asked.
      assert.notEqual(code, EXIT_CODES.noGo);
      assert.ok(CONTRACT.has(code), `unexpected exit code ${code} for ${what}`);
    });
  }
});
