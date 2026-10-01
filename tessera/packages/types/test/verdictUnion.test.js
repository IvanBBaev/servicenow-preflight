// PreflightVerdict is a discriminated union: a GO carries its ConfirmToken,
// a NO_GO / INCONCLUSIVE never does (A-1). This is a TYPE-level contract, so
// the suite compiles a probe against the built declarations and relies on
// `@ts-expect-error`: an expected error that does not occur is itself an
// error (TS2578), so a clean compile proves both directions.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const typesEntry = join(here, "..", "build", "index.js");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const PROBE = `
import type { ConfirmToken, PreflightVerdict } from ${JSON.stringify(typesEntry)};
declare const token: ConfirmToken;
declare const base: Omit<PreflightVerdict, "status" | "confirmToken">;

export const go: PreflightVerdict = { ...base, status: "GO", confirmToken: token };
export const noGo: PreflightVerdict = { ...base, status: "NO_GO" };
export const inconclusive: PreflightVerdict = { ...base, status: "INCONCLUSIVE" };

// @ts-expect-error a GO without its ConfirmToken
export const goNoToken: PreflightVerdict = { ...base, status: "GO" };
// @ts-expect-error a NO_GO carrying a ConfirmToken
export const noGoToken: PreflightVerdict = { ...base, status: "NO_GO", confirmToken: token };
// @ts-expect-error an INCONCLUSIVE carrying a ConfirmToken
export const incToken: PreflightVerdict = { ...base, status: "INCONCLUSIVE", confirmToken: token };

export function tokenOf(v: PreflightVerdict): ConfirmToken | undefined {
  // Narrowing on status yields a definite token on GO.
  if (v.status === "GO") {
    const definite: ConfirmToken = v.confirmToken;
    return definite;
  }
  return v.confirmToken;
}
`;

describe("PreflightVerdict — discriminated on status (A-1)", () => {
  it("accepts GO+token and NO_GO/INCONCLUSIVE without, rejects the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-verdict-union-"));
    try {
      const probe = join(dir, "probe.mts");
      writeFileSync(probe, PROBE);
      let output = "";
      let status = 0;
      try {
        execFileSync(
          process.execPath,
          [
            tsc,
            "--noEmit",
            "--strict",
            "--skipLibCheck",
            "--module",
            "Node16",
            "--moduleResolution",
            "Node16",
            "--target",
            "ES2022",
            probe,
          ],
          { encoding: "utf8", stdio: "pipe" },
        );
      } catch (error) {
        status = error.status ?? 1;
        output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      }
      assert.equal(status, 0, `probe must compile cleanly:\n${output}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
