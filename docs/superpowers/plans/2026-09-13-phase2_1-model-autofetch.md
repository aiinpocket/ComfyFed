# Phase 2.1: Model Auto-Distribution (自動抓模型) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `eligible_after_fetch` real (spec §8/§5): when every online worker lacks a model but the platform's signed manifest knows its hash + download source, the job is accepted, dispatched to an opted-in worker, the agent downloads the model (official URL → GCS backup fallback), verifies SHA-256, rescans, runs the job — with 下載模型中 progress visible in the panel and console. Workers keep sovereignty: auto-fetch is agent-side opt-in, off by default.

**Architecture:** Agents (protocol 3) hash their local models lazily into the inventory (cached sidecar). The server learns hashes by consensus across workers, joins them with model_guide's curated+harvested sources into a manifest whose per-entry trust payload `{name}|{directory}|{sha256}|{size_bytes}` is Ed25519-signed by the platform (spec: worker 只認清單不認連結 — the hash pin is the security boundary; URLs stay outside the signature so mirrors can rotate). Dispatch embeds `fetch_models` entries in the job push when no directly-eligible worker exists. Same feature ported to cloud/.

**Tech Stack:** Existing stacks (FastAPI/pytest; asyncio agent; React vitest; cloud Hono/vitest-workers).

**Spec:** docs/superpowers/specs/2026-09-12-comfyfed-spec.md §5 (assess/eligible_after_fetch), §8 (模型分發: signed manifest, hash verify), L66 (inventory hashes Phase 2 補).

## Global Constraints

- Suites green at each commit: `.venv/Scripts/python.exe -m pytest tests -q` (base 702, ONE foreground run per task, never two concurrent pytest), `cd cloud && npm test` (base 452) when cloud touched, `cd web && npx vitest run` (28) when web touched.
- zh-TW-first bilingual user-facing strings. Signature-byte parity between Python and cloud for the manifest payload string (golden-vector test in cloud).
- Backward compatible: protocol ≤2 agents keep working exactly as today (never receive fetch jobs); Python agent vs cloud server and vice versa both fine.
- Auto-fetch is agent config `auto_fetch_models` (default **false**) + `max_fetch_gb` (default 30). Downloads land ONLY under the agent's configured models_dir in the manifest entry's directory; path components sanitized; `.part` temp + atomic rename; failed/partial downloads cleaned up.
- Hash learning trust rule: a model's manifest hash requires ALL reporting workers to agree on (name,size)→sha256; any conflict excludes the entry and logs a WARNING naming both workers (poisoning tripwire).
- The decommissioned R2 mirror domain must not reappear. GCS base unchanged.

---

### Task 1: Agent — model inventory hashing (protocol 3 groundwork)

**Files:** Modify `agent/comfyfed_agent/hardware.py` (scan_models), `agent/comfyfed_agent/runner.py` (hello protocol → 3, `auto_fetch` flag in hello), agent config plumbing (find where agent.json keys load — add `hash_models` default true, `auto_fetch_models` default false, `max_fetch_gb` default 30). Test: `tests/agent/test_hardware.py`, `test_runner.py`.

**Behavior:** scan_models entries gain `"sha256"` when known. Hashing is lazy + cached: sidecar JSON `<models_dir>/.comfyfed_hashes.json` mapping relpath → {size, mtime, sha256}; a scan returns cached hashes for unchanged (size,mtime) files instantly and schedules hashing for at most ONE un-hashed file per scan pass (largest models take minutes to hash — never block a scan; the 10-minute rescan loop converges over time). Hash computed in a worker thread with a 1MB read loop. `hash_models: false` disables entirely (entries just omit sha256). hello: `"protocol": 3`, `"auto_fetch": <bool from config>`; heartbeat/inventory refresh path unchanged otherwise.

Steps: failing tests (cached hit no re-read; one-new-file-per-pass; mtime change invalidates; disabled flag; hello fields), implement, ONE full pytest run, commit `feat(agent): lazy sha256 model inventory + protocol 3 hello`.

### Task 2: Server — hash learning + signed manifest module

