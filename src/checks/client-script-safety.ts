import type { Check, CheckResult, CheckStatus } from "../types.js";
import { resolveScope } from "../http/query.js";
import { errorResult } from "./cert-common.js";
import {
  CLIENT_SCRIPT_SOURCES,
  MAX_SCAN_HITS,
  SERVER_SCRIPT_SOURCES,
  blindNote,
  describeHits,
  hitsToFindings,
  scanScripts,
  sourceTables,
  type ScanPattern,
} from "./script-scan.js";

const NAME = "client-script-safety";

/**
 * A global object a browser script reaches `eval` / `Function` through by
 * bracket access (`window["eval"]`). Bracket names live in string literals,
 * so those patterns test the `raw` view (comments blanked, strings kept).
 */
const GLOBAL_OBJECT = String.raw`\b(?:window|self|globalThis|top|parent)\s*\[\s*`;

/** Dynamic code and client-side GlideRecord in browser-side scripts. */
export const CLIENT_UNSAFE_PATTERNS: readonly ScanPattern[] = [
  { id: "eval", regex: /\beval\s*\(/, view: "code" },
  // Indirect eval: `(0, eval)(x)` — the comma operator hides the call.
  { id: "eval", regex: /,\s*eval\s*\)\s*\(/, view: "code" },
  {
    id: "eval",
    regex: new RegExp(String.raw`${GLOBAL_OBJECT}(["'\`])eval\1\s*\]\s*\(`),
    view: "raw",
    startInCode: true,
  },
  // `Function(…)` builds a function from a string with or without `new`;
  // a property named Function (`x.Function(`) is not the constructor.
  { id: "function-ctor", regex: /(?<![\w$.])Function\s*\(/, view: "code" },
  {
    id: "function-ctor",
    regex: /\b(?:window|self|globalThis|top|parent)\s*\.\s*Function\s*\(/,
    view: "code",
  },
  {
    id: "function-ctor",
    regex: new RegExp(String.raw`${GLOBAL_OBJECT}(["'\`])Function\1\s*\]\s*\(`),
    view: "raw",
    startInCode: true,
  },
  {
    id: "client-gliderecord",
    regex: /\bnew\s+GlideRecord\s*\(/,
    view: "code",
  },
];

/**
 * `GlideScopedEvaluator` and `evaluateScript` on the same server-side line.
 * Two anchored lookaheads, not `A.*B|B.*A`: the alternation restarts at every
 * occurrence of either name and scans to the line end each time, which is
 * quadratic on a long minified line (DEL-11).
 */
export const SERVER_UNSAFE_PATTERNS: readonly ScanPattern[] = [
  {
    id: "scoped-evaluator",
    regex: /^(?=.*\bGlideScopedEvaluator\b)(?=.*\bevaluateScript\b)/,
    view: "code",
  },
];

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Certification rule 2.8 (`ci/certification/CHECKLIST.md`) — High/Medium: no
 * client-side `eval()` and no unvalidated `GlideScopedEvaluator` sources.
 *
 * Client sources (client scripts, UI Scripts, UI Policy scripts and UI Action
 * client scripts) are scanned for `eval(`, `new Function(` and
 * `new GlideRecord(` (client GlideRecord is forbidden in scoped apps). Server
 * sources (business rules, Script Includes, UI Action scripts, scheduled
 * jobs, scripted REST operations, transform maps and scripts) are scanned for
 * `GlideScopedEvaluator` used with `evaluateScript` on the same line. Comment
 * lines are ignored. Messages name the artifact, field and line, never the
 * matched text.
 *
 * - **fail** — any hit, or any script table read was security-trimmed.
 * - **warn** — the scope is unset, a zero-row read was ambiguous, or a script could
 *   not be fully scanned (field not returned, unterminated literal).
 * - **pass** — no hit in any in-scope script, or the scope ships none.
 */
export const clientScriptSafety: Check = {
  name: NAME,
  description:
    "No eval, Function constructor or client GlideRecord in client scripts, and no GlideScopedEvaluator.evaluateScript on the server.",
  meta: {
    requires: "scope",
    rule: "2.8",
    severity: "blocker",
    tables: sourceTables([...CLIENT_SCRIPT_SOURCES, ...SERVER_SCRIPT_SOURCES]),
    remediation:
      "Remove eval() and new Function() from client code; fetch server data through GlideAjax with a client-callable Script Include or pass it via g_scratchpad instead of a client GlideRecord; never evaluate dynamic script with GlideScopedEvaluator.",
    verdicts: {
      pass: "No unsafe dynamic code or client GlideRecord in any in-scope script, or the scope ships none.",
      warn: "No scope set, an ambiguous zero-row read, or a script that could not be fully scanned (field not returned, unterminated literal).",
      fail: "eval, new Function, client GlideRecord or GlideScopedEvaluator.evaluateScript found, or a script table read was security-trimmed.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the client script safety scan (pass a scope to enable it).",
      );
    }

    try {
      const { clause } = await resolveScope(ctx, scope);
      const client = await scanScripts(
        ctx,
        clause,
        CLIENT_SCRIPT_SOURCES,
        CLIENT_UNSAFE_PATTERNS,
      );
      const server = await scanScripts(
        ctx,
        clause,
        SERVER_SCRIPT_SOURCES,
        SERVER_UNSAFE_PATTERNS,
      );

      const merged = [...client.hits, ...server.hits];
      const hits = merged.slice(0, MAX_SCAN_HITS);
      const dropped =
        client.dropped + server.dropped + (merged.length - hits.length);
      const total = hits.length + dropped;
      const findings = hitsToFindings(NAME, hits, dropped);
      const scanResult = (
        status: CheckStatus,
        message: string,
      ): CheckResult => ({
        ...result(status, message),
        ...findings,
      });
      const artifacts = new Set([...client.artifacts, ...server.artifacts]);
      const trimmed = [...client.trimmed, ...server.trimmed];
      const ambiguous = [...client.ambiguous, ...server.ambiguous];
      const unverified = [...client.unverified, ...server.unverified];
      const blind = blindNote(ambiguous, unverified);
      const scanned = client.scanned + server.scanned;

      const trimmedNote =
        trimmed.length > 0
          ? ` The read of ${trimmed.join(", ")} was security-trimmed — grant the account read access; the scripts it cannot see are the ones this gate cannot clear.`
          : "";
      if (total > 0) {
        return scanResult(
          "fail",
          `${total} unsafe dynamic-code or client GlideRecord use(s) in ${artifacts.size} artifact(s): ${describeHits(hits, dropped)}. Use GlideAjax with a client-callable Script Include or g_scratchpad, and no dynamic code.${trimmedNote}${blind}`,
        );
      }
      if (trimmed.length > 0) {
        return scanResult(
          "fail",
          `Cannot fully scan scripts in scope "${scope}" for unsafe dynamic code.${trimmedNote}`,
        );
      }
      if (blind) {
        return scanResult(
          "warn",
          `No unsafe dynamic code in ${scanned} script artifact(s) in scope "${scope}", but some scripts could not be confirmed.${blind}`,
        );
      }
      if (scanned === 0) {
        return scanResult(
          "pass",
          `No active scripts in scope "${scope}" — nothing to scan.`,
        );
      }
      return scanResult(
        "pass",
        `No eval, Function constructor, client GlideRecord or GlideScopedEvaluator.evaluateScript in ${scanned} script artifact(s) in scope "${scope}".`,
      );
    } catch (err) {
      return errorResult(NAME, "client script safety", err);
    }
  },
};
