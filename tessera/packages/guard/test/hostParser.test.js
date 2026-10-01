// Delegated decisions 2026-09-26 (review-w5a/guard1.mjs repros):
//   1. normalizeInstanceHost reads a host through WHATWG `new URL` and refuses
//      anything it cannot read unambiguously: userinfo, backslashes, a scheme
//      other than http/https, a path/query/fragment beyond a bare "/", and any
//      host sn-client's resolveHost would refuse. The hand-rolled parser read
//      "prod.service-now.com://dev.service-now.com" as dev (a scheme that is a
//      prod host), so a prod instance could classify as an allowlisted one.
//   2. The instance-name heuristic matches whole tokens, never substrings:
//      "qatarairways" held "qa" and "devonenergy" held "dev", so a prod name
//      raised no downgrade. A name can only become MORE suspect.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resolveHost } from "@tessera/sn-client";

import {
  createTargetGuard,
  nameHeuristicReasons,
  normalizeInstanceHost,
} from "../build/index.js";

const cleanProbe = () =>
  Promise.resolve({ productionProperty: false, atfRunnerEnabled: true });

describe("normalizeInstanceHost refuses ambiguous identities", () => {
  for (const input of [
    // guard1.mjs: the scheme is a prod host, the "authority" is an allowlisted one.
    "prod.service-now.com://dev.service-now.com",
    // guard1.mjs: WHATWG reads "\" as "/", the old parser read "@" as userinfo.
    "prod.service-now.com\\@dev.service-now.com",
    "https://prod.service-now.com\\dev.service-now.com",
    // userinfo, in any position
    "u:p@dev1.service-now.com",
    "https://u:p@acme.service-now.com:443/x",
    "https://@acme.service-now.com",
    "acme.service-now.com@evil.example",
    // a path, query or fragment beyond a bare "/"
    "https://acme.service-now.com/x",
    "http://dev1.service-now.com:8080/x?y#z",
    "acme.service-now.com?x",
    "acme.service-now.com#f",
    "acme.service-now.com//",
    // schemes other than http/https
    "ftp://acme.service-now.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "//acme.service-now.com",
    // percent-encoding, which WHATWG would decode into a different host
    "acme.service-now.com%2F",
    "acme%2eservice-now.com",
    // resolveHost parity: characters and shapes the transport refuses
    "a_b.service-now.com",
    "acme..service-now.com",
    ".acme.service-now.com",
    "-acme.service-now.com",
    "acme.service-now.com..",
    // Delegated decision 2026-09-26: a trailing dot (the DNS root) is refused,
    // matching sn-client resolveHost, so the guard never accepts a host the
    // transport refuses — the stricter side wins and it classifies `unknown`.
    "acme.service-now.com.",
    "https://acme.service-now.com.:443/",
    "https://acme.service-now.com./",
    "acme.",
    // a host WHATWG rewrites (IPv4 shorthand) is not the host we would compare
    "10.1",
    "0x7f.0.0.1",
    // ports
    "acme.service-now.com:99999",
    "acme.service-now.com:",
    "acme.service-now.com:44a",
    // non-ASCII, internal whitespace, IPv6
    "münchen.service-now.com",
    "acme\t.service-now.com",
    "acme .service-now.com",
    "[::1]",
    "https://[::1]:443/",
  ]) {
    it(`refuses ${JSON.stringify(input)}`, () => {
      assert.equal(normalizeInstanceHost(input), undefined);
    });
  }
});

describe("normalizeInstanceHost keeps the readable forms", () => {
  for (const [input, expected] of [
    ["ACME.SERVICE-NOW.COM", "acme.service-now.com"],
    ["acme.service-now.com:443", "acme.service-now.com"],
    ["  acme.service-now.com  ", "acme.service-now.com"],
    [" acme ", "acme.service-now.com"],
    ["https://acme/", "acme.service-now.com"],
    ["HTTPS://ACME.SERVICE-NOW.COM/", "acme.service-now.com"],
    ["http://acme.service-now.com:8080", "acme.service-now.com"],
    ["xn--mnchen-3ya.service-now.com", "xn--mnchen-3ya.service-now.com"],
    ["1.2.3.4", "1.2.3.4"],
  ]) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      assert.equal(normalizeInstanceHost(input), expected);
    });
  }
});

