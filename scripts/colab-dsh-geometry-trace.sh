#!/usr/bin/env bash
# colab-dsh-geometry-trace.sh — инструментальный прогон dsh TUI на Colab VM
# с forensic-трейсом геометрии скролла (DSH_TUI_GEOMETRY_TRACE) + pin-trace.
#
# Зачем: юзер-баги B1/B2 («почти весь экран пустой → контент опускается»,
# «дрожь строк» при длинном стриме) воспроизводятся фейк-E2E сьютом
# (flicker_toggle_rows 30-37), но покадровый диф не отвечает ГДЕ в коде
# рендера ломается вёрстка. Прогон поднимает TUI на VM с встроенным
# forensic: env DSH_TUI_GEOMETRY_TRACE=<file> пишет одну JSON-строку на
# закрашенный кадр (scroll-геометрия ScrollBox после всех clamp'ов,
# окно виртуализации MessageList, причина кадра), DSH_TUI_PIN_TRACE=1
# пишет флипы pinned/unpinned inline-режима. Синхронно снимается серия
# capture-кадров с таймстампами — корреляция «гашение строк в кадре ↔
# geometry-событие» делается локальным analysis.py по времени.
#
# Зависимости (ставит scripts/colab-dsh-up.sh --target current --fake-model):
#   /root/.dsh-live-target (активный профиль), dsh-fake-llm на 127.0.0.1:8787
#   (health "ok":true), settings.yaml с providers.fake. СКРИПТ НЕ ДЕЛАЕТ
#   деплой — только проверяет готовность и честно падает, если её нет.
#
# Механика (зеркалит tests/colab/dsh-tui-fake.yaml, сьют dsh-tui-fake):
#   tmux-сессия dsh-geo 180×50 (пустая, панель = SHELL), Tc-оверрайд,
#   launch = send-keys с env FAKE_LLM_KEY/DSH_TUI_WD_TRACE/DSH_TUI_PIN_TRACE/
#   DSH_TUI_GEOMETRY_TRACE, boot-poll до рамки ввода (❯ | for shortcuts),
#   send "SCENARIO:long напиши длинный текст" Enter, серия N кадров × 1с
#   (capture-pane + epoch-таймстамп в series.tsv), ожидание конца стрима
#   (●-счётчик, до 90с), выгрузка артефактов tar'ом одним colabctl download.
#
# Артефакты → reports/statusbar-fix-20260919/geometry-trace-<label>/:
#   geometry.jsonl (трейс закрашенных кадров), frame*.txt (серия),
#   series.tsv (idx + epoch_ms кадра), pin-trace.log (может отсутствовать
#   в fullscreen-режиме — сам по себе диагноз), boot.err, vm-ls.txt.
#
# Использование:
#   scripts/colab-dsh-geometry-trace.sh [--label <name>] [--frames <N>]
#   (дефолты: label=geo-r1, frames=30)
#
# Выход: 0 = артефакты выгружены; 1 = прогон/транспорт не удался;
# 2 = usage/инфраструктурная ошибка.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COLABCTL="$HOME/xeon-Programms/MCP/SOC/autotestvm/gcolab/bin/colabctl"
REPORT_BASE="$REPO_DIR/reports/statusbar-fix-20260919"

LABEL="geo-r1"
FRAMES=30

die() { echo "GEO-TRACE FAIL: $*" >&2; exit 2; }
fail() { echo "GEO-TRACE RUN FAIL: $*" >&2; exit 1; }
log() { echo "[geo-trace] $*"; }

usage() { sed -n '2,/^# Выход:/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:?--label требует значение}"; shift 2 ;;
    --frames) FRAMES="${2:?--frames требует значение}"; shift 2 ;;
    -h|--help) usage ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

[[ "$FRAMES" =~ ^[0-9]+$ ]] && [ "$FRAMES" -ge 3 ] \
  || die "--frames: нужно целое >= 3 (flicker-детектор сравнивает кадры k/k+1/k+2)"

# VM-пути (НЕ переменные сьюта: сессия dsh-geo, каталоги dsh-geo*).
GEO_SESS="dsh-geo"
GEO_DIR="/root/dsh-geo"
GEO_FRAMES="/root/dsh-geo-frames"
GEO_OUT="/root/dsh-geo-out"
GEO_TSV="$GEO_FRAMES/series.tsv"
GEO_JSONL="$GEO_DIR/geometry.jsonl"
VM_PIN="/tmp/dsh-pin-trace.log"
VM_BOOTERR="/root/dsh-boot.err"
REPORT_DIR="$REPORT_BASE/geometry-trace-$LABEL"

