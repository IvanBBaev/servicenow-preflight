// QA-18 — composition root of the stateful fake instance.
//
// Injection: `@tessera/sn-client`'s transport (`core/http.ts`) calls the global
// `fetch(url, init)` and reads back a standard `Response`. The fake therefore
// exposes a `fetch`-shaped adapter, and `install()` swaps it into a host object
// (defaulting to `globalThis`) and hands back the restore function. Nothing in
// `sn-client` is modified, and there is no module-level singleton here: every
// `createFakeInstance()` call owns its own state, ids, clock and fault rules.

import {
  createFakeAcl,
  createFakeReadAcl,
  type FakeAclOptions,
  type FakeReadAclOptions,
} from "./acl.js";
import { createLogicalClock, type FakeClock } from "./clock.js";
import {
  SUITE_RESULT_PARENT_FIELD,
  createFakeCicd,
  type CicdOptions,
  type FakeCicd,
} from "./cicd.js";
import { FakeAbortError } from "./errors.js";
import {
  createFaultRegistry,
  type FaultRegistry,
  type HttpMethod,
} from "./faults.js";
import {
  fixtureToSeed,
  parseFixtureBundle,
  type FixtureSeed,
  type HttpFixtureBundle,
} from "./fixtures.js";
import { createIdGenerator, type IdGenerator } from "./ids.js";
import type { UnknownQueryFieldMode } from "./query.js";
import { setOwn, type SnRecord } from "./record.js";
import {
  createRouter,
  type FakeRequest,
  type FakeResponse,
  type FakeStatsCountOptions,
  type RecordedRequest,
} from "./router.js";
import { createTableStore, type FakeTableStore } from "./tables.js";

/** The subset of `fetch` the transport uses. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Anything holding a swappable `fetch` — `globalThis` by default. */
export interface FetchHost {
  fetch: FetchLike;
}

export interface FakeInstanceOptions {
  /** Seed for deterministic sys_id generation. Default "tessera". */
  seed?: string;
  /** Override the deterministic id generator entirely. */
  ids?: IdGenerator;
  /** Override the logical clock. */
  clock?: FakeClock;
  /** Initial rows, keyed by table. Applied before `fixture`. */
  state?: Readonly<Record<string, readonly SnRecord[]>>;
  /** Recorded HTTP fixtures (parsed object or JSON text) used as initial state. */
  fixture?: HttpFixtureBundle | string;
  /** CI/CD lifecycle knobs. */
  cicd?: CicdOptions;
  /** Host used in `links.*.url`. Default "fake-instance.service-now.com". */
  host?: string;
  /** Query parameter carrying the §4a run id on `testsuite/run`. */
  runIdParam?: string;
  /**
   * DEV-14 — parameter names read as the suite sys_id on `testsuite/run`, in
   * precedence order. Default `["sys_id"]` (the vendored client's name);
   * `["test_suite_sys_id", "sys_id"]` also accepts the CI/CD endpoint's
   * documented name. See `DEFAULT_CICD_SUITE_PARAMS` in router.ts.
   */
  cicdSuiteParams?: readonly string[];
  /**
   * W2 (ADR-007) — the opt-in ACL/role model. Absent (the default) = every
   * table write lands, as before. Present = table writes are checked against
   * `acl.rules` (default: the W2 `sys_variable_value` rules) for the roles in
   * `acl.roles`, and a denied write answers 403 without mutating anything.
   */
  acl?: FakeAclOptions;
  /**
   * W6a M1 — what a `sysparm_query` condition on a field the table does not
   * have does. `"ignore"` is a real instance's default (the term is dropped);
   * `"no-rows"` models `glide.invalid_query.returns_no_rows=true`;
   * `"legacy-empty"` is the pre-W6a fake (the field reads as ""), an explicit
   * opt-in only. Default `"ignore"` — see `DEFAULT_UNKNOWN_QUERY_FIELD`. A
   * real instance never answers 400 for it, and neither does the fake.
   */
  unknownQueryField?: UnknownQueryFieldMode;
  /**
   * W6a M1 — declared fields per table, known to `unknownQueryField` even when
   * no seeded row carries them.
   */
  tableSchema?: Readonly<Record<string, readonly string[]>>;
  /**
   * W6a L3 — `=` / `!=` / `IN` / `NOT IN` fold case (ASCII/Unicode
   * `toLowerCase`) on both operands. Default false: exact, case-sensitive
   * compare. The LIKE family, `STARTSWITH` and `ENDSWITH` fold case either
   * way; ordering operators never do. Believed to match a real instance's
   * default collation, but no live capture in this repo proves it — see the
   * README "Equality semantics opt-ins" section for the evidence needed to
   * flip the default.
   */
  caseInsensitiveEquals?: boolean;
  /**
   * W6a L3 — `!=` never matches a row whose value is empty (`""`, or a field
   * the row does not carry). Default false: an empty value satisfies `!=`
   * for any non-empty operand. Only `!=` is affected — `NOT IN`, `NOT LIKE`
   * and `=` are unchanged. SQL-NULL-style and plausible for a real instance,
   * but not evidenced in this repo, hence opt-in — see the README
   * "Equality semantics opt-ins" section.
   */
  notEqualsExcludesEmpty?: boolean;
  /**
   * W6a L3 — opt-in read-ACL simulation: hidden rows shorten a list page
   * while `X-Total-Count` keeps the full count; field rules blank fields.
   */
  readAcl?: FakeReadAclOptions;
  /**
   * Wave 14 — opt-in: every list read (`GET /api/now/{table,import}/<t>`)
   * answers WITHOUT an `X-Total-Count` header, exactly as a real instance does
   * for `sysparm_no_count=true`. Default false: the header is emitted unless
   * the request itself sends `sysparm_no_count=true`.
   *
   * `@tessera/sn-client` never sends `sysparm_no_count`, so without this knob
   * its `fetchAll` "no X-Total-Count" branch is only reachable through a
   * hand-rolled stub transport, never through the stateful fake. Since wave 15
   * that branch probes one window past a short, non-empty page instead of
   * ending the read there (`truncationReason: "short-page-no-total"` when the
   * probe finds rows, `"probe-failed"` when it fails, `"no-total"` at the
   * SN_MAX_RECORDS cap), and `@tessera/runner-atf`'s `readTable` mirrors the
   * probe. Combined with `readAcl`, this knob is how both are driven: a denied
   * row still shortens its page, only the count that would expose it is gone.
   *
   * Delegated decision 2026-09-30 (wave 14): one instance-wide boolean, not a
   * per-table map — no caller needs mixed behaviour yet, and a boolean is the
   * smallest additive surface. Default off keeps every existing suite's
   * responses byte-identical (fail-closed: the header-present path is the one
   * that can flag a short page as partial).
   */
  omitTotalCount?: boolean;
  /**
   * Wave 16 — opt-in knobs for the modelled Aggregate (Stats) API count,
   * `GET /api/now/stats/<table>?sysparm_count=true`, which is always served
   * (answer shape `{ result: { stats: { count: "<n>" } } }`).
   * `aclFiltered: true` makes the count exclude read-ACL-hidden rows; the
   * default counts every matching row — an ASSUMPTION about the real API,
   * not verified live (see `FakeStatsCountOptions`). `fault` corrupts the
   * count for fail-closed parser tests.
   */
  statsCount?: FakeStatsCountOptions;
}

