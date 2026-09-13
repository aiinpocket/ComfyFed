# Phase 2.0 Cloud — final whole-branch review

Branch `feature/phase2_0-cloud`, 25 commits `c44dc6f..b50592e`. Cross-task /
deploy-readiness gate (per-task reviews already passed; their rulings are not
re-litigated here).

**Verdict: APPROVED** — 0 Critical, 1 Major, 5 minor, 3 nits. Nothing on the
list blocks a real Cloudflare deploy; the Major is an error-handling hole on
one route→DO call that should be closed before or immediately after merge.

## Verification run (once, as instructed)

| Command | Result |
|---|---|
| `cd cloud && npm test` | **445 passed** / 29 files, exit 0 |
| `cd cloud && npx tsc --noEmit` | clean, exit 0 |
| `cd web && npx vitest run` | **28 passed** / 5 files, exit 0 |

No pytest run (Python untouched since T8, which was verified there).

---

## 1. Security sweep — full request surface

Mount order in `cloud/src/index.ts`:

1. `:50` schema probe middleware (`*`) → 503 migration page
2. `:57` `GET /api/ping` (public, no state)
3. `:66` `comfySessionGate` (`*`) — redirects unauthenticated `/comfy*` to `/` 302, except `isGateExempt`
4. `:76` `GET /comfy` → 307 `/comfy/`
5. `:82/:95/:99` WS forwards to the singleton Hub DO
6. `:104-111` route mounts (auth, settings, workers, jobs, comfyapi, templates, reports, metrics)
7. `:119` `GET /comfy/*` → `serveComfyAsset`

Order is correct: the gate is registered before every `/comfy*` route mount and
before the asset passthrough, and the bare `/comfy` redirect sits after the
gate, so no `/comfy*` path can reach `ASSETS` unauthenticated.

### Coverage table (built from index.ts + routes/*)

| Route | Method | Gate | Notes |
|---|---|---|---|
| `/api/ping` | GET | none | intentional liveness probe, no data |
| `/api/setup/status` | GET | none | boolean only |
| `/api/setup` | POST | `SETUP_TOKEN` + already-done check | `auth.ts:83-110`, constant-time compare `:48` |
| `/api/auth/login` | POST | none (backoff) | must be open; 10-min backoff `auth.ts:118-128` |
| `/api/auth/logout` | POST | none | matches Python `auth.py:190` exactly |
| `/api/auth/me` | GET | none | returns `authenticated:false` when anon |
| `/api/auth/change-password` | POST | `requireCsrf` | rotates session secret `:180` |
| `/api/settings` | GET / POST | `requireAdmin` / `requireCsrf` | ✓ |
| `/api/workers` | GET | `requireAdmin` | ✓ |
| `/api/workers/tokens` | POST | `requireCsrf` | ✓ |
| `/api/workers/:id/disable` | POST | `requireCsrf` | ✓ |
| `/api/jobs` | GET / POST | `requireAdmin` / `requireCsrf` | ✓ |
| `/api/jobs/:id`, `/assessment`, `/artifacts/:f` | GET | `requireAdmin` | ✓ |
| `/api/jobs/:id/cancel`, `/retry` | POST | `requireCsrf` | ✓ |
| `/api/agent/register` | POST | one-time register token, atomically claimed | parity `workers.py:302-331` |
| `/api/agent/ping`, `/object_info`, `/jobs/*/inputs/*`, `/artifacts`, `/presign`, `/confirm` | — | Ed25519 `verifyAgentRequest` | ts skew 120s, D1 nonce replay store |
| `/api/agent/jobs/:id/artifacts/raw/:token` | PUT | one-time upload token IS the auth | `claimUploadToken` single-winner |
| `/api/agent/version` | GET | none | static version metadata, parity |
| `/api/agent/ws` | GET | DO handshake: challenge + Ed25519, 10s timeout | `hub.ts:300-347, 565-643` |
| `/comfy/ws`, `/comfy/api/ws` | GET | DO cookie check → plain 401 before any 101 | `hub.ts:361-374` |
| `/comfy/api/*` | all | `requireAdmin` only, **no CSRF** | documented deliberate parity (`comfyapi.ts:9-16`, `comfyapi.py:23-24`); mitigated by `SameSite=Lax` (`auth.ts:64-72`) |
| `/comfy/templates/*` | GET | session gate (302) **then** `requireAdmin` | see m1 |
| `/comfy/*` (assets) | GET | session gate | ✓ |
| `/metrics` | GET | public unless `metrics_public='false'` | parity `metrics.py:155` |

