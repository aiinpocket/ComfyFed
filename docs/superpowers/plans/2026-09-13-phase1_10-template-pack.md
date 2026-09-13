# Phase 1.10: Template Pack (首尾幀 / 影片截段 / 圖片放大) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three more novice-usable templates: ① 首尾幀生影片 (give a first frame + last frame, H3 generates the motion between), ② 影片截段 (trim a clip: start second + length), ③ 圖片放大 (4× upscale via RealESRGAN). Every template keeps the house style: bilingual sticky notes, 紅框=至少改這裡, 缺模型 dual-link note where models are needed.

**Architecture:** Pure template JSONs + one curated model_guide entry (#11 RealESRGAN_x4plus.pth). No server code changes expected (SaveImage/SaveVideo outputs, LoadVideo/LoadImage assets all already supported).

**Tech Stack:** ComfyUI UI-format JSON authoring, pytest.

**Spec:** docs/superpowers/specs/2026-09-12-comfyfed-spec.md. Verified-live facts below are ground truth.

## Global Constraints

- Suite green: `.venv/Scripts/python.exe -m pytest tests -q` (base 662), ONE foreground run at the end; never two concurrent pytest runs on this machine.
- zh-TW-first bilingual notes matching existing template voice (study comfyfed-video-concat.json's notes).
- GCS base `https://storage.googleapis.com/comfyfed-models/models/`; the decommissioned R2 mirror domain must not reappear.
- Templates must use ONLY core nodes present on the live worker (verify class names against http://127.0.0.1:8199/object_info if in doubt — read-only GET is allowed; NEVER POST /prompt).

## Verified-live facts (ground truth — do not re-derive)

- **Trim behavior:** CreateVideo(images, fps, audio) + SaveVideo TRUNCATES audio to the video's frame span, measured live: 24 frames @ source fps from a 5s clip → 1s output with synced audio. Trimming from frame 0 keeps AV sync; a mid-video start pairs the trimmed frames with audio from 0:00 (core has NO audio-slice node) — the note must state this honestly and recommend S=0 usage or ignoring audio for mid-trims.
- **ImageFromBatch** inputs: image, batch_index (INT, default 0), length (INT 1..4096). Frame math: batch_index = 起點秒數×fps, length = 長度秒數×fps; GetVideoComponents outputs (IMAGE, AUDIO, FLOAT fps).
- **首尾幀 model stack = EXACTLY the stack of our shipped `comfyfed-ref2v-video.json`** (minimax_h3_ref2va_pruned_int8_convrot + turbo 8step lora + heretic nvfp4 encoder + both vaes — all already in model_guide.SOURCES and mirrored on GCS). The official `video_minimax_h3_multiframe_reference.json` (in D:\ComfyFed-live\data\comfy_templates_official\) shows the multiframe/first-last wiring — adapt its graph shape but keep OUR model filenames from comfyfed-ref2v-video.json (the official file references 4step lora + awq encoder we don't ship). Study both files.
- **RealESRGAN_x4plus.pth** is on the worker at models/upscale_models/ and mirrored at `https://storage.googleapis.com/comfyfed-models/models/upscale_models/RealESRGAN_x4plus.pth` (67,061,725 bytes). Upscale chain: LoadImage → UpscaleModelLoader(model_name="RealESRGAN_x4plus.pth") → ImageUpscaleWithModel(upscale_model, image) → SaveImage.

---

### Task 1: The three templates + curated entry #11

**Files:**
- Create: `server/comfyfed_server/templates_data/comfyfed-flf2v-video.json`, `comfyfed-video-trim.json`, `comfyfed-image-upscale.json` + thumbnails `comfyfed-flf2v-video-1.webp`, `comfyfed-video-trim-1.webp`, `comfyfed-image-upscale-1.webp` (INITIAL thumbnails: generate real webp images with Pillow from packaged assets — e.g. a frame of comfyfed_sample_clip.mp4 via any quick means, or amyntas_ref.png downscaled; the controller replaces them with real output shots after live verification)
- Modify: `server/comfyfed_server/templates.py` TEMPLATE_NAMES (append three), `templates_data/index.json` (ComfyFed category, after existing seven), `server/comfyfed_server/model_guide.py` (SOURCES entry #11: RealESRGAN_x4plus.pth, directory upscale_models, size_gb 0.06, official_page https://github.com/xinntao/Real-ESRGAN, official_url https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth, backup_url per GCS base, gated False)
- Test: `tests/server/test_templates.py` (MODEL_SOURCES ground-truth dict gains #11 — the test-side pin is deliberate duplication, extend BOTH), `tests/server/test_model_guide.py` (SOURCES count 10→11 + field test)

**Graphs:**
- comfyfed-flf2v-video: LoadImage(首幀, amyntas_ref.png)[紅框] + LoadImage(尾幀, amyntas_ref.png)[紅框] + PrimitiveStringMultiline prompt[紅框] wired per the official multiframe first/last pattern into the ref2v stack from comfyfed-ref2v-video.json; SaveVideo output. Notes: ⓪缺模型 dual-link note for the FIVE H3-stack models (copy the format/values from comfyfed-ref2v-video.json's note verbatim — same models), ①用途＋紅框 (換首尾兩張圖＋描述動作), ②這在做什麼, ③結果在哪.
- comfyfed-video-trim: LoadVideo(comfyfed_sample_clip.mp4)[紅框] → GetVideoComponents → ImageFromBatch(batch_index=0, length=48)[紅框-兩個數字] → CreateVideo(images, fps from components, audio from components) → SaveVideo. Notes: 秒數→幀數公式 (幀=秒×fps，範例影片 24fps), the honest audio-sync boundary from the verified facts (起點=0 聲音完美；中段截取聲音會從頭開始——核心節點目前沒有聲音裁切), 零模型 (no 缺模型 note — zero-model template, index models: []).
- comfyfed-image-upscale: LoadImage(amyntas_ref.png)[紅框] → UpscaleModelLoader → ImageUpscaleWithModel → SaveImage. Notes: ⓪缺模型 note (single model, 0.06 GB dual-link), ①換圖就好, ②4×放大, ③結果在哪.
- All three: group frames ①②③, red highlight (use the same color values existing templates use) on the user-edit nodes, MarkdownNote bilingual, index entries with tags (首尾幀: ["video","首尾幀","新手"], trim: ["video","剪輯","新手","零模型"], upscale: ["image","放大","新手"]).

**Validation before commit:** each JSON parses; link-consistency check (every link id referenced exists — reuse the checker approach from previous template tasks); widget order for LoadVideo/ImageFromBatch verified against object_info schema order. Tests: parity with existing per-template tests (parse/serve/index/strip checks driven by TEMPLATE_NAMES), model_guide #11 pinned exactly, video-trim asserted zero-model in index.

Steps: failing tests → author JSONs → thumbnails → tests green → ONE full suite run → commit `feat(templates): flf2v, video-trim, image-upscale templates + RealESRGAN curated entry`.

### Task 2 (controller-executed): live verification + real thumbnails

Reinstall live (stop server+agent first), clone & run all three from the panel end-to-end (flf2v produces motion between the two frames; trim produces the exact requested span with synced audio at S=0; upscale produces 4× dimensions), replace the three thumbnails with webp shots of real outputs, GCS HEAD check for RealESRGAN URL, commit thumbnail replacement.
