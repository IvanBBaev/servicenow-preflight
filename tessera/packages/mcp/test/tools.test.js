// The tool contract as data — schema, validation, argv. No instance, no
// protocol: everything here is a pure function of a `ToolSpec`.
//
// The property these cases exist to hold is that the schema a host advertises
// and the argv the composition root receives are derived from ONE list. A knob
// that appears in one and not the other is either a flag a caller can never
// reach or an argument that is silently dropped, and both look like a working
// tool from the outside.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RUN_ID_PATTERN } from "@tessera/ledger";

import {
  APPLY_TOOL,
  CLEANUP_APPLY_TOOL,
  CLEANUP_LEGACY_PLAN_TOOL,
  CLEANUP_PLAN_TOOL,
  CONFIRM_READY_TOOL,
  COVERAGE_TOOL,
  DOCTOR_TOOL,
  findTool,
  GENERATE_TOOL,
  IMPACT_TOOL,
  inputSchemaFor,
  PLAN_TOOL,
  RESOLVE_TOOL,
  RUN_STATUS_TOOL,
  RUN_TOOL,
  toArgv,
  toolDefinition,
  TOOLS,
  validateArguments,
} from "../build/index.js";

const values = (spec, args) => {
  const outcome = validateArguments(spec, args);
  assert.equal(outcome.ok, true, outcome.message);
  return outcome.values;
};

// The `kinds` field carried "**Omit for the default set.**" for two revisions.
// A `doesNotMatch` on that sentence would pin the six words and nothing else,
// and the regression that actually happens is somebody restating the same
// convenience in their own — "defaults to all kinds", "leave it out and every
// kind is checked". So the shape is matched instead: a claim of this class is
// an OMISSION token and a TOTALITY token in one sentence with no negation
// holding them apart.
//
// The negation window reaches back over the omission token because a denial
// usually opens the sentence ("THERE IS NO DEFAULT SET, and omitting this does
// not mean …"), and it is clamped to the sentence so that a claim inserted
// after some unrelated "not" is still caught.
const OMISSION =
  /\bomit\w*\b|\bleav\w+ (?:it|this|them|the list|kinds?) out\b|\b(?:if|when|once) (?:it is |this is )?(?:absent|unset|empty)\b|\bby default\b|\bdefaults? to\b|\bwithout (?:a |any )?kinds?\b|\bno kinds? (?:named|given|listed|supplied|set|requested)\b/i;
const TOTALITY =
  /\bdefault (?:set|list|selection|kinds?)\b|\b(?:every|all|each|both)\s+(?:test\s+|three\s+)*kinds?\b(?!-)/i;
