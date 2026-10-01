// The tool contract, as data — DESIGN §6b's shape, for the thirteen tools that
// have a `tess` subcommand behind them: the ARCH-5 resolution
// (`preflight_resolve`), the two read-only reports v0.2/v0.3 shipped
// (`preflight_impact`, `preflight_coverage`), the §12.3 environment doctor
// (`preflight_doctor`), the ARCH-2/ARCH-13 plan/apply pair (`preflight_plan`,
// `preflight_apply`), the Phase-6 spec generator (`preflight_generate`), the
// Phase-5 walking-skeleton runner (`preflight_run`), and §6b's three run-state
// rows — `preflight_run_status`, `preflight_confirm_ready` and the §4b cleanup
// pair `preflight_cleanup_plan` / `preflight_cleanup_apply` (decisions 12–15),
// plus the read-only legacy-row inventory `preflight_cleanup_legacy_plan`
// (decision 18), which has no apply half on this surface.
//
// EIGHTEEN DECISIONS ARE RECORDED HERE RATHER THAN INVENTED SILENTLY, because the
// corpus does not settle them and a later reader would otherwise have to guess
// whether they were considered:
//
//  1. **`preflight_impact` SUPPLEMENTS §6b's bare `impact`; it does not rename
//     it.** PLAN's milestone table says "MCP tool `preflight_impact`" while §6b's
//     nine-tool table says `impact`. `preflight_doctor` (USER-JOURNEY §…) is the
//     precedent for an additive name, so the prefix is treated as a namespace a
//     host sees, not as a rewrite of the contract table. The prefix is now used
//     THROUGHOUT — §6b's `resolve`, `plan` and `apply` arrive below as
//     `preflight_resolve`, `preflight_plan` and `preflight_apply` — which is the
//     "keep it or drop it, but do not ship a mix" this comment used to owe.
//
//  2. **There is no `preflight_coverage` row in §6b at all** — the table predates
//     the coverage report (recorded as a gap in GAP-ANALYSIS). This file adds the
//     tool because PLAN requires it, with the same annotation set the read-only
//     rows in §6b carry, and the gap stays owed against the table, not the code.
//
//  3. **Presence is NOT validated here; types are.** No property is `required`,
//     even `scope`, which `tess impact` refuses to run without. The reason is
//     that `--scope` may arrive from `tessera.config.json` or `TESSERA_SCOPE`,
//     and a schema that demanded it would make this server stricter than the
//     composition root it fronts — a host that configured a scope could no longer
//     call the tool. The rule the whole package follows: this layer refuses only
//     what it can prove wrong WITHOUT running anything (a misspelled property, a
//     number where a string belongs); anything the pipeline itself refuses comes
//     back as a tool result, worded by the pipeline, because the reason is the
//     pipeline's to give.
//
//     There are exactly TWO carve-outs: `mode` on `preflight_apply` and
//     `preflight_cleanup_apply` (decision 6, and decision 12 for the second),
//     and `runId` on the run-state tools (decision 13) — an identifier that is
//     argv-only in the CLI, so no config or environment layer could supply it
//     and "the pipeline may still find it elsewhere" is false of it.
//
//  4. **A tool's effects are DECLARED, never discovered by calling it.** Every
//     spec carries a `writeClass` AND an `egress` — what a call does, and where
//     the doing lands — and the MCP annotations are derived from the first rather
//     than hard-coded, so a mutating tool cannot be added without somebody
//     writing the word. All three of §6b's classes now have a row: read-only
//     (nine tools), mutating (`preflight_apply`, `preflight_run`,
//     `preflight_cleanup_apply`) and `repo-write`
//     (`preflight_generate`, which writes proposals into the working tree and
//     never touches an instance). `ToolEgress` gained its third member with the
//     same tool and for the same reason — see decision 8 — so every member of
//     both unions is still selected by something, and "a member nothing selects
//     is a classification a reader has to check the code to disbelieve" stays
//     true of this file rather than being a rule it used to follow.
//
//  5. **The §11 knobs are NOT tool arguments.** `tess preflight` and `tess run`
//     accept `--allow` (the §11.2 non-prod allowlist) and `--prod`; neither is
//     exposed by either tool.
//     The allowlist is, in the guard's own words, the ONLY source of writability:
//     an unlisted host classifies `unknown` and is never writable, and a listed
//     one becomes `sub-prod` unless a probe downgrades it. A model that could set
//     `allow` could therefore manufacture the classification that authorises its
//     own write, which is the §11.2 threat exactly (SEC-2: an LLM may PROPOSE a
//     write, never AUTHORISE one). So both stay where `--config` already is — the
//     host's business, supplied once at launch through `tessera.config.json`,
//     `TESSERA_ALLOW` and `TESSERA_PROD`, by whoever decided this server should
//     be able to write at all.
//
//     `--acknowledge-prod` gets the SAME treatment, and this paragraph used to
//     say it needed none because no command implemented it. One does now:
//     `packages/cli/src/commands/run.ts` accepts `--acknowledge-prod <reason>`
//     and plumbs it straight into `GuardConfig.acknowledgeProd`. It covers
//     exactly one refusal — an allowlisted RUNNER that a probe downgraded to
//     `prod-suspect` — which is precisely the refusal a model must not be able to
//     talk its way past, so `preflight_run` does not expose it in any spelling.
//     `@tessera/guard` refusing an `mcp`-surfaced override without
//     `humanConfirmed` is the second line here, not the first: a flag that never
//     reaches the argv cannot be argued about.
//
//     `tess preflight --mode apply` and `tess cleanup` accept
//     `--acknowledge-prod` too now, and neither `preflight_apply` nor
//     `preflight_cleanup_apply` exposes it (delegated decision 2026-09-23). The
//     question asked was whether an existing `prod` field pattern on this
//     surface could carry it; there is none — `--prod` is itself one of the §11
//     knobs above — so there is no precedent to extend, only the SEC-2 reason
//     not to start one.
//
//  6. **`preflight_apply` requires `mode: "apply"`, literally, and that is the
//     first of decision 3's two carve-outs.** §6b asks for
//     it in those words, and `preflight_cleanup_apply` repeats it (decision 12).
//     Decision 3's justification does not reach it: that rule protects a value
//     the CONFIG may legitimately supply, and the entire purpose of this one is
//     that the caller must spell the privileged act out in the call the operator
//     can read. The schema advertises a one-entry `enum`, and `validateArguments`
//     refuses anything else before a byte reaches the pipeline.
//
//     Its mirror image is `preflight_plan`, which PINS `--mode plan` on the argv
//     instead of exposing the knob. Plan mode is the CLI's default, but a default
//     is not a guarantee: `TESSERA_MODE=apply` in the host's environment would
//     otherwise turn a tool advertised `readOnlyHint: true` into a writer. A
//     read-only tool has to be read-only by construction.
//
//  7. **`preflight_apply` carries §6b's plan hash and idempotency key, as
//     OPTIONAL fields that map one-to-one onto CLI flags** (delegated decision
//     2026-09-23, TODO "plan-hash / idempotency key — MCP half"). This
//     paragraph used to record the gap as owed against `packages/cli`, closing
//     "when a flag exists THERE to carry them, and not before". Both flags now
//     exist — `--plan-hash` and `--idempotency-key` in `PREFLIGHT_CLI_OPTIONS`,
//     argv-only and refused outside `--mode apply` — so the two fields are
//     `planHash` and `idempotencyKey`, and the pins that asserted their absence
//     came out with this change. What the CLI does with them, read out of
//     `packages/cli/src/commands/preflight.ts` and `infraApply.ts` rather than
//     assumed:
//
//       * The plan is ALWAYS recomputed. `--plan-hash` is the digest the caller
//         reviewed (`plan.planHash` out of `preflight_plan`), and a recomputed
//         plan with a different digest is REFUSED (exit 4, "stale plan hash …
//         nothing was written") instead of being silently applied.
//       * Each planned write is journalled write-ahead in the ARCH-33
//         standing-infra ledger under `<idempotencyKey>#<index>`. A retry
//         under the SAME key and the SAME plan skips every step the ledger
//         already holds as applied; the same key under a DIFFERENT plan is
//         refused before the first write (exit 4). Without a key the CLI keys on
//         a fresh per-call run id, so an unkeyed retry is still a RE-EXECUTION,
//         not a replay.
//
//     Both stay optional, and that is why `idempotentHint` stays `false`: the
//     annotation describes the tool, and the tool called without a key is not
//     idempotent. Neither field is validated for shape here — a hash or key the
//     pipeline cannot use is the pipeline's refusal to word (decision 3), and
//     this layer keeps no memory of either between calls: the state deciding
//     whether a write happens lives in the ledger behind `main`, never in the
//     adapter (ARCH-1).
//
//  8. **`preflight_generate` is the first tool here that can send instance
//     content to a THIRD PARTY, and that is why `egress` is a separate axis
//     from `writeClass`.** Its write class says where its WRITE lands (the
//     repository, `<testsRoot>/proposed/`); neither that word nor `read-only`
//     nor `mutating` says anything about a copy of the instance's text leaving
//     the machine, which is the fact a caller could otherwise only discover by
//     invoking the tool and reading somebody's API logs. So the member added is
//     `third-party`, and it is a declaration of what a call MAY do rather than
//     of what today's configuration does: `--provider template` is the default
//     and is offline, and `--provider anthropic` POSTs the impact graph to the
//     Messages API. A host reading the spec cannot tell which one the operator
//     configured, and the honest declaration is therefore the worse case.
//
//     What actually goes over that wire was read out of `@tessera/generate`
//     rather than assumed: `graphDataBlocks` renders `table=… sys_id=… name=…`
//     per node, the edges with their `via`/`confidence`, the unanalyzable
//     artifacts with their reasons and the demanded specs, and
//     `createAnthropicProvider` sends that as the user message with the frozen
//     instruction as `system`. Script BODIES are not in it — but `name` is prose
//     somebody typed on the instance, which TM-1 classifies `Untrusted` and
//     §10 counts as content that left. "Only identities" is not "nothing".
//
//  9. **The generation BACKEND is not a tool argument either — decision 5's
//     argument, one threat over.** `--provider`, `--model`, `--base-url`,
//     `--api-key` and `--deadline-ms` all exist on `tess generate`, and none of
//     them is a property here. `--provider` is the switch that turns egress on
//     at all, and `--base-url` names the host the instance's text is POSTed to,
//     so a model that could set either could authorise its own egress or point
//     it at a collector of its choosing — the SEC-2 shape exactly, with
//     exfiltration where the write was. `--api-key` is env-only in the CLI's
//     own table (a flag would put the credential in `ps(1)` and in a shell
//     history), and a tool argument is worse than a flag: it is a credential a
//     model would have to hold in order to pass. `--deadline-ms` is left out for
//     the duller reason that it is a budget knob measured in somebody else's
//     money and this surface has no number type to spend it with. All five stay
//     where `--config` and `--allow` are: the host's business, supplied once at
//     launch.
//
// 10. **`preflight_run` is the SECOND mutating tool, and it is deliberately not
//     a second write PATH.** The question a reviewer should ask of any new
//     writer is whether it reaches an instance through machinery of its own, and
//     the answer here was read out of the CLI rather than assumed: `run.ts`
//     parses argv and calls `runSkeleton`, whose own comment says the order is
//     load-bearing — "classify the runner → mint the ledger → journal any
//     acknowledge-prod BEFORE the first write" — with `guard.classify` marked
//     "§11.1 step zero: classify BEFORE anything is constructed that could
//     write". Same `createTargetGuard`, same §4b `createIntentLedger`, same
//     ARCH-3 single channel the apply path uses, and this package adds nothing
//     to it: `dispatch.ts` builds an argv and `main` does the rest.
//
//     What that buys is the reason the surface is ONE property wide. `tess run`
//     parses eighteen flags; `--instance` is the only one exposed, because it is
//     the only one a caller cannot turn into a lie. The §11 knobs go by decision
//     5. `--fake`, `--mutant` and `--fake-production-property` go because they do
//     not configure the run, they FABRICATE it — a GO produced against
//     `@tessera/fake-instance` is indistinguishable, in the report, from a GO
//     produced against the runner. `--actor`, `--name`, `--run-id`,
//     `--ledger-root` and `--docs-dir` go because they name who ran and decide
//     where the write-ahead record lands, and the audited party does not get to
//     move the audit. `--run-timeout-ms` and `--poll-interval-ms` go for decision
//     9's reason plus a sharper one: a one-millisecond budget turns every run
//     into a non-verdict. `--skeleton` is PINNED, not exposed — the command
//     refuses to run without it, so as a property it would offer one legal value
//     and a usage error behind everything else.
//
//     One consequence has to be said out loud rather than discovered by calling:
//     TODAY EVERY CALL TO THIS TOOL REFUSES. `run.ts` is argv-only by design —
//     its own header explains that its flags are dev-harness switches and that
//     giving them env and config layers would let a stray `TESSERA_MUTANT=1`
//     turn a real run into a seeded-bug run — so unlike `preflight`/`apply`,
//     `--allow` has NO `TESSERA_ALLOW` layer behind it. Decision 5 forbids the
//     tool from sending `--allow`, and nothing else can supply it, so the §11.2
//     allowlist reaching the guard is always empty, every runner classifies
//     `unknown`, and §11.5's floor refuses the first write the run attempts.
//     (Refuses AT the write, not before the run: `runSkeleton` classifies at
//     step zero but asserts writability where the writing happens, so a refused
//     run may have read the instance first — unlike `preflight_apply`, whose
//     refusal costs no round trip.) That is the guard working, not a bug in this
//     record — but it means the tool cannot reach a GO until
//     `packages/cli/src/commands/run.ts` grows an
//     operator-side §11.2 source the way `options.ts` already has one. The debt
//     is recorded against that file, and NOT worked around here: an argv this
//     package assembled from its own environment would be exactly the second
//     authorisation path ARCH-1 and SEC-2 exist to prevent. The description says
//     so plainly, because a tool that always refuses and does not admit it reads
//     as a broken instance rather than as a configuration that was never made.
//
// 11. **A NO_GO out of `preflight_run` is a FINDING, and exit 1 alone cannot
//     prove it is one.** `reportsVerdict` is true here for `preflight_apply`'s
//     reason — a failing test is the answer this tool was called to get, not a
//     malfunction — so `results.ts` hands back the report, the
//     `structuredContent` and the NOT READY banner rather than an empty error.
//
//     The part that is OWED rather than solved sits in
//     `packages/cli/src/commands/run.ts`, and it is recorded here instead of
//     being worked around: that command's exit mapping is frozen at Phase 0.5's
//     two outcomes, GO → 0 and everything else → 1, explicitly so that a CI job
//     pinned to the old behaviour never starts seeing a 5. But `VerdictStatus`
//     has three members, so an INCONCLUSIVE run — QA-9's "could not be checked,
//     so no green may be claimed" — leaves the CLI as a 1, wearing a NO_GO's
//     number. Exit 3 and exit 4 stay distinguishable (a fault throws and `cli.ts`
//     classifies it; a `GuardViolation` becomes a refusal), and 1-versus-5 does
//     not.
//
//     This surface does not paper over that. Widening the mapping belongs to the
//     CLI, and inventing a 5 here from a 1 would mean this package deciding what
//     a verdict was — the one thing ARCH-1 forbids it. So the fact is DECLARED
//     instead: the tool's own description tells the caller to read
//     `verdict.status` in the returned document, which is where the difference
//     survives intact, and warns that the exit code does not carry it. The
//     document is evidence; the number is a summary of it, and a lossy one.
//
// 12. **§6b's three run-state rows arrive with the `preflight_` prefix, and
//     `cleanup` arrives as TWO tools** (delegated decision 2026-09-23, TODO
//     "run_status / confirm_ready / cleanup"). The names follow decision 1:
//     `run_status` → `preflight_run_status` (`tess status`), `confirm_ready` →
//     `preflight_confirm_ready` (`tess confirm`), and `cleanup` →
//     `preflight_cleanup_plan` + `preflight_cleanup_apply` (`tess cleanup`).
//     The split is decision 6's, for decision 6's reason: `tess cleanup`
//     defaults to `--mode plan` and deletes on `--mode apply`, and one tool
//     carrying both would have to be annotated for its worse half — a read a
//     host could not call without a destructive-write prompt. So the plan half
//     PINS `--mode plan` (read-only by construction, whatever the environment
//     says) and the apply half REQUIRES `mode: "apply"` spelled in the call. The
//     bare §6b names stay unserved, as `impact` does.
//
// 13. **`runId` is REQUIRED on all four run-state tools, and it is not decision
//     10's `--run-id`.** On `preflight_run` the flag would MINT the identity the
//     audit trail is filed under, and the audited party does not pick it. Here
//     it names a run that already exists — the key a status poll, a
//     confirmation or a teardown is ABOUT — and every one of the three commands
//     exits 2 without it. It is argv-only in `packages/cli/src/commands/
//     runState.ts` (no env, no config layer), so decision 3's "the config may
//     still supply it" is false of it, and advertising it as optional would
//     promise a call shape that can only ever be a usage error. The rest of the
//     run-state argv stays off the surface for decision 10's reason:
//     `--ledger-root` decides WHICH ledger is read or settled (the audited party
//     does not move the audit), `--actor` is a minted identity, and `--allow`,
//     `--prod` and `--acknowledge-prod` are decision 5's knobs. `--since` is
//     exposed, as a non-negative INTEGER — the first number on this surface, and
//     a cursor rather than a budget, so decision 9's objection to numbers does
//     not reach it.
//
// 14. **`preflight_confirm_ready` RELAYS a recorded exit code, and exits 3 and 4
//     mean something different there.** `tess confirm` never re-runs anything
//     (§6b): it reads the persisted `tess run --live` result and returns ITS
//     exit code, so a 1 is the recorded NO_GO (a verdict — `reportsVerdict` is
//     true) and a 3 or 4 may be the recorded fault or refusal of the CONFIRMED
//     run rather than a failure of the confirmation. The CLI tells the two
//     apart by stdout: a relayed code arrives WITH the confirm document (whose
//     `exitCode` equals the code), a confirm-side fault arrives with none.
//     `relaysRecordedExit` carries that to `results.ts`, which reads the
//     document before believing either reading. The confirm token is
//     `verdict.confirmToken.verdictHash` in that document; this layer neither
//     mints nor checks it.
//
// 15. **`preflight_cleanup_apply` is the THIRD mutating tool, it deletes, and
//     today it always refuses.** Decision 10's argument applies unchanged: the
//     command classifies the runner with the same §11 TargetGuard, asserts
//     runner writability and a `delete` write before building the store, and
//     `--allow` is argv-only on `tess cleanup` with no `TESSERA_ALLOW` layer
//     behind it. Decision 5 forbids sending it, so the allowlist reaching the
//     guard is empty, the runner classifies `unknown`, and every apply is
//     REFUSED (exit 4) before anything is deleted — the description says so.
//     Two further refusals come BEFORE the guard and hold on the plan tool too:
//     DEV-17 (the local run is not terminal, so it may have a live owner) and
//     §4a (the run is not ephemeral). Neither is a guard speaking about a write,
//     so both tools carry a `refusalReading` rather than inheriting the §11
//     wording `results.ts` would otherwise attach. `reportsVerdict` is false on
//     both halves: a cleanup reaches no verdict, and a 1 out of it is a defect.
//
// 16. **The three run-state READS declare a closed world** (delegated decision
//     2026-09-23). `openWorldHint` was `true` on every tool because every tool
//     reached an instance. `preflight_run_status`, `preflight_confirm_ready` and
//     `preflight_cleanup_plan` do not: they read the §4b ledger and the runner
//     profiles in this server's working directory and contact nothing else.
//     Keeping `true` on them would tell a host they reach outside the machine
//     when they cannot, so they carry `localOnly` and the annotation says
//     `false`. The record they read still MOVES — a live run appends to it — but
//     that is a changing answer, not an open world.
//
// 17. **`tess cleanup --confirm-unrecorded` is NOT exposed, in any spelling, on
//     either cleanup tool.** Delegated decision 2026-09-28 (wave 13): the flag
//     is a human confirmation that lifts a refusal, and lifting a refusal is
//     authorising a delete — SEC-2 lets an agent propose one, never authorise
//     it. What it guards, read out of `packages/cli/src/commands/runState.ts`
//     (F2d): an apply with NO local run record sweeps the `<runId>:` namespace
//     addressed by nothing but the id, and an operator-chosen id (`smoke`,
//     `login`) may name a customer's own ATF rows. Such a sweep runs only for
//     an id of the shape `tess run` mints, or when the operator retypes the id
//     in `--confirm-unrecorded <run-id>`; anything else is REFUSED (exit 4)
//     before any instance is contacted. Three reasons it stays off:
//
//       * The confirmation is the id RETYPED, not a boolean, precisely so that
//         it "cannot be pasted onto the wrong id". A boolean mapped here to
//         `--confirm-unrecorded <runId>` would echo the id the caller already
//         sent and assert nothing a second time — the retype would be forged by
//         this layer. A string field that must equal `runId` is the same echo
//         one step removed: a model copies a field as easily as it types one.
//       * The judgment it records — "this namespace is Tessera's" — is about
//         data this surface cannot see: rows another tool or person created.
//         That is the operator's knowledge, which is decision 5's shape
//         exactly (`--acknowledge-prod` is refused here for the same reason).
//       * No run this surface can start ever needs it. `preflight_run` exposes
//         neither `--run-id` nor `--ledger-root` (decision 10), so every run it
//         starts carries a minted id AND a local record under this server's
//         working directory — either one clears the gate. Only a run started
//         outside MCP with a chosen id, or recorded in another ledger, reaches
//         the refusal, and the human who chose that id holds the CLI.
//
//     So the apply tool's `refusalReading` names this refusal too, and the plan
//     tool's description tells the caller how to read `unrecordedSweep`. The
//     ATF store's per-row ownership check (F2a/b) sits behind the gate either
//     way; declining the flag here removes no protection, it only keeps the
//     one confirmation meant for a human out of an agent's reach. The pins are
//     in `test/tools.test.js` ("keeps --confirm-unrecorded off the surface").
//
// 18. **`tess cleanup --legacy` is exposed as DISCOVERY ONLY:
//     `preflight_cleanup_legacy_plan`, and no tool deletes a legacy row.**
//     Delegated decision 2026-09-30 (wave 14): legacy rows are ATF records a
//     pre-marker store wrote: named `<runId>:…` but carrying no ownership
//     marker, so the run-scoped cleanup refuses them (F2a/b) and always will.
//     `tess cleanup --legacy --mode apply` deletes them, but only the sys_ids
//     an operator lists in `--confirm`, checked against a report file
//     (`--report`) the operator saved from a plan and reviewed. Both flags are
//     the confirmation itself, which is decision 17's shape one step further:
//     a model that could send a sys_id list could select rows to delete, and a
//     model that could send a report could forge the list it is checked
//     against — SEC-2 lets an agent propose a delete, never authorise one. So
//     there is no `preflight_cleanup_legacy_apply`, no property spelled
//     `confirm`, `report`, `sysIds` or `legacy`, and the plan tool pins
//     `--legacy --mode plan` so it cannot be turned into the apply.
//
//     The inventory itself is worth serving: it issues GETs only (the CLI runs
//     no §11 guard for it, as for `doctor`), and an agent that has hit an
//     ownership refusal from preflight_cleanup_apply can show the operator
//     exactly which rows are in the way and why. It is NOT `localOnly` — it
//     reads the runner — so its `openWorldHint` stays `true`. Its one
//     argument besides `runner` is `runIds` (repeated `--run-id`, each held to
//     the ledger's `RUN_ID_PATTERN`), which only WIDENS what is read. Its exit
//     4 is not the guard: a read that did not reach its end within the page
//     cap refuses rather than returning a partial inventory
//     (`truncated-read`), so it carries a `refusalReading`. The pins are in
//     `test/tools.test.js` ("serves the legacy sweep as discovery only").
//
// Two flags the CLI has are deliberately NOT exposed:
//
//   * `--json` — the server always passes it. Structured output IS the tool's
//     contract; a caller who could turn it off would get a human report through a
//     machine channel.
//   * `--instance` (the ARCH-29 alias for `--source`) and `--config`. The alias
//     exists so a human at a shell can type the shorter word; two properties that
//     mean one thing is a way for a model to set them to different values. And
//     the config file is the HOST's business — chosen once, when the server is
//     launched, through the working directory and environment it is launched
//     with — not an argument a model gets to repoint mid-session.

