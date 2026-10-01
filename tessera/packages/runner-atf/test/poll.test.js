// The bounded progress loop — DEV-2.
//
// Everything here runs on an injected clock. A backoff test that used real
// timers would either be slow or be a guess; with `manualClock` the schedule is
// a list of numbers and the assertions can be exact, which is the only way to
// state "the interval never exceeds the ceiling" as a fact rather than a hope.
//
// The three exits — terminal, deadline, aborted — are asserted as *returns*.
// A non-terminal run is evidence about the wait, not an error, and the caller
// turns it into `waiting-timeout` (§6a: INCONCLUSIVE, blocking). If this loop
// ever started throwing for a slow suite, a whole pipeline would report an
// infra fault where it should report an honest "still running".

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "@tessera/fake-instance";

import {
  CICD_PROGRESS_PATH_PREFIX,
  DEFAULT_INITIAL_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
  DEFAULT_MAX_POLLS,
  TERMINAL_STATUS_CODES,
  TERMINAL_STATUS_LABEL,
  fetchProgress,
  parseProgress,
  pollUntilTerminal,
  triggerSuite,
} from "../build/index.js";

import {
  SUITE_ID,
  assertInfraFault,
  assertNormalisedFault,
  fakeClient,
  manualClock,
  scriptedClient,
} from "./support.js";

const EXEC = "exec-0001";

/** One CI/CD progress envelope. */
function progress(status, statusLabel, extra = {}) {
  return {
    data: {
      result: {
        status,
        status_label: statusLabel,
        status_message: "",
        percent_complete: "50",
        ...extra,
      },
    },
    status: 200,
  };
}

/** A client that always answers "Running" — the loop only ends on a bound. */
const runningForever = () => scriptedClient(() => progress("1", "Running"));

/** Poll with an injected clock and a huge budget unless told otherwise. */
function poll(client, options = {}) {
  const clock = manualClock();
  const result = pollUntilTerminal(client, EXEC, {
    deadlineMs: 1_000_000_000,
    now: clock.now,
    sleep: clock.sleep,
    ...options,
  });
  return { clock, result };
}

describe("parseProgress", () => {
  it("maps every documented status code to a state", () => {
    const states = ["pending", "running", "successful", "failed", "canceled"];
    states.forEach((state, code) => {
      assert.equal(
        parseProgress(EXEC, progress(String(code), "").data).state,
        state,
      );
    });
  });

  it("calls an unanticipated code `unknown` instead of guessing", () => {
    assert.equal(parseProgress(EXEC, progress("9", "").data).state, "unknown");
    assert.equal(parseProgress(EXEC, progress("", "").data).state, "unknown");
  });

  it("treats 2, 3 and 4 as terminal and 0, 1 as not", () => {
    assert.deepEqual([...TERMINAL_STATUS_CODES].sort(), ["2", "3", "4"]);
    for (const code of ["2", "3", "4"]) {
      assert.equal(
        parseProgress(EXEC, progress(code, "").data).terminal,
        true,
        code,
      );
    }
    for (const code of ["0", "1"]) {
      assert.equal(
        parseProgress(EXEC, progress(code, "").data).terminal,
        false,
        code,
      );
    }
  });

  it("falls back to the label, so an unknown code cannot cost a whole deadline", () => {
    for (const label of [
      "Successful",
      "failed",
      "Canceled",
      "Cancelled",
      "  SUCCESSFUL  ",
    ]) {
      assert.equal(
        parseProgress(EXEC, progress("9", label).data).terminal,
        true,
        label,
      );
    }
    assert.equal(TERMINAL_STATUS_LABEL.test("Running"), false);
    assert.equal(
      parseProgress(EXEC, progress("9", "Running").data).terminal,
      false,
    );
  });

  it("does not let a label *containing* a terminal word end the wait early", () => {
    assert.equal(
      parseProgress(EXEC, progress("1", "failed to start, retrying").data)
        .terminal,
      false,
    );
  });

  it("degrades a non-numeric percentage to 0 rather than NaN", () => {
    const sample = parseProgress(
      EXEC,
      progress("1", "Running", { percent_complete: "half" }).data,
    );
    assert.equal(sample.percentComplete, 0);
  });

  it("returns undefined for a body that is not the envelope", () => {
    assert.equal(parseProgress(EXEC, undefined), undefined);
    assert.equal(parseProgress(EXEC, { result: [] }), undefined);
    assert.equal(parseProgress(EXEC, "<html>login</html>"), undefined);
  });
});

