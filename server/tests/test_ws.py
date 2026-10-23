"""WebSocket 通道：握手、会话建立、补发/全量、ack、resync、心跳、实时推送。"""

from __future__ import annotations

import time

import pytest
from conftest import ADMIN, USER, USER2, capture, hello, msg, put_rule, simple_rule
from starlette.websockets import WebSocketDisconnect

WS = "/api/ext/ws"
EXT_ORIGIN = {"Origin": "chrome-extension://abcdefghijklmnop"}


@pytest.fixture
def ws_client(make_client):
    # 心跳调慢，避免干扰按顺序断言的测试
    return make_client(ping_interval=60, idle_timeout=120)


def sync(ws) -> None:
    """发 ping 并等到 pong：证明此前没有其他待收的消息。"""
    ws.send_json(msg("ping"))
    reply = ws.receive_json()
    assert reply["kind"] == "pong", reply


@pytest.mark.parametrize(
    "headers,code",
    [
        ({}, 4401),
        ({"X-Role": "admin", "Authorization": "Bearer x"}, 4401),
        ({**USER, "Origin": "https://evil.example.net"}, 4403),
    ],
)
def test_handshake_rejected(ws_client, headers, code):
    with ws_client.websocket_connect(WS, headers=headers) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == code


def test_handshake_sso_off(make_client):
    c = make_client(sso=False)
    with c.websocket_connect(WS, headers=USER) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 1013


@pytest.mark.parametrize("origin", [None, "chrome-extension://abcdefghijklmnop", "http://testserver"])
def test_handshake_allowed_origins(ws_client, origin):
    headers = {**USER} if origin is None else {**USER, "Origin": origin}
    with ws_client.websocket_connect(WS, headers=headers) as ws:
        sync(ws)


def test_hello_new_user_gets_snapshot(ws_client):
    put_rule(ws_client, simple_rule("team"), ADMIN, shared=True)
    with ws_client.websocket_connect(WS, headers={**USER, **EXT_ORIGIN}) as ws:
        ws.send_json(hello(0))
        snap = ws.receive_json()
        assert snap["kind"] == "snapshot" and snap["v"] == 1 and snap["id"]
        assert snap["seq"] == 0 and [r["id"] for r in snap["rules"]] == ["team"]
        sync(ws)


def test_hello_catch_up_and_up_to_date(ws_client):
    for v in (1, 2, 3):
        put_rule(ws_client, simple_rule("a", version=v), USER)
    with ws_client.websocket_connect(WS, headers=USER) as ws:
        ws.send_json(hello(1))
        got = [ws.receive_json(), ws.receive_json()]
        assert [(m["kind"], m["seq"]) for m in got] == [("ruleUpsert", 2), ("ruleUpsert", 3)]
        sync(ws)
    with ws_client.websocket_connect(WS, headers=USER) as ws:
        ws.send_json(hello(3))
        sync(ws)  # 等于当前序号：什么都不发
    for last in (None, 10):
        with ws_client.websocket_connect(WS, headers=USER) as ws:
            ws.send_json(hello(last))
            snap = ws.receive_json()
            assert snap["kind"] == "snapshot" and snap["seq"] == 3
            assert snap["rules"][0]["version"] == 3


def test_realtime_push_to_all_connections(ws_client):
    with (
        ws_client.websocket_connect(WS, headers=USER) as a,
        ws_client.websocket_connect(WS, headers=USER) as b,
        ws_client.websocket_connect(WS, headers=USER2) as other,
    ):
        for ws in (a, b, other):
            ws.send_json(hello(0))
            assert ws.receive_json()["kind"] == "snapshot"
        put_rule(ws_client, simple_rule("x"), USER)
        put_rule(ws_client, simple_rule("x", version=2), USER)
        for ws in (a, b):
            got = [ws.receive_json(), ws.receive_json()]
            assert [(m["kind"], m["seq"]) for m in got] == [("ruleUpsert", 1), ("ruleUpsert", 2)]
        sync(other)  # 别人的私有规则不推
        ws_client.delete("/api/rules/x", headers=USER)
        for ws in (a, b):
            m = ws.receive_json()
            assert (m["kind"], m["seq"], m["ruleId"]) == ("ruleRemove", 3, "x")


