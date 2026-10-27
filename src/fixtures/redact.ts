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
 * - the instance host becomes `instance.invalid` everywhere.
 */

/** What every redacted value is replaced with. */
export const REDACTED = "<redacted>";

/** The origin a recording uses in place of the real instance. */
export const PLACEHOLDER_ORIGIN = "https://instance.invalid";

const PLACEHOLDER_HOST = "instance.invalid";

/** Field names whose values are secrets whatever they hold. */
const SECRET_NAME =
  /password|passwd|passphrase|(^|_)pass$|secret|token|api_?key|private_?key|credential|^authorization$/i;

/**
 * Secrets that can appear inside any text: a JWT, an Authorization header
 * value, a PEM private key, common vendor token shapes, and a quoted literal
 * assigned to a secret-looking name. Each match is replaced, not the whole
 * value, so a script keeps its shape.
 */
const SECRET_VALUES: readonly RegExp[] = [
  /eyJ[\w-]{4,}\.eyJ[\w-]{4,}\.[\w-]+/g,
  /\b(?:Bearer|Basic)\s+(?=[A-Za-z0-9+/=._~-]*[0-9+/=._~-])[A-Za-z0-9+/=._~-]{12,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:password|passwd|pwd|secret|token|api_?key)["']?\s*[:=]\s*(["'])[^"'\s]{4,}\1/gi,
];

/** `true` when `text` holds a secret by {@link SECRET_VALUES}. */
export function looksSecret(text: string): boolean {
  return SECRET_VALUES.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/** `text` with every {@link SECRET_VALUES} match replaced. */
function stripSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUES) out = out.replace(re, REDACTED);
  return out;
}

/** Tables whose identifying fields are pseudonymised, and their prefixes. */
const PEOPLE_TABLES: Readonly<Record<string, string>> = {
  sys_user: "user",
  sys_user_group: "group",
};
const PEOPLE_FIELDS = new Set(["name", "email", "user_name"]);

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
  /** Keep only the allowlisted headers, with the host replaced. */
  headers(source: Readonly<Record<string, string>>): Record<string, string>;
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

  /** Redact one value; `secret` marks it as held under a secret field name. */
  function walk(value: unknown, secret: boolean, people?: string): unknown {
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
    const named = typeof obj.name === "string" && SECRET_NAME.test(obj.name);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const isSecret =
        secret || SECRET_NAME.test(key) || (named && key === "value");
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
      SECRET_NAME.test((value as { name: string }).name);
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (keep && !keep.has(key)) continue;
      const secret = SECRET_NAME.test(key) || (named && key === "value");
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
      const prefix =
        !opts.raw && target.table ? PEOPLE_TABLES[target.table] : undefined;
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
    headers(source) {
      const out: Record<string, string> = {};
      for (const name of KEPT_HEADERS) {
        const value = source[name];
        if (value !== undefined) out[name] = text(value);
      }
      return out;
    },
  };
}
