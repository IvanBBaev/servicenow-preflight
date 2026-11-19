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

const NAME = "secret-in-scripts";

/** Secret-named key: the end of an identifier or a quoted key (`db_password`, `apiToken`). */
const SECRET_KEY = String.raw`(?:password|passwd|pwd|api[_-]?key|apikey|secret|token|credential)s?\d*`;

/**
 * Hard-coded secret patterns. None of them echo what they match: hits carry
 * only the artifact, field, line and pattern id.
 *
 * - `key-assign` (code view): an identifier that ends in a secret name
 *   (`password`, `db_password`, `apiToken`, `clientSecret`, …) assigned a
 *   non-empty string literal. The code view keeps the quote delimiters and
 *   replaces the literal body by same-length spaces, so a space right after
 *   the opening quote means a non-empty body — `password = ""` and
 *   `token = \`${x}\`` do not match, nor does a string concatenation such as
 *   `"token=" + x` (the key name sits inside the blanked literal).
 * - `quoted-key-assign` (raw view): the same with a quoted key — `{"password": "…"}`
 *   or `cfg['api_key'] = '…'` — whose value is a non-empty literal.
 * - `known-token-shape` (string view): well-known credential formats inside
 *   string and template literal bodies — AWS access key ids, GitHub tokens,
 *   Slack tokens, PEM private keys and JWTs.
 * - `basic-auth-header` (code view): `setBasicAuth(` with a literal first
 *   argument.
 * - `auth-header-value` (string view): a literal `Basic <credentials>` or
 *   `Bearer <token>` header value (the credential part has a digit or one of
 *   `+ / = . _ ~ -`, so prose such as "Basic authentication" does not match).
 */
export const SECRET_PATTERNS: readonly ScanPattern[] = [
  {
    id: "key-assign",
    regex: new RegExp(String.raw`${SECRET_KEY}\s*[:=]\s*["'\`] `, "i"),
    view: "code",
  },
  {
    id: "quoted-key-assign",
    regex: new RegExp(
      String.raw`["'\`][\w$.-]*${SECRET_KEY}["'\`]\s*\]?\s*[:=]\s*(?:["'](?!["'])|\`(?![\`$]))`,
      "i",
    ),
    view: "raw",
  },
  {
    id: "known-token-shape",
    regex:
      /AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
    view: "string",
  },
  {
    id: "basic-auth-header",
    regex: /\bsetBasicAuth\s*\(\s*["'`]/,
    view: "code",
  },
  {
    id: "auth-header-value",
    regex:
      /\b(?:Basic|Bearer)\s+(?=[A-Za-z0-9+/=._~-]*[0-9+/=._~-])[A-Za-z0-9+/=._~-]{12,}/,
    view: "string",
  },
];

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Hard-coded secrets in in-scope scripts (certification rule 1.7, the live
 * counterpart of the offline `ci/certification/scan.sh` secret scan).
 *
 * Every standard script source — server and client — is scanned for
 * {@link SECRET_PATTERNS}. Comments are ignored; string-literal contents are
 * only inspected for known token shapes. Messages name the artifact, field,
 * line and pattern id, never the matched text or any value.
 *
 * - **fail** — any hit, or a script table read was security-trimmed.
 * - **warn** — the scope is unset, a zero-row read was ambiguous, or a script could
 *   not be fully scanned (field not returned, unterminated literal).
 * - **pass** — no secret pattern in any in-scope script.
 */
export const secretInScripts: Check = {
  name: NAME,
  description:
    "No hard-coded passwords, API keys, tokens or private keys in in-scope scripts.",
  meta: {
    requires: "scope",
    rule: "1.7",
    severity: "blocker",
    tables: sourceTables(ALL_SCRIPT_SOURCES),
    remediation:
      "Move secrets out of scripts: store them in a Connection & Credential alias or a password2-typed system property, read them at run time (for example through sn_cc.ConnectionInfoProvider or gs.getProperty), and rotate any secret that has already shipped.",
    verdicts: {
      pass: "No hard-coded secret pattern in any in-scope script, or the scope ships no scripts.",
      warn: "No scope, an ambiguous zero-row read, or a script that could not be fully scanned (field not returned, unterminated literal).",
      fail: "A possible hard-coded secret in an in-scope script, or a script table read was security-trimmed.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the hard-coded secret scan (pass a scope to enable it).",
      );
    }

    try {
      const { clause } = await resolveScope(ctx, scope);
      const scan = await scanScripts(
        ctx,
        clause,
        ALL_SCRIPT_SOURCES,
        SECRET_PATTERNS,
      );
      const total = scan.hits.length + scan.dropped;
      const scanResult = (
        status: CheckStatus,
        message: string,
      ): CheckResult => ({
        ...result(status, message),
        ...hitsToFindings(NAME, scan.hits, scan.dropped),
      });
      const found =
        total > 0
          ? `${total} possible hard-coded secret(s) in in-scope scripts: ${describeHits(scan.hits, scan.dropped)}`
          : "";

      if (scan.trimmed.length > 0) {
        return scanResult(
          "fail",
          `Cannot fully scan scripts in scope "${scope}" for hard-coded secrets — the read of ${scan.trimmed.join(", ")} was security-trimmed. Grant the account read access; the scripts it cannot see are the ones this check cannot clear.` +
            (found ? ` (Found so far: ${found}.)` : ""),
        );
      }

      const blind = blindNote(scan.ambiguous, scan.unverified);
      if (total > 0) {
        return scanResult(
          "fail",
          `${found}. Move secrets to a Connection & Credential alias or a password2 property and rotate them.${blind}`,
        );
      }
      if (blind) {
        return scanResult(
          "warn",
          `No hard-coded secret pattern in ${scan.scanned} script artifact(s) in scope "${scope}", but some scripts could not be confirmed.${blind}`,
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
        `No hard-coded secret pattern in any in-scope script (${scan.scanned} script artifact(s) in scope "${scope}").`,
      );
    } catch (err) {
      return errorResult(NAME, "hard-coded secrets in scripts", err);
    }
  },
};
