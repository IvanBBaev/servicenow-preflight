// The resolver's refusals that `config.test.js` does not reach.
//
// That suite pins the promises against the real Phase-1 option table, which
// has no plain (non-integer) number, no boolean in a config file and no list
// with choices. Those shapes are still part of the contract — a later phase
// adds an option as a new row of data, not new code — so they are exercised
// here through small purpose-built tables: the table's own wiring checks, and
// every typed refusal on the text (flag/env) and JSON (file) paths.
//
// Same rule as the main suite: no temporary directories, the config file is a
// string behind the file-reader port.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ConfigError,
  ConfigSecretError,
  resolveConfig,
} from "../build/index.js";

const CONFIG_PATH = "/work/tessera.config.json";

function resolve({ file, ...input } = {}) {
  return resolveConfig({
    argv: [],
    env: {},
    cwd: "/work",
    readTextFile: (filePath) =>
      file !== undefined && filePath === CONFIG_PATH
        ? JSON.stringify(file)
        : undefined,
    options: TABLE,
    ...input,
  });
}

function refuses(fn, pattern, Kind = ConfigError) {
  assert.throws(fn, (error) => {
    assert.ok(
      error instanceof Kind,
      `expected ${Kind.name}, got ${error?.constructor?.name}: ${error?.message}`,
    );
    assert.match(error.message, pattern);
    return true;
  });
}

/** One row per value type the Phase-1 table leaves unexercised. */
const TABLE = [
  {
    key: "json",
    flag: "--json",
    env: "T_JSON",
    type: "boolean",
    describe: "a boolean",
  },
  {
    key: "ratio",
    flag: "--ratio",
    env: "T_RATIO",
    type: "number",
    min: 0,
    max: 10,
    describe: "a plain number",
  },
  {
    key: "count",
    flag: "--count",
    env: "T_COUNT",
    type: "number",
    integer: true,
    min: 1,
    describe: "an integer",
  },
  {
    key: "kinds",
    flag: "--kind",
    env: "T_KINDS",
    type: "list",
    repeatable: true,
    choices: ["unit", "e2e"],
    describe: "a closed list",
  },
  {
    key: "label",
    flag: "--label",
    env: "T_LABEL",
    type: "string",
    describe: "a free string",
  },
  {
    key: "region",
    flag: "--region",
    env: "T_REGION",
    type: "string",
    sources: ["env", "file"],
    describe: "kept off the command line, not a secret",
  },
];

// ── the option table itself ─────────────────────────────────────────────────

describe("a broken option table is refused before any input is read", () => {
  const row = (overrides) => ({
    key: "a",
    flag: "--a",
    type: "string",
    describe: "row",
    ...overrides,
  });
  const broken = [
    [
      "a key declared twice",
      [row({}), row({ flag: "--b" })],
      /declares "a" twice/,
    ],
    [
      "a flag declared twice",
      [row({}), row({ key: "b" })],
      /declares --a twice/,
    ],
    [
      "an env name declared twice, across env and legacyEnv",
      [row({ env: "T_A" }), row({ key: "b", flag: "--b", legacyEnv: "T_A" })],
      /declares T_A twice/,
    ],
    [
      "a repeatable option that is not a list",
      [row({ repeatable: true })],
      /"a" is repeatable but not of type list/,
    ],
    [
      "a min on a non-number",
      [row({ min: 0 })],
      /"a" declares a numeric bound but is not of type number/,
    ],
    [
      "a max on a non-number",
      [row({ type: "list", max: 3 })],
      /declares a numeric bound but is not of type number/,
    ],
    [
      "an integer marker on a non-number",
      [row({ type: "boolean", integer: true })],
      /declares a numeric bound but is not of type number/,
    ],
    [
      "a min above the max",
      [row({ type: "number", min: 5, max: 4 })],
      /"a" declares min 5 > max 4/,
    ],
  ];

  for (const [label, options, pattern] of broken) {
    it(`refuses ${label}`, () => {
      let read = 0;
      refuses(
        () =>
          resolve({
            options,
            argv: ["--a", "x"],
            readTextFile: () => {
              read += 1;
              return undefined;
            },
          }),
        pattern,
      );
      assert.equal(
        read,
        0,
        "the table is checked before the file is looked for",
      );
    });
  }

  it("accepts equal bounds and an env name reused by nothing", () => {
    const resolved = resolve({
      options: [row({ type: "number", min: 3, max: 3, env: "T_A" })],
      env: { T_A: "3" },
    });
    assert.deepEqual(resolved.values, { a: 3 });
  });
});

