"""AI 解读：脱敏、兜底描述、回答解析、缓存、接口与权限（用假客户端，不发网络请求）。"""

from __future__ import annotations

import asyncio
import json

import pytest

from conftest import ADMIN, USER, USER2, put_rule, recording, simple_rule

from pagepilot_server import ai
from pagepilot_server.ai import AiFailed, AiTimeout, BridgeClient, Completion

UPLINK = "/api/ext/uplink"


def loc(*strategies: tuple[str, str]) -> dict:
    return {"strategies": [{"kind": k, "value": v} for k, v in strategies]}


class FakeClient:
    model = "fake-model"

    def __init__(self, reply=None, error: Exception | None = None, delay: float = 0) -> None:
        self.reply = reply
        self.error = error
        self.delay = delay
        self.calls: list[str] = []

    async def complete(self, instructions: str, text: str, timeout: float) -> Completion:
        self.calls.append(text)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        if self.reply is not None:
            return Completion(self.reply, "fake-model")
        ids = ai.step_ids(json.loads(text)["steps"])
        return Completion(json.dumps({"summary": "测试流程", "steps": [{"id": i, "text": f"描述{i}"} for i in ids]},
                                     ensure_ascii=False), "fake-model")


def upload(c, m, headers=USER):
    assert c.post(UPLINK, json=m, headers=headers).status_code == 202


def with_fake(c, fake: FakeClient | None = None) -> FakeClient:
    fake = fake or FakeClient()
    c.app.state.ai_client = fake
    return fake


def user_seq(c, sub: str) -> int:
    with c.app.state.db.tx() as conn:
        return conn.execute("SELECT seq FROM users WHERE sub = ?", (sub,)).fetchone()["seq"]


# ---------- 脱敏 ----------


def test_redact_steps_keeps_only_readable_parts():
    steps = [
        {"id": "s1", "type": "open", "url": "https://user:pw@example.com/book/form?token=abc#frag", "note": "私人备注"},
        {"id": "s2", "type": "click", "target": loc(
            ("xpath", "/html/body/div[3]/form/button"),
            ("css", "body > div:nth-child(3) > form > button.btn"),
            ("aria", 'button[name="提交 \\"申请\\""]'),
            ("text", "提交"),
        )},
        {"id": "s3", "type": "fill", "target": loc(("css", "#email"), ("testid", "email-input")),
         "value": "alice@example.com"},
        {"id": "s4", "type": "fill", "target": loc(("css", 'input[name="pw"]')), "value": "{{secret.pw}}"},
        {"id": "s5", "type": "fill", "value": "Mr {{profile.name}}", "target": loc(("css", "#n"))},
        {"id": "s6", "type": "select", "target": loc(("css", "#visa")), "value": "C-3"},
        {"id": "s7", "type": "check", "target": loc(("css", "#agree")), "checked": True},
        {"id": "s8", "type": "waitFor", "until": "navigation", "urlPattern": "https://example.com/done?id=42*"},
        {"id": "s9", "type": "switchTab", "urlPattern": "https://example.com/pay#x"},
        {"id": "s10", "type": "handoff", "message": "请输入验证码", "resumeWhen": "userConfirm"},
    ]
    out = ai.redact_steps(steps)
    raw = json.dumps(out, ensure_ascii=False)
    assert out[0] == {"id": "s1", "type": "open", "url": "https://example.com/book/form"}
    assert out[1] == {"id": "s2", "type": "click", "target": {"role": "button", "name": '提交 "申请"', "text": "提交"}}
    assert out[2]["target"] == {"id": "email", "testid": "email-input"}
    assert out[2]["value"] == "<用户输入，17 个字符>"
    assert out[3] == {"id": "s4", "type": "fill", "target": {"fieldName": "pw"}, "value": "{{secret.pw}}"}
    assert out[4]["value"] == "<用户输入，3 个字符>{{profile.name}}"
    assert out[5]["value"] == "C-3"
    assert out[6]["checked"] is True
    assert out[7]["urlPattern"] == "https://example.com/done" and out[7]["until"] == "navigation"
    assert out[8]["urlPattern"] == "https://example.com/pay"
    assert out[9]["message"] == "请输入验证码"
    for leaked in ("alice@", "token", "abc", "frag", "pw@", "nth-child", "/html/body", "私人备注", "id=42"):
        assert leaked not in raw, leaked


