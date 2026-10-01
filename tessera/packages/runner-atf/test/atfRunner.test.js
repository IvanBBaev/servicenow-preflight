// The `Runner` port itself — what `core` gets when it dispatches an ATF spec.
//
// The other suites in this package test the pieces (trigger, poll, parse). This
// one tests the contract, and the contract has two halves that are easy to
// state and easy to break.
//
// DEV-1, the resolve/reject line. `run()` RESOLVES for anything that is
// evidence about a test — including "the suite never finished", which §6a turns
// into INCONCLUSIVE/blocking. It REJECTS only when the adapter has no evidence
// at all: a broken trigger, an unreadable body, a projection that cannot
// attribute. Every test below sits deliberately on one side of that line, and a
// test that asserted the wrong side would let a whole pipeline report an infra
// fault where it should report an honest "still running", or worse, report a
// green run it never observed.
//
// DEV-6/ARCH-9/DR-4, attribution. The CI/CD progress endpoint answers with a
// suite-level rollup and nothing else; "Failed" does not say WHICH spec failed.
// So the load-bearing test here is the one with two specs in one suite and two
// different result rows: if attribution ever regressed to the rollup, that test
// is the one that would go red.
//
// Everything runs on `manualClock`, so a fifteen-minute deadline is exercised in
// microseconds and the timeout paths are facts rather than flakes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "@tessera/fake-instance";

import {
  ATF_TARGET_TABLE,
  ATF_TEST_RESULT_TABLE,
  AtfInfrastructureError,
  CICD_TESTSUITE_RUN_PATH,
  DEFAULT_ATF_KINDS,
  DEFAULT_RUN_DEADLINE_MS,
  RESULT_FIELDS,
  SUITE_TRIGGER_PARAM,
  TABLE_API_PREFIX,
  createAtfRunner,
} from "../build/index.js";

import {
  CANARY,
  RUN_ID,
  SUITE_ID,
  VISIBLE,
  assertInfraFault,
  assertNormalisedFault,
  collector,
  fakeClient,
  isSuiteTreeRead,
  makeCtx,
  manualClock,
  plan,
  requestsTo,
  scriptedClient,
  seedResult,
  spec,
  suiteResultId,
  sysId,
  tablePage,
} from "./support.js";

const SUITE_A = sysId("suite-a");
const SUITE_B = sysId("suite-b");
const EXEC = "exec-0001";
/** The `links.results.id` a scripted terminal progress sample carries. */
const SCRIPTED_SUITE_RESULT = sysId("suite-result");

/**
 * A runner bound to a fake instance and to an injected clock. `initialIntervalMs`
 * is 1 by default so the backoff schedule (asserted exhaustively in
 * `poll.test.js`) does not dominate the deadlines these tests care about.
 */
function harness(instance, options = {}) {
  const clock = manualClock();
  const client = fakeClient(instance);
  const runner = createAtfRunner({
    client,
    now: clock.now,
    sleep: clock.sleep,
    initialIntervalMs: 1,
    ...options,
  });
  return { runner, client, clock };
}

/** The CI/CD trigger envelope, for the cases the fake instance cannot express. */
function triggerEnvelope(executionId = EXEC) {
  return {
    data: {
      result: {
        status: "0",
        status_label: "Pending",
        status_message: "",
        percent_complete: "0",
        links: {
          progress: {
            id: executionId,
            url: `https://fake/api/sn_cicd/progress/${executionId}`,
          },
        },
      },
    },
    status: 200,
  };
}

/**
 * One progress sample in the same envelope both CI/CD endpoints use.
 * `resultsId` is the terminal payload's `links.results.id` — the
 * `sys_atf_test_suite_result` sys_id that links per-test rows to THIS
 * execution; `null` omits the `links.results` block entirely.
 */
function progressEnvelope(status, statusLabel, options = {}) {
  const resultsId =
    options.resultsId === undefined ? SCRIPTED_SUITE_RESULT : options.resultsId;
  return {
    data: {
      result: {
        status,
        status_label: statusLabel,
        status_message: "",
        percent_complete: options.percent ?? "100",
        links: {
          progress: {
            id: EXEC,
            url: `https://fake/api/sn_cicd/progress/${EXEC}`,
          },
          ...(resultsId === null
            ? {}
            : {
                results: {
                  id: resultsId,
                  url: `https://fake/api/sn_cicd/testsuite/results/${resultsId}`,
                },
              }),
        },
      },
    },
    status: 200,
  };
}

/** The outcome recorded for one spec id, by id — attribution made assertable. */
function outcomeOf(result, id) {
  const found = result.outcomes.filter((outcome) => outcome.spec.id === id);
  assert.equal(found.length, 1, `expected exactly one outcome for ${id}`);
  return found[0];
}

/**
 * ARCH-24 — `core` owns the run boundary. An adapter that closed it would make
 * a multi-runner pipeline report `end` once per runner, so this is asserted on
 * every path, including the ones that fail.
 */
function assertNoEndEvent(events) {
  assert.deepEqual(events.of("end"), [], "the adapter emitted an `end` event");
}

/**
 * ARCH-28/DEV-17 — the runner reclaims nothing on its way out. A DELETE here
 * would race the orphan sweep and destroy the evidence the sweep exists to
 * collect, so this is asserted against the wire rather than against intent.
 */
