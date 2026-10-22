# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`notification-conditions` check** — install hygiene (advisory): an
  active `sysevent_email_action` in scope that is sent on update, has no
  event, no condition and no advanced condition fires on every update of
  its table → **warn** naming the Notification and the table (a mail-storm
  and outbound-queue risk, not a security rule). Metadata columns only; the
  advanced-condition script is tested for emptiness and never echoed.
- **`inactive-artifacts` check** — install hygiene (advisory): counts the
  `active = false` Business Rules, Client Scripts, Script Includes, UI
  Actions, UI Policies, Scheduled Jobs and Notifications the app ships in
  scope and **warns** with per-table counts and the first names (dead code
  still lands on every install and shows in the Store review). One metadata
  read per table, `sys_id` and the name column only — no script bodies.
- **`property-privacy` check** — adjacent to rule 1.7 (blocker): every
  active, password-typed `sys_properties` row in scope must be private
  (`is_private`), otherwise its value is exported in update sets and copied
  on clone → **fail**; a property whose name looks like a secret but uses a
  non-password type → **warn**. Only names and types are read, never values.
- **`CODE_OF_CONDUCT.md`** — the Contributor Covenant 2.1, verbatim; conduct
  reports go to the maintainer via GitHub (no e-mail address). Linked from the
  README next to `SECURITY.md` and `CONTRIBUTING.md`.
- **Tessera reviewed-body binding for `run --live`** — a promoted unit
  spec's `.manifest.json` entry now carries
  `"review": { "bodySha256": "<hex>", "reviewer": "<id>" }`, written by the
  new `tess review --tests-root <dir> --spec <id>... --reviewer <id>`. The
  digest is the lowercase hex SHA-256 of the body's exact UTF-8 text (no
  newline, BOM, whitespace or Unicode normalisation), and `--reviewer` is
  required and never defaulted from git config or `$USER`. `tess review`
  holds each body to the TM-3 gate first and records nothing if one fails
  (exit `4`). `tess run --live` refuses (exit `4`, `REFUSED (TM-5 review)`,
  nothing projected or written) any unit spec with no record, a malformed
  record or a body whose digest no longer matches. Manifests written before
  this change therefore fail closed for `run --live` only; every other
  command still reads them. `@tessera/specs` gains `SpecReviewRecord` and
  `SpecInventory.reviews`.
- **Tessera egress policy on the CLI** — `tess generate --provider anthropic`
  now requires an `egress` section in `tessera.config.json` with
  `"consent": true` (the JSON literal; a string or number is a validation
  error) and an explicit `allow` list; `deny` and `baseUrlOverride` are
  optional and unknown keys are refused with their path. No policy, no
  consent or a malformed section exits `2` with an actionable message.
  `--egress-dry-run` prints the redacted prompt plus a per-class redaction
  count manifest (never values) and exits without calling the provider. A
  non-default `--base-url` runs only when `egress.baseUrlOverride` names that
  exact origin, and the override is logged on stderr. `@tessera/config` gains
  `ResolveInput.sections` for raw, secret-scanned, file-only sections.
  Every config-resolving `tess` command declares the shared `egress`
  section, so a `tessera.config.json` holding a policy no longer makes
  `coverage`, `impact`, `resolve`, `doctor` or `preflight` fail with an
  unknown key; they ignore it, and only `generate` validates it.
- **Generated site check catalogue** — `npm run gen:site`
  (`scripts/gen-site.mjs`) writes `site/checks.generated.js` from the
  registry, and the docs board reads it (plus the check count) instead of a hand-kept copy;
  `npm run check` fails when the file is stale. `CheckMeta` gains optional
  `requires` (the board tag) and `summary` (the catalogue blurb).
- **`client-script-safety` check** — rule 2.8 (blocker): fails on `eval(`,
  `new Function(` or `new GlideRecord(` in active in-scope client scripts, UI
  Scripts, UI Policy scripts and UI Action client scripts, and on
  `GlideScopedEvaluator` used with `evaluateScript` on one line in server
  scripts. Comment lines are skipped; messages name the artifact, field and
  line, never the matched text. A security-trimmed read fails.
- **`hardcoded-identifiers` check** — rule 4.5 (advisory): scans active in-scope
  server and client scripts for 32-hex sys_ids and `http(s)://` URLs that are
  not `*.service-now.com` or `localhost`, skipping comments. Findings warn with
  artifact, field and line (never the matched text); a security-trimmed script
  table read fails closed.
- **Shared script scanner** — `scanScripts` (`src/checks/script-scan.ts`) reads
  the script fields of active, in-scope artifacts and tests line patterns
  against every non-comment line (a small state machine skips `//` and
  multi-line `/* … */` comments and ignores markers inside string literals).
  Hits name the artifact, field and line — never the matched text — and are
  capped at 500 per scan; security-trimmed sources are reported so callers can
  fail closed.
