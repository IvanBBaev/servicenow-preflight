// Staging the process for a run — the ONLY module that writes `process.env`.
//
// `@tessera/sn-client` is vendored and reads its instance and credentials from
// the environment (ARCH-7/18), so something has to write them. That something
// is the composition root and nowhere else: every module below this one is pure
// with respect to the environment, which is what lets the test suite run two
// differently-configured runs in the same process without them colliding.
//
// Everything staged is undone in reverse order by `restore()`, including the
// credential-store snapshot. A run that throws still restores (the caller uses
// `finally`), because a leaked SN_INSTANCE would silently retarget the next one.
//
// Moved from the Phase-0.5 skeleton CLI. One deliberate change since: the
// DEV-15 docs directory is staged for EVERY run rather than only for `--fake`
// (see `docsAnchor`), which is what keeps the vendored cwd-relative default out
// of reach of this command.
//
// Two entry points, one rule. `stage()` is the whole harness; `stageDocsDir()`
// stages the DEV-15 docs directory and nothing else, for a command that writes
// to an instance without needing a ledger, a fake or an ambient instance
// binding. Both live here because the rule is about the MODULE: a second
// `process.env` write anywhere else would end the purity every other module
// below the composition root depends on.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { discoverConfigFile, readTextFileSync } from "@tessera/config";
import { installAtfExecutionEngine, seedS5Instance } from "@tessera/phase05";
import type { S5Variant } from "@tessera/phase05";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";
// Type-only: erased at compile time, so the dev-only package still never enters
// the production module graph. The runtime import is the checked URL below.
import type * as FakeInstanceModule from "@tessera/fake-instance";

export interface StageOptions {
  readonly instanceHost: string;
  readonly ledgerRoot?: string;
  readonly docsDir?: string;
  /** Tier-2: run against `@tessera/fake-instance` (QA-18). Dev only. */
  readonly fake: boolean;
  readonly variant: S5Variant;
  readonly fakeProductionProperty: boolean;
  readonly keepLedger: boolean;
  /**
   * Default `true`: bind `SN_INSTANCE` to `instanceHost` (the skeleton's one
   * ambient instance). `tess run --live` passes `false` — it binds every adapter
   * to an explicit §2a profile (`topology.ts`), and an ambient instance would be
   * fighting that binding, exactly as it would for `tess preflight` (delegated
   * decision 2026-09-23, TODO "run --live"). Ignored under `fake`.
   */
  readonly bindAmbientInstance?: boolean;
}

export interface Harness {
  /** Undo everything staged: the global `fetch`, the environment, temp dirs. */
  restore: () => void;
  ledgerRoot: string;
  /**
   * Whether that directory was already on disk before staging touched it.
   *
   * Answerable only here, and only before the `mkdirSync` below — which is why
   * it is reported rather than recomputed. It is also the one fact the run
   * report needs in order to say whether the command created a directory in the
   * caller's filesystem: `ledgerRoot` alone is a path, and a path is true
   * either way. Under MCP the cwd belongs to whichever host launched the
   * server, so "we made a `.tessera/` here" is a side effect the caller never
   * asked for and could not otherwise learn about.
   */
  ledgerRootPreexisted: boolean;
}

/** The one directory name the DEV-15 journal is written under, per project. */
export const DOCS_DIR_NAME = "sn-docs";

/**
 * The §4b ledger root's directory name, under the caller's cwd.
 *
 * Named once because `stageDocsDir` needs the same answer without creating
 * anything: a command with no ledger still has to agree with `stage()` about
 * where an unconfigured project's journal lives, and two literals would drift.
 */
const LEDGER_DIR_NAME = ".tessera";

/**
 * Where an unconfigured DEV-15 write journal is rooted — the PROJECT, not the
 * directory `tess` happened to be invoked from.
 *
 * The vendored transport's own default is `path.resolve(process.cwd(),
 * "docs/instance")` (`sn-client/src/core/settings.ts`), and it is vendored under
 * ADR-002, so it cannot be edited. It does not have to be: the default only
 * applies when `SN_DOCS_DIR` is unset, so staging it here makes the default
 * unreachable from this command. Two things about that default are wrong for a
 * project-wide audit trail, and both are fixed by anchoring rather than by
 * changing the name:
 *
 *   * It follows the cwd. Run from the repo root and from `packages/foo` and
 *     you get TWO journals, neither naming the other, with no error and no
 *     warning — `appendWriteJournal` catches everything into `logger.warn`.
 *     Two journals of one code base is not a partial audit trail; it is an
 *     audit trail that cannot be read at all, because no reader can know the
 *     other one exists. That has already happened in this repository.
 *   * `docs/instance` is a plausible directory name in a ServiceNow project, so
 *     an audit trail landed inside the user's own source tree under a name that
 *     looks like documentation they wrote.
 *
 * The anchor is the first of: the directory holding the discovered
 * `tessera.config.json` (the only marker of "this project" that does not move
 * when the caller cd's), then the ledger root, then — reachable only if a
 * caller passes no ledger root and the default one is not computed from `cwd`,
 * which it always is — the cwd itself, i.e. the behaviour this replaces.
 *
 * Discovery reads the file rather than stat-ing it, because that is the one
 * function that already defines "the project's config file" (`@tessera/config`)
 * and a second definition here would be a second answer to the same question.
 * An unreadable config file therefore throws, exactly as it does for every
 * command that resolves config — "present but unreadable" is a fault the
 * operator has to hear about, not an absence.
 */