function assertNoDeletes(instance, client) {
  for (const entry of instance.requests()) {
    assert.notEqual(entry.method, "DELETE", `unexpected DELETE ${entry.path}`);
  }
  for (const call of client.calls) {
    assert.notEqual(call.method, "DELETE", `unexpected DELETE ${call.path}`);
  }
}

describe("createAtfRunner — port shape", () => {
  it("claims `unit` by default and lets a caller narrow or widen that", () => {
    const client = scriptedClient(() => triggerEnvelope());
    assert.deepEqual([...createAtfRunner({ client }).kinds], ["unit"]);
    assert.deepEqual([...DEFAULT_ATF_KINDS], ["unit"]);
    const wide = createAtfRunner({ client, kinds: ["unit", "integration"] });
    assert.deepEqual([...wide.kinds], ["unit", "integration"]);
  });

  it("ships the documented DEV-2 default budget", () => {
    // Fifteen minutes: long enough for a realistic suite, short enough that a
    // wedged instance cannot hold a pipeline hostage.
    assert.equal(DEFAULT_RUN_DEADLINE_MS, 15 * 60 * 1_000);
  });

  it("supports() answers only `is this spec addressed at a sys_atf_test row`", () => {
    // Kind membership is core's dispatcher's job; asking `supports()` about it
    // here would duplicate a decision that lives one layer up.
    const client = scriptedClient(() => triggerEnvelope());
    const runner = createAtfRunner({ client });
    const { specs } = plan([
      { id: "alpha" },
      { id: "beta", table: "sys_script_include" },
    ]);
    assert.equal(runner.supports(specs[0]), true);
    assert.equal(runner.supports(specs[1]), false);
    assert.equal(
      runner.supports({ ref: spec("gamma"), kind: "unit", targets: [] }),
      false,
      "a spec with no target is addressed at nothing",
    );
  });

  it("honours a custom targetTable, in both directions", () => {
    const client = scriptedClient(() => triggerEnvelope());
    const runner = createAtfRunner({ client, targetTable: "x_custom_test" });
    const { specs } = plan([
      { id: "alpha" },
      { id: "beta", table: "x_custom_test" },
    ]);
    assert.equal(runner.supports(specs[0]), false, ATF_TARGET_TABLE);
    assert.equal(runner.supports(specs[1]), true);
  });

  it("resolves an empty run without a projection and without a request", () => {
    const client = scriptedClient(() =>
      assert.fail("an empty run must not touch the instance"),
    );
    const events = collector();
    const runner = createAtfRunner({ client });
    return runner.run(makeCtx(), [], events.emit).then((result) => {
      // No projection was supplied: the early return has to happen before the
      // attribution check, or a run with nothing to do would fail closed for
      // no reason.
      assert.deepEqual(result, { runId: RUN_ID, outcomes: [] });
      assert.equal(client.calls.length, 0);
      assert.deepEqual(events.events, []);
    });
  });
});

describe("createAtfRunner — per-spec attribution (DEV-6 / ARCH-9 / DR-4)", () => {
  it("splits one suite verdict into one outcome per spec, on the right spec", async () => {
    // The property the whole adapter exists for. The suite rollup below is a
    // single "Successful"; the two specs are told apart only by the
    // `sys_atf_test_result` rows joined through the projection.
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([
      { id: "alpha" },
      { id: "beta" },
    ]);
    seedResult(instance, { test: testSysIdOf("alpha"), status: "success" });
    seedResult(instance, {
      test: testSysIdOf("beta"),
      status: "failure",
      output: "expected 3, got 4",
    });

    const events = collector();
    const { runner, client } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assert.equal(result.runId, RUN_ID);
    assert.equal(result.outcomes.length, 2);
    assert.equal(outcomeOf(result, "alpha").raw, "pass");
    assert.equal(outcomeOf(result, "beta").raw, "fail");
    assert.equal(
      outcomeOf(result, "beta").spec.path,
      "tests/beta.unit.ts",
      "the outcome carries the full TestSpecRef, not just an id",
    );

    // The events have to agree with the outcomes: a report built from the tape
    // and a report built from the RunResult must not disagree about who failed.
    assert.deepEqual(
      events.of("pass").map((event) => event.spec.id),
      ["alpha"],
    );
    assert.deepEqual(
      events.of("fail").map((event) => event.spec.id),
      ["beta"],
    );
    assert.match(events.of("fail")[0].assertion, /expected 3, got 4/);
    assertNoEndEvent(events);
    assertNoDeletes(instance, client);
  });

  it("attributes through the projection, not through the test's name", async () => {
    // Two specs whose ATF tests are named identically on the instance. Name
    // matching would be a coin flip; the projection makes it deterministic.
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([
      { id: "same-name-1" },
      { id: "same-name-2" },
    ]);
    seedResult(instance, {
      test: testSysIdOf("same-name-1"),
      status: "success",
      extra: { name: "Shared ATF name" },
    });
    seedResult(instance, {
      test: testSysIdOf("same-name-2"),
      status: "skipped",
      extra: { name: "Shared ATF name" },
    });

    const events = collector();
    const { runner } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );
    assert.equal(outcomeOf(result, "same-name-1").raw, "pass");
    assert.equal(outcomeOf(result, "same-name-2").raw, "skipped");
    assertNoEndEvent(events);
  });

  it("carries the result row as evidence, so a verdict can be traced back", async () => {
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    const row = seedResult(instance, {
      test: testSysIdOf("alpha"),
      status: "success",
    });

    const { runner } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      collector().emit,
    );
    assert.deepEqual(outcomeOf(result, "alpha").evidence, {
      kind: "atf-result",
      ref: row["sys_id"],
    });
  });
});

