# servicenow-preflight

<!-- badges:start -->

|                                        [![npm version](https://img.shields.io/npm/v/servicenow-preflight?style=flat-square&logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/servicenow-preflight)                                        |                   [![npm downloads](https://img.shields.io/npm/dm/servicenow-preflight?style=flat-square&logo=npm&logoColor=white&label=downloads)](https://www.npmjs.com/package/servicenow-preflight)                   | [![node](https://img.shields.io/node/v/servicenow-preflight?style=flat-square&logo=nodedotjs&logoColor=white&label=node)](https://www.npmjs.com/package/servicenow-preflight) |                            [![license](https://img.shields.io/npm/l/servicenow-preflight?style=flat-square&color=blue&label=license)](LICENSE)                            |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/servicenow-preflight/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/servicenow-preflight/actions/workflows/ci.yml) | [![last commit](https://img.shields.io/github/last-commit/IvanBBaev/servicenow-preflight?style=flat-square&logo=git&logoColor=white&label=last%20commit)](https://github.com/IvanBBaev/servicenow-preflight/commits/main) |             [![Known Vulnerabilities](https://snyk.io/test/npm/servicenow-preflight/badge.svg?style=flat-square)](https://snyk.io/test/npm/servicenow-preflight)              | [![built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org) |

<!-- badges:end -->

[![docs & live demo](https://img.shields.io/badge/docs-live%20demo-2ea44f?style=flat-square)](https://ivanbbaev.github.io/servicenow-preflight/)

Pre-deployment **preflight checks** for ServiceNow — validate a target instance
and your changes _before_ you ship them. Point it at an instance and it catches
what quietly breaks a deploy: an update set that isn't really complete, failing
ATF tests, a missing plugin dependency, untranslated strings, a wide-open ACL.
It ships as both a **CLI** you drop into a CI gate and a small, dependency-free
**library** you can embed.

> Independent, community-built project. Not affiliated with, endorsed by, or
> sponsored by ServiceNow, Inc.

**Docs & live demo:** <https://ivanbbaev.github.io/servicenow-preflight/>

## Contents

- **Start here** — [Quick start](#quick-start) ·
  [What it checks](#what-it-checks) · [CLI](#cli)
- **Configure** — [Credentials & auth](#credentials--auth) ·
  [HTTP(S) proxy](#https-proxy) · [Configuration file](#configuration-file)
- **Pipelines** — [Multi-instance: registry, sync & drift](#multi-instance-registry-sync--drift) ·
  [Report formats](#report-formats) · [CI integration](#ci-integration)
- **Embed** — [Library API](#library-api) · [Development](#development) ·
  [Security](#security) · [Support](#support) · [License](#license)
- **Preview** — [Tessera: `tess` and `tessera-mcp`](#tessera-preview-tess-and-tessera-mcp)

## Quick start

**Requires Node.js >= 20** (developed and tested on 22). Zero runtime
dependencies — one package built on Node's global `fetch`.

```bash
# Provide credentials via the environment (or a .env file — see below).
export SNPF_INSTANCE=https://dev12345.service-now.com
export SNPF_USER=admin
export SNPF_PASS='***'

npx servicenow-preflight        # run the default suite (short alias: snpf)
```

```text
✓ instance-url-configured: Instance URL looks good: https://dev12345.service-now.com
✓ connectivity-auth: Instance is reachable and the credentials authenticate.
! update-set-state: No update set specified (set SNPF_UPDATE_SET, add "updateSetId" to the config file, or set PreflightContext.updateSetId); skipping the update-set state check.
! default-set-leakage: No target scope set (PreflightContext.scope); nothing to verify — skipping the Default-set leakage check.
✓ remote-set-preview: No pending retrieved update sets on the target instance — nothing awaiting preview or commit.
✓ atf-enablement: ATF test execution is enabled ("sn_atf.runner.enabled" is "true").
! atf-run: No ATF suite configured (set options.atfSuites or options.atfSuiteId); skipping.
! scoped-app-deps: No required apps declared (set options.requiredApps to verify dependencies); skipping.
! i18n-completeness: No target scope set (PreflightContext.scope); skipping i18n completeness check.
! acl-role-sanity: No scope set — skipping ACL/role sanity (pass a scope to enable it).
! client-callable-acl: No scope set — skipping the client-callable Script Include ACL gate (pass a scope to enable it).
! rest-endpoint-security: No scope set — skipping the scripted REST security gate (pass a scope to enable it).
! script-field-exposure: No scope set — skipping the script-field write ACL gate (pass a scope to enable it).
! scheduled-job-run-as: No scope set — skipping the Scheduled Job 'Run as' gate (pass a scope to enable it).
! mobile-menu-hygiene: No scope set — skipping the mobile menu/module gate (pass a scope to enable it).
! table-crud-acl: No scope set — skipping the table CRUD ACL gate (pass a scope to enable it).
! ui-page-acl: No scope set — skipping the UI Page read ACL gate (pass a scope to enable it).
! ui-action-gating: No scope set — skipping the UI Action gating check (pass a scope to enable it).
! table-namespace: No scope set — skipping the table namespace check (pass a scope to enable it).
! portal-roles: No scope set — skipping the Service Portal widget/page roles check (pass a scope to enable it).
! acl-out-of-scope: No scope set — skipping the out-of-scope ACL check (pass a scope to enable it).
! module-roles: No scope set — skipping the navigator module roles check (pass a scope to enable it).
! script-hygiene: No scope set — skipping the Fix Script / Script Include hygiene check (pass a scope to enable it).
! hardcoded-identifiers: No scope set — skipping the hard-coded identifier scan (pass a scope to enable it).
! client-script-safety: No scope set — skipping the client script safety scan (pass a scope to enable it).
! property-privacy: No scope set — skipping the system property privacy check (pass a scope to enable it).
! inactive-artifacts: No scope set — skipping the inactive artifact sweep (pass a scope to enable it).
! notification-conditions: No scope set — skipping the Notification condition check (pass a scope to enable it).
! log-leftovers: No scope set — skipping the log leftover scan (pass a scope to enable it).
! deprecated-apis: No scope set — skipping the deprecated API scan (pass a scope to enable it).

4 passed, 26 warnings, 0 failed
```

Two identical binaries ship — `servicenow-preflight` and the alias `snpf`. Out
of the box only the checks that need no target-specific input do real work; the
rest turn on once you supply their inputs (a scope, an update set, ATF suite
ids, required apps) via a [config file](#configuration-file). The CLI **exits
non-zero on any `fail`**, so it drops straight into a pipeline before a
promote/deploy step.

### Scaffold a project: `init`

```bash
npx servicenow-preflight init --instance https://dev12345.service-now.com \
  --scope x_acme_app --ci github
```

`init` writes `preflight.config.json` (with a `$schema` reference), the CI
pipeline for `--ci github|gitlab|azure` (`none` by default; GitHub uses the
[action](#github-action)), and appends `.env`, `.preflight/fixtures/` and
`.preflight/trace*.ndjson` to `.gitignore` (lines already there are kept).
`--multi` writes `.preflight/instances.json` with one `dev` instance instead
of putting the URL in the config. `--auth basic|oauth-client|bearer|mtls`
picks which credential variables it lists and maps in CI.

It **never writes credentials or `.env`**: it prints the variable names to
set, with placeholders. On a terminal it asks each question (flags are the
defaults); with `--yes` or without a TTY it uses the flags only and never
waits for input. An existing file is never overwritten without `--force` —
`init` exits `2` and names the files, and writes nothing.

`init --check` runs [`doctor`](#readiness-check-doctor) against what it just
wrote (the `dev` instance with `--multi`) once the credentials are in the
environment; it exits `1` when a doctor row fails.

## What it checks

`runPreflight(ctx, checks?)` runs each check against the target instance and
aggregates a single `PreflightReport` (`ok`, `results`, `summary`). Thirty-four
checks ship in the default suite; the CLI is a thin wrapper over that function.

| Check                     | Needs                        | Verifies                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance-url-configured` | —                            | An instance URL is present and well-formed (prefers `https`).                                                                                                                                                                                                                                                                                                                         |
| `connectivity-auth`       | credentials                  | The instance is reachable and the credentials authenticate.                                                                                                                                                                                                                                                                                                                           |
| `update-set-state`        | `updateSetId`                | The target update set, and any batched child sets, are `complete` and non-empty (not in-progress or `ignore`d).                                                                                                                                                                                                                                                                       |
| `default-set-leakage`     | `scope`                      | No captured work is stranded in a "Default"-flagged update set for the scope — changes that would never ship.                                                                                                                                                                                                                                                                         |
| `remote-set-preview`      | credentials                  | Every pending retrieved update set on the target is previewed with all preview problems resolved (`updateSetId`, when set, focuses the gate on one set).                                                                                                                                                                                                                              |
| `atf-enablement`          | credentials                  | ATF test execution is enabled instance-wide (optionally also an online scheduled client test runner, via `options.atfEnablement.requireClientTestRunner`).                                                                                                                                                                                                                            |
| `atf-run`                 | `options.atfSuites`          | Configured ATF test suites run green (no failing or errored tests).                                                                                                                                                                                                                                                                                                                   |
| `scoped-app-deps`         | `options.requiredApps`       | Required scoped apps / plugins are installed, active, and meet any `minVersion`.                                                                                                                                                                                                                                                                                                      |
| `i18n-completeness`       | `scope`, `options.languages` | Every configured language has full translation coverage for the scope.                                                                                                                                                                                                                                                                                                                |
| `acl-role-sanity`         | `scope`                      | No wide-open mutating ACLs, and no ACLs referencing non-existent roles.                                                                                                                                                                                                                                                                                                               |
| `client-callable-acl`     | `scope`                      | Every active client-callable Script Include is gated by an active `execute` ACL (Store certification rule 1.2).                                                                                                                                                                                                                                                                       |
| `rest-endpoint-security`  | `scope`                      | Scripted REST resources require authentication and enforce ACL authorization backed by a `REST_Endpoint` ACL (rule 1.3).                                                                                                                                                                                                                                                              |
| `script-field-exposure`   | `scope`                      | Every script-typed column ships with an active field write ACL — `table.element` or `table.*` (rule 1.4).                                                                                                                                                                                                                                                                             |
| `scheduled-job-run-as`    | `scope`                      | Scheduled Jobs leave "Run as" empty so they run as `system` (rule 6.2; advisory — never fails).                                                                                                                                                                                                                                                                                       |
| `mobile-menu-hygiene`     | `scope`                      | No mobile Application Menus/Modules ship in a non-mobile app (rule 5.1; advisory — never fails).                                                                                                                                                                                                                                                                                      |
| `table-crud-acl`          | `scope`                      | Every custom table has active table-level create/read/write/delete ACLs (rule 1.1; a gap on an extended table only warns).                                                                                                                                                                                                                                                            |
| `ui-page-acl`             | `scope`                      | Every custom UI Page is protected by an active `ui_page` read ACL named for its endpoint (rule 2.2).                                                                                                                                                                                                                                                                                  |
| `ui-action-gating`        | `scope`                      | Every active UI Action has a condition or a "Requires role" entry (`sys_ui_action_role`) — none is runnable by every user (rule 2.1).                                                                                                                                                                                                                                                 |
| `table-namespace`         | `scope`                      | Every custom table is prefixed with the app namespace (`<scope>_`), taken from the resolved scope name (rule 6.1).                                                                                                                                                                                                                                                                    |
| `portal-roles`            | `scope`                      | Service Portal widgets and pages carry roles unless deliberately public; public ones are called out (rule 2.6; advisory — never fails).                                                                                                                                                                                                                                               |
| `acl-out-of-scope`        | `scope`                      | The app ships no ACLs onto tables outside its scope — table-level/wildcard ones fail; a field ACL for the app's own field only warns (rule 1.6).                                                                                                                                                                                                                                      |
| `module-roles`            | `scope`                      | Active navigator modules are gated by their own or their application menu's roles, honouring `override_menu_roles` (rule 5.5; advisory — never fails).                                                                                                                                                                                                                                |
| `script-hygiene`          | `scope`                      | No Fix Scripts that are empty or comments only, and no Script Include names duplicated in the scope or shared with another scope (rule 4.10; advisory — never fails).                                                                                                                                                                                                                 |
| `hardcoded-identifiers`   | `scope`                      | No hard-coded sys_ids or non-instance URLs in active in-scope server and client scripts; comment lines are ignored and messages give artifact, field and line only (rule 4.5; advisory — a security-trimmed read fails).                                                                                                                                                              |
| `client-script-safety`    | `scope`                      | No `eval(`, `new Function(` or `new GlideRecord(` in active in-scope client scripts, UI Scripts, UI Policy scripts and UI Action client scripts, and no `GlideScopedEvaluator` with `evaluateScript` on one line in server scripts; comment lines are ignored and messages give artifact, field and line only (rule 2.8; blocker — a security-trimmed read fails).                    |
| `property-privacy`        | `scope`                      | Password-typed system properties are private (kept out of update sets and clones); a secret-like name with a plain type is flagged.                                                                                                                                                                                                                                                   |
| `inactive-artifacts`      | `scope`                      | No inactive Business Rules, Client Scripts, Script Includes, UI Actions, UI Policies, Scheduled Jobs or Notifications ship with the app (dead code still installs). Advisory.                                                                                                                                                                                                         |
| `notification-conditions` | `scope`                      | No active Notification fires on every update of its table — each is tied to an event or carries a condition (mail-storm guard). Advisory.                                                                                                                                                                                                                                             |
| `log-leftovers`           | `scope`                      | No `console.log(` / `console.debug(` / `console.dir(` or debug `alert(` in active in-scope client scripts, UI Scripts, UI Policy scripts and UI Action client scripts, and no `gs.print(` / `gs.log(` (unavailable in scoped apps) in server scripts; comment lines are ignored and messages give artifact, field and line only (rule 4.3; advisory — a security-trimmed read fails). |
| `deprecated-apis`         | `scope`                      | No `Packages.` Java calls (not available in scoped apps) in active in-scope server scripts — those fail; synchronous `getXMLWait(`, a callback-less `g_form.getReference(…)` and the server-only `gs.hasRole` in client scripts warn. Comment lines are ignored and messages give artifact, field and line only (blocker — a security-trimmed read fails).                            |
| `platform-release`        | credentials                  | Reports the release family the instance runs (`glide.buildname`, plus the leading token of `glide.war`); fails below `options.platform.minRelease` and warns when it differs from `options.platform.expect`, when the family is unset or unknown, or when the read was trimmed. Advisory.                                                                                             |
| `cors-rules`              | `scope`                      | Every active in-scope CORS rule (`sys_cors_rule`) names an exact origin: an empty domain, `*` or a bare-TLD wildcard (`*.com`) fails, a wildcard sub-domain (`*.example.com`) warns. Messages name rules only, never the domain (rule 2.7; blocker — a security-trimmed read fails).                                                                                                  |
| `table-access-settings`   | `scope`                      | Application Access on every in-scope table: a table accessible from all application scopes that also grants create, update or delete to them fails; public read-only access and web-service access without a user role warn (blocker — a security-trimmed read fails).                                                                                                                |
| `cross-scope-privileges`  | `scope`                      | No cross-scope privilege the scope holds as a source (`sys_scope_privilege`, keyed on `source_scope`) is denied — those fail; privileges still only requested, or with an unknown status, warn. Messages name the target record and operation only (blocker — a security-trimmed read fails).                                                                                         |

Checks whose only need is credentials always run once credentials are present;
the rest `warn` (and explain what's missing) until you supply their inputs —
they never silently pass. Each check returns one status —
`pass` (`✓`, holds), `warn` (`!`, advisory), or `fail` (`✗`, blocks). **Only a
`fail` fails the run**; warnings do not, unless you pass `--fail-on warn`. Checks never throw (transport/auth/API
errors map to a result), and are read-mostly (the sole write is running the ATF
suites you configure).

**Exit codes:** `0` when no check `fail`ed; `1` when a check `fail`ed (or, under
`--fail-on warn`, when a row `warn`ed that no baseline accepted), when a
selection matched zero checks (nothing verified — treated as a failure, never a
vacuous pass); `2` for a usage
error — a bad invocation or config caught before any check runs (unknown option,
invalid `--format` value, malformed `--max-age` or `--timeout`, missing required
argument, an invalid config, registry or state manifest); `3` for a runtime
error — the tool could not run (a network or HTTP failure outside the checks,
such as during `sync`, an unreadable or unwritable file, an unexpected crash),
so CI can retry or page instead of treating it as a blocked release; `130` when
the run was interrupted with Ctrl-C (SIGINT) — the checks cut short are reported
as `fail` rows in the report that is still printed. A failure inside a check is
always a `fail` row (exit `1`), never exit `3`.

## CLI

```bash
snpf [run] [env] [options]     # run checks (default subcommand)
snpf sync <env> [options]      # pull ATF metadata → state manifest
snpf drift <src> <dst>         # compare two instances (promote gate)
snpf list [--format json]      # the check catalogue: name, severity, rule, description
snpf explain <check>           # one check: rule, tables, verdicts, remediation
snpf config schema [--out <file>]  # the config file's JSON Schema
snpf config validate           # check the config file against it
snpf config migrate [--write]  # move shared options into per-check blocks
```

`list` and `explain` read only the built-in catalogue — no config, credentials or
network. `list` prints one line per check (`test-drift` is marked `(drift only)`);
`--format json` prints the full catalogue. `explain` shows the check's
certification rule and its title, the tables it reads, the wording of each
verdict and what to change on the instance to make it pass. An unknown name is
exit `2` with up to three close matches (`Did you mean: table-crud-acl?`). Both
accept only `--format pretty` or `json`. The `config` actions are described in
[Validating the config](#validating-the-config); they need no credentials or
network either.

Both `--flag value` and `--flag=value` forms are accepted.

| Flag                          | Description                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `-i`, `--instance <url>`      | Target instance URL (single-instance, no registry).                                                                           |
| `-e`, `--env <name>`          | Select a registry instance (same as positional).                                                                              |
| `--all`                       | `run`: sweep every instance in the registry.                                                                                  |
| `--registry <path>`           | Registry file (default `.preflight/instances.json`); see below.                                                               |
| `--config <path>`             | Config file (default: auto-discovered).                                                                                       |
| `--only` / `--skip <csv>`     | Run only / skip these checks (comma-separated names).                                                                         |
| `--changed-since <dur\|date>` | `run`: only the checks whose tables changed since `<dur>` ago (`24h`, `7d`) or an ISO date; see below.                        |
| `--with-last-run`             | `sync`: also pull each test's most recent result.                                                                             |
| `--allow-empty`               | `sync`: commit an empty snapshot over a non-empty manifest.                                                                   |
| `--max-age <dur>`             | `drift`: fail if a compared manifest is older than `<dur>` (e.g. `7d`, `24h`).                                                |
| `--allow-stage-skip`          | `drift`: warn instead of fail when `<dst>` skips a declared pipeline stage.                                                   |
| `--format <fmt>`              | `pretty` (default), `json`, `junit`, `sarif`, `markdown`, `github` (`list`/`explain`: `pretty` or `json`).                    |
| `--json` / `-h`               | Shorthand for `--format json` / show help.                                                                                    |
| `--baseline [path]`           | `run`: demote findings recorded in a baseline file to warnings (see [Baseline](#baseline-accepted-findings)).                 |
| `--write-baseline [path]`     | `run`: record every non-pass result as a new baseline file.                                                                   |
| `--force`                     | `--write-baseline`: overwrite an existing baseline file.                                                                      |
| `--severity <check>=<level>`  | `run`: report a check's non-pass result as `fail` or `warn`, or skip it (`off`). Repeatable; wins over the config `severity`. |
| `--timeout <dur>`             | `run`: fail any check still running after `<dur>` (e.g. `30s`, `500ms`) and move on. Default: none; `SNPF_CHECK_TIMEOUT`.     |
| `--run-timeout <dur>`         | `run`: stop the run (per instance) after `<dur>`; unfinished checks become `fail` rows.                                       |
| `--fail-on <level>`           | `run`: `fail` (default) exits `1` on a `fail` row only; `warn` also on a `warn` row no baseline accepted. `SNPF_FAIL_ON`.     |
| `--output <format>=<path>`    | `run`: also write the report as `<format>` to `<path>` (atomic; folders created). Repeatable.                                 |
| `--no-summary`                | `run`: inside GitHub Actions, skip the step summary. `SNPF_SUMMARY=0`.                                                        |
| `--concurrency <n>`           | `run`: most checks running at once, 1–32. Default `4`; `SNPF_CONCURRENCY`.                                                    |
| `--max-inflight <n>`          | Most requests in flight at once, 1–64. Default `4`; `SNPF_MAX_INFLIGHT`.                                                      |
| `--rps <n>`                   | Requests started per second, 0.5–100. Default: unlimited; `SNPF_RPS`.                                                         |
| `--no-cache`                  | `run`: fetch every read, instead of sharing identical reads between checks. Also `SNPF_CACHE=0`.                              |
| `--timings`                   | `run`: print per-check time, requests, retries and cache hits to stderr; with `--format json`, a `timings` object per run.    |
| `--trace <path>`              | `run`: write a local NDJSON trace of the run (mode `0600`). Also `SNPF_TRACE`. See [Diagnostics](#diagnostics).               |
| `--record <dir>`              | `run`: also save every response, redacted, to `<dir>` for a later `--replay`. See [Record and replay](#record-and-replay).    |
| `--record-raw`                | `run`: with `--record`, keep user and group names and emails (secrets are still redacted).                                    |
| `--replay <dir>`              | `run`: answer every request from a recording — no network, no credentials.                                                    |

Durations take a unit: `ms`, `s`, `m`, `h`, `d` or `w`. A timed-out check is
cancelled — its in-flight requests are aborted — and reported as
`Check timed out after 30000 ms (--timeout).`; the per-request HTTP timeout
still applies inside it.

### Performance

A run executes up to `--concurrency` checks at once (default `4`, or
`SNPF_CONCURRENCY`); the ATF checks always run alone, one after another,
once the others are done. The report keeps registry order, so it is the same
at any concurrency. Requests from every running check share the client's
in-flight cap below.

`--max-inflight` and `--rps` keep a run from tripping the instance's inbound
REST rate limit or starving its other integrations. A `429` answer also holds
back every queued request for its `Retry-After` window. Both are read from the
instance's env namespace (`SNPF_<ENV>_RPS`) like the credentials; an
out-of-range value exits `2`.

A run shares identical Table API reads between its checks: the first check to
ask fetches, and the others reuse the result. The cache lives in memory for
one run only, failed reads are never cached, and the report is the same with
or without it. `--no-cache` (or `SNPF_CACHE=0`) turns it off.

`--changed-since` makes an incremental run. It reads the tables changed since
then from the target update set's `sys_update_xml` rows (child sets included),
or, without an update set, from the scope's `sys_metadata` rows, and runs only
the checks whose `tables` (see `explain`) include one of them. A check that
always runs, declares no tables or reads instance state (update sets,
retrieved-set previews, ATF results: `update-set-state`, `default-set-leakage`,
`atf-run`) is always kept, so a check is never dropped for lack of metadata.
Skipped checks are not rows (as with `--skip`); a stderr line names the kept
count and the changed tables. With no changes, a
`preflight:incremental` warn row says so. A change read over the row cap runs
every check. It composes with `--only` / `--skip` and is refused with
`--write-baseline` (exit 2), since the baseline would be partial. Git refs are
not supported.

`--instance`, `--only` and `--skip` override the matching config-file values. The
`scope` and `updateSetId` a run targets come from the config file (or the
programmatic context), **not** from CLI flags.

### Diagnostics

`--timings` answers "which check is slow, and why": after the report it
prints one table per instance to stderr — wall-clock milliseconds, HTTP
requests sent, `429` retries and read-cache hits per check, plus a total row.
With `--format json` the same numbers go into each run's `timings` object
instead, and stderr stays quiet.

`--trace <path>` (or `SNPF_TRACE`) writes one JSON event per line:

| Event         | Fields                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `run.start`   | `ts`, `version`, `instanceHost`, `checks`, `concurrency`                                                                     |
| `check.start` | `ts`, `check`                                                                                                                |
| `http`        | `ts`, `check`, `method`, `table` or `path`, `status`, `ms`, `attempt`, `retryAfterMs`, `cache` (`hit`/`miss`/`off`), `error` |
| `check.end`   | `ts`, `check`, `status`, `ms`                                                                                                |
| `run.end`     | `ts`, `ms`, `summary`                                                                                                        |

The trace is allowlisted field by field: it never holds query values, row
data, headers, credentials or user names. A non-table path keeps its fixed
segments only — a sys_id becomes `:id`, anything else variable `:value`. The
file is created with mode `0600` (an existing file is narrowed to it) and
never leaves the machine. With several instances, one file holds every run.

Library callers get the same events from `node:diagnostics_channel`
(`TRACE_CHANNELS`), or use `createTracer(write)` and `collectTimings()`
(all from `servicenow-preflight/report`)
around `runPreflight`. With no subscriber, nothing is built.

### Record and replay

`--record <dir>` runs against the instance as usual and also writes each
REST response into `<dir>` (one JSON file per distinct request, plus an
`index.json`). `--replay <dir>` later runs the same checks against that
directory alone: no network, no `SNPF_*` credentials and no instance URL.
Use it to reproduce a finding offline, to share a failing run in an issue,
or to run the checks in CI without instance access (see
[Credential-free CI](#credential-free-ci)).

```sh
npx servicenow-preflight run --instance https://dev1.service-now.com --record fixtures/dev
npx servicenow-preflight run --replay fixtures/dev --format json
```

A recording is redacted as it is written:

- a Table API row keeps only the fields the request asked for;
- values under secret-looking names (`password`, `token`, `secret`,
  `api_key`, …), and a `value` next to such a `name`, become `<redacted>`;
- tokens anywhere in text (JWTs, `Bearer`/`Basic` credentials, PEM private
  keys, cloud and GitHub keys) are cut out;
- the instance host becomes `instance.invalid`; `index.json` keeps only a
  hash of it;
- `sys_user` / `sys_user_group` names, user names and emails become stable
  pseudonyms (`user-0001`, `user-0001@example.invalid`) — `--record-raw`
  keeps them;
- only `content-type`, `x-total-count`, `link` and `retry-after` headers are
  kept; credentials and OAuth token traffic are never recorded.

Redaction is best effort: review a recording before you commit it. On the
first recording into a git work tree, the CLI warns when the directory is not
ignored and prints a `.gitignore` line for it.

Replay matches requests exactly (method, path, query and body). A request
the recording does not hold fails its check with
`No recorded response for GET /api/now/table/…; re-record with --record`,
so a check that changed what it reads fails closed rather than passing. The
report notes where it came from — a first line in `pretty` and `markdown`, a
`::notice::` in `github`, an XML comment in `junit` and a `replay` object
(`dir`, `recordedAt`) on each run in `json` and `sarif`. `--record` and
`--replay` take one instance, so they cannot be combined with each other or
with `--all`.

Library callers use `createReplayClient(dir)` (from
`servicenow-preflight/testing`) as `ctx.http`, with
`ctx.replay` from `readRecording(dir)` so the credential-gated checks run.

## Credentials & auth

Credentials are read from the **environment only** — never from the config file,
never logged, never placed into an error message. The tool covers the full range
of ServiceNow inbound-auth methods, plus transport-level mutual TLS:

| Method                     | `kind`           | Environment inputs                                          | Applied as                    |
| -------------------------- | ---------------- | ----------------------------------------------------------- | ----------------------------- |
| Basic                      | `basic`          | `SNPF_USER` + `SNPF_PASS`                                   | `Authorization: Basic …`      |
| Basic + MFA one-time code  | `basic`          | the above + `SNPF_MFA_TOTP_SECRET` (or `SNPF_MFA_CODE`)     | code appended to the password |
| Static bearer              | `oauth`          | `SNPF_TOKEN`                                                | `Authorization: Bearer …`     |
| API key                    | `apikey`         | `SNPF_API_KEY`                                              | `x-sn-apikey: …` (Tokyo+)     |
| OAuth — password grant     | `oauth-password` | client id/secret + `SNPF_USER` / `SNPF_PASS`                | `Bearer` (acquired at run)    |
| OAuth — client credentials | `oauth-client`   | client id/secret                                            | `Bearer` (acquired at run)    |
| OAuth — refresh token      | `oauth-refresh`  | client id/secret + `SNPF_OAUTH_REFRESH_TOKEN`               | `Bearer` (acquired at run)    |
| OAuth — JWT bearer         | `oauth-jwt`      | client id + signing key / assertion                         | `Bearer` (RS256, acquired)    |
| Mutual TLS                 | _(separate)_     | `SNPF_MTLS_CERT` + `SNPF_MTLS_KEY` (+ `_CA`, `_PASSPHRASE`) | client cert on the TLS socket |

For the four **grant flows** the token is minted at run time (POST to
`${instance}/oauth_token.do`, override with `SNPF_OAUTH_TOKEN_URL`), cached until
just before expiry, and re-acquired once on a 401. JWT assertions are signed
**RS256** with `node:crypto`. **Mutual TLS is a transport concern**: a client
cert composes with _any_ header method above, or stands alone (cert-only).

**MFA for basic auth** (experimental). When the instance enforces MFA on
basic-auth API calls, set `SNPF_MFA_TOTP_SECRET` to the account's base32 TOTP
seed: every request then carries the current RFC 6238 code (SHA-1, 6 digits,
30 s; override with `SNPF_MFA_TOTP_DIGITS` / `SNPF_MFA_TOTP_PERIOD`). A code
rejected with a 401 is retried once with the next window's code. For a manual
run, `SNPF_MFA_CODE` passes a one-off code instead. The code is appended to the
password, the widely reported mechanism; ServiceNow does not document the wire
format, so treat this as unverified until it passes on your instance. Like every
credential, the seed is read from the environment only; an MFA key in the
config file is refused.

> **A note on token lifetimes.** A static `SNPF_TOKEN` bearer is convenient, but
> on a real instance it is usually an OAuth **access token** carrying the
> platform-default **1800-second (30-minute) TTL** — so in a CI pipeline it is
> reliably _expired_ by the time the job runs. For anything unattended, prefer a
> **grant flow** (which mints a fresh token each run) or an **API key**
> (`SNPF_API_KEY`), which is not on that 30-minute cadence. Note too that
> `oauth-client` (the client-credentials grant) is **Vancouver+ only** and
> requires the OAuth registry record (`oauth_entity`) to be bound to an
> integration user — without that binding the grant returns no token.

Beyond the matrix inputs: `SNPF_INSTANCE`, `SNPF_UPDATE_SET`, `SNPF_PROXY` and
`SNPF_NO_PROXY` supply `instanceUrl`, `updateSetId`, `proxy` and `noProxy`
(precedence below); `SNPF_AUTH` forces a method; JWT
claims come from `SNPF_OAUTH_JWT_KID`
/ `_SUB` / `_AUD` / `_ISS` (or supply a pre-signed `_ASSERTION`). Any PEM / key /
assertion variable accepts an **`@path` value** (read from that file, e.g.
`SNPF_MTLS_KEY=@./certs/client.key`); a missing `@`-file is a hard error reported
with the path only, never contents.

**Config precedence** for `instanceUrl`, `updateSetId`, `proxy` and `noProxy`,
highest first:

| 1.x default (`SNPF_PRECEDENCE` unset or `file`) | Opt-in / 2.0 default (`SNPF_PRECEDENCE=env`) |
| ----------------------------------------------- | -------------------------------------------- |
| CLI flag (`--instance`) or registry instance    | CLI flag (`--instance`) or registry instance |
| config file                                     | `SNPF_<PREFIX>_X` (registry `envPrefix`)     |
| `SNPF_<PREFIX>_X` (registry `envPrefix`)        | `SNPF_X`                                     |
| `SNPF_X`                                        | config file                                  |

In 1.x, when a field is set in both the file and the environment with different
values and `SNPF_PRECEDENCE` is unset, the CLI prints one stderr warning per key
(`SNPF_INSTANCE (env) differs from instanceUrl in preflight.config.json; the file
wins in 1.x, env will win in 2.0. …`). The warning names keys only, never values.
Set `SNPF_PRECEDENCE=env` to adopt the 2.0 order now, or `SNPF_PRECEDENCE=file`
to keep the file and silence the warning.

### Troubleshooting 401 / 403

A refused request is explained, not just reported. The `connectivity-auth` row
and a `sync`/`drift` error both list the likely causes for the auth method in
use, most likely first — built only from the status, the method's kind, the
instance's own error text and the request path, never from a credential:

```text
ServiceNow authentication failed (401): User is not authenticated.
  Possible causes:
  - Wrong user name or password, or the account is locked or inactive.
  - The instance may restrict basic auth for API calls: …
  - Prefer OAuth (SNPF_AUTH=oauth-client and SNPF_OAUTH_CLIENT_ID/SECRET) or mutual TLS for CI accounts.
```

| Symptom                       | Usual cause                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `401` with basic auth         | wrong password, locked/inactive user, MFA on the account, or a basic-auth restriction policy |
| `401` with `SNPF_TOKEN`       | the static bearer expired (see the token-lifetime note above) — use a grant flow             |
| `401` from `/oauth_token.do`  | OAuth application registry entry: client id/secret, allowed grant type, JWT verifier         |
| `403` on `/api/now/table/<t>` | the account authenticates but lacks read access to `<t>` (ACL or role)                       |

For the instance-side settings (OAuth application registry, inbound REST
authentication policies, ACLs), see the ServiceNow product documentation for
your release.

### Readiness check: `doctor`

```bash
npx servicenow-preflight doctor -i https://dev12345.service-now.com
npx servicenow-preflight doctor dev --json   # a registry instance
```

`doctor` answers "can this account run the gate here?" before the first real
run. It only reads (Table API `GET`s limited to one row, and one `GET` on the
CI/CD API) and prints one row per question:

| Row                   | What it checks                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `doctor-config`       | where the instance URL (flag, registry, config file or `SNPF_INSTANCE`), the config file and the credentials come from — fails with no URL |
| `doctor-reachability` | the host (or the proxy host) resolves; proxy settings parse; warns on plain `http://`                                                      |
| `connectivity-auth`   | the credentials authenticate (the same row `run` has)                                                                                      |
| `doctor-basic-auth`   | the instance's basic-auth API restriction (`glide.authenticate.basic_auth.restriction.*`) and whether this account stays allowed under it  |
| `doctor-account`      | the account has `snc_basic_auth_api_access` or is Web Service Access Only                                                                  |
| `doctor-table-access` | the account reads every table the selected checks query (`--only` / `--skip` / config `select`); a `403` names the checks it affects       |
| `doctor-cicd`         | the CI/CD API answers, only when `atf-run` is selected                                                                                     |
| `doctor-runtime`      | Node.js and servicenow-preflight versions                                                                                                  |

Every warning carries the fix. A property or role table the account cannot
read is a warning ("ask an admin to confirm"), never a failure. `doctor` exits
`0` when every row passes or warns and `1` when one fails; `--format` works as
for `run`. The basic-auth property names and the `sys_user_has_role` read are
not yet confirmed on a live instance.

### HTTP(S) proxy

Outbound requests can be routed through a forward proxy via standard `CONNECT`
tunneling — still zero runtime dependencies. Precedence, first match wins: the
config file's `proxy` → `SNPF_PROXY` → `HTTPS_PROXY` → `https_proxy`. Only
`https:` targets are ever proxied (every ServiceNow instance is `https`), so
`HTTP_PROXY` is deliberately ignored. Both `http://` and `https://` proxy URLs
work (the latter speaks TLS to the proxy itself, then TLS to the instance
through it), proxy credentials go in the URL userinfo
(`http://user:pass@proxy:3128`, always redacted from errors and logs), and
mutual TLS composes through the tunnel. TLS verification of the instance is
never weakened by proxying.

Bypass hosts with `NO_PROXY`-style lists — the union of the config file's
`noProxy`, `SNPF_NO_PROXY`, and `NO_PROXY`/`no_proxy` applies: comma-separated
entries, each a hostname, a domain suffix, a `host:port`, a bracketed IPv6
literal, or `*` (bypass everything).

**Detection precedence** (with `SNPF_AUTH` unset, first match wins): OAuth client
id + secret (→ `oauth-refresh` if a refresh token is present, else `oauth-jwt` if
a JWT key/assertion is, else `oauth-password` if user + pass are, else
`oauth-client`) → `SNPF_TOKEN` → `SNPF_API_KEY` → `SNPF_USER` + `SNPF_PASS` → no
header auth. Mutual TLS (`SNPF_MTLS_*`) resolves **independently** and attaches on
top of whatever is selected. A `.env` file in the working directory is loaded
automatically, but **real environment variables always win** over it. Its
values are read into a private copy and are never exported into
`process.env`. With no
credentials at all, `connectivity-auth` reports `warn` (not `fail`) and
network-dependent checks degrade to advisory warnings.

## Configuration file

The CLI auto-discovers the first of `preflight.config.json`, `.js`, or `.mjs` in
the working directory (or point at one with `--config <path>`); JS/MJS forms may
export as `default` or a named `config`. The file declares the target, which
checks to run, and per-check options — but **never credentials**.

```json
{
  "instanceUrl": "https://dev12345.service-now.com",
  "scope": "x_acme_app",
  "updateSetId": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "select": { "skip": ["atf-run"] },
  "options": {
    "languages": ["de", "fr"],
    "baseLanguage": "en",
    "requiredApps": [{ "id": "x_acme_lib", "minVersion": "2.1.0" }],
    "atfSuites": ["<suite_sys_id>"]
  }
}
```

| Field         | Type                                     | Used by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instanceUrl` | `string`                                 | Target instance (CLI `--instance` overrides).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `scope`       | `string`                                 | `default-set-leakage`, `i18n-completeness`, `acl-role-sanity`, and the twenty-one certification checks (`client-callable-acl`, `rest-endpoint-security`, `script-field-exposure`, `scheduled-job-run-as`, `mobile-menu-hygiene`, `table-crud-acl`, `ui-page-acl`, `ui-action-gating`, `table-namespace`, `portal-roles`, `acl-out-of-scope`, `module-roles`, `script-hygiene`, `hardcoded-identifiers`, `client-script-safety`, `property-privacy`, `inactive-artifacts`, `notification-conditions`, `log-leftovers`, `deprecated-apis`, `cors-rules`). |
| `updateSetId` | `string` (sys_id)                        | `update-set-state`; also focuses `remote-set-preview` on that set's retrieved copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `select`      | `{ only?: string[]; skip?: string[] }`   | Check selection (CLI flags override).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `options`     | `object`                                 | Per-check options (`atfSuites`, `requiredApps`, `languages`, `baseLanguage`, …).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `checks`      | `{ [check]: object }`                    | Options for one check only, shallow-merged over `options` for that check (e.g. `{ "i18n-completeness": { "languages": ["fr"] } }`); an unknown check name is a usage error (exit 2).                                                                                                                                                                                                                                                                                                                                                                    |
| `baseline`    | `string \| boolean`                      | Apply a baseline file: `true` = the default path, a string = that file (CLI `--baseline` overrides).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `severity`    | `{ [check]: "fail" \| "warn" \| "off" }` | Severity policy (see [below](#severity-policy)); CLI `--severity` overrides per check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `failOn`      | `"fail" \| "warn"`                       | Run-level exit threshold (see [below](#strict-runs---fail-on-warn)); `--fail-on` and `SNPF_FAIL_ON` override it.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `proxy`       | `string`                                 | Forward proxy URL; outranks `SNPF_PROXY` and `HTTPS_PROXY` (see [HTTP(S) proxy](#https-proxy)). Keep credentials in `SNPF_PROXY`, not in this file.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `noProxy`     | `string`                                 | Extra proxy-bypass entries, merged with `SNPF_NO_PROXY` and `NO_PROXY`/`no_proxy`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Validating the config

Every check that reads options declares their shape, and the CLI derives a
JSON Schema (draft 2020-12) for the whole config file from them. Point
`$schema` at it for editor completion and inline errors:

```json
{
  "$schema": "./node_modules/servicenow-preflight/schemas/preflight.config.v1.json",
  "instanceUrl": "https://dev12345.service-now.com",
  "checks": {
    "scoped-app-deps": {
      "requiredApps": [{ "id": "x_acme_lib", "minVersion": "2.1.0" }]
    },
    "i18n-completeness": { "languages": ["de", "fr"] }
  }
}
```

The schema is shipped in the package (`servicenow-preflight/schemas/preflight.config.v1.json`)
and published on the docs site under its `$id`. A check's block under `checks`
accepts only the options that check declares; checks that take no options
accept any keys.

- `snpf config schema` prints the schema (`--out <file>` writes it instead).
- `snpf config validate` checks the discovered (or `--config`) file and lists
  every problem with its path and a did-you-mean hint, for example
  `options.langauges: unknown key (did you mean languages?)`. Exit `0` when
  valid, `2` otherwise. It also applies the load-time guards (such as safe
  `scope` names) without reading the environment or `.env`.
- `snpf config migrate` shows, as a unified diff, the config with each shared
  `options` key moved into the `checks` block of every check that declares it
  (an existing per-check value wins). `--write` rewrites the file atomically.
  JSON configs only.

A normal `run` does not fail on these problems in 1.x: it prints each one to
stderr once as `servicenow-preflight: config warning: …` and carries on.

### Severity policy

Teams disagree with the defaults: a Store-bound app may want the advisory
`scheduled-job-run-as` to **fail**, an internal app may want `table-namespace`
to only **warn**. The `severity` key overrides how a check's non-pass result is
reported, without skipping the check:

```json
{
  "severity": {
    "scheduled-job-run-as": "fail",
    "table-namespace": "warn",
    "mobile-menu-hygiene": "off"
  }
}
```

- `"fail"` / `"warn"` — a non-pass result of that check is reported with that
  status; a rewritten row's message ends in `[severity: fail by policy]` (or
  `warn`). `pass` results are never changed.
- `"off"` — the check is skipped, exactly like `select.skip` (so a run that
  ends up verifying nothing still fails).
- A name that is not a known check is a usage error (exit 2) listing it, raised
  before any network call. A check excluded by `--only` still counts as known.
- `--severity <check>=<level>` on the command line (repeatable) wins over the
  config entry for the same check, e.g.
  `snpf run --severity table-namespace=fail`.
- The policy is applied before the [baseline](#baseline-accepted-findings):
  the policy states intent, the baseline accepts the resulting state.

### Strict runs (`--fail-on warn`)

A release branch may want advisory findings to block too, without rewriting
the severity of every check. `--fail-on warn` (or `SNPF_FAIL_ON=warn`, or
`"failOn": "warn"` in the config file) makes the run exit `1` when any row is
`warn` or `fail`:

- The rows keep their statuses; only the report's `ok` and the exit code
  change. A stderr line says why a run without a `fail` row failed, and the
  JSON envelope carries `"failOn": "warn"`.
- Rows a [baseline](#baseline-accepted-findings) accepted (`Baselined …`) and
  expired-entry notices do not count.
- Unlike `severity`, which rewrites individual rows, this is one run-level
  gate. The flag wins over the env variable, which wins over the config key.

### Baseline (accepted findings)

A brownfield app is often red on the first run. Instead of skipping whole
checks, record today's findings once and accept them:

```bash
snpf run --write-baseline        # writes .preflight/baseline.json (refuses to overwrite without --force)
snpf run --baseline              # applies it on every later run
```

Commit `.preflight/baseline.json` and fill in `reason` (and optionally
`expires`) for each entry:

```json
{
  "version": 1,
  "generatedAt": "2026-10-22T10:00:00Z",
  "entries": [
    {
      "check": "table-crud-acl",
      "status": "fail",
      "message": "2 custom table(s) lack CRUD ACLs: x_acme_app_a, x_acme_app_b",
      "reason": "legacy tables, ticket ACME-123",
      "expires": "2027-01-31"
    }
  ]
}
```

- An entry matches a result by check name **and** status. A matched `fail`
  becomes a `warn` (a matched `warn` stays one), prefixed
  `Baselined (<reason> until <expires>): …`, so the run passes while any new
  failure still fails it.
- **Change detection is by message.** Results are one row per check, so when a
  baselined check's message differs from the recorded one (for example a new
  table joined the list), the row is still demoted but reads
  `Baselined but CHANGED since <generatedAt>: …`. Review those rows: this is the
  only signal that a baseline is hiding a new finding. Re-record with
  `--write-baseline --force` once the change is understood.
- An entry past its `expires` date (a date-only value lasts through that day,
  UTC) is ignored — the finding fails again — and a `baseline` warning row
  names it. Entries for checks that did not run are ignored.
- A registry instance (`snpf run dev`, `--all`) uses
  `.preflight/baseline.<env>.json` when present, else the shared file;
  `--write-baseline` writes the per-instance file. An explicit path applies to
  every instance (`--write-baseline <path>` is refused with `--all`).
- A missing or malformed baseline file is a usage error (exit 2). `--baseline`
  and `--write-baseline` cannot be combined. The optional path is the next
  token unless it starts with `-`; use `--baseline=<path>` before a positional
  instance name.

## Multi-instance: registry, sync & drift

A single `--instance` URL is fine for a one-off check. Real deployments move a
change through a pipeline — `dev → staging → test → prod` — and what you want to
guarantee is that a promote never drops validated coverage. That is what the
**registry**, `sync` and `drift` add on top of the single-instance `run`. It is
**opt-in**: with no `.preflight/instances.json`, the tool behaves as before.

The **registry** (`.preflight/instances.json`) is a committed description of the
instances a project targets and the order they promote in — it holds **no
credentials**. Each instance needs a `url`; `promotesTo` chains the pipeline (or
`null` for the terminal stage) and is enforced by `drift`; the optional `scope`,
`stage` and `envPrefix` refine per-instance behaviour. A `promotesTo` that names
an undeclared instance, the instance itself, or closes a cycle is rejected when
the registry loads (exit `2`). Only the default location may be absent: an
explicit `--registry <path>` that does not exist, is empty, or is not a regular
file (a directory, say) is a usage error (exit `2`) for `run`, `sync` and
`drift` — a directory used to fail with a raw `EISDIR` read error (exit `1`).

```json
{
  "version": 1,
  "scope": "x_acme_app",
  "instances": {
    "dev": {
      "url": "https://dev12345.service-now.com",
      "promotesTo": "staging"
    },
    "staging": {
      "url": "https://acmestaging.service-now.com",
      "promotesTo": "prod"
    },
    "prod": {
      "url": "https://acme.service-now.com",
      "promotesTo": null,
      "envPrefix": "PROD"
    }
  }
}
```

**Per-instance credentials** resolve from the environment exactly as above,
except each instance looks up a **namespaced** variable first: an instance whose
`envPrefix` is `PROD` reads `SNPF_PROD_*` before falling back to the unprefixed
`SNPF_*`. `envPrefix` defaults to the instance name upper-cased (`dev` →
`SNPF_DEV_*`). Every method and every `SNPF_*` variable works this way.

- **`run <env>`** (or `--all`) runs the full suite against a named instance,
  resolving its `url`/`scope`/`envPrefix` from the registry and loading a
  committed manifest, if present. With `--all`, `pretty` tags each instance block
  (`== staging ==`) and the run exits `1` if any instance has a failing check.
- **`sync <env>`** pulls the instance's ATF tests and suites — strictly
  **read-only** Table API reads — into a committed **state manifest** at
  `.preflight/state/<env>.state.json`. Each entry gets a **logical `id`**
  (`scope/slug`) stable across instances, so a re-sync yields a minimal, reviewable
  diff. `--with-last-run` also records each test's most recent result. The
  manifest also captures the instance's **platform identity**
  (`glide.buildname` / `glide.war`) and its **installed apps and plugins** with
  versions, feeding the parity gates below. Manifests carry `"version": 1`;
  one without a version reads as 1, and a newer version is refused (exit `2`)
  with a hint to upgrade the tool. A malformed manifest also exits `2`.
- **`drift <src> <dst>`** compares two committed manifests **offline** by logical
  `id`. A test **active upstream but missing downstream** fails the gate (exit 1)
  — it would ship a promote without coverage upstream has validated. Extra tests
  downstream `warn`; a fully-covered target `pass`es. Only _active_ source tests
  can block. Two **version-parity** results ride along: `instance-version-parity`
  fails on a release-family mismatch (`glide.buildname`) and warns on patch-level
  skew (`glide.war`); `app-version-parity` fails when an app or plugin installed
  on the source is missing or older on the target. Manifests written by older
  versions of the tool (no identity/app data) degrade to an advisory `warn`,
  never a crash. A **`promotion-order`** result checks the pair against the
  registry's `promotesTo` chain: the declared next stage `pass`es; a target
  further down that **skips a stage** fails (a `warn` under
  `--allow-stage-skip`, for a deliberate hotfix); a target **upstream** of the
  source or on **no shared chain** always fails. With no registry, an
  undeclared instance, or no `promotesTo` anywhere, it is an advisory `warn`.

```bash
snpf sync staging                 # commit the two manifests, then gate the promote
snpf sync prod
snpf drift staging prod           # exit 1 if staging has active tests prod lacks
snpf run prod                     # only if the gate passes
```

## Report formats

Selected with `--format` (or `--json`):

- **`pretty`** _(default)_ — human-readable lines (`✓ / ! / ✗`) plus a summary.
- **`json`** — a versioned envelope, the same shape for single-instance and
  `--all` runs (see [JSON output](#json-output)).
- **`junit`** — a JUnit XML document with **one `<testcase>` per check**: `fail`
  → `<failure>`, `warn` → a passing case with a `<system-out>` note, `pass` → an
  empty passing case. XML-1.0-illegal control characters are stripped and the five
  entities escaped, so arbitrary ATF output can't break the document.
- **`sarif`** — a SARIF 2.1.0 log with **one result per non-`pass` check** (`fail`
  → `error`, `warn` → `warning`) for code-scanning dashboards.
- **`markdown`** — a GitHub-flavoured Markdown block for a pull-request comment:
  a `###` heading with the instance and verdict, the bold summary, and a table
  ordered fail → warn → pass (more than five pass rows fold into `<details>`).
  Cell text is escaped (`|`, newlines, `<`/`>`, backticks), so a message cannot
  break the table. Fail and warn rows also carry the check's remediation hint on
  a second line (`<br><sub>Fix: …</sub>`); pass rows do not. With `--all`, a one-line roll-up (`**dev** ✅ · **prod** ❌`)
  leads one block per instance.
- **`github`** — GitHub Actions workflow commands: one `::error` (fail) or
  `::warning` (warn) line per non-`pass` check, titled with the check (and the
  instance under `--all`), then the plain summary line. Inside a GitHub job they
  become annotations on the run and the PR's Checks tab with no upload step;
  anywhere else the raw command lines are printed.

```bash
snpf --format junit > preflight-junit.xml
snpf --format sarif > preflight.sarif
snpf --json | jq '.runs[0].report.summary'
snpf --format markdown > preflight.md
gh pr comment "$PR_NUMBER" --body-file preflight.md
```

### JSON output

`--format json` prints one envelope (plus a trailing newline):

```json
{
  "schemaVersion": 1,
  "tool": { "name": "servicenow-preflight", "version": "0.5.0" },
  "generatedAt": "2026-10-24T08:00:00.000Z",
  "ok": false,
  "runs": [
    {
      "instance": "dev",
      "url": "https://dev12345.service-now.com",
      "report": { "ok": false, "results": [], "summary": {} }
    }
  ]
}
```

`ok` is `true` only when every run is ok. Each run's `report` is the full
`PreflightReport` (`ok`, `results[]` with any `findings`, `summary`). `instance`
is the registry name and is left out for an ad-hoc `--instance` run; `url` is
the instance origin only, so credentials and paths never appear. `--timings`
adds a `timings` object to each run. `drift`
prints the same envelope with one run. `schemaVersion` changes only on a
breaking shape change.

The JSON Schema (draft 2020-12) ships in the package as
`servicenow-preflight/schemas/report.v1.json` (and `finding.v1.json` for a
single `Finding`) and is published at
<https://ivanbbaev.github.io/servicenow-preflight/schemas/report.v1.json>. It is
generated from the TypeScript types (`npm run gen:schema`), and `npm run check`
fails when the committed copy is stale. The library builds the same envelope
with `toEnvelope(runs, { version })` and `formatJson(envelope)`.

## CI integration

`servicenow-preflight` exits non-zero on failure, so a single step gates a
pipeline. Exit `1` means a check blocked the release; exit `3` means the tool
could not run (network, instance outage, unreadable file) — a pipeline can retry
on `3` and treat only `1` as a blocked change.

### GitHub Action

The repo is also a composite action. One step installs the CLI, runs the
checks, uploads SARIF to code scanning and writes the step summary:

```yaml
name: ServiceNow preflight
on: [workflow_dispatch, pull_request]

jobs:
  preflight:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write # to upload SARIF
    steps:
      - uses: actions/checkout@v5
      - id: preflight
        uses: IvanBBaev/servicenow-preflight@vX.Y.Z # pin a release tag or SHA
        env:
          SNPF_INSTANCE: ${{ secrets.SNPF_INSTANCE }}
          SNPF_USER: ${{ secrets.SNPF_USER }}
          SNPF_PASS: ${{ secrets.SNPF_PASS }}
        with:
          fail-on: warn
      - if: always()
        run: echo "pass=${{ steps.preflight.outputs.pass }} fail=${{ steps.preflight.outputs.fail }}"
```

The action needs a release that ships it (the first release after 0.5.0);
by default it runs the CLI version matching its own `vX.Y.Z` tag, else
`latest`. Credentials are never inputs — pass them through `env:`.

| Input               | Default                | Meaning                                                 |
| ------------------- | ---------------------- | ------------------------------------------------------- |
| `version`           | the action's tag       | npm version / tag, or a local package path              |
| `args`              | `run`                  | subcommand and extra flags, split on spaces             |
| `instance`          |                        | registry instance (`--env`)                             |
| `config`            |                        | config file (`--config`)                                |
| `only` / `skip`     |                        | comma-separated check names                             |
| `fail-on`           | `fail`                 | exit threshold: `fail` or `warn`                        |
| `sarif`             | `true`                 | upload SARIF (needs `security-events: write`)           |
| `sarif-category`    | `servicenow-preflight` | code scanning category                                  |
| `summary`           | `true`                 | write the Markdown report to the step summary           |
| `replay`            |                        | recording directory (`--replay`); no credentials needed |
| `node-version`      | `22`                   | Node.js to set up                                       |
| `working-directory` | `.`                    | directory to run in                                     |

Outputs: `ok`, `pass`, `warn`, `fail` (summed over every instance),
`sarif-file` and `report-json` (paths under `runner.temp`), and `exit-code`
(`1` a check failed, `3` the tool could not run). On pull requests
from forks set `sarif: false` — the token cannot upload there. The repo's own
`action-selftest` workflow runs the action against the committed
`test/fixtures/replay-sample` recording with no secrets.

### GitLab CI and Azure Pipelines

Ready-made templates live in [`ci/`](ci/). GitLab — include the job and set
the `SNPF_*` variables as masked CI/CD variables:

```yaml
include:
  - remote: https://raw.githubusercontent.com/IvanBBaev/servicenow-preflight/vX.Y.Z/ci/gitlab/servicenow-preflight.gitlab-ci.yml

servicenow-preflight:
  variables:
    SNPF_ARGS: run --fail-on warn
```

It publishes a JUnit report plus JSON and Markdown artifacts. Azure Pipelines
— copy [`ci/azure/servicenow-preflight.yml`](ci/azure/servicenow-preflight.yml)
into your repo and use it as a step template; it maps the secret variables
`SNPF_INSTANCE`, `SNPF_USER` and `SNPF_PASS`, publishes JUnit test results and
a JSON artifact:

```yaml
steps:
  - template: ci/azure/servicenow-preflight.yml
    parameters:
      args: run --baseline
```

### Plain `npx`

For annotations without any upload step, use `--format github` instead — each
failing or warning check shows up on the run summary and the PR's Checks tab:

```yaml
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx servicenow-preflight --format github
        env:
          SNPF_INSTANCE: ${{ secrets.SNPF_INSTANCE }}
          SNPF_USER: ${{ secrets.SNPF_USER }}
          SNPF_PASS: ${{ secrets.SNPF_PASS }}
```

Store credentials as CI secrets — the tool only ever reads them from the
environment.

### Several formats in one run, step summary and outputs

`--output <format>=<path>` writes an extra copy of the report (repeatable), so
one run can print annotations and still leave SARIF and JUnit files for upload
steps. Each file is written atomically and its folders are created.

Inside GitHub Actions the run also appends the markdown report to the job's
step summary (`GITHUB_STEP_SUMMARY`; turn it off with `--no-summary` or
`SNPF_SUMMARY=0`) and writes `ok`, `pass`, `warn` and `fail` to the step
outputs (`GITHUB_OUTPUT`), summed over every instance:

```yaml
- id: preflight
  run: >
    npx servicenow-preflight --format github
    --output sarif=reports/preflight.sarif
    --output junit=reports/junit.xml
- if: always() && steps.preflight.outputs.warn != '0'
  run: echo "Preflight warned ${{ steps.preflight.outputs.warn }} time(s)"
```

### Credential-free CI

A reviewed recording committed to the repo lets pull-request CI run every
check with no instance secrets at all — useful for forks and for testing your
own policy, baseline and report wiring:

```yaml
- run: npx servicenow-preflight run --replay fixtures/dev --format github
```

Refresh the recording (`--record`) from a job or machine that does have
credentials when the instance or the checks change.

## Library API

The package root ([src/index.ts](src/index.ts)) is a curated core: `runPreflight`,
`selectChecks`, `defaultChecks`, `createSnClient` / `withSignal` and the
`SnError` family, `makeFinding` / `findingId`, `loadConfig` / `UsageError`,
`describeChecks` / `findCheck`, and the types a check or a caller needs
(`Check`, `CheckResult`, `PreflightContext`, `PreflightReport`, `SnClient`, …).
Everything else is on a subpath ([src/api/](src/api/)):

| Import from                     | What                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `servicenow-preflight/checks`   | Every bundled check, the registry, findings helpers (`MAX_FINDINGS`, `capFindings`), the catalogue, `doctorChecks`, severity policy, incremental selection (`planIncremental`, …). |
| `servicenow-preflight/http`     | The client, its errors and types, encoded-query helpers (`eq`, `inClause`, `resolveScope`, …), `resolveAuthFromEnv` / `resolveTlsFromEnv`.                                         |
| `servicenow-preflight/report`   | `toEnvelope` / `formatJson`, JUnit, SARIF, Markdown, GitHub annotations, the baseline, tracing and timings.                                                                        |
| `servicenow-preflight/state`    | Instance registry, state manifests, `syncManifest`, drift and promotion checks.                                                                                                    |
| `servicenow-preflight/testing`  | `createFakeSnClient`, `createReplayClient`, `readRecording`.                                                                                                                       |
| `servicenow-preflight/internal` | Helpers shared by the CLI and the checks. **No semver promise.**                                                                                                                   |

The list of every export per entry point is pinned in
[test/fixtures/public-api.txt](test/fixtures/public-api.txt).

```ts
import { runPreflight, createSnClient } from "servicenow-preflight";

const http = createSnClient({
  instanceUrl: "https://dev12345.service-now.com",
  auth: {
    kind: "basic",
    user: process.env.SNPF_USER!,
    pass: process.env.SNPF_PASS!,
  },
});

const report = await runPreflight({
  instanceUrl: "https://dev12345.service-now.com",
  http,
  scope: "x_acme_app",
  updateSetId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  options: { languages: ["de", "fr"], baseLanguage: "en" },
});

console.log(report.ok, report.summary); // e.g. false { pass: 2, warn: 4, fail: 1 }
```

- **`runPreflight(ctx, checks?, opts?)`** → `Promise<PreflightReport>`. Defaults
  to `defaultChecks`; `ctx.select` (only / skip by name) filters before they run.
  `opts` (`RunPreflightOptions`) takes `signal` (an `AbortSignal` that cancels
  the run), `timeoutMs` (per check), `runTimeoutMs` (whole run) and
  `concurrency` (checks at once, 1–32, default `1`; checks with
  `meta.serial` run alone after the others, and results keep registry order).
  A budget that is not a positive finite number, or a concurrency out of
  range, throws `RangeError`. Every check gets
  its own `ctx.signal`, aborted when it times out or the run stops, and a
  `ctx.http` bound to that signal, so a check that only uses `ctx.http` is
  cancelled with no extra code; pass `ctx.signal` on to any other async work.
  A cut-short check and every check not yet started become `fail` rows.
- **`withSignal(client, signal)`** → an `SnClient` that passes `signal` (merged
  with any per-call one) to every call. `table().get/query/queryWithMeta`,
  `cicd.runTestSuite` and `request` all accept `{ signal }` (`SnCallOptions`);
  an abort rejects with `SnNetworkError` ("… was aborted", `cause` set to the
  abort reason), including during a `Retry-After` wait or a CI/CD poll.
- **`selectChecks`**, **`defaultChecks`**, and each individual check
  (`instanceUrlConfigured`, `connectivityAuth`, …) are exported to compose your
  own list.
- **`createSnClient(config)`** → `SnClient` (`{ instanceUrl, auth?, tls?,
timeoutMs?, cicdPollIntervalMs?, cicdMaxPolls?, maxRows?, proxy?, noProxy?,
maxInFlight?, rps?, cache? }`),
  backed by Node's global `fetch` (or `node:https` when `tls` is set).
  `table(name).query()` **auto-paginates** unless you pass a `sysparm_limit`, and
  throws `SnTruncationError` past `maxRows` (default 100000) rather than
  truncating. `proxy` outranks the `SNPF_PROXY` and `HTTPS_PROXY` / `https_proxy`
  environment variables (`HTTP_PROXY` is never used); `noProxy` is merged with
  `SNPF_NO_PROXY` and `NO_PROXY` / `no_proxy`.
  `maxInFlight` (1–64) and `rps` (0.5–100) are unset by default, so a library
  client is unlimited unless you opt in; out-of-range values throw `SnError`.
  `loadConfig` returns them from the environment as `limits`. `cache: true`
  shares identical `query` / `queryWithMeta` reads for the client's lifetime
  (default `false`; the CLI turns it on per run). Cached rows are frozen.
- **`formatJUnit`** / **`formatSarif`**, and **`loadConfig`** /
  **`resolveAuthFromEnv`** / **`resolveTlsFromEnv`** (the CLI's own resolution).
  `loadConfig(cwd, { env, dotenv })` resolves from `env` (default
  `process.env`) plus `.env` (`dotenv`, default `true`) without writing to
  either, so several instances can be loaded in one process. It returns the
  merged `env`; pass it to `createSnClient({ env })` so `HTTPS_PROXY` /
  `NO_PROXY` from `.env` apply. `skipDotEnv` is a deprecated alias of
  `dotenv: false`. `precedence: "env" | "file"` overrides `SNPF_PRECEDENCE`,
  `onWarning(message)` receives the file-vs-env warnings (silent by default),
  and the returned `sources` names where each of those four fields came from
  (`"file"` or `"env"`).
- **`describeChecks(checks, defaults?)`** → `CheckDescriptor[]` (`name`,
  `description`, `meta`, `inDefaultSuite`), in the order given, and
  **`findCheck(name)`** (searches the default suite plus `test-drift`). Every
  bundled check declares an optional `meta` (`CheckMeta`): its certification
  `rule` id, `severity` (`"blocker"` or `"advisory"` — advisory checks never
  fail on a finding), the `tables` it reads, a `remediation` paragraph and the
  `verdicts` wording for pass / warn / fail. `formatSarif(report, checks?)`
  uses it to fill each SARIF rule's `shortDescription`, `fullDescription` and
  `properties`; a check without `meta` keeps working everywhere.

Checks _always_ call `ctx.http`, never `fetch` directly, so `createFakeSnClient`
(an in-memory `SnClient`, from `servicenow-preflight/testing`) unit-tests them with no network — seed table rows and
CI/CD responses, or force error surfaces with the `fail` fixture. Client helpers
throw a small typed hierarchy (all extend `SnError`) that checks map to results;
secrets never appear in the messages:

| Error               | Raised when                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `SnAuthError`       | HTTP 401 / 403, or missing credentials (`.status`).                                                       |
| `SnNetworkError`    | DNS / connection failure / timeout — instance unreachable.                                                |
| `SnHttpError`       | Any other non-2xx status (`.status`, `.body`).                                                            |
| `SnResponseError`   | A 2xx carrying a non-JSON body — a hibernating instance's wake-up page or an SSO/proxy interstitial.      |
| `SnTruncationError` | An auto-paginated `query()` hit `maxRows` (default 100000) — fails closed instead of silently truncating. |

To add your own check, implement the `Check` interface (a `run(ctx)` returning a
`CheckResult`, catching every `ctx.http` error) and pass a custom list to
`runPreflight`, or register it in `defaultChecks` under [src/checks/](src/checks/).

A `CheckResult` may also carry record-level **`findings`** (`Finding[]`): each
has a stable `id` (`"f1:"` + 16 hex, from **`findingId(check, kind, location)`**),
a check-local `kind`, a one-line `message`, an optional `status` and an optional
`location` (`table`, `sysId`, `recordName`, `field`, `line`, `logicalId`). The
id hashes the check, kind, table, sys_id, field and logical id only, so a moved
line, a renamed record or reworded message keeps the same id. Build them with
**`makeFinding`**; `runPreflight` validates what a check returns (malformed
entries are dropped, a bad `id` is recomputed) and caps the list at
`MAX_FINDINGS` (500), counting the overflow in `findingsTruncated`. `findings`
is optional and omitted when empty, and never changes the row's status.

A non-pass row without findings (a degraded read, a connectivity failure)
still stands for one finding: **`effectiveFindings(result)`** (from
`servicenow-preflight/checks`) returns the row's own findings, or for such a
row one implicit finding with kind `"row"` whose id depends only on the check
name, or none for a passing row. The drift gate emits findings too:
`test-drift` one per missing (`fail`) or extra (`warn`) test with
`logicalId: "<scope>/<slug>"`, `app-version-parity` one per downgraded,
missing or unverified app with `logicalId: "app:<scope>"`, and
`instance-version-parity` / `manifest-freshness` one `logicalId: "instance"`
finding per non-pass row.

Rows the tool synthesises carry a **`kind`**: `"runner"` on the `preflight`
guard rows (duplicate or reserved check names, an empty selection) and
`"baseline"` on expired-baseline notices. Check rows leave it out (meaning
`"check"`), and a `kind` a check sets itself is stripped. The names
`preflight`, `baseline` and any `preflight:` prefix are reserved: a check set
that uses one fails with a single `preflight` row. SARIF results carry the kind
in `properties.kind`.

## Tessera (preview): `tess` and `tessera-mcp`

The package also carries **Tessera**, a test framework for ServiceNow that runs
impact analysis and ATF tests as a gate. It is the product `servicenow-preflight`
grows into at **v1.0.0**. It is a **preview**: the full live pipeline has not yet
been verified end to end against a real instance, and its commands and flags may
still change before 1.0.

Nothing above changes. `servicenow-preflight` / `snpf`, the 30 checks and the
library API keep working as documented. Tessera adds two more binaries:

| Binary        | What it is                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `tess`        | The Tessera CLI (`tess <command> --help` for every command)                                    |
| `tessera-mcp` | A stdio MCP server exposing the same pipeline as 13 `preflight_*` tools (doctor, impact, run…) |

| Command                        | What it answers                                                                              | Writes                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `tess doctor`                  | Is this instance ready to run tests? Three states: ready / not ready / undecided.            | nothing                                               |
| `tess preflight`               | Is the topology ready, and does the runner carry the code the source has?                    | nothing unless `--mode apply`                         |
| `tess resolve`                 | Which artifacts does this story or scope change?                                             | nothing                                               |
| `tess impact`                  | What else does that change reach (where-used scan of one scope)?                             | nothing                                               |
| `tess coverage`                | Which impacted artifacts have a declared test spec, and which have none?                     | nothing                                               |
| `tess generate`                | Proposes specs for the gaps (offline template or the Anthropic API).                         | files under `<tests-root>/proposed/` only             |
| `tess review`                  | Records that a named reviewer read a promoted unit spec (SHA-256 of its body + reviewer id). | the local `.manifest.json` only                       |
| `tess run --live`              | Projects the repo's specs onto the runner as ATF tests, runs them, gives a verdict.          | the runner instance and the local run ledger          |
| `tess status` / `tess confirm` | Where is a run, and what did a finished run decide?                                          | nothing                                               |
| `tess cleanup`                 | Tears down a failed run's ATF projection.                                                    | nothing in `--mode plan` (the default)                |
| `tess benchmark`               | Scores a hand-authored mutant catalog against the S5 outcome gate on a sub-prod runner.      | the runner instance (it rewrites the scope's sources) |

Tessera separates three **roles**: `--source` (read artifacts from here),
`--runner` (the only instance a write may touch) and `--target` (probed
read-only). `--instance` sets all three to one profile. A role names a
credential profile: `default` reads `SN_INSTANCE` / `SN_USER` / `SN_PASSWORD`,
any other profile `SN_PROFILE_<NAME>_INSTANCE` / `_USER` / `_PASSWORD`. These
are not the `SNPF_*` variables the preflight checks use. The options of
`preflight`, `resolve`, `impact`, `coverage`, `generate` and `doctor` resolve as
flag > env > `tessera.config.json` > default; `run`, `review`, `status`,
`confirm`, `cleanup` and `benchmark` take flags only. Secrets are read only from
env or the credential store, never from a config file.

`tess run --live` refuses (exit `4`) any unit spec that has no `tess review`
record or whose body no longer matches the reviewed hash. The hash is taken
after CRLF line endings are folded to LF, and the live run executes that same
folded text, so a checkout that converts line endings keeps the review.

`tess generate --provider anthropic` sends redacted instance data to a third
party, so it also needs an `egress` section in `tessera.config.json` that records
`"consent": true` and names an `allow` list; without one it exits `2`.
`--egress-dry-run` prints the redacted prompt and per-class redaction counts
without calling the API. See `tess generate --help` for the schema.

```bash
export SN_INSTANCE=https://dev12345.service-now.com SN_USER=admin SN_PASSWORD='…'
npx tess doctor --instance default
npx tess impact --instance default --scope x_acme_app
```

Exit codes: `0` ready / GO · `1` not ready / NO_GO · `2` usage · `3`
infrastructure fault · `4` a write was refused and nothing was written · `5`
inconclusive.

Tessera ships inside this one package: no extra npm dependencies, and the
`@tessera/*` workspace packages under [tessera/](tessera/) are internal and never
published on their own. See [tessera/README.md](tessera/README.md) for the
package map and the development workflow.

## Development

```bash
npm install
npm run build        # tsc -> build/
npm test             # node --test (run AFTER build — tests import from build/)
npm run verify       # build + lint + format:check + test
npm run check        # verify + site-catalogue freshness + coverage (the full local gate)
npm run gen:site     # regenerate site/checks.generated.js from the registry
```

ESM (`"type": "module"`) with TypeScript `Node16` resolution — relative imports
carry the `.js` extension. Prettier: `semi`, double quotes, `trailingComma: all`.
Tests (`test/**/*.test.js`) import compiled output from `build/`, **so build
before testing**.

The docs site's check catalogue (`site/checks.generated.js`) is generated from
the check registry: each check's `meta.requires` becomes the board tag and
`meta.summary` (or `description`) its one-line blurb. After adding or changing
a check, run `npm run build && npm run gen:site` and commit the regenerated
file; `npm run check` runs `gen:site -- --check` and fails when it is stale.

## Security

- Credentials are read from the **environment only** — never from the config
  file, never logged, never included in error messages.
- Checks are **read-mostly**: the only write is _running_ the ATF suites you
  explicitly configure via `options.atfSuites`.
- No npm runtime dependencies — the preflight CLI and library are this package
  plus Node. The bundled Tessera tree (`build/tessera/`) vendors exactly one
  third-party package, `acorn` pinned at 8.18.0 (MIT, no dependencies), the ES5
  parser behind the TM-3 gate's AST allowlist layer; the staging script refuses
  any other third-party package or version.

To report a vulnerability, see [SECURITY.md](SECURITY.md). Contributions:
[CONTRIBUTING.md](CONTRIBUTING.md). Community standards:
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Support

Built and maintained in my own time. If it saves you or your team time, please
consider supporting its continued development — sponsorship directly funds new
features, fixes and maintenance.

- **[GitHub Sponsors](https://github.com/sponsors/IvanBBaev)** — one-off or
  recurring, with no platform fee (the preferred option).
- **[Ko-fi](https://ko-fi.com/ivanbbaev)** — quick one-off support; also accepts
  **PayPal**, the fallback for anyone without a GitHub account.
- **[Donate (Donatree)](https://donatr.ee/ivanbbaev/)** — a no-account donation
  page (card, PayPal and more) for a one-off tip.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/ivanbbaev)
[![Donate via Donatree](https://img.shields.io/badge/Donate-Donatree-22c55e?style=flat-square&logo=liberapay&logoColor=white)](https://donatr.ee/ivanbbaev/)

## License

[MIT](LICENSE) © Ivan Baev
