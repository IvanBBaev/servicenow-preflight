import { test } from "node:test";
import assert from "node:assert/strict";

import { aclRoleSanity } from "../../build/checks/acl-role-sanity.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/**
 * Route the fake's single global query filter by table name. `sys_security_acl`
 * and `sys_user_role` return all seeded rows; the m2m `sys_security_acl_role`
 * is filtered by the `sys_security_acl=<id>` param the check queries with, so a
 * per-ACL role fetch yields only that ACL's links.
 */
function queryFilter(table, rows, params) {
  if (table === "sys_security_acl_role") {
    const q = params?.sysparm_query ?? "";
    const match = /sys_security_acl=([^^]+)/.exec(q);
    const aclId = match ? match[1] : "";
    return rows.filter((r) => r.sys_security_acl === aclId);
  }
  return rows;
}

/** Assemble a fake client from ACL / link / role fixtures plus optional fail. */
function makeHttp({ acls = [], links = [], roles = [], fail } = {}) {
  return createFakeSnClient({
    tables: {
      sys_security_acl: acls,
      sys_security_acl_role: links,
      sys_user_role: roles,
    },
    queryFilter,
    fail,
  });
}

function run(http, extra = {}) {
  return aclRoleSanity.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

test("acl-role-sanity keeps its registered name", async () => {
  const result = await run(makeHttp());
  assert.equal(result.name, "acl-role-sanity");
});

test("warns when no scope is set", async () => {
  const result = await aclRoleSanity.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /scope/i);
});

test("passes when there are no ACLs in scope", async () => {
  const result = await run(makeHttp({ acls: [] }));
  assert.equal(result.status, "pass");
  assert.match(result.message, /No ACLs/i);
});

test("passes when every ACL is role-gated and roles exist", async () => {
  const acls = [
    {
      sys_id: "acl1",
      name: "incident",
      operation: "write",
      active: "true",
      script: "",
      condition: "",
    },
    {
      sys_id: "acl2",
      name: "incident",
      operation: "read",
      active: true,
      script: "",
      condition: "",
    },
  ];
  const links = [
    {
      sys_security_acl: "acl1",
      sys_user_role: "role_sysid_1",
      "sys_user_role.name": "itil",
    },
    {
      sys_security_acl: "acl2",
      sys_user_role: "role_sysid_1",
      "sys_user_role.name": "itil",
    },
  ];
  const roles = [{ sys_id: "role_sysid_1", name: "itil" }];
  const result = await run(makeHttp({ acls, links, roles }));
  assert.equal(result.status, "pass");
  assert.match(result.message, /gated/i);
});

test("passes when an ungated ACL is guarded by a condition or script", async () => {
  const acls = [
    {
      sys_id: "acl1",
      name: "incident",
      operation: "write",
      active: "true",
      script: "current.active == true;",
      condition: "",
    },
    {
      sys_id: "acl2",
      name: "problem",
      operation: "write",
      active: "true",
      script: "",
      condition: "active=true",
    },
  ];
  // No role links at all, but every ACL has a script/condition gate.
  const result = await run(makeHttp({ acls, links: [], roles: [] }));
  assert.equal(result.status, "pass");
});

test("fails on a wide-open mutating ACL (no role, condition, or script)", async () => {
  const acls = [
    {
      sys_id: "acl1",
      name: "incident",
      operation: "write",
      active: "true",
      script: "",
      condition: "",
    },
  ];
  const result = await run(makeHttp({ acls, links: [], roles: [] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /public access/i);
  assert.match(result.message, /write/);
});

test("fails when an ACL references a role that does not exist", async () => {
  const acls = [
    {
      sys_id: "acl1",
      name: "incident",
      operation: "write",
      active: "true",
      script: "",
      condition: "",
    },
  ];
  const links = [
    {
      sys_security_acl: "acl1",
      sys_user_role: "ghost_sysid",
      "sys_user_role.name": "nonexistent_role",
    },
  ];
  // sys_user_role table is empty -> the referenced role is dangling.
  const result = await run(makeHttp({ acls, links, roles: [] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /does not exist/i);
  assert.match(result.message, /nonexistent_role/);
});

test("warns on a wide-open read ACL (public read, not fatal)", async () => {
  const acls = [
    {
      sys_id: "acl1",
      name: "kb_knowledge",
      operation: "read",
      active: "true",
      script: "",
      condition: "",
    },
  ];
  const result = await run(makeHttp({ acls, links: [], roles: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /public read/i);
});

test("warns on an inactive shipped ACL", async () => {
  const acls = [
    {
      sys_id: "acl1",
      name: "incident",
      operation: "write",
      active: "false",
      script: "",
      condition: "gated=true",
    },
  ];
  const result = await run(makeHttp({ acls, links: [], roles: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /inactive/i);
});

test("fail (open write) takes precedence over warn (open read)", async () => {
  const acls = [
    {
      sys_id: "acl1",
      name: "incident",
      operation: "write",
      active: "true",
      script: "",
      condition: "",
    },
    {
      sys_id: "acl2",
      name: "incident",
      operation: "read",
      active: "true",
      script: "",
      condition: "",
    },
  ];
  const result = await run(makeHttp({ acls, links: [], roles: [] }));
  assert.equal(result.status, "fail");
});

test("resolves a referenced role by sys_id even when the name is absent", async () => {
  const acls = [
    {
      sys_id: "acl1",
      name: "incident",
      operation: "write",
      active: "true",
      script: "",
      condition: "",
    },
  ];
  const links = [{ sys_security_acl: "acl1", sys_user_role: "role_sysid_1" }];
  const roles = [{ sys_id: "role_sysid_1", name: "itil" }];
  const result = await run(makeHttp({ acls, links, roles }));
  assert.equal(result.status, "pass");
});

test("handles reference fields delivered as {value} objects", async () => {
  const acls = [
    {
      sys_id: "acl1",
      name: "incident",
      operation: "write",
      active: "true",
      script: "",
      condition: "",
    },
  ];
  const links = [
    {
      sys_security_acl: "acl1",
      sys_user_role: { value: "role_sysid_1", display_value: "itil" },
    },
  ];
  const roles = [{ sys_id: "role_sysid_1", name: "itil" }];
  const result = await run(makeHttp({ acls, links, roles }));
  assert.equal(result.status, "pass");
});

test("fails hard on an authentication error", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /authentication/i);
});

test("warns (degraded) on a network error", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /reach/i);
});

test("warns (degraded) on an HTTP error reading ACL tables", async () => {
  const result = await run(makeHttp({ fail: { http: 500 } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 500/);
});

test("never throws — always returns a well-formed CheckResult", async () => {
  const result = await run(makeHttp({ fail: { http: 403 } }));
  // 403 surfaces as SnAuthError from the real client contract; the fake maps
  // http:403 to SnHttpError, so we just assert the shape stays well-formed.
  assert.equal(result.name, "acl-role-sanity");
  assert.ok(["pass", "warn", "fail"].includes(result.status));
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
});
