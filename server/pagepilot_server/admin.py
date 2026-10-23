"""管理接口：规则、录制、抓取、运行报告。

普通用户只能管理自己的数据（共享规则可见但不能修改）；管理员可以管理全部。
找不到或无权访问一律 404。
"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response

from .auth import Principal, require_user
from .db import Database
from .events import RuleError, delete_rule, existing_version, put_rule, rule_row
from .rules import required_placeholders, validate_rule

DEFAULT_LIMIT = 100
MAX_LIMIT = 500


def clamp_limit(limit: int | None) -> int:
    if limit is None:
        return DEFAULT_LIMIT
    return max(1, min(limit, MAX_LIMIT))


MAX_INFERRED_URLS = 5


def _walk_steps(steps: list[Any]):
    """依次产出步骤（含 if / repeat 里嵌套的）。"""
    for s in steps:
        if not isinstance(s, dict):
            continue
        yield s
        for key in ("then", "else", "steps"):
            nested = s.get(key)
            if isinstance(nested, list):
                yield from _walk_steps(nested)


def infer_match_urls(steps: list[Any]) -> list[str]:
    """从录制的步骤里推断规则匹配的网站：用到的每个主机一条 `scheme://host/*`。"""
    found: list[str] = []
    for s in _walk_steps(steps):
        candidate = None
        if s.get("type") == "open" and isinstance(s.get("url"), str):
            candidate = s["url"]
        elif s.get("type") in ("waitFor", "switchTab") and isinstance(s.get("urlPattern"), str):
            candidate = s["urlPattern"]
        if not candidate or "{{" in candidate:
            continue
        m = re.match(r"^(https?)://([^/*?#:]+)", candidate)
        if not m:
            try:
                parts = urlsplit(candidate)
            except ValueError:
                continue
            if parts.scheme not in ("http", "https") or not parts.hostname:
                continue
            m = None
            scheme, host = parts.scheme, parts.hostname
        else:
            scheme, host = m.group(1), m.group(2)
        pattern = f"{scheme}://{host}/*"
        if pattern not in found:
            found.append(pattern)
        if len(found) >= MAX_INFERRED_URLS:
            break
    return found


def make_rule_id(db: Database, name: str) -> str:
    """由名称生成规则 id：英文数字取成短标识，中文等无法取标识时用 rule；后缀保证不重复。"""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24].strip("-")
    base = slug if len(slug) >= 2 else "rule"
    while True:
        rule_id = f"{base}-{secrets.token_hex(3)}"
        if existing_version(db, rule_id) is None:
            return rule_id


def _rule_error(e: RuleError) -> JSONResponse:
    body: dict[str, Any] = {"detail": e.detail}
    if e.errors:
        body["errors"] = e.errors
    return JSONResponse(body, status_code=e.status)


def _invalid(errors: list[str]) -> JSONResponse:
    return JSONResponse({"detail": "规则校验失败", "errors": errors}, status_code=422)


def _save_rule(request: Request, p: Principal, rule: Any, shared: Any) -> JSONResponse | dict[str, Any]:
    if shared is not None and not isinstance(shared, bool):
        return _invalid(["shared: 需要布尔值"])
    errors = validate_rule(rule)
    if errors:
        return _invalid(errors)
    state = request.app.state
    try:
        return put_rule(state.db, state.hub, p, rule, shared, keep=state.config.events_keep)
    except RuleError as e:
        return _rule_error(e)


# 列表、详情、删除共用的表描述
class _Table:
    def __init__(self, name: str, key: str, order: str, summary) -> None:
        self.name = name
        self.key = key
        self.order = order
        self.summary = summary

    def find(self, c: sqlite3.Connection, p: Principal, item_id: str) -> sqlite3.Row:
        sql = f"SELECT rowid AS _rowid, * FROM {self.name} WHERE {self.key} = ?"
        args: list[Any] = [item_id]
        if not p.is_admin:
            sql += " AND owner_sub = ?"
            args.append(p.sub)
        row = c.execute(sql + " ORDER BY received_at DESC LIMIT 1", args).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="不存在")
        return row


def _detail(row: sqlite3.Row) -> dict[str, Any]:
    return {**json.loads(row["body"]), "ownerSub": row["owner_sub"], "receivedAt": row["received_at"]}


RECORDINGS = _Table(
    "recordings", "recording_id", "received_at DESC, rowid DESC",
    lambda r: {
        "recordingId": r["recording_id"],
        "startedAt": r["started_at"],
        "stepCount": r["step_count"],
        "receivedAt": r["received_at"],
        "ownerSub": r["owner_sub"],
    },
)
CAPTURES = _Table(
    "captures", "id", "received_at DESC, rowid DESC",
    lambda r: {
        "captureId": r["id"],
        "pageUrl": r["page_url"],
        "title": r["title"],
        "elementCount": r["element_count"],
        "capturedAt": r["captured_at"],
        "receivedAt": r["received_at"],
        "ownerSub": r["owner_sub"],
    },
)
RUNS = _Table(
    "run_reports", "run_id", "started_at DESC, received_at DESC, rowid DESC",
    lambda r: {
        "runId": r["run_id"],
        "ruleId": r["rule_id"],
        "ruleVersion": r["rule_version"],
        "status": r["status"],
        "trigger": r["trigger"],
        "inputMode": r["input_mode"],
        "startedAt": r["started_at"],
        "endedAt": r["ended_at"],
        "receivedAt": r["received_at"],
        "ownerSub": r["owner_sub"],
    },
)


def _list(db: Database, table: _Table, p: Principal, limit: int | None, where: dict[str, Any] | None = None) -> list[dict]:
    clauses: list[str] = []
    args: list[Any] = []
    if not p.is_admin:
        clauses.append("owner_sub = ?")
        args.append(p.sub)
    for col, value in (where or {}).items():
        clauses.append(f"{col} = ?")
        args.append(value)
    sql = f"SELECT * FROM {table.name}"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += f" ORDER BY {table.order} LIMIT ?"
    args.append(clamp_limit(limit))
    with db.tx() as c:
        return [table.summary(r) for r in c.execute(sql, args)]


def _get(db: Database, table: _Table, p: Principal, item_id: str) -> dict[str, Any]:
    with db.tx() as c:
        return _detail(table.find(c, p, item_id))


def _delete(db: Database, table: _Table, p: Principal, item_id: str) -> Response:
    with db.tx() as c:
        row = table.find(c, p, item_id)
        c.execute(f"DELETE FROM {table.name} WHERE rowid = ?", (row["_rowid"],))
    return Response(status_code=204)


def make_router() -> APIRouter:
    router = APIRouter()

    # ----- 规则 -----

    @router.get("/api/rules")
    async def list_rules(request: Request, all: int = 0, limit: int | None = None,
                         p: Principal = Depends(require_user)):
        db: Database = request.app.state.db
        sql = "SELECT * FROM rules"
        args: list[Any] = []
        if not (p.is_admin and all == 1):
            sql += " WHERE owner_sub = ? OR shared = 1"
            args.append(p.sub)
        sql += " ORDER BY updated_at DESC, id LIMIT ?"
        args.append(clamp_limit(limit))
        with db.tx() as c:
            return [rule_row(r) for r in c.execute(sql, args)]

    @router.post("/api/rules/validate")
    async def validate(body: dict[str, Any] = Body(...), p: Principal = Depends(require_user)):
        errors = validate_rule(body.get("rule"))
        return {"ok": not errors, "errors": errors}

    @router.put("/api/rules/{rule_id}")
    async def save_rule(request: Request, rule_id: str, body: dict[str, Any] = Body(...),
                        p: Principal = Depends(require_user)):
        rule = body.get("rule")
        if isinstance(rule, dict) and rule.get("id") != rule_id:
            return _invalid([f"id: 规则 id 必须与路径一致（{rule_id}）"])
        return _save_rule(request, p, rule, body.get("shared"))

    @router.delete("/api/rules/{rule_id}", status_code=204)
    async def remove_rule(request: Request, rule_id: str, p: Principal = Depends(require_user)):
        state = request.app.state
        try:
            delete_rule(state.db, state.hub, p, rule_id, keep=state.config.events_keep)
        except RuleError as e:
            return _rule_error(e)
        return Response(status_code=204)

    # ----- 录制 -----

    @router.get("/api/recordings")
    async def list_recordings(request: Request, limit: int | None = None, p: Principal = Depends(require_user)):
        return _list(request.app.state.db, RECORDINGS, p, limit)

    @router.get("/api/recordings/{recording_id}")
    async def get_recording(request: Request, recording_id: str, p: Principal = Depends(require_user)):
        return _get(request.app.state.db, RECORDINGS, p, recording_id)

    @router.delete("/api/recordings/{recording_id}", status_code=204)
    async def delete_recording(request: Request, recording_id: str, p: Principal = Depends(require_user)):
        return _delete(request.app.state.db, RECORDINGS, p, recording_id)

    @router.post("/api/recordings/{recording_id}/rule")
    async def recording_to_rule(request: Request, recording_id: str, body: dict[str, Any] = Body(...),
                                p: Principal = Depends(require_user)):
        db: Database = request.app.state.db
        recording = _get(db, RECORDINGS, p, recording_id)
        steps = recording.get("steps") if isinstance(recording.get("steps"), list) else []
        name = body.get("name")
        rule_id = body.get("id")
        # 只需要名称：id 与匹配网站留空时自动生成 / 从录制推断
        if not rule_id and isinstance(name, str) and name.strip():
            rule_id = make_rule_id(db, name.strip())
        urls = body.get("urls")
        if not urls:
            urls = infer_match_urls([x for x in steps if isinstance(x, dict)])
            if not urls:
                return _invalid(["match.urls: 录制里没有页面地址，请手动填写匹配网址"])
        rule: dict[str, Any] = {
            "id": rule_id,
            "name": name.strip() if isinstance(name, str) else name,
            "version": 1,
            "match": {"urls": urls},
            "requires": required_placeholders([s for s in steps if isinstance(s, dict)]),
            "steps": steps,
        }
        rule["trigger"] = body.get("trigger", "manual")
        rule["inputMode"] = body.get("inputMode", "auto")
        if "exclude" in body:
            rule["match"]["exclude"] = body["exclude"]
        if isinstance(rule_id, str) and rule_id:
            current = existing_version(db, rule_id)
            if current is not None:
                rule["version"] = current + 1
        return _save_rule(request, p, rule, body.get("shared"))

    # ----- 抓取 -----

    @router.get("/api/captures")
    async def list_captures(request: Request, limit: int | None = None, p: Principal = Depends(require_user)):
        return _list(request.app.state.db, CAPTURES, p, limit)

    @router.get("/api/captures/{capture_id}")
    async def get_capture(request: Request, capture_id: str, p: Principal = Depends(require_user)):
        return _get(request.app.state.db, CAPTURES, p, capture_id)

    @router.delete("/api/captures/{capture_id}", status_code=204)
    async def delete_capture(request: Request, capture_id: str, p: Principal = Depends(require_user)):
        return _delete(request.app.state.db, CAPTURES, p, capture_id)

    # ----- 运行报告 -----

    @router.get("/api/runs")
    async def list_runs(request: Request, ruleId: str | None = Query(default=None),  # noqa: N803
                        limit: int | None = None, p: Principal = Depends(require_user)):
        where = {"rule_id": ruleId} if ruleId else None
        return _list(request.app.state.db, RUNS, p, limit, where)

    @router.get("/api/runs/{run_id}")
    async def get_run(request: Request, run_id: str, p: Principal = Depends(require_user)):
        return _get(request.app.state.db, RUNS, p, run_id)

    return router
