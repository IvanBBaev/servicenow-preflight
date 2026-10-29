import type { Check, CheckResult, CheckStatus } from "../types.js";
import { resolveScope } from "../http/query.js";
import { errorResult } from "./cert-common.js";
import {
  CLIENT_SCRIPT_SOURCES,
  MAX_SCAN_HITS,
  SERVER_SCRIPT_SOURCES,
  describeHits,
  hitsToFindings,
  scanScripts,
  sourceTables,
  type ScanPattern,
} from "./script-scan.js";

const NAME = "log-leftovers";

/** Debug output left in browser-side scripts. */
export const CLIENT_LOG_PATTERNS: readonly ScanPattern[] = [
  { id: "console", regex: /\bconsole\.(log|debug|dir)\s*\(/, view: "code" },
  { id: "alert", regex: /\balert\s*\(/, view: "code" },
];

/** Global-only logging left in server-side scripts (absent in scoped apps). */
export const SERVER_LOG_PATTERNS: readonly ScanPattern[] = [
  { id: "gs-log", regex: /\bgs\.(print|log)\s*\(/, view: "code" },
];

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Certification rule 4.3 (`ci/certification/CHECKLIST.md`) — Low: no
 * `console.log()` in shipped client code; use `jslog()`.
 *
 * Client sources (client scripts, UI Scripts, UI Policy scripts and UI Action
 * client scripts) are scanned for `console.log(` / `console.debug(` /
 * `console.dir(` and debug `alert(` calls. Server sources (business rules,
 * Script Includes, UI Action scripts, scheduled jobs, scripted REST
 * operations, transform maps and scripts) are scanned for `gs.print(` and
 * `gs.log(`, which are not available in scoped apps (`gs.info` is). Comment
 * lines are ignored. Messages name the artifact, field and line, never the
 * matched text.
 *
 * - **fail** — any script table read was security-trimmed (the scripts the
 *   account cannot see are the ones this check cannot clear).
 * - **warn** — a log leftover was found, the scope is unset, or a zero-row
 *   read was ambiguous.
 * - **pass** — no log leftover in any in-scope script.
 */
export const logLeftovers: Check = {
  name: NAME,
  description:
    "No console.log/debug/dir or debug alert() in client scripts and no gs.print/gs.log on the server. Advisory.",
  meta: {
    requires: "scope",
    rule: "4.3",
    severity: "advisory",
    tables: sourceTables([...CLIENT_SCRIPT_SOURCES, ...SERVER_SCRIPT_SOURCES]),
    remediation:
      "Use jslog() instead of console.log/debug/dir on the client and remove debug alert() calls; use gs.info, gs.warn or gs.error instead of gs.print and gs.log on the server.",
    verdicts: {
      pass: "No log leftover in any in-scope script, or the scope ships none.",
      warn: "A console/alert call on the client or gs.print/gs.log on the server, no scope, or an ambiguous zero-row read.",
      fail: "A script table read was security-trimmed.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the log leftover scan (pass a scope to enable it).",
      );
    }

    try {
      const { clause } = await resolveScope(ctx, scope);
      const client = await scanScripts(
        ctx,
        clause,
        CLIENT_SCRIPT_SOURCES,
        CLIENT_LOG_PATTERNS,
      );
      const server = await scanScripts(
        ctx,
        clause,
        SERVER_SCRIPT_SOURCES,
        SERVER_LOG_PATTERNS,
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
      const scanned = client.scanned + server.scanned;
      const found =
        total > 0
          ? `${total} log leftover(s) in ${artifacts.size} artifact(s): ${describeHits(hits, dropped)}`
          : "";

      if (trimmed.length > 0) {
        return scanResult(
          "fail",
          `Cannot fully scan scripts in scope "${scope}" for log leftovers — the read of ${trimmed.join(", ")} was security-trimmed. Grant the account read access; the scripts it cannot see are the ones this check cannot clear.` +
            (found ? ` (Found so far: ${found}.)` : ""),
        );
      }

      const blind =
        ambiguous.length > 0
          ? ` (Not confirmed: no rows and no pre-trim count for ${ambiguous.join(", ")}.)`
          : "";
      if (total > 0) {
        return scanResult(
          "warn",
          `${found}. Use jslog() on the client, gs.info/gs.warn on the server, and remove debug alert() calls.${blind}`,
        );
      }
      if (blind) {
        return scanResult(
          "warn",
          `No log leftovers in ${scanned} script artifact(s) in scope "${scope}", but some tables could not be confirmed.${blind}`,
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
        `No console/alert calls in client scripts and no gs.print/gs.log in server scripts across ${scanned} script artifact(s) in scope "${scope}".`,
      );
    } catch (err) {
      return errorResult(NAME, "log leftovers in scripts", err);
    }
  },
};
