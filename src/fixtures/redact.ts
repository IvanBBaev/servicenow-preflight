/**
 * F-X-6: redaction applied to every exchange before it is written to a
 * recording. It is allowlist-based where it can be:
 *
 * - a Table API response keeps only the fields the request asked for
 *   (`sysparm_fields`);
 * - `name` / `email` / `user_name` on `sys_user` and `sys_user_group` become
 *   stable pseudonyms (`user-0001`), unless the recording is raw;
 * - any value that looks like a password, token, key or JWT, and any value
 *   under a secret-looking field name, becomes `"<redacted>"` (raw or not);
 * - the instance host becomes `instance.invalid` everywhere;
 * - the request's query and the `link` header's URLs get the same treatment
 *   (CFG-5): emails and people operands of `sysparm_query` become pseudonyms.
 */

/** What every redacted value is replaced with. */
export const REDACTED = "<redacted>";

/** The origin a recording uses in place of the real instance. */
export const PLACEHOLDER_ORIGIN = "https://instance.invalid";

const PLACEHOLDER_HOST = "instance.invalid";

/**
 * Field names whose values are secrets whatever they hold. CFG-5 / RR-30: a
 * secret word anywhere in the name (`userPassword`, `glide.smtp.pwd`,
 * `client_secret`, `session_id`, `cookie`), a `pass` / `pin` segment
 * (`x.basic.auth.pass`, `u_pin`) and an encryption key name all count.
 */
const SECRET_NAME =
  /pass(?:word|wd|phrase|code)|(?:^|[._-])(?:pass|pin)$|pwd|secret|token|api_?key|private_?key|credential|^authorization$|cookie|session|encryption[._-]?key/i;

/** `true` when a field or property name marks its value as a secret. */
function secretName(name: string): boolean {
  return SECRET_NAME.test(name) || /[a-z0-9]Pass$/.test(name);
}

/** A secret word inside an identifier, a property name or a header name. */
const SECRET_WORD =
  "[A-Za-z0-9_$.-]*?(?:pass(?:word|wd|phrase)|pwd|secret|token|api_?key|private_?key|credential|authorization|cookie)[A-Za-z0-9_$.-]*";

/**
 * A secret's tail: everything up to the quote `q` that opened it, on one line.
 * Escaped quotes (`\"` inside a JSON-encoded string) close it too.
 */
const QUOTED_TAIL = String.raw`(?:(?!\k<q>)[^\n]){1,400}?(?<post>\k<q>)`;
const QUOTE = String.raw`(?<q>\\?["'\x60])`;

/**
 * Secrets that can appear inside any text. A rule with a `pre` / `post` group
 * keeps those parts (the name, the quotes) and replaces only what lies between,
 * so a script keeps its shape; a rule without them replaces the whole match.
 */
