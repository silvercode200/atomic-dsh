#!/usr/bin/env bash
# colab-dsh-up.sh — деплой dsh-tui стека на Colab VM (через colabctl), идемпотентно.
#
# Что делает (каждый шаг идемпотентен, повторный прогон = быстрая проверка):
#   1. colabctl up — создать/проверить VM (default-аккаунт, сессия col-test).
#   2. Node >= 22 (официальный tarball v22.23.2 в /usr/local) + apt tmux/patch.
#   3. npm i -g @deepseek-ai/dsh@0.1.1-rc.2 pnpm@9.15.9 (версии = Zorin-референс).
#   4. Профиль ~/.dsh/profiles/<name>: package.json + pnpm-workspace.yaml +
#      cordis.yml + cordis.patch.yml (зеркало Zorin-профиля, без machine-local
#      вставок) → pnpm install --ignore-scripts (bg + poll).
#   5. Патч-бандл из ЗАКОММИЧЕННОГО состояния репо (git archive) → tar.gz →
#      base64-чанки → VM → применение apply-dsh-overrides.sh (md5-гейт: бандл
#      передаётся только при изменении контрольной суммы). В бандл входят и
#      core-патчи (dsh-overrides/core-patches + apply-dsh-core-overrides.sh).
#   6. UI-патчи стека → профиль (apply-dsh-overrides.sh, DSH_PROFILE).
#   6c. Core-патчи @deepseek-ai/* (agent-loop, llm-retry, ...) — apply-dsh-
#      core-overrides.sh ко ВСЕМ копиям на VM (глобаль CLI /usr/local/... +
#      профильные, если есть). md5-гейт orig_md5 → чистый apply на свежие
#      npm-копии; идемпотентность по маркерам. pristine — НЕ применяются
#      (эталон upstream).
#   7. ~/.dsh/settings.yaml (bg-провайдер, БЕЗ секрета) + dsh-tui-секция.
#      Секрет DSH_BG_API_KEY: сначала boot БЕЗ ключа (ленивый резолв); если
#      boot-smoke падает с auth/credential-ошибкой — инъекция ключа из
#      локального ~/.dsh/.credentials.yaml в /root/.dsh/.credentials.yaml
#      (chmod 600). Ключ НИКОГДА не попадает в YAML/отчёты/лог этого скрипта.
#   9. Health-check: node -v, dsh --version, --dump-config, маркер патча в
#      STORE-файле, boot-smoke в tmux. Успех = exit 0.
#
# Цели (target):
#   pristine           профиль dsh-tui-pristine: npm-пакет 0.10.0-beta.4
#                      БЕЗ dsh-overrides-патчей (upstream-референс).
#   current            профиль dsh-tui: патч-стек из HEAD репо (дефолт).
#   patches:<git-ref>  профиль dsh-tui-ref-<san>: патч-стек из git archive
#                      указанного рефа.
#
# Использование:
#   scripts/colab-dsh-up.sh [--target pristine|current|patches:<ref>]
#                           [--no-key] [--inject-key] [--force-bundle]
#                           [--fake-model]
#
# --fake-model (идемпотентно, ОБРАТИМО): после основного деплоя передаёт
#   tools/dsh-fake-llm (server.mjs, lib/, scenarios/, selftest.mjs,
#   package.json) на VM в /root/dsh-fake-llm/ (tar.gz через base64-канал,
#   md5-гейт), поднимает сервер `colabctl bg`-каналом (env PORT=8787
#   STREAM_TOTAL_MS=45000 node server.mjs; живой health
#   /health "ok":true + неизменный md5 → не перезапускается; иначе pkill
#   старого и подъём заново), добавляет в /root/.dsh/settings.yaml провайдер
#   fake (bg НЕ трогает) и переключает agent-default-model на
#   {provider: fake, model: fake-sonnet}; прежний agent-default-model
#   сохраняется в /root/.dsh-default-model.bak (до перезаписи; повторный
#   --fake-model-прогон .bak не затирает). Повторный запуск БЕЗ --fake-model
#   восстанавливает agent-default-model из .bak (если .bak существует) и
#   глушит фейк-сервер (pkill -f dsh-fake-llm/server.mjs) — живой bg-сьют
#   не затрагивается. Ключ FAKE_LLM_KEY сервер не проверяет, но dsh-клиенту
#   нужен непустой env (сьют подставляет FAKE_LLM_KEY=fake-local-key сам).
#
# Выход: 0 = VM готова и здорова для target; 1..N = конкретная ошибка шага.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COLABCTL="$HOME/xeon-Programms/MCP/SOC/autotestvm/gcolab/bin/colabctl"

# --- Константы деплоя --------------------------------------------------------
NODE_VERSION="22.23.2"
DSH_CLI_VERSION="0.1.1-rc.2"        # = Zorin-референс (npm i -g)
PNPM_VERSION="9.15.9"               # = Zorin-референс
# Пин-набор транзитивов глобали dsh = ПОЛНАЯ рабочая Zorin-инсталляция
# (nvm global, проверена юзером). 2026-09-23: свежая VM-установка вытянула
# cordis 4.0.4 + plugin-hmr 1.0.19 + timer 1.1.6 (нет hmr.registerConfig,
# peer-конфликты) → dsh-app-boot watchUserPatches падает на буте (TypeError:
# hmr.registerConfig is not a function). Частичный пин (только cordis+hmr)
# ломается ERESOLVE: свежий plugin-timer требует peer cordis ~4.0.4 —
# поэтому пиним ВЕСЬ согласованный набор (peer'ы совместимы: timer@1.1.3 и
# hmr@1.0.16 хотят cordis ^4.0.1).
CORDIS_PIN_SET="@deepseek-ai/cordis@4.0.1 @deepseek-ai/cordis-plugin-group@1.0.1 @deepseek-ai/cordis-plugin-hmr@1.0.16 @deepseek-ai/cordis-plugin-include@1.0.6 @deepseek-ai/cordis-plugin-loader@1.0.2 @deepseek-ai/cordis-plugin-timer@1.1.3"
CORDIS_PIN="4.0.1"   # версия для гейт-проверки шага 3
TUI_PKG="@deepseek-harness-tui/dsh-tui@0.10.0-beta.4"
VM_LIVE_DIR="/root/dsh-live"        # деплой-корень на VM
VM_REPO="$VM_LIVE_DIR/repo"         # распакованный бандл (apply-скрипт + патчи)
VM_STATE="$VM_LIVE_DIR/state"       # md5-маркеры, логи bg-установок
VM_TARGET_FILE="/root/.dsh-live-target"  # активный профиль для SOC-программы
LOCAL_CRED="$HOME/.dsh/.credentials.yaml"
VM_CRED="/root/.dsh/.credentials.yaml"

TARGET="current"
INJECT_KEY="auto"     # auto | never | always
FORCE_BUNDLE=0
FAKE_MODEL=0          # 1 = деплой dsh-fake-llm + providers.fake (см. шапку)

die() { echo "FAIL: $*" >&2; exit 1; }
log() { echo "[colab-dsh-up] $*"; }

