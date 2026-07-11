import { test } from "node:test";
import assert from "node:assert/strict";

import { scopedAppDeps } from "../../build/checks/scoped-app-deps.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";

/** Build a context with the given required apps and seeded table fixtures. */
function ctx(requiredApps, fixtures = {}) {
  return {
    instanceUrl: INSTANCE,
    http: createFakeSnClient(fixtures),
    options: requiredApps === undefined ? undefined : { requiredApps },
  };
}

test("scopedAppDeps has the frozen name", () => {
  assert.equal(scopedAppDeps.name, "scoped-app-deps");
});

test("warns when no requiredApps are declared", async () => {
  const result = await scopedAppDeps.run(ctx());
  assert.equal(result.name, "scoped-app-deps");
  assert.equal(result.status, "warn");
});

test("warns when requiredApps is an empty list", async () => {
  const result = await scopedAppDeps.run(ctx([]));
  assert.equal(result.status, "warn");
});

test("warns when every requiredApps entry is malformed", async () => {
  const result = await scopedAppDeps.run(
    ctx([null, 42, { minVersion: "1.0.0" }, { id: "  " }]),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /malformed/);
});

test("passes when a required scoped app is present (no version constraint)", async () => {
  const result = await scopedAppDeps.run(
    ctx([{ id: "x_acme_core" }], {
      tables: {
        sys_store_app: [
          {
            sys_id: "1",
            scope: "x_acme_core",
            name: "Acme Core",
            version: "3.2.1",
          },
        ],
        sys_plugins: [],
      },
    }),
  );
  assert.equal(result.status, "pass");
});

