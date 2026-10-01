// Secret detection (PLAN Phase 1 §Configuration; GAP-ANALYSIS P1 secrets
// handling).
//
// "Config files are committable by construction" is only true if something
// enforces it, so this module is the enforcement. It has two halves with
// DELIBERATELY different appetites for false positives.
//
//  * KEY names are matched bluntly against a declared vocabulary. Blunt is
//    right here: the cost of a false positive is renaming a config key, the
//    error says exactly which one, and no legitimate committable setting needs
//    to be called `password`.
//
//  * VALUE shapes are matched NARROWLY — only a PEM private-key block, a
//    `Bearer <jwt>` string and a URL with `user:password@` userinfo, none of
//    which can plausibly be anything else.
//    The temptation is a length/entropy heuristic, and it must be resisted: a
//    32-hex sys_id, an update-set name, a signed URL and a base64 attachment
//    stub all trip it, and the operator's rational response to a check that
//    cries wolf is to switch the check off. A check that is switched off
//    catches nothing, so a narrow check that stays on is worth more than a
//    thorough one that does not. The key half is what carries the coverage;
//    the value half only catches a credential that was pasted under an
//    innocent name.
//
// Pure functions; no I/O.

import { isJsonArray, isJsonRecord } from "./json.js";

/**
 * Single words that make a key credential-bearing, case- and
 * separator-insensitive. `client_secret` and `access_token` need no entries of
 * their own — `secret` and `token` already cover them.
 */
export const SECRET_KEY_WORDS: readonly string[] = [
  "password",
  "passwords",
  "passwd",
  "secret",
  "secrets",
  "token",
  "tokens",
  "credential",
  "credentials",
  "bearer",
];

/**
 * Adjacent word pairs that are credential-bearing although neither word is on
 * its own. `key` alone would reject `sortKey`/`specKey`; the pair does not.
 */
export const SECRET_KEY_PHRASES: readonly (readonly [string, string])[] = [
  ["private", "key"],
  ["api", "key"],
];

/**
 * A PEM private key, with or without an algorithm word (`RSA`, `EC`,
 * `OPENSSH`). Nothing that is not a private key looks like this.
 */
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

/**
 * `Bearer` followed by three base64url segments — a JWT. An OPAQUE bearer
 * token is deliberately not matched: `Bearer swordfish` is indistinguishable
 * from prose, and guessing there is how the narrow half turns into the broad
 * heuristic this module refuses to be.
 */
