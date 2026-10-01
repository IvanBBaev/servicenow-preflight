// The stdio framing under hostile or awkward input: a flood with no newline,
// a line past the pending-line cap, and bytes split mid-code-point.
//
// `server.test.js` proves tidy framing end to end against the fake instance.
// This file needs no instance at all — `initialize` is answered by the
// dispatcher alone — so it can push tens of megabytes through `serve` and
// assert on time and on the exact replies without a pipeline behind it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createSession,
  ERROR_CODES,
  LATEST_PROTOCOL_VERSION,
  serve,
} from "../build/index.js";
import { MAX_PENDING_LINE_LENGTH } from "../build/server.js";

const HELLO = {
  jsonrpc: "2.0",
  id: "init",
  method: "initialize",
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test-host", version: "0" },
  },
};

const context = () => {
  const logged = [];
  return {
    logged,
    server: {
      now: () => new Date(0),
      actor: "framing-test",
      cwd: "/nowhere",
      env: {},
      log: (text) => logged.push(text),
    },
  };
};

async function* from(chunks) {
  for (const chunk of chunks) yield chunk;
}

/** Serve `chunks` (strings or byte arrays) and return the parsed replies. */
async function serveChunks(chunks) {
  const written = [];
  const { server } = context();
  await serve(
    { input: from(chunks), write: (text) => written.push(text) },
    server,
    createSession(),
  );
  return written.map((text) => JSON.parse(text));
}

const isOversizeReply = (reply) =>
  reply.id === null &&
  reply.error?.code === ERROR_CODES.parse &&
  /pending line/.test(reply.error.message);

describe("@tessera/mcp — framing under load (2026-09-26)", () => {
  it("caps a pending line at about 4 MiB", () => {
    assert.equal(MAX_PENDING_LINE_LENGTH, 4 * 1024 * 1024);
  });

  it("absorbs a 32 MiB flood with no newline in bounded time, answering once", async () => {
    const chunk = "x".repeat(64 * 1024);
    function* flood() {
      for (let index = 0; index < 32 * 16; index += 1) yield chunk;
    }

    const started = process.hrtime.bigint();
    const replies = await serveChunks(flood());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // The quadratic rescan took ~16 s here; a linear scan takes well under
    // one. The bound is loose enough for a slow CI host and tight enough that
    // re-scanning the whole buffer per chunk cannot meet it.
    assert.ok(elapsedMs < 3000, `32 MiB took ${elapsedMs.toFixed(0)} ms`);
    assert.equal(replies.length, 1);
    assert.ok(isOversizeReply(replies[0]), JSON.stringify(replies[0]));
  });

  it("assembles a large legal line from small chunks in bounded time", async () => {
    // Below the cap nothing is discarded, so this is what proves the pending
    // tail is not re-joined or re-scanned per chunk: 3 MiB in 128-byte chunks
    // is ~24 000 chunks, which a per-chunk join would turn into gigabytes copied.
    const message = JSON.stringify(HELLO);
    const padded = message + " ".repeat(3 * 1024 * 1024 - message.length);
    const chunks = [];
    for (let index = 0; index < padded.length; index += 128) {
      chunks.push(padded.slice(index, index + 128));
    }
    chunks.push("\n");

    const started = process.hrtime.bigint();
    const replies = await serveChunks(chunks);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.ok(
      elapsedMs < 2000,
      `3 MiB in 128 B chunks took ${elapsedMs.toFixed(0)} ms`,
    );
    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, "init");
  });

  it("answers an oversize line once, discards it to the newline, and resumes", async () => {
    const piece = "y".repeat(1024 * 1024);
    const replies = await serveChunks([
      ...Array.from({ length: 6 }, () => piece),
      `tail-of-the-oversize-line\n${JSON.stringify(HELLO)}\n`,
    ]);

    assert.equal(replies.length, 2);
    assert.ok(isOversizeReply(replies[0]), JSON.stringify(replies[0]));
    assert.equal(replies[1].id, "init");
    assert.equal(replies[1].result.protocolVersion, LATEST_PROTOCOL_VERSION);
  });

  it("answers an oversize line that arrives whole in one chunk", async () => {
    const replies = await serveChunks([
      `${"z".repeat(MAX_PENDING_LINE_LENGTH + 1)}\n${JSON.stringify(HELLO)}\n`,
    ]);

    assert.equal(replies.length, 2);
    assert.ok(isOversizeReply(replies[0]), JSON.stringify(replies[0]));
    assert.equal(replies[1].id, "init");
  });

  it("still processes a line exactly at the cap", async () => {
    const message = JSON.stringify(HELLO);
    const padded =
      message + " ".repeat(MAX_PENDING_LINE_LENGTH - message.length);
    assert.equal(padded.length, MAX_PENDING_LINE_LENGTH);

    const replies = await serveChunks([
      padded.slice(0, 1000),
      padded.slice(1000),
      "\n",
    ]);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, "init");
  });

  it("drops an oversize final fragment the host never terminated after answering it", async () => {
    const replies = await serveChunks([
      "w".repeat(MAX_PENDING_LINE_LENGTH),
      "w".repeat(10),
    ]);

    assert.equal(replies.length, 1);
    assert.ok(isOversizeReply(replies[0]), JSON.stringify(replies[0]));
  });

  it("frames many messages in one chunk, CRLF-terminated", async () => {
    const lines = Array.from({ length: 200 }, (_, index) =>
      JSON.stringify({ jsonrpc: "2.0", id: `ping-${index}`, method: "ping" }),
    );
    const replies = await serveChunks([`${lines.join("\r\n")}\r\n`]);

    assert.equal(replies.length, 200);
    assert.equal(replies[199].id, "ping-199");
    assert.equal(replies.filter((reply) => "error" in reply).length, 0);
  });

  it("decodes UTF-8 split mid-code-point across byte chunks", async () => {
    const message = JSON.stringify({
      ...HELLO,
      params: {
        ...HELLO.params,
        clientInfo: { name: "hôst-\u{1F600}-ж", version: "0" },
      },
    });
    const bytes = new TextEncoder().encode(`${message}\r\n${message}`);
    const chunks = [];
    for (let index = 0; index < bytes.length; index += 3) {
      chunks.push(bytes.slice(index, index + 3));
    }

    const replies = await serveChunks(chunks);

    // Two replies: the CRLF-terminated one and the unterminated final one.
    assert.equal(replies.length, 2);
    assert.equal(replies[0].id, "init");
    assert.equal(replies[1].id, "init");
  });

  it("flushes bytes torn mid-code-point at the end instead of dropping them", async () => {
    const ping = new TextEncoder().encode(
      JSON.stringify({ jsonrpc: "2.0", id: "p", method: "ping" }),
    );
    // The first two bytes of U+20AC, and then the input ends.
    const replies = await serveChunks([ping, new Uint8Array([0xe2, 0x82])]);

    // The torn bytes decode to U+FFFD on the same line, so the line is not the
    // clean ping it would read as if they had vanished: it is malformed.
    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, null);
    assert.equal(replies[0].error.code, ERROR_CODES.parse);
  });
});
