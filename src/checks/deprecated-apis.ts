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

const NAME = "deprecated-apis";

/** Server-side APIs that do not exist in scoped apps — any hit fails. */
export const SERVER_DEPRECATED_PATTERNS: readonly ScanPattern[] = [
  { id: "packages", regex: /\bPackages\./, view: "code" },
];

/** Synchronous or server-only calls in browser-side scripts — hits warn. */
export const CLIENT_DEPRECATED_PATTERNS: readonly ScanPattern[] = [
  { id: "xml-wait", regex: /\.getXMLWait\s*\(/, view: "code" },
  // A single argument (no callback) makes getReference synchronous.
  {
    id: "get-reference-sync",
    regex: /\bg_form\.getReference\s*\([^,)]*\)/,
    view: "code",
  },
  { id: "g-user-roles-sync", regex: /\bgs\.hasRole\b/, view: "code" },
];

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Deprecated and scope-unavailable API calls in in-scope scripts.
 *
 * Server sources (business rules, Script Includes, UI Action scripts,
 * scheduled jobs, scripted REST operations, transform maps and scripts) are
 * scanned for `Packages.` — direct Java calls, not available in scoped apps.
 * Client sources (client scripts, UI Scripts, UI Policy scripts and UI Action
 * client scripts) are scanned for synchronous GlideAjax (`getXMLWait(`), a
 * callback-less `g_form.getReference(…)` (synchronous; certification rule
 * 4.7) and the server-only `gs.hasRole` (use `g_user.hasRole`). Comment lines
 * are ignored. Messages name the artifact, field and line, never the matched
 * text.
 *
 * - **fail** — a `Packages.` call, or any script table read was
 *   security-trimmed.
 * - **warn** — only synchronous / server-only client calls, the scope is
 *   unset, or a zero-row read was ambiguous.
 * - **pass** — none of the patterns in any in-scope script.
 */
export const deprecatedApis: Check = {
  name: NAME,
  description:
    "No Packages.* Java calls in server scripts, and no synchronous getXMLWait, callback-less g_form.getReference or gs.hasRole in client scripts.",
  meta: {
    requires: "scope",
    rule: "4.7",
    severity: "blocker",
    tables: sourceTables([...SERVER_SCRIPT_SOURCES, ...CLIENT_SCRIPT_SOURCES]),
    remediation:
      "Replace Packages.* Java calls with the scoped Glide APIs; on the client use asynchronous GlideAjax (getXMLAnswer or getXML with a callback) instead of getXMLWait, pass a callback to g_form.getReference (or use g_scratchpad / GlideAjax), and use g_user.hasRole instead of gs.hasRole.",
    verdicts: {
      pass: "No deprecated or scope-unavailable API call in any in-scope script, or the scope ships none.",
      warn: "Only synchronous or server-only calls in client scripts (getXMLWait, callback-less g_form.getReference, gs.hasRole), no scope, or an ambiguous zero-row read.",
      fail: "A Packages.* call in a server script, or a script table read was security-trimmed.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the deprecated API scan (pass a scope to enable it).",
      );
    }

    try {
      const { clause } = await resolveScope(ctx, scope);
      // Server first, so the blocking hits lead the (capped) list.
      const server = await scanScripts(
        ctx,
        clause,
        SERVER_SCRIPT_SOURCES,
        SERVER_DEPRECATED_PATTERNS,
      );
      const client = await scanScripts(
        ctx,
        clause,
        CLIENT_SCRIPT_SOURCES,
        CLIENT_DEPRECATED_PATTERNS,
      );

      const blocking = server.hits.length + server.dropped;
      const merged = [...server.hits, ...client.hits];
      const hits = merged.slice(0, MAX_SCAN_HITS);
      const dropped =
        server.dropped + client.dropped + (merged.length - hits.length);
      const total = hits.length + dropped;
      const findings = hitsToFindings(NAME, hits, dropped);
      const scanResult = (
        status: CheckStatus,
        message: string,
      ): CheckResult => ({
        ...result(status, message),
        ...findings,
      });
      const artifacts = new Set([...server.artifacts, ...client.artifacts]);
      const trimmed = [...server.trimmed, ...client.trimmed];
      const ambiguous = [...server.ambiguous, ...client.ambiguous];
      const scanned = server.scanned + client.scanned;
      const found =
        total > 0
          ? `${total} deprecated API call(s) in ${artifacts.size} artifact(s)` +
            (blocking > 0
              ? `, ${blocking} of them Packages.* (not available in scoped apps)`
              : "") +
            `: ${describeHits(hits, dropped)}`
          : "";
      const advice =
        "Use the scoped Glide APIs instead of Packages.*, asynchronous GlideAjax and a getReference callback on the client, and g_user.hasRole instead of gs.hasRole.";

      if (trimmed.length > 0) {
        return scanResult(
          "fail",
          `Cannot fully scan scripts in scope "${scope}" for deprecated APIs — the read of ${trimmed.join(", ")} was security-trimmed. Grant the account read access; the scripts it cannot see are the ones this check cannot clear.` +
            (found ? ` (Found so far: ${found}.)` : ""),
        );
      }

      const blind =
        ambiguous.length > 0
          ? ` (Not confirmed: no rows and no pre-trim count for ${ambiguous.join(", ")}.)`
          : "";
      if (total > 0) {
        return scanResult(
          blocking > 0 ? "fail" : "warn",
          `${found}. ${advice}${blind}`,
        );
      }
      if (blind) {
        return scanResult(
          "warn",
          `No deprecated API calls in ${scanned} script artifact(s) in scope "${scope}", but some tables could not be confirmed.${blind}`,
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
        `No Packages.* calls in server scripts and no getXMLWait, callback-less g_form.getReference or gs.hasRole in client scripts across ${scanned} script artifact(s) in scope "${scope}".`,
      );
    } catch (err) {
      return errorResult(NAME, "deprecated APIs in scripts", err);
    }
  },
};
