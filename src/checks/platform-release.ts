import type { Check, CheckResult, CheckStatus } from "../types.js";
import { o } from "../options/dsl.js";
import { compareFamilies, releaseFamily } from "../releases.js";
import { readBuildInfo } from "../state/sync.js";
import { errorResult, triageZeroRead } from "./cert-common.js";

const NAME = "platform-release";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** Parsed `ctx.options.platform`. */
interface PlatformOptions {
  minRelease?: string;
  expect?: string;
  /** Problems with the option shape or values, phrased for a warn message. */
  notes: string[];
}

/**
 * Parse `ctx.options.platform` (`{ minRelease?: string; expect?: string }`).
 * A malformed shape or a name outside the known release families is dropped
 * and noted, so it surfaces as a warn and never silently arms a gate.
 */
function parsePlatformOptions(raw: unknown): PlatformOptions {
  const out: PlatformOptions = { notes: [] };
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    out.notes.push(
      "options.platform is malformed (expected { minRelease?: string; expect?: string }) and was ignored",
    );
    return out;
  }
  for (const key of ["minRelease", "expect"] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      out.notes.push(
        `options.platform.${key} is malformed (expected a release family name) and was ignored`,
      );
      continue;
    }
    const family = releaseFamily(value);
    if (!family) {
      out.notes.push(
        `options.platform.${key} is not a known release family and was ignored`,
      );
      continue;
    }
    out[key] = family;
  }
  return out;
}

/** The leading token of a `glide.war` value (`glide-xanadu-07-02-2024`). */
function warShort(war: string): string {
  return war.replace(/\.zip$/i, "").split(/[\s_]+/)[0] ?? "";
}

/**
 * ADD-13 — platform release awareness. Reads `glide.buildname` and
 * `glide.war` from `sys_properties` (the same read `sync` records as the
 * instance identity) and reports the release family the run targets.
 * Optional `options.platform.minRelease` gates on the oldest family the app
 * supports; `options.platform.expect` warns when the instance drifts from the
 * expected family. Messages carry only the family and the war's leading
 * token, never other property values.
 *
 * - **fail** — the instance runs a family older than `minRelease`, or the
 *   credentials were rejected.
 * - **warn** — no credentials are configured, the family differs from
 *   `expect`, `glide.buildname` is not set
 *   or not a known family, an option is malformed or names an unknown family,
 *   the read was security-trimmed or ambiguous, or the instance was not
 *   reachable.
 * - **pass** — the family is known and meets every configured expectation.
 */
export const platformRelease: Check = {
  name: NAME,
  description:
    "Reports the instance release family; fails below options.platform.minRelease and warns when it differs from options.platform.expect. Advisory.",
  optionsSchema: o.object({
    platform: o.optional(
      o.object({
        minRelease: o.optional(
          o.string({
            nonEmpty: true,
            description:
              'Oldest release family the app supports, e.g. "Xanadu"; an older instance fails.',
          }),
        ),
        expect: o.optional(
          o.string({
            nonEmpty: true,
            description:
              "Release family the instance is expected to run; a different one warns.",
          }),
        ),
      }),
    ),
  }),
  meta: {
    requires: "ALWAYS",
    severity: "advisory",
    summary:
      "The instance runs a known release family — at least options.platform.minRelease, and options.platform.expect when set.",
    tables: ["sys_properties"],
    remediation:
      "Upgrade the instance to the required release family, or target an instance that runs it; make sure glide.buildname is readable by the CI account.",
    verdicts: {
      pass: "The release family is known and meets the configured minimum and expectation.",
      warn: "The family differs from the expected one, is unset or unknown, an option is malformed, or the read was trimmed.",
      fail: "The instance runs a family older than the configured minimum.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    // Nothing to authenticate as: the read could only fail at the transport
    // layer. Warn and skip, as atf-enablement does, so an unconfigured run is
    // not failed twice (connectivity-auth already names the fix).
    if (!ctx.auth && !ctx.tls && !ctx.replay) {
      return result(
        "warn",
        "No credentials configured; cannot read the platform release (set SNPF_USER/SNPF_PASS, SNPF_TOKEN, SNPF_API_KEY, an OAuth grant, or SNPF_MTLS_CERT/KEY).",
      );
    }
    const options = parsePlatformOptions(ctx.options?.platform);
    try {
      const { buildName, war, read } = await readBuildInfo(ctx.http);
      const family = buildName ? releaseFamily(buildName) : undefined;
      const notes = [...options.notes];
      if (read.rows.length === 0) {
        const triage = triageZeroRead(read);
        if (triage === "trimmed") {
          notes.push("the sys_properties read was security-trimmed");
        } else if (triage === "ambiguous") {
          notes.push(
            "the sys_properties read returned no rows and no pre-trim count",
          );
        }
      } else if (read.securityTrimmed) {
        notes.push("the sys_properties read was security-trimmed");
      }
      const suffix = notes.length > 0 ? ` (${notes.join("; ")}.)` : "";

      if (!family) {
        return result(
          "warn",
          `glide.buildname is not set or not a known release family.${suffix}`,
        );
      }
      if (
        options.minRelease &&
        compareFamilies(family, options.minRelease) < 0
      ) {
        return result(
          "fail",
          `Instance runs ${family}; the app requires ${options.minRelease} or later.${suffix}`,
        );
      }
      if (options.expect && options.expect !== family) {
        return result(
          "warn",
          `Instance runs ${family}, expected ${options.expect}.${suffix}`,
        );
      }
      const build = war ? warShort(war) : "";
      const lead = `Instance runs ${family}${build ? ` (build ${build})` : ""}`;
      if (notes.length > 0) return result("warn", `${lead}.${suffix}`);
      return result("pass", `${lead}.`);
    } catch (err) {
      return errorResult(NAME, "the platform release", err);
    }
  },
};
