// The `LLMProvider` seam — the only place in @tessera/generate that knows a
// model exists, and therefore the only place a network call, an API key or a
// vendor response shape can enter the package.
//
// Four propositions are worth a suite of their own, and each of them is a claim
// the rest of the package silently depends on.
//
// 1. THE OFFLINE PROVIDER IS A REAL PROVIDER. `createTemplateProvider` is what
//    makes the QA-12(a) gate hermetic. If it were merely "a provider that does
//    not crash" the substitution would be a fiction: the tests below therefore
//    push its completion through `parseCandidates`, the same function the real
//    provider's output goes through, and require candidates out the other end.
//
// 2. THE FETCH IS INJECTED AND IS NEVER THE GLOBAL. Every Anthropic test here
//    drives a stub and asserts on what went ON THE WIRE — the URL, the version
//    header, the model id, the two prompt channels. A suite that only asserted
//    on the return value would pass against a provider that posted the API key
//    to the wrong host.
//
// 3. THE KEY NEVER LEAVES THE HEADER. A recognisable marker is planted as the
//    API key and every failure path is checked for it — message, stack, and the
//    serialised provider object. A key in a stack trace is a key in a CI log,
//    and CI logs are readable by more people than the secret store is.
//
// 4. A FAULT IS NEVER AN EMPTY COMPLETION. `./errors.ts` writes out why: an
//    empty spec list is a CLAIM that nothing here is worth testing. So every
//    transport and protocol fault below asserts a REJECTION, never a resolved
//    completion with nothing in it.
//
// Nothing in this file opens a socket. `globalThis.fetch` is replaced with a
// thrower for the template-provider tests specifically so that "no network" is
// a checked fact rather than an unexercised intention.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import {
  TEST_KINDS,
  isUntrusted,
  untrusted,
  unwrapUntrusted,
} from "@tessera/types";

import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL_ID,
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_VERSION_HEADER,
  MODELS_WITHOUT_SAMPLING_PARAMS,
  SUFFIX_BY_KIND,
  createAnthropicProvider,
  createTemplateProvider,
  modelAcceptsSamplingParams,
  parseCandidates,
} from "../build/index.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A marker that nothing else in this process could plausibly emit. The point of
 * the leak assertions is not "the message looks tidy" but "this exact sequence
 * of characters reached exactly one header and nowhere else".
 */
const FAKE_API_KEY = "sk-ant-fake-canary-2f9c-never-log-this";

/** Its opposite number: planted in a response body a fault message may not echo. */
const BODY_CANARY = "body-canary-8b31-must-not-be-quoted-back";

/** A model id deliberately outside `MODELS_WITHOUT_SAMPLING_PARAMS`. */
const SAMPLING_MODEL_ID = "legacy-generation-model-1";

const UNWRAP = "provider test — reading the completion to assert on it";

/**
 * A `RenderedPrompt`. The two channels are given distinctive, non-overlapping
 * content so a test can prove they arrived separately (TM-2) rather than
 * re-joined into one string somewhere on the way out.
 */
function prompt(overrides = {}) {
  return {
    instruction:
      "INSTRUCTION-CHANNEL: emit a JSON object with a `specs` array.",
    data: "DATA-CHANNEL:\n<<<TESSERA-DATA>>>\ntable: incident\n<<<TESSERA-DATA>>>",
    blocks: 1,
    promptHash: "a".repeat(64),
    instructionHash: "b".repeat(64),
    promptVersion: "generate/1",
    ...overrides,
  };
}

/** A recognisable instance-derived name, for the TM-1 assertion further down. */
const TARGET_NAME = "Incident: name-canary-5c07-instance-prose";

function target(overrides = {}) {
  return {
    table: "incident",
    sysId: "0123456789abcdef0123456789abcdef",
    name: TARGET_NAME,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    prompt: prompt(),
    kind: "unit",
    targets: [target()],
    ...overrides,
  };
}

/** A signal that never aborts, for the paths where cancellation is not the subject. */
function liveSignal() {
  return new AbortController().signal;
}

/** The pinned config the wire assertions read back out of the request body. */
function pinned(overrides = {}) {
  return {
    modelId: ANTHROPIC_DEFAULT_MODEL_ID,
    temperature: 0.25,
    maxTokens: 4096,
    promptHash: "c".repeat(64),
    promptVersion: "generate/1",
    ...overrides,
  };
}

/** A well-formed Messages response, with one text block carrying `payload`. */
function messagesResponse(payload, overrides = {}) {
  return {
    id: "msg_01test",
    type: "message",
    role: "assistant",
    model: ANTHROPIC_DEFAULT_MODEL_ID,
    stop_reason: "end_turn",
    content: [{ type: "text", text: payload }],
    ...overrides,
  };
}

