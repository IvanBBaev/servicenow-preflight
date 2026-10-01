// The composition root's own decisions, with no instance behind them.
//
// Everything here is a pure function of its arguments: the argv split, the exit
// code tables, the two roll-ups (`decideVerdict`, `exitCodeForDoctor`), the
// artifact parser, the role binder and the frozen Phase-0.5 report renderer.
// The wired commands are exercised against the QA-18 fake in
// `preflight.test.js`; keeping the two apart is what makes THIS file able to
// assert the fail-closed tables exhaustively without seeding a world first.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GuardViolation } from "@tessera/guard";
import {
  ProvisionApplyError,
  ProvisionVerificationError,
} from "@tessera/provisioner";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";
import * as doctor from "@tessera/doctor";
import { readFileSync } from "node:fs";

import {
  COMMANDS,
  commandHelp,
  decideVerdict,
  doctorHardFailure,
  EXIT_CODES,
  exitCodeForDoctor,
  formatRunReport,
  guardReasoning,
  jsonRunReport,
  main,
  parseArtifact,
  planIdentity,
  provisionAftermath,
  runExitDisposition,
  splitArgv,
  TOP_LEVEL_HELP,
  bindRole,
  createGuardProbe,
  TopologyError,
  verdictLabel,
} from "../build/index.js";

// ── harness ─────────────────────────────────────────────────────────────────

/** A context that captures both streams instead of writing to the terminal. */
function capture(overrides = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdoutText: () => out.join("\n"),
    stderrText: () => err.join("\n"),
    context: {
      now: () => new Date("2026-02-02T03:04:05.000Z"),
      actor: "test",
      cwd: process.cwd(),
      // Empty on purpose: an ambient TESSERA_* would silently become a layer
      // under the flags and the assertions below would stop meaning anything.
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      ...overrides,
    },
  };
}

/** Set credential env for the duration of one call, then put it all back. */
function withProfiles(profiles, fn) {
  const keys = [
    "SN_INSTANCE",
    "SN_USER",
    "SN_PASSWORD",
    "SN_ACTIVE_PROFILE",
    ...Object.keys(profiles),
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(profiles)) {
    process.env[key] = value;
  }
  reloadCredentialsFromEnv();
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadCredentialsFromEnv();
  }
}

function finding(precondition, status, applicability = "required") {
  return { precondition, status, applicability, evidence: `${status} here` };
}

function doctorReport(status, extra = {}) {
  return { status, findings: [finding("p", status)], ...extra };
}

function parityReport(status, extra = {}) {
  return {
    status,
    source: "src",
    runner: "run",
    rows: [],
    summary: `parity is ${status}`,
    ...extra,
  };
}

function plan(steps, extra = {}) {
  return {
    actions: [],
    steps,
    blockers: [],
    readiness: "not-ready",
    ...extra,
  };
}

// ── argv split ──────────────────────────────────────────────────────────────

describe("splitArgv", () => {
  it("treats an empty argv as a request for top-level help", () => {
    assert.deepEqual(splitArgv([]), { kind: "help" });
  });

  for (const form of ["help", "--help", "-h"]) {
    it(`treats a leading ${JSON.stringify(form)} as top-level help`, () => {
      assert.deepEqual(splitArgv([form]), { kind: "help" });
    });
  }

  it("hands the command everything after it, untouched", () => {
    assert.deepEqual(splitArgv(["doctor", "--instance", "dev", "--json"]), {
      kind: "command",
      name: "doctor",
      rest: ["--instance", "dev", "--json"],
    });
  });

  it("lets --help anywhere in a command's argv win over running it", () => {
    // A caller who asked for help never wanted the side effects of the run,
    // and `preflight --mode apply` has side effects.
    assert.deepEqual(splitArgv(["preflight", "--mode", "apply", "--help"]), {
      kind: "help",
      command: "preflight",
    });
    assert.deepEqual(splitArgv(["run", "-h"]), {
      kind: "help",
      command: "run",
    });
  });

  it("reads --help as a value, not help, only after a validated value flag", () => {
    // Delegated decision 2026-09-25 (args.ts `VALIDATED_VALUE_FLAGS`).
    assert.deepEqual(splitArgv(["status", "--json", "--run-id", "--help"]), {
      kind: "command",
      name: "status",
      rest: ["--json", "--run-id", "--help"],
    });
    assert.deepEqual(splitArgv(["cleanup", "--mode", "-h"]).kind, "command");
    assert.deepEqual(
      splitArgv(["status", "--since", "--help"]).kind,
      "command",
    );
    // ...and stays help everywhere else, including a flag position right after
    // a consumed value and after a value flag whose value is NOT validated up
    // front (fail-closed: help never has side effects, a run might).
    for (const argv of [
      ["status", "--help", "--run-id", "x"],
      ["status", "--run-id", "x", "--help"],
      ["cleanup", "--actor", "--help"],
      ["run", "--run-id", "--help"],
      ["preflight", "--mode", "--help"],
    ]) {
      assert.equal(splitArgv(argv).kind, "help", JSON.stringify(argv));
    }
  });

  it("names the commands when the head is not one", () => {
    const split = splitArgv(["preflght"]);
    assert.equal(split.kind, "error");
    assert.match(split.message, /unknown command "preflght"/);
    for (const command of COMMANDS)
      assert.match(split.message, RegExp(command));
  });

  it("reads a leading flag as a forgotten command, not a bad flag", () => {
    const split = splitArgv(["--instance", "dev"]);
    assert.equal(split.kind, "error");
    assert.match(split.message, /expected a command before "--instance"/);
  });
});

// ── exit codes and help ─────────────────────────────────────────────────────

describe("the exit-code table", () => {
  it("is the documented six, and every value is distinct", () => {
    assert.deepEqual(EXIT_CODES, {
      ok: 0,
      noGo: 1,
      usage: 2,
      fault: 3,
      refused: 4,
      inconclusive: 5,
    });
    assert.equal(new Set(Object.values(EXIT_CODES)).size, 6);
  });

  it("is documented in the top-level help, every code of it", () => {
    // Drift here is worse than a missing line: an operator wiring a CI job
    // reads the help, not the source.
    const block = TOP_LEVEL_HELP.slice(TOP_LEVEL_HELP.indexOf("EXIT CODES"));
    assert.notEqual(block, "");
    for (const [name, code] of Object.entries(EXIT_CODES)) {
      assert.match(
        block,
        RegExp(`\\b${code} \\S`),
        `exit code ${code} (${name}) is not documented in the top-level help`,
      );
    }
  });
});

