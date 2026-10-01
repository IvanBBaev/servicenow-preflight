// `tess generate` — the composition root's write command, wired, against the
// QA-18 fake.
//
// `@tessera/generate` already proves what the gate refuses, what the prompt
// fences, what the quality bar rejects and what the writer puts on disk. None of
// those suites can prove the thing this file exists for: that the CLI hands
// those parts to each other in the right order, with the right exit code falling
// out of the bottom, and that the one command in the workspace which WRITES
// writes only where it promised.
//
// Four properties are the whole contract, and each is a section below.
//
//   * **Nothing is armed** (DEV-4). Every byte this command produces lands under
//     `<tests-root>/proposed/`, plus one manifest beside the live one and NEVER
//     on top of it. The live `.manifest.json` is hashed before and after and must
//     be identical to the byte — asserted as a hash rather than as "the command
//     did not say it wrote it", because a report is not evidence about a disk.
//   * **The refusals are free.** An operator's mistake — no source, no scope, a
//     kind that does not exist, a key on the command line — is exit 2 with
//     `requests() === []`. A run that charged a scope's full where-used search
//     before noticing `--kind integration` would still print the right message.
//   * **1 is never returned.** A proposed spec has not been run, so it settles
//     nothing (QA-8/OPP-1b). Every case below records its code into `SEEN`, and
//     the last test in the file asserts 1 is not in it.
//   * **No untrusted byte escapes** (TM-1). `CANARY` lives only inside a script
//     body on the fake instance. It must reach neither stdout, nor stderr, nor
//     any file this command writes.
//
// The instance fixture is `coverage.test.js`'s, duplicated for the reason that
// file gives about `impact.test.js`: a shared fixture makes an edit for one suite
// silently change what another one asserts. The offline `template` provider is
// used throughout, so the suite never leaves the process (QA-19).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import { EXIT_CODES, main } from "../build/index.js";

// ── fixtures: the instance ──────────────────────────────────────────────────

const SOURCE_HOST = "dev-generate-source.service-now.com";

/** A 32-character lowercase-hex sys_id that stays readable in a diff. */
const hex = (prefix) => prefix.padEnd(32, "0");

const SCOPE_NAME = "x_tessera_demo";
const SCOPE_ID = hex("5c09e");

const AMOUNT_ID = hex("aaa1");
const TOTALS_ID = hex("bbb2");
const RULE_ID = hex("ccc3");
const ACTION_ID = hex("ddd4");
const DYNAMIC_ID = hex("eee5");

/**
 * A string that exists only inside a script body. TM-1 says a body is
 * attacker-authored text; the assertion that matters is not "the report reads
 * well" but "this exact sequence of characters left the process nowhere".
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
  `// ${CANARY}: this line must never reach the report or a written spec`,
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

function seed({ dynamic = false, empty = false } = {}) {
  const include = (sysId, name, script) => ({
    sys_id: sysId,
    name,
    sys_name: name,
    sys_scope: SCOPE_ID,
    script,
  });

  // A scope that EXISTS and holds nothing. Not the same instance as a scope
  // that is absent, and not the same report either (OPP-1b).
  if (empty) {
    return {
      sys_scope: [
        { sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Tessera Demo" },
      ],
      sys_script_include: [],
      sys_script: [],
      sys_ui_action: [],
      sysauto_script: [],
    };
  }

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

const target = (table, sysId, name) => ({ table, sysId, name });

/**
 * A live manifest with one entry. It exists so the DEV-4 assertion has something
 * to be about: a tests root with no live manifest would let a command that
 * happily overwrites `.manifest.json` pass, because there would be nothing there
 * to destroy.
 */