/** The JSON a compliant model would return: one unit spec. */
const SPECS_PAYLOAD = JSON.stringify({
  specs: [
    {
      id: "incident.unit.1",
      kind: "unit",
      filename: "incident.unit.ts",
      targets: [target()],
      source: "export function run(step) {\n  assertTrue('ok', true);\n}\n",
    },
  ],
});

function respond(status, body) {
  return {
    ok: status >= 200 && status <= 299,
    status,
    text: () =>
      Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/**
 * The injected transport. Records every call so a test can assert on the wire
 * rather than on the return value, and returns whatever the handler says —
 * including a rejection, which is how transport failure is expressed.
 */
function stubFetch(handler) {
  const calls = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(handler(url, init, calls.length - 1));
    },
    /** The parsed request body of the nth call. */
    bodyOf(index) {
      const call = calls[index];
      assert.ok(call, `no request at index ${index}`);
      return JSON.parse(call.init.body);
    },
    headersOf(index) {
      const call = calls[index];
      assert.ok(call, `no request at index ${index}`);
      return call.init.headers;
    },
  };
}

/** An Anthropic provider over a stub that always answers `body` with `status`. */
function providerAnswering(body, options = {}) {
  const status = options.status ?? 200;
  const stub = stubFetch(() => respond(status, body));
  const provider = createAnthropicProvider({
    fetch: stub.fetch,
    apiKey: FAKE_API_KEY,
    config: options.config ?? pinned(),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  return { provider, stub };
}

/** Assert the planted key is absent from anything that can reach a log. */
function assertNoKeyIn(value, label) {
  assert.ok(
    !String(value).includes(FAKE_API_KEY),
    `${label} leaked the API key`,
  );
}

/**
 * Assert a rejection is the DEV-1 fault marker, say so by name rather than by
 * shape, and check the same rejection for a secret leak while we have it — every
 * error message asserted below is also a string that travels to CI.
 */
async function assertFault(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.equal(
      error.name,
      "GenerationFaultError",
      `expected a generation fault, got ${error.name}: ${error.message}`,
    );
    if (expected !== undefined) assert.match(error.message, expected);
    assertNoKeyIn(error.message, "the fault message");
    assertNoKeyIn(error.stack, "the fault stack");
    return true;
  });
}

// There is no `assertInputError` counterpart to the above, and its absence is
// the point: `createAnthropicProvider` validates its config in the constructor
// and throws SYNCHRONOUSLY, so every `GenerateInputError` below is asserted with
// `assert.throws`. A promise-shaped helper would only ever have been reached by
// a code path where a config mistake had been deferred into a request.

// ── the offline provider ────────────────────────────────────────────────────

