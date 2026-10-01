// §2a role binding — the only place the CLI decides WHICH instance a read or a
// write lands on.
//
// ARCH-7/18: Tessera owns no credential store. The vendored transport resolves
// an instance, its auth and its host policy from a NAMED PROFILE
// (`SN_PROFILE_<NAME>_INSTANCE/_USER/_PASSWORD`; the legacy
// `SN_INSTANCE/SN_USER/SN_PASSWORD` triple is the `default` profile). So a
// Phase-1 role value IS a profile name, not a bare host — that is what makes a
// split topology executable at all. `--source prod_ro --runner dev` has two sets
// of credentials behind it; `--source https://a --runner https://b` would have
// one set and no way to say which host it belongs to.
//
// A value that is not a profile is therefore REFUSED rather than probed with
// whatever credentials happen to be active. Silently reading the wrong instance
// is the ARCH-8 failure mode this whole layer exists to prevent, and a run that
// compared a host against itself under one credential set would report a
// perfectly green parity that means nothing.
//
// Every adapter below is bound by wrapping it in `runWithProfile`, the same
// mechanism `@tessera/parity`'s reader already uses. The transport reads the
// profile from an AsyncLocalStorage at call time, so the binding survives the
// await chain without any signature threading it.

import { REDACTED, hasUrlUserinfo, secretValueShape } from "@tessera/config";
import { PRODUCTION_PROPERTY } from "@tessera/doctor";
import type { InstanceProbe } from "@tessera/doctor";
import type {
  InstanceProbe as GuardProbeResult,
  InstanceRef,
  InstanceRole,
  ProbeFn,
} from "@tessera/guard";
import { normalizeInstanceHost } from "@tessera/guard";
import type { InstanceWriter } from "@tessera/provisioner";
import type {
  AtfHttpClient,
  AtfRequest,
  AtfResponse,
} from "@tessera/runner-atf";
import type {
  TestStoreHttpClient,
  TestStoreRequest,
  TestStoreResponse,
} from "@tessera/teststore-atf";
import {
  assertValidProfileName,
  getCredentials,
  runWithProfile,
} from "@tessera/sn-client";
import {
  ATF_RUNNER_ENABLED_PROPERTY,
  ATF_RUNNER_SAFE_DIRECTION,
  decidePropertyRows,
  normalisePropertyValue,
  PRODUCTION_SAFE_DIRECTION,
  readsSafeDirection,
  type PropertySafeDirection,
} from "@tessera/types";

/**
 * §11.2 production marker. `@tessera/phase05` carries its own copy for the
 * Phase-0.5 probe and that copy dies with the package; this is the one the
 * Phase-1 preflight probe reads.
 *
 * Delegated decision 2026-09-26: re-exported from `@tessera/doctor` instead of
 * spelled out here. The doctor's probe resolves differing duplicate rows toward
 * "production" only for this exact name, so a second copy that drifted would
 * make `readBoolean` below read a property the doctor treats as ordinary. The
 * CLI already depends on the doctor; no dependency was added.
 */
export { PRODUCTION_PROPERTY };

/**
 * DR-3 runner capability property — the guard treats it as a §11.2 signal.
 *
 * Delegated decision 2026-10-01 (wave 17): re-exported from `@tessera/types`
 * (`ATF_RUNNER_ENABLED_PROPERTY`) under the CLI's existing public name instead
 * of spelled out here, so the doctor, the guard's wording and this probe read
 * one name. The CLI already depended on `@tessera/types`; nothing was added.
 */
export { ATF_RUNNER_ENABLED_PROPERTY as ATF_RUNNER_PROPERTY };

/** A role, the profile it was bound to, and the host that profile resolves to. */
export interface RoleBinding {
  readonly role: InstanceRole;
  readonly profile: string;
  readonly ref: InstanceRef;
}

/** A role value the credential store cannot turn into an instance. */
export class TopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopologyError";
  }
}

/**
 * Resolve one role. Throws `TopologyError` with the env keys spelled out — the
 * operator's next action is to set them, so the message names them.
 */
export function bindRole(role: InstanceRole, value: string): RoleBinding {
  const profile = value.trim().toLowerCase();
  try {
    assertValidProfileName(profile);
  } catch {
    throw new TopologyError(
      `--${role} expects a credential-store PROFILE name, not a host (got ${shown(value)}). ` +
        `Phase 1 binds each §2a role to a profile so a split topology carries its own credentials (ARCH-7/18); ` +
        `define one with SN_PROFILE_<NAME>_INSTANCE/_USER/_PASSWORD, or use "default" for the SN_INSTANCE triple.`,
    );
  }
  const host = getCredentials(profile).instance.trim();
  if (host === "") {
    throw new TopologyError(
      `--${role} names the profile "${profile}", but it has no instance: set ${envKey(profile)} (and the matching _USER/_PASSWORD).`,
    );
  }
  return { role, profile, ref: { name: profile, host } };
}

