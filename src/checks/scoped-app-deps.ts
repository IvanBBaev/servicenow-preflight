import type { Check, CheckResult, CheckStatus } from "../types.js";
import { SnAuthError, SnHttpError, SnNetworkError } from "../http/client.js";

const NAME = "scoped-app-deps";

/**
 * A single declared dependency the scoped application requires on the target
 * instance. Supplied via `ctx.options.requiredApps`.
 */
interface RequiredApp {
  /**
   * Identifier of the required plugin / scoped app. Matched against the common
   * identity fields of `sys_store_app` (`scope`, `source`, `name`, `sys_id`)
   * and `sys_plugins` (`id`, `source`, `name`, `sys_id`).
   */
  id: string;
  /** Optional minimum acceptable version (dot-separated, e.g. `"2.1.0"`). */
  minVersion?: string;
}

/** Outcome of resolving one {@link RequiredApp} against the instance. */
type ResolutionStatus =
  "satisfied" | "missing" | "inactive" | "outdated" | "unknown-version";

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

/** ServiceNow `active` flag is stored as the string `"true"` / `"false"`. */
function isActive(row: Record<string, unknown>): boolean {
  const value = row.active;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  // No `active` column at all (e.g. sys_store_app) — treat as active.
  return value === undefined;
}

/** Pull a version string from the row, trying the common version columns. */
function rowVersion(row: Record<string, unknown>): string | undefined {
  return str(row, "version") ?? str(row, "latest_version");
}

/**
 * Compare two dot-separated versions numerically. Returns a negative number
 * when `a < b`, zero when equal, positive when `a > b`. Non-numeric segments
 * compare as 0, so this is a best-effort semantic-ish comparison.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10);
    const nb = Number.parseInt(pb[i] ?? "0", 10);
    const va = Number.isNaN(na) ? 0 : na;
    const vb = Number.isNaN(nb) ? 0 : nb;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** Resolve one required app against the fetched store-app / plugin rows. */
function resolveApp(
  req: RequiredApp,
  storeRows: Record<string, unknown>[],
  pluginRows: Record<string, unknown>[],
): Resolution {
  const storeMatch = storeRows.find((r) =>
    rowMatchesId(r, STORE_ID_FIELDS, req.id),
  );
  const pluginMatch = pluginRows.find((r) =>
    rowMatchesId(r, PLUGIN_ID_FIELDS, req.id),
  );
  const match = storeMatch ?? pluginMatch;

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
      detail: `present, but version is unknown (need >= ${req.minVersion})`,
    };
  }

  if (compareVersions(version, req.minVersion) < 0) {
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
} {
  if (!Array.isArray(raw)) return { apps: [], invalid: 0 };
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
  return { apps, invalid };
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
 * `{ id, minVersion? }`. Each id is looked up in `sys_store_app` (scoped apps)
 * and `sys_plugins` (platform plugins).
 *
 * - **fail** — a required app is missing, installed-but-inactive, or below its
 *   `minVersion`.
 * - **warn** — no requirements were declared, some entries were malformed, or a
 *   dependency is present but its version cannot be verified.
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
    const { apps, invalid } = parseRequiredApps(ctx.options?.requiredApps);

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

    let storeRows: Record<string, unknown>[] = [];
    let pluginRows: Record<string, unknown>[] = [];
    try {
      // Fetch active plugins and installed store apps in parallel.
      [pluginRows, storeRows] = await Promise.all([
        ctx.http.table("sys_plugins").query({ sysparm_query: "active=true" }),
        ctx.http.table("sys_store_app").query(),
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

    const resolutions = apps.map((app) =>
      resolveApp(app, storeRows, pluginRows),
    );

    const hardFailures = resolutions.filter(
      (r) =>
        r.status === "missing" ||
        r.status === "inactive" ||
        r.status === "outdated",
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
