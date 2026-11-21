import type { Check, CheckResult, CheckStatus } from "../types.js";
import { resolveScope } from "../http/query.js";
import { errorResult } from "./cert-common.js";
import {
  ALL_SCRIPT_SOURCES,
  blindNote,
  describeHits,
  hitsToFindings,
  scanScripts,
  sourceTables,
  type ScanPattern,
} from "./script-scan.js";

const NAME = "hardcoded-identifiers";

/**
 * True when `url` points somewhere other than an instance
 * (`*.service-now.com`) or `localhost`. The host is the one `new URL()`
 * resolves — after any `user:password@` part — so
 * `https://x.service-now.com:pw@evil.example.com` is judged by
 * `evil.example.com` (DEL-15). A candidate `URL` cannot parse stays a finding.
 */
export function isForeignUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  return !(host === "localhost" || host.endsWith(".service-now.com"));
}

/**
 * The patterns this check scans for. A URL whose host is an instance
 * (`*.service-now.com`) or `localhost` is not a finding.
 */
export const HARDCODED_PATTERNS: readonly ScanPattern[] = [
  // sys_ids and URLs live in string literals: scan only those, so a 32-hex
  // run in code or a regex literal is not a finding. sys_ids are compared
  // case-insensitively by the platform, so an uppercase literal counts too.
  { id: "sys-id", regex: /\b[0-9a-f]{32}\b/i, view: "string" },
  {
    id: "url",
    regex: /https?:\/\/[^\s"'`]+/i,
    accept: isForeignUrl,
    view: "string",
  },
];

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Certification rule 4.5 (`ci/certification/CHECKLIST.md`) — Medium: no
 * hard-coded sys_ids or URLs in scripts. A literal sys_id breaks the moment
 * the record differs on the target instance; a literal endpoint pins the app
 * to one environment.
 *
 * Scans every active in-scope server and client script (business rules,
 * Script Includes, UI Actions, scheduled jobs, scripted REST operations,
 * transform maps and scripts, client scripts, UI Scripts, UI Policies) for a
 * 32-hex sys_id or an `http(s)://` URL that is not an instance or localhost
 * URL inside a string or template literal (comments and code are not
 * scanned). Messages name the artifact, field and line,
 * never the matched text.
 *
 * - **fail** — any script table read was security-trimmed (the scripts the
 *   account cannot see are the ones this check cannot clear).
 * - **warn** — a hard-coded identifier was found, the scope is unset, a
 *   zero-row read was ambiguous, or a script could not be fully scanned.
 * - **pass** — no hard-coded identifier in any in-scope script.
 */
export const hardcodedIdentifiers: Check = {
  name: NAME,
  description:
    "No hard-coded sys_ids or non-instance URLs in in-scope scripts. Advisory.",
  meta: {
    requires: "scope",
    rule: "4.5",
    severity: "advisory",
    tables: sourceTables(ALL_SCRIPT_SOURCES),
    remediation:
      "Replace literal sys_ids with GlideRecord lookups by name or a system property (sys_properties), and move endpoint URLs into system properties or a REST Message, so the app works unchanged on every instance.",
    verdicts: {
      pass: "No hard-coded sys_id or URL in any in-scope script, or the scope ships none.",
      warn: "A hard-coded sys_id or URL, no scope, an ambiguous zero-row read, or a script that could not be fully scanned (field not returned, unterminated literal).",
      fail: "A script table read was security-trimmed.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the hard-coded identifier scan (pass a scope to enable it).",
      );
    }

    try {
      const { clause } = await resolveScope(ctx, scope);
      const scan = await scanScripts(
        ctx,
        clause,
        ALL_SCRIPT_SOURCES,
        HARDCODED_PATTERNS,
      );
      const total = scan.hits.length + scan.dropped;
      const findings = hitsToFindings(NAME, scan.hits, scan.dropped);
      const scanResult = (
        status: CheckStatus,
        message: string,
      ): CheckResult => ({
        ...result(status, message),
        ...findings,
      });
      const found =
        total > 0
          ? `${total} hard-coded identifier(s) in ${scan.artifacts.length} artifact(s): ${describeHits(scan.hits, scan.dropped)}`
          : "";

      if (scan.trimmed.length > 0) {
        return scanResult(
          "fail",
          `Cannot fully scan scripts in scope "${scope}" for hard-coded identifiers — the read of ${scan.trimmed.join(", ")} was security-trimmed. Grant the account read access; the scripts it cannot see are the ones this check cannot clear.` +
            (found ? ` (Found so far: ${found}.)` : ""),
        );
      }

      const blind = blindNote(scan.ambiguous, scan.unverified);
      if (total > 0) {
        return scanResult(
          "warn",
          `${found}. Use system properties or lookups by name instead.${blind}`,
        );
      }
      if (blind) {
        return scanResult(
          "warn",
          `No hard-coded identifiers in ${scan.scanned} script artifact(s) in scope "${scope}", but some scripts could not be confirmed.${blind}`,
        );
      }
      if (scan.scanned === 0) {
        return scanResult(
          "pass",
          `No active scripts in scope "${scope}" — nothing to scan.`,
        );
      }
      return scanResult(
        "pass",
        `No hard-coded sys_ids or URLs in ${scan.scanned} script artifact(s) in scope "${scope}".`,
      );
    } catch (err) {
      return errorResult(NAME, "hard-coded identifiers in scripts", err);
    }
  },
};
