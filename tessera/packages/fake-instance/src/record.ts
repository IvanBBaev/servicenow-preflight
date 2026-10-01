// QA-18 — the fake's record shape.
//
// The Table API returns **every** field as a string when
// `sysparm_display_value=false` (what `@tessera/sn-client`'s `api/table.ts`
// always sends). Storing coerced strings therefore matches the real wire shape
// AND makes the query engine total: no operator has to reason about mixed
// types. The coercion is applied on write, so a caller that POSTs
// `{ active: true }` reads back `{ active: "true" }` — exactly as a real
// instance behaves.

/** Field map as it arrives from a caller (JSON body / seed fixture). */
export type SnRecord = Record<string, unknown>;

/** Field map as the fake stores and returns it: all values are strings. */
export type StoredRecord = Record<string, string>;

/**
 * Fields the fake stamps on every stored row. All four are store-maintained
 * and read-only to a caller: an update body carrying any of them has that key
 * dropped before the merge, as on a real instance (`sys_id` is immutable once
 * set, and the three audit stamps are owned by the platform). `tables.update`
 * enforces this list — it is not documentation alone.
 */
export const RESERVED_FIELDS = [
  "sys_id",
  "sys_created_on",
  "sys_updated_on",
  "sys_mod_count",
] as const;

/**
 * Coerce one field value to its Table-API string form. Objects and arrays are
 * JSON-encoded rather than dropped: a reference field posted as an object is a
 * caller mistake we want to keep visible in the state, not silently lose.
 */
export function coerceField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    // A cycle, a nested bigint, a throwing `toJSON`.
    encoded = undefined;
  }
  // `JSON.stringify` also answers `undefined` for a function or a symbol.
  // Returning "" for any of these would make an unencodable-but-present value
  // indistinguishable from null, undefined and a genuinely empty field — a
  // fault reported as data, and the opposite of what the note above promises.
  return encoded ?? unencodableForm(value);
}

/**
 * Last-resort *visible* rendering of a value `JSON.stringify` will not encode.
 * Never "" — the whole point is that the caller's mistake stays observable in
 * the stored state.
 */
function unencodableForm(value: unknown): string {
  let text: string;
  try {
    text = String(value);
  } catch {
    // A null-prototype object has no `toString` either.
    text = "";
  }
  return text === "" ? "[unencodable value]" : text;
}

/**
 * Set `key` as an OWN data property, even when `key` is `"__proto__"`: a plain
 * assignment there calls the inherited `__proto__` setter instead, which
 * either swaps the object's prototype or — for a string value — silently does
 * nothing. The object keeps `Object.prototype`, so strict `deepEqual` against
 * a plain literal still holds.
 */
export function setOwn<T>(
  target: Record<string, T>,
  key: string,
  value: T,
): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/** Coerce a whole field map. */
export function coerceRecord(fields: SnRecord): StoredRecord {
  const out: StoredRecord = {};
  for (const [key, value] of Object.entries(fields)) {
    // Delegated decision 2026-09-26: an own `__proto__` key (what JSON.parse
    // yields for a body carrying one) is stored as an ordinary field rather
    // than silently dropped by the prototype setter.
    setOwn(out, key, coerceField(value));
  }
  return out;
}

/** Project a record onto `sysparm_fields`; an empty list returns everything. */
export function projectFields(
  record: StoredRecord,
  fields: readonly string[] | undefined,
): StoredRecord {
  if (!fields || fields.length === 0) return { ...record };
  const out: StoredRecord = {};
  for (const field of fields) {
    // A real instance omits a field it does not know rather than erroring.
    // Delegated decision 2026-09-26: `Object.hasOwn`, not `in` — `in` also
    // sees `constructor` / `toString` on Object.prototype and projected them.
    if (Object.hasOwn(record, field)) setOwn(out, field, record[field] ?? "");
  }
  return out;
}
