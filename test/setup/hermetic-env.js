// Preloaded into every test process via `node --test --import` (see the
// package.json test scripts). The client honours proxy environment variables
// per request (SR-5), so a developer or CI machine that exports HTTPS_PROXY /
// NO_PROXY would otherwise leak into the suite: fetch stubs get bypassed by the
// tunnel transport, and a NO_PROXY=localhost silently cancels a test's own
// mock proxy. Scrub them once, before any test file loads; child processes
// spawned by the CLI tests inherit the cleaned environment. Tests that need a
// proxy variable set it explicitly (process.env or an injected `env`).
for (const name of [
  "SNPF_PROXY",
  "SNPF_NO_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
]) {
  delete process.env[name];
}
