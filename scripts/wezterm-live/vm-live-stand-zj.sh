#!/usr/bin/env bash
# vm-live-stand-zj.sh — ячейка zellij: WezTerm → zellij(кастом юзера) → dsh.
# Вариант vm-live-stand.sh (TG-ZCELL-20260926, матрица №2 хендоффа
# handoff-zellij-20260926.md): dsh запускается ВНУТРИ zellij-сессии —
# точная реплика продакшена юзера.
#
# Паритет продакшена (по исходникам форка, 26.09):
#   запуск  — ДВА шага как обёртка zz: (1) attach --create-background
#             с Z_OPTS (mouse-mode false — опции СОЗДАНИЯ, живут в
#             сессии), (2) attach БЕЗ опций с --config (конфиг юзера).
#   мышь    — финальный attach-клиент решает по СВОЕМУ конфигу:
#             config.kdl юзера = mouse_mode true → enable_mouse →
#             WezTerm ?1000h?1002h?1003h?1015h?1006h (input_handler.rs:166,
#             lib.rs:934 «CLI options merged into (getting priority over)
#             saved config options», kdl/mod.rs:2800). Колесо = SGR-мышь →
#             zellij скроллит СВОЙ viewport; dsh (inline, без mouse
#             tracking) событий не получает.
#   конфиг  — зеркало ~/.config/zellij/config.kdl юзера (mouse_mode true,
#             COLORTERM truecolor, scroll-кейбинды: Alt q = PageScrollUp,
#             PageUp = HalfPageScrollUp — последний bind побеждает).
#   BSU     — форк отвечает на DECRQM ?2026 «поддерживается» (grid.rs:5486)
#             и поглощает транзакции (?2026h lock_renders:5375, ?2026l
#             unlock_renders:5271) — путь ink sync-output в продакшне;
#             pane-env.txt проверяет проброс TERM/TERM_PROGRAM.
#
# Отличия от vm-live-stand.sh:
#   dsh-бут   — вместо прямого запуска dsh печатается команда запуска
#               zellij-attach (кастом-бинарь /usr/local/bin/zjcustom,
#               доставлен оркестратором через VPS-стейджинг); layout
#               одной панели запускает env-дамп + dsh (env панели = что
#               zellij пробрасывает: TERM/TERM_PROGRAM/COLORTERM — ключ
#               гипотезы sync-output BSU/ESU+DECSTBM).
#   скроллбек — WezTerm в alt-screen (zellij уводит ?1049h) →
#               wt get-text --start-line НЕ видит историю; захват
#               скроллбека ПАНЕЛИ zellij: Ctrl s (вход в Scroll-режим,
#               бинд и дефолта, и конфига юзера) → Ctrl b (PageScrollUp
#               в конфиге юзера, bind 184, НЕ пере-бинден позже — в
#               отличие от PageUp=HalfPage; байт 0x02 без ESC-ambiguity)
#               ×N с get_text на каждую страницу → конкатенация в
#               scrollback.txt (контракт vm-analyze.py). Выход — Esc,
#               к дну — Ctrl s; Ctrl c (ScrollToBottom).
#   teardown  — перед kill_gui: zjcustom delete-session (сервер живёт
#               дольше клиента) + pkill по zjcustom/dsh.
#
# Кейбинды (конфиг юзера = продакшн): Ctrl s → Scroll; в scroll:
#   Ctrl b = PageScrollUp (шаг rows-1 — 1 строка перекрытия между
#   страницами), PageUp = HalfPageScrollUp (последний bind побеждает
#   ранний PageScrollUp:184), j/k = 1 строка, Ctrl c =
#   ScrollToBottom+Normal; Esc → Normal.
#
# Курсорный ввод: zellij-клиент ставит tty в raw → Ctrl s (0x13) НЕ
# перехватывается IXON-дисциплиной, доходит до клиента как клавиша.
set -uo pipefail
LABEL="${1:-run-zj}"
COLS="${2:-47}"
ROWS="${3:-43}"
BASE=/root/wezterm-live
WORK="$BASE/run-$LABEL"
SOCKDIR="${XDG_RUNTIME_DIR:-/root/.local/share}/wezterm"
SOCK=""
ZJ=/usr/local/bin/zjcustom
ZJ_SESSION="dshz-$LABEL"
PROFILE="$(cat /root/.dsh-live-target 2>/dev/null || echo dsh-tui)"
DISP=:99
mkdir -p "$WORK/frames"
log() { echo "[stand-zj:$LABEL] $(date -u +%H:%M:%S) $*"; }
mark() { echo "$(date -u +%Y-%m-%dT%H:%M:%S)Z $*" >> "$WORK/marks.txt"; }

