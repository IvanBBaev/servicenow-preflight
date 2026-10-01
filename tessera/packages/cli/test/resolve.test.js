// `tess resolve` — ARCH-5 resolution, wired, against the QA-18 stateful fake.
//
// The unit suites in `@tessera/resolvers` already prove what each adapter does
// with a canned read; duplicating them here would only add slower copies. What
// nothing below that layer can prove is the wire itself — argv, the four config
// layers, §2a role binding, the real transport, the composite, and the number
// the process finally exits with. That number IS the contract of this command:
// four codes are reachable, the fifth must not be, and a CI job that keys off
// the wrong one turns a partial answer into a green gate.
//
// Three properties are load-bearing in nearly every case, and all three are
// borrowed from `preflight.test.js` for the same reasons:
//
//   * `env: {}` on the injected context and a temp `cwd`. Otherwise an ambient
//     `TESSERA_*` or a `tessera.config.json` somewhere above the repo quietly
//     becomes a config layer and the assertions stop meaning what they say.
//   * a hand-written host-routing `fetch` that REJECTS an unknown host. The
//     command binds exactly one profile (ARCH-19), so a read that drifted onto
//     another instance has to fail loudly rather than be answered by the fake.
//   * `SN_MAX_RETRIES=0`. The transport retries idempotent GETs, which would
//     let a single-fire fault be papered over and a fault test pass as a clean
//     resolution.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import { EXIT_CODES, main } from "../build/index.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SOURCE_HOST = "dev-resolve-source.service-now.com";

/** A 32-character lowercase-hex sys_id that stays readable in a diff. */
const hex = (prefix) => prefix.padEnd(32, "0");

const STORY_NUMBER = "STRY0042";
const STORY_ID = hex("57019");
const UPDATE_SET_ID = hex("5e7a");

const SCOPE_NAME = "x_tessera_demo";
const SCOPE_ID = hex("5c09e");

/** A Script Include the story changed AND the scope contains — the tie. */
const SHARED_INCLUDE_ID = hex("aaa1");
const SCOPE_INCLUDE_ID = hex("bbb2");
/** A Business Rule the story changed; no scope enumeration ever names it. */
const STORY_RULE_ID = hex("ccc3");

/**
 * One instance carrying both ARCH-5 paths over the same application: the story
 * reaches `sys_script_include/<SHARED>` through its update set, the scope
 * reaches the same row by enumeration, so the union has something real to
 * de-duplicate rather than two disjoint lists that never meet.
 */
