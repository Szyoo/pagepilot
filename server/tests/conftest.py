from __future__ import annotations

import copy
import json
import re
import uuid
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pagepilot_server.app import create_app
from pagepilot_server.config import Config

ADMIN = {"X-Portal-Sub": "sub-admin", "X-Role": "admin"}
USER = {"X-Portal-Sub": "sub-alice", "X-Role": "user"}
USER2 = {"X-Portal-Sub": "sub-bob"}

REPO_ROOT = Path(__file__).resolve().parents[2]


def load_doc_example() -> dict:
    """docs/rules.md 末尾的完整示例规则。"""
    text = (REPO_ROOT / "docs" / "rules.md").read_text(encoding="utf-8")
    blocks = re.findall(r"```json\n(.*?)```", text, flags=re.S)
    return json.loads(blocks[-1])


DOC_EXAMPLE = load_doc_example()


def simple_rule(rule_id: str = "r1", version: int = 1, **extra) -> dict:
    rule = {
        "id": rule_id,
        "name": f"规则 {rule_id}",
        "version": version,
        "match": {"urls": ["https://example.com/*"]},
        "steps": [{"id": "s1", "type": "open", "url": "https://example.com/"}],
    }
    rule.update(extra)
    return rule


def doc_rule() -> dict:
    return copy.deepcopy(DOC_EXAMPLE)


def make_config(tmp_path: Path, **overrides) -> Config:
    base = Config(
        sso=True,
        data_dir=tmp_path / "data",
        ping_interval=0.2,
        idle_timeout=1.0,
        keepalive_interval=0.2,
    )
    return replace(base, **overrides)


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator:
    clients: list[TestClient] = []

    def _make(**overrides) -> TestClient:
        app = create_app(make_config(tmp_path, **overrides))
        c = TestClient(app)
        c.__enter__()  # 触发 lifespan：建库、首轮清理；所有请求共用同一个事件循环
        clients.append(c)
        return c

    yield _make
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


def msg(kind: str, **fields) -> dict:
    return {"v": 1, "kind": kind, "id": str(uuid.uuid4()), **fields}


def hello(last_seq: int | None = None) -> dict:
    fields = {"clientId": "client-1", "extVersion": "0.1.0", "ruleSchemaVersion": 1}
    if last_seq is not None:
        fields["lastSeq"] = last_seq
    return msg("hello", **fields)


def put_rule(c: TestClient, rule: dict, headers: dict, shared: bool | None = None):
    body: dict = {"rule": rule}
    if shared is not None:
        body["shared"] = shared
    return c.put(f"/api/rules/{rule['id']}", json=body, headers=headers)


def poll(c: TestClient, headers: dict, since: int | None = None) -> list[dict]:
    url = "/api/ext/poll" if since is None else f"/api/ext/poll?since={since}"
    r = c.get(url, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["messages"]


def capture(**extra) -> dict:
    base = msg(
        "capture",
        pageUrl="https://example.com/form",
        title="表单",
        capturedAt=1760000000000,
        elements=[
            {
                "tag": "input",
                "attrs": {"type": "text"},
                "locator": {"strategies": [{"kind": "css", "value": "#user"}]},
                "sensitive": False,
            }
        ],
    )
    base.update(extra)
    return base


def recording(recording_id: str = "rec-1", steps: list | None = None) -> dict:
    return msg(
        "recording",
        recordingId=recording_id,
        startedAt=1760000000000,
        steps=steps
        if steps is not None
        else [
            {"id": "s1", "type": "open", "url": "https://example.com/form"},
            {
                "id": "s2",
                "type": "fill",
                "target": {"strategies": [{"kind": "css", "value": "#name"}]},
                "value": "{{profile.name}}",
            },
            {
                "id": "s3",
                "type": "fill",
                "target": {"strategies": [{"kind": "css", "value": "#pass"}]},
                "value": "{{secret.pass}}",
            },
        ],
    )


def run_report(run_id: str = "run-1", rule_id: str = "r1", started: int = 1760000000000) -> dict:
    return msg(
        "runReport",
        runId=run_id,
        ruleId=rule_id,
        ruleVersion=1,
        trigger="manual",
        startedAt=started,
        endedAt=started + 1000,
        status="succeeded",
        inputMode="trusted",
        steps=[{"stepId": "s1", "status": "succeeded", "attempts": 1, "durationMs": 10}],
    )