wt() { DISPLAY=$DISP WEZTERM_UNIX_SOCKET=$SOCK wezterm cli "$@"; }
get_text() { wt get-text --pane-id 0 > "$1" 2>/dev/null; }
shot() { DISPLAY=$DISP ffmpeg -hide_banner -loglevel error -y \
  -f x11grab -video_size 1600x1000 -i "$DISP" -frames:v 1 "$WORK/frames/$1.png"; }

if wt send-text --help 2>&1 | grep -q -- --no-paste; then NOPASTE=--no-paste; else NOPASTE=; fi
type_line() { wt send-text --pane-id 0 $NOPASTE "$1"; wt send-text --pane-id 0 $NOPASTE $'\r'; }
key_esc()   { wt send-text --pane-id 0 $NOPASTE $'\x1b'; }
key_ctrl()  { # key_ctrl <буква> — Ctrl+<буква> как управляющий байт
  local n
  n=$(printf '%d' "'${1}")
  wt send-text --pane-id 0 $NOPASTE "$(printf "\\$(printf '%03o' $((n - 96)))")"
}
page_up()   { # Ctrl b = PageScrollUp в scroll-режиме (конфиг юзера:184)
  wt send-text --pane-id 0 $NOPASTE $'\x02'; }

kill_gui() {
  pkill -f 'wezterm-gui' 2>/dev/null
  pkill -f 'wezterm-mux-server' 2>/dev/null
  pkill -f 'ffmpeg.*x11grab' 2>/dev/null
  sleep 0.7
  rm -f "$SOCKDIR"/gui-sock-* "$SOCKDIR"/pid 2>/dev/null
  return 0
}
kill_zj() {
  "$ZJ" delete-session --force "$ZJ_SESSION" >/dev/null 2>&1 || true
  pkill -f 'zjcustom' 2>/dev/null || true
  pkill -f 'dsh --profile' 2>/dev/null || true
  return 0
}

# ---------------------------------------------------------------- чистый старт
kill_zj; kill_gui; sleep 1
rm -f "$WORK/geo.jsonl" "$WORK/marks.txt"
"$ZJ" --version > "$WORK/zj-version.txt" 2>&1 || true
log "геометрия ${COLS}x${ROWS}, профиль $PROFILE, сессия $ZJ_SESSION, $($ZJ --version 2>&1 | head -1)"

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

