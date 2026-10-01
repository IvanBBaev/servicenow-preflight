// What "the same version" means, reduced to one hex string per side.
//
// The digest covers the artifact's EXECUTABLE fields — the script body AND the
// metadata that decides when and whether it runs (review W6a H2) — and
// nothing else.
// `sys_updated_on`, `sys_mod_count` and `sys_updated_by` differ routinely
// between two instances carrying byte-identical code — an update set import
// rewrites them on arrival — so folding them in would turn every healthy
// promotion into a reported mismatch, and a check that cries wolf on every run
// is a check people switch off.
//
// SHA-256, consistent with `compareApi`'s script hashing in `@tessera/sn-client`
// (`api/compare.ts`): scripts are large, digests are not, and a report that
// quotes two 64-character strings stays readable.

import { createHash } from "node:crypto";

import { scriptsApi } from "@tessera/sn-client";

import { ParityContractError } from "./errors.js";

/**
 * table -> the SCRIPT BODY fields of that table.
 *
 * Derived from `scriptsApi.SCRIPT_TYPES` rather than re-typed here, so the two
 * modules can never disagree about which fields carry the code. Fields are
 * unioned in the (currently hypothetical) case of two script types sharing a
 * table.
 *
 * This is NOT the version. Review W6a H2 (2026-09-26): a business rule whose
 * body is identical but which runs `after` instead of `before`, or is
 * inactive, behaves differently, and fingerprinting only the body read that as
 * `match`. The version is `EXECUTABLE_FIELDS_BY_TABLE` below; this map stays
 * exported, unchanged, for callers that want the bodies alone.
 */
export const SCRIPT_FIELDS_BY_TABLE: ReadonlyMap<string, readonly string[]> =
  buildScriptIndex();

function buildScriptIndex(): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const descriptor of Object.values(scriptsApi.SCRIPT_TYPES)) {
    const fields = index.get(descriptor.table) ?? [];
    for (const field of descriptor.scriptFields) {
      if (!fields.includes(field)) fields.push(field);
    }
    index.set(descriptor.table, fields);
  }
  return index;
}

/** `undefined` for a table with no script body in `SCRIPT_TYPES`. */
export function scriptFieldsFor(table: string): readonly string[] | undefined {
  return SCRIPT_FIELDS_BY_TABLE.get(table);
}

/**
 * How a blank value (`""`) of a field is read — review W6a M4.
 *
 * Delegated decision 2026-09-26: the Table API renders an unset field as `""`,
 * and it renders a field the connected user may not read the same way (a
 * field-level read ACL blanks the value). "Blank on both sides" is therefore
 * two blind reads as often as it is two equal versions, and it used to hash as
 * a match. The rule, per field kind:
 *
 * - `flag` — a field a readable record never renders blank: a mandatory
 *   choice, reference or boolean (`active`, `when`, `operation`, `table`...).
 *   Blank is always unreadable, and the row is `undecidable`.
 * - `text` — an optional field whose blank MAY be its unset value
 *   (`condition`; `order` is NOT one — see below). Blank is unreadable unless
 *   a gate in the same record PROVES the field inert (`inertWhen`).
 * - `script` — a body. Blank is unreadable unless a gate in the same record
 *   PROVES the body inert (`inertWhen`): then its content cannot affect what
 *   runs, and blank hashes. Otherwise a blank body on both sides is
 *   `undecidable`, never a match (review repro P2).
 *
 * Delegated decision 2026-09-30 (wave 14): a blank `text` field no longer
 * hashes as "unset" on the strength of the record's non-blank flags. The flags
 * prove the ROW readable, not each field of it: a field-level read ACL on
 * exactly `condition` (say) blanks that one value and leaves every flag
 * alone, and two such blind reads used to hash equal — a green for a
 * condition nobody read. Nothing the Table API returns separates "unset" from
 * "not shown": a denied field renders `""` under every `sysparm_display_value`
 * mode, and a `sysparm_query` probe on the field is itself subject to query
 * ACLs and to the instance silently dropping a term it will not evaluate.
 * So readability is established only by an `inertWhen` gate — the one proof
 * available offline — and otherwise the field is unreadable (fail closed):
 * `undecidable` when blank on both sides, and also when blank on ONE side
 * only, because that blank may be a hidden value equal to the other side's.
 * The cost is real and deliberate: a business rule with no condition is no
 * longer a clean `match`. Reversible: re-admitting `text` blanks is the one
 * `kind === "text"` short-circuit this decision removed from
 * `readExecutableFields`.
 *
 * An ABSENT key is unreadable for every kind (see `rawField`).
 */
