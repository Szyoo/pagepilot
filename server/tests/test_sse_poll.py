"""SSE 与轮询：先补发/全量再实时、keepalive、resync 经上行触发。"""

from __future__ import annotations

import json
import time

from conftest import ADMIN, USER, USER2, hello, msg, poll, put_rule, simple_rule

STREAM = "/api/ext/stream"


class SseReader:
    def __init__(self, response) -> None:
        self.lines = response.iter_lines()
        self.keepalives = 0

    def next(self, n: int = 1, timeout: float = 5.0) -> list[dict]:
        out: list[dict] = []
        deadline = time.monotonic() + timeout
        while len(out) < n:
            assert time.monotonic() < deadline, f"超时，只收到 {out}"
            line = next(self.lines)
            if line.startswith(": keepalive"):
                self.keepalives += 1
            elif line.startswith("data: "):
                out.append(json.loads(line[6:]))
        return out

    def wait_keepalive(self, timeout: float = 5.0) -> None:
        """等到一条 keepalive：证明此前没有待收的数据事件。"""
        deadline = time.monotonic() + timeout
        while True:
            assert time.monotonic() < deadline
            line = next(self.lines)
            assert not line.startswith("data: "), line
            if line.startswith(": keepalive"):
                return


def test_stream_headers_and_snapshot(client):
    put_rule(client, simple_rule("a"), USER)
    with client.stream("GET", STREAM, headers=USER) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        sse = SseReader(r)
        [snap] = sse.next()
        assert snap["kind"] == "snapshot" and snap["seq"] == 1 and snap["v"] == 1


def test_stream_catch_up_then_live(client):
    for v in (1, 2, 3):
        put_rule(client, simple_rule("a", version=v), USER)
    with client.stream("GET", f"{STREAM}?since=1", headers=USER) as r:
        sse = SseReader(r)
        assert [(m["kind"], m["seq"]) for m in sse.next(2)] == [("ruleUpsert", 2), ("ruleUpsert", 3)]
        sse.wait_keepalive()
        put_rule(client, simple_rule("b"), USER)
        client.delete("/api/rules/a", headers=USER)
        got = sse.next(2)
        assert [(m["kind"], m["seq"]) for m in got] == [("ruleUpsert", 4), ("ruleRemove", 5)]
        assert got[1]["ruleId"] == "a"


def test_stream_up_to_date_sends_nothing_until_change(client):
    put_rule(client, simple_rule("a"), USER)
    with client.stream("GET", f"{STREAM}?since=1", headers=USER) as r:
        sse = SseReader(r)
        sse.wait_keepalive()
        put_rule(client, simple_rule("team"), ADMIN, shared=True)
        [m] = sse.next()
        assert (m["kind"], m["seq"], m["rule"]["id"]) == ("ruleUpsert", 2, "team")


def test_stream_unsubscribes_on_disconnect(client):
    hub = client.app.state.hub
    with client.stream("GET", STREAM, headers=USER) as r:
        SseReader(r).next()
        assert hub.count() == 1
    deadline = time.monotonic() + 3
    while hub.count() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert hub.count() == 0


def test_resync_via_uplink_pushes_snapshot_to_stream(client):
    put_rule(client, simple_rule("a"), USER)
    with client.stream("GET", f"{STREAM}?since=1", headers=USER) as r:
        sse = SseReader(r)
        sse.wait_keepalive()
        # SSE 的 hello 经上行发送：只登记客户端，不重复补发
        assert client.post("/api/ext/uplink", json=hello(1), headers=USER).status_code == 200
        res = client.post("/api/ext/uplink", json=msg("resync"), headers=USER)
        assert res.status_code == 200
        [snap] = sse.next()
        assert snap["kind"] == "snapshot" and snap["seq"] == 1
        put_rule(client, simple_rule("a", version=2), USER)
        assert sse.next()[0]["seq"] == 2


# ----- 轮询 -----


def test_poll_empty_incremental_and_snapshot(client):
    client.get("/api/me", headers=USER)
    put_rule(client, simple_rule("a"), USER)
    put_rule(client, simple_rule("b"), USER)
    assert poll(client, USER, since=2) == []
    inc = poll(client, USER, since=1)
    assert [(m["kind"], m["seq"], m["rule"]["id"]) for m in inc] == [("ruleUpsert", 2, "b")]
    for since in (None, 3, 99):
        [snap] = poll(client, USER, since=since)
        assert snap["kind"] == "snapshot" and snap["seq"] == 2
        assert sorted(r["id"] for r in snap["rules"]) == ["a", "b"]


def test_poll_returns_snapshot_after_resync_once(client):
    put_rule(client, simple_rule("a"), USER)
    assert poll(client, USER, since=1) == []
    assert client.post("/api/ext/uplink", json=msg("resync"), headers=USER).status_code == 200
    [snap] = poll(client, USER, since=1)
    assert snap["kind"] == "snapshot"
    assert poll(client, USER, since=1) == []  # 已消费
    # 别人的 resync 不影响
    client.post("/api/ext/uplink", json=msg("resync"), headers=USER2)
    assert poll(client, USER, since=1) == []


def test_poll_invalid_since(client):
    assert client.get("/api/ext/poll?since=abc", headers=USER).status_code == 422
    [snap] = poll(client, USER, since=-1)
    assert snap["kind"] == "snapshot"
