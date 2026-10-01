// Ported from github.com/IvanBBaev/syncrona @ 73cae76
// (packages/core/src/tests/manifestBuilder.test.ts and
// manifestBuilderResilience.test.ts). GPL-3.0 upstream; dual-licensed for this
// use by the sole author/copyright owner (ADR-002 option 4).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Adaptations: jest → node:test/assert. Upstream mocked the ConfigManager and
// Logger module singletons (jest.unstable_mockModule); the vendored copy takes
// a `createManifestBuilder(options)` factory, so the previous-manifest accessor,
// the warn sink, and the environment are injected as plain values — including
// the SYNCRONA_* switches the upstream tests set on process.env. Call recording
// uses plain arrays instead of jest.fn mock metadata.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createManifestBuilder,
  isNotFoundError,
  QueryIdentifierError,
  TABLE_API_MAX_PAGES,
  LIST_APPS_MAX_ROWS,
  TABLE_DISCOVERY_MAX_ROWS,
  DICTIONARY_FIELD_MAX_ROWS,
  SCOPE_METADATA_MAX_ROWS,
} from "../build/manifestBuilder.js";

const respond = (rows) => ({ data: { result: rows } });

// W5a #3 made the pager append `^ORDERBYsys_id` and walk until an EMPTY page.
// The legacy doubles below answer by table/query alone and ignore the offset, so
// each would now serve its rows again on the follow-up request. This adapter
// makes them behave like a real Table API: it drops the pager's ordering suffix
// and its appended `,sys_id` column (record field lists already START with
// sys_id, so a trailing one is always the pager's) before the double sees the
// request, and slices the double's rows by offset. The paging-integrity tests at
// the bottom use raw clients instead.
const ORDER_SUFFIX = /\^?ORDERBYsys_id$/;
const SYS_ID_SUFFIX = /,sys_id$/;
function asWellBehavedServer(client) {
  return {
    async tableAPIGet(table, query, fields, limit, offset) {
      const res = await client.tableAPIGet(
        table,
        typeof query === "string" ? query.replace(ORDER_SUFFIX, "") : query,
        typeof fields === "string" ? fields.replace(SYS_ID_SUFFIX, "") : fields,
        limit,
        offset,
      );
      const rows = res?.data?.result;
      if (!Array.isArray(rows) || !offset) return res;
      return { ...res, data: { ...res.data, result: rows.slice(offset) } };
    },
  };
}

/** Builder wired to a collecting warn sink; returns both for assertions. */
function builder(extra = {}) {
  const warns = [];
  const raw = createManifestBuilder({
    logger: { warn: (m) => warns.push(m), debug: () => {} },
    ...extra,
  });
  const mb = {
    buildManifestFromTableAPI: (scope, client, config) =>
      raw.buildManifestFromTableAPI(scope, asWellBehavedServer(client), config),
    buildBulkDownloadFromTableAPI: (missing, client, ...rest) =>
      raw.buildBulkDownloadFromTableAPI(
        missing,
        asWellBehavedServer(client),
        ...rest,
      ),
    listAppsFromTableAPI: (client) =>
      raw.listAppsFromTableAPI(asWellBehavedServer(client)),
  };
  return { mb, warns };
}

const emptyConfig = { includes: {}, excludes: {}, tableOptions: {} };

// A 403 the builder treats as "table not accessible" rather than a real failure.
const forbidden = () =>
  Object.assign(new Error("http 403"), {
    isAxiosError: true,
    response: { status: 403 },
  });

// The same shape with a status the builder must never treat as an answer.
const serverError = () =>
  Object.assign(new Error("http 500"), {
    isAxiosError: true,
    response: { status: 500 },
  });

