import { test } from "node:test";
import assert from "node:assert/strict";

import { notificationConditions } from "../../build/checks/notification-conditions.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/** A deterministic 32-hex sys_id from a small integer. */
function sid(n) {
  return n.toString(16).padStart(32, "0");
}

/** Assemble a fake client from `sysevent_email_action` fixtures plus options. */
function makeHttp({ notifications = [], fail, totalCounts, queryFilter } = {}) {
  return createFakeSnClient({
    tables: { sysevent_email_action: notifications },
    totalCounts,
    queryFilter,
    fail,
  });
}

function run(http, extra = {}) {
  return notificationConditions.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

/** A Notification that fires on every update of its table. */
const STORM = {
  sys_id: sid(1),
  name: "Order changed",
  collection: "x_acme_app_order",
  event_name: "",
  condition: "",
  advanced_condition: "",
  action_insert: false,
  action_update: true,
};
const CONDITIONED = {
  ...STORM,
  sys_id: sid(2),
  name: "Order shipped",
  condition: "state=shipped^EQ",
};
const EVENT_DRIVEN = {
  ...STORM,
  sys_id: sid(3),
  name: "Order escalated",
  event_name: "x_acme_app.order.escalated",
};
const SCRIPTED = {
  ...STORM,
  sys_id: sid(4),
  name: "Order flagged",
  advanced_condition: "answer = current.priority == 1;",
};
const INSERT_ONLY = {
  ...STORM,
  sys_id: sid(5),
  name: "Order created",
  action_insert: true,
  action_update: false,
};

test("notification-conditions is registered as an advisory single-table check", () => {
  assert.equal(notificationConditions.name, "notification-conditions");
  assert.ok(defaultChecks.includes(notificationConditions));
  const { meta } = notificationConditions;
  assert.equal(meta.requires, "scope");
  assert.equal(meta.rule, undefined);
  assert.equal(meta.severity, "advisory");
  assert.deepEqual(meta.tables, ["sysevent_email_action"]);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.match(meta.verdicts.fail, /never/i);
});

test("warns when no scope is set", async () => {
  const result = await notificationConditions.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /no scope set/i);
});

test("warns and cannot confirm when zero rows arrive without a pre-trim count", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "warn");
  assert.match(result.message, /cannot confirm/i);
});

test("passes when the instance reports zero notifications in scope", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sysevent_email_action: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to check/i);
});

test("warns when every matching notification is security-trimmed away", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sysevent_email_action: 3 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /security-trimmed/);
  assert.match(result.message, /\b3\b/);
});

test("warns naming the notification and its table when it fires on every update", async () => {
  const result = await run(
    makeHttp({
      notifications: [CONDITIONED, STORM, EVENT_DRIVEN, SCRIPTED, INSERT_ONLY],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /1 Notification\(s\) fire on every update/);
  assert.match(result.message, /Order changed \(x_acme_app_order\)/);
  for (const clean of [
    "Order shipped",
    "Order escalated",
    "Order flagged",
    "Order created",
  ]) {
    assert.doesNotMatch(result.message, new RegExp(clean));
  }
  assert.doesNotMatch(result.message, /answer = current/);
});

test("reads action_update as a 'true'/'false' string too", async () => {
  const stringTrue = { ...STORM, action_update: "true" };
  const stringFalse = { ...STORM, action_update: "false" };
  const bad = await run(makeHttp({ notifications: [stringTrue] }));
  assert.equal(bad.status, "warn");
  assert.match(bad.message, /Order changed/);
  const ok = await run(makeHttp({ notifications: [stringFalse] }));
  assert.equal(ok.status, "pass");
});

test("falls back to the sys_id and omits the table when both names are empty", async () => {
  const result = await run(
    makeHttp({ notifications: [{ ...STORM, name: "", collection: "" }] }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, new RegExp(`${sid(1)}\\.`));
});

test("flags that a finding list may be incomplete when the read was trimmed", async () => {
  const result = await run(
    makeHttp({
      notifications: [STORM],
      totalCounts: { sysevent_email_action: 4 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Order changed/);
  assert.match(result.message, /may be incomplete/i);
});

test("a clean but security-trimmed read warns rather than passes", async () => {
  const result = await run(
    makeHttp({
      notifications: [CONDITIONED],
      totalCounts: { sysevent_email_action: 2 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /security-trimmed/);
});

test("passes when every active notification is event-driven or conditioned", async () => {
  const result = await run(
    makeHttp({
      notifications: [CONDITIONED, EVENT_DRIVEN, SCRIPTED, INSERT_ONLY],
      totalCounts: { sysevent_email_action: 4 },
    }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /All 4 active Notification\(s\)/);
});

test("queries only active notifications in scope with the metadata columns", async () => {
  const seen = [];
  const http = makeHttp({
    notifications: [CONDITIONED],
    queryFilter: (table, rows, params) => {
      if (table === "sysevent_email_action") seen.push(params);
      return rows;
    },
  });
  await run(http);
  assert.equal(seen.length, 1);
  const [params] = seen;
  assert.match(params.sysparm_query, /sys_scope(\.scope)?=/);
  assert.match(params.sysparm_query, /(^|\^)active=true($|\^)/);
  const fields = params.sysparm_fields.split(",");
  for (const f of [
    "sys_id",
    "name",
    "collection",
    "event_name",
    "condition",
    "advanced_condition",
    "action_insert",
    "action_update",
  ]) {
    assert.ok(fields.includes(f), f);
  }
  assert.ok(!fields.includes("message_html"));
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

test("warns on an HTTP error reading sysevent_email_action", async () => {
  const result = await run(
    makeHttp({ fail: { table: { sysevent_email_action: { http: 403 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /403/);
});
