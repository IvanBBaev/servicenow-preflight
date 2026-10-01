// GateEvaluator is sugar over the pure reducer; the shell mints the HMAC sig.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

import {
  aggregateVerdict,
  canonicalJson,
  createGateEvaluator,
} from "../build/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) =>
  JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf8"));

const split = (input) => {
  const { results, impact, coverage, ...policy } = input;
  return [{ results, impact, coverage }, policy];
};

describe("createGateEvaluator", () => {
  it("without a key, evaluate() equals the raw reducer output", () => {
    const { input } = load("full-green");
    const gate = createGateEvaluator();
    const [gateInput, policy] = split(input);
    assert.deepEqual(gate.evaluate(gateInput, policy), aggregateVerdict(input));
  });

  it("with a key, a GO verdict gets a verifiable HMAC sig", () => {
    const { input } = load("full-green");
    const gate = createGateEvaluator({ hmacKey: "test-key" });
    const [gateInput, policy] = split(input);
    const verdict = gate.evaluate(gateInput, policy);

    assert.equal(verdict.status, "GO");
    const { sig, ...payload } = verdict.confirmToken;
    const expectedSig = createHmac("sha256", "test-key")
      .update(canonicalJson(payload), "utf8")
      .digest("hex");
    assert.equal(sig, expectedSig);

    // Everything except sig matches the pure reducer output.
    const pureToken = { ...aggregateVerdict(input).confirmToken };
    delete pureToken.sig;
    assert.deepEqual(payload, pureToken);
  });

  it("a non-GO verdict never carries a token, key or not", () => {
    const { input } = load("full-red");
    const gate = createGateEvaluator({ hmacKey: "test-key" });
    const [gateInput, policy] = split(input);
    const verdict = gate.evaluate(gateInput, policy);
    assert.equal(verdict.status, "NO_GO");
    assert.equal(verdict.confirmToken, undefined);
  });

  it("an override-GO token is distinguishable: overridden flag and digest differ", () => {
    const overrideGo = load("allow-skipped-go");
    const plainGo = load("full-green");
    const gate = createGateEvaluator({ hmacKey: "test-key" });

    const withOverride = gate.evaluate(...split(overrideGo.input));
    const without = gate.evaluate(...split(plainGo.input));

    assert.equal(withOverride.confirmToken.overridden, true);
    assert.equal(without.confirmToken.overridden, false);
    assert.notEqual(
      withOverride.confirmToken.verdictHash,
      without.confirmToken.verdictHash,
    );
  });
});

// The gate signs a ConfirmToken only on a GO. aggregateVerdict never mints a
// token off GO, so the malformed input is fed to the signing step directly.
describe("signVerdict — a token is signed only on a GO", () => {
  const goVerdict = () => aggregateVerdict(load("full-green").input);

  it("signs a GO verdict's token", async () => {
    const { signVerdict } = await import("../build/gateEvaluator.js");
    const signed = signVerdict(goVerdict(), "test-key");
    assert.equal(signed.status, "GO");
    assert.notEqual(signed.confirmToken.sig, "");
  });

  for (const status of ["NO_GO", "INCONCLUSIVE"]) {
    for (const hmacKey of ["test-key", undefined]) {
      it(`refuses a ${status} verdict carrying a token (key ${hmacKey === undefined ? "absent" : "present"})`, async () => {
        const { signVerdict } = await import("../build/gateEvaluator.js");
        const forged = { ...goVerdict(), status };
        assert.throws(
          () => signVerdict(forged, hmacKey),
          /refusing to sign.*status "(NO_GO|INCONCLUSIVE)"/,
          "a token on a non-GO verdict breaks A-1 and must never leave the gate",
        );
      });
    }
  }

  it("passes a token-less non-GO verdict through untouched", async () => {
    const { signVerdict } = await import("../build/gateEvaluator.js");
    const red = aggregateVerdict(load("full-red").input);
    assert.equal(signVerdict(red, "test-key"), red);
  });
});
