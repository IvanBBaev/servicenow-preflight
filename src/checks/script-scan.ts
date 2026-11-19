/**
 * Shared script-body scanner for the pattern-based certification checks
 * (`hardcoded-identifiers`, `client-script-safety`, …). It reads the script
 * fields of in-scope artifacts through the Table API — the same egress
 * `script-hygiene` and `script-field-exposure` already perform — and tests a
 * list of line regexes against every line, in the view each pattern asks for
 * (code, string literals, or raw — see {@link lexLines}).
 *
 * Output policy: a {@link ScanHit} carries the artifact, the field, the line
 * number and the pattern id — **never the matched text**. Callers must keep it
 * that way in their messages.
 */

import type {
  CheckResult,
  Finding,
  FindingLocation,
  PreflightContext,
} from "../types.js";
import { findingId, makeFinding } from "../findings.js";
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
  /**
   * The line view the regex is tested against (see {@link lexLines}):
   * `"code"` (default) blanks comments and string, template and regex bodies;
   * `"string"` keeps only string and template bodies; `"raw"` blanks only
   * comments.
   */
  view?: ScanView;
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
  /**
   * Script fields the scan could not clear, as
   * `<name> (<table>.<field>: <reason>)`: the field was not returned for the
   * row (a field-level ACL, or a column the instance does not have), or the
   * lexer hit an unterminated literal that may hide code (see
   * {@link LexedLines.unterminatedLine}). The caller degrades a clean verdict
   * to `warn`.
   */
  unverified: string[];
  /** Hits found beyond the cap and not kept in `hits`. */
  dropped: number;
  /** `dropped > 0`: `hits` is not the full list. */
  truncated: boolean;
  /** Distinct artifacts (`table:sys_id`) with at least one hit, cap ignored. */
  artifacts: string[];
}

/** Hits kept per scan; the rest are only counted (`dropped`). */
export const MAX_SCAN_HITS = 500;

/** What a {@link ScanPattern} is tested against (see {@link lexLines}). */
export type ScanView = "code" | "string" | "raw";

/** One script, split into lines, in each {@link ScanView}. */
export interface LexedLines {
  /** Comments blanked; string, template and regex bodies replaced by spaces. */
  code: string[];
  /** Only string and template literal bodies; everything else blanked. */
  strings: string[];
  /** Comments blanked; everything else as written (the pre-lexer behaviour). */
  raw: string[];
  /**
   * 1-based line where the first unterminated literal starts — a quote string
   * or regex literal cut off by a line end, or a template literal, `${…}` part
   * or block comment still open at the end of the script — or `0` when every
   * literal is closed. Text after such a literal may be code the views hide,
   * so a scan that relies on them cannot clear the script.
   */
  unterminatedLine: number;
}

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
]);

/** Keywords whose parenthesised head (`if (…)`) may be followed by a regex. */
const REGEX_AFTER_PAREN_KEYWORDS = new Set(["if", "while", "for", "with"]);

/** The JavaScript line terminators: LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR. */
function isLineTerminator(ch: string | undefined): boolean {
  return ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
}

/** How one source character shows up in each view. */
type Role = "code" | "comment" | "body" | "delim" | "regex";

function isIdentChar(ch: string): boolean {
  return /[\w$]/.test(ch) || ch.charCodeAt(0) > 127;
}

/**
 * Lex `script` once into three line views — line `i` of every view is line
 * `i + 1` of the source, and every source character keeps its column (blanked
 * text becomes spaces; a CRLF line ending is dropped like LF). Every
 * JavaScript line terminator ends a line: LF, CRLF, a lone CR, U+2028 and
 * U+2029. A heuristic lexer, not a parser:
 * - `//` comments end at the line end; block comments may span lines;
 * - '…' and "…" end at the newline when unterminated (a backslash-newline
 *   continues them); template literals may span lines, and their `${…}`
 *   parts are code (brace depth is tracked, so `}` inside a nested string or
 *   object literal does not end them);
 * - a `/` opens a regex literal when the previous significant token is a
 *   punctuator other than `)` `]`, a `}`, the `)` that closes an `if` /
 *   `while` / `for` / `with` head, one of `return typeof instanceof in of new
 *   delete void throw case do else`, or the start of the script; `[…]` classes
 *   are tracked so a `/` inside one does not close it. Otherwise — after an
 *   operand, a `)` `]` or a postfix `++` / `--` — it is a division;
 * - an unterminated literal is reported in `unterminatedLine`.
 */
