// Doc-drift pins.
//
// @tessera/types is pure data, so several of its load-bearing statements are
// comments with no behaviour behind them — and a comment cannot fail. Each of
// the claims pinned below was WRONG in this package's history in the same way:
// it described a guarantee the code does not make, to a consumer with no way
// to notice. Every pin therefore asserts BOTH halves — that the correction is
// present, and that the wording it replaced is gone — because a pin that only
// looked for the new sentence would pass just as happily if someone added it
// underneath the old one.
//
// tsc retains comments, so the built artifacts carry these strings verbatim.
// Like every suite here, these read `build/`, never `src/`.

import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BUILD = new URL("../build/", import.meta.url);

/** Built file with runs of whitespace and comment markers flattened. */
function prose(file) {
  return readFileSync(new URL(file, BUILD), "utf8")
    .replace(/^\s*(?:\/\/|\*)\s?/gm, " ")
    .replace(/\s+/g, " ");
}

describe("claims the code has to keep", () => {
  it("does not call the flaky outcome unreachable", () => {
    // @tessera/core's reducer collapses two disagreeing outcomes for one spec
    // key into "flaky" today (aggregateVerdict.ts:136), and its golden fixture
    // flaky-disagreement.json is a verdict carrying one. The old comment said
    // the outcome was "producible only once a re-run policy exists", which
    // entitled a consumer of RawOutcome to leave the case unhandled.
    const verdict = prose("verdict.js");
    assert.ok(
      !verdict.includes("producible only once a"),
      "RAW_OUTCOMES still describes flaky as not yet producible",
    );
    assert.ok(
      verdict.includes("REACHABLE TODAY"),
      "RAW_OUTCOMES no longer records that flaky is reachable today",
    );
    assert.ok(
      verdict.includes("aggregateVerdict.ts:136"),
      "the flaky comment no longer cites the line that produces it",
    );
  });

  it("does not let an absent evidence ref diagnose a missing row", () => {
    // `ChecklistRow.evidence` is absent whenever the SpecOutcome it folded
    // carried none, which is possible for every raw — the reducer copies and
    // never synthesizes. The old comment said "Absent only when raw ===
    // 'missing'", which is a diagnosis read off an absence with many causes.
    const declarations = prose("verdict.d.ts");
    assert.ok(
      !declarations.includes("Absent only when raw"),
      "ChecklistRow.evidence still claims absence identifies a missing row",
    );
    assert.ok(
      declarations.includes("is NOT a diagnosis"),
      "ChecklistRow.evidence no longer warns against reading its absence",
    );
  });

  it("does not claim the compiler refuses interpolation or concatenation", () => {
    // Both typecheck; `${u}` and `u + ""` yield "[object Object]", which
    // test/untrusted.test.js pins. What refuses them is the type-checked
    // ESLint set, and only inside one glob — so the header names the glob
    // rather than the compiler, and says which operation actually leaks.
    const header = prose("untrusted.js");
    assert.ok(
      !header.includes("cannot be template-interpolated"),
      "the TM-1 header still attributes interpolation safety to the compiler",
    );
    assert.ok(
      header.includes("JSON.stringify` is stopped by nothing"),
      "the TM-1 header no longer names the one operation that leaks",
    );
    assert.ok(
      header.includes("packages/*/src/**/*.ts"),
      "the TM-1 header no longer states which files the lint guard covers",
    );
  });

  it("names a lint glob that the workspace config still uses", () => {
    // The claim above is about a file outside this package, so it can rot
    // without anything in this package changing. If this fails, the ESLint
    // config was re-scoped and the TM-1 header has to be re-read, not this
    // assertion relaxed.
    const config = readFileSync(
      new URL("../../../eslint.config.js", import.meta.url),
      "utf8",
    );
    assert.ok(
      config.includes('"packages/*/src/**/*.ts"'),
      "the type-checked ESLint block no longer covers packages/*/src/**/*.ts",
    );
  });
});