function seed({
  linkUpdateSet = true,
  storyLinkField = "story",
  scopeIncludes = true,
} = {}) {
  return {
    rm_story: [{ sys_id: STORY_ID, number: STORY_NUMBER }],
    sys_update_set: linkUpdateSet
      ? [
          {
            sys_id: UPDATE_SET_ID,
            name: `${STORY_NUMBER} work`,
            [storyLinkField]: STORY_ID,
          },
        ]
      : [],
    sys_update_xml: [
      {
        sys_id: hex("e001"),
        name: `sys_script_include_${SHARED_INCLUDE_ID}`,
        type: "Script Include",
        target_name: "AmountCalculator",
        action: "INSERT_OR_UPDATE",
        update_set: UPDATE_SET_ID,
      },
      {
        sys_id: hex("e002"),
        name: `sys_script_${STORY_RULE_ID}`,
        type: "Business Rule",
        target_name: "Recalculate totals",
        action: "INSERT_OR_UPDATE",
        update_set: UPDATE_SET_ID,
      },
    ],
    sys_scope: [{ sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Tessera Demo" }],
    // Seeded out of alphabetical order so the adapter's `ORDERBYname` has
    // something to do and the artifact order below is the query's, not the
    // fixture's.
    sys_script_include: scopeIncludes
      ? [
          {
            sys_id: SCOPE_INCLUDE_ID,
            name: "ZoneLookup",
            sys_scope: SCOPE_ID,
            script: "var Z = {};",
          },
          {
            sys_id: SHARED_INCLUDE_ID,
            name: "AmountCalculator",
            sys_scope: SCOPE_ID,
            script: "var A = {};",
          },
        ]
      : [],
  };
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-resolve-"));
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
    ...(options.tableSchema ? { tableSchema: options.tableSchema } : {}),
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
      env: {},
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

/** Every HTTP method the fake served — resolution may only ever produce GET. */
function methods(fake) {
  return [...new Set(fake.requests().map((entry) => entry.method))].sort();
}

/** A GET fault on one table, expressed the way the fault registry wants it. */
function faultOn(table, mode) {
  return { match: { method: "GET", table }, mode };
}

const SOURCE = ["--source", "source"];

// ── the exit-code contract ──────────────────────────────────────────────────

describe("tess resolve — refusals of the request (exit 2)", () => {
  it("refuses --update-set rather than resolving the rest of the input", async () => {
    const { code, h } = await run([
      "resolve",
      ...SOURCE,
      "--update-set",
      "STRY0042 work",
    ]);

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /^tess resolve: --update-set is not supported/m);
    assert.match(h.stderr(), /DESIGN §12\.3 defers UpdateSetResolver/);
    // The refusal must beat the reads: a resolution printed under a rejected
    // input is a list of the wrong question's answer.
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses an input that names neither a story nor a scope", async () => {
    const { code, h } = await run(["resolve", ...SOURCE]);

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /nothing to resolve/);
    // An empty list here would be an artefact of the request rather than a
    // fact about the instance — so no read is issued to produce one.
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses when neither --source nor --instance named an instance", async () => {
    const { code, h } = await run(["resolve", "--story", STORY_NUMBER]);

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /^tess resolve: no source instance/m);
    // Both spellings are offered: the operator who forgot one does not know
    // which of them this command prefers.
    assert.match(h.stderr(), /--source <profile>/);
    assert.match(h.stderr(), /--instance <profile>/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses a bare host as the source and names the env keys instead", async () => {
    const { code, h } = await run([
      "resolve",
      "--source",
      `https://${SOURCE_HOST}`,
      "--story",
      STORY_NUMBER,
    ]);

    // A host carries no credentials, so binding one would read the instance
    // with whatever profile happened to be ambient (ARCH-7/18).
    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /expects a credential-store PROFILE name/);
    assert.match(h.stderr(), /SN_PROFILE_<NAME>_INSTANCE/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses a story the instance says does not exist", async () => {
    const { code, h } = await run([
      "resolve",
      ...SOURCE,
      "--story",
      "STRY9999",
    ]);

    // The instance ANSWERED and the answer was "no such row". That is the
    // user's argument to fix, not an infrastructure fault — the whole point of
    // catching ResolutionInputError in the command rather than in `cli.ts`.
    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /no rm_story matches `number=STRY9999` on source/);
    assert.match(
      h.stderr(),
      /the instance answered, and there is no such story/,
    );
  });

  it("refuses a scope the instance says does not exist", async () => {
    const { code, h } = await run([
      "resolve",
      ...SOURCE,
      "--scope",
      "x_not_installed",
    ]);

    assert.equal(code, EXIT_CODES.usage);
    assert.match(
      h.stderr(),
      /no application scope named `x_not_installed` on the source instance/,
    );
  });
});

describe("tess resolve — the instance never answered (exit 3)", () => {
  for (const [what, fault, evidence] of [
    [
      "a 403 on rm_story",
      faultOn("rm_story", { kind: "http-error", status: 403 }),
      /read refused \(403\) for the connected user/,
    ],
    [
      "a 500 on sys_update_set",
      faultOn("sys_update_set", { kind: "http-error", status: 500 }),
      // Not "query rejected (500)": a 500 never got as far as evaluating the
      // query, so the old wording named a cause the read never established.
      /status 500 and nothing was said about the rows/,
    ],
    [
      "a dropped connection on sys_update_xml",
      faultOn("sys_update_xml", {
        kind: "transport-error",
        message: "socket hang up",
      }),
      /socket hang up/,
    ],
  ]) {
    it(`reports ${what} as an infrastructure fault, never as an empty list`, async () => {
      const { code, h } = await run(
        ["resolve", ...SOURCE, "--story", STORY_NUMBER],
        { faults: [fault] },
      );

      assert.equal(code, EXIT_CODES.fault);
      assert.match(h.stderr(), /^INFRASTRUCTURE FAULT \(DEV-1\): /m);
      assert.match(h.stderr(), evidence);
      assert.match(h.stderr(), /no evidence was produced about any test/);
      // Nothing that reads like a resolution reached stdout.
      assert.doesNotMatch(h.stdout(), /^artifacts/m);
      assert.doesNotMatch(h.stdout(), /^resolved /m);
    });
  }

  it("faults on a scope read even though the story already found artifacts", async () => {
    const { code, h } = await run(
      ["resolve", ...SOURCE, "--story", STORY_NUMBER, "--scope", SCOPE_NAME],
      {
        faults: [
          faultOn("sys_script_include", { kind: "http-error", status: 403 }),
        ],
      },
    );

    // The two artifacts the story named are real, and they are still not an
    // answer: half of the union could not be read, and printing the readable
    // half under a 0 or a 5 would present a fragment as the list (QA-9/DEV-1).
    assert.equal(code, EXIT_CODES.fault);
    assert.match(
      h.stderr(),
      /nothing could be read about the contents of scope `x_tessera_demo`/,
    );
    assert.doesNotMatch(h.stdout(), /AmountCalculator/);
  });
});