import { RUN_ID_PATTERN } from "@tessera/ledger";

/**
 * `string` maps to one `--flag value`; `stringList` repeats the flag;
 * `integer` is a non-negative whole number, rendered in decimal as one `--flag
 * value` (decision 13 — today only `preflight_run_status`'s `since` cursor).
 */
export type ToolFieldType = "string" | "stringList" | "integer";

/**
 * What a tool does to the world it reaches, in §6b's vocabulary (decision 4).
 * `repo-write` writes FILES, in the working directory the server was launched
 * in, and reaches no instance with anything but a read.
 */
export type ToolWriteClass = "read-only" | "mutating" | "repo-write";

/**
 * Where that doing LANDS — decision 4's second axis. `none` is the honest value
 * for a tool that only reads: it opens connections to an instance, but nothing
 * it did survives the call. `instance` means the runner and nothing else
 * (ARCH-8). `third-party` means a copy of instance-derived text is sent to
 * somebody who is neither the instance nor this machine, and it is a statement
 * about what a call MAY do under the operator's configuration rather than about
 * what it did — decision 8 argues both halves.
 */
export type ToolEgress = "none" | "instance" | "third-party";

export interface ToolField {
  /** The JSON Schema property name — the CLI option key, unchanged. */
  readonly name: string;
  /** The flag it becomes on the argv handed to the composition root. */
  readonly flag: string;
  readonly type: ToolFieldType;
  readonly description: string;
  /**
   * The one value this property accepts — advertised as a single-entry `enum`
   * and enforced before anything runs. Decision 6 (and its repeat on
   * `preflight_cleanup_apply`, decision 12) is the only use of it.
   */
  readonly only?: string;
  /**
   * A pattern a string value (or every entry of a `stringList`) must match —
   * advertised as the schema's `pattern` (its `source`) and enforced before
   * anything runs. Taken from the package
   * that owns the rule, never transcribed: `runId` carries the ledger's
   * `RUN_ID_PATTERN`.
   */
  readonly pattern?: RegExp;
  /**
   * Rare, and argued in decisions 6 and 13: presence is normally the
   * pipeline's call.
   */
  readonly required?: true;
}