function docsAnchor(cwd: string, ledgerRoot: string): string {
  const discovered = discoverConfigFile(cwd, readTextFileSync);
  return discovered === undefined ? ledgerRoot : path.dirname(discovered.path);
}

export interface DocsDirOptions {
  /** `--docs-dir` / `TESSERA_DOCS_DIR` as the caller resolved it, if at all. */
  readonly docsDir?: string;
  /** The caller's working directory — never `process.cwd()` (ARCH-1). */
  readonly cwd: string;
  /**
   * The anchor of last resort, used only when no `tessera.config.json` is
   * discovered above `cwd`. `stage()` passes the ledger root it has just
   * created; a caller with no ledger omits it and gets the path one WOULD have
   * had, so both commands answer "where does an unconfigured project's journal
   * live" the same way without either of them putting a directory on disk.
   */
  readonly fallbackRoot?: string;
}

/**
 * Stage `SN_DOCS_DIR` and hand back the undo. The whole of the docs-dir half of
 * `stage()`, and the only copy of it.
 *
 * Exported because `tess preflight --mode apply` performs real instance
 * mutations, and the vendored transport journals every one of them (DEV-15,
 * `sn-client/src/core/http.ts`) under whatever `getDocsDir()` reads at the
 * moment of the write. `preflightCommand` staged nothing at all, so its journal
 * went to the vendored cwd-relative default — the second journal `docsAnchor`
 * describes above, one of which is still on disk in this repository. It also
 * made `--docs-dir` a flag the command parsed, echoed back to the operator with
 * its provenance, and then never read.
 *
 * Why preflight cannot just call `stage()` — this is the "simplification" the
 * next reader will reach for, and each of these is a side effect preflight
 * would be acquiring for nothing:
 *
 *   * `stage()` creates or adopts a ledger root with `mkdirSync`, and may
 *     register an `rmdirSync` undo for it. Preflight has no §4b ledger; a
 *     `.tessera/` in the caller's cwd is exactly the litter that directory
 *     lifetime was written to prevent.
 *   * `stage()` sets `SN_INSTANCE`. Preflight binds its writer explicitly
 *     (`bindWriter(…, runner.profile)`) precisely so no ambient instance
 *     decides where a write lands; an ambient one would be fighting it.
 *   * `stage()` reloads the credential store, which preflight has not touched.
 *
 * A relative `docsDir` is resolved against the CALLER's `cwd` rather than left
 * to the vendored `getDocsDir()`, which resolves against `process.cwd()` — the
 * same divergence `docsAnchor` exists to close, and under MCP `process.cwd()`
 * is the host's directory, not the caller's.
 */
export function stageDocsDir(options: DocsDirOptions): () => void {
  const explicit = options.docsDir?.trim();
  const docsDir =
    explicit === undefined || explicit === ""
      ? path.join(
          docsAnchor(
            options.cwd,
            options.fallbackRoot ?? path.join(options.cwd, LEDGER_DIR_NAME),
          ),
          DOCS_DIR_NAME,
        )
      : path.resolve(options.cwd, explicit);

  const previous = process.env["SN_DOCS_DIR"];
  process.env["SN_DOCS_DIR"] = docsDir;
  // Absent restores to absent. Writing back `""` would not be a restoration:
  // the vendored `getDocsDir()` treats a blank value as unset and falls to its
  // own default, so the next reader in this process would silently get the
  // cwd-relative journal this function exists to keep out of reach.
  return () => {
    if (previous === undefined) delete process.env["SN_DOCS_DIR"];
    else process.env["SN_DOCS_DIR"] = previous;
  };
}

/**
 * A command-line mistake the caller can fix, as opposed to a DEV-1 fault.
 * `cli.ts` matches it by `name` (exit 2), like every other structural check
 * there, because the error may cross a package boundary.
 */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Seams for {@link resolveDevFakeInstance}; the defaults are the real ones. */
