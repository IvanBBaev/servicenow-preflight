import { test } from "node:test";
import assert from "node:assert/strict";

import { diagnoseAuthFailure } from "../../build/http/diagnose.js";

const KINDS = [
  "basic",
  "oauth",
  "apikey",
  "oauth-password",
  "oauth-client",
  "oauth-refresh",
  "oauth-jwt",
  "mtls",
  "none",
];

test("diagnose: basic 401 leads with credentials, then the restriction", () => {
  const hints = diagnoseAuthFailure({
    status: 401,
    authKind: "basic",
    detail: "User is not authenticated",
  });
  assert.match(hints[0], /Wrong user name or password/);
  assert.match(hints[1], /restrict basic auth/);
  assert.match(hints[2], /Prefer OAuth/);
});

test("diagnose: a body naming basic auth or MFA leads with that cause", () => {
  const basic = diagnoseAuthFailure({
    status: 401,
    authKind: "basic",
    detail: "Basic authentication is not allowed for this user",
  });
  assert.match(basic[0], /restrict basic auth/);
  const mfa = diagnoseAuthFailure({
    status: 401,
    authKind: "basic",
    detail: "Multi-factor authentication required",
  });
  assert.match(mfa[0], /multi-factor authentication/);
});

test("diagnose: bearer, API key, grant and mTLS 401s get their own hints", () => {
  assert.match(
    diagnoseAuthFailure({ status: 401, authKind: "oauth" })[0],
    /SNPF_TOKEN/,
  );
  assert.match(
    diagnoseAuthFailure({ status: 401, authKind: "apikey" })[0],
    /SNPF_API_KEY/,
  );
  assert.match(
    diagnoseAuthFailure({ status: 401, authKind: "oauth-client" })[1],
    /OAuth application registry/,
  );
  assert.match(
    diagnoseAuthFailure({ status: 401, authKind: "mtls" })[0],
    /client certificate/,
  );
  assert.match(
    diagnoseAuthFailure({ status: 401, authKind: "none" })[0],
    /No credentials/,
  );
});

test("diagnose: token-endpoint failures name the grant's own inputs", () => {
  const at = (authKind) =>
    diagnoseAuthFailure({ status: 401, authKind, tokenEndpoint: true });
  assert.match(at("oauth-client")[0], /OAuth application registry/);
  assert.ok(at("oauth-password").some((h) => /password grant/.test(h)));
  assert.ok(at("oauth-refresh").some((h) => /refresh token/.test(h)));
  assert.ok(at("oauth-jwt").some((h) => /JWT provider/.test(h)));
  assert.ok(at("oauth-client").some((h) => /SNPF_OAUTH_TOKEN_URL/.test(h)));
});

test("diagnose: a 403 names the table, or the endpoint when no table", () => {
  assert.deepEqual(
    diagnoseAuthFailure({
      status: 403,
      authKind: "basic",
      path: "/api/now/v2/table/sys_user?sysparm_limit=1",
    }),
    [
      "The account authenticates but lacks read access to sys_user (ACL or role).",
    ],
  );
  assert.match(
    diagnoseAuthFailure({
      status: 403,
      authKind: "basic",
      path: "/api/sn_cicd/app/batch",
    })[0],
    /not allowed to call this endpoint/,
  );
});

test("diagnose: every kind yields a hint and none echoes the detail", () => {
  const detail = "s3cret-value-from-body";
  for (const authKind of KINDS) {
    for (const status of [401, 403]) {
      const hints = diagnoseAuthFailure({ status, authKind, detail });
      assert.ok(hints.length > 0, `${authKind} ${status}`);
      assert.ok(!hints.join(" ").includes(detail), `${authKind} ${status}`);
    }
  }
});
