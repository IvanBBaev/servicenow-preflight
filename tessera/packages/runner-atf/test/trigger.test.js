// Starting one suite execution — DEV-14.
//
// The first block is the reason this module exists. The vendored client posts
// the suite sys_id as `sys_id`; the CI/CD test-suite endpoint reads
// `test_suite_sys_id`. Getting that wrong does not fail loudly — the endpoint
// answers, a run starts, and the results belong to whatever the instance
// decided to run. So the assertion is made against the request the instance
// actually received (`instance.requests()`), not against the constant the
// module exports: a test that compares the module to itself would still pass
// with the parameter never reaching the wire at all.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "@tessera/fake-instance";
import { ServiceNowError } from "@tessera/sn-client";

import {
  AtfInfrastructureError,
  CICD_TESTSUITE_RUN_PATH,
  SUITE_TRIGGER_ALIAS_PARAM,
  SUITE_TRIGGER_PARAM,
  parseRunHandle,
  triggerSuite,
} from "../build/index.js";

import {
  SUITE_ID,
  assertInfraFault,
  assertNormalisedFault,
  fakeClient,
  scriptedClient,
} from "./support.js";

/** Trigger once against a fake instance and hand back what it received. */
async function triggerOnce(options, instanceOptions = {}) {
  const instance = createFakeInstance(instanceOptions);
  const client = fakeClient(instance);
  const handle = await triggerSuite(client, SUITE_ID, options);
  const sent = instance.requests();
  assert.equal(sent.length, 1);
  return { handle, request: sent[0], instance };
}

describe("triggerSuite — the wire (DEV-14)", () => {
  it("posts the suite sys_id under `test_suite_sys_id`", async () => {
    const { request } = await triggerOnce();
    assert.equal(request.method, "POST");
    assert.equal(request.path, CICD_TESTSUITE_RUN_PATH);
    assert.equal(request.params["test_suite_sys_id"], SUITE_ID);
  });

  it("names that parameter the same way the module says it does", () => {
    assert.equal(SUITE_TRIGGER_PARAM, "test_suite_sys_id");
    assert.notEqual(SUITE_TRIGGER_PARAM, "sys_id");
  });

  it("also sends the `sys_id` alias, carrying the identical value", async () => {
    const { request } = await triggerOnce();
    assert.equal(SUITE_TRIGGER_ALIAS_PARAM, "sys_id");
    assert.equal(request.params[SUITE_TRIGGER_ALIAS_PARAM], SUITE_ID);
    assert.equal(
      request.params[SUITE_TRIGGER_ALIAS_PARAM],
      request.params[SUITE_TRIGGER_PARAM],
      "the two names must never drift apart — that is the whole risk",
    );
  });

  it("sends no run-id tag unless one is configured; inventing a parameter would be a lie about what the instance recorded", async () => {
    const { request } = await triggerOnce();
    assert.deepEqual(Object.keys(request.params).sort(), [
      "sys_id",
      "test_suite_sys_id",
    ]);
  });

  it("tags the execution when the transport understands a run-id parameter", async () => {
    const { request } = await triggerOnce({
      runIdParam: "tessera_run_id",
      runId: "run-2026-08-21-000001",
    });
    assert.equal(request.params["tessera_run_id"], "run-2026-08-21-000001");
  });

  it("omits the tag when the parameter is named but the value is empty", async () => {
    const { request } = await triggerOnce({
      runIdParam: "tessera_run_id",
      runId: "",
    });
    assert.equal("tessera_run_id" in request.params, false);
  });

  it("does not duplicate the parameter when the alias is set to the canonical name", async () => {
    const client = scriptedClient(() => ({
      data: { result: { links: { progress: { id: "e1" } } } },
    }));
    await triggerSuite(client, SUITE_ID, { aliasParam: SUITE_TRIGGER_PARAM });
    assert.deepEqual([...client.calls[0].params.keys()], [SUITE_TRIGGER_PARAM]);
  });

  it("accepts a different alias name, so a live capture can move it without a code change", async () => {
    const client = scriptedClient(() => ({
      data: { result: { links: { progress: { id: "e1" } } } },
    }));
    await triggerSuite(client, SUITE_ID, { aliasParam: "suite_sys_id" });
    assert.equal(client.paramsOf(0)["suite_sys_id"], SUITE_ID);
    assert.equal(client.paramsOf(0)[SUITE_TRIGGER_PARAM], SUITE_ID);
  });

  it("`aliasParam: null` sends the canonical name only — and the fake router proves the alias is load-bearing there", async () => {
    const instance = createFakeInstance();
    const client = fakeClient(instance);
    // The fake's router was derived from the vendored client and keys on
    // `sys_id`. Without the alias it answers 400, which is exactly why the
    // workaround exists — and why removing it needs a live capture first.
    await assert.rejects(
      triggerSuite(client, SUITE_ID, { aliasParam: null }),
      (error) => {
        assert.equal(error.status, 400);
        return true;
      },
    );
    assert.deepEqual(Object.keys(instance.requests()[0].params), [
      SUITE_TRIGGER_PARAM,
    ]);
  });
});