export function lexLines(script: string): LexedLines {
  const out: LexedLines = {
    code: [],
    strings: [],
    raw: [],
    unterminatedLine: 0,
  };
  let code = "";
  let strings = "";
  let raw = "";
  let state: "code" | "line" | "block" | "'" | '"' | "`" | "regex" = "code";
  // Open `${…}` expressions, innermost last: the `{` depth inside each.
  const templates: number[] = [];
  // The line each enclosing template literal of an open `${…}` started on.
  const templateStarts: number[] = [];
  let inClass = false;
  // The previous significant code token, for the regex-or-division decision.
  let prev: "start" | "punct" | "close" | "word" | "literal" = "start";
  let word = "";
  let inWord = false;
  // The last character was a backslash-newline inside a quote string.
  let continued = false;
  // Open `(`, innermost last: whether it starts an `if`/`while`/`for` head.
  const parens: boolean[] = [];
  // 1-based line where the current string, template, regex or block comment
  // (or the outermost open `${…}`) started.
  let openedAt = 0;
  const line = (): number => out.code.length + 1;
  const unterminated = (at: number): void => {
    if (out.unterminatedLine === 0) out.unterminatedLine = at;
  };

  const emit = (ch: string, role: Role): void => {
    raw += role === "comment" ? " " : ch;
    code += role === "code" || role === "delim" ? ch : " ";
    strings += role === "body" ? ch : " ";
  };
  const endLine = (): void => {
    out.code.push(code);
    out.strings.push(strings);
    out.raw.push(raw);
    code = strings = raw = "";
  };

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    const next = script[i + 1];
    if (ch === "\r" && next === "\n") continue;
    if (isLineTerminator(ch)) {
      endLine();
      inWord = false;
      if (state === "line") state = "code";
      else if (continued) continued = false;
      else if (state === "'" || state === '"' || state === "regex") {
        unterminated(openedAt);
        state = "code";
        prev = "literal";
      }
      continue;
    }
    switch (state) {
      case "line":
      case "block":
        if (state === "block" && ch === "*" && next === "/") {
          emit(ch, "comment");
          emit(next, "comment");
          i++;
          state = "code";
        } else {
          emit(ch, "comment");
        }
        break;
      case "'":
      case '"':
      case "`":
        if (ch === "\\" && next !== undefined) {
          emit(ch, "body");
          // A backslash-newline continues the literal on the next line.
          if (!isLineTerminator(next)) {
            emit(next, "body");
            i++;
          } else if (state !== "`") {
            continued = true;
          }
        } else if (ch === state) {
          emit(ch, "delim");
          state = "code";
          prev = "literal";
        } else if (state === "`" && ch === "$" && next === "{") {
          emit(ch, "code");
          emit(next, "code");
          i++;
          // Remember where the template started, to report it if it never closes.
          templates.push(0);
          templateStarts.push(openedAt);
          state = "code";
          prev = "punct";
        } else {
          emit(ch, "body");
        }
        break;
      case "regex":
        if (ch === "\\" && next !== undefined && !isLineTerminator(next)) {
          emit(ch, "regex");
          emit(next, "regex");
          i++;
        } else if (ch === "/" && !inClass) {
          emit(ch, "delim");
          state = "code";
          prev = "literal";
        } else {
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          emit(ch, "regex");
        }
        break;
      default: {
        if (ch === "/" && next === "/") {
          emit(ch, "comment");
          emit(next, "comment");
          i++;
          state = "line";
          inWord = false;
          break;
        }
        if (ch === "/" && next === "*") {
          emit(ch, "comment");
          emit(next, "comment");
          i++;
          state = "block";
          openedAt = line();
          inWord = false;
          break;
        }
        if (isIdentChar(ch)) {
          word = inWord ? word + ch : ch;
          inWord = true;
          prev = "word";
          emit(ch, "code");
          break;
        }
        inWord = false;
        if (/\s/.test(ch)) {
          emit(ch, "code");
          break;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
          emit(ch, "delim");
          state = ch;
          openedAt = line();
          break;
        }
        if (ch === "/") {
          const regexAllowed =
            prev === "start" ||
            prev === "punct" ||
            (prev === "word" && REGEX_AFTER_KEYWORDS.has(word));
          if (regexAllowed) {
            emit(ch, "delim");
            state = "regex";
            openedAt = line();
            inClass = false;
            break;
          }
        }
        if ((ch === "+" || ch === "-") && next === ch) {
          // `++` / `--` right after an operand is postfix: the expression
          // stays an operand, so a following `/` is a division.
          const operand: boolean =
            prev === "close" ||
            prev === "literal" ||
            (prev === "word" && !REGEX_AFTER_KEYWORDS.has(word));
          emit(ch, "code");
          emit(next, "code");
          i++;
          prev = operand ? "close" : "punct";
          break;
        }
        if (templates.length > 0 && (ch === "{" || ch === "}")) {
          const depth = templates[templates.length - 1]!;
          if (ch === "{") templates[templates.length - 1] = depth + 1;
          else if (depth > 0) templates[templates.length - 1] = depth - 1;
          else {
            // The `}` that closes a `${…}`: back inside the template literal.
            templates.pop();
            openedAt = templateStarts.pop() ?? openedAt;
            emit(ch, "code");
            state = "`";
            break;
          }
        }
        if (ch === "(") {
          parens.push(prev === "word" && REGEX_AFTER_PAREN_KEYWORDS.has(word));
        }
        // A `)` closing an `if (…)`-style head, or a `}` closing a block, ends
        // a statement part: a `/` after it starts a regex literal.
        prev =
          ch === ")"
            ? parens.pop() === true
              ? "punct"
              : "close"
            : ch === "]"
              ? "close"
              : "punct";
        emit(ch, "code");
      }
    }
  }
  if (state !== "code" && state !== "line") unterminated(openedAt);
  else if (templates.length > 0) {
    unterminated(templateStarts[0] ?? 1);
  }
  endLine();
  return out;
}

