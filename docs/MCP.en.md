# Driving ComfyFed from an AI client (API tokens + MCP)

[繁體中文版 →](MCP.zh.md) ｜ [Self-hosting guide](SELF-HOSTING.en.md) ｜ [back to the README](../README.en.md)

ComfyFed ships an **MCP server** (`comfyfed-mcp`) that exposes the whole federation as a tool set for an AI client (Claude Code / Claude Desktop / Cursor …). You describe what you want in plain language; the AI picks a recipe, submits the job, waits for it, and pulls the files down — no ComfyUI window, no node graph.

Authentication is an **API token**: mint it on the console's Settings page, valid for 30 days, revocable at any time. The token is equivalent to you on every API a session can use, except token management itself and change-password/logout, which stay cookie-only.

---

## 1. Install

The `mcp` package is an **optional** extra, so ask for it explicitly:

```bash
pip install "comfyfed[mcp]"
```

**If this machine is already a worker** (you ran the one-line installer), the agent lives in its own venv — install into that one instead of a second copy:

```powershell
# Windows
& "$env:LOCALAPPDATA\ComfyFed\venv\Scripts\pip.exe" install "mcp>=2.0,<3"
```

```bash
# Linux / macOS
~/.comfyfed/app/venv/bin/pip install "mcp>=2.0,<3"
```

`comfyfed-mcp` then lives in that venv (`...\ComfyFed\venv\Scripts\comfyfed-mcp.exe` on Windows, `~/.comfyfed/app/venv/bin/comfyfed-mcp` on Linux/macOS) — use that full path when you register it below.

Check the install:

```bash
comfyfed-mcp --version
```

Without the `mcp` package, `comfyfed-mcp` prints the install hint and exits **2**; incomplete settings (no token or no URL) exit **1**, so the two failures are never confused.

## 2. Get an API token

1. Log in to the console → **Settings** → the **API token / AI access** card.
2. Give it a name (e.g. `claude-code`) → **Generate**. The plaintext token (it starts with `cft_`) is shown **exactly once**.
3. Click **Download config** to get `comfyfed-mcp.json`:

   ```json
   {"platform_url": "https://your-platform.example", "token": "cft_...", "expires_at": "..."}
   ```

4. Save it as **`~/.comfyfed/mcp.json`** (`%USERPROFILE%\.comfyfed\mcp.json` on Windows). That is where `comfyfed-mcp` looks by default.

Three ways to supply the token, applied in order (later ones win):

| Source | Notes |
| --- | --- |
| `~/.comfyfed/mcp.json` | The default — just rename the downloaded file into place |
| `COMFYFED_TOKEN_FILE` | Same JSON shape at **another path** (same as `--token-file`) |
| `COMFYFED_TOKEN` | The plaintext token itself, overriding the file; pair it with `COMFYFED_PLATFORM_URL` (same as `--platform-url`) |

The **platform URL** is resolved as: `platform_url` from `mcp.json` → `COMFYFED_PLATFORM_URL` → a registered worker's **`~/.comfyfed/agent.json`** (`platforms[0].platform_url`). So on a machine that is already a worker, a token alone is enough.

On startup `comfyfed-mcp` writes one line to stderr — `comfyfed-mcp <version>: <platform url> (settings: mcp.json)`. It names the source and **never prints the token**.

## 3. Register the server

**Claude Code**:

```bash
claude mcp add comfyfed -- comfyfed-mcp
```

**Claude Desktop / Cursor** (the `mcpServers` block of their config file):

```json
{
  "mcpServers": {
    "comfyfed": {
      "command": "comfyfed-mcp"
    }
  }
}
```

If `comfyfed-mcp` is not on your PATH (e.g. it lives in the worker venv), put the full path in `command`. To point at another token file or another platform, add `"args": ["--token-file", "D:\\keys\\a.json"]` or `"args": ["--platform-url", "https://other.example"]`. The transport is **stdio** only — no SSE, no HTTP.

## 4. Recipes

A recipe is a fixed, **known-good** workflow on the platform plus a handful of parameters. The AI picks a recipe and fills parameters instead of inventing a node graph, so it cannot produce a graph no worker can run. `GET /api/recipes` (`list_recipes`) returns them in a fixed order and **the first one is the default**.

| Order | id | What it does | Parameters | `nsfw_ok` |
| --- | --- | --- | --- | --- |
| 1 | **`chroma-t2i`** (default) | Text-to-image with Chroma1-HD, an uncensored Flux-architecture checkpoint | `prompt` (required), `negative`, `width`/`height` (default 1024, 256–2048, step 16), `steps` (default 26, 1–60), `cfg` (default 3.5, 0–20), `seed` (-1 = random) | ✅ true |
| 2 | **`h3-t2v`** | Text-to-video with audio: MiniMax H3 with the 8-step turbo LoRA at 24 fps, using the uncensored heretic text encoder | `prompt` (required), `seconds` (default 5, 1–10), `width`/`height` (default 1280×704, 256–1536, step 32), `steps` (default 8, 1–20), `seed` | ✅ true |
| 3 | **`flux-t2i`** | Text-to-image with the official Flux.1-dev weights, kept for comparison | `prompt` (required), `width`/`height` (default 768), `steps` (default 8, 1–50), `guidance` (default 3.5), `seed` | ❌ false |

