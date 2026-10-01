// The fixture generation config pins the REAL generator instructionHash.
//
// `FIXTURE_GEN_CONFIG.promptHash` was a placeholder ("a" x 64) for waves; once
// `tess benchmark` began refusing a promptHash that is not this build's unit
// instructionHash (wave 14, exit 4), every consumer had to re-pin it locally.
// The fixture now derives it from `@tessera/generate`'s `instructionHashFor`,
// and this suite fails the moment the two diverge — including a regression to
// a hand-written literal that a later edit of the generation prompt leaves
// behind.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildGenerationPrompt,
  instructionHashFor,
  renderPrompt,
} from "@tessera/generate";

import { pinnedGenConfigProblems } from "../build/index.js";
import { FIXTURE_GEN_CONFIG } from "./fixtures/fixture-catalog.js";

const EMPTY_GRAPH = Object.freeze({
  nodes: [],
  edges: [],
  unanalyzable: [],
  demanded: [],
});

describe("FIXTURE_GEN_CONFIG.promptHash is this build's unit instructionHash", () => {
  test("equals @tessera/generate instructionHashFor('unit')", () => {
    assert.equal(FIXTURE_GEN_CONFIG.promptHash, instructionHashFor("unit"));
  });

  test("equals the instructionHash a real unit generation renders", () => {
    assert.equal(
      FIXTURE_GEN_CONFIG.promptHash,
      renderPrompt(buildGenerationPrompt("unit", EMPTY_GRAPH)).instructionHash,
    );
  });

  test("is not another kind's instructionHash (the benchmark runs unit)", () => {
    assert.notEqual(FIXTURE_GEN_CONFIG.promptHash, instructionHashFor("e2e"));
  });

  test("is not a placeholder and is still a valid pin", () => {
    assert.doesNotMatch(FIXTURE_GEN_CONFIG.promptHash, /^(.)\1{63}$/);
    assert.deepEqual(pinnedGenConfigProblems(FIXTURE_GEN_CONFIG), []);
  });

  test("stays frozen", () => {
    assert.ok(Object.isFrozen(FIXTURE_GEN_CONFIG));
  });
});
