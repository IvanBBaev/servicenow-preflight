// Three `TABLE_PATH_RE` copies, one contract — and four `NAMESPACE_404` lines.
//
// `@tessera/sn-client` (core/http.ts), the fake's fixture harvester
// (fake-instance/src/fixtures.ts) and the fake's router
// (fake-instance/src/router.ts) each own a copy of the regex that decides
// which paths name a Table/Import API table. The BODIES must agree, or the
// DEV-24 table gate and the DEV-15 write journal would classify a write
// differently from the fake that CI runs them against. The ANCHORS must
// differ, deliberately:
//
//   * http.ts is unanchored — it classifies a path wherever the API prefix
//     sits in it.
//   * fixtures.ts is anchored at the start — a recorded exchange's path is a
//     whole path, not a substring.
//   * router.ts is anchored at both ends — an unmodelled sub-resource under
//     `/api/now/` must fall through to the record-level 404 rather than be
//     routed as a table (the rationale sits above the regex in router.ts).
//
// `@tessera/sn-client` is a leaf and `@tessera/fake-instance` depends only on
// `@tessera/types`, so neither owner can import the other's copy without a new
// edge. This package already sees both — `sn-client` as a dependency, the fake
// as a devDependency — which is why the agreement is pinned here.
//
// Two kinds of evidence, on purpose. The anchoring is read from the SOURCE
// TEXT, because no public surface exposes an anchor as such. The
// classification matrix goes through the PUBLIC SURFACES — `tableTargetFor`,
// `fixtureToSeed`, `handle` — because a regex that agrees in isolation but is
// consumed differently (the router strips an inline `?query` before matching;
// the harvester decodes only the table) would pass a regex-only comparison
// and still disagree in practice.
//
// The WRITE side is pinned too (delegated decision 2026-09-25). Writes are
// gated and journalled through sn-client's anchored `writeTargetFor`, not the
// read-side `tableTargetFor`, so a second matrix drives that classifier
// against real writes through the fake's `handle`: every canonical write path
// must land in the table (and on the record) the client's policy checked, and
// every non-canonical spelling must be refused by the client before any
// request exists.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createFakeInstance,
  fixtureToSeed,
  namespace404Body,
  noRecordFoundBody,
} from "@tessera/fake-instance";
import {
  ServiceNowError,
  tableTargetFor,
  writeTargetFor,
} from "@tessera/sn-client";

// ── source text ─────────────────────────────────────────────────────────────

/** `packages/`, resolved from this file so a moved checkout still finds it. */
const PACKAGES = new URL("../../", import.meta.url);

/**
 * The one `const <name> = /…/<flags>;` line in a package source, split into
 * regex source and flags. Zero or several such lines is a fault in THIS
 * test's premise (the constant moved or was duplicated) and is reported as
 * such, never as a disagreement between copies.
 */
function regexLiteral(rel, name) {
  const text = readFileSync(new URL(rel, PACKAGES), "utf8");
  const lines = text.match(new RegExp(`^const ${name} = .*$`, "gm")) ?? [];
  assert.equal(
    lines.length,
    1,
    `expected exactly one "const ${name} = …;" line in packages/${rel}, found ${lines.length}`,
  );
  const literal = /^const \w+ = \/(.*)\/([a-z]*);$/.exec(lines[0]);
  assert.ok(
    literal,
    `packages/${rel}: "${lines[0]}" is not a one-line regex literal`,
  );
  return { line: lines[0], source: literal[1], flags: literal[2] };
}

/** A regex source split into its `^`/`$` anchors and the body between them. */
function anchored(source) {
  return {
    start: source.startsWith("^"),
    end: source.endsWith("$"),
    body: source.replace(/^\^/, "").replace(/\$$/, ""),
  };
}

/** The three sites and the anchoring each one is documented to carry. */
const TABLE_PATH_SITES = [
  { rel: "sn-client/src/core/http.ts", start: false, end: false },
  { rel: "fake-instance/src/fixtures.ts", start: true, end: false },
  { rel: "fake-instance/src/router.ts", start: true, end: true },
];

const tablePathCopies = () =>
  TABLE_PATH_SITES.map((site) => {
    const literal = regexLiteral(site.rel, "TABLE_PATH_RE");
    return { ...site, flags: literal.flags, found: anchored(literal.source) };
  });