const NEGATION =
  /\bno\b|\bnot\b|\bnever\b|\bneither\b|\bnor\b|\bnothing\b|n['’]t\b/i;

const defaultSetClaims = (description) =>
  description.split(/(?<=[.:;])\s+/).filter((sentence) => {
    const omission = OMISSION.exec(sentence);
    const totality = TOTALITY.exec(sentence);
    if (omission === null || totality === null) return false;

    const lo = Math.min(omission.index, totality.index);
    const hi = Math.max(
      omission.index + omission[0].length,
      totality.index + totality[0].length,
    );
    return !NEGATION.test(sentence.slice(Math.max(0, lo - 25), hi));
  });

// ── the list ────────────────────────────────────────────────────────────────

describe("@tessera/mcp — the tool list", () => {
  it("exposes exactly the thirteen tools Phase 9 intends, and nothing else", () => {
    // A pin, not a description. The list is the surface an operator consented
    // to when they launched this server, and a tool that appeared in it without
    // anybody editing this line would be a capability nobody granted.
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      [
        "preflight_resolve",
        "preflight_impact",
        "preflight_coverage",
        "preflight_generate",
        "preflight_doctor",
        "preflight_plan",
        "preflight_apply",
        "preflight_run",
        "preflight_run_status",
        "preflight_confirm_ready",
        "preflight_cleanup_plan",
        "preflight_cleanup_apply",
        "preflight_cleanup_legacy_plan",
      ],
    );
  });

  it("serves §6b's run-state rows under the prefix only, cleanup as two", () => {
    // The rows used to be pinned ABSENT until `tess status`, `tess confirm` and
    // `tess cleanup` existed; they do now (decision 12). What stays pinned is
    // the spelling: the bare §6b names are not aliases, and `cleanup` is served
    // as a plan tool and an apply tool, never as one tool carrying both halves.
    const names = TOOLS.map((tool) => tool.name);
    for (const bare of ["run_status", "cleanup", "confirm_ready", "run"]) {
      assert.equal(names.includes(bare), false, bare);
      assert.equal(findTool(bare), undefined, bare);
    }
    assert.equal(names.includes("preflight_cleanup"), false);
    assert.equal(findTool("preflight_run_status"), RUN_STATUS_TOOL);
    assert.equal(findTool("preflight_confirm_ready"), CONFIRM_READY_TOOL);
    assert.equal(findTool("preflight_cleanup_plan"), CLEANUP_PLAN_TOOL);
    assert.equal(findTool("preflight_cleanup_apply"), CLEANUP_APPLY_TOOL);
  });

  it("holds three instance-mutating tools and one repo-writing tool", () => {
    // Two different privileges, kept apart on purpose: generation writes the
    // working copy and touches no instance, the mutating pair writes an
    // instance and touches no file. Collapsing them into "not read-only" would
    // let either inherit the other's consent.
    assert.deepEqual(
      TOOLS.filter((tool) => tool.writeClass === "mutating").map(
        (tool) => tool.name,
      ),
      ["preflight_apply", "preflight_run", "preflight_cleanup_apply"],
    );
    assert.deepEqual(
      TOOLS.filter((tool) => tool.writeClass === "repo-write").map(
        (tool) => tool.name,
      ),
      ["preflight_generate"],
    );
  });

  it("delegates to the `tess` subcommands rather than to a private pipeline", () => {
    assert.equal(RESOLVE_TOOL.command, "resolve");
    assert.equal(IMPACT_TOOL.command, "impact");
    assert.equal(COVERAGE_TOOL.command, "coverage");
    assert.equal(GENERATE_TOOL.command, "generate");
    assert.equal(DOCTOR_TOOL.command, "doctor");
    // Two tools over one subcommand: the difference is `--mode`, which is why
    // the plan tool pins it and the apply tool demands it (decision 6).
    assert.equal(PLAN_TOOL.command, "preflight");
    assert.equal(APPLY_TOOL.command, "preflight");
    assert.equal(RUN_TOOL.command, "run");
    assert.equal(RUN_STATUS_TOOL.command, "status");
    assert.equal(CONFIRM_READY_TOOL.command, "confirm");
    // Cleanup is split the way preflight is (decision 12).
    assert.equal(CLEANUP_PLAN_TOOL.command, "cleanup");
    assert.equal(CLEANUP_APPLY_TOOL.command, "cleanup");
  });

  it("finds a tool by its wire name and nothing by a near miss", () => {
    assert.equal(findTool("preflight_impact"), IMPACT_TOOL);
    // The §6b table's bare names. The prefix is now used throughout, and the
    // bare form is not silently accepted as an alias — a caller reaching for
    // `apply` should be told the tool is called something else, not served.
    assert.equal(findTool("impact"), undefined);
    assert.equal(findTool("apply"), undefined);
  });

  it("marks the read-only tools read-only, and claims no write mode for them", () => {
    for (const spec of TOOLS.filter(
      (tool) => tool.writeClass === "read-only",
    )) {
      const { annotations } = toolDefinition(spec);
      assert.equal(annotations.readOnlyHint, true);
      // Those that reach an instance reach one nobody in this process controls
      // (§6b); the run-state reads touch only local files (decision 16).
      assert.equal(annotations.openWorldHint, spec.localOnly !== true);
      // Meaningful only when `readOnlyHint` is false; declaring either would
      // suggest there is a write mode to describe.
      assert.equal("destructiveHint" in annotations, false);
      assert.equal("idempotentHint" in annotations, false);
    }
  });

  it("declares the apply tool's writes in its annotations, not by calling it", () => {
    const { annotations } = toolDefinition(APPLY_TOOL);

    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.destructiveHint, true);
    assert.equal(annotations.openWorldHint, true);
    // §6b marks apply idempotent "(via key)" — honest only with an
    // `idempotencyKey`, which today's CLI has no way to accept. Claiming it
    // would invite exactly the retry the missing key cannot make safe.
    assert.equal(annotations.idempotentHint, false);
  });

  it("keeps the apply tool's idempotency hint false, and says why in its text", () => {
    // A PIN on an unwelcome truth, not a description of a preference. Decision
    // 7 measured this rather than assumed it: `@tessera/cli` holds neither a
    // plan hash nor an idempotency key anywhere in `src/`; `@tessera/core`'s
    // `runPipeline` mints its keys internally from a `runId` and computes no
    // plan hash at all; and `@tessera/ledger` does enforce at-most-once, but
    // only run-scoped (`intend()` scans `readEntries(runId)`), which a
    // preflight apply — minting no run id — cannot reach. The record shaped
    // for this case, `LedgerInfraWriteRecord`, is a seam nothing emits.
    //
    // So `true` here would advertise a guarantee no package below implements,
    // and the only honest way to earn it is a flag on `packages/cli`. Until
    // that exists this case fails, which is the point: the hint cannot be
    // "tidied up" in the adapter, and the feature cannot be manufactured here
    // out of cross-call state without ARCH-1's second decision path appearing.
    assert.equal(toolDefinition(APPLY_TOOL).annotations.idempotentHint, false);

    // The annotation is a flag on a struct; a model reads the prose. Both have
    // to carry the same fact, so the wording is pinned too — a retry is a
    // RE-EXECUTION, not a replay, and the caller is told to look rather than
    // to call again.
    assert.match(APPLY_TOOL.description, /RETRIES ARE NOT SAFE/);
    assert.match(APPLY_TOOL.description, /RE-EXECUTION, not a replay/);
    assert.match(APPLY_TOOL.description, /performed AGAIN/);
    assert.match(APPLY_TOOL.description, /do not retry this tool to find out/);
  });

  it("offers the plan hash and idempotency key as optional apply fields", () => {
    // This case used to pin both ABSENT, because no CLI flag carried them. Now
    // `tess preflight --mode apply` reads `--plan-hash` and `--idempotency-key`
    // (§6b/ARCH-33), so the absence pin was deleted and the mapping is pinned
    // instead: one field, one flag, neither required.
    const schema = inputSchemaFor(APPLY_TOOL);

    assert.equal(schema.properties.planHash.type, "string");
    assert.equal(schema.properties.idempotencyKey.type, "string");
    assert.deepEqual(schema.required, ["mode"]);
    assert.deepEqual(
      APPLY_TOOL.fields
        .filter((field) => /hash|idempot/i.test(field.flag))
        .map((field) => [field.name, field.flag]),
      [
        ["planHash", "--plan-hash"],
        ["idempotencyKey", "--idempotency-key"],
      ],
    );
    // Other spellings are still refused rather than dropped (closed schema).
    for (const name of ["plan_hash", "hash", "idempotency_key", "requestId"]) {
      const outcome = validateArguments(APPLY_TOOL, {
        mode: "apply",
        [name]: "x",
      });
      assert.equal(outcome.ok, false, name);
      assert.match(outcome.message, new RegExp(name));
    }
    // And the plan tool, which writes nothing, has neither.
    assert.equal("planHash" in inputSchemaFor(PLAN_TOOL).properties, false);
    assert.equal(
      "idempotencyKey" in inputSchemaFor(PLAN_TOOL).properties,
      false,
    );
    // The description tells the caller how to earn a safe retry.
    assert.match(
      APPLY_TOOL.description,
      /RETRIES ARE NOT SAFE WITHOUT THE SAME idempotencyKey/,
    );
  });

  it("declares a closed world for exactly the three local run-state reads", () => {
    // Decision 16: these read the §4b ledger and runner profiles in the
    // server's working directory and contact no instance.
    assert.deepEqual(
      TOOLS.filter(
        (tool) => toolDefinition(tool).annotations.openWorldHint === false,
      ).map((tool) => tool.name),
      [
        "preflight_run_status",
        "preflight_confirm_ready",
        "preflight_cleanup_plan",
      ],
    );
    // The apply half of cleanup deletes on the runner, so it keeps `true`.
    assert.equal(
      toolDefinition(CLEANUP_APPLY_TOOL).annotations.openWorldHint,
      true,
    );
  });

  it("declares the cleanup apply tool's deletes in its annotations", () => {
    const { annotations } = toolDefinition(CLEANUP_APPLY_TOOL);

    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.destructiveHint, true);
    // Re-entrant by §4b, and still not advertised as idempotent: a hint a
    // host may auto-retry a delete on is not handed out per tool (decision 4).
    assert.equal(annotations.idempotentHint, false);
    assert.match(CLEANUP_APPLY_TOOL.description, /THIS TOOL DELETES/);
    assert.match(CLEANUP_APPLY_TOOL.description, /EXPECT REFUSED TODAY/);
  });

  it("declares the generate tool's repo writes in its annotations too", () => {
    const { annotations } = toolDefinition(GENERATE_TOOL);

    // A repo write is still a write: a host that gates on `readOnlyHint` must
    // gate on this one, even though nothing on any instance changes.
    assert.equal(annotations.readOnlyHint, false);
    // Destructive because a second call overwrites a proposal a reviewer may
    // already be reading, and not idempotent because only the offline backend
    // is deterministic — the AI one is not, so the promise cannot be made.
    assert.equal(annotations.destructiveHint, true);
    assert.equal(annotations.idempotentHint, false);
    assert.equal(annotations.openWorldHint, true);
  });

  it("says in the generate tool's own text that it writes and may transmit", () => {
    // The point of the egress axis: a caller learns this from the tool list,
    // not from the network log after the fact.
    assert.match(GENERATE_TOOL.description, /THIS TOOL WRITES FILES/);
    assert.match(GENERATE_TOOL.description, /SEND INSTANCE CONTENT/);
    assert.match(GENERATE_TOOL.description, /EGRESS, DECLARED/);
    assert.match(GENERATE_TOOL.title, /WRITES/);
    assert.match(GENERATE_TOOL.title, /transmit/);
    // And that the backend which decides whether egress happens at all is the
    // operator's, not a knob the caller can reach for (SEC-2).
    assert.match(GENERATE_TOOL.description, /none of them is an argument/);
    // DEV-4, in the tool's own words rather than only in the result banner.
    assert.match(GENERATE_TOOL.description, /A PROPOSAL, NOT A TEST/);
    assert.match(GENERATE_TOOL.description, /DEV-4/);
  });

  it("says in the apply tool's own text that it writes, before anyone calls it", () => {
    assert.match(APPLY_TOOL.description, /THIS TOOL WRITES/);
    assert.match(APPLY_TOOL.title, /WRITES/);
    // And that a refusal is a refusal, with nothing to route around.
    assert.match(APPLY_TOOL.description, /NOTHING WAS WRITTEN/);
    assert.match(APPLY_TOOL.description, /not an argument of this tool/);
  });

  it("gives the run tool the same declared writes as the apply tool", () => {
    // The second mutating row, and the annotations are DERIVED from the write
    // class rather than written per tool (decision 4) — so this case is really
    // asking whether adding a writer to the list could ever produce a spec that
    // advertises itself as safe. It cannot: one word decides all four values.
    const { annotations } = toolDefinition(RUN_TOOL);

    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.destructiveHint, true);
    assert.equal(annotations.idempotentHint, false);
    assert.equal(annotations.openWorldHint, true);
    // Same class, same four hints: the two mutating rows differ only in title.
    const apply = toolDefinition(APPLY_TOOL).annotations;
    assert.deepEqual(
      { ...annotations, title: null },
      { ...apply, title: null },
      "a second mutating tool must not describe itself more gently",
    );
  });

  it("says in the run tool's own text that it writes and that §11 gates it", () => {
    assert.match(RUN_TOOL.description, /THIS TOOL WRITES/);
    assert.match(RUN_TOOL.title, /WRITES/);
    // The §11.5 floor, in the tool's own words: the runner may be neither
    // production nor unknown, and no argument here reaches that decision.
    assert.match(RUN_TOOL.description, /never be production/);
    assert.match(RUN_TOOL.description, /never be unknown/);
    assert.match(RUN_TOOL.description, /NOTHING WAS WRITTEN/);
    assert.match(
      RUN_TOOL.description,
      /Writability is never an argument of this tool/,
    );
    // And the state of the world it is shipped into: no §11.2 source reaches
    // `tess run`, so the tool declares its own ceiling instead of letting a
    // caller mistake the refusal for a broken instance.
    assert.match(RUN_TOOL.description, /EXPECT NO INSTANCE WRITE TODAY/);
    // ARCH-3: one mutation channel, and this tool is not a second one.
    assert.match(RUN_TOOL.description, /opens no second path/);
  });

  it("does not let the run tool claim the runner is the only thing it writes", () => {
    // Two corrections deep, and the second one is the instructive one.
    //
    // The claim originally read "It writes to the RUNNER and to nothing else
    // (ARCH-8)", and it was false on the axis a caller cares about most:
    // `packages/cli/src/stage.ts` mkdirs the §4b ledger root — `.tessera/` in
    // the SERVER's cwd, because this tool may not send `--ledger-root` —
    // unconditionally, before `runSkeleton` contacts anything. ARCH-8 is about
    // instance roles, so the sentence was scoped to instances rather than
    // deleted, and the disk was declared separately.
    //
    // Then `stage()` was fixed to remove a root it created and nothing wrote
    // into, and the correction went stale in its own turn: the description
    // still said "nothing removes it" and that a refusal "leaves the
    // directory". A TRUTHFULNESS FIX OUTLIVED THE DEFECT IT DESCRIBED — which
    // is why this test now pins the DISTINCTION a caller acts on rather than
    // the wording of either era.
    // So the assertions below are anchored on the NOUNS a caller acts on — the
    // directory, created, removed, ledger, pre-existing — and not on the
    // sentences carrying them. A rewrite that keeps the contract keeps these
    // green; only a change to the contract turns them red. The assertions this
    // block replaced failed for the one reason a test must never fail: the
    // prose moved. Both outcomes are pinned apart, because dropping either half
    // restores a version of the bug — without the removal the tool reads as
    // littering a directory the caller never chose, without the survival it
    // reads as never persisting anything, and a §4b ledger a caller does not
    // know is there is a crash-recovery record nobody goes looking for.
    for (const [noun, commitment] of [
      [
        /only INSTANCE[^.]*RUNNER/,
        "which instance role may be written (ARCH-8)",
      ],
      [/LOCAL DISK/, "that there is a second, non-instance write at all"],
      [/ledger root/, "what the directory is for"],
      // Name and location in ONE anchor, and not by taste. A bare
      // /`\.tessera\/`/ was in this list until it was mutation-tested: the name
      // occurs in three separate sentences, so deleting the one that INTRODUCES
      // the directory left it green. It asserted that the string appears
      // somewhere, which the other anchors already implied — the definition of
      // an assertion that cannot go red for the right reason.
      [
        /`\.tessera\/`[^.]*THIS SERVER/,
        "what it is called, where it is introduced, and whose working directory it lands in — not the caller's",
      ],
      [/created[^.]*refusal path/, "that the refusal path creates it too"],
      [/REMOVED AGAIN/, "that creating it is not the same as keeping it"],
      [/outlive the process/, "that a written ledger is kept, deliberately"],
      [
        /already there[^.]*never removed/,
        "that a pre-existing directory is not ours to delete",
      ],
      [
        /NOTHING WAS WRITTEN[^.]*INSTANCE/,
        "that the §11 paragraph's promise is scoped to the instance, so the two paragraphs cannot be read as contradicting each other",
      ],
    ]) {
      assert.match(
        RUN_TOOL.description,
        noun,
        `the description must still state ${commitment}`,
      );
    }
    // These two are PROSE-PINNED, and deliberately: they name sentences from the
    // two superseded eras, and a forbidden string has nothing but its wording to
    // be recognised by. They will need updating alongside any rewrite that
    // reuses these words innocently. That is fine — a brittle assertion which
    // announces its brittleness at the site is not the failure mode that bit us
    // twice today. A silent one is.
    assert.doesNotMatch(
      RUN_TOOL.description,
      /RUNNER and to nothing else/,
      "the run tool may write a local ledger root as well — that sentence overclaims",
    );
    assert.doesNotMatch(
      RUN_TOOL.description,
      /nothing removes it/,
      "`stage()` removes a ledger root it created and nothing wrote into",
    );
  });

  it("names both local writes the run tool can make, not just the ledger", () => {
    // The ledger root above was the only local write the description declared,
    // and it is not the only one. `stage()` also sets `SN_DOCS_DIR` to an
    // `sn-docs/` directory anchored on the discovered `tessera.config.json`
    // (`packages/cli/src/stage.ts`), which for a run started inside a project
    // puts it BESIDE that file — outside `.tessera/` entirely, and so outside
    // the empty-root undo the paragraph above describes. A caller who read
    // "the directory is `.tessera/`" as exhaustive would look in the wrong
    // place, or conclude a cleaned-up run left nothing when a journalled write
    // had landed one directory up.
    //
    // Two counts here rather than one string: the claim being fixed is an
    // EXHAUSTIVENESS claim, so the number is the load-bearing part.
    assert.match(RUN_TOOL.description, /TWO places/);
    assert.match(RUN_TOOL.description, /`sn-docs\/`/);
    assert.match(RUN_TOOL.description, /tessera\.config\.json/);
    assert.match(
      RUN_TOOL.description,
      /outside the `\.tessera\/`/,
      "the journal escaping the ledger root's undo is the whole reason it needs saying",
    );

    // Location is the other half of an exhaustiveness claim, and the branch a
    // caller of THIS server hits most often is the second one: an MCP host's
    // cwd is wherever it launched the server, which usually holds no
    // `tessera.config.json`. `docsAnchor` (`packages/cli/src/stage.ts`) falls
    // back to the ledger root then, so the journal lands INSIDE `.tessera/` —
    // and `stage()`'s undo is a non-recursive `rmdirSync`, which an `sn-docs/`
    // directory in there defeats. Naming only the beside-the-config case
    // leaves the paragraph above reading as though the empty root always goes.
    assert.match(RUN_TOOL.description, /`\.tessera\/sn-docs\/`/);
    assert.match(
      RUN_TOOL.description,
      /keeps the ledger root from being removed/,
    );

    // And the journal is CONDITIONAL, which is the part a description of a
    // write is easiest to overstate. `preflight_run` reaches no APPLIED
    // MUTATION on any call available today — the same description says
    // EXPECT NO INSTANCE WRITE TODAY — so a sentence declaring the journal
    // outright would send every caller looking for a file no call of theirs
    // can produce. Both halves are asserted: the condition, and the fact that
    // the block still says a write today is not among the things to expect.
    assert.match(
      RUN_TOOL.description,
      /only a run that reaches an APPLIED MUTATION creates it/,
    );
    assert.match(RUN_TOOL.description, /EXPECT NO INSTANCE WRITE TODAY/);
  });

  it("declares the write journal an applied preflight leaves on local disk", () => {
    // THE DEFECT THIS CLOSES, and it was pinned here by a test that argued its
    // way to the wrong conclusion from a true premise.
    //
    // The premise: `stage()` has exactly one caller and it is
    // `packages/cli/src/commands/run.ts`. The old assertion read that as "so
    // the apply path touches no path on disk". It is the opposite. Staging is
    // what SETS `SN_DOCS_DIR`, and `sn-client`'s transport appends every
    // non-GET it performs to `<that>/<profile>/write-journal.{jsonl,md}`
    // (`core/http.ts` calls `appendWriteJournal` on every journalled method).
    // So an apply that actually writes to the runner also writes an audit trail
    // to local disk, with no undo — and the tool contract said it wrote to the
    // runner "and to nothing else".
    //
    // The path in that sentence has since moved, which is why the anchor below
    // no longer names `docs/instance`: `preflightCommand` now calls
    // `stageDocsDir` (`packages/cli/src/stage.ts`), so the journal lands under
    // the `sn-docs/` directory anchored on the discovered `tessera.config.json`
    // — or `.tessera/sn-docs` when there is none — instead of the vendored
    // cwd-relative default. Whose working directory anchors it is unchanged,
    // and that is the part a caller acts on: under MCP it is the server host's,
    // never the caller's.
    //
    // Anchored on the nouns a caller acts on, the way the run tool's block
    // below is, so a rewrite that keeps the contract keeps this green.
    for (const [noun, commitment] of [
      [
        /only INSTANCE[^.]*RUNNER/,
        "which instance role may be written (ARCH-8)",
      ],
      [/LOCAL DISK/, "that there is a second, non-instance write at all"],
      [/write journal/, "what the file is"],
      [
        // Paragraph-scoped rather than sentence-scoped, and for a reason worth
        // recording: the path being pinned CONTAINS dots
        // (`write-journal.{jsonl,md}`), so the `[^.]*` idiom used for the run
        // tool's anchors below cannot reach across it.
        /sn-docs[^\n]*THIS SERVER/,
        "where it lands, and whose working directory that is — not the caller's",
      ],
      [/no undo/, "that this one is not cleaned up afterwards"],
      [
        /refused call[^.]*journalled/,
        "that a refusal leaves none of it, so the file's presence means a write reached the instance",
      ],
    ]) {
      assert.match(
        APPLY_TOOL.description,
        noun,
        `the description must still state ${commitment}`,
      );
    }
    // PROSE-PINNED for the same reason as the run tool's pair: a forbidden
    // string has nothing but its wording to be recognised by.
    assert.doesNotMatch(
      APPLY_TOOL.description,
      /RUNNER and to nothing else/,
      "an applied preflight also writes the DEV-15 journal — that sentence overclaims",
    );
    // What still separates the two tools, now that both admit a local write:
    // the run tool's ledger root is created on EVERY call and removed again if
    // empty, and apply's journal is created only by a write that landed and is
    // never removed. Neither description may be produced by search-and-replace
    // from the other.
    assert.doesNotMatch(
      APPLY_TOOL.description,
      /ledger root/,
      "the §4b ledger root is the run tool's directory, not this one's",
    );
    // And the stale half of the same sentence, pinned so it cannot come back
    // by copy: `tess preflight` stages a docs directory now.
    assert.doesNotMatch(
      APPLY_TOOL.description,
      /stages no docs directory/,
      "`preflightCommand` calls `stageDocsDir` — the vendored default no longer applies",
    );
  });

  it("tells the model that the state with work to do is the state §11 refuses", () => {
    // The tool's headline is "THIS TOOL WRITES", and as the guard stands there
    // is no instance state in which it can. The provision plan has exactly one
    // recipe (DR-3) and it fires only while `sn_atf.runner.enabled` does not
    // read `true`; the CLI's probe adapter reads any non-`true` value as the
    // downgrading `false` (fail closed, `packages/cli/src/topology.ts`), and
    // §11.2 moves an allowlisted instance carrying any downgrade signal to
    // `prod-suspect`, which §11.4 refuses without an acknowledgement. The
    // acknowledgement flag exists on the command line only — `tess preflight`
    // and `tess run` both parse it, and no tool here carries it. Verified end to end
    // against the fake instance in `packages/cli/test/preflight.test.js`:
    // `false`, an unreadable value and an empty one all exit 4, and `true`
    // exits 0 with `plan.steps` empty.
    //
    // A model that is not told this will read a refusal as a wrong call shape
    // and retry — which is the one thing the retry paragraph forbids.
    for (const [noun, commitment] of [
      [
        // The loudest sentence is pinned as itself, not as a noun: a model
        // that reads only the first line of the paragraph acts on this one,
        // and every noun below survives its deletion.
        /EXPECT REFUSED FROM ANY CALL THAT WOULD WRITE/,
        "the instruction the rest of the paragraph explains",
      ],
      [/prod-suspect/, "the class the refusal is about"],
      [/--acknowledge-prod/, "the flag that would cover it"],
      [
        /`tess preflight` and `tess run`/,
        "where that flag lives, since it is not here",
      ],
      [
        /`plan\.steps` is empty/,
        "what the permitted state actually looks like",
      ],
    ]) {
      assert.match(
        APPLY_TOOL.description,
        noun,
        `the description must still name ${commitment}`,
      );
    }
  });

  it("warns in the run tool's own text that exit 1 is two different answers", () => {
    // The debt owed against `packages/cli/src/commands/run.ts`, stated where a
    // model will read it rather than only in a comment: the Phase-0.5 mapping
    // is frozen at GO -> 0 / everything else -> 1, so INCONCLUSIVE arrives as
    // a 1 too and only the document tells them apart.
    assert.match(RUN_TOOL.description, /verdict\.status/);
    assert.match(RUN_TOOL.description, /INCONCLUSIVE/);
    assert.match(RUN_TOOL.description, /never as exit 5/);
    // And that a NO_GO is the answer rather than a malfunction (QA-8/DEV-1).
    assert.match(RUN_TOOL.description, /that is a FINDING/);
  });

  it("says in every description that a failure is not an empty answer", () => {
    assert.match(RESOLVE_TOOL.description, /never as an empty list/);
    assert.match(RESOLVE_TOOL.description, /DEV-1/);
    assert.match(IMPACT_TOOL.description, /never as an empty graph/);
    assert.match(IMPACT_TOOL.description, /DEV-1/);
    // QA-8 is the coverage tool's whole reading instruction.
    assert.match(COVERAGE_TOOL.description, /INTENT, not coverage/);
    assert.match(COVERAGE_TOOL.description, /QA-8/);
    assert.match(COVERAGE_TOOL.description, /QA-16/);
    // The doctor's three states are three, not two: "I could not tell" has its
    // own exit and its own sentence.
    assert.match(DOCTOR_TOOL.description, /never rounded up to ready/);
    assert.match(DOCTOR_TOOL.description, /QA-9/);
    // ...but three states are not three exit codes. See the DEV-2 test below.
    // And the gate's: an unearned green is what it exists to prevent.
    assert.match(PLAN_TOOL.description, /NOTHING IS WRITTEN/);
    assert.match(PLAN_TOOL.description, /QA-9/);
  });

  it("does not let the doctor promise UNKNOWN always gets exit 5", () => {
    // The claim this pins used to read "UNKNOWN gets its own outcome (exit 5)
    // rather than being folded into NOT READY", full stop. It is folded, on one
    // documented path: `exitCodeForDoctor` in
    // `packages/cli/src/commands/doctor.ts` short-circuits to `noGo` whenever
    // ANY report carries a `hardFailure`, and `hardFailureOf` in
    // `packages/doctor/src/doctor.ts` raises one for a kind-gated precondition
    // whose status is merely `!== "ready"` — `unknown` included. The rolled-up
    // `status` in the document then reads "unknown" while the exit code says 1.
    //
    // That is DEV-2 working as designed, so the fix is the description, not the
    // CLI. What must not survive is a caller reading exit 1 out of this tool as
    // proof that something decided no.
    assert.match(DOCTOR_TOOL.description, /ONE EXIT-CODE EXCEPTION/);
    assert.match(DOCTOR_TOOL.description, /HARD FAILURE/);
    assert.match(DOCTOR_TOOL.description, /DEV-2/);
    assert.match(DOCTOR_TOOL.description, /`hardFailure`/);
    // The unqualified promise is gone; the hedge is what is left.
    assert.match(
      DOCTOR_TOOL.description,
      /UNKNOWN USUALLY gets its own outcome/,
    );
    assert.doesNotMatch(
      DOCTOR_TOOL.description,
      /UNKNOWN gets its own outcome/,
      "exit 5 is not guaranteed for UNKNOWN — the DEV-2 hard-failure path returns 1",
    );
    // And the instruction that makes the exception actionable: read the
    // document, which carries both fields the exit code collapses.
    assert.match(
      DOCTOR_TOOL.description,
      /READ `status` AND `hardFailure` in the returned document/,
    );
  });

  it("declares which tools can reach a verdict and which only answer", () => {
    // The distinction `results.ts` reads: a 1 out of `preflight` is NOT READY
    // and a 1 out of `run` is a NO_GO, while a 1 out of the read-only three is
    // a defect in the pipeline.
    assert.deepEqual(
      TOOLS.filter((tool) => tool.reportsVerdict).map((tool) => tool.name),
      [
        "preflight_doctor",
        "preflight_plan",
        "preflight_apply",
        "preflight_run",
        "preflight_confirm_ready",
      ],
    );
  });

  it("declares where each tool's writes land, beside what it writes", () => {
    // Decision 4's second axis. The doctor is the clearest case for stating it
    // rather than deriving it: it reaches two instances and leaves nothing
    // behind on either, so "read-only" and "nothing escapes" are two facts.
    assert.equal(DOCTOR_TOOL.egress, "none");
    for (const spec of TOOLS.filter(
      (tool) => tool.writeClass === "read-only",
    )) {
      assert.equal(spec.egress, "none", `${spec.name} leaves nothing behind`);
    }
    assert.deepEqual(
      TOOLS.filter((tool) => tool.egress !== "none").map((tool) => tool.name),
      [
        "preflight_generate",
        "preflight_apply",
        "preflight_run",
        "preflight_cleanup_apply",
      ],
    );
    assert.equal(APPLY_TOOL.egress, "instance");
    // Its deletes land on the runner and nowhere else.
    assert.equal(CLEANUP_APPLY_TOOL.egress, "instance");
    // Same class, same landing place: the run reaches the runner and nothing
    // else (ARCH-8), so it takes `instance` for apply's reason rather than
    // `third-party` — nothing here posts instance text to anybody.
    assert.equal(RUN_TOOL.egress, "instance");
    // The axis exists for exactly this row: apply's writes stay inside the
    // operator's own topology, generation's may leave it altogether, and no
    // write class distinguishes those two — so egress states it separately.
    assert.equal(GENERATE_TOOL.egress, "third-party");
  });
});

