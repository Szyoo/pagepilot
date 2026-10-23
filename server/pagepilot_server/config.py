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
        )

    @property
    def db_path(self) -> Path:
        return self.data_dir / "pagepilot.db"