/**
 * The text of every line of `script` with comments blanked out — the `raw`
 * view of {@link lexLines} (strings, templates and regex literals are kept as
 * written). Line `i` of the result is line `i + 1` of the source.
 */
export function codeLines(script: string): string[] {
  return lexLines(script).raw;
}

/**
 * A script field's raw text — NOT trimmed, so line numbers stay exact — or
 * `undefined` when the row does not carry the field at all (absent, as
 * opposed to blank).
 */
function rawScript(
  row: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = row[field];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : str(row, field);
}

/** `unverified` entries shown in a message; the rest are counted. */
const MAX_UNVERIFIED_SHOWN = 10;

/**
 * The ` (Not confirmed: …)` suffix for the zero-row reads without a pre-trim
 * count (`ambiguous`) and the script fields that could not be cleared
 * (`unverified`), or `""` when both are empty. A check whose scan would
 * otherwise pass returns `warn` when this is non-empty.
 */
export function blindNote(
  ambiguous: readonly string[],
  unverified: readonly string[],
): string {
  const parts: string[] = [];
  if (ambiguous.length > 0) {
    parts.push(`no rows and no pre-trim count for ${ambiguous.join(", ")}`);
  }
  if (unverified.length > 0) {
    const shown = unverified.slice(0, MAX_UNVERIFIED_SHOWN).join(", ");
    const more = unverified.length - MAX_UNVERIFIED_SHOWN;
    parts.push(
      `script not fully scanned in ${shown}${more > 0 ? `, … and ${more} more` : ""}`,
    );
  }
  return parts.length > 0 ? ` (Not confirmed: ${parts.join("; ")}.)` : "";
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
    unverified: [],
    dropped: 0,
    truncated: false,
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
        if (script === undefined) {
          out.unverified.push(
            `${name} (${source.table}.${field}: not returned)`,
          );
          continue;
        }
        if (script.trim() === "") continue;
        const lexed = lexLines(script);
        if (lexed.unterminatedLine > 0) {
          out.unverified.push(
            `${name} (${source.table}.${field}:${lexed.unterminatedLine}: unterminated literal)`,
          );
        }
        const views: Record<ScanView, string[]> = {
          code: lexed.code,
          string: lexed.strings,
          raw: lexed.raw,
        };
        lexed.raw.forEach((_, index) => {
          for (const pattern of patterns) {
            const text = views[pattern.view ?? "code"][index]!;
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
  out.truncated = out.dropped > 0;
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

/** The `findings` / `findingsTruncated` pair a scan-based check attaches. */
export type ScanFindings = Pick<CheckResult, "findings" | "findingsTruncated">;

/**
 * One finding per hit: kind `pattern:<patternId>`, location
 * `{table, sysId, recordName, field, line}` and the message
 * `"<patternId> in <table>.<field> of <name> (line N)"` — never the matched
 * text. The id leaves the line out (so an edit above a hit keeps it); when the
 * same pattern hits the same field again, the second and later occurrences get
 * an ordinal-salted id so every finding of a result stays distinct.
 * `dropped` (hits beyond the cap) becomes `findingsTruncated`. Returns `{}`
 * when there is nothing to report.
 */
export function hitsToFindings(
  check: string,
  hits: readonly ScanHit[],
  dropped = 0,
): ScanFindings {
  const seen = new Map<string, number>();
  const findings: Finding[] = hits.map((h) => {
    const kind = `pattern:${h.patternId}`;
    const identity: FindingLocation = { table: h.table, field: h.field };
    if (h.sysId !== "") identity.sysId = h.sysId;
    const finding = makeFinding(
      check,
      kind,
      `${h.patternId} in ${h.table}.${h.field} of ${h.name} (line ${h.line})`,
      { ...identity, recordName: h.name, line: h.line },
    );
    const occurrence = (seen.get(finding.id) ?? 0) + 1;
    seen.set(finding.id, occurrence);
    if (occurrence > 1) {
      finding.id = findingId(check, kind, {
        ...identity,
        logicalId: `occurrence:${occurrence}`,
      });
    }
    return finding;
  });
  const out: ScanFindings = {};
  if (findings.length > 0) out.findings = findings;
  if (dropped > 0) out.findingsTruncated = dropped;
  return out;
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
