import type { CheckResult, PreflightReport } from "../types.js";
import type { NamedReport } from "./junit.js";

/** Options for the Markdown reporter. */
export interface MarkdownOptions {
  /**
   * Leading text of each block heading. Defaults to `servicenow-preflight`;
   * the instance name and the verdict always follow it.
   */
  title?: string;
}

/** Pass rows beyond this count are folded into a `<details>` element. */
const PASS_FOLD_THRESHOLD = 5;

const DEFAULT_TITLE = "servicenow-preflight";

/**
 * Make arbitrary text safe inside one GitHub-flavoured Markdown table cell: a
 * raw `|` would split the cell, a newline would end the row, `<` / `>` could
 * open HTML, and a backtick could break the code span the check name sits in.
 */
function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "'");
}

/** Status icon; an unknown status renders as a failure (the runner counts it as one). */
function icon(status: string): string {
  if (status === "pass") return "✅";
  if (status === "warn") return "⚠️";
  return "❌";
}

/** Sort rank: fail (and unknown) first, then warn, then pass. */
function rank(status: string): number {
  if (status === "pass") return 2;
  if (status === "warn") return 1;
  return 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function table(rows: readonly CheckResult[]): string {
  const lines = ["| | Check | Result |", "|---|---|---|"];
  for (const r of rows) {
    lines.push(
      `| ${icon(r.status)} | \`${escapeMarkdownCell(r.name)}\` | ${escapeMarkdownCell(r.message)} |`,
    );
  }
  return lines.join("\n");
}

/** Render one report as a Markdown block (no trailing newline). */
function block(
  report: PreflightReport,
  instance: string | undefined,
  opts: MarkdownOptions | undefined,
): string {
  const title = escapeMarkdownCell(opts?.title ?? DEFAULT_TITLE);
  const target = escapeMarkdownCell(instance ?? "preflight");
  const verdict = report.ok ? "✅ passed" : "❌ failed";
  const { pass, warn, fail } = report.summary;
  const parts = [
    `### ${title} — ${target} — ${verdict}`,
    `**${pass} passed, ${plural(warn, "warning")}, ${fail} failed**`,
  ];

  if (report.results.length === 0) {
    parts.push("_No checks ran._");
    return parts.join("\n\n");
  }

  // Stable sort: the failure is visible without scrolling, run order is kept
  // within each status group.
  const sorted = report.results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.status) - rank(b.r.status) || a.i - b.i)
    .map(({ r }) => r);
  const passes = sorted.filter((r) => r.status === "pass");
  const others = sorted.filter((r) => r.status !== "pass");

  if (passes.length <= PASS_FOLD_THRESHOLD) {
    parts.push(table(sorted));
  } else {
    if (others.length > 0) parts.push(table(others));
    parts.push(
      `<details><summary>${passes.length} passed</summary>\n\n${table(passes)}\n\n</details>`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Format a report as GitHub-flavoured Markdown, suitable for a pull-request
 * comment (`gh pr comment --body-file`). Rows are ordered fail → warn → pass;
 * more than five pass rows are folded into a `<details>` element.
 */
export function formatMarkdown(
  report: PreflightReport,
  instance?: string,
  opts?: MarkdownOptions,
): string {
  return `${block(report, instance, opts)}\n`;
}

/**
 * Format several instance reports as one Markdown document: a one-line
 * roll-up (`**dev** ✅ · **test** ❌`) followed by one block per instance.
 */
export function formatMarkdownAll(
  named: readonly NamedReport[],
  opts?: MarkdownOptions,
): string {
  const rollup = named
    .map(
      (n) => `**${escapeMarkdownCell(n.name)}** ${n.report.ok ? "✅" : "❌"}`,
    )
    .join(" · ");
  const blocks = named.map((n) => block(n.report, n.name, opts));
  return `${[rollup, ...blocks].join("\n\n")}\n`;
}
