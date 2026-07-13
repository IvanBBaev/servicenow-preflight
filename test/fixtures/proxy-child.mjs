/**
 * Child-process harness for the SR-5 proxy tests. The default (fetch-backed)
 * transport verifies the target's certificate against the process CA store,
 * and `NODE_EXTRA_CA_CERTS` is only read at process startup — so trusting the
 * self-signed test fixtures requires a fresh process. The parent test spawns
 * this script with `NODE_EXTRA_CA_CERTS` pointing at the fixture cert and the
 * proxy environment variables under test; the script performs one Table API
 * GET against the given instance URL and prints the record as JSON.
 *
 * Usage: node proxy-child.mjs <instanceUrl>
 */
import { createSnClient } from "../../build/http/client.js";

const [instanceUrl] = process.argv.slice(2);
if (!instanceUrl) {
  process.stderr.write("Usage: node proxy-child.mjs <instanceUrl>\n");
  process.exit(2);
}

const http = createSnClient({ instanceUrl, timeoutMs: 8000 });
const rec = await http.table("incident").get("x");
process.stdout.write(JSON.stringify(rec));
