#!/usr/bin/env bash
# colab-zjcell.sh — оркестратор ЯЧЕЙКИ ZELLIJ (TG-ZCELL-20260926, матрица
# №2 хендоффа handoff-zellij-20260926.md): WezTerm → zellij(кастом юзера) →
# dsh. Цель: отделить слой мультиплексора от продукта dsh — воспроизвести
# симптомы E1/пила/тултип при ТОЧНОМ паритете продакшна (кастом-бинарь
# 0.45.0 md5 456da6efb9b017e0bc3782de5d60eb3f, конфиг-зеркало юзера,
# двухшаговый запуск zz, mouse_mode true).
#
# Отличия от colab-wezterm-live.sh:
#   + stage_bin_to_vps — кастом-бинарь юзера (52.6МБ) → VPS-стейджинг
#     /var/www/html/zjcell/zj.bin (аплоад через /usr/bin/ssh напрямую,
#     НЕ base64: 52МБ = ~3500 чанков colabctl-канала — недопустимо;
#     НЕ ~/.local/bin/ssh — это proxychains-врапер с мёртвым SOCKS);
#   + fetch_bin_on_vm  — VM тянет бинарь curl'ом с VPS → /usr/local/bin/
#     zjcustom (имя БЕЗ zellij-токена — локальный хук зелишь-CLI не
#     должен резать команды оркестратора), md5-гейт, ldd, --version;
#   + run user-zj 47x43 — ОДНА геометрия (юзер-продакшн; wide-базлайны
#     не нужны — сравнение идёт с live-probe-20260926/user);
#   + cleanup_vps_bin  — стейджинг чистится после прогона.
#
# Использование: scripts/colab-zjcell.sh [--stage-only|--run-only|--fetch-only]
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COLABCTL="$HOME/xeon-Programms/MCP/SOC/autotestvm/gcolab/bin/colabctl"
OUT_BASE="$REPO_DIR/reports/zellij-cell-20260926"
VM_BASE=/root/wezterm-live

# Кастом-бинарь юзера (Zorin, тот же md5 что в продакшне) — источник ячейки.
ZBIN_LOCAL=$HOME/.local/bin/zellij
ZBIN_MD5_EXPECT=456da6efb9b017e0bc3782de5d60eb3f
ZBIN_SIZE_EXPECT=52614856
VPS_HOST=api.example.com
VPS_USER=root
VPS_KEY=$HOME/xeon-Programms/Micro-utils/Zellij/.keys/vps_deploy_key
VPS_BIN_URL="https://$VPS_HOST/zjcell/zj.bin"
VPS_BIN_DIR=/var/www/html/zjcell

log() { echo "[zjcell] $(date -u +%H:%M:%S) $*"; }

