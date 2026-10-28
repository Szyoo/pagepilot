"""规则校验：与扩展 `src/schema/rule.ts`（含 superRefine）保持一致的纯 Python 实现。

与 Zod 的行为对齐：
- 先做结构校验（字段类型、必填、枚举、数组最少条数）；结构有误时不做后续的语义检查；
- 可选字段可以缺省，但不能是 null；未知字段忽略（不参与占位符检查）；
- 语义检查：match.urls 不匹配全部网站、步骤 id 唯一（含 login.steps 与嵌套）、if/repeat 嵌套 ≤ 3、
  `{{secret.x}}` 只在 fill.value、requires 覆盖全部占位符、waitFor / handoff 字段组合。
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterator
from typing import Any

MAX_NESTING = 3

# 与 src/shared/template.ts 一致：`\{{` 是转义，不算占位符
PLACEHOLDER_RE = re.compile(r"\\\{\{|\{\{\s*(profile|secret|var)\.([A-Za-z0-9_.-]+)\s*\}\}")

# 与 src/shared/glob.ts 的 isMatchAll 一致（JS 的 `.` 不匹配四种行终止符）
_MATCH_ALL_RE = re.compile(r"(?:\*|https?|http\*)://\*(?:/[^\n\r  ]*)?")

_SAFE_INT = 2**53 - 1

LOCATOR_KINDS = ("css", "aria", "text", "xpath", "testid")
CONDITION_KINDS = ("element", "url", "not", "all", "any")
STEP_TYPES = (
    "open", "click", "fill", "select", "check", "press", "waitFor", "switchTab",
    "handoff", "assert", "extract", "if", "repeat",
)
CONTAINER_KEYS = ("then", "else", "steps")


def extract_placeholders(text: str) -> list[tuple[str, str]]:
    return [(m[1], m[2]) for m in PLACEHOLDER_RE.finditer(text) if m[1] and m[2]]


def is_match_all(glob: str) -> bool:
    if glob in ("<all_urls>", "*"):
        return True
    return _MATCH_ALL_RE.fullmatch(glob) is not None


# ---------- 结构校验 ----------

Path = tuple[str | int, ...]


def _fmt(path: Path) -> str:
    return ".".join(str(p) for p in path)


class _Checker:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def err(self, path: Path, message: str) -> None:
        self.errors.append(f"{_fmt(path)}: {message}" if path else message)

    # 基本类型
    def string(self, v: Any, path: Path, *, min_len: int = 0) -> bool:
        if not isinstance(v, str):
            self.err(path, "需要字符串")
            return False
        if len(v) < min_len:
            self.err(path, "不能为空")
            return False
        return True

    def boolean(self, v: Any, path: Path) -> bool:
        if not isinstance(v, bool):
            self.err(path, "需要布尔值")
            return False
        return True

    def number(self, v: Any, path: Path) -> bool:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (
            isinstance(v, float) and not math.isfinite(v)
        ):
            self.err(path, "需要数字")
            return False
        return True

    def integer(self, v: Any, path: Path, *, minimum: int | None = None) -> bool:
        if not self.number(v, path):
            return False
        if isinstance(v, float) and not v.is_integer() or abs(v) > _SAFE_INT:
            self.err(path, "需要整数")
            return False
        if minimum is not None and v < minimum:
            self.err(path, "需要正整数" if minimum == 1 else f"不能小于 {minimum}")
            return False
        return True

    def enum(self, v: Any, path: Path, options: tuple[str, ...]) -> bool:
        if v not in options or not isinstance(v, str):
            self.err(path, f"取值必须是 {' / '.join(options)}")
            return False
        return True

    def obj(self, v: Any, path: Path) -> bool:
        if not isinstance(v, dict):
            self.err(path, "需要对象")
            return False
        return True

    def array(self, v: Any, path: Path, item: Callable[[Any, Path], Any], *, min_items: int = 0) -> bool:
        if not isinstance(v, list):
            self.err(path, "需要数组")
            return False
        if len(v) < min_items:
            self.err(path, f"至少需要 {min_items} 项")
        for i, x in enumerate(v):
            item(x, (*path, i))
        return True

    def field(self, o: dict, key: str, path: Path, check: Callable[[Any, Path], Any], *, optional: bool = False) -> None:
        if key not in o:
            if not optional:
                self.err((*path, key), "必填")
            return
        check(o[key], (*path, key))

    # 复合结构
    def locator(self, v: Any, path: Path) -> None:
        if not self.obj(v, path):
            return

        def strategy(s: Any, p: Path) -> None:
            if self.obj(s, p):
                self.field(s, "kind", p, lambda x, q: self.enum(x, q, LOCATOR_KINDS))
                self.field(s, "value", p, lambda x, q: self.string(x, q, min_len=1))

        self.field(v, "strategies", path, lambda x, p: self.array(x, p, strategy, min_items=1))
        self.field(v, "frame", path, lambda x, p: self.array(x, p, self.string), optional=True)

    def condition(self, v: Any, path: Path) -> None:
        if not self.obj(v, path):
            return
        kind = v.get("kind")
        if not self.enum(kind, (*path, "kind"), CONDITION_KINDS):
            return
        if kind == "element":
            self.field(v, "target", path, self.locator)
            self.field(v, "visible", path, self.boolean, optional=True)
            self.field(v, "text", path, self.string, optional=True)
            self.field(v, "textMatch", path, self.string, optional=True)
            self.field(v, "filled", path, self.boolean, optional=True)
            self.field(v, "minLength", path, lambda x, p: self.integer(x, p, minimum=1), optional=True)
        elif kind == "url":
            self.field(v, "pattern", path, lambda x, p: self.string(x, p, min_len=1))
        elif kind == "not":
            self.field(v, "condition", path, self.condition)
        else:
            self.field(v, "conditions", path, lambda x, p: self.array(x, p, self.condition, min_items=1))

    def steps(self, v: Any, path: Path, *, min_items: int = 1) -> None:
        self.array(v, path, self.step, min_items=min_items)

    def step(self, v: Any, path: Path) -> None:
        if not self.obj(v, path):
            return
        t = v.get("type")
        if not isinstance(t, str) or t not in STEP_TYPES:
            self.err((*path, "type"), f"未知的步骤类型：{t}" if isinstance(t, str) else "缺少步骤类型")
            return
        f = lambda key, check, optional=False: self.field(v, key, path, check, optional=optional)  # noqa: E731
        f("id", lambda x, p: self.string(x, p, min_len=1))
        f("note", self.string, True)
        f("timeoutMs", lambda x, p: self.integer(x, p, minimum=1), True)
        f("retries", lambda x, p: self.integer(x, p, minimum=0), True)
        f("optional", self.boolean, True)
        pos = lambda x, p: self.integer(x, p, minimum=1)  # noqa: E731
        if t == "open":
            f("url", self.string)
            f("newTab", self.boolean, True)
            f("force", self.boolean, True)
        elif t == "click":
            f("target", self.locator)
        elif t == "fill":
            f("target", self.locator)
            f("value", self.string)
            f("clear", self.boolean, True)
        elif t == "select":
            f("target", self.locator)
            f("value", self.string)
        elif t == "check":
            f("target", self.locator)
            f("checked", self.boolean)
        elif t == "press":
            f("key", lambda x, p: self.string(x, p, min_len=1))
            f("target", self.locator, True)
        elif t == "waitFor":
            f("until", lambda x, p: self.enum(x, p, ("condition", "navigation", "newTab", "idle", "delay")))
            f("condition", self.condition, True)
            f("urlPattern", self.string, True)
            f("delayMs", pos, True)
        elif t == "switchTab":
            f("urlPattern", lambda x, p: self.string(x, p, min_len=1))
        elif t == "handoff":
            f("message", self.string)
            f("resumeWhen", lambda x, p: self.enum(x, p, ("userConfirm", "navigation", "condition")), True)
            f("until", self.condition, True)
            f("final", self.boolean, True)
        elif t == "assert":
            f("condition", self.condition)
        elif t == "extract":
            f("target", self.locator)
            f("saveAs", lambda x, p: self.string(x, p, min_len=1))
            f("attr", self.string, True)
        elif t == "if":
            f("condition", self.condition)
            f("then", self.steps)
            f("else", lambda x, p: self.steps(x, p, min_items=0), True)
        elif t == "repeat":
            f("steps", self.steps)
            f("until", self.condition)
            f("reload", self.boolean, True)
            f("intervalMs", pos, True)
            f("jitterMs", lambda x, p: self.integer(x, p, minimum=0), True)
            f("maxAttempts", pos, True)
            f("maxDurationMs", pos, True)
            f("onExhausted", lambda x, p: self.enum(x, p, ("fail", "handoff")), True)
            f("notify", self.boolean, True)
            f("sound", self.boolean, True)

    def rule(self, r: Any) -> None:
        if not self.obj(r, ()):
            return
        f = lambda key, check, optional=False: self.field(r, key, (), check, optional=optional)  # noqa: E731
        f("id", lambda x, p: self.string(x, p, min_len=1))
        f("name", self.string)
        f("version", lambda x, p: self.integer(x, p, minimum=0))
        f("enabled", self.boolean, True)
        f("trigger", lambda x, p: self.enum(x, p, ("manual", "auto")), True)
        f("inputMode", lambda x, p: self.enum(x, p, ("auto", "trusted", "synthetic")), True)

        def match(m: Any, p: Path) -> None:
            if self.obj(m, p):
                url = lambda x, q: self.string(x, q, min_len=1)  # noqa: E731
                self.field(m, "urls", p, lambda x, q: self.array(x, q, url, min_items=1))
                self.field(m, "exclude", p, lambda x, q: self.array(x, q, url), optional=True)

        def requires(q: Any, p: Path) -> None:
            if self.obj(q, p):
                for key in ("profile", "secret"):
                    self.field(q, key, p, lambda x, pp: self.array(x, pp, self.string), optional=True)

        def login(lg: Any, p: Path) -> None:
            if self.obj(lg, p):
                self.field(lg, "loggedIn", p, self.condition)
                self.field(lg, "steps", p, self.steps)

        f("match", match)
        f("requires", requires, True)
        f("login", login, True)
        f("steps", self.steps)


# ---------- 语义检查（对应 superRefine） ----------

# 每种步骤 Zod 解析后保留的字段（含默认值字段）；占位符只在这些字段里找
_BASE_KEYS = ("id", "note", "timeoutMs", "retries", "optional", "type")
_STEP_KEYS: dict[str, tuple[str, ...]] = {
    "open": ("url", "newTab", "force"),
    "click": ("target",),
    "fill": ("target", "value", "clear"),
    "select": ("target", "value"),
    "check": ("target", "checked"),
    "press": ("key", "target"),
    "waitFor": ("until", "condition", "urlPattern", "delayMs"),
    "switchTab": ("urlPattern",),
    "handoff": ("message", "resumeWhen", "until", "final"),
    "assert": ("condition",),
    "extract": ("target", "saveAs", "attr"),
    "if": ("condition",),
    "repeat": ("until", "reload", "intervalMs", "jitterMs", "maxAttempts", "maxDurationMs",
               "onExhausted", "notify", "sound"),
}

# Zod 的条件对象同样会去掉未知字段
_CONDITION_KEYS = {
    "element": ("kind", "target", "visible", "text", "textMatch", "filled", "minLength"),
    "url": ("kind", "pattern"),
    "not": ("kind", "condition"),
    "all": ("kind", "conditions"),
    "any": ("kind", "conditions"),
}


def _strings(v: Any, *, condition: bool = False) -> Iterator[str]:
    if isinstance(v, str):
        yield v
    elif isinstance(v, list):
        for x in v:
            yield from _strings(x, condition=condition)
    elif isinstance(v, dict):
        if condition and v.get("kind") in _CONDITION_KEYS:
            for k in _CONDITION_KEYS[v["kind"]]:
                if k in v:
                    yield from _strings(v[k], condition=k in ("condition", "conditions"))
            return
        for k, x in v.items():
            # 定位器里只有 strategies[].kind/value 与 frame
            if k in ("strategies", "frame", "kind", "value"):
                yield from _strings(x)


def step_strings(step: dict) -> Iterator[tuple[str, str]]:
    """步骤自身的全部字符串字段（不含子步骤），返回 (文本, 顶层字段名)。"""
    t = step.get("type")
    for key in (*_BASE_KEYS, *_STEP_KEYS.get(t, ())):
        if key not in step:
            continue
        value = step[key]
        is_cond = key in ("condition", "until") and isinstance(value, dict)
        for text in _strings(value, condition=is_cond):
            yield text, key


def flatten_steps(rule: dict) -> list[dict]:
    out: list[dict] = []

    def walk(steps: list) -> None:
        for s in steps:
            out.append(s)
            if s.get("type") == "if":
                walk(s.get("then", []))
                walk(s.get("else", []))
            elif s.get("type") == "repeat":
                walk(s.get("steps", []))

    login = rule.get("login")
    if isinstance(login, dict):
        walk(login.get("steps", []))
    walk(rule.get("steps", []))
    return out


def required_placeholders(steps: list[dict]) -> dict[str, list[str]]:
    """按出现顺序收集步骤里的 profile / secret 占位符键（用于从录制推导 requires）。"""
    need: dict[str, list[str]] = {"profile": [], "secret": []}
    for step in flatten_steps({"steps": steps}):
        for text, _ in step_strings(step):
            for scope, key in extract_placeholders(text):
                if scope in need and key not in need[scope]:
                    need[scope].append(key)
    return need


def _refine(rule: dict) -> list[str]:
    errors: list[str] = []

    def issue(message: str, path: Path = ()) -> None:
        errors.append(f"{_fmt(path)}: {message}" if path else message)

    for i, u in enumerate(rule["match"]["urls"]):
        if is_match_all(u):
            issue("match.urls 不允许匹配全部网站", ("match", "urls", i))

    ids: set[str] = set()
    need: dict[str, list[str]] = {"profile": [], "secret": []}

    def check_step(step: dict, at: Path) -> None:
        for text, field in step_strings(step):
            for scope, key in extract_placeholders(text):
                if scope == "var":
                    continue
                if scope == "secret" and not (step["type"] == "fill" and field == "value"):
                    issue("{{secret.x}} 只能出现在 fill 步骤的 value 中", (*at, field))
                if key not in need[scope]:
                    need[scope].append(key)
        if step["type"] == "waitFor":
            if step["until"] == "condition" and "condition" not in step:
                issue("waitFor(condition) 需要 condition", at)
            if step["until"] == "delay" and not step.get("delayMs"):
                issue("waitFor(delay) 需要 delayMs", at)
        if (
            step["type"] == "handoff"
            and step.get("resumeWhen", "userConfirm") == "condition"
            and "until" not in step
        ):
            issue("handoff(condition) 需要 until", at)

    def visit(steps: list[dict], depth: int, path: Path) -> None:
        for i, step in enumerate(steps):
            at = (*path, i)
            if step["id"] in ids:
                issue(f"步骤 id 重复：{step['id']}", (*at, "id"))
            ids.add(step["id"])
            check_step(step, at)
            if step["type"] in ("if", "repeat"):
                if depth + 1 > MAX_NESTING:
                    issue(f"嵌套超过 {MAX_NESTING} 层", at)
                if step["type"] == "if":
                    visit(step["then"], depth + 1, (*at, "then"))
                    if "else" in step:
                        visit(step["else"], depth + 1, (*at, "else"))
                else:
                    visit(step["steps"], depth + 1, (*at, "steps"))

    if "login" in rule:
        visit(rule["login"]["steps"], 0, ("login", "steps"))
    visit(rule["steps"], 0, ("steps",))

    requires = rule.get("requires", {})
    for scope in ("profile", "secret"):
        declared = requires.get(scope, [])
        for key in need[scope]:
            if key not in declared:
                issue(f"requires.{scope} 缺少 {key}", ("requires",))
    return errors


def validate_rule(rule: Any) -> list[str]:
    """返回错误列表；空列表表示通过。"""
    checker = _Checker()
    checker.rule(rule)
    if checker.errors:
        return checker.errors
    return _refine(rule)
