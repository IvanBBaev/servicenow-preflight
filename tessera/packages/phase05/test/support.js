// Shared harness for the @tessera/phase05 suites.
//
// Every adapter in this package reaches the instance through the module-level
// `tableApi`/`snRequest` singletons of `@tessera/sn-client` (ARCH-7/18: the
// client is bound to ONE instance by the environment). There is no transport to
// inject, so a test stands up `@tessera/fake-instance`, swaps its `fetch` into
// `globalThis`, and writes the environment the client reads — which is exactly
// what `@tessera/cli` does in production.
//
// `SN_DOCS_DIR` is staged for one more reason than the rest. The vendored
// transport journals every applied write (DEV-15), and `getDocsDir()` falls
// back to `docs/instance` relative to the CURRENT WORKING DIRECTORY. Unset,
// `createS5TestStore().teardown()`'s DELETE calls (exercised in
// `testStore.test.js`) therefore append rows to `phase05/docs/instance/` in
// the source tree on every run — fixture traffic accumulating in the one audit
// surface that has no external cross-check, in a row format with no field
// that could mark it as synthetic. Pointing it at a fresh temp directory per
// harness is what every other suite that drives this transport already does
// (`sn-client/test/httpWrite.test.js`, `runner-atf/test/client.test.js`,
// `cli/test/*.test.js`). Containment is asserted from the outside in
// `journal-containment.test.js`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import { seedS5Instance } from "../build/tier2.js";

/** Allowlisted and heuristic-clean; see `tier2.ts`'s `FAKE_HOST`. */
export const HOST = "dev-skeleton.service-now.com";

/** Everything `@tessera/sn-client` reads out of the environment. */
const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH",
  "SN_DOCS_DIR",
  "SN_READONLY",
  "SN_ACTIVE_PROFILE",
  "SN_ALLOWED_HOSTS",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
];

/**
 * @param {object} [options]
 * @param {Record<string, Record<string, unknown>[]>} [options.state]
 *   Raw seed state. Defaults to the reviewed S5 seed.
 * @param {object} [options.seed] Options forwarded to `seedS5Instance`.
 */
export function harness(options = {}) {
  const fake = createFakeInstance({
    host: HOST,
    state: options.state ?? seedS5Instance(options.seed ?? {}),
  });
  const restoreFetch = fake.install();

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const docsDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "tessera-phase05-journal-"),
  );
  process.env.SN_INSTANCE = HOST;
  process.env.SN_USER = "tessera";
  process.env.SN_PASSWORD = "tessera";
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = docsDir;
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  delete process.env.SN_TABLES_ALLOW;
  delete process.env.SN_TABLES_DENY;
  reloadCredentialsFromEnv();

  return {
    fake,
    docsDir,
    restore() {
      restoreFetch();
      fs.rmSync(docsDir, { recursive: true, force: true });
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

/** A `PipelineContext` with no live abort — enough for the adapters below. */
export function context(overrides = {}) {
  return {
    runId: "run-test-0001",
    lifecycle: "ephemeral",
    coverageSource: "test",
    topology: { source: "one", target: "one", runner: "one" },
    signal: new AbortController().signal,
    ...overrides,
  };
}
