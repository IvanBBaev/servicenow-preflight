// Shared fixtures for the ATF runner adapter's suites.
//
// Three things live here, and the reasons they live here matter.
//
// 1. `plan()` builds the specs AND the `ProjectionMap` that attributes them, in
//    one call. ARCH-26/DEV-16 make the projection the only attribution key, so
//    a fixture that lets the two drift apart is a fixture that proves nothing
//    about DEV-6 attribution.
//
// 2. `fakeClient()` binds the `AtfHttpClient` port to `@tessera/fake-instance`
//    and reproduces the one transport behaviour the adapter depends on: a
//    non-2xx answer is a REJECTION, carrying the real `ServiceNowError` that
//    `@tessera/sn-client`'s `core/http.ts` would raise. It throws the genuine
//    foreign type on purpose — the adapter normalises transport errors at its
//    side of the port, and a fake that already threw the marker type would make
//    that normalisation unfalsifiable. The port carries no `signal` (see
//    `src/client.ts`), so this binding deliberately does not forward one
//    either — an in-flight request always runs to completion, exactly as it
//    would in production.
//
// 3. `scriptedClient()` covers what the fake instance cannot express: a body
//    that is not the shape we speak, a row with a missing column, a response
//    with no `result` array. Those are DEV-1 infra faults with no fake-side
//    knob.
//
// `manualClock()` is the reason no suite here touches the wall clock: `now` and
// `sleep` are injected into both the poll loop and the runner, so a fifteen
// minute deadline is exercised in microseconds and the backoff schedule is
// asserted exactly rather than approximately.

import assert from "node:assert/strict";

import { specKey } from "@tessera/core";
import { deriveSysId } from "@tessera/fake-instance";
import { ServiceNowError } from "@tessera/sn-client";

import {
  ATF_TARGET_TABLE,
  ATF_TEST_RESULT_ITEM_TABLE,
  ATF_TEST_RESULT_TABLE,
} from "../build/index.js";

export const RUN_ID = "run-2026-08-21-000001";

export const TOPOLOGY = {
  source: "source.service-now.com",
  runner: "dev12345.service-now.com",
  target: "dev12345.service-now.com",
};

/**
 * A string that exists only inside a column the TM-1 allowlist excludes. The
 * assertion that matters is not "the event text is tidy" but "this exact
 * sequence of characters never reached a `TestEvent`" — and a marker nothing
 * else could plausibly emit is the only way to state it.
 */
export const CANARY = "canary-3d17-never-print-this";

/** Its opposite number: planted in an allowlisted column, so it MUST appear. */
export const VISIBLE = "visible-4a02-expected-in-the-assertion";

/** Deterministic 32-char sys_id from a label — hex, so `assertQueryable` passes. */
export function sysId(label) {
  let hex = "";
  for (const ch of label) hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return `${hex}${"0".repeat(32)}`.slice(0, 32);
}

export const SUITE_ID = sysId("suite");

export const spec = (id, path) => ({ id, path: path ?? `tests/${id}.unit.ts` });

/**
 * Build ATF specs plus the projection that attributes them.
 *
 * Each entry is `{ id, testSysId?, suiteSysId?, kind?, table?, projected? }`.
 * `projected: false` omits the spec from the map — the DEV-1 case where the
 * adapter has no attribution key and must refuse to run.
 */
export function plan(entries, options = {}) {
  const runId = options.runId ?? RUN_ID;
  const defaultSuite = options.suiteSysId ?? SUITE_ID;
  const specs = [];
  const projection = {};
  for (const entry of entries) {
    const ref = spec(entry.id);
    const testSysId = entry.testSysId ?? sysId(`test-${entry.id}`);
    specs.push({
      ref,
      kind: entry.kind ?? "unit",
      targets: [
        {
          table: entry.table ?? ATF_TARGET_TABLE,
          sysId: testSysId,
          name: `ATF: ${entry.id}`,
        },
      ],
    });
    if (entry.projected === false) continue;
    projection[specKey(ref)] = {
      testSysId,
      suiteSysId: entry.suiteSysId ?? defaultSuite,
      runId,
    };
  }
  return { specs, projection, testSysIdOf: (id) => sysId(`test-${id}`) };
}

