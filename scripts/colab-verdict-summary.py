#!/usr/bin/env python3
"""colab-verdict-summary.py — агрегатор RED/GREEN/pristine-вердиктов живых прогонов.

Читает verdict.json трёх прогонов драйвера (colab-dsh-live-check.sh):
  -- red    : patches:<ref> (стек без фикса) — баг-детекторы обязаны падать
              (reproduced: true) = юзерские баги воспроизведены на Colab.
  -- green  : current/HEAD (стек с фиксом) — те же детекторы обязаны пройти
              (reproduced: false) = дельта доказывает, что фикс работает.
  -- pristine : npm-пакет без патчей — slash_menu_effects обязан падать
              (контроль: патч-стек не no-op).
Печатает агрегат в stdout и пишет <out>/verdict.json.

Использование:
  python3 scripts/colab-verdict-summary.py --red <dir> [--green <dir>]
      [--pristine <dir>] [--out <dir>]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

#: Детекторы юзерских багов 1-5 (layout) — красные на unpatched-стеке.
LAYOUT_DETECTORS = (
    "footer_bottom_gap", "status_single_line", "ctx_value_no_dup",
    "input_at_bottom", "no_layout_jitter",
)
#: Контрольный детектор стека (наличие /effects): красный на pristine.
EFFECTS_DETECTORS = ("slash_menu_effects",)


def load_verdict(path: str) -> dict:
    """Прочитать verdict.json одного прогона; ошибки — в исключение."""
    p = Path(path) / "verdict.json"
    if not p.is_file():
        raise SystemExit(f"нет {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def detector_map(verdict: dict) -> dict[str, dict]:
    """{имя теста: запись} из verdict.tests."""
    return {t["name"]: t for t in verdict.get("tests", [])}


def collect_side(verdict: dict | None, label: str) -> dict:
    """Сводка по одной стороне red-матрицы."""
    if verdict is None:
        return {"label": label, "available": False}
    tests = detector_map(verdict)
    layout = {
        name: {
            "status": tests.get(name, {}).get("status", "absent"),
            "reproduced": tests.get(name, {}).get("reproduced"),
        }
        for name in LAYOUT_DETECTORS
    }
    effects = {
        name: {
            "status": tests.get(name, {}).get("status", "absent"),
            "reproduced": tests.get(name, {}).get("reproduced"),
        }
        for name in EFFECTS_DETECTORS
    }
    return {
        "label": label,
        "available": True,
        "target": verdict.get("target"),
        "job_id": verdict.get("job_id"),
        "program_status": verdict.get("program_status"),
        "report_dir": str(Path(verdict.get("_dir", ""))) if verdict.get("_dir") else None,
        "layout_bugs_reproduced": sum(
            1 for v in layout.values() if v["reproduced"] is True
        ),
        "layout_detectors": layout,
        "effects": effects,
    }


def main() -> int:
    """Собрать агрегированный verdict; rc=0 если red-критерий ≥3 и дельта есть."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--red", required=True, help="каталог red-прогона (verdict.json)")
    ap.add_argument("--green", help="каталог green-прогона")
    ap.add_argument("--pristine", help="каталог pristine-прогона (контроль)")
    ap.add_argument("--out", help="каталог для агрегированного verdict.json (stdout тоже)")
    args = ap.parse_args()

    red_v = load_verdict(args.red)
    red_v["_dir"] = str(Path(args.red).resolve())
    green_v = load_verdict(args.green) if args.green else None
    if green_v:
        green_v["_dir"] = str(Path(args.green).resolve())
    pristine_v = load_verdict(args.pristine) if args.pristine else None
    if pristine_v:
        pristine_v["_dir"] = str(Path(args.pristine).resolve())

    red = collect_side(red_v, "red")
    green = collect_side(green_v, "green") if green_v else {"label": "green", "available": False}
    pristine = collect_side(pristine_v, "pristine") if pristine_v else {"label": "pristine", "available": False}

    # Дельта: детектор, красный на red И зелёный на green = фикс между стеками.
    fixed_by_green = []
    if green.get("available"):
        for name in LAYOUT_DETECTORS:
            r = red["layout_detectors"].get(name, {})
            g = green["layout_detectors"].get(name, {})
            if r.get("reproduced") is True and g.get("reproduced") is False:
                fixed_by_green.append(name)

    # Полнее: детектор, красный на PRISTINE и чистый на red-стеке = патч-стек
    # чинит upstream-баг (эмпирика 2026-09-18: юзерские layout-баги живут в
    # npm-пакете, патчи 1-44 их уже чинят).
    fixed_by_stack = []
    if pristine.get("available"):
        for name in LAYOUT_DETECTORS:
            p = pristine["layout_detectors"].get(name, {})
            r = red["layout_detectors"].get(name, {})
            if p.get("reproduced") is True and r.get("reproduced") is False:
                fixed_by_stack.append(name)

    # Контроль pristine: effects-ассерт обязан падать (стек не no-op).
    pristine_effects_fail = None
    if pristine.get("available"):
        e = pristine["effects"].get("slash_menu_effects", {})
        pristine_effects_fail = e.get("reproduced") is True or e.get("status") == "fail"

    # Критерий: баги юзера воспроизведены (на любом таргете) + стек чинит
    # их (pristine→red дельта) ИЛИ red→green дельта; effects-контроль обязателен.
    reproduced_anywhere = red["layout_bugs_reproduced"] + (
        pristine.get("layout_bugs_reproduced", 0) if pristine.get("available") else 0
    )
    fix_delta = max(len(fixed_by_stack), len(fixed_by_green))
    matrix_ok = reproduced_anywhere >= 3 and fix_delta >= 3

    aggregate = {
        "schema_version": "colab-red-verdict/1",
        "red": red,
        "green": green,
        "pristine_control": {
            **pristine,
            "slash_menu_effects_fails": pristine_effects_fail,
        },
        "fixed_by_green": fixed_by_green,
        "fixed_by_stack_from_pristine": fixed_by_stack,
        "criteria": {
            "user_bugs_reproduced_min_3": reproduced_anywhere >= 3,
            "reproduced_count_any_target": reproduced_anywhere,
            "red_reproduced_count": red["layout_bugs_reproduced"],
            "pristine_reproduced_count": (
                pristine.get("layout_bugs_reproduced") if pristine.get("available") else None
            ),
            "fix_delta_min_3": fix_delta >= 3,
            "fix_delta_count": fix_delta,
            "pristine_effects_assert_fails": pristine_effects_fail,
        },
        "exit_code": 0 if (matrix_ok and pristine_effects_fail) else 1,
    }

    text = json.dumps(aggregate, ensure_ascii=False, indent=1)
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        # НЕ перезаписывать verdict.json прогона (артефакт драйвера):
        # агрегат пишется отдельным verdict-summary.json.
        (out / "verdict-summary.json").write_text(text + "\n", encoding="utf-8")
    print(text)
    return aggregate["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