export type ExecutableFieldKind = "flag" | "text" | "script";

interface FieldSpec {
  readonly name: string;
  readonly kind: ExecutableFieldKind;
}

/**
 * A gate: `field` reading exactly one of `values` proves the gated field's
 * content cannot affect what runs, so its blank is hashable.
 */
interface InertGate {
  readonly field: string;
  readonly values: readonly string[];
}

/**
 * Rows of another table that carry part of this record's behaviour, read as a
 * set of `valueField` values per parent (the live reader's `readRelated`).
 */
export interface RelatedSpec {
  /** The child table, e.g. `sys_security_acl_role`. */
  readonly table: string;
  /** The child's reference to the parent record, e.g. `sys_security_acl`. */
  readonly parentField: string;
  /** The child field whose values are compared, e.g. `sys_user_role.name`. */
  readonly valueField: string;
  /** What the set is, for evidence ("required roles"). */
  readonly label: string;
}

interface TableSpec {
  readonly fields: readonly FieldSpec[];
  /** field -> the gate that proves a blank value of it cannot run. */
  readonly inertWhen?: Readonly<Record<string, InertGate>>;
  /**
   * Behaviour that lives OUTSIDE this record and is not read. Set, it keeps
   * an all-equal row from ever being a clean `match` (fail closed, H2) —
   * unless `related` is set AND the reader can read it completely.
   */
  readonly uncompared?: string;
  /** The outside behaviour, when this stage knows how to read it. */
  readonly related?: RelatedSpec;
}

const flag = (name: string): FieldSpec => ({ name, kind: "flag" });
const text = (name: string): FieldSpec => ({ name, kind: "text" });
const script = (name: string): FieldSpec => ({ name, kind: "script" });

/**
 * The executable field set per table — review W6a H2.
 *
 * Delegated decision 2026-09-26: explicit, per table, and SEPARATE from
 * `SCRIPT_TYPES`. Every field name is quoted from a source already in this
 * repository; none is invented. Sources, abbreviated in the comments below:
 *
 * - [meta]  `SCRIPT_TYPES[*].metaFields` in `@tessera/sn-client`
 *           (`src/api/scripts.ts`), the per-type metadata the vendored client
 *           already reads next to the body;
 * - [flows] `@tessera/sn-client` `src/api/flows.ts` (sys_script
 *           `action_insert`/`action_update`/`action_delete`/`action_query`,
 *           `filter_condition`);
 * - [xml]   `packages/teststore-atf/assets/tessera-authoring-channel
 *           .update-set.xml` (the sys_security_acl record Tessera ships:
 *           `advanced`, `condition`, `decision_type`, `name`);
 * - [acl]   the preflight repo's `src/checks/acl-role-sanity.ts` (its
 *           sys_security_acl field list, and `sys_security_acl_role` as the
 *           role join);
 * - [rest]  the preflight repo's `src/checks/rest-endpoint-security.ts`
 *           (`requires_authentication`, `requires_acl_authorization`);
 * - [runas] the preflight repo's `src/checks/scheduled-job-run-as.ts`
 *           (`run_as`);
 * - [brief] named in the W6a fix brief (sys_script `advanced`; sys_ui_policy
 *           `conditions`, `on_load`, `reverse_if_false`);
 * - [platform] standard platform dictionary, no in-repo source — used once
 *           (sys_ui_action `condition`) and flagged there.
 *
 * Known gaps, left out BECAUSE no in-repo source names them (a guessed name
 * the instance does not know would come back absent and make every row
 * undecidable): business-rule `add_message`/`abort_action`/`set_field_value`
 * style action fields, client-script `isolate_script`/`global`/`view`,
 * scheduled-job `conditional`/`condition`, transform-script `active`.
 *
 * A `SCRIPT_TYPES` table with no entry here is NOT comparable (fail closed):
 * a new script type does not become "compared by body only" by default.
 */