const SECRET_VALUES: readonly RegExp[] = [
  // A JWT.
  /eyJ[\w-]{4,}\.eyJ[\w-]{4,}\.[\w-]+/g,
  // URL userinfo: `https://user:pass@host` keeps only the scheme and host.
  /(?<pre>\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:"'`<>\\]+:[^\s/?#@"'`<>\\]*(?<post>@)/gi,
  // An Authorization value of any length after the header name.
  /(?<pre>\bauthorization\\?["']?[ \t]*[:=,][ \t]*\\?["']?)(?:Bearer|Basic|Digest|Token|Negotiate|NTLM)[ \t]+[A-Za-z0-9+/=._~-]+/gi,
  // A Bearer / Basic credential anywhere (prose such as "Basic auth" is kept).
  /\b(?:Bearer|Basic)[ \t]+(?=[A-Za-z0-9+/=._~-]*[0-9+/=._~-])[A-Za-z0-9+/=._~-]{8,}/gi,
  // A PEM private key, and common vendor token shapes.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // A quoted literal assigned to a secret-looking name, camelCase and
  // prefixed names included: `var userPassword = "…"`, `"password":"…"`,
  // `{\"password\":\"…\"}`, `const token = \x60…\x60`.
  new RegExp(
    String.raw`(?<pre>${SECRET_WORD}\\?["'\x60]?[ \t]*[:=][ \t]*${QUOTE})${QUOTED_TAIL}`,
    "gi",
  ),
  // A literal passed next to a secret-looking name:
  // `gs.setProperty("glide.x.pwd", "…")`, `setRequestHeader("x-sn-apikey", "…")`.
  new RegExp(
    String.raw`(?<pre>(?<q0>["'\x60])${SECRET_WORD}\k<q0>[ \t]*,[ \t]*${QUOTE})${QUOTED_TAIL}`,
    "gi",
  ),
  // The password argument of `setBasicAuth("user", "…")`, and a setter such
  // as `setPassword("…")` / `setApiKey("…")`.
  new RegExp(
    String.raw`(?<pre>\bsetBasicAuth[ \t]*\([ \t]*(?<q0>["'\x60])(?:(?!\k<q0>)[^\n])*\k<q0>[ \t]*,[ \t]*${QUOTE})${QUOTED_TAIL}`,
    "g",
  ),
  new RegExp(
    String.raw`(?<pre>\bset[A-Za-z]*(?:Password|Passwd|Pwd|Secret|Token|ApiKey|Credential)[ \t]*\([ \t]*${QUOTE})${QUOTED_TAIL}`,
    "g",
  ),
  // An unquoted `name=value` (a query string, a form body, a property line):
  // `password=…&user=x`, `?apikey=…`, also at the start of a quoted string.
  new RegExp(
    String.raw`(?<pre>(?:^|[?&;\s,{("'\x60])${SECRET_WORD}=)(?!["'\x60\\=<])[^&;\s"'\x60<>#]+`,
    "gim",
  ),
];

/** Replace one rule's matches, keeping its `pre` / `post` groups. */
function replaceRule(text: string, re: RegExp): string {
  return text.replace(re, (...args: unknown[]) => {
    const groups = args[args.length - 1] as
      Record<string, string | undefined> | undefined;
    if (groups && typeof groups === "object") {
      return `${groups.pre ?? ""}${REDACTED}${groups.post ?? ""}`;
    }
    return REDACTED;
  });
}

/** `text` with every {@link SECRET_VALUES} match replaced. */
function stripSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUES) out = replaceRule(out, re);
  return out;
}

/**
 * `true` when `text` holds a secret by {@link SECRET_VALUES}: some rule would
 * still change it. A value already reduced to `<redacted>` does not count, so
 * a redacted recording reads as clean.
 */
export function looksSecret(text: string): boolean {
  return stripSecrets(text) !== text;
}

/** Tables whose identifying fields are pseudonymised, and their prefixes. */
const PEOPLE_TABLES: Readonly<Record<string, string>> = {
  sys_user: "user",
  sys_user_group: "group",
};
const PEOPLE_FIELDS = new Set(["name", "email", "user_name"]);

/** The pseudonym prefix of a people table (own keys only). */
function peoplePrefix(table: string | undefined): string | undefined {
  return table !== undefined && Object.hasOwn(PEOPLE_TABLES, table)
    ? PEOPLE_TABLES[table]
    : undefined;
}

/** Response headers a recording keeps; everything else is dropped. */
const KEPT_HEADERS = ["content-type", "x-total-count", "link", "retry-after"];

/** What the redactor needs to know about the request a body answered. */
export interface RedactTarget {
  /** The Table API table, when the path is `/api/now/table/<table>…`. */
  table?: string;
  /** The `sysparm_fields` the request asked for, when it named any. */
  fields?: readonly string[];
}

/** Options for {@link createRedactor}. */
export interface RedactorOptions {
  /** The real instance origin, replaced by {@link PLACEHOLDER_ORIGIN}. */
  origin: string;
  /** Keep names and emails (`--record-raw`); secrets are still redacted. */
  raw?: boolean;
}

/** Redaction state for one recording: the pseudonym map lives here. */
export interface Redactor {
  /** Redact a parsed JSON response body. */
  body(value: unknown, target: RedactTarget): unknown;
  /** Redact free text (a non-JSON body, a query value). */
  text(value: string): string;
  /**
   * Redact one query parameter value of a request to `table` (CFG-5): a
   * secret-looking parameter name redacts it whole, and outside a raw
   * recording emails and the people operands of a `sysparm_query`
   * (`user_name=…`, `email=…`, `sys_created_by=…`) become pseudonyms.
   */
  query(name: string, value: string, table?: string): string;
  /**
   * Keep only the allowlisted headers (names matched case-insensitively),
   * with the host replaced and the `link` URLs' queries redacted.
   */
  headers(source: Readonly<Record<string, string>>): Record<string, string>;
}

/** Query fields whose operand names a person, on any table. */
const PEOPLE_QUERY_FIELDS = new Set([
  "user_name",
  "email",
  "sys_created_by",
  "sys_updated_by",
]);

/** An email address that is not already a pseudonym. */
const EMAIL =
  /[A-Za-z0-9._%+-]+@(?!example\.invalid\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** One encoded-query condition: an optional `OR`/`NQ`, a field, an operator. */
const CONDITION =
  /^(?<lead>(?:OR|NQ)?)(?<field>[a-z0-9_.]+)(?<op>!=|=|NOT LIKE|LIKE|NOT IN|IN|STARTSWITH|ENDSWITH|CONTAINS|DOES NOT CONTAIN)(?<operand>.*)$/s;

/** The table of a Table / Aggregate API path, when it is one. */
export function pathTable(path: string): string | undefined {
  const match = /^\/api\/now\/(?:v\d+\/)?(?:table|stats)\/([^/?#]+)/.exec(path);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1] as string);
  } catch {
    // CFG-18: a malformed escape is not a table name.
    return undefined;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the redactor for a recording of the instance at `opts.origin`. */
export function createRedactor(opts: RedactorOptions): Redactor {
  const { host } = new URL(opts.origin);
  const hostName = new URL(opts.origin).hostname;
  const hostPatterns = [
    [new RegExp(`https?://${escapeRegExp(host)}`, "gi"), PLACEHOLDER_ORIGIN],
    [new RegExp(escapeRegExp(hostName), "gi"), PLACEHOLDER_HOST],
  ] as const;
  const pseudonyms = new Map<string, string>();
  const counters = new Map<string, number>();

  function pseudonym(prefix: string, value: string, field: string): string {
    const id = `${prefix}:${value}`;
    let name = pseudonyms.get(id);
    if (!name) {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      name = `${prefix}-${String(next).padStart(4, "0")}`;
      pseudonyms.set(id, name);
    }
    return field === "email" ? `${name}@example.invalid` : name;
  }

  function hostless(value: string): string {
    let out = value;
    for (const [pattern, replacement] of hostPatterns) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }

  function text(value: string): string {
    return hostless(stripSecrets(value));
  }

  function person(field: string, value: string, prefix = "user"): string {
    if (
      value === "" ||
      /^(?:user|group)-\d{4}(?:@example\.invalid)?$/.test(value)
    ) {
      return value;
    }
    return pseudonym(prefix, value, field === "email" ? "email" : "");
  }

  function encodedQuery(value: string, table: string | undefined): string {
    const prefix = peoplePrefix(table);
    return value
      .split("^")
      .map((part) => {
        const groups = CONDITION.exec(part)?.groups;
        if (!groups) return part;
        const field = groups.field as string;
        const leaf = field.slice(field.lastIndexOf(".") + 1);
        const people =
          PEOPLE_QUERY_FIELDS.has(leaf) ||
          (prefix !== undefined && field === "name");
        if (!people) return part;
        const op = groups.op as string;
        const operand = groups.operand as string;
        const mapped = /IN$/.test(op)
          ? operand
              .split(",")
              .map((v) => person(leaf, v, prefix))
              .join(",")
          : person(leaf, operand, prefix);
        return `${groups.lead ?? ""}${field}${op}${mapped}`;
      })
      .join("^");
  }

  function query(name: string, value: string, table?: string): string {
    if (secretName(name) && value !== "") return REDACTED;
    let out = text(value);
    if (opts.raw) return out;
    if (name === "sysparm_query") out = encodedQuery(out, table);
    return out.replace(EMAIL, (email) => person("email", email));
  }

  /** A `link` header with each URL's query redacted like a request's. */
  function link(value: string): string {
    return text(value).replace(/<([^>]*)>/g, (whole, target: string) => {
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        return whole;
      }
      const table = pathTable(url.pathname);
      const params = new URLSearchParams();
      for (const [name, v] of url.searchParams) {
        params.append(name, query(name, v, table));
      }
      url.search = params.toString();
      return `<${url.toString()}>`;
    });
  }

  /** Redact one value; `secret` marks it as held under a secret field name. */
  function walk(value: unknown, secret: boolean, people?: string): unknown {
    if (secret && typeof value === "number") return REDACTED;
    if (typeof value === "string") {
      if (secret && value !== "") return REDACTED;
      if (people && value !== "") return pseudonym(people, value, "");
      return text(value);
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, secret, people));
    if (value && typeof value === "object") {
      return walkObject(value as Record<string, unknown>, secret, people);
    }
    return value;
  }

  function walkObject(
    obj: Record<string, unknown>,
    secret: boolean,
    people?: string,
  ): Record<string, unknown> {
    // A name/value row (sys_properties and similar): a secret-looking name
    // makes its value a secret too.
    const named = typeof obj.name === "string" && secretName(obj.name);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const isSecret = secret || secretName(key) || (named && key === "value");
      out[key] = walk(value, isSecret, people);
    }
    return out;
  }

  function row(
    value: unknown,
    target: RedactTarget,
    prefix: string | undefined,
  ): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return walk(value, false);
    }
    const keep = target.fields ? new Set(target.fields) : undefined;
    const named =
      typeof (value as { name?: unknown }).name === "string" &&
      secretName((value as { name: string }).name);
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (keep && !keep.has(key)) continue;
      const secret = secretName(key) || (named && key === "value");
      const people = prefix && PEOPLE_FIELDS.has(key) ? prefix : undefined;
      if (people && key === "email") {
        out[key] = mapEmail(field, people, secret);
      } else {
        out[key] = walk(field, secret, people);
      }
    }
    return out;
  }

  function mapEmail(value: unknown, prefix: string, secret: boolean): unknown {
    if (typeof value === "string" && value !== "" && !secret) {
      return pseudonym(prefix, value, "email");
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = mapEmail(v, prefix, secret);
      }
      return out;
    }
    return walk(value, secret);
  }

  return {
    body(value, target) {
      const prefix = !opts.raw ? peoplePrefix(target.table) : undefined;
      if (
        target.table &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "result" in value
      ) {
        const { result, ...rest } = value as Record<string, unknown>;
        return {
          ...(walk(rest, false) as Record<string, unknown>),
          result: Array.isArray(result)
            ? result.map((r) => row(r, target, prefix))
            : row(result, target, prefix),
        };
      }
      return walk(value, false);
    },
    text,
    query,
    headers(source) {
      const lower = new Map<string, string>();
      for (const [name, value] of Object.entries(source)) {
        if (typeof value === "string") lower.set(name.toLowerCase(), value);
      }
      const out: Record<string, string> = {};
      for (const name of KEPT_HEADERS) {
        const value = lower.get(name);
        if (value === undefined) continue;
        out[name] = name === "link" ? link(value) : text(value);
      }
      return out;
    },
  };
}
