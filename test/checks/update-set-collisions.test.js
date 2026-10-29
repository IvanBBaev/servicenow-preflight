import { test } from "node:test";
import assert from "node:assert/strict";

import { updateSetCollisions } from "../../build/checks/update-set-collisions.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const SCOPE_SYS_ID = "a".repeat(32);
const INSTANCE = "https://dev12345.service-now.com";
const SENTINEL = "SENTINEL_9f3a";
const TARGET = "t".repeat(32);
const OTHER = "o".repeat(32);
const DONE = "c".repeat(32);
const DEFAULT = "d".repeat(32);

/** A sys_update_set row. */
function set(sys_id, name, state, fields = {}) {
  return { sys_id, name, state, application: SCOPE_SYS_ID, ...fields };
}

/** A sys_update_xml row, with the dot-walked set name/state unless `bare`. */
function xml(name, setRow, { bare = false } = {}) {
  const row = {
    sys_id: `x_${name}_${setRow.sys_id.slice(0, 4)}`,
    name,
    update_set: setRow.sys_id,
    payload: SENTINEL,
  };
  if (!bare) {
    row["update_set.name"] = setRow.name;
    row["update_set.state"] = setRow.state;
  }
  return row;
}

const target = set(TARGET, "Acme sprint 12", "in progress");
const other = set(OTHER, "Acme hotfix", "in progress");
const done = set(DONE, "Acme sprint 11", "complete");
const dflt = set(DEFAULT, "Default", "in progress", { is_default: "true" });

/** Evaluate the simple queries this check emits (`f=v`, `fIN a,b`, `^`, `^OR`). */
function matches(row, query) {
  if (!query) return true;
  if (query.includes("^OR")) {
    return query.split("^OR").some((q) => matches(row, q));
  }
  return query.split("^").every((clause) => {
    const inMatch = /^([\w.]+)IN(.*)$/.exec(clause);
    if (inMatch) return inMatch[2].split(",").includes(String(row[inMatch[1]]));
    const [field, value] = clause.split("=");
    return String(row[field] ?? "") === value;
  });
}

/**
 * Run the check. `sets` / `xmls` seed the two tables; `totalCounts` and
 * `fail` pass straight to the fake.
 */
async function run({
  sets = [target, other, done, dflt],
  xmls = [],
  totalCounts = {},
  fail,
  scope = SCOPE,
  updateSetId,
} = {}) {
  const calls = [];
  const http = createFakeSnClient({
    tables: {
      sys_update_set: sets,
      sys_update_xml: xmls,
      sys_scope: [{ sys_id: SCOPE_SYS_ID, scope: SCOPE }],
    },
    totalCounts,
    queryFilter: (t, rows, params) => {
      calls.push({ table: t, params });
      return rows.filter((r) => matches(r, params?.sysparm_query));
    },
    fail,
  });
  const result = await updateSetCollisions.run({
    instanceUrl: INSTANCE,
    http,
    scope,
    updateSetId,
  });
  assert.equal(result.name, "update-set-collisions");
  assert.ok(!result.message.includes(SENTINEL), result.message);
  for (const c of calls) {
    assert.ok(!/payload/.test(c.params?.sysparm_fields ?? ""), c.params);
    assert.equal(c.params?.sysparm_limit, undefined);
  }
  return { result, calls };
}

const xmlCalls = (calls) => calls.filter((c) => c.table === "sys_update_xml");

test("is registered as a blocker over the update set tables", () => {
  assert.ok(defaultChecks.includes(updateSetCollisions));
  const { meta } = updateSetCollisions;
  assert.equal(meta.rule, undefined);
  assert.equal(meta.severity, "blocker");
  assert.deepEqual(meta.tables, ["sys_update_set", "sys_update_xml"]);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.ok(meta.remediation);
});

test("warns and skips with neither a scope nor an update set id", async () => {
  const { result, calls } = await run({ scope: " " });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope or update set set/);
  assert.equal(calls.length, 0);
});

