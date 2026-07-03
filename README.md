# servicenow-preflight

<!-- badges:start -->

| [![node](https://img.shields.io/badge/node-%3E%3D20-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/servicenow-preflight/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/servicenow-preflight/actions/workflows/ci.yml) | [![last commit](https://img.shields.io/github/last-commit/IvanBBaev/servicenow-preflight?style=flat-square&logo=git&logoColor=white&label=last%20commit)](https://github.com/IvanBBaev/servicenow-preflight/commits/main) | [![built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org) |
| :-------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------: |

<!-- badges:end -->

Pre-deployment **preflight checks** for ServiceNow — validate a target instance
and your changes before you ship. Ships as both a **CLI** and a small
**library** you can embed in your own tooling.

> Independent, community-built project. Not affiliated with, endorsed by, or
> sponsored by ServiceNow, Inc.

## Install

```bash
npm install servicenow-preflight
```

Requires Node.js >= 20 (developed and tested on 22).

## CLI

```bash
# via npx
npx servicenow-preflight --instance https://dev12345.service-now.com

# short alias, JSON output
snpf -i https://dev12345.service-now.com --json
```

Options:

| Flag                     | Description                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `-i`, `--instance <url>` | Target ServiceNow instance URL                               |
| `--config <path>`        | Path to a config file (default: auto-discovered — see below) |
| `--only <csv>`           | Run only these checks (comma-separated check names)          |
| `--skip <csv>`           | Skip these checks (comma-separated check names)              |
| `--format <fmt>`         | Output format: `pretty` (default), `json`, `junit`, `sarif`  |
| `--json`                 | Shorthand for `--format json`                                |
| `-h`, `--help`           | Show help                                                    |

The process exits `1` when any check returns `fail`, so it drops straight into a
CI gate. Warnings do not fail the run.

Credentials are read from the **environment only** (never from the config file,
never logged):

| Variable                  | Auth used                            |
| ------------------------- | ------------------------------------ |
| `SNPF_TOKEN`              | OAuth bearer token (wins over Basic) |
| `SNPF_USER` + `SNPF_PASS` | Basic auth                           |
| `SNPF_INSTANCE`           | Instance URL (if `--instance` unset) |

A `.env` file in the working directory is loaded automatically; real environment
variables take precedence over `.env` entries.

### Checks

| Name                      | What it verifies                                                                 |
| ------------------------- | -------------------------------------------------------------------------------- |
| `instance-url-configured` | An instance URL is present and well-formed (`https`).                            |
| `connectivity-auth`       | The instance is reachable and the supplied credentials authenticate.             |
| `update-set-state`        | The target update set is complete, non-empty, and free of merge collisions.      |
| `atf-run`                 | Configured ATF test suites run green (no failing or errored tests).              |
| `scoped-app-deps`         | Required scoped apps / plugins are installed, active, and meet any `minVersion`. |
| `i18n-completeness`       | Every configured language has full translation coverage for the scope.           |
| `acl-role-sanity`         | No wide-open mutating ACLs and no ACLs referencing non-existent roles.           |

Run a subset by name:

```bash
snpf -i https://dev12345.service-now.com --only connectivity-auth,update-set-state
snpf -i https://dev12345.service-now.com --skip atf-run
```

### Config file

The CLI auto-discovers `preflight.config.json`, `preflight.config.js`, or
`preflight.config.mjs` in the working directory (or point at one with
`--config`). It declares the target, check selection, and per-check options —
but **never credentials**.

```json
{
  "instanceUrl": "https://dev12345.service-now.com",
  "scope": "x_acme_app",
  "updateSetId": "a1b2c3d4e5f6...",
  "select": { "skip": ["atf-run"] },
  "options": {
    "languages": ["de", "fr"],
    "requiredApps": [{ "id": "x_acme_lib", "minVersion": "2.1.0" }],
    "atfSuites": ["<suite_sys_id>"]
  }
}
```

CLI flags override the config file: `--instance`, `--only`, and `--skip` win over
the corresponding config values.

### Report formats

`--format junit` emits a JUnit XML document (one `<testcase>` per check; `fail`
becomes a `<failure>`, `warn` a passing case with a `<system-out>` note) suitable
for CI test-report ingestion. `--format sarif` emits a SARIF 2.1.0 log (one
result per non-pass check; `fail` → `error`, `warn` → `warning`) for code-scanning
dashboards.

```bash
snpf -i https://dev12345.service-now.com --format junit > preflight-junit.xml
snpf -i https://dev12345.service-now.com --format sarif > preflight.sarif
```

## Library

`runPreflight(ctx, checks?)` runs the checks and returns an aggregate report.
The context requires an injected HTTP client (`ctx.http`) — use `createSnClient`
for a real instance, or `createFakeSnClient` in tests. Checks always call
`ctx.http`, never `fetch` directly.

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
});

console.log(report.ok, report.summary); // e.g. false { pass: 2, warn: 4, fail: 1 }
```

Filter checks with `ctx.select` (or the exported `selectChecks`), and render a
report with `formatJUnit` / `formatSarif`:

```ts
import { runPreflight, formatSarif } from "servicenow-preflight";

const report = await runPreflight({
  http,
  select: { only: ["connectivity-auth"] },
});
const sarif = formatSarif(report);
```

Write your own check by implementing the `Check` interface and passing a custom
list to `runPreflight`:

```ts
import { runPreflight, type Check } from "servicenow-preflight";

const myCheck: Check = {
  name: "my-check",
  description: "Describe what this verifies.",
  async run(ctx) {
    const rows = await ctx.http.table("sys_user").query({ sysparm_limit: "1" });
    return {
      name: "my-check",
      status: "pass",
      message: `saw ${rows.length} row(s)`,
    };
  },
};

await runPreflight({ instanceUrl: "...", http }, [myCheck]);
```

## Development

```bash
npm install
npm run build        # tsc -> build/
npm test             # node --test (run after build)
npm run lint         # eslint
npm run format       # prettier --write
npm run check        # build + lint + format:check + coverage
```

Source lives in [src/](src/); the public API surface is
[src/index.ts](src/index.ts) and checks live under
[src/checks/](src/checks/). Tests (`test/**/*.test.js`) import the compiled
output from `build/`, so build before testing.

## Support

This project is built and maintained in my own time. If it saves you or your
team time, please consider supporting its continued development — sponsorship
directly funds new features, fixes and maintenance.

- **[GitHub Sponsors](https://github.com/sponsors/IvanBBaev)** — one-off or
  recurring, with no platform fee taken out (the preferred option).
- **[Ko-fi](https://ko-fi.com/ivanbbaev)** — quick one-off support; it also
  accepts **PayPal**, so it's the fallback for anyone without a GitHub account.
- **[Donate (Donatree)](https://donatr.ee/ivanbbaev/)** — a no-account donation
  page (card, PayPal and more) for a one-off tip.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/ivanbbaev)
[![Donate via Donatree](https://img.shields.io/badge/Donate-Donatree-22c55e?style=flat-square&logo=liberapay&logoColor=white)](https://donatr.ee/ivanbbaev/)

## License

[MIT](LICENSE) © Ivan Baev
