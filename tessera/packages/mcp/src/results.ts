// Exit code → tool result. This is the file where DEV-1 either survives the
// third output surface or quietly dies in it.
//
// GAP-ANALYSIS records the MCP error taxonomy as owed — the corpus states the
// constraint and never the mapping. The constraint is DEV-1: absence of evidence
// is an infrastructure fault, never a finding. Below is the mapping proposed to
// discharge it, and the one property every branch is written to keep:
//
//   **NO FAILURE MAY EVER RENDER AS AN EMPTY ANSWER.** "The instance refused the
//   read" and "nothing is impacted" are the same number of nodes and must never
//   be the same result. So a non-zero exit that carries no document produces
//   `isError: true` and NO `structuredContent` at all — there is nothing for a
//   caller to destructure a zero out of, and the text says in words that nothing
//   was measured.
//
// The exit vocabulary maps like this:
//
//   0  ok            → the report, `isError: false`
//   5  inconclusive  → the report, `isError: false`, PLUS a banner block
//   2  usage         → `isError: true`; the pipeline's own wording, verbatim
//   3  fault         → `isError: true`; DEV-1, spelled out
//   4  refused       → `isError: true`; a §11 guard spoke, and NOTHING WAS
//                      WRITTEN — a refusal, not a failure (see below)
//   1  noGo          → depends on the TOOL, which is the one place this file
//                      reads something other than the code (see below)
//
// **Why 5 is not an error.** The CLI's vocabulary already separates "partial
// evidence" (5) from "no evidence" (3), and collapsing that distinction at the
// MCP boundary would throw away the more useful of the two facts. What exit 5
// must not do is read as clean — so a banner block repeats the QA-9 sentence in
// prose, and it names the shortfall the way THIS document names it. That last
// part is not a nicety: `incomplete: true` and per-stage `notes` are how four of
// the six commands that can exit 5 carry it, and `tess doctor` and `tess
// preflight` carry neither — they say it through an undecided roll-up `status`
// instead. A banner promising fields the document never emitted sends a caller
// looking for keys that are not there, which is this file's own defect one level
// up. The banner goes SECOND, after the document: a client that parses
// `content[0].text` is a real client pattern, the incompleteness is carried by
// the document itself either way, and there is nothing to be gained by breaking
// the naive parse for emphasis a model reading both blocks does not need.
//
// **Why exit 1 is tool-dependent.** `resolve`, `impact` and `coverage` cannot
// return 1 — they answer questions rather than reaching verdicts — so a 1 out of
// them is a defect in the pipeline and is reported as one. `preflight` CAN, and
// there NOT READY is the answer, arrived at on purpose, with a full report
// attached. So can `run`, where the answer is a NO_GO and the tests are what
// reached it. `ToolSpec.reportsVerdict` carries the difference here, because the
// alternative is a table of command names in two files that must be kept in step.
//
// **Why a verdict-bearing 1 is READ as well as relayed.** The number is a lossy
// summary of the document behind it, and `tess run` is where the loss shows:
// its mapping is frozen at GO → 0 / everything else → 1, so INCONCLUSIVE has no
// exit of its own there and arrives as a 1. This file does not invent a 5 out of
// that — deciding what a verdict was is the pipeline's job — but it does read
// `verdict.status` and say so when the document and the number disagree. The
// mapping itself is owed against `packages/cli/src/commands/run.ts`; the
// misreading it would otherwise cause is not owed against anybody, because it
// happens here.
//
// A verdict-bearing 1 keeps its `structuredContent` — throwing away a report the
// caller needs in order to act would be its own kind of empty answer — but it is
// still `isError: true`. The reasoning is worth stating, because `isError: false`
// is defensible on the grounds that the tool did exactly what it was asked: a
// caller that branches on the success flag alone must not read NOT READY as a
// pass, and of the two ways to be wrong, "an error that was really a verdict"
// costs a second look while "a pass that was really a NO_GO" ships. The CLI makes
// the same call with the same asymmetry: exit 1 fails the build.
//
// **Why a repo-write success carries a banner.** `tess generate` ends its human
// report with the sentence that makes the whole DEV-4 envelope legible —
// "NOTHING HAS BEEN RUN and nothing has been promoted" — and its `--json`
// document does not: that document carries paths, counts and provenance, which
// read exactly like an artifact somebody could execute. This surface serves the
// document, so the sentence has to be re-attached here or the property survives
// in the CLI and dies at the MCP boundary. It is a BANNER rather than a field
// because the document belongs to the pipeline and this layer does not edit
// other people's reports, and it is keyed off `writeClass` rather than off a
// tool name for the reason the verdict branch is: a table of names in two files
// is a table that drifts.
//
// **Why a verdict-bearing 1 is read for UNDECIDED evidence too.** The collapsed
// verdict above is one instance of a wider shape: the CLI's roll-ups are
// ordered, and an undecided state loses to a proven failure everywhere they
// meet. `decideVerdict` puts `doctor.status === "unknown"` and
// `parity.status === "undecidable"` BELOW a hard failure, a parity mismatch and
// a not-ready runner (`packages/cli/src/commands/preflight.ts`), and
// `exitCodeForDoctor` maps a kind-gating hard failure to 1 even when the finding
// under it is undecided (DEV-2, and the doctor tool's description says so). Both
// are deliberate at the gate: the answer really is no. What they cost is the
// caveat — the SAME undecided evidence gets the incomplete banner at exit 5 and,
// once something worse outranks it, arrives at exit 1 with no mention anywhere.
// A reader of the prose is then told the report "names every check that did not
// hold" about a check nobody could run. So the NOT READY banner no longer claims
// that, and a second banner names the undecided roll-ups the document carries.
// Nothing is inferred: the fields are read, and only fields the document has.
//
// **Why a failure that carried no words says so.** Three of the failure
// headlines below promise the pipeline's own reasoning ("the reason follows
// verbatim", "the guard's own reasoning follows"), and that reasoning is
// relayed from stderr — so an empty stderr turned the promise into a sentence
// pointing at nothing, which is the empty answer this file exists to prevent,
// one level up. Every failure branch now either carries the pipeline's words or
// states in words that they did not arrive. Uniformly, rather than only on the
// branches that promise: which of them promises is a table, and a table drifts.
// For the same reason a failure relays whatever the command DID print. It is
// labelled as not-a-report and it is the only place the offending bytes of an
// unparseable document survive at all; a truncated relay says how much it cut.
//
// **Why exit 4 is also tool-dependent.** A §11 refusal reaching a tool that
// performs no instance write means the guard was consulted about a write nobody
// asked for — a defect. Reaching `preflight_apply` it means the system worked:
// the guard classified the runner, would not accept it as writable, and stopped
// before the writer existed. Both are errors; only one of them is a bug, and
// telling a caller to report a bug when the honest answer is "you may not write
// there" would send them looking in the wrong place. And a tool can be refused
// by something that is not the §11 guard at all: `tess cleanup` refuses a run
// that is not terminal (DEV-17) or not ephemeral (§4a) off its LOCAL record,
// before any mode is read, so even its plan tool meets a legitimate exit 4. A
// spec with a `refusalReading` supplies the paragraph for that reason, and the
// guard wording stays the default for every tool without one.
//
// **Why a mutating fault's remedy is per tool.** Exit 3 on a writer is never
// "call again", and what to read instead depends on what can be read back:
// `preflight_apply`'s state is on the instance (preflight_plan reads it), a
// cleanup's is in the run record (preflight_run_status and
// preflight_cleanup_plan read it). `faultRemedy` carries that paragraph; the
// "NOT PROOF THAT NOTHING WAS WRITTEN" sentence above it stays shared.
//
// **Why a relayed exit is read against the document.** `tess confirm` does not
// reach an exit of its own — it RELAYS the one a finished run recorded, so a 3
// or a 4 out of it can mean "the confirmed run faulted / was refused" (a fact,
// with a document) as well as "this call failed" (no document). The spec's
// `relaysRecordedExit` opts in, and only a parseable document whose own
// `exitCode` equals the process exit is read as the recorded one; anything else
// falls through to the ordinary failure wording, because a fault that happens
// to print something is still a fault.

