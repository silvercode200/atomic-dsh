#!/usr/bin/env python3
"""model-fork-repro.py — репро замерзания TUI-рендера после /model-форка сессии.

Баг (TG-DSH-IMG-MODELFORK-20260913 node 2): `/model <provider>/<другая-модель>`
форкает сессию (by design), после чего ответы модели пишутся в session-лог
ФОРК-сессии, но не появляются на экране TUI.

Запускается НА VMDEV против живого ~/.dsh (профиль dsh-tui). PTY-драйвер по
паттерну tests/golden/drive_session.py: спавнит dsh в PTY, водит сценарий
(ход 1 -> /model -> ход 2), проверяет ответ НА ЭКРАНЕ (кольцевой буфер PTY =
поток отрисовки) и в session-логах, пишет verdict JSON.

Сценарий (ответы развернуты — анти-degenerate: короткий output при большом
system = страйк MKS-детектора, см. golden/run.sh):
    1. ход 1: «Скажи "ок" + пара предложений о себе» -> ответ на экране (baseline).
    2. /model cli/gpt-5.6-luna            -> форк сессии (живой роут).
    3. ход 2: «Скажи слово РИМ + два предложения»     -> ответ на экране? (red: нет).

Экранная проверка: ANSI-стрип + счётчик вхождений строки; baseline-счётчик
снимается ПОСЛЕ отправки промпта (echo уже в буфере) — ответ = рост счётчика.
Так исключается ложное срабатывание на echo самого промпта.

Usage (vmdev):
    python3 model-fork-repro.py [--dsh-home ~/.dsh] [--out-dir DIR]
                                [--model cli/gpt-5.6-luna] [--timeout 420]

Выход: последняя строка stdout = VERDICT:<json>; артефакты в --out-dir.
Вердикт-поля: answer_on_screen + answer_match (word|fragment|position — как
найден на экране; 2026-09-13: bg-роут стал приклеивать thinking к ответу, а
inline-рендер full-стека пишет кадр одной PTY-строкой — чистый word-матч
давал ложный RED, добавлены fragment/position-фолбэки), turn1_on_screen,
answer_in_fork_log, stderr_errors (паттерны #185/Maximum update depth/
[dsh-tui] по всему raw-буферу), toast_model_switched_seen, pin_flips
(осцилляция pin/unpin эффекта патча 11), watchdog_fires (патч 22).
"""
from __future__ import annotations

import argparse
import fcntl
import glob
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import termios
import sys
import time
from typing import Optional

#: TUI-строки-маркеры готовности ввода (после boot)
READY_MARKERS = ("❯", "Context loaded")
#: общий таймаут всего прогона (сек)
HARD_TIMEOUT_SEC = 2400
#: таймаут одного хода: реальный роут может идти минуты
TURN_TIMEOUT_SEC = 420
#: интервал поллинга
POLL_INTERVAL = 2.0
#: ANSI-эскейпы (CSI/OSC и пр.) для стрипа экранного потока
ANSI_RE = re.compile(
    r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_].*?\x1b\\|\x1b.",
    re.DOTALL,
)
#: паттерны ошибок Node/stderr в PTY-потоке
STDERR_PATTERNS = (
    "UnhandledPromiseRejection",
    "unhandledRejection",
    "ERR_UNHANDLED_REJECTION",
    "listener threw",
    "listener rejected",
    "TypeError:",
    "ReferenceError:",
    "RangeError:",
    # dsh-tui render-freeze diagnostics (TG-DSH-IMG-MODELFORK-20260913 node 2):
    # React nested-update overflow (#185) — если этот класс ошибок виден в
    # PTY-потоке, механизм заморозки = осцилляция measure/commit, а не
    # потерянные wakeups стор-версии.
    "Minified React error #185",
    "Maximum update depth",
    "update-overflow",
    "[dsh-tui]",
)
#: тост «model-switched» (en/zh локали)
TOAST_RE = re.compile(r"Model switched to|模型已切换|Switching model to|正在切换模型", re.IGNORECASE)
#: диагностические логи TUI (env-гейты DSH_TUI_*_TRACE): затираем до прогона,
#: копируем в артефакты после — они истина о механизме заморозки.
DIAG_LOGS = (
    "/tmp/dsh-pin-trace.log",  # patch-11 pin/unpin решения (DSH_TUI_PIN_TRACE)
    "/tmp/dsh-ls-trace.log",  # channel listeners add/del/emit-ls=0 (DSH_TUI_LS_TRACE)
    "/tmp/mfk-watchdog.log",  # paint watchdog fire (DSH_TUI_WD_TRACE)
)


