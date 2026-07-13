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
- Version parity in the promote gate: `sync` now captures the instance's
  platform identity (`glide.buildname`/`glide.war`) and installed apps/plugins
  with versions; `drift` adds `instance-version-parity` (release-family
  mismatch fails, patch skew warns) and `app-version-parity` (missing or
  downgraded apps on the target fail). Manifests from older versions degrade
  to an advisory warning.
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

- README restructured quickstart-first; documentation site data refreshed.
- The published package now ships source maps and an `exports`-map default plus
  a `./package.json` subpath.
- All GitHub Actions are pinned to full commit SHAs; the release workflow gained
  a tag-ancestry guard and a `release` environment.

### Fixed

- Checks no longer report a false pass on zero-visible-rows (ACL trimming),
  reference-object field values, update-set batch child trees, or partial i18n
  coverage.
- HTTP client: non-JSON 2xx responses, mTLS and stream errors, OAuth error
  bodies, redirect and poll-budget limits, and token-refresh races are handled
  explicitly instead of failing open.
- State layer: manifest writes are atomic, slug and scope collisions are
  guarded, and an all-empty snapshot is refused unless `--allow-empty` is given.

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
