#!/usr/bin/env bash
# colab-dsh-live-check.sh — драйвер живого TUI-прогона dsh на Colab VM.
#
# Конвейер: colab-dsh-up.sh (деплой/health, идемпотентно) → socctl program
# (tests/colab/dsh-tui-live.yaml, lane colab, background) → poll program-status
# → выгрузка кадров с VM → reports/colab-live-<target>-<UTC>/ (verdict.json,
# job-status, frames/). EXIT 0 ТОЛЬКО при полном прохождении всех тестов
# (внешний факт: socctl program-status по job-id возвращает passed по всем
# тестам; verdict.json содержит verdict + grep-пробы кадров, где grep
# 'effects' находит строку в slash-меню кадра); красный кадр-массив — это
# не unit-тесты, а реальный TUI на реальной VM;
# red-прогон (упавшие ассерты баг-детекторов) = EXIT 1 с verdict.reproduced
# по каждому багу (не маскируем); инфраструктурный сбой = EXIT 2.
#
# target-семантика (red-матрица):
#   pristine            npm-пакет 0.10.0-beta.4 без патчей: upstream-референс;
#                       slash_menu_effects обязан упасть (команды effects нет).
#   current             патч-стек HEAD: баг-детекторы 1-5 падают = баги юзера
#                       воспроизведены на Colab (reproduced: true).
#   patches:<git-ref>   патч-стек указанного коммита.
#
# Использование:
#   scripts/colab-dsh-live-check.sh [--target pristine|current|patches:<ref>]
#                                   [--label red|green|<tag>] [--skip-deploy]
#                                   [--max-wait 1200] [--fake-model]
#   bash scripts/colab-dsh-live-check.sh; echo EXIT=$?
# --label: суффикс каталога отчёта reports/colab-<label>-<UTC>/ вместо
#   colab-live-<target>-<UTC>/ (target-имя сanитизируется: ':' → '_').
# --fake-model: проброс одноимённого флага в colab-dsh-up.sh (действует
#   только БЕЗ --skip-deploy): деплой поднимает dsh-fake-llm на VM
#   (127.0.0.1:8787) и переключает agent-default-model на fake-провайдер —
#   режим для сьюта tests/colab/dsh-tui-fake.yaml (ноль реальных токенов).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COLABCTL="$HOME/xeon-Programms/MCP/SOC/autotestvm/gcolab/bin/colabctl"
SOCCTL="$HOME/xeon-Programms/MCP/SOC/scripts/socctl.sh"
PROGRAM_YAML="$REPO_DIR/tests/colab/dsh-tui-live.yaml"
VM_FRAMES_DIR="/root/dsh-live-frames"
# Дефолтный набор баг-детекторов для verdict.reproduced (v1-сьют).
DEFAULT_DETECTORS="footer_bottom_gap,status_single_line,ctx_value_no_dup,input_at_bottom,no_layout_jitter,slash_menu_effects"

TARGET="current"
LABEL=""
DETECTORS="$DEFAULT_DETECTORS"
SKIP_DEPLOY=0
# 2400с = бюджет golden-сьюта dsh-tui-inline v5 (прогон 3: 2398.9с; прогон 5:
# 1677.7с — драйвер с дефолтом 1200с сдавался до фактического конца программы).
MAX_WAIT=2400
FAKE_MODEL=0

die() { echo "DRIVER FAIL: $*" >&2; exit 2; }
log() { echo "[colab-dsh-live-check] $*"; }

usage() { sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target требует значение}"; shift 2 ;;
    --label) LABEL="${2:?--label требует значение}"; shift 2 ;;
    --suite) PROGRAM_YAML="${2:?--suite требует путь}"; shift 2 ;;
    --detectors) DETECTORS="${2:?--detectors требует список}"; shift 2 ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    --max-wait) MAX_WAIT="${2:?}"; shift 2 ;;
    --fake-model) FAKE_MODEL=1; shift ;;
    -h|--help) usage ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

[ -f "$PROGRAM_YAML" ] || die "нет SOC-программы: $PROGRAM_YAML"

