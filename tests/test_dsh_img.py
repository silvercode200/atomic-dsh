# tests/test_dsh_img.py — unit-тесты dsh-img (pure python: без сети, без GUI).
#
# Покрывает: magic-детект 5 форматов, генерацию kitty graphics APC-эскейпов
# (формат, чанкинг ≤4096, kv только в первом чанке), выбор фолбэка
# (kitty/chafa/message), размеры панели из IHDR, источник --demo и
# subprocess-проверки CLI-режимов (пайп без ZELLIJ-панели, --render без текста).
from __future__ import annotations

import base64
import importlib.util
import re
import struct
import subprocess
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "dsh-img"

# APC kitty graphics: ESC _ G <kv> ; <base64> ESC \
APC_RE = re.compile(r"\x1b_G([^;]*);([0-9A-Za-z+/=]*)\x1b\\", re.DOTALL)


def _load_module():
    """Загрузить scripts/dsh-img как модуль (файл без .py, через SourceFileLoader)."""
    loader = SourceFileLoader("dsh_img", str(SCRIPT))
    spec = importlib.util.spec_from_loader("dsh_img", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


dsh = _load_module()


def _fake_png(width: int, height: int) -> bytes:
    """PNG-заголовок с заданными размерами IHDR (без валидных чанков)."""
    return (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR"
            + struct.pack(">II", width, height))


# --- magic-детект форматов ---

def test_detect_format_all_five():
    assert dsh.detect_format(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8) == "PNG"
    assert dsh.detect_format(b"\xff\xd8\xff\xe0" + b"\x00" * 12) == "JPEG"
    assert dsh.detect_format(b"GIF89a" + b"\x00" * 10) == "GIF"
    assert dsh.detect_format(b"GIF87a" + b"\x00" * 10) == "GIF"
    assert dsh.detect_format(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "WebP"
    assert dsh.detect_format(b"BM\x36\x00\x00\x00" + b"\x00" * 10) == "BMP"


def test_detect_format_unknown():
    assert dsh.detect_format(b"just some text file") is None
    assert dsh.detect_format(b"") is None


# --- фикстура --demo ---

def test_demo_fixture_is_valid_png():
    assert dsh.detect_format(dsh.DEMO_PNG_1X1[:16]) == "PNG"
    assert dsh.png_dimensions(dsh.DEMO_PNG_1X1) == (1, 1)


# --- kitty graphics эскейпы ---

def test_kitty_escape_single_chunk():
    out = dsh.build_kitty_escapes(dsh.DEMO_PNG_1X1, 60)
    assert out.startswith("\x1b_Gf=100,a=T,q=2,c=60,m=0;")
    assert out.endswith("\x1b\\")
    seqs = APC_RE.findall(out)
    assert len(seqs) == 1
    assert seqs[0][0] == "f=100,a=T,q=2,c=60,m=0"
    assert base64.b64decode(seqs[0][1]) == dsh.DEMO_PNG_1X1


def test_kitty_multichunk_chunking():
    png = _fake_png(300, 200) + b"X" * 30000  # payload сильно больше 4096
    out = dsh.build_kitty_escapes(png, 42)
    seqs = APC_RE.findall(out)
    assert len(seqs) >= 2
    # первый чанк: все kv-пары + m=1
    assert seqs[0][0] == "f=100,a=T,q=2,c=42,m=1"
    # последний чанк: m=0
    assert seqs[-1][0] == "m=0"
    # продолжения: только ключ m (m=1 в середине, m=0 в последнем), без f/a/q/c
    for kv, _ in seqs[1:]:
        assert kv in ("m=1", "m=0"), kv
    # каждый чанк ≤4096 base64-символов
    assert all(len(p) <= 4096 for _, p in seqs)
    # склейка payload декодируется в исходный png
    assert base64.b64decode("".join(p for _, p in seqs)) == png


def test_kitty_kv_only_in_first_chunk():
    png = b"\x89PNG\r\n\x1a\n" + b"Y" * 9000
    out = dsh.build_kitty_escapes(png, 10)
    seqs = APC_RE.findall(out)
    assert len(seqs) > 1
    for kv, _ in seqs[1:]:
        assert kv in ("m=1", "m=0"), "в продолжениях допустим только ключ m: " + kv


# --- поддержка kitty и выбор фолбэка ---

def test_kitty_supported_env():
    assert dsh.kitty_supported({"ZELLIJ": "0"}) is True
    assert dsh.kitty_supported({"ZELLIJEL": "1"}) is True
    assert dsh.kitty_supported({"TERM": "wezterm"}) is True
    assert dsh.kitty_supported({"TERM": "xterm-kitty"}) is True
    assert dsh.kitty_supported({"TERM": "kitty"}) is True
    assert dsh.kitty_supported({"TERM": "xterm-256color"}) is False
    assert dsh.kitty_supported({}) is False


def test_plan_render_matrix():
    zellij_env = {"ZELLIJ": "0", "TERM": "xterm-256color"}
    wezterm_env = {"TERM": "wezterm"}
    plain_env = {"TERM": "xterm-256color"}
    # PNG + kitty-терминал -> kitty
    assert dsh.plan_render("PNG", zellij_env, None) == "kitty"
    assert dsh.plan_render("PNG", wezterm_env, None) == "kitty"
    # PNG, но kitty не поддержана: chafa если есть, иначе message
    assert dsh.plan_render("PNG", plain_env, "/usr/bin/chafa") == "chafa"
    assert dsh.plan_render("PNG", plain_env, None) == "message"
    # не-PNG kitty не принимает: chafa если есть, иначе message
    assert dsh.plan_render("JPEG", zellij_env, "/usr/bin/chafa") == "chafa"
    assert dsh.plan_render("JPEG", zellij_env, None) == "message"
    assert dsh.plan_render("GIF", zellij_env, None) == "message"
    # неизвестный формат
    assert dsh.plan_render(None, zellij_env, None) == "message"


# --- размеры панели из IHDR ---

def test_png_dimensions():
    assert dsh.png_dimensions(_fake_png(1920, 1080)) == (1920, 1080)
    assert dsh.png_dimensions(b"\x89PNG\r\n\x1a") is None  # короткий/битый
    assert dsh.png_dimensions(b"not a png at all....") is None


def test_pane_size_for_png():
    # квадрат 1x1 при cols=60 -> rows = 60*1*0.5 = 30 (+1 запас) -> (62, 31)
    assert dsh.pane_size_for_png(_fake_png(1, 1), 60) == (62, 31)
    # 100x50: rows = 60 * (50/100) * 0.5 = 15 (+1) -> (62, 16)
    assert dsh.pane_size_for_png(_fake_png(100, 50), 60) == (62, 16)
    # очень плоская картинка: rows=round(0.03)=0 -> clamp 2 -> +1 запас = 3
    assert dsh.pane_size_for_png(_fake_png(1000, 1), 60) == (62, 3)
    assert dsh.pane_size_for_png(b"garbage", 60) is None


# --- CLI-режимы (subprocess, без сети) ---

def _run_cli(args, *, env_extra=None, drop_zellij=True):
    env = {k: v for k, v in __import__("os").environ.items()
           if k not in ("ZELLIJ", "ZELLIJEL") or not drop_zellij}
    env["TERM"] = "xterm-256color"
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True, timeout=30, env=env,
    )


def test_cli_demo_piped_prints_kitty_escapes_even_inside_zellij():
    # stdout — пайп (не tty): панель НЕ открывается даже при ZELLIJ=0,
    # --demo форсит kitty-эскейпы прямо в stdout (DONE-критерий).
    proc = _run_cli(["--demo"], env_extra={"ZELLIJ": "0"})
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.startswith(b"\x1b_Gf=100"), proc.stdout[:40]


def test_cli_render_prints_only_escapes_no_hint_text():
    # --render: ТОЛЬКО kitty-эскейпы, без текста-подсказки (фидбек юзера).
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        f.write(dsh.DEMO_PNG_1X1)
        tmp = f.name
    try:
        proc = _run_cli(["--render", tmp, "--cols", "30"],
                        env_extra={"ZELLIJ": "0"})
        assert proc.returncode == 0, proc.stderr
        expected = dsh.build_kitty_escapes(dsh.DEMO_PNG_1X1, 30).encode() + b"\n"
        assert proc.stdout == expected, proc.stdout[:60]
        assert b"dsh-img" not in proc.stdout  # никаких текстовых подсказок
    finally:
        import os
        os.unlink(tmp)


def test_cli_non_png_without_chafa_message_with_path():
    import os
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(b"\xff\xd8\xff\xe0" + b"\x00" * 32)
        tmp = f.name
    try:
        proc = _run_cli([tmp])
        assert proc.returncode == 1
        assert "JPEG" in proc.stdout.decode()
        assert tmp in proc.stdout.decode()  # путь к файлу в сообщении
    finally:
        os.unlink(tmp)
