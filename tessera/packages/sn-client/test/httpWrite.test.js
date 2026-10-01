// Contract tests for the two Tessera adaptations woven into the vendored
// transport (src/core/http.ts):
//   DEV-24 — the environment read-only gate is enforced at the transport
//            boundary, so a direct snRequest caller cannot bypass it.
//   DEV-15 — every applied mutation is journalled (DF-2). Upstream journalled
//            at the MCP tools layer, which is not vendored, so this behaviour
//            has no upstream test to port and is guarded here instead.
// The network is stubbed at globalThis.fetch; nothing here reaches an instance.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  snRequest,
  ServiceNowError,
  reloadCredentialsFromEnv,
  setLogSink,
  atfApi,
  tableApi,
  assertTableWritable,
  NEVER_WRITE_TABLES,
} from "../build/index.js";

/** Env keys every test in this file is allowed to touch. */
const OWNED_ENV = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_DOCS_DIR",
  "SN_READONLY",
  "SN_MAX_RETRIES",
  "SN_LOG_LEVEL",
  "SN_ACTIVE_PROFILE",
  "SN_AUTH_MODE",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
];

let saved;
let docsDir;
let calls;
let originalFetch;

/** A JSON response the transport parses exactly like a real instance reply. */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Record every request and answer each with the same canned payload. */
function stubFetch(
  response = () => jsonResponse({ result: { sys_id: "s1" } }),
) {
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(response(url, init));
  };
}

/** The journal lines written for the active profile, parsed. */
function journalEntries(profile = "default") {
  const file = path.join(docsDir, profile, "write-journal.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  saved = Object.fromEntries(OWNED_ENV.map((key) => [key, process.env[key]]));
  docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-journal-"));
  calls = [];
  originalFetch = globalThis.fetch;

  process.env.SN_INSTANCE = "dev00001.service-now.com";
  process.env.SN_USER = "admin";
  process.env.SN_PASSWORD = "secret";
  process.env.SN_DOCS_DIR = docsDir;
  process.env.SN_MAX_RETRIES = "0";
  // Keep the suite's stderr clean; individual tests raise this when they assert
  // on a log line.
  process.env.SN_LOG_LEVEL = "error";
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  delete process.env.SN_AUTH_MODE;
  delete process.env.SN_TABLES_ALLOW;
  delete process.env.SN_TABLES_DENY;
  reloadCredentialsFromEnv();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setLogSink(null);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  reloadCredentialsFromEnv();
  fs.rmSync(docsDir, { recursive: true, force: true });
});

