import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runPreflight,
  selectChecks,
  defaultChecks,
  SnError,
  SnTruncationError,
} from "../build/index.js";
import { instanceUrlConfigured } from "../build/api/checks.js";
import { resolveScope } from "../build/api/http.js";
import { createFakeSnClient } from "../build/http/fake.js";

/** A minimal context with the injected (fake) client every run requires. */
function ctx(extra = {}) {
  return { http: createFakeSnClient(), ...extra };
}

test("instanceUrlConfigured fails when no URL is given", async () => {
  const result = await instanceUrlConfigured.run(ctx());
  assert.equal(result.status, "fail");
});

test("instanceUrlConfigured warns on a non-https URL", async () => {
  const result = await instanceUrlConfigured.run(
    ctx({ instanceUrl: "http://dev12345.service-now.com" }),
  );
  assert.equal(result.status, "warn");
});

test("instanceUrlConfigured passes on a valid https URL", async () => {
  const result = await instanceUrlConfigured.run(
    ctx({ instanceUrl: "https://dev12345.service-now.com" }),
  );
  assert.equal(result.status, "pass");
});

test("instanceUrlConfigured fails on a malformed URL", async () => {
  // A bare hostname with no scheme is the realistic paste-o: `new URL` throws,
  // and the check must surface that as a fail that echoes the offending value.
  const result = await instanceUrlConfigured.run(
    ctx({ instanceUrl: "dev12345.service-now.com" }),
  );
  assert.equal(result.name, "instance-url-configured");
  assert.equal(result.status, "fail");
  assert.match(result.message, /not a valid URL/);
  assert.match(result.message, /dev12345\.service-now\.com/);
});

test("instanceUrlConfigured fails closed on every unparseable URL shape", async () => {
  // Fail-closed doctrine: an unparseable target must never warn or pass its way
  // through, whatever shape the garbage takes. Notably it must not be mistaken
  // for the empty-URL case, nor fall through to the non-https warn.
  const malformed = [
    "not a url",
    "https://",
    "://dev12345.service-now.com",
    "ht!tp://dev12345.service-now.com",
    "  dev12345.service-now.com  ",
  ];
  for (const instanceUrl of malformed) {
    const result = await instanceUrlConfigured.run(ctx({ instanceUrl }));
    assert.equal(result.status, "fail", `expected fail for ${instanceUrl}`);
    assert.match(result.message, /not a valid URL/);
  }
});

test("runPreflight runs every default check and the summary totals match", async () => {
  const report = await runPreflight(ctx());
  // Check-agnostic: one result per default check, and the summary buckets
  // partition the results exactly.
  assert.equal(report.results.length, defaultChecks.length);
  const { pass, warn, fail } = report.summary;
  assert.equal(pass + warn + fail, report.results.length);
});

test("runPreflight reports ok:false when no instanceUrl is given", async () => {
  const report = await runPreflight(ctx());
  // With no instance URL, instanceUrlConfigured fails, so the run is not ok.
  assert.equal(report.ok, false);
  assert.ok(report.summary.fail >= 1);
});

test("runPreflight ok mirrors the absence of any fail", async () => {
  const report = await runPreflight(ctx());
  assert.equal(report.ok, report.summary.fail === 0);
});

test("selectChecks honours only / skip by check name", () => {
  const names = defaultChecks.map((c) => c.name);
  const only = selectChecks(defaultChecks, { only: [names[0]] });
  assert.deepEqual(
    only.map((c) => c.name),
    [names[0]],
  );

  const skipped = selectChecks(defaultChecks, { skip: [names[0]] });
  assert.ok(!skipped.some((c) => c.name === names[0]));
  assert.equal(skipped.length, defaultChecks.length - 1);
});

test("runPreflight applies ctx.select filtering", async () => {
  const report = await runPreflight(
    ctx({ select: { only: [instanceUrlConfigured.name] } }),
  );
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, instanceUrlConfigured.name);
});

// --- Fail-closed runner guarantees --------------------------------------

