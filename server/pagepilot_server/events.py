"""按用户的下行事件日志：规则可见性、事件扇出、全量与补发、在线订阅者。

- 每个用户有自己的 `seq` 计数器，规则变化时给受影响的用户各写一条事件（序号连续）；
- 事件与规则写在同一个事务里，提交后再推给在线订阅者（WebSocket 与 SSE 共用）；
- 所有写入都在事件循环线程里同步完成，订阅者按序号过滤，不会重复或乱序。
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from .auth import Principal
from .db import Database, now_ms

log = logging.getLogger("pagepilot_server.events")

PROTOCOL_VERSION = 1
SYNC_KINDS = frozenset({"snapshot", "ruleUpsert", "ruleRemove"})
QUEUE_MAX = 2000


def new_id() -> str:
    return str(uuid.uuid4())


def message(kind: str, **fields: Any) -> dict[str, Any]:
    """构造一条下行消息（带信封 v 与 id）。"""
    return {"v": PROTOCOL_VERSION, "kind": kind, "id": new_id(), **fields}


def error_message(code: str, text: str) -> dict[str, Any]:
    return message("error", code=code, message=text)


# ---------- 订阅者 ----------


@dataclass(eq=False)
class Subscriber:
    sub: str
    channel: str  # "ws" | "sse"
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=QUEUE_MAX))
    #: 已经交给该连接的最大序号；之后只推更大的
    sent_seq: int = 0
    #: 会话建立（补发/全量已入队）之前不推实时事件
    ready: bool = False
    overflow: bool = False

    def put(self, msg: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(msg)
        except asyncio.QueueFull:
            # 消费跟不上：标记后由连接自行关闭，扩展重连时会补发或拿全量
            self.overflow = True

    def begin(self, messages: list[dict[str, Any]], seq: int) -> None:
        for m in messages:
            self.put(m)
        self.sent_seq = seq
        self.ready = True

    def offer(self, msg: dict[str, Any]) -> None:
        """实时事件：只推比已发送更大的序号。"""
        if not self.ready:
            return
        kind = msg.get("kind")
        if kind == "snapshot":
            self.sent_seq = msg["seq"]
        elif kind in SYNC_KINDS:
            if msg["seq"] <= self.sent_seq:
                return
            self.sent_seq = msg["seq"]
        self.put(msg)


class Hub:
    def __init__(self) -> None:
        self._subs: dict[str, set[Subscriber]] = defaultdict(set)

    def add(self, s: Subscriber) -> None:
        self._subs[s.sub].add(s)

    def remove(self, s: Subscriber) -> None:
        group = self._subs.get(s.sub)
        if group is not None:
            group.discard(s)
            if not group:
                del self._subs[s.sub]

    def subscribers(self, sub: str, channel: str | None = None) -> list[Subscriber]:
        return [s for s in self._subs.get(sub, ()) if channel is None or s.channel == channel]

    def publish(self, events: list[tuple[str, dict[str, Any]]]) -> None:
        for sub, msg in events:
            for s in list(self._subs.get(sub, ())):
                s.offer(msg)

    def count(self) -> int:
        return sum(len(v) for v in self._subs.values())


# ---------- 读取 ----------


def current_seq(c: sqlite3.Connection, sub: str) -> int:
    row = c.execute("SELECT seq FROM users WHERE sub = ?", (sub,)).fetchone()
    return row["seq"] if row else 0


def visible_rules(c: sqlite3.Connection, sub: str) -> list[dict[str, Any]]:
    rows = c.execute(
        "SELECT body FROM rules WHERE owner_sub = ? OR shared = 1 ORDER BY id", (sub,)
    ).fetchall()
    return [json.loads(r["body"]) for r in rows]


def snapshot(db: Database, sub: str) -> dict[str, Any]:
    with db.tx() as c:
        return message("snapshot", seq=current_seq(c, sub), rules=visible_rules(c, sub))


def catch_up(db: Database, sub: str, last_seq: int | None) -> tuple[list[dict[str, Any]], int]:
    """按本地序号决定补发还是全量。返回 (消息列表, 当前序号)。

    - 等于当前序号 → 空；
    - 在保留范围内且小于当前序号 → 其后的事件；
    - 为空、大于当前序号、已被裁剪 → 一条 snapshot；
    - 本地序号为 0（扩展的初始值，等同于没有本地状态）或该用户还没有任何事件（seq = 0）→ snapshot：
      之后才登记的用户，登记前已有的共享规则只能通过全量到达，从 1 开始补发会漏掉它们。
    """
    with db.tx() as c:
        cur = current_seq(c, sub)
        if last_seq is None or last_seq <= 0 or last_seq > cur or cur == 0:
            return [message("snapshot", seq=cur, rules=visible_rules(c, sub))], cur
        if last_seq == cur:
            return [], cur
        oldest = c.execute("SELECT MIN(seq) AS m FROM user_events WHERE sub = ?", (sub,)).fetchone()["m"]
        if oldest is None or last_seq < oldest - 1:
            return [message("snapshot", seq=cur, rules=visible_rules(c, sub))], cur
        rows = c.execute(
            "SELECT payload FROM user_events WHERE sub = ? AND seq > ? ORDER BY seq", (sub, last_seq)
        ).fetchall()
        return [json.loads(r["payload"]) for r in rows], cur


# ---------- 写入 ----------


def _append(c: sqlite3.Connection, subs: list[str], kind: str, fields: dict[str, Any], keep: int) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    now = now_ms()
    for sub in subs:
        seq = c.execute(
            "UPDATE users SET seq = seq + 1 WHERE sub = ? RETURNING seq", (sub,)
        ).fetchone()["seq"]
        msg = message(kind, seq=seq, **fields)
        c.execute(
            "INSERT INTO user_events (sub, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            (sub, seq, kind, json.dumps(msg, ensure_ascii=False), now),
        )
        c.execute("DELETE FROM user_events WHERE sub = ? AND seq <= ?", (sub, seq - keep))
        out.append((sub, msg))
    return out


def _audience(c: sqlite3.Connection, owner: str, shared: bool) -> list[str]:
    if shared:
        return [r["sub"] for r in c.execute("SELECT sub FROM users ORDER BY sub")]
    return [owner]


class RuleError(Exception):
    def __init__(self, status: int, detail: str, errors: list[str] | None = None) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.errors = errors or []


def rule_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "rule": json.loads(row["body"]),
        "ownerSub": row["owner_sub"],
        "shared": bool(row["shared"]),
        "updatedAt": row["updated_at"],
    }


def _can_manage(p: Principal, row: sqlite3.Row) -> bool:
    return p.is_admin or row["owner_sub"] == p.sub


def put_rule(
    db: Database, hub: Hub, p: Principal, rule: dict[str, Any], shared: bool | None, *, keep: int
) -> dict[str, Any]:
    """新增或更新规则（调用方已校验规则）。权限：所有者或管理员；shared=true 仅管理员。"""
    if shared and not p.is_admin:
        raise RuleError(403, "只有管理员可以共享规则")
    rule_id = rule["id"]
    with db.tx() as c:
        old = c.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
        if old is not None:
            if not _can_manage(p, old):
                raise RuleError(404, "规则不存在")
            if rule["version"] <= old["version"]:
                raise RuleError(409, f"version 必须大于当前版本 {old['version']}")
            owner = old["owner_sub"]
            new_shared = bool(old["shared"]) if shared is None else bool(shared)
            before = set(_audience(c, owner, bool(old["shared"])))
        else:
            owner = p.sub
            new_shared = bool(shared)
            before = set()
        now = now_ms()
        c.execute(
            "INSERT INTO rules (id, owner_sub, shared, version, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET shared = excluded.shared, version = excluded.version,"
            " body = excluded.body, updated_at = excluded.updated_at",
            (rule_id, owner, int(new_shared), rule["version"], json.dumps(rule, ensure_ascii=False), now),
        )
        after = _audience(c, owner, new_shared)
        events = _append(c, after, "ruleUpsert", {"rule": rule}, keep)
        gone = sorted(before - set(after))
        events += _append(c, gone, "ruleRemove", {"ruleId": rule_id}, keep)
        row = c.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
    hub.publish(events)
    return rule_row(row)


def delete_rule(db: Database, hub: Hub, p: Principal, rule_id: str, *, keep: int) -> None:
    with db.tx() as c:
        old = c.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
        if old is None or not _can_manage(p, old):
            raise RuleError(404, "规则不存在")
        audience = _audience(c, old["owner_sub"], bool(old["shared"]))
        c.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
        events = _append(c, audience, "ruleRemove", {"ruleId": rule_id}, keep)
    hub.publish(events)


def existing_version(db: Database, rule_id: str) -> int | None:
    with db.tx() as c:
        row = c.execute("SELECT version FROM rules WHERE id = ?", (rule_id,)).fetchone()
    return row["version"] if row else None