# colabctl sh: vm-sh.py ВСЕГДА возвращает exit 0 (colab exec глотает rc гостя),
# реальный rc живёт в маркере `SH_OK`/`SH_FAIL rc=N` — ПОСЛЕДНЕЙ строке STDOUT.
# IPython-шум (traceback SystemExit) живёт в stderr colabctl — НЕ смешиваем.
# Ведущие строки "[colab] ..." stdout — локальные логи colabctl (upload/refresh),
# срезаем. Транспортные сбои (colabctl rc≠0) ретраятся до 3 раз.
vm_sh() { # $1 = команда, $2 = таймаут (сек, дефолт 120); stdout = чистый вывод VM
  local cmd="$1" t="${2:-120}" out marker rc attempt errf refreshed=0
  errf="$(mktemp)"
  for attempt in 1 2 3 4 5; do
    if out="$(timeout "$t" "$COLABCTL" sh -c "$cmd" 2>"$errf")"; then
      rm -f "$errf"
      break
    fi
    [ "$attempt" -lt 5 ] || {
      log "vm_sh: 5 транспортных сбоев подряд. stdout: [${out:0:200}] stderr: [$(head -c 400 "$errf" 2>/dev/null)]"
      rm -f "$errf"
      return 1
    }
    # Wedged-транспорт при живой VM = почти всегда протухший runtime-proxy-token
    # (живёт 3600с): после 2 сбоев подряд обновляем его принудительно.
    if [ "$attempt" -ge 2 ] && [ "$refreshed" -eq 0 ]; then
      log "транспортный сбой ×$attempt — обновляю runtime-proxy-token (colabctl refresh)"
      timeout 170 "$COLABCTL" refresh >/dev/null 2>&1 || true
      refreshed=1
    fi
    log "транспортный сбой (попытка $attempt/5), ждём 15с: stdout=[${out:0:120}] stderr=[$(head -c 200 "$errf" 2>/dev/null)]"
    sleep 15
  done
  rm -f "$errf"
  marker="$(printf '%s\n' "$out" | tail -n1)"
  if [[ "$marker" =~ ^SH_FAIL\ rc=([0-9]+) ]]; then
    rc="${BASH_REMATCH[1]}"
  elif [[ "$marker" =~ ^SH_OK ]]; then
    rc=0
  else
    # маркера нет — вывод порван транспортом; считаем сбоем
    printf 'vm_sh: маркер SH_OK/SH_FAIL не найден в хвосте вывода:\n%s\n' "${out:0:400}" >&2
    return 1
  fi
  # payload = всё до маркера, минус транспортный шум colabctl (канонический
  # список = _COLAB_NOISE_PREFIXES из SOC program_executor: [colab],
  # session-health:, colabctl:, SH_OK/SH_FAIL-строки)
  out="$(printf '%s\n' "$out" | sed '$d' \
    | awk '!/^\[colab\] / && !/^session-health:/ && !/^colabctl:/ && !/^SH_OK/ && !/^SH_FAIL rc=/')"
  printf '%s' "$out"
  return "$rc"
}

# Скаляр из vm_sh без транспорт-мусора: colabctl-канал подмешивает ПУСТЫЕ
# СТРОКИ и IPython-хвосты (SystemExit/UserWarning) ДО payload — точные
# сравнения (rc-файлы, версии, md5) ломаются на них (деплой v4 2026-09-23:
# «cordis \n\n\n4.0.1 ≠ пин 4.0.1» при равных версиях). Вынимаем ПОСЛЕДНИЙ
# токен по ERE после фильтра шумовых строк. Кадровые захваты
# (tmux capture-pane) так чистить НЕЛЬЗЯ — там пустые строки значимы.
vm_scalar() { # $1 = ERE токена, $2 = команда VM, $3 = таймаут
  vm_sh "${2:-true}" "${3:-60}" \
    | awk 'NF && $0 !~ /^(An exception has occurred|SystemExit:|UserWarning:|To exit: use)/' \
    | grep -oE "$1" | tail -n1 || true
}

# Запуск VM-команды с ожиданием честного rc=0 (маркер SH_OK).
vm_sh_ok() { # $1 = команда, $2 = таймаут
  local out rc=0
  out="$(vm_sh "$1" "${2:-120}")" || rc=1
  [ "$rc" -eq 0 ] || printf '%s\n' "$out" >&2
  return "$rc"
}

# Запуск долгой команды на VM ЧЕРЕЗ colabctl bg (setsid — переживает закрытие
# exec-канала; лог пишется командой в $VM_STATE/<name>.rc/лог). Возврат сразу.
vm_bg_launch() { # $1 = имя, $2 = команда (сама пишет rc-файл $VM_STATE/<name>.rc)
  local name="$1" cmd="$2" out attempt refreshed=0
  vm_sh_ok "rm -f $VM_STATE/$name.rc" 60 || return 1
  # Ретраи как у vm_sh: единичный transport-фейл colabctl bg (kernel-check
  # timeout / response-loss) не должен валить весь деплой (инцидент 29.09:
  # ведж 36мин → kill → первый же bg-вызов словил kernel-check timeout → die).
  for attempt in 1 2 3; do
    if out="$("$COLABCTL" bg -c "$cmd" -n "$name" 2>&1)" \
       && printf '%s' "$out" | grep -q 'RUN_OK'; then
      return 0
    fi
    [ "$attempt" -lt 3 ] || {
      log "colabctl bg $name не запустился за 3 попытки: ${out:0:200}"
      return 1
    }
    if [ "$attempt" -ge 2 ] && [ "$refreshed" -eq 0 ]; then
      log "colabctl bg $name транспортный сбой ×$attempt — обновляю runtime-proxy-token"
      timeout 170 "$COLABCTL" refresh >/dev/null 2>&1 || true
      refreshed=1
    fi
    log "colabctl bg $name транспортный сбой (попытка $attempt/3), ждём 15с: ${out:0:200}"
    sleep 15
  done
  return 1
}

# Повтор с ретраями (транспорт Colab иногда роняет единичный вызов).
vm_retry() { # $1 = попытки, $2 = команда, $3 = таймаут
  local n="$1" cmd="$2" t="${3:-120}" i out
  for ((i = 1; i <= n; i++)); do
    if out="$(vm_sh "$cmd" "$t" 2>&1)"; then
      printf '%s' "$out"
      return 0
    fi
    log "vm_sh попытка $i/$n не удалась, ждём 10с: ${out:0:200}"
    sleep 10
  done
  return 1
}

usage() {
  # до маркера '# Выход:' — заголовок растёт (fake-model-блок), фикс. диапазон
  # обрезал бы его и печатал бы хвост кода
  sed -n '2,/^# Выход:/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target требует значение}"; shift 2 ;;
    --no-key) INJECT_KEY="never"; shift ;;
    --inject-key) INJECT_KEY="always"; shift ;;
    --force-bundle) FORCE_BUNDLE=1; shift ;;
    --fake-model) FAKE_MODEL=1; shift ;;
    -h|--help) usage ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

# --- Разрешение target → профиль + git-реф бандла ----------------------------
# pristine  → профиль dsh-tui-pristine, патчи НЕ применяются, бандл не нужен.
# current   → профиль dsh-tui,          бандл из git archive HEAD.
# patches:X → профиль dsh-tui-ref-<san>, бандл из git archive X.
resolve_target() { # печать: <profile> <gitref|-> (глобально PROFILE, GIT_REF)
  local t="$1"
  PROFILE=""
  GIT_REF="-"
  case "$t" in
    pristine) PROFILE="dsh-tui-pristine" ;;
    current)  PROFILE="dsh-tui"; GIT_REF="HEAD" ;;
    patches:*)
      GIT_REF="${t#patches:}"
      [ -n "$GIT_REF" ] || die "пустой git-ref в target: $t"
      # валидация рефа локально — до любых VM-действий
      git -C "$REPO_DIR" rev-parse --verify "$GIT_REF^{commit}" >/dev/null 2>&1 \
        || git -C "$REPO_DIR" rev-parse --verify "$GIT_REF" >/dev/null 2>&1 \
        || die "git-ref не найден в репо: $GIT_REF"
      local san
      san="$(printf '%s' "$GIT_REF" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-24)"
      PROFILE="dsh-tui-ref-$san"
      ;;
    *) die "неизвестный target: $t (ожидались pristine|current|patches:<ref>)" ;;
  esac
  export PROFILE GIT_REF
}

# --- Шаг 1: VM up (idempotent) ------------------------------------------------
vm_up() {
  # Быстрый путь: VM из прошлых прогонов УЖЕ жива — colabctl up НЕ вызываем:
  # его строгая bootstrap-верификация (VM-Claude обязан ответить ровно "OK")
  # флакает на живой сессии (модель отвечает болтливо) и может висеть.
  if out="$(vm_sh 'echo VM_READY' 60 2>/dev/null)" && printf '%s' "$out" | grep -q VM_READY; then
    log "шаг 1: VM уже жива (быстрый ping, без colabctl up)"
    return 0
  fi
  log "шаг 1: colabctl up (idempotent, до 3 попыток; VM на ping не ответила)"
  local i out up_failed=0
  for ((i = 1; i <= 3; i++)); do
    # внешний таймаут: сам colabctl up может висеть на мёртвом exec-канале
    if out="$(timeout 300 "$COLABCTL" up 2>&1)"; then
      break
    fi
    if [ "$i" -ge 3 ]; then
      # up может сфейлить на строгой bootstrap-верификации (VM-модель обязана
      # ответить ровно "OK", но иногда отвечает болтливо), при этом VM жива и
      # здорова. Решающий факт — живой shell, а не rc up.
      log "colabctl up 3× не удался; проверяем живость VM напрямую: $(printf '%s' "$out" | tail -2 | head -1)"
      up_failed=1
    else
      log "colabctl up попытка $i не удалась (${out:0:160}), ждём 15с"
      sleep 15
    fi
  done
  # Дождаться живого shell: сессия может подниматься после присвоения.
  for ((i = 1; i <= 20; i++)); do
    if out="$(vm_sh 'echo VM_READY' 60 2>/dev/null)" && printf '%s' "$out" | grep -q VM_READY; then
      log "VM жива (попытка $i${up_failed:+, несмотря на rc colabctl up})"
      return 0
    fi
    sleep 10
  done
  die "VM shell не отвечает 200с (colabctl status для диагностики)"
}

