# Contributing

Thanks for your interest. This is a personal project, so please open an issue
to discuss a larger change before you start on a pull request. Small fixes
(typos, docs, an obvious bug) are welcome straight away.

Security problems: see [SECURITY.md](SECURITY.md) — do not file them as public
issues. Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Node **>= 20** (development and CI use 22, see `.nvmrc`).

```bash
npm install
(cd tessera && npm install)
```

## The gates

The repository holds two npm projects: the shipped package at the root and the
Tessera workspace in [tessera/](tessera/). A change is ready when the gate of
every project it touches is green.

```bash
npm run check                # root: build + lint + format:check + tests with coverage + pack smoke
(cd tessera && npm run check) # Tessera: build + lint + format:check + tests with coverage
```

Tests import the compiled output, so **build before running tests** on their
own (`npm run build && npm test`).
The build compiles into a temporary sibling directory and renames it over
`build/`, so a concurrent run never sees a half-written tree. Coverage floors
in `.c8rc.json` sit one point under the measured values; raise them when
coverage grows, never lower them. Tests must not assert elapsed wall-clock
time: inject a clock (the `CLOCK` seam of `src/http/client.ts`, the limiter's
`now`/`sleep` options) and assert the requested waits.

## Conventions

- ESM (`"type": "module"`), TypeScript with `Node16` resolution — relative
  imports carry the `.js` extension.
- Prettier (`semi`, double quotes, `trailingComma: all`) and the ESLint flat
  config; run `npm run format` before committing. Tessera files are formatted
  from inside `tessera/`.
- Tests use `node --test` and live in `test/**/*.test.js` (root) or
  `tessera/packages/*/test/` (Tessera). Every behaviour change comes with a
  test.
- No runtime dependencies. A new dependency needs a strong reason.
- Never commit credentials, `.env` files or real instance data — use
  placeholders in tests, fixtures and docs.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(cli): …`, `fix(http): …`, `docs: …`), one logical change per commit.

## Adding a preflight check

1. Implement the `Check` interface in `src/checks/` (a `run(ctx)` returning a
   `CheckResult`).
2. Register it in `defaultChecks` (`src/checks/index.ts`).
3. Add a test in `test/` and document it in the README's "What it checks"
   section.
4. Regenerate the site's check catalogue with `npm run build && npm run gen:site`
   (`site/checks.generated.js`); `npm run check` fails while it is stale.

## Licence

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE) of this project.
