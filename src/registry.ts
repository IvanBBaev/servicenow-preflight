import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { UsageError } from "./config.js";
import { isSafeIdentifier } from "./http/query.js";

/**
 * The instance registry: a static, committed description of the ServiceNow
 * instances a project targets (dev → staging → test → prod) and the order they
 * promote in. It never holds credentials — those come from the environment,
 * namespaced per instance (see {@link ResolvedInstance.envPrefix} and
 * `resolveAuthFromEnv`). Lives at `.preflight/instances.json` by default.
 */

/** Directory holding the registry and per-instance state manifests. */
export const PREFLIGHT_DIR = ".preflight";

/** Registry file name under {@link PREFLIGHT_DIR}. */
export const REGISTRY_BASENAME = "instances.json";

/** One instance in the registry. */
export interface InstanceDef {
  /** Base URL, e.g. `https://dev12345.service-now.com`. */
  url: string;
  /** Pipeline stage — free-form, conventionally `dev｜staging｜test｜prod`. */
  stage?: string;
  /**
   * Name of the instance this one promotes to (the next stage), or `null` for
   * the terminal stage. Drives the promote-gate ordering.
   */
  promotesTo?: string | null;
  /** Target scope; overrides the registry-level {@link InstanceRegistry.scope}. */
  scope?: string;
  /**
   * Credential env namespace — `SNPF_<envPrefix>_*` is consulted before the
   * unprefixed `SNPF_*`. Defaults to the instance name upper-cased.
   */
  envPrefix?: string;
}

/** The parsed `instances.json`. */
export interface InstanceRegistry {
  /** Schema version (currently `1`). */
  version: number;
  /** Default scope applied to every instance that does not override it. */
  scope?: string;
  /** Instances keyed by name (`dev`, `staging`, …). */
  instances: Record<string, InstanceDef>;
}

/** A registry entry resolved for a run: defaults applied, name attached. */
export interface ResolvedInstance {
  /** Registry key (`dev`, `staging`, …). */
  name: string;
  url: string;
  stage?: string;
  promotesTo?: string | null;
  /** Effective scope (instance override, else registry default). */
  scope?: string;
  /** Effective credential env namespace (see {@link InstanceDef.envPrefix}). */
  envPrefix: string;
}

/** Absolute path of the registry file for a working directory. */
export function registryPath(cwd: string = process.cwd()): string {
  return resolve(cwd, PREFLIGHT_DIR, REGISTRY_BASENAME);
}

/** Turn an instance name into a safe env-prefix (upper snake, non-word → `_`). */
function defaultEnvPrefix(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Validate a registry/instance name before it is used to build a filesystem
 * path or resolve a manifest (CC-14/CC-16). A name becomes the `<name>` segment
 * of `.preflight/state/<name>.state.json`, so a path separator, `..`, or
 * surrounding whitespace could escape the state directory or silently mis-target
 * another instance's file. Returns the name unchanged when valid; throws a
 * {@link UsageError} (CLI exit 2) otherwise.
 */
export function validateInstanceName(name: string, where: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new UsageError(`${where}: instance name must be a non-empty string.`);
  }
  if (name !== name.trim()) {
    throw new UsageError(
      `${where}: instance name "${name}" has leading or trailing whitespace.`,
    );
  }
  if (/[/\\]/.test(name) || name.includes("..")) {
    throw new UsageError(
      `${where}: instance name "${name}" must not contain path separators or "..".`,
    );
  }
  return name;
}

/**
 * Reject a registry/instance `scope` that would break out of a ServiceNow
 * encoded query (SR-1). A scope is interpolated into `sysparm_query` by the
 * scope resolver, so an operator character (`^`, `^OR`, `^NQ`, or the
 * percent-encoded `%5E`) could inject extra clauses. Each must be a plain
 * ServiceNow identifier (`[A-Za-z0-9_.-]`) — a scope name or 32-hex sys_id.
 * A non-string or blank scope is left for other checks; a present, unsafe one
 * throws a {@link UsageError} (CLI exit 2) at load time, ahead of the query
 * builder's own runtime guard.
 */
function assertSafeScope(scope: unknown, where: string): void {
  if (typeof scope !== "string") return;
  const trimmed = scope.trim();
  if (trimmed === "") return;
  if (!isSafeIdentifier(trimmed)) {
    throw new UsageError(
      `${where}: scope "${scope}" contains characters outside [A-Za-z0-9_.-]. ` +
        `It is interpolated into a ServiceNow encoded query, so operator ` +
        `characters (e.g. "^", "^OR", "%5E") are rejected to prevent query injection.`,
    );
  }
}

/**
 * Structural scan for duplicate keys inside any single JSON object (CC-37).
 * `JSON.parse` silently keeps the LAST of duplicate keys, so a registry with two
 * `"prod"` entries would load as one and silently drop the other instance.
 * Zero-dependency: a minimal state machine over the raw text that tracks a stack
 * of open containers (a key-set per object, a `null` marker per array) and flags
 * a key string that repeats within the same object. Only reports duplicates —
 * malformed JSON is left for `JSON.parse` to reject first.
 */
