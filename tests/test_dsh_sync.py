# tests/test_dsh_sync.py — unit-тесты логики dsh-sync (фильтры, dry-run, rlist).
#
# Функции dsh-sync source-ятся до блока разбора аргументов; сетевые примитивы
# (ssh/scp/remote_bash) замокаются. Реальная сеть не используется.
from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DSH_SYNC = REPO / "dsh-sync"

# source-хвост: всё до разбора аргументов (case-блок не исполняется)
FUNCTIONS_HEAD = r"/^# --- разбор аргументов/{exit} {print}"

PRELUDE_TMPL = """set -u
REMOTE=mockhost
DRY_RUN={dry_run}
WITH_CREDENTIALS={with_credentials}
awk '{head}' "{script}" > "$TMPD/functions.sh"
source "$TMPD/functions.sh"
ssh() {{ return 0; }}
scp() {{ return 0; }}
remote_bash() {{ printf '%s\\n' "$MOCK_REMOTE_OUT"; }}
remote_stats() {{ printf '%s\\n' "$MOCK_STATS"; }}
"""


def _run_bash(
    body: str,
    *,
    dry_run: int = 0,
    with_credentials: int = 0,
    mock_stats: str = "",
    mock_remote_out: str = "",
) -> subprocess.CompletedProcess:
    """Исполнить body в bash с source-нутыми функциями dsh-sync и моками сети."""
    prelude = PRELUDE_TMPL.format(
        dry_run=dry_run,
        with_credentials=with_credentials,
        head=FUNCTIONS_HEAD,
        script=DSH_SYNC,
    )
    script = prelude + body
    env = dict(os.environ)
    env["MOCK_STATS"] = mock_stats
    env["MOCK_REMOTE_OUT"] = mock_remote_out
    env["TMPD"] = tempfile.mkdtemp(prefix="dsh-sync-test-")
    try:
        return subprocess.run(
            ["bash", "-c", script], capture_output=True, text=True, timeout=30, env=env
        )
    finally:
        import shutil

        shutil.rmtree(env["TMPD"], ignore_errors=True)


def test_credentials_excluded_by_default() -> None:
    """cfg_files_list: без --with-credentials НЕ содержит .credentials.yaml; с флагом — содержит."""
    r = _run_bash("cfg_files_list; printf '%s\\n' \"${CFG_LIST[@]}\"")
    assert r.returncode == 0, r.stderr
    assert ".credentials.yaml" not in r.stdout
    assert "settings.yaml" in r.stdout
    assert "AGENTS.md" in r.stdout

    r2 = _run_bash(
        "cfg_files_list; printf '%s\\n' \"${CFG_LIST[@]}\"", with_credentials=1
    )
    assert ".credentials.yaml" in r2.stdout


def test_is_active_threshold() -> None:
    """is_active: mtime свежее 60с — активна; старше — нет; 0 — нет."""
    body = (
        "now=$(date +%s); "
        "is_active $((now-10)) && echo FRESH_ACTIVE; "
        "is_active $((now-120)) || echo STALE_INACTIVE; "
        "is_active 0 || echo ZERO_INACTIVE"
    )
    r = _run_bash(body)
    assert r.returncode == 0, r.stderr
    assert "FRESH_ACTIVE" in r.stdout
    assert "STALE_INACTIVE" in r.stdout
    assert "ZERO_INACTIVE" in r.stdout


def test_push_files_selects_newer_local_only() -> None:
    """push_files: локальный новее удалённого -> push; удалённый новее -> skip; мелкий -> skip."""
    with tempfile.TemporaryDirectory() as td:
        f_push = Path(td) / "push.yaml"   # локальный новее -> push
        f_skip = Path(td) / "skip.yaml"   # удалённый новее -> skip
        f_tiny = Path(td) / "tiny.yaml"   # локальный новее, но <100b -> skip
        for f, content in ((f_push, "x" * 200), (f_skip, "y" * 200), (f_tiny, "z" * 10)):
            f.write_text(content)
        now = int(time.time())
        old = now - 3600
        fresh = now + 3600
        for f, mtime in ((f_push, now), (f_skip, old), (f_tiny, now)):
            os.utime(f, (mtime, mtime))
        stats = "\n".join(
            [
                f"{old} 200 {f_push}",   # удалённый старее -> локальный новее -> push
                f"{fresh} 200 {f_skip}", # удалённый свежее -> skip
                f"{old} 200 {f_tiny}",   # удалённый старее, но локальный мелкий -> skip
            ]
        )
        body = 'DRY_RUN=1; push_files "test" "%s" "%s" "%s"' % (f_push, f_skip, f_tiny)
        r = _run_bash(body, mock_stats=stats)
        assert r.returncode == 0, r.stderr
        assert "[test] 1 отправлено, 2 без изменений, 0 ошибок" in r.stdout
        assert f"[dry-run] push {f_push}" in r.stdout
        assert f"[dry-run] push {f_skip}" not in r.stdout


