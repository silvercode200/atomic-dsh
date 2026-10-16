#!/usr/bin/env python3
"""drive_session.py — PTY-драйвер dsh TUI для golden smoke-сьюта.

Запускается НА ЦЕЛЕВОЙ МАШИНЕ (vmdev / colab VM): спавнит `dsh --profile dsh-tui`
в PTY, ведёт multi-turn сценарий (промпты + /compact), поллит session.jsonl.zstd
на завершение ходов. Никаких зависимостей — только stdlib (pty, select).

Все проверки делает analyze.py — драйвер только водит сессию и возвращает
путь к session.jsonl.zstd.

Usage (внутри run.sh, на целевой машине):
    python3 drive_session.py --dsh-home /tmp/dsh-golden/dsh-home \
        --work-dir /tmp/dsh-golden/work --scenario b --plan plan_b.json

План (JSON): [{"send": "текст промпта"}, {"slash": "/compact"},
              {"sleep": 5}, {"respond": {"stop_on_call": "...", "workdir": true}}, ...]
Отправка промпта происходит после готовности TUI (маркер в PTY-выводе),
следующий — после turn/end предыдущего (или compaction/end).
respond — интерактивный ход план-мода: драйвер отвечает Enter на панели
вопросов (AskUserQuestionPanel) и ревью плана (PlanReviewPanel), стоп —
по появлению stop_on_call в session-логе; workdir=true меряет манифест
каталога (детект мутаций до exit_plan_mode).

Выход: последняя строка stdout = RESULT:<json> с session path и числом ходов.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import time
from typing import Optional

#: TUI-строки-маркеры готовности ввода (появление рамки ввода после boot)
READY_MARKERS = ("❯", "Context loaded")
#: маркеры панели вопросов (AskUserQuestionPanel, question-hint-enter; i18n en+zh).
#: «Enter submit» живёт и в hint план-ревью — но панели взаимоисключающи, а
#: детекция ask всегда гейтится открытым вызовом ask_user_question.
ASK_MARKERS = (
    "Enter submit",       # question-hint-enter (AskUserQuestionPanel)
    "Enter 提交",          # zh-вариант
)
#: маркеры план-ревью (PlanReviewPanel, plan-review-hint; i18n en+zh) —
#: «quick-pick»/«快选» встречаются ТОЛЬКО в этом hint (review MINOR: общий
#: «Esc dismiss» ловит btw/recap-панели и дал бы преждевременный Enter).
REVIEW_MARKERS = (
    "quick-pick",         # plan-review-hint (PlanReviewPanel, approve)
    "快选",                 # zh-вариант
)
#: объединение для generic-детекции «какая-то диалоговая панель видна»
DIALOG_MARKERS = ASK_MARKERS + REVIEW_MARKERS
#: общий таймаут на весь прогон (сек) — страховка от зависшего TUI
HARD_TIMEOUT_SEC = 5400
#: таймаут одного хода (сек): LLM + тулы
TURN_TIMEOUT_SEC = 900
#: интервал поллинга session-лога (сек)
POLL_INTERVAL = 2.0


class VirtualScreen:
    """Мини-эмулятор терминала (stdlib) для детекции панелей в PTY-потоке.

    TG-DSH-FIXUP-20260914 node 1: ink-рендер dsh-tui пишет кадры ПОЯЧЕЙНЫМ
    диффом (log-update.js): пустая ячейка (пробел без стиля) не пишется,
    курсор перепрыгивает её CUF (`\\x1b[N C`). Слова hint-строки панели
    разделяются escape-кодами: «Enter\\x1b[1Csubmit» — contiguous-поиск
    маркера в сырых байтах PTY не срабатывает, хотя панель смонтирована и
    отрисована (репро 20260914T083643Z: pyte-экран показывает панель, в
    raw bytes маркера нет). Поиск по виртуальному экрану решает это.

    Покрывает подмножество ECMA-48, которое реально пишет dsh-tui
    (каталогизировано по дампу репро): CUU/CUD/CUF/CUB, CUP, ED/EL, SGR
    (игнор), DECSET/DECRST (игнор, вкл. ?2026 synchronized output), CR/LF
    (+скролл), fullwidth-символы (эмодзи/CJK занимают 2 ячейки).
    Недекодируемые байты (utf-8 чанк-разрыв в ring-буфере) отбрасываются —
    буфер драйвера обрезается по байтам, посреди глифа.
    """

    COLS = 100
    ROWS = 40

    __slots__ = ("_cells", "_x", "_y", "_pending", "_wide_cache")

    def __init__(self, cols: int = COLS, rows: int = ROWS) -> None:
        self._cells = [[" "] * cols for _ in range(rows)]
        self._x = 0
        self._y = 0
        self._pending = b""  # недообработанный хвост (utf-8 чанк-разрыв / обрыв ESC)
        self._wide_cache = self._build_wide_table()

    @staticmethod
    def _build_wide_table() -> set[int]:
        """Кодпоинты ширины 2 (восточноазиатские W+F) — упрощённые диапазоны.

        Достаточно для эмодзи и CJK в панелях dsh-tui; ошибки ширины у
        редких кодпоинтов не ломают детекцию маркеров (сдвиг ≤1 колонка).
        """
        wide = set()
        ranges = (
            (0x1100, 0x115F), (0x2329, 0x232A), (0x2E80, 0x303E),
            (0x3041, 0x33FF), (0x3400, 0x4DBF), (0x4E00, 0x9FFF),
            (0xA000, 0xA4CF), (0xA960, 0xA97F), (0xAC00, 0xD7A3),
            (0xF900, 0xFAFF), (0xFE10, 0xFE19), (0xFE30, 0xFE6F),
            (0xFF00, 0xFF60), (0xFFE0, 0xFFE6),
            (0x1F004, 0x1F004), (0x1F0CF, 0x1F0CF), (0x1F18E, 0x1F18E),
            (0x1F191, 0x1F19A), (0x1F200, 0x1F320), (0x1F32D, 0x1F335),
            (0x1F337, 0x1F37C), (0x1F37E, 0x1F393), (0x1F3A0, 0x1F3CA),
            (0x1F3CF, 0x1F3D3), (0x1F3E0, 0x1F3F0), (0x1F3F4, 0x1F3F4),
            (0x1F3F8, 0x1F43E), (0x1F440, 0x1F440), (0x1F442, 0x1F4FC),
            (0x1F4FF, 0x1F53D), (0x1F54B, 0x1F54E), (0x1F550, 0x1F567),
            (0x1F57A, 0x1F57A), (0x1F595, 0x1F596), (0x1F5A4, 0x1F5A4),
            (0x1F5FB, 0x1F64F), (0x1F680, 0x1F6C5), (0x1F6CC, 0x1F6CC),
            (0x1F6D0, 0x1F6D2), (0x1F6EB, 0x1F6EC), (0x1F6F4, 0x1F6FC),
            (0x1F7E0, 0x1F7EB), (0x1F90C, 0x1F93A), (0x1F93C, 0x1F945),
            (0x1F947, 0x1F978), (0x1F97A, 0x1F9CB), (0x1F9CD, 0x1F9FF),
            (0x1FA70, 0x1FA74), (0x1FA78, 0x1FA7A), (0x1FA80, 0x1FA86),
            (0x1FA90, 0x1FAA8), (0x1FAB0, 0x1FAB6), (0x1FAC0, 0x1FAC2),
            (0x1FAD0, 0x1FAD6), (0x20000, 0x2FFFD), (0x30000, 0x3FFFD),
        )
        for lo, hi in ranges:
            wide.update(range(lo, hi + 1))
        return wide

    # --- публичное API ------------------------------------------------------

    def feed(self, chunk: bytes) -> None:
        """Скармливать очередную порцию PTY-байтов (инкрементально)."""
        data = self._pending + chunk
        self._pending = b""
        text, consumed = self._decode(data)
        consumed_chars = self._run(text)
        # хвост: недообработанные символы (обрыв ESC) + недекодированные байты
        self._pending = (text[consumed_chars:].encode("utf-8")
                         if consumed_chars < len(text) else b"") + data[consumed:]

    def text(self) -> str:
        """Текущий экран: строки, склеенные \\n (хвостовые пробелы срезаны)."""
        return "\n".join("".join(row).rstrip() for row in self._cells)

    # --- внутреннее ----------------------------------------------------------

    @staticmethod
    def _decode(data: bytes) -> tuple[str, int]:
        """Декодировать максимально длинный utf-8 префикс; вернуть (text, consumed)."""
        for cut in range(len(data), max(-1, len(data) - 4), -1):
            if cut < 0:
                return "", 0
            try:
                return data[:cut].decode("utf-8"), cut
            except UnicodeDecodeError:
                continue
        return "", 0

    def _run(self, text: str) -> int:
        """Исполнить декодированный текст; вернуть кол-во потреблённых символов.

        Обрыв ESC-последовательности концом chunk'а: остаток (с i) НЕ
        печатается и остаётся в _pending через возвращённый consumed_chars.
        """
        i, n = 0, len(text)
        while i < n:
            ch = text[i]
            if ch == "\x1b":
                consumed = self._escape(text, i)
                if consumed is None:
                    return i
                i = consumed
                continue
            if ch == "\r":
                self._x = 0
            elif ch == "\n":
                self._x = 0
                self._y += 1
                if self._y >= self.ROWS:
                    self._scroll()
                    self._y = self.ROWS - 1
            elif ch == "\b":
                self._x = max(0, self._x - 1)
            elif ch == "\t":
                self._x = min(self._cols_n - 1, (self._x // 8 + 1) * 8)
            else:
                self._put(ch)
            i += 1
        return n

    @property
    def _cols_n(self) -> int:
        return len(self._cells[0])

    def _put(self, ch: str) -> None:
        row = self._cells[self._y]
        row[self._x] = ch
        adv = 2 if ord(ch) in self._wide_cache else 1
        # wide-глиф: следующая ячейка — пустой спейсер (невидима)
        if adv == 2 and self._x + 1 < len(row):
            row[self._x + 1] = ""
        self._x += adv
        if self._x >= len(row):
            self._x = len(row) - 1  # автоперенос не моделируем — clip

    def _scroll(self) -> None:
        self._cells.pop(0)
        self._cells.append([" "] * len(self._cells[0]))

    def _escape(self, text: str, i: int) -> Optional[int]:
        """Обработать ESC-последовательность с индекса i.

        Возвращает индекс после последовательности, или None если она
        обрезана концом chunk'а (ждём продолжения в следующем feed).
        """
        n = len(text)
        if i + 1 >= n:
            return None  # голый ESC в конце chunk'а
        nxt = text[i + 1]
        if nxt == "]":
            # OSC (гиперссылки \x1b]8;;URL\x1b\\ / до BEL): контент не рисуется
            for j in range(i + 2, n):
                if text[j] == "\x07":
                    return j + 1
                if text[j] == "\x1b" and j + 1 < n and text[j + 1] == "\\":
                    return j + 2
            return None  # OSC обрезан концом chunk'а
        if nxt == "[":
            j = i + 2
            while j < n and text[j] in "0123456789;?<>=!":
                j += 1
            if j >= n:
                return None  # параметр не дочитан
            params_s = text[i + 2:j]
            cmd = text[j]
            if cmd == "C":
                self._x = min(len(self._cells[0]) - 1,
                              self._x + self._num(params_s, 1))
            elif cmd == "D":
                self._x = max(0, self._x - self._num(params_s, 1))
            elif cmd == "A":
                self._y = max(0, self._y - self._num(params_s, 1))
            elif cmd == "B":
                self._y = min(self.ROWS - 1, self._y + self._num(params_s, 1))
            elif cmd == "H" or cmd == "f":
                parts = params_s.split(";")
                row = self._num(parts[0], 1) if parts[0] else 1
                col = self._num(parts[1], 1) if len(parts) > 1 and parts[1] else 1
                self._y = max(0, min(self.ROWS - 1, row - 1))
                self._x = max(0, min(len(self._cells[0]) - 1, col - 1))
            elif cmd == "J":
                mode = self._mode(params_s, 0)
                if mode == 2 or mode == 3:
                    self._cells = [[" "] * len(self._cells[0])
                                   for _ in range(self.ROWS)]
                elif mode == 0:
                    row = self._cells[self._y]
                    for x in range(self._x, len(row)):
                        row[x] = " "
                    for y in range(self._y + 1, self.ROWS):
                        self._cells[y] = [" "] * len(row)
            elif cmd == "K":
                mode = self._mode(params_s, 0)
                row = self._cells[self._y]
                if mode == 0:
                    for x in range(self._x, len(row)):
                        row[x] = " "
                elif mode == 2:
                    self._cells[self._y] = [" "] * len(row)
            # m (SGR), h/l (DECSET/DECRST вкл. ?2026), прочее — игнор
            return j + 1
        # одиночные ESC (7/8/D/M...) — не встречаются в потоке dsh-tui; игнор
        return i + 2 if nxt not in "()#" else i + 3

    @staticmethod
    def _num(params: str, default: int) -> int:
        """Параметр cursor-команды: пусто/0/? → default (ECMA-48 CUU..CUB)."""
        if params.startswith("?") or params == "":
            return default
        try:
            v = int(params)
        except ValueError:
            return default
        return v if v > 0 else default

    @staticmethod
    def _mode(params: str, default: int) -> int:
        """Параметр ED/EL: 0 — валидный режим, пусто → default."""
        if params.startswith("?"):
            return default
        try:
            return int(params)
        except ValueError:
            return default


def dialog_markers_visible(chunk: bytes, screen: Optional[VirtualScreen] = None) -> bool:
    """Виден ли маркер диалоговой панели в PTY-байтах.

    Сначала дешёвый contiguous-поиск по raw (кадры без cell-skip), затем —
    рендер через VirtualScreen (cell-skip диффы ink). Инкрементальному
    использованию передавайте готовый `screen`: новые байты кормятся в него,
    полный рендер выполняется один раз.
    """
    if any(m.encode("utf-8") in chunk for m in DIALOG_MARKERS):
        return True
    if screen is not None:
        screen.feed(chunk)
        return any(m in screen.text() for m in DIALOG_MARKERS)
    vs = VirtualScreen()
    vs.feed(chunk)
    return any(m in vs.text() for m in DIALOG_MARKERS)


def log(msg: str) -> None:
    """Прогресс-строка драйвера (не JSON, для человека/отчёта)."""
    print(f"[drive] {msg}", flush=True)


def read_records(path: str) -> list[dict]:
    """Сессия -> записи (plain JSONL; zstd-декомпрессию делает analyze при анализе).

    Здесь нужна только.tail-семантика: берём plain-декомпрессию через
    тот же fallback, что в analyze.py (импорт по соседству).
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import analyze

    return analyze.read_session_records(path)


def find_session_file(dsh_home: str, cwd: str, newer_than: float) -> Optional[str]:
    """Найти session.jsonl.zstd свежей сессии в $DSH_HOME/sessions/--<cwd>--/*/.

    Args:
        dsh_home: golden-копия ~/.dsh.
        cwd: рабочая директория сессии (dsh санитизирует её в имя каталога).
        newer_than: unix-time — игнорировать сессии, созданные раньше.
    """
    sanitized = "--" + cwd.strip("/").replace("/", "-") + "--"
    pattern = os.path.join(dsh_home, "sessions", sanitized, "*", "session.jsonl.zstd")
    best = None
    for f in glob.glob(pattern):
        st = os.stat(f)
        if st.st_mtime < newer_than - 5:
            continue
        if best is None or os.path.getmtime(f) > os.path.getmtime(best):
            best = f
    return best


class TuiDriver:
    """PTY-обёртка над dsh TUI: чтение вывода в ring-буфер + отправка строк."""

    def __init__(self, cmd: list[str], env: dict, cwd: str):
        self.master, self.slave = pty.openpty()
        # term 100x40 — рабочий размер TUI (карточки не обрезаются)
        import fcntl
        import struct
        import termios
        # Виртуальный экран для детекции панелей: ink пишет кадры поячеечным
        # диффом (пустые ячейки = CUF-прыжок), contiguous-поиск по raw-байтам
        # слеп к «Enter\x1b[1Csubmit» (TG-DSH-FIXUP-20260914 node 1).
        # Кормится КАЖДЫМ прочитанным байтом до ring-обрезки — экран всегда
        # видит полный поток, независимо от кольца буфера.
        self._screen = VirtualScreen()

        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
        self.proc = subprocess.Popen(
            cmd,
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            env=env,
            cwd=cwd,
            preexec_fn=os.setsid,
            close_fds=True,
        )
        os.close(self.slave)
        self.buffer = b""
        self.dead = False

    def pump(self, duration: float) -> None:
        """Читает PTY-вывод duration секунд в буфер (ring, последний 1MB)."""
        deadline = time.time() + duration
        while time.time() < deadline and not self.dead:
            try:
                r, _, _ = select.select([self.master], [], [], 0.3)
            except OSError:
                self.dead = True
                break
            if r:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    self.dead = True
                    break
                if not chunk:
                    self.dead = True
                    break
                self._screen.feed(chunk)
                self.buffer = (self.buffer + chunk)[-1_000_000:]

    def output_text(self) -> str:
        """Текстовый хвост буфера (utf-8, errors=replace)."""
        return self.buffer.decode("utf-8", errors="replace")

    def dialog_visible(self, markers: tuple = ASK_MARKERS) -> bool:
        """Виден ли маркер диалоговой панели (по умолчанию — ask-панель).

        Двухступенчато: дешёвый raw-поиск по ring-буферу (кадры без
        cell-skip), затем — по виртуальному экрану (его кормит pump, здесь
        повторного фида нет: screen уже видел каждый прочитанный байт).
        """
        if any(m.encode("utf-8") in self.buffer for m in markers):
            return True
        text = self._screen.text()
        return any(m in text for m in markers)

    def send_line(self, text: str) -> None:
        """Отправить строку в TUI + Enter."""
        os.write(self.master, text.encode("utf-8"))
        time.sleep(0.3)
        os.write(self.master, b"\r")

    def kill(self) -> None:
        """Убить TUI-процесс (группа)."""
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except Exception:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except Exception:
                pass


def count_events(records: list[dict]) -> dict:
    """Счётчики хода/компакции из записей (tail-семантика)."""
    turns_done = 0
    compaction_done = 0
    for r in records:
        t = r.get("type")
        # любой turn/end = ход завершён (completed/aborted/error): после error
        # (например 502 upstream) агент не продолжит ход сам, ждать бессмысленно
        if t == "turn/end":
            turns_done += 1
        elif t == "compaction/end":
            compaction_done += 1
    return {"turns_done": turns_done, "compaction_done": compaction_done}


def _call_names(records: list[dict]) -> list[str]:
    """Имена вызовов тулов из записей: tool/call + tool/code-dispatch-start."""
    names = []
    for r in records:
        t = r.get("type")
        if t in ("tool/call", "tool/code-dispatch-start"):
            name = (r.get("data") or {}).get("name")
            if name:
                names.append(name)
    return names


def workdir_manifest(work_dir: str) -> dict[str, str]:
    """Манифест work dir: {relpath: md5} всех файлов (детект мутаций).

    Plan-mode сценарий не должен менять файлы до exit_plan_mode; манифест
    до/после — внешний наблюдаемый факт, независимый от session-лога.
    """
    manifest: dict[str, str] = {}
    for root, _dirs, files in os.walk(work_dir):
        for fn in files:
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, work_dir)
            try:
                with open(path, "rb") as fh:
                    manifest[rel] = hashlib.md5(fh.read()).hexdigest()
            except OSError:
                manifest[rel] = "<unreadable>"
    return manifest


