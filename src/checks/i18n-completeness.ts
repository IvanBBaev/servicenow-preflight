import type { Check, CheckResult, PreflightContext } from "../types.js";
import { SnAuthError, SnHttpError, SnNetworkError } from "../http/client.js";

const NAME = "i18n-completeness";

/** Tables that hold translated strings we count coverage against. */
const TRANSLATION_TABLES = ["sys_translated_text", "sys_ui_message"] as const;

/** Per-language coverage counts across the translation tables. */
interface LanguageCoverage {
  language: string;
  translated: number;
}

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
 * The reference language whose coverage defines the expected string count
 * (`ctx.options.baseLanguage`). When set, every target language is compared
 * against it; when unset we infer the baseline from the richest target
 * language, which requires at least two languages to be meaningful.
 */
function readBaseLanguage(ctx: PreflightContext): string {
  const raw = ctx.options?.baseLanguage;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Count translated rows for `language` in `scope` across the translation
 * tables. Uses `ctx.http` (never `fetch`). The query scopes rows to the target
 * application (`sys_scope`) and language, matching how ServiceNow stores
 * per-language translations.
 */
async function countTranslations(
  ctx: PreflightContext,
  scope: string,
  language: string,
): Promise<number> {
  let total = 0;
  for (const table of TRANSLATION_TABLES) {
    const rows = await ctx.http.table(table).query({
      sysparm_query: `sys_scope=${scope}^language=${language}`,
      sysparm_fields: "sys_id",
    });
    total += rows.length;
  }
  return total;
}

/**
 * Verifies translated strings are complete for the required languages: every
 * configured target language should cover the full set of translatable strings
 * in the scope (the maximum coverage observed across languages is treated as
 * the expected baseline). Languages that fall short have missing translations.
 *
 * Status mapping:
 * - `warn` when the scope or the target-language list is unset (nothing to
 *   check), or when the instance is unreachable / auth is degraded (cannot
 *   determine coverage — advisory, not a hard gate).
 * - `fail` when one or more required languages have translation gaps, or the
 *   instance returns an HTTP error (a real problem blocking the run).
 * - `pass` when every required language is fully covered.
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

    let coverage: LanguageCoverage[];
    let baseCoverage: number | undefined;
    try {
      coverage = await Promise.all(
        languages.map(async (language) => ({
          language,
          translated: await countTranslations(ctx, scope, language),
        })),
      );
      if (baseLanguage) {
        baseCoverage = await countTranslations(ctx, scope, baseLanguage);
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

    // The expected baseline is the reference language's coverage when one is
    // configured; otherwise the richest target language (the union of
    // translatable strings is at least as large as any single language).
    const expected =
      baseCoverage ??
      coverage.reduce((max, c) => (c.translated > max ? c.translated : max), 0);

    if (expected === 0) {
      return result(
        "warn",
        `No translatable strings found in scope "${scope}" for languages ${languages.join(", ")}; nothing to verify.`,
      );
    }

    const gaps = coverage
      .filter((c) => c.translated < expected)
      .map((c) => ({ ...c, missing: expected - c.translated }));

    if (gaps.length > 0) {
      const detail = gaps
        .map(
          (g) =>
            `${g.language} (${g.translated}/${expected}, ${g.missing} missing)`,
        )
        .join(", ");
      return result(
        "fail",
        `Incomplete translations in scope "${scope}" for ${gaps.length} of ${languages.length} language(s): ${detail}.`,
      );
    }

    return result(
      "pass",
      `Translations complete in scope "${scope}" for all ${languages.length} language(s) (${expected} string(s) each): ${languages.join(", ")}.`,
    );
  },
};
