import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rowFinding,
  subjectFinding,
  withFindings,
} from "../../build/checks/cert-common.js";

test("rowFinding locates a row by table, sys_id and its label (F-R-3)", () => {
  const f = rowFinding(
    "demo",
    "sys_script_include",
    { sys_id: "abc", name: "AcmeUtil" },
    "no-role",
  );
  assert.equal(f.kind, "no-role");
  assert.deepEqual(f.location, {
    table: "sys_script_include",
    sysId: "abc",
    recordName: "AcmeUtil",
  });
  assert.equal(f.message, "AcmeUtil (sys_script_include): no-role");
  assert.match(f.id, /^f1:[0-9a-f]{16}$/);
});

test("rowFinding falls back to the sys_id when the label is empty (F-R-3)", () => {
  const f = rowFinding("demo", "sys_ui_page", { sys_id: "abc", name: "" }, "k");
  assert.equal(f.location.recordName, "abc");
});

test("rowFinding id is stable across a rename of the record (F-R-3)", () => {
  const a = rowFinding("demo", "t", { sys_id: "abc", name: "Old" }, "k");
  const b = rowFinding("demo", "t", { sys_id: "abc", name: "New" }, "k");
  const other = rowFinding("demo", "t", { sys_id: "def", name: "Old" }, "k");
  const otherKind = rowFinding(
    "demo",
    "t",
    { sys_id: "abc", name: "Old" },
    "j",
  );
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, other.id);
  assert.notEqual(a.id, otherKind.id);
});

test("rowFinding without a sys_id keys on a name logicalId (F-R-3)", () => {
  const f = rowFinding("demo", "t", { name: "Lonely" }, "k");
  assert.equal(f.location.sysId, undefined);
  assert.equal(f.location.logicalId, "name:Lonely");
  assert.equal(f.location.recordName, "Lonely");
});

test("rowFinding accepts a label function and a custom message (F-R-3)", () => {
  const f = rowFinding(
    "demo",
    "sys_dictionary",
    { sys_id: "d1", name: "x_t", element: "script" },
    "acl-missing:write",
    (r) => `${r.name}.${r.element}`,
    "custom",
  );
  assert.equal(f.location.recordName, "x_t.script");
  assert.equal(f.message, "custom");
});

test("subjectFinding locates a non-row subject by logicalId (F-R-3)", () => {
  const f = subjectFinding(
    "demo",
    "table:x_acme",
    "x_acme",
    "acl-missing:read",
  );
  assert.deepEqual(f.location, {
    logicalId: "table:x_acme",
    recordName: "x_acme",
  });
  assert.equal(f.message, "x_acme: acl-missing:read");
});

test("withFindings attaches findings only when there are any (F-R-3)", () => {
  const base = { name: "demo", status: "pass", message: "ok" };
  assert.equal(withFindings(base, []).findings, undefined);
  const f = subjectFinding("demo", "x", "x", "k");
  assert.deepEqual(withFindings(base, [f]).findings, [f]);
});