test("the scope path targets the app's in-progress, non-default sets", async () => {
  const { result, calls } = await run({
    xmls: [xml("sys_script_include_1", target)],
  });
  assert.equal(result.status, "pass", result.message);
  const setReads = calls.filter((c) => c.table === "sys_update_set");
  assert.deepEqual(
    setReads.map((c) => [c.params.sysparm_query, c.params.sysparm_fields]),
    [
      ["is_default=true", "sys_id,name"],
      [`application=${SCOPE_SYS_ID}`, "sys_id,name,state,application"],
    ],
  );
  // `other` is in progress too, so both are targets; `done` and Default are not.
  assert.deepEqual(
    xmlCalls(calls).map((c) => [
      c.params.sysparm_query,
      c.params.sysparm_fields,
    ]),
    [
      [`update_setIN${TARGET},${OTHER}`, "sys_id,name,update_set"],
      [
        "nameINsys_script_include_1",
        "sys_id,name,update_set,update_set.name,update_set.state",
      ],
    ],
  );
});

test("the updateSetId path targets that set only", async () => {
  const { result, calls } = await run({
    updateSetId: TARGET,
    scope: undefined,
    xmls: [xml("sys_script_include_1", target)],
  });
  assert.equal(result.status, "pass", result.message);
  assert.equal(
    result.message,
    "No record in the target update set(s) is captured anywhere else (1 records).",
  );
  assert.equal(result.findings, undefined);
  assert.equal(
    calls.filter((c) => c.table === "sys_update_set").length,
    1,
    "only the Default-set read",
  );
  assert.equal(
    xmlCalls(calls)[0].params.sysparm_query,
    `update_setIN${TARGET}`,
  );
});

test("fails on a collision with another in-progress set", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    xmls: [
      xml("sys_script_include_1", target),
      xml("sys_script_include_2", target),
      xml("sys_script_include_1", other),
      xml("sys_script_include_2", other),
      xml("sys_script_include_2", done),
    ],
  });
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /^2 record\(s\) are also captured in other open update sets: Acme hotfix \(2 records\)\. 1 record\(s\) are already captured in completed update sets: Acme sprint 11 \(1 records\)\.$/,
  );
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.location.recordName, f.status]),
    [
      ["open-collision", "sys_script_include_1", undefined],
      ["open-collision", "sys_script_include_2", undefined],
      ["closed-collision", "sys_script_include_2", "warn"],
    ],
  );
  assert.equal(result.findings[0].location.table, "sys_update_xml");
  assert.equal(
    result.findings[0].location.sysId,
    "x_sys_script_include_1_tttt",
  );
  assert.match(result.findings[0].message, /also in Acme hotfix/);
});

test("warns when the only collisions are with completed sets", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    xmls: [xml("sys_ui_policy_1", target), xml("sys_ui_policy_1", done)],
  });
  assert.equal(result.status, "warn");
  assert.equal(
    result.message,
    "1 record(s) are already captured in completed update sets: Acme sprint 11 (1 records).",
  );
  assert.equal(result.findings.length, 1);
});

test("a collision with a set in another closed state is worded as closed", async () => {
  const ignored = set("i".repeat(32), "Acme parked", "ignore");
  const { result } = await run({
    sets: [target, ignored],
    updateSetId: TARGET,
    xmls: [xml("sys_ui_policy_1", target), xml("sys_ui_policy_1", ignored)],
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /in closed update sets: Acme parked/);
});

test("Default sets are ignored as partners and counted", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    xmls: [xml("sys_script_1", target), xml("sys_script_1", dflt)],
  });
  assert.equal(result.status, "pass", result.message);
  assert.match(
    result.message,
    /\(1 records\)\. 1 record\(s\) also sit in a Default update set \(ignored\)\.$/,
  );
});

test("record keys outside the safe charset are skipped and warned", async () => {
  const { result, calls } = await run({
    updateSetId: TARGET,
    xmls: [xml("sys_script_1", target), xml("bad^ORname=x", target)],
  });
  assert.equal(result.status, "warn");
  assert.equal(
    result.message,
    "1 update record name(s) could not be queried safely.",
  );
  assert.equal(xmlCalls(calls)[1].params.sysparm_query, "nameINsys_script_1");
});