const BEARER_JWT =
  /\bBearer\s+[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/i;

/**
 * A URL carrying a PASSWORD in its userinfo: `scheme://user:pass@host`.
 *
 * Delegated decision 2026-09-25: this is as unmistakable as the two shapes
 * above — a colon inside a URL authority before an `@` is a password by the
 * RFC 3986 grammar, not a heuristic — and it is exactly the shape an operator
 * pastes when they copy an instance URL out of a browser or a curl line. It
 * used to pass straight through to the startup log. Only the password form is
 * matched here, for EVERY option; a bare `user@` (no password) is refused only
 * on the topology keys, by `urlUserinfo` below, because elsewhere it can be
 * legitimate text.
 */
const URL_USERINFO_PASSWORD =
  /(?:[A-Za-z][A-Za-z0-9+.-]*:[/\\]*|[/\\]{2,})[^\s/\\?#@:]*:[^\s/\\?#@]*@/;
// Delegated decision 2026-09-26 (review W5b, A): the shape used to require
// `scheme://`, and the WHATWG parser the transport uses also reads userinfo out
// of `https:/a:b@h`, `https:/\a:b@h`, `https:a:b@h` and the scheme-relative
// `//a:b@h` / `\\a:b@h` (special schemes treat `\` as `/` and ignore any run of
// slashes). So the prefix is now EITHER a scheme followed by any run of `/` and
// `\` (including none) OR a run of two or more of them, and `\` ends the
// authority like `/` does. Tab/CR/LF are stripped before the test, as WHATWG
// strips them anywhere in the input. A bare scheme-less, slash-less
// `admin:pw@host` is still NOT matched here on purpose: on a non-topology
// option that is indistinguishable from ordinary `key:value@x` text, and the
// topology keys refuse it through `hasUrlUserinfo` regardless.

/** WHATWG removes ASCII tab and newline from anywhere in a URL string. */
function withoutTabOrNewline(text: string): string {
  return text.replace(/[\t\n\r]/g, "");
}

/**
 * Whether a value names credentials in its authority — `user:pass@` OR a bare
 * `user@` — with or without a scheme (`admin:pw@dev.service-now.com` has
 * none). Used on the §2a topology keys, whose values are instance names or
 * URLs and never legitimately carry a user.
 *
 * Delegated decision 2026-09-25 (fail closed): ANY `@` inside the authority of
 * a topology value is refused, not just a password, because the user half
 * alone still routes identity through a channel (argv, a committed file, the
 * startup log) that the credential store exists to replace.
 */
export function hasUrlUserinfo(text: string): boolean {
  // Delegated decision 2026-09-26 (review W5b, A): parse the way WHATWG does,
  // fail closed. The old check stripped a scheme only when `://` followed it,
  // so `https:/admin:pw@h`, `https:/\admin:pw@h` and `//admin:pw@h` — all of
  // which WHATWG reads WITH userinfo — passed. Now: drop tab/CR/LF anywhere
  // and C0-control/space at both ends (WHATWG does both), drop an optional
  // `scheme:`, drop ANY run of `/` and `\`, and refuse if an `@` appears
  // before the first `/`, `\`, `?` or `#` (`\` counts as `/`). Over-matching
  // (e.g. a non-special scheme that WHATWG would read as opaque) refuses a
  // value that could not have been a valid topology name anyway.
  const trimmed = withoutTabOrNewline(text).replace(
    // eslint-disable-next-line no-control-regex -- WHATWG trims C0 controls
    /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g,
    "",
  );
  const withoutScheme = trimmed
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, "")
    .replace(/^[/\\]+/, "");
  const authority = withoutScheme.split(/[/\\?#]/, 1)[0] ?? "";
  return authority.includes("@");
}

/** What redaction prints. Fixed text — never a length, never a prefix. */
export const REDACTED = "<redacted>";

export interface SecretFinding {
  /** Dotted/indexed path of the offender, e.g. `auth.password`, `hosts[1].token`. */
  readonly keyPath: string;
  /** Why it was refused, phrased for the operator. */
  readonly reason: string;
}

/**
 * Split a key into lowercase words across separators AND camelCase boundaries,
 * so `apiKey`, `API_KEY`, `api-key` and `api.key` all reduce to the same pair.
 * Whole-word matching is what keeps `tokenizer` out of the vocabulary.
 */
export function keyWords(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== "");
}

export function isSecretKey(key: string): boolean {
  const words = keyWords(key);
  if (words.some((word) => SECRET_KEY_WORDS.includes(word))) return true;
  return SECRET_KEY_PHRASES.some(([first, second]) =>
    words.some((word, index) => word === first && words[index + 1] === second),
  );
}

/** The shape name if this text is unmistakably a credential, else undefined. */
export function secretValueShape(text: string): string | undefined {
  if (PEM_PRIVATE_KEY.test(text)) return "a PEM private-key block";
  if (BEARER_JWT.test(text)) return "a Bearer JWT";
  if (URL_USERINFO_PASSWORD.test(withoutTabOrNewline(text))) {
    return "a URL with a password in its userinfo (user:password@)";
  }
  return undefined;
}

/**
 * First offender in a parsed document, depth-first in declaration order.
 *
 * A key is checked BEFORE descending into its value, so `{ auth: { password } }`
 * reports `auth.password` rather than whatever the value happens to look like:
 * the key name is the precise, actionable fact.
 */
export function findSecret(
  document: unknown,
  path = "",
): SecretFinding | undefined {
  if (typeof document === "string") {
    const shape = secretValueShape(document);
    if (shape === undefined) return undefined;
    return {
      keyPath: path === "" ? "(root)" : path,
      reason: `the value is ${shape}`,
    };
  }
  if (isJsonArray(document)) {
    for (const [index, item] of document.entries()) {
      const found = findSecret(item, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isJsonRecord(document)) {
    for (const [key, value] of Object.entries(document)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (isSecretKey(key)) {
        return {
          keyPath: childPath,
          reason: `the key name "${key}" is credential-bearing`,
        };
      }
      const found = findSecret(value, childPath);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
