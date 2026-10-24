import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createReadCache,
  deepFreeze,
  readKey,
} from "../../build/http/cache.js";

/** A load the test settles by hand; records the signal it was given. */
function deferredLoad() {
  const load = (signal) => {
    load.calls += 1;
    load.signal = signal;
    return new Promise((resolve, reject) => {
      load.resolve = resolve;
      load.reject = reject;
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  load.calls = 0;
  return load;
}

test("the same key shares one load and yields equal results", async () => {
  const cache = createReadCache();
  const load = deferredLoad();
  const a = cache.get("k", load);
  const b = cache.get("k", load);
  load.resolve({ rows: [1] });
  assert.deepEqual(await a, { rows: [1] });
  assert.deepEqual(await b, { rows: [1] });
  // A settled entry still answers later reads.
  assert.deepEqual(await cache.get("k", load), { rows: [1] });
  assert.equal(load.calls, 1);
  assert.deepEqual(cache.stats(), { hits: 2, misses: 1 });
});

test("different keys load separately", async () => {
  const cache = createReadCache();
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await cache.get("a", load), 1);
  assert.equal(await cache.get("b", load), 2);
});

test("a rejected load reaches every waiter and is evicted", async () => {
  const cache = createReadCache();
  const load = deferredLoad();
  const a = cache.get("k", load);
  const b = cache.get("k", load);
  load.reject(new Error("truncated"));
  await assert.rejects(a, /truncated/);
  await assert.rejects(b, /truncated/);
  assert.equal(await cache.get("k", async () => "fresh"), "fresh");
});

test("one caller's abort does not fail the other waiters", async () => {
  const cache = createReadCache();
  const load = deferredLoad();
  const quitter = new AbortController();
  const stayer = new AbortController();
  const a = cache.get("k", load, quitter.signal);
  const b = cache.get("k", load, stayer.signal);
  quitter.abort(new Error("check timed out"));
  await assert.rejects(a, /check timed out/);
  assert.equal(load.signal.aborted, false);
  load.resolve("value");
  assert.equal(await b, "value");
});

test("the load is aborted and evicted once every waiter gave up", async () => {
  const cache = createReadCache();
  const load = deferredLoad();
  const one = new AbortController();
  const two = new AbortController();
  const a = cache.get("k", load, one.signal);
  const b = cache.get("k", load, two.signal);
  one.abort(new Error("one"));
  two.abort(new Error("two"));
  await assert.rejects(a, /one/);
  await assert.rejects(b, /two/);
  assert.equal(load.signal.aborted, true);
  // The next read starts over instead of joining the aborted load.
  assert.equal(await cache.get("k", async () => "again"), "again");
});

test("a waiter without a signal keeps the load alive", async () => {
  const cache = createReadCache();
  const load = deferredLoad();
  const quitter = new AbortController();
  const a = cache.get("k", load, quitter.signal);
  const b = cache.get("k", load);
  quitter.abort(new Error("bye"));
  await assert.rejects(a, /bye/);
  assert.equal(load.signal.aborted, false);
  load.resolve(7);
  assert.equal(await b, 7);
});

test("an already-aborted signal rejects without loading", async () => {
  const cache = createReadCache();
  const controller = new AbortController();
  controller.abort(new Error("early"));
  let calls = 0;
  await assert.rejects(
    cache.get("k", async () => ++calls, controller.signal),
    /early/,
  );
  assert.equal(calls, 0);
});

test("readKey ignores parameter order, field order and blank values", () => {
  const base = readKey("incident", {
    sysparm_query: "active=true",
    sysparm_fields: "number,sys_id",
  });
  assert.equal(
    readKey("incident", {
      sysparm_fields: " sys_id , number,",
      sysparm_display_value: "",
      sysparm_query: "active=true ",
    }),
    base,
  );
  assert.notEqual(
    readKey("problem", {
      sysparm_query: "active=true",
      sysparm_fields: "number,sys_id",
    }),
    base,
  );
  assert.notEqual(
    readKey("incident", {
      sysparm_query: "active=true",
      sysparm_fields: "number",
    }),
    base,
  );
  assert.notEqual(
    readKey("incident", {
      sysparm_query: "active=true",
      sysparm_fields: "number,sys_id",
      sysparm_display_value: "true",
    }),
    base,
  );
  assert.equal(readKey("incident"), readKey("incident", {}));
});

test("deepFreeze freezes nested rows", () => {
  const value = deepFreeze({ rows: [{ a: { value: "1" } }] });
  assert.ok(Object.isFrozen(value.rows));
  assert.ok(Object.isFrozen(value.rows[0].a));
  assert.equal(deepFreeze(null), null);
  assert.equal(deepFreeze("s"), "s");
});
