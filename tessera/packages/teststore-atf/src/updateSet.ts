// W2 — the committed authoring-channel update set, and its offline validator
// (ADR-007; delegated decision 2026-09-23).
//
// The asset `assets/tessera-authoring-channel.update-set.xml` is what an admin
// imports once (C2). It must stay exactly this small, and this validator is
// the gate that keeps it so:
//   * one `sys_user_role` — `x_tessera.author`;
//   * the `sys_security_acl` rows (create / write / delete on
//     `sys_variable_value`, conditioned `document=sys_atf_step` through the
//     condition builder, i.e. `current.document == 'sys_atf_step'` without a
//     line of script), each bound to that role by a `sys_security_acl_role`;
//   * one `sys_properties` row — the C4 version handshake;
//   * NOTHING else. In particular no `sys_user_has_role` (C6: the grant is a
//     human runbook step, never shipped) and no Scripted REST or other code
//     (C5 + "zero code").
//
// Why three ACLs where the design note says "write": ServiceNow evaluates
// create, write and delete as separate operations, and the store creates the
// step-input row when the platform did not auto-create it (Spike 0) and
// deletes it in teardown (DEV-13). A write-only ACL would leave both of those
// on whatever the instance's default is.
//
// The parser is deliberately minimal (no XML dependency): an update-set
// export is a flat, machine-written document, and every construct the
// validator does not recognise is reported rather than skipped.

import {
  AUTHORING_CHANNEL_ROLE,
  AUTHORING_CHANNEL_VERSION,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
  parseChannelVersion,
} from "./channel.js";

/** Tables the update set may carry. Anything else is a validation problem. */
export const AUTHORING_CHANNEL_ALLOWED_TABLES: ReadonlySet<string> = new Set([
  "sys_user_role",
  "sys_security_acl",
  "sys_security_acl_role",
  "sys_properties",
]);

/** Tables that grant a role to a principal — never shipped (C6). */
export const AUTHORING_CHANNEL_FORBIDDEN_TABLES: readonly string[] = [
  "sys_user_has_role",
  "sys_user_grmember",
];

/** The operations the channel's ACLs must cover on `sys_variable_value`. */
export const AUTHORING_CHANNEL_ACL_OPERATIONS: readonly string[] = [
  "create",
  "write",
  "delete",
];

/** Published file name of the asset, under the package's `assets/`. */
export const AUTHORING_CHANNEL_UPDATE_SET_FILE =
  "tessera-authoring-channel.update-set.xml";

/**
 * `file:` URL of the shipped asset. Resolved from the compiled module
 * (`build/updateSet.js` → `../assets/…`), so it holds for the workspace link.
 */
export const AUTHORING_CHANNEL_UPDATE_SET_URL = new URL(
  `../assets/${AUTHORING_CHANNEL_UPDATE_SET_FILE}`,
  import.meta.url,
);

