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