describe("help", () => {
  it("lists every command in the top-level text", () => {
    for (const command of COMMANDS) {
      assert.match(TOP_LEVEL_HELP, RegExp(`^  ${command}\\s`, "m"));
    }
  });

  it("renders a usage line for each command", () => {
    for (const command of COMMANDS) {
      const text = commandHelp(command);
      assert.match(text, RegExp(`^tess ${command}`), command);
      assert.match(text, /^USAGE$/m, command);
      assert.match(text, /^EXIT CODES$/m, command);
    }
  });

  it("tells a run --skeleton operator that a 1 has two meanings", () => {
    // The help is where someone wiring a CI job learns what the exit code
    // means, and this command's is frozen at two codes for three answers. The
    // machine-readable escape hatch is named, because a warning that does not
    // say what to read instead is a warning nobody can act on.
    const text = commandHelp("run");
    assert.match(text, /NO_GO OR INCONCLUSIVE/);
    assert.match(text, /verdict\.exitCodeCollapsed/);
  });

  it("derives the preflight flag list from the option table", () => {
    // The point of deriving it: a flag that exists is documented, and a
    // documented flag exists.
    const text = commandHelp("preflight");
    for (const flag of ["--runner", "--source", "--mode", "--artifact"]) {
      assert.match(text, RegExp(`${flag}\\b`), flag);
    }
  });

  it("advertises --instance and --target together for the doctor", () => {
    const text = commandHelp("doctor");
    assert.match(text, /--instance\b/);
    assert.match(text, /--target\b/);
    // ...and says why that is not the ARCH-29 alias.
    assert.match(text, /not the\s+ARCH-29 alias/);
  });

  it("does not let the doctor help promise every unknown reaches exit 5", () => {
    // The exit table read "0 ready 1 not ready 2 usage 3 fault 5 unknown /
    // inconclusive" and stopped there, which reads as a total mapping. It is
    // not: `exitCodeForDoctor` short-circuits to 1 on any hard failure, and
    // `hardFailureOf` raises one for a kind-gated precondition whose status is
    // `!== "ready"` — `unknown` included (DEV-2). An operator wiring a CI job
    // reads this text, not the source, so the exception belongs here too.
    //
    // 5 is NOT struck from the table: `tess doctor` really does return it for
    // an undecided precondition that no hard failure outranked. What is added
    // is the one path on which it does not.
    const text = commandHelp("doctor");
    assert.match(text, /5 unknown \/ inconclusive/);
    assert.match(text, /ONE EXCEPTION, AND IT IS DELIBERATE/);
    assert.match(text, /DEV-2/);
    // The instruction that makes the exception actionable: the document carries
    // both fields the exit code collapses into one number.
    assert.match(text, /Read status AND hardFailure/);
  });

  it("warns that run --skeleton can never reach the inconclusive exit", () => {
    // The top-level table lists 5 for the whole CLI, and its "0 ready / GO" and
    // "1 not ready / NO_GO" rows use `run`'s own vocabulary — so it reads as
    // covering `run` too. It does not: `runExitDisposition` is GO → 0 and
    // everything else → 1 (pinned exhaustively in the `runExitDisposition`
    // suite below), so an INCONCLUSIVE verdict there arrives as a 1. A CI job
    // that branched on 5 after reading `tess --help` would wait forever.
    assert.match(TOP_LEVEL_HELP, /NOT reachable from `run --skeleton`/);
    assert.match(TOP_LEVEL_HELP, /never as a 5/);
    // The claim is only useful if it also says where 5 IS reachable, so the
    // reader is not left assuming the code is dead everywhere.
    for (const command of COMMANDS.filter((name) => name !== "run")) {
      assert.match(
        TOP_LEVEL_HELP.slice(TOP_LEVEL_HELP.indexOf("EXIT CODES")),
        RegExp(`\\b${command}\\b`),
        `${command} can exit 5 and the top-level help does not say so`,
      );
    }
  });
});

describe("main()", () => {
  it("prints top-level help on no argv and exits 0", async () => {
    const cap = capture();
    assert.equal(await main([], cap.context), EXIT_CODES.ok);
    assert.equal(cap.stdoutText(), TOP_LEVEL_HELP);
    assert.deepEqual(cap.err, []);
  });

  it("prints command help without running the command", async () => {
    for (const command of COMMANDS) {
      const cap = capture();
      assert.equal(await main([command, "--help"], cap.context), EXIT_CODES.ok);
      assert.equal(cap.stdoutText(), commandHelp(command));
    }
  });

  it("exits 2 on an unknown command, and says how to get help", async () => {
    const cap = capture();
    assert.equal(await main(["deploy"], cap.context), EXIT_CODES.usage);
    assert.match(cap.stderrText(), /unknown command "deploy"/);
    assert.match(cap.stderrText(), /tess --help/);
    assert.deepEqual(cap.out, []);
  });
});

// ── artifact parsing ────────────────────────────────────────────────────────

describe("parseArtifact", () => {
  it("parses table/sys_id and names the artifact after itself", () => {
    assert.deepEqual(parseArtifact("sys_script_include/abc123"), {
      table: "sys_script_include",
      sysId: "abc123",
      name: "sys_script_include/abc123",
    });
  });

  it("takes the optional trailing label", () => {
    assert.deepEqual(parseArtifact("sys_script_include/abc123:PriceRules"), {
      table: "sys_script_include",
      sysId: "abc123",
      name: "PriceRules",
    });
  });

  it("trims, and treats a blank label as absent", () => {
    assert.equal(parseArtifact("  sys_script/ x9 : ").name, "sys_script/x9");
  });

  for (const bad of ["sys_script_include", "/abc123", "sys_script/", ""]) {
    it(`refuses ${JSON.stringify(bad)} instead of resolving it`, () => {
      // A half-named artifact would become an `undecidable` parity row and
      // read like an instance problem when it is a typo.
      const parsed = parseArtifact(bad);
      assert.equal(typeof parsed, "string");
      assert.match(parsed, /--artifact expects/);
    });
  }
});

// ── the two roll-ups ────────────────────────────────────────────────────────

