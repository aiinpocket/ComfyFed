/**
 * Job output shaping for ComfyUI's `{node_id: {...}}` outputs mapping --
 * ports `server/comfyfed_server/comfyapi.py`'s `job_outputs` /
 * `_read_text_artifact` / `_merge_output` / `_node_ids_of_class` (the
 * `job_outputs`-reachable subset; `_output_node_ids`, which backs the queue
 * entry's `outputs_to_execute` slot, is Task 9's job, not this one's).
 *
 * Shared module (not do/hub.ts-private) precisely because Python's
 * `job_outputs` has two callers -- `panelws.job_done` (the WS `executed`
 * event, wired in `do/hub.ts`) and comfyapi's `GET /history` (Task 9's
 * `/api/jobs` history surface) -- and the whole point of the Python source
 * sharing one function is that a done job's outputs can never drift between
 * the two surfaces. Task 9 imports `jobOutputs` from here instead of
 * re-deriving it.
 *
 * R2 key layout for a job's stored artifacts is `artifacts/<job_id>/<filename>`
 * (see task-8-brief.md's `cloud/src/lib/store.ts` ruling); `_readTextArtifact`
 * reads from that layout via the `STORE` R2 binding, the cloud equivalent of
 * Python's `storage.get_store(data_dir).open(job_id, filename)`.
 */

const TEXT_ARTIFACT_EXT = ".txt";
const TEXT_ARTIFACT_MAX_BYTES = 100_000;

// Node classes whose id keys a history/executed entry's output. Mirrors
// comfyapi.py's `_MEDIA_OUTPUT_NODE_CLASSES` / `_TEXT_OUTPUT_NODE_CLASS` /
// `_PREVIEW_ANY_CLASS`. `SaveText` is a real output node but deliberately
// excluded from the media set -- a workflow with a SaveText node must never
// have its media files keyed under the SaveText id.
const MEDIA_OUTPUT_NODE_CLASSES = new Set(["SaveImage", "SaveVideo", "SaveAudio"]);
const TEXT_OUTPUT_NODE_CLASS = "SaveText";
const PREVIEW_ANY_CLASS = "PreviewAny";

/** Fallback output-node key when a workflow has none of the recognised
 * output node classes, so artifacts stay reachable. Ports comfyapi.py's
 * `FALLBACK_OUTPUT_KEY`. Exported: `do/hub.ts`'s `job_done` port needs it too
 * (an empty `job_outputs` result still needs ONE `executed` event, per
 * panelws.py's `job_outputs(job) or {FALLBACK_OUTPUT_KEY: {}}`). */
export const FALLBACK_OUTPUT_KEY = "comfyfed";

// `_read_text_artifact` memo cache, keyed by `${job_id}:${filename}`.
// Artifacts are immutable once a worker writes them, so a successful read
// never goes stale -- caching turns repeat panel/history reads of the same
// artifact into a single R2 read for the isolate's lifetime. Capped at
// `TEXT_ARTIFACT_CACHE_MAX`, evicting the oldest (Map insertion order,
// same FIFO semantics as Python's `OrderedDict`) -- an unbounded cache would
// let a long-lived isolate accumulate unbounded text forever. A FAILED read
// is deliberately never cached (mirrors Python): a late-arriving upload must
// still be picked up by a retry, not permanently pinned to `null`.
const TEXT_ARTIFACT_CACHE_MAX = 128;
const textArtifactCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const cached = textArtifactCache.get(key);
  if (cached === undefined) return undefined;
  // Move to end (most-recently-used), matching `OrderedDict.move_to_end`.
  textArtifactCache.delete(key);
  textArtifactCache.set(key, cached);
  return cached;
}

function cacheSet(key: string, value: string): void {
  textArtifactCache.delete(key);
  textArtifactCache.set(key, value);
  if (textArtifactCache.size > TEXT_ARTIFACT_CACHE_MAX) {
    const oldest = textArtifactCache.keys().next().value;
    if (oldest !== undefined) textArtifactCache.delete(oldest);
  }
}

/** Test-only escape hatch -- vitest doesn't tear down module-level state
 * between files, and a stale cache entry from one test could mask another
 * test's fresh R2 write under the same job/filename. */
export function clearTextArtifactCacheForTests(): void {
  textArtifactCache.clear();
}

/** Best-effort read of a `.txt` artifact's content for the panel/history
 * preview. Ports comfyapi.py's `_read_text_artifact`. Capped at
 * `TEXT_ARTIFACT_MAX_BYTES` (a generated prompt can run long, and this is a
 * preview, not a download -- the full file is still reachable via `files`).
 * Any failure (missing object, R2 error, ...) resolves to `null` so the
 * caller falls back to a files-only entry instead of ever throwing out of
 * `jobOutputs`. */