No route is reachable without its intended auth. Path-component sanitization
(`lib/store.ts:51-63`) is applied at every point a client-supplied name becomes
an R2 key segment (`artifactKey`/`jobInputKey`/`stagingKey`), and the
`object_info` upload key is derived from the **signature-verified** worker id,
never a request field (`workers.ts:242-245`).

Hub `/internal/cancel|event|dynamic|wake` are **not** externally reachable:
`index.ts` forwards only the three fixed WS pathnames to the stub, and the DO's
`fetch` dispatches on `url.pathname` (`hub.ts:276-298`).

## 2. The DO boundary

Every route→Hub interaction:

| Caller | Endpoint | Failure handling |
|---|---|---|
| `jobs.ts:103 wakeHub` (POST /api/jobs, /retry) | `/internal/wake` | try/catch, warn, continue ✓ |
| `comfyapi.ts:77 wakeHub` (POST /prompt) | `/internal/wake` | try/catch ✓ |
| `queries.ts:398 getDynamic` (GET /api/workers) | `/internal/dynamic` | try/catch + `!res.ok` → null ✓ |
| `comfyapi.ts:573-579` (POST /comfy/api/queue) | `/internal/cancel` | try/catch per job ✓ |
| `comfyapi.ts:540-547` (POST /comfy/api/interrupt) | `/internal/cancel` | **unguarded** → M1 |
| `jobs.ts:646-669` (POST /api/jobs/{id}/cancel) | `/internal/cancel` | **unguarded `res.json()`** → M1 |

**D1-vs-DO consistency (cancel).** `handleInternalCancel` (`hub.ts:403-458`)
snapshots the job, writes D1 first (`dispatch.cancelJob`, `hub.ts:425`), then
mints the receipt (try/catch), then best-effort pushes `job_cancelled`, then
notifies the panel, then re-arms the alarm. If the agent push fails, D1 stays
authoritative and the system self-heals on three independent paths:

- next heartbeat carrying that `job_id` → `job.workerId !== workerId` →
  `jobNotOwned` → `sendJobCancelled` (`hub.ts:734-753`);
- a late `job_done`/`job_failed` → `resolveOwnedJob` refuses, and
  `dispatch.tryReadopt` → `queries.readoptJob` requires `status='queued'`, so a
  **cancelled job can never be resurrected** (`dispatch.ts:181-183`);
- `requeueStale` (`dispatch.ts:142-154`) only touches assigned/running rows of
  workers stale >90s; `cancelJob` clears `worker_id` and sets a terminal
  status, so the sweep cannot pick it back up.

No orphan state, no double-billing (a cancelled receipt is minted only when the
pre-cancel snapshot was genuinely `running` with `started_at` set,
`hub.ts:420, 428-439`). Alarm re-arm is stall-free and correctly filtered to
agent-kind sockets (`hub.ts:1212-1232`), with `/internal/wake` +
`scheduleAlarmIfNeeded` covering a fully idle DO.

## 3. Wire-protocol coherence (one job's lifecycle)

