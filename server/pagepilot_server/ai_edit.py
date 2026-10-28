"""AI 修改：用自然语言修改已有规则，返回提案（不保存）。

- 发送前把规则里用户录入的字面值换成记号（`mask_rule_values`）：`fill` / `select` 的 `value`
  （纯占位符除外）换成 `«值N»`；网址的查询串与 `#` 之后的部分换成 `«参数N»`。
  模型返回后用记号表还原（`unmask_rule_values`）；模型输出了表里没有的记号视为错误。
- 解析模型输出（容错同 AI 解读），强制 `id` 不变、`version = 当前版本 + 1`，用 `validate_rule` 校验；
  不通过时把错误与上次输出发回模型自动修复一次，仍不通过就把错误随提案返回。
- 日志不记录发送的内容与模型的回答。
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from .ai import _PLACEHOLDER, AiClient, AiError, AiFailed, AiTimeout, AiUnavailable, _clip, _first_object
from .rules import CONTAINER_KEYS, validate_rule

log = logging.getLogger("pagepilot_server.ai")

MAX_INSTRUCTION = 2000
MAX_CHANGES = 30

_TOKEN = re.compile(r"«(?:值|参数)\d+»")


# ---------- 字面值换记号 ----------


class _Masker:
    def __init__(self) -> None:
        self.table: dict[str, str] = {}
        self._by_value: dict[tuple[str, str], str] = {}
        self._n = {"值": 0, "参数": 0}

    def token(self, kind: str, original: str) -> str:
        key = (kind, original)
        if key not in self._by_value:
            self._n[kind] += 1
            tok = f"«{kind}{self._n[kind]}»"
            self._by_value[key] = tok
            self.table[tok] = original
        return self._by_value[key]

    def value(self, v: Any) -> Any:
        """`fill` / `select` 的值：空串与纯占位符原样保留，其余整体换成 `«值N»`。"""
        if not isinstance(v, str) or not _PLACEHOLDER.sub("", v).strip():
            return v
        return self.token("值", v)

    def url(self, v: Any) -> Any:
        """网址 / glob：保留 `?` 或 `#` 之前的部分，之后的整段换成 `«参数N»`。"""
        if not isinstance(v, str):
            return v
        m = re.search(r"[?#]", v)
        if not m or m.end() == len(v):
            return v
        return v[: m.end()] + self.token("参数", v[m.end():])

    def condition(self, c: Any) -> Any:
        if not isinstance(c, dict):
            return c
        out = dict(c)
        kind = c.get("kind")
        if kind == "url" and "pattern" in c:
            out["pattern"] = self.url(c["pattern"])
        elif kind == "not" and "condition" in c:
            out["condition"] = self.condition(c["condition"])
        elif kind in ("all", "any") and isinstance(c.get("conditions"), list):
            out["conditions"] = [self.condition(x) for x in c["conditions"]]
        return out

    def steps(self, steps: Any) -> Any:
        if not isinstance(steps, list):
            return steps
        out: list[Any] = []
        for s in steps:
            if not isinstance(s, dict):
                out.append(s)
                continue
            r = dict(s)
            t = s.get("type")
            if t in ("fill", "select") and "value" in s:
                r["value"] = self.value(s["value"])
            if t == "open" and "url" in s:
                r["url"] = self.url(s["url"])
            if t in ("waitFor", "switchTab") and "urlPattern" in s:
                r["urlPattern"] = self.url(s["urlPattern"])
            for key in ("condition", "until"):
                if isinstance(s.get(key), dict):
                    r[key] = self.condition(s[key])
            for key in CONTAINER_KEYS:
                if isinstance(s.get(key), list):
                    r[key] = self.steps(s[key])
            out.append(r)
        return out


def mask_rule_values(rule: Any) -> tuple[Any, dict[str, str]]:
    """把规则里的字面值换成记号（纯函数），返回 (脱敏后的规则, 记号 → 原值)。

    - `fill` / `select` 的 `value`：不是纯占位符（`{{profile.x}}` / `{{secret.x}}` / `{{var.x}}`）时整体换成
      `«值N»`，同一个值复用同一个记号；
    - `open.url`、`waitFor` / `switchTab` 的 `urlPattern`、`url` 条件的 `pattern`、`match.urls` / `exclude`：
      保留网站与路径，`?` 或 `#` 之后的整段换成 `«参数N»`；
    - 其他（定位器、`element` 条件的文字、`assert`、`handoff.message`、`note`、`name`）原样保留。
    """
    if not isinstance(rule, dict):
        return rule, {}
    m = _Masker()
    out = copy.deepcopy(rule)
    match = out.get("match")
    if isinstance(match, dict):
        for key in ("urls", "exclude"):
            if isinstance(match.get(key), list):
                match[key] = [m.url(u) for u in match[key]]
    login = out.get("login")
    if isinstance(login, dict):
        if isinstance(login.get("loggedIn"), dict):
            login["loggedIn"] = m.condition(login["loggedIn"])
        login["steps"] = m.steps(login.get("steps"))
    if "steps" in out:
        out["steps"] = m.steps(out["steps"])
    return out, m.table


def unmask_rule_values(rule: Any, table: dict[str, str]) -> tuple[Any, list[str]]:
    """把记号还原成原值（纯函数），返回 (还原后的规则, 未知记号列表)。

    所有字符串字段都会替换（模型可能把值挪到新步骤里）；模型新增的字面值原样保留；
    不在记号表里的 `«值N»` / `«参数N»` 原样留下并记入未知列表。
    """
    unknown: list[str] = []

    def text(s: str) -> str:
        def sub(m: re.Match[str]) -> str:
            tok = m.group(0)
            if tok in table:
                return table[tok]
            if tok not in unknown:
                unknown.append(tok)
            return tok

        return _TOKEN.sub(sub, s)

    def walk(v: Any) -> Any:
        if isinstance(v, str):
            return text(v)
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v

    return walk(rule), unknown


# ---------- Prompt ----------

INSTRUCTIONS = """你是网页自动化规则的编辑助手。输入是一条浏览器自动化规则（JSON）和用户的修改要求，\
请按要求修改规则，输出修改后的完整规则。

