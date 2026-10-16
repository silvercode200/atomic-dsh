#!/usr/bin/env bash
# vm-live-stand.sh — живой стенд dsh на реальном растре WezTerm (Colab VM).
# Запускается НА VM из /root/wezterm-live/. Узлы 2-3 TG-DSH-LIVE-20260926.
#
# Сценарий (один прогон = одна геометрия):
#   boot    — видео с момента ДО старта wezterm: окно → shell → dsh-бут →
#             интро → промпт. Кадры 10fps на первые 25с (мигание рамки
#             ввода на старте — юзер-симптом) + idle-окно 12с (anim-кадры
#             cause='animation' = дыхание; патч 66: при animations:false
#             их быть не должно).
#   task    — реальная модель через фронтдор (провайдер mks, glm-5.3-flash):
#             длинный стриминг-вывод 60 пунктов, poll до завершения turn
#             (маркер ●, счёт от базы до старта задачи).
#   scroll  — колесо вниз ×10 У ДНА (пила scrollHeight, патч 67): окно
#             пилы = SCROLL_BEGIN..SCROLL_WHEEL_DONE (flips=0, sticky_off=0);
#             затем колесо вверх ×3 — легитимное чтение истории (отдельное
#             окно, sticky там ОБЯЗАН сломаться — фича, не баг).
#   hover   — наведение на строки транскрипта (тултип-дубль, патч 68):
#             4 точки, текст-кадр на каждую; вердикт = текст транскрипта
#             неизменен (слой не монтируется в inline).
#   slash   — «/» → слеш-меню (полный список команд), Esc.
#   sbcheck — скроллбек-захват wezterm (--start-line -2000): копии рамки
#             ввода (❯) в истории = E1; стенд БЕЗ zellij → чистый скроллбек
#             здесь = H-A (мусор появляется только под zellij), мусор = H-B
#             (сам WezTerm-растр BSU/ESU).
#
# pkill-паттерны НЕ матчат argv этого скрипта ('bash .../vm-live-stand.sh'):
# GUI-процесс называется wezterm-gui (запуск 'wezterm start' exec'ится в него),
# ffmpeg — по 'x11grab'. Сокет GUI НЕ задаётся WEZTERM_UNIX_SOCKET (env
# действует только на cli/mux-server): GUI биндит $SOCKDIR/gui-sock-<PID>;
# kill_gui вычищает каталог заранее → первый появившийся сокет = наш.
set -uo pipefail
LABEL="${1:-run}"
COLS="${2:-120}"
ROWS="${3:-48}"
BASE=/root/wezterm-live
WORK="$BASE/run-$LABEL"
SOCKDIR="${XDG_RUNTIME_DIR:-/root/.local/share}/wezterm"
SOCK=""
PROFILE="$(cat /root/.dsh-live-target 2>/dev/null || echo dsh-tui)"
DISP=:99
mkdir -p "$WORK/frames"
log() { echo "[stand:$LABEL] $(date -u +%H:%M:%S) $*"; }
mark() { echo "$(date -u +%Y-%m-%dT%H:%M:%S)Z $*" >> "$WORK/marks.txt"; }

wt() { DISPLAY=$DISP WEZTERM_UNIX_SOCKET=$SOCK wezterm cli "$@"; }
get_text() { wt get-text --pane-id 0 > "$1" 2>/dev/null; }
shot() { DISPLAY=$DISP ffmpeg -hide_banner -loglevel error -y \
  -f x11grab -video_size 1600x1000 -i "$DISP" -frames:v 1 "$WORK/frames/$1.png"; }

if wt send-text --help 2>&1 | grep -q -- --no-paste; then NOPASTE=--no-paste; else NOPASTE=; fi
type_line() { wt send-text --pane-id 0 $NOPASTE "$1"; wt send-text --pane-id 0 $NOPASTE $'\r'; }
key_esc()   { wt send-text --pane-id 0 $NOPASTE $'\x1b'; }

kill_gui() {
  # GUI = wezterm-gui (argv '.../wezterm-gui --config-file ...' — паттерн
  # 'wezterm --config-file' его НЕ матчит, орфаны потому и копились);
  # мимо идут и протухшие wezterm-mux-server (держат pid-файл лок).
  pkill -f 'wezterm-gui' 2>/dev/null
  pkill -f 'wezterm-mux-server' 2>/dev/null
  pkill -f 'ffmpeg.*x11grab' 2>/dev/null
  sleep 0.7
  rm -f "$SOCKDIR"/gui-sock-* "$SOCKDIR"/pid 2>/dev/null
  return 0
}

# ---------------------------------------------------------------- чистый старт
kill_gui; sleep 1
rm -f "$WORK/geo.jsonl" "$WORK/marks.txt"
log "геометрия ${COLS}x${ROWS}, профиль $PROFILE, no-paste=${NOPASTE:-нет}"