function assertNoDuplicateJsonKeys(text: string, path: string): void {
  const stack: (Set<string> | null)[] = [];
  const n = text.length;
  let i = 0;

  // Read a JSON string starting at text[i] === '"'; return [value, indexAfter].
  const readString = (): [string, number] => {
    let j = i + 1;
    let s = "";
    while (j < n) {
      const ch = text[j];
      if (ch === "\\") {
        const esc = text[j + 1];
        if (esc === "u") {
          s += String.fromCharCode(parseInt(text.slice(j + 2, j + 6), 16));
          j += 6;
        } else {
          const map: Record<string, string> = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          s += map[esc ?? ""] ?? esc ?? "";
          j += 2;
        }
      } else if (ch === '"') {
        return [s, j + 1];
      } else {
        s += ch;
        j += 1;
      }
    }
    return [s, j];
  };

  const skipWs = (j: number): number => {
    while (
      j < n &&
      (text[j] === " " ||
        text[j] === "\t" ||
        text[j] === "\n" ||
        text[j] === "\r")
    ) {
      j += 1;
    }
    return j;
  };

  while (i < n) {
    const ch = text[i];
    if (ch === "{") {
      stack.push(new Set<string>());
      i += 1;
    } else if (ch === "[") {
      stack.push(null);
      i += 1;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      i += 1;
    } else if (ch === '"') {
      const [value, next] = readString();
      // A string is an object KEY when the innermost container is an object and
      // the next non-whitespace char is ':'. Anything else (array element,
      // string value, top-level) is not a key and cannot duplicate.
      const top = stack[stack.length - 1];
      if (top && text[skipWs(next)] === ":") {
        if (top.has(value)) {
          throw new UsageError(
            `Registry ${path} has a duplicate key "${value}" in a JSON object; ` +
              `duplicate keys are ambiguous (JSON.parse silently keeps the last).`,
          );
        }
        top.add(value);
      }
      i = next;
    } else {
      i += 1;
    }
  }
}

/** Minimal structural validation; throws a clear error on a malformed file. */
function assertRegistry(value: unknown, path: string): InstanceRegistry {
  const reg = value as Partial<InstanceRegistry> | null;
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) {
    throw new UsageError(`Registry ${path} is not a JSON object.`);
  }
  // An array passes `typeof === "object"`, so reject it explicitly: `instances`
  // must be a name → instance map, and an array would surface numeric keys as
  // "instance names" (and make `--all` iterate a shape it cannot resolve).
  if (
    !reg.instances ||
    typeof reg.instances !== "object" ||
    Array.isArray(reg.instances)
  ) {
    throw new UsageError(
      `Registry ${path} has no "instances" map (must be a JSON object of name → instance).`,
    );
  }
  // Only version 1 is understood (CC-37). An unknown version means a newer
  // schema this build cannot safely interpret — refuse rather than mis-read it.
  // An ABSENT version defaults to 1 (back-compat with un-versioned registries).
  if (reg.version !== undefined && reg.version !== 1) {
    throw new UsageError(
      `Registry ${path} has unsupported version ${JSON.stringify(
        reg.version,
      )}; only version 1 is supported.`,
    );
  }
  // The registry-level default scope is interpolated into encoded queries for
  // every instance that does not override it — validate it once (SR-1).
  assertSafeScope(reg.scope, `Registry ${path}`);
  const lowered = new Map<string, string>();
  for (const [name, def] of Object.entries(reg.instances)) {
    // CC-14/CC-16: names build manifest paths — reject separators/`..`/whitespace.
    validateInstanceName(name, `Registry ${path}`);
    // CC-16: two names differing only in case would map to the same manifest
    // file on a case-insensitive filesystem (APFS/HFS+) and clobber each other.
    const lc = name.toLowerCase();
    const clash = lowered.get(lc);
    if (clash !== undefined) {
      throw new UsageError(
        `Registry ${path}: instance names "${clash}" and "${name}" differ only in ` +
          `case; on a case-insensitive filesystem (APFS/HFS+) their manifests would ` +
          `collide. Rename one so they differ beyond case.`,
      );
    }
    lowered.set(lc, name);
    if (!def || typeof def !== "object" || typeof def.url !== "string") {
      throw new UsageError(
        `Registry ${path}: instance "${name}" is missing a url.`,
      );
    }
    // A per-instance scope override is interpolated into encoded queries too
    // (SR-1) — reject operator characters at load time.
    assertSafeScope(def.scope, `Registry ${path}: instance "${name}"`);
  }
  return {
    version: reg.version ?? 1,
    scope: reg.scope,
    instances: reg.instances,
  };
}

/**
 * Load the registry from `.preflight/instances.json` (or an explicit path).
 * Returns `undefined` when the file is absent — the single-instance path stays
 * fully usable. Throws on a present-but-malformed file.
 */
export async function loadRegistry(
  cwd: string = process.cwd(),
  explicitPath?: string,
): Promise<InstanceRegistry | undefined> {
  const path = explicitPath
    ? isAbsolute(explicitPath)
      ? explicitPath
      : resolve(cwd, explicitPath)
    : registryPath(cwd);
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`Registry ${path} is not valid JSON.`);
  }
  // CC-37: JSON.parse has already collapsed duplicate keys — re-scan the raw
  // text to catch (and reject) them before they silently drop an instance.
  assertNoDuplicateJsonKeys(text, path);
  return assertRegistry(parsed, path);
}

/** Names of the instances declared in the registry (in declaration order). */
export function instanceNames(registry: InstanceRegistry): string[] {
  return Object.keys(registry.instances);
}

/**
 * Resolve one named instance from the registry, applying defaults: the scope
 * falls back to the registry default, and the env-prefix to the upper-cased
 * name. Throws (listing the known names) when `name` is not declared.
 */
export function resolveInstance(
  registry: InstanceRegistry,
  name: string,
): ResolvedInstance {
  const def = registry.instances[name];
  if (!def) {
    const known = instanceNames(registry).join(", ") || "(none)";
    throw new UsageError(
      `Unknown instance "${name}". Known instances: ${known}.`,
    );
  }
  return {
    name,
    url: def.url,
    stage: def.stage,
    promotesTo: def.promotesTo ?? null,
    scope: def.scope ?? registry.scope,
    envPrefix: def.envPrefix?.trim() || defaultEnvPrefix(name),
  };
}