export interface DevFakeResolution {
  /**
   * Resolves a bare specifier to a module URL. Default: `import.meta.resolve`
   * from THIS module, i.e. exactly what a bare dynamic `import()` here would
   * load.
   */
  readonly resolve?: (specifier: string) => string;
  /**
   * The URL this module has on disk; the cli package root is its parent's
   * parent (`<cli>/build/stage.js`). Default: `import.meta.url`.
   */
  readonly moduleUrl?: string;
}

const FAKE_INSTANCE_SPECIFIER = "@tessera/fake-instance";

const devOnly = (why: string): UsageError =>
  new UsageError(
    `--fake is development-only: it runs against ${FAKE_INSTANCE_SPECIFIER}, ` +
      "which is loaded only from the Tessera dev workspace this cli was built " +
      `in and is not shipped with the published package (${why})`,
  );

/**
 * The file URL `--fake` may load `@tessera/fake-instance` from — or a
 * {@link UsageError}. Fail-closed.
 *
 * Delegated decision 2026-09-26 (W6b finding 2): a bare
 * `import("@tessera/fake-instance")` resolves through ANY ancestor
 * `node_modules`. The release staging (scripts/stage-tessera.mjs) leaves the
 * package out on purpose, so from the published tree that lookup reaches
 * whatever copy happens to sit above the install — stale, or planted — and
 * that module would stand in for the instance under test. So resolution is
 * honoured only when BOTH hold:
 *
 *   1. this cli is a workspace member: its package root is
 *      `<ws>/packages/<dir>` and `<ws>/package.json` declares `workspaces`
 *      (the staged copy lives at `…/node_modules/@tessera/cli` and fails here,
 *      whatever sits beside it);
 *   2. the resolved module's REALPATH lies inside `<ws>/packages/fake-instance/`
 *      — compared by path segment, so neither a symlink out of the workspace
 *      nor a `fake-instance-evil` sibling passes.
 *
 * The caller imports the returned URL, never the bare specifier, so the module
 * that was checked is the module that is loaded.
 */
export function resolveDevFakeInstance(seams: DevFakeResolution = {}): string {
  const moduleUrl = seams.moduleUrl ?? import.meta.url;
  const resolve =
    seams.resolve ?? ((specifier: string) => import.meta.resolve(specifier));

  let cliRoot: string;
  try {
    cliRoot = realpathSync(fileURLToPath(new URL("../", moduleUrl)));
  } catch {
    throw devOnly("the cli package root could not be located");
  }
  const packagesDir = path.dirname(cliRoot);
  const workspace = path.dirname(packagesDir);
  if (
    path.basename(packagesDir) !== "packages" ||
    !declaresWorkspaces(workspace)
  ) {
    throw devOnly("this cli is not running from inside a Tessera workspace");
  }

  let expectedRoot: string;
  let resolvedFile: string;
  try {
    expectedRoot = realpathSync(path.join(packagesDir, "fake-instance"));
    const resolved = resolve(FAKE_INSTANCE_SPECIFIER);
    resolvedFile = realpathSync(
      resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved,
    );
  } catch {
    throw devOnly(`${FAKE_INSTANCE_SPECIFIER} is not present in the workspace`);
  }
  if (!resolvedFile.startsWith(expectedRoot + path.sep)) {
    throw devOnly(
      `${FAKE_INSTANCE_SPECIFIER} resolved to ${resolvedFile}, outside ${expectedRoot}`,
    );
  }
  return pathToFileURL(resolvedFile).href;
}

/** Whether `<dir>/package.json` parses and declares a non-empty npm `workspaces` array. */
function declaresWorkspaces(dir: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    ) as { readonly workspaces?: unknown };
    const { workspaces } = manifest;
    return Array.isArray(workspaces) && workspaces.length > 0;
  } catch {
    return false;
  }
}

/** Test seams for {@link stage}; production passes none. */
export interface StageSeams {
  readonly fakeInstance?: DevFakeResolution;
}

/**
 * `--fake` additionally builds `@tessera/fake-instance` and installs the Tier-2
 * ATF execution engine over its `fetch`. The import is dynamic so the dev-only
 * dependency never enters the production module graph — nothing outside this
 * branch can reach it — and it goes through {@link resolveDevFakeInstance},
 * which refuses (a {@link UsageError}) before anything at all is staged.
 */