def log(msg: str) -> None:
    print(f"[repro] {msg}", flush=True)


# --- PTY-драйвер (по drive_session.py) ---------------------------------------


class TuiDriver:
    """PTY-обёртка над dsh TUI: ring-буфер вывода (1MB) + отправка строк."""

    def __init__(self, cmd: list[str], env: dict, cwd: str):
        self.master, self.slave = pty.openpty()
        # term 100x40 — рабочий размер TUI
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
                self.buffer = (self.buffer + chunk)[-1_000_000:]

    def output_text(self) -> str:
        return self.buffer.decode("utf-8", errors="replace")

    def screen_text(self) -> str:
        """Текстовый хвост буфера без ANSI-эскейпов (что «на экране»)."""
        return ANSI_RE.sub("", self.output_text())

    def send_line(self, text: str) -> None:
        os.write(self.master, text.encode("utf-8"))
        time.sleep(0.3)
        os.write(self.master, b"\r")

    def kill(self) -> None:
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


def wait_for(condition, timeout: float, what: str, tui: Optional["TuiDriver"] = None) -> bool:
    """Поллить condition() пока не True или таймаут (PTY откачиваем —
    kernel-буфер PTY блокирует write() dsh, ловушка vmdev 2026-09-12)."""
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


# --- session-логи --------------------------------------------------------------


def read_records(path: str) -> list[dict]:
    """session.jsonl.zstd -> записи (multi-frame zstd через zstandard)."""
    import zstandard

    with open(path, "rb") as fh:
        reader = zstandard.ZstdDecompressor().stream_reader(fh, read_across_frames=True)
        data = reader.read()
    out = []
    for ln in data.decode("utf-8", errors="replace").splitlines():
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


def find_session_files(dsh_home: str, cwd: str, newer_than: float) -> list[str]:
    """Все session.jsonl.zstd нашего cwd, свежее newer_than (старая + форк)."""
    sanitized = "--" + cwd.strip("/").replace("/", "-") + "--"
    pattern = os.path.join(dsh_home, "sessions", sanitized, "*", "session.jsonl.zstd")
    found = []
    for f in glob.glob(pattern):
        st = os.stat(f)
        if st.st_mtime < newer_than - 5:
            continue
        found.append(f)
    return sorted(found, key=os.path.getmtime)


def count_turns(records: list[dict]) -> int:
    return sum(1 for r in records if r.get("type") == "turn/end")


def assistant_texts(records: list[dict]) -> list[str]:
    """Полные тексты assistant-сообщений (data.message.content[].text)."""
    texts = []
    for rec in records:
        if rec.get("type") != "assistant/message":
            continue
        content = ((rec.get("data") or {}).get("message") or {}).get("content") or []
        text = "".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        ).strip()
        if text:
            texts.append(text)
    return texts


def user_texts(records: list[dict]) -> list[str]:
    texts = []
    for rec in records:
        if rec.get("type") != "user/message":
            continue
        content = (rec.get("data") or {}).get("content") or []
        text = "".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        ).strip()
        if text:
            texts.append(text)
    return texts


# --- экранная проверка -----------------------------------------------------------


def last_answer_in_logs(dsh_home: str, work_dir: str, started: float, session_idx: int = -1) -> Optional[str]:
    """Последний assistant-текст из session_idx-й (по mtime) сессии или None.

    Фактический ответ модели — ground truth для экранной проверки: модель
    может ответить не «Рим», а «Италия» и т.п.; поиск заранее заданного слова
    даёт ложный red (найдено 2026-09-13: thinking содержит искомое слово,
    а ответ — другое).
    """
    files = find_session_files(dsh_home, work_dir, started)
    if not files:
        return None
    f = files[session_idx]
    try:
        recs = read_records(f)
    except Exception:
        return None
    texts = assistant_texts(recs)
    return texts[-1] if texts else None