# --- VM-вызов: маркер SH_OK/SH_FAIL в последней строке stdout (мини-копия
# vm_sh из colab-dsh-live-check.sh). При таймауте обёртки внук `colab exec`
# выживает и держит flock сессий — чистим свои залипшие exec'и (паттерн
# [.]py не матчит собственную обёртку). ---
vm_sh() { # $1 = команда, $2 = таймаут (сек, дефолт 120); stdout = чистый вывод VM
  local cmd="$1" t="${2:-120}" out marker rc
  if ! out="$(timeout "$t" "$COLABCTL" sh -c "$cmd" 2>/dev/null)"; then
    pkill -f "colab exec .* -f /tmp/tmp.*-vm-sh[.]py" 2>/dev/null || true
    return 1
  fi
  marker="$(printf '%s\n' "$out" | tail -n1)"
  if [[ "$marker" =~ ^SH_FAIL\ rc=([0-9]+) ]]; then rc="${BASH_REMATCH[1]}"
  elif [[ "$marker" =~ ^SH_OK ]]; then rc=0
  else return 1; fi
  printf '%s\n' "$out" | sed '$d' \
    | awk '!/^\[colab\] / && !/^session-health:/ && !/^colabctl:/ && !/^SH_OK/ && !/^SH_FAIL rc=/'
  return "$rc"
}

vm_sh_ok() { # $1 = команда, $2 = таймаут; rc=0 или смерть с сообщением
  local out rc=0
  out="$(vm_sh "$1" "${2:-120}")" || rc=1
  [ "$rc" -eq 0 ] || printf 'vm_sh вывод:\n%s\n' "$out" >&2
  return "$rc"
}

# --- 0. Готовность VM (деплой НЕ наш — только проверки, честный фейл) ---------
log "шаг 0: проверка готовности VM (деплой делает colab-dsh-up.sh)"
out="$(vm_sh 'echo VM_READY' 60 || true)"
printf '%s' "$out" | grep -q VM_READY || fail "VM не отвечает (запусти colab-dsh-up.sh --target current --fake-model)"
vm_sh_ok 'test -s /root/.dsh-live-target && cat /root/.dsh-live-target' 60 \
  || fail "нет /root/.dsh-live-target на VM (деплой не завершён?)"
vm_sh_ok 'curl -s http://127.0.0.1:8787/health 2>/dev/null | grep -q "\"ok\":true"' 60 \
  || fail "фейк-сервер :8787 не здоров (деплой без --fake-model?)"
log "VM жива, фейк-сервер здоров"

# --- 1. Чистая tmux-сессия + сброс артефактов ---------------------------------
log "шаг 1: tmux $GEO_SESS 180×50, сброс артефактов"
vm_sh_ok "tmux kill-session -t $GEO_SESS 2>/dev/null; true" 60 || true
vm_sh_ok "rm -rf $GEO_FRAMES $GEO_OUT $GEO_DIR; mkdir -p $GEO_FRAMES $GEO_DIR; rm -f $VM_PIN $VM_BOOTERR $GEO_JSONL; echo CLEANED" 120 \
  || fail "не очистились артефакт-каталоги на VM"
vm_sh_ok "tmux new-session -d -s $GEO_SESS -x 180 -y 50" 90 \
  || fail "tmux-сессия $GEO_SESS не создалась"
vm_sh_ok "tmux set -as terminal-overrides \",xterm-256color:Tc\"" 60 \
  || fail "Tc-оверрайд tmux не применился"

# --- 2. Launch TUI с forensic-env (механика = сьют + GEOMETRY_TRACE) ---------
log "шаг 2: launch dsh с DSH_TUI_GEOMETRY_TRACE=$GEO_JSONL"
vm_sh_ok "tmux send-keys -t $GEO_SESS \"FAKE_LLM_KEY=fake-local-key DSH_TUI_WD_TRACE=1 DSH_TUI_PIN_TRACE=1 DSH_TUI_GEOMETRY_TRACE=$GEO_JSONL dsh --profile \$(cat /root/.dsh-live-target) 2>$VM_BOOTERR\" Enter" 90 \
  || fail "send-keys launch не прошёл"

# --- 3. Boot-poll: рамка ввода видна (как boot_poll сьюта, до 180с) ----------
log "шаг 3: boot-poll (до 180с)"
out="$(vm_sh "for i in \$(seq 1 180); do
  tmux capture-pane -p -t $GEO_SESS > $GEO_FRAMES/boot.txt
  if grep -qE '❯|for shortcuts' $GEO_FRAMES/boot.txt; then echo READY; exit 0; fi
  sleep 1
