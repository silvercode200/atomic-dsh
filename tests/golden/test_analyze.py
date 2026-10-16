#!/usr/bin/env python3
"""TDD-тесты analyze.py — парсера session.jsonl.zstd и вердиктов golden suite.

Запуск: python3 tests/golden/test_analyze.py  (stdlib unittest, без зависимостей).
Фикстуры — синтетические JSONL-записи, повторяющие реальный формат dsh
(см. dsh-agent-loop/lib/index.js:731-739 — request/header пишется только
при изменении header, reason: initial|resume|change).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze  # noqa: E402


def hdr(reason: str, system: str = "SYS", tools: int = 1, model: str = "opus") -> dict:
    """request/header запись в формате dsh session log."""
    return {
        "type": "request/header",
        "seq": 1,
        "data": {
            "header": {
                "config": {"provider": "cli", "model": model},
                "system": system,
                "tools": [{"name": f"tool{i}"} for i in range(tools)],
            },
            "reason": reason,
        },
    }


def usage(turn: int, step: int, inp: int, cache, out: int = 100) -> dict:
    """assistant/chunk usage запись."""
    return {
        "type": "assistant/chunk",
        "seq": step,
        "data": {
            "turn": turn,
            "step": step,
            "chunk": {
                "type": "usage",
                "usage": {
                    "inputTokens": inp,
                    "outputTokens": out,
                    **({"cacheReadTokens": cache} if cache is not None else {}),
                },
            },
        },
    }


def tool_call(name: str, turn: int = 1, step: int = 1, time: int = 0) -> dict:
    return {
        "type": "tool/call",
        "seq": step,
        "time": time,
        "data": {"turn": turn, "step": step, "callId": f"c{step}", "name": name, "arguments": "{}"},
    }


def dispatch_call(name: str, sub: int = 1, time: int = 0) -> dict:
    """tool/code-dispatch-start запись (code mode: тулы внутри run_code)."""
    return {
        "type": "tool/code-dispatch-start",
        "seq": sub,
        "time": time,
        "data": {"name": name, "subCallId": f"d:code:{sub}"},
    }


def session_rec(
    sid: str,
    agent_preset: str = "code-lazy",
    origin: str | None = None,
    parent: str | None = None,
    created_at: int = 0,
    top_preset: bool = True,
) -> dict:
    """session-запись: linkage-поля (id/origin/parentSession/createdAt) — на
    ВЕРХНЕМ уровне записи (формат dsh persistence, репро golden-run e)."""
    rec = {
        "type": "session",
        "version": 0,
        "id": sid,
        "createdAt": created_at,
        "cwd": "/tmp/dsh-golden/work",
        "delegationDepth": 1 if origin == "subagent" else 0,
    }
    if origin is not None:
        rec["origin"] = origin
    if parent is not None:
        rec["parentSession"] = parent
    if top_preset:
        rec["agentPreset"] = agent_preset
    else:  # legacy-вариант: agentPreset в data
        rec["data"] = {"agentPreset": agent_preset}
    return rec


class TestSessionFacts(unittest.TestCase):
    def test_basic_facts(self):
        recs = [
            {"type": "session", "data": {"id": "x", "agentPreset": "code-lazy"}},
            hdr("initial", system="SYSTEM_PROMPT_TEXT" * 100, tools=5),
            usage(1, 1, 1000, None),
            usage(1, 2, 2000, 1950),
            tool_call("run_code"),
        ]
        f = analyze.session_facts(recs)
        self.assertEqual(f["header_count"], 1)
        self.assertEqual(f["header_reasons"], ["initial"])
        self.assertEqual(f["system_chars"], 1800)  # "SYSTEM_PROMPT_TEXT" (18) * 100
        self.assertGreater(len(f["system_sha256"]), 30)
        self.assertEqual(f["tools_count"], 5)
        self.assertEqual(f["provider"], "cli")
        self.assertEqual(f["agent_preset"], "code-lazy")
        self.assertEqual(len(f["usage_steps"]), 2)
        self.assertEqual(f["usage_steps"][1]["cacheReadTokens"], 1950)
        self.assertEqual(f["tool_calls"], ["run_code"])
        self.assertEqual(f["compaction_events"], [])
        self.assertEqual(f["turns"], 0)

    def test_header_change_detected(self):
        recs = [hdr("initial"), hdr("change"), usage(1, 1, 10, None)]
        f = analyze.session_facts(recs)
        self.assertEqual(f["header_count"], 2)
        self.assertEqual(f["header_reasons"], ["initial", "change"])

    def test_mcp_and_spot_calls_collected(self):
        recs = [
            hdr("initial"),
            tool_call("mcp__router__search_and_activate"),
            tool_call("mcp__context-mode__discover_code_context"),
            tool_call("spot_search"),
            tool_call("spot_load"),
        ]
        f = analyze.session_facts(recs)
        self.assertEqual(f["spot_calls"], ["spot_search", "spot_load"])
        # активация = router search_and_activate ИЛИ прямой activate-тул
        self.assertTrue(f["mcp_activation"])

    def test_code_dispatch_activation(self):
        """code mode: активация MCP и вызовы из run_code видны как code-dispatch."""
        recs = [
            hdr("initial"),
            tool_call("run_code"),
            {"type": "tool/code-dispatch-start", "data": {"name": "mcp__context-mode__activate", "subCallId": "d:code:1"}},
            {"type": "tool/code-dispatch-start", "data": {"name": "mcp__context-mode__ctx_stats", "subCallId": "d:code:2"}},
            {"type": "tool/code-dispatch-start", "data": {"name": "spot_search", "subCallId": "d:code:3"}},
        ]
        f = analyze.session_facts(recs)
        self.assertTrue(f["mcp_activation"])
        self.assertIn("mcp__context-mode__ctx_stats", f["dispatch_calls"])
        self.assertEqual(f["spot_calls"], ["spot_search"])
        f2 = dict(f)
        f2["system_stable"] = True
        v = analyze.verdict("b", f2)
        self.assertTrue(v["checks"]["mcp_activated"])
        self.assertTrue(v["checks"]["mcp_tool_called"])

    def test_compaction_events(self):
        recs = [
            hdr("initial"),
            {"type": "compaction/start", "data": {"compactionId": "k1", "turn": 2}},
            {"type": "compaction/end", "data": {"compactionId": "k1", "turn": 2}},
        ]
        f = analyze.session_facts(recs)
        self.assertEqual(f["compaction_events"], ["compaction/start", "compaction/end"])

    def test_model_from_header(self):
        """facts['model'] = header.config.model (пин субагента виден в дочерней сессии)."""
        recs = [hdr("initial", system="S")]
        f = analyze.session_facts(recs)
        self.assertEqual(f["model"], "opus")

    def test_session_linkage_fields_toplevel(self):
        """session-запись несёт linkage на ВЕРХНЕМ уровне: id/origin/parentSession/
        createdAt/agentPreset (репро golden-run e: origin=subagent)."""
        recs = [
            session_rec(
                "child-1", origin="subagent", parent="parent-1", created_at=1789377085335
            ),
            hdr("initial", model="haiku"),
        ]
        f = analyze.session_facts(recs)
        self.assertEqual(f["session_id"], "child-1")
        self.assertEqual(f["session_origin"], "subagent")
        self.assertEqual(f["session_parent"], "parent-1")
        self.assertEqual(f["session_created_at"], 1789377085335)
        self.assertEqual(f["agent_preset"], "code-lazy")

    def test_agent_preset_legacy_in_data(self):
        """legacy-вариант session-записи: agentPreset внутри data."""
        recs = [session_rec("s1", top_preset=False), hdr("initial")]
        f = analyze.session_facts(recs)
        self.assertEqual(f["agent_preset"], "code-lazy")

    def test_spawn_events_collected(self):
        """spawn_events: subagent_*-вызовы с ВРЕМЕНЮ записи (tool/call + dispatch)."""
        recs = [
            hdr("initial"),
            dispatch_call("subagent_research", sub=1, time=1789377085328),
            tool_call("tools.write", step=2, time=1789377090000),
            dispatch_call("subagent_exec", sub=3, time=1789377170950),
        ]
        f = analyze.session_facts(recs)
        self.assertEqual(
            f["spawn_events"],
            [
                {"name": "subagent_research", "time": 1789377085328},
                {"name": "subagent_exec", "time": 1789377170950},
            ],
        )

    def test_tools_shas_per_header(self):
        """tools_shas: sha списка имён тулов на КАЖДЫЙ header (f: tools стабильны
        между режимами, даже когда system штатно меняется)."""
        stable = analyze.session_facts(
            [hdr("initial", tools=3), hdr("change", system="S2", tools=3)]
        )
        self.assertTrue(stable["tools_stable"])
        grew = analyze.session_facts(
            [hdr("initial", tools=3), hdr("change", system="S2", tools=5)]
        )
        self.assertFalse(grew["tools_stable"])

    def test_calls_in_order_interleaved(self):
        """calls_in_order: имена тулов в ПОРЯДКЕ записей (tool/call + dispatch вперемешку)."""
        recs = [
            hdr("initial"),
            tool_call("ask_user_question", step=1),
            dispatch_call("run_code", sub=2),
            dispatch_call("exit_plan_mode", sub=3),
        ]
        f = analyze.session_facts(recs)
        self.assertEqual(
            f["calls_in_order"],
            ["ask_user_question", "run_code", "exit_plan_mode"],
        )

    def test_malformed_lines_ignored(self):
        recs = [
            {"type": "session", "data": {}},
            hdr("initial"),
            {"type": "assistant/chunk", "data": {"chunk": {"type": "text"}}},  # usage нет — ок
        ]
        f = analyze.session_facts(recs)
        self.assertEqual(f["header_count"], 1)
        self.assertEqual(f["usage_steps"], [])

    def test_system_stable_metric(self):
        """Идентичность system: ровно 1 request/header без change."""
        stable = analyze.session_facts([hdr("initial"), usage(1, 1, 10, None)])
        changed = analyze.session_facts([hdr("initial"), hdr("change")])
        self.assertTrue(stable["system_stable"])
        self.assertFalse(changed["system_stable"])


class TestCachePct(unittest.TestCase):
    def test_cache_pct_inclusive_semantics(self):
        """cache_pct = cacheReadTokens / inputTokens (inclusive), None-шаги пропущены."""
        steps = [
            {"turn": 1, "step": 1, "inputTokens": 1000, "cacheReadTokens": None},
            {"turn": 1, "step": 2, "inputTokens": 2000, "cacheReadTokens": 1940},
            {"turn": 1, "step": 3, "inputTokens": 3000, "cacheReadTokens": 2950},
        ]
        pct, n = analyze.cache_pct(steps)
        self.assertAlmostEqual(pct, (1940 / 2000 + 2950 / 3000) / 2 * 100)
        self.assertEqual(n, 2)

    def test_cache_pct_from_step(self):
        """stable_from_step: ранние шаги (первый кеш-прогрев) не портят метрику."""
        steps = [
            {"turn": 1, "step": 1, "inputTokens": 1000, "cacheReadTokens": 500},
            {"turn": 1, "step": 2, "inputTokens": 2000, "cacheReadTokens": 1980},
        ]
        pct, n = analyze.cache_pct(steps, stable_from_step=2)
        self.assertAlmostEqual(pct, 99.0)
        self.assertEqual(n, 1)

    def test_cache_pct_no_data(self):
        pct, n = analyze.cache_pct([{"turn": 1, "step": 1, "inputTokens": 10, "cacheReadTokens": None}])
        self.assertIsNone(pct)
        self.assertEqual(n, 0)


class TestVerdicts(unittest.TestCase):
    def base_facts(self, **over):
        f = {
            "header_count": 1,
            "header_reasons": ["initial"],
            "system_stable": True,
            "system_chars": 25491,
            "system_sha256": "ab" * 32,
            "tools_count": 10,
            "provider": "cli",
            "agent_preset": "code-lazy",
            "usage_steps": [
                {"turn": 1, "step": 1, "inputTokens": 6700, "cacheReadTokens": None},
                {"turn": 1, "step": 2, "inputTokens": 7000, "cacheReadTokens": 6900},
            ],
            "tool_calls": [],
            "dispatch_calls": [],
            "compaction_events": [],
            "mcp_activation": False,
            "spot_calls": [],
            "turns": 1,
        }
        f.update(over)
        return f

    def test_verdict_a_run_code(self):
        ok = analyze.verdict("a", self.base_facts(tool_calls=["run_code", "tools.write"]))
        self.assertTrue(ok["pass"], ok)
        self.assertTrue(ok["checks"]["run_code_called"])
        self.assertTrue(ok["checks"]["system_stable"])
        self.assertGreaterEqual(ok["checks"]["cache_pct"], 97.0)

    def test_verdict_a_fails_without_run_code(self):
        bad = analyze.verdict("a", self.base_facts(tool_calls=["tools.write"]))
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["run_code_called"])

    def test_verdict_b_mcp_activation(self):
        ok = analyze.verdict(
            "b",
            self.base_facts(
                tool_calls=["mcp__router__search_and_activate", "mcp__context-mode__discover_code_context"],
                mcp_activation=True,
            ),
        )
        self.assertTrue(ok["pass"], ok)
        self.assertTrue(ok["checks"]["mcp_activated"])
        self.assertTrue(ok["checks"]["mcp_tool_called"])

    def test_verdict_b_system_change_fails(self):
        bad = analyze.verdict(
            "b",
            self.base_facts(
                tool_calls=["mcp__router__search_and_activate", "mcp__context-mode__x"],
                mcp_activation=True,
                header_count=2,
                header_reasons=["initial", "change"],
                system_stable=False,
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["system_stable"])

    def test_verdict_c_spot(self):
        ok = analyze.verdict(
            "c",
            self.base_facts(tool_calls=["spot_search", "spot_load", "tools.write"], spot_calls=["spot_search", "spot_load"]),
        )
        self.assertTrue(ok["pass"], ok)

    def test_verdict_c_spot_load_missing_fails(self):
        bad = analyze.verdict("c", self.base_facts(tool_calls=["spot_search"], spot_calls=["spot_search"]))
        self.assertFalse(bad["pass"])

    def test_verdict_d_compaction(self):
        ok = analyze.verdict(
            "d",
            self.base_facts(compaction_events=["compaction/start", "compaction/end"], turns=2),
        )
        self.assertTrue(ok["pass"], ok)
        self.assertTrue(ok["checks"]["compaction_completed"])

    def test_verdict_d_without_compaction_fails(self):
        bad = analyze.verdict("d", self.base_facts(turns=2))
        self.assertFalse(bad["pass"])

    def test_verdict_e_subagent_routing(self):
        """e: родитель вызвал subagent_research+subagent_exec, дети на cli/haiku и cli/sonnet."""
        ok = analyze.verdict(
            "e",
            self.base_facts(
                tool_calls=["subagent_research", "subagent_exec"],
                child_sessions=[
                    {"provider": "cli", "model": "haiku", "role": "subagent_research"},
                    {"provider": "cli", "model": "sonnet", "role": "subagent_exec"},
                ],
            ),
        )
        self.assertTrue(ok["pass"], ok)
        self.assertTrue(ok["checks"]["subagent_research_called"])
        self.assertTrue(ok["checks"]["subagent_exec_called"])
        self.assertTrue(ok["checks"]["child_research_haiku_cli"])
        self.assertTrue(ok["checks"]["child_exec_sonnet_cli"])
        self.assertTrue(ok["checks"]["child_sessions_found"])

    def test_verdict_e_fails_without_children(self):
        """e: нет дочерних сессий с пинами — FAIL (пин не работает/дети не логируются)."""
        bad = analyze.verdict(
            "e",
            self.base_facts(
                tool_calls=["subagent_research", "subagent_exec"],
                child_sessions=[],
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["child_sessions_found"])

    def test_verdict_e_fails_on_wrong_child_model(self):
        """e: дочь на модели родителя (пин не применился) — FAIL."""
        bad = analyze.verdict(
            "e",
            self.base_facts(
                tool_calls=["subagent_research", "subagent_exec"],
                child_sessions=[{"provider": "cli", "model": "opus", "role": "subagent_research"}],
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["child_research_haiku_cli"])
        self.assertFalse(bad["checks"]["child_exec_sonnet_cli"])

    def test_verdict_e_fails_on_role_model_swap(self):
        """e (review MAJOR#1): пины ПЕРЕПУТАНЫ (research->sonnet, exec->haiku) —
        FAIL. Прежняя any()-проверка по множеству моделей своп пропускала."""
        bad = analyze.verdict(
            "e",
            self.base_facts(
                tool_calls=["subagent_research", "subagent_exec"],
                child_sessions=[
                    {"provider": "cli", "model": "sonnet", "role": "subagent_research"},
                    {"provider": "cli", "model": "haiku", "role": "subagent_exec"},
                ],
            ),
        )
        self.assertFalse(bad["pass"], "своп пинов ролей обязан FAIL-ить")
        self.assertFalse(bad["checks"]["child_research_haiku_cli"])
        self.assertFalse(bad["checks"]["child_exec_sonnet_cli"])

    def test_verdict_e_unmapped_child_role_fails(self):
        """e: дочерняя сессия без маппинга на роль (role=None) — FAIL, не PASS
        по множеству."""
        bad = analyze.verdict(
            "e",
            self.base_facts(
                tool_calls=["subagent_research", "subagent_exec"],
                child_sessions=[
                    {"provider": "cli", "model": "haiku", "role": None},
                    {"provider": "cli", "model": "sonnet", "role": None},
                ],
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["child_research_haiku_cli"])

    def test_verdict_e_dispatch_counts(self):
        """e: тулы субагентов могут идти через code-dispatch (code mode)."""
        ok = analyze.verdict(
            "e",
            self.base_facts(
                tool_calls=[],
                dispatch_calls=["subagent_research", "subagent_exec"],
                child_sessions=[
                    {"provider": "cli", "model": "haiku", "role": "subagent_research"},
                    {"provider": "cli", "model": "sonnet", "role": "subagent_exec"},
                ],
            ),
        )
        self.assertTrue(ok["pass"], ok)

    def test_verdict_f_grill_before_exit(self):
        """f: ask_user_question ДО exit_plan_mode, мутаций нет — PASS."""
        ok = analyze.verdict(
            "f",
            self.base_facts(
                calls_in_order=["ask_user_question", "exit_plan_mode"],
                tool_calls=["ask_user_question", "exit_plan_mode"],
                workdir_unchanged_until_exit=True,
            ),
        )
        self.assertTrue(ok["pass"], ok)
        self.assertTrue(ok["checks"]["ask_user_question_called"])
        self.assertTrue(ok["checks"]["exit_plan_mode_called"])
        self.assertTrue(ok["checks"]["ask_before_exit"])
        self.assertTrue(ok["checks"]["no_mutations_until_exit"])

    def test_verdict_f_fails_when_exit_first(self):
        """f: exit_plan_mode БЕЗ вопросов (grill пропущен) — FAIL."""
        bad = analyze.verdict(
            "f",
            self.base_facts(
                calls_in_order=["exit_plan_mode"],
                tool_calls=["exit_plan_mode"],
                workdir_unchanged_until_exit=True,
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["ask_user_question_called"])

    def test_verdict_f_fails_when_ask_after_exit(self):
        """f: вопрос ПОСЛЕ exit — порядок нарушен, FAIL."""
        bad = analyze.verdict(
            "f",
            self.base_facts(
                calls_in_order=["exit_plan_mode", "ask_user_question"],
                tool_calls=["exit_plan_mode", "ask_user_question"],
                workdir_unchanged_until_exit=True,
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["ask_before_exit"])

    def test_verdict_f_fails_on_mutations(self):
        """f: файлы менялись до exit_plan_mode — FAIL."""
        bad = analyze.verdict(
            "f",
            self.base_facts(
                calls_in_order=["ask_user_question", "exit_plan_mode"],
                tool_calls=["ask_user_question", "exit_plan_mode"],
                workdir_unchanged_until_exit=False,
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["no_mutations_until_exit"])

    def test_verdict_f_missing_mutation_fact_fails(self):
        """f: факт мутаций не передан (нет extra-facts) — FAIL, не вакуумный PASS."""
        bad = analyze.verdict(
            "f",
            self.base_facts(
                calls_in_order=["ask_user_question", "exit_plan_mode"],
                tool_calls=["ask_user_question", "exit_plan_mode"],
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["no_mutations_until_exit"])

    def test_verdict_f_header_change_on_plan_mode_ok(self):
        """f: header change от входа в план-мод — ШТАТНО (секция план-мода в
        system), это НЕ кеш-дефект: system_stable не входит в required; вместо
        него tools_stable — каталог тулов не растёт между режимами."""
        ok = analyze.verdict(
            "f",
            self.base_facts(
                calls_in_order=["ask_user_question", "exit_plan_mode"],
                tool_calls=["ask_user_question", "exit_plan_mode"],
                workdir_unchanged_until_exit=True,
                header_count=2,
                header_reasons=["initial", "change"],
                system_stable=False,
                tools_shas=["aa", "aa"],
                tools_stable=True,
            ),
        )
        self.assertTrue(ok["pass"], ok)
        self.assertTrue(ok["checks"]["tools_stable"])

    def test_verdict_f_tools_growth_fails(self):
        """f: рост каталога тулов между режимами — НЕ штатно, FAIL."""
        bad = analyze.verdict(
            "f",
            self.base_facts(
                calls_in_order=["ask_user_question", "exit_plan_mode"],
                tool_calls=["ask_user_question", "exit_plan_mode"],
                workdir_unchanged_until_exit=True,
                tools_shas=["aa", "bb"],
                tools_stable=False,
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["tools_stable"])

    # --- анти-вакуум кеш-метрики (review MAJOR#4): требуем usage-шаги и кеш-шаги
    # во ВСЕХ сценариях cli-группы; ослабление — только по внешнему факту
    # (channel_reports_cache=False: канал сам не репортит кеш, run.sh-проба).

    def test_verdict_a_fails_on_empty_usage_steps(self):
        """a: usage_steps=[] (нет собираемых данных) — FAIL по cache_steps_present."""
        bad = analyze.verdict(
            "a", self.base_facts(tool_calls=["run_code"], usage_steps=[])
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["cache_steps_present"])
        self.assertFalse(bad["checks"]["usage_steps_present"])

    def test_verdict_e_fails_on_empty_usage_steps(self):
        """e (review MAJOR#4): usage_steps=[] — FAIL по cache_steps_present."""
        bad = analyze.verdict(
            "e",
            self.base_facts(
                tool_calls=["subagent_research", "subagent_exec"],
                child_sessions=[
                    {"provider": "cli", "model": "haiku", "role": "subagent_research"},
                    {"provider": "cli", "model": "sonnet", "role": "subagent_exec"},
                ],
                usage_steps=[],
            ),
        )
        self.assertFalse(bad["pass"], "0 кеш-шагов = вакуумный PASS запрещён")
        self.assertFalse(bad["checks"]["cache_steps_present"])

    def test_verdict_f_fails_on_empty_usage_steps(self):
        """f (review MAJOR#4): usage_steps=[] — FAIL по cache_steps_present."""
        bad = analyze.verdict(
            "f",
            self.base_facts(
                calls_in_order=["ask_user_question", "exit_plan_mode"],
                tool_calls=["ask_user_question", "exit_plan_mode"],
                workdir_unchanged_until_exit=True,
                usage_steps=[],
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["cache_steps_present"])

    def test_verdict_bcd_fail_on_empty_usage_steps(self):
        """b/c/d (симметрия MAJOR#4): usage_steps=[] — FAIL."""
        for sc, over in (
            ("b", {"tool_calls": ["mcp__router__search_and_activate", "mcp__context-mode__x"], "mcp_activation": True}),
            ("c", {"tool_calls": ["spot_search", "spot_load"], "spot_calls": ["spot_search", "spot_load"]}),
            ("d", {"compaction_events": ["compaction/start", "compaction/end"], "turns": 2}),
        ):
            bad = analyze.verdict(sc, self.base_facts(usage_steps=[], **over))
            self.assertFalse(bad["pass"], sc)
            self.assertFalse(bad["checks"]["cache_steps_present"], sc)

    def test_verdict_channel_no_report_justifies_cache_na(self):
        """Канал сам не репортит кеш (внешний факт от run.sh-пробы) — отсутствие
        кеш-шагов НЕ фейлит сценарий; но usage_steps_present обязателен всё равно,
        а факт фиксируется в checks.cache_reporting."""
        ok = analyze.verdict(
            "e",
            self.base_facts(
                tool_calls=["subagent_research", "subagent_exec"],
                child_sessions=[
                    {"provider": "cli", "model": "haiku", "role": "subagent_research"},
                    {"provider": "cli", "model": "sonnet", "role": "subagent_exec"},
                ],
                usage_steps=[
                    {"turn": 1, "step": 1, "inputTokens": 11655, "cacheReadTokens": None},
                ],
                channel_reports_cache=False,
            ),
        )
        self.assertTrue(ok["pass"], ok)
        self.assertEqual(ok["checks"]["cache_reporting"], "channel-no-report")
        self.assertFalse(ok["checks"]["cache_steps_present"])  # честно: шагов кеша нет
        self.assertTrue(ok["checks"]["usage_steps_present"])  # данные собираются

    def test_verdict_channel_no_report_usage_vacuum_still_fails(self):
        """Проба «канал не репортит» НЕ покрывает вакуум usage-шагов: лог/анализ
        сломаны → FAIL независимо от пробы."""
        bad = analyze.verdict(
            "e",
            self.base_facts(
                tool_calls=["subagent_research", "subagent_exec"],
                child_sessions=[
                    {"provider": "cli", "model": "haiku", "role": "subagent_research"},
                    {"provider": "cli", "model": "sonnet", "role": "subagent_exec"},
                ],
                usage_steps=[],
                channel_reports_cache=False,
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["usage_steps_present"])

    def test_verdict_channel_reports_cache_requires_steps(self):
        """Проба «канал репортит кеш» + 0 кеш-шагов в сессии = dsh не записывает —
        FAIL (это и есть регрессия-вектор из review MAJOR#4)."""
        bad = analyze.verdict(
            "e",
            self.base_facts(
                tool_calls=["subagent_research", "subagent_exec"],
                child_sessions=[
                    {"provider": "cli", "model": "haiku", "role": "subagent_research"},
                    {"provider": "cli", "model": "sonnet", "role": "subagent_exec"},
                ],
                usage_steps=[
                    {"turn": 1, "step": 1, "inputTokens": 11655, "cacheReadTokens": None},
                ],
                channel_reports_cache=True,
            ),
        )
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["cache_steps_present"])

    def test_verdict_a_exact_run_code_name(self):
        """a (review MINOR): точное имя «run_code», тул-импостер с префиксом
        «code...» не зачитывается."""
        bad = analyze.verdict("a", self.base_facts(tool_calls=["codegen"]))
        self.assertFalse(bad["pass"])
        self.assertFalse(bad["checks"]["run_code_called"])
        ok = analyze.verdict(
            "a",
            self.base_facts(tool_calls=[], dispatch_calls=["run_code"]),
        )
        self.assertTrue(ok["checks"]["run_code_called"])

    def test_unknown_scenario_raises(self):
        with self.assertRaises(ValueError):
            analyze.verdict("z", self.base_facts())


class TestScanSessions(unittest.TestCase):
    def _mk_session(self, td, name, records, mtime=None):
        d = os.path.join(td, "--work--", name)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "session.jsonl")
        self._write_session(path, records)
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def test_scan_sessions_finds_children_with_role_mapping(self):
        """scan_sessions: дочерние сессии (origin=subagent, родитель задан),
        provider/model из header, роль — по spawn-времени родителя."""
        with tempfile.TemporaryDirectory() as td:
            now = time.time()
            # дочерняя сессия research: создана сразу после subagent_research
            self._mk_session(
                td, "child1",
                [
                    session_rec("c1", origin="subagent", parent="p1", created_at=1789377085335),
                    hdr("initial", model="haiku"),
                ],
            )
            # дочерняя exec: создана после subagent_exec
            self._mk_session(
                td, "child2",
                [
                    session_rec("c2", origin="subagent", parent="p1", created_at=1789377171000),
                    hdr("initial", model="sonnet"),
                ],
            )
            # старая сессия — ДО cutoff, игнорируется
            self._mk_session(td, "old", [hdr("initial")], mtime=now - 3600)
            # битый файл — пропускается молча
            self._mk_session(td, "torn", [])
            with open(os.path.join(td, "--work--", "torn", "session.jsonl"), "w") as fh:
                fh.write("{not json\n")

            spawns = [
                {"name": "subagent_research", "time": 1789377085328},
                {"name": "subagent_exec", "time": 1789377170950},
            ]
            children = analyze.scan_sessions(
                td,
                newer_than=now - 60,
                parent_session_id="p1",
                spawn_events=spawns,
            )
            self.assertEqual(len(children), 2)
            by_role = {c["role"]: c for c in children}
            self.assertEqual(by_role["subagent_research"]["model"], "haiku")
            self.assertEqual(by_role["subagent_exec"]["model"], "sonnet")
            self.assertTrue(all(c["provider"] == "cli" for c in children))
            self.assertTrue(all(c["origin"] == "subagent" for c in children))
            self.assertTrue(all(c["parent_session"] == "p1" for c in children))

    def test_scan_sessions_filters_foreign_by_origin_and_parent(self):
        """scan_sessions (review MAJOR#2): посторонняя свежая haiku-сессия БЕЗ
        origin=subagent (или с другим родителем) НЕ попадает в children."""
        with tempfile.TemporaryDirectory() as td:
            now = time.time()
            # посторонняя сессия того же стора: origin отсутствует (не субагент)
            self._mk_session(
                td, "foreign",
                [session_rec("f1", created_at=int(now * 1000)), hdr("initial", model="haiku")],
            )
            # субагент ДРУГОГО родителя (origin=subagent, parent=p999)
            self._mk_session(
                td, "other-parent",
                [
                    session_rec("o1", origin="subagent", parent="p999", created_at=int(now * 1000)),
                    hdr("initial", model="haiku"),
                ],
            )
            # настоящий ребёнок нашего родителя
            self._mk_session(
                td, "ours",
                [
                    session_rec("c1", origin="subagent", parent="p1", created_at=int(now * 1000)),
                    hdr("initial", model="haiku"),
                ],
            )
            children = analyze.scan_sessions(
                td, newer_than=now - 60, parent_session_id="p1", spawn_events=[]
            )
            self.assertEqual(
                [c["path"] for c in children],
                [os.path.join(td, "--work--", "ours", "session.jsonl")],
            )
            self.assertIsNone(children[0]["role"])  # нет spawn-событий — роль не сматчена

    def test_scan_sessions_excludes_parent(self):
        """scan_sessions: путь родителя исключается из результата."""
        with tempfile.TemporaryDirectory() as td:
            now = time.time()
            parent_dir = os.path.join(td, "--work--", "parent")
            os.makedirs(parent_dir)
            parent_path = os.path.join(parent_dir, "session.jsonl")
            self._write_session(parent_path, [hdr("initial")])
            children = analyze.scan_sessions(td, newer_than=now - 60, exclude=parent_path)
            self.assertEqual(children, [])

    def _write_session(self, path: str, records: list) -> None:
        with open(path, "w") as fh:
            for r in records:
                fh.write(json.dumps(r) + "\n")


class TestReadSession(unittest.TestCase):
    def test_read_plain_jsonl_and_zstd(self):
        """read_session_records: plain .jsonl напрямую, .zstd через fallback-цепочку."""
        with tempfile.TemporaryDirectory() as td:
            plain = os.path.join(td, "s.jsonl")
            with open(plain, "w") as fh:
                for r in [hdr("initial"), usage(1, 1, 10, None)]:
                    fh.write(json.dumps(r) + "\n")
            recs = analyze.read_session_records(plain)
            self.assertEqual(len(recs), 2)
            self.assertEqual(recs[0]["type"], "request/header")


if __name__ == "__main__":
    unittest.main()
