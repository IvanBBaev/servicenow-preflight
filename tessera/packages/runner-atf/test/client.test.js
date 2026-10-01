// The transport seam.
//
// Two things are worth pinning here and nothing else is.
//
// The first is `fieldString`. Everything downstream — the progress parser, the
// result parser — reads instance rows through it, so its degradation rules ARE
// the adapter's tolerance for a differently-configured instance. A reference
// field that arrives as `{ value, display_value }` instead of a string must not
// become the literal text `[object Object]` in a checklist row.
//
// The second is where the DEV-1 error boundary sits. `createSnAtfClient` is the
// far side of the transport port and stays a pass-through: `snRequest` raises
// `ServiceNowError` for any non-2xx and the client hands that straight on. The
// normalisation into `AtfInfrastructureError` happens on the RUNNER's side of
// the port, in `requestOrFault`, so it holds for every client that gets bound
// rather than only for this one — and so the suites keep a transport that
// throws a genuinely foreign type to test the normalisation against. Both
// halves are asserted below; a client that renamed its own errors would make
// the second half unfalsifiable.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { ServiceNowError, reloadCredentialsFromEnv } from "@tessera/sn-client";

import {
  AtfInfrastructureError,
  asRecord,
  createSnAtfClient,
  fieldString,
  requestOrFault,
  toInfrastructureError,
  unwrapResult,
} from "../build/index.js";

const HOST = "dev-runner-atf.service-now.com";

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
];

/**
 * Put a fake instance behind the real transport. `install()` swaps
 * `globalThis.fetch`, which is contained because `node --test` gives each test
 * file its own process; the env is still saved and restored so a stray
 * `SN_*` in the developer's shell cannot decide the outcome.
 *
 * `SN_DOCS_DIR` is staged for one more reason than the rest. The vendored
 * transport journals every applied write (DEV-15), and `getDocsDir()` falls
 * back to `docs/instance` relative to the CURRENT WORKING DIRECTORY. Unset,
 * the POST below therefore appends a row to `runner-atf/docs/instance/` in the
 * source tree on every run of this file — fixture traffic accumulating in the
 * one audit surface that has no external cross-check, in a row format with no
 * field that could mark it as synthetic. Pointing it at a fresh temp directory
 * is what every other suite that drives this transport already does
 * (`sn-client/test/httpWrite.test.js`, `cli/test/*.test.js`). Containment is
 * asserted from the outside in `journal-containment.test.js`.
 */
