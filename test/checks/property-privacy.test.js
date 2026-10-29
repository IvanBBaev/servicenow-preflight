import { test } from "node:test";
import assert from "node:assert/strict";

import { propertyPrivacy } from "../../build/checks/property-privacy.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/** A deterministic 32-hex sys_id from a small integer. */
function sid(n) {
  return n.toString(16).padStart(32, "0");
}

/** Assemble a fake client from `sys_properties` fixtures plus options. */
function makeHttp({ props = [], fail, totalCounts, queryFilter } = {}) {
  return createFakeSnClient({
    tables: { sys_properties: props },
    totalCounts,
    queryFilter,
    fail,
  });
}

function run(http, extra = {}) {
  return propertyPrivacy.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

const PRIVATE_PW = {
  sys_id: sid(1),
  name: "x_acme_app.vendor.password",
  type: "password2",
  is_private: true,
};
const PLAIN_SETTING = {
  sys_id: sid(2),
  name: "x_acme_app.page.size",
  type: "integer",
  is_private: false,
};

test("property-privacy is registered with blocker rule 1.7 metadata", () => {
  assert.equal(propertyPrivacy.name, "property-privacy");
  assert.ok(defaultChecks.includes(propertyPrivacy));
  const { meta } = propertyPrivacy;
  assert.equal(meta.requires, "scope");
  assert.equal(meta.rule, "1.7");
  assert.equal(meta.severity, "blocker");
  assert.deepEqual(meta.tables, ["sys_properties"]);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.match(meta.remediation, /Private/);
});

test("warns when no scope is set", async () => {
  const result = await propertyPrivacy.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /no scope set/i);
});

test("fails closed when zero rows arrive without a pre-trim count", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "fail");
  assert.match(result.message, /cannot confirm/i);
});

test("passes when the instance reports zero properties in scope", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_properties: 0 } }));
  assert.equal(result.status, "pass");
  assert.equal(result.findings, undefined); // F-R-3
  assert.match(result.message, /nothing to check/i);
});

test("fails when every matching property is security-trimmed away", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_properties: 3 } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/);
  assert.match(result.message, /\b3\b/);
});

test("fails on a password-typed property that is not private", async () => {
  const leaky = {
    sys_id: sid(3),
    name: "x_acme_app.api.secret",
    type: "password",
    is_private: false,
  };
  const result = await run(
    makeHttp({ props: [PRIVATE_PW, leaky, PLAIN_SETTING] }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /not private/);
  assert.match(result.message, /x_acme_app\.api\.secret/);
  assert.doesNotMatch(result.message, /vendor\.password/);
  assert.doesNotMatch(result.message, /page\.size/);
});

test("reads is_private as a 'true'/'false' string too", async () => {
  const stringTrue = { ...PRIVATE_PW, is_private: "true" };
  const stringFalse = {
    sys_id: sid(4),
    name: "x_acme_app.other.password",
    type: "password2",
    is_private: "false",
  };
  const ok = await run(makeHttp({ props: [stringTrue] }));
  assert.equal(ok.status, "pass");
  const bad = await run(makeHttp({ props: [stringFalse] }));
  assert.equal(bad.status, "fail");
  assert.match(bad.message, /other\.password/);
});

test("warns on a secret-like name stored with a non-password type", async () => {
  const plainSecret = {
    sys_id: sid(5),
    name: "x_acme_app.integration.api_key",
    type: "string",
    is_private: false,
  };
  const result = await run(
    makeHttp({ props: [PRIVATE_PW, plainSecret, PLAIN_SETTING] }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /non-password type/);
  assert.match(result.message, /integration\.api_key/);
  assert.doesNotMatch(result.message, /page\.size/);
});

test("a non-private password property outranks a plain secret and names both", async () => {
  const leaky = {
    sys_id: sid(3),
    name: "x_acme_app.api.secret",
    type: "password",
    is_private: false,
  };
  const plainSecret = {
    sys_id: sid(5),
    name: "x_acme_app.oauth.token",
    type: "string",
    is_private: false,
  };
  const result = await run(makeHttp({ props: [leaky, plainSecret] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /api\.secret/);
  assert.match(result.message, /Also 1 secret-like property/);
  assert.match(result.message, /oauth\.token/);
});

test("never echoes a property value into the message", async () => {
  const leaky = {
    sys_id: sid(3),
    name: "x_acme_app.api.secret",
    type: "password",
    is_private: false,
    value: "hunter2-not-for-the-log",
  };
  const result = await run(makeHttp({ props: [leaky] }));
  assert.equal(result.status, "fail");
  assert.doesNotMatch(result.message, /hunter2/);
});

test("flags that a finding list may be incomplete when the read was trimmed", async () => {
  const leaky = {
    sys_id: sid(3),
    name: "x_acme_app.api.secret",
    type: "password",
    is_private: false,
  };
  const result = await run(
    makeHttp({ props: [leaky], totalCounts: { sys_properties: 4 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /may be incomplete/i);
});

test("a clean but security-trimmed read fails rather than passes", async () => {
  const result = await run(
    makeHttp({ props: [PRIVATE_PW], totalCounts: { sys_properties: 2 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/);
});

test("passes when every property is correctly typed and private", async () => {
  const result = await run(
    makeHttp({
      props: [PRIVATE_PW, PLAIN_SETTING],
      totalCounts: { sys_properties: 2 },
    }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /All 2 active system properties/);
});

test("queries only active properties in scope and never asks for the value", async () => {
  const seen = [];
  const http = makeHttp({
    props: [PRIVATE_PW],
    queryFilter: (table, rows, params) => {
      if (table === "sys_properties") seen.push(params);
      return rows;
    },
  });
  await run(http);
  assert.equal(seen.length, 1);
  const [params] = seen;
  assert.match(params.sysparm_query, /sys_scope(\.scope)?=/);
  assert.match(params.sysparm_query, /(^|\^)active=true($|\^)/);
  assert.equal(params.sysparm_fields, "sys_id,name,type,is_private");
  assert.doesNotMatch(params.sysparm_fields, /\bvalue\b/);
});

test("fails on an authentication error", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /authentication failed/i);
});

test("warns on a network error", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /could not reach/i);
});

test("warns on an HTTP error reading sys_properties", async () => {
  const result = await run(
    makeHttp({ fail: { table: { sys_properties: { http: 403 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /403/);
});

function assertRowFindings(result, table, kinds) {
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    kinds,
  );
  for (const f of result.findings) {
    assert.equal(f.location.table, table);
    assert.ok(f.location.sysId || f.location.logicalId);
    assert.ok(f.location.recordName);
    assert.match(f.id, /^f1:[0-9a-f]{16}$/);
  }
}

test("emits a fail finding per leaky property and a warn per plain secret (F-R-3)", async () => {
  const leaky = {
    sys_id: sid(3),
    name: "x_acme_app.api.secret",
    type: "password",
    is_private: false,
  };
  const plainSecret = {
    sys_id: sid(5),
    name: "x_acme_app.oauth.token",
    type: "string",
    is_private: false,
  };
  const result = await run(makeHttp({ props: [leaky, plainSecret] }));
  assert.equal(result.status, "fail");
  assertRowFindings(result, "sys_properties", [
    "not-private",
    "plain-type-secret",
  ]);
  assert.equal(result.findings[0].status, undefined);
  assert.equal(result.findings[1].status, "warn");
});
