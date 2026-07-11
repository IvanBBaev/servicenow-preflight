import type { Check, CheckResult, PreflightContext } from "../types.js";
import { SnAuthError, SnHttpError, SnNetworkError } from "../http/client.js";
import { and, eq, resolveScope } from "../http/query.js";

const NAME = "i18n-completeness";

/**
 * A translation table scanned for coverage, paired with the columns that
 * (together with `language`) identify one translatable unit.
 *
 * Coverage is measured **per key, not per row**: two languages can hold the
 * same number of rows yet translate a different set of strings, so a row-count
 * comparison would call a genuine gap "complete". We collect the set of keys
 * each language actually translates and compare the sets.
 */
interface TranslationTable {
  table: string;
  /** Language-independent identity columns of one translatable unit. */
  keyColumns: readonly string[];
}

/**
 * The tables ServiceNow stores translated strings in, each with its own key
 * column(s). `sys_documentation` (labels/help), `sys_choice` (choice labels)
 * and `sys_translated` were added so field labels and choice lists count toward
 * completeness, not just messages and translated text (SN-7).
 */
const TRANSLATION_TABLES: readonly TranslationTable[] = [
  // Record/field value translations.
  {
    table: "sys_translated_text",
    keyColumns: ["tablename", "documentkey", "fieldname"],
  },
  // UI messages (getMessage / ${...}).
  { table: "sys_ui_message", keyColumns: ["key"] },
  // Dictionary labels, hints and help text.
  { table: "sys_documentation", keyColumns: ["name", "element"] },
  // Choice-list labels.
  { table: "sys_choice", keyColumns: ["name", "element", "value"] },
  // Generic translated strings.
  {
    table: "sys_translated",
    keyColumns: ["tablename", "documentkey", "fieldname"],
  },
];

/** ASCII unit separator — will not appear inside a ServiceNow field value. */
const SEP = String.fromCharCode(31);

