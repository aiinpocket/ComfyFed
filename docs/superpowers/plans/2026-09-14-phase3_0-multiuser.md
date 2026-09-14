# Phase 3.0 Multi-User Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-user account system — admin creates users, users see only their own jobs/artifacts, admins see everything, per-user billing aggregation + 分潤試算, full server/cloud/web parity.

**Architecture:** New `users` table (role admin|user, disabled, per-user `session_epoch`) replaces the single settings-row admin credential on both stacks; `jobs.user_id` stamps ownership; session cookie payload becomes `{uid, role, epoch, csrf}`; endpoints split into `require_user` (owner-scoped) vs `require_admin`; panel becomes a per-user workspace; reports gain per-user usage + payout estimation.

**Tech Stack:** FastAPI + SQLAlchemy 2 + Alembic (server), Hono + D1 (cloud), React 18 + Mantine + react-i18next (web).

**Spec:** `docs/superpowers/specs/2026-09-12-comfyfed-spec.md` — §"Phase 3.0 addendum: 多使用者帳號系統" is the binding authority for every contract below. Read it before implementing.

## Global Constraints

- zh-TW first, bilingual (every user-facing string in both `zh-TW` and `en` locale files; zh-TW is the source of truth).
- No compromises, no TODO/stub/deferred behavior — including in docs.
- Server and cloud must stay behavior-parity: same endpoint shapes, same error messages (cloud reuses its `MESSAGES` table pattern), same scoping rules. Cloud port mirrors Python semantics exactly (existing convention incl. `pyStrRepr` where Python `repr()` leaks into messages).
- Session payload: exactly `{uid, role, epoch, csrf}`; any payload missing `uid` is unauthenticated. `epoch` must equal the user's current `session_epoch`. Global session secret is NO LONGER rotated on password change.
- Username normalization: lowercase, 3–32 chars, regex `^[a-z0-9_.-]{3,32}$` (validate AFTER lowercasing input).
- Last-active-admin guard: an admin who is the only non-disabled admin cannot be disabled nor demoted (HTTP 400).
- Login must not leak account existence: unknown username → verify against a module-level dummy hash, same error message as wrong password; disabled user → same error message.
- Panel (`/comfy*`) scoping rule for EVERYONE incl. admin: `origin=='panel' AND user_id==session uid`.
- Never run two pytest suites concurrently (fixed-port WS tests deadlock). Run tests foreground.
- Alembic: single new revision `d0e1f2a3b4c5` (down_revision `c9d0e1f2a3b4`) carries ALL schema changes of this phase. Cloud: single migration `0006_users.sql`.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Server — users table, migration, auth core rewrite

**Files:**
- Create: `server/alembic/versions/d0e1f2a3b4c5_users_multiuser.py`
- Modify: `server/comfyfed_server/db.py`, `server/comfyfed_server/auth.py`, `server/comfyfed_server/bootstrap.py`, `server/comfyfed_server/security.py` (only if a helper is needed), `server/comfyfed_server/metrics.py` + `server/comfyfed_server/comfyapi.py` + any other hand-checker of `read_session_payload` (grep for it) — update to new payload validation.
- Test: `tests/server/test_auth.py` (extend), `tests/server/conftest.py` if the shared fixture needs the username.

**Interfaces (Produces — later tasks rely on these exact names):**
- `db.User`: table `users`, columns `id: str (uuid4 hex, PK)`, `username: str (unique)`, `password_hash: str`, `role: str`, `disabled: bool default False`, `session_epoch: int default 0`, `created_at: datetime`.
- `db.Job.user_id: Mapped[str | None]` (nullable TEXT, no FK constraint — matches existing loose-reference style).
- `db.LoginAttempt.username: Mapped[str | None]`.
- `auth.SessionUser` dataclass: `uid: str`, `username: str`, `role: str`. 
- `auth.require_user` FastAPI dependency → returns `SessionUser`; 401 if cookie absent/invalid/missing uid; 401 if user row missing, disabled, or `epoch != user.session_epoch`.
- `auth.require_admin` → `require_user` + `role == "admin"` else 403 (keep existing 403/401 conventions; check current code — today `require_admin` raises 401 on no session; keep 401 unauth / 403 wrong-role).
- `auth.read_session_payload(request) -> dict | None` stays public; hand-checkers must additionally verify uid/epoch — extract shared helper `auth.resolve_session_user(session, request) -> SessionUser | None` that does payload→DB validation, and use it in metrics/comfy gate/panel WS.
- `auth.issue_session_cookie(response, user)` sets cookie with `{uid, role, epoch, csrf}`.