export interface ToolSpec {
  readonly name: string;
  readonly title: string;
  /** The `tess` subcommand this tool delegates to — see `dispatch.ts`. */
  readonly command: string;
  readonly description: string;
  readonly fields: readonly ToolField[];
  /** Declared, never inferred from the fields (decision 4). */
  readonly writeClass: ToolWriteClass;
  /**
   * Declared BESIDE `writeClass`, not derived from it. The two agree on every
   * row today, and they stop agreeing the moment a tool writes somewhere that is
   * not an instance — which is the case the axis exists to make sayable rather
   * than inferable (decision 4).
   */
  readonly egress: ToolEgress;
  /**
   * True when exit 1 out of this command is a VERDICT about the target rather
   * than a defect in the pipeline. `results.ts` reads it and nothing else does;
   * its header argues what the distinction buys.
   */
  readonly reportsVerdict: boolean;
  /**
   * argv the server always appends and no caller can set, unset or override.
   * `--json` is pinned for every tool inside `toArgv`; this carries the rest —
   * today, `preflight_plan`'s and `preflight_cleanup_plan`'s `--mode plan`
   * (decisions 6 and 12), `preflight_run`'s `--skeleton` (decision 10) and
   * `preflight_cleanup_legacy_plan`'s `--legacy --mode plan` (decision 18). Each
   * is a flag with exactly one acceptable value on its tool, which is what
   * makes pinning it honest rather than restrictive.
   */
  readonly pinned?: readonly string[];
  /**
   * True when the command RELAYS an exit code it read from a persisted record
   * rather than one it reached itself (decision 14). `results.ts` then accepts
   * a document on exit 3 or 4 when its `exitCode` matches, instead of reading
   * the code as a failure of this call.
   */
  readonly relaysRecordedExit?: true;
  /**
   * True when the tool contacts no instance at all and reads only this
   * server's working directory (decision 16); its `openWorldHint` is then
   * `false`.
   */
  readonly localOnly?: true;
  /**
   * What exit 4 means for THIS tool, when it is not the §11 guard reading
   * `results.ts` would otherwise attach (decision 15). Rendered as the
   * paragraph under the REFUSED headline; the pipeline's own words follow it.
   */
  readonly refusalReading?: string;
  /**
   * For a mutating tool: what establishes the state after an exit 3, in place
   * of the default remedy paragraph. Written per tool because what can be read
   * back — and whether a second call is a replay — differs per command.
   */
  readonly faultRemedy?: string;
}

const SOURCE_FIELD: ToolField = {
  name: "source",
  flag: "--source",
  type: "string",
  description:
    "Credential profile for the §2a SOURCE role — artifacts, stories and scripts are READ from this instance and nothing is ever written to it (ARCH-19). May instead come from tessera.config.json or TESSERA_SOURCE.",
};

const STORY_FIELD: ToolField = {
  name: "story",
  flag: "--story",
  type: "string",
  description:
    "Optional resolver input — a story number or sys_id (ARCH-5). Without it the analysis starts from everything the scope enumerates.",
};

const SCOPE_FIELD: ToolField = {
  name: "scope",
  flag: "--scope",
  type: "string",
  description:
    "The single application scope the analysis is confined to, by name or sys_id (DESIGN §12.3). Required by the command, though it may instead come from tessera.config.json or TESSERA_SCOPE.",
};

/**
 * Scope again, one sentence different, and the difference is the point: `tess
 * resolve` accepts a story OR a scope, so a description promising the command
 * needs this would send a caller looking for a value they do not have. Copied
 * rather than shared for the same reason `options.ts` copies a table whose
 * `describe` shifted.
 */
const RESOLVE_SCOPE_FIELD: ToolField = {
  name: "scope",
  flag: "--scope",
  type: "string",
  description:
    "Optional resolver input — an application scope by name or sys_id (ARCH-5). At least one of `story` or `scope` must reach the composite, though either may instead come from tessera.config.json or the environment.",
};

const ARTIFACT_TABLES_FIELD: ToolField = {
  name: "artifactTables",
  flag: "--artifact-table",
  type: "stringList",
  description:
    "Tables the scope adapter enumerates. Omit for the default set; naming tables here REPLACES it, so a short list narrows what can be found.",
};

const UPDATE_SET_STORY_FIELD: ToolField = {
  name: "updateSetStoryField",
  flag: "--update-set-story-field",
  type: "string",
  description:
    "The sys_update_set column that links back to rm_story. Plugin- and version-dependent, and never verified against a live instance: a wrong name here reads back exactly like a story that changed nothing (OPP-1b).",
};

const TESTS_ROOT_FIELD: ToolField = {
  name: "testsRoot",
  flag: "--tests-root",
  type: "string",
  description:
    "The tests-as-code root whose .manifest.json registry is read (DESIGN §4 layout). Relative paths resolve against the directory the server was launched in.",
};

// ── the preflight fields ────────────────────────────────────────────────────
//
// A different set from the analysis fields above, and not by omission: `tess
// preflight` reads `runner`, `source`, `target`, `kinds`, `artifacts` and
// `mode`, and nothing else. Advertising `scope` or `story` here would put two
// knobs on a tool that ignores both — "an advertised flag that changes nothing
// is worse than a missing one; it reads as a knob and behaves as a comment"
// (`options.ts`, twice).

const RUNNER_FIELD: ToolField = {
  name: "runner",
  flag: "--runner",
  type: "string",
  description:
    "Credential profile for the §2a RUNNER role — the instance whose readiness is diagnosed, and the ONLY instance a pipeline write may ever touch (ARCH-8). Required by the command, though it may instead come from tessera.config.json or TESSERA_RUNNER.",
};

const PREFLIGHT_SOURCE_FIELD: ToolField = {
  name: "source",
  flag: "--source",
  type: "string",
  description:
    "Credential profile for the §2a SOURCE role — the ARCH-20 parity check READS the tested version of each artifact from here (ARCH-19). Omitted, the topology collapses onto the runner and parity reports `not-applicable` rather than passing.",
};

const TARGET_FIELD: ToolField = {
  name: "target",
  flag: "--target",
  type: "string",
  description:
    "Credential profile for the §2a TARGET role — the eventual promotion destination, probed read-only and never written to (ARCH-8). Purely descriptive here: naming it changes what the report says about the topology, not what is checked.",
};

