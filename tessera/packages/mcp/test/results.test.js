// Exit code → tool result, as a pure function.
//
// `server.test.js` drives these branches end to end wherever the pipeline can
// actually be made to reach them. Two cannot be reached that way and are the
// reason this file exists:
//
//   * **exit 3 out of a preflight tool.** The doctor turns an unreadable
//     precondition into `unknown` (exit 5), parity turns an unfingerprintable
//     artifact into `undecidable` (exit 5), and the §11.2 probe catches its own
//     transport failures and downgrades the classification rather than throwing.
//     So no fault injected into the fake produces a 3 out of `tess preflight` —
//     but `cli.ts` maps an unexpected throw to one, and the day something does
//     escape, the MUTATING tool must not be the one that says nothing about it.
//   * **a documented exit with no document behind it.** Impossible through the
//     commands as written, which is exactly why it is worth pinning: if it ever
//     happens, the failure to avoid is a verdict nobody can act on being handed
//     back as though it were one.
//
// Those two are why the file was started; they are not all it holds now. The
// banners this surface wraps a document in are pinned here and, for several of
// them, NOWHERE ELSE: `server.test.js` names UNDECIDED EVIDENCE, INCONCLUSIVE
// REPORTED AS EXIT 1, INTERNAL FAULT, the truncation note and the
// no-diagnostics block zero times between them. A rewrite that dropped one of
// those is caught by the cases below or by nothing at all.
//
// (The comment was corrected, not the assertions: this paragraph used to say
// the whole file asserted "one property in six shapes". That was its scope
// before the banner cases arrived, and counting shapes had stopped being true.)
//
// The property under all of them is unchanged: NO FAILURE RENDERS AS AN EMPTY
// ANSWER, a §11 refusal renders as a refusal rather than as a fault, and an
// undecided check is never relayed as one that failed (QA-9).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, LIVE_RESULT_KIND } from "@tessera/cli";

import {
  APPLY_TOOL,
  CLEANUP_APPLY_TOOL,
  CLEANUP_PLAN_TOOL,
  CONFIRM_READY_TOOL,
  DOCTOR_TOOL,
  GENERATE_TOOL,
  IMPACT_TOOL,
  PLAN_TOOL,
  RUN_TOOL,
  toolResultFor,
} from "../build/index.js";

/** One finished run, spelled the way `dispatch.ts` spells it. */
function outcome(spec, code, options = {}) {
  return {
    tool: spec.name,
    command: spec.command,
    code,
    stdout: options.stdout ?? [],
    stderr: options.stderr ?? [],
    writeClass: spec.writeClass,
    reportsVerdict: spec.reportsVerdict,
    // Copied only when present, exactly as `callTool` spreads them.
    ...(spec.relaysRecordedExit ? { relaysRecordedExit: true } : {}),
    ...(spec.refusalReading ? { refusalReading: spec.refusalReading } : {}),
    ...(spec.faultRemedy ? { faultRemedy: spec.faultRemedy } : {}),
  };
}

const REPORT = { mode: "apply", verdict: { exitCode: 0 } };

/**
 * What `jsonRunReport` actually prints, trimmed to the fields these cases read.
 *
 * `runner.cls` and `verdict.status` are the two that matter: the first is the
 * §11 classification the run was permitted under, the second is the answer —
 * and the second is the one `tess run`'s exit code cannot carry in full.
 */
const runReport = (status) => ({
  runId: "run-20260202T030405-abcd1234",
  instance: { name: "runner", host: "dev-mcp-runner.service-now.com" },
  runner: { cls: "sub-prod", role: "runner" },
  lifecycle: "ephemeral",
  verdict: { status, exitCode: status === "GO" ? 0 : 1 },
  failures:
    status === "NO_GO" ? [{ spec: "amount.spec", assertion: "total" }] : [],
});

const printed = (value) => [JSON.stringify(value, null, 2)];

/**
 * What `tess preflight --json` prints, trimmed to the roll-ups these cases read.
 *
 * `verdict.status` is REAL and it is derived. The comment here used to say the
 * field did not exist, and that the collapsed-verdict banner therefore could
 * never fire for this command; the field arrived, the conclusion survived, and
 * the stated reason did not — which is the same defect as a banner that is true
 * for a reason that has changed. `preflightCommand` builds the field with
 * `verdictLabel(verdict)` and then returns `verdict.exitCode`, so the label and
 * the number come out of ONE value and cannot disagree. Firing the banner needs
 * `verdict.status === "INCONCLUSIVE"` beside an exit of 1, and the only verdict
 * carrying that label is the one that exits 5.
 *
 * So the fixture derives its label the way the command does, and the case below
 * asserts the absence rather than this comment claiming it. `kinds` is a real
 * `TestKind` for the same reason: "server" is not one, and a fixture that could
 * not have been printed is not evidence about what happens to a printed one.
 */
const preflightReport = (doctorStatus, parityStatus, extra = {}) => ({
  mode: "plan",
  kinds: ["unit"],
  doctor: { status: doctorStatus, findings: [] },
  parity: { status: parityStatus, summary: "compared 2 artifacts" },
  plan: { readiness: [], actions: [], steps: [], blockers: [], applied: false },
  verdict: {
    exitCode: 1,
    reason: "the runner is not ready",
    status: "NOT READY",
  },
  ...extra,
});

/**
 * What `tess doctor --json` prints: a roll-up at the root, per-instance below.
 *
 * Both `hardFailure`s, because there are two and they are not the same field.
 * The per-instance one names the kind and the missing precondition; the ROOT one
 * is the half of `exitCodeForDoctor`'s decision that used to be unpublished, is
 * `null` rather than absent when there is none, and is the field the tool's own
 * description sends a caller to read. A fixture carrying only the nested one
 * would let this suite pass over a surface that had lost the root.
 */
const doctorReport = (status, findingStatus) => {
  const hardFailure = "ui was requested and the Test Runner is not available";
  return {
    kinds: ["ui"],
    instances: [
      {
        role: "runner",
        profile: "runner",
        host: "dev-mcp-runner.service-now.com",
        status,
        findings: [
          {
            id: "atf-runner",
            status: findingStatus,
            applicability: "required",
          },
        ],
        hardFailure,
      },
    ],
    status,
    hardFailure: `runner: ${hardFailure}`,
  };
};

/**
 * What `tess generate --json` prints when part of the analysis fell short.
 *
 * `notes` and `incomplete` are the point of it: generation is one of the four
 * commands that carry a shortfall in those two fields, and this fixture is what
 * the doctor and preflight fixtures above are contrasted against.
 */
const generateReport = () => ({
  kind: "unit",
  specs: [{ id: "amount.spec", path: "proposed/amount.spec.ts" }],
  notes: [{ stage: "impact", note: "one artifact could not be traced" }],
  incomplete: true,
  executed: false,
  promoted: false,
  counts: { impacted: 3, proposed: 2 },
});

/**
 * What `tess impact --json` prints when a node could not be analysed.
 *
 * The fixture exists for ONE property of the real command: `isIncomplete` in
 * `packages/impact/src/types.ts` is
 * `graph.unanalyzable.length > 0 || notes.some(warning)`, so `incomplete` can
 * be true while `notes` is EMPTY. That is not a contrived shape — it is what a
 * table the resolver refused to walk produces, and no other command in the
 * suite can produce it, which is why the generate fixture above cannot stand in
 * for it.
 */
const impactReport = () => ({
  graph: {
    nodes: [{ id: "u_amount", type: "table" }],
    edges: [],
    unanalyzable: [
      { id: "u_legacy", reason: "consumer table refused analysis" },
    ],
  },
  notes: [],
  incomplete: true,
  counts: { impacted: 1, unanalyzable: 1 },
});

/**
 * QA-9's sentence in the incompleteness banner, which every exit 5 keeps.
 *
 * What varies between the branches below is HOW the document names its
 * shortfall; that it must not be read as a measurement does not vary, so a
 * branch that grew its own wording for this would be the drift the banner was
 * split to prevent.
 */
const QA9_SENTENCE =
  /real evidence and is NOT a measurement[\s\S]*overstates the gaps \(QA-9\)/;

/**
 * The DEV-1 disclaimer, BOTH halves.
 *
 * `NOT_AN_EMPTY_RESULT` is two sentences carrying two different commitments:
 * the first says what the result is not, the second says what a reader must not
 * turn it into — "nothing is impacted", "no specs were found". Matching only
 * the first left the operative half deletable with every case here still green.
 * `server.test.js` covers the second half on the exit-3 branch; the INTERNAL
 * FAULT and UNKNOWN EXIT branches appear in no other suite, so this file is the
 * only thing standing under them.
 *
 * Prose-pinned by necessity — the commitment is a sentence — and it will need
 * editing by hand if that sentence is ever rewritten.
 */
