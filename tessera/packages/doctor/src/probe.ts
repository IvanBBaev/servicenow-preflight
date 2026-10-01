// The read-only surface the preconditions are allowed to touch.
//
// Deliberately narrow. The doctor answers readiness questions and NOTHING else,
// so the port exposes three reads and no write of any kind — that is what makes
// it safe to point at any role in the topology, `target` included (ARCH-8).
//
// Each probe returns a CLOSED outcome union instead of throwing, because the
// difference between "the instance said no" and "the instance did not say"
// is the whole point of the three-state contract. A thrown error would collapse
// both into one.
//
// ── The DEV-1 error boundary: why `ServiceNowError` is read here ────────────
//
// The 2026-08-26 ruling in `runner-atf/src/client.ts` normalised that package's
// transport faults into one owned type. It does not extend to here, and the
// difference is not tidiness. The runner REJECTS: a `ServiceNowError` escaping
// `Runner.run` reached `@tessera/core` and would have coupled every future
// caller of a `Runner` to a ServiceNow client. This adapter never rejects — it
// converts every fault into a member of the closed unions above, so no consumer
// of `InstanceProbe` can meet a transport type at all. That is the outcome the
// ruling was after, reached one layer lower down; the ruling says as much in
// its own carve-out, where `createSnAtfClient` "stays a pass-through: it is the
// far side of the port". An adapter is allowed to know its transport; that is
// what makes it an adapter. `instanceof ServiceNowError` becomes a defect here
// only if it ever moves INWARD, past `InstanceProbe`.
//
// What that costs, and what pins it: `denied` claims the INSTANCE answered 403,
// and that claim rests on something this file does not state anywhere else —
// every probe below calls `snRequest` DIRECTLY. `@tessera/sn-client` also
// fabricates a 403 `ServiceNowError`, before any request is sent, when
// `SN_TABLES_ALLOW`/`SN_TABLES_DENY` refuses a table; but that guard
// (`assertTableAllowed`) sits in the `tableApi` layer, which nothing here
// calls. Move a probe onto `tableApi` — the obvious tidy-up, since it is the
// higher-level API — and the doctor starts reporting the operator's own config
// as the instance's refusal, complete with a remedy for an ACL that is not the
// problem. `@tessera/resolvers` is on that path and has to word its 403 under
// both readings; the doctor does not, and this is the whole of the reason.
// Pinned by "never reports a client-side table-policy denial as the instance's
// refusal" in `test/doctor.test.js`.
//
// The same type has a second way of not meaning "the instance answered", and
// it is quieter: a `ServiceNowError` with NO `status` never carried an HTTP
// response at all. `AccessProbe.status` and `ApiProbe.status` mean "what the
// instance answered with", so neither the field nor the detail line may be
// filled in from one that does not exist. Pinned by "never attributes a status
// to a probe the instance never answered" in `test/doctor.test.js`; see
// `NO_STATUS` below.

import { ServiceNowError, snRequest } from "@tessera/sn-client";
import {
  decidePropertyRows,
  incompletePropertyRead,
  normalisePropertyValue,
  PRODUCTION_PROPERTY,
  PRODUCTION_SAFE_DIRECTION,
  PROPERTY_READ_LIMIT,
  SYS_PROPERTIES_TABLE,
} from "@tessera/types";

// Delegated decision 2026-09-30 (wave 16): the sys_properties table name, the
// property row/read limits and the incomplete-read rule bound to them are
// declared once, in `@tessera/types`, and re-exported here under the names
// this package always exported them by. `@tessera/phase05` re-exports the same
// bindings, so the two probes cannot drift to different limits. The comment
// history for the limits (wave 14: read one row more than compared) lives
// with the declarations there.
export {
  PROPERTY_READ_LIMIT,
  PROPERTY_ROW_LIMIT,
  SYS_PROPERTIES_TABLE,
} from "@tessera/types";

