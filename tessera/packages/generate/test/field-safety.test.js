// Review W7b, M1 — control, bidi and zero-width characters, and the length
// caps, on the short model-authored fields (id, filename, target triple).
//
// These fields are printed to a terminal and written into a manifest a human
// reads. Before this review a bidi override in a target name went straight to
// stdout, and a thousand-character id was accepted. They are now refused where
// they enter (`parseCandidates`) and escaped where they leave (the CLI uses
// `escapeForTerminal`).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { untrusted } from "@tessera/types";

import {
  GenerationFaultError,
  MAX_ID_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_TARGETS_PER_SPEC,
  escapeForTerminal,
  hasUnsafeTextCharacter,
  isSafeField,
  parseCandidates,
  sanitizeModelId,
} from "../build/index.js";

function completionOf(text) {
  return {
    text: untrusted(text),
    modelId: "template://test",
    promptHash: "d".repeat(64),
    stopReason: "end_turn",
  };
}

const TARGET = {
  table: "sys_script_include",
  sysId: "0123456789abcdef0123456789abcdef",
  name: "Discount",
};

function specJson(overrides = {}) {
  return {
    id: "discount.unit.1",
    kind: "unit",
    filename: "discount.unit.ts",
    targets: [TARGET],
    source: "assertEquals(1, f());\n",
    ...overrides,
  };
}

function parse(spec) {
  return parseCandidates(completionOf(JSON.stringify({ specs: [spec] })));
}

/** Every refusal is a fault, and its message quotes none of the field. */
function assertRefused(spec, marker) {
  assert.throws(
    () => parse(spec),
    (error) => {
      assert.ok(error instanceof GenerationFaultError, String(error));
      assert.ok(
        !error.message.includes(marker),
        "the message echoed the field",
      );
      assert.ok(!hasUnsafeTextCharacter(error.message), error.message);
      return true;
    },
  );
}

const UNSAFE = {
  esc: "\u001b[31m",
  bel: "\u0007",
  del: "\u007f",
  c1_csi: "\u009b",
  lro: "‭",
  rlo: "‮",
  lri: "⁦",
  pdi: "⁩",
  lrm: "‎",
  zwsp: "​",
  zwj: "‍",
  bom: "﻿",
  line_sep: " ",
  para_sep: " ",
  newline: "\n",
  tab: "\t",
};

describe("fieldSafety — the character class", () => {
  for (const [name, ch] of Object.entries(UNSAFE)) {
    it(`treats ${name} as unsafe`, () => {
      assert.equal(hasUnsafeTextCharacter(`ok${ch}ok`), true);
    });
  }

  it("admits ordinary text, including non-Latin letters", () => {
    for (const text of [
      "Discount",
      "Business Rule: café",
      "Скидка",
      "a/b.c-d_e",
    ]) {
      assert.equal(hasUnsafeTextCharacter(text), false, text);
    }
  });

  it("isSafeField applies the cap", () => {
    assert.equal(isSafeField("a".repeat(MAX_ID_CHARS), MAX_ID_CHARS), true);
    assert.equal(
      isSafeField("a".repeat(MAX_ID_CHARS + 1), MAX_ID_CHARS),
      false,
    );
  });
});

describe("fieldSafety — escapeForTerminal", () => {
  it("escapes every unsafe character and the backslash, and nothing else", () => {
    assert.equal(escapeForTerminal("a‮b"), "a\\u{202E}b");
    assert.equal(escapeForTerminal("\u001b[2J"), "\\u{001B}[2J");
    assert.equal(escapeForTerminal("x\\u{202E}"), "x\\\\u{202E}");
    assert.equal(escapeForTerminal("café Скидка"), "café Скидка");
  });

  it("never lets a raw unsafe character through", () => {
    for (const ch of Object.values(UNSAFE)) {
      assert.equal(hasUnsafeTextCharacter(escapeForTerminal(`a${ch}b`)), false);
    }
  });

  it("is unambiguous: an escaped character and its literal spelling differ", () => {
    assert.notEqual(escapeForTerminal("‮"), escapeForTerminal("\\u{202E}"));
  });
});

describe("fieldSafety — sanitizeModelId", () => {
  it("strips unsafe characters and caps the length", () => {
    assert.equal(sanitizeModelId("claude‮-x\u001b"), "claude-x");
    assert.equal(sanitizeModelId("m".repeat(500)).length, MAX_MODEL_ID_CHARS);
    assert.equal(sanitizeModelId("claude-opus-5"), "claude-opus-5");
  });
});

describe("parseCandidates — refuses unsafe short fields (W7b M1)", () => {
  it("still accepts the clean baseline", () => {
    assert.equal(parse(specJson()).length, 1);
  });

  for (const [name, ch] of Object.entries(UNSAFE)) {
    it(`refuses ${name} in a target name`, () => {
      assertRefused(
        specJson({ targets: [{ ...TARGET, name: `Dis${ch}count` }] }),
        "Dis",
      );
    });
  }

  it("refuses a bidi override in the id", () => {
    assertRefused(specJson({ id: "discount‮1.tinu" }), "discount");
  });

  it("refuses a zero-width character in the filename", () => {
    assertRefused(specJson({ filename: "disc​ount.unit.ts" }), "disc");
  });

  it("refuses a control character in the table and in the sysId", () => {
    assertRefused(
      specJson({ targets: [{ ...TARGET, table: "tbl\u0000x" }] }),
      "tbl",
    );
    assertRefused(
      specJson({ targets: [{ ...TARGET, sysId: "0123\u001b456" }] }),
      "0123",
    );
  });

  it("refuses an id, filename, table, sysId and name over their caps", () => {
    assertRefused(specJson({ id: "i".repeat(MAX_ID_CHARS + 1) }), "iiii");
    assertRefused(specJson({ filename: `${"f".repeat(200)}.unit.ts` }), "ffff");
    assertRefused(
      specJson({ targets: [{ ...TARGET, table: "t".repeat(81) }] }),
      "tttt",
    );
    assertRefused(
      specJson({ targets: [{ ...TARGET, sysId: "s".repeat(65) }] }),
      "ssss",
    );
    assertRefused(
      specJson({ targets: [{ ...TARGET, name: "n".repeat(257) }] }),
      "nnnn",
    );
  });

  it("refuses more targets than the per-spec cap", () => {
    const targets = Array.from(
      { length: MAX_TARGETS_PER_SPEC + 1 },
      () => TARGET,
    );
    assertRefused(specJson({ targets }), "Discount");
    const atCap = Array.from({ length: MAX_TARGETS_PER_SPEC }, () => TARGET);
    assert.equal(parse(specJson({ targets: atCap })).length, 1);
  });
});
