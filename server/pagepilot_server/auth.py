"""身份与来源校验：只信门卫注入的头。

部署时反向代理（门卫）先剥掉客户端发来的 X-Portal-Sub / X-Role，再按门户会话注入真头；
容器不对外发布端口，所以应用看到的这两个头只可能来自门卫。应用层面保证：
- 未开 SSO（`SZYYW_SSO` 不为 1）→ 503，绝不因为请求自带了头就放行；
- 开了 SSO 但没有 X-Portal-Sub → 401；
- X-Role 只有 `admin` 算管理员，其余一律按 `user`；
- 状态修改类请求与 WebSocket 握手检查 Origin，其他网页来源 → 403。
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import HTTPException
from starlette.requests import HTTPConnection, Request

from .db import Database, now_ms

SSO_NOT_CONFIGURED = "未配置门户登录"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


@dataclass(frozen=True)
class Principal:
    sub: str
    role: str  # "admin" | "user"

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def principal_from_request(conn: HTTPConnection) -> Principal:
    """HTTP 请求与 WebSocket 握手共用：从门卫注入的头取身份。"""
    if not conn.app.state.config.sso:
        raise HTTPException(status_code=503, detail=SSO_NOT_CONFIGURED)
    sub = (conn.headers.get("x-portal-sub") or "").strip()
    if not sub:
        raise HTTPException(status_code=401, detail="未登录")
    role = (conn.headers.get("x-role") or "").strip().lower()
    return Principal(sub=sub, role="admin" if role == "admin" else "user")


def origin_allowed(conn: HTTPConnection) -> bool:
    origin = conn.headers.get("origin")
    if origin is None:
        return True  # 非浏览器客户端
    origin = origin.strip().rstrip("/")
    if origin.startswith("chrome-extension://") and len(origin) > len("chrome-extension://"):
        return True
    if origin in conn.app.state.config.allowed_origins:
        return True
    parts = urlsplit(origin)
    host = (conn.headers.get("host") or "").strip().lower()
    # 同源：只比主机与端口（TLS 在门卫处终止，应用看到的 scheme 不可靠）
    return parts.scheme in {"http", "https"} and bool(host) and parts.netloc.lower() == host


def check_origin(conn: HTTPConnection) -> None:
    if not origin_allowed(conn):
        raise HTTPException(status_code=403, detail="来源不被允许")


def register_user(db: Database, p: Principal) -> None:
    now = now_ms()
    with db.tx() as c:
        c.execute(
            "INSERT INTO users (sub, role, created_at, last_seen) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(sub) DO UPDATE SET role = excluded.role, last_seen = excluded.last_seen",
            (p.sub, p.role, now, now),
        )


def authenticate(conn: HTTPConnection, *, check_unsafe_origin: bool = True) -> Principal:
    """取身份、按需校验来源，并登记/更新 users。"""
    p = principal_from_request(conn)
    method = conn.scope.get("method")
    if conn.scope["type"] == "websocket" or (check_unsafe_origin and method in UNSAFE_METHODS):
        check_origin(conn)
    register_user(conn.app.state.db, p)
    return p


def require_user(request: Request) -> Principal:
    """FastAPI 依赖：所有需要身份的 HTTP 接口都用它。"""
    return authenticate(request)
