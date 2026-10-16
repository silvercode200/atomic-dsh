#!/usr/bin/env bash
# sync-stack.sh — зеркало dsh-стека ~/.dsh <-> репо (dsh-stack/).
#
# ~/.dsh — живой канон (машины zorin/vmdev синхронизируются отдельным dsh-sync);
# dsh-stack/ в репо — версионируемый бэкап + источник для развёртывания на новой
# машине. Секреты в зеркало не попадают: settings.yaml хранится как
# settings.yaml.example с маской (токен выставляется руками/скриптом развёртки).
#
# Usage:
#   bash scripts/sync-stack.sh          # push: ~/.dsh -> dsh-stack/ (по умолчанию)
#   bash scripts/sync-stack.sh --pull   # pull: dsh-stack/ -> ~/.dsh (ОСТОРОЖНО)
#   bash scripts/sync-stack.sh --check  # diff без записи
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
MIRROR="$REPO/dsh-stack"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
MODE="${1:---push}"

die() { printf 'sync-stack: FATAL: %s\n' "$*" >&2; exit 1; }
[[ -d "$DSH_HOME/profiles/dsh-tui" ]] || die "нет $DSH_HOME/profiles/dsh-tui"
[[ -d "$MIRROR" ]] || die "нет $MIRROR"

# Файлы стека: (источник относительно DSH_HOME) — зеркало под тем же путём.
PATHS=(
  patches/apply-dsh-tools-patches.sh
  patches/caveman-system.json
  patches/README.md
  profiles/dsh-tui/cordis.patch.yml
  .agent-presets/code-lazy/agent.cordis.yml
  .agent-presets/code-lazy/preset.yml
  .agent-presets/code-lazy/skill-search.mjs
  .agent-presets/code-lazy/delegation-mandate.mjs
  AGENTS.md
)

# spot/ — дерево целиком (без runtime), отдельной rsync-командой.
SPOT_EXCLUDES=(--exclude node_modules --exclude logs --exclude .pnpm --exclude '*.log')

sanitize_settings() { # $1=src $2=dst
  python3 - "$1" "$2" <<'PYEOF'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
s = re.sub(r'(Authorization:\s*Bearer\s+)[A-Za-z0-9_\-]{16,}', r'\1***REDACTED***', s)
s = re.sub(r'(apiKey:\s*)[A-Za-z0-9_\-]{16,}', r'\1***REDACTED***', s)
open(dst, 'w').write(s)
PYEOF
}

sync_tree() { # $1=источник-дерево $2=цель-дерево
  mkdir -p "$2"
  rsync -a --delete "${SPOT_EXCLUDES[@]}" "$1" "$2"
}

case "$MODE" in
--check)
  for p in "${PATHS[@]}"; do
    if ! diff -q "$DSH_HOME/$p" "$MIRROR/$p" >/dev/null 2>&1; then
      echo "DIFF: $p"
    fi
  done
  rsync -an --delete "${SPOT_EXCLUDES[@]}" "$DSH_HOME/profiles/dsh-tui/spot/" "$MIRROR/profiles/dsh-tui/spot/" 2>/dev/null | grep -E '^(>|<)' | head -20
  ;;
--pull)
  echo "!! pull перезаписывает живой ~/.dsh из зеркала (кроме settings.yaml)"
  for p in "${PATHS[@]}"; do
    mkdir -p "$DSH_HOME/$(dirname "$p")"
    cp "$MIRROR/$p" "$DSH_HOME/$p"
    echo "pulled: $p"
  done
  sync_tree "$MIRROR/profiles/dsh-tui/spot/" "$DSH_HOME/profiles/dsh-tui/spot/"
  echo "pulled: profiles/dsh-tui/spot/ (дерево)"
  echo "напоминание: settings.yaml не тянется (живёт только в ~/.dsh, с секретом); применить патчи: bash \$DSH_HOME/patches/apply-dsh-tools-patches.sh"
  ;;
--push|*)
  for p in "${PATHS[@]}"; do
    mkdir -p "$MIRROR/$(dirname "$p")"
    cp "$DSH_HOME/$p" "$MIRROR/$p"
    echo "pushed: $p"
  done
  sync_tree "$DSH_HOME/profiles/dsh-tui/spot/" "$MIRROR/profiles/dsh-tui/spot/"
  echo "pushed: profiles/dsh-tui/spot/ (дерево)"
  sanitize_settings "$DSH_HOME/settings.yaml" "$MIRROR/settings.yaml.example"
  echo "pushed: settings.yaml.example (sanitized)"
  ;;
esac
