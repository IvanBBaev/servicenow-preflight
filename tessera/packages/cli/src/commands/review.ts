// `tess review` — record that a named human reviewed a promoted unit spec's
// exact body (PA-10 fix 3).
//
// Promotion stays a human act (DEV-4): moving an entry from
// `.manifest.proposed.json` into `.manifest.json` is not a tool's job, and
// this command does not do it. What it adds is the confirm step after that
// move: the reviewer has READ the body, and says so with their identity. The
// command then writes `review: { bodySha256, reviewer }` onto that spec's
// `.manifest.json` entry, and `tess run --live` refuses any unit spec whose
// current body does not hash to the recorded digest (`specReview.ts` — the
// canonical form is defined there, once).
//
// THE REVIEWER IS STATED, NEVER INFERRED. `--reviewer <id>` is required and
// has no default: not `git config user.name`, not `$USER`, not the CLI
// context's `actor`. An identity filled in silently is an identity nobody
// attested to, which is the one thing the record exists to carry. It is an
// attestation recorded in a reviewed file, not authentication — a commit that
// edits the manifest can forge it, exactly as it could forge a promotion; git
// history and code review over `.manifest.json` remain the control on that.
//
// The body is held to the same TM-3 gate the live loader applies before the
// digest is recorded: a body the gate refuses is never marked reviewed (exit
// 4, nothing written). The command reads and writes the local repo only — it
// opens no instance connection, and it is not exposed through the MCP server
// (a review is a human's act, not an agent's).
//
// Exit codes: 0 recorded, 2 usage (bad flags, unknown or non-unit spec, a
// manifest this command cannot safely edit), 3 fault (a registry that could
// not be read or written), 4 a TM-3 refusal.

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  readSpecInventory,
  SPEC_MANIFEST_FILENAME,
  SPEC_REVIEWER_PATTERN,
  SpecInputError,
  type SpecReviewRecord,
} from "@tessera/specs";

import type { CliContext } from "../context.js";
import { EXIT_CODES, type ExitCode } from "../exitCodes.js";
import {
  formatRejectedSpecs,
  gateUnitSpecBody,
  isInside,
  type RejectedSpec,
} from "../liveSpecs.js";
import { canonicalSpecBody, specBodySha256 } from "../specReview.js";

/** The `--json` result kind. */
export const REVIEW_RESULT_KIND = "tessera.review";

interface ReviewArgs {
  testsRoot?: string;
  reviewer?: string;
  specs: string[];
  json: boolean;
}

function usage(context: CliContext, message: string): ExitCode {
  context.stderr(`tess: ${message}`);
  context.stderr("");
  context.stderr("Run `tess review --help` for usage.");
  return EXIT_CODES.usage;
}

function parseReviewArgs(
  argv: readonly string[],
): { kind: "error"; message: string } | { kind: "ok"; args: ReviewArgs } {
  const args: ReviewArgs = { specs: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--json") {
      args.json = true;
      continue;
    }
    if (flag !== "--tests-root" && flag !== "--reviewer" && flag !== "--spec") {
      return { kind: "error", message: `unknown flag ${JSON.stringify(flag)}` };
    }
    const raw = argv[index + 1];
    index += 1;
    if (raw === undefined || raw.trim() === "") {
      return { kind: "error", message: `${flag} expects a value` };
    }
    if (flag === "--spec") {
      args.specs.push(raw);
    } else if (flag === "--tests-root") {
      if (args.testsRoot !== undefined) {
        return { kind: "error", message: "--tests-root given more than once" };
      }
      args.testsRoot = raw;
    } else {
      if (args.reviewer !== undefined) {
        return { kind: "error", message: "--reviewer given more than once" };
      }
      args.reviewer = raw;
    }
  }
  return { kind: "ok", args };
}

