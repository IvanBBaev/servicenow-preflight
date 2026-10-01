// DEV-4 — the generation safety envelope, repo side.
//
// The rule this file exists to enforce is one sentence long: GENERATED OUTPUT IS
// INERT UNTIL A HUMAN PROMOTES IT.
//
// What makes that enforceable is an accident of the Phase 4 design that is worth
// naming. `@tessera/specs` joins on the MANIFEST and never on file paths (QA-16),
// so a spec file that no manifest entry mentions is not a spec that runs — it is
// a file. The inventory reader will notice it and say so in a warning, which is
// exactly the behaviour wanted here: the repo is told the file exists and told
// that nothing is claiming it. So the arming mechanism is not the write, it is
// the manifest entry, and a writer that never edits `.manifest.json` cannot arm
// anything no matter what it puts on disk.
//
// Hence the shape: specs go to `<testsRoot>/proposed/`, and their entries go to a
// SIBLING `.manifest.proposed.json` written in the same version-1 shape the live
// manifest uses. Promotion is then a human moving entries from one file to the
// other — a diff a reviewer can read, in a format they already know, with no tool
// in the loop. This module never opens `.manifest.json`, in any mode, for any
// reason. There is no flag that changes that, and adding one would delete the
// only property this file has.
//
// Four further guards, each of which has its own test:
//
// CONTAINMENT. Every path is resolved and checked to be inside `proposed/` by
// path SEGMENTS, the way `@tessera/specs` does it — `startsWith` would call
// `/tests/proposed-old/x` contained. A model-authored `filename` is untrusted
// input in the ordinary sense even though it arrives as a plain string: it was
// composed by something that read instance text (TM-1's chain), and `../../`
// costs nothing to write.
//
// THE GATE BINDING. `writeProposedSpecs` takes a `ClearedSource`, and a
// `ClearedSource` carries a `GateClearance` that only `./gate.ts` can mint. There
// is no overload that takes a bare string. Writing a source the gate never saw is
// therefore a compile error rather than something review has to catch — and the
// runtime check below that the cleared source is the SAME VALUE as the
// candidate's closes the other half, where somebody gates one string and writes
// another.
//
// ATOMIC BATCH. A batch lands whole or not at all: it is staged in a fresh
// sibling directory and swapped in by rename, so a refusal or a filesystem
// fault leaves the previous batch exactly as it was (review W7b, L2).
//
// NO CLOCK. Nothing here reads the time. Two identical generation runs produce
// byte-identical output, so a re-run shows an empty diff and a real change shows
// only itself. A `generatedAt` field would make every re-run look like a change
// and teach reviewers to skim the one file they must not skim.

import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { PROPOSED_SPECS_DIRNAME } from "@tessera/specs";
import { unwrapUntrusted } from "@tessera/types";
import type { TargetArtifactRef, TestKind } from "@tessera/types";

import { GenerateInputError, GenerationFaultError } from "./errors.js";
import {
  MAX_MODEL_ID_CHARS,
  MAX_SYS_ID_CHARS,
  MAX_TABLE_CHARS,
  MAX_TARGET_NAME_CHARS,
  MAX_TARGETS_PER_SPEC,
  isSafeField,
} from "./fieldSafety.js";
import type { ClearedSource } from "./gate.js";
import type { GenerationCandidate } from "./provider.js";

/**
 * The unwrap boundary. The source is written verbatim to a file under
 * `proposed/` that nothing runs and no manifest arms; it is not interpolated,
 * not evaluated, and not rendered into a report.
 */
const WRITE_BOUNDARY =
  "proposed-spec write — the cleared source is written verbatim to a file under proposed/ that no manifest arms and nothing executes; it is never interpolated, evaluated or rendered (TM-1/DEV-4)";

/**
 * Where generated specs land. A sibling of the live tree, never inside it.
 *
 * Delegated decision 2026-09-28 (wave 13): the name is owned by `@tessera/specs`,
 * the reader that has to find the batch again, and is imported rather than
 * restated so the writer and the reader cannot drift apart. Kept under its old
 * name as an alias because dependents import `PROPOSED_DIRNAME` from here.
 * (`LIVE_MANIFEST_FILENAME` below is duplicated on purpose; this one is not.)
 */
export const PROPOSED_DIRNAME = PROPOSED_SPECS_DIRNAME;

/** The inert registry. Deliberately NOT `.manifest.json`. */
export const PROPOSED_MANIFEST_FILENAME = ".manifest.proposed.json";

/**
 * The live registry, named here for one purpose: so the guard below can compare
 * against it and so a reader of this file sees the name it must never write.
 * Duplicated from `@tessera/specs` rather than imported, because the value this
 * constant carries is "the thing we refuse to touch" — if the two ever diverge,
 * the refusal must not silently follow the rename.
 */