const KINDS_FIELD: ToolField = {
  name: "kinds",
  flag: "--kind",
  type: "stringList",
  description:
    "Test kinds whose preconditions must hold — unit, e2e or ui. THERE IS NO DEFAULT SET, and omitting this does not mean “check every kind”: the list is empty, only the preconditions that apply to every kind stay `required`, and every kind-gated one is reported `deferred` — left out of the `status` roll-up, left out of any provision plan built from the same findings, and unable to raise the hard failure below. Naming the kinds you intend to run is what turns that gating on. Once a kind is named, a precondition gating it that does not come back `ready` is a HARD FAILURE rather than a warning, and undecided counts: a kind whose runner nobody could confirm is a run that would hang and report nothing (DEV-2).",
};

const ARTIFACTS_FIELD: ToolField = {
  name: "artifacts",
  flag: "--artifact",
  type: "stringList",
  description:
    "An artifact to parity-check, spelled `table/sys_id` with an optional `:label` (ARCH-20). Without at least one, parity has nothing to compare and reports `not-applicable` — it never passes by default.",
};

/**
 * The confirmation, not a knob (decision 6). It is the first field of the apply
 * tool so that the argv reads `preflight --json --mode apply …` — the flag that
 * makes this a write is the one a reader of the audit trail sees first.
 */
const APPLY_MODE_FIELD: ToolField = {
  name: "mode",
  flag: "--mode",
  type: "string",
  only: "apply",
  required: true,
  description:
    'Must be the literal string "apply". This tool WRITES to the runner, and §6b requires the caller to say so in the call rather than inherit it from a default. To see what would be written without writing it, call preflight_plan instead.',
};

/**
 * The §6b stale-plan check (decision 7). Optional: a caller that reviewed no
 * plan has no hash to send, and inventing one would only buy a refusal.
 */
const PLAN_HASH_FIELD: ToolField = {
  name: "planHash",
  flag: "--plan-hash",
  type: "string",
  description:
    "The plan you reviewed: `plan.planHash.value` from a preflight_plan call made with the SAME inputs (present only when `plan.planHash.state` is `computed`). The plan is ALWAYS recomputed; if its digest differs from this one the call is REFUSED (§6b, exit 4) and NOTHING IS WRITTEN — the instance moved since you looked, so plan again and review what changed. Omitted, the recomputed plan is applied without that comparison.",
};

/**
 * ARCH-33 deduplication (decision 7). Optional, because the CLI mints a per-call
 * key when none is given — which is exactly why a retry without one is a
 * re-execution.
 */
const IDEMPOTENCY_KEY_FIELD: ToolField = {
  name: "idempotencyKey",
  flag: "--idempotency-key",
  type: "string",
  description:
    "A key you choose for THIS apply, recorded against every step in the local ARCH-33 ledger. A second call with the SAME key and the same plan skips the steps already confirmed under it instead of performing them again; the same key under a DIFFERENT plan is REFUSED (exit 4) before the first write. Omitted, the command keys the call by a fresh run id, so nothing links it to an earlier call and a retry is a re-execution. Choose one before the first call if you may need to retry.",
};

// ── the doctor fields ───────────────────────────────────────────────────────
//
// `tess doctor` reads `--instance`, `--target` and `--kind`, and nothing else.
// `KINDS_FIELD` above is REUSED rather than copied, unlike `RESOLVE_SCOPE_FIELD`
// — but not for the reason this comment used to give. "The doctor IS the gate's
// first stage run on its own, over the same kinds" is true and is only half of
// it: on plan and apply the SAME list also reaches the provisioner, which
// re-diagnoses with it and plans a step only for a `required` finding
// (`packages/provisioner/src/provisioner.ts`), so omitting it shrinks the plan
// as well as the diagnosis. A sentence written about the doctor's report would
// understate that, and one written about `plan.steps` would name a field the
// doctor's document does not have.
//
// So the shared sentence is written about the one mechanism all three tools
// really share: what the kinds list does to a finding's APPLICABILITY. That is
// true unchanged on every tool that takes this field, and it is what makes one
// field defensible where three copies would drift — silently, and in the
// dangerous direction, because the drift a copy hides is the gate being off.

/**
 * Property `runner`, flag `--instance`, and the mismatch is deliberate on both
 * sides. `options.ts` binds the doctor's `--instance` to key `runner` (it is NOT
 * the ARCH-29 alias — the doctor takes two instances, so "all three roles are
 * this one" would be a contradiction), and the property keeps the CLI's key so
 * that the profile a host names here is spelled the way it is on every other
 * tool. The flag the alias objection covers is not exposed: there is exactly one
 * property per instance, which is what stops a caller setting two names for one.
 */
const DOCTOR_INSTANCE_FIELD: ToolField = {
  name: "runner",
  flag: "--instance",
  type: "string",
  description:
    "Credential profile for the instance to diagnose, bound to the §2a RUNNER role. Read-only whatever the role: this command constructs no writer, no ledger and no guard. Required by the command, though it may instead come from tessera.config.json or TESSERA_INSTANCE.",
};

const DOCTOR_TARGET_FIELD: ToolField = {
  name: "target",
  flag: "--target",
  type: "string",
  description:
    "Optional second instance to diagnose, also read-only. Because nothing here can write, there is no single-writer rule to protect and any role may be probed, the promotion target included (ARCH-8). May instead come from tessera.config.json or TESSERA_TARGET.",
};

const RESOLVE_FIELDS: readonly ToolField[] = [
  SOURCE_FIELD,
  STORY_FIELD,
  RESOLVE_SCOPE_FIELD,
  ARTIFACT_TABLES_FIELD,
  UPDATE_SET_STORY_FIELD,
];

const IMPACT_FIELDS: readonly ToolField[] = [
  SOURCE_FIELD,
  STORY_FIELD,
  SCOPE_FIELD,
  ARTIFACT_TABLES_FIELD,
  UPDATE_SET_STORY_FIELD,
];

/**
 * Spread, mirroring `COVERAGE_OPTIONS` in the CLI and for its reason: coverage
 * differs from impact by ADDITION only. Keeping the relationship structural is
 * what stops `testsRoot` from drifting away from the analysis knobs it is joined
 * against. The same cost applies — `testsRoot` lands last in the schema rather
 * than beside `scope` — and it is the cheaper of the two defects here too.
 */
const COVERAGE_FIELDS: readonly ToolField[] = [
  ...IMPACT_FIELDS,
  TESTS_ROOT_FIELD,
];

/**
 * Singular where the doctor's `kinds` is a list, and a `string` rather than a
 * `stringList` for the CLI's own reason: `TestGenerator.generate(ctx, graph,
 * kind)` takes ONE kind, so a list would have to be silently truncated or
 * silently looped, and both are a knob that does not mean what it says.
 */
const GENERATE_KIND_FIELD: ToolField = {
  name: "kind",
  flag: "--kind",
  type: "string",
  description:
    "The single test kind to propose specs for — unit, e2e or ui. Omit for the command's default (unit); it may instead come from tessera.config.json or TESSERA_KIND.",
};

/**
 * Coverage's fields plus the one generation knob, spread for the reason every
 * spread here is a spread: `tess generate` runs the IDENTICAL analysis and then
 * hands the graph to a generator instead of to a join, so no field changes
 * meaning. `testsRoot` does MORE work here than it does on coverage — there it
 * is only read, here it is also the root the `proposed/` tree is written under
 * (DEV-4) — which is a widening of one field's consequences, not a change to
 * what it names.
 *
 * The rest of `tess generate`'s surface — `--provider`, `--model`,
 * `--base-url`, `--api-key`, `--deadline-ms` — is absent by decision 9.
 */
const GENERATE_FIELDS: readonly ToolField[] = [
  ...COVERAGE_FIELDS,
  GENERATE_KIND_FIELD,
];

const DOCTOR_FIELDS: readonly ToolField[] = [
  DOCTOR_INSTANCE_FIELD,
  DOCTOR_TARGET_FIELD,
  KINDS_FIELD,
];

const PLAN_FIELDS: readonly ToolField[] = [
  RUNNER_FIELD,
  PREFLIGHT_SOURCE_FIELD,
  TARGET_FIELD,
  KINDS_FIELD,
  ARTIFACTS_FIELD,
];

/**
 * Spread as well, and the addition is the confirmation itself: apply is plan
 * plus permission, so every input that shaped the plan must still shape the
 * thing being applied. A field list that diverged would mean the two tools could
 * answer about different runs. The two §6b/ARCH-33 fields come after them
 * (decision 7): they name WHICH plan and WHICH attempt, not what is planned.
 */
const APPLY_FIELDS: readonly ToolField[] = [
  APPLY_MODE_FIELD,
  ...PLAN_FIELDS,
  PLAN_HASH_FIELD,
  IDEMPOTENCY_KEY_FIELD,
];

export const RESOLVE_TOOL: ToolSpec = {
  name: "preflight_resolve",
  title: "Change-set resolution (read-only)",
  command: "resolve",
  description: [
    "Answers WHICH ARTIFACTS a change consists of, before anything is analysed or gated: runs the ARCH-5 composite resolver over a story and/or an application scope and returns the artifact list, each row labelled with the adapter that claimed it, plus a note per source that could not answer in full.",
    "",
    "It reads a live instance and only ever reads; there is no writer, no ledger and no guard in reach of this command, so pointing it at production is safe by construction rather than by promise (ARCH-19).",
    "",
    "It reaches NO VERDICT. Resolution answers `which artifacts` — it never says whether anything is ready. A 1 out of this tool would be a defect.",
    "",
    "An empty list that every source agreed on is a real answer; a list that came back INCOMPLETE is not an answer at all, and says so (`incomplete: true`, exit 5, QA-9). A source that never replied is reported as an error, never as an empty list (DEV-1).",
  ].join("\n"),
  fields: RESOLVE_FIELDS,
  writeClass: "read-only",
  egress: "none",
  reportsVerdict: false,
};

export const IMPACT_TOOL: ToolSpec = {
  name: "preflight_impact",
  title: "Impact analysis (read-only)",
  command: "impact",
  description: [
    "Answers what a change REACHES inside one ServiceNow application scope: resolves the story and/or scope to a set of artifacts, runs a where-used search confined to that scope, and returns the impact graph — nodes, edges, the artifacts nobody could trace, and a note per stage that could not answer in full.",
    "",
    "It reads a live instance and only ever reads; it writes nothing and creates nothing.",
    "",
    "It reaches NO VERDICT. An impact graph answers a question — it does not say whether anything is ready to deploy.",
    "",
    "Absence of evidence is reported as an error, never as an empty graph: if the instance could not be read, this call fails rather than returning zero nodes (DEV-1). The machine-readable report is in `structuredContent` and, verbatim, in the first text block.",
  ].join("\n"),
  fields: IMPACT_FIELDS,
  writeClass: "read-only",
  egress: "none",
  reportsVerdict: false,
};

