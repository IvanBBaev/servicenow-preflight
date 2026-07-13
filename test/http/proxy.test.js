import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  createServer as createTcpServer,
  connect as netConnect,
} from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";

import {
  createSnClient,
  SnError,
  SnNetworkError,
} from "../../build/http/client.js";
import {
  ProxyConfigError,
  openProxyTunnel,
  parseProxyUrl,
  redactedProxy,
  resolveProxy,
} from "../../build/http/proxy.js";

/**
 * SR-5: HTTP(S) forward-proxy support. Unit tests cover the resolution /
 * bypass matrix; integration tests run a real mock CONNECT proxy (a `node:http`
 * server's `connect` event piping to a local TLS target built from the
 * `test/fixtures/tls/` PEMs). The default (fetch) transport verifies the
 * target against the process CA store, which only a fresh process can extend
 * (`NODE_EXTRA_CA_CERTS` is read at startup) — those scenarios spawn
 * `test/fixtures/proxy-child.mjs`.
 */

const fixturePath = (name) =>
  fileURLToPath(new URL(`../fixtures/tls/${name}`, import.meta.url));
const fixture = (name) => readFileSync(fixturePath(name), "utf8");

const serverKey = fixture("server.key");
const serverCrt = fixture("server.crt");
const clientKey = fixture("client.key");
const clientCrt = fixture("client.crt");

const CHILD = fileURLToPath(
  new URL("../fixtures/proxy-child.mjs", import.meta.url),
);

const PROXY_ENV_VARS = [
  "SNPF_PROXY",
  "SNPF_NO_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
];

// Every test starts from a clean proxy environment; tests set what they need.
// (node --test runs each file in its own process, so this cannot leak.)
beforeEach(() => {
  for (const name of PROXY_ENV_VARS) delete process.env[name];
});

/** Track a server's raw sockets so `stop()` can tear them down deterministically. */
function trackSockets(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return async function stop() {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, "close");
  };
}

/**
 * Start a local HTTPS target from the TLS fixtures. With `mutual: true` it
 * REQUIRES + verifies a client certificate (the proxy must therefore pass the
 * TLS bytes through untouched for the request to succeed).
 */
async function startTlsTarget({ mutual = false, onRequest } = {}) {
  const seen = { peerCNs: [] };
  const server = createHttpsServer(
    {
      key: serverKey,
      cert: serverCrt,
      ...(mutual
        ? { ca: clientCrt, requestCert: true, rejectUnauthorized: true }
        : {}),
    },
    (req, res) => {
      seen.peerCNs.push(req.socket.getPeerCertificate()?.subject?.CN);
      if (onRequest) {
        onRequest(req, res);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { sys_id: "x", name: "ok" } }));
    },
  );
  const stop = trackSockets(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, seen, stop };
}

/**
 * Start a mock CONNECT proxy: a `node:http` (or, with `tls: true`, a
 * `node:https`) server whose `connect` event pipes a plain TCP upstream to the
 * requested host:port. Records every CONNECT target and Proxy-Authorization
 * header it sees. With `requireAuth` set, a non-matching header is answered
 * with 407; with `refuse: true`, every CONNECT is answered with 403.
 */