describe("decideVerdict", () => {
  it("puts a hard failure above everything else", () => {
    const verdict = decideVerdict(
      doctorReport("not-ready", { hardFailure: "no Test Runner (DEV-2)" }),
      parityReport("mismatch", { preflightFailure: "runner is behind" }),
      plan([]),
      "plan",
    );
    assert.equal(verdict.exitCode, EXIT_CODES.noGo);
    assert.equal(verdict.reason, "no Test Runner (DEV-2)");
  });

  it("does not promise every undecided preflight state reaches exit 5", () => {
    // The module header used to read "anything undecided is `inconclusive` (5)",
    // full stop. It is not: `hardFailure` is tested FIRST, and `hardFailureOf`
    // in `@tessera/doctor` raises one for a kind-gated precondition whose status
    // is merely `!== "ready"` — `unknown` included. So an undecided doctor
    // report under a DEV-2 hard failure exits 1.
    //
    // The sibling test above proves the ordering with a `not-ready` status,
    // which is the case where 1 was never in doubt. THIS one uses `unknown`,
    // because that is the status the corrected claim is about: fail-closed
    // still holds (it is never 0), but the code is not 5.
    const verdict = decideVerdict(
      doctorReport("unknown", { hardFailure: "no Test Runner (DEV-2)" }),
      parityReport("match"),
      plan([]),
      "plan",
    );
    assert.notEqual(
      verdict.exitCode,
      EXIT_CODES.inconclusive,
      "a DEV-2 hard failure outranks an undecided report — it is exit 1, not 5",
    );
    assert.equal(verdict.exitCode, EXIT_CODES.noGo);
    assert.equal(verdict.reason, "no Test Runner (DEV-2)");
    // ...and fail-closed is the invariant that survives the exception.
    assert.notEqual(verdict.exitCode, EXIT_CODES.ok);
  });

  it("prefers a proven parity mismatch to a generic not-ready", () => {
    // Both are exit 1. The reason an operator is handed should be the one that
    // is provably wrong rather than the one that merely needs provisioning.
    const verdict = decideVerdict(
      doctorReport("not-ready"),
      parityReport("mismatch", { preflightFailure: "runner is behind" }),
      plan([]),
      "plan",
    );
    assert.equal(verdict.exitCode, EXIT_CODES.noGo);
    assert.equal(verdict.reason, "runner is behind");
  });

  it("points a not-ready plan run at --mode apply, with a step count", () => {
    const verdict = decideVerdict(
      doctorReport("not-ready"),
      parityReport("match"),
      plan([{ precondition: "p" }, { precondition: "q" }]),
      "plan",
    );
    assert.equal(verdict.exitCode, EXIT_CODES.noGo);
    assert.match(verdict.reason, /2 step\(s\) planned/);
    assert.match(verdict.reason, /--mode apply/);
  });

  it("does not offer --mode apply when there is nothing to apply", () => {
    const verdict = decideVerdict(
      doctorReport("not-ready"),
      parityReport("match"),
      plan([]),
      "plan",
    );
    assert.equal(verdict.exitCode, EXIT_CODES.noGo);
    assert.doesNotMatch(verdict.reason, /--mode apply/);
  });

  it("does not offer --mode apply to a run already in apply mode", () => {
    const verdict = decideVerdict(
      doctorReport("not-ready"),
      parityReport("match"),
      plan([{ precondition: "p" }]),
      "apply",
    );
    assert.doesNotMatch(verdict.reason, /--mode apply/);
  });

  it("is inconclusive, not green, when parity could not be decided", () => {
    const verdict = decideVerdict(
      doctorReport("ready"),
      parityReport("undecidable", { inconclusive: "could not read abc123" }),
      plan([]),
      "plan",
    );
    assert.equal(verdict.exitCode, EXIT_CODES.inconclusive);
    assert.equal(verdict.reason, "could not read abc123");
  });

  it("is inconclusive when a precondition could not be decided (QA-9)", () => {
    const verdict = decideVerdict(
      doctorReport("unknown"),
      parityReport("match"),
      plan([]),
      "plan",
    );
    assert.equal(verdict.exitCode, EXIT_CODES.inconclusive);
    assert.match(verdict.reason, /QA-9/);
  });

  it("says out loud that a not-applicable parity verified nothing", () => {
    const verdict = decideVerdict(
      doctorReport("ready"),
      parityReport("not-applicable", {
        summary: "source and runner are the same instance (dev)",
      }),
      plan([]),
      "plan",
    );
    assert.equal(verdict.exitCode, EXIT_CODES.ok);
    assert.match(verdict.reason, /not applicable/);
    assert.match(verdict.reason, /same instance/);
  });

  it("is green only when the runner is ready AND in parity", () => {
    const verdict = decideVerdict(
      doctorReport("ready"),
      parityReport("match"),
      plan([]),
      "plan",
    );
    assert.equal(verdict.exitCode, EXIT_CODES.ok);
    assert.equal(verdict.reason, "the runner is ready and in parity");
  });
});

describe("verdictLabel", () => {
  it("keeps INCONCLUSIVE distinct from NOT READY", () => {
    assert.equal(
      verdictLabel({ exitCode: EXIT_CODES.ok, reason: "" }),
      "READY",
    );
    assert.equal(
      verdictLabel({ exitCode: EXIT_CODES.inconclusive, reason: "" }),
      "INCONCLUSIVE",
    );
    assert.equal(
      verdictLabel({ exitCode: EXIT_CODES.noGo, reason: "" }),
      "NOT READY",
    );
    assert.equal(
      verdictLabel({ exitCode: EXIT_CODES.refused, reason: "" }),
      "NOT READY",
    );
  });
});

describe("planIdentity", () => {
  // The property: a plan with NO digest must be distinguishable, by a machine,
  // from a plan whose digest is the empty string. `planHash` is optional on
  // `PreflightProvisionPlan` — `isExecutable` narrows on `steps` alone, so an
  // unhashed plan is a legal value of the type the JSON branch renders — and
  // the three obvious renderings of that absence (`""`, `null`, an absent key)
  // are all read as falsy, i.e. as "no hash", by exactly the consumers that
  // would then substitute a default and compare it to a real digest.
  it("does not give an unhashed plan an identity it can be read out of", () => {
    const identity = planIdentity(plan([]));

    assert.equal(identity.state, "not-computed");
    // Not `value === undefined`: the key must not be reachable at all, or a
    // consumer doing `identity.value ?? ""` gets the empty hash back by
    // another route.
    assert.equal("value" in identity, false);
    // The absence has to survive serialization, since JSON is the only form
    // this is ever seen in. `JSON.stringify` drops `undefined` values, so a
    // shape that merely left `value` undefined would round-trip into the same
    // absent key an old CLI produces.
    assert.equal(
      Object.keys(JSON.parse(JSON.stringify(identity)))
        .sort()
        .join(","),
      "state,why",
    );
    assert.match(identity.why, /no DESIGN §6b digest/);
  });

  it("keeps the empty hash a hash", () => {
    // The pair the whole tagged shape exists for. An empty digest is a claim
    // about a plan; no digest is the absence of a claim. Rendered flat they
    // are the same two bytes.
    const empty = planIdentity(plan([], { planHash: "" }));
    const missing = planIdentity(plan([]));

    assert.deepEqual(empty, { state: "computed", value: "" });
    assert.notDeepEqual(empty, missing);
    assert.notEqual(
      JSON.stringify(empty),
      JSON.stringify(missing),
      "the two facts must not serialize to the same document",
    );
  });

  it("publishes a real digest by value, unaltered", () => {
    const digest = "a".repeat(64);
    assert.deepEqual(planIdentity(plan([], { planHash: digest })), {
      state: "computed",
      value: digest,
    });
  });
});

