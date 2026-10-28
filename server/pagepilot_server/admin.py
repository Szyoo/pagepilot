"""管理接口：规则、录制、抓取、运行报告、AI 解读。

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

from . import ai
from .auth import Principal, require_user
from .db import Database, now_ms
from .events import RuleError, delete_rule, existing_version, put_rule, rule_row
from .rules import required_placeholders, validate_rule

DEFAULT_LIMIT = 100
MAX_LIMIT = 500


def clamp_limit(limit: int | None) -> int:
    if limit is None:
        return DEFAULT_LIMIT
    return max(1, min(limit, MAX_LIMIT))


MAX_INFERRED_URLS = 5

# 验证码、短信验证码这类每次都不同的输入，不可能存进本地保险库
_USER_INPUT_KEY = re.compile(r"captcha|verif|otp|sms|one[-_]?time|验证码", re.IGNORECASE)
_SECRET_PLACEHOLDER = re.compile(r"^\{\{\s*secret\.([A-Za-z0-9_.-]+)\s*\}\}$")
CAPTCHA_HANDOFF_MESSAGE = "请在页面上输入验证码；输完会自动继续，也可以点「继续」"


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


def captchas_to_handoff(steps: list[Any], min_length: int | None = None) -> list[Any]:
    """把录制里“用凭据填写验证码输入框”的步骤改成交还给用户的步骤。

    扩展录制时会把验证码等敏感输入替换成 `{{secret.<字段名>}}`，但验证码每次都不同，
    保险库里存不了，规则也就跑不起来；改成交还步骤，由用户输入后继续。
    """
    out: list[Any] = []
    for s in steps:
        if not isinstance(s, dict):
            out.append(s)
            continue
        value = s.get("value")
        m = _SECRET_PLACEHOLDER.match(value) if s.get("type") == "fill" and isinstance(value, str) else None
        if m and _USER_INPUT_KEY.search(m.group(1)):
            handoff: dict[str, Any] = {
                "id": s.get("id"),
                "type": "handoff",
                "message": CAPTCHA_HANDOFF_MESSAGE,
                "resumeWhen": "userConfirm",
            }
            target = s.get("target")
            if isinstance(target, dict):
                # 输入框填满（有 maxlength 时达到它，否则非空）就自动继续；侧边栏的「继续」按钮仍可手动继续
                handoff["resumeWhen"] = "condition"
                if min_length:
                    # 验证码实际位数与输入框的 maxlength 不一致时，用明确的位数判断
                    handoff["until"] = {"kind": "element", "target": target, "minLength": min_length}
                else:
                    handoff["until"] = {"kind": "element", "target": target, "filled": True}
            if isinstance(s.get("note"), str):
                handoff["note"] = s["note"]
            out.append(handoff)
            continue
        converted = dict(s)
        for key in ("then", "else", "steps"):
            if isinstance(s.get(key), list):
                converted[key] = captchas_to_handoff(s[key], min_length)
        out.append(converted)
    return out


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


# ----- AI 解读缓存 -----


def _load_note(db: Database, kind: str, ref: str, owner: str) -> sqlite3.Row | None:
    with db.tx() as c:
        return c.execute(
            "SELECT * FROM ai_notes WHERE kind = ? AND ref = ? AND owner_sub = ?", (kind, ref, owner)
        ).fetchone()


def _note_out(row: sqlite3.Row) -> dict[str, Any]:
    body = json.loads(row["body"])
    return {"summary": body.get("summary") or "", "steps": body.get("steps") or [],
            "model": row["model"], "createdAt": row["created_at"]}


def _store_note(db: Database, kind: str, ref: str, owner: str, digest: str, notes: ai.Notes, model: str) -> sqlite3.Row:
    with db.tx() as c:
        c.execute(
            "INSERT INTO ai_notes (kind, ref, owner_sub, digest, body, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(kind, ref) DO UPDATE SET owner_sub = excluded.owner_sub, digest = excluded.digest,"
            " body = excluded.body, model = excluded.model, created_at = excluded.created_at",
            (kind, ref, owner, digest, json.dumps(notes.to_body(), ensure_ascii=False), model, now_ms()),
        )
        return c.execute("SELECT * FROM ai_notes WHERE kind = ? AND ref = ?", (kind, ref)).fetchone()


def _ai_error(e: ai.AiError) -> JSONResponse:
    return JSONResponse({"detail": e.detail}, status_code=e.status)


async def _describe(request: Request, kind: str, ref: str, owner: str, steps: list[Any],
                    refresh: bool) -> tuple[ai.Notes, sqlite3.Row, bool]:
    """取缓存（脱敏后输入的摘要一致时）或调用 AI 并写入缓存。返回 (结果, 缓存行, 是否命中缓存)。"""
    state = request.app.state
    redacted = ai.redact_steps(steps)
    digest = ai.digest(redacted)
    if not refresh:
        row = _load_note(state.db, kind, ref, owner)
        if row is not None and row["digest"] == digest:
            return ai.Notes.from_body(json.loads(row["body"])), row, True
    notes, model = await ai.describe(ai.get_client(state), redacted, state.config.ai_timeout)
    return notes, _store_note(state.db, kind, ref, owner, digest, notes, model), False


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
        with state.db.tx() as c:
            c.execute("DELETE FROM ai_notes WHERE kind = 'rule' AND ref = ?", (rule_id,))
        return Response(status_code=204)

    @router.post("/api/rules/{rule_id}/describe")
    async def describe_rule(request: Request, rule_id: str, refresh: int = 0,
                            p: Principal = Depends(require_user)):
        """生成每步描述，填进空的 note，保存为新版本（推送给扩展）。"""
        db: Database = request.app.state.db
        with db.tx() as c:
            row = c.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
        if row is None or not (p.is_admin or row["owner_sub"] == p.sub):
            return JSONResponse({"detail": "规则不存在"}, status_code=404)
        if row["shared"] and not p.is_admin:
            return JSONResponse({"detail": "只有管理员可以修改共享规则"}, status_code=403)
        rule = json.loads(row["body"])
        login = rule.get("login") if isinstance(rule.get("login"), dict) else None
        login_steps = login.get("steps") if login and isinstance(login.get("steps"), list) else []
        steps = rule.get("steps") if isinstance(rule.get("steps"), list) else []
        try:
            notes, note_row, cached = await _describe(request, "rule", rule_id, row["owner_sub"],
                                                      [*login_steps, *steps], refresh == 1)
        except ai.AiError as e:
            return _ai_error(e)
        texts = notes.text_map(ai_only=True)
        new_rule = dict(rule)
        new_rule["steps"], added = ai.apply_notes(steps, texts)
        if login is not None:
            new_login = dict(login)
            new_login["steps"], n = ai.apply_notes(login_steps, texts)
            new_rule["login"] = new_login
            added += n
        extra = {"summary": notes.summary, "added": added, "model": note_row["model"], "cached": cached}
        if not added:
            return {"rule": rule, **extra}
        # AI 调用期间规则可能被改过：以开始时的版本为准，期间有新版本时 put_rule 返回 409
        new_rule["version"] = row["version"] + 1
        saved = _save_rule(request, p, new_rule, None)
        if isinstance(saved, JSONResponse):
            return saved
        return {"rule": saved["rule"], **extra}

    # ----- AI -----

    @router.get("/api/ai/status")
    async def ai_status(request: Request, p: Principal = Depends(require_user)):
        client = ai.get_client(request.app.state)
        return {"available": client is not None, "model": client.model if client else None}

    # ----- 录制 -----

    @router.get("/api/recordings")
    async def list_recordings(request: Request, limit: int | None = None, p: Principal = Depends(require_user)):
        return _list(request.app.state.db, RECORDINGS, p, limit)

    @router.get("/api/recordings/{recording_id}")
    async def get_recording(request: Request, recording_id: str, p: Principal = Depends(require_user)):
        db: Database = request.app.state.db
        detail = _get(db, RECORDINGS, p, recording_id)
        note = _load_note(db, "recording", recording_id, detail["ownerSub"])
        if note is not None:
            detail["ai"] = _note_out(note)
        return detail

    @router.delete("/api/recordings/{recording_id}", status_code=204)
    async def delete_recording(request: Request, recording_id: str, p: Principal = Depends(require_user)):
        db: Database = request.app.state.db
        with db.tx() as c:
            row = RECORDINGS.find(c, p, recording_id)
            c.execute("DELETE FROM recordings WHERE rowid = ?", (row["_rowid"],))
            c.execute("DELETE FROM ai_notes WHERE kind = 'recording' AND ref = ? AND owner_sub = ?",
                      (recording_id, row["owner_sub"]))
        return Response(status_code=204)

    @router.post("/api/recordings/{recording_id}/describe")
    async def describe_recording(request: Request, recording_id: str, refresh: int = 0,
                                 p: Principal = Depends(require_user)):
        detail = _get(request.app.state.db, RECORDINGS, p, recording_id)
        steps = detail.get("steps") if isinstance(detail.get("steps"), list) else []
        if not ai.flat_steps(steps):
            return _invalid(["steps: 录制里没有步骤"])
        try:
            _, row, cached = await _describe(request, "recording", recording_id, detail["ownerSub"], steps,
                                             refresh == 1)
        except ai.AiError as e:
            return _ai_error(e)
        return {**_note_out(row), "cached": cached}

    @router.post("/api/recordings/{recording_id}/rule")
    async def recording_to_rule(request: Request, recording_id: str, body: dict[str, Any] = Body(...),
                                p: Principal = Depends(require_user)):
        db: Database = request.app.state.db
        recording = _get(db, RECORDINGS, p, recording_id)
        steps = recording.get("steps") if isinstance(recording.get("steps"), list) else []
        captcha_length = body.get("captchaLength")
        if captcha_length is not None and (
            isinstance(captcha_length, bool) or not isinstance(captcha_length, int) or not 1 <= captcha_length <= 20
        ):
            return _invalid(["captchaLength: 需要 1 到 20 的整数"])
        steps = captchas_to_handoff(steps, captcha_length)
        # 已有 AI 解读时把每步的描述写进 note（不调用 AI，保持快速；已有 note 不覆盖）
        note = _load_note(db, "recording", recording_id, recording["ownerSub"])
        if note is not None:
            texts = ai.Notes.from_body(json.loads(note["body"])).text_map(ai_only=True)
            steps, _ = ai.apply_notes(steps, texts)
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