describe("createTemplateProvider — the hermetic half of the seam", () => {
  it("resolves without touching the global fetch", async () => {
    // Not a stylistic point. The package's claim is that CI needs no vendor and
    // no key; the only way to state that as a fact is to make the global hostile
    // and watch the provider not notice.
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("the template provider reached for the network");
    };
    try {
      const completion = await createTemplateProvider().complete(
        request(),
        liveSignal(),
      );
      assert.ok(unwrapUntrusted(completion.text, UNWRAP).length > 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("returns the same bytes for the same request, twice", async () => {
    // Determinism is what lets a re-run produce an empty diff under `proposed/`.
    // A provider with a clock or a counter in it would make every regeneration
    // look like a change and teach reviewers to skim.
    const provider = createTemplateProvider();
    const first = await provider.complete(request(), liveSignal());
    const second = await provider.complete(request(), liveSignal());
    assert.equal(
      unwrapUntrusted(first.text, UNWRAP),
      unwrapUntrusted(second.text, UNWRAP),
    );
    assert.equal(first.modelId, second.modelId);
    assert.equal(first.stopReason, second.stopReason);
  });

  it("brands its completion like any other provider", () => {
    // The template author is trusted; the SEAM is not the place to make an
    // exception, because an exception here is a second code path through the
    // gate — and the gate is the thing that has to be single-pathed.
    return createTemplateProvider()
      .complete(request(), liveSignal())
      .then((completion) => {
        assert.notEqual(typeof completion.text, "string");
        assert.ok(isUntrusted(completion.text));
        assert.equal(completion.stopReason, "end_turn");
      });
  });

  it("produces output `parseCandidates` accepts, for every TestKind", async () => {
    // The substitution claim in one assertion: the offline provider's output
    // travels the same parse path the model's does. A template that only "looked
    // like" a completion would make the hermetic suite prove nothing.
    for (const kind of TEST_KINDS) {
      const provider = createTemplateProvider();
      const completion = await provider.complete(
        request({ kind }),
        liveSignal(),
      );
      const candidates = parseCandidates(completion);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].kind, kind);
      assert.ok(
        candidates[0].filename.endsWith(SUFFIX_BY_KIND[kind]),
        `${kind} candidate filename ${candidates[0].filename} does not carry ${SUFFIX_BY_KIND[kind]}`,
      );
      assert.ok(candidates[0].id.endsWith(`.${kind}`));
    }
  });

  it("maps every TestKind in SUFFIX_BY_KIND", () => {
    // Totality is the property: a kind added without a suffix decision would
    // produce specs with a name no inventory reader recognises.
    assert.deepEqual(
      Object.keys(SUFFIX_BY_KIND).sort(),
      [...TEST_KINDS].sort(),
    );
    for (const kind of TEST_KINDS) {
      assert.match(SUFFIX_BY_KIND[kind], /^\.[a-z0-9.]+$/);
    }
  });

  it("emits one candidate per target, keyed on identity", async () => {
    const targets = [
      target({ table: "incident", sysId: "a".repeat(32) }),
      target({ table: "sc_req_item", sysId: "b".repeat(32) }),
    ];
    const completion = await createTemplateProvider().complete(
      request({ targets }),
      liveSignal(),
    );
    const candidates = parseCandidates(completion);
    assert.equal(candidates.length, 2);
    assert.deepEqual(
      candidates.map((candidate) => candidate.targets[0].sysId),
      [targets[0].sysId, targets[1].sysId],
    );
    // Distinct ids: the writer refuses a batch that repeats one, so a template
    // that collapsed two targets onto one id would be undeliverable.
    assert.notEqual(candidates[0].id, candidates[1].id);
  });

  it("keeps instance-derived prose out of the spec body (TM-1)", async () => {
    // `name` is instance text. It belongs in a labelled `targets[].name` field a
    // reader can see is data — not in a file body where an un-labelled copy
    // reads like something a person wrote.
    const completion = await createTemplateProvider().complete(
      request(),
      liveSignal(),
    );
    const [candidate] = parseCandidates(completion);
    assert.ok(
      !unwrapUntrusted(candidate.source, UNWRAP).includes(TARGET_NAME),
      "the target name reached the generated spec body",
    );
    assert.equal(candidate.targets[0].name, TARGET_NAME);
  });

  it("reports a blank promptHash by default, and honours a supplied config", async () => {
    // A blank hash is how `./generator.ts` reads "not pinned" and skips the
    // drift check — an offline template has no frozen prompt to drift from.
    const bare = createTemplateProvider();
    assert.equal(bare.name, "template");
    assert.equal(bare.config.promptHash, "");

    const config = pinned({ modelId: "template://custom/2" });
    const completion = await createTemplateProvider({ config }).complete(
      request(),
      liveSignal(),
    );
    assert.equal(completion.modelId, "template://custom/2");
    assert.equal(completion.promptHash, config.promptHash);
  });
});

// ── the Anthropic provider: what goes on the wire ───────────────────────────

describe("createAnthropicProvider — the request", () => {
  it("posts to the default base URL plus the messages path", async () => {
    const { provider, stub } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD),
    );
    await provider.complete(request(), liveSignal());
    assert.equal(stub.calls.length, 1);
    assert.equal(
      stub.calls[0].url,
      `${ANTHROPIC_DEFAULT_BASE_URL}${ANTHROPIC_MESSAGES_PATH}`,
    );
    assert.equal(stub.calls[0].init.method, "POST");
  });

  it("honours a supplied base URL and keeps the messages path", async () => {
    // The override exists for a proxy or a gateway. It may move the HOST; it may
    // not move the endpoint, or a caller could be redirected to a path that
    // answers 200 to anything.
    const { provider, stub } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD),
      { baseUrl: "https://gateway.internal.example" },
    );
    await provider.complete(request(), liveSignal());
    assert.equal(
      stub.calls[0].url,
      `https://gateway.internal.example${ANTHROPIC_MESSAGES_PATH}`,
    );
  });

  it("sends the version header and a JSON content type", async () => {
    // The version header is what pins the response SHAPE this file parses.
    // Dropping it would let a future default shape arrive at a parser written
    // for the old one, and the failure would look like "no text content".
    const { provider, stub } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD),
    );
    await provider.complete(request(), liveSignal());
    const headers = stub.headersOf(0);
    assert.equal(headers["anthropic-version"], ANTHROPIC_VERSION_HEADER);
    assert.equal(ANTHROPIC_VERSION_HEADER, "2023-06-01");
    assert.equal(headers["content-type"], "application/json");
  });

  it("sends the pinned model id and token ceiling", async () => {
    // DESIGN §12.3: a run that cannot name its model cannot be reproduced. The
    // id on the wire must be the id the provenance record will claim.
    const config = pinned({ modelId: SAMPLING_MODEL_ID, maxTokens: 1234 });
    const { provider, stub } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD),
      { config },
    );
    await provider.complete(request(), liveSignal());
    const body = stub.bodyOf(0);
    assert.equal(body.model, SAMPLING_MODEL_ID);
    assert.equal(body.max_tokens, 1234);
  });

  it("carries the two prompt channels separately and intact (TM-2)", async () => {
    // The instruction is the trusted half and the data is the untrusted half.
    // They travel in different fields and are never concatenated on the way out
    // — a re-joined prompt is a prompt where instance text sits in an
    // instruction position, which is §9.2's entire chain.
    const rendered = prompt();
    const { provider, stub } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD),
    );
    await provider.complete(request({ prompt: rendered }), liveSignal());
    const body = stub.bodyOf(0);
    assert.equal(body.system, rendered.instruction);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[0].content, rendered.data);
    assert.ok(
      !body.system.includes("DATA-CHANNEL"),
      "the data channel leaked into the instruction channel",
    );
    assert.ok(!body.messages[0].content.includes("INSTRUCTION-CHANNEL"));
  });

  it("forwards the caller's AbortSignal to the transport", async () => {
    // Identity, not "a signal": a provider that made its own would leave the
    // caller's deadline unable to stop an in-flight request.
    const signal = liveSignal();
    const { provider, stub } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD),
    );
    await provider.complete(request(), signal);
    assert.equal(stub.calls[0].init.signal, signal);
  });

  it("refuses to be constructed without a key, a model id or a token ceiling", () => {
    // DEV-1: the fix is a different argument, not a retry — so these are input
    // errors thrown at construction, before any request exists to fail.
    const fetch = () => {
      throw new Error("the provider issued a request during construction");
    };
    assert.throws(
      () => createAnthropicProvider({ fetch, apiKey: "  " }),
      (error) => error.name === "GenerateInputError",
    );
    assert.throws(
      () =>
        createAnthropicProvider({
          fetch,
          apiKey: FAKE_API_KEY,
          config: pinned({ modelId: "   " }),
        }),
      (error) => error.name === "GenerateInputError",
    );
    assert.throws(
      () =>
        createAnthropicProvider({
          fetch,
          apiKey: FAKE_API_KEY,
          config: pinned({ maxTokens: 0 }),
        }),
      (error) => error.name === "GenerateInputError",
    );
  });
});

