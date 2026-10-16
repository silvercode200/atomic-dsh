#!/usr/bin/env bash
# colab-wezterm-live.sh — локальный оркестратор живого WezTerm-стенда dsh
# (TG-DSH-LIVE-20260926 узлы 2-3). Запускается с Zorin/Xeon-копии.
#
#   1. заливает scripts/wezterm-live/* + tests/colab/trace-metrics.py на VM
#      (base64-чанки ≤15000 симв. через colabctl sh; md5-гейт на файл);
#   2. поверх деплойного /root/.dsh/settings.yaml добавляет провайдер mks
#      (api anthropic-messages, baseURL https://api.example.com/sw —
#      фронтдор VPS-свитчера) и переключает agent-default-model на
#      glm-5.3-flash; РАЗОВО инжектит токен dsh-приложения в
#      /root/.dsh/.credentials.yaml (refs.DSH_MKS_KEY ← локальный
#      ~/.dsh/.credentials.yaml refs.MKS_DSH_TOKEN; chmod 600; значение
#      идёт только base64-каналом, НИКОГДА в лог/чат);
#   3. preflight: живой POST /v1/messages с ключом (печатаю только HTTP-код);
#   4. vm-install.sh (wezterm 20240203 = версия юзера, xdotool, JetBrains Mono);
#   5. vm-live-stand.sh × 2 геометрии: 120x48 (wide) + 47x43 (юзер);
#      длинные шаги — через colabctl bg + poll rc-файла (не foreground sh:
#      длинный exec держит flock канала — ловушка memory);
#   6. vm-analyze.py на каждом прогоне;
#   7. выгрузка tar в reports/live-probe-20260926/<label>/ (фоллбек: tar
#      без видео, если канал не тянет; md5 обе стороны — stale-tar ловушка).
#
# Использование: scripts/colab-wezterm-live.sh [--setup-only|--run-only|--fetch-only]
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COLABCTL="$HOME/xeon-Programms/MCP/SOC/autotestvm/gcolab/bin/colabctl"
OUT_BASE="$REPO_DIR/reports/live-probe-20260926"
VM_BASE=/root/wezterm-live

log() { echo "[wezterm-live] $(date -u +%H:%M:%S) $*"; }

vm_sh() { # vm_sh <timeout> <cmd...> — вывод без SH-маркеров/IPython-шума/[colab]
  local t=$1; shift
  local out rc=0
  out=$(timeout "$t" "$COLABCTL" sh -c "$*" 2>&1) || rc=$?
  # SystemExit без якоря ^ — ANSI-вариант с ESC-префиксом тоже режется
  printf '%s\n' "$out" | awk \
    '!/^SH_OK/ && !/^SH_FAIL/ && !/^An exception/ && !/SystemExit/ && !/interactiveshell/ && !/warn\(/ && !/^\[colab\]/ {print}'
  if [ "$rc" -ne 0 ] || ! printf '%s\n' "$out" | grep -q '^SH_OK'; then
    log "vm_sh FAIL rc=$rc: $(printf '%s' "$*" | head -c 120)"
    return 1
  fi
}

vm_bg_run() { # vm_bg_run <name> <timeout> <vm-cmd...> — stdout = rc задачи
  local name=$1 tmo=$2; shift 2
  local rcfile="$VM_BASE/rc-$name"
  vm_sh 30 "rm -f $rcfile" >/dev/null 2>&1 || true
  # stdout colabctl bg (RUN_OK/[colab] upload) — В /dev/null: функция обязана
  # печатать ТОЛЬКО rc задачи (колбэк-захват rc=$() иначе ловит многострочный
  # мусор → ложный abort сравнением [ "$rc" = 0 ])
  local launch=0
  timeout 60 "$COLABCTL" bg -c "$* > $VM_BASE/log-$name.log 2>&1; echo \$? > $rcfile" -n "$name" >/dev/null 2>&1 \
    || { sleep 5; timeout 60 "$COLABCTL" bg -c "$* > $VM_BASE/log-$name.log 2>&1; echo \$? > $rcfile" -n "$name" >/dev/null 2>&1 || launch=1; }
  if [ "$launch" = 1 ]; then
    log "bg-launch $name FAIL"; return 124
  fi
  local waited=0
  while [ "$waited" -le "$tmo" ]; do
    local n
    n=$(vm_sh 25 "cat $rcfile 2>/dev/null || true" 2>/dev/null | grep -E '^[0-9]+$' | tail -1 || true)
    if [ -n "$n" ]; then
      printf '%s\n' "$n"; return 0
    fi
    sleep 15; waited=$((waited + 15))
  done
  log "TIMEOUT $name (${tmo}s)"
  return 124
}