#: сколько безуспешных Enter подряд на ОДНОМ открытом ask-вызове допустимо,
#: прежде чем сменить тактику: вопросы со свободным ответом («укажите путь
#: в поле произвольного ответа») чистый Enter НЕ закрывают — нет опций для
#: Recommended-сабмита (репро 20260914T100406Z: 77 Enter в пустоту, ход f
#: умер на таймауте). Эскалация: Enter → текстовый ответ (cwd) → Esc (cancel).
ENTER_ATTEMPTS_BEFORE_ESC = 10


def ask_next_action(open_call_id: object, enter_attempts: int) -> str:
    """Следующее действие драйвера по открытому ask-вызову.

    Эскалация тактики на ОДНОМ вызове (смена subCallId обнуляет счётчик):
      * "enter" (< N) — чистый Enter: submit Recommended-опции;
      * "type" (N..2N-1) — текстовый ответ (cwd драйвера) в поле
        произвольного ответа: панель принимает текст («Type text to attach
        an answer»), закрывает вопросы без опций; для «какой проект?»
        cwd — валидный ответ;
      * "cancel" (>= 2N) — Esc: ASK_CANCELLED, модель продолжит; для
        вердикта важен ФАКТ ask ДО exit_plan_mode, не ответ.

    Args:
        open_call_id: идентификатор текущего открытого вызова; None — нет.
        enter_attempts: сколько попыток уже сделано по этому вызову.

    Returns:
        "enter" | "type" | "cancel".
    """
    if open_call_id is None:
        return "enter"  # вызова нет — решение не применяется
    if enter_attempts >= 2 * ENTER_ATTEMPTS_BEFORE_ESC:
        return "cancel"
    if enter_attempts >= ENTER_ATTEMPTS_BEFORE_ESC:
        return "type"
    return "enter"