function liveHarness(state) {
  const instance = createFakeInstance(state === undefined ? {} : { state });
  const uninstall = instance.install();
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  const docsDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "tessera-runner-atf-journal-"),
  );
  process.env.SN_INSTANCE = HOST;
  process.env.SN_USER = "tessera";
  process.env.SN_PASSWORD = "tessera";
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = docsDir;
  // A retry would paper over a single-fire fault and turn a 500 into a hang.
  process.env.SN_MAX_RETRIES = "0";
  reloadCredentialsFromEnv();
  return {
    instance,
    docsDir,
    restore() {
      uninstall();
      fs.rmSync(docsDir, { recursive: true, force: true });
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

describe("asRecord", () => {
  it("accepts a plain object", () => {
    assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
  });

  it("rejects null, arrays and primitives — each of which `typeof` calls an object or would coerce", () => {
    for (const value of [null, undefined, [1, 2], "x", 7, true]) {
      assert.equal(asRecord(value), undefined, JSON.stringify(value ?? null));
    }
  });
});

describe("unwrapResult", () => {
  it("returns the `result` member of the ServiceNow envelope", () => {
    assert.deepEqual(unwrapResult({ result: [1, 2] }), [1, 2]);
    assert.deepEqual(unwrapResult({ result: { id: "x" } }), { id: "x" });
  });

  it("returns undefined — never throws — for a body that is not an envelope", () => {
    assert.equal(unwrapResult(undefined), undefined);
    assert.equal(unwrapResult("<html>login</html>"), undefined);
    assert.equal(unwrapResult([{ result: 1 }]), undefined);
  });

  it("returns undefined for an envelope with no `result`, e.g. an error body", () => {
    assert.equal(unwrapResult({ error: { message: "no" } }), undefined);
  });
});

describe("fieldString", () => {
  it("passes a string through", () => {
    assert.equal(fieldString({ a: "x" }, "a"), "x");
  });

  it("stringifies numbers and booleans, which display_value=false should not produce but might", () => {
    assert.equal(fieldString({ a: 42 }, "a"), "42");
    assert.equal(fieldString({ a: 0 }, "a"), "0");
    assert.equal(fieldString({ a: false }, "a"), "false");
  });

  it("unwraps the `{ value, display_value }` reference shape", () => {
    assert.equal(
      fieldString({ a: { value: "sys", display_value: "Name" } }, "a"),
      "sys",
    );
  });

  it('degrades to "" rather than "[object Object]" for anything else', () => {
    assert.equal(fieldString({}, "missing"), "");
    assert.equal(fieldString({ a: null }, "a"), "");
    assert.equal(fieldString({ a: { value: 7 } }, "a"), "");
    assert.equal(fieldString({ a: ["x"] }, "a"), "");
  });
});

describe("AtfInfrastructureError", () => {
  it("carries its own name, so a caller can tell an adapter fault from a bug", () => {
    const error = new AtfInfrastructureError("nope");
    assert.equal(error.name, "AtfInfrastructureError");
    assert.ok(error instanceof Error);
    assert.equal(error.message, "nope");
  });

  it("keeps the underlying failure as `cause` instead of flattening it to text", () => {
    const cause = new TypeError("socket hang up");
    assert.equal(new AtfInfrastructureError("wrapped", { cause }).cause, cause);
  });

  it("carries `status` as a declared property, undefined when there was no response", () => {
    // Declared, not conditionally attached: `"status" in error` must never be
    // the classification test, because a socket error legitimately has none.
    assert.equal(new AtfInfrastructureError("x").status, undefined);
    assert.equal(new AtfInfrastructureError("x", { status: 429 }).status, 429);
  });
});

describe("toInfrastructureError", () => {
  it("wraps a foreign transport error, lifting status and keeping the original", () => {
    const original = new ServiceNowError(
      "ServiceNow API error (403): nope",
      403,
      {
        error: { message: "User Not Authorized" },
      },
    );
    const fault = toInfrastructureError("POST /x (trigger)", original);
    assert.equal(fault.name, "AtfInfrastructureError");
    assert.equal(fault.status, 403);
    assert.equal(fault.cause, original, "the same object, not a copy");
    assert.deepEqual(fault.cause.detail, {
      error: { message: "User Not Authorized" },
    });
    // The instance's own text is quoted, because `core` flattens a rejection to
    // `${name}: ${message}` for the report and a 403's "why" has to survive it.
    assert.equal(
      fault.message,
      "POST /x (trigger) (HTTP 403) failed: ServiceNowError: ServiceNow API error (403): nope",
    );
  });

  it("omits the status when the failure never got a response", () => {
    const fault = toInfrastructureError("GET /y", new Error("ECONNRESET"));
    assert.equal(fault.status, undefined);
    assert.equal(fault.message, "GET /y failed: Error: ECONNRESET");
  });

  it("ignores a non-numeric `status` rather than putting junk on the fault", () => {
    const weird = Object.assign(new Error("odd"), { status: "403" });
    assert.equal(toInfrastructureError("GET /y", weird).status, undefined);
  });

  it("is idempotent — an existing fault passes through with its message intact", () => {
    // Double-wrapping would bury the specific message ("carried no progress
    // id") under a generic one and nest `cause` a level deeper each hop.
    const inner = new AtfInfrastructureError("carried no progress id");
    assert.equal(toInfrastructureError("GET /y", inner), inner);
  });

  it("survives a thrown non-Error without producing `[object Object]`", () => {
    assert.equal(
      toInfrastructureError("GET /y", "kaboom").message,
      "GET /y failed: kaboom",
    );
    assert.match(
      toInfrastructureError("GET /y", { status: 502 }).message,
      /\(HTTP 502\) failed: \[object Object\]/,
    );
  });
});

describe("requestOrFault", () => {
  it("passes a successful response through untouched", async () => {
    const response = { data: { result: 1 }, status: 200, total: 7 };
    const client = { request: () => Promise.resolve(response) };
    assert.equal(
      await requestOrFault(client, { method: "GET", path: "/x" }, "GET /x"),
      response,
    );
  });

  it("normalises a rejection from any bound client, not just the ServiceNow one", async () => {
    // The port declares no error type and TypeScript cannot make it. This is
    // why the wrap lives on the runner's side of it rather than inside
    // `createSnAtfClient`: it holds for whatever gets bound.
    const boom = new Error("some other transport");
    const client = { request: () => Promise.reject(boom) };
    await assert.rejects(
      requestOrFault(client, { method: "GET", path: "/x" }, "GET /x"),
      (error) => {
        assert.ok(error instanceof AtfInfrastructureError);
        assert.equal(error.cause, boom);
        return true;
      },
    );
  });

  it("catches a SYNCHRONOUS throw too — a client need not be well-behaved", async () => {
    const client = {
      request() {
        throw new Error("threw before returning a promise");
      },
    };
    await assert.rejects(
      requestOrFault(client, { method: "GET", path: "/x" }, "GET /x"),
      (error) => {
        assert.ok(error instanceof AtfInfrastructureError);
        return true;
      },
    );
  });
});

describe("createSnAtfClient", () => {
  it("issues the request and returns the raw envelope plus X-Total-Count", async () => {
    const h = liveHarness({
      sys_atf_test_result: [
        { sys_id: "a".repeat(32), test: "b".repeat(32), status: "success" },
      ],
    });
    try {
      const response = await createSnAtfClient().request({
        method: "GET",
        path: "/api/now/table/sys_atf_test_result",
        params: new URLSearchParams({ sysparm_fields: "sys_id,status" }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.total, 1);
      // `data` is the RAW body — the parsers do their own unwrapping.
      assert.deepEqual(Object.keys(response.data), ["result"]);
      assert.deepEqual(response.data.result, [
        { sys_id: "a".repeat(32), status: "success" },
      ]);
      assert.equal(h.instance.requests().length, 1);
    } finally {
      h.restore();
    }
  });

  it("lets a POST through — the DEV-24 write gate is off by default", async () => {
    const h = liveHarness();
    try {
      const response = await createSnAtfClient().request({
        method: "POST",
        path: "/api/sn_cicd/testsuite/run",
        params: new URLSearchParams({ sys_id: "c".repeat(32) }),
      });
      assert.equal(response.status, 200);
      assert.ok(response.data.result.links.progress.id);

      // The POST is an applied write, so DEV-15 journals it. Assert the row
      // exists AND that it landed in the staged directory: this is the
      // positive control for `journal-containment.test.js`, which would
      // otherwise pass just as happily if nothing here journalled at all.
      const journal = path.join(h.docsDir, "default", "write-journal.jsonl");
      const rows = fs
        .readFileSync(journal, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, "execute");
      assert.equal(rows[0].table, "/api/sn_cicd/testsuite/run");
    } finally {
      h.restore();
    }
  });

  it("propagates the transport's own error type — the port, not the client, normalises", async () => {
    const h = liveHarness();
    try {
      h.instance.faults.add({
        match: { path: "/api/now/table/" },
        mode: { kind: "http-error", status: 503 },
      });
      await assert.rejects(
        createSnAtfClient().request({
          method: "GET",
          path: "/api/now/table/sys_atf_test_result",
        }),
        (error) => {
          assert.equal(error.name, "ServiceNowError");
          assert.equal(error.status, 503);
          assert.equal(error instanceof AtfInfrastructureError, false);
          return true;
        },
      );
    } finally {
      h.restore();
    }
  });
});
