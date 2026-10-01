// Vendored from github.com/IvanBBaev/servicenow-mcp @ 5acdcc7 (src/core/policy.ts).
// MIT upstream; vendored by the sole author/copyright owner (ADR-002).
//
// DEV-24 — precedence in Tessera. This env-driven gate is *defense in depth*,
// not the product's plan/apply gate: Tessera decides whether a run may write in
// @tessera/core's configuration (ARCH-12). The two compose as follows:
//
//   1. `SN_READONLY` (and its per-profile override) is checked at the transport
//      boundary in http.ts, so it holds even for callers that bypass the api
//      layer. It can only ever *remove* permission.
//   2. A denial surfaces as an explicit 403 ServiceNowError — never a silent
//      skip, never a "passed" verdict — so a run configured to apply changes
//      against a read-only environment fails loudly instead of reporting green.
//
// In short: core config may refuse a write the environment allows; the
// environment may refuse a write core config allows. Whichever refuses, wins.

import { ServiceNowError } from "./errors.js";
import { logger } from "./logging.js";
import { activeProfile } from "./config.js";
import { getDeniedPackages, getReadOnlyPackages } from "./settings.js";

/**
 * Discoverability hint appended to every policy-denial message so a model or
 * human knows where the active policy is surfaced (UX review §6 / §11).
 */
const POLICY_HINT = " Run servicenow_get_status to see the active policy.";

/**
 * Access policy for ServiceNow tables and operations, configured via env:
 *
 * - `SN_TABLES_ALLOW`  comma-separated allowlist; when set, only these tables
 *                      are reachable.
 * - `SN_TABLES_DENY`   comma-separated denylist; always wins over the allowlist.
 * - `SN_READONLY`      unless unset/blank or 0/false/no/off, every write
 *                      (create/update/delete) is refused (fail closed).
 *
 * Per-profile overrides (MI-2): `SN_PROFILE_<NAME>_READONLY` / `_TABLES_ALLOW`
 * / `_TABLES_DENY` apply when that profile is active and fall back to the
 * global keys — the real-world setup "prod is read-only, dev has full rights"
 * in one server.
 *
 * Enforced in the client layer so all tool and resource paths share one guard.
 */

/**
 * Read a policy env var: the profile's override first, then the global key.
 *
 * DEV-24 adaptation — an *empty* scoped value is treated as unset and falls
 * through to the global key, exactly as `authEnv()` already does for the auth
 * keys. Upstream returned the empty string, which silently disabled a global
 * `SN_READONLY=1` for that profile: a blank line in an env template would have
 * handed a run write access nobody granted. A policy env var must only ever be
 * able to remove permission, so the fail-closed reading is the correct one.
 */
function policyValue(
  suffix: string,
  profile: string = activeProfile(),
): string | undefined {
  if (profile !== "default") {
    const scoped = process.env[`SN_PROFILE_${profile.toUpperCase()}_${suffix}`];
    if (scoped !== undefined && scoped.trim() !== "") return scoped;
  }
  return process.env[`SN_${suffix}`];
}