describe("tess resolve — incomplete resolutions (exit 5)", () => {
  it("is inconclusive when a story has no update sets linked to it", async () => {
    const { code, h } = await run(
      ["resolve", ...SOURCE, "--story", STORY_NUMBER],
      { state: { linkUpdateSet: false } },
    );

    assert.equal(code, EXIT_CODES.inconclusive);
    assert.match(h.stdout(), /\[WARNING\] story: STRY0042 has no update sets/);
    assert.match(h.stdout(), /^INCOMPLETE — 0 artifact\(s\) named/m);
  });

  it("stays inconclusive even when artifacts were found (QA-9)", async () => {
    const { code, h } = await run(
      ["resolve", ...SOURCE, "--story", STORY_NUMBER, "--scope", SCOPE_NAME],
      { state: { linkUpdateSet: false } },
    );

    // The scope answered in full and named two artifacts; the story did not
    // answer in full. A CI job that keyed off "the array is non-empty" would
    // read this as a resolution, so the exit code — not the list — carries it.
    assert.equal(code, EXIT_CODES.inconclusive);
    assert.match(h.stdout(), /^artifacts \(2\):$/m);
    assert.match(
      h.stdout(),
      /^INCOMPLETE — 2 artifact\(s\) named, .*this list is not the answer \(QA-9\)$/m,
    );
  });

  it("carries the same verdict into --json as `incomplete`", async () => {
    const { code, h } = await run(
      [
        "resolve",
        ...SOURCE,
        "--story",
        STORY_NUMBER,
        "--scope",
        SCOPE_NAME,
        "--json",
      ],
      { state: { linkUpdateSet: false } },
    );

    assert.equal(code, EXIT_CODES.inconclusive);
    const report = h.json();
    assert.equal(report.incomplete, true);
    assert.equal(report.count, 2);
    assert.ok(
      report.notes.some((note) => note.level === "warning"),
      "the warning that made the run inconclusive must be in the document",
    );
  });

  it("says so in words when a scope contains nothing (W6a M3)", async () => {
    const { code, h } = await run(
      ["resolve", ...SOURCE, "--scope", SCOPE_NAME],
      { state: { scopeIncludes: false } },
    );

    // Every source answered and none of them named an artifact. Since W6a M3
    // an empty scope is a warning, not a clean answer: it would otherwise let
    // a mistyped or unreadable scope pass as "nothing to test".
    assert.equal(code, EXIT_CODES.inconclusive);
    assert.match(
      h.stdout(),
      /^artifacts: none — this resolution named no artifact$/m,
    );
    assert.match(
      h.stdout(),
      /\[WARNING\] scope: scope `x_tessera_demo` resolved to no artifacts/,
    );
    assert.match(h.stdout(), /^INCOMPLETE — 0 artifact\(s\) named/m);
    assert.doesNotMatch(h.stdout(), /^resolved 0 artifact\(s\)/m);
  });
});

