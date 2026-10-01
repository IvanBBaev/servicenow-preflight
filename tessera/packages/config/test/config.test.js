// Tests for @tessera/config (PLAN Phase 1 §Configuration).
//
// The suite is organised by the promise each group defends rather than by the
// module the code happens to live in, because the promises are what a reviewer
// checks Phase 1 against:
//
//  * precedence and provenance — flag > env > file > default, per field;
//  * the ARCH-29 `--instance` alias, which must fan out and must refuse to
//    guess when a role disagrees with it;
//  * fail-closed parsing — every unrecognised input is a named error, never a
//    silent drop (this repository shipped one of those in `commandSync` and it
//    produced green runs against nothing);
//  * secrets, which may not come from a config file or from argv;
//  * the redacted startup log;
//  * and, last, the one thing the port cannot stand in for: the real disk
//    reader's absent-vs-unreadable split.
//
// No temporary directories anywhere. Everything above the last group goes
// through the file-reader PORT, so a config file in those tests is a string in
// an object literal; the last group calls the real reader against paths that
// already exist or provably do not.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConfigError,
  ConfigSecretError,
  PREFLIGHT_OPTIONS,
  findSecret,
  formatOptionsHelp,
  formatResolvedConfig,
  isSecretKey,
  readTextFileSync,
  resolveConfig,
} from "../build/index.js";

/** An in-memory file system: absent paths read as `undefined`, as on disk. */
function reader(files) {
  return (filePath) =>
    Object.prototype.hasOwnProperty.call(files, filePath)
      ? files[filePath]
      : undefined;
}

/** `resolveConfig` with every injected input defaulted so a test names only what it exercises. */
function resolve({ files = {}, ...input } = {}) {
  return resolveConfig({
    argv: [],
    env: {},
    cwd: "/work",
    readTextFile: reader(files),
    ...input,
  });
}

function json(document) {
  return JSON.stringify(document, null, 2);
}

/** A table with an env-only secret, exercising the mechanism the Phase-1 surface has no row for yet. */
const SECRET_TABLE = [
  {
    key: "confirmToken",
    flag: "--confirm-token",
    env: "TESSERA_CONFIRM_TOKEN",
    type: "string",
    secret: true,
    sources: ["env"],
    describe: "signed promotion token (§6b)",
  },
  {
    key: "scope",
    flag: "--scope",
    env: "TESSERA_SCOPE",
    type: "string",
    describe: "application scope",
  },
];

function throwsWith(fn, Kind, assertions) {
  assert.throws(fn, (error) => {
    assert.ok(
      error instanceof Kind,
      `expected ${Kind.name}, got ${error?.constructor?.name}: ${error?.message}`,
    );
    assertions?.(error);
    return true;
  });
}