**`nsfw_ok` describes the weights, not a permission.** The official Flux dev weights steer away from explicit content, so `flux-t2i` is flagged false — and that is why it is not the default. The two defaults use uncensored weights. The platform enforces no policy of its own around this flag; it is your federation and your rules.

**The default recipe downloads a model on its first run.** `chroma-t2i` declares an auto-fetch source: when no live worker holds `Chroma1-HD-fp8mixed.safetensors` (**9.2 GB**, 9,193,379,316 bytes, from Comfy-Org on huggingface.co), `run_recipe` queues a model-fetch job **before** creating the image job, and the response's `model_fetch_jobs` is not empty:

```json
{"job_id": "...", "recipe_id": "chroma-t2i", "params": {...},
 "model_fetch_jobs": [{"name": "Chroma1-HD-fp8mixed.safetensors", "job_id": "...", "reused": false}]}
```

When that happens, **poll `model_fetch_status` for each entry first** — 9 GB over a home connection can take 10+ minutes — and only then `wait_for_job`. The image job is queued the whole time, not stuck: it becomes dispatchable as soon as a worker has the file and reports its inventory. Every entry from `list_recipes` also carries `missing_models`, so you can tell **in advance** whether a recipe will trigger a download.

`h3-t2v` and `flux-t2i` have no auto-fetch source (the weights are too large or gated); an admin installs those from the table in the [self-hosting guide's model downloads](SELF-HOSTING.en.md#model-downloads).

## 5. Tools and the order to use them

| Tool | What it does |
| --- | --- |
| `platform_status` | Who you are, when the token expires, which GPUs/VRAM the fleet has |
| `list_workers` | Full per-worker hardware and model counts |
| `list_recipes` | Recipes and their parameters (**first = default**), with `missing_models` |
| `run_recipe` | Submit from a recipe → `{job_id, recipe_id, params, model_fetch_jobs}` |
| `submit_workflow` | Submit a raw ComfyUI API-format workflow (only when no recipe fits) |
| `list_jobs` | Jobs, newest first; `status` accepts a comma-separated list (`queued,running`) |
| `job_status` | Full job state, including `attempt_errors`, `dispatch_info` and the receipt |
| `wait_for_job` | Poll until terminal (600 s by default); on timeout returns `{"timed_out": true, ...}` |
| `download_results` | Fetch result files locally, by default into `~/.comfyfed/results/<job_id>/` |
| `cancel_job` | Cancel a job that has not finished |
| `request_model` | Ask the fleet to download a missing model (**huggingface.co / civitai.com only**) |
| `model_fetch_status` | Progress of a model-fetch job |

The usual order:

1. `platform_status` — confirm the platform answers, the token is still valid, and workers are online.
2. `list_recipes` — pick a recipe; absent a reason to do otherwise, take the first (default) one.
3. `run_recipe` — submit.
4. If `model_fetch_jobs` came back non-empty → `model_fetch_status` until the download finishes.
5. `wait_for_job` — until `done` / `failed` / `cancelled`.
6. `download_results` — collect the files.

Reach for `submit_workflow` only when no recipe fits (custom nodes, img2img, a bespoke pipeline); it takes a **complete API-format workflow JSON**. When a model is missing, use `request_model`.

## 6. Common errors

| Message | Meaning | What to do |
| --- | --- | --- |
| `auth.required` (HTTP 401) | The token expired (30 days), was revoked, or **the password changed** (which invalidates every token) | Mint a new one on the console's Settings page and replace `~/.comfyfed/mcp.json` |
| `recipes.bad_params` (400) | A parameter's type, range or step is wrong; the message names the **first** offending parameter | Fix it against `params` from `list_recipes`; never send an undeclared parameter |
| `recipes.not_found` (404) | No such recipe id | Use an `id` from `list_recipes` rather than guessing |
| `model_fetch.no_worker` (400) | No worker can download right now (needs to be online, with `auto_fetch_models` on, agent ≥ 0.1.14, enough disk and `max_fetch_gb`) | Wait for a capable worker, or ask an admin to install the model by hand |
| `model_fetch.untrusted_url` / `gated` | The origin is not allowlisted, or the source requires a login | Use direct huggingface.co / civitai.com URLs; gated weights must be fetched manually |
| A job whose `error` reads "已在 N 台 worker 嘗試 M 次全部失敗 / failed on N workers after M attempts…" | The job was re-dispatched and every worker failed | Read `attempt_errors` from `job_status` for each worker's own last error — usually not enough VRAM, or a missing custom node |
| A job stays `queued` | No eligible worker (missing model/node, not enough VRAM), or a model is still downloading | Check `dispatch_info` from `job_status`; right after the default recipe it is usually the 9.2 GB download |

The token only ever travels in the `Authorization` header: it is never logged and never appears in a tool's return value. Revoking it in the console takes effect immediately — the next request is a 401.
