# ServiceNow scoped-app certification gate

A self-contained, reusable pre-submission gate for **ServiceNow scoped
applications**. It encodes the reviewer findings that ServiceNow Store
certification raises again and again into a checklist plus an automatable text
scanner, so an app clears review the first time instead of bouncing on the
recurring issues.

This directory is a **drop-in kit**: nothing here is wired into
`servicenow-preflight`'s own CI. Copy the pieces you want into the repo that
holds your exported scoped-app artifacts (`*.xml` / `*.js` update-set or
source-control exports).

## What's here

| File                     | What it is                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHECKLIST.md`           | The human gate — Tier 1–7 rules, each with _what_ to check, _why_, a detection grep, and a ❌/✅ example. Read it once; use it as the sign-off list before submitting.                                                                |
| `scan.sh`                | The machine gate — text-scans `*.xml`/`*.js` for the automatable subset of the checklist. Emits `cert-report.txt` + `cert-junit.xml`; exit code = number of blocking violations. Zero dependencies (POSIX `sh` + `grep`/`sed`/`git`). |
| `github-workflow.yml`    | GitHub Actions workflow that runs `scan.sh` on push / PR (blocking job + non-blocking advisory job).                                                                                                                                  |
| `pre-commit-config.yaml` | [pre-commit](https://pre-commit.com) config that runs the same `scan.sh` locally before each commit.                                                                                                                                  |

## Install into a scoped-app repo

Copy the kit under `ci/certification/`, then wire up whichever entry points you
use:

```
your-scoped-app-repo/
├─ ci/certification/
│  ├─ CHECKLIST.md
│  └─ scan.sh            # chmod +x
├─ .github/workflows/
│  └─ certification.yml  # ← copy of github-workflow.yml
└─ .pre-commit-config.yaml   # ← copy of pre-commit-config.yaml
```

1. **Scanner:** copy `scan.sh` to `ci/certification/scan.sh` and
   `chmod +x ci/certification/scan.sh`.
2. **CI (optional):** copy `github-workflow.yml` to
   `.github/workflows/certification.yml`. GitHub only runs workflows under
   `.github/workflows/`, so the copy here stays inert until you move it.
3. **Local hook (optional):** copy `pre-commit-config.yaml` to
   `.pre-commit-config.yaml` at the repo root, then `pre-commit install`. Both
   the hook and CI call the same `scan.sh`, so local and server results never
   drift apart.

## Run it manually

```bash
# scan the whole tree
ci/certification/scan.sh --mode all

# only the blocking (Tier 1/2) rules — exit code = blocker count
ci/certification/scan.sh --mode blocking

# scan just what changed against a base commit (used by CI on PRs)
ci/certification/scan.sh --mode blocking --diff origin/main
```

## Scope and limits

The scanner is a **heuristic triage**: a grep hit means "review this", not a
certain defect, and a clean run is not a certification guarantee. Metadata-level
rules — ACL coverage, Coalesce on transform maps, homepage `Order`, Scheduled
Job **Run as**, mobile menus, the install log — cannot be seen in exported text
and are **not** covered here. Use an ATF suite, a Platform-IQ / Instance Scan,
or the live-instance checks in `servicenow-preflight` for those. `CHECKLIST.md`
marks which rules the scanner automates and which need a live instance.