describe("manifestBuilder", () => {
  it("buildManifestFromTableAPI builds tables, records, and files", async () => {
    const client = {
      async tableAPIGet(table) {
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return respond([
            { sys_class_name: "sys_script_include" },
            { sys_class_name: "sys_script_include" },
          ]);
        if (table === "sys_dictionary")
          return respond([
            { element: "script", internal_type: "script_plain" },
            { element: "description", internal_type: "string" },
          ]);
        if (table === "sys_script_include")
          return respond([
            {
              sys_id: "rec-1",
              name: "Include A",
              script: "gs.info('a');",
              description: "desc",
            },
          ]);
        return respond([]);
      },
    };

    const { mb } = builder();
    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      client,
      emptyConfig,
    );

    assert.equal(manifest.scope, "x_demo");
    assert.deepEqual(Object.keys(manifest.tables), ["sys_script_include"]);
    const record = manifest.tables.sys_script_include.records["Include A"];
    assert.equal(record.sys_id, "rec-1");
    assert.deepEqual(record.files, [
      { name: "script", type: "js" },
      { name: "description", type: "txt" },
    ]);
  });

  // #6: buildRecordName derives the on-disk record name from tableOptions.displayField
  // and differentiatorField, but the record query used to select only the DEFAULT
  // display field. Those configured columns were never fetched, so the manifest name
  // silently diverged from the bulk-download name and `repair --prune` deleted the
  // file. The field list must include the configured displayField and differentiator.
  it("selects the configured displayField and differentiatorField for the record query (#6)", async () => {
    const calls = [];
    const client = {
      async tableAPIGet(table, query, fields, limit, offset) {
        calls.push([table, query, fields, limit, offset]);
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return respond([{ sys_class_name: "sys_script_include" }]);
        if (table === "sys_dictionary")
          return respond([
            { element: "script", internal_type: "script_plain" },
          ]);
        if (table === "sys_script_include")
          return respond([
            {
              sys_id: "rec-1",
              u_title: "Custom Title",
              u_code: "ABC",
              script: "gs.info('a');",
            },
          ]);
        return respond([]);
      },
    };

    const { mb } = builder();
    const manifest = await mb.buildManifestFromTableAPI("x_demo", client, {
      includes: {},
      excludes: {},
      tableOptions: {
        sys_script_include: {
          displayField: "u_title",
          differentiatorField: "u_code",
          query: "",
        },
      },
    });

    const recordCall = calls.find((c) => c[0] === "sys_script_include");
    // The 3rd arg is the sysparm_fields select list.
    const selectedFields = recordCall?.[2] ?? "";
    assert.ok(selectedFields.includes("u_title"));
    assert.ok(selectedFields.includes("u_code"));

    // And the record is named from the configured display + differentiator fields,
    // proving the fetched columns actually feed buildRecordName.
    assert.equal(
      manifest.tables.sys_script_include.records["Custom Title (ABC)"]?.sys_id,
      "rec-1",
    );
  });

  it("refuses a scope name carrying encoded-query metacharacters before any read", async () => {
    // Wave 16: a `^` in the scope name used to be escaped to a space, so the
    // scope read as missing; an identifier no ServiceNow scope can carry is now
    // refused outright, before the first request is sent.
    for (const scope of [
      "x_demo^sys_id=INJECT",
      "x_demo^ORscope=global",
      "x_demo=1",
      "x demo",
      "x_demo,global",
      "x_demo!",
      "",
    ]) {
      const calls = [];
      const client = {
        async tableAPIGet(table, query) {
          calls.push([table, query]);
          return respond([{ sys_id: "scope-1" }]);
        },
      };
      const { mb } = builder();
      await assert.rejects(
        mb.buildManifestFromTableAPI(scope, client, emptyConfig),
        (e) =>
          e instanceof QueryIdentifierError &&
          e.name === "QueryIdentifierError" &&
          e.kind === "scope" &&
          e.value === scope,
        JSON.stringify(scope),
      );
      assert.deepEqual(calls, [], JSON.stringify(scope));
    }
  });

  it("never names a record '.' or '..' (would escape its own directory)", async () => {
    const client = {
      async tableAPIGet(table) {
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return respond([{ sys_class_name: "sys_script_include" }]);
        if (table === "sys_dictionary")
          return respond([
            { element: "script", internal_type: "script_plain" },
          ]);
        if (table === "sys_script_include")
          return respond([
            { sys_id: "rec-dots", name: "..", script: "gs.info('x');" },
          ]);
        return respond([]);
      },
    };

    const { mb } = builder();
    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      client,
      emptyConfig,
    );

    const records = manifest.tables.sys_script_include.records;
    // Falls back to the sys_id rather than the traversal-dangerous "..".
    assert.ok(records["rec-dots"]);
    assert.equal(records[".."], undefined);
    assert.deepEqual(Object.keys(records), ["rec-dots"]);
  });

  it("buildManifestFromTableAPI throws clear error when scope is missing", async () => {
    const client = {
      async tableAPIGet() {
        return respond([]);
      },
    };

    const { mb } = builder();
    await assert.rejects(
      mb.buildManifestFromTableAPI("x_missing", client, emptyConfig),
      /Scope "x_missing" not found on this instance\. Check the scope code\./,
    );
  });

  it("does not report a failed scope lookup as a missing scope", async () => {
    const client = {
      async tableAPIGet(table) {
        if (table === "sys_app") throw serverError();
        return respond([]);
      },
    };

    const { mb } = builder();
    await assert.rejects(
      mb.buildManifestFromTableAPI("x_demo", client, emptyConfig),
      (err) => {
        assert.match(err.message, /lookup failed/);
        assert.doesNotMatch(err.message, /Check the scope code/);
        return true;
      },
    );
  });

  it("names the cause when the scope lookup never reached the instance", async () => {
    const client = {
      async tableAPIGet(table) {
        if (table === "sys_app") throw new Error("socket hang up");
        return respond([]);
      },
    };

    const { mb } = builder();
    await assert.rejects(
      mb.buildManifestFromTableAPI("x_demo", client, emptyConfig),
      (err) => {
        assert.match(err.message, /lookup failed/);
        assert.match(err.message, /socket hang up/);
        assert.doesNotMatch(err.message, /Check the scope code/);
        return true;
      },
    );
  });

  it("treats a scope row with an empty sys_id as a missing scope", async () => {
    const client = {
      async tableAPIGet(table) {
        if (table === "sys_app") return respond([{ sys_id: "" }]);
        return respond([]);
      },
    };

    const { mb } = builder();
    await assert.rejects(
      mb.buildManifestFromTableAPI("x_blank", client, emptyConfig),
      /Scope "x_blank" not found on this instance\. Check the scope code\./,
    );
  });

  it("falls back to sys_db_object when sys_metadata is empty", async () => {
    const client = {
      async tableAPIGet(table) {
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata") return respond([]);
        if (table === "sys_db_object")
          return respond([{ name: "x_fleet_record" }]);
        if (table === "sys_dictionary")
          return respond([
            { element: "script", internal_type: "script_plain" },
          ]);
        if (table === "x_fleet_record")
          return respond([
            { sys_id: "rec-1", name: "Fleet A", script: "gs.info('fleet');" },
          ]);
        return respond([]);
      },
    };

    const { mb } = builder();
    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      client,
      emptyConfig,
    );

    assert.ok(manifest.tables.x_fleet_record);
    assert.deepEqual(manifest.tables.x_fleet_record.records["Fleet A"].files, [
      { name: "script", type: "js" },
    ]);
  });

  it("falls back to sys_dictionary when sys_db_object is empty", async () => {
    const calls = [];
    const client = {
      async tableAPIGet(table, query, fields, limit, offset) {
        calls.push([table, query, fields, limit, offset]);
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata") return respond([]);
        if (table === "sys_db_object") return respond([]);
        if (table === "sys_dictionary") {
          // The 4th call overall is the scoped sys_dictionary table-name lookup;
          // later sys_dictionary calls are the field lookups.
          if (calls.length === 4) return respond([{ name: "x_fleet_record" }]);
          return respond([
            { element: "script", internal_type: "script_plain" },
          ]);
        }
        if (table === "x_fleet_record")
          return respond([
            { sys_id: "rec-1", name: "Fleet A", script: "gs.info('fleet');" },
          ]);
        return respond([]);
      },
    };

    const { mb } = builder();
    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      client,
      emptyConfig,
    );

    assert.ok(manifest.tables.x_fleet_record);
    assert.deepEqual(manifest.tables.x_fleet_record.records["Fleet A"].files, [
      { name: "script", type: "js" },
    ]);
  });

  it("falls back to sys_metadata sys_id query when scoped table filter returns no rows", async () => {
    const client = {
      async tableAPIGet(table, query) {
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata") {
          if (query === "sys_scope=scope-1")
            return respond([{ sys_class_name: "sys_script_include" }]);
          if (query === "sys_scope=scope-1^sys_class_name=sys_script_include")
            return respond([
              { sys_id: "rec-1", sys_class_name: "sys_script_include" },
            ]);
        }
        if (table === "sys_db_object")
          return respond([{ name: "sys_script_include" }]);
        if (table === "sys_dictionary")
          return respond([
            { element: "script", internal_type: "script_plain" },
          ]);
        if (table === "sys_script_include") {
          if (query === "sys_scope=scope-1^sys_class_name=sys_script_include")
            return respond([]);
          if (query === "sys_idINrec-1")
            return respond([
              {
                sys_id: "rec-1",
                name: "Include via Metadata",
                script: "gs.info('meta');",
              },
            ]);
        }
        return respond([]);
      },
    };

    const { mb } = builder();
    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      client,
      emptyConfig,
    );

    assert.ok(manifest.tables.sys_script_include);
    const record =
      manifest.tables.sys_script_include.records["Include via Metadata"];
    assert.ok(record);
    assert.deepEqual(record.files, [{ name: "script", type: "js" }]);
  });

  it("materializes data-only tables with txt fields when no script-like fields exist", async () => {
    const client = {
      async tableAPIGet(table, query, fields) {
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return respond([{ sys_class_name: "x_data_table" }]);
        if (table === "sys_db_object")
          return respond([{ name: "x_data_table" }]);
        if (table === "sys_dictionary") {
          if (fields === "element,internal_type") return respond([]);
          return respond([{ element: "u_name" }, { element: "u_code" }]);
        }
        if (table === "x_data_table")
          return respond([
            {
              sys_id: "rec-1",
              name: "Data A",
              u_name: "Truck",
              u_code: "T-01",
            },
          ]);
        return respond([]);
      },
    };

    // Upstream set process.env.SYNCRONA_INCLUDE_DATA_FIELDS; here the switch is
    // injected through the factory's env option.
    const { mb } = builder({ env: { SYNCRONA_INCLUDE_DATA_FIELDS: "true" } });
    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      client,
      emptyConfig,
    );

    assert.ok(manifest.tables.x_data_table);
    assert.deepEqual(manifest.tables.x_data_table.records["Data A"].files, [
      { name: "u_name", type: "txt" },
      { name: "u_code", type: "txt" },
    ]);
  });

  it("buildBulkDownloadFromTableAPI fills missing file contents", async () => {
    const client = {
      async tableAPIGet(table) {
        if (table === "sys_script_include")
          return respond([
            {
              sys_id: "rec-1",
              name: "Include A",
              script: "gs.info('a');",
              description: "hello",
            },
          ]);
        return respond([]);
      },
    };

    const missing = {
      sys_script_include: {
        "rec-1": [
          { name: "script", type: "js" },
          { name: "description", type: "txt" },
        ],
      },
    };

    const { mb } = builder();
    const tableMap = await mb.buildBulkDownloadFromTableAPI(
      missing,
      client,
      {},
    );
    assert.deepEqual(Object.keys(tableMap), ["sys_script_include"]);
    const rec = tableMap.sys_script_include.records["Include A"];
    assert.deepEqual(rec.files, [
      { name: "script", type: "js", content: "gs.info('a');" },
      { name: "description", type: "txt", content: "hello" },
    ]);
  });

  // buildRecordName applies the tableOptions.displayField override internally
  // (override -> default -> sys_id). The bulk-download path used to hand it the
  // already-resolved override as the fallback argument, collapsing that chain to
  // override -> override -> sys_id. A record whose override value is EMPTY was
  // therefore named "<sys_id>" by the download while the manifest named it from
  // the default display field: the content landed in an untracked folder, the
  // manifest-referenced file stayed a 0-byte skeleton, and `repair --prune`
  // deleted the real content as an orphan. Both paths must name it identically.
  it("names a record with an empty displayField override exactly like the manifest path", async () => {
    const row = {
      sys_id: "rec-9",
      name: "MyInclude",
      u_title: "",
      script: "gs.info('a');",
    };
    const client = {
      async tableAPIGet(table) {
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return respond([{ sys_class_name: "sys_script_include" }]);
        if (table === "sys_dictionary")
          return respond([
            { element: "script", internal_type: "script_plain" },
          ]);
        if (table === "sys_script_include") return respond([row]);
        return respond([]);
      },
    };

    const tableOptions = {
      sys_script_include: { displayField: "u_title", query: "" },
    };

    const { mb } = builder();
    const manifest = await mb.buildManifestFromTableAPI("x_demo", client, {
      includes: {},
      excludes: {},
      tableOptions,
    });
    const manifestName = Object.keys(
      manifest.tables.sys_script_include.records,
    )[0];

    const tableMap = await mb.buildBulkDownloadFromTableAPI(
      { sys_script_include: { "rec-9": [{ name: "script", type: "js" }] } },
      client,
      tableOptions,
    );
    const downloadName = Object.keys(tableMap.sys_script_include.records)[0];

    // The empty override falls back to the default display field, not to sys_id.
    assert.equal(manifestName, "MyInclude");
    assert.equal(downloadName, manifestName);
  });

  it("listAppsFromTableAPI returns SN.App[] shape", async () => {
    const client = {
      async tableAPIGet() {
        return respond([
          { sys_id: "app-1", scope: "x_demo", name: "Demo" },
          { sys_id: "app-2", scope: "x_tools", name: "Tools" },
        ]);
      },
    };

    const { mb } = builder();
    const apps = await mb.listAppsFromTableAPI(client);
    assert.deepEqual(apps, [
      { sys_id: "app-1", scope: "x_demo", displayName: "Demo" },
      { sys_id: "app-2", scope: "x_tools", displayName: "Tools" },
    ]);
  });

  it("isNotFoundError handles 404 and non-404 inputs", () => {
    assert.equal(isNotFoundError({ response: { status: 404 } }), true);
    assert.equal(isNotFoundError({ response: { status: 500 } }), false);
    assert.equal(isNotFoundError({ status: 404 }), true);
    assert.equal(isNotFoundError("boom"), false);
    assert.equal(isNotFoundError(null), false);
  });

  it("uses sys_atf_step inputs.script without dictionary query", async () => {
    const calls = [];
    const client = {
      async tableAPIGet(table, query, fields, limit, offset) {
        calls.push([table, query, fields, limit, offset]);
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return respond([{ sys_class_name: "sys_atf_step" }]);
        if (table === "sys_dictionary")
          throw new Error(
            "sys_dictionary should not be queried for sys_atf_step",
          );
        if (table === "sys_atf_step")
          return respond([
            {
              sys_id: "atf-1",
              name: "Step A",
              "inputs.script": "gs.info('atf');",
            },
          ]);
        return respond([]);
      },
    };

    const { mb } = builder();
    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      client,
      emptyConfig,
    );

    assert.ok(manifest.tables.sys_atf_step);
    const rec = Object.values(manifest.tables.sys_atf_step.records)[0];
    assert.deepEqual(rec.files, [{ name: "inputs.script", type: "js" }]);
    assert.equal(
      calls.some((call) => call[0] === "sys_dictionary"),
      false,
    );
  });

  it("queries dictionary across table hierarchy (table + ancestors)", async () => {
    const dictionaryQueries = [];
    const client = {
      async tableAPIGet(table, query) {
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return respond([{ sys_class_name: "x_child_table" }]);
        if (table === "sys_db_object") {
          if (query === "name=x_child_table")
            return respond([
              { name: "x_child_table", "super_class.name": "x_parent_table" },
            ]);
          if (query === "name=x_parent_table")
            return respond([
              { name: "x_parent_table", "super_class.name": "sys_metadata" },
            ]);
          if (query === "name=sys_metadata")
            return respond([{ name: "sys_metadata" }]);
        }
        if (table === "sys_dictionary") {
          dictionaryQueries.push(query);
          return respond([
            { element: "script", internal_type: "script_plain" },
          ]);
        }
        if (table === "x_child_table")
          return respond([
            { sys_id: "rec-1", name: "Child A", script: "gs.info('x');" },
          ]);
        return respond([]);
      },
    };

    const { mb } = builder();
    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      client,
      emptyConfig,
    );

    assert.deepEqual(Object.keys(manifest.tables), ["x_child_table"]);
    const rec = manifest.tables.x_child_table.records["Child A"];
    assert.deepEqual(rec.files, [{ name: "script", type: "js" }]);
    assert.ok(
      dictionaryQueries.some((q) =>
        q.includes(
          "name=x_child_table^ORname=x_parent_table^ORname=sys_metadata",
        ),
      ),
    );
  });

  it("formats differentiatorField string and array like SincUtilsMS", async () => {
    const client = {
      async tableAPIGet(table) {
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return respond([{ sys_class_name: "sys_script_include" }]);
        if (table === "sys_db_object")
          return respond([{ name: "sys_script_include" }]);
        if (table === "sys_dictionary")
          return respond([
            { element: "script", internal_type: "script_plain" },
          ]);
        if (table === "sys_script_include")
          return respond([
            {
              sys_id: "rec-1",
              name: "Include A",
              script: "gs.info('a');",
              version: "v2",
              category: "ops",
            },
          ]);
        return respond([]);
      },
    };

    const includes = {
      sys_script_include: {
        version: { type: "txt" },
        category: { type: "txt" },
      },
    };

    const { mb } = builder();
    const byString = await mb.buildManifestFromTableAPI("x_demo", client, {
      includes,
      excludes: {},
      tableOptions: {
        sys_script_include: { differentiatorField: "version", query: "" },
      },
    });
    assert.ok(byString.tables.sys_script_include.records["Include A (v2)"]);

    const byArray = await mb.buildManifestFromTableAPI("x_demo", client, {
      includes,
      excludes: {},
      tableOptions: {
        sys_script_include: {
          differentiatorField: ["version", "category"],
          query: "",
        },
      },
    });
    assert.ok(
      byArray.tables.sys_script_include.records["Include A (version:v2)"],
    );
  });

  it("fails the build when a table's field lookup hits a network error (no silent drop)", async () => {
    const client = {
      async tableAPIGet(table, _query, fields) {
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return respond([{ sys_class_name: "sys_script_include" }]);
        if (table === "sys_dictionary" && fields === "element,internal_type")
          // Network-level failure: no HTTP status at all.
          throw new Error("socket hang up");
        return respond([]);
      },
    };

    const { mb } = builder();
    await assert.rejects(
      mb.buildManifestFromTableAPI("x_demo", client, emptyConfig),
      /Manifest build incomplete — failed tables: sys_script_include/,
    );
  });

  it("still skips a table whose dictionary endpoint is inaccessible (403)", async () => {
    const client = {
      async tableAPIGet(table, _query, fields) {
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return respond([{ sys_class_name: "sys_script_include" }]);
        if (table === "sys_dictionary" && fields === "element,internal_type")
          throw forbidden();
        return respond([]);
      },
    };

    const { mb } = builder();
    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      client,
      emptyConfig,
    );
    assert.deepEqual(manifest.tables, {});
  });

  it("listAppsFromTableAPI propagates network errors instead of returning an empty list", async () => {
    const client = {
      async tableAPIGet() {
        throw new Error("socket hang up");
      },
    };

    const { mb } = builder();
    await assert.rejects(mb.listAppsFromTableAPI(client), /socket hang up/);
  });

  it("listAppsFromTableAPI returns empty list when sys_app endpoint is unavailable (404)", async () => {
    const client = {
      async tableAPIGet() {
        throw Object.assign(new Error("not found"), {
          isAxiosError: true,
          response: { status: 404 },
        });
      },
    };

    const { mb } = builder();
    assert.deepEqual(await mb.listAppsFromTableAPI(client), []);
  });
});