describe("exitCodeForDoctor", () => {
  const role = (status, extra = {}) => ({
    role: "runner",
    profile: "dev",
    host: "dev.service-now.com",
    report: doctorReport(status, extra),
  });

  it("maps the three states to 0 / 1 / 5", () => {
    assert.equal(exitCodeForDoctor([role("ready")]), EXIT_CODES.ok);
    assert.equal(exitCodeForDoctor([role("not-ready")]), EXIT_CODES.noGo);
    assert.equal(exitCodeForDoctor([role("unknown")]), EXIT_CODES.inconclusive);
  });

  it("lets a hard failure override an otherwise undecided report", () => {
    // DEV-2 is a definite "no", not an undecided one, even though the finding
    // underneath it is `unknown`.
    assert.equal(
      exitCodeForDoctor([role("unknown", { hardFailure: "no Test Runner" })]),
      EXIT_CODES.noGo,
    );
  });

  it("rolls two instances up fail-closed: unknown beats not-ready", () => {
    assert.equal(
      exitCodeForDoctor([role("not-ready"), role("unknown")]),
      EXIT_CODES.inconclusive,
    );
    assert.equal(
      exitCodeForDoctor([role("ready"), role("not-ready")]),
      EXIT_CODES.noGo,
    );
  });
});

// The predicate `exitCodeForDoctor` branches on, extracted so the document root
// can state it too. It is asserted here in its own right — not through the exit
// code — because the whole point of factoring it out was that the two answers
// can no longer be derived separately and drift.
describe("doctorHardFailure", () => {
  const role = (name, status, extra = {}) => ({
    role: name,
    profile: "dev",
    host: `${name}.service-now.com`,
    report: doctorReport(status, extra),
  });

  it("is undefined only when no instance reported one", () => {
    assert.equal(
      doctorHardFailure([role("runner", "unknown"), role("source", "ready")]),
      undefined,
    );
  });

  it("names the instance, so a root-level reader knows which one failed", () => {
    // The reason the roll-up is a string rather than a boolean: `hardFailure:
    // true` on a two-instance document tells a caller that something is wrong
    // and nothing about where, which is the same dead end as reading `status`.
    assert.equal(
      doctorHardFailure([
        role("runner", "unknown", { hardFailure: "no Test Runner (DEV-2)" }),
        role("source", "ready"),
      ]),
      "runner: no Test Runner (DEV-2)",
    );
  });

  it("keeps every failing instance rather than reporting the first", () => {
    assert.equal(
      doctorHardFailure([
        role("runner", "unknown", { hardFailure: "no Test Runner" }),
        role("source", "not-ready", { hardFailure: "no ui kind" }),
      ]),
      "runner: no Test Runner; source: no ui kind",
    );
  });

  it("agrees with the exit code it is factored out of", () => {
    // The drift this pair exists to prevent: the exit code said "hard failure"
    // and the document root said nothing, for the same reports.
    const reports = [role("runner", "unknown", { hardFailure: "DEV-2" })];
    assert.equal(exitCodeForDoctor(reports), EXIT_CODES.noGo);
    assert.notEqual(doctorHardFailure(reports), undefined);
  });
});

// ── what escapes a command (cli.ts's catch) ─────────────────────────────────

describe("guardReasoning", () => {
  const violation = (reason, message, detail = {}) =>
    new GuardViolation(message, {
      reason,
      instance: { name: "prod-eu", host: "acme.service-now.com" },
      role: "target",
      cls: "prod",
      evidence: [
        { kind: "allowlist", effect: "deny", detail: "not allowlisted" },
      ],
      remedy: "point --runner at a sub-production instance",
      design: ["§11.5", "ARCH-8"],
      ...detail,
    });

  it("states the reason code and the class for a message that carries neither", () => {
    // ARCH-8's own refusal, verbatim from targetGuard.ts. It names the ROLE and
    // stops there: whether the instance the write was aimed at is prod, unknown
    // or perfectly ordinary sub-prod is invisible in the prose, and the closed
    // union that answers it exactly reached no caller at all. Three of the eight
    // reasons build a message like this one.
    const text = guardReasoning(
      violation(
        "role-forbids-write",
        "write refused: the target role never receives pipeline writes (ARCH-8)",
      ),
    );
    assert.match(text, /^GuardViolation \[role-forbids-write\]: /);
    assert.match(text, /^ {2}class: +prod$/m);
    assert.match(text, /^ {2}role: +target$/m);
    assert.match(text, /^ {2}instance: prod-eu <acme\.service-now\.com>$/m);
    assert.match(text, /- \[deny\] allowlist: not allowlisted/);
    assert.match(text, /^ {2}remedy: +point --runner at/m);
  });

  it("renders the refused write when the refusal carried one", () => {
    const text = guardReasoning(
      violation("declared-prod", 'write refused: "acme" is declared prod', {
        intent: {
          op: "update",
          table: "sys_properties",
          sysId: "abc",
          description: "enable the ATF runner",
        },
      }),
    );
    assert.match(
      text,
      /^ {2}refused: +update sys_properties\/abc — enable the ATF runner$/m,
    );
  });

  it("returns nothing rather than throwing when the detail is not there", () => {
    // The crash-safety property, and why this is not folded into the check that
    // decides exit 4: the renderer dereferences `detail` and iterates two of its
    // arrays, and a throw raised from inside the catch block would turn a clean
    // refusal into a stack trace. An error that calls itself a GuardViolation
    // without its detail is still a refusal — it just loses the extra lines.
    const bare = new Error("write refused: something");
    bare.name = "GuardViolation";
    assert.equal(guardReasoning(bare), undefined);

    const half = new Error("write refused: something");
    half.name = "GuardViolation";
    half.detail = { reason: "declared-prod", evidence: [] };
    assert.equal(guardReasoning(half), undefined);
  });
});

describe("provisionAftermath", () => {
  it("states how much of the plan already landed", () => {
    // The fact the DEV-1 banner was printing over. `applied`/`total` exist on
    // this error precisely because "what state is the instance in now?" is the
    // next question, and the fault branch rendered `message` alone — under a
    // line that reads "no evidence was produced", which a reader is entitled to
    // hear as "nothing happened, retry".
    const lines = provisionAftermath(
      new ProvisionApplyError("PATCH sys_properties failed: 500", {
        applied: 2,
        total: 5,
      }),
    );
    assert.equal(lines.length, 2);
    assert.match(lines[0], /PARTIAL APPLY: 2 of 5 planned write\(s\)/);
    assert.match(lines[1], /does not undo what landed/);
  });

  it("keeps an unverified apply distinguishable from a partial one", () => {
    // Not the same failure and not the same advice: every write claimed success
    // and the instance disagreed, so how much of the plan is in place is
    // UNKNOWN — which is neither "2 of 5" nor "nothing".
    const lines = provisionAftermath(
      new ProvisionVerificationError("the runner still reads false"),
    );
    assert.equal(lines.length, 2);
    assert.match(lines[0], /APPLY UNVERIFIED/);
    assert.match(lines[0], /UNKNOWN/);
    assert.equal(
      lines.some((line) => /PARTIAL APPLY/.test(line)),
      false,
    );
  });

  it("says nothing about an error that is neither", () => {
    assert.deepEqual(provisionAftermath(new Error("ECONNRESET")), []);
    assert.deepEqual(provisionAftermath("not an error at all"), []);
  });
});

