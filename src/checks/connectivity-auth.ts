import type { Check, CheckResult } from "../types.js";
import { SnAuthError, SnHttpError, SnNetworkError } from "../http/client.js";

const NAME = "connectivity-auth";

/**
 * Verifies the instance is reachable and the supplied credentials authenticate
 * with a cheap authenticated Table API ping (`sys_user` limited to one row).
 *
 * Outcome mapping:
 * - no auth and no client cert   -> warn (nothing to authenticate with)
 * - success                      -> pass (reachable and authenticated)
 * - 403 (insufficient rights)    -> warn (reachable, but the account is degraded)
 * - 401 / missing credentials    -> fail (authentication failed)
 * - network / DNS / timeout      -> fail (instance unreachable)
 * - any other non-2xx status     -> fail (unexpected API error)
 *
 * The check NEVER throws — every error surface from `ctx.http` is caught and
 * mapped to a well-formed {@link CheckResult}.
 */
export const connectivityAuth: Check = {
  name: NAME,
  description:
    "The target instance is reachable and the credentials authenticate.",
  async run(ctx): Promise<CheckResult> {
    // A mutual-TLS client cert can identify the caller on its own, so only warn
    // when neither a header credential nor a client cert is configured.
    if (!ctx.auth && !ctx.tls) {
      return {
        name: NAME,
        status: "warn",
        message:
          "No credentials configured; cannot verify authentication (set SNPF_USER/SNPF_PASS, SNPF_TOKEN, SNPF_API_KEY, an OAuth grant, or SNPF_MTLS_CERT/KEY).",
      };
    }

    try {
      await ctx.http.table("sys_user").query({ sysparm_limit: "1" });
      return {
        name: NAME,
        status: "pass",
        message: "Instance is reachable and the credentials authenticate.",
      };
    } catch (err) {
      if (err instanceof SnAuthError) {
        // 403: reachable and authenticated, but the account lacks rights to
        // read sys_user — degraded, not fatal.
        if (err.status === 403) {
          return {
            name: NAME,
            status: "warn",
            message:
              "Reachable, but the account has insufficient rights (HTTP 403).",
          };
        }
        // 401 or missing credentials: authentication failed.
        return {
          name: NAME,
          status: "fail",
          message: `Authentication failed${
            err.status ? ` (HTTP ${err.status})` : ""
          }: check the configured credentials.`,
        };
      }

      if (err instanceof SnNetworkError) {
        return {
          name: NAME,
          status: "fail",
          message: `Instance unreachable: ${err.message}`,
        };
      }

      if (err instanceof SnHttpError) {
        return {
          name: NAME,
          status: "fail",
          message: `Unexpected API error (HTTP ${err.status}) while verifying connectivity.`,
        };
      }

      const detail = err instanceof Error ? err.message : String(err);
      return {
        name: NAME,
        status: "fail",
        message: `Connectivity check failed unexpectedly: ${detail}`,
      };
    }
  },
};
