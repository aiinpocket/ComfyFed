# Phase 2.0: ComfyFed Cloud — Cloudflare Workers Deployment Mode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second, fully working deployment form of the ComfyFed platform on Cloudflare Workers (spec §9 "ComfyFed Cloud"): clone the repo → connect Cloudflare Workers Builds → deploy — no VM, no DDNS, no port forwarding, no TLS chores. The self-hosted Python server remains 本體; the cloud build lives entirely under `cloud/` and never changes Python behavior except one additive agent upload mode.

**Architecture:** Hono on Workers + **D1** (schema mirroring the Python alembic head) + **one Durable Object `Hub`** (agent WS + panel WS via WebSocket hibernation, dispatch/requeue alarm) + **R2** (artifacts, job inputs, staging, object_info snapshots, optional official template library) + **Workers Static Assets** (console SPA + pinned ComfyUI frontend fetched at build). Ed25519 via WebCrypto with Python golden-vector parity. Session cookie = HMAC-SHA256 (own format), password = PBKDF2-SHA256 (WebCrypto), CSRF double-submit as today. Agent artifact upload gains a "presign" mode (sha256-header-signed raw PUT) so bodies stream to R2; the Python agent tries it first and falls back to today's multipart when absent (so old servers keep working).

**Tech Stack:** TypeScript, Hono, wrangler, @cloudflare/vitest-pool-workers (miniflare: D1/R2/DO emulated locally), vitest.

**Spec:** docs/superpowers/specs/2026-09-12-comfyfed-spec.md §9. **The Python modules are the behavior spec** — every port task names its source module(s); parity means same routes, same wire messages, same status codes, same zh-TW strings for user-facing text, same signature payload bytes.

## Global Constraints