import { EXIT_CODES } from "@tessera/cli";

import type { ToolWriteClass } from "./tools.js";

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

/**
 * A type alias rather than an interface, and not by accident: a `result` on the
 * wire is `Record<string, unknown>`, and TypeScript gives an implicit index
 * signature to an object type alias but not to an interface. Declaring this one
 * as an interface makes it unassignable to the response shape it exists to be.
 */
export type ToolResult = {
  readonly content: readonly TextContent[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
};

/** Everything one delegated `tess` run produced. */
export interface CommandOutcome {
  /** The MCP tool name, so a message can name what the caller actually called. */
  readonly tool: string;
  /** The `tess` subcommand, so it can also name what actually ran. */
  readonly command: string;
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** Copied from the `ToolSpec`; see the header for both of these. */
  readonly writeClass: ToolWriteClass;
  readonly reportsVerdict: boolean;
  /**
   * Also copied from the spec, and all three optional: see "Why a relayed exit
   * is read against the document" in the header, and `ToolSpec` for each.
   */
  readonly relaysRecordedExit?: boolean;
  readonly refusalReading?: string;
  readonly faultRemedy?: string;
}

function text(value: string): TextContent {
  return { type: "text", text: value };
}

/** Kept as its own block and labelled: it is diagnostics, not the report. */
function diagnostics(lines: readonly string[]): TextContent[] {
  const body = lines.join("\n").trim();
  return body === "" ? [] : [text(`diagnostics (stderr):\n${body}`)];
}

const NOT_AN_EMPTY_RESULT =
  "This is NOT an empty result. Nothing was measured, so it must not be reported as “nothing is impacted” or “no specs were found” — absence of evidence is a fault, never a finding (DEV-1).";

/**
 * The block that stands in for diagnostics that never came.
 *
 * A headline promising a reason, followed by nothing, is the same defect this
 * file is written against in miniature: the caller cannot tell "the pipeline
 * said nothing" from "this server dropped what it said". So the silence is
 * stated rather than left as a gap, and it is stated as a fact about stderr —
 * not as an excuse — because an exit that explains itself nowhere is worth
 * reporting on its own.
 */
function noDiagnostics(outcome: CommandOutcome): TextContent {
  return text(
    `no diagnostics (stderr): \`tess ${outcome.command}\` wrote nothing to stderr, so nothing above is the pipeline's own account of this exit — it is this server's reading of the exit code, and no reason for it arrived. Do not infer one.`,
  );
}

/**
 * How much of an unexpected stdout is relayed before it is cut.
 *
 * A cut is announced with the count it dropped, because a silently shortened
 * document reads as a complete one — and the branch that needs this most is the
 * unparseable report, where the bytes ARE the bug report.
 */
const STDOUT_RELAY_LIMIT = 4000;

/**
 * Whatever the command printed on a branch that has no document to show.
 *
 * Every failure path used to drop stdout entirely. On most of them it is empty
 * and this adds nothing; on the internal-fault path it is the whole evidence —
 * `missingReport` says the command "printed something that is not JSON" and
 * then discarded the something, leaving a caller with a defect they cannot
 * diagnose and no way to see that anything was withheld.
 */
function relayedStdout(outcome: CommandOutcome): TextContent[] {
  const body = outcome.stdout.join("\n").trim();
  if (body === "") return [];
  const dropped = body.length - STDOUT_RELAY_LIMIT;
  const note =
    dropped > 0
      ? `\n[cut here: ${dropped} of ${body.length} characters not shown]`
      : "";
  return [
    text(
      `stdout (NOT a report — the command did not exit with one):\n${body.slice(0, STDOUT_RELAY_LIMIT)}${note}`,
    ),
  ];
}

/**
 * The marker `tess` prints about a write that failed part-way — or nothing,
 * when it printed neither.
 *
 * `provisionAftermath` (`packages/cli/src/cli.ts`) writes `PARTIAL APPLY:` or
 * `APPLY UNVERIFIED:` to stderr, ahead of the "no evidence was produced" line
 * and on the same exit-3 branch, and stderr DOES reach a host through this
 * server: `captureContext` collects it into an array and `failed()` relays it
 * verbatim through `diagnostics()`. So the fault banner points at it by name
 * rather than paraphrasing it, and nothing here restates what the pipeline
 * already said.
 *
 * Conditional for the same reason `hasPlanSteps` is. Both markers come from the
 * provisioner, and only `tess preflight --mode apply` builds one;
 * `preflight_run` is mutating too and reaches this branch through
 * `runSkeleton`, which raises neither error. Naming them unconditionally would
 * send a run's caller looking for a line nobody wrote.
 */
function provisionAftermathMarker(outcome: CommandOutcome): string | undefined {
  const body = outcome.stderr.join("\n");
  return ["PARTIAL APPLY:", "APPLY UNVERIFIED:"].find((marker) =>
    body.includes(marker),
  );
}

/**
 * Which plan-identity refusal the pipeline printed, if any — `REFUSED (§6b)`
 * for a stale or missing digest, `REFUSED (ARCH-33)` for a key already bound
 * to another plan (`packages/cli/src/commands/preflight.ts`).
 */
function planIdentityRefusal(outcome: CommandOutcome): string | undefined {
  const body = outcome.stderr.join("\n");
  return ["§6b", "ARCH-33"].find((tag) => body.includes(`REFUSED (${tag})`));
}

/**
 * Which §4b run-ledger refusal `tess run` printed, if any —
 * `REFUSED (§4b concurrency): ` when another run holds the scope on this
 * runner, `REFUSED (§4b): ` when the run id names a run already used
 * (`packages/cli/src/cli.ts`).
 *
 * Delegated decision 2026-09-26: matched as the pipeline's exact prefix at the
 * START of a stderr line, case and colon included, and nothing looser. This
 * reading REMOVES the §11 allowlist advice, so it must be earned: a line that
 * merely quotes the tag, drops the colon or misspells the qualifier is not
 * this refusal, and falls through to the §11 wording (fail closed) — the
 * reading that was already there for every unrecognised exit 4.
 */
function runLedgerRefusal(
  outcome: CommandOutcome,
): "§4b" | "§4b concurrency" | undefined {
  for (const line of outcome.stderr) {
    const match = /^REFUSED \(§4b( concurrency)?\): /.exec(line);
    if (match !== null)
      return match[1] === undefined ? "§4b" : "§4b concurrency";
  }
  return undefined;
}

function failed(outcome: CommandOutcome, headline: string): ToolResult {
  const reason = diagnostics(outcome.stderr);
  return {
    content: [
      text(headline),
      ...(reason.length > 0 ? reason : [noDiagnostics(outcome)]),
      ...relayedStdout(outcome),
    ],
    isError: true,
  };
}

/**
 * The one branch that is a bug report rather than a mapping.
 *
 * `tess` returning a documented code with nothing on stdout, or with something
 * that is not a JSON object, cannot happen through any of these commands — each
 * writes exactly one `JSON.stringify` and returns. If it ever does, the failure
 * mode to avoid is obvious and severe: an empty document handed back as a
 * successful read, or a verdict with nothing behind it.
 */
function missingReport(outcome: CommandOutcome, why: string): ToolResult {
  return failed(
    outcome,
    [
      `INTERNAL FAULT — \`tess ${outcome.command} --json\` exited ${outcome.code} but ${why}.`,
      "",
      NOT_AN_EMPTY_RESULT,
    ].join("\n"),
  );
}

type DocumentOutcome =
  | {
      readonly ok: true;
      readonly document: string;
      readonly parsed: Record<string, unknown>;
    }
  | { readonly ok: false; readonly why: string };

/**
 * Read the one JSON object a `--json` run prints. Shared by the two branches
 * that hand a document back — success and a verdict-bearing NO_GO — so that a
 * report which fails to parse takes the same DEV-1 exit from both.
 */
function readDocument(stdout: readonly string[]): DocumentOutcome {
  const document = stdout.join("\n").trim();
  if (document === "") return { ok: false, why: "printed no report" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return { ok: false, why: "printed something that is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, why: "printed a JSON value that is not an object" };
  }
  return { ok: true, document, parsed: parsed as Record<string, unknown> };
}

/**
 * How THIS document says which part fell short — a fact about the document in
 * hand, not about the command that produced it.
 *
 * The banner asserted the first branch for every exit 5, and it was false on
 * half of them. Six commands can return 5: `resolve`, `impact`, `coverage` and
 * `generate` all publish `notes` and `incomplete` and the sentence was written
 * for them; `doctor` and `preflight` publish NEITHER — they carry the shortfall
 * in an undecided roll-up `status` (`worst(...) === "unknown"` in
 * `packages/cli/src/commands/doctor.ts`, `decideVerdict`'s `undecidable` and
 * `unknown` arms in `packages/cli/src/commands/preflight.ts`). So three of the
 * eight tools told a caller to read two keys their report never emitted. `tess
 * run` cannot reach 5 at all — its mapping is frozen at two codes — which is
 * why the collapsed-verdict banner exists further down.
 *
 * The `notes`/`incomplete` branch also tests the array's LENGTH, not just its
 * presence. `incomplete` is not a mirror of `notes`: `tess impact` computes it
 * as `graph.unanalyzable.length > 0 || notes.some(warning)`, so a report whose
 * only shortfall is an unanalyzable node arrives flagged with `notes: []`. The
 * first branch would have sent that caller to an empty array and let them
 * conclude nothing fell short, which is the opposite of what the flag says.
 *
 * Keyed on what the document CONTAINS rather than on a list of command names,
 * for the reason the proposal banner is keyed on `writeClass` and the NOT READY
 * banner reads `plan.steps` before mentioning them: a table of command names in
 * two files is a table that drifts, and a command added later that follows
 * either convention is covered without an edit here. It also degrades honestly
 * — a document that carries no shortfall marker at all gets a sentence saying
 * exactly that, rather than a confident pointer at nothing.
 */
function incompletenessCarrier(parsed: Record<string, unknown>): string {
  const notes = parsed["notes"];
  const flagged = parsed["incomplete"] === true;

  if (Array.isArray(notes) && notes.length > 0 && flagged) {
    return "Every stage that fell short said so in `notes`, and `incomplete` is true.";
  }

  if (flagged) {
    return "`incomplete` is true and this report's `notes` are EMPTY, so nothing here describes the shortfall in words. Do NOT read the empty `notes` as nothing having fallen short — the flag is computed from more than the notes (`tess impact` raises it on an unanalyzable node alone), so the counts and lists in the document are the only trace of what was left out.";
  }

  const undecided = undecidedStatusPaths(parsed);
  if (undecided.length > 0) {
    return `This report carries no per-stage \`notes\` and no \`incomplete\` flag — do not look for them. What could not be settled is named by its ROLL-UP instead: ${undecided.join(", ")}. Those are summaries rather than an inventory, so read the findings beneath them; a check nested deeper can be undecided without appearing in that list.`;
  }

  return "This report carries no per-stage `notes`, no `incomplete` flag and no roll-up that came back undecided, so the exit code is the only thing here that says the answer is partial. Treat the whole document as partial and do not infer WHICH part is missing — nothing in it names that.";
}

function incompleteBanner(
  outcome: CommandOutcome,
  parsed: Record<string, unknown>,
): TextContent {
  return text(
    [
      `INCOMPLETE (exit 5) — \`tess ${outcome.command}\` answered, but at least one stage could not answer in full.`,
      "",
      "The report above is real evidence and is NOT a measurement: an untraced artifact understates what the change reaches, and an unread spec overstates the gaps (QA-9).",
      "",
      incompletenessCarrier(parsed),
    ].join("\n"),
  );
}

/**
 * The DEV-4 sentence, re-attached to a document that does not carry it.
 *
 * It is written at the reader most likely to get this wrong — a host holding a
 * list of freshly written spec paths and a tool that runs specs — and it names
 * the missing step rather than merely warning: what is owed is a person reading
 * a diff, and no argument to anything here substitutes for it.
 */
function proposalBanner(outcome: CommandOutcome): TextContent {
  return text(
    [
      `PROPOSAL, NOT AN ARTIFACT TO RUN (DEV-4) — \`tess ${outcome.command}\` wrote files into the repository, and none of them is armed.`,
      "",
      "Generated specs land under `proposed/` and are indexed in `.manifest.proposed.json`. The live `.manifest.json` was never opened, and the spec inventory joins on THAT manifest rather than on file paths (QA-16), so what is on disk now is a set of files and not a set of tests. Nothing has been run, nothing counts as coverage and nothing has retired an existing test.",
      "",
      "The step this owes is a HUMAN one: somebody reads the diff in git and moves the entries into the live manifest. No tool on this server does that, and passing these paths to a tool that executes specs would skip the review the whole envelope exists for rather than automate it. Report what was proposed and where; do not describe it as ready, passing or promoted.",
    ].join("\n"),
  );
}

/**
 * Read `verdict.status` out of a report that has one.
 *
 * It exists because the CLI's exit code is a lossy summary of it — see the
 * collapsed-verdict banner below — and reading the document is the only way to
 * recover what the number dropped.
 */
function verdictStatusOf(parsed: Record<string, unknown>): string | undefined {
  const verdict = parsed["verdict"];
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict))
    return undefined;
  const status = (verdict as Record<string, unknown>)["status"];
  return typeof status === "string" ? status : undefined;
}

