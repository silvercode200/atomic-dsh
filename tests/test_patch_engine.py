# tests/test_patch_engine.py — unit-тесты патч-механизма ~/.dsh/patches/.
#
# Фикстуры — мини-копии целевых файлов (dsh-tools / dsh-system-prompt /
# dsh-code-runtime-worker-thread / dsh-llm-retry / dsh-llm-pi-ai lib/index.js)
# со всеми якорями. Реальные node_modules НЕ трогаются: таргеты подменяются
# через env DSH_TOOLS_PATCH_TARGET / DSH_SP_PATCH_TARGET /
# DSH_WORKER_PATCH_TARGET / DSH_LLM_RETRY_PATCH_TARGET / DSH_LLM_PIAI_PATCH_TARGET.
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPT = Path.home() / ".dsh/patches/apply-dsh-tools-patches.sh"

TOOLS_FIXTURE = """import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
export function renderToolsSdk(schemas) {
\tconst sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
\treturn sorted;
}
export function renderToolsSdkPy(schemas) {
\tconst sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
\treturn sorted;
}
export function runCode(args) {
\tif (result.error) {
\t\tconst logsText = result.logs.length > 0 ? `\\nCaptured output:\\n${result.logs.join("\\n")}` : "";
\t\tthrow new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`);
\t}
}
export { CodeRunFailedError, renderToolsSdk };
"""

SP_FIXTURE = """import { Service } from "@deepseek-ai/cordis";
function renderPrompt(assembly) {
\treturn assembly.sections.map((section) => interpolate(section, assembly.variables, "section")).filter((text) => text.length > 0).join("\\n\\n");
}
"""

WORKER_FIXTURE = """function messageOf(error) {
\treturn error instanceof Error ? error.message : String(error);
}
class Runtime {
\tasync run(request) {
\t\tif (request.signal?.aborted) return this.failureBeforeWorker({
\t\t\tkind: "abort",
\t\t\tmessage: String(request.signal.reason)
\t\t});
\t\tlet code;
\t\ttry {
\t\t\tconst stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + request.program + STRIP_WRAP.suffix);
\t\t\tcode = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length);
\t\t} catch (error) {
\t\t\treturn this.failureBeforeWorker({
\t\t\t\tkind: "exception",
\t\t\t\tmessage: messageOf(error)
\t\t\t});
\t\t}
\t\treturn await this.execute(request, code, bindings);
\t}
\tasync execute(request, code, bindings) {
\t\tconst onAbort = () => {
\t\t\tfinish(() => output.failure([...logs], {
\t\t\t\t\tkind: "abort",
\t\t\t\t\tmessage: String(request.signal?.reason)
\t\t\t}));
\t\t};
\t}
}
"""

LLM_RETRY_FIXTURE = """function localDelay(config, retry, random) {
\tconst exponent = Math.min(retry - 1, 1024);
\tconst exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
\tconst jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
\treturn Math.min(exponential * jitter, config.maxDelayMs);
}
function apply(ctx, config = {}, internals = {}) {
\tasync function recover({ agent, turn, step, provider, failure, retryPolicy: policy, signal }, next) {
\t\tif (policy === void 0) return next();
\t\tif (policy.mode === "always") {
\t\t\treturn;
\t\t} else if (!policy.retryableCodes.includes(failure.code)) return next();
\t\tconst policyKey = retryPolicyKey(policy);
\t\tconst priorPolicyRetry = agent.session.events.findLast((event) => event.type === "llm/retry" && event.data.turn === turn && event.data.step === step && event.data.provider === provider && event.data.policyKey === policyKey);
\t\tconst previousRetry = priorPolicyRetry?.data.retry ?? 0;
\t\tif (policy.mode === "normal" && previousRetry >= policy.maxRetries) return next();
\t\tconst retry = previousRetry + 1;
\t\tconst retryId = priorPolicyRetry?.data.retryId ?? RetryId(randomUUID());
\t\tlet delayMs;
\t\tif (failure.providerRetryAfterMs !== void 0 && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) if (failure.providerRetryAfterMs > policy.maxDelayMs) {
\t\t\tif (policy.mode === "normal") return next();
\t\t\tdelayMs = localDelay(policy, retry, random);
\t\t} else delayMs = failure.providerRetryAfterMs;
\t\telse delayMs = localDelay(policy, retry, random);
\t\treturn backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal);
\t}
}
"""

PIAI_FIXTURE = """function classifyPiAiError(message) {
\tif (/\\b(?:401|403)\\b/.test(message)) return "AUTH";
\tif (/\\b429\\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
\treturn "PI_AI_ERROR";
}
async function* toStreamChunks(events, contextWindow) {
\tconst toolIds = /* @__PURE__ */ new Map();
\tfor await (const event of events) switch (event.type) {
\t\tcase "text_delta":
\t\t\tyield {
\t\t\t\ttype: "text-delta",
\t\t\t\tindex: event.contentIndex,
\t\t\t\ttext: event.delta
\t\t\t};
\t\t\tbreak;
\t\tcase "thinking_delta":
\t\t\tyield {
\t\t\t\ttype: "reasoning-delta",
\t\t\t\tindex: event.contentIndex,
\t\t\t\ttext: event.delta
\t\t\t};
\t\t\tbreak;
\t\tcase "toolcall_delta": {
\t\t\tconst known = toolIds.get(event.contentIndex);
\t\t\tyield {
\t\t\t\ttype: "tool-call-delta",
\t\t\t\tindex: event.contentIndex,
\t\t\t\tid: CallId(known?.id ?? ""),
\t\t\t\targumentsDelta: event.delta
\t\t\t};
\t\t\tbreak;
\t\t}
\t}
}
export { Config, PiAiAdapter, apply, inject, name, recordKeyFor, supportedProtocols };
"""


