import { test } from "node:test";
import assert from "node:assert/strict";

import { i18nCompleteness } from "../../build/checks/i18n-completeness.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";
const SCOPE = "x_acme_app";

/**
 * Build a fake client whose per-language coverage is driven by a map of
 * `{ [language]: count }` per translation table. The check queries each table
 * once per language with `sysparm_query: "sys_scope=<scope>^language=<lang>"`;
 * we parse the language out of that query and yield `count` synthetic rows.
 */
function coverageClient(perTable) {
  const tables = {};
  for (const table of Object.keys(perTable)) {
    // A single seeded row is enough — queryFilter decides the real count.
    tables[table] = [{ sys_id: "seed" }];
  }
  return createFakeSnClient({
    tables,
    queryFilter(table, _rows, params) {
      const query = params?.sysparm_query ?? "";
      const match = /language=([^^]+)/.exec(query);
      const language = match ? match[1] : "";
      const count = perTable[table]?.[language] ?? 0;
      return Array.from({ length: count }, (_, i) => ({
        sys_id: `${table}-${language}-${i}`,
      }));
    },
  });
}

test("warns when no scope is configured", async () => {
  const http = createFakeSnClient();
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    options: { languages: ["fr", "de"] },
  });
  assert.equal(result.name, "i18n-completeness");
  assert.equal(result.status, "warn");
});

test("warns when no target languages are configured", async () => {
  const http = createFakeSnClient();
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
  });
  assert.equal(result.status, "warn");
});

test("warns when the languages list is present but empty after trimming", async () => {
  const http = createFakeSnClient();
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["", "   "] },
  });
  assert.equal(result.status, "warn");
});

test("passes when every language is fully covered", async () => {
  const http = coverageClient({
    sys_translated_text: { fr: 5, de: 5 },
    sys_ui_message: { fr: 2, de: 2 },
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr", "de"] },
  });
  assert.equal(result.status, "pass");
  // 5 + 2 = 7 strings per language.
  assert.match(result.message, /7 string/);
});

test("passes and accepts a comma-separated languages string", async () => {
  const http = coverageClient({
    sys_translated_text: { fr: 3, de: 3, es: 3 },
    sys_ui_message: { fr: 0, de: 0, es: 0 },
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: "fr, de ,es" },
  });
  assert.equal(result.status, "pass");
  assert.match(result.message, /3 language/);
});

test("fails when a required language has translation gaps", async () => {
  const http = coverageClient({
    sys_translated_text: { fr: 5, de: 3 },
    sys_ui_message: { fr: 2, de: 1 },
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr", "de"] },
  });
  assert.equal(result.status, "fail");
  // fr baseline = 7, de = 4 -> 3 missing, reported with counts.
  assert.match(result.message, /de/);
  assert.match(result.message, /4\/7/);
  assert.match(result.message, /3 missing/);
});

test("fails and lists every language with gaps", async () => {
  const http = coverageClient({
    sys_translated_text: { fr: 10, de: 4, es: 2 },
    sys_ui_message: { fr: 0, de: 0, es: 0 },
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr", "de", "es"] },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /2 of 3/);
  assert.match(result.message, /de/);
  assert.match(result.message, /es/);
});

test("warns when no translatable strings exist for the scope", async () => {
  const http = coverageClient({
    sys_translated_text: { fr: 0, de: 0 },
    sys_ui_message: { fr: 0, de: 0 },
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr", "de"] },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /nothing to verify/);
});

test("warns on a single target language with no baseline to compare against", async () => {
  const http = coverageClient({
    sys_translated_text: { fr: 5 },
    sys_ui_message: { fr: 2 },
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr"] },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /baseline/i);
});

test("uses options.baseLanguage as the coverage baseline (single language passes)", async () => {
  const http = coverageClient({
    sys_translated_text: { en: 5, fr: 5 },
    sys_ui_message: { en: 2, fr: 2 },
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr"], baseLanguage: "en" },
  });
  assert.equal(result.status, "pass");
});

test("fails a language that falls short of options.baseLanguage", async () => {
  const http = coverageClient({
    sys_translated_text: { en: 5, fr: 3 },
    sys_ui_message: { en: 2, fr: 1 },
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr"], baseLanguage: "en" },
  });
  assert.equal(result.status, "fail");
  // en baseline = 7, fr = 4 -> 3 missing.
  assert.match(result.message, /4\/7/);
  assert.match(result.message, /3 missing/);
});

test("warns (degraded) on an authentication error", async () => {
  const http = createFakeSnClient({ fail: { auth: true } });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr", "de"] },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /authentication/i);
});

test("warns (degraded) on a network error", async () => {
  const http = createFakeSnClient({ fail: { network: true } });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr", "de"] },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /unreachable/i);
});

test("fails on an HTTP error from the instance", async () => {
  const http = createFakeSnClient({ fail: { http: 500 } });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr", "de"] },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /500/);
});

test("never throws — always returns a well-formed CheckResult", async () => {
  const http = createFakeSnClient({ fail: { auth: true } });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr", "de"] },
  });
  assert.equal(result.name, "i18n-completeness");
  assert.ok(["pass", "warn", "fail"].includes(result.status));
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
});