test("runPreflight fails closed when a selection matches no checks (vacuous guard)", async () => {
  // A non-empty default set narrowed to zero by `only` naming a check that does
  // not exist must not report a vacuous pass.
  const report = await runPreflight(
    ctx({ select: { only: ["no-such-check"] } }),
  );
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, "preflight");
  assert.equal(report.results[0].kind, "runner");
  assert.match(report.results[0].message, /nothing was verified/i);
});

test("runPreflight fails closed when the instance URL is unparseable", async () => {
  // End-to-end pin: the malformed-URL fail must propagate to report.ok, so a
  // typo'd target can never be reported as a clean run.
  const report = await runPreflight(
    ctx({
      instanceUrl: "dev12345.service-now.com",
      select: { only: [instanceUrlConfigured.name] },
    }),
  );
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.summary.pass, 0);
  assert.equal(report.summary.warn, 0);
  assert.equal(report.results[0].status, "fail");
  assert.match(report.results[0].message, /not a valid URL/);
});

test("runPreflight with an explicit empty check list is not ok (CC-21)", async () => {
  const report = await runPreflight(ctx(), []);
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, "preflight");
  assert.match(report.results[0].message, /nothing was verified/i);
});

test("runPreflight converts a throwing check into a fail result and continues (CC-5)", async () => {
  const throwing = {
    name: "throwing-check",
    description: "always throws an Error",
    run() {
      throw new Error("boom");
    },
  };
  const passing = {
    name: "passing-check",
    description: "always passes",
    run() {
      return { name: "passing-check", status: "pass", message: "ok" };
    },
  };
  const report = await runPreflight(ctx(), [throwing, passing]);
  assert.equal(report.ok, false);
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["throwing-check"].status, "fail");
  assert.match(byName["throwing-check"].message, /boom/);
  // The run continued: the check after the throwing one still ran and reported.
  assert.equal(byName["passing-check"].status, "pass");
  assert.equal(report.results.length, 2);
});

test("runPreflight handles a check that throws a non-Error value (CC-5)", async () => {
  const throwsString = {
    name: "throws-string",
    description: "throws a bare string",
    run() {
      throw "kaboom";
    },
  };
  const report = await runPreflight(ctx(), [throwsString]);
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, "fail");
  assert.match(report.results[0].message, /kaboom/);
});

test("runPreflight treats an unrecognised status as fail (CC-6, fail-closed)", async () => {
  const bogus = {
    name: "bogus-status",
    description: "returns a status outside pass/warn/fail",
    run() {
      return { name: "bogus-status", status: "error", message: "weird" };
    },
  };
  const report = await runPreflight(ctx(), [bogus]);
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  // No NaN buckets: the summary partitions cleanly into integers.
  assert.ok(Number.isInteger(report.summary.pass));
  assert.ok(Number.isInteger(report.summary.warn));
  assert.ok(Number.isInteger(report.summary.fail));
  assert.equal(report.results[0].status, "fail");
  assert.match(report.results[0].message, /unrecognised status/i);
});

test("runPreflight rejects a check set with duplicate names (CC-46)", async () => {
  const first = {
    name: "dup",
    description: "first with this name",
    run() {
      return { name: "dup", status: "pass", message: "one" };
    },
  };
  const second = {
    name: "dup",
    description: "second with this name",
    run() {
      return { name: "dup", status: "pass", message: "two" };
    },
  };
  const report = await runPreflight(ctx(), [first, second]);
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.results[0].name, "preflight");
  assert.equal(report.results[0].kind, "runner");
  assert.match(report.results[0].message, /[Dd]uplicate/);
  assert.match(report.results[0].message, /dup/);
});

