#!/usr/bin/env bash
# test-series-apply.sh — series-механика apply-скрипта (миграция SUBSYS.FF.B,
# этап 0, TG-DSH-PATCHMIG-20260928 node 1).
#
# Self-contained bash-тест (без сети/GUI/бута TUI): строит сандбокс
# $SANDBOX — копия live-пакета dsh-tui (cp -a от readlink -f: источник —
# pnpm-симлинк, см. memory dsh-pnpm-profile-symlink-cp-trap), патчи из
# $PATCHES_SRC, копия apply-скрипта — и гоняет полный цикл:
#   1) --revert → reverted=<N> skipped=0 failed=0   (live-копия вся в патчах)
#   2) apply    → applied=<N> skipped=0 failed=0 + fork version: +p<N>
#   3) повтор   → applied=0 skipped=<N> failed=0    (идемпотентность)
#   4) Фаза 5: multi-file patch_files — 3 файла для patch 65, marker
#      present после apply, absent после revert
#   5) Фаза 6: --verify I1 pristine-hash gate — exit 0 pristine,
#      exit non-zero tampered manifest
# плюс статические ассерты серии: PATCH-SERIES ↔ *.patch 1:1 (оба
# направления, без дублей), порядок серии = лексикографический (этап 0),
# порядок applied:-строк = порядок серии, reverted: = реверс серии.
#
# Live-профиль НЕ изменяется: из него только читают (cp). Побочный
# ~/.dsh/bin-копиер скрипта уходит в сандбокс через HOME=$SANDBOX/home.
#
# Использование:
#   bash tests/patch-stack/test-series-apply.sh
#   PATCHES_SRC=/tmp/series-frozen/dsh-overrides/patches \
#     bash tests/patch-stack/test-series-apply.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PATCHES_SRC="${PATCHES_SRC:-$REPO/dsh-overrides/patches}"
APPLY_SCRIPT="${APPLY_SCRIPT:-$REPO/scripts/apply-dsh-overrides.sh}"
SANDBOX="${SANDBOX:-/tmp/series-test-sandbox}"
LIVE_PKG_SRC="${LIVE_PKG_SRC:-$HOME/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui}"

FAILURES=0
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "PASS: $*"; }

# --- Сандбокс -----------------------------------------------------------------
# build_sandbox: копирует live-пакет, патчи и apply-скрипт в $SANDBOX так,
# чтобы скрипт, запущенный из $SANDBOX/scripts/, увидел REPO_DIR=$SANDBOX.
# FATAL (exit 2) — инфраструктура теста не собралась; это не продукт-фейл.
build_sandbox() {
  local live_real
  live_real="$(readlink -f "$LIVE_PKG_SRC")"
  if [ ! -d "$live_real/package" ] && [ ! -f "$live_real/package.json" ]; then
    echo "FATAL: live-пакет не найден: $LIVE_PKG_SRC (резолв: $live_real)" >&2
    return 2
  fi
  rm -rf "$SANDBOX"
  mkdir -p "$SANDBOX/scripts" "$SANDBOX/home" "$SANDBOX/dsh-overrides/settings/bin" \
    || { echo "FATAL: mkdir $SANDBOX" >&2; return 2; }
  cp -a "$live_real" "$SANDBOX/pkg" \
    || { echo "FATAL: cp live-пакета ($live_real)" >&2; return 2; }
  cp -a "$PATCHES_SRC" "$SANDBOX/dsh-overrides/patches" \
    || { echo "FATAL: cp патчей ($PATCHES_SRC)" >&2; return 2; }
  cp "$APPLY_SCRIPT" "$SANDBOX/scripts/apply-dsh-overrides.sh" \
    || { echo "FATAL: cp apply-скрипта ($APPLY_SCRIPT)" >&2; return 2; }
  cp "$REPO/dsh-overrides/settings/bin/mcp-stderr-to-log" \
    "$SANDBOX/dsh-overrides/settings/bin/" \
    || { echo "FATAL: cp mcp-stderr-to-log" >&2; return 2; }
  cp "$REPO/dsh-overrides/pristine-manifest.sha256" "$SANDBOX/dsh-overrides/" \
    || { echo "FATAL: cp pristine-manifest.sha256" >&2; return 2; }
  # Pristine snapshots: clean copies of files that patch -R cannot fully
  # revert (overlapping patches cause context shift). Used by --verify to
  # restore MODIFIED files to upstream state after revert_all.
  if [ -d "$REPO/dsh-overrides/pristine-snapshots" ]; then
    cp -a "$REPO/dsh-overrides/pristine-snapshots" "$SANDBOX/dsh-overrides/" \
      || { echo "FATAL: cp pristine-snapshots" >&2; return 2; }
  fi
}