def test_redact_steps_nested_if_repeat():
    steps = [
        {"id": "r1", "type": "repeat", "until": {"kind": "element", "target": loc(("text", "可预约"))},
         "steps": [
             {"id": "i1", "type": "if",
              "condition": {"kind": "url", "pattern": "https://example.com/full?x=1"},
              "then": [{"id": "t1", "type": "fill", "target": loc(("css", "#q")), "value": "secret literal"}],
              "else": [{"id": "e1", "type": "click", "target": loc(("xpath", "//a[1]"))}]},
         ]},
    ]
    out = ai.redact_steps(steps)
    assert out[0]["until"] == {"kind": "element", "target": {"text": "可预约"}}
    inner = out[0]["steps"][0]
    assert inner["condition"] == {"kind": "url", "pattern": "https://example.com/full"}
    assert inner["then"][0]["value"] == "<用户输入，14 个字符>"
    assert inner["else"][0] == {"id": "e1", "type": "click"}
    assert ai.step_ids(out) == ["r1", "i1", "t1", "e1"]
    assert "secret literal" not in json.dumps(out)


def test_redact_empty_value_and_bad_input():
    assert ai.redact_steps(None) == []
    assert ai.redact_steps([1, "x", {"id": "a", "type": "fill", "value": ""}]) == [
        {"id": "a", "type": "fill", "value": ""}
    ]


def test_fallback_text():
    assert ai.fallback_text({"type": "click"}) == "点击按钮"
    assert ai.fallback_text({"type": "fill"}) == "填写输入框"
    assert ai.fallback_text({"type": "handoff"}) == "交还给你处理"
    assert ai.fallback_text({"type": "open"}) == "打开页面"
    assert ai.fallback_text({"type": "check", "checked": False}) == "取消勾选"
    assert ai.fallback_text({"type": "press", "key": "Enter"}) == "按下 Enter 键"
    assert ai.fallback_text({"type": "waitFor", "until": "navigation"}) == "等待页面跳转"
    assert ai.fallback_text({"type": "nope"}) == "执行一步操作"
    for t in ai._FALLBACK:  # noqa: SLF001
        assert len(ai.fallback_text({"type": t})) <= 15


# ---------- 解析 ----------

STEPS = [{"id": "a", "type": "click"}, {"id": "b", "type": "if", "then": [{"id": "c", "type": "fill"}]}]


def test_parse_reply_tolerates_fences_and_extra_text():
    reply = '好的，结果如下：\n```json\n{"summary": "登录", "steps": [{"id": "a", "text": "点击登录按钮"}]}\n```\n以上。'
    notes = ai.parse_reply(reply, STEPS)
    assert notes.summary == "登录"
    assert notes.steps == [
        {"id": "a", "text": "点击登录按钮"},
        {"id": "b", "text": "按页面情况分支处理"},
        {"id": "c", "text": "填写输入框"},
    ]
    assert notes.ai_ids == ["a"]


def test_parse_reply_drops_unknown_ids_and_clips():
    long = "很" * 60
    reply = json.dumps({"summary": "x", "steps": [
        {"id": "zzz", "text": "多余"}, {"id": "a", "text": long}, {"id": "b", "text": "  "}, {"id": "c", "text": 3},
    ]}, ensure_ascii=False)
    notes = ai.parse_reply(reply, STEPS)
    assert [s["id"] for s in notes.steps] == ["a", "b", "c"]
    assert len(notes.steps[0]["text"]) == ai.MAX_TEXT
    assert notes.ai_ids == ["a"]


def test_parse_reply_failures():
    with pytest.raises(AiFailed):
        ai.parse_reply("抱歉，我无法完成", STEPS)
    with pytest.raises(AiFailed):
        ai.parse_reply('{"steps": []}', STEPS)  # 什么都没有


def test_apply_notes_only_fills_empty():
    steps = [{"id": "a", "type": "click", "note": "我的备注"}, {"id": "b", "type": "if", "condition": {},
                                                               "then": [{"id": "c", "type": "click", "note": " "}]}]
    out, n = ai.apply_notes(steps, {"a": "新", "b": "分支", "c": "点击"})
    assert n == 2
    assert out[0]["note"] == "我的备注" and out[1]["note"] == "分支" and out[1]["then"][0]["note"] == "点击"
    assert "note" not in steps[1]  # 不改原对象


