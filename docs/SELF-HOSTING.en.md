# ComfyFed Self-Hosting Guide (Technical Appendix)

[繁體中文版 →](SELF-HOSTING.zh.md) | [Back to the general README](../README.md)

This is the technical reference for people who will actually run the server, edit config files, and care about API details. If you just want to know what ComfyFed is and what you can do with it, read the root [README.md](../README.md) first.

### What it is

ComfyFed is a **distributed ComfyUI rendering federation** built for a trusted circle of people: one server (the platform) coordinates multiple workers (agents), so friends can share GPU compute for each other's ComfyUI workflows without running a public service or trusting a stranger's node.

- End-to-end Ed25519 signed protocol: worker registration, every API call, and WebSocket connections are all signed and replay-protected
- Automatic job assessment: the server compares a workflow's required nodes/models/VRAM against each worker's live state and rules `eligible` / `eligible_after_fetch` / `ineligible`
- Dual-signed receipts: every completed job is signed by both the worker and the platform, forming an auditable contribution record
- Bilingual (繁中 / English) web console: Dashboard, Workers, Jobs, Reports, Settings
- Prometheus `/metrics` endpoint for Grafana-style monitoring
- Signed, verified auto-update for the agent

### Quick start

Requires Python 3.12+.

```bash
# from the repo root (no PyPI package yet; one is planned)
pip install -e .
```

**First-time server install** (interactive wizard: pick a language, enter the public URL, and get a one-time random admin password):

```bash
comfyfed-server install
```

The password is printed once at install time — save it immediately. The database and keys live under `./data` by default (override with `--data-dir`). Non-interactive install is also supported:

```bash
comfyfed-server install --non-interactive --lang en --url https://your-domain.example
```

**Run the server**:

```bash
comfyfed-server run --host 0.0.0.0 --port 8388
```

(`--host` defaults to `0.0.0.0`, `--port` to `8388`, `--data-dir` to `./data`)

**Build the web console** (Vite + React + Mantine):

```bash
cd web
npm install
npm run build
```

Don't want to self-host? There's a Cloudflare version too: see [`cloud/README.md`](../cloud/README.md) — the same federation protocol running on Cloudflare's free tier, no machine of your own to keep powered on.

### Network: DDNS or a fixed IP both work

The server just needs one address everyone can reach — a dynamic DNS hostname or a fixed IP both work fine. That address is the `platform_url` you enter during install, and it's the same value baked into every worker's registration bundle.

Workers (agents) only ever make **outbound** connections to the platform — no inbound port needs to be opened, so agents behind NAT/firewalls work without any configuration.

If you're exposing the server over HTTPS, put a reverse proxy in front for TLS and forward to the internal port `comfyfed-server` listens on (e.g. 8388).

**Caddy** (automatic HTTPS, two lines):

```
your-domain.example {
    reverse_proxy 127.0.0.1:8388
}
```

**nginx** (equivalent):

```nginx
server {
    listen 443 ssl;
    server_name your-domain.example;
    location / {
        proxy_pass http://127.0.0.1:8388;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

(The agent uses a long-lived WebSocket connection, so make sure the proxy forwards the `Upgrade`/`Connection` headers.)

### Adding a worker

1. In the console, go to **Workers** → add, name it, and the platform generates a one-time registration bundle (`bundle.json`) — download it.
2. On the machine that will contribute compute:

```bash
pip install -e .
comfyfed-agent register bundle.json
comfyfed-agent run
```

`register` exchanges the bundle's one-time token for a real certificate from the platform and writes the config to `~/.comfyfed/agent.json`; `run` connects to every registered platform and starts processing jobs.

That machine needs a local ComfyUI running (defaults to `http://127.0.0.1:8188`); if yours runs elsewhere, set `comfy_url` in `agent.json`.

**Stopping an agent**: press `Ctrl-C` in its terminal (`CTRL_BREAK` works too on Windows) for a graceful shutdown — the agent asks ComfyUI to interrupt whatever it's running, cleans up its own temp files, and only exits once that wind-down is confirmed, instead of leaving a half-finished job or stray files behind.