const DEV1_DISCLAIMER =
  /This is NOT an empty result\.[\s\S]*absence of evidence is a fault, never a finding \(DEV-1\)/;

/**
 * Every sentence in `body` that COMMANDS a retry.
 *
 * A negative anchor on the exact sentence "Fix the cause and call again" is a
 * spell-checker: the regression worth catching is somebody re-introducing that
 * instruction to a WRITER in their own words — "Resolve the underlying problem
 * and invoke the tool again", "Retry once the cause is fixed" — and every one of
 * those walks past a quoted string.
 *
 * So the shape is matched instead of the wording, on two conditions that have to
 * hold together: the sentence opens with an imperative verb, and it asks for
 * another attempt. Capitalisation carries real weight in the first condition and
 * is not an accident of style — an imperative at the head of a sentence is
 * capitalised, and a lowercase `call again` inside quotation marks is a MENTION
 * of the instruction rather than the instruction. That is exactly how the
 * mutating branch talks about it.
 *
 * The colon and semicolon are sentence boundaries here because the wording this
 * guards against used one: "Fix the cause and call again; do not treat this as
 * an answer" is two clauses, and splitting on the full stop alone would hand the
 * scanner a "do not" that belongs to the other half.
 *
 * Returned as a list rather than a boolean so a case can assert the POSITIVE
 * control too. An anchor that fires nowhere is anchored to nothing, and the
 * read-only branch is where this one must fire.
 */
const RETRY_COMMAND =
  /^\s*(?:So |Then |Now |)(?:Fix|Correct|Resolve|Repair|Address|Clear|Retry|Rerun|Re-run|Reissue|Call|Invoke|Run|Try|Attempt|Repeat|Resend|Submit)\b/;
const ANOTHER_ATTEMPT =
  /\bagain\b|\bretry\b|\bre-?run\b|\bonce more\b|\ba second time\b|\brepeat\b/i;

const retryInstructions = (body) =>
  body
    .split(/(?<=[.:;!?])\s+/)
    .filter(
      (sentence) =>
        RETRY_COMMAND.test(sentence) && ANOTHER_ATTEMPT.test(sentence),
    );

// On the anchors below. Most match a stable noun a caller acts on: a headline,
// a capitalised phrase, a field path, a block label, a block count. A few match
// a sentence because the commitment IS a sentence — an instruction not to relay
// something, or a negative assertion against wording that was deliberately
// removed, which has nothing but that wording to recognise it by. Those are
// marked PROSE-PINNED at the site. They are meant to be updated alongside any
// rewrite of the sentence they quote; that is the trade, not an oversight.