describe("TABLE_PATH_RE — three copies, one body", () => {
  it("has the same body and flags in sn-client, the harvester and the router", () => {
    const [reference, ...others] = tablePathCopies();
    for (const copy of others) {
      assert.equal(
        copy.found.body,
        reference.found.body,
        `TABLE_PATH_RE body in packages/${copy.rel} diverged from packages/${reference.rel}`,
      );
      assert.equal(
        copy.flags,
        reference.flags,
        `TABLE_PATH_RE flags in packages/${copy.rel} diverged from packages/${reference.rel}`,
      );
    }
  });

  it("carries exactly the anchoring each site is documented to carry", () => {
    for (const copy of tablePathCopies()) {
      assert.equal(
        copy.found.start,
        copy.start,
        `packages/${copy.rel}: TABLE_PATH_RE ${copy.start ? "must" : "must not"} start with ^`,
      );
      assert.equal(
        copy.found.end,
        copy.end,
        `packages/${copy.rel}: TABLE_PATH_RE ${copy.end ? "must" : "must not"} end with $`,
      );
    }
  });
});

// ── classification matrix ───────────────────────────────────────────────────

/** The row every table in the matrix is seeded with. */
const SEEDED_ID = "0123456789abcdef0123456789abcdef";

/**
 * `table`/`sysId` are what a classifying site must report — DECODED, because
 * every consumer percent-decodes its segments. `http`/`fixtures`/`router` say
 * which sites classify the path as a table at all; `fallsTo` names the 404
 * branch the router must land in when it does not. The first block is the
 * canonical shapes the three must agree on; the second is each anchor doing
 * the job it was given.
 */
const MATRIX = [
  { path: "/api/now/table/incident", table: "incident" },
  {
    path: `/api/now/table/incident/${SEEDED_ID}`,
    table: "incident",
    sysId: SEEDED_ID,
  },
  { path: "/api/now/import/u_import_set", table: "u_import_set" },
  {
    path: `/api/now/import/u_import_set/${SEEDED_ID}`,
    table: "u_import_set",
    sysId: SEEDED_ID,
  },
  { path: "/api/now/table/x%2Fy/a%2Fb", table: "x/y", sysId: "a/b" },
  { path: "/api/now/table/x%20y/a%20b", table: "x y", sysId: "a b" },
  // `sn-client` sends params separately, so http.ts never sees a `?`; a
  // recorded path and a raw `fetch` URL can carry one, and `[^/?]` in the
  // shared body is what keeps the harvester in step with the router's strip.
  { path: "/api/now/table/incident?sysparm_limit=5", table: "incident" },

  {
    path: "/x/api/now/table/incident",
    table: "incident",
    http: true,
    fixtures: false,
    router: false,
    fallsTo: "namespace",
  },
  {
    path: `/api/now/table/incident/${SEEDED_ID}/extra`,
    table: "incident",
    sysId: SEEDED_ID,
    http: true,
    fixtures: true,
    router: false,
    fallsTo: "record",
  },
  {
    path: "/api/now/table/incident/",
    table: "incident",
    http: true,
    fixtures: true,
    router: false,
    fallsTo: "record",
  },
].map((row) => ({ http: true, fixtures: true, router: true, ...row }));

/**
 * How the router classified `path`, observed through `handle`. The table is
 * seeded with the very record the path could name, so a table route MUST
 * answer 200 with that record (or the collection holding it); a 404 can then
 * only mean the path fell through, and its body says to which branch.
 */
async function routerVerdict(row) {
  const fake = createFakeInstance({
    state: { [row.table]: [{ sys_id: row.sysId ?? SEEDED_ID }] },
  });
  return fake.handle({ method: "GET", path: row.path });
}

/** Which table (decoded) the harvester filed a recorded GET under, if any. */
function harvestedTable(path) {
  const seed = fixtureToSeed({
    version: 1,
    exchanges: [{ path, body: { result: [{ sys_id: SEEDED_ID }] } }],
  });
  const tables = Object.keys(seed.tables);
  assert.ok(
    tables.length <= 1,
    `fixtureToSeed filed ${path} under several tables: ${tables.join(", ")}`,
  );
  return tables[0];
}

describe("TABLE_PATH_RE — the three sites classify paths as documented", () => {
  for (const row of MATRIX) {
    const verdict = [
      row.http ? "http" : "",
      row.fixtures ? "fixtures" : "",
      row.router ? "router" : `not router (${row.fallsTo} 404)`,
    ]
      .filter(Boolean)
      .join(", ");

    it(`${row.path} → ${verdict}`, async () => {
      // sn-client: the exported classifier the table gate and journal share.
      assert.deepEqual(
        tableTargetFor(row.path),
        row.http
          ? { table: row.table, ...(row.sysId ? { sysId: row.sysId } : {}) }
          : undefined,
        `sn-client tableTargetFor(${JSON.stringify(row.path)})`,
      );

      // fixtures: the harvester keeps only the table (group 1), so the sys_id
      // is not observable here and is not asserted.
      assert.equal(
        harvestedTable(row.path),
        row.fixtures ? row.table : undefined,
        `fake-instance fixtureToSeed(${JSON.stringify(row.path)}) table`,
      );

      // router: a GET through the public `handle`, see `routerVerdict`.
      const response = await routerVerdict(row);
      const where = `fake-instance handle(GET ${row.path})`;
      if (!row.router) {
        assert.equal(response.status, 404, `${where} must fall through`);
        assert.deepEqual(
          response.body,
          row.fallsTo === "record"
            ? noRecordFoundBody()
            : namespace404Body(row.path.split("?")[0]),
          `${where} must land in the ${row.fallsTo}-level 404 branch`,
        );
        return;
      }
      assert.equal(response.status, 200, `${where} must be routed as a table`);
      const result = response.body?.result;
      assert.equal(
        Array.isArray(result) ? result[0]?.sys_id : result?.sys_id,
        row.sysId ?? SEEDED_ID,
        `${where} must answer from table ${JSON.stringify(row.table)}`,
      );
    });
  }
});

