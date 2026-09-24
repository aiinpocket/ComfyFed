# 檔案頁（上傳素材＋產出成品）設計 / Files page design

日期：2026-09-20。狀態：使用者已核准，直接實作。

## 1. 目標

Console 多一個「檔案 / Files」頁，讓使用者在一個地方看到：

1. **上傳素材**（現有 staging 清單，原本在 Settings 的「我的上傳檔案」卡）；
2. **產出成品**：自己所有 job 的產出檔，以 `[工作名稱] / [YYYY-MM-DD] /` 兩層資料夾呈現，
   圖片、影片直接顯示縮圖，每個檔案可再次下載或刪除，整個日期資料夾可整批刪除。

## 2. 工作名稱：`jobs.label`

Job 目前沒有名稱。新增 nullable 欄位 `jobs.label TEXT NULL`（server alembic `a7b8c9d0e1f2_job_label`、cloud `0014_job_label.sql`），舊列不回填。

名稱來源，優先序：

1. 呼叫端明確給的 `label`：
   - console `POST /api/jobs` 多一個選填 form 欄位 `label`；
   - `POST /api/recipes/{id}/run` 一律寫 `label = recipe_id`（body 可帶 `label` 覆蓋）；
   - MCP `run_recipe(recipe_id, params, label=None)`、`submit_workflow(workflow_json, requirements=None, label=None)`。
2. 沒給時，從 workflow 推：`derive_label(workflow) -> str | None`（server `jobs.derive_label`、cloud `core/label.ts` `deriveLabel`，byte-parity）：
   走過 API-format workflow 的節點（dict 的值），依 **node id 字串排序**，取第一個 `class_type` 以 `Save` 開頭、且 `inputs.filename_prefix` 是非空字串的節點；回傳 `filename_prefix` 去掉頭尾空白、`/`／`\` 後面的最後一段（ComfyUI 允許 `sub/dir/name`，只取 `name`）、截到 64 字。找不到 → `None`。
3. 都沒有 → 存 NULL；顯示時用 job id 前 8 碼。

`label` 進 DB 前：去頭尾空白、截 64 字、空字串當 NULL。`_job_dict`／`rowToJob`／`GET /api/jobs` 每一列都多回 `label`（可為 null）。`model_fetch` 單 `label` 留 NULL。

## 3. API

全部 server（FastAPI）與 cloud（Hono）同構。

### 3.1 `GET /api/me/artifacts`（require_user）

只回**呼叫者自己**的 job（admin 也只看自己的；這是個人檔案頁不是稽核頁）。只列 `kind='prompt'`、`status='done'`、`result_files` 非空的 job；拆分父 job 沒有 `result_files`，子 job 有 `user_id`（沿用父的），所以子 job 自然入列，`label` 顯示父的 label（子 job 建立時複製父 label —— 見 split 建子單處）。

回應：
```json
{
  "files": [
    {"job_id": "…", "label": "chroma-t2i" | null, "created_at": "ISO", "filename": "ComfyUI_00001_.png",
     "size": 123456, "kind": "image" | "video" | "other"}
  ]
}
```
`kind` 依副檔名：image = png/jpg/jpeg/webp/gif；video = mp4/webm/mov；其餘 other。`size` 由儲存層取（server `os.stat`；cloud R2 `list({prefix: artifacts/<job_id>/})` 一次拿一個 job 的全部）；儲存層找不到的檔不列。排序：`created_at` 新到舊，同 job 內依檔名。

### 3.2 `DELETE /api/jobs/{id}/artifacts/{filename}`、`DELETE /api/jobs/{id}/artifacts`（require_csrf_user）

- 404 `jobs.not_found`：job 不存在或非本人且非 admin（同現有下載路由的 `_require_owner_or_admin`／`isOwnerOrAdmin`）。
- 404 `jobs.artifact_not_found`：檔名不在 `result_files`。
- 409 `jobs.not_finished`：job 不是終局狀態（queued/assigned/running）。
- 成功：刪儲存層檔案（不存在也視為成功）、從 `result_files` 移除該名（整筆 → 設 `[]`）；**`result_hashes`、收據、job 列一律保留**（帳本不動）。回 `{"ok": true, "result_files": [...剩下的]}`。
- 整筆版本對每個 `result_files` 元素做同樣的事。

### 3.3 下載

沿用 `GET /api/jobs/{id}/artifacts/{filename}`，不改。

## 4. Console

- 新頁 `/files`（`web/src/pages/Files.tsx`），導覽列在「任務」之後、「Worker」之前，圖示 `IconFolder`，i18n `nav.files`＝「檔案」／「Files」。
- **上半「上傳素材」**：把 Settings 的「我的上傳檔案」卡（清單、重新整理、刪除＋確認、合計）整段搬過來，行為與現有測試相同；Settings 只保留配額進度條與「已用／配額」文字（仍讀 `GET /api/staging`）。
- **下半「產出成品」**：讀 `GET /api/me/artifacts`，前端分組：第一層 `label ?? job_id.slice(0,8)`，第二層 `created_at` 的本地日期 `YYYY-MM-DD`，兩層皆可折疊（Mantine `Accordion`），預設展開最新的第一個名稱。第三層是檔案卡片格（`SimpleGrid`，每張固定 160px 寬）：
  - image → `<Image src={artifactUrl} fit="cover" h={120}>`；
  - video → `<video src={artifactUrl} preload="metadata" controls muted style={{height:120}}>`；
  - other → 圖示 `IconFile`＋副檔名。
  - 卡片下方：檔名（monospace、截斷、tooltip 全名）、大小、job 短 id chip（同資料夾多筆 job 時區分）、下載鈕（`<a download>`）、刪除鈕。
  - 每個日期資料夾標題列右側「刪除整批」鈕。
- 刪除（單檔／整批）都先跳 Modal 確認，成功後 toast 並重新載入清單；失敗 toast 用 `errors.<code>`。
- i18n 新增 `files.*` 鍵（zh-TW／en）：`heading_uploads`、`heading_outputs`、`outputs_hint`、`outputs_empty`、`outputs_load_failed`、`download`、`delete`、`delete_all`、`confirm_delete`、`confirm_delete_all`、`deleted`、`delete_failed`、`unnamed`。`settings.uploads_*` 鍵不刪（Settings 仍用 quota 相關者）。
- `api.ts`：`listMyArtifacts(): Promise<{files: ArtifactFile[]}>`、`deleteArtifact(jobId, filename)`、`deleteJobArtifacts(jobId)`；`Job` 型別加 `label: string | null`。
- 任務列表頁的每列與詳情頁標題顯示 `label`（有才顯示）。

## 5. MCP／agent

`agent/comfyfed_agent/mcp_server.py`：`run_recipe`、`submit_workflow` 加選填 `label`；docstring 說明「會成為檔案頁的資料夾名稱」。agent 版本 0.1.16，發佈到平台。docs `MCP.zh.md`／`MCP.en.md` 補參數；`SELF-HOSTING.{zh,en}.md` 新段「檔案頁」，並把「我的上傳檔案」的描述改指向檔案頁。

## 6. 不做

- admin 瀏覽別人的成品；成品計入配額；zip 批次下載；刪除 job 本身。
