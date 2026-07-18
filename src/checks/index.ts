import type { Check } from "../types.js";
import { connectivityAuth } from "./connectivity-auth.js";
import { updateSetState } from "./update-set-state.js";
import { defaultSetLeakage } from "./default-set-leakage.js";
import { remoteSetPreview } from "./remote-set-preview.js";
import { atfEnablement } from "./atf-enablement.js";
import { atfRun } from "./atf-run.js";
import { scopedAppDeps } from "./scoped-app-deps.js";
import { i18nCompleteness } from "./i18n-completeness.js";
import { aclRoleSanity } from "./acl-role-sanity.js";
import { clientCallableAcl } from "./client-callable-acl.js";
import { restEndpointSecurity } from "./rest-endpoint-security.js";
import { scriptFieldExposure } from "./script-field-exposure.js";
import { scheduledJobRunAs } from "./scheduled-job-run-as.js";
import { mobileMenuHygiene } from "./mobile-menu-hygiene.js";

export { connectivityAuth } from "./connectivity-auth.js";
export { updateSetState } from "./update-set-state.js";
export { defaultSetLeakage } from "./default-set-leakage.js";
export { remoteSetPreview } from "./remote-set-preview.js";
export { atfEnablement } from "./atf-enablement.js";
export { atfRun } from "./atf-run.js";
export { scopedAppDeps } from "./scoped-app-deps.js";
export { i18nCompleteness } from "./i18n-completeness.js";
export { aclRoleSanity } from "./acl-role-sanity.js";
export { clientCallableAcl } from "./client-callable-acl.js";
export { restEndpointSecurity } from "./rest-endpoint-security.js";
export { scriptFieldExposure } from "./script-field-exposure.js";
export { scheduledJobRunAs } from "./scheduled-job-run-as.js";
export { mobileMenuHygiene } from "./mobile-menu-hygiene.js";
export { testDrift } from "./test-drift.js";

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

/**
 * The default set of checks run when no explicit list is supplied.
 *
 * `testDrift` is intentionally NOT here: it is a promote gate that needs a
 * second instance's manifest to compare against, and would otherwise `warn` on
 * every single-instance run. The CLI adds it only when a promote target is
 * resolved (`snpf drift`, or a `run` with a downstream target).
 */
export const defaultChecks: Check[] = [
  instanceUrlConfigured,
  connectivityAuth,
  updateSetState,
  // Update-set hygiene on top of the basic state gate: work stranded in a
  // "Default" set never ships (OPP-3), and a retrieved-but-unpreviewed or
  // collision-ridden remote set blocks the target side (OPP-4).
  defaultSetLeakage,
  remoteSetPreview,
  // Verify ATF is enabled before atf-run burns its poll budget on a runner
  // that can never start (OPP-2) — so it must sort before atfRun.
  atfEnablement,
  atfRun,
  scopedAppDeps,
  i18nCompleteness,
  aclRoleSanity,
  // ServiceNow Store certification gates — live-instance versions of the
  // recurring reviewer findings in ci/certification/CHECKLIST.md; the
  // metadata rules the text scanner (ci/certification/scan.sh) cannot cover.
  clientCallableAcl,
  restEndpointSecurity,
  scriptFieldExposure,
  scheduledJobRunAs,
  mobileMenuHygiene,
];