def respond_until_call(
    tui: "TuiDriver",
    session_file: str,
    stop_on_call: str,
    timeout: float,
    work_dir: str = "",
    send: str = "",
) -> dict:
    """Интерактивный ход с панелями вопросов (план-мод grill / plan-review).

    Цикл: откачиваем PTY, при видимом диалоге (DIALOG_MARKERS) шлём чистый
    Enter (Recommended-опция в AskUserQuestionPanel / Approve в
    PlanReviewPanel — обе панели сабмитят первый option). Выход — как только
    в session-логе появился вызов stop_on_call (обычно exit_plan_mode):
    фиксируем манифест work dir НА ЭТОТ МОМЕНТ (мутации после одобрения
    плана не считаются нарушением план-режима) и шлём финальный Enter
    (approve), чтобы сессия закрыла ход аккуратно.

    send (опционально): промпт этого хода. КРИТИЧНО отправлять его ЗДЕСЬ,
    а не отдельным {"send": ...}-айтемом: ход с вопросами не завершается
    (turn/end не наступит, пока вопросы не отвечены), обычный send-айтем
    завис бы на TURN_TIMEOUT в ожидании конца хода (дедлок — найден на
    первом прогоне 2026-09-13).

    Returns:
        {"ok": bool, "workdir_unchanged_until_exit": bool|None,
         "stop_call_seen": bool}
    """
    baseline = workdir_manifest(work_dir) if work_dir else {}
    if send:
        tui.send_line(send)
    saw_stop_call = False
    unchanged: Optional[bool] = None
    last_enter_at = 0.0
    last_debug_at = 0.0
    ask_open_since = 0.0
    # тактика «зависший ask»: Enter по одному и тому же открытому вызову
    cur_call_id: Optional[str] = None
    enter_attempts = 0
    deadline = time.time() + timeout
    while time.time() < deadline and not tui.dead:
        tui.pump(1.0)
        records = read_records(session_file)
        # открытый ask-вызов: dispatch-start БЕЗ dispatch-результата с тем же
        # subCallId — панель вопросов сейчас смонтирована (батч «Question k/N»
        # = ОДИН вызов, несколько Enter)
        open_id = _open_call_id(records, "ask_user_question")
        if open_id is not None and open_id != cur_call_id:
            cur_call_id = open_id
            enter_attempts = 0
        if open_id is not None and time.time() - last_enter_at > 1.5:
            marker_seen = tui.dialog_visible()
            if marker_seen:
                # Эскалация тактики «зависший ask»: вопрос со свободным
                # ответом чистый Enter НЕ закрывает (нет Recommended-опции).
                # Enter → текстовый ответ (cwd) → Esc (cancel) — см.
                # ask_next_action (репро 20260914T100406Z: 77 Enter в пустоту).
                action = ask_next_action(cur_call_id, enter_attempts)
                if action == "cancel":
                    os.write(tui.master, b"\x1b")
                    last_enter_at = time.time()
                    enter_attempts += 1
                    log("respond: ask не закрывается ("
                        f"{enter_attempts - 1} попыток) — Esc (cancel)")
                    continue
                if action == "type":
                    answer = work_dir or os.getcwd()
                    tui.send_line(answer)
                    last_enter_at = time.time()
                    enter_attempts += 1
                    ask_open_since = 0.0
                    log(f"respond: ask не закрывает Enter — текстовый ответ ({answer})")
                    continue
                # multi-select вопрос: Enter при 0 отмеченных НЕ сабмитит
                # (setError 'question-select-or-answer'). Space отмечает
                # подсвеченную (Recommended) опцию; в single-select Space
                # прикрепляет её к ответу — оба случая валидны. Поэтому если
                # в открытом батче есть multi_select — шлём Space перед Enter.
                if _open_call_has_multi(records):
                    os.write(tui.master, b" ")
                    time.sleep(0.2)
                tui.send_line("")  # чистый Enter: submit Recommended-опции
                enter_attempts += 1
                last_enter_at = time.time()
                ask_open_since = 0.0  # панель видна — сбрасываем «слепой» таймер
                log("respond: ask открыт, маркер видим — Enter отправлен")
            elif ask_open_since == 0.0:
                ask_open_since = time.time()  # панель ещё не отрисована?
            elif time.time() - ask_open_since > 120:
                # «Гонка user-questions провайдера» из backlog-20260914
                # (ловушки 5-6) ОПРОВЕРГНУТА: панель монтируется и рисуется
                # всегда, слеп был contiguous-поиск маркера в raw-байтах
                # (ink cell-skip дифф, TG-DSH-FIXUP-20260914 node 1).
                # Esc-fallback оставлен как страховка от НЕИЗВЕСТНЫХ
                # регрессий: панель реально не видна 120с — шлём cancel,
                # модель получит ASK_CANCELLED и продолжит. Для вердикта
                # важен ФАКТ ask_user_question ДО exit_plan_mode.
                os.write(tui.master, b"\x1b")
                last_enter_at = time.time()
                ask_open_since = time.time()
                log("respond: ask открыт 120с без панели — Esc (cancel) отправлен")
            elif time.time() - last_debug_at > 30:
                last_debug_at = time.time()
                log("respond: ask открыт, панель не видна, ждём (120с до Esc)")
        else:
            ask_open_since = 0.0
            if time.time() - last_debug_at > 30:
                last_debug_at = time.time()
                log("respond: ask не открыт, ждём (спиннер/модель работает)")
        if not saw_stop_call and stop_on_call in _call_names(records):
            saw_stop_call = True
            # манифест на момент exit_plan_mode — ДО approve
            unchanged = workdir_manifest(work_dir) == baseline if work_dir else None
            log(f"respond: {stop_on_call} в логе; workdir_unchanged={unchanged}")
            # ждём монтирования PlanReview и подтверждаем план (approve);
            # маркер — специфичный для план-ревью («quick-pick»): общий
            # «Esc dismiss» ловит btw/recap-панели, а «Enter submit» ещё и
            # живёт в ring-буфере от ask-фазы (буфер не чистим)
            if wait_for_marker(tui, REVIEW_MARKERS, 120):
                tui.send_line("")
                tui.pump(3.0)
            return {
                "ok": True,
                "workdir_unchanged_until_exit": unchanged,
                "stop_call_seen": True,
            }
    return {
        "ok": False,
        "workdir_unchanged_until_exit": unchanged,
        "stop_call_seen": saw_stop_call,
        "error": f"{stop_on_call} not seen in {timeout}s",
    }


