// `tess coverage` — DESIGN §4a's intent report, wired, against the QA-18 fake.
//
// `@tessera/specs` already proves what the inventory reader does with a tree on
// disk, and `computeIntent` already proves what the join does with two canned
// inputs. Neither of them can prove the thing this file exists for: that the two
// readers are wired to the same command, in the right ORDER, with the right exit
// code falling out the bottom.
//
// Three properties are the whole contract, and each is a separate section below.
//
//   * **Disk before instance.** A tests root that is not readable must be
//     refused before the first HTTP round trip — asserted as `requests() === []`
//     rather than as a message, because the message would still pass if the
//     command had charged the operator for a full where-used search first.
//   * **An unread registry is never an empty one** (OPP-1b/QA-9). A manifest
//     that will not parse is exit 3. A tests root with no manifest is exit 0 and
//     an `info` note that says the repo is empty. Those two cases produce the
//     same number of specs — zero — and must never produce the same report.
//   * **1 is never returned.** The clean case below has three gaps in it and
//     exits 0. A gap is a hole in somebody's PLAN, and this command holds no
//     evidence with which to fail a build (QA-8).
//
// The instance fixture is `impact.test.js`'s, deliberately duplicated rather
// than exported from it: those scripts are tuned to falsify claims about
// CONFIDENCE, and a shared fixture would make an edit for one suite silently
// change what the other one is testing. What this file adds is the second half
// the other suite has no notion of — a tests root on disk.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import { EXIT_CODES, main } from "../build/index.js";

// ── fixtures: the instance ──────────────────────────────────────────────────

const SOURCE_HOST = "dev-coverage-source.service-now.com";

/** A 32-character lowercase-hex sys_id that stays readable in a diff. */
const hex = (prefix) => prefix.padEnd(32, "0");

const SCOPE_NAME = "x_tessera_demo";
const SCOPE_ID = hex("5c09e");

const AMOUNT_ID = hex("aaa1");
const TOTALS_ID = hex("bbb2");
const RULE_ID = hex("ccc3");
const ACTION_ID = hex("ddd4");
const DYNAMIC_ID = hex("eee5");

/** Targeted by a spec, reachable by nothing — the stray-declaration case. */
const RETIRED_ID = hex("f001");

/**
 * A string that exists only inside a script body. TM-1 says a body is
 * attacker-authored text, so the assertion that matters is not "the report is
 * tidy" but "this exact sequence of characters never reached stdout".
 */
const CANARY = "canary-4b70-never-print-this";

const AMOUNT_SCRIPT = [
  "var AmountCalculator = Class.create();",
  "AmountCalculator.prototype = {",
  "  total: function (items) {",
  "    return items.length;",
  "  },",
  "};",
].join("\n");

const TOTALS_SCRIPT = [
  `// ${CANARY}: this line must never reach the report`,
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

/** Builds its call target at runtime, so its silence proves nothing (QA-9). */
const DYNAMIC_SCRIPT = [
  'var handler = eval(gs.getProperty("x_tessera_demo.handler"));',
  "handler.run();",
].join("\n");

/**
 * Two Script Includes the scope adapter enumerates and two consumers that earn
 * an edge, which is four impacted artifacts — the denominator every count below
 * is stated against.
 */
function seed({ dynamic = false } = {}) {
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
    sysauto_script: dynamic
      ? [
          {
            sys_id: DYNAMIC_ID,
            name: "Nightly recalculation",
            sys_name: "Nightly recalculation",
            sys_scope: SCOPE_ID,
            script: DYNAMIC_SCRIPT,
          },
        ]
      : [],
  };
}

// ── fixtures: the repo ──────────────────────────────────────────────────────

const AMOUNT_SPEC_PATH =
  "x_tessera_demo/sys_script_include/AmountCalculator/AmountCalculator.unit.ts";
const TOTALS_SPEC_PATH =
  "x_tessera_demo/sys_script_include/OrderTotals/OrderTotals.unit.ts";

const target = (table, sysId, name) => ({ table, sysId, name });

/**
 * One registered spec against `AmountCalculator`, and nothing else — so the
 * clean run has one declared artifact and three gaps. A fixture where everything
 * had a spec would let a join that returns its input unchanged pass.
 */