done
echo NOT_READY
exit 1" 210)" \
  || fail "TUI не поднялся за 180с (boot.err на VM: $VM_BOOTERR; последний кадр на VM: $GEO_FRAMES/boot.txt)"
log "TUI поднялся ($out)"

# --- 4. Warmup-фаза: короткий turn ДО long (механика сьюта dsh-tui-fake) ------
# Probe geo-r1: ПЕРВЫЙ turn сессии dsh шлёт промпт в формате, где маркер
# SCENARIO:<name> не доходит до text-блока user-сообщения (фейк-сервер
# детектит short, log: scenario=short marker=False), а последующие turn'ы —
# доходят (r11: сьют слал short→waves→tools→long и long работал). Warmup
# = один короткий turn, затем long-стрим штатно детектится.
log "шаг 4: warmup SCENARIO:short (первый turn — формат промпта)"
vm_sh_ok "tmux capture-pane -p -t $GEO_SESS | { grep -c '●' > $GEO_DIR/warmup-base.txt || true; }; true" 60 \
  || fail "база ●-счётчика warmup не записана"
vm_sh_ok "tmux send-keys -t $GEO_SESS \"SCENARIO:short привет, ответь кратко\" Enter" 90 \
  || fail "send-keys warmup-промпта не прошёл"
