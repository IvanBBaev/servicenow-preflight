// Contract tests for the vendored ServiceNow client (@tessera/sn-client): the
// host resolver and its SSRF policy, the shared response-envelope helpers, and
// the Table API read path exercised over a stubbed global `fetch`. Upstream
// (servicenow-mcp) covers these in TypeScript suites that are not vendored, so
// the behaviour Tessera depends on is pinned here instead.
//
// The two Tessera adaptations woven into the transport — the DEV-15 write
// journal and the DEV-24 read-only gate — belong to test/httpWrite.test.js and
// are deliberately not re-tested here; every request below is a GET.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveHost,
  resolveHostWithPolicy,
  instanceBaseUrl,
  reloadCredentialsFromEnv,
  ServiceNowError,
  sharedApi,
  tableApi,
} from "../build/index.js";

// Every SN_* key is cleared per test and restored afterwards, so whatever the
// developer's real environment holds (a live PDI in .env, an API key, an active
// profile, a host allowlist) cannot change what these assertions measure.
let savedEnv = {};

function clearSnEnv() {
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SN_")) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
}

function restoreSnEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SN_")) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  reloadCredentialsFromEnv();
}

describe("host resolution (core/host.ts)", () => {
  beforeEach(clearSnEnv);
  afterEach(restoreSnEnv);

  describe("resolveHost — normalisation", () => {
    // Every accepted shape and the host it collapses to. Spelled out as literals
    // rather than derived from the module, so the table still measures something
    // when the normalisation changes underneath it.
    const accepted = [
      ["bare instance name", "dev12345", "dev12345.service-now.com"],
      ["bare name with a hyphen", "dev-123", "dev-123.service-now.com"],
      ["surrounding whitespace", "  dev12345  ", "dev12345.service-now.com"],
      [
        "fully qualified host",
        "dev12345.service-now.com",
        "dev12345.service-now.com",
      ],
      [
        "full https URL with a path and query",
        "https://dev12345.service-now.com/nav_to.do?uri=incident.do",
        "dev12345.service-now.com",
      ],
      [
        "trailing slash",
        "dev12345.service-now.com/",
        "dev12345.service-now.com",
      ],
      [
        "explicit port (dropped)",
        "dev12345.service-now.com:8443",
        "dev12345.service-now.com",
      ],
      // http:// is stripped like https:// and the request is then made over
      // https by instanceBaseUrl — a plain-http instance value is upgraded,
      // never honoured as cleartext.
      [
        "http:// scheme (stripped, not rejected)",
        "http://dev12345.service-now.com",
        "dev12345.service-now.com",
      ],
    ];
    for (const [label, input, expected] of accepted) {
      it(`accepts ${label}`, () => {
        assert.equal(resolveHost(input), expected);
      });
    }

    it("returns the host with its original casing (matching is case-insensitive)", () => {
      // The SSRF and canonical-suffix checks lowercase internally, but the
      // returned value is the caller's spelling — asserted because the URL the
      // transport builds is this string verbatim.
      assert.equal(
        resolveHost("DEV12345.SERVICE-NOW.COM"),
        "DEV12345.SERVICE-NOW.COM",
      );
    });

    it("builds the instance origin over https", () => {
      assert.equal(
        instanceBaseUrl("dev12345"),
        "https://dev12345.service-now.com",
      );
    });

    it("applies the same guard when building the origin", () => {
      assert.throws(() => instanceBaseUrl("127.0.0.1"), ServiceNowError);
    });
  });

  describe("resolveHost — SSRF policy", () => {
    // Every rejected shape with the exact reason the source gives. The message
    // is asserted (not just the throw) because the three rules — blocked host,
    // malformed host, non-canonical domain — are separate guards that a change
    // could silently swap.
    const rejected = [
      // Loopback / link-local / RFC1918, matched as literal IPv4 addresses.
      [
        "IPv4 loopback",
        "127.0.0.1",
        'Refusing to connect to internal/loopback host "127.0.0.1". Set SN_ALLOWED_HOSTS to override.',
      ],
      [
        "0.0.0.0",
        "0.0.0.0",
        'Refusing to connect to internal/loopback host "0.0.0.0". Set SN_ALLOWED_HOSTS to override.',
      ],
      [
        "10/8 private range",
        "10.1.2.3",
        'Refusing to connect to internal/loopback host "10.1.2.3". Set SN_ALLOWED_HOSTS to override.',
      ],
      [
        "192.168/16 private range",
        "192.168.0.5",
        'Refusing to connect to internal/loopback host "192.168.0.5". Set SN_ALLOWED_HOSTS to override.',
      ],
      [
        "172.16/12 private range",
        "172.16.0.1",
        'Refusing to connect to internal/loopback host "172.16.0.1". Set SN_ALLOWED_HOSTS to override.',
      ],
      [
        "169.254/16 link-local (cloud metadata)",
        "http://169.254.169.254/latest/meta-data/",
        'Refusing to connect to internal/loopback host "169.254.169.254". Set SN_ALLOWED_HOSTS to override.',
      ],
      // Internal-name suffixes.
      [
        "a *.localhost name",
        "foo.localhost",
        'Refusing to connect to internal/loopback host "foo.localhost". Set SN_ALLOWED_HOSTS to override.',
      ],
      [
        "a *.local name",
        "box.local",
        'Refusing to connect to internal/loopback host "box.local". Set SN_ALLOWED_HOSTS to override.',
      ],
      [
        "a *.internal name",
        "box.internal",
        'Refusing to connect to internal/loopback host "box.internal". Set SN_ALLOWED_HOSTS to override.',
      ],
      // Userinfo: rejected before the host is even normalised, so credentials
      // can never be mailed to the part after the "@".
      [
        "embedded credentials",
        "user:pw@evil.example",
        "Invalid ServiceNow instance: embedded credentials are not allowed.",
      ],
      [
        "a canonical-looking name used as userinfo",
        "dev12345.service-now.com@evil.example",
        "Invalid ServiceNow instance: embedded credentials are not allowed.",
      ],
      // Anything that is not http(s) keeps its scheme text in the host, which
      // then fails the character class — the rejection is real, but it is the
      // malformed-host guard that catches it, not a scheme check.
      [
        "a non-https scheme",
        "ftp://evil.example",
        'Invalid ServiceNow host: "ftp:.service-now.com".',
      ],
      [
        "IPv6 loopback (port strip leaves a bare colon)",
        "::1",
        'Invalid ServiceNow host: ":.service-now.com".',
      ],
      // Malformed hosts.
      [
        "a leading dash",
        "-dev.service-now.com",
        'Invalid ServiceNow host: "-dev.service-now.com".',
      ],
      [
        "an empty label",
        "a..b.service-now.com",
        'Invalid ServiceNow host: "a..b.service-now.com".',
      ],
      ["an empty value", "", "ServiceNow instance is empty or invalid."],
      [
        "a scheme-relative URL (nothing before the first slash)",
        "//evil.example",
        "ServiceNow instance is empty or invalid.",
      ],
      // Anything outside the canonical domain needs an explicit opt-in.
      [
        "a host outside *.service-now.com",
        "https://evil.example",
        'Host "evil.example" is not a *.service-now.com instance. Set SN_ALLOWED_HOSTS to allow a custom or sovereign-cloud domain.',
      ],
      [
        "a fragment used to smuggle a canonical host",
        "evil.example#@dev12345.service-now.com",
        'Host "evil.example" is not a *.service-now.com instance. Set SN_ALLOWED_HOSTS to allow a custom or sovereign-cloud domain.',
      ],
    ];
    for (const [label, input, message] of rejected) {
      it(`rejects ${label}`, () => {
        assert.throws(() => resolveHost(input), {
          name: "ServiceNowError",
          message,
        });
      });
    }

    it("turns the bare name 'localhost' into a canonical instance instead of rejecting it", () => {
      // Documented deviation from the obvious expectation: a dot-less value is a
      // ServiceNow *instance name*, so the canonical suffix is appended before
      // any host check runs. The result is a public *.service-now.com name, so
      // nothing internal is reachable — but no error is raised either.
      assert.equal(resolveHost("localhost"), "localhost.service-now.com");
      assert.equal(
        resolveHost("http://localhost:8080"),
        "localhost.service-now.com",
      );
    });

    it("permits an otherwise blocked host when SN_ALLOWED_HOSTS lists it", () => {
      process.env.SN_ALLOWED_HOSTS = "127.0.0.1, my.corp.example";
      assert.equal(resolveHost("127.0.0.1"), "127.0.0.1");
      // Allowlist entries match the host itself or any subdomain of it.
      assert.equal(
        resolveHost("https://sn.my.corp.example/api"),
        "sn.my.corp.example",
      );
    });

    it("makes SN_ALLOWED_HOSTS exclusive — a canonical host not on the list is refused", () => {
      // The allowlist replaces the default policy rather than extending it, so
      // configuring one is not a way to accidentally widen access.
      process.env.SN_ALLOWED_HOSTS = "my.corp.example";
      assert.throws(() => resolveHost("dev12345"), {
        name: "ServiceNowError",
        message:
          'Host "dev12345.service-now.com" is not permitted by SN_ALLOWED_HOSTS.',
      });
    });
  });

  describe("resolveHostWithPolicy — the shared algorithm", () => {
    // resolveHost is a thin wrapper over this; a second system (Jira upstream)
    // supplies its own suffix, env var and error type through the same code.
    class OtherSystemError extends Error {}
    const policy = {
      subject: "Test site",
      system: "Test",
      canonicalSuffix: ".example.net",
      allowedHostsEnv: "SN_TEST_ALLOWED_HOSTS",
      nonCanonicalError: (host) =>
        `Host "${host}" is not a *.example.net site.`,
      makeError: (message) => new OtherSystemError(message),
    };

    it("appends the policy's canonical suffix to a bare name", () => {
      assert.equal(resolveHostWithPolicy("acme", policy), "acme.example.net");
    });

    it("enforces the same SSRF rules through the policy's own error type", () => {
      assert.throws(() => resolveHostWithPolicy("127.0.0.1", policy), {
        name: "Error",
        message:
          'Refusing to connect to internal/loopback host "127.0.0.1". Set SN_TEST_ALLOWED_HOSTS to override.',
      });
      assert.throws(
        () => resolveHostWithPolicy("acme.example.org", policy),
        OtherSystemError,
      );
    });

    it("reads the allowlist from the policy's own env var", () => {
      process.env.SN_TEST_ALLOWED_HOSTS = "acme.example.org";
      assert.equal(
        resolveHostWithPolicy("https://acme.example.org/x", policy),
        "acme.example.org",
      );
    });
  });
});

