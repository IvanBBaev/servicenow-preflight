import type { Check, CheckResult, CheckStatus } from "../types.js";
import { SnAuthError, SnHttpError, SnNetworkError } from "../http/client.js";
import { compareVersions } from "../versions.js";

const NAME = "scoped-app-deps";

/**
 * A single declared dependency the scoped application requires on the target
 * instance. Supplied via `ctx.options.requiredApps`.
 */
interface RequiredApp {
  /**
   * Identifier of the required plugin / scoped app. Matched against the common
   * identity fields of `sys_store_app` / `sys_app` (`scope`, `source`, `name`,
   * `sys_id`) and `sys_plugins` (`id`, `source`, `name`, `sys_id`).
   */
  id: string;
  /** Optional minimum acceptable version (dot-separated, e.g. `"2.1.0"`). */
  minVersion?: string;
}

/** Outcome of resolving one {@link RequiredApp} against the instance. */
type ResolutionStatus =
  | "satisfied"
  | "missing"
  | "inactive"
  | "outdated"
  | "unknown-version"
  | "unparseable-version";

interface Resolution {
  id: string;
  status: ResolutionStatus;
  detail: string;
}

/** The identity fields we try, in order, when matching a required id to a row. */
const STORE_ID_FIELDS = ["scope", "source", "name", "sys_id"] as const;
const PLUGIN_ID_FIELDS = ["id", "source", "name", "sys_id"] as const;

/** Read a row field as a trimmed string, or `undefined` when absent/blank. */
function str(row: Record<string, unknown>, field: string): string | undefined {
  const value = row[field];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** True when `row` identifies as `id` on any of the given identity `fields`. */
function rowMatchesId(
  row: Record<string, unknown>,
  fields: readonly string[],
  id: string,
): boolean {
  const wanted = id.toLowerCase();
  for (const field of fields) {
    const value = str(row, field);
    if (value !== undefined && value.toLowerCase() === wanted) return true;
  }
  return false;
}

/**
 * ServiceNow's `active` flag is a boolean field surfaced as the string
 * `"true"` / `"false"`. An UNSPECIFIED flag — an empty string, an explicit
 * `null`, or a table with no `active` column at all (e.g. `sys_store_app`) — is
 * treated as active, so all three "not disabled" shapes read consistently
 * (CC-44). Only an explicit non-empty non-`"true"` value (`"false"`) is inactive.
 */
function isActive(row: Record<string, unknown>): boolean {
  const value = row.active;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "" || v === "true";
  }
  // Absent (undefined) or explicitly null: unspecified → active.
  return true;
}

/**
 * The row's INSTALLED version. Only the `version` column counts — never
 * `latest_version` (the store's newest available), which would let an
 * uninstalled/empty version borrow the store's number and falsely satisfy a
 * minimum (SN-5). An empty installed version therefore reads as unknown.
 */
function rowVersion(row: Record<string, unknown>): string | undefined {
  return str(row, "version");
}

// `parseVersion` / `compareVersions` were extracted verbatim to
// `src/versions.ts` (CC-43) so the sync/drift promote gate (OPP-1/OPP-5)
// compares versions with exactly the same semantics as this check.

/**
 * Resolve one required app against the fetched scoped-app rows (`sys_store_app`
 * + `sys_app`) and plugin rows (`sys_plugins`).
 */
function resolveApp(
  req: RequiredApp,
  scopedRows: Record<string, unknown>[],
  pluginRows: Record<string, unknown>[],
): Resolution {
  const scopedMatch = scopedRows.find((r) =>
    rowMatchesId(r, STORE_ID_FIELDS, req.id),
  );
  const pluginMatch = pluginRows.find((r) =>
    rowMatchesId(r, PLUGIN_ID_FIELDS, req.id),
  );
  const match = scopedMatch ?? pluginMatch;

  if (!match) {
    return { id: req.id, status: "missing", detail: "not installed" };
  }

  if (!isActive(match)) {
    return { id: req.id, status: "inactive", detail: "installed but inactive" };
  }

  if (req.minVersion === undefined) {
    return { id: req.id, status: "satisfied", detail: "present and active" };
  }

  const version = rowVersion(match);
  if (version === undefined) {
    return {
      id: req.id,
      status: "unknown-version",
      detail: `present, but the installed version is unknown (need >= ${req.minVersion})`,
    };
  }

  const order = compareVersions(version, req.minVersion);
  if (order === null) {
    return {
      id: req.id,
      status: "unparseable-version",
      detail: `version "${version}" cannot be compared to the required "${req.minVersion}" (non-numeric segment)`,
    };
  }

  if (order < 0) {
    return {
      id: req.id,
      status: "outdated",
      detail: `version ${version} is below the required ${req.minVersion}`,
    };
  }

  return {
    id: req.id,
    status: "satisfied",
    detail: `version ${version} satisfies >= ${req.minVersion}`,
  };
}

/**
 * Parse and validate `ctx.options.requiredApps` into a clean list. Entries that
 * are not `{ id: string, minVersion?: string }` are dropped (they surface as a
 * warn via `invalid` count, never a silent pass).
 */
