#!/usr/bin/env bash
# check-dsh-tui-update.sh — проверка обновлений dsh-TUI для Claude Code SessionStart.
#
# Сравнивает установленную версию @deepseek-harness-tui/dsh-tui с:
#   - npm view version (дистрибутив)
#   - GitHub releases/latest tag (ccch1mneyyy/dsh-TUI)
# Печатает строку обновления только при найденной более новой версии.
# При равенстве — краткий статус; при отсутствии сети/ошибках — молча (exit 0).
#
# Идемпотентен и безопасен для SessionStart: только чтение, никаких записей.

set -u

# --- Пути (полные, не зависят от PATH сессии) ---
PKG_JSON="$HOME/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-harness-tui/dsh-tui/package.json"
NPM_BIN="$HOME/.nvm/versions/node/v22.23.2/bin/npm"
GH_URL="https://api.github.com/repos/ccch1mneyyy/dsh-TUI/releases/latest"
TIMEOUT_S=8

# --- Нормализация и сравнение версий ---

# core_of: числовое ядро semver (без префикса v и без pre-release суффикса).
#   v0.10.0-beta.3 -> 0.10.0 ; 0.9.3 -> 0.9.3
core_of() {
  local v="$1"
  v="${v#v}"
  v="${v#V}"
  printf '%s' "${v%%-*}"
}

# ver_gt: выход 0, если числовое ядро $1 строго больше ядра $2.
# Сравнение посегментное; недостающие сегменты считаются 0.
# Pre-release суффикс (-beta.N) на решение не влияет: обновление триггерим
# только когда ядро выросло — тогда суффикс не важен.
ver_gt() {
  local a b i x y
  a="$(core_of "$1")"
  b="$(core_of "$2")"
  IFS='.' read -r -a A <<< "$a"
  IFS='.' read -r -a B <<< "$b"
  for i in 0 1 2 3; do
    x="${A[$i]:-0}"
    y="${B[$i]:-0}"
    if [ "$x" -gt "$y" ] 2>/dev/null; then
      return 0
    elif [ "$x" -lt "$y" ] 2>/dev/null; then
      return 1
    fi
  done
  return 1
}

# --- Сбор данных (каждый источник опционален; timeout гасит зависания) ---

# Установленная версия. Нет пакета — нечего проверять, молча выходим.
[ -f "$PKG_JSON" ] || exit 0
installed="$(grep -m1 '"version"' "$PKG_JSON" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
[ -n "$installed" ] || exit 0

npm_ver=""
gh_ver=""
checked=0

# npm view: вывод может содержать warnings (NO_COLOR) — берём последнюю строку.
if [ -x "$NPM_BIN" ]; then
  npm_ver="$(timeout "$TIMEOUT_S" "$NPM_BIN" view @deepseek-harness-tui/dsh-tui version 2>/dev/null | tail -n1 | tr -d '[:space:]')"
  [ -n "$npm_ver" ] && checked=1
fi

# GitHub releases/latest: вытаскиваем поле "tag_name" (формат: v0.10.0-beta.3).
gh_ver="$(timeout "$TIMEOUT_S" curl -s "$GH_URL" 2>/dev/null | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | cut -d'"' -f4)"
[ -n "$gh_ver" ] && checked=1

# Нет сети / оба источника недоступны — молчим (SessionStart-safe).
[ "$checked" -eq 1 ] || exit 0

# --- Определяем самую новую из доступных удалённых версий ---
newest="$installed"
for cand in "$npm_ver" "$gh_ver"; do
  [ -n "$cand" ] || continue
  if ver_gt "$cand" "$newest"; then
    newest="$cand"
  fi
done

# --- Вывод ---
if ver_gt "$newest" "$installed"; then
  echo "dsh-TUI: есть обновление ${installed} → ${newest}"
else
  echo "dsh-TUI up to date (${installed})"
fi

exit 0