def screen_shows_text(screen: str, text: str) -> tuple[bool, str]:
    """Есть ли в хвосте экрана ответ (word-матч) ИЛИ его финальные слова.

    Возвращает (found, how):
      - ("word", ...): settled-строка с ответом отдельным словом (как в
        wave-1); probe = последний токен ответа, матчится с границами слова.
      - ("fragment", ...): стрим-фрагменты, содержащие финальные слова ответа
        (2026-09-13: bg/glm-5.3 стал возвращать thinking приклеенным к ответу
        («…Simple.Рим»), settled-строка сворачивается в «N tokens» бейдж, а
        слово «Рим» на экране приклеено к точке thinking'а — word-границ
        нет; стрим-фрагменты «…Simple.Р» + «им» при \r-склейке дают хвост
        ответа. Фрагменты финальных слов на экране = рендер дожил до конца
        ответа (заморозка wave-1 обрывала стрим ДО финальных слов).

    Строки echo промпта (начинаются с «Скажи …», с пробелами или склеенные)
    исключаются маркером «скажи». Промпты ходов обязаны начинаться со «Скажи»,
    иначе echo попадёт в матчинг как ответ.
    """
    if not text:
        return False, "no-text"
    norm = text.replace("\r", "").replace("\b", "").strip()
    if not norm:
        return False, "no-text"
    tokens = [t for t in re.split(r"[\s.]+", norm) if t]
    if not tokens:
        return False, "no-tokens"
    probe = tokens[-1].lower()
    if len(probe) < 2:
        return False, "short-probe"
    tail = screen.replace("\r", "").replace("\b", "")[-10000:]
    rx = re.compile(rf"(?<!\S){re.escape(probe)}(?!\S)")
    for line in tail.splitlines():
        low = line.lower()
        if "скажи" in low:
            continue
        if rx.search(low):
            return True, "word"
    # fallback: фрагмент финальных слов — строка, ОКАНЧИВАЮЩАЯСЯ на probe
    # (склейка thinking'а) либо содержащая probe c любой левой границей.
    for line in tail.splitlines():
        low = line.lower()
        if "скажи" in low:
            continue
        if low.endswith(probe) or re.search(rf"(?!\S){re.escape(probe)}", low):
            return True, "fragment"
    # fallback 2 (vmdev 2026-09-13, full-стек): inline-рендер dsh-tui пишет
    # кадр в ОДНУ PTY-строку (логотип-арт + контент курсорными прыжками, без
    # \n) — probe в середине гигантской строки, строкового матчинга нет.
    # Позиционный матч: probe правее ПОСЛЕДНЕГО echo-маркера «скажи» —
    # ответ модели в потоке всегда ПОЗЖЕ echo введённого промпта, а при
    # заморозке (wave-1 red) финальные слова ответа в поток не попадают.
    low_all = tail.lower()
    last_echo = low_all.rfind("скажи")
    if last_echo >= 0 and probe in low_all[last_echo + 1:]:
        return True, "position"
    return False, "not-found"


# --- основной сценарий --------------------------------------------------------------