export const COVERAGE_TOOL: ToolSpec = {
  name: "preflight_coverage",
  title: "Declared test intent (read-only)",
  command: "coverage",
  description: [
    "Answers, of everything a change reaches, what the repository CLAIMS to test: the impact graph of preflight_impact joined against the tests-as-code registry (.manifest.json) under the tests root. Returns one row per impacted artifact with the specs declaring it, plus the gap set — the artifacts no spec names.",
    "",
    "The join is DECLARED: a spec counts for an artifact because it names it in `targets` (table + sys_id), never because of where its file sits (QA-16).",
    "",
    "What comes back is INTENT, not coverage. A spec that exists is not a spec that passed; confirmed coverage is computed AFTER a run, and this call performs none (QA-8). For the same reason a gap is never a failure here — it is a hole in somebody's plan, and the call succeeds while reporting it.",
    "",
    "The denominator includes the artifacts nobody could trace, so the ratio cannot improve by the analysis getting worse (QA-15). An unreadable registry is an error, never an empty one (OPP-1b).",
  ].join("\n"),
  fields: COVERAGE_FIELDS,
  writeClass: "read-only",
  egress: "none",
  reportsVerdict: false,
};

/**
 * The one tool whose two axes disagree, which is what decision 4 built them for:
 * it writes the REPOSITORY and may transmit to a THIRD PARTY, and neither fact
 * implies the other.
 *
 * DEV-4 — "generated specs land as proposed, git-reviewed, not auto-run" — is
 * inherited whole and cannot be broken from here: `writer.ts` never opens the
 * live `.manifest.json`, `@tessera/specs` joins on that manifest and not on file
 * paths (QA-16), and this package has no promote path, no run path and no state
 * between calls. What one tool call CANNOT do is stop a host from feeding these
 * paths into a tool that runs them, so the result is shaped to say a human step
 * is owed — the sentence is in this description, in the handshake, and in the
 * banner `results.ts` attaches to every repo-write result. Declaration is the
 * only instrument this layer is allowed; a lock or a session flag would be the
 * second decision path ARCH-1 forbids it.
 */
export const GENERATE_TOOL: ToolSpec = {
  name: "preflight_generate",
  title: "Test-spec generation (WRITES the repo, MAY transmit off-box)",
  command: "generate",
  description: [
    "THIS TOOL WRITES FILES AND MAY SEND INSTANCE CONTENT TO A THIRD PARTY. It works the list preflight_coverage reports: the same resolution and the same single-scope impact analysis, and then the graph goes to a test generator instead of to a join. What comes back is written under `<testsRoot>/proposed/` and indexed in a sibling `.manifest.proposed.json`. No instance is written to — the source is read and nothing else is touched (ARCH-19).",
    "",
    "EGRESS, DECLARED SO THAT NOBODY HAS TO DISCOVER IT BY CALLING: with the operator's default backend (`template`) generation is offline, deterministic and reaches no third party. If the operator configured the AI backend instead, every call POSTs the impact graph to that vendor's API — table names, sys_ids, the artifact NAMES somebody typed on the instance, the edges between them and the reasons artifacts could not be analysed. Script bodies are not sent, but a name is instance prose and it leaves the machine. Which backend, which model, which base URL and which key are the operator's configuration, and none of them is an argument of this tool: a caller cannot switch egress on, redirect it, or spend a budget that is not theirs by asking (SEC-2).",
    "",
    "WHAT IT PRODUCES IS A PROPOSAL, NOT A TEST, AND A HUMAN STEP IS OWED. `proposed/` is inert by construction: the live `.manifest.json` is never opened for writing, and a spec no live manifest names is a file rather than a test (QA-16). Nothing here has been run, nothing counts as coverage and nothing retires a passing test. Promotion is a person reading the diff in git and moving entries into the live manifest — no tool on this surface does it. Handing these paths to a tool that executes specs deletes that review; it does not automate it (DEV-4).",
    "",
    "It reaches NO VERDICT and never returns 1: an unrun spec is no evidence with which to fail a build (QA-8). A wrong request comes back verbatim from the pipeline (exit 2). A fault — the instance never answered, the model never answered, the answer was truncated, or the generated code was refused by the TM-3 gate or the quality bar — means NO SPEC WAS WRITTEN and is never an empty batch reported as success (exit 3, DEV-1). INCOMPLETE (exit 5) means the specs on disk are real but the claim that they are the WHOLE work list is not (QA-9).",
  ].join("\n"),
  fields: GENERATE_FIELDS,
  writeClass: "repo-write",
  egress: "third-party",
  reportsVerdict: false,
};

export const DOCTOR_TOOL: ToolSpec = {
  name: "preflight_doctor",
  title: "Environment doctor (read-only)",
  command: "doctor",
  description: [
    "Answers whether an instance CAN RUN TESTS AT ALL, with no change in sight: runs the §12.3 EnvironmentDoctor over one or two instances and returns a finding per precondition for the requested test kinds — what holds, what does not, and what nobody could decide.",
    "",
    "It is the one command that constructs no writer, no ledger and no guard, because it performs no write of any kind. That is what earns it the right to point at ANY role in the topology, the promotion target included (ARCH-8), rather than at the runner alone.",
    "",
    "It DOES reach a verdict, and the verdict is about the ENVIRONMENT rather than about a change. READY (exit 0) means every precondition for the requested kinds held. NOT READY (exit 1) is a real answer about the instance — the report names the finding that failed — and is returned as an error result so that a caller who reads only the success flag cannot mistake it for a pass. It says NOTHING about whether any code is ready to deploy; preflight_plan is the tool that answers that, and it runs this diagnosis as its first stage.",
    "",
    "UNKNOWN USUALLY gets its own outcome (exit 5) rather than being folded into NOT READY: a precondition nobody could decide is a different operational problem from one that decided no, and it is never rounded up to ready (QA-9).",
    "",
    "ONE EXIT-CODE EXCEPTION, AND IT IS DELIBERATE: a precondition that GATES a requested kind and does not come back ready is a HARD FAILURE, and a hard failure is exit 1 even when the finding behind it is undecided rather than failed (DEV-2 — asking for `ui` without a Test Runner is a run that would hang and report nothing, so the caller must refuse rather than choose). On that path the document and the number disagree on purpose: `status` can read `unknown` while the exit code says NOT READY, and `hardFailure` is the field that names why. READ `status` AND `hardFailure` in the returned document rather than inferring either from the exit code — an exit 1 out of this tool does not by itself mean a precondition decided no.",
  ].join("\n"),
  fields: DOCTOR_FIELDS,
  writeClass: "read-only",
  egress: "none",
  reportsVerdict: true,
};

export const PLAN_TOOL: ToolSpec = {
  name: "preflight_plan",
  title: "Preflight gate, plan only (read-only)",
  command: "preflight",
  description: [
    "Answers whether a runner is FIT TO RUN THE TESTS, and what it would take to make it so: diagnoses every precondition for the requested test kinds, checks ARCH-20 parity between the code on the source and the code on the runner, and returns an inspectable provision plan (ARCH-2/ARCH-13) — the steps that would be performed, and the blockers no write can clear.",
    "",
    "NOTHING IS WRITTEN. `--mode plan` is pinned onto the delegated command, so this tool cannot apply the plan even if the host's configuration says otherwise; preflight_apply is the only tool that performs it.",
    "",
    "It DOES reach a verdict, and the verdict is fail-closed. READY (exit 0) means every precondition held and parity did not disagree. NOT READY (exit 1) is a real answer about the runner — the report names the checks behind it and what the plan would do — and is returned as an error result so that a caller who reads only the success flag cannot mistake it for a pass. INCONCLUSIVE (exit 5) means something could not be decided, which is never rounded up to ready (QA-9).",
    "",
    "EXIT 1 CAN CARRY AN UNDECIDED CHECK, and that is deliberate: a precondition that GATES a requested kind and does not come back ready is a HARD FAILURE, and a hard failure is exit 1 even when the finding behind it is undecided rather than failed (DEV-2 — the same rule preflight_doctor states, because this gate runs that diagnosis as its first stage). READ the diagnosis `status` and `hardFailure` in the returned document rather than inferring either from the exit code — an exit 1 out of this tool does not by itself mean a check decided no.",
    "",
    "Parity is `not-applicable` unless artifacts are named and a separate source is given: that is stated in the report rather than shown as a pass, because an unearned green is the failure this gate exists to prevent.",
  ].join("\n"),
  fields: PLAN_FIELDS,
  writeClass: "read-only",
  egress: "none",
  reportsVerdict: true,
  // See decision 6: the CLI's default is already `plan`, and a default is not a
  // guarantee while `TESSERA_MODE` exists.
  pinned: ["--mode", "plan"],
};

export const APPLY_TOOL: ToolSpec = {
  name: "preflight_apply",
  title: "Preflight gate, apply mode (WRITES to the runner)",
  command: "preflight",
  description: [
    "THIS TOOL WRITES. It runs the same gate as preflight_plan and then PERFORMS the provision plan against the runner instance — creating and updating records so the runner can execute the requested test kinds. Call preflight_plan first and read the `plan.steps` it returns: those are the writes this call will make.",
    "",
    "The only INSTANCE it writes to is the RUNNER: the source is read-only (ARCH-19) and the target is only ever probed (ARCH-8). IT ALSO WRITES TO THE LOCAL DISK, but only once a write actually lands — the transport appends every applied mutation to the DEV-15 write journal at `<docs-dir>/<profile>/write-journal.{jsonl,md}`. `tess preflight` stages `<docs-dir>` itself: the directory holding the nearest `tessera.config.json` found upwards, or `.tessera/sn-docs` when there is none, in both cases relative to the working directory of the process running THIS SERVER — which under MCP is whichever host launched it and not a directory the caller chose. There is no undo for that file. A refused call leaves none of it behind, because only a request the instance accepted is journalled.",
    "",
    'It requires `mode` to be the literal string "apply". Nothing else is accepted, and no default supplies it.',
    "",
    "A §11 TargetGuard decides whether the runner may be written to AT ALL, before the writer is constructed. An instance that is not on the operator's non-prod allowlist classifies `unknown` and is REFUSED; an instance that looks like production is refused whatever the allowlist says. A refusal comes back as an error whose first line says REFUSED, and it means NOTHING WAS WRITTEN — it is not a failure to retry and not a verdict about the change. The allowlist is configured by the operator who runs this server; it is not an argument of this tool, and there is no way to ask for it from here.",
    "",
    "AS THE GUARD STANDS, EXPECT REFUSED FROM ANY CALL THAT WOULD WRITE. The provision plan has exactly one step and it exists only while `sn_atf.runner.enabled` does not read `true` — and that same reading is a §11.2 downgrade signal, which classifies even an allowlisted runner `prod-suspect`. §11.4 refuses a prod-suspect write unless an acknowledgement covers the run, and this tool sends none: `tess preflight` and `tess run` both take an `--acknowledge-prod` flag on the command line, but it is deliberately not a field here (decision 5) — lifting a prod-suspect refusal is the operator's act, not an agent's. So the state in which this tool has work to do is the state in which it is refused, and the state in which it is permitted is the state in which `plan.steps` is empty. Report the refusal to the operator; do not look for a call shape that gets past it, because there is none.",
    "",
    "The verdict is measured AFTER the writes: READY (exit 0) means the runner is ready now. NOT READY (exit 1) means it still is not, and the report says why. INCONCLUSIVE (exit 5) means something could not be decided (QA-9).",
    "",
    "TWO OPTIONAL FIELDS BIND A CALL TO WHAT WAS REVIEWED. `planHash` is the digest preflight_plan returned: the plan is always recomputed, and if it no longer matches, the call is REFUSED (§6b) and nothing is written. `idempotencyKey` is recorded against every step in the local ARCH-33 ledger under `.tessera/` in this server's working directory, the ledger an apply writes before it touches the instance: a second call with the same key and the same plan skips the steps already confirmed, and the same key under a different plan is refused before the first write.",
    "",
    "RETRIES ARE NOT SAFE WITHOUT THE SAME idempotencyKey — read this before calling twice. Without one the command keys each call by a fresh run id, so a byte-identical second call is a RE-EXECUTION, not a replay: the plan is recomputed against the instance as it is at that moment, and the writes are performed AGAIN. Nothing links the second call to the first. If a call made without a key times out or its result is lost, you do NOT know whether it wrote: call preflight_plan and read what is on the instance now, report that, and let the operator decide whether to apply again — do not retry this tool to find out. Only a call that sent an idempotencyKey may be repeated with that same key, and even then report the first outcome as unknown rather than as a success.",
  ].join("\n"),
  fields: APPLY_FIELDS,
  writeClass: "mutating",
  egress: "instance",
  reportsVerdict: true,
  faultRemedy:
    "So “fix the cause and call again” is NOT the remedy here. Establish the state with a read first — call preflight_plan and read what is on the instance now — then report that and let the operator decide whether to call this tool again. Do not retry it to find out: without the same idempotencyKey a second call is a re-execution and not a replay, and with it the call resumes only steps the ledger recorded as confirmed.",
};

