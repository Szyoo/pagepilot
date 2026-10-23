"""PagePilot 后台应用。

启动：uvicorn pagepilot_server.app:create_app --factory
"""

from __future__ import annotations

import asyncio
import logging
import re
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse

from . import __version__, admin, ext
from .auth import Principal, require_user
from .config import Config
from .db import Database
from .events import Hub
from .retention import purge

log = logging.getLogger("pagepilot_server")

STATIC_DIR = Path(__file__).parent / "static"
# 静态文件只取 static/ 目录下一层、名字安全的文件
_STATIC_NAME = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:css|js|svg|png|ico|json|txt|html)$")

PLACEHOLDER_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>PagePilot 后台</title></head>
<body><h1>PagePilot 后台</h1><p>管理页尚未构建。</p></body></html>
"""

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
}


def create_app(config: Config | None = None, static_dir: Path | None = None) -> FastAPI:
    config = config or Config.from_env()
    static_dir = static_dir or STATIC_DIR

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db = Database(config.db_path)
        app.state.db = db
        if not config.sso:
            log.warning("SZYYW_SSO 未开启：除 /api/health 外所有接口返回 503")

        async def purge_once() -> None:
            try:
                await asyncio.to_thread(purge, db, config.retention_days, events_keep=config.events_keep)
            except Exception:  # noqa: BLE001
                log.exception("保留期清理失败")

        await purge_once()

        async def purge_loop() -> None:
            while True:
                await asyncio.sleep(config.purge_interval)
                await purge_once()

        task = asyncio.create_task(purge_loop())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            db.close()

    app = FastAPI(title="pagepilot-server", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.config = config
    app.state.hub = Hub()

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    @app.get("/api/me")
    async def me(p: Principal = Depends(require_user)):
        return {"sub": p.sub, "role": p.role}

    app.include_router(ext.make_router())
    app.include_router(admin.make_router())

    # ----- 管理页（同样需要身份头） -----

    @app.get("/", response_class=HTMLResponse)
    async def index(p: Principal = Depends(require_user)):
        page = static_dir / "index.html"
        if page.is_file():
            return FileResponse(page, media_type="text/html; charset=utf-8", headers=SECURITY_HEADERS)
        return HTMLResponse(PLACEHOLDER_HTML, headers=SECURITY_HEADERS)

    @app.get("/{name}")
    async def static_file(name: str, p: Principal = Depends(require_user)):
        path = static_dir / name
        if not _STATIC_NAME.match(name) or not path.is_file():
            raise HTTPException(status_code=404, detail="不存在")
        return FileResponse(path, headers=SECURITY_HEADERS)

    return app
