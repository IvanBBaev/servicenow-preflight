/**
 * `servicenow-preflight/internal` — helpers the CLI and the bundled checks
 * share. **No semver promise:** anything here may change or disappear in any
 * release. Import from the package root or a documented subpath instead.
 *
 * @packageDocumentation
 */
export { closestNames, RULE_TITLES } from "../catalogue.js";
export { parseSeverityFlag } from "../policy.js";
export { slugify } from "../state/manifest.js";
export { tablesOf } from "../doctor.js";
export { tableOfUpdateName } from "../incremental.js";
export { namespacedEnv } from "../config.js";
