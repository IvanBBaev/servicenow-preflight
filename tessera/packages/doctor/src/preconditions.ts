// The precondition catalogue (DESIGN §12.3, PLAN Phase 1).
//
// Two rules govern everything here:
//
//  1. A precondition that this phase cannot probe is DECLARED and marked
//     `deferredTo`, never omitted. An absent control is an unowned control;
//     PLAN Phase 0.5 refused that once already and the same refusal applies to
//     readiness. A deferred precondition is visible in every report and is left
//     out of the roll-up only while no request needs it.
//
//  2. Nothing here is imported from the frozen Phase-0.5 package. Its ATF
//     table and property names are a walking-skeleton snapshot that Phases 2–8
//     replace wholesale, so Phase-1 readiness code that leaned on them would
//     be pinned to something designed to be thrown away. `@tessera/phase05`
//     keeps its own copies of the tables; the names below are re-declared
//     from the same spike provenance ([S0] SPIKE-FINDINGS Spike 0,
//     [DR-1]/[DR-3] design rulings), and the duplication is the point.
//
//     Delegated decision 2026-10-01 (wave 17): the one exception is the DR-3
//     runner property NAME, which is declared in `@tessera/types` (the shared
//     base both packages already depend on, not the Phase-0.5 package) beside
//     `SYS_PROPERTIES_TABLE` and its safe direction. A property name that two
//     readers spell differently is a property one of them reads and the other
//     does not — the drift this rule's duplication was never meant to allow.

import {
  ATF_RUNNER_ENABLED_PROPERTY,
  type ProvisionAction,
} from "@tessera/types";

import {
  SYS_PROPERTIES_TABLE,
  type AccessProbe,
  type InstanceProbe,
  type PropertyProbe,
} from "./probe.js";
import type { DoctorFinding, Precondition } from "./types.js";

/** [DR-3] must be `true` or ATF silently refuses to execute anything. */
export { ATF_RUNNER_ENABLED_PROPERTY };

/** [S0/DR-1] the tables the projection writes and the attribution reads. */
export const ATF_AUTHORING_TABLES = [
  "sys_atf_test",
  "sys_atf_step",
  "sys_atf_test_suite",
  "sys_atf_test_suite_test",
  "sys_atf_test_result",
] as const;

/**
 * [S0/DEV-8/DR-2] the only run endpoint there is. Probed with an all-zero
 * sys_id: a GET that can never match a real execution, so the instance answers
 * about the *namespace* rather than about anybody's run. Read-only by
 * construction — the doctor never POSTs to `testsuite/run`.
 */
export const CICD_PROBE_PATH =
  "/api/sn_cicd/progress/00000000000000000000000000000000";

export const PRECONDITION_IDS = {
  atfRunnerEnabled: ATF_RUNNER_ENABLED_PROPERTY,
  cicdApi: "sn_cicd.api",
  atfTables: "sn_atf.tables.readable",
  browserTestRunner: "sn_atf.browser.test-runner",
  harnessScopedApp: "tessera.harness.scoped-app",
  authoringChannel: "tessera.authoring-channel",
} as const;

type Probed = Omit<DoctorFinding, "applicability">;

/**
 * The remedy `Provisioner.plan()` would emit for a runner property this run
 * READ and found false. There is an observed row behind this one, so
 * `enableAtfRunnerRecipe` can turn it into a precise update against that row's
 * sys_id — which is what makes `kind: "update"` a claim and not a guess.
 */
const ENABLE_RUNNER_ACTION: ProvisionAction = {
  kind: "update",
  table: SYS_PROPERTIES_TABLE,
  description: `${ATF_RUNNER_ENABLED_PROPERTY} must be true before ATF will execute anything (DR-3)`,
};

/**
 * The same property when NO row for it was readable — and deliberately not the
 * action above.
 *
 * `ENABLE_RUNNER_ACTION` names a write the provisioner will actually perform.
 * Here nothing was observed to update: an empty result set is a genuinely unset
 * property OR an ACL-trimmed one, the Table API renders the two identically
 * (OPP-1b), and they want opposite writes — create the row, or update a row
 * this run cannot see. `enableAtfRunnerRecipe` answers `blocked` for exactly
 * this state rather than pick one. An operator handed the plain "update
 * sys_properties" line would go hunting for a row that may not exist, or may
 * exist and be invisible to them, and would find nothing either way.
 *
 * So the description holds under BOTH readings instead of picking the one it
 * cannot prove — the same move `@tessera/resolvers` makes on its 403 detail —
 * and it says outright that no plan will perform this, because the doctor's
 * remedy pointer is advisory and `recipes.ts` says so from the other side.
 */