def _open_call_id(records: list[dict], name: str) -> Optional[str]:
    """subCallId ОТКРЫТОГО вызова тула name (dispatch-start без результата)
    или None. Панель вопросов смонтирована ⟺ вызов ask_user_question
    отправлен, но ответ (tool/code-dispatch с тем же subCallId) ещё не записан.

    Несколько открытых (фон) — последний по insertion-порядку.
    """
    open_ids: list[str] = []  # insertion-порядок: «последний открытый» =
    done_ids: set[str] = set()  # последний по ВРЕМЕНИ, не лексикографически
    for r in records:
        t = r.get("type")
        data = r.get("data") or {}
        if t == "tool/code-dispatch-start" and data.get("name") == name:
            sid = data.get("subCallId")
            if sid and sid not in open_ids:
                open_ids.append(sid)
        elif t == "tool/code-dispatch" and data.get("name") == name:
            sid = data.get("subCallId")
            # dispatch-результат может неносить subCallId (dsh-tools:1276+);
            # если его нет — считаем закрытым последний открытый вызов
            if sid:
                done_ids.add(sid)
            elif open_ids:
                done_ids.add(open_ids[-1])
    for sid in reversed(open_ids):
        if sid not in done_ids:
            return sid
    return None


def _open_call(records: list[dict], name: str) -> bool:
    """Есть ли ОТКРЫТЫЙ вызов тула name: dispatch-start без результата.

    Пока вызов открыт — каждый Enter отвечает на очередной вопрос батча
    («Question k/N»), закрывая панель по последнему.
    """
    return _open_call_id(records, name) is not None