// ─── Resilience: refused reads must not become silent data loss ─────────────

const PREVIOUS = {
  scope: "x_demo",
  tables: {
    sys_script: {
      records: {
        Existing: {
          sys_id: "rec-1",
          name: "Existing",
          files: [{ name: "script", type: "js" }],
        },
      },
    },
  },
};

// A table the instance refuses (column ACL, temporarily unreadable) returns
// "no file fields" — indistinguishable from a table that genuinely has none.
// The rebuilt manifest therefore dropped the table entirely and replaced the
// good manifest: every already-downloaded file of that table stopped mapping to
// a record, so `push` ignored edits to them and `repair --prune` called them
// orphans. The previously known records must survive a refused read.
describe("buildManifestFromTableAPI with an inaccessible table", () => {
  const clientRefusingDictionary = () => ({
    async tableAPIGet(table) {
      if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
      if (table === "sys_metadata")
        return respond([{ sys_class_name: "sys_script" }]);
      if (table === "sys_dictionary") throw forbidden();
      return respond([]);
    },
  });

  it("keeps the previously known records instead of dropping the table", async () => {
    const { mb, warns } = builder({ getPreviousManifest: () => PREVIOUS });

    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      clientRefusingDictionary(),
      emptyConfig,
    );

    assert.ok(manifest.tables.sys_script);
    assert.equal(
      manifest.tables.sys_script.records["Existing"].sys_id,
      "rec-1",
    );
    assert.ok(
      warns.some((m) =>
        m.includes("Kept the previously known records for: sys_script"),
      ),
    );
  });

  it("warns about the unreadable table even when there is nothing to carry over", async () => {
    const { mb, warns } = builder({ getPreviousManifest: () => undefined });

    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      clientRefusingDictionary(),
      emptyConfig,
    );

    assert.equal(manifest.tables.sys_script, undefined);
    assert.ok(
      warns.some((m) =>
        m.includes(
          "Could not fully read 1 table(s) while building the manifest",
        ),
      ),
    );
  });

  it("reports a previous-manifest accessor that threw, instead of reading it as nothing to carry", async () => {
    // The accessor is the whole recovery mechanism for a refused table. When it
    // throws, the bare `catch` used to return `undefined` — the same value it
    // returns when there simply is no previous manifest — so the run emitted
    // the identical warning in both cases and nothing said the carry-forward
    // had not run at all.
    const thrown = builder({
      getPreviousManifest: () => {
        throw new Error("state dir unreadable");
      },
    });
    const absent = builder({ getPreviousManifest: () => undefined });

    const manifest = await thrown.mb.buildManifestFromTableAPI(
      "x_demo",
      clientRefusingDictionary(),
      emptyConfig,
    );
    await absent.mb.buildManifestFromTableAPI(
      "x_demo",
      clientRefusingDictionary(),
      emptyConfig,
    );

    assert.equal(manifest.tables.sys_script, undefined);
    // The two runs must not be indistinguishable in the log.
    assert.notDeepEqual(thrown.warns, absent.warns);
    assert.ok(
      thrown.warns.some(
        (m) =>
          m.includes("Could not read the previously known manifest") &&
          m.includes("state dir unreadable"),
      ),
      `expected a warning naming the failed carry-forward, got ${JSON.stringify(thrown.warns)}`,
    );
  });

  it("does not carry over records from a different scope's manifest", async () => {
    const { mb } = builder({
      getPreviousManifest: () => ({ ...PREVIOUS, scope: "x_other" }),
    });

    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      clientRefusingDictionary(),
      emptyConfig,
    );

    assert.equal(manifest.tables.sys_script, undefined);
  });
});

// The same "refused reads as empty" confusion exists on three deeper paths that
// used to swallow the skip without reporting it: the text-field fallback, the
// sys_metadata lookup behind an empty record query, and the per-chunk `sys_idIN`
// fallback. Each one has to reach the same carry-forward.
describe("buildManifestFromTableAPI with a refused read below the top-level query", () => {
  // Answers everything the builder needs to reach getRecordsForTable for
  // `sys_script`; `overrides` decides which of the deeper reads is refused.
  const createRefusingClient = (overrides) => ({
    async tableAPIGet(table, query, fields) {
      const override = overrides(table, query, fields);
      if (override instanceof Error) throw override;
      if (override) return override;

      if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
      // Table discovery (fields "sys_class_name") — distinct from the
      // sys_metadata fallback inside getRecordsForTable.
      if (table === "sys_metadata" && fields === "sys_class_name")
        return respond([{ sys_class_name: "sys_script" }]);
      // Hierarchy walk: no parent class.
      if (table === "sys_db_object") return respond([]);
      // File fields for the table.
      if (table === "sys_dictionary" && fields === "element,internal_type")
        return respond([{ element: "script", internal_type: "script" }]);
      return respond([]);
    },
  });

  it("reports a refused text-field fallback instead of returning no fields", async () => {
    // The fallback only runs for a data-materialized table, and it is the only
    // sys_dictionary read that asks for "element" alone. Upstream set
    // process.env.SYNCRONA_DATA_TABLES; here the allowlist is injected.
    const { mb, warns } = builder({
      getPreviousManifest: () => PREVIOUS,
      env: { SYNCRONA_DATA_TABLES: "sys_script" },
    });

    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      createRefusingClient((table, _query, fields) => {
        if (table === "sys_dictionary" && fields === "element,internal_type")
          return respond([]);
        if (table === "sys_dictionary" && fields === "element")
          return forbidden();
        return undefined;
      }),
      emptyConfig,
    );

    assert.equal(
      manifest.tables.sys_script.records["Existing"].sys_id,
      "rec-1",
    );
    assert.ok(
      warns.some((m) =>
        m.includes("Kept the previously known records for: sys_script"),
      ),
    );
  });

  it("reports a refused sys_metadata lookup behind an empty record query", async () => {
    const { mb, warns } = builder({ getPreviousManifest: () => PREVIOUS });

    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      createRefusingClient((table, _query, fields) =>
        table === "sys_metadata" && fields === "sys_id,sys_class_name"
          ? forbidden()
          : undefined,
      ),
      emptyConfig,
    );

    assert.equal(
      manifest.tables.sys_script.records["Existing"].sys_id,
      "rec-1",
    );
    assert.ok(
      warns.some((m) =>
        m.includes("Kept the previously known records for: sys_script"),
      ),
    );
  });

  // A refused `sys_idIN` chunk leaves the other chunks intact, so the table does
  // come back with records — just not all of them. That partial set used to be
  // written as if it were the whole table, which is the same data loss one step
  // later: the missing records' files become orphans for `repair --prune`.
  it("merges the previous records back in when only one sys_id chunk is refused", async () => {
    const { mb, warns } = builder({ getPreviousManifest: () => PREVIOUS });
    // SYS_ID_CHUNK_SIZE is 200, so 250 ids produce exactly two chunks.
    const ids = Array.from({ length: 250 }, (_, i) => `md-${i}`);

    const manifest = await mb.buildManifestFromTableAPI(
      "x_demo",
      createRefusingClient((table, query, fields) => {
        if (table === "sys_metadata" && fields === "sys_id,sys_class_name")
          return respond(ids.map((sys_id) => ({ sys_id })));
        if (table === "sys_script" && query.startsWith("sys_idIN")) {
          const chunk = query.slice("sys_idIN".length).split(",");
          // The second chunk is the refused one.
          if (chunk.includes("md-200")) return forbidden();
          return respond(
            chunk.map((sys_id) => ({ sys_id, name: `Script-${sys_id}` })),
          );
        }
        return undefined;
      }),
      emptyConfig,
    );

    const records = manifest.tables.sys_script.records;
    // Everything the accessible chunk returned...
    assert.equal(records["Script-md-0"].sys_id, "md-0");
    assert.equal(Object.keys(records).length, 201);
    // ...plus the record the refused chunk would have silently dropped.
    assert.equal(records["Existing"].sys_id, "rec-1");
    assert.ok(
      warns.some((m) =>
        m.includes("Kept the previously known records for: sys_script"),
      ),
    );
  });
});

// `row[fieldName] || ""` cannot tell "the instance returned an empty value"
// from "the instance did not return this column at all" (read ACL on the
// field). Because downloadAllFiles writes with forceWrite, the fabricated empty
// string overwrote the local file — silent data loss on every download of a
// read-restricted field.
describe("buildBulkDownloadFromTableAPI with a field the instance withholds", () => {
  it("omits a field missing from the response instead of blanking it", async () => {
    const client = {
      async tableAPIGet() {
        // "script" is withheld by a column-level ACL; "css" comes back empty.
        return respond([{ sys_id: "rec-1", id: "Widget", css: "" }]);
      },
    };

    const { mb, warns } = builder();
    const result = await mb.buildBulkDownloadFromTableAPI(
      {
        sp_widget: {
          "rec-1": [
            { name: "script", type: "js" },
            { name: "css", type: "css" },
          ],
        },
      },
      client,
      {},
    );

    const files = result.sp_widget.records["Widget"].files;
    assert.deepEqual(
      files.map((f) => f.name),
      ["css"],
    );
    assert.equal(files[0].content, "");
    assert.ok(
      warns.some((m) =>
        m.includes("the instance returned no value for field(s) script"),
      ),
    );
  });

  it("still writes a field the instance returns as an empty string", async () => {
    const client = {
      async tableAPIGet() {
        return respond([{ sys_id: "rec-1", id: "Widget", script: "" }]);
      },
    };

    const { mb } = builder();
    const result = await mb.buildBulkDownloadFromTableAPI(
      { sp_widget: { "rec-1": [{ name: "script", type: "js" }] } },
      client,
      {},
    );

    assert.deepEqual(result.sp_widget.records["Widget"].files, [
      { name: "script", type: "js", content: "" },
    ]);
  });
});