describe("@tessera/mcp — the exit-code mapping", () => {
  it("renders a fault as a fault for the mutating tool too", () => {
    const result = toolResultFor(
      outcome(APPLY_TOOL, EXIT_CODES.fault, {
        stderr: ["tess preflight: the instance never answered"],
      }),
    );

    assert.equal(result.isError, true);
    // Nothing to destructure a zero — or a false — out of.
    assert.equal("structuredContent" in result, false);
    assert.match(
      result.content[0].text,
      /INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );
    assert.match(result.content[0].text, DEV1_DISCLAIMER);
    // A fault is not a refusal: nothing declined this, something broke.
    assert.equal(/REFUSED/.test(result.content[0].text), false);
    // Anchored at the start of the block, and the pipeline's words are checked
    // to be in it. Unanchored, `/diagnostics \(stderr\)/` also matches the
    // `no diagnostics (stderr)` fallback — so it stayed green through exactly
    // the regression it was here to catch: stderr arriving relayed nowhere.
    assert.match(result.content[1].text, /^diagnostics \(stderr\)/);
    assert.match(result.content[1].text, /the instance never answered/);
  });

  it("does not tell a fault out of a WRITER to fix it and call again", () => {
    // This assertion replaces one that pinned `/Fix the cause and call again/`
    // on this exact call, and the replacement is the point. That anchor was
    // written to assert the BEHAVIOUR, so it held the two surfaces apart while
    // they contradicted each other: `preflight_apply`'s own description ends
    // "do not retry this tool to find out", and the banner four lines from it
    // said to call again. Renumbering the old case to keep it green would have
    // pinned the contradiction; the contract is what is pinned instead.
    //
    // The reason the read-only remedy is wrong here is not politeness. Exit 3
    // out of a writer says no EVIDENCE came back — it says nothing about
    // whether the writes landed, and "call again" on a half-applied plan with
    // no plan hash and no idempotency key is a second execution, not a replay.
    const writer = toolResultFor(
      outcome(APPLY_TOOL, EXIT_CODES.fault, {
        stderr: ["tess preflight: the instance never answered"],
      }),
    );
    const reader = toolResultFor(
      outcome(DOCTOR_TOOL, EXIT_CODES.fault, {
        stderr: ["tess doctor: the instance never answered"],
      }),
    );

    // The positive control comes first: the scanner has to FIND the instruction
    // where it belongs, or its silence on the writer proves nothing at all.
    assert.deepEqual(retryInstructions(reader.content[0].text), [
      "Fix the cause and call again;",
    ]);
    assert.deepEqual(retryInstructions(writer.content[0].text), []);

    // What the writer gets instead, and each line is a separate commitment.
    // First: "nothing was measured" is not "nothing was written" — a caller
    // told only the DEV-1 sentence is free to conclude the instance is clean.
    assert.match(writer.content[0].text, /NOT PROOF THAT NOTHING WAS WRITTEN/);
    assert.match(writer.content[0].text, /may have landed part-way/);
    // Second: the remedy is a READ, and it is the same one the tool's own
    // description names — two surfaces, one instruction.
    assert.match(writer.content[0].text, /preflight_plan/);
    assert.match(writer.content[0].text, /let the operator decide/);
    // Third: why calling again is not merely unhelpful but unsafe.
    assert.match(writer.content[0].text, /re-execution and not a replay/);
    // And the reader keeps everything it had: this branch was split, not moved.
    assert.match(reader.content[0].text, DEV1_DISCLAIMER);
    assert.doesNotMatch(reader.content[0].text, /NOTHING WAS WRITTEN/);
  });

  it("names the pipeline's own account of a half-applied write when it has one", () => {
    // `provisionAftermath` in `packages/cli/src/cli.ts` prints `PARTIAL APPLY:`
    // or `APPLY UNVERIFIED:` to stderr on this same exit-3 branch, and stderr
    // reaches a host through this server — `captureContext` collects it and
    // `failed()` relays it verbatim. So the banner points at a line the caller
    // can actually see in the block below it.
    //
    // Conditional, and the negative half is the load-bearing one: only
    // `tess preflight --mode apply` builds a provisioner. `preflight_run` is
    // mutating too and reaches this branch through `runSkeleton`, which raises
    // neither error — naming the marker unconditionally would send a run's
    // caller hunting for a line nobody wrote, which is the defect this whole
    // file is written against.
    const partial = toolResultFor(
      outcome(APPLY_TOOL, EXIT_CODES.fault, {
        stderr: [
          "PARTIAL APPLY: 2 of 5 planned write(s) already landed on the runner.",
        ],
      }),
    );
    const unverified = toolResultFor(
      outcome(APPLY_TOOL, EXIT_CODES.fault, {
        stderr: ["APPLY UNVERIFIED: the read-back never answered."],
      }),
    );
    const silent = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.fault, {
        stderr: ["tess run: the runner never answered"],
      }),
    );

    assert.match(partial.content[0].text, /`PARTIAL APPLY:`/);
    assert.match(partial.content[0].text, /outranks anything inferred/);
    assert.match(unverified.content[0].text, /`APPLY UNVERIFIED:`/);
    // The stderr line itself is still relayed, unparaphrased, in its own block —
    // the banner names the marker, it does not restate what the pipeline said.
    assert.match(partial.content[1].text, /2 of 5 planned write\(s\)/);

    // No marker printed, no marker named — and the rest of the writer's banner
    // is still there, so "silent" cannot be satisfied by having lost the branch.
    assert.doesNotMatch(
      silent.content[0].text,
      /PARTIAL APPLY|APPLY UNVERIFIED/,
    );
    // The marker names are not what enforces the conditional; the SENTENCE
    // that promises one is. A conditional that stopped being conditional
    // renders "The diagnostics above carry `undefined`", which names neither
    // marker and so clears the assertion above while sending a run's caller
    // hunting for a line nobody wrote — the exact defect the branch exists to
    // avoid. So the promise itself is pinned, positive control first.
    const AFTERMATH_PROMISE = /The diagnostics above carry/;
    assert.match(partial.content[0].text, AFTERMATH_PROMISE);
    assert.match(unverified.content[0].text, AFTERMATH_PROMISE);
    assert.doesNotMatch(silent.content[0].text, AFTERMATH_PROMISE);
    // ...and no absent marker is ever rendered as a word, whatever frames it.
    assert.doesNotMatch(silent.content[0].text, /undefined/);
    assert.match(silent.content[0].text, /NOT PROOF THAT NOTHING WAS WRITTEN/);
    assert.deepEqual(retryInstructions(silent.content[0].text), []);
  });

  it("reads exit 3 out of the repo-writing tool as a plain fault", () => {
    // The exit-4 branch is written as "not the mutating one" rather than "the
    // read-only ones", and carries a comment saying why; exit 3 above is
    // written the same way and nothing pinned it. `tess generate` writes spec
    // files into the repo and asks for no instance write, so the aftermath
    // banner is false about it clause by clause: no plan was half-applied,
    // nothing "may have landed part-way" on a runner it never called, and
    // sending its caller to `preflight_plan` to establish the state points at
    // the wrong machine. The read-only remedy is the true one here — nothing
    // was promoted (DEV-4), so calling again after the fix is a first
    // execution and not a second.
    const result = toolResultFor(
      outcome(GENERATE_TOOL, EXIT_CODES.fault, {
        stderr: ["tess generate: the coverage input could not be read"],
      }),
    );

    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /^INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );
    // The scanner is proved silent on the writer two cases above, so its
    // finding the instruction here is the assertion and not a formality.
    assert.deepEqual(retryInstructions(result.content[0].text), [
      "Fix the cause and call again;",
    ]);
    // And none of the instance-write aftermath, clause by clause.
    assert.doesNotMatch(
      result.content[0].text,
      /NOT PROOF THAT NOTHING WAS WRITTEN/,
    );
    assert.doesNotMatch(result.content[0].text, /may have landed part-way/);
    assert.doesNotMatch(result.content[0].text, /preflight_plan/);
    assert.doesNotMatch(
      result.content[0].text,
      /re-execution and not a replay/,
    );
  });

  it("renders a fault as a fault for the read-only doctor as well", () => {
    // `preflight_doctor` cannot be made to exit 3 against the fake for the very
    // reason quoted above — it IS the doctor that downgrades to `unknown`. But
    // it is also the one tool a caller reaches for when an instance is misbehaving,
    // so the day something does escape, "no diagnosis" must not arrive looking
    // like a clean bill of health.
    const result = toolResultFor(
      outcome(DOCTOR_TOOL, EXIT_CODES.fault, {
        stderr: ["tess doctor: the instance never answered"],
      }),
    );

    assert.equal(result.isError, true);
    assert.equal("structuredContent" in result, false);
    assert.match(
      result.content[0].text,
      /INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );
    assert.match(result.content[0].text, DEV1_DISCLAIMER);
    // Anchored, and matched against what stderr actually said — see the case
    // above for what the unanchored version let through.
    assert.match(result.content[1].text, /^diagnostics \(stderr\)/);
    assert.match(result.content[1].text, /the instance never answered/);
  });

  it("reads exit 4 as a refusal for the tool that asked to write", () => {
    const result = toolResultFor(
      outcome(APPLY_TOOL, EXIT_CODES.refused, {
        stderr: ['REFUSED (§11): the runner classifies "unknown"'],
      }),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^REFUSED \(§11, exit 4\)/);
    assert.match(result.content[0].text, /NOTHING WAS WRITTEN/);
    assert.match(result.content[0].text, /not a failure/);
    assert.equal(/defect/.test(result.content[0].text), false);
  });

  it("reads the same exit 4 as a defect for a tool that asked for nothing", () => {
    const result = toolResultFor(outcome(PLAN_TOOL, EXIT_CODES.refused));

    // Same code, different reading, and the difference is the point: a guard
    // refusing a read-only run means the guard was consulted about something
    // that asked for no write, and telling the caller to check an allowlist
    // would send them to fix a configuration that is not the problem.
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^REFUSED \(§11, exit 4\)/);
    // Both halves of the reading, which do different work: report this as a
    // bug, AND do not read it as evidence about the change. Anchored on the
    // nouns — "treat it as a defect" also pinned the verb it was phrased with,
    // and a rewrite to "report it as a defect" is not a change of contract.
    assert.match(result.content[0].text, /asks for no instance write/);
    assert.match(result.content[0].text, /\bdefect\b/);
    assert.match(result.content[0].text, /not as a finding/);
    assert.equal(/NOTHING WAS WRITTEN/.test(result.content[0].text), false);
  });

  it("reads exit 4 as a defect for the repo-writing tool too", () => {
    // `tess generate` constructs no guard and asks for no instance write, so a
    // §11 refusal reaching it is a wiring bug rather than a permission the
    // operator withheld. The branch keys off "did this ask to write an
    // INSTANCE", not off "is this read-only" — otherwise the day generation
    // exits 4 the caller would be sent to edit an allowlist that is irrelevant.
    const result = toolResultFor(outcome(GENERATE_TOOL, EXIT_CODES.refused));

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^REFUSED \(§11, exit 4\)/);
    // The message names the tool the caller actually called, and says of THAT
    // tool that it asked for no instance write. ("at all" was emphasis; the
    // claim is the same without it.)
    assert.match(result.content[0].text, /preflight_generate/);
    assert.match(result.content[0].text, /asks for no instance write/);
    assert.match(result.content[0].text, /\bdefect\b/);
    assert.equal(/NOTHING WAS WRITTEN/.test(result.content[0].text), false);
  });

  it("carries the proposal banner on an INCOMPLETE repo write as well", () => {
    // The dangerous combination: partial evidence AND files on disk. Both
    // warnings have to survive, because "incomplete" is about the work list and
    // "not promoted" is about the specs — dropping either leaves a true
    // statement that reads as permission to run them.
    //
    // The fixture carries `notes` and `incomplete` because a real generate
    // document at exit 5 carries both (`packages/cli/src/commands/generate.ts`
    // writes them field by field). It used to be `{counts:{proposed:2}}` alone,
    // which was never a document this command could print — and once the banner
    // started reading the document, that fixture silently began exercising a
    // different branch than the one this case is named after.
    const result = toolResultFor(
      outcome(GENERATE_TOOL, EXIT_CODES.inconclusive, {
        stdout: printed(generateReport()),
      }),
    );

    assert.equal(result.isError, false);
    assert.match(result.content[1].text, /INCOMPLETE \(exit 5\)/);
    assert.match(result.content[2].text, /PROPOSAL, NOT AN ARTIFACT TO RUN/);
  });

  // ── the incompleteness banner describes THIS document ─────────────────────

  it("points at `notes` and `incomplete` on a document that has them", () => {
    // Four of the six commands that can exit 5 carry the shortfall this way —
    // resolve, impact, coverage and generate — and this sentence was written for
    // them. It is kept verbatim rather than generalised: a caller told to read
    // two named keys can go and read them, which is strictly more than a caller
    // told the answer is partial.
    const result = toolResultFor(
      outcome(GENERATE_TOOL, EXIT_CODES.inconclusive, {
        stdout: printed(generateReport()),
      }),
    );

    assert.match(
      result.content[1].text,
      /Every stage that fell short said so in `notes`, and `incomplete` is true\./,
    );
    // QA-9's sentence is the part of this banner that is the same on every
    // command, and it is the reason the banner exists at all.
    assert.match(result.content[1].text, QA9_SENTENCE);
  });

  it("does not point at an empty `notes` as though it named the shortfall", () => {
    // THE DEFECT THIS CLOSES. The branch above tested `Array.isArray(notes)`,
    // which an EMPTY array satisfies, and then asserted "every stage that fell
    // short said so in `notes`". `tess impact` computes `incomplete` as
    // `graph.unanalyzable.length > 0 || notes.some(warning)`
    // (`packages/impact/src/types.ts`), so a change whose consumer table
    // refused analysis exits 5 with `unanalyzable` populated and `notes: []`.
    // A caller sent to `notes` reads an empty array and concludes nothing fell
    // short — an absence of evidence relayed as evidence of absence, one turn
    // after the exit code said the answer was partial (DEV-1).
    const result = toolResultFor(
      outcome(IMPACT_TOOL, EXIT_CODES.inconclusive, {
        stdout: printed(impactReport()),
      }),
    );

    assert.equal(result.isError, false);
    assert.match(result.content[1].text, /INCOMPLETE \(exit 5\)/);
    assert.match(result.content[1].text, QA9_SENTENCE);
    // The claim that must not be made about this document.
    assert.doesNotMatch(
      result.content[1].text,
      /Every stage that fell short said so in `notes`/,
      "the notes are empty; nothing in them said anything",
    );
    // And what has to be said instead — the two halves that make it actionable
    // rather than merely not-false: the flag is real, and the empty array is
    // not the answer to it.
    assert.match(result.content[1].text, /`notes` are EMPTY/);
    assert.match(
      result.content[1].text,
      /Do NOT read the empty `notes` as nothing having fallen short/,
    );
  });

  it("does not promise `notes` to a doctor report that never emits them", () => {
    // The defect this closes. The banner asserted the `notes`/`incomplete`
    // sentence for EVERY exit 5, and `tess doctor` publishes neither field —
    // its `--json` document is kinds/instances/status/hardFailure and nothing
    // else. Three of the eight tools were sending a caller to read two keys
    // that were never there, which is this file's own defect one level up.
    const result = toolResultFor(
      outcome(DOCTOR_TOOL, EXIT_CODES.inconclusive, {
        stdout: printed(doctorReport("unknown", "unknown")),
      }),
    );

    assert.equal(result.isError, false);
    assert.match(result.content[1].text, /INCOMPLETE \(exit 5\)/);
    assert.match(result.content[1].text, QA9_SENTENCE);
    // PROSE-PINNED, and widened past the exact old sentence: the claim coming
    // back as "each shortfall is listed in `notes`" would be the same defect in
    // other words, so the field names are what is forbidden here.
    assert.doesNotMatch(result.content[1].text, /\bin `notes`\b/);
    assert.doesNotMatch(result.content[1].text, /`incomplete` is true/);
    // And what replaced it: the field the doctor DOES carry the shortfall in,
    // named as the root roll-up it is, plus the warning that a roll-up is a
    // summary rather than an inventory.
    assert.match(result.content[1].text, /carries no per-stage `notes`/);
    assert.match(result.content[1].text, /ROLL-UP instead: status\b/);
    assert.match(result.content[1].text, /read the findings beneath them/);
  });

  it("names every undecided roll-up a preflight report carries at exit 5", () => {
    // The other command that publishes neither field. Here there are two
    // roll-ups to name and they are not interchangeable: `doctor.status` says a
    // precondition could not be established, `verdict.status` says the gate as a
    // whole reached no decision. A banner naming one of them would be true and
    // still short.
    const result = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.inconclusive, {
        stdout: printed(
          preflightReport("unknown", "match", {
            verdict: {
              exitCode: 5,
              reason: "the doctor could not decide",
              status: "INCONCLUSIVE",
            },
          }),
        ),
      }),
    );

    assert.match(result.content[1].text, /INCOMPLETE \(exit 5\)/);
    assert.match(result.content[1].text, QA9_SENTENCE);
    assert.doesNotMatch(result.content[1].text, /\bin `notes`\b/);
    assert.match(result.content[1].text, /doctor\.status/);
    assert.match(result.content[1].text, /verdict\.status/);
    // Not the roll-up that decided: `parity.status` is "match" here, and a
    // banner that listed a settled field among the unsettled ones would be
    // louder and less true — the same trade the undecided-evidence banner makes.
    assert.doesNotMatch(result.content[1].text, /parity\.status/);
  });

  it("says the document names no shortfall rather than pointing at nothing", () => {
    // The honest degradation, and the reason the banner reads the document
    // instead of consulting a table of command names: a document that carries
    // neither convention gets a sentence saying exactly that. A table would have
    // had to guess, and both guesses are a claim the reader cannot check —
    // "read `notes`" sends them to a missing key, and naming a roll-up that
    // decided sends them to a settled one.
    const result = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.inconclusive, {
        stdout: printed(preflightReport("ready", "match")),
      }),
    );

    assert.match(result.content[1].text, /INCOMPLETE \(exit 5\)/);
    assert.match(result.content[1].text, QA9_SENTENCE);
    assert.doesNotMatch(result.content[1].text, /\bin `notes`\b/);
    assert.doesNotMatch(result.content[1].text, /ROLL-UP instead/);
    assert.match(
      result.content[1].text,
      /the exit code is the only thing here that says the answer is partial/,
    );
    assert.match(result.content[1].text, /do not infer WHICH part is missing/);
  });

  it("attaches no proposal banner to a tool that wrote no files", () => {
    const result = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.ok, {
        stdout: [JSON.stringify(REPORT, null, 2)],
      }),
    );

    // Keyed off the write class rather than the tool name, and this is the
    // assertion that the key is the right one: a read-only success says nothing
    // about promotion, because there is nothing to promote.
    //
    // The absence is only worth asserting beside what IS there. On its own it
    // also held for a result carrying no document at all — the failure this
    // whole file is written against — so the success is pinned first.
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, REPORT);
    assert.equal(result.content.length, 1);
    assert.equal(
      JSON.stringify(result).includes("PROPOSAL, NOT AN ARTIFACT"),
      false,
    );
  });

  it("keeps the report on a verdict-bearing NO_GO and still errors", () => {
    const result = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.noGo, {
        stdout: [JSON.stringify(REPORT, null, 2)],
      }),
    );

    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, REPORT);
    assert.match(result.content[1].text, /NOT READY \(exit 1\)/);
  });

  it("refuses to relay a verdict with no report behind it", () => {
    const result = toolResultFor(outcome(APPLY_TOOL, EXIT_CODES.noGo));

    // A NO_GO nobody can act on is an empty answer wearing a verdict's clothes.
    assert.equal(result.isError, true);
    assert.equal("structuredContent" in result, false);
    assert.match(result.content[0].text, /INTERNAL FAULT/);
    assert.match(result.content[0].text, /printed no report/);
    assert.match(result.content[0].text, DEV1_DISCLAIMER);
  });

  // ── the run tool: exit 1 is the routine answer ────────────────────────────

  it("renders a NO_GO run as a finding that carries the run's own record", () => {
    const report = runReport("NO_GO");
    const result = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.noGo, { stdout: printed(report) }),
    );

    // The assertion this case exists to make is NOT `code === 1`. A number
    // cannot tell a failing test from an outage, and DEV-1's whole point is that
    // absence of evidence must never read as either. So the claim is that the
    // EVIDENCE came back: the run's outcome record, intact.
    assert.deepEqual(result.structuredContent, report);
    assert.equal(result.structuredContent.verdict.status, "NO_GO");
    assert.equal(result.structuredContent.failures.length, 1);
    // Including the §11 classification the run was allowed under — the record
    // says which instance was written to and what class it was found to be.
    assert.equal(result.structuredContent.runner.cls, "sub-prod");
    // Still an error result, for the apply tool's reason: a caller branching on
    // the success flag alone must not read a NO_GO as a pass.
    assert.equal(result.isError, true);
    assert.match(result.content[1].text, /NOT READY \(exit 1\)/);
    // And it is a verdict, not a malfunction and not a permission problem.
    const wire = JSON.stringify(result);
    assert.equal(/INFRASTRUCTURE FAULT/.test(wire), false);
    assert.equal(/REFUSED/.test(wire), false);
  });

  it("names `plan.steps` only when the plan actually proposes a step", () => {
    // Three documents, because the banner's condition has three answers and the
    // middle one was wrong.
    //
    // No plan at all is `tess run`, and it was the original defect: the banner
    // promised a provision plan unconditionally, so a caller sent looking for
    // `plan.steps` in a run report found nothing and could not tell absence
    // from a bug.
    //
    // AN EMPTY PLAN IS THE DEFECT THIS CLOSES. `tess preflight --json` emits
    // `plan.steps` on every run — `packages/cli/src/commands/preflight.ts`
    // builds the key unconditionally — so testing for the key's PRESENCE was
    // true of every preflight report, empty ones included. A NOT READY whose
    // blockers no write can clear was told that `plan.steps` "lists what a
    // provision would do about the ones a write can clear", and the list is
    // empty: the caller reads a remediation route that does not exist, and the
    // report's real message — that this one needs a human — is the part that
    // gets lost. The CLI's own text guards on `plan.steps.length > 0`; this
    // banner did not.
    const withoutPlan = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.noGo, {
        stdout: printed(runReport("NO_GO")),
      }),
    );
    const withEmptyPlan = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.noGo, {
        stdout: printed({ ...REPORT, plan: { steps: [], applied: false } }),
      }),
    );
    const withPlan = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.noGo, {
        stdout: printed({
          ...REPORT,
          plan: {
            steps: [{ table: "sys_atf_test", action: "create" }],
            applied: false,
          },
        }),
      }),
    );

    assert.equal(/plan\.steps/.test(withoutPlan.content[1].text), false);
    assert.match(withoutPlan.content[1].text, /NOT READY \(exit 1\)/);
    // An empty plan is a plan-shaped absence, and reads exactly like the
    // no-plan case: still a NOT READY, still no pointer at a list.
    assert.equal(/plan\.steps/.test(withEmptyPlan.content[1].text), false);
    assert.match(withEmptyPlan.content[1].text, /NOT READY \(exit 1\)/);
    // And the pointer survives where it is earned, so the fix is a narrowing
    // rather than a deletion.
    assert.match(withPlan.content[1].text, /plan\.steps/);
  });

  it("tells a NO_GO from a fault and from an inconclusive by evidence alone", () => {
    // The three answers `tess run` can give a caller, side by side. Two of them
    // leave the CLI wearing the SAME exit code — the Phase-0.5 mapping is frozen
    // at GO -> 0 / everything else -> 1, so INCONCLUSIVE has no number of its
    // own (owed against `packages/cli/src/commands/run.ts`). If this surface
    // read the number and nothing else, the first two rows would be identical.
    const noGo = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.noGo, {
        stdout: printed(runReport("NO_GO")),
      }),
    );
    const inconclusive = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.noGo, {
        stdout: printed(runReport("INCONCLUSIVE")),
      }),
    );
    const fault = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.fault, {
        stderr: ["tess run: the runner never answered"],
      }),
    );

    // Same exit code, different answers, and the documents say which is which.
    assert.equal(noGo.structuredContent.verdict.status, "NO_GO");
    assert.equal(inconclusive.structuredContent.verdict.status, "INCONCLUSIVE");
    // QA-9's sentence is re-attached where the exit code dropped it, so a caller
    // reading prose rather than JSON is not told a test failed when none did.
    //
    // PROSE-PINNED, the last two deliberately: "no green may be claimed" is a
    // quotation of QA-9's own words (`packages/cli/src/exitCodes.ts` uses the
    // same phrase), and the instruction not to relay this as a failure is the
    // commitment itself — there is no noun underneath it to anchor on instead.
    assert.match(
      inconclusive.content[2].text,
      /INCONCLUSIVE, REPORTED AS EXIT 1/,
    );
    assert.match(inconclusive.content[2].text, /no green may be claimed/);
    assert.match(
      inconclusive.content[2].text,
      /Do not relay this as a failing test/,
    );
    // The NO_GO gets no such banner: it means what its number says.
    assert.equal(noGo.content.length, 2);
    assert.equal(/INCONCLUSIVE/.test(JSON.stringify(noGo)), false);

    // And the fault is the one that carries NO evidence at all — the difference
    // an exit-code-only reading destroys, because 3 and 1 are both "not zero".
    assert.equal("structuredContent" in fault, false);
    assert.match(
      fault.content[0].text,
      /INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );
    assert.match(fault.content[0].text, DEV1_DISCLAIMER);
    // A fault is not a refusal: nothing declined this run, something broke.
    assert.equal(/REFUSED/.test(fault.content[0].text), false);
  });

  it("reads exit 4 out of the run tool as a refusal, like the other writer", () => {
    // The second mutating tool takes the same branch as the first, because the
    // branch keys off `writeClass` rather than off a tool name. This is the
    // assertion that adding a writer did not need the taxonomy edited.
    const result = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.refused, {
        stderr: ['REFUSED (§11): the runner classifies "unknown"'],
      }),
    );

    assert.equal(result.isError, true);
    assert.equal("structuredContent" in result, false);
    assert.match(result.content[0].text, /^REFUSED \(§11, exit 4\)/);
    assert.match(result.content[0].text, /NOTHING WAS WRITTEN/);
    assert.match(result.content[0].text, /SEC-2/);
    // Not a defect: this tool DOES ask to write, so the guard was consulted
    // about exactly the thing it exists to decide. Widened to the word, so a
    // rephrased defect reading cannot arrive here past the old sentence.
    assert.equal(/\bdefect\b/.test(result.content[0].text), false);
  });

  it("returns a GO run as a plain success, with no banner attached", () => {
    const report = runReport("GO");
    const result = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.ok, { stdout: printed(report) }),
    );

    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, report);
    assert.equal(result.structuredContent.verdict.status, "GO");
    // One content block: the document. No proposal banner (nothing was written
    // to the repo), no incompleteness banner, no verdict banner.
    assert.equal(result.content.length, 1);
    assert.equal(
      /PROPOSAL, NOT AN ARTIFACT/.test(JSON.stringify(result)),
      false,
    );
  });

  it("has no vocabulary for an undocumented code, and says so", () => {
    const result = toolResultFor(outcome(APPLY_TOOL, 42));

    assert.equal(result.isError, true);
    assert.equal("structuredContent" in result, false);
    assert.match(result.content[0].text, /UNKNOWN EXIT \(42\)/);
    assert.match(result.content[0].text, DEV1_DISCLAIMER);
  });

  // ── undecided evidence under a no ─────────────────────────────────────────

  it("names the undecided roll-ups a NO_GO outranked", () => {
    // The exact collapse: `decideVerdict` ranks a not-ready runner ABOVE an
    // undecided doctor, so this document exits 1 rather than 5 — and the exit-5
    // branch, which is where the incomplete banner lives, never runs. Without
    // this banner the caller is handed a verdict and no hint that part of the
    // evidence under it was never established.
    const result = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.noGo, {
        stdout: printed(preflightReport("unknown", "undecidable")),
      }),
    );

    assert.equal(result.isError, true);
    assert.match(
      result.content[2].text,
      /UNDECIDED EVIDENCE UNDER A NO \(QA-9\)/,
    );
    // Both roll-ups, named as fields the caller can go and read.
    assert.match(result.content[2].text, /doctor\.status/);
    assert.match(result.content[2].text, /parity\.status/);
    assert.match(result.content[2].text, /WAS NOT CHECKED/);
    // The verdict is not softened — it is still an error and still a no.
    // PROSE-PINNED: "the verdict stands" is the caveat's own limit, and a
    // caveat that does not state its limit is the softening it must not be.
    assert.match(result.content[1].text, /NOT READY \(exit 1\)/);
    assert.match(result.content[2].text, /The verdict stands/);
  });

  it("no longer claims a NO_GO report names every check that did not hold", () => {
    // The sentence was true of a report whose every check reached a decision and
    // false of one carrying an `unknown`, and a reader cannot tell which they
    // have. Drawing the distinction is the UNDECIDED EVIDENCE banner's job — it
    // arrives in the block after this one — so the flat claim is gone from the
    // NOT READY banner whichever kind of report it describes. (Comment fixed,
    // not the assertions: "the banner above" pointed backwards at a banner that
    // is emitted after this one, in a file where "above" also reads as "the
    // previous case".)
    const result = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.noGo, {
        stdout: printed(preflightReport("unknown", "match")),
      }),
    );

    // PROSE-PINNED, unavoidably: a guard against wording that was deliberately
    // removed has nothing but that wording to recognise. Widened past the exact
    // old sentence, because the over-claim returning as "names every check that
    // failed" would be the same defect wearing different words.
    assert.equal(/did not hold/.test(result.content[1].text), false);
    assert.equal(/names every/.test(result.content[1].text), false);
    // And what replaced it: the report is the evidence behind the verdict,
    // claimed without claiming the evidence is complete.
    assert.match(result.content[1].text, /names the checks behind it/);
    assert.match(result.content[2].text, /doctor\.status/);
    assert.equal(/parity\.status/.test(result.content[2].text), false);
  });

  it("names the doctor's own root roll-up when DEV-2 forced its exit 1", () => {
    // `exitCodeForDoctor` maps a kind-gating hard failure to 1 even when the
    // finding under it is undecided — deliberate, and the tool's description
    // says so. What the description cannot do is reach a caller reading only
    // this payload, where "the verdict is no" was the only sentence on offer.
    const result = toolResultFor(
      outcome(DOCTOR_TOOL, EXIT_CODES.noGo, {
        stdout: printed(doctorReport("unknown", "unknown")),
      }),
    );

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "unknown");
    assert.match(result.content[2].text, /UNDECIDED EVIDENCE UNDER A NO/);
    // The ROOT roll-up, named as the root: `status` with no object in front of
    // it. `/: status\./` pinned the punctuation the path list happens to be
    // joined and ended with, and would have gone red on a reformat that changed
    // no commitment; these two pin what the case is actually about — the field
    // is named, and it is not named as though it were nested.
    const headline = result.content[2].text.split("\n")[0];
    assert.match(headline, /\bstatus\b/);
    assert.equal(/\.status\b/.test(headline), false);
  });

  it("attaches no such banner when every roll-up reached a decision", () => {
    const result = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.noGo, {
        stdout: printed(preflightReport("not-ready", "mismatch")),
      }),
    );

    // A no that is entirely a no gets no caveat: the banner has to be silent
    // here or it says nothing anywhere. Pinned against the two blocks that DO
    // belong, so "silent" cannot be satisfied by a result that lost the verdict
    // along with the caveat.
    assert.equal(result.content.length, 2);
    assert.match(result.content[1].text, /NOT READY \(exit 1\)/);
    assert.equal(/UNDECIDED EVIDENCE/.test(JSON.stringify(result)), false);
  });

  it("reads roll-ups only, not every `unknown` in the document", () => {
    // Two decoys that a deep string match would report and this must not: a
    // per-finding `unknown` inside an array may be `not-applicable` to the
    // requested kinds, and `runnerClassification.cls` is a §11 CLASSIFICATION —
    // "unknown" there means the guard could not place the instance, which is a
    // different fact with a different remedy. Naming either as undecided
    // evidence behind the verdict would be a louder banner and a false one.
    const doctor = toolResultFor(
      outcome(DOCTOR_TOOL, EXIT_CODES.noGo, {
        stdout: printed(doctorReport("not-ready", "unknown")),
      }),
    );
    const preflight = toolResultFor(
      outcome(APPLY_TOOL, EXIT_CODES.noGo, {
        stdout: printed(
          preflightReport("not-ready", "match", {
            runnerClassification: { cls: "unknown", evidence: [] },
          }),
        ),
      }),
    );

    // Each decoy result still has to BE the verdict-bearing pair — the document
    // and the NOT READY banner — or "no banner" is satisfied by a branch on
    // which the detector never ran at all.
    assert.equal(doctor.content.length, 2);
    assert.match(doctor.content[1].text, /NOT READY \(exit 1\)/);
    assert.equal(/UNDECIDED EVIDENCE/.test(JSON.stringify(doctor)), false);

    assert.equal(preflight.content.length, 2);
    assert.match(preflight.content[1].text, /NOT READY \(exit 1\)/);
    assert.equal(/UNDECIDED EVIDENCE/.test(JSON.stringify(preflight)), false);
  });

  it("does not report a collapsed verdict twice", () => {
    // `verdict.status` is a roll-up like any other, so the run tool's
    // INCONCLUSIVE matches both detectors. The collapsed-verdict banner says
    // strictly more about that field, so it keeps it: a second block listing
    // `verdict.status` under it would read as a separate problem.
    const result = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.noGo, {
        stdout: printed(runReport("INCONCLUSIVE")),
      }),
    );

    assert.equal(result.content.length, 3);
    assert.match(result.content[2].text, /INCONCLUSIVE, REPORTED AS EXIT 1/);
    // The banner's content, not the fact that a third block exists: what it is
    // for is telling a reader the DOCUMENT is right and the number is narrow.
    assert.match(result.content[2].text, /THE DOCUMENT IS RIGHT/);
    assert.match(
      result.content[2].text,
      /exit mapping is frozen at two outcomes/,
    );
    assert.match(result.content[2].text, /Do not relay this as a failing test/);
    assert.equal(/UNDECIDED EVIDENCE/.test(JSON.stringify(result)), false);
  });

  it("stays silent about a collapsed verdict on a preflight NOT READY", () => {
    // `tess preflight` now publishes `verdict.status`, and that did NOT make
    // this banner reachable for it — the reason it cannot fire simply changed
    // from "the field does not exist" to "the field cannot disagree". Both come
    // out of one value: `preflightCommand` labels the verdict with
    // `verdictLabel(verdict)` and returns `verdict.exitCode`, and the only label
    // that would fire this banner is the one attached to exit 5.
    //
    // Pinned as an absence beside the field's PRESENCE, because an absence on
    // its own is also satisfied by the field having gone away again — which is
    // exactly the state this case was written to tell apart.
    const result = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.noGo, {
        stdout: printed(preflightReport("unknown", "match")),
      }),
    );

    assert.equal(result.structuredContent.verdict.status, "NOT READY");
    // Structural first, verbal second. If the banner ever starts firing on this
    // document it arrives as a FOURTH block whatever it comes to say — the
    // undecided evidence under it stays, because only `verdict.status` is
    // filtered out of that list and this fixture's undecided roll-up is
    // `doctor.status`. A `doesNotMatch` on today's headline would go quiet the
    // moment somebody reworded the headline.
    assert.equal(result.content.length, 3);
    assert.doesNotMatch(
      JSON.stringify(result),
      /INCONCLUSIVE, REPORTED AS EXIT 1/,
    );
    // The undecided evidence under it is still named — this is a narrowing of
    // one banner, not a report with no caveat on it.
    assert.match(result.content[2].text, /UNDECIDED EVIDENCE UNDER A NO/);
    assert.match(result.content[2].text, /doctor\.status/);
  });

  // ── a failure that carried no words says so ───────────────────────────────

  it("says the pipeline gave no reason rather than promising one", () => {
    // The headline promises the pipeline's own wording, and that wording is
    // relayed from stderr. An empty stderr used to end the result right there,
    // leaving a sentence pointing at nothing — a caller cannot tell "the
    // pipeline said nothing" from "this server dropped what it said".
    const result = toolResultFor(outcome(PLAN_TOOL, EXIT_CODES.usage));

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /INVALID REQUEST \(exit 2\)/);
    assert.match(result.content[0].text, /The reason follows verbatim/);
    assert.match(result.content[1].text, /^no diagnostics \(stderr\)/);
    assert.match(result.content[1].text, /Do not infer one/);
  });

  it("says it on the refusal branch too, where the promise is the guard's", () => {
    const result = toolResultFor(outcome(APPLY_TOOL, EXIT_CODES.refused));

    assert.match(result.content[0].text, /The guard's own reasoning follows/);
    assert.match(result.content[1].text, /^no diagnostics \(stderr\)/);
    // The refusal itself is unchanged: still a refusal, still not a failure.
    assert.match(result.content[0].text, /NOTHING WAS WRITTEN/);
  });

  it("keeps the diagnostics block when there are diagnostics", () => {
    // The other half of the pair, pinned so the fallback cannot quietly replace
    // the real thing: when stderr spoke, the caller gets its words verbatim.
    const result = toolResultFor(
      outcome(APPLY_TOOL, EXIT_CODES.usage, {
        stderr: ["tess preflight: no runner instance"],
      }),
    );

    assert.match(result.content[1].text, /^diagnostics \(stderr\)/);
    assert.match(result.content[1].text, /no runner instance/);
    assert.equal(/no diagnostics/.test(JSON.stringify(result)), false);
  });

  // ── the offending bytes of an unreadable document ─────────────────────────

  it("relays the stdout that was not a report instead of dropping it", () => {
    // "printed something that is not JSON" and then discarding the something is
    // a bug report with the evidence removed — and the caller cannot see that
    // anything was withheld, because the branch that withheld it is the one
    // claiming an internal fault.
    const result = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.ok, {
        stdout: ["<!DOCTYPE html>", "<title>Instance hibernating</title>"],
      }),
    );

    assert.equal(result.isError, true);
    assert.equal("structuredContent" in result, false);
    assert.match(result.content[0].text, /INTERNAL FAULT/);
    assert.match(result.content[0].text, /printed something that is not JSON/);
    assert.match(result.content[2].text, /^stdout \(NOT a report/);
    assert.match(result.content[2].text, /Instance hibernating/);
  });

  it("announces a cut rather than shortening it silently", () => {
    const body = "x".repeat(4100);
    const result = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.ok, { stdout: [body] }),
    );

    // A shortened document that does not say it was shortened reads as a whole
    // one, which is the same defect one layer down. Two commitments, and only
    // one of them is wording: the relay really is shorter than what the command
    // printed, and it says how much it dropped. The old anchor quoted the
    // note's phrasing and asserted NEITHER — announcing a cut that never
    // happened passed it.
    const relay = result.content[2].text;
    assert.equal(relay.includes(body), false);
    assert.match(relay, /\b100\b[\s\S]*\b4100\b/);
  });

  it("leaves a clean failure at one block plus the silence", () => {
    // Nothing printed, nothing on stderr: the result is the headline and the
    // statement that no reason arrived, and no empty stdout block invented for
    // symmetry.
    const result = toolResultFor(outcome(APPLY_TOOL, EXIT_CODES.fault));

    assert.equal(result.content.length, 2);
    assert.match(result.content[0].text, /INFRASTRUCTURE FAULT/);
    assert.match(result.content[1].text, /^no diagnostics \(stderr\)/);
  });
});

