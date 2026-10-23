"""规则校验：与 src/schema/rule.ts 的约束一致。"""

from __future__ import annotations

import pytest
from conftest import ADMIN, USER, doc_rule, simple_rule

from pagepilot_server.rules import extract_placeholders, is_match_all, required_placeholders, validate_rule

LOC = {"strategies": [{"kind": "css", "value": "#x"}]}
COND = {"kind": "element", "target": LOC}


def errors_of(rule: dict) -> list[str]:
    return validate_rule(rule)


def assert_rejected(rule: dict, fragment: str) -> None:
    errors = errors_of(rule)
    assert errors, "应被拒绝"
    assert any(fragment in e for e in errors), errors


def test_doc_example_passes():
    assert errors_of(doc_rule()) == []


def test_minimal_rule_passes():
    assert errors_of(simple_rule()) == []


# ----- 必填与类型 -----


@pytest.mark.parametrize("field", ["id", "name", "version", "match", "steps"])
def test_required_fields(field):
    rule = simple_rule()
    del rule[field]
    assert_rejected(rule, f"{field}: 必填")


@pytest.mark.parametrize(
    "patch,fragment",
    [
        ({"id": ""}, "id: 不能为空"),
        ({"id": 1}, "id: 需要字符串"),
        ({"name": None}, "name: 需要字符串"),
        ({"version": -1}, "version: 不能小于 0"),
        ({"version": 1.5}, "version: 需要整数"),
        ({"version": True}, "version: 需要数字"),
        ({"version": "1"}, "version: 需要数字"),
        ({"match": {"urls": []}}, "match.urls: 至少需要 1 项"),
        ({"match": {"urls": [""]}}, "match.urls.0: 不能为空"),
        ({"match": {}}, "match.urls: 必填"),
        ({"steps": []}, "steps: 至少需要 1 项"),
        ({"trigger": "always"}, "trigger: 取值必须是"),
        ({"inputMode": "fast"}, "inputMode: 取值必须是"),
        ({"enabled": "yes"}, "enabled: 需要布尔值"),
        ({"requires": {"profile": "name"}}, "requires.profile: 需要数组"),
        ({"login": {"steps": [{"id": "l1", "type": "open", "url": "u"}]}}, "login.loggedIn: 必填"),
        ({"login": {"loggedIn": COND, "steps": []}}, "login.steps: 至少需要 1 项"),
    ],
)
def test_field_types(patch, fragment):
    assert_rejected(simple_rule(**patch), fragment)


def test_optional_field_cannot_be_null():
    # Zod 的 optional 只接受缺省，不接受 null
    assert_rejected(simple_rule(trigger=None), "trigger")


def test_version_zero_and_integral_float_pass():
    assert errors_of(simple_rule(version=0)) == []
    assert errors_of(simple_rule(version=2.0)) == []


def test_unknown_top_level_fields_are_ignored():
    assert errors_of(simple_rule(extra={"anything": "{{secret.x}}"})) == []


# ----- 步骤 -----


def step_rule(*steps: dict, **extra) -> dict:
    return simple_rule(steps=list(steps), **extra)


def test_unknown_step_type():
    assert_rejected(step_rule({"id": "s1", "type": "teleport"}), "未知的步骤类型")
    assert_rejected(step_rule({"id": "s1"}), "缺少步骤类型")


@pytest.mark.parametrize(
    "step,fragment",
    [
        ({"id": "", "type": "open", "url": "u"}, "steps.0.id: 不能为空"),
        ({"id": "s", "type": "open"}, "steps.0.url: 必填"),
        ({"id": "s", "type": "click"}, "steps.0.target: 必填"),
        ({"id": "s", "type": "click", "target": {"strategies": []}}, "strategies: 至少需要 1 项"),
        ({"id": "s", "type": "click", "target": {"strategies": [{"kind": "id", "value": "x"}]}}, "kind: 取值必须是"),
        ({"id": "s", "type": "click", "target": {"strategies": [{"kind": "css", "value": ""}]}}, "value: 不能为空"),
        ({"id": "s", "type": "fill", "target": LOC}, "steps.0.value: 必填"),
        ({"id": "s", "type": "check", "target": LOC}, "steps.0.checked: 必填"),
        ({"id": "s", "type": "press", "key": ""}, "steps.0.key: 不能为空"),
        ({"id": "s", "type": "waitFor", "until": "forever"}, "steps.0.until: 取值必须是"),
        ({"id": "s", "type": "waitFor", "until": "delay", "delayMs": 0}, "steps.0.delayMs: 需要正整数"),
        ({"id": "s", "type": "switchTab", "urlPattern": ""}, "urlPattern: 不能为空"),
        ({"id": "s", "type": "handoff"}, "steps.0.message: 必填"),
        ({"id": "s", "type": "assert", "condition": {"kind": "magic"}}, "condition.kind: 取值必须是"),
        ({"id": "s", "type": "assert", "condition": {"kind": "url", "pattern": ""}}, "pattern: 不能为空"),
        ({"id": "s", "type": "assert", "condition": {"kind": "all", "conditions": []}}, "conditions: 至少需要 1 项"),
        ({"id": "s", "type": "extract", "target": LOC, "saveAs": ""}, "saveAs: 不能为空"),
        ({"id": "s", "type": "if", "condition": COND, "then": []}, "then: 至少需要 1 项"),
        ({"id": "s", "type": "repeat", "until": COND, "steps": []}, "steps.0.steps: 至少需要 1 项"),
        ({"id": "s", "type": "repeat", "until": COND, "steps": [{"id": "a", "type": "waitFor", "until": "idle"}],
          "onExhausted": "retry"}, "onExhausted: 取值必须是"),
        ({"id": "s", "type": "open", "url": "u", "timeoutMs": 0}, "timeoutMs: 需要正整数"),
        ({"id": "s", "type": "open", "url": "u", "retries": -1}, "retries: 不能小于 0"),
    ],
)
def test_step_fields(step, fragment):
    assert_rejected(step_rule(step), fragment)