// ── the command-line layer ──────────────────────────────────────────────────

describe("an option kept off the command line", () => {
  it("is refused as a layer violation, not as a credential", () => {
    assert.throws(
      () => resolve({ argv: ["--region", "eu"] }),
      (error) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error instanceof ConfigSecretError, false);
        assert.match(
          error.message,
          /--region may not be given on the command line — allowed layers: env, file/,
        );
        return true;
      },
    );
  });

  it("still arrives through the layers it allows", () => {
    assert.equal(resolve({ env: { T_REGION: "eu" } }).values.region, "eu");
    assert.equal(resolve({ file: { region: "us" } }).values.region, "us");
  });
});

// ── text values (flag and env) ──────────────────────────────────────────────

describe("a boolean from text", () => {
  it("refuses a word outside the closed set, with the same message on both layers", () => {
    const valid = /valid: true, 1, yes, on, false, 0, no, off/;
    refuses(
      () => resolve({ argv: ["--json=maybe"] }),
      /--json expects a boolean — got "maybe"/,
    );
    refuses(() => resolve({ argv: ["--json=maybe"] }), valid);
    refuses(
      () => resolve({ env: { T_JSON: "maybe" } }),
      /T_JSON expects a boolean — got "maybe"/,
    );
    refuses(() => resolve({ env: { T_JSON: "maybe" } }), valid);
  });

  it("reads the closed set case- and space-insensitively", () => {
    for (const [text, value] of [
      [" YES ", true],
      ["On", true],
      ["1", true],
      ["Off", false],
      ["no", false],
      ["0", false],
    ]) {
      assert.equal(resolve({ env: { T_JSON: text } }).values.json, value, text);
    }
  });
});

describe("a plain number from text", () => {
  for (const text of ["abc", "Infinity", "-Infinity", "NaN", "1e999"]) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      refuses(
        () => resolve({ env: { T_RATIO: text } }),
        new RegExp(`^T_RATIO expects a number — got "${text}"$`),
      );
    });
  }

  it("refuses an empty inline flag before typing it", () => {
    refuses(
      () => resolve({ argv: ["--ratio="] }),
      /--ratio expects a non-empty value/,
    );
  });

  it("accepts a decimal, an exponent and the inclusive bounds", () => {
    assert.equal(resolve({ argv: ["--ratio", "2.5"] }).values.ratio, 2.5);
    assert.equal(resolve({ argv: ["--ratio", "1e1"] }).values.ratio, 10);
    assert.equal(resolve({ argv: ["--ratio", " 0 "] }).values.ratio, 0);
  });

  it("refuses a value outside the bounds, naming the bound", () => {
    refuses(
      () => resolve({ argv: ["--ratio=-0.5"] }),
      /--ratio expects a number >= 0 — got -0.5/,
    );
    refuses(
      () => resolve({ argv: ["--ratio", "10.01"] }),
      /--ratio expects a number <= 10 — got 10.01/,
    );
  });
});

// ── JSON values (the config file) ───────────────────────────────────────────

