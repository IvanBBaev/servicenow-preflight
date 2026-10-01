// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// [OPEN] — THE ONE GUESSED CONTRACT IN THIS PACKAGE. Spike 2b established
// WHERE per-test attribution comes from (`sys_atf_test_result`, queried by
// `test=<sysId>` ordered by `sys_created_on` desc, reading `status` + `output`)
// but NOT the byte-level wording of `output` for a "Run Server Side Script"
// step's `assertEqual` calls. Nothing in this repo captures it.
//
// So this module is the single place the wording lives: `formatAssertionLine`
// writes it (the Tier-2 substrate in `tier2.ts` uses it, standing in for the
// ATF engine) and `parseAssertionOutput` reads it (the Runner uses it, against
// whatever a real instance wrote). Reconciling with a live capture means
// editing the patterns HERE and nowhere else.
//
// Because writer and reader are the same guess, the green/red pair proves that
// per-assertion attribution FLOWS end to end — it does not prove the wording.
// The parser is therefore deliberately tolerant of several plausible shapes,
// and an unparsable `output` degrades to "the suite failed" honestly rather
// than silently reporting zero failed assertions.

/** One `assertEqual` call's result, as the skeleton models it. */
export interface AssertionOutcome {
  readonly name: string;
  readonly passed: boolean;
  /** Human detail — expected/actual, or the thrown error. */
  readonly detail?: string;
}

export interface ParsedAtfOutput {
  readonly assertions: readonly AssertionOutcome[];
  /** Lines the patterns below did not recognise — surfaced, never dropped. */
  readonly unparsed: readonly string[];
}

/** Emitted for a step that threw before/while asserting. */
export const STEP_ERROR_PREFIX = "Step error:";

/**
 * Canonical line shapes. `PASS_PATTERNS`/`FAIL_PATTERNS` are tried in order;
 * capture group 1 is the assertion name.
 */
const PASS_PATTERNS: readonly RegExp[] = [
  /^assertion\s+passed\s*:\s*(.+)$/i,
  /^\[?(?:pass|passed|ok|success)\]?\s*[-:]\s*(.+)$/i,
];

const FAIL_PATTERNS: readonly RegExp[] = [
  /^assertion\s+failed\s*:\s*(.+)$/i,
  /^\[?(?:fail|failed|failure)\]?\s*[-:]\s*(.+)$/i,
];

/** Separator between an assertion name and its expected/actual detail. */
const DETAIL_SEPARATOR = " -- ";

function splitDetail(rest: string): { name: string; detail?: string } {
  const at = rest.indexOf(DETAIL_SEPARATOR);
  if (at === -1) return { name: rest.trim() };
  return {
    name: rest.slice(0, at).trim(),
    detail: rest.slice(at + DETAIL_SEPARATOR.length).trim(),
  };
}

/** Render one assertion the way `parseAssertionOutput` reads it back. */
export function formatAssertionLine(outcome: AssertionOutcome): string {
  const head = outcome.passed ? "Assertion passed: " : "Assertion failed: ";
  const detail =
    outcome.detail === undefined || outcome.detail === ""
      ? ""
      : `${DETAIL_SEPARATOR}${outcome.detail}`;
  return `${head}${outcome.name}${detail}`;
}

/** Render a whole step's `output` column. */
export function formatAtfOutput(
  outcomes: readonly AssertionOutcome[],
  trailer?: string,
): string {
  const lines = outcomes.map(formatAssertionLine);
  if (trailer !== undefined && trailer !== "") lines.push(trailer);
  return lines.join("\n");
}

/** Read `sys_atf_test_result.output` back into per-assertion outcomes. */
export function parseAssertionOutput(output: string): ParsedAtfOutput {
  const assertions: AssertionOutcome[] = [];
  const unparsed: string[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    let matched = false;
    for (const pattern of PASS_PATTERNS) {
      const hit = pattern.exec(line);
      if (hit?.[1] === undefined) continue;
      const { name, detail } = splitDetail(hit[1]);
      assertions.push({ name, passed: true, ...(detail ? { detail } : {}) });
      matched = true;
      break;
    }
    if (matched) continue;

    for (const pattern of FAIL_PATTERNS) {
      const hit = pattern.exec(line);
      if (hit?.[1] === undefined) continue;
      const { name, detail } = splitDetail(hit[1]);
      assertions.push({ name, passed: false, ...(detail ? { detail } : {}) });
      matched = true;
      break;
    }
    if (!matched) unparsed.push(line);
  }

  return { assertions, unparsed };
}

/** Names of the assertions that failed, in report order. */
export function failedAssertionNames(
  parsed: ParsedAtfOutput,
): readonly string[] {
  return parsed.assertions
    .filter((assertion) => !assertion.passed)
    .map((assertion) => assertion.name);
}