### Job dispatch: light jobs go to weak GPUs first

Dispatch isn't a random pick among eligible workers: jobs that need zero models (pure post-processing work like video trimming or concatenation) are preferentially routed to workers with no dedicated GPU or weaker VRAM (Mac/CPU-only machines included), saving the model-heavy, VRAM-hungry rendering jobs for the real GPUs. That means a laptop can pull its weight in the federation instead of a 4090 getting stuck doing video-editing busywork.

### Security model summary

- **One-time registration token**: each bundle issued by the console can be used exactly once (the server claims it atomically, so two concurrent registrations can't both win).
- **Mutual key pinning**: on first registration, the agent pins the platform's Ed25519 public key locally; the certificate the platform issues back is likewise bound to that worker's public key — after that, identity checks no longer depend on the token.
- **Signed requests + replay protection**: every API call carries `X-Ts` (timestamp), `X-Nonce`, and an Ed25519 signature; the server rejects requests whose timestamp is off by more than ±120 seconds and rejects any nonce it has already seen.
- **WebSocket challenge**: when an agent opens its long-lived connection, the server sends a random nonce that the agent must sign back with its own key to complete the handshake.
- **Dual-signed receipts**: on job completion, both the worker and the platform sign the receipt, so neither side can fabricate a contribution record alone.
- **No hardcoded default credentials**: the admin password is randomly generated at `install` time and shown exactly once — there is no built-in account.

### Node whitelist

Each worker sets `node_policy` in `agent.json`:

- `installed` (default): allow every node class the local ComfyUI has installed.
- `official_only`: allow only official ComfyUI core nodes (intersected with what's actually installed).
- `custom`: allow only a configured list (`whitelist_extra`, intersected with what's installed).

This exists because **a workflow is executable content** — a malicious or poorly-written custom node can run arbitrary code on the worker's machine. This whitelist is local, defense-in-depth (checked before the agent executes anything); the server independently checks node requirements for dispatch decisions, as a second, separate layer.

### Artifact hash verification

Every artifact a worker uploads carries its sha256 (`X-Artifact-SHA256`); the server recomputes the hash itself over the bytes it received and compares. A mismatch rejects the whole upload (`artifact.hash_mismatch`), the agent retries once automatically, and if it still doesn't match the job is marked failed rather than letting a corrupted or swapped file quietly land in storage. A verified hash is stored in the job's `result_hashes` and is visible via `GET /api/jobs/{id}`.

### Disk cleanup

After every job — success or failure — the worker discards whatever it staged for that job in its own memory/temp state. What actually accumulates on disk over time is local ComfyUI's own `input`/`output` directories: every job's reference assets get copied into `input`, and every render lands in `output`. Left alone, that fills the worker's disk.

To have the agent clean those up too, set in `agent.json`:

```json
{
  "comfy_output_dir": "D:/ComfyUI/output",
  "comfy_input_dir": "D:/ComfyUI/input"
}
```

With these set, the agent deletes a job's files ONLY once that job succeeded AND its artifact hashes were confirmed by the platform (reconstructing each output's path from the filename/subfolder ComfyUI's history reported, and refusing to touch anything outside the configured directories). Leave them unset and the agent skips this step entirely — it never guesses where ComfyUI's folders are. A failed job's ComfyUI-side outputs are always left in place so you can inspect what happened.

### Auto-fetch models (optional)

The platform can dispatch a job together with the models it needs that this worker is missing, and the agent downloads them itself before running the job instead of the job simply being ruled `ineligible`. **Off by default** — opt in via `agent.json`:

```json
{
  "auto_fetch_models": true,
  "max_fetch_gb": 30,
  "hash_models": true
}
```

- `auto_fetch_models` (default `false`): while off, this worker is never dispatched a job carrying `fetch_models` — identical to pre-2.1 behavior.
- `max_fetch_gb` (default `30`): the most this worker will download for a single job, in GB. Over budget or insufficient free disk both refuse the whole batch up front — never a half-downloaded failure.
- `hash_models` (default `true`): turning this off stops the agent from scanning/hashing local models at all, which also means the server can never learn this worker's models well enough to offer them to others — and, as a side effect, this worker can no longer auto-fetch models either.

**Trust model**: the platform Ed25519-signs the fetch manifest; the agent verifies that signature before downloading anything, then verifies each file's sha256 after it lands. Both checks must pass before the file is moved into place under `models_dir`'s matching subfolder — a bad signature or hash mismatch rejects the whole batch, leaving no partial files behind. Downloads always land under `models_dir`; the agent sanitizes every path so a manifest entry can never write outside it.

Download progress shows on the job's card in the console (`stage: "fetching_models"` plus a percentage and the current filename). Once a download completes, the model isn't recorded as "this worker has it" until the next periodic local scan (up to 10 minutes later) reports its hash to the server.

**A hash conflict is permanent and needs manual recovery**: if two workers report different sha256 values for the same name/size (usually a corrupted or swapped file on one of them), the server logs a `model_manifest: sha256 conflict for ...` WARNING and marks that `model_hashes` row as conflicted (`conflict = 1`), permanently excluding it from the fetch manifest from then on — it does **not** self-heal on restart or on a later, correct report. Once you've confirmed which copy is right, an admin has to fix it directly in the database:

```sql
UPDATE model_hashes SET conflict = 0 WHERE name = '...' AND size_bytes = ...;
```

There's no admin-UI conflict-resolution button this phase — this manual query is the only recovery path.

### Job assessment

When a job arrives, the server automatically extracts the node classes, model files, and (when known) VRAM needs from the workflow, and rules on each candidate worker:

- `eligible`: the worker already has every required node and model — dispatch directly.
- `eligible_after_fetch`: models missing on this worker are available from another worker in the federation (actual transfer lands in Phase 2), and there's enough free disk to hold them.
- `ineligible`: with plain-language reasons, e.g. missing node classes, insufficient VRAM, or missing models that no one else in the federation has either.

### Embedded workflow editor (`/comfy`)

You don't need your own ComfyUI to build a workflow: the platform can serve the **official ComfyUI frontend** at `/comfy`. Wire up your graph in the browser, press Queue, and the job goes straight into the federation's queue — the results come back in the same interface.

The static bundle is not installed with the package (it's ~24 MB of JavaScript that an API-only deployment never touches), so fetch it once:

```bash
comfyfed-server fetch-comfy-ui --data-dir ./data
```

That downloads the `comfyui-frontend-package` wheel from PyPI — **both the version and its sha256 are pinned in the source**, and the digest is verified before anything is extracted — and unpacks its `static/` tree into `<data-dir>/comfy_frontend/`. Already fetched: it's a no-op. **Restart the server** afterwards so `/comfy` gets mounted.

- `--version X` fetches a different release, but then the sha256 check is **skipped** and compatibility with this platform's `/comfy/api` is not guaranteed (the command warns about both).
- Until you fetch it, `/comfy` serves a bilingual notice page telling you to run the command above.
- `/comfy` and all of its assets require an **admin session**; without one you are redirected to `/` (the console login).

**Then fetch the official template library** (optional, but recommended): the frontend wheel is just the UI — it does not carry ComfyUI's official starter workflows. One more command:

```bash
comfyfed-server fetch-comfy-templates --data-dir ./data
```

That reads the `comfyui-workflow-templates` meta package's dependencies on PyPI, downloads the matching `-json` and `-media-*` sub-package wheels (each verified against the sha256 PyPI itself reports before anything is extracted) and flattens their `templates/` trees into `<data-dir>/comfy_templates_official/`. Budget roughly **475 MB** of download for ~105 MB on disk, and a few minutes.

- `--version X` fetches a specific release; the default is the newest on PyPI.
- **Restart the server** afterwards — the library is picked up at startup. The template browser's sidebar then lists ComfyFed's own categories first and the official ones after them.
- Skipping this breaks nothing: the browser still opens, it just contains only ComfyFed's own built-in templates.
- Official template JSONs have their **model download URLs and hashes stripped** before they reach the browser. Those "Download" buttons fetch to the machine running the browser, which on a stock ComfyUI is the machine running the graph and here is **your laptop** — useless to the federation. When a model really is missing, pressing Run is refused with zh-TW guidance naming the file and the worker folder it belongs in.

Once it's there, log into the console, go to **Jobs**, and hit the primary **Open workflow editor** button — it opens in a new tab. The old paste-the-API-JSON form is still on that page, tucked into the "Paste API JSON instead" section.

⚠ **Nodes only appear when at least one worker is online.** The node catalogue is not something the platform invents: by default it is the union of the `/object_info` snapshots reported by every **online, enabled** worker. With the whole fleet offline the node panel is empty — that's expected, not a bug.

The Settings page can switch `object_info_mode` from the default union to **intersection**: in intersection mode the editor only shows nodes that **every online worker** has, so anything in the dropdown is guaranteed dispatchable everywhere, at the cost of fewer available nodes. Union mode offers a richer node set but a graph mixing nodes unique to different machines can still fail to dispatch (see next point).

⚠ **In union mode, that catalogue does not describe any single worker.** Nodes visible in the editor may live on different machines. A graph mixing a node only worker A has with one only worker B has **submits fine** — the job is created and queued — but it is ineligible for every worker individually, so it simply **sits in the queue forever** with no error. The Jobs page's ineligibility reasons explain what is missing. `/comfy/api/object_info` returns an `X-ComfyFed-Worker-Count` header saying how many workers the listing came from (in intersection mode, how many workers all agree on it).

**Cancel/Interrupt, Clear queue, and deleting history entries all work for real.** These toolbar buttons in the editor have a real backend behind them now: clicking them actually cancels the underlying federation job (the worker gets an interrupt notification too) — it's no longer a read-only queue/history layer. The one thing to know: **these panel controls only affect jobs submitted from the panel itself** (`origin == panel`). If you submitted via the console's "Paste API JSON" form instead, cancel it from the console's Jobs page. Conversely, **the console's Jobs page and its job-detail page can cancel a job from either origin** — it's the one cancel surface that covers everything.

The compatibility layer now covers "build a graph → queue it → see the results → cancel/clean up" as its main line. Editor features that assume a single local ComfyUI still do not work — **saving workflows to the server, Manager / custom-node extensions, and model browsing** (models live on the workers; the platform has none). Export/import workflows through the browser instead, or paste the API JSON into the console. Editor UI preferences (theme and so on) persist to `<data-dir>/comfy_settings.json`. The template browser *does* work: out of the box it is stocked with ComfyFed's own templates, and once you have run `fetch-comfy-templates` ComfyUI's upstream gallery is merged into the same sidebar.

**How this relates to bringing your own ComfyUI**: they are two doors into the same federation, not alternatives. The embedded editor is for "I don't have ComfyUI here, or don't feel like launching it". If you already run ComfyUI locally, keep building there, export with "Save (API format)", and paste it into the console. Either way the actual rendering happens on federation workers — each member's own ComfyUI. The platform itself never installs ComfyUI and never runs inference; `/comfy` is only a compatibility layer that translates the official frontend's actions into federation jobs.

### Templates

ComfyFed ships ten **production-proven** workflows, each annotated on the canvas with sticky notes — in Traditional Chinese and English — explaining what every stage does and which node you are supposed to edit. The user-facing rundown of what each one is for lives in the root [README.md](../README.md); this section covers the operational details.

**Opening the browser**: the **Browse Templates** entry in the editor's left toolbar (also under Workflow → Browse Templates, and on the empty-canvas screen) → pick the **ComfyFed** category in the sidebar → click a thumbnail. That **clones** the template into a new untitled workflow; you edit the copy, the template itself is never touched, so if you break it, close it and take a fresh one.

Ten templates (backed by `server/comfyfed_server/templates_data/index.json`):

| Template | What it is | Size / steps |
| --- | --- | --- |
| **Wuxia text-to-image** | Flux text-to-image — the exact graph (and prompt) of ComfyFed's first end-to-end federation run | 768×768, 8 steps |
| **Character portrait** | The same Flux pipeline in portrait orientation, for single-character reference sheets | 896×1152, 20 steps |
| **Reference to video** | MiniMax H3 Ref2V: one reference photo → a clip of the same person moving, with generated audio | 1152×640, 141 frames (~6s), 8 steps via the turbo LoRA |
| **First+last frame to video** | Give MiniMax H3 a first frame, a last frame, and one line describing the motion; it fills in the movement and audio between them | 8 steps via the turbo LoRA |
| **Video concat** | Join two clips end-to-end, picture and audio both. Zero models | — |
| **Image intro + video** | Hold a still image as a title card, then play a video clip. Zero models | — |
| **Video trim** | Cut a start-second + length span out of a clip. Zero models | — |
| **Image upscale** | 4x super-resolution upscale of a still image via RealESRGAN | — |
| **Image to prompt** | Upload a reference image and a short ask; a local Qwen3-VL model writes the polished English prompt for you | — |
| **Text to prompt** | Paste a rough idea and the same local Qwen3-VL model rewrites it into a structured English prompt | — |

**Change one thing and run.** The three model-heavy templates (wuxia, character portrait, reference-to-video) use a purple group box labelled "only edit here" around the prompt node (the video one also has a reference-image node). The other six use a more compact three-group layout (①②③ notes) — follow the notes the same way. Press **Run**: the graph becomes a federation job, and when a worker finishes, the result renders inside the output node on the right and is also downloadable, with its receipt, from the console's Jobs page.

**Bundled assets**: templates that need a reference image or sample input (reference-to-video, image-to-prompt, image-upscale, etc.) seed the matching file into `<data-dir>/comfy_staging/` at startup, so the `LoadImage`/`LoadVideo` dropdown resolves out of the box. To use your own, upload it on the node (or drop the file onto the canvas) — uploads land in the same staging area and are copied into the job's inputs at submit time.

⚠ The models a template names must actually be installed **on a worker** for the dropdowns to offer them and for the job to be dispatchable. Otherwise the job is created but sits in the queue; the Jobs page's ineligibility reasons say what is missing. The six zero-model templates (video concat, image intro + video, video trim, etc.) run fine on a brand-new worker with no models at all.

### Model downloads

A fresh worker has none of these files, which makes the model-dependent templates dead on arrival. They are too large for git, so every file below comes with two links: the **official** one (its HuggingFace/upstream home — prefer this), and a **backup** on our public GCS mirror at `https://storage.googleapis.com/comfyfed-models/models/`, whose layout mirrors ComfyUI's `models/` directory and which is there for when the official source is down or gated. Download a file and drop it under the matching subfolder of the worker's `ComfyUI/models/`.

| File | Size | Target path | Official | Backup |
| --- | --- | --- | --- | --- |
| `flux1-dev.safetensors` | 22.17 GB | `models/diffusion_models/` | [Official](https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors) (requires HuggingFace login + accepting the FLUX.1-dev license) | [Backup](https://storage.googleapis.com/comfyfed-models/models/diffusion_models/flux1-dev.safetensors) |
| `clip_l.safetensors` | 0.23 GB | `models/text_encoders/` | [Official](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/text_encoders/clip_l.safetensors) |
| `t5xxl_fp16.safetensors` | 9.12 GB | `models/text_encoders/` | [Official](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/text_encoders/t5xxl_fp16.safetensors) |
| `ae.safetensors` | 0.31 GB | `models/vae/` | [Official](https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/ae.safetensors) (requires HuggingFace login + accepting the FLUX.1-dev license) | [Backup](https://storage.googleapis.com/comfyfed-models/models/vae/ae.safetensors) |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 19.53 GB | `models/diffusion_models/` | [Official](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) |
| `qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors` | 14.61 GB | `models/text_encoders/` | [Official](https://huggingface.co/sakamakismile/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4/resolve/main/qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/text_encoders/qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors) |
| `minimax_h3_video_vae_fp16.safetensors` | 4.85 GB | `models/vae/` | [Official](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/vae/minimax_h3_video_vae_fp16.safetensors) |
| `minimax_h3_audio_vae_fp32.safetensors` | 0.56 GB | `models/vae/` | [Official](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/vae/minimax_h3_audio_vae_fp32.safetensors) |
| `minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors` | 0.91 GB | `models/loras/` | [Official](https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI/resolve/main/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/loras/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors) |
| `qwen3vl_4b_bf16.safetensors` | 8.27 GB | `models/text_encoders/` | [Official](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/text_encoders/qwen3vl_4b_bf16.safetensors) |
| `RealESRGAN_x4plus.pth` | 0.06 GB | `models/upscale_models/` | [Official](https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth) | [Backup](https://storage.googleapis.com/comfyfed-models/models/upscale_models/RealESRGAN_x4plus.pth) |

Everything together is about **80.3 GB**; the two Flux templates (wuxia, character portrait) need about **31.8 GB**; the reference-to-video template alone needs about **40.5 GB**; the two prompt-helper templates (image-to-prompt, text-to-prompt) share a single model and need only **8.27 GB**; image upscale needs only RealESRGAN's **0.06 GB**; video concat, image-intro-video, and video trim need no models at all. Each model-dependent template's canvas also carries a "⓪ Missing models?" note (the zero-model templates skip it) listing exactly what that template needs.

**No restart required**: once the files are in place you do not need to restart ComfyUI or the agent — it rescans its local model inventory every 10 minutes and reports back, and the job assessment turns green on its own. Restart the agent if you want that to happen immediately instead of waiting.

### Publishing an agent release

The server ships a publish command that copies the wheel into `<data-dir>/releases/`, computes its sha256, signs it with the platform key, and writes all five `agent_*` settings in one go:

```bash
comfyfed-server publish-agent dist/comfyfed_agent-0.2.0-py3-none-any.whl \
  --min-supported 0.1.0
```

(The version is parsed from the wheel filename unless you pass `--latest`. `--min-supported` defaults to `--latest`, which locks out every older agent.)

Once published, an agent asks `/api/agent/version` at startup, compares versions, downloads the wheel, and installs it only if both the sha256 and the platform signature verify. **The signed payload is `{version}|{sha256}`** — binding the version into the signature means an old release's signature cannot be replayed to advertise a newer version, so a downgrade attack does not work.

⚠ **The platform signing key may be kept offline** (as the spec recommends). If you would rather not keep `data/keys/platform.key` on the live host, skip `publish-agent`: sign `"{version}|{sha256}"` yourself on an offline machine and set `agent_latest`, `agent_min_supported`, `agent_wheel_url`, `agent_wheel_sha256` and `agent_wheel_sig` by hand. The agent verifies them identically either way.

### Known limitations

- **Billing is actual execution seconds, not queue wait**: a receipt's `gpu_seconds` is built from `exec_seconds` — guaranteed by agent protocol 2 — the moment ComfyUI's `/queue` first reports the prompt under `queue_running` to completion, capped at the wall-clock span (`finished_at - started_at`). It only falls back to the wall-clock figure when `exec_seconds` couldn't be measured (an older agent, or an unreachable `/queue`); the receipt's `basis` field records whether that run was billed on `exec` or `wall`. This is deliberate: one worker can serve local use plus several platforms at once, and billing queue-wait as GPU time would double-charge every platform for the same idle stretch, breaking future revenue sharing. Time a worker spends queued behind other platforms' (or local) work is excluded from this platform's receipts.
- **Failed/cancelled jobs produce a non-billable receipt for the record, but don't count toward totals**: a job that fails or gets cancelled still mints a receipt (`kind` of `failed` or `cancelled`, `billable=false`) so there's an auditable trail of where that time went — but only `kind=completed` (`billable=true`) receipts feed the Reports page's contribution totals and leaderboard.

### Roadmap

**Phase 2**
- Model manifest distribution (to actually implement `eligible_after_fetch` transfers)
- S3/R2-compatible artifact storage

**Phase 3**
- Direct member-to-member P2P transfer
- Revenue-share ledger
- Multi-admin support

**ComfyFed Cloud** (shipped): a hosted variant built on Cloudflare Workers + D1 + R2, so there's no machine of your own to keep powered on. See [`cloud/README.md`](../cloud/README.md).

### License

License: [AGPL-3.0](../LICENSE).
