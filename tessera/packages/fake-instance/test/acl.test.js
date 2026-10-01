// W2 (ADR-007) — the opt-in ACL/role model, and the DEV-14 suite-parameter
// option on `testsuite/run`. Both are OFF by default; the default-path tests
// below pin that nothing changed for a fake built without them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CICD_SUITE_PARAMS,
  W2_AUTHORING_ROLE,
  createFakeInstance,
} from "../build/index.js";

const INPUTS = "/api/now/table/sys_variable_value";
const stepInput = {
  document: "sys_atf_step",
  document_key: "step1",
  variable: "var1",
  value: "gs.info('x');",
};

const post = (fake, path, body) => fake.handle({ method: "POST", path, body });

describe("ACL model — off by default", () => {
  it("a fake without `acl` lets every table write land", async () => {
    const fake = createFakeInstance();
    const created = await post(fake, INPUTS, stepInput);
    assert.equal(created.status, 201);
    const id = created.body.result.sys_id;
    const patched = await fake.handle({
      method: "PATCH",
      path: `${INPUTS}/${id}`,
      body: { value: "y" },
    });
    assert.equal(patched.status, 200);
    const removed = await fake.handle({
      method: "DELETE",
      path: `${INPUTS}/${id}`,
    });
    assert.equal(removed.status, 204);
  });
});

describe("ACL model — W2 rules", () => {
  it("refuses a step-input create with 403 when the caller lacks the role, and writes nothing", async () => {
    const fake = createFakeInstance({ acl: { roles: [] } });
    const res = await post(fake, INPUTS, stepInput);
    assert.equal(res.status, 403);
    assert.match(res.body.error.detail, /x_tessera\.author/);
    assert.equal(fake.tables.query("sys_variable_value").records.length, 0);
  });

  it("refuses write and delete of an existing step input without the role", async () => {
    const fake = createFakeInstance({
      acl: { roles: ["atf_test_designer"] },
      state: { sys_variable_value: [{ sys_id: "v1", ...stepInput }] },
    });
    const patched = await fake.handle({
      method: "PATCH",
      path: `${INPUTS}/v1`,
      body: { value: "changed" },
    });
    assert.equal(patched.status, 403);
    assert.equal(
      fake.tables.get("sys_variable_value", "v1").value,
      stepInput.value,
    );
    const removed = await fake.handle({
      method: "DELETE",
      path: `${INPUTS}/v1`,
    });
    assert.equal(removed.status, 403);
    assert.ok(fake.tables.get("sys_variable_value", "v1"));
  });

  it("allows the same writes to a holder of the W2 role", async () => {
    const fake = createFakeInstance({ acl: { roles: [W2_AUTHORING_ROLE] } });
    const created = await post(fake, INPUTS, stepInput);
    assert.equal(created.status, 201);
    const removed = await fake.handle({
      method: "DELETE",
      path: `${INPUTS}/${created.body.result.sys_id}`,
    });
    assert.equal(removed.status, 204);
  });

  it("applies only to rows whose document is sys_atf_step, and not to other tables", async () => {
    const fake = createFakeInstance({ acl: { roles: [] } });
    const other = await post(fake, INPUTS, {
      ...stepInput,
      document: "sc_cat_item",
    });
    assert.equal(other.status, 201);
    const test = await post(fake, "/api/now/table/sys_atf_test", { name: "t" });
    assert.equal(test.status, 201);
  });

  it("does not gate reads, and a denied request is still logged with its status", async () => {
    const fake = createFakeInstance({
      acl: { roles: [] },
      state: { sys_variable_value: [{ sys_id: "v1", ...stepInput }] },
    });
    const read = await fake.handle({ method: "GET", path: INPUTS });
    assert.equal(read.status, 200);
    assert.equal(read.body.result.length, 1);
    await post(fake, INPUTS, stepInput);
    assert.equal(fake.requests().at(-1).status, 403);
  });

  it("enforces caller-supplied rules instead of the W2 default, with no implicit admin override", async () => {
    const fake = createFakeInstance({
      acl: {
        roles: ["admin"],
        rules: [
          {
            table: "sys_atf_test",
            operation: "create",
            role: "atf_test_designer",
          },
        ],
      },
    });
    const test = await post(fake, "/api/now/table/sys_atf_test", { name: "t" });
    assert.equal(test.status, 403);
    const input = await post(fake, INPUTS, stepInput);
    assert.equal(input.status, 201);
  });
});

describe("DEV-14 — suite parameter names on testsuite/run", () => {
  const run = (fake, params) =>
    fake.handle({ method: "POST", path: "/api/sn_cicd/testsuite/run", params });

  it("defaults to `sys_id` only and refuses the canonical name alone", async () => {
    assert.deepEqual([...DEFAULT_CICD_SUITE_PARAMS], ["sys_id"]);
    const fake = createFakeInstance();
    const res = await run(fake, { test_suite_sys_id: "suite1" });
    assert.equal(res.status, 400);
    assert.equal(
      res.body.error.detail,
      "one of sys_id or test_sys_id is required",
    );
    assert.equal((await run(fake, { sys_id: "suite1" })).status, 200);
  });

  it("accepts `test_suite_sys_id` when opted in, preferring it over the alias", async () => {
    const fake = createFakeInstance({
      cicdSuiteParams: ["test_suite_sys_id", "sys_id"],
    });
    const res = await run(fake, { test_suite_sys_id: "suite1" });
    assert.equal(res.status, 200);
    const both = await run(fake, {
      test_suite_sys_id: "canon",
      sys_id: "alias",
    });
    assert.equal(both.status, 200);
    const started = fake.cicd.peek(both.body.result.links.progress.id);
    assert.equal(started.suiteSysId, "canon");
  });
});