/** `PlannedSpec[]` for `aggregateVerdict` — one row per spec, as §6a requires. */
export function plannedFrom(specs) {
  return specs.map((entry) => ({
    spec: entry.ref,
    kind: entry.kind,
    target: entry.targets[0],
  }));
}

/** A `PipelineContext`; `signal` defaults to one that never aborts. */
export function makeCtx(options = {}) {
  return {
    runId: options.runId ?? RUN_ID,
    lifecycle: options.lifecycle ?? "ephemeral",
    coverageSource: "test",
    topology: TOPOLOGY,
    signal: options.signal ?? new AbortController().signal,
    ...(options.projection === undefined
      ? {}
      : { projection: options.projection }),
  };
}

/** Collects everything a runner emits, so a suite can assert on the whole tape. */
export function collector() {
  const events = [];
  return {
    events,
    emit: (event) => events.push(event),
    of: (kind) => events.filter((event) => event.kind === kind),
    /** The whole tape as one string — what a canary assertion greps. */
    text: () => JSON.stringify(events),
  };
}

/**
 * An injectable clock. `sleep` advances it and records the requested delay, so
 * a test reads the backoff schedule straight out of `sleeps`.
 */
export function manualClock(startMs = 1_000_000) {
  let current = startMs;
  const sleeps = [];
  return {
    sleeps,
    now: () => current,
    advance(ms) {
      current += ms;
    },
    sleep(ms) {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
  };
}

/**
 * Bind the `AtfHttpClient` port to a fake instance. Non-2xx becomes a
 * `ServiceNowError` because that is what the real transport does; the adapter's
 * DEV-1 behaviour is only meaningful against that shape.
 */
export function fakeClient(instance) {
  const calls = [];
  return {
    calls,
    async request({ method, path, params }) {
      calls.push({ method, path, params: Object.fromEntries(params ?? []) });
      const response = await instance.handle({
        method,
        path,
        ...(params === undefined ? {} : { params }),
      });
      if (response.status < 200 || response.status > 299) {
        throw new ServiceNowError(
          `ServiceNow API error (${response.status}) on ${method} ${path}`,
          response.status,
          response.body,
        );
      }
      const total = response.headers?.["x-total-count"];
      return {
        data: response.body,
        status: response.status,
        ...(total === undefined ? {} : { total: Number(total) }),
      };
    },
  };
}

/**
 * A client driven by a handler instead of a state machine. The handler receives
 * the `AtfRequest` and returns an `AtfResponse` (or throws); every request is
 * recorded for assertions about what actually went on the wire.
 */
export function scriptedClient(handler) {
  const calls = [];
  return {
    calls,
    /** Query parameters of the nth call, as a plain object. */
    paramsOf(index) {
      const call = calls[index];
      assert.ok(call, `no request at index ${index}`);
      return Object.fromEntries(call.params ?? []);
    },
    async request(args) {
      calls.push(args);
      const result = await handler(args, calls.length - 1);
      return { status: 200, ...result };
    },
  };
}

/**
 * True for a Table API read of `sys_atf_test_suite_result` — the wave 13
 * child-suite tree read the runner issues before the result read.
 */
export function isSuiteTreeRead(args) {
  return (
    typeof args?.path === "string" &&
    args.path.endsWith("/sys_atf_test_suite_result")
  );
}

/** A `{ result: rows }` page plus the `X-Total-Count` the Table API sends. */
export function tablePage(rows, total = rows.length) {
  return { data: { result: rows }, status: 200, total };
}

/**
 * The `sys_atf_test_suite_result` sys_id the fake instance mints for its nth
 * suite trigger (default seed "tessera", per-table ordinal — see
 * `@tessera/fake-instance`'s `ids.ts`). It is also the `links.results.id` the
 * fake's terminal progress payload carries, i.e. the execution link the runner
 * filters `sys_atf_test_result` by.
 */
export function suiteResultId(ordinal = 1) {
  return deriveSysId(`tessera|sys_atf_test_suite_result|${ordinal}`);
}

/**
 * Seed one `sys_atf_test_result` row. The fake's CI/CD model writes only
 * `sys_atf_test_suite_result` (a suite-level rollup), which is precisely
 * ARCH-9's point: per-spec attribution cannot come from progress, so the
 * per-test rows have to be planted here.
 *
 * `link` is the row's `test_suite_result` reference — the column that ties a
 * per-test result to ONE suite execution. It defaults to the first suite
 * result the fake mints ({@link suiteResultId}), so a single-trigger scenario
 * is linked to its own run. `link: null` seeds an UNLINKED row (a stale or
 * foreign result the runner must refuse); any other string links the row to
 * that suite result (a concurrent run, or the second trigger of a scenario).
 */
export function seedResult(instance, fields) {
  const link = fields.link === undefined ? suiteResultId(1) : fields.link;
  const row = {
    test: fields.test,
    status: fields.status,
    output: fields.output ?? "",
    ...(link === null ? {} : { test_suite_result: link }),
    ...(fields.sys_id === undefined ? {} : { sys_id: fields.sys_id }),
    ...(fields.sys_created_on === undefined
      ? {}
      : { sys_created_on: fields.sys_created_on }),
    ...fields.extra,
  };
  return instance.tables.insert(ATF_TEST_RESULT_TABLE, row);
}

/** Seed one `sys_atf_test_result_item` (step) row. */
export function seedResultItem(instance, fields) {
  return instance.tables.insert(ATF_TEST_RESULT_ITEM_TABLE, {
    test_result: fields.test_result,
    status: fields.status,
    output: fields.output ?? "",
    order: String(fields.order ?? ""),
    ...fields.extra,
  });
}

/** The recorded requests whose path starts with `prefix`. */
export function requestsTo(instance, prefix) {
  return instance.requests().filter((entry) => entry.path.startsWith(prefix));
}

/** Assert a rejection is the DEV-1 marker type and say so by name, not by shape. */
export async function assertInfraFault(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.equal(
      error.name,
      "AtfInfrastructureError",
      `expected a DEV-1 adapter fault, got ${error.name}: ${error.message}`,
    );
    if (expected !== undefined) assert.match(error.message, expected);
    return true;
  });
}