// ── the run-state tools ─────────────────────────────────────────────────────

/** What `tess confirm --json` prints, trimmed to what these cases read. */
const confirmReport = (exitCode, extra = {}) => ({
  runId: "run-20260202T030405-abcd1234",
  state: "done",
  exitCode,
  ...extra,
});

describe("@tessera/mcp — the run-state exit mapping", () => {
  it("relays a recorded NO_GO out of confirm as a verdict, document attached", () => {
    const document = confirmReport(1, {
      verdict: { status: "NO_GO", confirmToken: { verdictHash: "h" } },
    });
    const result = toolResultFor(
      outcome(CONFIRM_READY_TOOL, EXIT_CODES.noGo, {
        stdout: printed(document),
      }),
    );

    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, document);
    assert.match(result.content[1].text, /NOT READY|NO_GO/);
    assert.doesNotMatch(result.content[1].text, /UNEXPECTED VERDICT/);
  });

  it("reads a recorded fault out of confirm as the run's, not as this call's", () => {
    const document = confirmReport(3);
    const result = toolResultFor(
      outcome(CONFIRM_READY_TOOL, EXIT_CODES.fault, {
        stdout: printed(document),
      }),
    );

    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, document);
    assert.match(result.content[1].text, /^RECORDED OUTCOME \(exit 3\)/);
    assert.match(result.content[1].text, /This call WORKED/);
    assert.match(result.content[1].text, /no confirm token/);
    assert.doesNotMatch(result.content[0].text, /INFRASTRUCTURE FAULT \(DEV-1/);
  });

  it("does not believe a relayed exit whose document names another code", () => {
    // The CLI prints the document only when it relays; a document whose
    // `exitCode` disagrees with the process is not the record of this exit.
    const result = toolResultFor(
      outcome(CONFIRM_READY_TOOL, EXIT_CODES.fault, {
        stdout: printed(confirmReport(0)),
      }),
    );

    assert.equal("structuredContent" in result, false);
    assert.match(
      result.content[0].text,
      /^INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );
  });

  it("reads exit 3 with no document out of confirm as a plain fault", () => {
    const result = toolResultFor(
      outcome(CONFIRM_READY_TOOL, EXIT_CODES.fault, {
        stderr: ["tess confirm: the recorded result is not a live run"],
      }),
    );

    assert.equal(result.isError, true);
    assert.equal("structuredContent" in result, false);
    assert.match(
      result.content[0].text,
      /^INFRASTRUCTURE FAULT \(DEV-1, exit 3\)/,
    );
    // Read-only, so the read-only remedy applies and no write aftermath.
    assert.doesNotMatch(
      result.content[0].text,
      /NOT PROOF THAT NOTHING WAS WRITTEN/,
    );
    assert.doesNotMatch(result.content[0].text, /RECORDED OUTCOME/);
  });

  it("reads a recorded refusal out of confirm as the run's too", () => {
    const result = toolResultFor(
      outcome(CONFIRM_READY_TOOL, EXIT_CODES.refused, {
        stdout: printed(confirmReport(4)),
      }),
    );

    assert.match(result.content[1].text, /^RECORDED OUTCOME \(exit 4\)/);
    assert.match(result.content[1].text, /REFUSAL/);
    assert.doesNotMatch(result.content[1].text, /defect/);
  });

  it("says why confirm is inconclusive without calling it a partial check", () => {
    const document = { runId: "r1", state: "running", exitCode: 5 };
    const result = toolResultFor(
      outcome(CONFIRM_READY_TOOL, EXIT_CODES.inconclusive, {
        stdout: printed(document),
      }),
    );

    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, document);
    assert.match(result.content[1].text, /^INCONCLUSIVE \(exit 5\)/);
    assert.match(result.content[1].text, /persisted no result yet/);
    assert.match(result.content[1].text, /Do not report the run as ready/);
  });

  it("reads a cleanup plan refusal as the run's lifecycle, not as a defect", () => {
    const result = toolResultFor(
      outcome(CLEANUP_PLAN_TOOL, EXIT_CODES.refused, {
        stderr: ["REFUSED (DEV-17): run r1 is running, not terminal"],
      }),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^REFUSED \(exit 4\)/);
    assert.match(result.content[0].text, /NOTHING WAS DELETED/);
    assert.match(result.content[0].text, /DEV-17/);
    assert.doesNotMatch(result.content[0].text, /defect/);
    assert.doesNotMatch(result.content[0].text, /§11/);
    assert.match(result.content[1].text, /not terminal/);
  });

  it("reads a cleanup apply refusal as nothing deleted, with both causes named", () => {
    const result = toolResultFor(
      outcome(CLEANUP_APPLY_TOOL, EXIT_CODES.refused, {
        stderr: ['REFUSED (§11): the runner classifies "unknown"'],
      }),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^REFUSED \(exit 4\)/);
    assert.match(result.content[0].text, /NOTHING WAS DELETED/);
    assert.match(result.content[0].text, /§11 guard/);
    assert.match(result.content[0].text, /DEV-17/);
    assert.deepEqual(retryInstructions(result.content[0].text), []);
  });

  it("reads a cleanup apply fault as not proof, with a read as the remedy", () => {
    const result = toolResultFor(
      outcome(CLEANUP_APPLY_TOOL, EXIT_CODES.fault, {
        stderr: ["tess cleanup: the runner stopped answering"],
      }),
    );

    assert.match(result.content[0].text, /NOT PROOF THAT NOTHING WAS WRITTEN/);
    assert.match(result.content[0].text, /preflight_run_status/);
    assert.match(result.content[0].text, /preflight_cleanup_plan/);
    assert.match(result.content[0].text, /let the operator decide/);
    // Not the apply tool's remedy: nothing here re-plans a preflight.
    assert.doesNotMatch(result.content[0].text, /call preflight_plan/);
    assert.deepEqual(retryInstructions(result.content[0].text), []);
  });

  it("reads a plan-identity refusal on apply as the caller's, not the operator's", () => {
    for (const [tag, line] of [
      [
        "§6b",
        "REFUSED (§6b): --plan-hash sha256:old does not match the recomputed plan",
      ],
      [
        "ARCH-33",
        "REFUSED (ARCH-33): idempotency key k-1 is bound to another plan",
      ],
    ]) {
      const result = toolResultFor(
        outcome(APPLY_TOOL, EXIT_CODES.refused, { stderr: [line] }),
      );

      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        new RegExp(`^REFUSED \\(${tag}, exit 4\\)`),
      );
      assert.match(result.content[0].text, /NOTHING WAS WRITTEN/);
      assert.match(result.content[0].text, /Call preflight_plan again/);
      // Not the §11 text: no allowlist to ask the operator for.
      assert.doesNotMatch(result.content[0].text, /§11\.2 configuration/);
    }
  });

  it("keeps the apply tool's own fault remedy, key included", () => {
    const result = toolResultFor(
      outcome(APPLY_TOOL, EXIT_CODES.fault, {
        stderr: ["tess preflight: the instance never answered"],
      }),
    );

    assert.match(result.content[0].text, /same idempotencyKey/);
    assert.match(result.content[0].text, /re-execution and not a replay/);
  });
});

