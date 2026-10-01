// The hardcoded Phase-0.5 Resolver.
//
// THE PROPERTIES UNDER TEST, in the module's own words:
//  * "a Resolver reads, never writes, and hands the pipeline `AffectedArtifact`s
//    carrying a real instance sys_id";
//  * "`resolvedBy` is pinned to `\"scope\"` ... Reporting `\"story\"` here would
//    be a lie the verdict later repeats";
//  * "Refusing loudly keeps a Phase-1 caller from believing resolution
//    happened."
//
// Each of those is a claim the CALLER cannot check: it receives an artifact
// list and a provenance label and has no second source for either. So the tests
// below check what the caller cannot — that a refused read never arrives
// wearing the words of a proven absence, and that a capped read never states a
// total it did not ask for.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { SCRIPT_INCLUDE_TABLE } from "../build/atf.js";
import { SkeletonInfrastructureError } from "../build/errors.js";
import { S5_TARGET_NAME } from "../build/fixtures.js";
import { createS5Resolver } from "../build/resolver.js";
import { context, harness } from "./support.js";

const opened = [];
after(() => {
  for (const h of opened) h.restore();
});

function open(options) {
  const h = harness(options);
  opened.push(h);
  return h;
}

/** Seed state holding `count` Script Includes that all share one name. */
function copies(count, name = S5_TARGET_NAME) {
  return {
    [SCRIPT_INCLUDE_TABLE]: Array.from({ length: count }, (_unused, i) => ({
      name,
      api_name: `global.${name}`,
      sys_scope: i === 0 ? "global" : `scope_${i}`,
      active: "true",
      script: "var X = Class.create();",
    })),
  };
}