// W5a finding 3 (review-w5a/page1.mjs): tableAPIGetAllRows stopped at the first
// short page (silent truncation when the server caps rows below pageSize) and
// never stopped when the server ignored the offset. These doubles are raw — they
// do NOT go through builder()'s well-behaved-server adapter — because the server
// misbehaviour is exactly what is under test. Each failed before the fix.
describe("tableAPIGetAllRows paging integrity (W5a #3)", () => {
  const rawBuilder = () =>
    createManifestBuilder({
      logger: { warn: () => {}, debug: () => {} },
      env: {},
    });

  /** A client that pages sys_metadata through `metaPage` and serves one script table. */
  function pagedClient(metaPage, calls) {
    return {
      async tableAPIGet(table, query, fields, limit, offset) {
        calls.push({ table, query, fields, limit, offset });
        if (table === "sys_app") return respond([{ sys_id: "scope-1" }]);
        if (table === "sys_metadata")
          return metaPage(limit, offset ?? 0, query);
        if (table === "sys_dictionary")
          return respond(
            (offset ?? 0) === 0
              ? [{ element: "script", internal_type: "script_plain" }]
              : [],
          );
        if ((offset ?? 0) > 0) return respond([]);
        if (table === "sys_script_include" || table === "sys_ui_page")
          return respond([
            { sys_id: `${table}-1`, name: `${table} one`, script: "x" },
          ]);
        return respond([]);
      },
    };
  }

  it("keeps paging past a short page when the server caps rows below pageSize", async () => {
    const all = Array.from({ length: 12000 }, (_, i) => ({
      sys_id: `m${String(i).padStart(6, "0")}`,
      sys_class_name: i < 5000 ? "sys_script_include" : "sys_ui_page",
    }));
    const calls = [];
    const client = pagedClient(
      (limit, offset) =>
        respond(all.slice(offset, offset + Math.min(limit, 5000))),
      calls,
    );

    const manifest = await rawBuilder().buildManifestFromTableAPI(
      "x_acme",
      client,
      emptyConfig,
    );

    assert.ok(
      manifest.tables.sys_ui_page,
      "rows after the first cap were lost",
    );
    const discovery = calls.filter(
      (c) => c.table === "sys_metadata" && c.limit === 10000,
    );
    // Offsets advance by rows actually received, and the walk ends on an EMPTY page.
    assert.deepEqual(
      discovery.map((c) => c.offset),
      [0, 5000, 10000, 12000],
    );
  });

  it("orders every paged query by sys_id and selects sys_id", async () => {
    const calls = [];
    const client = pagedClient(
      (limit, offset) =>
        respond(
          offset === 0
            ? [{ sys_id: "m1", sys_class_name: "sys_script_include" }]
            : [],
        ),
      calls,
    );

    await rawBuilder().buildManifestFromTableAPI("x_acme", client, emptyConfig);

    const discovery = calls.find(
      (c) => c.table === "sys_metadata" && c.limit === 10000,
    );
    assert.equal(discovery?.query, "sys_scope=scope-1^ORDERBYsys_id");
    assert.ok(discovery?.fields.split(",").includes("sys_id"));
    assert.ok(discovery?.fields.split(",").includes("sys_class_name"));
  });

  it("fails loudly (not a fallback) when the server ignores the offset", async () => {
    const calls = [];
    const client = pagedClient(
      (limit) =>
        respond(
          Array.from({ length: limit }, (_, i) => ({
            sys_id: `same-${i}`,
            sys_class_name: "sys_script_include",
          })),
        ),
      calls,
    );

    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_acme", client, emptyConfig),
      /no progress/i,
    );
    const metaCalls = calls.filter((c) => c.table === "sys_metadata");
    assert.equal(metaCalls.length, 2);
    // The integrity failure must not be swallowed into the dictionary fallback.
    assert.equal(
      calls.some((c) => c.table === "sys_dictionary"),
      false,
    );
  });

  it("fails loudly when the page cap is reached", async () => {
    const calls = [];
    let n = 0;
    const client = pagedClient(() => {
      n += 1;
      return respond([
        { sys_id: `row-${n}`, sys_class_name: "sys_script_include" },
      ]);
    }, calls);

    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_acme", client, emptyConfig),
      /page cap/i,
    );
    assert.equal(
      calls.filter((c) => c.table === "sys_metadata").length,
      TABLE_API_MAX_PAGES,
    );
  });

  it("throws when the client-reported total disagrees with the rows received", async () => {
    const client = pagedClient(
      (limit, offset) => ({
        data: {
          result:
            offset === 0
              ? [{ sys_id: "m1", sys_class_name: "sys_script_include" }]
              : [],
        },
        total: 3,
      }),
      [],
    );

    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_acme", client, emptyConfig),
      /X-Total-Count/,
    );
  });

  it("accepts a client-reported total that matches", async () => {
    const client = pagedClient(
      (limit, offset) => ({
        data: {
          result:
            offset === 0
              ? [{ sys_id: "m1", sys_class_name: "sys_script_include" }]
              : [],
        },
        total: 1,
      }),
      [],
    );

    const manifest = await rawBuilder().buildManifestFromTableAPI(
      "x_acme",
      client,
      emptyConfig,
    );
    assert.ok(manifest.tables.sys_script_include);
  });
});

// W7b review lane (L8/L9, 2026-09-26): the Table API reader trusted every answer
// that was not an HTTP error. A body without a `result` ARRAY (an `{error}` body,
// an HTML login page, a `{result:{rows}}` shape) read as an empty page and ended
// paging early; 400 counted as "table not accessible"; broad catches turned 5xx
// and network failures into "no tables here"; offset paging accepted rows that
// reappeared on a later page; and the unpaged sys_idIN fallback accepted a short
// answer. These doubles are raw (no well-behaved adapter): each case is a server
// misbehaviour, and each failed before the fix.
describe("Table API response integrity (W7b L8/L9)", () => {
  const rawBuilder = (warns = []) =>
    createManifestBuilder({
      logger: { warn: (m) => warns.push(m), debug: () => {} },
      env: {},
    });

  const httpError = (status) =>
    Object.assign(new Error(`http ${status}`), {
      isAxiosError: true,
      response: { status },
    });

  const MALFORMED_BODIES = [
    ["an {error} body", { error: { message: "User Not Authenticated" } }],
    ["an HTML string", "<html>login</html>"],
    ["a {result:{rows}} body", { result: { rows: [] } }],
    ["a missing body", undefined],
  ];

  /**
   * One scope with one script table `x_tbl`. `answer(table, query, fields,
   * offset)` may return a response, throw, or return undefined for the default.
   */
  function client(answer, calls = []) {
    return {
      calls,
      async tableAPIGet(table, rawQuery, rawFields, limit, offset = 0) {
        calls.push({
          table,
          query: rawQuery,
          fields: rawFields,
          limit,
          offset,
        });
        // Wave 13 paged the fixed-limit discovery / dictionary reads: show the
        // answers the pre-pager query and field list, and end every paged
        // non-sys_metadata read after its first page (these fixtures answer
        // one page regardless of offset).
        const paged = rawQuery.endsWith("^ORDERBYsys_id");
        const query = paged
          ? rawQuery.slice(0, -"^ORDERBYsys_id".length)
          : rawQuery;
        const fields =
          paged && table !== "sys_metadata" && rawFields.endsWith(",sys_id")
            ? rawFields.slice(0, -",sys_id".length)
            : rawFields;
        if (
          paged &&
          offset > 0 &&
          (table === "sys_dictionary" || table === "sys_db_object")
        )
          return respond([]);
        const override = await answer(table, query, fields, offset);
        if (override !== undefined) return override;
        if (table === "sys_app") return respond([{ sys_id: "S1" }]);
        if (table === "sys_metadata" && fields.startsWith("sys_class_name"))
          return respond(
            offset === 0 ? [{ sys_id: "m1", sys_class_name: "x_tbl" }] : [],
          );
        if (table === "sys_db_object") return respond([]);
        if (table === "sys_dictionary" && fields === "element,internal_type")
          return respond(
            offset === 0
              ? [{ element: "script", internal_type: "script_plain" }]
              : [],
          );
        if (table === "x_tbl")
          return respond(
            offset === 0 ? [{ sys_id: "r1", name: "One", script: "x" }] : [],
          );
        return respond([]);
      },
    };
  }

  for (const [label, body] of MALFORMED_BODIES) {
    it(`ends paging with an error, not a truncated result, on ${label}`, async () => {
      const c = client((table, _q, fields, offset) =>
        table === "sys_metadata" &&
        fields.startsWith("sys_class_name") &&
        offset > 0
          ? { data: body }
          : undefined,
      );
      await assert.rejects(
        rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
        (err) => {
          assert.equal(err.name, "TableAPIPagingError");
          assert.match(err.message, /sys_metadata/);
          assert.match(err.message, /result/);
          return true;
        },
      );
      // Not swallowed into the dictionary fallback either.
      assert.equal(
        c.calls.some((x) => x.table === "sys_dictionary"),
        false,
      );
    });

    it(`reports the scope lookup as failed, not absent, on ${label}`, async () => {
      const c = client((table) =>
        table === "sys_app" ? { data: body } : undefined,
      );
      await assert.rejects(
        rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
        (err) => {
          assert.match(err.message, /lookup failed/);
          assert.doesNotMatch(err.message, /Check the scope code/);
          return true;
        },
      );
    });
  }

  it("fails the build on a malformed body from the db_object fallback", async () => {
    const c = client((table, _q, fields) => {
      if (table === "sys_metadata" && fields.startsWith("sys_class_name"))
        return respond([]);
      if (table === "sys_db_object") return { data: "<html>login</html>" };
      return undefined;
    });
    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
      /sys_db_object/,
    );
  });

  it("fails the build on a malformed body from the dictionary fallback", async () => {
    const c = client((table, _q, fields) => {
      if (table === "sys_metadata" && fields.startsWith("sys_class_name"))
        return respond([]);
      if (table === "sys_dictionary" && fields === "name")
        return { data: { error: { message: "nope" } } };
      return undefined;
    });
    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
      /sys_dictionary/,
    );
  });

  it("treats a 400 on a table read as a fault, not a skip", async () => {
    const c = client((table) => {
      if (table === "x_tbl") throw httpError(400);
      return undefined;
    });
    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
      /failed tables: x_tbl/,
    );
  });

  it("treats a 400 on the field lookup as a fault, not a skip", async () => {
    const c = client((table, _q, fields) => {
      if (table === "sys_dictionary" && fields === "element,internal_type")
        throw httpError(400);
      return undefined;
    });
    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
      /failed tables: x_tbl/,
    );
  });

  it("still skips a 403 on a table read", async () => {
    const warns = [];
    const c = client((table) => {
      if (table === "x_tbl") throw httpError(403);
      return undefined;
    });
    const m = await rawBuilder(warns).buildManifestFromTableAPI(
      "x_app",
      c,
      emptyConfig,
    );
    assert.deepEqual(Object.keys(m.tables), []);
    assert.ok(warns.some((w) => /Could not fully read 1 table/.test(w)));
  });

  it("does not skip a 400 in the bulk download", async () => {
    const c = {
      async tableAPIGet() {
        throw httpError(400);
      },
    };
    await assert.rejects(
      rawBuilder().buildBulkDownloadFromTableAPI(
        { sp_widget: { r1: [{ name: "script", type: "js" }] } },
        c,
        {},
      ),
      /http 400/,
    );
  });

  it("does not turn a 500 on table discovery into the dictionary fallback", async () => {
    const c = client((table, _q, fields) => {
      if (table === "sys_metadata" && fields.startsWith("sys_class_name"))
        throw httpError(500);
      return undefined;
    });
    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
      /http 500/,
    );
    assert.equal(
      c.calls.some((x) => x.table === "sys_dictionary"),
      false,
    );
  });

  it("still falls back to the dictionary when discovery is refused (403)", async () => {
    const c = client((table, _q, fields) => {
      if (table === "sys_metadata" && fields.startsWith("sys_class_name"))
        throw httpError(403);
      if (table === "sys_dictionary" && fields === "name")
        return respond([{ name: "x_tbl" }]);
      return undefined;
    });
    const m = await rawBuilder().buildManifestFromTableAPI(
      "x_app",
      c,
      emptyConfig,
    );
    assert.ok(m.tables.x_tbl);
  });

  it("propagates a 500 from the db_object fallback", async () => {
    const c = client((table, _q, fields) => {
      if (table === "sys_metadata" && fields.startsWith("sys_class_name"))
        return respond([]);
      if (table === "sys_db_object") throw httpError(500);
      return undefined;
    });
    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
      /http 500/,
    );
    assert.equal(
      c.calls.some((x) => x.table === "sys_dictionary"),
      false,
    );
  });

  it("moves past a refused (403) db_object fallback to the dictionary", async () => {
    const c = client((table, _q, fields) => {
      if (table === "sys_metadata" && fields.startsWith("sys_class_name"))
        return respond([]);
      if (table === "sys_db_object" && fields === "name") throw httpError(403);
      if (table === "sys_dictionary" && fields === "name")
        return respond([{ name: "x_tbl" }]);
      return undefined;
    });
    const m = await rawBuilder().buildManifestFromTableAPI(
      "x_app",
      c,
      emptyConfig,
    );
    assert.ok(m.tables.x_tbl);
  });

  for (const which of ["scoped", "nameLIKE"]) {
    it(`propagates a 500 from the ${which} dictionary fallback`, async () => {
      const c = client((table, query, fields) => {
        if (table === "sys_metadata" && fields.startsWith("sys_class_name"))
          return respond([]);
        if (table === "sys_dictionary" && fields === "name") {
          const isLike = query.startsWith("nameLIKE");
          if ((which === "nameLIKE") === isLike) throw httpError(500);
          return respond([]);
        }
        return undefined;
      });
      await assert.rejects(
        rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
        /http 500/,
      );
    });
  }

  it("propagates a 500 from the table-hierarchy lookup", async () => {
    const c = client((table, _q, fields) => {
      if (table === "sys_db_object" && fields === "name,super_class.name")
        throw httpError(500);
      return undefined;
    });
    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
      /failed tables: x_tbl/,
    );
  });

  it("fails paging when a sys_id reappears on a later page", async () => {
    const c = client((table, _q, fields, offset) => {
      if (table === "sys_metadata" && fields.startsWith("sys_class_name")) {
        if (offset === 0)
          return respond([
            { sys_id: "a", sys_class_name: "x_tbl" },
            { sys_id: "b", sys_class_name: "x_tbl" },
          ]);
        if (offset === 2)
          return respond([
            { sys_id: "c", sys_class_name: "x_tbl" },
            { sys_id: "a", sys_class_name: "x_tbl" },
          ]);
        return respond([]);
      }
      return undefined;
    });
    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
      (err) => {
        assert.equal(err.name, "TableAPIPagingError");
        assert.match(err.message, /duplicate sys_id "a"/);
        return true;
      },
    );
  });

  /** Empty direct record query, three sys_metadata ids, sys_idIN answered by `idAnswer`. */
  const idFallbackClient = (idAnswer) =>
    client((table, query, fields, offset) => {
      if (table === "x_tbl" && !query.startsWith("sys_idIN"))
        return respond([]);
      if (table === "sys_metadata" && fields === "sys_id,sys_class_name")
        return respond(
          offset === 0
            ? [{ sys_id: "i1" }, { sys_id: "i2" }, { sys_id: "i3" }]
            : [],
        );
      if (table === "x_tbl") {
        const ids = query
          .replace(/^sys_idIN/, "")
          .split("^")[0]
          .split(",");
        return respond(idAnswer(ids));
      }
      return undefined;
    });

  it("accepts a sys_idIN chunk that returns every requested id", async () => {
    const m = await rawBuilder().buildManifestFromTableAPI(
      "x_app",
      idFallbackClient((ids) => ids.map((id) => ({ sys_id: id, name: id }))),
      emptyConfig,
    );
    assert.deepEqual(Object.keys(m.tables.x_tbl.records).sort(), [
      "i1",
      "i2",
      "i3",
    ]);
  });

  it("fails closed on a short sys_idIN chunk with no filter to explain it", async () => {
    await assert.rejects(
      rawBuilder().buildManifestFromTableAPI(
        "x_app",
        idFallbackClient((ids) =>
          ids.slice(1).map((id) => ({ sys_id: id, name: id })),
        ),
        emptyConfig,
      ),
      /failed tables: x_tbl/,
    );
  });

  it("accepts a short sys_idIN chunk when a tableOptions.query filter explains it", async () => {
    const m = await rawBuilder().buildManifestFromTableAPI(
      "x_app",
      idFallbackClient((ids) =>
        ids.slice(1).map((id) => ({ sys_id: id, name: id })),
      ),
      { ...emptyConfig, tableOptions: { x_tbl: { query: "active=true" } } },
    );
    assert.deepEqual(Object.keys(m.tables.x_tbl.records).sort(), ["i2", "i3"]);
  });

  it("fails on a sys_idIN chunk that returns an id it did not ask for", async () => {
    const warns = [];
    await assert.rejects(
      rawBuilder(warns).buildManifestFromTableAPI(
        "x_app",
        idFallbackClient((ids) => [
          ...ids.slice(1).map((id) => ({ sys_id: id, name: id })),
          { sys_id: "zz", name: "zz" },
        ]),
        { ...emptyConfig, tableOptions: { x_tbl: { query: "active=true" } } },
      ),
      /failed tables: x_tbl/,
    );
    assert.ok(warns.some((m) => /not requested/.test(m)));
  });

  it("fails on a sys_idIN chunk that repeats an id", async () => {
    const warns = [];
    await assert.rejects(
      rawBuilder(warns).buildManifestFromTableAPI(
        "x_app",
        idFallbackClient((ids) => [
          ...ids.map((id) => ({ sys_id: id, name: id })),
          { sys_id: "i1", name: "again" },
        ]),
        emptyConfig,
      ),
      /failed tables: x_tbl/,
    );
    assert.ok(warns.some((m) => /duplicate/.test(m)));
  });
});

