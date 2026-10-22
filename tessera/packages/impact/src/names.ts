// The one door this package opens on an instance-authored artifact name
// (TM-1, AIS-4).
//
// Every `name` on an `InstanceArtifactRef` arrives branded: the resolvers and
// the lookups in this package brand it the moment it leaves the record,
// because a display name is whatever somebody typed into a form. The analyzer
// still has three honest uses for the text, and all of them go through here:
//
//   - a where-used SEARCH KEY: the scanner matches it as a literal identifier
//     and echoes back only what the caller asked for, never instance text;
//   - an ORDERING KEY: graph nodes and edges sort by name so a CI log diffs;
//   - a MESSAGE fragment: a note or a demanded-spec reason a human reads in a
//     terminal — only ever through `nameForMessage`, which escapes it.
//
// A fourth use has its own boundary, `wireTarget`: the demanded checklist
// row's `target` is a plain `TargetArtifactRef`, because it is serialised into
// checklists, manifests and JSON reports (a branded box would serialise as
// `{"value":...}`). Every print site of that wire name escapes it.
//
// None of these hands the text to a prompt. The generator builds its prompt
// from the branded graph and unwraps behind its own named boundary.
//
// Internal on purpose: not re-exported from `index.ts`, so no other package
// gets a second, unnamed door through `@tessera/impact`.

import { escapeForTerminal, unwrapUntrusted } from "@tessera/types";
import type { InstanceArtifactRef, TargetArtifactRef } from "@tessera/types";

const NAME_BOUNDARY =
  "impact search, ordering and escaped-message key (never a prompt)";

const WIRE_BOUNDARY =
  "demanded checklist target (wire identity, escaped wherever printed)";

/** The raw name, for matching and ordering only. Never print this value. */
export function artifactName(ref: Pick<InstanceArtifactRef, "name">): string {
  return unwrapUntrusted(ref.name, NAME_BOUNDARY);
}

/** The name as it may appear in a note or a reason: terminal-escaped. */
export function nameForMessage(ref: Pick<InstanceArtifactRef, "name">): string {
  return escapeForTerminal(artifactName(ref));
}

/** The plain wire shape of a demanded checklist row's target. */
export function wireTarget(ref: InstanceArtifactRef): TargetArtifactRef {
  return {
    table: ref.table,
    sysId: ref.sysId,
    name: unwrapUntrusted(ref.name, WIRE_BOUNDARY),
  };
}