/**
 * The refused value as the operator may see it.
 *
 * Delegated decision 2026-09-26 (review W5b, A): the refusal used to echo
 * `JSON.stringify(value)`, so `--runner https://admin:pw@h` printed the
 * password on stderr (and into any CI log capturing it). A value that fails a
 * secret check — URL userinfo in any WHATWG spelling, or a secret-shaped value —
 * is now replaced by `<redacted>`; any other value is still echoed, because
 * seeing the typo is the operator's fastest way to fix it.
 */
function shown(value: string): string {
  if (hasUrlUserinfo(value) || secretValueShape(value) !== undefined) {
    return `${REDACTED}: the value carries credentials and is not shown`;
  }
  return JSON.stringify(value);
}

function envKey(profile: string): string {
  return profile === "default"
    ? "SN_INSTANCE"
    : `SN_PROFILE_${profile.toUpperCase()}_INSTANCE`;
}

/** Bind every read of a doctor probe to one profile. */
export function bindProbe(
  probe: InstanceProbe,
  profile: string,
): InstanceProbe {
  return {
    readProperty: (name, signal) =>
      runWithProfile(profile, () => probe.readProperty(name, signal)),
    readTable: (table, signal) =>
      runWithProfile(profile, () => probe.readTable(table, signal)),
    reachApi: (path, signal) =>
      runWithProfile(profile, () => probe.reachApi(path, signal)),
  };
}

/**
 * Bind every write to one profile. ARCH-8: the caller must only ever pass the
 * RUNNER's profile here, and `assertRunnerWritable` has already run by then.
 */
export function bindWriter(
  writer: InstanceWriter,
  profile: string,
): InstanceWriter {
  return {
    updateRecord: (table, sysId, fields) =>
      runWithProfile(profile, () => writer.updateRecord(table, sysId, fields)),
  };
}

/**
 * Bind every ATF request to one profile.
 *
 * The doctor's probe and the provisioner's writer are bound above because they
 * arrive unbound; `createSnAtfClient()` is the third of exactly that kind and
 * had no wrapper until the run loop needed one. It reaches the transport
 * directly, so without this it would inherit whichever profile happened to be
 * on the AsyncLocalStorage at call time — which, in a split topology, is the
 * SOURCE for most of a run. Triggering a suite there is the ARCH-8 failure this
 * module exists to prevent, and ARCH-19 is unambiguous that execution belongs
 * to the runner.
 *
 * `request` is written as a method rather than an arrow property so its type
 * parameter survives the wrapping: an arrow would erase `<T>` and every caller
 * would get `AtfResponse<unknown>` back.
 */
export function bindAtfClient(
  client: AtfHttpClient,
  profile: string,
): AtfHttpClient {
  return {
    request<T>(args: AtfRequest): Promise<AtfResponse<T>> {
      return runWithProfile(profile, () => client.request<T>(args));
    },
  };
}

/**
 * Bind every ATF TestStore request to one profile — the fourth unbound
 * adapter, for the same reason as `bindAtfClient`: `createSnTestStoreClient()`
 * reaches the transport directly, and the projection writes (§4b) belong to the
 * RUNNER alone (ARCH-8/ARCH-19). Written as a method so `<T>` survives.
 */
export function bindTestStoreClient(
  client: TestStoreHttpClient,
  profile: string,
): TestStoreHttpClient {
  return {
    request<T>(args: TestStoreRequest): Promise<TestStoreResponse<T>> {
      return runWithProfile(profile, () => client.request<T>(args));
    },
  };
}

/** One instance the §11.2 guard probe is allowed to ask about. */
export interface ProbeTarget {
  readonly ref: InstanceRef;
  readonly probe: InstanceProbe;
}

/**
 * The §11.2 read-only guard probe, over the doctor's port.
 *
 * OPP-1(b) is the reason every non-`found` outcome becomes an `unreachable`
 * note rather than `false`: the Table API renders a genuinely-unset property
 * and an ACL-trimmed one identically, so "no row" is not evidence that this is
 * not production. The guard already treats an unreadable probe as a warning and
 * never as a clearance — feeding it a fabricated `false` would turn a blind
 * spot into a green light.
 *
 * A `found` row is the opposite case and is NOT left to the guard: a value this
 * module cannot interpret resolves to whichever reading downgrades, so it
 * refuses rather than warns. See `readBoolean`.
 */