// Wave 13 (2026-09-28): the bulk download pushed whatever each sys_idIN chunk
// returned, so a record hidden by an ACL, deleted, or cut off by a response cap
// vanished from a download that reported success; and the sys_db_object /
// sys_dictionary discovery, the per-table dictionary field reads and the sys_app
// listing were single fixed-limit requests that truncated silently. These doubles
// are raw (no well-behaved adapter): each honours or abuses `limit`/`offset`
// exactly as the case needs.
describe("sys_id completeness and paged fixed-limit reads (wave 13)", () => {
  const rawBuilder = (warns = []) =>
    createManifestBuilder({
      logger: { warn: (m) => warns.push(m), debug: () => {} },
      env: {},
    });

  /** Serves `rows` paged by offset/limit, never more than `cap` rows per answer. */
  const pageOf = (rows, limit, offset = 0, cap = Infinity) =>
    respond(rows.slice(offset, offset + Math.min(limit, cap)));

  const hexId = (i) => i.toString(16).padStart(32, "0");

  /** Answers sys_idIN queries on x_tbl through `answer(ids)`; records every call. */
  function idClient(answer, calls = []) {
    return {
      calls,
      async tableAPIGet(table, query, fields, limit, offset) {
        calls.push({ table, query, fields, limit, offset });
        const ids = query.replace(/^sys_idIN/, "").split(",");
        return respond(answer(ids));
      },
    };
  }

  const missingOf = (ids) =>
    Object.fromEntries(ids.map((id) => [id, [{ name: "script", type: "js" }]]));

  const rowsFor = (ids) =>
    ids.map((id) => ({ sys_id: id, name: `n-${id}`, script: `s-${id}` }));

  describe("buildBulkDownloadFromTableAPI", () => {
    it("returns every requested record across several chunks", async () => {
      const ids = Array.from({ length: 450 }, (_, i) => `id${i}`);
      const calls = [];
      const map = await rawBuilder().buildBulkDownloadFromTableAPI(
        { x_tbl: missingOf(ids) },
        idClient(rowsFor, calls),
        {},
      );
      assert.equal(Object.keys(map.x_tbl.records).length, 450);
      assert.deepEqual(
        calls.map((c) => c.query.split(",").length),
        [200, 200, 50],
      );
    });

    it("bounds each sys_idIN chunk by its encoded length", async () => {
      const ids = Array.from({ length: 200 }, (_, i) => hexId(i));
      const calls = [];
      await rawBuilder().buildBulkDownloadFromTableAPI(
        { x_tbl: missingOf(ids) },
        idClient(rowsFor, calls),
        {},
      );
      assert.deepEqual(
        calls.map((c) => c.query.split(",").length),
        [171, 29],
      );
      for (const c of calls) {
        const list = c.query.replace(/^sys_idIN/, "");
        assert.ok(encodeURIComponent(list).length <= 6000);
      }
    });

    it("fails by id when a requested record is missing", async () => {
      await assert.rejects(
        rawBuilder().buildBulkDownloadFromTableAPI(
          { x_tbl: missingOf(["a", "b", "c"]) },
          idClient((ids) => rowsFor(ids.filter((id) => id !== "b"))),
          {},
        ),
        (err) => {
          assert.equal(err.name, "SysIdCompletenessError");
          assert.equal(err.table, "x_tbl");
          assert.deepEqual(err.missingSysIds, ["b"]);
          assert.match(err.message, /2 of 3 requested records/);
          assert.match(err.message, /missing sys_id\(s\): "b"/);
          return true;
        },
      );
    });

    it("fails, naming the ids, when the server caps each answer (short page)", async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `id${i}`);
      await assert.rejects(
        rawBuilder().buildBulkDownloadFromTableAPI(
          { x_tbl: missingOf(ids) },
          idClient((chunk) => rowsFor(chunk.slice(0, 100))),
          {},
        ),
        (err) => {
          assert.equal(err.name, "SysIdCompletenessError");
          // 100 of the 200-id chunk and all 50 of the second chunk come back.
          assert.equal(err.missingSysIds.length, 100);
          assert.equal(err.missingSysIds[0], "id100");
          assert.match(err.message, /150 of 250/);
          assert.match(err.message, /and 80 more/);
          return true;
        },
      );
    });

    it("fails when a record comes back without a usable sys_id", async () => {
      await assert.rejects(
        rawBuilder().buildBulkDownloadFromTableAPI(
          { x_tbl: missingOf(["a", "b"]) },
          idClient(() => [...rowsFor(["a"]), { name: "anon", script: "x" }]),
          {},
        ),
        (err) => {
          assert.deepEqual(err.missingSysIds, ["b"]);
          return true;
        },
      );
    });

    it("fails on a duplicate id", async () => {
      await assert.rejects(
        rawBuilder().buildBulkDownloadFromTableAPI(
          { x_tbl: missingOf(["a", "b"]) },
          idClient((ids) => [...rowsFor(ids), ...rowsFor(["a"])]),
          {},
        ),
        /duplicate sys_id "a"/,
      );
    });

    it("fails on an id that was not requested", async () => {
      await assert.rejects(
        rawBuilder().buildBulkDownloadFromTableAPI(
          { x_tbl: missingOf(["a"]) },
          idClient(() => rowsFor(["zz"])),
          {},
        ),
        /"zz", which was not requested/,
      );
    });

    it("refuses an id that cannot be listed in sys_idIN before any request", async () => {
      const calls = [];
      await assert.rejects(
        rawBuilder().buildBulkDownloadFromTableAPI(
          { x_tbl: missingOf(["a", "b,c", "d^ORactive=true"]) },
          idClient(rowsFor, calls),
          {},
        ),
        /cannot be listed in a sys_idIN query/,
      );
      assert.equal(calls.length, 0);
    });

    it("still skips a table the instance refuses (403)", async () => {
      const warns = [];
      const map = await rawBuilder(warns).buildBulkDownloadFromTableAPI(
        { x_tbl: missingOf(["a"]) },
        {
          async tableAPIGet() {
            throw forbidden();
          },
        },
        {},
      );
      assert.deepEqual(map, {});
      assert.ok(warns.some((m) => /Skipping inaccessible table x_tbl/.test(m)));
    });
  });

  describe("manifest sys_idIN fallback", () => {
    it("names the missing ids when a chunk comes back short", async () => {
      const warns = [];
      const c = {
        async tableAPIGet(table, query, fields, limit, offset = 0) {
          if (table === "sys_app") return respond([{ sys_id: "S1" }]);
          if (table === "sys_metadata" && fields.startsWith("sys_class_name"))
            return pageOf(
              [{ sys_id: "m1", sys_class_name: "x_tbl" }],
              limit,
              offset,
            );
          if (table === "sys_metadata")
            return pageOf([{ sys_id: "i1" }, { sys_id: "i2" }], limit, offset);
          if (table === "sys_dictionary" && fields.startsWith("element,"))
            return pageOf(
              [
                {
                  sys_id: "d1",
                  element: "script",
                  internal_type: "script_plain",
                },
              ],
              limit,
              offset,
            );
          if (table === "x_tbl" && query.startsWith("sys_idIN"))
            return respond([{ sys_id: "i1", name: "One" }]);
          return respond([]);
        },
      };
      await assert.rejects(
        rawBuilder(warns).buildManifestFromTableAPI("x_app", c, emptyConfig),
        /failed tables: x_tbl/,
      );
      assert.ok(
        warns.some((m) => /missing sys_id\(s\): "i2"/.test(m)),
        warns.join("\n"),
      );
    });
  });

  describe("listAppsFromTableAPI", () => {
    const apps = (n) =>
      Array.from({ length: n }, (_, i) => ({
        sys_id: hexId(i),
        scope: `x_${i}`,
        name: `App ${i}`,
      }));

    function appClient(all, calls, cap) {
      return {
        async tableAPIGet(table, query, fields, limit, offset = 0) {
          calls.push({ table, query, fields, limit, offset });
          return pageOf(all, limit, offset, cap);
        },
      };
    }

    it("pages past the first 200 apps (multi-page happy path)", async () => {
      const calls = [];
      const list = await rawBuilder().listAppsFromTableAPI(
        appClient(apps(450), calls),
      );
      assert.equal(list.length, 450);
      assert.deepEqual(
        calls.map((c) => c.offset),
        [0, 200, 400, 450],
      );
      assert.equal(calls[0].query, "active=true^ORDERBYsys_id");
    });

    it("keeps paging when the server answers short pages", async () => {
      const calls = [];
      const list = await rawBuilder().listAppsFromTableAPI(
        appClient(apps(120), calls, 50),
      );
      assert.equal(list.length, 120);
      assert.deepEqual(
        calls.map((c) => c.offset),
        [0, 50, 100, 120],
      );
    });

    it("fails on a cap hit instead of truncating", async () => {
      await assert.rejects(
        rawBuilder().listAppsFromTableAPI(
          appClient(apps(LIST_APPS_MAX_ROWS + 1), []),
        ),
        (err) => {
          assert.equal(err.name, "TableAPIPagingError");
          assert.match(err.message, /sys_app exceeded the row cap of 10000/);
          return true;
        },
      );
    });

    it("accepts exactly the cap", async () => {
      const list = await rawBuilder().listAppsFromTableAPI(
        appClient(apps(LIST_APPS_MAX_ROWS), []),
      );
      assert.equal(list.length, LIST_APPS_MAX_ROWS);
    });
  });

  describe("discovery and field reads", () => {
    const scriptField = (i) => ({
      sys_id: `d${i}`,
      element: `script_${i}`,
      internal_type: "script_plain",
    });

    /**
     * Scope S1 with an empty sys_metadata discovery, so sys_db_object answers.
     * `dbObject` / `dictionary` are the row sets; `cap` limits every answer.
     */
    function discoveryClient(
      { dbObject, dictionary, cap = Infinity },
      calls = [],
    ) {
      return {
        calls,
        async tableAPIGet(table, query, fields, limit, offset = 0) {
          calls.push({ table, query, fields, limit, offset });
          if (table === "sys_app") return respond([{ sys_id: "S1" }]);
          if (table === "sys_metadata") return respond([]);
          if (table === "sys_db_object" && query.startsWith("sys_scope="))
            return pageOf(dbObject, limit, offset, cap);
          if (table === "sys_db_object") return respond([]);
          if (table === "sys_dictionary" && fields.startsWith("element,"))
            return pageOf(dictionary, limit, offset, cap);
          if (table.startsWith("x_t") && offset === 0)
            return respond([{ sys_id: `${table}-r`, name: `${table} rec` }]);
          return respond([]);
        },
      };
    }

    const tables = (n) =>
      Array.from({ length: n }, (_, i) => ({
        sys_id: `t${i}`,
        name: `x_t${i}`,
      }));

    it("pages sys_db_object discovery through short pages", async () => {
      const calls = [];
      const m = await rawBuilder().buildManifestFromTableAPI(
        "x_app",
        discoveryClient(
          { dbObject: tables(5), dictionary: [scriptField(0)], cap: 2 },
          calls,
        ),
        emptyConfig,
      );
      assert.deepEqual(Object.keys(m.tables).sort(), [
        "x_t0",
        "x_t1",
        "x_t2",
        "x_t3",
        "x_t4",
      ]);
      const discovery = calls.filter(
        (c) => c.table === "sys_db_object" && c.query.startsWith("sys_scope="),
      );
      assert.deepEqual(
        discovery.map((c) => c.offset),
        [0, 2, 4, 5],
      );
    });

    it("fails discovery on a cap hit instead of falling back or truncating", async () => {
      const calls = [];
      await assert.rejects(
        rawBuilder().buildManifestFromTableAPI(
          "x_app",
          discoveryClient(
            {
              dbObject: tables(TABLE_DISCOVERY_MAX_ROWS + 1),
              dictionary: [scriptField(0)],
            },
            calls,
          ),
          emptyConfig,
        ),
        /sys_db_object exceeded the row cap of 100000/,
      );
      assert.equal(
        calls.some((c) => c.table === "sys_dictionary"),
        false,
      );
    });

    it("pages the dictionary field read (multi-page happy path)", async () => {
      const calls = [];
      const m = await rawBuilder().buildManifestFromTableAPI(
        "x_app",
        discoveryClient(
          {
            dbObject: tables(1),
            dictionary: Array.from({ length: 450 }, (_, i) => scriptField(i)),
          },
          calls,
        ),
        emptyConfig,
      );
      assert.equal(m.tables.x_t0.records["x_t0 rec"].files.length, 450);
      assert.deepEqual(
        calls.filter((c) => c.table === "sys_dictionary").map((c) => c.offset),
        [0, 200, 400, 450],
      );
    });

    it("fails the table on a dictionary field cap hit", async () => {
      const warns = [];
      await assert.rejects(
        rawBuilder(warns).buildManifestFromTableAPI(
          "x_app",
          discoveryClient({
            dbObject: tables(1),
            dictionary: Array.from(
              { length: DICTIONARY_FIELD_MAX_ROWS + 1 },
              (_, i) => scriptField(i),
            ),
          }),
          emptyConfig,
        ),
        /failed tables: x_t0/,
      );
      assert.ok(warns.some((m) => /exceeded the row cap of 20000/.test(m)));
    });

    it("pages the data-only text-field read through short pages", async () => {
      const textFields = Array.from({ length: 7 }, (_, i) => ({
        sys_id: `f${i}`,
        element: `u_f${i}`,
      }));
      const c = {
        async tableAPIGet(table, query, fields, limit, offset = 0) {
          if (table === "sys_app") return respond([{ sys_id: "S1" }]);
          if (table === "sys_metadata") return respond([]);
          if (table === "sys_db_object" && query.startsWith("sys_scope="))
            return pageOf(tables(1), limit, offset);
          if (table === "sys_db_object") return respond([]);
          if (
            table === "sys_dictionary" &&
            fields.startsWith("element,internal_type")
          )
            return respond([]);
          if (table === "sys_dictionary")
            return pageOf(textFields, limit, offset, 3);
          if (table === "x_t0" && offset === 0)
            return respond([{ sys_id: "r", name: "rec" }]);
          return respond([]);
        },
      };
      const m = await createManifestBuilder({
        logger: { warn: () => {}, debug: () => {} },
        env: { SYNCRONA_INCLUDE_DATA_FIELDS: "true" },
      }).buildManifestFromTableAPI("x_app", c, emptyConfig);
      assert.deepEqual(
        m.tables.x_t0.records.rec.files.map((f) => f.name),
        textFields.map((f) => f.element),
      );
    });
  });
});