describe("DEV-15 — write journal at the transport boundary", () => {
  it("journals a Table API insert as create, with the sent fields", async () => {
    stubFetch();
    await snRequest({
      method: "POST",
      path: "/api/now/table/incident",
      body: { short_description: "Printer on fire", urgency: "1" },
    });

    const entries = journalEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "create");
    assert.equal(entries[0].table, "incident");
    assert.equal(entries[0].profile, "default");
    assert.ok(entries[0].ts, "entry carries a timestamp");
    assert.deepEqual(Object.keys(entries[0].fields), [
      "short_description",
      "urgency",
    ]);
    assert.equal(entries[0].sys_id, undefined);
  });

  it("journals a PATCH as an update of the addressed record", async () => {
    stubFetch();
    await snRequest({
      method: "PATCH",
      path: "/api/now/table/incident/abc123",
      body: { state: "6" },
    });

    const [entry] = journalEntries();
    assert.equal(entry.action, "update");
    assert.equal(entry.table, "incident");
    assert.equal(entry.sys_id, "abc123");
    assert.deepEqual(entry.fields, { state: "6" });
  });

  it("journals a PUT as an update too", async () => {
    stubFetch();
    await snRequest({
      method: "PUT",
      path: "/api/now/table/sys_script/def456",
      body: { script: "gs.info('x');" },
    });

    const [entry] = journalEntries();
    assert.equal(entry.action, "update");
    assert.equal(entry.table, "sys_script");
    assert.equal(entry.sys_id, "def456");
  });

  it("journals a DELETE without a fields payload", async () => {
    // A real Table API delete answers 204 with no body at all.
    stubFetch(() => new Response(null, { status: 204 }));
    await snRequest({
      method: "DELETE",
      path: "/api/now/table/incident/abc123",
    });

    const [entry] = journalEntries();
    assert.equal(entry.action, "delete");
    assert.equal(entry.table, "incident");
    assert.equal(entry.sys_id, "abc123");
    assert.equal(entry.fields, undefined);
  });

  it("journals a non-Table mutating endpoint as execute, keyed by path, WITH what it sent", async () => {
    stubFetch();
    await snRequest({
      method: "POST",
      path: "/api/sn_cicd/app_repo/publish",
      body: { app_sys_id: "a1" },
    });

    const [entry] = journalEntries();
    assert.equal(entry.action, "execute");
    assert.equal(entry.table, "/api/sn_cicd/app_repo/publish");
    // The endpoint name alone is not an audit trail: the risk of this write is
    // *which* app it published, so the payload has to be in the entry.
    assert.deepEqual(entry.fields, { app_sys_id: "a1" });
    assert.equal(entry.payload_unknown, undefined);
  });

  it("journals the query arguments of a write that carries its payload there", async () => {
    // The real non-Table writes in this codebase (the CI/CD surface) send no
    // body at all - everything identifying the target is in the query string.
    // An entry without them records that something ran and nothing about what
    // it ran against.
    stubFetch(() =>
      jsonResponse({
        result: { status: "0", links: { progress: { id: "p1" } } },
      }),
    );
    await atfApi.runAtfSuite("suite-sys-id-42");

    const [entry] = journalEntries();
    assert.equal(entry.action, "execute");
    assert.equal(entry.table, "/api/sn_cicd/testsuite/run");
    assert.deepEqual(entry.params, { sys_id: "suite-sys-id-42" });
    assert.equal(entry.payload_unknown, undefined);
  });

  it("journals repeated query keys without losing any value", async () => {
    stubFetch();
    const params = new URLSearchParams();
    params.append("id", "a");
    params.append("id", "b");
    params.append("mode", "full");
    await snRequest({ method: "POST", path: "/api/x/run", params });

    const [entry] = journalEntries();
    assert.deepEqual(entry.params, { id: ["a", "b"], mode: "full" });
  });

  it("journals the query arguments of a Table API write too", async () => {
    stubFetch();
    await snRequest({
      method: "POST",
      path: "/api/now/table/incident",
      params: new URLSearchParams({ sysparm_input_display_value: "true" }),
      body: { short_description: "x" },
    });

    const [entry] = journalEntries();
    assert.equal(entry.table, "incident");
    assert.deepEqual(entry.fields, { short_description: "x" });
    assert.deepEqual(entry.params, { sysparm_input_display_value: "true" });
  });

  it("marks a payload it could not record instead of looking complete", async () => {
    // A pre-encoded rawBody cannot be enumerated as named values. The entry
    // must SAY the payload is missing; an entry that merely omits `fields` is
    // indistinguishable from a write that sent nothing.
    stubFetch();
    await snRequest({
      method: "POST",
      path: "/api/x/run",
      rawBody: "name=deploy&value=1",
      contentType: "application/x-www-form-urlencoded",
    });

    const [entry] = journalEntries();
    assert.equal(entry.payload_unknown, true);
    assert.equal(entry.fields, undefined);
  });

  it("marks a non-object JSON body as an unrecorded payload", async () => {
    stubFetch();
    await snRequest({
      method: "POST",
      path: "/api/x/run",
      body: [{ a: 1 }, { b: 2 }],
    });

    const [entry] = journalEntries();
    assert.equal(entry.payload_unknown, true);
    assert.equal(entry.fields, undefined);
  });

  it("does not claim an unknown payload for a write that sent none", async () => {
    // The flag must mean "we could not record it", not "there was nothing" -
    // otherwise a consumer cannot use it to tell the two apart.
    stubFetch(() => new Response(null, { status: 204 }));
    await snRequest({
      method: "DELETE",
      path: "/api/now/table/incident/abc123",
    });

    const [entry] = journalEntries();
    assert.equal(entry.payload_unknown, undefined);
  });

  it("does not journal reads", async () => {
    stubFetch(() => jsonResponse({ result: [] }));
    await snRequest({ method: "GET", path: "/api/now/table/incident" });

    assert.deepEqual(journalEntries(), []);
    assert.equal(
      fs.existsSync(path.join(docsDir, "default", "write-journal.jsonl")),
      false,
    );
  });

  it("does not journal a write the instance rejected", async () => {
    stubFetch(() => jsonResponse({ error: { message: "bad" } }, 400));
    await assert.rejects(
      snRequest({
        method: "POST",
        path: "/api/now/table/incident",
        body: { x: "1" },
      }),
      ServiceNowError,
    );

    assert.deepEqual(journalEntries(), []);
  });

  it("writes a human-readable markdown row alongside the jsonl line", async () => {
    stubFetch();
    await snRequest({
      method: "POST",
      path: "/api/now/table/incident",
      body: { short_description: "x" },
    });

    const md = fs.readFileSync(
      path.join(docsDir, "default", "write-journal.md"),
      "utf8",
    );
    assert.match(md, /\| create \| incident \| short_description \|/);
  });

  it("does not leave the markdown row silent for a query-only write", async () => {
    stubFetch();
    await snRequest({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
      params: new URLSearchParams({ sys_id: "s42" }),
    });

    const md = fs.readFileSync(
      path.join(docsDir, "default", "write-journal.md"),
      "utf8",
    );
    assert.match(md, /\?sys_id/);
    assert.doesNotMatch(
      md,
      /\| execute \| \/api\/sn_cicd\/testsuite\/run \| \u2014 \|/,
      "an em-dash payload column would read as a write that sent nothing",
    );
  });

  it("says so in the markdown row when the payload was not recordable", async () => {
    stubFetch();
    await snRequest({
      method: "POST",
      path: "/api/x/run",
      rawBody: "name=deploy",
      contentType: "application/x-www-form-urlencoded",
    });

    const md = fs.readFileSync(
      path.join(docsDir, "default", "write-journal.md"),
      "utf8",
    );
    assert.match(md, /\(payload not recorded\)/);
  });

  it("journals under the active profile's directory", async () => {
    process.env.SN_ACTIVE_PROFILE = "prod";
    process.env.SN_PROFILE_PROD_INSTANCE = "dev00002.service-now.com";
    process.env.SN_PROFILE_PROD_USER = "admin";
    process.env.SN_PROFILE_PROD_PASSWORD = "secret";
    reloadCredentialsFromEnv();
    try {
      stubFetch();
      await snRequest({
        method: "POST",
        path: "/api/now/table/incident",
        body: { short_description: "x" },
      });

      assert.deepEqual(journalEntries("default"), []);
      const [entry] = journalEntries("prod");
      assert.equal(entry.profile, "prod");
      assert.equal(entry.action, "create");
    } finally {
      delete process.env.SN_PROFILE_PROD_INSTANCE;
      delete process.env.SN_PROFILE_PROD_USER;
      delete process.env.SN_PROFILE_PROD_PASSWORD;
    }
  });

  it("never turns a successful write into an error when journalling fails", async () => {
    // Point the docs dir at a path under an existing *file*, so mkdirSync fails.
    const blocker = path.join(docsDir, "not-a-directory");
    fs.writeFileSync(blocker, "");
    process.env.SN_DOCS_DIR = path.join(blocker, "nested");
    process.env.SN_LOG_LEVEL = "warn";
    const warnings = [];
    setLogSink((level, message) => warnings.push(`${level}:${message}`));

    stubFetch();
    const res = await snRequest({
      method: "POST",
      path: "/api/now/table/incident",
      body: { short_description: "x" },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { result: { sys_id: "s1" } });
    assert.ok(
      warnings.some((w) => w === "warn:write-journal append failed"),
      `expected a journal warning, got ${JSON.stringify(warnings)}`,
    );
  });
});