const TABLE_SPECS: Readonly<Record<string, TableSpec>> = {
  sys_script: {
    fields: [
      flag("active"), // [meta]
      flag("collection"), // [meta]
      flag("when"), // [meta]
      flag("order"), // [meta] — numeric with a default, never blank
      flag("action_insert"), // [flows]
      flag("action_update"), // [flows]
      flag("action_delete"), // [flows]
      flag("action_query"), // [flows]
      flag("advanced"), // [brief]
      text("condition"), // [meta]
      text("filter_condition"), // [flows]
      script("script"), // SCRIPT_TYPES.business_rule.scriptFields
    ],
  },
  sys_security_acl: {
    fields: [
      flag("active"), // [meta] [acl] [xml]
      flag("name"), // [acl] [xml]
      flag("operation"), // [meta] [acl] [xml]
      flag("type"), // [meta] [acl] [xml]
      flag("admin_overrides"), // [meta] [acl] [xml]
      flag("advanced"), // [xml]
      flag("decision_type"), // [xml]
      text("condition"), // [acl] [xml]
      script("script"), // SCRIPT_TYPES.acl.scriptFields
    ],
    // Delegated decision 2026-09-26: the roles an ACL requires live in
    // sys_security_acl_role rows [acl] [xml], a second query per ACL. Without
    // that query an ACL whose own fields are identical is never a clean
    // `match` — it is `undecidable` with this line as the reason (fail closed).
    uncompared: "its required roles (sys_security_acl_role) are not compared",
    // Delegated decision 2026-09-30 (wave 14): read them when the reader can
    // (`readRelated`), compared BY ROLE NAME (`sys_user_role.name`, the
    // dot-walk [acl] already reads): a role created separately on each
    // instance carries a different sys_id and the same meaning. A read that
    // is not provably complete still falls back to `uncompared` above.
    related: {
      table: "sys_security_acl_role",
      parentField: "sys_security_acl",
      valueField: "sys_user_role.name",
      label: "required roles",
    },
  },
  sys_script_include: {
    fields: [
      flag("active"), // [meta]
      flag("api_name"), // [meta]
      flag("access"), // [meta]
      flag("client_callable"), // [meta]
      script("script"), // SCRIPT_TYPES.script_include.scriptFields
    ],
  },
  sys_script_client: {
    fields: [
      flag("active"), // [meta]
      flag("table"), // [meta]
      flag("type"), // [meta]
      flag("ui_type"), // [meta]
      text("field"), // [meta] — blank for onLoad/onSubmit scripts
      script("script"), // SCRIPT_TYPES.client_script.scriptFields
    ],
    // Delegated decision 2026-09-30 (wave 14): `field` names the field an
    // onChange/onCellEdit script watches; an onLoad or onSubmit script never
    // reads it, so its blank is inert there. The two type values are
    // [platform] knowledge with no in-repo source — a wrong spelling only
    // fails to fire the gate, which leaves the blank unreadable (fail closed).
    inertWhen: {
      field: { field: "type", values: ["onLoad", "onSubmit"] },
    },
  },
  sys_ui_policy: {
    fields: [
      flag("active"), // [meta]
      flag("table"), // [meta]
      flag("run_scripts"), // [meta]
      flag("on_load"), // [brief]
      flag("reverse_if_false"), // [brief]
      text("conditions"), // [brief]
      script("script_true"), // SCRIPT_TYPES.ui_policy.scriptFields
      script("script_false"), // SCRIPT_TYPES.ui_policy.scriptFields
    ],
    // Delegated decision 2026-09-26: the policy's scripts only run when
    // `run_scripts` is true, so `run_scripts = "false"` proves a blank body
    // inert and it hashes.
    inertWhen: {
      script_true: { field: "run_scripts", values: ["false"] },
      script_false: { field: "run_scripts", values: ["false"] },
    },
    // Delegated decision 2026-09-26: most of what a UI policy does lives in
    // its sys_ui_policy_action rows, which are not read. Fail closed.
    // Delegated decision 2026-09-30 (wave 14): still not read. Unlike the ACL
    // role join (one value per row, named in [acl]), an action row is a
    // multi-field record (target field, visible/mandatory/read-only/cleared
    // choices...) and no source in this repository names those fields; a
    // guessed name would come back absent and decide nothing.
    uncompared: "its UI policy actions (sys_ui_policy_action) are not compared",
  },
  sys_ui_action: {
    fields: [
      flag("active"), // [meta]
      flag("table"), // [meta]
      flag("client"), // [meta]
      flag("order"), // [meta] — numeric with a default, never blank
      text("action_name"), // [meta] — optional on the form
      text("condition"), // [platform] — no in-repo source; the one exception
      script("script"), // SCRIPT_TYPES.ui_action.scriptFields
    ],
  },
  sysauto_script: {
    fields: [
      flag("active"), // [meta]
      flag("run_type"), // [meta]
      text("run_time"), // [meta]
      text("run_as"), // [runas] — blank = run as the system
      script("script"), // SCRIPT_TYPES.scheduled_job.scriptFields
    ],
  },
  sys_transform_script: {
    fields: [
      flag("map"), // [meta]
      flag("when"), // [meta]
      flag("order"), // [meta] — numeric with a default, never blank
      script("script"), // SCRIPT_TYPES.transform.scriptFields
    ],
  },
  sys_ws_operation: {
    fields: [
      flag("active"), // [meta]
      flag("web_service_definition"), // [meta]
      flag("http_method"), // [meta]
      flag("operation_uri"), // [meta]
      flag("requires_authentication"), // [rest]
      flag("requires_acl_authorization"), // [rest]
      script("operation_script"), // SCRIPT_TYPES.rest_operation.scriptFields
    ],
  },
};