/**
 * Whether the report carries a NON-EMPTY provision plan the banner may point a
 * reader at.
 *
 * Presence of the key is not the question. `tess preflight --json` emits
 * `plan.steps` on every run, empty array included, so a presence test is true
 * for every preflight report and the banner would promise a remediation list
 * to a caller whose plan proposes nothing — a NOT READY whose blockers no write
 * can clear reads as one with a fix attached. The CLI's own report text guards
 * on `plan.steps.length > 0` for the same reason.
 */
function hasPlanSteps(parsed: Record<string, unknown>): boolean {
  const plan = parsed["plan"];
  if (typeof plan !== "object" || plan === null) return false;
  const steps = (plan as Record<string, unknown>)["steps"];
  return Array.isArray(steps) && steps.length > 0;
}

/**
 * The sentence about `plan.steps` is CONDITIONAL, and that is the whole reason
 * this function reads the document at all. `tess preflight` returns a plan;
 * `tess run` returns a run report and has no plan of any kind. Naming a field
 * that is not there would send a caller looking for it — a banner must not
 * assert a property the document lacks, for the same reason a comment must not.
 */
function notReadyBanner(
  outcome: CommandOutcome,
  parsed: Record<string, unknown>,
): TextContent {
  const plan = hasPlanSteps(parsed)
    ? ", and `plan.steps` lists what a provision would do about the ones a write can clear"
    : "";
  return text(
    [
      `NOT READY (exit 1) — \`tess ${outcome.command}\` reached a verdict, and the verdict is no.`,
      "",
      // "names every check that did not hold" is what this used to claim, and
      // it was not always true: an undecided check did not hold and was also
      // never checked, and the banner below is where that difference is stated.
      `This IS the answer and not a failure to produce one: the report above names the checks behind it${plan}. It is returned as an error result so that a caller reading only the success flag cannot mistake a NO_GO for a pass — nothing here was lost, the document is intact above and in \`structuredContent\`.`,
      "",
      "Calling again unchanged returns the same verdict. Something has to change first.",
    ].join("\n"),
  );
}