export function createGuardProbe(targets: readonly ProbeTarget[]): ProbeFn {
  const byHost = new Map<string, InstanceProbe>();
  for (const target of targets) {
    const host = normalizeInstanceHost(target.ref.host);
    if (host !== undefined) byHost.set(host, target.probe);
  }

  return async (ref: InstanceRef): Promise<GuardProbeResult> => {
    const host = normalizeInstanceHost(ref.host);
    const probe = host === undefined ? undefined : byHost.get(host);
    if (probe === undefined) {
      return {
        unreachable: [
          `no bound probe for ${ref.host} — the §11.2 properties were not read`,
        ],
      };
    }

    const unreachable: string[] = [];
    const [production, runner] = await Promise.all([
      readBoolean(probe, PRODUCTION_PROPERTY, unreachable, {
        direction: PRODUCTION_SAFE_DIRECTION,
        downgradesAs: true,
      }),
      readBoolean(probe, ATF_RUNNER_ENABLED_PROPERTY, unreachable, {
        direction: ATF_RUNNER_SAFE_DIRECTION,
        downgradesAs: false,
      }),
    ]);

    // Delegated decision 2026-10-01 (wave 17): the fail-closed boolean still
    // travels beside a raised `*Uninterpretable` flag. The guard replaces the
    // boolean's signal with the flag's own downgrade, so the boolean changes
    // nothing there — but a consumer that predates the flags (or ignores
    // them) keeps downgrading on it rather than seeing no boolean at all.
    return {
      ...(production.value === undefined
        ? {}
        : { productionProperty: production.value }),
      ...(production.uninterpretable
        ? { productionPropertyUninterpretable: true }
        : {}),
      ...(runner.value === undefined ? {} : { atfRunnerEnabled: runner.value }),
      ...(runner.uninterpretable
        ? { atfRunnerEnabledUninterpretable: true }
        : {}),
      ...(unreachable.length === 0 ? {} : { unreachable }),
    };
  };
}

/** Which way a §11.2 property fails closed, and the boolean that way reads as. */
interface Truthiness {
  /**
   * The property's safe direction from `@tessera/types` — the ONE normalised
   * value that licenses the unsafe reading (`false` for the production flag,
   * `true` for the ATF runner) and the value that states the safe one.
   */
  readonly direction: PropertySafeDirection;
  /**
   * `true` for `glide.installation.production` (the guard downgrades on
   * `=== true`), `false` for `sn_atf.runner.enabled` (it downgrades on
   * `=== false`): the boolean the SAFE direction reads as. The two point in
   * opposite directions, so the property has to name it.
   */
  readonly downgradesAs: boolean;
}

/**
 * What `readBoolean` read: the fail-closed boolean (absent = no boolean
 * arrived) and whether the value behind it was one it had to interpret.
 */
interface BooleanReading {
  readonly value: boolean | undefined;
  /**
   * Set when a FOUND value whose rows agree was neither the canonical nor the
   * licensing value, so `value` is the safe direction by interpretation, not
   * what the row says. `createGuardProbe` hands it to the guard as the
   * property's `*Uninterpretable` flag.
   */
  readonly uninterpretable?: true;
}

/**
 * Read one §11.2 property as a boolean, fail closed.
 *
 * Delegated decision 2026-09-30 (wave 16): the reading is `@tessera/types`'
 * `decidePropertyRows` under the property's safe direction — the rule
 * `@tessera/doctor` and `@tessera/phase05` apply — instead of a local copy of
 * the doctor's old `{"true","1","yes"}` truthiness set, which had drifted from
 * it: the doctor now reads only `true` as an enabled runner, and this probe
 * still read `1`/`yes` as enabled. So:
 *
 *  * production: only an exact (trimmed, case-folded) `false` reads `false`;
 *    every other value, differing rows included, reads `true` (production);
 *  * runner: only an exact `true` reads `true`; every other value, and rows
 *    that differ, read `false` (not enabled) — which the guard downgrades on;
 *  * an incomplete read the doctor could not settle arrives `undecidable`,
 *    `incomplete`, with the rows it DID see; a seen row in the safe direction
 *    settles it (no unseen row can make it less safe), and otherwise — only
 *    licensing rows seen, or no rows at all — it stays undecidable: no
 *    boolean, a warning (OPP-1(b) below).
 *
 * The rows are re-decided here whenever the doctor's read carries them, so a
 * `found` winner cannot clear rows that differ, and a runner read the doctor
 * left `undecidable` for differing rows (it gives the runner no direction of
 * its own) is settled in the runner's safe direction. A found value that is
 * neither the licensing nor the canonical value still reads safe, is flagged
 * `uninterpretable`, and carries a note that says so.
 *
 * A non-`found` outcome with nothing to settle resolves to `undefined` —
 * OPP-1(b): nothing usable was read, so there is no value to fail closed ON,
 * and the guard's warning is the honest outcome.
 */