export async function stage(
  options: StageOptions,
  cwd: string,
  seams: StageSeams = {},
): Promise<Harness> {
  // Delegated decision 2026-09-26: checked FIRST, so a refused `--fake` leaves
  // no temp ledger root, no environment write and no installed `fetch` behind.
  const fakeInstanceUrl = options.fake
    ? resolveDevFakeInstance(seams.fakeInstance)
    : undefined;
  const undo: (() => void)[] = [];
  const setEnv = (key: string, value: string | undefined): void => {
    const previous = process.env[key];
    undo.push(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  const ledgerRoot =
    options.ledgerRoot ??
    (options.fake
      ? mkdtempSync(path.join(tmpdir(), "tessera-skeleton-"))
      : path.join(cwd, LEDGER_DIR_NAME));
  // Whether the directory is ours to remove has to be answered BEFORE we
  // create it — afterwards the question is unanswerable.
  const ledgerRootPreexisted = existsSync(ledgerRoot);
  mkdirSync(ledgerRoot, { recursive: true });
  if (options.ledgerRoot === undefined && options.fake && !options.keepLedger) {
    undo.push(() => rmSync(ledgerRoot, { recursive: true, force: true }));
  } else if (
    options.ledgerRoot === undefined &&
    !options.fake &&
    !ledgerRootPreexisted
  ) {
    // A REFUSED run must leave nothing on disk. Staging happens before any
    // gate: `runPipeline` asserts §11.5 runner-writability at its very first
    // statement and refuses concurrent runs next, both *before* `openRun()` —
    // so a refusal is not a rare path to a stray `.tessera/`, it is the most
    // likely one. It matters more than it looks: under MCP the cwd is the
    // host's, wherever it happened to launch the server, so the litter lands
    // in a directory the caller never chose. The tool contract used to say a
    // refusal writes nothing; this is what makes that true rather than a
    // wording problem.
    //
    // Removed only if BOTH: we created it (an existing `.tessera/` is someone
    // else's data — possibly a ledger from an earlier run this process must
    // not touch), and it is still empty at restore time. A run that reached
    // `openRun` has written its §4b write-ahead ledger into it, and that
    // record must outlive the process: it is what makes a crashed run
    // recoverable, so removing it would destroy the guarantee the ledger
    // exists to provide. Emptiness is the exact test for "did anything get
    // written", and it is the one signal available here without importing the
    // pipeline's outcome across the ARCH-1 boundary.
    //
    // `rmdirSync` non-recursively rather than reading the directory and then
    // deciding: the syscall's own ENOTEMPTY *is* the emptiness check, so there
    // is no window between the test and the removal in which a concurrent run
    // could write. Both failure modes are correct outcomes, not errors —
    // ENOTEMPTY means the ledger is real and must stay, ENOENT means something
    // already removed it — so both are swallowed.
    undo.push(() => {
      try {
        rmdirSync(ledgerRoot);
      } catch {
        // Intentionally empty; see above. Neither case is recoverable from
        // here and neither is a failure of the run being restored.
      }
    });
  }

  // ALWAYS set, `--fake` or not. It used to be staged only under `--fake`,
  // which meant the one case that matters — a real run, writing to a real
  // instance, producing the audit trail of writes that actually happened — was
  // the case that fell through to the vendored cwd-relative default. See
  // `docsAnchor` for what that default does to a journal.
  //
  // Delegated rather than inlined so `tess preflight`, which needs this one
  // variable and none of the rest of the harness, cannot end up with a second
  // answer to the same question. Its undo joins the same reverse-ordered list.
  undo.push(
    stageDocsDir({ docsDir: options.docsDir, cwd, fallbackRoot: ledgerRoot }),
  );

  if (fakeInstanceUrl !== undefined) {
    const { createFakeInstance } = (await import(
      fakeInstanceUrl
    )) as typeof FakeInstanceModule;
    const fake = createFakeInstance({
      host: options.instanceHost,
      state: seedS5Instance({
        variant: options.variant,
        productionProperty: options.fakeProductionProperty,
      }),
    });
    undo.push(installAtfExecutionEngine(fake));

    // Credentials the fake ignores but the transport insists on.
    setEnv("SN_INSTANCE", options.instanceHost);
    setEnv("SN_USER", "tessera");
    setEnv("SN_PASSWORD", "tessera");
    setEnv("SN_AUTH", "basic");
    setEnv("SN_ACTIVE_PROFILE", undefined);
    // DEV-24: the fake IS the instance under test, so a stray SN_READONLY in
    // the developer's shell must not silently turn the run into a no-op.
    setEnv("SN_READONLY", undefined);
  } else if (options.bindAmbientInstance !== false) {
    setEnv("SN_INSTANCE", options.instanceHost);
  }
  if (options.fake || options.bindAmbientInstance !== false) {
    // The credential store snapshots the environment on first read; the run
    // has just rewritten it.
    reloadCredentialsFromEnv();
    undo.push(() => void reloadCredentialsFromEnv());
  }

  return {
    ledgerRoot,
    ledgerRootPreexisted,
    restore: () => {
      for (const step of [...undo].reverse()) step();
    },
  };
}