describe("precedence", () => {
  it("prefers a flag over the environment, the file and the default", () => {
    const resolved = resolve({
      argv: ["--mode", "apply"],
      env: { TESSERA_MODE: "plan" },
      files: { "/work/tessera.config.json": json({ mode: "plan" }) },
    });
    assert.equal(resolved.values.mode, "apply");
    assert.equal(resolved.provenance.mode, "flag");
  });

  it("prefers the environment over the file and the default", () => {
    const resolved = resolve({
      env: { TESSERA_SCOPE: "x_acme_env" },
      files: { "/work/tessera.config.json": json({ scope: "x_acme_file" }) },
    });
    assert.equal(resolved.values.scope, "x_acme_env");
    assert.equal(resolved.provenance.scope, "env");
  });

  it("prefers the file over the default", () => {
    const resolved = resolve({
      files: { "/work/tessera.config.json": json({ mode: "apply" }) },
    });
    assert.equal(resolved.values.mode, "apply");
    assert.equal(resolved.provenance.mode, "file");
  });

  it("falls back to the declared default when no layer supplies a value", () => {
    const resolved = resolve();
    assert.equal(resolved.values.mode, "plan");
    assert.equal(resolved.values.json, false);
    assert.equal(resolved.provenance.mode, "default");
  });

  it("decides each field independently, so a flag for one field keeps the file's value for another", () => {
    const resolved = resolve({
      argv: ["--scope", "x_acme_cli"],
      files: {
        "/work/tessera.config.json": json({
          scope: "x_acme_file",
          runner: "https://runner.example.com",
          story: "STRY0042",
        }),
      },
    });
    assert.equal(resolved.values.scope, "x_acme_cli");
    assert.equal(resolved.values.runner, "https://runner.example.com");
    assert.equal(resolved.values.story, "STRY0042");
    assert.equal(resolved.provenance.scope, "flag");
    assert.equal(resolved.provenance.runner, "file");
    assert.equal(resolved.provenance.story, "file");
  });

  it("treats an empty environment variable as unset, because an unset shell variable expands to one", () => {
    const resolved = resolve({
      env: { TESSERA_SCOPE: "  " },
      files: { "/work/tessera.config.json": json({ scope: "x_acme_file" }) },
    });
    assert.equal(resolved.values.scope, "x_acme_file");
    assert.equal(resolved.provenance.scope, "file");
  });

  it("lets the TESSERA_ name win over the legacy transport name for a pass-through option", () => {
    const resolved = resolve({
      env: { TESSERA_DOCS_DIR: "docs/tessera", SN_DOCS_DIR: "docs/instance" },
    });
    assert.equal(resolved.values.docsDir, "docs/tessera");
  });

  it("still reads the legacy transport name when the TESSERA_ name is absent", () => {
    const resolved = resolve({ env: { SN_DOCS_DIR: "docs/instance" } });
    assert.equal(resolved.values.docsDir, "docs/instance");
    assert.equal(resolved.provenance.docsDir, "env");
  });

  it("validates a layer that lost, so a broken committed file fails even under an overriding flag", () => {
    throwsWith(
      () =>
        resolve({
          argv: ["--mode", "apply"],
          files: { "/work/tessera.config.json": json({ mode: "aply" }) },
        }),
      ConfigError,
      (error) => assert.match(error.message, /mode.*plan, apply.*aply/s),
    );
  });
});

describe("provenance", () => {
  it("reports the winning layer for every resolved field", () => {
    const resolved = resolve({
      argv: ["--runner", "https://runner.example.com"],
      env: { TESSERA_STORY: "STRY0042" },
      files: { "/work/tessera.config.json": json({ scope: "x_acme" }) },
    });
    assert.deepEqual(
      {
        runner: resolved.provenance.runner,
        story: resolved.provenance.story,
        scope: resolved.provenance.scope,
        mode: resolved.provenance.mode,
      },
      { runner: "flag", story: "env", scope: "file", mode: "default" },
    );
  });

  it("omits an option that no layer supplied, from both values and provenance", () => {
    const resolved = resolve();
    assert.equal(resolved.values.story, undefined);
    assert.equal(resolved.provenance.story, undefined);
    assert.equal(resolved.values.docsDir, undefined);
  });

  it("reports the config file that took part", () => {
    const resolved = resolve({
      files: { "/work/tessera.config.json": json({ scope: "x_acme" }) },
    });
    assert.equal(resolved.configFile, "/work/tessera.config.json");
  });
});

