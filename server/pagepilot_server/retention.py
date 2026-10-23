"""数据保留：删除 RETENTION_DAYS 天前收到的抓取、录制、运行报告与去重记录；
下行事件每用户只保留最近 N 条（写入时也会裁剪，这里兜底）。"""

from __future__ import annotations

import logging

from .db import Database, now_ms

log = logging.getLogger("pagepilot_server.retention")

DAY_MS = 86_400_000


def purge(db: Database, retention_days: int, *, events_keep: int = 1000, now: int | None = None) -> dict[str, int]:
    now = now_ms() if now is None else now
    cutoff = now - retention_days * DAY_MS
    result: dict[str, int] = {}
    with db.tx() as c:
        for table in ("captures", "recordings", "run_reports", "uplink_seen"):
            result[table] = c.execute(f"DELETE FROM {table} WHERE received_at < ?", (cutoff,)).rowcount
        result["user_events"] = c.execute(
            "DELETE FROM user_events WHERE seq <= (SELECT u.seq FROM users u WHERE u.sub = user_events.sub) - ?",
            (events_keep,),
        ).rowcount
    if any(result.values()):
        log.info("保留期清理：%s", result)
    return result
