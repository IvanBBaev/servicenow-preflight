import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EncodedQueryError,
  IN_CHUNK_SIZE,
  and,
  assertIdentifier,
  assertSysId,
  chunk,
  eq,
  inClause,
  isSafeIdentifier,
  isSysId,
  or,
  resolveScope,
  scopeFilterClause,
} from "../../build/http/query.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";
const SCOPE_NAME = "x_acme_app";
const SCOPE_SYS_ID = "0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Charset predicates
// ---------------------------------------------------------------------------

test("isSafeIdentifier accepts scope names, sys_ids, dot-walks and language codes", () => {
  assert.equal(isSafeIdentifier("x_acme_app"), true);
  assert.equal(isSafeIdentifier("sys_scope.scope"), true);
  assert.equal(isSafeIdentifier(SCOPE_SYS_ID), true);
  assert.equal(isSafeIdentifier("pt-BR"), true);
  assert.equal(isSafeIdentifier("  fr  "), true); // trims before testing
});

test("isSafeIdentifier rejects encoded-query operators and % (SR-1)", () => {
  assert.equal(isSafeIdentifier("x^ORy"), false);
  assert.equal(isSafeIdentifier("x%5Ey"), false); // percent-encoded caret
  assert.equal(isSafeIdentifier("a=b"), false);
  assert.equal(isSafeIdentifier("a,b"), false);
  assert.equal(isSafeIdentifier(""), false);
  assert.equal(isSafeIdentifier(42), false);
  assert.equal(isSafeIdentifier(null), false);
});

test("isSysId matches exactly 32 lowercase hex characters", () => {
  assert.equal(isSysId(SCOPE_SYS_ID), true);
  assert.equal(isSysId("ffffffffffffffffffffffffffffffff"), true);
  assert.equal(isSysId("x_acme_app"), false);
  assert.equal(isSysId("0123456789ABCDEF0123456789ABCDEF"), false); // uppercase
  assert.equal(isSysId("0123456789abcdef0123456789abcde"), false); // 31 chars
});

// ---------------------------------------------------------------------------
// assertIdentifier / assertSysId — fail closed
// ---------------------------------------------------------------------------

test("assertIdentifier returns the trimmed value when safe", () => {
  assert.equal(assertIdentifier("  x_acme_app  ", "scope"), "x_acme_app");
});

test("assertIdentifier throws EncodedQueryError on an operator (SR-1)", () => {
  assert.throws(
    () => assertIdentifier("x_acme_app^ORsys_id=abc", "scope"),
    (err) =>
      err instanceof EncodedQueryError &&
      /scope/.test(err.message) &&
      /injection/i.test(err.message),
  );
});

test("assertIdentifier throws on a percent-encoded caret (SR-1)", () => {
  assert.throws(
    () => assertIdentifier("x%5EORsys_id=abc"),
    (err) => err instanceof EncodedQueryError,
  );
});

test("assertIdentifier throws on a non-string", () => {
  assert.throws(
    () => assertIdentifier(undefined, "field"),
    (err) => err instanceof EncodedQueryError && /field/.test(err.message),
  );
});

test("assertSysId accepts a 32-hex id and rejects anything else", () => {
  assert.equal(assertSysId(SCOPE_SYS_ID), SCOPE_SYS_ID);
  assert.throws(
    () => assertSysId("x_acme_app"),
    (err) => err instanceof EncodedQueryError,
  );
});

// ---------------------------------------------------------------------------
// Clause builders
// ---------------------------------------------------------------------------

test("eq builds a validated field=value clause", () => {
  assert.equal(eq("sys_scope", "x_acme_app"), "sys_scope=x_acme_app");
  assert.equal(
    eq("sys_scope.scope", "x_acme_app"),
    "sys_scope.scope=x_acme_app",
  );
});

test("eq fails closed when the value carries an operator (SR-1)", () => {
  assert.throws(
    () => eq("sys_scope", "x_acme_app^ORsys_id=abc"),
    (err) => err instanceof EncodedQueryError,
  );
});

test("eq fails closed when the field carries an operator (SR-1)", () => {
  assert.throws(
    () => eq("sys_scope^OR", "x_acme_app"),
    (err) => err instanceof EncodedQueryError,
  );
});

test("inClause builds a validated IN membership clause", () => {
  assert.equal(
    inClause("sys_security_acl", ["a1", "b2", "c3"]),
    "sys_security_aclINa1,b2,c3",
  );
});

