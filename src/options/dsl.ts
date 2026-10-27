/**
 * A tiny schema DSL for check options and the config file (F-X-7). One
 * declaration yields both a validator (`parse`, with dotted-path messages such
 * as `checks.scoped-app-deps.requiredApps[0].id: expected non-empty string, got 42`)
 * and a JSON Schema (draft 2020-12) fragment, so the docs, the editor schema and
 * `snpf config validate` can never disagree. Dependency-free on purpose.
 */

/** One validation problem, located by a dotted path. */
export interface Issue {
  /** `a.b`, `a[0].c`; empty for the root value. */
  path: string;
  message: string;
  /** Set when the problem is a key the schema does not declare. */
  unknownKey?: { key: string; known: string[] };
}

/** A JSON Schema fragment. */
export type JsonSchema = Record<string, unknown>;

/** A declared value shape. */
export interface Schema<T = unknown> {
  readonly kind: string;
  /** Absent values are accepted (only meaningful inside an object). */
  readonly optional: boolean;
  /** Human label used in `expected …` messages. */
  readonly expected: string;
  /** Free-text description, carried into the JSON Schema. */
  readonly description?: string;
  /** Validate `value`, pushing problems onto `issues`. */
  check(value: unknown, path: string, issues: Issue[]): void;
  toJsonSchema(): JsonSchema;
  /** Phantom marker for the parsed type. */
  readonly __type?: T;
}

/** The shape map of an object schema. */
export type Shape = Record<string, Schema>;

/** An object schema; `shape` is exposed so callers can list its keys. */
export interface ObjectSchema extends Schema<Record<string, unknown>> {
  readonly kind: "object";
  readonly shape: Shape;
}

/** Validation outcome of {@link parse}. */
export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; issues: Issue[] };

/** Validate `value` against `schema`. The value is returned unchanged. */
export function parse<T>(
  schema: Schema<T>,
  value: unknown,
  path = "",
): ParseResult<T> {
  const issues: Issue[] = [];
  schema.check(value, path, issues);
  return issues.length === 0
    ? { ok: true, value: value as T }
    : { ok: false, issues };
}

/** Render an issue as `path: message` (just the message at the root). */
export function formatIssue(issue: Issue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

/** A short rendering of a received value for `got …`. */
export function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") {
    const text = value.length > 40 ? `${value.slice(0, 37)}...` : value;
    return JSON.stringify(text);
  }
  if (typeof value === "object") return "an object";
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return `a ${typeof value}`;
}

/** Append a key to a path, bracket-quoting keys that are not identifiers. */
export function joinPath(path: string, key: string): string {
  const part = /^[A-Za-z_$][\w$-]*$/.test(key) ? key : JSON.stringify(key);
  if (!path) return /^[A-Za-z_$]/.test(part) ? part : `[${part}]`;
  return part.startsWith('"') ? `${path}[${part}]` : `${path}.${part}`;
}

