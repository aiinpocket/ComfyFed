"""First-run install wizard: bilingual prompts, random admin password, settings persistence."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass

from . import db, i18n, security

_DB_FILENAME = "comfyfed.db"

_ADMIN_USERNAME = "admin"
_PLATFORM_URL_KEY = "platform_url"
_LANG_KEY = "lang"


@dataclass
class InstallResult:
    admin_password: str | None
    first_run: bool


def _is_installed(session) -> bool:
    """Whether the server has already been through first-run setup.

    Final review finding #12: aligned to cloud's `hasAnyUser` semantics --
    ANY `users` row means installed, not specifically one named `admin`.
    Immaterial today (there is no username rename and no DELETE), but the
    two answers would otherwise diverge the moment a future task adds
    either -- e.g. an admin renaming their own account would make this
    return `False` again under the old definition, offering a fresh
    install wizard on top of a live, populated database.
    """
    return session.query(db.User).first() is not None


def get_lang() -> str:
    """Return the installed server's interface language (default "en").

    Assumes `db.init_db` has already run (e.g. via `ensure_installed` or
    `create_app`) in this process.
    """
    with db.get_session() as session:
        row = session.get(db.Setting, _LANG_KEY)
        return row.value if row is not None else "en"


def get_platform_url() -> str:
    """Return the installed server's public platform URL (default "").

    Assumes `db.init_db` has already run (e.g. via `ensure_installed` or
    `create_app`) in this process.
    """
    with db.get_session() as session:
        row = session.get(db.Setting, _PLATFORM_URL_KEY)
        return row.value if row is not None else ""


def ensure_installed(
    data_dir: str,
    lang: str | None,
    url: str | None,
    interactive: bool,
) -> InstallResult:
    """Ensure the server is installed: on first run, generate credentials and platform keys.

    Non-first runs are a no-op and return first_run=False with admin_password=None.
    """
    db.init_db(os.path.join(data_dir, _DB_FILENAME))

    with db.get_session() as session:
        if _is_installed(session):
            return InstallResult(admin_password=None, first_run=False)

        if interactive:
            print(i18n.t("install.choose_lang", "zh-TW") + " / " + i18n.t("install.choose_lang", "en"))
            chosen_lang = input().strip() or "en"
            lang = chosen_lang or lang

            print(i18n.t("install.enter_url", lang))
            entered_url = input().strip()
            url = entered_url or url

        lang = lang or "en"
        url = url or ""

        # Platform Ed25519 keys, generated and persisted on first install.
        security.load_platform_keys(data_dir)

        admin_password = secrets.token_urlsafe(12)
        admin_password_hash = security.hash_password(admin_password)

        session.add(
            db.User(
                username=_ADMIN_USERNAME,
                password_hash=admin_password_hash,
                role="admin",
            )
        )
        session.add(db.Setting(key=_PLATFORM_URL_KEY, value=url))
        session.add(db.Setting(key=_LANG_KEY, value=lang))
        session.commit()

        if interactive:
            print(i18n.t("install.admin_password_notice", lang))
            print(admin_password)
            print(i18n.t("install.done", lang))

        return InstallResult(admin_password=admin_password, first_run=True)
