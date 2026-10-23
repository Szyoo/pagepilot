"""扩展接口：WebSocket、SSE、轮询与上行消息处理。

日志只记录消息类型与 id，不记录页面文本与表单值。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.websockets import WebSocketDisconnect, WebSocketState

from .auth import Principal, authenticate, require_user
from .db import Database, now_ms
from .events import Hub, Subscriber, catch_up, error_message, message, snapshot

log = logging.getLogger("pagepilot_server.ext")

UPLINK_KINDS = frozenset(
    {"hello", "ack", "resync", "ping", "pong", "capture", "recording", "runReport"}
)
# 心跳不进去重表
NO_DEDUPE = frozenset({"ping", "pong"})
STORED_KINDS = frozenset({"capture", "recording", "runReport"})

WS_CLOSE_CODES = {401: 4401, 403: 4403, 503: 1013}


class UplinkError(Exception):
    """无法处理的上行消息；HTTP 返回 400，WebSocket 回 error 消息。"""

    def __init__(self, code: str, text: str) -> None:
        super().__init__(text)
        self.code = code
        self.text = text

    def to_message(self) -> dict[str, Any]:
        return error_message(self.code, self.text)


class PayloadTooLarge(Exception):
    pass


@dataclass
class UplinkResult:
    status: int = 200
    #: 需要立即回给发送方的下行消息（WebSocket 直接发；HTTP 放在响应体里）
    replies: list[dict[str, Any]] = field(default_factory=list)
    duplicate: bool = False
    #: WebSocket 的 hello：补发/全量与当前序号，由连接设置订阅起点
    session: tuple[list[dict[str, Any]], int] | None = None


# ---------- 字段检查（与 src/schema/message.ts 的上行 schema 对齐的最小检查） ----------


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_int(v: Any) -> bool:
    return _is_num(v) and float(v).is_integer()


def _require(msg: dict[str, Any], checks: dict[str, Any]) -> None:
    for key, check in checks.items():
        optional = key.endswith("?")
        name = key.rstrip("?")
        if name not in msg:
            if optional:
                continue
            raise UplinkError("INVALID_MESSAGE", f"{msg.get('kind')} 缺少 {name}")
        if not check(msg[name]):
            raise UplinkError("INVALID_MESSAGE", f"{msg.get('kind')}.{name} 格式错误")


_is_str = lambda v: isinstance(v, str)  # noqa: E731
_is_list = lambda v: isinstance(v, list)  # noqa: E731
_nonneg_int = lambda v: _is_int(v) and v >= 0  # noqa: E731


def _enum(*options: str):
    return lambda v: isinstance(v, str) and v in options


FIELD_CHECKS: dict[str, dict[str, Any]] = {
    "hello": {"clientId": _is_str, "extVersion": _is_str, "ruleSchemaVersion": _is_int, "lastSeq?": _nonneg_int},
    "ack": {"seq": _nonneg_int},
    "capture": {"pageUrl": _is_str, "title": _is_str, "capturedAt": _is_num, "elements": _is_list},
    "recording": {"recordingId": _is_str, "startedAt": _is_num, "steps": _is_list},
    "runReport": {
        "runId": _is_str,
        "ruleId": _is_str,
        "ruleVersion": _is_num,
        "trigger": _enum("manual", "auto"),
        "startedAt": _is_num,
        "endedAt": _is_num,
        "status": _enum("succeeded", "failed", "aborted", "handedOff"),
        "inputMode": _enum("trusted", "synthetic"),
        "steps": _is_list,
    },
}


def check_envelope(msg: Any) -> dict[str, Any]:
    if not isinstance(msg, dict):
        raise UplinkError("INVALID_MESSAGE", "消息必须是 JSON 对象")
    if msg.get("v") != 1 or isinstance(msg.get("v"), bool):
        raise UplinkError("UNSUPPORTED_VERSION", "不支持的协议版本，当前为 1")
    if not isinstance(msg.get("id"), str) or not msg["id"]:
        raise UplinkError("INVALID_MESSAGE", "缺少消息 id")
    kind = msg.get("kind")
    if kind not in UPLINK_KINDS:
        raise UplinkError("INVALID_MESSAGE", f"未知的消息类型：{kind}")
    _require(msg, FIELD_CHECKS.get(kind, {}))
    return msg


# ---------- 上行处理（WebSocket 与 HTTP 共用） ----------


def _store(c, sub: str, msg: dict[str, Any], now: int) -> None:
    kind = msg["kind"]
    body = json.dumps(msg, ensure_ascii=False)
    if kind == "capture":
        c.execute(
            "INSERT OR IGNORE INTO captures (owner_sub, id, page_url, title, element_count, captured_at,"
            " received_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (sub, msg["id"], msg["pageUrl"], msg["title"], len(msg["elements"]), msg["capturedAt"], now, body),
        )
    elif kind == "recording":
        # 同一个 recordingId 重复上报视为已收到
        c.execute(
            "INSERT OR IGNORE INTO recordings (owner_sub, recording_id, started_at, step_count, received_at, body)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (sub, msg["recordingId"], msg["startedAt"], len(msg["steps"]), now, body),
        )
    elif kind == "runReport":
        c.execute(
            "INSERT OR IGNORE INTO run_reports (owner_sub, run_id, rule_id, rule_version, status, trigger,"
            " input_mode, started_at, ended_at, received_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (sub, msg["runId"], msg["ruleId"], msg["ruleVersion"], msg["status"], msg["trigger"],
             msg["inputMode"], msg["startedAt"], msg["endedAt"], now, body),
        )


def handle_uplink(db: Database, hub: Hub, p: Principal, raw: Any, *, channel: str) -> UplinkResult:
    """处理一条上行消息。channel 为 "ws" 或 "http"。"""
    msg = check_envelope(raw)
    kind = msg["kind"]
    now = now_ms()

    if kind == "ping":
        return UplinkResult(replies=[message("pong")])
    if kind == "pong":
        return UplinkResult()

    with db.tx() as c:
        seen = c.execute(
            "INSERT OR IGNORE INTO uplink_seen (sub, id, received_at) VALUES (?, ?, ?)",
            (p.sub, msg["id"], now),
        ).rowcount == 0
        if seen:
            log.info("重复的上行消息 kind=%s id=%s", kind, msg["id"])
            return UplinkResult(status=202 if kind in STORED_KINDS else 200, duplicate=True)
        if kind == "hello":
            c.execute(
                "INSERT INTO clients (sub, client_id, ext_version, rule_schema_version, last_seen)"
                " VALUES (?, ?, ?, ?, ?) ON CONFLICT(sub, client_id) DO UPDATE SET"
                " ext_version = excluded.ext_version, rule_schema_version = excluded.rule_schema_version,"
                " last_seen = excluded.last_seen",
                (p.sub, msg["clientId"], msg["extVersion"], int(msg["ruleSchemaVersion"]), now),
            )
        elif kind == "ack":
            c.execute(
                "UPDATE users SET acked_seq = MAX(acked_seq, ?) WHERE sub = ?", (int(msg["seq"]), p.sub)
            )
        elif kind == "resync" and channel == "http":
            c.execute("UPDATE users SET resync_pending = 1 WHERE sub = ?", (p.sub,))
        elif kind in STORED_KINDS:
            _store(c, p.sub, msg, now)

    log.info("上行 kind=%s id=%s channel=%s", kind, msg["id"], channel)
    if kind == "hello" and channel == "ws":
        last = msg.get("lastSeq")
        return UplinkResult(session=catch_up(db, p.sub, int(last) if last is not None else None))
    if kind == "resync":
        snap = snapshot(db, p.sub)
        if channel == "ws":
            return UplinkResult(replies=[snap])
        # SSE 推到流里；轮询在下一次轮询时取走 resync_pending
        for s in hub.subscribers(p.sub, "sse"):
            s.offer(snap)
    return UplinkResult(status=202 if kind in STORED_KINDS else 200)


# ---------- 路由 ----------


async def read_limited(request: Request, limit: int) -> bytes:
    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) > limit:
                raise PayloadTooLarge
        except ValueError:
            raise HTTPException(status_code=400, detail="Content-Length 无效") from None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise PayloadTooLarge
        chunks.append(chunk)
    return b"".join(chunks)


def make_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/ext/uplink")
    async def uplink(request: Request, p: Principal = Depends(require_user)):
        state = request.app.state
        try:
            raw = await read_limited(request, state.config.max_body)
        except PayloadTooLarge:
            return JSONResponse(error_message("PAYLOAD_TOO_LARGE", "上报内容超过 2 MB"), status_code=413)
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return JSONResponse(error_message("INVALID_MESSAGE", "无法解析的 JSON"), status_code=400)
        try:
            result = handle_uplink(state.db, state.hub, p, data, channel="http")
        except UplinkError as e:
            return JSONResponse(e.to_message(), status_code=400)
        body: dict[str, Any] = {"ok": True, "messages": result.replies}
        if result.duplicate:
            body["duplicate"] = True
        return JSONResponse(body, status_code=result.status)

    @router.get("/api/ext/poll")
    async def poll(request: Request, since: int | None = Query(default=None), p: Principal = Depends(require_user)):
        db: Database = request.app.state.db
        with db.tx() as c:
            pending = c.execute("SELECT resync_pending FROM users WHERE sub = ?", (p.sub,)).fetchone()[0]
            if pending:
                c.execute("UPDATE users SET resync_pending = 0 WHERE sub = ?", (p.sub,))
        if pending:
            return {"messages": [snapshot(db, p.sub)]}
        messages, _ = catch_up(db, p.sub, since)
        return {"messages": messages}

    @router.get("/api/ext/stream")
    async def stream(request: Request, since: int | None = Query(default=None), p: Principal = Depends(require_user)):
        state = request.app.state
        sub = Subscriber(sub=p.sub, channel="sse")
        sub.begin(*catch_up(state.db, p.sub, since))
        state.hub.add(sub)
        keepalive = state.config.keepalive_interval

        async def events():
            try:
                while not sub.overflow:
                    try:
                        msg = await asyncio.wait_for(sub.queue.get(), keepalive)
                    except TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
            finally:
                state.hub.remove(sub)

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.websocket("/api/ext/ws")
    async def ws_endpoint(ws: WebSocket):
        # 先 accept 再按需关闭：握手前关闭只会变成 HTTP 403，扩展拿不到 4401/4403
        try:
            p = authenticate(ws)
        except HTTPException as e:
            await ws.accept()
            await ws.close(code=WS_CLOSE_CODES.get(e.status_code, 4403), reason=str(e.detail))
            return
        await ws.accept()
        await run_ws(ws, p)

    return router


async def run_ws(ws: WebSocket, p: Principal) -> None:
    state = ws.app.state
    cfg = state.config
    db: Database = state.db
    hub: Hub = state.hub
    sub = Subscriber(sub=p.sub, channel="ws")
    hub.add(sub)
    last_recv = time.monotonic()

    async def reader() -> None:
        nonlocal last_recv
        while True:
            event = await ws.receive()
            if event["type"] == "websocket.disconnect":
                return
            last_recv = time.monotonic()
            text = event.get("text")
            if text is None and event.get("bytes") is not None:
                text = event["bytes"].decode("utf-8", errors="replace")
            if text is None:
                continue
            if len(text.encode("utf-8")) > cfg.max_body:
                sub.put(error_message("PAYLOAD_TOO_LARGE", "上报内容超过 2 MB"))
                continue
            try:
                data = json.loads(text)
            except ValueError:
                log.warning("忽略无法解析的 WebSocket 消息")
                continue
            try:
                result = handle_uplink(db, hub, p, data, channel="ws")
            except UplinkError as e:
                sub.put(e.to_message())
                continue
            if result.session is not None:
                sub.begin(*result.session)
            for m in result.replies:
                # resync 回的全量也要更新已发送序号
                if m.get("kind") == "snapshot":
                    sub.sent_seq = m["seq"]
                sub.put(m)

    async def writer() -> None:
        while True:
            msg = await sub.queue.get()
            await ws.send_text(json.dumps(msg, ensure_ascii=False))

    async def ticker() -> None:
        tick = min(cfg.ping_interval, cfg.idle_timeout) / 4
        next_ping = time.monotonic() + cfg.ping_interval
        while True:
            await asyncio.sleep(tick)
            now = time.monotonic()
            if now - last_recv > cfg.idle_timeout or sub.overflow:
                return
            if now >= next_ping:
                sub.put(message("ping"))
                next_ping = now + cfg.ping_interval

    tasks = [asyncio.create_task(t()) for t in (reader, writer, ticker)]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            exc = t.exception()
            if exc is not None and not isinstance(exc, WebSocketDisconnect):
                log.warning("WebSocket 连接异常结束：%r", exc)
    finally:
        # 不等待被取消的任务结束：它们只在等收发或睡眠，取消即退出
        for t in tasks:
            t.cancel()
        hub.remove(sub)
        if ws.application_state == WebSocketState.CONNECTED and ws.client_state == WebSocketState.CONNECTED:
            try:
                await ws.close(code=1001)
            except Exception:  # noqa: BLE001
                pass
