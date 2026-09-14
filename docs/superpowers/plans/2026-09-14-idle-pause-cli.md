# Idle Detection + Pause/Stop CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** The agent automatically pauses job intake while a human is actively using the machine (BOINC-style, default ON), and gains `pause` / `resume` / `status` / `stop` CLI subcommands, with both platform stacks and the console understanding the new `paused` worker state.

**Architecture:** Jobs are pushed by the platform only to workers whose heartbeat `state == "idle"` (server `agentws.py:1335`, cloud `hub.ts:1435`). So pausing = the agent reporting a new heartbeat state `"paused"` instead of `"idle"` whenever it is unavailable; a running job is never aborted (it finishes; only NEW intake stops). Unavailability has two independent sources OR-ed together: (1) a manual pause flag file written by the CLI, (2) user-activity detection — the OS reports last-input more recently than `idle_minutes` ago. Cross-process control (pause/stop from a second terminal while the service runs in the background) uses small files in the config directory polled by the runner's heartbeat loop — no signals, works identically on all three OSes.

**Tech Stack:** Python ctypes (no new dependencies) for idle detection; existing FastAPI server + CF Workers cloud + React console.

**Spec:** this header + the user's directive (2026-09-14): 「1（閒置偵測，預設開啟）＋3（CLI pause/resume/stop）」. Pause semantics ruled in-session: pause = stop taking new jobs; the in-flight job runs to completion.

## Global Constraints

- zh-TW-first bilingual: every user-facing string (CLI output, console labels, docs) has 繁中 first, English second.
- No new Python dependencies for the agent (ctypes only). No new npm dependencies.
- Never abort a running job because of pause/activity; only stop NEW intake.
- Headless machines (idle detection unavailable → `seconds_since_input()` returns `None`) are treated as ALWAYS idle (available). Detection failure must never make a worker unschedulable.
- Wire compat: agents ≤0.1.1 never send `"paused"`; platforms must keep accepting plain `"idle"/"busy"` unchanged. A `"paused"` heartbeat received by an OLD platform is ignored (state stays) — acceptable, documented.
- All config coercion follows the existing defensive `_coerce_*` posture in `config.py`.
- Tests: pytest for agent/server (never two pytest runs concurrently), vitest for cloud/web. Controller runs full suites; implementers run only their scoped tests, foreground.
- Agent version bumps to 0.1.2 (Task 6).

---

### Task 1: `idle.py` — cross-platform seconds-since-last-input + config fields

**Files:**
- Create: `agent/comfyfed_agent/idle.py`
- Modify: `agent/comfyfed_agent/config.py`
- Test: `tests/agent/test_idle.py`

**Interfaces:**
- Produces: `idle.seconds_since_input() -> float | None` (None = cannot detect on this machine: headless Linux/Wayland-without-X, unsupported OS, any API error). Never raises.
- Produces: `AgentConfig.pause_when_active: bool = True`, `AgentConfig.idle_minutes: float = 5.0` (persisted, coerced: `_coerce_bool` / `_coerce_positive_float`).

**Implementation — one public function dispatching per `sys.platform`:**

```python
def seconds_since_input() -> float | None:
    try:
        if sys.platform == "win32":
            return _win32_seconds()
        if sys.platform == "darwin":
            return _darwin_seconds()
        if sys.platform.startswith("linux"):
            return _linux_seconds()
    except Exception:
        logger.debug("idle: detection failed", exc_info=True)
    return None
```

- `_win32_seconds`: `ctypes.windll.user32.GetLastInputInfo` with `LASTINPUTINFO(cbSize=8)` struct; idle ms = `(kernel32.GetTickCount() - lii.dwTime) & 0xFFFFFFFF` (32-bit wraparound-safe), return /1000.0. If GetLastInputInfo returns 0 → return None.
- `_darwin_seconds`: `ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")`, `CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF)` (kCGEventSourceStateCombinedSessionState=1, kCGAnyInputEventType=~0), `restype=c_double`, argtypes `(c_uint32, c_uint32)`.
- `_linux_seconds`: X11 XScreenSaver — return None immediately if `not os.environ.get("DISPLAY")`; else `ctypes.CDLL("libX11.so.6")` + `ctypes.CDLL("libXss.so.1")`, XOpenDisplay(None) (None → return None), XScreenSaverAllocInfo/QueryInfo → `info.contents.idle / 1000.0`, always XFree + XCloseDisplay in finally. Wayland without XWayland yields None → always-available; document in Task 7.

**Tests** (mock ctypes — no real OS calls): monkeypatch the per-OS helper to prove dispatch + exception→None; a real smoke test that `seconds_since_input()` returns float-or-None without raising on the CI host; config round-trip: defaults (True, 5.0), save/load preserves, `"idle_minutes": "abc"` → 5.0, `"pause_when_active": "off"` → False.

Commit: `feat(agent): cross-platform user-idle detection + pause config fields`

