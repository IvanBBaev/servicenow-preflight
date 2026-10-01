# Tessera (in development)

AI-driven test framework for ServiceNow — the codebase that
`servicenow-preflight` v1.0.0 is planned to become. This directory is a
**self-contained npm workspace**: it installs, builds, and tests independently
of the shipped package in the repository root, and nothing in here ships with
0.x releases.

## Packages

Exactly one of them is a composition root; every other package takes its
collaborators as arguments and names none of them (ARCH-1).

| Package                  | Role                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `@tessera/cli`           | **The composition root** — argv, config, role binding, wiring, exit codes. Ships `tess`         |
| `@tessera/mcp`           | The read-only MCP surface (tools only, DR-6) — turns a `tools/call` into a `tess` run           |
| `@tessera/types`         | Shared wire types: verdicts, checklist rows, test events, artifact refs                         |
| `@tessera/core`          | Pipeline ports (stage interfaces), engine, and the pure verdict reducer                         |
| `@tessera/config`        | One resolved value set per run: flag > env > `tessera.config.json` > default, with provenance   |
| `@tessera/resolvers`     | ARCH-5 "what changed?" — story and scope adapters, unioned and de-duplicated by the composite   |
| `@tessera/impact`        | ARCH-15 "what does it touch?" — textual where-used scan, graph builder, declared-intent join    |
| `@tessera/specs`         | The tests-as-code registry read off disk; the spec↔artifact link is declared, never inferred    |
| `@tessera/generate`      | The AI TestGenerator — prompt fencing, the lexical code gate, the quality bar, `proposed/` only |
| `@tessera/runner-atf`    | The ATF adapter — triggers a suite, polls it under a bound deadline, normalises the results     |
| `@tessera/reporter`      | Rendering only — console, `--json` and JUnit views of a run that has already been decided       |
| `@tessera/doctor`        | EnvironmentDoctor — three-state readiness over a declared precondition catalogue, read-only     |
| `@tessera/parity`        | ARCH-20 code-version parity: does the runner carry what the source was tested at?               |
| `@tessera/provisioner`   | Turns not-ready findings into an inspectable plan, and applies it only when asked (ARCH-2)      |
| `@tessera/guard`         | TargetGuard — the fail-closed §11 write-side control on the single mutation channel             |
| `@tessera/ledger`        | Write-ahead intent ledger (intend → write → confirm), run lifecycle, audit log                  |
| `@tessera/sn-client`     | ServiceNow REST client — transport, auth, write journal, typed API modules (vendored, MIT)      |
| `@tessera/store`         | Local projection store helpers and the collaboration lock (vendored)                            |
| `@tessera/fake-instance` | Stateful in-memory fake instance with injectable faults — what the Tier-2 suites run against    |
| `@tessera/phase05`       | The frozen Phase-0.5 walking-skeleton adapters, kept only behind `tess run --skeleton`          |

All packages are `private: true` — internal names, never published. Vendored
code keeps its provenance in a per-package `VENDORED.md`.

## Commands (run in this directory)

```sh
npm install
npm run check   # build + lint + format:check + test
npx tess --help
```

Conventions match the repo root: strict TypeScript, ESM with `Node16`
resolution (relative imports carry `.js`), Node >= 20, `node --test` suites
that import from each package's `build/` output — build before testing.

The `bin/` launchers sit outside that type-checked surface: each package's
`tsconfig.json` includes `src/**/*` only, so tsc never sees them, and ESLint
checks their syntax, not whether the symbol they import exists.
`packages/cli/test/launcher.test.js` and `packages/mcp/test/launcher.test.js`
cover them instead — each parses the imports out of every file its package
names in `bin` and asserts every named binding is a function in the built
output.

One convention does not match the root: `npm run check` here is the
four-stage script above, while the repository root defines a different
`check` that ends in `npm run test:coverage`. There is no code-coverage
stage in this workspace, so a root-level description of `check` as
"verify + coverage" describes the root package, not this one.

## Behaviour notes

User-visible behaviour that changed in the wave 15 and wave 16 hardening
passes. Each note names where the rule lives, so check the code before you rely
on a note.