describe("value typing", () => {
  it("accumulates a repeatable list flag and keeps declaration order", () => {
    const resolved = resolve({ argv: ["--kind", "unit", "--kind", "e2e"] });
    assert.deepEqual(resolved.values.kinds, ["unit", "e2e"]);
  });

  it("splits a comma-separated list and de-duplicates repeated items", () => {
    const resolved = resolve({ argv: ["--kind", "unit,e2e,unit"] });
    assert.deepEqual(resolved.values.kinds, ["unit", "e2e"]);
  });

  it("refuses a test kind the pipeline cannot execute", () => {
    throwsWith(
      () => resolve({ argv: ["--kind", "smoke"] }),
      ConfigError,
      (error) => assert.match(error.message, /unit, e2e, ui.*smoke/s),
    );
  });

  it("reads a list from the environment and from the file", () => {
    assert.deepEqual(
      resolve({ env: { TESSERA_KINDS: "unit,ui" } }).values.kinds,
      ["unit", "ui"],
    );
    assert.deepEqual(
      resolve({
        files: { "/work/tessera.config.json": json({ kinds: ["e2e"] }) },
      }).values.kinds,
      ["e2e"],
    );
  });

  it("never lets a boolean flag consume the next token", () => {
    const resolved = resolve({ argv: ["--json", "--scope", "x_acme"] });
    assert.equal(resolved.values.json, true);
    assert.equal(resolved.values.scope, "x_acme");
  });

  it("accepts an explicit boolean word attached to the flag", () => {
    assert.equal(resolve({ argv: ["--json=false"] }).values.json, false);
    assert.equal(resolve({ env: { TESSERA_JSON: "yes" } }).values.json, true);
  });

  it("requires the file to use the JSON type the option declares", () => {
    throwsWith(
      () =>
        resolve({
          files: { "/work/tessera.config.json": json({ json: "yes" }) },
        }),
      ConfigError,
      (error) => assert.match(error.message, /JSON boolean.*a string/s),
    );
  });
});

describe("the --instance alias (ARCH-29)", () => {
  it("collapses onto all three roles explicitly and records where they came from", () => {
    const resolved = resolve({
      argv: ["--instance", "https://dev.example.com"],
    });
    assert.equal(resolved.values.source, "https://dev.example.com");
    assert.equal(resolved.values.runner, "https://dev.example.com");
    assert.equal(resolved.values.target, "https://dev.example.com");
    assert.deepEqual(resolved.aliasedFrom, {
      source: "instance",
      runner: "instance",
      target: "instance",
    });
    assert.equal(resolved.provenance.runner, "flag");
  });

  it("carries the alias's own layer onto the roles it produced", () => {
    const resolved = resolve({
      env: { TESSERA_INSTANCE: "https://dev.example.com" },
    });
    assert.equal(resolved.provenance.source, "env");
    assert.equal(resolved.aliasedFrom.source, "instance");
  });

  it("refuses to guess when an explicit role disagrees with the alias", () => {
    throwsWith(
      () =>
        resolve({
          argv: [
            "--instance",
            "https://dev.example.com",
            "--runner",
            "https://other.example.com",
          ],
        }),
      ConfigError,
      (error) => {
        assert.match(error.message, /--instance=https:\/\/dev\.example\.com/);
        assert.match(error.message, /--runner=https:\/\/other\.example\.com/);
      },
    );
  });

  it("refuses a conflict across layers too, not only within the command line", () => {
    throwsWith(
      () =>
        resolve({
          argv: ["--runner", "https://other.example.com"],
          files: {
            "/work/tessera.config.json": json({
              instance: "https://dev.example.com",
            }),
          },
        }),
      ConfigError,
      (error) => assert.match(error.message, /from file.*from flag/s),
    );
  });

  it("accepts a role that repeats the alias's value and leaves its own provenance alone", () => {
    const resolved = resolve({
      argv: [
        "--instance",
        "https://dev.example.com",
        "--runner",
        "https://dev.example.com",
      ],
    });
    assert.equal(resolved.values.runner, "https://dev.example.com");
    assert.equal(resolved.aliasedFrom.runner, undefined);
    assert.equal(resolved.aliasedFrom.target, "instance");
  });
});