export const LIVE_MANIFEST_FILENAME = ".manifest.json";

/** The manifest version `@tessera/specs` understands. Matched exactly. */
export const PROPOSED_MANIFEST_VERSION = 1;

/**
 * The suffixes each kind may be written with, from `SPEC_FILE_SUFFIXES` in
 * `@tessera/specs`. Total over `TestKind` so a new kind cannot be added without
 * deciding how its files are named.
 *
 * Enforced, not advisory. A file the inventory's suffix sweep does not recognise
 * is a file that will never be reported as unregistered — so a spec written with
 * a name outside this list would sit in the repo completely unmentioned, which is
 * the one outcome the proposed/ directory exists to prevent.
 */
export const ALLOWED_SUFFIXES: Readonly<Record<TestKind, readonly string[]>> = {
  unit: [".unit.ts"],
  e2e: [".e2e.atf.yaml", ".e2e.atf.yml"],
  ui: [".spec.ts"],
};

/**
 * The longest id or filename this writer accepts — and therefore the longest
 * one it can ever quote back into an error message.
 *
 * A name is model output. Every rejection below quotes the name it is about,
 * because a rule violation the caller cannot locate is barely a rejection at
 * all, and those messages travel: CLI stderr, a CI annotation, and — through
 * the MCP relay in `@tessera/mcp` — the context of the next model. Unbounded
 * model prose arriving there under the heading of an error message is the
 * TM-1 hole in miniature, so the length is capped here rather than trimmed at
 * each print site. 120 characters is well above any real spec name and well
 * below the 255-byte segment limit every target filesystem imposes, which also
 * keeps an over-long name a DEV-1 input error instead of an ENAMETOOLONG fault
 * raised halfway through a batch.
 */
const MAX_NAME_CHARS = 120;

/**
 * The id charset the generation prompt tells the model its ids are held to.
 *
 * It is enforced HERE because the prompt says a downstream check enforces it,
 * and because the id is the one piece of model-authored text that leaves this
 * package by design: it is written into the proposed manifest, reported in
 * `ProposedWriteReport.written`, and printed by the CLI.
 */
const ID_CHARSET = /^[A-Za-z0-9._-]+$/;

/**
 * The sibling directories a batch is staged in and the previous batch is
 * retired to, each suffixed with a random token (not a clock). Dot-prefixed
 * and never named `proposed`, so neither is ever mistaken for the inert tree.
 */
/** Device names Windows reserves, matched on the stem before the first dot. */
const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;

const STAGING_PREFIX = ".proposed-staging-";
const RETIRED_PREFIX = ".proposed-retired-";

/** A candidate plus the proof its source went through the gate. */
export interface ProposedSpec {
  readonly candidate: GenerationCandidate;
  readonly cleared: ClearedSource;
}

/**
 * What produced this batch. Recorded in the proposed manifest so the reviewer
 * reading the diff knows which model, which prompt and which run to blame — and
 * so a promoted entry can be traced back after the fact.
 */
export interface ProposedProvenance {
  readonly runId: string;
  /** The provider's `name` — a constant, never caller text. */
  readonly generator: string;
  readonly modelId: string;
  readonly promptHash: string;
  readonly promptVersion: string;
}

const PROVENANCE_FIELDS = [
  "runId",
  "generator",
  "modelId",
  "promptHash",
  "promptVersion",
] as const satisfies readonly (keyof ProposedProvenance)[];

export interface WriteProposedOptions {
  /** Absolute path of the tests root — the directory holding `.manifest.json`. */
  readonly testsRoot: string;
  readonly specs: readonly ProposedSpec[];
  readonly provenance: ProposedProvenance;
}

/** The swap steps, in order; each is reported to {@link WriterSeams.afterSwapStep}. */
export type SwapStep = "retired-manifest" | "retired-proposed" | "installed";

/** Test seams for {@link writeProposedSpecs}; production passes none. */
export interface WriterSeams {
  /**
   * Called after each completed swap step. A throw here is treated exactly like
   * a filesystem fault at that point, so the rollback path can be exercised on
   * a real directory without racing the filesystem.
   */
  readonly afterSwapStep?: (step: SwapStep) => Promise<void> | void;
}

export interface WrittenSpec {
  readonly id: string;
  /** Tests-root-relative, POSIX separators — what goes in the manifest. */
  readonly path: string;
  readonly absolutePath: string;
  readonly bytes: number;
  /** True iff a file was already there. Regeneration is allowed; silence is not. */
  readonly overwritten: boolean;
}

