"""运行时配置，全部来自环境变量。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip() == "1"


def _int(name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(value, minimum)


@dataclass(frozen=True)
class Config:
    sso: bool
    data_dir: Path
    retention_days: int = 90
    #: 额外允许的 Origin（已去掉末尾斜杠）
    allowed_origins: tuple[str, ...] = ()
    port: int = 8000
    # 以下为协议常量，测试时可调小
    ping_interval: float = 20.0
    idle_timeout: float = 45.0
    keepalive_interval: float = 20.0
    max_body: int = 2 * 1024 * 1024
    events_keep: int = 1000
    purge_interval: float = 86400.0
    # AI 解读（claude-bridge 调用方接口）；地址或令牌为空即不可用
    bridge_url: str = ""
    bridge_token: str = ""
    bridge_model: str = "claude-haiku-5-5"
    bridge_scope: str = "pagepilot"
    ai_timeout: float = 120.0

    @classmethod
    def from_env(cls) -> Config:
        origins = tuple(
            o.strip().rstrip("/")
            for o in os.environ.get("ALLOWED_ORIGINS", "").split(",")
            if o.strip()
        )
        return cls(
            sso=_flag("SZYYW_SSO"),
            data_dir=Path(os.environ.get("DATA_DIR", "/data")),
            retention_days=_int("RETENTION_DAYS", 90),
            allowed_origins=origins,
            port=_int("PORT", 8000),
            bridge_url=os.environ.get("CLAUDE_BRIDGE_URL", "").strip().rstrip("/"),
            bridge_token=os.environ.get("CLAUDE_BRIDGE_TOKEN", "").strip(),
            bridge_model=os.environ.get("CLAUDE_BRIDGE_MODEL", "").strip() or "claude-haiku-5-5",
            bridge_scope=os.environ.get("CLAUDE_BRIDGE_SCOPE", "").strip() or "pagepilot",
            ai_timeout=float(_int("AI_TIMEOUT_SEC", 120, minimum=5)),
        )

    @property
    def ai_configured(self) -> bool:
        return bool(self.bridge_url and self.bridge_token)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "pagepilot.db"