describe("createS5Resolver", () => {
  it("returns exactly one artifact carrying the instance's own sys_id", async () => {
    const h = open();
    try {
      const artifacts = await createS5Resolver().resolve(context(), {});
      assert.equal(artifacts.length, 1);
      const [artifact] = artifacts;
      assert.equal(artifact.ref.table, SCRIPT_INCLUDE_TABLE);
      assert.equal(artifact.ref.name, S5_TARGET_NAME);

      // The sys_id must be the row's, not a fabricated or blank placeholder:
      // downstream projection writes against it, and a wrong one tests the
      // wrong artifact while looking exactly like a right one.
      const [row] = h.fake.tables.all(SCRIPT_INCLUDE_TABLE);
      assert.equal(artifact.ref.sysId, row["sys_id"]);
      assert.notEqual(artifact.ref.sysId, "");
    } finally {
      h.restore();
    }
  });

  it("labels provenance 'scope', which is what it actually did", async () => {
    const h = open();
    try {
      const [artifact] = await createS5Resolver().resolve(context(), {});
      assert.equal(artifact.resolvedBy, "scope");
    } finally {
      h.restore();
    }
  });

  it("reads and never writes", async () => {
    const h = open();
    try {
      await createS5Resolver().resolve(context(), {});
      const methods = h.fake.requests().map((request) => request.method);
      assert.ok(methods.length > 0, "the resolver must actually read");
      assert.deepEqual(
        methods.filter((method) => method !== "GET"),
        [],
        "a Resolver issues no mutating request",
      );
    } finally {
      h.restore();
    }
  });

  it("refuses a story instead of quietly resolving something else", async () => {
    const h = open();
    try {
      await assert.rejects(
        () => createS5Resolver().resolve(context(), { story: "STRY0042" }),
        (error) => {
          assert.ok(error instanceof SkeletonInfrastructureError);
          assert.match(error.message, /hardcoded to one Script Include/);
          return true;
        },
      );
      // Loud, and BEFORE the read: a caller that named a story must not receive
      // the hardcoded artifact under the impression its story was honoured.
      assert.deepEqual(h.fake.requests(), []);
    } finally {
      h.restore();
    }
  });

  it("refuses an update set the same way", async () => {
    const h = open();
    try {
      await assert.rejects(
        () => createS5Resolver().resolve(context(), { updateSet: "SYS0001" }),
        SkeletonInfrastructureError,
      );
      assert.deepEqual(h.fake.requests(), []);
    } finally {
      h.restore();
    }
  });

  it("reports an absent target as absent", async () => {
    const h = open({ state: { [SCRIPT_INCLUDE_TABLE]: [] } });
    try {
      await assert.rejects(
        () => createS5Resolver().resolve(context(), {}),
        (error) => {
          assert.match(error.message, /does not exist on the source instance/);
          return true;
        },
      );
    } finally {
      h.restore();
    }
  });

  it("a refused read is NEVER reported as a proven absence", async () => {
    // The campaign's defect class, exactly: the target IS there, and a resolver
    // that caught the 403 and fell through to `records[0] === undefined` would
    // tell the caller the artifact "does not exist on the source instance" —
    // a confident diagnosis of an instance it could not read.
    const h = open();
    h.fake.faults.add({
      match: { method: "GET", table: SCRIPT_INCLUDE_TABLE },
      mode: { kind: "http-error", status: 403, message: "no read access" },
    });
    try {
      await assert.rejects(
        () => createS5Resolver().resolve(context(), {}),
        (error) => {
          assert.doesNotMatch(
            error.message,
            /does not exist/,
            "a read that was refused must not be reported as a proven absence",
          );
          return true;
        },
      );
    } finally {
      h.restore();
    }
  });

  it("a transport failure is not reported as an absence either", async () => {
    const h = open();
    h.fake.faults.add({
      match: { method: "GET", table: SCRIPT_INCLUDE_TABLE },
      mode: { kind: "transport-error", message: "socket hang up" },
    });
    try {
      await assert.rejects(
        () => createS5Resolver().resolve(context(), {}),
        (error) => {
          assert.doesNotMatch(error.message, /does not exist/);
          assert.doesNotMatch(error.message, /ambiguous/);
          return true;
        },
      );
    } finally {
      h.restore();
    }
  });

  it("refuses two same-named Script Includes rather than picking one", async () => {
    const h = open({ state: copies(2) });
    try {
      await assert.rejects(
        () => createS5Resolver().resolve(context(), {}),
        (error) => {
          assert.ok(error instanceof SkeletonInfrastructureError);
          assert.match(error.message, /is ambiguous/);
          return true;
        },
      );
    } finally {
      h.restore();
    }
  });

  it("does not state a match total the capped read never asked for", async () => {
    // Five rows exist; the query asks for two. Any exact count in the message
    // is therefore a number the resolver cannot know — a truncated read
    // reported as a complete one. It must say "more than one", not "2".
    const h = open({ state: copies(5) });
    try {
      await assert.rejects(
        () => createS5Resolver().resolve(context(), {}),
        (error) => {
          assert.match(error.message, /more than one match/);
          assert.doesNotMatch(
            error.message,
            /\b2 matches\b/,
            "the read saw 2 rows of 5 and must not report 2 as the total",
          );
          assert.match(error.message, /capped at 2/);
          return true;
        },
      );
    } finally {
      h.restore();
    }
  });

  it("refuses a target name that could inject encoded-query syntax", async () => {
    // `X^ORname=TesseraS5Target` would resolve the S5 target under a different
    // requested name; refused before any request instead.
    for (const targetName of [
      `NoSuchThing^ORname=${S5_TARGET_NAME}`,
      `${S5_TARGET_NAME}^NQname=Other`,
      "a=b",
      "a@b",
      "has space",
      "",
    ]) {
      const h = open();
      try {
        await assert.rejects(
          () => createS5Resolver({ targetName }).resolve(context(), {}),
          (error) => {
            assert.ok(error instanceof SkeletonInfrastructureError);
            assert.match(error.message, /not safe to splice/);
            return true;
          },
          `target name ${JSON.stringify(targetName)} must be refused`,
        );
        assert.deepEqual(h.fake.requests(), [], "no request may be sent");
      } finally {
        h.restore();
      }
    }
  });

  it("refuses a returned row whose name is not exactly the requested one", async () => {
    // ServiceNow's `=` is case-insensitive; the fake's is exact. Rewrite the
    // response so the instance hands back a differently-cased name.
    const h = open();
    const installed = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await installed(input, init);
      if (!String(input).includes(SCRIPT_INCLUDE_TABLE)) return response;
      const body = await response.json();
      for (const row of body.result ?? [])
        row.name = String(row.name).toLowerCase();
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: response.headers,
      });
    };
    try {
      await assert.rejects(
        () => createS5Resolver().resolve(context(), {}),
        (error) => {
          assert.ok(error instanceof SkeletonInfrastructureError);
          assert.match(error.message, /does not match exactly/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = installed;
      h.restore();
    }
  });

  it("honours an overridden target name", async () => {
    const h = open({ state: copies(1, "OtherThing") });
    try {
      const [artifact] = await createS5Resolver({
        targetName: "OtherThing",
      }).resolve(context(), {});
      assert.equal(artifact.ref.name, "OtherThing");
    } finally {
      h.restore();
    }
  });
});
