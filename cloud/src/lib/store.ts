/**
 * R2 artifact/input-asset storage helpers, ported from
 * `server/comfyfed_server/storage.py`. Phase 1's `LocalStore` wrote to
 * `<data_dir>/artifacts/<job_id>/<filename>` and `<data_dir>/job_inputs/
 * <job_id>/<filename>` on local disk; this cloud port keeps the exact same
 * two-segment key shape against the `STORE` R2 binding instead --
 * `artifacts/<job_id>/<filename>` and `job_inputs/<job_id>/<filename>` --
 * plus a `staging/<uid>/<filename>` prefix with no equivalent in Phase 1
 * (used by Task 9/10's template-asset staging flow, not by anything in this
 * file) and a `userdata/<uid>/<relative path>` prefix for the panel's own
 * saved files (workflows, keybinding presets, node templates), the twin of
 * Python's `<data_dir>/comfy_userdata/<uid>/` tree.
 *
 * `sanitizePathComponent` matches storage.py's function of the same name in
 * every case Python actually rejects (empty, `.`/`..`, a value whose
 * basename differs from itself, Windows device names, trailing dot/space) --
 * but it is deliberately a STRICTER SUPERSET, not a byte-for-byte port: it
 * splits on both `/` and `\` unconditionally, on every platform, where
 * Python's `os.path.basename` only treats `\` as a separator on Windows (see
 * `basename`'s docstring below for why that divergence is intentional, not
 * an oversight). Every place a client-supplied name becomes an R2 key
 * segment here (artifact filename, job-input filename) must go through it,
 * exactly like the Python source's single-definition-of-"safe" contract.
 */

const ARTIFACTS_PREFIX = "artifacts";
const JOB_INPUTS_PREFIX = "job_inputs";
const STAGING_PREFIX = "staging";

