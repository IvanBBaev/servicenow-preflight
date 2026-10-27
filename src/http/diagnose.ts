/**
 * Actionable hints for a refused request (F-X-10). A bare
 * `ServiceNow authentication failed (401).` does not tell a CI operator
 * whether the password is wrong, the instance restricts basic auth, or an
 * OAuth grant is misconfigured; this module is the one place that wording
 * lives. Pure: it sees only the status, the auth method's kind, the
 * instance's own (already secret-free) error text and the request path — never
 * a credential.
 */

/** How the refused request authenticated: an `SnAuth` kind, or `mtls`/`none`. */
export type AuthKind =
  | "basic"
  | "oauth"
  | "apikey"
  | "oauth-password"
  | "oauth-client"
  | "oauth-refresh"
  | "oauth-jwt"
  | "mtls"
  | "none";

export interface AuthFailure {
  status: number;
  authKind: AuthKind;
  /** `error.message` / `error.detail` from the instance's response body. */
  detail?: string;
  /** The request path, used to name the table a 403 refused. */
  path?: string;
  /** The failure came from the OAuth token endpoint, not an API call. */
  tokenEndpoint?: boolean;
}

const OAUTH_REGISTRY =
  "Check the OAuth application registry entry: client ID and secret, and that the entry allows this grant type.";
const PREFER_OAUTH =
  "Prefer OAuth (SNPF_AUTH=oauth-client and SNPF_OAUTH_CLIENT_ID/SECRET) or mutual TLS for CI accounts.";

/** Hints for a refused request, most likely cause first. Never empty. */
export function diagnoseAuthFailure(failure: AuthFailure): string[] {
  const { status, authKind, detail = "" } = failure;
  if (status === 403) return [forbiddenHint(failure.path)];
  if (failure.tokenEndpoint) return tokenEndpointHints(authKind);

  switch (authKind) {
    case "basic":
      return basicHints(detail);
    case "oauth":
      return [
        "The bearer token (SNPF_TOKEN) is expired, revoked or was issued by another instance.",
        "An OAuth grant (SNPF_OAUTH_CLIENT_ID/SECRET) refreshes its token itself; prefer it over a static token in CI.",
      ];
    case "apikey":
      return [
        "The API key (SNPF_API_KEY) is wrong or inactive, or no REST API key authentication profile and access policy covers this endpoint.",
      ];
    case "oauth-password":
    case "oauth-client":
    case "oauth-refresh":
    case "oauth-jwt":
      return [
        "The instance refused the access token even after a fresh one was requested.",
        OAUTH_REGISTRY,
        "The token's user may be locked, inactive or lack the scope this API needs.",
      ];
    case "mtls":
      return [
        "The client certificate was not accepted: check that it is trusted by the instance and mapped to an active user.",
      ];
    case "none":
      return [
        "No credentials were sent: set SNPF_USER/SNPF_PASS, SNPF_TOKEN, SNPF_API_KEY, an OAuth grant, or SNPF_MTLS_CERT/KEY.",
      ];
  }
}

function basicHints(detail: string): string[] {
  const wrong =
    "Wrong user name or password, or the account is locked or inactive.";
  const restriction =
    "The instance may restrict basic auth for API calls: the account must be allowed by the basic-auth restriction policy (for example a Web Service Access Only user).";
  if (/multi[- ]?factor|\bmfa\b|one[- ]time/i.test(detail)) {
    return [
      "The account requires multi-factor authentication, which a basic-auth API call cannot answer.",
      restriction,
      PREFER_OAUTH,
    ];
  }
  if (/basic/i.test(detail)) return [restriction, wrong, PREFER_OAUTH];
  return [wrong, restriction, PREFER_OAUTH];
}

function tokenEndpointHints(authKind: AuthKind): string[] {
  const hints = [OAUTH_REGISTRY];
  if (authKind === "oauth-password") {
    hints.push(
      "For the password grant, also check SNPF_USER/SNPF_PASS and that the user is active.",
    );
  } else if (authKind === "oauth-refresh") {
    hints.push(
      "The refresh token (SNPF_OAUTH_REFRESH_TOKEN) may be expired or revoked.",
    );
  } else if (authKind === "oauth-jwt") {
    hints.push(
      "For the JWT grant, check the JWT provider's verifier (certificate and kid) and the sub/aud/iss claims.",
    );
  }
  hints.push(
    "SNPF_OAUTH_TOKEN_URL, when set, must point at this instance's /oauth_token.do.",
  );
  return hints;
}

function forbiddenHint(path?: string): string {
  const table = path
    ? /\/api\/now\/(?:v\d+\/)?table\/([\w$]+)/.exec(path)
    : null;
  return table?.[1]
    ? `The account authenticates but lacks read access to ${table[1]} (ACL or role).`
    : "The account authenticates but is not allowed to call this endpoint (ACL or role).";
}
