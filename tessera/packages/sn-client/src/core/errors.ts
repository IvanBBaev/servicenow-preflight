// Vendored from github.com/IvanBBaev/servicenow-mcp @ 5acdcc7 (src/core/errors.ts).
// MIT upstream; vendored by the sole author/copyright owner (ADR-002).
// Adaptation: upstream's `JiraError` subclass is removed — the Jira client it
// served (src/core/jira/**, src/api/jira/**) was never vendored, so nothing
// here could throw it (Jira excision completed 2026-09-23, delegated decision;
// see VENDORED.md).

/**
 * Error thrown when a ServiceNow request fails — either before it leaves the
 * client (bad host, missing credentials, policy denial) or because the API
 * returned a non-2xx response. `status` is the HTTP status when known and
 * `detail` is the parsed ServiceNow error body, so callers can react
 * differently to 401 vs 403 vs 429.
 */
export class ServiceNowError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ServiceNowError";
  }
}

/**
 * True when `res` is a redirect that was NOT followed: a 3xx under
 * `redirect: "manual"` in Node, or the status-0 `opaqueredirect` a browser-style
 * fetch hands back instead.
 */
export function isRedirect(res: Response): boolean {
  return (
    res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)
  );
}

/**
 * Delegated decision 2026-09-25: a redirect from ServiceNow (API or token
 * endpoint) is an error, never followed. Following it would replay the auth
 * headers, the write body or the OAuth client secret to a host that never
 * passed the SSRF/allowlist check. The `Location` value is deliberately left
 * out of the message and the error: it is attacker-influenced text, and the
 * operator's fix is to point SN_INSTANCE at the serving host, not to chase it.
 */
export function redirectError(what: string, res: Response): ServiceNowError {
  const shown = res.status === 0 ? "opaque redirect" : String(res.status);
  return new ServiceNowError(
    `${what} was answered with a redirect (${shown}); redirects are never followed, so credentials and payloads are not replayed to another host. Point SN_INSTANCE at the host that serves the API.`,
    res.status,
  );
}
