# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Three new default-suite checks: `default-set-leakage` (captured work stranded
  in a "Default"-flagged update set for the target scope), `remote-set-preview`
  (every pending retrieved update set on the target is previewed with all
  preview problems resolved; `updateSetId` focuses the gate), and
  `atf-enablement` (ATF test execution is enabled instance-wide, optionally
  requiring an online scheduled client test runner) — the default suite grows
  from seven to ten checks.
- Five Store-certification checks, live-instance versions of the recurring
  reviewer findings: `client-callable-acl` (every active client-callable
  Script Include is gated by an active `execute` ACL), `rest-endpoint-security`
  (scripted REST resources require authentication and enforce ACL
  authorization), `script-field-exposure` (every script-typed column ships
  with an active field write ACL) — all three fail closed on security-trimmed
  reads — plus the advisory `scheduled-job-run-as` (no pinned "Run as") and
  `mobile-menu-hygiene` (no leftover mobile menus/modules) — the default suite
  grows from ten to fifteen checks.
- `table-crud-acl` certification check (rule 1.1, raised in 16 of 19
  releases): every custom table in scope carries active table-level
  create/read/write/delete ACLs. A base-table gap fails; a gap on a table
  that extends another only warns (it inherits the parent's ACLs at
  runtime); security-trimmed reads fail closed — the default suite grows from
  fifteen to sixteen checks.
- `ui-page-acl` certification check (rule 2.2, raised in 13 of 19 releases):
  every custom UI Page in scope is protected by an active `ui_page` read ACL
  named for its endpoint (the URI without `.do`); security-trimmed reads fail
  closed — the default suite grows from sixteen to seventeen checks.
- `ui-action-gating` certification check (rule 2.1, raised in 10 of 19
  releases): every active UI Action in scope has a non-trivial condition or a
  "Requires role" entry in `sys_ui_action_role`; an empty, whitespace or bare
  `true` condition counts as none, and a security-trimmed role read fails
  closed — the default suite grows from seventeen to eighteen checks.
- `table-namespace` certification check (rule 6.1, raised in 8 of 19
  releases): every table in scope is prefixed with the app namespace
  (`<scope>_`), resolved from `sys_scope` so a scope given by sys_id works
  too; the global scope and an unresolvable sys_id only warn, and a
  security-trimmed read fails closed — the default suite grows from eighteen
  to nineteen checks.
- `portal-roles` certification check (rule 2.6, raised in 7 of 19 releases):
  every Service Portal widget and page in scope carries at least one role;
  role-less ones marked `public` are listed separately as reachable without
  login. Advisory — the rule allows deliberate exceptions, so it never fails —
  the default suite grows from nineteen to twenty checks.
- `module-roles` certification check (rule 5.5, raised in 6 of 19 releases):
  every active navigator module in scope is gated by its own roles or, unless
  it sets `override_menu_roles`, by its application menu's roles — the way
  the platform decides visibility; separators are skipped. Advisory — it never
  fails — the default suite grows from twenty-one to twenty-two checks.
- `acl-out-of-scope` certification check (rule 1.6, raised in 7 of 19
  releases): no `record` ACL the scope ships targets a table outside the app
  (its own `sys_db_object` tables or the `<scope>_` namespace). A
  table-level or wildcard ACL (`table`, `table.*`, `*`) fails; a field ACL
  for the app's own namespaced field on an out-of-scope table only warns;
  a security-trimmed ACL read fails closed — the default suite grows from
  twenty to twenty-one checks.
- The twelve certification checks (`clientCallableAcl`, `restEndpointSecurity`,
  `scriptFieldExposure`, `scheduledJobRunAs`, `mobileMenuHygiene`,
  `tableCrudAcl`, `uiPageAcl`, `uiActionGating`, `tableNamespace`,
  `portalRoles`, `aclOutOfScope`, `moduleRoles`) are now exported from the
  package entry point, like the other built-in checks.
- CLI `-v` / `--version` flag.
- Promotion-order gate: `drift <src> <dst>` now enforces the registry's
  `promotesTo` pipeline with a `promotion-order` result — the declared next
  stage passes; skipping a stage fails (warns under the new
  `--allow-stage-skip` flag); a reverse or unrelated pair always fails; no
  registry or no declared pipeline is an advisory warn. `promotionChain` and
  `promotionOrderResult` are exported for programmatic gates.
