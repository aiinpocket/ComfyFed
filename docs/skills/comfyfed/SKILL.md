---
name: comfyfed
description: Generate images and videos on a ComfyFed GPU federation over MCP — install comfyfed-mcp, get an API token, pick a recipe (chroma-t2i / h3-t2v / flux-t2i), submit, wait, download the results.
---

# ComfyFed

ComfyFed runs ComfyUI jobs on a federation of shared GPU workers. The `comfyfed-mcp`
MCP server turns one platform into a tool set: pick a recipe, submit, wait, download.
User-facing versions of this page: [`docs/MCP.zh.md`](../../MCP.zh.md) (zh-TW) and
[`docs/MCP.en.md`](../../MCP.en.md).

## Install

The `mcp` package is an optional extra of the `comfyfed` distribution, so ask for it:

```bash
pip install "comfyfed[mcp]"
```

On a machine that is already a **worker**, the agent lives in its own venv — install
into that one rather than a second copy:

```powershell
# Windows: C:\Users\<you>\AppData\Local\ComfyFed\venv
& "$env:LOCALAPPDATA\ComfyFed\venv\Scripts\pip.exe" install "mcp>=2.0,<3"
```

```bash
# Linux / macOS
~/.comfyfed/app/venv/bin/pip install "mcp>=2.0,<3"
```

`comfyfed-mcp --version` confirms it. Missing `mcp` package → exit 2 with an install
hint; missing token or platform URL → exit 1 with the three ways to supply them.

## Get a token

1. Console → **Settings** → **API token / AI access** → name it → **Generate**.
   The plaintext (`cft_…`) is shown once, is valid 30 days, and is revocable.
2. **Download config** gives `comfyfed-mcp.json`
   (`{"platform_url": ..., "token": ..., "expires_at": ...}`).
3. Save it as `~/.comfyfed/mcp.json` (`%USERPROFILE%\.comfyfed\mcp.json` on Windows).

Alternatives, applied in that order (later wins): `COMFYFED_TOKEN_FILE` (same JSON at
another path, `--token-file`), `COMFYFED_TOKEN` (the plaintext itself),
`COMFYFED_PLATFORM_URL` (`--platform-url`). On a worker host the platform URL is read
automatically from the registered `~/.comfyfed/agent.json`, so a token alone is enough.

## Register the server

```bash
claude mcp add comfyfed -- comfyfed-mcp
```

Claude Desktop / Cursor config:

```json
{"mcpServers": {"comfyfed": {"command": "comfyfed-mcp"}}}
```

Use the venv's full path in `command` when `comfyfed-mcp` is not on PATH. Transport is
stdio only.

## Workflow

1. **`platform_status`** — platform reachable, token not expired, workers online.
2. **`list_recipes`** — recipes with their parameters and `missing_models`. The list is
   ordered and **the first entry is the default** — recommend it unless the user asks
   for something it cannot do.
3. **`run_recipe(recipe_id, params)`** — returns
   `{job_id, recipe_id, params, model_fetch_jobs}`. `params` is what the platform
   actually used (defaults applied, `seed: -1` replaced by a real random value).
4. **`model_fetch_status(job_id)`** — only when `model_fetch_jobs` is non-empty. The
   fleet is downloading a missing model; a 9 GB weight can take 10+ minutes, so poll
   this **before** waiting on the job. The image/video job stays queued meanwhile and
   becomes dispatchable once a worker reports the file.
5. **`wait_for_job(job_id)`** — until `done` / `failed` / `cancelled`. A
   `{"timed_out": true, ...}` result means keep waiting, not that the job died.
6. **`download_results(job_id, dest_dir=None)`** — files land in
   `~/.comfyfed/results/<job_id>/` by default; the return value has absolute paths.

`submit_workflow(workflow_json, requirements=None)` is the escape hatch: a complete
ComfyUI API-format workflow JSON, only when no recipe fits (custom nodes, img2img, a
bespoke pipeline). Nothing validates the graph for you.

`request_model(name, directory, url)` asks the fleet to fetch a missing model. Only
`huggingface.co` and `civitai.com` URLs are accepted; track it with
`model_fetch_status`. Other tools: `list_workers`, `list_jobs`, `job_status`,
`cancel_job`.

## Recipes

| Order | id | What | `nsfw_ok` |
| --- | --- | --- | --- |
| 1 | `chroma-t2i` (default) | Text-to-image, Chroma1-HD (uncensored Flux-architecture weights). `prompt` (required), `negative`, `width`/`height` (1024, step 16), `steps` (26), `cfg` (3.5), `seed` (-1 = random) | true |
| 2 | `h3-t2v` | Text-to-video with audio, MiniMax H3 + 8-step turbo LoRA at 24 fps, uncensored heretic text encoder. `prompt` (required), `seconds` (5, 1–10), `width`/`height` (1280×704, step 32), `steps` (8), `seed` | true |
| 3 | `flux-t2i` | Text-to-image, official Flux.1-dev weights, kept for comparison. `prompt` (required), `width`/`height` (768), `steps` (8), `guidance` (3.5), `seed` | false |

`nsfw_ok` states whether the weights themselves avoid explicit content — the official
Flux dev weights do, which is why `flux-t2i` is flagged false and is not the default.
It is not a permission or a policy; the platform enforces nothing on top of it.

**The default recipe fetches a 9.2 GB model on first use.** `chroma-t2i` auto-fetches
`Chroma1-HD-fp8mixed.safetensors` (9,193,379,316 bytes, from huggingface.co) when no
live worker has it — that is what a non-empty `model_fetch_jobs` means. Tell the user
the first run will take a while. `h3-t2v` and `flux-t2i` have no auto-fetch source;
their models must be installed on a worker by an admin.

## Errors

- **`auth.required` (401)** — the token expired (30 days), was revoked, or the user
  changed their password (which kills every token). Ask them to mint a new one in
  Settings and replace `~/.comfyfed/mcp.json`. Do not retry.
- **`recipes.bad_params` (400)** — a parameter's type, range or step is wrong; the
  message names the first offender. Fix it against `list_recipes`; never send a
  parameter the recipe does not declare.
- **`recipes.not_found` (404)** — use an `id` from `list_recipes`.
- **`model_fetch.no_worker` (400)** — nothing in the fleet can download right now
  (needs an online worker with `auto_fetch_models` on, agent ≥ 0.1.14, enough disk and
  `max_fetch_gb`). Report it; the model must be installed by hand.
- **`model_fetch.untrusted_url` / `model_fetch.gated`** — the origin is not allowlisted
  or the source requires a login.
- **A job whose `error` starts `已在 N 台 worker 嘗試 … / failed on N workers …`** —
  every worker it was dispatched to failed. Read `attempt_errors` from `job_status`
  for each worker's own last error (usually VRAM or a missing custom node) before
  suggesting anything.
- **A job that stays `queued`** — no eligible worker, or a model is still downloading.
  `dispatch_info` in `job_status` says which.

Never print or echo the token: it only travels in the `Authorization` header and never
appears in a tool result.