describe("a config-file value is typed by JSON, not coerced", () => {
  const origin = (key) => `"${key}" in ${CONFIG_PATH}`;
  const refusals = [
    [
      "a string for a boolean",
      { json: "true" },
      `${origin("json")} expects a JSON boolean — got a string`,
    ],
    [
      "a number for a boolean",
      { json: 1 },
      `${origin("json")} expects a JSON boolean`,
    ],
    [
      "a string for a number",
      { ratio: "3" },
      `${origin("ratio")} expects a JSON number — got a string`,
    ],
    [
      "null for a number",
      { ratio: null },
      `${origin("ratio")} expects a JSON number`,
    ],
    [
      "a string for a list",
      { kinds: "unit" },
      `${origin("kinds")} expects an array of strings — got a string`,
    ],
    [
      "an object for a list",
      { kinds: { 0: "unit" } },
      `${origin("kinds")} expects an array of strings`,
    ],
    [
      "a non-string list item",
      { kinds: ["unit", 2] },
      `${origin("kinds")} expects an array of strings — one item is a number`,
    ],
    [
      "an empty list",
      { kinds: [] },
      `${origin("kinds")} expects at least one value`,
    ],
    [
      "a list item outside the choices",
      { kinds: ["unit", "perf"] },
      `${origin("kinds")} expects one of unit, e2e — got "perf"`,
    ],
    [
      "a blank list item",
      { kinds: [" "] },
      `${origin("kinds")} expects a non-empty value`,
    ],
    [
      "a number for a string",
      { label: 7 },
      `${origin("label")} expects a JSON string — got a number`,
    ],
    [
      "a blank string",
      { label: "  " },
      `${origin("label")} expects a non-empty value`,
    ],
    [
      "a fraction for an integer",
      { count: 1.5 },
      `${origin("count")} expects a whole number — got 1.5`,
    ],
    [
      "an unsafe integer",
      { count: 2 ** 53 },
      `${origin("count")} expects a whole number — got ${2 ** 53}`,
    ],
    [
      "an integer below its min",
      { count: 0 },
      `${origin("count")} expects a number >= 1 — got 0`,
    ],
    [
      "a number above its max",
      { ratio: 11 },
      `${origin("ratio")} expects a number <= 10 — got 11`,
    ],
  ];

  for (const [label, file, expected] of refusals) {
    it(`refuses ${label}`, () => {
      assert.throws(
        () => resolve({ file }),
        (error) => {
          assert.ok(error instanceof ConfigError, String(error));
          assert.ok(
            error.message.startsWith(expected),
            `${error.message}\n  does not start with\n${expected}`,
          );
          return true;
        },
      );
    });
  }

  it("refuses an invalid file value even when a flag would have won (rule 3)", () => {
    refuses(
      () => resolve({ argv: ["--json"], file: { json: "yes" } }),
      /expects a JSON boolean/,
    );
  });

  it("accepts each type in its JSON form, de-duplicating a list in first-seen order", () => {
    const resolved = resolve({
      file: {
        json: false,
        ratio: 0.25,
        count: 3,
        kinds: ["e2e", "unit", "e2e"],
        label: " x ",
      },
    });
    assert.deepEqual(resolved.values, {
      json: false,
      ratio: 0.25,
      count: 3,
      kinds: ["e2e", "unit"],
      label: "x",
    });
    assert.ok(
      Object.values(resolved.provenance).every((source) => source === "file"),
    );
  });
});

// ── the edges around them ───────────────────────────────────────────────────

describe("the edges around the typed paths", () => {
  it("names a non-Error thrown by the reader port in the refusal", () => {
    refuses(
      () =>
        resolve({
          readTextFile: () => {
            throw "disk on fire";
          },
        }),
      /config file \/work\/tessera\.config\.json could not be read: disk on fire/,
    );
  });

  it("fans --instance out only onto the roles the table declares", () => {
    const options = [
      {
        key: "instance",
        flag: "--instance",
        type: "string",
        describe: "alias",
      },
      {
        key: "runner",
        flag: "--runner",
        type: "string",
        describe: "runner role",
      },
    ];
    const resolved = resolve({ options, argv: ["--instance", "acme"] });
    assert.deepEqual(resolved.values, { instance: "acme", runner: "acme" });
    assert.deepEqual(resolved.aliasedFrom, { runner: "instance" });
  });

  it("reads process.env and the working directory when they are not injected", () => {
    const name = "T_LABEL";
    const before = process.env[name];
    process.env[name] = "from-process-env";
    try {
      const resolved = resolveConfig({
        options: TABLE,
        argv: [],
        readTextFile: () => undefined,
      });
      assert.equal(resolved.values.label, "from-process-env");
      assert.equal(resolved.provenance.label, "env");
    } finally {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  });
});
