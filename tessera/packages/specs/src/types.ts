// The tests-as-code vocabulary (DESIGN §4, PLAN Phase 4 read side / v0.3).
//
// DESIGN §4 fixes the source of truth: tests live as FILES in the git repo,
// next to the synced source, and are projected onto an instance at run time.
// This package owns the first half of that sentence and none of the second. It
// reads the repo. It never writes one, and it never touches an instance — the
// ATF projection writer is the other half of Phase 4 and is blocked on an owner
// decision it has no business pre-empting.
//
// Three rules shape everything below.
//
// First, the spec↔artifact link is DECLARED, never inferred from file paths
// (QA-16). The layout in DESIGN §4 is suggestive — `sys_script_include/<Name>/`
// — and it is tempting to read a target out of it. It does not work: a path
// encodes at most one table and one name, while a `ui` or `e2e` spec routinely
// exercises several artifacts at once, so the inference is wrong precisely
// where coverage matters most. The manifest is therefore the only join key.
//
// Second, an unreadable registry is not an empty one. `@tessera/impact` learned
// this against the Table API (OPP-1b: a genuinely absent row and an ACL-trimmed
// one render identically); the filesystem offers the same trap with a different
// errno. Every way this reader can fail to see the whole picture is either a
// thrown fault or a `warning` note that sets `incomplete` — never a quietly
// shorter spec list.
//
// Third, and most important: nothing here is COVERAGE. A file that exists is a
// statement about somebody's plan. Only a run is a statement about the code.
// See `IntentReport` in `@tessera/impact` for the split (DESIGN §4a, QA-8).

import type { TargetArtifactRef, TestKind, TestSpec } from "@tessera/types";

/** The registry filename inside the tests root (DESIGN §4's `.manifest.json`). */
export const SPEC_MANIFEST_FILENAME = ".manifest.json";

/**
 * The largest `.manifest.json` this reader will open, in bytes (8 MiB).
 *
 * Delegated decision 2026-09-26 (review L4, INFO): generous on purpose — an
 * entry is ~200 bytes, so this is tens of thousands of specs — and a manifest
 * above it is a `SpecStoreFaultError`, never a partial read.
 */
export const SPEC_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The directory under the tests root that `tess generate` writes proposed
 * specs into. Mirrors `PROPOSED_DIRNAME` in `@tessera/generate`'s writer.ts;
 * defined here because this package depends on `@tessera/types` alone, and
 * pinned by a test so a divergence is loud.
 */
export const PROPOSED_SPECS_DIRNAME = "proposed";

/** The only manifest shape this reader accepts; bumped, never widened silently. */
export const SPEC_MANIFEST_VERSION = 1;

/**
 * One registered spec, exactly as it appears in `.manifest.json`.
 *
 * This is the on-disk wire shape, so it is plain and loose on purpose — it
 * describes what a file may contain, not what the reader guarantees. Validation
 * turns it into a `TestSpec`, and anything that fails validation becomes a note
 * rather than a silently-coerced entry.
 */
export interface ManifestSpecEntry {
  /** Stable identity, independent of the path so a spec can be moved. */
  readonly id: string;
  /** Spec file location, relative to the tests root. */
  readonly path: string;
  readonly kind: TestKind;
  /** The QA-16 declaration: what this spec claims to exercise. */
  readonly targets: readonly TargetArtifactRef[];
}

export interface SpecManifest {
  readonly version: number;
  readonly specs: readonly ManifestSpecEntry[];
}

export type InventoryNoteLevel = "info" | "warning";

/**
 * Mirrors `ImpactNote` in shape and prints alike, deliberately duplicated
 * rather than shared: a two-member union is not worth a package dependency,
 * and `@tessera/specs` deliberately depends on `@tessera/types` alone.
 *
 * `warning` carries the same meaning it carries in `@tessera/impact` — the
 * inventory IS NOT A CLEAN ANSWER and must not be consumed as one. Both
 * directions count: an unregistered file on disk means the repo may intend
 * more than this inventory reports, and a manifest entry pointing at a missing
 * file means it may intend less.
 */
export interface InventoryNote {
  readonly level: InventoryNoteLevel;
  readonly message: string;
}

/**
 * What the repo says it intends to test.
 *
 * `specs` holds only entries that were registered in the manifest AND found on
 * disk. Both halves are load-bearing: an entry with no file is rot rather than
 * intent (a spec that cannot run cannot ever confirm anything), and a file with
 * no entry has no declared targets, so there is no honest way to join it —
 * QA-16 forbids guessing them from the path. Each dropped case leaves a
 * `warning`, so the shorter list is never the silent one.
 *
 * `payload` is left undefined on every spec. Reading the spec BODY is the
 * projection writer's job and needs the YAML step schema; the inventory joins
 * on identity and targets, and deliberately does not open the file it lists.
 */
export interface SpecInventory {
  readonly specs: readonly TestSpec[];
  readonly notes: readonly InventoryNote[];
  /** True iff any note is a `warning` — see `InventoryNote`. */
  readonly incomplete: boolean;
}

export interface ReadInventoryOptions {
  /**
   * Absolute path of the tests root — the directory holding
   * `.manifest.json` and the per-scope tree (DESIGN §4).
   */
  readonly root: string;
}

// TM-1, recorded rather than enforced — because the reasoning has an expiry
// date on it and the next person needs to know when it runs out.
//
// `Untrusted<T>` brands strings read off an INSTANCE (DESIGN §9.2): those
// arrive from a system where an attacker may have written the record, which is
// why Phase 3 started enforcing the brand rather than merely intending it.
// Manifest strings are not that. They arrive from the git repo — which is
// exactly the property tests-as-code was chosen for: a human reviewed the diff
// before anything here could read it.
//
// That argument holds only while a human is in the loop. In Phase 6 the
// GENERATOR writes these entries, and an AI authoring a target `name` that a
// later stage renders is the TM-1 shape again with a different origin. The
// review gate is the mitigation; if generated specs are ever committed without
// one, this file is where the brand has to land.
