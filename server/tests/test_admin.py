"""管理接口：列表/详情/删除、录制固化为规则、权限。"""

from __future__ import annotations

from conftest import ADMIN, USER, USER2, capture, put_rule, recording, run_report, simple_rule

UPLINK = "/api/ext/uplink"
URLS = ["https://example.com/*"]


def upload(c, m, headers=USER):
    assert c.post(UPLINK, json=m, headers=headers).status_code == 202


def test_recordings_list_detail_delete(client):
    upload(client, recording("rec-1"))
    upload(client, recording("rec-2"))
    rows = client.get("/api/recordings", headers=USER).json()
    assert [r["recordingId"] for r in rows] == ["rec-2", "rec-1"]
    assert set(rows[0]) == {"recordingId", "startedAt", "stepCount", "receivedAt", "ownerSub"}
    assert rows[0]["stepCount"] == 3
    assert len(client.get("/api/recordings?limit=1", headers=USER).json()) == 1
    detail = client.get("/api/recordings/rec-1", headers=USER).json()
    assert detail["recordingId"] == "rec-1" and len(detail["steps"]) == 3
    assert client.delete("/api/recordings/rec-1", headers=USER).status_code == 204
    assert client.get("/api/recordings/rec-1", headers=USER).status_code == 404
    assert client.delete("/api/recordings/rec-1", headers=USER).status_code == 404


def test_captures_admin_can_delete_any(client):
    m = capture()
    upload(client, m, USER2)
    assert client.delete(f"/api/captures/{m['id']}", headers=ADMIN).status_code == 204
    assert client.get("/api/captures", headers=USER2).json() == []


def test_runs_filter_order_and_limit(client):
    upload(client, run_report("run-a", "r1", started=1000))
    upload(client, run_report("run-b", "r2", started=2000))
    upload(client, run_report("run-c", "r1", started=3000))
    rows = client.get("/api/runs", headers=USER).json()
    assert [r["runId"] for r in rows] == ["run-c", "run-b", "run-a"]
    assert [r["runId"] for r in client.get("/api/runs?ruleId=r1", headers=USER).json()] == ["run-c", "run-a"]
    assert len(client.get("/api/runs?limit=1", headers=USER).json()) == 1
    assert {"runId", "ruleId", "ruleVersion", "status", "trigger", "inputMode", "startedAt", "endedAt"} <= set(rows[0])
    detail = client.get("/api/runs/run-a", headers=USER).json()
    assert detail["steps"][0]["stepId"] == "s1"
    assert client.get("/api/runs/nope", headers=USER).status_code == 404


def test_limit_bounds(client):
    for i in range(3):
        upload(client, run_report(f"run-{i}"))
    assert len(client.get("/api/runs?limit=0", headers=USER).json()) == 1
    assert len(client.get("/api/runs?limit=100000", headers=USER).json()) == 3


# ----- 录制固化为规则 -----


def test_recording_to_rule_only_needs_a_name(client):
    """只填名称：id 自动生成，匹配网站从录制里的页面地址推断，其余用默认值。"""
    upload(client, recording("rec-1"))
    r = client.post("/api/recordings/rec-1/rule", json={"name": "韩国签证预约"}, headers=USER)
    assert r.status_code == 200, r.text
    rule = r.json()["rule"]
    assert rule["name"] == "韩国签证预约"
    assert rule["id"].startswith("rule-") and len(rule["id"]) > len("rule-")
    assert rule["match"]["urls"] == ["https://example.com/*"]
    assert rule["trigger"] == "manual" and rule["inputMode"] == "auto"
    assert rule["version"] == 1
    # 同一份录制再生成一次，id 不重复
    again = client.post("/api/recordings/rec-1/rule", json={"name": "韩国签证预约"}, headers=USER).json()["rule"]
    assert again["id"] != rule["id"]


def test_auto_id_uses_english_name_as_prefix(client):
    upload(client, recording("rec-1"))
    rule = client.post("/api/recordings/rec-1/rule", json={"name": "Korea Visa 2026"}, headers=USER).json()["rule"]
    assert rule["id"].startswith("korea-visa-2026-")