describe("DEV-24 — read-only gate at the transport boundary", () => {
  it("refuses every mutating method with an explicit 403, before any request", async () => {
    process.env.SN_READONLY = "1";
    stubFetch();

    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      await assert.rejects(
        snRequest({ method, path: "/api/now/table/incident", body: {} }),
        (error) => {
          assert.ok(error instanceof ServiceNowError);
          assert.equal(error.status, 403);
          assert.match(error.message, /read-only mode \(SN_READONLY\)/);
          assert.match(
            error.message,
            new RegExp(`${method} /api/now/table/incident`),
          );
          return true;
        },
      );
    }

    assert.equal(calls.length, 0, "no request may leave the process");
    assert.deepEqual(journalEntries(), []);
  });

  it("still allows reads while read-only", async () => {
    process.env.SN_READONLY = "1";
    stubFetch(() => jsonResponse({ result: [] }));

    const res = await snRequest({
      method: "GET",
      path: "/api/now/table/incident",
    });

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  });

  it("is checked before credentials, so a denial is never masked", async () => {
    process.env.SN_READONLY = "true";
    delete process.env.SN_INSTANCE;
    reloadCredentialsFromEnv();
    stubFetch();

    await assert.rejects(
      snRequest({ method: "POST", path: "/api/now/table/incident", body: {} }),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /read-only mode/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  // Delegated decision 2026-09-26 (review-w5a method1.mjs repro): an
  // unrecognised truthy spelling used to leave writes on. It must refuse at the
  // transport exactly like "1", before any request leaves the process.
  it("refuses a write for an unrecognised SN_READONLY value (fail closed)", async () => {
    for (const value of ["y", "enabled", "2", "TRUE ", "Yes"]) {
      process.env.SN_READONLY = value;
      stubFetch();
      await assert.rejects(
        snRequest({
          method: "POST",
          path: "/api/now/table/incident",
          body: {},
        }),
        (error) => {
          assert.ok(error instanceof ServiceNowError);
          assert.equal(error.status, 403, `SN_READONLY=${value} must gate`);
          assert.match(error.message, /read-only mode \(SN_READONLY\)/);
          return true;
        },
      );
    }
    assert.equal(calls.length, 0, "no request may leave the process");
    assert.deepEqual(journalEntries(), []);
  });

  it("does not gate writes when the flag is falsy", async () => {
    for (const value of ["0", "false", "no", ""]) {
      process.env.SN_READONLY = value;
      stubFetch();
      const res = await snRequest({
        method: "POST",
        path: "/api/now/table/incident",
        body: { short_description: "x" },
      });
      assert.equal(res.status, 200, `SN_READONLY=${value} must not gate`);
    }
    assert.equal(calls.length, 4);
    assert.equal(journalEntries().length, 4);
  });
});

describe("table policy coverage at the transport boundary", () => {
  it("refuses a denied table's write at the transport, before any request", async () => {
    // assertTableAllowed is applied by the api layer; a caller reaching the
    // transport directly must not thereby escape the operator's denylist.
    process.env.SN_TABLES_DENY = "sys_user";
    stubFetch();

    await assert.rejects(
      snRequest({
        method: "POST",
        path: "/api/now/table/sys_user",
        body: { user_name: "x" },
      }),
      (error) => {
        assert.ok(error instanceof ServiceNowError);
        assert.equal(error.status, 403);
        assert.match(error.message, /SN_TABLES_DENY/);
        return true;
      },
    );

    assert.equal(calls.length, 0, "no request may leave the process");
    assert.deepEqual(journalEntries(), []);
  });

  it("refuses a write to a table outside the allowlist", async () => {
    process.env.SN_TABLES_ALLOW = "incident";
    stubFetch();

    await assert.rejects(
      snRequest({
        method: "POST",
        path: "/api/now/table/sys_user",
        body: { user_name: "x" },
      }),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /SN_TABLES_ALLOW/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it("lets an allowlisted table's write through", async () => {
    process.env.SN_TABLES_ALLOW = "incident";
    stubFetch();

    const res = await snRequest({
      method: "POST",
      path: "/api/now/table/incident",
      body: { short_description: "x" },
    });

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  });

  it("refuses a write that names no table while an allowlist is set", async () => {
    // "Only these tables are reachable" is a positive claim. A write that
    // reaches no nameable table cannot be shown to satisfy it, so letting it
    // through would make setting an allowlist widen what a caller may do.
    process.env.SN_TABLES_ALLOW = "incident";
    stubFetch();

    await assert.rejects(
      snRequest({
        method: "POST",
        path: "/api/sn_cicd/testsuite/run",
        params: new URLSearchParams({ sys_id: "s1" }),
      }),
      (error) => {
        assert.ok(error instanceof ServiceNowError);
        assert.equal(error.status, 403);
        assert.match(error.message, /SN_TABLES_ALLOW/);
        assert.match(error.message, /\/api\/sn_cicd\/testsuite\/run/);
        return true;
      },
    );

    assert.equal(calls.length, 0);
    assert.deepEqual(journalEntries(), []);
  });

  it("warns, rather than silently proceeding, when only a denylist is set and the write names no table", async () => {
    // A denylist is a claim about named tables, so this write is not denied by
    // it - but the operator must be able to notice that their table policy
    // cannot reach this surface at all.
    process.env.SN_TABLES_DENY = "sys_user";
    process.env.SN_LOG_LEVEL = "warn";
    const logged = [];
    setLogSink((level, message, fields) =>
      logged.push({ level, message, fields }),
    );
    stubFetch();

    const res = await snRequest({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
      params: new URLSearchParams({ sys_id: "s1" }),
    });

    assert.equal(res.status, 200, "the write is not denied");
    const warning = logged.find(
      (entry) => entry.level === "warn" && /names no table/.test(entry.message),
    );
    assert.ok(
      warning,
      `expected an uncovered-write warning, got ${JSON.stringify(logged)}`,
    );
    assert.equal(warning.fields.operation, "POST /api/sn_cicd/testsuite/run");
  });

  it("never puts the query string into the warning", async () => {
    // An encoded query can carry personal data; the log stream is not the
    // journal and must not become a second copy of the payload.
    process.env.SN_TABLES_DENY = "sys_user";
    process.env.SN_LOG_LEVEL = "warn";
    const logged = [];
    setLogSink((level, message, fields) =>
      logged.push({ level, message, fields }),
    );
    stubFetch();

    await snRequest({
      method: "POST",
      path: "/api/x/run",
      params: new URLSearchParams({ email: "someone@example.com" }),
    });

    const serialised = JSON.stringify(logged);
    assert.doesNotMatch(serialised, /someone@example\.com/);
  });

  it("says nothing when no table policy is configured", async () => {
    process.env.SN_LOG_LEVEL = "warn";
    const logged = [];
    setLogSink((level, message) => logged.push(`${level}:${message}`));
    stubFetch();

    await snRequest({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
      params: new URLSearchParams({ sys_id: "s1" }),
    });

    assert.deepEqual(
      logged.filter((line) => /names no table/.test(line)),
      [],
      "no policy means no claim to warn about",
    );
  });

  it("does NOT gate reads at the transport, so a client 403 is never mistaken for the instance's", async () => {
    // doctor and parity read through this transport precisely so a
    // client-fabricated denial can never be attributed to the instance
    // (DEV-1). Pushing the read gate down here would take that away from them.
    process.env.SN_TABLES_DENY = "sys_user";
    process.env.SN_TABLES_ALLOW = "incident";
    stubFetch(() => jsonResponse({ result: [] }));

    const res = await snRequest({
      method: "GET",
      path: "/api/now/table/sys_user",
    });

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, "the read must reach the instance");
  });

  it("matches the policy against the decoded table name", async () => {
    // The table segment is percent-encoded into the path; comparing the raw
    // segment against the operator's list would let encoding slip a denied
    // table through.
    process.env.SN_TABLES_DENY = "sys user";
    stubFetch();

    await assert.rejects(
      snRequest({
        method: "POST",
        path: `/api/now/table/${encodeURIComponent("sys user")}`,
        body: {},
      }),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /SN_TABLES_DENY/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });
});

describe("built-in never-write list at the transport boundary (ADR-007 C6)", () => {
  // Delegated decision 2026-09-23. sys_user_has_role is the role-grant table:
  // were it writable, Tessera could grant itself the role that authorises its
  // own writes. The list is a constant, not an env var, so no operator setting
  // can empty it or re-admit the table.
  it("carries sys_user_has_role and cannot be mutated at runtime", () => {
    assert.ok(NEVER_WRITE_TABLES.includes("sys_user_has_role"));
    assert.ok(Object.isFrozen(NEVER_WRITE_TABLES));
  });

  it("refuses every write method, even with SN_TABLES_ALLOW naming the table", async () => {
    process.env.SN_TABLES_ALLOW = "sys_user_has_role,incident";
    stubFetch();

    for (const [method, tablePath] of [
      ["POST", "/api/now/table/sys_user_has_role"],
      ["PATCH", "/api/now/table/sys_user_has_role/abc"],
      ["PUT", "/api/now/table/sys_user_has_role/abc"],
      ["DELETE", "/api/now/table/sys_user_has_role/abc"],
      ["POST", `/api/now/table/${encodeURIComponent("SYS_USER_HAS_ROLE")}`],
    ]) {
      await assert.rejects(
        snRequest({ method, path: tablePath, body: {} }),
        (error) => {
          assert.ok(error instanceof ServiceNowError);
          assert.equal(error.status, 403);
          assert.match(error.message, /never-write list/);
          assert.match(error.message, /ADR-007 C6/);
          return true;
        },
        `${method} ${tablePath}`,
      );
    }
    assert.equal(calls.length, 0, "no request may leave the process");
    assert.deepEqual(journalEntries(), []);
  });

  it("refuses the api-layer create even though the allowlist admits it there", async () => {
    // tableApi.createRecord runs assertTableAllowed first, which the allowlist
    // satisfies; the transport's never-write check must still stop it.
    process.env.SN_TABLES_ALLOW = "sys_user_has_role";
    stubFetch();

    await assert.rejects(
      tableApi.createRecord("sys_user_has_role", { user: "u", role: "r" }),
      (error) => error.status === 403 && /never-write/.test(error.message),
    );
    assert.equal(calls.length, 0);
  });

  it("leaves reads of the table alone, so role membership can be verified", async () => {
    stubFetch(() => jsonResponse({ result: [] }));
    const res = await snRequest({
      method: "GET",
      path: "/api/now/table/sys_user_has_role",
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  });

  it("does not touch other tables", async () => {
    assert.equal(assertTableWritable("sys_user", "POST x"), undefined);
    assert.equal(assertTableWritable("sys_user_role", "POST x"), undefined);
    assert.throws(
      () => assertTableWritable("  Sys_User_Has_Role ", "POST x"),
      ServiceNowError,
    );
  });
});

describe("SN_TABLES_ALLOW and the ATF run surface (delegated decision 2026-09-23, option a)", () => {
  // Ratified consequence, pinned so it cannot change silently: with a table
  // allowlist set, the CI/CD test-run POST names no table and is refused with
  // a 403 before any request. An operator who sets SN_TABLES_ALLOW has asked
  // for "only these tables", and a run endpoint cannot be shown to satisfy it.
  it("refuses runAtfSuite with a 403 while an allowlist is set", async () => {
    process.env.SN_TABLES_ALLOW = "incident";
    stubFetch();

    await assert.rejects(atfApi.runAtfSuite("suite-1"), (error) => {
      assert.ok(error instanceof ServiceNowError);
      assert.equal(error.status, 403);
      assert.match(error.message, /SN_TABLES_ALLOW/);
      return true;
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(journalEntries(), []);
  });
});
