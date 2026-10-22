// DESIGN §10 — classification before egress, fail-closed.
//
// The propositions, each held to account below:
//
// 1. UNKNOWN IS DENIED. A table no allow rule names refuses the generation; a
//    field class the policy does not allow is redacted; a field-class string
//    the package does not know is a malformed policy, not an ignored entry.
// 2. DENY WINS. A table or field class on both lists is treated as denied.
// 3. NOTHING IS SILENTLY SKIPPED. A withheld artifact refuses the whole
//    generation with a typed `EgressRefusedError`; the provider is never asked.
// 4. THE TRANSPORT IS THE BACKSTOP. The Anthropic adapter refuses any prompt
//    that did not come out of `clearForEgress` — before it builds a request —
//    so forgetting the policy sends nothing rather than everything.
// 5. THE TEMPLATE PROVIDER IS UNTOUCHED. No egress, no policy needed.
// 6. NO LEAK. A planted marker is absent from the outbound request while its
//    placeholder is present (§10.3 canary), and no refusal message, stack or
//    inspection carries the API key, the marker or instance prose.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import {
  DEFAULT_EGRESS_POLICY,
  DEFAULT_EGRESS_TABLES,
  EGRESS_FIELD_CLASSES,
  EgressRefusedError,
  GenerateInputError,
  assertEgressCleared,
  buildGenerationPrompt,
  clearForEgress,
  createAiTestGenerator,
  createAnthropicProvider,
  createTemplateProvider,
  isEgressCleared,
  renderPrompt,
  validateEgressPolicy,
} from "../build/index.js";

import {
  demand,
  edge,
  graphWith,
  makeCtx,
  manualClock,
  stubGate,
  stubProvider,
  stubQuality,
  stubWriter,
  sysId,
  target,
} from "./support.js";

/** Stands in for the API key; must reach exactly one header and nothing else. */
const KEY_MARKER = "egress-key-marker-91d4-never-log-this";
/** Planted in instance prose in a credential position; must never reach the wire. */
const PLANTED = "planted-marker-4be1-egress";
/** Instance prose that is not a credential, but is still not ours to send. */
const NAME_CANARY = "name-canary-c3a8-instance-prose";

const CONSENTING = Object.freeze({
  consent: true,
  allow: { tables: DEFAULT_EGRESS_TABLES, fields: EGRESS_FIELD_CLASSES },
});

function policy(overrides = {}) {
  return { ...CONSENTING, ...overrides };
}

function liveSignal() {
  return new AbortController().signal;
}

function stubFetch() {
  const calls = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              id: "msg_egress",
              type: "message",
              role: "assistant",
              model: "m",
              stop_reason: "end_turn",
              content: [{ type: "text", text: '{"specs":[]}' }],
            }),
          ),
      });
    },
  };
}

function anthropic(stub) {
  return createAnthropicProvider({ fetch: stub.fetch, apiKey: KEY_MARKER });
}

function assertNoLeak(error) {
  for (const text of [error.message, error.stack, inspect(error)]) {
    for (const marker of [KEY_MARKER, PLANTED, NAME_CANARY]) {
      assert.ok(!String(text).includes(marker), `a refusal leaked ${marker}`);
    }
  }
}

/** Refused with the typed egress error; and the refusal itself leaks nothing. */
function assertRefused(fn, expected) {
  assert.throws(fn, (error) => {
    assert.ok(
      error instanceof EgressRefusedError,
      `expected EgressRefusedError, got ${error?.name}`,
    );
    assert.ok(error instanceof GenerateInputError);
    assert.equal(error.name, "EgressRefusedError");
    if (expected !== undefined) assert.match(error.message, expected);
    assertNoLeak(error);
    return true;
  });
}

describe("egress policy — validation", () => {
  it("refuses an unknown field-class string instead of ignoring it", () => {
    // A typo in `deny` that was skipped would send exactly the class the
    // operator meant to withhold.
    assert.throws(
      () => validateEgressPolicy(policy({ deny: { fields: ["nmae"] } })),
      (error) => {
        assert.ok(error instanceof GenerateInputError);
        assert.match(error.message, /deny\.fields is not a known field class/);
        assert.ok(!error.message.includes("nmae"), "the entry was quoted");
        return true;
      },
    );
  });

  it("refuses a malformed table entry without quoting it", () => {
    assert.throws(
      () =>
        validateEgressPolicy(
          policy({ allow: { tables: [`x ${PLANTED}`], fields: [] } }),
        ),
      (error) => {
        assert.ok(error instanceof GenerateInputError);
        assert.ok(!error.message.includes(PLANTED));
        return true;
      },
    );
  });

  it("refuses a missing or non-object allow section", () => {
    assert.throws(
      () => validateEgressPolicy({ consent: true }),
      GenerateInputError,
    );
    assert.throws(() => validateEgressPolicy(undefined), GenerateInputError);
  });

  it("ships fail-closed defaults: no consent, §2 code tables, no instance prose", () => {
    assert.equal(DEFAULT_EGRESS_POLICY.consent, false);
    assert.deepEqual([...DEFAULT_EGRESS_POLICY.allow.fields].sort(), [
      "plan",
      "relation",
    ]);
    assert.ok(DEFAULT_EGRESS_TABLES.includes("sys_script_include"));
    assert.ok(!DEFAULT_EGRESS_TABLES.includes("incident"));
    assert.ok(!DEFAULT_EGRESS_TABLES.includes("sys_user"));
  });
});

