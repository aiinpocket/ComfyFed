/**
 * Bundled agent release (spec `2026-09-24-single-stack-selfhost-and-remote-
 * update.md` §2.1).
 *
 * `cloud/scripts/build-wheel.mjs` packages the Python agent into
 * `assets/agent/<wheel>` and writes `assets/agent/release.json` next to it
 * on every build. This module is the runtime half: the first time an
 * isolate needs the agent version (an agent's startup check, the Workers
 * page), it reads that manifest through the ASSETS binding and, if the
 * bundled version is newer than the published `agent_latest` setting,
 * signs `{version}|{sha256}` with the platform key and writes the five
 * `agent_*` settings `GET /api/agent/version` serves -- the same five the
 * manual `POST /api/workers/agent-release` route writes, so a hand-published
 * higher version still wins and nothing else needs to know which path
 * published.
 *
 * Idempotent and cheap: the outcome is cached per isolate (a fresh deploy
 * means fresh isolates, which is exactly when a re-check matters). Two
 * isolates racing to publish the same version write identical rows.
 */

import type { Env } from "../env";
import { getSetting, resolvePlatformSeed, setSetting } from "../db/queries";
import { signRelease } from "../lib/signing";
import { compareVersions } from "./version";

export const AGENT_VERSION_DEFAULT = "0.1.0";
export const AGENT_LATEST_KEY = "agent_latest";
export const AGENT_MIN_SUPPORTED_KEY = "agent_min_supported";
export const AGENT_WHEEL_URL_KEY = "agent_wheel_url";
export const AGENT_WHEEL_SHA256_KEY = "agent_wheel_sha256";
export const AGENT_WHEEL_SIG_KEY = "agent_wheel_sig";

/** Where build-wheel.mjs puts the manifest, relative to the assets root. */
export const RELEASE_MANIFEST_PATH = "/agent/release.json";

export interface BundledRelease {
  version: string;
  filename: string;
  sha256: string;
}

export type ReleaseLoader = (env: Env) => Promise<BundledRelease | null>;

const WHEEL_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]*\.whl$/;
const VERSION_RE = /^[0-9][A-Za-z0-9_.!+]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Shape-checks a parsed `release.json`; anything off returns null (and is
 * logged) rather than publishing a half-valid release. */
export function parseBundledRelease(raw: unknown): BundledRelease | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { version, filename, sha256 } = raw as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION_RE.test(version)) return null;
  if (typeof filename !== "string" || !WHEEL_FILENAME_RE.test(filename)) return null;
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return null;
  return { version, filename, sha256 };
}

/** Default loader: the manifest the build put under `assets/agent/`. A
 * deployment built without the wheel step (or an assets fixture without
 * one) simply has no bundled release. */
async function loadFromAssets(env: Env): Promise<BundledRelease | null> {
  let response: Response;
  try {
    response = await env.ASSETS.fetch(new Request(`https://assets.internal${RELEASE_MANIFEST_PATH}`));
  } catch (err) {
    console.warn("agent_release: ASSETS fetch failed", err);
    return null;
  }
  if (!response.ok) return null;
  // The SPA fallback answers unknown paths with index.html + 200, so a
  // missing manifest looks like HTML here -- reject anything that is not a
  // JSON object rather than trusting the status alone.
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  const release = parseBundledRelease(parsed);
  if (release === null) console.warn("agent_release: ignoring malformed release.json");
  return release;
}

let loader: ReleaseLoader = loadFromAssets;
let checked: Promise<void> | null = null;

/** Test seam: swap the manifest source and forget the per-isolate result. */
export function setBundledReleaseLoaderForTests(next: ReleaseLoader | null): void {
  loader = next ?? loadFromAssets;
  checked = null;
}

/** Publish the bundled release if it is newer than what is stored. Runs at
 * most once per isolate; concurrent callers share the same promise. Never
 * throws -- a failure here must not take `/api/agent/version` down. */
export function ensureBundledAgentRelease(env: Env): Promise<void> {
  if (checked === null) {
    checked = publishIfNewer(env).catch((err) => {
      console.error("agent_release: publish failed", err);
      // Let the next request retry rather than caching a failure for the
      // isolate's whole lifetime.
      checked = null;
    });
  }
  return checked;
}

async function publishIfNewer(env: Env): Promise<void> {
  const bundled = await loader(env);
  if (bundled === null) return;
  const stored = (await getSetting(env.DB, AGENT_LATEST_KEY)) ?? AGENT_VERSION_DEFAULT;
  if (compareVersions(bundled.version, stored) <= 0) return;

  const seed = await resolvePlatformSeed(env.DB, env.PLATFORM_ED25519_SEED);
  const { signatureHex } = await signRelease(seed, bundled.version, bundled.sha256);
  // min_supported keeps the manual route's owner policy: never ratcheted by
  // a publish, only set when nothing was ever published.
  const minSupported = (await getSetting(env.DB, AGENT_MIN_SUPPORTED_KEY)) ?? AGENT_VERSION_DEFAULT;

  await setSetting(env.DB, AGENT_LATEST_KEY, bundled.version);
  await setSetting(env.DB, AGENT_MIN_SUPPORTED_KEY, minSupported);
  await setSetting(env.DB, AGENT_WHEEL_URL_KEY, `/agent/${bundled.filename}`);
  await setSetting(env.DB, AGENT_WHEEL_SHA256_KEY, bundled.sha256);
  await setSetting(env.DB, AGENT_WHEEL_SIG_KEY, signatureHex);
  console.log(`agent_release: published bundled agent ${bundled.version} (${bundled.filename})`);
}