// ── write classifier ────────────────────────────────────────────────────────

/**
 * Canonical write paths: sn-client's write gate must classify each as
 * `table`/`sysId`, and the fake's router must apply the write to exactly that
 * table and record. Both API families, unversioned and `/v<N>/`, with and
 * without a sys_id and with an inline query.
 */
const CANONICAL_WRITES = ["table", "import"]
  .flatMap((api) =>
    ["", "v1/", "v2/"].flatMap((version) => {
      const table = api === "table" ? "incident" : "u_import_set";
      const base = `/api/now/${version}${api}/${table}`;
      return [
        { path: base, table },
        { path: `${base}/${SEEDED_ID}`, table, sysId: SEEDED_ID },
        { path: `${base}?sysparm_input_display_value=true`, table },
        {
          path: `${base}/${SEEDED_ID}?sysparm_fields=sys_id`,
          table,
          sysId: SEEDED_ID,
        },
      ];
    }),
  )
  .concat([
    { path: "/api/now/table/x%20y", table: "x y" },
    {
      path: `/api/now/v2/table/x%20y/${SEEDED_ID}`,
      table: "x y",
      sysId: SEEDED_ID,
    },
  ]);

/**
 * A single trailing `/`. The fake's router is anchored at both ends on purpose
 * (see the read matrix above) and answers its record-level 404, and whether a
 * real instance routes `/api/now/table/incident/` is not something this repo
 * has evidence for. Delegated decision 2026-09-25: the client REFUSES these
 * writes (403 "Refusing …") instead of classifying them, so the two sides no
 * longer disagree about a write that could leave the process — none can. The
 * fake's 404 is still pinned, so a router change that starts routing them is
 * noticed here rather than silently re-opening the question.
 */
const TRAILING_SLASH_WRITES = [
  { path: "/api/now/table/incident/", table: "incident" },
  { path: "/api/now/v2/table/incident/", table: "incident" },
  {
    path: `/api/now/table/incident/${SEEDED_ID}/`,
    table: "incident",
    sysId: SEEDED_ID,
  },
  { path: "/api/now/import/u_import_set/", table: "u_import_set" },
];

/** Paths the client's write gate must refuse before any request is built. */
const NON_CANONICAL_WRITES = [
  "/api/now/table/./sys_user_has_role",
  "/api/now/table/%2e/sys_user_has_role",
  "/api/now/table/%2E/sys_user_has_role",
  "/api/now/table/incident/../sys_user_has_role",
  "/api/now/table/incident/%2e%2e/sys_user_has_role",
  "/api/now/table/incident/%2E%2E/sys_user_has_role",
  "/api/now/table/incident/.%2e/sys_user_has_role",
  "/api/now/v2/table/incident/../sys_user_has_role",
  "/api/now/table//sys_user_has_role",
  "/api/now//table/sys_user_has_role",
  "//api/now/table/sys_user_has_role",
  "/api/now/table/incident;x=1",
  "/api/now/table/incident/abc;jsessionid=1",
  "/api/now/table/incident\\..\\sys_user_has_role",
  "/api/now/table/incident%5c..%5csys_user_has_role",
  "/api/now/table/incident%2fsys_user_has_role",
  `/api/now/table/incident/${SEEDED_ID}/extra`,
  "/api/now/v2/table/incident/abc/extra",
  "/api/now/import/u_import_set/abc/extra",
  "/x/api/now/table/sys_user_has_role",
  "/API/NOW/TABLE/sys_user_has_role",
  "/api/now/Table/sys_user_has_role",
  "/api/now/t%61ble/sys_user_has_role",
  "/api/now/V2/table/sys_user_has_role",
  "/api/now/vx/table/sys_user_has_role",
  "/api/now/table",
  "/api/now/table/",
];

/** The method a row's write is sent with: a record update or a table insert. */
const writeMethod = (row) => (row.sysId ? "PATCH" : "POST");

/** The client's verdict, as the transport's write gate would reach it. */
function clientWriteTarget(row) {
  return writeTargetFor(writeMethod(row), row.path);
}

