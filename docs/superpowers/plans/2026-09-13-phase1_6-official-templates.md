# Phase 1.6: Official Template Library + Missing-Model Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the official ComfyUI template library into the embedded panel (keeping ComfyFed's own category distinct), neutralize the frontend's browser-side model-download buttons (misleading on a federation), and replace them with a pre-execution guidance error listing each missing model with its official download link + our GCS backup link + worker placement path.

**Architecture:** Server-side only — the official frontend bundle is never patched. Official templates are fetched from PyPI wheels at install time into `data/comfy_templates_official/` and merged into the `/comfy/templates/` serving layer (ComfyFed category first). Served template JSONs get their `models[].url`/`hash` stripped so the frontend's Download button (a plain `<a href>` browser download — useless for a federation) never renders. Guidance moves to a POST /prompt rejection: when no online worker has a required model, the server answers with a ComfyUI-shaped error whose message carries per-model 官方載點＋備份載點＋放置路徑. The panel WS additionally sends explicit `feature_flags:false` so Manager/Asset-Browser/sign-in UI stays dormant.

**Tech Stack:** FastAPI, httpx, zipfile (wheel extraction), pytest. Frontend untouched (comfyui-frontend-package 1.52.7).

**Spec:** docs/superpowers/specs/2026-09-12-comfyfed-spec.md (Phase 1.6 addendum appended by this plan's author). Research evidence: `C:\Users\user\AppData\Local\Temp\claude\D--Joseph-ceph\20d91259-cb59-4c16-bd91-c9e40e2f6a8d\scratchpad\frontend-research.md` (frontend internals) and `...\scratchpad\official-model-links.md` (verified official URLs).

## Global Constraints

- All user-facing strings zh-TW first, matching existing tone (繁體中文、台灣用語).
- Never modify files under `data/comfy_frontend/` — the official bundle is served verbatim.
- All existing tests stay green (`python -m pytest server/tests agent/tests` — 389 passing at branch point).
- No reference to the decommissioned R2 mirror's custom domain may remain anywhere in the repo after Task 5.
- GCS backup base URL: `https://storage.googleapis.com/comfyfed-models/models/` (bucket `comfyfed-models`, project local-hardware, public objectViewer).
- Path handling: any filename derived from an archive or request must be rejected if it contains `/`, `\`, `..`, or is empty (existing convention in `templates.py` / `storage.sanitize_path_component`).
- Frontend contract facts (from research, do not re-derive): core index at `{base}/templates/index.json`, localized `index.<locale>.json` (e.g. `index.zh.json`) with automatic fallback to `index.json` on 404/non-JSON; per-template workflow `/templates/<name>.json`; thumbnails `/templates/<name>-1.<mediaSubtype>` (`-2` for compare variants); `index_logo.json` soft-fails; `/api/workflow_templates` must return `{}`; missing-model Download button renders only when a template JSON's top-level `models[]` entry has BOTH `url` and `directory`; feature flags travel over WS as `{"type":"feature_flags","data":{...}}` in both directions.

---

## The curated model source registry (used by Tasks 3 and 5)

Nine models, verified 2026-09-13. `dir` = worker-side folder under `models/`. GCS backup = `https://storage.googleapis.com/comfyfed-models/models/<dir>/<file>`.

| file | dir | size_gb | official page | direct URL | gated |
|---|---|---|---|---|---|
| flux1-dev.safetensors | diffusion_models | 22.17 | https://huggingface.co/black-forest-labs/FLUX.1-dev | https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors | YES (HF login + FLUX.1-dev 授權同意) |
| ae.safetensors | vae | 0.31 | https://huggingface.co/black-forest-labs/FLUX.1-dev | https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/ae.safetensors | YES (同上) |
| clip_l.safetensors | text_encoders | 0.23 | https://huggingface.co/comfyanonymous/flux_text_encoders | https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors | no |
| t5xxl_fp16.safetensors | text_encoders | 9.12 | https://huggingface.co/comfyanonymous/flux_text_encoders | https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors | no |
| qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors | text_encoders | 14.61 | https://huggingface.co/sakamakismile/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4 | https://huggingface.co/sakamakismile/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4/resolve/main/qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors | no |
| minimax_h3_ref2va_pruned_int8_convrot.safetensors | diffusion_models | 19.53 | https://huggingface.co/Comfy-Org/MiniMax-H3 | https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors | no |
| minimax_h3_video_vae_fp16.safetensors | vae | 4.85 | https://huggingface.co/Comfy-Org/MiniMax-H3 | https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors | no |
| minimax_h3_audio_vae_fp32.safetensors | vae | 0.56 | https://huggingface.co/Comfy-Org/MiniMax-H3 | https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors | no |
| minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors | loras | 0.91 | https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI | https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI/resolve/main/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors | no |

---

### Task 1: `fetch-comfy-templates` CLI — download the official template library from PyPI

**Files:**
- Create: `server/comfyfed_server/official_templates.py`
- Modify: `server/comfyfed_server/main.py` (add CLI subcommand, mirror the existing `fetch-comfy-ui` wiring)
- Test: `server/tests/test_official_templates.py`

**Interfaces:**
- Produces: `official_templates.fetch(data_dir: str, version: str | None = None) -> dict` — downloads + extracts, returns the manifest dict it wrote. `official_templates.official_dir(data_dir: str) -> str` = `<data_dir>/comfy_templates_official`. `official_templates.load_manifest(data_dir) -> dict | None`.
- CLI: `comfyfed-server fetch-comfy-templates [--version X] [--data-dir D]`.

Mechanism (mirror `comfy_frontend.py`'s fetch style):
1. `GET https://pypi.org/pypi/comfyui-workflow-templates/json` (or `/comfyui-workflow-templates/<version>/json`) → `info.requires_dist` lists sub-packages (`comfyui-workflow-templates-core`, `-json`, `-media-*` …) with `==` pins. Parse each `name==version`.
2. Skip `-core` (server-side loader helpers, useless to us). For `-json` and every `-media-*` package: `GET https://pypi.org/pypi/<name>/<version>/json` → pick the `bdist_wheel` URL from `urls`, download to a temp file with httpx (stream, verify the `digests.sha256` from the same PyPI response).
3. Extract with `zipfile`: every member whose path contains a `/templates/` segment is written FLAT (basename only) into `official_dir(data_dir)`. Reject any member basename that is empty or contains `/`, `\`, `..` after basename extraction (zip-slip guard: use `os.path.basename` on the member name and skip non-files). Expected payload: `index.json`, `index.<lang>.json`, `index_logo.json`, `<name>.json`, `<name>-1.<ext>`/`<name>-2.<ext>` media.
4. Write `<official_dir>/manifest.json`: `{"meta_version": ..., "packages": {name: version}, "files": <count>, "fetched_at": <iso8601>}`.
5. Idempotent: re-run wipes and re-extracts (like fetch-comfy-ui). Network failures raise with a clear message; a partial extract must not be left behind (extract into a temp sibling dir, then atomic `os.replace`/rename swap — on Windows remove the old dir first).

- [ ] **Step 1: Failing tests.** In `test_official_templates.py`, build an in-memory fixture wheel (zipfile with members `comfyui_workflow_templates_json/templates/index.json`, `.../templates/foo.json`, `.../templates/foo-1.webp`, plus a malicious member `comfyui_workflow_templates_json/templates/../evil.txt`). Mock httpx (monkeypatch `official_templates._get_json` / `_download`) to serve: meta JSON with `requires_dist: ["comfyui-workflow-templates-json==0.1.63", "comfyui-workflow-templates-core==0.3.337", "comfyui-workflow-templates-media-other==0.1.0"]`, per-package JSON with a wheel URL + sha256 of the fixture bytes, and the fixture bytes. Tests: (a) fetch() extracts index.json/foo.json/foo-1.webp flat into official_dir; (b) `evil.txt` is NOT written anywhere outside official_dir and the `..` member is skipped; (c) manifest.json written with package pins; (d) `-core` package is never downloaded; (e) sha256 mismatch raises and leaves no official_dir change; (f) re-run replaces content (stale file from previous run disappears).
- [ ] **Step 2: Run tests, verify they fail** (`python -m pytest server/tests/test_official_templates.py -x -q`).
- [ ] **Step 3: Implement `official_templates.py`** with small mockable seams `_get_json(url)` and `_download(url) -> bytes`; module docstring explaining the PyPI split-package situation (meta → -json + -media-*) and why -core is skipped.
- [ ] **Step 4: Wire the CLI subcommand in `main.py`** next to `fetch-comfy-ui`, same argument style; help text zh-TW like its sibling if siblings are zh-TW, else match existing style.
- [ ] **Step 5: Run the new tests + full suite; commit** `feat(server): fetch-comfy-templates CLI pulls official template library from PyPI`.

### Task 2: Merged template serving + models[].url stripping

**Files:**
- Modify: `server/comfyfed_server/templates.py`, `server/comfyfed_server/app.py` (router creation now takes data_dir)
- Test: `server/tests/test_templates.py` (extend existing)

**Interfaces:**
- Consumes: `official_templates.official_dir(data_dir)` from Task 1.
- Produces: `templates.create_router(data_dir: str)` (signature change; update the call in `app.py`).

Behavior of `GET /comfy/templates/{filename}` after this task:
1. `index.json`: JSONResponse of `[<ComfyFed categories from packaged templates_data/index.json>] + [<official categories from official_dir/index.json if present>]`. ComfyFed first — that is the 平台專用分類 the user wants kept distinct. If official index is absent/unparseable → serve ours alone (today's behavior, logged at debug).
2. `index.<locale>.json` (e.g. `index.zh.json`): if `official_dir/index.<locale>.json` exists → merged response = ComfyFed categories (our English/zh-TW copy as-is from packaged index.json) + official localized categories. If not → 404 (frontend falls back to `index.json` per its own logic).
3. `index_logo.json`: serve official file if present, else 404 (soft-fails client-side).
4. Any other `*.json` request: resolve packaged `templates_data/` first, then `official_dir`. Before returning a WORKFLOW json from the official dir, load it and strip `url`, `hash`, `hash_type` from every entry of a top-level `models` list (keep `name` + `directory`) — `hasDownloadMetadata` in the frontend requires `url`+`directory`, so stripping `url` removes the misleading browser-download button while the missing-model panel still lists the names. ComfyFed's own template JSONs pass through unchanged (they carry no `models` url metadata; guidance lives in their sticky notes).
5. Non-JSON files (thumbnails/media): packaged dir first, then official dir; same `_MEDIA_TYPES` mapping, still no subpaths allowed.
6. Index merging must tolerate the official index being a list of category dicts with unknown extra fields (pass them through untouched).

- [ ] **Step 1: Failing tests.** Extend `test_templates.py` with a tmp data_dir containing a fake `comfy_templates_official/` (mini index.json with one category `{"moduleName":"default","title":"Flux","templates":[{"name":"flux_dev","mediaType":"image","mediaSubtype":"webp"}]}`, a `flux_dev.json` workflow containing `"models":[{"name":"flux1-dev.safetensors","url":"https://x/y","directory":"diffusion_models","hash":"h","hash_type":"SHA256"}]`, and `flux_dev-1.webp`). Tests: (a) merged index.json = ComfyFed categories first then Flux category; (b) missing official dir → ours alone; (c) `flux_dev.json` served with url/hash/hash_type stripped, name+directory kept; (d) our own `comfyfed-wuxia-t2i.json` still served byte-identical; (e) `flux_dev-1.webp` served `image/webp`; (f) `index.zh.json` 404s without official localized file, merged when present; (g) traversal filenames still 404.
- [ ] **Step 2: Run tests, verify failure.**
- [ ] **Step 3: Implement** — `create_router(data_dir)`; keep the module docstring updated (it documents the frontend contract; add the stripping rationale: web-mode Download is a browser-side `<a href>` that lands the file on the viewer's PC, not the worker — federation guidance instead comes from the /prompt rejection of Task 3).
- [ ] **Step 4: Update `app.py`** call site.
- [ ] **Step 5: Full suite; commit** `feat(server): merge official template library into /comfy/templates, strip browser download metadata`.

### Task 3: Pre-execution missing-model guidance on POST /prompt

**Files:**
- Create: `server/comfyfed_server/model_guide.py`
- Modify: `server/comfyfed_server/comfyapi.py` (post_prompt), possibly `server/comfyfed_server/jobs.py` if a helper is needed to evaluate verdicts without creating the job
- Test: `server/tests/test_model_guide.py`, extend `server/tests/test_comfyapi.py`

**Interfaces:**
- Produces: `model_guide.SOURCES: dict[str, ModelSource]` — the 9 curated entries from the registry table above (`ModelSource` dataclass: `name, directory, size_gb, official_page, official_url, backup_url, gated: bool`). `model_guide.lookup(name: str, data_dir: str) -> ModelSource | None` — curated first (matched via `assess.matches_model_name` semantics: bare-name and category-relative both hit), then harvested. `model_guide.harvest(data_dir) -> dict[str, dict]` — scans `official_dir` template JSONs' `models[]` arrays (ORIGINAL files on disk still carry url/directory — Task 2 strips only the HTTP response) into `{name: {url, directory}}`, cached with mtime check. `model_guide.guidance_message(missing: list[str], data_dir: str) -> str` — the zh-TW multi-line message below.
- Consumes: `assess.needs_from_job` / `assess.verdict` (existing), `official_templates.official_dir`.

post_prompt change: after `assess.extract(prompt)` and BEFORE `jobs.create_job`, evaluate the model requirement against the current online-worker fleet: if at least one worker is online AND every online worker's verdict is `ineligible` with `missing_models` non-empty (i.e. the union/intersection logic: compute `blocking = set.intersection(*[set(v.missing_models) for v in ineligible verdicts])` — models NO online worker has; if every online worker is ineligible **because of missing models** and `blocking` non-empty) → return `_comfy_error("prompt.missing_models", guidance_message(sorted(blocking), data_dir))` with HTTP 400 (same shape as existing `_comfy_error` uses — the frontend surfaces `error.message` in its error dialog/toast). If NO workers online, keep today's behavior (job queues and waits). If at least one worker is eligible or only vram-blocked, keep today's behavior.

`guidance_message` format (exact copy, one block per model, joined by blank lines, header first):

```
無法執行：目前在線的 worker 都缺少以下模型。請在 worker 主機下載後放到指定資料夾，worker 會在 10 分鐘內自動掃描並回報，不需重啟。

【<name>】(<size_gb> GB)
放置路徑：models/<directory>/
官方載點：<official_url>
備份載點：<backup_url>
```

- Gated entries (flux1-dev, ae) append to the 官方載點 line: `（需登入 HuggingFace 並同意 FLUX.1-dev 授權）`.
- `(<size_gb> GB)` omitted when unknown (harvested entries). 備份載點 line omitted when no GCS backup (non-curated). For a harvested-only entry use its `url` as 官方載點 and its `directory`. For a model in neither source, the block is just 【name】＋`放置路徑：models/<資料夾依節點類型>/`＋`官方載點：請向工作流提供者取得下載來源`.

- [ ] **Step 1: Failing tests** for `model_guide`: (a) all 9 curated names resolve with correct URLs; category-relative lookup (`text_encoders/clip_l.safetensors`) resolves too; (b) harvest() reads a tmp official dir's template models arrays; (c) guidance_message renders the exact block format above for one curated gated model + one harvested + one unknown (assert exact strings — they are the product copy); (d) no reference to the decommissioned R2 mirror's custom domain anywhere in module output.
- [ ] **Step 2: Failing test in test_comfyapi.py**: with one online worker whose inventory lacks `flux1-dev.safetensors`, POST /prompt with a flux workflow → 400, body `error.type == "prompt.missing_models"`, message contains `官方載點：https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors` and `備份載點：https://storage.googleapis.com/comfyfed-models/models/diffusion_models/flux1-dev.safetensors`; with zero workers online → job still created (today's behavior); with an eligible worker → job created.
- [ ] **Step 3: Run, verify failure. Step 4: Implement. Step 5: Full suite; commit** `feat(server): reject unrunnable prompts with per-model download guidance (official + GCS backup links)`.

### Task 4: Explicit feature_flags over panel WS + /folder_paths stub

**Files:**
- Modify: `server/comfyfed_server/panelws.py` (send server flags on connect; silently consume the client's incoming `feature_flags` message), `server/comfyfed_server/comfyapi.py` (add `GET /folder_paths` stub returning `{}`)
- Test: extend `server/tests/test_panelws.py`, `server/tests/test_comfyapi.py`

On panel WS accept (right after the existing initial status send — same async-first conventions as the rest of panelws), send:
```json
{"type": "feature_flags", "data": {"assets": false, "node_replacements": false, "show_signin_button": false, "extension.manager.supports_v4": false, "extension.manager.supports_csrf_post": false}}
```
Incoming text messages of type `feature_flags` from the client are expected chatter (the frontend announces `supports_manager_v4_ui` etc. on open) — consume without logging a warning.

- [ ] **Step 1: Failing tests**: WS connect receives a feature_flags message with exactly those five keys all false; sending a client feature_flags frame does not raise/log-warn and the socket stays usable; GET /comfy/api/folder_paths → 200 `{}`.
- [ ] **Step 2–4: Verify fail, implement, full suite; commit** `feat(server): advertise explicit false feature flags to panel; stub /folder_paths`.

### Task 5: Dual-link swap — 官方載點＋GCS 備份 everywhere

**Files:**
- Modify: `server/comfyfed_server/templates_data/index.json` (each template's `models` string list stays name-only — verify, no URLs there), the three workflow JSONs `comfyfed-wuxia-t2i.json` / `comfyfed-character-portrait.json` / `comfyfed-ref2v-video.json` (the ⓪ 缺模型 MarkdownNote), `docs/` model guide page(s) that carry the decommissioned R2 mirror's links, spec addendum if it references them
- Test: extend the existing template-note test (the one that asserted mirror links) to assert the new format

In every ⓪ 缺模型 sticky note, replace each model's single decommissioned-R2-mirror link with two lines using the registry table (keep the existing note structure — model name, size, 放置路徑 — only the link lines change):
```
官方載點：<official_url>
備份載點：<backup_url>
```
flux1-dev 與 ae 的官方載點行尾加註 `（需登入 HuggingFace 並同意 FLUX.1-dev 授權）`. Keep the existing 「放好後不用重啟，worker 每 10 分鐘自動掃描」 copy unchanged.

- [ ] **Step 1: Update the test** asserting: zero occurrences of the decommissioned R2 mirror's custom domain across the repo's server/ + docs/ trees; each of the three notes contains both `官方載點：` and `備份載點：` and the correct GCS URL for its models; flux note carries the 授權 caveat.
- [ ] **Step 2–3: Verify fail, apply the swaps (JSON string editing — mind escaping), full suite; commit** `docs+templates: swap model mirror to dual official/GCS links`.

### Task 6 (controller-executed, not a subagent dispatch): Live verification

Checklist for the session controller after merge:
- Stop live server processes FIRST, then `pip install` the new wheel into `D:\ComfyFed-live\venv` (Windows file-lock lesson), run `comfyfed-server fetch-comfy-templates`, restart server + agent.
- Browser: `/comfy/` template browser shows ComfyFed category first AND official categories (Flux/video/etc. with thumbnails); our three templates unchanged.
- Open an official template that needs models we lack → missing-models panel lists names WITHOUT download buttons.
- 執行 that template → error dialog shows the zh-TW guidance with 官方＋備份 links.
- Clone our wuxia template → 執行 → still completes end-to-end (image lands, receipt signed).
- Confirm feature_flags frame in WS (devtools or server log) and no Manager/sign-in UI.
- Verify GCS links: `curl -I` a small and a large object → 200, sizes match local files.