def _write(tmp_path: Path, name: str, content: str) -> Path:
    p = tmp_path / name
    p.write_text(content, encoding="utf-8")
    return p


def _run(mode: str, tools: Path, sp: Path, worker: Path, llmretry: Path, piai: Path) -> subprocess.CompletedProcess:
    import os

    env = dict(os.environ)
    env.update(
        {
            "DSH_TOOLS_PATCH_TARGET": str(tools),
            "DSH_SP_PATCH_TARGET": str(sp),
            "DSH_WORKER_PATCH_TARGET": str(worker),
            "DSH_LLM_RETRY_PATCH_TARGET": str(llmretry),
            "DSH_LLM_PIAI_PATCH_TARGET": str(piai),
        }
    )
    flag = {"status": "--status", "revert": "--revert", "apply": ""}[mode]
    cmd = ["bash", str(SCRIPT)] + ([flag] if flag else [])
    return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=60)


ALL_PIDS = (
    "sort-ts", "sort-py", "hide", "failctx", "caveman", "synloc", "abortmsg",
    "retry-budget", "mdis403", "repguard",
)


@pytest.fixture()
def fixtures(tmp_path: Path) -> dict[str, Path]:
    return {
        "tools": _write(tmp_path, "tools-index.js", TOOLS_FIXTURE),
        "sp": _write(tmp_path, "sp-index.js", SP_FIXTURE),
        "worker": _write(tmp_path, "worker-index.js", WORKER_FIXTURE),
        "llmretry": _write(tmp_path, "llm-retry-index.js", LLM_RETRY_FIXTURE),
        "piai": _write(tmp_path, "piai-index.js", PIAI_FIXTURE),
    }


def test_apply_marks_all_patches_applied(fixtures: dict[str, Path]) -> None:
    """apply -> все 10 патчей applied; повторный apply — no-op (все skipped)."""
    r = _run("apply", **fixtures)
    assert r.returncode == 0, r.stderr
    for pid in ALL_PIDS:
        assert f"applied {pid}" in r.stdout, pid

    r2 = _run("apply", **fixtures)
    assert r2.returncode == 0, r2.stderr
    assert "applied" not in r2.stdout
    for pid in ALL_PIDS:
        assert f"skipped {pid}" in r2.stdout, pid


def test_status_reports_applied(fixtures: dict[str, Path]) -> None:
    """--status показывает applied после apply, not-applied на vanilla."""
    r0 = _run("status", **fixtures)
    assert r0.returncode == 0
    assert "failctx: not-applied" in r0.stdout
    assert "synloc: not-applied" in r0.stdout
    assert "abortmsg: not-applied" in r0.stdout
    assert "retry-budget: not-applied" in r0.stdout
    assert "mdis403: not-applied" in r0.stdout
    assert "repguard: not-applied" in r0.stdout

    _run("apply", **fixtures)
    r1 = _run("status", **fixtures)
    assert "failctx: applied" in r1.stdout
    assert "synloc: applied" in r1.stdout
    assert "abortmsg: applied" in r1.stdout
    assert "retry-budget: applied" in r1.stdout
    assert "mdis403: applied" in r1.stdout
    assert "repguard: applied" in r1.stdout


def test_revert_roundtrip_byte_identical(fixtures: dict[str, Path]) -> None:
    """revert после apply возвращает все пять файлов к vanilla байт-в-байт."""
    originals = {k: p.read_text(encoding="utf-8") for k, p in fixtures.items()}
    _run("apply", **fixtures)
    # маркеры реально легли
    tools_txt = fixtures["tools"].read_text(encoding="utf-8")
    assert "dshPatchFailureContext" in tools_txt
    assert "dshPatchHiddenTools" in tools_txt
    worker_txt = fixtures["worker"].read_text(encoding="utf-8")
    assert "dshPatchSyntaxErrorContext" in worker_txt
    assert "dshPatchAbortReason" in worker_txt
    retry_txt = fixtures["llmretry"].read_text(encoding="utf-8")
    assert "dshPatchRetryBudgetMs" in retry_txt
    assert "dshPatchBudgetExhausted" in retry_txt
    piai_txt = fixtures["piai"].read_text(encoding="utf-8")
    assert "dshPatchIsModelDisabled" in piai_txt
    assert "dshPatchDetectRepetition" in piai_txt
    assert "dshPatchRepetitionGuard(dshPatchRep, event.delta, true)" in piai_txt
    assert "dshPatchDetectRepetition, inject" in piai_txt

    r = _run("revert", **fixtures)
    assert r.returncode == 0, r.stderr
    for pid in ("failctx", "hide", "sort-ts", "sort-py", "caveman", "synloc", "abortmsg", "retry-budget", "mdis403", "repguard"):
        assert f"reverted {pid}" in r.stdout, pid
    for k, p in fixtures.items():
        assert p.read_text(encoding="utf-8") == originals[k], k


def test_revert_idempotent(fixtures: dict[str, Path]) -> None:
    """Повторный revert — все skipped, файлы не тронуты."""
    _run("apply", **fixtures)
    _run("revert", **fixtures)
    snapshot = {k: p.read_text(encoding="utf-8") for k, p in fixtures.items()}
    r = _run("revert", **fixtures)
    assert r.returncode == 0, r.stderr
    for k, p in fixtures.items():
        assert p.read_text(encoding="utf-8") == snapshot[k], k
