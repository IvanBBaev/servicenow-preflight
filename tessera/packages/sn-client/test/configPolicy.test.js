// Net-new for @tessera/sn-client (the vendored core arrived without tests).
// env-file.ts, config.ts and policy.ts are one contract read from three files:
// formatEnvValue() writes the .env lines parseEnvContent() must read back
// identically (a mangled password is an authentication failure nobody can
// debug), and policy.ts resolves every gate through the same environment,
// per-profile key first and global key second.
// Everything here reads process.env on each call — the credential store is the
// only cached module state, and reloadCredentialsFromEnv() re-snapshots it — so
// the suites stage the environment directly. withEnv() restores every key it
// touches, including ones the host machine happened to define, because the
// whole file shares one process.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  parseEnvContent,
  applyEnv,
  formatEnvValue,
  activeProfile,
  getCredentials,
  hasCredentials,
  listProfiles,
  reloadCredentialsFromEnv,
  isReadOnly,
  assertTableAllowed,
  assertWriteAllowed,
  getAllowedTables,
  getDeniedTables,
  ServiceNowError,
} from "../build/index.js";

/**
 * Run `fn` with the given env vars staged — a value of `undefined` deletes the
 * key — and restore the previous state (including absence) afterwards.
 */
function withEnv(vars, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

/**
 * Every env key the policy gate consults, cleared. Spelled out as a literal so
 * an ambient value on the developer's machine can never decide a test, and so
 * the list moves only when a human edits it.
 */
const NO_POLICY = {
  SN_READONLY: undefined,
  SN_TABLES_ALLOW: undefined,
  SN_TABLES_DENY: undefined,
  SN_ACTIVE_PROFILE: undefined,
  SN_PROFILE_PROD_READONLY: undefined,
  SN_PROFILE_PROD_TABLES_ALLOW: undefined,
  SN_PROFILE_PROD_TABLES_DENY: undefined,
  SN_PROFILE_PROD_INSTANCE: undefined,
  SN_PROFILE_PROD_USER: undefined,
  SN_PROFILE_PROD_PASSWORD: undefined,
};

/** Assert a policy denial: a 403 ServiceNowError whose message names `what`. */
function assertDenied(fn, what) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ServiceNowError);
    assert.equal(err.name, "ServiceNowError");
    assert.equal(err.status, 403);
    assert.match(err.message, what);
    return true;
  });
}

