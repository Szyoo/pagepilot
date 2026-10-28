"""AI 解读：把录制 / 规则的步骤交给 claude-bridge，生成整体说明与每一步的中文描述。

- 发送前一律脱敏（`redact_steps`）：只保留步骤类型、定位器里可读的部分、去掉查询串的地址、占位符；
  用户输入的字面值替换为 `<用户输入，N 个字符>`。
- 调用 claude-bridge 的调用方接口（`/api/caller/tasks` 提交一次性任务，再长轮询取结果）。
- 结果按 (kind, ref) 缓存在 `ai_notes`，`digest` 是脱敏后输入的 SHA-256，输入变了缓存失效。
- 日志不记录发送的内容与模型的回答。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from .config import Config
from .rules import CONTAINER_KEYS

log = logging.getLogger("pagepilot_server.ai")

MAX_TEXT = 40
MAX_FIELD = 80


class AiError(Exception):
    """AI 调用失败的基类；`status` / `detail` 直接用作 HTTP 响应。"""

    status = 502
    detail = "AI 解读失败"


class AiUnavailable(AiError):
    status = 503
    detail = "AI 未配置"


class AiFailed(AiError):
    status = 502
    detail = "AI 解读失败"


class AiTimeout(AiError):
    status = 504
    detail = "AI 响应超时"


# ---------- 脱敏 ----------

# 与 rules.PLACEHOLDER_RE 一致：`\{{` 是转义，不算占位符
_PLACEHOLDER = re.compile(r"\{\{\s*(?:profile|secret|var)\.[A-Za-z0-9_.-]+\s*\}\}")
_ARIA = re.compile(r'^([a-z]+)(?:\[name="((?:[^"\\]|\\.)*)"\])?$')
_CSS_ID = re.compile(r"^#([A-Za-z_][\w-]*)$")
_CSS_NAME = re.compile(r'^[a-z][a-z0-9]*\[name="((?:[^"\\]|\\.)*)"\]$')
_URL = re.compile(r"^([a-z][a-z0-9+.-]*://)(?:[^/@?#]*@)?([^?#]*)", re.IGNORECASE)


def _clip(text: str, limit: int = MAX_FIELD) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _unescape(value: str) -> str:
    return re.sub(r"\\(.)", r"\1", value)


def redact_url(url: str) -> str:
    """只保留 origin + path（去掉账号、查询串与 hash）。"""
    m = _URL.match(url.strip())
    if m:
        return _clip(m.group(1) + m.group(2), 200)
    return _clip(re.split(r"[?#]", url.strip(), maxsplit=1)[0], 200)


def redact_value(value: str) -> str:
    """输入值：占位符原样保留，其余字面值替换为 `<用户输入，N 个字符>`。"""
    out: list[str] = []
    pos = 0
    for m in _PLACEHOLDER.finditer(value):
        literal = value[pos:m.start()]
        if literal.strip():
            out.append(f"<用户输入，{len(literal)} 个字符>")
        out.append(m.group(0))
        pos = m.end()
    tail = value[pos:]
    if tail.strip():
        out.append(f"<用户输入，{len(tail)} 个字符>")
    return "".join(out)


def redact_locator(locator: Any) -> dict[str, str]:
    """定位器里只取可读的部分：aria 的角色与名称、text 的文字、testid、css 里的 id / name。"""
    out: dict[str, str] = {}
    if not isinstance(locator, dict) or not isinstance(locator.get("strategies"), list):
        return out
    for s in locator["strategies"]:
        if not isinstance(s, dict) or not isinstance(s.get("value"), str):
            continue
        kind, value = s.get("kind"), s["value"]
        if kind == "aria":
            m = _ARIA.match(value)
            if m:
                out.setdefault("role", m.group(1))
                if m.group(2):
                    out.setdefault("name", _clip(_unescape(m.group(2))))
        elif kind == "text":
            out.setdefault("text", _clip(value))
        elif kind == "testid":
            out.setdefault("testid", _clip(value))
        elif kind == "css":
            if m := _CSS_ID.match(value):
                out.setdefault("id", _clip(m.group(1)))
            elif m := _CSS_NAME.match(value):
                out.setdefault("fieldName", _clip(_unescape(m.group(1))))
        # xpath 与长 css 路径不发送
    return out


def redact_condition(cond: Any) -> dict[str, Any] | None:
    if not isinstance(cond, dict):
        return None
    kind = cond.get("kind")
    if kind == "element":
        out: dict[str, Any] = {"kind": "element", "target": redact_locator(cond.get("target"))}
        if isinstance(cond.get("text"), str):
            out["text"] = _clip(cond["text"])
        if cond.get("filled") is True or isinstance(cond.get("minLength"), int):
            out["filled"] = True
        if cond.get("visible") is False:
            out["visible"] = False
        return out
    if kind == "url":
        return {"kind": "url", "pattern": redact_url(cond["pattern"]) if isinstance(cond.get("pattern"), str) else ""}
    if kind == "not":
        return {"kind": "not", "condition": redact_condition(cond.get("condition"))}
    if kind in ("all", "any"):
        items = cond.get("conditions") if isinstance(cond.get("conditions"), list) else []
        return {"kind": kind, "conditions": [redact_condition(x) for x in items]}
    return None


def redact_steps(steps: Any) -> list[dict[str, Any]]:
    """脱敏后的步骤列表（纯函数）：只含发送给 AI 的字段，嵌套的 if / repeat 递归处理。"""
    out: list[dict[str, Any]] = []
    if not isinstance(steps, list):
        return out
    for s in steps:
        if not isinstance(s, dict):
            continue
        t = s.get("type")
        r: dict[str, Any] = {"id": str(s.get("id", "")), "type": t if isinstance(t, str) else "unknown"}
        if "target" in s:
            target = redact_locator(s.get("target"))
            if target:
                r["target"] = target
        if t == "open" and isinstance(s.get("url"), str):
            r["url"] = redact_url(s["url"])
        elif t == "fill" and isinstance(s.get("value"), str):
            r["value"] = redact_value(s["value"])
        elif t == "select" and isinstance(s.get("value"), str):
            r["value"] = _clip(s["value"])  # 页面上的选项值，不是个人数据
        elif t == "check" and isinstance(s.get("checked"), bool):
            r["checked"] = s["checked"]
        elif t == "press" and isinstance(s.get("key"), str):
            r["key"] = _clip(s["key"], 20)
        elif t in ("waitFor", "switchTab"):
            if isinstance(s.get("until"), str):
                r["until"] = s["until"]
            if isinstance(s.get("urlPattern"), str):
                r["urlPattern"] = redact_url(s["urlPattern"])
        elif t == "handoff" and isinstance(s.get("message"), str):
            r["message"] = _clip(s["message"], 200)
        elif t == "extract" and isinstance(s.get("saveAs"), str):
            r["saveAs"] = _clip(s["saveAs"])
        for key in ("condition", "until"):
            if isinstance(s.get(key), dict):
                cond = redact_condition(s[key])
                if cond:
                    r[key] = cond
        for key in CONTAINER_KEYS:
            if isinstance(s.get(key), list):
                r[key] = redact_steps(s[key])
        out.append(r)
    return out


def step_ids(steps: list[dict[str, Any]]) -> list[str]:
    """按出现顺序列出全部步骤 id（含嵌套）。"""
    ids: list[str] = []
    for s in steps:
        if isinstance(s, dict):
            if isinstance(s.get("id"), str) and s["id"] and s["id"] not in ids:
                ids.append(s["id"])
            for key in CONTAINER_KEYS:
                if isinstance(s.get(key), list):
                    ids.extend(i for i in step_ids(s[key]) if i not in ids)
    return ids


def flat_steps(steps: list[Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in steps:
        if isinstance(s, dict):
            out.append(s)
            for key in CONTAINER_KEYS:
                if isinstance(s.get(key), list):
                    out.extend(flat_steps(s[key]))
    return out


def apply_notes(steps: list[Any], texts: dict[str, str]) -> tuple[list[Any], int]:
    """把描述写进步骤的 `note`（只填空的 note，已有的不覆盖），返回 (新步骤列表, 写入条数)。"""
    added = 0
    out: list[Any] = []
    for s in steps:
        if not isinstance(s, dict):
            out.append(s)
            continue
        copy = dict(s)
        sid = s.get("id")
        note = s.get("note")
        if isinstance(sid, str) and texts.get(sid) and not (isinstance(note, str) and note.strip()):
            copy["note"] = texts[sid]
            added += 1
        for key in CONTAINER_KEYS:
            if isinstance(s.get(key), list):
                copy[key], n = apply_notes(s[key], texts)
                added += n
        out.append(copy)
    return out, added


def digest(redacted: list[dict[str, Any]]) -> str:
    raw = json.dumps(redacted, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ---------- 兜底描述 ----------

_WAIT_TEXT = {
    "navigation": "等待页面跳转",
    "newTab": "等待新标签页打开",
    "idle": "等待页面加载完成",
    "delay": "稍等片刻",
    "condition": "等待页面出现内容",
}

_FALLBACK = {
    "open": "打开页面",
    "click": "点击按钮",
    "fill": "填写输入框",
    "select": "选择下拉选项",
    "switchTab": "切换标签页",
    "handoff": "交还给你处理",
    "assert": "检查页面状态",
    "extract": "读取页面内容",
    "if": "按页面情况分支处理",
    "repeat": "反复尝试直到满足条件",
}


def fallback_text(step: dict[str, Any]) -> str:
    """AI 没给出描述时按步骤类型生成的泛化描述（纯函数）。"""
    t = step.get("type")
    if t == "check":
        return "取消勾选" if step.get("checked") is False else "勾选选项"
    if t == "press":
        key = step.get("key")
        return f"按下 {key} 键" if isinstance(key, str) and 0 < len(key) <= 12 else "按下按键"
    if t == "waitFor":
        return _WAIT_TEXT.get(step.get("until"), "等待页面")
    return _FALLBACK.get(t, "执行一步操作")


# ---------- Prompt 与解析 ----------

INSTRUCTIONS = """你是网页自动化流程的解说员。输入是一个浏览器自动化流程的步骤列表（JSON），\
来自用户录制或手写的规则，已经脱敏：
- type 是步骤类型：open 打开页面、click 点击、fill 填写、select 下拉选择、check 勾选、press 按键、\
waitFor 等待、switchTab 切换标签页、handoff 交还给用户手动处理、assert 检查、extract 读取、\
if 条件分支（then / else 是子步骤）、repeat 反复执行（steps 是子步骤）；
- target 是被操作元素可读的线索（role / name / text / testid / id / fieldName），可能为空；
- value 里的 {{profile.x}} 是用户资料、{{secret.x}} 是保险库里的机密，<用户输入，N 个字符> 是用户输入过的内容；
- url / urlPattern 只保留了网站与路径。