// ── the run field ───────────────────────────────────────────────────────────
//
// One property, and the short list below is the whole argument for why. `tess
// run` parses eighteen flags; seventeen of them fall into four groups that this
// surface must not hand to a model, and decision 10 argues them:
//
//   * the §11 knobs — `--allow`, `--prod`, `--acknowledge-prod` (decision 5);
//   * the dev-harness switches — `--fake`, `--mutant`,
//     `--fake-production-property`, `--keep` — which do not merely configure the
//     run, they FABRICATE it;
//   * the audit-trail identities — `--actor`, `--name`, `--run-id`,
//     `--ledger-root`, `--docs-dir` — which name who ran and where the §4b
//     ledger lands;
//   * the timing budgets — `--run-timeout-ms`, `--poll-interval-ms` — left out
//     for decision 9's duller reason, plus a sharper one: a one-millisecond
//     timeout turns any run into a non-verdict.
//
// `--skeleton` is the eighteenth and it is PINNED, not exposed — see decision 10.

/**
 * Property `runner`, flag `--instance` — the doctor's mismatch (see
 * `DOCTOR_INSTANCE_FIELD`) for the doctor's reason: the property keeps the name
 * every other tool spells an instance with, and the flag is what `tess run`
 * actually parses. Unlike everywhere else on this surface the VALUE is a host
 * rather than a credential profile, which is why the sentence below says host.
 */
const RUN_INSTANCE_FIELD: ToolField = {
  name: "runner",
  flag: "--instance",
  type: "string",
  description:
    "Host of the §2a RUNNER instance the tests execute on — the ONLY instance this run may write to (ARCH-8). A host, not a credential profile, and this is the one knob on this tool: naming an instance cannot make it writable, because §11.2 writability comes from the allowlist the command was started with and from nothing a caller can send. May instead come from SN_INSTANCE.",
};

const RUN_FIELDS: readonly ToolField[] = [RUN_INSTANCE_FIELD];

export const RUN_TOOL: ToolSpec = {
  name: "preflight_run",
  title: "Walking-skeleton test run (WRITES to the runner)",
  command: "run",
  description: [
    "THIS TOOL WRITES. It executes the PLAN Phase-0.5 walking-skeleton test run against the runner instance and returns the verdict it reached, with the run report attached.",
    "",
    "The only INSTANCE it writes to is the RUNNER (ARCH-8), through the same single mutation channel `preflight_apply` uses (ARCH-3). It opens no second path: this server holds no client, no guard and no writer of its own — the call becomes a `tess run` argv and the pipeline does the rest.",
    "",
    "IT MAY WRITE TO THE LOCAL DISK, in TWO places, and that is worth knowing before calling. The first is the §4b ledger root. `tess run` creates it before it contacts any instance, and this tool may not send `--ledger-root`, so the directory is `.tessera/` under the working directory of the process running THIS SERVER — which under MCP is whichever host launched the server, not a directory the caller chose. It is created on every call that gets past argument parsing, the refusal path below included, but it is REMOVED AGAIN at the end of the call if and only if this run created it and nothing was written into it. So a refused run leaves nothing behind. What survives is a run that actually opened its §4b write-ahead ledger: those records outlive the process deliberately, because crash recovery has nothing to recover from otherwise. A `.tessera/` that was already there when the call started is never removed, empty or not.",
    "",
    "The second is the DEV-15 write journal, and only a run that reaches an APPLIED MUTATION creates it. `tess run` stages it into an `sn-docs/` directory anchored on the discovered `tessera.config.json`, so it lands BESIDE that file — outside the `.tessera/` described above and therefore outside that undo — and falls back to `.tessera/sn-docs/` when no config file is found, where its presence also keeps the ledger root from being removed. Whatever it writes stays.",
    "",
    "A §11 TargetGuard classifies the runner before anything that could write is built, and §11.5 is a floor no argument reaches: the runner may never be production and may never be unknown. An instance that is not on the §11.2 non-prod allowlist classifies `unknown` and every write it is asked for is REFUSED; a declared production instance is refused whatever the allowlist says. A refusal comes back as an error whose first line says REFUSED, and it means NOTHING WAS WRITTEN TO THE INSTANCE. Writability is never an argument of this tool, in any spelling.",
    "",
    "EXPECT NO INSTANCE WRITE TODAY, AND NO LOCAL ONE EITHER on this path: §11.5 is asserted as the first statement of the pipeline, before the ledger is opened, so the refusal below leaves no ledger entry and the `.tessera/` directory described above is removed again. `tess run` takes its §11 configuration from its own argv and from no environment or config file, and this tool may not send the allowlist flag (an agent may propose a write, never authorise one), so the allowlist reaching the guard is currently always empty, every runner classifies `unknown`, and the guard refuses the first write the run attempts. A run may READ the instance before reaching that point, so the call can also come back as an infrastructure fault raised earlier — but it cannot come back as a GO. Neither answer is a fact about the tests or about the runner: report it as configuration that has not been made, and retrying changes nothing.",
    "",
    "THE VERDICT: GO (exit 0) means the tests ran and passed. NO_GO (exit 1) means they ran and something failed — that is a FINDING, the answer this tool was called to get, and not a fault in the tool. Do not retry it and do not report it as an error about the pipeline; report what failed.",
    "",
    "READ `verdict.status` IN THE RETURNED DOCUMENT rather than trusting the exit code to separate the outcomes. This command's mapping is frozen at Phase 0.5's two codes — GO exits 0 and EVERYTHING ELSE exits 1 — so an INCONCLUSIVE verdict (QA-9: something could not be checked, so no green may be claimed) also arrives as exit 1 and never as exit 5. The document keeps the difference the exit code loses; a NO_GO and an INCONCLUSIVE are not the same answer and must not be reported as one.",
    "",
    "An infrastructure fault is a THIRD thing again and is never a verdict: it comes back with no report at all, because a run that produced no evidence has said nothing about the tests (DEV-1).",
  ].join("\n"),
  fields: RUN_FIELDS,
  writeClass: "mutating",
  egress: "instance",
  reportsVerdict: true,
  // Decision 10: `tess run` REFUSES to run without `--skeleton` ("Phase 0.5 has
  // exactly one mode, and the flag is what says the caller knows it"). Exposing
  // it would offer a caller one legal value and one usage error; pinning it is
  // the same move `preflight_plan` makes with `--mode plan`.
  pinned: ["--skeleton"],
};

// ── the run-state fields ────────────────────────────────────────────────────
//
// `tess status`, `tess confirm` and `tess cleanup` read a run a previous `tess
// run` left in the §4b ledger. Decision 13 argues the short list: the run id is
// the one identity these commands cannot work without, so it is required and it
// is NOT decision 10's minting `--run-id` — here it names a run that already
// exists rather than choosing the name a new run's audit trail will carry.
// `--ledger-root` stays off (it would let a caller read or delete under a
// directory of its choosing), and so do `--actor` and the §11 knobs.

/** Required, and the second of decision 3's carve-outs (decision 13). */
const RUN_ID_FIELD: ToolField = {
  name: "runId",
  flag: "--run-id",
  type: "string",
  required: true,
  // Delegated decision 2026-09-25: an id that cannot name a run is refused as
  // invalid params before any argv is built, with the ledger's own pattern —
  // the same rule `tess status/confirm/cleanup` apply as a usage error.
  pattern: RUN_ID_PATTERN,
  description:
    "The id of a run a previous `tess run` / preflight_run recorded in the local §4b ledger (`.tessera/` under this server's working directory). It names an EXISTING run; it cannot start one. An id with no record there is a usage error (exit 2), not an empty answer.",
};

const SINCE_FIELD: ToolField = {
  name: "since",
  flag: "--since",
  type: "integer",
  description:
    "Event cursor: return only the events committed after it. Pass back the `cursor` of the previous call to resume a poll; omitted, it is 0 and every event is returned.",
};

/**
 * Property `runner`, flag `--runner`, and — unlike `RUN_INSTANCE_FIELD` — the
 * value is a credential PROFILE, because that is what `tess cleanup` binds.
 */
const CLEANUP_RUNNER_FIELD: ToolField = {
  name: "runner",
  flag: "--runner",
  type: "string",
  description:
    "Credential profile for the §2a RUNNER role — the instance the run's ephemeral ATF records live on. Omitted, the command uses the profile named \"default\". Naming a profile cannot make it writable: §11.2 writability is the operator's allowlist, never an argument.",
};

/**
 * Decision 18: explicit run ids a legacy inventory reads besides the minted
 * ones — repeated `--run-id`, each held to the ledger's pattern.
 */
const LEGACY_RUN_IDS_FIELD: ToolField = {
  name: "runIds",
  flag: "--run-id",
  type: "stringList",
  pattern: RUN_ID_PATTERN,
  description:
    "Optional explicit run ids (e.g. a benchmark's chosen `--run-id`) whose `<runId>:` rows are inventoried as well. Rows under any run id of the shape Tessera mints are always included; these only WIDEN the read.",
};

const CLEANUP_LEGACY_PLAN_FIELDS: readonly ToolField[] = [
  CLEANUP_RUNNER_FIELD,
  LEGACY_RUN_IDS_FIELD,
];

/** Decision 6's confirmation, repeated for the second writer that deletes. */
const CLEANUP_MODE_FIELD: ToolField = {
  name: "mode",
  flag: "--mode",
  type: "string",
  only: "apply",
  required: true,
  description:
    'Must be the literal string "apply". This tool DELETES records on the runner, and §6b requires the caller to say so in the call. To see what would be deleted without deleting it, call preflight_cleanup_plan instead.',
};

