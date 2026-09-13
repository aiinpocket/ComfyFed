# Phase 1.8b: Prompt-Helper Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two templates that solve the "使用者不知道怎麼描述想要的東西" problem: (1) 圖生提示詞 — upload a reference image + a simple ask, a local VLM writes the polished English prompt; (2) 文字生提示詞 — paste a rough idea, the same model rewrites it into a structured prompt. Both results display in the panel and come back as a .txt artifact the user can copy anywhere.

**Architecture:** Uses ComfyUI core `TextGenerate` (category `text`, STRING output) with the **full Qwen3-VL-4B** encoder from Comfy-Org/Krea-2 (`qwen3vl_4b_bf16.safetensors`, 8.88GB, vision tower + BaseGenerate — verified live: image caption 6s, accurate; the MiniMax heretic nvfp4 CANNOT generate, outputs commas). Server work: text artifacts must surface in the panel — `comfyapi.job_outputs` currently maps every result file as `images`, so `.txt` results need a `text`(+`files`) mapping onto the right node ids for the frontend to render.

**Tech Stack:** FastAPI + pytest (server), ComfyUI UI-format JSON authoring (templates).

**Spec:** docs/superpowers/specs/2026-09-12-comfyfed-spec.md, Phase 1.8b addendum. Verified-live facts below are ground truth; do not re-derive.

## Global Constraints