const UNREADABLE_RUNNER_ROW_ACTION: ProvisionAction = {
  kind: "update",
  table: SYS_PROPERTIES_TABLE,
  description:
    `no ${SYS_PROPERTIES_TABLE} row for ${ATF_RUNNER_ENABLED_PROPERTY} was ` +
    `readable on this run, so the "update" named to the left of this dash is ` +
    `not a write that will happen — setting the property means CREATING the ` +
    `row if it is genuinely unset, ` +
    `or UPDATING a row this run could not see if it is ACL-trimmed, and the ` +
    `Table API renders those identically. ATF executes nothing until it is ` +
    `true (DR-3); an admin with ${SYS_PROPERTIES_TABLE} access has to set it, ` +
    `and no plan from here will`,
};

/**
 * The row answered, and its identity did not.
 *
 * `readProperty` fills `sysId` only when the response carried one, and a
 * field-level ACL can trim `sys_id` off a row the caller may otherwise read —
 * so this is a live state, not a defensive one, and `enableAtfRunnerRecipe`
 * guards it explicitly ("there is no row to address"). The doctor must say the
 * same thing: `PropertyProbe.sysId`'s own contract is that "a remedy that wants
 * to change this property must address the row it actually observed — updating
 * by name would be a blind write against whatever matches at apply time", and
 * without a sys_id there is no row to address here either.
 */
const UNIDENTIFIED_RUNNER_ROW_ACTION: ProvisionAction = {
  kind: "update",
  table: SYS_PROPERTIES_TABLE,
  description:
    `${SYS_PROPERTIES_TABLE} answered for ${ATF_RUNNER_ENABLED_PROPERTY} ` +
    `without a sys_id, so the "update" named to the left of this dash is not ` +
    `a write that will happen — the row exists and nothing here can address ` +
    `it, and a write matched on ` +
    `name alone would land on whatever matches at apply time. ATF executes ` +
    `nothing until the property is true (DR-3); this needs someone who can ` +
    `read ${SYS_PROPERTIES_TABLE}.sys_id, and no plan from here will`,
};

/**
 * More than one `sys_properties` row answered for the runner property.
 *
 * Delegated decision 2026-09-26: no single-row update is a remedy here. With
 * disagreeing rows, which one ATF honours is not knowable from a Table API
 * read; with agreeing `false` rows, patching one of them manufactures exactly
 * that disagreement. `enableAtfRunnerRecipe` blocks on both, and this
 * description says so rather than advertise a write that will not happen.
 */
const DUPLICATE_RUNNER_ROWS_ACTION: ProvisionAction = {
  kind: "update",
  table: SYS_PROPERTIES_TABLE,
  description:
    `${SYS_PROPERTIES_TABLE} holds more than one row named ` +
    `${ATF_RUNNER_ENABLED_PROPERTY}, so the "update" named to the left of ` +
    `this dash is not a write that will happen — an admin has to remove the ` +
    `duplicate rows and leave one row reading true (DR-3); updating a single ` +
    `row would only leave the duplicates disagreeing, and no plan from here will`,
};

/**
 * Which remedy a `found` row has earned. A remedy naming an update is a claim
 * that there is a row to update, and only an observed sys_id makes it one —
 * and only when that row is the ONLY row for the name.
 */
function foundRemedy(read: PropertyProbe): ProvisionAction {
  if (read.duplicates !== undefined) return DUPLICATE_RUNNER_ROWS_ACTION;
  return read.sysId === undefined
    ? UNIDENTIFIED_RUNNER_ROW_ACTION
    : ENABLE_RUNNER_ACTION;
}

/**
 * Delegated decision 2026-09-25: the property is read the way ServiceNow reads
 * a boolean property — only the (trimmed, lower-cased) string `true` enables
 * it. `false`, or an empty value (an unset row, which ATF treats as disabled
 * exactly like an absent one), is `not-ready` with a remedy. Any other value
 * (`yes`, `1`, `on`, …) is `unknown`: it is a malformed value, and this probe
 * will neither promote it to `ready` (the old `{"true","1","yes"}` set did,
 * while `@tessera/phase05` read the same row as disabled) nor claim to know
 * what the instance makes of it. Both outcomes block — fail closed.
 */