const RUN_STATUS_FIELDS: readonly ToolField[] = [RUN_ID_FIELD, SINCE_FIELD];
const CONFIRM_FIELDS: readonly ToolField[] = [RUN_ID_FIELD];
const CLEANUP_PLAN_FIELDS: readonly ToolField[] = [
  RUN_ID_FIELD,
  CLEANUP_RUNNER_FIELD,
];
/** Plan plus permission, exactly as `APPLY_FIELDS` is (decision 12). */
const CLEANUP_APPLY_FIELDS: readonly ToolField[] = [
  CLEANUP_MODE_FIELD,
  ...CLEANUP_PLAN_FIELDS,
];

/**
 * DEV-17 and §4a are refused on the LOCAL record before `--mode` is even read,
 * so the plan tool can be refused too — and there the refusal is a fact about
 * the run's lifecycle, not the guard defect `results.ts` would otherwise read
 * into a read-only tool's exit 4 (decision 15).
 */
const CLEANUP_LIFECYCLE_REFUSAL =
  "The run's LOCAL record says it may not be cleaned up, and NOTHING WAS DELETED. Either it is not in a terminal state yet (DEV-17 — a run that may still have a live owner is torn down by that owner, never by cleanup; once it is `failed` or `abandoned`, cleanup can re-enter it), or it is not an ephemeral run (§4a — persistent test definitions are never deleted by cleanup). It is not a failure to retry and not a finding about any change: report the reason below and stop.";

export const RUN_STATUS_TOOL: ToolSpec = {
  name: "preflight_run_status",
  title: "Run status (read-only)",
  command: "status",
  description: [
    "Answers WHERE A RUN IS: reads the local §4b record of a run preflight_run (or `tess run`) started and returns its lifecycle state, whether that state is terminal, the §6b events committed after `since`, a `cursor` to resume from, and — once the run persisted one — a summary of its result.",
    "",
    "It reads LOCAL FILES ONLY — the ledger under `.tessera/` in this server's working directory — and contacts no instance. It writes nothing anywhere.",
    "",
    "It reaches NO VERDICT. `result`, when present, is what the run recorded; to confirm a verdict and obtain its token, call preflight_confirm_ready. A run id with no record is a usage error (exit 2) rather than an empty status, because an unknown run is not a run with no events.",
  ].join("\n"),
  fields: RUN_STATUS_FIELDS,
  writeClass: "read-only",
  egress: "none",
  reportsVerdict: false,
  localOnly: true,
};

export const CONFIRM_READY_TOOL: ToolSpec = {
  name: "preflight_confirm_ready",
  title: "Confirm a run's recorded verdict (read-only)",
  command: "confirm",
  description: [
    "Answers WHAT A FINISHED RUN DECIDED, from what it recorded: reads the result a run persisted in the local §4b ledger and returns its verdict, its failures and — for a verdict — the `verdict.confirmToken.verdictHash` that identifies it. IT NEVER RE-RUNS ANYTHING (§6b, QA-9): it contacts no instance, writes nothing, and a run without a persisted result is not run to get one.",
    "",
    "The exit code is the RECORDED one, relayed: GO (exit 0) and NO_GO (exit 1) are the run's verdict, and NO_GO comes back as an error result with the document attached so that it cannot be read as a pass. INCONCLUSIVE (exit 5) is either the run's own inconclusive verdict or a run that has persisted no result yet — the document's `state` says which; do not report it as ready.",
    "",
    "A run that RECORDED an infrastructure fault or a §11 refusal relays exit 3 or 4 WITH its document, and that is a fact about the confirmed run, not a failure of this call. An exit 3 WITHOUT a document is this call failing (the record could not be trusted as a live result, DEV-1), and nothing was confirmed. A run id with no record is a usage error (exit 2).",
  ].join("\n"),
  fields: CONFIRM_FIELDS,
  writeClass: "read-only",
  egress: "none",
  reportsVerdict: true,
  relaysRecordedExit: true,
  localOnly: true,
};

export const CLEANUP_PLAN_TOOL: ToolSpec = {
  name: "preflight_cleanup_plan",
  title: "Run cleanup, plan only (read-only)",
  command: "cleanup",
  description: [
    "Answers WHAT CLEANING UP A RUN WOULD DO: reads the run's local §4b record and returns the plan — the runner it would act on, the run's local state, the `<runId>:` namespace whose ephemeral ATF suites, tests, steps and step inputs would be deleted (suite RESULTS are kept, QA-17), the lifecycle transitions it would record, and how many ledger entries it would settle.",
    "",
    "NOTHING IS DELETED. `--mode plan` is pinned onto the delegated command; preflight_cleanup_apply is the only tool that performs the plan. It reads local files and the runner profile's configuration, and contacts no instance.",
    "",
    "A run with no local record still gets a plan (`localState: null`) — the apply would sweep the namespace only, and `unrecordedSweep` says whether it may: `minted-run-id` (the id has the shape Tessera mints) lets it proceed, `refused` means the apply WILL be refused because the namespace may hold ATF records Tessera did not create. The CLI's `--confirm-unrecorded` lifts that refusal and is deliberately not an argument of either cleanup tool: whether the namespace is Tessera's is the operator's call, made at the command line. `unrecordedSweep` is null when a local record exists.",
    "",
    "A run that is not terminal yet (DEV-17) or not ephemeral (§4a) is REFUSED (exit 4) here as well, because that check reads the local record before any mode is considered: nothing would be deleted, and the refusal says why.",
    "",
    "It reaches NO VERDICT; this is a plan, not an answer about the tests.",
  ].join("\n"),
  fields: CLEANUP_PLAN_FIELDS,
  writeClass: "read-only",
  egress: "none",
  reportsVerdict: false,
  pinned: ["--mode", "plan"],
  refusalReading: CLEANUP_LIFECYCLE_REFUSAL,
  localOnly: true,
};

export const CLEANUP_APPLY_TOOL: ToolSpec = {
  name: "preflight_cleanup_apply",
  title: "Run cleanup, apply mode (DELETES on the runner)",
  command: "cleanup",
  description: [
    "THIS TOOL DELETES. It performs the plan preflight_cleanup_plan returns: deletes every ephemeral ATF suite, test, step and step input named `<runId>:…` on the runner (in the DEV-13 order; suite RESULTS are kept, QA-17), settles the run's local ledger entries and records it `done`. Call preflight_cleanup_plan first and read it.",
    "",
    "It requires `mode` to be the literal string \"apply\". It also WRITES LOCALLY: the run's record and events under `.tessera/` in this server's working directory.",
    "",
    'A run that is not terminal (DEV-17) or not ephemeral (§4a) is REFUSED before anything else. So is a run with NO local record whose id is not one Tessera mints (the plan\'s `unrecordedSweep: "refused"`): its namespace may hold ATF records Tessera did not create, and the confirmation that lifts that refusal belongs to the operator at the command line — it is not an argument of this tool. Then a §11 TargetGuard decides whether the runner may be written to at all, and the store itself refuses while any suite result of the run is still running (DEV-17). A refusal comes back as an error whose first line says REFUSED, and it means NOTHING WAS DELETED.',
    "",
    "EXPECT REFUSED TODAY. `tess cleanup` takes its §11.2 allowlist from its own argv and from no environment or config file, and this tool may not send it (an agent may propose a delete, never authorise one), so every runner classifies `unknown` and the guard refuses. Report that as configuration that has not been made; retrying changes nothing.",
    "",
    "A completed cleanup exits 0. It is re-entrant by design (§4b): a second cleanup of a run already cleaned finds an empty namespace and deletes nothing. It reaches no verdict about the tests.",
  ].join("\n"),
  fields: CLEANUP_APPLY_FIELDS,
  writeClass: "mutating",
  egress: "instance",
  reportsVerdict: false,
  refusalReading:
    "Nothing you can pass as a tool argument lifts this, and NOTHING WAS DELETED. Either the run's local record forbids cleanup (DEV-17 — not terminal yet, so a live owner may still hold it; §4a — not ephemeral), or there is no local record and the id is not one Tessera mints (the namespace may hold ATF records Tessera did not create — the `--confirm-unrecorded` the reason below mentions is the operator's command-line confirmation and has no counterpart here), or the §11 guard would not accept the runner as writable (its allowlist belongs to the operator who runs this server). It is a REFUSAL, not a failure to retry and not a finding about the tests: report the reason below and stop.",
  faultRemedy:
    "What establishes the state is a READ: call preflight_run_status for the run (a cleanup that failed part-way records the run `failed`) and preflight_cleanup_plan for what is still to delete, report both, and let the operator decide whether to call this tool again. Cleanup is re-entrant — a second call re-enters a `failed` run and deletes only what is still there — but whether to make it is the operator's call, not something to try in order to find out.",
};

export const CLEANUP_LEGACY_PLAN_TOOL: ToolSpec = {
  name: "preflight_cleanup_legacy_plan",
  title: "Legacy ATF rows, inventory only (read-only)",
  command: "cleanup",
  description: [
    "Answers WHICH PRE-MARKER ATF ROWS ARE ON THE RUNNER: lists every ATF test and suite named `<runId>:…` (a run id of the shape Tessera mints, or one of `runIds`) whose description carries no Tessera ownership marker — rows an older Tessera wrote, which preflight_cleanup_apply refuses as not provably the run's and will never delete. Each candidate comes with its steps, step inputs, suite links, suite results and `blockers`; `conflicts` lists rows that carry ANOTHER run's marker.",
    "",
    "NOTHING IS DELETED, and no tool here deletes these rows. `--legacy --mode plan` is pinned onto the delegated command, which issues GET requests only. Deleting a legacy row takes `tess cleanup --legacy --mode apply` at the command line with a saved report and the operator's own list of sys_ids; neither is an argument of any tool (an agent may propose a delete, never authorise one). Report the candidates and their blockers and let the operator decide.",
    "",
    "It reaches NO VERDICT about any test.",
  ].join("\n"),
  fields: CLEANUP_LEGACY_PLAN_FIELDS,
  writeClass: "read-only",
  egress: "none",
  reportsVerdict: false,
  pinned: ["--legacy", "--mode", "plan"],
  refusalReading:
    "The legacy inventory was REFUSED rather than returned partially, and NOTHING WAS DELETED — this tool deletes nothing in any case. The usual reason is a read that did not reach its end within the page cap (`truncated-read`): acting on part of an inventory is how a row gets missed. It is not a finding about any test and not a failure to retry blindly: report the reason below and stop.",
};

/**
 * Every tool this server exposes, in pipeline order — resolve what changed,
 * analyse it, join it against the repo, propose specs for what the join says is
 * missing, diagnose the instance it would run on, gate it, then and only then
 * write to it. Generation sits where it does because that is where it belongs in
 * the work, not because of what it writes: its output is a proposal a human
 * promotes, so it precedes every step that touches an instance. Fixed at compile
 * time, hence no `listChanged`.
 *
 * `preflight_run` follows the gate because it is what the tools before it are
 * FOR: the gate exists to decide whether this call may happen. The run-state
 * tools come after it because they read what a run left behind — follow it,
 * confirm what it decided, then clean up after it, plan before apply as
 * everywhere else in the list.
 */
