// The CLI's one door on an instance-authored artifact name (TM-1, AIS-4).
//
// Every `name` on an `InstanceArtifactRef` arrives branded: the resolvers and
// the impact lookups brand it the moment it leaves the record, because a
// display name is whatever somebody typed into a form. The CLI has exactly two
// honest uses for it, and both go through here:
//
//   - a TERMINAL line: `printedName`, which escapes every control, bidi and
//     zero-width character so a name cannot repaint, reorder or hide the line
//     an operator reads;
//   - a `--json` document or a `TestSpec` target: `wireRef`, the plain
//     `TargetArtifactRef` wire shape. A box would serialise as
//     `{"value":...}`, and `JSON.stringify` already escapes the C0 controls a
//     terminal would obey.

import { escapeForTerminal, unwrapUntrusted } from "@tessera/types";
import type { InstanceArtifactRef, TargetArtifactRef } from "@tessera/types";

const NAME_BOUNDARY =
  "CLI output of an instance artifact name: terminal-escaped, or a JSON/TestSpec wire field";

/** The one unwrap. Private: neither use below may print it unescaped. */
function rawName(ref: Pick<InstanceArtifactRef, "name">): string {
  return unwrapUntrusted(ref.name, NAME_BOUNDARY);
}

/** The name as a terminal line may show it: escaped. */
export function printedName(ref: Pick<InstanceArtifactRef, "name">): string {
  return escapeForTerminal(rawName(ref));
}

/** The plain wire shape: three identity fields, never a fourth. */
export function wireRef(ref: InstanceArtifactRef): TargetArtifactRef {
  return {
    table: ref.table,
    sysId: ref.sysId,
    name: rawName(ref),
  };
}
