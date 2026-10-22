/**
 * Shared script-body scanner for the pattern-based certification checks
 * (`hardcoded-identifiers`, `client-script-safety`, …). It reads the script
 * fields of in-scope artifacts through the Table API — the same egress
 * `script-hygiene` and `script-field-exposure` already perform — and tests a
 * list of line regexes against every non-comment line.
 *
 * Output policy: a {@link ScanHit} carries the artifact, the field, the line
 * number and the pattern id — **never the matched text**. Callers must keep it
 * that way in their messages.
 */

import type { PreflightContext } from "../types.js";
import { and, eq } from "../http/query.js";
import { str, triageZeroRead } from "./cert-common.js";

/** One table whose script fields are scanned. */
export interface ScriptSource {
  table: string;
  /** Column used to label an artifact in messages (falls back to the sys_id). */
  nameField: string;
  scriptFields: readonly string[];
  /** Extra pre-built encoded-query clause ANDed onto the scope + active filter. */
  extraQuery?: string;
}

/** A line pattern. The regex must not use the `g` flag; it is tested per line. */
export interface ScanPattern {
  id: string;
  regex: RegExp;
}

/** One pattern match: where it is, never what it matched. */
export interface ScanHit {
  table: string;
  sysId: string;
  name: string;
  field: string;
  /** 1-based line number inside the field. */
  line: number;
  patternId: string;
}

/** What one {@link scanScripts} call saw. */
export interface ScanResult {
  /** At most {@link MAX_SCAN_HITS} hits, in read order. */
  hits: ScanHit[];
  /** Artifacts (rows) scanned across every source. */
  scanned: number;
  /** Sources whose read was security-trimmed — the caller fails closed. */
  trimmed: string[];
  /** Sources with a zero-row read and no pre-trim count (none vs. no access). */
  ambiguous: string[];
  /** Hits found beyond the cap and not kept in `hits`. */
  dropped: number;
  /** Distinct artifacts (`table:sys_id`) with at least one hit, cap ignored. */
  artifacts: string[];
}

/** Hits kept per scan; the rest are only counted (`dropped`). */
export const MAX_SCAN_HITS = 500;

/**
 * The code text of every line of `script`, with comments blanked out — line
 * `i` of the result is line `i + 1` of the source (so line numbers survive).
 * A small state machine: `//` comments end at the newline, block comments may
 * span lines, and comment markers inside '…', "…" or `…` literals are text, not
 * comments (so `"https://…"` is never mistaken for a comment). Quote strings
 * end at a newline even when unterminated; template literals may span lines.
 * A backslash outside a string escapes the next character, which keeps regex
 * literals like `/\/\//` from opening a comment. Regex literals are not
 * otherwise recognised — the scanner is a heuristic, not a parser.
 */
export function codeLines(script: string): string[] {
  const lines: string[] = [];
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  let current = "";
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    const next = script[i + 1];
    if (ch === "\n") {
      lines.push(current.replace(/\r$/, ""));
      current = "";
      if (state === "line" || state === "'" || state === '"') state = "code";
      continue;
    }
    switch (state) {
      case "line":
        break;
      case "block":
        if (ch === "*" && next === "/") {
          state = "code";
          i++;
        }
        break;
      case "'":
      case '"':
      case "`":
        current += ch;
        if (ch === "\\" && next !== undefined && next !== "\n") {
          current += next;
          i++;
        } else if (ch === state) {
          state = "code";
        }
        break;
      default:
        if (ch === "/" && next === "/") {
          state = "line";
          i++;
        } else if (ch === "/" && next === "*") {
          state = "block";
          i++;
          current += " ";
        } else {
          current += ch;
          if (ch === "\\" && next !== undefined && next !== "\n") {
            current += next;
            i++;
          } else if (ch === "'" || ch === '"' || ch === "`") {
            state = ch;
          }
        }
    }
  }
  lines.push(current.replace(/\r$/, ""));
  return lines;
}

/** A script field's raw text — NOT trimmed, so line numbers stay exact. */
function rawScript(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return typeof value === "string" ? value : str(row, field);
}

/**
 * Scan the script fields of every active, in-scope row of each source.
 * `scopeClause` is the resolved scope filter (`resolveScope(...).clause`).
 * No `sysparm_limit`: the client auto-paginates, so every row is seen.
 */
