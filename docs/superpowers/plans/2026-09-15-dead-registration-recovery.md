# Dead-Registration Recovery Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** An agent whose worker was deleted (or whose credentials are otherwise rejected) fails loudly and recoverably instead of silently spamming 4401 forever, never accumulates duplicate registrations for the same platform, and a re-run of the installer self-heals a dead registration.

**Architecture:** Four coordinated fixes in the agent + installer. Root cause of the live incident: `identity.register` APPENDS a new `PlatformEntry` on every registration, so repeated installs to the same `platform_url` accumulate entries; when those workers are deleted server-side, every stale entry's handshake returns WS close code 4401 and the agent retries all of them forever, while the periodic/broadcast heartbeat also crashes on the down connection.

**Tech Stack:** Python agent (`agent/comfyfed_agent/`), PowerShell/bash installers.

**Spec:** this file. Live incident: worker `1c16005c` (deleted) still in a machine's `agent.json`; log shows `ConnectionClosedError: received 4401` on `handshake()` looping, plus `AttributeError: 'NoneType' object has no attribute 'send'` from `broadcast_heartbeat` on the down connection.

## Global Constraints

- zh-TW-first bilingual for every new user-facing message (console log lines the user reads, installer output).
- No new dependencies. No behavior change to a HEALTHY single valid registration.
- WS close code 4401 = auth rejected (worker removed OR credentials invalid) and is PERMANENT — never a transient blip (a deploy/network drop closes with 1006/1011, not 4401). Treat 4401 categorically differently from other disconnects.
- Agent bumps to 0.1.5 (last task).
- Tests: agent pytest only, scoped, foreground, single process, never two pytest at once.

---

### Task 1: `identity.register` replaces (dedupes) an existing same-platform entry

**Files:**
- Modify: `agent/comfyfed_agent/identity.py`
- Test: `tests/agent/test_identity.py`

**Interfaces:**
- Produces: after `register`, `cfg.platforms` contains exactly ONE entry whose `platform_url` matches the bundle's — the freshly registered one; any prior entry(ies) for that same `platform_url` are removed. Entries for OTHER platform_urls are untouched (multi-platform is still legal).

**Change:** in `register`, before `cfg.platforms.append(entry)`, drop every existing entry with the same `platform_url`:
```python
cfg = AgentConfig.load(cfg_path)
cfg.platforms = [p for p in cfg.platforms if p.platform_url != platform_url]
cfg.platforms.append(entry)
cfg.save(cfg_path)
```
Add a one-line comment: re-registering the same machine to the same platform REPLACES its prior credential rather than stacking a second (the live incident: stacked entries pointing at since-deleted workers spammed 4401).

**Tests:** registering twice to the same platform (fake/patched HTTP like the existing register tests) leaves exactly one entry, carrying the SECOND registration's worker_id/signing key; an existing entry for a DIFFERENT platform_url survives a registration.

Commit: `fix(agent): registration replaces a prior same-platform entry, never stacks`

### Task 2: `broadcast_heartbeat` skips connections that are not currently connected

**Files:**
- Modify: `agent/comfyfed_agent/runner.py` (`broadcast_heartbeat`, ~line 577)
- Test: `tests/agent/test_runner_pause.py` or the nearest runner test file (find where broadcast_heartbeat is already exercised; add there)

**Change:** inside the `for worker_id, conn in self.connections.items():` loop, skip a connection whose socket is not up:
```python
if getattr(conn, "ws", None) is None:
    continue
```
before the `try`. Comment: a connection that failed or lost its handshake has `ws is None`; a job-lifecycle beat must not attempt a send on it (live incident: `AttributeError: 'NoneType' has no attribute 'send'` spammed once per beat per dead platform entry). Do NOT change the periodic-beat path in `_connection_loop` — that only runs for a connection that completed its handshake in the same `_run_platform` iteration.

**Tests:** a fake AgentLoop with two connections, one with `ws=None`, one with a recording fake ws: `broadcast_heartbeat("idle")` sends to the live one only, no exception raised, nothing logged for the down one. Reuse the fake-connection idioms already in the runner tests.

Commit: `fix(agent): broadcast_heartbeat skips not-connected platforms`

### Task 3: 4401 handshake → loud actionable message + stop retrying the dead entry

**Files:**
- Modify: `agent/comfyfed_agent/runner.py` (`_run_platform`, and a small helper on `PlatformConnection` to classify the close code)
- Test: `tests/agent/test_runner.py` (or the runner test file covering `_run_platform`)

