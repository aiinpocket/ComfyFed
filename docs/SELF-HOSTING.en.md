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

### Users & permissions

Login is now **username + password** (not a single admin password). The first account created by the install wizard is always named `admin`, with the admin role.

**Creating users**: log in as an admin, go to Console → **Users** → create a user, giving it a username and a role (admin or user). Leave the password blank and the system generates a random one, **shown exactly once** at creation time (with a copy button) — hand it to that person right away. If it's lost, an admin can hit "Reset password" on the same page to issue a fresh one-time password.

**What each role sees**:

- **User**: only their own jobs and artifacts (Dashboard, Jobs, and Reports all scope to their own data); Settings is trimmed down to change-password and language; no visibility into anyone else's jobs. **The Workers page and workflow templates are open to every role** — workers are shared fleet infrastructure, so a user sees the whole fleet's status (online/offline, hardware, model counts), but the **issue-token / disable / delete** controls and their APIs stay admin-only.
- **Admin**: sees everyone's jobs and stats in the console, plus the Workers, Users, and full Settings pages, and all three report tabs (contributions, per-user usage, payout estimation).
- The embedded workflow editor (`/comfy`) is a **personal workspace for every role**: whether admin or user, the panel only shows jobs that person submitted through the panel — see the full picture on the console's Jobs page instead.

Every account on the Users page can be **disabled/re-enabled**, have its **role changed**, and have its **password reset**; disabling a user immediately invalidates all of its existing logins and blocks new ones. There's no delete (jobs and receipts need to keep their attribution), and **the last remaining admin can't be disabled or demoted**, so you can't lock yourself out.