**Migration content:**
```python
# d0e1f2a3b4c5_users_multiuser.py — upgrade():
# 1. op.create_table("users", ...) per db.User above (sqlite batch not needed for create)
# 2. op.add_column("jobs", sa.Column("user_id", sa.Text(), nullable=True))
# 3. op.add_column("login_attempts", sa.Column("username", sa.Text(), nullable=True))
# 4. Data migration (raw SQL via op.get_bind()):
#    hash = SELECT value FROM settings WHERE key='admin_password_hash'
#    if hash: INSERT INTO users(id, username, password_hash, role, disabled, session_epoch, created_at)
#             VALUES (uuid4().hex, 'admin', hash, 'admin', 0, 0, now-iso)
#             UPDATE jobs SET user_id = <that id>
#             DELETE FROM settings WHERE key='admin_password_hash'
```
Also delete `settings.session_secret`? NO — keep, it still signs cookies.

**Auth behavior changes:**
- `POST /api/auth/login` body `{username, password}` (pydantic; username required). Lowercase username. Backoff: `_consecutive_failures` counts attempts WHERE `username == <given>` (window/formula unchanged). Unknown/disabled user → run `verify_password(_DUMMY_HASH, password)` then fail with the SAME message currently used for wrong password. Record attempt row with username.
- `_DUMMY_HASH`: module-level constant computed once via `hash_password("comfyfed-dummy-password-for-timing")`.
- `GET /api/auth/me` → `{authenticated: True, username, role, lang, platform_url}`.
- `POST /api/auth/change-password`: verify old password for the SESSION user, set new hash, `session_epoch += 1`, re-issue cookie with new epoch (self stays logged in). REMOVE the session-secret rotation.
- `bootstrap.ensure_installed`: instead of writing `admin_password_hash` setting, create the admin `users` row (username `admin`). Return value keeps `.admin_password`. Fresh-install DB is created by `alembic upgrade head`, so the users table exists before bootstrap writes.
- Delete the now-unused `_ADMIN_PASSWORD_HASH_KEY` path.