/** One recorded review, as printed and as `--json` reports it. */
interface RecordedReview extends SpecReviewRecord {
  readonly id: string;
  readonly path: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `tess review --tests-root <dir> --spec <id> [--spec <id>]... --reviewer <id>`
 */
export async function reviewCommand(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const parsed = parseReviewArgs(argv);
  if (parsed.kind === "error") return usage(context, parsed.message);
  const { args } = parsed;
  if (args.testsRoot === undefined) {
    return usage(
      context,
      "review needs --tests-root <dir>: the manifest there is the one the review is recorded in",
    );
  }
  if (args.reviewer === undefined) {
    return usage(
      context,
      "review needs --reviewer <id>: the reviewer is stated explicitly and is never taken from git config or $USER",
    );
  }
  if (!SPEC_REVIEWER_PATTERN.test(args.reviewer)) {
    return usage(
      context,
      `--reviewer ${JSON.stringify(args.reviewer)} is not a valid reviewer id (1-128 characters of A-Z a-z 0-9 . _ @ + -, starting with a letter or digit)`,
    );
  }
  if (args.specs.length === 0) {
    return usage(
      context,
      "review needs at least one --spec <id>: name each spec you reviewed",
    );
  }
  const wanted = [...new Set(args.specs)];
  const reviewer = args.reviewer;
  const root = path.resolve(context.cwd, args.testsRoot);

  let inventory;
  try {
    inventory = await readSpecInventory({ root });
  } catch (error) {
    // `SpecStoreFaultError` propagates: `cli.ts` renders it as a fault (exit 3).
    if (error instanceof SpecInputError) {
      return usage(
        context,
        `${error.message} (--tests-root ${args.testsRoot})`,
      );
    }
    throw error;
  }

  // Validate every named spec before reading any body, so a typo in the third
  // id does not leave the first two half-processed.
  const byId = new Map(inventory.specs.map((spec) => [spec.ref.id, spec]));
  for (const id of wanted) {
    const spec = byId.get(id);
    if (spec === undefined) {
      return usage(
        context,
        `spec ${JSON.stringify(id)} is not registered in ${path.join(root, SPEC_MANIFEST_FILENAME)} — promote it into the manifest first (DEV-4), then review it`,
      );
    }
    if (spec.kind !== "unit") {
      return usage(
        context,
        `spec ${JSON.stringify(id)} is a ${spec.kind} spec; only unit specs are projected by \`run --live\`, so only they carry a review record`,
      );
    }
  }

  const recorded: RecordedReview[] = [];
  const rejected: RejectedSpec[] = [];
  for (const id of wanted) {
    const spec = byId.get(id);
    if (spec === undefined) continue; // validated above
    const file = path.resolve(root, spec.ref.path);
    if (!isInside(root, file)) {
      throw new Error(
        `spec \`${spec.ref.id}\` resolves outside the tests root (${spec.ref.path})`,
      );
    }
    // Gated and hashed in the canonical form `run --live` projects.
    const body = canonicalSpecBody(await readFile(file, "utf8"));
    const verdict = gateUnitSpecBody(spec, body);
    if (!verdict.ok) {
      rejected.push({
        id: spec.ref.id,
        path: spec.ref.path,
        violations: verdict.violations,
      });
      continue;
    }
    recorded.push({
      id: spec.ref.id,
      path: spec.ref.path,
      bodySha256: specBodySha256(body),
      reviewer,
    });
  }
  if (rejected.length > 0) {
    context.stderr("");
    context.stderr(
      `REFUSED (TM-3): ${rejected.length} spec(s) under ${args.testsRoot} failed the generated-code gate; a body \`run --live\` would refuse is not recorded as reviewed, and nothing was written`,
    );
    for (const line of formatRejectedSpecs(rejected)) context.stderr(line);
    context.stderr("");
    return EXIT_CODES.refused;
  }

  // Edit the manifest as JSON: the inventory validated it, but it is re-read
  // here so every field this command does not own is carried through as is.
  const manifestPath = path.join(root, SPEC_MANIFEST_FILENAME);
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isPlainObject(manifest) || !Array.isArray(manifest.specs)) {
    // The inventory accepted this file a moment ago; a different shape now is
    // a concurrent edit, not the operator's argument.
    throw new Error(`${manifestPath} changed while it was being reviewed`);
  }
  const entries: unknown[] = manifest.specs;
  for (const review of recorded) {
    const matches = entries.filter(
      (entry) => isPlainObject(entry) && entry.id === review.id,
    );
    if (matches.length !== 1) {
      // The inventory keeps the first VALID entry for a duplicated id, which
      // need not be the first textual one; guessing which entry to stamp
      // would record a review against a spec the operator may not have read.
      return usage(
        context,
        `spec ${JSON.stringify(review.id)} appears ${matches.length} times in ${manifestPath}; remove the duplicates before recording a review`,
      );
    }
    const entry = matches[0] as Record<string, unknown>;
    entry.review = { bodySha256: review.bodySha256, reviewer: review.reviewer };
  }
  // Write-then-rename, so a crash never leaves a truncated registry behind.
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temporary, manifestPath);

  if (args.json) {
    context.stdout(
      JSON.stringify({ kind: REVIEW_RESULT_KIND, reviewed: recorded }),
    );
  } else {
    for (const review of recorded) {
      context.stdout(
        `reviewed ${review.id} (${review.path}): sha256 ${review.bodySha256} by ${review.reviewer}`,
      );
    }
  }
  return EXIT_CODES.ok;
}
