/**
 * NSFW 送件閘（2026-09-20）。Ported from the former Python server (2026-09)
 * -- same settings key, same keyword tables, same classifier prompt, same
 * fallbacks; this file is now the only implementation. The design, in short:
 *
 * * `users.nsfw_allowed` NULL / 1 = allowed (the default for everyone);
 *   only an explicit 0 routes a submission through this gate.
 * * Layer 1, rules (free, deterministic, NOT overridable by the AI): recipe
 *   `nsfw_ok`, model file names with uncensored/NSFW markers, unambiguous
 *   explicit words in POSITIVE prompts. Words with everyday meanings
 *   (`explicit`, `naked`, `breasts`…) are deliberately left to layer 2.
 *   Negative prompts are found by walking upstream from every `negative`
 *   input through conditioning-shaped nodes (at most 4 hops).
 * * Layer 2, Claude Haiku 4.5 (only when the admin stored an API key in the
 *   `nsfw_check_api_key` setting): ALLOW / DENY on the positive prompts +
 *   model names. Any failure to get a verdict is treated as ALLOW and logged
 *   -- a third-party outage must not stop the platform accepting jobs.
 *
 * The three submit routes (`POST /api/jobs`, `POST /api/recipes/:id/run`,
 * `POST /comfy/api/prompt`) all call `checkSubmission`. They pass `classify:
 * nsfwGate.classifyWithClaude` THROUGH THE MODULE NAMESPACE so the test
 * suite can `vi.spyOn(nsfwGate, "classifyWithClaude")` -- the same seam
 * `modelFetch.headSizeBytes` uses; production has nothing else to inject.
 *
 * Known, accepted parity gap: the English word-boundary regex is ASCII `\b`
 * here and Unicode-aware `\b` in Python, so `nude女` matches on this stack
 * only. Both stacks agree on every ASCII-delimited prompt.
 */

import type { Env } from "../env";
import { getSetting, getUserById } from "../db/queries";

export const NSFW_CHECK_API_KEY_KEY = "nsfw_check_api_key";
export const NSFW_NOT_ALLOWED_CODE = "nsfw_not_allowed";

export const NSFW_CHECK_MODEL = "claude-haiku-4-5";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 15_000;

export const REJECTION_MESSAGE =
  "此工作觸發 NSFW 審核，請聯絡管理員放行。" +
  " / This job was flagged by the NSFW review; contact an administrator to allow it.";

export const MODEL_NAME_KEYWORDS = [
  "nsfw",
  "uncensored",
  "heretic",
  "abliterated",
  "hentai",
  "porn",
  "nude",
  "lewd",
  "erotic",
  "xxx",
] as const;

const PROMPT_WORDS_EN = [
  "nsfw",
  "nude",
  "nudity",
  "topless",
  "porn",
  "porno",
  "pornographic",
  "hentai",
  "xxx",
  "erotic",
  "lewd",
  "genitals",
  "genitalia",
  "penis",
  "vagina",
  "nipples",
  "areola",
  "orgasm",
];
const PROMPT_WORDS_ZH = ["裸體", "全裸", "裸露", "露點", "色情", "情色", "性交", "做愛", "乳頭", "陰部", "陰莖", "自慰"];
const PROMPT_RE_EN = new RegExp(
  "\\b(?:" + PROMPT_WORDS_EN.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
  "i"
);

const PROMPT_FIELD_NAMES = new Set(["text", "prompt", "positive", "text_g", "text_l", "clip_l", "t5xxl", "conditioning_text"]);
const MODEL_EXTENSIONS = [".safetensors", ".ckpt", ".pt", ".pth", ".sft", ".gguf"];
const CONDITIONING_MARKERS = ["conditioning", "textencode", "guidance", "controlnet"];
const NEGATIVE_WALK_DEPTH = 4;

const SYSTEM_PROMPT =
  "You are a content-safety classifier for an image/video generation service. " +
  "You will be given the positive text prompts and the model file names of a generation job. " +
  "Decide whether the job is trying to produce sexually explicit, pornographic, or nude (NSFW) content. " +
  "Artistic nudity, suggestive but clothed subjects, violence without sexual content, and medical or " +
  "educational contexts are NOT NSFW for this purpose. " +
  "Reply with exactly one word: DENY if the job is NSFW, ALLOW otherwise.";

export interface Signals {
  modelNames: string[];
  positiveTexts: string[];
}