describe("clearForEgress — tables", () => {
  it("refuses without consent, whatever else the policy allows", () => {
    const graph = graphWith([target("a")]);
    assertRefused(
      () => clearForEgress("unit", graph, policy({ consent: false })),
      /consent/,
    );
    assertRefused(
      () => clearForEgress("unit", graph, DEFAULT_EGRESS_POLICY),
      /consent/,
    );
  });

  it("refuses an artifact on a table no allow rule names (unknown ⇒ deny)", () => {
    const graph = graphWith([
      target("a"),
      target("b", { table: "incident", name: NAME_CANARY }),
    ]);
    assertRefused(
      () => clearForEgress("unit", graph, policy()),
      /withholds 1 of 2 artifacts .*1 on a table no allow rule names/,
    );
    // The identity travels as structured data, never in the message.
    let caught;
    try {
      clearForEgress("unit", graph, policy());
    } catch (error) {
      caught = error;
    }
    assert.deepEqual(caught.withheld, [
      { table: "incident", sysId: sysId("b"), rule: "unmatched" },
    ]);
  });

  it("refuses an artifact on a denied table, and deny wins over allow", () => {
    const graph = graphWith([target("a", { table: "sys_script_include" })]);
    assertRefused(
      () =>
        clearForEgress(
          "unit",
          graph,
          policy({ deny: { tables: ["SYS_SCRIPT_INCLUDE"] } }),
        ),
      /1 on a denied table/,
    );
  });

  it("classifies every artifact the graph names — edges, QA-9 entries, demands", () => {
    const hidden = target("h", { table: "sys_user" });
    for (const graph of [
      graphWith([target("a")], { edges: [edge(target("a"), hidden)] }),
      graphWith([target("a")], {
        unanalyzable: [{ artifact: hidden, reason: "r" }],
      }),
      graphWith([target("a")], { demanded: [demand(hidden)] }),
    ]) {
      assertRefused(() => clearForEgress("unit", graph, policy()), /1 of 2/);
    }
  });

  it("refuses an identity that is not a table name and a 32-hex sys_id", () => {
    assertRefused(
      () =>
        clearForEgress(
          "unit",
          graphWith([target("a", { sysId: PLANTED })]),
          policy(),
        ),
      /1 without a table\/sys_id identity/,
    );
  });
});

describe("clearForEgress — field classes and patterns", () => {
  it("redacts a field class the policy does not allow, with a stable placeholder", () => {
    const a = target("a", { name: NAME_CANARY });
    const graph = graphWith([a], { edges: [edge(a, a)] });
    const { prompt, report } = clearForEgress(
      "unit",
      graph,
      policy({ allow: { tables: ["sys_script"], fields: ["relation"] } }),
    );
    assert.ok(!prompt.data.includes(NAME_CANARY));
    assert.ok(prompt.data.includes("«REDACTED:name:1»"));
    assert.ok(
      !prompt.data.includes("«REDACTED:name:2»"),
      "the placeholder is not stable per value",
    );
    assert.ok(
      prompt.data.includes("where_used"),
      "an allowed class was dropped",
    );
    assert.equal(report.artifacts, 1);
    assert.equal(report.redactions.name, 3);
    assert.ok(!inspect(report).includes(NAME_CANARY));
  });

  it("redacts a class that is both allowed and denied (deny wins)", () => {
    const { prompt } = clearForEgress(
      "unit",
      graphWith([target("a", { name: NAME_CANARY })]),
      policy({ deny: { fields: ["name"] } }),
    );
    assert.ok(!prompt.data.includes(NAME_CANARY));
  });

  it("never sends the instance's reason prose under the default field classes", () => {
    const a = target("a");
    const { prompt } = clearForEgress(
      "unit",
      graphWith([a], {
        unanalyzable: [{ artifact: a, reason: `usage of ${NAME_CANARY}` }],
      }),
      { ...DEFAULT_EGRESS_POLICY, consent: true },
    );
    assert.ok(!prompt.data.includes(NAME_CANARY));
    assert.ok(prompt.data.includes("«REDACTED:reason:1»"));
  });

  it("scrubs credentials, tokens, keys and emails out of allowed text", () => {
    const cases = [
      [`password=${PLANTED}`, "credential"],
      [`api_key: "${PLANTED}"`, "credential"],
      [`Bearer ${PLANTED}`, "token"],
      [`eyJhbGciOi.eyJzdWIiOi.${PLANTED}`, "token"],
      [
        `-----BEGIN RSA PRIVATE KEY-----\n${PLANTED}\n-----END RSA PRIVATE KEY-----`,
        "private-key",
      ],
      [`${PLANTED}@example.com`, "email"],
    ];
    for (const [name, category] of cases) {
      const { prompt, report } = clearForEgress(
        "unit",
        graphWith([target("a", { name: `Rule ${name}` })]),
        policy(),
      );
      assert.ok(!prompt.data.includes(PLANTED), `${category} leaked`);
      assert.ok(prompt.data.includes(`«REDACTED:${category}:1»`), category);
      assert.ok(report.redactions[category] >= 1);
    }
  });

  it("marks only its own frozen output as cleared", () => {
    const graph = graphWith([target("a")]);
    const { prompt } = clearForEgress("unit", graph, policy());
    assert.ok(isEgressCleared(prompt));
    assert.ok(Object.isFrozen(prompt));
    assert.equal(isEgressCleared({ ...prompt }), false, "a copy passed");
    assert.equal(
      isEgressCleared(renderPrompt(buildGenerationPrompt("unit", graph))),
      false,
      "an unclassified prompt passed",
    );
    assert.equal(isEgressCleared(undefined), false);
    assertRefused(() => assertEgressCleared({ ...prompt }, "anthropic"));
  });
});