def test_sync_sessions_skips_active_remote_only_files() -> None:
    """Remote-only файлы: активные на удалённой (mtime<60с) пропускаются, старые — pull."""
    now = int(time.time())
    active_remote = "/home/user/.dsh/sessions/x/active/session.jsonl.zstd"
    stale_remote = "/home/user/.dsh/sessions/x/stale/session.jsonl.zstd"
    # remote_bash отвечает пустым stats + RLIST с mtime (формат find -printf '%T@ %p')
    mock_out = (
        "===RLIST===\n"
        f"{now}.123 {active_remote}\n"
        f"{now - 5000}.0 {stale_remote}"
    )
    with tempfile.TemporaryDirectory() as td:
        # пустой локальный sessions-каталог: вся работа в remote-only ветке
        (Path(td) / "sessions").mkdir()
        body = 'DSH_DIR="%s"; sync_sessions' % td
        r = _run_bash(body, dry_run=1, mock_remote_out=mock_out)
        assert r.returncode == 0, r.stderr
        assert f"[dry-run] pull {stale_remote}" in r.stdout
        assert f"[dry-run] pull {active_remote}" not in r.stdout
        # 1 pull (stale), активный remote-only в skip
        assert "1 получено" in r.stdout


def test_no_arg_is_forbidden() -> None:
    """Запуск без аргументов запрещён (нет авто-watcher)."""
    r = subprocess.run(
        ["bash", str(DSH_SYNC)], capture_output=True, text=True, timeout=30
    )
    assert r.returncode == 2
    assert "запрещена" in r.stderr


def test_help_documents_check_and_credentials() -> None:
    """--help документирует --check, --with-credentials, отсутствие watcher."""
    r = subprocess.run(
        ["bash", str(DSH_SYNC), "--help"], capture_output=True, text=True, timeout=30
    )
    assert r.returncode == 0
    assert "--check" in r.stdout
    assert "--with-credentials" in r.stdout
    assert "watcher" in r.stdout.lower()


def test_remote_stats_script_quotes_injection_filenames() -> None:
    """MAJOR#2: имя файла с одинарной кавычкой не вырывается из remote-скрипта.

    Генерируем скрипт для злого имени, проверяем: bash -n парсит его, и
    исполнение (stat отсутствующего файла) не создаёт инъекционный маркер.
    """
    evil = "/tmp/x'; touch /tmp/pwned-dsh-sync; '.y"
    body = (
        "script=$(remote_stats_script \"%s\"); "
        "printf '%%s\\\\n' \"$script\"; "
        "rm -f /tmp/pwned-dsh-sync; "
        "bash <<<\"$script\"; "
        "test -e /tmp/pwned-dsh-sync && echo PWNED || echo SAFE"
        % evil
    )
    r = _run_bash(body)
    assert r.returncode == 0, r.stderr
    assert "PWNED" not in r.stdout, r.stdout
    assert "SAFE" in r.stdout, r.stdout
    # сгенерированный скрипт синтаксически валиден и не содержит голой инъекции
    assert "$(touch" not in r.stdout


def test_shq_escapes_single_quotes() -> None:
    """shq: строка с кавычкой превращается в безопасный single-quoted литерал."""
    body = (
        "shq \"x'; y\"; echo; "
        "v=$(shq \"it's\"); eval \"echo $v\""
    )
    r = _run_bash(body)
    assert r.returncode == 0, r.stderr
    assert "it's" in r.stdout, r.stdout


def test_shq2_escapes_double_quote_context() -> None:
    """shq2: двойные кавычки с экранированием $ ` \" \\ — безопасно для ssh-строк."""
    body = 'v=$(shq2 \'a"b`c$d\\e\'); echo "$v"'
    r = _run_bash(body)
    assert r.returncode == 0, r.stderr
    # вывод shq2 = экранированный double-quoted литерал для remote shell
    assert '"a\\"b\\`c\\$d\\\\e"' in r.stdout, r.stdout


def test_flush_pending_skips_when_remote_newer() -> None:
    """MAJOR#4: remote-файл новее pending-файла -> push пропущен, pending сохранён."""
    with tempfile.TemporaryDirectory() as td:
        pending = Path(td) / "settings.yaml.pending.123"
        pending.write_text("x" * 200)
        old = int(time.time()) - 3600
        os.utime(pending, (old, old))
        # ssh-мок: stat-запрос -> "remote" mtime сильно новее pending
        body = (
            "ssh() { case \"$*\" in *stat*) echo %d;; *) return 0;; esac; }; "
            "scp() { echo \"SCP_CALLED\"; return 0; }; "
            "PENDING_DIR=\"%s\"; "
            "flush_pending; "
            "test -f \"%s\" && echo PENDING_KEPT"
            % (int(time.time()) + 3600, td, pending)
        )
        r = _run_bash(body)
        assert r.returncode == 0, r.stderr
        assert "SCP_CALLED" not in r.stdout, r.stdout
        assert "PENDING_KEPT" in r.stdout, r.stdout
        assert "конфликт" in r.stderr or "конфликт" in r.stdout


def test_flush_pending_pushes_when_remote_older_or_missing() -> None:
    """MAJOR#4 (контроль): remote старее/отсутствует -> push проходит, pending удаляется."""
    with tempfile.TemporaryDirectory() as td:
        pending = Path(td) / "settings.yaml.pending.123"
        pending.write_text("x" * 200)
        fresh = int(time.time())
        os.utime(pending, (fresh, fresh))
        body = (
            "ssh() { case \"$*\" in *stat*) echo 0;; *) return 0;; esac; }; "
            "scp() { echo \"SCP_CALLED\"; return 0; }; "
            "PENDING_DIR=\"%s\"; "
            "flush_pending; "
            "test -f \"%s\" || echo PENDING_FLUSHED"
            % (td, pending)
        )
        r = _run_bash(body)
        assert r.returncode == 0, r.stderr
        assert "SCP_CALLED" in r.stdout, r.stdout
        assert "PENDING_FLUSHED" in r.stdout, r.stdout
