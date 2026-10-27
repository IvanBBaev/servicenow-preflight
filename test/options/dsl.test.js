import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeValue,
  formatIssue,
  joinPath,
  o,
  parse,
} from "../../build/options/dsl.js";

const messages = (schema, value) => {
  const result = parse(schema, value);
  return result.ok ? [] : result.issues.map(formatIssue);
};

test("primitives accept their type and report a mismatch with the value", () => {
  assert.deepEqual(messages(o.string(), "x"), []);
  assert.deepEqual(messages(o.string(), 42), ["expected string, got 42"]);
  assert.deepEqual(messages(o.string({ nonEmpty: true }), "  "), [
    'expected non-empty string, got "  "',
  ]);
  assert.deepEqual(messages(o.bool(), "true"), [
    'expected boolean, got "true"',
  ]);
  assert.deepEqual(messages(o.int({ min: 1, max: 5 }), 0), [
    "expected integer >= 1 and <= 5, got 0",
  ]);
  assert.deepEqual(messages(o.int(), 1.5), ["expected integer, got 1.5"]);
  assert.deepEqual(messages(o.number(), Number.NaN), [
    "expected number, got NaN",
  ]);
  assert.deepEqual(messages(o.enumOf(["a", "b"]), "c"), [
    'expected one of "a", "b", got "c"',
  ]);
  assert.deepEqual(messages(o.any(), Symbol("x")), []);
});

test("objects locate problems by dotted path and flag unknown keys", () => {
  const schema = o.object({
    apps: o.optional(o.array(o.object({ id: o.string({ nonEmpty: true }) }))),
    name: o.string(),
  });
  const result = parse(schema, { apps: [{ id: "a" }, { id: 7 }], nmae: "x" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(formatIssue), [
    "apps[1].id: expected non-empty string, got 7",
    "name: is required",
    "nmae: unknown key",
  ]);
  assert.deepEqual(result.issues[2].unknownKey, {
    key: "nmae",
    known: ["apps", "name"],
  });
});

test("unknownKeys allow and extraKeys accept undeclared keys", () => {
  const open = o.object({}, { unknownKeys: "allow" });
  assert.deepEqual(messages(open, { anything: 1 }), []);
  const extra = o.object({}, { extraKeys: ["$schema"] });
  assert.deepEqual(messages(extra, { $schema: "./x.json" }), []);
  assert.deepEqual(messages(extra, { other: 1 }), ["other: unknown key"]);
});

test("a union reports the closest member, else a summary mismatch", () => {
  const schema = o.union([o.array(o.string()), o.string()]);
  assert.deepEqual(messages(schema, ["fr", "de"]), []);
  assert.deepEqual(messages(schema, "fr"), []);
  assert.deepEqual(messages(schema, ["fr", 3]), [
    "[1]: expected string, got 3",
  ]);
  assert.deepEqual(messages(schema, 3), [
    "expected array of string or string, got 3",
  ]);
});

test("record validates every value", () => {
  const schema = o.record(o.int());
  assert.deepEqual(messages(schema, { a: 1, "b c": "x" }), [
    '["b c"]: expected integer, got "x"',
  ]);
  assert.deepEqual(messages(schema, []), ["expected object, got an array"]);
});

test("joinPath and describeValue render paths and values compactly", () => {
  assert.equal(joinPath("", "a"), "a");
  assert.equal(joinPath("checks", "scoped-app-deps"), "checks.scoped-app-deps");
  assert.equal(joinPath("a", "b c"), 'a["b c"]');
  assert.equal(joinPath("", "1x"), '["1x"]');
  assert.equal(describeValue(null), "null");
  assert.equal(describeValue(undefined), "undefined");
  assert.equal(describeValue({}), "an object");
  assert.equal(
    describeValue(() => 1),
    "a function",
  );
  assert.equal(
    describeValue("x".repeat(50)),
    JSON.stringify(`${"x".repeat(37)}...`),
  );
});

test("toJsonSchema mirrors the declaration", () => {
  const schema = o.object(
    {
      id: o.string({ nonEmpty: true, description: "The id." }),
      max: o.optional(o.int({ min: 1, default: 10 })),
      on: o.optional(o.bool({ default: false })),
      mode: o.optional(o.enumOf(["a", "b"])),
      any: o.optional(o.union([o.bool(), o.string()])),
      map: o.optional(o.record(o.number())),
    },
    { extraKeys: ["$schema"], description: "Root." },
  );
  assert.deepEqual(schema.toJsonSchema(), {
    description: "Root.",
    type: "object",
    properties: {
      id: { description: "The id.", type: "string", minLength: 1 },
      max: { type: "integer", minimum: 1, default: 10 },
      on: { type: "boolean", default: false },
      mode: { type: "string", enum: ["a", "b"] },
      any: { anyOf: [{ type: "boolean" }, { type: "string" }] },
      map: { type: "object", additionalProperties: { type: "number" } },
      $schema: {},
    },
    required: ["id"],
    additionalProperties: false,
  });
});