describe("fail-closed parsing", () => {
  it("names an unknown flag and lists the valid ones", () => {
    throwsWith(
      () => resolve({ argv: ["--targets", "https://dev.example.com"] }),
      ConfigError,
      (error) => {
        assert.match(error.message, /unknown flag "--targets"/);
        assert.match(error.message, /--target/);
      },
    );
  });

  it("names an unknown config-file key and lists the valid ones", () => {
    throwsWith(
      () =>
        resolve({
          files: { "/work/tessera.config.json": json({ scoop: "x_acme" }) },
        }),
      ConfigError,
      (error) => {
        assert.match(error.message, /unknown key "scoop"/);
        assert.match(error.message, /scope/);
      },
    );
  });

  it("refuses a stray positional instead of dropping it, the way commandSync once did", () => {
    throwsWith(
      () => resolve({ argv: ["preflight", "--scope", "x_acme"] }),
      ConfigError,
      (error) => assert.match(error.message, /unexpected argument "preflight"/),
    );
  });

  it("refuses a flag whose value is missing", () => {
    throwsWith(
      () => resolve({ argv: ["--scope"] }),
      ConfigError,
      (error) => assert.match(error.message, /--scope expects a value/),
    );
    throwsWith(
      () => resolve({ argv: ["--scope", "--json"] }),
      ConfigError,
      (error) => assert.match(error.message, /--scope expects a value/),
    );
  });

  it("refuses a non-numeric value for a numeric option", () => {
    throwsWith(
      () => resolve({ argv: ["--run-timeout-ms", "soon"] }),
      ConfigError,
      (error) => assert.match(error.message, /expects a number — got "soon"/),
    );
  });

  it("enforces the declared lower bound on a numeric option", () => {
    throwsWith(
      () => resolve({ argv: ["--poll-interval-ms", "0"] }),
      ConfigError,
      (error) => assert.match(error.message, />= 1/),
    );
  });

  it("refuses a repeated flag that is not repeatable rather than dropping one value", () => {
    throwsWith(
      () => resolve({ argv: ["--scope", "a", "--scope", "b"] }),
      ConfigError,
      (error) => assert.match(error.message, /more than once/),
    );
  });

  it("refuses an empty flag value", () => {
    throwsWith(
      () => resolve({ argv: ["--scope="] }),
      ConfigError,
      (error) => assert.match(error.message, /non-empty/),
    );
  });

  it("refuses a config file that is not valid JSON, naming the file", () => {
    throwsWith(
      () => resolve({ files: { "/work/tessera.config.json": "{ scope: }" } }),
      ConfigError,
      (error) =>
        assert.match(
          error.message,
          /\/work\/tessera\.config\.json is not valid JSON/,
        ),
    );
  });

  it("refuses a config file that is not a JSON object at the top level", () => {
    throwsWith(
      () =>
        resolve({ files: { "/work/tessera.config.json": json(["--scope"]) } }),
      ConfigError,
      (error) =>
        assert.match(error.message, /object at the top level.*an array/s),
    );
  });

  it("refuses an option in the file that the table keeps off the file layer", () => {
    throwsWith(
      () =>
        resolve({
          files: {
            "/work/tessera.config.json": json({ config: "other.json" }),
          },
        }),
      ConfigError,
      (error) => assert.match(error.message, /"config" may not be set/),
    );
  });

  it("refuses an option table that lets a secret arrive by flag or file", () => {
    throwsWith(
      () =>
        resolveConfig({
          argv: [],
          env: {},
          cwd: "/work",
          readTextFile: () => undefined,
          options: [
            {
              key: "token",
              flag: "--token",
              env: "TESSERA_TOKEN",
              type: "string",
              secret: true,
              describe: "a badly declared secret",
            },
          ],
        }),
      ConfigError,
      (error) => assert.match(error.message, /must declare sources: \["env"\]/),
    );
  });
});

