"""@szyyw/design 的引用位置（自托管 CDN design.szyyw.xyz）。版本只在这里写一处。

- 页面直接读 `{DESIGN_BASE}/tokens.css`、`components.css`；JS 经 import map（`@szyyw/design/` → DESIGN_BASE）
  在 static/boot.js 里 `import … from "@szyyw/design/chrome.js"`，不写版本。
- 升级 = 改 `DESIGN_VERSION`（同一页所有文件同一版本，不引用 latest）。
- 环境变量 `DESIGN_BASE` 可覆盖（本机用带 CORS 的静态服务器调试未发版的设计包时）；
  `PORTAL_URL` 可覆盖门户地址（默认 https://szyyw.xyz）。
"""

from __future__ import annotations

import html
import json
import os
from urllib.parse import urlsplit

DESIGN_VERSION = "v0.22.1"
DESIGN_CDN = "https://design.szyyw.xyz"
DEFAULT_PORTAL = "https://szyyw.xyz"


def design_base() -> str:
    return (os.environ.get("DESIGN_BASE") or f"{DESIGN_CDN}/{DESIGN_VERSION}").rstrip("/")


def design_origin() -> str:
    u = urlsplit(design_base())
    return f"{u.scheme}://{u.netloc}"


def portal_url() -> str:
    return (os.environ.get("PORTAL_URL") or DEFAULT_PORTAL).rstrip("/")


def import_map_base() -> str:
    """放进 import map JSON 字符串值里的 base：按 JSON 转义，`</` 再转义避免提前结束 <script>。"""
    return json.dumps(design_base())[1:-1].replace("</", "<\\/")


def render_shell(template: str, *, sso: bool) -> str:
    """把 static/index.html 当模板，替换占位符（import map 的值按 JSON 转义，其余做 HTML 转义）。"""
    values = {
        "{{DESIGN_BASE}}": html.escape(design_base(), quote=True),
        "{{DESIGN_ORIGIN}}": html.escape(design_origin(), quote=True),
        "{{PORTAL}}": html.escape(portal_url(), quote=True),
        "{{SSO}}": "1" if sso else "0",
        "{{IMPORTMAP_BASE}}": import_map_base(),
    }
    for key, val in values.items():
        template = template.replace(key, val)
    return template
