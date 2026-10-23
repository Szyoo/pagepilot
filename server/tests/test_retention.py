"""保留期清理与数据库迁移。"""

from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from conftest import USER, capture, make_config, poll, put_rule, recording, run_report, simple_rule

from pagepilot_server.app import create_app
from pagepilot_server.db import MIGRATIONS, Database, now_ms
from pagepilot_server.retention import DAY_MS, purge


def upload(c, m):
    assert c.post("/api/ext/uplink", json=m, headers=USER).status_code == 202


def age(c, table: str, days: int) -> None:
    with c.app.state.db.tx() as conn:
        conn.execute(f"UPDATE {table} SET received_at = ?", (now_ms() - days * DAY_MS,))


def test_purge_by_retention_days(make_client):
    c = make_client(retention_days=30)
    old, new = capture(), capture()
    upload(c, old)
    upload(c, recording("rec-old"))
    upload(c, run_report("run-old"))
    age(c, "captures", 31)
    age(c, "recordings", 31)
    age(c, "run_reports", 31)
    age(c, "uplink_seen", 31)
    upload(c, new)
    upload(c, recording("rec-new"))
    upload(c, run_report("run-new"))
    result = purge(c.app.state.db, 30)
    assert result["captures"] == 1 and result["recordings"] == 1 and result["run_reports"] == 1
    assert [x["captureId"] for x in c.get("/api/captures", headers=USER).json()] == [new["id"]]
    assert [x["recordingId"] for x in c.get("/api/recordings", headers=USER).json()] == ["rec-new"]
    assert [x["runId"] for x in c.get("/api/runs", headers=USER).json()] == ["run-new"]
    # 规则不受保留期影响
    put_rule(c, simple_rule("a"), USER)
    assert purge(c.app.state.db, 30, now=now_ms() + 365 * DAY_MS)["user_events"] == 0
    assert len(c.get("/api/rules", headers=USER).json()) == 1


def test_purge_trims_user_events(make_client):
    c = make_client(events_keep=10_000)
    for v in range(1, 13):
        put_rule(c, simple_rule("a", version=v), USER)
    result = purge(c.app.state.db, 90, events_keep=5)
    assert result["user_events"] == 7
    with c.app.state.db.tx() as conn:
        seqs = [r[0] for r in conn.execute("SELECT seq FROM user_events ORDER BY seq")]
    assert seqs == [8, 9, 10, 11, 12]
    assert [m["kind"] for m in poll(c, USER, since=6)] == ["snapshot"]
    assert [m["seq"] for m in poll(c, USER, since=7)] == [8, 9, 10, 11, 12]


def test_purge_runs_on_startup(tmp_path):
    config = make_config(tmp_path)
    with TestClient(create_app(config)) as c:
        upload(c, capture())
        age(c, "captures", 100)
    with TestClient(create_app(config)) as c:  # 同一个数据目录，启动时清理
        assert c.get("/api/captures", headers=USER).json() == []


def test_migrations_set_user_version_and_pragmas(tmp_path):
    db = Database(tmp_path / "x.db")
    assert db.schema_version == len(MIGRATIONS)
    with db.tx() as c:
        assert c.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    db.close()
    # 再次打开不重复执行
    db = Database(tmp_path / "x.db")
    assert db.schema_version == len(MIGRATIONS)
    db.close()
    raw = sqlite3.connect(tmp_path / "x.db")
    tables = {r[0] for r in raw.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"users", "rules", "user_events", "captures", "recordings", "run_reports", "clients", "uplink_seen"} <= tables
    raw.close()


def test_purge_loop_runs_periodically(make_client):
    import time

    c = make_client(purge_interval=0.05)
    upload(c, capture())
    age(c, "captures", 100)
    deadline = time.monotonic() + 3
    while c.get("/api/captures", headers=USER).json() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert c.get("/api/captures", headers=USER).json() == []