/**
 * The resolved specs: only tables `SCRIPT_TYPES` knows AND this file
 * specifies. Every script field of the table is folded in as `script` kind if
 * the spec above missed it, so the body can never drop out of the version.
 */
const EXECUTABLE_SPECS: ReadonlyMap<string, TableSpec> = buildExecutableSpecs();

function buildExecutableSpecs(): ReadonlyMap<string, TableSpec> {
  const specs = new Map<string, TableSpec>();
  for (const [table, scriptFields] of SCRIPT_FIELDS_BY_TABLE) {
    const spec = Object.hasOwn(TABLE_SPECS, table)
      ? TABLE_SPECS[table]
      : undefined;
    if (spec === undefined) continue;
    const names = new Set(spec.fields.map((field) => field.name));
    const fields = [
      ...spec.fields,
      ...scriptFields.filter((name) => !names.has(name)).map(script),
    ];
    specs.set(table, { ...spec, fields });
  }
  return specs;
}

/** table -> every executable field that defines its version (H2). */
export const EXECUTABLE_FIELDS_BY_TABLE: ReadonlyMap<
  string,
  readonly string[]
> = new Map(
  [...EXECUTABLE_SPECS].map(([table, spec]) => [
    table,
    spec.fields.map((field) => field.name),
  ]),
);

/** `undefined` for a table this stage cannot fingerprint — never a guess. */
export function executableFieldsFor(
  table: string,
): readonly string[] | undefined {
  return EXECUTABLE_FIELDS_BY_TABLE.get(table);
}

