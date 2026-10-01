// QA-18 — injection. `@tessera/sn-client`'s transport (core/http.ts) calls the
// *global* `fetch(url, init)` with `{ method, headers, body, signal }` and reads
// back a standard `Response`; nothing else about it is pluggable. The fake
// therefore exposes a fetch-shaped adapter plus `install()`, and needs no change
// to sn-client at all.
//
// `snRequestLike` below is a faithful miniature of that transport (same URL
// join, same headers, same non-2xx handling, same X-Total-Count read). It is
// duplicated rather than imported so this package keeps zero cross-package
// dependencies beyond @tessera/types.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "../build/index.js";

const HOST = "fake-instance.service-now.com";

/** Miniature of core/http.ts's request loop, minus auth/retry/telemetry. */
async function snRequestLike({ method = "GET", path, params, body }) {
  const qs = params?.toString();
  const url = `https://${HOST}${path}${qs ? `?${qs}` : ""}`;
  const headers = { Accept: "application/json" };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = json?.error?.message ?? json?.error?.detail ?? "(no detail)";
    throw new Error(`ServiceNow API error (${res.status}): ${detail}`);
  }
  const rawTotal = res.headers.get("x-total-count");
  return {
    data: json,
    status: res.status,
    ...(rawTotal && /^\d+$/.test(rawTotal) ? { total: Number(rawTotal) } : {}),
  };
}

let fake;
let restore;
beforeEach(() => {
  fake = createFakeInstance({
    state: { sys_atf_test: [{ sys_id: "aaa1", name: "persistent" }] },
  });
  restore = fake.install();
});
afterEach(() => {
  restore();
});

describe("install", () => {
  it("swaps fetch on an arbitrary host object and restores it", () => {
    const original = () => Promise.resolve(new Response(null));
    const host = { fetch: original };
    const undo = fake.install(host);
    assert.equal(host.fetch, fake.fetch);
    undo();
    assert.equal(host.fetch, original);
  });

  it("swaps the global fetch, which is the transport's only seam", async () => {
    assert.equal(globalThis.fetch, fake.fetch);
    const res = await fetch(`https://${HOST}/api/now/table/sys_atf_test`);
    assert.equal(res.status, 200);
    restore();
    assert.notEqual(globalThis.fetch, fake.fetch);
  });
});