test("inClause yields the empty string for an empty list", () => {
  assert.equal(inClause("sys_security_acl", []), "");
});

test("inClause fails closed when any value carries an operator (SR-1)", () => {
  assert.throws(
    () => inClause("sys_security_acl", ["ok", "bad^ORx=1"]),
    (err) => err instanceof EncodedQueryError,
  );
});

test("and joins non-empty clauses with ^ and drops empties", () => {
  assert.equal(and("a=1", "b=2"), "a=1^b=2");
  assert.equal(and("a=1", "", "b=2"), "a=1^b=2");
  assert.equal(and("", ""), "");
});

test("or joins non-empty clauses with ^OR and drops empties", () => {
  assert.equal(or("a=1", "b=2"), "a=1^ORb=2");
  assert.equal(or("a=1", ""), "a=1");
});

// ---------------------------------------------------------------------------
// chunk / IN_CHUNK_SIZE
// ---------------------------------------------------------------------------

test("IN_CHUNK_SIZE is 100", () => {
  assert.equal(IN_CHUNK_SIZE, 100);
});

test("chunk splits into consecutive slices of at most the given size", () => {
  const items = Array.from({ length: 250 }, (_, i) => i);
  const chunks = chunk(items, 100);
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [100, 100, 50],
  );
  assert.equal(chunks[0][0], 0);
  assert.equal(chunks[2][49], 249);
});

test("chunk defaults to IN_CHUNK_SIZE and never yields a zero-size step", () => {
  const items = Array.from({ length: 201 }, (_, i) => i);
  assert.equal(chunk(items).length, 3); // ceil(201/100)
  // A pathological size <= 0 must not loop forever — it clamps to 1.
  assert.equal(chunk([1, 2], 0).length, 2);
});

test("chunk falls back to the default step on a non-finite size (never drops items)", () => {
  // NaN/Infinity as `step` would make `i += step` never advance past the first
  // iteration, silently returning [] and dropping every item — guard falls back
  // to IN_CHUNK_SIZE so all items survive.
  const items = Array.from({ length: 250 }, (_, i) => i);
  for (const bad of [NaN, Infinity, -Infinity]) {
    const chunks = chunk(items, bad);
    assert.equal(
      chunks.reduce((n, c) => n + c.length, 0),
      250,
      `size=${bad} must preserve all items`,
    );
    assert.equal(chunks.length, 3); // ceil(250 / IN_CHUNK_SIZE)
  }
});

// ---------------------------------------------------------------------------
// scopeFilterClause (no lookup)
// ---------------------------------------------------------------------------

test("scopeFilterClause dot-walks a name and filters a sys_id directly (SN-4)", () => {
  assert.equal(scopeFilterClause(SCOPE_NAME), "sys_scope.scope=x_acme_app");
  assert.equal(scopeFilterClause(SCOPE_SYS_ID), `sys_scope=${SCOPE_SYS_ID}`);
});

test("scopeFilterClause fails closed on an operator-bearing scope (SR-1)", () => {
  assert.throws(
    () => scopeFilterClause("x_acme_app^ORsys_id=abc"),
    (err) => err instanceof EncodedQueryError,
  );
});

// ---------------------------------------------------------------------------
// resolveScope — name↔sys_id parity, fail-closed fallback, per-run caching
// ---------------------------------------------------------------------------

/** A fake `sys_scope` table that answers the resolver's `sys_id=…^ORscope=…` query. */
function scopeClient(rows) {
  return createFakeSnClient({
    tables: { sys_scope: rows },
    queryFilter(table, seeded, params) {
      if (table !== "sys_scope") return seeded;
      const q = params?.sysparm_query ?? "";
      const idMatch = /sys_id=([^^]+)/.exec(q);
      const scopeMatch = /scope=([^^]+)/.exec(q);
      const wantId = idMatch ? idMatch[1] : null;
      const wantScope = scopeMatch ? scopeMatch[1] : null;
      return seeded.filter(
        (r) =>
          (wantId !== null && r.sys_id === wantId) ||
          (wantScope !== null && r.scope === wantScope),
      );
    },
  });
}

/** Count table queries so caching can be proven. */
function tracked(http) {
  const calls = [];
  return {
    http: {
      ...http,
      table(name) {
        const t = http.table(name);
        return {
          get: (id, params) => t.get(id, params),
          query: (params) => {
            calls.push({ table: name, params });
            return t.query(params);
          },
          queryWithMeta: (params) => {
            calls.push({ table: name, params });
            return t.queryWithMeta(params);
          },
        };
      },
    },
    calls,
  };
}