请输出整个流程的说明和每一步（包括嵌套的子步骤）的中文描述。只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：
{"summary": "一两句话说明这个流程做什么", "steps": [{"id": "<步骤 id>", "text": "这一步做什么"}]}

要求：
- 每一步的 text 不超过 15 个字，以动词开头，如“点击登录按钮”“选择签证类型”“输入验证码（交还给你）”；
- 只依据输入里出现的信息，不要编造网站名称、按钮文字或用户数据；认不出元素时按类型泛写，如“点击按钮”“填写输入框”；
- 填写 {{profile.x}} / {{secret.x}} 时可按字段名写，如“填写密码”；不要输出占位符本身；
- steps 里的 id 必须原样取自输入，每个步骤一条。"""


def build_prompt(redacted: list[dict[str, Any]]) -> str:
    return json.dumps({"steps": redacted}, ensure_ascii=False, separators=(",", ":"))


_FENCE = re.compile(r"```[A-Za-z]*\s*")


def _first_object(text: str) -> dict[str, Any] | None:
    text = _FENCE.sub("", text)
    decoder = json.JSONDecoder()
    start = text.find("{")
    while start != -1:
        try:
            obj, _ = decoder.raw_decode(text, start)
        except json.JSONDecodeError:
            start = text.find("{", start + 1)
            continue
        if isinstance(obj, dict):
            return obj
        start = text.find("{", start + 1)
    return None


@dataclass
class Notes:
    summary: str
    #: 按步骤顺序，每个 id 一条（缺的已用兜底描述补齐）
    steps: list[dict[str, str]]
    #: 由 AI 给出（而非兜底）的步骤 id
    ai_ids: list[str]

    def text_map(self, *, ai_only: bool = False) -> dict[str, str]:
        keep = set(self.ai_ids)
        return {s["id"]: s["text"] for s in self.steps if not ai_only or s["id"] in keep}

    def to_body(self) -> dict[str, Any]:
        return {"summary": self.summary, "steps": self.steps, "aiIds": self.ai_ids}

    @classmethod
    def from_body(cls, body: dict[str, Any]) -> Notes:
        return cls(summary=body.get("summary") or "", steps=body.get("steps") or [], ai_ids=body.get("aiIds") or [])


def parse_reply(text: str, steps: list[Any]) -> Notes:
    """解析模型回答（容错：去掉代码块围栏、取第一个 JSON 对象）；无法解析时抛 AiFailed。

    `steps` 是原始（或脱敏后）的步骤列表，用来校验 id 与生成兜底描述。
    """
    obj = _first_object(text or "")
    if obj is None:
        raise AiFailed("无法解析 AI 的回答")
    summary = obj.get("summary")
    summary = _clip(summary, 200) if isinstance(summary, str) else ""
    given: dict[str, str] = {}
    items = obj.get("steps")
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            sid, txt = item.get("id"), item.get("text")
            if isinstance(sid, str) and isinstance(txt, str) and txt.strip() and sid not in given:
                given[sid] = _clip(txt.strip(), MAX_TEXT)
    out: list[dict[str, str]] = []
    ai_ids: list[str] = []
    for s in flat_steps(steps):
        sid = s.get("id")
        if not isinstance(sid, str) or not sid or any(x["id"] == sid for x in out):
            continue
        if sid in given:
            out.append({"id": sid, "text": given[sid]})
            ai_ids.append(sid)
        else:
            out.append({"id": sid, "text": fallback_text(s)})
    if not summary and not ai_ids:
        raise AiFailed("AI 的回答里没有可用内容")
    return Notes(summary=summary, steps=out, ai_ids=ai_ids)


# ---------- claude-bridge 客户端 ----------


@dataclass
class Completion:
    text: str
    model: str


class AiClient(Protocol):
    model: str

    async def complete(self, instructions: str, text: str, timeout: float) -> Completion: ...


_TIMEOUT_KINDS = frozenset({"timeout"})


class BridgeClient:
    """claude-bridge 调用方接口：`POST /api/caller/tasks` 提交，`GET /api/caller/tasks/{id}?wait=N` 长轮询。"""

    POLL_WAIT = 20

    def __init__(self, url: str, token: str, model: str, scope: str) -> None:
        self.url = url.rstrip("/")
        self._token = token
        self.model = model
        self.scope = scope

    def _call(self, method: str, path: str, body: dict[str, Any] | None, timeout: float) -> tuple[int, dict[str, Any]]:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            f"{self.url}/api/caller{path}",
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=max(timeout, 1.0)) as res:  # noqa: S310 地址来自配置
                status, raw = res.status, res.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except (TimeoutError, socket.timeout) as e:
            raise AiTimeout() from e
        except urllib.error.URLError as e:
            if isinstance(e.reason, (TimeoutError, socket.timeout)):
                raise AiTimeout() from e
            raise AiFailed(f"连接 claude-bridge 失败：{type(e.reason).__name__}") from e
        except OSError as e:
            raise AiFailed(f"连接 claude-bridge 失败：{type(e).__name__}") from e
        try:
            parsed = json.loads(raw or b"{}")
        except ValueError:
            parsed = {}
        return status, parsed if isinstance(parsed, dict) else {}

    def _fail(self, stage: str, status: int, body: dict[str, Any]) -> AiError:
        kind = body.get("error_kind")
        log.warning("claude-bridge %s 失败：HTTP %s，%s", stage, status, kind or "-")
        return AiTimeout() if kind in _TIMEOUT_KINDS else AiFailed(f"{stage} {status} {kind or ''}".strip())

    def _run(self, instructions: str, text: str, timeout: float) -> Completion:
        deadline = time.monotonic() + timeout
        status, body = self._call(
            "POST",
            "/tasks",
            {
                "text": text,
                "scope": self.scope,
                "options": {"model": self.model, "instructions": instructions, "max_turns": 1, "thinking": False},
                # bridge 侧到点自动取消（排队时间也算）；接受 5 到 900 秒
                "timeout": int(min(max(timeout, 5), 900)),
                "require_online": True,
            },
            min(15.0, timeout),
        )
        task_id = body.get("task_id")
        if status != 201 or not isinstance(task_id, str):
            raise self._fail("提交", status, body)
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                self._cancel(task_id)
                raise AiTimeout()
            wait = int(max(0, min(self.POLL_WAIT, left - 1)))
            status, body = self._call("GET", f"/tasks/{task_id}?wait={wait}", None, wait + 10)
            if status != 200:
                raise self._fail("轮询", status, body)
            st = body.get("status")
            if st == "done":
                return Completion(text=body.get("text") or "", model=body.get("model") or self.model)
            if st in ("failed", "cancelled"):
                raise self._fail("任务", status, body)

    def _cancel(self, task_id: str) -> None:
        try:
            self._call("POST", f"/tasks/{task_id}/cancel", {}, 5)
        except AiError:
            pass

    async def complete(self, instructions: str, text: str, timeout: float) -> Completion:
        return await asyncio.to_thread(self._run, instructions, text, timeout)


def get_client(state: Any) -> AiClient | None:
    """当前应用的 AI 客户端：测试可预先放入 `app.state.ai_client`；未配置时为 None。"""
    client = getattr(state, "ai_client", None)
    if client is not None:
        return client
    config: Config = state.config
    if not config.ai_configured:
        return None
    client = BridgeClient(config.bridge_url, config.bridge_token, config.bridge_model, config.bridge_scope)
    state.ai_client = client
    return client


async def describe(client: AiClient | None, redacted: list[dict[str, Any]], timeout: float) -> tuple[Notes, str]:
    """调用 AI 生成描述，返回 (结果, 模型)。整体超时 `timeout` 秒。"""
    if client is None:
        raise AiUnavailable()
    try:
        result = await asyncio.wait_for(client.complete(INSTRUCTIONS, build_prompt(redacted), timeout), timeout)
    except TimeoutError as e:
        raise AiTimeout() from e
    except AiError:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("AI 调用异常：%s", type(e).__name__)
        raise AiFailed() from e
    try:
        notes = parse_reply(result.text, redacted)
    except AiFailed:
        log.warning("AI 回答无法解析（%d 个字符）", len(result.text or ""))
        raise
    return notes, result.model or client.model