for (const reservedName of ["preflight", "baseline", "preflight:extra"]) {
  test(`runPreflight rejects the reserved check name ${reservedName} (F-R-17)`, async () => {
    let ran = false;
    const check = {
      name: reservedName,
      description: "claims a reserved name",
      run() {
        ran = true;
        return { name: reservedName, status: "pass", message: "ok" };
      },
    };
    const report = await runPreflight(ctx(), [check]);
    assert.equal(ran, false);
    assert.equal(report.ok, false);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].name, "preflight");
    assert.equal(report.results[0].kind, "runner");
    assert.match(report.results[0].message, /[Rr]eserved/);
    assert.ok(report.results[0].message.includes(reservedName));
  });
}

test("runPreflight reports duplicate and reserved names in one row", async () => {
  const mk = (name) => ({
    name,
    description: name,
    run: () => ({ name, status: "pass", message: "ok" }),
  });
  const report = await runPreflight(ctx(), [mk("a"), mk("a"), mk("baseline")]);
  assert.equal(report.results.length, 1);
  assert.match(report.results[0].message, /Duplicate check name\(s\): a\./);
  assert.match(
    report.results[0].message,
    /Reserved check name\(s\): baseline\./,
  );
});

test("runPreflight strips a kind a check tries to set on its own row", async () => {
  const check = {
    name: "forger",
    description: "claims to be the runner",
    run: () => ({
      name: "forger",
      status: "warn",
      message: "hi",
      kind: "runner",
    }),
  };
  const report = await runPreflight(ctx(), [check]);
  assert.equal(report.results[0].status, "warn");
  assert.equal(Object.hasOwn(report.results[0], "kind"), false);
});

test("runPreflight leaves kind off ordinary check rows", async () => {
  const report = await runPreflight(
    ctx({ instanceUrl: "https://x.service-now.com" }),
    [instanceUrlConfigured],
  );
  assert.equal(Object.hasOwn(report.results[0], "kind"), false);
});

// --- coerceResult: a bad check return must fail only that check ---------

test("runPreflight treats a check returning null as fail without taking down other checks", async () => {
  const returnsNull = {
    name: "returns-null",
    description: "returns null instead of a CheckResult",
    run() {
      return null;
    },
  };
  const passing = {
    name: "passing-check",
    description: "always passes",
    run() {
      return { name: "passing-check", status: "pass", message: "ok" };
    },
  };
  const report = await runPreflight(ctx(), [returnsNull, passing]);
  assert.equal(report.ok, false);
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["returns-null"].status, "fail");
  assert.match(byName["returns-null"].message, /returned null/);
  assert.match(byName["returns-null"].message, /treated as fail/);
  // The bad return took down only its own check: the well-behaved check next
  // to it still produced its normal result, and the run itself did not reject.
  assert.equal(byName["passing-check"].status, "pass");
  assert.equal(byName["passing-check"].message, "ok");
  assert.equal(report.results.length, 2);
});

test("runPreflight treats a check returning a primitive as fail, naming the type", async () => {
  const returnsString = {
    name: "returns-string",
    description: "returns a bare string instead of a CheckResult",
    run() {
      return "not a result";
    },
  };
  const returnsUndefined = {
    name: "returns-undefined",
    description: "returns undefined instead of a CheckResult",
    run() {
      return undefined;
    },
  };
  const report = await runPreflight(ctx(), [returnsString, returnsUndefined]);
  assert.equal(report.ok, false);
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["returns-string"].status, "fail");
  assert.match(byName["returns-string"].message, /returned a string/);
  assert.match(byName["returns-string"].message, /treated as fail/);
  assert.equal(byName["returns-undefined"].status, "fail");
  assert.match(byName["returns-undefined"].message, /returned undefined/);
  assert.match(byName["returns-undefined"].message, /treated as fail/);
});

test("runPreflight falls back to the producing check's name when the returned object lacks one", async () => {
  const nameless = {
    name: "nameless-result-check",
    description: "returns an object with no `name` field",
    run() {
      return { status: "pass", message: "looks fine, forgot my name" };
    },
  };
  const report = await runPreflight(ctx(), [nameless]);
  // coerceResult only fills in the missing `name`; it leaves `status` alone,
  // and here it is a valid status, so the summariser counts it as a pass.
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, "nameless-result-check");
  assert.equal(report.results[0].status, "pass");
  assert.equal(report.results[0].message, "looks fine, forgot my name");
  assert.equal(report.ok, true);
  assert.equal(report.summary.pass, 1);
  assert.equal(report.summary.fail, 0);
});

