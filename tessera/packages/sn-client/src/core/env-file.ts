// Net-new for @tessera/sn-client (not vendored): replaces the upstream
// `dotenv` dependency so the package carries zero runtime dependencies.
// The parser reproduces the dotenv v16 semantics that config.ts's
// formatEnvValue() serialiser was written against, so .env files written by
// the upstream server and by this client stay mutually round-trippable.
//
// That round-trip guarantee covers files this project WRITES, not every file
// dotenv can READ. This is a strict one-line subset of dotenv v16, verified by
// differential test against dotenv 16.6.1; two constructs diverge:
//
//   * MULTI-LINE quoted values. dotenv scans the whole file and lets a
//     "/'/`-quoted value span newlines; this parser splits on newlines first.
//     It used to TRUNCATE such a value at the first line (keeping the opening
//     quote) and then re-parse the continuation lines as top-level
//     assignments, so text inside a quoted value could inject unrelated keys —
//     and the mangled first line of an inline PEM in SN_OAUTH_JWT_KEY was still
//     truthy, so auth.ts's "key is missing" guard would not fire. Since
//     2026-09-23 (delegated decision, TODO "hand-rolled .env parser has two
//     holes" option: throw on an unterminated quote) a value that OPENS a quote
//     and never closes it on the same line THROWS, naming the line and key but
//     never the value, which may be a secret. Multi-line values are still not
//     supported; they are refused instead of mis-read. Note that loadEnv()
//     (config.ts) swallows every parse/read error, so through that path such a
//     file is IGNORED WHOLESALE — fail-closed: no truncated value and no
//     injected key reaches process.env. Nothing in this monorepo calls
//     loadEnv(); a value exported by the shell is unaffected. Use
//     SN_OAUTH_JWT_KEY_FILE for PEM keys.
//   * The `KEY: value` separator, which dotenv accepts and this parser ignores
//     (the line is dropped, not mis-read). Still open, deliberately: it fails
//     closed — the key is simply absent — and supporting it means widening the
//     grammar toward a full dotenv re-implementation, which was not chosen.
//
// formatEnvValue() emits neither construct — it throws rather than write a
// value containing a newline — so nothing this client writes can hit them.

/**
 * One-line grammar. Within a single line this matches dotenv v16 exactly:
 *   [export] KEY = <single|double|backtick-quoted | unquoted-up-to-#>  [# comment]
 * Quoted values keep everything between the outer quotes (escaped quotes of the
 * same kind allowed, never unescaped); double-quoted values additionally expand
 * `\n` and `\r`. Unquoted values are trimmed and end at an unquoted `#`.
 * Values spanning more than one line are NOT supported — see the note above.
 */
const LINE =
  /^\s*(?:export\s+)?([\w.-]+)\s*=\s*("(?:\\"|[^"])*"|'(?:\\'|[^'])*'|`(?:\\`|[^`])*`|[^#\r\n]*)\s*(?:#.*)?$/;

/**
 * Parse .env file content into key/value pairs (later lines win).
 *
 * @throws Error when a value opens a quote (`"`, `'` or `` ` ``) that the same
 * line never closes — the shape of a multi-line value this parser does not
 * support. Refusing it is what stops the continuation lines from being read as
 * assignments of their own.
 */
export function parseEnvContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = LINE.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = (match[2] ?? "").trim();
    if (key === undefined) continue;
    const quote = value[0];
    if (
      (quote === '"' || quote === "'" || quote === "`") &&
      !value.includes(quote, 1)
    ) {
      throw new Error(
        `.env line ${index + 1}: the value of ${key} opens a ${quote} quote that is never closed on that line. ` +
          "Multi-line values are not supported; put the value on one line (a PEM key belongs in SN_OAUTH_JWT_KEY_FILE).",
      );
    }
    if (
      value.length >= 2 &&
      (quote === '"' || quote === "'" || quote === "`") &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Apply parsed pairs to an environment with dotenv's `override: false`
 * semantics: keys already present in the environment are left untouched.
 */
export function applyEnv(
  pairs: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [key, value] of Object.entries(pairs)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}