def run(args: argparse.Namespace) -> dict:
    started = time.time()
    work_dir = os.path.abspath(args.work_dir)
    os.makedirs(work_dir, exist_ok=True)
    os.makedirs(args.out_dir, exist_ok=True)
    # диагностические логи прошлого прогона не должны попадать в этот вердикт
    for diag in DIAG_LOGS:
        try:
            os.remove(diag)
        except FileNotFoundError:
            pass

    env = dict(os.environ)
    env["DSH_HOME"] = args.dsh_home
    env["TERM"] = "xterm-256color"
    env["DSH_PERMISSION_MODE"] = "danger-full-access"
    env["NO_PROXY"] = "localhost,127.0.0.1"
    env["no_proxy"] = env["NO_PROXY"]

    dsh_bin = ""
    for cand in ("/home/user/.npm-global/bin/dsh", shutil.which("dsh") or ""):
        if cand and os.path.isfile(cand):
            dsh_bin = cand
            break
    if not dsh_bin:
        raise RuntimeError("dsh binary not found")

    cmd = [dsh_bin, "--profile", "dsh-tui"]
    log(f"boot: {' '.join(cmd)} (DSH_HOME={args.dsh_home}, cwd={work_dir})")
    tui = TuiDriver(cmd, env, work_dir)

    verdict: dict = {
        "answer_on_screen": False,
        "answer_match": None,
        "turn1_on_screen": False,
        "turn1_match": None,
        "answer_in_fork_log": False,
        "answer_session_id": None,
        "stderr_errors": [],
        "toast_model_switched_seen": False,
        "error": None,
        "pin_flips": 0,
        "watchdog_fires": 0,
    }
    screen_before_path = os.path.join(args.out_dir, "screen_before_model.txt")
    screen_after_path = os.path.join(args.out_dir, "screen_after.txt")
    raw_buf_path = os.path.join(args.out_dir, "pty_buffer_raw.txt")

    def scan_stderr(text: str) -> list[str]:
        return [p for p in STDERR_PATTERNS if p in text]

    try:
        # 1. готовность TUI
        def tui_ready() -> bool:
            tui.pump(1.0)
            return any(m in tui.output_text() for m in READY_MARKERS)

        if not wait_for(tui_ready, 180, "tui boot", tui):
            raise RuntimeError("TUI not ready")
        tui.pump(5.0)

        session_files = find_session_files(args.dsh_home, work_dir, started)
        if not session_files:
            raise RuntimeError("session.jsonl.zstd not found after boot")
        main_session = session_files[0]
        log(f"main session: {main_session}")

        def answer_count_in(session_idx: int) -> int:
            """Число assistant-сообщений в session_idx-й (по mtime) сессии.

            Сигнал завершения хода: число assistant-текстов выросло. Поиск
            конкретного слова ненадёжен (thinking содержит искомое слово,
            а ответ модели может быть другим — ложный red, найдено 2026-09-13).
            """
            files = find_session_files(args.dsh_home, work_dir, started)
            if len(files) <= session_idx:
                return 0
            try:
                return len(assistant_texts(read_records(files[session_idx])))
            except Exception:
                return 0

        # 2. ход 1: baseline — рендер ДО форка работает. «Скажи» в начале
        # промпта = маркер echo-строк для screen_shows_text, не менять.
        tui.send_line("Скажи \"ок\", а затем парой предложений расскажи о себе.")
        ok_turn1_log = wait_for(
            lambda: answer_count_in(0) >= 1, TURN_TIMEOUT_SEC, "turn 1 answer (log)", tui
        )
        if not ok_turn1_log:
            raise RuntimeError("turn 1 answer not found in session log")
        # settle отрисовки
        tui.pump(5.0)
        turn1_answer = last_answer_in_logs(args.dsh_home, work_dir, started, session_idx=0) or ""
        ok1, how1 = screen_shows_text(tui.screen_text(), turn1_answer)
        verdict["turn1_on_screen"] = ok1
        verdict["turn1_match"] = how1
        log(f"turn1_on_screen={verdict['turn1_on_screen']} ({how1}; answer={turn1_answer!r})")
        with open(screen_before_path, "w") as fh:
            fh.write(tui.screen_text()[-8000:])

        # 3. /model -> форк сессии
        provider, _, model_id = args.model.partition("/")
        tui.send_line(f"/model {provider}/{model_id}")
        # форк создаётся быстро; toast ловим в потоке после завершения
        ok_fork = wait_for(
            lambda: len(find_session_files(args.dsh_home, work_dir, started)) >= 2,
            120,
            "fork session file appears",
            tui,
        )
        if not ok_fork:
            log("WARN: второй session-файл не появился (форк не создан?)")
        tui.pump(5.0)
        if TOAST_RE.search(tui.screen_text()):
            verdict["toast_model_switched_seen"] = True
            log("toast model-switched seen on screen")

        # 4. ход 2: ответ после форка. Сигнал завершения = ЧИСЛО assistant-
        # сообщений в форк-сессии достигло 2 (seed-реплей хода 1 + ход 2);
        # turn/end в форк-логе ложен — seed-реплей тащит turn/end хода 1.
        tui.send_line("Скажи слово РИМ, а затем двумя предложениями объясни, что ты только что сделал.")
        ok_turn2_log = wait_for(
            lambda: answer_count_in(-1) >= 2, TURN_TIMEOUT_SEC, "turn 2 answer (log)", tui
        )
        if not ok_turn2_log:
            log("ERROR: ответ хода 2 не появился в форк-логе за таймаут")
        # фактический ответ модели — ground truth для экранной проверки
        turn2_answer = last_answer_in_logs(args.dsh_home, work_dir, started, session_idx=-1) or ""
        log(f"turn 2 answer (log): {turn2_answer!r}")
        tui.pump(15.0)  # settle финального кадра отрисовки
        final_screen = tui.screen_text()
        ok2, how2 = screen_shows_text(final_screen, turn2_answer)
        verdict["answer_on_screen"] = ok2
        verdict["answer_match"] = how2
        log(f"answer_on_screen={verdict['answer_on_screen']} ({how2})")
        if TOAST_RE.search(final_screen):
            verdict["toast_model_switched_seen"] = True
        verdict["stderr_errors"] = scan_stderr(ANSI_RE.sub("", tui.output_text()))

        with open(screen_after_path, "w") as fh:
            fh.write(final_screen[-16000:])
        with open(raw_buf_path, "wb") as fh:
            fh.write(tui.buffer)

        # диагностика механизма: копируем env-гейтованные логи TUI и считаем
        # ключевые события (flip-осцилляция pin/unpin, watchdog-файры)
        verdict["pin_flips"] = 0
        verdict["watchdog_fires"] = 0
        for diag in DIAG_LOGS:
            if not os.path.isfile(diag):
                continue
            base = os.path.basename(diag)
            try:
                with open(diag, "rb") as src, open(os.path.join(args.out_dir, base), "wb") as dst:
                    dst.write(src.read())
                with open(diag, "r", errors="replace") as fh:
                    lines = fh.readlines()
                if base == "dsh-pin-trace.log":
                    verdict["pin_flips"] = sum(
                        1 for ln in lines if "unpin=true" in ln or "pin=true" in ln
                    )
                elif base == "mfk-watchdog.log":
                    verdict["watchdog_fires"] = sum(1 for ln in lines if " wd fire" in ln)
            except OSError:
                pass

        # 5. анализ логов: где лежит ответ хода 2
        # Форк-детект: session-файл НЕ хранит parentSession в логе — форком
        # считается самая свежая сессия (по mtime), отличная от основной.
        main_sid = os.path.basename(os.path.dirname(main_session))
        for f in find_session_files(args.dsh_home, work_dir, started):
            recs = read_records(f)
            sid = os.path.basename(os.path.dirname(f))
            texts = assistant_texts(recs)
            users = user_texts(recs)
            log(
                f"session {sid}: turns={count_turns(recs)} is_main={sid == main_sid} "
                f"answers={len(texts)} last={texts[-1][:60]!r} user_рим={any('рим' in u.lower() for u in users)}"
            )
            if turn2_answer and texts and texts[-1] == turn2_answer:
                verdict["answer_session_id"] = sid
                verdict["answer_in_fork_log"] = sid != main_sid
        if verdict["answer_session_id"] is None:
            log("answer not matched in any session log")

    except Exception as e:  # noqa: BLE001
        log(f"ERROR: {e}")
        verdict["error"] = str(e)
        try:
            with open(raw_buf_path, "wb") as fh:
                fh.write(tui.buffer)
        except Exception:
            pass
    finally:
        # корректный выход: /exit (ловушка: Ctrl+Q в некоторых версиях не выходит)
        try:
            tui.send_line("/exit")
            time.sleep(3.0)
        except Exception:
            pass
        tui.kill()

    with open(os.path.join(args.out_dir, "verdict.json"), "w") as fh:
        json.dump(verdict, fh, ensure_ascii=False, indent=2)
    print("VERDICT:" + json.dumps(verdict, ensure_ascii=False), flush=True)
    return verdict