/** Build a small, well-formed result for this check. */
function result(status: CheckResult["status"], message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Read the configured target languages from `ctx.options.languages`. Accepts an
 * array of strings (or a comma-separated string) and normalises to trimmed,
 * de-duplicated, non-empty language codes. Returns `[]` when unset/unusable.
 */
function readLanguages(ctx: PreflightContext): string[] {
  const raw = ctx.options?.languages;
  let list: string[] = [];
  if (Array.isArray(raw)) {
    list = raw.filter((v): v is string => typeof v === "string");
  } else if (typeof raw === "string") {
    list = raw.split(",");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const code = item.trim();
    if (code && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

/**
 * The reference language whose key set defines the expected coverage
 * (`ctx.options.baseLanguage`). When set, every target language is compared
 * against it; when unset we infer the baseline from the union of every target
 * language's keys, which requires at least two languages to be meaningful.
 */
function readBaseLanguage(ctx: PreflightContext): string {
  const raw = ctx.options?.baseLanguage;
  return typeof raw === "string" ? raw.trim() : "";
}

/** Render a primitive cell (`string`/`number`/`boolean`) as a string, else `""`. */
function primitiveToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

/** Read one cell as a string, unwrapping a `{ value }` reference object. */
function cellValue(raw: unknown): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return primitiveToString((raw as { value?: unknown }).value);
  }
  return primitiveToString(raw);
}

/** The union of every language's key set. */
function unionKeys(coverage: readonly { keys: Set<string> }[]): Set<string> {
  const union = new Set<string>();
  for (const c of coverage) for (const key of c.keys) union.add(key);
  return union;
}

/**
 * Collect the set of translation keys present for `language` in the resolved
 * scope across the translation tables. Each key is the table name joined with
 * that table's identity-column values, so a UI message and a dictionary label
 * never collide even if their raw values coincide. Uses `ctx.http` (never
 * `fetch`).
 *
 * `scopeClause` is the shared resolver's single-term scope filter; the language
 * is charset-validated by {@link eq}, and the two are AND-composed by
 * {@link and}, so no config value ever reaches `sysparm_query` un-validated
 * (SR-1).
 */
async function collectKeys(
  ctx: PreflightContext,
  scopeClause: string,
  language: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const languageClause = and(scopeClause, eq("language", language));
  for (const { table, keyColumns } of TRANSLATION_TABLES) {
    const rows = await ctx.http.table(table).query({
      sysparm_query: languageClause,
      sysparm_fields: keyColumns.join(","),
    });
    for (const row of rows) {
      const composite = keyColumns.map((c) => cellValue(row[c])).join(SEP);
      keys.add(`${table}${SEP}${composite}`);
    }
  }
  return keys;
}

/**
 * Verifies translated strings are complete for the required languages. Every
 * configured target language must translate the same set of keys as the
 * baseline (the configured `options.baseLanguage`, or the union of every target
 * language's keys when none is configured). Coverage is per key, so a language
 * that translates a different — not merely smaller — set of strings is flagged.
 *
 * Status mapping:
 * - `warn` when the scope or the target-language list is unset (nothing to
 *   check), when there are no translatable strings at all (nothing to verify),
 *   or when the instance is unreachable / auth is degraded (cannot determine
 *   coverage — advisory, not a hard gate).
 * - `fail` when one or more target languages have missing keys, when the
 *   configured base language carries no strings while targets do (a
 *   misconfigured `baseLanguage`), or when the instance returns an HTTP error.
 * - `pass` when every target language covers the full baseline key set.
 */
export const i18nCompleteness: Check = {
  name: NAME,
  description: "Translations are complete for the required languages.",
  async run(ctx: PreflightContext): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No target scope set (PreflightContext.scope); skipping i18n completeness check.",
      );
    }

    const languages = readLanguages(ctx);
    if (languages.length === 0) {
      return result(
        "warn",
        "No target languages configured (options.languages); skipping i18n completeness check.",
      );
    }

    const baseLanguage = readBaseLanguage(ctx);
    if (!baseLanguage && languages.length < 2) {
      // A single target language with no explicit baseline compares only to
      // itself, which can never surface a gap. Refuse to give a false "pass".
      return result(
        "warn",
        `Only one target language ("${languages[0]}") and no options.baseLanguage set; cannot infer a coverage baseline to compare against.`,
      );
    }

    let coverage: { language: string; keys: Set<string> }[];
    let baseKeys = new Set<string>();
    try {
      // Resolve the scope once per run (cached on ctx, shared with other checks)
      // and thread its single-term clause into every per-language read.
      const scopeClause = (await resolveScope(ctx, scope)).clause;
      coverage = await Promise.all(
        languages.map(async (language) => ({
          language,
          keys: await collectKeys(ctx, scopeClause, language),
        })),
      );
      if (baseLanguage) {
        baseKeys = await collectKeys(ctx, scopeClause, baseLanguage);
      }
    } catch (err) {
      if (err instanceof SnAuthError) {
        return result(
          "warn",
          "Could not read translations: authentication failed or credentials are missing.",
        );
      }
      if (err instanceof SnNetworkError) {
        return result(
          "warn",
          "Could not read translations: the instance was unreachable.",
        );
      }
      if (err instanceof SnHttpError) {
        return result(
          "fail",
          `Could not read translations: the instance returned HTTP ${err.status}.`,
        );
      }
      return result(
        "fail",
        `Could not read translations: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }

    const targetKeyTotal = coverage.reduce((sum, c) => sum + c.keys.size, 0);

    if (baseLanguage && baseKeys.size === 0) {
      if (targetKeyTotal > 0) {
        // The reference language carries no strings while targets do — the
        // baseLanguage is almost certainly wrong (a typo, or not the source
        // language). A silent "nothing to verify" would hide a real gap.
        return result(
          "fail",
          `Base language "${baseLanguage}" has no translatable strings in scope "${scope}", yet the target language(s) carry ${targetKeyTotal}. Set options.baseLanguage to the source language that actually holds the strings.`,
        );
      }
      return result(
        "warn",
        `No translatable strings found in scope "${scope}" for base language "${baseLanguage}" or targets ${languages.join(", ")}; nothing to verify.`,
      );
    }

    // Baseline key set: the reference language's keys when configured, otherwise
    // the union of every target language's keys.
    const expectedKeys = baseLanguage ? baseKeys : unionKeys(coverage);

    if (expectedKeys.size === 0) {
      return result(
        "warn",
        `No translatable strings found in scope "${scope}" for languages ${languages.join(", ")}; nothing to verify.`,
      );
    }

    const total = expectedKeys.size;
    const gaps = coverage
      .map((c) => {
        let missing = 0;
        for (const key of expectedKeys) if (!c.keys.has(key)) missing++;
        return { language: c.language, covered: total - missing, missing };
      })
      .filter((g) => g.missing > 0);

    if (gaps.length > 0) {
      const detail = gaps
        .map(
          (g) =>
            `${g.language} (${g.covered}/${total} keys, ${g.missing} missing)`,
        )
        .join(", ");
      return result(
        "fail",
        `Incomplete translations in scope "${scope}" for ${gaps.length} of ${languages.length} language(s): ${detail}.`,
      );
    }

    return result(
      "pass",
      `Translations complete in scope "${scope}" for all ${languages.length} language(s) (${total} key(s) each): ${languages.join(", ")}.`,
    );
  },
};
