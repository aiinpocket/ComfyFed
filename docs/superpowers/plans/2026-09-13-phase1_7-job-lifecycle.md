# Phase 1.7: Job Lifecycle & Dispatch Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zombie-run elimination and real cancellation: a worker whose job was requeued learns within one heartbeat and aborts (interrupt + cleanup) instead of finishing uselessly; a worker that merely blipped offline and comes back with the finished result gets it accepted (re-adoption); humans can cancel jobs from the console AND the embedded panel's native controls; dispatch picks the best eligible worker instead of first-come.

**Architecture:** Server-side: a `cancelled` terminal status, a `job_cancelled` WS push whenever an authenticated agent references a job it no longer owns (dedup per connection), `Job.last_worker_id` (Alembic migration) to distinguish "you blipped, welcome back" from "someone else owns it now", an admin cancel API + ComfyUI-compat mappings (`POST /interrupt`, `POST /queue` delete). Agent-side: `handle_job` moves to a background task so the WS receive loop keeps consuming messages mid-run; `job_cancelled` interrupts ComfyUI (`POST /interrupt` if executing, `POST /queue {"delete":[...]}` if still queued locally) and runs file cleanup. Dispatch: rank eligible idle workers per job (clean > warned, then most free VRAM).

**Tech Stack:** FastAPI, SQLAlchemy+Alembic (migration #5), websockets/httpx (agent), React console (Mantine, react-i18next), pytest + vitest.

**Spec:** docs/superpowers/specs/2026-09-12-comfyfed-spec.md — Phase 1.7 addendum (appended alongside this plan). Code facts verified from the tree at merge 4bf96c5/fc02a65: `dispatch.pick_job_for` walks queued jobs oldest-first per idle connection; `requeue_stale` (90s) sets `status=queued, worker_id=None, progress=0`; `_owned_job` silently drops (WARNING log) any worker message for a job it doesn't own; agent `_handle_message` **awaits** `handle_job` inline, so nothing else on that socket is read during a run; heartbeats are sent by a separate task and carry `job_id` while busy.

## Global Constraints

- All user-facing strings zh-TW first with en translation where the console i18n catalog is touched (existing react-i18next pattern; server messages follow existing zh-TW conventions).
- Full suite green at every task commit (`.venv/Scripts/python.exe -m pytest tests -q` from repo root — 442 passing at branch point; `tests/server/test_auth.py::test_read_session_payload_rejects_absent_and_tampered_cookies` is a known pre-existing flake: rerun to confirm, don't chase) (resolved in Phase 1.9 Task 8 — root cause: the tamper flipped the token's last base64 char, whose bits are partly discarded padding, so ~6% of runs produced an alias that still decoded to the same signature). Console: `cd web && npx vitest run` (11 passing at branch point).
- Never modify files under `data/comfy_frontend/`.
- Alembic migration must be additive and reversible (`last_worker_id` nullable TEXT, no backfill needed).
- A cancelled job bills nothing: no receipt row is ever created for it.
- Protocol messages are JSON over the existing authenticated agent WS; new message type literal: `{"type": "job_cancelled", "job_id": "<id>"}` (server→agent only). Agents that don't understand it must be unaffected (old agent logs unknown-type warning and continues — verified acceptable; the runner's else-branch only logs).
- The single-job invariant stays: an agent runs at most one job at a time (`self._job_lock` semantics preserved when handle_job becomes a task).

---

### Task 1: Server cancellation core — `cancelled` status, `job_cancelled` push, re-adoption