test("SnTruncationError is re-exported from the package root (WP-A extra)", () => {
  assert.equal(typeof SnTruncationError, "function");
  const err = new SnTruncationError("hit the cap", 10000);
  assert.ok(err instanceof SnError);
  assert.ok(err instanceof Error);
  assert.equal(err.cap, 10000);
  assert.equal(err.name, "SnTruncationError");
});

test("runPreflight merges a check's checkOptions entry over options for that check only", async () => {
  const seen = {};
  const probe = (name) => ({
    name,
    description: name,
    run: async (c) => {
      seen[name] = c.options;
      return { name, status: "pass", message: "ok" };
    },
  });
  const report = await runPreflight(
    ctx({
      options: { a: 1, b: 2 },
      checkOptions: { first: { b: 3, c: 4 } },
    }),
    [probe("first"), probe("second")],
  );
  assert.equal(report.ok, true);
  assert.deepEqual(seen.first, { a: 1, b: 3, c: 4 });
  assert.deepEqual(seen.second, { a: 1, b: 2 });
});

test("runPreflight ignores inherited checkOptions keys", async () => {
  let seen;
  const report = await runPreflight(
    ctx({ options: { a: 1 }, checkOptions: {} }),
    [
      {
        name: "toString",
        description: "named like an Object.prototype member",
        run: async (c) => {
          seen = c.options;
          return { name: "toString", status: "pass", message: "ok" };
        },
      },
    ],
  );
  assert.equal(report.ok, true);
  assert.deepEqual(seen, { a: 1 });
});

// F-X-4: per-check and run timeouts, external cancellation.

/** A check that never settles on its own, but records the signal it was given. */
function hangingCheck(id, seen = {}) {
  return {
    name: id,
    description: id,
    run: (c) => {
      seen.signal = c.signal;
      return new Promise(() => {});
    },
  };
}

const passing = (id) => ({
  name: id,
  description: id,
  run: () => ({ name: id, status: "pass", message: "ok" }),
});

test("a check over its timeout fails, aborts its signal, and the run goes on", async () => {
  const seen = {};
  const report = await runPreflight(
    ctx(),
    [hangingCheck("slow", seen), passing("after")],
    { timeoutMs: 30 },
  );
  assert.equal(report.ok, false);
  const [slow, after] = report.results;
  assert.equal(slow.status, "fail");
  assert.match(slow.message, /Check timed out after 30 ms \(--timeout\)\./);
  assert.equal(after.status, "pass");
  assert.equal(seen.signal.aborted, true);
  assert.equal(seen.signal.reason.name, "TimeoutError");
});

test("a check that finishes in time leaves its signal un-aborted", async () => {
  const seen = {};
  const report = await runPreflight(
    ctx(),
    [
      {
        name: "quick",
        description: "quick",
        run: (c) => {
          seen.signal = c.signal;
          return { name: "quick", status: "pass", message: "ok" };
        },
      },
    ],
    { timeoutMs: 1000 },
  );
  assert.equal(report.ok, true);
  assert.equal(seen.signal.aborted, false);
});

test("an external abort fails the running check and every check not yet started", async () => {
  const controller = new AbortController();
  const seen = {};
  const running = {
    name: "running",
    description: "running",
    run: (c) => {
      seen.signal = c.signal;
      setTimeout(() => controller.abort(), 5);
      return new Promise(() => {});
    },
  };
  const report = await runPreflight(
    ctx(),
    [passing("first"), running, passing("later")],
    { signal: controller.signal },
  );
  const [first, cut, later] = report.results;
  assert.equal(first.status, "pass");
  assert.equal(cut.status, "fail");
  assert.match(cut.message, /Run aborted while this check was running\./);
  assert.equal(later.status, "fail");
  assert.match(later.message, /Run aborted before this check started\./);
  assert.equal(seen.signal.aborted, true);
});