// Delegated decision 2026-09-26: `tess run` refuses under its OWN §4b
// prefixes — `REFUSED (§4b concurrency): ` when another run holds the
// scope+runner, `REFUSED (§4b): ` when the run id names a used run
// (`packages/cli/src/cli.ts`). Neither is the §11 guard, so neither may be
// read as one: no allowlist advice, and a pointer to the run that can be read.
describe("toolResultFor — §4b refusals out of a writer (2026-09-26)", () => {
  const fourB = (message) => ["", message, ""];

  function assertNotTheGuard(text) {
    assert.doesNotMatch(text, /§11/);
    assert.doesNotMatch(text, /allowlist/i);
    assert.doesNotMatch(text, /SEC-2/);
    assert.equal(/\bdefect\b/.test(text), false);
  }

  it("reads a concurrency refusal as another run holding the scope", () => {
    const line =
      "REFUSED (§4b concurrency): run r-live already holds scope global on dev1.service-now.com";
    const result = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.refused, { stderr: fourB(line) }),
    );

    assert.equal(result.isError, true);
    assert.equal("structuredContent" in result, false);
    const headline = result.content[0].text;
    assert.match(headline, /^REFUSED \(§4b concurrency, exit 4\)/);
    assert.match(headline, /NOTHING WAS RUN AND NOTHING WAS WRITTEN/);
    assert.match(headline, /another run holds/);
    assert.match(headline, /tess status --run-id/);
    assert.match(headline, /preflight_run_status/);
    assertNotTheGuard(headline);
    // The pipeline's own words still arrive, labelled as diagnostics.
    assert.ok(
      result.content.slice(1).some((block) => block.text.includes(line)),
    );
  });

  it("reads a resume refusal as a reused run id", () => {
    const result = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.refused, {
        stderr: fourB(
          "REFUSED (§4b): run r-1 already exists in state failed; it cannot be resumed",
        ),
      }),
    );

    const headline = result.content[0].text;
    assert.match(headline, /^REFUSED \(§4b, exit 4\)/);
    assert.match(headline, /NOTHING WAS RUN AND NOTHING WAS WRITTEN/);
    assert.match(headline, /run id is being reused/);
    assert.match(headline, /tess status --run-id/);
    assertNotTheGuard(headline);
  });

  it("fails closed: anything short of the exact prefix keeps the §11 reading", () => {
    for (const stderr of [
      [],
      ["note: REFUSED (§4b): quoted inside another line"],
      ["REFUSED (§4b) missing the colon"],
      ["REFUSED (§4b concurrency) missing the colon"],
      ["REFUSED (§4bx): not the tag"],
      ["REFUSED (§4b Concurrency): wrong case"],
      [' REFUSED (§11): the runner classifies "unknown"'],
    ]) {
      const result = toolResultFor(
        outcome(RUN_TOOL, EXIT_CODES.refused, { stderr }),
      );
      assert.match(
        result.content[0].text,
        /^REFUSED \(§11, exit 4\)/,
        JSON.stringify(stderr),
      );
      assert.match(result.content[0].text, /§11\.2 configuration/);
    }
  });

  it("leaves a §11 refusal beside nothing else exactly as it was", () => {
    const result = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.refused, {
        stderr: ['REFUSED (§11): the runner classifies "unknown"'],
      }),
    );
    assert.match(result.content[0].text, /^REFUSED \(§11, exit 4\)/);
  });

  it("does not relabel a §4b line out of a tool that asks for no write", () => {
    // Scoped to writers: a read-only tool refused at all is still the defect
    // reading, whatever prefix the refusal carried.
    const result = toolResultFor(
      outcome(PLAN_TOOL, EXIT_CODES.refused, {
        stderr: fourB("REFUSED (§4b concurrency): unexpected here"),
      }),
    );
    assert.match(result.content[0].text, /^REFUSED \(§11, exit 4\)/);
    assert.match(result.content[0].text, /\bdefect\b/);
  });
});