def test_inferred_urls_cover_every_site_in_the_recording(client):
    steps = [
        {"id": "s1", "type": "open", "url": "https://a.example.com/start?token=x"},
        {"id": "s2", "type": "waitFor", "until": "navigation", "urlPattern": "https://b.example.com/pay*"},
        {"id": "s3", "type": "switchTab", "urlPattern": "https://a.example.com/other*"},
        {
            "id": "s4",
            "type": "if",
            "condition": {"kind": "url", "pattern": "https://ignored.example.com/*"},
            "then": [{"id": "s5", "type": "open", "url": "http://c.example.com/x"}],
        },
    ]
    upload(client, recording("rec-1", steps))
    rule = client.post("/api/recordings/rec-1/rule", json={"name": "多站点"}, headers=USER).json()["rule"]
    assert rule["match"]["urls"] == [
        "https://a.example.com/*",
        "https://b.example.com/*",
        "http://c.example.com/*",
    ]


def test_no_page_address_in_recording_asks_for_urls(client):
    steps = [{"id": "s1", "type": "click", "target": {"strategies": [{"kind": "css", "value": "#go"}]}}]
    upload(client, recording("rec-1", steps))
    r = client.post("/api/recordings/rec-1/rule", json={"name": "没有地址"}, headers=USER)
    assert r.status_code == 422
    assert any("匹配网址" in e for e in r.json()["errors"])
    ok = client.post("/api/recordings/rec-1/rule", json={"name": "手填", "urls": URLS}, headers=USER)
    assert ok.status_code == 200


def test_captcha_input_becomes_handoff_not_a_secret(client):
    """验证码输入框被录成 {{secret.x}} 时，生成规则会改成交还步骤，且不再要求保险库里有这条凭据。"""
    steps = [
        {"id": "s1", "type": "open", "url": "https://example.com/form"},
        {"id": "s2", "type": "fill", "target": {"strategies": [{"kind": "css", "value": "#pw"}]}, "value": "{{secret.password}}"},
        {"id": "s3", "type": "fill", "target": {"strategies": [{"kind": "css", "value": "#c"}]}, "value": "{{secret.captchaTxt2}}"},
        {"id": "s4", "type": "fill", "target": {"strategies": [{"kind": "css", "value": "#sms"}]}, "value": "{{secret.sms_code}}"},
        {
            "id": "s5",
            "type": "if",
            "condition": {"kind": "url", "pattern": "https://example.com/*"},
            "then": [
                {"id": "s6", "type": "fill", "target": {"strategies": [{"kind": "css", "value": "#c2"}]}, "value": "{{secret.verifyCode}}"}
            ],
        },
    ]
    upload(client, recording("rec-1", steps))
    r = client.post("/api/recordings/rec-1/rule", json={"name": "含验证码"}, headers=USER)
    assert r.status_code == 200, r.text
    rule = r.json()["rule"]
    kinds = {s["id"]: s["type"] for s in rule["steps"]}
    assert kinds == {"s1": "open", "s2": "fill", "s3": "handoff", "s4": "handoff", "s5": "if"}
    h = rule["steps"][2]
    assert "验证码" in h["message"]
    # 输入框填满（有 maxlength 时达到它，否则非空）就自动继续；定位器沿用录制里的
    assert h["resumeWhen"] == "condition"
    assert h["until"] == {"kind": "element", "target": steps[2]["target"], "filled": True}
    assert rule["steps"][4]["then"][0]["type"] == "handoff"
    # 真正的密码仍是凭据，验证码类不再出现在 requires 里
    assert rule["requires"] == {"profile": [], "secret": ["password"]}


def test_captcha_length_param_uses_min_length(client):
    """验证码实际位数与输入框 maxlength 不一致时，可以明确给出位数。"""
    steps = [
        {"id": "s1", "type": "open", "url": "https://example.com/form"},
        {"id": "s2", "type": "fill", "target": {"strategies": [{"kind": "css", "value": "#c"}]}, "value": "{{secret.captchaTxt2}}"},
    ]
    upload(client, recording("rec-1", steps))
    rule = client.post("/api/recordings/rec-1/rule", json={"name": "五位", "captchaLength": 5}, headers=USER).json()["rule"]
    until = rule["steps"][1]["until"]
    assert until == {"kind": "element", "target": steps[1]["target"], "minLength": 5}
    for bad in (0, 21, 2.5, "5", True):
        r = client.post("/api/recordings/rec-1/rule", json={"name": "x", "captchaLength": bad}, headers=USER)
        assert r.status_code == 422, bad