规则格式（精简）：
- 顶层：id、name、version、enabled?、trigger（manual / auto）、inputMode（auto / trusted / synthetic）、\
match（urls：URL glob 列表至少一条，不能匹配全部网站，如 <all_urls>、*://*/*；exclude?）、\
requires（profile / secret：规则用到的占位符键名，必须覆盖规则里全部 {{profile.x}} 与 {{secret.x}}）、\
login?（loggedIn 条件 + steps，判断未登录时先执行）、steps（至少一步）。
- 定位器 target：{"strategies": [{"kind": "css|aria|text|xpath|testid", "value": "…"}], "frame"?: [iframe 选择器]}，按顺序尝试。
- 条件：{"kind": "element", "target", "visible"?, "text"?, "textMatch"?(正则), "filled"?, "minLength"?} | \
{"kind": "url", "pattern": glob} | {"kind": "not", "condition"} | {"kind": "all"|"any", "conditions": [...]}。
- 所有步骤有 id（规则内唯一，含 login.steps 与嵌套）、type，可选 note（步骤说明）、timeoutMs、retries、optional。
- 步骤类型：open{url, newTab?}；click{target}；fill{target, value, clear?}；select{target, value}；\
check{target, checked}；press{key, target?}；switchTab{urlPattern}；extract{target, saveAs, attr?}（保存为 {{var.<saveAs>}}）；\
assert{condition}；waitFor{until: condition|navigation|newTab|idle|delay}（condition 需要 condition 字段，\
delay 需要 delayMs，navigation / newTab 可选 urlPattern）；\
handoff{message, resumeWhen?: userConfirm|navigation|condition, until?, final?}（resumeWhen 为 condition 时必须有 until）；\
if{condition, then: [步骤], else?: [步骤]}；\
repeat{steps: [步骤], until: 条件, reload?, intervalMs?(默认 5000，不低于 3000), jitterMs?, maxAttempts?(默认 100), \
maxDurationMs?, onExhausted?: fail|handoff, notify?, sound?}（每轮执行 steps 后判断 until，成立即退出；\
reload 为 true 时从第 2 轮起每轮先刷新页面）。
- if / repeat 嵌套不超过 3 层；login.steps 里不能再有 login。
- 占位符：{{profile.x}} 个人信息、{{secret.x}} 保险库凭据（只能出现在 fill.value）、{{var.x}} extract 保存的值。

输入里的记号：
- «值N» 是用户录入的具体值，已在本机替换为记号；需要保留时原样写出记号（可以移动或复制到别的步骤），\
不要猜测它的内容，也不要自己编造新的 «值N»；修改要求里明确给出新的具体值时直接写那个值；
- «参数N» 是网址里查询参数的记号，原样保留。

只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：
{"rule": {修改后的完整规则}, "summary": "一两句话说明改了什么", "changes": ["逐条说明每一处修改"]}