describe("fetchProgress", () => {
  it("GETs the progress endpoint with the execution id URL-encoded", async () => {
    const client = scriptedClient(() => progress("1", "Running"));
    await fetchProgress(client, "exec/with space");
    assert.equal(client.calls[0].method, "GET");
    assert.equal(
      client.calls[0].path,
      `${CICD_PROGRESS_PATH_PREFIX}exec%2Fwith%20space`,
    );
  });

  it("rejects with a DEV-1 fault when the body is unparseable, naming the status", async () => {
    const client = scriptedClient(() => ({
      data: { nope: true },
      status: 502,
    }));
    await assertInfraFault(
      fetchProgress(client, EXEC),
      /unparseable \(HTTP 502\); the suite state is unknown/,
    );
  });

  it("normalises a transport failure, naming the execution and keeping the original as `cause`", async () => {
    const boom = new Error("ECONNRESET");
    const client = scriptedClient(() => {
      throw boom;
    });
    await assertNormalisedFault(fetchProgress(client, EXEC), {
      cause: boom,
      message: new RegExp(
        `progress of execution ${EXEC}\\) failed: Error: ECONNRESET`,
      ),
    });
  });
});

describe("pollUntilTerminal — terminal", () => {
  it("returns on the first terminal sample without sleeping", async () => {
    const client = scriptedClient(() => progress("2", "Successful"));
    const { clock, result } = poll(client);
    const outcome = await result;
    assert.equal(outcome.outcome, "terminal");
    assert.equal(outcome.run.state, "successful");
    assert.equal(client.calls.length, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  it("keeps polling through non-terminal samples and stops at the first terminal one", async () => {
    const script = ["0", "1", "1", "3"];
    const client = scriptedClient((_args, index) =>
      progress(script[index], ""),
    );
    const { clock, result } = poll(client);
    const outcome = await result;
    assert.equal(outcome.outcome, "terminal");
    assert.equal(outcome.run.state, "failed");
    assert.equal(client.calls.length, 4);
    assert.equal(clock.sleeps.length, 3, "one sleep between each round-trip");
  });
});

describe("pollUntilTerminal — backoff", () => {
  it("doubles from the initial interval and stops at the ceiling", async () => {
    const { clock, result } = poll(runningForever(), {
      initialIntervalMs: 2_000,
      maxIntervalMs: 15_000,
      maxPolls: 5,
    });
    await result;
    assert.deepEqual(clock.sleeps, [2_000, 4_000, 8_000, 15_000, 15_000]);
    for (const wait of clock.sleeps) {
      assert.ok(wait >= 0 && wait <= 15_000, `interval ${wait} out of bounds`);
    }
  });

  it("never waits past the deadline — the last interval is clipped to what is left", async () => {
    const { clock, result } = poll(runningForever(), {
      deadlineMs: 10_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 15_000,
    });
    const outcome = await result;
    assert.deepEqual(clock.sleeps, [2_000, 4_000, 4_000]);
    assert.equal(
      clock.sleeps.reduce((a, b) => a + b, 0),
      10_000,
    );
    assert.equal(outcome.outcome, "deadline");
    assert.equal(outcome.reason, "time");
    assert.equal(outcome.polls, 3);
    assert.equal(outcome.elapsedMs, 10_000);
  });

  it("handles a zero initial interval without getting stuck doubling zero", async () => {
    const { clock, result } = poll(runningForever(), {
      initialIntervalMs: 0,
      maxPolls: 5,
    });
    await result;
    assert.deepEqual(clock.sleeps, [0, 1, 2, 4, 8]);
  });

  it("clamps the initial interval to the ceiling, in both directions", async () => {
    const fast = poll(runningForever(), {
      initialIntervalMs: 60_000,
      maxIntervalMs: 500,
      maxPolls: 3,
    });
    await fast.result;
    assert.deepEqual(fast.clock.sleeps, [500, 500, 500]);

    const frozen = poll(runningForever(), {
      initialIntervalMs: 1_000,
      maxIntervalMs: -1,
      maxPolls: 3,
    });
    await frozen.result;
    assert.deepEqual(frozen.clock.sleeps, [0, 0, 0]);
  });

  it("ships the documented defaults", () => {
    assert.equal(DEFAULT_INITIAL_INTERVAL_MS, 2_000);
    assert.equal(DEFAULT_MAX_INTERVAL_MS, 15_000);
    assert.equal(DEFAULT_MAX_POLLS, 1_000);
    assert.ok(DEFAULT_INITIAL_INTERVAL_MS <= DEFAULT_MAX_INTERVAL_MS);
  });
});

describe("pollUntilTerminal — bounds", () => {
  it("stops at the poll ceiling even when the clock never moves", async () => {
    // A frozen injected clock is a plausible harness bug; the ceiling is what
    // keeps it from becoming an infinite loop.
    const client = runningForever();
    const outcome = await pollUntilTerminal(client, EXEC, {
      deadlineMs: 1_000_000_000,
      now: () => 1_000,
      sleep: () => Promise.resolve(),
      maxPolls: 7,
    });
    assert.equal(outcome.outcome, "deadline");
    assert.equal(outcome.reason, "max-polls");
    assert.equal(outcome.polls, 7);
    assert.equal(client.calls.length, 7);
    assert.equal(outcome.elapsedMs, 0);
  });

  it("stops after a single poll when maxPolls is 1", async () => {
    const client = runningForever();
    const outcome = await poll(client, { maxPolls: 1 }).result;
    assert.equal(client.calls.length, 1);
    assert.equal(outcome.polls, 1);
    assert.equal(outcome.reason, "max-polls");
  });

  it("issues no request at all when the budget is already spent", async () => {
    const client = runningForever();
    const outcome = await poll(client, { deadlineMs: 0 }).result;
    assert.equal(outcome.outcome, "deadline");
    assert.equal(outcome.reason, "time");
    assert.equal(outcome.polls, 0);
    assert.equal(client.calls.length, 0, "no evidence was even asked for");
    assert.equal("lastRun" in outcome, false);
  });

  it("carries the last observed sample, so the caller can say what state it was in", async () => {
    const outcome = await poll(runningForever(), { maxPolls: 2 }).result;
    assert.equal(outcome.lastRun.state, "running");
    assert.equal(outcome.lastRun.executionId, EXEC);
  });
});

describe("pollUntilTerminal — abort (ARCH-28)", () => {
  it("an already-aborted signal stops the loop before the first request", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = runningForever();
    const outcome = await poll(client, { signal: controller.signal }).result;
    assert.equal(outcome.outcome, "aborted");
    assert.equal(outcome.polls, 0);
    assert.equal(client.calls.length, 0);
  });

  it("an abort mid-run stops promptly, between round-trips", async () => {
    const controller = new AbortController();
    const client = runningForever();
    const clock = manualClock();
    const outcome = await pollUntilTerminal(client, EXEC, {
      deadlineMs: 1_000_000_000,
      now: clock.now,
      sleep: (ms) => {
        controller.abort();
        return clock.sleep(ms);
      },
      signal: controller.signal,
    });
    assert.equal(outcome.outcome, "aborted");
    assert.equal(outcome.polls, 1);
    assert.equal(
      client.calls.length,
      1,
      "no further round-trip after the signal fired",
    );
    assert.equal(outcome.lastRun.state, "running");
  });

  it("does not throw — an abort is a result the caller converts to waiting-timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.doesNotReject(
      poll(runningForever(), { signal: controller.signal }).result,
    );
  });
});