export interface ProposedWriteReport {
  readonly proposedDir: string;
  readonly manifestPath: string;
  /**
   * The path this writer did NOT touch. Returned so a caller — or a test — can
   * assert the negative against a concrete string rather than a convention.
   */
  readonly liveManifestPath: string;
  readonly written: readonly WrittenSpec[];
}

/** The on-disk shape of `.manifest.proposed.json`. */
export interface ProposedManifest {
  readonly version: number;
  /** Present so a promoted copy that forgets to drop it is obvious in review. */
  readonly proposed: true;
  readonly note: string;
  readonly provenance: ProposedProvenance;
  readonly specs: readonly ProposedManifestEntry[];
}

export interface ProposedManifestEntry {
  readonly id: string;
  readonly path: string;
  readonly kind: TestKind;
  readonly targets: readonly TargetArtifactRef[];
}

const MANIFEST_NOTE = [
  "These specs are PROPOSED. Nothing runs them.",
  `A spec is armed by an entry in ${LIVE_MANIFEST_FILENAME}, and this file is not that file:`,
  "@tessera/specs joins on the manifest and never on file paths (QA-16), so an entry",
  "listed here is inert until a human moves it across and reviews the spec body it points at.",
  "The generator never writes the live manifest, in any mode.",
].join(" ");

/** Segment-wise containment, matching `@tessera/specs`. `startsWith` lies. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "" || path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0] !== "..";
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Codepoint arithmetic rather than a regex with literal control characters in
 * the source. The regex form is unreadable in a diff, survives a copy-paste
 * badly, and needs a lint suppression to exist at all.
 *
 * Three families, and one property shared by all of them: they make a rendered
 * name lie about its own content. The C0 controls and DEL (a NUL truncates the
 * name in a terminal, an ESC opens a colour or cursor sequence), the C1
 * controls (a second escape vocabulary on the terminals that still decode
 * them), and the zero-width, line/paragraph-separator and bidi-override
 * characters, which hide or reorder the text around them while occupying no
 * width at all. Every one of these names is model output that this file quotes
 * back into an error message, so a character that can make the quotation
 * display as something other than what was proposed is refused rather than
 * escaped: escaping would still hand the reader a name, and the reader has no
 * way to tell an escaped rendering from an honest one.
 */
function hasUnsafeNameCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
    if (code >= 0x80 && code <= 0x9f) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code === 0x2028 || code === 0x2029) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code === 0xfeff) return true;
  }
  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Make sure every directory from `root` (exclusive) down to `dir` (inclusive)
 * exists and is a REAL directory — never a symlink, never a file.
 *
 * Delegated decision 2026-09-25 (fail closed): a symlink anywhere below the
 * tests root is refused, whatever it points at. `mkdir({ recursive: true })`
 * and `writeFile` both follow links, so a link committed into `proposed/` —
 * `proposed/x.unit.ts -> ../.manifest.json`, or `proposed/sub -> ..` — let
 * model output land on the live manifest, which is the one write DEV-4 exists
 * to make impossible. Resolving the link and checking where it lands was the
 * alternative; it is refused instead because a link in the inert tree has no
 * legitimate use and every check on a resolved target races the link itself.
 * Components are created one at a time (never recursively) so that each one
 * is examined before anything is created beneath it.
 */
async function ensureRealDirectoryChain(
  root: string,
  dir: string,
): Promise<void> {
  const relative = path.relative(root, dir);
  if (relative === "") return;
  if (path.isAbsolute(relative) || relative.split(path.sep)[0] === "..") {
    throw new GenerationFaultError(
      `${dir} is not inside the tests root ${root}; refusing to create it (DEV-4)`,
    );
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") {
        throw new GenerationFaultError(
          `${current} could not be examined: ${describeError(error)}`,
          { cause: error },
        );
      }
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (errnoOf(mkdirError) !== "EEXIST") {
          throw new GenerationFaultError(
            `${current} could not be created: ${describeError(mkdirError)}`,
            { cause: mkdirError },
          );
        }
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) {
      throw new GenerationFaultError(
        `${current} is a symbolic link; the generator refuses to write through a link under the tests root, because a link is how generated output reaches the live manifest (DEV-4)`,
      );
    }
    if (!info.isDirectory()) {
      throw new GenerationFaultError(
        `${current} exists and is not a directory; refusing to write beneath it`,
      );
    }
  }
}

/**
 * Examine a write target without following it. Returns whether a regular file
 * is already there; refuses a symlink or anything else that is not a file.
 */