// ── the secret ─────────────────────────────────────────────────────────────

describe("createAnthropicProvider — the key reaches one header and nothing else", () => {
  it("puts the key in x-api-key and in no other part of the request", async () => {
    const { provider, stub } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD),
    );
    await provider.complete(request(), liveSignal());
    assert.equal(stub.headersOf(0)["x-api-key"], FAKE_API_KEY);
    assertNoKeyIn(stub.calls[0].url, "the request URL");
    assertNoKeyIn(stub.calls[0].init.body, "the request body");
  });

  it("keeps the key out of the provider object and its completion", async () => {
    // The key lives in a closure and is not a property. Anything that
    // serialises, logs or inspects the provider — a debug dump, an error
    // reporter, a `console.log(provider)` — must come up empty.
    const { provider } = providerAnswering(messagesResponse(SPECS_PAYLOAD));
    assertNoKeyIn(JSON.stringify(provider), "the serialised provider");
    assertNoKeyIn(
      inspect(provider, { depth: 10, showHidden: true }),
      "the inspected provider",
    );
    assertNoKeyIn(JSON.stringify(provider.config), "the pinned config");

    const completion = await provider.complete(request(), liveSignal());
    assertNoKeyIn(
      inspect(completion, { depth: 10 }),
      "the returned completion",
    );
  });

  it("keeps the key out of every failure path's message and stack", async () => {
    // A key in a stack trace is a key in a CI log. `assertFault` checks this on
    // every fault in the file; this test enumerates the paths deliberately so
    // that a new failure branch added without a leak check shows up as a gap
    // here rather than as a secret in an annotation.
    const stub = stubFetch(() => {
      throw new Error(`transport refused ${BODY_CANARY}`);
    });
    const transport = createAnthropicProvider({
      fetch: stub.fetch,
      apiKey: FAKE_API_KEY,
      config: pinned(),
    });
    await assertFault(transport.complete(request(), liveSignal()));

    const cases = [
      providerAnswering(`{"error":{"type":"authentication_error"}}`, {
        status: 401,
      }),
      providerAnswering("not json at all", {}),
      providerAnswering(messagesResponse(SPECS_PAYLOAD, { content: [] })),
      providerAnswering(
        messagesResponse(SPECS_PAYLOAD, { stop_reason: "refusal" }),
      ),
      providerAnswering(
        messagesResponse(SPECS_PAYLOAD, { stop_reason: "max_tokens" }),
      ),
    ];
    for (const entry of cases) {
      await assertFault(entry.provider.complete(request(), liveSignal()));
    }
  });

  it("does not echo the response body into a fault message", async () => {
    // An error envelope is a place a server can put anything at all, including
    // the request it just received. Only the status and the API's own closed
    // error enum are safe to quote.
    const { provider } = providerAnswering(
      `{"error":{"type":"rate_limit_error","message":"${BODY_CANARY}"}}`,
      { status: 429 },
    );
    await assert.rejects(
      provider.complete(request(), liveSignal()),
      (error) => {
        assert.match(error.message, /429/);
        assert.match(error.message, /rate_limit_error/);
        assert.ok(
          !error.message.includes(BODY_CANARY),
          "the fault message quoted the response body back",
        );
        return true;
      },
    );
  });

  it("discards an unrecognised error type rather than echoing it", async () => {
    // The taxonomy is a closed set. A server-supplied `type` outside it is
    // attacker-influenced text with a plausible-looking home in a log line.
    const { provider } = providerAnswering(
      `{"error":{"type":"${BODY_CANARY}"}}`,
      { status: 500 },
    );
    await assertFault(provider.complete(request(), liveSignal()), /unknown/);
  });
});

