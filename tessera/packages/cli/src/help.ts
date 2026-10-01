// Help text. Flag lists are DERIVED, prose is written.
//
// `formatOptionsHelp` renders the same table `resolveConfig` parses, so the two
// cannot drift: a flag that exists is documented, and a documented flag exists.
// The prose around it — what a command is FOR, which exit code means what — is
// the part a table cannot express, and it is the part operators actually read.
//
// `tess run --skeleton` keeps its hand-written block verbatim from Phase 0.5:
// its flags never went through the option table (see commands/run.ts), so there
// is nothing to derive them from, and the block is frozen along with the
// command's behaviour.

import { formatOptionsHelp } from "@tessera/config";
import { S5_TARGET_NAME } from "@tessera/phase05";

import type { CommandName } from "./args.js";
import { LIVE_ARTIFACT_TABLES } from "./liveArtifactTables.js";
import {
  COVERAGE_OPTIONS,
  DOCTOR_OPTIONS,
  GENERATE_OPTIONS,
  IMPACT_OPTIONS,
  PREFLIGHT_CLI_OPTIONS,
  RESOLVE_OPTIONS,
} from "./options.js";

/** A comma-separated list, wrapped at `width` columns under `indent`. */
function wrapList(
  items: readonly string[],
  indent: string,
  width: number,
): string {
  const lines: string[] = [];
  let line = "";
  items.forEach((item, index) => {
    const word = index === items.length - 1 ? `${item}.` : `${item},`;
    const next = line === "" ? `${indent}${word}` : `${line} ${word}`;
    if (line !== "" && next.length > width) {
      lines.push(line);
      line = `${indent}${word}`;
    } else {
      line = next;
    }
  });
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

export const TOP_LEVEL_HELP = `tess — preflight for ServiceNow test runs (Tessera, PLAN Phase 1)

USAGE
  tess <command> [options]
  tess <command> --help

COMMANDS
  preflight   Is this topology ready to run tests, and does the runner carry the
              code the source says it should? Plans the fixes; applies none
              unless asked (ARCH-2).
  resolve     What does this story or scope actually affect? Prints the ARCH-5
              artifact list, read-only, before anything is gated on it. Never
              exits 1 — resolution answers "which artifacts", not "go / no-go".
  impact      What ELSE does that change reach? Resolves the same change set,
              then traces which scripts in one scope use it. Read-only, and it
              never exits 1 either — a graph is an answer, not a verdict.
  coverage    Which of those impacted artifacts has a test spec declared against
              it, and which has none? The gap list, read before a run — DECLARED
              INTENT only, never a pass/fail claim (QA-8).
  generate    Propose specs for the artifacts that have none. Writes ONLY to
              <tests-root>/proposed/; the live manifest is never touched, so
              nothing it produces runs until a human promotes it (DEV-4).
  doctor      Read-only readiness diagnosis of one or two instances. Writes
              nothing, ever — so it may probe any role, target included (ARCH-8).
  run         A gated test run. --live projects the repo's unit specs onto the
              runner, executes them and reaches a §6a verdict; --skeleton is the
              frozen PLAN Phase 0.5 walking skeleton. Requires one of the two.
  status      Where is a run now? The persisted §4b state and the §6b events
              after a cursor. Read-only, local disk only.
  confirm     What did a finished live run decide? Its verdict and confirm token,
              read from the persisted result. Never re-runs anything (§6b).
  cleanup     Tear down a failed or abandoned run's ATF projection by its run-id
              namespace and settle its ledger. --mode plan (default) writes
              nothing; --mode apply deletes (§4b). --legacy lists pre-marker
              ATF rows and deletes only operator-confirmed sys_ids.
  benchmark   Score a hand-authored mutant catalog against the S5 OutcomeGate
              (§13.1) on an allowlisted sub-prod runner. There is no default
              catalog; a fixture catalog can never exit 0.

TOPOLOGY (ARCH-29/DEV-5)
  Roles are named as CREDENTIAL-STORE PROFILES, not hosts: each role carries its
  own instance, auth and host policy (ARCH-7/18). "default" is the profile made
  of SN_INSTANCE/SN_USER/SN_PASSWORD; any other lives under
  SN_PROFILE_<NAME>_INSTANCE/_USER/_PASSWORD.

    --source    read artifacts and stories from here (ARCH-19)
    --runner    the ONLY instance a pipeline write may touch (ARCH-8)
    --target    probed read-only; the promotion destination
    --instance  collapse all three onto one profile

CONFIGURATION
  Every option of preflight, resolve, impact, coverage, generate and doctor
  resolves through four layers, highest first: flag > env > tessera.config.json
  > default. \`run\`, \`status\`, \`confirm\`, \`cleanup\` and \`benchmark\` take
  argv only: the
  skeleton's flags are frozen Phase-0.5 dev switches, and the rest are
  addressed by run id, which has no business in an env var or a config file.
  The resolved set is logged with the layer that won, so "why is it that value"
  is answerable from the output. Secrets are never read from a config file — env
  or the credential store only.

EXIT CODES
  0 ready / GO          3 infrastructure fault (no evidence — DEV-1)
  1 not ready / NO_GO   4 §11 refusal — a write was refused, nothing was written
  2 usage               5 inconclusive — something could not be decided (QA-9)

  5 is reachable from preflight, resolve, impact, coverage, generate, doctor,
  confirm, benchmark and \`run --live\`; status and cleanup answer 0, 2, 3 or
  4 only.
  It is NOT reachable from \`run --skeleton\`, whose mapping is frozen at Phase
  0.5's two outcomes — 0 for GO, 1 for everything else — so an INCONCLUSIVE
  verdict there arrives as a 1 and never as a 5. A CI job branching on 5 must
  not be pointed at that command; see \`tess run --help\`.
`;

const PREFLIGHT_HELP = `tess preflight — is this topology ready, and is the runner running the right code?

USAGE
  tess preflight --runner <profile> [--source <profile>] [options]

WHAT IT DOES
  1. Resolves configuration through all four layers and logs it, redacted.
  2. EnvironmentDoctor (DESIGN §12.3): every declared precondition is probed on
     the runner and reported ready / not-ready / unknown. A precondition this
     phase cannot probe is declared and marked deferred, never omitted — an
     unanalyzable check is never a silent green (QA-9). A requested test kind
     whose runner is unreachable is a hard failure (DEV-2).
  3. ARCH-20 code-version parity: SHA-256 of the executable fields of each
     --artifact on the source and on the runner. A mismatch is a hard failure.
     Parity NEVER deploys source -> runner; that stays yours to do.
  4. Provisioner: turns not-ready findings into a plan of precise writes.
     --mode plan (the default) prints the plan and writes NOTHING; --mode apply
     performs it against the runner and re-diagnoses afterwards, so the verdict
     reflects the instance as it now is rather than as the plan hoped.

OPTIONS
${formatOptionsHelp(PREFLIGHT_CLI_OPTIONS)}

NOTES
  --artifact takes table/sys_id[:label] and is repeatable. It exists because
  parity needs an artifact list and preflight has no other way to obtain one:
  without it there is nothing to compare and parity reports not-applicable
  forever. The ARCH-5 composite that will supersede it now exists — see
  \`tess resolve\` — but preflight does not consume it yet, so the flag is still
  how this command learns what to compare.

  --allow is the ONLY source of writability (§11.2) and is required by
  --mode apply. No flag lifts a declared --prod instance or an unknown one.

  --acknowledge-prod <reason> lifts ONE case: an allowlisted runner the §11.2
  probe downgraded to prod-suspect. The reason, your actor and the evidence
  are journalled to the §4b ledger BEFORE any write; if that cannot be
  flushed the write is refused.

  --plan-hash <digest> is the hash a --mode plan run printed. Apply always
  re-plans; if the recomputed hash differs the instance moved since review,
  and apply is REFUSED (exit 4) with nothing written — never silently
  re-planned.

  Every apply write is journalled write-ahead as ARCH-33 standing
  infrastructure under --ledger-root (default .tessera) and keyed
  <--idempotency-key>#<step> (default: the run id). A retry under the same key
  and the same plan skips steps already confirmed; the same key under a
  different plan is refused before any write.

  These four flags are argv-only (no env, no config file) and apply-only.

EXIT CODES
  0 ready   1 not ready / parity mismatch   2 usage
  3 fault   4 §11 refusal                   5 inconclusive
`;

const RESOLVE_HELP = `tess resolve — what does this story or scope actually affect?

USAGE
  tess resolve --source <profile> (--story <id> | --scope <name>) [options]

WHAT IT DOES
  Runs the ARCH-5 composite resolver and prints the artifact list it produced,
  with the source that claimed each row. Nothing is gated on the answer here —
  that is the point. A checklist assembled from the wrong story produces a
  perfectly green run over artifacts nobody meant to test, and the only defence
  against that is being able to look at the list first.

  Every source runs on every input and the results are UNIONED, de-duplicated by
  sys_id. Order sets reporting precedence, not first-wins: an artifact both the
  story and the scope name is reported once, labelled with the story, because
  "this row is in the story's update set" is the more specific statement.

  It READS, and it binds one role. Stories and artifacts live on the source
  (ARCH-19) and the reader is GET-only, so there is no writer, no ledger and no
  guard in reach — pointing this at production is safe by construction rather
  than by promise (ARCH-8).

OPTIONS
${formatOptionsHelp(RESOLVE_OPTIONS)}

NOTES
  --update-set is declared and REFUSED. DESIGN §12.3 defers UpdateSetResolver
  past the MVP, and resolving the story or scope while quietly ignoring the
  update set would report a resolution the operator never asked for.

  --update-set-story-field exists because the column linking sys_update_set back
  to rm_story is the one piece of schema here not yet verified against a live
  instance. A wrong field name is REJECTED by the instance rather than answered,
  and that fault is reported as a fault — it is never rounded down to "this
  story changed nothing" (OPP-1b).

EXIT CODES
  0 resolved   2 usage — including a story or scope the instance says is absent
  3 infrastructure fault — the instance never answered, so there is no list
  5 inconclusive — at least one source could not answer in full, so the list is
    partial even when it is not empty (QA-9)

  1 is never returned. Resolution answers "which artifacts", not "go / no-go";
  a 1 out of this command is a bug, not a rejection.
`;

const IMPACT_HELP = `tess impact — what else does this change reach?

USAGE
  tess impact --source <profile> --scope <name> [--story <id>] [options]

WHAT IT DOES
  Resolves the change set exactly as \`tess resolve\` does — same ARCH-5
  composite, same instance, same labels — and then asks the question resolve
  stops short of: which OTHER scripts in this scope use what changed. The answer
  is a graph: the resolved artifacts and the consumers that reach them, one edge
  per use, plus the artifacts nobody could analyse at all.

  The search is TEXTUAL, and every edge says so. ServiceNow has no API that
  answers "who calls this Script Include" — its own Where-Used runs a search
  across script columns, and so does this — and a search cannot tell
  \`new Validator()\` from the word "validator" in a comment. So each edge carries
  the evidence that produced it: high (the name in call position), medium (the
  name as a bare identifier), low (the name inside a comment or a string). A low
  edge is not a defect; it is the analysis declining to round a guess up.

  What it CANNOT see is printed, never dropped. A consumer that builds its call
  target at runtime (GlideEvaluator, gs.include, eval) makes its own silence
  meaningless, and a consumer table that refused the read said nothing about its
  rows. Both land in "unanalyzable" and both make the run exit 5, because an
  absent edge under a hole in the analysis is not evidence that nothing uses the
  artifact (QA-9).

  It READS, and it binds one role — the same construction as \`tess resolve\`, so
  pointing it at production is safe by construction rather than by promise
  (ARCH-8/19).

OPTIONS
${formatOptionsHelp(IMPACT_OPTIONS)}

NOTES
  --scope is REQUIRED, and it does two jobs. It is a resolver input, so naming a
  scope widens the change set to that scope's artifacts exactly as it does in
  \`tess resolve\`; and it is the wall the where-used search runs inside. DESIGN
  §12.3 row 3 confines the MVP to one scope, so there is no instance-wide search
  to fall back on — that is a different operation with a different cost, not this
  one with a flag left off.

  --story narrows the SUBJECTS without narrowing the SEARCH. With it, the
  analysis traces the story's artifacts against every script in the scope; the
  scope still bounds where consumers are looked for.

  --update-set is not accepted here at all. \`tess resolve\` declares and refuses
  it so the operator asking "what is my change set" meets DESIGN §12.3's
  deferral rather than an unknown-flag error; on this command it could only ever
  fail before one edge was traced.

  Script Includes, Business Rules (sys_script) and server-side UI Actions
  (sys_ui_action) are traced as subjects; a rule or action on \`global\`, a
  client-side action, or one whose sys_script / sys_ui_action read is refused, is
  unanalyzable (exit 5) and a transport fault on that read is exit 3. No flow is
  followed past the first hop (DESIGN §12.3 row 3). The graph is one level deep
  on purpose.

EXIT CODES
  0 analysed   2 usage — including a story or scope the instance says is absent
  3 infrastructure fault — the instance never answered, so there is no graph
  5 inconclusive — an unanalyzable artifact, a table that would not answer, or a
    resolution that came back partial; the graph is not the answer (QA-9)

  1 is never returned. Impact analysis answers "what does this reach", not
  "go / no-go"; a 1 out of this command is a bug, not a rejection.
`;

const COVERAGE_HELP = `tess coverage — which impacted artifacts have a spec, and which have none?

USAGE
  tess coverage --source <profile> --scope <name> [--tests-root <dir>] [options]

WHAT IT DOES
  Runs the analysis \`tess impact\` runs — same composite, same instance, same
  single-scope wall — and then joins its result against the tests-as-code tree on
  disk. The output is one row per impacted artifact: the specs declared against
  it, or the word GAP. The gap list is the work list.

  The join is DECLARED, never inferred (QA-16). A spec is linked to an artifact
  because its manifest entry names that artifact's table and sys_id — not because
  its filename resembles one. A spec that names an artifact this analysis did not
  reach is reported as a stray, not quietly dropped: it means the manifest and
  the instance disagree, and which one is wrong is not this command's call.

  The denominator is everything the analysis touched, INCLUDING the artifacts it
  could not analyse (QA-15). Built from the analysable ones alone, the ratio
  would improve every time the analysis got worse. Rows the analysis could not
  read are marked, and they make the run exit 5.

  Disk is read BEFORE the first request to the instance, so a mistyped
  --tests-root costs nothing. It READS, and it binds one role (ARCH-8/19).

OPTIONS
${formatOptionsHelp(COVERAGE_OPTIONS)}

NOTES
  This is INTENT, not confirmed coverage, and the distinction is the whole point
  (QA-8). A spec that exists is somebody's plan; only a run is a statement about
  the code. Nothing here has been executed, so no row on this report claims that
  anything passes. Confirmed coverage is computed after a run and is a different
  report.

  --tests-root defaults to \`tests\` (the DESIGN §4 layout) and is resolved against
  the working directory. A root that does not exist is REFUSED with exit 2 rather
  than read as empty: a tree that was never read and a repo with no specs must
  never render as the same zero (OPP-1b).

  Every impact flag still means what it meant, and narrowing the analysis narrows
  this report's denominator with it — a smaller --artifact-table list is a
  smaller question, not better coverage.

EXIT CODES
  0 reported   2 usage — including a missing tests root or an absent story/scope
  3 infrastructure fault — the instance never answered, or the spec tree could
    not be read; either way there is no report (DEV-1)
  5 inconclusive — an unanalyzable artifact, a partial resolution, or a spec tree
    that was read only in part; the join is not the whole picture (QA-9)

  1 is never returned, and not merely by convention. A gap here is a gap in a
  PLAN, and this command has no evidence with which to fail a build.
`;

const GENERATE_HELP = `tess generate — propose specs for the artifacts that have none

USAGE
  tess generate --source <profile> --scope <name> --tests-root <dir> [options]

WHAT IT DOES
  Runs the analysis \`tess coverage\` runs and then works its gap list: the impact
  graph goes to a TestGenerator, which asks a provider for spec bodies, puts every
  one of them through the code gate and the quality bar, and writes the survivors.

  NOTHING IT WRITES IS LIVE. Output lands in <tests-root>/proposed/, beside a
  separate .manifest.proposed.json, and the live .manifest.json is never opened
  for writing (DEV-4). Until a human reads the diff and promotes it, nothing here
  can run, can count as coverage, or can retire a passing test. That review is the
  control this command is built around, not a step around it.

  Every spec is written with its provenance: the provider, the exact model id, and
  the hash of the prompt that produced it. A proposal nobody can attribute to a
  model is a proposal nobody can reproduce.

  It READS the instance and it binds one role (ARCH-8/19). The only thing it
  writes is files, on your own disk.

OPTIONS
${formatOptionsHelp(GENERATE_OPTIONS)}

NOTES
  --provider defaults to \`template\`: offline, deterministic, and reaching no third
  party. The spelling that costs money and sends a scope's script bodies to an API
  is the one you have to type out.

  THE API KEY IS ENV-ONLY. --api-key is listed above so the obvious spelling gets
  an explanation, and refused so the credential never reaches argv, \`ps\`, or your
  shell history. Set TESSERA_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY). Wherever
  the resolved config is printed, it renders <redacted>.

  There is no --instruction flag. The library parameter it would expose REPLACES
  the frozen instruction channel rather than adding to it, and a run that drops
  the frozen prompt while still recording the pinned prompt version has provenance
  that lies. Reproducing a past prompt is a library call, not a flag.

  One run produces one --kind, so there is no list form: a list would have to be
  either silently truncated or silently looped.

  An empty result is never a success. Every failure in the generator throws, and
  no layer converts one back into a green zero — "the model produced nothing" and
  "nothing here needs testing" are the same silence and opposite facts (OPP-1b).

  Re-running overwrites proposed/ rather than refusing. Nothing there is armed, and
  the alternative is worse: fresh output with nowhere to go while a stale file
  stays and gets reviewed as current.

EXIT CODES
  0 specs proposed and written — read them before you promote them
  2 usage — no source, no scope, no tests root, a kind outside the union, an
    analysis that named nothing, or \`--provider anthropic\` with no key in the env
  3 infrastructure fault — the instance never answered, the model never answered,
    the answer was truncated, or the gate or the quality bar rejected the batch;
    either way no spec was produced and none is being claimed (DEV-1)
  5 inconclusive — a partial resolution or an unanalyzable artifact. The specs
    that were written are real; what is not established is that they are the
    whole work list (QA-9)

  1 is never returned. A proposal is not a verdict: these specs have not been run,
  so failing a build over one would assert what no evidence supports (QA-8).
`;

const DOCTOR_HELP = `tess doctor — read-only readiness diagnosis

USAGE
  tess doctor --instance <profile> [--target <profile>] [options]

WHAT IT DOES
  Runs the EnvironmentDoctor's precondition catalogue and prints a three-state
  report: ready, not-ready, unknown. It performs no write of any kind, which is
  precisely why it is allowed to point at any role in the topology — including
  target, which no pipeline write may ever touch (ARCH-8).

  "unknown" is fail-closed and is never rounded up to "ready": a precondition
  nobody could decide is reported as undecided, with the evidence that made it
  undecidable (QA-9).

OPTIONS
${formatOptionsHelp(DOCTOR_OPTIONS)}

NOTES
  --instance and --target may name two different profiles here. That is not the
  ARCH-29 alias — the doctor is not a pipeline, so there is no single-writer
  rule to protect and two independent read targets are meaningful.

EXIT CODES
  0 ready   1 not ready   2 usage   3 fault   5 unknown / inconclusive

  ONE EXCEPTION, AND IT IS DELIBERATE: a precondition that GATES a requested
  --kind and does not come back ready is a hard failure, and a hard failure
  exits 1 even when the finding under it is "unknown" rather than not-ready
  (DEV-2 — asking for a kind whose runner nobody can confirm is a run that
  would hang, so this command refuses instead of choosing). So an "unknown"
  does not always reach 5 here, and a 1 out of this command does not by itself
  mean a precondition decided no. Read status AND hardFailure in the --json
  document rather than inferring either from the exit code.
`;

// Delegated decision 2026-09-26 (W6b finding 2): `--fake` stays listed, marked
// dev-only, rather than hidden. Help is static text, and a flag that vanished
// from it would make the exit-2 refusal a surprise instead of documented.
const RUN_HELP = `tess run — a gated test run: --live, or the Phase 0.5 --skeleton

USAGE
  tess run --live --runner <profile> --scope <name> --tests-root <dir> [options]
  tess run --skeleton [options]

  Exactly one of --live / --skeleton. Each refuses the other's flags.

LIVE (--live)
  Reads the unit specs the manifest under --tests-root declares, holds every
  body to the TM-3 generated-code gate (one rejection refuses the WHOLE run,
  exit 4, before anything is written), classifies the runner (§11), projects
  the specs as run-id-namespaced ATF tests on the runner, triggers them through
  the CI/CD API, folds the results into the §6a verdict and tears the
  projection down (DEV-13). Impact analysis runs; generation does not — a
  gating run executes what the repo declares, never a fresh proposal (DEV-4).
  Every event and the result are persisted under the ledger root, so
  \`tess status\` and \`tess confirm\` answer from disk.

  Artifacts are enumerated in the --scope from every script-bearing table:
${wrapList(LIVE_ARTIFACT_TABLES, "    ", 80)}
  A table whose read is refused (403), ACL-trimmed or truncated makes the run
  INCONCLUSIVE (exit 5) and is named in the report; a transport fault is exit 3.

  --runner <profile>         The ONLY instance written to (ARCH-8). Default:
                             "default".
  --source <profile>         Where artifacts are resolved. Default: --runner.
  --scope <name>             Application scope under test. Required.
  --story <id>               Narrow resolution to one story.
  --tests-root <dir>         The repo's spec tree (manifest). Required (QA-9).
  --allow / --prod / --acknowledge-prod / --actor   As below (§11).
  --allow-skipped            Journalled §6a override: a skipped row stops
                             blocking. Recorded in the verdict and its token.
  --run-id / --ledger-root / --docs-dir / --run-timeout-ms / --json   As below.
  --json-out <file>          Also write the JSON report to a file.
  --junit-out <file>         Also write a JUnit XML report to a file.
  Lifecycle is ephemeral only (DEV-20); the Tier-2 fake flags are refused.

  Exit codes under --live are the full set: 0 GO, 1 NO_GO, 2 usage,
  3 infrastructure fault with no NO_GO evidence, 4 §11 or TM-3 refusal,
  5 INCONCLUSIVE.

SKELETON (--skeleton)

WHAT IT DOES
  Drives ONE hardcoded ServiceNow change end to end: classify the runner (§11),
  open the write-ahead intent ledger (§4b), resolve the ${S5_TARGET_NAME} Script
  Include, project a throwaway ATF suite + test + step, trigger it through the
  CI/CD API, read the per-test result, fold it into the §6a checklist verdict,
  and tear the projection down (DEV-13).

TARGET
  --instance <host>          Instance host. Default: $SN_INSTANCE. This command
                             predates the profile binding and still takes a raw
                             host: it collapses all three roles onto one
                             instance and uses the ambient credentials.
  --name <alias>             Config alias used in messages. Default: the host.
  --allow <host>             §11.2 non-prod allowlist entry (repeatable). This
                             is the ONLY source of writability.
  --prod <host>              §11.1 prod declaration (repeatable).

OVERRIDE (§11.4)
  --acknowledge-prod <why>   Audited, run-scoped override. It covers EXACTLY ONE
                             case: a RUNNER that is allowlisted but downgraded
                             to "prod-suspect" by a heuristic. It can never lift
                             "unknown", a declared "prod", or a non-runner role
                             — those are configuration problems, not flag
                             problems. The reason is mandatory and is journalled
                             before the first write.
  --actor <name>             Who passed the override. Default: $USER.

RUN
  --run-id <id>              Default: minted from the clock.
  --lifecycle <name>         ephemeral (default) | persistent. Phase 0.5
                             implements only "ephemeral".
  --ledger-root <dir>        §4b ledger root. Default: <cwd>/.tessera.
  --docs-dir <dir>           DEV-15 write-journal root (sets $SN_DOCS_DIR).
  --run-timeout-ms <n>       DEV-2 deadline for the whole run.
  --poll-interval-ms <n>     Gap between CI/CD progress polls.
  --json                     Machine-readable report on stdout.

TIER-2 FAKE (development only)
  --fake                     Run against @tessera/fake-instance with the Tier-2
                             ATF execution engine installed (QA-18), seeded with
                             the reviewed s5-probe Script Include. Dev only:
                             refused (exit 2) unless the fake resolves inside
                             the Tessera workspace; not in the published
                             package.
  --mutant                   Seed the MUTANT half of the seeded-bug pair
                             (">" instead of ">=") — the red run.
  --fake-production-property Seed glide.installation.production=true so the
                             guard downgrades the host to "prod-suspect".
  --keep                     Keep the temporary ledger root.

EXIT CODES
  --live: the six codes above. --skeleton, frozen from Phase 0.5: 0 GO,
  1 anything else. The wider Phase-1 set (5 for
  inconclusive) deliberately does NOT apply here — CI jobs pinned to this
  command must keep the mapping they were written against.
  2 usage   3 infrastructure fault   4 §11 refusal

  So a 1 out of this command means NO_GO OR INCONCLUSIVE, and the number
  does not say which: "the target failed" and "we could not tell" are the same
  exit here (QA-9). Do not read the code alone. The report prints VERDICT and
  an "exit:" line that says when the code collapsed a distinction, and --json
  carries the same answer as verdict.exitCode / verdict.exitCodeCollapsed —
  branch on those, or move the job to --live, where 1 and 5 are distinct.
`;

const STATUS_HELP = `tess status — where is a run now?

USAGE
  tess status --run-id <id> [--since <cursor>] [--ledger-root <dir>] [--json]

WHAT IT DOES
  Prints the run's persisted §4b state (scope, runner, lifecycle, timestamps),
  the §6b events committed after --since, and the result summary once one is
  persisted. Poll it with the printed cursor as the next --since. Read-only and
  local: it opens no instance connection and never creates a ledger root.

  --run-id <id>              The run. Required.
  --since <cursor>           Only events after this cursor. Default: 0 (all).
  --ledger-root <dir>        Default: <cwd>/.tessera.
  --json                     Machine-readable snapshot on stdout.

EXIT CODES
  0 the run is known (whatever its state)
  2 usage, or no such run under the ledger root
`;

const CONFIRM_HELP = `tess confirm — what did a finished live run decide?

USAGE
  tess confirm --run-id <id> [--ledger-root <dir>] [--json]

WHAT IT DOES
  Reads the result \`tess run --live\` persisted and prints the §6a verdict,
  its non-passing rows, accepted overrides, stage failures and — on GO only —
  the confirm token (its verdictHash). It never re-runs anything and never
  consumes the token; promotion does (§6b).

EXIT CODES
  0 GO                  3 the run faulted, or its persisted result is unreadable
  1 NO_GO               4 the run was refused (§11 / TM-3)
  2 usage, or no such run
  5 INCONCLUSIVE, or no persisted result yet (in flight, or died before
    persisting) — nothing is re-run to find out (QA-9)
`;

const CLEANUP_HELP = `tess cleanup — tear down a failed or abandoned run

USAGE
  tess cleanup --run-id <id> [--runner <profile>] [--mode plan|apply] [options]
  tess cleanup --legacy [--runner <profile>] [--run-id <id>]... [--json]
  tess cleanup --legacy --mode apply --report <file> --confirm <sys_id,...>
               [--runner <profile>] [--allow <host>] [--prod <host>]

WHAT IT DOES
  Deletes every ATF suite, test, step and step input named "<run-id>:…" on the
  runner, in the DEV-13 order, keeping suite RESULTS (QA-17); then settles the
  run's ledger entries and moves it failed/abandoned -> tearing-down -> done
  (§4b). Idempotent: a second cleanup is a no-op. A run with no local record
  is swept by namespace only — and only if the id is one Tessera mints
  (run-YYYYMMDDtHHMMSS-xxxxxxxx) or --confirm-unrecorded repeats it.

  --mode plan (the default) reads the local ledger and prints what apply would
  do; it contacts no instance and writes nothing. --mode apply classifies the
  runner (§11) and deletes.

  A run that is not terminal locally (it may still have a live owner) is
  REFUSED, as is one whose suite result is still running on the instance
  (DEV-17), a persistent run (§4a), and any namespaced row that lacks this
  run's ownership marker — nothing is deleted.

  --run-id <id>              The run. Required.
  --runner <profile>         Where it was projected. Default: "default".
  --confirm-unrecorded <id>  Sweep a run with no local record whose id Tessera
                             did not mint. Must repeat --run-id exactly.
  --allow <host> / --prod <host> / --acknowledge-prod <why> / --actor <name>
                             §11, as for \`tess run\`.
  --ledger-root <dir>        Default: <cwd>/.tessera.
  --json                     Machine-readable outcome on stdout.

LEGACY ROWS (--legacy)
  Rows written before the ownership marker existed are refused by the cleanup
  above and never deleted by it. --legacy finds and deletes them by sys_id:

  --mode plan (the default) issues GETs only and runs no §11 guard: it lists
  every ATF test and suite named "<run-id>:…" (a Tessera-minted run id, or one
  given with --run-id) whose description carries no ownership marker, with its
  steps, suite links, suite results and BLOCKED reasons, and the conflicting
  rows that carry another run's marker. --json prints the report itself; save
  it, review it, and pass it to apply.

  --mode apply classifies the runner (§11; a production runner is refused, and
  --acknowledge-prod is not accepted), re-reads every confirmed row fresh and
  deletes only the confirmed ones — refusing the whole call, before any DELETE,
  if a row changed, is not in the report, has an empty description, is linked
  into a suite you did not confirm, or has a non-terminal suite result.

  --legacy                   Switch to the legacy sweep.
  --run-id <id>              Plan only, repeatable: an explicit run id to scan
                             besides the minted ones.
  --report <file>            Apply only: a report saved from --legacy --json.
  --confirm <sys_id,...>     Apply only: the report candidates to delete.
  --allow <host> / --prod <host>
                             §11, as for \`tess run\` (apply only).

EXIT CODES
  0 torn down, or planned   3 teardown fault (the run is left failed; re-run)
  2 usage                   4 §11, DEV-17, unrecorded-namespace, ownership or
                              legacy refusal — nothing was deleted
`;

const BENCHMARK_HELP = `tess benchmark — the S5 OutcomeGate (§13)

USAGE
  tess benchmark --catalog <file> --gen-config <file> --scope <app scope>
                 --run-id <id> [--runner <profile>] [options]
  tess benchmark --restore <run-id> [--runner <profile>] [--ignore-live-pid]
                 [--allow/--prod/--acknowledge-prod/--actor]
                 [--ledger-root <dir>] [--docs-dir <dir>] [--json]

WHAT IT DOES
  Loads a HAND-AUTHORED mutant catalog (§13.4) and scores it on 95% Wilson
  bounds: kill-rate lower bound, false-green upper bound, per-category catch
  floor and caught-set determinism over k repetitions (§13.1). Each rep
  generates the suite once from the correct source, then runs it against every
  mutant and baseline on the runner. Prints the S5 record (§13.2).

  Inputs are validated before any instance is touched: a catalog the loader
  refuses (no sign-off, a category under its floor, a diff hash mismatch) is a
  refusal — exit 4, nothing staged, nothing written. The runner is classified
  (§11) and must be writable before any adapter is built: a benchmark rewrites
  the source of every target in its scope.

  --catalog <file>           The catalog JSON. Required; there is no default.
  --gen-config <file>        Pinned generation config JSON: modelId,
                             temperature, maxTokens, promptHash, promptVersion
                             (§12.3). Required. A promptHash that is not this
                             build's unit instructionHash is refused (exit 4).
  --provider template|anthropic
                             Default: template. anthropic reads its key from
                             TESSERA_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY.
  --repetitions <k>          Default and minimum: the §13.1 minimum.
  --scope <app scope>        Impact analysis scope. Required.
  --run-id <id>              Namespaces every staged spec and the lease.
                             Required.
  --runner <profile>         Default: "default". --source defaults to it.
  --tests-root <dir>         Default: <ledger-root>/benchmark/<run-id>/tests.
  --allow <host> / --prod <host> / --acknowledge-prod <why> / --actor <name>
                             §11, as for \`tess run\`.
  --ledger-root <dir>        Default: <cwd>/.tessera.
  --docs-dir <dir>           DEV-15 write-journal root (sets $SN_DOCS_DIR).
  --out <file>               Also write the JSON document to this file.
  --json                     Machine-readable document on stdout.

RESTORE JOURNAL
  Before an artifact's source is first rewritten, its correct source is made
  durable in <ledger-root>/benchmark/<run-id>/restore-journal.json; the file is
  removed only after the final restore is verified. A run refuses to start
  (exit 4) while an unrestored journal exists for its run id, for any artifact
  its catalog touches, or that cannot be read. It also refuses to capture a
  live source equal to one of the catalog's mutant or detonator texts (or not
  matching an entry's optional correctSha256).

  SIGINT/SIGTERM abort the run and the final restore still runs. A second
  signal is acknowledged and ignored — it does not skip the restore. Only
  SIGKILL can; then the journal stays for --restore. An artifact the final
  restore could not put back (3 attempts) is named on stderr and under
  "unrestored" in the JSON document, its journal is kept, and the exit is 3.

  --restore <run-id>         Write the journaled sources back to the runner,
                             verify them, remove the journal and release the
                             crashed run's own lease row. The runner (default:
                             the journal's profile) must be the journal's
                             instance and pass §11. Refuses (4) a corrupt
                             journal or one whose writer may still be running.
                             If the lease cannot be released, delete the
                             u_benchmark_lease row(s) whose holder is the
                             run id by hand.
  --ignore-live-pid          With --restore: proceed although the journal's
                             writer pid is alive or on another host.

EXIT CODES
  0 GO on a real catalog     3 infrastructure fault, or an artifact left
                               unrestored
  1 MISS (measured, below)   4 §11 refusal, a catalog that will not be scored,
                               or a pending restore journal
  2 usage                    5 VOID (a substrate control went red — never a
                               miss), or GO on a FIXTURE catalog, whose
                               finding is forced to open
  --restore: 0 restored · 2 no such journal · 3 still unrestored / lease not
  released · 4 refused
`;

export function commandHelp(command: CommandName): string {
  switch (command) {
    case "preflight":
      return PREFLIGHT_HELP;
    case "resolve":
      return RESOLVE_HELP;
    case "impact":
      return IMPACT_HELP;
    case "coverage":
      return COVERAGE_HELP;
    case "generate":
      return GENERATE_HELP;
    case "doctor":
      return DOCTOR_HELP;
    case "run":
      return RUN_HELP;
    case "status":
      return STATUS_HELP;
    case "confirm":
      return CONFIRM_HELP;
    case "cleanup":
      return CLEANUP_HELP;
    case "benchmark":
      return BENCHMARK_HELP;
  }
}