// ── `artifactTablesRefused` and its `read: "lookup"` tag (wave 16) ──────────
//
// Since wave 15 a live run record's `artifactTablesRefused` entries may carry
// `read: "lookup"`: absent means the scope ENUMERATION was refused, `"lookup"`
// means only the impact analysis's lookup read was (the Business Rule lookup
// of `sys_script`, the UI Action lookup of `sys_ui_action`). The two are worded
// differently by the CLI ("live artifact enumeration is incomplete" vs "impact
// lookup is incomplete") because they send an operator to different places.
//
// This layer neither declares an output schema nor summarises the field: it
// relays the CLI's document verbatim and the CLI's stderr verbatim. What is
// pinned here is exactly that — the tag survives into `structuredContent` and
// the text copy, an untagged entry is not given one, both CLI warnings reach
// the caller unparaphrased and in order, and no banner of this server adds
// refusal wording of its own that could contradict the CLI's.
//
// Delegated decision 2026-09-30 (wave 16): pinned against hand-written
// documents rather than a real `tess run --live`, because no MCP tool reaches
// a document carrying the field today: `preflight_run` pins `--skeleton`
// (decision 10), and `tess confirm --json` / `tess status --json` project the
// record without it. The relay is shape-agnostic, so the day either changes
// the property below is what holds.