describe("parseEnvContent — the dotenv v16 grammar this package reimplements", () => {
  it("reads KEY=value, ignoring surrounding whitespace and an `export` prefix", () => {
    assert.deepEqual(parseEnvContent("K=value"), { K: "value" });
    assert.deepEqual(parseEnvContent("   K   =   value   "), { K: "value" });
    assert.deepEqual(parseEnvContent("export K=value"), { K: "value" });
    assert.deepEqual(parseEnvContent("  export   K=value"), { K: "value" });
  });

  it("ends an unquoted value at an inline # comment and trims what is left", () => {
    assert.equal(parseEnvContent("K=value # trailing comment").K, "value");
    assert.equal(
      parseEnvContent("K=  spaced value   # note").K,
      "spaced value",
    );
    // A `#` with no space before it still starts the comment when unquoted.
    assert.equal(parseEnvContent("K=value#comment").K, "value");
  });

  it("keeps inner spaces and # inside single, double and backtick quotes", () => {
    assert.equal(parseEnvContent("K='a b # c'").K, "a b # c");
    assert.equal(parseEnvContent('K="a b # c"').K, "a b # c");
    assert.equal(parseEnvContent("K=`a b # c`").K, "a b # c");
    // Trailing whitespace inside the quotes survives; outside them it does not.
    assert.equal(parseEnvContent("K='padded '   ").K, "padded ");
  });

  it("strips only ONE surrounding quote pair", () => {
    assert.equal(parseEnvContent('K=""inner""').K, '"inner"');
    assert.equal(parseEnvContent("K=''inner''").K, "'inner'");
    assert.equal(parseEnvContent("K=``inner``").K, "`inner`");
  });

  it("expands \\n and \\r inside double quotes, keeps them literal in single quotes", () => {
    assert.equal(parseEnvContent('K="a\\nb"').K, "a\nb");
    assert.equal(parseEnvContent('K="a\\rb"').K, "a\rb");
    assert.equal(parseEnvContent("K='a\\nb'").K, "a\\nb");
    assert.equal(parseEnvContent("K=`a\\nb`").K, "a\\nb");
  });

  it("ignores blank lines, full-line comments and malformed lines", () => {
    const content = [
      "",
      "   ",
      "# a full-line comment",
      "   # an indented comment",
      "NO_ASSIGNMENT",
      "not a key = value",
      "=orphan value",
      "GOOD=kept",
    ].join("\n");
    assert.deepEqual(parseEnvContent(content), { GOOD: "kept" });
  });

  it("lets a later line for the same key win", () => {
    assert.equal(parseEnvContent("K=first\nK=second").K, "second");
    // CRLF files split the same way, so the rule holds there too.
    assert.equal(parseEnvContent("K=first\r\nK=second\r\n").K, "second");
  });

  // Delegated decision 2026-09-23: a quote opened and never closed on its line
  // is a multi-line value this parser cannot read. It used to be truncated and
  // its continuation lines re-parsed as assignments (key injection); now the
  // whole parse throws, and the message never echoes the (possibly secret) value.
  it("throws on an unterminated quote instead of injecting continuation lines", () => {
    for (const q of ['"', "'", "`"]) {
      assert.throws(
        () => parseEnvContent(`A=1\nK=${q}s3cret-first-line\nPATH=/evil\n${q}`),
        (error) =>
          error instanceof Error &&
          error.message.includes("line 2") &&
          error.message.includes("K") &&
          !error.message.includes("s3cret"),
        `quote ${q}`,
      );
    }
    // A lone quote character is unterminated too.
    assert.throws(() => parseEnvContent('K="'), /line 1/);
    // Closed on the same line — even with trailing text — is NOT an error.
    assert.equal(parseEnvContent('K="a" b').K, '"a" b');
    assert.equal(parseEnvContent('K=a"b').K, 'a"b');
  });

  it("still drops the `KEY: value` separator line (known gap, fails closed)", () => {
    assert.deepEqual(parseEnvContent("K: value\nGOOD=kept"), { GOOD: "kept" });
  });
});

describe("formatEnvValue → parseEnvContent round-trip", () => {
  // A secret survives a save/load cycle or it does not; each entry is one value
  // written to an .env line and read straight back.
  const ROUND_TRIP = [
    ["a plain token", "hello"],
    ["a value with spaces", "hello world"],
    ["a value containing #", "a#b"],
    ["a value containing =", "a=b"],
    ["a value containing a single quote", "it's"],
    ["a value containing a double quote", 'say "hi"'],
    ["a value that is itself double-quoted text", '"quoted"'],
    ["a value that opens with a single quote", "'leading"],
    ["a value with leading and trailing spaces", " padded "],
    ["an empty string", ""],
    ["a password with a space and a #", "p@ss w0rd#1"],
    [
      "a JWT-looking token",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXNzZXJhIiwiaWF0IjoxN30.7Hh-_9aQxK2mN0pRsTuVwXyZ",
    ],
    ["a Windows path (backslashes need no quoting)", "C:\\logs\\sn"],
  ];

  for (const [label, value] of ROUND_TRIP) {
    it(`round-trips ${label}`, () => {
      assert.equal(parseEnvContent(`K=${formatEnvValue(value)}`).K, value);
    });
  }

  it("quotes only what it must, preferring single quotes", () => {
    // The chosen serialisation is part of the contract: a value that needs no
    // quoting must not gain any, or a hand-edited .env stops matching a written
    // one. Note that spaces and an inner quote alone do NOT trigger quoting.
    assert.equal(formatEnvValue("hello world"), "hello world");
    assert.equal(formatEnvValue("it's"), "it's");
    assert.equal(formatEnvValue('say "hi"'), 'say "hi"');
    assert.equal(formatEnvValue("a#b"), "'a#b'");
    assert.equal(formatEnvValue(" padded "), "' padded '");
    assert.equal(formatEnvValue(""), "''");
    // Only when the value already contains a single quote does it fall back to
    // double quotes.
    assert.equal(formatEnvValue("'leading"), '"\'leading"');
  });

  // The refusals are the honest half of the contract: dotenv never unescapes a
  // backslash, so these values cannot come back unchanged and the writer says
  // so instead of silently corrupting a credential.
  const REFUSED = [
    ["a newline", "line1\nline2"],
    ["a carriage return", "line1\rline2"],
    ["a backslash in a value that must be quoted", "C:\\logs #1"],
    [
      "both quote kinds in a value that must be quoted",
      `he said "hi" to o'brien #now`,
    ],
  ];

  for (const [label, value] of REFUSED) {
    it(`refuses to serialise ${label}`, () => {
      assert.throws(
        () => formatEnvValue(value),
        /cannot be stored safely in \.env/,
      );
    });
  }
});