// ── role binding (§2a) ──────────────────────────────────────────────────────

describe("bindRole", () => {
  it("resolves a profile name to the host its credentials name", () => {
    withProfiles(
      {
        SN_PROFILE_PROD_RO_INSTANCE: "acme.service-now.com",
        SN_PROFILE_PROD_RO_USER: "ro",
        SN_PROFILE_PROD_RO_PASSWORD: "ro",
      },
      () => {
        assert.deepEqual(bindRole("source", "prod_ro"), {
          role: "source",
          profile: "prod_ro",
          ref: { name: "prod_ro", host: "acme.service-now.com" },
        });
      },
    );
  });

  it("lower-cases and trims the profile name", () => {
    withProfiles(
      {
        SN_PROFILE_DEV_INSTANCE: "dev.service-now.com",
        SN_PROFILE_DEV_USER: "u",
        SN_PROFILE_DEV_PASSWORD: "p",
      },
      () => {
        assert.equal(
          bindRole("runner", "  DEV  ").ref.host,
          "dev.service-now.com",
        );
      },
    );
  });

  it("REFUSES a bare host rather than probing it with ambient credentials", () => {
    // Silently reading the wrong instance is the ARCH-8 failure mode this
    // whole layer exists to prevent.
    assert.throws(
      () => bindRole("runner", "https://dev.service-now.com"),
      (error) => {
        assert.ok(error instanceof TopologyError);
        assert.match(error.message, /PROFILE name, not a host/);
        // The operator's next action is to set the env keys, so it names them.
        assert.match(error.message, /SN_PROFILE_<NAME>_INSTANCE/);
        return true;
      },
    );
  });

  it("refuses a profile that exists but names no instance", () => {
    withProfiles({ SN_PROFILE_EMPTY_INSTANCE: "  " }, () => {
      assert.throws(
        () => bindRole("target", "empty"),
        (error) => {
          assert.match(error.message, /SN_PROFILE_EMPTY_INSTANCE/);
          return true;
        },
      );
    });
  });

  it("names SN_INSTANCE, not a profile key, for the default profile", () => {
    withProfiles({ SN_INSTANCE: "" }, () => {
      assert.throws(
        () => bindRole("runner", "default"),
        (error) => {
          assert.match(error.message, /set SN_INSTANCE\b/);
          return true;
        },
      );
    });
  });
});

// ── the §11.2 guard probe ───────────────────────────────────────────────────

// Delegated decision 2026-09-26: the CLI holds no copy of the production
// property name — it re-exports `@tessera/doctor`'s, the probe that resolves
// differing duplicate rows toward production for exactly that name. A second
// literal could drift from the doctor's and silently skip that resolution.
describe("the production property name has one home", () => {
  it("is the doctor's constant, re-exported", async () => {
    const cli = await import("../build/index.js");
    assert.equal(cli.PRODUCTION_PROPERTY, doctor.PRODUCTION_PROPERTY);
    assert.equal(doctor.PRODUCTION_PROPERTY, "glide.installation.production");
  });

  it("is not spelled out again in the CLI's topology module", () => {
    const compiled = readFileSync(
      new URL("../build/topology.js", import.meta.url),
      "utf8",
    );
    // Quoted string literals only: doc comments name it in backticks.
    assert.doesNotMatch(compiled, /["']glide\.installation\.production["']/);
    assert.match(
      compiled,
      /import\s*\{[^}]*\bPRODUCTION_PROPERTY\b[^}]*\}\s*from\s*"@tessera\/doctor"/,
    );
  });
});

