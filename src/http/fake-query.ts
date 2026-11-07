/**
 * The encoded-query interpreter behind the in-memory test client
 * (`src/http/fake.ts`). It exists so that a check whose query names the wrong
 * field or operator gets the rows the instance would return, instead of every
 * seeded row.
 *
 * It models ServiceNow's grammar, not a convenient reading of it:
 *
 * - Precedence is `^NQ`, then `^`, then `^OR`: `^OR` binds tightest, so
 *   `a=1^b=2^ORb=3` means `a=1 AND (b=2 OR b=3)`, and `^NQ` starts a whole new
 *   query whose rows are added to the result.
 * - Comparisons are case-insensitive, the platform's default collation.
 * - `!=` follows SQL: a row with an empty value matches neither `=` nor `!=`.
 *   Pair it with `^ORfieldISEMPTY` to keep empties.
 *
 * It is **strict** by design. The operators are exactly the ones production
 * code emits or the query builders in `query.ts` are documented to produce;
 * anything else throws {@link FakeQueryError}, so a test cannot pass on a query
 * the model does not understand. Extend the operator table here when production
 * starts emitting a new one, and verify the new semantics against an instance.
 */

/** A query the interpreter cannot model — always a bug in the code under test. */
export class FakeQueryError extends Error {
  constructor(query: string, detail: string) {
    super(`Unsupported encoded query "${query}": ${detail}.`);
    this.name = "FakeQueryError";
  }
}

/** Reads a field off a raw row as the plain string the platform compares. */
export type FieldReader = (
  row: Record<string, unknown>,
  field: string,
) => string;

const TERM =
  /^([a-z0-9_.]+?)(ISNOTEMPTY|ISEMPTY|RELATIVEGE|STARTSWITH|LIKE|IN|!=|=)(.*)$/;
const ORDER = /^ORDERBY(DESC)?([a-z0-9_.]+)$/;
const RELATIVE = /^@(minute|hour|day)@ago@(\d+)$/;
const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

interface Term {
  field: string;
  op: string;
  value: string;
}

interface Order {
  field: string;
  descending: boolean;
}

/** A parsed query: OR of `^NQ` branches, each an AND of `^OR` groups of terms. */
export interface ParsedQuery {
  branches: Term[][][];
  order: Order[];
}

function parseTerm(query: string, token: string): Term {
  const match = TERM.exec(token);
  if (!match) {
    throw new FakeQueryError(query, `cannot interpret term "${token}"`);
  }
  const [, field, op, value] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  if ((op === "ISEMPTY" || op === "ISNOTEMPTY") && value !== "") {
    throw new FakeQueryError(query, `${op} takes no value, got "${value}"`);
  }
  if (op === "RELATIVEGE" && !RELATIVE.test(value)) {
    throw new FakeQueryError(query, `cannot interpret RELATIVEGE "${value}"`);
  }
  return { field, op, value };
}

/** Parse `query`, throwing {@link FakeQueryError} on anything unsupported. */
export function parseEncodedQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { branches: [], order: [] };
  for (const branch of query.split("^NQ")) {
    const groups: Term[][] = [];
    for (const token of branch.split("^")) {
      if (token === "EQ") continue;
      const order = ORDER.exec(token);
      if (order) {
        parsed.order.push({
          field: order[2] as string,
          descending: order[1] !== undefined,
        });
      } else if (token.startsWith("OR")) {
        const group = groups[groups.length - 1];
        if (!group) {
          throw new FakeQueryError(query, `"${token}" has nothing to OR with`);
        }
        group.push(parseTerm(query, token.slice(2)));
      } else {
        groups.push([parseTerm(query, token)]);
      }
    }
    parsed.branches.push(groups);
  }
  return parsed;
}

/** Epoch millis of a `yyyy-MM-dd HH:mm:ss` UTC value; `NaN` when it is not one. */
function parseDateTime(value: string): number {
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

function matchesTerm(actual: string, term: Term, now: number): boolean {
  const have = actual.toLowerCase();
  const want = term.value.toLowerCase();
  switch (term.op) {
    case "=":
      return have === want;
    case "!=":
      return have !== "" && have !== want;
    case "IN":
      return want.split(",").includes(have);
    case "LIKE":
      return want !== "" && have.includes(want);
    case "STARTSWITH":
      return want !== "" && have.startsWith(want);
    case "ISEMPTY":
      return have === "";
    case "ISNOTEMPTY":
      return have !== "";
    default: {
      // RELATIVEGE: the shape was validated when the term was parsed.
      const [, unit, amount] = RELATIVE.exec(term.value) as RegExpExecArray;
      const since =
        now - Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS];
      return parseDateTime(actual) >= since;
    }
  }
}

/**
 * The rows of `rows` an instance would return for `query`, in its order.
 * `read` turns a raw row into comparable values; `now` anchors relative dates.
 */
export function applyEncodedQuery(
  query: string,
  rows: readonly Record<string, unknown>[],
  read: FieldReader,
  now: number,
): Record<string, unknown>[] {
  const { branches, order } = parseEncodedQuery(query);
  const matched = rows.filter((row) =>
    branches.some((groups) =>
      groups.every((group) =>
        group.some((term) => matchesTerm(read(row, term.field), term, now)),
      ),
    ),
  );
  // Later keys only break ties, so sort by them first; `sort` is stable.
  for (const { field, descending } of [...order].reverse()) {
    matched.sort((a, b) => {
      const [x, y] = [read(a, field), read(b, field)];
      const rank = x < y ? -1 : x > y ? 1 : 0;
      return descending ? -rank : rank;
    });
  }
  return matched;
}