describe("applyEnv — dotenv's override:false semantics", () => {
  it("sets absent keys and leaves present ones untouched", () => {
    const env = { PRESENT: "existing", EMPTY: "" };
    applyEnv({ PRESENT: "from file", EMPTY: "from file", ABSENT: "set" }, env);
    // An empty string is *present*, so the file must not fill it in — the
    // check is `=== undefined`, not truthiness.
    assert.deepEqual(env, {
      PRESENT: "existing",
      EMPTY: "",
      ABSENT: "set",
    });
  });

  it("writes only into the env object it was handed", () => {
    const env = {};
    applyEnv({ SN_APPLYENV_PROBE: "x" }, env);
    assert.equal(env.SN_APPLYENV_PROBE, "x");
    assert.equal(process.env.SN_APPLYENV_PROBE, undefined);
  });

  it("is a no-op for an empty pair set", () => {
    const env = { KEEP: "me" };
    assert.equal(applyEnv({}, env), undefined);
    assert.deepEqual(env, { KEEP: "me" });
  });
});

describe("policy — the env-driven write and table gates (DEV-24)", () => {
  // Delegated decision 2026-09-26: SN_READONLY fails CLOSED. Only an unset or
  // blank value, or one of the four explicit "off" spellings (case-insensitive,
  // trimmed), leaves writes permitted; ANY other value — including a typo or an
  // unfamiliar truthy spelling such as "y", "enabled" or "2" — is read-only.
  // Before this, only 1/true/yes/on closed the gate, so an operator writing
  // `SN_READONLY=y` believed the environment was read-only while it was not.
  const TRUTHY = [
    "1",
    "true",
    "TRUE",
    " yes ",
    "on",
    "On",
    "y",
    "enabled",
    "2",
    "maybe",
    "readonly",
    "-1",
  ];
  const FALSY = ["0", "false", "FALSE", " no ", "off", "Off", "", "  "];

  for (const raw of TRUTHY) {
    it(`treats SN_READONLY=${JSON.stringify(raw)} as read-only`, () => {
      withEnv({ ...NO_POLICY, SN_READONLY: raw }, () => {
        assert.equal(isReadOnly(), true);
        assertDenied(() => assertWriteAllowed("POST /x"), /POST \/x/);
      });
    });
  }

  for (const raw of FALSY) {
    it(`treats SN_READONLY=${JSON.stringify(raw)} as writable`, () => {
      withEnv({ ...NO_POLICY, SN_READONLY: raw }, () => {
        assert.equal(isReadOnly(), false);
        assert.equal(assertWriteAllowed("POST /x"), undefined);
      });
    });
  }

  it("treats an unset SN_READONLY as writable", () => {
    withEnv(NO_POLICY, () => {
      assert.equal(isReadOnly(), false);
      assert.equal(assertWriteAllowed("POST /x"), undefined);
    });
  });

  it("denies a write with a 403 ServiceNowError naming the operation", () => {
    // A denial must be loud and attributable — the caller has to be able to
    // tell 403-by-policy from 401 and to see which call was refused.
    withEnv({ ...NO_POLICY, SN_READONLY: "1" }, () => {
      assertDenied(
        () => assertWriteAllowed("POST /api/now/table/incident"),
        /"POST \/api\/now\/table\/incident" is not permitted/,
      );
      assertDenied(
        () => assertWriteAllowed("POST /api/now/table/incident"),
        /SN_READONLY/,
      );
    });
  });

  it("permits every table when neither list is configured", () => {
    withEnv(NO_POLICY, () => {
      assert.deepEqual(getAllowedTables(), []);
      assert.deepEqual(getDeniedTables(), []);
      assert.equal(assertTableAllowed("sys_user"), undefined);
    });
  });

  it("admits only the listed tables once SN_TABLES_ALLOW is set", () => {
    withEnv({ ...NO_POLICY, SN_TABLES_ALLOW: "incident, Problem ,," }, () => {
      // Entries are trimmed, lower-cased and emptied out on both sides.
      assert.deepEqual(getAllowedTables(), ["incident", "problem"]);
      assert.equal(assertTableAllowed("incident"), undefined);
      assert.equal(assertTableAllowed("  PROBLEM  "), undefined);
      assertDenied(
        () => assertTableAllowed("change_request"),
        /not permitted by SN_TABLES_ALLOW/,
      );
    });
  });

  it("lets SN_TABLES_DENY win over the allowlist for the same table", () => {
    withEnv(
      { ...NO_POLICY, SN_TABLES_ALLOW: "incident", SN_TABLES_DENY: "incident" },
      () => {
        assert.deepEqual(getDeniedTables(), ["incident"]);
        assertDenied(
          () => assertTableAllowed("incident"),
          /denied by SN_TABLES_DENY/,
        );
      },
    );
  });

  it("denies a table by SN_TABLES_DENY even with no allowlist at all", () => {
    withEnv({ ...NO_POLICY, SN_TABLES_DENY: "sys_user" }, () => {
      assertDenied(
        () => assertTableAllowed("sys_user"),
        /denied by SN_TABLES_DENY/,
      );
      assert.equal(assertTableAllowed("incident"), undefined);
    });
  });

  describe("per-profile overrides (MI-2)", () => {
    // The whole point of the profile axis: one process serving "prod is
    // read-only, dev has full rights".
    const PROD = {
      ...NO_POLICY,
      SN_INSTANCE: undefined,
      SN_USER: undefined,
      SN_PASSWORD: undefined,
      SN_ACTIVE_PROFILE: "prod",
      SN_PROFILE_PROD_INSTANCE: "https://prod.service-now.com",
      SN_PROFILE_PROD_USER: "svc.tessera",
      SN_PROFILE_PROD_PASSWORD: "p@ss w0rd#1",
    };

    afterEach(() => {
      // The credential store is the one piece of cached module state. withEnv
      // has already restored the environment, so re-snapshot from it and leave
      // no staged profile behind for the next suite.
      reloadCredentialsFromEnv();
    });

    it("activates the profile named by SN_ACTIVE_PROFILE and snapshots its credentials", () => {
      withEnv(PROD, () => {
        reloadCredentialsFromEnv();
        assert.equal(activeProfile(), "prod");
        assert.deepEqual(getCredentials(), {
          instance: "https://prod.service-now.com",
          user: "svc.tessera",
          password: "p@ss w0rd#1",
        });
        assert.equal(hasCredentials(), true);
        assert.ok(listProfiles().includes("prod"));
        // With SN_INSTANCE cleared there is no legacy `default` profile.
        assert.equal(listProfiles().includes("default"), false);
      });
    });

    it("trims and lower-cases SN_ACTIVE_PROFILE, and ignores a malformed name", () => {
      withEnv({ ...NO_POLICY, SN_ACTIVE_PROFILE: "  PROD  " }, () => {
        assert.equal(activeProfile(), "prod");
      });
      withEnv({ ...NO_POLICY, SN_ACTIVE_PROFILE: "Prod Server" }, () => {
        assert.equal(activeProfile(), "default");
      });
    });

    it("applies SN_PROFILE_PROD_READONLY while the global SN_READONLY is unset", () => {
      withEnv({ ...PROD, SN_PROFILE_PROD_READONLY: "1" }, () => {
        reloadCredentialsFromEnv();
        assert.equal(process.env.SN_READONLY, undefined);
        assert.equal(isReadOnly(), true);
        assertDenied(
          () => assertWriteAllowed("PATCH /api/now/table/incident/sys_id"),
          /is not permitted/,
        );
      });
    });

    it("scopes the table lists to the active profile as well", () => {
      withEnv(
        {
          ...PROD,
          SN_TABLES_ALLOW: "incident",
          SN_PROFILE_PROD_TABLES_ALLOW: "change_request",
        },
        () => {
          reloadCredentialsFromEnv();
          assert.deepEqual(getAllowedTables(), ["change_request"]);
          assert.equal(assertTableAllowed("change_request"), undefined);
          assertDenied(
            () => assertTableAllowed("incident"),
            /not permitted by SN_TABLES_ALLOW/,
          );
        },
      );
    });

    it("reads an unrecognised profile override as read-only (fail closed)", () => {
      // Delegated decision 2026-09-26: the scoped key follows the same rule as
      // the global one — only an explicit "off" spelling keeps writes on.
      withEnv(
        { ...PROD, SN_READONLY: "0", SN_PROFILE_PROD_READONLY: "enabled" },
        () => {
          reloadCredentialsFromEnv();
          assert.equal(isReadOnly(), true);
        },
      );
    });

    it("falls back to the global key when the profile has no override", () => {
      withEnv({ ...PROD, SN_READONLY: "1" }, () => {
        reloadCredentialsFromEnv();
        assert.equal(isReadOnly(), true);
      });
    });

    it("does NOT let an empty profile override disable a global deny", () => {
      // DEV-24 — an empty scoped value is an absent override, not a deliberate
      // "prod is writable": upstream returned "" here, so a blank line in an
      // env template silently handed the profile write access. A policy key
      // may only ever remove permission, so the global deny still wins.
      withEnv(
        { ...PROD, SN_READONLY: "1", SN_PROFILE_PROD_READONLY: "" },
        () => {
          reloadCredentialsFromEnv();
          assert.equal(isReadOnly(), true);
          assert.throws(() => assertWriteAllowed("POST /x"), ServiceNowError);
        },
      );
    });

    it("treats a whitespace-only profile override as absent too", () => {
      withEnv(
        {
          ...PROD,
          SN_TABLES_DENY: "sys_user",
          SN_PROFILE_PROD_TABLES_DENY: " ",
        },
        () => {
          reloadCredentialsFromEnv();
          assert.throws(() => assertTableAllowed("sys_user"), ServiceNowError);
        },
      );
    });

    it("steers the policy lookup even when the profile has no credentials", () => {
      // activeProfile() validates the NAME only — it never consults the
      // credential store — so an unconfigured profile still selects the
      // per-profile policy keys.
      withEnv(
        {
          ...NO_POLICY,
          SN_ACTIVE_PROFILE: "prod",
          SN_PROFILE_PROD_READONLY: "yes",
        },
        () => {
          reloadCredentialsFromEnv();
          assert.equal(hasCredentials("prod"), false);
          assert.equal(activeProfile(), "prod");
          assert.equal(isReadOnly(), true);
        },
      );
    });

    it("reads the default profile's keys when no profile is active", () => {
      withEnv(
        {
          ...NO_POLICY,
          SN_INSTANCE: "https://dev.service-now.com",
          SN_USER: "admin",
          SN_PASSWORD: "secret",
        },
        () => {
          reloadCredentialsFromEnv();
          assert.equal(activeProfile(), "default");
          assert.deepEqual(getCredentials(), {
            instance: "https://dev.service-now.com",
            user: "admin",
            password: "secret",
          });
          // A profile-scoped key cannot reach the default profile.
          assert.equal(isReadOnly(), false);
        },
      );
    });
  });
});