test("a run timeout cuts the run and names --run-timeout", async () => {
  const report = await runPreflight(
    ctx(),
    [hangingCheck("stuck"), passing("never")],
    { runTimeoutMs: 30 },
  );
  const [stuck, never] = report.results;
  assert.match(
    stuck.message,
    /Run timed out after 30 ms \(--run-timeout\) while this check was running\./,
  );
  assert.match(never.message, /before this check started\./);
});

test("a pre-aborted signal runs no check at all", async () => {
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  const report = await runPreflight(
    ctx(),
    [
      {
        name: "x",
        description: "x",
        run: () => ((ran = true), passing("x").run()),
      },
    ],
    { signal: controller.signal },
  );
  assert.equal(ran, false);
  assert.equal(report.results[0].status, "fail");
});

test("runPreflight rejects a budget that is not a positive finite number", async () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      runPreflight(ctx(), [], { timeoutMs: bad }),
      RangeError,
    );
    await assert.rejects(
      runPreflight(ctx(), [], { runTimeoutMs: bad }),
      RangeError,
    );
  }
});

test("the scope lookup is shared across checks, but redone after a cancelled check", async () => {
  let reads = 0;
  const http = createFakeSnClient({
    tables: { sys_scope: [{ sys_id: "a".repeat(32), scope: "x_app" }] },
    queryFilter: (table, rows) => {
      if (table === "sys_scope") reads += 1;
      return rows;
    },
  });
  const usesScope = (id) => ({
    name: id,
    description: id,
    run: async (c) => {
      const scope = await resolveScope(c, "x_app");
      return { name: id, status: "pass", message: scope.clause };
    },
  });
  const report = await runPreflight({ http }, [
    usesScope("one"),
    usesScope("two"),
  ]);
  assert.equal(report.ok, true);
  assert.equal(reads, 1);

  // A check that starts the lookup and then times out poisons nothing: the
  // next check resolves the scope afresh rather than reusing the aborted entry.
  reads = 0;
  const slowHttp = createFakeSnClient({
    tables: { sys_scope: [{ sys_id: "b".repeat(32), scope: "x_app" }] },
    queryFilter: (table, rows) => {
      if (table === "sys_scope") reads += 1;
      return rows;
    },
  });
  const starter = {
    name: "starter",
    description: "starter",
    run: (c) => {
      void resolveScope(c, "x_app");
      return new Promise(() => {});
    },
  };
  const second = await runPreflight(
    { http: slowHttp },
    [starter, usesScope("next")],
    { timeoutMs: 20 },
  );
  assert.equal(second.results[1].status, "pass");
  assert.equal(reads, 2);
});

// F-X-3: bounded concurrent check execution.

/** A check that takes `ms`, tracking how many checks are running at once. */
function timedCheck(id, ms, track, extra = {}) {
  return {
    name: id,
    description: id,
    ...extra,
    run: async () => {
      track.active += 1;
      track.peak = Math.max(track.peak, track.active);
      track.started.push(id);
      await new Promise((r) => setTimeout(r, ms));
      track.active -= 1;
      return { name: id, status: "pass", message: "ok" };
    },
  };
}

const newTrack = () => ({ active: 0, peak: 0, started: [] });

test("concurrency caps the checks running at once and keeps registry order", async () => {
  const track = newTrack();
  // Uneven durations, so checks settle out of order.
  const checks = [40, 5, 30, 10, 25, 5, 15, 20].map((ms, i) =>
    timedCheck(`c${i}`, ms, track),
  );
  const report = await runPreflight(ctx(), checks, { concurrency: 3 });
  assert.equal(track.peak, 3);
  assert.deepEqual(
    report.results.map((r) => r.name),
    checks.map((c) => c.name),
  );
  assert.equal(report.summary.pass, 8);
});

