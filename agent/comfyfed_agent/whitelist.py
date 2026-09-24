"""Agent-side node-class whitelist: defense in depth behind the platform's own filter."""

from __future__ import annotations

from . import comfy

# Snapshot of core/official ComfyUI node classes, used by the `official_only`
# policy. Not exhaustive of every custom node ecosystem -- that's the point.
OFFICIAL_NODE_CLASSES = frozenset(
    {
        "KSampler",
        "KSamplerAdvanced",
        "CheckpointLoaderSimple",
        "CheckpointLoader",
        "CLIPTextEncode",
        "CLIPSetLastLayer",
        "CLIPLoader",
        "DualCLIPLoader",
        "TripleCLIPLoader",
        "CLIPVisionLoader",
        "CLIPVisionEncode",
        "CLIPMergeSimple",
        "VAEDecode",
        "VAEEncode",
        "VAEDecodeTiled",
        "VAEEncodeTiled",
        "VAELoader",
        "VAEDecodeAudio",
        "VAEEncodeAudio",
        "UNETLoader",
        "ModelMergeSimple",
        "ModelSamplingDiscrete",
        "ModelSamplingFlux",
        "EmptyLatentImage",
        "EmptySD3LatentImage",
        "LoadImage",
        "LoadImageMask",
        "LoadAudio",
        "SaveImage",
        "SaveAudio",
        "SaveVideo",
        "CreateVideo",
        "PreviewImage",
        "LoraLoader",
        "LoraLoaderModelOnly",
        "ControlNetLoader",
        "ControlNetApply",
        "ControlNetApplyAdvanced",
        "ImageScale",
        "ImageScaleBy",
        "ImageInvert",
        "ImageBatch",
        "ImageCrop",
        "ImageCompositeMasked",
        "ImagePadForOutpaint",
        "ImageColorToMask",
        "ImageUpscaleWithModel",
        "UpscaleModelLoader",
        "EmptyImage",
        "LatentUpscale",
        "LatentUpscaleBy",
        "LatentComposite",
        "LatentBlend",
        "ConditioningCombine",
        "ConditioningConcat",
        "ConditioningAverage",
        "ConditioningSetArea",
        "ConditioningSetTimestepRange",
        "ConditioningZeroOut",
        "StyleModelLoader",
        "StyleModelApply",
        "SamplerCustom",
        "SamplerCustomAdvanced",
        "KSamplerSelect",
        "BasicScheduler",
        "BasicGuider",
        "DualCFGGuider",
        "CFGGuider",
        "RandomNoise",
        "DisableNoise",
        "FluxGuidance",
        "GrowMask",
        "MaskComposite",
        "MaskToImage",
        "ImageToMask",
        "SolidMask",
        "FeatherMask",
        "InpaintModelConditioning",
        "DifferentialDiffusion",
        "FreeU",
        "FreeU_V2",
        "PerpNeg",
        "PatchModelAddDownscale",
        "RescaleCFG",
        "PhotoMakerLoader",
        "PhotoMakerEncode",
    }
)


class NodeNotAllowed(Exception):
    """Raised by `check` when a workflow references a node class not in the allowed set."""

    def __init__(self, node_class: str):
        super().__init__(f"Node class not allowed: {node_class}")
        self.node_class = node_class


def allowed_classes(policy: str, comfy_url: str, custom: list, client=None) -> set:
    """Compute the set of node classes this agent will execute.

    - "installed" (default): every node class ComfyUI reports via /object_info.
    - "official_only": OFFICIAL_NODE_CLASSES intersected with installed nodes.
    - "custom": `custom` intersected with installed nodes.
    """
    installed = set(comfy.get_object_info(comfy_url, client=client).keys())

    if policy == "installed":
        return installed
    if policy == "official_only":
        return OFFICIAL_NODE_CLASSES & installed
    if policy == "custom":
        return set(custom) & installed
    raise ValueError(f"Unknown node_policy: {policy!r}")


def check(workflow: dict, allowed: set) -> None:
    """Raise `NodeNotAllowed` if any node in `workflow` has a class_type outside `allowed`."""
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        node_class = node.get("class_type")
        if node_class is not None and node_class not in allowed:
            raise NodeNotAllowed(node_class)
