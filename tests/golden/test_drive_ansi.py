#!/usr/bin/env python3
"""test_drive_ansi.py — TDD-тесты ANSI-детекции панелей в PTY-драйвере golden.

TG-DSH-FIXUP-20260914 node 1. Root cause «гонки ask-панели» (backlog
20260914 ловушки 5-6): панель вопросов монтируется и отрисовывается, но
ink-рендер dsh-tui пишет кадр ПОЯЧЕЙНЫМ диффом (log-update.js): пустые
ячейки (пробелы без стиля) не пишутся, курсор перепрыгивает их CUF
(\\x1b[N C). Слова hint-строки разделяются escape-кодами:
«Enter\\x1b[1Csubmit» — contiguous-поиск «Enter submit» в сырых байтах
PTY НИКОГДА не срабатывает для такого кадра. Драйвер считал панель
несмонтированной (ложный Esc-fallback через 120с), хотя панель была
на экране (подтверждено виртуальным экраном: репро 20260914T083643Z,
vmdev, сессия 8f3a0b75).

Фикстура ask_panel_cuf_frame.bin — реальный кадр PTY из этого репро:
  - pyte-рендер показывает «Enter submit» на экране (строка hint);
  - b"Enter submit" в raw bytes ОТСУТСТВУЕТ.

Тестируют модуль drive_session.VirtualScreen (мини-эмулятор на stdlib)
и детекцию маркеров dialog_markers_visible().
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest

from drive_session import (
    ASK_MARKERS,
    DIALOG_MARKERS,
    ENTER_ATTEMPTS_BEFORE_ESC,
    REVIEW_MARKERS,
    VirtualScreen,
    _open_call,
    _open_call_id,
    ask_next_action,
    dialog_markers_visible,
)

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "ask_panel_cuf_frame.bin")


@pytest.fixture(scope="module")
def fixture_bytes() -> bytes:
    with open(FIXTURE, "rb") as f:
        return f.read()


class TestVirtualScreenBasics:
    """Мини-эмулятор: покомандная семантика."""

    def test_plain_text_lands_in_row0(self):
        vs = VirtualScreen()
        vs.feed(b"hello")
        assert "hello" in vs.text()

    def test_cuf_skips_cells_without_writing(self):
        # «Enter\x1b[1Csubmit» → на экране «Enter submit», в raw нет
        vs = VirtualScreen()
        vs.feed(b"Enter\x1b[1Csubmit")
        assert vs.text().splitlines()[0] == "Enter submit"

    def test_cub_moves_back(self):
        vs = VirtualScreen()
        vs.feed(b"abcdef\x1b[2D")  # курсор с позиции 6 назад на 2 → на 'e'
        vs.feed(b"XY")             # перезапишет 'ef'
        assert vs.text().splitlines()[0].startswith("abcdXY")

    def test_cup_positions_absolute(self):
        vs = VirtualScreen()
        vs.feed(b"\x1b[5;10Hx")  # row 5, col 10
        lines = vs.text().splitlines()
        assert lines[4][9] == "x"

    def test_cr_returns_to_line_start(self):
        vs = VirtualScreen()
        vs.feed(b"abc\rXY")
        assert vs.text().splitlines()[0].startswith("XY")

    def test_lf_advances_line(self):
        vs = VirtualScreen()
        vs.feed(b"a\r\nb")
        lines = vs.text().splitlines()
        assert lines[0].startswith("a") and lines[1].startswith("b")

    def test_lf_at_bottom_scrolls(self):
        # ROWS+10 строк «lineN\r\n» → 10 прокруток: line0..line9 ушли,
        # последняя строка (line{ROWS+9}) видна
        vs = VirtualScreen()
        total = VirtualScreen.ROWS + 10
        for i in range(total):
            vs.feed(f"line{i}\r\n".encode())
        text = vs.text()
        assert "line0" not in text
        assert "line9" not in text
        assert f"line{total - 1}" in text

    def test_el_clears_to_eol(self):
        vs = VirtualScreen()
        vs.feed(b"abcdef\r\x1b[0K")
        assert vs.text().splitlines()[0].strip() == ""

    def test_ed_clears_screen(self):
        vs = VirtualScreen()
        vs.feed(b"abc\r\ndef")
        vs.feed(b"\x1b[2J")
        assert vs.text().strip() == ""

    def test_sgr_ignored(self):
        vs = VirtualScreen()
        vs.feed(b"\x1b[38;5;145mEnter\x1b[1Csubmit\x1b[39m")
        assert "Enter submit" in vs.text()

    def test_decset_ignored(self):
        # synchronized output markers (\x1b[?2026h / l) в потоке — 2К+ на прогон
        vs = VirtualScreen()
        vs.feed(b"\x1b[?2026hEnter\x1b[1Csubmit\x1b[?2026l")
        assert "Enter submit" in vs.text()

    def test_fullwidth_char_takes_two_cells(self):
        # «📋» (wide) + « Question» — разделитель после эмодзи должен
        # попасть в правильную колонку, а не нарисовать строку со сдвигом
        vs = VirtualScreen()
        vs.feed("📋 Question 1/2".encode())
        assert "Question 1/2" in vs.text()

    def test_incremental_feed_same_state(self):
        # эмулятор кормится инкрементально (только новые байты) —
        # состояние эквивалентно одиночной подаче
        whole = b"Enter\x1b[1Csubmit\r\n\x1b[1B\x1b[2Cok"
        a = VirtualScreen()
        a.feed(whole)
        b = VirtualScreen()
        for i in range(0, len(whole), 3):
            b.feed(whole[i:i + 3])
        assert a.text() == b.text()

    def test_survives_megabyte_of_spinner_frames(self):
        # буфер драйвера — до 1MB спиннер-диффов; эмулятор должен
        # переваривать это без взрыва
        vs = VirtualScreen()
        chunk = (b"\x1b[?2026h\x1b[4A\x1b[20D  \xe2\x9c\xbb Sublimating"
                 b"\xe2\x80\xa6 (2m 27s)\x1b[?2026l") * 5000
        vs.feed(chunk)
        assert "Sublimating" in vs.text()


class TestMarkerDetection:
    """Детекция панелей: raw-поиск ломается о cell-skip дифф."""

    def test_fixture_marker_missing_in_raw_bytes(self, fixture_bytes):
        # УСЛОВИЕ БАГА: в сырых байтах маркера нет — старая детекция слепа
        assert b"Enter submit" not in fixture_bytes

    def test_fixture_marker_visible_on_virtual_screen(self, fixture_bytes):
        # НОВАЯ детекция: маркер виден на виртуальном экране
        vs = VirtualScreen()
        vs.feed(fixture_bytes)
        assert "Enter submit" in vs.text(), (
            "фикстура обязана рендерить hint-строку панели "
            "(см. комментарий в шапке теста)"
        )

    def test_fixture_question_header_visible(self, fixture_bytes):
        vs = VirtualScreen()
        vs.feed(fixture_bytes)
        assert "Question 1/2" in vs.text()

    def test_dialog_markers_visible_on_fixture(self, fixture_bytes):
        assert dialog_markers_visible(fixture_bytes)

    def test_dialog_markers_invisible_on_plain_stream(self):
        # спиннер без панели — маркеров нет (нет ложного срабатывания)
        chunk = b"\x1b[?2026h  \xe2\x9c\xbb Sublimating\xe2\x80\xa6 (2m 27s)\x1b[?2026l"
        assert not dialog_markers_visible(chunk)

    def test_dialog_markers_all_i18n_variants(self):
        # en/zh-варианты ask-hint и план-ревью hint (специфичный «quick-pick»/
        # «快选» вместо общего «Esc dismiss», review MINOR: btw/recap-панели
        # тоже пишут «Esc dismiss» и получили бы преждевременный Enter)
        for marker_frame in (
            b"Enter\x1b[1Csubmit",
            "Enter 提交".encode(),
            b"1/2\x1b[1Cquick-pick",
            "快选".encode(),
            b"Enter submit",  # contiguous-кадр тоже ловим (регресс)
        ):
            assert dialog_markers_visible(marker_frame), marker_frame

    def test_existing_dialog_markers_are_supported(self):
        # контракты ASK/REVIEW/DIALOG маркеров — все детектятся
        for m in DIALOG_MARKERS:
            assert dialog_markers_visible(m.encode()), m
        assert "quick-pick" in REVIEW_MARKERS
        assert "Enter submit" in ASK_MARKERS
        # общий «Esc dismiss» больше НЕ маркер (review MINOR)
        assert "Esc dismiss" not in DIALOG_MARKERS


class TestHangingAsk:
    """Тактика «зависший ask»: вопрос со свободным ответом чистый Enter НЕ
    закрывает (нет Recommended-опции) — после порога безуспешных Enter по
    ТОМУ ЖЕ вызову шлём Esc (cancel, ASK_CANCELLED). Репро 20260914T100406Z:
    77 Enter в пустоту, ход f умер на таймауте."""

    def test_escalation_enter_type_cancel(self):
        N = ENTER_ATTEMPTS_BEFORE_ESC
        assert ask_next_action("call_x:code:1", 0) == "enter"
        assert ask_next_action("call_x:code:1", N - 1) == "enter"
        assert ask_next_action("call_x:code:1", N) == "type"
        assert ask_next_action("call_x:code:1", 2 * N - 1) == "type"
        assert ask_next_action("call_x:code:1", 2 * N) == "cancel"
        assert ask_next_action("call_x:code:1", 10_000) == "cancel"

    def test_no_escalation_without_call(self):
        # вызова нет — решение не применяется
        assert ask_next_action(None, 10_000) == "enter"

    def test_open_call_id_and_reset_on_new_call(self):
        # смена открытого вызова (новый батч) — счётчик Enter обнуляется
        # (проверяем саму идентификацию: оба вызова «открыты» по очереди)
        recs = [
            {"type": "tool/code-dispatch-start",
             "data": {"name": "ask_user_question", "subCallId": "d:code:1"}},
            {"type": "tool/code-dispatch",
             "data": {"name": "ask_user_question", "subCallId": "d:code:1"}},
            {"type": "tool/code-dispatch-start",
             "data": {"name": "ask_user_question", "subCallId": "d:code:2"}},
        ]
        assert _open_call(recs, "ask_user_question")
        assert _open_call_id(recs, "ask_user_question") == "d:code:2"

    def test_open_call_id_none_when_settled(self):
        recs = [
            {"type": "tool/code-dispatch-start",
             "data": {"name": "ask_user_question", "subCallId": "d:code:9"}},
            {"type": "tool/code-dispatch-start",
             "data": {"name": "ask_user_question", "subCallId": "d:code:10"}},
            # результат БЕЗ subCallId: закрывает ПОСЛЕДНИЙ открытый (d:code:10),
            # d:code:9 остаётся открытым — insertion-порядок, не сортировка
            {"type": "tool/code-dispatch",
             "data": {"name": "ask_user_question"}},
        ]
        assert _open_call_id(recs, "ask_user_question") == "d:code:9"

    def test_open_call_false_when_all_settled(self):
        recs = [
            {"type": "tool/code-dispatch-start",
             "data": {"name": "ask_user_question", "subCallId": "d:code:9"}},
            {"type": "tool/code-dispatch",
             "data": {"name": "ask_user_question", "subCallId": "d:code:9"}},
        ]
        assert not _open_call(recs, "ask_user_question")
