"""数据保留：删除 RETENTION_DAYS 天前收到的抓取、录制、运行报告与去重记录；
录制或规则已不存在的 AI 解读缓存随之删除；
下行事件每用户只保留最近 N 条（写入时也会裁剪，这里兜底）。"""

from __future__ import annotations

import logging
import sqlite3

from .db import Database, now_ms

log = logging.getLogger("pagepilot_server.retention")

DAY_MS = 86_400_000


def purge_orphan_notes(c: sqlite3.Connection) -> int:
    """删除对应录制 / 规则已不存在的 AI 解读缓存。"""
    return c.execute(
        "DELETE FROM ai_notes WHERE (kind = 'recording' AND NOT EXISTS ("
        " SELECT 1 FROM recordings r WHERE r.recording_id = ai_notes.ref AND r.owner_sub = ai_notes.owner_sub))"
        " OR (kind = 'rule' AND NOT EXISTS (SELECT 1 FROM rules WHERE rules.id = ai_notes.ref))"
    ).rowcount


def purge(db: Database, retention_days: int, *, events_keep: int = 1000, now: int | None = None) -> dict[str, int]:
    now = now_ms() if now is None else now
    cutoff = now - retention_days * DAY_MS
    result: dict[str, int] = {}
    with db.tx() as c:
        for table in ("captures", "recordings", "run_reports", "uplink_seen"):
            result[table] = c.execute(f"DELETE FROM {table} WHERE received_at < ?", (cutoff,)).rowcount
        result["ai_notes"] = purge_orphan_notes(c)
        result["user_events"] = c.execute(
            "DELETE FROM user_events WHERE seq <= (SELECT u.seq FROM users u WHERE u.sub = user_events.sub) - ?",
            (events_keep,),
        ).rowcount
    if any(result.values()):
        log.info("保留期清理：%s", result)
    return result
