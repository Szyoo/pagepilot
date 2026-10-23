"""事件与序号：按用户连续、扇出、可见性变化、全量与补发、裁剪。"""

from __future__ import annotations

import json

from conftest import ADMIN, USER, USER2, poll, put_rule, simple_rule

from pagepilot_server.events import catch_up


def events_of(c, sub: str) -> list[tuple[int, str, str]]:
    with c.app.state.db.tx() as conn:
        rows = conn.execute("SELECT seq, kind, payload FROM user_events WHERE sub = ? ORDER BY seq", (sub,)).fetchall()


    out = []
    for r in rows:
        p = json.loads(r["payload"])
        out.append((r["seq"], r["kind"], p.get("ruleId") or p["rule"]["id"]))
    return out


def seq_of(c, sub: str) -> int:
    with c.app.state.db.tx() as conn:
        return conn.execute("SELECT seq FROM users WHERE sub = ?", (sub,)).fetchone()[0]


def register(c, *headers):
    for h in headers:
        assert c.get("/api/me", headers=h).status_code == 200


def test_private_rule_events_only_for_owner(client):
    register(client, USER, USER2)
    put_rule(client, simple_rule("a"), USER)
    put_rule(client, simple_rule("a", version=2), USER)
    put_rule(client, simple_rule("b"), USER)
    assert events_of(client, "sub-alice") == [(1, "ruleUpsert", "a"), (2, "ruleUpsert", "a"), (3, "ruleUpsert", "b")]
    assert events_of(client, "sub-bob") == []
    assert seq_of(client, "sub-bob") == 0


def test_shared_rule_fans_out_to_all_registered(client):
    register(client, USER, USER2)
    put_rule(client, simple_rule("mine"), USER)  # alice seq 1
    put_rule(client, simple_rule("team"), ADMIN, shared=True)
    assert events_of(client, "sub-alice") == [(1, "ruleUpsert", "mine"), (2, "ruleUpsert", "team")]
    assert events_of(client, "sub-bob") == [(1, "ruleUpsert", "team")]
    assert events_of(client, "sub-admin") == [(1, "ruleUpsert", "team")]


def test_late_user_gets_shared_rule_via_snapshot(client):
    put_rule(client, simple_rule("team"), ADMIN, shared=True)
    register(client, USER2)  # 之后才登记
    assert events_of(client, "sub-bob") == []
    msgs = poll(client, USER2, since=0)
    assert [m["kind"] for m in msgs] == ["snapshot"]
    assert msgs[0]["seq"] == 0 and [r["id"] for r in msgs[0]["rules"]] == ["team"]


def test_shared_to_private_removes_for_others(client):
    register(client, USER, USER2)
    put_rule(client, simple_rule("team"), ADMIN, shared=True)
    r = put_rule(client, simple_rule("team", version=2), ADMIN, shared=False)
    assert r.status_code == 200 and r.json()["shared"] is False
    assert events_of(client, "sub-alice") == [(1, "ruleUpsert", "team"), (2, "ruleRemove", "team")]
    assert events_of(client, "sub-admin") == [(1, "ruleUpsert", "team"), (2, "ruleUpsert", "team")]


def test_private_to_shared_upserts_for_all(client):
    register(client, USER, USER2)
    put_rule(client, simple_rule("x"), USER)
    put_rule(client, simple_rule("x", version=2), ADMIN, shared=True)
    assert events_of(client, "sub-alice") == [(1, "ruleUpsert", "x"), (2, "ruleUpsert", "x")]
    assert events_of(client, "sub-bob") == [(1, "ruleUpsert", "x")]


def test_shared_kept_when_omitted(client):
    register(client, USER)
    put_rule(client, simple_rule("team"), ADMIN, shared=True)
    r = put_rule(client, simple_rule("team", version=2), ADMIN)
    assert r.json()["shared"] is True
    assert events_of(client, "sub-alice")[-1] == (2, "ruleUpsert", "team")


def test_delete_produces_remove_for_audience(client):
    register(client, USER, USER2)
    put_rule(client, simple_rule("team"), ADMIN, shared=True)
    put_rule(client, simple_rule("own"), USER)
    assert client.delete("/api/rules/team", headers=ADMIN).status_code == 204
    assert client.delete("/api/rules/own", headers=USER).status_code == 204
    assert events_of(client, "sub-bob") == [(1, "ruleUpsert", "team"), (2, "ruleRemove", "team")]
    assert events_of(client, "sub-alice")[-2:] == [(3, "ruleRemove", "team"), (4, "ruleRemove", "own")]
    assert client.delete("/api/rules/own", headers=USER).status_code == 404


