"""身份与攻击测试。

说明：真实部署中，门卫（反向代理）会剥掉客户端发来的 X-Portal-Sub / X-Role 再注入真头，
且容器不对外发布端口；“伪造身份头 + 任意 Authorization 头，结果不得为 200”的门卫层测试属于
部署验证，要在部署环境里对外网地址执行。这里只能证明应用层的保证：
- SSO 未开时一律 503（即使请求自带身份头）；
- 没有 X-Portal-Sub 一律 401（Authorization 头不会被当作身份）；
- X-Role 只有 admin 才算管理员；普通用户拿不到管理员能力。
"""

from __future__ import annotations

import pytest
from conftest import ADMIN, USER, USER2, capture, put_rule, recording, run_report, simple_rule

FORGED = {"X-Portal-Sub": "sub-admin", "X-Role": "admin", "Authorization": "Bearer x"}

GETS = [
    "/api/me",
    "/api/rules",
    "/api/recordings",
    "/api/recordings/x",
    "/api/captures",
    "/api/captures/x",
    "/api/runs",
    "/api/runs/x",
    "/api/ext/poll",
    "/api/ext/stream",
    "/",
    "/app.js",
]


def test_health_is_public(make_client):
    c = make_client(sso=False)
    r = c.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True}


@pytest.mark.parametrize("path", GETS)
def test_sso_off_is_503_even_with_forged_headers(make_client, path):
    c = make_client(sso=False)
    r = c.get(path, headers=FORGED)
    assert r.status_code == 503


def test_sso_off_writes_are_503(make_client):
    c = make_client(sso=False)
    assert c.put("/api/rules/r1", json={"rule": simple_rule()}, headers=FORGED).status_code == 503
    assert c.delete("/api/rules/r1", headers=FORGED).status_code == 503
    assert c.post("/api/rules/validate", json={"rule": {}}, headers=FORGED).status_code == 503
    assert c.post("/api/ext/uplink", json=capture(), headers=FORGED).status_code == 503


@pytest.mark.parametrize("path", GETS)
def test_missing_sub_is_401(client, path):
    r = client.get(path, headers={"X-Role": "admin", "Authorization": "Bearer x"})
    assert r.status_code == 401


def test_authorization_header_alone_is_not_identity(client):
    r = client.post("/api/ext/uplink", json=capture(), headers={"Authorization": "Bearer x"})
    assert r.status_code == 401
    assert client.get("/api/me", headers={"X-Portal-Sub": "  "}).status_code == 401


def test_role_only_admin_counts(client):
    assert client.get("/api/me", headers=ADMIN).json() == {"sub": "sub-admin", "role": "admin"}
    assert client.get("/api/me", headers=USER).json() == {"sub": "sub-alice", "role": "user"}
    for role in ("superuser", "Administrator", "root", ""):
        me = client.get("/api/me", headers={"X-Portal-Sub": "s", "X-Role": role}).json()
        assert me["role"] == "user"
    assert client.get("/api/me", headers={"X-Portal-Sub": "s", "X-Role": "ADMIN"}).json()["role"] == "admin"


def test_users_are_registered(client):
    client.get("/api/me", headers=USER)
    client.get("/api/rules", headers=USER2)
    db = client.app.state.db
    with db.tx() as c:
        rows = {r["sub"]: r["role"] for r in c.execute("SELECT sub, role FROM users")}
    assert rows == {"sub-alice": "user", "sub-bob": "user"}
    # 角色随门卫头更新
    client.get("/api/me", headers={**USER, "X-Role": "admin"})
    with db.tx() as c:
        assert c.execute("SELECT role FROM users WHERE sub = 'sub-alice'").fetchone()[0] == "admin"


# ----- 来源校验 -----


@pytest.mark.parametrize(
    "origin,ok",
    [
        (None, True),
        ("chrome-extension://abcdefghijklmnop", True),
        ("http://testserver", True),  # 同源（TestClient 的 Host 是 testserver）
        ("https://admin.example.com", True),  # ALLOWED_ORIGINS
        ("https://evil.example.net", False),
        ("null", False),
        ("chrome-extension://", False),
    ],
)
def test_origin_check_on_writes(make_client, origin, ok):
    c = make_client(allowed_origins=("https://admin.example.com",))
    headers = {**USER} if origin is None else {**USER, "Origin": origin}
    r = put_rule(c, simple_rule(), headers)
    assert (r.status_code == 200) is ok, r.text
    if not ok:
        assert r.status_code == 403
        assert c.post("/api/ext/uplink", json=capture(), headers=headers).status_code == 403
        assert c.delete("/api/rules/r1", headers=headers).status_code == 403