`POST /api/jobs` → `insertJob{workflowJson, inputAssets, requiredNodes,
requiredModels, estVramGb, origin}` + R2 `job_inputs/<job>/<name>` → `wakeHub`
→ alarm `tick` → `dispatch.assignJobs` → `claimJob` → DO pushes
`{type:"job", job_id, workflow_json, input_assets}` — **byte-identical** to
`agentws.py:1074-1081` (no `requirements` field, matching the Python send, per
the T6 ledger note) → agent heartbeat `{state:"busy", job_id, progress}` →
`updateJobRunning` + panel `executing`/`progress` frames → agent uploads via
one of the three artifact paths, all of which converge on
`mergeJobResultHash(jobId, filename, sha)` and R2 key
`artifacts/<job>/<filename>` (`lib/store.ts:79-81`) → `job_done{result_files,
exec_seconds}` → `updateJobDone` → `jobOutputs` reads `job.resultFiles` +
`artifacts/<job>/<name>` and emits `{filename, subfolder: job.id, type:"output"}`
(`outputs.ts:176, 184`) → panel `executed` per node → the frontend rounds back
through `GET /comfy/api/view?filename=&subfolder=<job id>` which resolves the
same key (`comfyapi.ts:693-720`) and via `GET /api/jobs/{id}/artifacts/{f}`
(`jobs.ts:619-642`).

No field-name drift found across routes / D1 / DO / WS / R2. The single shared
`core/outputs.ts` is imported by both the DO's `panelJobDone` and comfyapi's
`/history`, so the two surfaces cannot diverge — the stated design intent holds
in the code.

## 4. Deploy-readiness

Confirmed good:

- `wrangler.jsonc:44-49` — **DO migration tag `v1` with
  `new_sqlite_classes: ["Hub"]` is present**. Required on first deploy; without
  it `wrangler deploy` rejects the `HUB` binding. ✓
- Bindings `DB`/`HUB`/`STORE`/`ASSETS` + vars `MODE` all declared and exactly
  matching `src/env.ts:5-35`; no binding referenced in code is missing from the
  config, and none is declared-but-unused.
- `assets`: `run_worker_first: ["/comfy", "/comfy/*", "/api/*"]` (bare `/comfy`
  listed alongside the glob — correct, and load-bearing for the gate),
  `not_found_handling: "single-page-application"`.
- Migrations chain is single-path `0001_initial` → `0002_nonces` →
  `0003_upload_tokens`, no branch, no destructive rewrite; `migrations_dir` set.
- `package.json:11` deploy order is right: `d1 migrations apply --remote` **then**
  `wrangler deploy` (a new table must exist before the new code serving it).
- `database_id: "TBD-set-at-deploy"` placeholder is explicitly documented in
  both README languages (`cloud/README.md:33-44` / `:186-197`) with the exact
  `wrangler d1 create comfyfed` → paste step, plus the required
  `wrangler r2 bucket create comfyfed-store`.
- Built `cloud/assets/`: 621 files, 40 MB, largest single file 5.8 MB — well
  inside the Workers assets limits (20 000 files, 25 MiB/file).
- Secrets absent-by-default (`SETUP_TOKEN`, `PLATFORM_ED25519_SEED`) fail
  closed, with the reasoning written into `wrangler.jsonc:9-26`.

Residual: see m5 (a bare `npm run deploy` on a fresh clone has no `assets/`).

## 5. Parity spot-audit (3 high-risk areas)

**(a) Receipt mint paths.** `buildReceiptPayload` = `` `${jobId}|${workerId}|${python1f(gpuSeconds)}` `` (`signing.ts:22-24`), golden-vector-verified in T2. Completed:
`min(exec, wall)` basis `exec`, else wall (`hub.ts:984-1005`); failed:
`exec` clamped by wall when `finished_at` exists, else wall from `started_at`
(`hub.ts:1030-1053`); cancelled: wall from the pre-cancel `started_at` snapshot,
`billable:false`, basis `wall` (`hub.ts:1072-1081`). All three clamp with
`Math.max(0, …)` and all three go through the one `mintReceipt`, matching
`agentws.py`'s `_create_and_push_receipt` / `_create_and_push_failure_receipt` /
`_mint_cancelled_receipt` split. Receipt frame fields
(`receipt_id/payload/platform_sig/kind/billable/basis`) match `_push_receipt_frame`.
`receipt_ack` re-derives the payload server-side and verifies against the
worker's pubkey before storing (`hub.ts:1118-1142`) — no client-supplied payload
is trusted. **Parity clean.**

