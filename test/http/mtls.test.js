import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:https";
import { once } from "node:events";

import { createSnClient, SnNetworkError } from "../../build/http/client.js";

/**
 * Integration test for the `node:https` mutual-TLS transport. A throwaway HTTPS
 * server requires a client certificate; the client must present the configured
 * cert on the TLS socket for the request to succeed. Static self-signed PEM
 * fixtures live under `test/fixtures/tls/` (server + client key pairs).
 */

const fixture = (name) =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/tls/${name}`, import.meta.url)),
    "utf8",
  );

const serverKey = fixture("server.key");
const serverCrt = fixture("server.crt");
const clientKey = fixture("client.key");
const clientCrt = fixture("client.crt");

/** Start an HTTPS server that REQUIRES + verifies a client cert; resolve once listening. */
async function startMutualTlsServer(onRequest) {
  const server = createServer(
    {
      key: serverKey,
      cert: serverCrt,
      // Trust the self-signed client cert directly (it is its own CA).
      ca: clientCrt,
      requestCert: true,
      rejectUnauthorized: true,
    },
    onRequest,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

test("mTLS transport presents the client certificate the server requires", async () => {
  let peerCN;
  const server = await startMutualTlsServer((req, res) => {
    peerCN = req.socket.getPeerCertificate()?.subject?.CN;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: { sys_id: "x", name: "ok" } }));
  });
  try {
    const port = server.address().port;
    const http = createSnClient({
      instanceUrl: `https://localhost:${port}`,
      tls: { cert: clientCrt, key: clientKey, ca: serverCrt },
    });
    const rec = await http.table("incident").get("x");
    assert.deepEqual(rec, { sys_id: "x", name: "ok" });
    // The server observed our client certificate on the socket.
    assert.equal(peerCN, "preflight-client");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("mTLS composes with a header credential (Bearer + client cert)", async () => {
  let auth;
  const server = await startMutualTlsServer((req, res) => {
    auth = req.headers.authorization;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: { sys_id: "y" } }));
  });
  try {
    const port = server.address().port;
    const http = createSnClient({
      instanceUrl: `https://localhost:${port}`,
      auth: { kind: "oauth", token: "tok-mtls" },
      tls: { cert: clientCrt, key: clientKey, ca: serverCrt },
    });
    const rec = await http.table("incident").get("y");
    assert.deepEqual(rec, { sys_id: "y" });
    // The Authorization header rides over the mutually-authenticated socket.
    assert.equal(auth, "Bearer tok-mtls");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("mTLS handshake failure surfaces as SnNetworkError", async () => {
  const server = await startMutualTlsServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: {} }));
  });
  try {
    const port = server.address().port;
    // Present no client certificate: the server rejects the TLS handshake.
    const http = createSnClient({
      instanceUrl: `https://localhost:${port}`,
      tls: { cert: "", key: "", ca: serverCrt },
    });
    await assert.rejects(
      () => http.table("incident").get("x"),
      (err) => {
        assert.ok(err instanceof SnNetworkError);
        return true;
      },
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});