/**
 * QA-9's sentence, re-attached when the EXIT CODE threw it away.
 *
 * `tess run` is frozen at Phase 0.5's mapping — GO exits 0 and everything else
 * exits 1 — so an INCONCLUSIVE verdict arrives here wearing a NO_GO's number
 * (the debt is recorded against `packages/cli/src/commands/run.ts`, which is
 * where widening it belongs). The document still says INCONCLUSIVE, so nothing
 * is inferred here and no code is invented: the banner fires on what the report
 * SAYS, and only when it disagrees with what the number implies.
 *
 * Without it, the two answers QA-9 exists to keep apart — "we checked and it is
 * wrong" and "we could not check, so no green may be claimed" — reach a caller
 * as the same red, and a model summarising the call would report a test failure
 * that never happened.
 */
function collapsedVerdictBanner(outcome: CommandOutcome): TextContent {
  return text(
    [
      `INCONCLUSIVE, REPORTED AS EXIT 1 — \`tess ${outcome.command}\` says \`verdict.status\` is INCONCLUSIVE while its exit code says NO_GO.`,
      "",
      "That is not a contradiction to resolve, it is a known narrowing: this command's exit mapping is frozen at two outcomes, so QA-9's third one has no number of its own here. THE DOCUMENT IS RIGHT. Nothing was proven wrong — something could not be checked at all, so no green may be claimed and no failure may be reported either.",
      "",
      "Do not relay this as a failing test. Report what could not be decided, which the report names.",
    ].join("\n"),
  );
}