/**
 * Why a `sys_properties` read for one name cannot be taken as complete, or
 * `undefined` when it can. Re-exported as-is from `@tessera/types`
 * (`incompletePropertyRead`): overflow past `PROPERTY_ROW_LIMIT`, or fewer
 * rows than X-Total-Count (zero rows included). An incomplete read is
 * `undecidable`, never a value; the production flag alone still resolves when
 * a row it DID see already reads in the production direction.
 */
export { incompletePropertyRead as incompleteRead };

/**
 * `denied` = the instance answered 403: a real, attributable "no".
 * `undecidable` = no usable answer (401, 5xx, timeout, transport, no creds,
 * or an incomplete read — including no rows under a larger X-Total-Count).
 * `absent` = no row came back AND nothing says one was hidden; it never
 * stands for rows the count saw but read ACLs removed.
 * `denied` and `undecidable` are kept apart because only the first is worth
 * a remedy.
 */
export interface PropertyProbe {
  readonly outcome: "found" | "absent" | "denied" | "undecidable";
  readonly value?: string;
  /**
   * Identity of the row that answered, when it answered. A remedy that wants to
   * change this property must address the row it actually observed — updating
   * by name would be a blind write against whatever matches at apply time.
   */
  readonly sysId?: string;
  /**
   * Set only when MORE than one `sys_properties` row answered for the name.
   * `identical` — every row gives the same (trimmed, case-folded) value, so
   * the reading is unambiguous and `outcome` is `found`. `differing` — the rows
   * disagree; `outcome` is then `undecidable`, except for
   * `glide.installation.production`, which reads `found` in the production
   * direction (see `readProperty`). A caller that ignores this field still
   * fails closed: a differing read never arrives as a plain `found` value that
   * depends on row order.
   */
  readonly duplicates?: "identical" | "differing";
  /**
   * Every row that answered, in response order. Present with `duplicates`,
   * and on an `incomplete` read that saw at least one row — whatever its
   * outcome — so a caller with a safe direction of its own can settle the
   * read from a row it DID see (`decidePropertyRows(values, false, …)`).
   * Values are instance-authored text: data to decide on, never to quote.
   */
  readonly rows?: readonly PropertyRow[];
  /**
   * Set (to `true`) only when the read cannot be taken as the whole picture —
   * overflow past `PROPERTY_ROW_LIMIT`, or fewer rows than X-Total-Count
   * (`incompleteRead`). Absent on a complete read. It is what tells a caller
   * that `rows` must be decided with `complete = false`: an unseen row may
   * disagree with every row that was seen.
   */
  readonly incomplete?: true;
  readonly detail: string;
}

/** One `sys_properties` row as `readProperty` observed it. */
export interface PropertyRow {
  readonly sysId?: string;
  readonly value: string;
}

export interface AccessProbe {
  readonly outcome: "readable" | "denied" | "absent" | "undecidable";
  readonly status?: number;
  readonly detail: string;
}

export interface ApiProbe {
  readonly outcome: "present" | "denied" | "absent" | "undecidable";
  readonly status?: number;
  readonly detail: string;
}

export interface InstanceProbe {
  /** One `sys_properties` row by name. */
  readProperty(name: string, signal?: AbortSignal): Promise<PropertyProbe>;
  /** The cheapest read that still exercises the table's ACL. */
  readTable(table: string, signal?: AbortSignal): Promise<AccessProbe>;
  /** Does this REST namespace exist and answer for the connected user? */
  reachApi(path: string, signal?: AbortSignal): Promise<ApiProbe>;
}

/**
 * A *namespace* 404 ("the URI is not a resource") proves the backing plugin or
 * table is not exposed; a *record* 404 ("No Record found") proves the opposite
 * — something answered about a row. Same status code, opposite conclusions.
 * The wording is the only discriminator ServiceNow gives, and `api/plugin.ts`
 * in `@tessera/sn-client` keys on the same phrases, as do `@tessera/parity`'s
 * reader and `@tessera/resolvers`.
 *
 * BOTH classifiers below test it, and `classifyTable` is the one that used not
 * to: it read every 404 as `absent` and said "the table is not present on this
 * instance" — an instance-wide claim drawn from an answer computed for one
 * session, and one ServiceNow's own record-404 body contradicts in so many
 * words ("Record doesn't exist or ACL restricts the record retrieval").
 */