describe("createAtfRunner — the trigger on the wire (DEV-14)", () => {
  it("identifies the suite by test_suite_sys_id, asserted off the request log", async () => {
    // DEV-14 is a bug that does not fail loudly: the wrong parameter name still
    // gets an answer, the run still appears to start, and results are attributed
    // to whatever the instance decided to run. So the assertion reads the
    // request the instance actually received, never the adapter's return value.
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    seedResult(instance, { test: testSysIdOf("alpha"), status: "success" });

    const { runner } = harness(instance);
    await runner.run(makeCtx({ projection }), specs, collector().emit);

    const triggers = requestsTo(instance, CICD_TESTSUITE_RUN_PATH);
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].method, "POST");
    assert.equal(triggers[0].params[SUITE_TRIGGER_PARAM], SUITE_ID);
    assert.equal(SUITE_TRIGGER_PARAM, "test_suite_sys_id");
  });

  it("names the execution in a log event, so an abandoned run is traceable", async () => {
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    seedResult(instance, { test: testSysIdOf("alpha"), status: "success" });

    const events = collector();
    const { runner } = harness(instance);
    await runner.run(makeCtx({ projection }), specs, events.emit);

    const executionId = instance.cicd.runs()[0].executionId;
    assert.ok(
      events.of("log").some((event) => event.message.includes(executionId)),
      "no log event named the execution id",
    );
    assertNoEndEvent(events);
  });
});

describe("createAtfRunner — the run budget (DEV-2)", () => {
  it("resolves waiting-timeout when the poll ceiling is reached, and does not reject", async () => {
    // "We stopped waiting" is evidence about the WAIT, not about the tests.
    // Rejecting here would turn a slow suite into an adapter fault and lose the
    // per-spec rows §6a needs to say INCONCLUSIVE/blocking.
    const instance = createFakeInstance({ cicd: { pollsToComplete: 99 } });
    const { specs, projection } = plan([{ id: "alpha" }, { id: "beta" }]);

    const events = collector();
    const { runner, client } = harness(instance, { maxPolls: 3 });
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.raw),
      ["waiting-timeout", "waiting-timeout"],
    );
    const executionId = instance.cicd.runs()[0].executionId;
    const errors = events.of("error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].cause, new RegExp(executionId));
    assert.match(errors[0].cause, /did not reach a terminal state/);
    assert.match(errors[0].cause, /last observed state running/);
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.evidence),
      [
        { kind: "log", ref: executionId },
        { kind: "log", ref: executionId },
      ],
      "the abandoned execution is the evidence the orphan sweep will need",
    );
    assertNoEndEvent(events);
    assertNoDeletes(instance, client);
  });

  it("stops on the wall budget, measured against the injected clock", async () => {
    const instance = createFakeInstance({ cicd: { pollsToComplete: 99 } });
    const { specs, projection } = plan([{ id: "alpha" }]);

    const events = collector();
    const { runner, clock } = harness(instance, {
      deadlineMs: 20,
      initialIntervalMs: 8,
      maxIntervalMs: 8,
    });
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assert.equal(result.outcomes[0].raw, "waiting-timeout");
    // The last interval is clipped to what is left, so the runner never sleeps
    // past its own deadline.
    assert.deepEqual(clock.sleeps, [8, 8, 4]);
    assert.match(events.of("error")[0].cause, /within the run budget \(20ms\)/);
    assertNoEndEvent(events);
  });

  it("records waiting-timeout without triggering anything when the budget is already spent", async () => {
    // A budget consumed by an earlier runner in the same run. Triggering a suite
    // we already know we cannot wait for would leave an orphan for nothing.
    const instance = createFakeInstance();
    const { specs, projection } = plan([{ id: "alpha" }]);

    // A zero budget is refused at construction (fix 2026-09-25), so the spent
    // budget is modelled the way it happens in production: a clock that has
    // already moved past the 1 ms deadline by the time the first suite is due.
    const events = collector();
    let tick = 0;
    const { runner, client } = harness(instance, {
      deadlineMs: 1,
      now: () => (tick += 5),
    });
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0].raw, "waiting-timeout");
    assert.deepEqual(result.outcomes[0].evidence, {
      kind: "log",
      ref: `sys_atf_test_suite:${SUITE_ID}`,
    });
    assert.equal(client.calls.length, 0, "nothing was started");
    assert.match(events.of("error")[0].cause, /exhausted its 1ms ATF budget/);
    assertNoEndEvent(events);
  });
});