describe("shared response helpers (api/shared.ts)", () => {
  describe("expectResult", () => {
    it("unwraps the ServiceNow result envelope", () => {
      assert.deepEqual(
        sharedApi.expectResult({ result: { sys_id: "abc" } }, "Table API"),
        { sys_id: "abc" },
      );
    });

    it("keeps a present-but-falsy result (only null/undefined are missing)", () => {
      // `data.result == null` is the test, so 0 / "" / false are legitimate
      // payloads and must survive rather than read as a malformed response.
      assert.equal(sharedApi.expectResult({ result: false }, "API"), false);
      assert.equal(sharedApi.expectResult({ result: 0 }, "API"), 0);
      assert.equal(sharedApi.expectResult({ result: "" }, "API"), "");
    });

    // Every payload shape that is not a usable envelope, named by the API so the
    // error tells the caller which call site produced it.
    const malformed = [
      ["null", null],
      ["undefined", undefined],
      ["an object with no result key", {}],
      ["an explicit null result", { result: null }],
      ["an explicit undefined result", { result: undefined }],
    ];
    for (const [label, payload] of malformed) {
      it(`throws a named ServiceNowError for ${label}`, () => {
        assert.throws(() => sharedApi.expectResult(payload, "Table API"), {
          name: "ServiceNowError",
          message:
            "Unexpected response from ServiceNow Table API: missing 'result'.",
        });
      });
    }
  });

  describe("expectResultArray", () => {
    it("unwraps an array result, including an empty one", () => {
      assert.deepEqual(
        sharedApi.expectResultArray({ result: [{ n: 1 }] }, "Table API"),
        [{ n: 1 }],
      );
      assert.deepEqual(
        sharedApi.expectResultArray({ result: [] }, "Table API"),
        [],
      );
    });

    const notArrays = [
      ["null", null],
      ["undefined", undefined],
      ["an object with no result key", {}],
      ["a single object instead of a list", { result: { sys_id: "abc" } }],
      ["a string", { result: "abc" }],
      ["a null result", { result: null }],
    ];
    for (const [label, payload] of notArrays) {
      it(`throws for ${label}`, () => {
        assert.throws(() => sharedApi.expectResultArray(payload, "Table API"), {
          name: "ServiceNowError",
          message:
            "Unexpected response from ServiceNow Table API: missing 'result' array.",
        });
      });
    }
  });

  describe("snString", () => {
    it("passes scalars through as strings", () => {
      assert.equal(sharedApi.snString("INC0001"), "INC0001");
      assert.equal(sharedApi.snString(""), "");
      assert.equal(sharedApi.snString(42), "42");
      assert.equal(sharedApi.snString(0), "0");
      assert.equal(sharedApi.snString(true), "true");
      assert.equal(sharedApi.snString(false), "false");
    });

    // Anything non-scalar maps to "" — notably the {value, display_value} shape
    // sysparm_display_value=all returns, which String() would render as
    // "[object Object]" in the middle of a report.
    const nonScalars = [
      ["a display-value object", { value: "x", display_value: "y" }],
      ["null", null],
      ["undefined", undefined],
      ["an array", ["a", "b"]],
      ["a function", () => "x"],
    ];
    for (const [label, value] of nonScalars) {
      it(`returns "" for ${label}`, () => {
        assert.equal(sharedApi.snString(value), "");
      });
    }
  });

  describe("assertNoCaret", () => {
    it("rejects a fragment containing the encoded-query separator, as a 400", () => {
      assert.throws(
        () => sharedApi.assertNoCaret("admin^ORactive=true", "name"),
        (err) => {
          assert.ok(err instanceof ServiceNowError);
          // A 400 (not a 500): the caller supplied an unusable filter.
          assert.equal(err.status, 400);
          assert.equal(
            err.message,
            "The name filter cannot contain '^' (it is the encoded-query separator and cannot be escaped).",
          );
          return true;
        },
      );
    });

    it("passes any fragment without a caret", () => {
      assert.equal(sharedApi.assertNoCaret("incident", "table"), undefined);
      // Only "^" is rejected — the other encoded-query metacharacters are not.
      assert.equal(sharedApi.assertNoCaret("a=b,c%20d&e", "query"), undefined);
    });
  });

  describe("markdown helpers", () => {
    it("escapes pipes, and only pipes", () => {
      assert.equal(sharedApi.mdEscape("a|b|c"), "a\\|b\\|c");
      assert.equal(sharedApi.mdEscape("no pipes here"), "no pipes here");
      // The helper claims to protect the column layout, nothing more: other
      // Markdown metacharacters are left untouched.
      assert.equal(
        sharedApi.mdEscape("*bold* _x_ `code`"),
        "*bold* _x_ `code`",
      );
    });

    it("renders a table whose header and cells are both escaped", () => {
      assert.equal(
        sharedApi.mdTable(
          ["Na|me", "Value"],
          [
            ["a|b", "c"],
            ["plain", "1"],
          ],
        ),
        [
          "| Na\\|me | Value |",
          "| --- | --- |",
          "| a\\|b | c |",
          "| plain | 1 |",
        ].join("\n"),
      );
    });

    it("renders header and separator even with no rows", () => {
      assert.equal(
        sharedApi.mdTable(["A", "B"], []),
        "| A | B |\n| --- | --- |",
      );
    });
  });
});

