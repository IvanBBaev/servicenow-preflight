// The pre-run intent join — DESIGN §4a's first half (PLAN Phase 4 read side,
// ARCH-15, ARCH-25). The contract, and the reasoning behind it, live above
// `IntentEntry`/`IntentReport` in `./types.js`; this file is only their
// implementation.
//
// Three properties are worth more than the twenty lines that produce them.
//
// First, the entry set is `graph.nodes ∪ graph.unanalyzable`. `entries.length`
// is the denominator QA-15's coverage floor divides by, so an artifact nobody
// could analyse has to be IN it: built from `nodes` alone, the ratio would
// climb every time the analysis got worse, which is the exact failure the floor
// was written to catch. Making the union the only way an entry is produced is
// how that stops depending on anyone remembering it.
//
// Second, the join is on `targets` — table + sys_id — and on nothing else
// (QA-16). Not on `name`, which is a display label two records may share and
// which `@tessera/resolvers` substitutes a placeholder for when it is
// unreadable; and not on the spec's path, which encodes at most one table and
// one name and breaks outright for a `ui`/`e2e` spec covering several
// artifacts. The link is declared, never inferred.
//
// Third, everything this file produces is INTENT: somebody wrote a spec aimed
// at this artifact. Whether that spec passes is confirmed coverage (QA-8) and
// is computed post-run by `computeCoverage` in `@tessera/core`, from a run this
// function never sees. Hence the wording of the summary note, and hence the
// signature: `TestSpec` values arrive as arguments, so `@tessera/specs` is not
// a dependency of this package and the two sides keep speaking `@tessera/types`
// only. The function is pure — no clock, no disk, no instance.

import type { TargetArtifactRef, TestSpec, TestSpecRef } from "@tessera/types";
import { artifactKey } from "@tessera/resolvers";

import { isIncomplete } from "./types.js";
import type {
  ImpactNote,
  ImpactNoteLevel,
  ImpactReport,
  IntentEntry,
  IntentReport,
} from "./types.js";

export interface IntentOptions {
  /**
   * True when the spec inventory handed in is known to be partial — a spec file
   * that failed to parse, a directory that could not be read. It cannot be
   * inferred from `specs` here, because an inventory that read nothing and an
   * inventory of a repo with no specs both arrive as an empty array, and those
   * two are the pair that must never be reported alike.
   */
  readonly inventoryIncomplete?: boolean;
}

function note(level: ImpactNoteLevel, message: string): ImpactNote {
  return { level, message };
}

/**
 * Deterministic, locale-independent string order — the same reason `analyze.ts`
 * refuses `localeCompare`: a CI log that sorts differently on two runners is a
 * log nobody can diff.
 */
function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The pre-run gap report for one impact graph and one spec inventory.
 *
 * `report` supplies the impacted artifacts, `specs` the declarations; the
 * result covers every impacted artifact, so a gap is `specs.length === 0` and
 * never a second list that can drift out of step (see `IntentReport`).
 */