async function examineTarget(target: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return false;
    throw new GenerationFaultError(
      `${target} could not be examined before writing: ${describeError(error)}`,
      { cause: error },
    );
  }
  if (info.isSymbolicLink()) {
    throw new GenerationFaultError(
      `${target} is a symbolic link; refusing to write through it, because a link is how generated output reaches the live manifest (DEV-4)`,
    );
  }
  if (!info.isFile()) {
    throw new GenerationFaultError(
      `${target} exists and is not a regular file; refusing to write over it`,
    );
  }
  return true;
}

/**
 * Walk the EXISTING part of the chain from `root` (exclusive) down to `dir`
 * (inclusive) without following anything, and without creating anything.
 * Returns whether the whole chain exists. A symlink or a non-directory on the
 * way is refused, exactly as `ensureRealDirectoryChain` refuses it — but this
 * one runs before any write, so a refusal leaves the tree as it was found.
 */
async function examineExistingChain(
  root: string,
  dir: string,
): Promise<boolean> {
  const relative = path.relative(root, dir);
  if (relative === "") return true;
  if (path.isAbsolute(relative) || relative.split(path.sep)[0] === "..") {
    throw new GenerationFaultError(
      `${dir} is not inside the tests root ${root}; refusing to write (DEV-4)`,
    );
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return false;
      throw new GenerationFaultError(
        `${current} could not be examined: ${describeError(error)}`,
        { cause: error },
      );
    }
    if (info.isSymbolicLink()) {
      throw new GenerationFaultError(
        `${current} is a symbolic link; the generator refuses to write through a link under the tests root, because a link is how generated output reaches the live manifest (DEV-4)`,
      );
    }
    if (!info.isDirectory()) {
      throw new GenerationFaultError(
        `${current} exists and is not a directory; refusing to write beneath it`,
      );
    }
  }
  return true;
}

/** Whether a directory entry exists at `target`, link or not; never follows. */
async function entryExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * Write `text` to `target` without ever opening `target` itself.
 *
 * The bytes go to a fresh, uniquely named sibling created with `wx`
 * (O_CREAT|O_EXCL — it fails rather than follows if anything, a link
 * included, already sits at that name), and the sibling is then renamed over
 * the target. `rename` replaces the directory ENTRY: a link planted at the
 * target after `examineTarget` looked is replaced, not followed, and a hard
 * link to the live manifest keeps the manifest's bytes. The temporary name
 * starts with a dot and ends in `.tmp`, so the inventory's suffix sweep never
 * mistakes it for a spec. The random suffix is not a clock: two runs still
 * produce byte-identical outputs.
 */
async function writeByRename(target: string, text: string): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** `realpath`, reported as a fault rather than a raw errno. */
async function realpathOf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    throw new GenerationFaultError(
      `${target} could not be resolved: ${describeError(error)}`,
      { cause: error },
    );
  }
}

/**
 * Reject a filename before it is resolved against anything.
 *
 * Resolution is where `..` stops being visible, so the cheap syntactic checks
 * happen first and the containment check happens anyway. Both, not either.
 *
 * The ORDER of the checks is load-bearing for a second reason. Every message
 * from the fourth check onwards quotes the name, and the name is model output
 * on its way to a log and to another model's context. So the two properties
 * that make a quotation safe — bounded length, no character that can forge its
 * own rendering — are established BEFORE anything is quoted, and the checks
 * that establish them describe the name by its length and their own rule
 * rather than by its text. The absolute-filename branch used to run first and
 * therefore quoted names no check had looked at yet.
 */
