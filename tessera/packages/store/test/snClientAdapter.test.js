// Wave 16: the production SNClient adapter over @tessera/sn-client's
// single-page `queryTable`. Unit tests drive it with a stub `queryTable`; the
// contract tests at the bottom compose it with the real sn-client `tableApi`
// against the stateful fake instance, which is what makes the wave-15
// X-Total-Count cross-check and `requireTotalCount` live.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  createSnClientAdapter,
  createSnClientManifestBuilder,
  getErrorResponseStatus,
  isScopedEndpointUnavailableError,
  STORE_FIXED_TABLES,
  SnClientHttpError,
  SnClientReadError,
  TableAPIPagingError,
} from "../build/index.js";

/** A structural stand-in for sn-client's ServiceNowError. */
function snError(message, status, detail) {
  const e = new Error(message);
  e.name = "ServiceNowError";
  if (status !== undefined) e.status = status;
  if (detail !== undefined) e.detail = detail;
  return e;
}

function stubQueryTable(answer) {
  const calls = [];
  const queryTable = async (opts) => {
    calls.push(opts);
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(opts) : answer;
  };
  return { calls, queryTable };
}

describe("createSnClientAdapter (wave 16)", () => {
  it("maps tableAPIGet onto one queryTable page and returns the total", async () => {
    const records = [{ sys_id: "a1", scope: "x_app", name: "App" }];
    const { calls, queryTable } = stubQueryTable({ records, total: 7 });
    const client = createSnClientAdapter({ queryTable });

    const res = await client.tableAPIGet(
      "sys_app",
      "active=true^ORDERBYsys_id",
      "sys_id, scope,name,,",
      200,
      400,
    );

    assert.deepEqual(calls, [
      {
        table: "sys_app",
        query: "active=true^ORDERBYsys_id",
        fields: ["sys_id", "scope", "name"],
        limit: 200,
        offset: 400,
      },
    ]);
    assert.deepEqual(res, { data: { result: records }, total: 7 });
  });

  it("defaults the offset to 0 and omits a total the client did not report", async () => {
    for (const total of [undefined, Number.NaN, Infinity, "7"]) {
      const { calls, queryTable } = stubQueryTable({ records: [], total });
      const res = await createSnClientAdapter({ queryTable }).tableAPIGet(
        "sys_metadata",
        "sys_scope=S1",
        "sys_class_name",
        10,
      );
      assert.equal(calls[0].offset, 0);
      assert.deepEqual(res, { data: { result: [] } }, String(total));
      assert.ok(!("total" in res), String(total));
    }
  });

  it("refuses a read with no limit instead of inheriting the client's default page size", async () => {
    const { calls, queryTable } = stubQueryTable({ records: [] });
    await assert.rejects(
      createSnClientAdapter({ queryTable }).tableAPIGet(
        "sys_app",
        "active=true",
        "sys_id",
      ),
      /limit/,
    );
    assert.equal(calls.length, 0);
  });

  it("maps an instance HTTP answer to the status shape the store classifiers read", async () => {
    for (const status of [403, 404, 500]) {
      const cause = snError(`ServiceNow API error (${status})`, status, {});
      const { queryTable } = stubQueryTable(cause);
      const err = await createSnClientAdapter({ queryTable })
        .tableAPIGet("sys_app", "active=true", "sys_id", 10)
        .then(
          () => assert.fail("expected a rejection"),
          (e) => e,
        );
      assert.ok(err instanceof SnClientHttpError);
      assert.equal(err.name, "SnClientHttpError");
      assert.equal(err.isAxiosError, true);
      assert.deepEqual(err.response, { status });
      assert.equal(err.cause, cause);
      assert.equal(getErrorResponseStatus(err), status);
    }
  });

  it("never lets a client-side refusal pass as the instance's own 403", async () => {
    // A SN_TABLES_ALLOW/DENY denial is a ServiceNowError(msg, 403) with no
    // detail: sn-client fabricated it, the instance was never asked.
    const policy = snError("Table sys_app is not allowed", 403);
    const redirect = snError("redirect refused", 302);
    const transport = snError("fetch failed");
    const other = new TypeError("boom");
    for (const cause of [policy, redirect, transport, other]) {
      const { queryTable } = stubQueryTable(cause);
      const err = await createSnClientAdapter({ queryTable })
        .tableAPIGet("sys_app", "active=true", "sys_id", 10)
        .then(
          () => assert.fail("expected a rejection"),
          (e) => e,
        );
      assert.ok(err instanceof SnClientReadError, cause.message);
      assert.equal(err.cause, cause);
      assert.equal(err.isAxiosError, undefined);
      assert.equal(err.response, undefined);
      assert.equal(err.status, undefined);
      assert.equal(getErrorResponseStatus(err), undefined);
      assert.equal(isScopedEndpointUnavailableError(err), false);
    }
  });

  it("names the fixed tables the store reads", () => {
    assert.deepEqual([...STORE_FIXED_TABLES].sort(), [
      "sys_app",
      "sys_db_object",
      "sys_dictionary",
      "sys_metadata",
    ]);
    assert.ok(Object.isFrozen(STORE_FIXED_TABLES));
  });
});

