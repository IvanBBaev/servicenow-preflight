// The `egress` section of `tessera.config.json` — the operator's DESIGN §10.2
// egress policy, as `tess generate --provider anthropic` reads it.
//
// Three facts shape the file.
//
//  * **It is file-only.** A nested policy has no honest one-line flag or
//    environment spelling, and a policy that lives in a committed file is one
//    a reviewer can read in a diff. `@tessera/config` routes the section out
//    raw (`ResolveInput.sections`), still secret-scanned; this file owns the
//    shape.
//
//  * **Consent is the JSON literal `true` or nothing.** Absent or `false` is a
//    well-formed policy that withholds consent — the caller refuses it with
//    the consent message. Anything else (`"true"`, `1`, `"yes"`) is a malformed
//    policy: the config layer's boolean words are deliberately NOT accepted
//    here, because the one field that authorises sending instance data off the
//    machine must not be satisfiable by coercion.
//
//  * **Every unknown key is refused, at every level, with its path.** A typo in
//    `deny` that was skipped would send exactly what the operator meant to
//    withhold. Values from the file are not echoed back: the path and the
//    expected shape are enough to fix it, and the message reaches a terminal.

import { ConfigError } from "@tessera/config";
import {
  EGRESS_FIELD_CLASSES,
  GenerateInputError,
  resolveAnthropicBaseUrl,
  validateEgressPolicy,
  type EgressFieldClass,
  type EgressPolicy,
  type EgressRuleSet,
} from "@tessera/generate";

import { EGRESS_SECTION } from "./options.js";

export { EGRESS_SECTION };

/** `@tessera/generate`'s table-name rule, restated so the error carries a path. */
const TABLE_PATTERN = /^[a-z0-9_]{1,80}$/i;

const POLICY_KEYS = ["consent", "allow", "deny", "baseUrlOverride"] as const;
const RULE_KEYS = ["tables", "fields"] as const;

export interface EgressConfig {
  /** Validated by `validateEgressPolicy`; `consent` may still be `false`. */
  readonly policy: EgressPolicy;
  /**
   * The one non-default Anthropic origin this operator allows (AIS-5),
   * normalised to `scheme://host[:port]`. Absent: the base URL stays pinned.
   */
  readonly baseUrlOverride?: string;
}

/** An example section, for the messages that tell an operator to add one. */
export const EGRESS_EXAMPLE = `"egress": { "consent": true, "allow": { "tables": ["sys_script_include"], "fields": ["relation", "plan"] } }`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(file: string, keyPath: string, problem: string): ConfigError {
  return new ConfigError(
    `invalid egress policy in ${file}: \`${keyPath}\` ${problem}`,
  );
}

function refuseUnknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  file: string,
  keyPath: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      // The key itself is the operator's own text and may carry anything, so
      // it is described by position rather than quoted.
      throw invalid(
        file,
        keyPath,
        `has a key that is not part of the schema (known: ${known.join(", ")})`,
      );
    }
  }
}

function tablesAt(
  value: unknown,
  file: string,
  keyPath: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw invalid(file, keyPath, "must be a list of table names");
  }
  return value.map((entry: unknown, index) => {
    if (typeof entry !== "string" || !TABLE_PATTERN.test(entry.trim())) {
      throw invalid(
        file,
        `${keyPath}[${index}]`,
        "is not a table name ([a-z0-9_], at most 80 characters)",
      );
    }
    return entry.trim();
  });
}

function fieldsAt(
  value: unknown,
  file: string,
  keyPath: string,
): readonly EgressFieldClass[] {
  if (!Array.isArray(value)) {
    throw invalid(file, keyPath, "must be a list of field classes");
  }
  return value.map((entry: unknown, index) => {
    const known = EGRESS_FIELD_CLASSES.find((field) => field === entry);
    if (known === undefined) {
      throw invalid(
        file,
        `${keyPath}[${index}]`,
        `is not a field class (known: ${EGRESS_FIELD_CLASSES.join(", ")})`,
      );
    }
    return known;
  });
}

function rulesAt(value: unknown, file: string, keyPath: string): EgressRuleSet {
  if (!isPlainObject(value)) {
    throw invalid(file, keyPath, "must be an object of { tables, fields }");
  }
  refuseUnknownKeys(value, RULE_KEYS, file, keyPath);
  return {
    ...(value.tables === undefined
      ? {}
      : { tables: tablesAt(value.tables, file, `${keyPath}.tables`) }),
    ...(value.fields === undefined
      ? {}
      : { fields: fieldsAt(value.fields, file, `${keyPath}.fields`) }),
  };
}

/**
 * Parse and validate the raw `egress` section.
 *
 * @param raw  the section exactly as the config file carried it.
 * @param file the config file's path, for the messages.
 * @throws ConfigError on any shape the schema does not describe.
 */
export function parseEgressConfig(raw: unknown, file: string): EgressConfig {
  if (!isPlainObject(raw)) {
    throw invalid(file, EGRESS_SECTION, "must be an object");
  }
  refuseUnknownKeys(raw, POLICY_KEYS, file, EGRESS_SECTION);

  const consent = raw.consent;
  if (consent !== undefined && typeof consent !== "boolean") {
    throw invalid(
      file,
      `${EGRESS_SECTION}.consent`,
      "must be the JSON boolean true (or false); a string or a number is not consent",
    );
  }

  if (raw.allow === undefined) {
    throw invalid(
      file,
      `${EGRESS_SECTION}.allow`,
      "is required — name the tables (and field classes) that may leave the machine; there is no implicit allow list",
    );
  }
  const allow = rulesAt(raw.allow, file, `${EGRESS_SECTION}.allow`);
  const deny =
    raw.deny === undefined
      ? undefined
      : rulesAt(raw.deny, file, `${EGRESS_SECTION}.deny`);

  let baseUrlOverride: string | undefined;
  if (raw.baseUrlOverride !== undefined) {
    const keyPath = `${EGRESS_SECTION}.baseUrlOverride`;
    if (typeof raw.baseUrlOverride !== "string") {
      throw invalid(file, keyPath, "must be an https origin string");
    }
    try {
      baseUrlOverride = resolveAnthropicBaseUrl(raw.baseUrlOverride, true);
    } catch (error) {
      if (error instanceof GenerateInputError) {
        throw invalid(file, keyPath, `is refused: ${error.message}`);
      }
      throw error;
    }
  }

  const policy: EgressPolicy = {
    consent: consent === true,
    allow,
    ...(deny === undefined ? {} : { deny }),
  };
  // The library's own check, as a backstop: the shape above is meant to be
  // exactly what it accepts, and a disagreement must refuse rather than pass.
  try {
    validateEgressPolicy(policy);
  } catch (error) {
    if (error instanceof GenerateInputError) {
      throw new ConfigError(
        `invalid egress policy in ${file}: ${error.message}`,
      );
    }
    throw error;
  }

  return {
    policy,
    ...(baseUrlOverride === undefined ? {} : { baseUrlOverride }),
  };
}
