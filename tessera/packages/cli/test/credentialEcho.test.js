// No raw value that failed a secret check is echoed back to the operator, and
// `tess run` refuses URL credentials on the flags whose values it persists.
//
//  * `bindRole` (topology.ts) used to put `JSON.stringify(value)` in its
//    refusal, so `--runner https://admin:pw@h` printed the password on stderr.
//  * `parseRunArgs` (commands/run.ts) never checked `--instance`, `--name`,
//    `--allow` or `--prod`; `--name 'https://admin:pw@host'` reached
//    ledger.jsonl, run.json and the `--json` document.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EXIT_CODES, main, parseRunArgs } from "../build/index.js";
import { TopologyError, bindRole } from "../build/topology.js";

const CREDENTIAL_VALUES = [
  "https://admin:hunter2@dev.service-now.com",
  "https:/admin:hunter2@dev.service-now.com",
  "https:/\\admin:hunter2@dev.service-now.com",
  "//admin:hunter2@dev.service-now.com",
  "https://admin@dev.service-now.com",
  "Bearer aaaa.bbbbbbbb.cccccccc",
];

/** Anything identifying the credential; none of it may appear in output. */
const LEAK = /hunter2|admin|aaaa\.bbbb/;

describe("bindRole never echoes a value that fails a secret check", () => {
  for (const value of CREDENTIAL_VALUES) {
    it(JSON.stringify(value), () => {
      assert.throws(
        () => bindRole("runner", value),
        (error) => {
          assert.ok(error instanceof TopologyError);
          assert.doesNotMatch(error.message, LEAK);
          assert.match(error.message, /<redacted>|not shown/);
          return true;
        },
      );
    });
  }

  it("still echoes an innocent non-profile value, so the operator sees the typo", () => {
    assert.throws(
      () => bindRole("runner", "https://dev.service-now.com"),
      (error) => {
        assert.ok(error instanceof TopologyError);
        assert.match(error.message, /"https:\/\/dev\.service-now\.com"/);
        return true;
      },
    );
  });
});

function context(cwd) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    ctx: {
      now: () => new Date("2026-09-26T10:00:00.000Z"),
      actor: "test",
      cwd,
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

describe("tess run refuses URL credentials on --instance/--name/--allow/--prod", () => {
  const FLAGS = ["--instance", "--name", "--allow", "--prod"];

  for (const flag of FLAGS) {
    for (const value of CREDENTIAL_VALUES) {
      it(`parseRunArgs: ${flag} ${JSON.stringify(value)}`, () => {
        const { ctx } = context("/");
        const parsed = parseRunArgs(["--skeleton", "--fake", flag, value], ctx);
        assert.equal(parsed.kind, "error");
        assert.match(parsed.message, new RegExp(flag));
        assert.doesNotMatch(parsed.message, LEAK);
      });
    }

    it(`parseRunArgs --live: ${flag} is refused on the credential, not only as a skeleton flag`, () => {
      // --allow/--prod are shared by both modes; a credential there must not
      // reach the live guard config either.
      const { ctx } = context("/");
      const parsed = parseRunArgs(
        [
          "--live",
          "--scope",
          "x",
          "--tests-root",
          "t",
          flag,
          CREDENTIAL_VALUES[0],
        ],
        ctx,
      );
      assert.equal(parsed.kind, "error");
      assert.doesNotMatch(parsed.message, LEAK);
    });
  }

  it("main: exit 2, nothing echoed, no ledger written", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-cred-"));
    try {
      for (const flag of FLAGS) {
        const { ctx, out, err } = context(root);
        const code = await main(
          ["run", "--skeleton", "--fake", flag, CREDENTIAL_VALUES[0]],
          ctx,
        );
        assert.equal(code, EXIT_CODES.usage, `${flag}: ${err.join("\n")}`);
        assert.doesNotMatch(`${out.join("\n")}\n${err.join("\n")}`, LEAK);
      }
      assert.equal(existsSync(path.join(root, ".tessera")), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("an innocent host is still accepted", () => {
    const { ctx } = context("/");
    const parsed = parseRunArgs(
      [
        "--skeleton",
        "--instance",
        "dev.service-now.com",
        "--name",
        "dev",
        "--allow",
        "dev.service-now.com",
        "--prod",
        "prod.service-now.com",
      ],
      ctx,
    );
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.instanceName, "dev");
  });
});

describe("tess run --skeleton refuses a credential-carrying SN_INSTANCE", () => {
  // `context.instance` is `$SN_INSTANCE`, the skeleton's default host. It
  // becomes the instance name AND host — the guard's audit, the ledger's run
  // record and the report — exactly like `--instance`, so it gets the same
  // check and the same refusal: exit 2, the variable named, the value never.
  for (const value of CREDENTIAL_VALUES) {
    it(`parseRunArgs: SN_INSTANCE=${JSON.stringify(value)}`, () => {
      const { ctx } = context("/");
      const parsed = parseRunArgs(["--skeleton"], { ...ctx, instance: value });
      assert.equal(parsed.kind, "error");
      assert.match(parsed.message, /SN_INSTANCE/);
      assert.doesNotMatch(parsed.message, LEAK);
    });
  }

  it("main: exit 2, nothing echoed, no ledger written", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-cred-"));
    try {
      const { ctx, out, err } = context(root);
      const code = await main(["run", "--skeleton"], {
        ...ctx,
        instance: CREDENTIAL_VALUES[0],
      });
      assert.equal(code, EXIT_CODES.usage, err.join("\n"));
      const all = `${out.join("\n")}\n${err.join("\n")}`;
      assert.doesNotMatch(all, LEAK);
      assert.match(all, /SN_INSTANCE/);
      assert.equal(existsSync(path.join(root, ".tessera")), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("an innocent SN_INSTANCE is still the default host", () => {
    const { ctx } = context("/");
    const parsed = parseRunArgs(["--skeleton"], {
      ...ctx,
      instance: "dev.service-now.com",
    });
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.instanceHost, "dev.service-now.com");
  });

  it("an SN_INSTANCE that --instance or --fake overrides is never read", () => {
    const { ctx } = context("/");
    const tainted = { ...ctx, instance: CREDENTIAL_VALUES[0] };
    const explicit = parseRunArgs(
      ["--skeleton", "--instance", "dev.service-now.com"],
      tainted,
    );
    assert.equal(explicit.kind, "run");
    assert.equal(explicit.options.instanceHost, "dev.service-now.com");
    const fake = parseRunArgs(["--skeleton", "--fake"], tainted);
    assert.equal(fake.kind, "run");
    assert.doesNotMatch(fake.options.instanceHost, LEAK);
  });
});
