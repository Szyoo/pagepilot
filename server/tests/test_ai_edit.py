"""AI 修改：字面值换记号与还原、提案接口、自动修复、权限与错误码（用假客户端，不发网络请求）。"""

from __future__ import annotations

import asyncio
import copy
import json
import re

import pytest

from conftest import ADMIN, USER, USER2, poll, put_rule, simple_rule

from pagepilot_server import ai_edit
from pagepilot_server.ai import AiFailed, AiTimeout, Completion
from pagepilot_server.ai_edit import mask_rule_values, unmask_rule_values


def loc(value: str) -> dict:
    return {"strategies": [{"kind": "css", "value": value}]}


def edit_rule(rule_id: str = "r1", version: int = 1) -> dict:
    return {
        "id": rule_id,
        "name": "预约",
        "version": version,
        "match": {"urls": ["https://example.com/*"], "exclude": ["https://example.com/admin?x=1"]},
        "requires": {"profile": ["name"], "secret": ["pass"]},
        "login": {
            "loggedIn": {"kind": "url", "pattern": "https://example.com/home?tab=me"},
            "steps": [
                {"id": "l1", "type": "fill", "target": loc("#pass"), "value": "{{secret.pass}}"},
            ],
        },
        "steps": [
            {"id": "s1", "type": "open", "url": "https://example.com/book?token=abc&lang=ja#top", "note": "打开预约页"},
            {"id": "s2", "type": "fill", "target": loc("#email"), "value": "alice@example.com"},
            {"id": "s3", "type": "fill", "target": loc("#name"), "value": "{{profile.name}}"},
            {"id": "s4", "type": "fill", "target": loc("#email2"), "value": "alice@example.com"},
            {"id": "s5", "type": "select", "target": loc("#visa"), "value": "C-3"},
            {"id": "s6", "type": "if",
             "condition": {"kind": "all", "conditions": [
                 {"kind": "url", "pattern": "https://example.com/full?page=2*"},
                 {"kind": "element", "target": loc(".msg"), "text": "满员"},
             ]},
             "then": [{"id": "s6a", "type": "waitFor", "until": "navigation",
                       "urlPattern": "https://example.com/done?id=42*"}]},
            {"id": "s7", "type": "handoff", "message": "请确认后提交", "final": True},
        ],
    }


# ---------- 记号 ----------


def test_mask_replaces_literals_and_keeps_placeholders():
    rule = edit_rule()
    before = copy.deepcopy(rule)
    masked, table = mask_rule_values(rule)
    assert rule == before  # 不改原对象
    raw = json.dumps(masked, ensure_ascii=False)
    for leaked in ("alice@", "C-3", "token=abc", "lang=ja", "top", "id=42", "page=2", "x=1", "tab=me"):
        assert leaked not in raw, leaked
    s = masked["steps"]
    assert s[1]["value"] == "«值1»" and s[3]["value"] == "«值1»"  # 同一个值复用同一记号
    assert s[2]["value"] == "{{profile.name}}"
    assert s[4]["value"] == "«值2»"
    assert masked["login"]["steps"][0]["value"] == "{{secret.pass}}"
    url_token = s[0]["url"].removeprefix("https://example.com/book?")
    assert re.fullmatch(r"«参数\d+»", url_token)
    assert s[0]["note"] == "打开预约页" and masked["name"] == "预约"
    conds = s[5]["condition"]["conditions"]
    assert conds[0]["pattern"].startswith("https://example.com/full?«参数")
    assert conds[1]["text"] == "满员"
    assert s[5]["then"][0]["urlPattern"].startswith("https://example.com/done?«参数")
    assert s[6]["message"] == "请确认后提交"
    assert masked["match"]["urls"] == ["https://example.com/*"]
    assert masked["match"]["exclude"][0].startswith("https://example.com/admin?«参数")
    assert masked["login"]["loggedIn"]["pattern"].startswith("https://example.com/home?«参数")
    assert table["«值1»"] == "alice@example.com" and table["«值2»"] == "C-3"
    assert table[url_token] == "token=abc&lang=ja#top"
    assert len(table) == 2 + 5  # 两个值、五个网址参数


