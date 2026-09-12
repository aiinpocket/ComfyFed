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
    "install.password_box_title": {
        "zh-TW": "管理員密碼（僅顯示一次，請立即保存）",
        "en": "Admin password (shown once, save it now)",
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