**Behavior:** distinguish `websockets.exceptions.ConnectionClosed*` with code 4401 from every other exception in `_run_platform`'s loop:
- On 4401: log ONE clear bilingual error naming the worker id and platform_url, e.g. `該 worker（{worker_id}）已不被平台 {platform_url}接受（可能已被移除或憑證失效），不再重試此註冊。請重新執行安裝指令以重新註冊。 / Worker {worker_id} is no longer accepted by platform {platform_url} (removed or credentials invalid); giving up on this registration. Re-run the installer to re-register.` Then RETURN from `_run_platform` (stop the retry loop for this entry) instead of backing off and retrying forever.
- All other exceptions: unchanged (log + backoff + retry).
- After `run()`'s `asyncio.gather` completes because every `_run_platform` returned (all entries dead), the existing `run()` flow proceeds to shutdown; add: if ALL platform tasks returned due to 4401 (no entry ever stayed connected), the process should exit non-zero with a final bilingual summary line so a foreground run and the log both make the problem obvious. Track this with a per-loop flag set when any `_run_platform` gives up on 4401 and cleared if any connection ever handshakes successfully; `_cmd_run` in main.py reads it (or `run()` raises a typed `AllRegistrationsRejected` that `_cmd_run` turns into a bilingual message + `sys.exit(4)`). Choose the raise-typed-exception approach — it is testable without capturing logs.

**Classification helper:** websockets raises `ConnectionClosedError`/`ConnectionClosedOK` carrying `.rcvd`/`.sent` `Close` frames with `.code`. Add a module helper `def _is_auth_rejected(exc) -> bool` that returns True iff the exception is a `ConnectionClosed*` whose received OR sent close code == 4401 (check `getattr(exc, "rcvd", None)` and `getattr(exc, "sent", None)` `.code`, plus a defensive substring fallback on `str(exc)` for `"4401"`). Unit-test this helper directly with constructed close frames.

**Tests:**
- `_is_auth_rejected` True for a 4401 ConnectionClosedError, False for a 1006 one and for a plain OSError.
- A `_run_platform` whose `handshake` raises a 4401 `ConnectionClosedError` returns (does not loop) and records the give-up; one whose handshake raises a 1006 retries (assert it backs off — use a connect/handshake fake that raises 4401 once vs 1006 once and observe the loop count, capping the test with a small max via monkeypatched backoff/sleep).
- `run()` with a single 4401-dead entry raises `AllRegistrationsRejected` (or sets the flag) and `_cmd_run` exits non-zero with a bilingual message.

Commit: `fix(agent): stop retrying a 4401-rejected registration, fail loud and actionable`

### Task 4: installer self-heals a dead registration on re-run

**Files:**
- Modify: `agent/comfyfed_agent/main.py` (new `check-registration` subcommand), `server/comfyfed_server/installers/install.ps1`, `server/comfyfed_server/installers/install.sh`
- Test: `tests/agent/test_cli_control.py` (or a CLI test file) for the subcommand; `tests/server/test_installers.py` static asserts for the installer wiring

**New subcommand `comfyfed-agent check-registration [--config PATH]`:** loads the config; for the pinned platform(s), attempts a real WS connect+handshake with a short timeout (reuse `PlatformConnection.connect`/`handshake` via a tiny asyncio runner). Exit codes:
- `0` — at least one entry authenticates (registration is live).
- `2` — a definitive 4401 rejection and NO entry authenticated (dead registration).
- `3` — could not determine (network error/timeout, no 4401 seen) — installer must NOT re-register on this (avoid burning the token on a transient outage).
- `1` — no platforms configured at all.
Print a one-line bilingual status. Keep it dependency-free and fast (short timeout, e.g. 5s per entry).

**Installer wiring (both scripts):** replace the current "platform URL already in agent.json → skip registration" with: platform present in agent.json AND a token was supplied → run `comfyfed-agent check-registration`; if it exits `2` (dead), fall through to REGISTER (Task 1 makes register replace the dead entry); if it exits `0`/`3`/`1`, keep the current skip-and-continue. When no token was supplied, keep today's behavior. Bilingual line explaining a detected-dead registration is being re-registered. PS 5.1 rules: `$LASTEXITCODE` after the native call, no `&&`/ternary. `install.sh` stays pure LF; `install.ps1` keeps its BOM.

**Tests:**
- `check-registration` against a config with no platforms → exit 1; against a fake platform that completes the handshake → exit 0; that closes with 4401 → exit 2; that refuses TCP → exit 3. Use a stdlib WS-ish fake or monkeypatch `PlatformConnection.connect/handshake` to raise/return per case (prefer monkeypatch — a real WS server in a unit test is heavy).
- Installer static asserts: both scripts contain the `check-registration` gate and the dead→re-register branch; `install.sh` still LF-only; PS parses via the existing tokenizer test.

Commit: `feat(agent,installer): check-registration self-heals a dead registration on re-run`

### Task 5: version bump 0.1.5

**Files:** `pyproject.toml`, `agent/comfyfed_agent/__init__.py`
Bump both to `0.1.5`.
Commit: `chore: bump agent to 0.1.5`

---

### Final steps (controller)
1. Full agent+server pytest foreground (one at a time); cloud/web unaffected but run cloud vitest once (installer templates are served by cloud) + tsc.
2. Whole-branch review; fix wave if needed.
3. Commit on main (no separate branch — user directive: everything in this session/branch), push.
4. Build wheel 0.1.5, publish to cloud, redeploy cloud (installer templates changed), verify `/api/agent/version` = 0.1.5 and served installers carry the check-registration gate.