function mismatch(
  issues: Issue[],
  path: string,
  expected: string,
  value: unknown,
): void {
  issues.push({
    path,
    message: `expected ${expected}, got ${describeValue(value)}`,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Common {
  description?: string;
}

function withDescription(schema: JsonSchema, description?: string): JsonSchema {
  return description ? { description, ...schema } : schema;
}

function make<T>(
  kind: string,
  expected: string,
  check: Schema<T>["check"],
  json: () => JsonSchema,
  description?: string,
): Schema<T> {
  return {
    kind,
    optional: false,
    expected,
    description,
    check,
    toJsonSchema: () => withDescription(json(), description),
  };
}

function string(opts: Common & { nonEmpty?: boolean } = {}): Schema<string> {
  const expected = opts.nonEmpty ? "non-empty string" : "string";
  return make<string>(
    "string",
    expected,
    (value, path, issues) => {
      if (typeof value !== "string" || (opts.nonEmpty && value.trim() === "")) {
        mismatch(issues, path, expected, value);
      }
    },
    () =>
      opts.nonEmpty ? { type: "string", minLength: 1 } : { type: "string" },
    opts.description,
  );
}

function numeric(
  integer: boolean,
  opts: Common & { min?: number; max?: number; default?: number },
): Schema<number> {
  const base = integer ? "integer" : "number";
  const bounds = [
    opts.min !== undefined ? `>= ${opts.min}` : "",
    opts.max !== undefined ? `<= ${opts.max}` : "",
  ].filter(Boolean);
  const expected = bounds.length ? `${base} ${bounds.join(" and ")}` : base;
  return make<number>(
    base,
    expected,
    (value, path, issues) => {
      const ok =
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!integer || Number.isInteger(value)) &&
        (opts.min === undefined || value >= opts.min) &&
        (opts.max === undefined || value <= opts.max);
      if (!ok) mismatch(issues, path, expected, value);
    },
    () => ({
      type: base,
      ...(opts.min !== undefined ? { minimum: opts.min } : {}),
      ...(opts.max !== undefined ? { maximum: opts.max } : {}),
      ...(opts.default !== undefined ? { default: opts.default } : {}),
    }),
    opts.description,
  );
}

function bool(opts: Common & { default?: boolean } = {}): Schema<boolean> {
  return make<boolean>(
    "boolean",
    "boolean",
    (value, path, issues) => {
      if (typeof value !== "boolean") mismatch(issues, path, "boolean", value);
    },
    () => ({
      type: "boolean",
      ...(opts.default !== undefined ? { default: opts.default } : {}),
    }),
    opts.description,
  );
}

function enumOf<const V extends string>(
  values: readonly V[],
  opts: Common = {},
): Schema<V> {
  const expected = `one of ${values.map((v) => JSON.stringify(v)).join(", ")}`;
  return make<V>(
    "enum",
    expected,
    (value, path, issues) => {
      if (typeof value !== "string" || !values.includes(value as V)) {
        mismatch(issues, path, expected, value);
      }
    },
    () => ({ type: "string", enum: [...values] }),
    opts.description,
  );
}

function array<T>(item: Schema<T>, opts: Common = {}): Schema<T[]> {
  const expected = `array of ${item.expected}`;
  return make<T[]>(
    "array",
    expected,
    (value, path, issues) => {
      if (!Array.isArray(value)) {
        mismatch(issues, path, expected, value);
        return;
      }
      value.forEach((entry, i) => item.check(entry, `${path}[${i}]`, issues));
    },
    () => ({ type: "array", items: item.toJsonSchema() }),
    opts.description,
  );
}

function object(
  shape: Shape,
  opts: Common & {
    /** `"report"` (default) flags undeclared keys; `"allow"` accepts them. */
    unknownKeys?: "report" | "allow";
    /** Keys accepted (any value) but not documented, e.g. `$schema`. */
    extraKeys?: readonly string[];
  } = {},
): ObjectSchema {
  const known = Object.keys(shape);
  const extra = new Set(opts.extraKeys ?? []);
  const report = (opts.unknownKeys ?? "report") === "report";
  return {
    kind: "object",
    optional: false,
    expected: "object",
    description: opts.description,
    shape,
    check(value, path, issues) {
      if (!isPlainObject(value)) {
        mismatch(issues, path, "object", value);
        return;
      }
      for (const [key, field] of Object.entries(shape)) {
        if (value[key] === undefined) {
          if (!field.optional) {
            issues.push({ path: joinPath(path, key), message: "is required" });
          }
          continue;
        }
        field.check(value[key], joinPath(path, key), issues);
      }
      if (!report) return;
      for (const key of Object.keys(value)) {
        if (key in shape || extra.has(key)) continue;
        issues.push({
          path: joinPath(path, key),
          message: "unknown key",
          unknownKey: { key, known },
        });
      }
    },
    toJsonSchema() {
      const properties: Record<string, JsonSchema> = {};
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = field.toJsonSchema();
      }
      for (const key of extra) properties[key] ??= {};
      const required = known.filter((k) => !shape[k]!.optional);
      return withDescription(
        {
          type: "object",
          properties,
          ...(required.length ? { required } : {}),
          additionalProperties: !report,
        },
        opts.description,
      );
    },
  };
}

function record<T>(
  value: Schema<T>,
  opts: Common = {},
): Schema<Record<string, T>> {
  return make<Record<string, T>>(
    "record",
    "object",
    (raw, path, issues) => {
      if (!isPlainObject(raw)) {
        mismatch(issues, path, "object", raw);
        return;
      }
      for (const [key, entry] of Object.entries(raw)) {
        value.check(entry, joinPath(path, key), issues);
      }
    },
    () => ({ type: "object", additionalProperties: value.toJsonSchema() }),
    opts.description,
  );
}

function union(members: readonly Schema[], opts: Common = {}): Schema {
  const expected = members.map((m) => m.expected).join(" or ");
  return make<unknown>(
    "union",
    expected,
    (value, path, issues) => {
      // Report the closest member when exactly one matches the value's base
      // type (e.g. an array of the wrong items); else a summary mismatch.
      let best: Issue[] | undefined;
      for (const member of members) {
        const own: Issue[] = [];
        member.check(value, path, own);
        if (own.length === 0) return;
        if (own.some((i) => i.path !== path)) best ??= own;
      }
      if (best) issues.push(...best);
      else mismatch(issues, path, expected, value);
    },
    () => ({ anyOf: members.map((m) => m.toJsonSchema()) }),
    opts.description,
  );
}

function optional<T>(schema: Schema<T>): Schema<T | undefined> {
  return { ...schema, optional: true };
}

function any(opts: Common = {}): Schema<unknown> {
  return make<unknown>(
    "any",
    "any value",
    () => undefined,
    () => ({}),
    opts.description,
  );
}

/** The DSL entry point: `o.object({ maxRows: o.optional(o.int({ min: 1 })) })`. */
export const o = {
  string,
  int: (opts: Common & { min?: number; max?: number; default?: number } = {}) =>
    numeric(true, opts),
  number: (
    opts: Common & { min?: number; max?: number; default?: number } = {},
  ) => numeric(false, opts),
  bool,
  enumOf,
  array,
  object,
  record,
  union,
  optional,
  any,
};