describe("createAtfRunner — option validation (fix 2026-09-25)", () => {
  // NaN deadline + NaN maxPolls used to poll forever; a zero/negative budget
  // made every run a silent waiting-timeout. Both are refused at construction.
  for (const [label, options] of [
    ["deadlineMs NaN", { deadlineMs: Number.NaN }],
    ["deadlineMs Infinity", { deadlineMs: Number.POSITIVE_INFINITY }],
    ["deadlineMs 0", { deadlineMs: 0 }],
    ["deadlineMs -1", { deadlineMs: -1 }],
    ["maxPolls NaN", { maxPolls: Number.NaN }],
    ["maxPolls 0", { maxPolls: 0 }],
    ["maxPolls -3", { maxPolls: -3 }],
    ["maxPolls 2.5", { maxPolls: 2.5 }],
    ["initialIntervalMs NaN", { initialIntervalMs: Number.NaN }],
    ["maxIntervalMs Infinity", { maxIntervalMs: Number.POSITIVE_INFINITY }],
  ]) {
    it(`throws TypeError for ${label}`, () => {
      assert.throws(
        () =>
          createAtfRunner({ client: scriptedClient(() => ({})), ...options }),
        TypeError,
      );
    });
  }

  it("accepts the defaults and explicit positive values", () => {
    const client = scriptedClient(() => ({}));
    assert.doesNotThrow(() => createAtfRunner({ client }));
    assert.doesNotThrow(() =>
      createAtfRunner({ client, deadlineMs: 1, maxPolls: 1 }),
    );
  });
});

describe("createAtfRunner — cancellation (ARCH-28 / DEV-17)", () => {
  it("an already-aborted signal resolves waiting-timeout and starts nothing", async () => {
    const instance = createFakeInstance();
    const { specs, projection } = plan([{ id: "alpha" }, { id: "beta" }]);
    const controller = new AbortController();
    controller.abort();

    const events = collector();
    const { runner, client } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection, signal: controller.signal }),
      specs,
      events.emit,
    );

    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.raw),
      ["waiting-timeout", "waiting-timeout"],
    );
    assert.equal(client.calls.length, 0);
    assert.match(events.of("error")[0].cause, /was aborted before ATF suite/);
    assertNoEndEvent(events);
    assertNoDeletes(instance, client);
  });

  it("an abort mid-poll abandons the execution instead of reclaiming it", async () => {
    // The instance-side run keeps going and the projected records stay put.
    // Deleting them here would race the orphan sweep, which is the component
    // that actually knows whether a run is still alive (§4b).
    const instance = createFakeInstance({ cicd: { pollsToComplete: 99 } });
    const { specs, projection } = plan([{ id: "alpha" }]);
    const controller = new AbortController();
    const clock = manualClock();
    const client = fakeClient(instance);
    const runner = createAtfRunner({
      client,
      now: clock.now,
      sleep: (ms) => {
        controller.abort();
        return clock.sleep(ms);
      },
      initialIntervalMs: 1,
    });

    const events = collector();
    const result = await runner.run(
      makeCtx({ projection, signal: controller.signal }),
      specs,
      events.emit,
    );

    assert.equal(result.outcomes[0].raw, "waiting-timeout");
    const executionId = instance.cicd.runs()[0].executionId;
    assert.match(events.of("error")[0].cause, /was abandoned on abort/);
    assert.match(events.of("error")[0].cause, new RegExp(executionId));
    assert.notEqual(
      instance.cicd.peek(executionId).state,
      "canceled",
      "the adapter must not cancel the instance-side execution",
    );
    assertNoEndEvent(events);
    assertNoDeletes(instance, client);
  });
});

describe("createAtfRunner — a spec with no result row (QA-9)", () => {
  it("reports `missing` rather than dropping the spec from the outcomes", async () => {
    // The failure this guards against is silence: a spec that vanishes from the
    // outcome array reads downstream as "not planned", which is exactly the
    // false green §6a is built to make impossible.
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([
      { id: "alpha" },
      { id: "ghost" },
    ]);
    seedResult(instance, { test: testSysIdOf("alpha"), status: "success" });

    const events = collector();
    const { runner } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assert.equal(result.outcomes.length, 2, "the ghost spec was dropped");
    assert.equal(outcomeOf(result, "ghost").raw, "missing");
    const error = events
      .of("error")
      .find((event) => event.spec?.id === "ghost");
    assert.ok(error, "a missing result must be announced, not inferred");
    assert.match(
      error.cause,
      /no sys_atf_test_result row came back for sys_atf_test/,
    );
    assertNoEndEvent(events);
  });
});