// A generated corpus: every combination of scheme, userinfo, host, port and
// tail. Used for the WHATWG-agreement and resolveHost-parity properties.
const CORPUS = (() => {
  const schemes = ["", "https://", "http://", "HTTPS://", "ftp://", "//"];
  const userinfo = ["", "u:p@", "@"];
  const hosts = [
    "acme",
    "ACME",
    "acme.service-now.com",
    "dev1.example.com",
    "a_b.service-now.com",
    "-x.com",
    ".x.com",
    "x..com",
    "10.1",
    "1.2.3.4",
    "xn--mnchen-3ya.service-now.com",
    "münchen.service-now.com",
    "[::1]",
    "acme.",
    "acme.service-now.com.",
    "acme%2e.com",
    "0x7f.1",
    "prod.service-now.com\\",
  ];
  const ports = ["", ":443", ":99999", ":", ":0x1"];
  const tails = ["", "/", "/x", "?q", "#f", "\\"];
  const out = [];
  for (const s of schemes)
    for (const u of userinfo)
      for (const h of hosts)
        for (const p of ports)
          for (const t of tails) out.push(`${s}${u}${h}${p}${t}`);
  return out;
})();

describe("accepted hosts agree with WHATWG and with sn-client resolveHost", () => {
  const saved = process.env.SN_ALLOWED_HOSTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SN_ALLOWED_HOSTS;
    else process.env.SN_ALLOWED_HOSTS = saved;
  });

  it("every accepted host is its own WHATWG hostname", () => {
    let accepted = 0;
    for (const input of CORPUS) {
      const host = normalizeInstanceHost(input);
      if (host === undefined) continue;
      accepted += 1;
      assert.equal(new URL(`https://${host}/`).hostname, host, input);
    }
    assert.ok(accepted > 50, `corpus exercised ${accepted} accepted inputs`);
  });

  it("guard accepts ⇒ resolveHost accepts the same host (no exceptions)", () => {
    let checked = 0;
    for (const input of CORPUS) {
      const host = normalizeInstanceHost(input);
      if (host === undefined) continue;
      // Syntax parity only: the transport's allowlist/SSRF policy is a
      // separate decision, so the allowlist is pinned to the exact host.
      process.env.SN_ALLOWED_HOSTS = host;
      // No exception is caught here: a guard-accepted host that resolveHost
      // refuses is a parity failure (the trailing-dot exception is gone).
      const resolved = resolveHost(input);
      assert.equal(resolved.toLowerCase(), host, input);
      checked += 1;
    }
    assert.ok(checked > 50, `parity checked ${checked} inputs`);
  });

  it("refuses every corpus input that resolveHost refuses", () => {
    let refused = 0;
    for (const input of CORPUS) {
      process.env.SN_ALLOWED_HOSTS = "0.0.0.0/0-never-matches";
      let refusedBySyntax = false;
      try {
        resolveHost(input);
      } catch (error) {
        refusedBySyntax = !/not permitted by SN_ALLOWED_HOSTS/.test(
          String(error.message),
        );
      }
      if (refusedBySyntax) {
        refused += 1;
        assert.equal(normalizeInstanceHost(input), undefined, input);
      }
    }
    assert.ok(refused > 50, `parity refused ${refused} inputs`);
  });
});

describe("a mis-parsed identity cannot borrow an allowlist entry", () => {
  for (const input of [
    "prod.service-now.com://dev.service-now.com",
    "prod.service-now.com\\@dev.service-now.com",
  ]) {
    it(`${JSON.stringify(input)} classifies unknown, not sub-prod`, async () => {
      const guard = createTargetGuard(
        {
          prodInstances: ["prod.service-now.com"],
          nonProdAllowlist: ["dev.service-now.com"],
        },
        { probe: cleanProbe },
      );
      const c = await guard.classify({ name: "x", host: input }, "runner");
      assert.equal(c.cls, "unknown");
      assert.equal(c.host, undefined);
    });
  }
});