**(b) `/prompt` missing-model 400 body.** `comfyError` (`comfyapi.ts:95-108`)
emits `{error:{type,message,details:details||message,extra_info:{}},node_errors}`
at 400 — byte-identical shape to `_comfy_error`. The missing-models branch
(`comfyapi.ts:433-455`) matches `comfyapi.py:744-790` step for step: sorted
names (`fleetWideGaps` sorts both sets, `:180, :185`), `guidance_message`,
`"\n\n" + missing_nodes_note(sorted)`, per-node `node_errors` entries keyed by
node id with `class_type`/`dependent_outputs`/`errors[]` and each error carrying
`type:"comfyfed.missing_model"`, `guidance_summary([name])`,
`model_guidance_block(name)`, `extra_info:{}`; top-level message is
`guidance_summary(names)`, details the full guidance. The missing-assets branch
reproduces `"Prompt references input files that are not available: " + ", ".join`
and the same follow-up sentence verbatim. **Parity clean.**

**(c) Staged-asset injection.** `UPLOAD_FIELD_EXTENSIONS` (`comfyapi.ts:264-268`)
is set-for-set identical to `_UPLOAD_FIELD_EXTENSIONS`; the three
`(field, upload_flag)` pairs, the "unknown extension is offered everywhere"
rule, the `spec[1][upload_flag]` upload-node detection, `_merge_options`'s two
shapes (bare option list and `["COMBO", {options}]`), and the copy-on-write of
`node_def → input → required` all match `comfyapi.py:_with_staged_images`.
`staging/` is flat, and `stagingKey` sanitizes. **Parity clean apart from n1.**

## 6. `cloud/README.md` accuracy

Checked against the code and scripts:

- Secret names: `SETUP_TOKEN`, `PLATFORM_ED25519_SEED` (64 lowercase hex),
  `R2_S3_ACCOUNT_ID` / `R2_S3_ACCESS_KEY_ID` / `R2_S3_SECRET_ACCESS_KEY` /
  `R2_S3_BUCKET` — all four names and the "all four or none" switch match
  `env.ts:31-34` and `jobs.ts:438-439`. ✓
- Commands `npm install`, `npm run ci-build`, `npm run deploy`,
  `npm run seed-official` all exist in `package.json:6-13`. ✓
- 100 MB direct-mode cap + the `R2_S3_*` presign workaround matches
  `jobs.ts:401-467`. ✓
- `/api/setup` curl fallback body `{token, password}` and the 8-char minimum
  match `auth.ts:91-99`; `{"ok": true}` response matches `:109`. ✓
- `GET /api/agent/version` defaulting to `0.1.0`/`0.1.0` with the rest `null`
  matches `workers.ts:274-283`. ✓
- Workers Builds root `cloud/` + build `npm run ci-build` + deploy
  `npm run deploy` is consistent with `build.mjs` reaching `../web` and
  `../server/comfyfed_server/templates_data` (the whole repo is checked out;
  root only changes cwd). ✓

No inaccuracy found in the README.

---

## Findings

### Major

