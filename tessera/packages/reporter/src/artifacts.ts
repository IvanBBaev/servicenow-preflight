// The QA-11 run-id-keyed artifact directory — what `runPipeline.ts:605` calls
// out as `// SEAM (QA-11): Phase 1 points this at the run-id-keyed artifact
// directory`. This is what the seam points at.
//
// WHY IT MUST EXIST BEFORE TEARDOWN. USER-JOURNEY §10 (lines 345-350): results
// are read from `sys_atf_test_result` and "materialized into the run-id-keyed
// artifact directory *before any deletion*" (DEV-13), because in `ephemeral`
// mode the ATF rows are torn down as soon as they are read. An
// `EvidenceRef { kind: "atf-result", ref: <sys_id> }` written after that
// teardown points at a record that no longer exists — a dangling verdict is
// worse than a missing one, since it reads as evidence. So the payload is
// materialised locally first and `evidence` points HERE.
//
// LAYOUT — `<root>/<runId>/<name>`. No layout convention is mandated anywhere
// in the corpus; this is a choice of this package, stated here so a reviewer
// knows there is no document to check it against. `root` is INJECTED and never
// defaulted to `.tessera` or anything else: the CLI, the MCP server and a test
// each have their own idea of where a run's evidence belongs, and a hardcoded
// root would make the second caller wrong.
//
// PORTABLE REFS. `ArtifactRef.ref` is the path RELATIVE TO `root`, not an
// absolute one. A verdict is copied into a ticket, attached to a CI artifact
// bundle and read on a different machine than the one that produced it; an
// absolute `/Users/…/.tessera/run-7/atf.json` is a fact about one laptop.
// Relative to root, the same reference resolves anywhere the directory is
// unpacked. Separators are normalised to `/` for the same reason.
//
// CONTAINMENT (INJ-1). `name` reaches this module from event data and from
// spec identities, i.e. from the instance. Every write resolves the target and
// refuses anything that is not strictly under the run directory, so no
// `../../.zshrc` and no absolute path can be written through this API. The
// guard is `isUnderPath` (`pathkit.ts`), the segment-wise rule the vendored
// source writer also applies — reimplemented here from its behaviour when this
// package stopped depending on `@tessera/store` (delegated decision 2026-09-23).
// Write and read sides share the one copy, so they cannot drift. Since
// 2026-09-25 the write side also applies the read side's post-`realpath` rule
// (see `ensureContainedParent`): the lexical check alone let a link planted in
// the run directory carry a write outside it.
//
// Writes are atomic: content goes to a `.<pid>.<uuid>.tmp` sibling and is renamed
// into place. Rename is atomic on one filesystem, so a crash mid-write cannot
// leave a truncated artifact that a later reader takes for the real payload.
// The pattern (and `withRetry` around it, `pathkit.ts`) follows the vendored
// store's `writeManifestFile`.
//
// ── THE READ SIDE ───────────────────────────────────────────────────────────
//
// QA-9: UNREADABLE IS NOT EMPTY. A holder of an `ArtifactRef` — a verdict
// renderer, the MCP server, a CI step unpacking the directory — has to tell
// three states apart, and every one of them means something different about
// the run:
//
//   * `missing`    — nothing is at that ref. The evidence was never captured,
//                    or was torn down. The verdict citing it is dangling.
//   * `unreadable` — something IS there and we could not get at it
//                    (permissions, a directory in the artifact's place, a
//                    symlink loop). The evidence may be perfectly good; this
//                    is a fact about the reader, not about the run.
//   * `ok` + zero bytes — the artifact was captured and it is genuinely
//                    empty. That is a real observation about the run.
//
// Collapsing any pair of those into "empty" is the defect QA-9 names: an
// empty rendering of an unreadable artifact reads as "the run produced no
// output", which is a claim the store is in no position to make. So the read
// API returns a DISCRIMINATED RESULT, never `""` and never `null` for an I/O
// error, and `missing`/`unreadable` carry no `value` property at all — there
// is nothing for a careless caller to fall through to.
//
// A fourth outcome exists only on `readJson`: `malformed`, for bytes that are
// present and readable but are not JSON. An empty file lands there too —
// `JSON.parse("")` throws — which is the point: "the artifact is empty" and
// "the artifact holds an empty document" are not the same statement.
//
// CONTAINMENT ON READ (INJ-1). Refs are instance-authored just like names, and
// a read is an exfiltration primitive: `../../../.ssh/id_rsa` rendered into a
// verdict is worse than a write, because the payload leaves the machine. So
// the read path applies the SAME `isUnderPath` rule as the write path, twice:
//
//   1. syntactically, on `path.resolve(root, ref)` — this refuses `..` and any
//      absolute ref, including one aimed at a SIBLING run's directory (a store
//      is scoped to its own run);
//   2. after `realpath`, on the fully symlink-resolved target — because
//      `path.resolve` normalises text and knows nothing about links. This is
//      the same rule, not a second one; only the anchor is canonicalised too,
//      which it must be (`/var` is a symlink to `/private/var` on macOS, so
//      every temp-rooted store would fail a naive comparison).
//
// A refused ref THROWS, exactly as a refused write does. It is not a fourth
// read status: a status can be ignored by a caller, and "this ref tried to
// leave the run directory" must not be ignorable.
//
// Note what (2) does NOT do: it is not a blanket ban on symlinks. A link that
// stays inside the run directory resolves and reads normally. The rule is
// containment; a link is only a problem when it breaks containment.

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { ArtifactRef, RunId } from "@tessera/types";

