from comfyfed_server import bootstrap, db, i18n, security


def test_first_run_generates_password(tmp_path):
    r = bootstrap.ensure_installed(str(tmp_path), lang="zh-TW", url="http://h:8388", interactive=False)
    assert r.first_run and len(r.admin_password) >= 12
    with db.get_session() as s:
        user = s.query(db.User).filter(db.User.username == "admin").one()
        assert user.role == "admin"
        assert security.verify_password(r.admin_password, user.password_hash)


def test_second_run_no_password(tmp_path):
    bootstrap.ensure_installed(str(tmp_path), lang="en", url="http://h", interactive=False)
    r2 = bootstrap.ensure_installed(str(tmp_path), lang=None, url=None, interactive=False)
    assert not r2.first_run and r2.admin_password is None


def test_installed_predicate_is_any_user_not_specifically_named_admin(tmp_path):
    """Final review finding #12: aligned to cloud's `hasAnyUser` semantics --
    renaming the sole account away from `admin` must not make the server
    look uninstalled again (the old predicate checked specifically for a
    user named `admin`)."""
    r1 = bootstrap.ensure_installed(str(tmp_path), lang="en", url="http://h", interactive=False)
    assert r1.first_run

    with db.get_session() as s:
        user = s.query(db.User).filter(db.User.username == "admin").one()
        user.username = "renamed-owner"
        s.commit()

    r2 = bootstrap.ensure_installed(str(tmp_path), lang=None, url=None, interactive=False)
    assert not r2.first_run and r2.admin_password is None

    with db.get_session() as s:
        assert s.query(db.User).count() == 1  # not re-seeded with a second admin row


def test_platform_keys_persist(tmp_path):
    sk1, _ = security.load_platform_keys(str(tmp_path))
    sk2, _ = security.load_platform_keys(str(tmp_path))
    assert bytes(sk1) == bytes(sk2)


def test_i18n_both_languages():
    assert i18n.t("install.admin_password_notice", "zh-TW") != i18n.t("install.admin_password_notice", "en")


def test_i18n_key_parity():
    zh_keys = set(i18n._DICT.keys())
    for key in zh_keys:
        assert "zh-TW" in i18n._DICT[key]
        assert "en" in i18n._DICT[key]