# --- Шаг 2: apt + Node >= 22 ---------------------------------------------------
ensure_node22() {
  log "шаг 2: apt tmux/patch + node >= ${NODE_VERSION}"
  vm_sh_ok "command -v tmux >/dev/null && command -v patch >/dev/null || (apt-get update -qq && apt-get install -y -qq tmux patch) >/dev/null 2>&1" 300 \
    || die "apt install tmux/patch не удался"
  local vmver
  vmver="$(vm_retry 3 'node -v' 60)" || die "node -v не отвечает на VM"
  if [[ "$vmver" =~ v([0-9]+)\. ]] && [ "${BASH_REMATCH[1]}" -ge 22 ]; then
    log "node на VM уже >= 22: $vmver"
    return 0
  fi
  log "node на VM $vmver < 22 — установка tarball v${NODE_VERSION} в /usr/local"
  vm_sh_ok "curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1" 420 \
    || die "tarball node ${NODE_VERSION} не скачался/не распаковался"
  vmver="$(vm_retry 3 'node -v' 60)" || die "node -v не отвечает после установки"
  [[ "$vmver" =~ v([0-9]+)\. ]] && [ "${BASH_REMATCH[1]}" -ge 22 ] \
    || die "node после установки всё ещё < 22: $vmver"
  log "node на VM: $vmver"
}

# --- Шаг 3: глобальные пакеты dsh + pnpm --------------------------------------
# Долгая установка идёт через colabctl bg + poll rc-файла (nohup-семантика).
bg_poll() { # $1 = имя bg-задачи, $2 = rc-файл, $3 = таймаут сек
  local name="$1" rcfile="$2" tmo="$3" i rc
  for ((i = 1; i <= tmo / 10; i++)); do
    rc="$(vm_scalar '[0-9]+' "cat $rcfile 2>/dev/null || true" 60)"
    if [ -n "${rc:-}" ]; then
      [ "$rc" = "0" ] && return 0
      log "bg-задача $name rc=$rc (лог: $VM_STATE/${name}.log)"
      vm_sh "tail -30 $VM_STATE/${name}.log 2>/dev/null" 60 | sed 's/^/    /' >&2 || true
      return 1
    fi
    sleep 10
  done
  log "bg-задача $name не завершилась за ${tmo}с (лог: $VM_STATE/${name}.log)"
  vm_sh "tail -30 $VM_STATE/${name}.log 2>/dev/null" 60 | sed 's/^/    /' >&2 || true
  return 1
}

ensure_globals() {
  log "шаг 3: npm i -g dsh@${DSH_CLI_VERSION} pnpm@${PNPM_VERSION} (+ пин-набор cordis = Zorin-референс)"
  vm_sh_ok "mkdir -p $VM_STATE" 60 || die "не создан $VM_STATE"
  local want cordis_now
  want="$(vm_sh "dsh --version 2>/dev/null | head -1; pnpm --version 2>/dev/null | head -1" 90 || true)"
  cordis_now="$(vm_scalar '[0-9]+(\.[0-9]+)+' "grep -m1 '\"version\"' /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/package.json 2>/dev/null | grep -o '[0-9][0-9.]*'" 90)"
  if printf '%s' "$want" | grep -q "$DSH_CLI_VERSION" && printf '%s' "$want" | grep -q "$PNPM_VERSION" \
     && [ "$cordis_now" = "$CORDIS_PIN" ]; then
    log "глобальные dsh/pnpm уже на месте (cordis $cordis_now = пин)"
    return 0
  fi
  if ! printf '%s' "$want" | grep -q "$DSH_CLI_VERSION" || ! printf '%s' "$want" | grep -q "$PNPM_VERSION"; then
    vm_bg_launch globals \
      "npm i -g @deepseek-ai/dsh@${DSH_CLI_VERSION} pnpm@${PNPM_VERSION} >$VM_STATE/globals.log 2>&1; echo \$? >$VM_STATE/globals.rc" \
      || die "не смог запустить npm i -g через colabctl bg"
    bg_poll globals "$VM_STATE/globals.rc" 600 || {
      # response-loss: обрыв канала к ядру НЕ отменяет исполнение на VM —
      # rc-файл может получить код транспорта при отработавшем npm (кейс
      # 28.09: rc=31 при «added 457 packages» в логе). Фактическое состояние
      # глобалей важнее rc — перепроверяем перед смертью деплоя.
      want="$(vm_sh "dsh --version 2>/dev/null | head -1; pnpm --version 2>/dev/null | head -1" 90 || true)"
      printf '%s' "$want" | grep -q "$DSH_CLI_VERSION" \
        && printf '%s' "$want" | grep -q "$PNPM_VERSION" \
        && log "bg_poll globals rc≠0, но глобали фактически на месте — продолжаем (response-loss)" \
        || die "npm i -g (dsh+pnpm) не удался — см. $VM_STATE/globals.log"
    }
    vm_sh "dsh --version 2>/dev/null | head -1; pnpm --version 2>/dev/null | head -1" 90 | grep -q . \
      || die "dsh/pnpm не в PATH после установки"
  else
    log "dsh/pnpm на месте, но cordis ${cordis_now:-?} ≠ пин ${CORDIS_PIN} — пиним транзитивы"
  fi
  # Пин транзитивов глобали dsh к ПОЛНОМУ рабочему Zorin-набору (см. константы
  # выше): частичный пин ломается ERESOLVE (свежий plugin-timer требует
  # peer cordis ~4.0.4), полный набор peer-совместим. --no-save: не портить
  # package.json глобали; --ignore-scripts: чужие lifecycle-хуки.
  vm_bg_launch globals-pin \
    "cd /usr/local/lib/node_modules/@deepseek-ai/dsh && rm -rf node_modules/@deepseek-ai/cordis node_modules/@deepseek-ai/cordis-plugin-group node_modules/@deepseek-ai/cordis-plugin-hmr node_modules/@deepseek-ai/cordis-plugin-include node_modules/@deepseek-ai/cordis-plugin-loader node_modules/@deepseek-ai/cordis-plugin-timer && npm install --no-save --ignore-scripts --no-audit --no-fund ${CORDIS_PIN_SET} >$VM_STATE/globals-pin.log 2>&1; echo \$? >$VM_STATE/globals-pin.rc" \
    || die "не смог запустить пин-установку через colabctl bg"
  # bg_poll-сбой не фатален: настоящий гейт — версия cordis ниже (response-loss
  # может испортить rc при отработавшем npm install).
  bg_poll globals-pin "$VM_STATE/globals-pin.rc" 600 \
    || log "bg_poll globals-pin не подтвердился (возможен response-loss) — гейт по факту cordis ниже"
  cordis_now="$(vm_scalar '[0-9]+(\.[0-9]+)+' "grep -m1 '\"version\"' /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/package.json 2>/dev/null | grep -o '[0-9][0-9.]*'" 90)"
  [ "$cordis_now" = "$CORDIS_PIN" ] \
    || die "cordis после пина = ${cordis_now:-?}, ожидался ${CORDIS_PIN}"
  log "глобальные пакеты готовы (cordis $cordis_now = Zorin-референс)"
}

