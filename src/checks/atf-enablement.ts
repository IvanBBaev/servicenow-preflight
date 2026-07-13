import type { Check, CheckResult, CheckStatus } from "../types.js";
import { SnAuthError, SnHttpError, SnNetworkError } from "../http/client.js";
import { and, eq } from "../http/query.js";
import { resolveSuiteIds } from "./atf-run.js";

const NAME = "atf-enablement";

/** Table that holds instance system properties. */
const PROPERTY_TABLE = "sys_properties";

/**
 * The system property that gates ATF execution instance-wide ("Enable test /
 * test suite execution"). When it is not `true`, the ATF runner refuses every
 * run — so `atf-run` would burn its whole poll budget (CC-32) waiting on a
 * suite that can never start. Verifying it up front is the point of this
 * check (OPP-2).
 */
const RUNNER_ENABLED_PROPERTY = "sn_atf.runner.enabled";

/**
 * Table that holds one row per registered ATF client test runner session.
 * Chosen because `sys_atf_agent` is the table behind "Automated Test Framework
 * > Administration > Client Test Runners": every browser session that
 * registers as a client test runner writes a row here, `type` distinguishes a
 * `scheduled` (unattended, CI-suitable) runner from a `manual` one, and a live
 * session heart-beats `status=online` while stale sessions remain as
 * `status=offline` rows. Filtering on both fields is what separates "a runner
 * is available right now" from "a runner existed at some point" (OPP-2).
 */
const AGENT_TABLE = "sys_atf_agent";

/** `sys_atf_agent.type` of an unattended (scheduled) client test runner. */
const AGENT_TYPE_SCHEDULED = "scheduled";

/** `sys_atf_agent.status` of a live, currently-connected runner session. */
const AGENT_STATUS_ONLINE = "online";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** Read a string-ish field from an arbitrary record, trimmed; "" when absent. */
function str(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // ServiceNow reference fields may arrive as { value, link, display_value }.
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner.trim();
  }
  return "";
}

/** Parsed shape of the per-check `ctx.options.atfEnablement` option. */
interface AtfEnablementOptions {
  /** `true` when at least one online scheduled client test runner is required. */
  requireClientTestRunner: boolean;
  /** Count of malformed option shapes encountered (surfaced as a warn). */
  malformed: number;
}

/**
 * Parse and validate `ctx.options.atfEnablement`
 * (`{ requireClientTestRunner?: boolean }`). Mirrors how `scoped-app-deps`
 * treats malformed `requiredApps` entries: a malformed value is dropped but
 * counted, so it surfaces as a warn rather than being silently ignored — and
 * never silently *enables* a gate the caller did not clearly ask for.
 */
function parseAtfEnablementOptions(raw: unknown): AtfEnablementOptions {
  if (raw === undefined) {
    return { requireClientTestRunner: false, malformed: 0 };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { requireClientTestRunner: false, malformed: 1 };
  }
  const value = (raw as { requireClientTestRunner?: unknown })
    .requireClientTestRunner;
  if (value === undefined) {
    // An empty object is valid configuration: the gate is simply not required.
    return { requireClientTestRunner: false, malformed: 0 };
  }
  if (typeof value !== "boolean") {
    return { requireClientTestRunner: false, malformed: 1 };
  }
  return { requireClientTestRunner: value, malformed: 0 };
}

/** The warn note appended when the option shape could not be parsed. */
const MALFORMED_NOTE =
  "options.atfEnablement is malformed (expected { requireClientTestRunner?: boolean }) and was ignored";