test("passes when a required plugin is present and active and meets minVersion", async () => {
  const result = await scopedAppDeps.run(
    ctx([{ id: "com.snc.discovery", minVersion: "2.0.0" }], {
      tables: {
        sys_store_app: [],
        sys_plugins: [
          {
            sys_id: "p1",
            id: "com.snc.discovery",
            active: "true",
            version: "2.4.0",
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /up to date/);
});

test("passes when multiple deps are all satisfied", async () => {
  const result = await scopedAppDeps.run(
    ctx(
      [{ id: "x_acme_core", minVersion: "3.0.0" }, { id: "com.snc.discovery" }],
      {
        tables: {
          sys_store_app: [
            { sys_id: "1", scope: "x_acme_core", version: "3.2.1" },
          ],
          sys_plugins: [
            { sys_id: "p1", id: "com.snc.discovery", active: "true" },
          ],
        },
      },
    ),
  );
  assert.equal(result.status, "pass");
});

test("fails when a required app is missing", async () => {
  const result = await scopedAppDeps.run(
    ctx([{ id: "x_acme_missing" }], {
      tables: { sys_store_app: [], sys_plugins: [] },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /not installed/);
});

test("fails when a required plugin is present but inactive", async () => {
  const result = await scopedAppDeps.run(
    ctx([{ id: "com.snc.discovery" }], {
      tables: {
        sys_store_app: [],
        sys_plugins: [
          { sys_id: "p1", id: "com.snc.discovery", active: "false" },
        ],
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /inactive/);
});

test("fails when a required app is below its minVersion", async () => {
  const result = await scopedAppDeps.run(
    ctx([{ id: "x_acme_core", minVersion: "3.5.0" }], {
      tables: {
        sys_store_app: [
          { sys_id: "1", scope: "x_acme_core", version: "3.2.1" },
        ],
        sys_plugins: [],
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /below the required/);
});

test("fail aggregates and reports all unsatisfied deps", async () => {
  const result = await scopedAppDeps.run(
    ctx(
      [{ id: "x_acme_core", minVersion: "9.0.0" }, { id: "x_acme_missing" }],
      {
        tables: {
          sys_store_app: [
            { sys_id: "1", scope: "x_acme_core", version: "3.2.1" },
          ],
          sys_plugins: [],
        },
      },
    ),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /2 of 2/);
  assert.match(result.message, /x_acme_core/);
  assert.match(result.message, /x_acme_missing/);
});

test("warns when a present dep has no verifiable version but minVersion was requested", async () => {
  const result = await scopedAppDeps.run(
    ctx([{ id: "x_acme_core", minVersion: "1.0.0" }], {
      tables: {
        sys_store_app: [{ sys_id: "1", scope: "x_acme_core" }],
        sys_plugins: [],
      },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /version is unknown/);
});

test("warns (not fails) when all deps present but some entries were malformed", async () => {
  const result = await scopedAppDeps.run(
    ctx([{ id: "x_acme_core" }, { bogus: true }], {
      tables: {
        sys_store_app: [
          { sys_id: "1", scope: "x_acme_core", version: "1.0.0" },
        ],
        sys_plugins: [],
      },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /malformed/);
});

test("version comparison treats equal versions as satisfied", async () => {
  const result = await scopedAppDeps.run(
    ctx([{ id: "x_acme_core", minVersion: "3.2.1" }], {
      tables: {
        sys_store_app: [
          { sys_id: "1", scope: "x_acme_core", version: "3.2.1" },
        ],
        sys_plugins: [],
      },
    }),
  );
  assert.equal(result.status, "pass");
});

test("fails when the installed version has a non-numeric segment (CC-43)", async () => {
  // A named release ("Madrid") or any non-numeric segment cannot be coerced to
  // a number; comparing it would silently treat the segment as 0 and either pass
  // or fail arbitrarily. The check must report it as unparseable, not guess.
  const result = await scopedAppDeps.run(
    ctx([{ id: "x_acme_core", minVersion: "3.0.0" }], {
      tables: {
        sys_store_app: [
          { sys_id: "1", scope: "x_acme_core", version: "Madrid" },
        ],
        sys_plugins: [],
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /non-numeric|cannot be compared|cannot parse/i);
});

test("treats an empty active flag as active (CC-44)", async () => {
  // An empty-string `active` is an unspecified flag, not "disabled". It must read
  // consistently with a missing column and a null — all active.
  const result = await scopedAppDeps.run(
    ctx([{ id: "com.snc.discovery" }], {
      tables: {
        sys_store_app: [],
        sys_plugins: [
          {
            sys_id: "p1",
            id: "com.snc.discovery",
            active: "",
            version: "1.0.0",
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "pass");
});

test("resolves a dependency shipped as a sys_app scoped app (SN-5)", async () => {
  // The dep exists only in sys_app (a custom/scoped app), not sys_store_app or
  // sys_plugins. It must still resolve — sys_app is part of the lookup union.
  const result = await scopedAppDeps.run(
    ctx([{ id: "x_acme_scoped", minVersion: "1.0.0" }], {
      tables: {
        sys_store_app: [],
        sys_plugins: [],
        sys_app: [{ sys_id: "a1", scope: "x_acme_scoped", version: "1.4.0" }],
      },
    }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /up to date/);
});

test("does not borrow latest_version for an empty installed version (SN-5)", async () => {
  // latest_version is the store's newest AVAILABLE build, not what is installed.
  // An empty installed `version` must read as unknown (warn), never satisfy the
  // minimum by falling back to latest_version.
  const result = await scopedAppDeps.run(
    ctx([{ id: "x_acme_core", minVersion: "1.0.0" }], {
      tables: {
        sys_store_app: [
          {
            sys_id: "1",
            scope: "x_acme_core",
            version: "",
            latest_version: "9.9.9",
          },
        ],
        sys_plugins: [],
      },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /version is unknown/i);
});

test("matches a required id against the plugin source field, case-insensitively", async () => {
  const result = await scopedAppDeps.run(
    ctx([{ id: "COM.SNC.Discovery" }], {
      tables: {
        sys_store_app: [],
        sys_plugins: [
          { sys_id: "p1", source: "com.snc.discovery", active: true },
        ],
      },
    }),
  );
  assert.equal(result.status, "pass");
});

test("honours a queryFilter that enforces active=true on sys_plugins", async () => {
  // The fake ignores sysparm_query unless a queryFilter is provided; this
  // mirrors the real filter the check sends, so an inactive plugin is excluded
  // by the query itself and the required app resolves as missing -> fail.
  const http = createFakeSnClient({
    tables: {
      sys_store_app: [],
      sys_plugins: [{ sys_id: "p1", id: "com.snc.discovery", active: "false" }],
    },
    queryFilter(table, rows, params) {
      if (table === "sys_plugins" && params?.sysparm_query === "active=true") {
        return rows.filter((r) => r.active === "true" || r.active === true);
      }
      return rows;
    },
  });
  const result = await scopedAppDeps.run({
    instanceUrl: INSTANCE,
    http,
    options: { requiredApps: [{ id: "com.snc.discovery" }] },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /not installed/);
});

test("maps SnAuthError to fail (never throws)", async () => {
  const http = createFakeSnClient({
    tables: { sys_plugins: [], sys_store_app: [] },
    fail: { auth: true },
  });
  const result = await scopedAppDeps.run({
    instanceUrl: INSTANCE,
    http,
    options: { requiredApps: [{ id: "x_acme_core" }] },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /uthentication/);
});

test("maps SnNetworkError to fail (never throws)", async () => {
  const http = createFakeSnClient({
    tables: { sys_plugins: [], sys_store_app: [] },
    fail: { network: true },
  });
  const result = await scopedAppDeps.run({
    instanceUrl: INSTANCE,
    http,
    options: { requiredApps: [{ id: "x_acme_core" }] },
  });
  assert.equal(result.status, "fail");
});

test("maps an unexpected SnHttpError to warn (dependencies unverified)", async () => {
  const http = createFakeSnClient({
    tables: { sys_plugins: [], sys_store_app: [] },
    fail: { http: 500 },
  });
  const result = await scopedAppDeps.run({
    instanceUrl: INSTANCE,
    http,
    options: { requiredApps: [{ id: "x_acme_core" }] },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /unverified/);
});
