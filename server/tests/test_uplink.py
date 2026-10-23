"""上行消息：存储、幂等、去重、大小上限、版本与格式错误。"""

from __future__ import annotations

import json

import pytest
from conftest import USER, USER2, capture, hello, msg, recording, run_report

UPLINK = "/api/ext/uplink"


def count(c, table: str) -> int:
    with c.app.state.db.tx() as conn:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def test_capture_stored(client):
    m = capture()
    r = client.post(UPLINK, json=m, headers=USER)
    assert r.status_code == 202 and r.json()["ok"] is True
    rows = client.get("/api/captures", headers=USER).json()
    assert rows == [
        {
            "captureId": m["id"],
            "pageUrl": "https://example.com/form",
            "title": "表单",
            "elementCount": 1,
            "capturedAt": 1760000000000,
            "receivedAt": rows[0]["receivedAt"],
            "ownerSub": "sub-alice",
        }
    ]
    detail = client.get(f"/api/captures/{m['id']}", headers=USER).json()
    assert detail["elements"] == m["elements"] and detail["ownerSub"] == "sub-alice"


def test_same_message_id_deduplicated(client):
    m = capture()
    assert client.post(UPLINK, json=m, headers=USER).status_code == 202
    r = client.post(UPLINK, json=m, headers=USER)
    assert r.status_code == 202 and r.json()["duplicate"] is True
    assert count(client, "captures") == 1
    # 去重按用户：别人的同 id 消息照常处理
    assert "duplicate" not in client.post(UPLINK, json=m, headers=USER2).json()
    assert count(client, "captures") == 2


def test_recording_idempotent_by_recording_id(client):
    first = recording("rec-1")
    again = recording("rec-1", steps=[{"id": "x", "type": "open", "url": "u"}])  # 新的消息 id
    assert client.post(UPLINK, json=first, headers=USER).status_code == 202
    assert client.post(UPLINK, json=again, headers=USER).status_code == 202
    assert count(client, "recordings") == 1
    detail = client.get("/api/recordings/rec-1", headers=USER).json()
    assert len(detail["steps"]) == 3  # 保留第一次收到的内容


def test_run_report_idempotent_by_run_id(client):
    assert client.post(UPLINK, json=run_report("run-1"), headers=USER).status_code == 202
    assert client.post(UPLINK, json=run_report("run-1"), headers=USER).status_code == 202
    assert count(client, "run_reports") == 1


def test_too_large_is_413(make_client):
    c = make_client(max_body=2000)
    big = capture(title="x" * 3000)
    r = c.post(UPLINK, json=big, headers=USER)
    assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"
    # 没有 Content-Length 的分块上传同样受限
    body = json.dumps(big).encode()
    r = c.post(UPLINK, content=iter([body[:1000], body[1000:]]), headers={**USER, "Content-Type": "application/json"})
    assert r.status_code == 413
    assert count(c, "captures") == 0


def test_default_limit_is_2mb(client):
    assert client.app.state.config.max_body == 2 * 1024 * 1024
    big = capture(title="x" * (2 * 1024 * 1024))
    assert client.post(UPLINK, json=big, headers=USER).status_code == 413


def test_unsupported_version(client):
    r = client.post(UPLINK, json={**capture(), "v": 2}, headers=USER)
    assert r.status_code == 400
    body = r.json()
    assert body["kind"] == "error" and body["code"] == "UNSUPPORTED_VERSION" and body["v"] == 1 and body["id"]
    assert count(client, "captures") == 0


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"v": 1, "kind": "capture"},
        {"v": 1, "id": "", "kind": "ping"},
        msg("unknown"),
        {**capture(), "elements": "nope"},
        {**recording(), "steps": None},
        {**run_report(), "status": "exploded"},
        {**hello(), "lastSeq": -1},
        msg("ack"),
    ],
)
def test_invalid_messages_are_400(client, payload):
    r = client.post(UPLINK, json=payload, headers=USER)
    assert r.status_code == 400
    assert r.json()["code"] == "INVALID_MESSAGE"


def test_invalid_json(client):
    r = client.post(UPLINK, content=b"{nope", headers={**USER, "Content-Type": "application/json"})
    assert r.status_code == 400


def test_invalid_message_not_marked_seen(client):
    bad = {**capture(), "elements": "nope"}
    assert client.post(UPLINK, json=bad, headers=USER).status_code == 400
    good = {**bad, "elements": []}
    assert client.post(UPLINK, json=good, headers=USER).status_code == 202
    assert count(client, "captures") == 1


def test_hello_registers_client(client):
    assert client.post(UPLINK, json=hello(0), headers=USER).status_code == 200
    with client.app.state.db.tx() as c:
        row = c.execute("SELECT * FROM clients").fetchone()
    assert (row["sub"], row["client_id"], row["ext_version"]) == ("sub-alice", "client-1", "0.1.0")


def test_ping_over_http_returns_pong(client):
    r = client.post(UPLINK, json=msg("ping"), headers=USER)
    assert r.status_code == 200 and [m["kind"] for m in r.json()["messages"]] == ["pong"]
    assert client.post(UPLINK, json=msg("pong"), headers=USER).json()["messages"] == []


def test_ack_keeps_max(client):
    client.post(UPLINK, json=msg("ack", seq=5), headers=USER)
    client.post(UPLINK, json=msg("ack", seq=3), headers=USER)
    with client.app.state.db.tx() as c:
        assert c.execute("SELECT acked_seq FROM users").fetchone()[0] == 5
