// Shared fixtures for the ATF TestStore suites.
//
// `fakeClient()` binds the `TestStoreHttpClient` port to
// `@tessera/fake-instance` and reproduces the one transport behaviour the
// store depends on: a non-2xx answer is a REJECTION carrying the genuine
// `ServiceNowError` `@tessera/sn-client` raises (DEV-1 normalisation happens
// on the store's side of the port, so the fake must not pre-normalise).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { ServiceNowError } from "@tessera/sn-client";

import {
  AUTHORING_CHANNEL_VERSION,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
} from "../build/index.js";

export const RUN_ID = "run-2026-09-23-000001";

export function makeCtx(options = {}) {
  return {
    runId: options.runId ?? RUN_ID,
    lifecycle: options.lifecycle ?? "ephemeral",
    coverageSource: "test",
    topology: {
      source: "source.service-now.com",
      runner: "dev12345.service-now.com",
      target: "dev12345.service-now.com",
    },
    signal: options.signal ?? new AbortController().signal,
    // AtfTeardownContext: the caller's assertion that no CI/CD run of the
    // suite was ever requested (the DEV-17 empty-result escape hatch).
    ...(options.neverTriggered === undefined
      ? {}
      : { neverTriggered: options.neverTriggered }),
    // AtfTeardownContext (wave 13): the ledger's recorded trigger count.
    ...("recordedTriggers" in options
      ? { recordedTriggers: options.recordedTriggers }
      : {}),
  };
}

export function spec(id, script = `gs.info("${id}");`) {
  return {
    ref: { id, path: `tests/${id}.test.ts` },
    kind: "unit",
    targets: [],
    payload: { script },
  };
}

/** The W2 version row as an installed channel leaves it. */
export function channelRow(value = AUTHORING_CHANNEL_VERSION) {
  return {
    sys_id: "7e55e0a0c0de4a5ea000000000000040",
    name: AUTHORING_CHANNEL_VERSION_PROPERTY,
    value,
  };
}

/** A fake instance with the channel installed unless `version: null`. */
export function makeInstance(options = {}) {
  const { version = AUTHORING_CHANNEL_VERSION, state = {}, ...rest } = options;
  return createFakeInstance({
    ...rest,
    state: {
      ...(version === null ? {} : { sys_properties: [channelRow(version)] }),
      ...state,
    },
  });
}

/**
 * `withTotal` (default true) forwards the fake's `X-Total-Count` as `total`,
 * exactly as `createSnTestStoreClient()` forwards sn-client's; `false`
 * models a transport that reports no count.
 */
export function fakeClient(instance, { withTotal = true } = {}) {
  const calls = [];
  return {
    calls,
    async request({ method, path: requestPath, params, body }) {
      calls.push({ method, path: requestPath, params });
      const response = await instance.handle({
        method,
        path: requestPath,
        ...(params === undefined ? {} : { params }),
        ...(body === undefined ? {} : { body }),
      });
      if (response.status < 200 || response.status > 299) {
        throw new ServiceNowError(
          `ServiceNow API error (${response.status}) on ${method} ${requestPath}`,
          response.status,
          response.body,
        );
      }
      const total = response.headers?.["x-total-count"];
      return {
        data: response.body,
        status: response.status,
        ...(withTotal && total !== undefined ? { total: Number(total) } : {}),
      };
    },
  };
}

/** A fresh lock path in a private temp dir; removed by `cleanup()`. */
export function tempLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-teststore-"));
  return {
    lockPath: path.join(dir, "ledger", "projection.lock"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export const ATF_TABLES = [
  "sys_atf_test",
  "sys_atf_step",
  "sys_variable_value",
  "sys_atf_test_suite",
  "sys_atf_test_suite_test",
];

export function rowCounts(instance) {
  return Object.fromEntries(
    ATF_TABLES.map((table) => [table, instance.tables.count(table)]),
  );
}
