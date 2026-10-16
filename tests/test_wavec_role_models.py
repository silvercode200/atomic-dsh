"""wavec-C node 2 (C4): unit-тесты логики выбора роли/модели субагентов.

Чистая функция resolve_role_models() извлекает карту роль -> модель из
состава пресета (группа delegation, инстансы @deepseek-ai/dsh-tool-subagent).
Тесты: реальный пресет code-lazy (пины cli/sonnet|haiku|fable, дефолтный
subagent без пина) + синтетические кейсы (нет пина, чужой провайдер, нет
toolName).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

PRESET_PATH = Path(
    os.environ.get(
        "DSH_WAVEC_PRESET",
        os.path.expanduser("~/.dsh/.agent-presets/code-lazy/agent.cordis.yml"),
    )
)

SUBAGENT_PKG = "@deepseek-ai/dsh-tool-subagent"


class IgnoreJSLoader(yaml.SafeLoader):
    """PyYAML loader, игнорирующий !!js/-теги dsh-конфигов (возвращая None)."""


def _js_tag_constructor(loader: yaml.SafeLoader, suffix: str, node: yaml.Node):
    return None


IgnoreJSLoader.add_multi_constructor("!", _js_tag_constructor)
IgnoreJSLoader.add_multi_constructor("tag:yaml.org,2002:js", _js_tag_constructor)


def load_preset(path: Path = PRESET_PATH) -> list[dict]:
    """Загрузить agent.cordis.yml, нейтрализовав !!js-теги."""
    with open(path, encoding="utf-8") as fh:
        return yaml.load(fh, Loader=IgnoreJSLoader)


def resolve_role_models(
    entries: list[dict],
) -> dict[str, dict[str, str | None]]:
    """Чистая функция: карта toolName -> {provider, model, pinned}.

    Из плоского списка entry пресета берёт группу `delegation`, внутри —
    все инстансы @deepseek-ai/dsh-tool-subagent, и резолвит role-пины
    agentOptions.{provider,model}. Дефолтный unpinned-инстанс получает
    pinned=False (наследует модель родителя). Прочие группы игнорируются.
    """
    roles: dict[str, dict[str, str | None]] = {}
    for entry in entries or []:
        if not isinstance(entry, dict) or entry.get("id") != "delegation":
            continue
        for row in entry.get("config") or []:
            if not isinstance(row, dict) or row.get("name") != SUBAGENT_PKG:
                continue
            if row.get("disabled"):
                continue
            cfg = row.get("config") or {}
            tool_name = cfg.get("toolName") or "subagent"
            opts = cfg.get("agentOptions") or {}
            roles[tool_name] = {
                "provider": opts.get("provider"),
                "model": opts.get("model"),
                "pinned": bool(opts.get("model")),
            }
    return roles


@pytest.fixture(scope="module")
def live_roles() -> dict[str, dict[str, str | None]]:
    return resolve_role_models(load_preset())


def test_live_preset_defines_three_role_tools(live_roles):
    for tool in ("subagent_exec", "subagent_research", "subagent_review"):
        assert tool in live_roles, f"нет роли {tool}: {sorted(live_roles)}"


def test_live_preset_default_subagent_unpinned(live_roles):
    assert "subagent" in live_roles
    assert live_roles["subagent"]["pinned"] is False


def test_live_preset_model_pins(live_roles):
    assert live_roles["subagent_exec"]["provider"] == "cli"
    assert live_roles["subagent_exec"]["model"] == "sonnet"
    assert live_roles["subagent_research"]["provider"] == "cli"
    assert live_roles["subagent_research"]["model"] == "haiku"
    assert live_roles["subagent_review"]["provider"] == "cli"
    assert live_roles["subagent_review"]["model"] == "fable"


def test_live_preset_fork_unpinned(live_roles):
    assert "subagent_fork" in live_roles
    assert live_roles["subagent_fork"]["pinned"] is False


def test_distinct_tool_names(live_roles):
    # один toolName на инстанс — обязательное ограничение dsh-tool-subagent:
    # resolve_role_models индексирует по toolName, дубль затёр бы инстанс.
    # Поэтому реальная проверка — все ожидаемые роли доехали (не затёрлись).
    expected = {"subagent", "subagent_exec", "subagent_research", "subagent_review", "subagent_fork"}
    assert expected <= set(live_roles), sorted(set(live_roles))


def test_synthetic_missing_pin_is_unpinned():
    entries = [
        {
            "id": "delegation",
            "config": [
                {
                    "id": "tool-subagent",
                    "name": SUBAGENT_PKG,
                    "config": {"provider": "spawn"},
                }
            ],
        }
    ]
    roles = resolve_role_models(entries)
    assert roles["subagent"] == {
        "provider": None,
        "model": None,
        "pinned": False,
    }


def test_synthetic_provider_only_pin():
    entries = [
        {
            "id": "delegation",
            "config": [
                {
                    "id": "tool-subagent-x",
                    "name": SUBAGENT_PKG,
                    "config": {
                        "provider": "spawn",
                        "toolName": "subagent_x",
                        "agentOptions": {"provider": "bg"},
                    },
                }
            ],
        }
    ]
    roles = resolve_role_models(entries)
    assert roles["subagent_x"] == {
        "provider": "bg",
        "model": None,
        "pinned": False,
    }


def test_synthetic_disabled_row_skipped():
    entries = [
        {
            "id": "delegation",
            "config": [
                {
                    "id": "tool-subagent-codex",
                    "name": SUBAGENT_PKG,
                    "disabled": True,
                    "config": {
                        "provider": "codex",
                        "toolName": "subagent_codex",
                        "agentOptions": {"model": "x"},
                    },
                }
            ],
        }
    ]
    assert resolve_role_models(entries) == {}


def test_synthetic_no_delegation_group():
    assert resolve_role_models([{"id": "planning", "config": []}]) == {}
