# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Release rehearsal path** (RR-14, OPS-14) — `release.yml` has a
  `workflow_dispatch` trigger whose `dry_run` input defaults to on. A dry run
  runs every release guard except the ancestry and tag checks, ends in
  `npm publish --dry-run --provenance` (prepack and the `check` gate still
  run), never receives the npm token, and uploads the output with the tarball
  listing as the `npm-publish-dry-run` artifact. Its `version` input rehearses
  another version (e.g. `1.0.0-rc.1`) in the runner only. A real manual
  publish is accepted only on a version tag ref. Release runs share the
  `release` concurrency group, so two tag pushes queue instead of overlapping,
  and the tag filter is `v[0-9]*.[0-9]*.[0-9]*`: a floating `v1` tag no longer
  starts a release run.

- **`drift` gates on `--fail-on` and writes `--output`** (RR-13, ARC-5) —
  `snpf drift <src> <dst> --fail-on warn` exits `1` on a warn-only drift (e.g.
  an extra downstream test), and `--output <format>=<path>` writes the drift
  report like `run` does, also when the gate blocks. The threshold comes from
  the flag only (`SNPF_FAIL_ON` / config `failOn` stay run settings). The
  drift gate is a library function now: `runDrift(opts)` (source and target
  manifests, optional registry, `maxAgeMs`, `allowStageSkip`, `now`, `signal`)
  returns the report `drift` prints, and `evaluate(report, { failOn })` gives
  its exit decision. New exports:
  `runDrift`, `DriftSide`, `RunDriftOptions` (`servicenow-preflight/state`).

- **Library gate verdict** (RR-12) — `runGate(ctx, checks?, opts?)` returns
  the `Verdict` the CLI acts on (`ok`, `report`, `failOn`, `baselined`,
  `expired`), applying severity policy, baseline and `failOn` in the CLI's
  order; `evaluate(report, opts?)` is the same pure pipeline over an existing
  report. The CLI now decides every run through `evaluate`, and a parity test
  pins the CLI's JSON envelope and exit code to `runGate` across policy ×
  baseline × `failOn`. `runPreflight`'s `report.ok` stays the raw verdict.
  New exports: `runGate`, `evaluate`, `Verdict` (root); `evaluate`,
  `EvaluateOptions`, `Verdict`, `FailOn`, `BaselineTarget`
  (`servicenow-preflight/report`).