describe("Table API reads over a stubbed fetch (api/table.ts + core/http.ts)", () => {
  const HOST = "dev12345.service-now.com";
  let originalFetch;

  /**
   * Record every request and answer it with a real Response, so the transport's
   * status, header and body handling runs for real instead of against a
   * hand-rolled double.
   */
  function stubFetch(reply) {
    const calls = [];
    globalThis.fetch = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(reply(calls.length - 1));
    };
    return calls;
  }

  function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearSnEnv();
    process.env.SN_INSTANCE = "dev12345";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "s3cret";
    // No backoff: a request the transport decides to retry must fail the test
    // immediately rather than sleep through the exponential delay.
    process.env.SN_MAX_RETRIES = "0";
    // The transport logs an API error at warn level; keep the suite's stderr to
    // assertion output only.
    process.env.SN_LOG_LEVEL = "error";
    reloadCredentialsFromEnv();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreSnEnv();
  });

  it("queries the Table API with exactly the parameters the caller asked for", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ result: [{ number: "INC0001" }] }, 200, {
        "x-total-count": "42",
      }),
    );

    const res = await tableApi.queryTable({
      table: "incident",
      query: "active=true^priority=1",
      fields: ["number", "short_description"],
      limit: 5,
    });

    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.origin, `https://${HOST}`);
    assert.equal(url.pathname, "/api/now/table/incident");
    assert.equal(
      url.searchParams.get("sysparm_query"),
      "active=true^priority=1",
    );
    assert.equal(
      url.searchParams.get("sysparm_fields"),
      "number,short_description",
    );
    assert.equal(url.searchParams.get("sysparm_limit"), "5");
    // Defaults the read wrapper adds on every call.
    assert.equal(url.searchParams.get("sysparm_display_value"), "false");
    assert.equal(
      url.searchParams.get("sysparm_exclude_reference_link"),
      "true",
    );
    // A zero offset is not sent at all.
    assert.equal(url.searchParams.get("sysparm_offset"), null);

    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.headers.Accept, "application/json");
    // A read carries no body and no Content-Type.
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.headers["Content-Type"], undefined);

    // The `result` envelope is unwrapped; X-Total-Count becomes `total`.
    assert.deepEqual(res.records, [{ number: "INC0001" }]);
    assert.equal(res.total, 42);
    assert.equal(res.truncated, undefined);
  });

  it("sends only the mandatory parameters, with a default page of 10, when the caller gives none", async () => {
    const calls = stubFetch(() => jsonResponse({ result: [] }));

    const res = await tableApi.queryTable({ table: "sys_user" });

    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/api/now/table/sys_user");
    assert.equal(url.searchParams.get("sysparm_limit"), "10");
    assert.equal(url.searchParams.get("sysparm_query"), null);
    assert.equal(url.searchParams.get("sysparm_fields"), null);
    // No X-Total-Count on the response leaves `total` unset rather than 0.
    assert.deepEqual(res, { records: [], total: undefined });
  });

  it("percent-encodes a table name into the path", async () => {
    const calls = stubFetch(() => jsonResponse({ result: [] }));

    await tableApi.queryTable({ table: "x_snc app/table" });

    assert.equal(
      new URL(calls[0].url).pathname,
      "/api/now/table/x_snc%20app%2Ftable",
    );
  });

  it("reads a single record by sys_id and unwraps the object result", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ result: { sys_id: "0123456789", number: "INC0001" } }),
    );

    const record = await tableApi.getRecord("incident", "0123456789", [
      "number",
    ]);

    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/api/now/table/incident/0123456789");
    assert.equal(url.searchParams.get("sysparm_fields"), "number");
    assert.deepEqual(record, { sys_id: "0123456789", number: "INC0001" });
  });

  it("rejects a 404 with a ServiceNowError that carries the status but never the query", async () => {
    // http.ts builds a `safeUrl` without the query string precisely because an
    // encoded query can carry personal data; the API-error message goes further
    // and names no URL at all. Both claims are asserted against the one thing
    // that could leak them — the message the caller sees.
    const secretQuery = "emailLIKEjane.doe@example.com";
    const calls = stubFetch(() =>
      jsonResponse(
        {
          error: { message: "No Record found", detail: "Records matching..." },
          status: "failure",
        },
        404,
      ),
    );

    await assert.rejects(
      () => tableApi.queryTable({ table: "incident", query: secretQuery }),
      (err) => {
        assert.ok(err instanceof ServiceNowError);
        assert.equal(err.status, 404);
        assert.equal(
          err.message,
          "ServiceNow API error (404): No Record found",
        );
        assert.ok(!err.message.includes(secretQuery));
        assert.ok(!err.message.includes("jane.doe"));
        assert.ok(!err.message.includes("sysparm_query"));
        // The parsed body is still attached for callers that need it.
        assert.equal(err.detail.error.message, "No Record found");
        return true;
      },
    );

    // The query really was sent — the omission is in the error message, not in
    // the request, so this is a redaction test and not a "we never queried" one.
    assert.equal(
      new URL(calls[0].url).searchParams.get("sysparm_query"),
      secretQuery,
    );
  });

  it("refuses to reach the network at all when the instance is not configured", async () => {
    delete process.env.SN_INSTANCE;
    reloadCredentialsFromEnv();
    const calls = stubFetch(() => jsonResponse({ result: [] }));

    await assert.rejects(() => tableApi.queryTable({ table: "incident" }), {
      name: "ServiceNowError",
    });
    assert.equal(calls.length, 0);
  });
});