// Wave 14 (2026-09-30): the sys_metadata reads gained a row cap
// (SCOPE_METADATA_MAX_ROWS), the scope and table-hierarchy lookups read two rows
// and refuse an ambiguous answer, and the client-reported total cross-check is
// exercised on the paths the W5a tests did not reach. Raw doubles, no adapter.
describe("sys_metadata row cap, ambiguous lookups and total cross-check (wave 14)", () => {
  const rawBuilder = (warns = []) =>
    createManifestBuilder({
      logger: { warn: (m) => warns.push(m), debug: () => {} },
      env: {},
    });

  const pageOf = (rows, limit, offset = 0) =>
    respond(rows.slice(offset, offset + limit));

  const metaRows = (n, cls = "sys_script_include") =>
    Array.from({ length: n }, (_, i) => ({
      sys_id: `m${String(i).padStart(7, "0")}`,
      sys_class_name: cls,
    }));

  /**
   * Scope S1. `discovery` serves the whole-scope sys_metadata read, `perTable`
   * the per-table sys_metadata fallback; `records` answers the record query of
   * sys_script_include (sys_idIN chunks are answered from the requested ids).
   */
  function scopeClient({ discovery, perTable = [], records }, calls = []) {
    return {
      calls,
      async tableAPIGet(table, query, fields, limit, offset = 0) {
        calls.push({ table, query, fields, limit, offset });
        if (table === "sys_app") return respond([{ sys_id: "S1" }]);
        if (table === "sys_metadata" && query.includes("sys_class_name="))
          return pageOf(perTable, limit, offset);
        if (table === "sys_metadata") return pageOf(discovery, limit, offset);
        if (table === "sys_db_object") return respond([]);
        if (table === "sys_dictionary")
          return respond(
            offset === 0
              ? [{ element: "script", internal_type: "script_plain" }]
              : [],
          );
        if (table === "sys_script_include" && query.startsWith("sys_idIN"))
          return respond(
            query
              .split("^")[0]
              .slice("sys_idIN".length)
              .split(",")
              .map((id) => ({ sys_id: id, name: `n-${id}`, script: "x" })),
          );
        if (table === "sys_script_include")
          return pageOf(records ?? [], limit, offset);
        return respond([]);
      },
    };
  }

  describe("sys_metadata row cap", () => {
    it("is 250000", () => {
      assert.equal(SCOPE_METADATA_MAX_ROWS, 250_000);
    });

    it("accepts exactly the cap on scope discovery", async () => {
      const m = await rawBuilder().buildManifestFromTableAPI(
        "x_app",
        scopeClient({
          discovery: metaRows(SCOPE_METADATA_MAX_ROWS),
          records: [{ sys_id: "r1", name: "one", script: "x" }],
        }),
        emptyConfig,
      );
      assert.ok(m.tables.sys_script_include.records.one);
    });

    it("fails scope discovery one row past the cap, without a fallback", async () => {
      const calls = [];
      await assert.rejects(
        rawBuilder().buildManifestFromTableAPI(
          "x_app",
          scopeClient(
            {
              discovery: metaRows(SCOPE_METADATA_MAX_ROWS + 1),
              records: [{ sys_id: "r1", name: "one", script: "x" }],
            },
            calls,
          ),
          emptyConfig,
        ),
        (err) => {
          assert.equal(err.name, "TableAPIPagingError");
          assert.match(
            err.message,
            /sys_metadata exceeded the row cap of 250000/,
          );
          return true;
        },
      );
      assert.equal(
        calls.some(
          (c) => c.table === "sys_db_object" || c.table === "sys_dictionary",
        ),
        false,
      );
    });

    it("accepts exactly the cap on the per-table sys_id fallback", async () => {
      const m = await rawBuilder().buildManifestFromTableAPI(
        "x_app",
        scopeClient({
          discovery: metaRows(1),
          perTable: metaRows(SCOPE_METADATA_MAX_ROWS),
          records: [],
        }),
        emptyConfig,
      );
      assert.equal(
        Object.keys(m.tables.sys_script_include.records).length,
        SCOPE_METADATA_MAX_ROWS,
      );
    });

    it("fails the table one row past the cap on the per-table sys_id fallback", async () => {
      const warns = [];
      const calls = [];
      await assert.rejects(
        rawBuilder(warns).buildManifestFromTableAPI(
          "x_app",
          scopeClient(
            {
              discovery: metaRows(1),
              perTable: metaRows(SCOPE_METADATA_MAX_ROWS + 1),
              records: [],
            },
            calls,
          ),
          emptyConfig,
        ),
        /failed tables: sys_script_include/,
      );
      assert.ok(
        warns.some((m) =>
          /sys_metadata exceeded the row cap of 250000/.test(m),
        ),
      );
      // Refused before any sys_idIN chunk was requested.
      assert.equal(
        calls.some((c) => String(c.query).startsWith("sys_idIN")),
        false,
      );
    });
  });

  describe("ambiguous single-row lookups", () => {
    it("reads the scope with limit 2 and refuses two sys_app rows as a failed lookup", async () => {
      const calls = [];
      const c = {
        async tableAPIGet(table, _query, _fields, limit) {
          calls.push({ table, limit });
          if (table === "sys_app")
            return respond([{ sys_id: "S1" }, { sys_id: "S2" }]);
          return respond([]);
        },
      };
      await assert.rejects(
        rawBuilder().buildManifestFromTableAPI("x_app", c, emptyConfig),
        (err) => {
          assert.match(err.message, /Could not resolve scope "x_app"/);
          assert.match(err.message, /returned 2 rows .*ambiguous/);
          assert.doesNotMatch(err.message, /not found/);
          return true;
        },
      );
      assert.deepEqual(calls, [{ table: "sys_app", limit: 2 }]);
    });

    function hierarchyClient(dbObjectRows, calls = []) {
      return {
        calls,
        async tableAPIGet(table, query, fields, limit, offset = 0) {
          calls.push({ table, query, fields, limit, offset });
          if (table === "sys_app") return respond([{ sys_id: "S1" }]);
          if (table === "sys_metadata")
            return respond(
              offset === 0 ? [{ sys_id: "m1", sys_class_name: "x_tbl" }] : [],
            );
          if (table === "sys_db_object" && fields === "name,super_class.name")
            return respond(dbObjectRows(query));
          if (table === "sys_dictionary")
            return respond(
              offset === 0
                ? [{ element: "script", internal_type: "script_plain" }]
                : [],
            );
          if (table === "x_tbl" && offset === 0)
            return respond([{ sys_id: "r1", name: "one", script: "x" }]);
          return respond([]);
        },
      };
    }

    it("reads each hierarchy level with limit 2 and accepts a single row", async () => {
      const calls = [];
      const m = await rawBuilder().buildManifestFromTableAPI(
        "x_app",
        hierarchyClient(
          (q) =>
            q === "name=x_tbl"
              ? [{ name: "x_tbl", "super_class.name": "x_base" }]
              : [{ name: "x_base" }],
          calls,
        ),
        emptyConfig,
      );
      assert.ok(m.tables.x_tbl.records.one);
      const levels = calls.filter(
        (c) =>
          c.table === "sys_db_object" && c.fields === "name,super_class.name",
      );
      assert.deepEqual(
        levels.map((c) => [c.query, c.limit]),
        [
          ["name=x_tbl", 2],
          ["name=x_base", 2],
        ],
      );
    });

    it("fails the table when a hierarchy level returns two rows", async () => {
      const warns = [];
      await assert.rejects(
        rawBuilder(warns).buildManifestFromTableAPI(
          "x_app",
          hierarchyClient((q) =>
            q === "name=x_tbl"
              ? [
                  { name: "x_tbl", "super_class.name": "x_base" },
                  { name: "x_tbl", "super_class.name": "x_other" },
                ]
              : [],
          ),
          emptyConfig,
        ),
        /failed tables: x_tbl/,
      );
      assert.ok(
        warns.some((m) =>
          /sys_db_object returned 2 rows for table "x_tbl".*ambiguous/.test(m),
        ),
      );
    });
  });

  describe("client-reported total cross-check", () => {
    /** Serves `rows` of sys_metadata discovery, attaching `total(offset)` to each answer. */
    function totalClient(rows, total) {
      return {
        async tableAPIGet(table, query, fields, limit, offset = 0) {
          if (table === "sys_app") return respond([{ sys_id: "S1" }]);
          if (table === "sys_metadata")
            return {
              ...pageOf(rows, Math.min(limit, 2), offset),
              total: total(offset),
            };
          if (table === "sys_dictionary")
            return respond(
              offset === 0
                ? [{ element: "script", internal_type: "script_plain" }]
                : [],
            );
          if (table === "sys_script_include" && offset === 0)
            return respond([{ sys_id: "r1", name: "one", script: "x" }]);
          return respond([]);
        },
      };
    }

    it("accepts a matching total across several pages", async () => {
      const m = await rawBuilder().buildManifestFromTableAPI(
        "x_app",
        totalClient(metaRows(5), () => 5),
        emptyConfig,
      );
      assert.ok(m.tables.sys_script_include);
    });

    it("fails when the rows received exceed the reported total", async () => {
      await assert.rejects(
        rawBuilder().buildManifestFromTableAPI(
          "x_app",
          totalClient(metaRows(5), () => 4),
          emptyConfig,
        ),
        (err) => {
          assert.equal(err.name, "TableAPIPagingError");
          assert.match(
            err.message,
            /returned 5 rows but X-Total-Count reported 4/,
          );
          return true;
        },
      );
    });

    it("fails when the reported total changes mid-read", async () => {
      // The first page reports 5, the rest 3. Since wave 15 the change itself is
      // refused at the first page reporting 3 (every page of one read must agree),
      // before the final count is compared.
      await assert.rejects(
        rawBuilder().buildManifestFromTableAPI(
          "x_app",
          totalClient(metaRows(5), (offset) => (offset === 0 ? 5 : 3)),
          emptyConfig,
        ),
        /X-Total-Count reported 3/,
      );
    });

    for (const [label, total] of [
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["a numeric string", "99"],
      ["null", null],
    ]) {
      it(`does not cross-check a total that is ${label}`, async () => {
        const m = await rawBuilder().buildManifestFromTableAPI(
          "x_app",
          totalClient(metaRows(5), () => total),
          emptyConfig,
        );
        assert.ok(m.tables.sys_script_include);
      });
    }
  });
});

