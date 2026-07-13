# servicenow-preflight

<!-- badges:start -->

| [![node](https://img.shields.io/badge/node-%3E%3D20-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/servicenow-preflight/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/servicenow-preflight/actions/workflows/ci.yml) | [![last commit](https://img.shields.io/github/last-commit/IvanBBaev/servicenow-preflight?style=flat-square&logo=git&logoColor=white&label=last%20commit)](https://github.com/IvanBBaev/servicenow-preflight/commits/main) | [![built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org) |
| :-------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------: |

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
! update-set-state: No update set configured (set updateSetId in the config); skipping.
! default-set-leakage: No target scope set (PreflightContext.scope); nothing to verify — skipping the Default-set leakage check.
✓ remote-set-preview: No pending retrieved update sets on the target instance — nothing awaiting preview or commit.
✓ atf-enablement: ATF test execution is enabled ("sn_atf.runner.enabled" is "true").
! atf-run: No ATF suite configured (set options.atfSuites); skipping.
! scoped-app-deps: No required apps declared (set options.requiredApps); skipping.
! i18n-completeness: No target scope set; skipping.
! acl-role-sanity: No scope set; skipping.

4 passed, 6 warnings, 0 failed
```

Two identical binaries ship — `servicenow-preflight` and the alias `snpf`. Out
of the box only the checks that need no target-specific input do real work; the
rest turn on once you supply their inputs (a scope, an update set, ATF suite
ids, required apps) via a [config file](#configuration-file). The CLI **exits
non-zero on any `fail`**, so it drops straight into a pipeline before a
promote/deploy step.

## What it checks

`runPreflight(ctx, checks?)` runs each check against the target instance and
aggregates a single `PreflightReport` (`ok`, `results`, `summary`). Ten checks
ship in the default suite; the CLI is a thin wrapper over that function.

| Check                     | Needs                        | Verifies                                                                                                                                                   |
| ------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance-url-configured` | —                            | An instance URL is present and well-formed (prefers `https`).                                                                                              |
| `connectivity-auth`       | credentials                  | The instance is reachable and the credentials authenticate.                                                                                                |
| `update-set-state`        | `updateSetId`                | The target update set, and any batched child sets, are `complete` and non-empty (not in-progress or `ignore`d).                                            |
| `default-set-leakage`     | `scope`                      | No captured work is stranded in a "Default"-flagged update set for the scope — changes that would never ship.                                              |
| `remote-set-preview`      | credentials                  | Every pending retrieved update set on the target is previewed with all preview problems resolved (`updateSetId`, when set, focuses the gate on one set).   |
| `atf-enablement`          | credentials                  | ATF test execution is enabled instance-wide (optionally also an online scheduled client test runner, via `options.atfEnablement.requireClientTestRunner`). |
| `atf-run`                 | `options.atfSuites`          | Configured ATF test suites run green (no failing or errored tests).                                                                                        |
| `scoped-app-deps`         | `options.requiredApps`       | Required scoped apps / plugins are installed, active, and meet any `minVersion`.                                                                           |
| `i18n-completeness`       | `scope`, `options.languages` | Every configured language has full translation coverage for the scope.                                                                                     |
| `acl-role-sanity`         | `scope`                      | No wide-open mutating ACLs, and no ACLs referencing non-existent roles.                                                                                    |

Checks whose only need is credentials always run once credentials are present;
the rest `warn` (and explain what's missing) until you supply their inputs —
they never silently pass. Each check returns one status —
`pass` (`✓`, holds), `warn` (`!`, advisory), or `fail` (`✗`, blocks). **Only a
`fail` fails the run**; warnings never do. Checks never throw (transport/auth/API
errors map to a result), and are read-mostly (the sole write is running the ATF
suites you configure).

**Exit codes:** `0` when no check `fail`ed; `1` when a check `fail`ed, when a
selection matched zero checks (nothing verified — treated as a failure, never a
vacuous pass), or when the CLI hit an unexpected runtime error; `2` for a usage
error — a bad invocation or config caught before any check runs (unknown option,
invalid `--format` value, malformed `--max-age`, missing required argument).

## CLI

```bash
snpf [run] [env] [options]     # run checks (default subcommand)
snpf sync <env> [options]      # pull ATF metadata → state manifest
snpf drift <src> <dst>         # compare two instances (promote gate)
```

Both `--flag value` and `--flag=value` forms are accepted.

| Flag                      | Description                                                                    |
| ------------------------- | ------------------------------------------------------------------------------ |
| `-i`, `--instance <url>`  | Target instance URL (single-instance, no registry).                            |
| `-e`, `--env <name>`      | Select a registry instance (same as positional).                               |
| `--all`                   | `run`: sweep every instance in the registry.                                   |
| `--registry <path>`       | Registry file (default `.preflight/instances.json`).                           |
| `--config <path>`         | Config file (default: auto-discovered).                                        |
| `--only` / `--skip <csv>` | Run only / skip these checks (comma-separated names).                          |
| `--with-last-run`         | `sync`: also pull each test's most recent result.                              |
| `--allow-empty`           | `sync`: commit an empty snapshot over a non-empty manifest.                    |
| `--max-age <dur>`         | `drift`: fail if a compared manifest is older than `<dur>` (e.g. `7d`, `24h`). |
| `--format <fmt>`          | `pretty` (default), `json`, `junit`, `sarif`.                                  |
| `--json` / `-h`           | Shorthand for `--format json` / show help.                                     |

`--instance`, `--only` and `--skip` override the matching config-file values. The
`scope` and `updateSetId` a run targets come from the config file (or the
programmatic context), **not** from CLI flags.

## Credentials & auth

Credentials are read from the **environment only** — never from the config file,
never logged, never placed into an error message. The tool covers the full range
of ServiceNow inbound-auth methods, plus transport-level mutual TLS:

| Method                     | `kind`           | Environment inputs                                          | Applied as                    |
| -------------------------- | ---------------- | ----------------------------------------------------------- | ----------------------------- |
| Basic                      | `basic`          | `SNPF_USER` + `SNPF_PASS`                                   | `Authorization: Basic …`      |
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

> **A note on token lifetimes.** A static `SNPF_TOKEN` bearer is convenient, but
> on a real instance it is usually an OAuth **access token** carrying the
> platform-default **1800-second (30-minute) TTL** — so in a CI pipeline it is
> reliably _expired_ by the time the job runs. For anything unattended, prefer a
> **grant flow** (which mints a fresh token each run) or an **API key**
> (`SNPF_API_KEY`), which is not on that 30-minute cadence. Note too that
> `oauth-client` (the client-credentials grant) is **Vancouver+ only** and
> requires the OAuth registry record (`oauth_entity`) to be bound to an
> integration user — without that binding the grant returns no token.

Beyond the matrix inputs: `SNPF_INSTANCE` sets the URL when `--instance`/config
is unset; `SNPF_AUTH` forces a method; JWT claims come from `SNPF_OAUTH_JWT_KID`
/ `_SUB` / `_AUD` / `_ISS` (or supply a pre-signed `_ASSERTION`). Any PEM / key /
assertion variable accepts an **`@path` value** (read from that file, e.g.
`SNPF_MTLS_KEY=@./certs/client.key`); a missing `@`-file is a hard error reported
with the path only, never contents.

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
automatically, but **real environment variables always win** over it. With no
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

| Field         | Type                                   | Used by                                                                             |
| ------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `instanceUrl` | `string`                               | Target instance (CLI `--instance` overrides).                                       |
| `scope`       | `string`                               | `default-set-leakage`, `i18n-completeness`, `acl-role-sanity`.                      |
| `updateSetId` | `string` (sys_id)                      | `update-set-state`; also focuses `remote-set-preview` on that set's retrieved copy. |
| `select`      | `{ only?: string[]; skip?: string[] }` | Check selection (CLI flags override).                                               |
| `options`     | `object`                               | Per-check options (`atfSuites`, `requiredApps`, `languages`, `baseLanguage`, …).    |

## Multi-instance: registry, sync & drift

A single `--instance` URL is fine for a one-off check. Real deployments move a
change through a pipeline — `dev → staging → test → prod` — and what you want to
guarantee is that a promote never drops validated coverage. That is what the
**registry**, `sync` and `drift` add on top of the single-instance `run`. It is
**opt-in**: with no `.preflight/instances.json`, the tool behaves as before.

The **registry** (`.preflight/instances.json`) is a committed description of the
instances a project targets and the order they promote in — it holds **no
credentials**. Each instance needs a `url`; `promotesTo` chains the pipeline (or
`null` for the terminal stage); the optional `scope`, `stage` and `envPrefix`
refine per-instance behaviour.

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
  versions, feeding the parity gates below.
- **`drift <src> <dst>`** compares two committed manifests **offline** by logical
  `id`. A test **active upstream but missing downstream** fails the gate (exit 1)
  — it would ship a promote without coverage upstream has validated. Extra tests
  downstream `warn`; a fully-covered target `pass`es. Only _active_ source tests
  can block. Two **version-parity** results ride along: `instance-version-parity`
  fails on a release-family mismatch (`glide.buildname`) and warns on patch-level
  skew (`glide.war`); `app-version-parity` fails when an app or plugin installed
  on the source is missing or older on the target. Manifests written by older
  versions of the tool (no identity/app data) degrade to an advisory `warn`,
  never a crash.

```bash
snpf sync staging                 # commit the two manifests, then gate the promote
snpf sync prod
snpf drift staging prod           # exit 1 if staging has active tests prod lacks
snpf run prod                     # only if the gate passes
```

## Report formats

Selected with `--format` (or `--json`):

- **`pretty`** _(default)_ — human-readable lines (`✓ / ! / ✗`) plus a summary.
- **`json`** — the full `PreflightReport` (`ok`, `results[]`, `summary`) as
  pretty-printed JSON.
- **`junit`** — a JUnit XML document with **one `<testcase>` per check**: `fail`
  → `<failure>`, `warn` → a passing case with a `<system-out>` note, `pass` → an
  empty passing case. XML-1.0-illegal control characters are stripped and the five
  entities escaped, so arbitrary ATF output can't break the document.
- **`sarif`** — a SARIF 2.1.0 log with **one result per non-`pass` check** (`fail`
  → `error`, `warn` → `warning`) for code-scanning dashboards.

```bash
snpf --format junit > preflight-junit.xml
snpf --format sarif > preflight.sarif
snpf --json | jq '.summary'
```

## CI integration

`servicenow-preflight` exits non-zero on failure, so a single step gates a
pipeline. This GitHub Actions job runs the checks and uploads the SARIF log to
code scanning:

```yaml
name: ServiceNow preflight
on: [workflow_dispatch, pull_request]

jobs:
  preflight:
    runs-on: ubuntu-latest
    permissions:
      security-events: write # to upload SARIF
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Run preflight
        env:
          SNPF_INSTANCE: ${{ secrets.SNPF_INSTANCE }}
          SNPF_USER: ${{ secrets.SNPF_USER }}
          SNPF_PASS: ${{ secrets.SNPF_PASS }}
        run: npx servicenow-preflight --format sarif > preflight.sarif
      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: preflight.sarif
```

Store credentials as CI secrets — the tool only ever reads them from the
environment.

## Library API

The public surface is [src/index.ts](src/index.ts); everything below is exported
from the package root.

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

- **`runPreflight(ctx, checks?)`** → `Promise<PreflightReport>`. Defaults to
  `defaultChecks`; `ctx.select` (only / skip by name) filters before they run.
- **`selectChecks`**, **`defaultChecks`**, and each individual check
  (`instanceUrlConfigured`, `connectivityAuth`, …) are exported to compose your
  own list.
- **`createSnClient(config)`** → `SnClient` (`{ instanceUrl, auth?, tls?,
timeoutMs?, cicdPollIntervalMs?, cicdMaxPolls? }`), backed by Node's global
  `fetch` (or `node:https` when `tls` is set). `table(name).query()`
  **auto-paginates** unless you pass a `sysparm_limit`.
- **`formatJUnit`** / **`formatSarif`**, and **`loadConfig`** /
  **`resolveAuthFromEnv`** / **`resolveTlsFromEnv`** (the CLI's own resolution).

Checks _always_ call `ctx.http`, never `fetch` directly, so `createFakeSnClient`
(an in-memory `SnClient`) unit-tests them with no network — seed table rows and
CI/CD responses, or force error surfaces with the `fail` fixture. Client helpers
throw a small typed hierarchy (all extend `SnError`) that checks map to results;
secrets never appear in the messages:

| Error            | Raised when                                                |
| ---------------- | ---------------------------------------------------------- |
| `SnAuthError`    | HTTP 401 / 403, or missing credentials (`.status`).        |
| `SnNetworkError` | DNS / connection failure / timeout — instance unreachable. |
| `SnHttpError`    | Any other non-2xx status (`.status`, `.body`).             |

To add your own check, implement the `Check` interface (a `run(ctx)` returning a
`CheckResult`, catching every `ctx.http` error) and pass a custom list to
`runPreflight`, or register it in `defaultChecks` under [src/checks/](src/checks/).

## Development

```bash
npm install
npm run build        # tsc -> build/
npm test             # node --test (run AFTER build — tests import from build/)
npm run verify       # build + lint + format:check + test
npm run check        # verify + coverage (the full local gate)
```

ESM (`"type": "module"`) with TypeScript `Node16` resolution — relative imports
carry the `.js` extension. Prettier: `semi`, double quotes, `trailingComma: all`.
Tests (`test/**/*.test.js`) import compiled output from `build/`, **so build
before testing**.

## Security

- Credentials are read from the **environment only** — never from the config
  file, never logged, never included in error messages.
- Checks are **read-mostly**: the only write is _running_ the ATF suites you
  explicitly configure via `options.atfSuites`.
- Zero runtime dependencies — the entire supply chain is this package plus Node.

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