import {
  createDirRecursively,
  isSafePathComponent,
  isUnderPath,
  pathExists,
  withRetry,
} from "./pathkit.js";

/** What a caller must supply — nothing is defaulted. */
export interface ArtifactStoreOptions {
  /** Directory that holds every run's artifacts. Injected, never assumed. */
  root: string;
  /** The run this store belongs to; becomes the single directory level under `root`. */
  runId: RunId;
}

/**
 * What a reader hands back in: the `ArtifactRef` `put` returned, or just its
 * `.ref` string. Root-relative and `/`-separated either way — a caller never
 * reconstructs an absolute path, which is the whole point of a portable ref.
 */
export type ArtifactRefInput = string | { readonly ref: string };

/** The artifact was read. `value` is the payload — possibly empty, legitimately. */
export interface ArtifactReadOk<T> {
  status: "ok";
  /** The ref as handed in, normalised to its string form. */
  ref: string;
  /** Absolute path the ref resolved to. Diagnostics only. */
  path: string;
  value: T;
}

/** Nothing is at that ref. Distinct from empty, and distinct from unreadable. */
export interface ArtifactMissing {
  status: "missing";
  ref: string;
  path: string;
  /** One line fit for a report. */
  reason: string;
}

/**
 * Something is there and could not be read. NEVER reported for `ENOENT` —
 * only the outcomes we are certain are absent get to say `missing`.
 */
export interface ArtifactUnreadable {
  status: "unreadable";
  ref: string;
  path: string;
  /** The libuv code (`EACCES`, `EISDIR`, `ELOOP`, …), or `UNKNOWN`. */
  code: string;
  reason: string;
}

/** Present and readable, but not the document it claims to be (`readJson`). */
export interface ArtifactMalformed {
  status: "malformed";
  ref: string;
  path: string;
  reason: string;
}

/** Three outcomes, none of which is the others. See the QA-9 note above. */
export type ArtifactReadResult<T> =
  ArtifactReadOk<T> | ArtifactMissing | ArtifactUnreadable;

/** `readJson` adds one: bytes that are present but do not parse. */
export type ArtifactJsonReadResult =
  ArtifactReadResult<unknown> | ArtifactMalformed;

