/**
 * Outbound HTTP(S) forward-proxy support for the ServiceNow client (SR-5):
 * proxy URL resolution, `NO_PROXY`-style bypassing, and the raw CONNECT
 * tunnel. Zero runtime dependencies — the tunnel is hand-rolled on
 * `node:net` / `node:tls`, because Node's global `fetch` (undici) ignores
 * proxy environment variables unless a dispatcher is injected, and undici is
 * not a declared dependency of this package.
 *
 * ## Environment variables
 *
 * Proxy selection for a target URL, from highest precedence to lowest
 * (OPP-2 — explicit configuration always outranks the standard variables):
 *
 * 1. An explicit `proxy` option (the config file's `proxy` key /
 *    `SnClientConfig.proxy`, wired through `src/config.ts`).
 * 2. `SNPF_PROXY` — this tool's namespaced override, so a preflight run can be
 *    pointed at a proxy without disturbing the process-wide variables.
 * 3. `HTTPS_PROXY`, then lowercase `https_proxy` — the standard variables for
 *    **https:// targets**. `process.env` is case-sensitive on POSIX, so both
 *    spellings are consulted explicitly (uppercase first, matching curl).
 *
 * Only `https://` targets are ever proxied (OPP-1): every ServiceNow instance
 * URL is https, and `HTTP_PROXY`/`http_proxy` are deliberately **not** used as
 * a fallback for https targets — mainstream tools (curl, requests, undici)
 * scope `HTTP_PROXY` to plain-http traffic only, and silently routing TLS
 * traffic through a variable the operator set for http would be surprising.
 * An `http://` target URL is always fetched directly.
 *
 * A proxy URL looks like `http://proxy.example.com:3128` (default port 80) or
 * `https://proxy.example.com:3129` (default port 443 — the proxy itself is a
 * TLS peer, verified against the default CA store, with the CONNECT issued
 * inside that session). Basic credentials may ride in the URL userinfo
 * (`http://user:pass@proxy…`) and are sent as `Proxy-Authorization: Basic …`;
 * they are never logged and never echoed into error messages (OPP-6).
 * Any other scheme (e.g. `socks5://`) is a configuration error — a configured
 * proxy is **never silently bypassed** (OPP-4). Empty / whitespace-only values
 * are treated as unset.
 *
 * ## Bypass list
 *
 * The bypass verdict is the union of the explicit `noProxy` option, then
 * `SNPF_NO_PROXY`, then `NO_PROXY` (or lowercase `no_proxy` when the uppercase
 * spelling is unset) — a match in **any** source bypasses the proxy, even an
 * explicitly configured one (OPP-3). Each source is a comma-separated list of
 * entries, matched case-insensitively against the target hostname:
 *
 * - `*` — bypass every host (forces direct connections).
 * - `example.com` or `.example.com` — the host itself and any subdomain
 *   (`example.com`, `a.example.com`); a leading dot is ignored. Suffix
 *   matching is on whole labels, so `example.com` does NOT match
 *   `badexample.com`.
 * - `example.com:8443` — as above, but only for that target port (the target
 *   port defaults to 443 for https URLs).
 *
 * There is no built-in loopback exemption: `localhost` traffic honours the
 * same variables, matching the standard-variable semantics — add it to
 * `NO_PROXY` to exempt it.
 */

import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * A proxy configuration problem: malformed proxy URL or unsupported scheme.
 * Deliberately a plain `Error` subclass (not an `SnError`) to keep this module
 * free of an import cycle with `./client.js`; the client maps it into its own
 * error taxonomy (`SnError` at construction, `SnNetworkError` per request).
 */
export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyConfigError";
  }
}

/** Options for {@link resolveProxy}. */
export interface ResolveProxyOptions {
  /** Explicit proxy URL — outranks every environment variable (OPP-2). */
  proxy?: string;
  /** Extra bypass entries, merged with the `NO_PROXY`-family variables. */
  noProxy?: string;
  /** Environment to consult (defaults to `process.env`; injectable for tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * First non-empty value among `names` (in order), with the variable's name so
 * error messages can cite the source instead of echoing the value (OPP-6).
 * Empty / whitespace-only values count as unset.
 */
function envValue(
  env: NodeJS.ProcessEnv,
  ...names: string[]
): { name: string; value: string } | undefined {
  for (const name of names) {
    const raw = env[name];
    if (typeof raw === "string" && raw.trim() !== "") {
      return { name, value: raw.trim() };
    }
  }
  return undefined;
}

/**
 * Parse and validate a proxy URL. Throws {@link ProxyConfigError} on a
 * malformed URL or an unsupported scheme — never echoing the raw value, which
 * may embed `user:pass` credentials (OPP-6); `source` names where the value
 * came from so the operator can find it.
 */
export function parseProxyUrl(
  raw: string,
  source = "the proxy configuration",
): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProxyConfigError(
      `The proxy URL from ${source} is not a valid URL; expected e.g. ` +
        `"http://proxy.example.com:3128".`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // OPP-4: an unsupported proxy scheme must fail, never silently bypass the
    // proxy the operator configured.
    throw new ProxyConfigError(
      `The proxy URL from ${source} uses the unsupported scheme ` +
        `"${url.protocol}" — only http:// and https:// proxies are supported. ` +
        `A configured proxy is never silently bypassed; fix or unset it.`,
    );
  }
  return url;
}

