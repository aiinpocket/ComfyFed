# Files page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `jobs.label` + `GET /api/me/artifacts` + artifact delete routes on both stacks, and a console「檔案 / Files」page with uploads + a `label/date/` output browser with thumbnails, download and delete.

**Architecture:** server (`server/comfyfed_server`, FastAPI) is the parity source; cloud (`cloud/src`, Hono/D1/R2) mirrors it function-for-function; web (`web/src`, React/Mantine/i18next) consumes both identically.

**Tech Stack:** Python 3.13 + SQLAlchemy + alembic + pytest (`.venv/Scripts/python -X utf8 -m pytest tests/server/...`); TypeScript + vitest (`cd cloud && npx vitest run test/x.spec.ts`, `npx tsc --noEmit -p .`); React + vitest (`cd web && npx vitest run src/pages/X.test.tsx`, `npm run build` uses `tsc -b`).

**Spec:** `docs/superpowers/specs/2026-09-20-files-page-design.md`

## Global Constraints

- Work directly on `main`; one commit per task; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never run two pytest processes at once.
- Server/cloud byte-parity for pure functions (`derive_label` / `deriveLabel`), identical route shapes, identical error codes.
- User-facing strings zh-TW first, English second; every new i18n key exists in BOTH `web/src/i18n/zh-TW.json` and `en.json`.
- Files written by scripts use LF and UTF-8.
- `label` is stored trimmed, max 64 chars, empty → NULL.

---

### Task 1: server — `jobs.label`, `derive_label`, `GET /api/me/artifacts`, artifact delete

**Files:**
- Create: `server/alembic/versions/a7b8c9d0e1f2_job_label.py` (revision `a7b8c9d0e1f2`, down_revision `e6f7a8b9c0d1`; `op.add_column("jobs", sa.Column("label", sa.String(), nullable=True))`).
- Modify: `server/comfyfed_server/db.py` (`Job.label: Mapped[Optional[str]] = mapped_column(String, nullable=True)`).
- Modify: `server/comfyfed_server/jobs.py`, `server/comfyfed_server/recipes.py`, `server/comfyfed_server/comfyapi.py`, `server/comfyfed_server/split.py`, `server/comfyfed_server/storage.py`.
- Test: `tests/server/test_jobs.py` (new section at end), `tests/server/test_recipes.py`, `tests/server/test_comfyapi.py` (or wherever `/comfy/api/prompt` is tested — grep `"/comfy/api/prompt"`).

**Interfaces (Produces):**
```python
# jobs.py
LABEL_MAX_CHARS = 64
def normalize_label(value) -> str | None            # str → strip, [:64], "" → None; non-str → None
def derive_label(workflow: dict) -> str | None       # spec §2.2
def create_job(..., label: Optional[str] = None)     # stores normalize_label(label) or derive_label(workflow)
async def create_job_from_workflow(..., label: Optional[str] = None)   # passes through
# POST /api/jobs: new optional Form field `label: Optional[str] = Form(default=None)`
# _job_dict adds "label": job.label
# GET /api/me/artifacts  -> {"files": [...]}   (spec §3.1)
# DELETE /api/jobs/{job_id}/artifacts/{filename} and DELETE /api/jobs/{job_id}/artifacts (spec §3.2)
ARTIFACT_KINDS = {"png":"image","jpg":"image","jpeg":"image","webp":"image","gif":"image","mp4":"video","webm":"video","mov":"video"}
def artifact_kind(filename) -> str
# storage.py
ArtifactStore.delete(job_id, filename) -> None   # abstract; LocalStore removes file, ignores missing, prunes empty job dir
ArtifactStore.size(job_id, filename) -> int | None  # LocalStore os.stat, None if missing
# recipes.py: RunRequest gains `label: Optional[str] = None`; run passes label=body.label or recipe_id
# comfyapi.py: post_prompt passes nothing (derive_label applies inside create_job)
# split.py: child rows copy `label=parent.label`
```

`derive_label`:
```python
def derive_label(workflow: dict) -> str | None:
    if not isinstance(workflow, dict):
        return None
    for node_id in sorted(workflow, key=str):
        node = workflow[node_id]
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        if not isinstance(class_type, str) or not class_type.startswith("Save"):
            continue
        prefix = (node.get("inputs") or {}).get("filename_prefix") if isinstance(node.get("inputs"), dict) else None
        if not isinstance(prefix, str):
            continue
        last = prefix.replace("\\", "/").rstrip("/").split("/")[-1].strip()
        if last:
            return last[:LABEL_MAX_CHARS]
    return None
```

`GET /api/me/artifacts` (require_user): query `db.Job` where `user_id == user.uid`, `status == "done"`, `kind == "prompt"` (or kind is None), `result_files != "[]"`, order `created_at desc`; for each filename in `json.loads(result_files)` sorted, `size = store.size(job.id, name)`; skip None; emit `{"job_id","label","created_at" (isoformat),"filename","size","kind": artifact_kind(name)}`.

Delete routes (require_csrf_user): 404 `jobs.not_found` via `_require_owner_or_admin`; 409 `jobs.not_finished` unless `job.status in ("done","failed","cancelled")`; single: 404 `jobs.artifact_not_found` if filename not in result_files; `store.delete`; write back `result_files`; return `{"ok": True, "result_files": remaining}`.

Tests to write (each a real assertion, ≥1 per bullet): normalize/derive (SaveImage with `sub/dir/name `, no Save node → None, non-string prefix skipped, ordering by node id, 64-char cut); `POST /api/jobs` with `label` form → `GET /api/jobs/{id}` shows it, without → derived from SaveImage, neither → null; recipe run label = recipe id and override via body; panel prompt derives; split children copy label (use existing split test helpers); `/api/me/artifacts` lists only own done jobs, sizes, kinds, order, skips missing file, admin sees only own; delete single (file gone, result_files updated, hashes untouched, 404 twice), delete all, 409 on running, 404 for other user's job and for unknown filename, CSRF required.

