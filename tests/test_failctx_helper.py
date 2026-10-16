# tests/test_failctx_helper.py — юнит-тесты JS-хелперов failctx/synloc.
#
# Хелперы извлекаются из РЕАЛЬНОГО установленного dsh-tools (пропатченного),
# исполняются в node с замоканным fs/os/path. Проверяются три реальных
# сценария отказа run_code из транскриптов (см. reports/wavec-c-requirements-20260912.md).
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


def _dsh_install() -> Path:
    """Каталог глобальной установки @deepseek-ai/dsh (npm root -g; фоллбек —
    glob ~/.nvm/versions/node/*/..., без хардкода версии node — при апгрейде
    nvm тест молча уходил бы в skip, review MINOR)."""
    import glob as _glob
    import os

    groot = subprocess.run(
        ["npm", "root", "-g"], capture_output=True, text=True, check=True
    ).stdout.strip()
    for cand in (
        Path(groot) / "@deepseek-ai/dsh",
        *(
            Path(p)
            for p in _glob.glob(
                os.path.expanduser(
                    "~/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh"
                )
            )
        ),
    ):
        if (cand / "node_modules/@deepseek-ai/dsh-tools/lib/index.js").is_file():
            return cand
    pytest.skip("dsh-tools не установлен")


def _tools_index() -> Path:
    return _dsh_install() / "node_modules/@deepseek-ai/dsh-tools/lib/index.js"


def _worker_index() -> Path:
    return _dsh_install() / "node_modules/@deepseek-ai/dsh-code-runtime-worker-thread/lib/index.js"