test("concurrency 1 (the library default) runs one check at a time", async () => {
  for (const opts of [{}, { concurrency: 1 }]) {
    const track = newTrack();
    const checks = [10, 5, 10].map((ms, i) => timedCheck(`c${i}`, ms, track));
    await runPreflight(ctx(), checks, opts);
    assert.equal(track.peak, 1);
    assert.deepEqual(track.started, ["c0", "c1", "c2"]);
  }
});

test("serial checks run alone after the parallel ones, in registry order", async () => {
  const track = newTrack();
  const peaks = {};
  const serial = (id) => {
    const inner = timedCheck(id, 5, track, { meta: { serial: true } });
    return {
      ...inner,
      run: async () => {
        peaks[id] = track.active;
        return inner.run();
      },
    };
  };
  const checks = [
    serial("s1"),
    timedCheck("p1", 20, track),
    serial("s2"),
    timedCheck("p2", 10, track),
    timedCheck("p3", 15, track),
  ];
  const report = await runPreflight(ctx(), checks, { concurrency: 4 });
  assert.deepEqual(track.started.slice(3), ["s1", "s2"]);
  assert.deepEqual(
    new Set(track.started.slice(0, 3)),
    new Set(["p1", "p2", "p3"]),
  );
  // Nothing else was running when each serial check started.
  assert.deepEqual(peaks, { s1: 0, s2: 0 });
  assert.deepEqual(
    report.results.map((r) => r.name),
    ["s1", "p1", "s2", "p2", "p3"],
  );
});

test("a throwing check fails at its own index under concurrency", async () => {
  const track = newTrack();
  const report = await runPreflight(
    ctx(),
    [
      timedCheck("a", 10, track),
      {
        name: "boom",
        description: "boom",
        run: async () => {
          throw new Error("kaput");
        },
      },
      timedCheck("b", 5, track),
    ],
    { concurrency: 3 },
  );
  assert.deepEqual(
    report.results.map((r) => [r.name, r.status]),
    [
      ["a", "pass"],
      ["boom", "fail"],
      ["b", "pass"],
    ],
  );
  assert.match(report.results[1].message, /Check threw an error: kaput/);
});

test("an abort under concurrency fails every running and every pending check", async () => {
  const controller = new AbortController();
  const checks = [
    hangingCheck("h1"),
    hangingCheck("h2"),
    hangingCheck("h3"),
    { ...passing("serial"), meta: { serial: true } },
  ];
  setTimeout(() => controller.abort(), 10);
  const report = await runPreflight(ctx(), checks, {
    concurrency: 2,
    signal: controller.signal,
  });
  const messages = report.results.map((r) => r.message);
  assert.match(messages[0], /while this check was running/);
  assert.match(messages[1], /while this check was running/);
  assert.match(messages[2], /before this check started/);
  assert.match(messages[3], /before this check started/);
  assert.equal(report.summary.fail, 4);
});

test("concurrency speeds a run up without changing the report", async () => {
  const make = () => {
    const track = newTrack();
    return Array.from({ length: 8 }, (_, i) => timedCheck(`c${i}`, 50, track));
  };
  let at = performance.now();
  const serialReport = await runPreflight(ctx(), make(), { concurrency: 1 });
  const serialMs = performance.now() - at;
  at = performance.now();
  const pooledReport = await runPreflight(ctx(), make(), { concurrency: 4 });
  const pooledMs = performance.now() - at;
  assert.ok(
    pooledMs <= serialMs * 0.4,
    `pooled ${pooledMs.toFixed(0)} ms vs serial ${serialMs.toFixed(0)} ms`,
  );
  assert.deepEqual(pooledReport, serialReport);
});

test("runPreflight rejects a concurrency outside 1-32", async () => {
  for (const bad of [0, 33, 1.5, -1, Number.NaN]) {
    await assert.rejects(
      runPreflight(ctx(), [passing("x")], { concurrency: bad }),
      RangeError,
    );
  }
});