function parseRequiredApps(raw: unknown): {
  apps: RequiredApp[];
  invalid: number;
  malformed: boolean;
} {
  // Nothing declared and declared-with-the-wrong-shape are different mistakes.
  // Collapsing them answers a misconfigured `requiredApps` with "none declared",
  // which reads as confirmation that there was nothing to verify — when in fact
  // the dependencies the caller asked about went unchecked.
  if (raw === undefined || raw === null) {
    return { apps: [], invalid: 0, malformed: false };
  }
  if (!Array.isArray(raw)) return { apps: [], invalid: 0, malformed: true };
  const apps: RequiredApp[] = [];
  let invalid = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      invalid++;
      continue;
    }
    const o = entry as { id?: unknown; minVersion?: unknown };
    if (typeof o.id !== "string" || o.id.trim() === "") {
      invalid++;
      continue;
    }
    const app: RequiredApp = { id: o.id.trim() };
    if (typeof o.minVersion === "string" && o.minVersion.trim() !== "") {
      app.minVersion = o.minVersion.trim();
    }
    apps.push(app);
  }
  return { apps, invalid, malformed: false };
}

function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Verifies the scoped application's declared dependencies (plugins / other
 * scoped apps) are present, active, and at or above their required version on
 * the target instance.
 *
 * Dependencies are declared via `ctx.options.requiredApps`, a list of
 * `{ id, minVersion? }`. Each id is looked up across `sys_store_app` (store
 * apps), `sys_app` (custom/scoped apps) and `sys_plugins` (platform plugins).
 *
 * - **fail** — a required app is missing, installed-but-inactive, below its
 *   `minVersion`, or carries a version that cannot be parsed/compared.
 * - **warn** — no requirements were declared, some entries were malformed, or a
 *   dependency is present but its installed version cannot be verified.
 * - **pass** — every declared dependency is present, active, and up to date.
 *
 * Never throws: `SnAuthError` / `SnNetworkError` map to `fail`, other transport
 * errors map to `warn`.
 */
export const scopedAppDeps: Check = {
  name: NAME,
  description:
    "The scoped application's dependencies are present on the target instance.",
  async run(ctx): Promise<CheckResult> {
    const { apps, invalid, malformed } = parseRequiredApps(
      ctx.options?.requiredApps,
    );

    if (malformed) {
      return result(
        "warn",
        `options.requiredApps must be an array of { id, minVersion? } objects, but a ${typeof ctx
          .options?.requiredApps} was supplied; no dependency was verified.`,
      );
    }

    if (apps.length === 0) {
      return result(
        "warn",
        invalid > 0
          ? `No valid required apps declared (${invalid} malformed entr${
              invalid === 1 ? "y" : "ies"
            } ignored); nothing to verify.`
          : "No required apps declared (set options.requiredApps to verify dependencies); skipping.",
      );
    }

    let storeRows: Record<string, unknown>[];
    let appRows: Record<string, unknown>[];
    let pluginRows: Record<string, unknown>[];
    try {
      // Fetch active plugins plus installed store apps and scoped apps in
      // parallel. `sys_app` (custom/scoped apps on this instance) is part of the
      // lookup union so a dependency shipped as a scoped app — not a store app —
      // still resolves (SN-5). Store/scoped apps are read unfiltered so an
      // inactive one is reported as inactive rather than silently missing.
      [pluginRows, storeRows, appRows] = await Promise.all([
        ctx.http.table("sys_plugins").query({ sysparm_query: "active=true" }),
        ctx.http.table("sys_store_app").query(),
        ctx.http.table("sys_app").query(),
      ]);
    } catch (err) {
      if (err instanceof SnAuthError) {
        return result(
          "fail",
          "Authentication failed while reading sys_plugins / sys_store_app; cannot verify dependencies.",
        );
      }
      if (err instanceof SnNetworkError) {
        return result(
          "fail",
          `Could not reach the instance to verify dependencies: ${err.message}`,
        );
      }
      if (err instanceof SnHttpError) {
        // The tables may be unavailable (e.g. store not activated) — advisory.
        return result(
          "warn",
          `Could not read dependency tables (HTTP ${err.status}); dependencies are unverified.`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return result(
        "warn",
        `Unexpected error while verifying dependencies: ${message}`,
      );
    }

    const scopedRows = [...storeRows, ...appRows];
    const resolutions = apps.map((app) =>
      resolveApp(app, scopedRows, pluginRows),
    );

    const hardFailures = resolutions.filter(
      (r) =>
        r.status === "missing" ||
        r.status === "inactive" ||
        r.status === "outdated" ||
        r.status === "unparseable-version",
    );
    const advisory = resolutions.filter((r) => r.status === "unknown-version");

    if (hardFailures.length > 0) {
      const detail = hardFailures
        .map((r) => `${r.id} (${r.detail})`)
        .join("; ");
      return result(
        "fail",
        `${hardFailures.length} of ${apps.length} required app(s) not satisfied: ${detail}.`,
      );
    }

    if (advisory.length > 0 || invalid > 0) {
      const parts: string[] = [];
      if (advisory.length > 0) {
        parts.push(advisory.map((r) => `${r.id} (${r.detail})`).join("; "));
      }
      if (invalid > 0) {
        parts.push(
          `${invalid} malformed requiredApps entr${
            invalid === 1 ? "y" : "ies"
          } ignored`,
        );
      }
      return result(
        "warn",
        `All required apps present, but with advisories: ${parts.join("; ")}.`,
      );
    }

    return result(
      "pass",
      `All ${apps.length} required app(s) present, active, and up to date.`,
    );
  },
};
