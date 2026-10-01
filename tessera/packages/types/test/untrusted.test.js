// TM-1 — the brand has to hold at runtime too.
//
// The type-level half of the brand does not survive into JS. What these tests
// protect is the half that does: the box round-trips, the door refuses to open
// without a stated boundary, and a value that was cast rather than branded is
// caught here instead of surfacing as `undefined` three stages downstream.
//
// They also pin the brand's HONEST LIMITS, which are otherwise asserted only
// in comments, and a comment cannot fail. The door's check is provenance (a
// module-private WeakSet), so a forged or copied box is refused — but
// `mapUntrusted` hands its callback the payload in the clear, and
// `JSON.stringify` still walks the box and leaks it (the written concession
// in src/untrusted.ts). Each is
// asserted POSITIVELY, because a suite that only listed what the brand refuses
// could not tell a guarantee that holds from one that was never there.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isUntrusted,
  mapUntrusted,
  untrusted,
  unwrapUntrusted,
} from "../build/index.js";

test("a branded value round-trips through the one door", () => {
  const body = "gs.info('hello');";
  const wrapped = untrusted(body);
  assert.equal(
    unwrapUntrusted(wrapped, "test — asserting the round trip"),
    body,
  );
});

test("the brand carries arbitrary payloads, not just strings", () => {
  const wrapped = untrusted({ script: "x", lines: 3 });
  assert.deepEqual(unwrapUntrusted(wrapped, "test — object payload"), {
    script: "x",
    lines: 3,
  });
});

test("unwrapping without a boundary is refused", () => {
  const wrapped = untrusted("anything");
  assert.throws(() => unwrapUntrusted(wrapped, ""), {
    name: "TypeError",
    message: /requires a boundary/,
  });
  // Whitespace is not a boundary: the string exists so a reviewer can read the
  // argument for why this unwrap is safe, and a space makes no argument.
  assert.throws(() => unwrapUntrusted(wrapped, "   "), {
    name: "TypeError",
    message: /requires a boundary/,
  });
});

test("a value that was never branded is refused rather than silently undefined", () => {
  // Exactly the set the `@throws` contract on `unwrapUntrusted` names: a bare
  // string, number, null, array or function cast past the compiler. `{}` and
  // `undefined` are here too — `{}` is rejected only by the `"value" in box`
  // half of the check, and `undefined` only by the `box === null` guard's
  // neighbouring `typeof` test, so both halves stay exercised.
  for (const impostor of [
    "raw string",
    42,
    null,
    undefined,
    {},
    [],
    () => {},
  ]) {
    assert.throws(() => unwrapUntrusted(impostor, "test — impostor"), {
      name: "TypeError",
      message: /never branded/,
    });
  }
});

test("mapUntrusted transforms the payload and stays branded", () => {
  const wrapped = untrusted("  padded  ");
  const trimmed = mapUntrusted(wrapped, (raw) => raw.trim());
  assert.equal(isUntrusted(trimmed), true);
  assert.equal(
    unwrapUntrusted(trimmed, "test — asserting the mapped value"),
    "padded",
  );
});

test("mapUntrusted does not mutate or launder the original", () => {
  const wrapped = untrusted("original");
  mapUntrusted(wrapped, (raw) => raw.toUpperCase());
  assert.equal(
    unwrapUntrusted(wrapped, "test — original unchanged"),
    "original",
  );
});

test("isUntrusted recognises the box and rejects plain values", () => {
  assert.equal(isUntrusted(untrusted("x")), true);
  assert.equal(isUntrusted("x"), false);
  assert.equal(isUntrusted(null), false);
  assert.equal(isUntrusted(undefined), false);
  assert.equal(isUntrusted({ notValue: 1 }), false);
});

const PAYLOAD = "gr.deleteRecord(); // hostile";