# --- Шаг 4: профиль = ТОЧНОЕ зеркало Zorin ------------------------------------
# Пит-стоп истории: свежий pnpm-resolve на VM падал с
# ERR_PNPM_NO_MATCHING_VERSION (@deepseek-ai/dsh-scope@>=0.1.2 <0.2.0-0),
# хотя registry отдаёт полный список версий. Лечение — не решать реестр
# заново, а воспроизвести дерево Zorin: тот же package.json (с file:-зависим.
# spot/mcp-lazy), тот же pnpm-lock.yaml, тот же spot/ — установка
# pnpm install --frozen-lockfile (все версии+integrity из lock).

# Передача локального файла на VM: embed base64 in Python script →
# colabctl exec -f (kernel API upload, один вызов ~4.5s для 769KB).
# Заменяет base64-чанки по 15KB через colabctl sh (34 чанка × 20s = 680s
# → deploy timeout). md5-контроль после передачи.
vm_upload_file() { # $1 = локальный файл, $2 = удалённый путь
  local local_f="$1" remote="$2" md5_local md5_remote script out attempt
  md5_local="$(md5sum "$local_f" | cut -d' ' -f1)"
  # Python-генератор: embeds file content as base64 in a script that
  # decodes+writes it at the remote path. base64 charset [A-Za-z0-9+/=]
  # is safe inside Python double-quoted string literals (no quotes/backslashes).
  script="$(mktemp --suffix=.py)"
  python3 - "$local_f" "$remote" "$script" <<'PYEOF'
import sys, base64, os
local_f, remote, script_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(local_f, 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('ascii')
with open(script_path, 'w') as out:
    out.write('import base64, os\n')
    out.write(f'data = "{b64}"\n')
    out.write(f'path = "{remote}"\n')
    out.write('os.makedirs(os.path.dirname(path) or ".", exist_ok=True)\n')
    out.write('with open(path, "wb") as f:\n')
    out.write('    f.write(base64.b64decode(data))\n')
    out.write('print("FILE_WRITTEN")\n')
PYEOF
  for attempt in 1 2 3; do
    out="$("$COLABCTL" exec -f "$script" 2>&1)" && break
    [ "$attempt" -lt 3 ] || { rm -f "$script"; log "exec -f failed for $local_f after 3 attempts: ${out:0:200}"; return 1; }
    log "exec -f attempt $attempt failed for $local_f: ${out:0:120} — retry in 5s"
    sleep 5
  done
  rm -f "$script"
  printf '%s' "$out" | grep -q 'FILE_WRITTEN' || { log "exec -f no FILE_WRITTEN for $local_f: ${out:0:200}"; return 1; }
  md5_remote="$(vm_scalar '[0-9a-f]{32}' "md5sum $remote 2>/dev/null | cut -d' ' -f1" 60)"
  [ "$md5_remote" = "$md5_local" ] || { log "md5 mismatch after exec -f: $local_f → $remote (got=${md5_remote:0:8} want=${md5_local:0:8})"; return 1; }
}

write_profile_files() { # $1 = имя профиля
  local p="$1"
  local pd="/root/.dsh/profiles/$p"
  vm_sh_ok "mkdir -p $pd" 60 || die "не создан каталог профиля $pd"
  # package.json — зеркало Zorin (file:-зависимость spot/mcp-lazy обязательна:
  # под неё в lock-файле записан импортер, frozen-lockfile требует совпадения).
  vm_sh_ok "cat > $pd/package.json <<'EOF'
{
  \"name\": \"dsh-profile-dsh-tui\",
  \"private\": true,
  \"dependencies\": {
    \"@deepseek-harness-tui/dsh-tui\": \"0.10.0-beta.4\",
    \"@yilinxiao/dsh-mcp-lazy\": \"file:./spot/mcp-lazy\"
  },
  \"dsh\": {
    \"profile\": {
      \"bundles\": [
        \"@deepseek-ai/dsh-base\",
        \"@deepseek-harness-tui/dsh-tui\",
        \"@yilinxiao/dsh-mcp-lazy\"
      ]
    }
  }
}
EOF" 60 || die "package.json профиля не записан"
  vm_sh_ok "cat > $pd/pnpm-workspace.yaml <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
EOF" 60 || die "pnpm-workspace.yaml не записан"
  vm_sh_ok "printf '[]\\n' > $pd/cordis.yml" 60 || die "cordis.yml не записан"
  # cordis.patch.yml — редуцированное зеркало Zorin: строки, нужные для boot
  # (presets — без них PermissionPresetService кидает исключение) и dsh-tui
  # (fullscreen: true — режим живой сессии юзера, где живут layout-баги),
  # + disable авто-захвата mcp-lazy (бандл монтируется, менеджер погашен).
  # Machine-local вставки (ленивые серверы с $HOME-путями) вырезаны.
  vm_sh_ok "cat > $pd/cordis.patch.yml <<'EOF'
# VM-профиль: редуцированное зеркало Zorin cordis.patch.yml (без machine-local вставок).
- id: approval
  config:
    policy: never
- id: permission
  config:
    presets:
      workspace-write:
        sandbox: workspace-write
        approval: ask
        name: workspace-write
        description: Write inside the workspace and permitted temporary directories; wider retries require approval.
      danger-full-access:
        sandbox: danger-full-access
        approval: never
        name: danger-full-access
        description: Full file access without approval prompts.
      workspace-write-noask:
        sandbox: workspace-write
        approval: never
        name: workspace-write-noask
        description: Write inside the workspace and permitted temporary directories without approval prompts.
- id: dsh-tui
  config:
    provider: deepseek-official
    fullscreen: true
    effort: max
    preset: !!js process.env.DSH_TUI_PRESET ?? undefined
    workspace: !!js process.env.DSH_TUI_WORKSPACE_TARGET ?? undefined
    sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ?? process.env.DSH_CC_RESUME_SESSION ?? undefined
    modes:
      - id: default
        plan: false
      - id: plan
        plan: true
      - id: full
        plan: false
        sandbox: danger-full-access
        approval: never
- id: mcp-lazy-manager
  disabled: true
- id: session-title-llm
  config:
    targetWords: 5
    targetCjkCharacters: 10
    maxInputBytes: 4096
    maxOutputTokens: 32
    timeoutMs: 60000
EOF" 60 || die "cordis.patch.yml не записан"
}

# Локальный seed профиля: spot/ (file:-плагин) + pnpm-lock.yaml из Zorin-профиля
# (read-only источник). Собирается в tar.gz и передаётся на VM одним файлом.
# Глобалы (НЕ печать): SEED_GZ = путь tar.gz, SEED_MD5 = чексумма. Вызывать
# БЕЗ $() — командная подстановка съедает глобалы.
SEED_GZ=""
SEED_MD5=""
build_profile_seed() {
  local tmp src="$HOME/.dsh/profiles/dsh-tui"
  tmp="$(mktemp -d)"
  tar -C "$src" -czf "$tmp/seed.tar.gz" spot pnpm-lock.yaml \
    || { rm -rf "$tmp"; die "seed (spot+lock) не собрался из $src"; }
  SEED_MD5="$(md5sum "$tmp/seed.tar.gz" | cut -d' ' -f1)"
  SEED_GZ="$tmp/seed.tar.gz"
}

