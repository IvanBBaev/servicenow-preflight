// Rendering the resolved config (PLAN Phase 1 §Configuration: "resolved once at
// startup and logged redacted").
//
// The startup log is the operator's only window into precedence. Most support
// questions in a four-layer config system are not "what is the value" but "why
// is it that value", so every line carries the layer that won, and the ARCH-29
// alias fan-out is spelled out rather than left to look like three coincidences.
//
// Redaction is by DESCRIPTOR first and by value shape second. Descriptor-first
// matters: a secret is secret because the table says so, and a value that fails
// the narrow shape test (see secrets.ts) must still be redacted when its
// descriptor is marked. The reverse case — an unmarked option that was handed a
// PEM block — is caught by the value pass, which is why the second pass exists
// at all.
//
// A redacted value renders as fixed text. Never a length, never a prefix, never
// a masked tail: "sk-…7fA (12 chars)" tells an attacker reading a shared CI log
// which credential this is and how much of it to brute-force, and tells the
// operator nothing they could not get from the layer name.

import { REDACTED, hasUrlUserinfo, secretValueShape } from "./secrets.js";
import type { ConfigValues, OptionSpec, ResolvedConfig } from "./types.js";

/**
 * One `key = value (from <layer>)` line per resolved option, in table order.
 *
 * Options that resolved to nothing are omitted: an absent optional value has no
 * layer to report, and printing `story = (unset)` for every unused resolver
 * input would bury the lines that matter.
 */
export function formatResolvedConfig(
  resolved: ResolvedConfig<ConfigValues>,
): string {
  const lines: string[] = [];
  lines.push(
    resolved.configFile === undefined
      ? "config file: none (no tessera.config.json found)"
      : `config file: ${resolved.configFile}`,
  );

  for (const spec of resolved.options) {
    const value = resolved.values[spec.key];
    if (value === undefined) continue;
    const source = resolved.provenance[spec.key] ?? "default";
    const alias = resolved.aliasedFrom[spec.key];
    const via = alias === undefined ? "" : ` via --${kebab(alias)}`;
    lines.push(
      `${spec.key} = ${renderValue(spec, value)} (from ${source}${via})`,
    );
  }
  return lines.join("\n");
}

/**
 * `--flag  describe` help, derived from the same table the resolver reads.
 *
 * Help text that is written by hand drifts from the parser, and the drift is
 * invisible until an operator follows the help and gets "unknown flag". Here
 * the two cannot disagree.
 */
export function formatOptionsHelp(options: readonly OptionSpec[]): string {
  const width = options.reduce(
    (widest, option) => Math.max(widest, invocation(option).length),
    0,
  );
  return options
    .map(
      (option) => `  ${invocation(option).padEnd(width)}  ${option.describe}`,
    )
    .join("\n");
}

function invocation(spec: OptionSpec): string {
  if (spec.type === "boolean") return spec.flag;
  return `${spec.flag} <${spec.type === "list" ? "value,…" : spec.type}>`;
}

function renderValue(spec: OptionSpec, value: unknown): string {
  if (spec.secret === true) return REDACTED;
  if (typeof value === "string") {
    // Delegated decision 2026-09-26 (review W5b, A): also redact any value
    // with an `@` before its host (`hasUrlUserinfo`). Not every logged value
    // was refused first: the env layer is not shape-checked for non-topology
    // options, and a bare `user@` is allowed off the topology keys, so the log
    // is the last line of defence. The cost is that an e-mail-like value on
    // this display channel reads `<redacted>`; the resolved value is untouched.
    return secretValueShape(value) === undefined && !hasUrlUserinfo(value)
      ? value
      : REDACTED;
  }
  if (Array.isArray(value)) {
    return (value as readonly unknown[])
      .map((item) => renderValue(spec, item))
      .join(",");
  }
  return String(value);
}

function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
