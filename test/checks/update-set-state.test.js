import { test } from "node:test";
import assert from "node:assert/strict";

import { updateSetState } from "../../build/checks/update-set-state.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";
const SET_ID = "us_abc";

/** Build a run context with the fake client and a given update set id. */
function ctx(http, updateSetId = SET_ID) {
  return { instanceUrl: INSTANCE, http, updateSetId };
}

/**
 * Route batch queries the way a live instance would: `sys_update_set` filtered
 * by `parent=<id>` (child sets), `sys_update_xml` by `update_set=<id>` (a set's
 * change rows). Runs on the raw seeded rows, so it matches the plain
 * `parent` / `update_set` strings the fixtures carry.
 */
function routed(table, rows, params) {
  const q = params?.sysparm_query ?? "";
  if (table === "sys_update_set") {
    const m = /parent=(\S+)/.exec(q);
    if (m) return rows.filter((r) => String(r.parent ?? "") === m[1]);
  }
  if (table === "sys_update_xml") {
    const m = /update_set=(\S+)/.exec(q);
    if (m) return rows.filter((r) => String(r.update_set ?? "") === m[1]);
  }
  return rows;
}

test("update-set-state: warns when no update set is specified", async () => {
  const http = createFakeSnClient();
  const result = await updateSetState.run({ instanceUrl: INSTANCE, http });
  assert.equal(result.name, "update-set-state");
  assert.equal(result.status, "warn");
  assert.match(result.message, /no update set/i);
});

test("update-set-state: warns when updateSetId is blank", async () => {
  const http = createFakeSnClient();
  const result = await updateSetState.run(ctx(http, "   "));
  assert.equal(result.status, "warn");
});

test("update-set-state: the no-update-set message names the real mechanisms (U-1)", async () => {
  const http = createFakeSnClient();
  const result = await updateSetState.run({ instanceUrl: INSTANCE, http });
  assert.equal(result.status, "warn");
  // It must point at the mechanisms that actually exist...
  assert.match(result.message, /SNPF_UPDATE_SET/);
  assert.match(result.message, /updateSetId/);
  assert.match(result.message, /PreflightContext\.updateSetId/);
  // ...and never suggest a non-existent CLI flag.
  assert.doesNotMatch(result.message, /--update-set/);
});

test("update-set-state: passes when set is complete with changes", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [{ sys_id: SET_ID, name: "My set", state: "complete" }],
      sys_update_xml: [{ sys_id: "x1" }, { sys_id: "x2" }],
    },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.name, "update-set-state");
  assert.equal(result.status, "pass");
  assert.match(result.message, /My set/);
  assert.match(result.message, /2 change/);
});

test("update-set-state: fails when set is complete but empty", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        { sys_id: SET_ID, name: "Empty set", state: "complete" },
      ],
      sys_update_xml: [],
    },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "fail");
  assert.match(result.message, /0 changes/);
});

test("update-set-state: fails when set is still in progress", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        { sys_id: SET_ID, name: "WIP set", state: "in progress" },
      ],
      sys_update_xml: [{ sys_id: "x1" }],
    },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "fail");
  assert.match(result.message, /in progress/i);
});

test("update-set-state: fails for the in_progress (underscore) variant", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        { sys_id: SET_ID, name: "WIP set", state: "in_progress" },
      ],
      sys_update_xml: [{ sys_id: "x1" }],
    },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "fail");
});

test("update-set-state: fails when the set does not exist", async () => {
  const http = createFakeSnClient({
    tables: { sys_update_set: [], sys_update_xml: [] },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "fail");
  assert.match(result.message, /not found/i);
});

test("update-set-state: warns when the set carries a base_update_set (merged)", async () => {
  // The merge signal is the `base_update_set` reference, delivered by the Table
  // API as a { link, value } object — never the invented `state: "merged"`.
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        {
          sys_id: SET_ID,
          name: "Merged set",
          state: "complete",
          base_update_set: "us_base",
        },
      ],
      sys_update_xml: [{ sys_id: "x1" }],
    },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "warn");
  assert.match(result.message, /merge/i);
});