const NAMESPACE_404 = /does not represent any resource|invalid uri/i;

/**
 * What that regex is matched against: the message AND the body, composed
 * exactly the way the canonical transport does it. `api/plugin.ts` in
 * `@tessera/sn-client` builds message + `JSON.stringify(detail ?? "")` and
 * tests that; this is the same string, and the two must not drift into
 * answering one question differently.
 *
 * Why the message alone is not enough: `extractErrorDetail` (`core/http.ts`)
 * PREFERS `error.message` and only falls back to `error.detail`, so a 404
 * body that carries the namespace wording in `detail` alone arrives here with
 * a message that says nothing about a namespace. The transport caught those
 * bodies; this file did not.

 * For `cicdApiPrecondition` that divergence read as a live CI/CD API — a
 * false `ready` while the backing plugin was inactive, and the run only
 * finds out when the suite fails to launch.
 *
 * `detail` is the whole parsed error body — `core/http.ts` passes the parsed
 * `json` — so it is always `JSON.parse` output or `undefined`.
 * `JSON.stringify` can therefore meet neither a cycle nor a BigInt here, and
 * this adapter keeps its promise never to throw.
 *
 * It is not free, and the cost runs the other way: the haystack is now the
 * WHOLE body, so a 404 whose body says "invalid URI" for some unrelated
 * reason (a proxy's own error page, a scripted REST resource validating its
 * own path parameters) is read as a namespace 404. That trade is deliberate
 * — the old failure was a false green, the new one is fail-closed — but it is
 * a trade, not a freebie.
 */
function namespaceHaystack(error: ServiceNowError): string {
  return `${error.message} ${JSON.stringify(error.detail ?? "")}`;
}

/** What a `sys_properties.name` passed to `readProperty` may be spelt with. */
const PROPERTY_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * The one property whose disagreeing duplicates resolve instead of going
 * undecidable: the §11.2 production flag, where the only safe direction is
 * "production".
 *
 * Delegated decision 2026-10-01 (wave 17): the name itself is declared once,
 * in `@tessera/types`, and re-exported here under the name this package always
 * exported it by — `@tessera/phase05` re-exports the same binding, so the
 * name this probe resolves toward "production" cannot drift from the one the
 * guard probe reads.
 *
 * Delegated decision 2026-09-30 (wave 16): the rule itself —
 * `decidePropertyRows` with `PRODUCTION_SAFE_DIRECTION` — lives in
 * `@tessera/types` and is the one `@tessera/phase05`'s guard probe calls, so
 * the two probes cannot read the same rows two ways again. Only this property
 * gets a safe direction HERE: `readProperty` is generic, and its runner
 * consumer (`atfRunnerEnabledPrecondition`) already realises the runner's
 * safe direction ("not ready") from an undecidable differing read, with a
 * duplicate-row remedy that a resolved value would lose.
 */
export { PRODUCTION_PROPERTY };

/**
 * Printable account of every row that answered — sys_id and a JSON-quoted,
 * length-capped value. The value is instance-authored text, so it is quoted
 * (control characters escaped) and truncated rather than spliced in raw.
 */
function describeRows(rows: readonly PropertyRow[]): string {
  return rows
    .map((row) => {
      const quoted = JSON.stringify(row.value);
      const value = quoted.length > 42 ? `${quoted.slice(0, 40)}…"` : quoted;
      return `${row.sysId ?? "(no sys_id)"}=${value}`;
    })
    .join(", ");
}

/** Set when the caller cancelled before the probe could reach the wire. */
const ABORTED = "aborted before the probe reached the instance";

/**
 * A `ServiceNowError` carrying no `status` never carried an HTTP response
 * either: the transport failed or timed out, or the request never left this
 * client at all (unconfigured instance, missing credentials, host policy).
 * Which of those it was is not knowable from here, so the evidence states the
 * one thing that is — nothing came back — and names both readings rather than
 * picking the one it cannot prove.
 *
 * What it must never do is render the absent status as a value. A status that
 * does not exist, printed in the grammar of one the instance sent, leaves an
 * operator unable to tell a real refusal from a probe that never arrived — and
 * on this boundary the evidence line IS the product of an undecided row.
 * Word-for-word the same line in `@tessera/resolvers` and `@tessera/parity`.
 */