/**
 * The proxy's safe-to-log form: scheme + host + port, with any userinfo
 * credentials stripped (OPP-6). Every error message names the proxy through
 * this helper.
 */
export function redactedProxy(proxy: URL): string {
  return `${proxy.protocol}//${proxy.host}`;
}

/** Split a bypass entry into host and optional port (IPv6-bracket aware). */
function splitHostPort(entry: string): { host: string; port?: string } {
  const v6 = /^(\[[^\]]*\])(?::(\d+))?$/.exec(entry);
  if (v6?.[1]) return { host: v6[1], port: v6[2] };
  const m = /^(.+):(\d+)$/.exec(entry);
  // A bare IPv6 address without brackets contains ":" itself — do not split it.
  if (m?.[1] !== undefined && m[2] !== undefined && !m[1].includes(":")) {
    return { host: m[1], port: m[2] };
  }
  return { host: entry };
}

/** Whether one bypass-list entry matches the target host (+ effective port). */
function noProxyEntryMatches(
  rawEntry: string,
  host: string,
  port: string,
): boolean {
  const entry = rawEntry.trim().toLowerCase();
  if (entry === "") return false;
  if (entry === "*") return true;
  const parsed = splitHostPort(entry);
  if (parsed.port !== undefined && parsed.port !== port) return false;
  // A leading dot means "any subdomain of" — same as the bare form here.
  // Normalise IPv6 brackets so a bare (`::1`) or bracketed (`[::1]`) entry both
  // match the target host, which is compared bracket-stripped below (OPP-3).
  const entryHost = dialHost(parsed.host.replace(/^\./, ""));
  // Whole-label suffix match: `example.com` covers `a.example.com` but never
  // `badexample.com`.
  return host === entryHost || host.endsWith(`.${entryHost}`);
}

/**
 * Decide whether (and via which proxy) `targetUrl` should be reached, per the
 * module contract above. Returns the parsed proxy URL, or `undefined` for a
 * direct connection. Throws {@link ProxyConfigError} when a configured value
 * is malformed or uses an unsupported scheme (OPP-4 — fail, never bypass).
 */
export function resolveProxy(
  targetUrl: string | URL,
  opts: ResolveProxyOptions = {},
): URL | undefined {
  const env = opts.env ?? process.env;
  const target = typeof targetUrl === "string" ? new URL(targetUrl) : targetUrl;
  // OPP-1: only https:// targets are proxied; HTTP_PROXY is deliberately not
  // consulted for them (see the module JSDoc).
  if (target.protocol !== "https:") return undefined;

  // Strip any IPv6 brackets so the bypass comparison sees the bare literal,
  // matching how noProxyEntryMatches normalises its entries (SEC — a bare
  // `NO_PROXY=::1` must bypass an `https://[::1]` target).
  const host = dialHost(target.hostname).toLowerCase();
  const port = target.port || "443";
  // OPP-3: the bypass verdict is the union of every source — a match anywhere
  // goes direct, even when the proxy itself was configured explicitly.
  const bypassSources = [
    opts.noProxy,
    envValue(env, "SNPF_NO_PROXY")?.value,
    envValue(env, "NO_PROXY", "no_proxy")?.value,
  ];
  for (const source of bypassSources) {
    if (!source) continue;
    for (const entry of source.split(",")) {
      if (noProxyEntryMatches(entry, host, port)) return undefined;
    }
  }

  // OPP-2: explicit configuration first, then SNPF_PROXY, then the standard
  // https-proxy variables (uppercase preferred).
  if (typeof opts.proxy === "string" && opts.proxy.trim() !== "") {
    return parseProxyUrl(opts.proxy, "the configured proxy setting");
  }
  const fromEnv = envValue(env, "SNPF_PROXY", "HTTPS_PROXY", "https_proxy");
  if (!fromEnv) return undefined;
  return parseProxyUrl(
    fromEnv.value,
    `the ${fromEnv.name} environment variable`,
  );
}

/** The tunnel destination: the target's hostname (verbatim from its URL, so an
 * IPv6 literal keeps its brackets) and effective port. */
export interface ProxyTunnelTarget {
  host: string;
  port: number;
}

/** Strip WHATWG-URL brackets off an IPv6 hostname for node dial options. */
function dialHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** Upper bound on a CONNECT response head; a proxy sending more is broken. */
const MAX_CONNECT_HEAD = 16 * 1024;