# ------------------------------------------------- layout+config zellij (паритет zz)
# Z_OPTS-зеркало обёртки zz юзера (install-local-resilient-zellij.sh):
# ОПЦИИ СОЗДАНИЯ сессии (шаг 1): mouse-mode false, pane-frames false,
# scroll-buffer 2500, kitty off. Шаг 2 (финальный attach) идёт БЕЗ
# опций — как в zz, где exec attach без Z_OPTS, а мышь решает конфиг.
mkdir -p /root/.config/zellij/layouts
cat > /root/.config/zellij/layouts/dshz-$LABEL.kdl <<KEOF
layout {
    pane command="bash" {
        args "-c" "env | sort > '$WORK/pane-env.txt'; DSH_TUI_GEOMETRY_TRACE='$WORK/geo.jsonl' DSH_TUI_PIN_TRACE=1 dsh --profile '$PROFILE' 2>'$WORK/boot.err'; echo DSH_EXIT_\$?; sleep 300"
    }
}
KEOF
# Конфиг = зеркало ~/.config/zellij/config.kdl юзера (Zorin, продакшн),
# минус машинно-специфичное: default_shell fish (нет на VM),
# default_layout main-desktop (задаётся опцией создания),
# plugins welcome-screen (плагин не нужен), copy_command zellij-copy
# (нет на VM → true = no-op), Run-бинды proxywrapper (бинарня нет).
# Остальное — ДОСЛОВНО: mouse_mode true, env COLORTERM truecolor,
# scroll-кейбинды (Alt q = PageScrollUp; PageUp = HalfPageScrollUp
# последним биндом; телеф. PageUp/PageDown в normal).
cat > /root/.config/zellij/config.kdl <<KEOF
default_mode "normal"
pane_frames false
simplified_ui false
scroll_buffer_size 2500
session_serialization true
serialization_interval 60
osc8_hyperlinks true
mouse_mode true
focus_follows_mouse false
serialize_pane_viewport false
support_kitty_keyboard_protocol false
show_release_notes false
show_startup_tips false
copy_command "true"
copy_on_select true

keybinds {
    normal {
        bind "Ctrl s" { SwitchToMode "Scroll"; }
        bind "Alt d" "Alt D" "Alt в" "Alt В" { SwitchToMode "Locked"; }
        bind "PageUp" { SwitchToMode "Scroll"; HalfPageScrollUp; }
        bind "PageDown" { SwitchToMode "Scroll"; HalfPageScrollDown; }
    }
    locked {
        bind "Alt d" "Alt D" "Alt в" "Alt В" "Ctrl п" "Ctrl g" { SwitchToMode "Normal"; }
    }
    shared_except "locked" {
        unbind "Ctrl h"
        unbind "Ctrl q"
        unbind "Backspace"
        bind "Ctrl p" "Ctrl з" { SwitchToMode "Pane"; }
        bind "Ctrl t" "Ctrl е" { SwitchToMode "Tab"; }
        bind "Ctrl n" "Ctrl т" { SwitchToMode "Resize"; }
        bind "Ctrl y" "Ctrl н" { SwitchToMode "Move"; }
        bind "Ctrl s" "Ctrl ы" { SwitchToMode "Scroll"; }
        bind "Ctrl o" "Ctrl щ" { SwitchToMode "Session"; }
        bind "Ctrl f" "Ctrl а" { NextSwapLayout; }
        bind "Alt g" "Alt п" { NextSwapLayout; }
        bind "Alt q" "Alt й" { PageScrollUp; }
        bind "Alt s" "Alt ы" { ScrollDown; }
        bind "Alt w" "Alt ц" { ScrollUp; }
        bind "Alt a" "Alt ф" { PageScrollDown; }
        bind "Alt n" "Alt т" { NewPane; }
        bind "Alt x" "Alt ч" { CloseFocus; }
    }
    scroll {
        bind "Esc" { SwitchToMode "Normal"; }
        bind "Ctrl s" "Ctrl ы" { SwitchToMode "Normal"; }
        bind "Ctrl c" "Ctrl с" { ScrollToBottom; SwitchToMode "Normal"; }
        bind "j" "Down" "о" { ScrollDown; }
        bind "k" "Up" "л" { ScrollUp; }
        bind "Ctrl f" "PageDown" "Right" "l" "д" "Ctrl а" "f" "а" { PageScrollDown; }
        bind "Ctrl b" "PageUp" "Left" "h" "р" "q" "й" "Ctrl и" "b" "и" { PageScrollUp; }
        bind "PageDown" { HalfPageScrollDown; }
        bind "PageUp" { HalfPageScrollUp; }
        bind "d" "в" { HalfPageScrollDown; }
        bind "u" "г" { HalfPageScrollUp; }
        bind "Alt q" "Alt й" { PageScrollUp; }
        bind "Alt s" "Alt ы" { ScrollDown; }
        bind "Alt w" "Alt ц" { ScrollUp; }
        bind "Alt a" "Alt ф" { PageScrollDown; }
        bind "s" "ы" { SwitchToMode "EnterSearch"; SearchInput 0; }
    }
    search {
        bind "Esc" { SwitchToMode "Normal"; }
        bind "Ctrl c" "Ctrl с" { ScrollToBottom; SwitchToMode "Normal"; }
        bind "j" "Down" "о" { ScrollDown; }
        bind "k" "Up" "л" { ScrollUp; }
        bind "d" "в" { HalfPageScrollDown; }
        bind "u" "г" { HalfPageScrollUp; }
        bind "Alt q" "Alt й" { PageScrollUp; }
        bind "Alt s" "Alt ы" { ScrollDown; }
        bind "Alt w" "Alt ц" { ScrollUp; }
        bind "Alt a" "Alt ф" { PageScrollDown; }
    }
}