def test_mask_mixed_value_and_edge_cases():
    rule = simple_rule(steps=[
        {"id": "a", "type": "fill", "target": loc("#n"), "value": "Mr {{profile.name}}"},
        {"id": "b", "type": "fill", "target": loc("#m"), "value": " {{profile.name}} {{var.x}} "},
        {"id": "c", "type": "fill", "target": loc("#e"), "value": ""},
        {"id": "d", "type": "open", "url": "https://example.com/a?"},
        {"id": "e", "type": "open", "url": "https://example.com/a#frag"},
    ])
    masked, table = mask_rule_values(rule)
    s = masked["steps"]
    assert s[0]["value"] == "«值1»" and table["«值1»"] == "Mr {{profile.name}}"
    assert s[1]["value"] == " {{profile.name}} {{var.x}} "
    assert s[2]["value"] == ""
    assert s[3]["url"] == "https://example.com/a?"
    assert s[4]["url"] == "https://example.com/a#«参数1»" and table["«参数1»"] == "frag"
    assert mask_rule_values(None) == (None, {})


def test_unmask_roundtrip_and_moved_values():
    rule = edit_rule()
    masked, table = mask_rule_values(rule)
    restored, unknown = unmask_rule_values(masked, table)
    assert restored == rule and unknown == []
    # 模型把记号挪到新步骤、并新增了字面值
    masked["steps"].append({"id": "s8", "type": "fill", "target": loc("#x"), "value": "«值2»"})
    masked["steps"].append({"id": "s9", "type": "fill", "target": loc("#y"), "value": "新值"})
    restored, unknown = unmask_rule_values(masked, table)
    assert restored["steps"][-2]["value"] == "C-3" and restored["steps"][-1]["value"] == "新值"
    assert unknown == []


def test_unmask_reports_unknown_tokens():
    _, table = mask_rule_values(edit_rule())
    out, unknown = unmask_rule_values({"steps": [{"value": "«值9»"}, {"url": "https://example.com/?«参数7»"},
                                                 {"value": "«值9»"}]}, table)
    assert unknown == ["«值9»", "«参数7»"]
    assert out["steps"][0]["value"] == "«值9»"  # 原样留下


# ---------- 接口 ----------


class EditClient:
    """按顺序返回预设回答；回答可以是函数（参数为本次发送的文本）。"""

    model = "fake-model"

    def __init__(self, *replies, error: Exception | None = None, delay: float = 0) -> None:
        self.replies = list(replies)
        self.error = error
        self.delay = delay
        self.calls: list[str] = []

    async def complete(self, instructions: str, text: str, timeout: float) -> Completion:
        assert instructions == ai_edit.INSTRUCTIONS
        self.calls.append(text)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        reply = self.replies.pop(0)
        return Completion(reply(text) if callable(reply) else reply, "fake-model")


def sent_rule(text: str) -> dict:
    """从发送的文本里取出“当前规则”的 JSON。"""
    body = text.split("当前规则（JSON）：\n", 1)[1]
    return json.JSONDecoder().raw_decode(body)[0]


def answer(rule: dict, summary: str = "加了一步", changes: list | None = None) -> str:
    return "```json\n" + json.dumps({"rule": rule, "summary": summary, "changes": changes or ["在最后加了一步"]},
                                    ensure_ascii=False) + "\n```"


def add_step(text: str) -> str:
    rule = sent_rule(text)
    rule["steps"].insert(5, {"id": "s5a", "type": "click", "target": loc("#go"), "note": "点击前往"})
    return answer(rule)


def install(c, fake):
    c.app.state.ai_client = fake
    return fake