// ── sampling parameters ────────────────────────────────────────────────────

describe("modelAcceptsSamplingParams", () => {
  it("returns false for every id on MODELS_WITHOUT_SAMPLING_PARAMS", () => {
    assert.ok(MODELS_WITHOUT_SAMPLING_PARAMS.length > 0);
    for (const modelId of MODELS_WITHOUT_SAMPLING_PARAMS) {
      assert.equal(modelAcceptsSamplingParams(modelId), false, modelId);
    }
  });

  it("returns true for an id off the list", () => {
    // Both directions, deliberately: a one-directional test would pass against a
    // predicate hard-wired to `false`, and a hard-wired predicate would silently
    // stop sending `temperature` to the models that still accept it.
    assert.equal(modelAcceptsSamplingParams(SAMPLING_MODEL_ID), true);
    assert.equal(modelAcceptsSamplingParams(""), true);
  });

  it("covers the pinned default model id", () => {
    // The coupling that matters: if the default were ever pinned to a model NOT
    // on the list, the default request would start carrying a `temperature` the
    // header comment says is only recorded.
    assert.ok(
      MODELS_WITHOUT_SAMPLING_PARAMS.includes(ANTHROPIC_DEFAULT_MODEL_ID),
      "the pinned default is not covered by the sampling-params list",
    );
  });

  it("omits temperature from the body for a listed model", async () => {
    const config = pinned({
      modelId: MODELS_WITHOUT_SAMPLING_PARAMS[0],
      temperature: 0.7,
    });
    const { provider, stub } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD),
      { config },
    );
    await provider.complete(request(), liveSignal());
    const body = stub.bodyOf(0);
    // `in`, not `=== undefined`: sending `"temperature": null` would be a 400,
    // and a test written against `undefined` would not see the difference.
    assert.equal("temperature" in body, false);
    assert.equal("top_p" in body, false);
    assert.equal("top_k" in body, false);
    // Still RECORDED as provenance, which is the whole point of the split.
    assert.equal(provider.config.temperature, 0.7);
  });

  it("sends temperature for a model off the list", async () => {
    const config = pinned({ modelId: SAMPLING_MODEL_ID, temperature: 0.42 });
    const { provider, stub } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD),
      { config },
    );
    await provider.complete(request(), liveSignal());
    assert.equal(stub.bodyOf(0).temperature, 0.42);
  });
});

// ── transport and protocol faults ──────────────────────────────────────────

