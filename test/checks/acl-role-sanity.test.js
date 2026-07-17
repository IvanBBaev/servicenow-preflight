import { test } from "node:test";
import assert from "node:assert/strict";

import { aclRoleSanity } from "../../build/checks/acl-role-sanity.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/**
 * Route the fake's single global query filter by table name. `sys_security_acl`
 * and `sys_user_role` return all seeded rows; the m2m `sys_security_acl_role`
 * is now read in ONE batched query per chunk of ACL ids (SN-6), so it is
 * filtered by the `sys_security_aclIN<id1>,<id2>,…` membership clause the check
 * queries with — yielding every seeded link whose ACL is in the batch. (The
 * legacy per-ACL `sys_security_acl=<id>` form is still honoured for safety.)
 */
function queryFilter(table, rows, params) {
  if (table === "sys_security_acl_role") {
    const q = params?.sysparm_query ?? "";
    const inMatch = /sys_security_aclIN([^^]+)/.exec(q);
    if (inMatch) {
      const ids = new Set(inMatch[1].split(","));
      return rows.filter((r) => ids.has(r.sys_security_acl));
    }
    const match = /sys_security_acl=([^^]+)/.exec(q);
    const aclId = match ? match[1] : "";
    return rows.filter((r) => r.sys_security_acl === aclId);
  }
  return rows;
}

/** Assemble a fake client from ACL / link / role fixtures plus optional fail. */
function makeHttp({
  acls = [],
  links = [],
  roles = [],
  fail,
  totalCounts,
} = {}) {
  return createFakeSnClient({
    tables: {
      sys_security_acl: acls,
      sys_security_acl_role: links,
      sys_user_role: roles,
    },
    queryFilter,
    totalCounts,
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

/**
 * Wrap a fake client so every `query`/`queryWithMeta` call is recorded. The ACL
 * read now goes through `queryWithMeta` (for the security-trimmed signal), so the
 * wrapper must forward — and record — that method too, or the check would call an
 * undefined member.
 */
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

test("warns (never passes) on a plain zero-row ACL read (SN-1)", async () => {
  // Zero visible ACLs with no pre-trim count is ambiguous — the app may ship
  // none, or the account may not read sys_security_acl. It is NOT proof of
  // safety, so the gate warns rather than passes green on nothing.
  const result = await run(makeHttp({ acls: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /No ACLs/i);
  assert.match(result.message, /cannot confirm/i);
});

test("fails on a security-trimmed zero-row ACL read (SN-1)", async () => {
  // 0 rows are visible but X-Total-Count proves ACLs match: the CI account is
  // security-trimmed (sys_security_acl is admin-read out-of-box). A zero-row
  // read here must fail — the gate cannot see what it is meant to inspect.
  const result = await run(
    makeHttp({ acls: [], totalCounts: { sys_security_acl: 3 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/i);
  assert.match(result.message, /\b3\b/);
});

test("fails on a partially trimmed ACL read rather than passing on the visible subset", async () => {
  // The visible ACLs are all clean, so the check would otherwise report green
  // — while 40 ACLs match and only 2 were ever looked at. The 38 it cannot see
  // are exactly the ones it cannot clear, so a trimmed read never passes.
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
  const result = await run(
    makeHttp({ acls, links, roles, totalCounts: { sys_security_acl: 40 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/i);
  assert.match(result.message, /40 ACL\(s\) match but only 2 are visible/);
});

test("a trimmed read still reports what the visible ACLs turned up", async () => {
  // Failing closed must not throw away the advisory findings the visible subset
  // did produce — they are still actionable.
  const acls = [
    {
      sys_id: "acl1",
      name: "incident",
      operation: "read",
      active: "true",
      script: "",
      condition: "",
    },
  ];
  const result = await run(
    makeHttp({
      acls,
      links: [],
      roles: [],
      totalCounts: { sys_security_acl: 12 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/i);
  assert.match(result.message, /Of those visible/);
  assert.match(result.message, /ungated read ACL\(s\)/);
});

test("a dangling role reference outranks a trimmed read", async () => {
  // A concrete, actionable defect is more useful than "I could not see
  // everything", so the hard failure keeps precedence.
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
      sys_user_role: "role_sysid_gone",
      "sys_user_role.name": "ghost",
    },
  ];
  const result = await run(
    makeHttp({ acls, links, roles: [], totalCounts: { sys_security_acl: 40 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /does not exist/i);
  assert.match(result.message, /ghost/);
});

test("names a dangling role by sys_id when the link carries no role name", async () => {
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
    { sys_security_acl: "acl1", sys_user_role: "role_sysid_gone" },
  ];
  const result = await run(makeHttp({ acls, links, roles: [] }));
  assert.equal(result.status, "fail");
  // With no name to print, the id is the only handle the operator has.
  assert.match(result.message, /incident → role_sysid_gone/);
});

test("labels a dangling role reference that carries neither name nor id", async () => {
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
  // A link row with an empty role reference: broken, and still reported rather
  // than skipped as if the ACL were gated.
  const links = [
    { sys_security_acl: "acl1", sys_user_role: "", "sys_user_role.name": "" },
  ];
  const result = await run(makeHttp({ acls, links, roles: [] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /\(unknown\)/);
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

test("inspects the ACL tables without an explicit sysparm_limit (CC-27)", async () => {
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
      sys_user_role: "role_sysid_1",
      "sys_user_role.name": "itil",
    },
  ];
  const roles = [{ sys_id: "role_sysid_1", name: "itil" }];
  const { http, calls } = tracked(makeHttp({ acls, links, roles }));
  const result = await run(http);
  assert.equal(result.status, "pass");
  // No ACL / role read pins a page size: the client auto-paginates so an app
  // shipping more ACLs (or an ACL gated by more roles) than a single page is
  // never silently truncated and misjudged as wide open (CC-27).
  const capped = calls.filter((c) => c.params?.sysparm_limit !== undefined);
  assert.deepEqual(capped, []);
});

test("batches ACL→role lookups into ⌈N/100⌉ queries, not N (SN-6)", async () => {
  // 250 ACLs used to cost 250 per-ACL `sys_security_acl_role` reads (N+1).
  // The batched IN form collapses that to ⌈250/100⌉ = 3 reads, each a single
  // `sys_security_aclIN<ids>` membership query. Proven by counting the reads.
  const acls = Array.from({ length: 250 }, (_, i) => ({
    sys_id: `acl${i}`,
    name: `acl_${i}`,
    operation: "write",
    active: "true",
    // Script-gated, so every ACL passes and the run reaches the batched read.
    script: "current.active == true;",
    condition: "",
  }));
  const { http, calls } = tracked(makeHttp({ acls, links: [], roles: [] }));
  const result = await run(http);
  assert.equal(result.status, "pass");

  const roleReads = calls.filter((c) => c.table === "sys_security_acl_role");
  assert.equal(roleReads.length, 3);
  for (const r of roleReads) {
    // Each read is a batched membership clause, never a per-ACL equality.
    assert.match(r.params.sysparm_query, /sys_security_aclIN/);
    assert.doesNotMatch(r.params.sysparm_query, /sys_security_acl=/);
  }
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