vm_sh() { # vm_sh <timeout> <cmd...> — вывод без SH-маркеров/IPython-шума/[colab]
  # Флак моста (обрывы WS / rc=124 после истёкшего runtime-proxy-token):
  # идемпотентные вызовы ретраятся VM_SH_RETRIES раз. Дефолт 0 — запуск
  # стенда (vm_bg_run) и прочие non-idempotent вызовы не трогаются; ретраи
  # включаются только локально внутри upload_file (динамический скоуп bash).
  local t=$1; shift
  local out rc=1 try tries=${VM_SH_RETRIES:-0}
  for try in $(seq 0 "$tries"); do
    out=$(timeout "$t" "$COLABCTL" sh -c "$*" 2>&1) && rc=0 || rc=$?
    [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q '^SH_OK' && break
    [ "$try" -lt "$tries" ] && { log "vm_sh rc=$rc — ретрай: $(printf '%s' "$*" | head -c 80)"; sleep 4; }
  done
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
append_chunk() { # append_chunk <dir> <idx> <chunk> — идемпотентная дозапись чанка
  # Флак «команда выполнилась, но ответ потерян»: слепой ретрай задвоил бы
  # чанк. Идемпотентность по размеру: перед чанком idx файл обязан иметь
  # ровно idx*15000 байт, после — (idx+1)*15000; любое другое = порча.
  # Размер через stat: `wc -c <f` при отсутствии f сыплет ошибку шелла
  # в stderr канала (2>/dev/null у wc её НЕ глушит) и рвёт парсинг.
  local dir=$1 idx=$2 chunk=$3 try sz
  # последний чанк короче 15000 → want_after от фактической длины чанка
  # (для полных = (idx+1)*15000, формула единая)
  local want_before=$((idx * 15000)) want_after=$((idx * 15000 + ${#chunk}))
  for try in 1 2 3; do
    sz=$(vm_sh 30 "stat -c %s $dir/.tmp-b64 2>/dev/null || echo 0" 2>/dev/null | tr -d '[:space:]')
    [ "$sz" = "$want_after" ] && return 0
    [ "$sz" = "$want_before" ] || { log "chunk $idx: .tmp-b64=$sz байт (ждали $want_before)"; return 1; }
    # аппенд НЕидемпотентен → внутренние ретраи vm_sh гасим (задвоение
    # чанка); повторная попытка — только через re-check размера циклом
    VM_SH_RETRIES=0 vm_sh 90 "printf '%s' '$chunk' >> $dir/.tmp-b64" || true
  done
  sz=$(vm_sh 30 "stat -c %s $dir/.tmp-b64 2>/dev/null || echo 0" 2>/dev/null | tr -d '[:space:]')
  [ "$sz" = "$want_after" ]
}

upload_file() { # upload_file <локальный> <удалённый>
  local src=$1 dst=$2 b64 md5 vmmd5 chunk i n
  md5=$(md5sum "$src" | cut -d' ' -f1)
  b64=$(base64 -w0 "$src")
  # все шаги аплоада идемпотентны (mkdir/rm/чанки по размеру/md5-skip) →
  # ретраи vm_sh безопасны; наружу (запуск стенда) не текут — local
  local VM_SH_RETRIES=2
  vm_sh 60 "mkdir -p $(dirname "$dst")" || return 1
  vm_sh 30 "rm -f $(dirname "$dst")/.tmp-b64" || return 1
  n=$(( ( ${#b64} + 14999 ) / 15000 ))
  for i in $(seq 0 $((n - 1))); do
    append_chunk "$(dirname "$dst")" "$i" "${b64:$((i * 15000)):15000}" || return 1
  done
  # md5-skip: прошлый finalize мог выполниться при потерянном ответе —
  # тогда .tmp-b64 уже consumed и dst уже верен; слепой повтор падал бы
  vmmd5=$(vm_sh 90 "if md5sum '$dst' 2>/dev/null | grep -q '^$md5'; then echo '$md5'; else base64 -d $(dirname "$dst")/.tmp-b64 > '$dst' && rm -f $(dirname "$dst")/.tmp-b64 && md5sum '$dst' | cut -d' ' -f1; fi" | grep -E '^[0-9a-f]{32}$' | tail -1 || true)
  if [ -z "$vmmd5" ] || [ "$vmmd5" != "$md5" ]; then
    log "md5-гейт FAIL: $dst ($vmmd5 ≠ $md5)"; return 1
  fi
  log "залит $dst (md5 ok)"
}

setup_assets() {
  upload_file "$REPO_DIR/scripts/wezterm-live/wezterm.lua"          "$VM_BASE/wezterm.lua"
  upload_file "$REPO_DIR/scripts/wezterm-live/vm-install.sh"        "$VM_BASE/vm-install.sh"
  upload_file "$REPO_DIR/scripts/wezterm-live/vm-live-stand-zj.sh"  "$VM_BASE/vm-live-stand-zj.sh"
  upload_file "$REPO_DIR/scripts/wezterm-live/vm-analyze.py"        "$VM_BASE/vm-analyze.py"
  upload_file "$REPO_DIR/tests/colab/trace-metrics.py"              "$VM_BASE/trace-metrics.py"
  vm_sh 30 "chmod +x $VM_BASE/vm-install.sh $VM_BASE/vm-live-stand-zj.sh $VM_BASE/trace-metrics.py"
}

# --- 1b. стейджинг бинаря zellij на VPS ------------------------------------------
# Аплоад 52.6МБ напрямую ssh'ом в webroot: colabctl base64-канал тянет
# ~9Кб/ш (медленно, держит flock), а download-канал — для выгрузки.
# Ретраи: файл перечитывается с диска КАЖДУЮ попытку (НЕ буферизовать в
# stdin — 52МБ × N в памяти), аплоад идёт в .tmp + атомарный mv.
stage_bin_to_vps() {
  local md5 size rc=0
  md5=$(md5sum "$ZBIN_LOCAL" | cut -d' ' -f1)
  size=$(stat -c %s "$ZBIN_LOCAL")
  [ "$md5" = "$ZBIN_MD5_EXPECT" ] || { log "ЛОКАЛЬНЫЙ бинарь ≠ эталон ($md5) — ячейка будет не-продакшн"; return 1; }
  [ "$size" = "$ZBIN_SIZE_EXPECT" ] || { log "ЛОКАЛЬНЫЙ размер ≠ $ZBIN_SIZE_EXPECT ($size)"; return 1; }
  # Уже стейджирован и HTTP-доступен? — идемпотентно пропускаем
  if curl -fsSI -m 30 "$VPS_BIN_URL" 2>/dev/null | grep -qi "^content-length: $ZBIN_SIZE_EXPECT"; then
    log "VPS: $VPS_BIN_URL уже стейджирован (content-length ok)"
    return 0
  fi
  for attempt in 1 2 3; do
    log "VPS-аплоад попытка $attempt (52.6МБ в webroot)"
    /usr/bin/ssh -i "$VPS_KEY" -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new \
      "$VPS_USER@$VPS_HOST" "mkdir -p $VPS_BIN_DIR && cat > $VPS_BIN_DIR/zj.bin.tmp" < "$ZBIN_LOCAL" \
      && /usr/bin/ssh -i "$VPS_KEY" -o ConnectTimeout=20 \
           "$VPS_USER@$VPS_HOST" "mv $VPS_BIN_DIR/zj.bin.tmp $VPS_BIN_DIR/zj.bin && md5sum $VPS_BIN_DIR/zj.bin | cut -d' ' -f1" \
      | { read -r rmd5; [ "$rmd5" = "$md5" ] && echo "md5 ok: $rmd5" || { echo "md5 FAIL: $rmd5"; exit 1; }; } \
      && rc=0 && break || rc=$?
    sleep 10
  done
  [ "$rc" = 0 ] || { log "VPS-аплоад не прошёл после 3 попыток"; return 1; }
  # HTTP-гейт: nginx отдаёт webroot по default location
  local clen
  clen=$(curl -fsSI -m 30 "$VPS_BIN_URL" 2>/dev/null | grep -i '^content-length:' | tr -dc 0-9)
  [ "$clen" = "$ZBIN_SIZE_EXPECT" ] \
    || { log "HTTP-гейт FAIL: content-length=$clen (ожидал $ZBIN_SIZE_EXPECT)"; return 1; }
  log "VPS-стейджинг готов: $VPS_BIN_URL ($clen байт)"
}

# --- 1c. бинарь на VM ------------------------------------------------------------
fetch_bin_on_vm() {
  # Идемпотентно: если md5 уже совпадает — не качаем (52.6МБ по медленному
  # каналу VM↔VPS = минуты; curl -fsSL -m 540 в bg-задаче)
  local have
  have=$(vm_sh 30 "md5sum /usr/local/bin/zjcustom 2>/dev/null | cut -d' ' -f1" | grep -E '^[0-9a-f]{32}$' | tail -1 || true)
  if [ "$have" = "$ZBIN_MD5_EXPECT" ]; then
    log "VM: zjcustom уже стоит (md5 ok)"
  else
    local rc
    rc=$(vm_bg_run zjfetch 600 "curl -fsSL -m 540 -o /usr/local/bin/zjcustom '$VPS_BIN_URL' && chmod 755 /usr/local/bin/zjcustom")
    [ "$rc" = 0 ] || { log "zjfetch rc=$rc — смотри $VM_BASE/log-zjfetch.log"; return 1; }
  fi
  # Ассерты: md5 + ldd + --version (glibc: собран на Zorin 2.35, VM 2.39 —
  # forward-совместим)
  vm_sh 30 "md5sum /usr/local/bin/zjcustom | grep -q $ZBIN_MD5_EXPECT && echo MD5_OK" \
    || { log "АССЕРТ: md5 zjcustom на VM НЕ совпал"; return 1; }
  vm_sh 30 "ldd /usr/local/bin/zjcustom >/dev/null 2>&1 && echo LDD_OK || echo LDD_MISS" || true
  vm_sh 30 "/usr/local/bin/zjcustom --version" || true
  log "VM: zjcustom готов (md5 = продакшн-эталон)"
}

cleanup_vps_bin() {
  /usr/bin/ssh -i "$VPS_KEY" -o ConnectTimeout=20 "$VPS_USER@$VPS_HOST" \
    "rm -rf $VPS_BIN_DIR" 2>/dev/null || log "WARN: cleanup VPS $VPS_BIN_DIR не прошёл"
  log "VPS-стейджинг вычищен"
}

# --- 2. провайдер mks + токен (дублирует colab-wezterm-live.sh) ------------------
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
  # Bearer → 200; проба 2026-09-26), а dsh-адаптер (pi-ai anthropic-messages)
  # шлёт только x-api-key.
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

# --- 5-6. прогон + анализ --------------------------------------------------------
run_cell() { # run_cell <label> <cols> <rows>
  local label=$1 cols=$2 rows=$3 rc
  log "прогон $label (${cols}x${rows})"
  # || echo TIMEOUT: vm_bg_run при таймауте возвращает 124 → без guard'а
  # set -e абортирует оркестратор ДО analyze/cleanup (стенд мог успеть
  # отработать основную фазу — вердикты всё равно нужны)
  rc=$(vm_bg_run "stand-$label" 1200 "bash $VM_BASE/vm-live-stand-zj.sh $label $cols $rows" || echo TIMEOUT)
  vm_sh 40 "tail -12 $VM_BASE/log-stand-$label.log" || true
  if [ "$rc" != 0 ]; then
    log "stand $label rc=$rc — вердикты могут быть неполными"
  fi
  rc=$(vm_bg_run "analyze-$label" 300 "python3 $VM_BASE/vm-analyze.py $VM_BASE/run-$label" || echo TIMEOUT)
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

fetch_artifacts() { fetch_one "${ZJ_LABEL:-user-zj}"; }

cleanup_vm() {
  # bracket-трюк: команда идёт через colabctl sh -c → её ТЕКСТ в argv
  # обёртки; '[w]ezterm' не матчит литерал 'wezterm' в собственном тексте.
  vm_sh 30 "pkill -f '[w]ezterm-gui'; pkill -f '[w]ezterm-mux-server'; pkill -f '[f]fmpeg.*x11grab'; pkill -f '[z]jcustom'; pkill -f '[X]vfb :99'; sleep 1; rm -f /root/.local/share/wezterm/gui-sock-* /root/.local/share/wezterm/pid; true" 2>/dev/null || true
}

case "${1:-all}" in
  --stage-only)
    stage_bin_to_vps
    fetch_bin_on_vm
    ;;
  --setup-only)
    setup_assets
    stage_bin_to_vps
    fetch_bin_on_vm
    setup_provider
    setup_fullscreen_parity
    preflight_provider
    ;;
  --run-only)
    rc=$(vm_bg_run install 600 "bash $VM_BASE/vm-install.sh" || echo TIMEOUT)
    [ "$rc" = 0 ] || { log "vm-install rc=$rc"; exit 1; }
    run_cell "${ZJ_LABEL:-user-zj}" 47 43
    cleanup_vm
    ;;
  --fetch-only)
    fetch_artifacts
    ;;
  --cleanup-vps)
    cleanup_vps_bin
    ;;
  all)
    setup_assets
    stage_bin_to_vps
    fetch_bin_on_vm
    setup_provider
    setup_fullscreen_parity
    preflight_provider
    rc=$(vm_bg_run install 600 "bash $VM_BASE/vm-install.sh" || echo TIMEOUT)
    [ "$rc" = 0 ] || { log "vm-install rc=$rc"; exit 1; }
    run_cell "${ZJ_LABEL:-user-zj}" 47 43
    cleanup_vm
    fetch_artifacts
    cleanup_vps_bin
    ;;
esac
log "готово"