describe("createGuardProbe", () => {
  const ref = { name: "dev", host: "dev.service-now.com" };

  /** A probe whose `readProperty` answers from a table of canned outcomes. */
  function stubProbe(answers) {
    return {
      readProperty: (name) =>
        Promise.resolve(
          answers[name] ?? { outcome: "undecidable", detail: "not stubbed" },
        ),
      readTable: () => Promise.reject(new Error("not used")),
      reachApi: () => Promise.reject(new Error("not used")),
    };
  }

  /**
   * A bound probe whose two §11.2 rows are both `found` and hold the given
   * values. `detail` carries the value the way `@tessera/doctor`'s own probe
   * writes it (`name=value`), so a test that asserts nothing instance-authored
   * escapes has a real string to escape.
   */
  function foundBoth(production, runner) {
    return createGuardProbe([
      {
        ref,
        probe: stubProbe({
          "glide.installation.production": {
            outcome: "found",
            value: production,
            detail: `glide.installation.production=${production || "(empty)"}`,
          },
          "sn_atf.runner.enabled": {
            outcome: "found",
            value: runner,
            detail: `sn_atf.runner.enabled=${runner || "(empty)"}`,
          },
        }),
      },
    ]);
  }

  it("reads both §11.2 properties as booleans", async () => {
    const probe = createGuardProbe([
      {
        ref,
        probe: stubProbe({
          "glide.installation.production": {
            outcome: "found",
            value: "TRUE",
            detail: "found",
          },
          "sn_atf.runner.enabled": {
            outcome: "found",
            value: "false",
            detail: "found",
          },
        }),
      },
    ]);
    assert.deepEqual(await probe(ref), {
      productionProperty: true,
      atfRunnerEnabled: false,
    });
  });

  it("maps an absent property to `unreachable`, never to false (OPP-1b)", async () => {
    // The Table API renders a genuinely-unset property and an ACL-trimmed one
    // identically, so "no row" is not evidence that this is not production.
    const probe = createGuardProbe([
      {
        ref,
        probe: stubProbe({
          "glide.installation.production": {
            outcome: "absent",
            detail: "no readable row",
          },
          "sn_atf.runner.enabled": {
            outcome: "denied",
            detail: "403",
          },
        }),
      },
    ]);
    const result = await probe(ref);
    assert.equal(result.productionProperty, undefined);
    assert.equal(result.atfRunnerEnabled, undefined);
    assert.equal(result.unreachable.length, 2);
    assert.match(
      result.unreachable.join("\n"),
      /glide.installation.production/,
    );
  });

  // ── the fail-closed reading of a `found` row ────────────────────────────
  //
  // The four below are the ruling of 2026-09-03: a value that cannot be
  // interpreted must not silently license a write. They are properties, not
  // wording — each names the thing that breaks if it stops holding.

  it("reads the vocabulary `@tessera/doctor` decides on: only `true` enables the runner", async () => {
    // The guard and the doctor have to read the runner row the same way: when
    // they did not ("1" enabled to one, unreadable to the other), the guard
    // never looked at a host the doctor was about to write to. Wave 16 moved
    // both onto `@tessera/types`' `ATF_RUNNER_SAFE_DIRECTION`: only an exact
    // (trimmed, case-folded) `true` is an enabled runner.
    for (const value of ["true", "TRUE", " true "]) {
      const result = await foundBoth(value, value)(ref);
      assert.equal(result.productionProperty, true, value);
      assert.equal(result.atfRunnerEnabled, true, value);
      assert.equal(result.unreachable, undefined, value);
    }
  });

  it('reads "1" and "yes" as a not-enabled runner and as production (wave 16)', async () => {
    // Before wave 16 these two were in a local truthiness set copied from
    // the doctor, which read them as enabled. The doctor now reads them as
    // not ready (only `true` licenses "enabled"), so the guard must fail
    // closed on them too: runner `false`, production `true`, each with the
    // fail-closed note — neither is the value that states either reading.
    for (const value of [" 1 ", "yes", "YES"]) {
      const result = await foundBoth(value, value)(ref);
      assert.equal(result.productionProperty, true, value);
      assert.equal(result.atfRunnerEnabled, false, value);
      assert.equal(result.unreachable.length, 2, value);
      assert.match(
        result.unreachable.join("\n"),
        /sn_atf\.runner\.enabled: found, but .* read as false \(fail closed\)/,
        value,
      );
    }
  });

  /** A bound probe answering the runner property with `runnerRead`. */
  function runnerProbe(runnerRead, productionRead) {
    return createGuardProbe([
      {
        ref,
        probe: stubProbe({
          "glide.installation.production": productionRead ?? {
            outcome: "found",
            value: "false",
            detail: "glide.installation.production=false",
          },
          "sn_atf.runner.enabled": runnerRead,
        }),
      },
    ]);
  }

  it("reads differing runner rows as not enabled (the safe direction), never by row order", async () => {
    // `@tessera/doctor`'s probe gives the runner property no safe direction
    // of its own, so differing rows arrive as `undecidable` WITH the rows.
    // Under `ATF_RUNNER_SAFE_DIRECTION` a row that is not `true` settles it.
    for (const values of [
      ["true", "false"],
      ["false", "true"],
      ["true", "1"],
    ]) {
      const result = await runnerProbe({
        outcome: "undecidable",
        duplicates: "differing",
        rows: values.map((value, i) => ({ sysId: `r${i}`, value })),
        detail: "sn_atf.runner.enabled has 2 rows with differing values",
      })(ref);
      assert.equal(result.atfRunnerEnabled, false, JSON.stringify(values));
      assert.match(
        result.unreachable.join("\n"),
        /sn_atf\.runner\.enabled: 2 rows with differing values — read as false \(fail closed\)/,
      );
      assert.equal(result.productionProperty, false);
    }
  });

  it("keeps an incomplete runner read without rows undecidable (no boolean, a warning)", async () => {
    const result = await runnerProbe({
      outcome: "undecidable",
      detail: "sn_atf.runner.enabled: 1 of 2 rows read; no value is read",
    })(ref);
    assert.equal(result.atfRunnerEnabled, undefined);
    assert.match(result.unreachable.join("\n"), /1 of 2 rows read/);
  });

  it("reads identical duplicate runner rows `true` as enabled, with no note", async () => {
    const result = await runnerProbe({
      outcome: "found",
      value: "true",
      duplicates: "identical",
      rows: [
        { sysId: "r0", value: "true" },
        { sysId: "r1", value: " TRUE" },
      ],
      detail: "sn_atf.runner.enabled=true (2 identical rows)",
    })(ref);
    assert.equal(result.atfRunnerEnabled, true);
    assert.equal(result.unreachable, undefined);
  });

  it("reads a found production value from its rows, never only from the winner", async () => {
    // A `found` read with rows is re-decided from the rows under
    // `PRODUCTION_SAFE_DIRECTION`: even a stub (or a future doctor) that named
    // the `false` row as the winner cannot clear rows that differ.
    const result = await runnerProbe(
      {
        outcome: "found",
        value: "true",
        detail: "sn_atf.runner.enabled=true",
      },
      {
        outcome: "found",
        value: "false",
        duplicates: "differing",
        rows: [
          { sysId: "p0", value: "false" },
          { sysId: "p1", value: "garbage" },
        ],
        detail: "glide.installation.production has 2 rows",
      },
    )(ref);
    assert.equal(result.productionProperty, true);
    assert.equal(result.atfRunnerEnabled, true);
  });

  it("an undecidable differing read of rows that all read the licensing value stays undecidable", async () => {
    // Defensive: normalisation makes these agree, which a complete read never
    // reports as `differing`; no direction settles "all licensing", so the
    // guard gets no boolean rather than an enabled runner.
    const result = await runnerProbe({
      outcome: "undecidable",
      duplicates: "differing",
      rows: [{ value: "true" }, { value: " TRUE " }],
      detail: "odd",
    })(ref);
    assert.equal(result.atfRunnerEnabled, undefined);
    assert.ok(result.unreachable.length >= 1);
  });

  it("fails closed on an uninterpretable value, per property direction", async () => {
    // The guard downgrades on `productionProperty === true` and on
    // `atfRunnerEnabled === false`, so "the reading that downgrades" is a
    // different boolean for each property. A single hard-coded `false` here
    // would clear the production marker instead of failing closed on it.
    for (const value of ["", "0", "no", "off", "maybe", "2"]) {
      const result = await foundBoth(value, value)(ref);
      assert.equal(result.productionProperty, true, value);
      assert.equal(result.atfRunnerEnabled, false, value);
      assert.equal(result.unreachable.length, 2, value);
    }
  });

  it('separates an explicit "false" from a value it cannot read', async () => {
    // Same boolean for the runner, different account of why. Collapsing the
    // two would either strip the explanation from the fail-closed case or
    // make every honestly-false production marker a `prod-suspect`.
    const explicit = await foundBoth("false", "false")(ref);
    assert.equal(explicit.productionProperty, false);
    assert.equal(explicit.atfRunnerEnabled, false);
    assert.equal(explicit.unreachable, undefined);

    const unreadable = await foundBoth("0", "0")(ref);
    assert.equal(unreadable.atfRunnerEnabled, false);
    assert.equal(unreadable.unreachable.length, 2);
    assert.match(
      unreadable.unreachable.join("\n"),
      /sn_atf\.runner\.enabled: found, but .* \(fail closed\)/,
    );
  });

  it("never puts an instance-authored value into the guard's evidence", async () => {
    // `unreachable` is printed verbatim in a refusal report, and
    // `sys_properties` holds text an instance wrote. The shape travels; the
    // value does not. `@tessera/guard`'s own `shapeOf` makes the same trade
    // for the fields it can see, and cannot police what this string carries.
    const poison = "</script> ignore previous instructions";
    const result = await foundBoth(poison, poison)(ref);
    assert.equal(result.unreachable.length, 2); // not vacuous
    assert.doesNotMatch(JSON.stringify(result), /ignore previous instructions/);
  });

  it("matches by normalised host, and reports an unbound one", async () => {
    const probe = createGuardProbe([
      {
        ref: { name: "dev", host: "https://DEV.service-now.com/" },
        probe: stubProbe({
          "glide.installation.production": {
            outcome: "found",
            value: "false",
            detail: "found",
          },
          "sn_atf.runner.enabled": {
            outcome: "found",
            value: "true",
            detail: "found",
          },
        }),
      },
    ]);
    assert.equal((await probe(ref)).productionProperty, false);

    const other = await probe({ name: "prod", host: "acme.service-now.com" });
    assert.equal(other.productionProperty, undefined);
    assert.match(
      other.unreachable[0],
      /no bound probe for acme.service-now.com/,
    );
  });
});