async function readTextArtifact(store: R2Bucket, jobId: string, filename: string): Promise<string | null> {
  const cacheKey = `${jobId}:${filename}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const obj = await store.get(`artifacts/${jobId}/${filename}`);
    if (obj === null) return null;
    const buf = await obj.arrayBuffer();
    const bytes = new Uint8Array(buf).slice(0, TEXT_ARTIFACT_MAX_BYTES);
    const text = new TextDecoder("utf-8").decode(bytes);
    cacheSet(cacheKey, text);
    return text;
  } catch {
    return null;
  }
}

function nodeIdsOfClass(workflow: Record<string, unknown>, classes: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (
      typeof node === "object" &&
      node !== null &&
      !Array.isArray(node) &&
      classes.has((node as Record<string, unknown>).class_type as string)
    ) {
      ids.push(nodeId);
    }
  }
  return ids.sort();
}

interface OutputPayload {
  images?: unknown[];
  files?: unknown[];
  text?: unknown[];
}

/** Adds `payload`'s lists into `result[key]`, creating or extending it --
 * ports comfyapi.py's `_merge_output`. A plain assignment would let two
 * different pieces of `jobOutputs` clobber each other when they land on the
 * same node id (notably the `FALLBACK_OUTPUT_KEY` collision between media
 * and text when a workflow has neither a media output node nor SaveText). */
function mergeOutput(result: Record<string, OutputPayload>, key: string, payload: OutputPayload): void {
  const existing: OutputPayload = result[key] ?? (result[key] = {});
  for (const [field, values] of Object.entries(payload) as [keyof OutputPayload, unknown[]][]) {
    const arr = (existing[field] ??= []) as unknown[];
    arr.push(...values);
  }
}

function parseWorkflow(workflowJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(workflowJson || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The subset of `db/queries.ts`'s `Job` this needs -- kept minimal (rather
 * than importing the whole `Job` type) so this module has no dependency on
 * `db/queries.ts`. */
export interface JobOutputsInput {
  id: string;
  workflowJson: string;
  resultFiles: unknown[];
  /** Phase 3.3 §3.7: a PARENT job's outputs are its children's files --
   * `[[childId, filename], ...]` from `split.parentOutputs`, already in
   * split_index then per-child file order. Given, it replaces `resultFiles`
   * entirely (a parent's own column is always empty) and each entry's
   * `subfolder` becomes the child that holds the bytes, so `/view` (and the
   * text-artifact read below) resolves to the right job. Resolved by the
   * CALLER rather than here so this module keeps having no dependency on
   * `db/queries.ts`; the Python twin branches inside `job_outputs` itself
   * because it already has DB access there. */
  splitOutputs?: [string, string][];
}

/** Builds the `{node_id: {...}}` mapping ComfyUI's frontend expects for a
 * job's outputs. Ports comfyapi.py's `job_outputs` exactly -- see that
 * docstring for the full split-by-extension / fallback-key / PreviewAny-
 * duplication contract; not re-explained here to avoid the two drifting.
 * Empty until the job has result files. */
export async function jobOutputs(job: JobOutputsInput, store: R2Bucket): Promise<Record<string, OutputPayload>> {
  // Entries are `[owning job id, filename]` PAIRS, not a filename list with a
  // name -> owner side table: two children of the same parent routinely
  // produce the SAME filename (every worker numbers `ComfyUI_00001_.png` from
  // its own counter), and a name-keyed map would hand both copies the last
  // child's subfolder -- i.e. serve one child's image twice.
  const entries: [string, string][] =
    job.splitOutputs !== undefined
      ? job.splitOutputs
      : job.resultFiles.filter((f): f is string => typeof f === "string").map((name) => [job.id, name]);
  if (entries.length === 0) return {};

  const isText = (name: string) => name.toLowerCase().endsWith(TEXT_ARTIFACT_EXT);
  const textEntries = entries.filter(([, name]) => isText(name));
  const mediaEntries = entries.filter(([, name]) => !isText(name));

  const workflow = parseWorkflow(job.workflowJson);
  const result: Record<string, OutputPayload> = {};

  if (mediaEntries.length > 0) {
    const mediaIds = nodeIdsOfClass(workflow, MEDIA_OUTPUT_NODE_CLASSES);
    const key = mediaIds[0] ?? FALLBACK_OUTPUT_KEY;
    mergeOutput(result, key, {
      images: mediaEntries.map(([owner, name]) => ({ filename: name, subfolder: owner, type: "output" })),
    });
  }

  if (textEntries.length > 0) {
    const texts = (
      await Promise.all(textEntries.map(([owner, name]) => readTextArtifact(store, owner, name)))
    ).filter((content): content is string => content !== null);
    const fileEntries = textEntries.map(([owner, name]) => ({
      filename: name,
      subfolder: owner,
      type: "output",
    }));

    // Only the FIRST SaveText node (sorted by id) gets a payload -- matches
    // comfyapi.py's documented (not "fixed") one-SaveText-per-workflow
    // contract.
    const saveTextIds = nodeIdsOfClass(workflow, new Set([TEXT_OUTPUT_NODE_CLASS]));
    const saveTarget = saveTextIds[0] ?? FALLBACK_OUTPUT_KEY;
    const savePayload: OutputPayload = { files: fileEntries };
    if (texts.length > 0) savePayload.text = texts;
    mergeOutput(result, saveTarget, savePayload);

    if (texts.length > 0) {
      for (const previewId of nodeIdsOfClass(workflow, new Set([PREVIEW_ANY_CLASS]))) {
        mergeOutput(result, previewId, { text: texts });
      }
    }
  }

  return result;
}
