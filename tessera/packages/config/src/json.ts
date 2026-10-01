// Narrowing helpers for values that came out of `JSON.parse`.
//
// `Array.isArray` narrows `unknown` to `any[]`, which quietly disables type
// checking for the whole walk downstream of it. These guards keep a parsed
// document typed as `unknown` all the way down, which is what it is.

export function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !isJsonArray(value);
}

/** How a rejected JSON value is named in an error message. */
export function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (isJsonArray(value)) return "an array";
  if (isJsonRecord(value)) return "an object";
  return `a ${typeof value}`;
}