test("resolveScope resolves a NAME to sys_scope=<sysId> (SN-4)", async () => {
  const http = scopeClient([{ sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME }]);
  const ctx = { instanceUrl: INSTANCE, http };
  const resolved = await resolveScope(ctx, SCOPE_NAME);
  assert.equal(resolved.input, SCOPE_NAME);
  assert.equal(resolved.sysId, SCOPE_SYS_ID);
  assert.equal(resolved.clause, `sys_scope=${SCOPE_SYS_ID}`);
});

test("resolveScope resolves a SYS_ID to the identical clause (name↔sys_id parity)", async () => {
  const http = scopeClient([{ sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME }]);
  const ctx = { instanceUrl: INSTANCE, http };
  const fromName = await resolveScope(ctx, SCOPE_NAME);
  const fromSysId = await resolveScope(ctx, SCOPE_SYS_ID);
  // The whole point of SN-4: a scope's name and its sys_id produce the SAME
  // canonical filter, so every check behaves identically whichever form is given.
  assert.equal(fromSysId.sysId, SCOPE_SYS_ID);
  assert.equal(fromSysId.clause, fromName.clause);
  assert.equal(fromSysId.clause, `sys_scope=${SCOPE_SYS_ID}`);
});

test("resolveScope falls back to sys_scope.scope=<name> for an unresolved name (fail closed)", async () => {
  // No sys_scope row matches — the fallback still filters (matches nothing on a
  // genuinely wrong scope) rather than widening to a vacuous match.
  const http = scopeClient([]);
  const ctx = { instanceUrl: INSTANCE, http };
  const resolved = await resolveScope(ctx, "x_unknown_app");
  assert.equal(resolved.sysId, undefined);
  assert.equal(resolved.clause, "sys_scope.scope=x_unknown_app");
});

test("resolveScope falls back to sys_scope=<hex> for an unresolved 32-hex input", async () => {
  const http = scopeClient([]);
  const ctx = { instanceUrl: INSTANCE, http };
  const unknownId = "ffffffffffffffffffffffffffffffff";
  const resolved = await resolveScope(ctx, unknownId);
  assert.equal(resolved.sysId, undefined);
  assert.equal(resolved.clause, `sys_scope=${unknownId}`);
});

test("resolveScope caches per run — a repeat resolve issues no second query", async () => {
  const { http, calls } = tracked(
    scopeClient([{ sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME }]),
  );
  const ctx = { instanceUrl: INSTANCE, http };
  const first = await resolveScope(ctx, SCOPE_NAME);
  const second = await resolveScope(ctx, SCOPE_NAME);
  assert.equal(second.clause, first.clause);
  const scopeReads = calls.filter((c) => c.table === "sys_scope");
  assert.equal(scopeReads.length, 1);
});

test("resolveScope dedupes concurrent resolves of the same scope into one query", async () => {
  const { http, calls } = tracked(
    scopeClient([{ sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME }]),
  );
  const ctx = { instanceUrl: INSTANCE, http };
  const [a, b] = await Promise.all([
    resolveScope(ctx, SCOPE_NAME),
    resolveScope(ctx, SCOPE_NAME),
  ]);
  assert.equal(a.clause, b.clause);
  assert.equal(calls.filter((c) => c.table === "sys_scope").length, 1);
});

test("resolveScope keys its cache on the context (separate runs resolve independently)", async () => {
  const rows = [{ sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME }];
  const { http, calls } = tracked(scopeClient(rows));
  const ctxA = { instanceUrl: INSTANCE, http };
  const ctxB = { instanceUrl: INSTANCE, http };
  await resolveScope(ctxA, SCOPE_NAME);
  await resolveScope(ctxB, SCOPE_NAME);
  // Different contexts do not share the cache — one read each.
  assert.equal(calls.filter((c) => c.table === "sys_scope").length, 2);
});

test("resolveScope fails closed on an operator-bearing scope before any query (SR-1)", async () => {
  const { http, calls } = tracked(scopeClient([]));
  const ctx = { instanceUrl: INSTANCE, http };
  await assert.rejects(
    resolveScope(ctx, "x_acme_app^ORsys_id=abc"),
    (err) => err instanceof EncodedQueryError,
  );
  // The guard trips before the sys_scope read is issued.
  assert.equal(calls.filter((c) => c.table === "sys_scope").length, 0);
});
