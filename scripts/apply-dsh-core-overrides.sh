#!/usr/bin/env bash
# apply-dsh-core-overrides.sh — применение core-патчей к пакетам @deepseek-ai/*.
#
# В отличие от apply-dsh-overrides.sh (UI-патчи dsh-tui в ОДНОМ профиле),
# core-патчи правят сборку пакетов ВО ВСЕХ местах установки: глобальные копии
# (node_modules внутри пакета @deepseek-ai/dsh во всех nvm-версиях) +
# профильные .pnpm-копии (~/.dsh/profiles/*). Реестр патчей (INI-секции
# [NN-name]): dsh-overrides/core-patches/manifest.conf.
#
# Состояния каждой цели (как у patches/apply-dsh-patch.sh):
#   - md5 == orig_md5 (секция манифеста) -> применить патч
#   - файл содержит marker               -> already applied, skip (идемпотентность)
#   - ни то, ни другое                   -> "unknown": апстрим изменился, НЕ трогать,
#                                          итоговый exit 2
#
# Использование:
#   scripts/apply-dsh-core-overrides.sh            # apply ко всем целям всех патчей
#   scripts/apply-dsh-core-overrides.sh --status   # только список целей + состояние
#   scripts/apply-dsh-core-overrides.sh --revert   # откат из backup/ (в ОБРАТНОМ
#                                                  # порядке секций: 05 -> 01 —
#                                                  # патчи одного файла стекуются)
#   scripts/apply-dsh-core-overrides.sh --only 02  # только секция 02-* (по номеру)
#
# Зависимости: patch, md5sum, node, find (стандартные утилиты).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_DIR="$REPO_DIR/dsh-overrides/core-patches"
MANIFEST="$CORE_DIR/manifest.conf"

fail_loud() {
    echo "FAIL: $*" >&2
    exit 3
}

[ -f "$MANIFEST" ] || fail_loud "нет манифеста: $MANIFEST"

# --- Разбор INI-секций манифеста ---------------------------------------------
# Секции: [NN-name] с ключами package/rel_path/patch/backup/marker/orig_md5.
# Глобальные комментарии (#) и пустые строки игнорируются.
manifest_sections() {
    sed -nE 's/^\[([0-9]+-[^]]+)\]$/\1/p' "$MANIFEST"
}
manifest_value() { # $1 = секция, $2 = ключ
    sed -nE "/^\[$1\]$/,/^\[/{s/^$2=(.*)$/\1/p;}" "$MANIFEST" | head -1
}

ONLY_FILTER=""
case "${1:-apply}" in
    --status) ACTION=status ;;
    --revert) ACTION=revert ;;
    --only)
        ACTION=apply
        ONLY_FILTER="$2"
        [ -n "$ONLY_FILTER" ] || fail_loud "--only требует номер секции (напр. 02)"
        ;;
    *) ACTION=apply ;;
esac