describe("createAnthropicProvider — a fault is never an empty completion", () => {
  it("wraps a transport rejection as a GenerationFaultError with the cause attached", async () => {
    // GenerationFaultError, not GenerateInputError: the request was well formed
    // and the environment failed underneath it, so a retry is the sensible
    // response. The cause travels for a debugger; the MESSAGE is written here so
    // a transport error carrying a URL with a query string cannot become the
    // text a CI annotation prints.
    const boom = new Error("ECONNRESET");
    const stub = stubFetch(() => {
      throw boom;
    });
    const provider = createAnthropicProvider({
      fetch: stub.fetch,
      apiKey: FAKE_API_KEY,
      config: pinned(),
    });
    await assert.rejects(
      provider.complete(request(), liveSignal()),
      (error) => {
        assert.equal(error.name, "GenerationFaultError");
        assert.equal(error.cause, boom);
        return true;
      },
    );
  });

  it("faults on a non-2xx, naming the status and the API's own error type", async () => {
    // GenerationFaultError: a 429 or a 503 is the environment, not the argument.
    const { provider } = providerAnswering(
      `{"error":{"type":"overloaded_error"}}`,
      { status: 529 },
    );
    await assertFault(provider.complete(request(), liveSignal()), /529/);
  });

  it("faults on a body that is not JSON", async () => {
    // GenerationFaultError: an HTML error page from a proxy is a 200 with a body
    // this parser cannot read. Reporting it as "no specs" would be the OPP-1b
    // failure — an outage that reads downstream as a clean bill of health.
    const { provider } = providerAnswering("<html>gateway timeout</html>");
    await assertFault(provider.complete(request(), liveSignal()), /not JSON/);
  });

  it("faults on JSON of the wrong shape", async () => {
    // GenerationFaultError: valid JSON with no `content` array is a response
    // from something that is not the Messages API. `textOf` returns undefined
    // rather than guessing, and undefined is a throw.
    const { provider } = providerAnswering({ hello: "world" });
    await assertFault(
      provider.complete(request(), liveSignal()),
      /no text content/,
    );
  });

  it("faults on an empty content array", async () => {
    // GenerationFaultError, and the important half: "no text" must never be
    // reported as "no tests". The distinction is the difference between an
    // outage and a claim about the codebase.
    const { provider } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD, { content: [] }),
    );
    await assertFault(
      provider.complete(request(), liveSignal()),
      /no text content/,
    );
  });

  it("faults when the content array holds no text block", async () => {
    // `content` is a discriminated union. Reading `.text` off the first element
    // without narrowing is how a thinking-enabled model turns into `undefined`
    // — so a response of thinking and tool blocks must fault, not silently
    // produce an empty string.
    const { provider } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD, {
        content: [
          { type: "thinking", thinking: "…" },
          { type: "tool_use", id: "t1", name: "x", input: {} },
        ],
      }),
    );
    await assertFault(
      provider.complete(request(), liveSignal()),
      /no text content/,
    );
  });

  it("concatenates several text blocks into one completion", async () => {
    // The other side of the union rule: a response split across two text blocks
    // is one answer, and dropping the tail would truncate a spec list silently.
    const { provider } = providerAnswering(
      messagesResponse("", {
        content: [
          { type: "text", text: `{"specs":[` },
          { type: "thinking", thinking: "ignored" },
          {
            type: "text",
            text: `{"id":"a","kind":"unit","filename":"a.unit.ts","targets":[],"source":"x"}]}`,
          },
        ],
      }),
    );
    const completion = await provider.complete(request(), liveSignal());
    assert.equal(parseCandidates(completion).length, 1);
  });

  it("faults on stop_reason refusal, before it looks at the content", async () => {
    // GenerationFaultError. A refusal can carry a NON-empty content array
    // explaining the refusal in prose — parsing that as a spec list is how a
    // decline turns into a plausible-looking answer. Hence the order.
    const { provider } = providerAnswering(
      messagesResponse("I can't help with that.", { stop_reason: "refusal" }),
    );
    await assertFault(
      provider.complete(request(), liveSignal()),
      /declined to answer/,
    );
  });

  it("faults on stop_reason max_tokens even when text came back", async () => {
    // GenerationFaultError. The text here is well-formed JSON — that is exactly
    // the trap. A truncated answer that happens to parse is a spec list missing
    // its tail, and shipping it would under-test the change silently.
    const { provider } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD, { stop_reason: "max_tokens" }),
    );
    await assertFault(provider.complete(request(), liveSignal()), /truncated/);
  });
});

// ── stopReason ─────────────────────────────────────────────────────────────

describe("ProviderCompletion.stopReason", () => {
  it("is preserved verbatim, including a value this file has never seen", async () => {
    // `./generator.ts` refuses a truncated completion by READING this field. A
    // provider that normalised it — mapped everything unknown to "end_turn",
    // say — would make a future truncation reason invisible and ship half a
    // spec list as a whole one.
    for (const reason of [
      "end_turn",
      "tool_use",
      "pause_turn",
      "some_future_reason",
    ]) {
      const { provider } = providerAnswering(
        messagesResponse(SPECS_PAYLOAD, { stop_reason: reason }),
      );
      const completion = await provider.complete(request(), liveSignal());
      assert.equal(completion.stopReason, reason);
    }
  });

  it("reports `unknown` when the field is missing rather than assuming success", async () => {
    const { provider } = providerAnswering(
      messagesResponse(SPECS_PAYLOAD, { stop_reason: null }),
    );
    const completion = await provider.complete(request(), liveSignal());
    assert.equal(completion.stopReason, "unknown");
  });

  it("reports the model the response names, and falls back to the pinned id", async () => {
    // The served model is the reproducible fact; the pinned id is what was
    // asked for. When the response names one, provenance records what actually
    // answered.
    const config = pinned({ modelId: SAMPLING_MODEL_ID });
    const served = providerAnswering(
      messagesResponse(SPECS_PAYLOAD, { model: "served-model-9" }),
      { config },
    );
    const first = await served.provider.complete(request(), liveSignal());
    assert.equal(first.modelId, "served-model-9");
    assert.equal(first.promptHash, config.promptHash);

    const silent = providerAnswering(
      messagesResponse(SPECS_PAYLOAD, { model: 42 }),
      { config },
    );
    const second = await silent.provider.complete(request(), liveSignal());
    assert.equal(second.modelId, SAMPLING_MODEL_ID);
  });

  it("brands the returned text", async () => {
    const { provider } = providerAnswering(messagesResponse(SPECS_PAYLOAD));
    const completion = await provider.complete(request(), liveSignal());
    assert.notEqual(typeof completion.text, "string");
    assert.equal(unwrapUntrusted(completion.text, UNWRAP), SPECS_PAYLOAD);
  });
});

