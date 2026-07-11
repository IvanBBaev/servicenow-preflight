import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeSnClient } from "../../build/http/fake.js";
import { SnResponseError } from "../../build/http/client.js";

// These tests pin the fake's fidelity to the real ServiceNow Table API shapes.
// A check that only works against a naive fixture (plain-string references,
// missing empty columns, dot-walks it never requested) must break HERE, not in
// production. The four contracts under test mirror the file header of fake.ts.

test("reference columns come back as { link, value }, never a plain string", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        {
          sys_id: "us1",
          name: "My set",
          state: "complete",
          parent: "us_parent",
        },
      ],
    },
  });
  const [row] = await http.table("sys_update_set").query();
  // A declared reference is wrapped, with a synthesised link URL.
  assert.deepEqual(row.parent, {
    link: "https://fake.service-now.com/api/now/table/sys_update_set/us_parent",
    value: "us_parent",
  });
  // A plain (non-reference) column stays a bare string.
  assert.equal(row.name, "My set");
});

test('an empty / unset reference column comes back as "" (never wrapped)', async () => {
  const http = createFakeSnClient({
    tables: {
      // base_update_set explicitly empty; sys_scope not seeded at all.
      sys_update_set: [
        { sys_id: "us1", name: "Set", state: "complete", base_update_set: "" },
      ],
    },
  });
  const [row] = await http.table("sys_update_set").query();
  assert.equal(row.base_update_set, "");
  assert.equal(row.sys_scope, "");
});

test("a reference seeded as a { value } object is wrapped and keeps its display_value", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_security_acl_role: [
        {
          sys_id: "l1",
          sys_user_role: { value: "role1", display_value: "itil" },
        },
      ],
    },
  });
  const [row] = await http.table("sys_security_acl_role").query();
  assert.equal(row.sys_user_role.value, "role1");
  assert.equal(row.sys_user_role.display_value, "itil");
  assert.match(row.sys_user_role.link, /sys_security_acl_role\/role1$/);
});

test('a known-but-empty column is present as "", never a missing key', async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        { sys_id: "us1", name: "First" },
        { sys_id: "us2", name: "Second", description: "only here" },
      ],
    },
  });
  const rows = await http.table("sys_update_set").query();
  const first = rows.find((r) => r.sys_id === "us1");
  // `description` is a real column of the table (some row has it), so the row
  // that lacks a value still carries the key as "".
  assert.ok("description" in first);
  assert.equal(first.description, "");
});

test("dot-walked fields appear only when requested via sysparm_fields", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_atf_test_result: [
        {
          sys_id: "t1",
          test: "ref1",
          "test.name": "Create incident",
          status: "success",
        },
      ],
    },
  });
  // No sysparm_fields → the dot-walked key is NOT surfaced (and `test` is wrapped).
  const [full] = await http.table("sys_atf_test_result").query();
  assert.ok(!("test.name" in full));
  assert.equal(full.test.value, "ref1");
  // Requested explicitly → surfaced as the seeded value.
  const [proj] = await http
    .table("sys_atf_test_result")
    .query({ sysparm_fields: "sys_id,test.name" });
  assert.equal(proj["test.name"], "Create incident");
  assert.deepEqual(Object.keys(proj).sort(), ["sys_id", "test.name"]);
});

test("a dot-walked field that was not seeded is not fabricated", async () => {
  const http = createFakeSnClient({
    tables: { sys_atf_test_result: [{ sys_id: "t1", test: "ref1" }] },
  });
  const [proj] = await http
    .table("sys_atf_test_result")
    .query({ sysparm_fields: "sys_id,test.name" });
  assert.ok(!("test.name" in proj));
});

test('unknown sysparm_fields names are dropped; known-but-absent become ""', async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        { sys_id: "us1", name: "Set" },
        { sys_id: "us2", name: "Other", description: "x" },
      ],
    },
  });
  const rows = await http
    .table("sys_update_set")
    .query({ sysparm_fields: "sys_id,description,totally_made_up" });
  const first = rows.find((r) => r.sys_id === "us1");
  // A real column with no value on this row → "".
  assert.equal(first.description, "");
  // A column name the table does not have → silently dropped.
  assert.ok(!("totally_made_up" in first));
});

test("get() projects a single row the same way and returns null for a miss", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        { sys_id: "us1", name: "Set", state: "complete", parent: "us_p" },
      ],
    },
  });
  const hit = await http.table("sys_update_set").get("us1");
  assert.equal(hit.parent.value, "us_p");
  assert.equal(hit.name, "Set");
  const miss = await http.table("sys_update_set").get("nope");
  assert.equal(miss, null);
});

test("queryWithMeta surfaces X-Total-Count and the security-trimmed signal", async () => {
  const http = createFakeSnClient({
    tables: { sys_security_acl: [{ sys_id: "a1", name: "incident" }] },
    totalCounts: { sys_security_acl: 5 },
  });
  const meta = await http.table("sys_security_acl").queryWithMeta();
  assert.equal(meta.rows.length, 1);
  assert.equal(meta.totalCount, 5);
  // 5 match pre-trim but only 1 is visible → the account is security-trimmed.
  assert.equal(meta.securityTrimmed, true);
});

test("queryWithMeta is not security-trimmed when the count matches the rows", async () => {
  const http = createFakeSnClient({
    tables: { sys_security_acl: [{ sys_id: "a1" }] },
    totalCounts: { sys_security_acl: 1 },
  });
  const meta = await http.table("sys_security_acl").queryWithMeta();
  assert.equal(meta.securityTrimmed, false);
});

test("queryWithMeta reports no total count and no trim when none is seeded", async () => {
  const http = createFakeSnClient({
    tables: { sys_security_acl: [] },
  });
  const meta = await http.table("sys_security_acl").queryWithMeta();
  assert.equal(meta.totalCount, undefined);
  assert.equal(meta.securityTrimmed, false);
});

test("referenceFields override opts an extra column into the wrapped shape", async () => {
  const http = createFakeSnClient({
    tables: { my_table: [{ sys_id: "r1", owner: "user1" }] },
    referenceFields: { my_table: ["owner"] },
  });
  const [row] = await http.table("my_table").query();
  assert.equal(row.owner.value, "user1");
  assert.match(row.owner.link, /my_table\/user1$/);
});

test("fail.response throws SnResponseError with a 200 status (non-JSON 2xx)", async () => {
  const http = createFakeSnClient({
    tables: { sys_update_set: [] },
    fail: { response: true },
  });
  await assert.rejects(
    async () => http.table("sys_update_set").query(),
    (err) => err instanceof SnResponseError && err.status === 200,
  );
});

test("fail can be scoped to a single table, leaving others working", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [{ sys_id: "us1", name: "Set" }],
      sys_user_role: [{ sys_id: "role1", name: "itil" }],
    },
    fail: { table: { sys_update_set: { http: 500 } } },
  });
  await assert.rejects(async () => http.table("sys_update_set").query());
  const roles = await http.table("sys_user_role").query();
  assert.equal(roles.length, 1);
});
