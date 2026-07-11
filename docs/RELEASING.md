# Releasing `servicenow-preflight`

This project publishes to npm from CI when a `v*` tag is pushed. The golden
rule is **tag last**: the tag must point at a commit whose `package.json` (and
every other piece of published metadata) is already correct on `main`.

## Why tag-last matters (OPS-6)

The publish workflow (`.github/workflows/release.yml`) checks out the **tag**,
not `main`. Whatever the tagged commit is missing, npm is missing. In v0.5.0
the `homepage` fix landed _after_ the tag, so the published package's
`homepage` lagged `main`. This kind of drift **self-heals at the next release**
as long as you follow the flow below — no back-fix needed.

## The release flow

1. Land every change (including any `package.json` metadata edits) on `main`
   through a PR, and make sure CI is green on `main`.
2. From an up-to-date `main` working copy, bump the version, commit, and tag in
   one atomic step with `npm version`:

   ```sh
   git switch main && git pull
   npm version patch   # or: minor | major | <exact-version>
   ```

   `npm version` writes the new version into `package.json`, regenerates
   `package-lock.json`, creates the commit, and creates the annotated tag —
   **the tag is created last, after the version commit.** This is exactly the
   ordering that prevents the OPS-6 drift and keeps the lockfile root version
   in sync (OPS-7).

3. Push the commit and the tag:

   ```sh
   git push --follow-tags
   ```

4. The `Release` workflow runs and publishes. It refuses to publish if:
   - the tagged commit is **not reachable from `main`** (OPS-1 ancestry guard),
   - the tag name doesn't match `package.json` version,
   - the `prepublishOnly` gate (`npm run check`: build + lint + format +
     coverage) fails.

## Supply-chain guarantees in the pipeline

- **Ancestry guard (OPS-1):** a `v*` tag on a commit that never reached `main`
  (e.g. pushed with a leaked token straight onto an arbitrary commit) is
  rejected before publish.
- **`release` environment (OPS-1):** the publish job runs in the `release`
  deployment environment. Configure required reviewers / wait timers in repo
  Settings → Environments → `release`.
- **SHA-pinned actions (OPS-4):** every action is pinned to a full commit SHA
  with a version comment; Dependabot (`.github/dependabot.yml`) bumps the pins.
- **Provenance (OPS-2):** `npm publish --provenance` publishes a signed build
  provenance attestation (needs `id-token: write`, already set).

## Migrating to OIDC Trusted Publishing (OPS-2) — sequenced with npmjs.com

The workflow still authenticates with the long-lived `NPM_TOKEN` secret. To
remove that standing credential:

1. On npmjs.com, configure this repo + `release.yml` as a **Trusted Publisher**
   for the `servicenow-preflight` package.
2. Only **after** step 1 is live, delete the `NODE_AUTH_TOKEN` env from the
   publish step in `release.yml` **and** delete the `NPM_TOKEN` repo secret.

The workflow change and the npmjs.com setup must land together; until then the
token stays so releases keep working. `--provenance` already works with the
token, so provenance is not blocked on this migration.

## Settings-side checklist (not enforceable from the repo files)

- npm Trusted Publishing configured (then delete `NPM_TOKEN`).
- A `v*` tag ruleset restricting who may create release tags.
- Required reviewers on the `release` environment.
- `enforce_admins` enabled on `main` branch protection.
- Signed release tags (`git tag -s`) with signature verification.
- Delete the dangling `CODECOV_TOKEN` secret (nothing references it).