describe("config-file discovery", () => {
  it("treats a missing tessera.config.json as normal", () => {
    const resolved = resolve({ cwd: "/work/deep/nested" });
    assert.equal(resolved.configFile, undefined);
    assert.equal(resolved.values.mode, "plan");
  });

  it("walks up from the working directory to the nearest file", () => {
    const resolved = resolve({
      cwd: "/work/packages/app",
      files: { "/work/tessera.config.json": json({ scope: "x_acme" }) },
    });
    assert.equal(resolved.configFile, "/work/tessera.config.json");
    assert.equal(resolved.values.scope, "x_acme");
  });

  it("stops at the nearest file rather than merging the ones above it", () => {
    const resolved = resolve({
      cwd: "/work/packages/app",
      files: {
        "/work/tessera.config.json": json({ scope: "x_root", story: "STRY1" }),
        "/work/packages/app/tessera.config.json": json({ scope: "x_leaf" }),
      },
    });
    assert.equal(resolved.values.scope, "x_leaf");
    assert.equal(resolved.values.story, undefined);
  });

  it("resolves an explicit --config against the working directory", () => {
    const resolved = resolve({
      argv: ["--config", "conf/tessera.json"],
      cwd: "/work",
      files: { "/work/conf/tessera.json": json({ scope: "x_acme" }) },
    });
    assert.equal(resolved.configFile, "/work/conf/tessera.json");
    assert.equal(resolved.provenance.config, "flag");
  });

  it("errors when an explicit --config names a file that is not there", () => {
    throwsWith(
      () => resolve({ argv: ["--config", "missing.json"] }),
      ConfigError,
      (error) =>
        assert.match(
          error.message,
          /config file not found: \/work\/missing\.json/,
        ),
    );
  });

  it("accepts the explicit path from the environment as well", () => {
    const resolved = resolve({
      env: { TESSERA_CONFIG: "/elsewhere/tessera.json" },
      files: { "/elsewhere/tessera.json": json({ scope: "x_acme" }) },
    });
    assert.equal(resolved.configFile, "/elsewhere/tessera.json");
  });

  it("reports a file that exists but cannot be read, rather than treating it as absent", () => {
    throwsWith(
      () =>
        resolve({
          argv: ["--config", "locked.json"],
          readTextFile: () => {
            throw Object.assign(new Error("permission denied"), {
              code: "EACCES",
            });
          },
        }),
      ConfigError,
      (error) =>
        assert.match(error.message, /could not be read.*permission denied/s),
    );
  });
});