describe("createSnClientManifestBuilder (wave 16)", () => {
  const logger = () => {
    const warns = [];
    return { warns, logger: { warn: (m) => warns.push(m), debug: () => {} } };
  };
  const pagedApps = (total) => ({
    queryTable: async ({ offset }) =>
      offset === 0
        ? { records: [{ sys_id: "a1", scope: "x_app", name: "App" }], total }
        : { records: [], total },
  });

  it("defaults requireTotalCount to true", async () => {
    const { logger: l } = logger();
    const client = createSnClientAdapter(pagedApps(undefined));
    await assert.rejects(
      createSnClientManifestBuilder({
        logger: l,
        env: {},
      }).listAppsFromTableAPI(client),
      TableAPIPagingError,
    );
  });

  it("keeps an explicit requireTotalCount: false (warns instead)", async () => {
    const { logger: l, warns } = logger();
    const client = createSnClientAdapter(pagedApps(undefined));
    const apps = await createSnClientManifestBuilder({
      logger: l,
      env: {},
      requireTotalCount: false,
    }).listAppsFromTableAPI(client);
    assert.equal(apps.length, 1);
    assert.ok(
      warns.some((m) => /X-Total-Count/.test(m)),
      JSON.stringify(warns),
    );
  });

  it("accepts a read every page of which carries a matching total", async () => {
    const { logger: l, warns } = logger();
    const client = createSnClientAdapter(pagedApps(1));
    const apps = await createSnClientManifestBuilder({
      logger: l,
      env: {},
    }).listAppsFromTableAPI(client);
    assert.deepEqual(apps, [
      { sys_id: "a1", scope: "x_app", displayName: "App" },
    ]);
    assert.deepEqual(warns, []);
  });
});

// Contract: the adapter composed with the real sn-client over the fake.
describe("sn-client composition over the fake instance (wave 16)", async () => {
  const { createFakeInstance } = await import("@tessera/fake-instance");
  const { reloadCredentialsFromEnv, setLogSink, tableApi } =
    await import("@tessera/sn-client");

  const HOST = "dev12345.service-now.com";
  const hex = (n) => String(n).padStart(32, "0");
  const APPS = [1, 2, 3].map((n) => ({
    sys_id: hex(n),
    scope: `x_app${n}`,
    name: `App ${n}`,
    active: "true",
  }));

  let savedEnv = {};
  let originalFetch;

  beforeEach(() => {
    savedEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SN_")) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    process.env.SN_INSTANCE = "dev12345";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "s3cret";
    process.env.SN_MAX_RETRIES = "0";
    process.env.SN_LOG_LEVEL = "warn";
    reloadCredentialsFromEnv();
    setLogSink(() => {});
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SN_")) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    reloadCredentialsFromEnv();
    setLogSink(null);
  });

  function routeTo(options) {
    const fake = createFakeInstance({
      host: HOST,
      state: { sys_app: APPS.map((r) => ({ ...r })) },
      ...options,
    });
    const urls = [];
    globalThis.fetch = (input, init) => {
      urls.push(new URL(String(input)));
      return fake.fetch(input, init);
    };
    return urls;
  }

  const build = () =>
    createSnClientManifestBuilder({
      logger: { warn: () => {}, debug: () => {} },
      env: {},
    });
  const client = () =>
    createSnClientAdapter({ queryTable: (opts) => tableApi.queryTable(opts) });

  it("lists every app with the X-Total-Count cross-check live", async () => {
    const urls = routeTo({});
    const apps = await build().listAppsFromTableAPI(client());
    assert.deepEqual(
      apps.map((a) => a.scope),
      ["x_app1", "x_app2", "x_app3"],
    );
    const first = urls[0];
    assert.equal(first.pathname, "/api/now/table/sys_app");
    assert.equal(first.searchParams.get("sysparm_limit"), "200");
    assert.equal(
      first.searchParams.get("sysparm_query"),
      "active=true^ORDERBYsys_id",
    );
    assert.deepEqual(
      urls.map((u) => Number(u.searchParams.get("sysparm_offset") ?? "0")),
      [0, 3],
    );
  });

  it("refuses a listing no X-Total-Count vouches for", async () => {
    routeTo({ omitTotalCount: true });
    await assert.rejects(
      build().listAppsFromTableAPI(client()),
      TableAPIPagingError,
    );
  });

  it("fails a listing sn-client's table policy refuses instead of returning no apps", async () => {
    routeTo({});
    process.env.SN_TABLES_DENY = "sys_app";
    reloadCredentialsFromEnv();
    await assert.rejects(
      build().listAppsFromTableAPI(client()),
      SnClientReadError,
    );
  });
});