/**
 * The words the pipeline's roll-ups use for "nobody could decide".
 *
 * All three are somebody else's vocabulary, quoted: `unknown` is `DoctorStatus`
 * (`packages/doctor/src/types.ts`), `undecidable` is `ParityStatus`
 * (`packages/parity/src/types.ts`), `INCONCLUSIVE` is the run verdict. They are
 * listed rather than inferred because there is no way to tell an undecided
 * state from a failing one by shape, and guessing wrong in either direction
 * would be the same defect this banner exists to close.
 */
const UNDECIDED_STATUSES = new Set(["unknown", "undecidable", "INCONCLUSIVE"]);

/**
 * Every roll-up `status` in the document whose value is an undecided one.
 *
 * The rule is one axis, deliberately: a field literally NAMED `status`, at the
 * document root or one level inside a root object. That is where all four
 * documents put a roll-up — `status` (doctor), `doctor.status`, `parity.status`,
 * `verdict.status` — so no table of tool names or field paths is needed, and a
 * new command that follows the same convention is covered without an edit here.
 *
 * What it deliberately does NOT do is walk the whole document. Two reasons, and
 * both are about not making a claim the reader cannot check: a per-finding
 * `unknown` inside `instances[].findings[]` may be `not-applicable` to the
 * requested kinds and so not evidence behind THIS verdict at all, and `unknown`
 * is also a §11 classification (`runnerClassification.cls`) meaning something
 * entirely different. A deep string match would report both as undecided
 * evidence, which is a louder banner and a less true one.
 */
