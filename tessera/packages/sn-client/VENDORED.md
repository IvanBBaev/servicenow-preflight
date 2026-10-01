# @tessera/sn-client — vendoring provenance

Every module body under `src/core/` and `src/api/` — except the net-new
`src/core/env-file.ts`, see below — is vendored from
**github.com/IvanBBaev/servicenow-mcp @ `5acdcc7`** (`5acdcc77bf415217d34620805f8f73a406a003bc`,
2026-07-03) under **ADR-002 option 4**. The upstream repository is **MIT**, and
the code was written by the sole author/copyright owner, so vendoring needs
nothing beyond attribution. Each file carries a two-line provenance header
naming its upstream path.

This is the package the architecture calls canonical (ARCH-7 / ARCH-18): the
credential, auth and transport layer for Tessera is servicenow-mcp's
`core/auth` + `core/config` + `core/http` — **not** syncrona's `credential-store`
or `sn-transport`, which are not vendored under any ADR-002 option. If
encryption at rest is wanted later it becomes a feature of this store, never a
second store.

## Why vendored, not depended on

Tessera cannot take a runtime dependency on the MCP server: that package is an
MCP process (stdio/HTTP transport, tool registry, MCP SDK dependency), while
Tessera needs only its REST client. Vendoring takes the client and leaves the
server behind — and keeps the two free to move at different release cadences.

## What was deliberately left behind

