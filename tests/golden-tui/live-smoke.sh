#!/usr/bin/env bash
# live-smoke.sh — этапы 4-5 golden-tui: живая dsh-сессия с фейк-моделью
# через SOC lane termseer + запись кадров (record start/stop + frames diff).
# Вызывается из run.sh при LIVE=1. Требования: socctl в PATH, запуск на
# целевой машине lane'ов (Zorin/vmdev запрещены законом SOC).
#
# До запуска: роут fake в ~/.dsh/settings.yaml (см. tools/dsh-fake-llm/README.md)
# и export FAKE_LLM_KEY=fake-local-key.
set -uo pipefail

OUT="${1:?usage: live-smoke.sh <out-dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCEN="$REPO/tests/golden-tui/fake-model-smoke.yaml"
SOC="${SOCCTL:-socctl}"

[ -x "$REPO/tools/dsh-fake-llm/server.mjs" ] || { echo "no fake-llm server.mjs"; exit 1; }
[ -f "$SCEN" ] || { echo "no scenario: $SCEN"; exit 1; }

# 1) fake-llm на фиксированном порту (сценарий ходит на 127.0.0.1:8787)
PORT=8787 node "$REPO/tools/dsh-fake-llm/server.mjs" > "$OUT/live-server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 20); do
  curl -sf http://127.0.0.1:$PORT/health >/dev/null 2>&1 && break
  sleep 0.5
done

# 2) программа: поднимает dsh в termseer-пейне, гоняет turn'ы против фейк-модели,
#    пишет запись (record start/stop) и structural frames diff.
if "$SOC" program --root "$REPO" --file "$SCEN" --lane termseer --background --json > "$OUT/live-program.json" 2>&1; then
  :
else
  echo "socctl program failed"; cat "$OUT/live-program.json"; exit 1
fi
JOB="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["job_id"])' "$OUT/live-program.json" 2>/dev/null || true)"
[ -n "$JOB" ] || { echo "no job_id"; exit 1; }

# 3) poll до терминального статуса
for i in $(seq 1 120); do
  ST="$("$SOC" program-status --job-id "$JOB" --json 2>/dev/null || true)"
  S="$(printf '%s' "$ST" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
  case "$S" in
    done|passed) echo "PROGRAM $S"; break ;;
    fail*|error|cancelled) echo "PROGRAM $S"; printf '%s' "$ST" > "$OUT/live-status-final.json"; exit 1 ;;
  esac
  sleep 10
done
printf '%s' "$ST" > "$OUT/live-status-final.json"
[ "$S" = "done" ] || [ "$S" = "passed" ] || exit 1

# 4) артефакты записи: cast + meta + summary
RD="$REPO/reports/recordings/dsh_fake"
if [ -f "$RD/cast" ]; then
  cp -r "$RD" "$OUT/recordings-dsh-fake" 2>/dev/null || true
  echo "CAST_OK $(wc -l < "$RD/cast") lines"
else
  echo "WARN: recordings/dsh_fake/cast не найден (сценарий не дошёл до record stop?)"
fi
echo "LIVE SMOKE DONE"