**Steps:**
- [ ] Write failing tests: login requires username; wrong username == wrong password message; disabled user rejected same message; me returns username+role; change-password keeps self logged in but kills a second session (epoch); old-format cookie (`{"authenticated": True, "csrf": "x"}` signed with same secret) is rejected; per-username backoff (failures on user A don't lock user B); migration test: seed pre-migration DB state? (Use alembic programmatic upgrade on a temp DB with a settings row inserted at revision `c9d0e1f2a3b4`, then upgrade to head, assert users row exists with the hash, jobs.user_id backfilled, setting deleted.)
- [ ] Run to verify failures.
- [ ] Implement migration + db models + auth rewrite + bootstrap + hand-checker updates (grep `read_session_payload` across server/, update every caller to `resolve_session_user`).
- [ ] Fix ALL other existing server tests that authenticate (conftest/fixtures now need username `admin`): run the full server suite foreground and repair fixtures — this task is not done until `pytest tests/server tests/agent` is green.
- [ ] Commit.

### Task 2: Server — user management API

**Files:**
- Create: `server/comfyfed_server/users.py`, `tests/server/test_users.py`
- Modify: `server/comfyfed_server/app.py` (mount router)

**Interfaces:**
- Consumes: `auth.require_admin`, `auth.require_csrf`, `db.User`, `security.hash_password`.
- Produces: router prefix `/api/users`:
  - `GET /api/users` (admin) → `{"users": [{id, username, role, disabled, created_at, jobs}]}` (`jobs` = COUNT of jobs with that user_id), ordered by created_at.
  - `POST /api/users` (admin+CSRF) body `{username, role, password?}`; role in {admin,user}; validate username regex after lowercase; 400 `username_taken` on duplicate (case-insensitive); password absent → `secrets.token_urlsafe(12)`; response `{id, username, role, password}` (password only when generated or supplied — always echo the effective password ONCE).
  - `POST /api/users/{id}/reset-password` (admin+CSRF) → new generated password, `session_epoch += 1`, response `{password}`.
  - `PATCH /api/users/{id}` (admin+CSRF) body `{role?, disabled?}`; last-active-admin guard (400, message key `last_admin`); disabling bumps epoch; admin can modify self EXCEPT self-disable/self-demote when last admin (same guard covers it).
- Error messages bilingual-ready: return stable machine keys in `detail` (e.g. `{"detail": "username_taken"}`) — web maps to i18n.

**Steps:**
- [ ] Failing tests: create/list/duplicate/regex-reject/generated-password-login-works/reset-password-invalidates-session/disable-blocks-login-and-kills-session/last-admin-guard (disable & demote)/non-admin-gets-403/user-role-cannot-access.
- [ ] Implement, run `pytest tests/server/test_users.py tests/server/test_auth.py` then full server suite.
- [ ] Commit.

### Task 3: Server — job ownership & console scoping

**Files:**
- Modify: `server/comfyfed_server/jobs.py`, `server/comfyfed_server/comfyapi.py` (only the `POST /comfy/api/prompt` submission path — stamp user), tests `tests/server/test_jobs.py` + new `tests/server/test_job_scoping.py`

**Interfaces:**
- Consumes: `auth.require_user` / `require_admin`, `db.Job.user_id`, Task 1's `SessionUser`.
- Produces:
  - `POST /api/jobs` (any user): stamps `user_id = session.uid`. Panel `/comfy/api/prompt` path stamps likewise.
  - `GET /api/jobs`: gate becomes `require_user`; admin → all jobs, each item gains `"username"` (join users; None for legacy NULL user_id); non-admin → only own jobs (no username field needed but include own username for shape consistency).
  - `GET /api/jobs/{id}`, `/assessment`, `GET .../artifacts/{filename}`, `POST .../cancel`: gate `require_user` + owner-or-admin check → 404 for non-owner non-admin (404 not 403 — do not leak job existence).
  - Agent-facing endpoints unchanged.

**Steps:**
- [ ] Failing tests: user A cannot list/see/download/cancel user B's job (404); admin can; list filtering; username in admin list; job created via console + via panel carries user_id.
- [ ] Implement; full server suite foreground; commit.

### Task 4: Server — panel as per-user workspace

**Files:**
- Modify: `server/comfyfed_server/comfyapi.py`, tests `tests/server/test_comfy_api.py` / `tests/server/test_comfy_panel_ws.py` (extend)

**Interfaces:**
- Consumes: `auth.resolve_session_user` (panel surface hand-checks cookies today).
- Produces: every panel-native read/control — `GET /comfy/api/queue`, `GET /comfy/api/history`, `POST /comfy/api/interrupt`, `POST /comfy/api/queue` (delete/clear), `POST /comfy/api/history` (hide), `GET /comfy/api/view`, job_outputs mapping — scoped to `origin=='panel' AND user_id==uid` for EVERY role (spec ruling: admin's panel is personal too; console keeps role scope). Panel WS: progress/executing frames forwarded only for the socket user's own jobs; the WS auth handshake must resolve the user and keep uid on the connection.
- Static gate `/comfy` and `/comfy/api/*`: any authenticated user (was admin-only).

**Steps:**
- [ ] Failing tests: two users' panel jobs isolated in queue/history/view; interrupt/clear only touches own; WS relays only own job frames; admin panel view excludes other users' panel jobs; non-admin can open panel surface.
- [ ] Implement; run the panel WS test file ALONE foreground (fixed-port), then full suite; commit.

### Task 5: Server — reports: usage, my-usage, payout

**Files:**
- Modify: `server/comfyfed_server/receipts.py`; Test: `tests/server/test_reports.py` (or wherever contributions tests live — extend same file)

**Interfaces:**
- Produces (all support `from`/`to` like contributions, reuse `_parse_date`):
  - `GET /api/reports/usage` (admin): join receipts→jobs.user_id→users; per-user rows `{user_id, username, jobs, gpu_seconds, unbilled_gpu_seconds}`; billable-only in jobs/gpu_seconds, rest in unbilled (same rule as contributions); legacy NULL user_id rows aggregate into one row `{user_id: null, username: null, ...}`; sorted gpu_seconds DESC.
  - `GET /api/reports/my-usage` (any user): same row shape, only session user, single object `{user_id, username, jobs, gpu_seconds, unbilled_gpu_seconds}`.
  - `GET /api/reports/payout?pool=<float>` (admin): per-worker billable gpu_seconds over range; response `{"total_gpu_seconds": float, "pool": float, "workers": [{worker_id, name, gpu_seconds, ratio, amount}]}` where `ratio = gpu_seconds/total`, `amount = pool*ratio` (raw floats); total==0 → `{"total_gpu_seconds": 0, "pool": pool, "workers": []}`; pool must parse as non-negative float else 400.
- Contributions endpoint untouched.

**Steps:**
- [ ] Failing tests: usage aggregation across two users + legacy-null row; my-usage isolation; payout math incl. zero-total and bad pool; role gates (user can my-usage but not usage/payout).
- [ ] Implement; suite; commit.

### Task 6: Web — auth, roles, navigation

**Files:**
- Modify: `web/src/App.tsx`, `web/src/api.ts`, `web/src/pages/Login.tsx`, `web/src/pages/Settings.tsx`, locale files `web/src/locales/*` (check actual path), tests `web/src/**/*.test.tsx` as applicable.

**Interfaces:**
- `api.login(username, password)`; `api.me()` now returns `{authenticated, username, role, lang, platform_url}`; store `{username, role}` in App state, pass down via context or props (follow existing pattern).
- Login page: username + password fields (username autofocus, autocomplete `username`/`current-password`).
- Route/nav gating: role `user` sees Dashboard, Jobs, Reports, Settings(change-password+language only); `admin` additionally Workers, Users, full Settings. Guard at ROUTE level (redirect non-admin hitting admin route to /dashboard), not just menu hiding.
- zh-TW + en strings for all new UI.

**Steps:**
- [ ] Update api + pages + guards; extend existing web vitest suite (route-guard test: role user cannot render Workers route).
- [ ] `npm test` + `npm run build` in web/ green; commit.

### Task 7: Web — Users management page

**Files:**
- Create: `web/src/pages/Users.tsx` (+ route in App.tsx, nav entry admin-only)
- Modify: `web/src/api.ts`, locales.

**Interfaces:** Consumes Task 2 endpoints. UI: Mantine Table (username, role badge, 狀態 enabled/disabled, created, jobs count, actions); 建立使用者 modal (username, role select, optional password) → success modal showing one-time password with Copy button + warning 「密碼僅顯示這一次」; per-row actions: 重設密碼 (confirm → one-time password modal), 停用/啟用 (confirm), 角色切換; API error keys (`username_taken`, `last_admin`, invalid username) mapped to zh-TW/en messages. Match existing page styling (look at Workers.tsx for idiom).

**Steps:**
- [ ] Implement + at least one vitest (renders rows from mocked api; create flow shows one-time password).
- [ ] `npm test` + build; commit.

### Task 8: Web — jobs username column, reports tabs

**Files:**
- Modify: `web/src/pages/Jobs.tsx`, `web/src/pages/JobDetail.tsx` (show 使用者 for admin), `web/src/pages/Reports.tsx`, `web/src/api.ts`, locales.

**Interfaces:** Jobs list shows 使用者 column only for admin (from item.username). Reports page: admin → Mantine Tabs 「Worker 貢獻」「使用者用量」「分潤試算」; 分潤試算 tab: pool NumberInput + date range → table (worker, gpu_seconds, ratio %, amount, 2-decimal formatting); user role → only 我的用量 (no tabs). Reuse existing date-picker + formatGpuSeconds.

**Steps:**
- [ ] Implement + vitest for role-conditional rendering; `npm test` + build; commit.

### Task 9: Cloud — migration 0006, auth core, users API

**Files:**
- Create: `cloud/migrations/0006_users.sql`, `cloud/src/routes/users.ts`, `cloud/test/users.spec.ts`
- Modify: `cloud/src/routes/auth.ts`, `cloud/src/core/auth.ts`, `cloud/src/lib/guard.ts`, `cloud/src/lib/cookies.ts`, `cloud/src/index.ts` (mount), `cloud/test/auth.spec.ts` + every spec that logs in.

**Interfaces:** Byte-parity port of Tasks 1+2: users table DDL (TEXT id PK, username UNIQUE, password_hash, role, disabled INTEGER, session_epoch INTEGER, created_at); 0006 data-migration SQL (INSERT users from settings admin_password_hash — D1 SQL can't uuid4: use `lower(hex(randomblob(16)))`; UPDATE jobs SET user_id=...; DELETE setting) — write as pure SQL with a guard (`INSERT ... SELECT ... WHERE EXISTS`); `ALTER TABLE jobs ADD COLUMN user_id TEXT`; `ALTER TABLE login_attempts ADD COLUMN username TEXT`. `/api/setup` creates admin user row. Session cookie payload `{uid, role, epoch, csrf}`; `requireUser`/`requireAdmin` guards with epoch check; per-username backoff; dummy-hash timing guard (PBKDF2 dummy); change-password epoch bump without secret rotation; users routes identical shapes/keys to Task 2.

**Steps:**
- [ ] Port with failing-tests-first where practical; update ALL cloud specs that authenticate (helpers/http.ts `setup`/login helper gains username).
- [ ] `npx vitest run` (whole cloud suite) green; commit.

### Task 10: Cloud — job ownership & panel scoping

**Files:**
- Modify: `cloud/src/routes/jobs.ts`, `cloud/src/routes/comfy*.ts` (locate panel routes), Hub DO panel WS handling in `cloud/src/do/hub.ts` (uid on panel socket), specs.

**Interfaces:** Parity port of Tasks 3+4: stamp user_id on create (console + panel prompt), owner-or-admin with 404, admin list + username join, panel per-user scoping incl. WS frame filtering, panel static gate any-user.

**Steps:**
- [ ] Port + specs; whole cloud suite green; commit.

### Task 11: Cloud — reports parity

**Files:**
- Modify: `cloud/src/routes/reports.ts`, spec file.

**Interfaces:** Parity port of Task 5 (usage/my-usage/payout), identical JSON shapes incl. null-user row and zero-total behavior.

**Steps:**
- [ ] Port + specs; whole cloud suite green; commit.

### Task 12: Docs

**Files:**
- Modify: `docs/SELF-HOSTING.zh.md`, `docs/SELF-HOSTING.en.md` (new 多使用者 section: creating users, roles, per-user visibility, usage & payout reports, upgrade note「升級後全員需重新登入；原 admin 密碼不變、帳號名為 admin」), `README.md` + `README.en.md` (one general-audience line: 支援多使用者帳號，成員各自送單、管理員總覽與帳務), spec §9 Phase 3 line marked 多管理員/分潤試算 shipped in 3.0.

**Steps:**
- [ ] Write both languages, general-audience tone for README, technical for SELF-HOSTING; commit.