/**
 * Verifies ATF is actually enabled on the target instance BEFORE a run is
 * triggered, so a disabled runner is caught immediately instead of `atf-run`
 * burning its whole poll budget (CC-32) on a suite that can never start
 * (OPP-2). Reads the `sn_atf.runner.enabled` system property, and — only when
 * `ctx.options.atfEnablement.requireClientTestRunner` is `true` — additionally
 * requires at least one online *scheduled* client test runner
 * (`sys_atf_agent`, needed by browser/UI tests).
 *
 * - **fail** — the property is explicitly `"false"` (or any non-`"true"`
 *   value, which the platform evaluates as false) *and* an ATF suite is
 *   configured for this run (so `atf-run` will actually try to execute), or the
 *   client-runner gate is required and zero scheduled runners are online.
 * - **warn** — no credentials are configured (nothing to authenticate the
 *   reads with — `connectivity-auth` already names the fix, so an unconfigured
 *   run is not failed twice), the property row is not visible (possible ACL
 *   restriction — enablement is explicitly unverified), the property is
 *   non-`"true"` but no ATF suite is configured for the run (nothing to gate —
 *   advisory, matching how `atf-run` warn-skips), the runner table is
 *   security-trimmed, or `options.atfEnablement` is malformed.
 * - **pass** — the property is `"true"` (and, when required, at least one
 *   scheduled client test runner is online — mentioned in the message).
 *
 * Never throws: `SnAuthError` / `SnNetworkError` map to `fail`, other
 * transport errors map to `warn` (explicitly unverified).
 */