function checkFilename(filename: string, kind: TestKind, label: string): void {
  if (!isNonBlank(filename)) {
    throw new GenerateInputError(`${label} has a blank filename`);
  }
  if (filename.length > MAX_NAME_CHARS) {
    throw new GenerateInputError(
      `${label} has a filename of ${filename.length} characters; the limit is ${MAX_NAME_CHARS}, and the name is not quoted here because nothing has bounded it yet`,
    );
  }
  if (hasUnsafeNameCharacter(filename)) {
    throw new GenerateInputError(
      `${label} has a filename containing a control, C1 or bidi-format character`,
    );
  }
  if (path.isAbsolute(filename) || /^[A-Za-z]:/.test(filename)) {
    throw new GenerateInputError(
      `${label} has the absolute filename "${filename}"; a proposed spec is named relative to ${PROPOSED_DIRNAME}/`,
    );
  }
  if (filename.includes("\\")) {
    // A backslash is a separator on one platform and a legal filename character
    // on another. A generated name that relies on which one it is running under
    // is a name that means two things.
    throw new GenerateInputError(
      `${label} has the filename "${filename}"; use "/" between path segments`,
    );
  }
  const segments = filename.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new GenerateInputError(
        `${label} has the filename "${filename}", which contains an empty or relative path segment`,
      );
    }
    // Delegated decision 2026-09-26 (fail closed, review W7b L3): each segment
    // is held to the same charset as an id. A generated name with a space, a
    // colon, a quote or a non-ASCII letter is a name that one filesystem
    // stores, another folds (NFC/NFD) and a shell splits; none of them is a
    // spec name this pipeline asked for. The name is not quoted: whatever it
    // holds is outside the set this writer vouches for.
    if (!ID_CHARSET.test(segment)) {
      throw new GenerateInputError(
        `${label} has a filename with a path segment outside [A-Za-z0-9._-]; each segment of a proposed spec's filename is held to that charset`,
      );
    }
    // Windows refuses these device names whatever their extension (`con.unit.ts`
    // opens the console), and silently strips a trailing dot, so `a.` and `a`
    // are one file there. The batch is reviewed and promoted on every platform.
    const stem = segment.split(".")[0]?.toUpperCase() ?? "";
    if (WINDOWS_RESERVED_NAMES.test(stem)) {
      throw new GenerateInputError(
        `${label} has the filename "${filename}", which uses a device name Windows reserves (CON, PRN, AUX, NUL, COM1-9, LPT1-9)`,
      );
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new GenerateInputError(
        `${label} has the filename "${filename}", which has a path segment ending in a dot or a space; Windows strips it, so the name means two files`,
      );
    }
  }
  const suffixes = ALLOWED_SUFFIXES[kind];
  if (!suffixes.some((suffix) => filename.endsWith(suffix))) {
    throw new GenerateInputError(
      `${label} has the filename "${filename}", which does not end in ${suffixes.join(" or ")} as a ${kind} spec must; a file the inventory's suffix sweep does not recognise would sit in the repo entirely unreported`,
    );
  }
}

/**
 * Write a batch of generated specs into the inert half of the tests root.
 *
 * Replaces `<testsRoot>/proposed/` with a tree holding
 * `<filename>` for each spec, and writes one
 * `<testsRoot>/.manifest.proposed.json` describing them all. Never opens, reads
 * or writes `<testsRoot>/.manifest.json`.
 *
 * @throws GenerateInputError when the tests root, a filename or the batch itself
 * is wrong — the fix is a different argument (DEV-1).
 * @throws GenerationFaultError when the tree under the tests root holds a link
 * or a non-file where the batch goes, or the filesystem refuses a write that
 * was validated. The batch is atomic: on any of these the previous batch —
 * files and manifest — is left, or put back, exactly as it was.
 */
