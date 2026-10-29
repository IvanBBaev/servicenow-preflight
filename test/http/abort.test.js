import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anySignal,
  abortReason,
  raceAbort,
  sleep,
  systemClock,
} from "../../build/http/abort.js";

test("anySignal drops undefined and returns a lone signal as is", () => {
  assert.equal(anySignal([]), undefined);
  assert.equal(anySignal([undefined, undefined]), undefined);
  const only = new AbortController().signal;
  assert.equal(anySignal([undefined, only]), only);
});

test("anySignal follows whichever source aborts first", () => {
  const a = new AbortController();
  const b = new AbortController();
  const merged = anySignal([a.signal, b.signal]);
  assert.equal(merged.aborted, false);
  b.abort("b-reason");
  assert.equal(merged.aborted, true);
  assert.equal(merged.reason, "b-reason");
});

for (const preAborted of [false, true]) {
  test(`anySignal falls back without AbortSignal.any (pre-aborted: ${preAborted})`, () => {
    const real = AbortSignal.any;
    AbortSignal.any = undefined;
    try {
      const a = new AbortController();
      const b = new AbortController();
      if (preAborted) a.abort("early");
      const merged = anySignal([a.signal, b.signal]);
      if (preAborted) {
        assert.equal(merged.aborted, true);
        assert.equal(merged.reason, "early");
        return;
      }
      assert.equal(merged.aborted, false);
      a.abort("late");
      b.abort("ignored");
      assert.equal(merged.aborted, true);
      assert.equal(merged.reason, "late");
    } finally {
      AbortSignal.any = real;
    }
  });
}

test("abortReason normalises every kind of reason to an Error", () => {
  const withError = new AbortController();
  const boom = new Error("boom");
  withError.abort(boom);
  assert.equal(abortReason(withError.signal), boom);

  const withString = new AbortController();
  withString.abort("stop");
  const s = abortReason(withString.signal);
  assert.equal(s.name, "AbortError");
  assert.equal(s.message, "stop");

  const withObject = new AbortController();
  withObject.abort({ odd: true });
  assert.equal(
    abortReason(withObject.signal).message,
    "The operation was aborted.",
  );

  // The default reason is a DOMException, which is an Error.
  const plain = new AbortController();
  plain.abort();
  assert.equal(abortReason(plain.signal).name, "AbortError");
});

test("raceAbort passes values and errors through when no abort happens", async () => {
  assert.equal(await raceAbort(Promise.resolve(1), undefined), 1);
  const signal = new AbortController().signal;
  assert.equal(await raceAbort(Promise.resolve(2), signal), 2);
  await assert.rejects(raceAbort(Promise.reject(new Error("x")), signal), /x/);
  await assert.rejects(raceAbort(Promise.reject("raw"), signal), /raw/);
});

test("raceAbort rejects on abort and swallows the abandoned rejection", async () => {
  const pre = new AbortController();
  pre.abort("pre");
  await assert.rejects(
    raceAbort(Promise.reject(new Error("late")), pre.signal),
    {
      message: "pre",
    },
  );

  const mid = new AbortController();
  let rejectInner;
  const inner = new Promise((_, reject) => (rejectInner = reject));
  const raced = raceAbort(inner, mid.signal);
  mid.abort("mid");
  await assert.rejects(raced, { message: "mid" });
  rejectInner(new Error("after the race"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("sleep resolves, or rejects early on abort", async () => {
  await sleep(1);
  await sleep(1, new AbortController().signal);

  const pre = new AbortController();
  pre.abort("pre");
  await assert.rejects(sleep(10_000, pre.signal), { message: "pre" });

  // E-1: no elapsed-time assert. A 10 s sleep can only reject through the
  // abort, so the rejection itself proves the wait was cut short.
  const mid = new AbortController();
  const pending = sleep(10_000, mid.signal);
  setImmediate(() => mid.abort("mid"));
  await assert.rejects(pending, { message: "mid" });
});

test("systemClock reads Date.now and sleeps abortably", async () => {
  const before = Date.now();
  const now = systemClock.now();
  assert.ok(now >= before && now <= Date.now());
  await systemClock.sleep(0);
  const pre = new AbortController();
  pre.abort("pre");
  await assert.rejects(systemClock.sleep(10_000, pre.signal), {
    message: "pre",
  });
});