const NO_STATUS =
  "no answer was received and there is no HTTP status to report — the " +
  "request either never left this client, or left it and never got a response";

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The live adapter: every read goes through the canonical transport (ARCH-7).
 *
 * The `signal` is checked before the request and NOT forwarded: `snRequest`
 * (`SnRequestArgs`) takes no abort signal, only its own per-request timeout.
 * An abort mid-request is therefore honoured one layer up, where
 * `createEnvironmentDoctor` races every probe against the caller's signal.
 */
export function createSnInstanceProbe(): InstanceProbe {
  return {
    async readProperty(name, signal) {
      if (aborted(signal)) return { outcome: "undecidable", detail: ABORTED };
      // Delegated decision 2026-09-25: `name` is spliced into an encoded query,
      // so a name carrying `^`, `=` or any other operator could rewrite it
      // (`x^ORname=sn_atf.runner.enabled` answered for a property nobody
      // asked about). Only plain property-name characters are accepted, and
      // the row must answer for exactly `name` below — fail closed on both.
      if (!PROPERTY_NAME_RE.test(name)) {
        return {
          outcome: "undecidable",
          detail: `refused to query ${SYS_PROPERTIES_TABLE} for ${JSON.stringify(name)}: a property name may contain only letters, digits, '_', '.' and '-'`,
        };
      }
      const params = new URLSearchParams({
        sysparm_query: `name=${name}`,
        sysparm_fields: "sys_id,name,value",
        sysparm_limit: String(PROPERTY_READ_LIMIT),
      });
      try {
        const res = await snRequest<{
          result?: { sys_id?: unknown; name?: unknown; value?: unknown }[];
        }>({
          method: "GET",
          path: `/api/now/table/${SYS_PROPERTIES_TABLE}`,
          params,
        });
        const result = res.data.result ?? [];
        const incomplete = incompletePropertyRead(
          name,
          result.length,
          res.total,
        );
        if (result.length === 0) {
          if (incomplete !== undefined) {
            // Delegated decision 2026-09-30 (wave 15): no rows under a larger
            // X-Total-Count is every matching row hidden (read ACLs), which is
            // an UNREADABLE answer, not an absent one — `absent` asserts
            // something about the instance the read never saw. Fail closed.
            return {
              outcome: "undecidable",
              incomplete: true,
              detail: `${incomplete}; no value is read from an incomplete read`,
            };
          }
          // Genuinely unset OR ACL-trimmed without a count saying so — the
          // Table API renders both as an empty result set and this probe
          // cannot separate them. Callers must word their evidence so it
          // holds under both readings.
          return {
            outcome: "absent",
            detail: `no readable ${SYS_PROPERTIES_TABLE} row named ${name}`,
          };
        }
        const stray = result.find((row) => row.name !== name);
        if (stray !== undefined) {
          return {
            outcome: "undecidable",
            detail: `${SYS_PROPERTIES_TABLE} answered a query for ${name} with a row named ${JSON.stringify(stray.name)}`,
          };
        }
        const rows: PropertyRow[] = result.map((row) => {
          const value = typeof row.value === "string" ? row.value : "";
          const sysId = typeof row.sys_id === "string" ? row.sys_id : "";
          return sysId === "" ? { value } : { sysId, value };
        });
        const [first] = rows as [PropertyRow, ...PropertyRow[]];
        const values = rows.map((row) => normalisePropertyValue(row.value));
        const decision = decidePropertyRows(
          values,
          incomplete === undefined,
          name === PRODUCTION_PROPERTY ? PRODUCTION_SAFE_DIRECTION : undefined,
        );
        // Whether the rows that WERE read agree — reported even on an
        // incomplete read, where `decision` cannot be `agreed`.
        const agree = values.every((value) => value === values[0]);
        const found = (row: PropertyRow, detail: string): PropertyProbe => ({
          outcome: "found",
          value: row.value,
          ...(row.sysId === undefined ? {} : { sysId: row.sysId }),
          ...(rows.length > 1
            ? {
                duplicates: agree
                  ? ("identical" as const)
                  : ("differing" as const),
                rows,
              }
            : {}),
          ...(incomplete === undefined ? {} : { incomplete: true as const }),
          detail,
        });
        if (incomplete !== undefined) {
          // Delegated decision 2026-09-30 (wave 14): an incomplete read has no
          // value, even when every row it saw agrees — the unseen rows are
          // exactly where a disagreement would hide. The production flag is
          // the one exception, and only in its safe direction: a SEEN row that
          // does not read `false` already wins under the duplicate rule below,
          // and no unseen row can make that less production. All-`false` rows
          // decide nothing, because an unseen row may read `true`.
          if (decision.kind === "safe") {
            const winner = rows[decision.index] ?? first;
            return found(
              winner,
              `${incomplete}; a row that was read reads ${JSON.stringify(winner.value)}, the production direction, so it is read as that`,
            );
          }
          // Delegated decision 2026-10-01 (wave 17): the rows that WERE read
          // travel with the undecidable read, marked `incomplete`, so a caller
          // holding a safe direction this generic reader does not (the CLI's
          // guard probe reads the runner as "not enabled" from any non-`true`
          // row) can settle it from a seen row instead of receiving no value
          // at all — the rows are the fail-closed evidence. `duplicates` is
          // deliberately NOT set: `identical` would claim an agreement an
          // unseen row may break, and `differing` would route the runner
          // precondition from `unknown` to its complete-read duplicate
          // remedy, which an incomplete read has not earned (wave 14). The
          // detail line is unchanged and quotes no row value.
          return {
            outcome: "undecidable",
            rows,
            incomplete: true,
            detail: `${incomplete}; no value is read from an incomplete read`,
          };
        }
        const plain = `${name}=${first.value || "(empty)"}`;
        if (decision.kind === "agreed") {
          if (rows.length === 1) return found(first, plain);
          // Delegated decision 2026-09-26: duplicates that agree are one
          // observation, so the value stands; `duplicates`/`rows` still say
          // there is more than one row, because a remedy that writes ONE of
          // them would turn agreeing duplicates into disagreeing ones.
          return found(
            first,
            `${plain} (${rows.length} identical rows: ${describeRows(rows)})`,
          );
        }
        const differing = `${name} has ${rows.length} rows with differing values (${describeRows(rows)})`;
        if (decision.kind === "safe") {
          // Delegated decision 2026-09-26: for the production flag the only
          // safe direction is "production" (§11.2 downgrades only). Any row
          // reading `true` wins; failing that, any row that does not read
          // `false` wins, so the caller's own fail-closed reading of an odd
          // value applies. Rows can only differ here if at least one of them
          // is not `false`, so this never resolves to `false`.
          const winner = rows[decision.index] ?? first;
          return found(
            winner,
            `${differing}; read as ${JSON.stringify(winner.value)}, the production direction`,
          );
        }
        // Delegated decision 2026-09-26: disagreeing duplicates are not
        // resolved by row order — which row the platform honours is not
        // knowable from here, so there is no value to report (fail closed).
        return {
          outcome: "undecidable",
          duplicates: "differing",
          rows,
          detail: `${differing}; which one the instance honours is not knowable from here`,
        };
      } catch (error) {
        return classifyProperty(error);
      }
    },

    async readTable(table, signal) {
      if (aborted(signal)) return { outcome: "undecidable", detail: ABORTED };
      const params = new URLSearchParams({
        sysparm_limit: "1",
        sysparm_fields: "sys_id",
      });
      try {
        const res = await snRequest<{ result?: unknown[] }>({
          method: "GET",
          path: `/api/now/table/${encodeURIComponent(table)}`,
          params,
        });
        return {
          outcome: "readable",
          status: res.status,
          detail: `${table} is readable`,
        };
      } catch (error) {
        return classifyTable(table, error);
      }
    },

    async reachApi(path, signal) {
      if (aborted(signal)) return { outcome: "undecidable", detail: ABORTED };
      try {
        const res = await snRequest<unknown>({ method: "GET", path });
        return {
          outcome: "present",
          status: res.status,
          detail: `${path} answered ${res.status}`,
        };
      } catch (error) {
        return classifyApi(path, error);
      }
    },
  };
}