// ── the schema ──────────────────────────────────────────────────────────────

describe("@tessera/mcp — the input schema", () => {
  it("adds `testsRoot` to impact's fields and changes nothing else", () => {
    const impact = Object.keys(inputSchemaFor(IMPACT_TOOL).properties);
    const coverage = Object.keys(inputSchemaFor(COVERAGE_TOOL).properties);

    assert.deepEqual(coverage, [...impact, "testsRoot"]);
  });

  it("exposes neither `--json` nor the `--instance` alias nor `--config`", () => {
    const properties = inputSchemaFor(COVERAGE_TOOL).properties;

    // `--json` is the contract, not a knob: a caller who could turn it off
    // would get a human report through a machine channel.
    assert.equal("json" in properties, false);
    // One way to say one thing — two properties meaning the same instance is a
    // way for a caller to set them to different values (ARCH-29 alias).
    assert.equal("instance" in properties, false);
    // The config file is the host's, chosen at launch through cwd and env.
    assert.equal("config" in properties, false);
  });

  it("requires nothing except the apply confirmations and a run id", () => {
    // A schema that demanded `scope` would make this server stricter than the
    // composition root it fronts: a host with `scope` in tessera.config.json
    // could no longer call the tool at all. The carve-out is a value no config
    // may supply on the caller's behalf, which is the whole point of it.
    //
    // The second carve-out is `runId` on the four run-state tools (decision
    // 13): the CLI reads it from argv alone, so no config can supply it and an
    // optional property would advertise a call that can only exit 2.
    const runState = [
      RUN_STATUS_TOOL,
      CONFIRM_READY_TOOL,
      CLEANUP_PLAN_TOOL,
      CLEANUP_APPLY_TOOL,
    ];
    for (const spec of TOOLS) {
      if (spec === APPLY_TOOL || runState.includes(spec)) continue;
      assert.equal("required" in inputSchemaFor(spec), false, spec.name);
    }
    assert.deepEqual(inputSchemaFor(APPLY_TOOL).required, ["mode"]);
    assert.deepEqual(inputSchemaFor(RUN_STATUS_TOOL).required, ["runId"]);
    assert.deepEqual(inputSchemaFor(CONFIRM_READY_TOOL).required, ["runId"]);
    assert.deepEqual(inputSchemaFor(CLEANUP_PLAN_TOOL).required, ["runId"]);
    assert.deepEqual(inputSchemaFor(CLEANUP_APPLY_TOOL).required, [
      "mode",
      "runId",
    ]);
  });

  it('advertises "apply" as the only value the mode property accepts', () => {
    const mode = inputSchemaFor(APPLY_TOOL).properties.mode;

    assert.deepEqual(mode.enum, ["apply"]);
    // The plan tool has no such property at all: `--mode` is pinned onto its
    // argv, so there is nothing for a caller to set in either direction.
    assert.equal("mode" in inputSchemaFor(PLAN_TOOL).properties, false);
  });

  it("advertises the run tool as one closed, optional property", () => {
    const schema = inputSchemaFor(RUN_TOOL);

    // `tess run` parses eighteen flags and this surface offers one of them.
    // The rest are argued in decision 10: the §11 knobs, the harness switches
    // that would fabricate the verdict, the audit-trail identities, and the
    // timing budgets.
    assert.deepEqual(Object.keys(schema.properties), ["runner"]);
    assert.equal(schema.properties.runner.type, "string");
    // Optional, like everywhere but the apply confirmation: the host may have
    // supplied the instance through SN_INSTANCE, and a schema that demanded it
    // would be stricter than the composition root it fronts (decision 3).
    assert.equal("required" in schema, false);
    // Closed, so a misspelled property is refused before anything runs rather
    // than silently dropped from the argv.
    assert.equal(schema.additionalProperties, false);
  });

  it("puts the §11 knobs out of reach of every tool", () => {
    // `--allow` is, in the guard's own words, the ONLY source of writability: a
    // caller who could set it would manufacture the classification that
    // authorises its own write. `--prod` is its mirror. Both belong to the
    // operator's configuration, alongside `--config`, and neither is exposed
    // here — nor is the §11.4 acknowledgement, which `tess run` DOES implement
    // (`--acknowledge-prod <reason>`, plumbed into `GuardConfig`): it covers
    // exactly the refusal a model must not be able to talk its way past, so the
    // spelling it would have to reach for is checked here rather than assumed
    // unimplementable.
    for (const spec of TOOLS) {
      const properties = inputSchemaFor(spec).properties;
      for (const knob of [
        "allow",
        "prod",
        "acknowledgeProd",
        "acknowledge_prod",
        "acknowledgeProdReason",
      ]) {
        assert.equal(knob in properties, false, `${spec.name}.${knob}`);
      }
    }
  });

  it("puts the run harness's evidence-forging switches out of reach too", () => {
    // A different threat from the §11 knobs and a worse one. `--fake` runs the
    // whole skeleton against `@tessera/fake-instance`, `--mutant` seeds a bug
    // into the source under test, and `--fake-production-property` makes a
    // non-prod instance look like production to the classifier. A caller who
    // could set any of them would not be configuring the run, it would be
    // FABRICATING the verdict — a GO that touched no instance reads exactly
    // like a GO that did. The audit-trail identities go the same way: `--actor`
    // names who ran, and `--ledger-root` decides where the §4b write-ahead
    // record lands, which is not a thing the party being audited gets to move.
    //
    // `runId` is carved out for the run-state tools alone (decision 13): there
    // it NAMES a run that already exists instead of minting the identity a new
    // one is audited under, and `preflight_run` still cannot set it.
    const namesAnExistingRun = new Set([
      RUN_STATUS_TOOL,
      CONFIRM_READY_TOOL,
      CLEANUP_PLAN_TOOL,
      CLEANUP_APPLY_TOOL,
    ]);
    for (const spec of TOOLS) {
      const properties = inputSchemaFor(spec).properties;
      for (const knob of [
        "fake",
        "mutant",
        "fakeProductionProperty",
        "keep",
        "actor",
        "runId",
        "ledgerRoot",
        "docsDir",
        "skeleton",
      ]) {
        if (knob === "runId" && namesAnExistingRun.has(spec)) continue;
        assert.equal(knob in properties, false, `${spec.name}.${knob}`);
      }
    }
    assert.equal("runId" in inputSchemaFor(RUN_TOOL).properties, false);
  });

  it("advertises only the flags `tess preflight` actually reads", () => {
    // An advertised flag that changes nothing reads as a knob and behaves as a
    // comment. `preflight` consumes runner/source/target/kinds/artifacts/mode
    // and ignores scope and story entirely.
    const plan = Object.keys(inputSchemaFor(PLAN_TOOL).properties);

    assert.deepEqual(plan, [
      "runner",
      "source",
      "target",
      "kinds",
      "artifacts",
    ]);
    // Apply is plan plus permission: same inputs, so the two tools cannot
    // answer about different runs — plus the two plan-identity fields only a
    // write reads (`--plan-hash`, `--idempotency-key`).
    assert.deepEqual(Object.keys(inputSchemaFor(APPLY_TOOL).properties), [
      "mode",
      ...plan,
      "planHash",
      "idempotencyKey",
    ]);
  });

  it("advertises only the flags `tess doctor` actually reads", () => {
    const doctor = Object.keys(inputSchemaFor(DOCTOR_TOOL).properties);

    // `doctor` consumes instance/target/kinds and nothing else — no `source`,
    // because it diagnoses instances rather than reading artifacts out of one.
    assert.deepEqual(doctor, ["runner", "target", "kinds"]);
    // The instance property is the CLI's KEY (`runner`), not its flag: there is
    // one property per instance, so there is nothing to set two ways.
    assert.equal("instance" in inputSchemaFor(DOCTOR_TOOL).properties, false);
    assert.equal(inputSchemaFor(DOCTOR_TOOL).properties.runner.type, "string");
  });

  it("tells a caller what OMITTING `kinds` does, not just that it may", () => {
    // The sentence this replaces was "**Omit for the default set.**", and there
    // is no default set anywhere on the path it describes. `tess doctor`
    // resolves the flag to `[]` (`packages/cli/src/commands/doctor.ts`);
    // `applicabilityOf` then marks every kind-gated precondition `deferred`,
    // `rollUp` leaves a deferred finding out of `status`, `hardFailureOf`
    // returns early on an empty list, and the provisioner plans a step only for
    // a `required` one. Omitting the field does not widen the check — it turns
    // the gate off, and the report still comes back green.
    //
    // Deleting the false clause would have been half a fix: a caller told
    // nothing about the default guesses, and "check everything" is the guess
    // the word "optional" invites. So the three places the empty list is felt
    // are each named, and each is asserted here — a description that kept only
    // "THERE IS NO DEFAULT SET" would pass a keyword pin and still leave the
    // caller with no idea what it got instead.
    const kinds = inputSchemaFor(DOCTOR_TOOL).properties.kinds.description;

    assert.match(kinds, /THERE IS NO DEFAULT SET/);
    assert.match(kinds, /the list is empty/);
    assert.match(kinds, /reported `deferred`/);
    assert.match(kinds, /left out of the `status` roll-up/);
    assert.match(kinds, /left out of any provision plan/);
    assert.match(kinds, /unable to raise the hard failure/);
    // ...and the action that turns the gating back on, so the field reads as a
    // decision the caller makes rather than as a warning about itself.
    assert.match(kinds, /Naming the kinds you intend to run/);
  });

  it("does not re-offer the default set in anybody's words", () => {
    // The positive control comes first: an anchor that flags nothing is not an
    // anchor. `defaultSetClaims` must catch the wording that was here, a
    // paraphrase of it, and a plausible restatement that shares neither
    // sentence's vocabulary — otherwise this is a spell-checker for six words.
    assert.deepEqual(defaultSetClaims("Omit for the default set."), [
      "Omit for the default set.",
    ]);
    assert.deepEqual(
      defaultSetClaims("If you leave it out, every kind is checked."),
      ["If you leave it out, every kind is checked."],
    );
    assert.deepEqual(defaultSetClaims("Defaults to all three kinds."), [
      "Defaults to all three kinds.",
    ]);
    assert.deepEqual(defaultSetClaims("Without a kind, all kinds are gated."), [
      "Without a kind, all kinds are gated.",
    ]);
    // A denial of the same claim is not the claim. This is what keeps the
    // anchor from forbidding the sentence that has to be there.
    assert.deepEqual(
      defaultSetClaims("Omitting this does not mean “check every kind”."),
      [],
    );

    for (const spec of [DOCTOR_TOOL, PLAN_TOOL, APPLY_TOOL]) {
      assert.deepEqual(
        defaultSetClaims(inputSchemaFor(spec).properties.kinds.description),
        [],
        `${spec.name} promises a default set`,
      );
    }
  });

  it("states the hard failure's real trigger, undecided included", () => {
    // `hardFailureOf` (`packages/doctor/src/doctor.ts`) raises on a kind-gated
    // finding that is `required` and whose status is merely `!== "ready"`, so
    // `unknown` raises it exactly as `not-ready` does. "A kind the runner
    // cannot support" named only half of that, and the half it left out is the
    // dangerous one: a runner nobody could reach is the case a caller is most
    // likely to read as probably fine.
    const kinds = inputSchemaFor(PLAN_TOOL).properties.kinds.description;

    assert.match(kinds, /does not come back `ready`/);
    assert.match(kinds, /HARD FAILURE/);
    assert.match(kinds, /undecided counts/);
    assert.match(kinds, /would hang and report nothing/);
    assert.match(kinds, /DEV-2/);
    // Shape, not wording: any restatement of the trigger as a question of what
    // the runner supports re-excludes `unknown`, whichever verb it uses.
    const SUPPORT_TRIGGER =
      /\bun-?supported\b|\bnot supported\b|\b(?:cannot|can(?:'|’)t|could not|does not|doesn(?:'|’)t|is unable to|fails to|will not|won(?:'|’)t)\s+(?:support|provide|offer|host|handle)\b/i;
    assert.equal(
      SUPPORT_TRIGGER.test("a kind the runner cannot support"),
      true,
    );
    assert.equal(
      SUPPORT_TRIGGER.test("a kind this runner does not support"),
      true,
    );
    assert.equal(SUPPORT_TRIGGER.test("an unsupported kind"), true);
    assert.doesNotMatch(
      kinds,
      SUPPORT_TRIGGER,
      "a support-shaped trigger excludes `unknown`, which raises it too",
    );
  });

  it("shares one `kinds` sentence across the three tools that take it", () => {
    // The reuse defence in `tools.ts` is a claim about exactly this: one field,
    // three tools, one sentence true on all three. What makes it true is that
    // the sentence is written about APPLICABILITY — what the list does to a
    // finding — rather than about any one document. `tess doctor`'s report has
    // no plan in it, so a sentence naming `plan.steps` would be false there;
    // and the doctor is not the only consumer, so a sentence about the
    // diagnosis alone would understate what omitting the field costs on plan
    // and apply, where the same list also reaches the provisioner.
    const kindsOf = (spec) => inputSchemaFor(spec).properties.kinds.description;

    assert.equal(kindsOf(PLAN_TOOL), kindsOf(DOCTOR_TOOL));
    assert.equal(kindsOf(APPLY_TOOL), kindsOf(DOCTOR_TOOL));
    assert.doesNotMatch(
      kindsOf(DOCTOR_TOOL),
      /\bplan\.steps\b|`steps`|\bblockers\b/,
      "the doctor's document has no plan to name",
    );
  });

  it("adds one `kind` to coverage's fields for generation and nothing else", () => {
    const coverage = Object.keys(inputSchemaFor(COVERAGE_TOOL).properties);
    const generate = Object.keys(inputSchemaFor(GENERATE_TOOL).properties);

    // Same analysis, one extra decision: which kind of spec to propose. A field
    // that appeared here and not on coverage would mean the two tools can
    // disagree about what they are looking at.
    assert.deepEqual(generate, [...coverage, "kind"]);
    assert.equal(inputSchemaFor(GENERATE_TOOL).properties.kind.type, "string");
  });

  it("keeps generation's backend, endpoint, key and budget off the surface", () => {
    // Decision 9, and it is the egress control. `provider` is the switch
    // between an offline generator and one that POSTs the impact graph to a
    // vendor; `baseUrl` names the host it would be POSTed to; `apiKey` is read
    // from the environment and must never travel through a tool call. A caller
    // that could set any of them would be authorising its own egress, which is
    // precisely what SEC-2 keeps on the operator's side of the line.
    const properties = inputSchemaFor(GENERATE_TOOL).properties;

    for (const knob of ["provider", "model", "baseUrl", "apiKey", "deadlineMs"])
      assert.equal(knob in properties, false, `${knob} is the operator's`);
  });

  it("closes the object so an invented flag is refused, not dropped", () => {
    assert.equal(inputSchemaFor(IMPACT_TOOL).additionalProperties, false);
    assert.equal(inputSchemaFor(GENERATE_TOOL).additionalProperties, false);
    assert.equal(inputSchemaFor(APPLY_TOOL).additionalProperties, false);
  });

  it("types the repeatable flag as a non-empty array of strings", () => {
    const tables = inputSchemaFor(IMPACT_TOOL).properties.artifactTables;

    assert.equal(tables.type, "array");
    assert.deepEqual(tables.items, { type: "string" });
    assert.equal(tables.minItems, 1);
  });
});

// ── validation ──────────────────────────────────────────────────────────────

describe("@tessera/mcp — argument validation", () => {
  it("accepts an absent argument object", () => {
    assert.equal(values(IMPACT_TOOL, undefined).size, 0);
    assert.equal(values(IMPACT_TOOL, {}).size, 0);
  });

  it("treats null as absent, because hosts serialise omissions that way", () => {
    const map = values(IMPACT_TOOL, { scope: "x_demo", story: null });

    assert.equal(map.get("scope"), "x_demo");
    assert.equal(map.has("story"), false);
  });

  it("names the property when it does not exist on the tool", () => {
    // `--update-set` is a real CLI flag that is REFUSED with a deferral message
    // (DESIGN §12.3), and it is not in the impact table at all — so a caller who
    // reaches for it must be told, not quietly answered without it.
    const outcome = validateArguments(IMPACT_TOOL, { updateSet: "abc" });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /unknown argument `updateSet`/);
    assert.match(outcome.message, /this tool accepts .*scope/);
  });

  it("refuses `testsRoot` on the impact tool and accepts it on coverage", () => {
    assert.equal(
      validateArguments(IMPACT_TOOL, { testsRoot: "tests" }).ok,
      false,
    );
    assert.equal(
      validateArguments(COVERAGE_TOOL, { testsRoot: "tests" }).ok,
      true,
    );
  });

  it("advertises the ledger's run-id pattern on every run-state tool", () => {
    // The pattern is the ledger's own, imported rather than copied, so the
    // schema can never drift from what `validateRunId` enforces.
    for (const spec of [
      RUN_STATUS_TOOL,
      CONFIRM_READY_TOOL,
      CLEANUP_PLAN_TOOL,
      CLEANUP_APPLY_TOOL,
    ]) {
      assert.equal(
        inputSchemaFor(spec).properties.runId.pattern,
        RUN_ID_PATTERN.source,
        spec.name,
      );
    }
  });

  it("refuses a run id the ledger would refuse, before any argv exists", () => {
    for (const bad of [
      "x^ORsys_idISNOTEMPTY^name!=",
      "../x",
      "a/b",
      "RUN-1",
      "",
      "x".repeat(129),
    ]) {
      const outcome = validateArguments(RUN_STATUS_TOOL, { runId: bad });
      assert.equal(outcome.ok, false, JSON.stringify(bad));
      assert.match(outcome.message, /`runId` must match/);
    }
    assert.equal(
      values(RUN_STATUS_TOOL, { runId: "run-1.a_b" }).get("runId"),
      "run-1.a_b",
    );
  });

  it("refuses a value that starts with a dash, since argv would read a flag", () => {
    // Delegated decision 2026-09-25 (tools.ts `flagLikeValue`).
    for (const [spec, args] of [
      [RUN_STATUS_TOOL, { runId: "--help" }],
      [CONFIRM_READY_TOOL, { runId: "-h" }],
      [IMPACT_TOOL, { scope: "--help" }],
      [IMPACT_TOOL, { artifactTables: ["sys_script", "--help"] }],
    ]) {
      const outcome = validateArguments(spec, args);
      assert.equal(outcome.ok, false, JSON.stringify(args));
      assert.match(outcome.message, /must not start with "-"/);
    }
  });

  it("refuses a number where a string belongs", () => {
    const outcome = validateArguments(IMPACT_TOOL, { scope: 7 });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /`scope` must be a string; received number/);
  });

  it("refuses a bare string for the repeatable flag", () => {
    const outcome = validateArguments(IMPACT_TOOL, {
      artifactTables: "sys_script",
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /must be an array of strings/);
  });

  it("refuses an empty list rather than falling through to the default set", () => {
    // The trap this closes: `[]` would produce no flags, the CLI default would
    // apply, and the caller would read an answer computed over exactly the
    // tables they believed they had excluded.
    const outcome = validateArguments(IMPACT_TOOL, { artifactTables: [] });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /at least one value/);
  });

  it("refuses an array of arguments", () => {
    const outcome = validateArguments(IMPACT_TOOL, ["x_demo"]);

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /must be an object; received an array/);
  });

  it("refuses an apply with no mode, so no default can perform a write", () => {
    const outcome = validateArguments(APPLY_TOOL, { runner: "runner" });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /`mode` is required for preflight_apply/);
    assert.match(outcome.message, /must be "apply"/);
  });

  it("refuses a null mode, because a forgotten argument is not a confirmation", () => {
    // Everywhere else on this surface `null` means "absent" and is shrugged
    // off. Here it must not be: a privileged act a serialisation quirk could
    // still perform is not a confirmation of anything.
    const outcome = validateArguments(APPLY_TOOL, { mode: null });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /`mode` is required/);
  });

  it("refuses any mode but the literal `apply`", () => {
    const outcome = validateArguments(APPLY_TOOL, { mode: "plan" });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /`mode` must be "apply" for preflight_apply/);
    assert.match(outcome.message, /received "plan"/);
  });

  it("accepts the apply tool with its confirmation spelled out", () => {
    const map = values(APPLY_TOOL, { mode: "apply", runner: "runner" });

    assert.equal(map.get("mode"), "apply");
    assert.equal(map.get("runner"), "runner");
  });

  it("refuses the generation provider as an argument, by name", () => {
    // The refusal is the egress control doing its job, and the wording is half
    // of it: told "unknown argument", a model learns the switch is not here to
    // be found, rather than that it guessed the spelling wrong.
    const outcome = validateArguments(GENERATE_TOOL, {
      scope: "x_demo",
      provider: "anthropic",
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /unknown argument `provider`/);
    assert.match(outcome.message, /this tool accepts .*kind/);
  });

  it("refuses an api key on the generate tool rather than forwarding it", () => {
    const outcome = validateArguments(GENERATE_TOOL, { apiKey: "sk-ant-x" });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /unknown argument `apiKey`/);
  });

  it("refuses the §11 allowlist as an argument of the mutating tool", () => {
    // The message matters as much as the refusal: a model told "unknown
    // argument" learns the knob does not exist here, rather than that it
    // guessed the spelling wrong.
    const outcome = validateArguments(APPLY_TOOL, {
      mode: "apply",
      allow: ["dev-runner.service-now.com"],
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /unknown argument `allow`/);
  });
});

