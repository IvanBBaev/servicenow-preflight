// Shared fixtures and the hand-rolled XML well-formedness check.
//
// The check is hand-rolled on purpose: this package has zero runtime
// dependencies beyond `@tessera/*`, and adding an XML parser to the test tree
// only to assert that our own escaping worked would move the assertion from
// "the document is well formed" to "one parser accepted it".

import assert from "node:assert/strict";

export const RUN_ID = "run-2026-08-21-000001";

export const spec = (id, path) => ({ id, path: path ?? `tests/${id}.unit.ts` });

/** Characters XML 1.0 forbids outright — none may survive into a document. */
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const VALID_ENTITY = /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/;

/**
 * Asserts tag balance, quoted attributes, valid entities and the absence of
 * every character XML 1.0 excludes. Returns the tag stack trace for debugging.
 */
export function assertWellFormedXml(xml) {
  assert.equal(
    XML_FORBIDDEN.test(xml),
    false,
    "document contains a character XML 1.0 forbids",
  );
  assert.equal(
    LONE_SURROGATE.test(xml),
    false,
    "document contains an unpaired surrogate",
  );

  const stack = [];
  let index = 0;
  while (index < xml.length) {
    const char = xml[index];
    if (char === "&") {
      const match = VALID_ENTITY.exec(xml.slice(index));
      assert.ok(match, `bare "&" at offset ${index}`);
      index += match[0].length;
      continue;
    }
    if (char !== "<") {
      index += 1;
      continue;
    }
    if (xml.startsWith("<?", index)) {
      const end = xml.indexOf("?>", index);
      assert.ok(end > 0, "unterminated processing instruction");
      index = end + 2;
      continue;
    }
    const end = xml.indexOf(">", index);
    assert.ok(end > 0, `unterminated tag at offset ${index}`);
    const raw = xml.slice(index + 1, end);
    index = end + 1;

    // Attribute values must be double-quoted and may not carry a raw "<".
    const attributes = raw.slice(raw.indexOf(" ") + 1);
    if (raw.includes(" ")) {
      for (const [, value] of attributes.matchAll(
        /=("[^"]*"|'[^']*'|[^\s/>]*)/g,
      )) {
        assert.ok(
          value.startsWith('"') && value.endsWith('"'),
          `attribute value is not double-quoted: ${value}`,
        );
        assert.equal(
          value.slice(1, -1).includes("<"),
          false,
          "raw < inside an attribute value",
        );
      }
    }

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      assert.equal(stack.pop(), name, `mismatched closing tag </${name}>`);
      continue;
    }
    if (raw.endsWith("/")) continue; // self-closing
    stack.push(raw.split(/[\s/]/)[0]);
  }
  assert.deepEqual(stack, [], "unclosed elements remain");
  return true;
}

/** The events a `pass`/`fail`/`error` run produces, end included. */
export function eventsFor(outcomes, extras = []) {
  return [
    ...extras,
    {
      kind: "end",
      runId: RUN_ID,
      result: { runId: RUN_ID, outcomes },
    },
  ];
}

/** Every malformed thing a reporter may be handed without throwing. */
export function malformedEvents() {
  const throwing = {
    get kind() {
      throw new Error("hostile getter");
    },
  };
  return [
    undefined,
    null,
    42,
    "start",
    [],
    {},
    { kind: "unknown-kind", runId: RUN_ID },
    { kind: "start" },
    { kind: "start", runId: RUN_ID, spec: null },
    {
      kind: "fail",
      runId: RUN_ID,
      spec: spec("a"),
      assertion: { toString: null },
    },
    { kind: "error", runId: RUN_ID },
    { kind: "log", runId: RUN_ID, message: 7 },
    { kind: "end", runId: RUN_ID },
    { kind: "end", runId: RUN_ID, result: { outcomes: "not-an-array" } },
    {
      kind: "end",
      runId: RUN_ID,
      result: { outcomes: [null, 5, { raw: "pass" }] },
    },
    throwing,
  ];
}