const LIVE = {
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

const LIVE_MANIFEST = ".manifest.json";
const PROPOSED_MANIFEST = ".manifest.proposed.json";
const PROPOSED_DIR = "proposed";

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-generate-"));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Every exit code this file ever observed — see the `1` assertion at the end. */
const SEEN = new Set();

async function writeTestsRoot(root, { dir = "tests", manifest, files = [] }) {
  const testsRoot = path.join(root, dir);
  await fs.mkdir(testsRoot, { recursive: true });
  for (const file of files) {
    const full = path.join(testsRoot, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, "// a spec body nothing in this command opens\n");
  }
  if (manifest !== undefined) {
    await fs.writeFile(
      path.join(testsRoot, LIVE_MANIFEST),
      typeof manifest === "string"
        ? manifest
        : `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  return testsRoot;
}

/**
 * Stand the source instance up behind a host-dispatching `fetch`, stage the one
 * credential profile it answers to, lay a tests root down, and hand back an
 * injectable context.
 *
 * No `default` profile is configured, on purpose: if the profile binding ever
 * stopped working, every read has to fail rather than be served from whatever
 * instance happens to be ambient (ARCH-19). The host dispatcher is the second
 * half of the same guarantee — a request to `api.anthropic.com` is REJECTED
 * here, so a test that reaches a vendor fails loudly instead of billing anyone.
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
    SEEN.add(code);
    return { code, h };
  } finally {
    h.restore();
  }
}

/** Every HTTP method the fake served — generation may only ever produce GET. */
function methods(fake) {
  return [...new Set(fake.requests().map((entry) => entry.method))].sort();
}

/** A GET fault on one table, expressed the way the fault registry wants it. */
function faultOn(table, mode) {
  return { match: { method: "GET", table }, mode };
}

const SOURCE = ["--source", "source"];
const SCOPE = ["--scope", SCOPE_NAME];
const UNIT = ["--kind", "unit"];
const ARGV = [...SOURCE, ...SCOPE, ...UNIT];

/**
 * The human report is printed under the config-precedence block, which is
 * printed before any read. Cases that care about "what the run said" want the
 * part after that block.
 */
function reportOf(h) {
  return h.out.slice(2).join("\n");
}

async function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

/** Every regular file under a directory, as tests-root-relative POSIX paths. */
async function tree(dir, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await tree(path.join(dir, entry.name), rel)));
    } else {
      found.push(rel);
    }
  }
  return found.sort();
}

// ── help ────────────────────────────────────────────────────────────────────

describe("tess generate — help", () => {
  it("prints one document, exits 0, and states that 1 is never returned", async () => {
    const { code, h } = await run(["generate", "--help"]);

    assert.equal(code, EXIT_CODES.ok);
    // One write: help piped into a pager must not arrive in fragments.
    assert.equal(h.out.length, 1);
    assert.match(h.stdout(), /^tess generate — propose specs/);
    assert.match(h.stdout(), /^ {2}1 is never returned/m);
    // The sentence the command exists to keep true.
    assert.match(h.stdout(), /proposed\//);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("asks for help even when the rest of the argv would have run", async () => {
    const { code, h } = await run(["generate", ...ARGV, "--help"], {
      specs: LIVE,
    });

    assert.equal(code, EXIT_CODES.ok);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("is listed as a command by the top-level help", async () => {
    const { code, h } = await run(["--help"]);

    assert.equal(code, EXIT_CODES.ok);
    assert.match(h.stdout(), /^ {2}generate\b/m);
  });
});

// ── refusals: an operator's mistake costs no round trip ─────────────────────

describe("tess generate — refuses before it reads anything", () => {
  const cases = [
    {
      name: "no source instance",
      argv: ["generate", ...SCOPE, ...UNIT],
      match: /no source instance/,
    },
    {
      name: "no scope",
      argv: ["generate", ...SOURCE, ...UNIT],
      match: /no scope/,
    },
    {
      name: "a kind that does not exist",
      argv: ["generate", ...SOURCE, ...SCOPE, "--kind", "integration"],
      // The config layer's enum check gets there first, so the command's own
      // fallback message never fires. Both spell the same closed set.
      match: /--kind expects one of unit, e2e, ui/,
    },
    {
      name: "a provider that does not exist",
      argv: ["generate", ...ARGV, "--provider", "openai"],
      match: /template, anthropic/,
    },
    {
      name: "a flag nothing declares",
      argv: ["generate", ...ARGV, "--wat"],
      match: /--wat/,
    },
  ];

  for (const testCase of cases) {
    it(`exits 2 on ${testCase.name}, with no HTTP`, async () => {
      const { code, h } = await run(testCase.argv, { specs: LIVE });

      assert.equal(code, EXIT_CODES.usage);
      assert.match(h.stderr(), testCase.match);
      // The assertion that carries the section: the message would read the same
      // if the refusal had arrived after a full where-used search.
      assert.deepEqual(h.fake.requests(), []);
    });
  }

  it("refuses --api-key on the command line, naming the reason (TM-1)", async () => {
    const { code, h } = await run(
      ["generate", ...ARGV, "--provider", "anthropic", "--api-key", "sk-x"],
      { specs: LIVE },
    );

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /--api-key/);
    assert.match(h.stderr(), /environment/);
    // argv is world-readable; the refusal exists because the flag would put the
    // key in `ps(1)` and in a shell history file.
    assert.match(h.stderr(), /ps\(1\)/);
    assert.ok(!h.stdout().includes("sk-x"));
    assert.ok(!h.stderr().includes("sk-x"));
    assert.deepEqual(h.fake.requests(), []);
  });

  it("refuses --provider anthropic with no key in the environment", async () => {
    const { code, h } = await run(
      ["generate", ...ARGV, "--provider", "anthropic"],
      { specs: LIVE },
    );

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /TESSERA_ANTHROPIC_API_KEY/);
    assert.match(h.stderr(), /ANTHROPIC_API_KEY/);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("takes the key from the environment and never prints it", async () => {
    // This run gets PAST the usage gate, so it reaches the provider — and the
    // host dispatcher rejects `api.anthropic.com`, which is the point: the
    // vendor is never called from a test. What is asserted here is the code
    // (a DEV-1 fault, not a finding) and the silence about the key.
    const { code, h } = await run(
      ["generate", ...ARGV, "--provider", "anthropic"],
      {
        specs: LIVE,
        env: { TESSERA_ANTHROPIC_API_KEY: "sk-ant-secret-value" },
      },
    );

    assert.equal(code, EXIT_CODES.fault);
    assert.ok(!h.stdout().includes("sk-ant-secret-value"));
    assert.ok(!h.stderr().includes("sk-ant-secret-value"));
    // The config-precedence block prints the key's ORIGIN, redacted.
    assert.match(h.stdout(), /apiKey/);
    assert.match(h.stdout(), /<redacted>/);
  });

  it("refuses a scope that is not on the instance, as the operator's mistake", async () => {
    const { code, h } = await run(
      ["generate", ...SOURCE, "--scope", "x_not_a_scope", ...UNIT],
      { specs: LIVE },
    );

    // Exit 2 and not 3: the resolver looked, and the answer was "no such
    // scope" — a fact about the argument, not an absence of evidence (DEV-1).
    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /no application scope named `x_not_a_scope`/);
  });

  it("refuses an empty scope rather than writing an empty proposal (OPP-1b)", async () => {
    const { code, h } = await run(["generate", ...ARGV], {
      specs: LIVE,
      state: { empty: true },
    });

    // "your scope has no artifacts" and "the generator produced nothing" are
    // the same silence and opposite facts. The first is exit 2 with a pointer
    // at the command that shows the analysis; it is never a green empty batch.
    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /nothing to generate/);
    assert.match(h.stderr(), /tess coverage --scope x_tessera_demo/);
    await assert.rejects(
      fs.access(path.join(h.testsRoot, PROPOSED_MANIFEST)),
      /ENOENT/,
    );
  });
});

// ── the write: everything lands under proposed/ (DEV-4) ────────────────────

describe("tess generate — nothing it writes is armed (DEV-4)", () => {
  it("writes one spec per impacted artifact, and only under proposed/", async () => {
    const h = await harness({ specs: LIVE });
    let code;
    const before = await sha256(path.join(h.testsRoot, LIVE_MANIFEST));
    try {
      code = await main(["generate", ...ARGV], h.context);
      SEEN.add(code);

      assert.equal(code, EXIT_CODES.ok);

      const files = await tree(h.testsRoot);
      // The live manifest, the spec the fixture registered, the proposed
      // manifest, and the proposed tree. Nothing else — in particular nothing
      // written at the tests root that the command did not name.
      const outside = files.filter(
        (file) =>
          !file.startsWith(`${PROPOSED_DIR}/`) &&
          file !== PROPOSED_MANIFEST &&
          file !== LIVE_MANIFEST &&
          file !== AMOUNT_SPEC_PATH,
      );
      assert.deepEqual(outside, []);

      const proposed = files.filter((file) =>
        file.startsWith(`${PROPOSED_DIR}/`),
      );
      assert.equal(proposed.length, 4);
      for (const file of proposed) assert.match(file, /\.unit\.ts$/);

      // The live manifest is byte-identical. A command that "did not mention"
      // rewriting it would pass a message assertion; it cannot pass this one.
      assert.equal(await sha256(path.join(h.testsRoot, LIVE_MANIFEST)), before);

      // Reads only. The whole command is a read of an instance and a write to
      // a disk; a POST here would mean something reached the instance.
      assert.deepEqual(methods(h.fake), ["GET"]);
    } finally {
      h.restore();
    }
  });

  it("puts the proposed manifest beside the live one, marked inert", async () => {
    const h = await harness({ specs: LIVE });
    try {
      const code = await main(["generate", ...ARGV], h.context);
      SEEN.add(code);
      assert.equal(code, EXIT_CODES.ok);

      const manifestPath = path.join(h.testsRoot, PROPOSED_MANIFEST);
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

      assert.equal(manifest.proposed, true);
      // The note is the file's own explanation of why reading it changes
      // nothing: an entry here is inert until a human moves it across.
      assert.match(manifest.note, /inert until a human/i);
      assert.match(manifest.note, /never writes the live manifest/i);
      assert.equal(manifest.specs.length, 4);
      // Sorted by id, so a regenerated batch diffs against the previous one
      // rather than against whatever order the model answered in.
      assert.deepEqual(
        manifest.specs.map((spec) => spec.id),
        [...manifest.specs.map((spec) => spec.id)].sort(),
      );
      // Every entry points inside proposed/ and at a file that exists.
      for (const spec of manifest.specs) {
        assert.match(spec.path, /^proposed\//);
        await fs.access(path.join(h.testsRoot, spec.path));
        // QA-16: the spec↔artifact link is DECLARED, and the declaration is
        // what a reviewer reads before promoting anything.
        assert.ok(spec.targets.length > 0);
      }

      // The command reports the same two paths it actually used. This is the
      // regression the CLI shipped with once: the manifest is at the TESTS
      // ROOT, not inside proposed/ with the files it indexes.
      assert.match(reportOf(h), /manifest: {2}.*\.manifest\.proposed\.json/);
      const reported = reportOf(h)
        .split("\n")
        .find((line) => line.startsWith("manifest:"));
      assert.equal(reported.replace(/^manifest: +/, ""), manifestPath);
    } finally {
      h.restore();
    }
  });

  it("regenerating replaces the previous proposal and still leaves the live tree alone", async () => {
    const h = await harness({ specs: LIVE });
    try {
      const before = await sha256(path.join(h.testsRoot, LIVE_MANIFEST));
      assert.equal(await main(["generate", ...ARGV], h.context), EXIT_CODES.ok);
      const first = await tree(h.testsRoot);

      h.out.length = 0;
      h.err.length = 0;
      assert.equal(await main(["generate", ...ARGV], h.context), EXIT_CODES.ok);

      // Deterministic filenames, so a second run is an overwrite and not a
      // second copy of a review queue.
      assert.deepEqual(await tree(h.testsRoot), first);
      assert.equal(await sha256(path.join(h.testsRoot, LIVE_MANIFEST)), before);
    } finally {
      h.restore();
    }
  });

  it("refuses a tests root that is not there rather than inventing one", async () => {
    // CURRENT BEHAVIOUR, pinned rather than endorsed: unlike `tess coverage`,
    // which checks the disk BEFORE the instance, this command validates the
    // tests root inside the writer — so the refusal arrives after a full
    // analysis has already been paid for. The exit code is right (2, the
    // operator's to fix) and the message names the path; the ordering is a
    // known wart, and this assertion is where a fix would announce itself.
    const { code, h } = await run(
      ["generate", ...ARGV, "--tests-root", "no-such-dir"],
      { specs: LIVE },
    );

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /no-such-dir/);
    assert.ok(h.fake.requests().length > 0);
  });
});

// ── TM-1: no untrusted byte escapes ────────────────────────────────────────

describe("tess generate — the canary reaches nothing (TM-1)", () => {
  it("keeps a script body out of stdout, stderr and every written file", async () => {
    const h = await harness({ specs: LIVE });
    try {
      const code = await main(["generate", ...ARGV], h.context);
      SEEN.add(code);
      assert.equal(code, EXIT_CODES.ok);

      // The body is genuinely on the instance — otherwise this test passes by
      // asserting nothing.
      assert.ok(
        h.fake
          .requests()
          .some((entry) => entry.path.includes("sys_script_include")),
      );

      assert.ok(!h.stdout().includes(CANARY));
      assert.ok(!h.stderr().includes(CANARY));

      for (const file of await tree(h.testsRoot)) {
        const text = await fs.readFile(path.join(h.testsRoot, file), "utf8");
        assert.ok(
          !text.includes(CANARY),
          `${file} carries a byte the model was shown`,
        );
      }
    } finally {
      h.restore();
    }
  });

  it("keeps it out of the --json document too", async () => {
    const { code, h } = await run(["generate", ...ARGV, "--json"], {
      specs: LIVE,
    });

    assert.equal(code, EXIT_CODES.ok);
    assert.ok(!h.stdout().includes(CANARY));
  });
});

// ── the report ─────────────────────────────────────────────────────────────

describe("tess generate — what the report says", () => {
  it("prints one JSON document naming the provider, the model and no key", async () => {
    const { code, h } = await run(["generate", ...ARGV, "--json"], {
      specs: LIVE,
    });

    assert.equal(code, EXIT_CODES.ok);
    // One write: a consumer piping stdout into a parser must not reassemble it.
    assert.equal(h.out.length, 1);

    const doc = h.json();
    assert.equal(doc.kind, "unit");
    assert.equal(doc.provider.name, "template");
    assert.ok(doc.provider.modelId.length > 0);
    // A proposal nobody can attribute to a model is a proposal nobody can
    // reproduce — and the key has no field to be leaked through.
    assert.ok(!("apiKey" in doc.provider));
    assert.ok(!JSON.stringify(doc).includes("sk-"));

    assert.equal(doc.specs.length, 4);
    assert.equal(doc.counts.proposed, 4);
    assert.equal(doc.counts.impacted, 4);
    assert.equal(doc.incomplete, false);
    assert.equal(doc.testsRoot, path.join(h.root, "tests"));
    assert.equal(doc.proposedDir, path.join(h.root, "tests", PROPOSED_DIR));
    assert.equal(
      doc.manifestPath,
      path.join(h.root, "tests", PROPOSED_MANIFEST),
    );
    // The path the command did NOT write, named as a concrete string. The
    // writer returns it for exactly this reason: "the live manifest is
    // untouched" is a claim about a specific file, and a document that never
    // names that file leaves the reader to assume which one was meant. The
    // hash-based proof lives in the DEV-4 section above; this is the same
    // negative, made checkable by a machine.
    assert.equal(
      doc.liveManifestPath,
      path.join(h.root, "tests", LIVE_MANIFEST),
    );
    for (const spec of doc.specs) {
      assert.match(spec.path, /^proposed\//);
      assert.equal(spec.kind, "unit");
    }
  });

  it("says where the source went, computed from the provider that was built", async () => {
    // Not a constant. The two branches of the provider switch are exactly the
    // two answers — the offline `template` provider reads the instance and
    // nothing leaves the process (QA-19), the `anthropic` one posts artifact
    // source to a third party — and the caller of a tool whose whole input is
    // somebody's production source code cannot learn which one ran from
    // `provider.name` unless they already know what the names mean.
    const { code, h } = await run(["generate", ...ARGV, "--json"], {
      specs: LIVE,
    });

    assert.equal(code, EXIT_CODES.ok);
    assert.equal(h.json().egress, "none");
  });

  it("states the DEV-4 envelope in the document, not only in the prose", async () => {
    // The defect class this pins: a documented safety property that survives in
    // the human branch and evaporates at the `--json` boundary. The human tail
    // says "NOTHING HAS BEEN RUN and nothing has been promoted"; a machine
    // consumer never sees that sentence, and `specs: [...]` beside a
    // `manifestPath` reads exactly like a registered, passing suite.
    //
    // Asserted as two `=== false`, not as truthiness or presence: a missing
    // field and a false one must not pass the same test, or a regression that
    // dropped them both would go green.
    const { code, h } = await run(["generate", ...ARGV, "--json"], {
      specs: LIVE,
    });

    assert.equal(code, EXIT_CODES.ok);
    const doc = h.json();

    assert.equal(doc.executed, false);
    assert.equal(doc.promoted, false);
  });

  it("states whether it destroyed a previous proposal, per spec and overall", async () => {
    // The fact that EARNS the tool's `destructiveHint`. Deterministic filenames
    // make a second run an overwrite rather than a second copy of the review
    // queue (asserted as a file tree in the DEV-4 section); the writer has
    // always recorded which entries it clobbered, and nothing in production
    // read the field, so the one document that exists to describe the write
    // said nothing about the review a reader may have just lost.
    //
    // Two runs against the same tests root, so both values come from the same
    // fixture: a field pinned only at `true` cannot be told apart from a
    // constant, and one pinned only at `false` cannot be told apart from a
    // missing feature.
    const h = await harness({ specs: LIVE });
    try {
      const first = await main(["generate", ...ARGV, "--json"], h.context);
      SEEN.add(first);
      assert.equal(first, EXIT_CODES.ok);
      const fresh = h.json();
      assert.equal(fresh.overwroteExisting, false);
      assert.equal(fresh.specs.length, 4);
      for (const spec of fresh.specs) assert.equal(spec.overwritten, false);

      h.out.length = 0;
      h.err.length = 0;
      const second = await main(["generate", ...ARGV, "--json"], h.context);
      SEEN.add(second);
      assert.equal(second, EXIT_CODES.ok);
      const again = h.json();
      assert.equal(again.overwroteExisting, true);
      for (const spec of again.specs) assert.equal(spec.overwritten, true);
    } finally {
      h.restore();
    }
  });

  it("names every proposed spec and what it claims to cover", async () => {
    const { code, h } = await run(["generate", ...ARGV], { specs: LIVE });

    assert.equal(code, EXIT_CODES.ok);
    const report = reportOf(h);
    assert.match(report, /^proposed \(4\):/m);
    assert.match(report, /AmountCalculator/);
    assert.match(report, /written to .*proposed$/m);
    // Nothing has been run and nothing has been promoted — the sentence a
    // reader has to see before they trust the list above it.
    assert.match(report, /promoted/i);
  });

  it("resolves a relative --tests-root against the injected cwd", async () => {
    const { code, h } = await run(
      ["generate", ...ARGV, "--tests-root", "tests"],
      { specs: LIVE },
    );

    assert.equal(code, EXIT_CODES.ok);
    await fs.access(path.join(h.root, "tests", PROPOSED_MANIFEST));
  });
});

// ── incomplete and faulted ─────────────────────────────────────────────────

describe("tess generate — an unfinished analysis is not a clean one", () => {
  it("exits 5, and still writes, when an artifact could not be traced (QA-9)", async () => {
    const h = await harness({ specs: LIVE, state: { dynamic: true } });
    try {
      const code = await main(["generate", ...ARGV], h.context);
      SEEN.add(code);

      assert.equal(code, EXIT_CODES.inconclusive);
      // The specs are real. What is not established is that they are the WHOLE
      // work list — so the exit code carries the doubt and the files still land.
      const proposed = (await tree(h.testsRoot)).filter((file) =>
        file.startsWith(`${PROPOSED_DIR}/`),
      );
      assert.ok(proposed.length > 0);
      assert.match(reportOf(h), /INCOMPLETE/);
    } finally {
      h.restore();
    }
  });

  it("keeps the flag and the exit code agreeing in --json mode", async () => {
    const { code, h } = await run(["generate", ...ARGV, "--json"], {
      specs: LIVE,
      state: { dynamic: true },
    });

    assert.equal(code, EXIT_CODES.inconclusive);
    assert.equal(h.json().incomplete, true);
  });

  it("exits 3, not 1, when the scope read itself fails (DEV-1)", async () => {
    const { code, h } = await run(["generate", ...ARGV], {
      specs: LIVE,
      faults: [faultOn("sys_scope", { kind: "http-error", status: 500 })],
    });

    assert.equal(code, EXIT_CODES.fault);
    assert.match(h.stderr(), /INFRASTRUCTURE FAULT \(DEV-1\)/);
    assert.match(h.stderr(), /this is not a NO_GO/);
  });

  it("writes nothing at all when the analysis faults", async () => {
    const h = await harness({
      specs: LIVE,
      faults: [faultOn("sys_scope", { kind: "http-error", status: 500 })],
    });
    try {
      const before = await tree(h.testsRoot);
      const code = await main(["generate", ...ARGV], h.context);
      SEEN.add(code);

      assert.equal(code, EXIT_CODES.fault);
      // A partial proposal is worse than none: a reviewer would read it as the
      // work list for a scope the run never finished looking at (OPP-1b).
      assert.deepEqual(await tree(h.testsRoot), before);
    } finally {
      h.restore();
    }
  });
});

// ── the code that is never returned ────────────────────────────────────────

describe("tess generate — 1 is never returned", () => {
  it("produced 0, 2, 3 and 5 above, and never 1", () => {
    // Sanity first: an empty `SEEN` would make the real assertion vacuous.
    assert.ok(SEEN.size >= 4, `SEEN was ${[...SEEN].join(", ")}`);
    assert.ok(
      !SEEN.has(EXIT_CODES.noGo),
      "a proposed spec has not been run, so it cannot fail a build (QA-8)",
    );
  });
});
