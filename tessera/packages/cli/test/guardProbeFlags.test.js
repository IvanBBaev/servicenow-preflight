// Wave 17: the §11.2 guard probe's `*Uninterpretable` flags, the incomplete
// reads it settles from the rows `@tessera/doctor` carries, and the single
// source of the DR-3 runner property name.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ATF_RUNNER_ENABLED_PROPERTY } from "@tessera/types";

import { ATF_RUNNER_PROPERTY, createGuardProbe } from "../build/index.js";

const ref = { name: "dev", host: "dev.service-now.com" };

function stubProbe(answers) {
  return {
    readProperty: (name) =>
      Promise.resolve(
        answers[name] ?? { outcome: "undecidable", detail: "not stubbed" },
      ),
    readTable: () => Promise.reject(new Error("not used")),
    reachApi: () => Promise.reject(new Error("not used")),
  };
}

function bound(productionRead, runnerRead) {
  return createGuardProbe([
    {
      ref,
      probe: stubProbe({
        "glide.installation.production": productionRead,
        "sn_atf.runner.enabled": runnerRead,
      }),
    },
  ]);
}

const found = (name, value) => ({
  outcome: "found",
  value,
  detail: `${name}=${value || "(empty)"}`,
});

const PROD_FALSE = found("glide.installation.production", "false");
const RUNNER_TRUE = found("sn_atf.runner.enabled", "true");

/** An incomplete read that saw `values` and was left undecidable. */
function incompleteRead(name, values) {
  return {
    outcome: "undecidable",
    rows: values.map((value, i) => ({ sysId: `r${i}`, value })),
    incomplete: true,
    detail: `${name}: ${values.length} of ${values.length + 1} rows read; no value is read from an incomplete read`,
  };
}

describe("createGuardProbe: uninterpretable flags (wave 17)", () => {
  it("flags a found value that is neither canonical nor licensing, and keeps the boolean", async () => {
    for (const value of ["", "yes", " 1 ", "maybe"]) {
      const result = await bound(
        found("glide.installation.production", value),
        found("sn_atf.runner.enabled", value),
      )(ref);
      assert.equal(result.productionProperty, true, value);
      assert.equal(result.atfRunnerEnabled, false, value);
      assert.equal(result.productionPropertyUninterpretable, true, value);
      assert.equal(result.atfRunnerEnabledUninterpretable, true, value);
    }
  });

  it("flags each property on its own", async () => {
    const result = await bound(
      found("glide.installation.production", "garbage"),
      RUNNER_TRUE,
    )(ref);
    assert.equal(result.productionPropertyUninterpretable, true);
    assert.equal("atfRunnerEnabledUninterpretable" in result, false);
    assert.equal(result.atfRunnerEnabled, true);

    const other = await bound(
      PROD_FALSE,
      found("sn_atf.runner.enabled", "garbage"),
    )(ref);
    assert.equal("productionPropertyUninterpretable" in other, false);
    assert.equal(other.atfRunnerEnabledUninterpretable, true);
    assert.equal(other.productionProperty, false);
  });

  it("does not flag canonical or licensing values", async () => {
    for (const [production, runner] of [
      ["true", "false"],
      ["false", "true"],
      [" TRUE ", " FALSE"],
    ]) {
      const result = await bound(
        found("glide.installation.production", production),
        found("sn_atf.runner.enabled", runner),
      )(ref);
      assert.equal("productionPropertyUninterpretable" in result, false);
      assert.equal("atfRunnerEnabledUninterpretable" in result, false);
    }
  });

  it("does not flag differing rows settled in the safe direction", async () => {
    const result = await bound(
      {
        outcome: "found",
        value: "garbage",
        duplicates: "differing",
        rows: [{ value: "false" }, { value: "garbage" }],
        detail: "glide.installation.production has 2 rows",
      },
      {
        outcome: "undecidable",
        duplicates: "differing",
        rows: [{ value: "true" }, { value: "garbage" }],
        detail: "sn_atf.runner.enabled has 2 rows",
      },
    )(ref);
    assert.equal(result.productionProperty, true);
    assert.equal(result.atfRunnerEnabled, false);
    assert.equal("productionPropertyUninterpretable" in result, false);
    assert.equal("atfRunnerEnabledUninterpretable" in result, false);
  });

  it("does not flag an absent or refused read", async () => {
    const result = await bound(
      { outcome: "absent", detail: "no row" },
      { outcome: "denied", detail: "403" },
    )(ref);
    assert.equal("productionPropertyUninterpretable" in result, false);
    assert.equal("atfRunnerEnabledUninterpretable" in result, false);
  });
});

describe("createGuardProbe: incomplete reads settled from seen rows (wave 17)", () => {
  it("reads an incomplete runner read that saw a non-`true` row as not enabled", async () => {
    for (const values of [["garbage"], ["false"], [""], ["true", "false"]]) {
      const result = await bound(
        PROD_FALSE,
        incompleteRead("sn_atf.runner.enabled", values),
      )(ref);
      assert.equal(result.atfRunnerEnabled, false, JSON.stringify(values));
      assert.match(
        result.unreachable.join("\n"),
        /sn_atf\.runner\.enabled: an incomplete read saw a row reading in the safe direction — read as false \(fail closed\)/,
      );
      assert.doesNotMatch(JSON.stringify(result), /garbage/);
    }
  });

  it("keeps an incomplete runner read that saw only `true` rows undecidable", async () => {
    const result = await bound(
      PROD_FALSE,
      incompleteRead("sn_atf.runner.enabled", ["true", " TRUE"]),
    )(ref);
    assert.equal(result.atfRunnerEnabled, undefined);
    assert.match(result.unreachable.join("\n"), /no value is read/);
  });

  it("keeps an incomplete production read that saw only `false` rows undecidable", async () => {
    const result = await bound(
      incompleteRead("glide.installation.production", ["false", "false"]),
      RUNNER_TRUE,
    )(ref);
    assert.equal(result.productionProperty, undefined);
    assert.match(result.unreachable.join("\n"), /no value is read/);
  });

  it("does not settle an undecidable read with rows but neither differing nor incomplete", async () => {
    const result = await bound(PROD_FALSE, {
      outcome: "undecidable",
      rows: [{ value: "false" }],
      detail: "stray row",
    })(ref);
    assert.equal(result.atfRunnerEnabled, undefined);
  });
});

describe("ATF_RUNNER_PROPERTY", () => {
  it("is the `@tessera/types` constant", () => {
    assert.equal(ATF_RUNNER_PROPERTY, ATF_RUNNER_ENABLED_PROPERTY);
  });
});
