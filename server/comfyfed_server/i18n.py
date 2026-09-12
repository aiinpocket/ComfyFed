"""Minimal bilingual (zh-TW / en) dictionary for install/bootstrap strings."""

from __future__ import annotations

_DICT: dict[str, dict[str, str]] = {
    "install.choose_lang": {
        "zh-TW": "請選擇語言 / Choose language (zh-TW/en):",
        "en": "Please choose language / 請選擇語言 (zh-TW/en):",
    },
    "install.enter_url": {
        "zh-TW": "請輸入平台網址 (platform URL):",
        "en": "Enter platform URL:",
    },
    "install.admin_password_notice": {
        "zh-TW": "已產生管理員密碼，請妥善保存（僅顯示一次）：",
        "en": "Admin password generated, please save it (shown only once):",
    },
    "install.done": {
        "zh-TW": "安裝完成。",
        "en": "Installation complete.",
    },
    "install.already_installed": {
        "zh-TW": "伺服器已安裝完成，無需重複安裝。",
        "en": "Server is already installed; nothing to do.",
    },
    "install.next_steps": {
        "zh-TW": "接下來：執行 `comfyfed-server run` 啟動伺服器，然後用上面的密碼登入。",
        "en": "Next: run `comfyfed-server run` to start the server, then log in with the password above.",
    },
    "publish.done": {
        "zh-TW": "已發布 agent 版本，設定如下：",
        "en": "Agent release published; settings written:",
    },
    "publish.offline_key_note": {
        "zh-TW": (
            "注意：平台簽章金鑰可以離線保管。若要離線簽章，請自行對 "
            "\"{版本}|{sha256}\" 簽名，再手動寫入上述 agent_* 設定。"
        ),
        "en": (
            "Note: the platform signing key may be kept offline. To sign offline, sign "
            '"{version}|{sha256}" yourself and set the agent_* settings above by hand.'
        ),
    },
    "fetch_ui.start": {
        "zh-TW": "正在下載官方 ComfyUI 前端（{version}）…",
        "en": "Downloading the official ComfyUI frontend ({version})…",
    },
    "fetch_ui.already_present": {
        "zh-TW": "已經有前端檔案了，不重複下載。要重抓請先刪掉這個目錄：",
        "en": "The frontend is already installed; nothing to download. Delete this directory to re-fetch:",
    },
    "fetch_ui.done": {
        "zh-TW": "前端安裝完成（{files} 個檔案）。重啟伺服器後，登入 Console 即可從「工作」頁開啟 /comfy。",
        "en": "Frontend installed ({files} files). Restart the server, then open /comfy from the console's Jobs page.",
    },
    "fetch_ui.unpinned_warning": {
        "zh-TW": "⚠ 你指定了 --version，這不是本版內建的釘選版本，因此**略過 sha256 驗證**，且不保證與本平台的 /comfy/api 相容。",
        "en": "⚠ --version was given, so this is not the build pinned by this release: the sha256 check is SKIPPED and compatibility with this platform's /comfy/api is not guaranteed.",
    },
    "fetch_ui.failed": {
        "zh-TW": "下載失敗：",
        "en": "Fetch failed:",
    },
    "install.password_box_title": {
        "zh-TW": "管理員密碼（僅顯示一次，請立即保存）",
        "en": "Admin password (shown once, save it now)",
    },
    "fetch_templates.start": {
        "zh-TW": "正在從 PyPI 下載官方範本庫…",
        "en": "Downloading the official template library from PyPI…",
    },
    "fetch_templates.done": {
        "zh-TW": "範本庫安裝完成（{files} 個檔案，meta 版本 {meta_version}）。",
        "en": "Template library installed ({files} files, meta version {meta_version}).",
    },
    "fetch_templates.failed": {
        "zh-TW": "下載失敗：",
        "en": "Fetch failed:",
    },
}


def t(key: str, lang: str | None) -> str:
    """Look up a translation. Falls back to en, then the key itself."""
    entry = _DICT.get(key)
    if entry is None:
        return key
    if lang and lang in entry:
        return entry[lang]
    if "en" in entry:
        return entry["en"]
    return key
