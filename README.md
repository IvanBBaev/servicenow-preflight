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

## License

[MIT](LICENSE) © Ivan Baev