function undecidedStatusPaths(parsed: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const collect = (holder: Record<string, unknown>, prefix: string): void => {
    const status = holder["status"];
    if (typeof status === "string" && UNDECIDED_STATUSES.has(status)) {
      paths.push(`${prefix}status`);
    }
  };

  collect(parsed, "");
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      collect(value as Record<string, unknown>, `${key}.`);
    }
  }
  return paths;
}

/**
 * QA-9's other half: the undecided evidence an exit 1 kept but stopped naming.
 *
 * The collapsed-verdict banner covers the case where the VERDICT itself is
 * INCONCLUSIVE. This one covers the case where the verdict really is a no and
 * some of what it was reached over is undecided anyway — a hard failure, a
 * parity mismatch or a not-ready runner outranked it, so exit 5 never happened
 * and the incomplete banner never fired. Nothing about the verdict is disputed
 * here; what is added is the distinction the number and the exit-5 branch
 * between them threw away, so that a model summarising the call does not report
 * a check that came back blind as a check that came back failing.
 */
function undecidedEvidenceBanner(
  outcome: CommandOutcome,
  paths: readonly string[],
): TextContent {
  return text(
    [
      `UNDECIDED EVIDENCE UNDER A NO (QA-9) — \`tess ${outcome.command}\` exited 1, and part of what it looked at came back undecided rather than failed: ${paths.join(", ")}.`,
      "",
      "The verdict stands and this does not soften it: a stronger fact outranked the undecided ones, which is why the code is 1 and not 5. But they are not the same finding. An undecided check WAS NOT CHECKED — nothing about it was proven wrong, so it must not be relayed as a failure, and nothing about it was proven right either.",
      "",
      "Report what the verdict names as the failure. Report the fields named above as what nobody could establish, and say which is which.",
    ].join("\n"),
  );
}

/**
 * Map one finished command onto the result the caller sees.
 *
 * Note what is missing, the same way `cli.ts` notes it: there is no branch here
 * on which a non-zero exit other than 5 produces `isError: false`, and no branch
 * on which `structuredContent` is set without a document to put in it.
 */
/**
 * The document of a relaying command (see the header), when — and only when —
 * it says the exit it carries is the one the process returned.
 */
function recordedDocument(
  outcome: CommandOutcome,
):
  | { readonly document: string; readonly parsed: Record<string, unknown> }
  | undefined {
  if (outcome.relaysRecordedExit !== true) return undefined;
  const report = readDocument(outcome.stdout);
  if (!report.ok || report.parsed["exitCode"] !== outcome.code)
    return undefined;
  return { document: report.document, parsed: report.parsed };
}

function recordedExitBanner(outcome: CommandOutcome): TextContent {
  const what =
    outcome.code === EXIT_CODES.fault
      ? "an INFRASTRUCTURE FAULT (DEV-1, exit 3) — it produced no verdict"
      : "a REFUSAL (exit 4) — it was stopped before it acted";
  return text(
    [
      `RECORDED OUTCOME (exit ${outcome.code}) — \`tess ${outcome.command}\` read the run's persisted result, and that run ended in ${what}.`,
      "",
      "This call WORKED: the exit code is the run's, relayed, and the document above is its record. There is no verdict to confirm and so no confirm token — report the run as not confirmed, never as ready. Nothing was re-run to get this answer, and calling again returns the same record.",
    ].join("\n"),
  );
}

function recordedInconclusiveBanner(outcome: CommandOutcome): TextContent {
  return text(
    [
      `INCONCLUSIVE (exit 5) — \`tess ${outcome.command}\` read the run's record, and it does not confirm a verdict.`,
      "",
      "Either the run recorded an INCONCLUSIVE verdict (QA-9: something could not be checked, so no green may be claimed) or it has persisted no result yet — the document's `state` and `verdict` say which. Nothing was re-run to find out. Do not report the run as ready.",
    ].join("\n"),
  );
}

