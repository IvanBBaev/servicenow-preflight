// The live spec loader — the TM-3 projection gate in front of `tess run --live`.
//
// `@tessera/specs` answers what a tests root DECLARES and deliberately leaves
// `payload` undefined: it never reads a spec body, because an inventory is a
// statement about intent, not code. Projection needs the body — the ATF store
// writes it verbatim into a "Run Server Side Script" step, where it executes
// with the runner's authority. So this module is the one place a repo-authored
// body is read and handed to a write path, and it holds that body to exactly
// the bar a GENERATED body is held to: `createGeneratedCodeGate()` (TM-3).
//
// A repo spec is not trusted merely because it is in the repo (TM-5: a hostile
// or compromised commit is the threat model, not an exotic one). Every body is
// read as `Untrusted<string>`, inspected, and unwrapped only through the
// clearance the gate returns. One rejection refuses the WHOLE run before the
// first write — a partial projection would be a run over a subset the operator
// did not choose (delegated decision 2026-09-23, TODO "run --live").
//
// Only `unit` specs are projected: the ATF store authors "Run Server Side
// Script" steps and nothing else (ADR-007), so an e2e spec has no projection
// and is reported, not silently dropped.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createGeneratedCodeGate, type GateViolation } from "@tessera/generate";
import { readSpecInventory, type InventoryNote } from "@tessera/specs";
import { untrusted, unwrapUntrusted, type TestSpec } from "@tessera/types";

/** The unwrap boundary: what a cleared body is about to cross. */
const PROJECTION_BOUNDARY =
  "live spec projection — a TM-3-cleared repo spec body is written verbatim into an ATF step input on the runner; it is never evaluated, interpolated into a prompt or rendered by Tessera (TM-1/TM-3)";

/** The DESIGN §4 repo directory a tests root stands for. */
const REPO_TESTS_DIR = "tests";

function toPosix(relative: string): string {
  return relative.split(path.sep).join(path.posix.sep);
}

/** One spec the gate refused, with the violations it reported. */
export interface RejectedSpec {
  readonly id: string;
  readonly path: string;
  readonly violations: readonly GateViolation[];
}

export type LiveSpecLoad =
  | {
      readonly kind: "loaded";
      /** Unit specs with `payload: { script }`, in inventory order. */
      readonly specs: readonly TestSpec[];
      /** Inventory notes plus one line per non-projectable spec. */
      readonly notes: readonly InventoryNote[];
      readonly incomplete: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly rejected: readonly RejectedSpec[];
    };

/** Containment by path segments, as `@tessera/specs` checks it. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "" || path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0] !== "..";
}

/**
 * Read the inventory under `testsRoot`, then read and TM-3-gate every `unit`
 * body. Throws what `readSpecInventory` throws (`SpecInputError`,
 * `SpecStoreFaultError`) and a plain `Error` for a body that vanished between
 * the inventory and the read — both are DEV-1 faults, not refusals.
 */
export async function loadLiveSpecs(testsRoot: string): Promise<LiveSpecLoad> {
  const root = path.resolve(testsRoot);
  const inventory = await readSpecInventory({ root });
  const gate = createGeneratedCodeGate();
  const notes: InventoryNote[] = [...inventory.notes];
  const specs: TestSpec[] = [];
  const rejected: RejectedSpec[] = [];
  let incomplete = inventory.incomplete;

  for (const spec of inventory.specs) {
    if (spec.kind !== "unit") {
      // Delegated decision 2026-09-26 (review W5b, C): a spec the manifest
      // declares but the live run does not project is a spec the verdict does
      // not cover, exactly like one the inventory could not read — so the load
      // says `incomplete`, not only a warning line. Otherwise a manifest with
      // an e2e/ui spec reported a complete inventory for a run over a subset.
      incomplete = true;
      notes.push({
        level: "warning",
        message: `spec \`${spec.ref.id}\` (${spec.kind}) is not projected: the ATF store authors server-side-script steps for unit specs only (ADR-007)`,
      });
      continue;
    }
    const file = path.resolve(root, spec.ref.path);
    if (!isInside(root, file)) {
      // The inventory already refuses this; re-checked because this is the
      // read that feeds a write, and a check one package away is a promise.
      throw new Error(
        `spec \`${spec.ref.id}\` resolves outside the tests root (${spec.ref.path})`,
      );
    }
    const body = await readFile(file, "utf8");
    const verdict = gate.inspect(untrusted(body));
    if (!verdict.ok) {
      rejected.push({
        id: spec.ref.id,
        path: spec.ref.path,
        violations: verdict.violations,
      });
      continue;
    }
    specs.push({
      ...spec,
      // Delegated decision 2026-09-23 (TODO "run --live"): the inventory names a
      // spec relative to the tests root; impact analysis names the specs it
      // DEMANDS by the DESIGN §4 repo layout (`tests/<scope>/<table>/<Name>/…`),
      // and the ARCH-30 parity check joins the two on (id, path). The ref is
      // re-rooted into that layout so one spec is one row, not two; the body was
      // read above from the inventory path, which stays the file of record.
      ref: {
        ...spec.ref,
        path: path.posix.join(REPO_TESTS_DIR, toPosix(spec.ref.path)),
      },
      payload: {
        script: unwrapUntrusted(verdict.cleared.source, PROJECTION_BOUNDARY),
      },
    });
  }

  if (rejected.length > 0) return { kind: "rejected", rejected };
  return { kind: "loaded", specs, notes, incomplete };
}

/** Operator-facing lines for a rejection. Rule names only, never the body. */
export function formatRejectedSpecs(
  rejected: readonly RejectedSpec[],
): string[] {
  const lines: string[] = [];
  for (const entry of rejected) {
    lines.push(`  ${entry.id} (${entry.path}):`);
    for (const violation of entry.violations) {
      const where = violation.line === 0 ? "" : ` line ${violation.line}`;
      lines.push(
        `    - ${violation.category}/${violation.rule}${where}: ${violation.detail}`,
      );
    }
  }
  return lines;
}