def test_shared_rule_pushed_to_other_user(ws_client):
    ws_client.get("/api/me", headers=ADMIN)
    with ws_client.websocket_connect(WS, headers=USER2) as ws:
        ws.send_json(hello())
        assert ws.receive_json()["kind"] == "snapshot"
        put_rule(ws_client, simple_rule("team"), ADMIN, shared=True)
        m = ws.receive_json()
        assert (m["kind"], m["seq"], m["rule"]["id"]) == ("ruleUpsert", 1, "team")


def test_no_live_events_before_hello(ws_client):
    with ws_client.websocket_connect(WS, headers=USER) as ws:
        put_rule(ws_client, simple_rule("x"), USER)
        sync(ws)  # 未 hello 不推
        ws.send_json(hello(0))
        m = ws.receive_json()
        assert (m["kind"], m["seq"]) == ("snapshot", 1)
        put_rule(ws_client, simple_rule("x", version=2), USER)
        assert ws.receive_json()["seq"] == 2


def test_ack_recorded(ws_client):
    put_rule(ws_client, simple_rule("x"), USER)
    with ws_client.websocket_connect(WS, headers=USER) as ws:
        ws.send_json(msg("ack", seq=1))
        sync(ws)
    with ws_client.app.state.db.tx() as c:
        assert c.execute("SELECT acked_seq FROM users WHERE sub = 'sub-alice'").fetchone()[0] == 1


def test_resync_replies_snapshot(ws_client):
    put_rule(ws_client, simple_rule("x"), USER)
    with ws_client.websocket_connect(WS, headers=USER) as ws:
        ws.send_json(hello(1))
        sync(ws)
        ws.send_json(msg("resync"))
        snap = ws.receive_json()
        assert snap["kind"] == "snapshot" and snap["seq"] == 1 and snap["rules"][0]["id"] == "x"
        put_rule(ws_client, simple_rule("x", version=2), USER)
        assert ws.receive_json()["seq"] == 2


def test_ping_pong_and_bad_messages(ws_client):
    with ws_client.websocket_connect(WS, headers=USER) as ws:
        ws.send_text("not json {")
        sync(ws)  # 无法解析的消息忽略，不断开
        ws.send_json(msg("pong"))
        sync(ws)
        ws.send_json({**msg("ping"), "v": 2})
        err = ws.receive_json()
        assert err["kind"] == "error" and err["code"] == "UNSUPPORTED_VERSION" and err["v"] == 1
        ws.send_json({"kind": "ping", "id": "x"})
        assert ws.receive_json()["code"] == "UNSUPPORTED_VERSION"
        ws.send_json(msg("teleport"))
        assert ws.receive_json()["code"] == "INVALID_MESSAGE"
        sync(ws)


def test_uplink_over_websocket(ws_client):
    cap = capture()
    with ws_client.websocket_connect(WS, headers=USER) as ws:
        ws.send_json(cap)
        ws.send_json(cap)  # 重发去重
        sync(ws)
    assert len(ws_client.get("/api/captures", headers=USER).json()) == 1


def test_ws_too_large(make_client):
    c = make_client(ping_interval=60, idle_timeout=120, max_body=1000)
    with c.websocket_connect(WS, headers=USER) as ws:
        ws.send_json(capture(title="x" * 2000))
        assert ws.receive_json()["code"] == "PAYLOAD_TOO_LARGE"
        sync(ws)
    assert c.get("/api/captures", headers=USER).json() == []


def test_server_ping_and_idle_close(make_client):
    c = make_client(ping_interval=0.1, idle_timeout=0.5)
    kinds: list[str] = []
    start = time.monotonic()
    with c.websocket_connect(WS, headers=USER) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            while True:
                kinds.append(ws.receive_json()["kind"])
    elapsed = time.monotonic() - start
    assert exc.value.code == 1001
    assert kinds and set(kinds) == {"ping"}
    assert 0.4 < elapsed < 5


def test_client_messages_keep_connection_alive(make_client):
    c = make_client(ping_interval=0.1, idle_timeout=0.4)
    with c.websocket_connect(WS, headers=USER) as ws:
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            m = ws.receive_json()
            if m["kind"] == "ping":
                ws.send_json(msg("pong"))
        ws.send_json(msg("ping"))
        while ws.receive_json()["kind"] != "pong":
            pass