ensure_profile() { # $1 = имя профиля
  local p="$1"
  local pd="/root/.dsh/profiles/$p"
  log "шаг 4: профиль $p (зеркало Zorin + frozen-lockfile)"
  local installed
  installed="$(vm_sh "grep -m1 '\"version\"' $pd/node_modules/@deepseek-harness-tui/dsh-tui/package.json 2>/dev/null || true" 60 || true)"
  if printf '%s' "$installed" | grep -q '0.10.0-beta.4'; then
    log "профиль $p уже установлен (0.10.0-beta.4)"
    return 0
  fi
  write_profile_files "$p"
  # seed: spot/ + pnpm-lock.yaml (md5-гейт — повторно не передавать).
  # Гейт per-profile: глобальный seed.md5 совпадает между профилями, а
  # распаковка шла в предыдущий $pd — fresh-профиль (patches:ref) без
  # pnpm-lock.yaml ловит ERR_PNPM_NO_LOCKFILE. Условие: md5 читается
  # ТОЛЬКО если lockfile есть в целевом профиле.
  local seed_remote_md5
  build_profile_seed
  seed_remote_md5="$(vm_scalar '[0-9a-f]{32}' "test -f $pd/pnpm-lock.yaml && cat $VM_STATE/seed.md5 2>/dev/null || true" 60)"
  if [ "$seed_remote_md5" != "$SEED_MD5" ]; then
    log "передача seed профиля (spot+lock, $(du -h "$SEED_GZ" | cut -f1))"
    vm_upload_file "$SEED_GZ" "$VM_LIVE_DIR/seed.tar.gz" \
      || { rm -rf "$(dirname "$SEED_GZ")"; die "seed не передался"; }
    vm_sh_ok "cd $pd && tar -xzf $VM_LIVE_DIR/seed.tar.gz && echo '$SEED_MD5' > $VM_STATE/seed.md5" 120 \
      || { rm -rf "$(dirname "$SEED_GZ")"; die "seed не распаковался в $pd"; }
  else
    log "seed не изменился (md5 совпал)"
  fi
  rm -rf "$(dirname "$SEED_GZ")"
  log "pnpm install --frozen-lockfile --ignore-scripts в $pd (colabctl bg + poll)"
  vm_bg_launch "pnpm-$p" \
    "cd $pd && pnpm install --frozen-lockfile --ignore-scripts >$VM_STATE/pnpm-$p.log 2>&1; echo \$? >$VM_STATE/pnpm-$p.rc" \
    || die "не смог запустить pnpm install через colabctl bg"
  # bg_poll-сбой не фатален: настоящий гейт — наличие dsh-tui в профиле ниже
  # (response-loss: rc-файл может получить код транспорта при успешном pnpm).
  bg_poll "pnpm-$p" "$VM_STATE/pnpm-$p.rc" 900 \
    || log "bg_poll pnpm-$p не подтвердился (возможен response-loss) — гейт по факту пакета ниже"
  installed="$(vm_sh "grep -m1 '\"version\"' $pd/node_modules/@deepseek-harness-tui/dsh-tui/package.json 2>/dev/null || true" 60 || true)"
  printf '%s' "$installed" | grep -q '0.10.0-beta.4' \
    || die "после pnpm install пакет dsh-tui не найден в $pd"
  log "профиль $p установлен"
}

# --- Шаг 5: патч-бандл (git archive → tar.gz → base64-чанки → VM) -------------
# Бандл собирается из ЗАКОММИЧЕННОГО состояния (git archive), не из рабочей
# копии: Colab-прогон — это стейджинг-проверка коммита перед сдачей.
BUNDLE_TMP=""
BUNDLE_MD5=""

# Глобалы (не печать!): BUNDLE_TMP = временный каталог, BUNDLE_MD5 = чексумма.
# Вызывать БЕЗ $() — командная подстановка съедает глобалы и ломает md5-гейт.
bundle_local() { # $1 = gitref
  local ref="$1" tmp
  tmp="$(mktemp -d)"
  git -C "$REPO_DIR" archive "$ref" \
      dsh-overrides/patches scripts/apply-dsh-overrides.sh \
      dsh-overrides/core-patches scripts/apply-dsh-core-overrides.sh \
      dsh-overrides/settings/bin \
    | gzip > "$tmp/bundle.tar.gz" \
    || { rm -rf "$tmp"; die "git archive $ref не собрался"; }
  BUNDLE_MD5="$(md5sum "$tmp/bundle.tar.gz" | cut -d' ' -f1)"
  BUNDLE_TMP="$tmp"
}

transfer_bundle() { # $1 = путь tar.gz, $2 = md5, $3 = имя цели (для маркеров)
  local gz="$1" md5="$2" tag="$3"
  log "передача бандла через exec -f: $(du -h "$gz" | cut -f1) (md5 $md5)"
  vm_upload_file "$gz" "$VM_LIVE_DIR/bundle.tar.gz" \
    || die "бандл не передался через exec -f"
  # Распаковка + md5-контроль на месте.
  vm_sh_ok "cd $VM_LIVE_DIR && md5sum bundle.tar.gz | cut -d' ' -f1 | grep -qxF '$md5' && rm -rf $VM_REPO && mkdir -p $VM_REPO && tar -xzf bundle.tar.gz -C $VM_REPO && echo '$md5' > $VM_STATE/bundle-$tag.md5 && rm -f bundle.tar.gz" 180 \
    || die "распаковка/md5 бандла на VM не прошли"
  log "бандл передан и распакован (md5 $md5)"
}

ensure_bundle() { # глобально: PROFILE, GIT_REF, FORCE_BUNDLE
  [ "$GIT_REF" != "-" ] || return 0   # pristine: бандл не нужен
  local tag remote_md5
  tag="$(printf '%s' "$GIT_REF" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-24)"
  bundle_local "$GIT_REF"
  local gz="$BUNDLE_TMP/bundle.tar.gz"
  remote_md5="$(vm_scalar '[0-9a-f]{32}' "cat $VM_STATE/bundle-$tag.md5 2>/dev/null || true" 60)"
  if [ "$FORCE_BUNDLE" -eq 0 ] && [ "$remote_md5" = "$BUNDLE_MD5" ] \
     && vm_sh_ok "test -f $VM_REPO/scripts/apply-dsh-overrides.sh" 60; then
    log "шаг 5: бандл $tag не изменился (md5 совпал) — пропускаю передачу"
  else
    log "шаг 5: передача патч-бандла ($GIT_REF)"
    transfer_bundle "$gz" "$BUNDLE_MD5" "$tag"
  fi
  rm -rf "$BUNDLE_TMP"
}

apply_patches() { # $1 = профиль
  [ "$GIT_REF" != "-" ] || { log "шаг 6: pristine — патчи не применяются"; return 0; }
  log "шаг 6: apply-dsh-overrides.sh → профиль $1"
  # rc apply-скрипта не терять в пайпе: лог в файл, хвост в вывод, честный exit.
  # Retry-once: известная особенность стека — патч 40 (plugin.js hunk ctxBarMode)
  # использует как контекст строки ручной правки живой Zorin-сессии («Wave C
  # status-bar fields», их нет ни в одном патче). На ЧИСТОМ профиле этот hunk
  # не ложится (остальные 5 файлов патча 40 применяются), patch возвращает
  # rc=1 → failed=1. Идемпотентность apply-скрипта (маркер 40 в
  # animationsMode.js) делает повторный прогон зелёным: 40 → already applied
  # → skipped. Второй прогон допускает ТОЛЬКО маркерные skipped; реальные
  # расхождения после него всё равно дают failed>0 → деплой честно умирает.
  local out out2
  out="$(vm_sh "cd $VM_REPO && DSH_PROFILE=$1 bash scripts/apply-dsh-overrides.sh >$VM_STATE/apply.log 2>&1; rc=\$?; tail -6 $VM_STATE/apply.log; exit \$rc" 540)" \
    || true
  if printf '%s\n' "$out" | grep -q 'failed=0'; then
    log "патч-стек применён:
$out"
    return 0
  fi
  log "первый apply-прогон не зелёный — повтор (идемпотентность по маркерам):
$out"
  out2="$(vm_sh "cd $VM_REPO && DSH_PROFILE=$1 bash scripts/apply-dsh-overrides.sh >$VM_STATE/apply2.log 2>&1; rc=\$?; tail -6 $VM_STATE/apply2.log; exit \$rc" 540)" \
    || die "apply-dsh-overrides.sh упал на VM (лог: $VM_STATE/apply2.log)"
  printf '%s\n' "$out2" | grep -q 'failed=0' \
    || die "apply-dsh-overrides.sh: failed>0 после retry:
$out2"
  log "патч-стек применён (retry):
$out2"
}

