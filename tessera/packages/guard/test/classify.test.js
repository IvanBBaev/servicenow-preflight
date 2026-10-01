// §11.1 classification + §11.2 downgrade-only. Every path through the
// classification lattice, and the fail-closed defaults around it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTargetGuard } from "../build/index.js";

const ref = (host, name = host) => ({ name, host });

/** Reads clean: not prod, ATF runner on. Never upgrades anything (§11.2). */
const cleanProbe = () =>
  Promise.resolve({ productionProperty: false, atfRunnerEnabled: true });

const SUB_PROD_HOST = "dev12345.service-now.com";
const allowlisted = (probe = cleanProbe) =>
  createTargetGuard({ nonProdAllowlist: [SUB_PROD_HOST] }, { probe });

const kinds = (c) => c.evidence.map((s) => s.kind);
const effects = (c) => c.evidence.map((s) => s.effect);

describe("§11.1 classification", () => {
  it("classifies an allowlisted instance with clean heuristics as sub-prod", async () => {
    const c = await allowlisted().classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "sub-prod");
    assert.equal(c.role, "runner");
    assert.equal(c.host, SUB_PROD_HOST);
    assert.ok(kinds(c).includes("allowlist-entry"));
    assert.ok(!effects(c).includes("downgrade"));
  });

  it("classifies a declared prod instance as prod", async () => {
    const guard = createTargetGuard(
      { prodInstances: ["acme.service-now.com"] },
      { probe: cleanProbe },
    );
    const c = await guard.classify(ref("acme.service-now.com"), "target");
    assert.equal(c.cls, "prod");
    assert.ok(kinds(c).includes("prod-declaration"));
  });

  it("classifies an instance absent from config as unknown — the default", async () => {
    const guard = createTargetGuard({}, { probe: cleanProbe });
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "unknown");
    assert.ok(kinds(c).includes("not-classified"));
  });

  it("classifies as unknown with no config at all", async () => {
    const c = await createTargetGuard().classify(ref(SUB_PROD_HOST), "source");
    assert.equal(c.cls, "unknown");
  });

  it("lets the prod declaration win when a host is on both lists", async () => {
    const guard = createTargetGuard(
      {
        nonProdAllowlist: [SUB_PROD_HOST],
        prodInstances: [SUB_PROD_HOST],
      },
      { probe: cleanProbe },
    );
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "prod");
    const conflict = c.evidence.find(
      (s) => s.kind === "allowlist-entry" && s.effect === "warning",
    );
    assert.match(conflict.detail, /prod declaration wins/);
  });

  it("pins the classification per instance + role", async () => {
    const guard = allowlisted();
    const first = await guard.classify(ref(SUB_PROD_HOST), "runner");
    const second = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(first, second);
    const other = await guard.classify(ref(SUB_PROD_HOST), "source");
    assert.notEqual(first, other);
    assert.equal(other.role, "source");
  });

  it("freezes the pinned classification", async () => {
    const c = await allowlisted().classify(ref(SUB_PROD_HOST), "runner");
    assert.throws(() => {
      c.cls = "sub-prod";
    }, TypeError);
    assert.throws(() => {
      c.evidence.push({ kind: "allowlist-entry" });
    }, TypeError);
  });

  it("runs one probe for concurrent classify calls on the same pair", async () => {
    let calls = 0;
    const guard = createTargetGuard(
      { nonProdAllowlist: [SUB_PROD_HOST] },
      {
        probe: () => {
          calls += 1;
          return cleanProbe();
        },
      },
    );
    const [a, b] = await Promise.all([
      guard.classify(ref(SUB_PROD_HOST), "runner"),
      guard.classify(ref(SUB_PROD_HOST), "runner"),
    ]);
    assert.equal(a, b);
    assert.equal(calls, 1);
  });

  it("lists every pinned classification for the run record (§11.6)", async () => {
    const guard = allowlisted();
    await guard.classify(ref(SUB_PROD_HOST), "runner");
    await guard.classify(ref("prod.example.com"), "target");
    assert.deepEqual(
      guard.pinned().map((c) => [c.role, c.cls]),
      [
        ["runner", "sub-prod"],
        ["target", "unknown"],
      ],
    );
  });
});