out="$(vm_sh "base=\$(cat $GEO_DIR/warmup-base.txt)
for w in \$(seq 1 45); do
  tmux capture-pane -p -t $GEO_SESS > $GEO_FRAMES/warmup-done.txt
  n=\$(grep -c '●' $GEO_FRAMES/warmup-done.txt || true)
  [ \"\$n\" -gt \"\$base\" ] && { echo WARMUP_DONE; exit 0; }
  sleep 2
done
echo WARMUP_TIMEOUT
exit 1" 120)" \
  || { cat $GEO_FRAMES/warmup-done.txt 2>/dev/null | head -20; fail "warmup-ответ не пришёл за 90с (см. warmup-done.txt)"; }
log "warmup: $out"

# --- 5. Long-стрим + серия кадров с таймстампами (сэмплируемый turn) --------- -----------------------------
# База ●-маркеров ДО промпта (конец стрима = новый ●, как long_done_poll).
# grep -c при нуле совпадений возвращает rc=1 — пустой чат при старте ● не
# содержит, база 0 легитимна: гасим rc, не фейля шаг.
vm_sh_ok "tmux capture-pane -p -t $GEO_SESS | { grep -c '●' > $GEO_DIR/long-base.txt || true; }; true" 60 \
  || fail "база ●-счётчика не записана"
log "шаг 5: send SCENARIO:long + серия $FRAMES кадров × 1с"
vm_sh_ok "tmux send-keys -t $GEO_SESS \"SCENARIO:long напиши длинный текст\" Enter" 90 \
  || fail "send-keys промпта не прошёл"
# Серия: один цикл на VM (30+ транспортных раундов = флейк и 2× время).
# series.tsv: idx epoch_ms — таймстамп СРАЗУ ПЕРЕД capture, окно кадра k =
# [ts_k, ts_{k+1}); анализ сопоставляет trace-строки (ISO t) с окнами.
vm_sh_ok "for ((I=1; I<=$FRAMES; I++)); do
  TS=\$(date +%s%3N)
  tmux capture-pane -p -t $GEO_SESS > $GEO_FRAMES/frame\$(printf '%03d' \$I).txt
  printf '%d %s\n' \"\$I\" \"\$TS\" >> $GEO_TSV
  sleep 1
done
echo SERIES_DONE" "$((FRAMES + 60))" \
  || fail "серия кадров не снялась"
n_frames="$(vm_sh "ls -1 $GEO_FRAMES/frame*.txt 2>/dev/null | wc -l" 60)" || n_frames=0
log "серия снята: $n_frames кадров"

# --- 6. Конец стрима (до 90с: ●-счётчик вырос от базы) ------------------------ ------------------------
log "шаг 6: ожидание конца long-стрима (до 90с)"
out="$(vm_sh "base=\$(cat $GEO_DIR/long-base.txt)
for w in \$(seq 1 45); do
  tmux capture-pane -p -t $GEO_SESS > $GEO_FRAMES/long-done.txt
  n=\$(grep -c '●' $GEO_FRAMES/long-done.txt)
  [ \"\$n\" -gt \"\$base\" ] && { echo LONG_DONE; exit 0; }
  sleep 2
done
echo LONG_TIMEOUT
exit 0" 120)" || out="LONG_POLL_FAIL"
log "стрим: $out (не блокирует выгрузку)"
# погасить TUI, чтобы trace-файл закрылся чисто (стрим мог не завершиться)
vm_sh_ok "tmux send-keys -t $GEO_SESS C-c; sleep 1; tmux send-keys -t $GEO_SESS /exit; sleep 1; tmux send-keys -t $GEO_SESS Enter; sleep 2; tmux kill-session -t $GEO_SESS 2>/dev/null; true" 120 \
  || log "завершение TUI-сессии не гладкое (не критично)"

# --- 7. Стейджинг-каталог + tar одним вызовом ---------------------------------- ---------------------------------
log "шаг 7: стейджинг артефактов на VM"
# pin-trace может отсутствовать (fullscreen-режим НЕ пишет pin-trace — эффект
# Chat.js возвращается до трейс-вызовов; это сам по себе диагноз) — кладём
# объяснительную строку, факт фиксирует vm-ls.txt. Раскладка ПЛОСКАЯ:
# frame*.txt/series.tsv/geometry.jsonl/pin-trace.log в корне отчёта.
vm_sh_ok "mkdir -p $GEO_OUT
cp $GEO_JSONL $GEO_OUT/geometry.jsonl 2>/dev/null || echo GEOMETRY_MISSING > $GEO_OUT/geometry.jsonl.missing
cp $GEO_FRAMES/*.txt $GEO_FRAMES/*.tsv $GEO_OUT/ 2>/dev/null
if [ -f $VM_PIN ]; then cp $VM_PIN $GEO_OUT/pin-trace.log; else printf '%s\n' 'MISSING: /tmp/dsh-pin-trace.log не создан — fullscreen-режим не пишет pin-trace (эффект Chat.js:452 возвращается до трейс-вызовов); факт — в vm-ls.txt' > $GEO_OUT/pin-trace.log; fi
if [ -f $VM_BOOTERR ]; then cp $VM_BOOTERR $GEO_OUT/boot.err; else echo 'BOOTERR_MISSING (boot без stderr)' > $GEO_OUT/boot.err; fi
{ ls -la $GEO_JSONL $VM_PIN $VM_BOOTERR 2>&1; wc -l $GEO_JSONL 2>/dev/null; } > $GEO_OUT/vm-ls.txt
tar -czf /root/dsh-geo-out.tar.gz -C /root dsh-geo-out
echo STAGED" 150 \
  || fail "стейджинг на VM не собрался"

# --- 8. Выгрузка + распаковка в отчёт-каталог ---------------------------------- ---------------------------------
log "шаг 8: выгрузка → $REPORT_DIR"
mkdir -p "$REPORT_DIR"
timeout 240 "$COLABCTL" download /root/dsh-geo-out.tar.gz "$REPORT_DIR/dsh-geo-out.tar.gz" >/dev/null 2>&1 \
  || fail "tar-архив не скачался (colabctl download)"
tar -xzf "$REPORT_DIR/dsh-geo-out.tar.gz" -C "$REPORT_DIR" \
  || fail "tar не распаковался"
rm -f "$REPORT_DIR/dsh-geo-out.tar.gz"
mv "$REPORT_DIR/dsh-geo-out"/* "$REPORT_DIR"/ 2>/dev/null || true
rmdir "$REPORT_DIR/dsh-geo-out" 2>/dev/null || true
vm_sh_ok "rm -rf $GEO_OUT /root/dsh-geo-out.tar.gz" 60 || true

# --- 9. Самопроверка артефактов ------------------------------------------------ ----------------------------------------------
[ -s "$REPORT_DIR/geometry.jsonl" ] || fail "geometry.jsonl пуст/отсутствует (env DSH_TUI_GEOMETRY_TRACE не дошёл до TUI?)"
n_jsonl="$(wc -l < "$REPORT_DIR/geometry.jsonl")"
[ "$n_jsonl" -ge 200 ] \
  || log "ВНИМАНИЕ: geometry.jsonl строк $n_jsonl < 200 (ожидали больше; анализ возможен, но данных мало)"
if [ ! -f "$REPORT_DIR/pin-trace.log" ]; then
  log "pin-trace.log отсутствует → fullscreen-режим (Chat.js pin-эффект не пишет в fullscreen)"
fi
log "OK: артефакты в $REPORT_DIR"
log "geometry.jsonl: $n_jsonl строк; кадров: $(ls -1 "$REPORT_DIR"/frame*.txt 2>/dev/null | wc -l)"
exit 0