export interface ArtifactStore {
  /** Absolute path of this run's directory: `<root>/<runId>`. */
  readonly dir: string;
  /**
   * Write one artifact and return the reference a `fail`/`error` event or an
   * `EvidenceRef` should carry. `name` may contain `/` to nest, but may not
   * leave the run directory.
   */
  put(
    name: string,
    contents: string | Uint8Array,
    kind: ArtifactRef["kind"],
  ): Promise<ArtifactRef>;
  /** `put` for a JSON payload — e.g. the materialised ATF result rows. */
  putJson(
    name: string,
    value: unknown,
    kind: ArtifactRef["kind"],
  ): Promise<ArtifactRef>;
  /**
   * Read back what `put` wrote, byte for byte. Resolves to one of three
   * outcomes (QA-9); THROWS — never resolves — for a ref that leaves the run
   * directory (INJ-1).
   */
  read(ref: ArtifactRefInput): Promise<ArtifactReadResult<Uint8Array>>;
  /**
   * `read`, decoded as UTF-8. Decoding is lossy the way `readFile(…, "utf8")`
   * is: invalid sequences become U+FFFD. A caller that needs byte fidelity
   * uses `read`.
   */
  readText(ref: ArtifactRefInput): Promise<ArtifactReadResult<string>>;
  /** `readText`, parsed. Adds the `malformed` outcome — including for empty bytes. */
  readJson(ref: ArtifactRefInput): Promise<ArtifactJsonReadResult>;
}

/** Root-relative, `/`-separated — see the portability note in the header. */
function toPortableRef(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

/** The libuv code off a rejected fs call, or `UNKNOWN` for anything else. */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "UNKNOWN";
}

const utf8 = new TextDecoder();

