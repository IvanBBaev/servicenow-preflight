// GateEvaluator (DESIGN §6/§6a): sugar over the pure reducer (ARCH-17/22).
// The shell responsibility lives here: minting ConfirmToken.sig with the
// injected HMAC key — the reducer itself never sees the key.

import type { PreflightVerdict, VerdictStatus } from "@tessera/types";
import { aggregateVerdict, type VerdictInput } from "./aggregateVerdict.js";
import { canonicalJson, hmacSha256Hex } from "./canonical.js";

/** Facts the pipeline measured this run. */
export type GateInput = Pick<VerdictInput, "results" | "impact" | "coverage">;

/** Policy + identity — everything in VerdictInput that is not a GateInput fact. */
export type GatePolicy = Omit<VerdictInput, keyof GateInput>;

/** The §6a Verdict IS PreflightVerdict — no second shape (A-1). */
export type Verdict = PreflightVerdict;

export interface GateEvaluator {
  evaluate(input: GateInput, policy: GatePolicy): Verdict;
}

export interface GateEvaluatorOptions {
  /**
   * HMAC key for ConfirmToken.sig. Injected via config/secret store — never
   * from a config FILE (§9 secrets rule). Without a key the token ships with
   * sig === "" (unsigned; ADR-003 contingency posture).
   */
  hmacKey?: string;
}

/**
 * Sign a verdict's ConfirmToken with `hmacKey`, or pass it through unsigned
 * when no key is injected.
 *
 * Delegated decision 2026-09-26: a token on anything but a GO is REFUSED
 * (thrown), key or not — never silently stripped. A-1 says the token exists
 * iff status === "GO"; the reducer upholds that today, so a violation here is
 * a programming fault upstream, and signing it would hand `tess confirm` a
 * valid promotion credential for a verdict that did not pass. Throwing keeps
 * it a fault (never a verdict), and the discriminated PreflightVerdict type
 * cannot express the bad input, so this guards runtime-built objects only.
 * Exported for the test that feeds it a forged verdict; not re-exported
 * from the package index.
 */
export function signVerdict(
  verdict: PreflightVerdict,
  hmacKey: string | undefined,
): PreflightVerdict {
  const status: VerdictStatus = verdict.status;
  const token = verdict.confirmToken;
  if (token === undefined) return verdict;
  if (status !== "GO") {
    throw new Error(
      `refusing to sign a ConfirmToken on a verdict with status "${status}": a token exists only on GO (A-1)`,
    );
  }
  if (hmacKey === undefined) return verdict;
  // The sig covers exactly these fields (§6a: "HMAC over the fields
  // above") — enumerated explicitly so the signed payload is visible.
  const unsigned = {
    runId: token.runId,
    verdictHash: token.verdictHash,
    overridden: token.overridden,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
  };
  return {
    ...verdict,
    status: "GO",
    confirmToken: {
      ...unsigned,
      sig: hmacSha256Hex(hmacKey, canonicalJson(unsigned)),
    },
  };
}

export function createGateEvaluator(
  options: GateEvaluatorOptions = {},
): GateEvaluator {
  return {
    evaluate(input, policy) {
      return signVerdict(
        aggregateVerdict({ ...input, ...policy }),
        options.hmacKey,
      );
    },
  };
}