describe("pollUntilTerminal — against the fake instance", () => {
  it("follows a real execution from Pending to Successful", async () => {
    const instance = createFakeInstance({ cicd: { pollsToComplete: 3 } });
    const client = fakeClient(instance);
    const handle = await triggerSuite(client, SUITE_ID);
    const clock = manualClock();
    const outcome = await pollUntilTerminal(client, handle.executionId, {
      deadlineMs: 1_000_000_000,
      now: clock.now,
      sleep: clock.sleep,
      initialIntervalMs: 1,
    });
    assert.equal(outcome.outcome, "terminal");
    assert.equal(outcome.run.state, "successful");
    assert.equal(outcome.run.statusLabel, "Successful");
    const polls = instance
      .requests()
      .filter((entry) => entry.path.startsWith(CICD_PROGRESS_PATH_PREFIX));
    assert.equal(polls.length, 3);
  });

  it("reports a failed suite as terminal, not as an infra fault", async () => {
    const instance = createFakeInstance({
      cicd: { pollsToComplete: 1, defaultOutcome: "failed" },
    });
    const client = fakeClient(instance);
    const handle = await triggerSuite(client, SUITE_ID);
    const outcome = await pollUntilTerminal(client, handle.executionId, {
      deadlineMs: 1_000_000_000,
      now: manualClock().now,
      sleep: () => Promise.resolve(),
    });
    assert.equal(outcome.outcome, "terminal");
    assert.equal(outcome.run.state, "failed");
  });

  it("a 404 on the progress endpoint rejects as a DEV-1 fault, not as a silent non-terminal", async () => {
    // The loop resolves for "still running" and rejects for "we cannot tell".
    // This is the second one, and the 404 has to still be legible as a 404
    // after the boundary normalised it — the status is on the fault itself, so
    // a caller classifies it without importing the transport's error type.
    const instance = createFakeInstance();
    await assertNormalisedFault(
      pollUntilTerminal(fakeClient(instance), "never-started", {
        deadlineMs: 1_000_000_000,
        now: manualClock().now,
        sleep: () => Promise.resolve(),
      }),
      { status: 404, message: /progress of execution never-started/ },
    );
  });
});

