/**
 * F-X-6: the canonical key a recorded HTTP exchange is stored and matched
 * under. Two requests share a key exactly when they share the method, the path,
 * the query parameters (in any order) and the body; the instance origin is not
 * part of it, so a recording replays against any URL.
 */
import { createHash } from "node:crypto";

/** The parts of a request a recording matches on. */
export interface RequestKey {
  method: string;
  /** The URL path, still percent-encoded as sent. */
  path: string;
  /** Query parameters sorted by name; a repeated name keeps every value in order. */
  query: Record<string, string | string[]>;
  /** SHA-256 of the request body, when the request has one. */
  bodySha256?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The key of a request to `url` with `method` and an optional JSON `body`. */
export function requestKey(
  method: string,
  url: string,
  body?: string,
): RequestKey {
  const parsed = new URL(url);
  const grouped = new Map<string, string[]>();
  for (const [name, value] of parsed.searchParams) {
    const values = grouped.get(name);
    if (values) values.push(value);
    else grouped.set(name, [value]);
  }
  const query: Record<string, string | string[]> = {};
  for (const name of [...grouped.keys()].sort()) {
    const values = grouped.get(name) as string[];
    query[name] = values.length === 1 ? (values[0] as string) : values;
  }
  return {
    method: method.toUpperCase(),
    path: parsed.pathname,
    query,
    ...(body !== undefined ? { bodySha256: sha256(body) } : {}),
  };
}

/** The file name, inside a recording directory, that holds `key`'s exchange. */
export function keyFile(key: RequestKey): string {
  return `${sha256(JSON.stringify(key)).slice(0, 16)}.json`;
}

/** `GET /api/now/table/x?a=1&b=2`, shortened for an error message. */
export function describeKey(key: RequestKey, max = 200): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(key.query)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      params.append(name, v);
    }
  }
  const search = params.toString();
  const text = `${key.method} ${key.path}${search ? `?${search}` : ""}`;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