**Files:**
- Modify: `server/comfyfed_server/dispatch.py`, `server/comfyfed_server/agentws.py`, `server/comfyfed_server/db.py` (model: `last_worker_id`), `server/alembic/versions/` (new migration #5)
- Test: `tests/server/test_dispatch.py`, `tests/server/test_agentws.py` (extend both)

**Interfaces:**
- Produces: `dispatch.cancel_job(job_id, *, reason: str) -> str | None` — moves a queued/assigned/running job to `cancelled` (sets `error=reason`, `finished_at`), returns the owning worker_id at time of cancel (None if unowned) so callers can push `job_cancelled`; no-op returning None on terminal/unknown jobs. `dispatch.try_readopt(job_id, worker_id) -> bool` — if job is `queued` AND `last_worker_id == worker_id`, restore ownership (`status=assigned, worker_id=worker_id`) and return True. `_TERMINAL_STATUSES` gains `"cancelled"`.
- `requeue_stale` records `last_worker_id = worker.id` on every job it requeues.
- agentws: helper `await _send_job_cancelled(conn, job_id)` with per-connection dedup set (cleared when the connection drops); invoked whenever `mark_running`/`mark_done`/`mark_failed`/progress handling hits the not-owned path, and on busy heartbeats whose `job_id` the worker doesn't own.
- job_done path: before rejecting a not-owned `job_done`, call `dispatch.try_readopt(job_id, worker_id)`; on success proceed exactly as an owned completion (mark_done, receipt, panel events). On failure, reject AND `_send_job_cancelled`.
- Artifact upload (`workers.py` or wherever `POST /api/agent/jobs/{id}/artifacts` ownership-gates): accept uploads when `try_readopt` would succeed — concretely, allow when `job.worker_id == worker_id` OR (`status == "queued"` AND `last_worker_id == worker_id`); do NOT flip ownership from the upload path itself (read-only check), the job_done message does the adoption. Find the actual gate with grep and adapt minimally.

Steps (TDD; run the suite after each green):
- [ ] **Step 1: Failing tests — migration + model.** `last_worker_id` column exists, nullable, default None; alembic upgrade head from a pre-existing DB works (there are existing migration tests to copy the harness from — grep `alembic` in tests/server).
- [ ] **Step 2: Failing tests — requeue_stale records last_worker_id** for each requeued job, and clears worker_id as today.
- [ ] **Step 3: Failing tests — cancel_job**: queued→cancelled (returns None), assigned/running→cancelled (returns worker id, error=reason, finished_at set); done/failed/cancelled/unknown → None and unchanged; no receipt row created.
- [ ] **Step 4: Failing tests — try_readopt**: queued+matching last_worker_id → assigned to that worker, True; queued+different last_worker → False unchanged; assigned-to-other → False; terminal → False.
- [ ] **Step 5: Failing tests — agentws pushes**: (a) busy heartbeat carrying a job_id owned by another worker → connection receives `job_cancelled` exactly once even across repeated heartbeats (dedup), and the WARNING log still fires; (b) `job_done` for a job requeued from this same worker (status queued, last_worker_id=this) → re-adopted: job ends `done`, receipt created, panel notified, NO job_cancelled sent; (c) `job_done` for a job now running on worker B → rejected, A receives job_cancelled, B's job untouched; (d) artifact upload in the blip window (queued + last_worker_id match) → 200 accepted.
- [ ] **Step 6: Implement** (migration first, then dispatch, then agentws), matching existing module conventions (docstring style, log-level split WARNING/DEBUG rationale in `_owned_job` — extend it, don't fork it).
- [ ] **Step 7: Full suite; commit** `feat(server): cancelled status, job_cancelled push, blip re-adoption (migration 5)`.

### Task 2: Cancel entry points — admin API, panel /interrupt + /queue delete, console button

**Files:**
- Modify: `server/comfyfed_server/app.py` or the module holding `/api/jobs` routes (grep), `server/comfyfed_server/comfyapi.py` (POST /interrupt, POST /queue delete handling), `server/comfyfed_server/panelws.py` (job_cancelled panel event so the badge/executing state clears), `server/comfyfed_server/i18n.py` if server strings are catalogued there
- Modify: `web/src/` console jobs page (cancel button + confirm + status chip for `cancelled`), i18n zh-TW/en catalogs
- Test: `tests/server/test_comfyapi.py`, `tests/server/test_jobs_api.py` (or wherever /api/jobs routes are tested), web vitest for the jobs page

**Interfaces:**
- Consumes: `dispatch.cancel_job` + agentws send from Task 1. Produces: `POST /api/jobs/{id}/cancel` (admin session; 200 `{"status":"cancelled"}`, 404 unknown, 409 if already terminal with the terminal status in the body); comfyapi `POST /interrupt` cancels the currently-executing panel job (the one panelws tracks as executing; 200 always, matching upstream's fire-and-forget contract); comfyapi `POST /queue` with body `{"delete": [prompt_ids]}` cancels those queued/assigned jobs (upstream contract: also `{"clear": true}` empties the queue — support both); each cancellation of an owned assigned/running job pushes `job_cancelled` to the owning agent connection and emits the panel event.
- Console: jobs table row action 取消 (only for queued/assigned/running), optimistic refresh, `cancelled` rendered as its own status chip (zh-TW 已取消 / en Cancelled).

- [ ] **Step 1: Failing server tests** for the three entry points incl. WS push to owner and panel event; `{"clear": true}` cancels every non-terminal panel-submitted job.
- [ ] **Step 2: Implement server side.**
- [ ] **Step 3: Failing vitest** for the cancel button rendering/click wiring (mock fetch), status chip.
- [ ] **Step 4: Implement console; `npx vitest run` green; also `npm run build` must succeed** (the live install serves `web/dist`).
- [ ] **Step 5: Full suites; commit** `feat: job cancellation via console and native panel controls`.

### Task 3: Agent — concurrent job task + cancellation handling

**Files:**
- Modify: `agent/comfyfed_agent/runner.py`, `agent/comfyfed_agent/comfy.py` (interrupt/queue-delete helpers)
- Test: `tests/agent/test_runner.py`, `tests/agent/test_comfy.py` (find the actual agent test paths with glob and extend)

**Interfaces:**
- `_handle_message` no longer awaits `handle_job` inline: it spawns `asyncio.create_task(self.handle_job(conn, msg))`, stored as `self._current_job_task` with `self._current_job_id`; the global one-job-at-a-time lock stays (a second `job` message while busy is handled however it is today — verify and preserve).
- New message branch: `job_cancelled` → if it names the current job: set a per-job `asyncio.Event` (checked by the run loop) AND call `comfy.interrupt_or_dequeue(prompt_id)` (`POST /interrupt` when this prompt is ComfyUI's `queue_running` head, else `POST /queue {"delete": [prompt_id]}`); the running `handle_job` task then winds down WITHOUT sending job_done/job_failed for the cancelled job, runs `cleanup_job_files` for whatever inputs were staged and outputs already produced (cancel cleanup must not require `success=True` — refactor the flag into an explicit mode), and returns the agent to idle (broadcast idle heartbeat as today). If it names a non-current job: log at DEBUG, ignore.
- `comfy.run_workflow` gains cooperative cancellation: its polling loop checks the cancel event each iteration and raises a dedicated `JobCancelled` exception that `handle_job` catches (no job_failed message for it).

- [ ] **Step 1: Failing tests**: (a) receive loop stays responsive during a running job (send `job_cancelled` mid-run against a fake slow ComfyUI; assert interrupt called, no job_done/job_failed sent, cleanup ran, agent broadcasts idle); (b) cancel for a *queued-locally* prompt uses /queue delete not /interrupt; (c) cancel for unknown job id is ignored quietly; (d) normal completion path unchanged (job_done still sent, cleanup on success still happens); (e) receipt message arriving mid-run is still processed (proves the loop is truly concurrent).
- [ ] **Step 2: Implement. Step 3: Full suite; commit** `feat(agent): concurrent job execution with server-driven cancellation`.

### Task 4: Dispatch ranking — best worker per job

**Files:**
- Modify: `server/comfyfed_server/dispatch.py`, `server/comfyfed_server/agentws.py` (`dispatch_tick` collects idle connections first)
- Test: `tests/server/test_dispatch.py`

**Interfaces:**
- New: `dispatch.assign_jobs(idle_worker_ids: list[str]) -> list[tuple[str, db.Job]]` — for each queued job oldest-first, evaluate every still-unassigned idle worker's verdict and pick the best: (1) eligible with no warnings beats eligible-with-warnings (vram_offload), (2) tie-break by largest free VRAM (from the worker's dynamic/hardware snapshot — reuse whatever `assess.verdict` reads), (3) stable tie-break by worker name for determinism. Atomic claim per pair exactly as `pick_job_for` does today (keep the rowcount guard). Each worker gets at most one job per tick. `pick_job_for` stays for any other callers (grep; if none besides dispatch_tick, fold it in and delete).
- `dispatch_tick` calls `assign_jobs` once with all idle connection ids, then pushes each (worker, job) pair on its connection.

- [ ] **Step 1: Failing tests**: two idle workers (one clean-eligible, one vram_offload-warned) + one job → clean one gets it; two clean workers with different free VRAM → larger wins; two jobs oldest-first across two workers → both assigned in one tick; claim race (job already taken) skips gracefully.
- [ ] **Step 2: Implement. Step 3: Full suite; commit** `feat(server): rank eligible workers when dispatching (clean > warned, then free VRAM)`.

### Task 5 (controller-executed): Live verification

- Stop server AND agent (same wheel!), reinstall, restart; console: cancel a queued job → chip 已取消; panel: run wuxia then hit the native ✕/interrupt → job cancelled, agent log shows interrupt + cleanup, no receipt row; blip test: kill agent mid-run, wait >90s (requeue), restart agent — on its job_done attempt it must receive job_cancelled and clean up (or, if within the queued window with no other worker, be re-adopted — verify at least one path live); confirm exec-seconds receipts unaffected for a normal run.