describe("pollUntilTerminal — option validation (fix 2026-09-25)", () => {
  // NaN never compares `>=`, so a NaN deadline AND a NaN ceiling used to
  // disable both termination bounds: the loop polled forever. A bad knob is a
  // caller bug and throws TypeError before any request — never a silent default.
  for (const [label, options] of [
    ["deadlineMs NaN", { deadlineMs: Number.NaN }],
    ["deadlineMs Infinity", { deadlineMs: Number.POSITIVE_INFINITY }],
    ["deadlineMs -Infinity", { deadlineMs: Number.NEGATIVE_INFINITY }],
    ["maxPolls NaN", { maxPolls: Number.NaN }],
    ["maxPolls 0", { maxPolls: 0 }],
    ["maxPolls -1", { maxPolls: -1 }],
    ["maxPolls 1.5", { maxPolls: 1.5 }],
    ["maxPolls Infinity", { maxPolls: Number.POSITIVE_INFINITY }],
    ["initialIntervalMs NaN", { initialIntervalMs: Number.NaN }],
    ["maxIntervalMs NaN", { maxIntervalMs: Number.NaN }],
  ]) {
    it(`rejects ${label} with TypeError and issues no request`, async () => {
      const client = runningForever();
      await assert.rejects(poll(client, options).result, TypeError);
      assert.equal(client.calls.length, 0);
    });
  }

  it("rejects NaN deadline AND NaN maxPolls together instead of looping forever", async () => {
    // The reviewer's repro E: the client throws after 50 calls so a regression
    // fails the test instead of hanging it.
    const client = scriptedClient((_args, index) => {
      if (index >= 50) throw new Error("still polling after 50 calls");
      return progress("1", "Running");
    });
    await assert.rejects(
      poll(client, { deadlineMs: Number.NaN, maxPolls: Number.NaN }).result,
      TypeError,
    );
    assert.equal(client.calls.length, 0);
  });
});

describe("pollUntilTerminal — unrecognised status (fix 2026-09-25)", () => {
  it("rejects with a DEV-1 fault on the first unrecognised status instead of waiting out the deadline", async () => {
    const client = scriptedClient(() => progress("7", "Unknown"));
    const { clock, result } = poll(client);
    await assertInfraFault(
      result,
      /unrecognised status "7" \(label "Unknown"\); the suite state is unknown/,
    );
    assert.equal(client.calls.length, 1, "no second round-trip");
    assert.deepEqual(clock.sleeps, [], "no waiting on an unreadable state");
  });

  it("rejects an empty status the same way", async () => {
    const client = scriptedClient(() => progress("", ""));
    await assertInfraFault(poll(client).result, /unrecognised status ""/);
  });

  it("still accepts an unknown code whose label is terminal", async () => {
    const client = scriptedClient(() => progress("9", "Cancelled"));
    const outcome = await poll(client).result;
    assert.equal(outcome.outcome, "terminal");
    assert.equal(outcome.run.state, "unknown");
  });

  it("an unknown sample after running samples still rejects", async () => {
    const script = ["0", "1", "7"];
    const client = scriptedClient((_args, index) =>
      progress(script[index], ""),
    );
    await assertInfraFault(poll(client).result, /unrecognised status "7"/);
    assert.equal(client.calls.length, 3);
  });
});