# --- VM-вызов (мини-копия vm_sh из colab-dsh-up.sh: маркер SH_OK/SH_FAIL в
# последней строке stdout, IPython-шум в stderr, канонический шум-фильтр) ----
# При таймауте обёртка timeout убивает colabctl, но внук `colab exec` может
# выжить, держа flock sessions.json — следующий вызов умрёт на lock-wait.
# Поэтому после сбоя чистим свои залипшие vm-sh exec'и (паттерн [.]py не
# матчит собственную обёртку; keep-alive не матчится — там нет exec -f).
vm_sh() {
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

# --- 1. Деплой (идемпотентный; повторный прогон = быстрая health-проверка) ----
# --inject-key: сьют шлёт реальный turn (ctx-детектор) — DSH_BG_API_KEY нужен
# на VM (base64-канал, значение не в логах).
if [ "$SKIP_DEPLOY" -eq 0 ]; then
  # --fake-model пробрасывается в деплой (флаг виден только без --skip-deploy)
  UP_ARGS=(--target "$TARGET" --inject-key)
  FAKE_TAG=""
  if [ "$FAKE_MODEL" -eq 1 ]; then UP_ARGS+=(--fake-model); FAKE_TAG=" --fake-model"; fi
  log "шаг 1: деплой target=$TARGET (colab-dsh-up.sh --inject-key$FAKE_TAG)"
  if ! bash "$REPO_DIR/scripts/colab-dsh-up.sh" "${UP_ARGS[@]}" 2>&1 | tee /tmp/colab-dsh-up-last.log; then
    die "деплой не прошёл (лог: /tmp/colab-dsh-up-last.log)"
  fi
else
  log "шаг 1: деплой пропущен (--skip-deploy)"
fi

# --- 2. Отправка SOC-программы -----------------------------------------------
log "шаг 2: socctl program --lane colab --background"
SUBMIT_JSON="$(timeout 120 "$SOCCTL" program --file "$PROGRAM_YAML" --lane colab --root "$REPO_DIR" --background --json 2>/dev/null)" \
  || die "program не отправился в SOC"
# job_id живёт в submit-ответе ВЛОЖЕННО: d.program.job_id (верхнего уровня нет)
JOB_ID="$(printf '%s' "$SUBMIT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["program"]["job_id"])')" \
  || die "job_id не извлёкся из ответа SOC (нет d.program.job_id)"
log "job_id=$JOB_ID"

# Каталог отчёта создаётся ДО запуска: wait_for_program пишет туда финальный
# status-payload (job-status.json), verdict-парсер читает его result_json.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# target сanitизируется для имени каталога: ':' в 'patches:<ref>' → '_'
REPORT_TAG="$LABEL"
[ -n "$REPORT_TAG" ] || REPORT_TAG="live-$(printf '%s' "$TARGET" | tr ':' '_')"
REPORT_DIR="$REPO_DIR/reports/colab-$REPORT_TAG-$STAMP"
FRAMES_DIR="$REPORT_DIR/frames"
mkdir -p "$FRAMES_DIR"

# --- 3. Poll program-status ---------------------------------------------------
wait_for_program() { # $1 = job_id; печать финального статуса (pass|fail); инфра-сбой → rc 2
  # socctl program-status выходит rc=1, когда job завершился fail (rc
  # отражает статус программы) — это НЕ транспортный сбой: payload валиден
  # и парсится при любом rc; ретраится только пустой/невалидный вывод.
  local job="$1" waited=0 status payload
  while :; do
    payload="$(timeout 60 "$SOCCTL" program-status --job-id "$job" --json 2>/dev/null)" || true
    status="$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
    case "$status" in
      pass|fail) printf '%s' "$payload" > "$REPORT_DIR/job-status.json"
                printf '%s' "$status"; return 0 ;;
      running) : ;;
      *) printf 'poll: статус не распознан (транспорт?), waited=%ss\n' "$waited" >&2 ;;
    esac
    if [ "$waited" -ge "$MAX_WAIT" ]; then
      printf '%s' "$payload" | head -c 2000 >&2
      return 2
    fi
    sleep 15
    waited=$((waited + 15))
  done
}

log "шаг 3: ожидание завершения программы (до ${MAX_WAIT}с)"
FINAL_STATUS="$(wait_for_program "$JOB_ID")" || die "программа не завершилась за ${MAX_WAIT}с (job_id=$JOB_ID)"
log "программа завершилась: $FINAL_STATUS"