function classifyProperty(error: unknown): PropertyProbe {
  if (error instanceof ServiceNowError && error.status === 403) {
    return {
      outcome: "denied",
      detail: `read on ${SYS_PROPERTIES_TABLE} refused (403)`,
    };
  }
  return { outcome: "undecidable", detail: describe(error) };
}

function classifyTable(table: string, error: unknown): AccessProbe {
  if (error instanceof ServiceNowError) {
    // Destructured once and the status-less case returned immediately, so
    // TypeScript types `status` as `number` below: `status: error.status` can
    // no longer put an absent status on an `AccessProbe` whose `status` means
    // "what the instance answered with".
    const { status } = error;
    if (status === undefined) {
      // No `status` key at all rather than `status: undefined` — the key's
      // presence is itself a claim that a status was observed, and the object
      // must not make one the detail line refuses to make.
      return {
        outcome: "undecidable",
        detail: `${table}: ${NO_STATUS} (${error.message})`,
      };
    }
    if (status === 403) {
      return {
        outcome: "denied",
        status: 403,
        detail: `${table}: no read access for the connected user`,
      };
    }
    if (status === 404) {
      // The same discriminator `classifyApi` uses below, on the same status,
      // for the same reason: only the namespace wording says anything about
      // the TABLE. Every other 404 body ServiceNow sends on this endpoint
      // spells its own ambiguity out — "Record doesn't exist or ACL restricts
      // the record retrieval" — so it cannot separate a table that is not
      // there from one this caller was simply not shown, and `absent` is the
      // reading that turns into a `not-ready` finding: the STRONGER claim,
      // the one that asserts something specific about the instance, and the
      // one a bare status does not earn. `@tessera/parity` and
      // `@tessera/resolvers` split the same status the same way.
      //
      // And the namespace reading is still an answer computed for ONE
      // session, so the detail names both ways it can be true rather than
      // picking the one it cannot prove — the same move the 403 line above
      // makes by saying "for the connected user" instead of "on this
      // instance".
      return NAMESPACE_404.test(namespaceHaystack(error))
        ? {
            outcome: "absent",
            status: 404,
            detail:
              `${table} is not a resource on this instance for the ` +
              `connected user — either the table is not there at all, or ` +
              `this caller's scope and roles cannot resolve it`,
          }
        : {
            outcome: "undecidable",
            status: 404,
            detail:
              `${table}: answered 404 without the namespace wording, so ` +
              `nothing was said about the table itself (${error.message})`,
          };
    }
    return {
      outcome: "undecidable",
      status,
      detail: `${table}: ${error.message}`,
    };
  }
  return { outcome: "undecidable", detail: `${table}: ${describe(error)}` };
}

function classifyApi(path: string, error: unknown): ApiProbe {
  if (error instanceof ServiceNowError) {
    // Same shape as `classifyTable`, and deliberately so: one question, and
    // the two probes must not drift into answering it differently.
    const { status } = error;
    if (status === undefined) {
      return {
        outcome: "undecidable",
        detail: `${path}: ${NO_STATUS} (${error.message})`,
      };
    }
    if (status === 403) {
      return {
        outcome: "denied",
        status: 403,
        detail: `${path} refused (403)`,
      };
    }
    if (status === 404) {
      return NAMESPACE_404.test(namespaceHaystack(error))
        ? {
            outcome: "absent",
            status: 404,
            detail: `${path} is not a resource on this instance (the backing plugin is inactive)`,
          }
        : {
            outcome: "present",
            status: 404,
            detail: `${path} answered a record-level 404 — the API itself is live`,
          };
    }
    return {
      outcome: "undecidable",
      status,
      detail: `${path}: ${error.message}`,
    };
  }
  return { outcome: "undecidable", detail: `${path}: ${describe(error)}` };
}