const LOOKUP_REFUSAL = {
  table: "sys_script",
  reason: "sys_script: read refused (403) for the connected user",
  read: "lookup",
};
const ENUMERATION_REFUSAL = {
  table: "sys_ui_action",
  reason: "sys_ui_action: read refused (403) for the connected user",
};
const LOOKUP_WARNING =
  "warning: impact lookup is incomplete — 1 table(s) refused the impact analysis's lookup read (not the enumeration), so the verdict cannot be GO: sys_script (sys_script: read refused (403) for the connected user)";
const ENUMERATION_WARNING =
  "warning: live artifact enumeration is incomplete — 1 of 12 table(s) refused, so the verdict cannot be GO: sys_ui_action (sys_ui_action: read refused (403) for the connected user)";

const REFUSAL_WORDING =
  /could not be enumerated|enumeration is incomplete|lookup is incomplete|lookup read/;

/** A persisted live record, as `tess run --live --json` prints it, trimmed. */
const liveRecord = (status, exitCode) => ({
  kind: LIVE_RESULT_KIND,
  runId: "run-20260930T120000-abcd1234",
  exitCode,
  state: "done",
  teardown: "done",
  verdict: {
    status,
    warnings: [
      "unanalyzable impact: sys_script/0123 — the rule's call targets could not be established",
    ],
  },
  planned: 1,
  inventoryIncomplete: false,
  artifactTablesRefused: [LOOKUP_REFUSAL, ENUMERATION_REFUSAL],
  failures: [],
});

