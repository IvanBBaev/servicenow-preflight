import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendOutputs, appendSummary } from "../build/ci/github-env.js";

const report = (ok, pass, warn, fail) => ({
  ok,
  results: [],
  summary: { pass, warn, fail },
});

test("github-env helpers do nothing outside GitHub Actions", () => {
  assert.equal(appendSummary({}, "# x"), false);
  assert.equal(appendSummary({ GITHUB_STEP_SUMMARY: "  " }, "# x"), false);
  assert.equal(appendOutputs({}, [report(true, 1, 0, 0)]), false);
});

test("github-env helpers append a summary and summed outputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-ghenv-"));
  try {
    const env = {
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      GITHUB_OUTPUT: join(dir, "output"),
    };
    assert.equal(appendSummary(env, "# one"), true);
    assert.equal(appendSummary(env, "# two\n"), true);
    assert.equal(
      readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"),
      "# one\n# two\n",
    );
    assert.equal(
      appendOutputs(env, [report(true, 2, 1, 0), report(false, 3, 0, 4)]),
      true,
    );
    assert.equal(
      readFileSync(env.GITHUB_OUTPUT, "utf8"),
      "ok=false\npass=5\nwarn=1\nfail=4\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