### Task 2: runner integration — availability gate, `paused` heartbeats, control files

**Files:**
- Create: `agent/comfyfed_agent/control.py`
- Modify: `agent/comfyfed_agent/runner.py`
- Test: `tests/agent/test_control.py`, extend `tests/agent/test_runner_pause.py` (new file)

**Interfaces:**
- Produces (`control.py`, all take `config_dir: str`):
  - `PAUSE_FILE = "paused"`, `STOP_FILE = "stop.request"`, `STATE_FILE = "agent_state.json"` (module constants, filenames inside config dir).
  - `is_pause_requested(config_dir) -> bool` / `request_pause(config_dir)` (writes ISO-8601 UTC timestamp as content) / `clear_pause(config_dir)`.
  - `is_stop_requested(config_dir) -> bool` / `request_stop(config_dir)` / `clear_stop(config_dir)`.
  - `write_state(config_dir, state: str, job_id: str | None)` — atomic write (`.tmp-<pid>` + `os.replace`) of `{"pid": os.getpid(), "state": state, "job_id": job_id, "updated_at": <iso-utc>}`.
  - `read_state(config_dir) -> dict | None` (None on missing/corrupt).
  - `availability(cfg, config_dir) -> str` returning `"available"`, `"paused-manual"`, or `"paused-active"`: manual flag wins; else if `cfg.pause_when_active` and `idle.seconds_since_input()` is a float `< cfg.idle_minutes * 60` → `"paused-active"`; else `"available"`.
- Consumes: Task 1's `idle.seconds_since_input`, config fields.

**Runner changes** (`AgentLoop`):
- `self._config_dir = os.path.dirname(os.path.abspath(cfg_path))` in `__init__`; `control.clear_stop(self._config_dir)` at loop start (stale file from a crash must not instantly kill a fresh run).
- In the periodic heartbeat path (`broadcast_heartbeat` / wherever the per-tick state is computed): when the worker would report `"idle"`, first check `control.availability(...)` — if paused, report state `"paused"` instead. `"busy"` is NEVER rewritten (running job keeps its busy beats + job_id).
- Each tick also: `control.write_state(config_dir, effective_state, current_job_id)`; and if `control.is_stop_requested(...)` → log bilingual notice, `control.clear_stop(...)`, then trigger the same graceful path as a console signal (reuse `_graceful_shutdown_and_stop` scheduling exactly as `_on_os_signal` does — read that method first and mirror it, including `shutdown_in_progress`).
- On clean loop exit, best-effort remove STATE_FILE (a `finally`).

**Tests:** control file round-trips incl. corrupt state JSON → None; availability truth table (manual beats active; `None` idle-seconds → available; threshold boundary: exactly `idle_minutes*60` → available, just under → paused-active) via monkeypatched `idle.seconds_since_input`; runner-level: fake connection asserting a tick that would be idle sends `"paused"` when a pause file exists, and that a stop request flips `shutdown_in_progress`. Follow the existing fake-connection patterns in `tests/agent/` (find the runner tests and copy their harness idioms; do not invent a new one).

Commit: `feat(agent): pause/stop control files + paused heartbeat state`

### Task 3: CLI subcommands `pause` / `resume` / `status` / `stop`

**Files:**
- Modify: `agent/comfyfed_agent/main.py`, `agent/pyproject.toml`
- Test: `tests/agent/test_cli_control.py`

**Interfaces:**
- Consumes: Task 2's `control.*`. Config dir = `os.path.dirname(os.path.abspath(args.config))`; all four take `--config` defaulting to `DEFAULT_CONFIG_PATH`.
- Produces: `pyproject.toml` gains a second console script `comfyfed = "comfyfed_agent.main:cli"` (alias, same CLI) so the short name works everywhere the wheel is installed.

**Behavior (all output 繁中 first / English second):**
- `pause`: `control.request_pause`; print 「已暫停接收新工作（最慢一個心跳週期內生效；進行中的工作會跑完）。/ Paused: no new jobs will be accepted (takes effect within one heartbeat; the running job finishes).」
- `resume`: `control.clear_pause`; print confirmation. Note in output: 閒置偵測仍然有效 (auto-pause on activity still applies if enabled).
- `status`: read pause flag + `read_state`. If state file missing or `updated_at` older than 120s → 「agent 未在執行 / agent not running」(still report manual-pause flag). Else print state (idle/busy/paused + job_id if any) bilingually. Exit code 0 always.
- `stop`: `control.request_stop`; print 「已要求 agent 結束（進行中的工作會先跑完）。開機自啟仍在：下次登入／開機會再啟動；要恢復請執行 comfyfed resume 前先手動啟動，或重新登入。/ Stop requested; the running job finishes first. Autostart remains: the agent returns at next logon/boot.」

**Tests:** run each `_cmd_*` against a tmp config dir; assert files created/removed and printed text (capsys) contains both languages; status staleness branch (freeze `updated_at` old) and running branch.