# X-сервер: сокет+процесс (xdpyinfo ВООБЩЕ НЕ в Colab-образе — проверка через
# него гарантированно FAIL при живом Xvfb; ловушка первого прогона 2026-09-26)
x_ready() { [ -S "/tmp/.X11-unix/X${DISP#:}" ] && pgrep -f "Xvfb $DISP" >/dev/null 2>&1; }
if ! x_ready; then
  pkill -f "Xvfb $DISP" 2>/dev/null; sleep 0.5
  rm -f "/tmp/.X${DISP#:}-lock" "/tmp/.X11-unix/X${DISP#:}"
  nohup Xvfb $DISP -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 &
  for i in $(seq 1 20); do x_ready && break; sleep 0.5; done
  x_ready || { log "FAIL: Xvfb не поднялся"; exit 2; }
fi
log "Xvfb готов"

DISPLAY=$DISP nohup ffmpeg -hide_banner -loglevel error -y \
  -f x11grab -framerate 30 -video_size 1600x1000 -i "$DISP" \
  -pix_fmt yuv420p -crf 30 "$WORK/video-$LABEL.mp4" > "$WORK/ffmpeg.log" 2>&1 &
FFPID=$!
log "ffmpeg pid $FFPID"

WT_COLS=$COLS WT_ROWS=$ROWS DISPLAY=$DISP \
  nohup wezterm --config-file "$BASE/wezterm.lua" start --always-new-process \
  > "$WORK/wezterm.log" 2>&1 &
# Discovery сокета: файл gui-sock-* появляется атомарно с bind, каталог был
# пуст после kill_gui → первый сокет = наш; wt list подтверждает живой mux.
WT_OK=0
for i in $(seq 1 30); do
  SOCK=$(ls "$SOCKDIR"/gui-sock-* 2>/dev/null | head -1)
  if [ -n "$SOCK" ] && wt list >/dev/null 2>&1; then WT_OK=1; break; fi
  sleep 0.5
done
[ "$WT_OK" = 1 ] || {
  log "FAIL: wezterm/mux не поднялся (лог: $(grep -iE 'error' "$WORK/wezterm.log" | head -1))"
  kill "$FFPID" 2>/dev/null; kill_gui; exit 2
}
sleep 1.5
WID=$(DISPLAY=$DISP xdotool search --class wezterm 2>/dev/null | head -1)
[ -n "$WID" ] || { log "FAIL: окно wezterm не найдено"; kill "$FFPID" 2>/dev/null; kill_gui; exit 2; }
eval "$(DISPLAY=$DISP xdotool getwindowgeometry --shell "$WID" | grep -E '^(X|Y|WIDTH|HEIGHT)=')"
WW=${WIDTH:-0}; WH=${HEIGHT:-0}
log "окно wezterm id=$WID pos=${X:-?},${Y:-?} size=${WW}x${WH}"
shot "00-blank"

# ---------------------------------------------------------------- dsh-бут
mark "BOOT_BEGIN"
type_line "DSH_TUI_GEOMETRY_TRACE=$WORK/geo.jsonl DSH_TUI_PIN_TRACE=1 dsh --profile $PROFILE 2>$WORK/boot.err; echo DSH_EXIT_\$?"
BOOT_OK=0
for i in $(seq 1 60); do
  get_text "$WORK/boot-poll.txt"
  grep -qE '❯|for shortcuts' "$WORK/boot-poll.txt" && { BOOT_OK=1; break; }
  sleep 1
done
[ "$BOOT_OK" = 1 ] || { log "FAIL: dsh не загрузился (boot.err далее)"; get_text "$WORK/boot-fail.txt"; shot "99-boot-fail"; kill_gui; kill -INT $FFPID 2>/dev/null; exit 1; }
mark "BOOT_READY"
log "dsh бут готов (попытка $i)"
shot "01-boot"

# idle-окно 12с с мышью-свипами: рендеры от мыши дают кадры (гейт живости
# anim-детектора), но НЕ cause='animation' — дыхание при animations:false
# обязано отсутствовать. Без свипов idle может дать 0 кадров = NO_DATA.
for j in 1 2 3; do
  DISPLAY=$DISP xdotool mousemove --window "$WID" $((WW/2)) $((WH*j/4))
  sleep 2
done
sleep 6
mark "IDLE_WINDOW_END"
shot "02-idle"

