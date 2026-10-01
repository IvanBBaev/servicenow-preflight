// QA-18 / DESIGN §4b — crash injection. W1 (intend -> write) must leave the
// instance clean; W2 (write -> confirm) must leave an orphan the caller cannot
// name. Both are asserted against real state, which is the whole point of a
// stateful fake.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  FakeAbortError,
  FakeTransportError,
  createFakeInstance,
  createFaultRegistry,
} from "../build/index.js";

const TABLE = "/api/now/table/sys_atf_test";

let fake;
beforeEach(() => {
  fake = createFakeInstance({
    state: { sys_atf_test: [{ sys_id: "aaa1", name: "persistent" }] },
  });
});

const create = (name = "tessera-RUN1 ephemeral") =>
  fake.handle({ method: "POST", path: TABLE, body: { name } });

describe("W1 — http-error: the mutation must not land", () => {
  it("answers the injected status and writes nothing", async () => {
    fake.faults.add({
      match: { method: "POST", table: "sys_atf_test" },
      mode: { kind: "http-error", status: 403, message: "ACL denied" },
    });
    const res = await create();
    assert.equal(res.status, 403);
    assert.equal(res.body.error.message, "ACL denied");
    assert.equal(fake.tables.count("sys_atf_test"), 1);
    assert.deepEqual(fake.tables.recordsForRun("RUN1"), []);
  });

  it("carries a caller-supplied body verbatim", async () => {
    fake.faults.add({
      match: { path: TABLE },
      mode: { kind: "http-error", status: 500, body: { custom: true } },
    });
    const res = await create();
    assert.deepEqual(res.body, { custom: true });
  });

  it("records the fault id on the request log", async () => {
    fake.faults.add({
      id: "w1",
      match: { method: "POST" },
      mode: { kind: "http-error", status: 500 },
    });
    await create();
    assert.equal(fake.requests()[0].fault, "w1");
    assert.deepEqual(fake.faults.history(), ["w1"]);
  });
});

describe("W1 — transport-error: the connection drops before the write", () => {
  it("rejects and writes nothing", async () => {
    fake.faults.add({
      match: { method: "POST" },
      mode: { kind: "transport-error", message: "socket hang up" },
    });
    await assert.rejects(create(), (error) => {
      assert.ok(error instanceof FakeTransportError);
      assert.equal(error.message, "socket hang up");
      return true;
    });
    assert.equal(fake.tables.count("sys_atf_test"), 1);
  });
});

describe("W2 — crash-after-write: the record exists, the caller cannot name it", () => {
  it("applies the write, then drops the connection", async () => {
    fake.faults.add({
      match: { method: "POST", table: "sys_atf_test" },
      mode: { kind: "crash-after-write" },
    });
    await assert.rejects(create(), FakeTransportError);
    // The orphan is really there — this is what the sweep has to reclaim.
    const orphans = fake.tables.recordsForRun("RUN1");
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].record.name, "tessera-RUN1 ephemeral");
    assert.equal(fake.tables.count("sys_atf_test"), 2);
  });

  it("can crash with an HTTP status instead of a dropped socket", async () => {
    fake.faults.add({
      match: { method: "POST" },
      mode: { kind: "crash-after-write", status: 502, message: "gateway died" },
    });
    const res = await create();
    assert.equal(res.status, 502);
    assert.equal(res.body.error.message, "gateway died");
    // The caller sees an error but never the sys_id of the row that landed.
    assert.equal(fake.tables.count("sys_atf_test"), 2);
  });

  it("crashes an update after it mutated the row", async () => {
    fake.faults.add({
      match: { method: "PATCH", sysId: "aaa1" },
      mode: { kind: "crash-after-write" },
    });
    await assert.rejects(
      fake.handle({
        method: "PATCH",
        path: `${TABLE}/aaa1`,
        body: { name: "mutated" },
      }),
      FakeTransportError,
    );
    assert.equal(fake.tables.get("sys_atf_test", "aaa1").name, "mutated");
  });

  it("crashes a delete after it removed the row", async () => {
    fake.faults.add({
      match: { method: "DELETE" },
      mode: { kind: "crash-after-write" },
    });
    await assert.rejects(
      fake.handle({ method: "DELETE", path: `${TABLE}/aaa1` }),
      FakeTransportError,
    );
    assert.equal(fake.tables.get("sys_atf_test", "aaa1"), undefined);
  });
});

