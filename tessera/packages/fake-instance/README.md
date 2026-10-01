# @tessera/fake-instance

Stateful in-memory fake ServiceNow instance — **QA-18**, the dependency of
PLAN Phase 0.5's Tier-2 CI job.

It is deliberately **not** a response replayer. Creates mint a `sys_id` and store
the row, updates mutate it, deletes remove it, and every later read reflects
those writes. DESIGN §4a's write-sequence invariants (delete ordering,
fresh-create identity, sweep scoping) and §4b's crash windows are only
falsifiable against a store that really holds state.

- Zero runtime dependencies (Node built-ins + `@tessera/types`).
- Deterministic: seeded SHA-256 `sys_id`s, a logical clock, poll-count-driven
  CI/CD lifecycle. No `Math.random()`, no wall clock, no module-level singletons.
- Injected by swapping `fetch`; `@tessera/sn-client` is not modified.

## Quick start

```js
import { createFakeInstance } from "@tessera/fake-instance";

const fake = createFakeInstance({
  state: { sys_atf_test_suite: [{ sys_id: "aaa1", name: "persistent suite" }] },
});

const restore = fake.install(); // globalThis.fetch := fake.fetch
try {
  // ...drive @tessera/sn-client exactly as it would talk to a real instance
} finally {
  restore();
}
```

Two ways in, same router underneath:

| Entry point                | Use it for                                           |
| -------------------------- | ---------------------------------------------------- |
| `fake.fetch` / `install()` | Driving real client code through the global `fetch`. |
| `fake.handle(request)`     | Asserting on status/body/headers without `Response`. |

## How injection works

`@tessera/sn-client`'s transport (`src/core/http.ts`) has exactly one seam: it
calls the **global** `fetch(url, init)` with `{ method, headers, body, signal }`
and reads a standard `Response` back (`res.ok`, `res.status`, `res.text()`,
`res.headers.get("x-total-count")`). So the fake:

1. exposes `fake.fetch`, a `fetch`-shaped adapter that decodes the request,
   routes it, and returns a real `Response` (a `204` carries a genuinely empty
   body, as the Table API does);
2. exposes `fake.install(host?)`, which assigns that adapter onto `host.fetch`
   (default `globalThis`) and returns the restore closure.

Nothing in `sn-client` changes, and each `createFakeInstance()` owns its own
state, ids, clock and fault rules — parallel tests never share a fake.

## Request surface

Derived from what `sn-client` actually sends:

**Table API** — `/api/now/{table,import}/<table>[/<sys_id>]`

| Request                | Behaviour                                                             |
| ---------------------- | --------------------------------------------------------------------- |
| `GET <table>`          | `200 { result: [...] }` + `X-Total-Count` (matches **before** paging) |
| `GET <table>/<sys_id>` | `200 { result: {...} }` or `404 "No Record found"`                    |
| `POST <table>`         | `201 { result: {...} }` with the minted `sys_id`                      |
| `PATCH`/`PUT` record   | `200 { result: {...} }` or `404`                                      |
| `DELETE` record        | `204`, empty body; `404` when already gone                            |

Supported parameters: `sysparm_query`, `sysparm_fields`, `sysparm_limit`,
`sysparm_offset`. `sysparm_no_count=true` omits `X-Total-Count`, as the
real Table API does; `createFakeInstance({ omitTotalCount: true })` omits it on
every list read (opt-in, default off — `sn-client` never sends
`sysparm_no_count`, so this is how its "no X-Total-Count" `fetchAll` path is
driven through the fake). `sysparm_display_value` / `sysparm_exclude_reference_link` are
accepted and ignored — every stored value is already a string, which is what
`display_value=false` returns.