describe("createAtfRunner — several suites in one run", () => {
  it("triggers one execution per projected suite", async () => {
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([
      { id: "alpha", suiteSysId: SUITE_A },
      { id: "beta", suiteSysId: SUITE_A },
      { id: "gamma", suiteSysId: SUITE_B },
    ]);
    for (const id of ["alpha", "beta"]) {
      seedResult(instance, { test: testSysIdOf(id), status: "success" });
    }
    // SUITE_B is the second trigger, so its rows link to the second
    // sys_atf_test_suite_result the fake mints.
    seedResult(instance, {
      test: testSysIdOf("gamma"),
      status: "success",
      link: suiteResultId(2),
    });

    const events = collector();
    const { runner } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    const triggers = requestsTo(instance, CICD_TESTSUITE_RUN_PATH);
    assert.deepEqual(
      triggers.map((entry) => entry.params[SUITE_TRIGGER_PARAM]),
      [SUITE_A, SUITE_B],
      "specs sharing a suite must share one execution",
    );
    assert.equal(result.outcomes.length, 3);
    assert.deepEqual(
      result.outcomes.map((outcome) => [outcome.spec.id, outcome.raw]),
      [
        ["alpha", "pass"],
        ["beta", "pass"],
        ["gamma", "pass"],
      ],
      "each suite's rows are read through its own execution link",
    );
    assertNoEndEvent(events);
  });

  it("records the untouched group's specs as waiting-timeout, not as absent", async () => {
    // A halt in the first group stops the run, and the specs that never got
    // their turn still need a row apiece — the whole point of §6a's checklist.
    const instance = createFakeInstance({ cicd: { pollsToComplete: 99 } });
    const { specs, projection } = plan([
      { id: "alpha", suiteSysId: SUITE_A },
      { id: "gamma", suiteSysId: SUITE_B },
    ]);

    const events = collector();
    const { runner, client } = harness(instance, { maxPolls: 2 });
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assert.equal(result.outcomes.length, 2);
    assert.equal(outcomeOf(result, "alpha").raw, "waiting-timeout");
    assert.equal(outcomeOf(result, "gamma").raw, "waiting-timeout");
    assert.deepEqual(
      requestsTo(instance, CICD_TESTSUITE_RUN_PATH).length,
      1,
      "the second suite must not be started after the run halted",
    );
    // The two groups fail for different reasons and the evidence says so: one
    // execution was abandoned, the other never existed.
    assert.deepEqual(outcomeOf(result, "gamma").evidence, {
      kind: "log",
      ref: `sys_atf_test_suite:${SUITE_B}`,
    });
    assert.equal(
      events.of("error").length,
      2,
      "one error for the halted suite, one for the specs never executed",
    );
    assert.match(
      events.of("error")[1].cause,
      /1 ATF spec\(s\) were never executed/,
    );
    assertNoEndEvent(events);
    assertNoDeletes(instance, client);
  });
});

describe("createAtfRunner — infrastructure faults (DEV-1)", () => {
  it("rejects when the trigger answers without a progress id", async () => {
    // A run that cannot be polled produces no evidence about any test, so
    // resolving here would be the adapter inventing a verdict.
    const client = scriptedClient(() => ({
      data: { result: {} },
      status: 200,
    }));
    const { specs, projection } = plan([{ id: "alpha" }]);
    const runner = createAtfRunner({ client, now: manualClock().now });
    await assertInfraFault(
      runner.run(makeCtx({ projection }), specs, collector().emit),
      /carried no progress id/,
    );
  });

  it("rejects when the trigger answers non-2xx, as the port's own fault type", async () => {
    // `aliasParam: null` sends the DEV-14 name alone, which the fake's router
    // (keyed on the vendored `sys_id`) answers 400 to — a real HTTP failure
    // rather than a simulated one, and incidentally proof that the alias is
    // load-bearing for the fake.
    //
    // This is the assertion the whole boundary ruling is for, made at the port
    // rather than at a helper: a consumer holding nothing but a `Runner` sees
    // ONE fault type whatever went wrong, and gets the HTTP status off it
    // without importing `@tessera/sn-client` to ask.
    const instance = createFakeInstance();
    const { specs, projection } = plan([{ id: "alpha" }]);
    const { runner } = harness(instance, { trigger: { aliasParam: null } });
    await assertNormalisedFault(
      runner.run(makeCtx({ projection }), specs, collector().emit),
      { status: 400, message: /trigger of ATF suite/ },
    );
  });

  it("still hands the transport's own error to a debugger, one hop down on `cause`", async () => {
    // The counter-argument to normalising was that it destroys diagnostics.
    // It would, if the wrapper flattened. It does not: the ServiceNowError is
    // the same object, with its status and its parsed body, and its text is
    // quoted into the wrapper's message so it survives `core`'s
    // `${name}: ${message}` flattening onto the report as well.
    const instance = createFakeInstance();
    instance.faults.add({
      match: { path: CICD_TESTSUITE_RUN_PATH },
      mode: { kind: "http-error", status: 403 },
    });
    const { specs, projection } = plan([{ id: "alpha" }]);
    const { runner } = harness(instance);
    await assert.rejects(
      runner.run(makeCtx({ projection }), specs, collector().emit),
      (error) => {
        assert.ok(error instanceof AtfInfrastructureError);
        assert.equal(error.status, 403);
        const original = error.cause;
        assert.equal(original.name, "ServiceNowError");
        assert.equal(original.status, 403);
        assert.notEqual(
          original.detail,
          undefined,
          "the response body is kept",
        );
        assert.equal(typeof original.detail, "object", "as data, not as text");
        assert.match(error.message, /ServiceNowError:/);
        return true;
      },
    );
  });

  it("rejects when the progress body is not the envelope we speak", async () => {
    const client = scriptedClient((_args, index) =>
      index === 0
        ? triggerEnvelope()
        : { data: "<html>login</html>", status: 200 },
    );
    const { specs, projection } = plan([{ id: "alpha" }]);
    const runner = createAtfRunner({
      client,
      now: manualClock().now,
      sleep: () => Promise.resolve(),
    });
    await assertInfraFault(
      runner.run(makeCtx({ projection }), specs, collector().emit),
      /unparseable/,
    );
  });

  it("rejects when the progress status is unrecognised, instead of waiting out the budget (fix 2026-09-25)", async () => {
    const client = scriptedClient((_args, index) =>
      index === 0 ? triggerEnvelope() : progressEnvelope("7", "Unknown"),
    );
    const { specs, projection } = plan([{ id: "alpha" }]);
    const runner = createAtfRunner({
      client,
      now: manualClock().now,
      sleep: () => Promise.resolve(),
    });
    await assertInfraFault(
      runner.run(makeCtx({ projection }), specs, collector().emit),
      /unrecognised status "7"/,
    );
    assert.equal(
      client.calls.length,
      2,
      "trigger + one progress read, no more",
    );
  });

  it("rejects when the result read returns no `result` array", async () => {
    // The suite finished, so the tests DID produce verdicts — we simply cannot
    // read them. Reporting "missing" for every spec would blame the tests for an
    // adapter fault.
    const client = scriptedClient((_args, index) => {
      if (index === 0) return triggerEnvelope();
      if (index === 1) return progressEnvelope("2", "Successful");
      if (isSuiteTreeRead(_args)) return tablePage([]);
      return { data: { nope: true }, status: 200 };
    });
    const { specs, projection } = plan([{ id: "alpha" }]);
    const runner = createAtfRunner({
      client,
      now: manualClock().now,
      sleep: () => Promise.resolve(),
    });
    await assertInfraFault(
      runner.run(makeCtx({ projection }), specs, collector().emit),
      new RegExp(`Table API read of ${ATF_TEST_RESULT_TABLE}`),
    );
  });
});

