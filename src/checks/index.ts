import type { Check } from "../types.js";
import { connectivityAuth } from "./connectivity-auth.js";
import { updateSetState } from "./update-set-state.js";
import { atfRun } from "./atf-run.js";
import { scopedAppDeps } from "./scoped-app-deps.js";
import { i18nCompleteness } from "./i18n-completeness.js";
import { aclRoleSanity } from "./acl-role-sanity.js";

export { connectivityAuth } from "./connectivity-auth.js";
export { updateSetState } from "./update-set-state.js";
export { atfRun } from "./atf-run.js";
export { scopedAppDeps } from "./scoped-app-deps.js";
export { i18nCompleteness } from "./i18n-completeness.js";
export { aclRoleSanity } from "./acl-role-sanity.js";

/**
 * Verifies that a target instance URL was provided and is well-formed.
 *
 * This is a starter check that ships with the scaffold. Real checks —
 * update-set state, ATF results, scoped-app dependencies, missing
 * translations, and so on — are added alongside it and registered in
 * {@link defaultChecks}.
 */
export const instanceUrlConfigured: Check = {
  name: "instance-url-configured",
  description: "A ServiceNow instance URL is configured and well-formed.",
  run(ctx) {
    const url = ctx.instanceUrl?.trim();
    if (!url) {
      return {
        name: "instance-url-configured",
        status: "fail",
        message:
          "No instance URL provided (pass --instance or set PreflightContext.instanceUrl).",
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        name: "instance-url-configured",
        status: "fail",
        message: `Instance URL is not a valid URL: ${url}`,
      };
    }

    if (parsed.protocol !== "https:") {
      return {
        name: "instance-url-configured",
        status: "warn",
        message: `Instance URL should use https, got ${parsed.protocol.replace(":", "")}.`,
      };
    }

    return {
      name: "instance-url-configured",
      status: "pass",
      message: `Instance URL looks good: ${parsed.origin}`,
    };
  },
};

/** The default set of checks run when no explicit list is supplied. */
export const defaultChecks: Check[] = [
  instanceUrlConfigured,
  connectivityAuth,
  updateSetState,
  atfRun,
  scopedAppDeps,
  i18nCompleteness,
  aclRoleSanity,
];
