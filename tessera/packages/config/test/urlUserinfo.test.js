// URL-userinfo detection, differentially against the WHATWG URL parser.
//
// `hasUrlUserinfo` and the `user:password@` shape in `secretValueShape` are
// hand-rolled string checks, and a hand-rolled check drifts from the parser the
// transport (and every browser/curl the operator copies from) actually uses.
// The forms below all parse WITH userinfo under WHATWG — `https:/a:b@h`,
// `https:/\a:b@h`, `//a:b@h` — and used to slip past both checks because they
// only stripped a scheme that was followed by `://`.
//
// The contract is one-directional on purpose: whenever WHATWG sees userinfo,
// the check must too. The reverse (the check refusing something WHATWG would
// not read as userinfo) is fail-closed and allowed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  REDACTED,
  formatResolvedConfig,
  hasUrlUserinfo,
  resolveConfig,
  secretValueShape,
} from "../build/index.js";

/**
 * What WHATWG reads out of a value: the parse of the value itself, and the
 * parse with an `https://` prefix — a topology value may be a bare host, and a
 * transport that prefixes a scheme would read the userinfo of the second.
 */
function whatwg(value) {
  const found = { user: false, password: false };
  for (const candidate of [value, `https://${value}`]) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.username !== "" || url.password !== "") found.user = true;
    if (url.password !== "") found.password = true;
  }
  return found;
}

/** Forms that carry a password, in every spelling WHATWG accepts. */
const PASSWORD_FORMS = [
  "https://admin:pw@h.service-now.com",
  "https:/admin:pw@h.service-now.com",
  "https:/\\admin:pw@h.service-now.com",
  "https:\\\\admin:pw@h.service-now.com",
  "https:\\/admin:pw@h.service-now.com",
  "https:admin:pw@h.service-now.com",
  "https:///admin:pw@h.service-now.com",
  "HTTPS://admin:pw@h",
  "http://admin:pw@h:8080/path",
  "//admin:pw@h",
  "\\\\admin:pw@h",
  "/\\admin:pw@h",
  " https://a:b@h",
  "https://a:b@h ",
  "https:/\t/admin:pw@h",
  "https://ad\nmin:pw@h",
];

/** Forms that carry a user and NO password. */
const USER_ONLY_FORMS = [
  "https://admin@h.service-now.com",
  "https:/admin@h",
  "https:/\\admin@h",
  "//admin@h",
  "https:admin@h",
  "https://admin%3Apw@h",
  "admin@dev.service-now.com",
];

/** Forms with no userinfo at all. */
const CLEAN_FORMS = [
  "https://h.service-now.com",
  "https://h.service-now.com/path@x",
  "https://h.service-now.com?q=a@b",
  "https://h.service-now.com#a@b",
  "https://h\\@evil",
  "dev.service-now.com",
  "dev",
  "prod_ro",
  "localhost:8080",
];

describe("hasUrlUserinfo agrees with WHATWG (never misses userinfo)", () => {
  for (const value of [...PASSWORD_FORMS, ...USER_ONLY_FORMS, ...CLEAN_FORMS]) {
    it(JSON.stringify(value), () => {
      const parsed = whatwg(value);
      if (parsed.user) {
        assert.equal(
          hasUrlUserinfo(value),
          true,
          `WHATWG reads userinfo in ${JSON.stringify(value)}`,
        );
      }
    });
  }

  it("flags every password and user-only form, and no clean one", () => {
    for (const value of [...PASSWORD_FORMS, ...USER_ONLY_FORMS]) {
      assert.equal(hasUrlUserinfo(value), true, JSON.stringify(value));
    }
    for (const value of CLEAN_FORMS) {
      assert.equal(hasUrlUserinfo(value), false, JSON.stringify(value));
    }
  });
});

describe("secretValueShape's user:password@ shape is equally tolerant", () => {
  for (const value of PASSWORD_FORMS) {
    it(JSON.stringify(value), () => {
      assert.equal(whatwg(value).password, true, "table sanity: WHATWG agrees");
      assert.match(secretValueShape(value) ?? "", /password in its userinfo/);
    });
  }

  it("still matches nothing that has no password", () => {
    for (const value of [...USER_ONLY_FORMS, ...CLEAN_FORMS]) {
      assert.equal(secretValueShape(value), undefined, JSON.stringify(value));
    }
  });
});

describe("the resolver refuses the bypass forms without echoing them", () => {
  const bypasses = [
    "https:/admin:pw@h.service-now.com",
    "https:/\\admin:pw@h.service-now.com",
    "//admin:pw@h",
    "https:/admin@h",
  ];
  for (const value of bypasses) {
    for (const channel of ["flag", "env", "file"]) {
      it(`${JSON.stringify(value)} via ${channel}`, () => {
        const input = {
          argv: channel === "flag" ? ["--runner", value] : [],
          env: channel === "env" ? { TESSERA_RUNNER: value } : {},
          cwd: "/x",
          readTextFile: (p) =>
            channel === "file" && p === "/x/tessera.config.json"
              ? JSON.stringify({ runner: value })
              : undefined,
        };
        assert.throws(
          () => resolveConfig(input),
          (error) => {
            assert.equal(error.name, "ConfigSecretError");
            assert.doesNotMatch(error.message, /pw|admin/);
            return true;
          },
        );
      });
    }
  }
});

describe("the startup log never prints a URL credential", () => {
  // `formatResolvedConfig` takes a ResolvedConfig; a non-topology option is
  // never refused for a bare `user@`, and the env layer is never shape-checked,
  // so the log itself must redact.
  const spec = { key: "docsDir", flag: "--docs-dir", type: "string" };
  const render = (value) =>
    formatResolvedConfig({
      values: { docsDir: value },
      provenance: { docsDir: "env" },
      aliasedFrom: {},
      options: [spec],
    });

  for (const value of [...PASSWORD_FORMS, ...USER_ONLY_FORMS]) {
    it(JSON.stringify(value), () => {
      const out = render(value);
      assert.match(out, new RegExp(`docsDir = ${REDACTED}`));
      assert.doesNotMatch(out, /admin|pw|a:b/);
    });
  }

  it("prints a clean value verbatim", () => {
    assert.match(
      render("https://h.service-now.com/docs"),
      /docsDir = https:\/\/h\.service-now\.com\/docs \(from env\)/,
    );
  });
});
