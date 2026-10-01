// Review W7b, M1 — an artifact whose NAME carries a bidi override or a
// terminal escape, run through `tess generate`.
//
// A target's name is free text: the instance owner chose it, the analyzer read
// it, the model repeated it. Before this review it went to stdout raw, so a
// Script Include called "Amount<U+202E>rotaluclaC" printed as a line that reads
// differently from the bytes, and an ESC sequence in a name could drive the
// reviewer's terminal. Now the short fields are refused where model output is
// parsed (`parseCandidates`), and every such field is escaped at print time.
//
// The assertion is the fail-closed one: the run does not succeed, nothing is
// written under `proposed/`, and the raw character appears in neither stdout nor
// stderr.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import { EXIT_CODES, main } from "../build/index.js";

const SOURCE_HOST = "dev-generate-unsafe.service-now.com";
const hex = (prefix) => prefix.padEnd(32, "0");
const SCOPE_NAME = "x_tessera_unsafe";
const SCOPE_ID = hex("5c0fe");

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

const tempRoots = [];
after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function seed(name) {
  const script = [
    `var ${"Calc"} = Class.create();`,
    "Calc.prototype = {",
    "  total: function (items) {",
    "    return items.length;",
    "  },",
    "};",
  ].join("\n");
  return {
    sys_scope: [{ sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Unsafe" }],
    sys_script_include: [
      {
        sys_id: hex("aaa1"),
        name,
        sys_name: name,
        sys_scope: SCOPE_ID,
        script,
      },
    ],
    sys_script: [],
    sys_ui_action: [],
    sysauto_script: [],
  };
}

async function runGenerate(name) {
  const fake = createFakeInstance({ host: SOURCE_HOST, state: seed(name) });
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

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-unsafe-"));
  tempRoots.push(root);
  const testsRoot = path.join(root, "tests");
  await fs.mkdir(testsRoot, { recursive: true });
  await fs.writeFile(
    path.join(testsRoot, ".manifest.json"),
    `${JSON.stringify({ version: 1, specs: [] }, null, 2)}\n`,
  );

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
  try {
    const code = await main(
      [
        "generate",
        "--source",
        "source",
        "--scope",
        SCOPE_NAME,
        "--kind",
        "unit",
        "--tests-root",
        testsRoot,
      ],
      {
        now: () => new Date("2026-02-02T03:04:05.000Z"),
        actor: "test",
        cwd: root,
        env: {},
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
    );
    return { code, out: out.join("\n"), err: err.join("\n"), testsRoot };
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadCredentialsFromEnv();
  }
}

async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

const CASES = {
  "a bidi override (U+202E)": "Amount‮rotaluclac",
  "an ANSI escape (ESC [2J)": "Amount\u001b[2JCalc",
  "a zero-width space": "Amount​Calc",
};

describe("tess generate — an unsafe character in an artifact name (W7b M1)", () => {
  it("control run: a plain name succeeds, so the refusals below are about the character", async () => {
    const result = await runGenerate("AmountCalc");
    assert.equal(result.code, EXIT_CODES.ok, result.err);
    assert.match(result.out, /AmountCalc/);
  });

  for (const [label, name] of Object.entries(CASES)) {
    it(`fails closed on ${label}, and the raw character reaches neither stream`, async () => {
      const raw = [...name].find(
        (ch) => ch.codePointAt(0) < 0x20 || ch.codePointAt(0) >= 0x200b,
      );
      assert.ok(raw !== undefined);
      const result = await runGenerate(name);

      assert.notEqual(result.code, EXIT_CODES.ok, result.out);
      assert.notEqual(result.code, 1, "generate never returns 1");
      assert.ok(!result.out.includes(raw), "the raw character reached stdout");
      assert.ok(!result.err.includes(raw), "the raw character reached stderr");
      assert.equal(
        await exists(path.join(result.testsRoot, "proposed")),
        false,
        "a proposed/ tree was written for a refused batch",
      );
      assert.equal(
        await exists(path.join(result.testsRoot, ".manifest.proposed.json")),
        false,
      );
    });
  }
});