const ONE_SPEC = {
  manifest: {
    version: 1,
    specs: [
      {
        id: "amount-unit",
        path: AMOUNT_SPEC_PATH,
        kind: "unit",
        targets: [target("sys_script_include", AMOUNT_ID, "AmountCalculator")],
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
  "SN_PROFILE_SOURCE_INSTANCE",
  "SN_PROFILE_SOURCE_USER",
  "SN_PROFILE_SOURCE_PASSWORD",
];

// ── harness ─────────────────────────────────────────────────────────────────

const tempRoots = [];

async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-coverage-"));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Lay a tests root down under the injected cwd.
 *
 * `manifest` may be an object (serialised) or a raw string, because two cases
 * below need a manifest that is NOT valid JSON — and the whole point of those
 * cases is that the reader meets the bytes rather than a shape.
 *
 * The spec bodies are a comment. The inventory joins on identity and targets and
 * deliberately never opens the file it lists, so a realistic body here would
 * assert nothing and imply something false.
 */
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
 * Stand the source instance up behind a host-dispatching `fetch`, stage the one
 * credential profile it answers to, write the tests root, and hand back an
 * injectable context.
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
    return fake.fetch(input, init);
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
    root,
    testsRoot,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    /** The single JSON document a `--json` run prints. */
    json: () => JSON.parse(out.join("\n")),
    context: {
      now: () => new Date("2026-02-02T03:04:05.000Z"),
      actor: "test",
      cwd: root,
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

/** Every HTTP method the fake served — coverage may only ever produce GET. */
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
 * printed before any read. Cases that care about "what the join said" want the
 * part after that block.
 */
function reportOf(h) {
  return h.out.slice(2).join("\n");
}

// ── help ────────────────────────────────────────────────────────────────────

describe("tess coverage — help", () => {
  it("prints one document, exits 0, and states that 1 is never returned", async () => {
    const { code, h } = await run(["coverage", "--help"]);

    assert.equal(code, EXIT_CODES.ok);
    // One write: help piped into a pager must not arrive in fragments.
    assert.equal(h.out.length, 1);
    assert.match(h.stdout(), /^tess coverage — which impacted artifacts/);
    assert.match(h.stdout(), /^ {2}1 is never returned/m);
    // The one sentence the command exists to keep true.
    assert.match(h.stdout(), /INTENT, not confirmed coverage/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("asks for help even when the rest of the argv would have run", async () => {
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE, "--help"], {
      specs: ONE_SPEC,
    });

    assert.equal(code, EXIT_CODES.ok);
    assert.deepEqual(h.fake.requests(), []);
  });
});

// ── exit 2 ──────────────────────────────────────────────────────────────────

describe("tess coverage — refusals of the request (exit 2)", () => {
  it("refuses when neither --source nor --instance named an instance", async () => {
    const { code, h } = await run(["coverage", ...SCOPE], { specs: ONE_SPEC });

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /^tess coverage: no source instance/m);
    assert.match(h.stderr(), /--source <profile>/);
    assert.match(h.stderr(), /--instance <profile>/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses a run with no scope rather than dividing by an unbounded set", async () => {
    const { code, h } = await run(["coverage", ...SOURCE], { specs: ONE_SPEC });

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /^tess coverage: no scope/m);
    // The denominator is the point: a report over "every artifact on the
    // instance" is a different question, not this one with a flag left off.
    assert.match(h.stderr(), /the impacted set this report divides by/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses a tests root that is not there BEFORE it touches the instance", async () => {
    const { code, h } = await run(
      ["coverage", ...SOURCE, ...SCOPE, "--tests-root", "no-such-dir"],
      { specs: ONE_SPEC },
    );

    assert.equal(code, EXIT_CODES.usage);
    assert.match(
      h.stderr(),
      /^tess coverage: the tests root .* is not readable/m,
    );
    // The flag the operator has to edit is quoted back verbatim, because the
    // message otherwise names only the absolute path it resolved to.
    assert.match(h.stderr(), /\(--tests-root no-such-dir\)/);
    // The property this case is actually for: the cheap read runs first, so a
    // mistyped path costs nothing. Asserted as "no request was made" rather
    // than as a message, which would pass either way.
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses a tests root that is a file rather than reading it as a manifest", async () => {
    const { code, h } = await run(
      ["coverage", ...SOURCE, ...SCOPE, "--tests-root", "tests/.manifest.json"],
      { specs: ONE_SPEC },
    );

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /is not a directory/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses a scope the instance says does not exist", async () => {
    const { code, h } = await run(
      ["coverage", ...SOURCE, "--scope", "x_not_installed"],
      { specs: ONE_SPEC },
    );

    assert.equal(code, EXIT_CODES.usage);
    assert.match(
      h.stderr(),
      /no application scope named `x_not_installed` on the source instance/,
    );
    assert.doesNotMatch(h.stdout(), /^impacted artifacts/m);
  });

  it("prints nothing at all on stdout when --json meets a bad request", async () => {
    const { code, h } = await run(["coverage", "--json", ...SOURCE], {
      specs: ONE_SPEC,
    });

    assert.equal(code, EXIT_CODES.usage);
    // A consumer piping stdout into a parser gets an empty stream, not half a
    // document — the diagnosis is on stderr where it cannot corrupt the parse.
    assert.deepEqual(h.out, []);
    assert.match(h.stderr(), /^tess coverage: no scope/m);
  });
});

// ── exit 0 ──────────────────────────────────────────────────────────────────

describe("tess coverage — a clean join (exit 0)", () => {
  it("marks every impacted artifact as spec'd or GAP, and exits 0 with gaps in it", async () => {
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: ONE_SPEC,
    });

    // Three of the four artifacts have no spec, and the command still exits 0.
    // That is the QA-8 contract, not an oversight: a gap is a hole in a plan,
    // and this command holds no evidence with which to fail a build.
    assert.equal(code, EXIT_CODES.ok);
    const report = reportOf(h);

    assert.match(
      report,
      /^source: source <dev-coverage-source\.service-now\.com>$/m,
    );
    assert.match(
      report,
      /^tests root: .*[/\\]tests \(1 spec\(s\) registered\)$/m,
    );
    assert.match(report, /^impacted artifacts \(4, 3 with no spec\):$/m);

    // The declared join, and only it: the spec names `sys_script_include/aaa1`
    // in its `targets`, so that row is the one that carries it (QA-16).
    assert.match(
      report,
      /^ {2}spec {2}sys_script_include\/aaa10* {2}AmountCalculator$/m,
    );
    assert.match(
      report,
      new RegExp(`^ {6}unit {2}amount-unit {2}${AMOUNT_SPEC_PATH}$`, "m"),
    );
    // `OrderTotals` sits in the same directory tree as the spec above and shares
    // its naming convention. It is a GAP, because no manifest entry names it —
    // a path-shaped inference would have got this row wrong.
    assert.match(
      report,
      /^ {2}GAP {3}sys_script_include\/bbb20* {2}OrderTotals$/m,
    );
    assert.match(
      report,
      /^ {2}GAP {3}sys_script\/ccc30* {2}Recalculate totals$/m,
    );
    assert.match(report, /^ {2}GAP {3}sys_ui_action\/ddd40* {2}Recalculate$/m);

    // The closing line refuses the misreading in the same breath as the number.
    assert.match(
      report,
      /^3 of 4 impacted artifact\(s\) in scope x_tessera_demo on source have no spec declaring them — DECLARED INTENT only/m,
    );
    assert.match(report, /confirmed coverage is computed after a run \(QA-8\)/);
    assert.doesNotMatch(report, /INCOMPLETE/);
    assert.doesNotMatch(report, /\[unanalyzable\]/);

    // ARCH-8: this command binds one role and writes nothing, and the only
    // proof of that is the method log.
    assert.deepEqual(methods(h.fake), ["GET"]);
  });

  it("sorts rows by (table, sysId) so two runs of one instance diff cleanly", async () => {
    const { h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: ONE_SPEC,
    });

    const rows = reportOf(h)
      .split("\n")
      .filter((line) => /^ {2}(GAP|spec) {2,}/.test(line))
      .map((line) => line.trim().split(/ {2,}/)[1]);

    assert.deepEqual(rows, [
      `sys_script/${RULE_ID}`,
      `sys_script_include/${AMOUNT_ID}`,
      `sys_script_include/${TOTALS_ID}`,
      `sys_ui_action/${ACTION_ID}`,
    ]);
  });

  it("resolves a relative --tests-root against the injected cwd, not the process one", async () => {
    // No `--tests-root` at all: the default is `tests`, and `tests` has to mean
    // the directory the config layers were discovered from. If this resolved
    // against `process.cwd()` it would read the repo running the test suite.
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: ONE_SPEC,
    });

    assert.equal(code, EXIT_CODES.ok);
    assert.match(
      reportOf(h),
      new RegExp(
        `^tests root: ${h.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "m",
      ),
    );
    assert.match(reportOf(h), /^tests root: .*\(1 spec\(s\) registered\)$/m);
  });

  it("says the repo is empty, not unread, when the tests root has no manifest", async () => {
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: { files: [] },
    });

    // The OPP-1b pair. This run and the exit-3 run below both see zero specs;
    // one is a repo that has not written any, the other is a registry that
    // would not open. They must never render alike, and the exit code is the
    // first place that has to hold.
    assert.equal(code, EXIT_CODES.ok);
    const report = reportOf(h);
    assert.match(report, /\(0 spec\(s\) registered\)$/m);
    assert.match(report, /^impacted artifacts \(4, 4 with no spec\):$/m);
    assert.match(
      report,
      /\[info\] specs: no \.manifest\.json in .*: the tests root exists and registers no specs yet/,
    );
    assert.match(report, /not because anything could not be read/);
    assert.doesNotMatch(report, /INCOMPLETE/);
  });

  it("warns about a spec aimed outside the impacted set without calling the run incomplete", async () => {
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: {
        manifest: {
          version: 1,
          specs: [
            ...ONE_SPEC.manifest.specs,
            {
              id: "retired-unit",
              path: TOTALS_SPEC_PATH,
              kind: "unit",
              targets: [
                target("sys_script_include", RETIRED_ID, "RetiredThing"),
              ],
            },
          ],
        },
        files: [AMOUNT_SPEC_PATH, TOTALS_SPEC_PATH],
      },
    });

    // A stray declaration is evidence about some OTHER change, so it warns and
    // does NOT flip the incomplete flag: nothing about this analysis was left
    // unread. Exit 0 with a WARNING on the page is the intended shape.
    assert.equal(code, EXIT_CODES.ok);
    const report = reportOf(h);
    assert.match(
      report,
      /\[WARNING\] intent: 1 declared spec target\(s\) are not in this impacted artifact set/,
    );
    assert.match(
      report,
      new RegExp(`retired-unit → sys_script_include/${RETIRED_ID}`),
    );
    // Both specs are registered; only the one with an impacted target joins.
    assert.match(report, /\(2 spec\(s\) registered\)$/m);
    assert.match(report, /^impacted artifacts \(4, 3 with no spec\):$/m);
    assert.doesNotMatch(report, /INCOMPLETE/);
  });

  it("attributes every note to the reader that wrote it", async () => {
    const { h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: ONE_SPEC,
    });
    const report = reportOf(h);

    // Four readers feed this stream and they send an operator to four different
    // places, so a note that does not name its source is a note nobody can act
    // on. The intent line is the one that is always present.
    assert.match(
      report,
      /\[info\] intent: 3 of 4 impacted artifact\(s\) have no spec declaring them as a target/,
    );
    // The resolution half keeps the sub-source its own resolvers wrote —
    // `story`, `scope` — instead of being flattened to one "source" label. That
    // is the finer attribution, and re-labelling it here to match the other
    // three would throw away the only thing that says WHICH resolver spoke.
    for (const line of report.split("\n").filter((l) => l.startsWith("  ["))) {
      assert.match(
        line,
        /^ {2}\[(WARNING|info)\] (story|scope|impact|specs|intent): /,
      );
    }
    assert.match(report, /^ {2}\[info\] scope: /m);
  });
});

// ── JSON ────────────────────────────────────────────────────────────────────

describe("tess coverage — the machine-readable report", () => {
  it("emits exactly one write and one document, with the gap list broken out", async () => {
    const { code, h } = await run(["coverage", "--json", ...SOURCE, ...SCOPE], {
      specs: ONE_SPEC,
    });

    assert.equal(code, EXIT_CODES.ok);
    assert.equal(h.out.length, 1);
    const doc = h.json();

    assert.deepEqual(doc.source, { profile: "source", host: SOURCE_HOST });
    assert.deepEqual(doc.input, { scope: SCOPE_NAME });
    assert.equal(doc.testsRoot, path.join(h.root, "tests"));
    assert.equal(doc.incomplete, false);
    assert.deepEqual(doc.counts, {
      impacted: 4,
      withSpec: 1,
      gaps: 3,
      unanalyzable: 0,
      specsInRoot: 1,
    });

    // QA-8 must survive the `--json` boundary. This file's header forbids
    // wording OR COUNTING as though a run had happened, and `counts` above is
    // exactly such a count: without `basis`, a consumer reading `withSpec: 1`
    // out of `gaps: 3` has been handed a coverage ratio with nothing marking it
    // as a plan. The human branch is asserted separately (it must close with
    // "DECLARED INTENT only … computed after a run (QA-8)"); this is the same
    // guarantee on the machine path, which is where it was missing.
    assert.equal(doc.basis, "declared-intent");

    // `gaps` is redundant with `entries` on purpose: it is the generation
    // work-list, and a consumer should not have to re-derive it by filtering.
    assert.deepEqual(
      doc.gaps.map((ref) => `${ref.table}/${ref.sysId}`).sort(),
      [
        `sys_script/${RULE_ID}`,
        `sys_script_include/${TOTALS_ID}`,
        `sys_ui_action/${ACTION_ID}`,
      ].sort(),
    );
    assert.equal(
      doc.gaps.length,
      doc.entries.filter((entry) => entry.specs.length === 0).length,
    );

    const amount = doc.entries.find(
      (entry) => entry.artifact.sysId === AMOUNT_ID,
    );
    assert.equal(amount.analyzable, true);
    assert.deepEqual(amount.specs, [
      { id: "amount-unit", path: AMOUNT_SPEC_PATH, kind: "unit" },
    ]);

    // The config-precedence block belongs to the human report only: it is not
    // JSON, and printing it here would break the parse it exists beside.
    assert.doesNotMatch(h.stdout(), /^config file:/m);
  });

  it("carries only the three identity fields of an artifact, never a body", async () => {
    const { h } = await run(["coverage", "--json", ...SOURCE, ...SCOPE], {
      specs: ONE_SPEC,
    });
    const doc = h.json();

    for (const entry of doc.entries) {
      assert.deepEqual(Object.keys(entry.artifact).sort(), [
        "name",
        "sysId",
        "table",
      ]);
    }
  });
});

// ── exit 3 ──────────────────────────────────────────────────────────────────

describe("tess coverage — no evidence was produced (exit 3)", () => {
  it("faults on a manifest that is there and will not parse, before any read", async () => {
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: { manifest: "{ not json at all", files: [] },
    });

    // The other half of the OPP-1b pair. A registry that exists and cannot be
    // read says NOTHING about what the repo intends, and reporting it as four
    // gaps would invent a work-list out of an I/O failure (DEV-1).
    assert.equal(code, EXIT_CODES.fault);
    assert.match(h.stderr(), /^INFRASTRUCTURE FAULT \(DEV-1\): /m);
    assert.match(h.stderr(), /\.manifest\.json is not valid JSON/);
    assert.match(h.stderr(), /no evidence was produced about any test/);
    assert.deepEqual(h.fake.requests(), []);
    assert.doesNotMatch(h.stdout(), /^impacted artifacts/m);
  });

  it("faults on a manifest version it does not understand", async () => {
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: { manifest: { version: 2, specs: [] }, files: [] },
    });

    // Reading a newer format on a guess is how a reader silently drops the
    // field that says which specs are disabled.
    assert.equal(code, EXIT_CODES.fault);
    assert.match(h.stderr(), /is version 2; this reader understands version 1/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("faults rather than reporting an empty impacted set when sys_scope 500s", async () => {
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: ONE_SPEC,
      faults: [faultOn("sys_scope", { kind: "http-error", status: 500 })],
    });

    assert.equal(code, EXIT_CODES.fault);
    assert.match(h.stderr(), /^INFRASTRUCTURE FAULT \(DEV-1\): /m);
    assert.match(
      h.stderr(),
      /could not read sys_scope to resolve `x_tessera_demo`/,
    );
    // An impacted set of zero would have printed "nothing here for a spec to
    // declare", which is a statement about the repo made out of a 500.
    assert.doesNotMatch(h.stdout(), /^impacted artifacts/m);
  });

  it("puts nothing on stdout in --json mode when the read never completed", async () => {
    const { code, h } = await run(["coverage", "--json", ...SOURCE, ...SCOPE], {
      specs: ONE_SPEC,
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
});

// ── exit 5 ──────────────────────────────────────────────────────────────────

describe("tess coverage — incomplete joins (exit 5)", () => {
  it("is inconclusive when a registered spec file is missing from disk", async () => {
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: { manifest: ONE_SPEC.manifest, files: [] },
    });

    // The inventory read only part of what the manifest declared, so the gap
    // set OVERSTATES what has no spec — the opposite direction of error from an
    // untraced artifact, and both land on the same exit code.
    assert.equal(code, EXIT_CODES.inconclusive);
    const report = reportOf(h);
    assert.match(
      report,
      /\[WARNING\] specs: dropped entry `amount-unit`: there is no file at/,
    );
    assert.match(
      report,
      /\[WARNING\] intent: the spec inventory was not fully read/,
    );
    assert.match(report, /^INCOMPLETE — 4 of 4 impacted artifact\(s\)/m);
    assert.match(report, /this ratio is not a measurement \(QA-9\)/);
  });

  it("is inconclusive, and says so per row, when an artifact could not be traced", async () => {
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      state: { dynamic: true },
      specs: ONE_SPEC,
    });

    assert.equal(code, EXIT_CODES.inconclusive);
    const report = reportOf(h);
    // QA-15: the artifact nobody could trace is still in the denominator, and
    // it is marked — a spec'd artifact that was traced and a spec'd artifact
    // that was not are not the same fact.
    assert.match(report, /^impacted artifacts \(5, 4 with no spec\):$/m);
    assert.match(
      report,
      /^ {2}GAP {3}sysauto_script\/eee50* {2}Nightly recalculation {2}\[unanalyzable\]$/m,
    );
    assert.match(report, /^INCOMPLETE — 4 of 5 impacted artifact\(s\)/m);
  });

  it("stays inconclusive in --json mode, with the flag and the count agreeing", async () => {
    const { code, h } = await run(["coverage", "--json", ...SOURCE, ...SCOPE], {
      state: { dynamic: true },
      specs: ONE_SPEC,
    });

    assert.equal(code, EXIT_CODES.inconclusive);
    const doc = h.json();
    assert.equal(doc.incomplete, true);
    assert.equal(doc.counts.impacted, 5);
    assert.equal(doc.counts.unanalyzable, 1);
    assert.equal(
      doc.entries.filter((entry) => !entry.analyzable).length,
      doc.counts.unanalyzable,
    );
  });

  it("is inconclusive when a consumer table refuses the read", async () => {
    const { code, h } = await run(["coverage", ...SOURCE, ...SCOPE], {
      specs: ONE_SPEC,
      faults: [faultOn("sys_ui_policy", { kind: "http-error", status: 403 })],
    });

    // The impacted set is a floor, not an answer, so no ratio computed over it
    // is a measurement — even though every row printed is true.
    assert.equal(code, EXIT_CODES.inconclusive);
    assert.match(
      reportOf(h),
      /\[WARNING\] impact: sys_ui_policy could not be searched for usage/,
    );
    assert.match(reportOf(h), /^INCOMPLETE — /m);
  });
});

// ── TM-1 ────────────────────────────────────────────────────────────────────

describe("tess coverage — TM-1: no script text leaves the analyzer", () => {
  for (const [mode, argv] of [
    ["human", ["coverage", ...SOURCE, ...SCOPE]],
    ["json", ["coverage", "--json", ...SOURCE, ...SCOPE]],
  ]) {
    it(`prints no body, excerpt or marker text in ${mode} mode`, async () => {
      const { code, h } = await run(argv, {
        state: { dynamic: true },
        specs: ONE_SPEC,
      });

      // Not a clean run: the dynamic consumer is deliberately present, which is
      // the row whose explanation quotes something ABOUT a body.
      assert.equal(code, EXIT_CODES.inconclusive);
      assert.doesNotMatch(h.stdout(), new RegExp(CANARY));
      assert.doesNotMatch(h.stderr(), new RegExp(CANARY));
      assert.doesNotMatch(h.stdout(), /Class\.create/);
      assert.doesNotMatch(h.stdout(), /gs\.getProperty/);
    });
  }
});