describe("§11.1 fail-closed identity", () => {
  for (const bad of ["", "   ", "https://", "not a host", "://x"]) {
    it(`classifies an unreadable host ${JSON.stringify(bad)} as unknown`, async () => {
      const guard = createTargetGuard(
        { nonProdAllowlist: [SUB_PROD_HOST, bad] },
        { probe: cleanProbe },
      );
      const c = await guard.classify(ref(bad), "runner");
      assert.equal(c.cls, "unknown");
      assert.equal(c.host, undefined);
    });
  }

  it("matches the allowlist through scheme, port, trailing slash and case", async () => {
    const guard = allowlisted();
    for (const variant of [
      `https://${SUB_PROD_HOST}`,
      `HTTPS://${SUB_PROD_HOST.toUpperCase()}/`,
      `${SUB_PROD_HOST}:443`,
      `  ${SUB_PROD_HOST}  `,
    ]) {
      const c = await guard.classify(ref(variant), "runner");
      assert.equal(c.cls, "sub-prod", variant);
    }
  });

  // Delegated decision 2026-09-26: a trailing dot is refused (sn-client
  // resolveHost refuses it too), so it no longer borrows the allowlist entry.
  it("does not match the allowlist through a trailing dot", async () => {
    const guard = allowlisted();
    const c = await guard.classify(ref(`${SUB_PROD_HOST}.`), "runner");
    assert.equal(c.cls, "unknown");
  });

  // Delegated decision 2026-09-26: userinfo and a path are refused, not
  // stripped — an identity that needs cutting down is not read at all.
  it("does not match the allowlist through userinfo or a path", async () => {
    const guard = allowlisted();
    for (const variant of [
      `https://user@${SUB_PROD_HOST}/`,
      `https://${SUB_PROD_HOST}/api/now/table/incident?x=1`,
    ]) {
      const c = await guard.classify(ref(variant), "runner");
      assert.equal(c.cls, "unknown", variant);
    }
  });

  it("never matches an allowlist entry against the config alias", async () => {
    const guard = createTargetGuard(
      { nonProdAllowlist: ["my-dev-box"] },
      { probe: cleanProbe },
    );
    const c = await guard.classify(
      { name: "my-dev-box", host: SUB_PROD_HOST },
      "runner",
    );
    assert.equal(c.cls, "unknown");
  });

  it("does not treat allowlist entries as wildcards", async () => {
    const guard = createTargetGuard(
      { nonProdAllowlist: ["*.service-now.com", "service-now.com"] },
      { probe: cleanProbe },
    );
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "unknown");
  });
});