| Upstream module                              | Why it is not here                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/mcp/write-mode.ts`                      | MCP-layer glue for the plan/apply prompt flow. Tessera's plan/apply gate lives in `@tessera/core`'s configuration (ARCH-12), so this would be a second, competing gate.              |
| `src/tools/**`, `src/mcp/**`, `src/index.ts` | The MCP server itself (registry, transport, prompts, resources, result mapping).                                                                                                     |
| `src/core/jira/**`, `src/api/jira/**`        | Unrelated product surface. Its error type `JiraError` (upstream `core/errors.ts`) was removed too — nothing here could throw it (excision completed 2026-09-23, delegated decision). |
| `dotenv` (dependency)                        | Replaced by `src/core/env-file.ts` — see below. The package has **zero runtime dependencies**.                                                                                       |

`core/mtls.ts` keeps its optional `undici` import (a dynamic import through a
non-literal specifier), so mutual-TLS support activates only when `undici` is
actually installed and the package stays dependency-free without it.

## Adaptations

Only `config.ts`, `errors.ts`, `http.ts` and `policy.ts` differ from upstream in
substance. `host.ts`, `http-util.ts` and `settings.ts` carry **comment-only**
edits (2026-09-23) marking their Jira references as upstream-only, since the
Jira client was not vendored. Every other file is byte-identical to `5acdcc7`
below its 3-line header, except `auth.ts`, `api/compare.ts` and `api/plugin.ts`,
which Prettier re-wrapped to the workspace style — verified to differ only in
whitespace, trailing commas and leading union pipes, with no token changed.

| File                   | Adaptation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/env-file.ts` | **Net-new**, not vendored. A ~50-line parser reproducing the dotenv v16 _single-line_ grammar (`export` prefix, single/double/backtick quotes with same-kind escapes, one quote pair stripped, `\n`/`\r` expanded only inside double quotes, unquoted values trimmed and terminated by an inline `#`) plus `applyEnv()` with dotenv's `override: false` semantics. It covers the whole grammar `config.ts`'s `formatEnvValue()` serialiser can emit, so files written by the upstream server and by this client stay mutually round-trippable — but it is a strict **subset** of what dotenv can read. An unterminated quote **throws** (since 2026-09-23); the `KEY: value` separator is still silently dropped. See **Known parser gaps** below.  |
| `src/core/config.ts`   | `import dotenv` → `./env-file.js`; `loadEnv()` reads the file itself and applies the pairs with override:false. An unreadable/malformed env file is swallowed (optional configuration must not take the process down) — including the unterminated-quote error `env-file.ts` throws since 2026-09-23, so such a file is ignored as a whole, never half-applied. No other change.                                                                                                                                                                                                                                                                                                                                                                    |
| `src/core/errors.ts`   | `JiraError` removed (Jira excision completed 2026-09-23, delegated decision); `src/index.ts` exports `ServiceNowError` only. No in-monorepo consumer referenced it (grepped across `tessera/`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/core/http.ts`     | Two behavioural welds, below, plus the built-in never-write check on Table/Import API writes (ADR-007 C6, below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/core/policy.ts`   | The header documents the DEV-24 precedence contract between this env gate and `@tessera/core`'s plan/apply gate. One behavioural fix: `policyValue()` now treats an **empty** per-profile override as absent and falls through to the global key (upstream returned `""`, which silently disabled a global `SN_READONLY=1` for that profile — a blank line in an env template would have granted write access nobody asked for). This mirrors what upstream's own `authEnv()` already does for the auth keys. **Added 2026-09-23 (ADR-007 C6, delegated decision):** the built-in `NEVER_WRITE_TABLES` list (`sys_user_has_role`) and `assertTableWritable()`, and a doc note ratifying the `SN_TABLES_ALLOW` → ATF-run 403 (option a). Both below. |
| `src/index.ts`         | **New.** Public surface: core modules re-exported flat, api modules as namespaces (`tableApi`, `metaApi`, …) because several of them re-export core symbols and would otherwise collide.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Known parser gaps (`env-file.ts` vs real dotenv v16)

Verified by differential test against dotenv 16.6.1. Neither gap can be reached
by a file this client writes (`formatEnvValue()` throws rather than emit a value
containing a newline, always closes the quotes it opens, and always writes
`KEY=value`), but a **hand-written** or upstream-server-read `.env` can hit both:

1. **Multi-line quoted values are rejected** (since 2026-09-23, delegated
   decision — TODO "hand-rolled .env parser has two holes"). dotenv scans the
   whole file and lets a `"`-, `'`- or `` ` ``-quoted value span newlines. This
   parser splits on newlines first; it used to truncate `KEY="a⏎b"` to `"a` and
   then re-parse the continuation lines as top-level assignments, so text inside
   a quoted value could inject unrelated keys. Now any value that opens a quote
   the same line never closes makes `parseEnvContent()` **throw**, naming the
   line number and key but never the value (it may be a secret). Multi-line
   values are still unsupported — refused, no longer mis-read. Through
   `loadEnv()` the throw is swallowed with every other read/parse error, so the
   whole file is ignored (fail-closed: no truncated value, no injected key).
   A value closed on its line with trailing text (`KEY="a" b`) still parses to
   the raw `"a" b`, as dotenv does.
2. **The `KEY: value` separator is ignored** — still open, deliberately. dotenv
   accepts it; here the line is dropped. It fails closed — the key is simply
   absent — and supporting it means growing toward a full dotenv grammar.
   Recorded in the `env-file.ts` header and pinned by a test.

Gap 1 mattered most for `SN_OAUTH_JWT_KEY` (`core/auth.ts`), documented as an
inline PEM private key and so inherently multi-line: under the old behaviour
its truncated first line was still truthy, auth.ts's "requires SN_OAUTH_JWT_KEY
or SN_OAUTH_JWT_KEY_FILE" guard did not fire, and the failure would have
surfaced as an opaque signing error. With the throw, such a `.env` is refused
instead. The whole path is still **latent**: nothing in this monorepo calls
`loadEnv()` — `parseEnvContent`, `applyEnv` and `loadEnv` are exported
(`src/index.ts`) but not wired into a runtime path. `parseEnvContent` and
`applyEnv` are unit-tested (`test/configPolicy.test.js`); `loadEnv` itself has
no test anywhere in the monorepo, so whoever wires it in inherits no coverage.
Values reaching `process.env` from a shell or CI secret store are unaffected.
Prefer `SN_OAUTH_JWT_KEY_FILE`, which is read with `readFileSync` and is immune.

### DEV-24 — read-only gate at the transport boundary

`snRequest()` calls `assertWriteAllowed()` for every non-GET request, before
credentials are even read. Upstream applied the policy in the api layer only;
here it is defense in depth, so a caller reaching the transport directly cannot
bypass it. Precedence (documented in `policy.ts`): the env gate can only ever
_remove_ permission that `@tessera/core`'s configuration granted, and a denial
is an explicit 403 `ServiceNowError` — **never a silent skip, never a green
verdict**.

The **table** policy (`SN_TABLES_ALLOW` / `SN_TABLES_DENY`) is enforced on
writes at the same boundary, for the same reason: upstream called
`assertTableAllowed()` from the Table API layer only (six sites in `api/`), so
an operator who set a table policy had no way to notice it did not reach a
non-Table-API write. A non-Table-API path names no table, so the allowlist
cannot literally be extended to it; the two axes are answered on their own
terms instead:

- under `SN_TABLES_ALLOW` (a positive containment claim) an unclassifiable
  write is **refused** with a 403 — the fail-closed reading already ratified
  for `policyValue()`, since letting it through would make _setting_ an
  allowlist widen what a caller may do;
- under `SN_TABLES_DENY` alone (a claim about named tables) the write
  **proceeds**, with a `logger.warn` naming the method and path — never the
  query string, which can carry personal data. Inventing a denial the operator
  never wrote would be worse than the silence; leaving the silence in place is
  the defect.
- with no table policy set there is no claim to violate and nothing is said.

**Reads are deliberately not gated here.** `@tessera/doctor` and
`@tessera/parity` read through this transport precisely so a client-fabricated
403 can never be reported as the instance's own refusal (the DEV-1 attribution
ruling); moving the read gate down to the transport would take that distinction
away from them. The read-side bypass for a direct `snRequest` caller is
therefore a known, chosen residual — it is those packages' design, not an
oversight here.

**`SN_TABLES_ALLOW` refuses the ATF run surface — ratified (delegated decision
2026-09-23, option a).** The CI/CD test-run POST (`/api/sn_cicd/testsuite/run`,
reached by `atfApi.runAtfSuite` / `runAtfTest` and therefore by
`@tessera/runner-atf` and `@tessera/phase05`) names no table, so under an
allowlist it is refused with the 403 above, before any request. This is kept,
not special-cased: carving the run endpoint out of the allowlist would make the
"only these tables" claim false for a surface that executes arbitrary test
steps. A run that needs ATF leaves `SN_TABLES_ALLOW` unset and narrows tables
with `SN_TABLES_DENY`. Documented in `policy.ts` and pinned by
`test/httpWrite.test.js`.

### ADR-007 C6 — built-in never-write list (divergence, 2026-09-23)

`policy.ts` exports `NEVER_WRITE_TABLES` — a frozen constant holding at least
`sys_user_has_role`, the role-grant table — and `assertTableWritable()`.
`snRequest()` calls it for every Table/Import API **write**, _before_ the
operator's allow/deny lists, so the write is refused with a 403 even when
`SN_TABLES_ALLOW` names the table, and even when the api layer's own
`assertTableAllowed()` (which the allowlist satisfies) has already passed.
Reads are untouched: verifying role membership is exactly what ADR-007 C6
requires. It is a constant rather than an env var on purpose — an
operator-configurable denylist can be emptied. Upstream servicenow-mcp has no
such list; this is a Tessera divergence. Residual, stated: a write that names
no table (a background script, a CI/CD call) is not classified by table and so
is not covered by this list — the generation gate (`@tessera/generate`
`gate.ts`) is what refuses `sys_user_has_role` in generated script bodies.

### DEV-15 — write journal at the transport boundary

Upstream journalled applied mutations (DF-2) in its MCP tool handlers, which are
not vendored — so the vendored client would have shipped with an audit trail
that nothing writes to. `snRequest()` now calls `appendWriteJournal()` itself,
after the response proves the mutation was applied:

- `/api/now/{table,import}/<table>[/<sys_id>]` → `create` (POST) / `update`
  (PATCH, PUT) / `delete` (DELETE), table and `sys_id` percent-decoded;
- any other mutating path → `execute`, keyed by the path. Over-journalling is
  deliberate: an entry too many is a lesser failure than an applied write with
  no trace.

The **payload** is recorded for every write, not only the Table API ones: a
JSON object body as `fields`, the query arguments as `params` (repeated keys
kept as arrays). On the non-table paths that is not a nicety but the entire
content — the CI/CD endpoints (`atfApi.runAtfSuite`, `runAtfTest`,
`@tessera/phase05`) send **no body at all** and carry everything identifying
their target in the query string, so an entry without `params` names the
endpoint and nothing about what it acted on. Where the payload cannot be
decomposed into named values — a pre-encoded `rawBody`, a non-object JSON
body — the entry sets `payload_unknown: true` rather than merely omitting
`fields`, which would be indistinguishable from a write that sent nothing: an
unrecorded payload is a fact the audit trail has to state. The markdown row
mirrors all three states (`field`, `?param`, `(payload not recorded)`) so the
human-readable half never goes silent where the jsonl half does not.

Unlike `logger` fields, the journal may carry the query arguments: it is a
local file under the operator's docs dir and recording them is the point of the
artefact.

No double-journalling is possible, but **not** because writes are never
retried — they are. `appendWriteJournal()` is called past every `continue` in
the retry loop, on its sole success path, so it runs at most once per
`snRequest()` call however many attempts were made. (Non-GET requests _are_
retried after a received response: 429 is retryable for any method, and the
one-shot 401 OAuth re-auth re-issues regardless of method. Moving the call
above either `continue` would double-journal.) The upstream tool layer that
also journalled is not part of this package. Journalling is best-effort — `appendWriteJournal()`
never throws, so a file-system failure cannot turn a successful write into an
error.

## Vendored files

`src/core/` — `auth.ts`, `cache.ts`, `config.ts`, `errors.ts`, `host.ts`,
`http.ts`, `http-util.ts`, `jwt.ts`, `logging.ts`, `mtls.ts`, `oauth-login.ts`,
`pkce.ts`, `policy.ts`, `request-context.ts`, `settings.ts`, `write-journal.ts`

`src/api/` — `table.ts`, `meta.ts`, `scripts.ts`, `whereused.ts`, `flows.ts`,
`atf.ts`, `compare.ts`, `snapshot.ts`, `capabilities.ts`, `shared.ts`,
`plugin.ts`, `docs.ts`, `aggregate.ts`

`plugin.ts`, `docs.ts` and `aggregate.ts` are not in the PLAN's named list; they
are the transitive closure of the modules that are (`scripts`/`atf` import
`plugin`, `compare` imports `docs`, and `snapshot` imports both `docs` and
`aggregate`).

## Tests (QA-2)

The upstream suites are Vitest-style and reach deep into the MCP server's
fixtures, so rather than port them the vendored copies are guarded by **contract
tests at their new boundary** — the package's public surface, with `globalThis.fetch`
stubbed. Nothing here touches a real instance.

| File                        | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/httpWrite.test.js`    | The two adaptations: DEV-15 journal (create/update/delete/execute mapping, `fields`/`params`/`payload_unknown`, per-profile directory, markdown row, no journal for reads or rejected writes, never throws on fs failure), the DEV-24 gate (403 before any request leaves the process, reads still allowed, checked before credentials, falsy flags do not gate), and table-policy coverage at the transport (denied/non-allowlisted table writes refused, a table-less write refused under an allowlist and warned under a denylist only, no warning without a policy, decoded table matching, and reads deliberately left ungated), the ADR-007 C6 never-write list (every write method refused even when allowlisted, via the transport and via `tableApi.createRecord`; reads allowed; case/encoding normalised) and the ratified `SN_TABLES_ALLOW` → `runAtfSuite` 403. |
| `test/configPolicy.test.js` | `env-file.ts` grammar (including the unterminated-quote throw, whose message must not echo the value, and the still-dropped `KEY: value` line), the `formatEnvValue` → `parseEnvContent` round-trip, `applyEnv` override:false, and the policy gates (read-only truthiness, allow/deny precedence, per-profile overrides).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/apiContract.test.js`  | `resolveHost` SSRF rules, the `shared.ts` helpers (`expectResult`, `snString`, `assertNoCaret`, markdown escaping) and the Table API wrapper's request shape, response unwrapping and error path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