describe("the Anthropic adapter — transport backstop", () => {
  it("refuses an uncleared prompt before any request is built", async () => {
    const stub = stubFetch();
    const graph = graphWith([target("a", { name: `password=${PLANTED}` })]);
    const uncleared = renderPrompt(buildGenerationPrompt("unit", graph));
    await assert.rejects(
      anthropic(stub).complete(
        { prompt: uncleared, kind: "unit", targets: graph.nodes },
        liveSignal(),
      ),
      (error) => {
        assert.ok(error instanceof EgressRefusedError);
        assert.match(error.message, /did not pass egress classification/);
        assertNoLeak(error);
        return true;
      },
    );
    assert.equal(stub.calls.length, 0, "a request left the machine");
  });

  it("sends a cleared prompt — and the planted marker is nowhere on the wire (§10.3 canary)", async () => {
    const stub = stubFetch();
    const a = target("a", { name: `Rule token=${PLANTED} ${NAME_CANARY}` });
    const graph = graphWith([a], {
      unanalyzable: [{ artifact: a, reason: NAME_CANARY }],
    });
    const { prompt } = clearForEgress("unit", graph, {
      ...DEFAULT_EGRESS_POLICY,
      consent: true,
    });
    await anthropic(stub).complete(
      { prompt, kind: "unit", targets: graph.nodes },
      liveSignal(),
    );
    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    const wire = `${call.url}\n${JSON.stringify(call.init.headers)}\n${call.init.body}`;
    assert.ok(!wire.includes(PLANTED), "the planted marker was sent");
    assert.ok(!wire.includes(NAME_CANARY), "instance prose was sent");
    assert.ok(wire.includes("«REDACTED:name:1»"));
    assert.ok(wire.includes("«REDACTED:reason:1»"));
    assert.ok(wire.includes(sysId("a")), "the identity must still be sent");
  });
});

describe("the generator — egress option", () => {
  function generator(provider, egress) {
    return createAiTestGenerator({
      provider,
      gate: stubGate(),
      quality: stubQuality(),
      writer: stubWriter(),
      testsRoot: "/repo/tests",
      now: manualClock().now,
      ...(egress === undefined ? {} : { egress }),
    });
  }

  it("validates the policy at construction", () => {
    assert.throws(
      () => generator(stubProvider(), policy({ allow: { fields: ["bogus"] } })),
      GenerateInputError,
    );
  });

  it("refuses a withheld graph without ever asking the provider", async () => {
    const provider = stubProvider();
    await assert.rejects(
      generator(provider, policy()).generate(
        makeCtx(),
        graphWith([target("a", { table: "incident" })]),
        "unit",
      ),
      EgressRefusedError,
    );
    assert.equal(provider.calls.length, 0);
  });

  it("hands the provider the cleared prompt", async () => {
    const provider = stubProvider();
    await generator(provider, {
      ...DEFAULT_EGRESS_POLICY,
      consent: true,
    }).generate(
      makeCtx(),
      graphWith([target("a", { name: NAME_CANARY })]),
      "unit",
    );
    assert.equal(provider.calls.length, 1);
    const sent = provider.calls[0].request.prompt;
    assert.ok(isEgressCleared(sent));
    assert.ok(!sent.data.includes(NAME_CANARY));
  });

  it("leaves the template provider — no egress — working without a policy", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("the template provider opened a socket");
    };
    try {
      const specs = await generator(createTemplateProvider()).generate(
        makeCtx(),
        graphWith([target("a")]),
        "unit",
      );
      assert.ok(specs.length >= 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses the anthropic provider when the generator was given no policy", async () => {
    const stub = stubFetch();
    await assert.rejects(
      generator(anthropic(stub)).generate(
        makeCtx(),
        graphWith([target("a")]),
        "unit",
      ),
      (error) => {
        assert.equal(error.name, "EgressRefusedError");
        assertNoLeak(error);
        return true;
      },
    );
    assert.equal(stub.calls.length, 0);
  });
});
