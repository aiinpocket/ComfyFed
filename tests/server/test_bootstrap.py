from comfyfed_server import bootstrap, db, i18n, security


def test_first_run_generates_password(tmp_path):
    r = bootstrap.ensure_installed(str(tmp_path), lang="zh-TW", url="http://h:8388", interactive=False)
    assert r.first_run and len(r.admin_password) >= 12
    with db.get_session() as s:
        h = s.get(db.Setting, "admin_password_hash").value
        assert security.verify_password(r.admin_password, h)


def test_second_run_no_password(tmp_path):
    bootstrap.ensure_installed(str(tmp_path), lang="en", url="http://h", interactive=False)
    r2 = bootstrap.ensure_installed(str(tmp_path), lang=None, url=None, interactive=False)
    assert not r2.first_run and r2.admin_password is None


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