export function signalsEmpty(signals: Signals): boolean {
  return signals.modelNames.length === 0 && signals.positiveTexts.length === 0;
}

/** `users.nsfw_allowed` for `uid`; NULL (and an unknown uid) reads as allowed. */
export async function userNsfwAllowed(db: D1Database, uid: string): Promise<boolean> {
  const user = await getUserById(db, uid);
  if (user === null || user.nsfwAllowed === null) return true;
  return user.nsfwAllowed;
}

export async function readApiKey(db: D1Database): Promise<string> {
  return ((await getSetting(db, NSFW_CHECK_API_KEY_KEY)) ?? "").trim();
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function linkTarget(value: unknown): string | null {
  if (Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || typeof value[0] === "number")) {
    return String(value[0]);
  }
  return null;
}

function isModelName(value: string): boolean {
  const lowered = value.toLowerCase();
  return MODEL_EXTENSIONS.some((ext) => lowered.endsWith(ext));
}

function nodeInputs(workflow: Record<string, unknown>, nodeId: string): Record<string, unknown> | null {
  const node = workflow[nodeId];
  if (!isPlain(node) || !isPlain(node.inputs)) return null;
  return node.inputs;
}

function classType(workflow: Record<string, unknown>, nodeId: string): string {
  const node = workflow[nodeId];
  return isPlain(node) && typeof node.class_type === "string" ? node.class_type.toLowerCase() : "";
}

/** Every node reachable upstream from some node's `negative` input, walking
 * through conditioning-shaped nodes only, at most `NEGATIVE_WALK_DEPTH`
 * hops -- ports the former Python `_negative_node_ids`. */
function negativeNodeIds(workflow: Record<string, unknown>): Set<string> {
  const negative = new Set<string>();
  const queue: Array<[string, number]> = [];
  for (const node of Object.values(workflow)) {
    if (!isPlain(node) || !isPlain(node.inputs)) continue;
    const target = linkTarget(node.inputs.negative);
    if (target !== null) queue.push([target, 0]);
  }
  while (queue.length > 0) {
    const [nodeId, depth] = queue.shift()!;
    if (negative.has(nodeId)) continue;
    negative.add(nodeId);
    if (depth >= NEGATIVE_WALK_DEPTH) continue;
    const type = classType(workflow, nodeId);
    if (!CONDITIONING_MARKERS.some((marker) => type.includes(marker))) continue;
    for (const value of Object.values(nodeInputs(workflow, nodeId) ?? {})) {
      const upstream = linkTarget(value);
      if (upstream !== null) queue.push([upstream, depth + 1]);
    }
  }
  return negative;
}

/** Non-model string inputs of `nodeId` -- what a Primitive / String literal
 * node wired into a prompt field actually carries. */
function linkedStrings(workflow: Record<string, unknown>, nodeId: string): string[] {
  const out: string[] = [];
  for (const value of Object.values(nodeInputs(workflow, nodeId) ?? {})) {
    if (typeof value === "string" && value.trim() && !isModelName(value)) out.push(value.trim());
  }
  return out;
}

/** Model file names + POSITIVE prompt texts -- ports the former Python
 * `extract_signals`: a prompt field holding a LINK is followed one hop to
 * the source node's string inputs; negative sources are skipped. */
export function extractSignals(workflow: unknown): Signals {
  const signals: Signals = { modelNames: [], positiveTexts: [] };
  if (!isPlain(workflow)) return signals;

  const negativeIds = negativeNodeIds(workflow);
  const seenModels = new Set<string>();
  const seenTexts = new Set<string>();
  const addText = (text: string) => {
    if (!seenTexts.has(text)) {
      seenTexts.add(text);
      signals.positiveTexts.push(text);
    }
  };

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!isPlain(node) || !isPlain(node.inputs)) continue;
    const isTextEncoder = classType(workflow, nodeId).includes("textencode");
    const isNegative = negativeIds.has(nodeId);
    for (const [fieldName, value] of Object.entries(node.inputs)) {
      if (typeof value === "string") {
        if (isModelName(value)) {
          if (!seenModels.has(value)) {
            seenModels.add(value);
            signals.modelNames.push(value);
          }
          continue;
        }
        if (isNegative) continue;
        if ((isTextEncoder || PROMPT_FIELD_NAMES.has(fieldName)) && value.trim()) addText(value.trim());
        continue;
      }
      if (isNegative) continue;
      if (PROMPT_FIELD_NAMES.has(fieldName)) {
        const source = linkTarget(value);
        if (source !== null && !negativeIds.has(source)) {
          for (const text of linkedStrings(workflow, source)) addText(text);
        }
      }
    }
  }
  return signals;
}

