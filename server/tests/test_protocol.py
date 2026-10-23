"""协议一致性：后台输出的每种下行消息都满足 src/schema/message.ts 的 downlinkSchema。

1. 用 Python 复现 downlinkSchema 的必需字段并逐条断言；
2. 若本机有 node 与仓库根的 node_modules（vitest），把样例写到临时文件，再用扩展自己的 Zod schema
   校验（server/tests/zod/）；同时比对后台规则校验与 ruleSchema 的结论。没有 node 环境时跳过。
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess

import pytest
from conftest import ADMIN, REPO_ROOT, USER, USER2, doc_rule, hello, msg, put_rule, simple_rule

from pagepilot_server.rules import validate_rule

LOC = {"strategies": [{"kind": "css", "value": "#x"}]}
COND = {"kind": "element", "target": LOC}


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def check_downlink(m: dict) -> None:
    """对应 downlinkSchema（discriminatedUnion on kind）。"""
    assert isinstance(m, dict)
    assert m.get("v") == 1 and _is_int(m["v"]), m
    assert isinstance(m.get("id"), str) and m["id"], m
    kind = m.get("kind")
    assert kind in {"snapshot", "ruleUpsert", "ruleRemove", "ping", "pong", "error"}, m
    if kind in {"snapshot", "ruleUpsert", "ruleRemove"}:
        assert _is_int(m.get("seq")) and m["seq"] >= 0, m
    if kind == "snapshot":
        assert isinstance(m.get("rules"), list) and all(isinstance(r, dict) for r in m["rules"])
        for r in m["rules"]:
            assert validate_rule(r) == []
    elif kind == "ruleUpsert":
        assert isinstance(m.get("rule"), dict) and validate_rule(m["rule"]) == []
    elif kind == "ruleRemove":
        assert isinstance(m.get("ruleId"), str)
    elif kind == "error":
        assert isinstance(m.get("code"), str)
        assert "message" not in m or isinstance(m["message"], str)


def collect_downlink(make_client) -> list[dict]:
    c = make_client(ping_interval=0.05, idle_timeout=30)
    out: list[dict] = []
    c.get("/api/me", headers=USER2)
    put_rule(c, doc_rule(), ADMIN, shared=True)
    put_rule(c, simple_rule("own"), USER2)
    put_rule(c, simple_rule("own", version=2), USER2)
    c.delete("/api/rules/own", headers=USER2)
    out += c.get("/api/ext/poll?since=1", headers=USER2).json()["messages"]  # 增量：upsert / remove
    out += c.get("/api/ext/poll", headers=USER2).json()["messages"]  # snapshot
    r = c.post("/api/ext/uplink", json={**msg("ping"), "v": 9}, headers=USER2)
    out.append(r.json())  # HTTP 的 error
    out += c.post("/api/ext/uplink", json=msg("ping"), headers=USER2).json()["messages"]  # pong
    with c.websocket_connect("/api/ext/ws", headers=USER2) as ws:
        ws.send_json(hello(1))  # 补发 2..4：ruleUpsert 与 ruleRemove
        kinds: set[str] = set()
        ws.send_json(msg("ping"))
        ws.send_json({**msg("ping"), "v": 2})
        ws.send_json(msg("resync"))
        while not {"ruleUpsert", "ruleRemove", "pong", "error", "snapshot", "ping"} <= kinds:
            m = ws.receive_json()
            kinds.add(m["kind"])
            out.append(m)
    assert {m["kind"] for m in out} == {"snapshot", "ruleUpsert", "ruleRemove", "ping", "pong", "error"}
    return out


def test_every_downlink_message_matches_schema(make_client):
    for m in collect_downlink(make_client):
        check_downlink(m)


def test_seq_continuous_as_extension_applies(make_client):
    """按扩展 applyDownlink 的规则应用：snapshot 重置，其余必须是 lastSeq + 1。"""
    c = make_client(ping_interval=60, idle_timeout=120)
    with c.websocket_connect("/api/ext/ws", headers=USER) as ws:
        ws.send_json(hello(0))
        last = ws.receive_json()["seq"]
        for v in range(1, 4):
            put_rule(c, simple_rule("a", version=v), USER)
        put_rule(c, simple_rule("team"), ADMIN, shared=True)
        c.delete("/api/rules/a", headers=USER)
        for _ in range(5):
            m = ws.receive_json()
            assert m["seq"] == last + 1, m
            last = m["seq"]


# ----- 规则校验结论对照语料（也给 Node 端用 ruleSchema 比对） -----


def nest(depth: int) -> dict:
    step: dict = {"id": f"leaf{depth}", "type": "waitFor", "until": "idle"}
    for i in range(depth):
        step = {"id": f"n{i}", "type": "if", "condition": COND, "then": [step]}
    return step


def rule_corpus() -> list[dict]:
    def with_steps(*steps, **extra):
        return simple_rule(steps=list(steps), **extra)

    bad_dup = doc_rule()
    bad_dup["steps"][1]["steps"][0]["id"] = "l1"
    cases = [
        doc_rule(),
        simple_rule(),
        simple_rule(version=0),
        simple_rule(match={"urls": ["https://*.example.com/*"]}),
        simple_rule(match={"urls": ["https://*/*"]}),
        simple_rule(match={"urls": ["*://*/*"]}),
        simple_rule(match={"urls": ["<all_urls>"]}),
        simple_rule(match={"urls": ["https://*"]}),
        simple_rule(match={"urls": ["https://*example.com/*"]}),
        simple_rule(match={"urls": []}),
        simple_rule(match={"urls": ["https://example.com/*"], "exclude": ["*"]}),
        simple_rule(id=""),
        simple_rule(name=""),
        simple_rule(version=-1),
        simple_rule(version=1.5),
        simple_rule(trigger=None),
        simple_rule(extra={"x": "{{secret.y}}"}),
        bad_dup,
        with_steps(nest(3)),
        with_steps(nest(4)),
        with_steps({"id": "s1", "type": "open", "url": r"https://example.com/\{{secret.x}}"}),
        with_steps({"id": "s1", "type": "open", "url": "https://example.com/{{secret.x}}"}, requires={"secret": ["x"]}),
        with_steps({"id": "s1", "type": "fill", "target": LOC, "value": "{{secret.x}}"}, requires={"secret": ["x"]}),
        with_steps({"id": "s1", "type": "fill", "target": LOC, "value": "{{secret.x}}"}),
        with_steps({"id": "s1", "type": "fill", "target": LOC, "value": "{{ profile.a-b.c }}"}, requires={"profile": ["a-b.c"]}),
        with_steps({"id": "s1", "type": "fill", "target": LOC, "value": "{{profile.a}}"}),
        with_steps({"id": "s1", "type": "fill", "target": LOC, "value": "{{var.a}}"}),
        with_steps({"id": "s1", "type": "click", "target": {"strategies": [{"kind": "css", "value": "{{secret.k}}"}]}}, requires={"secret": ["k"]}),
        with_steps({"id": "s1", "type": "click", "target": LOC, "label": "{{secret.k}}"}),
        with_steps({"id": "s1", "type": "waitFor", "until": "condition"}),
        with_steps({"id": "s1", "type": "waitFor", "until": "delay"}),
        with_steps({"id": "s1", "type": "waitFor", "until": "delay", "delayMs": 10}),
        with_steps({"id": "s1", "type": "handoff", "message": "m", "resumeWhen": "condition"}),
        with_steps({"id": "s1", "type": "handoff", "message": "m", "resumeWhen": "condition", "until": COND}),
        with_steps({"id": "s1", "type": "teleport"}),
        with_steps({"id": "s1", "type": "check", "target": LOC}),
        with_steps({"id": "s1", "type": "assert", "condition": {"kind": "not", "condition": {"kind": "url", "pattern": "{{secret.z}}"}}}, requires={"secret": ["z"]}),
        simple_rule(login={"loggedIn": {"kind": "url", "pattern": "{{secret.q}}"}, "steps": [{"id": "l1", "type": "open", "url": "u"}]}),
        simple_rule(login={"loggedIn": COND, "steps": [{"id": "s1", "type": "open", "url": "u"}]}),
    ]
    return [copy.deepcopy(r) for r in cases]


def test_rule_corpus_has_both_outcomes():
    verdicts = [validate_rule(r) == [] for r in rule_corpus()]
    assert any(verdicts) and not all(verdicts)


def _vitest() -> str | None:
    if os.environ.get("PAGEPILOT_SKIP_NODE") == "1":
        return None
    binary = REPO_ROOT / "node_modules" / ".bin" / "vitest"
    if shutil.which("node") is None or not binary.exists():
        return None
    return str(binary)


def test_extension_zod_accepts_backend_output(make_client, tmp_path):
    vitest = _vitest()
    if vitest is None:
        pytest.skip("本机没有 node 或仓库根未安装依赖，跳过 Zod 校验")
    samples = {
        "downlink": collect_downlink(make_client),
        "rules": [{"rule": r, "ok": validate_rule(r) == []} for r in rule_corpus()],
    }
    path = tmp_path / "samples.json"
    path.write_text(json.dumps(samples, ensure_ascii=False), encoding="utf-8")
    proc = subprocess.run(
        [vitest, "run", "--config", "server/tests/zod/vitest.config.ts"],
        cwd=REPO_ROOT,
        env={**os.environ, "PAGEPILOT_SAMPLES": str(path), "CI": "1"},
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, proc.stdout[-4000:] + proc.stderr[-4000:]
    assert "2 passed" in proc.stdout, proc.stdout[-2000:]
