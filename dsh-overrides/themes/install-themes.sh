#!/usr/bin/env bash
# Установка сгенерированных dsh-tui тем в ~/.dsh-tui/themes/.
# Идемпотентно: mkdir -p + cp -f. НЕ трогает ~/.dsh-tui/theme.json
# (активную тему пользователя) — копирует только файлы тем.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.dsh-tui/themes"

if [ ! -d "${DIR}/generated" ] || ! ls "${DIR}"/generated/*.json >/dev/null 2>&1; then
  echo "нет ${DIR}/generated/*.json — сначала запусти: node ${DIR}/generate-themes.mjs" >&2
  exit 1
fi

mkdir -p "${DEST}"
count=0
for f in "${DIR}"/generated/*.json; do
  cp -f "$f" "${DEST}/"
  count=$((count + 1))
done

echo "installed ${count} themes -> ${DEST}"
echo "active theme file (~/.dsh-tui/theme.json) not touched"