describe("triggerSuite — the handle", () => {
  it("returns the progress id the CI/CD envelope carried", async () => {
    const { handle, instance } = await triggerOnce();
    assert.ok(handle.executionId);
    assert.equal(handle.status, "0");
    assert.equal(handle.statusLabel, "Pending");
    assert.ok(handle.progressUrl.includes(handle.executionId));
    // The fake really started a run under that id.
    assert.ok(instance.cicd.peek(handle.executionId));
  });
});

describe("triggerSuite — DEV-1 faults", () => {
  it("refuses an empty suite sys_id without issuing a request", async () => {
    const client = scriptedClient(() => {
      throw new Error("no request should have been made");
    });
    await assertInfraFault(triggerSuite(client, "   "), /empty suite sys_id/);
    assert.equal(client.calls.length, 0);
  });

  it("rejects when the response carries no progress id, naming the HTTP status", async () => {
    const client = scriptedClient(() => ({
      data: { result: { status: "0", links: {} } },
      status: 200,
    }));
    await assertInfraFault(
      triggerSuite(client, SUITE_ID),
      /carried no progress id \(HTTP 200\)/,
    );
  });

  it("rejects on a body that is not the envelope at all (a login page, say)", async () => {
    const client = scriptedClient(() => ({ data: "<html>login</html>" }));
    await assertInfraFault(triggerSuite(client, SUITE_ID));
  });

  it("normalises a transport failure into the DEV-1 fault, keeping the original as `cause`", async () => {
    // A socket error has no status, so the fault must not invent one — the
    // absence of a status is itself the signal that nothing was answered.
    const boom = new Error("socket hang up");
    const client = scriptedClient(() => {
      throw boom;
    });
    await assertNormalisedFault(triggerSuite(client, SUITE_ID), {
      cause: boom,
      message: /trigger of ATF suite .* failed: Error: socket hang up/,
    });
    await assert.rejects(triggerSuite(client, SUITE_ID), (error) => {
      assert.equal(error.status, undefined, "no response, so no status");
      return true;
    });
  });

  it("normalises an HTTP error, lifting the status and quoting the instance's own text", async () => {
    // The point of the wrap is that this stays debuggable: a 401 must still
    // read as a 401, and the parsed ServiceNow body must still be an object on
    // `cause.detail` rather than something scraped back out of a string.
    const instance = createFakeInstance();
    instance.faults.add({
      match: { path: CICD_TESTSUITE_RUN_PATH },
      mode: { kind: "http-error", status: 401 },
    });
    await assertNormalisedFault(triggerSuite(fakeClient(instance), SUITE_ID), {
      status: 401,
      message: /\(HTTP 401\) failed: ServiceNowError: .*401/,
    });
  });

  it("does not leak the transport's error type — a caller need not know one exists", async () => {
    // The whole ruling in one assertion: nothing about `@tessera/sn-client`
    // reaches a caller of this module. `cause` is where it lives now.
    const instance = createFakeInstance();
    instance.faults.add({
      match: { path: CICD_TESTSUITE_RUN_PATH },
      mode: { kind: "http-error", status: 403 },
    });
    await assert.rejects(
      triggerSuite(fakeClient(instance), SUITE_ID),
      (error) => {
        assert.equal(error instanceof ServiceNowError, false);
        assert.ok(error instanceof AtfInfrastructureError);
        assert.ok(
          error.cause instanceof ServiceNowError,
          "kept, not discarded",
        );
        return true;
      },
    );
  });
});

describe("parseRunHandle", () => {
  const envelope = (result) => ({ result });

  it("reads every field of the shared CI/CD envelope", () => {
    const handle = parseRunHandle(
      envelope({
        status: "1",
        status_label: "Running",
        status_message: "in flight",
        percent_complete: "42",
        links: { progress: { id: "exec-1", url: "https://x/api/y/exec-1" } },
      }),
    );
    assert.deepEqual(handle, {
      executionId: "exec-1",
      status: "1",
      statusLabel: "Running",
      statusMessage: "in flight",
      percentComplete: 42,
      progressUrl: "https://x/api/y/exec-1",
    });
  });

  it("degrades a non-numeric percentage to 0 rather than letting NaN into a report", () => {
    const handle = parseRunHandle(
      envelope({
        percent_complete: "soon",
        links: { progress: { id: "exec-1" } },
      }),
    );
    assert.equal(handle.percentComplete, 0);
  });

  it("returns undefined for every shape that cannot be polled", () => {
    assert.equal(parseRunHandle(undefined), undefined);
    assert.equal(parseRunHandle({}), undefined, "no result");
    assert.equal(parseRunHandle(envelope([])), undefined, "result is an array");
    assert.equal(parseRunHandle(envelope({})), undefined, "no links");
    assert.equal(
      parseRunHandle(envelope({ links: { progress: {} } })),
      undefined,
      "no id",
    );
    assert.equal(
      parseRunHandle(envelope({ links: { progress: { id: "" } } })),
      undefined,
      "empty id",
    );
  });
});
