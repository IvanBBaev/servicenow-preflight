// Delegated decision 2026-09-25: a dot-less instance name is classified as the
// host the transport connects to. sn-client's resolveHost appends
// ".service-now.com" to any host without a dot, so a bare `acme` IS
// acme.service-now.com on the wire. Classifying it as the vanity host `acme`
// made it prod-suspect (liftable by --acknowledge-prod) while the write landed
// on a declared-prod instance.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GuardViolation,
  createTargetGuard,
  normalizeInstanceHost,
} from "../build/index.js";

const ACK = {
  reason: "vanity heuristic is a false positive",
  actor: "ivan@example.com",
  surface: "cli",
};

const cleanProbe = () =>
  Promise.resolve({ productionProperty: false, atfRunnerEnabled: true });

describe("normalizeInstanceHost mirrors resolveHost's bare-name rule", () => {
  for (const [input, expected] of [
    ["acme", "acme.service-now.com"],
    ["ACME", "acme.service-now.com"],
    ["https://acme/", "acme.service-now.com"],
    ["acme:443", "acme.service-now.com"],
    ["acme.service-now.com", "acme.service-now.com"],
    ["acme.example.com", "acme.example.com"],
  ]) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      assert.equal(normalizeInstanceHost(input), expected);
    });
  }
});

describe("a bare name cannot dodge the declared prod list", () => {
  for (const [host, prodEntry, allowEntry] of [
    ["acme", "https://acme.service-now.com", "acme"],
    ["acme", "acme.service-now.com", "acme"],
    ["acme.service-now.com", "acme", "acme.service-now.com"],
  ]) {
    it(`ref ${host} with prod ${prodEntry} classifies prod and stays refused under an ack`, async () => {
      const guard = createTargetGuard(
        {
          prodInstances: [prodEntry],
          nonProdAllowlist: [allowEntry],
          acknowledgeProd: ACK,
        },
        {
          runId: "r1",
          audit: { record() {} },
          probe: cleanProbe,
        },
      );
      const c = await guard.classify({ name: "p", host }, "runner");
      assert.equal(c.host, "acme.service-now.com");
      assert.equal(c.cls, "prod");
      assert.throws(() => {
        guard.assertRunnerWritable(c);
        guard.assertWrite(c, { kind: "x", table: "t" });
      }, GuardViolation);
    });
  }
});
