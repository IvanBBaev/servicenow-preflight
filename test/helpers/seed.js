/**
 * Fixture helpers for the fake client, which evaluates `sysparm_query`: a row
 * is only returned when it really seeds the columns the check filters on.
 */

/**
 * `rows` as members of `scope`: each answers the dot-walked
 * `sys_scope.scope=<scope>` clause, and carries `defaults` (typically
 * `active: "true"`, or `sys_scope: <sysId>` for a resolved scope). A value the
 * row sets itself wins, so a test can still seed an out-of-filter row.
 */
export function inScope(rows, scope, defaults = {}) {
  return rows.map((row) => ({ "sys_scope.scope": scope, ...defaults, ...row }));
}

/** {@link inScope} over every table of a `tables` fixture. */
export function tablesInScope(tables, scope, defaults = {}) {
  return Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [
      name,
      inScope(rows, scope, defaults),
    ]),
  );
}

/** Wrap a fake client so each table read is recorded as `{ table, params }`. */
export function tracked(http) {
  const calls = [];
  return {
    http: {
      ...http,
      table(name) {
        const t = http.table(name);
        const recording = (read) => (params) => {
          calls.push({ table: name, params });
          return read(params);
        };
        return {
          ...t,
          query: recording(t.query),
          queryWithMeta: recording(t.queryWithMeta),
        };
      },
    },
    calls,
  };
}