**Per-user usage and payout**: admins get two extra Reports tabs — "**Per-user usage**" (each account's job count and GPU-seconds) and "**Payout estimation**" (enter a payout pool amount and it splits it across workers by their share of GPU-seconds in the date range). A regular user's Reports page only shows their own "**My usage**".

**Upgrade note**: when upgrading from an older install, the existing admin password automatically becomes the `admin` account (**the password itself doesn't change** — no reset needed), and all existing jobs/receipts are attributed to that account. But because the session cookie format changed, **everyone has to log in again once after the upgrade** (admin included) — old login cookies are treated as unauthenticated, with no compatibility fallback. Both self-hosted (Alembic migration) and Cloud (D1 migration 0006) run this data migration automatically on upgrade/deploy — no manual steps needed.

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

1. In the console, go to **Workers** → add, name it, and the platform issues a one-time registration token and shows three one-line install commands right away (Windows PowerShell / Windows cmd / Linux + macOS), each with its own copy button.
2. On the machine that will contribute compute, paste the matching line into a terminal. **No administrator/sudo needed**: on Windows a plain terminal works (an elevated one gets a Task Scheduler autostart, a non-elevated one automatically falls back to a per-user registry Run key — same effect); on Linux/macOS run as your normal user, **without sudo** (everything installs into your home directory; the script refuses to run as root). The script is safe to re-run: an already-registered machine skips the registration step automatically.

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
pip install -e .
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

### Job dispatch: light jobs go to weak GPUs first

Dispatch isn't a random pick among eligible workers: jobs that need zero models (pure post-processing work like video trimming or concatenation) are preferentially routed to workers with no dedicated GPU or weaker VRAM (Mac/CPU-only machines included), saving the model-heavy, VRAM-hungry rendering jobs for the real GPUs. That means a laptop can pull its weight in the federation instead of a 4090 getting stuck doing video-editing busywork.

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

**Curated models auto-download even with zero holders fleet-wide**: the 11 curated models in the platform's built-in download list (see the "Model downloads" table below) each carry an operator-vouched official sha256/size, so they don't need any worker to have actually held the file and reported a hash first — every other model still needs at least one worker in the federation to have held it and reported a hash, with agreement across reporters ("consensus"), before it can enter the manifest; once a real consensus hash does show up, consensus always wins over the built-in value. As long as some worker has `auto_fetch_models` on and enough free disk, a curated model with zero current holders still gets dispatched for download — it never gets stuck just because nobody has it yet — and once the download completes it's reported the same way as any other, so the rest of the fleet immediately sees "this worker has it too." Which worker gets picked for the download is still just disk headroom and smallest download size (existing logic) — **bandwidth is not measured**, and there's no bandwidth-based selection.

**Trust model**: the platform Ed25519-signs the fetch manifest; the agent verifies that signature before downloading anything, then verifies each file's sha256 after it lands. Both checks must pass before the file is moved into place under `models_dir`'s matching subfolder — a bad signature or hash mismatch rejects the whole batch, leaving no partial files behind. Downloads always land under `models_dir`; the agent sanitizes every path so a manifest entry can never write outside it.

**A worker's own download budget also gates queueing**: hello reports the agent's configured `max_fetch_gb` (see above) to the platform, and a worker whose budget can't cover a job's whole missing-model set is not counted fetch-capable for it — the same way a worker without enough free disk isn't. So a fresh federation with one auto-fetch worker at the default 20 GB budget gets an actionable 400 at submission time (naming the models) for a curated set bigger than that — e.g. the FLUX.1-dev workflows' ~32 GB set or the MiniMax-H3 pipeline's ~40 GB set, both of which exceed the default budget — rather than a job that dispatches and then fails mid-download. Either raise `max_fetch_gb` on at least one online, opted-in worker, or place the files manually under `models_dir`, to clear it.

**What happens if upstream re-uploads a curated file (stale guide hash)**: the agent always verifies the downloaded bytes against the SIGNED hash, so a stale guide value can never land the wrong file — the failure is clean, just repeated: every job that needs the model re-downloads it, verification fails, and the job fails, until either (a) the platform's curated registry (`model_guide.py`/`model_guide.ts`'s `SOURCES`) is updated to the new official hash, or (b) any one worker actually downloads/holds the real current file and reports its hash through the normal inventory scan — that worker's reported hash becomes a learned consensus row, which always takes precedence over the built-in guide value from then on (see "Curated models auto-download..." above), and every worker in the federation can fetch from it immediately. Recovery needs only ONE worker to get the correct file by any means (manual download, an old backup, etc.) and let it scan/report normally — nothing is permanently broken.

Download progress shows on the job's card in the console (`stage: "fetching_models"` plus a percentage and the current filename). Once a download completes, the model isn't recorded as "this worker has it" until the next periodic local scan (up to 10 minutes later) reports its hash to the server.

**A hash conflict is permanent and needs manual recovery**: if two workers report different sha256 values for the same name/size (usually a corrupted or swapped file on one of them), the server logs a `model_manifest: sha256 conflict for ...` WARNING and marks that `model_hashes` row as conflicted (`conflict = 1`), permanently excluding it from the fetch manifest from then on — it does **not** self-heal on restart or on a later, correct report. Once you've confirmed which copy is right, an admin has to fix it directly in the database:

```sql
UPDATE model_hashes SET conflict = 0 WHERE name = '...' AND size_bytes = ...;
```

There's no admin-UI conflict-resolution button this phase — this manual query is the only recovery path.

### Member-to-member P2P chunked transfer

Besides the official-download-then-GCS-backup chain, workers can also hand model files to each other directly: a worker missing a model a job needs first asks the platform for a transfer grant, then pulls the file in 64 MiB HTTP Range chunks from another online worker that already has it, falling back to the official download chain only if that fails. This unlocks one extra capability: **a private model with no official download URL can still be dispatched, as long as some online member is sharing it right now** — whether it's dispatchable is fully transparent in the dispatch verdict and in the job page's ineligibility reasons, never a silent failure.

**Enabling it (off by default)**: each worker decides for itself whether to share its models, via `agent.json`:

```json
{
  "peer_serve": true,
  "peer_listen_port": 8850,
  "peer_advertise_host": "your-lan-or-public-ip",
  "peer_bind_host": "0.0.0.0"
}
```

- `peer_serve` (default `false`): when off, the agent never starts the sharing HTTP service, and never advertises any peer address in its handshake (`hello`) -- advertised once at handshake time only, not on every heartbeat.
- `peer_listen_port`: required for sharing to actually turn on (`peer_serve: true` alone with no port is a no-op). This listener is a stdlib HTTP server built into the agent — no new dependency — and only serves one route, `GET /peer/models/<name>`; each connection gets a 30-second socket timeout so an idle connection doesn't hold a thread forever.
- `peer_advertise_host` (optional): left unset, the agent auto-detects its LAN IP to advertise; if the worker sits behind NAT and other members need a fixed IP or DDNS name to reach it, set the reachable address here.
- `peer_bind_host` (optional, default `"0.0.0.0"`): which interface the listener binds. **If this machine has a public IP** (a rented GPU box, the common case), the default exposes the sharing listener to the entire internet the moment `peer_serve` is on — to restrict it to a LAN/VPN, set this to a LAN interface IP (e.g. `192.168.1.10`) or `127.0.0.1` (only combined with a reverse proxy).
- **Remember to open `peer_listen_port` in your firewall** — otherwise, once the platform picks you as a seeder, pullers still can't reach you (it just falls back to the official download chain instead of stalling the job, but your share does nothing).
- **Sharing and "job intake disabled" are independent**: disabling a worker on the Workers page (so it stops taking new jobs) doesn't stop it from continuing to share models it already has; conversely, `peer_serve: false` only turns off sharing — it doesn't affect normal job intake. The two can be combined any way you like.

**Security model**: every single transfer requires a grant — there's no anonymous path.

- The puller (an already signature-verified agent request) asks the platform for an **Ed25519-signed transfer grant**, valid for **at least 10 minutes and scaled up with the file size** (the time a whole transfer takes at the agent's default 20 Mbps upload cap, x1.5, plus 10 minutes — about 75 minutes for a 6.5 GB model), bound to one file, one puller, and one seeder — not something a worker can hold onto and reuse at will; once it expires, a fresh one has to be requested.
- The seeder (the worker sharing the model) **verifies the grant on every single request, before even consulting its own inventory**: platform signature, expiry, whether `seeder_id` matches itself, and whether the requested name matches its local inventory — a missing grant, a bad signature, an expired grant, or a mismatched range all **fail closed with a bare 403**, leaking no detail (including whether a given filename even exists — an unauthenticated request always gets 403, never a name-revealing 404).
- Workers **never keep standing trust with each other** — sharing a model with one member today doesn't let that member reconnect without a grant later; every transfer needs a freshly issued one from the platform.
- Per-chunk hashes only exist to abort a bad chunk early; the **final whole-file SHA-256 verification always runs**, same iron rule as any other model download — the chunk table itself is never the trust root.
- **Transfers are currently plaintext HTTP**: the grant only authorizes *who can pull what* — it does not encrypt the content. Both the `X-ComfyFed-Grant` header and the model bytes travel unencrypted, and the grant is a bearer credential: anyone who observes that header while the grant is valid (at least 10 minutes, longer for a big model) can pull the file it authorizes. If your members talk over a public network, only enable this feature within a trusted LAN or VPN (Tailscale, WireGuard, etc.) — don't expose `peer_listen_port` to the open internet.
- **The advertised address is self-reported by the worker, and the platform does not independently verify it**: `peer_advertise_host` (or the auto-detected IP) is never probed or reverse-checked by the platform, so a malicious worker could in principle advertise an address reachable only from inside the platform's or another member's network (e.g. `127.0.0.1`, `169.254.169.254`, another worker's LAN IP), causing other agents to issue a ranged GET against it. The response gets discarded on a signature/shape mismatch, so nothing is exfiltrated, but this is still an address-unfiltered request-forwarding surface — `peer_url` is trusted only as far as the worker's own registration trust already extends, no further.

**Bandwidth accounting**: once a seeder finishes serving a grant, it reports the bytes served back to the platform, which records it in the receipt ledger (`kind: p2p_upload`, non-billable, no GPU seconds); the Reports page's contribution report gains a "P2P upload volume" column, and the Workers page shows whether each worker is currently sharing models and what address it's advertising.

### Job assessment

When a job arrives, the server automatically extracts the node classes, model files, and (when known) VRAM needs from the workflow, and rules on each candidate worker:

- `eligible`: the worker already has every required node and model — dispatch directly.
- `eligible_after_fetch`: models missing on this worker are available through the platform-signed fetch manifest, and there's enough free disk to hold them — sources include models another worker already holds with a reported consensus hash, **and also curated-list models with zero holders fleet-wide right now** (operator-vouched hash), both served through the same download mechanism from the worker's point of view.
- `ineligible`: with plain-language reasons, e.g. missing node classes or insufficient VRAM; a model-related `ineligible` now fires either when the platform genuinely doesn't recognize the model at all (not in the curated list, and no worker has ever reported a consensus hash for it — no trustworthy hash exists to sign a manifest entry with), **or when the model's `model_hashes` row is in conflict** (see "A hash conflict is permanent and needs manual recovery" above) — a curated, perfectly well-known model is still excluded while its row disagrees.

### Embedded workflow editor (`/comfy`)

You don't need your own ComfyUI to build a workflow: the platform can serve the **official ComfyUI frontend** at `/comfy`. Wire up your graph in the browser, press Queue, and the job goes straight into the federation's queue — the results come back in the same interface.

The static bundle is not installed with the package (it's ~24 MB of JavaScript that an API-only deployment never touches), so fetch it once:

```bash
comfyfed-server fetch-comfy-ui --data-dir ./data
```

That downloads the `comfyui-frontend-package` wheel from PyPI — **both the version and its sha256 are pinned in the source**, and the digest is verified before anything is extracted — and unpacks its `static/` tree into `<data-dir>/comfy_frontend/`. Already fetched: it's a no-op. **Restart the server** afterwards so `/comfy` gets mounted.

- `--version X` fetches a different release, but then the sha256 check is **skipped** and compatibility with this platform's `/comfy/api` is not guaranteed (the command warns about both).
- Until you fetch it, `/comfy` serves a bilingual notice page telling you to run the command above.
- `/comfy` and all of its assets only require **being logged in** (any role); without a session you are redirected to `/` (the console login). The panel is a **personal workspace**: everyone only sees the jobs and artifacts they submitted through it — even an admin only sees their own panel jobs there — see the full picture on the console's Jobs page instead.

**Then fetch the official template library** (optional, but recommended): the frontend wheel is just the UI — it does not carry ComfyUI's official starter workflows. One more command:

```bash
comfyfed-server fetch-comfy-templates --data-dir ./data
```

That reads the `comfyui-workflow-templates` meta package's dependencies on PyPI, downloads the matching `-json` and `-media-*` sub-package wheels (each verified against the sha256 PyPI itself reports before anything is extracted) and flattens their `templates/` trees into `<data-dir>/comfy_templates_official/`. Budget roughly **475 MB** of download for ~105 MB on disk, and a few minutes.

- `--version X` fetches a specific release; the default is the newest on PyPI.
- **Restart the server** afterwards — the library is picked up at startup. The template browser's sidebar then lists ComfyFed's own categories first and the official ones after them.
- Skipping this breaks nothing: the browser still opens, it just contains only ComfyFed's own built-in templates.
- Official template JSONs have their **model download URLs and hashes stripped** before they reach the browser. Those "Download" buttons fetch to the machine running the browser, which on a stock ComfyUI is the machine running the graph and here is **your laptop** — useless to the federation. Pressing Run with a curated model (the 11 built-in models in the "Model downloads" table below) queues and auto-dispatches a download even with zero holders fleet-wide right now — it's never refused for that. Other models (template-library ones that aren't curated, or anything else a workflow references) carry no operator-vouched hash, so they still need at least one worker in the federation to actually hold the file and have reported a hash before they can enter the download list — pressing Run is refused, with zh-TW guidance naming the file and the worker folder it belongs in, only for a model the platform genuinely doesn't recognize and nobody in the federation holds.

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

**Custom templates (My templates)**: the **「我的範本 / My templates」** category at the very top of the template browser is **yours alone** — no other user sees it, not even an admin. There are two ways to fill it, neither of which needs any new UI:

- in the editor, **Save As** the workflow under the name `templates/<name>` (the workflow browser already saves into userdata's `workflows/...`);
- or upload straight to `workflows/templates/<name>.json` through the existing userdata API.

For a thumbnail, drop a matching `<name>-1.webp` (`.png`/`.jpg` also work) beside it in the same folder; without one the card simply has no preview. Reload the template browser after saving and it is there — clicking it still **copies** the graph onto the canvas.

Naming rules: a single filename only — no `/`, `\`, `:`, no leading `.`/`..`, no trailing dot or space, and no Windows reserved device name (`con`, `nul`, `com1`, …). These are exactly the rules every other userdata file follows; a file that breaks them is never listed. Each entry's name in the index is `my_<name>`, which in practice keeps personal templates clear of ComfyFed's own (`comfyfed-*`) and of the official library. Precisely: **your own file wins**. A request for `my_<x>` looks in your `workflows/templates/<x>.json` first and only falls through to the bundled/official library on a miss — so if the official library ever shipped a template literally named `my_<x>` and you happened to own an `<x>`, you would see yours (**only for you**; nobody else's view changes). **An empty folder produces no category at all** (no empty group is shown). To delete a template, delete its `.json` (and its thumbnail).

**Upload limits and the storage quota**: every uploaded file has a **per-file ceiling** (default **50 MB**) and every user has a **storage quota** (default **5 GB**). The per-file cap applies to editor uploads, workflows saved through `/userdata`, and assets attached to a console job submit. The quota counts only a user's own two areas — staging uploads (`comfy_staging/<uid>/`) and saved panel files (`comfy_userdata/<uid>/`); **job results do not count toward it** (they are outputs, and reclaiming them is a separate concern). Exceeding either answers 413 with a message naming the amount used and the quota. An admin adjusts both under **Console → Settings → Upload limits** (1–1024 MB per file; 0.1–1024 GB quota); they are stored as the `upload_max_file_mb` and `upload_user_quota_gb` settings and take effect immediately, no restart. Each user sees their own usage and quota on the Settings page's "My uploads" card.

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

(The version is parsed from the wheel filename unless you pass `--latest`. **`--min-supported` policy: publishing never raises `min_supported` automatically** — omit it and the currently-stored value stays put (falling back to the built-in default `0.1.0` only on the very first publish, before anything has ever been stored); older agents keep working, just possibly without newer features, and an agent self-updates on its next start anyway. Only pass `--min-supported` explicitly when there's a genuine hard breaking change that would actually break an older agent's connection — and the value can't exceed `--latest` (that would lock out every agent, including the one you just published; the command fails outright).)

**Self-update version floor (honest note)**: agents **0.1.6 and older never actually self-updated** — three mutually-masking bugs in the old code (exiting instead of updating when below `min_supported`; fetching the platform's relative `wheel_url` verbatim; saving the wheel under a random temp name that pip rejects as "not a valid wheel filename"). All three are fixed in 0.1.7. So **machines running 0.1.6 or older need the one-line installer run once more** (it installs the latest wheel outright and won't re-register an already-registered machine); from 0.1.7 on, every start genuinely self-updates.

**How the agent restarts after an update (0.1.9+)**: it no longer re-execs itself (0.1.8 and older used `os.execv`; under pip's Windows launcher `sys.argv[0]` lacks `.exe`, so the re-exec always failed and the agent simply went offline — the fifth and last bug in the self-update chain). Instead it exits with **code 75** and lets a supervisor start the new build: systemd's `Restart=on-failure` on Linux, launchd's `SuccessfulExit=false` on macOS, and the installer-generated `launcher.ps1` loop on Windows (which restarts on 75 only). `comfyfed stop` exits 0, so a stop remains final. **Machines on 0.1.8**: updating to 0.1.9 still goes through the old re-exec once — the install succeeds but the agent goes offline; log in again / reboot, or re-run the one-line installer (it installs 0.1.9 outright and swaps in the new launcher).

Once published, an agent asks `/api/agent/version` at startup, compares versions, downloads the wheel, and installs it only if both the sha256 and the platform signature verify. **The signed payload is `{version}|{sha256}`** — binding the version into the signature means an old release's signature cannot be replayed to advertise a newer version, so a downgrade attack does not work.

**Cloud deployment (Cloudflare Workers)**: there is no CLI on the cloud edition — use the admin API instead. After logging in, POST the wheel directly (it is stored under `releases/` in R2; the signature and the five settings are written exactly as the CLI does):

```bash
curl -X POST "https://<your-platform-url>/api/workers/agent-release?filename=comfyfed-0.1.0-py3-none-any.whl"   -H "X-CSRF: <csrf from login>" -b cookies.txt   --data-binary @dist/comfyfed-0.1.0-py3-none-any.whl
```

Once published, the console's Workers page shows a "Download agent package" button, and anyone can fetch `/api/agent/releases/<filename>` without logging in — integrity is guarded by the sha256 + platform signature that `/api/agent/version` advertises, same as the self-hosted edition.

⚠ **The platform signing key may be kept offline** (as the spec recommends). If you would rather not keep `data/keys/platform.key` on the live host, skip `publish-agent`: sign `"{version}|{sha256}"` yourself on an offline machine and set `agent_latest`, `agent_min_supported`, `agent_wheel_url`, `agent_wheel_sha256` and `agent_wheel_sig` by hand. The agent verifies them identically either way.

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

**ComfyFed Cloud** (shipped): a hosted variant built on Cloudflare Workers + D1 + R2, so there's no machine of your own to keep powered on. See [`cloud/README.md`](../cloud/README.md).

### License

License: [AGPL-3.0](../LICENSE).
