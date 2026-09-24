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

**There is exactly one server implementation** (`cloud/src`, a Cloudflare Worker): self-hosting means running that same packaged Worker on your machine under Miniflare (Cloudflare's own workerd wrapper), with D1 backed by local SQLite, R2 by a local directory and the Durable Object by local SQLite. The old Python server was removed on 2026-09-24; the agent is still Python and is unaffected.

**Self-hosted (Docker)**

```bash
docker run -d --name comfyfed --restart unless-stopped \
  -p 8388:8388 -v comfyfed-data:/data \
  ghcr.io/aiinpocket/comfyfed:latest
docker logs comfyfed        # the first start prints the setup token
```

**Self-hosted (without Docker, Node.js 22+)**

```bash
cd web && npm ci
cd ../cloud && npm ci
npm run selfhost -- --data-dir ./data --url https://your-domain.example
```

The first run builds the console and the Worker (`dist-selfhost/` and `assets/`); every start after that takes seconds. Open `http://<this machine>:8388`, enter the setup token and create the admin password. `--check` starts the server, hits `/api/ping` once and exits, to confirm the install works. The full parameter table (`--data-dir` / `--port` / `--host` / `--url` / `--check`) and the TLS reverse-proxy setup are in [README.en.md, "A. Self-hosted"](../README.en.md#a-self-hosted-local-machine-or-vm).

`--data-dir` (`/data` under Docker) holds two things: `state/`, the persisted D1 / R2 / Durable Object data (database, uploads, outputs), and `selfhost.json` (mode 0600), the `SETUP_TOKEN` and `PLATFORM_ED25519_SEED` generated on first run. The seed is the platform's signing identity, so back it up with the rest. `migrations/*.sql` apply at startup and are recorded in `d1_migrations` (same semantics as `wrangler d1 migrations apply`), so re-running is a no-op.

**Cloudflare (a Cloudflare account plus Node.js 20+)**

```bash
cd cloud && npm install
npm run setup:cloudflare          # add -- --yes for non-interactive: keep existing secrets, ask nothing
```

One command covers login, D1, R2, the `database_id` in `wrangler.jsonc`, secrets, build, migrations and deploy, and prints the URL and setup token at the end. The step-by-step manual route is still in [`cloud/README.md`](../cloud/README.md).

**Honest note**: Cloudflare positions Miniflare as a development tool, not a production product. For a friends-circle platform on one box that is an acceptable trade for zero duplicated server code; it is not built to carry heavy traffic.

### Users & permissions

Login is now **username + password** (not a single admin password). The first account created by the install wizard is always named `admin`, with the admin role.

**Creating users**: log in as an admin, go to Console → **Users** → create a user, giving it a username and a role (admin or user). Leave the password blank and the system generates a random one, **shown exactly once** at creation time (with a copy button) — hand it to that person right away. If it's lost, an admin can hit "Reset password" on the same page to issue a fresh one-time password.

**What each role sees**:

- **User**: only their own jobs and artifacts (Dashboard, Jobs, and Reports all scope to their own data); Settings is trimmed down to change-password and language; no visibility into anyone else's jobs. **The Workers page and workflow templates are open to every role** — workers are shared fleet infrastructure, so a user sees the whole fleet's status (online/offline, hardware, model counts), but the **issue-token / disable / delete** controls and their APIs stay admin-only.
- **Admin**: sees everyone's jobs and stats in the console, plus the Workers, Users, and full Settings pages, and all three report tabs (contributions, per-user usage, payout estimation).
- The embedded workflow editor (`/comfy`) is a **personal workspace for every role**: whether admin or user, the panel only shows jobs that person submitted through the panel — see the full picture on the console's Jobs page instead.

Every account on the Users page can be **disabled/re-enabled**, have its **role changed**, and have its **password reset**; disabling a user immediately invalidates all of its existing logins and blocks new ones. There's no delete (jobs and receipts need to keep their attribution), and **the last remaining admin can't be disabled or demoted**, so you can't lock yourself out.

**Per-user usage and payout**: admins get two extra Reports tabs — "**Per-user usage**" (each account's job count and GPU-seconds) and "**Payout estimation**" (enter a payout pool amount and it splits it across workers by their share of GPU-seconds in the date range). A regular user's Reports page only shows their own "**My usage**".

**Upgrade note**: when upgrading from an older install, the existing admin password automatically becomes the `admin` account (**the password itself doesn't change** — no reset needed), and all existing jobs/receipts are attributed to that account. But because the session cookie format changed, **everyone has to log in again once after the upgrade** (admin included) — old login cookies are treated as unauthenticated, with no compatibility fallback. The data migration is D1 migration `0006`: Cloud applies it during `npm run deploy`, and the self-hosted edition applies the same migrations at startup — no manual steps needed.

### Network: DDNS or a fixed IP both work

The server just needs one address everyone can reach — a dynamic DNS hostname or a fixed IP both work fine. That address is the `platform_url` platform setting (written on first run by `npm run selfhost -- --url …`, changed later in the console's Settings; when unset, the request's own origin is used), and it's the same value baked into every worker's registration bundle.

Workers (agents) only ever make **outbound** connections to the platform — no inbound port needs to be opened, so agents behind NAT/firewalls work without any configuration.

If you're exposing the server over HTTPS, put a reverse proxy in front for TLS and forward to the internal port the platform listens on (8388 by default).

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

**A worker's source IP is read only from `CF-Connecting-IP`.** The platform uses each worker's public IP to group P2P peers that sit behind the same NAT (they then swap chunks over their LAN addresses; see "Members behind the same NAT use the LAN address" below). Cloudflare sets that header automatically on the cloud edition; under Miniflare nothing sets it, and there is no "trust X-Forwarded-For" switch, so the self-hosted edition currently does no same-NAT grouping — P2P still works, pullers simply try the external address first.

### Adding a worker

1. In the console, go to **Workers** → add, name it, and the platform issues a one-time registration token and shows three one-line install commands right away (Windows PowerShell / Windows cmd / Linux + macOS), each with its own copy button.
2. On the machine that will contribute compute, paste the matching line into a terminal. **No administrator/sudo needed**: on Windows a plain terminal works (an elevated one gets a Task Scheduler autostart, a non-elevated one automatically falls back to a per-user registry Run key — same effect); on Linux/macOS run as your normal user, **without sudo** (everything installs into your home directory; the script refuses to run as root). The script is safe to re-run: an already-registered machine skips the registration step automatically. **A re-run never touches your existing `agent.json`** (`auto_fetch_models`, `max_fetch_gb`, whitelist and the rest all survive; the only thing it changes on its own is the never-configured sharing switch described under P2P below). **One worker can serve several platforms**: pasting a second platform's install command on the same machine only appends an entry to `platforms` in `agent.json`, never replacing the first registration, and it **never downgrades the agent**: when the installed agent is newer than the version that platform publishes, the installer skips the wheel step and keeps what you have (the same version is still reinstalled).

```powershell
# Windows (PowerShell)
irm "<your platform URL>/install.ps1?token=<one-time token>" | iex
```

```cmd
:: Windows (cmd)
curl -fsSL "<your platform URL>/install.cmd?token=<one-time token>" -o install.cmd && install.cmd && del install.cmd
```

```bash
# Linux / macOS
curl -fsSL "<your platform URL>/install.sh?token=<one-time token>" | bash
```

(Copy the actual command straight from the console — the URL and token are already filled in for you.)

That one line does the whole install: missing Python gets installed automatically — **with no sudo/administrator on any OS** (Windows: python.org's per-user silent installer; macOS and Linux: a relocatable CPython 3.12 from Astral's python-build-standalone into `~/.comfyfed/python`, verified against sha256 digests pinned in the script before it is used — the same prebuilt interpreters `uv` ships; Linux falls back to apt/dnf only if that download fails. macOS note: the Xcode Command Line Tools' python3 is 3.9, below the 3.10 floor, so installing Xcode does not help and the script no longer suggests it); if no local ComfyUI is found it installs ComfyUI too (pinned at v0.35.0, with CUDA/CPU/MPS picked automatically from your GPU); once done it uses the token to run `register` on its own and sets the whole stack (ComfyUI + agent) to start on login and run in the background — no further manual steps. Re-running the same line is safe (idempotent): a machine that's already set up gets its scheduled task/service repaired and its agent upgraded, without reinstalling ComfyUI.

**An existing ComfyUI is now started for you too.** When the installer finds a ComfyUI you already run (Comfy Desktop, your own checkout), it records *how that running instance was started* — the executable, its arguments, its working directory and the URL it answers on — into `comfyui_managed.json` (`%LOCALAPPDATA%\ComfyFed\` on Windows, `~/.comfyfed/app/` on Linux/macOS), and starts it again at logon/boot just before the agent. Until this landed only a ComfyUI the installer had installed *itself* came back after a reboot, so on a Comfy Desktop machine the agent would start with nothing behind it and the worker sat offline until someone opened ComfyUI by hand. Starting is always probe-first: if something already answers on that URL, nothing is launched, so you never get a second copy fighting for the same port. If the installer cannot read the listening process (nothing found, or permission), it writes **nothing** and tells you on the spot that you have to start ComfyUI yourself after a reboot.

- **To opt out**, set `"autostart": false` in `comfyui_managed.json` and the launcher will leave ComfyUI alone (the agent still autostarts and simply waits for ComfyUI to appear). Re-running the installer **re-captures** that file — a detected ComfyUI can move, upgrade, or change port — so set the flag again after a re-run.
- **The recorded port is the one ComfyUI was answering on at install time.** Comfy Desktop opened *later* as a second instance picks a different port; the agent keeps using the recorded one, so point the recorded instance at the port you want to contribute with.

**Uninstalling**:

- **Windows**: `schtasks /Delete /TN ComfyFedAgent /F` (for a non-admin install: `reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v ComfyFedAgent /f`), then delete the `%LOCALAPPDATA%\ComfyFed` folder.
- **Linux**: `systemctl --user disable --now comfyfed-agent comfyfed-comfyui`, then delete `~/.comfyfed`.
- **macOS**: `launchctl unload -w ~/Library/LaunchAgents/com.comfyfed.agent.plist` (and `com.comfyfed.comfyui.plist` too, if ComfyUI was installed by the script), delete those `.plist` files, then delete `~/.comfyfed`.

#### Manual install (advanced)

Under the hood, the one-liner is just "install the Python package, then register." If you need to control the environment yourself (an existing ComfyUI, a custom venv), you can still do it by hand — the console's collapsed "Manual install (advanced)" section still lets you download the same `bundle.json`:

```bash
pip install -e .            # from the repo root; the root pyproject.toml is the agent
comfyfed-agent register bundle.json
comfyfed-agent run
```

`register` exchanges the bundle's one-time token for a real certificate from the platform and writes the config to `~/.comfyfed/agent.json`; `run` connects to every registered platform and starts processing jobs. The manual flow does not install ComfyUI or set up autostart for you — you're on your own for both.

**ComfyUI's location and folders are auto-detected**: at registration (and every startup) the agent finds the local ComfyUI on its own — well-known ports first (8188/8000/...), then a sweep of 8000-8399 confirmed by the `/system_stats` fingerprint — and derives the model library (`models_dir`) plus ComfyUI's real output/input folders from `/internal/folder_paths`, writing them all into `agent.json`. You only need to set `comfy_url` by hand when nothing can be found (ComfyUI isn't running, or listens on an unusual port); a value you set by hand is never overwritten by detection.

**Stopping an agent**: press `Ctrl-C` in its terminal (`CTRL_BREAK` works too on Windows) for a graceful shutdown — the agent asks ComfyUI to interrupt whatever it's running, cleans up its own temp files, and only exits once that wind-down is confirmed, instead of leaving a half-finished job or stray files behind.

### Pause & stop

The agent has BOINC-style idle detection built in, **on by default**: whenever it detects someone actively using the machine (mouse/keyboard input), it stops taking new jobs — anything already running keeps going to completion, only new intake stops. You can also control an already-running background agent from a second terminal with the CLI:

```bash
comfyfed pause    # stop taking new jobs (any job already running finishes normally)
comfyfed resume   # start taking new jobs again
comfyfed status   # show the current state (available / paused-manual / paused-active, plus whether a job is running)
comfyfed stop     # ask the agent to shut down gracefully: the running job is cancelled and cleaned up (same as Ctrl-C in its terminal)
```

**`stop` does not wait for the running job.** It runs exactly the `Ctrl-C` wind-down — ask ComfyUI to interrupt, clean up the temp files, exit — and the platform requeues that job onto another worker after its stale-job timeout. To drain first, do it in this order: `comfyfed pause` → wait until `comfyfed status` no longer reports `busy` → `comfyfed stop`.

(`comfyfed` is on PATH after the one-line installer runs; the manual-install flow uses the same binary under the name `comfyfed-agent` — they're the same commands.)

**Pause needs a platform on this release or newer.** `paused` is a heartbeat state added in 0.1.2; an older platform does not recognise it and keeps dispatching. A new agent against an old platform means pause silently has no effect — upgrade the platform side first.

Idle-detection settings live in `agent.json`: `pause_when_active` (default `true`) toggles activity detection on/off, and `idle_minutes` (default `15`) is how many consecutive minutes without any keyboard/mouse input count as idle — while the last input is more recent than that, the agent treats the user as active and pauses intake, resuming once the machine has been idle that long. After editing `agent.json` by hand, restart the agent for the change to take effect.

**Pausing stops new jobs, not seeding (P2P model sharing).** Serving model files to other workers costs only CPU and network — no GPU — so it keeps running while you use the machine, but it is rate-limited so it stays out of your way. While the user is active or the agent is manually paused, uploads are capped at `peer_upload_limit_mbps` (default `20`, in megabits per second); while the machine is idle, the cap is `peer_upload_limit_idle_mbps` (default `0` = unlimited). Both live in `agent.json`; restart the agent after editing it by hand. The cap is process-wide and shared: several pullers at once are jointly bounded by it, not one cap each. **Honest note**: with no cap (the idle default), a single pull can saturate a home uplink and make video calls or gaming feel awful — if that matters to you, set `peer_upload_limit_idle_mbps` to a real number too (say half your upstream bandwidth).

**A seeder reports its own cap, and grant lifetimes are sized from it.** The agent's `hello` carries the slowest upload cap it would ever seed at — the lowest non-zero of `peer_upload_limit_mbps` and `peer_upload_limit_idle_mbps`, and nothing at all when both are `0` (unlimited). When the platform signs a P2P grant, it estimates the transfer time from that number instead of always assuming 20 Mbps, so a deliberately slow uplink (say 5 Mbps) gets a grant roughly 4x longer and the transfer no longer expires mid-file. An older platform simply ignores the field and behaves exactly as before.

**A dead registration is moved to `agent.dead.json` automatically.** When a platform rejects a registration with 4401 (the worker was deleted, or its credentials are invalid) **twice in a row**, the agent stops retrying it *and* takes that `platforms` entry out of `agent.json`, appending a full backup to `agent.dead.json` in the same directory (a JSON list that grows, with `removed_at` and `reason` added). The next start no longer attempts it or re-logs the error. **That backup contains a signing key in the clear — guard it exactly like `agent.json`.** To restore one, copy the record's `platform_url`, `platform_pubkey`, `worker_id`, `certificate` and `signing_key_hex` back into `agent.json`'s `platforms` list (leave `removed_at`/`reason` behind) and restart the agent. Normally, just re-run the installer to register afresh. A single 4401 (an older platform also sends it on a handshake timeout), a handshake timeout (4408), and an admin-**disabled** worker (4403) never prune anything: the agent simply keeps retrying, so re-enabling a disabled worker brings it straight back.

**When activity can't be detected, the worker is always treated as idle and keeps accepting jobs**: headless machines (no display/keyboard/mouse) and Wayland desktops without XWayland give the agent no signal to read, so detection failure never makes a worker unschedulable — it just behaves as if pause-when-active is off.

**Windows: the worker shows offline after a reboot (0.1.11+).** The agent starts automatically at logon, but ComfyUI Desktop is launched by you — so after a restart the agent is usually up minutes before ComfyUI is. It handles that on its own: it probes ComfyUI first, and while nothing answers it does **not** connect to the platform, logs one warning line instead of a traceback, re-probes every 30 s, and goes online by itself the moment ComfyUI is running. Until then the console simply lists the worker as offline and `comfyfed status` reports `paused` with the reason `comfyui_unreachable` — nothing needs fixing, just start ComfyUI. **On a machine installed (or re-run) since this feature landed that window is usually gone**: the installer records how your existing ComfyUI starts and the logon launcher brings it up before the agent — see "Adding a worker" above.

**Windows: can't find the `comfyfed` command?** The terminal window the installer ran in doesn't pick up the new PATH entry — that's expected. Close it and open a new terminal.

**macOS / Linux: can't find the `comfyfed` command?** The installer links it into `~/.local/bin`, which is not on the default PATH on macOS (stock `/etc/paths`) or on minimal Linux images (the installer says so when it notices). Add it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # bash: ~/.bashrc
exec $SHELL -l
```

### Storage quota counts everything a user keeps (2026-09-24)

A user's quota (`upload_user_quota_gb`, or their per-user override) is charged against **three** namespaces: their uploads (staging), their saved panel files (userdata) and, since 2026-09-24, the inputs and outputs of every job they own. Outputs were previously excluded; a video job leaves hundreds of MB behind, so a quota that ignored them was not a quota. Uploads and job submissions are both refused with `quota_exceeded` once the total would exceed the quota; deleting outputs from the Files page frees the space. The Settings page bar and the admin Users page (`Used` column, `used_bytes` in `GET /api/users`) show the total; `GET /api/staging` reports the job share as `jobs_bytes`. The Workers page also shows each worker's agent version (`hardware.agent_version`) and flags one older than the published `latest`.

### Job dispatch: light jobs go to weak GPUs first

Dispatch isn't a random pick among eligible workers: jobs that need zero models (pure post-processing work like video trimming or concatenation) are preferentially routed to workers with no dedicated GPU or weaker VRAM (Mac/CPU-only machines included), saving the model-heavy, VRAM-hungry rendering jobs for the real GPUs. That means a laptop can pull its weight in the federation instead of a 4090 getting stuck doing video-editing busywork.

**Model jobs go to NVIDIA, or to a Mac running the MPS shim** (2026-09-20 rule, relaxed 2026-09-23): as soon as a workflow loads any model, only workers reporting the `cuda` backend qualify — plus an Apple-silicon (`mps`) worker whose ComfyUI is running the agent's **MPS quantization shim**. fp8 / int8 / nvfp4 weights have no Apple MPS kernels; the shim (`custom_nodes/comfyfed_mps_compat`, installed by the macOS installer and refreshed by the agent) decodes fp8 through a lookup table and computes int8 matmuls in fp32, so the exact same quantized workflows (fp8 Chroma, int8+nvfp4 MiniMax-H3) run unchanged on a Mac. The agent reports `mps_quant_compat: true` in its hello only when the *running* ComfyUI has loaded the shim (it needs a restart after install); without that flag a Mac is still refused with the reason "Jobs that load models only go to NVIDIA…". ROCm and unknown-backend workers stay refused. If a particular model should be allowed on a backend regardless of the shim, add `backends: ["cuda", "mps"]` to its entry in the platform's model guide. Zero-model editing jobs are unaffected and still go to Macs/weak cards first.

**How a slow backend is weighed** (2026-09-23, spec `docs/superpowers/specs/2026-09-23-cross-backend-dispatch-design.md`): there is no flat "Mac penalty". A worker that has never completed a job gets a *speed prior* from its backend (`cuda` 1.0, `rocm` 0.7, `mps` 0.12, `cpu` 0.03) in place of the learned `speed_index`, so its first predictions are already the right order of magnitude (an M4 Pro measured ~1/8 of an RTX 5080 on fp8 Chroma); its first completed job then replaces the prior with the measured ratio. On top of that the scheduler now weighs **waiting for a busy worker** against running now: for every queued job it estimates when each busy worker would finish it (remaining time of its current job, plus everything already queued behind it this tick, plus the same load/fetch/run cost an idle worker is charged) and, when that is clearly sooner than the best idle worker (by more than 25 % + 30 s), it **holds** the job — it stays queued and the decision is re-evaluated every 5 s tick. The hold is visible in the job's `dispatch_info` (`held_for`, `wait_seconds`, `run_now_seconds`). Held jobs queue up behind the busy worker in age order, so once enough work is waiting for one card the next job *does* go to the Mac: weak workers absorb the overflow, never the whole queue. A hold only ever exists relative to a busy worker that is alive, eligible for that job and whose remaining time is estimable (not more than 2× overdue); the moment that stops being true the job goes to whatever idle worker can run it — nothing is ever stranded while any live worker qualifies.

**Unified memory** (2026-09-23): a Mac reports its whole unified pool as `vram_gb` with `unified_memory: true`. For such a worker the resident set of a job (the sum of *all* referenced models × 1.15, since nothing can be offloaded to a separate RAM) must fit in 85 % of the pool, otherwise the job is refused with `memory:<need>><usable>`. Discrete GPUs keep the largest-single-model rule with RAM offload.

### Scheduling and batch splitting

The server runs a dispatch tick every 5 seconds. It doesn't pick one job at a time for the biggest available card — instead it puts **every job currently queued** and **every idle worker** into a single cost table and solves for the overall cheapest matching in one shot (the Hungarian algorithm). The cost table factors in:

- **How long this machine takes on this kind of graph.** Every submitted graph gets a "workflow signature" — a hash of the node composition, model list, total step count, resolution bucket, and batch size. Changing only the prompt text or the seed leaves the signature unchanged; changing resolution, steps, or models changes it. Every time a job finishes and the agent reports a valid GPU execution time, the platform folds it into an exponential moving average keyed by `(worker, signature)`. If this worker has never run this signature, the platform converts another worker's median for that signature using this worker's "speed index"; if there's no data for the signature at all, it falls back to the fleet-wide median; a brand-new install assumes 60 seconds.
- **Whether a model needs reloading.** Each worker remembers which models the job it was last assigned needed. If the models this job needs are already warm, that costs nothing; if they're cold, the platform estimates load time at 1.5 seconds per GB. So "smaller VRAM but the model is already warm" regularly beats "bigger card but has to reload 22 GB."
- **Whether a model needs downloading.** Candidates that need auto-fetch are estimated at 50 MB/s. The existing rule still holds: as soon as any worker already has every required model, the workers that would need to download are excluded from consideration entirely.
- **Light jobs stay off the big cards.** Jobs that need no models at all (video editing, for instance) are still preferentially routed to weaker GPUs/Macs.
- **Longer waits win.** Every second waited is worth one second less cost; a job that has waited more than 5 minutes is guaranteed to be dispatched this tick as long as any eligible worker exists.
- **A verdict with warnings always ranks behind a clean one** (for example, needing to offload weights to system RAM).

The job detail page shows what this dispatch decided (`dispatch_info`): the predicted execution time (`predicted_seconds`), where that prediction came from (`basis`: `signature` — this machine has run this signature before; `speed_index` — converted from another worker's data; `fleet_default` — fleet-wide median; `none` — the brand-new-install default), the predicted load/fetch time (`load_seconds`/`fetch_seconds`), and how many eligible workers there were at the time (`candidates`).

#### Automatic batch splitting

A graph with `batch_size >= 2` gets split into several sub-jobs that run at the same time, one per contiguous slice of the batch (e.g. 4 images split into 2+2), whenever there are multiple eligible idle workers available right now. The split is done by inserting one core node, `LatentFromBatch`, into each sub-job's workflow, telling it which slice of the full batch to compute — **the agent side does nothing special and needs nothing extra installed.**

**Will the result be the same?** Same seed, same composition — but **not bit-for-bit**. When ComfyUI generates batch noise, as soon as the latent carries a `batch_index` (which `LatentFromBatch` sets), it generates the noise slice-by-slice and keeps only the requested slice; measured at the pure-noise layer this is bit-identical. After running end-to-end there's a tiny floating-point difference (measured on Flux dev, 512x512, 4 steps: mean pixel difference 0.47/255), coming from the different kernel paths taken by batch=2 versus batch=1 — the control group (a genuinely different image) measured 17.7/255. **This difference is the same order of magnitude as the difference you'd already get from running the same job on a different GPU.** If you need bit-level reproducibility, turn splitting off.

Not every graph can be split. All of the following must hold:

- The graph contains **exactly one** `EmptyLatentImage` or `EmptySD3LatentImage` node, and its `batch_size` is a literal integer >= 2.
- **No other** node carries a `batch_size` input.
- Every node in the graph is in the split-safety allowlist. **Custom nodes are never on the allowlist**, and neither are `ImageBatch`, `LatentBatch`, `RepeatLatentBatch`, `RebatchLatents`, or video nodes — these treat the whole batch as one unit, so splitting would produce the wrong result.
- Every sampler's latent input can be traced back to that batch source (passing only through nodes that carry the batch structure through unchanged).
- Every `SaveImage`/`PreviewImage` node can trace the batch source as an ancestor — otherwise a side branch unrelated to the batch (say, a standalone `LoadImage -> VAEEncode -> VAEDecode -> SaveImage`) would get rendered once per child and duplicated in the output.

Other rules:

- Splitting caps out at 8 sub-jobs, and never exceeds the number of eligible idle workers available right now.
- Split sub-jobs are **invisible to the ComfyUI panel**: `/history`, the queue, and progress events all still show the one original job, and outputs come back merged and ordered the same way they would from a single full-batch run.
- The console (`/jobs`) job list likewise still lists only the original job, with an extra "split x k" badge; the detail page can expand to show each sub-job (`children`) — which worker it landed on, how far it got, and how many GPU-seconds it used (this field is `null`, not 0, for a sub-job with no receipt yet) — plus the aggregated `gpu_seconds_total`. Pass `?include_children=1` on the API to list sub-jobs directly.
- **Receipts are minted one per sub-job** (the parent job has no receipt of its own), so revenue-sharing and usage reports are completely unaffected — the seconds are still credited to whoever actually ran them.
- If any sub-job fails, every other sub-job still in flight is cancelled, and the parent job is marked failed with a note of which slice failed. Cancelling the parent cancels every sub-job and notifies each still-running worker individually; cancelling any single sub-job cancels the whole group.
- **A retry never re-splits**: the whole batch runs on one worker again, so two generations of sub-jobs never get mixed together.

#### Turning splitting off

The platform settings page has an "automatic batch splitting" toggle that turns it off fleet-wide (on by default). Once off, **newly submitted** jobs always run as a single unit on one worker; sub-jobs that were already split off are unaffected and run to completion normally.

To turn it off for just one job, include `{"split": false}` in that job's `requirements`.

### What happens when a job fails

A worker reporting "this one failed" is not the end of the line. The platform first assumes the problem is with **that machine**, not with the job:

- **Failure #1** → the job goes back to `queued` and is re-matched on the next dispatch tick. Anyone can pick it up, **including the worker that just failed it** — a one-off OOM, a driver hiccup, or a wedged ComfyUI very often passes on the second run.
- **Failure #2 on the same worker** → that worker is out for **this job** and is never matched to it again; at the same time the platform records "this worker is unsuitable for this **kind** of task". The kind is the job's workflow signature (node composition + model list + steps/resolution/batch — the same signature dispatch uses for its time predictions), so **new jobs of the same kind won't go to that worker for 7 days** either. For a model download job (`model_fetch`) the kind is "this worker can't fetch this model".
- **Re-dispatch ignores "who already has the model".** This is the point of the feature: the normal rule is "as soon as any worker already has every required model, the workers that would need to download are excluded" — but once the worker that has the model is out, the platform hands the job to a worker that **doesn't have the model but has auto-fetch enabled**, with that model's download list (official/backup URLs, or peer-to-peer chunk transfer between members) attached to the push, so the agent downloads first and then runs. "The only machine with the model can't actually run it" is no longer a dead end.
- **6 failures in total**, or **no worker in the fleet could possibly run it** (all excluded, or missing nodes with no fetchable model; **a worker with no heartbeat for more than 7 days does not count as "possible"**, so a stale registration that will never come back cannot keep a job queued forever) → only then is the job finally marked failed. That "could anyone still run it" question is re-asked every dispatch tick for jobs that have already been retried, so when the last possible worker disappears later (goes stale, gets deleted or disabled) the job is wrapped up instead of sitting in the queue.
- **Dispatched, but the worker says it is idle** (the push landed on a connection that had just dropped, or the agent restarted mid-run): when the same worker reports idle with no job on two consecutive heartbeats, any job still assigned/running under its name is taken back into the queue and re-dispatched on the next tick. This is not counted as a failed attempt and mints no receipt. Its error message is a summary: how many workers were tried over how many attempts, and each one's last error — so you can tell at a glance whether every machine chokes on it or one machine keeps blowing up.
- **Every failed attempt still mints a receipt**, `kind=failed` and **non-billable** — failures are never charged, but who attempted what and when stays on the record.
- **Admin cancellations** and **stale requeues** (a worker drops off and its job is reclaimed) **do not count as failures** and never saddle a worker with an unsuitable record.

**How a record is cleared**

- **Automatically**: the moment that worker successfully completes a job of the same kind, the record is deleted.
- **By expiry**: 7 days without another failure and it stops applying (the row stays, so admins can still see the history — it just no longer blocks dispatch).
- **Manually**: the Workers page has an "unsuitable tasks" section per worker listing the task kind (first 12 characters of the signature), the accumulated failure count, the last error, and a link to the last failed job; an admin clicks "clear" to lift it immediately — for when the GPU was swapped, the driver was fixed, or those two failures were the platform's fault, without waiting out the 7 days.

The job detail page's "attempts" panel lists how many times each worker failed this job; a job still being retried shows its "last error", so you don't have to wait for a final failure to see what went wrong.

### Security model summary

- **One-time registration token**: each bundle issued by the console can be used exactly once (the server claims it atomically, so two concurrent registrations can't both win).
- **Mutual key pinning**: on first registration, the agent pins the platform's Ed25519 public key locally; the certificate the platform issues back is likewise bound to that worker's public key — after that, identity checks no longer depend on the token.
- **Signed requests + replay protection**: every API call carries `X-Ts` (timestamp), `X-Nonce`, and an Ed25519 signature; the server rejects requests whose timestamp is off by more than ±120 seconds and rejects any nonce it has already seen.
- **WebSocket challenge**: when an agent opens its long-lived connection, the server sends a random nonce that the agent must sign back with its own key to complete the handshake.
- **Dual-signed receipts**: on job completion, both the worker and the platform sign the receipt, so neither side can fabricate a contribution record alone.
- **No hardcoded default credentials**: the first admin account is created by you on first visit, using the randomly generated setup token (printed in the startup log when self-hosting, or by `setup:cloudflare`) and a password of your choosing — there is no built-in account.

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

The platform can dispatch a job together with the models it needs that this worker is missing, and the agent downloads them itself before running the job instead of the job simply being ruled `ineligible`. **On by default** (as of 2026-09-16), bounded by `max_fetch_gb`; opt out in `agent.json` if you don't want it:

```json
{
  "auto_fetch_models": true,
  "max_fetch_gb": 20,
  "hash_models": true
}
```

> Note: an existing `agent.json` written by an earlier agent version that already contains an explicit `"auto_fetch_models": false` keeps that value across the upgrade — operators of existing workers edit the file to opt in to the new default.

- `auto_fetch_models` (default `true`): while off, this worker is never dispatched a job carrying `fetch_models` — identical to pre-2.1 behavior; set `false` to opt out.
- `max_fetch_gb` (default `20`): the most this worker will download for a single job, in GB. Over budget or insufficient free disk both refuse the whole batch up front — never a half-downloaded failure.
- `hash_models` (default `true`): turning this off stops the agent from scanning/hashing local models at all, which also means the server can never learn this worker's models well enough to offer them to others — and, as a side effect, this worker can no longer auto-fetch models either.

**Curated models auto-download even with zero holders fleet-wide**: the 12 curated models in the platform's built-in download list (see the "Model downloads" table below) each carry an operator-vouched official sha256/size, so they don't need any worker to have actually held the file and reported a hash first — every other model still needs at least one worker in the federation to have held it and reported a hash, with agreement across reporters ("consensus"), before it can enter the manifest; once a real consensus hash does show up, consensus always wins over the built-in value. As long as some worker has `auto_fetch_models` on and enough free disk, a curated model with zero current holders still gets dispatched for download — it never gets stuck just because nobody has it yet — and once the download completes it's reported the same way as any other, so the rest of the fleet immediately sees "this worker has it too." Which worker gets picked for the download is still just disk headroom and smallest download size (existing logic) — **bandwidth is not measured**, and there's no bandwidth-based selection.

**Trust model**: the platform Ed25519-signs the fetch manifest; the agent verifies that signature before downloading anything, then verifies each file's sha256 after it lands. Both checks must pass before the file is moved into place under `models_dir`'s matching subfolder — a bad signature or hash mismatch rejects the whole batch, leaving no partial files behind. Downloads always land under `models_dir`; the agent sanitizes every path so a manifest entry can never write outside it.

**A worker's own download budget also gates queueing**: hello reports the agent's configured `max_fetch_gb` (see above) to the platform, and a worker whose budget can't cover a job's whole missing-model set is not counted fetch-capable for it — the same way a worker without enough free disk isn't. So a fresh federation with one auto-fetch worker at the default 20 GB budget gets an actionable 400 at submission time (naming the models) for a curated set bigger than that — e.g. the FLUX.1-dev workflows' ~32 GB set or the MiniMax-H3 pipeline's ~40 GB set, both of which exceed the default budget — rather than a job that dispatches and then fails mid-download. Either raise `max_fetch_gb` on at least one online, opted-in worker, or place the files manually under `models_dir`, to clear it.

**What happens if upstream re-uploads a curated file (stale guide hash)**: the agent always verifies the downloaded bytes against the SIGNED hash, so a stale guide value can never land the wrong file — the failure is clean, just repeated: every job that needs the model re-downloads it, verification fails, and the job fails, until either (a) the platform's curated registry (`SOURCES` in `cloud/src/core/model_guide.ts`) is updated to the new official hash, or (b) any one worker actually downloads/holds the real current file and reports its hash through the normal inventory scan — that worker's reported hash becomes a learned consensus row, which always takes precedence over the built-in guide value from then on (see "Curated models auto-download..." above), and every worker in the federation can fetch from it immediately. Recovery needs only ONE worker to get the correct file by any means (manual download, an old backup, etc.) and let it scan/report normally — nothing is permanently broken.

Download progress shows on the job's card in the console (`stage: "fetching_models"` plus a percentage and the current filename). Once a download completes, the model isn't recorded as "this worker has it" until the next periodic local scan (up to 10 minutes later) reports its hash to the server.

**A hash conflict is permanent and needs manual recovery**: if two workers report different sha256 values for the same name/size (usually a corrupted or swapped file on one of them), the server logs a `model_manifest: sha256 conflict for ...` WARNING and marks that `model_hashes` row as conflicted (`conflict = 1`), permanently excluding it from the fetch manifest from then on — it does **not** self-heal on restart or on a later, correct report. Once you've confirmed which copy is right, an admin has to fix it directly in the database:

```sql
UPDATE model_hashes SET conflict = 0 WHERE name = '...' AND size_bytes = ...;
```

There's no admin-UI conflict-resolution button this phase — this manual query is the only recovery path.

### The panel's Download button

The stock ComfyUI frontend puts a **Download** button on its "missing models" card. On a single machine that downloads onto the machine that runs the graph; mounted under ComfyFed's `/comfy` it would download onto **your own laptop**, which does the federation no good at all (which is why the platform already strips model urls and hashes out of the official template JSON before it reaches the browser — see "Embedded workflow editor"). As of 2026-09-19 that button is wired to the platform's own route instead: pressing it creates a `kind=model_fetch` **download-only job**, dispatched to an eligible worker in the federation, which pulls the file into its own `models_dir`. The panel shows the progress in place (percentage and current filename), and not one byte goes through your browser.

**The decision order once you press it** (any step that fails returns a 400 on the spot, with an actionable message, and creates no job):

1. **Already in the fleet** → refused (`already_present`). Any **registered** worker having the file in its inventory counts, offline ones included — the model is in the federation, the panel's missing-models card is just stale.
2. **A live job for the same model already exists** → no duplicate job; the existing `job_id` comes back with `reused: true`.
3. **The platform knows this model** → it takes the existing **signed manifest** path (one of the 12 curated built-in models, or a model the federation has already learned a consensus hash for): the proper entry with its sha256 is used and **the url in the request is ignored entirely** — no allowlist check, no HEAD.
4. **The platform doesn't know it** → only then does it take the unverified-source path: the url's **origin** must be `https://huggingface.co` or `https://civitai.com` (matched on the parsed scheme + host, not a string prefix, so `https://huggingface.co.evil.com/...` does not pass; https and the default port only).
5. **HEAD for the size** → a HEAD (10 s timeout) that must yield a `Content-Length`. No length is `size_unknown`; a 401/403 is `gated` (a login-walled model such as the FLUX.1-dev files — neither the platform nor the worker has credentials, and refusing up front beats a worker failing halfway through). Redirects are followed **by the platform, one hop at a time**, and every hop — the final url included — must clear step 4's allowlist again or it is refused as `untrusted_url`; the chain is capped at 5 hops. This is what stops an allowlisted url from bouncing a self-hosted server at `http://127.0.0.1:…` or a LAN address (SSRF / an internal port oracle).
6. **Pick a worker** → it must be **online**, have `auto_fetch_models` on, run agent **0.1.14 or newer** (protocol 5, the first version that understands `kind=model_fetch`), have free disk of **more than 1.2× the file size**, and have the file fit its own `max_fetch_gb` budget. The agent-version bar applies **whether step 3 or step 4 produced the entry**: even a platform-known, sha256-bearing entry is never offered to an older agent, because such an agent does not know the `kind` field at all — it would treat the download-only job as an ordinary one and run the empty `{}` workflow, and fail it. If nobody qualifies the answer is `no_worker`, and the message lists the **real** reasons (nobody new enough vs. nobody with the disk/budget) rather than a blanket "no workers".

**The trust model for an unverified-source entry**: a model the platform doesn't know has no sha256 for the agent to check against, so the signature covers **the url itself** — the payload is `name|directory|url|size_bytes|unverified`, signed with the platform key (Ed25519). The agent verifies the signature, downloads from that url only, accepts that size only, and does **not** try P2P (with no hash there is no content addressing, so there is no "the same file" to find). When it finishes it reports the sha256 it measured itself alongside `job_done`. The platform records that as its first evidence in `model_hashes` (the existing first-seen-wins / conflict rules apply unchanged), and from then on the model is an ordinary verified, hash-bearing entry for **every other** worker — P2P-able and auto-fetchable. In other words: unverified only ever applies to the first fetch.

**This job is not billable**: a `model_fetch` job has no workflow and runs no inference — it is a download, start to finish. It never enters the execution-time statistics, and its receipt is `kind=model_fetch`, `basis=model_fetch`, `gpu_seconds=0`, `billable=false`. The job's `started_at` is never set (every heartbeat of the download carries `stage=fetching_models`, which is exactly what keeps the clock from starting), so cancelling mid-download mints no receipt at all.

**Reload the panel when it's done**: the editor fetches its node definitions (`/object_info`, which is where the model dropdowns come from) **once per page load**, so a freshly downloaded model does not appear in the dropdowns by itself — press F5 and it's there. Separately, the worker's own model scan (at most every 10 minutes) is what makes the server record "this one has it too" in its inventory.

**Visible in the console**: the job appears on the console's Jobs page like any other, carrying a **"Model fetch"** badge; the job detail page shows the model name, the source url, and whether it was an unverified source.

**Deploy order on the cloud stack**: the `jobs.kind` column comes from D1 migration `0011`, and the moment that Worker code is live **every job INSERT names the column**, so `0011` must be applied **before** the Worker that names it is deployed — otherwise even ordinary prompt submissions break with `no such column: kind`. `npm run deploy` does exactly that order (`wrangler d1 migrations apply comfyfed --remote`, then `wrangler deploy`), and Workers Builds' Deploy command should be set to `npm run deploy` rather than the dashboard's default `npx wrangler deploy`.

### Member-to-member P2P chunked transfer

Besides the official-download-then-GCS-backup chain, workers can also hand model files to each other directly: a worker missing a model a job needs first asks the platform for a transfer grant, then pulls the file in 64 MiB HTTP Range chunks from another online worker that already has it, falling back to the official download chain only if that fails. This unlocks one extra capability: **a private model with no official download URL can still be dispatched, as long as some online member is sharing it right now** — whether it's dispatchable is fully transparent in the dispatch verdict and in the job page's ineligibility reasons, never a silent failure.

**Turning it on (decided for you at install time)** (revised 2026-09-16): the installer asks your router once, right after setup, whether it will open a port automatically (NAT-PMP, then UPnP, 8 seconds max).

- **It answers** → the installer writes `peer_serve: true` and `peer_listen_port: 8850` into `agent.json` and tells you which method worked (natpmp/upnp).
- **It doesn't** → nothing is changed (sharing stays off) and you get one line explaining what to do: turn UPnP on at the router and **re-run the same install command**, or forward the port yourself and set `peer_advertise_host`.
- **Anything you chose yourself is respected**: the installer only enables sharing when `peer_serve` is currently `false` **and** `peer_listen_port` has never been set. A port you configured by hand survives a re-run untouched. Note the one limit of that rule: a `peer_serve: false` **without** a port is indistinguishable from the default and will be enabled — if you want sharing to stay off across re-runs, also set `peer_listen_port` (any port pins the decision).
- **On an upgrade the agent is usually running**: the probe leaves the agent's own 8850 mapping alone and asks the router about the neighbouring port (8851) instead, releasing it right away (since 0.1.13; 0.1.12 refused outright while the agent ran, so an upgrade could never turn sharing on). A positive answer is still written to `agent.json`, **but it only takes effect after the agent restarts**: the installer will not kill an agent that may be mid-job, it prints the command to apply now instead: macOS `launchctl kickstart -k gui/$(id -u)/com.comfyfed.agent`, Linux `systemctl --user restart comfyfed-agent`, Windows `comfyfed stop` then re-run the install command (or sign in again).
- To check for yourself: `comfyfed-agent p2p-probe` prints one JSON line (`method`, `external_ip`, `external_port` and the `probe_port` it actually asked about on success) and leaves no mapping behind.

The relevant `agent.json` settings:

```json
{
  "peer_serve": true,
  "peer_listen_port": 8850,
  "peer_nat_traversal": "auto",
  "peer_advertise_host": "your-public-ip-or-ddns",
  "peer_bind_host": "0.0.0.0"
}
```

- `peer_serve`: when off, the agent never starts the sharing HTTP service, and never advertises any peer address in its handshake (`hello`) — advertised once at handshake time only, not on every heartbeat.
- `peer_listen_port`: required for sharing to actually turn on (`peer_serve: true` alone with no port is a no-op). This listener is a stdlib HTTP server built into the agent — no new dependency — and only serves one route, `GET /peer/models/<name>`; each connection gets a 30-second socket timeout so an idle connection doesn't hold a thread forever.
- `peer_nat_traversal` (default `"auto"`): the agent asks the router to open a port automatically at startup. It tries **NAT-PMP** first (RFC 6886, common on Apple/ASUS and most home routers), then **UPnP IGD** if that doesn't answer, 8 seconds total; if neither answers, it falls back to LAN-only reachability and logs one warning. The lease is 1 hour and the agent renews it every 30 minutes automatically, releasing the mapping when it shuts down. Set `"off"` to never touch the router at all.
- `peer_advertise_host` (optional): **setting it skips automatic port mapping entirely** — you've already told the agent your external address. Good for a fixed IP or DDNS name plus manual port forwarding; **but a DDNS hostname only helps other workers reach you — the platform's reachability check only probes IP addresses**, see "reachability badges" below.
- `peer_bind_host` (optional, default `"0.0.0.0"`): which interface the listener binds. **If this machine has a public IP**, the default exposes the sharing listener to the entire internet — to restrict it to a LAN/VPN, set this to a LAN interface IP or `127.0.0.1` (only combined with a reverse proxy).
- **Double NAT (your ISP is behind NAT too, including the `100.64.0.0/10` CGNAT range)**: when the router maps the port successfully but reports a private address as the "external IP", the agent falls back to the public IP the platform reported at handshake time (see below), and reconnects once to send the corrected address (at most once per hour, to avoid flapping).
- **Sharing and "job intake disabled" are independent**: disabling a worker on the Workers page doesn't stop it from continuing to share; conversely, `peer_serve: false` only turns off sharing.
- **Remember to open `peer_listen_port` in your firewall** — otherwise, once the platform picks you as a seeder, pullers still can't reach you (it just falls back to the official download chain instead of stalling the job, but your share does nothing).

**Security model**: every single transfer requires a grant — there's no anonymous path.

- The puller (an already signature-verified agent request) asks the platform for an **Ed25519-signed transfer grant**, valid for **at least 10 minutes and scaled up with the file size** (the time a whole transfer takes at the agent's default 20 Mbps upload cap, x1.5, plus 10 minutes — about 75 minutes for a 6.5 GB model), bound to one file, one puller, and one seeder — not something a worker can hold onto and reuse at will; once it expires, a fresh one has to be requested.
- The seeder (the worker sharing the model) **verifies the grant on every single request, before even consulting its own inventory**: platform signature, expiry, whether `seeder_id` matches itself, and whether the requested name matches its local inventory — a missing grant, a bad signature, an expired grant, or a mismatched range all **fail closed with a bare 403**, leaking no detail (including whether a given filename even exists — an unauthenticated request always gets 403, never a name-revealing 404).
- Workers **never keep standing trust with each other** — sharing a model with one member today doesn't let that member reconnect without a grant later; every transfer needs a freshly issued one from the platform.
- Per-chunk hashes only exist to abort a bad chunk early; the **final whole-file SHA-256 verification always runs**, same iron rule as any other model download — the chunk table itself is never the trust root.
- **Transfers are currently plaintext HTTP**: the grant only authorizes *who can pull what* — it does not encrypt the content. Both the `X-ComfyFed-Grant` header and the model bytes travel unencrypted, and the grant is a bearer credential: anyone who observes that header while the grant is valid (at least 10 minutes, longer for a big model) can pull the file it authorizes. If your members talk over a public network, only enable this feature within a trusted LAN or VPN (Tailscale, WireGuard, etc.) — don't expose `peer_listen_port` to the open internet.
- **The advertised address is only handed out once the platform has verified it** (revised 2026-09-16): a worker's reported `peer_url` is no longer taken at face value. The platform **statically rejects** any host that's loopback, link-local, or private (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10` CGNAT, `fc00::/7`, `::1`) — marking it "unreachable" outright, **without sending any request at all**, which closes the old "advertise an internal address to trick the platform or another member into requesting it" forwarding surface. Addresses that pass the static check get an active 3-second GET against `<peer_url>/peer/health` (that route needs no grant, returns 204, and carries no identifying information); only ones that answer 204 are handed out as seeders. Heartbeats re-check any address more than 10 minutes stale, and a worker going offline clears the result along with the address. **The probe only understands IP addresses**: when `peer_url`'s host is a hostname (e.g. a DDNS name), the platform never resolves it and never sends a request — it stays "not checked" forever. To make DDNS-based, cross-network seeding work, set `peer_advertise_host` to your current public IP instead, or accept LAN-only sharing. `peer_url`/`peer_lan_url` are always the `http://host:port` shape the agent itself builds — no path, no query string.
- **Reachability badges**: the Workers page's P2P column shows three states — **verified** (the platform can reach it; any member can pull from this worker), **unreachable** (the platform can't; only members behind the same NAT can still pull it over the LAN address), and **not checked** (just connected and still being probed, or `peer_url` is a hostname the platform has never probed). The agent's own `comfyfed status` prints the same thing.
- **Members behind the same NAT use the LAN address**: the platform remembers the public IP each worker connects from. When the puller and the seeder share the same public IP (almost always the same router), the platform puts the seeder's **LAN address first** and its external address second — many home routers don't support hairpin NAT, so connecting to your own external address from inside the LAN can fail even though the mapping is fine; this ordering routes around that. The puller tries each address in turn, 5 seconds per connect attempt, falling back to the official download chain only once every candidate fails.

**Bandwidth accounting**: once a seeder finishes serving a grant, it reports the bytes served back to the platform, which records it in the receipt ledger (`kind: p2p_upload`, non-billable, no GPU seconds); the Reports page's contribution report gains a "P2P upload volume" column, and the Workers page shows whether each worker is currently sharing models and what address it's advertising.

### Job assessment

When a job arrives, the server automatically extracts the node classes, model files, and (when known) VRAM needs from the workflow, and rules on each candidate worker:

- `eligible`: the worker already has every required node and model — dispatch directly.
- `eligible_after_fetch`: models missing on this worker are available through the platform-signed fetch manifest, and there's enough free disk to hold them — sources include models another worker already holds with a reported consensus hash, **and also curated-list models with zero holders fleet-wide right now** (operator-vouched hash), both served through the same download mechanism from the worker's point of view.
- `ineligible`: with plain-language reasons, e.g. missing node classes or insufficient VRAM; a model-related `ineligible` now fires either when the platform genuinely doesn't recognize the model at all (not in the curated list, and no worker has ever reported a consensus hash for it — no trustworthy hash exists to sign a manifest entry with), **or when the model's `model_hashes` row is in conflict** (see "A hash conflict is permanent and needs manual recovery" above) — a curated, perfectly well-known model is still excluded while its row disagrees.

### Embedded workflow editor (`/comfy`)

You don't need your own ComfyUI to build a workflow: the platform can serve the **official ComfyUI frontend** at `/comfy`. Wire up your graph in the browser, press Queue, and the job goes straight into the federation's queue — the results come back in the same interface.

**Since 2026-09-24 the frontend is packaged at build time**: `cloud/scripts/build.mjs` downloads the `comfyui-frontend-package` wheel from PyPI (**both the version and its sha256 are pinned in the source**, and the digest is verified before anything is extracted) and places its `static/` tree under `assets/comfy/`, so `/comfy` works right after deploying either the self-hosted or the Cloudflare edition, with no extra command and no restart. (During development `--skip-comfy` or `SKIP_COMFY_FETCH=1` skips the download; `/comfy` then serves a bilingual notice page instead.)

- `/comfy` and all of its assets only require **being logged in** (any role); without a session you are redirected to `/` (the console login). The panel is a **personal workspace**: everyone only sees the jobs and artifacts they submitted through it — even an admin only sees their own panel jobs there — see the full picture on the console's Jobs page instead.

**Seed the official template library** (optional, but recommended): the frontend wheel is just the UI; it does not carry ComfyUI's official starter workflows. On the Cloudflare edition run one command from `cloud/`:

```bash
npm run seed-official
```

That reads the `comfyui-workflow-templates` meta package's dependencies on PyPI, downloads the matching `-json` and `-media-*` sub-package wheels (each verified against the sha256 PyPI itself reports before anything is extracted) and uploads their `templates/` trees into the R2 bucket under the `official_templates/` prefix. Budget roughly **475 MB** of download; it is safe to re-run. Skipping it breaks nothing: the template browser still opens, just with ComfyFed's own templates only. Once seeded, the sidebar lists ComfyFed's categories first and the official ones after. The self-hosted edition has no seeding command yet (`seed-official` only uploads to Cloudflare R2).

- Official template JSONs have their **model download URLs and hashes stripped** before they reach the browser. Those "Download" buttons fetch to the machine running the browser, which on a stock ComfyUI is the machine running the graph and here is **your laptop** — useless to the federation. Pressing Run with a curated model (the 11 built-in models in the "Model downloads" table below) queues and auto-dispatches a download even with zero holders fleet-wide right now — it's never refused for that. Other models (template-library ones that aren't curated, or anything else a workflow references) carry no operator-vouched hash, so they still need at least one worker in the federation to actually hold the file and have reported a hash before they can enter the download list — pressing Run is refused, with zh-TW guidance naming the file and the worker folder it belongs in, only for a model the platform genuinely doesn't recognize and nobody in the federation holds.

Once it's there, log into the console, go to **Jobs**, and hit the primary **Open workflow editor** button — it opens in a new tab. The old paste-the-API-JSON form is still on that page, tucked into the "Paste API JSON instead" section.

⚠ **Nodes only appear when at least one worker is online.** The node catalogue is not something the platform invents: by default it is the union of the `/object_info` snapshots reported by every **online, enabled** worker. With the whole fleet offline the node panel is empty — that's expected, not a bug.

The Settings page can switch `object_info_mode` from the default union to **intersection**: in intersection mode the editor only shows nodes that **every online worker** has, so anything in the dropdown is guaranteed dispatchable everywhere, at the cost of fewer available nodes. Union mode offers a richer node set but a graph mixing nodes unique to different machines can still fail to dispatch (see next point).

⚠ **In union mode, that catalogue does not describe any single worker.** Nodes visible in the editor may live on different machines. A graph mixing a node only worker A has with one only worker B has **submits fine** — the job is created and queued — but it is ineligible for every worker individually, so it simply **sits in the queue forever** with no error. The Jobs page's ineligibility reasons explain what is missing. `/comfy/api/object_info` returns an `X-ComfyFed-Worker-Count` header saying how many workers the listing came from (in intersection mode, how many workers all agree on it).

**Cancel/Interrupt, Clear queue, and deleting history entries all work for real.** These toolbar buttons in the editor have a real backend behind them now: clicking them actually cancels the underlying federation job (the worker gets an interrupt notification too) — it's no longer a read-only queue/history layer. The one thing to know: **these panel controls only affect jobs submitted from the panel itself** (`origin == panel`). If you submitted via the console's "Paste API JSON" form instead, cancel it from the console's Jobs page. Conversely, **the console's Jobs page and its job-detail page can cancel a job from either origin** — it's the one cancel surface that covers everything.

The compatibility layer now covers "build a graph → queue it → see the results → cancel/clean up" as its main line. Editor features that assume a single local ComfyUI still do not work — **saving workflows to the server, Manager / custom-node extensions, and model browsing** (models live on the workers; the platform has none). Export/import workflows through the browser instead, or paste the API JSON into the console. Editor UI preferences (theme and so on) persist in the `comfy_settings_json` platform setting. The template browser *does* work: out of the box it is stocked with ComfyFed's own templates, and once you have run `npm run seed-official` ComfyUI's upstream gallery is merged into the same sidebar.

**How this relates to bringing your own ComfyUI**: they are two doors into the same federation, not alternatives. The embedded editor is for "I don't have ComfyUI here, or don't feel like launching it". If you already run ComfyUI locally, keep building there, export with "Save (API format)", and paste it into the console. Either way the actual rendering happens on federation workers — each member's own ComfyUI. The platform itself never installs ComfyUI and never runs inference; `/comfy` is only a compatibility layer that translates the official frontend's actions into federation jobs.

### Templates

ComfyFed ships ten **production-proven** workflows, each annotated on the canvas with sticky notes — in Traditional Chinese and English — explaining what every stage does and which node you are supposed to edit. The user-facing rundown of what each one is for lives in the root [README.md](../README.md); this section covers the operational details.

**Opening the browser**: the **Browse Templates** entry in the editor's left toolbar (also under Workflow → Browse Templates, and on the empty-canvas screen) → pick the **ComfyFed** category in the sidebar → click a thumbnail. That **clones** the template into a new untitled workflow; you edit the copy, the template itself is never touched, so if you break it, close it and take a fresh one.

Ten templates (backed by `cloud/packaged/templates/index.json`, packaged into the platform's assets at build time):

| Template | What it is | Size / steps |
| --- | --- | --- |
| **Text-to-image** | Chroma1-HD text-to-image with uncensored weights. Type the idea in Chinese into the red node: the bundled Qwen3-VL-4B Heretic helper writes the English prompt and wires it straight into `CLIPTextEncode`. The default idea is still the wuxia scene from ComfyFed's first end-to-end federation run; replace it and the template draws anything | 768×768, 26 steps |
| **Character portrait** | The same Chroma pipeline in portrait orientation, for single-character reference sheets | 896×1152, 26 steps |
| **Reference to video** | MiniMax H3 Ref2V: one reference photo → a clip of the same person moving, with generated audio. Describe the shot in Chinese in the idea node; the helper writes the English prompt and prepends the `<Picture 1>` tag | 1152×640, 141 frames (~6s), 8 steps via the turbo LoRA |
| **NSFW image-to-video** | The same H3 Ref2V pipeline with nothing filtered (H3's Heretic 32B encoder plus the Heretic 4B helper): one photo of an adult plus an explicit scene written in Chinese. Promoted from the admin's shared "(NSFW)圖生影片" template, bundled with its sample photo `nsfw_i2v_ref.jpg` | 1152×640, 141 frames (~6s), 8 steps via the turbo LoRA |
| **First+last frame to video** | Give MiniMax H3 a first frame, a last frame, and one line describing the motion; it fills in the movement and audio between them | 8 steps via the turbo LoRA |
| **Video concat** | Join two clips end-to-end, picture and audio both. Zero models | — |
| **Image intro + video** | Hold a still image as a title card, then play a video clip. Zero models | — |
| **Video trim** | Cut a start-second + length span out of a clip. Zero models | — |
| **Image upscale** | 4x super-resolution upscale of a still image via RealESRGAN | — |
| **Image to prompt** | Upload a reference image and a short ask; a local Qwen3-VL model writes the polished English prompt for you | — |
| **Text to prompt** | Paste a rough idea and the same local Qwen3-VL model rewrites it into a structured English prompt | — |

**Change one thing and run.** The four model-heavy templates (text-to-image, character portrait, reference-to-video, NSFW image-to-video) use a purple group box labelled "only edit here". Since 2026-09-20 text-to-image, reference-to-video and NSFW image-to-video embed the text-to-prompt chain (a red idea node that takes Chinese → Qwen3-VL-4B Heretic `TextGenerate` writes the English prompt → wired straight into the prompt input; the two video ones also prepend `<Picture 1>` automatically), so the idea node is all you edit (plus the reference-image node on the video ones); character portrait still takes an English prompt directly. The other six use a more compact three-group layout (①②③ notes) — follow the notes the same way. Press **Run**: the graph becomes a federation job, and when a worker finishes, the result renders inside the output node on the right and is also downloadable, with its receipt, from the console's Jobs page.

**Bundled assets**: the sample inputs for templates that need a reference image or clip (reference-to-video, NSFW image-to-video, image-to-prompt, image-upscale, etc.) ship with the build (`cloud/packaged/templates/assets/`). The first time anyone opens the template browser the platform copies them into a **shared** staging namespace (under R2's `staging/`; under `<data-dir>/state/` when self-hosting), so the `LoadImage`/`LoadVideo` dropdown resolves out of the box; these shared samples never appear on anyone's Files page and cannot be deleted. To use your own, upload it on the node (or drop the file onto the canvas) — uploads land in your own staging area and are copied into the job's inputs at submit time.

**Custom templates (My templates)**: the **「我的範本 / My templates」** category at the very top of the template browser is **yours alone** — no other user sees it, not even an admin (an admin's own folder is a different story: see "Shared library" below). There are two ways to fill it, neither of which needs any new UI:

- in the editor, **Save As** the workflow under the name `templates/<name>` (the workflow browser already saves into userdata's `workflows/...`);
- or upload straight to `workflows/templates/<name>.json` through the existing userdata API.

For a thumbnail, drop a matching `<name>-1.webp` (`.png`/`.jpg` also work) beside it in the same folder; without one the card simply has no preview. Reload the template browser after saving and it is there — clicking it still **copies** the graph onto the canvas.

Naming rules: a single filename only — no `/`, `\`, `:`, no leading `.`/`..`, no trailing dot or space, and no Windows reserved device name (`con`, `nul`, `com1`, …). These are exactly the rules every other userdata file follows; a file that breaks them is never listed. Each entry's name in the index is `my_<name>`, which in practice keeps personal templates clear of ComfyFed's own (`comfyfed-*`) and of the official library. Precisely: **your own file wins**. A request for `my_<x>` looks in your `workflows/templates/<x>.json` first and only falls through to the bundled/official library on a miss — so if the official library ever shipped a template literally named `my_<x>` and you happened to own an `<x>`, you would see yours (**only for you**; nobody else's view changes). **An empty folder produces no category at all** (no empty group is shown). To delete a template, delete its `.json` (and its thumbnail).

**Shared library (admin-published templates)**: an **admin's** (`role=admin`) `workflows/templates/` folder is **not private — it is the shared library**. Every file in it shows up in **everyone's ComfyFed** category. An admin "uploads or modifies a template" exactly the way any user does (Save As `templates/<name>`, or a userdata upload); only the outcome differs:

- the file is served **un-prefixed** as `<name>` and takes **precedence over** the bundled and official copies. So an admin who opens `comfyfed-wuxia-t2i`, edits it and **saves under the same name** has **replaced that platform template for everyone** (the index keeps the bundled card's title/description/tags); saving under a new name appends a new entry at the end of the ComfyFed category (title = filename; a matching `-1.webp` thumbnail works the same way).
- an admin therefore has **no "My templates" of their own**: the whole folder is public, and `my_<name>` never resolves for an admin.
- ordinary users are **untouched**: opening a shared template and doing Save As writes into their own userdata and shows only in their own "My templates" — **the shared library is never modified**.
- several admins' folders are merged; on a name clash the admin with the lower uid wins. A disabled admin stops publishing.

**Upload limits and the storage quota**: every uploaded file has a **per-file ceiling** (default **50 MB**) and every user has a **storage quota** (default **5 GB**). The per-file cap applies to editor uploads, workflows saved through `/userdata`, and assets attached to a console job submit. The quota counts a user's staging uploads (`staging/<uid>/`), saved panel files (`userdata/<uid>/`) and, since 2026-09-24, the inputs and outputs of every job they own (see "Storage quota counts everything a user keeps" above). Exceeding it answers 413 (`quota_exceeded`) with a message naming the amount used and the quota. An admin adjusts both under **Console → Settings → Upload limits** (1–1024 MB per file; 0.1–1024 GB quota); they are stored as the `upload_max_file_mb` and `upload_user_quota_gb` settings and take effect immediately, no restart. Each user sees their own usage and quota on the Settings page; the upload list and delete controls live on the Files page (next section).

**Per-user overrides (2026-09-20)**: an admin can give one user their own per-file cap and storage quota under **Console → Users → that row's "Limits & NSFW"**; these **take precedence over the platform defaults**, and a blank field falls back to the platform value. The same dialog holds a **"May submit NSFW work"** switch — **on for every user by default**. Turned off, every submission from that user (console submit, recipe `run`, panel Queue) first goes through the **NSFW review**: keyword rules run first (a recipe declaring `nsfw_ok`, model file names containing heretic / uncensored / nsfw and the like, explicit words in the positive prompts — negative prompts are ignored); if nothing matches and the admin has stored a **Claude API key** under **Settings → NSFW review**, the positive prompts and model names are also judged once by Claude Haiku 4.5. A job judged NSFW is refused outright and never queued, with error code `nsfw_not_allowed` and a message telling the user to contact an administrator (flipping the switch back on is the release). With no key stored only the rules run; if the review service is unreachable or answers something unparseable the job is **allowed and logged** — a third-party outage never stops the platform accepting work. The key lives in the `nsfw_check_api_key` setting; the API only ever reports whether one is set, never the plaintext.

⚠ The models a template names must actually be installed **on a worker** for the dropdowns to offer them and for the job to be dispatchable. Otherwise the job is created but sits in the queue; the Jobs page's ineligibility reasons say what is missing. The six zero-model templates (video concat, image intro + video, video trim, etc.) run fine on a brand-new worker with no models at all.

### Files page: uploads and outputs

The console's **「檔案 / Files」** page gathers a user's own files in one place:

- **Uploads**: the reference images/assets you uploaded in the editor (staging), with refresh and per-file delete. Deleting does not affect jobs already submitted (the bytes were copied into the job's inputs at submit time).
- **Outputs**: every finished job's results, shown as **`job name / date (YYYY-MM-DD) /`** two-level folders. Images render as thumbnails, videos show their first frame and play inline, other types show the filename. Each file can be **downloaded again** or **deleted**; a date folder has a **delete all** button. Several jobs with the same name on the same day share one folder; the cards carry the short job id to tell them apart.
- **The job name** is the job's `label`: a recipe run uses the recipe id; a panel submit uses the `filename_prefix` of the workflow's first `Save*` node (ComfyUI already names output files by it, default `ComfyUI`); console/MCP submits may set their own (max 64 chars); failing all, the first 8 characters of the job id. The Jobs list shows it too.
- **Deleting an output deletes only the file**: the job row, its receipt and the output hashes all stay (the ledger is untouched); the name is dropped from `result_files` and can no longer be downloaded. A job that is still queued/assigned/running cannot be deleted from (409).
- Outputs **count** toward the storage quota (since 2026-09-24); deleting them here frees the space. A plain user only ever sees their own uploads and outputs; an **admin** gets a "My files / All users" switch at the top of the page — "All users" lists every user's uploads and outputs (each row tagged with its owner) and lets the admin delete on that user's behalf. The Jobs list works the same way: an admin sees everyone's jobs and can cancel or retry them.

API: `GET /api/me/artifacts` (every output of the caller, with size and kind; admin: add `?scope=all` for every user's, each file gaining `user_id`/`username` — likewise `GET /api/staging?scope=all` and `DELETE /api/staging/{name}?user=<uid>`), `DELETE /api/jobs/{id}/artifacts/{filename}` (one file), `DELETE /api/jobs/{id}/artifacts` (all of a job's); downloads keep using `GET /api/jobs/{id}/artifacts/{filename}`.

### Model downloads

A fresh worker has none of these files, which makes the model-dependent templates dead on arrival. They are too large for git, so every file below comes with two links: the **official** one (its HuggingFace/upstream home — prefer this), and a **backup** on our public GCS mirror at `https://storage.googleapis.com/comfyfed-models/models/`, whose layout mirrors ComfyUI's `models/` directory and which is there for when the official source is down or gated. Download a file and drop it under the matching subfolder of the worker's `ComfyUI/models/`.

| File | Size | Target path | Official | Backup |
| --- | --- | --- | --- | --- |
| `Chroma1-HD-fp8mixed.safetensors` | 8.56 GB | `models/diffusion_models/` | [Official](https://huggingface.co/Comfy-Org/Chroma1-HD_repackaged/resolve/main/split_files/diffusion_models/Chroma1-HD-fp8mixed.safetensors) | None yet (not mirrored — use the official link) |
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
| `qwen3-vl-4b-heretic.safetensors` | 8.27 GB | `models/text_encoders/` | [Official](https://huggingface.co/DreamFast/Qwen3-VL-4b-Heretic-ComfyUI/resolve/main/qwen3-vl-4b-heretic.safetensors) | None yet (not mirrored — use the official link) |
| `RealESRGAN_x4plus.pth` | 0.06 GB | `models/upscale_models/` | [Official](https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth) | [Backup](https://storage.googleapis.com/comfyfed-models/models/upscale_models/RealESRGAN_x4plus.pth) |

Everything together is about **97.2 GB**; the two Chroma templates (text-to-image, character portrait) need about **18.0 GB** (`Chroma1-HD-fp8mixed` + `t5xxl_fp16` + `ae` — the 22 GB `flux1-dev` is now used only by the `flux-t2i` recipe); the reference-to-video template alone needs about **40.5 GB**; the two prompt-helper templates (image-to-prompt, text-to-prompt) share a single model, `qwen3-vl-4b-heretic` (the uncensored build of Qwen3-VL-4B-Instruct), and need only **8.27 GB** — text-to-image, reference-to-video and NSFW image-to-video embed that helper chain, so each adds the same 8.27 GB on top (about 26.3 GB for text-to-image, about 48.8 GB for each of the two H3 video templates) — the old `qwen3vl_4b_bf16` is no longer used by any template but stays in the built-in download list; image upscale needs only RealESRGAN's **0.06 GB**; video concat, image-intro-video, and video trim need no models at all. Each model-dependent template's canvas also carries a "⓪ Missing models?" note (the zero-model templates skip it) listing exactly what that template needs.

**No restart required**: once the files are in place you do not need to restart ComfyUI or the agent — it rescans its local model inventory every 10 minutes and reports back, and the job assessment turns green on its own. Restart the agent if you want that to happen immediately instead of waiting.

### API tokens / AI access

Any user can mint a bearer token for themselves under **Console → Settings → API token / AI access** and hand it to an AI client over MCP. The full walkthrough is in **[Driving ComfyFed from an AI client](MCP.en.md)**.

- **The plaintext appears exactly once**, at creation (a `cft_` prefix plus 32 random bytes); the server stores only its sha256, so it can never be shown again. The neighbouring "download config" button builds `comfyfed-mcp.json` (`{"platform_url", "token", "expires_at"}`) in the browser; saved as `~/.comfyfed/mcp.json` it is exactly what `comfyfed-mcp` reads by default.
- **Valid 30 days**, at most **10** active tokens per user (an eleventh answers 409 `auth.too_many_tokens` — revoke one first). The list shows name, prefix, created/expires/last-used and status, with a revoke button.
- **A token is equivalent to its owner**: `Authorization: Bearer cft_...` works on every API a session can use (role is read live from `users`) and **skips CSRF** — CSRF protects against a browser attaching cookies cross-site, and headers are never attached cross-site. When an `Authorization` header is present it is the only thing consulted; there is no fallback to the cookie.
- **A token cannot breed**: creating, listing and revoking tokens, changing the password and logging out are **cookie-only** — a bearer call gets 401.
- **Changing the password invalidates every token**: a token records the `session_epoch` it was minted under, and a password change advances that epoch, retiring tokens and sessions together. Expiry, revocation and a disabled user all answer the same 401 `auth.required`, deliberately without distinguishing the reason (otherwise the endpoint becomes an oracle about other people's tokens).
- `last_used_at` is written at most once every 5 minutes, so the "last used" column can lag by that much — the alternative is a database write on every single request.

### Recipes

A recipe is a fixed, **known-good** workflow that ships with the platform, exposed as a handful of parameters. It is the submission path for an AI client (or anyone who does not want to assemble a node graph): pick a recipe, fill parameters, and the platform validates them, renders the workflow and then goes down **exactly the same** job-creation and dispatch path as `POST /api/jobs`. Recipes are files bundled into the Worker (`cloud/src/core/recipes/<id>.json`), so changing one means shipping a release — there is no online editor.

Endpoints (all require a login; `run` uses `require_csrf_user`, so a bearer token can submit directly):

- `GET /api/recipes` → the list without workflows, ascending by `order`, so **the first entry is the default**; each carries a `missing_models` array.
- `GET /api/recipes/{id}` → the same entry plus its `workflow`.
- `POST /api/recipes/{id}/run` with `{"params": {...}}` → `201 {"job_id", "recipe_id", "params", "model_fetch_jobs"}`. The returned `params` is what actually ran: defaults applied and `seed: -1` replaced by a real random value. A bad type, range or step answers 400 `recipes.bad_params`, naming the first offending parameter.

The three built-ins:

| Order | id | What | Models | `nsfw_ok` |
| --- | --- | --- | --- | --- |
| 1 | **`chroma-t2i`** (default) | Text-to-image, 1024×1024 / 26 steps / cfg 3.5 | `Chroma1-HD-fp8mixed` (9.2 GB, **auto-fetched when missing**), `t5xxl_fp16`, `ae` | ✅ |
| 2 | **`h3-t2v`** | Text-to-video with audio, 24 fps, 8-step turbo LoRA, 5 seconds by default | The MiniMax H3 set plus the uncensored heretic text encoder | ✅ |
| 3 | **`flux-t2i`** | Text-to-image with the official Flux.1-dev weights, kept for comparison | `flux1-dev`, `clip_l`, `t5xxl_fp16`, `ae` | ❌ |

`nsfw_ok` records whether the **weights themselves** avoid explicit content: the official Flux dev weights do, which is why `flux-t2i` is flagged false and is not the default, while both defaults use uncensored weights. The platform reads the flag in exactly one situation: a user whose NSFW permission an admin has turned off (see "Per-user overrides" above) is refused by the NSFW review when running an `nsfw_ok: true` recipe; nobody else is affected.

**The default recipe downloads a model on its first run.** `chroma-t2i` declares `model_sources`, so when no live worker holds `Chroma1-HD-fp8mixed.safetensors` (9,193,379,316 bytes), `run` calls the very same `create_fetch_job` the panel's Download button uses (same de-duplication, same allowlist, same HEAD probe) **before** creating the job, and the response's `model_fetch_jobs` is non-empty. The image job is created and queued as usual and becomes dispatchable once a worker has the file and reports its inventory — on a home connection those 9.2 GB can take 10+ minutes. If the download cannot be scheduled at all (no capable worker, say), that is only logged; it never blocks the submission.

### Publishing an agent release

**Since 2026-09-24 every deploy is an agent release**; there is no wheel to upload by hand anymore. How it works:

1. At build time `cloud/scripts/build-wheel.mjs` packages `agent/comfyfed_agent/` into `comfyfed-<version>-py3-none-any.whl` (the version comes from `__version__` in `__init__.py` and is asserted equal to `pyproject.toml`), places it under `cloud/assets/agent/` and writes `release.json` (`{"version","filename","sha256"}`) next to it.
2. On the Worker side, `core/agent_release.ts` reads `assets/agent/release.json` the first time the platform is asked for the agent version (an agent's startup call to `/api/agent/version`, or anyone opening the console's Workers page). If the bundled version is **higher** than the current `agent_latest`, it signs `{version}|{sha256}` with the platform key and writes the five `agent_*` settings in one go (`agent_latest` / `agent_min_supported` / `agent_wheel_url` / `agent_wheel_sha256` / `agent_wheel_sig`). Each isolate checks once; a lower version never downgrades.
3. **`min_supported` is never raised automatically**: older agents keep connecting, just possibly without newer features. Only change `agent_min_supported` by hand for a genuine breaking change.

An agent asks `/api/agent/version` at every start, compares versions, downloads the wheel and installs it only if both the sha256 and the platform signature verify. **The signed payload is `{version}|{sha256}`**: binding the version into the signature means an old release's signature cannot be replayed to advertise a newer version, so a downgrade attack does not work. After installing, the agent exits with **code 75** and lets its supervisor start the new build: systemd (`Restart=on-failure`), launchd (`SuccessfulExit=false`) or `launcher.ps1` on Windows. `comfyfed stop` exits 0, so a stop remains final.

**One-click updates from the console (agent 0.1.18+)**: on the Workers page, every online worker that is behind gets an "Update" button, and there is an "Update all" above the list (both admin only). The platform sends `{"type":"update_agent"}` to the agent, which answers `{"type":"update_ack","status":…,"detail":…}` with one of five statuses:

| status | Meaning |
| --- | --- |
| `updating` | Idle, updating now; once installed it restarts with exit code 75 and reconnects on its own |
| `deferred` | Busy; the update applies once the current job ends (success, failure or cancel) |
| `up_to_date` | Already on the latest version |
| `declined` | The machine's owner set `auto_update: false` in `agent.json`; the owner's setting beats the remote admin |
| `failed` | Download or signature verification failed; the old version keeps running |

If no ack arrives within 15 seconds the result is `sent`. **Agents older than 0.1.18** do not understand the command (the button returns 409 `workers.agent_too_old`); restart the agent once on that machine and it updates itself at startup.

**Manual publish (override)**: `POST /api/workers/agent-release` still exists. After logging in, POST the wheel directly (it is stored under `releases/` in R2 — the local R2 under `<data-dir>/state/` when self-hosting; the signature and the five settings are written exactly as the automatic path does), and a manually published **higher** version wins. The wheel is the build output, `cloud/assets/agent/comfyfed-<version>-py3-none-any.whl`:

```bash
curl -X POST "https://<your-platform-url>/api/workers/agent-release?filename=comfyfed-<version>-py3-none-any.whl"   -H "X-CSRF: <csrf from login>" -b cookies.txt   --data-binary @cloud/assets/agent/comfyfed-<version>-py3-none-any.whl
```

Anyone can fetch the wheel from `/agent/<filename>` (automatic releases) or `/api/agent/releases/<filename>` (manual releases) without logging in; integrity is guarded by the sha256 and platform signature that `/api/agent/version` advertises.

⚠ **The platform signing key may be kept offline**: if you would rather not keep `PLATFORM_ED25519_SEED` on the live host, sign `"{version}|{sha256}"` yourself on an offline machine and set the five `agent_*` settings above by hand. The agent verifies them identically either way. Note that the automatic release only writes when the bundled version is higher than `agent_latest`, so a higher hand-written version is never overwritten.

### Known limitations

- **Billing is actual execution seconds, not queue wait**: a receipt's `gpu_seconds` is built from `exec_seconds` — guaranteed by agent protocol 2 — the moment ComfyUI's `/queue` first reports the prompt under `queue_running` to completion, capped at the wall-clock span (`finished_at - started_at`). It only falls back to the wall-clock figure when `exec_seconds` couldn't be measured (an older agent, or an unreachable `/queue`); the receipt's `basis` field records whether that run was billed on `exec` or `wall`. This is deliberate: one worker can serve local use plus several platforms at once, and billing queue-wait as GPU time would double-charge every platform for the same idle stretch, breaking future revenue sharing. Time a worker spends queued behind other platforms' (or local) work is excluded from this platform's receipts.
- **Failed/cancelled jobs produce a non-billable receipt for the record, but don't count toward totals**: a job that fails or gets cancelled still mints a receipt (`kind` of `failed` or `cancelled`, `billable=false`) so there's an auditable trail of where that time went — but only `kind=completed` (`billable=true`) receipts feed the Reports page's contribution totals and leaderboard.

### Roadmap

**Phase 2**
- Model manifest distribution (to actually implement `eligible_after_fetch` transfers)
- S3/R2-compatible artifact storage

**Phase 3** (**multi-user accounts plus multi-admin support and payout estimation shipped in Phase 3.0**: an admin can create and manage other user accounts, and the Reports page offers payout estimation — enter a pool amount and it's split by each worker's contribution share; see "Users & permissions" above. **Member-to-member P2P chunked transfer shipped in Phase 3.1 (2026-09-14)**, see "Member-to-member P2P chunked transfer" above. The item below remains outstanding)
- ~~Member-to-member P2P chunked transfer~~ ✅ Phase 3.1
- Revenue-share ledger (today's payout estimation only computes ratios — it doesn't record actual disbursements)

**ComfyFed Cloud** (shipped): the same Worker deployed to Cloudflare Workers + D1 + R2, so there's no machine of your own to keep powered on. See [`cloud/README.md`](../cloud/README.md).

### License

License: [AGPL-3.0](../LICENSE).