# ----- superRefine 的每一条约束 -----


@pytest.mark.parametrize("url", ["<all_urls>", "*", "*://*/*", "https://*/*", "http://*/*", "http*://*/*", "https://*"])
def test_match_all_rejected(url):
    assert is_match_all(url)
    assert_rejected(simple_rule(match={"urls": ["https://example.com/*", url]}), "match.urls.1: match.urls 不允许匹配全部网站")


@pytest.mark.parametrize("url", ["https://*.example.com/*", "https://example.com/*", "*://example.com/*", "https://*example.com/*"])
def test_wildcard_subdomain_allowed(url):
    assert not is_match_all(url)
    assert errors_of(simple_rule(match={"urls": [url]})) == []


def test_exclude_may_match_all():
    # 与扩展一致：只限制 urls
    assert errors_of(simple_rule(match={"urls": ["https://example.com/*"], "exclude": ["*"]})) == []


def test_duplicate_step_ids_top_level():
    rule = step_rule({"id": "s1", "type": "open", "url": "u"}, {"id": "s1", "type": "open", "url": "u"})
    assert_rejected(rule, "steps.1.id: 步骤 id 重复：s1")


def test_duplicate_step_ids_across_login_and_nested():
    rule = doc_rule()
    rule["steps"][1]["steps"][0]["id"] = "l1"  # repeat 里的子步骤与登录步骤重名
    assert_rejected(rule, "步骤 id 重复：l1")


def nest(depth: int) -> dict:
    step: dict = {"id": f"leaf{depth}", "type": "waitFor", "until": "idle"}
    for i in range(depth):
        if i % 2 == 0:
            step = {"id": f"if{i}", "type": "if", "condition": COND, "then": [step]}
        else:
            step = {"id": f"rp{i}", "type": "repeat", "until": COND, "steps": [step]}
    return step


def test_nesting_three_levels_ok():
    assert errors_of(step_rule(nest(3))) == []


def test_nesting_fourth_level_rejected():
    assert_rejected(step_rule(nest(4)), "嵌套超过 3 层")


def test_nesting_in_else_counts():
    inner = nest(3)
    rule = step_rule({"id": "top", "type": "if", "condition": COND, "then": [{"id": "t", "type": "waitFor", "until": "idle"}], "else": [inner]})
    assert_rejected(rule, "嵌套超过 3 层")


def test_nesting_in_login_counts():
    rule = simple_rule(login={"loggedIn": COND, "steps": [nest(4)]})
    assert_rejected(rule, "嵌套超过 3 层")


def test_secret_only_in_fill_value():
    rule = step_rule(
        {"id": "s1", "type": "open", "url": "https://example.com/?u={{secret.user}}"},
        requires={"secret": ["user"]},
    )
    assert_rejected(rule, "steps.0.url: {{secret.x}} 只能出现在 fill 步骤的 value 中")


def test_secret_in_select_value_rejected():
    rule = step_rule({"id": "s1", "type": "select", "target": LOC, "value": "{{secret.x}}"}, requires={"secret": ["x"]})
    assert_rejected(rule, "{{secret.x}} 只能出现在 fill 步骤的 value 中")


def test_secret_in_locator_and_condition_rejected():
    loc = {"strategies": [{"kind": "css", "value": "#{{secret.x}}"}]}
    rule = step_rule({"id": "s1", "type": "fill", "target": loc, "value": "v"}, requires={"secret": ["x"]})
    assert_rejected(rule, "steps.0.target: {{secret.x}}")
    cond = {"kind": "not", "condition": {"kind": "url", "pattern": "{{ secret.x }}"}}
    rule = step_rule({"id": "s1", "type": "assert", "condition": cond}, requires={"secret": ["x"]})
    assert_rejected(rule, "steps.0.condition: {{secret.x}}")


def test_secret_in_fill_value_ok():
    rule = step_rule({"id": "s1", "type": "fill", "target": LOC, "value": "{{secret.pw}}"}, requires={"secret": ["pw"]})
    assert errors_of(rule) == []