- `cd cloud && npm test` green at every commit (vitest workers pool); Python suite untouched and green when agent/ touched (`.venv/Scripts/python.exe -m pytest tests -q`, base 696, ONE foreground run, never two concurrent).
- **Signature-byte parity is sacred**: receipt payload `${job_id}|${worker_id}|${gpu_seconds .1f}`, registration cert `${worker_id}|${pubkey_hex}`, release `${version}|${sha256hex}`, and the signed-request canonical string `{METHOD}\n{path[?query]}\n{ts}\n{nonce}\n{body}` must verify against PyNaCl-produced vectors and vice versa. The `.1f` must reproduce Python `format(x, '.1f')` including round-half-even ties.
- zh-TW-first bilingual user-facing strings, copied from the Python source where the same message exists.
- No Node-only APIs in Worker code (no fs/crypto module — WebCrypto + Web Streams only). Build scripts may use Node.
- The decommissioned R2 *model-mirror domain* must not reappear; model download guidance keeps 官方載點＋GCS 備份載點 exactly as the Python model_guide does. (Cloud artifacts live in the deployment's own R2 bucket — unrelated to the old mirror.)
- Secrets/vars (final names): `PLATFORM_ED25519_SEED` (secret, hex 32B), `SETUP_TOKEN` (secret, first-run install gate), optional `R2_S3_ACCESS_KEY_ID`/`R2_S2_SECRET`/`R2_S3_ENDPOINT` for presigned-URL mode. Session secret + admin hash live in D1 settings (rotate-on-password-change preserved).
- Cloud never self-migrates at request time: `npm run deploy` = `wrangler d1 migrations apply --remote && wrangler deploy`; the Worker detects missing schema and serves a clear bilingual "資料庫尚未初始化" page.

---

### Task 1: Scaffold + D1 schema + golden vectors

**Files:** Create `cloud/package.json`, `cloud/wrangler.jsonc` (D1 `DB`, DO `HUB` class Hub + migrations block, R2 `STORE`, assets binding `ASSETS` with run_worker_first for `/comfy/*` `/api/*`, vars), `cloud/tsconfig.json`, `cloud/vitest.config.ts` (workers pool, miniflare bindings), `cloud/migrations/0001_initial.sql` (FULL schema = current alembic head: settings/workers/register_tokens/jobs/receipts/login_attempts with every column incl. origin, panel_hidden, protocol, receipt kind/billable/basis — read server/comfyfed_server/db.py + all 8 alembic revisions and consolidate), `cloud/src/index.ts` (Hono app, `/api/ping`, schema-missing guard), `cloud/src/lib/hex.ts`, `scripts/golden_vectors.py` (repo root scripts/; generates `cloud/test/fixtures/golden.json` with: 3 keypairs (seed hex, pub hex), signed samples of all four canonical strings incl. request-signing over a multipart-ish body, 20 `.1f` cases incl. ties 0.05/0.15/0.25/2.5/9.999/0.04999, pbkdf2 N/A) — run it with the repo .venv and COMMIT the fixture.
**Tests:** migration applies in miniflare; ping route; schema-guard page when tables missing.
Commit `feat(cloud): scaffold, D1 schema, golden vectors`.

### Task 2: Crypto + formatting parity lib

**Files:** `cloud/src/lib/ed25519.ts` (seed↔PKCS#8 import, sign/verify raw 64B hex), `format.ts` (`python1f()` round-half-even), `signing.ts` (four canonical-string builders + verifySignedRequest parts), `passwords.ts` (PBKDF2-SHA256 600k iter, constant-time compare, self-describing hash string `pbkdf2$iter$salt$hash`), `cookies.ts` (HMAC-SHA256 signed cookie `payload.b64url.sig`, max-age 7d, csrf token embed).
**Sources (parity):** server/comfyfed_server/security.py, workers.py (canonical string), agentws.py (receipt payload), auth.py (cookie semantics, not format).
**Tests:** every golden vector verifies; TS-signed → TS-verified round trips; `python1f` matches all fixture cases; cookie tamper (flip signature char in a FULL base64 group — see tests/server/test_auth.py's flake lesson) rejected.
Commit `feat(cloud): webcrypto ed25519 + python-parity formatting + sessions`.

### Task 3: DB layer + dispatch port

**Files:** `cloud/src/db/queries.ts` (typed helpers per table, JSON columns parsed at the edge), `cloud/src/core/dispatch.ts`.
**Sources (parity):** dispatch.py — claim semantics (atomic UPDATE...WHERE status='queued'), assign_jobs ranking incl. Phase 1.9 light-job preference (weak backend mps/cpu first, smallest free VRAM for zero-model jobs; heavy jobs clean>warned>biggest VRAM), requeue_stale (90s, last_worker_id), cancel_job (clears worker_id, sets last_worker_id, started-jobs produce cancelled-receipt data), try_readopt, terminal statuses incl. cancelled.
**Tests:** port the assertions of tests/server/test_dispatch.py that are pure dispatch logic (ranking tie-breaks, light vs heavy, readopt gates, stale requeue) against real D1.
Commit `feat(cloud): db layer and dispatch engine`.

### Task 4: Auth + settings + first-run setup

**Files:** `cloud/src/routes/auth.ts`, `settings.ts`, middleware in `cloud/src/lib/guard.ts`.
**Sources (parity):** auth.py — login backoff (2**(n-3)s after 4 fails/10min via login_attempts), change-password rotates session secret, `/api/settings` GET/POST incl. `object_info_mode` enum validation, metrics_public, artifact hash toggle etc. (read the Python settings surface and port all keys). Setup: when no admin hash row → all routes redirect to `/setup`; POST /api/setup {token, password} requires SETUP_TOKEN match; generates argon2→NO: pbkdf2 hash, session secret, and returns the login.
**Tests:** login/logout/CSRF/backoff/rotation/setup-token wrong/right; settings enum.
Commit `feat(cloud): auth, settings, first-run setup`.

### Task 5: Worker registration + signed-request verification + object_info upload

**Files:** `cloud/src/routes/workers.ts`, `cloud/src/lib/verify_agent.ts`.
**Sources (parity):** workers.py — register-token issuance/expiry, `/api/agent/register` (cert = sign(`worker|pubkey`)), signed-header verification (±120s skew, nonce replay window 300s — store nonces in D1 table `nonces` with opportunistic pruning; add it to a NEW migration 0002), gzip object_info upload (8MB compressed/32MB inflated caps → R2 `object_info/<worker_id>.json.gz`), `/api/workers` listing with dynamic fields from Hub-held state (fetch from DO), enable/disable, delete.
**Tests:** golden-vector signed requests accepted, tampered/expired/replayed rejected; caps enforced; register flow end-to-end.
Commit `feat(cloud): agent registration and signed transport`.

### Task 6: Hub DO — agent WS + dispatch alarm

**Files:** `cloud/src/do/hub.ts` (part 1).
**Sources (parity):** agentws.py — the whole agent protocol: nonce challenge handshake, hello (protocol 2 records/deprecation frame to v1, platform), heartbeat (job_id ref → not-owned job_cancelled push w/ bounded dedup + rate-limited logs), inventory refresh, job push message shape, job_done (exec_seconds validation/cap, receipt mint kind=completed + push + ack countersign verify, blip re-adoption via try_readopt), job_failed (non-billable receipt, wall fallback), cancelled receipts minted via the shared hook, panel relay calls (Task 7's bus). Use WebSocket hibernation (`state.acceptWebSocket`, `webSocketMessage`), attach worker identity via serializeAttachment. Alarm every 5s WHILE (any agent connected OR queued/assigned jobs exist): requeue_stale + assign + push; re-arm conditionally.
**Tests:** miniflare DO websocket tests porting the core assertions of tests/server/test_agent_ws.py (handshake, hello v1/v2, done→receipt→ack, failed→non-billable, cancel push dedup, readopt).
Commit `feat(cloud): Hub durable object — agent websocket + dispatch loop`.

### Task 7: Hub DO — panel WS + event bus

**Files:** `cloud/src/do/hub.ts` (part 2), `cloud/src/lib/events.ts` (routes→DO RPC via `stub.fetch('/internal/event', ...)`).
**Sources (parity):** panelws.py — connect frame (feature_flags all-false incl. show_signin_button), status/progress relays, job_done → ONE executed event PER output node (job_outputs shape), job_cancelled/requeued events.
**Tests:** panel client sees flags frame; a completed job produces per-node executed events; cancel event relayed.
Commit `feat(cloud): Hub — panel websocket and event relay`.

### Task 8: Jobs API + R2 artifacts + presign upload protocol (+ Python agent support)

**Files:** `cloud/src/routes/jobs.ts`, `cloud/src/lib/store.ts` (R2: artifacts/<job>/<file>, job_inputs/, staging/); **Python:** `agent/comfyfed_agent/runner.py` (or its upload helper) + `tests/agent/`.
**Sources (parity):** jobs.py — create (multipart assets→R2, assess, origin=console), list/detail (receipt embed incl kind/billable/basis/acked), cancel (X-CSRF), retry, agent input download (signed), artifact download, SHA-256 verify, text artifacts.
**New upload protocol:** `POST /api/agent/jobs/{id}/artifacts/presign` (signed, JSON {filename, sha256, size}) → `{mode:"direct", url:"/api/agent/jobs/{id}/artifacts/raw/{token}"}` (one-time token, 10min): agent PUTs raw bytes; Worker streams to R2 while hashing, 413 over limit, compares sha256. When S3 secrets configured return `{mode:"s3", url:<aws4 presigned PUT>}` + confirm POST. **Python agent:** try presign first; on 404/405 fall back to today's multipart unchanged; tests for both paths (mock server).
**Tests:** cloud vitest for all routes + streaming hash + one-time token replay rejected; python agent tests for fallback.
Commit `feat(cloud): jobs api, R2 artifact store, presign upload (agent support)`.

### Task 9: comfyapi port (panel-compatible API)

**Files:** `cloud/src/routes/comfyapi.ts`, `cloud/src/core/assess.ts`, `cloud/src/core/model_guide.ts`.
**Sources (parity):** comfyapi.py end to end: object_info union/intersection from R2 snapshots (gunzip via DecompressionStream, cache in DO storage keyed (fleet-hash, mode), zero-worker `{}` + headers), POST /prompt (assess extract — port assess.py's walker: nodes/models/assets/VRAM + model_nodes; fleet-wide missing-model 400 with guidance_summary/message + node_errors, missing custom-node note), queue/history GET (origin scope, panel_hidden), /interrupt, /queue delete/clear, POST /history hide, /view from R2, /upload/image → staging, settings json (D1 row), /users, /extensions + comfyfed-ext JS (copy panel_ext/comfyfed.js into cloud bundle), feature flags. model_guide.ts: curated SOURCES (import the 11 entries VERBATIM from model_guide.py — write a small parity test asserting name/dir/URLs equality against a checked-in JSON snapshot generated by scripts/golden_vectors.py addendum or hand-copied carefully), harvest from R2 official library when seeded, guidance byte-parity for the fixture cases in tests/server/test_model_guide.py (copy expected strings).
**Tests:** port the highest-value assertions from tests/server/test_comfyapi.py + test_assess.py + test_model_guide.py (guidance message byte-equality, node_errors shape, strip/serve behavior, origin scoping).
Commit `feat(cloud): comfyui-compatible api`.

### Task 10: Templates on cloud

**Files:** `cloud/src/routes/templates.ts`, `cloud/scripts/seed-official.mjs`, template data wiring in build (Task 11 consumes).
**Sources (parity):** templates.py — merged index (ComfyFed first), recursive strip of models[].url/hash/hash_type (top-level, nodes[].properties.models, definitions.subgraphs[]), media passthrough. ComfyFed's own templates_data ships in Static Assets under an internal path; JSON is served through the Worker with strip applied; webp/mp4 assets served directly. seed-official.mjs: PyPI split-package fetch (port official_templates.py: meta→json+media wheels, skip -core, sha256 verify, 512MB cap) uploading flat into R2 `official_templates/`; Worker merges R2 index when present. Staging seeding: template assets copied to R2 staging on first request (memoized).
**Tests:** strip parity against the same fixtures test_templates.py uses (copy the fixture workflows); index merge order; media route.
Commit `feat(cloud): template library serving + official seed script`.

### Task 11: Build pipeline + static assets + session gate

**Files:** `cloud/scripts/build.mjs`, `cloud/src/lib/gate.ts`, package.json scripts (`build`, `deploy`, `ci-build`), `cloud/.assetsignore` as needed.
**Behavior:** build.mjs = (1) `npm ci && npm run build` in ../web → assets/console/; (2) fetch comfyui-frontend-package wheel — SAME pinned version+sha256 as comfy_frontend.py (read the constants; extract wheel member paths, drop *.map) → assets/comfy/; (3) copy ../server/comfyfed_server/templates_data → assets/comfyfed_templates/; (4) emit assets manifest. Gate middleware: unauthenticated non-`/comfy/api/*` requests under `/comfy/*` redirect `/` (parity with app.py middleware); console SPA fallback via assets config `not_found_handling: single-page-application`.
**Tests:** gate logic unit tests (Workers pool with fake assets); build script smoke-run in CI mode able to skip the 93MB fetch via env flag (BUT run it for real once locally and commit the manifest expectations, not the assets).
Commit `feat(cloud): build pipeline, static assets, session gate`.

### Task 12: Reports + metrics

**Files:** `cloud/src/routes/reports.ts`, `metrics.ts`.
**Sources (parity):** receipts.py (contributions aggregation incl. unbilled split + per-receipt kind/billable/basis/acked), metrics.py (Prometheus text format: same metric names; gauges computed at scrape; honor metrics_public setting).
**Tests:** aggregation fixtures; text format snapshot.
Commit `feat(cloud): reports and metrics`.

### Task 13: Cloud end-to-end test + docs

**Files:** `cloud/test/e2e.spec.ts`, `cloud/README.md`, root README untouched.
**E2E (miniflare):** setup flow → login → issue register token → HTTP register a fake worker (golden keypair) → open agent WS, handshake+hello v2 → panel POST /prompt (zero-model workflow w/ staged asset) → alarm tick assigns → fake agent receives job push → uploads artifact via presign → job_done → receipt frame → counter-sign ack → panel history shows output → cancel path: second job cancelled mid-"run" → cancelled receipt billable=0 → GET reports shows billable + unbilled. Every step asserted.
**cloud/README.md** (zh-TW first, then EN): prerequisites (CF account, free plan OK — SQLite DOs), create D1 + R2 (`wrangler d1 create comfyfed`, `wrangler r2 bucket create comfyfed-store`), set secrets (PLATFORM_ED25519_SEED via `python scripts/golden_vectors.py --new-seed` or openssl, SETUP_TOKEN), Workers Builds dashboard steps (connect repo, root dir `cloud/`, build `npm run ci-build`, deploy `npm run deploy`), first-run /setup, register a worker (same comfyfed-agent, platform_url = https://your.workers.dev), limits (100MB artifact on free plan; S3 presign option), what differs from self-hosted (one table).
Commit `feat(cloud): end-to-end test + deployment docs`.

### Task 14 (controller-executed): real deployment verification

Deploy to the real Cloudflare account (create D1/R2, secrets, `npm run deploy`), run /setup, register the local RTX 5080 agent against the cloud URL alongside its local platform (multi-platform is a core feature), submit a zero-model template job from the cloud panel, verify: WS through CF, dispatch, artifact upload, receipt dual-signed, console pages. Leave the deployment up; record URL in the ledger.