test("update-set-state: warns on an unrecognised state", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [{ sys_id: SET_ID, name: "Odd set", state: "weird" }],
      sys_update_xml: [{ sys_id: "x1" }],
    },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "warn");
  assert.match(result.message, /unrecognised|expected/i);
});

test("update-set-state: SN-3 — an 'ignore' set fails as explicitly do-not-migrate", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        { sys_id: SET_ID, name: "Do not ship", state: "ignore" },
      ],
      sys_update_xml: [{ sys_id: "x1" }],
    },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "fail");
  assert.match(result.message, /ignore/i);
  assert.match(result.message, /do-not-migrate/i);
  // It must NOT nag the author to "finish"/"complete" a deliberately-excluded set.
  assert.doesNotMatch(result.message, /complete it|finish/i);
});

test("update-set-state: SN-2 — a complete parent fails on an in-progress child", async () => {
  // The parent container is `complete` with no changes of its own; a child set
  // is still `in progress`. Following `parent` links is what stops the parent
  // from masking the unfinished child.
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        { sys_id: "us_parent", name: "Parent", state: "complete" },
        {
          sys_id: "us_child",
          name: "Child",
          state: "in progress",
          parent: "us_parent",
        },
      ],
      sys_update_xml: [{ sys_id: "x1", update_set: "us_child" }],
    },
    queryFilter: routed,
  });
  const result = await updateSetState.run(ctx(http, "us_parent"));
  assert.equal(result.status, "fail");
  assert.match(result.message, /in progress/i);
  assert.match(result.message, /Child/);
});

test("update-set-state: SN-2 — a container parent with changed children is not 'empty'", async () => {
  // The parent holds 0 change rows itself but its complete children carry the
  // changes — the batch has something to deploy, so this must pass, not fail
  // "0 changes".
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        { sys_id: "us_parent", name: "Parent", state: "complete" },
        {
          sys_id: "us_child",
          name: "Child",
          state: "complete",
          parent: "us_parent",
        },
      ],
      sys_update_xml: [
        { sys_id: "x1", update_set: "us_child" },
        { sys_id: "x2", update_set: "us_child" },
      ],
    },
    queryFilter: routed,
  });
  const result = await updateSetState.run(ctx(http, "us_parent"));
  assert.equal(result.status, "pass");
  assert.match(result.message, /2 change/);
  assert.match(result.message, /2 sets/);
});

test("update-set-state: SN-2 — recursion reaches an in-progress grandchild", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [
        { sys_id: "us_parent", name: "Parent", state: "complete" },
        {
          sys_id: "us_child",
          name: "Child",
          state: "complete",
          parent: "us_parent",
        },
        {
          sys_id: "us_grandchild",
          name: "Grandchild",
          state: "in progress",
          parent: "us_child",
        },
      ],
      sys_update_xml: [
        { sys_id: "x1", update_set: "us_child" },
        { sys_id: "x2", update_set: "us_grandchild" },
      ],
    },
    queryFilter: routed,
  });
  const result = await updateSetState.run(ctx(http, "us_parent"));
  assert.equal(result.status, "fail");
  assert.match(result.message, /Grandchild/);
});

test("update-set-state: fails on an auth error", async () => {
  const http = createFakeSnClient({
    tables: { sys_update_set: [], sys_update_xml: [] },
    fail: { auth: true },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "fail");
  assert.match(result.message, /authoriz/i);
});

test("update-set-state: warns on a transient network error", async () => {
  const http = createFakeSnClient({
    tables: { sys_update_set: [], sys_update_xml: [] },
    fail: { network: true },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "warn");
  assert.match(result.message, /reach|transient/i);
});

test("update-set-state: fails on an HTTP error", async () => {
  const http = createFakeSnClient({
    tables: { sys_update_set: [], sys_update_xml: [] },
    fail: { http: 500 },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "fail");
  assert.match(result.message, /HTTP 500/);
});

test("update-set-state: never throws — always returns a well-formed result", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [{ sys_id: SET_ID, name: "Set", state: "complete" }],
      sys_update_xml: [{ sys_id: "x1" }],
    },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(typeof result.name, "string");
  assert.ok(["pass", "warn", "fail"].includes(result.status));
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
});
