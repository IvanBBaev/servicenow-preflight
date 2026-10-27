/**
 * GitHub Actions integration (F-X-16): append the markdown report to the job's
 * step summary and the run's verdict to the step outputs. Both read their
 * target files from an injected `env`, never from `process.env` directly, and
 * do nothing outside Actions (when the variable is unset).
 */
import { appendFileSync } from "node:fs";
import type { PreflightReport } from "../types.js";

/** The environment the helpers read `GITHUB_STEP_SUMMARY` / `GITHUB_OUTPUT` from. */
export type GitHubEnv = Readonly<Record<string, string | undefined>>;

/**
 * Append `markdown` to the file `GITHUB_STEP_SUMMARY` names. Returns whether
 * it wrote anything.
 */
export function appendSummary(env: GitHubEnv, markdown: string): boolean {
  const path = env.GITHUB_STEP_SUMMARY?.trim();
  if (!path) return false;
  appendFileSync(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return true;
}

/**
 * Append `ok=`, `pass=`, `warn=` and `fail=` lines (summed over `reports`) to
 * the file `GITHUB_OUTPUT` names, in GitHub's `key=value` env-file format.
 * Returns whether it wrote anything.
 */
export function appendOutputs(
  env: GitHubEnv,
  reports: readonly PreflightReport[],
): boolean {
  const path = env.GITHUB_OUTPUT?.trim();
  if (!path) return false;
  const total = { pass: 0, warn: 0, fail: 0 };
  for (const { summary } of reports) {
    total.pass += summary.pass;
    total.warn += summary.warn;
    total.fail += summary.fail;
  }
  const ok = reports.every((r) => r.ok);
  appendFileSync(
    path,
    `ok=${ok}\npass=${total.pass}\nwarn=${total.warn}\nfail=${total.fail}\n`,
  );
  return true;
}
