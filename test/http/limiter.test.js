import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLimiter,
  limitProblem,
  MAX_IN_FLIGHT_RANGE,
  RPS_RANGE,
} from "../../build/http/limiter.js";

/** A manual clock: `sleep` resolves only when `advance` moves time past it. */
function fakeClock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    sleep: (ms) =>
      new Promise((resolve) => timers.push({ at: t + ms, resolve })),
    async advance(ms) {
      t += ms;
      for (const timer of timers.filter((x) => x.at <= t)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.resolve();
      }
      await settle();
    },
    pending: () => timers.length,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Start `n` acquires and track which were granted. */
function acquireMany(limiter, n, signal) {
  const granted = [];
  const releases = [];
  const promises = Array.from({ length: n }, (_, i) =>
    limiter.acquire(signal).then((release) => {
      granted.push(i);
      releases[i] = release;
      return release;
    }),
  );
  return { granted, releases, promises };
}

test("the in-flight cap holds back acquires until a slot is released", async () => {
  const limiter = createLimiter({ maxInFlight: 2 });
  const { granted, releases } = acquireMany(limiter, 5);
  await settle();
  assert.deepEqual(granted, [0, 1]);
  releases[0]();
  await settle();
  assert.deepEqual(granted, [0, 1, 2]);
  // Release is idempotent: a double call frees one slot, not two.
  releases[0]();
  await settle();
  assert.deepEqual(granted, [0, 1, 2]);
  releases[1]();
  releases[2]();
  await settle();
  assert.deepEqual(granted, [0, 1, 2, 3, 4]);
});

test("tokens refill at the rps rate, one at a time", async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ rps: 2, now: clock.now, sleep: clock.sleep });
  const { granted, releases } = acquireMany(limiter, 4);
  await settle();
  assert.deepEqual(granted, [0]);
  releases[0]();
  await clock.advance(499);
  assert.deepEqual(granted, [0]);
  await clock.advance(1);
  assert.deepEqual(granted, [0, 1]);
  await clock.advance(500);
  await clock.advance(500);
  assert.deepEqual(granted, [0, 1, 2, 3]);
});

test("an idle bucket does not save up a burst", async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ rps: 1, now: clock.now, sleep: clock.sleep });
  await clock.advance(10_000);
  const { granted } = acquireMany(limiter, 3);
  await settle();
  assert.deepEqual(granted, [0]);
});

test("pause blocks new grants until the window passes", async () => {
  const clock = fakeClock();
  const limiter = createLimiter({
    maxInFlight: 4,
    now: clock.now,
    sleep: clock.sleep,
  });
  limiter.pause(1000);
  limiter.pause(10); // a shorter pause never shortens the window
  limiter.pause(0);
  const { granted } = acquireMany(limiter, 2);
  await settle();
  assert.deepEqual(granted, []);
  await clock.advance(999);
  assert.deepEqual(granted, []);
  await clock.advance(1);
  assert.deepEqual(granted, [0, 1]);
});

test("an aborted acquire rejects and leaves the queue", async () => {
  const limiter = createLimiter({ maxInFlight: 1 });
  const first = await limiter.acquire();
  const controller = new AbortController();
  const queued = limiter.acquire(controller.signal);
  const next = limiter.acquire();
  controller.abort(new Error("gave up"));
  await assert.rejects(queued, { message: "gave up" });
  first();
  // The slot goes to the next waiter, not to the one that left.
  const release = await next;
  release();

  const pre = new AbortController();
  pre.abort(new Error("already"));
  await assert.rejects(limiter.acquire(pre.signal), { message: "already" });
});

test("a release in finally frees the slot when the work throws", async () => {
  const limiter = createLimiter({ maxInFlight: 1 });
  const work = async () => {
    const release = await limiter.acquire();
    try {
      throw new Error("boom");
    } finally {
      release();
    }
  };
  await assert.rejects(work(), /boom/);
  await assert.rejects(work(), /boom/);
});

test("without limits every acquire is granted at once", async () => {
  const limiter = createLimiter();
  const { granted } = acquireMany(limiter, 100);
  await settle();
  assert.equal(granted.length, 100);
});

test("the default timer wakes a waiting acquire", async () => {
  const limiter = createLimiter({ rps: 100 });
  const first = await limiter.acquire();
  first();
  // E-1: no elapsed-time assert. The bucket is empty, so the second acquire
  // must stay pending through a microtask drain (no timer can fire inside
  // one) and be granted only by the default timer.
  let granted = false;
  const second = limiter.acquire().then((release) => {
    granted = true;
    return release;
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(granted, false);
  (await second)();
  assert.equal(granted, true);
});

test("limitProblem enforces the documented ranges", () => {
  assert.equal(limitProblem("maxInFlight", MAX_IN_FLIGHT_RANGE.min), undefined);
  assert.equal(limitProblem("maxInFlight", MAX_IN_FLIGHT_RANGE.max), undefined);
  for (const bad of [0, 65, 1.5, Number.NaN]) {
    assert.match(
      limitProblem("maxInFlight", bad),
      /whole number between 1 and 64/,
    );
  }
  assert.equal(limitProblem("rps", RPS_RANGE.min), undefined);
  assert.equal(limitProblem("rps", 2.5), undefined);
  for (const bad of [0, 0.4, 101, Number.POSITIVE_INFINITY]) {
    assert.match(limitProblem("rps", bad), /between 0.5 and 100/);
  }
});