# --- Дискавери целей ---------------------------------------------------------
# 1) Глобальная копия через `command -v dsh`: realpath даёт либо нативный бинарь
#    .../node_modules/@deepseek-ai/dsh/lib/bin.js, либо обёртку ~/.local/bin/dsh
#    (настоящий путь в DSH_CLI= внутри).
# 2) ВСЕ nvm-версии (не только активная — при смене node непропатченная копия
#    вернула бы старое поведение).
# 3) Профильные .pnpm-копии: find ~/.dsh/profiles.
# $1 = package (@deepseek-ai/<pkg>)
#
# Env override DSH_CORE_TARGET_DIR: если задан — короткое замыкание discovery,
# возвращает пути прямо под этим каталогом (для vendored build, напр. atomic-dsh
# build-package.sh). Каталог должен содержать <package>/<rel_path> напрямую
# (как node_modules внутри пакета @deepseek-ai/dsh). Backward-compatible:
# env не задан → обычный auto-discovery (nvm global + profiles).
discover_targets() {
    local dsh_bin cand pkg_root target cli
    if [ -n "${DSH_CORE_TARGET_DIR:-}" ]; then
        target="$DSH_CORE_TARGET_DIR/$1/$2"
        [ -f "$target" ] && printf '%s\n' "$target"
        return
    fi
    dsh_bin="$(realpath "$(command -v dsh)" 2>/dev/null || true)"
    cand=""
    if [ -n "$dsh_bin" ] && [[ "$dsh_bin" == *"node_modules/@deepseek-ai/dsh/lib/bin.js" ]]; then
        cand="$dsh_bin"
    elif [ -n "$dsh_bin" ] && [ -f "$dsh_bin" ]; then
        cli="$(sed -nE 's/^[[:space:]]*DSH_CLI=(\S+).*/\1/p' "$dsh_bin" | head -1)"
        [ -n "$cli" ] && cand="$(realpath "$cli" 2>/dev/null || true)"
    fi
    if [ -n "$cand" ]; then
        pkg_root="${cand%/lib/bin.js}"
        target="$pkg_root/node_modules/$1/$2"
        [ -f "$target" ] && printf '%s\n' "$target"
    fi
    find "$HOME"/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh/node_modules \
        -path "*/$1/$2" -type f 2>/dev/null
    find "$HOME/.dsh/profiles" -path "*/$1/$2" -type f 2>/dev/null
}

target_pkg_root() { # $1 = .../<pkg>/<rel_path> -> .../<pkg>
    # Поднимаемся от целевого файла до ближайшего package.json: rel_path бывает
    # глубже lib/index.js (напр. dist/api/anthropic-messages.js у pi-ai).
    local d
    d="$(dirname "$1")"
    while [ "$d" != "/" ] && [ ! -f "$d/package.json" ]; do
        d="$(dirname "$d")"
    done
    printf '%s\n' "$d"
}

target_version() { # из package.json цели
    local pkg_root
    pkg_root="$(target_pkg_root "$1")"
    grep -m1 '"version"' "$pkg_root/package.json" 2>/dev/null \
        | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || echo "?"
}

# $1 = целевой файл, $2 = marker, $3 = orig_md5 -> unpatched | patched | unknown
current_state() {
    local md5
    md5="$(md5sum "$1" | awk '{print $1}')"
    if [ "$md5" = "$3" ]; then
        echo "unpatched"
    elif grep -qF -- "$2" "$1" 2>/dev/null; then
        echo "patched"
    else
        echo "unknown"
    fi
}

# $1 = секция: проверка записи манифеста + файлов патча/backup
verify_section() {
    local section="$1" pkg rel patch backup marker md5
    pkg="$(manifest_value "$section" package)"
    rel="$(manifest_value "$section" rel_path)"
    patch="$(manifest_value "$section" patch)"
    backup="$(manifest_value "$section" backup)"
    marker="$(manifest_value "$section" marker)"
    md5="$(manifest_value "$section" orig_md5)"
    [ -n "$pkg" ] && [ -n "$rel" ] && [ -n "$patch" ] && [ -n "$backup" ] \
        && [ -n "$marker" ] && [ -n "$md5" ] \
        || fail_loud "секция [$section] неполная в $MANIFEST"
    [ -f "$CORE_DIR/$patch" ] || fail_loud "файл патча отсутствует: $CORE_DIR/$patch"
    [ -f "$CORE_DIR/$backup" ] || fail_loud "backup отсутствует: $CORE_DIR/$backup"
    local want have
    want="$(awk '{print $1}' "$CORE_DIR/$backup.md5" 2>/dev/null || true)"
    have="$(md5sum "$CORE_DIR/$backup" | awk '{print $1}')"
    [ "$want" = "$have" ] || fail_loud "md5 backup не совпадает: $CORE_DIR/$backup повреждён"
}