def _open_call_has_multi(records: list[dict]) -> bool:
    """Содержит ли ОТКРЫТЫЙ ask-батч multi_select-вопрос.

    multi_select + 0 отмеченных: Enter не сабмитит (панель требует Space).
    Space в single-select безвреден (прикрепляет Recommended-опцию).
    """
    open_ids: list[str] = []  # insertion-порядок (см. _open_call)
    done_ids: set[str] = set()
    multi_ids: set[str] = set()
    for r in records:
        t = r.get("type")
        data = r.get("data") or {}
        if t == "tool/code-dispatch-start" and data.get("name") == "ask_user_question":
            sid = data.get("subCallId")
            if sid and sid not in open_ids:
                open_ids.append(sid)
                args = data.get("arguments") or {}
                questions = args.get("questions") if isinstance(args, dict) else None
                if isinstance(questions, list) and any(
                    isinstance(q, dict) and q.get("multi_select") for q in questions
                ):
                    multi_ids.add(sid)
        elif t == "tool/code-dispatch" and data.get("name") == "ask_user_question":
            sid = data.get("subCallId")
            if sid:
                done_ids.add(sid)
            elif open_ids:
                done_ids.add(open_ids[-1])
    return any(sid not in done_ids and sid in multi_ids for sid in open_ids)


