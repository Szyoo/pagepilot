"""管理页外壳：服务端渲染，外观走 @szyyw/design（固定版本）。"""

from __future__ import annotations

import re

from conftest import USER, make_config
from fastapi.testclient import TestClient

from pagepilot_server.app import create_app
from pagepilot_server.design import DESIGN_CDN, DESIGN_VERSION

BASE = f"{DESIGN_CDN}/{DESIGN_VERSION}"


def test_shell_links_pinned_design_version(client):
    r = client.get("/", headers=USER)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert re.fullmatch(r"v\d+\.\d+\.\d+", DESIGN_VERSION)
    assert f'<link rel="stylesheet" href="{BASE}/tokens.css">' in r.text
    assert f'<link rel="stylesheet" href="{BASE}/components.css">' in r.text
    assert f'<link rel="preconnect" href="{DESIGN_CDN}" crossorigin>' in r.text
    assert f'"@szyyw/design/": "{BASE}/"' in r.text
    assert "latest" not in r.text.split("<body>")[0]
    assert 'src="/boot.js"' in r.text and 'href="/style.css"' in r.text


def test_shell_has_no_leftover_placeholders(client):
    r = client.get("/", headers=USER)
    assert "{{" not in r.text


def test_design_base_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("DESIGN_BASE", 'http://127.0.0.1:9/design/"x</script>')
    with TestClient(create_app(make_config(tmp_path))) as c:
        r = c.get("/", headers=USER)
    assert r.status_code == 200
    assert DESIGN_VERSION not in r.text
    assert 'href="http://127.0.0.1:9/design/&quot;x&lt;/script&gt;/tokens.css"' in r.text
    # import map 里的 </ 被转义，不会提前结束 script
    assert "<\\/script>" in r.text
    assert "{{" not in r.text


def test_shell_requires_identity(client):
    assert client.get("/", headers={}).status_code == 401


def test_shell_sso_off_is_503(make_client):
    assert make_client(sso=False).get("/", headers={"X-Portal-Sub": "x"}).status_code == 503


def test_static_assets_served(client):
    for name, kind in (("boot.js", "javascript"), ("app.js", "javascript"), ("style.css", "css")):
        r = client.get(f"/{name}", headers=USER)
        assert r.status_code == 200 and kind in r.headers["content-type"]
    assert client.get("/boot.js", headers={}).status_code == 401