const ENABLED_VALUE = "true";
const DISABLED_VALUES: ReadonlySet<string> = new Set(["false", ""]);

/**
 * DR-3. Note what happens when the row is unreadable: the Table API renders a
 * genuinely unset property and an ACL-trimmed one identically, so the evidence
 * below is worded to hold under both readings. It resolves `not-ready` rather
 * than `unknown` because in BOTH readings this run cannot rely on ATF
 * executing, and unlike `unknown` there is something concrete to do about it.
 * Both statuses block the gate either way — the distinction is diagnostic.
 */
export function atfRunnerEnabledPrecondition(
  probe: InstanceProbe,
): Precondition {
  return {
    id: PRECONDITION_IDS.atfRunnerEnabled,
    async probe(signal): Promise<Probed> {
      const read = await probe.readProperty(
        ATF_RUNNER_ENABLED_PROPERTY,
        signal,
      );
      const precondition = PRECONDITION_IDS.atfRunnerEnabled;
      if (read.outcome === "found") {
        const value = (read.value ?? "").trim().toLowerCase();
        if (value === ENABLED_VALUE) {
          return { precondition, status: "ready", evidence: read.detail };
        }
        if (DISABLED_VALUES.has(value)) {
          return {
            precondition,
            status: "not-ready",
            evidence: `${read.detail} — ATF will accept a run request and execute nothing`,
            remedy: { action: foundRemedy(read) },
          };
        }
        return {
          precondition,
          status: "unknown",
          evidence: `could not decide: ${read.detail} is neither "true" nor "false", so whether ATF will execute is not something this probe can state`,
        };
      }
      if (read.duplicates === "differing") {
        // Delegated decision 2026-09-26: disagreeing duplicate rows are
        // `not-ready`, not `unknown` — whichever row ATF honours, this run
        // cannot rely on it executing, and there is a concrete thing for an
        // admin to do (remove the duplicates). The evidence names every row.
        return {
          precondition,
          status: "not-ready",
          evidence: `${read.detail} — this run cannot rely on ATF executing until only one row remains`,
          remedy: { action: DUPLICATE_RUNNER_ROWS_ACTION },
        };
      }
      if (read.outcome === "absent") {
        return {
          precondition,
          status: "not-ready",
          evidence: `${read.detail} — either genuinely unset (ATF then defaults to disabled) or ACL-trimmed; under both readings this run cannot rely on ATF executing`,
          remedy: { action: UNREADABLE_RUNNER_ROW_ACTION },
        };
      }
      return {
        precondition,
        status: "unknown",
        evidence: `could not decide: ${read.detail}`,
      };
    },
  };
}

/**
 * The CI/CD API is the ONLY way Tessera triggers a suite ([S0/DEV-8/DR-2]), so
 * its absence is not a degraded mode — it is the end of the run. A record-level
 * 404 counts as present: the namespace answered.
 */
export function cicdApiPrecondition(probe: InstanceProbe): Precondition {
  return {
    id: PRECONDITION_IDS.cicdApi,
    async probe(signal): Promise<Probed> {
      const reach = await probe.reachApi(CICD_PROBE_PATH, signal);
      const precondition = PRECONDITION_IDS.cicdApi;
      switch (reach.outcome) {
        case "present":
          return { precondition, status: "ready", evidence: reach.detail };
        case "absent":
          // Not remediable by `Provisioner.plan()`: activating a plugin is not
          // a table write, and ARCH-33 forbids the run loop from installing
          // standing infrastructure regardless.
          return {
            precondition,
            status: "not-ready",
            evidence: `${reach.detail} — Tessera has no other way to trigger a suite (DR-2)`,
          };
        case "denied":
          return {
            precondition,
            status: "not-ready",
            evidence: `${reach.detail} — the connected user may not invoke the CI/CD API`,
          };
        default:
          return {
            precondition,
            status: "unknown",
            evidence: `could not decide: ${reach.detail}`,
          };
      }
    },
  };
}

