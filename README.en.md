# ComfyFed

[繁體中文版 →](README.md)

## Pool your friends' GPUs into one big machine

ComfyFed lets a group of people who know each other connect their graphics cards, so whoever's GPU is free renders whoever's job just came in. You don't need to buy a top-end card, and you don't need to learn how ComfyUI is installed or how nodes are wired. Open a browser, pick a template, change a few words, hit Run, and an idle machine in the federation does the rest. The image or video shows up in the web console when it's done, ready to view or download.

The circle is invite-only. Only a one-time link issued by the admin gets someone in, and both the person who submitted a job and the person who lent the GPU can see who did what. It's built for small trusted groups: family, coworkers, a club, a studio.

### What you can make

The built-in workflow editor ships with 11 ready-made templates. Each canvas has a red sticky note marking exactly what to edit, so someone who has never touched ComfyUI can still get a finished result:

| Template | What it does |
| --- | --- |
| Text-to-image | Type your idea in Chinese (or English); a local AI writes the English prompt and the image follows (the default is a wuxia scene; swap it for anything) |
| Character portrait | Portrait-orientation version, for a single character's reference sheet |
| Reference to video | Feed in one photo, describe the shot in Chinese, and watch that person move, with generated audio |
| NSFW image-to-video | The same pipeline with nothing filtered: one photo of an adult plus an explicit scene written in Chinese |
| First+last frame to video | Give a first and last frame; the motion in between is filled in |
| Video concat | Stitch two clips into one, picture and audio both |
| Image intro + video | Hold a still as a title card for a few seconds, then play a clip |
| Video trim | Cut the segment you want out of a longer clip |
| Image upscale | Turn a small image into a high-resolution one |
| Image to prompt | Upload a reference image, get a polished English prompt |
| Text to prompt | Paste a rough idea, get it rewritten as a structured English prompt |

Opening a template clones it onto your own canvas, so the original never gets damaged. Results and their records land on the console's Jobs page.

### Why it's worth setting up

- **One-line join.** The admin clicks "add worker" in the console, gets a one-line install command, and pastes it on the target machine. Missing Python or ComfyUI gets installed automatically and everything is set to start on login. No sudo, no administrator rights.
- **No ports to open.** Workers only ever connect outbound to the platform, so a machine behind a home NAT works as-is.
- **Steps aside when you're using the computer.** The agent notices activity on the machine and stops taking new jobs, then resumes once you walk away. Anything already running finishes normally.
- **Contributions you can prove.** Every finished job produces a receipt signed by both the worker and the platform. Neither side can alter a record the other signed, and the Reports page turns them into a leaderboard and a revenue-split estimate.
- **Models travel between members.** A new machine missing a model can pull it from anyone in the circle who's online, far faster than everyone re-downloading from the outside. If the router cooperates, the port is opened automatically; if not, sharing stays LAN-only.
- **Missing models get fetched.** Models the platform vouches for download automatically, up to 20 GB per job by default. Adjustable, or turn it off.
- **One account per person.** Regular users see only their own jobs and outputs. Admins see everything, set quotas, and handle billing.
- **AI can submit jobs too.** An MCP server is included, so Claude Code, Claude Desktop, Cursor and similar tools can submit a job in plain language, wait for it, and pull the file back locally. See the [MCP guide](docs/MCP.en.md).
- **Signed end to end.** Every registration, API call and WebSocket connection is Ed25519-signed and replay-protected. Workers can also whitelist node types, so a workflow someone else submits can't run anything it shouldn't on your machine.

### Two ways to host, one codebase, one agent

There is exactly one server implementation (`cloud/`, a Cloudflare Worker). The only difference is where it runs:

| | Self-hosted (local) | Cloudflare Cloud |
| --- | --- | --- |
| Runs on | Your own machine or VM (Docker or Node.js), running the same Worker under Miniflare | Cloudflare Workers, serverless |
| Database / files | Local SQLite / local disk | D1 / R2 |
| Address | Bring your own DDNS or fixed IP, TLS via a reverse proxy | A `*.workers.dev` URL on deploy, TLS handled |
| Cost | Host and bandwidth | $0 within the free tier |
| Output size cap | Limited by disk | 100 MB, about 5 GB once `R2_S3_*` is set |
| Updates | `docker pull` and restart | Push to GitHub, auto-deploy |

Both run the same server code, the same federation protocol and the same `comfyfed-agent`. Connecting a friend's GPU is the identical step either way; the `platform_url` inside `bundle.json` decides where it connects.

---

## Installation

In order: host the platform (A or B), connect workers (C), configure the platform (D).

### A. Self-hosted (local machine or VM)

Self-hosting runs **exactly the same code as the cloud edition**: Cloudflare's Worker runtime (Miniflare / workerd) runs on your machine, and the database and files live in a local `data` directory. No Python, no separate database to install.

**Requirements**: Docker, or Node.js 22+.

**Docker (recommended)**

```bash
docker run -d --name comfyfed --restart unless-stopped \
  -p 8388:8388 -v comfyfed-data:/data \
  ghcr.io/aiinpocket/comfyfed:latest
```

The first start prints a **setup token** in the log:

```bash
docker logs comfyfed
```

Open `http://<this machine>:8388`, enter the token and choose an admin password. Done. The token is also stored in `/data/selfhost.json`; once the admin account exists you no longer need it.

**Without Docker**

```bash
git clone https://github.com/aiinpocket/ComfyFed.git
cd ComfyFed/web && npm ci
cd ../cloud && npm ci
npm run selfhost -- --data-dir ./data --url https://your-domain.example
```

The first run builds the console and the Worker (a few minutes); every start after that takes seconds. The setup token is printed in the terminal the same way.

**Public address and TLS**

