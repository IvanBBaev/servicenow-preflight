// DESIGN §13.4 — a result is valid only for its exact
// {platformVersion, mutantSetHash, genConfig} key; a different key makes a
// prior result invalid, never adjusted.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  StaleResultError,
  assertResultKeyMatches,
  compareResultKey,
  pinnedGenConfigProblems,
  resultKeyHash,
} from "../build/index.js";
import { FIXTURE_GEN_CONFIG as PINNED } from "./fixtures/fixture-catalog.js";

const KEY = Object.freeze({
  platformVersion: "FIXTURE-build",
  mutantSetHash: "b".repeat(64),
  genConfig: PINNED,
});

describe("pinnedGenConfigProblems", () => {
  test("an exact config is pinned", () => {
    assert.deepEqual(pinnedGenConfigProblems(PINNED), []);
  });

  test("floating ids and missing fields are not a pin", () => {
    const cases = [
      [{ modelId: "claude-latest" }, /not an exact versioned id/],
      [{ modelId: "claude sonnet" }, /not an exact versioned id/],
      [{ modelId: "" }, /modelId/],
      [{ temperature: Number.NaN }, /temperature/],
      [{ maxTokens: 0 }, /maxTokens/],
      [{ maxTokens: 1.5 }, /maxTokens/],
      [{ promptHash: "ABC" }, /promptHash/],
      [{ promptVersion: " " }, /promptVersion/],
    ];
    for (const [change, pattern] of cases) {
      const problems = pinnedGenConfigProblems({ ...PINNED, ...change });
      assert.equal(problems.length, 1, JSON.stringify(change));
      assert.match(problems[0], pattern);
    }
    assert.deepEqual(pinnedGenConfigProblems(null), [
      "genConfig is not an object",
    ]);
  });
});

describe("result key", () => {
  test("an identical key is valid and hashes stably", () => {
    const copy = { ...KEY, genConfig: { ...PINNED } };
    assert.deepEqual(compareResultKey(KEY, copy), { valid: true });
    assert.equal(resultKeyHash(KEY), resultKeyHash(copy));
    assert.doesNotThrow(() => assertResultKeyMatches(KEY, copy));
  });

  test("any changed element invalidates the prior result", () => {
    const changes = [
      [{ platformVersion: "FIXTURE-build-2" }, "platformVersion"],
      [{ mutantSetHash: "c".repeat(64) }, "mutantSetHash"],
      [
        { genConfig: { ...PINNED, modelId: "fixture-model-2026-10-01" } },
        "genConfig.modelId",
      ],
      [{ genConfig: { ...PINNED, temperature: 0.2 } }, "genConfig.temperature"],
      [{ genConfig: { ...PINNED, maxTokens: 4097 } }, "genConfig.maxTokens"],
      [
        { genConfig: { ...PINNED, promptHash: "d".repeat(64) } },
        "genConfig.promptHash",
      ],
      [
        { genConfig: { ...PINNED, promptVersion: "fixture-prompt/2" } },
        "genConfig.promptVersion",
      ],
    ];
    for (const [change, field] of changes) {
      const current = { ...KEY, ...change };
      assert.deepEqual(compareResultKey(KEY, current), {
        valid: false,
        mismatched: [field],
      });
      assert.notEqual(resultKeyHash(current), resultKeyHash(KEY));
      assert.throws(
        () => assertResultKeyMatches(KEY, current),
        (error) =>
          error instanceof StaleResultError &&
          error.mismatched.includes(field) &&
          /never adjusted/.test(error.message),
      );
    }
  });
});
