// Vendored from github.com/IvanBBaev/syncrona @ 73cae76 (packages/core/src/constants.ts,
// packages/core/src/genericUtils.ts, packages/core/src/flatLayout.ts,
// packages/core/src/snClient.ts, packages/sn-transport/src/index.ts).
// GPL-3.0 upstream; dual-licensed for this use by the sole author/copyright owner (ADR-002 option 4).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Aggregation module: the vendored fieldMap/FileUtils/manifestBuilder modules
// each needed one or two small helpers from separate upstream leaf modules.
// Rather than vendoring five whole files, the exact helpers (with their
// original explanatory comments) live here. Adaptations are noted inline and
// in VENDORED.md.

import path from "path";

/**
 * Logger shape injected into every vendored factory. Matches the subset of the
 * upstream `Logger.js` singleton the vendored code actually calls.
 * (Adaptation: upstream imported a module-level winston-backed logger.)
 */
export interface StoreLogger {
  warn(msg: string): void;
  debug?(msg: string): void;
}

// --- from packages/core/src/constants.ts ---

export const PATH_DELIMITER = `${path.delimiter}${path.delimiter}`;

// --- from packages/core/src/genericUtils.ts ---

// INJ-1: the single rule for "is this string safe to use as ONE path segment?".
// It lives in this leaf module (nothing but @syncrona/types is imported here) so
// every consumer that joins an instance-supplied name onto a local path — the
// download pipeline, `init --ci`'s packages/<scope> directories, the scope doc
// generator — shares the exact same rule without dragging a module graph along.
export const isSafePathComponent = (component: string): boolean =>
  typeof component === "string" &&
  component.length > 0 &&
  !/^\.+$/.test(component) &&
  !/[/\\]/.test(component);

// --- from packages/core/src/flatLayout.ts ---

// DX17: optional flat local layout.
//
// SyncroNow AI stores each record as a folder of field files:
//   <sourceDir>/<table>/<record>/<field>.<ext>
// New users often expect a flatter tree. Flat mode collapses the per-record
// folder into a single file per field, keeping table + record + field so the
// mapping stays LOSSLESS and reversible:
//   <sourceDir>/<table>/<record>~<field>.<ext>
//
// The separator '~' is safe on every OS filesystem and never appears in a
// ServiceNow dictionary field name, so the record name (which may contain dots
// or other characters) is everything before the LAST '~' in the stem and the
// field is everything after it. These functions are pure (path strings only).

export const FLAT_FIELD_SEPARATOR = "~";

/** True when a relative path looks flat-encoded (has a `~` in its file stem). */
export function isFlatEncoded(relPath: string): boolean {
  const file = path.basename(relPath);
  const stem = path.basename(file, path.extname(file));
  const sepIndex = stem.lastIndexOf(FLAT_FIELD_SEPARATOR);
  return sepIndex > 0 && sepIndex < stem.length - 1;
}

// --- from packages/sn-transport/src/index.ts ---

/**
 * Neutralize a user/config-supplied value before it is interpolated into a
 * ServiceNow encoded query. `^` separates query conditions, so an unescaped `^`
 * in a value lets a caller inject extra conditions and slip past a scope filter
 * (e.g. `scope=app^sys_id=...`). Replacing `^` with a space keeps the value as a
 * single condition operand. Use this for EVERY interpolated value, never on an
 * already-assembled query string. Shared here so the CLI and the MCP server
 * cannot drift on the escaping rule.
 */
export function escapeQueryValue(value: string): string {
  return value.replace(/\^/g, " ");
}

/**
 * HTTP status codes that mean "the scoped SyncroNow AI endpoint is not available
 * on this instance" (custom scope not installed, blocked by ACL, or the
 * namespace simply does not exist). Both clients use this to decide when to
 * try the next scoped prefix or fall back to the standard Table API.
 */
export const ENDPOINT_NOT_FOUND_STATUSES: readonly number[] = [400, 403, 404];

const endpointNotFoundStatusSet = new Set<number>(ENDPOINT_NOT_FOUND_STATUSES);

/** Whether the given HTTP status marks the scoped endpoint as unavailable. */
export function isEndpointNotFoundStatus(status: number): boolean {
  return endpointNotFoundStatusSet.has(status);
}

// --- from packages/core/src/snClient.ts ---

/**
 * Minimal structural view of the upstream `SNClient` class: the single method
 * the vendored manifest builder calls. Any client (including the @tessera
 * ServiceNow client or a test double) satisfying this shape works.
 * (Adaptation: upstream imported the concrete axios-backed SNClient class.)
 */
export interface SNClient {
  tableAPIGet(
    table: string,
    query: string,
    fields: string,
    limit?: number,
    offset?: number,
    // `total` (W5a #3, 2026-09-26): the X-Total-Count for the query, when the
    // client can surface it. Optional so every existing client still satisfies the
    // shape; the paged reader cross-checks it only when present.
  ): Promise<{ data: unknown; total?: number }>;
}

/**
 * (Adaptation: upstream used `axios.isAxiosError(e)` here. This vendored copy
 * checks the same `isAxiosError === true` marker structurally so the module
 * carries zero runtime dependencies; axios's own helper is that marker test on
 * a non-null object, so the two classify exactly the same errors as carrying an
 * HTTP response status. The value returned is not quite upstream's: upstream
 * handed back `e.response?.status` whatever it held, while this copy reports a
 * status that is not a number as `undefined`. The one consumer,
 * `isTableSkippableError` in manifestBuilder.ts, re-tests `typeof status ===
 * "number"` itself and so cannot observe that; a future caller trusting the
 * declared `number | undefined` would.)
 */
export function getErrorResponseStatus(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) {
    return undefined;
  }
  const marked = e as {
    isAxiosError?: unknown;
    response?: { status?: unknown };
  };
  if (marked.isAxiosError !== true) {
    return undefined;
  }
  const status = marked.response?.status;
  return typeof status === "number" ? status : undefined;
}