// ── cancellation ───────────────────────────────────────────────────────────

describe("createAnthropicProvider — cancellation", () => {
  it("honours a signal that is already aborted", async () => {
    // The transport is what enforces the abort; the provider's job is to pass
    // the signal down and to REPORT what came back rather than swallow it into
    // an empty completion.
    const controller = new AbortController();
    controller.abort(new Error("deadline exceeded before dispatch"));
    const stub = stubFetch((url, init) => {
      assert.ok(init.signal.aborted, "the provider dropped the signal");
      throw Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });
    });
    const provider = createAnthropicProvider({
      fetch: stub.fetch,
      apiKey: FAKE_API_KEY,
      config: pinned(),
    });
    await assert.rejects(
      provider.complete(request(), controller.signal),
      (error) => {
        assert.equal(error.name, "GenerationFaultError");
        assert.equal(error.cause.name, "AbortError");
        assertNoKeyIn(error.stack, "the cancellation stack");
        return true;
      },
    );
  });

  it("surfaces an abort that lands mid-flight", async () => {
    // The realistic shape: the request is already open when the deadline fires.
    // The rejection must reach the caller as a fault — a provider that resolved
    // with whatever it had would hand a partial answer to the gate.
    const controller = new AbortController();
    const stub = stubFetch(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("The operation was aborted"), {
                name: "AbortError",
              }),
            );
          });
        }),
    );
    const provider = createAnthropicProvider({
      fetch: stub.fetch,
      apiKey: FAKE_API_KEY,
      config: pinned(),
    });
    const pending = provider.complete(request(), controller.signal);
    controller.abort();
    await assertFault(pending);
  });
});

// ── parsing the answer ─────────────────────────────────────────────────────

/** A completion carrying `text`, without going through any provider. */
function completionOf(text) {
  return {
    text: untrusted(text),
    modelId: SAMPLING_MODEL_ID,
    promptHash: "d".repeat(64),
    stopReason: "end_turn",
  };
}

function specJson(overrides = {}) {
  return {
    id: "incident.unit.1",
    kind: "unit",
    filename: "incident.unit.ts",
    targets: [target()],
    source: "export function run(step) {}\n",
    ...overrides,
  };
}