**M1 — route→DO cancel calls have no failure guard.**
`cloud/src/routes/jobs.ts:657` calls `await res.json<{cancelled, worker_id}>()`
on the Hub DO's response without checking `res.ok` or catching a parse error.
If `handleInternalCancel` throws (a D1 error in `cancelJob`, an evicted/
overloaded DO, an internal exception anywhere in `hub.ts:403-458`), the DO
answers with a non-JSON 500 body, `res.json()` rejects, the handler throws, and
the console receives a bare 500 with **no `{error:{code,message}}` envelope** —
which is the shape `web/src/pages/Jobs.tsx` parses to show a cancel failure.
The same call in `cloud/src/routes/comfyapi.ts:544`
(`POST /comfy/api/interrupt` → `cancelJobViaHub`) is likewise unguarded, while
its sibling at `comfyapi.ts:573-579` already wraps the identical call in
try/catch — so the codebase is internally inconsistent about this.

State stays consistent either way (see §2), so this is robustness, not
corruption. Fix:

```ts
// jobs.ts, after the stub.fetch
if (!res.ok) return errorJson(c, 502, "jobs.hub_unavailable", "Cancel could not be delivered; try again.");
let result: { cancelled: boolean; worker_id: string | null };
try { result = await res.json(); }
catch { return errorJson(c, 502, "jobs.hub_unavailable", "Cancel could not be delivered; try again."); }
```

and wrap `comfyapi.ts:544` in the same `try/catch { console.warn(...) }` its
sibling uses.

### minor

**m1 — `index.ts:62-66` comment is wrong about the gate exemptions.**
It states the gate "exempts all of those by path itself (see `isGateExempt`)"
while naming `/comfy/api/*` **and `/comfy/templates/*`**. `gate.ts:54-56`
exempts only `/comfy/api/*` and `/comfy/ws`; `/comfy/templates/*` is gated and
an anonymous hit gets a 302 to `/`, not the 401 JSON the comment implies. The
behavior is correct (it matches Python, where `templates.py:350`'s router has no
`Depends(require_admin)` and relies entirely on `_comfy_session_gate`), so this
is a comment fix only — and worth noting alongside it that
`templates.ts:363`'s `requireAdmin` is therefore defense-in-depth, never the
primary gate for an anonymous caller.

**m2 — dead code: `queries.deleteUploadToken`.**
`cloud/src/db/queries.ts:1077-1079` has no caller in `src/` or `test/`. Same
standard the T9 reviewer applied to `getJobByIdAndOrigin` (dropped in
`2075568`). Either delete it or wire it into m3's pruning.

**m3 — `upload_tokens` rows are never pruned.**
`nonces` are pruned opportunistically on every verification
(`verify_agent.ts:105` → `pruneNonces`), but every `/artifacts/presign` in
`direct` mode inserts an `upload_tokens` row (`jobs.ts:460`) that is never
deleted — used or expired. D1 rows accumulate for the life of the deployment.
Fix: mirror the nonce pattern with a
`DELETE FROM upload_tokens WHERE expires_at < ?` at the top of the presign
handler.

**m4 — the raw PUT has no size cap when the presign omitted `size`.**
`jobs.ts:436` makes `size` optional (`null` when absent), and
`jobs.ts:522-536` only installs the `FixedLengthStream` guard when
`row.size !== null`; otherwise the body streams into R2 unbounded. The caller is
an authenticated agent, so this is not a security hole, but both the README's
100 MB claim and the R2 bill then depend on the agent volunteering an accurate
`size`. Fix: reject a presign body with no numeric `size` (400
`jobs.bad_asset_name`), or fall back to a configured maximum in the
`FixedLengthStream`.