def stored_version(c, rule_id: str = "r1") -> int:
    return [x["rule"]["version"] for x in c.get("/api/rules", headers=USER).json() if x["rule"]["id"] == rule_id][0]


def test_ai_edit_returns_proposal_without_saving(client):
    assert put_rule(client, edit_rule(), USER).status_code == 200
    fake = install(client, EditClient(add_step))
    r = client.post("/api/rules/r1/ai-edit", json={"instruction": "第 5 步之后点击前往"}, headers=USER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["errors"] == [] and body["summary"] == "加了一步" and body["changes"] == ["在最后加了一步"]
    assert body["repaired"] is False
    rule = body["rule"]
    assert rule["id"] == "r1" and rule["version"] == 2
    assert [s["id"] for s in rule["steps"]][4:7] == ["s5", "s5a", "s6"]
    # 记号已还原
    assert rule["steps"][1]["value"] == "alice@example.com"
    assert rule["steps"][0]["url"] == "https://example.com/book?token=abc&lang=ja#top"
    # 发送的内容不含字面值，含修改要求
    assert "alice@" not in fake.calls[0] and "token=abc" not in fake.calls[0]
    assert "第 5 步之后点击前往" in fake.calls[0]
    assert stored_version(client) == 1  # 没有保存


def test_ai_edit_forces_id_and_version(client):
    put_rule(client, edit_rule(version=3), USER)

    def rename(text):
        rule = sent_rule(text)
        rule["id"], rule["version"], rule["name"] = "other", 99, "新名称"
        return answer(rule)

    install(client, EditClient(rename))
    body = client.post("/api/rules/r1/ai-edit", json={"instruction": "改名"}, headers=USER).json()
    assert body["rule"]["id"] == "r1" and body["rule"]["version"] == 4 and body["rule"]["name"] == "新名称"
    assert body["errors"] == []


def test_ai_edit_repairs_once(client):
    put_rule(client, edit_rule(), USER)

    def broken(text):
        rule = sent_rule(text)
        rule["steps"].append({"id": "s1", "type": "waitFor", "until": "delay"})  # id 重复、缺 delayMs
        return answer(rule)

    fake = install(client, EditClient(broken, add_step))
    body = client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER).json()
    assert body["errors"] == [] and body["repaired"] is True
    assert len(fake.calls) == 2
    repair = fake.calls[1]
    assert "没有通过校验" in repair and "步骤 id 重复：s1" in repair
    # 发回的上次输出仍是记号形式
    assert "alice@" not in repair and "«值1»" in repair


def test_ai_edit_two_failures_return_errors(client):
    put_rule(client, edit_rule(), USER)

    def broken(text):
        rule = sent_rule(text)
        rule["match"]["urls"] = ["<all_urls>"]
        return answer(rule)

    install(client, EditClient(broken, broken))
    r = client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER)
    assert r.status_code == 200
    assert any("匹配全部网站" in e for e in r.json()["errors"])


def test_ai_edit_unknown_token_is_error(client):
    put_rule(client, edit_rule(), USER)

    def token(text):
        rule = sent_rule(text)
        rule["steps"][1]["value"] = "«值9»"
        return answer(rule)

    install(client, EditClient(token, token))
    body = client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER).json()
    assert any("«值9»" in e for e in body["errors"])


def test_ai_edit_unparsable_then_ok(client):
    put_rule(client, edit_rule(), USER)
    fake = install(client, EditClient("抱歉", add_step))
    body = client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER).json()
    assert body["errors"] == [] and len(fake.calls) == 2
    install(client, EditClient("抱歉", "还是不行"))
    assert client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER).status_code == 502