- [ ] Write failing tests → run → implement → run `tests/server/test_jobs.py tests/server/test_recipes.py` + the comfyapi/split files you touched → commit `feat(server): job label, GET /api/me/artifacts, artifact delete routes`.

### Task 2: cloud parity

**Files:**
- Create: `cloud/migrations/0014_job_label.sql` (`ALTER TABLE jobs ADD COLUMN label TEXT NULL;` with a comment block like 0013's).
- Create: `cloud/src/core/label.ts` (`LABEL_MAX_CHARS`, `normalizeLabel`, `deriveLabel`, `ARTIFACT_KINDS`, `artifactKind`) — byte-parity port of Task 1.
- Modify: `cloud/src/db/queries.ts` (`Job.label`, `NewJob.label?`, `insertJob` binds label, `rowToJob`, split-children INSERT copies parent label, `listDoneJobsWithResultsForUser(db, uid)`, `updateJobResultFiles(db, jobId, files)`), `cloud/src/routes/jobs.ts` (`createJobFromWorkflow(..., opts.label)`, `POST /api/jobs` reads form `label`, `_job_dict` twin includes `label`, new routes), `cloud/src/routes/recipes.ts` (label = body.label ?? recipe id), `cloud/src/routes/comfyapi.ts` (label: deriveLabel(promptObj)), `cloud/src/core/split.ts` if children are built there.
- Test: `cloud/test/label.spec.ts` (pure parity cases identical to Task 1's), `cloud/test/jobs.spec.ts` (routes), `cloud/test/recipes.spec.ts`, `cloud/test/comfyapi.spec.ts`.

`GET /api/me/artifacts`: for each job, `env.STORE.list({prefix: "artifacts/<job_id>/"})` (drain cursor) → map name→size; emit as spec. Delete: `env.STORE.delete(artifactKey(jobId, name))`, then `updateJobResultFiles`.

- [ ] Same test list as Task 1 → `npx tsc --noEmit -p .` → run touched specs → commit `feat(cloud): job label, GET /api/me/artifacts, artifact delete routes (parity)`.

### Task 3: web — Files page

**Files:**
- Create: `web/src/pages/Files.tsx`, `web/src/pages/Files.test.tsx`.
- Modify: `web/src/api.ts` (`Job.label: string | null`; `ArtifactFile {job_id,label,created_at,filename,size,kind}`; `listMyArtifacts()`, `deleteArtifact(jobId, filename)`, `deleteJobArtifacts(jobId)`; `submitJob` gains optional `label` if a form helper exists), `web/src/App.tsx` (route `/files`), `web/src/components/AppLayout.tsx` (nav entry after `/jobs`, `IconFolder`), `web/src/pages/Settings.tsx` (remove the uploads list/delete UI, keep the quota line + refresh), `web/src/pages/Settings.test.tsx` (move `describe('Settings page: my uploads card')` cases into `Files.test.tsx`; keep the quota-line describe), `web/src/pages/Jobs.tsx` (show `job.label` under the short id when present), `web/src/pages/JobDetail.tsx` (title shows label when present), `web/src/i18n/zh-TW.json` + `en.json` (`nav.files`, `files.*` from spec §4).

Files page behaviour per spec §4. Grouping helper (export for tests):
```ts
export function groupArtifacts(files: ArtifactFile[]): { label: string; dates: { date: string; files: ArtifactFile[] }[] }[]
// label = file.label ?? file.job_id.slice(0, 8); date = local YYYY-MM-DD of created_at; groups ordered by newest file desc; dates desc; files by filename asc.
```
Tests: renders uploads from `GET /api/staging` and deletes via `DELETE /api/staging/{name}` (moved cases); renders `label/date` groups from `GET /api/me/artifacts`, image → `<img src="/api/jobs/<id>/artifacts/<name>">`, video → `<video>`, other → filename only; download link has `download` attr; single delete calls `DELETE /api/jobs/<id>/artifacts/<name>` after confirm and refreshes; batch delete calls `DELETE /api/jobs/<id>/artifacts` once per job in that folder; `groupArtifacts` ordering; nav shows「檔案」.

- [ ] Tests → implement → `npx vitest run src/pages/Files.test.tsx src/pages/Settings.test.tsx src/pages/Jobs.test.tsx` → `npm run build` (tsc -b must pass) → commit `feat(web): Files page (uploads + label/date output browser)`.

### Task 4: MCP `label`, agent 0.1.16, docs

- `agent/comfyfed_agent/mcp_server.py`: `run_recipe(c, recipe_id, params, label=None)` → body includes `label` when given; `submit_workflow(..., label=None)` → form field. Tool docstrings: 「label 會成為檔案頁的資料夾名稱 / becomes the folder name on the Files page」. `agent/comfyfed_agent/__init__.py` `__version__ = "0.1.16"`; agent pyproject version too (find it: `grep -rn "0.1.15" agent/ --include=*.toml --include=*.py`).
- `tests/agent/test_mcp_server.py` (or existing MCP test file): label forwarded in both.
- Docs: `docs/MCP.zh.md`/`MCP.en.md` add `label`; `docs/SELF-HOSTING.zh.md`/`.en.md`: new `### 檔案頁 / Files page` section after the 範本 section describing uploads + outputs browser + delete semantics (ledger untouched) + label sources; update the「我的上傳檔案」sentence in the upload-limits paragraph to point at the Files page.
- [ ] Commit `feat(mcp+docs): label on run_recipe/submit_workflow; Files page docs; agent 0.1.16`.