function list(suffix: string, profile?: string): string[] {
  return (policyValue(suffix, profile) ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function getAllowedTables(profile?: string): string[] {
  return list("TABLES_ALLOW", profile);
}

export function getDeniedTables(profile?: string): string[] {
  return list("TABLES_DENY", profile);
}

/**
 * The only spellings of `SN_READONLY` (and its per-profile override) that keep
 * writes ON. Lower-case; the value is trimmed and lower-cased before lookup.
 */
const WRITABLE_SPELLINGS: ReadonlySet<string> = new Set([
  "0",
  "false",
  "no",
  "off",
]);

/**
 * Delegated decision 2026-09-26: `SN_READONLY` fails CLOSED. Unset, empty or
 * whitespace-only, and `0`/`false`/`no`/`off` (case-insensitive, trimmed) mean
 * writable; ANY other value means read-only. Upstream recognised only
 * 1/true/yes/on as read-only, so `SN_READONLY=y`, `=enabled` or `=2` — an
 * operator clearly asking for read-only — silently left writes on. The key can
 * only ever remove permission, so an unrecognised value is read as the removal
 * the operator most plausibly meant; a typo now costs a refused write, never an
 * unintended one.
 *
 * The other policy keys in this file (`SN_TABLES_ALLOW` / `SN_TABLES_DENY` and
 * their per-profile overrides) are name lists, not booleans, so there is no
 * truthy spelling to misread there: an unrecognised table name is simply a
 * table, and the empty-override case is already fail-closed in
 * {@link policyValue}. They need no change under this decision.
 */
export function isReadOnly(profile?: string): boolean {
  const raw = (policyValue("READONLY", profile) ?? "").trim().toLowerCase();
  if (raw === "") return false;
  return !WRITABLE_SPELLINGS.has(raw);
}

/** Throw a 403-style ServiceNowError when the table is not permitted. */
export function assertTableAllowed(table: string): void {
  const t = table.trim().toLowerCase();
  if (getDeniedTables().includes(t)) {
    throw new ServiceNowError(
      `Access to table "${table}" is denied by SN_TABLES_DENY.${POLICY_HINT}`,
      403,
    );
  }
  const allowed = getAllowedTables();
  if (allowed.length > 0 && !allowed.includes(t)) {
    throw new ServiceNowError(
      `Access to table "${table}" is not permitted by SN_TABLES_ALLOW.${POLICY_HINT}`,
      403,
    );
  }
}

/**
 * Tables Tessera itself never writes, whatever the environment says
 * (ADR-007 C6; delegated decision 2026-09-23). `sys_user_has_role` is the
 * role-grant table: were it writable, the client could grant itself the role
 * that authorises its own writes — the same shape as a model authorising its
 * own write. The grant is a human runbook step; Tessera may READ the table to
 * verify membership, never write it.
 *
 * Deliberately a built-in constant, not an env var: an operator-configurable
 * denylist is one the operator (or a blank line in a template) can empty.
 * Consequently no `SN_TABLES_ALLOW` entry can re-admit a write to these tables.
 * A divergence from upstream servicenow-mcp — see VENDORED.md. Names are
 * lower-case; the check normalises the same way the allow/deny lists do.
 */
export const NEVER_WRITE_TABLES: readonly string[] = Object.freeze([
  "sys_user_has_role",
]);

/**
 * Throw a 403-style ServiceNowError when a write targets a built-in
 * never-write table ({@link NEVER_WRITE_TABLES}). Applied to Table/Import API
 * writes at the transport (http.ts), BEFORE the operator's allow/deny lists, so
 * it holds for every caller and cannot be widened by `SN_TABLES_ALLOW`.
 * Reads are not affected.
 */
export function assertTableWritable(table: string, operation: string): void {
  const t = table.trim().toLowerCase();
  if (NEVER_WRITE_TABLES.includes(t)) {
    throw new ServiceNowError(
      `Table "${table}" is on Tessera's built-in never-write list (ADR-007 C6); "${operation}" is not permitted. ` +
        "Role grants are a human step; SN_TABLES_ALLOW cannot re-admit this table.",
      403,
    );
  }
}

/**
 * The table gate for a write whose path names no table.
 *
 * A table allowlist cannot be *extended* to such a path — there is no table to
 * match — so the two policy axes are answered on their own terms:
 *
 * - `SN_TABLES_ALLOW` is a positive containment claim: "only these tables are
 *   reachable". A write that reaches no nameable table cannot be shown to
 *   satisfy it, so it is refused. This is the fail-closed reading already
 *   ratified above: a policy env var must only ever be able to remove
 *   permission, and letting an unclassifiable write through would let setting
 *   an allowlist *widen* what a caller can do relative to the claim it makes.
 * - `SN_TABLES_DENY` is a negative claim about named tables; an unclassifiable
 *   path is not one of them, so the write proceeds. It is warned about instead,
 *   because the failure this guards against is an operator believing a table
 *   policy covers a surface it structurally cannot cover. Silence there is the
 *   defect; refusing outright would be inventing a denial the operator never
 *   wrote.
 *
 * Consequence, ratified as delegated decision 2026-09-23 (option a — keep the
 * behaviour, document it): with `SN_TABLES_ALLOW` set, the CI/CD ATF run POST
 * (`atf.ts` `runAtfSuite` / `runAtfTest`, and so the runner-atf and phase05
 * paths built on it) is refused with this 403. A run needing ATF must leave
 * `SN_TABLES_ALLOW` unset and constrain tables with `SN_TABLES_DENY` instead.
 *
 * With no table policy configured there is no claim to violate, and nothing is
 * said. The warning names only the method and path — never the query string,
 * which can carry personal data (see `logging.ts`).
 */
export function assertUnclassifiedWriteAllowed(operation: string): void {
  if (getAllowedTables().length > 0) {
    throw new ServiceNowError(
      `"${operation}" does not target a table, so it cannot be permitted by SN_TABLES_ALLOW.${POLICY_HINT}`,
      403,
    );
  }
  if (getDeniedTables().length > 0) {
    logger.warn(
      "table policy does not cover this write: the path names no table, so SN_TABLES_DENY cannot apply to it",
      { operation },
    );
  }
}

/** Throw a 403-style ServiceNowError when the server is in read-only mode. */
export function assertWriteAllowed(operation: string): void {
  if (isReadOnly()) {
    throw new ServiceNowError(
      `Server is in read-only mode (SN_READONLY); "${operation}" is not permitted.${POLICY_HINT}`,
      403,
    );
  }
}

/**
 * Throw when a tool package is denied via SN_PACKAGES_DENY. Mirrors the
 * registry's package gate so a path that reaches a package's REST surface
 * outside the normal tool registration (the Batch API) cannot bypass the deny.
 */
export function assertPackageAllowed(pkg: string): void {
  if (getDeniedPackages().includes(pkg)) {
    throw new ServiceNowError(
      `Access to package "${pkg}" is denied by SN_PACKAGES_DENY.${POLICY_HINT}`,
      403,
    );
  }
}

/**
 * Throw when a write targets a package made read-only via SN_PACKAGES_READONLY.
 * The package axis only removes write tools at registration time; this enforces
 * the same rule on the Batch API, whose sub-requests skip that registration.
 */
export function assertPackageWriteAllowed(
  pkg: string,
  operation: string,
): void {
  if (getReadOnlyPackages().includes(pkg)) {
    throw new ServiceNowError(
      `Package "${pkg}" is read-only (SN_PACKAGES_READONLY); "${operation}" is not permitted.${POLICY_HINT}`,
      403,
    );
  }
}