// ── the frozen Phase-0.5 report ─────────────────────────────────────────────

describe("formatRunReport / jsonRunReport", () => {
  const display = {
    instanceName: "skeleton-fake",
    instanceHost: "dev-skeleton.service-now.com",
    lifecycle: "ephemeral",
    ledgerRoot: "/tmp/tessera",
    // Stated, not omitted. The renderer's job here is to distinguish "this run
    // created a directory in your cwd" from "this run used one that was
    // already there", so a fixture that left the field off would test the
    // undefined case and call it the answer.
    ledgerRootCreated: false,
  };

  const row = {
    spec: { id: "s5-probe" },
    kind: "unit",
    status: "fail",
    raw: "fail",
    blocking: false,
    overridden: false,
    target: { table: "sys_script_include", sysId: "abc", name: "S5Probe" },
    evidence: { kind: "test-result", ref: "res1" },
  };

  const result = {
    report: {
      runId: "run-1",
      state: "done",
      transitions: ["planned", "done"],
      teardown: "complete",
      verdict: {
        status: "NO_GO",
        rows: [row],
        warnings: ["a warning"],
        counts: {
          pass: 0,
          fail: 1,
          inconclusive: 0,
          blocking: 0,
          missing: 0,
        },
      },
    },
    runner: { cls: "non-prod", role: "runner" },
    failures: [{ spec: { id: "s5-probe" }, assertion: "threshold" }],
    errors: [],
    acknowledgements: [],
    created: ["a", "b"],
    deleted: ["a", "b"],
  };

  it("puts the verdict, the counts and the failing assertion in the text", () => {
    const text = formatRunReport(result, display);
    assert.match(text, /^VERDICT:\s+NO_GO$/m);
    assert.match(text, /pass=0 fail=1/);
    assert.match(text, /- s5-probe: threshold/);
    assert.match(text, /\[FAIL\s+\] s5-probe \(unit\)/);
    assert.match(text, /evidence: test-result:res1/);
    // A non-blocking row must say so; the flag changes what the gate does.
    assert.match(text, /non-blocking/);
  });

  it("says so when nothing was planned instead of printing an empty list", () => {
    const empty = {
      ...result,
      report: {
        ...result.report,
        verdict: { ...result.report.verdict, rows: [], warnings: [] },
      },
      failures: [],
    };
    assert.match(
      formatRunReport(empty, display),
      /no rows — nothing was planned/,
    );
  });

  it("renders the stage failure and the DEV-1 errors when present", () => {
    const broken = {
      ...result,
      errors: ["ECONNRESET"],
      report: {
        ...result.report,
        failure: { stage: "projecting", message: "boom" },
      },
    };
    const text = formatRunReport(broken, display);
    assert.match(text, /infrastructure errors \(DEV-1\)/);
    assert.match(text, /- ECONNRESET/);
    assert.match(text, /stage failure: \[projecting\] boom/);
  });

  it("names the reporter and the event when a reporter refused one", () => {
    const noisy = {
      ...result,
      report: {
        ...result.report,
        reporterEventFaults: [
          { reporter: "reporters[1]", event: "spec-end", message: "disk full" },
        ],
      },
    };
    const text = formatRunReport(noisy, display);
    // Which reporter is half the diagnostic: with three artifacts written, "an
    // event was refused" cannot answer which one is short a row.
    assert.match(text, /reporter faults/);
    assert.match(text, /reporters\[1\] refused spec-end: disk full/);
  });

  it("reports a reporter fault ALONGSIDE a stage failure, not instead of it", () => {
    // The two used to compete for one slot under first-writer-wins, and the
    // reporter always lost — a run with both reported the reporter nowhere.
    const both = {
      ...result,
      report: {
        ...result.report,
        failure: { stage: "projecting", message: "boom" },
        reporterEventFaults: [
          { reporter: "reporters[0]", event: "run-end", message: "closed" },
        ],
      },
    };
    const text = formatRunReport(both, display);
    assert.match(text, /stage failure: \[projecting\] boom/);
    assert.match(text, /reporters\[0\] refused run-end: closed/);

    const parsed = JSON.parse(jsonRunReport(both, display));
    assert.equal(parsed.failure.stage, "projecting");
    assert.deepEqual(parsed.reporterEventFaults, [
      { reporter: "reporters[0]", event: "run-end", message: "closed" },
    ]);
  });

  it("omits the reporter-fault key entirely when no reporter threw", () => {
    // Absent rather than [], for the same reason `failure` is absent rather
    // than null: an empty array is a claim that the run was checked and clean,
    // and this field is only written when there was something to write.
    const parsed = JSON.parse(jsonRunReport(result, display));
    assert.equal("reporterEventFaults" in parsed, false);
    assert.doesNotMatch(formatRunReport(result, display), /reporter faults/);
  });

  it("emits the same facts as parseable JSON", () => {
    const parsed = JSON.parse(jsonRunReport(result, display));
    assert.equal(parsed.runId, "run-1");
    assert.deepEqual(parsed.instance, {
      name: display.instanceName,
      host: display.instanceHost,
    });
    assert.equal(parsed.verdict.status, "NO_GO");
    assert.deepEqual(parsed.created, ["a", "b"]);
    // Absent rather than null: the shape says "there was no stage failure".
    assert.equal("failure" in parsed, false);
    // The local-disk write, by value. `ledgerRoot` is a path and a path is true
    // either way, so the document used to describe writes to the RUNNER while
    // saying nothing about the one it made on the caller's own machine.
    assert.equal(parsed.ledgerRootCreated, false);
  });

  it("says which of the two things it did to the caller's own disk", () => {
    // Both values, on the same fixture: the field is only worth having if it
    // can be false, and only worth trusting if it can be true.
    const created = { ...display, ledgerRootCreated: true };
    assert.equal(
      JSON.parse(jsonRunReport(result, created)).ledgerRootCreated,
      true,
    );
    assert.match(
      formatRunReport(result, created),
      /^ledger: +\/tmp\/tessera \(created by this run\)$/m,
    );
    assert.match(
      formatRunReport(result, display),
      /^ledger: +\/tmp\/tessera$/m,
    );
  });

  it("carries a stage failure into the JSON when there was one", () => {
    const parsed = JSON.parse(
      jsonRunReport(
        {
          ...result,
          report: {
            ...result.report,
            failure: { stage: "running", message: "timed out" },
          },
        },
        display,
      ),
    );
    assert.deepEqual(parsed.failure, {
      stage: "running",
      message: "timed out",
    });
  });

  // ── the exit code, in the report ──────────────────────────────────────────
  //
  // The frozen mapping has three statuses to say and two codes to say them in,
  // so a `1` out of this command means NO_GO or INCONCLUSIVE and does not say
  // which. That was true before and stated only in a header comment, which is
  // the DEV-4 defect: a claim with no consumer that can notice its absence.

  /** The same fixture at another verdict — the only field these read. */
  const at = (status) => ({
    ...result,
    report: {
      ...result.report,
      verdict: { ...result.report.verdict, status },
    },
  });

  it("states the code the run is about to exit with, in both branches", () => {
    // Literal numbers rather than EXIT_CODES lookups: the freeze is these two
    // values, and a table this test read from could move together with them.
    for (const [status, code] of [
      ["GO", 0],
      ["NO_GO", 1],
      ["INCONCLUSIVE", 1],
    ]) {
      assert.equal(
        JSON.parse(jsonRunReport(at(status), display)).verdict.exitCode,
        code,
        status,
      );
      assert.match(
        formatRunReport(at(status), display),
        RegExp(`^exit: +${code}\\b`, "m"),
        status,
      );
    }
  });

  it("says when that code collapsed two different answers into one (QA-9)", () => {
    // Both values on the same fixture: the field is only worth having if it can
    // be false, and only worth trusting if it can be true. Compared by value,
    // never by key presence — a regression that dropped the field would satisfy
    // `"exitCodeCollapsed" in verdict` by leaving `undefined` behind.
    const collapsed = (status) =>
      JSON.parse(jsonRunReport(at(status), display)).verdict.exitCodeCollapsed;
    assert.equal(collapsed("INCONCLUSIVE"), true);
    assert.equal(collapsed("NO_GO"), false);
    assert.equal(collapsed("GO"), false);

    // The human branch says the same thing in its own words.
    const note = /^NOTE$/m;
    assert.match(formatRunReport(at("INCONCLUSIVE"), display), note);
    assert.match(
      formatRunReport(at("INCONCLUSIVE"), display),
      /cannot tell/,
      "the NOTE has to say what the number cannot distinguish",
    );
    assert.doesNotMatch(formatRunReport(at("NO_GO"), display), note);
    assert.doesNotMatch(formatRunReport(at("GO"), display), note);
  });

  it("does not let the two branches disagree about one run", () => {
    // DEV-4 exists because a human line and a `--json` document said different
    // things about the same run. The assertion here is the agreement itself, so
    // an edit to either branch alone fails.
    for (const status of ["GO", "NO_GO", "INCONCLUSIVE"]) {
      const text = formatRunReport(at(status), display);
      const verdict = JSON.parse(jsonRunReport(at(status), display)).verdict;
      const printed = /^exit: +(\d+)/m.exec(text);
      assert.notEqual(printed, null, `no exit line for ${status}`);
      assert.equal(Number(printed[1]), verdict.exitCode, status);
      assert.equal(/^NOTE$/m.test(text), verdict.exitCodeCollapsed, status);
      assert.match(text, RegExp(`^VERDICT: +${status}$`, "m"));
      assert.equal(verdict.status, status);
    }
  });

  it("adds the exit facts to the verdict without replacing the rest of it", () => {
    // The two keys arrive by spreading the pipeline's verdict; a spread written
    // the other way round would drop the checklist the verdict is evidence for.
    const verdict = JSON.parse(jsonRunReport(result, display)).verdict;
    assert.deepEqual(verdict.counts, result.report.verdict.counts);
    assert.deepEqual(verdict.warnings, result.report.verdict.warnings);
    assert.equal(verdict.rows.length, 1);
  });
});