// Delegated decision 2026-09-26: the trailing dot is refused (resolveHost
// parity). Each list it can appear in must still fail closed.
describe("a trailing-dot identity fails closed wherever it appears", () => {
  it("a trailing-dot ref classifies unknown, even when its host is allowlisted", async () => {
    const guard = createTargetGuard(
      { nonProdAllowlist: ["dev.service-now.com"] },
      { probe: cleanProbe },
    );
    const c = await guard.classify(
      { name: "x", host: "dev.service-now.com." },
      "runner",
    );
    assert.equal(c.cls, "unknown");
    assert.equal(c.host, undefined);
  });

  it("a trailing-dot allowlist entry admits nothing", async () => {
    const guard = createTargetGuard(
      { nonProdAllowlist: ["dev.service-now.com."] },
      { probe: cleanProbe },
    );
    const c = await guard.classify(
      { name: "x", host: "dev.service-now.com" },
      "runner",
    );
    assert.equal(c.cls, "unknown");
  });

  for (const entry of [
    "prod.service-now.com.",
    "https://prod.service-now.com./",
    "prod.service-now.com.:443",
  ]) {
    it(`prod-list entry ${JSON.stringify(entry)} still marks its host prod`, async () => {
      // Dropping it would be fail-OPEN: the same host on the allowlist would
      // then classify sub-prod. The prod list can only make a host stricter,
      // so it keeps reading the DNS-root form as the same host.
      const guard = createTargetGuard(
        {
          prodInstances: [entry],
          nonProdAllowlist: ["prod.service-now.com"],
        },
        { probe: cleanProbe },
      );
      const c = await guard.classify(
        { name: "x", host: "prod.service-now.com" },
        "runner",
      );
      assert.equal(c.cls, "prod");
    });
  }
});

describe("the name heuristic matches whole tokens", () => {
  const noMarker = (host) =>
    nameHeuristicReasons(host).some((r) => /no dev\/test\/uat marker/.test(r));

  for (const label of [
    "qatarairways",
    "devonenergy",
    "democracyprep",
    "democratic-party",
    "strainco",
    "equator",
    "contestants",
    "acmedev",
    "pre_prod", // was suspect before; must stay suspect
  ]) {
    it(`"${label}" raises the missing-marker reason`, () => {
      assert.ok(noMarker(`${label}.service-now.com`));
    });
  }

  for (const label of [
    "dev12345",
    "acme-uat",
    "acme_dev",
    "acme-preprod",
    "acme-pre-prod",
    "sbx01",
    "dev-skeleton",
    "uat2-acme",
    "acme-non-prod-3",
  ]) {
    it(`"${label}" stays clean`, () => {
      assert.ok(!noMarker(`${label}.service-now.com`));
    });
  }

  it("never makes a name less suspect than the substring rule did", () => {
    // The pre-2026-09-26 marker list and rule, kept here as the oracle.
    const OLD_MARKERS = [
      "dev",
      "test",
      "tst",
      "uat",
      "qa",
      "sandbox",
      "sbx",
      "staging",
      "stage",
      "stg",
      "demo",
      "poc",
      "train",
      "preprod",
      "pre-prod",
      "nonprod",
      "non-prod",
      "subprod",
      "sub-prod",
      "pdi",
    ];
    const oldClean = (label) => OLD_MARKERS.some((m) => label.includes(m));
    const pieces = ["", "acme", "1", "-", "_", "x", "prod", "pre", "sub"];
    let cleanCount = 0;
    for (const a of pieces)
      for (const m of OLD_MARKERS)
        for (const b of pieces) {
          const label = `${a}${m}${b}`;
          if (!noMarker(`${label}.service-now.com`)) {
            cleanCount += 1;
            assert.ok(oldClean(label), label);
          }
        }
    assert.ok(cleanCount > 100, `oracle compared ${cleanCount} clean labels`);
  });

  it("an allowlisted qatarairways is prod-suspect and its write is refused", async () => {
    const guard = createTargetGuard(
      { nonProdAllowlist: ["qatarairways"] },
      { probe: cleanProbe },
    );
    const c = await guard.classify(
      { name: "qatarairways", host: "qatarairways" },
      "runner",
    );
    assert.equal(c.cls, "prod-suspect");
    assert.throws(() => guard.assertWrite(c, { op: "insert", table: "x" }));
  });
});