- **`list` and `explain` subcommands** — `list [--format pretty|json]` prints
  the check catalogue (one line per check: name, severity, rule, description;
  `test-drift` marked `(drift only)`); `explain <check>` prints a check's rule
  and title, tables, verdicts, flags and remediation. Both run offline with no
  config or credentials. An unknown name is exit 2 with up to three
  suggestions. Exported as `closestNames` and `RULE_TITLES`.
- **Severity policy** — the config key `severity` and the repeatable
  `run --severity <check>=<fail|warn|off>` flag override how a check's non-pass
  result is reported (`fail`/`warn`, with a `[severity: … by policy]` suffix)
  or skip it (`off`). Unknown check names are a usage error (exit 2) before any
  network call; the CLI entry wins over the config entry. Applied before the
  baseline. Exported as `applyPolicy`, `parseSeverityFlag`, `validatePolicy`
  and `policySkips`.
- **Baseline of accepted findings** — `run --write-baseline [path]` records
  every non-pass result in `.preflight/baseline.json` (per registry instance
  `baseline.<env>.json`; `--force` to overwrite), and `run --baseline [path]`
  (or the config key `baseline`) demotes matching findings to `warn`. A changed
  message is flagged `Baselined but CHANGED since …`; an expired entry fails
  again and adds a `baseline` warning row. Exported as `readBaseline`,
  `writeBaseline`, `applyBaseline`, `baselineFromReport` and `baselinePath`.
- **Per-check metadata** — `Check` gains an optional `meta` (`CheckMeta`: the
  certification `rule` id, `severity` blocker/advisory, the `tables` read, a
  `remediation` paragraph and the pass/warn/fail `verdicts` wording), filled on
  all 23 default checks and `test-drift`. New `describeChecks` / `findCheck`
  catalogue helpers. SARIF `rules[]` entries for known checks now carry
  `shortDescription`, `fullDescription` (remediation) and `properties`
  (`rule`, `severity`, `tables`); `formatSarif` takes an optional check list.
- **Markdown reporter** — `--format markdown` renders a pull-request-comment
  table (heading with instance and verdict, bold summary, rows ordered
  fail → warn → pass, more than five passes folded into `<details>`); `--all`
  adds a one-line roll-up and one block per instance. Exported as
  `formatMarkdown` / `formatMarkdownAll`.
- **Markdown remediation hints** — `MarkdownOptions.checks`: when given, fail
  and warn rows whose check has `meta.remediation` get a second line,
  `<br><sub>Fix: …</sub>`, escaped like messages; pass rows never do. The CLI
  passes the checks that ran, so `--format markdown` shows the hints.
- **GitHub annotations** — `--format github` prints one `::error` (fail) or
  `::warning` (warn) workflow command per non-pass check, titled with the check
  and, under `--all`, the instance, followed by the plain summary line; inside a
  GitHub job they become run and PR annotations with no upload step. Exported as
  `formatGitHubAnnotations` / `formatGitHubAnnotationsAll`.
- **Tessera (preview)** ships inside the package: a ServiceNow test framework
  that this package grows into at v1.0.0. Two new binaries: `tess` (doctor,
  preflight, resolve, impact, coverage, generate, `run --live`, status, confirm,
  cleanup, benchmark) and `tessera-mcp` (a stdio MCP server with 13
  `preflight_*` tools). The runtime closure of the internal `@tessera/*`
  workspace packages is staged into `build/tessera/` on `prepack`; it adds no
  npm dependencies. The `servicenow-preflight` / `snpf` binaries, the checks and
  the library API are unchanged. The live pipeline is not yet verified end to
  end against a real instance, so commands and flags may still change before
  1.0.

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
- `script-hygiene` certification check (rule 4.10, raised in 5–8 of 19
  releases): flags Fix Scripts that do nothing (empty, comments only, or an
  empty IIFE) and Script Include names used twice in the scope or shared with
  another scope, where an unqualified call can resolve to the wrong one.
  Advisory — it never fails — the default suite grows from twenty-two to
  twenty-three checks.
- The thirteen certification checks (`clientCallableAcl`,
  `restEndpointSecurity`, `scriptFieldExposure`, `scheduledJobRunAs`,
  `mobileMenuHygiene`, `tableCrudAcl`, `uiPageAcl`, `uiActionGating`,
  `tableNamespace`, `portalRoles`, `aclOutOfScope`, `moduleRoles`,
  `scriptHygiene`) are now exported from the package entry point, like the other
  built-in checks.
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
- **Behaviour change:** an explicit `--registry <path>` that names a directory
  (or anything else that is not a regular file) is now a usage error — exit 2,
  `RegistryNotFoundError`, "is not a regular file (named by --registry)" — for
  `run`, `sync` and `drift`. It previously surfaced as a raw `EISDIR` read
  error with exit 1; scripts that keyed on exit 1 for this case must expect 2.