export interface FakeInstance {
  readonly tables: FakeTableStore;
  readonly cicd: FakeCicd;
  readonly faults: FaultRegistry;
  /** Every request served, in order. */
  requests(): RecordedRequest[];
  /** Request-level surface: the same shapes the real transport speaks. */
  handle(request: FakeRequest): Promise<FakeResponse>;
  /** `fetch`-compatible adapter — inject this in place of the real transport. */
  fetch: FetchLike;
  /** Swap `fetch` into `host` (default `globalThis`); returns the restorer. */
  install(host?: FetchHost): () => void;
  /** Merge more rows into the live state (JSON in, state out). */
  seedFrom(fixture: HttpFixtureBundle | string): FixtureSeed;
  /** Back to the initial seeded state; clears faults, log, ids and clock. */
  reset(): void;
}

const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
]);

/** Decode a `fetch` body back into the JSON value the router expects. */
function decodeBody(body: BodyInit | null | undefined): unknown {
  if (body === null || body === undefined) return undefined;
  let text: string;
  if (typeof body === "string") text = body;
  else if (body instanceof Uint8Array)
    text = Buffer.from(body).toString("utf8");
  else if (ArrayBuffer.isView(body)) {
    text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString(
      "utf8",
    );
  } else if (body instanceof ArrayBuffer) {
    text = Buffer.from(body).toString("utf8");
  } else {
    // FormData/Blob/streams: `sn-client` never sends them.
    return undefined;
  }
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The caller's `tableSchema` plus the column the CI/CD model always owns.
 *
 * Delegated decision 2026-09-28 (wave 13): `parent` is declared on the
 * suite-result table by default. A root execution row carries no `parent`
 * key, so without the declaration a `parent=<id>` / `parentIN...` read of a
 * run with no child suite would hit the default `unknownQueryField: "ignore"`
 * and return EVERY suite-result row — other runs' roots included — which is
 * not what a real instance (whose dictionary has the column) answers. Declared
 * rather than written as `parent: ""` so existing row shapes stay unchanged;
 * a caller's own declaration for the table is kept and merged.
 */
function withCicdSchema(
  options: FakeInstanceOptions,
): Readonly<Record<string, readonly string[]>> {
  const table = options.cicd?.resultTable ?? "sys_atf_test_suite_result";
  const declared = options.tableSchema ?? {};
  const own = Object.hasOwn(declared, table) ? (declared[table] ?? []) : [];
  return Object.fromEntries([
    ...Object.entries(declared),
    [table, [...new Set([...own, SUITE_RESULT_PARENT_FIELD])]],
  ]);
}

export function createFakeInstance(
  options: FakeInstanceOptions = {},
): FakeInstance {
  const ids = options.ids ?? createIdGenerator(options.seed ?? "tessera");
  const clock = options.clock ?? createLogicalClock();
  const tables = createTableStore({
    ids,
    clock,
    semantics: {
      ...(options.unknownQueryField
        ? { unknownQueryField: options.unknownQueryField }
        : {}),
      ...(options.caseInsensitiveEquals ? { caseInsensitiveEquals: true } : {}),
      ...(options.notEqualsExcludesEmpty
        ? { notEqualsExcludesEmpty: true }
        : {}),
    },
    tableSchema: withCicdSchema(options),
  });
  const host = options.host ?? "fake-instance.service-now.com";
  const runIdParam = options.runIdParam ?? "tessera_run_id";
  const cicd = createFakeCicd({
    tables,
    ids,
    clock,
    options: { host, ...options.cicd },
  });
  const faults = createFaultRegistry();
  const log: RecordedRequest[] = [];

  // The initial state is materialized once and replayed by `reset()`, so a
  // scenario always restarts from the same bytes.
  // Delegated decision 2026-09-26: a Map, not `{}` — `initial["__proto__"]`
  // on a plain object is Object.prototype (not iterable), which crashed a
  // `__proto__` table; a Map treats every table name as plain data.
  const initial = new Map<string, SnRecord[]>();
  const merge = (rows: Readonly<Record<string, readonly SnRecord[]>>): void => {
    for (const [table, records] of Object.entries(rows)) {
      initial.set(table, [...(initial.get(table) ?? []), ...records]);
    }
  };
  const initialState = (): Record<string, SnRecord[]> => {
    const out: Record<string, SnRecord[]> = {};
    for (const [table, records] of initial) setOwn(out, table, records);
    return out;
  };
  if (options.state) merge(options.state);
  if (options.fixture !== undefined) {
    merge(fixtureToSeed(parseFixtureBundle(options.fixture)).tables);
  }
  tables.seed(initialState());

  const router = createRouter({
    tables,
    cicd,
    faults,
    runIdParam,
    ...(options.cicdSuiteParams
      ? { cicdSuiteParams: options.cicdSuiteParams }
      : {}),
    ...(options.acl ? { acl: createFakeAcl(options.acl) } : {}),
    ...(options.readAcl ? { readAcl: createFakeReadAcl(options.readAcl) } : {}),
    ...(options.omitTotalCount ? { omitTotalCount: true } : {}),
    ...(options.statsCount ? { statsCount: options.statsCount } : {}),
    onRequest: (entry) => log.push(entry),
  });

  const handle = (request: FakeRequest): Promise<FakeResponse> =>
    router.handle(request);

  const fakeFetch: FetchLike = async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    // A relative path is accepted so the fake can be driven without a host.
    const url = new URL(rawUrl, `https://${host}`);
    const method = (init?.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) {
      throw new FakeAbortError(
        `fake instance: unsupported method ${method}`,
        "AbortError",
      );
    }

    const body = decodeBody(init?.body);
    const response = await handle({
      method: method as HttpMethod,
      path: url.pathname,
      params: url.searchParams,
      ...(body === undefined ? {} : { body }),
      ...(init?.signal ? { signal: init.signal } : {}),
    });

    // 204 (Table API DELETE) must carry no body, exactly like the real API.
    if (response.status === 204 || response.body === undefined) {
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: response.headers,
    });
  };

  return {
    tables,
    cicd,
    faults,

    requests() {
      return log.map((entry) => ({ ...entry }));
    },

    handle,

    fetch: fakeFetch,

    install(target) {
      const holder: FetchHost = target ?? globalThis;
      const previous = holder.fetch;
      holder.fetch = fakeFetch;
      return () => {
        holder.fetch = previous;
      };
    },

    seedFrom(fixture) {
      const seed = fixtureToSeed(parseFixtureBundle(fixture));
      tables.seed(seed.tables);
      return seed;
    },

    reset() {
      tables.clear();
      cicd.clear();
      faults.clear();
      log.length = 0;
      ids.reset();
      clock.reset();
      tables.seed(initialState());
    },
  };
}