/**
 * Open a raw tunnel to `target` through `proxy`: dial the proxy (plain TCP for
 * an `http://` proxy; a fully verified TLS session for an `https://` proxy),
 * issue `CONNECT host:port`, and resolve with the socket once the proxy
 * answers 200 — ready for the caller to layer the end-to-end target TLS
 * session on top (the proxy never terminates the target TLS).
 *
 * Rejections name the proxy in redacted form only (OPP-6) and are mapped to
 * `SnNetworkError` by the client's transport pipeline (OPP-7): unreachable
 * proxy, non-200 CONNECT (407 auth required, 403 refused, …), malformed or
 * oversized response, or an abort/timeout fired via `signal` (the rejection
 * keeps the signal reason's `name`, so the client's timeout mapping works
 * identically to a direct connection).
 */
export function openProxyTunnel(
  proxy: URL,
  target: ProxyTunnelTarget,
  signal?: AbortSignal,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const label = redactedProxy(proxy);
    const proxyPort = proxy.port
      ? Number(proxy.port)
      : proxy.protocol === "https:"
        ? 443
        : 80;
    const proxyHost = dialHost(proxy.hostname);
    const connectTarget = `${target.host}:${target.port}`;

    let settled = false;
    // `socket` is referenced by the handlers below before its initializer runs;
    // that is safe because no handler can fire until after `connect`.
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    // An https:// proxy is itself a TLS peer: verify it against the default CA
    // store (default `rejectUnauthorized` untouched — OPP-5) before issuing the
    // CONNECT inside that session. An http:// proxy is a plain TCP hop. Either
    // way the *target* TLS session is layered on top by the caller, end to end.
    const socket: Socket =
      proxy.protocol === "https:"
        ? tlsConnect({
            host: proxyHost,
            port: proxyPort,
            // SNI only for names — RFC 6066 forbids IP literals.
            servername: isIP(proxyHost) ? undefined : proxyHost,
          })
        : netConnect({ host: proxyHost, port: proxyPort });

    // Kept attached for the socket's lifetime: after the tunnel is handed over
    // it degrades to a guard that prevents an unhandled 'error' event in the
    // window before the caller wires its own listeners.
    socket.on("error", (err: Error) => {
      fail(new Error(`Could not reach the proxy at ${label}: ${err.message}`));
    });
    socket.on("end", () => {
      fail(
        new Error(
          `The proxy at ${label} closed the connection during CONNECT to ` +
            `${connectTarget}.`,
        ),
      );
    });

    if (signal) {
      const onAbort = (): void => {
        const reason = signal.reason as { name?: string; message?: string };
        const err = new Error(reason?.message ?? "The operation was aborted.");
        // Preserve the reason's name (TimeoutError/AbortError) so the client
        // maps a tunnel-phase timeout exactly like a direct-connection one.
        err.name = reason?.name ?? "AbortError";
        fail(err);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const lines = [
      `CONNECT ${connectTarget} HTTP/1.1`,
      `Host: ${connectTarget}`,
    ];
    if (proxy.username !== "" || proxy.password !== "") {
      // OPP-6: Basic credentials from the proxy URL userinfo. The header value
      // is written to the socket only — never logged, never in any message.
      let creds: string;
      try {
        creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      } catch {
        // Malformed percent-encoding (a bare `%`) would otherwise throw out of
        // this Promise executor and leak the just-opened socket. Route it
        // through fail() — which destroys the socket — with a redacted,
        // credential-free message.
        fail(
          new Error(
            `The proxy credentials for ${label} are not valid percent-encoding; check the userinfo in the proxy URL.`,
          ),
        );
        return;
      }
      lines.push(
        `Proxy-Authorization: Basic ${Buffer.from(creds, "utf8").toString("base64")}`,
      );
    }
    // Writes are queued until the (TCP or TLS) connection is up; no need to
    // wait for the 'connect'/'secureConnect' event.
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);

    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_CONNECT_HEAD) {
          fail(
            new Error(
              `The proxy at ${label} sent an oversized CONNECT response header.`,
            ),
          );
        }
        return;
      }
      socket.removeListener("data", onData);
      const statusLine = head
        .subarray(0, end)
        .toString("latin1")
        .split("\r\n", 1)[0];
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine ?? "");
      if (!match?.[1]) {
        fail(
          new Error(`The proxy at ${label} sent a malformed CONNECT response.`),
        );
        return;
      }
      const status = Number(match[1]);
      if (status < 200 || status >= 300) {
        // OPP-7: name the (redacted) proxy and the status so a 407 is
        // immediately actionable — without ever echoing credentials.
        fail(
          new Error(
            `The proxy at ${label} refused CONNECT to ${connectTarget} with ` +
              `HTTP ${status}${status === 407 ? " (proxy authentication required)" : ""}.`,
          ),
        );
        return;
      }
      // Any bytes the proxy pipelined after its response head belong to the
      // tunneled stream — push them back for the TLS layer to consume.
      const rest = head.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      settled = true;
      resolve(socket);
    };
    socket.on("data", onData);
  });
}