env {
    COLORTERM "truecolor"
    FORCE_COLOR "1"
}
KEOF
log "zellij layout + config-зеркало юзера записаны"

# ---------------------------------------------------------------- zellij-бут + dsh
# Шаг 1 — зеркало recreate_from_canon() обёртки zz: create-background
# с Z_OPTS (опции создания живут в сессии; клиент создаёт и выходит).
mark "BOOT_BEGIN"
type_line "$ZJ --config /root/.config/zellij/config.kdl attach --create-background --force-run-commands $ZJ_SESSION options --default-layout dshz-$LABEL --session-serialization true --serialization-interval 60 --pane-frames false --simplified-ui false --mouse-mode false --scroll-buffer-size 2500 --support-kitty-keyboard-protocol false >$WORK/zj-create.out 2>$WORK/zj-create.err; echo ZJ_CREATE_\$?"
# Ждём сессию в list-sessions (runtime-путь зависит от XDG — поллим
# список, бинарно-агностик; иначе шаг 2 attачит пустую и «Bye»).
ZJ_UP=0
for i in $(seq 1 30); do
  if "$ZJ" list-sessions --no-formatting 2>/dev/null | grep -q "^$ZJ_SESSION"; then ZJ_UP=1; break; fi
  sleep 1
done
[ "$ZJ_UP" = 1 ] || log "WARN: сессия $ZJ_SESSION не в list-sessions за ${i}с"
# Шаг 2 — зеркало exec attach zz: БЕЗ options; мышь/клавиатуру решает
# конфиг (mouse_mode true → SGR-репортинг ВКЛ = продакшн).
type_line "$ZJ --config /root/.config/zellij/config.kdl attach $ZJ_SESSION 2>$WORK/zj.err; echo ZJ_EXIT_\$?"
BOOT_OK=0
for i in $(seq 1 90); do
  get_text "$WORK/boot-poll.txt"
  grep -qE '❯|for shortcuts' "$WORK/boot-poll.txt" && { BOOT_OK=1; break; }
  sleep 1
done
if [ "$BOOT_OK" != 1 ]; then
  log "FAIL: dsh в zellij не загрузился (zj.err/boot.err далее)"
  get_text "$WORK/boot-fail.txt"; shot "99-boot-fail"
  cat "$WORK/zj.err" 2>/dev/null | head -5 >> "$WORK/boot-fail.txt"
  cat "$WORK/boot.err" 2>/dev/null | head -10 >> "$WORK/boot-fail.txt"
  kill_zj; kill_gui; kill -INT $FFPID 2>/dev/null; exit 1