test("the door checks provenance, not shape", () => {
  // Delegated decision 2026-09-23: the door used to accept anything shaped
  // like a box, which let a JSON round trip re-open it on the far side of a
  // queue, cache or HTTP hop. It now accepts only a box `untrusted()` minted
  // in this process. Every copy below carries the same `{ value }` shape as a
  // real box and must be refused — asserted per copy, because a check that
  // happened to reject one kind of copy would pass a single-case test.
  const real = untrusted(PAYLOAD);
  const copies = [
    ["a hand-rolled box", { value: PAYLOAD }],
    ["a JSON round trip", JSON.parse(JSON.stringify(real))],
    ["a spread", { ...real }],
    ["an Object.assign copy", Object.assign({}, real)],
    ["a structuredClone", structuredClone(real)],
  ];
  for (const [label, copy] of copies) {
    assert.deepEqual(copy, { value: PAYLOAD }, `${label} keeps the shape`);
    assert.throws(
      () => unwrapUntrusted(copy, "test — forged copy"),
      { name: "TypeError", message: /never branded/ },
      label,
    );
  }

  // And the real box still opens — the refusal above is provenance, not a
  // door that has stopped opening at all.
  assert.equal(unwrapUntrusted(real, "test — the original"), PAYLOAD);

  // Re-branding at the far side is the sanctioned way back in: the reader of
  // a serialised payload is an ingestion boundary and brands it there.
  const rebranded = untrusted(JSON.parse(JSON.stringify(real)).value);
  assert.equal(unwrapUntrusted(rebranded, "test — re-branded"), PAYLOAD);
});

test("mapUntrusted hands its callback the payload in the clear", () => {
  // `mapUntrusted` re-brands its result, which the suite above already pins.
  // What it does NOT do is keep the payload from the callback, and that is the
  // half a reader is most likely to assume. The callback captures rather than
  // transforms so that a regression fails this assertion instead of crashing
  // inside the callback — a crash would redden the wrong channel.
  let seen;
  const result = mapUntrusted(untrusted(PAYLOAD), (raw) => {
    seen = raw;
    return "normalised";
  });
  assert.equal(seen, PAYLOAD);
  assert.equal(isUntrusted(seen), false);
  assert.equal(isUntrusted(result), true);
});

test("isUntrusted answers exactly what the door answers", () => {
  const doorOpens = (value) => {
    try {
      unwrapUntrusted(value, "test — probing the door");
      return true;
    } catch {
      return false;
    }
  };

  const candidates = [
    ["a real box", untrusted("branded")],
    ["a real box holding undefined", untrusted(undefined)],
    ["a hand-rolled box", { value: "forged" }],
    ["a hand-rolled box holding undefined", { value: undefined }],
    ["a JSON round trip of a box", JSON.parse(JSON.stringify(untrusted("x")))],
    ["a bare string", "x"],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["an array", []],
    ["a function", () => {}],
    ["an object with some other key", { notValue: 1 }],
  ];

  // The accepted set, stated in full. Listing only rejections would pass just
  // as happily against an `isUntrusted` that returns false for everything.
  assert.deepEqual(
    candidates
      .filter(([, value]) => isUntrusted(value))
      .map(([label]) => label),
    ["a real box", "a real box holding undefined"],
  );

  // And the real invariant: `isUntrusted` answers exactly what the door
  // answers — since the provenance marker, "could this be unwrapped?" and
  // "was this branded?" are one question. The two must not drift apart, or a
  // caller could gate on one and be surprised by the other.
  for (const [label, value] of candidates) {
    assert.equal(isUntrusted(value), doorOpens(value), label);
  }
});

test("the box is inert under stringification — except JSON.stringify", () => {
  const wrapped = untrusted(PAYLOAD);

  // None of these three is a compiler error; the type-checked ESLint rules
  // refuse them inside `packages/*/src/**/*.ts`, and outside that glob nothing
  // does. What keeps them harmless is that the box carries no `toString`.
  assert.equal(`${wrapped}`, "[object Object]");
  assert.equal("prefix: " + wrapped, "prefix: [object Object]");
  assert.equal(String(wrapped), "[object Object]");

  // The exception, asserted positively because an absent leak and an
  // unexercised probe look identical from a passing test: `JSON.stringify`
  // walks the box and emits the hostile body in the clear. It accepts
  // `unknown`, so no type can refuse it — serialising a structure that still
  // holds branded values is an unwrap nobody wrote down. The provenance
  // marker does not change this — it is the written concession recorded in
  // src/untrusted.ts (delegated decision 2026-09-23).
  assert.equal(
    JSON.stringify({ body: wrapped }),
    `{"body":{"value":${JSON.stringify(PAYLOAD)}}}`,
  );
});