/** The rule layer's reason to deny, or `null` when it has none. */
export function ruleVerdict(signals: Signals, opts: { recipeNsfwOk?: boolean } = {}): string | null {
  if (opts.recipeNsfwOk) return "recipe declares nsfw_ok";
  for (const name of signals.modelNames) {
    const lowered = name.toLowerCase();
    for (const keyword of MODEL_NAME_KEYWORDS) {
      if (lowered.includes(keyword)) return `model name matches '${keyword}'`;
    }
  }
  for (const text of signals.positiveTexts) {
    const match = PROMPT_RE_EN.exec(text);
    if (match) return `prompt matches '${match[0].toLowerCase()}'`;
    for (const word of PROMPT_WORDS_ZH) {
      if (text.includes(word)) return `prompt matches '${word}'`;
    }
  }
  return null;
}

/** The user-turn text -- byte-identical to the former Python `classifier_input`. */
export function classifierInput(signals: Signals): string {
  const lines = ["Model files:"];
  lines.push(...(signals.modelNames.length ? signals.modelNames.map((n) => `- ${n}`) : ["- (none)"]));
  lines.push("");
  lines.push("Positive prompts:");
  lines.push(...(signals.positiveTexts.length ? signals.positiveTexts.map((t) => `- ${t}`) : ["- (none)"]));
  return lines.join("\n");
}

export type ClassifyFn = (apiKey: string, signals: Signals, fetchImpl?: typeof fetch) => Promise<boolean | null>;

/** Ask Claude Haiku: `true` = deny, `false` = allow, `null` = no usable
 * verdict (network, non-200, unparseable) -- the caller treats `null` as
 * allow. `fetchImpl` exists so a unit test can hand in a fake. */
export async function classifyWithClaude(
  apiKey: string,
  signals: Signals,
  fetchImpl: typeof fetch = fetch
): Promise<boolean | null> {
  const payload = {
    model: NSFW_CHECK_MODEL,
    max_tokens: 8,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: classifierInput(signals) }],
  };
  let resp: Response;
  try {
    resp = await fetchImpl(MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.warn("nsfw_gate: classifier request failed; allowing", err);
    return null;
  }
  if (resp.status !== 200) {
    console.warn("nsfw_gate: classifier answered HTTP", resp.status, "; allowing");
    return null;
  }
  let text: string;
  try {
    const body = (await resp.json()) as { content?: Array<{ type?: string; text?: string }> };
    const block = (body.content ?? []).find((b) => b?.type === "text");
    if (!block || typeof block.text !== "string") throw new Error("no text block");
    text = block.text;
  } catch {
    console.warn("nsfw_gate: classifier response had no text block; allowing");
    return null;
  }
  const word = text.trim().toUpperCase();
  if (word.startsWith("DENY")) return true;
  if (word.startsWith("ALLOW")) return false;
  console.warn("nsfw_gate: classifier said", JSON.stringify(text), "; treating as no verdict (allowing)");
  return null;
}

/** The bilingual rejection message if `uid` may not submit `workflow`, else
 * `null`. Cheap for the common case: a user whose `nsfw_allowed` is NULL /
 * true returns before the workflow is even walked. */
export async function checkSubmission(
  env: Env,
  uid: string,
  workflow: unknown,
  opts: { recipeNsfwOk?: boolean; classify?: ClassifyFn } = {}
): Promise<string | null> {
  if (await userNsfwAllowed(env.DB, uid)) return null;

  const signals = extractSignals(workflow);
  const reason = ruleVerdict(signals, { recipeNsfwOk: opts.recipeNsfwOk });
  if (reason !== null) {
    console.info("nsfw_gate: refused submission from", uid, "(rule:", reason + ")");
    return REJECTION_MESSAGE;
  }

  if (signalsEmpty(signals)) return null;
  const apiKey = await readApiKey(env.DB);
  if (!apiKey) return null;
  const classify = opts.classify ?? classifyWithClaude;
  if ((await classify(apiKey, signals)) === true) {
    console.info("nsfw_gate: refused submission from", uid, "(classifier)");
    return REJECTION_MESSAGE;
  }
  return null;
}