export function createArtifactStore(
  options: ArtifactStoreOptions,
): ArtifactStore {
  const { root: rawRoot, runId } = options;
  if (typeof rawRoot !== "string" || rawRoot.length === 0) {
    throw new Error("createArtifactStore: `root` must be a non-empty path.");
  }
  // A runId is a single directory level, so it must be a single path
  // component. `isSafePathComponent` (`pathkit.ts`) is the same rule the
  // vendored store applies to manifest-supplied file types.
  if (!isSafePathComponent(runId)) {
    throw new Error(
      `createArtifactStore: refusing to key an artifact directory on ${JSON.stringify(
        runId,
      )} — a runId must be a single path component.`,
    );
  }
  const root = path.resolve(rawRoot);
  const dir = path.join(root, runId);

  /**
   * The one containment rule, shared by both directions. `anchor` is the run
   * directory, or its `realpath` when the check runs after symlink resolution;
   * the message always names the run directory a caller knows about.
   *
   * `isUnderPath` treats a path as under itself, so the run directory itself
   * is excluded explicitly — it is a directory, not an artifact.
   */
  function assertInsideRunDir(
    target: string,
    subject: string,
    verb: "read" | "write",
    anchor: string = dir,
  ): void {
    if (target === anchor || !isUnderPath(anchor, target)) {
      throw new Error(
        `ArtifactStore: refusing to ${verb} ${JSON.stringify(
          subject,
        )} — it resolves outside the run directory ${dir}.`,
      );
    }
  }

  /**
   * Resolve `name` inside the run directory or refuse it. `path.resolve`
   * normalises `..` and absolutises a rooted name first, so both escapes are
   * visible to the containment check rather than hidden inside the string.
   */
  function resolveTarget(name: string): string {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        "ArtifactStore: artifact `name` must be a non-empty string.",
      );
    }
    const target = path.resolve(dir, name);
    assertInsideRunDir(target, name, "write");
    return target;
  }

  /**
   * A ref is relative to `root` (that is what `put` returned), not to the run
   * directory — but it must still land inside the run directory, so a ref for
   * a SIBLING run is refused here rather than silently read.
   */
  function resolveRef(input: ArtifactRefInput): {
    ref: string;
    target: string;
  } {
    const ref =
      typeof input === "string"
        ? input
        : typeof input === "object" && input !== null
          ? input.ref
          : undefined;
    if (typeof ref !== "string" || ref.length === 0) {
      throw new Error(
        "ArtifactStore: artifact `ref` must be a non-empty string.",
      );
    }
    const target = path.resolve(root, ref);
    assertInsideRunDir(target, ref, "read");
    return { ref, target };
  }

  /**
   * Create `parent` one level at a time, judging every level that already
   * exists by its REAL path before anything is created beneath it.
   *
   * Delegated decision 2026-09-25: `put` applies the read side's post-`realpath`
   * containment rule, and it applies it BEFORE `mkdir`, not only after. Until
   * then `put` checked the lexical path only, so a link planted inside the run
   * directory (`run-1/evidence -> /outside`) made `put("evidence/x")` write
   * `/outside/x` — the read of the same ref already refused it. Checking only
   * after a recursive `mkdir` would still have created directories outside
   * the run directory on the way to the refusal, so each existing level is
   * resolved and vetted first, and a missing level is created only under a
   * vetted one. As on the read side this is containment, not a symlink ban: a
   * link that stays inside the run directory is followed normally.
   */
  async function ensureContainedParent(
    parent: string,
    name: string,
    realDir: string,
  ): Promise<void> {
    const relative = path.relative(dir, parent);
    const levels = relative === "" ? [] : relative.split(path.sep);
    let current = dir;
    for (const level of levels) {
      current = path.join(current, level);
      let real: string | undefined;
      try {
        real = await realpath(current);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (real === undefined) {
        // Non-recursive on purpose: the level above was vetted, so this one
        // is created there and nowhere else. `EEXIST` means a racing `put`
        // created it first — it is re-resolved on the next pass below.
        await mkdir(current).catch((error: unknown) => {
          if (errorCode(error) !== "EEXIST") throw error;
        });
        real = await realpath(current);
      }
      if (real !== realDir && !isUnderPath(realDir, real)) {
        throw new Error(
          `ArtifactStore: refusing to write ${JSON.stringify(
            name,
          )} — it resolves outside the run directory ${dir}.`,
        );
      }
    }
    // The rule the read side applies, restated on the final parent: after
    // every level is in place, its real path must be at or under the real run
    // directory (at: an artifact directly in the run directory).
    const realParent = await realpath(parent);
    if (realParent !== realDir && !isUnderPath(realDir, realParent)) {
      throw new Error(
        `ArtifactStore: refusing to write ${JSON.stringify(
          name,
        )} — it resolves outside the run directory ${dir}.`,
      );
    }
  }

  async function put(
    name: string,
    contents: string | Uint8Array,
    kind: ArtifactRef["kind"],
  ): Promise<ArtifactRef> {
    const target = resolveTarget(name);
    const parent = path.dirname(target);
    // On demand: constructing a store must not create a directory for a run
    // that turns out to capture nothing. The run directory itself sits under
    // the injected (trusted) root, so it may be created recursively; every
    // level BELOW it is instance-named and goes through the vetted walk.
    if (!(await pathExists(dir))) {
      await createDirRecursively(dir);
    }
    const realDir = await realpath(dir);
    await ensureContainedParent(parent, name, realDir);
    // Delegated decision 2026-09-25: a symlink AT the target is refused
    // outright, whatever it points at. `rename` would replace the link rather
    // than follow it, so this is not an escape today — but an artifact name
    // that is already a link was planted by someone other than this store, and
    // overwriting it silently hides that. Fail closed, same error wording.
    let targetIsLink = false;
    try {
      targetIsLink = (await lstat(target)).isSymbolicLink();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (targetIsLink) {
      throw new Error(
        `ArtifactStore: refusing to write ${JSON.stringify(
          name,
        )} — it is a symbolic link, and a link at an artifact name may resolve outside the run directory ${dir}.`,
      );
    }
    // Delegated decision 2026-09-25: the temp name carries a random UUID, not
    // just the pid. Two concurrent `put`s of the same name in one process
    // shared `${target}.${pid}.tmp`; the first rename moved it away and the
    // second failed with ENOENT (17 of 20 in the review repro). Each attempt
    // gets its own name, opened with `wx` (O_CREAT|O_EXCL), so it can neither
    // clobber another writer's temp file nor follow a link planted at its name.
    await withRetry(async () => {
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, contents, { flag: "wx" });
        await rename(tmp, target);
      } catch (error) {
        // A unique name is never reused by the retry, so a failed attempt
        // would otherwise leave its temp file behind for good.
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    return { kind, ref: toPortableRef(root, target) };
  }

  async function putJson(
    name: string,
    value: unknown,
    kind: ArtifactRef["kind"],
  ): Promise<ArtifactRef> {
    const body = JSON.stringify(value, null, 2);
    if (body === undefined) {
      // `undefined`, a function or a symbol — there is no document to write,
      // and an empty file would be indistinguishable from a captured empty one.
      throw new Error(
        `ArtifactStore: ${JSON.stringify(name)} has no JSON representation.`,
      );
    }
    return put(name, body, kind);
  }

  /**
   * Turn a rejected fs call into the outcome it actually proves. ONLY `ENOENT`
   * is allowed to claim `missing`: every other code means something is there
   * that we could not read, and reporting that as absent (or as empty) is the
   * QA-9 defect. `UNKNOWN` therefore lands on `unreadable` too — when we do
   * not know, we do not get to say the evidence was never captured.
   */
  function toFailure(
    ref: string,
    target: string,
    error: unknown,
  ): ArtifactMissing | ArtifactUnreadable {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return {
        status: "missing",
        ref,
        path: target,
        reason: `no artifact exists at ${target}`,
      };
    }
    return {
      status: "unreadable",
      ref,
      path: target,
      code,
      reason: `${target} exists but could not be read (${code})`,
    };
  }

  async function read(
    input: ArtifactRefInput,
  ): Promise<ArtifactReadResult<Uint8Array>> {
    const { ref, target } = resolveRef(input);

    // Resolve links BEFORE opening anything, so containment is judged on the
    // path the read would actually touch. A rejection here is an outcome, not
    // an escape: nothing was read, so nothing left the run directory.
    let real: string;
    try {
      real = await realpath(target);
    } catch (error) {
      return toFailure(ref, target, error);
    }
    // The anchor is canonicalised too — `dir` may itself sit behind a link
    // (`/var` → `/private/var` on macOS), and comparing a resolved child to an
    // unresolved parent would refuse every legitimate read there.
    const realDir = await realpath(dir).catch(() => dir);
    assertInsideRunDir(real, ref, "read", realDir);

    let bytes: Uint8Array;
    try {
      // Read the RESOLVED path: it is the walk we vetted, and it carries no
      // links left to follow, so re-walking `target` here would re-open the
      // window `realpath` just closed.
      //
      // KNOWN LIMIT, stated rather than papered over: `realpath` then `open`
      // is not atomic. A local attacker who can write inside the run directory
      // between the two calls can still swap a path component. Closing that
      // needs `openat2(RESOLVE_BENEATH)`, which Node does not expose — and
      // `O_NOFOLLOW` would not do it either (it guards only the last component,
      // and it would break the contained symlinks this API deliberately reads).
      // The threat this API is actually built for — an instance-authored ref —
      // is fully covered, because such a ref never gets to plant a file here.
      bytes = new Uint8Array(await readFile(real));
    } catch (error) {
      return toFailure(ref, target, error);
    }
    return { status: "ok", ref, path: target, value: bytes };
  }

  async function readText(
    input: ArtifactRefInput,
  ): Promise<ArtifactReadResult<string>> {
    const result = await read(input);
    if (result.status !== "ok") {
      return result;
    }
    return {
      status: "ok",
      ref: result.ref,
      path: result.path,
      value: utf8.decode(result.value),
    };
  }

  async function readJson(
    input: ArtifactRefInput,
  ): Promise<ArtifactJsonReadResult> {
    // Over `read`, not `readText`, so the `malformed` reason can name the
    // BYTES that were on disk. Until 2026-09-03 this went through `readText`
    // and reported the decoded string's `.length` as a byte count: that is a
    // count of UTF-16 code units of a LOSSY decode, so any artifact holding a
    // multi-byte character was reported as smaller than it is, and a run of
    // invalid bytes was reported as however many U+FFFD they collapsed to.
    // Nobody reading the reason has the file to check it against.
    const result = await read(input);
    if (result.status !== "ok") {
      return result;
    }
    const text = utf8.decode(result.value);
    try {
      // `as unknown` and not `any`: a parsed artifact is instance-authored
      // data, and typing it as `any` would let it flow anywhere unchecked.
      const value = JSON.parse(text) as unknown;
      return { status: "ok", ref: result.ref, path: result.path, value };
    } catch (error) {
      return {
        status: "malformed",
        ref: result.ref,
        path: result.path,
        // An empty artifact lands here: `JSON.parse("")` throws. "The file is
        // empty" and "the document is empty" are different findings.
        reason: `${result.path} holds ${result.value.byteLength} byte(s) that are not JSON: ${
          error instanceof Error ? error.message : "parse failed"
        }`,
      };
    }
  }

  return { dir, put, putJson, read, readText, readJson };
}
