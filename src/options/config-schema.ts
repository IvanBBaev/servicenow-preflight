/**
 * The config-file schema (F-X-7), built from the check registry: one closed
 * entry under `checks` per check that declares an `optionsSchema`, and the
 * union of every declared key under the shared `options`. It backs
 * `snpf config schema`, `snpf config validate` and the run-time unknown-key
 * warnings, and is emitted as `schemas/preflight.config.v1.json`.
 */
import { closestNames } from "../catalogue.js";
import type { Check } from "../types.js";
import { formatIssue, o, parse } from "./dsl.js";
import type { Issue, JsonSchema, ObjectSchema, Schema, Shape } from "./dsl.js";

/** Where the published config schema lives (the `$id`). */
export const CONFIG_SCHEMA_ID =
  "https://ivanbbaev.github.io/servicenow-preflight/schemas/preflight.config.v1.json";

/** The union of every option key the given checks declare (first one wins). */
export function declaredOptions(checks: readonly Check[]): Shape {
  const shape: Shape = {};
  for (const check of checks) {
    for (const [key, field] of Object.entries(
      check.optionsSchema?.shape ?? {},
    )) {
      shape[key] ??= o.optional(field);
    }
  }
  return shape;
}

/** The root config-file schema for a check set. */
export function buildConfigSchema(checks: readonly Check[]): ObjectSchema {
  const perCheck: Shape = {};
  const severity: Shape = {};
  for (const check of checks) {
    perCheck[check.name] = o.optional(
      check.optionsSchema
        ? withDescription(check.optionsSchema, check.description)
        : o.record(o.any(), { description: check.description }),
    );
    severity[check.name] = o.optional(o.enumOf(["fail", "warn", "off"]));
  }
  const nameList = o.array(o.string());
  return o.object(
    {
      instanceUrl: o.optional(
        o.string({ description: "Base URL of the target instance." }),
      ),
      scope: o.optional(
        o.string({ description: "Target scope name or scoped-app sys_id." }),
      ),
      updateSetId: o.optional(
        o.string({ description: "Target update set sys_id." }),
      ),
      select: o.optional(
        o.object(
          {
            only: o.optional(nameList),
            skip: o.optional(nameList),
          },
          { description: "Run only these checks, or all except these." },
        ),
      ),
      checks: o.optional(
        o.object(perCheck, {
          description:
            "Per-check options, shallow-merged over `options` for that check only.",
        }),
      ),
      options: o.optional(
        o.object(declaredOptions(checks), {
          description: "Options forwarded to every check.",
        }),
      ),
      proxy: o.optional(
        o.string({ description: "Outbound HTTP(S) proxy URL." }),
      ),
      noProxy: o.optional(
        o.string({
          description: "Comma-separated NO_PROXY-style bypass entries.",
        }),
      ),
      baseline: o.optional(
        o.union([o.bool(), o.string({ nonEmpty: true })], {
          description:
            "Accepted-findings file: true for the default path, or a path.",
        }),
      ),
      severity: o.optional(
        o.object(severity, {
          description: "Per-check fail / warn / off overrides.",
        }),
      ),
      failOn: o.optional(
        o.enumOf(["fail", "warn"], {
          description: "Fail the run on fail rows only, or on warn rows too.",
        }),
      ),
    },
    {
      extraKeys: ["$schema"],
      description: "servicenow-preflight config file.",
    },
  );
}

function withDescription(
  schema: ObjectSchema,
  description: string,
): ObjectSchema {
  if (schema.description) return schema;
  return {
    ...schema,
    description,
    toJsonSchema: () => ({ description, ...schema.toJsonSchema() }),
  };
}

/** The config JSON Schema document (draft 2020-12) for a check set. */
export function renderConfigSchema(checks: readonly Check[]): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CONFIG_SCHEMA_ID,
    title: "servicenow-preflight config",
    ...buildConfigSchema(checks).toJsonSchema(),
  };
}

/** Validate a parsed config file; issues come back in document order. */
export function validateConfig(
  raw: unknown,
  checks: readonly Check[],
): Issue[] {
  const result = parse(buildConfigSchema(checks) as Schema, raw);
  return result.ok ? [] : result.issues;
}

/** An issue as one line, with "did you mean" hints for an unknown key. */
export function describeIssue(issue: Issue): string {
  const line = formatIssue(issue);
  if (!issue.unknownKey) return line;
  const hints = closestNames(issue.unknownKey.key, issue.unknownKey.known);
  return hints.length ? `${line} (did you mean ${hints.join(", ")}?)` : line;
}