fi
mark "BOOT_READY"
log "zellij+dsh бут готов (попытка $i)"
shot "01-boot"
# env панели: что zellij пробрасывает (TERM/TERM_PROGRAM/COLORTERM) —
# ключ гипотезы BSU/ESU (ink isSynchronizedOutputSupported)
if [ -f "$WORK/pane-env.txt" ]; then
  grep -E '^(TERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|COLORTERM|ZELLIJ)=' "$WORK/pane-env.txt" > "$WORK/pane-env-key.txt" || true
  log "env панели: $(tr '\n' ' ' < "$WORK/pane-env-key.txt")"
else
  log "WARN: pane-env.txt не появился (панель жива?)"
fi

# idle-окно 12с с мышью-свипами (гейт живости anim-детектора)
for j in 1 2 3; do
  DISPLAY=$DISP xdotool mousemove --window "$WID" $((WW/2)) $((WH*j/4))
  sleep 2
done
sleep 6
mark "IDLE_WINDOW_END"
shot "02-idle"

# ---------------------------------------------------------------- задача
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
  [ "$N" -gt "$BASE_DOT" ] 2>/dev/null && SEEN_GROW=1
  if [ "$SEEN_GROW" = 1 ] && [ -n "$PREV" ] && [ "$H" = "$PREV" ]; then
    STABLE=$((STABLE + 1))
  else
    STABLE=0
  fi
  PREV=$H
  # LIVE-якорь: стабильность считается только на живом кадре (если чёрн
  # оставил вьюпорт в истории, md5 совпадёт ложно → преждевременный DONE)
  grep -q '╰' "$WORK/task-poll.txt" || STABLE=0
  [ "$STABLE" -ge 2 ] && { DONE=1; break; }
  # ЧЁРН E1: колесо-скролл вьюпорта ПОВЕРХ активного рендера dsh
  # (BSU lock/unlock_renders + viewport-scroll — предсказанный триггер
  # рассинхрона). Вверх ×3 (в историю) → захват вьюпорта+скрин →
  # вниз ×6 (двойной запас) → возврат к поллу.
  DISPLAY=$DISP xdotool mousemove --window "$WID" $((WW/2)) $((WH/2))
  for w in 1 2 3; do DISPLAY=$DISP xdotool click --window "$WID" 4; sleep 0.25; done
  get_text "$WORK/sd-$(printf '%02d' $i).txt"
  shot "sd-$(printf '%02d' $i)"
  for w in 1 2 3 4 5 6; do DISPLAY=$DISP xdotool click --window "$WID" 5; sleep 0.15; done
  sleep 1.2
done
TASK_T1=$(date -u +%s)
[ "$DONE" = 1 ] && mark "TASK_DONE $((TASK_T1-TASK_T0))s" || mark "TASK_TIMEOUT $((TASK_T1-TASK_T0))s"
log "задача: done=$DONE за $((TASK_T1-TASK_T0))с (итерация $i, стабильность $STABLE)"
get_text "$WORK/task-final.txt"; shot "03-task-done"

# ---------------------------------------------------------------- скролл-пила
# Путь юзера: колесо → WezTerm (alt-screen, mouse-reporting off от
# zellij) → стрелки ×alternate_buffer_wheel_scroll_speed → zellij →
# панель (dsh). xdotool click 5/4 = колесо вниз/вверх.
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

# --------------------------------------------- скроллбек ПАНЕЛИ zellij (E1)
# Ctrl s → Scroll-режим; Ctrl b (PageScrollUp) по страницам; захват
# экрана = окно истории. Ранний стоп: контент перестал меняться (верх
# истории достигнут). Выход: Esc → Normal.
mark "SB_BEGIN"
get_text "$WORK/zsb-live.txt"
key_ctrl s; sleep 1.2
get_text "$WORK/zsb-first.txt"
SB_PAGES=0; SB_FROZEN=0; PREV_SB=""
for p in $(seq 1 65); do
  get_text "$WORK/zsb-page-$(printf '%02d' $p).txt"
  CUR=$(md5sum "$WORK/zsb-page-$(printf '%02d' $p).txt" 2>/dev/null | cut -d' ' -f1)
  SB_PAGES=$p
  if [ -n "$PREV_SB" ] && [ "$CUR" = "$PREV_SB" ]; then
    SB_FROZEN=$((SB_FROZEN + 1))
    [ "$SB_FROZEN" -ge 2 ] && break
  else
    SB_FROZEN=0
  fi
  PREV_SB=$CUR
  page_up; sleep 0.7
