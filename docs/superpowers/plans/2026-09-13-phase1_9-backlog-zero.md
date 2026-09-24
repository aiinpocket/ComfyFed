# Phase 1.9: Backlog Zero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every recorded defect / known-limitation in the codebase and docs: job origin scoping, panel history delete, agentws memory/log hygiene, full missing-model guidance in the panel Errors tab, hide the dead 登入 button, non-billable receipts for failed/cancelled runs, agent protocol v2 (platform report + guaranteed exec_seconds), CPU-light job dispatch preference (weak-GPU/Mac workers get merge-style jobs), template-index caching, download size caps, object_info intersection mode, the auth test flake, a console job-detail page, and LICENSE.

**Architecture:** All server work stays inside the existing FastAPI modules; three Alembic migrations (#6 job origin+panel_hidden, #7 receipt kind/billable/basis, #8 worker protocol). Agent bumps to protocol 2 (adds `protocol`, `platform`, exec_seconds-on-failure). Web console gains a `/jobs/:id` detail route. No new dependencies.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic + pytest (server), asyncio agent, React 18 + Mantine 7 + vitest (web).

**Spec:** docs/superpowers/specs/2026-09-12-comfyfed-spec.md. Facts below marked "verified" come from a live code survey of a747e79 — treat as ground truth, do not re-derive.

## Global Constraints

- Suite green at every commit: `.venv/Scripts/python.exe -m pytest tests -q` (base 584) and, when web/ touched, `cd web && npx vitest run` (base 15). The auth-flake exemption ends at Task 8 — after it, zero reruns allowed.
- zh-TW-first bilingual user-facing copy. `data/comfy_frontend/` (live dist) is read-only reference — never patch the bundle; server-side hooks only.
- The decommissioned R2 mirror domain must not reappear anywhere. GCS base: `https://storage.googleapis.com/comfyfed-models/models/`.
- Existing wire messages stay backward compatible: a protocol-1 agent must still connect and run jobs (it just gets a deprecation warning frame and wall-clock billing basis).
- Alembic: each migration must `upgrade` from the previous head `d4e5f6a7b8c9` chain and have a working `downgrade`.
- Never log secrets. Never widen CSRF exemptions.

---

### Task 1: Job origin, scoped panel controls, panel history delete

**Files:**
- Modify: `server/comfyfed_server/db.py` (Job model), `server/comfyfed_server/jobs.py` (create_job + POST /api/jobs), `server/comfyfed_server/comfyapi.py` (post_prompt, /interrupt, /queue, /history)
- Create: `server/alembic/versions/<rev>_job_origin_panel_hidden.py` (migration #6, down_revision d4e5f6a7b8c9)
- Test: `tests/server/test_comfyapi.py`, `tests/server/test_jobs.py`

**Verified facts:** `db.Job` has no origin column; both creators funnel through `jobs.create_job()` — panel at comfyapi.py:707, console at jobs.py:145. `/interrupt` today cancels the federation's oldest assigned/running job regardless of submitter; `{"clear":true}` cancels every non-terminal job (spec L125 "Known limitation").

**Behavior:**
- Migration #6 adds `origin TEXT NOT NULL DEFAULT 'console'` and `panel_hidden BOOLEAN NOT NULL DEFAULT 0` to jobs.
- `create_job(..., origin: str)`; comfyapi stamps `"panel"`, console `"console"`.
- `POST /comfy/api/interrupt`: only considers jobs with `origin == "panel"`.
- `POST /comfy/api/queue {"delete": [...]}` and `{"clear": true}`: cancel only non-terminal panel-origin jobs; console jobs untouched.
- Panel history delete: grep the live frontend dist (`D:\ComfyFed-live\data\comfy_frontend`, e.g. the api chunk) for how the frontend deletes history items (ComfyUI upstream posts `{"delete": [prompt_id, ...]}` to `/api/history`; verify the exact shape/method in the dist before implementing). Implement that endpoint: for each named terminal panel-origin job set `panel_hidden = True` (never delete rows — receipts reference jobs). `{"clear": true}` on history hides all terminal panel-origin jobs. `/history` GET responses exclude `panel_hidden` jobs. Console `/api/jobs` still lists everything (console is the audit surface).
- Console jobs list/detail responses include `origin`.

Steps: failing tests (panel /interrupt skips console job; /queue clear leaves console job queued; history delete hides only named terminal panel jobs and GET /history omits them; create_job stamps both origins; migration up/down), implement, full suite, commit `feat(server): job origin column, scoped panel controls, panel history delete`.

### Task 2: agentws hygiene — bounded cancel dedup, rate-limited warnings

**Files:**
- Modify: `server/comfyfed_server/agentws.py`, `server/comfyfed_server/dispatch.py` (`_owned_job` logging only)
- Test: `tests/server/test_agentws.py`

**Verified facts:** `_Connection.cancelled_jobs_sent: set` (agentws.py:91) is unbounded for the connection's lifetime. `_owned_job` (dispatch.py:289–306) logs WARNING on every not-owned/unknown/finished reference; agentws.py:222 warns on every unknown message type. Only the push is deduped, not the log.

**Behavior:**
- `cancelled_jobs_sent` becomes a bounded LRU (OrderedDict, cap 512; evict oldest on overflow). Eviction may cause a rare duplicate `job_cancelled` push — harmless (agent treats it idempotently); assert that in a test comment.
- Warning rate limit: per connection, the first not-owned/unknown reference to a given job id logs WARNING; subsequent references to the same (connection, job_id) log DEBUG. Same policy for unknown message types keyed by type name. Implement in agentws (a small bounded seen-set, cap 512, same LRU helper) — `_owned_job` gains a `log_level` parameter or agentws pre-checks; keep dispatch.py's behavior for other callers unchanged.

Steps: failing tests (cap enforced + eviction order; caplog shows 1 WARNING then DEBUG for repeats; unknown-type similarly), implement, suite, commit `fix(server): bound agentws dedup memory and rate-limit repeat warnings`.

### Task 3: Missing-model guidance in the panel Errors tab (node_errors)

**Files:**
- Modify: `server/comfyfed_server/assess.py` (model→node mapping), `server/comfyfed_server/comfyapi.py` (post_prompt 400 body)
- Test: `tests/server/test_comfyapi.py`, `tests/server/test_assess.py`

**Verified facts:** The Errors tab renders prompt-level errors from `error.message` only; the `details` string the server puts on the top-level error never reaches the tab. The tab's scrollable details box is fed exclusively by `node_errors[<graph node id>].errors[].details` (frontend `useErrorGroups.ts:398–399`, schema: `node_errors: {"<id>": {class_type, dependent_outputs: [], errors: [{type, message, details, extra_info}]}}`, details = plain string). The legacy dialog concatenates `message + ': ' + details` and must keep working.

**Behavior:**
- `assess` gains `model_nodes(prompt) -> dict[str, list[tuple[str, str]]]` mapping each referenced model name → list of (node_id, class_type) that reference it, using the same extraction rules as the existing requirements walk (single source of truth — refactor so both paths share the walker, don't duplicate).
- `post_prompt`'s missing-models 400 keeps today's top-level `error {type, message, details}` unchanged and ADDS `node_errors`: for every missing model, for each referencing node: `{class_type, dependent_outputs: [], errors: [{"type": "comfyfed.missing_model", "message": <one-line zh-TW summary for that model>, "details": <that model's full guidance block from model_guide (its 【name】 section: path + official + backup links)>, "extra_info": {}}]}`. Multiple missing models on one node → multiple entries in that node's errors list. Per-model guidance sections must be extracted from model_guide by refactoring `guidance_message` into per-model block builder + joiner (keep `guidance_message` output byte-identical — tests pin it).
- Missing-nodes note (custom nodes) stays top-level only.

Steps: failing tests (node_errors shape exact for 1 model on 2 nodes + 2 models on 1 node; top-level unchanged; guidance_message byte-identical), implement, suite, commit `feat(server): per-node missing-model errors so the panel Errors tab shows full guidance`.

### Task 4: Panel extension — hide the dead 登入 button

**Files:**
- Create: `server/comfyfed_server/panel_ext/__init__.py` (empty), `server/comfyfed_server/panel_ext/comfyfed.js`
- Modify: `server/comfyfed_server/comfyapi.py` (`GET /comfy/api/extensions` + a route serving the JS), `pyproject.toml` only if package-data include patterns need the new dir (check `[tool.hatch...]`/`[tool.setuptools...]` config — templates_data is included somehow; mirror that mechanism)
- Test: `tests/server/test_comfyapi.py`

**Verified facts:** `show_signin_button` is a dead flag in frontend 1.52.7 — nothing reads it. The button is `LoginButton.vue` gated purely on client-side `isLoggedIn`, mounted in TopMenuSection and WorkflowTabs. The sanctioned server hook: `GET /comfy/api/extensions` currently returns `[]` (comfyapi.py:951–953); the frontend fetches and imports every listed JS module URL.

**Behavior:**
- `GET /comfy/api/extensions` returns `["/comfy/api/comfyfed-ext/comfyfed.js"]`.
- New GET route `/comfy/api/comfyfed-ext/comfyfed.js` serves the packaged file with `media_type="application/javascript"` (read via importlib.resources like templates_data).
- `comfyfed.js`: an ES module that injects one `<style>` tag hiding the login button in both mounts. Before writing selectors, grep the dist for the rendered attributes of LoginButton (search `LoginButton`, `login-button`, `data-testid` in `D:\ComfyFed-live\data\comfy_frontend\assets\*.js`) and use the real testid/class; include a fallback attribute selector. Keep the file tiny and commented (zh-TW + en) explaining why (federation has no Comfy cloud login).
- Keep sending `show_signin_button: false` in feature_flags (harmless, future-proof).

Steps: failing tests (extensions list; JS route 200 + mime + non-empty body containing `display:none`), implement, verify packaged-data inclusion (`pip install .` into a tmp venv or `python -c "import importlib.resources..."` from an sdist-like check), suite, commit `feat(server): panel extension hides Comfy-cloud login button`.

### Task 5: Receipts for failed and cancelled runs (non-billable)

**Files:**
- Modify: `server/comfyfed_server/db.py` (Receipt), `server/comfyfed_server/agentws.py` (mint paths), `server/comfyfed_server/dispatch.py` (cancel path data), `server/comfyfed_server/receipts.py` (report split), `agent/comfyfed_agent/runner.py` (exec_seconds on failure)
- Create: `server/alembic/versions/<rev>_receipt_kind_billable_basis.py` (migration #7)
- Test: `tests/server/test_agentws.py`, `tests/server/test_receipts.py`, `tests/agent/test_runner.py`

**Verified facts:** Receipts are minted only in `agentws._create_and_push_receipt` on job_done; payload string `f"{job_id}|{worker_id}|{gpu_seconds:.1f}"` is signed by platform, pushed, and counter-signed by the worker via receipt_ack. README documents "失敗的工作不會產生收據…沒被記帳" as a known limitation — this task removes it.

**Behavior:**
- Migration #7 adds to receipts: `kind TEXT NOT NULL DEFAULT 'completed'` (`completed|failed|cancelled`), `billable BOOLEAN NOT NULL DEFAULT 1`, `basis TEXT NOT NULL DEFAULT 'exec'` (`exec|wall`).
- Payload string format is UNCHANGED (existing worker verifiers must keep validating); kind/billable/basis ride in the receipt row + the receipt WS frame as extra fields (old agents ignore extras — verify the agent's ack path signs only the payload string; it does).
- job_failed: agent (see below) now includes `exec_seconds` when measurable; server mints a receipt kind=failed, billable=0, gpu_seconds = exec_seconds if provided else wall-clock (started_at→now, basis=wall), pushed for counter-signature exactly like completed receipts.
- Human/panel cancel of a RUNNING job (started_at set): server mints kind=cancelled, billable=0, basis=wall, gpu_seconds = started_at→cancel wall seconds. Queued-job cancels stay receipt-free (nothing ran). The mint happens where cancel_job confirms a running victim (cancel_job returns enough state; do the mint in the caller that has the signing key — agentws/dispatch boundary: add a small hook so all three cancel entry points produce it exactly once). Worker may be offline at mint time: receipt stores worker_sig NULL until an ack arrives; report marks unacked.
- Agent `_report_failure` includes `exec_seconds` computed the same way as success (`comfy.py` measures queue_running interval) when the prompt actually started; omit otherwise.
- `/api/reports/contributions`: billable seconds remain the headline numbers (unchanged semantics); response gains `unbilled_gpu_seconds` per worker and total (sum of billable=0 receipts), and per-receipt listings include kind/billable/basis.

Steps: failing tests (failed mints billable=0 exec-basis; failed without exec_seconds → wall basis; running-cancel mints cancelled receipt once across entry points; queued-cancel mints none; report splits billable/unbilled; payload string byte-format pinned), implement server+agent, suite, commit `feat: non-billable receipts for failed and cancelled runs`.

### Task 6: Agent protocol 2 — platform report, guaranteed exec_seconds, light-job dispatch preference

**Files:**
- Modify: `agent/comfyfed_agent/hardware.py` (platform), `agent/comfyfed_agent/runner.py` (hello protocol), `server/comfyfed_server/agentws.py` (hello handling, deprecation frame), `server/comfyfed_server/db.py` (Worker.protocol), `server/comfyfed_server/dispatch.py` (ranking), `web/src/pages/Workers.tsx` ONLY if trivially adding platform display (else skip UI)
- Create: `server/alembic/versions/<rev>_worker_protocol.py` (migration #8)
- Test: `tests/agent/test_runner.py`, `tests/server/test_agentws.py`, `tests/server/test_dispatch.py`

**Verified facts:** hello = `{"type":"hello","hardware":{gpu_name,vram_gb,cpu,cpu_cores,ram_gb,agent_version},"backend":cuda|rocm|mps|cpu,"torch_version",...,"node_classes":[...]}`; `platform.system()` is never reported. `Worker.backend` IS already a DB column (db.py:50, stored at agentws.py:390). Ranking today (dispatch.py:104–120): `(has_warnings, -free_vram, name, worker_id)` — a zero-model job can steal the biggest GPU. `db.Job.required_models` (JSON) + `est_vram_gb` (nullable) identify CPU-light work.

**Behavior:**
- Agent hello gains `"protocol": 2` and hardware gains `"platform": platform.system()` (`Windows|Darwin|Linux`).
- Migration #8: `workers.protocol INTEGER NOT NULL DEFAULT 1`. Server records it from hello.
- Protocol-1 agents: still fully served (backward compat, Global Constraint), but the server sends one `{"type":"deprecation","message":"..."}` frame after hello (zh-TW+en text: agent 版本過舊，請更新以支援取消通知與精確計費) and never `job_cancelled` frames to them (they'd only log unknown-type warnings); their receipts get basis=wall unless exec_seconds present.
- Protocol-2 job_done/job_failed missing exec_seconds when the run started → server logs ERROR (protocol violation) and falls back to wall basis; receipt records basis honestly. (Agent side already guarantees it after Task 5.)
- **Light-job preference** in `assign_jobs`: a job is light iff `needs.models == []` and `(needs.est_vram_gb or 0) == 0`. For light jobs the candidate sort key becomes `(has_warnings, not is_weak_backend, free_vram, name, worker_id)` where `is_weak_backend = worker.backend in ("mps","cpu")` — i.e. clean first, then Mac/CPU workers first, then SMALLEST free VRAM (weakest GPU) first. Heavy jobs keep the existing key exactly. Rationale comment in code: 合併影片這類零模型工作交給弱 GPU／Mac，把大卡留給模型任務.

Steps: failing tests (hello v2 recorded; platform in hardware; deprecation frame to v1 only; no job_cancelled push to v1; light job picks mps worker over 32GB cuda; light job picks 8GB cuda over 24GB cuda; heavy job ranking unchanged; migration), implement, suite, commit `feat: agent protocol 2 and CPU-light job dispatch preference`.

### Task 7: Template index caching, download size caps, object_info intersection mode

**Files:**
- Modify: `server/comfyfed_server/templates.py`, `server/comfyfed_server/official_templates.py`, `server/comfyfed_server/comfyapi.py` (object_info merge), `server/comfyfed_server/auth.py` or wherever `/api/settings` schema lives (new setting)
- Test: `tests/server/test_templates.py`, `tests/server/test_official_templates.py`, `tests/server/test_comfyapi.py`

**Verified facts:** `_merged_index` (templates.py:234–247) re-reads both index.json files and re-strips every workflow JSON on every request — no cache. `official_templates._download` (89–99) buffers whole wheels in a bytearray with no size cap. object_info serves the union only (spec L83 lists intersection as the Phase 2 conservative option).

**Behavior:**
- templates.py: cache merged index and per-file stripped JSON keyed by (path, mtime) — invalidate when any source file's mtime changes (index cache keys on both index files' mtimes). Model: `model_guide.harvest`'s existing mtime cache. Bounded: per-file cache LRU cap 256 entries.
- official_templates: stream downloads to a temp file (no whole-wheel bytearray) and enforce a hard cap — 512 MB per wheel, abort with a clear zh-TW error beyond it; sha256 computed while streaming.
- object_info: settings row `object_info_mode` = `union` (default) | `intersection`; `/api/settings` GET/PUT exposes it (admin, CSRF, validated enum). Intersection semantics: node classes present on EVERY online worker; per-class widget/value merge keeps the union-merge behavior for the classes that survive (values like checkpoint lists still union — intersection governs node-class presence only; document why in a docstring: 交集模式保證派得出去，下拉內容仍聯集因為模型檔各 worker 本就不同). Cache keyed by (fleet frozenset, mode).
- Console Settings page: add the toggle only if `/api/settings` is already rendered generically there; otherwise API-only is acceptable for this task (web UI wiring may ride Task 9's commit if shared files conflict).

Steps: failing tests (second index request does zero re-reads — monkeypatch open/json.load counter; mtime bump invalidates; oversize wheel aborts mid-stream; intersection drops a node class missing on one worker but keeps union'd values; settings enum validation), implement, suite, commit `perf(server): template caches, download caps, object_info intersection mode`.

### Task 8: Kill the auth cookie test flake for real

**Files:**
- Investigate/Modify: `tests/server/test_auth.py::test_read_session_payload_rejects_absent_and_tampered_cookies`, possibly `server/comfyfed_server/auth.py`
- Test: same file

**Verified facts:** Twice recorded as "known flake — rerun, don't chase" (phase1_7:16, phase1_8b:15). That exemption dies here.

**Behavior:** Reproduce deterministically: run the single test 500× (`--count` via a quick loop or pytest-repeat if present; a bash for-loop over pytest -q is fine). Diagnose the actual mechanism (candidate hypotheses to check, in order: tamper mutation occasionally producing a still-valid token — e.g. flipping a character in the base64 alphabet that decodes identically or mutating the payload while the signature check only covers part; time-window edge in URLSafeTimedSerializer max_age; secret containing separator chars). Fix at the root: if the test's tamper strategy is unsound, make the mutation provably signature-breaking (e.g. flip a char in the SIGNATURE segment after the last dot, asserting the mutated char differs); if the product code is at fault, fix auth.py. Then run the test 500× green, and remove the "known flake" caveats from both plan docs (edit the two lines to note "resolved in Phase 1.9 Task 8").

Steps: reproduce → root-cause note in the test docstring → fix → 500× green → full suite → commit `fix(tests): make session-cookie tamper test deterministic (root-caused)`.

### Task 9: Console job detail page

**Files:**
- Create: `web/src/pages/JobDetail.tsx`, `web/src/pages/JobDetail.test.tsx`
- Modify: `web/src/App.tsx` (route `/jobs/:id`), `web/src/pages/Jobs.tsx` (row link), `web/src/i18n.ts` (new keys zh-TW + en), server `server/comfyfed_server/jobs.py` ONLY if GET /api/jobs/{id} detail (single job incl. receipt + origin + artifacts list) doesn't already exist — verify; add if missing with tests in `tests/server/test_jobs.py`
- Test: vitest + pytest as touched

**Verified facts:** No job-detail route exists (App.tsx routes: /dashboard /jobs /workers /reports /settings). Job errors render only as a truncated tooltip on the Jobs table (Jobs.tsx:650–651). Artifacts download endpoint + text artifacts already exist server-side.

**Behavior:** `/jobs/:id` shows: status chip (incl. 已取消), origin (面板/Console), timeline (created/started/finished + duration), worker (link-less name), full error text in a scrollable `<Code block>` (THE fix for the truncated-tooltip complaint — full model guidance readable here), input assets list, output artifacts (images inline via the existing download URL, .txt content rendered in a copyable block, other files as download links), receipt summary when present (gpu_seconds, kind, billable, basis, ack state), cancel button for non-terminal (reuse Jobs.tsx's existing cancel call), retry if that exists. Bilingual via i18n. Jobs table: job id cell becomes a router Link.

Steps: failing vitest (renders error full text; renders txt artifact content; cancel visible only non-terminal), implement, `npx vitest run` + pytest if server touched, commit `feat(web): job detail page with full error guidance and artifacts`.

### Task 10: LICENSE and doc truth-up

**Files:**
- Create: `LICENSE` (AGPL-3.0 full text)
- Modify: `pyproject.toml` + `agent/pyproject.toml` if separate (license field), `web/package.json` (license field), `docs/superpowers/specs/2026-09-12-comfyfed-spec.md`, `docs/superpowers/plans/2026-09-12-comfyfed-phase1.md`, `2026-09-12-comfyfed-phase1_5-comfy-panel.md`, `2026-09-13-phase1_6-official-templates.md` (+1_7, 1_8, 1_8b): checkbox marking + stale-line fixes
- Test: none (docs) — but full suite must still pass (license field syntax)

**Behavior:**
- LICENSE = AGPL-3.0-only (rationale recorded in commit message: matches the AI Horde lineage the spec cites; copyright holder aiinpocket retains dual-licensing freedom). pyproject `license = "AGPL-3.0-only"` (or classifier form matching existing style).
- Spec: delete the L125 known-limitation paragraph, replacing with one line stating origin scoping shipped in 1.9; fix L110 to describe the actual fleet-wide-including-offline predicate (verify against comfyapi code first — describe what the code does); L83 note intersection mode shipped; add one Phase 1.9 summary bullet to §9.
- Plans: tick every `- [ ]` → `- [x]` in the five shipped plan files (they are all merged); fix phase1.md:221 and :355 stale exclusions with a one-line "(superseded — shipped in 1.7 / 1.5)" annotation; phase1_7/1_8b flake caveats already edited by Task 8 — verify.
- README is NOT touched here (full rewrite is a later phase — leave it).

Steps: write, `python -c "import tomllib; tomllib.load(open('pyproject.toml','rb'))"` sanity, suite, commit `docs: AGPL-3.0 license, spec/plans truth-up`.