describe("§11.2 heuristics downgrade only", () => {
  const downgrades = (c) =>
    c.evidence.filter((s) => s.effect === "downgrade").map((s) => s.kind);

  it("downgrades on glide.installation.production true", async () => {
    const guard = allowlisted(() =>
      Promise.resolve({ productionProperty: true, atfRunnerEnabled: true }),
    );
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "prod-suspect");
    assert.deepEqual(downgrades(c), ["production-property"]);
  });

  it("downgrades on a disabled ATF runner (DR-3)", async () => {
    const guard = allowlisted(() =>
      Promise.resolve({ productionProperty: false, atfRunnerEnabled: false }),
    );
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "prod-suspect");
    assert.deepEqual(downgrades(c), ["atf-runner-disabled"]);
  });

  it("downgrades an allowlisted host with no dev/test/uat marker", async () => {
    const guard = createTargetGuard(
      { nonProdAllowlist: ["acme.service-now.com"] },
      { probe: cleanProbe },
    );
    const c = await guard.classify(ref("acme.service-now.com"), "runner");
    assert.equal(c.cls, "prod-suspect");
    assert.deepEqual(downgrades(c), ["name-pattern"]);
    assert.match(c.evidence[1].detail, /no dev\/test\/uat marker/);
  });

  it("downgrades an allowlisted vanity/customer URL", async () => {
    const guard = createTargetGuard(
      { nonProdAllowlist: ["dev.acme.com"] },
      { probe: cleanProbe },
    );
    const c = await guard.classify(ref("dev.acme.com"), "runner");
    assert.equal(c.cls, "prod-suspect");
    assert.match(c.evidence[1].detail, /vanity\/customer URL/);
  });

  it("reports both name reasons on one signal", async () => {
    const guard = createTargetGuard(
      { nonProdAllowlist: ["acme.example.com"] },
      { probe: cleanProbe },
    );
    const c = await guard.classify(ref("acme.example.com"), "runner");
    const signal = c.evidence.find((s) => s.kind === "name-pattern");
    assert.match(signal.detail, /no dev\/test\/uat marker/);
    assert.match(signal.detail, /vanity\/customer URL/);
  });

  it("collects several downgrade signals at once", async () => {
    const guard = createTargetGuard(
      { nonProdAllowlist: ["acme.example.com"] },
      {
        probe: () =>
          Promise.resolve({
            productionProperty: true,
            atfRunnerEnabled: false,
          }),
      },
    );
    const c = await guard.classify(ref("acme.example.com"), "runner");
    assert.deepEqual(downgrades(c), [
      "name-pattern",
      "production-property",
      "atf-runner-disabled",
    ]);
  });

  it("never upgrades an unclassified instance, however clean the reads", async () => {
    let called = false;
    const guard = createTargetGuard(
      {},
      {
        probe: () => {
          called = true;
          return cleanProbe();
        },
      },
    );
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "unknown");
    // Probes only ever downgrade an allowlisted entry, so they are not run
    // for classes they could not change (§11.2).
    assert.equal(called, false);
  });

  it("never upgrades a declared prod instance", async () => {
    let called = false;
    const guard = createTargetGuard(
      { prodInstances: [SUB_PROD_HOST] },
      {
        probe: () => {
          called = true;
          return cleanProbe();
        },
      },
    );
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "prod");
    assert.equal(called, false);
  });

  it("keeps the allowlist entry standing when the probe result is empty", async () => {
    const guard = allowlisted(() => Promise.resolve({}));
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "sub-prod");
    const warnings = c.evidence.filter((s) => s.kind === "probe-unreachable");
    assert.equal(warnings.length, 2);
  });

  it("keeps the allowlist entry standing when the probe throws", async () => {
    const guard = allowlisted(() => Promise.reject(new Error("401 nope")));
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "sub-prod");
    assert.match(
      c.evidence.find((s) => s.kind === "probe-unreachable").detail,
      /read-only probe failed: 401 nope/,
    );
  });

  it("keeps the allowlist entry standing when no probe is configured", async () => {
    const guard = createTargetGuard({ nonProdAllowlist: [SUB_PROD_HOST] });
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "sub-prod");
    assert.match(
      c.evidence.find((s) => s.kind === "probe-unreachable").detail,
      /no read-only probe configured/,
    );
  });

  it("treats a malformed probe result as unreadable, not as clean", async () => {
    const guard = allowlisted(() => Promise.resolve(null));
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "sub-prod");
    assert.match(
      c.evidence.find((s) => s.kind === "probe-unreachable").detail,
      /no usable result/,
    );
  });

  it("neither clears nor downgrades on a non-boolean probe value, and does not report it as unread", async () => {
    // `"false"` is not `false`, so the value cannot be acted on and the
    // allowlist entry stands (§11.2). What the guard must NOT do is call it a
    // read that failed: the read is what produced the string. Named for the
    // property because the count alone passed before the sentence was true.
    const guard = allowlisted(() =>
      Promise.resolve({ productionProperty: "false", atfRunnerEnabled: 1 }),
    );
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "sub-prod");
    const warnings = c.evidence.filter((s) => s.kind === "probe-unreachable");
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((s) => s.effect === "warning"));
    for (const signal of warnings) {
      assert.doesNotMatch(signal.detail, /could not be read/);
      assert.match(signal.detail, /not a boolean/);
    }
  });

  it("records explicit probe-unreachable reasons as warnings", async () => {
    const guard = allowlisted(() =>
      Promise.resolve({
        productionProperty: false,
        atfRunnerEnabled: true,
        unreachable: ["sys_properties read denied"],
      }),
    );
    const c = await guard.classify(ref(SUB_PROD_HOST), "runner");
    assert.equal(c.cls, "sub-prod");
    assert.equal(
      c.evidence.find((s) => s.kind === "probe-unreachable").detail,
      "sys_properties read denied",
    );
  });
});
