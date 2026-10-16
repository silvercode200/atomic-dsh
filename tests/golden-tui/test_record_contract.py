"""Контрактные тесты артефактов записи termseer record (golden-tui).

Валидируют формат артефактов, которые производят SOC-спецшаги
``record start/stop`` и ``frames <name> diff`` (autotestvm/termseer_provider.py,
репо MCP/SOC). Тесты не требуют ни zellij, ни сети: гоняются по
зафиксированным демо-артефактам (reports/golden-tui/soc-evidence/) и по
синтетическим данным, собранным в tmp-каталоге. Контракт:

- cast — asciinema v2: строка 1 JSON {version:2, width, height, timestamp,
  env.TERM}; далее строки {"time": float, "event": "o", "data": str} с
  неубывающим time;
- meta.jsonl — по объекту на кадр: {i, ts, rows_total, last_nonempty_row,
  nonempty_count, status_row_text, blank_ratio};
- summary.json — {frames, duration_s, changed_frames, blank_ratio_min/max,
  last_nonempty_row_min/max, gap_under_status_row_max}.

Если SOC меняет формат артефактов — эти тесты ловят дрейф до того, как
golden-tui/live-smoke.sh начнёт молча пропускать битые записи.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
DEMO = HERE.parent.parent / "reports" / "golden-tui" / "soc-evidence" / "demo-cast-and-timeline.txt"


def _cast_lines(demo_text: str) -> list[dict]:
    """Достать JSON-строки cast из демо-файла (первая секция до summary)."""
    lines = []
    for line in demo_text.splitlines():
        line = line.strip()
        if line.startswith("{"):
            lines.append(json.loads(line))
        elif line.startswith("=== summary"):
            break
    return lines


def test_demo_cast_header_is_asciinema_v2():
    cast = _cast_lines(DEMO.read_text(encoding="utf-8"))
    assert cast, "демо-cast пуст"
    header = cast[0]
    assert header["version"] == 2
    assert header["width"] > 0 and header["height"] > 0
    assert header["env"]["TERM"]


def test_demo_cast_events_are_output_frames():
    cast = _cast_lines(DEMO.read_text(encoding="utf-8"))
    events = cast[1:]
    assert len(events) >= 1
    last_time = 0.0
    for event in events:
        assert event["event"] == "o", "все строки после header — output-кадры"
        assert isinstance(event["data"], str) and event["data"]
        assert event["time"] >= last_time, "time неубывающий"
        last_time = event["time"]


def test_demo_summary_has_blank_and_gap_metrics():
    text = DEMO.read_text(encoding="utf-8")
    marker = text.index("=== summary.json ===")
    # первая JSON-строка после заголовка секции — summary; дальше идёт
    # секция frames_diff (не JSON) — берём ровно одну строку
    summary = json.loads(text[marker:].split("\n", 1)[1].split("\n", 1)[0].strip())
    for key in (
        "frames",
        "duration_s",
        "changed_frames",
        "blank_ratio_min",
        "blank_ratio_max",
        "last_nonempty_row_min",
        "last_nonempty_row_max",
        "gap_under_status_row_max",
    ):
        assert key in summary, f"summary.json без обязательного ключа {key}"
    # gap под статус-баром — метрика «пустых зон»: 0 = контент до низа
    assert summary["gap_under_status_row_max"] >= 0


def _write_meta(path: Path, frames: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for frame in frames:
            fh.write(json.dumps(frame, ensure_ascii=False) + "\n")


def test_meta_jsonl_contract(tmp_path):
    meta = tmp_path / "meta.jsonl"
    _write_meta(meta, [
        {"i": 0, "ts": 1.0, "rows_total": 24, "last_nonempty_row": 23,
         "nonempty_count": 5, "status_row_text": "  ✦ glm-5.3", "blank_ratio": 0.79},
        {"i": 1, "ts": 1.2, "rows_total": 24, "last_nonempty_row": 18,
         "nonempty_count": 7, "status_row_text": "", "blank_ratio": 0.71},
    ])
    entries = [json.loads(line) for line in meta.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(entries) == 2
    for entry in entries:
        assert {"i", "ts", "rows_total", "last_nonempty_row",
                "nonempty_count", "status_row_text", "blank_ratio"} <= set(entry)
    # вторая серия: контент поднялся (last_nonempty_row упал = пустые зоны
    # под статус-баром выросли) — детектор gap_growth видит это по метрике
    gap_first = entries[0]["rows_total"] - entries[0]["last_nonempty_row"] - 1
    gap_second = entries[1]["rows_total"] - entries[1]["last_nonempty_row"] - 1
    assert gap_second > gap_first, "рост gap под статус-баром должен быть виден в meta"


def test_meta_frames_survive_trailing_blank_rows(tmp_path):
    """Экран с trailing-пустыми строками (кейс «пустые зоны под баром») —
    rows_total не должен съедать их (ловушка, закрытая в SOC record)."""
    meta = tmp_path / "meta.jsonl"
    _write_meta(meta, [
        {"i": 0, "ts": 1.0, "rows_total": 40, "last_nonempty_row": 12,
         "nonempty_count": 12, "status_row_text": "status", "blank_ratio": 0.70},
    ])
    entry = json.loads(meta.read_text(encoding="utf-8").splitlines()[0])
    assert entry["rows_total"] == 40
    assert entry["rows_total"] - entry["last_nonempty_row"] - 1 == 27


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