def wait_for_marker(tui: "TuiDriver", markers: tuple, timeout: float) -> bool:
    """Ждать появления любого из markers в PTY-выводе (панель смонтирована).

    ВАЖНО: буфер НЕ чистим — пока панель ждёт ввода, экран статичен (нет
    спиннера → нет новых байтов), маркер живёт в ring-буфере с момента
    первого рендера панели. Чистка буфера = вечное ожидание (ловушка
    первого прогона 2026-09-13).

    Поиск двухступенчатый (TG-DSH-FIXUP-20260914 node 1): raw-подстрока в
    ring-буфере ИЛИ вхождение на виртуальном экране — ink-дифф пишет пустые
    ячейки CUF-прыжком («Enter\\x1b[1Csubmit»), contiguous-поиск слеп.
    """
    deadline = time.time() + timeout
    while time.time() < deadline and not tui.dead:
        tui.pump(1.0)
        txt = tui.output_text()
        if any(m in txt for m in markers):
            return True
        screen_text = tui._screen.text()
        if any(m in screen_text for m in markers):
            return True
    return False


def wait_for(condition, timeout: float, what: str, tui: "TuiDriver" = None) -> bool:
    """Поллить condition() пока не True или таймаут; логирует исход.

    Args:
        tui: если задан — на каждом тике откачиваем PTY-вывод (pump):
            TUI рисует спиннер постоянно, kernel-буфер PTY (~64KB) заполняется
            за секунды, после чего write() dsh-процесса БЛОКИРУЕТСЯ и весь
            agent-loop замирает (ловушка найдена на vmdev 2026-09-12).
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if tui is not None:
            tui.pump(1.0)
        if condition():
            log(f"{what}: ok")
            return True
        time.sleep(POLL_INTERVAL)
    log(f"{what}: TIMEOUT after {timeout}s")
    return False


def run_scenario(args: argparse.Namespace) -> int:
    """Основной цикл: boot TUI -> исполнить план -> вернуть session path."""
    started = time.time()
    with open(args.plan) as fh:
        plan = json.load(fh)

    env = dict(os.environ)
    env["DSH_HOME"] = args.dsh_home
    env["TERM"] = "xterm-256color"
    # run_code и файловые тулы без approval-промптов (TUI неинтерактивно водится)
    env["DSH_PERMISSION_MODE"] = "danger-full-access"
    # relay — в LAN; локальные прокси цели (HTTP_PROXY=10.0.2.2:...) ломают
    # путь к нему, гасим оба варианта
    env["NO_PROXY"] = "127.0.0.1,localhost,127.0.0.1"
    env["no_proxy"] = env["NO_PROXY"]
    for kv in args.env or []:
        k, _, v = kv.partition("=")
        env[k] = v

    os.makedirs(args.work_dir, exist_ok=True)
    # реальный бинарь dsh (минуя ~/.local/bin/dsh обёртку с её прокси-env):
    # --dsh-bin > /home/user/.npm-global/bin/dsh > PATH
    dsh_bin = args.dsh_bin or ""
    if not dsh_bin:
        for cand in ("/home/user/.npm-global/bin/dsh", shutil.which("dsh") or ""):
            if cand and os.path.isfile(cand):
                dsh_bin = cand
                break
    if not dsh_bin:
        raise RuntimeError("dsh binary not found (pass --dsh-bin)")
    cmd = [dsh_bin, "--profile", "dsh-tui"]
    log(f"boot: {' '.join(cmd)} (DSH_HOME={args.dsh_home})")
    tui = TuiDriver(cmd, env, args.work_dir)

    session_file: Optional[str] = None
    respond_result: Optional[dict] = None
    rc = 1
    try:
        # 1. готовность TUI: маркер ввода в PTY-выводе ИЛИ session-файл
        def tui_ready() -> bool:
            tui.pump(1.0)
            txt = tui.output_text()
            return any(m in txt for m in READY_MARKERS)

        if not wait_for(tui_ready, 180, "tui boot", tui):
            raise RuntimeError("TUI not ready: no input marker in PTY output")
        # frame settle: TUI дорисовывает
        tui.pump(5.0)

        session_file = find_session_file(args.dsh_home, os.path.abspath(args.work_dir), started)
        if session_file is None:
            raise RuntimeError("session.jsonl.zstd not found after boot")
        log(f"session file: {session_file}")

        prev = count_events(read_records(session_file))
        for i, item in enumerate(plan, 1):
            if "send" in item:
                prompt = item["send"]
                log(f"turn {i}: send ({len(prompt)} chars)")
                tui.send_line(prompt)
                ok = wait_for(
                    lambda: count_events(read_records(session_file))["turns_done"] > prev["turns_done"],
                    TURN_TIMEOUT_SEC,
                    f"turn {i} completion",
                    tui,
                )
                if not ok:
                    raise RuntimeError(f"turn {i} did not complete in {TURN_TIMEOUT_SEC}s")
                prev = count_events(read_records(session_file))
            elif "slash" in item:
                cmd_name = item["slash"]
                log(f"step {i}: slash {cmd_name}")
                tui.send_line(cmd_name)
                if cmd_name == "/compact":
                    ok = wait_for(
                        lambda: count_events(read_records(session_file))["compaction_done"] > prev["compaction_done"],
                        TURN_TIMEOUT_SEC,
                        f"compaction {i}",
                        tui,
                    )
                    if not ok:
                        raise RuntimeError(f"compaction did not complete in {TURN_TIMEOUT_SEC}s")
                    prev = count_events(read_records(session_file))
            elif item.get("sleep"):
                time.sleep(item["sleep"])
            elif "respond" in item:
                # интерактивный ход план-мода: промпт (если задан) уходит
                # ЗДЕСЬ, не отдельным send-айтемом — ход с вопросами не
                # завершается до ответов (иначе дедлок на turn/end)
                cfg = item["respond"] or {}
                stop_call = cfg.get("stop_on_call", "exit_plan_mode")
                check_wd = cfg.get("workdir", False)
                prompt = cfg.get("send", "")
                log(f"turn {i}: respond until {stop_call} ({len(prompt)} chars)")
                respond_result = respond_until_call(
                    tui,
                    session_file,
                    stop_on_call=stop_call,
                    # 2× TURN_TIMEOUT: grill-раунды длинные (research +
                    # несколько батчей вопросов + подготовка плана)
                    timeout=TURN_TIMEOUT_SEC * 2,
                    work_dir=os.path.abspath(args.work_dir) if check_wd else "",
                    send=prompt,
                )
                if not respond_result["ok"]:
                    raise RuntimeError(respond_result.get("error", "respond failed"))
                prev = count_events(read_records(session_file))
            else:
                raise ValueError(f"unknown plan item: {item}")

        final = read_records(session_file)
        counts = count_events(final)
        log(f"done: turns={counts['turns_done']} compactions={counts['compaction_done']}")
        result = {
            "session": session_file,
            "turns_done": counts["turns_done"],
            "compactions": counts["compaction_done"],
            "ok": True,
        }
        if respond_result is not None:
            result["workdir_unchanged_until_exit"] = respond_result.get(
                "workdir_unchanged_until_exit"
            )
        rc = 0
    except Exception as e:  # noqa: BLE001
        log(f"ERROR: {e}")
        result = {"session": session_file, "ok": False, "error": str(e)}
        rc = 1
    finally:
        tui.kill()

    print("RESULT:" + json.dumps(result, ensure_ascii=False), flush=True)
    return rc


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dsh-home", required=True, help="DSH_HOME golden-копии стека")
    ap.add_argument("--work-dir", required=True, help="cwd сессии")
    ap.add_argument("--scenario", required=True, help="имя сценария (для логов)")
    ap.add_argument("--plan", required=True, help="JSON-план сценария")
    ap.add_argument("--env", action="append", help="доп. env KEY=VALUE (repeatable)")
    ap.add_argument("--dsh-bin", help="явный путь к бинарю dsh (минуя обёртку с прокси-env)")
    args = ap.parse_args(argv)

    def _hard_timeout(_sig, _frm):
        print("RESULT:" + json.dumps({"ok": False, "error": "hard timeout"}), flush=True)
        sys.exit(1)

    signal.signal(signal.SIGALRM, _hard_timeout)
    signal.alarm(HARD_TIMEOUT_SEC)
    return run_scenario(args)


if __name__ == "__main__":
    sys.exit(main())