# --- 4. Отчёт: verdict + кадры ------------------------------------------------
# result.json программы: путь в финальном status-payload. Ответ program-status
# бывает ПЛОСКИМ (job ещё жив: top-level result_json) или ОБЁРНУТЫМ
# (job завершён: {status, program_status:{result_json}, artifact_refs:{...}})
# — ищем во всех трёх местах.
RESULT_JSON="$(python3 - "$REPORT_DIR/job-status.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
for source in (d, d.get("program_status") or {}, d.get("artifact_refs") or {}):
    path = source.get("result_json")
    if path:
        print(path)
        break
PYEOF
)"
[ -n "$RESULT_JSON" ] && [ -f "$RESULT_JSON" ] \
  || die "result.json не найден в финальном status-payload (job_id=$JOB_ID)"
cp "$RESULT_JSON" "$REPORT_DIR/result.json"

# Выгрузка кадров с VM: tar-архив одним файлом (v2-сьют пишет 100+ кадров —
# поштучно это 15+ минут транспорта; tar = один colabctl download).
# Каталог кадров автодетектится: live-сьют пишет /root/dsh-live-frames,
# fake-сьют — /root/dsh-fake-frames; берём непустой с максимумом файлов
# (оба могут существовать после смешанных прогонов).
download_frames() {
  local n f
  local counts
  counts="$(vm_sh "for d in /root/dsh-live-frames /root/dsh-fake-frames; do echo \"\$d \$(find \$d -type f 2>/dev/null | wc -l)\"; done" 90)" || return 1
  local best=0 best_dir=""
  while read -r d c; do
    [ -z "${d:-}" ] && continue
    if [ "${c:-0}" -gt "$best" ]; then best="$c"; best_dir="$d"; fi
  done <<< "$counts"
  if [ -n "$best_dir" ]; then
    VM_FRAMES_DIR="$best_dir"
    log "каталог кадров на VM: $VM_FRAMES_DIR ($best файлов)"
  fi
  n="$best"
  [ "${n:-0}" -gt 0 ] || { log "кадров на VM нет ($VM_FRAMES_DIR пуст)"; return 0; }
  if [ "$n" -le 8 ]; then
    # малые прогоны: поштучно (в отчете файлы лежат плоско, как раньше)
    local listing ok=0 fail=0
    listing="$(vm_sh "ls -1 $VM_FRAMES_DIR 2>/dev/null" 60)" || return 1
    for f in $listing; do
      if timeout 90 "$COLABCTL" download "$VM_FRAMES_DIR/$f" "$FRAMES_DIR/$f" >/dev/null 2>&1; then
        ok=$((ok + 1))
      else
        log "кадр не скачался: $f"; fail=$((fail + 1))
      fi
    done
    log "кадры выгружены: ok=$ok fail=$fail → $FRAMES_DIR"
    [ "$fail" -eq 0 ]
    return
  fi
  local frames_base
  frames_base="$(basename "$VM_FRAMES_DIR")"
  vm_sh "tar -czf /root/dsh-frames.tar.gz -C /root $frames_base" 120 || return 1
  timeout 180 "$COLABCTL" download /root/dsh-frames.tar.gz "$REPORT_DIR/frames.tar.gz" >/dev/null 2>&1 \
    || { log "tar-архив кадров не скачался"; return 1; }
  tar -xzf "$REPORT_DIR/frames.tar.gz" -C "$REPORT_DIR" || { log "tar не распаковался"; return 1; }
  rm -f "$REPORT_DIR/frames.tar.gz"
  # распаковалось в reports/<...>/<frames_base>/* → переносим в frames/
  mv "$REPORT_DIR/$frames_base"/* "$FRAMES_DIR"/ 2>/dev/null || true
  rmdir "$REPORT_DIR/$frames_base" 2>/dev/null || true
  log "кадры выгружены tar-ом: $(find "$FRAMES_DIR" -type f | wc -l) файлов → $FRAMES_DIR"
}

download_frames || die "выгрузка кадров сломалась (см. лог выше)"

# grep-пробы кадров: буквальные артефакт-факты для verdict (узел 4 ТЗ:
# «кадры, где grep находит 'effects' в slash-меню кадре»). Пробы пишутся в
# verdict.json как frame_probes — при починке бага №6 (регистрация команды
# effects) menu_effects станет >0 и это будет прямое доказательство.
frame_probes_json() { # $1 = FRAMES_DIR; печать: JSON-строка с grep-счётчиками
  python3 - "$1" <<'PYEOF'
import json, subprocess, sys
from pathlib import Path
frames = Path(sys.argv[1])
def grep_count(path, needle):
    if not path.is_file():
        return None
    r = subprocess.run(["grep", "-c", needle, str(path)], capture_output=True, text=True)
    return int(r.stdout.strip() or 0) if r.returncode in (0, 1) else None
probes = {
    "slash_menu_effects_grep": grep_count(frames / "slash_menu.txt", "effects"),
    "slash_menu_theme_grep": grep_count(frames / "slash_menu.txt", "theme"),
    "effects_panel_inputBorderBreath_grep": grep_count(frames / "effects_panel.txt", "inputBorderBreath"),
    "themes_picker_tokyonight_grep": grep_count(frames / "themes_picker.txt", "tokyonight"),
    "footer_status_grep": grep_count(frames / "footer.txt", "glm-"),
}
print(json.dumps(probes, ensure_ascii=False))
PYEOF
}
FRAME_PROBES="$(frame_probes_json "$FRAMES_DIR")"
log "grep-пробы кадров: $FRAME_PROBES"

# verdict.json: по каждому тесту status + reproduced (для баг-детекторов).
# reproduced=true значит: ассет упал на этом target — баг воспроизведён.
# Набор детекторов настраивается --detectors (v1-дефолт или v2-набор).
# Раскладка argv inline-python ниже (после argv[0]='-' и argv[1..5]):
#   argv[6]=FRAME_PROBES (JSON grep-проб), argv[7]=DETECTORS (csv-список) —
#   НЕ путать местами: argv[6] в detectors_raw глушит reproduced (баг aba0ca9),
#   argv[7] в frame_probes кладёт в пробы строку детекторов.
python3 - "$REPORT_DIR/result.json" "$REPORT_DIR/verdict.json" "$TARGET" "$JOB_ID" "$FINAL_STATUS" "$FRAME_PROBES" "$DETECTORS" <<'PYEOF'
import json, sys
result_path, verdict_path, target, job_id, final_status = sys.argv[1:6]
detectors_raw = sys.argv[7] if len(sys.argv) > 7 else ""
with open(result_path) as f:
    result = json.load(f)
BUG_DETECTORS = {name.strip() for name in detectors_raw.split(",") if name.strip()}
tests = []
for step in result.get("steps", []):
    if step.get("type") != "test":
        continue
    name = step.get("id", "")
    entry = {"name": name, "status": step.get("status", "unknown")}
    if name in BUG_DETECTORS:
        # fail/error на тестируемом стеке = баг пойман детектором
        entry["reproduced"] = step.get("status") in ("fail", "error")
    if step.get("message"):
        entry["message"] = step["message"]
    tests.append(entry)
verdict = {
    "schema_version": "colab-live-verdict/1",
    "target": target,
    "job_id": job_id,
    "program_status": final_status,
    "counters": result.get("counters", {}),
    "tests": tests,
    "bug_reproduced_count": sum(1 for t in tests if t.get("reproduced")),
    "bug_detector_total": sum(1 for t in tests if "reproduced" in t),
    # grep-пробы артефакт-кадров (узел 4: «кадры, где grep находит 'effects'
    # в slash-меню кадре»): menu_effects >0 = команда effects в меню видна.
    "frame_probes": json.loads(sys.argv[6]) if len(sys.argv) > 6 else {},
    "frames_dir": "frames/",
    "result_json": "result.json",
    "exit_code": 0 if final_status == "pass" else 1,
}
with open(verdict_path, "w") as f:
    json.dump(verdict, f, ensure_ascii=False, indent=1)
print("verdict: program={} reproduced={}/{} exit={}".format(
    final_status, verdict["bug_reproduced_count"],
    verdict["bug_detector_total"], verdict["exit_code"]))
for t in tests:
    marker = ""
    if "reproduced" in t:
        marker = " [reproduced={}{}]".format(
            "true" if t["reproduced"] else "false",
            "" if t["reproduced"] else " (детектор НЕ поймал баг на этом target)")
    print("  {:24s} {}{}".format(t["name"], t["status"], marker))
PYEOF

# --- 5. Итог -------------------------------------------------------------------
log "отчёт: $REPORT_DIR"
if [ "$FINAL_STATUS" = "pass" ]; then
  log "GREEN: все тесты прошли"
  exit 0
fi
log "RED/FAIL: программа не прошла — verdict и кадры в $REPORT_DIR (exit 1)"
exit 1