def test_ai_edit_repair_call_fails_keeps_first(client):
    put_rule(client, edit_rule(), USER)

    class Flaky(EditClient):
        async def complete(self, instructions, text, timeout):
            if self.calls:
                self.calls.append(text)
                raise AiTimeout()
            return await super().complete(instructions, text, timeout)

    def broken(text):
        rule = sent_rule(text)
        rule["steps"].append({"id": "s1", "type": "click", "target": loc("#a")})
        return answer(rule)

    install(client, Flaky(broken))
    body = client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER).json()
    assert any("步骤 id 重复" in e for e in body["errors"])
    assert body["errors"][-1] == "自动修复失败：AI 响应超时"


def test_ai_edit_with_base(client):
    put_rule(client, edit_rule(), USER)
    base = edit_rule()
    base["name"] = "上一次的提案"
    base["version"] = 2
    fake = install(client, EditClient(add_step))
    body = client.post("/api/rules/r1/ai-edit", json={"instruction": "x", "base": base}, headers=USER).json()
    assert body["rule"]["name"] == "上一次的提案" and body["rule"]["version"] == 2
    assert sent_rule(fake.calls[0])["name"] == "上一次的提案"
    other = edit_rule("r2")
    r = client.post("/api/rules/r1/ai-edit", json={"instruction": "x", "base": other}, headers=USER)
    assert r.status_code == 422
    r = client.post("/api/rules/r1/ai-edit", json={"instruction": "x", "base": [1]}, headers=USER)
    assert r.status_code == 422


def test_ai_edit_permissions(client):
    client.get("/api/me", headers=USER)
    put_rule(client, edit_rule(), USER)
    install(client, EditClient(add_step, add_step, add_step))
    assert client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER2).status_code == 404
    assert client.post("/api/rules/nope/ai-edit", json={"instruction": "x"}, headers=USER).status_code == 404
    assert client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=ADMIN).status_code == 200
    # 被管理员共享后，普通用户所有者不能再修改
    assert put_rule(client, edit_rule(version=2), ADMIN, shared=True).status_code == 200
    assert client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER).status_code == 403
    assert client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=ADMIN).status_code == 200


def test_ai_edit_errors(make_client):
    c = make_client(ai_timeout=0.1)
    put_rule(c, edit_rule(), USER)
    assert c.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER).status_code == 503
    install(c, EditClient(delay=1))
    r = c.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER)
    assert r.status_code == 504 and r.json() == {"detail": "AI 响应超时"}
    install(c, EditClient(error=AiFailed()))
    assert c.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER).status_code == 502
    install(c, EditClient(error=RuntimeError("boom")))
    assert c.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER).status_code == 502


@pytest.mark.parametrize("instruction", [None, "", "   ", 3, "长" * 2001])
def test_ai_edit_instruction_validation(client, instruction):
    put_rule(client, edit_rule(), USER)
    fake = install(client, EditClient())
    r = client.post("/api/rules/r1/ai-edit", json={"instruction": instruction}, headers=USER)
    assert r.status_code == 422 and r.json()["errors"]
    assert fake.calls == []


def test_saving_proposal_pushes_event(client):
    put_rule(client, edit_rule(), USER)
    install(client, EditClient(add_step))
    proposal = client.post("/api/rules/r1/ai-edit", json={"instruction": "x"}, headers=USER).json()["rule"]
    before = poll(client, USER)
    since = before[-1]["seq"] if before else 0
    r = client.put("/api/rules/r1", json={"rule": proposal}, headers=USER)
    assert r.status_code == 200 and r.json()["rule"]["version"] == 2
    events = poll(client, USER, since)
    upserts = [m for m in events if m["kind"] == "ruleUpsert"]
    assert upserts and upserts[-1]["rule"]["version"] == 2
    assert any(s["id"] == "s5a" for s in upserts[-1]["rule"]["steps"])


def test_instructions_cover_key_constraints():
    text = ai_edit.INSTRUCTIONS
    for needle in ("{{secret.x}}", "requires", "3 层", "<all_urls>", "需要确认定位", "«值N»", '"changes"'):
        assert needle in text, needle