describe("hang — DEV-2's poll deadline", () => {
  it("completes normally after the delay when ms is given", async () => {
    fake.faults.add({
      match: { method: "GET" },
      mode: { kind: "hang", ms: 5 },
    });
    const res = await fake.handle({ method: "GET", path: TABLE });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.length, 1);
  });

  it("never settles until the caller's signal aborts", async () => {
    fake.faults.add({ match: { method: "GET" }, mode: { kind: "hang" } });
    const controller = new AbortController();
    const pending = fake.handle({
      method: "GET",
      path: TABLE,
      signal: controller.signal,
    });
    controller.abort(new FakeAbortError("deadline exceeded"));
    await assert.rejects(pending, (error) => {
      // core/http.ts branches on name === "TimeoutError" | "AbortError".
      assert.equal(error.name, "TimeoutError");
      assert.equal(error.message, "deadline exceeded");
      return true;
    });
  });

  it("falls back to its own abort error when the reason is not an Error", async () => {
    fake.faults.add({ match: { method: "GET" }, mode: { kind: "hang" } });
    const controller = new AbortController();
    const pending = fake.handle({
      method: "GET",
      path: TABLE,
      signal: controller.signal,
    });
    controller.abort("stop");
    await assert.rejects(pending, FakeAbortError);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    fake.faults.add({ match: { method: "GET" }, mode: { kind: "hang" } });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fake.handle({ method: "GET", path: TABLE, signal: controller.signal }),
      (error) => error instanceof Error,
    );
    // No fault was consumed: the abort short-circuits ahead of the registry.
    assert.deepEqual(fake.faults.history(), []);
  });
});

describe("rule matching and budgets", () => {
  it("fires at most `times` times, then lets the request through", async () => {
    fake.faults.add({
      match: { method: "POST", times: 1 },
      mode: { kind: "http-error", status: 500 },
    });
    assert.equal((await create()).status, 500);
    assert.equal((await create()).status, 201);
    assert.equal(fake.faults.list()[0].fired, 1);
    assert.equal(fake.faults.list()[0].remaining, 0);
  });

  it("matches on method, table, sysId and a path RegExp", () => {
    const registry = createFaultRegistry();
    registry.add({
      id: "by-sys-id",
      match: { sysId: "aaa1" },
      mode: { kind: "http-error", status: 409 },
    });
    registry.add({
      id: "by-regexp",
      match: { path: /sn_cicd/, method: ["POST", "GET"] },
      mode: { kind: "transport-error" },
    });
    assert.equal(
      registry.take({ method: "GET", path: "/x", table: "t", sysId: "aaa2" }),
      undefined,
    );
    assert.equal(
      registry.take({ method: "GET", path: "/x", table: "t", sysId: "aaa1" })
        .kind,
      "http-error",
    );
    assert.equal(
      registry.take({ method: "POST", path: "/api/sn_cicd/testsuite/run" })
        .kind,
      "transport-error",
    );
    assert.equal(
      registry.take({ method: "DELETE", path: "/api/sn_cicd/testsuite/run" }),
      undefined,
    );
    assert.deepEqual(registry.history(), ["by-sys-id", "by-regexp"]);
  });

  it("evaluates in insertion order, first match wins", async () => {
    fake.faults.add({
      id: "first",
      match: {},
      mode: { kind: "http-error", status: 418 },
    });
    fake.faults.add({
      id: "second",
      match: {},
      mode: { kind: "http-error", status: 500 },
    });
    assert.equal((await create()).status, 418);
    assert.deepEqual(fake.faults.history(), ["first"]);
  });

  it("removes rules and rejects duplicate ids", () => {
    const registry = createFaultRegistry();
    registry.add({ id: "dup", match: {}, mode: { kind: "hang", ms: 1 } });
    assert.throws(
      () => registry.add({ id: "dup", match: {}, mode: { kind: "hang" } }),
      /already registered/,
    );
    assert.equal(registry.remove("dup"), true);
    assert.equal(registry.remove("dup"), false);
    assert.deepEqual(registry.list(), []);
  });

  it("derives an id when none is supplied and clears everything", () => {
    const registry = createFaultRegistry();
    assert.equal(
      registry.add({ match: {}, mode: { kind: "http-error", status: 500 } }),
      "fault-1",
    );
    assert.equal(
      registry.add({ match: {}, mode: { kind: "http-error", status: 500 } }),
      "fault-2",
    );
    registry.take({ method: "GET", path: "/x" });
    registry.clear();
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(registry.history(), []);
  });

  it("leaves untargeted requests alone", async () => {
    fake.faults.add({
      match: { table: "sys_atf_test_suite" },
      mode: { kind: "http-error", status: 500 },
    });
    assert.equal((await create()).status, 201);
    assert.deepEqual(fake.faults.history(), []);
  });
});
