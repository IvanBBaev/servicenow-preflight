import { test } from "node:test";
import assert from "node:assert/strict";

import { i18nCompleteness } from "../../build/checks/i18n-completeness.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";
const SCOPE = "x_acme_app";

/**
 * Build a fake whose per-language coverage is driven by explicit KEY lists (not
 * row counts). Coverage is measured per key now, so each language maps to the
 * set of `sys_ui_message.key` values it translates. The queryFilter parses the
 * language out of the `sys_scope=...^language=...` query and yields one row per
 * key; the other translation tables return nothing.
 *
 *   keyClient({ fr: ["a", "b", "c"], de: ["a", "b"] })
 */
function keyClient(perLanguage) {
  return createFakeSnClient({
    // A schema row so `key` is a known column the fake will project.
    tables: {
      sys_ui_message: [{ sys_id: "seed", key: "seed", language: "seed" }],
    },
    queryFilter(table, _rows, params) {
      if (table !== "sys_ui_message") return [];
      const query = params?.sysparm_query ?? "";
      const match = /language=([^^]+)/.exec(query);
      const language = match ? match[1] : "";
      const keys = perLanguage[language] ?? [];
      return keys.map((k, i) => ({
        sys_id: `${language}-${i}`,
        key: k,
        language,
      }));
    },
  });
}

/**
 * A fake whose keys live ONLY in `sys_documentation` (identified by
 * `name` + `element`). If the check did not scan that table, coverage would be
 * empty and it would warn "nothing to verify" — so a pass/fail here proves the
 * SN-7 table is queried.
 *
 *   docClient({ en: [["incident", "short_description"]], fr: [...] })
 */
function docClient(perLanguage) {
  return createFakeSnClient({
    tables: {
      sys_documentation: [
        { sys_id: "seed", name: "seed", element: "seed", language: "seed" },
      ],
    },
    queryFilter(table, _rows, params) {
      if (table !== "sys_documentation") return [];
      const query = params?.sysparm_query ?? "";
      const match = /language=([^^]+)/.exec(query);
      const language = match ? match[1] : "";
      const units = perLanguage[language] ?? [];
      return units.map(([name, element], i) => ({
        sys_id: `${language}-${i}`,
        name,
        element,
        language,
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

test("passes when every language covers the same key set", async () => {
  const http = keyClient({
    fr: ["msg.a", "msg.b", "msg.c"],
    de: ["msg.a", "msg.b", "msg.c"],
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr", "de"] },
  });
  assert.equal(result.status, "pass");
  assert.match(result.message, /3 key/);
});

test("passes and accepts a comma-separated languages string", async () => {
  const http = keyClient({
    fr: ["msg.a", "msg.b", "msg.c"],
    de: ["msg.a", "msg.b", "msg.c"],
    es: ["msg.a", "msg.b", "msg.c"],
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

test("measures per-key coverage, not row counts (CC-29)", async () => {
  // de translates the SAME NUMBER of strings as the en baseline (3), but one of
  // them is a key en does not have — so it is missing one of en's keys. A
  // row-count comparison (3 >= 3) would call this "complete"; per-key catches it.
  const http = keyClient({
    en: ["msg.a", "msg.b", "msg.c"],
    de: ["msg.a", "msg.b", "msg.x"],
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["de"], baseLanguage: "en" },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /de \(2\/3 keys, 1 missing\)/);
});

test("fails when a required language has translation gaps", async () => {
  // No baseLanguage: the baseline is the union of every target's keys. fr covers
  // all 7; de covers 4 of them -> 3 missing.
  const http = keyClient({
    fr: ["a", "b", "c", "d", "e", "f", "g"],
    de: ["a", "b", "c", "d"],
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr", "de"] },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /de/);
  assert.match(result.message, /4\/7/);
  assert.match(result.message, /3 missing/);
});

test("fails and lists every language with gaps", async () => {
  const http = keyClient({
    fr: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
    de: ["a", "b", "c", "d"],
    es: ["a", "b"],
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
  const http = keyClient({ fr: [], de: [] });
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
  const http = keyClient({ fr: ["a", "b"] });
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
  const http = keyClient({
    en: ["a", "b", "c"],
    fr: ["a", "b", "c"],
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
  const http = keyClient({
    en: ["a", "b", "c", "d", "e", "f", "g"],
    fr: ["a", "b", "c", "d"],
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr"], baseLanguage: "en" },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /4\/7/);
  assert.match(result.message, /3 missing/);
});

test("fails when the base language is empty but targets carry strings (CC-30)", async () => {
  // A zero-row base language while targets DO have strings is a misconfiguration
  // (wrong baseLanguage), not "nothing to verify" — it must fail, not pass/skip.
  const http = keyClient({
    en: [],
    fr: ["a", "b", "c"],
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr"], baseLanguage: "en" },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /base language "en"/i);
  assert.match(result.message, /no translatable strings/i);
  assert.match(result.message, /baseLanguage/);
  assert.doesNotMatch(result.message, /nothing to verify/);
});

test("warns (nothing to verify) when base and targets are all empty (CC-30)", async () => {
  const http = keyClient({ en: [], fr: [] });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr"], baseLanguage: "en" },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /nothing to verify/);
});

test("scans the added translation tables — sys_documentation (SN-7)", async () => {
  // Keys live only in sys_documentation. A pass here is only possible if the
  // check queries that table; otherwise coverage would be empty and it would
  // warn "nothing to verify".
  const http = docClient({
    en: [
      ["incident", "short_description"],
      ["incident", "description"],
    ],
    fr: [
      ["incident", "short_description"],
      ["incident", "description"],
    ],
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr"], baseLanguage: "en" },
  });
  assert.equal(result.status, "pass");
  assert.match(result.message, /2 key/);
});

test("catches a gap in a sys_documentation label (SN-7)", async () => {
  const http = docClient({
    en: [
      ["incident", "short_description"],
      ["incident", "description"],
    ],
    fr: [["incident", "short_description"]],
  });
  const result = await i18nCompleteness.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    options: { languages: ["fr"], baseLanguage: "en" },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /1\/2/);
  assert.match(result.message, /1 missing/);
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