# ---------- 桥客户端（不发网络请求） ----------


def test_bridge_client_submit_and_poll(monkeypatch):
    client = BridgeClient("https://bridge.example.com", "tok", "m1", "pagepilot")
    calls: list[tuple[str, str, dict | None]] = []
    replies = iter([
        (201, {"task_id": "t1", "status": "queued"}),
        (200, {"task_id": "t1", "status": "running"}),
        (200, {"task_id": "t1", "status": "done", "text": "{}", "model": "m1-real"}),
    ])

    def fake_call(method, path, body, timeout):
        calls.append((method, path, body))
        return next(replies)

    monkeypatch.setattr(client, "_call", fake_call)
    result = client._run("说明", "输入", 30)  # noqa: SLF001
    assert result == Completion("{}", "m1-real")
    assert calls[0][0:2] == ("POST", "/tasks")
    assert calls[0][2]["scope"] == "pagepilot" and calls[0][2]["options"]["model"] == "m1"
    assert calls[0][2]["options"]["instructions"] == "说明" and calls[0][2]["text"] == "输入"
    assert calls[1][1].startswith("/tasks/t1?wait=")


@pytest.mark.parametrize(("status", "body", "error"), [
    (503, {"error_kind": "offline"}, AiFailed),
    (429, {"error_kind": "busy"}, AiFailed),
    (401, {"detail": "调用方令牌无效"}, AiFailed),
])
def test_bridge_client_submit_errors(monkeypatch, status, body, error):
    client = BridgeClient("https://bridge.example.com", "tok", "m1", "s")
    monkeypatch.setattr(client, "_call", lambda *a: (status, body))
    with pytest.raises(error):
        client._run("i", "t", 30)  # noqa: SLF001


def test_bridge_client_task_timeout_kind(monkeypatch):
    client = BridgeClient("https://bridge.example.com", "tok", "m1", "s")
    replies = iter([(201, {"task_id": "t1"}), (200, {"status": "cancelled", "error_kind": "timeout"})])
    monkeypatch.setattr(client, "_call", lambda *a: next(replies))
    with pytest.raises(AiTimeout):
        client._run("i", "t", 30)  # noqa: SLF001


# ---------- 接口 ----------


def test_status_unconfigured_and_configured(make_client):
    c = make_client()
    assert c.get("/api/ai/status", headers=USER).json() == {
        "available": False,
        "model": None,
        "bridgeUrl": None,
        "scope": "pagepilot",
    }
    c2 = make_client(bridge_url="https://bridge.example.com", bridge_token="tok")
    st = c2.get("/api/ai/status", headers=USER).json()
    assert st["available"] is True and st["model"] == "claude-haiku-5-5"


def test_describe_unconfigured_503(client):
    upload(client, recording("rec-1"))
    r = client.post("/api/recordings/rec-1/describe", headers=USER)
    assert r.status_code == 503 and r.json() == {"detail": "AI 未配置"}


def test_describe_bridge_failure_502(client):
    upload(client, recording("rec-1"))
    with_fake(client, FakeClient(error=AiFailed()))
    r = client.post("/api/recordings/rec-1/describe", headers=USER)
    assert r.status_code == 502 and r.json() == {"detail": "AI 解读失败"}
    with_fake(client, FakeClient(reply="不是 JSON"))
    assert client.post("/api/recordings/rec-1/describe", headers=USER).status_code == 502
    with_fake(client, FakeClient(error=RuntimeError("boom")))
    assert client.post("/api/recordings/rec-1/describe", headers=USER).status_code == 502


def test_describe_timeout_504(make_client):
    c = make_client(ai_timeout=0.1)
    upload(c, recording("rec-1"))
    with_fake(c, FakeClient(delay=1))
    r = c.post("/api/recordings/rec-1/describe", headers=USER)
    assert r.status_code == 504 and r.json() == {"detail": "AI 响应超时"}