describe("secrets never reach a config file or argv", () => {
  it("refuses a credential planted in a config file and names the offending key path", () => {
    throwsWith(
      () =>
        resolve({
          files: {
            "/work/tessera.config.json": json({
              runner: "https://dev12345.service-now.com",
              auth: {
                username: "tessera.svc",
                password: "8Rk!qz2Lm#4vTp9w",
              },
            }),
          },
        }),
      ConfigSecretError,
      (error) => {
        assert.equal(error.keyPath, "auth.password");
        assert.equal(error.channel, "file");
        assert.match(error.message, /auth\.password/);
        assert.match(error.message, /environment|credential store/);
      },
    );
  });

  it("reports the credential before the unknown key that carries it", () => {
    // "unknown key auth" would send the operator to fix a typo while the
    // password stays in the committed file.
    throwsWith(
      () =>
        resolve({
          files: {
            "/work/tessera.config.json": json({
              auth: { client_secret: "s3cr3t-value" },
            }),
          },
        }),
      ConfigSecretError,
      (error) => assert.equal(error.keyPath, "auth.client_secret"),
    );
  });

  it("refuses a PEM private key pasted under an innocent key name", () => {
    throwsWith(
      () =>
        resolve({
          files: {
            "/work/tessera.config.json": json({
              transport: {
                material:
                  "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----",
              },
            }),
          },
        }),
      ConfigSecretError,
      (error) => {
        assert.equal(error.keyPath, "transport.material");
        assert.match(error.message, /PEM private-key block/);
      },
    );
  });

  it("does not refuse a key that merely contains a secret word, or a value that merely reads like one", () => {
    const resolved = resolve({
      options: [
        {
          key: "tokenizer",
          flag: "--tokenizer",
          env: "TESSERA_TOKENIZER",
          type: "string",
          describe: "how test names are split",
        },
        {
          key: "scope",
          flag: "--scope",
          env: "TESSERA_SCOPE",
          type: "string",
          describe: "application scope",
        },
      ],
      files: {
        "/work/tessera.config.json": json({
          tokenizer: "whitespace",
          scope: "secretariat",
        }),
      },
    });
    assert.equal(resolved.values.tokenizer, "whitespace");
    assert.equal(resolved.values.scope, "secretariat");
    assert.equal(isSecretKey("tokenizer"), false);
    assert.equal(isSecretKey("sortKey"), false);
    assert.equal(findSecret({ tokenizer: "secretariat" }), undefined);
  });

  it("still matches a credential key across separators and camel case", () => {
    assert.equal(isSecretKey("apiKey"), true);
    assert.equal(isSecretKey("API_KEY"), true);
    assert.equal(isSecretKey("private-key"), true);
    assert.equal(isSecretKey("clientSecret"), true);
  });

  it("refuses a credential-bearing flag because argv is readable through ps(1)", () => {
    throwsWith(
      () => resolve({ argv: ["--api-key", "abc123"] }),
      ConfigSecretError,
      (error) => {
        assert.equal(error.channel, "flag");
        assert.match(error.message, /ps\(1\)/);
      },
    );
  });

  it("refuses a secret-shaped value on the command line even under an innocent flag", () => {
    throwsWith(
      () =>
        resolve({
          argv: [
            "--scope",
            "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27u",
          ],
        }),
      ConfigSecretError,
      (error) => {
        assert.equal(error.channel, "flag");
        assert.match(error.message, /Bearer JWT/);
      },
    );
  });

  it("refuses an env-only secret option on the command line", () => {
    throwsWith(
      () =>
        resolve({ argv: ["--confirm-token", "abc"], options: SECRET_TABLE }),
      ConfigSecretError,
      (error) => {
        assert.equal(error.keyPath, "--confirm-token");
        assert.match(error.message, /only come from the environment/);
      },
    );
  });

  it("accepts an env-only secret option from the environment", () => {
    const resolved = resolve({
      env: { TESSERA_CONFIRM_TOKEN: "d41d8cd98f00b204e9800998ecf8427e" },
      options: SECRET_TABLE,
    });
    assert.equal(
      resolved.values.confirmToken,
      "d41d8cd98f00b204e9800998ecf8427e",
    );
    assert.equal(resolved.provenance.confirmToken, "env");
  });
});

describe("the redacted startup log", () => {
  it("redacts a secret to fixed text, leaking neither its value nor its length", () => {
    const token = "d41d8cd98f00b204e9800998ecf8427e";
    const resolved = resolve({
      argv: ["--scope", "x_acme"],
      env: { TESSERA_CONFIRM_TOKEN: token },
      options: SECRET_TABLE,
    });
    const log = formatResolvedConfig(resolved);
    assert.match(log, /^confirmToken = <redacted> \(from env\)$/m);
    assert.equal(log.includes(token), false);
    assert.equal(log.includes(token.slice(0, 8)), false);
    assert.equal(log.includes(String(token.length)), false);
  });

  it("redacts a secret-shaped value even under an option the table did not mark", () => {
    const resolved = resolve({
      files: {
        "/work/tessera.config.json": json({ scope: "x_acme" }),
      },
      options: [
        {
          key: "scope",
          flag: "--scope",
          env: "TESSERA_SCOPE",
          type: "string",
          describe: "application scope",
        },
      ],
      env: {
        TESSERA_SCOPE: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjft",
      },
    });
    assert.match(formatResolvedConfig(resolved), /^scope = <redacted>/m);
  });

  it("shows the layer that won for every other option", () => {
    const log = formatResolvedConfig(
      resolve({
        argv: ["--runner", "https://runner.example.com"],
        env: { TESSERA_STORY: "STRY0042" },
        files: { "/work/tessera.config.json": json({ scope: "x_acme" }) },
      }),
    );
    assert.match(
      log,
      /^runner = https:\/\/runner\.example\.com \(from flag\)$/m,
    );
    assert.match(log, /^story = STRY0042 \(from env\)$/m);
    assert.match(log, /^scope = x_acme \(from file\)$/m);
    assert.match(log, /^mode = plan \(from default\)$/m);
    assert.match(log, /^config file: \/work\/tessera\.config\.json$/m);
  });

  it("marks the roles the --instance alias produced", () => {
    const log = formatResolvedConfig(
      resolve({ argv: ["--instance", "https://dev.example.com"] }),
    );
    assert.match(
      log,
      /^runner = https:\/\/dev\.example\.com \(from flag via --instance\)$/m,
    );
  });

  it("says so when no config file took part", () => {
    assert.match(formatResolvedConfig(resolve()), /^config file: none/m);
  });

  it("derives the help text from the same table the resolver reads", () => {
    const help = formatOptionsHelp(PREFLIGHT_OPTIONS);
    for (const option of PREFLIGHT_OPTIONS) {
      assert.ok(help.includes(option.flag), `help omits ${option.flag}`);
      assert.ok(help.includes(option.describe), `help omits ${option.key}`);
    }
    assert.match(help, /--json {2,}/);
  });
});