# run_apply: прогоняет сандбокс-копию скрипта (HOME и TUI_BASE — сандбокс).
# $1 = режим ('' | '--revert'), $2 = имя логфайла относительно $SANDBOX.
run_apply() {
  local mode="$1" logf="$SANDBOX/$2"
  if [ -n "$mode" ]; then
    env HOME="$SANDBOX/home" TUI_BASE="$SANDBOX/pkg" \
      bash "$SANDBOX/scripts/apply-dsh-overrides.sh" "$mode" >"$logf" 2>&1
  else
    env HOME="$SANDBOX/home" TUI_BASE="$SANDBOX/pkg" \
      bash "$SANDBOX/scripts/apply-dsh-overrides.sh" >"$logf" 2>&1
  fi
}

build_sandbox || exit 2

# Ожидаемое число патчей стека = *.patch в источнике (этап 0: 75).
shopt -s nullglob
src_patches=("$PATCHES_SRC"/*.patch)
shopt -u nullglob
expected=${#src_patches[@]}
if [ "$expected" -eq 0 ]; then
  echo "FATAL: в $PATCHES_SRC нет *.patch" >&2
  exit 2
fi
echo "сандбокс: $SANDBOX — источник патчей: $PATCHES_SRC, патчей: $expected"

# --- Фаза 1: статические ассерты PATCH-SERIES ---------------------------------
series_file="$SANDBOX/dsh-overrides/patches/PATCH-SERIES"
SERIES=()
if [ -f "$series_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    SERIES+=("$line")
  done < "$series_file"
  pass "PATCH-SERIES существует, записей: ${#SERIES[@]}"
else
  fail "PATCH-SERIES не найден: $series_file (порядок обязан быть явным, glob-fallback запрещён)"
fi

if [ "${#SERIES[@]}" -gt 0 ]; then
  # Каждая запись серии существует как *.patch-файл.
  for name in "${SERIES[@]}"; do
    if [ ! -f "$SANDBOX/dsh-overrides/patches/$name" ]; then
      fail "в серии запись без файла: $name"
    fi
  done
  # Каждый *.patch числится в серии; дублей записей нет (1:1 в обе стороны).
  declare -A series_set=()
  for name in "${SERIES[@]}"; do series_set["$name"]=1; done
  for pf in "${src_patches[@]}"; do
    b="$(basename "$pf")"
    if [ -z "${series_set[$b]:-}" ]; then
      fail "*.patch не числится в серии: $b"
    fi
  done
  if [ "${#SERIES[@]}" -ne "${#series_set[@]}" ]; then
    fail "в серии дублирующиеся записи: строк ${#SERIES[@]}, уникальных ${#series_set[@]}"
  fi
  if [ "${#series_set[@]}" -eq "$expected" ]; then
    pass "серия ↔ *.patch 1:1 (${#SERIES[@]} записей)"
  fi
  # Этап 1 (SUBSYS.FF.B): лексикографический ассерт снят — имена более
  # не лексикографичны порядку применения. 1:1 проверяется выше.
  # series-order.txt нужен Фазе 3 (порядок applied = порядок серии).
  printf '%s\n' "${SERIES[@]}" > "$SANDBOX/series-order.txt"
  pass "порядок серии = явный (SUBSYS.FF.B, этап 1)"
fi

# --- Фаза 2: --revert на копии live (всё в патчах) -----------------------------
run_apply --revert revert.log
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "apply --revert exit 0"
else
  fail "apply --revert exit $rc (лог: $SANDBOX/revert.log)"
fi
if grep -qx "reverted=$expected skipped=0 failed=0" "$SANDBOX/revert.log"; then
  pass "revert: reverted=$expected skipped=0 failed=0"
else
  fail "revert summary ≠ reverted=$expected skipped=0 failed=0 — фактически: $(grep 'reverted=' "$SANDBOX/revert.log" | tail -1)"
fi
if [ "${#SERIES[@]}" -gt 0 ]; then
  # Порядок отката = строгий реверс серии.
  grep '^reverted: ' "$SANDBOX/revert.log" | sed 's/^reverted: //' > "$SANDBOX/reverted-order.txt"
  printf '%s\n' "${SERIES[@]}" | tac > "$SANDBOX/series-reversed.txt"
  if diff -q "$SANDBOX/reverted-order.txt" "$SANDBOX/series-reversed.txt" >/dev/null; then
    pass "порядок revert = реверс серии"
  else
    fail "порядок revert ≠ реверс серии (diff: $SANDBOX/revert-vs-series.diff)"
    diff -u "$SANDBOX/reverted-order.txt" "$SANDBOX/series-reversed.txt" > "$SANDBOX/revert-vs-series.diff" || true
  fi
fi

# --- Фаза 3: apply всей серии ---------------------------------------------------
run_apply '' apply.log
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "apply exit 0"
else
  fail "apply exit $rc (лог: $SANDBOX/apply.log)"
fi
if grep -qx "applied=$expected skipped=0 failed=0" "$SANDBOX/apply.log"; then
  pass "apply: applied=$expected skipped=0 failed=0"
else
  fail "apply summary ≠ applied=$expected skipped=0 failed=0 — фактически: $(grep '^applied=' "$SANDBOX/apply.log" | tail -1)"
fi
if grep -q "fork version: +p$expected" "$SANDBOX/apply.log"; then
  pass "fork version: +p$expected"
else
  fail "fork version ≠ +p$expected — фактически: $(grep 'fork version' "$SANDBOX/apply.log" | tail -1)"
fi
fork_file="$SANDBOX/pkg/lib/types/components/forkVersion.js"
if [ -f "$fork_file" ] && grep -qx "export const patch = $expected;" "$fork_file"; then
  pass "forkVersion.js: export const patch = $expected;"
else
  fail "forkVersion.js ≠ patch = $expected — фактически: $(grep 'export const patch' "$fork_file" 2>/dev/null | tail -1)"
fi
if [ "${#SERIES[@]}" -gt 0 ]; then
  # Порядок применения = порядок серии (не сортировка на месте).
  grep '^applied: ' "$SANDBOX/apply.log" | sed 's/^applied: //' > "$SANDBOX/applied-order.txt"
  if diff -q "$SANDBOX/applied-order.txt" "$SANDBOX/series-order.txt" >/dev/null; then
    pass "порядок applied = порядок серии"
  else
    fail "порядок applied ≠ порядок серии (diff: $SANDBOX/apply-vs-series.diff)"
    diff -u "$SANDBOX/applied-order.txt" "$SANDBOX/series-order.txt" > "$SANDBOX/apply-vs-series.diff" || true
  fi
fi

# --- Фаза 4: повторный apply (идемпотентность) ---------------------------------
run_apply '' apply2.log
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "повторный apply exit 0"
else
  fail "повторный apply exit $rc (лог: $SANDBOX/apply2.log)"
fi
if grep -qx "applied=0 skipped=$expected failed=0" "$SANDBOX/apply2.log"; then
  pass "повтор: applied=0 skipped=$expected failed=0"
else
  fail "повтор summary ≠ applied=0 skipped=$expected failed=0 — фактически: $(grep '^applied=' "$SANDBOX/apply2.log" | tail -1)"
fi

# --- Фаза 5: multi-file patch_files validation --------------------------------
# patch 65: 3 файла в # Files header (effectsCatalog.js, hubSettings.js,
# SettingsExamples.js). Все три — CREATED (не в upstream).
echo "=== Phase 5: multi-file patch_files ==="

MULTI_PATCH="HB.02.1-settings-effects-explanations.patch"

# Извлечение patch_files(), marker_file(), MARKERS из sandbox-копии apply-скрипта.
# eval определяет функции; PATCHES_DIR указывает на sandbox-патчи.
eval "$(sed -n '/^declare -A MARKERS=(/,/^)/p' "$SANDBOX/scripts/apply-dsh-overrides.sh")"
eval "$(sed -n '/^marker_file()/,/^}/p' "$SANDBOX/scripts/apply-dsh-overrides.sh")"
eval "$(sed -n '/^patch_files()/,/^}/p' "$SANDBOX/scripts/apply-dsh-overrides.sh")"
PATCHES_DIR="$SANDBOX/dsh-overrides/patches"

# 5a: patch_files возвращает 3 уникальных файла для multi-file патча.
mapfile -t p65_files < <(patch_files "$MULTI_PATCH")
if [ "${#p65_files[@]}" -eq 3 ]; then
  pass "patch_files($MULTI_PATCH) = ${#p65_files[@]} файлов (3 ожидаемо)"
else
  fail "patch_files($MULTI_PATCH) = ${#p65_files[@]} файлов (ожидаемо 3)"
fi

# 5b: marker присутствует в ≥1 файле после apply (sandbox пропатчен Фазами 3/4).
p65_marker="${MARKERS[$MULTI_PATCH]:-}"
if [ -z "$p65_marker" ]; then
  fail "нет маркера для $MULTI_PATCH в MARKERS"
else
  marker_found=0
  for pf in "${p65_files[@]}"; do
    if [ -f "$SANDBOX/pkg/$pf" ] && grep -qF -- "$p65_marker" "$SANDBOX/pkg/$pf"; then
      marker_found=1
      break
    fi
  done
  if [ "$marker_found" -eq 1 ]; then
    pass "marker в ≥1 файле после apply ($MULTI_PATCH)"
  else
    fail "marker не найден ни в одном из ${#p65_files[@]} файлов после apply"
  fi
fi

# 5c: revert → marker отсутствует во ВСЕХ файлах.
# revert_all: маркер отсутствует во ВСЕХ файлах → skip (multi-file semantics).
run_apply --revert revert_p5.log
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "Phase5 revert exit 0"
else
  fail "Phase5 revert exit $rc (лог: $SANDBOX/revert_p5.log)"
fi

if [ -n "$p65_marker" ]; then
  marker_absent=1
  for pf in "${p65_files[@]}"; do
    if [ -f "$SANDBOX/pkg/$pf" ] && grep -qF -- "$p65_marker" "$SANDBOX/pkg/$pf"; then
      marker_absent=0
      break
    fi
  done
  if [ "$marker_absent" -eq 1 ]; then
    pass "marker отсутствует во всех ${#p65_files[@]} файлах после revert"
  else
    fail "marker найден в файле после revert (должен быть удалён)"
  fi
fi

# --- Фаза 6: --verify I1 pristine-hash gate -----------------------------------
# --verify: revert_all → verify_pristine(sha256 vs manifest) → apply_all.
# Exit 0 = pristine OK, non-zero = mismatch.
echo "=== Phase 6: --verify I1 pristine-hash gate ==="

# 6a: --verify exit 0 (sandbox unpatched после Phase 5c; revert → все skipped;
# sha256 match → PRISTINE OK; re-apply).
echo "Phase 6a: --verify pristine (ожидаемо exit 0, ~3 мин)..."
run_apply --verify verify_p6a.log
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "--verify exit 0 (pristine OK)"
else
  fail "--verify exit $rc (ожидаемо 0 — pristine; лог: $SANDBOX/verify_p6a.log)"
fi
if grep -q "PRISTINE OK" "$SANDBOX/verify_p6a.log"; then
  pass "--verify: PRISTINE OK в логе"
else
  fail "--verify: PRISTINE OK не найдено в логе"
fi

# 6b: RED fixture — tamper manifest → --verify exit non-zero (MISMATCH).
echo "Phase 6b: --verify tampered manifest (ожидаемо exit non-zero, ~3 мин)..."
MANIFEST_SANDBOX="$SANDBOX/dsh-overrides/pristine-manifest.sha256"
cp "$MANIFEST_SANDBOX" "$SANDBOX/manifest.bak"
# Заменить первый sha256 hash на bogus (64 нуля — валидный hex, но не реальный).
sed -i '0,/^[0-9a-f]\{64\}/s/^[0-9a-f]\{64\}/0000000000000000000000000000000000000000000000000000000000000000/' "$MANIFEST_SANDBOX"

run_apply --verify verify_p6b.log
rc=$?
if [ "$rc" -ne 0 ]; then
  pass "--verify tampered exit $rc (non-zero — MISMATCH обнаружен)"
else
  fail "--verify tampered exit 0 (ожидаемо non-zero — MISMATCH не пойман)"
fi
if grep -q "PRISTINE FAIL" "$SANDBOX/verify_p6b.log"; then
  pass "--verify tampered: PRISTINE FAIL в логе"
else
  fail "--verify tampered: PRISTINE FAIL не найдено в логе"
fi

# 6c: восстановить манифест (оригинал из бэкапа).
cp "$SANDBOX/manifest.bak" "$MANIFEST_SANDBOX"
pass "manifest restored после RED fixture"

# --- Фаза 7: partial-apply detection (CRITICAL #1 regression test) ------------
# State: all patches applied (after Phase 6a/6b --verify re-apply).
# Simulate partial state: delete marker_file (SettingsExamples.js) for patch 65.
# marker_file() is the single file where the marker is guaranteed to appear.
# NEW code (marker in marker_file → skip): marker_file missing → marker absent
#   → NOT "already applied" → patch --forward attempted.
# OLD code (marker in ≥1 file → skip): marker still in hubSettings.js → skip
#   → partial state NOT detected. FAIL.
echo "=== Phase 7: partial-apply detection ==="

# marker_file for patch 65 is SettingsExamples.js (from marker_file() function).
p65_mfile="lib/types/components/SettingsExamples.js"

if [ -z "${p65_marker:-}" ]; then
  fail "Phase7: нет маркера для $MULTI_PATCH"
elif [ "${#p65_files[@]}" -ne 3 ]; then
  fail "Phase7: patch_files($MULTI_PATCH) = ${#p65_files[@]} файлов (ожидаемо 3)"
else
  # Baseline: marker present in marker_file AND all 3 files exist.
  baseline_ok=1
  if [ ! -f "$SANDBOX/pkg/$p65_mfile" ] || ! grep -qF -- "$p65_marker" "$SANDBOX/pkg/$p65_mfile"; then
    baseline_ok=0
  fi
  for pf in "${p65_files[@]}"; do
    [ -f "$SANDBOX/pkg/$pf" ] || baseline_ok=0
  done
  if [ "$baseline_ok" -eq 1 ]; then
    pass "Phase7 baseline: marker in marker_file + all 3 files exist"
  else
    fail "Phase7 baseline: state not clean (marker missing or file absent)"
  fi

  # Backup marker_file, then delete it (simulate partial-apply: marker_file missing).
  cp "$SANDBOX/pkg/$p65_mfile" "$SANDBOX/p7-mfile-backup"
  rm -f "$SANDBOX/pkg/$p65_mfile"

  if [ ! -f "$SANDBOX/pkg/$p65_mfile" ]; then
    pass "Phase7: deleted $p65_mfile (partial state — marker_file missing)"
  else
    fail "Phase7: failed to delete $p65_mfile"
  fi

  # Verify: marker still present in another file (hubSettings.js) — proves
  # OLD code (marker in ≥1 file → skip) would skip patch 65.
  marker_in_other=0
  for pf in "${p65_files[@]}"; do
    if [ "$pf" != "$p65_mfile" ] && [ -f "$SANDBOX/pkg/$pf" ] \
      && grep -qF -- "$p65_marker" "$SANDBOX/pkg/$pf"; then
      marker_in_other=1
      break
    fi
  done
  if [ "$marker_in_other" -eq 1 ]; then
    pass "Phase7: marker still in another file (OLD code would skip — partial NOT detected)"
  else
    fail "Phase7: marker absent from all files (unexpected — state not partial)"
  fi

  # Run apply — NEW pre-check: marker absent in marker_file → NOT "already applied"
  # → patch --forward attempted. May succeed (re-create marker_file) or fail.
  run_apply '' apply_p7.log
  rc=$?

  # Assert: patch 65 was NOT skipped ("already applied" absent for 65).
  if grep -q "already applied: $MULTI_PATCH" "$SANDBOX/apply_p7.log"; then
    fail "Phase7: patch 65 was SKIPPED (partial state NOT detected — old marker-only bug)"
  else
    pass "Phase7: patch 65 NOT skipped (partial state detected by marker_file check)"
  fi

  # Assert: patch --forward was attempted for 65 (either "applied" or "FAILED").
  if grep -q "applied: $MULTI_PATCH\|FAILED to apply: $MULTI_PATCH" "$SANDBOX/apply_p7.log"; then
    pass "Phase7: patch --forward attempted for 65 (re-apply or fail)"
  else
    fail "Phase7: no apply attempt for 65 (лог: $SANDBOX/apply_p7.log)"
  fi

  # Cleanup: remove .rej files if any, then revert + re-apply to restore state.
  find "$SANDBOX/pkg" -name '*.rej' -delete 2>/dev/null || true
  run_apply --revert revert_p7.log 2>/dev/null || true
  run_apply '' reapply_p7.log 2>/dev/null || true
fi

# --- Фаза 6c: file drift fixture (MAJOR #5) -----------------------------------
echo "=== Phase 6c: file drift fixture ==="

# Get to pristine state.
run_apply --revert revert_p6c.log
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "Phase6c revert exit 0"
else
  fail "Phase6c revert exit $rc (лог: $SANDBOX/revert_p6c.log)"
fi

# Pick first sha256 file from manifest (a modified file, not CREATED).
drift_file="$(grep -m1 '^[0-9a-f]\{64\}' "$MANIFEST_SANDBOX" | awk '{print $2}')"
if [ -z "$drift_file" ]; then
  fail "Phase6c: no sha256 file in manifest"
elif [ ! -f "$SANDBOX/pkg/$drift_file" ]; then
  fail "Phase6c: file not found: $drift_file"
else
  printf '\n// DRIFT TEST\n' >> "$SANDBOX/pkg/$drift_file"
  pass "Phase6c: drift injected into $drift_file"

  # --verify → exit non-zero (MISMATCH).
  run_apply --verify verify_p6c.log
  rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "Phase6c: --verify exit $rc (non-zero — drift detected)"
  else
    fail "Phase6c: --verify exit 0 (expected non-zero — drift NOT detected)"
  fi
  if grep -q "PRISTINE FAIL" "$SANDBOX/verify_p6c.log"; then
    pass "Phase6c: PRISTINE FAIL in log"
  else
    fail "Phase6c: PRISTINE FAIL not in log"
  fi
fi

# --- Фаза 6d: missing file fixture (MAJOR #5) ---------------------------------
echo "=== Phase 6d: missing file fixture ==="

# Get to pristine state (after 6c --verify re-applied everything).
run_apply --revert revert_p6d.log
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "Phase6d revert exit 0"
else
  fail "Phase6d revert exit $rc (лог: $SANDBOX/revert_p6d.log)"
fi

# Pick first sha256 file from manifest.
missing_file="$(grep -m1 '^[0-9a-f]\{64\}' "$MANIFEST_SANDBOX" | awk '{print $2}')"
if [ -z "$missing_file" ]; then
  fail "Phase6d: no sha256 file in manifest"
elif [ ! -f "$SANDBOX/pkg/$missing_file" ]; then
  fail "Phase6d: file not found: $missing_file"
else
  # Backup, then delete.
  cp "$SANDBOX/pkg/$missing_file" "$SANDBOX/missing-file-backup"
  rm "$SANDBOX/pkg/$missing_file"
  pass "Phase6d: deleted $missing_file"

  # --verify → exit non-zero (MISSING).
  run_apply --verify verify_p6d.log
  rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "Phase6d: --verify exit $rc (non-zero — missing file detected)"
  else
    fail "Phase6d: --verify exit 0 (expected non-zero — missing file NOT detected)"
  fi
  if grep -q "PRISTINE FAIL" "$SANDBOX/verify_p6d.log"; then
    pass "Phase6d: PRISTINE FAIL in log"
  else
    fail "Phase6d: PRISTINE FAIL not in log"
  fi

  # Restore the deleted file.
  cp "$SANDBOX/missing-file-backup" "$SANDBOX/pkg/$missing_file"
fi

# Cleanup: revert + apply (restore clean state).
run_apply --revert cleanup_revert.log
run_apply '' cleanup_apply.log
pass "cleanup: revert + apply (state restored)"

# --- Итог ----------------------------------------------------------------------
echo "----------------------------------------"
if [ "$FAILURES" -eq 0 ]; then
  echo "OK: test-series-apply (источник: $PATCHES_SRC, патчей: $expected)"
  exit 0
fi
echo "FAILED: $FAILURES провал(ов) — сандбокс: $SANDBOX"
exit 1