# --- 1. ассеты на VM -----------------------------------------------------------
upload_file() { # upload_file <локальный> <удалённый>
  local src=$1 dst=$2 b64 md5 vmmd5 chunk i n
  md5=$(md5sum "$src" | cut -d' ' -f1)
  b64=$(base64 -w0 "$src")
  vm_sh 60 "mkdir -p $(dirname "$dst")" || return 1
  vm_sh 30 "rm -f $(dirname "$dst")/.tmp-b64" || return 1
  n=$(( ( ${#b64} + 14999 ) / 15000 ))
  for i in $(seq 0 $((n - 1))); do
    chunk="${b64:$((i * 15000)):15000}"
    vm_sh 60 "printf '%s' '$chunk' >> $(dirname "$dst")/.tmp-b64" || return 1
  done
  vmmd5=$(vm_sh 90 "base64 -d $(dirname "$dst")/.tmp-b64 > '$dst' && rm -f $(dirname "$dst")/.tmp-b64 && md5sum '$dst' | cut -d' ' -f1" | grep -E '^[0-9a-f]{32}$' | tail -1 || true)
  if [ -z "$vmmd5" ] || [ "$vmmd5" != "$md5" ]; then
    log "md5-гейт FAIL: $dst ($vmmd5 ≠ $md5)"; return 1
  fi
  log "залит $dst (md5 ok)"
}

setup_assets() {
  upload_file "$REPO_DIR/scripts/wezterm-live/wezterm.lua"      "$VM_BASE/wezterm.lua"
  upload_file "$REPO_DIR/scripts/wezterm-live/vm-install.sh"    "$VM_BASE/vm-install.sh"
  upload_file "$REPO_DIR/scripts/wezterm-live/vm-live-stand.sh" "$VM_BASE/vm-live-stand.sh"
  upload_file "$REPO_DIR/scripts/wezterm-live/vm-analyze.py"    "$VM_BASE/vm-analyze.py"
  upload_file "$REPO_DIR/tests/colab/trace-metrics.py"          "$VM_BASE/trace-metrics.py"
  vm_sh 30 "chmod +x $VM_BASE/vm-install.sh $VM_BASE/vm-live-stand.sh $VM_BASE/trace-metrics.py"
}

# --- 2. провайдер mks + токен ---------------------------------------------------
setup_provider() {
  if ! vm_sh 60 "grep -q 'provider: mks' /root/.dsh/settings.yaml" 2>/dev/null; then
    vm_sh 90 "python3 - <<'PYEOF'
p = '/root/.dsh/settings.yaml'
s = open(p).read()
s = s.replace('agent-default-model:\n  provider: bg\n  model: glm-5.3',
              'agent-default-model:\n  provider: mks\n  model: glm-5.3-flash')
s = s.replace('llm-pi-ai:\n  providers:\n',
'''llm-pi-ai:\n  providers:\n    mks:\n      api: anthropic-messages\n      apiKeyEnv: DSH_MKS_KEY\n      baseURL: https://api.example.com/sw\n      models:\n      - id: glm-5.3-flash\n        retryPolicy:\n          mode: normal\n          maxRetries: 8\n          backoff:\n            maxDelayMs: 60000\n''')
open(p, 'w').write(s)
print('settings patched')
PYEOF" || { log "патч settings.yaml FAIL"; return 1; }
  fi
  vm_sh 30 "grep -q 'provider: mks' /root/.dsh/settings.yaml" \
    || { log "АССЕРТ: provider: mks не в settings.yaml"; return 1; }
  log "settings.yaml: провайдер mks активен"

  if ! vm_sh 30 "grep -q DSH_MKS_KEY /root/.dsh/.credentials.yaml" 2>/dev/null; then
    local tok_b64
    tok_b64=$(python3 -c "
import yaml, base64
d = yaml.safe_load(open('$HOME/.dsh/.credentials.yaml'))
print(base64.b64encode(d['refs']['MKS_DSH_TOKEN'].encode()).decode())")
    [ -n "$tok_b64" ] || { log "локальный токен не прочитан"; return 1; }
    vm_sh 60 "python3 - <<PYEOF
import base64
tok = base64.b64decode('$tok_b64').decode()
p = '/root/.dsh/.credentials.yaml'
try:
    import yaml; d = yaml.safe_load(open(p)) or {}
except Exception:
    d = {}
refs = d.get('refs') or {}
refs['DSH_MKS_KEY'] = tok
d['refs'] = refs
# dsh-credentials-local ≥ v1-парсер: БЕЗ version:1 файл считается pre-release
# flat layout → «Add version: 1 and nest the existing entry under refs» —
# dsh-бут падает на загрузке credentials (ловушка прогона #4, 2026-09-26)
d['version'] = 1
import yaml
open(p, 'w').write(yaml.safe_dump(d, default_flow_style=False))
import os; os.chmod(p, 0o600)
print('cred injected')
PYEOF" || { log "инъекция токена FAIL"; return 1; }
  fi
  vm_sh 30 "stat -c '%a' /root/.dsh/.credentials.yaml" || true

  # headers-инъекция: фронтдор требует Authorization Bearer (x-api-key → 401,
  # Bearer → 200, оба → 200; проба 2026-09-26), а dsh-адаптер (pi-ai
  # anthropic-messages) шлёт только x-api-key. Схема провайдера поддерживает
  # headers (dsh-llm-pi-ai index.js:943 z.dict(z.string()); authorization
  # не в reserved-сете requestHeaders; optionsHeaders мержится последним в
  # defaultHeaders SDK). Токен читается НА VM из credentials.yaml — значение
  # не проходит через канал команд и логи.
  vm_sh 60 "python3 - <<'PYEOF'
import os, yaml
sp = '/root/.dsh/settings.yaml'
tok = yaml.safe_load(open('/root/.dsh/.credentials.yaml'))['refs']['DSH_MKS_KEY']
s = open(sp).read()
if 'authorization: Bearer' in s:
    print('headers already present')
else:
    needle = '      apiKeyEnv: DSH_MKS_KEY\n'
    assert needle in s, 'mks apiKeyEnv line not found'
    ins = needle + '      headers:\n        authorization: Bearer ' + tok + '\n'
    open(sp, 'w').write(s.replace(needle, ins, 1))
    os.chmod(sp, 0o600)
    print('headers injected')
PYEOF" || { log "headers-инъекция FAIL"; return 1; }
  vm_sh 30 "grep -q 'authorization: Bearer' /root/.dsh/settings.yaml" \
    || { log "АССЕРТ: authorization не в settings.yaml"; return 1; }
  log "headers.authorization инжектен (Bearer-фронтдор)"
}

# --- 2b. юзер-парити режима: fullscreen:false ------------------------------------
# Ловушка прогонов #5-6 (2026-09-26): деплойный settings.yaml НЕ несёт ключ
# fullscreen → побеждает cordis.patch.yml fullscreen:true → dsh стартует в
# FULLSCREEN (alt-screen). Все inline-баги (E1 скроллбек-мусор, тултип-дубль)
# в fullscreen не тестируются вовсе: alt-screen не пишет primary-историю.
# Юзер: ~/.dsh/settings.yaml dsh-tui.fullscreen:false (бьёт cordis —
# прецеденция plugin.js). Зеркалим на VM + ассертим.
setup_fullscreen_parity() {
  # print(False) — с ЗАГЛАВНОЙ; без -i ветка «уже стоит» не срабатывает никогда
  if vm_sh 30 "python3 -c \"import yaml; print(yaml.safe_load(open('/root/.dsh/settings.yaml'))['dsh-tui'].get('fullscreen'))\"" 2>/dev/null | grep -qxi false; then
    log "settings.yaml: fullscreen:false уже стоит (inline-паритет)"
    return 0
  fi
  vm_sh 60 "python3 - <<'PYEOF'
import yaml
p = '/root/.dsh/settings.yaml'
d = yaml.safe_load(open(p))
d.setdefault('dsh-tui', {})['fullscreen'] = False
open(p, 'w').write(yaml.safe_dump(d, default_flow_style=False, allow_unicode=True, sort_keys=False))
print('fullscreen:false записан')
PYEOF" || { log "fullscreen-паритет FAIL"; return 1; }
  vm_sh 30 "python3 -c \"import yaml; assert yaml.safe_load(open('/root/.dsh/settings.yaml'))['dsh-tui']['fullscreen'] is False\" && echo PARITY_OK" \
    || { log "АССЕРТ: fullscreen:false не в settings.yaml"; return 1; }
  log "settings.yaml: fullscreen:false (inline, паритет юзера)"
}

# --- 3. preflight живого маршрута -----------------------------------------------
preflight_provider() {
  vm_sh 120 "python3 - <<'PYEOF'
import urllib.request, urllib.error, json, yaml
d = yaml.safe_load(open('/root/.dsh/.credentials.yaml'))
key = d['refs']['DSH_MKS_KEY']
req = urllib.request.Request(
    'https://api.example.com/sw/v1/messages',
    data=json.dumps({'model': 'glm-5.3-flash', 'max_tokens': 8,
                     'messages': [{'role': 'user', 'content': 'ping'}]}).encode(),
    headers={'content-type': 'application/json', 'x-api-key': key,
             'Authorization': 'Bearer ' + key,
             'anthropic-version': '2023-06-01'})
try:
    r = urllib.request.urlopen(req, timeout=90)
    print('PROVIDER_HTTP', r.status)
except urllib.error.HTTPError as e:
    print('PROVIDER_HTTP', e.code)
except Exception as e:
    print('PROVIDER_ERR', type(e).__name__)
PYEOF"
}

# --- 5-6. прогоны + анализ -------------------------------------------------------
run_geometry() { # run_geometry <label> <cols> <rows>
  local label=$1 cols=$2 rows=$3 rc
  log "прогон $label (${cols}x${rows})"
  rc=$(vm_bg_run "stand-$label" 900 "bash $VM_BASE/vm-live-stand.sh $label $cols $rows")
  vm_sh 40 "tail -12 $VM_BASE/log-stand-$label.log" || true
  if [ "$rc" != 0 ]; then
    log "stand $label rc=$rc — вердикты могут быть неполными"
  fi
  rc=$(vm_bg_run "analyze-$label" 300 "python3 $VM_BASE/vm-analyze.py $VM_BASE/run-$label")
  vm_sh 40 "cat $VM_BASE/run-$label/verdicts.txt" || true
  [ "$rc" = 0 ] || log "analyze $label rc=$rc (WARN)"
}

# --- 7. выгрузка -----------------------------------------------------------------
fetch_one() { # fetch_one <label>
  local label=$1 ts vmd5 lmd5
  vm_sh 30 "test -d $VM_BASE/run-$label" 2>/dev/null || { log "нет run-$label на VM"; return 0; }
  mkdir -p "$OUT_BASE"
  ts=$(date -u +%H%M%S)
  vm_sh 180 "cd $VM_BASE && du -sh run-$label && tar -czf /root/wtl-$label-$ts.tar.gz run-$label" || { log "tar $label FAIL"; return 0; }
  vmd5=$(vm_sh 30 "md5sum /root/wtl-$label-$ts.tar.gz | cut -d' ' -f1" | grep -E '^[0-9a-f]{32}$' | tail -1 || true)
  if timeout 900 "$COLABCTL" download "/root/wtl-$label-$ts.tar.gz" "$OUT_BASE/$label.tar.gz" >/dev/null 2>&1; then
    lmd5=$(md5sum "$OUT_BASE/$label.tar.gz" | cut -d' ' -f1)
    if [ -n "$vmd5" ] && [ "$vmd5" = "$lmd5" ]; then
      rm -rf "$OUT_BASE/$label"
      mkdir -p "$OUT_BASE/$label"
      tar -xzf "$OUT_BASE/$label.tar.gz" -C "$OUT_BASE/$label" --strip-components=1
      log "артефакты $label → $OUT_BASE/$label/ (md5 ok, полный)"
      return 0
    fi
    log "md5 расходится после download ($vmd5 ≠ $lmd5) — stale-tar? пробую light-tar"
  else
    log "download $label полный FAIL — пробую light-tar (без видео)"
  fi
  vm_sh 180 "cd $VM_BASE && tar -czf /root/wtl-$label-l-$ts.tar.gz --exclude='*.mp4' --exclude='bootfps' run-$label" || { log "light-tar $label FAIL"; return 0; }
  vmd5=$(vm_sh 30 "md5sum /root/wtl-$label-l-$ts.tar.gz | cut -d' ' -f1" | grep -E '^[0-9a-f]{32}$' | tail -1 || true)
  timeout 600 "$COLABCTL" download "/root/wtl-$label-l-$ts.tar.gz" "$OUT_BASE/$label.tar.gz" >/dev/null 2>&1 \
    || { log "light-download $label FAIL"; return 0; }
  lmd5=$(md5sum "$OUT_BASE/$label.tar.gz" | cut -d' ' -f1)
  if [ -n "$vmd5" ] && [ "$vmd5" = "$lmd5" ]; then
    rm -rf "$OUT_BASE/$label"
    mkdir -p "$OUT_BASE/$label"
    tar -xzf "$OUT_BASE/$label.tar.gz" -C "$OUT_BASE/$label" --strip-components=1
    log "артефакты $label → $OUT_BASE/$label/ (light, без видео)"
  else
    log "light md5 тоже расходится — артефакты остаются на VM"
  fi
}

fetch_artifacts() { fetch_one wide; fetch_one user; }

cleanup_vm() {
  # bracket-трюк: команда идёт через colabctl sh -c → её ТЕКСТ в argv
  # обёртки; '[w]ezterm' не матчит литерал 'wezterm' в собственном тексте.
  # Без скобок pkill убивает сам обёрочный sh (rc=-15, SH_FAIL — уже было).
  vm_sh 30 "pkill -f '[w]ezterm-gui'; pkill -f '[w]ezterm-mux-server'; pkill -f '[f]fmpeg.*x11grab'; sleep 1; rm -f /root/.local/share/wezterm/gui-sock-* /root/.local/share/wezterm/pid; true" 2>/dev/null || true
}

case "${1:-all}" in
  --setup-only)
    setup_assets
    setup_provider
    setup_fullscreen_parity
    preflight_provider
    ;;
  --run-only)
    rc=$(vm_bg_run install 600 "bash $VM_BASE/vm-install.sh")
    [ "$rc" = 0 ] || { log "vm-install rc=$rc"; exit 1; }
    run_geometry wide 120 48
    run_geometry user 47 43
    cleanup_vm
    ;;
  --fetch-only)
    fetch_artifacts
    ;;
  all)
    setup_assets
    setup_provider
    setup_fullscreen_parity
    preflight_provider
    rc=$(vm_bg_run install 600 "bash $VM_BASE/vm-install.sh")
    [ "$rc" = 0 ] || { log "vm-install rc=$rc"; exit 1; }
    run_geometry wide 120 48
    run_geometry user 47 43
    cleanup_vm
    fetch_artifacts
    ;;
esac
log "готово"