- Version parity in the promote gate: `sync` now captures the instance's
  platform identity (`glide.buildname`/`glide.war`) and installed apps/plugins
  with versions; `drift` adds `instance-version-parity` (release-family
  mismatch fails, patch skew warns) and `app-version-parity` (missing or
  downgraded apps on the target fail). Manifests from older versions degrade
  to an advisory warning. When `glide.buildname` is absent on both sides the
  parity gate falls back to comparing `glide.war`, and `sync` proves _why_ the
  property is missing (genuinely absent vs security-trimmed) so the drift
  advisory names the actual cause instead of guessing.
- HTTP(S) forward-proxy support via `CONNECT` tunneling on both transports —
  still zero runtime dependencies. Configured with the `proxy`/`noProxy` config
  fields or `SNPF_PROXY`/`SNPF_NO_PROXY` (falling back to standard
  `HTTPS_PROXY`/`https_proxy`/`NO_PROXY`); https-only by design, proxy
  credentials always redacted, mutual TLS composes through the tunnel.
- Validated encoded-query builder (`src/http/query.ts`), exported as public
  API, so custom checks can compose `sysparm_query` filters without raw string
  interpolation.
- CLI flags `--max-age <dur>` (drift staleness) and `--allow-empty` (sync);
  documented exit code `2` for usage errors (bad flags or config).
- CI coverage gate on Node 20 and 22; Dependabot for npm and GitHub Actions.
- Release runbook (`docs/RELEASING.md`) and OIDC provenance publishing.

### Changed

- The registry now validates `promotesTo` at load time: an undeclared target,
  a self-reference, a non-string value or a cycle is a usage error (exit 2)
  for every command, since `drift` now relies on those edges.
- README restructured quickstart-first; documentation site data refreshed.
- The published package now ships source maps and an `exports`-map default plus
  a `./package.json` subpath.
- All GitHub Actions are pinned to full commit SHAs; the release workflow gained
  a tag-ancestry guard and a `release` environment.

### Fixed

- Test suite is hermetic against the host's proxy environment: every test
  process preloads `test/setup/hermetic-env.js`, which scrubs `SNPF_PROXY`,
  `HTTPS_PROXY`, `NO_PROXY` and their variants, so a machine exporting them no
  longer routes fetch stubs through a real proxy or bypasses a test's own mock
  proxy.
- Checks no longer report a false pass on zero-visible-rows (ACL trimming),
  reference-object field values, update-set batch child trees, or partial i18n
  coverage.
- HTTP client: non-JSON 2xx responses, mTLS and stream errors, OAuth error
  bodies, redirect and poll-budget limits, and token-refresh races are handled
  explicitly instead of failing open.
- State layer: manifest writes are atomic, slug and scope collisions are
  guarded, and an all-empty snapshot is refused unless `--allow-empty` is given.
- CLI: an extra positional instance name (`run dev prod`, `run --env dev prod`,
  `sync a b`, `drift a b c`) is a usage error instead of a silent drop.
- Config: non-string `proxy` / `noProxy` values are rejected with a usage error
  instead of silently bypassing the configured proxy; an unreadable `.env`
  file is a usage error instead of a green run that verified nothing.
- Fail-closed sweep: a partially security-trimmed read fails
  `acl-role-sanity` instead of reporting on the visible subset; a malformed
  `requiredApps` container is its own warning; a check returning a malformed
  result fails that check (not the whole run); JUnit output strips
  XML-invalid characters.

### Security

- The encoded-query builder rejects operator injection and validates the field
  and value charset; scope is resolved once per run.
- The Table API client detects response security-trimming via `X-Total-Count`
  and treats it as a signal rather than an empty-but-clean result.

## [0.5.0] - 2026-07-04

### Added

- Eight authentication methods: basic, bearer token, three OAuth flows, and
  mutual TLS.
- Multi-instance registry (`.preflight/instances.json`) with per-instance state
  manifests and a `sync` / `drift` promote gate.
- GitHub Pages departure-board documentation site.
- JUnit XML and SARIF reporters.
- Initial preflight check suite, auto-paginating Table API client, and the
  `sync` / `run` / `drift` CLI over the `runPreflight` library API.

[Unreleased]: https://github.com/IvanBBaev/servicenow-preflight/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/IvanBBaev/servicenow-preflight/releases/tag/v0.5.0