# --- Шаг 6c: core-патчи @deepseek-ai/* (глобаль CLI + профильные копии) --------
# Core-патчи (манифест dsh-overrides/core-patches/manifest.conf) правят пакеты
# рантайма агента (agent-loop, llm-retry, ...) во ВСЕХ копиях на VM. Layout VM
# (проверен 2026-09-22): глобаль CLI — вложенные копии
# /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*;
# профильные копии @deepseek-ai/* в hoisted-профиле НЕТ (dsh-tui их не
# тянет) — discover_targets скрипта находит обе группы сам (realpath dsh +
# find ~/.dsh/profiles). Свежие npm-копии совпадают с orig_md5 манифеста →
# чистый apply; повторный прогон видит маркеры → skipped. Retry-once как у
# UI-apply: одиночный rc!=0 у patch(1) (fuzz/маркер) на повторе даёт
# already-applied; rc!=0 после повтора = честный die.
apply_core_patches() { # глобально: GIT_REF, VM_REPO
  [ "$GIT_REF" != "-" ] || { log "шаг 6c: pristine — core-патчи не применяются"; return 0; }
  log "шаг 6c: apply-dsh-core-overrides.sh (глобаль CLI + профильные копии)"
  local out out2
  if out="$(vm_sh "cd $VM_REPO && bash scripts/apply-dsh-core-overrides.sh >$VM_STATE/core-apply.log 2>&1; rc=\$?; tail -8 $VM_STATE/core-apply.log; exit \$rc" 540)"; then
    log "core-патчи применены (rc=0):
$out"
    return 0
  fi
  log "первый core-apply не зелёный — повтор (идемпотентность по маркерам):
$out"
  out2="$(vm_sh "cd $VM_REPO && bash scripts/apply-dsh-core-overrides.sh >$VM_STATE/core-apply2.log 2>&1; rc=\$?; tail -8 $VM_STATE/core-apply2.log; exit \$rc" 540)" \
    || die "apply-dsh-core-overrides.sh: failed после retry (лог: $VM_STATE/core-apply2.log):
$out2"
  log "core-патчи применены (retry):
$out2"
}

