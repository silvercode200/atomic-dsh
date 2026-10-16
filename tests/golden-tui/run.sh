#!/usr/bin/env bash
# golden-tui/run.sh — golden smoke сьют TUI-механик dsh (TG-DSH-TESTING-20260920 node 4).
# Этапы 1-3 (backend) обязательны; 4-5 (live lane) при доступности — иначе DEGRADED.
# Расширение = отдельный коммит + bump schemaVersion в README.md.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOC="${SOC_ROOT:-$HOME/xeon-Programms/MCP/SOC}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$REPO/reports/golden-tui/$TS"
mkdir -p "$OUT"

schema_version=1
overall="PASS"
declare -a stage_results=()

record() { # $1=status $2=stage $3=detail
  stage_results+=("$1|$2|$3")
  [ "$1" != "PASS" ] && overall="FAIL"
}

# --- Этап 1: selftest fake-llm (backend) -------------------------------------
if (cd "$REPO/tools/dsh-fake-llm" && timeout 60 node selftest.mjs) > "$OUT/stage1-selftest.txt" 2>&1 \
   && grep -q "SELFTEST PASSED: 6/6" "$OUT/stage1-selftest.txt"; then
  record PASS stage1-selftest "SELFTEST PASSED 6/6"
else
  record FAIL stage1-selftest "selftest не прошёл или не найден маркер (см. stage1-selftest.txt)"
fi

# --- Этап 2: сервер + health (backend) ---------------------------------------
PORT="${FAKE_LLM_PORT:-8791}"
PORT=$PORT node "$REPO/tools/dsh-fake-llm/server.mjs" > "$OUT/stage2-server.log" 2>&1 &
SRV=$!
sleep 1.5
h="$(curl -sf "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
if [ -n "$h" ] && printf '%s' "$h" | grep -q '"ok": *true'; then
  record PASS stage2-health "$h"
else
  record FAIL stage2-health "health-ответ не ок: '$h'"
fi
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null

# --- Этап 3: pytest SOC record (backend, мок-сессия) -------------------------
if [ -d "$SOC" ]; then
  if (cd "$SOC" && timeout 300 python3 -m pytest tests/test_record_frames.py -q) > "$OUT/stage3-pytest.txt" 2>&1; then
    n="$(tail -1 "$OUT/stage3-pytest.txt")"
    record PASS stage3-pytest "test_record_frames: $n"
  else
    record FAIL stage3-pytest "pytest упал (см. stage3-pytest.txt)"
  fi
else
  record FAIL stage3-pytest "SOC-чекаут не найден: $SOC"
fi

# --- Этап 3b: контрактные тесты артефактов записи (backend) -------------------
if (cd "$REPO" && timeout 120 python3 -m pytest tests/golden-tui/test_record_contract.py -q) > "$OUT/stage3b-contract.txt" 2>&1; then
  record PASS stage3b-contract "test_record_contract: $(tail -1 "$OUT/stage3b-contract.txt")"
else
  record FAIL stage3b-contract "контракт-тесты записи упали (см. stage3b-contract.txt)"
fi

# --- Этапы 4-5: live lane termseer -------------------------------------------
# Запускаются только при явном opt-in (LIVE=1) И доступности socctl: живые
# TUI-прогоны идут через SOC lane (Zorin/vmdev запрещены законом SOC).
LIVE_OUT="$OUT/stage45-live.txt"
if [ "${LIVE:-0}" = "1" ] && command -v socctl >/dev/null 2>&1; then
  # сценарий поднимает fake-llm, dsh с provider fake, record start/stop + frames diff
  if bash "$REPO/tests/golden-tui/live-smoke.sh" "$OUT" > "$LIVE_OUT" 2>&1; then
    record PASS stage45-live "см. stage45-live.txt"
  else
    record FAIL stage45-live "live-smoke не прошёл (см. stage45-live.txt)"
  fi
else
  overall="DEGRADED"
  echo "Этапы 4-5 (live lane) пропущены: LIVE=1 и socctl не заданы — backend-этапы ниже; live прогнать отдельно" > "$LIVE_OUT"
fi

# --- verdict ------------------------------------------------------------------
{
  echo '{'
  echo "  \"schema_version\": \"golden-tui/$schema_version\","
  echo "  \"ts\": \"$TS\","
  echo "  \"overall\": \"$overall\","
  echo '  "stages": ['
  first=1
  for s in "${stage_results[@]}"; do
    st="${s%%|*}"; rest="${s#*|}"; name="${rest%%|*}"; detail="${rest#*|}"
    [ $first -eq 0 ] && echo ','
    first=0
    printf '    {"name": "%s", "status": "%s", "detail": "%s"}' "$name" "$st" "${detail//\"/\\\"}"
  done
  echo ''
  echo '  ]'
  echo '}'
} > "$OUT/verdict.json"

cat "$OUT/verdict.json"
echo
echo "golden-tui: overall=$overall → $OUT"
[ "$overall" = "PASS" ] || [ "$overall" = "DEGRADED" ]
