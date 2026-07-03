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

test("update-set-state: warns on a merged set state", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [{ sys_id: SET_ID, name: "Merged set", state: "merged" }],
      sys_update_xml: [{ sys_id: "x1" }],
    },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "warn");
  assert.match(result.message, /collision|merge/i);
});

test("update-set-state: warns when a change row is flagged as a collision", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_update_set: [{ sys_id: SET_ID, name: "Set", state: "complete" }],
      sys_update_xml: [{ sys_id: "x1", disposition: "collision" }],
    },
  });
  const result = await updateSetState.run(ctx(http));
  assert.equal(result.status, "warn");
  assert.match(result.message, /collision|merge/i);
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
