/**
 * Shared dot-separated version parsing and comparison.
 *
 * Extracted verbatim from the `scoped-app-deps` check so every consumer — the
 * dependency check and the sync/drift promote gate's app-version parity
 * (OPP-5) — compares versions with identical semantics (CC-43). Keep this
 * module dependency-free; it is pure string/number logic.
 */

/**
 * Parse a dot-separated version into numeric segments, or `null` when ANY
 * segment is non-numeric (or the string is empty). Returning `null` — rather
 * than silently coercing a non-numeric segment to 0 — lets the caller surface
 * "cannot parse" instead of a misleading comparison (CC-43).
 */
export function parseVersion(version: string): number[] | null {
  const parts = version.split(".");
  const out: number[] = [];
  for (const part of parts) {
    const segment = part.trim();
    if (!/^\d+$/.test(segment)) return null;
    out.push(Number.parseInt(segment, 10));
  }
  return out.length > 0 ? out : null;
}

/**
 * Compare two dot-separated versions numerically. Returns a negative number
 * when `a < b`, zero when equal, positive when `a > b`, or `null` when either
 * side has a non-numeric segment and cannot be compared (CC-43). Shorter
 * versions are zero-padded (`"1.2"` equals `"1.2.0"`).
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}
