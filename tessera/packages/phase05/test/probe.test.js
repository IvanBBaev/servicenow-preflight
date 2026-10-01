// The §11.2 instance probe.
//
// THE PROPERTY UNDER TEST, in the module's own words: "An unreadable property
// is reported as `unreachable`, never as a clearance: a probe that cannot be
// read must not make an instance look safer than the allowlist says it is."
//
// `InstanceProbe` encodes "no boolean arrived" as an ABSENT KEY, so every
// assertion below checks key presence with `in` rather than comparing to
// `undefined`. A test that only asserts `result.productionProperty === undefined`
// passes for a probe that sets the key to `undefined` explicitly and for one
// that sets it to `false` because nobody looked — which is the exact defect
// this file exists to catch.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

import * as sharedTypes from "@tessera/types";

import { createInstanceProbe, PRODUCTION_PROPERTY } from "../build/probe.js";
import {
  ATF_RUNNER_ENABLED_PROPERTY,
  SYS_PROPERTIES_TABLE,
} from "../build/atf.js";
import { harness, HOST } from "./support.js";

const REF = { name: "fake", host: HOST };

/** Seed state carrying exactly the property rows a case needs. */
function properties(rows) {
  return { [SYS_PROPERTIES_TABLE]: rows };
}

const opened = [];
after(() => {
  for (const h of opened) h.restore();
});

function open(options) {
  const h = harness(options);
  opened.push(h);
  return h;
}

