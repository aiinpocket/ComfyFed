from comfyfed_server import db


def test_init_creates_tables(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    with db.get_session() as s:
        s.add(db.Setting(key="platform_url", value="http://x"))
        s.commit()
        assert s.get(db.Setting, "platform_url").value == "http://x"


def test_worker_defaults(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    with db.get_session() as s:
        w = db.Worker(id="w1", name="n", pubkey="pk")
        s.add(w)
        s.commit()
        assert (w.status, w.disabled) == ("offline", False)