Commit: `feat(agent): pause/resume/status/stop CLI + comfyfed alias entry point`

### Task 4: server accepts `paused`

**Files:**
- Modify: `server/comfyfed_server/agentws.py` (heartbeat state whitelist at `_handle_heartbeat`, protocol doc comment at top; dispatch eligibility at `idle_worker_ids` stays idle-only)
- Test: extend the existing agentws heartbeat tests (find `tests/server/` file covering `_handle_heartbeat`)

**Changes:** `if state in ("idle", "busy", "paused"): conn.state = state`; `elif state == "paused": worker.status = "paused"` in the DB row update. `worker.status` is free-text — no migration. Dispatch loop (`state == "idle"`) untouched → paused workers are skipped naturally; verify with a test: two connected workers, one paused, dispatch picks only the idle one.

Commit: `feat(server): accept paused heartbeat state, exclude from dispatch`

### Task 5: cloud accepts `paused`

**Files:**
- Modify: `cloud/src/do/hub.ts` (`state` union `"idle" | "busy" | "dispatched" | "paused"` at ~147; heartbeat mapping ~874-880: accept `"paused"`, `newStatus` → `"paused"`; dispatch check ~1435 stays `=== "idle"`)
- Test: extend the hub vitest suite covering heartbeats (find it in `cloud/test/`)

**Tests:** paused heartbeat sets worker status `"paused"`; a queued job does NOT dispatch to a paused worker but DOES dispatch after a subsequent idle heartbeat.

Commit: `feat(cloud): accept paused heartbeat state, exclude from dispatch`

### Task 6: console label + agent version bump

**Files:**
- Modify: `web/src/pages/Workers.tsx` (or wherever worker status badges render — locate the existing `online`/`busy`/`offline` badge mapping and add `paused`), `web/src/i18n` (keys `workers.status_paused`: 「已暫停」/「Paused」), `agent/comfyfed_agent/__init__.py` (`__version__ = "0.1.2"`), `agent/pyproject.toml` version.
- Test: extend the Workers page vitest if a status-badge test exists; else snapshot-free assertion that the mapping renders 已暫停 for status "paused". `tsc` must stay clean.

Badge styling: distinct neutral/amber tone, consistent with the existing badge system — reuse existing badge classes, do not invent a parallel style.

Commit: `feat(web): paused worker badge; bump agent to 0.1.2`

### Task 7: installers + docs

**Files:**
- Modify: `server/comfyfed_server/installers/install.sh` (launchd agent plist: `<key>KeepAlive</key><true/>` → `<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>` for the AGENT plist only, `com.comfyfed.agent` — leave the ComfyUI plist as-is; plus *nix `comfyfed` shim: `mkdir -p ~/.local/bin && ln -sf "$VENV/bin/comfyfed" ~/.local/bin/comfyfed` right after wheel install, non-fatal `|| fail_step`-style warning if it fails)
- Modify: `server/comfyfed_server/installers/install.ps1` (after wheel install: write `%LOCALAPPDATA%\ComfyFed\bin\comfyfed.cmd` containing `@"%LOCALAPPDATA%\ComfyFed\venv\Scripts\comfyfed.exe" %*` — build the path from the script's existing venv variable, not hardcoded; then add that `bin` dir to the USER Path via `[Environment]::SetEnvironmentVariable("Path", ..., "User")` ONLY if not already present, case-insensitive substring check; `$LASTEXITCODE`-check any native calls per this repo's PS 5.1 rules)
- Modify: `docs/SELF-HOSTING.zh.md`, `docs/SELF-HOSTING.en.md`: new section 「暫停與停止 / Pause & stop」— the four commands, idle-detection default (5 min, `idle_minutes` / `pause_when_active` in agent.json), headless/Wayland note (偵測不到使用者活動時視為閒置，一律接單；Wayland 桌面若無 XWayland 亦同), PATH note (Windows 需重開終端機才看得到 `comfyfed` / restart the terminal).
- Test: the existing installer test suites (`tests/server/test_installer*`, PSParser syntax test, sh syntax test) must still pass; extend the plist assertion if one exists to match the new KeepAlive dict.

Constraints reminder: install.sh stays pure-LF (`.gitattributes` already pins it); install.ps1 is stored WITH BOM; templates are the single source served by both stacks.

Commit: `feat(installer): comfyfed on PATH + launchd no-resurrect-on-clean-exit; docs`

---

### Final steps (controller, not a task)

1. Full suites foreground: agent+server pytest (one at a time), cloud vitest, web vitest + tsc.
2. Final whole-branch review subagent (most capable model), fix wave if needed.
3. Merge to main (stash local wrangler.jsonc database_id edit first, pop after), push.
4. Build agent wheel 0.1.2, publish to cloud via `/api/workers/agent-release`, rebuild+deploy cloud, verify `/api/agent/version` shows 0.1.2.
