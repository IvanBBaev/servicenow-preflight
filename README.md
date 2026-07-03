# servicenow-preflight

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

# short alias
snpf -i https://dev12345.service-now.com --json
```

Options:

| Flag                     | Description                    |
| ------------------------ | ------------------------------ |
| `-i`, `--instance <url>` | Target ServiceNow instance URL |
| `--json`                 | Emit the report as JSON        |
| `-h`, `--help`           | Show help                      |

The process exits `1` when any check fails, so it drops straight into a CI gate.

## Library

```ts
import { runPreflight, defaultChecks } from "servicenow-preflight";

const report = await runPreflight({
  instanceUrl: "https://dev12345.service-now.com",
});

console.log(report.ok, report.summary); // true { pass: 1, warn: 0, fail: 0 }
```

Write your own check by implementing the `Check` interface and passing a custom
list to `runPreflight`:

```ts
import { runPreflight, type Check } from "servicenow-preflight";

const myCheck: Check = {
  name: "my-check",
  description: "Describe what this verifies.",
  run(ctx) {
    return { name: "my-check", status: "pass", message: "all good" };
  },
};

await runPreflight({ instanceUrl: "..." }, [myCheck]);
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
[src/checks/](src/checks/).

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
