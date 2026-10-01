// Whether a bounded Table API read can be taken as the whole picture.
//
// Pure: it judges numbers the caller already holds and performs no I/O. It
// lives here because `@tessera/doctor` and `@tessera/phase05` both read
// `sys_properties` this way and both depend on this package; one copy is the
// point — two copies of a fail-closed rule drift into two rules.

/** What one bounded read returned, and what the instance said matched. */
export interface CountedRead {
  /** The table that was read, e.g. `sys_properties`. */
  readonly table: string;
  /** What the read was for — spliced into the explanation verbatim. */
  readonly what: string;
  /** How many rows came back. */
  readonly returned: number;
  /** The X-Total-Count header, or `undefined` when the instance sent none. */
  readonly total: number | undefined;
  /**
   * How many rows the caller compares. The read must ask for ONE row more
   * than this, so that seeing `rowLimit + 1` rows proves the limit was
   * exceeded even when the instance sends no X-Total-Count.
   */
  readonly rowLimit: number;
}

/**
 * Why a bounded read cannot be taken as complete, or `undefined` when it can.
 *
 * Two ways, both fail-closed:
 *   - more than `rowLimit` rows came back — the rows past the read limit were
 *     never fetched, so one of them may disagree;
 *   - X-Total-Count reports more matching rows than came back — rows the
 *     count saw were removed, typically by read ACLs. This includes ZERO rows
 *     under a positive count: every matching row hidden is an unreadable
 *     answer, never an absent one.
 *
 * An X-Total-Count at or below the rows returned, or absent, is no evidence
 * of a gap; the `rowLimit + 1` row is what catches the no-header case.
 *
 * The short-read sentence is `@tessera/sn-client`'s
 * `tableApi.describeTruncation` wording for its `short-page` case. This
 * package cannot depend on the transport, so the wording is restated here and
 * `@tessera/doctor`'s suite pins the two equal.
 */
export function incompleteRead(read: CountedRead): string | undefined {
  const { table, what, returned, total, rowLimit } = read;
  if (returned > rowLimit) {
    const count =
      total === undefined
        ? "the instance sent no X-Total-Count"
        : `X-Total-Count reports ${total}`;
    return `${table} read for ${what} matched more than ${rowLimit} rows (${count}); only ${rowLimit} are compared, so a row past them could disagree unseen`;
  }
  if (total !== undefined && total > returned) {
    return `${table} read for ${what} came back short: X-Total-Count reports ${total} matching rows but only ${returned} were returned (rows removed by read ACLs, or an inconsistent count; raising SN_MAX_RECORDS will not help)`;
  }
  return undefined;
}

/** The table every property read in Tessera goes to. */
export const SYS_PROPERTIES_TABLE = "sys_properties";

// Delegated decision 2026-10-01 (wave 17): the two property NAMES Tessera
// reads a safety signal from are declared once, here, beside the table they
// live in. `@tessera/doctor` and `@tessera/phase05` each declared them with a
// "mirrors the other one" comment; the doctor's probe resolves differing
// duplicate rows toward "production" only for the EXACT production name, so a
// copy that drifted would make a consumer read a property the probe treats as
// ordinary. Both packages re-export these under the names they always
// exported. Their safe directions (`PRODUCTION_SAFE_DIRECTION`,
// `ATF_RUNNER_SAFE_DIRECTION`) live in `propertyRows.ts`.

/**
 * §11.2 production marker. Only an exact `false` reads as a non-production
 * instance (`PRODUCTION_SAFE_DIRECTION`).
 */
export const PRODUCTION_PROPERTY = "glide.installation.production";

/**
 * [DR-3] must be `true` or ATF silently refuses to execute anything. Only an
 * exact `true` reads as enabled (`ATF_RUNNER_SAFE_DIRECTION`).
 */
export const ATF_RUNNER_ENABLED_PROPERTY = "sn_atf.runner.enabled";

/**
 * How many `sys_properties` rows one property read compares.
 *
 * Delegated decision 2026-09-26: more than one, so a duplicate row for the
 * same name is SEEN instead of hidden behind whichever row the instance
 * happened to return first — `sysparm_limit=1` made the reading depend on row
 * order.
 *
 * Delegated decision 2026-09-30 (wave 16): declared here once. `@tessera/doctor`
 * and `@tessera/phase05` each used to declare it (and {@link
 * PROPERTY_READ_LIMIT}) with a "mirrors the other one" comment; they now
 * re-export these, so the two probes cannot drift to different limits.
 */
export const PROPERTY_ROW_LIMIT = 10;

/**
 * The `sysparm_limit` a property read sends: {@link PROPERTY_ROW_LIMIT} plus
 * the one row whose presence proves the limit was exceeded (wave 14). Seeing
 * it makes the read incomplete — see {@link incompletePropertyRead}.
 */
export const PROPERTY_READ_LIMIT = PROPERTY_ROW_LIMIT + 1;

/**
 * Why a `sys_properties` read for one property cannot be taken as complete,
 * or `undefined` when it can: {@link incompleteRead} bound to
 * {@link SYS_PROPERTIES_TABLE} and {@link PROPERTY_ROW_LIMIT}. The read must
 * have asked for {@link PROPERTY_READ_LIMIT} rows.
 */
export function incompletePropertyRead(
  what: string,
  returned: number,
  total: number | undefined,
): string | undefined {
  return incompleteRead({
    table: SYS_PROPERTIES_TABLE,
    what,
    returned,
    total,
    rowLimit: PROPERTY_ROW_LIMIT,
  });
}