export const atfEnablement: Check = {
  name: NAME,
  description: "ATF test execution is enabled on the target instance.",
  async run(ctx): Promise<CheckResult> {
    // With nothing to authenticate as, the reads below can only fail at the
    // transport layer — a configuration gap, not an instance problem. Warn and
    // skip (mirroring connectivity-auth, which names the fix) so an
    // unconfigured default run is not turned into a hard fail.
    if (!ctx.auth && !ctx.tls) {
      return result(
        "warn",
        "No credentials configured; cannot verify ATF enablement (set SNPF_USER/SNPF_PASS, SNPF_TOKEN, SNPF_API_KEY, an OAuth grant, or SNPF_MTLS_CERT/KEY).",
      );
    }

    const { requireClientTestRunner, malformed } = parseAtfEnablementOptions(
      ctx.options?.atfEnablement,
    );

    try {
      // Every query part goes through the validated builder (SR-1) — even the
      // constant property name — so no raw value ever reaches sysparm_query.
      const properties = await ctx.http.table(PROPERTY_TABLE).queryWithMeta({
        sysparm_query: eq("name", RUNNER_ENABLED_PROPERTY),
        sysparm_fields: "sys_id,name,value",
      });

      if (properties.rows.length === 0) {
        // Zero visible rows is not proof the property is absent: sys_properties
        // may be ACL-trimmed for a least-privilege CI account (OPP-2). Either
        // way enablement is unverified — never a pass, never a false fail.
        if (properties.securityTrimmed) {
          return result(
            "warn",
            `Cannot verify ATF enablement: ${
              properties.totalCount ?? "some"
            } ${PROPERTY_TABLE} row(s) match "${RUNNER_ENABLED_PROPERTY}" but 0 are visible — the account is security-trimmed. ATF enablement is unverified; grant the CI account read access to ${PROPERTY_TABLE}.`,
          );
        }
        return result(
          "warn",
          `Cannot verify ATF enablement: the "${RUNNER_ENABLED_PROPERTY}" property is not visible (not set, or ${PROPERTY_TABLE} is ACL-restricted for this account). ATF enablement is unverified.`,
        );
      }

      // Property names are unique per instance; the first visible row is it
      // (the `?? {}` only satisfies noUncheckedIndexedAccess — the zero-row
      // case returned above).
      const rawValue = str(properties.rows[0] ?? {}, "value");
      const value = rawValue.toLowerCase();
      if (value !== "true") {
        // The platform parses boolean properties with Boolean.parseBoolean
        // semantics: anything that is not (case-insensitively) "true" is
        // false. So an empty or garbage value disables ATF exactly like an
        // explicit "false" — fail closed on all of them (OPP-2).
        const detail =
          value === "false"
            ? `is explicitly "false"`
            : rawValue === ""
              ? "is empty, which the platform evaluates as false"
              : `is "${rawValue}", which the platform evaluates as false (only "true" enables the runner)`;
        // Only a *hard* fail when an ATF run is actually intended for this run:
        // atf-run resolves the same suite ids, and with none configured it
        // warn-skips and burns no poll budget — so a disabled runner gates
        // nothing. Failing a default preflight on instances that simply do not
        // use ATF was a false-fail; surface it as advisory instead. Configuring
        // a suite (options.atfSuites/atfSuiteId or a manifest suite) re-arms the
        // hard gate so the two checks stay in agreement (OPP-2).
        if (resolveSuiteIds(ctx).length === 0) {
          return result(
            "warn",
            `ATF test execution is disabled: "${RUNNER_ENABLED_PROPERTY}" ${detail}. No ATF suite is configured for this run (set options.atfSuites/atfSuiteId or a manifest suite), so nothing will run; enable the property before triggering an ATF run.`,
          );
        }
        return result(
          "fail",
          `ATF test execution is disabled: "${RUNNER_ENABLED_PROPERTY}" ${detail}. Enable the property (Automated Test Framework > Administration > Properties), otherwise atf-run cannot execute tests.`,
        );
      }

      let runnerNote = "";
      if (requireClientTestRunner) {
        const agents = await ctx.http.table(AGENT_TABLE).queryWithMeta({
          sysparm_query: and(
            eq("type", AGENT_TYPE_SCHEDULED),
            eq("status", AGENT_STATUS_ONLINE),
          ),
          sysparm_fields: "sys_id,type,status",
        });
        if (agents.rows.length === 0) {
          // Conservative split (OPP-2): proven trimming means the runner state
          // is unknowable for this account (warn, unverified); a clean zero
          // means no scheduled runner is online (fail — UI tests cannot run).
          if (agents.securityTrimmed) {
            return result(
              "warn",
              `ATF is enabled, but the client test runner state is unverified: ${
                agents.totalCount ?? "some"
              } ${AGENT_TABLE} row(s) match but 0 are visible — the account is security-trimmed. Grant the CI account read access to ${AGENT_TABLE}.`,
            );
          }
          return result(
            "fail",
            `ATF is enabled, but no scheduled client test runner is online (${AGENT_TABLE}: type=${AGENT_TYPE_SCHEDULED}, status=${AGENT_STATUS_ONLINE} matched 0 rows) — tests that need a browser cannot execute. Start a scheduled client test runner (Automated Test Framework > Run > Scheduled Client Test Runner) before triggering a run.`,
          );
        }
        runnerNote = ` ${agents.rows.length} scheduled client test runner(s) online.`;
      }

      if (malformed > 0) {
        return result(
          "warn",
          `ATF test execution is enabled ("${RUNNER_ENABLED_PROPERTY}" is "true"), but ${MALFORMED_NOTE}.`,
        );
      }

      return result(
        "pass",
        `ATF test execution is enabled ("${RUNNER_ENABLED_PROPERTY}" is "true").${runnerNote}`,
      );
    } catch (err) {
      if (err instanceof SnAuthError) {
        return result(
          "fail",
          `Authentication failed while reading ${PROPERTY_TABLE} / ${AGENT_TABLE}; cannot verify ATF enablement.`,
        );
      }
      if (err instanceof SnNetworkError) {
        return result(
          "fail",
          `Could not reach the instance to verify ATF enablement: ${err.message}`,
        );
      }
      if (err instanceof SnHttpError) {
        // The tables may be unavailable to this account — advisory.
        return result(
          "warn",
          `Could not read ${PROPERTY_TABLE} / ${AGENT_TABLE} (HTTP ${err.status}); ATF enablement is unverified.`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return result(
        "warn",
        `Unexpected error while verifying ATF enablement: ${message}`,
      );
    }
  },
};