describe("tess resolve — a resolution that can be acted on (exit 0)", () => {
  it("resolves a story to its update set's members, reading only (ARCH-8)", async () => {
    const { code, h } = await run([
      "resolve",
      ...SOURCE,
      "--story",
      STORY_NUMBER,
    ]);

    assert.equal(code, EXIT_CODES.ok);
    assert.match(h.stdout(), /^resolved 2 artifact\(s\) from source$/m);
    assert.equal(h.stderr(), "");
    // The module header's claim that this command is safe against production
    // by construction is only worth as much as this assertion.
    assert.deepEqual(methods(h.fake), ["GET"]);
  });

  it("binds the source through the ARCH-29 --instance alias too", async () => {
    const { code, h } = await run([
      "resolve",
      "--instance",
      "source",
      "--scope",
      SCOPE_NAME,
    ]);

    assert.equal(code, EXIT_CODES.ok);
    // The alias is reported as the layer it came from, so a surprising
    // instance can be traced to the flag that chose it.
    assert.match(h.stdout(), /^source = source \(from flag via --instance\)$/m);
    assert.match(
      h.stdout(),
      /^source: source <dev-resolve-source\.service-now\.com>$/m,
    );
  });

  it("reaches the story adapter with --update-set-story-field (OPP-1b)", async () => {
    const state = { storyLinkField: "u_story" };
    // Delegated decision 2026-09-26: the instance's `sys_update_set` schema is
    // declared rather than inferred from the seeded row. A real instance with
    // the Agile plugin carries BOTH the out-of-box `story` reference and the
    // customer's `u_story`; this one just never populated `story`. Declaring
    // it keeps the default query a real filter that matches nothing, instead
    // of an unknown-field term a real instance would drop (the fake's
    // `"ignore"` default) and so answer unfiltered.
    const tableSchema = {
      sys_update_set: ["sys_id", "name", "story", "u_story"],
    };

    const def = await run(["resolve", ...SOURCE, "--story", STORY_NUMBER], {
      state,
      tableSchema,
    });
    // The default column finds nothing on this instance, and "nothing" is a
    // warning rather than a clean zero precisely because it may be a wrong
    // field name rather than an empty story.
    assert.equal(def.code, EXIT_CODES.inconclusive);

    const { code, h } = await run(
      [
        "resolve",
        ...SOURCE,
        "--story",
        STORY_NUMBER,
        "--update-set-story-field",
        "u_story",
      ],
      { state, tableSchema },
    );

    assert.equal(code, EXIT_CODES.ok);
    assert.match(h.stdout(), /^resolved 2 artifact\(s\) from source$/m);
  });
});

describe("tess resolve — the code it must never return", () => {
  /** The four codes `exitCodeFor` and `cli.ts` between them can produce. */
  const CONTRACT = new Set([
    EXIT_CODES.ok,
    EXIT_CODES.usage,
    EXIT_CODES.fault,
    EXIT_CODES.inconclusive,
  ]);

  const PATHS = [
    ["a clean resolution", ["--story", STORY_NUMBER], {}],
    ["a rejected input", ["--update-set", "x"], {}],
    [
      "an unreadable instance",
      ["--story", STORY_NUMBER],
      { faults: [faultOn("rm_story", { kind: "http-error", status: 500 })] },
    ],
    [
      "an incomplete resolution",
      ["--story", STORY_NUMBER],
      { state: { linkUpdateSet: false } },
    ],
  ];

  for (const [what, rest, options] of PATHS) {
    it(`answers 1 (noGo) on no path — checked on ${what}`, async () => {
      const { code } = await run(["resolve", ...SOURCE, ...rest], options);

      // `noGo` is a verdict about a change, and resolution renders no verdict:
      // it answers "which artifacts", or it fails to. A 1 out of this command
      // is a bug, not a rejection.
      assert.notEqual(code, EXIT_CODES.noGo);
      assert.ok(CONTRACT.has(code), `exit ${code} is outside the contract`);
    });
  }
});

// ── the union, and how it is reported ───────────────────────────────────────

describe("tess resolve — the ARCH-5 union", () => {
  it("de-duplicates by sys_id and lets the story own the shared row", async () => {
    const { code, h } = await run([
      "resolve",
      ...SOURCE,
      "--story",
      STORY_NUMBER,
      "--scope",
      SCOPE_NAME,
      "--json",
    ]);

    assert.equal(code, EXIT_CODES.ok);
    const report = h.json();
    // Three rows out of four found: the scope's AmountCalculator is the story's
    // row seen a second time, and the union reports it once.
    assert.deepEqual(
      report.artifacts.map((artifact) => [
        artifact.table,
        artifact.sysId,
        artifact.resolvedBy,
      ]),
      [
        ["sys_script_include", SHARED_INCLUDE_ID, "story"],
        ["sys_script", STORY_RULE_ID, "story"],
        ["sys_script_include", SCOPE_INCLUDE_ID, "scope"],
      ],
    );
    // Order sets reporting precedence, not first-wins: the scope adapter still
    // ran and its own find is still in the list.
    assert.equal(report.count, 3);
    assert.equal(report.incomplete, false);
    // The losing source is never silently dropped — two sources agreeing on an
    // artifact is information the single `resolvedBy` label cannot carry.
    assert.ok(
      report.notes.some((note) =>
        /was also resolved by scope; reported as story \(ARCH-5 precedence\)/.test(
          note.message,
        ),
      ),
      "the de-duplication tie must be reported",
    );
  });
});