**Aggregate (Stats) API count** — `GET /api/now/stats/<table>?sysparm_count=true`
(optionally `sysparm_query`, run through the same query engine) answers
`200 { result: { stats: { count: "<n>" } } }` — the count is a **string**, as a
real instance sends it. This is what `sn-client`'s `countRows` (and the opt-in
`fetchAll` `crossCheckCount`) calls. Only the plain count is modelled: without
`sysparm_count=true`, or with any avg/min/max/sum/group_by/having parameter, the
request keeps the record-level `404` every unmodelled `/api/now/` resource gets;
a non-`GET` answers `405`. The route is always served — there is no switch that
turns it off; an instance without the Stats API is modelled with the fault
registry below.

The `statsCount` construction option (both keys opt-in):

| Key           | Default                                                                                       | Set                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `aclFiltered` | the count covers **every** matching row, read-ACL-hidden ones included (like `X-Total-Count`) | `true`: the count excludes the rows the `readAcl` model hides, as the Table API page does. Has an effect only when `readAcl` is also configured |
| `fault`       | a well-formed string count                                                                    | `"non-numeric-count"` (`count: "many"`), `"missing-count"` (`stats: {}`) or `"numeric-count"` (a JSON number) — for fail-closed parser tests    |

The unfiltered default is an **assumption**: whether the real Stats API honours
row-level read ACLs is not verified live. Under `aclFiltered: true` a count
cross-check sees exactly the rows the Table API returned and detects nothing —
which is how the consumers' "trimmed last window" residual is pinned. HTTP and
transport failures of the stats path (a `404`/`403` instance without the Stats
API, a timeout) use the fault registry (`match: { path: "/api/now/stats/" }`).

```js
const fake = createFakeInstance({
  omitTotalCount: true, // drive the no-X-Total-Count path
  readAcl: {
    rules: [{ table: "sys_atf_test", when: (row) => row.active === "false" }],
  },
  statsCount: { aclFiltered: true },
});
```

Encoded-query subset: `^` (AND), `^OR`, `^NQ`, `ORDERBY`/`ORDERBYDESC`, and the
operators `=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE`, `NOT LIKE`, `STARTSWITH`,
`ENDSWITH`, `IN`, `NOT IN`, `ISEMPTY`, `ISNOTEMPTY`, `ANYTHING`. Unparseable
tokens are dropped, not thrown on. `=`/`!=`/`IN` are case-**sensitive** (stricter
than real ServiceNow collation, deliberately: a test that passes here passes
there); the `LIKE` family is case-insensitive.

### Equality semantics opt-ins

Two row-matching knobs change how `=` / `!=` / `IN` / `NOT IN` behave. Both
default to **off**, and both stay off until a real-instance capture proves
what ServiceNow does. `test/equalitySemanticsMatrix.test.js` pins every cell
of the table below for all four on/off combinations.

| Option                   | Operators affected        | Off (default)                              | On                                               |
| ------------------------ | ------------------------- | ------------------------------------------ | ------------------------------------------------ |
| `caseInsensitiveEquals`  | `=`, `!=`, `IN`, `NOT IN` | exact compare: `name=us-1` misses `US-1`   | both sides lower-cased: `name=us-1` finds `US-1` |
| `notEqualsExcludesEmpty` | `!=` only                 | an empty/absent value satisfies `field!=X` | an empty/absent value never satisfies `field!=X` |

Not affected by either option: `LIKE` / `NOT LIKE` / `STARTSWITH` /
`ENDSWITH` (always case-insensitive), `>` / `>=` / `<` / `<=` (never fold
case), `ISEMPTY` / `ISNOTEMPTY` / `ANYTHING`. `NOT IN` keeps matching empty
values even with `notEqualsExcludesEmpty` on — the option models the SQL
`col <> 'x'` NULL rule for `!=` alone, not for list operators. With both on,
`!=` first drops the empty rows, then compares the rest case-insensitively.

**Why they are off.** Off is the stricter reading for a test author: an
exact `=` can tell two run ids apart that differ only in case, and an
inclusive `!=` never silently hides a row. A suite that passes against the
defaults does not rely on either behaviour.

**Evidence needed to flip a default.** Neither default changes on reasoning
alone. What would be sufficient:

- `caseInsensitiveEquals` — a scrubbed live capture (the fixture-bundle
  schema below) from a real instance of `GET /api/now/table/<t>` with
  `sysparm_query=<field>=<value>` where the stored value differs from the
  operand only in case, for each of `=`, `!=`, `IN` and `NOT IN`, recording
  the returned rows and `X-Total-Count`. It must name the instance's database
  (MariaDB/MySQL vs. RaptorDB/PostgreSQL collation can differ) and ideally
  come from more than one release family. If different backends disagree the
  option stays opt-in and the capture names which backend each mode models.
- `notEqualsExcludesEmpty` — a scrubbed live capture of `<field>!=<value>`
  against rows where `<field>` is (a) a non-matching value, (b) an empty
  string written via the Table API, and (c) never written (NULL), also with
  `^OR<field>ISEMPTY` appended as the control. Rows (b) and (c) must both be
  observed; ServiceNow may store an empty string as NULL, so they can differ.

Flipping either default is then a separate, reviewed change that re-runs
every dependent suite: ten other workspace packages construct the fake with
the defaults, and none of them opts into either knob today.

**CI/CD API**

| Request                           | Behaviour                                            |
| --------------------------------- | ---------------------------------------------------- |
| `POST /api/sn_cicd/testsuite/run` | needs `sys_id` **or** `test_sys_id`; returns pending |
| `GET /api/sn_cicd/progress/<id>`  | advances one step per poll to a terminal state       |

Unknown paths **inside** `/api/sn_cicd/` answer a record-level 404, not the
namespace 404 wording — `sn-client`'s `api/plugin.ts` keys "plugin inactive" on
that wording and would cache "CI/CD unavailable" for five minutes. Unknown
top-level `/api/...` namespaces do return the namespace 404 body, on purpose.

### What is derived vs guessed

- **Derived** from `sn-client` (`core/http.ts`, `api/table.ts`, `api/atf.ts`,
  `api/shared.ts`, `api/plugin.ts`, `api/aggregate.ts`): all paths and parameter names above, the
  `{ result }` envelope, `X-Total-Count`, the `{ error: { message, detail } }`
  failure body, the namespace-404 wording, and the CI/CD payload fields the
  client reads (`status`, `status_label`, `status_message`, `percent_complete`,
  `links.progress.{id,url}`).
- **From the public CI/CD docs**, not verifiable in this repo: the numeric status
  codes `0..4` (Pending/Running/Successful/Failed/Canceled) and the
  `links.results` block on a completed run.
- **Guessed**, flagged in `src/cicd.ts`: the column names the fake writes onto
  `sys_atf_test_suite_result` beyond `test_suite`/`status` (`test`, `run_id`,
  `execution_id`, `start_time`, `end_time`). Reconcile against a live capture
  before any assertion depends on them.

## Fixture bundles

PLAN Phase 0.5: recorded fixtures seed the fake's **initial state**, but the fake
— not fixed replay — answers writes. A bundle is consumed exactly once, at
construction (or via `seedFrom`), and is never consulted again.

```jsonc
{
  "version": 1, // only 1 is understood
  "name": "tier2-seed",
  "description": "free text",
  "tables": {
    // rows inserted verbatim
    "sys_atf_test_suite": [{ "sys_id": "...", "name": "..." }],
  },
  "exchanges": [
    // captured request/response pairs
    {
      "method": "GET", // default "GET"
      "path": "/api/now/table/sys_properties",
      "query": "sysparm_query=name%3Dsn_atf.runner.enabled", // informational
      "status": 200, // default 200
      "body": {
        "result": [{ "sys_id": "...", "name": "...", "value": "true" }],
      },
    },
  ],
}
```

Harvest rules (`fixtureToSeed`), in order:

1. `tables` entries are inserted as given (a row's own `sys_id` is kept).
2. Every `GET` exchange with a 2xx status against `/api/now/{table,import}/<t>`
   contributes its `result` rows (array or single object) to table `<t>`.
3. Everything else — recorded writes, CI/CD polls, error responses, bodies with
   no `result` — is skipped and reported in `seed.ignored` with a reason.
   Replaying a captured `POST` response is exactly the stateless replay QA-18
   rejects.

Rows are deduped by `sys_id`, later capture wins. A malformed bundle throws
rather than booting a silently empty instance.

### Capturing a real bundle

`fixtures/tier2-seed.json` is **hand-written**: no live capture exists yet (the
PDI was unreachable when this package was written), so its rows are
plausible-but-invented. Drop a real capture with the same schema in its place and
nothing else changes.

To record one, wrap the global `fetch` while the walking skeleton runs against a
live instance and append one entry per exchange:

```js
const exchanges = [];
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await real(input, init);
  const url = new URL(typeof input === "string" ? input : input.url);
  const clone = res.clone();
  exchanges.push({
    method: (init?.method ?? "GET").toUpperCase(),
    path: url.pathname,
    query: url.search.slice(1),
    status: res.status,
    body: await clone.json().catch(() => undefined),
  });
  return res;
};
// afterwards: writeFileSync(out, JSON.stringify({ version: 1, exchanges }, null, 2))
```

Scrub the capture before committing it: instance host names, user records and
any encoded query carrying personal data.

Loading:

```js
import { readFixtureFile, createFakeInstance } from "@tessera/fake-instance";

const fixture = await readFixtureFile("fixtures/tier2-seed.json");
const fake = createFakeInstance({ fixture });
const { ignored } = fake.seedFrom(moreFixtureJson); // merge later captures
```

## Fault injection (DESIGN §4b)

Rules are opt-in, evaluated in insertion order, first match wins, each with an
optional `times` budget. Deterministic — no randomness, no wall-clock decisions.

| Mode                | Window | Effect                                                      |
| ------------------- | ------ | ----------------------------------------------------------- |
| `http-error`        | W1     | HTTP error response; **the mutation never happens**         |
| `transport-error`   | W1     | rejected `fetch`; the mutation never happens                |
| `crash-after-write` | W2     | the mutation lands, **then** the request fails              |
| `hang`              | DEV-2  | stalls for `ms`, or forever until the caller's signal fires |

```js
fake.faults.add({
  match: { method: "POST", table: "sys_atf_test", times: 1 },
  mode: { kind: "crash-after-write" }, // §4b W2: an orphan the caller cannot name
});
```

`match` accepts `method` (one or many), `path` (prefix string or `RegExp`),
`table`, `sysId` and `times`. `fake.faults.history()` lists the rule ids that
fired, in order; `fake.requests()` lists every request served, each carrying the
id of the fault that hit it.

Aborts are honoured ahead of the registry: a request whose `signal` is already
aborted rejects immediately and consumes no fault budget.

## Assertion helpers

- `fake.tables.recordsForRun(runId)` — the §4b Tier-2 pass criterion: every row,
  across tables, tagged with a run id (by field value or by name prefix, §4a).
  After a sweep this must be empty for the dead run while the persistent suite
  and a concurrent live run's rows are untouched.
- `fake.tables.snapshot()` — deep copy of the whole state.
- `fake.cicd.peek(id)` — read a run without advancing it.
- `fake.reset()` — back to the seeded state; clears faults, request log, ids and
  clock, so a scenario replays byte-identically.

## Layout

```
src/ids.ts        deterministic sys_id generation
src/clock.ts      logical clock (no wall clock)
src/record.ts     Table-API string coercion + field projection
src/query.ts      encoded-query parser/matcher/sorter
src/tables.ts     the stateful table model
src/cicd.ts       CI/CD run lifecycle + suite-run rows
src/faults.ts     fault registry and modes
src/errors.ts     ServiceNow error bodies, transport/abort errors
src/fixtures.ts   fixture bundle validation and harvesting
src/router.ts     the request-level surface
src/instance.ts   composition root + fetch adapter
```

## Commands

```
npm run build -w @tessera/fake-instance
npm run test  -w @tessera/fake-instance   # node --test; imports from build/
```