**Files:** Create `server/comfyfed_server/model_manifest.py`, migration #9 `model_hashes` (name TEXT, size_bytes INTEGER, sha256 TEXT, first_worker_id TEXT, created_at DATETIME, PK(name,size_bytes)). Modify `server/comfyfed_server/agentws.py` (inventory intake records hashes), `workers.py` only if inventory also arrives there (check). Test: `tests/server/test_model_manifest.py` (new), `test_agent_ws.py`.

**Behavior:** On inventory intake, for each entry carrying sha256: INSERT OR IGNORE into model_hashes; if an existing row for (name,size) has a DIFFERENT sha256 → do NOT overwrite, log WARNING (both worker ids), and mark the name poisoned for this process (in-memory set) so manifest excludes it. `model_manifest.entries(data_dir, db)` joins model_guide lookup (curated first, harvest fallback — official_url + backup_url + directory + size) with learned hashes; only models with BOTH a source URL and an agreed sha256 become manifest entries. Entry dict: {name, directory, url, backup_url|null, sha256, size_bytes, sig} where sig = platform Ed25519 hex over `f"{name}|{directory}|{sha256}|{size_bytes}"`. `GET /api/agent/manifest` (signed-agent auth) returns {entries: [...]} (also used by dispatch internally). Admin `GET /api/models/manifest` (console visibility, admin auth).

Steps: failing tests (consensus rule incl. conflict exclusion + WARNING; sig verifies with platform pubkey; entry requires url+hash; endpoints auth), implement, suite, commit `feat(server): learned model hashes + signed fetch manifest`.

### Task 3: Server — real eligible_after_fetch verdict

**Files:** Modify `server/comfyfed_server/assess.py`, `server/comfyfed_server/db.py`/migration #10 IF a column is needed (prefer storing auto_fetch + protocol already on worker rows — protocol exists; add `auto_fetch BOOLEAN NOT NULL DEFAULT 0` to workers in the SAME migration #9 wave if Task 2's migration hasn't merged yet — coordinate: ONE migration file total across T2/T3 is fine), `agentws.py` (hello stores auto_fetch). Test: `tests/server/test_assess.py`.

**Behavior:** verdict returns `eligible_after_fetch` (existing kind, today effectively dead) iff: worker missing ≥1 required model AND every missing model has a manifest entry AND worker.protocol >= 3 AND worker.auto_fetch AND worker free_disk_gb > 1.2 × Σ missing sizes AND everything else (nodes, VRAM rules) passes. Reasons list the models to fetch. Keep `eligible` strictly better than `eligible_after_fetch` in all consumers.

Steps: failing tests (each gate flips the verdict; disk margin; protocol/opt-in gates), implement, suite, commit `feat(server): eligible_after_fetch becomes a real verdict`.

### Task 4: Server — fetch-aware dispatch + submission relaxation

**Files:** Modify `server/comfyfed_server/dispatch.py` (assign_jobs), `agentws.py` (job push + progress relay), `comfyapi.py` (post_prompt 400 predicate), `jobs.py` (console submit predicate + assessment display), `panelws.py` only if a new progress stage frame needs shaping. Test: `test_dispatch.py`, `test_agent_ws.py`, `test_comfyapi.py`, `test_jobs.py`.

**Behavior:**
- assign_jobs: rank directly-eligible candidates first (existing keys); if NONE, rank eligible_after_fetch candidates (clean>warned, then SMALLEST total fetch bytes, then free VRAM rules as per job class, then name) and assign. The job push message to such a worker gains `"fetch_models": [<manifest entries for the missing models>]`. Never send fetch_models to protocol <3 (they were already excluded by verdict).
- Agent progress: agent sends job_progress with `"stage": "fetching_models"`, `"fetch_pct": 0-100`, `"fetch_model": <name>` while downloading (existing progress message extended); server relays to panel WS as the normal progress event (frontend shows its progress bar) and stores progress on the job; console job dict includes stage fields.
- POST /comfy/api/prompt + POST /api/jobs: the fleet-wide missing-model 400 now triggers ONLY for models that are BOTH missing-everywhere AND not-fetchable-by-anyone (no manifest entry, or no online protocol-3 auto_fetch worker with disk). Fetchable-missing models queue normally; the 202/200 response's node_errors/details are NOT sent for them. Mixed case (some fetchable, some not) → still 400 listing only the unfetchable ones (guidance text unchanged for those).