def _run_helper(error_message: str, program: str, saved_dir: Path) -> str:
    """Исполнить dshPatchFailureContext из установленного dsh-tools в node."""
    src = _tools_index().read_text(encoding="utf-8")
    node_script = """
const fs = require("fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const m = src.match(/\\/\\/ dsh-patch-failctx begin[\\s\\S]*?\\/\\/ dsh-patch-failctx end/);
if (!m) { console.error("helper not found (патч failctx не применён?)"); process.exit(9); }
// неймспейс-импорты хелпера замоканы на tempdir: сохранение программы в тестовую папку
const dshPatchFs = { mkdirSync: () => {}, writeFileSync: (f, c) => { savedFile = f; fs.mkdirSync(require("path").dirname(f), {recursive: true}); fs.writeFileSync(f, c); }, readdirSync: () => [], unlinkSync: () => {} };
const dshPatchOs = { homedir: () => process.argv[2] };
const dshPatchPath = require("path");
let savedFile = null;
eval(m[0]);
const error = { message: process.argv[3] };
const program = process.argv[4];
console.log(dshPatchFailureContext(error, program));
console.log("SAVED:" + savedFile);
"""
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        r = subprocess.run(
            ["node", "-e", node_script, str(_tools_index()), td, error_message, program],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if r.returncode == 9:
            pytest.skip("патч failctx не применён в установленном dsh-tools")
        assert r.returncode == 0, r.stderr
        return r.stdout


def test_tool_call_error_gets_tool_and_call_sites() -> None:
    """ToolCallError (стек только worker-internal): имя тула + call sites, шум опущен."""
    msg = (
        'ToolCallError: invalid arguments for bash: missing required property "description"\n'
        "    at bindingFailure (/x/worker.cjs:759:22)\n"
        "    at [nodejs.internal.kHybridDispatch] (node:internal/event_target:843:20)"
    )
    program = (
        "const r = await tools.bash({command: 'ls', description: 'x'});\n"
        "await tools.bash({command: 'dsh --version'});"
    )
    out = _run_helper(msg, program, Path("/tmp"))
    assert "Failing tool: bash" in out
    assert "call sites in program: line(s) 1, 2" in out
    assert "worker.cjs" not in out  # шум worker-internal опущен
    assert "node:internal" not in out
    assert "Program saved:" in out


def test_runtime_typeerror_gets_program_line() -> None:
    """Runtime TypeError (кадр <anonymous>:L:C): строка программы с оффсетом -3."""
    msg = (
        "TypeError: r.stderr.slice is not a function\n"
        "    at eval (eval at runWorkerMain (/x/worker.cjs:887:31), <anonymous>:5:20)\n"
        "    at async runWorkerMain (/x/worker.cjs:887:25)"
    )
    program = (
        "const r = await tools.bash({command: 'v', description: 'd'});\n"
        "const tail = r.stderr.slice(0, 200);\n"
        "return tail;"
    )
    out = _run_helper(msg, program, Path("/tmp"))
    assert "at program line 2, col 20" in out
    assert "2 | const tail = r.stderr.slice(0, 200);" in out
    assert "worker.cjs" not in out


def test_syntax_error_context_passes_through() -> None:
    """Синтакс-ошибка (post-synloc): блок позиции сохраняется, Program saved добавляется."""
    msg = (
        "TS syntax error at program line 1, col 17: Expected ',', got 'ident'\n"
        "  1 | const x = {a: 1 b: 2};\n"
        "  |                 ^"
    )
    out = _run_helper(msg, "const x = {a: 1 b: 2};\nreturn x;", Path("/tmp"))
    assert "TS syntax error at program line 1, col 17" in out
    assert "1 | const x = {a: 1 b: 2};" in out
    assert "Program saved:" in out


def test_synloc_helper_against_real_amaro_error() -> None:
    """synloc-хелпер против РЕАЛЬНОЙ SyntaxError от stripTypeScriptTypes (amaro)."""
    src = _worker_index()
    worker_src = src.read_text(encoding="utf-8")
    if "dsh-patch-synloc begin" not in worker_src:
        pytest.skip("патч synloc не применён")
    node_script = """
const fs = require("fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const m = src.match(/\\/\\/ dsh-patch-synloc begin[\\s\\S]*?\\/\\/ dsh-patch-synloc end/);
function messageOf(error) { return error instanceof Error ? error.message : String(error); }
eval(m[0]);
const { stripTypeScriptTypes } = require("node:module");
const program = "const x = {a: 1 b: 2};\\nreturn x;";
let err;
try { stripTypeScriptTypes("async function __dsh_program__() {\\n" + program + "\\n}"); }
catch (e) { err = e; }
console.log(dshPatchSyntaxErrorContext(err, program));
"""
    r = subprocess.run(
        ["node", "--no-warnings", "-e", node_script, str(src)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert r.returncode == 0, r.stderr
    assert "TS syntax error at program line 1, col 17" in r.stdout
    assert "1 | const x = {a: 1 b: 2};" in r.stdout
    assert "^" in r.stdout


def test_abortmsg_helper_user_cancel_real_case() -> None:
    """abortmsg-хелпер против РЕАЛЬНОГО кейса user-cancel из транскрипта.

    8d7c4568 line 6382: esc во время run_code → dsh-host-apiproxy
    agent.cancel({kind:"user"}) → exec.signal.reason = {kind:"user"} (объект)
    → vanilla String(reason) = "[object Object]". Патч даёт «aborted (user)».
    DOMException-кейс (review MINOR): дефолт AbortSignal.reason — DOMException,
    не instanceof Error в Node; JSON.stringify(DOMException) = "{}" — патч
    даёт чистое «aborted», не «aborted ({})».
    """
    src = _worker_index()
    worker_src = src.read_text(encoding="utf-8")
    if "dsh-patch-abortmsg begin" not in worker_src:
        pytest.skip("патч abortmsg не применён")
    node_script = """
const fs = require("fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const m = src.match(/\\/\\/ dsh-patch-abortmsg begin[\\s\\S]*?\\/\\/ dsh-patch-abortmsg end/);
eval(m[0]);
const cases = [
  [{kind: "user"}, "aborted (user)"],                    // реальный кейс 8d7c4568
  [{kind: "disposed"}, "aborted (disposed)"],
  ["run_code settled", "run_code settled"],
  [new Error("agent loop is not active"), "agent loop is not active"],
  [undefined, "aborted"],
  [{foo: 1}, 'aborted ({"foo":1})'],
  // DOMException-подобный объект (review MINOR): не Error, stringify = "{}"
  [{name: "DOMException", message: "This operation was aborted"}, "aborted"],
];
for (const [reason, expected] of cases) {
  const got = dshPatchAbortReason(reason);
  if (got !== expected) { console.error(`FAIL ${JSON.stringify(got)} != ${JSON.stringify(expected)}`); process.exit(1); }
}
console.log("abortmsg: all 7 reason variants OK");
console.log("main regression case: code run failed (abort): " + dshPatchAbortReason({kind: "user"}));
"""
    r = subprocess.run(
        ["node", "--no-warnings", "-e", node_script, str(src)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert r.returncode == 0, r.stderr
    assert "all 7 reason variants OK" in r.stdout
    # главный регресс-кейс: НЕ "[object Object]"
    assert "aborted (user)" in r.stdout