describe("parseCandidates — where model output stops being opaque", () => {
  it("parses a bare JSON object", () => {
    const candidates = parseCandidates(
      completionOf(JSON.stringify({ specs: [specJson()] })),
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, "incident.unit.1");
    assert.equal(candidates[0].filename, "incident.unit.ts");
    assert.deepEqual(candidates[0].targets, [
      { table: "incident", sysId: target().sysId, name: TARGET_NAME },
    ]);
  });

  it("tolerates a fenced code block", () => {
    // Models wrap JSON in fences. Refusing to cope would turn a formatting habit
    // into a pipeline outage that looks like "the model produced nothing".
    const body = JSON.stringify({ specs: [specJson()] }, null, 2);
    const candidates = parseCandidates(
      completionOf("```json\n" + body + "\n```"),
    );
    assert.equal(candidates.length, 1);
  });

  it("tolerates an unlabelled fence", () => {
    const body = JSON.stringify({ specs: [specJson()] });
    const candidates = parseCandidates(completionOf("```\n" + body + "\n```"));
    assert.equal(candidates.length, 1);
  });

  it("tolerates surrounding prose", () => {
    const body = JSON.stringify({ specs: [specJson()] });
    const candidates = parseCandidates(
      completionOf(
        `Here are the specs I would write.\n\n${body}\n\nLet me know if you want more coverage.`,
      ),
    );
    assert.equal(candidates.length, 1);
  });

  it("parses several candidates from one completion", () => {
    const candidates = parseCandidates(
      completionOf(
        JSON.stringify({
          specs: [
            specJson({ id: "one", filename: "one.unit.ts" }),
            specJson({
              id: "two",
              kind: "e2e",
              filename: "two.e2e.atf.yaml",
            }),
            specJson({ id: "three", kind: "ui", filename: "three.spec.ts" }),
          ],
        }),
      ),
    );
    assert.deepEqual(
      candidates.map((candidate) => candidate.id),
      ["one", "two", "three"],
    );
    assert.deepEqual(
      candidates.map((candidate) => candidate.kind),
      ["unit", "e2e", "ui"],
    );
  });

  it("brands every parsed source", () => {
    // The load-bearing assertion of this whole file. Everything downstream — the
    // gate, the quality bar, the writer's unwrap boundary — is reachable only
    // through the brand. A `source` that came back as a bare string would mean
    // the model's text could be interpolated anywhere with no compiler
    // objection, which is the TM-1 hole the package exists to close.
    const [candidate] = parseCandidates(
      completionOf(JSON.stringify({ specs: [specJson({ source: "BODY" })] })),
    );
    assert.notEqual(typeof candidate.source, "string");
    assert.ok(isUntrusted(candidate.source));
    assert.equal(unwrapUntrusted(candidate.source, UNWRAP), "BODY");
    // `id`, `kind` and `filename` are deliberately NOT branded: they are checked
    // against a charset by the quality bar and are used as identifiers, not as
    // content. Pinned so a future "brand everything" change is a deliberate one.
    assert.equal(typeof candidate.id, "string");
    assert.equal(typeof candidate.filename, "string");
  });

  it("faults on an empty completion", () => {
    // GenerationFaultError, not an empty array. An empty spec list is the most
    // dangerous wrong answer this package can give (OPP-1b).
    assert.throws(() => parseCandidates(completionOf("")), {
      name: "GenerationFaultError",
    });
    assert.throws(() => parseCandidates(completionOf("   \n\t ")), {
      name: "GenerationFaultError",
    });
  });

  it("faults on prose with no JSON in it", () => {
    assert.throws(
      () =>
        parseCandidates(
          completionOf("I don't think this change needs any tests."),
        ),
      { name: "GenerationFaultError" },
    );
  });

  it("faults on an empty `specs` array rather than returning it", () => {
    assert.throws(
      () => parseCandidates(completionOf(JSON.stringify({ specs: [] }))),
      (error) => {
        assert.equal(error.name, "GenerationFaultError");
        assert.match(error.message, /empty/);
        return true;
      },
    );
  });

  it("faults on a response with no `specs` array", () => {
    assert.throws(
      () => parseCandidates(completionOf(JSON.stringify({ tests: [] }))),
      { name: "GenerationFaultError" },
    );
    assert.throws(
      () => parseCandidates(completionOf(JSON.stringify({ specs: "one" }))),
      { name: "GenerationFaultError" },
    );
  });

  it("repairs nothing", () => {
    // No quote fixing and no trailing-comma removal, deliberately. A body that
    // needs mending is a body nobody can reason about, and mending it silently
    // converts a fault into a plausible-looking answer.
    assert.throws(
      () => parseCandidates(completionOf('{"specs": [{"id": "a",}]}')),
      { name: "GenerationFaultError" },
    );
  });

  it("faults on each missing or mistyped field, one at a time", () => {
    // Structural validation only — whether the values are any GOOD is the
    // quality bar's question. Each row here is a field the writer or the
    // manifest would otherwise carry as `undefined`.
    const bad = [
      ["not an object", ["just a string"]],
      ["blank id", [specJson({ id: "  " })]],
      ["missing id", [specJson({ id: undefined })]],
      ["kind outside the union", [specJson({ kind: "integration" })]],
      ["blank filename", [specJson({ filename: "" })]],
      ["source not a string", [specJson({ source: 12 })]],
      ["targets not an array", [specJson({ targets: "incident" })]],
      [
        "target without a table",
        [specJson({ targets: [{ sysId: "a", name: "b" }] })],
      ],
      [
        "target without a sysId",
        [specJson({ targets: [{ table: "incident", name: "b" }] })],
      ],
      [
        "target without a name",
        [specJson({ targets: [{ table: "incident", sysId: "a" }] })],
      ],
    ];
    for (const [label, specs] of bad) {
      assert.throws(
        () => parseCandidates(completionOf(JSON.stringify({ specs }))),
        { name: "GenerationFaultError" },
        `a spec with ${label} was accepted`,
      );
    }
  });

  it("names the offending spec by position and never by content", () => {
    // The position is what a human needs to find it. The CONTENT is untrusted
    // model text, and an error message is a door to a log — see `./errors.ts`.
    const canary = "spec-canary-7e42-never-in-an-error";
    assert.throws(
      () =>
        parseCandidates(
          completionOf(
            JSON.stringify({
              specs: [specJson(), specJson({ id: canary, kind: "nonsense" })],
            }),
          ),
        ),
      (error) => {
        assert.match(error.message, /#2/);
        assert.ok(
          !error.message.includes(canary),
          "the parse error quoted model output",
        );
        return true;
      },
    );
  });

  it("accepts a spec with an empty targets array", () => {
    // Structural validation does not require a target — QA-16's "did the model
    // invent a target?" question belongs to the quality bar, and duplicating it
    // here would put one rule in two places that can disagree.
    const candidates = parseCandidates(
      completionOf(JSON.stringify({ specs: [specJson({ targets: [] })] })),
    );
    assert.deepEqual(candidates[0].targets, []);
  });
});