// `readTextFileSync` is the only thing in this package that touches disk, so it
// is the only thing the port-shaped suite above cannot reach. Still no
// temporary directories: both paths below already exist, or provably do not.
describe("the real disk reader", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));

  it("never reports a path that is occupied as absent", () => {
    // A directory named like a config file is PRESENT. Reading it as
    // `undefined` would reach the operator as `config file not found`, which
    // this reader never observed: it observed a read it could not perform.
    assert.throws(
      () => readTextFileSync(here),
      (error) => error.code === "EISDIR",
    );
  });

  it("reports a path with nothing at it as absent", () => {
    assert.equal(
      readTextFileSync(path.join(here, "no-such-config-file.json")),
      undefined,
    );
  });
});

// Delegated decision 2026-09-25 — review W3a finding 2: a URL with userinfo
// used to resolve on a topology key and print, password included, in the
// startup log (`runner = https://admin:hunter2@…`).
describe("credentialed URLs (userinfo)", () => {
  const PASSWORD = "hunter2";
  const URL_WITH_PASSWORD = `https://admin:${PASSWORD}@dev.service-now.com`;

  function assertNoPassword(error) {
    assert.equal(error.message.includes(PASSWORD), false);
    assert.equal(String(error.stack).includes(PASSWORD), false);
  }

  it("refuses user:password@ on a topology flag without echoing the password", () => {
    for (const flag of ["--runner", "--source", "--target", "--instance"]) {
      throwsWith(
        () => resolve({ argv: [flag, URL_WITH_PASSWORD] }),
        ConfigSecretError,
        (error) => {
          assert.equal(error.channel, "flag");
          assert.match(error.message, /userinfo/);
          assertNoPassword(error);
        },
      );
    }
  });

  it("refuses userinfo on a topology key from the environment too", () => {
    for (const name of [
      "TESSERA_SOURCE",
      "TESSERA_RUNNER",
      "TESSERA_TARGET",
      "TESSERA_INSTANCE",
    ]) {
      throwsWith(
        () => resolve({ env: { [name]: URL_WITH_PASSWORD } }),
        ConfigSecretError,
        (error) => {
          assert.equal(error.channel, "env");
          assert.match(error.message, new RegExp(name));
          assertNoPassword(error);
        },
      );
    }
  });

  it("refuses a bare user@ on a topology key, with or without a scheme", () => {
    for (const value of [
      "https://admin@dev.service-now.com",
      "admin@dev.service-now.com",
      "admin:pw@dev.service-now.com",
    ]) {
      throwsWith(
        () => resolve({ argv: ["--runner", value] }),
        ConfigSecretError,
        (error) => {
          assert.equal(error.keyPath, "runner");
          assert.equal(error.message.includes("pw@"), false);
        },
      );
    }
  });

  it("refuses userinfo on a topology key in a config file, even when a flag overrides it", () => {
    throwsWith(
      () =>
        resolve({
          argv: ["--runner", "https://dev.service-now.com"],
          files: {
            "/work/tessera.config.json": json({
              runner: "https://admin@dev.service-now.com",
            }),
          },
        }),
      ConfigSecretError,
      (error) => assert.equal(error.channel, "file"),
    );
    throwsWith(
      () =>
        resolve({
          files: {
            "/work/tessera.config.json": json({ runner: URL_WITH_PASSWORD }),
          },
        }),
      ConfigSecretError,
      (error) => {
        assert.equal(error.channel, "file");
        assertNoPassword(error);
      },
    );
  });

  it("refuses user:password@ under a non-topology flag and redacts it from env", () => {
    throwsWith(
      () => resolve({ argv: ["--scope", URL_WITH_PASSWORD] }),
      ConfigSecretError,
      (error) => {
        assert.equal(error.channel, "flag");
        assertNoPassword(error);
      },
    );
    const log = formatResolvedConfig(
      resolve({ env: { TESSERA_SCOPE: URL_WITH_PASSWORD } }),
    );
    assert.match(log, /^scope = <redacted>/m);
    assert.equal(log.includes(PASSWORD), false);
  });

  it("still accepts plain instance URLs, ports and paths", () => {
    const resolved = resolve({
      argv: [
        "--runner",
        "https://dev.service-now.com:8443/path?q=a@b",
        "--source",
        "dev000000",
      ],
    });
    assert.equal(
      resolved.values.runner,
      "https://dev.service-now.com:8443/path?q=a@b",
    );
    assert.equal(resolved.values.source, "dev000000");
  });
});