done
key_esc; sleep 0.8; key_esc
# Сброс к дну: повторный вход+Ctrl c (ScrollToBottom) на случай, если Esc
# оставил нас выше дна (следующие фазы ждут живой кадр у дна)
key_ctrl s; sleep 0.5; key_ctrl c; sleep 0.8
get_text "$WORK/zsb-after.txt"
# Верх истории раньше дна: page 01 = live-кадр (дно), page NN = выше.
# PageScrollUp = rows-1 (tab/mod.rs:7881) → соседние страницы делят РОВНО
# одну строку — НО у верха истории последний PageUp КЛАМПИТСЯ (шаг < 42,
# оверлап больше). Склейка top-down (старейшая первой): (1) выкинуть
# страницы, целиком равные предыдущей (early-stop ловит верх истории
# 2-3 одинаковыми кадрами); (2) page-01 (живой кадр) в историю НЕ входит —
# паритет с контролем (wt get-text --end-line -1 исключает вьюпорт);
# (3) на границе срезать МАКСИМАЛЬНЫЙ совпавший оверлап (норма 1 строка,
# верх истории — до целой страницы), матч k>1 должен содержать непустую
# строку (серия пустых не даёт ложного среза). Дедуп ограничен границами —
# повторы ВНУТРИ страниц (симптом E1) не съедаются.
python3 - "$WORK" <<'PYEOF'
import glob, sys
work = sys.argv[1]
pages = sorted(glob.glob(work + "/zsb-page-*.txt"))
texts = [open(p, encoding="utf-8", errors="replace").read().splitlines() for p in pages]
uniq = [t for i, t in enumerate(texts) if i == 0 or t != texts[i - 1]]
hist = uniq[1:] if len(uniq) > 1 else []  # uniq[0] = page-01 = живой кадр
out = []
for cur in reversed(hist):  # старейшая (верх) → новейшая (низ истории)
    if out and cur:
        best = 0
        for k in range(1, min(len(cur), len(out), 43) + 1):
            if out[-k:] == cur[:k] and (k == 1 or any(s.strip() for s in cur[:k])):
                best = k
        cur = cur[best:]
    out.extend(cur)
open(work + "/scrollback.txt", "w", encoding="utf-8").write("\n".join(out) + "\n")
print("scrollback.txt: страниц=%d (уник %d) строк=%d"
      % (len(texts), len(uniq), len(out)))
PYEOF
PROMPT_ROWS=$(grep -c '❯' "$WORK/scrollback.txt" 2>/dev/null || echo 0)
CORNER_ROWS=$(grep -c '╭' "$WORK/scrollback.txt" 2>/dev/null || echo 0)
{
  echo "pages=$SB_PAGES frozen_hits=$SB_FROZEN"
  echo "prompt_rows=$PROMPT_ROWS corner_rows=$CORNER_ROWS"
  echo "scrollback_lines=$(wc -l < "$WORK/scrollback.txt" 2>/dev/null || echo 0)"
} > "$WORK/zj-sb-counts.txt"
mark "SB_END"
log "скроллбек панели: страниц=$SB_PAGES, ❯=$PROMPT_ROWS, ╭=$CORNER_ROWS"

# ---------------------------------------------------------------- финал/teardown
get_text "$WORK/screen-final.txt"
shot "09-final"
mark "TEARDOWN"
kill_zj
kill_gui
kill -INT $FFPID 2>/dev/null; sleep 2; kill $FFPID 2>/dev/null
log "прогон $LABEL завершён; артефакты в $WORK"
exit 0