test("a missing dot-walk falls back to reading the partner set by sys_id", async () => {
  const { result, calls } = await run({
    updateSetId: TARGET,
    xmls: [
      xml("sys_script_1", target),
      xml("sys_script_1", other, { bare: true }),
    ],
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /open update sets: Acme hotfix \(1 records\)/);
  const fallback = calls.filter(
    (c) =>
      c.table === "sys_update_set" &&
      c.params.sysparm_query === `sys_idIN${OTHER}`,
  );
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].params.sysparm_fields, "sys_id,name,state");
});

test("a partner set that cannot be read at all is labelled by its sys_id", async () => {
  const ghost = "g".repeat(32);
  const { result } = await run({
    updateSetId: TARGET,
    xmls: [
      xml("sys_script_1", target),
      { sys_id: "x_ghost", name: "sys_script_1", update_set: ghost },
    ],
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, new RegExp(`closed update sets: ${ghost}`));
});

test("101 record keys are queried in two chunks", async () => {
  const xmls = Array.from({ length: 101 }, (_, i) =>
    xml(`sys_script_${i}`, target),
  );
  const { result, calls } = await run({ updateSetId: TARGET, xmls });
  assert.equal(result.status, "pass", result.message);
  const nameReads = xmlCalls(calls).filter((c) =>
    c.params.sysparm_query.startsWith("nameIN"),
  );
  assert.equal(nameReads.length, 2);
  assert.equal(nameReads[0].params.sysparm_query.split(",").length, 100);
});

test("warns when the scope has no in-progress set besides the Default set", async () => {
  const { result } = await run({ sets: [done, dflt] });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No in-progress update set in scope/);
});

test("warns when the instance reports the scope has no update sets", async () => {
  const { result } = await run({
    sets: [],
    totalCounts: { sys_update_set: 0 },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No update sets in scope "x_acme_app"/);
});

test("warns on an ambiguous zero-row update set read", async () => {
  const { result } = await run({ sets: [] });
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count arrived/);
});

test("fails a zero-row update set read that was security-trimmed", async () => {
  const { result } = await run({
    sets: [],
    totalCounts: { sys_update_set: 4 },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /4 match but 0 are visible/);
});

test("passes a target set the instance reports as empty", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    totalCounts: { sys_update_xml: 0 },
  });
  assert.equal(result.status, "pass");
  assert.match(result.message, /carries no records/);
});

test("warns when the target set's records read is ambiguous", async () => {
  const { result } = await run({ updateSetId: TARGET });
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count arrived/);
});

test("fails when the target set's records read is security-trimmed", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    totalCounts: { sys_update_xml: 3 },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /3 match but 0 are visible/);
});

test("fails a partially trimmed read even when no collision is visible", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    xmls: [xml("sys_script_1", target)],
    totalCounts: { sys_update_xml: 9 },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/);
});

test("a trimmed read with a collision notes the list may be incomplete", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    xmls: [xml("sys_script_1", target), xml("sys_script_1", other)],
    totalCounts: { sys_update_xml: 9 },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /Acme hotfix.*may be incomplete/);
});

test("an empty-but-trimmed Default read still fails the gate", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    totalCounts: { sys_update_set: 5, sys_update_xml: 0 },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/);
});

test("an operator-bearing update set id fails closed without an xml read", async () => {
  const { result, calls } = await run({ updateSetId: "x^ORactive=true" });
  assert.equal(result.status, "fail");
  assert.equal(xmlCalls(calls).length, 0);
});

test("an unresolved scope filters by application.scope", async () => {
  const { calls } = await run({ scope: "x_other_app", sets: [] });
  const appRead = calls.find(
    (c) =>
      c.table === "sys_update_set" &&
      c.params.sysparm_query !== "is_default=true",
  );
  assert.equal(appRead.params.sysparm_query, "application.scope=x_other_app");
});

test("maps an auth error to fail", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    fail: { table: { sys_update_set: { auth: true } } },
  });
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /Authentication failed while checking update set collisions/,
  );
});

test("maps a network error to warn", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    fail: { table: { sys_update_xml: { network: true } } },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /Could not reach the instance/);
});

test("maps an HTTP error to warn", async () => {
  const { result } = await run({
    updateSetId: TARGET,
    fail: { table: { sys_update_xml: { http: 403 } } },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 403/);
});