/**
 * The fake seeded with the record the path names and a decoy table, so a
 * write routed anywhere but `row.table` (and `row.sysId`) is observable.
 */
function seededFake(row) {
  return createFakeInstance({
    state: {
      [row.table]: [{ sys_id: SEEDED_ID, marker: "seed" }],
      sys_user_has_role: [{ sys_id: SEEDED_ID, marker: "seed" }],
    },
  });
}

/** Every stored row, table by table, for a before/after comparison. */
function snapshot(fake, tables) {
  return Object.fromEntries(
    tables.map((table) => [table, fake.tables.query(table, {}).records]),
  );
}

describe("write classifier — sn-client and the router agree on canonical writes", () => {
  for (const row of CANONICAL_WRITES) {
    const method = writeMethod(row);
    it(`${method} ${row.path} → ${row.table}${row.sysId ? `/${row.sysId}` : ""}`, async () => {
      assert.deepEqual(
        clientWriteTarget(row),
        { table: row.table, ...(row.sysId ? { sysId: row.sysId } : {}) },
        `sn-client writeTargetFor(${method}, ${JSON.stringify(row.path)})`,
      );

      const fake = seededFake(row);
      const response = await fake.handle({
        method,
        path: row.path,
        body: { marker: "written" },
      });
      const where = `fake-instance handle(${method} ${row.path})`;
      assert.equal(
        response.status,
        row.sysId ? 200 : 201,
        `${where} must be routed as a table write`,
      );
      const written = fake.tables
        .query(row.table, {})
        .records.filter((record) => record.marker === "written");
      assert.equal(
        written.length,
        1,
        `${where} must write exactly one row of ${JSON.stringify(row.table)}`,
      );
      if (row.sysId) assert.equal(written[0].sys_id, row.sysId, where);
      assert.deepEqual(
        fake.tables
          .query("sys_user_has_role", {})
          .records.map((record) => record.marker),
        ["seed"],
        `${where} must not touch any other table`,
      );
    });
  }

  for (const row of TRAILING_SLASH_WRITES) {
    const method = writeMethod(row);
    it(`${method} ${row.path} → client refuses, router 404s (fail closed)`, async () => {
      assert.throws(
        () => clientWriteTarget(row),
        (error) => {
          assert.ok(error instanceof ServiceNowError, String(error));
          assert.equal(error.status, 403);
          assert.match(error.message, /^Refusing .*trailing '\/'/);
          return true;
        },
        `sn-client writeTargetFor(${method}, ${JSON.stringify(row.path)})`,
      );

      const fake = seededFake(row);
      const tables = [row.table, "sys_user_has_role"];
      const before = snapshot(fake, tables);
      const response = await fake.handle({
        method,
        path: row.path,
        body: { marker: "written" },
      });
      const where = `fake-instance handle(${method} ${row.path})`;
      assert.equal(response.status, 404, `${where} must fall through`);
      assert.deepEqual(response.body, noRecordFoundBody(), where);
      assert.deepEqual(
        snapshot(fake, tables),
        before,
        `${where} mutated state`,
      );
    });
  }
});

describe("write classifier — sn-client refuses non-canonical write paths", () => {
  for (const path of NON_CANONICAL_WRITES) {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      it(`refuses ${method} ${path}`, () => {
        assert.throws(
          () => writeTargetFor(method, path),
          (error) => {
            assert.ok(error instanceof ServiceNowError, String(error));
            assert.equal(error.status, 403);
            assert.match(error.message, /^Refusing /);
            return true;
          },
          `sn-client writeTargetFor(${method}, ${JSON.stringify(path)}) must throw`,
        );
      });
    }
  }
});

// ── NAMESPACE_404 ───────────────────────────────────────────────────────────

/**
 * Four packages each carry the line that recognises a namespace 404 (no such
 * REST API) by its wording. Where that discriminator should LIVE is an open
 * question this test does not answer; it pins only that the four copies have
 * not drifted apart, which is the precondition for moving them at all.
 */
const NAMESPACE_404_SITES = [
  "doctor/src/probe.ts",
  "parity/src/reader.ts",
  "resolvers/src/read.ts",
  "sn-client/src/api/plugin.ts",
];

describe("NAMESPACE_404 — four copies, one line", () => {
  it("is byte-identical in doctor, parity, resolvers and sn-client", () => {
    const [reference, ...others] = NAMESPACE_404_SITES.map((rel) => ({
      rel,
      ...regexLiteral(rel, "NAMESPACE_404"),
    }));
    for (const copy of others) {
      assert.equal(
        copy.line,
        reference.line,
        `NAMESPACE_404 line in packages/${copy.rel} diverged from packages/${reference.rel}`,
      );
    }
  });
});