// Wave 15: every value interpolated into an encoded query is escaped, and the
// X-Total-Count cross-check is live wherever a client reports a total — with an
// opt-in policy that refuses a paged read no total vouches for, and a warning
// (never a silent "complete") when the default policy lets one through.
describe("encoded-query escaping and X-Total-Count policy (wave 15)", () => {
  const rawBuilder = (warns = [], extra = {}) =>
    createManifestBuilder({
      logger: { warn: (m) => warns.push(m), debug: () => {} },
      env: {},
      ...extra,
    });

  const pageOf = (rows, limit, offset = 0) =>
    respond(rows.slice(offset, offset + limit));

  // Wave 16: an identifier interpolated into an encoded query — a scope
  // sys_id, a discovered table, a parent named by the instance, a config field
  // exclude — is refused when it carries anything a ServiceNow identifier
  // cannot, instead of being escaped into a literal that reads as empty.
  describe("encoded-query identifier refusal", () => {
    const isRefusal = (kind, value) => (e) =>
      e instanceof QueryIdentifierError &&
      e.kind === kind &&
      (value === undefined || e.value === value);

    for (const inj of [
      "^ORname=sys_user",
      "^NQname=sys_user",
      "^name=sys_user",
      "^ORsys_scope=global",
      "=sys_user",
      " sys_user",
      ",sys_user",
    ]) {
      const BAD = `x_tbl${inj}`;

      /** Scope S1 → one table T whose parent is P. */
      function scopeClient({ scopeId = "S1", T = "x_tbl", P = "x_base" }) {
        const calls = [];
        const client = {
          async tableAPIGet(table, query, fields, limit, offset = 0) {
            calls.push({ table, query, fields, offset });
            if (table === "sys_app") return respond([{ sys_id: scopeId }]);
            if (table === "sys_metadata" && query.includes("sys_class_name="))
              return respond([]);
            if (table === "sys_metadata")
              return pageOf(
                [{ sys_id: "m1", sys_class_name: T }],
                limit,
                offset,
              );
            if (table === "sys_db_object")
              return respond(
                query === `name=${T}`
                  ? [{ name: T, "super_class.name": P }]
                  : [],
              );
            if (table === "sys_dictionary")
              return respond(
                offset === 0
                  ? [{ element: "script", internal_type: "script_plain" }]
                  : [],
              );
            return respond([]);
          },
        };
        return { calls, client };
      }

      it(`refuses a scope sys_id carrying ${JSON.stringify(inj)} before discovery`, async () => {
        const { calls, client } = scopeClient({ scopeId: `S1${inj}` });
        await assert.rejects(
          rawBuilder().buildManifestFromTableAPI("x_app", client, emptyConfig),
          isRefusal("scope sys_id", `S1${inj}`),
        );
        assert.deepEqual(
          calls.map((c) => c.table),
          ["sys_app"],
        );
      });

      it(`refuses a discovered table carrying ${JSON.stringify(inj)} before any per-table read`, async () => {
        const { calls, client } = scopeClient({ T: BAD });
        await assert.rejects(
          rawBuilder().buildManifestFromTableAPI("x_app", client, emptyConfig),
          isRefusal("table", BAD),
        );
        assert.deepEqual(
          calls.map((c) => c.table),
          ["sys_app", "sys_metadata", "sys_metadata"],
        );
      });

      it(`refuses a parent table carrying ${JSON.stringify(inj)} before its hierarchy read`, async () => {
        const warns = [];
        const P = `x_base${inj}`;
        const { calls, client } = scopeClient({ P });
        await assert.rejects(
          rawBuilder(warns).buildManifestFromTableAPI(
            "x_app",
            client,
            emptyConfig,
          ),
          /failed tables: x_tbl/,
        );
        assert.ok(
          warns.some((m) => /Refusing .*parent table/.test(m)),
          JSON.stringify(warns),
        );
        for (const c of calls) {
          assert.ok(!c.query.includes(P), JSON.stringify(c.query));
        }
        assert.deepEqual(
          calls.filter((c) => c.table === "sys_dictionary"),
          [],
        );
      });

      it(`refuses a config field exclude carrying ${JSON.stringify(inj)} before any read`, async () => {
        const EX = `script${inj}`;
        const { calls, client } = scopeClient({});
        await assert.rejects(
          rawBuilder().buildManifestFromTableAPI("x_app", client, {
            includes: {},
            excludes: { x_tbl: { [EX]: {} } },
            tableOptions: {},
          }),
          isRefusal("field", EX),
        );
        assert.deepEqual(calls, []);
      });

      it(`refuses a bulk-download table carrying ${JSON.stringify(inj)} before any read`, async () => {
        const calls = [];
        const client = {
          async tableAPIGet(table, query) {
            calls.push({ table, query });
            return respond([]);
          },
        };
        await assert.rejects(
          rawBuilder().buildBulkDownloadFromTableAPI(
            {
              // A valid table first: its read must not have been sent either.
              sys_script_include: { a1: [{ name: "script", type: "js" }] },
              [BAD]: { a2: [{ name: "script", type: "js" }] },
            },
            client,
            {},
          ),
          isRefusal("table", BAD),
        );
        assert.deepEqual(calls, []);
      });
    }

    it("still queries well-formed identifiers verbatim (dot-walked field excludes included)", async () => {
      const calls = [];
      const client = {
        async tableAPIGet(table, query, fields, limit, offset = 0) {
          calls.push({ table, query, fields, offset });
          if (table === "sys_app") return respond([{ sys_id: "S-1" }]);
          if (table === "sys_metadata" && query.includes("sys_class_name="))
            return respond([]);
          if (table === "sys_metadata")
            return pageOf(
              [{ sys_id: "m1", sys_class_name: "x_tbl" }],
              limit,
              offset,
            );
          if (table === "sys_db_object")
            return respond(
              query === "name=x_tbl"
                ? [{ name: "x_tbl", "super_class.name": "x_base" }]
                : [],
            );
          if (table === "sys_dictionary")
            return respond(
              offset === 0
                ? [{ element: "script", internal_type: "script_plain" }]
                : [],
            );
          return respond([]);
        },
      };
      await rawBuilder()
        .buildManifestFromTableAPI("x_app", client, {
          includes: {},
          excludes: { x_tbl: { "inputs.script": {} } },
          tableOptions: {},
        })
        .catch(() => {});
      const q = (table, pred) =>
        calls
          .filter((c) => c.table === table && c.offset === 0 && pred(c))
          .map((c) => c.query);
      assert.deepEqual(
        q("sys_app", () => true),
        ["scope=x_app"],
      );
      assert.deepEqual(
        q("sys_db_object", (c) => c.fields === "name,super_class.name"),
        ["name=x_tbl", "name=x_base"],
      );
      const dict = q("sys_dictionary", () => true);
      assert.ok(dict.length > 0);
      for (const d of dict) {
        assert.ok(d.startsWith("name=x_tbl^ORname=x_base^"), d);
        assert.ok(d.includes("^element!=inputs.script"), d);
      }
      assert.deepEqual(
        q("x_tbl", () => true),
        ["sys_scope=S-1^sys_class_name=x_tbl^ORDERBYsys_id"],
      );
    });

    it("QueryIdentifierError is exported from the package barrel", async () => {
      const barrel = await import("../build/index.js");
      assert.equal(barrel.QueryIdentifierError, QueryIdentifierError);
      // escapeQueryValue stays for free-text values.
      assert.equal(barrel.escapeQueryValue("a^b"), "a b");
    });
  });

  it("refuses a server-supplied sys_id with `^` before the record fallback's sys_idIN read", async () => {
    const calls = [];
    const warns = [];
    const client = {
      async tableAPIGet(table, query, fields, limit, offset = 0) {
        calls.push({ table, query });
        if (table === "sys_app") return respond([{ sys_id: "S1" }]);
        if (table === "sys_metadata" && query.includes("sys_class_name="))
          return pageOf(
            [{ sys_id: "a1^ORsys_scope=global", sys_class_name: "x_tbl" }],
            limit,
            offset,
          );
        if (table === "sys_metadata")
          return pageOf(
            [{ sys_id: "m1", sys_class_name: "x_tbl" }],
            limit,
            offset,
          );
        if (table === "sys_dictionary")
          return respond(
            offset === 0
              ? [{ element: "script", internal_type: "script_plain" }]
              : [],
          );
        return respond([]);
      },
    };
    await assert.rejects(
      rawBuilder(warns).buildManifestFromTableAPI("x_app", client, emptyConfig),
      /failed tables: x_tbl/,
    );
    assert.ok(
      warns.some((m) => /Refusing to query x_tbl by sys_id/.test(m)),
      JSON.stringify(warns),
    );
    assert.deepEqual(
      calls.filter((c) => c.query.startsWith("sys_idIN")),
      [],
    );
  });

  describe("X-Total-Count policy", () => {
    const metaRows = (n) =>
      Array.from({ length: n }, (_, i) => ({
        sys_id: `m${String(i).padStart(7, "0")}`,
        sys_class_name: "sys_script_include",
      }));

    /**
     * Scope S1 with one table. Every paged read is served in pages of two and
     * carries `total(table, offset, rowCount)` when that returns a value.
     */
    function scopeClient(total, meta = metaRows(5)) {
      const serve = (table, rows, limit, offset) => {
        const res = pageOf(rows, Math.min(limit, 2), offset);
        const t = total(table, offset, rows.length);
        return t === undefined ? res : { ...res, total: t };
      };
      return {
        async tableAPIGet(table, query, fields, limit, offset = 0) {
          if (table === "sys_app" && query.startsWith("scope="))
            return respond([{ sys_id: "S1" }]);
          if (table === "sys_app")
            return serve(
              table,
              [{ sys_id: "a1", scope: "x_app", name: "App" }],
              limit,
              offset,
            );
          if (table === "sys_metadata")
            return serve(table, meta, limit, offset);
          if (table === "sys_db_object") return respond([]);
          if (table === "sys_dictionary")
            return serve(
              table,
              [
                {
                  sys_id: "d1",
                  element: "script",
                  internal_type: "script_plain",
                },
              ],
              limit,
              offset,
            );
          return serve(
            table,
            [{ sys_id: "r1", name: "one", script: "x" }],
            limit,
            offset,
          );
        },
      };
    }
    const exact = (_t, _o, n) => n;
    const none = () => undefined;

    it("fails when X-Total-Count changes between pages, even if the last one matches", async () => {
      // Six rows counted on the first page, five afterwards and five received:
      // a row was deleted mid-read, so offset paging skipped one. The final
      // count agrees with the latest total, so only the page-to-page check sees it.
      await assert.rejects(
        rawBuilder().buildManifestFromTableAPI(
          "x_app",
          scopeClient((t, o, n) => (t === "sys_metadata" && o === 0 ? 6 : n)),
          emptyConfig,
        ),
        (err) => {
          assert.equal(err.name, "TableAPIPagingError");
          assert.match(
            err.message,
            /X-Total-Count reported 5 at offset 2 but 6 on an earlier page/,
          );
          return true;
        },
      );
    });

    it("default policy: a build no total vouches for warns that completeness is unverified", async () => {
      const warns = [];
      const m = await rawBuilder(warns).buildManifestFromTableAPI(
        "x_app",
        scopeClient(none),
        emptyConfig,
      );
      assert.ok(m.tables.sys_script_include.records.one);
      const w = warns.filter((x) => /X-Total-Count/.test(x));
      assert.equal(w.length, 1, JSON.stringify(warns));
      assert.match(w[0], /unverified/);
      assert.match(w[0], /sys_metadata/);
      assert.match(w[0], /sys_dictionary/);
      assert.match(w[0], /sys_script_include/);
    });

    it("default policy: no warning when every paged read carries a matching total", async () => {
      const warns = [];
      await rawBuilder(warns).buildManifestFromTableAPI(
        "x_app",
        scopeClient(exact),
        emptyConfig,
      );
      assert.deepEqual(
        warns.filter((x) => /X-Total-Count/.test(x)),
        [],
      );
    });

    it("default policy: names only the reads that lacked a total", async () => {
      const warns = [];
      await rawBuilder(warns).buildManifestFromTableAPI(
        "x_app",
        scopeClient((t, o, n) => (t === "sys_dictionary" ? undefined : n)),
        emptyConfig,
      );
      const w = warns.filter((x) => /X-Total-Count/.test(x));
      assert.equal(w.length, 1);
      assert.match(w[0], /sys_dictionary/);
      assert.doesNotMatch(w[0], /sys_metadata|sys_script_include/);
    });

    it("requireTotalCount: refuses a paged read without X-Total-Count", async () => {
      await assert.rejects(
        rawBuilder([], { requireTotalCount: true }).buildManifestFromTableAPI(
          "x_app",
          scopeClient(none),
          emptyConfig,
        ),
        (err) => {
          assert.equal(err.name, "TableAPIPagingError");
          assert.match(err.message, /sys_metadata.*no X-Total-Count/);
          return true;
        },
      );
    });

    it("requireTotalCount: refuses a read where only some pages carry the total", async () => {
      await assert.rejects(
        rawBuilder([], { requireTotalCount: true }).buildManifestFromTableAPI(
          "x_app",
          scopeClient((t, o, n) =>
            t === "sys_metadata" && o > 0 ? undefined : n,
          ),
          emptyConfig,
        ),
        /sys_metadata.*no X-Total-Count/,
      );
    });

    it("requireTotalCount: a build where every read carries a matching total succeeds without a warning", async () => {
      const warns = [];
      const m = await rawBuilder(warns, {
        requireTotalCount: true,
      }).buildManifestFromTableAPI("x_app", scopeClient(exact), emptyConfig);
      assert.ok(m.tables.sys_script_include.records.one);
      assert.deepEqual(warns, []);
    });

    it("listApps: default policy warns, requireTotalCount refuses, a total passes", async () => {
      const warns = [];
      const apps = await rawBuilder(warns).listAppsFromTableAPI(
        scopeClient(none),
      );
      assert.equal(apps.length, 1);
      assert.ok(
        warns.some((x) => /X-Total-Count.*sys_app/.test(x)),
        JSON.stringify(warns),
      );

      await assert.rejects(
        rawBuilder([], { requireTotalCount: true }).listAppsFromTableAPI(
          scopeClient(none),
        ),
        /sys_app.*no X-Total-Count/,
      );

      const quiet = [];
      await rawBuilder(quiet, { requireTotalCount: true }).listAppsFromTableAPI(
        scopeClient(exact),
      );
      assert.deepEqual(quiet, []);
    });
  });
});