export async function writeProposedSpecs(
  options: WriteProposedOptions,
  seams: WriterSeams = {},
): Promise<ProposedWriteReport> {
  // ── 1. the root ─────────────────────────────────────────────────────────
  if (!isNonBlank(options.testsRoot)) {
    throw new GenerateInputError(
      `the tests root is blank; name the directory holding ${LIVE_MANIFEST_FILENAME} (DESIGN §4)`,
    );
  }
  const testsRoot = path.resolve(options.testsRoot);

  let rootStat;
  try {
    rootStat = await stat(testsRoot);
  } catch (error) {
    throw new GenerateInputError(
      `the tests root ${testsRoot} is not readable as a directory: ${describeError(error)}`,
      { cause: error },
    );
  }
  if (!rootStat.isDirectory()) {
    throw new GenerateInputError(
      `the tests root ${testsRoot} is not a directory`,
    );
  }

  const proposedDir = path.join(testsRoot, PROPOSED_DIRNAME);
  const manifestPath = path.join(testsRoot, PROPOSED_MANIFEST_FILENAME);
  const liveManifestPath = path.join(testsRoot, LIVE_MANIFEST_FILENAME);

  // The guard that makes the file header's claim checkable rather than merely
  // stated. It cannot fire while the constants above are correct, which is the
  // point: it fires the day somebody edits one of them.
  if (path.basename(manifestPath) === LIVE_MANIFEST_FILENAME) {
    throw new GenerationFaultError(
      "the proposed manifest resolved to the live manifest path; refusing to write, because writing it is what arms a spec (DEV-4)",
    );
  }

  // ── 2. the batch ────────────────────────────────────────────────────────
  if (options.specs.length === 0) {
    // Not a fault and not a silent success. The generator throws before it can
    // hand over an empty batch (see `./errors.ts` on why an empty spec list is
    // a claim); a caller that reached here with zero specs has a bug in the
    // argument it built, and writing an empty manifest over a previous batch
    // would erase a review queue nobody asked to erase.
    throw new GenerateInputError(
      "the proposed batch is empty; there is nothing to write, and writing an empty manifest would silently discard a previous batch",
    );
  }

  // Delegated decision 2026-09-26 (fail closed, review W7b L3): provenance is
  // written verbatim into the manifest a reviewer reads, so every field is a
  // short string with no control, bidi or zero-width character. The generator
  // sanitises the provider's model id before it gets here; anything else that
  // arrives unsafe is a caller bug and is refused rather than repaired.
  for (const field of PROVENANCE_FIELDS) {
    const value: unknown = options.provenance?.[field];
    if (typeof value !== "string" || !isSafeField(value, MAX_MODEL_ID_CHARS)) {
      throw new GenerateInputError(
        `the provenance field \`${field}\` is not a string of at most ${MAX_MODEL_ID_CHARS} characters free of control, bidi and zero-width characters`,
      );
    }
  }

  const entries: ProposedManifestEntry[] = [];
  const planned: Array<{
    readonly absolutePath: string;
    readonly text: string;
    readonly entry: ProposedManifestEntry;
  }> = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const [index, spec] of options.specs.entries()) {
    const { candidate, cleared } = spec;
    const label = `proposed spec #${index + 1}`;

    if (!isNonBlank(candidate.id)) {
      throw new GenerateInputError(`${label} has a blank id`);
    }
    if (candidate.id.length > MAX_NAME_CHARS) {
      throw new GenerateInputError(
        `${label} has an id of ${candidate.id.length} characters; the limit is ${MAX_NAME_CHARS}, and the id is not quoted here because nothing has bounded it yet`,
      );
    }
    if (!ID_CHARSET.test(candidate.id)) {
      // The prompt tells the model this charset is a rule "a downstream gate
      // enforces". Until this check existed, nothing did: an id was accepted
      // whatever it contained, went into the proposed manifest verbatim, and
      // came back out through the CLI report into the next model's context. A
      // rule stated to a model and enforced nowhere is worse than an unstated
      // one, because the batch that breaks it is the batch nobody inspects.
      throw new GenerateInputError(
        `${label} has an id outside [A-Za-z0-9._-]; that charset is a rule the generation prompt states and this writer enforces, and an id travels into the manifest, the report and from there into a reader that cannot check it`,
      );
    }
    if (seenIds.has(candidate.id)) {
      // Identity that is not unique is not identity, and `@tessera/specs` would
      // resolve the collision by first-wins with a warning — a promoted batch
      // that quietly drops half of itself.
      throw new GenerateInputError(
        `${label} repeats the id \`${candidate.id}\`; spec ids must be unique within a batch`,
      );
    }
    seenIds.add(candidate.id);

    // The gate binding. Value identity, not deep equality: a source that merely
    // LOOKS like the cleared one is a source the gate did not inspect.
    if (cleared.source !== candidate.source) {
      throw new GenerateInputError(
        `${label} carries a gate clearance for a different source than the one it asks to write; the clearance proves nothing about this text (TM-3)`,
      );
    }

    checkFilename(candidate.filename, candidate.kind, label);

    // Delegated decision 2026-09-26 (fail closed, review W7b L3): the target
    // triples go into the manifest verbatim, so the parser's caps are enforced
    // again here for a caller that did not come through `parseCandidates`.
    // Held as `unknown` so the list check does not narrow the typed field to
    // `any[]` (Array.isArray's signature); the loop below keeps the types.
    const targetList: unknown = candidate.targets;
    if (
      !Array.isArray(targetList) ||
      targetList.length > MAX_TARGETS_PER_SPEC
    ) {
      throw new GenerateInputError(
        `${label} names more than ${MAX_TARGETS_PER_SPEC} targets, or its targets are not a list`,
      );
    }
    for (const target of candidate.targets) {
      if (
        !isSafeField(String(target?.table), MAX_TABLE_CHARS) ||
        !isSafeField(String(target?.sysId), MAX_SYS_ID_CHARS) ||
        !isSafeField(String(target?.name), MAX_TARGET_NAME_CHARS)
      ) {
        throw new GenerateInputError(
          `${label} has a target whose table, sys_id or name holds a control, bidi or zero-width character, or is longer than its cap (${MAX_TABLE_CHARS}/${MAX_SYS_ID_CHARS}/${MAX_TARGET_NAME_CHARS} chars)`,
        );
      }
    }

    const absolutePath = path.resolve(proposedDir, candidate.filename);
    if (!isInside(proposedDir, absolutePath)) {
      throw new GenerateInputError(
        `${label} has the filename "${candidate.filename}", which resolves outside ${PROPOSED_DIRNAME}/; generated output is confined to the inert directory (DEV-4)`,
      );
    }
    // Unreachable while containment holds. Kept because "unreachable" is a claim
    // about today's code and this is the one collision that arms a spec.
    if (
      absolutePath === liveManifestPath ||
      absolutePath === manifestPath ||
      path.basename(absolutePath) === LIVE_MANIFEST_FILENAME
    ) {
      throw new GenerateInputError(
        `${label} asks to write ${LIVE_MANIFEST_FILENAME}; the generator never writes a live manifest (DEV-4)`,
      );
    }

    // Delegated decision 2026-09-26: dedupe on the path a case-insensitive,
    // normalising filesystem would actually open, not on the string. On APFS
    // (and NTFS) `Foo.unit.ts` and `foo.unit.ts` — or the NFC and NFD
    // spellings of one name — are ONE file: the second write replaced the
    // first and both manifest entries resolved to the second spec's code. The
    // key is NFC-normalised and lower-cased on every platform, and a collision
    // refuses the WHOLE batch here, before any write: fail closed regardless
    // of which filesystem this run happens to be on, because the batch is
    // reviewed and promoted on others.
    const pathKey = absolutePath.normalize("NFC").toLowerCase();
    if (seenPaths.has(pathKey)) {
      throw new GenerateInputError(
        `${label} writes "${candidate.filename}", which another spec in this batch also writes (compared case-insensitively and after Unicode NFC normalisation, as a case-insensitive filesystem would); the second would silently replace the first`,
      );
    }
    seenPaths.add(pathKey);

    const text = unwrapUntrusted(cleared.source, WRITE_BOUNDARY);
    const relative = path
      .relative(testsRoot, absolutePath)
      .split(path.sep)
      .join("/");

    const entry: ProposedManifestEntry = {
      id: candidate.id,
      path: relative,
      kind: candidate.kind,
      // QA-16: the declared link, copied through verbatim. The `name` field is
      // model-authored prose and stays in a labelled data position — a manifest
      // field a reader can see is data — rather than in the spec body.
      targets: candidate.targets.map((target) => ({
        table: target.table,
        sysId: target.sysId,
        name: target.name,
      })),
    };
    entries.push(entry);
    planned.push({ absolutePath, text, entry });
  }

  // ── 3. the pre-check ────────────────────────────────────────────────────
  // Everything that already exists at a path this batch will occupy is
  // examined, without following links, BEFORE anything is created: a link or a
  // non-file there refuses the batch while the tests root is still exactly as
  // it was found. The existing tree is never written into — the batch is
  // staged beside it and swapped in whole (step 4) — so these checks are about
  // refusing a tree someone tampered with, not about where the bytes go.
  const realRoot = await realpathOf(testsRoot);
  const overwrittenByPath = new Map<string, boolean>();
  for (const item of planned) {
    const chainExists = await examineExistingChain(
      testsRoot,
      path.dirname(item.absolutePath),
    );
    // Regenerating over a previous proposal is the normal case and is allowed
    // — everything under proposed/ is inert by construction. It is REPORTED,
    // because a reviewer who has already read a file needs to know it changed.
    overwrittenByPath.set(
      item.absolutePath,
      chainExists ? await examineTarget(item.absolutePath) : false,
    );
  }
  // The same no-follow discipline for the inert registry: a link planted at
  // `.manifest.proposed.json` pointing at `.manifest.json` is refused here.
  await examineTarget(manifestPath);

  // ── 4. stage, then swap ─────────────────────────────────────────────────
  // Delegated decision 2026-09-26 (fail closed, review W7b L2): the batch is
  // ATOMIC. It is written in full to a fresh sibling directory created with a
  // non-recursive mkdir, every file with `wx`, and only then swapped in: the old
  // manifest is retired FIRST (so no manifest ever names a tree it does not
  // describe), the old proposed/ is retired, the staged tree is renamed to
  // proposed/, and the new manifest is written LAST. Any failure before the
  // swap removes the staging directory and leaves the previous batch exactly
  // as it was; a failure during the swap puts the previous batch back. Before
  // this, a mid-batch filesystem fault left the first half of a new batch
  // mixed into the old one. The consequence, pinned in the tests: proposed/ is
  // REPLACED wholesale, so a file a previous batch wrote and this one does not
  // is removed with the retired tree. proposed/ is the generator's inert
  // output directory; anything a human wants to keep is promoted out of it.
  const token = randomBytes(8).toString("hex");
  const stagingDir = path.join(testsRoot, `${STAGING_PREFIX}${token}`);
  const retiredDir = path.join(testsRoot, `${RETIRED_PREFIX}${token}`);

  try {
    await mkdir(stagingDir);
  } catch (error) {
    throw new GenerationFaultError(
      `${stagingDir} could not be created to stage the batch: ${describeError(error)}; nothing was written and the previous batch is unchanged`,
      { cause: error },
    );
  }

  const written: WrittenSpec[] = [];
  try {
    const stagingInfo = await lstat(stagingDir);
    if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) {
      throw new GenerationFaultError(
        `${stagingDir} is not the directory this run just created; refusing to stage into it (DEV-4)`,
      );
    }
    const realStaging = await realpathOf(stagingDir);
    if (!isInside(realRoot, realStaging)) {
      throw new GenerationFaultError(
        `${stagingDir} resolves outside the tests root; refusing to write (DEV-4)`,
      );
    }
    for (const item of planned) {
      const staged = path.join(
        stagingDir,
        path.relative(proposedDir, item.absolutePath),
      );
      await ensureRealDirectoryChain(stagingDir, path.dirname(staged));
      try {
        // `wx`: the staging tree is this run's own and brand new, so anything
        // already at the name — a link included — is refused, never followed.
        await writeFile(staged, item.text, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        throw new GenerationFaultError(
          `${item.absolutePath} could not be staged: ${describeError(error)}`,
          { cause: error },
        );
      }
      written.push({
        id: item.entry.id,
        path: item.entry.path,
        absolutePath: item.absolutePath,
        bytes: Buffer.byteLength(item.text, "utf8"),
        overwritten: overwrittenByPath.get(item.absolutePath) ?? false,
      });
    }
    await mkdir(retiredDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await rm(retiredDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (error instanceof GenerationFaultError) {
      throw new GenerationFaultError(
        `${error.message}; nothing was written and the previous batch is unchanged`,
        { cause: error },
      );
    }
    throw new GenerationFaultError(
      `the batch could not be staged: ${describeError(error)}; nothing was written and the previous batch is unchanged`,
      { cause: error },
    );
  }

  const manifest: ProposedManifest = {
    version: PROPOSED_MANIFEST_VERSION,
    proposed: true,
    note: MANIFEST_NOTE,
    provenance: options.provenance,
    specs: [...entries].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  const retiredManifest = path.join(retiredDir, PROPOSED_MANIFEST_FILENAME);
  const retiredProposed = path.join(retiredDir, PROPOSED_DIRNAME);
  let movedManifest = false;
  let movedProposed = false;
  let installed = false;
  try {
    // Re-examined at the moment of the swap. `rename` moves a directory ENTRY
    // and never follows one, so even a link planted since the pre-check is
    // retired as a link rather than written through.
    if (await entryExists(manifestPath)) {
      await rename(manifestPath, retiredManifest);
      movedManifest = true;
      await seams.afterSwapStep?.("retired-manifest");
    }
    if (await entryExists(proposedDir)) {
      await rename(proposedDir, retiredProposed);
      movedProposed = true;
      await seams.afterSwapStep?.("retired-proposed");
    }
    await rename(stagingDir, proposedDir);
    installed = true;
    await seams.afterSwapStep?.("installed");
    await writeByRename(manifestPath, manifestText);
  } catch (error) {
    // Roll back in reverse. Each step is attempted even if an earlier one
    // failed, and the retired directory is deleted only when the previous
    // batch is back in place — otherwise it is the only copy, and it is named.
    let restored = true;
    const attempt = async (step: () => Promise<void>): Promise<void> => {
      try {
        await step();
      } catch {
        restored = false;
      }
    };
    if (installed) await attempt(() => rename(proposedDir, stagingDir));
    if (movedProposed) {
      await attempt(() => rename(retiredProposed, proposedDir));
    }
    if (movedManifest) {
      await attempt(() => rename(retiredManifest, manifestPath));
    }
    await rm(stagingDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (restored) {
      await rm(retiredDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw new GenerationFaultError(
      restored
        ? `the staged batch could not be swapped into ${proposedDir}: ${describeError(error)}; the previous batch was put back and nothing new was written`
        : `the staged batch could not be swapped into ${proposedDir}: ${describeError(error)}; the previous batch could NOT be fully put back and is preserved in ${retiredDir} for recovery by hand`,
      { cause: error },
    );
  }

  try {
    await rm(retiredDir, { recursive: true, force: true });
  } catch (error) {
    // Delegated decision 2026-09-26 (fail closed): the new batch is in place
    // and its manifest describes it, but a leftover of the previous one sits
    // beside it; a silent success would leave that for nobody to notice.
    throw new GenerationFaultError(
      `the new batch was written to ${proposedDir}, but the previous one could not be removed from ${retiredDir}: ${describeError(error)}; delete it by hand`,
      { cause: error },
    );
  }

  return { proposedDir, manifestPath, liveManifestPath, written };
}