// ── argv ────────────────────────────────────────────────────────────────────

describe("@tessera/mcp — the argv handed to the composition root", () => {
  it("leads with the subcommand and --json", () => {
    assert.deepEqual(toArgv(IMPACT_TOOL, values(IMPACT_TOOL, {})), [
      "impact",
      "--json",
    ]);
  });

  it("orders flags by the tool's field list, not by JSON key order", () => {
    const forwards = toArgv(
      IMPACT_TOOL,
      values(IMPACT_TOOL, { source: "dev", scope: "x_demo" }),
    );
    const backwards = toArgv(
      IMPACT_TOOL,
      values(IMPACT_TOOL, { scope: "x_demo", source: "dev" }),
    );

    assert.deepEqual(forwards, backwards);
    assert.deepEqual(forwards, [
      "impact",
      "--json",
      "--source",
      "dev",
      "--scope",
      "x_demo",
    ]);
  });

  it("repeats the flag once per entry of a list", () => {
    const argv = toArgv(
      IMPACT_TOOL,
      values(IMPACT_TOOL, {
        artifactTables: ["sys_script_include", "sys_script"],
      }),
    );

    assert.deepEqual(argv, [
      "impact",
      "--json",
      "--artifact-table",
      "sys_script_include",
      "--artifact-table",
      "sys_script",
    ]);
  });

  it("emits nothing for an omitted field, leaving precedence to the CLI", () => {
    // Not `--scope ""`: an empty flag would override a scope the config file
    // supplied, and the layer that owns precedence is `@tessera/config`.
    const argv = toArgv(
      COVERAGE_TOOL,
      values(COVERAGE_TOOL, { testsRoot: "t" }),
    );

    assert.deepEqual(argv, ["coverage", "--json", "--tests-root", "t"]);
  });

  it("pins `--skeleton` rather than offering it as a one-value knob", () => {
    // `tess run` refuses to run without it — "Phase 0.5 has exactly one mode,
    // and the flag is what says the caller knows it". Exposed, it would be a
    // property with one legal value and one usage error behind every other, so
    // it goes where `--mode plan` went.
    assert.deepEqual(toArgv(RUN_TOOL, values(RUN_TOOL, {})), [
      "run",
      "--json",
      "--skeleton",
    ]);
    assert.deepEqual(
      toArgv(
        RUN_TOOL,
        values(RUN_TOOL, { runner: "dev12345.service-now.com" }),
      ),
      ["run", "--json", "--skeleton", "--instance", "dev12345.service-now.com"],
    );
  });

  it("pins `--mode plan` so the environment cannot turn a read into a write", () => {
    // The CLI already defaults to plan mode, and a default is not a guarantee:
    // `TESSERA_MODE=apply` in the host's environment beats it. A tool
    // advertised `readOnlyHint: true` has to be read-only by construction, so
    // the flag is on the argv whether or not the caller sent anything.
    assert.deepEqual(toArgv(PLAN_TOOL, values(PLAN_TOOL, {})), [
      "preflight",
      "--json",
      "--mode",
      "plan",
    ]);
  });

  it("cannot be talked into an apply through the plan tool", () => {
    // There is no property to set, and the pinned flag is emitted before any
    // field could be — so no argument object produces a second `--mode`.
    const argv = toArgv(
      PLAN_TOOL,
      values(PLAN_TOOL, { runner: "runner", artifacts: ["sys_script/abc"] }),
    );

    assert.deepEqual(
      argv.filter((entry) => entry === "--mode"),
      ["--mode"],
    );
    assert.equal(argv[argv.indexOf("--mode") + 1], "plan");
    assert.equal(argv.includes("apply"), false);
  });

  it("puts the apply tool's confirmation first on the argv it delegates", () => {
    // The flag that makes this a write is the one a reader of the audit trail
    // sees first, and it is there because the caller said so — not because a
    // default supplied it.
    const argv = toArgv(
      APPLY_TOOL,
      values(APPLY_TOOL, { mode: "apply", runner: "runner" }),
    );

    assert.deepEqual(argv, [
      "preflight",
      "--json",
      "--mode",
      "apply",
      "--runner",
      "runner",
    ]);
  });

  it("carries generation's inputs through under the generate subcommand", () => {
    const argv = toArgv(
      GENERATE_TOOL,
      values(GENERATE_TOOL, {
        source: "dev",
        scope: "x_demo",
        testsRoot: "tests",
        kind: "e2e",
      }),
    );

    assert.deepEqual(argv, [
      "generate",
      "--json",
      "--source",
      "dev",
      "--scope",
      "x_demo",
      "--tests-root",
      "tests",
      "--kind",
      "e2e",
    ]);
    // Nothing on the argv names a backend: whichever generator runs is the one
    // the operator's configuration and environment select, and this call cannot
    // move that choice in either direction.
    for (const flag of ["--provider", "--base-url", "--api-key", "--model"])
      assert.equal(argv.includes(flag), false);
  });

  it("carries the resolver's inputs through under the resolve subcommand", () => {
    const argv = toArgv(
      RESOLVE_TOOL,
      values(RESOLVE_TOOL, {
        source: "dev",
        story: "STRY0010001",
        artifactTables: ["sys_script"],
      }),
    );

    assert.deepEqual(argv, [
      "resolve",
      "--json",
      "--source",
      "dev",
      "--story",
      "STRY0010001",
      "--artifact-table",
      "sys_script",
    ]);
  });
});