/**
 * The text blocks this server wrote itself: everything except the relayed
 * document (always first) and the relayed stderr.
 */
const ownBanners = (result) =>
  result.content
    .slice(1)
    .map((block) => block.text)
    .filter((body) => !body.startsWith("diagnostics (stderr):"));

function assertRelayedVerbatim(result, document) {
  assert.deepEqual(result.structuredContent, document);
  assert.deepEqual(JSON.parse(result.content[0].text), document);

  const refused = result.structuredContent.artifactTablesRefused;
  assert.equal(refused[0].read, "lookup");
  // Absent means the enumeration: an untagged entry must stay untagged, not
  // become `read: undefined` or be defaulted to anything.
  assert.equal("read" in refused[1], false);

  const stderr = result.content.find((block) =>
    block.text.startsWith("diagnostics (stderr):"),
  );
  assert.ok(stderr, "the CLI's warnings reach the caller");
  assert.equal(
    stderr.text,
    `diagnostics (stderr):\n${LOOKUP_WARNING}\n${ENUMERATION_WARNING}`,
  );

  for (const body of ownBanners(result)) {
    assert.doesNotMatch(body, REFUSAL_WORDING, body);
  }
}

describe('toolResultFor — `artifactTablesRefused` with `read: "lookup"` (wave 16)', () => {
  const stderr = [LOOKUP_WARNING, ENUMERATION_WARNING];

  it("relays a recorded INCONCLUSIVE with a lookup refusal verbatim (confirm, exit 5)", () => {
    const document = liveRecord("INCONCLUSIVE", EXIT_CODES.inconclusive);
    const result = toolResultFor(
      outcome(CONFIRM_READY_TOOL, EXIT_CODES.inconclusive, {
        stdout: printed(document),
        stderr,
      }),
    );

    assert.equal(result.isError, false);
    assert.match(result.content[1].text, /^INCONCLUSIVE \(exit 5\)/);
    assertRelayedVerbatim(result, document);
  });

  it("relays a run document carrying a lookup refusal verbatim under the collapsed-verdict banner (run, exit 1)", () => {
    const document = liveRecord("INCONCLUSIVE", EXIT_CODES.noGo);
    const result = toolResultFor(
      outcome(RUN_TOOL, EXIT_CODES.noGo, { stdout: printed(document), stderr }),
    );

    assert.equal(result.isError, true);
    assert.ok(
      ownBanners(result).some((body) =>
        body.startsWith("INCONCLUSIVE, REPORTED AS EXIT 1"),
      ),
    );
    assertRelayedVerbatim(result, document);
  });

  it("relays the same list verbatim out of an analysis tool too, whatever document carries it (impact, exit 5)", () => {
    const document = {
      incomplete: true,
      notes: [],
      graph: { nodes: [], edges: [], unanalyzable: [] },
      artifactTablesRefused: [LOOKUP_REFUSAL, ENUMERATION_REFUSAL],
    };
    const result = toolResultFor(
      outcome(IMPACT_TOOL, EXIT_CODES.inconclusive, {
        stdout: printed(document),
        stderr,
      }),
    );

    assert.equal(result.isError, false);
    assert.match(result.content[1].text, /^INCOMPLETE \(exit 5\)/);
    assertRelayedVerbatim(result, document);
  });
});