async function startConnectProxy({
  requireAuth,
  refuse = false,
  tls = false,
} = {}) {
  const seen = { connects: [], auths: [] };
  const server = tls
    ? createHttpsServer({ key: serverKey, cert: serverCrt })
    : createHttpServer();
  server.on("request", (req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on("connect", (req, clientSocket, head) => {
    seen.connects.push(req.url);
    seen.auths.push(req.headers["proxy-authorization"]);
    if (requireAuth && req.headers["proxy-authorization"] !== requireAuth) {
      clientSocket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="proxy"\r\n\r\n',
      );
      return;
    }
    if (refuse) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const [host, port] = req.url.split(":");
    const upstream = netConnect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", () => upstream.destroy());
    upstream.on("close", () => clientSocket.destroy());
  });
  const stop = trackSockets(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const scheme = tls ? "https" : "http";
  // The TLS fixture certifies `localhost`, so an https proxy is addressed by name.
  const host = tls ? "localhost" : "127.0.0.1";
  return { port, url: `${scheme}://${host}:${port}`, seen, stop };
}

/** An ephemeral port with nothing listening on it (grab, then release). */
async function unreachablePort() {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

/** Run the child harness with a controlled proxy environment. */
function runChild(instanceUrl, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, instanceUrl], {
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: fixturePath("server.crt"),
        // Our resolver treats empty values as unset — scrub inherited state.
        ...Object.fromEntries(PROXY_ENV_VARS.map((name) => [name, ""])),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("close", (code) => resolve({ code, out, errOut }));
  });
}

// ---------------------------------------------------------------------------
// resolveProxy — selection precedence (OPP-1 / OPP-2)
// ---------------------------------------------------------------------------

test("resolveProxy picks HTTPS_PROXY for an https target", () => {
  const proxy = resolveProxy("https://dev12345.service-now.com/api", {
    env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
  });
  assert.equal(proxy?.href, "http://proxy.example.com:3128/");
});

test("resolveProxy falls back to lowercase https_proxy, uppercase preferred", () => {
  const lower = resolveProxy("https://x.example.com", {
    env: { https_proxy: "http://lower.example.com:1" },
  });
  assert.equal(lower?.hostname, "lower.example.com");
  const both = resolveProxy("https://x.example.com", {
    env: {
      HTTPS_PROXY: "http://upper.example.com:1",
      https_proxy: "http://lower.example.com:1",
    },
  });
  assert.equal(both?.hostname, "upper.example.com");
});

test("SNPF_PROXY outranks the standard HTTPS_PROXY (OPP-2)", () => {
  const proxy = resolveProxy("https://x.example.com", {
    env: {
      SNPF_PROXY: "http://snpf.example.com:1",
      HTTPS_PROXY: "http://standard.example.com:1",
    },
  });
  assert.equal(proxy?.hostname, "snpf.example.com");
});

test("an explicit proxy option outranks every environment variable (OPP-2)", () => {
  const proxy = resolveProxy("https://x.example.com", {
    proxy: "http://explicit.example.com:1",
    env: {
      SNPF_PROXY: "http://snpf.example.com:1",
      HTTPS_PROXY: "http://standard.example.com:1",
    },
  });
  assert.equal(proxy?.hostname, "explicit.example.com");
});

test("HTTP_PROXY alone never applies to an https target (OPP-1)", () => {
  const proxy = resolveProxy("https://x.example.com", {
    env: { HTTP_PROXY: "http://proxy.example.com:1" },
  });
  assert.equal(proxy, undefined);
});

test("an http:// target is never proxied (OPP-1)", () => {
  const proxy = resolveProxy("http://x.example.com", {
    proxy: "http://explicit.example.com:1",
    env: { HTTPS_PROXY: "http://proxy.example.com:1" },
  });
  assert.equal(proxy, undefined);
});

test("empty / whitespace-only proxy values are treated as unset", () => {
  const proxy = resolveProxy("https://x.example.com", {
    proxy: "  ",
    env: { HTTPS_PROXY: "", https_proxy: "   " },
  });
  assert.equal(proxy, undefined);
});

test("the resolved proxy URL keeps its userinfo for the tunnel", () => {
  const proxy = resolveProxy("https://x.example.com", {
    env: { HTTPS_PROXY: "http://user:p%40ss@proxy.example.com:3128" },
  });
  assert.equal(proxy?.username, "user");
  assert.equal(proxy?.password, "p%40ss");
});

// ---------------------------------------------------------------------------
// resolveProxy — NO_PROXY bypassing (OPP-3)
// ---------------------------------------------------------------------------

const NO_PROXY_ENV = { HTTPS_PROXY: "http://proxy.example.com:3128" };

test("NO_PROXY bypasses an exact host match, case-insensitively", () => {
  const proxy = resolveProxy("https://Dev12345.Service-Now.com", {
    env: {
      ...NO_PROXY_ENV,
      NO_PROXY: "other.example.com, DEV12345.service-now.COM",
    },
  });
  assert.equal(proxy, undefined);
});

test("NO_PROXY matches subdomains by whole-label suffix, with or without a leading dot", () => {
  for (const entry of ["example.com", ".example.com"]) {
    const env = { ...NO_PROXY_ENV, NO_PROXY: entry };
    assert.equal(resolveProxy("https://a.example.com", { env }), undefined);
    assert.equal(resolveProxy("https://example.com", { env }), undefined);
    // `example.com` must NOT match `badexample.com` (no partial-label match).
    assert.equal(
      resolveProxy("https://badexample.com", { env })?.hostname,
      "proxy.example.com",
    );
  }
});

test("a port-qualified NO_PROXY entry only bypasses that target port", () => {
  const env = { ...NO_PROXY_ENV, NO_PROXY: "example.com:8443" };
  assert.equal(resolveProxy("https://example.com:8443", { env }), undefined);
  // The https default port is 443 — no match against the :8443 entry.
  assert.equal(
    resolveProxy("https://example.com", { env })?.hostname,
    "proxy.example.com",
  );
});

test("NO_PROXY=* bypasses every host (forces direct connections)", () => {
  const proxy = resolveProxy("https://x.example.com", {
    env: { ...NO_PROXY_ENV, NO_PROXY: "*" },
  });
  assert.equal(proxy, undefined);
});

test("a bracketed IPv6 NO_PROXY entry matches, with and without a port", () => {
  for (const entry of ["[::1]", "[::1]:443"]) {
    const proxy = resolveProxy("https://[::1]/", {
      env: { ...NO_PROXY_ENV, NO_PROXY: entry },
    });
    assert.equal(proxy, undefined, `entry ${entry} should bypass`);
  }
  // A different port-qualified entry must not bypass.
  const proxy = resolveProxy("https://[::1]/", {
    env: { ...NO_PROXY_ENV, NO_PROXY: "[::1]:8443" },
  });
  assert.equal(proxy?.hostname, "proxy.example.com");
});

test("a bare (unbracketed) IPv6 NO_PROXY entry bypasses a bracketed target (SEC)", () => {
  // `NO_PROXY=::1` is the shape the environment actually carries — but the
  // target hostname is bracketed (`[::1]`). The bypass must normalise brackets
  // on both sides, or the loopback literal would wrongly route through the proxy.
  const proxy = resolveProxy("https://[::1]/", {
    env: { ...NO_PROXY_ENV, NO_PROXY: "::1" },
  });
  assert.equal(proxy, undefined);
});

test("the bypass verdict is the union of noProxy option, SNPF_NO_PROXY and no_proxy (OPP-3)", () => {
  const env = { ...NO_PROXY_ENV };
  // Option source — bypasses even an explicitly configured proxy.
  assert.equal(
    resolveProxy("https://a.example.com", {
      proxy: "http://explicit.example.com:1",
      noProxy: "a.example.com",
      env,
    }),
    undefined,
  );
  // SNPF_NO_PROXY source.
  assert.equal(
    resolveProxy("https://b.example.com", {
      env: { ...env, SNPF_NO_PROXY: "b.example.com" },
    }),
    undefined,
  );
  // Lowercase no_proxy source; empty entries in the list are ignored.
  assert.equal(
    resolveProxy("https://c.example.com", {
      env: { ...env, no_proxy: " , ,c.example.com" },
    }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// parseProxyUrl / redactedProxy — validation and redaction (OPP-4 / OPP-6)
// ---------------------------------------------------------------------------

test("a malformed proxy URL throws ProxyConfigError naming the source, never the value", () => {
  assert.throws(
    () =>
      resolveProxy("https://x.example.com", {
        env: { HTTPS_PROXY: "::user:secret-cred::" },
      }),
    (err) => {
      assert.ok(err instanceof ProxyConfigError);
      assert.match(err.message, /HTTPS_PROXY/);
      // OPP-6: the raw value may embed credentials — never echo it.
      assert.ok(!err.message.includes("secret-cred"));
      return true;
    },
  );
});

test("an unsupported proxy scheme throws instead of silently bypassing (OPP-4)", () => {
  assert.throws(
    () =>
      resolveProxy("https://x.example.com", {
        env: { SNPF_PROXY: "socks5://proxy.example.com:1080" },
      }),
    (err) => {
      assert.ok(err instanceof ProxyConfigError);
      assert.match(err.message, /socks5/);
      assert.match(err.message, /never silently bypassed/);
      return true;
    },
  );
});

test("redactedProxy strips userinfo credentials (OPP-6)", () => {
  const proxy = parseProxyUrl("http://user:secret@proxy.example.com:3128");
  assert.equal(redactedProxy(proxy), "http://proxy.example.com:3128");
});

// ---------------------------------------------------------------------------
// openProxyTunnel — protocol edge cases against raw TCP peers
// ---------------------------------------------------------------------------

/** Start a raw TCP server that runs `onSocket` for every connection. */
async function startRawServer(onSocket) {
  const server = createTcpServer(onSocket);
  const stop = trackSockets(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, stop };
}

test("openProxyTunnel rejects a malformed CONNECT response", async () => {
  const raw = await startRawServer((socket) => {
    socket.write("GARBAGE RESPONSE\r\n\r\n");
  });
  try {
    await assert.rejects(
      openProxyTunnel(parseProxyUrl(`http://127.0.0.1:${raw.port}`), {
        host: "target.example.com",
        port: 443,
      }),
      /malformed CONNECT response/,
    );
  } finally {
    await raw.stop();
  }
});

test("openProxyTunnel rejects an oversized CONNECT response head", async () => {
  const raw = await startRawServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\nX-Filler: " + "x".repeat(20_000));
  });
  try {
    await assert.rejects(
      openProxyTunnel(parseProxyUrl(`http://127.0.0.1:${raw.port}`), {
        host: "target.example.com",
        port: 443,
      }),
      /oversized CONNECT response/,
    );
  } finally {
    await raw.stop();
  }
});

test("openProxyTunnel rejects when the proxy closes mid-CONNECT", async () => {
  const raw = await startRawServer((socket) => {
    socket.end("HTTP/1.1 ");
  });
  try {
    await assert.rejects(
      openProxyTunnel(parseProxyUrl(`http://127.0.0.1:${raw.port}`), {
        host: "target.example.com",
        port: 443,
      }),
      /closed the connection during CONNECT/,
    );
  } finally {
    await raw.stop();
  }
});

test("openProxyTunnel honours an already-aborted signal, preserving its name", async () => {
  await assert.rejects(
    openProxyTunnel(
      parseProxyUrl("http://127.0.0.1:1"),
      { host: "target.example.com", port: 443 },
      AbortSignal.abort(),
    ),
    (err) => {
      assert.equal(err.name, "AbortError");
      return true;
    },
  );
});

test("openProxyTunnel routes malformed credential percent-encoding through fail(), never leaking it (SEC)", async () => {
  // A bare `%zz` in the userinfo survives URL parsing but breaks
  // decodeURIComponent. The guard must reject (destroying the just-opened
  // socket) with a redacted message, rather than throwing out of the Promise
  // executor and leaking the half-open socket / the raw credential value.
  await assert.rejects(
    openProxyTunnel(parseProxyUrl("http://user:%zz@127.0.0.1:1"), {
      host: "target.example.com",
      port: 443,
    }),
    (err) => {
      assert.match(err.message, /not valid percent-encoding/);
      // The raw userinfo never appears in the message.
      assert.ok(!err.message.includes("%zz"));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// End-to-end through a mock CONNECT proxy — mTLS transport (in-process)
// ---------------------------------------------------------------------------

test("a tunneled request succeeds on the mTLS transport — client cert presented end-to-end", async () => {
  const target = await startTlsTarget({ mutual: true });
  const proxy = await startConnectProxy();
  try {
    const http = createSnClient({
      instanceUrl: `https://localhost:${target.port}`,
      tls: { cert: clientCrt, key: clientKey, ca: serverCrt },
      proxy: proxy.url,
    });
    const rec = await http.table("incident").get("x");
    assert.deepEqual(rec, { sys_id: "x", name: "ok" });
    // The proxy tunneled exactly one CONNECT to the target...
    assert.deepEqual(proxy.seen.connects, [`localhost:${target.port}`]);
    // ...without credentials (no userinfo on the proxy URL)...
    assert.deepEqual(proxy.seen.auths, [undefined]);
    // ...and the mTLS client certificate rode the *inner* TLS session, which
    // the proxy cannot terminate (OPP-5).
    assert.deepEqual(target.seen.peerCNs, ["preflight-client"]);
  } finally {
    await proxy.stop();
    await target.stop();
  }
});

test("Proxy-Authorization is sent when the proxy URL carries userinfo (URL-decoded)", async () => {
  const expected = `Basic ${Buffer.from("user:p@ss", "utf8").toString("base64")}`;
  const target = await startTlsTarget();
  const proxy = await startConnectProxy({ requireAuth: expected });
  try {
    const http = createSnClient({
      instanceUrl: `https://localhost:${target.port}`,
      tls: { cert: clientCrt, key: clientKey, ca: serverCrt },
      proxy: `http://user:p%40ss@127.0.0.1:${proxy.port}`,
    });
    const rec = await http.table("incident").get("x");
    assert.deepEqual(rec, { sys_id: "x", name: "ok" });
    assert.deepEqual(proxy.seen.auths, [expected]);
  } finally {
    await proxy.stop();
    await target.stop();
  }
});

test("an explicitly configured proxy outranks a broken HTTPS_PROXY (config-over-env, OPP-2)", async () => {
  const target = await startTlsTarget();
  const proxy = await startConnectProxy();
  const deadPort = await unreachablePort();
  process.env.HTTPS_PROXY = `http://127.0.0.1:${deadPort}`;
  try {
    const http = createSnClient({
      instanceUrl: `https://localhost:${target.port}`,
      tls: { cert: clientCrt, key: clientKey, ca: serverCrt },
      proxy: proxy.url,
    });
    const rec = await http.table("incident").get("x");
    assert.deepEqual(rec, { sys_id: "x", name: "ok" });
    assert.equal(proxy.seen.connects.length, 1);
  } finally {
    await proxy.stop();
    await target.stop();
  }
});

test("NO_PROXY bypasses the proxy entirely — the request goes direct (OPP-3)", async () => {
  const target = await startTlsTarget();
  const proxy = await startConnectProxy();
  process.env.HTTPS_PROXY = proxy.url;
  process.env.NO_PROXY = "localhost";
  try {
    const http = createSnClient({
      instanceUrl: `https://localhost:${target.port}`,
      tls: { cert: clientCrt, key: clientKey, ca: serverCrt },
    });
    const rec = await http.table("incident").get("x");
    assert.deepEqual(rec, { sys_id: "x", name: "ok" });
    // The proxy never saw a CONNECT.
    assert.equal(proxy.seen.connects.length, 0);
  } finally {
    await proxy.stop();
    await target.stop();
  }
});

test("CC-31 holds on the tunneled path: a redirect from the target is refused", async () => {
  const target = await startTlsTarget({
    onRequest: (req, res) => {
      res.writeHead(302, { Location: "https://evil.example.com/" });
      res.end();
    },
  });
  const proxy = await startConnectProxy();
  try {
    const http = createSnClient({
      instanceUrl: `https://localhost:${target.port}`,
      tls: { cert: clientCrt, key: clientKey, ca: serverCrt },
      proxy: proxy.url,
    });
    await assert.rejects(
      () => http.table("incident").get("x"),
      (err) => {
        assert.ok(err instanceof SnNetworkError);
        assert.match(err.message, /redirect/i);
        return true;
      },
    );
  } finally {
    await proxy.stop();
    await target.stop();
  }
});

test("the inner TLS handshake through the tunnel honours the request timeout — no hang (SEC-1)", async () => {
  // A raw TCP peer accepts the tunnelled socket but never speaks TLS, so the
  // end-to-end handshake would hang forever. tlsOverTunnel must honour the
  // request's abort signal (the per-request timeout), destroy the half-open
  // socket and reject — surfacing as a timeout SnNetworkError, not a hang.
  const raw = await startRawServer(() => {
    /* accept the tunnelled socket and stay silent — never start TLS */
  });
  const proxy = await startConnectProxy();
  try {
    const http = createSnClient({
      instanceUrl: `https://localhost:${raw.port}`,
      proxy: proxy.url,
      timeoutMs: 250,
    });
    await assert.rejects(
      () => http.table("incident").get("x"),
      (err) => {
        assert.ok(err instanceof SnNetworkError);
        assert.match(err.message, /timed out after 250ms/);
        return true;
      },
    );
  } finally {
    await proxy.stop();
    await raw.stop();
  }
});

// ---------------------------------------------------------------------------
// Proxy-layer failures → SnNetworkError, credentials redacted (OPP-6 / OPP-7)
// ---------------------------------------------------------------------------

test("a 407 from the proxy maps to SnNetworkError naming the proxy, never the credentials", async () => {
  const target = await startTlsTarget();
  const proxy = await startConnectProxy({
    requireAuth: "Basic something-else",
  });
  try {
    // Default transport (no tls) — the tunnel fails before any TLS happens,
    // so this also exercises proxy routing on the fetch-default client.
    const http = createSnClient({
      instanceUrl: `https://localhost:${target.port}`,
      proxy: `http://user:wrongpass@127.0.0.1:${proxy.port}`,
    });
    await assert.rejects(
      () => http.table("incident").get("x"),
      (err) => {
        assert.ok(err instanceof SnNetworkError);
        assert.match(err.message, /HTTP 407/);
        assert.match(err.message, /proxy authentication required/);
        assert.ok(err.message.includes(`http://127.0.0.1:${proxy.port}`));
        // OPP-6: the userinfo never leaks into the message.
        assert.ok(!err.message.includes("wrongpass"));
        assert.ok(!err.message.includes("user:"));
        return true;
      },
    );
  } finally {
    await proxy.stop();
    await target.stop();
  }
});

test("an unreachable proxy maps to SnNetworkError naming the redacted proxy", async () => {
  const deadPort = await unreachablePort();
  const http = createSnClient({
    instanceUrl: "https://dev12345.service-now.com",
    proxy: `http://user:hush-hush@127.0.0.1:${deadPort}`,
  });
  await assert.rejects(
    () => http.table("incident").get("x"),
    (err) => {
      assert.ok(err instanceof SnNetworkError);
      assert.match(err.message, /Could not reach the proxy/);
      assert.ok(err.message.includes(`http://127.0.0.1:${deadPort}`));
      assert.ok(!err.message.includes("hush-hush"));
      return true;
    },
  );
});

test("a refused tunnel (403) maps to SnNetworkError", async () => {
  const proxy = await startConnectProxy({ refuse: true });
  try {
    const http = createSnClient({
      instanceUrl: "https://dev12345.service-now.com",
      proxy: proxy.url,
    });
    await assert.rejects(
      () => http.table("incident").get("x"),
      (err) => {
        assert.ok(err instanceof SnNetworkError);
        assert.match(err.message, /refused CONNECT/);
        assert.match(err.message, /HTTP 403/);
        return true;
      },
    );
  } finally {
    await proxy.stop();
  }
});

test("a non-TLS upstream behind the tunnel fails the inner handshake as SnNetworkError", async () => {
  // The proxy happily tunnels to a plain TCP peer; the end-to-end TLS layer
  // must reject it (full verification is never relaxed — OPP-5).
  const raw = await startRawServer((socket) => {
    socket.write("not a tls server");
  });
  const proxy = await startConnectProxy();
  try {
    const http = createSnClient({
      instanceUrl: `https://localhost:${raw.port}`,
      proxy: proxy.url,
    });
    await assert.rejects(
      () => http.table("incident").get("x"),
      (err) => {
        assert.ok(err instanceof SnNetworkError);
        return true;
      },
    );
  } finally {
    await proxy.stop();
    await raw.stop();
  }
});

test("a malformed HTTPS_PROXY surfaces per request as SnNetworkError — never a silent bypass (OPP-4)", async () => {
  process.env.HTTPS_PROXY = "::not a url::";
  const http = createSnClient({
    instanceUrl: "https://dev12345.service-now.com",
  });
  await assert.rejects(
    () => http.table("incident").get("x"),
    (err) => {
      assert.ok(err instanceof SnNetworkError);
      assert.match(err.message, /HTTPS_PROXY/);
      return true;
    },
  );
});

test("an invalid SnClientConfig.proxy fails fast at construction with SnError (OPP-4)", () => {
  assert.throws(
    () =>
      createSnClient({
        instanceUrl: "https://dev12345.service-now.com",
        proxy: "socks5://proxy.example.com:1080",
      }),
    (err) => {
      assert.ok(err instanceof SnError);
      assert.match(err.message, /socks5/);
      assert.match(err.message, /SnClientConfig\.proxy/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Default (fetch) transport through the tunnel — child process, because
// NODE_EXTRA_CA_CERTS (trust for the self-signed fixture) is read at startup.
// ---------------------------------------------------------------------------

test("a tunneled request succeeds on the default transport (HTTPS_PROXY)", async () => {
  const target = await startTlsTarget();
  const proxy = await startConnectProxy();
  try {
    const { code, out, errOut } = await runChild(
      `https://localhost:${target.port}`,
      { HTTPS_PROXY: proxy.url },
    );
    assert.equal(code, 0, `child failed: ${errOut}`);
    assert.deepEqual(JSON.parse(out), { sys_id: "x", name: "ok" });
    assert.deepEqual(proxy.seen.connects, [`localhost:${target.port}`]);
  } finally {
    await proxy.stop();
    await target.stop();
  }
});

test("an https:// proxy works: TLS to the proxy, CONNECT, then nested TLS to the target", async () => {
  const target = await startTlsTarget();
  const proxy = await startConnectProxy({ tls: true });
  try {
    const { code, out, errOut } = await runChild(
      `https://localhost:${target.port}`,
      { HTTPS_PROXY: proxy.url },
    );
    assert.equal(code, 0, `child failed: ${errOut}`);
    assert.deepEqual(JSON.parse(out), { sys_id: "x", name: "ok" });
    assert.deepEqual(proxy.seen.connects, [`localhost:${target.port}`]);
  } finally {
    await proxy.stop();
    await target.stop();
  }
});
