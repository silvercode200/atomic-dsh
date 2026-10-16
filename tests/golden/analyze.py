#!/usr/bin/env python3
"""analyze.py — парсер dsh session.jsonl(.zstd) и вердикты golden smoke-сьюта.

Золотой smoke-сьют кеш-верификации (TG-DSH-CACHE-20260912, node 9).
Запускается на целевой машине (vmdev/colab VM) — stdlib only, без зависимостей.

Проверяемые механики (источник — dsh-agent-loop/lib/index.js:731-739):
  * request/header пишется ПЕРВЫЙ раз (reason: initial|resume) и далее ТОЛЬКО
    при изменении header (reason: change). Header = config + system + tools.
    => «system заморожен на сессию» ⟺ в сессии ровно 1 request/header
       и ни одной записи с reason:"change".
  * usage пишется на каждом LLM-шаге (assistant/chunk, chunk.type=usage).
    Семантика inclusive: inputTokens = полный ввод шага,
    cacheReadTokens = кешированная часть этого же ввода
    (эмпирика: cacheRead(step N) ≈ inputTokens(step N-1)).
    cache_pct = cacheReadTokens / inputTokens, усреднение по шагам
    с cacheReadTokens != None, начиная со stable_from_step.

Usage:
    analyze.py SESSION.jsonl.zstd --scenario a|b|c|d [--stable-from-step N] [--json]
    analyze.py SESSION.jsonl.zstd --facts          # только факты, без вердикта
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from typing import Iterator, Optional

#: порог зелёного по кешу (задача: 97-99.5%)
CACHE_PASS_PCT = 97.0
#: с какого шага считать кеш «устоявшимся» (первый кеш-шаг всегда чуть ниже)
DEFAULT_STABLE_FROM_STEP = 2


# --- чтение session log -----------------------------------------------------

def _decompress_zstd_bytes(path: str) -> bytes:
    """Декомпрессия .zstd через fallback-цепочку, читая ВСЕ фреймы потока.

    session.jsonl.zstd у dsh — многофреймовый стрим (запись append), поэтому
    одноразовые decompress()-вызовы (первый фрейм только) НЕ годятся.
    Порядок: zstd CLI (потоково все фреймы) -> zstandard stream_reader
    (read_across_frames) -> compression.zstd.ZstdFile (python 3.14+).

    Raises:
        RuntimeError: ни один способ недоступен.
    """
    cli = shutil.which("zstd")
    if cli:  # CLI: `zstd -dc` читает все фреймы подряд (Zorin)
        return subprocess.run(
            [cli, "-dc", path], capture_output=True, check=True
        ).stdout
    try:  # сторонний модуль zstandard: поток через все фреймы
        import zstandard  # type: ignore[import-not-found]

        with open(path, "rb") as fh:
            reader = zstandard.ZstdDecompressor().stream_reader(
                fh, read_across_frames=True
            )
            return reader.read()
    except ImportError:
        pass
    try:  # Python 3.14+: ZstdFile — потоковый читатель
        from compression import zstd as _zstd  # type: ignore[import-not-found]

        with open(path, "rb") as fh:
            with _zstd.ZstdFile(fh) as zf:
                return zf.read()
    except ImportError:
        pass
    raise RuntimeError(
        "нет способа декомпрессировать multi-frame zstd "
        "(нет zstd CLI, zstandard, compression.zstd)"
    )


def read_session_records(path: str) -> list[dict]:
    """Прочитать session log (plain .jsonl или .jsonl.zstd) в список записей.

    Битые строки пропускаются молча: session log может содержать
    недописанный хвост (torn record).
    """
    opener = open
    if path.endswith(".zstd"):
        data = _decompress_zstd_bytes(path)
        lines = data.decode("utf-8", errors="replace").splitlines()
    else:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    out = []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            rec = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


# --- факты сессии ------------------------------------------------------------

def _usage_step(data: dict) -> Optional[dict]:
    """usage-шаг из assistant/chunk, или None если чанк не usage."""
    chunk = data.get("chunk") or {}
    if chunk.get("type") != "usage":
        return None
    u = chunk.get("usage") or {}
    return {
        "turn": data.get("turn"),
        "step": data.get("step"),
        "inputTokens": u.get("inputTokens"),
        "cacheReadTokens": u.get("cacheReadTokens"),
        "outputTokens": u.get("outputTokens"),
    }


def session_facts(records: list[dict]) -> dict:
    """Извлечь наблюдаемые факты из записей session log.

    Returns:
        dict с ключами: header_count, header_reasons, system_stable,
        system_chars, system_sha256, tools_count, tools_shas, tools_stable,
        provider, model, agent_preset, usage_steps, tool_calls,
        dispatch_calls, calls_in_order, spawn_events, compaction_events,
        mcp_activation, spot_calls, turns, session_id, session_origin,
        session_parent, session_created_at.
    """
    facts = {
        "header_count": 0,
        "header_reasons": [],
        "system_stable": True,
        "system_chars": 0,
        "system_sha256": None,
        "tools_count": 0,
        "tools_shas": [],
        "tools_stable": True,
        "provider": None,
        "model": None,
        "agent_preset": None,
        "usage_steps": [],
        "tool_calls": [],
        "dispatch_calls": [],
        "calls_in_order": [],
        "spawn_events": [],
        "compaction_events": [],
        "mcp_activation": False,
        "spot_calls": [],
        "turns": 0,
        # linkage-поля session-записи (ВЕРХНИЙ уровень записи, не data)
        "session_id": None,
        "session_origin": None,
        "session_parent": None,
        "session_created_at": None,
    }
    for rec in records:
        rtype = rec.get("type", "")
        data = rec.get("data") or {}
        if rtype == "request/header":
            facts["header_count"] += 1
            reason = data.get("reason", "?")
            facts["header_reasons"].append(reason)
            header = data.get("header") or {}
            system = header.get("system")
            if isinstance(system, str):
                facts["system_chars"] = len(system)
                facts["system_sha256"] = hashlib.sha256(system.encode()).hexdigest()
            tools = header.get("tools")
            if isinstance(tools, list):
                facts["tools_count"] = len(tools)
                names = [t.get("name") for t in tools if isinstance(t, dict)]
                facts["tools_shas"].append(
                    hashlib.sha256(json.dumps(names).encode()).hexdigest()
                )
            cfg = header.get("config") or {}
            if cfg.get("provider"):
                facts["provider"] = cfg["provider"]
            if cfg.get("model"):
                facts["model"] = cfg["model"]
        elif rtype == "assistant/chunk":
            step = _usage_step(data)
            if step is not None:
                facts["usage_steps"].append(step)
        elif rtype == "tool/call":
            name = data.get("name")
            if name:
                facts["tool_calls"].append(name)
                facts["calls_in_order"].append(name)
                if name.startswith("spot_"):
                    facts["spot_calls"].append(name)
                if "search_and_activate" in name or name.endswith("__activate"):
                    facts["mcp_activation"] = True
                if name.startswith("subagent_"):
                    facts["spawn_events"].append({"name": name, "time": rec.get("time")})
        elif rtype == "tool/code-dispatch-start":
            # code mode: тулы вызываются ВНУТРИ run_code (tools.*) и логируются
            # как code-dispatch, а не tool/call — активация MCP и вызовы серверных
            # тулов видны только здесь
            name = data.get("name")
            if name:
                facts["dispatch_calls"].append(name)
                facts["calls_in_order"].append(name)
                if name.startswith("spot_"):
                    facts["spot_calls"].append(name)
                if "search_and_activate" in name or name.endswith("__activate"):
                    facts["mcp_activation"] = True
                if name.startswith("subagent_"):
                    facts["spawn_events"].append({"name": name, "time": rec.get("time")})
        elif rtype.startswith("compaction/"):
            facts["compaction_events"].append(rtype)
        elif rtype == "session":
            # agentPreset живёт на верхнем уровне записи (репро golden-run e);
            # data — legacy-фоллбек
            facts["agent_preset"] = rec.get("agentPreset") or data.get("agentPreset")
            facts["session_id"] = rec.get("id")
            facts["session_origin"] = rec.get("origin")
            facts["session_parent"] = rec.get("parentSession")
            facts["session_created_at"] = rec.get("createdAt")
        elif rtype == "turn/start":
            facts["turns"] += 1
    # ровно один header и ни одного change => system+tools байт-стабильны
    facts["system_stable"] = (
        facts["header_count"] == 1 and "change" not in facts["header_reasons"]
    )
    # каталог тулов стабилен между header'ами (f: план-мод меняет system,
    # но НЕ инструменты — «tool catalog stays the same across modes»)
    facts["tools_stable"] = len(set(facts["tools_shas"])) <= 1
    return facts


# --- скан дочерних сессий (субагенты) ------------------------------------------

#: допуск (мс) спавн-времени при маппинге роль→дочь: createdAt ребёнка идёт
#: ПОСЛЕ dispatch-start родителя (репро golden-run e: +7 мс), но лог-время
#: записей может чуть гулять на границах
SPAWN_TIME_TOLERANCE_MS = 2000


def _child_role(created_at, spawn_events) -> Optional[str]:
    """Роль субагента для дочерней сессии по времени её создания.

    Спавн-события родителя (tool/call|code-dispatch-start subagent_*) несут
    time (мс); дочерняя session-запись — createdAt. Дочь принадлежит ПОСЛЕДНЕМУ
    спавну, случившемуся не позже её createdAt (+допуск). Спавны сценария e
    строго последовательные (run_in_background: false, «дождись результата»),
    поэтому времени достаточно; session-id в dispatch-результате dsh не пишет.
    """
    if created_at is None:
        return None
    role = None
    for ev in spawn_events or []:
        t = ev.get("time")
        if t is None:
            continue
        if t <= created_at + SPAWN_TIME_TOLERANCE_MS:
            role = ev.get("name")
    return role


def scan_sessions(
    sessions_root: str,
    newer_than: float,
    exclude: Optional[str] = None,
    parent_session_id: Optional[str] = None,
    spawn_events: Optional[list] = None,
) -> list[dict]:
    """Найти дочерние сессии субагентов в $DSH_HOME/sessions.

    Субагент dsh-subagent (spawn-провайдер) создаёт полноценную сессию в
    общем session store: $DSH_HOME/sessions/<sanitized-cwd>/<id>/
    session.jsonl(.zstd). Пин модели (agentOptions.model) виден в её
    request/header -> config.model.

    «Дочерность» определяется linkage-полями session-записи (review MAJOR#2):
    origin == "subagent" (+ parentSession == id родителя, если задан) — а НЕ
    «любая свежая сессия стора»: сценарии одного прогона пишут в тот же стор
    в то же окно.

    Args:
        sessions_root: каталог $DSH_HOME/sessions.
        newer_than: unix-time — брать только сессии, изменённые после
            (mtime), т.е. созданные в текущем прогоне.
        exclude: путь session-файла родителя (не включать в результат).
        parent_session_id: id родительской session-записи (фильтр parentSession).
        spawn_events: спавн-события родителя (session_facts["spawn_events"]) —
            для маппинга дочерней сессии на вызвавшую её роль.

    Returns:
        Список {"path", "provider", "model", "agent_preset", "origin",
        "parent_session", "created_at", "role"} — по одной записи на найденную
        сессию. Битые/пустые файлы пропускаются молча.
    """
    import glob as _glob

    out: list[dict] = []
    pattern = os.path.join(sessions_root, "*", "*", "session.jsonl*")
    for path in _glob.glob(pattern):
        try:
            if os.stat(path).st_mtime < newer_than:
                continue
        except OSError:
            continue
        if exclude is not None and os.path.abspath(path) == os.path.abspath(exclude):
            continue
        recs = read_session_records(path)
        has_header = False
        entry = {
            "path": path,
            "provider": None,
            "model": None,
            "agent_preset": None,
            "origin": None,
            "parent_session": None,
            "created_at": None,
            "role": None,
        }
        for rec in recs:
            rtype = rec.get("type", "")
            if rtype == "request/header" and not has_header:
                has_header = True
                cfg = (rec.get("data") or {}).get("header", {}).get("config") or {}
                entry["provider"] = cfg.get("provider")
                entry["model"] = cfg.get("model")
            elif rtype == "session":
                data = rec.get("data") or {}
                entry["agent_preset"] = rec.get("agentPreset") or data.get("agentPreset")
                entry["origin"] = rec.get("origin")
                entry["parent_session"] = rec.get("parentSession")
                entry["created_at"] = rec.get("createdAt")
            if has_header and entry["agent_preset"] is not None:
                break
        # фильтр «дочерности»: только сессии субагентов нашего родителя
        if entry["origin"] != "subagent":
            continue
        if parent_session_id is not None and entry["parent_session"] != parent_session_id:
            continue
        entry["role"] = _child_role(entry["created_at"], spawn_events)
        if has_header:
            out.append(entry)
    return out


# --- метрика кеша --------------------------------------------------------------

def cache_pct(
    usage_steps: list[dict], stable_from_step: int = DEFAULT_STABLE_FROM_STEP
) -> tuple[Optional[float], int]:
    """Средний cache_read/input (inclusive семантика) по кешированным шагам.

    Args:
        usage_steps: список шагов из session_facts.
        stable_from_step: шаг, с которого кеш считается устоявшимся
            (шаг 1 — холодный, его промах не штрафуем).

    Returns:
        (pct, n): средний процент по шагам с cacheReadTokens != None
        (inputTokens > 0), n — сколько таких шагов; (None, 0) если нет данных.
    """
    ratios = []
    for s in usage_steps:
        cr, it = s.get("cacheReadTokens"), s.get("inputTokens")
        step = s.get("step") or 0
        if cr is None or not it or step < stable_from_step:
            continue
        ratios.append(cr / it)
    if not ratios:
        return None, 0
    return sum(ratios) / len(ratios) * 100.0, len(ratios)


# --- вердикты по сценариям ------------------------------------------------------

def _check_system_and_cache(facts: dict, stable_from_step: int) -> dict:
    """Общие проверки: заморозка system + кеш на устойчивых шагах."""
    pct, n = cache_pct(facts["usage_steps"], stable_from_step)
    return {
        "system_stable": facts["system_stable"],
        "header_count": facts["header_count"],
        "cache_pct": round(pct, 2) if pct is not None else None,
        "cache_steps": n,
        "cache_steps_present": n > 0,
    }


def _apply_cache_requirements(checks: dict, facts: dict, required: list) -> None:
    """Анти-вакуум кеш-метрики, единый для всех сценариев cli-группы (review MAJOR#4).

    Три уровня:
      * usage_steps_present — данные LLM-шагов собираются ВООБЩЕ (лог/анализ
        живы). Обязателен всегда, независимо от канала.
      * cache_steps_present — есть шаги с cacheReadTokens. Обязателен, если
        кеш-данные есть ИЛИ проба канала (facts["channel_reports_cache"],
        внешний факт от run.sh: прямой запрос в relay) не сказала «канал
        не репортит». Дефолт (пробы нет) — строгий режим.
      * cache_pct_ge_97 — при наличии кеш-данных.

    Ослабление возможно ТОЛЬКО внешним фактом channel_reports_cache=False
    (сам канал не возвращает кеш-поля — свойство апстрима relay, не dsh);
    в этом случае факт фиксируется в checks["cache_reporting"] и виден в
    отчёте прогона. dsh-регрессия записи кеша при репортящем канале даёт
    честный FAIL (probe=True, шагов нет).
    """
    checks["usage_steps_present"] = any(
        s.get("inputTokens") for s in facts.get("usage_steps") or []
    )
    required.append("usage_steps_present")
    channel = facts.get("channel_reports_cache")
    if checks["cache_steps"] > 0:
        required.append("cache_steps_present")
        if checks["cache_pct"] is not None:
            checks["cache_pct_ge_97"] = checks["cache_pct"] >= CACHE_PASS_PCT
            required.append("cache_pct_ge_97")
    elif channel is False:
        checks["cache_reporting"] = "channel-no-report"
    else:
        # строгий дефолт: нет кеш-шагов и нет оправдания каналом — FAIL
        required.append("cache_steps_present")


def verdict(scenario: str, facts: dict, stable_from_step: int = DEFAULT_STABLE_FROM_STEP) -> dict:
    """Вердикт сценария golden suite по фактам сессии.

    Args:
        scenario: a (run_code) | b (MCP activate+call) | c (spot cold-load) |
            d (compaction) | e (role-pinned subagents) | f (plan-mode grill).
        facts: результат session_facts (+ опционально child_sessions /
            workdir_unchanged_until_exit / channel_reports_cache из внешних
            источников — CLI-флаги --sessions-root / --extra-facts).
        stable_from_step: см. cache_pct.

    Returns:
        {"pass": bool, "checks": {...}} — pass только если ВСЕ обязательные
        проверки истинны.

    Raises:
        ValueError: неизвестный сценарий.
    """
    if scenario not in ("a", "b", "c", "d", "e", "f"):
        raise ValueError(f"unknown scenario: {scenario}")
    calls = facts["tool_calls"]
    all_calls = calls + facts.get("dispatch_calls", [])
    checks = _check_system_and_cache(facts, stable_from_step)
    if scenario == "a":
        # code-mode: точное имя run_code (tool/call или code-dispatch) —
        # «code...»-импостеры не зачитываются (review MINOR)
        checks["run_code_called"] = "run_code" in all_calls
        required = ["system_stable", "run_code_called"]
    elif scenario == "b":
        checks["mcp_activated"] = facts["mcp_activation"]
        checks["mcp_tool_called"] = any(
            c.startswith("mcp__") and "search_and_activate" not in c and not c.endswith("__activate")
            for c in all_calls
        )
        required = ["system_stable", "mcp_activated", "mcp_tool_called"]
    elif scenario == "c":
        checks["spot_search_called"] = "spot_search" in all_calls
        checks["spot_load_called"] = "spot_load" in all_calls
        required = ["system_stable", "spot_search_called", "spot_load_called"]
    elif scenario == "d":
        checks["compaction_completed"] = (
            "compaction/start" in facts["compaction_events"]
            and "compaction/end" in facts["compaction_events"]
        )
        checks["turns_after_compaction"] = facts["turns"] >= 2
        required = ["system_stable", "compaction_completed", "turns_after_compaction"]
    elif scenario == "e":
        # рольные субагенты (C-4): родитель вызвал запинненные тулы, и в
        # session store появились ДОЧЕРНИЕ сессии с pinned-моделью на cli.
        # Пин = agentOptions.model в dsh-tool-subagent (пресет code-lazy),
        # проверяется по request/header дочерней сессии, НЕ по dump-config.
        # Маппинг роль→дочь (review MAJOR#1): дочь матчится к вызванной роли
        # (origin=subagent + parentSession + spawn-время), и проверяется ПАРА
        # (роль, модель) — своп пинов (research->sonnet) обязан FAIL-ить,
        # а не PASS-ать по множеству моделей.
        checks["subagent_research_called"] = "subagent_research" in all_calls
        checks["subagent_exec_called"] = "subagent_exec" in all_calls
        children = facts.get("child_sessions") or []
        checks["child_sessions_found"] = len(children) > 0
        checks["child_research_haiku_cli"] = any(
            c.get("role") == "subagent_research"
            and c.get("model") == "haiku"
            and c.get("provider") == "cli"
            for c in children
        )
        checks["child_exec_sonnet_cli"] = any(
            c.get("role") == "subagent_exec"
            and c.get("model") == "sonnet"
            and c.get("provider") == "cli"
            for c in children
        )
        required = [
            "system_stable",
            "subagent_research_called",
            "subagent_exec_called",
            "child_sessions_found",
            "child_research_haiku_cli",
            "child_exec_sonnet_cli",
        ]
    else:  # f
        # план-мод рисёч+ (C-5): на материально неоднозначной задаче модель
        # спрашивает (ask_user_question) ДО exit_plan_mode и не мутирует
        # файлы до подачи плана. Мутации меряет драйвер (манифест work dir
        # до/на момент exit_plan_mode) и передаёт через extra-facts.
        # system_stable НЕ проверяем (review MAJOR#3, задокументированное
        # исключение план-мода): вход в план-мод ШТАТНО меняет system (режется
        # секция, reason:"change"). Вместо него tools_stable — каталог тулов
        # не растёт между режимами («tool catalog stays the same across modes»).
        order = facts.get("calls_in_order") or []
        ask_idx = next((i for i, n in enumerate(order) if n == "ask_user_question"), None)
        exit_idx = next((i for i, n in enumerate(order) if n == "exit_plan_mode"), None)
        checks["ask_user_question_called"] = ask_idx is not None
        checks["exit_plan_mode_called"] = exit_idx is not None
        checks["ask_before_exit"] = (
            ask_idx is not None and exit_idx is not None and ask_idx < exit_idx
        )
        # отсутствие факта = FAIL (анти-вакуум, как cache_steps в сценарии a)
        checks["no_mutations_until_exit"] = facts.get("workdir_unchanged_until_exit") is True
        checks["tools_stable"] = facts.get("tools_stable", True)
        required = [
            "ask_user_question_called",
            "exit_plan_mode_called",
            "ask_before_exit",
            "no_mutations_until_exit",
            "tools_stable",
        ]
    _apply_cache_requirements(checks, facts, required)
    return {
        "scenario": scenario,
        "pass": all(checks[k] for k in required),
        "required": required,
        "checks": checks,
    }


# --- CLI ------------------------------------------------------------------------

def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("session", help="путь до session.jsonl(.zstd)")
    ap.add_argument("--scenario", choices=["a", "b", "c", "d", "e", "f"])
    ap.add_argument("--stable-from-step", type=int, default=DEFAULT_STABLE_FROM_STEP)
    ap.add_argument("--facts", action="store_true", help="только факты, без вердикта")
    ap.add_argument("--json", action="store_true", help="вывод одной JSON-строкой")
    ap.add_argument(
        "--sessions-root",
        help="каталог $DSH_HOME/sessions (сценарий e): скан дочерних сессий субагентов",
    )
    ap.add_argument(
        "--newer-than",
        type=float,
        default=0.0,
        help="unix-time: дочерние сессии старше игнорируются (сценарий e)",
    )
    ap.add_argument(
        "--extra-facts",
        help="JSON-строка с доп. фактами (сценарий f: workdir_unchanged_until_exit)",
    )
    args = ap.parse_args(argv)

    records = read_session_records(args.session)
    facts = session_facts(records)
    if args.sessions_root:
        facts["child_sessions"] = scan_sessions(
            args.sessions_root,
            newer_than=args.newer_than,
            exclude=args.session,
            parent_session_id=facts.get("session_id"),
            spawn_events=facts.get("spawn_events"),
        )
    if args.extra_facts:
        try:
            extra = json.loads(args.extra_facts)
        except json.JSONDecodeError as e:
            print(f"error: --extra-facts не JSON: {e}", file=sys.stderr)
            return 2
        if not isinstance(extra, dict):
            print("error: --extra-facts должен быть JSON-объектом", file=sys.stderr)
            return 2
        facts.update(extra)
    out: dict = {"session": os.path.abspath(args.session)}
    if args.facts or not args.scenario:
        out["facts"] = facts
    if args.scenario:
        out["verdict"] = verdict(args.scenario, facts, args.stable_from_step)
    if args.json:
        print(json.dumps(out, ensure_ascii=False))
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        if "verdict" in out:
            print(f"VERDICT_{args.scenario.upper()}: {'PASS' if out['verdict']['pass'] else 'FAIL'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
