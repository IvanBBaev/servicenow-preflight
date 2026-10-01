// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// A Reporter that keeps the event stream in memory so the CLI can print WHICH
// assertion went red. The §6a verdict says the spec failed; only the event
// stream says "at threshold: exactly 100 units get 10% off" failed, and the
// whole point of the green/red pair is that the red run names it.
//
// Phase 1 replaces this with the real reporters (JUnit / SARIF / console). Note
// the ARCH-24 flush boundary: `close(runId)` is where a real reporter writes
// its file, and core awaits it before teardown starts.

import type { Reporter } from "@tessera/core";
import type { RunId, TestEvent, TestSpecRef } from "@tessera/types";

/** One red assertion, attributed to the spec that reported it. */
export interface FailedAssertion {
  readonly spec: TestSpecRef;
  readonly assertion: string;
}

export interface CollectingReporter extends Reporter {
  /** Every event, in emission order. */
  events(): readonly TestEvent[];
  /** `fail` events, flattened to (spec, assertion) pairs. */
  failures(): readonly FailedAssertion[];
  /** `error` events — infra faults, not evidence about a test (DEV-1). */
  errors(): readonly string[];
  /** Runs whose flush boundary was reached. */
  closed(): readonly RunId[];
}

export function createCollectingReporter(): CollectingReporter {
  const events: TestEvent[] = [];
  const closed: RunId[] = [];

  return {
    onEvent(event: TestEvent): void {
      events.push(event);
    },

    async close(runId: RunId): Promise<void> {
      // ARCH-24: the flush boundary. Nothing to flush in memory, but the run
      // is recorded so a test can prove core awaited it before teardown.
      closed.push(runId);
      return Promise.resolve();
    },

    events() {
      return events;
    },

    failures() {
      return events.flatMap((event) =>
        event.kind === "fail"
          ? [{ spec: event.spec, assertion: event.assertion }]
          : [],
      );
    },

    errors() {
      return events.flatMap((event) =>
        event.kind === "error" ? [event.cause] : [],
      );
    },

    closed() {
      return closed;
    },
  };
}
