// §11.2 heuristics — read-only probes that can ONLY downgrade an allowlisted
// instance to `prod-suspect`. There is no code path here that returns a
// "clear" verdict: name patterns and properties are spoofable and drift across
// platform families, so only the explicit allowlist entry grants writability.

import {
  ATF_RUNNER_ENABLED_PROPERTY,
  PRODUCTION_PROPERTY,
} from "@tessera/types";

import type { GuardSignal, InstanceProbe } from "./types.js";

/**
 * Non-prod markers looked for, as whole tokens, in the FIRST host label (the
 * instance name).
 * Deliberately short and conservative — a marker that matches too eagerly
 * (e.g. "sit" inside "website") would suppress a downgrade, which is the
 * fail-open direction. Missing a real marker only costs a `prod-suspect`.
 */
const NON_PROD_MARKERS = [
  "dev",
  "test",
  "tst",
  "uat",
  "qa",
  "sandbox",
  "sbx",
  "staging",
  "stage",
  "stg",
  "demo",
  "poc",
  "train",
  "preprod",
  "pre-prod",
  "nonprod",
  "non-prod",
  "subprod",
  "sub-prod",
  "pdi",
] as const;

/** Vendor-issued domains; anything else is a vanity/customer URL (§11.2). */
const VENDOR_DOMAINS = [".service-now.com", ".servicenowservices.com"] as const;

/** sn-client's canonical instance suffix (core/host.ts SN_HOST_POLICY). */
const TRANSPORT_CANONICAL_SUFFIX = ".service-now.com";

/** Schemes whose authority the guard is willing to read. */
const READABLE_SCHEMES = new Set(["http", "https"]);

/**
 * sn-client resolveHost's host syntax (core/host.ts resolveHostWithPolicy),
 * applied after the canonical suffix: letters, digits, "." and "-" only, no
 * empty label, no leading "." or "-", no trailing ".".
 */
function isTransportHostSyntax(host: string): boolean {
  return (
    /^[a-z0-9.-]+$/.test(host) &&
    !host.includes("..") &&
    !host.startsWith(".") &&
    !host.startsWith("-") &&
    !host.endsWith(".")
  );
}

/**
 * Normalize a configured host to the string every comparison uses. Returns
 * `undefined` when the value cannot be read as a host — an unparseable
 * identity is NOT matched against the allowlist, so it falls through to
 * `unknown` (§11.1 fail closed).
 */
