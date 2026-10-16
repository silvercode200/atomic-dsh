#!/usr/bin/env bash
# vm-install.sh — зависимости живого WezTerm-стенда на Colab VM.
# Идемпотентно: повторный прогон = быстрые проверки. Запускается НА VM.
#
# Ставит: WezTerm 20240203-110809-5046fc22 (ВЕРСИЯ ЮЗЕРА) из GitHub .deb,
# xdotool (мышь/колесо), JetBrains Mono (дефолтный шрифт WezTerm юзера),
# проверяет python3-PIL для кадр-анализа.
set -uo pipefail
log() { echo "[wezterm-live-install] $*"; }

BASE=/root/wezterm-live
mkdir -p "$BASE"
WT_VER="20240203-110809-5046fc22"

# --- Ubuntu-версия → правильный deb -----------------------------------------
source /etc/os-release
case "$VERSION_ID" in
  22.04) DEB_TAG="Ubuntu22.04" ;;
  20.04) DEB_TAG="Ubuntu20.04" ;;
  *) DEB_TAG="Ubuntu22.04" ;;  # ближайший бинарь; wezterm статичен по glibc-минимуму
esac
log "Ubuntu $VERSION_ID → deb $DEB_TAG"

# --- WezTerm -----------------------------------------------------------------
if command -v wezterm >/dev/null 2>&1 && wezterm --version 2>/dev/null | grep -q "$WT_VER"; then
  log "wezterm уже $(wezterm --version) — skip"
else
  URL="https://github.com/wezterm/wezterm/releases/download/${WT_VER}/wezterm-${WT_VER}.${DEB_TAG}.deb"
  log "загрузка $URL"
  curl -fsSL -o "$BASE/wezterm.deb" "$URL" || { log "FAIL: download wezterm"; exit 1; }
  dpkg -i "$BASE/wezterm.deb" 2>/dev/null || apt-get install -y -f ./... 2>/dev/null
  dpkg -i "$BASE/wezterm.deb" 2>&1 | tail -1
  apt-get install -y -f 2>&1 | tail -1
  command -v wezterm >/dev/null 2>&1 || { log "FAIL: wezterm не встал"; exit 1; }
  log "wezterm $(wezterm --version) установлен"
fi

# --- xdotool ------------------------------------------------------------------
if command -v xdotool >/dev/null 2>&1; then
  log "xdotool уже есть"
else
  apt-get update -qq 2>&1 | tail -1
  apt-get install -y -qq xdotool 2>&1 | tail -1
  command -v xdotool >/dev/null 2>&1 || { log "FAIL: xdotool"; exit 1; }
fi

# --- JetBrains Mono (дефолт юзера) --------------------------------------------
if fc-list 2>/dev/null | grep -qi 'JetBrains Mono'; then
  log "JetBrains Mono уже есть"
else
  apt-get install -y -qq fonts-jetbrains-mono 2>&1 | tail -1
  if ! fc-list 2>/dev/null | grep -qi 'JetBrains Mono'; then
    log "apt не дал JetBrains Mono — тяну ttf из GitHub JetBrains"
    curl -fsSL -o "$BASE/jbmono.zip" \
      'https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip' \
      && mkdir -p /usr/share/fonts/truetype/jetbrains && \
      unzip -o -j "$BASE/jbmono.zip" 'fonts/ttf/JetBrainsMono-Regular.ttf' 'fonts/ttf/JetBrainsMono-Medium.ttf' \
        -d /usr/share/fonts/truetype/jetbrains >/dev/null && fc-cache -f >/dev/null 2>&1
  fi
  fc-list | grep -ci 'JetBrains Mono' | grep -q '^0$' && { log "FAIL: шрифт не встал"; exit 1; } || true
  log "JetBrains Mono: $(fc-list | grep -ci 'JetBrains Mono') начертаний"
fi

# --- ffmpeg / Xvfb (обычно уже в образе) --------------------------------------
for tool in ffmpeg Xvfb; do
  command -v $tool >/dev/null 2>&1 || { log "FAIL: $tool отсутствует"; exit 1; }
done
log "ffmpeg + Xvfb на месте"

# --- python3 + PIL (кадр-диф анализ) ------------------------------------------
python3 -c 'import PIL.Image' 2>/dev/null || pip install -q pillow 2>&1 | tail -1
python3 -c 'import PIL.Image' 2>/dev/null && log "PIL готов" || { log "WARN: PIL нет — кадр-диф будет пропущен"; }

log "OK: стенд-зависимости готовы"
exit 0