- **Config precedence warning and opt-in** (F-X-8) — when `instanceUrl`,
  `updateSetId`, `proxy` or `noProxy` is set in both the config file and the
  environment (`SNPF_INSTANCE`, `SNPF_UPDATE_SET`, `SNPF_PROXY`,
  `SNPF_NO_PROXY`) with different values, the CLI prints one stderr warning
  per key, naming keys only. The file still wins in 1.x; `SNPF_PRECEDENCE=env`
  (or `loadConfig`'s `precedence: "env"`) makes the environment win now, as it
  will by default in 2.0, and `SNPF_PRECEDENCE=file` keeps the file silently.
  `loadConfig` gains `onWarning` and returns `sources` (`"file"` / `"env"` per
  field); `doctor` uses it to report where the instance URL came from.

- **`cors-rules` check** (rule 2.7, blocker) — reads every active in-scope
  `sys_cors_rule`. An empty domain, `*` or a bare-TLD wildcard (`*.com`)
  fails; a wildcard sub-domain (`*.example.com`) warns; a security-trimmed
  read fails. Messages name rules only, never the domain value. Each
  offending rule is one finding (`wildcard-origin`, or `wildcard-subdomain`
  with a `warn` status).
- **Delivery, ATF and app/i18n findings** — `update-set-state` and
  `default-set-leakage` return one finding per offending `sys_update_set` /
  leaked `sys_update_xml` row; `remote-set-preview` one per unpreviewed set and
  per preview problem (`logicalId: "sys_update_preview_problem:<sys_id>"`,
  warnings and resolved problems as `warn`); `atf-run` one `test-failed`
  finding per red test on `sys_atf_test` with the quoted output capped at 200
  characters; `atf-enablement` one `logicalId: "instance"` finding;
  `scoped-app-deps` one per unsatisfied dependency (`logicalId: "app:<id>"`);
  `i18n-completeness` one `missing-translation` finding per missing key
  (`logicalId: "lang:<code>/<key>"`). Row messages are unchanged.
- **`update-set-collisions` check** — finds records in the target update set
  (`updateSetId`, or every in-progress set of the scope's application) that
  another update set also captures, by record key (`sys_update_xml.name`,
  chunked). A collision with another in-progress set fails; collisions with
  completed sets only warn; Default sets are ignored and counted; record keys
  outside the safe charset are skipped and warned. One finding per colliding
  record (`open-collision`, `closed-collision`). Record XML is never requested.
  Blocker; a security-trimmed read fails. Registry grows to 35 checks.
- **`table-access-settings` check** — reads the Application Access fields of
  every in-scope `sys_db_object` row. A table accessible from all application
  scopes that also grants create, update or delete fails; a public read-only
  table and web-service access without a user role warn. One finding per
  offending table (`public-write:<ops>`, `public-read`, `ws-no-role`). Blocker;
  a security-trimmed read fails. Registry grows to 33 checks.
- **`cross-scope-privileges` check** — cross-scope access the app depends
  on (blocker, no checklist rule): reads `sys_scope_privilege` rows whose
  `source_scope` is the resolved scope's sys_id. A **denied** privilege
  fails; one still only **requested**, or with an unknown status, warns;
  a scope that does not resolve to a `sys_scope` record warns. Messages and
  findings name only the target record and operation. **New blocker in the
  default suite** — a run whose app holds a denied privilege now fails.
- **`connection-credentials` check** (rule 1.7, blocker) — reads in-scope
  `discovery_credentials` (any row fails: a credential record ships in the
  app), `sys_rest_message` / `sys_rest_message_fn` (a literal `http…`
  endpoint without a `${…}` alias placeholder warns) and `sys_alias`
  (informational count). Only `sys_id`, names and classes are requested —
  never credential values — and endpoint URLs are never echoed. Each read is
  independent: a trimmed credential read fails, a trimmed REST or alias read
  warns. **New blocker in the default suite** — an app that ships a credential
  record now fails the run.
- **`secret-in-scripts` check** (rule 1.7, blocker) — scans every standard
  in-scope script source for hard-coded secrets: a secret-named identifier
  (`password`, `api_key`, `token`, …) assigned a non-empty string literal
  (code view), a known token shape inside a literal body (AWS access key id,
  GitHub and Slack tokens, PEM private key, JWT; string view), and
  `setBasicAuth(` with a literal first argument. Empty literals, property
  reads and string concatenations such as `"token=" + x` do not match.
  Messages and findings name the artifact, field, line and pattern id, never
  the matched value. **New blocker in the default suite** — an app with a
  hard-coded secret now fails the run.
- **Drift findings and fallback identity** — `test-drift` returns one finding
  per test missing on (`fail`) or extra on (`warn`) the target, keyed on its
  logical id; `app-version-parity` one per downgraded, missing or unverified
  app (`logicalId: "app:<scope>"`); `instance-version-parity` and
  `manifest-freshness` one `logicalId: "instance"` finding per non-pass row.
  New `effectiveFindings(result)` (`servicenow-preflight/checks`) gives a
  non-pass row without findings one implicit `kind: "row"` finding whose id
  depends only on the check name. Row messages are unchanged.
- **Certification-check findings** — the 17 `cert-common` checks (ACL,
  role, namespace, hygiene and privacy rules) return one `findings[]` entry
  per offending record, with a check-local kind (e.g. `no-role`,
  `acl-missing:<op>`, `foreign-table`, `not-private`) and a location of
  table, sys_id and record name. Table-level gaps use a `table:<name>`
  logical id; advisory sub-findings carry `status: "warn"`. Error results
  and passing runs carry no findings. Row messages are unchanged.
- **`platform-release` check** (ADD-13) — reads `glide.buildname` /
  `glide.war` and reports the release family the run targets. Optional
  `options.platform.minRelease` fails an older instance;
  `options.platform.expect` warns on a different family. An unset or unknown
  family, a malformed option or a trimmed read warns. Messages carry only the
  family and the war's leading token. The release order is exported as
  `FAMILY_ORDER` (with `releaseFamily` / `compareFamilies`) from
  `servicenow-preflight/checks`, and the shared `sys_properties` read as
  `readBuildInfo` from `servicenow-preflight/state`.
- **Script-scan findings** — `hardcoded-identifiers`, `client-script-safety`,
  `log-leftovers` and `deprecated-apis` return one `findings[]` entry per
  hit, with kind `pattern:<patternId>`, a location of table, sys_id, record
  name, field and line, and a message naming the pattern, field, record and
  line — never the matched text. Ids leave the line out; a repeat of the same
  pattern in the same field gets an ordinal-salted id. Hits over the 500 cap
  set `findingsTruncated`. Row messages are unchanged.
- **`--changed-since <dur|date>`** — incremental runs: only the checks whose
  `meta.tables` include a table changed since then (a duration such as `24h`
  or an ISO date). Changes come from the update set's `sys_update_xml` rows
  (batched child sets included; composite names such as
  `sys_dictionary_<table>_<column>` map by the longest known table prefix),
  else from the scope's `sys_metadata`. Checks that always run, declare no
  tables or read instance state (update sets, ATF results) are always kept; a
  change read over the row cap runs everything; no changes adds a
  `preflight:incremental` warn row.
  A stderr preamble lists the kept count and the changed tables. Refused with
  `--write-baseline` (exit 2). Library: `changedTables`, `selectByTables`,
  `planIncremental`, `tableOfUpdateName`, `declaredTables`. Watch mode and
  git-ref input are not included.
- **`doctor`** — `servicenow-preflight doctor [env] [-i <url>]` is a read-only
  readiness report: config sources, DNS / proxy, authentication, the
  basic-auth API restriction properties, the account's
  `snc_basic_auth_api_access` role or Web Service Access Only flag, read access
  to every table the selected checks query (a `403` names the affected
  checks), the CI/CD API when `atf-run` is selected, and the Node / tool
  versions. A table it cannot read warns with "ask an admin", never fails;
  exit `1` only when a row fails. `init --check` runs it after scaffolding.
  Library: `doctorChecks(options)` returns the rows as `Check`s for
  `runPreflight`.
- **MFA one-time password for basic auth** (experimental) —
  `SNPF_MFA_TOTP_SECRET` (base32 seed) makes every basic-auth request carry
  the current RFC 6238 code appended to the password; `SNPF_MFA_TOTP_DIGITS` /
  `_PERIOD` override the 6-digit / 30 s defaults and `SNPF_MFA_CODE` passes a
  one-off code. A 401 is retried once with the next window's code, a
  Retry-After wait takes a fresh code, and an MFA challenge without a seed
  names `SNPF_MFA_TOTP_SECRET` in the diagnosis. Library: `SnAuth` basic gains
  `mfa` (`SnMfa`). MFA keys in the config file are refused. The wire format is
  not documented by ServiceNow and is still to be confirmed on an instance.
- **`init`** — `servicenow-preflight init` scaffolds `preflight.config.json`
  (with `$schema`), an optional one-instance registry (`--multi`), a GitHub /
  GitLab / Azure pipeline (`--ci`) and `.gitignore` entries, and prints the
  credential variable names to set (`--auth`). It prompts on a terminal unless
  `--yes`, never writes `.env`, and refuses to overwrite a file without
  `--force` (exit `2`).
- **GitHub Action, GitLab and Azure templates** — the repo is now a composite
  action (`uses: IvanBBaev/servicenow-preflight@vX.Y.Z`): it runs the CLI
  matching its tag, uploads SARIF, writes the step summary and exposes
  `ok`/`pass`/`warn`/`fail`/`sarif-file`/`report-json` outputs; credentials
  stay in `env:`. `ci/gitlab/` and `ci/azure/` ship ready-made job / step
  templates with JUnit reporting. An `action-selftest` workflow runs the action
  against a committed, credential-free replay sample
  (`npm run record:sample` refreshes it).
- **Typed check options and `config schema` / `validate` / `migrate`** —
  checks declare their options with a small schema DSL, from which the CLI
  derives a JSON Schema for the config file
  (`schemas/preflight.config.v1.json`, exported and on the docs site).
  `config validate` lists every problem with a dotted path and a did-you-mean
  hint (exit `2`); `config migrate` moves shared `options` into per-check
  `checks` blocks (diff by default, `--write` to apply, JSON only). A `run`
  only warns about config problems on stderr. Library: `Check.optionsSchema`.
  See README "Validating the config".
- **Explained 401/403 failures** — a refused request now lists its likely
  causes for the auth method in use (wrong or locked basic credentials, a
  basic-auth restriction, MFA, an expired static bearer, an OAuth registry or
  grant problem, a missing ACL/role on the named table). The hints appear in
  the `connectivity-auth` row message and under a `sync`/`drift` error, and
  are built without any credential. Library: `SnAuthError.diagnosis`. See
  README "Troubleshooting 401 / 403".
- **`--output` files and the GitHub step summary** — `run --output
<format>=<path>` (repeatable) also writes the report in another format to a
  file, atomically. Inside GitHub Actions a run appends the markdown report
  to the step summary (off with `--no-summary` / `SNPF_SUMMARY=0`) and
  `ok`/`pass`/`warn`/`fail` to the step outputs.
- **`--fail-on warn`** — `run --fail-on warn` (or `SNPF_FAIL_ON`, or the
  `failOn` config key) also exits `1` on a `warn` row that no baseline
  accepted. Rows keep their statuses; only `ok` and the exit code change, and
  the JSON envelope gains `failOn: "warn"` (in `report.v1.json`).
- **Record and replay** — `run --record <dir>` also saves every REST
  response, redacted (fields filtered to the request, secrets and tokens
  removed, host replaced, user and group names pseudonymised unless
  `--record-raw`), and `run --replay <dir>` runs the checks from that
  directory with no network or credentials. A request missing from the
  recording fails its check; the report notes the replay (`replay` on each
  run in `report.v1.json`). Library: `createReplayClient`, `readRecording`,
  `RecordingError` and `PreflightContext.replay`.
- **Diagnostics** — `run --timings` prints per-check time, requests, `429`
  retries and read-cache hits to stderr (`--format json`: an optional
  `timings` object per run, in `report.v1.json`). `run --trace <path>` (or
  `SNPF_TRACE`) writes a local, allowlisted NDJSON trace (`run`, `check` and
  `http` events; mode `0600`; no query values, rows, headers or credentials).
  Library: `createTracer`, `collectTimings`, `formatTimings` and the
  `node:diagnostics_channel` names in `TRACE_CHANNELS`.
- **Concurrent checks** — a run executes up to `--concurrency <n>` checks at
  once (default `4`, or `SNPF_CONCURRENCY`, 1–32); `atf-enablement` and
  `atf-run` are marked `meta.serial` and run alone after the others. The
  report keeps registry order and is identical at any concurrency. Library:
  `runPreflight(ctx, checks, { concurrency })` (default `1`) and
  `LoadedConfig.concurrency`.
- **Read cache** — a run fetches each identical Table API read once and
  shares it between checks, which cuts the full registry's GETs by about 40%
  with an unchanged report. Failed reads are not cached; one check's timeout
  never fails another check waiting on the same read. Opt out with
  `--no-cache` or `SNPF_CACHE=0`. Library: `SnClientConfig.cache` (default
  `false`) and `LoadedConfig.cache`.
- **Request limits** — `--max-inflight <n>` (default `4`, or
  `SNPF_MAX_INFLIGHT`) caps concurrent requests and `--rps <n>` (or
  `SNPF_RPS`) caps the request rate; a `429` pauses every queued request for
  its `Retry-After` window. Library: `SnClientConfig.maxInFlight` / `rps`
  (unset = unlimited) and `LoadedConfig.limits`.
- **Timeouts and cancellation** — `--timeout <dur>` (or
  `SNPF_CHECK_TIMEOUT`) fails a check that runs too long and moves on;
  `--run-timeout <dur>` bounds the whole run; durations accept `ms`. Ctrl-C
  aborts in-flight requests, still prints the partial report and exits `130`.
  Library: `runPreflight(ctx, checks, { signal, timeoutMs, runTimeoutMs })`,
  a per-check `PreflightContext.signal`, `{ signal }` on every `SnClient` call
  (`SnCallOptions`) and `withSignal(client, signal)`. An aborted request
  rejects with `SnNetworkError`, its `cause` the abort reason.
- **`loadConfig(cwd, { env, dotenv })`** — resolve config and credentials
  from an injected environment (default `process.env`) and an optional `.env`
  (`dotenv`, default `true`). The result carries the merged `env`, and
  `createSnClient({ env })` reads proxy variables from it. `skipDotEnv` is
  deprecated in favour of `dotenv: false`.
- **State manifest versioning** — `sync` writes `"version": 1` as the first
  key of `.preflight/state/<env>.state.json` (a one-time extra line on the
  next sync). A manifest without `version` still reads as version 1; any other
  value is refused with exit `2` and "upgrade the tool", so an older CLI never
  silently mis-reads a newer format. `MANIFEST_VERSION` is exported.
- **Record-level findings (`Finding`)** — `CheckResult` gains optional
  `findings` (`id`, `kind`, `message`, `status?`, `location?`) and
  `findingsTruncated`. New exports `findingId` (stable `f1:` fingerprint over
  check, kind, table, sys_id, field and logical id — never the line, record
  name or message), `makeFinding`, `capFindings` and `MAX_FINDINGS` (500).
  `runPreflight` sanitises returned findings and caps them; results without
  findings are unchanged.
- **Synthetic-row `kind`** — `CheckResult.kind` (`"check" | "runner" |
"baseline"`, new `CheckResultKind` export) marks the runner's `preflight`
  guard rows (`"runner"`) and expired-baseline rows (`"baseline"`); check rows
  omit it and a check cannot set it. SARIF results carry it as
  `properties.kind`.
- **Per-check options (`checks` config key)** — `PreflightConfig.checks` was
  declared but never read. Each entry is now shallow-merged over `options`
  for its check only (new `PreflightContext.checkOptions`, honoured by
  `runPreflight`); a non-object value or an unknown check name is a usage
  error (exit 2), and per-check `languages` / `baseLanguage` get the same
  SR-1 load-time query-injection guard as `options`.
- **`deprecated-apis` check** — scope-unavailable and synchronous API calls
  (blocker, no checklist rule): a `Packages.` Java call in an active in-scope
  server script → **fail** (not available in scoped apps); in client
  scripts a synchronous `getXMLWait(` (rule 3.3 spirit), a callback-less
  `g_form.getReference(…)` (rule 4.7) or the server-only `gs.hasRole` →
  **warn**. Messages name the artifact, field and line, never the matched
  text; a security-trimmed script read fails closed. Uses the shared script
  scanner.
- **`log-leftovers` check** — certification rule 4.3 (advisory): active
  in-scope client scripts, UI Scripts, UI Policy scripts and UI Action
  client scripts are scanned for `console.log(` / `console.debug(` /
  `console.dir(` and debug `alert(` calls, and server scripts for
  `gs.print(` / `gs.log(` (unavailable in scoped apps) → **warn** naming the
  artifact, field and line, never the matched text; a security-trimmed
  script read fails closed. Uses the shared script scanner.
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
  digest is the lowercase hex SHA-256 of the body's UTF-8 text with CRLF
  line endings folded to LF (no other newline, BOM, whitespace or Unicode
  normalisation), and `--reviewer` is
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

- **`sync` refuses `--fail-on` and `--output`** (RR-13, ARC-5; **breaking**
  for a command line that passed them) — `sync` writes a manifest, not a
  report, and used to drop both flags silently. It now exits `2` with a usage
  error before any request. The GitHub Action and the CI templates always pass
  `--fail-on` / `--output`, so they support `run` and `drift`, not `sync`.

- **Unknown check names in the selection are a usage error** (RR-11b, DEV-9;
  **breaking** for a misspelled name) — `--only` / `--skip` (on `run` and
  `doctor`) and the config file's `select.only` / `select.skip` naming a
  check that does not exist now exit `2` with the nearest names and a pointer
  to `servicenow-preflight list`, instead of silently dropping the intended
  gate. The severity policy, per-check `checks` options and the selection
  share one known-name set, so `--severity test-drift=off` is accepted like
  `checks: { "test-drift": … }`. The library's `selectChecks` still ignores
  unknown names.

- **A pending ATF suite fails the run** (RR-6; **breaking** for runs whose
  suites outlast the poll budget) — `atf-run` reports a configured suite that
  is still pending after the CI/CD poll budget (`cicdMaxPolls` ×
  `cicdPollIntervalMs`, default 450 × 2 s ≈ 15 min) as `fail` instead of
  `warn`, since nothing was verified; the message quotes the client's real
  budget (the new `SnCicd.pollBudget`, typed `CicdPollBudget`; the default when
  a custom client reports none). The new
  `atf-run` option `atfPending: "warn"` restores the old behaviour for teams
  that accept async suites (`"fail"` is the default). A red suite still fails
  regardless of the option.

- **Unknown `SNPF_AUTH` is a config error** (RR-5; **breaking** for a
  misspelled selector) — a value that names no auth method now exits `2` with
  the list of valid values instead of being silently ignored (which, with
  RR-4, meant no credentials). The selector is trimmed and case-insensitive;
  `bearer` (the `init --auth` name) and `oauth` are aliases of `token`.
  `SNPF_AUTH=mtls` gets a hint that mutual TLS is configured through
  `SNPF_MTLS_CERT` / `SNPF_MTLS_KEY` instead.

- **Missing or partial credentials fail closed** (RR-4; **breaking** for CI
  runs without credentials) — a half-set credential pair is a config error
  (exit `2`) naming the missing variable, never values: `SNPF_USER` without
  `SNPF_PASS` (or the reverse), an OAuth client id without its secret (or the
  reverse), a refresh token or JWT key without the OAuth client, a known
  `SNPF_AUTH` kind whose inputs are incomplete, and `SNPF_MTLS_CERT` without
  `SNPF_MTLS_KEY` (or the reverse). `resolveAuthFromEnv` / `resolveTlsFromEnv`
  throw `UsageError` for these instead of returning `undefined`. When `CI` is
  set (anything but empty, `0` or `false`), a `run` or `sync` against an
  instance with no credentials at all is exit `2` instead of an all-warn green
  run, so a renamed or expired CI secret fails the gate; `--allow-no-auth`
  opts out for an anonymous instance. Locally the run still proceeds and the
  checks warn; `--replay` needs no credentials.

- **Read failures are an `error` status** (RR-3, OD-12; **breaking** for
  library consumers of `CheckStatus` and `summary`) — an HTTP 4xx/5xx, network
  or auth failure while a check reads the instance (and such an error thrown
  out of a check into the runner) is now an `error` row instead of a `fail`.
  It fails the run (exit `1`, `ok: false`), is counted in a new
  `summary.error` bucket, and is never demoted: a baseline neither records nor
  matches it and a severity policy leaves it alone, so a baselined finding
  whose read later returns 403 no longer reads as accepted. JUnit renders it
  as `<error>` with an `errors=` count, SARIF at level `error`, markdown with
  🛑 sorted first, text with `E`, the action gains an `error` output and the
  trace carries the status and bucket. Unexpected errors (an unparsable
  response, a bad encoded query, a crash) stay `fail`. A missing table — HTTP
  404, or the Table API's HTTP 400 "Invalid table" — is not a read failure:
  the check is skipped with a `warn` that says the providing plugin is likely
  not installed, so an instance without an optional plugin does not go red.

- **Script scanner lexer** (behaviour narrowing) — the pattern checks now
  lex each script field into a code view (comments blanked, string, template
  and regex bodies replaced by spaces), a string view (only string and
  template bodies) and a raw view (comments blanked only), with line and
  column positions kept. Regex literals and template `${…}` expressions are
  recognised. `client-script-safety`, `log-leftovers` and `deprecated-apis`
  match the code view, so text inside a string or regex literal (for example
  `"console.log("`) is no longer a hit; `hardcoded-identifiers` matches
  sys_ids and URLs only inside string and template literals. Verdicts can
  only move toward fewer false positives. Internal: `ScanPattern.view`,
  `ScanResult.truncated` and `lexLines`; `codeLines` returns the raw view.
- **Tiered library exports** (breaking, pre-1.0) — the package root shrinks
  from ≈210 symbols to a curated core of 37 (`runPreflight`, `selectChecks`,
  `defaultChecks`, `createSnClient`, `withSignal`, the `SnError` family,
  `makeFinding`, `findingId`, `loadConfig`, `UsageError`, `describeChecks`,
  `findCheck` and the core types). Everything else moves to subpaths:
  `servicenow-preflight/checks` (bundled checks, findings helpers, `doctorChecks`,
  policy, incremental selection), `/http` (client, query helpers, env auth/TLS
  resolution), `/report` (envelope, formatters, baseline, tracing), `/state`
  (registry, manifests, sync, drift), `/testing` (fake and replay clients,
  recordings) and `/internal` (`closestNames`, `RULE_TITLES`,
  `parseSeverityFlag`, `slugify`, `tablesOf`, `tableOfUpdateName`,
  `namespacedEnv`; no semver promise). The deprecated `Auth` type alias is
  removed; use `PreflightAuth`. A snapshot test
  (`test/fixtures/public-api.txt`) pins every export per entry point.

- **Gate hardening (contributors).** `npm run build` compiles into a private
  `.build-<pid>-…` directory and swaps it in with renames, so a concurrent test
  or second build never sees a missing `build/`. `npm run check` now ends with
  a pack-and-install smoke (`npm run smoke:pack`): the tarball `npm pack`
  produces is installed offline into a fresh consumer, which imports the
  library and its schema subpaths and runs both bins. Coverage floors rise to
  the measured value minus one point. HTTP client tests assert the waits they
  request on an injected clock instead of elapsed wall-clock time.

- **Exit code `3` for runtime errors** (breaking, pre-1.0) — an error that
  escapes a command without being a usage or config error (a network or HTTP
  failure outside the checks, e.g. during `sync`; an unreadable or unwritable
  file; a crash) now exits `3` instead of `1`, so CI can tell "the tool could
  not run" from "a check failed" (`1`). Failures inside a check are still
  `fail` rows (exit `1`). An unreadable `SNPF_*` `@file` value is now a config
  error (exit `2`). The GitHub Action exposes the code as the `exit-code`
  output; HELP and README document `3`.

- **Certification rule mapping** — `deprecated-apis` now declares rule 4.7
  (callback-less `g_form.getReference()`) and `inactive-artifacts` rule 6.6
  (dead metadata removed before packaging), so `list`, `explain` and SARIF
  rule properties show them; 19 checks now carry a rule id.

- **`.env` no longer mutates `process.env`** — `.env` values merge into a
  private copy, so library embedders that load several configs in one process
  no longer leak credentials between them. Code that read a `.env` value back
  from `process.env` after `loadConfig` should read `loaded.env` instead. The
  CLI behaves as before, including `HTTPS_PROXY` / `NO_PROXY` set in `.env`.
- **State manifest errors exit 2** — a malformed state manifest (invalid
  JSON, not an object, an element without an `id`, or one that declares a
  different instance) and a `drift` side that was never synced are now usage
  errors (exit `2`) instead of exit `1`, so CI can tell a broken checkout apart
  from a blocked release. A check failure still exits `1`.
- **`--format json` prints a versioned envelope** —
  `{ schemaVersion: 1, tool: { name, version }, generatedAt, ok, runs: [{ instance?, url?, report }] }`
  for single-instance, `--all` and `drift` runs alike, replacing the bare
  `PreflightReport` and the `--all` `{ ok, instances }` object. Single-instance
  runs now keep the registry instance name; `url` is the instance origin only.
  Read a single report with `.runs[0].report`. New JSON Schemas
  `schemas/report.v1.json` and `schemas/finding.v1.json` (draft 2020-12),
  generated from the types by `npm run gen:schema`, shipped and exported by the
  package, published on the docs site and drift-checked by `npm run check`. New
  library exports `toEnvelope`, `formatJson` and `REPORT_SCHEMA_VERSION`.
- Check names `preflight`, `baseline` and any `preflight:` prefix are now
  reserved: `runPreflight` rejects a check set that uses one with a single
  failing `preflight` row, like duplicate names.

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

- **`.env` grammar, recording redaction and file modes, trace paths**
  (RR-61, RR-30, CFG-4, CFG-5, CFG-6, CFG-17, CFG-18, SEC-9) — **behaviour
  changes:**
  - The `.env` reader follows the dotenv grammar. A quoted value keeps a `#`
    and an escaped quote (`SNPF_PASS="pa#ss"` was read as `pa`); a double-,
    single- or backtick-quoted value may span lines (a PEM key no longer
    turns into junk keys); `\n` / `\r` / `\t` / `\"` / `\\` are expanded in
    double quotes only; an unquoted value is cut at `#` only after
    whitespace (`pa#ss` stays whole). A line with no `=`, an unterminated
    quote or text after a closing quote now **fails the run** with
    `<file>:<line>: …` (the value is never echoed) where it used to be
    skipped or kept half-read. A UTF-8 BOM is ignored.
  - Recordings redact more: camelCase and dotted secret names
    (`userPassword`, `glide.smtp.pwd`, `u_pwd`, `u_pin`, `cookie`,
    `session_id`, `x.basic.auth.pass`, encryption keys, numbers under such
    names), URL userinfo, `Authorization` values of any length, escaped-JSON
    and backtick literals, `setBasicAuth` / `setPassword`-style arguments,
    `setProperty("x.pwd", "…")` and `?apikey=…`. The stored request key and
    the `link` header now pass through the redactor: secret-named query
    parameters become `<redacted>` and people operands of a `sysparm_query`
    become pseudonyms. A file that still looks like it holds a secret after
    redaction is not written — the run fails instead.
  - A recording directory is created `0700` and its files are written
    atomically with mode `0600` (they were `0755` / `0644`). Starting a
    recording removes the `index.json` and exchange files a previous
    recording left there, so a re-record never replays a stale answer;
    other files in the directory are kept.
  - Replay rejects an exchange file without a valid HTTP status, with
    non-string headers or text, or recorded for another method. A malformed
    `%` escape in a recorded path no longer throws `URIError`, and a
    `__proto__` query parameter is now part of the request key. Existing
    recordings keep their file names.
  - The trace (`SNPF_TRACE`) keeps only allow-listed path shapes: a path it
    does not know keeps its `now` / `global` / `sn_*` namespace
    (`/api/now/:path`) or becomes `/api/:path` / `:path`, so user names and
    custom app paths no longer appear (it was `/api/now/x/:value`).

- **Reporters tell the same verdict as the exit code** (RR-70, REL-2, REL-3,
  REL-4, REL-8, REL-9, REL-11, CLI-13) — under `--fail-on warn` a run that
  exited `1` on a warn wrote JUnit with `failures="0"`, SARIF level `warning`
  and `::warning` lines. A `warn` row no baseline accepted now renders as a
  JUnit `<failure>` (counted in `failures`), a SARIF `error` and an `::error`,
  and the `github` summary line ends with `— failing: --fail-on warn`; a
  baselined warn stays a warning. `run` (single and multi-instance, each
  instance with its own threshold) and `drift` pass the threshold to the
  reporters; library callers pass `{ failOn }` (`ReportFormatOptions`, new
  type export) as the new last argument of `formatJUnit`, `formatSarif`,
  `formatGitHubAnnotations` and the multi-report variants, and a
  `NamedReport` may carry its own `failOn`. A row with an unknown status,
  which the summary already counts as a failure, rendered as a passing JUnit
  testcase and a level-less SARIF result: it is a failure in both now. A row
  without a message no longer makes JUnit throw or print `undefined`.
  **SARIF now emits one result per non-`pass` finding** (it emitted one per
  row), each with `partialFingerprints["findingId/v1"]` and a logical
  location (`table/sys_id.field:line`), so code scanning tracks and closes
  findings one by one; a row whose finding list was truncated keeps a row
  result counting the rest. Existing code-scanning alerts keyed on the old
  per-row result close once and reopen per finding. The Markdown table now
  neutralises `[ ] ( ) ! * _ ~ \`, `&` and `@` as well, so a message from an
  instance cannot render an image, a link, emphasis or a mention in the PR
  comment; check names stay in a code span. `createFakeSnClient` takes
  `maxRows` (default 100000) and throws `SnTruncationError` on an
  auto-paginated read past it, like the real client.

- **HTTP client robustness: progress links, Retry-After, token endpoint,
  NO_PROXY, redirects and aborts** (RR-60, HTTP-3, HTTP-7…HTTP-14,
  HTTP-16…HTTP-18) — the CI/CD progress poll is now always built on the
  configured instance origin: from the link's `id` when present, otherwise
  from the path of its `url` only. A server-supplied link naming another
  host is no longer refused; the foreign host is simply never contacted.
  `Retry-After` accepts decimal and `+`-signed seconds, and every wait has
  a 250 ms floor, so `Retry-After: 0` no longer retries in a tight loop. A
  value is read as an HTTP date only when it contains letters.
  A 429 or 5xx from the OAuth token endpoint is now retried
  (`Retry-After`-aware, 4 attempts, a fresh JWT assertion each time). When
  it keeps failing it surfaces as `SnHttpError` with the status, no longer
  as an `SnAuthError` that blamed the credentials. A token endpoint that
  rotates the refresh token is honoured: the next exchange presents the new
  one. A caller's abort now ends a wait on a pending token request. A
  private key that cannot sign the JWT assertion is an `SnAuthError` naming
  the cause (never the key), not a raw crypto error. A 403 from the token
  endpoint gets OAuth-entry and IP-restriction hints instead of table-ACL
  hints.
  Redirects are no longer followed on any transport (`redirect: "manual"`).
  The refusal names the status and the target origin and path, never its
  query string, so an SSO or maintenance redirect is recognisable. Network
  errors carry the underlying cause (`ECONNREFUSED`, `ENOTFOUND`, …) in
  the message and as `cause`.
  `NO_PROXY` / `SNPF_NO_PROXY` now honour `*.example.com` and CIDR ranges
  (`10.0.0.0/8`, `fd00::/8`, IP-literal targets only). Any other wildcard
  form still never matches, so the proxy stays in use.
  The `node:https` transports (mTLS, proxy) strip a leading UTF-8 BOM
  before parsing JSON. They no longer leave an abort listener on a
  long-lived signal after each request, and they close the tunnel socket
  when building the request throws.
  One check's abort no longer fails the shared `sys_scope` lookup for the
  other checks of the run. A backward wall-clock step no longer stalls the
  rate limiter.

- **Script scans catch more spellings; release and version gaps close**
  (RR-68, DEL-11, DEL-14, DEL-15, DEL-16) — `client-script-safety` matched
  `GlideScopedEvaluator` / `evaluateScript` with `A.*B|B.*A`, which backtracks
  quadratically: one long line repeating either name took seconds per scan.
  It now uses two anchored lookaheads (linear). The scans also catch forms
  they used to miss: `window["eval"](…)`, `(0, eval)(…)`, `Function(…)`
  without `new`, `self.Function(…)` and `globalThis["Function"](…)`
  (`client-script-safety`); `console.info` / `warn` / `trace` / `table`,
  `console["log"](…)`, `gs .log(…)` and `gs["log"](…)` (`log-leftovers`;
  client `console.error` stays allowed); `Packages["java"]`
  (`deprecated-apis`); uppercase sys_ids, and a URL is judged by the host
  `new URL()` parses, so `https://acme.service-now.com:pw@evil.example.com`
  is flagged and `https://user:pw@acme.service-now.com` is not
  (`hardcoded-identifiers`). Bracket forms match only in code, not in quoted
  text. A line counts once per finding kind, and finding kinds keep their
  ids, so baselines stay valid. `platform-release` now resolves a
  multi-word family with a suffix (`San Diego Patch 3`, `Washington DC
Patch 1`) instead of reporting it unknown, so `minRelease` is enforced on
  those instances. `scoped-app-deps` now **fails** when a required app is
  present but its installed version is unknown or unparseable while a
  `minVersion` is declared (it warned); without a `minVersion` an unknown
  version is still not judged.

- **Hygiene checks judge what really gates** (RR-59, ACL-15, ACL-16, ACL-17,
  ACL-18, ACL-19, ACL-20, ACL-21) — eight checks passed on rules that gate
  nothing or missed what the app ships. `ui-action-gating` and
  `notification-conditions` treat an always-true condition (`1==1`, `(true)`,
  `'a'=='a'`, `!0`) or a comment-only one as no condition, and
  `notification-conditions` now also flags a Notification that sends on every
  insert. `script-field-exposure` covers `script_server`, `script_client`,
  `email_script` and `condition_string` columns, and a role-gated table-level
  write ACL turns a missing field ACL into a warn instead of a pass or fail.
  `acl-out-of-scope` no longer counts a sibling scope's prefixed table
  (`x_acme_app_ext_task`) as the app's own unless the table read was trimmed
  or unproven. `module-roles` skips modules under an inactive menu, and
  `module-roles` and `portal-roles` no longer count the `public` role as a
  gate (`portal-roles` flags logged-in-only widgets only when the page is
  public). `cors-rules` also reads active rules of other scopes that target the
  app's REST APIs and fails public-suffix wildcards (`*.co.uk`,
  `*.github.io`, `*.herokuapp.com`). `scheduled-job-run-as` reads
  `sysauto_report` and `sysauto_template` next to `sysauto_script` (skipping
  a table the instance lacks) and warns when a job's Run-as cannot be read.

- **Schema-dependent checks read the columns that decide** (RR-58, ACL-4,
  ACL-5, ACL-9, ACL-10, ACL-11, ACL-12, ACL-13) — four checks filtered on, or
  judged by, the wrong columns. `property-privacy` no longer adds an
  `active=true` term (`sys_properties` has no `active` column, so the filter
  could hide every leaky property). `connection-credentials` walks the class
  tree under `discovery_credentials`, `oauth_entity` and
  `sys_auth_profile_basic` (fail) and `sys_auth_profile_oauth2` (warn — each
  customer should register their own) and looks for those classes in the
  app's `sys_metadata` and `sys_metadata_link` records, so a credential the
  app does not ship no longer fails and one added as a data record no longer
  passes; a class read that was security-trimmed or deeper than 10 levels
  fails. A REST endpoint counts as hard-coded when its host is a literal, so
  `https://api.vendor.example/v1/${path}` now warns. `table-access-settings`
  fails a public table that grants other scopes configuration
  (`alter_access`) or UI actions (`actions_access`), and a web-service table
  now needs an active table-level read ACL shipped in the app — `user_role`
  is not a web-service gate and is no longer read. `rest-endpoint-security`
  checks the ACLs each resource enforces (its `enforce_acl`, else its API's
  default list): one of them must be an active `REST_Endpoint` ACL of the app
  gated by a role other than `public`, a script or a condition. The global
  default ACL, a public-only ACL or an unrelated in-scope ACL no longer backs a
  resource (a per-resource warn finding replaces the scope-level
  `no-rest-endpoint-acl` one). Resources of an explicitly inactive API are
  skipped. A trimmed API, ACL or role-link read fails.

- **ACL checks judge what ships and what actually gates** (RR-57, ACL-2,
  ACL-3, ACL-6, ACL-7, ACL-8, ACL-14) — four ACL checks could pass on an ACL
  that does not ship with the app or does not gate anything.
  `table-crud-acl`, `client-callable-acl` and `ui-page-acl` now read each
  ACL's scope: a matching ACL that lives in another scope (customer-made on
  the dev instance, or a same-named `global` ACL such as `Ajax` for a scoped
  `x_acme_app.Ajax`) fails as "exists but does not ship", and an ACL whose
  scope cannot be read is not counted. `acl-role-sanity` treats the `public`
  role as no role, strips comments from ACL scripts and treats a
  constant-true script (`answer = true;`, `// TODO`) or a `^EQ`-only
  condition as no gate, skips inactive ACLs after flagging them (an inactive
  role-less write was a public-write fail), reads role links with the
  security-trimmed signal (a trimmed link read is "Cannot read the ACL role
  links", not a wide-open finding) and warns on a mutating ACL gated only by
  `snc_internal`. ACL reads request `operation.name`, so a custom operation
  whose reference is a GUID is still matched by name; a wide-open ACL for a
  non-CRUD mutating operation (`save_as_template`, `list_edit`, …) or an
  unknown operation fails. `table-crud-acl` walks each extended table's
  `super_class` chain: a gap warns only when an ancestor's ACL covers the
  operation, fails when no ancestor does, and fails when the chain cannot be
  read (missing parent, cycle, over 20 levels). A wide-open `execute` ACL
  stays a warning; the final form of the operation match awaits live
  query 4 (OD-9).

- **The instance registry is validated on load** (RR-56, ST-20, ST-22,
  ST-23, CFG-10, CFG-11, CFG-12) — a registry that loaded but meant the wrong
  thing is now a usage error (exit `2`). Unknown keys are refused, with a
  case hint (`promotesto` silently left an instance with no promote target).
  `stage`, `scope` (registry and instance) and `envPrefix` must be strings and
  an instance entry must be an object (a numeric `envPrefix` was a raw
  `TypeError`). Instance names — in the registry and on the command line —
  follow an allow-list (a letter or digit, then letters, digits, `.`, `_`,
  `-`; no trailing `.`), must be NFC (an NFD duplicate shared one macOS file)
  and must not be a Windows device name; NUL, `:`, `*`, `--all` and
  `__proto__` were accepted. Each instance's credential env prefix must be
  non-empty, unique (`prod-eu` / `prod_eu` / `prod.eu` shared `PROD_EU`) and
  must not make one `SNPF_*` variable read as another (`no` read
  `SNPF_NO_PROXY` as the proxy, `oauth-refresh` read the refresh token as a
  bearer token, `prod` beside `prod_no` overlapped on `SNPF_PROD_NO_PROXY`);
  an explicit `envPrefix` must be upper-snake. `resolveInstance` and
  `promotionChain` look up own keys only (`constructor` resolved Object's).

- **Auto-pagination survives a table that changes mid-walk** (RR-55, HTTP-2,
  HTTP-15) — offset windows over a live table skipped a row whenever one was
  deleted behind the current page and repeated one on each insert, and a
  caller's `ORDERBY` on a non-unique field (`sys_created_on`) left ties free
  to reorder between pages; the walk returned the damaged set as complete.
  `table().query()` / `queryWithMeta()` now page along a `sys_id` keyset
  (`sys_id>last^ORDERBYsys_id`, with `sys_id` added to `sysparm_fields` for
  the walk and stripped from the rows again). A query with its own `ORDERBY`
  or an `^NQ` keeps offset windows, gains an `ORDERBYsys_id` tiebreak unless
  `sys_id` is already an order key, and treats a moved `X-Total-Count` or a
  repeated `sys_id` as a changed set. A keyset walk whose rows do not add up
  to the first count re-reads the count with one `sysparm_limit=1` request.
  A changed set is walked once more; if it changes again the query throws
  `SnError` instead of returning rows that may be missing or doubled. A row
  without a usable `sys_id` in keyset mode is an `SnResponseError`. The RR-1
  security-trimming and RR-46 count rules are unchanged; on a heavily trimmed
  set the `maxRows` cap counts windows read and may trip slightly earlier.

- **`drift` proves identity and parity** (RR-54, ST-7, ST-8, ST-9, ST-10,
  ST-24) — a promote gate that compared the wrong things no longer passed.
  A new `manifest-identity` result fails when a manifest's `url` is not the
  URL the registry declares for its name (a prod manifest copied in as
  staging), when source and target resolve to one instance URL (two names, one
  instance) or name, and when the two were synced for different scopes; a
  manifest with no `url` warns. URLs compare normalised. `loadManifest` now
  refuses (exit `2`) a manifest with an absent, blank or non-string
  `instance` instead of filling in the requested name. `manifest-freshness`
  fails a `syncedAt` more than five minutes in the future (it was clamped to
  age zero and passed) and warns on a missing or unparseable one even without
  `--max-age`. `app-version-parity` now **fails** when an app recorded on the
  source is not installed on the target (it was an advisory `warn`, against
  the documented contract), warns when the source recorded no version, and
  compares `v`-prefixed and pre-release / build-suffixed versions instead of
  skipping them as unparseable. `promotion-order` **fails** for an instance
  the registry does not declare (a typo was an advisory `warn`); no registry,
  or no `promotesTo` pipeline, stays a `warn`. New exports
  (`servicenow-preflight/state`): `identityResults`, `IdentitySide`,
  `IDENTITY_CHECK`, `FUTURE_SYNC_SKEW_MS`.

- **`doctor` fails closed** (RR-53, ST-6, ST-15, ST-16, ST-17) — a doctor run
  that proved nothing no longer passed. `doctor-table-access` is now a
  blocker: it fails when a table a selected check requires answers HTTP 403
  (a table every reader lists in `meta.optionalTables` still only warns) or
  when read ACLs trim it (the one-row probe returns nothing although
  `X-Total-Count` counts matching rows); no rows with no count, a non-2xx or
  a body without a `result` array warns. The probe is a raw
  `GET /api/now/table/<name>?sysparm_limit=1` that reads `X-Total-Count`.
  `doctor-basic-auth` reports "not active" only when it sees both the
  `…restriction.active` and `…restriction.enforce` properties set to false
  in an untrimmed read, warns otherwise, and treats an enforcement date of
  today or earlier as enforced. `doctor-cicd` passes only on HTTP 200, 400
  or 404 carrying a ServiceNow `result` / `error` JSON envelope; a login
  page, a redirect, a 429 or any other status warns. New `DoctorOptions.now`
  (the clock for the date comparison). Fake: `request("GET",
"/api/now/table/<name>", { query })` without a canned `requests` entry is
  now served from `tables` (paging and `fail` as for `table().query`) with
  an `x-total-count` header from `totalCounts` or the matching row count,
  instead of a bare 404. Behaviour change: `doctor` exits `1` on a refused or
  trimmed required table, where it warned before.

- **Script scans no longer go blind** (RR-67, DEL-3, DEL-4, DEL-8, DEL-9,
  DEL-12) — the shared script-scan lexer could lose sync and blank every
  later line, so a secret or banned call below the trigger passed unseen. A
  regex literal is now recognised after the head of an `if` / `while` / `for`
  / `with` and after a `}`, a postfix `++` / `--` keeps the next `/` a
  division, and a lone CR, U+2028 and U+2029 end a line as in JavaScript.
  A script whose quote, regex, template, `${` or block comment is never
  closed, or whose script field the read did not return at all, is reported
  as "script not fully scanned" and turns a pass into `warn` in all five scan
  checks (`secret-in-scripts`, `log-leftovers`, `deprecated-apis`,
  `hardcoded-identifiers`, `client-script-safety`); a hit still fails or
  warns as before, with the note appended. `secret-in-scripts` now matches an
  identifier that ends in a secret name (`db_password`, `apiToken`,
  `clientSecret`, `password2`), a quoted key (`{"password": "…"}`,
  `cfg['api_key'] = '…'`, new pattern id `quoted-key-assign`) and a literal
  `Basic …` / `Bearer …` header value (new pattern id `auth-header-value`).
  Behaviour change: these checks can now return `warn` where they passed
  before. Rows of `sys_ui_action` whose instance does not return
  `client_script` now warn until RR-22 settles that field.

- **Delivery checks fail closed** (RR-66, DEL-1, DEL-2, DEL-5, DEL-6, DEL-7,
  DEL-10, DEL-13) — several delivery gates passed on reads that proved
  nothing. `atf-run` now fails a suite that reports success with no result id
  (`no-result-id`), with zero test rows (`no-tests`) or with a security-trimmed
  suite-result or test-result read (`results-trimmed`); a test row whose status
  is neither green, red nor skipped (`cancelled`, `running`, an unknown value)
  fails as `test-unverified` instead of being ignored. Both result reads use
  `queryWithMeta`. `update-set-collisions` fails when `updateSetId` names no
  `sys_update_set` row (`not-found`), warns instead of passing when the target
  set is confirmed empty ("ships nothing"), and warns when target records carry
  no readable name and so could not be compared. `update-set-state` reads
  child sets and changes with `queryWithMeta`: a trimmed read fails (a hidden
  child set may still be in progress) and a zero-row child read without a
  pre-trim count warns. `default-set-leakage` and `remote-set-preview` warn
  (unverified) instead of passing when their zero-row `sys_update_xml` /
  `sys_update_preview_problem` read carries no pre-trim count. Behaviour
  change: these checks can now return `warn` or `fail` where they passed
  before; an instance that sends `X-Total-Count` keeps its passes.

- **Missing-table skip needs a ServiceNow answer** (RR-39, N-2) — any HTTP
  404 from a read was taken for "plugin not installed" and turned the check
  into a `warn` skip, so a wrong instance path or a proxy/gateway 404 could
  skip every check that hit it, the runner catch included. The skip now
  requires the ServiceNow JSON error envelope (`error.message`) on the 404 or
  the "Invalid table" 400; an HTML, plain-text, empty or non-envelope body
  stays an `error` row. The fake client's forced `http` failures now carry
  that envelope by default, and a new `ForcedFailure.body` sets the body
  (`{ raw: "…" }` for a proxy page, `null` for an empty one). Library users:
  a custom check or test double that throws `new SnHttpError(404, …)` without
  a body no longer gets the skip — pass the envelope as the third argument.

- **The HTTP client validates its numeric options and never prints credential
  bytes** (RR-52, HTTP-4, HTTP-5, HTTP-6, CLI-9) — an oauth token or api key
  with a control character (a token file with an interior newline) or a
  non-Latin-1 character is refused at `createSnClient` with an `SnAuthError`
  that names the field, not the value; a server-issued `access_token` gets the
  same check, and a transport error that quotes the credential header has it
  replaced with `[redacted]`. Before, the transport's "invalid header value"
  message printed the whole secret (HTTP-4). `timeoutMs` (1 to 2147483647),
  `maxRows` and `cicdMaxPolls` (whole numbers from 1) and `cicdPollIntervalMs`
  (0 to 2147483647) are checked at construction and throw `SnError`: a NaN,
  negative or infinite `timeoutMs` threw a raw `RangeError` and then hung the
  next call on a leaked limiter slot, and `maxRows: NaN` turned off the
  truncation cap (HTTP-5, HTTP-6). The request timeout signal is now built
  inside the block that frees the slot. `--timeout`, `--run-timeout`,
  `SNPF_CHECK_TIMEOUT` and the `runPreflight` budgets refuse values above
  2147483647 ms (about 24.8 days; a longer Node timer fires after 1 ms, so
  every check timed out) and a value that parses to Infinity, which exited `3`
  instead of `2` (CLI-9).

- **Repo-controlled files cannot write outside the repo or redirect
  credentials** (RR-51) — `writeAtomic` (config, init, `--output`, baseline)
  creates its temp file under a random name with `O_EXCL`/`O_NOFOLLOW`, so a
  planted symlink at the old `<path>.<pid>.tmp` name is never written through;
  an existing file keeps its mode (a `0600` file stays `0600`) and the data is
  fsynced before the rename (CFG-2, CFG-7). `writeBaseline` now writes
  atomically too (CLI-19). The trace file is opened with `O_NOFOLLOW` (a
  symlink is exit `2`); `SNPF_TRACE` is read from the real environment only
  (`.env` is ignored with a warning) and must stay inside the working
  directory (CFG-1). A `.env` key in the instance namespace
  (`SNPF_PROD_INSTANCE`, `SNPF_PROD_OAUTH_TOKEN_URL`, `SNPF_PROD_PROXY`, …) no
  longer outranks the same key set unprefixed in the real environment (CFG-3).
  The registry rejects a `url` that does not parse, carries `user:password@`
  or is cleartext `http://` on a non-loopback host, and any credential-looking
  key; `sync` refuses an instance url with userinfo before it reads anything,
  so it never lands in the committed manifest (ST-21). Error messages never
  echo the credential.

- **A run that checks nothing, an empty incremental plan or a foreign baseline
  fails closed** (RR-50, CLI-4, CLI-5, CLI-6, CLI-8) — `run` with no instance
  URL (`--instance ""`, `SNPF_INSTANCE=` or a renamed CI variable) and a
  narrowed `--only` that left out `instance-url-configured` exited `0`, as did
  `--severity instance-url-configured=warn`. Now, under CI, no instance URL is
  exit `2` before any check runs (even with `--allow-no-auth`); outside CI the
  report gets a `preflight:instance` runner `fail` row unless
  `instance-url-configured` already failed. `--changed-since` against an
  update set or scope that does not exist read as "no changes" and passed:
  the update set is now looked up first, a missing set or unresolved scope
  marks the change set `missing` (`ChangeSet.missing`), every check runs and
  the `preflight:incremental` row fails; a plan with nothing left to run is a
  `fail` row too. A baseline recorded against one instance was applied to
  any other: `--write-baseline` now records the instance origin as `url`, and
  a baseline whose `instance` or `url` differs from the run's target is a
  usage error (`assertBaselineTarget`, and `applyBaseline`'s new `target`
  argument). `--write-baseline` returned before `--fail-on warn` was applied,
  so the recording run exited `0` on an unaccepted warning; it now keeps the
  exit code.
- **Runner rows are never baselined or demoted; a missing core table is an
  error** (RR-49, CLI-1, CLI-2, CLI-3, CLI-17) — every HTTP 404 (or 400
  "Invalid table") read was a "plugin not installed" skip `warn`, so a wrong
  instance path or a proxy answering 404 gave a green run that verified
  nothing. A baseline recorded and later accepted the runner's own rows
  ("No checks matched", a timeout, a thrown error), and `--severity
<check>=warn` demoted a timed-out, aborted or crashed check to `warn`. A
  check could also return a result under another check's name, or one
  without a `message`, and it was taken as given. Now the runner watches each
  check's table reads: a missing table the check does not list in the new
  `meta.optionalTables` makes its row `error` (`atf-enablement` lists
  `sys_atf_agent`, `portal-roles` lists `sp_widget` and `sp_page`). Timeout,
  abort, thrown-error and malformed-result rows carry `kind: "runner"`;
  `applyPolicy` leaves them as they are, and `baselineFromReport` /
  `applyBaseline` skip them and every row under a reserved name (`preflight`,
  `preflight:*`, `baseline`). A returned result always takes the check's
  name, and one without a `message` string is a runner `fail`. Library users:
  a custom check that skips on a missing plugin table must now list that
  table in `meta.optionalTables`.
- **Drift fails closed on empty, malformed or duplicate-id manifests** (RR-48,
  ST-2, ST-3, ST-4, ST-11) — `test-drift` passed with "all 0 active test(s)
  exist" when the source manifest was empty or all-inactive; `loadManifest`
  read a missing or non-array `tests`/`suites` field as an empty list and
  silently dropped malformed `apps` entries; two tests with one logical `id`
  collapsed into one in drift's index, so the missing one never blocked; and
  an empty source app list made `app-version-parity` pass having compared
  nothing. Now `test-drift` fails when the source has no active test, and
  `computeDrift(...).ok` is `false` in that case. `loadManifest` rejects
  (exit `2`) a missing or non-array `tests`/`suites`, a non-array `apps`, an
  app entry without a non-empty string `id` or with an empty `name`/`version`,
  and duplicate test or suite ids. `computeDrift` throws on a duplicate id
  (the runner records `fail`), `mergeManifest` (and so `sync`) throws when
  reconciliation would write one — a renamed test plus a new test with its
  old name — and an empty source app list `warn`s.
- **`sync` fails closed on a partial ATF read** (RR-47, ST-1, ST-5, ST-19) —
  a proven security-trim was acted on only when the whole snapshot was empty
  over a non-empty manifest, so a re-sync that saw 1 of 3 tests silently
  dropped two, and a first sync that saw 0 of 50 wrote an empty manifest. The
  suite→test link read had no trim signal at all, and a test row without a
  readable `active` value was recorded as inactive, so drift never blocked on
  it. Now any trimmed test, suite or link read, and any test without a
  `"true"`/`"false"` `active` value, throws the new `IncompleteSnapshotError`
  (`table`, `reason`) from `pullManifest` and `syncManifest` (exit `3`,
  nothing written); `--allow-empty` does not override it. A trimmed empty
  snapshot now raises this error instead of `EmptySnapshotError`, whose
  `securityTrimmed` is therefore always `false`.
- **An empty or low `X-Total-Count` no longer ends pagination** (RR-46,
  HTTP-1) — an empty header was read as `0` and a count below the rows already
  delivered was trusted, so a 2500-row table came back as its first 1000 rows
  with `securityTrimmed: false` and no other signal. Only a plain digit run is
  a count now (`""`, `1e3`, `+5` are absent), and once the rows delivered
  exceed the count the header is dropped: the walk goes on by page length,
  `totalCount` is reported as unknown, and the row cap still fails closed.
- **An unresolved scope fails the run** (RR-45, ACL-1, ACL-22) — a scope with
  no `sys_scope` row (a typo such as `x_acme_ap`) made every scope-bound read
  match nothing, so 18 of the 20 scope-bound checks passed with "nothing to
  check". `runPreflight` now looks at the scope lookup the checks shared (no
  extra read) and, when it found no row, puts a `preflight` `fail` row first in
  the report. A lookup that failed is still reported by each check.
  `cross-scope-privileges` now fails instead of warning on an unresolved
  scope. Checks called directly keep their own fallback.
- **The no-credentials guard covers every common CI system** (RR-37) — the
  RR-4 guard (no credentials under CI is exit `2`) read only `CI`, which Azure
  Pipelines, Jenkins, TeamCity and Buildkite do not set, so a missing secret
  there was still an all-warn green run. `TF_BUILD`, `JENKINS_URL`,
  `TEAMCITY_VERSION` and `BUILDKITE` now count as CI too (same rule: anything
  but empty, `0` or `false`), and the message names the variable it found
  (`... and TF_BUILD is set.`). `--allow-no-auth` still opts out. Inverting the
  local default (fail without credentials everywhere) is left for 2.0.

- **Release and CI gates fail closed** (RR-69, REL-1/5/6/7) —
  `ci/certification/scan.sh` exited with the blocker count, which wraps at
  256, so 256 blockers exited `0` and passed the gate; it now exits `1` on any
  blocker (the count stays in the summary and the JUnit `failures`). Its
  per-file rules word-split the file list and silently skipped a path with a
  space; the list is now read line by line. The composite action used at a
  commit SHA, a major tag or a branch ran `servicenow-preflight@latest`; it now
  runs the version in the action's own `package.json` and fails with exit `2`
  when that is not a valid version (`version: latest` still opts in). The
  release workflow published every version, a `1.0.0-rc.1` included, as
  `latest`; a prerelease now goes to the `next` dist-tag. The certification
  workflow template pins `actions/checkout` and `actions/upload-artifact` to
  commit SHAs.

- **`table().get()` fails closed on a 2xx body without a record** (RR-38) —
  `get` returned `null` ("no such record") for any 2xx answer whose `result`
  was missing, `null`, an array or a scalar, so a proxy or gateway answering
  with its own JSON under status 200, or an empty body, read as a missing
  record. It now throws `SnResponseError` naming the table and the body shape,
  as list reads do since RR-7. A 404 still resolves to `null`. The test fake's
  `get` now rejects its returned promise on a forced failure instead of
  throwing synchronously, as the real client does.

- **`--changed-since` no longer skips checks on an ACL-trimmed change read**
  (RR-10) — the update set, `sys_update_xml` and `sys_metadata` reads carried
  no trim signal, so a CI account that could not see every change narrowed the
  run to the visible tables and skipped exactly the checks covering the hidden
  ones. The reads now use `queryWithMeta`: a security-trimmed read, or a
  zero-row read without `X-Total-Count`, runs every check, with a stderr line
  that names the table. `ChangeSet` gains `trimmed` and `ambiguous`. Scope mode
  still does not see deletions (`sys_metadata_delete`); the README states it.

- **A baselined finding whose message changed is no longer demoted** (RR-9)
  — a baseline entry matched on check and status alone, so when the message
  moved (for example three new hard-coded secrets joined an accepted one) the
  row was still rewritten to `warn` and the run passed. Such a row now keeps
  its status with a `Baseline does not match (changed since …)` prefix, so it
  gates again until the baseline is re-recorded. Accepted rows carry
  `kind: "baseline"`, and `--fail-on warn` exempts rows by that marker instead
  of a message prefix a check could produce itself.

- **The post-policy / post-baseline summary fails closed on unknown statuses**
  (RR-8) — `applyPolicy`, `applyBaseline` and the CLI's incremental path
  recomputed the summary with a second counter that turned an unrecognised
  status into a `NaN` bucket and a vacuous `ok: true`. They now use the same
  `summarizeResults` as `runPreflight`, so such a row is reported as `fail`
  and the run is not ok. A severity policy no longer remaps an unrecognised
  status to its level; it only remaps `fail` / `warn` rows, as documented.

- **A 2xx Table API body without a `result` array fails closed** (RR-7) — the
  client used to coerce a missing or non-array `result` into zero rows, so a
  proxy or gateway answering with its own JSON under status 200 read as an
  empty table and checks could pass against data they never saw. Table list
  reads (`query`, `queryWithMeta`, every auto-paginated page) now throw
  `SnResponseError` naming the table and the body shape; an empty 200 body is
  treated the same way. A genuine `{"result": []}` is still an empty table.

- **The test fake evaluates `sysparm_query`** (RR-2b) — `createFakeSnClient`
  used to return every seeded row whatever the query said, so a check that
  built a wrong query still passed its tests. It now selects rows through one
  strict encoded-query interpreter (`^NQ`, then `^`, then `^OR`; `=`, `!=`,
  `IN`, `STARTSWITH`, `LIKE`, `ISEMPTY`, `ISNOTEMPTY`, `RELATIVEGE`, `ORDERBY`,
  `ORDERBYDESC`, `^EQ`) that throws `FakeQueryError` on anything else. Fixtures
  must seed every column a query filters on; the new `now` fixture anchors
  relative dates, and `queryFilter` is left for fault injection, running on the
  rows the query already selected. The per-test matchers are gone.

- **Auto-pagination no longer stops on a security-trimmed short page**
  (RR-1) — ServiceNow cuts the offset window before it drops ACL-denied rows,
  so a page can come back short while later windows still hold readable rows.
  When `X-Total-Count` is present the client now walks every window up to that
  count instead of breaking on the first short page; `query()` callers no
  longer silently lose the rows after it. Without the header a short page still
  ends the walk, and the row cap still fails closed.
- **Test fake raises auth errors like the real client** (RR-2) — the in-memory
  `createFakeSnClient` turned a forced HTTP 403 into a plain `SnHttpError`,
  while `SnClient` raises `SnAuthError` for 401 and 403. Check tests therefore
  pinned a `warn` verdict on a forbidden table that production reports as
  `fail`. `fail: { http: 401 | 403 }` now raises `SnAuthError` with the same
  message shape and diagnosis as the client (a 403 names the table), a new
  `fail: { forbidden: true }` mode spells out the 403 case, and a parity suite
  runs 401, 403, 404, exhausted 429, 500 and a network error through both the
  fake and the real client.
- **`drift` verdict is fail-closed** — results folded into a `drift` report
  (promotion order, manifest staleness, version parity) are now summarised by
  the same rule as `runPreflight`: an unrecognised status counts as a failure
  instead of a pass, so it can no longer yield `ok: true` on the promote gate.
- **Tessera review digests survive a CRLF checkout** (PA-10) — `tess review`
  and `tess run --live` now read a unit spec through one canonical form,
  `canonicalSpecBody` (exported from `@tessera/cli`), which folds every run
  of CRs ending in an LF to one LF and touches nothing else. The folded text
  is what the TM-3 gate inspects, what the digest covers and what the ATF
  step executes, so a body reviewed on an LF checkout still matches on a
  `core.autocrlf` checkout and the digest still covers exactly what runs. A
  lone CR, a BOM, trailing whitespace and the Unicode form still change the
  digest. Reviews recorded before this change over a body that contained
  CRLF no longer match and must be recorded again.
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

- **No raw interpolation in any `sysparm_query`** (RR-40) — `doctor` built its
  `sys_user` lookup as a template literal (`user_name=${name}`), guarded only by
  a local charset check. It now goes through the encoded-query builder
  (`eqUserName`: the identifier charset plus `@` and `+`), so a user name with
  `^`, `=` or `%` never reaches the query and the account row reports it as
  unreadable. The ATF result read in `sync` joins its `ORDERBYDESC` clause with
  `and()` instead of a template literal. No behaviour change for valid names.
- **Credentials are not sent over cleartext `http:`** (RR-11, SEC-7;
  **breaking** for runs against an `http://` instance with credentials) —
  `createSnClient` refused nothing, so an `http://` instance URL sent basic
  auth, bearer tokens and API keys in clear text, with only a check warning
  after the fact. With auth or mTLS configured, an `http:` URL to a
  non-loopback host is now refused before any request (CLI exit `2`) with a
  message naming the origin. `--allow-insecure-http`, `SNPF_ALLOW_INSECURE_HTTP=1`
  or the library option `allowInsecureHttp: true` accepts the risk; it is
  deliberately not a config-file key. `localhost`, `127.0.0.0/8` and `[::1]`
  stay exempt.
- **Scheme-less and malformed instance URLs** (RR-11, DX-4) — a bare host in
  `--instance`, `SNPF_INSTANCE` or the config `instanceUrl` (for example
  `dev12345.service-now.com`) now gets `https://` with a one-line note; it
  used to fail later with exit `3`. Any other malformed value, or a scheme
  other than `http`/`https`, exits `2` with
  `Instance URL must be https://<host> (got "...")`, userinfo masked. A
  malformed `instanceUrl` passed to `createSnClient` is an `SnError` instead of
  a `TypeError`.

- **Tessera TM-3 gate validates and caps declared Script Include targets**
  (`@tessera/generate`, PA-10) — a spec's `sys_script_include` target names
  come from the manifest and become constructible classes in the AST
  allowlist. Each name must now be a plain ASCII JavaScript identifier of at
  most `MAX_TARGET_CLASS_NAME_CHARS` (100) characters that is not an ES5
  reserved word, and a spec may declare at most `MAX_TARGET_CLASS_NAMES` (16)
  distinct targets. Either breach refuses the whole body fail-closed
  (`ast-target-name-invalid`, `ast-too-many-targets`), so `run --live` and
  `tess review` refuse the spec. Before, a malformed name was silently ignored
  and the count was unbounded. Findings never quote the name. Both constants
  are exported.
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
- **Tessera's template provider keeps a blank `promptHash` pin, now
  documented** (AIS-6) — the field is the hash of the frozen instruction
  channel and the template sends none, so any other value would be refused by
  the benchmark's drift check. A template run's manifest provenance records
  the rendered prompt's full hash, never the provider's blank pin (now
  tested). `tess benchmark --provider anthropic` wires no egress policy, so it
  fails closed with `EgressRefusedError` before any request is sent.

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
