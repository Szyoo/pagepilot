"""SQLite 存储：单连接 + 锁，WAL，外键，`PRAGMA user_version` 做迁移。

路由都是 async，数据库调用在事件循环线程里同步执行（单文件、写入很小）；保留期清理在线程里跑，
同一把锁保证不会并发使用连接。
"""

from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

# 迁移脚本按顺序执行；user_version = 已执行的条数。只能追加，不能改已发布的脚本
MIGRATIONS: tuple[str, ...] = (
    """
    CREATE TABLE users (
        sub            TEXT PRIMARY KEY,
        role           TEXT NOT NULL,
        seq            INTEGER NOT NULL DEFAULT 0,  -- 该用户的下行序号计数器
        acked_seq      INTEGER NOT NULL DEFAULT 0,  -- 扩展确认过的最大序号（仅供运维查看）
        resync_pending INTEGER NOT NULL DEFAULT 0,  -- 经 HTTP 上行请求了全量、轮询尚未取走
        created_at     INTEGER NOT NULL,            -- 以下时间均为 unix 毫秒
        last_seen      INTEGER NOT NULL
    );

    CREATE TABLE clients (
        sub                 TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        client_id           TEXT NOT NULL,
        ext_version         TEXT,
        rule_schema_version INTEGER,
        last_seen           INTEGER NOT NULL,
        PRIMARY KEY (sub, client_id)
    );

    CREATE TABLE rules (
        id         TEXT PRIMARY KEY,
        owner_sub  TEXT NOT NULL REFERENCES users(sub),
        shared     INTEGER NOT NULL DEFAULT 0,
        version    INTEGER NOT NULL,
        body       TEXT NOT NULL,                   -- 规则 JSON，原样保存
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX rules_owner ON rules(owner_sub);
    CREATE INDEX rules_shared ON rules(shared);

    CREATE TABLE user_events (
        sub        TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        kind       TEXT NOT NULL,                   -- ruleUpsert / ruleRemove
        payload    TEXT NOT NULL,                   -- 完整的下行消息 JSON（含 id 与 seq）
        created_at INTEGER NOT NULL,
        PRIMARY KEY (sub, seq)
    ) WITHOUT ROWID;

    CREATE TABLE captures (
        owner_sub     TEXT NOT NULL,
        id            TEXT NOT NULL,                -- 上行消息的 id
        page_url      TEXT,
        title         TEXT,
        element_count INTEGER NOT NULL,
        captured_at   REAL,
        received_at   INTEGER NOT NULL,
        body          TEXT NOT NULL,
        PRIMARY KEY (owner_sub, id)
    );
    CREATE INDEX captures_id ON captures(id);
    CREATE INDEX captures_received ON captures(received_at);

    CREATE TABLE recordings (
        owner_sub    TEXT NOT NULL,
        recording_id TEXT NOT NULL,
        started_at   REAL,
        step_count   INTEGER NOT NULL,
        received_at  INTEGER NOT NULL,
        body         TEXT NOT NULL,
        PRIMARY KEY (owner_sub, recording_id)
    );
    CREATE INDEX recordings_id ON recordings(recording_id);
    CREATE INDEX recordings_received ON recordings(received_at);

    CREATE TABLE run_reports (
        owner_sub    TEXT NOT NULL,
        run_id       TEXT NOT NULL,
        rule_id      TEXT NOT NULL,
        rule_version REAL,
        status       TEXT,
        trigger      TEXT,
        input_mode   TEXT,
        started_at   REAL,
        ended_at     REAL,
        received_at  INTEGER NOT NULL,
        body         TEXT NOT NULL,
        PRIMARY KEY (owner_sub, run_id)
    );
    CREATE INDEX run_reports_id ON run_reports(run_id);
    CREATE INDEX run_reports_rule ON run_reports(rule_id, started_at);
    CREATE INDEX run_reports_received ON run_reports(received_at);

    -- 上行消息去重：扩展重连后会重发队列里的消息
    CREATE TABLE uplink_seen (
        sub         TEXT NOT NULL,
        id          TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (sub, id)
    ) WITHOUT ROWID;
    CREATE INDEX uplink_seen_received ON uplink_seen(received_at);
    """,
)


def now_ms() -> int:
    return int(time.time() * 1000)


class Database:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._depth = 0
        self._conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self.migrate()

    def migrate(self) -> None:
        with self._lock:
            current = self._conn.execute("PRAGMA user_version").fetchone()[0]
            for i, script in enumerate(MIGRATIONS[current:], start=current + 1):
                # executescript 会先提交；脚本与版本号写在同一个事务里
                self._conn.executescript(f"BEGIN;\n{script}\nPRAGMA user_version = {i};\nCOMMIT;")

    @property
    def schema_version(self) -> int:
        with self._lock:
            return self._conn.execute("PRAGMA user_version").fetchone()[0]

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """事务（可嵌套，只有最外层提交）。"""
        with self._lock:
            outer = self._depth == 0
            if outer:
                self._conn.execute("BEGIN IMMEDIATE")
            self._depth += 1
            try:
                yield self._conn
            except BaseException:
                self._depth -= 1
                if outer:
                    self._conn.execute("ROLLBACK")
                raise
            self._depth -= 1
            if outer:
                self._conn.execute("COMMIT")

    def close(self) -> None:
        with self._lock:
            self._conn.close()