def main(argv: Optional[list[str]] = None) -> int:
    global TURN_TIMEOUT_SEC
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dsh-home", default=os.path.expanduser("~/.dsh"))
    ap.add_argument("--work-dir", default=None, help="cwd сессии (default: /tmp/dsh-model-fork-<ts>)")
    ap.add_argument("--out-dir", default=None, help="артефакты (default: /tmp/dsh-model-fork-<ts>)")
    ap.add_argument(
        "--model",
        default="bg/glm-5.3",
        help="модель для /model-переключения (ДОЛЖНА отличаться от дефолта профиля)",
    )
    ap.add_argument("--timeout", type=int, default=TURN_TIMEOUT_SEC)
    args = ap.parse_args(argv)
    TURN_TIMEOUT_SEC = args.timeout
    ts = time.strftime("%Y%m%d-%H%M%S")
    if args.work_dir is None:
        args.work_dir = f"/tmp/dsh-model-fork-{ts}"
    if args.out_dir is None:
        args.out_dir = args.work_dir
    args.out_dir = os.path.abspath(args.out_dir)

    def _hard_timeout(_sig, _frm):
        print("VERDICT:" + json.dumps({"answer_on_screen": False, "error": "hard timeout"}), flush=True)
        sys.exit(1)

    signal.signal(signal.SIGALRM, _hard_timeout)
    signal.alarm(HARD_TIMEOUT_SEC)
    run(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