def test_version_must_increase(client):
    assert put_rule(client, simple_rule("a", version=3), USER).status_code == 200
    assert put_rule(client, simple_rule("a", version=3), USER).status_code == 409
    assert put_rule(client, simple_rule("a", version=2), USER).status_code == 409
    assert put_rule(client, simple_rule("a", version=4), USER).status_code == 200
    assert [e[0] for e in events_of(client, "sub-alice")] == [1, 2]


def test_list_rules_shape(client):
    put_rule(client, simple_rule("a"), USER)
    rows = client.get("/api/rules", headers=USER).json()
    assert len(rows) == 1
    assert set(rows[0]) == {"rule", "ownerSub", "shared", "updatedAt"}
    assert rows[0]["ownerSub"] == "sub-alice" and rows[0]["shared"] is False
    assert isinstance(rows[0]["updatedAt"], int)


def test_list_limit(client):
    for i in range(5):
        put_rule(client, simple_rule(f"r{i}"), USER)
    assert len(client.get("/api/rules?limit=2", headers=USER).json()) == 2
    assert len(client.get("/api/rules?limit=9999", headers=USER).json()) == 5


# ----- 全量与补发 -----


def test_snapshot_content_and_seq(client):
    register(client, USER, USER2)
    put_rule(client, simple_rule("mine"), USER)
    put_rule(client, simple_rule("bobs"), USER2)
    put_rule(client, simple_rule("team"), ADMIN, shared=True)
    [snap] = poll(client, USER)
    assert snap["kind"] == "snapshot" and snap["seq"] == 2
    assert sorted(r["id"] for r in snap["rules"]) == ["mine", "team"]


def test_catch_up_ranges(client):
    register(client, USER)
    for v in range(1, 6):
        put_rule(client, simple_rule("a", version=v), USER)
    db = client.app.state.db
    msgs, cur = catch_up(db, "sub-alice", 5)
    assert msgs == [] and cur == 5
    msgs, _ = catch_up(db, "sub-alice", 2)
    assert [(m["kind"], m["seq"]) for m in msgs] == [("ruleUpsert", 3), ("ruleUpsert", 4), ("ruleUpsert", 5)]
    assert msgs[-1]["rule"]["version"] == 5
    msgs, _ = catch_up(db, "sub-alice", 1)
    assert [m["seq"] for m in msgs] == [2, 3, 4, 5]
    # 0 是扩展的初始值，等同于没有本地状态
    for last in (None, 0, -1, 6, 100):
        msgs, _ = catch_up(db, "sub-alice", last)
        assert [m["kind"] for m in msgs] == ["snapshot"] and msgs[0]["seq"] == 5


def test_replayed_event_keeps_same_id(client):
    put_rule(client, simple_rule("a"), USER)
    put_rule(client, simple_rule("b"), USER)
    a = poll(client, USER, since=1)
    b = poll(client, USER, since=1)
    assert a == b and a[0]["seq"] == 2


def test_trimmed_events_force_snapshot(make_client):
    c = make_client(events_keep=3)
    for v in range(1, 7):
        put_rule(c, simple_rule("a", version=v), USER)
    assert [e[0] for e in events_of(c, "sub-alice")] == [4, 5, 6]
    db = c.app.state.db
    # 最早保留 4：lastSeq = 3 仍可补发，2 需要全量
    assert [m["seq"] for m in catch_up(db, "sub-alice", 3)[0]] == [4, 5, 6]
    msgs = catch_up(db, "sub-alice", 2)[0]
    assert [m["kind"] for m in msgs] == ["snapshot"] and msgs[0]["seq"] == 6


def test_late_user_with_fresh_cache_gets_snapshot_not_replay(client):
    # bob 登记前已有共享规则 team；之后才有事件。本地序号 0 若从 1 补发会漏掉 team
    put_rule(client, simple_rule("team"), ADMIN, shared=True)
    register(client, USER2)
    put_rule(client, simple_rule("bobs"), USER2)
    [snap] = poll(client, USER2, since=0)
    assert snap["kind"] == "snapshot" and snap["seq"] == 1
    assert sorted(r["id"] for r in snap["rules"]) == ["bobs", "team"]


def test_new_user_without_events_gets_snapshot(client):
    register(client, USER)
    msgs = poll(client, USER, since=0)
    assert [m["kind"] for m in msgs] == ["snapshot"] and msgs[0]["rules"] == [] and msgs[0]["seq"] == 0
