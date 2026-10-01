// W2 authoring channel — identity and the C4 version handshake (ADR-007;
// delegated decision 2026-09-23).
//
// W2 is a committed update set an admin installs ONCE (C2): one role, the
// `sys_variable_value` ACLs that role unlocks, and one `sys_properties` row
// carrying the channel's version. Zero code. The store reads that row before
// its first write and:
//   * refuses when it is absent (C3 — the channel is not installed, and a
//     projection without it dies on the step-input write with an opaque 403
//     half way through a run);
//   * refuses on a MAJOR mismatch or an unreadable version (C4 — the ACL
//     contract this code relies on is not the one installed);
//   * warns on a MINOR mismatch and proceeds;
//   * never installs, upgrades or grants anything itself (C2/C6).
//
// `@tessera/doctor` re-declares the property name and major for its own C3
// precondition rather than importing this package (doctor rule #2). The two
// copies are pinned equal by a doctor test; change them together.

import {
  asRecord,
  fieldString,
  requestOrFault,
  TestStoreRefusalError,
  type TestStoreHttpClient,
} from "./client.js";

/** `sys_properties.name` of the W2 version row. */
export const AUTHORING_CHANNEL_VERSION_PROPERTY = "x_tessera.channel.version";

/** The channel version this build of the store was written against. */
export const AUTHORING_CHANNEL_VERSION = "1.0.0";

/** The role the W2 ACLs require; granted by a human, never by the CLI (C6). */
export const AUTHORING_CHANNEL_ROLE = "x_tessera.author";

export interface ParsedChannelVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** `MAJOR.MINOR[.PATCH]`, digits only; anything else is `undefined`. */
export function parseChannelVersion(
  raw: string,
): ParsedChannelVersion | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? "0"),
  };
}

export type ChannelVersionVerdict =
  | { readonly outcome: "compatible"; readonly installed: string }
  | {
      readonly outcome: "minor-mismatch";
      readonly installed: string;
      readonly warning: string;
    };

/**
 * Pure C4 comparison. Returns the verdict for a compatible version and THROWS
 * a {@link TestStoreRefusalError} for an incompatible or unparseable one.
 */
export function compareChannelVersion(
  installed: string,
  expected: string = AUTHORING_CHANNEL_VERSION,
): ChannelVersionVerdict {
  const want = parseChannelVersion(expected);
  if (want === undefined) {
    throw new TypeError(
      `expected channel version "${expected}" is not MAJOR.MINOR[.PATCH]`,
    );
  }
  const have = parseChannelVersion(installed);
  if (have === undefined) {
    throw new TestStoreRefusalError(
      "channel-incompatible",
      `the W2 authoring channel reports version "${installed}" in ${AUTHORING_CHANNEL_VERSION_PROPERTY}, which is not MAJOR.MINOR[.PATCH] — refusing rather than guessing compatibility (C4)`,
    );
  }
  if (have.major !== want.major) {
    throw new TestStoreRefusalError(
      "channel-incompatible",
      `the installed W2 authoring channel is version ${installed} but this Tessera needs major ${want.major} (${expected}) — install the matching update set; Tessera never upgrades it itself (C4)`,
    );
  }
  if (have.minor !== want.minor) {
    return {
      outcome: "minor-mismatch",
      installed,
      warning: `the installed W2 authoring channel is version ${installed}, this Tessera was built against ${expected}; proceeding (same major), but consider installing the matching update set (C4)`,
    };
  }
  return { outcome: "compatible", installed };
}

/**
 * Read the W2 version row and apply {@link compareChannelVersion}. An absent
 * row is C3's refusal. A transport failure (including a read ACL's 403)
 * rejects as the package's infrastructure fault — fail closed either way.
 */
export async function checkAuthoringChannel(
  client: TestStoreHttpClient,
  expected: string = AUTHORING_CHANNEL_VERSION,
): Promise<ChannelVersionVerdict> {
  const params = new URLSearchParams({
    sysparm_query: `name=${AUTHORING_CHANNEL_VERSION_PROPERTY}`,
    sysparm_fields: "sys_id,name,value",
    sysparm_limit: "2",
    sysparm_exclude_reference_link: "true",
  });
  const response = await requestOrFault<unknown>(
    client,
    { method: "GET", path: "/api/now/table/sys_properties", params },
    `GET sys_properties (W2 channel version ${AUTHORING_CHANNEL_VERSION_PROPERTY})`,
  );
  const rows = asRecord(response.data)?.["result"];
  const first = Array.isArray(rows) ? asRecord(rows[0]) : undefined;
  if (first === undefined) {
    throw new TestStoreRefusalError(
      "channel-absent",
      `the W2 authoring channel is not installed: no ${AUTHORING_CHANNEL_VERSION_PROPERTY} row in sys_properties. An admin installs assets/tessera-authoring-channel.update-set.xml once and grants ${AUTHORING_CHANNEL_ROLE} to the Tessera user by hand (C2/C3/C6)`,
    );
  }
  return compareChannelVersion(fieldString(first, "value"), expected);
}