def test_origin_not_checked_on_reads(client):
    r = client.get("/api/rules", headers={**USER, "Origin": "https://evil.example.net"})
    assert r.status_code == 200


# ----- 管理员与普通用户的差异 -----


def test_only_admin_can_share(client):
    r = put_rule(client, simple_rule(), USER, shared=True)
    assert r.status_code == 403
    r = put_rule(client, simple_rule(), FORGED | {"X-Role": "user"}, shared=True)
    assert r.status_code == 403
    r = put_rule(client, simple_rule(), ADMIN, shared=True)
    assert r.status_code == 200 and r.json()["shared"] is True


def test_all_param_only_for_admin(client):
    put_rule(client, simple_rule("alice-rule"), USER)
    put_rule(client, simple_rule("bob-rule"), USER2)
    ids = lambda h, q="": sorted(x["rule"]["id"] for x in client.get(f"/api/rules{q}", headers=h).json())  # noqa: E731
    assert ids(USER, "?all=1") == ["alice-rule"]
    assert ids(ADMIN) == []
    assert ids(ADMIN, "?all=1") == ["alice-rule", "bob-rule"]


def test_user_cannot_touch_others_rules(client):
    put_rule(client, simple_rule("bob-rule"), USER2)
    assert put_rule(client, simple_rule("bob-rule", version=2), USER).status_code == 404
    assert client.delete("/api/rules/bob-rule", headers=USER).status_code == 404
    # 管理员可以改别人的规则，所有者不变
    r = put_rule(client, simple_rule("bob-rule", version=2), ADMIN)
    assert r.status_code == 200 and r.json()["ownerSub"] == "sub-bob"


def test_user_cannot_modify_shared_rule_of_admin(client):
    put_rule(client, simple_rule("team"), ADMIN, shared=True)
    client.get("/api/me", headers=USER)
    listed = client.get("/api/rules", headers=USER).json()
    assert [x["rule"]["id"] for x in listed] == ["team"]
    assert put_rule(client, simple_rule("team", version=2), USER).status_code == 404
    assert client.delete("/api/rules/team", headers=USER).status_code == 404


def test_user_cannot_read_others_uploads(client):
    rec = recording("rec-bob")
    cap = capture()
    run = run_report("run-bob")
    for m in (rec, cap, run):
        assert client.post("/api/ext/uplink", json=m, headers=USER2).status_code == 202
    for path in ("/api/recordings/rec-bob", f"/api/captures/{cap['id']}", "/api/runs/run-bob"):
        assert client.get(path, headers=USER).status_code == 404
        assert client.get(path, headers=USER2).status_code == 200
        assert client.get(path, headers=ADMIN).status_code == 200
    for path in ("/api/recordings", "/api/captures", "/api/runs"):
        assert client.get(path, headers=USER).json() == []
        assert len(client.get(path, headers=USER2).json()) == 1
        assert len(client.get(path, headers=ADMIN).json()) == 1
    assert client.delete("/api/recordings/rec-bob", headers=USER).status_code == 404
    assert client.delete(f"/api/captures/{cap['id']}", headers=USER).status_code == 404
    r = client.post("/api/recordings/rec-bob/rule", json={"id": "x", "name": "x", "urls": ["https://example.com/*"]}, headers=USER)
    assert r.status_code == 404


def test_uplink_owner_is_header_not_body(client):
    # 上报内容里自称的所有者不起作用
    m = capture(ownerSub="sub-admin")
    client.post("/api/ext/uplink", json=m, headers=USER)
    assert client.get(f"/api/captures/{m['id']}", headers=USER).json()["ownerSub"] == "sub-alice"


def test_websocket_requires_identity(client):
    from starlette.websockets import WebSocketDisconnect

    with client.websocket_connect("/api/ext/ws", headers={"Authorization": "Bearer x"}) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 4401