export const TOOLS: readonly ToolSpec[] = [
  RESOLVE_TOOL,
  IMPACT_TOOL,
  COVERAGE_TOOL,
  GENERATE_TOOL,
  DOCTOR_TOOL,
  PLAN_TOOL,
  APPLY_TOOL,
  RUN_TOOL,
  RUN_STATUS_TOOL,
  CONFIRM_READY_TOOL,
  CLEANUP_PLAN_TOOL,
  CLEANUP_APPLY_TOOL,
  // Decision 18: discovery only, deliberately without an apply half.
  CLEANUP_LEGACY_PLAN_TOOL,
];

export function findTool(name: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

function propertySchema(field: ToolField): Record<string, unknown> {
  if (field.type === "stringList") {
    return {
      type: "array",
      items: {
        type: "string",
        ...(field.pattern === undefined
          ? {}
          : { pattern: field.pattern.source }),
      },
      minItems: 1,
      description: field.description,
    };
  }
  if (field.type === "integer") {
    return { type: "integer", minimum: 0, description: field.description };
  }
  return {
    type: "string",
    // A one-entry enum, so a host that renders the schema shows the caller the
    // only value there is instead of an open text box (decision 6).
    ...(field.only === undefined ? {} : { enum: [field.only] }),
    ...(field.pattern === undefined ? {} : { pattern: field.pattern.source }),
    description: field.description,
  };
}

/**
 * The `inputSchema` a host advertises, derived from the same field list the
 * argv builder walks — so a knob cannot appear in one and not the other.
 *
 * `additionalProperties: false` is the half of the schema that does real work:
 * a model that invents `--update-set` (deferred, DESIGN §12.3) or misspells
 * `testsRoot` gets told so, instead of having the argument silently dropped and
 * reading the resulting report as an answer to the question it thought it asked.
 *
 * `required` is emitted only when a field actually asks for it, which today is
 * `mode` on the two apply tools and `runId` on the run-state tools and nothing
 * else — see decision 3 for why an empty `required` would be a claim rather
 * than an omission.
 */
export function inputSchemaFor(spec: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of spec.fields) {
    properties[field.name] = propertySchema(field);
    if (field.required === true) required.push(field.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

/**
 * The `annotations` block, derived from `writeClass` rather than written per
 * tool (decision 4).
 *
 * `destructiveHint` and `idempotentHint` are OMITTED for a read-only tool
 * rather than set false: the specification says both are meaningful only when
 * `readOnlyHint` is false, and declaring them anyway would suggest the tool had
 * a write mode to describe.
 *
 * For the mutating ones both are stated, and `idempotentHint` is `false` on
 * purpose. §6b's table marks `apply` idempotent "(via key)", and since
 * `--idempotency-key` reached `tess preflight` the key IS an argument of
 * `preflight_apply` — but an OPTIONAL one (decision 7). The hint describes the
 * tool, not the best-behaved call to it: a call without a key is keyed by a
 * fresh run id and a repeat of it is a re-execution, so `true` would promise
 * the unkeyed caller a safety only the keyed caller has. It stays pinned false
 * for that reason, and the prose tells the caller how to earn the property.
 * `preflight_run` has an independent reason for the same value: two runs are
 * two runs, each minting its own run id and its own ledger entries, and a test
 * suite that passed an hour ago is not a promise. `preflight_cleanup_apply` is
 * re-entrant by §4b — a second cleanup finds an empty namespace — and still
 * shares the `false`: it deletes, the branch is one decision for every writer
 * (decision 4), and a hint a host may use to auto-retry a delete is not one
 * this surface hands out per tool.
 *
 * `repo-write` lands on the same three values and shares the branch, which is
 * worth arguing rather than leaving as an accident of the `if`. `readOnlyHint`
 * is false because files appear. `destructiveHint` is true because a
 * regenerated batch OVERWRITES the proposal a reviewer may already have read —
 * `writer.ts` reports that as `overwritten` precisely because it matters to
 * them — so "additive only" is a claim this tool cannot keep, inert and
 * confined to `proposed/` though everything it can reach is. And
 * `idempotentHint` is false because only the offline backend is deterministic,
 * and the spec cannot know which one the operator configured. Where the two
 * classes genuinely differ is `egress` and the wording of the tool itself,
 * neither of which an annotation carries.
 */
function annotationsFor(spec: ToolSpec): Record<string, unknown> {
  const shared = {
    title: spec.title,
    // Every tool that reaches an instance reaches one nobody in this process
    // controls (§6b marks every instance-touching row this way), so the same
    // arguments may return different answers tomorrow. The local-only reads
    // are the exception, and say so (decision 16).
    openWorldHint: spec.localOnly !== true,
  };
  if (spec.writeClass === "read-only") {
    return { ...shared, readOnlyHint: true };
  }
  return {
    ...shared,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  };
}

/** One entry of a `tools/list` reply. */
export function toolDefinition(spec: ToolSpec): Record<string, unknown> {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: inputSchemaFor(spec),
    annotations: annotationsFor(spec),
  };
}

export type ToolArgumentValue = string | readonly string[];

export type ValidationOutcome =
  | {
      readonly ok: true;
      readonly values: ReadonlyMap<string, ToolArgumentValue>;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Type-check one `tools/call` argument object against a tool's fields.
 *
 * `null` is accepted as "absent". That is a deliberate leniency rather than an
 * oversight: several hosts serialise an omitted optional argument as `null`, and
 * refusing it would cost a real caller a real error to teach them nothing — the
 * only thing `null` can mean here is that the knob was not set.
 *
 * The two exceptions are `required` and `only`: `mode` on the apply tools
 * (decisions 6 and 12) and `runId` on the run-state tools (decision 13). A
 * privileged act that a forgotten argument could still perform is not a
 * confirmation, so `mode: null` on `preflight_apply` is refused rather than
 * shrugged off; and a run-state call without a run id has no question in it.
 */
export function validateArguments(
  spec: ToolSpec,
  args: unknown,
): ValidationOutcome {
  if (args !== undefined && args !== null) {
    if (typeof args !== "object" || Array.isArray(args)) {
      return {
        ok: false,
        message: `arguments must be an object; received ${Array.isArray(args) ? "an array" : typeof args}`,
      };
    }
  }

  const record: Record<string, unknown> =
    args === undefined || args === null
      ? {}
      : (args as Record<string, unknown>);
  const known = new Set(spec.fields.map((field) => field.name));
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      return {
        ok: false,
        message: `unknown argument \`${key}\` for ${spec.name}; this tool accepts ${[...known].join(", ")}`,
      };
    }
  }

  const values = new Map<string, ToolArgumentValue>();
  for (const field of spec.fields) {
    const value = record[field.name];
    const absent =
      !(field.name in record) || value === null || value === undefined;

    if (absent) {
      if (field.required === true) {
        return {
          ok: false,
          message: `\`${field.name}\` is required for ${spec.name}${field.only === undefined ? "" : ` and must be "${field.only}"`}`,
        };
      }
      continue;
    }

    if (field.type === "string") {
      if (typeof value !== "string") {
        return {
          ok: false,
          message: `\`${field.name}\` must be a string; received ${typeof value}`,
        };
      }
      const flagLike = flagLikeValue(field, value);
      if (flagLike !== undefined) return flagLike;
      if (field.pattern !== undefined && !field.pattern.test(value)) {
        return {
          ok: false,
          message: `\`${field.name}\` must match ${field.pattern.source}; received ${JSON.stringify(value)}`,
        };
      }
      if (field.only !== undefined && value !== field.only) {
        return {
          ok: false,
          message: `\`${field.name}\` must be "${field.only}" for ${spec.name}; received ${JSON.stringify(value)}`,
        };
      }
      values.set(field.name, value);
      continue;
    }

    if (field.type === "integer") {
      // Refused here rather than by the CLI because the wire type is provable
      // without running anything (decision 3): `1.5`, `-1` and `"3"` are not
      // cursors, and the argv carries the decimal the CLI parses back.
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        return {
          ok: false,
          message: `\`${field.name}\` must be a non-negative integer; received ${typeof value === "number" ? String(value) : typeof value}`,
        };
      }
      values.set(field.name, String(value));
      continue;
    }

    if (!Array.isArray(value)) {
      return {
        ok: false,
        message: `\`${field.name}\` must be an array of strings; received ${typeof value}`,
      };
    }
    if (value.some((entry) => typeof entry !== "string")) {
      return {
        ok: false,
        message: `\`${field.name}\` must contain strings only`,
      };
    }
    for (const entry of value as readonly string[]) {
      const flagLike = flagLikeValue(field, entry);
      if (flagLike !== undefined) return flagLike;
      // Delegated decision 2026-09-30 (wave 14): a list entry is held to its
      // field's pattern exactly as a string is (decision 18's `runIds`).
      if (field.pattern !== undefined && !field.pattern.test(entry)) {
        return {
          ok: false,
          message: `every entry of \`${field.name}\` must match ${field.pattern.source}; received ${JSON.stringify(entry)}`,
        };
      }
    }
    // An empty array would fall through to the CLI's default set, so the caller
    // would get an answer computed over tables they thought they had excluded.
    if (value.length === 0) {
      return {
        ok: false,
        message: `\`${field.name}\` must name at least one value; omit it entirely to use the default`,
      };
    }
    values.set(field.name, value as readonly string[]);
  }

  return { ok: true, values };
}

/**
 * A string argument that begins with "-" is refused before any argv is built.
 *
 * Delegated decision 2026-09-25: every value reaches the CLI as the token after
 * its flag, and a value that looks like a flag is read by the CLI as one — a
 * `runId` of "--help" turned a status call into help text that came back as an
 * INTERNAL FAULT. No field on this surface has a legitimate value with a
 * leading dash (run ids, profiles, hosts, scopes, story ids, tests roots, the
 * literal "apply"), so the refusal is unconditional rather than per field:
 * fail-closed, and provable without running anything (decision 3).
 */
function flagLikeValue(
  field: ToolField,
  value: string,
): ValidationOutcome | undefined {
  if (!value.startsWith("-")) return undefined;
  return {
    ok: false,
    message: `\`${field.name}\` must not start with "-" (it would be read as a flag); received ${JSON.stringify(value)}`,
  };
}

/**
 * Validated arguments → the argv the composition root parses.
 *
 * Walks the FIELD list, not the caller's object, so the argv is a function of
 * the tool rather than of JSON key order — which is what makes it assertable.
 * `--json` leads, because the report shape is not negotiable (see the header),
 * and `pinned` follows it: a flag the tool fixes must be on the argv whether or
 * not the caller sent anything at all.
 */
export function toArgv(
  spec: ToolSpec,
  values: ReadonlyMap<string, ToolArgumentValue>,
): string[] {
  const argv: string[] = [spec.command, "--json", ...(spec.pinned ?? [])];
  for (const field of spec.fields) {
    const value = values.get(field.name);
    if (value === undefined) continue;
    if (typeof value === "string") {
      argv.push(field.flag, value);
      continue;
    }
    for (const entry of value) argv.push(field.flag, entry);
  }
  return argv;
}