### Reads without `X-Total-Count` are cross-checked with a Stats count

When the Table API sends no `X-Total-Count`, a read that otherwise looks
complete is confirmed with one Aggregate (Stats) API count of the same filter
(`GET /api/now/stats/<table>?sysparm_count=true`, ORDERBY terms dropped):

- `@tessera/runner-atf` (suite-result tree and result reads) and
  `@tessera/teststore-atf` (store and legacy-sweep reads) always do this.
  There is no opt-out.
- `@tessera/sn-client` does it only when the caller passes
  `queryTable({ fetchAll: true, crossCheckCount: true })`, and only when no
  other truncation reason has already flagged the read. A count that disagrees
  marks the result `truncated` with `truncationReason: "count-mismatch"`. A
  count it cannot get marks it `"count-unavailable"`.
- Any disagreement counts as a mismatch, including a count lower than the rows
  read. An instance without the Stats API (`404`, `403`), a failed request or
  an unreadable count never counts as a complete read. In the ATF adapters it
  is a refusal: runner-atf reports a suite tree it cannot confirm as an
  infrastructure fault, and teststore-atf refuses to continue. The check can
  only add a partial verdict. It never turns a partial read into GO.
- **Open question:** nobody has verified live whether the real Stats count
  honours row-level read ACLs. If it does, the count equals the rows the
  caller can see, and a trimmed last window stays invisible.
  `@tessera/fake-instance`'s `statsCount.aclFiltered` models that case.

### `sn_atf.runner.enabled` and `glide.installation.production`

Both properties are read with the shared safe-direction rule
(`@tessera/types` `decidePropertyRows`). Values are trimmed and case-folded
before they are compared:

- The ATF runner is enabled only when the value is exactly `true`. `1` and
  `yes` no longer count as enabled in the guard's topology probe. If the rows
  for the runner property differ, it reads as not enabled. The guard then
  downgrades the host to `prod-suspect`, so `tess preflight --mode apply`
  refuses with exit `4` before it plans or writes anything.
- An instance is non-production only when `glide.installation.production` is
  exactly `false`. Any other value, including rows that differ, reads as
  production.

### Impact traces more script tables by default in the CLI

`tess` impact analysis now traces these subject tables by default, in addition
to Script Includes and Business Rules: server-side UI Actions
(`sys_ui_action`), Scheduled Script Executions (`sysauto_script`), Scripted
REST operations (`sys_ws_operation`) and transform scripts
(`sys_transform_script`). `@tessera/impact` on its own still treats them as
opt-in. A lookup read that is refused, truncated or ACL-trimmed makes the
subject unanalyzable (INCONCLUSIVE, exit `5`). It is recorded in
`artifactTablesRefused` with `read: "lookup"` and printed as "impact lookup is
incomplete — …". A transport fault exits `3`.

### Completeness fields in `tess status --json` / `tess confirm --json`

Both commands now relay the persisted live record's `inventoryIncomplete`,
`verdictReason` and `artifactTablesRefused`. `status` puts them under `result`,
and `confirm` puts them at the top level. They are additive: a field appears
only when the record carries it in a well-formed shape, and nothing is
synthesized for a record written before the field existed.
`inventoryIncomplete` appears whenever the record carries it, even when it is
`false`.

### Waiting for the workspace build lock

`npm run build`, `npm test` and `npm run check` (and every package's `build` or
`test`) run under `scripts/build-lock.mjs`. By default a run that meets a held
lock exits `75` at once. To wait instead, set
`TESSERA_BUILD_LOCK_WAIT=<seconds>`:

```sh
TESSERA_BUILD_LOCK_WAIT=600 npm run build
```

- The value must be a whole number from `0` to `1800`. Unset or empty means `0`,
  which does not wait. Any other value (`-1`, `1.5`, `5s`, `1801`) is a usage
  error: the command exits `64` and never runs.
- The wait uses a backoff from 250 ms up to 2 s. It ends either by acquiring
  the lock or at the deadline, where the run exits `75` as it would without
  the wait. It never proceeds without the lock.
- Only a top-level run waits. A nested run whose tree has lost the hold still
  refuses at once. An unusable lock path (exit `78`) is never waited on.