**m5 — a bare `npm run deploy` can ship stale assets or fail outright.**
`package.json:11` runs migrations + `wrangler deploy` but no build, and
`cloud/assets/` is gitignored (`.gitignore:11`). On a fresh clone
`wrangler deploy` fails on the missing assets directory; after editing `web/`
without re-running `ci-build`, it silently ships the previous console bundle.
The README does document `ci-build` first (`:74-77`, `:227-230`), and chaining
`npm run build` into `deploy` would make Workers Builds pay for the 93 MB
frontend wheel twice — so the right fix is either a `predeploy` script that
errors when `assets/index.html` is absent, or a one-line caution in the README's
First deploy block ("`npm run deploy` does not build — re-run `npm run build`
after changing `web/`").

### Nits

**n1 — `comfyapi.ts:295-297` `arraysEqual` is shallow where Python's
`merged == spec` is deep.** `mergeOptions` always returns a fresh array for
element 0, so the "nothing changed, skip" short-circuit at `:330` can never
fire; the node def is copied on every request even when no staged name was
added. The emitted JSON is identical — pure wasted work.

**n2 — `comfyapi.ts:704-708` legacy `/view` ordering.** Sorts on a single
`finishedAt ?? createdAt` key; `comfyapi.py`'s query orders
`finished_at DESC, created_at DESC` (two keys). Only observable for a `done`
job with a null `finished_at`, which `updateJobDone` never produces.

**n3 — `reports.ts:130`** renders `'${err.value}'` where Python uses
`{value!r}` (`receipts.py:35`); the two differ for a value containing a quote
character.

---

## Final fix wave

**M1 — fixed.** `jobs.ts`'s `POST /api/jobs/{id}/cancel` now guards the Hub DO
`fetch` in try/catch, checks `res.ok`, and guards `res.json()` separately —
each failure path returns `502 {error:{code:"jobs.hub_unavailable",
message: bilingual}}` (new `HUB_UNAVAILABLE` constant + the existing
`bilingualMessage`/`SETUP_MESSAGES`-style helper from `core/auth.ts`, since
this error has no Python parity source — the monolith has no DO to be
unreachable). `comfyapi.ts:544`'s `/comfy/api/interrupt` call is now wrapped
in the same try/catch its `/comfy/api/queue` sibling already used, but kept
its own success semantics: Python's `/interrupt` (`comfyapi.py`) returns `200`
unconditionally with no dispatcher-equivalent to fail, so on a DO throw this
route logs a warning and still answers `200 {}` (documented inline at the
call site) rather than surfacing a 502 the panel doesn't check for.

Added tests (all against a mocked `HUB.get` returning a stub whose `fetch`
rejects, or resolves non-OK):
- `jobs.spec.ts`: cancel → 502 `jobs.hub_unavailable` on DO-throw; 502 on
  DO non-OK response.
- `comfyapi.spec.ts`: `/interrupt` still 200 `{}` on DO-throw (panel parity);
  `/queue` delete still 200 on DO-throw for one job.

Taken alongside M1 (cheap, in files already touched):
- **m2** — deleted dead `queries.deleteUploadToken` (no caller anywhere;
  same standard T9 applied to `getJobByIdAndOrigin`).
- **n1** — `comfyapi.ts`'s `arraysEqual` replaced with a proper `deepEqual`;
  the old shallow `===`-per-element check could never short-circuit the
  "nothing changed" skip since `mergeOptions` always allocates a fresh
  element 0, so every `/object_info` request re-copied the node def for
  nothing.
- **n2** — `/comfy/api/view` legacy scan now sorts `finished_at DESC,
  created_at DESC` (two keys, null-safe), matching `comfyapi.py`'s `ORDER BY`
  exactly instead of collapsing to a single `finishedAt ?? createdAt` key.

Skipped (not cheap enough to bundle into this pass, left for a follow-up):
- **m1** (`index.ts` comment) — correct but not in a file this pass touched.
- **m3** (prune `upload_tokens`) — needs a new `queries` function, a presign-
  handler change, and its own test; real scope, not a drive-by.
- **m4** (raw PUT size cap when `size` omitted) — same: a behavior change to
  the presign contract, needs deliberate test coverage of its own.
- **n3** (`reports.ts` `!r` quoting) — correct but not in a file this pass
  touched.

Verification: `cd cloud && npm test` → **449 passed** / 29 files, exit 0;
`cd cloud && npx tsc --noEmit` → clean, exit 0.

---

## Final fix wave, round 2 (controller-adjudicated: take the rest)

**m1 — fixed.** Corrected the `index.ts` comment above `comfySessionGate`'s
mount: it now says `isGateExempt` exempts only `/comfy/api/*` and
`/comfy/ws`, that `/comfy/templates/*` is NOT exempt (goes through the same
302-to-`/` gate as the panel page/assets, matching Python's
`templates.py`/`_comfy_session_gate` split), and that `requireAdmin` on those
routes is defense-in-depth only, never the primary gate for an anonymous
caller.

**m3 — fixed.** Added `queries.pruneUploadTokens(db, nowSeconds)` (mirrors
`pruneNonces`: `DELETE FROM upload_tokens WHERE expires_at < ?`), called at
the top of the presign handler in `jobs.ts` before either the s3 or direct
branch. `deleteUploadToken` (already deleted in round 1 as dead code, m2)
stays deleted: a single-token delete on the claim path would have been
redundant now that expiry-based pruning runs on every presign call and
covers both used and unused expired rows with one predicate. Test:
`jobs.spec.ts` seeds an expired row directly, calls presign, asserts the
stale row is gone.

**m4 — fixed.** Presign now requires a numeric, non-negative `size`; a
missing/non-numeric/negative `size` is a `400 jobs.bad_asset_name` with a new
bilingual `PRESIGN_SIZE_REQUIRED` message (cloud-only, no Python parity
source, same treatment as `HUB_UNAVAILABLE`). Verified the real Python agent
(`agent/comfyfed_agent/runner.py:804`, `_try_presign`) already sends
`size: len(content)` on every presign request — **no agent-side change
needed**, this is a pure cloud-side tightening. Effect: `upload_tokens.size`
is now always non-null for a direct-mode token, so `PUT
.../artifacts/raw/:token`'s `FixedLengthStream` guard is unconditionally
installed. Tests: `jobs.spec.ts` — 400 for size omitted / stringified /
negative / explicit `null`.

**m5 — fixed.** Added `cloud/scripts/check-assets.mjs` and wired it as
`package.json`'s `predeploy` script (npm runs it automatically before
`deploy`). It checks `cloud/assets/index.html` exists and, if not, exits 1
with a bilingual message pointing at `npm run ci-build` and explaining why
`deploy` itself doesn't build (avoids Workers Builds double-paying to
package `web/`). Manually verified both branches (renamed `index.html` away
and back) — exit 1 with the message when missing, exit 0/silent when
present. No automated test: this only runs under `npm`'s lifecycle hook
outside the Workers runtime the vitest suite exercises, same category as the
other `scripts/*.mjs` files, none of which have unit tests.

**n3 — fixed, one-line-equivalent.** `reports.ts:130` rendered
`` `'${err.value}'` `` where Python's `receipts.py:35` uses `{value!r}`;
diverges for a value containing a quote character (a user-supplied `?from=`/
`?to=` query param, so reachable, not hypothetical). Added a small
`pyStrRepr()` helper approximating Python's string `repr()` (switches to
double quotes when the value contains `'` and no `"`, backslash-escapes the
chosen quote char and `\` otherwise) and used it in place of the raw
template literal. Tests: `reports.spec.ts` — exact message for the plain
case, plus a new case asserting `"o'clock"` renders as `"o'clock"` (Python's
quote-switching behavior), not `'o'clock'`.

Verification: `cd cloud && npm test` → **452 passed** / 29 files, exit 0
(3 new: m3 pruning, m4 four bad-size cases, n3 quote-switch case; `hub.spec.ts`
had one unrelated pre-existing flake on the first run, confirmed by an
isolated re-run passing 16/16 and the full suite passing clean on the next
run — no file this pass touched is anywhere near `do/hub.ts`);
`cd cloud && npx tsc --noEmit` → clean, exit 0.