# --- Действия ----------------------------------------------------------------
OVERALL_RC=0
run_targets() { # $1 = section, $2 = действие (apply|status|revert)
    local section="$1" action="$2"
    local pkg rel patchfile backup marker orig_md5
    pkg="$(manifest_value "$section" package)"
    rel="$(manifest_value "$section" rel_path)"
    patchfile="$CORE_DIR/$(manifest_value "$section" patch)"
    backup="$CORE_DIR/$(manifest_value "$section" backup)"
    marker="$(manifest_value "$section" marker)"
    orig_md5="$(manifest_value "$section" orig_md5)"
    verify_section "$section"

    local t state pkg_root applied=0 skipped=0 failed=0 rc=0
    echo "== $section ($pkg $rel)"
    while IFS= read -r t; do
        [ -n "$t" ] || continue
        state="$(current_state "$t" "$marker" "$orig_md5")"
        case "$action:$state" in
            status:*)
                printf '  [%s] v%-12s %s\n' "$state" "$(target_version "$t")" "$t"
                skipped=$((skipped + 1))
                continue
                ;;
            apply:patched)
                echo "already applied: $t"
                skipped=$((skipped + 1))
                continue
                ;;
            apply:unpatched)
                : # применяем ниже
                ;;
            apply:unknown)
                echo "UNKNOWN (не трогаю, exit 2): $t" >&2
                echo "  файл не совпадает с эталонным md5 и не содержит маркер — апстрим изменился." >&2
                failed=$((failed + 1))
                rc=2
                continue
                ;;
            revert:patched)
                cp "$backup" "$t"
                node --check "$t" 2>/dev/null || fail_loud "восстановленный файл не проходит node --check: $t"
                echo "reverted: $t"
                applied=$((applied + 1))
                continue
                ;;
            revert:unpatched)
                echo "already original: $t"
                skipped=$((skipped + 1))
                continue
                ;;
            revert:unknown)
                echo "REFUSED (unknown, не перезаписываю): $t" >&2
                failed=$((failed + 1))
                rc=2
                continue
                ;;
        esac
        pkg_root="$(target_pkg_root "$t")"
        if ! patch --dry-run -p1 -d "$pkg_root" < "$patchfile" >/dev/null 2>&1; then
            echo "FAILED dry-run (не применён): $t" >&2
            failed=$((failed + 1))
            rc=2
            continue
        fi
        patch -p1 -d "$pkg_root" < "$patchfile" >/dev/null
        # anti-test-theater: синтаксис + маркер после применения
        if ! node --check "$t" 2>/dev/null; then
            cp "$backup" "$t"
            echo "FAILED node --check (восстановлен оригинал): $t" >&2
            failed=$((failed + 1))
            rc=2
            continue
        fi
        if ! grep -qF -- "$marker" "$t"; then
            cp "$backup" "$t"
            echo "FAILED post-check маркера (восстановлен оригинал): $t" >&2
            failed=$((failed + 1))
            rc=2
            continue
        fi
        echo "applied: $t"
        applied=$((applied + 1))
    done < <(discover_targets "$pkg" "$rel" | sort -u)
    if [ "$((applied + skipped + failed))" -eq 0 ]; then
        echo "  (цели не найдены)" >&2
        rc=2
    fi
    echo "  $action: applied/reverted=$applied skipped=$skipped failed=$failed"
    if [ "$rc" -gt "$OVERALL_RC" ]; then OVERALL_RC=$rc; fi
}

# Порядок обхода секций: apply/status — прямой (01..05, стекуемые патчи одного
# файла ложатся в порядке регистрации); revert — ОБРАТНЫЙ (chain): откат 01 при
# живом 05 затёр бы его (backup 01 = престиж, а не пост-01), поэтому 05
# откатывается первым и возвращает пост-01 состояние, которое затем откатывает 01.
if [ "$ACTION" = "revert" ]; then
    SECTIONS="$(manifest_sections | tac)"
else
    SECTIONS="$(manifest_sections)"
fi
for section in $SECTIONS; do
    if [ -n "$ONLY_FILTER" ]; then
        [[ "$section" == "$ONLY_FILTER"-* ]] || continue
    fi
    run_targets "$section" "$ACTION"
done

[ -n "$(manifest_sections)" ] || fail_loud "в манифесте нет секций: $MANIFEST"
echo "----------------------------------------"
echo "итог: exit $OVERALL_RC"
exit "$OVERALL_RC"