async function readBoolean(
  probe: InstanceProbe,
  name: string,
  unreachable: string[],
  truthiness: Truthiness,
): Promise<BooleanReading> {
  const read = await probe.readProperty(name);
  // Delegated decision 2026-10-01 (wave 17): an `undecidable` read is
  // settleable from its rows when the doctor says why it could not decide —
  // rows that differ, or a read that was incomplete. Any other undecidable
  // read (a stray row name, say) is not re-read here, rows or not.
  const incomplete = read.outcome === "undecidable" && read.incomplete === true;
  const settleable =
    read.outcome === "undecidable" &&
    read.rows !== undefined &&
    read.rows.length > 0 &&
    (read.duplicates === "differing" || incomplete);
  if (read.outcome !== "found" && !settleable) {
    unreachable.push(`${name}: ${read.detail}`);
    return { value: undefined };
  }
  const values = (
    read.rows !== undefined && read.rows.length > 0
      ? read.rows.map((row) => row.value)
      : [read.value ?? ""]
  ).map(normalisePropertyValue);
  // A `found` read is decided as complete even when the doctor marked it
  // `incomplete`: the doctor only returns `found` from an incomplete read
  // when a seen row already reads the production direction, the safe one.
  const decision = decidePropertyRows(
    values,
    !incomplete,
    truthiness.direction,
  );
  const safe = truthiness.downgradesAs;
  if (decision.kind === "agreed" && read.outcome === "found") {
    const value = values[0] ?? "";
    if (!readsSafeDirection(value, truthiness.direction)) {
      return { value: !safe };
    }
    if (value === truthiness.direction.canonical) return { value: safe };
    // The guard downgrades on the `*Uninterpretable` flag under a kind of its
    // own instead of the boolean's ("reads false", which this row does not
    // hold). The note still travels: it says WHAT could not be interpreted
    // (an empty row, or some other value — its shape, never the value).
    unreachable.push(
      `${name}: found, but ${describeUnusable(value, truthiness.direction)} — ` +
        `read as ${String(safe)} (fail closed), which downgrades this instance`,
    );
    return { value: safe, uninterpretable: true };
  }
  if (decision.kind === "safe") {
    // Delegated decision 2026-10-01 (wave 17): rows settled in the safe
    // direction — differing rows, or an incomplete read that saw a safe row —
    // are NOT flagged uninterpretable, even when the row that settled them is
    // non-canonical. They were settled deterministically by the property's
    // direction, and the note below says how; the guard's boolean signal
    // ("reads false"/"reads true") is the direction they were settled in.
    unreachable.push(
      incomplete
        ? `${name}: an incomplete read saw a row reading in the safe ` +
            `direction — read as ${String(safe)} (fail closed), which ` +
            `downgrades this instance`
        : `${name}: ${values.length} rows with differing values — read as ` +
            `${String(safe)} (fail closed), which downgrades this instance`,
    );
    return { value: safe };
  }
  // Rows the doctor called differing that nevertheless agree once normalised,
  // an incomplete read that saw only the licensing value, or none at all:
  // nothing here settles them, and an undecidable read never becomes the
  // licensing reading. The guard gets no boolean — a warning.
  unreachable.push(`${name}: ${read.detail}`);
  return { value: undefined };
}

/**
 * The SHAPE of a value the safe direction does not name — never the value.
 * `sys_properties` holds instance-authored text and this string is handed to
 * `@tessera/guard` verbatim, which prints it in a refusal report;
 * `heuristics.ts`'s own `shapeOf` makes the same trade for the same reason.
 * The value is not lost to the operator — `tess doctor` reports the property
 * as `name=value` on a channel that is not a guard message.
 */
function describeUnusable(
  value: string,
  direction: PropertySafeDirection,
): string {
  return value === ""
    ? "the row is empty"
    : `the value is neither "${direction.canonical}" nor "${direction.licensing}"`;
}