// Delegated decision 2026-09-25 — review W3a finding 3: `Number()` + isFinite
// and a min-only bound let 3e9, 1e308, "0x10" and 1.5 through, and setTimeout
// clamps an overflowing delay to 1 ms.
describe("millisecond options are bounded safe integers", () => {
  const MAX = 2_147_483_647;

  it("accepts the full timer range at its edges", () => {
    const resolved = resolve({
      argv: ["--run-timeout-ms", String(MAX), "--poll-interval-ms", "1"],
    });
    assert.equal(resolved.values.runTimeoutMs, MAX);
    assert.equal(resolved.values.pollIntervalMs, 1);
  });

  it("refuses a value above the setTimeout ceiling on every layer", () => {
    for (const input of [
      { argv: ["--run-timeout-ms", String(MAX + 1)] },
      { argv: ["--poll-interval-ms", "3000000000"] },
      { env: { TESSERA_RUN_TIMEOUT_MS: "3000000000" } },
      {
        files: {
          "/work/tessera.config.json": json({ pollIntervalMs: 3e9 }),
        },
      },
    ]) {
      throwsWith(
        () => resolve(input),
        ConfigError,
        (error) => assert.match(error.message, /<= 2147483647/),
      );
    }
  });

  it("refuses hex, exponent, decimal and signed text", () => {
    for (const text of ["0x10", "1e308", "1e3", "1.5", "+5", "-0", " 1 2"]) {
      throwsWith(
        () => resolve({ argv: [`--run-timeout-ms=${text}`] }),
        ConfigError,
        (error) => assert.match(error.message, /decimal digits only/),
      );
    }
  });

  it("refuses a non-integer JSON number in the config file", () => {
    throwsWith(
      () =>
        resolve({
          files: { "/work/tessera.config.json": json({ runTimeoutMs: 1.5 }) },
        }),
      ConfigError,
      (error) => assert.match(error.message, /whole number/),
    );
  });

  it("declares the bound in the shipped table", () => {
    for (const key of ["runTimeoutMs", "pollIntervalMs"]) {
      const spec = PREFLIGHT_OPTIONS.find((option) => option.key === key);
      assert.equal(spec.max, MAX);
      assert.equal(spec.integer, true);
    }
  });
});