export async function scanScripts(
  ctx: PreflightContext,
  scopeClause: string,
  sources: readonly ScriptSource[],
  patterns: readonly ScanPattern[],
): Promise<ScanResult> {
  const out: ScanResult = {
    hits: [],
    scanned: 0,
    trimmed: [],
    ambiguous: [],
    dropped: 0,
    artifacts: [],
  };
  const artifacts = new Set<string>();
  for (const source of sources) {
    const meta = await ctx.http.table(source.table).queryWithMeta({
      sysparm_query: and(
        scopeClause,
        eq("active", "true"),
        source.extraQuery ?? "",
      ),
      sysparm_fields: ["sys_id", source.nameField, ...source.scriptFields].join(
        ",",
      ),
    });
    const label = `${source.table}.${source.scriptFields.join("/")}`;
    if (meta.securityTrimmed) out.trimmed.push(label);
    else if (meta.rows.length === 0 && triageZeroRead(meta) === "ambiguous") {
      out.ambiguous.push(label);
    }
    for (const row of meta.rows) {
      out.scanned++;
      const sysId = str(row, "sys_id");
      const name = str(row, source.nameField) || sysId || "(unnamed)";
      for (const field of source.scriptFields) {
        const script = rawScript(row, field);
        if (script.trim() === "") continue;
        codeLines(script).forEach((text, index) => {
          for (const pattern of patterns) {
            pattern.regex.lastIndex = 0; // harmless guard against a stray g/y flag
            if (!pattern.regex.test(text)) continue;
            artifacts.add(`${source.table}:${sysId || name}`);
            if (out.hits.length >= MAX_SCAN_HITS) {
              out.dropped++;
              continue;
            }
            out.hits.push({
              table: source.table,
              sysId,
              name,
              field,
              line: index + 1,
              patternId: pattern.id,
            });
          }
        });
      }
    }
  }
  out.artifacts = [...artifacts];
  return out;
}

/**
 * `name (field:line, pattern), …` for the hits, with an `… and N more` suffix
 * when `dropped` is positive. Never includes matched text.
 */
export function describeHits(hits: readonly ScanHit[], dropped = 0): string {
  const list = hits
    .map((h) => `${h.name} (${h.field}:${h.line}, ${h.patternId})`)
    .join(", ");
  return dropped > 0 ? `${list}, … and ${dropped} more` : list;
}

/*
 * Standard script sources (ADD-5-0 source table). Field names are the
 * out-of-box dictionary names; `sys_ui_action.client_script` and the
 * `sys_transform_script` label column are unverified against a live instance.
 */

const BUSINESS_RULES: ScriptSource = {
  table: "sys_script",
  nameField: "name",
  scriptFields: ["script"],
};
const SCRIPT_INCLUDES: ScriptSource = {
  table: "sys_script_include",
  nameField: "name",
  scriptFields: ["script"],
};
const SCHEDULED_SCRIPTS: ScriptSource = {
  table: "sysauto_script",
  nameField: "name",
  scriptFields: ["script"],
};
const REST_OPERATIONS: ScriptSource = {
  table: "sys_ws_operation",
  nameField: "name",
  scriptFields: ["operation_script"],
};
const TRANSFORM_MAPS: ScriptSource = {
  table: "sys_transform_map",
  nameField: "name",
  scriptFields: ["script"],
};
// A transform script has no name of its own; label it by its map reference.
const TRANSFORM_SCRIPTS: ScriptSource = {
  table: "sys_transform_script",
  nameField: "map",
  scriptFields: ["script"],
};
const CLIENT_SCRIPTS: ScriptSource = {
  table: "sys_script_client",
  nameField: "name",
  scriptFields: ["script"],
};
const UI_SCRIPTS: ScriptSource = {
  table: "sys_ui_script",
  nameField: "name",
  scriptFields: ["script"],
};
const UI_POLICIES: ScriptSource = {
  table: "sys_ui_policy",
  nameField: "short_description",
  scriptFields: ["script_true", "script_false"],
};

/** Sources whose script fields run on the server. */
export const SERVER_SCRIPT_SOURCES: readonly ScriptSource[] = [
  BUSINESS_RULES,
  SCRIPT_INCLUDES,
  { table: "sys_ui_action", nameField: "name", scriptFields: ["script"] },
  SCHEDULED_SCRIPTS,
  REST_OPERATIONS,
  TRANSFORM_MAPS,
  TRANSFORM_SCRIPTS,
];

/** Sources whose script fields run in the browser. */
export const CLIENT_SCRIPT_SOURCES: readonly ScriptSource[] = [
  CLIENT_SCRIPTS,
  UI_SCRIPTS,
  UI_POLICIES,
  {
    table: "sys_ui_action",
    nameField: "name",
    scriptFields: ["client_script"],
  },
];

/** Every source, server and client, reading each table once. */
export const ALL_SCRIPT_SOURCES: readonly ScriptSource[] = [
  BUSINESS_RULES,
  SCRIPT_INCLUDES,
  {
    table: "sys_ui_action",
    nameField: "name",
    scriptFields: ["script", "client_script"],
  },
  SCHEDULED_SCRIPTS,
  REST_OPERATIONS,
  TRANSFORM_MAPS,
  TRANSFORM_SCRIPTS,
  CLIENT_SCRIPTS,
  UI_SCRIPTS,
  UI_POLICIES,
];

/** The distinct table names of `sources`, in order (for `CheckMeta.tables`). */
export function sourceTables(sources: readonly ScriptSource[]): string[] {
  return [...new Set(sources.map((s) => s.table))];
}