// ── the run-state tools ─────────────────────────────────────────────────────

describe("@tessera/mcp — the run-state tools (§6b rows)", () => {
  const RUN_STATE = [
    RUN_STATUS_TOOL,
    CONFIRM_READY_TOOL,
    CLEANUP_PLAN_TOOL,
    CLEANUP_APPLY_TOOL,
  ];

  it("pins the argv each run-state tool delegates, with --json forced", () => {
    assert.deepEqual(
      toArgv(
        RUN_STATUS_TOOL,
        values(RUN_STATUS_TOOL, { runId: "r1", since: 3 }),
      ),
      ["status", "--json", "--run-id", "r1", "--since", "3"],
    );
    assert.deepEqual(
      toArgv(CONFIRM_READY_TOOL, values(CONFIRM_READY_TOOL, { runId: "r1" })),
      ["confirm", "--json", "--run-id", "r1"],
    );
    // The plan half pins `--mode plan` ahead of any field (decision 12).
    assert.deepEqual(
      toArgv(
        CLEANUP_PLAN_TOOL,
        values(CLEANUP_PLAN_TOOL, { runId: "r1", runner: "p" }),
      ),
      [
        "cleanup",
        "--json",
        "--mode",
        "plan",
        "--run-id",
        "r1",
        "--runner",
        "p",
      ],
    );
    // The apply half carries the confirmation first, as preflight_apply does.
    assert.deepEqual(
      toArgv(
        CLEANUP_APPLY_TOOL,
        values(CLEANUP_APPLY_TOOL, { mode: "apply", runId: "r1", runner: "p" }),
      ),
      [
        "cleanup",
        "--json",
        "--mode",
        "apply",
        "--run-id",
        "r1",
        "--runner",
        "p",
      ],
    );
  });

  it("appends the plan hash and idempotency key to the apply argv", () => {
    assert.deepEqual(
      toArgv(
        APPLY_TOOL,
        values(APPLY_TOOL, {
          idempotencyKey: "k-1",
          planHash: "sha256:abc",
          mode: "apply",
          runner: "runner",
        }),
      ),
      [
        "preflight",
        "--json",
        "--mode",
        "apply",
        "--runner",
        "runner",
        "--plan-hash",
        "sha256:abc",
        "--idempotency-key",
        "k-1",
      ],
    );
  });

  it("requires a run id on every run-state tool", () => {
    for (const spec of RUN_STATE) {
      const args = spec === CLEANUP_APPLY_TOOL ? { mode: "apply" } : {};
      const outcome = validateArguments(spec, args);
      assert.equal(outcome.ok, false, spec.name);
      assert.match(outcome.message, /runId/, spec.name);
    }
  });

  it("types `since` as a non-negative integer, in the schema and in validation", () => {
    const since = inputSchemaFor(RUN_STATUS_TOOL).properties.since;
    assert.equal(since.type, "integer");
    assert.equal(since.minimum, 0);

    for (const bad of [-1, 1.5, "3", Number.MAX_SAFE_INTEGER + 2]) {
      const outcome = validateArguments(RUN_STATUS_TOOL, {
        runId: "r1",
        since: bad,
      });
      assert.equal(outcome.ok, false, String(bad));
      assert.match(outcome.message, /`since` must be a non-negative integer/);
    }
    // Zero is a cursor like any other, and reaches the argv as a string.
    assert.deepEqual(
      toArgv(
        RUN_STATUS_TOOL,
        values(RUN_STATUS_TOOL, { runId: "r1", since: 0 }),
      ),
      ["status", "--json", "--run-id", "r1", "--since", "0"],
    );
  });

  it("offers no mode on the cleanup plan tool and only `apply` on its twin", () => {
    assert.equal("mode" in inputSchemaFor(CLEANUP_PLAN_TOOL).properties, false);
    const refused = validateArguments(CLEANUP_PLAN_TOOL, {
      runId: "r1",
      mode: "apply",
    });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /mode/);

    assert.deepEqual(inputSchemaFor(CLEANUP_APPLY_TOOL).properties.mode.enum, [
      "apply",
    ]);
    for (const mode of ["plan", "APPLY", null, true]) {
      const outcome = validateArguments(CLEANUP_APPLY_TOOL, {
        runId: "r1",
        mode,
      });
      assert.equal(outcome.ok, false, String(mode));
    }
  });

  it("never lets a read-only tool's argv carry `--mode apply`", () => {
    // Every read-only tool, fed the richest argument object it accepts: the
    // argv it delegates must not contain the word that turns a read into a
    // write, whatever the caller sent.
    for (const spec of TOOLS.filter(
      (tool) => tool.writeClass === "read-only",
    )) {
      const args = {};
      for (const field of spec.fields) {
        args[field.name] =
          field.type === "stringList"
            ? ["apply"]
            : field.type === "integer"
              ? 1
              : (field.only ?? "apply");
      }
      const outcome = validateArguments(spec, args);
      assert.equal(outcome.ok, true, `${spec.name}: ${outcome.message}`);
      const argv = toArgv(spec, outcome.values);
      const modes = argv.flatMap((entry, i) =>
        entry === "--mode" ? [argv[i + 1]] : [],
      );
      assert.equal(modes.includes("apply"), false, spec.name);
    }
    // And the run-state readers carry no mode property to set at all.
    for (const spec of [
      RUN_STATUS_TOOL,
      CONFIRM_READY_TOOL,
      CLEANUP_PLAN_TOOL,
    ]) {
      assert.equal("mode" in inputSchemaFor(spec).properties, false, spec.name);
    }
  });

  it("keeps --confirm-unrecorded off the surface (decision 17)", () => {
    // `tess cleanup --confirm-unrecorded <run-id>` lifts the F2d refusal of a
    // namespace sweep with no local record — a human's confirmation that the
    // namespace is Tessera's. No tool advertises it, in any spelling.
    for (const spec of TOOLS) {
      for (const property of Object.keys(inputSchemaFor(spec).properties)) {
        assert.doesNotMatch(property, /unrecorded/i, spec.name);
      }
      for (const field of spec.fields) {
        assert.notEqual(field.flag, "--confirm-unrecorded", spec.name);
      }
      assert.equal(
        (spec.pinned ?? []).includes("--confirm-unrecorded"),
        false,
        spec.name,
      );
    }

    // Offered anyway, as a boolean or as the retyped id, it is refused as an
    // unknown argument before any argv exists — never coerced, never dropped.
    for (const [spec, base] of [
      [CLEANUP_PLAN_TOOL, { runId: "smoke" }],
      [CLEANUP_APPLY_TOOL, { mode: "apply", runId: "smoke" }],
    ]) {
      for (const [key, value] of [
        ["confirmUnrecorded", true],
        ["confirmUnrecorded", false],
        ["confirmUnrecorded", "smoke"],
        ["confirmUnrecorded", "true"],
        ["confirm_unrecorded", "smoke"],
        ["--confirm-unrecorded", "smoke"],
      ]) {
        const outcome = validateArguments(spec, { ...base, [key]: value });
        assert.equal(outcome.ok, false, `${spec.name}.${key}=${value}`);
        assert.ok(
          outcome.message.includes(`\`${key}\``),
          `${spec.name}: ${outcome.message}`,
        );
      }
    }

    // And no value can smuggle it in. A string spelled like the flag is
    // refused outright (it would be read as a flag), and what IS accepted
    // reaches `toArgv`, which emits strict flag/value pairs: every FLAG
    // position of every cleanup argv is a flag the tool declares.
    for (const spec of [CLEANUP_PLAN_TOOL, CLEANUP_APPLY_TOOL]) {
      const base = spec === CLEANUP_APPLY_TOOL ? { mode: "apply" } : {};
      const smuggled = validateArguments(spec, {
        ...base,
        runId: "smoke",
        runner: "--confirm-unrecorded",
      });
      assert.equal(smuggled.ok, false, spec.name);
      assert.match(smuggled.message, /must not start with "-"/);

      const argv = toArgv(
        spec,
        values(spec, { ...base, runId: "smoke", runner: "p" }),
      );
      const declared = new Set([
        ...spec.fields.map((field) => field.flag),
        "--mode",
      ]);
      assert.equal(argv[0], "cleanup");
      assert.equal(argv[1], "--json");
      for (let index = 2; index < argv.length; index += 2) {
        assert.ok(declared.has(argv[index]), `${spec.name}: ${argv[index]}`);
      }
      assert.equal(argv.includes("--confirm-unrecorded"), false, spec.name);
    }

    // Both descriptions say where the confirmation lives instead.
    assert.match(CLEANUP_PLAN_TOOL.description, /unrecordedSweep/);
    assert.match(
      CLEANUP_PLAN_TOOL.description,
      /--confirm-unrecorded`[^.]*not an argument of either cleanup tool/,
    );
    assert.match(
      CLEANUP_APPLY_TOOL.description,
      /not an argument of this tool/,
    );
    assert.match(CLEANUP_APPLY_TOOL.refusalReading, /--confirm-unrecorded/);
  });

  it("keeps the run-state tools' audit and §11 flags off the surface", () => {
    for (const spec of RUN_STATE) {
      const properties = Object.keys(inputSchemaFor(spec).properties);
      for (const knob of [
        "ledgerRoot",
        "actor",
        "allow",
        "prod",
        "acknowledgeProd",
      ]) {
        assert.equal(properties.includes(knob), false, `${spec.name}.${knob}`);
      }
    }
    assert.deepEqual(Object.keys(inputSchemaFor(RUN_STATUS_TOOL).properties), [
      "runId",
      "since",
    ]);
    assert.deepEqual(
      Object.keys(inputSchemaFor(CONFIRM_READY_TOOL).properties),
      ["runId"],
    );
    assert.deepEqual(
      Object.keys(inputSchemaFor(CLEANUP_PLAN_TOOL).properties),
      ["runId", "runner"],
    );
    assert.deepEqual(
      Object.keys(inputSchemaFor(CLEANUP_APPLY_TOOL).properties),
      ["mode", "runId", "runner"],
    );
  });

  it("serves the legacy sweep as discovery only (decision 18)", () => {
    // Legacy rows carry no ownership marker, so nothing an agent can pass
    // proves them Tessera's. The inventory is a read; the delete belongs to
    // the operator at the command line, with a saved report and their own
    // list of sys_ids, and neither half of that has a counterpart here.
    const legacy = TOOLS.filter((tool) =>
      (tool.pinned ?? []).includes("--legacy"),
    );
    assert.deepEqual(
      legacy.map((tool) => tool.name),
      ["preflight_cleanup_legacy_plan"],
    );
    assert.equal(
      findTool("preflight_cleanup_legacy_plan"),
      CLEANUP_LEGACY_PLAN_TOOL,
    );
    assert.equal(CLEANUP_LEGACY_PLAN_TOOL.writeClass, "read-only");
    assert.equal(CLEANUP_LEGACY_PLAN_TOOL.egress, "none");
    assert.equal(CLEANUP_LEGACY_PLAN_TOOL.reportsVerdict, false);
    assert.deepEqual(CLEANUP_LEGACY_PLAN_TOOL.pinned, [
      "--legacy",
      "--mode",
      "plan",
    ]);
    const { annotations } = toolDefinition(CLEANUP_LEGACY_PLAN_TOOL);
    assert.equal(annotations.readOnlyHint, true);
    assert.equal(annotations.openWorldHint, true);

    for (const spec of TOOLS) {
      assert.doesNotMatch(
        spec.name,
        /legacy.*(apply|delete)|(apply|delete).*legacy/,
      );
      if (spec.writeClass !== "read-only") {
        assert.equal(
          (spec.pinned ?? []).includes("--legacy"),
          false,
          spec.name,
        );
      }
      for (const field of spec.fields) {
        assert.equal(
          ["confirm", "report", "sysIds", "legacy"].includes(field.name),
          false,
          `${spec.name}.${field.name}`,
        );
        assert.equal(
          ["--confirm", "--report", "--legacy"].includes(field.flag),
          false,
          `${spec.name} ${field.flag}`,
        );
      }
    }

    // Unknown arguments are refused, not dropped: the apply half's knobs
    // cannot be smuggled in by name.
    for (const extra of [
      { confirm: "a".repeat(32) },
      { report: "legacy.json" },
      { mode: "apply" },
    ]) {
      assert.equal(
        validateArguments(CLEANUP_LEGACY_PLAN_TOOL, {
          runner: "dev",
          ...extra,
        }).ok,
        false,
        JSON.stringify(extra),
      );
    }

    assert.deepEqual(
      toArgv(
        CLEANUP_LEGACY_PLAN_TOOL,
        values(CLEANUP_LEGACY_PLAN_TOOL, {
          runner: "dev",
          runIds: ["bench-01", "bench-02"],
        }),
      ),
      [
        "cleanup",
        "--json",
        "--legacy",
        "--mode",
        "plan",
        "--runner",
        "dev",
        "--run-id",
        "bench-01",
        "--run-id",
        "bench-02",
      ],
    );
    assert.deepEqual(
      toArgv(
        CLEANUP_LEGACY_PLAN_TOOL,
        values(CLEANUP_LEGACY_PLAN_TOOL, { runner: "dev" }),
      ),
      ["cleanup", "--json", "--legacy", "--mode", "plan", "--runner", "dev"],
    );

    // Every run id is held to the ledger's pattern — an entry that could read
    // as a flag never reaches the argv.
    for (const bad of ["--mode", "-x", "has space", ""]) {
      const outcome = validateArguments(CLEANUP_LEGACY_PLAN_TOOL, {
        runner: "dev",
        runIds: ["bench-01", bad],
      });
      assert.equal(outcome.ok, false, bad);
      assert.match(outcome.message, /runIds/);
    }
    const schema = inputSchemaFor(CLEANUP_LEGACY_PLAN_TOOL);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "runIds",
      "runner",
    ]);
    assert.equal(schema.properties.runIds.items.pattern, RUN_ID_PATTERN.source);
  });
});

// Wave 16: the MCP surface declares no output schema, so a relayed document —
// including a live record's `artifactTablesRefused` entries and their
// `read: "lookup"` tag — cannot be rejected or stripped by a host validating
// `structuredContent` against one. Adding an `outputSchema` later means
// re-deciding that, including the tag (see results.test.js).
describe("@tessera/mcp — no output schema (wave 16)", () => {
  it("declares no outputSchema on any tool, so no document field can be validated away", () => {
    for (const spec of TOOLS) {
      const definition = toolDefinition(spec);
      assert.equal("outputSchema" in definition, false, spec.name);
      assert.deepEqual(
        Object.keys(definition).sort(),
        ["annotations", "description", "inputSchema", "name", "title"],
        spec.name,
      );
    }
  });

  it("words no artifact-table refusal of its own in any tool description", () => {
    // The CLI owns the two wordings (enumeration vs impact lookup); a tool
    // description paraphrasing either would be a third copy that drifts.
    for (const spec of TOOLS) {
      assert.doesNotMatch(
        toolDefinition(spec).description,
        /artifactTablesRefused|could not be enumerated|enumeration is incomplete|lookup is incomplete/,
        spec.name,
      );
    }
  });
});