要求：
- 只改修改要求涉及的部分，其余内容（尤其步骤 id、note、定位器、顺序）保持原样；id 字段不要改；
- 新增步骤用规则里没有用过的新 id（如在 s5 之后新增可用 s5a、s5b），并给新步骤写简短的中文 note；
- 用户说“第 N 步”时按 steps 里的顺序（从 1 开始，不含 login.steps）理解；
- 不要编造网站上不存在的元素：需要定位元素时优先复用规则里已有的定位器；确实没有时用最可能的写法，\
并在 changes 里注明“需要确认定位”；
- 用到新的占位符时同步更新 requires；
- 无法按要求修改时原样返回规则，并在 summary 里说明原因。"""


def build_prompt(masked_rule: Any, instruction: str) -> str:
    rule_json = json.dumps(masked_rule, ensure_ascii=False, indent=1)
    return f"修改要求：\n{instruction}\n\n当前规则（JSON）：\n{rule_json}"


def build_repair_prompt(masked_rule: Any, instruction: str, previous: Any, errors: list[str]) -> str:
    prev_json = json.dumps(previous, ensure_ascii=False, indent=1)
    lines = "\n".join(f"- {e}" for e in errors)
    return (
        build_prompt(masked_rule, instruction)
        + f"\n\n你上次输出的规则没有通过校验，错误如下：\n{lines}\n\n上次输出的规则：\n{prev_json}\n\n"
        "请在上次输出的基础上修正这些错误（其他修改保留），按同样的格式重新输出完整的 JSON 对象。"
    )


# ---------- 解析与校验 ----------


@dataclass
class Attempt:
    #: 模型输出的规则（仍是记号形式，用于自动修复时发回）
    raw_rule: Any
    #: 还原记号、强制 id / version 后的规则
    rule: dict[str, Any]
    summary: str
    changes: list[str]
    errors: list[str] = field(default_factory=list)


def parse_edit(text: str) -> dict[str, Any] | None:
    """取出模型回答里的 JSON 对象（容错同 AI 解读）；没有对象或没有 `rule` 对象时返回 None。"""
    obj = _first_object(text or "")
    if obj is None or not isinstance(obj.get("rule"), dict):
        return None
    return obj


def finish_attempt(obj: dict[str, Any], table: dict[str, str], rule_id: str, version: int) -> Attempt:
    """还原记号、强制 id 不变与 version，校验，得到一次提案。"""
    raw = obj["rule"]
    restored, unknown = unmask_rule_values(raw, table)
    restored = dict(restored)
    restored["id"] = rule_id
    restored["version"] = version
    summary = obj.get("summary")
    summary = _clip(summary, 400) if isinstance(summary, str) else ""
    changes = [
        _clip(x, 300) for x in (obj.get("changes") if isinstance(obj.get("changes"), list) else [])
        if isinstance(x, str) and x.strip()
    ][:MAX_CHANGES]
    errors = [f"AI 输出了未知的记号 {tok}（不是你录入过的值），请改成具体的值" for tok in unknown]
    errors += validate_rule(restored)
    return Attempt(raw_rule=raw, rule=restored, summary=summary, changes=changes, errors=errors)


async def _complete(client: AiClient, text: str, timeout: float) -> str:
    try:
        result = await asyncio.wait_for(client.complete(INSTRUCTIONS, text, timeout), timeout)
    except TimeoutError as e:
        raise AiTimeout() from e
    except AiError:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("AI 调用异常：%s", type(e).__name__)
        raise AiFailed() from e
    return result.text or ""


@dataclass
class Proposal:
    rule: dict[str, Any]
    summary: str
    changes: list[str]
    errors: list[str]
    repaired: bool
    model: str

    def to_body(self) -> dict[str, Any]:
        return {
            "rule": self.rule,
            "summary": self.summary,
            "changes": self.changes,
            "errors": self.errors,
            "repaired": self.repaired,
            "model": self.model,
        }


async def propose_edit(
    client: AiClient | None, base: dict[str, Any], instruction: str, rule_id: str, version: int, timeout: float
) -> Proposal:
    """生成修改提案：调用一次，校验不通过时自动修复一次。每次调用各自超时 `timeout` 秒。"""
    if client is None:
        raise AiUnavailable()
    masked, table = mask_rule_values(base)
    model = client.model
    text = await _complete(client, build_prompt(masked, instruction), timeout)
    obj = parse_edit(text)
    first = finish_attempt(obj, table, rule_id, version) if obj else None
    if first is not None and not first.errors:
        return Proposal(first.rule, first.summary, first.changes, [], False, model)

    if first is None:
        log.warning("AI 修改的回答无法解析（%d 个字符），自动重试一次", len(text))
        previous: Any = {"说明": "上次的回答里没有找到 JSON 对象或 rule 字段"}
        errors = ["回答必须是一个 JSON 对象，且包含 rule 对象"]
    else:
        previous, errors = first.raw_rule, first.errors
    try:
        text2 = await _complete(client, build_repair_prompt(masked, instruction, previous, errors), timeout)
    except AiError as e:
        if first is None:
            raise
        # 自动修复的那次调用失败：返回第一次的提案与错误
        return Proposal(first.rule, first.summary, first.changes,
                        [*first.errors, f"自动修复失败：{e.detail}"], False, model)
    obj2 = parse_edit(text2)
    if obj2 is None:
        if first is None:
            log.warning("AI 修改的回答仍无法解析（%d 个字符）", len(text2))
            raise AiFailed("无法解析 AI 的回答")
        return Proposal(first.rule, first.summary, first.changes,
                        [*first.errors, "自动修复失败：AI 的回答无法解析"], False, model)
    second = finish_attempt(obj2, table, rule_id, version)
    summary = second.summary or (first.summary if first else "")
    changes = second.changes or (first.changes if first else [])
    return Proposal(second.rule, summary, changes, second.errors, True, model)