const WINDOWS_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Basename-only path traversal check: `path.basename` for POSIX-style
 * separators (Workers has no `path` module, and R2 keys are always `/`-
 * separated) plus a manual backslash split, since storage.py's
 * `os.path.basename` behaves per-OS but the Python docstring is explicit
 * that a name must be valid/invalid identically on every host -- matching
 * that intent means treating BOTH `/` and `\` as separators here regardless
 * of platform, not just `/`. */
function basename(value: string): string {
  const parts = value.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

/** Reduce `value` to a single, safe path segment, or throw. Matches
 * `storage.sanitize_path_component`'s rejections, plus the stricter
 * both-separator basename split -- see this file's docstring. */
export function sanitizePathComponent(value: string, what = "path component"): string {
  const fail = (): never => {
    throw new Error(`Invalid ${what}: ${JSON.stringify(value)}`);
  };
  if (!value) fail();
  // Control characters (and DEL) are rejected before anything else, mirroring
  // storage.py's identical check: a NUL makes Python's `open()` throw deep
  // inside a route (an unhandled 500 instead of a 400), and an R2 key must
  // never carry one either. Same verdict on both stacks.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) fail();
  const base = basename(value);
  if (base !== value || base === "" || base === "." || base === "..") fail();
  const last = base[base.length - 1];
  if (last === "." || last === " ") fail();
  const stem = base.split(".", 1)[0]!.toLowerCase();
  if (WINDOWS_DEVICE_NAMES.has(stem)) fail();
  return base;
}

export class InvalidPathComponent extends Error {}

/** Same as `sanitizePathComponent` but throws `InvalidPathComponent`
 * (distinguishable from a generic `Error`) -- routes catch this specific
 * type to render the `jobs.bad_asset_name` 400, matching jobs.py's
 * `except ValueError` around the same call. */
export function sanitizePathComponentOrThrow(value: string, what = "path component"): string {
  try {
    return sanitizePathComponent(value, what);
  } catch (err) {
    throw new InvalidPathComponent(err instanceof Error ? err.message : String(err));
  }
}

export function artifactKey(jobId: string, filename: string): string {
  return `${ARTIFACTS_PREFIX}/${sanitizePathComponent(jobId, "job id")}/${sanitizePathComponent(filename, "artifact filename")}`;
}

export function jobInputKey(jobId: string, filename: string): string {
  return `${JOB_INPUTS_PREFIX}/${sanitizePathComponent(jobId, "job id")}/${sanitizePathComponent(filename, "asset filename")}`;
}

/** Reserved pseudo-uid for the packaged template sample assets (mirrors
 * `comfyapi.py`'s `SHARED_STAGING_UID`) -- namespaced alongside real
 * per-user staging keys but readable by EVERY user, since these are
 * platform-shipped public samples, not private uploads. Never collides with
 * a real `users.id` (a UUID, never starting with `_`). */
export const SHARED_STAGING_UID = "_shared";

/** Per-user staging key: `staging/<uid>/<filename>`. Final review finding
 * #1 -- the staging area used to be one flat, process-wide R2 prefix, so
 * any logged-in user could view, list, or overwrite any other user's
 * staged upload. `uid` is sanitized the same way a client-supplied
 * filename is; it always comes from an authenticated session, but defense
 * in depth costs nothing here. */
export function stagingKey(uid: string, filename: string): string {
  return `${stagingPrefix(uid)}${sanitizePathComponent(filename, "staging filename")}`;
}

/** The R2 prefix every one of `uid`'s staging objects sits under (trailing
 * slash included), for LIST -- the twin of `userdataPrefix`. Exported so
 * `routes/staging.ts`'s listing and `stagingKey`'s delete can never address
 * different namespaces if `STAGING_PREFIX` is ever renamed. */
export function stagingPrefix(uid: string): string {
  return `${STAGING_PREFIX}/${sanitizePathComponent(uid, "user id")}/`;
}

const USERDATA_PREFIX = "userdata";

/** Reduce a client-supplied RELATIVE path to a safe `/`-joined key suffix, or
 * throw `InvalidPathComponent`. Mirrors comfyapi.py's
 * `_safe_userdata_relpath`: multi-segment paths are legal
 * (`workflows/sub/x.json` -- the panel really does save into subdirectories),
 * but every segment still goes through `sanitizePathComponent`, so there is
 * exactly one definition of "safe segment" here as in the Python source.
 * Backslashes are normalized to `/` first and an absolute path is rejected
 * outright. */
export function sanitizeRelativePathOrThrow(value: string, what = "path"): string {
  const raw = (value ?? "").replace(/\\/g, "/");
  if (!raw || raw.startsWith("/")) {
    throw new InvalidPathComponent(`Invalid ${what}: ${JSON.stringify(value)}`);
  }
  // An empty segment (trailing or doubled slash), `.` and `..` are all
  // rejected by `sanitizePathComponentOrThrow`.
  return raw
    .split("/")
    .map((segment) => sanitizePathComponentOrThrow(segment, `${what} segment`))
    .join("/");
}

/** Per-user userdata key: `userdata/<uid>/<relative path>` -- the cloud twin
 * of comfyapi.py's `<data_dir>/comfy_userdata/<uid>/` tree, holding the
 * panel's own saved files (workflows, keybinding presets, node templates,
 * the bookmark index). Namespaced by uid for the same reason `stagingKey` is:
 * one user must never be able to list, read, overwrite, move or delete
 * another user's saved workflows. */
export function userdataKey(uid: string, path: string): string {
  return `${USERDATA_PREFIX}/${sanitizePathComponent(uid, "user id")}/${sanitizeRelativePathOrThrow(path, "userdata path")}`;
}

/** The R2 prefix every one of `uid`'s userdata objects sits under (trailing
 * slash included), for LIST. `subdir` may be `""` (the whole tree). */
export function userdataPrefix(uid: string, subdir = ""): string {
  const base = `${USERDATA_PREFIX}/${sanitizePathComponent(uid, "user id")}/`;
  if (!subdir) return base;
  return `${base}${sanitizeRelativePathOrThrow(subdir, "userdata dir")}/`;
}

/** Ports `LocalStore.url` -- the API path clients fetch a stored artifact
 * from (console download route). */
export function artifactUrl(jobId: string, filename: string): string {
  return `/api/jobs/${sanitizePathComponent(jobId, "job id")}/artifacts/${sanitizePathComponent(filename, "artifact filename")}`;
}

/** Store `filename`'s bytes under `job_id` in R2 -- ports `LocalStore.put`.
 * Returns the stored (sanitized) filename. */
export async function putArtifact(
  store: R2Bucket,
  jobId: string,
  filename: string,
  body: ReadableStream | ArrayBuffer | ArrayBufferView | Blob
): Promise<string> {
  const name = sanitizePathComponent(filename, "artifact filename");
  await store.put(artifactKey(jobId, name), body);
  return name;
}