/**
 * Read access to the ATF tables the projection touches.
 *
 * Honest about its own limit: a read-only probe cannot prove WRITE authority,
 * and this doctor is read-only on purpose (ARCH-8). So `ready` here means "the
 * user can see these tables", not "the projection will succeed" — the write
 * side is proven at plan/apply time on the single mutation channel (ARCH-3).
 * The evidence says so, because a green line that quietly means less than it
 * looks like is exactly the failure QA-9 exists to prevent.
 */
export function atfTablesPrecondition(probe: InstanceProbe): Precondition {
  return {
    id: PRECONDITION_IDS.atfTables,
    async probe(signal): Promise<Probed> {
      const precondition = PRECONDITION_IDS.atfTables;
      const results: { table: string; probe: AccessProbe }[] = [];
      for (const table of ATF_AUTHORING_TABLES) {
        results.push({ table, probe: await probe.readTable(table, signal) });
      }

      const undecidable = results.filter(
        (r) => r.probe.outcome === "undecidable",
      );
      // The two blocked outcomes are kept apart from here down, and between
      // them they are exactly the set one `blocked` filter used to hold:
      // `denied` and `absent` are disjoint members of one closed union, so
      // their two lengths sum to that filter's length for every input. The
      // verdict below is therefore the verdict it always was — what changes
      // is which question the evidence hands the operator.
      const denied = results.filter((r) => r.probe.outcome === "denied");
      const absent = results.filter((r) => r.probe.outcome === "absent");

      // Order matters: an undecided probe outranks a decided refusal, because
      // "some of these are unreadable" is a claim you cannot make while part of
      // the evidence is missing.
      if (undecidable.length > 0) {
        return {
          precondition,
          status: "unknown",
          evidence: `could not decide for ${undecidable.length} of ${results.length} table(s): ${detailList(undecidable)}`,
        };
      }
      if (denied.length + absent.length > 0) {
        return {
          precondition,
          status: "not-ready",
          evidence: blockedEvidence(denied, absent, results.length),
        };
      }
      return {
        precondition,
        status: "ready",
        evidence: `all ${results.length} ATF tables are readable (${ATF_AUTHORING_TABLES.join(", ")}); write authority is not provable by a read-only probe and is verified at apply time`,
      };
    },
  };
}

function detailList(rows: readonly { probe: AccessProbe }[]): string {
  return rows.map((r) => r.probe.detail).join("; ");
}

/**
 * The `not-ready` evidence, one named group per blocked population.
 *
 * These two outcomes carry the same verdict and are not the same problem. A
 * `denied` table answered 403: the instance resolved the URI and then refused
 * THIS caller, so the table is demonstrably there and a role or ACL grant is
 * the missing piece. An `absent` table answered a namespace 404: nothing
 * resolved at that URI, which `classifyTable` already words under both of ITS
 * readings — the table is not there at all, or this caller's scope and roles
 * cannot resolve it. Granting a read role on a table that is not exposed
 * changes nothing, so the install-and-scope question comes first there and
 * comes not at all in the group above. Merged, both populations were still
 * printed — but an operator had to re-derive the split out of the detail prose
 * before they knew which of the two questions they had been handed.
 *
 * A group with nothing in it is OMITTED, not printed empty. "read refused for
 * 0 table(s)" is evidence about nothing, and this string is the whole product
 * of a `not-ready` finding: `formatDoctorReport` prints it verbatim and
 * derives nothing new from it.
 *
 * Each group states its direction BEFORE its colon and its entries after it,
 * matching the `could not decide for N of M table(s): …` line above. The order
 * is not cosmetic: an `absent` detail already ends in an em-dash clause naming
 * its own two readings, so a group clause appended AFTER the list produced two
 * consecutive dashes and no way to tell which of them the second belonged to.
 *
 * The groups join on " | " rather than the "; " `detailList` puts between
 * ENTRIES, so the two nestings stay tellable apart inside one flat string.
 * Flat is a constraint and not a preference — `DoctorFinding.evidence` is
 * rendered as a single indented line both by `formatDoctorReport` here and by
 * `formatProvisionPlan` in `@tessera/provisioner`, and a newline would put the
 * second group at column zero in both.
 */