# --- Шаг 7a: темы юзера (~/.dsh-tui/themes) — часть зеркала профиля ------------
# Темы = JSON-файлы (~200K): /theme-пикер их листает, settings.yaml ссылается
# (tokyonight-moon). Без них на VM пикер показывает только 3 встроенных
# (auto/dark/light) и тема из настроек не резолвится. Перенос тем же
# base64-каналом, md5-гейт: повторный прогон не передаёт заново.
ensure_themes() {
  local src="$HOME/.dsh-tui/themes"
  if [ ! -d "$src" ] || [ -z "$(ls -A "$src" 2>/dev/null)" ]; then
    log "шаг 7a: локальных тем нет ($src) — пропуск"
    return 0
  fi
  local tmp gz md5 remote_md5
  tmp="$(mktemp -d)"
  tar -C "$HOME/.dsh-tui" -czf "$tmp/themes.tar.gz" themes \
    || { rm -rf "$tmp"; die "themes tar не собрался"; }
  gz="$tmp/themes.tar.gz"
  md5="$(md5sum "$gz" | cut -d' ' -f1)"
  remote_md5="$(vm_scalar '[0-9a-f]{32}' "cat $VM_STATE/themes.md5 2>/dev/null || true" 60)"
  if [ "$remote_md5" = "$md5" ] && vm_sh_ok "ls /root/.dsh-tui/themes/*.json >/dev/null 2>&1" 60; then
    log "шаг 7a: темы уже на VM (md5 совпал)"
  else
    log "шаг 7a: передача тем ($(du -h "$gz" | cut -f1), $(ls -1 "$src" | wc -l) шт.)"
    # Каталог ДО передачи: чанки пишутся в /root/.dsh-tui/*.b64.pNNN, а mkdir
    # раньше жил только в шаге распаковки (после успешной передачи) — на
    # свежей VM redirect в несуществующий каталог = SH_FAIL каждого чанка
    # (поймано 2026-09-20: «темы не передались» 3 деплой-прогона подряд).
    vm_sh_ok "mkdir -p /root/.dsh-tui" 60 || { rm -rf "$tmp"; die "не создан /root/.dsh-tui"; }
    vm_upload_file "$gz" "/root/.dsh-tui/themes.tar.gz" \
      || { rm -rf "$tmp"; die "темы не передались"; }
    vm_sh_ok "mkdir -p /root/.dsh-tui && rm -rf /root/.dsh-tui/themes && tar -xzf /root/.dsh-tui/themes.tar.gz -C /root/.dsh-tui && echo '$md5' > $VM_STATE/themes.md5 && rm -f /root/.dsh-tui/themes.tar.gz" 90 \
      || { rm -rf "$tmp"; die "темы не распаковались на VM"; }
  fi
  rm -rf "$tmp"
  log "шаг 7a: темы на VM: $(vm_sh "ls -1 /root/.dsh-tui/themes/*.json 2>/dev/null | wc -l" 60) шт."
}

# --- Шаг 7: settings.yaml (bg-провайдер, без секрета) --------------------------
ensure_settings() {
  log "шаг 7: /root/.dsh/settings.yaml (bg-провайдер, dsh-tui-секция = Zorin)"
  # --fake-model: прежний agent-default-model → .bak ДО перезаписи (лениво —
  # restore делает прогон БЕЗ флага); файл пишем целиком heredoc'ом в стиле
  # шага 7 (текстовый подход, pyyaml на VM не нужен).
  if [ "$FAKE_MODEL" -eq 1 ]; then
    fake_backup_default_model || die "не сохранился /root/.dsh-default-model.bak"
  fi
  local adm prov
  if [ "$FAKE_MODEL" -eq 1 ]; then
    adm="agent-default-model:
  provider: fake
  model: fake-sonnet"
    prov="    fake:
      displayName: Fake LLM (local)
      api: anthropic-messages
      apiKeyEnv: FAKE_LLM_KEY
      baseURL: http://127.0.0.1:8787
      models:
      - id: fake-sonnet
        name: Fake Sonnet (local)
        contextWindow: 262144
        maxTokens: 32768"
  else
    adm="agent-default-model:
  provider: bg
  model: glm-5.3"
    prov=""
  fi
  # heredoc с локальной подстановкой $adm/$prov (в YAML нет $/бектиков —
  # двойного раскрытия на VM не возникает; маркер quoted = тело литерально)
  vm_sh_ok "mkdir -p /root/.dsh && cat > /root/.dsh/settings.yaml <<'EOF'
# VM-деплой: минимальный рантайм для live-TUI-прогона (без секретов;
# ключ живёт в .credentials.yaml и резолвится лениво).
$adm
llm-pi-ai:
  providers:
    bg:
      api: anthropic-messages
      apiKeyEnv: DSH_BG_API_KEY
      baseURL: https://relay.example.com
      models:
      - id: glm-5.3
      retryPolicy:
        mode: normal
        maxRetries: 37
        backoff:
          maxDelayMs: 120000
$prov
dsh-tui:
  statusBar:
    tokens: true
    compact: false
    contextBar: true
    mode: true
    trajectory: true
    shortcutHint: true
    activity: true
    cache: true
    gitBranch: true
    compactThresholdRatio: 0.4768
  fullscreen: false
  minimal: false
  toolBackground: subtle
  appearance:
    powerline: full
    theme: tokyonight-moon
    inputBorder: '#7aa2f7'
    animations: false
    cwdMode: compact
EOF" 120 || die "settings.yaml не записан на VM"
}

# --- Шаг 7f: dsh-fake-llm (--fake-model) --------------------------------------
# Сохранить прежний agent-default-model (текстовый блок из settings.yaml VM)
# в /root/.dsh-default-model.bak — ДО перезаписи настроек. Идемпотентность:
# прежняя модель уже fake → .bak не трогаем (бэкап bg-дефолта переживает
# повторные --fake-model-прогоны). Блока/файла нет (свежая VM) → .bak =
# bg-дефолт деплоя (restore даёт то же состояние, что и не-флаг-прогон).
fake_backup_default_model() {
  local old
  old="$(vm_sh "awk '/^agent-default-model:/{f=1} f && !/^agent-default-model:/ && length(\$0) > 0 && substr(\$0,1,1) != \" \" {exit} f{print}' /root/.dsh/settings.yaml 2>/dev/null || true" 60 || true)"
  if [ -n "$old" ] && printf '%s' "$old" | grep -q 'provider: fake'; then
    log "agent-default-model уже fake — /root/.dsh-default-model.bak не трогаю (идемпотентно)"
    return 0
  fi
  if [ -z "$old" ]; then
    log "settings.yaml на VM нет/без agent-default-model — .bak = bg-дефолт деплоя"
    old="agent-default-model:
  provider: bg
  model: glm-5.3"
  fi
  vm_sh_ok "cat > /root/.dsh-default-model.bak <<'BAKEOF'
$old
BAKEOF" 60 || return 1
  log "прежний agent-default-model сохранён в /root/.dsh-default-model.bak"
}

# Health-гейт фейк-сервера: /health отвечает "ok":true.
# ВАЖНО '; echo' в конце: curl -s не даёт завершающего \n, маркер SH_OK
# colabctl-обёртки клеится к JSON в одну строку — vm_sh не находит маркер
# в хвосте, объявляет транспорт порванным и возвращает сбой (лечено
# 2026-09-22: ложные рестарты живого сервера + die до записи live-target).
fake_health_ok() {
  local h
  h="$(vm_sh "curl -s http://127.0.0.1:8787/health 2>/dev/null || true; echo" 30 || true)"
  printf '%s' "$h" | grep -q '"ok":true'
}

# Опрос health на VM одним вызовом транспорта (до 20×1с, как спека).
fake_health_poll() {
  vm_sh_ok "for w in \$(seq 1 20); do curl -s http://127.0.0.1:8787/health 2>/dev/null | grep -q '\"ok\":true' && { echo HEALTH_OK; exit 0; }; sleep 1; done; echo HEALTH_FAIL; exit 1" 60 \
    || { log "фейк-сервер не поднял health за 20с (лог: /root/dsh-fake-llm/server.log)"; vm_sh "tail -20 /root/dsh-fake-llm/server.log 2>/dev/null" 60 | sed 's/^/    /' >&2 || true; return 1; }
}

# Деплой dsh-fake-llm на VM + запуск сервера. Транспорт — tar.gz одним файлом
# через vm_upload_file (rsync/scp на Colab-VM нет; base64-канал + md5-гейт).
# Тар из РАБОЧЕГО дерева, не git archive: сценарий waves.json дописывается
# параллельным агентом и может быть не закоммичен на момент прогона; md5-гейт
# ловит обновление и форсирует перезапуск (README: правка JSON требует рестарта).
# Сервер поднимается через colabctl bg: vm_sh с `&`/setsid клинит exec-канал
# (~10 мин, memory colab-exec-chunk-channel); bg сам детачит и переживает
# закрытие канала.
ensure_fake_model() {
  log "шаг 7f: dsh-fake-llm → /root/dsh-fake-llm + сервер :8787"
  local tmp gz md5 remote_md5 restart=0
  tmp="$(mktemp -d)"
  tar -C "$REPO_DIR/tools/dsh-fake-llm" -czf "$tmp/fake-llm.tar.gz" \
      server.mjs lib scenarios selftest.mjs package.json \
    || { rm -rf "$tmp"; die "tar dsh-fake-llm не собрался"; }
  gz="$tmp/fake-llm.tar.gz"
  md5="$(md5sum "$gz" | cut -d' ' -f1)"
  remote_md5="$(vm_scalar '[0-9a-f]{32}' "cat $VM_STATE/fake-llm.md5 2>/dev/null || true" 60)"
  if [ "$remote_md5" = "$md5" ] && vm_sh_ok "test -f /root/dsh-fake-llm/server.mjs" 60; then
    log "dsh-fake-llm уже на VM (md5 совпал)"
  else
    log "передача dsh-fake-llm ($(du -h "$gz" | cut -f1))"
    vm_upload_file "$gz" /root/dsh-fake-llm.tar.gz \
      || { rm -rf "$tmp"; die "dsh-fake-llm не передался на VM"; }
    vm_sh_ok "rm -rf /root/dsh-fake-llm; mkdir -p /root/dsh-fake-llm && tar -xzf /root/dsh-fake-llm.tar.gz -C /root/dsh-fake-llm && echo '$md5' > $VM_STATE/fake-llm.md5 && rm -f /root/dsh-fake-llm.tar.gz" 90 \
      || { rm -rf "$tmp"; die "dsh-fake-llm не распаковался на VM"; }
    restart=1
  fi
  rm -rf "$tmp"
  if [ "$restart" -eq 0 ] && fake_health_ok; then
    log "фейк-сервер уже жив (health ok), код не менялся — не перезапускаю"
  else
    log "запуск фейк-сервера через colabctl bg (PORT=8787 STREAM_TOTAL_MS=45000)"
    # pkill и запуск — РАЗНЫЕ colabctl-обёртки: паттерн pkill матчит текст
    # node-аргумента (server.mjs) в ОДНОЙ команде → pkill убивает сам свою
    # обёртку (rc=-15, server.log не создаётся). Разносим на два вызова.
    vm_sh_ok "pkill -f 'dsh-fake-llm/server[.]mjs' 2>/dev/null; sleep 1; echo FAKE_KILLED" 60 || true
    # Демон — ТОЛЬКО через colabctl bg: vm_sh с `&`/setsid клинит exec-канал
    # ~10 мин (memory colab-exec-chunk-channel) — golden-62 2026-09-24 упал
    # 5/5 транспортных сбоев подряд на этой строке. bg сам детачит; вывод
    # сервера → server.log, rc-файл не нужен: живость меряет health-гейт.
    vm_bg_launch fake-llm "cd /root/dsh-fake-llm && env PORT=8787 STREAM_TOTAL_MS=45000 node /root/dsh-fake-llm/server.mjs > /root/dsh-fake-llm/server.log 2>&1 < /dev/null" \
      || die "фейк-сервер не запустился на VM (colabctl bg)"
    fake_health_poll || die "health фейк-сервера не поднялся"
  fi
  log "фейк-сервер здоров: http://127.0.0.1:8787/health (STREAM_TOTAL_MS=45000)"
}

# Прогон БЕЗ --fake-model: восстановить agent-default-model из .bak (если
# существует; ensure_settings уже вернул bg-дефолт, .bak возвращает прежнюю
# модель, если она отличалась) и погасить фейк-сервер. Замена блока —
# python3 без pyyaml (текстово: блок agent-default-model до следующего
# ключа верхнего уровня ← содержимое .bak).
disable_fake_model() {
  vm_sh_ok "if [ -f /root/.dsh-default-model.bak ]; then
python3 - <<'PYEOF'
bak = open('/root/.dsh-default-model.bak').read()
path = '/root/.dsh/settings.yaml'
lines = open(path).read().splitlines(True)
out = []
i = 0
while i < len(lines):
    if lines[i].rstrip() == 'agent-default-model:':
        j = i + 1
        while j < len(lines) and (lines[j].startswith(' ') or lines[j].strip() == ''):
            j += 1
        out.append(bak)
        i = j
    else:
        out.append(lines[i])
        i += 1
open(path, 'w').write(''.join(out))
print('ADM_RESTORED')
PYEOF
else echo NO_BAK; fi; pkill -f 'dsh-fake-llm/server[.]mjs' 2>/dev/null || true; echo FAKE_SERVER_STOPPED" 90 \
    || die "возврат к реальной модели (restore .bak / pkill) не удался"
  log "шаг 7f: без --fake-model — agent-default-model из .bak (если был), фейк-сервер погашен"
}

# --- Шаг 8: секрет (только через base64-канал, никогда в командной строке) ----
# Возвращает 0 если ключ на VM присутствует (или не нужен).
vm_key_present() {
  vm_sh_ok "grep -q 'DSH_BG_API_KEY' $VM_CRED 2>/dev/null" 60
}

# Читает локальный refs.DSH_BG_API_KEY (значение НИКОГДА не печатается) и
# передаёт файл на VM тем же base64-каналом, что и бандл.
inject_credentials() {
  [ -f "$LOCAL_CRED" ] || { log "локальный $LOCAL_CRED отсутствует — ключ не вводится"; return 1; }
  local tmp b64
  tmp="$(mktemp -d)"
  python3 - "$LOCAL_CRED" "$tmp/cred.yaml" <<'PYEOF'
import sys, yaml
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    d = yaml.safe_load(f)
key = (d.get("refs") or {}).get("DSH_BG_API_KEY")
if not key:
    sys.exit("no DSH_BG_API_KEY in local credentials")
with open(dst, "w") as f:
    f.write(f"refs:\n  DSH_BG_API_KEY: {key}\nversion: {d.get('version', 1)}\n")
PYEOF
  [ -s "$tmp/cred.yaml" ] || { rm -rf "$tmp"; log "DSH_BG_API_KEY в локальных credentials не найден"; return 1; }
  b64="$(base64 -w0 "$tmp/cred.yaml")"
  rm -rf "$tmp"
  vm_sh_ok "mkdir -p /root/.dsh; rm -f $VM_LIVE_DIR/cred.b64; printf '%s' '$b64' | base64 -d > $VM_CRED && chmod 600 $VM_CRED" 60 \
    || die "инъекция credentials на VM не удалась"
  vm_key_present || die "credentials на VM не читаются после инъекции"
  log "ключ DSH_BG_API_KEY доставлен на VM ($VM_CRED, 0600)"
}

# --- Шаг 9: health-check + boot-smoke ------------------------------------------
# Boot-smoke: короткая загрузка TUI в tmux (20с), кадр текстом. Возвращает 0 при
# живом TUI; печать кадра в stdout для вызова. AUTH_FAIL — маркер, что boot
# упал по auth/ключу (тогда нужен inject).
TUI_SMOKE_SESS="dsh-smoke"

boot_smoke() { # $1 = профиль; печать: кадр (или вывод ошибки); rc: 0 ok, 2 auth-fail, 1 прочее
  local p="$1" frame err
  vm_sh_ok "tmux kill-session -t $TUI_SMOKE_SESS 2>/dev/null; true" 60 || true
  vm_sh "tmux new-session -d -s $TUI_SMOKE_SESS -x 180 -y 50 'dsh --profile $p; sleep 600'" 90 >/dev/null \
    || { echo "tmux-сессия не создалась"; return 1; }
  sleep 18
  frame="$(vm_sh "tmux capture-pane -p -t $TUI_SMOKE_SESS 2>/dev/null" 60 || true)"
  vm_sh_ok "tmux kill-session -t $TUI_SMOKE_SESS 2>/dev/null; true" 60 || true
  # Порядок важен: сначала проверка живого TUI (рамка ввода / hint) — токены
  # статус-бара могут случайно содержать 401/403, это НЕ auth-падение.
  if printf '%s' "$frame" | grep -qE '❯|for shortcuts|╭'; then
    printf '%s' "$frame"
    return 0
  fi
  err="$(printf '%s\n' "$frame" | grep -iE 'auth|credential|api[ _-]?key|unauthorized|403|401' | head -5 || true)"
  if [ -n "$err" ]; then
    printf '%s\n' "$err"
    return 2
  fi
  printf '%s' "$frame" | tail -20
  return 1
}

health_check() { # $1 = профиль; глобально GIT_REF
  local p="$1" out rc=0
  log "шаг 9: health-check профиля $p"
  out="$(vm_retry 3 'node -v' 60)"; [[ "$out" =~ v2[2-9]\. ]] || { log "node < 22: $out"; rc=1; }
  out="$(vm_retry 3 'dsh --version 2>/dev/null | head -1' 90)"; [ -n "$out" ] || { log "dsh --version пуст"; rc=1; }
  # dump-config: критерий = конфиг реально выдан (маркер '# ==') и нет падения.
  # 'entry "plugin-package-inventory-deepseek" not found' — ЗНАЧИТ безвредный
  # stderr-warning dsh-base (тот же вывод на живом Zorin, rc=0); 'not found'
  # как маркер фейла нельзя — ловит этот warning.
  out="$(vm_sh "dsh --profile $p --dump-config 2>&1 | head -3" 120 || true)"
  printf '%s' "$out" | grep -q '^# ==' && ! printf '%s' "$out" | grep -qi 'throw\|exception\|cannot find module' \
    || { log "dsh --dump-config некорректен: ${out:0:300}"; rc=1; }
  local tui_base="/root/.dsh/profiles/$p/node_modules/@deepseek-harness-tui/dsh-tui"
  if [ "$GIT_REF" != "-" ]; then
    vm_sh_ok "grep -q 'dsh-overrides 38: the /effects dashboard' $tui_base/lib/types/components/EffectsPanel.js" 60 \
      || { log "маркер патча 38 отсутствует (стек не применён?)"; rc=1; }
    # core-патчи: все цели всех секций = patched (unpatched/unknown = 0).
    # --status печатает [state] на каждую цель; парсим вывод, а не rc
    # (status-действие скрипта всегда rc=0).
    local core_bad
    core_bad="$(vm_scalar '[0-9]+' "cd $VM_REPO && bash scripts/apply-dsh-core-overrides.sh --status 2>/dev/null | grep -cE '\\[(unpatched|unknown)\\]' || true" 120)"
    [ "$core_bad" = "0" ] || { log "core-патчи: $core_bad целей не patched (core-стек не применён?)"; rc=1; }
  else
    vm_sh_ok "! grep -q 'dsh-overrides 38' $tui_base/lib/types/components/EffectsPanel.js 2>/dev/null" 60 \
      || { log "pristine: маркер патча 38 присутствует (профиль не pristine!)"; rc=1; }
    # Глобаль CLI общая для всех профилей: core-патчи из прошлого current-деплоя
    # НЕ откатываем автоматически (следующий current всё равно вернёт их; revert
    # на live-глобали — отдельная осознанная операция). Честность pristine =
    # TUI-профиль без UI-патчей; core-патчи правят поведение агента, не рендер
    # TUI, UI-сравнения не затронуты — предупреждаем, не фейлим.
    if vm_sh_ok "test -d $VM_REPO" 60 2>/dev/null; then
      local core_patched
      core_patched="$(vm_scalar '[0-9]+' "cd $VM_REPO && bash scripts/apply-dsh-core-overrides.sh --status 2>/dev/null | grep -cE '\\[patched\\]' || true" 120)"
      [ "$core_patched" = "0" ] || [ -z "$core_patched" ] \
        || log "pristine: глобаль CLI несёт core-патчи ($core_patched целей) — поведение агента не upstream (TUI-рендер не затронут)"
    fi
  fi
  [ "$rc" -eq 0 ] || return "$rc"
  # boot-smoke с политикой ключа
  local smoke_out smoke_rc
  smoke_out="$(boot_smoke "$p")"; smoke_rc=$?
  if [ "$smoke_rc" -eq 0 ]; then
    log "boot-smoke: TUI живой"
  elif [ "$smoke_rc" -eq 2 ]; then
    if [ "$INJECT_KEY" = "never" ]; then
      log "boot-smoke: auth-ошибка, ключ запрещён (--no-key):
$smoke_out"
      return 1
    fi
    log "boot-smoke: auth-ошибка без ключа — инъекция DSH_BG_API_KEY"
    inject_credentials || return 1
    smoke_out="$(boot_smoke "$p")"; smoke_rc=$?
    [ "$smoke_rc" -eq 0 ] || { log "boot-smoke падает и с ключом (rc=$smoke_rc):
$smoke_out"; return 1; }
    log "boot-smoke после инъекции: TUI живой"
  else
    log "boot-smoke: TUI не поднялся (кадр/ошибка):
$smoke_out"
    return 1
  fi
  return 0
}

# --- main ----------------------------------------------------------------------
main() {
  resolve_target "$TARGET"
  log "target=$TARGET → профиль=$PROFILE, git-ref=$GIT_REF"
  log "VM-окружение: $VM_LIVE_DIR (repo/state), профиль /root/.dsh/profiles/$PROFILE"

  vm_up
  ensure_node22
  ensure_globals
  ensure_profile "$PROFILE"
  ensure_bundle
  apply_patches "$PROFILE"
  apply_core_patches
  ensure_settings
  ensure_themes
  if [ "$FAKE_MODEL" -eq 1 ]; then
    ensure_fake_model
  else
    disable_fake_model
  fi

  # Точка входа для SOC-программы: активный профиль.
  vm_sh_ok "printf '%s\\n' '$PROFILE' > $VM_TARGET_FILE" 60 \
    || die "не записан $VM_TARGET_FILE"

  # --inject-key (always): явная инъекция ДО health-check. Boot-smoke сам по
  # себе проходит без ключа (ленивый резолв — auth нужна только на реальном
  # turn), ветка smoke_rc==2 не наступает — а сьюту ctx-детектора ключ нужен.
  if [ "$INJECT_KEY" = "always" ]; then
    inject_credentials || die "инъекция DSH_BG_API_KEY не удалась (--inject-key)"
  fi

  health_check "$PROFILE" || die "health-check не прошёл для профиля $PROFILE"
  log "OK: VM готова, профиль $PROFILE здоров (target=$TARGET)"
  log "активный профиль для SOC-программы: $VM_TARGET_FILE = $PROFILE"
}

main "$@"