Steps: failing tests (fetch-candidate ranking incl. smallest-bytes preference; push payload shape; 400 relaxation matrix: fetchable/unfetchable/mixed/no-optin-worker; progress relay), implement, suite, commit `feat(server): fetch-aware dispatch and submission`.

### Task 5: Agent — download, verify, run

**Files:** Modify `agent/comfyfed_agent/runner.py` (handle_job pre-phase), create `agent/comfyfed_agent/fetcher.py`. Test: `tests/agent/test_fetcher.py` (new), `test_runner.py`.

**Behavior:** When job push carries fetch_models and config.auto_fetch_models: BEFORE running, for each entry: verify entry sig with the platform pubkey from the agent's platform config (reject job → job_failed with zh-TW 「模型清單簽章驗證失敗」 on mismatch); enforce Σ size ≤ max_fetch_gb and free disk; download url → `.part` file under models_dir/<sanitized directory>/ streaming with sha256 running hash + progress callbacks (job_progress stage fetching_models, per-model pct weighted by bytes); on url failure/timeout retry once then try backup_url; hash mismatch → delete .part, fail job with clear message naming the file; success → atomic rename, force inventory rescan + push inventory update, continue into the normal run path. Cancellation (job_cancelled / shutdown) mid-download aborts and deletes the .part. If config.auto_fetch_models is false but fetch_models arrives (server bug or race) → job_failed politely 「此 worker 未開啟自動下載」. httpx streaming with generous timeout; no proxy tricks.

Steps: failing tests (sig verify gate; hash mismatch cleanup; backup fallback; cancel mid-fetch cleanup; disabled-config refusal; progress emission), implement, ONE full pytest run, commit `feat(agent): verified model auto-fetch before run`.

### Task 6: Web console — fetch visibility

**Files:** Modify `web/src/pages/Jobs.tsx`, `web/src/pages/JobDetail.tsx`, i18n files. Test: existing vitest files.

**Behavior:** running/assigned jobs whose progress payload carries stage fetching_models show a 「下載模型中 <name> xx%」 chip/line (Jobs row + JobDetail timeline area) instead of the generic percentage; i18n zh/en. Nothing else.

Steps: vitest for the rendering branch, implement, `npx vitest run` + `npm run build`, commit `feat(web): show model auto-fetch progress`.

### Task 7: Cloud parity

**Files:** Modify `cloud/src/core/assess.ts` (verdict gates), `cloud/src/core/dispatch.ts` (fetch-candidate ranking), `cloud/src/do/hub.ts` (hello auto_fetch/protocol 3 store, job push fetch_models, progress relay, inventory hash intake), `cloud/src/db/queries.ts` + migration `0004_model_hashes.sql` (+ workers.auto_fetch column), new `cloud/src/core/model_manifest.ts`, `cloud/src/routes/workers.ts` (manifest endpoints), `cloud/src/routes/comfyapi.ts` + `jobs.ts` (submission relaxation). Test: mirrors of the Python task tests + a golden-vector test proving the manifest payload string signs/verifies identically to Python (extend scripts/golden_vectors.py with a manifest sample + regenerate fixture; Python change limited to that script).

**Behavior:** byte-parity port of Tasks 2–4 semantics. The e2e spec gains a mini-arc: worker registers with auto_fetch, job needing a manifest-known model gets dispatched with fetch_models, fake agent reports fetching progress then done.

Steps: failing tests, implement, `cd cloud && npm test` + tsc, regenerate golden fixture (run scripts/golden_vectors.py with repo venv), commit `feat(cloud): model auto-fetch parity`.

### Task 8 (controller-executed): live verification

Reinstall live (stop server+agent first), enable auto_fetch_models on the live agent config, DELETE RealESRGAN_x4plus.pth from the worker's models dir (small, re-fetchable from GCS), wait for inventory hashes to converge (or prime the hash of another worker — single-worker fleet: manifest hash must come from the deleted model... trap: single worker deletes its only copy → hash unknown → unfetchable! Controller primes model_hashes row from the file's real sha256 BEFORE deleting, via sqlite insert — and notes in the ledger that multi-worker fleets learn organically). Submit 圖片放大 through the panel → observe 下載模型中 progress → auto-download from GCS → job completes → receipt. Regression: a template whose models are all present runs untouched. Then redeploy cloud (migrations + deploy) and smoke the cloud manifest endpoint.