describe("createAtfRunner — the projection is the attribution key (ARCH-26 / DEV-16)", () => {
  /** Every case here must fail before a single request leaves the adapter. */
  async function assertRefusedUpFront(ctxOptions, specs, expected) {
    const client = scriptedClient(() =>
      assert.fail("a run that cannot attribute must not touch the instance"),
    );
    const runner = createAtfRunner({ client, now: manualClock().now });
    const events = collector();
    await assertInfraFault(
      runner.run(makeCtx(ctxOptions), specs, events.emit),
      expected,
    );
    assert.equal(client.calls.length, 0);
    assertNoEndEvent(events);
  }

  it("rejects when ctx.projection is absent", async () => {
    const { specs } = plan([{ id: "alpha" }]);
    await assertRefusedUpFront({}, specs, /ctx\.projection is absent/);
  });

  it("rejects when a spec has no projection entry, and names that spec", async () => {
    // Guessing an attribution key is precisely the silent mis-attribution DR-4
    // exists to prevent, and an error that did not name the spec would send an
    // operator hunting through the whole plan.
    const { specs, projection } = plan([
      { id: "alpha" },
      { id: "orphan", projected: false },
    ]);
    await assertRefusedUpFront(
      { projection },
      specs,
      /spec orphan \(tests\/orphan\.unit\.ts\) has no projection entry/,
    );
  });

  it("rejects a projection entry with a blank testSysId or suiteSysId", async () => {
    const blankTest = plan([{ id: "alpha", testSysId: "" }]);
    await assertRefusedUpFront(
      { projection: blankTest.projection },
      blankTest.specs,
      /is\s+incomplete \(testSysId=""/,
    );

    const blankSuite = plan([{ id: "alpha", suiteSysId: "" }]);
    await assertRefusedUpFront(
      { projection: blankSuite.projection },
      blankSuite.specs,
      /suiteSysId=""/,
    );
  });

  it("rejects two specs projected onto the same sys_atf_test row", async () => {
    // One row yields one result, so one spec's outcome would silently overwrite
    // the other's — a green run for a spec nobody ever executed.
    const shared = sysId("shared-test");
    const { specs, projection } = plan([
      { id: "alpha", testSysId: shared },
      { id: "beta", testSysId: shared },
    ]);
    await assertRefusedUpFront(
      { projection },
      specs,
      /specs alpha \(.+\) and beta \(.+\) are both projected onto sys_atf_test/,
    );
  });
});

describe("createAtfRunner — TM-1: untrusted instance text", () => {
  it("never lets a non-allowlisted column reach the event tape", async () => {
    // Defence #1 is structural: the read sends an explicit `sysparm_fields`
    // allowlist, so the script column is never fetched at all. The assertion is
    // on the WHOLE tape, because a canary that leaked into any field — an
    // artifact ref, a log message, a cause — is just as leaked.
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    seedResult(instance, {
      test: testSysIdOf("alpha"),
      status: "failure",
      output: `assertion failed: ${VISIBLE}`,
      extra: { step_script: CANARY, description: CANARY },
    });

    const events = collector();
    const { runner } = harness(instance);
    await runner.run(makeCtx({ projection }), specs, events.emit);

    assert.ok(
      events.text().includes(VISIBLE),
      "the allowlisted output must survive, or the canary proves nothing",
    );
    assert.equal(events.text().includes(CANARY), false);

    // Proven on the wire too: widening the allowlist is a code change, so the
    // constant is what must appear in the request.
    const reads = requestsTo(
      instance,
      `${TABLE_API_PREFIX}${ATF_TEST_RESULT_TABLE}`,
    );
    assert.ok(reads.length > 0);
    for (const read of reads) {
      assert.equal(read.params["sysparm_fields"], RESULT_FIELDS.join(","));
    }
    assertNoEndEvent(events);
  });

  it("ignores a rogue column even when the instance sends one anyway", async () => {
    // Defence #1 assumes the instance honours `sysparm_fields`. A misbehaving
    // instance (or a proxy) can return more than was asked for, so the parser
    // must read only the columns it knows rather than the row it received.
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    const client = scriptedClient((_args, index) => {
      if (index === 0) return triggerEnvelope();
      if (index === 1) return progressEnvelope("3", "Failed");
      if (isSuiteTreeRead(_args)) return tablePage([]);
      return {
        data: {
          result: [
            {
              sys_id: sysId("row-1"),
              test: testSysIdOf("alpha"),
              status: "failure",
              output: `assertion failed: ${VISIBLE}`,
              sys_created_on: "2026-08-21 10:00:00",
              test_suite_result: SCRIPTED_SUITE_RESULT,
              step_script: CANARY,
            },
          ],
        },
        status: 200,
      };
    });

    const events = collector();
    const runner = createAtfRunner({
      client,
      now: manualClock().now,
      sleep: () => Promise.resolve(),
    });
    await runner.run(makeCtx({ projection }), specs, events.emit);

    assert.ok(events.text().includes(VISIBLE));
    assert.equal(events.text().includes(CANARY), false);
    assertNoEndEvent(events);
  });
});

describe("createAtfRunner — emission discipline (ARCH-24)", () => {
  it("emits exactly one `start` per spec it is about to run", async () => {
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([
      { id: "alpha", suiteSysId: SUITE_A },
      { id: "beta", suiteSysId: SUITE_B },
    ]);
    seedResult(instance, { test: testSysIdOf("alpha"), status: "success" });
    seedResult(instance, {
      test: testSysIdOf("beta"),
      status: "success",
      link: suiteResultId(2),
    });

    const events = collector();
    const { runner } = harness(instance);
    await runner.run(makeCtx({ projection }), specs, events.emit);

    assert.deepEqual(
      events.of("start").map((event) => event.spec.id),
      ["alpha", "beta"],
    );
    for (const event of events.events) {
      assert.equal(event.runId, RUN_ID, "every event carries the §4a run id");
    }
    assertNoEndEvent(events);
  });

  it("never emits `end` — not on success, not on timeout, not on abort", async () => {
    // Core owns the run boundary. Asserted once more as a sweep across the three
    // shapes of a run, because the tempting place to add an `end` is exactly the
    // early-exit path where the adapter feels like it is finishing.
    const green = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    seedResult(green, { test: testSysIdOf("alpha"), status: "success" });
    const greenEvents = collector();
    await harness(green).runner.run(
      makeCtx({ projection }),
      specs,
      greenEvents.emit,
    );
    assertNoEndEvent(greenEvents);

    const slow = createFakeInstance({ cicd: { pollsToComplete: 99 } });
    const slowEvents = collector();
    await harness(slow, { maxPolls: 1 }).runner.run(
      makeCtx({ projection }),
      specs,
      slowEvents.emit,
    );
    assertNoEndEvent(slowEvents);

    const controller = new AbortController();
    controller.abort();
    const abortedEvents = collector();
    await harness(createFakeInstance()).runner.run(
      makeCtx({ projection, signal: controller.signal }),
      specs,
      abortedEvents.emit,
    );
    assertNoEndEvent(abortedEvents);
  });
});

describe("createAtfRunner — results are linked to THIS execution (F1, fail-closed)", () => {
  // `sys_atf_test_result` is a history table: every run of a test adds a row.
  // Reading "the newest row for this test" therefore attributes whatever ran
  // last — a stale row from before the trigger, or a concurrent run's row — to
  // the execution this runner started. The only admissible evidence is a row
  // whose `test_suite_result` points at the `sys_atf_test_suite_result` named
  // by the terminal progress payload's `links.results.id`.

  /** A scripted trigger → one terminal progress sample → result read. */
  function scriptedRun(progress, resultRows) {
    const client = scriptedClient((_args, index) => {
      if (index === 0) return triggerEnvelope();
      if (index === 1) return progress;
      if (isSuiteTreeRead(_args)) return tablePage([]);
      return { data: { result: resultRows }, status: 200 };
    });
    const runner = createAtfRunner({
      client,
      now: manualClock().now,
      sleep: () => Promise.resolve(),
    });
    return { client, runner };
  }

  function assertNoPass(result, events, id) {
    assert.notEqual(outcomeOf(result, id).raw, "pass", `${id} passed`);
    assert.deepEqual(events.of("pass"), [], "a pass event was emitted");
  }

  it("a stale success row written before the trigger is not a pass", async () => {
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    // Last year's green run of the same test: no link to this execution.
    seedResult(instance, {
      test: testSysIdOf("alpha"),
      status: "success",
      sys_created_on: "2025-01-01 00:00:00",
      link: null,
    });

    const events = collector();
    const { runner } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assertNoPass(result, events, "alpha");
    assert.equal(outcomeOf(result, "alpha").raw, "missing");
    assertNoEndEvent(events);
  });

  it("a suite Canceled at 0% with no results link yields no pass (the r1 repro)", async () => {
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    const { client, runner } = scriptedRun(
      progressEnvelope("4", "Canceled", { resultsId: null, percent: "0" }),
      [
        {
          sys_id: sysId("stale-row"),
          test: testSysIdOf("alpha"),
          status: "success",
          output: "",
          sys_created_on: "2025-06-01 00:00:00",
        },
      ],
    );

    const events = collector();
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assertNoPass(result, events, "alpha");
    assert.equal(outcomeOf(result, "alpha").raw, "missing");
    assert.equal(
      client.calls.length,
      2,
      "no result read without an execution link — an unscoped scan is exactly the bug",
    );
    const error = events
      .of("error")
      .find((event) => event.spec?.id === "alpha");
    assert.ok(error, "the unlinked spec must be announced");
    assert.match(error.cause, /Canceled/);
    assert.match(error.cause, /links\.results/);
    assertNoEndEvent(events);
  });

  it("a Failed suite whose read returns an unlinked success row yields no pass", async () => {
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    // A transport that ignores the encoded-query filter and hands back a row
    // with no execution link at all.
    const { runner } = scriptedRun(progressEnvelope("3", "Failed"), [
      {
        sys_id: sysId("unlinked-row"),
        test: testSysIdOf("alpha"),
        status: "success",
        output: "",
        sys_created_on: "2026-08-21 10:00:00",
      },
    ]);

    const events = collector();
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assertNoPass(result, events, "alpha");
    assert.equal(outcomeOf(result, "alpha").raw, "missing");
  });

  it("rejects a concurrent run's row that links to a different suite result", async () => {
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    // A concurrent run of the same suite wrote a NEWER green row.
    seedResult(instance, {
      test: testSysIdOf("alpha"),
      status: "success",
      sys_created_on: "2099-01-01 00:00:00",
      link: sysId("concurrent-suite-result"),
    });

    const events = collector();
    const { runner } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assertNoPass(result, events, "alpha");
    assert.equal(outcomeOf(result, "alpha").raw, "missing");
  });

  it("a concurrent run's newer green row cannot mask this run's failure", async () => {
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    const mine = seedResult(instance, {
      test: testSysIdOf("alpha"),
      status: "failure",
      output: "this run failed",
      sys_created_on: "2026-08-21 10:00:00",
    });
    seedResult(instance, {
      test: testSysIdOf("alpha"),
      status: "success",
      sys_created_on: "2099-01-01 00:00:00",
      link: sysId("concurrent-suite-result"),
    });

    const events = collector();
    const { runner } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assert.equal(outcomeOf(result, "alpha").raw, "fail");
    assert.equal(outcomeOf(result, "alpha").evidence.ref, mine.sys_id);
    assertNoPass(result, events, "alpha");
  });

  it("drops a foreign-linked row even when the transport ignores the filter", async () => {
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    const { runner } = scriptedRun(progressEnvelope("2", "Successful"), [
      {
        sys_id: sysId("foreign-row"),
        test: testSysIdOf("alpha"),
        status: "success",
        output: "",
        sys_created_on: "2099-01-01 00:00:00",
        test_suite_result: sysId("concurrent-suite-result"),
      },
    ]);

    const events = collector();
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assertNoPass(result, events, "alpha");
    assert.equal(outcomeOf(result, "alpha").raw, "missing");
  });

  it("the normal path still passes, and the read is scoped to this execution on the wire", async () => {
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    const { specs, projection, testSysIdOf } = plan([{ id: "alpha" }]);
    const row = seedResult(instance, {
      test: testSysIdOf("alpha"),
      status: "success",
    });

    const events = collector();
    const { runner } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assert.equal(outcomeOf(result, "alpha").raw, "pass");
    assert.equal(outcomeOf(result, "alpha").evidence.ref, row.sys_id);
    const [read] = requestsTo(
      instance,
      `${TABLE_API_PREFIX}${ATF_TEST_RESULT_TABLE}`,
    );
    assert.ok(read, "no result read was issued");
    assert.equal(
      read.params["sysparm_query"],
      `test_suite_result=${instance.cicd.runs()[0].resultSysId}^test=${testSysIdOf("alpha")}^ORDERBYDESCsys_created_on`,
    );
    assert.equal(instance.cicd.runs()[0].resultSysId, suiteResultId(1));
  });

  it("a linked pass is kept even when the suite as a whole was Canceled", async () => {
    // A test that finished before the cancel wrote a row linked to this
    // execution; that row IS evidence about this run.
    const instance = createFakeInstance({ cicd: { pollsToComplete: 1 } });
    instance.cicd.setOutcome(SUITE_ID, "canceled");
    const { specs, projection, testSysIdOf } = plan([
      { id: "alpha" },
      { id: "beta" },
    ]);
    seedResult(instance, { test: testSysIdOf("alpha"), status: "success" });
    seedResult(instance, {
      test: testSysIdOf("beta"),
      status: "success",
      link: null,
    });

    const events = collector();
    const { runner } = harness(instance);
    const result = await runner.run(
      makeCtx({ projection }),
      specs,
      events.emit,
    );

    assert.equal(outcomeOf(result, "alpha").raw, "pass");
    assert.equal(outcomeOf(result, "beta").raw, "missing");
  });
});