# ---------------------------------------------------------------- задача
# Завершение turn = ответ СТАБИЛЕН (2 чтения подряд идентичны, ≥6с) после
# того как транскрипт вырос сверх базы. Маркер ● (assistant bullet) остаётся
# в транскрипте навсегда после ответа — счёт ● не детектирует завершение
# (ловушка раннего DONE посреди стриминга → фаза пилы попала бы в активный
# стриминг → легитимный sticky_off = ложный RED).
get_text "$WORK/task-before.txt"
BASE_TXT=$(md5sum "$WORK/task-before.txt" | cut -d' ' -f1)
BASE_DOT=$(grep -c '●' "$WORK/task-before.txt" || true)
mark "TASK_BEGIN"
type_line "Сгенерируй нумерованный список ровно из 60 пунктов: каждый пункт вида «N. Пункт — короткая фраза про осень», без вступления и заключения."
TASK_T0=$(date -u +%s)
DONE=0; SEEN_GROW=0; PREV=; STABLE=0
for i in $(seq 1 90); do
  get_text "$WORK/task-poll.txt"
  H=$(md5sum "$WORK/task-poll.txt" | cut -d' ' -f1)
  N=$(grep -c '●' "$WORK/task-poll.txt" || true)
  # ответ начался: появился НОВЫЙ assistant-ряд (● сверх базы) — echo
  # промпта не считается (hash меняется и без модели)
  [ "$N" -gt "$BASE_DOT" ] 2>/dev/null && SEEN_GROW=1
  if [ "$SEEN_GROW" = 1 ] && [ -n "$PREV" ] && [ "$H" = "$PREV" ]; then
    STABLE=$((STABLE + 1))
  else
    STABLE=0
  fi
  PREV=$H
  [ "$STABLE" -ge 2 ] && { DONE=1; break; }
  sleep 3
done
TASK_T1=$(date -u +%s)
[ "$DONE" = 1 ] && mark "TASK_DONE $((TASK_T1-TASK_T0))s" || mark "TASK_TIMEOUT $((TASK_T1-TASK_T0))s"
log "задача: done=$DONE за $((TASK_T1-TASK_T0))с (итерация $i, стабильность $STABLE)"
get_text "$WORK/task-final.txt"; shot "03-task-done"

# ---------------------------------------------------------------- скролл-пила
mark "SCROLL_BEGIN"
shot "04-pre-scroll"
DISPLAY=$DISP xdotool mousemove --window "$WID" $((WW/2)) $((WH/2))
for i in $(seq 1 10); do
  DISPLAY=$DISP xdotool click --window "$WID" 5; sleep 0.6
done
mark "SCROLL_WHEEL_DONE"
sleep 2
get_text "$WORK/scroll-after.txt"; shot "05-post-scroll"
for i in $(seq 1 3); do
  DISPLAY=$DISP xdotool click --window "$WID" 4; sleep 0.5
done
sleep 2
get_text "$WORK/scroll-up.txt"; shot "06-post-scroll-up"
mark "SCROLL_END"

# ---------------------------------------------------------------- hover-тултип
mark "HOVER_BEGIN"
for k in 2 3 4 5; do
  HY=$((WH * k / 5))
  DISPLAY=$DISP xdotool mousemove --window "$WID" $((WW/2)) "$HY"
  sleep 1.3
  get_text "$WORK/hover-$k.txt"
  shot "07-hover-$k"
done
DISPLAY=$DISP xdotool mousemove --window "$WID" 5 5
mark "HOVER_END"

# ---------------------------------------------------------------- слеш-меню
# После колеса вверх транскрипт dsh прокручен от дна (ВНУТРЕННИЙ скролл dsh,
# не вьюпорт wezterm: канал мыши жив — sticky_off в окне wheelup). Меню
# слеша рисуется у ввода внизу → без возврата к дну кадр показывает
# транскрипт 17-35 без меню (ловушка прогона #5: entries=[] при живом меню).
# Две пробы: (а) слеш В ПРОКРУЧЕННОМ состоянии — продукт-вопрос E2 (snap
# к дну при вводе или нет); (б) слеш у дна — гейт рендера меню.
wt send-text --pane-id 0 $NOPASTE "/"
sleep 2
get_text "$WORK/slash-scrolled.txt"; shot "08-slash-scrolled"
key_esc; sleep 0.6
mark "SLASH_BEGIN"
for i in $(seq 1 6); do
  DISPLAY=$DISP xdotool click --window "$WID" 5; sleep 0.4
done
sleep 1
get_text "$WORK/pre-slash.txt"
grep -q '60\.' "$WORK/pre-slash.txt" \
  || log "WARN: хвост 60-пунктов не в кадре перед слешем (не у дна?)"
wt send-text --pane-id 0 $NOPASTE "/"
sleep 2
get_text "$WORK/slash.txt"; shot "08-slash"
key_esc; sleep 1
mark "SLASH_END"

# ---------------------------------------------------------------- скроллбек (E1)
mark "SB_BEGIN"
wt get-text --pane-id 0 --start-line -2000 --end-line -1 > "$WORK/scrollback.txt" 2>/dev/null \
  || get_text "$WORK/scrollback.txt"
mark "SB_END"

kill_gui
kill -INT $FFPID 2>/dev/null; sleep 2; kill $FFPID 2>/dev/null
log "прогон $LABEL завершён; артефакты в $WORK"
exit 0