- Packing (`prepack` / `npm run stage:tessera`): the Tessera staging marker now
  lives inside `build/tessera/` as a digest of the staged tree (kept out of the
  tarball by a nested `.npmignore`), so wiping `node_modules` no longer makes
  the next pack refuse its own output. A non-empty `build/tessera/` whose
  content does not match its marker — foreign or edited files, or a tampered,
  partial or older marker — is still refused; `npm run build` clears it.
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
- CLI: an explicit `--registry <path>` that does not exist (or is empty,
  blank or not a file) is a usage error (exit 2, `RegistryNotFoundError`)
  instead of silently reading as "no registry" for `run`, `sync` and `drift`;
  only the default `.preflight/instances.json` may be absent. `drift` resolves
  the registry before the manifests, so a mistyped path is not masked by a
  missing-manifest exit 1.
- Config: non-string `proxy` / `noProxy` values are rejected with a usage error
  instead of silently bypassing the configured proxy; an unreadable `.env`
  file is a usage error instead of a green run that verified nothing.
- Fail-closed sweep: a partially security-trimmed read fails
  `acl-role-sanity` instead of reporting on the visible subset; a malformed
  `requiredApps` container is its own warning; a check returning a malformed
  result fails that check (not the whole run); JUnit output strips
  XML-invalid characters.

### Security

- Tessera's Anthropic adapter pins its base URL (AIS-5): `baseUrl` must be an
  `https:` origin with no userinfo, path, query or fragment, and it must be
  `https://api.anthropic.com` unless the caller passes
  `allowBaseUrlOverride: true`. A refused value is never quoted back. The
  check is exported as `resolveAnthropicBaseUrl`. A response body that is not
  JSON now faults without a `cause`, so the parser's error, which quotes the
  body, cannot reach a log.
- **Tessera TM-3 gate: AST allowlist layer** (`@tessera/generate`, PA-10) —
  `inspectAtfServerScript` / `createAtfServerScriptGate` hold an ATF server
  script to two layers: an ES5 parse (acorn 8.18.0) checked against a data
  allowlist (layer 1), then the existing lexical deny-list (layer 2); both must
  pass. Layer 1 fails closed on an unparseable body, a call or construction
  outside the allowlist, a computed member, `eval` / `Function` / `with` /
  `this` / `arguments`, a non-ASCII identifier, an aliased function value, a
  non-literal table name and any redeclared allowlisted name. Allowed:
  GlideRecord / GlideAggregate reads, the ATF assertion helpers, `gs.info` /
  `gs.debug`, and construction of the caller-declared Script Include targets.
  DML, `setWorkflow` / `autoSysFields`, other Script Includes,
  `GlideSysAttachment`, `RESTMessageV2`, `GlideHTTPRequest` and
  `gs.eventQueue` are refused. Findings reuse the lexical gate's
  `{rule, category, line, detail}` shape and never echo the source. The
  bundled Tessera tree now vendors `acorn` at exactly 8.18.0; the staging
  script refuses any other third-party package, a range, a different installed
  version or a vendored package with dependencies of its own.
- **`tess run --live` requires both TM-3 layers** (PA-10) — every repo `unit`
  spec body must clear the AST allowlist and the lexical deny-list before
  anything is projected; the spec's declared `sys_script_include` targets are
  the only classes it may construct besides the read-only Glide ones. A body
  that spelled nothing on the deny-list (an undenied write method, a
  homoglyph, another Script Include) now refuses the run with exit 4.
- The encoded-query builder rejects operator injection and validates the field
  and value charset; scope is resolved once per run.
- The Table API client detects response security-trimming via `X-Total-Count`
  and treats it as a signal rather than an empty-but-clean result.
- **Tessera brands instance names at ingestion** (AIS-4) — every artifact
  name a resolver or an impact lookup reads off the instance, and every
  model-authored `targets[].name` the provider parses, is now an
  `Untrusted<string>` (`InstanceArtifactRef`). Each use unwraps it behind a
  named, allow-listed boundary; every terminal print site escapes it with
  `escapeForTerminal` (now exported from `@tessera/types`), and the JSON
  outputs (`tess resolve/impact/coverage --json`, TestSpecs, the proposed
  manifest) carry the plain wire string. The proposed-manifest writer refuses
  a target whose name is not branded.
- **Tessera generation faults carry no `cause`** (AIS-5) — a failed request
  to the Anthropic Messages API and a provider failure wrapped by the
  generator no longer attach the upstream error as `cause`, so a URL with a
  query string or quoted response text cannot reach a log that walks the
  cause chain. The message names only the upstream error's class and code
  (for example `(TypeError, UND_ERR_SOCKET)`), each matched against a closed
  identifier shape.

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
