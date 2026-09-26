import { test } from "node:test";
import assert from "node:assert/strict";

import { uiActionGating } from "../../build/checks/ui-action-gating.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/** A deterministic 32-hex sys_id from a small integer. */
function sid(n) {
  return n.toString(16).padStart(32, "0");
}

/**
 * Route the fake's single global query filter by table name: the role lookup
 * arrives as `sys_ui_actionIN<id>,<id>,…` in chunked batches.
 */
function queryFilter(table, rows, params) {
  if (table === "sys_ui_action_role") {
    const q = params?.sysparm_query ?? "";
    const inMatch = /sys_ui_actionIN([^^]+)/.exec(q);
    if (!inMatch) return rows;
    const ids = new Set(inMatch[1].split(","));
    return rows.filter((r) => ids.has(String(r.sys_ui_action)));
  }
  return rows;
}

/** Assemble a fake client from UI Action / role-link fixtures plus options. */
function makeHttp({ actions = [], links = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: { sys_ui_action: actions, sys_ui_action_role: links },
    queryFilter,
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return uiActionGating.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

/** Wrap a fake client so every `query`/`queryWithMeta` call is recorded. */
function tracked(http) {
  const calls = [];
  return {
    http: {
      ...http,
      table(name) {
        const t = http.table(name);
        return {
          get: (id, params) => t.get(id, params),
          query: (params) => {
            calls.push({ table: name, params });
            return t.query(params);
          },
          queryWithMeta: (params) => {
            calls.push({ table: name, params });
            return t.queryWithMeta(params);
          },
        };
      },
    },
    calls,
  };
}

/** A UI Action row. */
function action(
  n,
  { name = `Action ${n}`, condition = "", table = "x_acme_asset" } = {},
) {
  return { sys_id: sid(n), name, table, condition };
}

/** A "Requires role" link for action `n`. */
function roleLink(n, role = "x_acme_app.admin") {
  return { sys_id: `link${n}`, sys_ui_action: sid(n), sys_user_role: role };
}

test("is registered in the default suite", () => {
  assert.ok(defaultChecks.includes(uiActionGating));
  assert.equal(uiActionGating.name, "ui-action-gating");
});

test("warns and skips when no scope is set", async () => {
  const result = await run(makeHttp(), { scope: undefined });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("passes when every action has a condition or a required role", async () => {
  const result = await run(
    makeHttp({
      actions: [action(1, { condition: "current.canWrite()" }), action(2)],
      links: [roleLink(2)],
    }),
  );
  assert.equal(result.status, "pass", result.message);
  assert.match(result.message, /All 2 active UI Action\(s\)/);
});

test("fails an action with neither a condition nor a role, naming it with its table", async () => {
  const result = await run(
    makeHttp({
      actions: [
        action(1, { name: "Approve", table: "x_acme_request" }),
        action(2, { condition: "gs.hasRole('x_acme_app.user')" }),
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /1 active UI Action\(s\)/);
  assert.match(result.message, /Approve \(x_acme_request\)/);
  assert.doesNotMatch(result.message, /Action 2/);
});

test("a whitespace or bare `true` condition gates nothing", async () => {
  const result = await run(
    makeHttp({
      actions: [
        action(1, { condition: "   " }),
        action(2, { condition: "true" }),
        action(3, { condition: " TRUE; " }),
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /3 active UI Action\(s\)/);
});

test("a role link with an empty role does not gate the action", async () => {
  const result = await run(
    makeHttp({ actions: [action(1)], links: [roleLink(1, "")] }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Action 1/);
});

test("a role linked to a different action does not gate this one", async () => {
  const result = await run(
    makeHttp({ actions: [action(1), action(2)], links: [roleLink(2)] }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Action 1/);
  assert.doesNotMatch(result.message, /Action 2/);
});

test("skips the role lookup entirely when every action has a condition", async () => {
  const { http, calls } = tracked(
    makeHttp({ actions: [action(1, { condition: "current.isValid()" })] }),
  );
  const result = await run(http);
  assert.equal(result.status, "pass");
  assert.equal(calls.filter((c) => c.table === "sys_ui_action_role").length, 0);
});

test("queries active scoped actions and role links by action id, unpaged", async () => {
  const { http, calls } = tracked(
    makeHttp({ actions: [action(1)], links: [roleLink(1)] }),
  );
  await run(http);
  const actionRead = calls.find((c) => c.table === "sys_ui_action");
  assert.match(actionRead.params.sysparm_query, /x_acme_app/);
  assert.match(actionRead.params.sysparm_query, /\^active=true$/);
  assert.equal(actionRead.params.sysparm_limit, undefined);
  const roleRead = calls.find((c) => c.table === "sys_ui_action_role");
  assert.equal(roleRead.params.sysparm_query, `sys_ui_actionIN${sid(1)}`);
  assert.equal(roleRead.params.sysparm_limit, undefined);
});

test("batches the role lookup across many actions", async () => {
  const actions = Array.from({ length: 230 }, (_, i) => action(i + 1));
  const links = actions.map((_, i) => roleLink(i + 1));
  const { http, calls } = tracked(makeHttp({ actions, links }));
  const result = await run(http);
  assert.equal(result.status, "pass", result.message);
  assert.equal(calls.filter((c) => c.table === "sys_ui_action_role").length, 3);
});

test("an action whose sys_id is not safely queryable fails as unverifiable", async () => {
  const result = await run(
    makeHttp({
      actions: [
        {
          sys_id: "abc^ORactive=false",
          name: "Odd",
          table: "t",
          condition: "",
        },
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /1 could not be verified/);
  assert.match(result.message, /Odd \(t\)/);
});

test("passes when the instance reports the scope ships no active actions", async () => {
  const result = await run(
    makeHttp({ actions: [], totalCounts: { sys_ui_action: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /No active UI Actions in scope/);
});

test("fails on a security-trimmed zero-row action read (SN-1)", async () => {
  const result = await run(
    makeHttp({ actions: [], totalCounts: { sys_ui_action: 6 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /6 match but 0 are visible/);
});

test("warns on an ambiguous zero-row action read (no pre-trim count)", async () => {
  const result = await run(makeHttp({ actions: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count arrived/);
});

test("fails on a partially trimmed action read even when every visible action is gated", async () => {
  const result = await run(
    makeHttp({
      actions: [action(1, { condition: "x" })],
      totalCounts: { sys_ui_action: 3 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_ui_action read was security-trimmed/);
});

test("fails on a trimmed role read even when every visible action is gated", async () => {
  const result = await run(
    makeHttp({
      actions: [action(1)],
      links: [roleLink(1)],
      totalCounts: { sys_ui_action_role: 4 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_ui_action_role read was security-trimmed/);
});

test("an apparently ungated action under a trimmed role read says the role may be hidden", async () => {
  const result = await run(
    makeHttp({ actions: [action(1)], totalCounts: { sys_ui_action_role: 2 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Action 1/);
  assert.match(result.message, /a role this account cannot see may gate/);
});

test("an ungated action under a trimmed action read notes the incomplete view", async () => {
  const result = await run(
    makeHttp({ actions: [action(1)], totalCounts: { sys_ui_action: 5 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /may be incomplete/);
});

test("fails hard on an authentication error", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /Authentication failed/);
});

test("warns (degraded) on a network error", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /Could not reach the instance/);
});

test("warns (degraded) on an HTTP error reading the role table", async () => {
  const result = await run(
    makeHttp({
      actions: [action(1)],
      fail: { table: { sys_ui_action_role: { http: 403 } } },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 403/);
});