/**
 * Assert a TRANSPORT failure came back normalised without being flattened.
 *
 * Checking the type alone would be a weaker test than the old one it replaces:
 * a boundary that answered every transport failure with the string
 * "infrastructure fault" would pass a type check and destroy exactly the
 * diagnostic the person debugging the instance needs. So all three carriers are
 * asserted together — the marker type, the ORIGINAL error still reachable as
 * `cause` (with its own `status`/`detail` intact, as objects), and the original
 * text quoted into the message, because `core` flattens a rejection to
 * `${name}: ${message}` for the report and the "why" has to survive that.
 *
 * @param expected `{ status, cause, message }` — `message` is a RegExp.
 */
export async function assertNormalisedFault(promise, expected = {}) {
  await assert.rejects(promise, (error) => {
    assert.equal(
      error.name,
      "AtfInfrastructureError",
      `expected the boundary to normalise, got ${error.name}: ${error.message}`,
    );
    if (expected.cause !== undefined) {
      assert.equal(
        error.cause,
        expected.cause,
        "the original error must be the `cause`, not a copy of its text",
      );
    }
    if (expected.status !== undefined) {
      assert.equal(error.status, expected.status, "lifted HTTP status");
      assert.equal(
        error.cause?.status,
        expected.status,
        "the status on the original error must survive too",
      );
    }
    if (expected.message !== undefined) {
      assert.match(error.message, expected.message);
    }
    return true;
  });
}