def test_describe_recording_and_cache(client):
    upload(client, recording("rec-1"))
    fake = with_fake(client)
    r = client.post("/api/recordings/rec-1/describe", headers=USER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summary"] == "测试流程" and body["cached"] is False and body["model"] == "fake-model"
    assert body["steps"] == [{"id": f"s{i}", "text": f"描述s{i}"} for i in (1, 2, 3)]
    assert isinstance(body["createdAt"], int)
    # 发出的内容已脱敏
    assert json.loads(fake.calls[0])["steps"][2]["value"] == "{{secret.pass}}"
    # 再请求一次命中缓存
    again = client.post("/api/recordings/rec-1/describe", headers=USER).json()
    assert again["cached"] is True and len(fake.calls) == 1
    # 详情带 ai 字段
    detail = client.get("/api/recordings/rec-1", headers=USER).json()
    assert detail["ai"] == {k: body[k] for k in ("summary", "steps", "model", "createdAt")}
    # refresh=1 强制重新生成
    assert client.post("/api/recordings/rec-1/describe?refresh=1", headers=USER).json()["cached"] is False
    assert len(fake.calls) == 2


def test_cache_invalidated_when_digest_changes(client):
    upload(client, recording("rec-1"))
    fake = with_fake(client)
    client.post("/api/recordings/rec-1/describe", headers=USER)
    with client.app.state.db.tx() as conn:
        conn.execute("UPDATE ai_notes SET digest = 'stale'")
    assert client.post("/api/recordings/rec-1/describe", headers=USER).json()["cached"] is False
    assert len(fake.calls) == 2


def test_detail_without_cache_has_no_ai(client):
    upload(client, recording("rec-1"))
    assert "ai" not in client.get("/api/recordings/rec-1", headers=USER).json()


def test_describe_permissions(client):
    upload(client, recording("rec-1"), USER)
    with_fake(client)
    assert client.post("/api/recordings/rec-1/describe", headers=USER2).status_code == 404
    assert client.post("/api/recordings/rec-1/describe", headers=ADMIN).status_code == 200
    put_rule(client, simple_rule("r1"), USER)
    assert client.post("/api/rules/r1/describe", headers=USER2).status_code == 404
    assert client.post("/api/rules/nope/describe", headers=USER).status_code == 404


def test_delete_recording_removes_note(client):
    upload(client, recording("rec-1"))
    with_fake(client)
    client.post("/api/recordings/rec-1/describe", headers=USER)
    assert client.delete("/api/recordings/rec-1", headers=USER).status_code == 204
    with client.app.state.db.tx() as conn:
        assert conn.execute("SELECT COUNT(*) FROM ai_notes").fetchone()[0] == 0


def test_purge_removes_orphan_notes(client):
    from pagepilot_server.retention import purge

    upload(client, recording("rec-1"))
    with_fake(client)
    client.post("/api/recordings/rec-1/describe", headers=USER)
    with client.app.state.db.tx() as conn:
        conn.execute("UPDATE recordings SET received_at = 0")
    result = purge(client.app.state.db, 30)
    assert result["recordings"] == 1 and result["ai_notes"] == 1


def test_recording_to_rule_uses_cached_notes(client):
    upload(client, recording("rec-1"))
    fake = with_fake(client, FakeClient(reply=json.dumps(
        {"summary": "x", "steps": [{"id": "s1", "text": "打开表单页"}, {"id": "s2", "text": "填写姓名"}]},
        ensure_ascii=False)))
    client.post("/api/recordings/rec-1/describe", headers=USER)
    rule = client.post("/api/recordings/rec-1/rule", json={"name": "表单"}, headers=USER).json()["rule"]
    assert [s.get("note") for s in rule["steps"]] == ["打开表单页", "填写姓名", None]  # s3 是兜底描述，不写入
    assert len(fake.calls) == 1


def test_recording_to_rule_without_cache_does_not_call_ai(client):
    upload(client, recording("rec-1"))
    fake = with_fake(client)
    rule = client.post("/api/recordings/rec-1/rule", json={"name": "表单"}, headers=USER).json()["rule"]
    assert all("note" not in s for s in rule["steps"])
    assert fake.calls == []


def test_describe_rule_saves_new_version_and_pushes(client):
    rule = simple_rule("r1", login={
        "loggedIn": {"kind": "element", "target": loc(("testid", "me"))},
        "steps": [{"id": "l1", "type": "click", "target": loc(("text", "登录"))}],
    }, steps=[
        {"id": "s1", "type": "open", "url": "https://example.com/"},
        {"id": "s2", "type": "click", "target": loc(("css", "#go")), "note": "原有备注"},
        {"id": "s3", "type": "repeat", "until": {"kind": "url", "pattern": "https://example.com/ok"},
         "steps": [{"id": "s4", "type": "click", "target": loc(("css", "#retry"))}]},
    ])
    assert put_rule(client, rule, USER).status_code == 200
    fake = with_fake(client)
    seq = user_seq(client, "sub-alice")
    r = client.post("/api/rules/r1/describe", headers=USER)
    assert r.status_code == 200, r.text
    body = r.json()
    new = body["rule"]
    assert body["summary"] == "测试流程" and body["added"] == 4
    assert new["version"] == 2
    assert new["login"]["steps"][0]["note"] == "描述l1"
    assert [s.get("note") for s in new["steps"]] == ["描述s1", "原有备注", "描述s3"]
    assert new["steps"][2]["steps"][0]["note"] == "描述s4"
    assert user_seq(client, "sub-alice") == seq + 1
    assert [x["rule"]["version"] for x in client.get("/api/rules", headers=USER).json()] == [2]
    assert [s["id"] for s in json.loads(fake.calls[0])["steps"]] == ["l1", "s1", "s2", "s3"]
    # 再来一次：缓存命中、没有空 note 可填，不产生新版本
    again = client.post("/api/rules/r1/describe", headers=USER).json()
    assert again["added"] == 0 and again["cached"] is True and again["rule"]["version"] == 2
    assert user_seq(client, "sub-alice") == seq + 1 and len(fake.calls) == 1


def test_describe_shared_rule_admin_only(client):
    client.get("/api/me", headers=USER)
    assert put_rule(client, simple_rule("shared-1"), ADMIN, shared=True).status_code == 200
    with_fake(client)
    assert client.post("/api/rules/shared-1/describe", headers=USER).status_code == 404
    r = client.post("/api/rules/shared-1/describe", headers=ADMIN)
    assert r.status_code == 200 and r.json()["rule"]["version"] == 2
    # 所有者是普通用户、但已被管理员共享的规则：所有者也不能做
    put_rule(client, simple_rule("mine"), USER)
    assert put_rule(client, simple_rule("mine", version=2), ADMIN, shared=True).status_code == 200
    assert client.post("/api/rules/mine/describe", headers=USER).status_code == 403


def test_describe_rule_errors(client):
    put_rule(client, simple_rule("r1"), USER)
    assert client.post("/api/rules/r1/describe", headers=USER).status_code == 503
    with_fake(client, FakeClient(error=AiTimeout()))
    assert client.post("/api/rules/r1/describe", headers=USER).status_code == 504


def test_describe_recording_uses_converted_steps(client):
    """解读对生成规则时会得到的步骤做：验证码类输入已是交还，且字面值不会发出去。"""
    fake = with_fake(client)
    steps = [
        {"id": "s1", "type": "open", "url": "https://example.com/login"},
        {
            "id": "s2",
            "type": "fill",
            "target": {"strategies": [{"kind": "aria", "value": 'textbox[name="Enter verification number"]'}]},
            "value": "12345",
        },
    ]
    upload(client, recording("rec-v", steps))
    assert client.post("/api/recordings/rec-v/describe", headers=USER).status_code == 200
    sent = json.loads(fake.calls[0])["steps"]
    assert [s["type"] for s in sent] == ["open", "handoff"]
    assert "12345" not in fake.calls[0]


def test_status_reports_public_bridge_url(make_client):
    c = make_client(bridge_url="http://bridge.internal:8770", bridge_token="tok", bridge_public_url="https://bridge.example.com/api")
    st = c.get("/api/ai/status", headers=USER).json()
    assert st["available"] is True
    assert st["bridgeUrl"] == "https://bridge.example.com/api"
    assert st["scope"] == "pagepilot"
    assert make_client().get("/api/ai/status", headers=USER).json()["bridgeUrl"] is None