/**
 * What of this table's behaviour is NOT compared by its executable fields, or
 * `undefined` when those fields are the whole story. For a table with
 * `relatedFor`, this is what stands when the related rows cannot be read.
 */
export function uncomparedFor(table: string): string | undefined {
  return EXECUTABLE_SPECS.get(table)?.uncompared;
}

/**
 * The related rows that carry the rest of this table's behaviour, when this
 * stage knows how to read and compare them; `undefined` otherwise.
 */
export function relatedFor(table: string): RelatedSpec | undefined {
  return EXECUTABLE_SPECS.get(table)?.related;
}

/** Every table parity can compare, for evidence that names the alternatives. */
export function comparableTables(): readonly string[] {
  return [...EXECUTABLE_FIELDS_BY_TABLE.keys()].sort();
}

/**
 * Why a record could not be digested. A string, not a digest: the caller turns
 * it into an `undecidable` row's evidence.
 */
export type FingerprintResult =
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly reason: string };

/**
 * One field as read: the text that gets hashed, or why there is none. The
 * `reason` is `"<field> (<why>)"`, ready to be listed in evidence.
 */
export type FieldRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * One field's value as the text that gets hashed, BEFORE the blank rule.
 *
 * Delegated decision 2026-09-25: only the shapes the Table API actually uses
 * under `sysparm_display_value=false` are hashable — a string, a number or
 * boolean, or a `{ value }` wrapper whose `value` is one of those. Everything
 * else fails closed and makes the row `undecidable`:
 *
 * - an ABSENT key: the Table API omits a requested field it does not know or
 *   will not show, so "absent on both sides" is two blind reads, not a match;
 * - JSON `null`: the Table API renders an empty field as `""`, not `null`, so
 *   a `null` is a shape nobody has characterised;
 * - a `{ display_value }` object with no `value`, or any other object/array:
 *   the display rendering is not the stored code.
 *
 * Delegated decision 2026-09-26 (review W6a L5): a string that is not
 * well-formed UTF-16 (a lone surrogate) is unreadable too. UTF-8 encoding
 * replaces a lone surrogate with U+FFFD, so `"x\uD800"` and `"x\uFFFD"`
 * hashed alike (review repro P3); no instance stores a lone surrogate as code,
 * so refusing it costs nothing and removes the collision.
 */
function rawField(
  record: Readonly<Record<string, unknown>>,
  field: string,
): FieldRead {
  const refuse = (why: string): FieldRead => ({
    ok: false,
    reason: `${field} (${why})`,
  });
  if (!Object.hasOwn(record, field)) return refuse("absent");
  const value = record[field];
  let text = scalarText(value);
  if (
    text === undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "value")
  ) {
    text = scalarText((value as { value: unknown }).value);
  }
  if (text === undefined) return refuse(describeShape(value));
  if (!isWellFormed(text)) {
    return refuse("not well-formed UTF-16: it carries a lone surrogate");
  }
  return { ok: true, text };
}

function isWellFormed(text: string): boolean {
  // `String.prototype.isWellFormed` is Node >= 20 (the engines floor) but not
  // in the ES2022 lib this package compiles against.
  return (text as unknown as { isWellFormed(): boolean }).isWellFormed();
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object"
    ? "an object with no scalar `value`"
    : typeof value;
}

const BLANK_UNPROVEN =
  "blank — an unset value and a value the connected user may not read both render blank, and nothing in this record proves which";

/**
 * Every executable field of `table` as read from `record`, with the M4 blank
 * rule applied (see `ExecutableFieldKind`). `undefined` for a table this stage
 * cannot fingerprint.
 */