function blockedEvidence(
  denied: readonly { probe: AccessProbe }[],
  absent: readonly { probe: AccessProbe }[],
  total: number,
): string {
  const groups: string[] = [];
  if (denied.length > 0) {
    groups.push(
      `read refused for ${denied.length} of ${total} table(s) — the instance ` +
        `resolved the URI and refused this caller, so these want a role or ` +
        `ACL grant: ${detailList(denied)}`,
    );
  }
  if (absent.length > 0) {
    groups.push(
      `not a resource for ${absent.length} of ${total} table(s) — the URI ` +
        `resolved to no resource, so these want the plugin or this caller's ` +
        `scope checked before any role grant: ${detailList(absent)}`,
    );
  }
  return groups.join(" | ");
}

/**
 * A precondition this phase declares but cannot answer. It always resolves
 * `unknown` — which is inert while the request leaves it `deferred`, and
 * fail-closed the moment a request promotes it to `required`.
 */
function deferredPrecondition(
  id: string,
  phase: string,
  why: string,
  requiredForKinds: Precondition["requiredForKinds"],
): Precondition {
  return {
    id,
    ...(requiredForKinds === undefined ? {} : { requiredForKinds }),
    deferredTo: phase,
    probe(): Promise<Probed> {
      return Promise.resolve({
        precondition: id,
        status: "unknown",
        evidence: `no probe exists yet — ${why} (arrives in ${phase})`,
      });
    },
  };
}

/**
 * DEV-2: a `ui` request against a Test Runner Tessera cannot confirm is a HARD
 * preflight failure, not a run that hangs until the deadline. Declaring the
 * precondition as `requiredForKinds: ["ui"]` is what makes that automatic —
 * asking for `ui` promotes it to required, it resolves `unknown`, and the
 * fail-closed roll-up refuses the run.
 */
export function browserTestRunnerPrecondition(): Precondition {
  return deferredPrecondition(
    PRECONDITION_IDS.browserTestRunner,
    "Phase 8",
    "a browser Test Runner must be attached and polling before any `ui` step can execute (DEV-2)",
    ["ui"],
  );
}

/**
 * The harness scoped app — DESIGN §3 runner option B ("Self-hosted harness"),
 * kept by §3's decision item 3 only as an optional, dev-only adapter that is
 * explicitly off in prod. Never required by kind. (Cited as "§12.3" until
 * 2026-09-23; §12.3 is the Definition of Done, whose row 1 EXCLUDES
 * harness-app checks from the MVP — TODO "Three docs/ai claims" (b).)
 */
export function harnessScopedAppPrecondition(): Precondition {
  return deferredPrecondition(
    PRECONDITION_IDS.harnessScopedApp,
    "Phase 8",
    "the harness scoped application is not part of the MVP topology",
    [],
  );
}

/**
 * `sys_properties.name` of the W2 channel's version row (ADR-007 C4).
 * Re-declared from `@tessera/teststore-atf`'s `AUTHORING_CHANNEL_VERSION_PROPERTY`
 * under rule #2 above; a doctor test pins the two copies equal.
 */
export const AUTHORING_CHANNEL_VERSION_PROPERTY = "x_tessera.channel.version";

/** The channel MAJOR this Tessera speaks (teststore-atf's `AUTHORING_CHANNEL_VERSION`). */
export const AUTHORING_CHANNEL_REQUIRED_MAJOR = 1;

/**
 * ADR-007 C3: once promoted, the authoring channel is required for `unit`
 * runs — exactly as `browserTestRunnerPrecondition` declares `["ui"]`.
 */
export const AUTHORING_CHANNEL_C3_REQUIRED_KINDS: readonly ["unit"] = ["unit"];

/**
 * ADR-007 C3 switch — PROMOTED (delegated decision 2026-09-23). It lands
 * together with the composition root that actually projects through the
 * channel: `tess run --live` registers the ATF TestStore, so a `unit` run now
 * needs the channel installed and refuses without it rather than inventing a
 * degraded mode. Pass `{ promoted: false }` to get the old declared-and-
 * deferred row (tests; a rollback would flip this constant back).
 */
export const AUTHORING_CHANNEL_C3_PROMOTED = true;

export interface AuthoringChannelOptions {
  /** Override {@link AUTHORING_CHANNEL_C3_PROMOTED} (tests; the flip itself). */
  readonly promoted?: boolean;
}