describe("the fetch adapter", () => {
  it("returns a real Response with headers the transport can read", async () => {
    const res = await fetch(`https://${HOST}/api/now/table/sys_atf_test`);
    assert.ok(res instanceof Response);
    assert.equal(res.ok, true);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(res.headers.get("x-total-count"), "1");
    assert.deepEqual((await res.json()).result.length, 1);
  });

  it("lets the transport see a list response with no X-Total-Count", async () => {
    // core/http.ts reports `total` only when the header parses; fetchAll then
    // falls back to its cap heuristic. That path is dead against a fake that
    // always sends the header, so the fake has to be able to withhold it.
    const withCount = await snRequestLike({
      path: "/api/now/table/sys_atf_test",
    });
    assert.equal(withCount.total, 1);

    const res = await fetch(
      `https://${HOST}/api/now/table/sys_atf_test?sysparm_no_count=true`,
    );
    assert.equal(res.headers.get("x-total-count"), null);
    const noCount = await snRequestLike({
      path: "/api/now/table/sys_atf_test",
      params: new URLSearchParams({ sysparm_no_count: "true" }),
    });
    assert.equal("total" in noCount, false);
    assert.equal(noCount.data.result.length, 1);
  });

  it("answers 204 with a genuinely empty body", async () => {
    const res = await fetch(`https://${HOST}/api/now/table/sys_atf_test/aaa1`, {
      method: "DELETE",
    });
    assert.equal(res.status, 204);
    assert.equal(res.body, null);
    assert.equal(await res.text(), "");
  });

  it("accepts a string URL, a URL object, a Request and a bare path", async () => {
    const inputs = [
      `https://${HOST}/api/now/table/sys_atf_test`,
      new URL(`https://${HOST}/api/now/table/sys_atf_test`),
      new Request(`https://${HOST}/api/now/table/sys_atf_test`),
      "/api/now/table/sys_atf_test",
    ];
    for (const input of inputs) {
      assert.equal((await fetch(input)).status, 200, String(input));
    }
  });

  it("decodes a JSON string body and a Uint8Array body alike", async () => {
    const payload = { name: "tessera-RUN1 x" };
    const asText = await fetch(`https://${HOST}/api/now/table/sys_atf_test`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const asBytes = await fetch(`https://${HOST}/api/now/table/sys_atf_test`, {
      method: "POST",
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });
    assert.equal(asText.status, 201);
    assert.equal(asBytes.status, 201);
    assert.equal(fake.tables.count("sys_atf_test"), 3);
  });

  it("merges query parameters from the URL", async () => {
    const res = await fetch(
      `https://${HOST}/api/now/table/sys_atf_test?sysparm_query=name%3Dnope`,
    );
    assert.deepEqual((await res.json()).result, []);
    assert.equal(fake.requests()[0].params.sysparm_query, "name=nope");
  });

  it("rejects an unsupported method the way a transport failure looks", async () => {
    await assert.rejects(
      fetch(`https://${HOST}/api/now/table/sys_atf_test`, { method: "HEAD" }),
      /unsupported method HEAD/,
    );
  });
});

describe("driving the fake through a transport-shaped caller", () => {
  it("round-trips create -> read -> update -> delete against real state", async () => {
    const created = await snRequestLike({
      method: "POST",
      path: "/api/now/table/sys_atf_test",
      body: { name: "tessera-RUN1 ephemeral", active: "true" },
    });
    assert.equal(created.status, 201);
    const sysId = created.data.result.sys_id;

    const read = await snRequestLike({
      path: `/api/now/table/sys_atf_test/${sysId}`,
    });
    assert.equal(read.data.result.name, "tessera-RUN1 ephemeral");

    await snRequestLike({
      method: "PATCH",
      path: `/api/now/table/sys_atf_test/${sysId}`,
      body: { active: "false" },
    });

    const listed = await snRequestLike({
      path: "/api/now/table/sys_atf_test",
      params: new URLSearchParams({ sysparm_query: "active=false" }),
    });
    assert.equal(listed.total, 1);
    assert.equal(listed.data.result[0].sys_id, sysId);

    await snRequestLike({
      method: "DELETE",
      path: `/api/now/table/sys_atf_test/${sysId}`,
    });
    await assert.rejects(
      snRequestLike({ path: `/api/now/table/sys_atf_test/${sysId}` }),
      /ServiceNow API error \(404\): No Record found/,
    );
  });

  it("runs an ATF suite to completion the way api/atf.ts polls", async () => {
    const start = await snRequestLike({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
      params: new URLSearchParams({ sys_id: "aaa1" }),
    });
    const executionId = start.data.result.links.progress.id;

    let payload;
    for (let poll = 0; poll < 10; poll += 1) {
      payload = (
        await snRequestLike({ path: `/api/sn_cicd/progress/${executionId}` })
      ).data.result;
      if (payload.percent_complete === "100") break;
    }
    assert.equal(payload.status_label, "Successful");
  });

  it("surfaces an injected transport failure as a rejected fetch", async () => {
    fake.faults.add({
      match: { method: "POST" },
      mode: { kind: "transport-error", message: "socket hang up" },
    });
    await assert.rejects(
      snRequestLike({
        method: "POST",
        path: "/api/now/table/sys_atf_test",
        body: { name: "x" },
      }),
      /socket hang up/,
    );
  });

  it("surfaces an injected HTTP error as a ServiceNow API error", async () => {
    fake.faults.add({
      match: { method: "GET" },
      mode: { kind: "http-error", status: 403, message: "ACL denied" },
    });
    await assert.rejects(
      snRequestLike({ path: "/api/now/table/sys_atf_test" }),
      /ServiceNow API error \(403\): ACL denied/,
    );
  });

  it("honours the transport's AbortSignal.timeout on a hanging request", async () => {
    fake.faults.add({ match: { method: "GET" }, mode: { kind: "hang" } });
    // AbortSignal.timeout()'s own timer is unref'd, and a request that never
    // settles holds nothing else open, so keep the loop alive meanwhile.
    const keepAlive = setTimeout(() => undefined, 1000);
    try {
      await assert.rejects(
        fetch(`https://${HOST}/api/now/table/sys_atf_test`, {
          signal: AbortSignal.timeout(10),
        }),
        (error) => {
          // core/http.ts maps exactly this name onto its "timed out" branch.
          assert.equal(error.name, "TimeoutError");
          return true;
        },
      );
    } finally {
      clearTimeout(keepAlive);
    }
  });
});
