import { isMissingTable } from "../checks/cert-common.js";
import type { SnClient } from "../http/client.js";
import type { Check, CheckResult } from "../types.js";

/**
 * CLI-1 (RR-49): which tables a check's reads found missing.
 *
 * A Table API read that fails with a missing-table answer (see
 * {@link isMissingTable}) is taken for "the plugin is not installed", and the
 * check turns it into a skip `warn`. That is only true for a table a plugin
 * provides. A 404 on a table every instance has (`sys_security_acl`,
 * `sys_db_object`, …) means a wrong instance path, a proxy or a read the
 * account may not make: the check verified nothing. The runner watches each
 * check's table reads, and a missing table the check did not declare in
 * `meta.optionalTables` turns its row into `error`.
 */
export class MissingTables {
  /** Missing tables the check declared optional. */
  private readonly optionalSeen = new Set<string>();
  /** Missing tables the check did not declare optional. */
  private readonly requiredSeen = new Set<string>();
  /** The table each recorded error came from. */
  private readonly tableOf = new WeakMap<object, string>();
  private readonly optional: ReadonlySet<string>;

  constructor(check: Check) {
    this.optional = new Set(check.meta?.optionalTables ?? []);
  }

  /** `client` with every table read watched for a missing-table failure. */
  watch(client: SnClient): SnClient {
    const watched = async <T>(table: string, read: () => Promise<T>) => {
      try {
        return await read();
      } catch (err) {
        if (isMissingTable(err)) {
          (this.optional.has(table)
            ? this.optionalSeen
            : this.requiredSeen
          ).add(table);
          this.tableOf.set(err, table);
        }
        throw err;
      }
    };
    // `read` runs inside `watched`'s try: a client that throws synchronously
    // (rather than rejecting) is watched too.
    return {
      table: (name) => {
        const table = client.table(name);
        return {
          get: (sysId, params, opts) =>
            watched(name, () => table.get(sysId, params, opts)),
          query: (params, opts) =>
            watched(name, () => table.query(params, opts)),
          queryWithMeta: (params, opts) =>
            watched(name, () => table.queryWithMeta(params, opts)),
        };
      },
      cicd: client.cicd,
      request: (method, path, opts) => client.request(method, path, opts),
    };
  }

  /** The missing tables the check did not declare optional, sorted. */
  required(): string[] {
    return [...this.requiredSeen].sort();
  }

  /** Whether `err` came from a read of a table the check declared optional. */
  isOptional(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false;
    const table = this.tableOf.get(err);
    return table !== undefined && this.optional.has(table);
  }

  /**
   * `result`, or an `error` row when a required table was missing: the
   * check's own verdict (often a "plugin not installed" skip) rests on a read
   * that returned nothing. An `error` row is kept as it is.
   */
  enforce(result: CheckResult): CheckResult {
    const missing = this.required();
    if (missing.length === 0 || result.status === "error") return result;
    return {
      ...result,
      status: "error",
      message: `${missingMessage(missing)} The check reported: ${result.message}`,
    };
  }
}

/** The `error` message for required tables that answered as missing. */
export function missingMessage(tables: readonly string[]): string {
  const list = tables.length > 0 ? tables.join(", ") : "a table it reads";
  return `Required table not found (HTTP 404 or "Invalid table"): ${list}. The check does not declare it optional (meta.optionalTables), so this is not a missing plugin: the instance URL or path, a proxy, or the account's read access is wrong. Nothing was verified.`;
}