def test_requires_must_cover_profile_and_secret():
    rule = step_rule(
        {"id": "s1", "type": "fill", "target": LOC, "value": "{{profile.name}} {{secret.pw}}"},
    )
    errors = errors_of(rule)
    assert "requires: requires.profile 缺少 name" in errors
    assert "requires: requires.secret 缺少 pw" in errors


def test_requires_profile_found_anywhere():
    rule = step_rule({"id": "s1", "type": "open", "url": "https://example.com/{{profile.city}}"})
    assert_rejected(rule, "requires.profile 缺少 city")


def test_var_placeholders_need_nothing():
    rule = step_rule({"id": "s1", "type": "open", "url": "https://example.com/{{var.page}}"})
    assert errors_of(rule) == []


def test_escaped_placeholder_is_not_placeholder():
    assert extract_placeholders(r"\{{secret.x}}") == []
    assert extract_placeholders(r"\{{secret.x}} {{secret.y}}") == [("secret", "y")]
    rule = step_rule({"id": "s1", "type": "open", "url": r"https://example.com/\{{secret.x}}"})
    assert errors_of(rule) == []


def test_unknown_step_fields_not_scanned():
    # Zod 解析后去掉未知字段，superRefine 看不到它们
    rule = step_rule({"id": "s1", "type": "click", "target": LOC, "label": "{{secret.x}}"})
    assert errors_of(rule) == []


def test_login_logged_in_condition_not_scanned():
    rule = simple_rule(login={"loggedIn": {"kind": "url", "pattern": "{{profile.x}}"}, "steps": [{"id": "l1", "type": "open", "url": "u"}]})
    assert errors_of(rule) == []


def test_wait_for_condition_requires_condition():
    assert_rejected(step_rule({"id": "s1", "type": "waitFor", "until": "condition"}), "waitFor(condition) 需要 condition")
    assert errors_of(step_rule({"id": "s1", "type": "waitFor", "until": "condition", "condition": COND})) == []


def test_wait_for_delay_requires_delay_ms():
    assert_rejected(step_rule({"id": "s1", "type": "waitFor", "until": "delay"}), "waitFor(delay) 需要 delayMs")
    assert errors_of(step_rule({"id": "s1", "type": "waitFor", "until": "delay", "delayMs": 500})) == []


def test_handoff_condition_requires_until():
    assert_rejected(step_rule({"id": "s1", "type": "handoff", "message": "m", "resumeWhen": "condition"}), "handoff(condition) 需要 until")
    ok = {"id": "s1", "type": "handoff", "message": "m", "resumeWhen": "condition", "until": COND}
    assert errors_of(step_rule(ok)) == []
    assert errors_of(step_rule({"id": "s1", "type": "handoff", "message": "m"})) == []


def test_structural_errors_skip_semantic_checks():
    # 与 Zod 一致：结构错误时不报 superRefine 的问题
    rule = step_rule({"id": "s1", "type": "open"}, {"id": "s1", "type": "open", "url": "u"})
    errors = errors_of(rule)
    assert errors == ["steps.0.url: 必填"]


def test_required_placeholders_in_order():
    steps = [
        {"id": "a", "type": "fill", "target": LOC, "value": "{{profile.b}}{{profile.a}}"},
        {"id": "b", "type": "if", "condition": COND, "then": [{"id": "c", "type": "fill", "target": LOC, "value": "{{secret.s}}{{var.v}}{{profile.b}}"}]},
    ]
    assert required_placeholders(steps) == {"profile": ["b", "a"], "secret": ["s"]}


# ----- 接口 -----


def test_validate_endpoint(client):
    r = client.post("/api/rules/validate", json={"rule": doc_rule()}, headers=USER)
    assert r.json() == {"ok": True, "errors": []}
    r = client.post("/api/rules/validate", json={"rule": simple_rule(match={"urls": ["https://*/*"]})}, headers=USER)
    body = r.json()
    assert body["ok"] is False and any("全部网站" in e for e in body["errors"])
    r = client.post("/api/rules/validate", json={}, headers=USER)
    assert r.json()["ok"] is False
    # 不保存
    assert client.get("/api/rules", headers=USER).json() == []


def test_put_rejects_invalid_rule(client):
    r = client.put("/api/rules/r1", json={"rule": simple_rule(match={"urls": ["*"]})}, headers=ADMIN)
    assert r.status_code == 422
    assert any("全部网站" in e for e in r.json()["errors"])


def test_put_rejects_id_mismatch(client):
    r = client.put("/api/rules/other", json={"rule": simple_rule("r1")}, headers=ADMIN)
    assert r.status_code == 422


def test_element_condition_accepts_filled():
    rule = simple_rule(
        steps=[
            {
                "id": "h",
                "type": "handoff",
                "message": "请输入验证码",
                "resumeWhen": "condition",
                "until": {
                    "kind": "element",
                    "target": {"strategies": [{"kind": "css", "value": "#c"}]},
                    "filled": True,
                },
            }
        ]
    )
    assert validate_rule(rule) == []
    rule["steps"][0]["until"]["filled"] = "yes"
    assert validate_rule(rule)