/** One record found inside a `sys_update_xml` payload. */
export interface UpdateSetRecord {
  readonly table: string;
  readonly action: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface UpdateSetValidation {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly records: readonly UpdateSetRecord[];
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&amp;": "&",
};

function unescapeXml(text: string): string {
  return text.replace(
    /&(?:lt|gt|quot|apos|amp);/g,
    (m) => XML_ENTITIES[m] ?? m,
  );
}

/** Text content of an element body: CDATA unwrapped, entities decoded. */
function textOf(body: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(body);
  return cdata ? (cdata[1] ?? "") : unescapeXml(body);
}

/** Direct child elements of a flat record body → `{ name: text }`. */
function fieldsOf(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /<([A-Za-z_][\w.]*)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (const match of body.matchAll(re)) {
    const name = match[1];
    if (name === undefined) continue;
    fields[name] = match[2] === undefined ? "" : textOf(match[2]).trim();
  }
  return fields;
}

/** Records inside one `<record_update>` payload document. */
function recordsOfPayload(
  payload: string,
  problems: string[],
): UpdateSetRecord[] {
  const update = /<record_update\b[^>]*>([\s\S]*?)<\/record_update>/.exec(
    payload,
  );
  if (!update) {
    problems.push("a sys_update_xml payload holds no <record_update> document");
    return [];
  }
  const records: UpdateSetRecord[] = [];
  const re = /<([A-Za-z_][\w.]*)\s+action="([A-Z_]+)"\s*>([\s\S]*?)<\/\1>/g;
  for (const match of (update[1] ?? "").matchAll(re)) {
    records.push({
      table: match[1] ?? "",
      action: match[2] ?? "",
      fields: fieldsOf(match[3] ?? ""),
    });
  }
  if (records.length === 0) {
    problems.push("a <record_update> payload carries no record");
  }
  return records;
}

/**
 * Validate an authoring-channel update-set export. Pure: takes the XML text,
 * returns every problem found (empty = valid) plus the records it parsed.
 */
export function validateAuthoringChannelUpdateSet(
  xml: string,
  expectedVersion: string = AUTHORING_CHANNEL_VERSION,
): UpdateSetValidation {
  const problems: string[] = [];

  // C6 first and on the raw text: a role grant is refused wherever it hides —
  // a payload, a comment, an attribute — not only where the parser looks.
  for (const table of AUTHORING_CHANNEL_FORBIDDEN_TABLES) {
    if (xml.includes(table)) {
      problems.push(
        `the update set mentions ${table}: role grants are a human runbook step and are never shipped (C6)`,
      );
    }
  }

  if (!/<unload\b[^>]*>[\s\S]*<\/unload>\s*$/.test(xml.trim())) {
    problems.push("the document is not an update-set export (<unload> root)");
  }
  const remoteSets = [
    ...xml.matchAll(
      /<sys_remote_update_set\b[^>]*>([\s\S]*?)<\/sys_remote_update_set>/g,
    ),
  ];
  if (remoteSets.length !== 1) {
    problems.push(
      `expected exactly one <sys_remote_update_set>, found ${remoteSets.length}`,
    );
  }
  const setSysId = fieldsOf(remoteSets[0]?.[1] ?? "")["sys_id"] ?? "";

  const records: UpdateSetRecord[] = [];
  const updates = [
    ...xml.matchAll(/<sys_update_xml\b[^>]*>([\s\S]*?)<\/sys_update_xml>/g),
  ];
  if (updates.length === 0)
    problems.push("the update set carries no <sys_update_xml>");
  for (const update of updates) {
    const body = update[1] ?? "";
    const payload = /<payload>([\s\S]*?)<\/payload>/.exec(body);
    if (!payload) {
      problems.push("a <sys_update_xml> has no <payload>");
      continue;
    }
    const owner =
      /<remote_update_set\b[^>]*>([\s\S]*?)<\/remote_update_set>/.exec(body);
    if (setSysId !== "" && (owner?.[1] ?? "").trim() !== setSysId) {
      problems.push(
        "a <sys_update_xml> does not belong to the update set's sys_remote_update_set",
      );
    }
    records.push(...recordsOfPayload(textOf(payload[1] ?? ""), problems));
  }

  for (const record of records) {
    if (!AUTHORING_CHANNEL_ALLOWED_TABLES.has(record.table)) {
      problems.push(
        `unexpected record type ${record.table}: the channel ships only ${[...AUTHORING_CHANNEL_ALLOWED_TABLES].join(", ")} — zero code, no endpoints (C5)`,
      );
    }
    if (record.action !== "INSERT_OR_UPDATE") {
      problems.push(
        `${record.table} record has action ${record.action}; only INSERT_OR_UPDATE is shipped`,
      );
    }
  }
  const of = (table: string): UpdateSetRecord[] =>
    records.filter((record) => record.table === table);

  // The role.
  const roles = of("sys_user_role");
  const role = roles.find((r) => r.fields["name"] === AUTHORING_CHANNEL_ROLE);
  if (roles.length !== 1 || role === undefined) {
    problems.push(
      `expected exactly one sys_user_role named ${AUTHORING_CHANNEL_ROLE}, found ${roles.map((r) => r.fields["name"] ?? "?").join(", ") || "none"}`,
    );
  }
  const roleSysId = role?.fields["sys_id"] ?? "";

  // The version property (C4).
  const properties = of("sys_properties");
  const property = properties.find(
    (p) => p.fields["name"] === AUTHORING_CHANNEL_VERSION_PROPERTY,
  );
  if (properties.length !== 1 || property === undefined) {
    problems.push(
      `expected exactly one sys_properties row named ${AUTHORING_CHANNEL_VERSION_PROPERTY}`,
    );
  } else {
    const shipped = parseChannelVersion(property.fields["value"] ?? "");
    const wanted = parseChannelVersion(expectedVersion);
    if (shipped === undefined) {
      problems.push(
        `${AUTHORING_CHANNEL_VERSION_PROPERTY} value "${property.fields["value"] ?? ""}" is not MAJOR.MINOR[.PATCH]`,
      );
    } else if (wanted !== undefined && shipped.major !== wanted.major) {
      problems.push(
        `${AUTHORING_CHANNEL_VERSION_PROPERTY} ships ${property.fields["value"] ?? ""}, but the store requires major ${wanted.major}`,
      );
    }
  }

  // The ACLs, one per operation, each bound to the role.
  const acls = of("sys_security_acl");
  const aclRoles = of("sys_security_acl_role");
  if (acls.length !== AUTHORING_CHANNEL_ACL_OPERATIONS.length) {
    problems.push(
      `expected ${AUTHORING_CHANNEL_ACL_OPERATIONS.length} sys_security_acl rows, found ${acls.length}`,
    );
  }
  for (const operation of AUTHORING_CHANNEL_ACL_OPERATIONS) {
    const acl = acls.find((a) => a.fields["operation"] === operation);
    if (acl === undefined) {
      problems.push(`no sys_security_acl for operation ${operation}`);
      continue;
    }
    const f = acl.fields;
    const where = `sys_security_acl (${operation})`;
    if (f["name"] !== "sys_variable_value") {
      problems.push(
        `${where} targets ${f["name"] ?? "?"}, not sys_variable_value`,
      );
    }
    if (f["type"] !== "record") problems.push(`${where} is not a record ACL`);
    if (f["active"] !== "true") problems.push(`${where} is not active`);
    if (f["advanced"] !== "false" || (f["script"] ?? "") !== "") {
      problems.push(`${where} carries a script — the channel ships zero code`);
    }
    // Delegated decision 2026-09-26: the condition must be EXACTLY
    // `document=sys_atf_step` (optionally closed by `^EQ`). A term-anywhere
    // match accepted `document=sys_atf_step^NQ…` / `^OR…`, which WIDENS the
    // ACL past ATF step inputs — any appended or prepended term is refused.
    if (!/^document=sys_atf_step(\^EQ)?$/.test(f["condition"] ?? "")) {
      problems.push(
        `${where} is not conditioned on document=sys_atf_step exactly (got ${JSON.stringify(f["condition"] ?? "")}) — any other or additional term opens sys_variable_value rows beyond ATF step inputs`,
      );
    }
    const aclSysId = f["sys_id"] ?? "";
    const bindings = aclRoles.filter(
      (r) => r.fields["sys_security_acl"] === aclSysId,
    );
    if (
      bindings.length !== 1 ||
      roleSysId === "" ||
      bindings[0]?.fields["sys_user_role"] !== roleSysId
    ) {
      problems.push(
        `${where} must be bound to ${AUTHORING_CHANNEL_ROLE} by exactly one sys_security_acl_role`,
      );
    }
  }
  if (aclRoles.length !== acls.length) {
    problems.push(
      `found ${aclRoles.length} sys_security_acl_role rows for ${acls.length} ACLs`,
    );
  }

  return { ok: problems.length === 0, problems, records };
}