export function computeIntent(
  report: ImpactReport,
  specs: readonly TestSpec[],
  options?: IntentOptions,
): IntentReport {
  // ── 1. the impacted universe ────────────────────────────────────────────
  // Insertion-ordered by `nodes` first, but nothing downstream may rely on
  // that — the sort below is what fixes the order. What matters here is that
  // both sources feed one map: an artifact in `nodes` AND in `unanalyzable`
  // is one impacted artifact, and an artifact in `unanalyzable` alone is still
  // one (QA-15).
  const impacted = new Map<string, TargetArtifactRef>();
  const untraced = new Set<string>();
  for (const node of report.graph.nodes) {
    const key = artifactKey(node);
    if (!impacted.has(key)) impacted.set(key, node);
  }
  for (const entry of report.graph.unanalyzable) {
    const key = artifactKey(entry.artifact);
    untraced.add(key);
    if (!impacted.has(key)) impacted.set(key, entry.artifact);
  }

  // ── 2. the declared links ───────────────────────────────────────────────
  // Keyed by artifact and then by `spec.ref.id`, so a spec that names one
  // artifact twice in `targets` counts once while two distinct specs aimed at
  // the same artifact both count.
  const declared = new Map<string, Map<string, TestSpecRef>>();
  // Rendered as `spec-id → table/sys_id` at collection time so the note can
  // name BOTH ends: which spec, and which target of it, missed. A count alone
  // sends the reader hunting through the repo for the one that is stale.
  const strayTargets = new Set<string>();

  for (const spec of specs) {
    for (const target of spec.targets) {
      const key = artifactKey(target);
      if (!impacted.has(key)) {
        strayTargets.add(`${spec.ref.id} → ${target.table}/${target.sysId}`);
        continue;
      }
      let refs = declared.get(key);
      if (refs === undefined) {
        refs = new Map<string, TestSpecRef>();
        declared.set(key, refs);
      }
      if (!refs.has(spec.ref.id)) refs.set(spec.ref.id, spec.ref);
    }
  }

  // ── 3. entries ──────────────────────────────────────────────────────────
  const entries: IntentEntry[] = [];
  for (const [key, artifact] of impacted) {
    const refs = declared.get(key);
    entries.push({
      artifact,
      specs:
        refs === undefined
          ? []
          : [...refs.values()].sort((left, right) =>
              compare(left.id, right.id),
            ),
      analyzable: !untraced.has(key),
    });
  }
  // (table, sysId) rather than `analyze.ts`'s (table, name, sysId): identity,
  // not label. Two rows can carry one name and an unreadable one carries the
  // resolvers' `table/sys_id` placeholder, so a name-led order is not stable
  // across a rename of something this report never mentions.
  entries.sort(
    (left, right) =>
      compare(left.artifact.table, right.artifact.table) ||
      compare(left.artifact.sysId, right.artifact.sysId),
  );

  // ── 4. notes ────────────────────────────────────────────────────────────
  // The graph's own reasoning still applies to this report — the gap set was
  // computed over exactly those artifacts — so it travels through whole and
  // first, and the intent-specific lines follow in a fixed order.
  const notes: ImpactNote[] = [...report.notes];

  const gaps = entries.filter((entry) => entry.specs.length === 0).length;
  // Deliberately not "covered": DESIGN §4a / QA-8. A spec that exists is
  // somebody's plan, and only a run is a statement about the code, so the
  // sentence says what was counted (declarations) and denies the other reading
  // outright rather than leaving a percentage to be misquoted as coverage.
  notes.push(
    note(
      "info",
      `${gaps} of ${entries.length} impacted artifact(s) have no spec declaring them as a target; this counts DECLARED INTENT only — a spec that exists is not a spec that passed, and confirmed coverage is computed after a run (DESIGN §4a, QA-8)`,
    ),
  );

  if (strayTargets.size > 0) {
    // Nothing is dropped: such a spec still counts for whichever of its other
    // targets ARE impacted. The warning exists because the alternative is
    // silence, and a spec aimed at an artifact this change does not touch is
    // either stale or misaimed — neither of which anyone finds by not looking.
    notes.push(
      note(
        "warning",
        `${strayTargets.size} declared spec target(s) are not in this impacted artifact set, so they are no evidence about this change and may be stale or misaimed: ${[...strayTargets].sort(compare).join(", ")}`,
      ),
    );
  }

  if (options?.inventoryIncomplete === true) {
    notes.push(
      note(
        "warning",
        "the spec inventory was not fully read, so the gap set may overstate the artifacts that have no spec: a spec that exists but went unread is indistinguishable here from one that was never written",
      ),
    );
  }

  // ── 5. the honest header ────────────────────────────────────────────────
  // Exactly the two rules `IntentReport.incomplete` names, and no third: an
  // incomplete graph understates the impacted set, an incomplete inventory
  // understates intent. A stray target above is neither — it is evidence about
  // some OTHER change — so it warns without flipping this flag, which is why
  // the flag is computed from the INPUT report rather than from `notes`.
  return {
    entries,
    notes,
    incomplete: isIncomplete(report) || options?.inventoryIncomplete === true,
  };
}
