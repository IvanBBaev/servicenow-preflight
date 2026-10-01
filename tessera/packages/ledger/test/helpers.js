// Shared fixtures for the @tessera/ledger suites. Not a `*.test.js`, so the
// runner never executes it directly.
//
// Every suite drives a REAL temp directory: the whole point of this package is
// what survives `kill -9`, and an in-memory fs would test the wrong thing.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIntentLedger } from "../build/index.js";

/** A fresh temp root, removed when the test finishes (pass or fail). */
export function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), "tessera-ledger-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * A ledger over a fresh temp root. `clock` is a mutable box so a suite can
 * advance time without sleeping.
 */
export function newLedger(t) {
  const rootDir = tempRoot(t);
  const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
  const ledger = createIntentLedger({
    rootDir,
    now: () => clock.now,
  });
  return { rootDir, ledger, clock };
}

/** A second ledger instance over the same root — i.e. a restarted process. */
export function reopen(rootDir, now) {
  return createIntentLedger(now === undefined ? { rootDir } : { rootDir, now });
}

export const RUN = {
  scope: "x_tess_demo",
  runner: "https://runner.example.service-now.com",
  lifecycle: "ephemeral",
};

/** Open a run and move it out of `planned`, where writes are not yet allowed. */
export async function openProvisioning(ledger, runId, overrides = {}) {
  await ledger.openRun({ runId, ...RUN, ...overrides });
  await ledger.transition(runId, "provisioning");
  return runId;
}

/** A well-formed create intent: unknown sys_id, so it carries a QA-25 probe. */
export function createIntent(runId, key, overrides = {}) {
  return {
    runId,
    instance: RUN.runner,
    intent: "project sys_atf_test",
    target: { table: "sys_atf_test" },
    compensation: { op: "delete", table: "sys_atf_test" },
    idempotencyKey: key,
    probe: {
      table: "sys_atf_test",
      query: `nameSTARTSWITHtess-${runId}`,
      key: "run-id-prefix",
    },
    ...overrides,
  };
}

/**
 * A well-formed §11.4 `acknowledge-prod` input — the WHOLE fact.
 *
 * It lives here rather than inline because the payload gained instance, role,
 * cls, evidence and surface on 2026-08-31: until then the guard wrote those
 * five to a sibling `guard-audit.jsonl` and only `{reason, actor}` reached this
 * log. Every suite that appends one has to spell all seven fields now, and one
 * fixture is what keeps "which fields make up the fact" from being spelled
 * seven times and drifting.
 */
export function acknowledgeProd(runId, overrides = {}) {
  return {
    kind: "acknowledge-prod",
    runId,
    reason: "hotfix window",
    actor: "ivan",
    instance: { name: "runner", host: RUN.runner },
    role: "runner",
    cls: "prod-suspect",
    evidence: [
      {
        kind: "allowlist-entry",
        effect: "source-of-truth",
        detail: "declared non-prod",
      },
      {
        kind: "production-property",
        effect: "downgrade",
        detail: "glide.installation.production is true",
      },
    ],
    surface: "cli",
    ...overrides,
  };
}

/** An update intent: the `restore` snapshot is captured at intend time. */
export function updateIntent(runId, key, sysId, overrides = {}) {
  return {
    runId,
    instance: RUN.runner,
    intent: "update sys_user",
    target: { table: "sys_user", sysId },
    compensation: {
      op: "restore",
      table: "sys_user",
      sysId,
      fields: { active: "true" },
    },
    idempotencyKey: key,
    ...overrides,
  };
}

export function runDirPath(rootDir, runId) {
  return join(rootDir, "runs", runId);
}

export function ledgerLogPath(rootDir, runId) {
  return join(rootDir, "runs", runId, "ledger.jsonl");
}

export function runStatePath(rootDir, runId) {
  return join(rootDir, "runs", runId, "run.json");
}

export function auditLogPath(rootDir) {
  return join(rootDir, "audit.jsonl");
}