const CHANNEL_RUNBOOK =
  "an admin imports @tessera/teststore-atf's assets/tessera-authoring-channel.update-set.xml " +
  "once and grants x_tessera.author to the Tessera user by hand — Tessera never " +
  "installs, upgrades or grants it (ADR-007 C2/C6)";

/**
 * The W2 authoring channel (ADR-007). It is what PROJECTS repo-authored specs
 * onto the instance — without it there is no projection and no `unit` run.
 *
 * Unpromoted (`{ promoted: false }`) it is a declared, deferred row.
 * Promoted (the default, {@link AUTHORING_CHANNEL_C3_PROMOTED}), it reads the
 * C4 version row: present with the required major is `ready` (a minor difference is
 * noted, not refused); absent, unparseable or a different major is
 * `not-ready`; a refused or failed read is `unknown`. All but `ready` block a
 * `unit` run, which is C3's "refuse; do not invent a degraded mode".
 */
export function authoringChannelPrecondition(
  probe?: InstanceProbe,
  options: AuthoringChannelOptions = {},
): Precondition {
  const promoted = options.promoted ?? AUTHORING_CHANNEL_C3_PROMOTED;
  const id = PRECONDITION_IDS.authoringChannel;
  if (!promoted) {
    return deferredPrecondition(
      id,
      "Phase 4",
      "the W2 authoring channel (ADR-007) projects specs onto the instance and a live `unit` run cannot start without it; its C3 promotion to required-for-unit lands with `tess run --live`",
      [],
    );
  }
  if (probe === undefined) {
    throw new TypeError(
      "authoringChannelPrecondition: a promoted (C3) precondition needs an InstanceProbe",
    );
  }
  return {
    id,
    requiredForKinds: AUTHORING_CHANNEL_C3_REQUIRED_KINDS,
    async probe(signal): Promise<Probed> {
      const read = await probe.readProperty(
        AUTHORING_CHANNEL_VERSION_PROPERTY,
        signal,
      );
      if (read.duplicates === "differing") {
        // Delegated decision 2026-09-26: disagreeing version rows are
        // `not-ready` — there is no one installed version to check against
        // ADR-007 C4, and refusing beats guessing by row order.
        return {
          precondition: id,
          status: "not-ready",
          evidence: `${read.detail} — refusing rather than guessing which W2 authoring channel version is installed (ADR-007 C4): ${CHANNEL_RUNBOOK}`,
        };
      }
      if (read.outcome === "absent") {
        return {
          precondition: id,
          status: "not-ready",
          evidence: `${read.detail} — the W2 authoring channel is not installed (or its version row is ACL-trimmed); nothing can be projected for a unit run: ${CHANNEL_RUNBOOK}`,
        };
      }
      if (read.outcome !== "found") {
        return {
          precondition: id,
          status: "unknown",
          evidence: `could not decide: ${read.detail}`,
        };
      }
      const value = (read.value ?? "").trim();
      const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
      if (!match) {
        return {
          precondition: id,
          status: "not-ready",
          evidence: `${AUTHORING_CHANNEL_VERSION_PROPERTY} reads "${value}", which is not MAJOR.MINOR[.PATCH] — refusing rather than guessing compatibility (ADR-007 C4)`,
        };
      }
      const major = Number(match[1]);
      if (major !== AUTHORING_CHANNEL_REQUIRED_MAJOR) {
        return {
          precondition: id,
          status: "not-ready",
          evidence: `the installed W2 authoring channel is version ${value}, this Tessera needs major ${AUTHORING_CHANNEL_REQUIRED_MAJOR} (ADR-007 C4): ${CHANNEL_RUNBOOK}`,
        };
      }
      return {
        precondition: id,
        status: "ready",
        evidence: `W2 authoring channel ${value} installed (${read.detail}); a minor difference from this Tessera's build only warns at projection time (C4). Membership of x_tessera.author is verified by the projection's own writes, not by this read`,
      };
    },
  };
}

/**
 * The MVP catalogue, in report order: what this phase can prove first, what it
 * has merely declared last.
 */
export function createDefaultPreconditions(
  probe: InstanceProbe,
): readonly Precondition[] {
  return [
    atfRunnerEnabledPrecondition(probe),
    cicdApiPrecondition(probe),
    atfTablesPrecondition(probe),
    browserTestRunnerPrecondition(),
    harnessScopedAppPrecondition(),
    authoringChannelPrecondition(probe),
  ];
}