// ── the frozen Phase-0.5 exit mapping ───────────────────────────────────────

describe("runExitDisposition", () => {
  it("maps every verdict status onto the two Phase-0.5 codes and no others", () => {
    // FROZEN. A CI job pinned to this command was written against 0/1 and must
    // not start seeing a 5 because Phase 1 grew one.
    assert.equal(runExitDisposition("GO").code, 0);
    assert.equal(runExitDisposition("NO_GO").code, 1);
    assert.equal(runExitDisposition("INCONCLUSIVE").code, 1);
    assert.notEqual(
      runExitDisposition("INCONCLUSIVE").code,
      EXIT_CODES.inconclusive,
      "widening the skeleton mapping to the Phase-1 code breaks pinned CI",
    );
    assert.deepEqual(
      new Set(
        ["GO", "NO_GO", "INCONCLUSIVE"].map((s) => runExitDisposition(s).code),
      ),
      new Set([0, 1]),
    );
  });

  it("reports the distinction the code cannot carry", () => {
    assert.equal(runExitDisposition("INCONCLUSIVE").collapsed, true);
    assert.equal(runExitDisposition("NO_GO").collapsed, false);
    assert.equal(runExitDisposition("GO").collapsed, false);
  });

  it("derives the collapse from the mapping, not from a list of statuses", () => {
    // A status this build has never heard of stands in for the fourth one a
    // future PLAN phase adds: it must be collapsed onto 1 AND reported as
    // collapsed, without an edit here. A function that special-cased
    // "INCONCLUSIVE" would return false and quietly under-report.
    const future = runExitDisposition("SOMETHING_NEW");
    assert.equal(future.code, 1);
    assert.equal(future.collapsed, true);
  });
});

// Delegated decision 2026-09-25 — review W3a finding 3: `parseInteger` took
// `Number(raw)`, so "3e9" (clamped by setTimeout to 1 ms), "0x10" and "1e3"
// were accepted. Digits only, 1..2147483647, else usage (exit 2).
describe("run — millisecond flags are bounded decimal integers", () => {
  for (const flag of ["--run-timeout-ms", "--poll-interval-ms"]) {
    for (const raw of [
      "3e9",
      "3000000000",
      "2147483648",
      "1e308",
      "0x10",
      "1e3",
      "1.5",
      "0",
      "+5",
      " 5",
    ]) {
      it(`exits 2 on ${flag}=${JSON.stringify(raw)}`, async () => {
        const cap = capture();
        assert.equal(
          await main(["run", "--skeleton", "--fake", flag, raw], cap.context),
          EXIT_CODES.usage,
        );
        assert.match(cap.stderrText(), /expects a positive integer/);
        assert.deepEqual(cap.out, []);
      });
    }
  }
});