export function toolResultFor(outcome: CommandOutcome): ToolResult {
  if (
    outcome.code === EXIT_CODES.ok ||
    outcome.code === EXIT_CODES.inconclusive
  ) {
    const report = readDocument(outcome.stdout);
    if (!report.ok) return missingReport(outcome, report.why);

    return {
      // The serialised document is repeated in `content` on purpose: the
      // specification asks a tool that returns structured content to also return
      // it as text, and a host that ignores `structuredContent` would otherwise
      // show the caller an empty answer to a successful read.
      content: [
        text(report.document),
        // DECIDED AGAINST, not merely not done: the undecided-evidence banner
        // is NOT attached here. At exit 5 the incomplete banner already says
        // it, and at exit 0 the CLI's own roll-ups make an undecided status
        // unreachable — `decideVerdict` returns 5 for every one of them, and a
        // green that carried one would be a defect in that function rather than
        // a caveat to print here. Firing on a 0 would say "part of this could
        // not be decided" about a document that reached ok BECAUSE everything
        // was decided, which is a claim, not a safeguard.
        ...(outcome.code === EXIT_CODES.inconclusive
          ? [
              outcome.relaysRecordedExit === true
                ? recordedInconclusiveBanner(outcome)
                : incompleteBanner(outcome, report.parsed),
            ]
          : []),
        // After the incompleteness, because a caller who was told the work list
        // may be short still has to be told that none of it is armed.
        ...(outcome.writeClass === "repo-write"
          ? [proposalBanner(outcome)]
          : []),
        ...diagnostics(outcome.stderr),
      ],
      structuredContent: report.parsed,
      isError: false,
    };
  }

  if (outcome.code === EXIT_CODES.noGo && outcome.reportsVerdict) {
    const report = readDocument(outcome.stdout);
    // A verdict with no report behind it is not a verdict — it falls through to
    // the same internal-fault wording an empty success would get, rather than
    // being relayed as a NO_GO nobody can act on.
    if (!report.ok) return missingReport(outcome, report.why);

    // The stronger banner wins the field it speaks to: when the VERDICT is the
    // undecided thing, the one below says so in full, and repeating
    // `verdict.status` in a list of undecided roll-ups underneath it would read
    // as a second, separate problem.
    const collapsed = verdictStatusOf(report.parsed) === "INCONCLUSIVE";
    const undecided = undecidedStatusPaths(report.parsed).filter(
      (path) => !(collapsed && path === "verdict.status"),
    );

    return {
      content: [
        text(report.document),
        notReadyBanner(outcome, report.parsed),
        // After the verdict, because a caller who has just been told the answer
        // is no has to be told next that it might not be a no at all.
        ...(collapsed ? [collapsedVerdictBanner(outcome)] : []),
        // And last of the three, because it qualifies the evidence rather than
        // the answer: the verdict stands either way.
        ...(undecided.length > 0
          ? [undecidedEvidenceBanner(outcome, undecided)]
          : []),
        ...diagnostics(outcome.stderr),
      ],
      structuredContent: report.parsed,
      isError: true,
    };
  }

  if (outcome.code === EXIT_CODES.usage) {
    return failed(
      outcome,
      [
        `INVALID REQUEST (exit 2) — \`tess ${outcome.command}\` refused the arguments and did not run.`,
        "",
        "Nothing was read and nothing was measured. The reason follows verbatim from the pipeline, which is the layer that owns it.",
      ].join("\n"),
    );
  }

  if (
    outcome.code === EXIT_CODES.fault ||
    outcome.code === EXIT_CODES.refused
  ) {
    const recorded = recordedDocument(outcome);
    if (recorded !== undefined) {
      return {
        content: [
          text(recorded.document),
          recordedExitBanner(outcome),
          ...diagnostics(outcome.stderr),
        ],
        structuredContent: recorded.parsed,
        isError: true,
      };
    }
  }

  if (outcome.code === EXIT_CODES.fault) {
    const headline = `INFRASTRUCTURE FAULT (DEV-1, exit 3) — \`tess ${outcome.command}\` could not produce evidence.`;

    if (outcome.writeClass !== "mutating") {
      return failed(
        outcome,
        [
          headline,
          "",
          NOT_AN_EMPTY_RESULT,
          "",
          "Fix the cause and call again; do not treat this as an answer about the change.",
        ].join("\n"),
      );
    }

    const marker = provisionAftermathMarker(outcome);
    return failed(
      outcome,
      [
        headline,
        "",
        NOT_AN_EMPTY_RESULT,
        "",
        `IT IS ALSO NOT PROOF THAT NOTHING WAS WRITTEN. ${outcome.tool} writes, and this exit says only that no evidence came back: the writes may never have started, may have landed part-way, or may have reported success the instance never confirmed. Nothing in this result tells those apart.${marker === undefined ? "" : ` The diagnostics above carry \`${marker}\` — that is the pipeline's own account of what became of the write, and it outranks anything inferred from the exit code.`}`,
        "",
        outcome.faultRemedy ??
          "So “fix the cause and call again” is NOT the remedy here. Establish the state with a read first, then report that and let the operator decide whether to call this tool again. Do not retry it to find out: a second call is a re-execution and not a replay.",
      ].join("\n"),
    );
  }

  if (outcome.code === EXIT_CODES.refused) {
    // A tool that can be refused by more than the §11 guard says what its
    // refusal means itself, and the headline then names no guard it may not
    // have met (see the header).
    if (outcome.refusalReading !== undefined) {
      return failed(
        outcome,
        [
          `REFUSED (exit 4) — \`tess ${outcome.command}\` declined before it acted.`,
          "",
          outcome.refusalReading,
        ].join("\n"),
      );
    }

    // Written as "not the mutating one" rather than "the read-only ones": a
    // repo-write tool constructs no guard either, so a §11 refusal reaching it
    // is the same defect, and a binary test would have quietly filed it under
    // "the runner may not be written to" — about a runner it never touched.
    if (outcome.writeClass !== "mutating") {
      return failed(
        outcome,
        [
          `REFUSED (§11, exit 4) — a guard stopped \`tess ${outcome.command}\` before it acted.`,
          "",
          `The guard's own reasoning follows. ${outcome.tool} asks for no instance write at all, so a refusal here means the guard disagrees with that claim — treat it as a defect worth reporting, not as a finding about the change.`,
        ].join("\n"),
      );
    }

    // Since `planHash` and `idempotencyKey` reached `preflight_apply` (decision
    // 7), a writer can also be refused by the §6b/ARCH-33 plan-identity checks,
    // which are not the guard and are lifted by the CALLER, not the operator.
    // Read off the pipeline's own prefix, as the aftermath marker is: telling
    // that caller to go and ask for an allowlist would be the wrong place.
    const planRefusal = planIdentityRefusal(outcome);
    if (planRefusal !== undefined) {
      return failed(
        outcome,
        [
          `REFUSED (${planRefusal}, exit 4) — \`tess ${outcome.command}\` would not apply this plan under this key, and stopped before the first write.`,
          "",
          "NOTHING WAS WRITTEN. The plan was recomputed and could not be bound to this call: the reviewed `planHash` is stale (§6b — the instance moved since the plan was read), the plan carries no digest its writes could be journalled under (§6b), or the `idempotencyKey` already belongs to a different plan (ARCH-33). The pipeline's words say which.",
          "",
          "This is a REFUSAL, not a failure. Call preflight_plan again, review what changed, and report it; a new apply needs the new hash and, if a key is sent, a key not already used for another plan.",
        ].join("\n"),
      );
    }

    // Delegated decision 2026-09-26: a writer can also be refused by the §4b
    // run ledger — another run holds this scope on this runner, or the run id
    // names a run already used. Neither is the guard and neither is lifted by
    // the operator's §11.2 configuration, so this reading names neither. Read
    // off the pipeline's own prefix (see `runLedgerRefusal`), and scoped to
    // writers: a read-only tool refused at all keeps the defect reading above.
    // `preflight_run` gets no `refusalReading` for this, because a spec-wide
    // paragraph would also replace its GENUINE §11 refusals.
    const ledgerRefusal = runLedgerRefusal(outcome);
    if (ledgerRefusal !== undefined) {
      const cause =
        ledgerRefusal === "§4b concurrency"
          ? "another run holds this scope on this runner (DESIGN §4b: a second run is rejected, never queued)"
          : "the run id is being reused: it names a run the ledger already holds, and a used run is not resumed";
      return failed(
        outcome,
        [
          `REFUSED (${ledgerRefusal}, exit 4) — \`tess ${outcome.command}\` declined at the §4b run ledger before any stage ran: ${cause}.`,
          "",
          "NOTHING WAS RUN AND NOTHING WAS WRITTEN. No stage ran, no writer was built and the ledger was not written (`RunConcurrencyRefusedError` / `RunResumeRefusedError` in `@tessera/core`), so there is nothing of this call to undo or reconcile. The run it names is untouched.",
          "",
          "This is a REFUSAL, not a failure, and retrying it unchanged changes nothing. Read the run the pipeline names below with preflight_run_status (`tess status --run-id <id>`): wait for a live run to finish, clean up a terminal one with preflight_cleanup_plan / preflight_cleanup_apply, or call again with a run id no earlier run used.",
        ].join("\n"),
      );
    }

    return failed(
      outcome,
      [
        `REFUSED (§11, exit 4) — the target guard would not accept the runner as writable, and \`tess ${outcome.command}\` stopped before the writer was built.`,
        "",
        "NOTHING WAS WRITTEN. Not partially, not to a different instance: the §11.1 classification happens before the single mutation channel exists, so there is no half-applied plan to undo and no state to reconcile.",
        "",
        "This is a REFUSAL, not a failure — the run did not break, it was declined. Retrying it unchanged changes nothing, and it says nothing about whether the change is good.",
        "",
        "The only thing that lifts it is the operator's §11.2 configuration on the machine running this server, which is deliberately not reachable from any tool argument here (SEC-2: an agent may propose a write, never authorise one). The guard's own reasoning follows.",
      ].join("\n"),
    );
  }

  if (outcome.code === EXIT_CODES.noGo) {
    return failed(
      outcome,
      [
        `UNEXPECTED VERDICT (exit 1) — \`tess ${outcome.command}\` returned a NO_GO.`,
        "",
        `${outcome.tool} holds no evidence with which to fail a build: a resolution lists artifacts, an impact graph answers a question, a coverage gap is a hole in a plan rather than a statement about the code, and a proposed spec has not been run at all (QA-8). A 1 out of this command is a defect in the pipeline and must not be relayed as a verdict about the change.`,
      ].join("\n"),
    );
  }

  return failed(
    outcome,
    [
      `UNKNOWN EXIT (${outcome.code}) — \`tess ${outcome.command}\` returned a code this server has no vocabulary for.`,
      "",
      NOT_AN_EMPTY_RESULT,
    ].join("\n"),
  );
}