describe("createInstanceProbe", () => {
  it("reports both booleans when both rows carry a boolean", async () => {
    const h = open({
      state: properties([
        { name: PRODUCTION_PROPERTY, value: "false" },
        { name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" },
      ]),
    });
    try {
      const result = await createInstanceProbe()(REF);
      assert.equal(result.productionProperty, false);
      assert.equal(result.atfRunnerEnabled, true);
      // Nothing was unreadable, so the account of unreadable things is absent
      // rather than an empty array a caller would have to know to ignore.
      assert.equal("unreachable" in result, false);
    } finally {
      h.restore();
    }
  });

  it("reports a production instance as production, not as a clearance", async () => {
    const h = open({
      state: properties([
        { name: PRODUCTION_PROPERTY, value: "true" },
        { name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" },
      ]),
    });
    try {
      const result = await createInstanceProbe()(REF);
      assert.equal(result.productionProperty, true);
    } finally {
      h.restore();
    }
  });

  it("a refused read yields NO boolean at all — not a false one", async () => {
    const h = open({
      state: properties([
        { name: PRODUCTION_PROPERTY, value: "true" },
        { name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" },
      ]),
    });
    h.fake.faults.add({
      match: { method: "GET", table: SYS_PROPERTIES_TABLE },
      mode: { kind: "http-error", status: 403, message: "no read access" },
    });
    try {
      const result = await createInstanceProbe()(REF);
      // The instance IS production, and the probe could not see that. It must
      // therefore claim neither the true reading nor a safe-looking false one.
      assert.equal(
        "productionProperty" in result,
        false,
        "a probe that could not read must not carry a productionProperty",
      );
      assert.equal(
        "atfRunnerEnabled" in result,
        false,
        "a probe that could not read must not carry an atfRunnerEnabled",
      );
      // Wave 16: each property is its own query, so each refusal is its own
      // account, and each names the property it cost.
      assert.equal(result.unreachable.length, 2);
      assert.ok(
        result.unreachable.every((note) =>
          /sys_properties is unreadable/.test(note),
        ),
      );
      for (const name of [PRODUCTION_PROPERTY, ATF_RUNNER_ENABLED_PROPERTY]) {
        assert.ok(
          result.unreachable.some((note) => note.includes(name)),
          `the refused read of ${name} is named`,
        );
      }
    } finally {
      h.restore();
    }
  });

  it("a transport failure is reported, never swallowed into an empty probe", async () => {
    const h = open({ state: properties([]) });
    h.fake.faults.add({
      match: { method: "GET", table: SYS_PROPERTIES_TABLE },
      mode: { kind: "transport-error", message: "socket hang up" },
    });
    try {
      const result = await createInstanceProbe()(REF);
      assert.ok(Array.isArray(result.unreachable));
      assert.ok(result.unreachable.length > 0);
      assert.match(result.unreachable[0], /unreadable/);
    } finally {
      h.restore();
    }
  });

  it("an absent row is unreachable, not an absent-means-safe false", async () => {
    const h = open({ state: properties([]) });
    try {
      const result = await createInstanceProbe()(REF);
      assert.equal("productionProperty" in result, false);
      assert.equal("atfRunnerEnabled" in result, false);
      assert.equal(result.unreachable.length, 2);
      assert.ok(
        result.unreachable.some((note) => note.includes(PRODUCTION_PROPERTY)),
        "the absent production property must be named",
      );
      assert.ok(
        result.unreachable.some((note) =>
          note.includes(ATF_RUNNER_ENABLED_PROPERTY),
        ),
        "the absent ATF-runner property must be named",
      );
    } finally {
      h.restore();
    }
  });

  it("a non-boolean value fails closed to the property's safe direction", async () => {
    // Wave 16 (delegated decision): this used to produce NO boolean, while
    // `@tessera/doctor` (and `@tessera/cli`'s guard probe over it) read the
    // same row as production. Both probes now share `decidePropertyRows`:
    // only an exact `false` is a non-production instance, only an exact
    // `true` an enabled runner, and anything else — `yes`, `""` — reads in
    // the safe direction, with the probe's own account beside it.
    for (const [production, runner] of [
      ["yes", ""],
      ["", "garbage"],
      ["garbage", "1"],
    ]) {
      const h = open({
        state: properties([
          { name: PRODUCTION_PROPERTY, value: production },
          { name: ATF_RUNNER_ENABLED_PROPERTY, value: runner },
        ]),
      });
      try {
        const result = await createInstanceProbe()(REF);
        const label = JSON.stringify([production, runner]);
        assert.equal(result.productionProperty, true, label);
        assert.equal(result.atfRunnerEnabled, false, label);
        assert.equal(result.unreachable.length, 2, label);
        assert.ok(
          result.unreachable.every((note) => /fails closed/.test(note)),
          JSON.stringify(result.unreachable),
        );
        // Instance-authored text never reaches a guard message.
        for (const value of [production, runner].filter(Boolean)) {
          assert.ok(
            result.unreachable.every((note) => !note.includes(value)),
            `${value} is not quoted`,
          );
        }
      } finally {
        h.restore();
      }
    }
  });

  it("one unreadable property does not suppress the other's reading", async () => {
    // Two observations, not one: a probe that collapsed them would either drop
    // the good reading or invent a bad one.
    const h = open({
      state: properties([
        { name: PRODUCTION_PROPERTY, value: "TRUE" },
        { name: ATF_RUNNER_ENABLED_PROPERTY, value: "maybe" },
      ]),
    });
    try {
      const result = await createInstanceProbe()(REF);
      assert.equal(result.productionProperty, true, "case-insensitive read");
      assert.equal(result.atfRunnerEnabled, false, "fails closed (wave 16)");
      assert.equal(result.unreachable.length, 1);
      assert.match(result.unreachable[0], /sn_atf\.runner\.enabled/);
    } finally {
      h.restore();
    }
  });
  it("reads each property with its own query and its own row budget (wave 16)", async () => {
    // One `nameIN` query used to share the eleven-row budget between both
    // names, so duplicates of one property could make the other unreadable.
    const h = open({
      state: properties([
        { name: PRODUCTION_PROPERTY, value: "false" },
        { name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" },
      ]),
    });
    try {
      await createInstanceProbe()(REF);
      const reads = h.fake
        .requests()
        .filter((r) => r.path.includes(SYS_PROPERTIES_TABLE));
      assert.equal(reads.length, 2, "one request per property, no more");
      assert.deepEqual(reads.map((r) => r.params.sysparm_query).sort(), [
        `name=${PRODUCTION_PROPERTY}`,
        `name=${ATF_RUNNER_ENABLED_PROPERTY}`,
      ]);
      assert.ok(reads.every((r) => r.params.sysparm_limit === "11"));
    } finally {
      h.restore();
    }
  });

  describe("duplicate property rows (2026-09-26)", () => {
    // `sys_properties.name` is not unique-enforced in every instance's
    // history, and the query below can answer with two rows for one name.
    // The last row used to win silently, so `true` then `false` for the
    // production property read as a non-production clearance.
    async function probeWith(rows) {
      const h = open({ state: properties(rows) });
      try {
        return await createInstanceProbe()(REF);
      } finally {
        h.restore();
      }
    }

    it("reads any `true` among differing production rows as production", async () => {
      for (const order of [
        ["true", "false"],
        ["false", "true"],
        ["false", "maybe", "TRUE"],
        // Wave 16: the cases that used to read unknown here and production
        // in `@tessera/doctor`.
        ["false", "garbage"],
        ["false", ""],
        ["", "false"],
      ]) {
        const result = await probeWith([
          ...order.map((value) => ({ name: PRODUCTION_PROPERTY, value })),
          { name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" },
        ]);
        assert.equal(result.productionProperty, true, order.join(","));
        assert.ok(
          result.unreachable.some(
            (note) =>
              note.includes(PRODUCTION_PROPERTY) && /differing/.test(note),
          ),
          `the disagreement is named: ${JSON.stringify(result.unreachable)}`,
        );
      }
    });

    it("differing production rows with no `true` still read production (wave 16)", async () => {
      const result = await probeWith([
        { name: PRODUCTION_PROPERTY, value: "false" },
        { name: PRODUCTION_PROPERTY, value: "yes" },
        { name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" },
      ]);
      assert.equal(result.productionProperty, true);
      assert.ok(
        result.unreachable.some(
          (note) =>
            note.includes(PRODUCTION_PROPERTY) && /differing/.test(note),
        ),
      );
    });

    it("differing ATF-runner rows read not enabled, whichever order they arrive in", async () => {
      // Wave 16: the runner's safe direction is "not enabled" — the reading
      // this package's provisioner and the doctor's precondition already gave
      // differing rows — so it is now the boolean, not a missing one.
      for (const order of [
        ["false", "true"],
        ["true", "false"],
        ["true", "garbage"],
        ["", "true"],
      ]) {
        const result = await probeWith([
          { name: PRODUCTION_PROPERTY, value: "false" },
          ...order.map((value) => ({
            name: ATF_RUNNER_ENABLED_PROPERTY,
            value,
          })),
        ]);
        assert.equal(result.atfRunnerEnabled, false, order.join(","));
        assert.equal(result.productionProperty, false);
        assert.equal(result.unreachable.length, 1);
        assert.match(result.unreachable[0], /sn_atf\.runner\.enabled/);
        assert.match(result.unreachable[0], /differing/);
      }
    });

    it("duplicates that agree are one reading, with nothing to caveat", async () => {
      const result = await probeWith([
        { name: PRODUCTION_PROPERTY, value: "false" },
        { name: PRODUCTION_PROPERTY, value: " FALSE" },
        { name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" },
        { name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" },
      ]);
      assert.equal(result.productionProperty, false);
      assert.equal(result.atfRunnerEnabled, true);
      assert.equal("unreachable" in result, false);
    });
  });
});

describe("one shared duplicate-row rule (wave 16)", () => {
  async function probeWith(rows) {
    const h = open({ state: properties(rows) });
    try {
      return await createInstanceProbe()(REF);
    } finally {
      h.restore();
    }
  }

  // The boolean each property reads as, derived from `@tessera/types`' shared
  // decision alone — the probe must agree with it case by case.
  function expected(values, direction) {
    const decision = sharedTypes.decidePropertyRows(
      values.map(sharedTypes.normalisePropertyValue),
      true,
      direction,
    );
    const safe = direction.canonical === "true";
    if (decision.kind === "safe") return safe;
    if (decision.kind === "agreed") {
      const value = sharedTypes.normalisePropertyValue(values[0]);
      return sharedTypes.readsSafeDirection(value, direction) ? safe : !safe;
    }
    return undefined;
  }

  for (const values of [
    ["true"],
    ["false"],
    ["TRUE"],
    ["garbage"],
    [""],
    ["false", "garbage"],
    ["false", ""],
    ["true", "false"],
    ["false", " FALSE"],
    ["true", "TRUE"],
  ]) {
    it(`both properties read ${JSON.stringify(values)} as the shared rule does`, async () => {
      const result = await probeWith([
        ...values.map((value) => ({ name: PRODUCTION_PROPERTY, value })),
        ...values.map((value) => ({
          name: ATF_RUNNER_ENABLED_PROPERTY,
          value,
        })),
      ]);
      assert.equal(
        result.productionProperty,
        expected(values, sharedTypes.PRODUCTION_SAFE_DIRECTION),
      );
      assert.equal(
        result.atfRunnerEnabled,
        expected(values, sharedTypes.ATF_RUNNER_SAFE_DIRECTION),
      );
    });
  }

  it("a stray row for another name is not read as either property", async () => {
    // Each read asks for one name; a row answering for another (an instance
    // ignoring the query) is not evidence for the property asked about.
    const h = open({ state: properties([]) });
    const installed = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ result: [{ name: "some.other", value: "false" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    try {
      const result = await createInstanceProbe()(REF);
      assert.equal("productionProperty" in result, false);
      assert.equal("atfRunnerEnabled" in result, false);
      assert.equal(result.unreachable.length, 2);
      assert.ok(
        result.unreachable.every((note) => !note.includes("some.other")),
        JSON.stringify(result.unreachable),
      );
    } finally {
      globalThis.fetch = installed;
      h.restore();
    }
  });

  it("the built probe carries no rule of its own", () => {
    const built = readFileSync(
      new URL("../build/probe.js", import.meta.url),
      "utf8",
    );
    assert.match(built, /decidePropertyRows\(/);
    assert.match(built, /PRODUCTION_SAFE_DIRECTION/);
    assert.match(built, /ATF_RUNNER_SAFE_DIRECTION/);
    assert.doesNotMatch(built, /function toBoolean|anyTrueWins|nameIN/);
  });
});