def test_blank_name_is_rejected(client):
    upload(client, recording("rec-1"))
    r = client.post("/api/recordings/rec-1/rule", json={"name": "  "}, headers=USER)
    assert r.status_code == 422


def test_recording_to_rule(client):
    upload(client, recording("rec-1"))
    body = {"id": "from-rec", "name": "录制生成", "urls": URLS, "trigger": "manual", "inputMode": "trusted"}
    r = client.post("/api/recordings/rec-1/rule", json=body, headers=USER)
    assert r.status_code == 200, r.text
    out = r.json()
    rule = out["rule"]
    assert rule["version"] == 1 and rule["inputMode"] == "trusted"
    assert rule["requires"] == {"profile": ["name"], "secret": ["pass"]}
    assert [s["id"] for s in rule["steps"]] == ["s1", "s2", "s3"]
    assert out["ownerSub"] == "sub-alice" and out["shared"] is False
    # 已有同 id 规则：版本 + 1
    r = client.post("/api/recordings/rec-1/rule", json={**body, "exclude": ["https://example.com/admin/*"]}, headers=USER)
    assert r.json()["rule"]["version"] == 2
    assert r.json()["rule"]["match"]["exclude"] == ["https://example.com/admin/*"]
    # 规则产生了事件
    [snap] = client.get("/api/ext/poll", headers=USER).json()["messages"]
    assert snap["rules"][0]["version"] == 2


def test_recording_to_rule_validation_errors(client):
    bad_steps = [
        {"id": "s1", "type": "open", "url": "https://example.com/?p={{secret.pw}}"},
    ]
    upload(client, recording("rec-bad", steps=bad_steps))
    r = client.post("/api/recordings/rec-bad/rule", json={"id": "x", "name": "x", "urls": URLS}, headers=USER)
    assert r.status_code == 422
    assert any("fill 步骤的 value" in e for e in r.json()["errors"])
    upload(client, recording("rec-1"))
    for body in (
        {"id": "x", "name": "x", "urls": ["<all_urls>"]},
        {"id": "x", "urls": URLS},
        {"id": "x", "name": "x", "urls": URLS, "trigger": "sometimes"},
    ):
        r = client.post("/api/recordings/rec-1/rule", json=body, headers=USER)
        assert r.status_code == 422, body
        assert r.json()["errors"]
    assert client.get("/api/rules", headers=USER).json() == []


def test_recording_to_rule_permissions(client):
    upload(client, recording("rec-1"))
    put_rule(client, simple_rule("taken"), USER2)
    # 同 id 规则属于别人 → 404
    r = client.post("/api/recordings/rec-1/rule", json={"id": "taken", "name": "x", "urls": URLS}, headers=USER)
    assert r.status_code == 404
    # 只有管理员能共享
    r = client.post("/api/recordings/rec-1/rule", json={"id": "x", "name": "x", "urls": URLS, "shared": True}, headers=USER)
    assert r.status_code == 403
    # 管理员可以用别人的录制生成共享规则
    r = client.post("/api/recordings/rec-1/rule", json={"id": "x", "name": "x", "urls": URLS, "shared": True}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["shared"] is True and r.json()["ownerSub"] == "sub-admin"


def test_put_rule_shared_must_be_bool(client):
    r = client.put("/api/rules/r1", json={"rule": simple_rule(), "shared": "yes"}, headers=ADMIN)
    assert r.status_code == 422


def test_put_rule_body_must_be_object(client):
    assert client.put("/api/rules/r1", json=[1], headers=ADMIN).status_code == 422
    r = client.put("/api/rules/r1", json={}, headers=ADMIN)
    assert r.status_code == 422 and r.json()["errors"]


def test_index_and_static(client, tmp_path):
    r = client.get("/", headers=USER)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert client.get("/missing.js", headers=USER).status_code == 404
    assert client.get("/..%2Fapp.py", headers=USER).status_code == 404
    assert client.get("/", headers={}).status_code == 401


def test_index_placeholder_when_missing(make_client, tmp_path):
    from fastapi.testclient import TestClient

    from pagepilot_server.app import create_app
    from conftest import make_config

    app = create_app(make_config(tmp_path / "other"), static_dir=tmp_path / "no-static")
    with TestClient(app) as c:
        r = c.get("/", headers=USER)
        assert r.status_code == 200 and "PagePilot" in r.text