export function normalizeInstanceHost(raw: string): string | undefined {
  // Defensive: this package is consumed from plain JS too (tests, adapters).
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  // Delegated decision 2026-09-26: refuse, before any parsing, every character
  // on which two URL parsers are known to disagree or that smuggles a second
  // host into one string. Non-printable/non-ASCII (WHATWG strips tabs and
  // newlines, IDNA-maps Unicode), a backslash (WHATWG reads it as "/", a naive
  // parser as part of the host), "@" (userinfo: which side is the host?), "%"
  // (WHATWG percent-decodes the host) and "?"/"#" (query/fragment are never
  // part of an instance identity). The old parser read
  // "prod.service-now.com<backslash>@dev…" as dev, and so matched an allowlist
  // entry for what may be a prod instance.
  if (trimmed === "" || !/^[\x21-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  if (/[\\@%?#]/.test(trimmed)) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  // Delegated decision 2026-09-26: only http/https are read. The old parser
  // stripped ANY "scheme://", and "prod.service-now.com://dev.service-now.com"
  // is a valid scheme (RFC 3986 allows "." and "-") followed by an allowlisted
  // host. A value with no scheme is read as https, exactly as the transport
  // connects to it; any other "://" (including a leading "//") is refused.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(lowered);
  let rest = lowered;
  if (scheme) {
    if (!READABLE_SCHEMES.has(scheme[1] ?? "")) {
      return undefined;
    }
    rest = lowered.slice(scheme[0].length);
  } else if (lowered.includes("://") || lowered.startsWith("//")) {
    return undefined;
  }
  // Delegated decision 2026-09-26: a path is not part of an identity. Only a
  // bare trailing "/" is tolerated (a pasted origin); anything more is refused
  // rather than cut off, because what follows the cut is exactly where a
  // second host hides.
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  if (slash !== -1 && rest.slice(slash) !== "/") {
    return undefined;
  }
  const hostPort = /^([^:]*)(?::(\d{1,5}))?$/.exec(authority);
  if (!hostPort) {
    return undefined; // an empty, non-numeric or repeated port, or IPv6
  }
  const port = hostPort[2];
  // Delegated decision 2026-09-26: a trailing dot (the DNS root) is refused,
  // not stripped. It names the same host in DNS, but sn-client's resolveHost
  // refuses it, and the guard must never accept a host the transport refuses
  // (stricter side wins). Returning undefined classifies it `unknown` (fail
  // closed); isTransportHostSyntax below refuses it, so nothing strips it here.
  let host = hostPort[1] ?? "";
  if (host === "") {
    return undefined;
  }
  // Delegated decision 2026-09-25: a dot-less name is classified as the host
  // the transport will actually connect to. sn-client's resolveHost
  // (core/host.ts) appends ".service-now.com" to any host without a ".", so
  // "acme" reaches acme.service-now.com; classifying it as the bare "acme"
  // made it a vanity/prod-suspect host an ack could lift, while a declared-prod
  // "https://acme.service-now.com" was the instance written to. The same
  // rule applies to the ref, the allowlist and the prod list (all normalise
  // through here), so "acme" in any of them means acme.service-now.com.
  if (!host.includes(".")) {
    host = `${host}${TRANSPORT_CANONICAL_SUFFIX}`;
  }
  // Delegated decision 2026-09-26: the guard never accepts a host the
  // transport would refuse, so it cannot classify an identity the client will
  // not connect to under a different name. guard depends only on
  // @tessera/types and adding @tessera/sn-client would widen that contract
  // (and this lane's scope), so the rule is MIRRORED here, not imported;
  // test/hostParser.test.js is the parity test against resolveHost, with no
  // documented exception (the trailing dot is refused on both sides since
  // 2026-09-26). The suffix above must stay equal to
  // SN_HOST_POLICY.canonicalSuffix.
  if (!isTransportHostSyntax(host)) {
    return undefined;
  }
  // Delegated decision 2026-09-26: WHATWG must read the same host. This closes
  // parser differentials the lexical checks cannot see — "10.1" is the IPv4
  // 10.0.0.1 to WHATWG, "0x7f.0.0.1" is 127.0.0.1, a numeric last label that
  // is not an IPv4 address is invalid, and a port above 65535 is refused.
  // Both the rebuilt authority AND the value as given (https:// prefixed when
  // it has no scheme) are parsed, and both must name this host with nothing
  // but a bare "/" after it.
  let rebuilt: URL;
  let given: URL;
  try {
    rebuilt = new URL(
      `https://${host}${port === undefined ? "" : `:${port}`}/`,
    );
    given = new URL(scheme ? lowered : `https://${lowered}`);
  } catch {
    return undefined;
  }
  let givenHost = given.hostname;
  if (givenHost !== "" && !givenHost.includes(".")) {
    givenHost = `${givenHost}${TRANSPORT_CANONICAL_SUFFIX}`;
  }
  if (
    rebuilt.hostname !== host ||
    givenHost !== host ||
    !READABLE_SCHEMES.has(given.protocol.slice(0, -1)) ||
    given.username !== "" ||
    given.password !== "" ||
    given.pathname !== "/" ||
    given.search !== "" ||
    given.hash !== ""
  ) {
    return undefined;
  }
  return host;
}

/**
 * The instance label split into tokens on "-", "_" and every letter/digit
 * boundary: "acme-uat2" → ["acme", "uat", "2"], "dev12345" → ["dev", "12345"].
 */
function labelTokens(label: string): string[] {
  return label
    .split(/[-_]+|(?<=[0-9])(?=[^0-9])|(?<=[^0-9])(?=[0-9])/)
    .filter((token) => token !== "");
}

/** Whether `marker` (itself tokenised) appears as adjacent whole tokens. */
function hasMarkerTokens(tokens: string[], marker: string): boolean {
  const want = labelTokens(marker);
  for (let i = 0; i + want.length <= tokens.length; i += 1) {
    if (want.every((part, j) => tokens[i + j] === part)) {
      return true;
    }
  }
  return false;
}

/**
 * §11.2 row 2 — instance-name pattern. Returns the reasons the name looks like
 * prod; an empty array means the name raised nothing (which never upgrades
 * anything, it only declines to downgrade).
 */
export function nameHeuristicReasons(host: string): string[] {
  const reasons: string[] = [];
  const label = host.split(".")[0] ?? "";
  const tokens = labelTokens(label);
  // Delegated decision 2026-09-26: a marker must be a whole token (or, for
  // "pre-prod" style markers, adjacent whole tokens). Substring matching let
  // "qatarairways" (qa), "devonenergy" (dev) and "democracyprep" (demo) pass
  // as non-prod, so an allowlisted prod name raised no downgrade — the
  // fail-open direction. The substring test is kept as a second, AND-ed
  // condition so no name can ever become LESS suspect than before: a token
  // match without the old substring match (e.g. "pre_prod" against
  // "pre-prod") still raises the reason.
  const marked = NON_PROD_MARKERS.some(
    (marker) => label.includes(marker) && hasMarkerTokens(tokens, marker),
  );
  if (!marked) {
    reasons.push(`no dev/test/uat marker in instance name "${label}"`);
  }
  if (!VENDOR_DOMAINS.some((domain) => host.endsWith(domain))) {
    reasons.push("vanity/customer URL (not a *.service-now.com host)");
  }
  return reasons;
}

function warning(detail: string): GuardSignal {
  return { kind: "probe-unreachable", effect: "warning", detail };
}

/**
 * The SHAPE of an unexpected probe value — never the value. `sys_properties`
 * holds instance-authored text, and a guard message printed by
 * `formatGuardViolation` is the last place that text should be able to reach;
 * `typeof` is a closed set of strings nobody on the instance can influence.
 */
function shapeOf(value: unknown): string {
  return value === null ? "null" : typeof value;
}

/**
 * What the guard may truthfully say about a probe field that is neither `true`
 * nor `false`, which is TWO observations, not one (DEV-1).
 *
 * `undefined` means the probe result carried nothing for this field. The guard
 * did not watch a read fail — it received a result with a hole in it, and only
 * the probe knows whether that hole was a refused read, an unset property or a
 * value it could not use. Whatever reason it did have travels separately,
 * through `InstanceProbe.unreachable`, so a guard warning that asserts a cause
 * here can end up printed directly above a probe reason that contradicts it.
 *
 * Anything else means a value DID arrive and was not a boolean. "Could not be
 * read" is false twice over in that case: the read happened, and it answered.
 *
 * Neither state clears the instance and neither downgrades it on its own; that
 * part is unchanged, and is what the sentences still say out loud.
 */
function unusableValueDetail(property: string, value: unknown): string {
  return value === undefined
    ? `${property}: no boolean in the probe result, so it neither clears nor downgrades this instance`
    : `${property}: the probe returned a ${shapeOf(value)}, not a boolean, so it neither clears nor downgrades this instance`;
}

/**
 * Whether an `*Uninterpretable` flag is raised. Only an absent flag or an
 * explicit `false` reads "not flagged".
 *
 * Delegated decision 2026-10-01 (wave 17): a flag that is present but not a
 * boolean (the type forbids it, a malformed probe can still send it) counts as
 * raised — fail closed: the cost is a downgrade to `prod-suspect`, the
 * alternative is a malformed probe clearing a value it said it could not read.
 */
function isFlagged(flag: unknown): boolean {
  return flag !== undefined && flag !== false;
}

/**
 * Turn a probe result into signals. A value the guard cannot use is a warning:
 * it neither clears an instance nor, alone, downgrades it — the allowlist entry
 * stands (§11.2). A readable non-prod value produces NO signal, because
 * heuristics never upgrade. A value the probe flags as uninterpretable is a
 * downgrade under its own kind, and it replaces whatever the boolean beside it
 * would have raised: that boolean is the probe's fail-closed reading, not what
 * the row says.
 *
 * Delegated decision 2026-10-01 (wave 17): two kinds (one per property), not
 * one generic kind — matching `production-property`/`atf-runner-disabled`, so
 * a consumer filtering on the property keeps a closed set to match on.
 *
 * Delegated decision 2026-10-01 (wave 17): the two property names in the
 * details below are built from `@tessera/types`' constants rather than spelled
 * out, so the wording cannot drift from the names the probes read. The
 * rendered strings are byte-identical to the literals they replaced.
 */
export function probeSignals(probe: InstanceProbe | undefined): GuardSignal[] {
  const signals: GuardSignal[] = [];
  if (probe === null || typeof probe !== "object") {
    // Fail-closed on a malformed probe: treat it as unreadable, not as clean.
    return [warning("read-only probe returned no usable result")];
  }

  if (isFlagged(probe.productionPropertyUninterpretable)) {
    signals.push({
      kind: "production-property-uninterpretable",
      effect: "downgrade",
      detail: `${PRODUCTION_PROPERTY}: the probe read a value it could not interpret — treated as production (fail closed), which downgrades this instance`,
    });
  } else if (probe.productionProperty === true) {
    signals.push({
      kind: "production-property",
      effect: "downgrade",
      detail: `${PRODUCTION_PROPERTY} reads true`,
    });
  } else if (probe.productionProperty !== false) {
    signals.push(
      warning(
        unusableValueDetail(PRODUCTION_PROPERTY, probe.productionProperty),
      ),
    );
  }

  if (isFlagged(probe.atfRunnerEnabledUninterpretable)) {
    signals.push({
      kind: "atf-runner-uninterpretable",
      effect: "downgrade",
      detail: `${ATF_RUNNER_ENABLED_PROPERTY} (DR-3): the probe read a value it could not interpret — treated as disabled (fail closed), which downgrades this instance`,
    });
  } else if (probe.atfRunnerEnabled === false) {
    signals.push({
      kind: "atf-runner-disabled",
      effect: "downgrade",
      detail: `${ATF_RUNNER_ENABLED_PROPERTY} reads false (DR-3)`,
    });
  } else if (probe.atfRunnerEnabled !== true) {
    signals.push(
      warning(
        unusableValueDetail(
          `${ATF_RUNNER_ENABLED_PROPERTY} (DR-3)`,
          probe.atfRunnerEnabled,
        ),
      ),
    );
  }

  for (const reason of probe.unreachable ?? []) {
    signals.push(warning(reason));
  }
  return signals;
}

/** Signals for a probe that never ran or threw — warnings only (§11.2). */
export function probeFailureSignals(detail: string): GuardSignal[] {
  return [warning(detail)];
}