- zh-TW-first bilingual notes matching existing template voice; suite green at every commit (`.venv/Scripts/python.exe -m pytest tests -q`, base 552; known flake tests/server/test_auth.py::test_read_session_payload_rejects_absent_and_tampered_cookies — rerun, don't chase).
- data/comfy_frontend/ untouched. No models.aiinpocket.com. GCS base `https://storage.googleapis.com/comfyfed-models/models/`.
- Verified-live TextGenerate facts (ground truth):
  - CLIPLoader widgets for the model: `["qwen3vl_4b_bf16.safetensors", "qwen_image", "default"]` (type qwen_image reaches the generic qwen3vl path: vision + generation).
  - 圖生提示詞 recipe: `use_default_template=True`, image linked, instruction text ends with ` /no_think` (suppresses Qwen3's think block).
  - 文字生提示詞 recipe: `use_default_template=False` and the FULL prompt manually wrapped as `<|im_start|>user\n{instruction}\n\n想法：{user_text} /no_think<|im_end|>\n<|im_start|>assistant\n` (with the default template on, a text-only prompt returns an EMPTY string — encoding template hits EOS immediately).
  - `TextGenerate` API-format inputs: `clip`, `prompt`, `max_length` (use 400), optional `image`, `thinking` (false), `use_default_template`, and the dynamic combo `sampling_mode: "on"` with dotted keys `sampling_mode.temperature` 0.7 / `sampling_mode.top_k` 64 / `sampling_mode.top_p` 0.95 / `sampling_mode.min_p` 0.05 / `sampling_mode.repetition_penalty` 1.05 / `sampling_mode.seed` (any int). In UI format the dynamic combo renders as widgets — mirror how the frontend serializes a DynamicCombo (widgets_values carries the nested values; study any official template using one, or express sampling params as plain widgets_values in the order the schema lists them and verify by loading in the panel during the executor's own validation).
  - `SaveText` inputs: `text`, `filename_prefix`, `format` ("txt"); its ComfyUI history output carries BOTH `text: [content]` and `files: [{filename,...}]`. `PreviewAny` input `source` (any type), history output `text: [content]`.
  - Agent already uploads `files`-keyed outputs (comfy.py collects "images","gifs","videos","files").

## Model registry addition (Tasks 1 and 2)

| file | dir | size_gb | official page | direct URL | gated |
|---|---|---|---|---|---|
| qwen3vl_4b_bf16.safetensors | text_encoders | 8.27 | https://huggingface.co/Comfy-Org/Krea-2 | https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors | no |

GCS backup: `https://storage.googleapis.com/comfyfed-models/models/text_encoders/qwen3vl_4b_bf16.safetensors` (upload already done by controller).

---

### Task 1: Surface text artifacts in the panel (server)

**Files:**
- Modify: `server/comfyfed_server/comfyapi.py` (`job_outputs`, the output-node class list near the top, and the artifact-content read), possibly `server/comfyfed_server/panelws.py` only if job_done needs no change (it calls job_outputs — verify).
- Test: `tests/server/test_comfyapi.py`

**Behavior:** `job_outputs(job)` splits `_result_files(job)` by extension:
- Non-text files (everything but `.txt`): exactly today's `images` mapping, keyed to the first *media* output node id (SaveImage/SaveVideo/etc. — the existing class list) or `FALLBACK_OUTPUT_KEY`.
- `.txt` files: mapped as `{"text": [<file content as str>], "files": [{"filename": name, "subfolder": job.id, "type": "output"}]}`. Content read from the artifact store (find how `get_job_artifact`/store reads bytes; cap at 100_000 bytes, decode utf-8 with errors="replace"; on any read failure fall back to files-only, never raise). Keyed to the workflow's `SaveText` node id; ALSO duplicate the same `{"text": [...]}` payload onto every `PreviewAny` node id in the workflow (that is the node novices look at; duplicating is how both render). Extend the output-node class list with `SaveText` (and locate PreviewAny ids separately — PreviewAny must NOT become a generic output-key candidate for media files).
- A job with both media and text files produces both mappings side by side.
- `panelws.job_done`'s executed event uses `job_outputs` (verify, no drift).

Steps: failing tests for (a) txt-only job → text+files under SaveText id + text under PreviewAny id, media absent; (b) mixed media+txt job → both mappings, media under media node id; (c) unreadable/missing txt artifact → files entry present, no text key crash; (d) 100KB cap; (e) no-SaveText workflow with txt file → FALLBACK key still carries files (frontend degrades gracefully); then implement; full suite; commit `feat(server): surface text artifacts in panel history and executed events`.

### Task 2: The two prompt-helper templates

**Files:**
- Create: `server/comfyfed_server/templates_data/comfyfed-image-to-prompt.json`, `comfyfed-text-to-prompt.json` (thumbnails `comfyfed-image-to-prompt-1.webp` / `comfyfed-text-to-prompt-1.webp` ALREADY EXIST — do not create)
- Modify: `templates.py` TEMPLATE_NAMES (append both), `templates_data/index.json` (ComfyFed category, after the five existing), `server/comfyfed_server/model_guide.py` (SOURCES entry #10 from the registry table above)
- Test: `tests/server/test_templates.py`, `tests/server/test_model_guide.py`

**comfyfed-image-to-prompt.json** graph (UI format, conventions from comfyfed-video-concat.json — groups ①②③, red-highlight editable nodes, bilingual MarkdownNotes):
- LoadImage(amyntas_ref.png) [紅框]
- PrimitiveStringMultiline [紅框] default: `請仔細觀察這張圖片，把「圖中人物」的外觀完整描述出來：長相、髮型髮色、服裝配件、姿勢、光線與整體氛圍。輸出一段英文提示詞（適合 AI 文生圖／生影片使用），只輸出提示詞本身，不要解釋。`
- StringConcatenate(string_a=instruction, string_b=" /no_think", delimiter="") — in a 「別動 / don't touch」 dim group
- CLIPLoader(qwen3vl_4b_bf16.safetensors, qwen_image, default)
- TextGenerate(clip, prompt=concat, image=LoadImage, max_length=400, sampling on per the verified numbers, thinking=false, use_default_template=TRUE)
- PreviewAny(source=text) + SaveText(text, filename_prefix="comfyfed_prompt", format="txt")

**comfyfed-text-to-prompt.json**:
- PrimitiveStringMultiline [紅框] default: `一個武俠風的女劍客站在竹林裡，有霧，很有氣氛` (the ONLY node the user must edit)
- PrimitiveStringMultiline (別動) default: `<|im_start|>user\n你是提示詞專家。把下面的想法整理成一段結構完整的英文提示詞：包含主體、外觀細節、動作、環境、光線、風格與畫質關鍵字，適合 AI 文生圖／生影片使用。只輸出英文提示詞本身，不要解釋。\n\n想法：` (real newlines in the JSON string)
- PrimitiveStringMultiline (別動) default: ` /no_think<|im_end|>\n<|im_start|>assistant\n`
- StringConcatenate(prefix, user_text, "") → StringConcatenate(that, suffix, "")
- CLIPLoader(same) + TextGenerate(prompt=chain, NO image, use_default_template=FALSE, same sampling) + PreviewAny + SaveText(filename_prefix="comfyfed_prompt")

**Notes copy (bilingual, per template)**: ⓪ 缺模型？ note in the established dual-link format for the ONE model (qwen3vl_4b_bf16, 8.27 GB, models/text_encoders/, official + 備份 links, 10-minute rescan copy); ① 用途＋紅框=至少改這裡 (image version: 換圖片＋把「圖中人物」改成你要描述的對象，例如「整個場景」「衣服的樣式」; text version: 只改想法那一格，中文英文都可以); ② 這在做什麼 (一句話：AI 讀圖/讀你的話，寫出一段英文提示詞); ③ 結果在哪＋怎麼用 (跑完後結果直接顯示在「預覽」節點裡——全選複製，貼到「武俠文生圖」等其他範本的提示詞欄再微調；也會存成 .txt 到 Console 任務頁). Index entries: `models: ["qwen3vl_4b_bf16.safetensors"]`, tags include "prompt"/"提示詞"/"新手".

**Validation before commit:** each JSON parses; link-consistency check (same script approach as the previous template task); UI-format DynamicCombo serialization for TextGenerate double-checked against the panel (the executor may load the JSON into the live panel at http://127.0.0.1:8388/comfy/ — cookies at D:\ComfyFed-live\cookies.txt — but MUST NOT execute jobs; execution verification is the controller's). Tests: parity with the zero-model template tests (parse/serve/index/link checks, TEMPLATE_NAMES-driven tests adjusted — these two have a 缺模型 note, so the note-format tests that key on MODEL_BEARING sets must now include them with the ONE-model list), model_guide SOURCES #10 asserted (URLs exact). Commit `feat(templates): image-to-prompt and text-to-prompt helper templates`.

### Task 3 (controller-executed): live verification
Reinstall live (stop server+agent first), panel-run both templates end-to-end (image→prompt result must describe the actual amyntas image; text→prompt must return a non-empty structured English prompt; text visible in panel PreviewAny node + .txt artifact in console), regression one media template, GCS link HEAD check for the new model.
