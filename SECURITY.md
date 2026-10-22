# Security policy

## Supported versions

| Version                              | Supported                          |
| ------------------------------------ | ---------------------------------- |
| 0.5.x (latest release on npm)        | Yes                                |
| `main` (the 1.0.0 train, unreleased) | Yes — fixes land here first        |
| older 0.x                            | No — upgrade to the latest release |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/IvanBBaev/servicenow-preflight/security/advisories/new)
("Report a vulnerability" on the repository's **Security** tab). Include the
version, the command or API call, what you expected and what happened, and — if
you can — a minimal reproduction. Never include real instance credentials or
customer data; use placeholders.

This is a personal project maintained in spare time. You can expect an
acknowledgement within a week; a fix or a mitigation plan follows once the
report is confirmed. Credit is given in the advisory unless you ask otherwise.

## Scope

In scope:

- credential handling (the `SNPF_*` and `SN_*` variables, the credential store,
  OAuth / mTLS flows) — leaks into logs, error messages, reports or files;
- a write to a ServiceNow instance that the documentation says is read-only, or
  a write that bypasses the Tessera role split (`--source` / `--runner` /
  `--target`) or the target guard;
- the Tessera `generate` path: instance content reaching the LLM provider
  unclassified, or generated test code escaping the `proposed/` review step;
- the `tessera-mcp` server: a tool doing more than its description says;
- the published npm tarball (unexpected files, install-time scripts).

Out of scope: vulnerabilities in ServiceNow itself, in Node.js, or in a
configuration where the user deliberately grants broader access (for example
pointing `--runner` at a production instance).

## Design notes

- Credentials are read from the environment or the credential store only —
  never from a config file — and are never logged.
- The preflight checks are read-mostly; the only write is running the ATF
  suites you configure. Tessera writes only to the `--runner` instance and
  records every write in a local journal.
- There are no runtime npm dependencies. The bundled Tessera tree
  (`build/tessera/`) vendors one third-party package, `acorn` 8.18.0 (MIT),
  and the staging script refuses any other.