The server needs one address everyone can reach; DDNS or a fixed IP both work. `--url` records it in the platform settings (you can change it later in the console's Settings). Put a reverse proxy in front for HTTPS. Caddy needs two lines:

```
your-domain.example {
    reverse_proxy 127.0.0.1:8388
}
```

With nginx, pass the `Upgrade` and `Connection` headers, since agents hold a WebSocket connection.

**Upgrading**: `docker pull ghcr.io/aiinpocket/comfyfed:latest` and restart the container (without Docker: `git pull`, then run `npm run selfhost` again). Database migrations apply themselves at startup, and the new agent version ships with the same upgrade, so there's nothing to do on the worker side (see "Agent updates" below).

**Backups**: the whole `data` directory (the `comfyfed-data` volume under Docker). `selfhost.json` inside it holds the platform's signing key and the setup token, so keep it with the rest.

**Parameters**

| Parameter | Default | Notes |
| --- | --- | --- |
| `--data-dir` | `./data` | Where the database, uploads, outputs and keys live |
| `--port` | `8388` | Listen port |
| `--host` | `0.0.0.0` | Bind address |
| `--url` | none | Public platform URL; written to the settings on first run, change it in the console's Settings afterwards |
| `--check` | off | Start, hit `/api/ping` once and exit, to confirm the install works |

The Docker image has these filled in already (`/data`, `8388`); change `-p` to use a different port.

**Honest note**: Cloudflare positions Miniflare as a development tool, not a production product. For "a few friends, one machine" it is more than enough, and in exchange the self-hosted and cloud editions share every line of server code. It is not meant to carry heavy traffic.

### B. Cloudflare Cloud

**Requirements**: a Cloudflare account (free plan is fine), Node.js 20+.

```bash
git clone https://github.com/aiinpocket/ComfyFed.git
cd ComfyFed/cloud
npm install
npm run setup:cloudflare
```

That one command logs in to Cloudflare (opening a browser if needed), creates the D1 database and R2 bucket (reusing them if they exist), writes the `database_id` into `wrangler.jsonc`, generates and sets the `SETUP_TOKEN` and `PLATFORM_ED25519_SEED` secrets (asking before replacing existing ones), builds the console, applies migrations and deploys. At the end it prints your URL (`https://comfyfed-cloud.<account>.workers.dev`) and the setup token.

Open the URL, enter the setup token and the admin password you want (8+ characters), and you can log in. Running the same command again is just a redeploy and is safe.

**Connect GitHub for automatic deploys (recommended)**

Commit the updated `cloud/wrangler.jsonc` to your repo first, then Cloudflare Dashboard → Workers & Pages → your Worker → Settings → Builds → connect the repo:

| Field | Value |
| --- | --- |
| Root directory | `/cloud` |
| Build command | `npm run ci-build` |
| Deploy command | `npm run deploy` |
| Branch | `main` |

From then on every push tests, builds, applies migrations and deploys. A single failing test blocks the deploy. The Node version is pinned to 22 by `cloud/.node-version`.

**Optional parameters**

| Parameter | Where | Notes |
| --- | --- | --- |
| `R2_S3_ACCOUNT_ID` `R2_S3_ACCESS_KEY_ID` `R2_S3_SECRET_ACCESS_KEY` `R2_S3_BUCKET` | `npx wrangler secret put` | With all four set, agents PUT outputs straight into R2 and the per-file cap rises from 100 MB to about 5 GB. **Required if you run any video template.** Get the keys from Dashboard → R2 → Manage API Tokens |
| Custom domain | Dashboard → Domains & Routes | After attaching, update `platform_url` in the console's Settings |
| `npm run seed-official` | CLI | Loads ComfyUI's official template library into R2 so "start from a template" has content |
| `npm run setup:cloudflare -- --yes` | CLI | Non-interactive: keep existing secrets, ask nothing |

The step-by-step manual route (create D1 yourself, set the secrets yourself) is still in [cloud/README.md](cloud/README.md).

### Agent updates (same for both)

- **Every deploy is an agent release**: the build packages the agent into a wheel and ships it with the platform, and the platform signs and publishes it the first time anyone asks for the agent version. Workers check for a new version at every start and update themselves; there is no wheel to upload by hand anymore.
- **One-click updates from the console**: on the Workers page, any worker that is behind gets an "Update" button (and there is an "Update all"). An idle worker updates right away and reconnects on its own; a busy one finishes its current job first; a machine whose owner turned off `auto_update` in `agent.json` reports "declined". Agents older than 0.1.18 don't understand the command; restart the agent once on that machine and it updates itself at startup.

### C. Connect a worker

The steps are the same whether the platform is local or on Cloudflare.

**One-line install (recommended)**

Admin logs into the console → Workers → add → name it. The page shows three commands with copy buttons. On the machine contributing GPU time, paste the matching one:

```powershell
irm "<platform url>/install.ps1?token=<one-time token>" | iex
```

```bash
curl -fsSL "<platform url>/install.sh?token=<one-time token>" | bash
```

There's a Windows cmd variant too. The script installs Python, installs or detects ComfyUI, registers, and sets up start-on-login, all without sudo. Re-running the same line is safe: an already-registered machine skips registration and only upgrades the agent. Your existing `agent.json` is left alone.

**Manual install (advanced)**

The "manual install" section on the console's Workers page offers a `bundle.json` download:

```bash
pip install -e .            # from the repo root; the root pyproject.toml is the agent
comfyfed-agent register bundle.json
comfyfed-agent run
```

**agent.json optional parameters**

The config lives at `~/.comfyfed/agent.json` (one-line installs on Windows use `%LOCALAPPDATA%\ComfyFed\`). Restart the agent after editing. The ComfyUI address and folders are auto-detected; fill them in only when detection fails.

| Key | Default | Notes |
| --- | --- | --- |
| `comfy_url` | auto-detected | Local ComfyUI URL |
| `models_dir` | auto-detected | Model library root; auto-fetch and P2P only ever write here |
| `comfy_output_dir` / `comfy_input_dir` | auto-detected | Used for post-job temp-file cleanup |
| `node_policy` | `installed` | Node whitelist policy |
| `whitelist_extra` | `[]` | Extra node classes to allow |
| `auto_update` | `true` | Check for a platform-published release on start and self-update |
| `hash_models` | `true` | Compute sha256 while scanning models; P2P and auto-fetch depend on it |
| `auto_fetch_models` | `true` | Download platform-vouched models when a job needs them |
| `max_fetch_gb` | `20` | Total auto-download budget per job |
| `pause_when_active` | `true` | Stop taking new jobs while someone is using the machine |
| `idle_minutes` | `15` | Minutes of no input before the machine counts as idle |
| `peer_serve` | `false` | Share model files with other workers. The one-line installer turns it on when the router agrees to open a port |
| `peer_listen_port` | none | Sharing port; the installer probes 8850 by default |
| `peer_bind_host` | `0.0.0.0` | Interface the sharing service binds to |
| `peer_advertise_host` | auto-detected LAN IP | Address advertised to peers; set it when you forward the port yourself |
| `peer_nat_traversal` | `auto` | Ask the router to open the port (NAT-PMP, then UPnP). `off` never touches the router |
| `peer_upload_limit_mbps` | `20` | Upload cap (Mbps) while someone is using the machine or it's manually paused |
| `peer_upload_limit_idle_mbps` | `0` | Upload cap while idle; `0` means unlimited |

**Command line**

| Command | What it does |
| --- | --- |
| `comfyfed pause` / `resume` | Manually pause or resume taking jobs |
| `comfyfed status` | Show the current state and reason |
| `comfyfed stop` | Cancel the running job and exit (same as Ctrl-C) |
| `comfyfed-agent check-registration` | Check whether the platform still accepts this machine |
| `comfyfed-agent p2p-probe` | Test whether the router will open a port |

After a one-line install, `comfyfed` is on PATH. With a manual install the same command is `comfyfed-agent`.

### D. Platform settings (console Settings, admin)

| Setting | Default | Notes |
| --- | --- | --- |
| `platform_url` | set at install | Public address, baked into every registration bundle. Update it after a domain change |
| `lang` | `en` | UI language |
| `object_info_mode` | `union` | Whether the editor's node list is the union or intersection across workers |
| `upload_max_file_mb` | `50` | Per-file upload cap |
| `upload_user_quota_gb` | `5` | Total storage per user |
| `split_batches` | on | Split multi-image jobs across workers to run in parallel |
| `nsfw_check_api_key` | empty | Enter an Anthropic API key to enable the pre-submission content gate |

The same page issues API tokens (for MCP and scripts). The Users page can override quotas per account.

---

## Repository layout

- `agent/` — the Python worker agent (`comfyfed-agent` / `comfyfed` / `comfyfed-mcp`). The only Python in the repo; the root `pyproject.toml` is its package definition.
- `cloud/` — the server, one Cloudflare Worker (TypeScript). Cloudflare and self-hosting (Miniflare / Docker) both run this; `cloud/scripts/` holds the build, `selfhost` and `setup:cloudflare` scripts.
- `cloud/packaged/` — data the build packages into the platform: the built-in workflow templates (`templates/`) and the one-line installer scripts (`installers/`).
- `web/` — the console (React), bundled into the Worker's assets at build time.
- `tests/` — the agent's pytest suite; server tests live in `cloud/test/` (vitest, run inside Miniflare) and console tests in `web/`.
- `docs/` — this guide, the MCP guide and the design specs (`docs/superpowers/specs/`).

## Documentation

- [Self-hosting guide](docs/SELF-HOSTING.en.md) | [繁體中文](docs/SELF-HOSTING.zh.md)
- [Cloudflare Cloud guide](cloud/README.md)
- [Driving ComfyFed with AI (MCP)](docs/MCP.en.md) | [繁體中文](docs/MCP.zh.md)
- Model downloads the templates need: the "Model downloads" section of the self-hosting guide

## License

[AGPL-3.0](LICENSE)