export function readExecutableFields(
  table: string,
  record: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, FieldRead> | undefined {
  const spec = EXECUTABLE_SPECS.get(table);
  if (spec === undefined) return undefined;
  const reads = new Map<string, FieldRead>();
  for (const { name, kind } of spec.fields) {
    const read = rawField(record, name);
    if (!read.ok || read.text !== "") {
      reads.set(name, read);
      continue;
    }
    // Blank, of any kind, from here on: only a gate proves it hashable. A
    // `flag` carries no gate (it never renders blank when readable).
    const gate = kind === "flag" ? undefined : spec.inertWhen?.[name];
    const gateRead =
      gate === undefined ? undefined : rawField(record, gate.field);
    const inert =
      gate !== undefined &&
      gateRead?.ok === true &&
      gate.values.includes(gateRead.text);
    reads.set(
      name,
      inert ? read : { ok: false, reason: `${name} (${BLANK_UNPROVEN})` },
    );
  }
  return reads;
}

/**
 * Byte-exact over the field values, in the given field order. Whitespace is
 * NOT normalized: parity claims the runner carries the version that was
 * resolved, not a version that probably behaves the same.
 *
 * Each field is fed in name- and length-prefixed rather than joined on a
 * separator, because a script can contain any separator you might pick.
 *
 * Delegated decision 2026-09-26 (review W6a L5): the length prefix is the
 * UTF-8 BYTE length (`Buffer.byteLength`) of exactly the bytes hashed after
 * it, not the UTF-16 `.length`, so prefix and payload measure the same thing.
 */
function digestTexts(
  fields: readonly string[],
  texts: ReadonlyMap<string, string>,
): string {
  const digest = createHash("sha256");
  for (const field of fields) {
    const text = texts.get(field) ?? "";
    digest.update(`${field}:${Buffer.byteLength(text, "utf8")}:`, "utf8");
    digest.update(text, "utf8");
  }
  return digest.digest("hex");
}

/**
 * The side's digest over `reads`, or why there is none. Any unreadable field
 * makes the whole side undigestable — a digest over a partial record is a
 * claim about code nobody read.
 */
export function digestFieldReads(
  fields: readonly string[],
  reads: ReadonlyMap<string, FieldRead>,
): FingerprintResult {
  const texts = new Map<string, string>();
  const unreadable: string[] = [];
  for (const field of fields) {
    const read = reads.get(field) ?? rawField({}, field);
    if (read.ok) texts.set(field, read.text);
    else unreadable.push(read.reason);
  }
  if (unreadable.length > 0) {
    return {
      ok: false,
      reason: `no hashable value for ${unreadable.join(", ")}`,
    };
  }
  return { ok: true, digest: digestTexts(fields, texts) };
}

/**
 * The digest of `record` over `fields`, with no table to interpret them.
 *
 * Delegated decision 2026-09-26 (review W6a M4): with no table there is no
 * field kind and no gate, so nothing can PROVE a blank field readable — a
 * blank value is refused here exactly like an absent one. The check itself
 * uses `readExecutableFields`, which knows which blanks are an unset value.
 */
export function fingerprintRecord(
  record: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): FingerprintResult {
  const reads = new Map<string, FieldRead>();
  for (const field of fields) {
    const read = rawField(record, field);
    reads.set(
      field,
      read.ok && read.text === ""
        ? { ok: false, reason: `${field} (${BLANK_UNPROVEN})` }
        : read,
    );
  }
  return digestFieldReads(fields, reads);
}

/**
 * The digest, or a thrown `ParityContractError` when a field has no hashable
 * value. Kept for callers that already hold a well-formed record; the check
 * itself uses `readExecutableFields` so an unhashable field becomes a row,
 * not a throw.
 *
 * Delegated decision 2026-09-25: this used to hash an absent or unrecognised
 * value as `""`. It now refuses instead — fail closed — rather than returning
 * a digest that two blind reads would share.
 */
export function fingerprint(
  record: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): string {
  const result = fingerprintRecord(record, fields);
  if (!result.ok)
    throw new ParityContractError(`cannot fingerprint: ${result.reason}`);
  return result.digest;
}
