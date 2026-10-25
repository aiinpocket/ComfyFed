/**
 * Submission-time numeric validation of an API-format prompt against the
 * fleet's merged `object_info` -- the platform-side guard added after the
 * 2026-10-25 incident: a stale panel tab (frontend 1.52.7 against ComfyUI
 * 0.42.5) serialized COMFY_DYNAMICCOMBO_V3 sub-widgets in the wrong order,
 * submitting e.g. `sampling_mode.repetition_penalty = 64` (top_k's value,
 * max 5). The job then failed deterministic validation ON the worker,
 * twice, which minted a `worker_task_failures` exclusion that blocked the
 * worker from the whole batch's task_key -- one poisoned submission stalled
 * the entire queue for days. Rejecting it at submission costs one cached
 * object_info read and turns that scenario into an immediate 400 the
 * submitter can see.
 *
 * Deliberately conservative -- its job is to catch the scramble, not to
 * reimplement ComfyUI's validator:
 *
 *  * Only INT/FLOAT inputs with a declared `min`/`max` are range-checked,
 *    and only when the submitted value is a plain finite number. A link
 *    (`["206", 0]`), a string, a missing spec entry, an unknown input name,
 *    or an unknown class all pass -- a custom node the platform has never
 *    seen must not be refusable here (the worker's own ComfyUI remains the
 *    authority).
 *  * Flattened dynamic-combo keys (`sampling_mode.temperature`,
 *    `format.codec.encoding`) are resolved through the selected option at
 *    each level (the base key's submitted value picks the option whose
 *    `key` matches); any level that cannot be resolved passes.
 */

export interface InputViolation {
  nodeId: string;
  classType: string;
  inputName: string;
  received: number;
  min: number | null;
  max: number | null;
  message: string;
}

type Spec = Record<string, unknown>;

function asRecord(value: unknown): Spec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Spec) : null;
}

/** `input.required` + `input.optional` of a node def, flattened into one
 * name -> spec-tuple map. Defensive on every level: object_info is
 * worker-supplied JSON. */
function inputSpecs(def: unknown): Map<string, unknown> {
  const specs = new Map<string, unknown>();
  const input = asRecord(asRecord(def)?.input);
  if (!input) return specs;
  for (const section of ["required", "optional"]) {
    const bucket = asRecord(input[section]);
    if (!bucket) continue;
    for (const [name, spec] of Object.entries(bucket)) specs.set(name, spec);
  }
  return specs;
}

/** Nested input map of a dynamic combo's selected option, or null when
 * `spec` is not a dynamic combo / the option is unknown. */
function dynamicOptionInputs(spec: unknown, selected: unknown): Map<string, unknown> | null {
  if (!Array.isArray(spec) || typeof spec[0] !== "string" || !spec[0].startsWith("COMFY_DYNAMICCOMBO")) {
    return null;
  }
  const options = asRecord(spec[1])?.options;
  if (!Array.isArray(options)) return null;
  const option = options.find((o) => asRecord(o)?.key === selected);
  const inputs = asRecord(asRecord(option)?.inputs);
  if (!inputs) return null;
  const out = new Map<string, unknown>();
  for (const section of ["required", "optional"]) {
    const bucket = asRecord(inputs[section]);
    if (!bucket) continue;
    for (const [name, sub] of Object.entries(bucket)) out.set(name, sub);
  }
  return out;
}

/** Resolves a (possibly dotted) input name to its spec tuple, walking the
 * dynamic-combo chain by the node's own submitted selections. Returns null
 * whenever any step is unresolvable -- unresolvable means unvalidatable,
 * never invalid. */
function resolveSpec(
  specs: Map<string, unknown>,
  inputs: Spec,
  name: string
): unknown {
  if (!name.includes(".")) return specs.get(name) ?? null;
  const parts = name.split(".");
  let currentSpecs = specs;
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix === "" ? parts[i]! : `${prefix}.${parts[i]!}`;
    const baseSpec = currentSpecs.get(parts[i]!);
    const nested = dynamicOptionInputs(baseSpec, inputs[prefix]);
    if (nested === null) return null;
    currentSpecs = nested;
  }
  return currentSpecs.get(parts[parts.length - 1]!) ?? null;
}

function checkRange(spec: unknown, value: number): { min: number | null; max: number | null; bad: boolean } {
  if (!Array.isArray(spec) || (spec[0] !== "INT" && spec[0] !== "FLOAT")) {
    return { min: null, max: null, bad: false };
  }
  const config = asRecord(spec[1]);
  const min = typeof config?.min === "number" ? config.min : null;
  const max = typeof config?.max === "number" ? config.max : null;
  const bad = (min !== null && value < min) || (max !== null && value > max);
  return { min, max, bad };
}

export function validatePromptInputs(
  prompt: Record<string, unknown>,
  objectInfo: Record<string, unknown>
): InputViolation[] {
  const violations: InputViolation[] = [];
  for (const [nodeId, nodeRaw] of Object.entries(prompt)) {
    const node = asRecord(nodeRaw);
    const classType = node?.class_type;
    if (typeof classType !== "string") continue;
    const def = objectInfo[classType];
    if (def === undefined) continue;
    const inputs = asRecord(node!.inputs);
    if (!inputs) continue;
    const specs = inputSpecs(def);
    for (const [name, value] of Object.entries(inputs)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const spec = resolveSpec(specs, inputs, name);
      const { min, max, bad } = checkRange(spec, value);
      if (!bad) continue;
      const bound =
        max !== null && value > max ? `大於上限 ${max} / above max ${max}` : `小於下限 ${min} / below min ${min}`;
      violations.push({
        nodeId,
        classType,
        inputName: name,
        received: value,
        min,
        max,
        message: `${classType}.${name} = ${value} ${bound}`,
      });
    }
  }
  return violations;
}