describe("tess resolve --json", () => {
  it("prints exactly one parseable document and nothing else", async () => {
    const { code, h } = await run([
      "resolve",
      ...SOURCE,
      "--story",
      STORY_NUMBER,
      "--json",
    ]);

    assert.equal(code, EXIT_CODES.ok);
    // One write, not one document assembled from several: a consumer piping
    // stdout into a parser must not have to reassemble it, and the config
    // precedence block must not be in front of it.
    assert.equal(h.out.length, 1);
    const report = JSON.parse(h.out[0]);

    assert.deepEqual(report.source, {
      profile: "source",
      host: SOURCE_HOST,
    });
    assert.deepEqual(report.input, { story: STORY_NUMBER });
    assert.equal(report.count, 2);
    assert.equal(report.count, report.artifacts.length);
    assert.equal(report.incomplete, false);
    assert.deepEqual(report.artifacts[0], {
      table: "sys_script_include",
      sysId: SHARED_INCLUDE_ID,
      name: "AmountCalculator",
      resolvedBy: "story",
    });
    // Every note the adapters wrote, still attributed to the adapter that
    // wrote it — "scope could not read X" and "story could not read X" send an
    // operator to two different places.
    assert.ok(report.notes.length > 0);
    for (const note of report.notes) {
      assert.ok(["story", "scope"].includes(note.source));
      assert.ok(["info", "warning"].includes(note.level));
      assert.equal(typeof note.message, "string");
    }
  });
});

describe("tess resolve — the human-readable report", () => {
  it("addresses every artifact as <table>/<sys_id> beside its source", async () => {
    const { code, h } = await run([
      "resolve",
      ...SOURCE,
      "--story",
      STORY_NUMBER,
      "--scope",
      SCOPE_NAME,
    ]);

    assert.equal(code, EXIT_CODES.ok);
    assert.match(h.stdout(), /^artifacts \(3\):$/m);
    // table/sys_id rather than a display name alone: the label is what a human
    // recognises, the pair is what they can open.
    assert.match(
      h.stdout(),
      new RegExp(
        `^ {2}story {2}sys_script_include/${SHARED_INCLUDE_ID} {2}AmountCalculator$`,
        "m",
      ),
    );
    assert.match(
      h.stdout(),
      new RegExp(
        `^ {2}scope {2}sys_script_include/${SCOPE_INCLUDE_ID} {2}ZoneLookup$`,
        "m",
      ),
    );
  });

  it("logs which config layer chose the instance before it reads it", async () => {
    const { code, h } = await run([
      "resolve",
      ...SOURCE,
      "--story",
      STORY_NUMBER,
    ]);

    assert.equal(code, EXIT_CODES.ok);
    // An answer printed after the read is an answer about a read that already
    // went to the wrong place, so the whole precedence block — every option
    // beside the layer that won it — leads the output.
    assert.match(
      h.out[0],
      /^config file: none \(no tessera\.config\.json found\)$/m,
    );
    assert.match(h.out[0], /^source = source \(from flag\)$/m);
    assert.match(h.out[0], /^updateSetStoryField = story \(from default\)$/m);
  });
});

// ── help ────────────────────────────────────────────────────────────────────

describe("tess resolve --help", () => {
  it("renders the command's own help without resolving anything", async () => {
    const { code, h } = await run(["resolve", "--help"]);

    assert.equal(code, EXIT_CODES.ok);
    assert.equal(h.out.length, 1);
    assert.match(
      h.stdout(),
      /^tess resolve — what does this story or scope actually affect\?$/m,
    );
    // The flag list is derived from RESOLVE_OPTIONS, so a documented flag and
    // an existing flag are the same set.
    assert.match(h.stdout(), /^ {2}--story /m);
    assert.match(h.stdout(), /^ {2}--update-set /m);
    // The absent fifth code is stated where an operator will look for it.
    assert.match(h.stdout(), /^ {2}1 is never returned\./m);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("is listed in the top-level help", async () => {
    const { code, h } = await run(["--help"]);

    assert.equal(code, EXIT_CODES.ok);
    assert.match(h.stdout(), /^ {2}resolve {5}What does this story or scope/m);
  });
});
