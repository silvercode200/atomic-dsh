#!/usr/bin/env bash
# run.sh — golden smoke-сьют кеш-верификации dsh: одна команда.
#
# TG-DSH-CACHE-20260912 node 9. Сьют: tests/golden/suite.yaml (schemaVersion 1).
#
# Что делает:
#   1. prep: rsync канонического dsh-стека (~/.dsh минус sessions/logs/secrets)
#      на целевую машину в /tmp/dsh-golden/dsh-home; адаптация путей под цель;
#      применение патчей ядра (B2 sort/hide, B8 caveman) к dsh-установке цели.
#   2. сценарии a-f: TUI-сессии через PTY-драйвер (drive_session.py);
#      провайдер cli (relay Xeon), см. suite.yaml.
#      e = рольные субагенты (пин модели по дочерним сессиям),
#      f = план-мод рисёч+ (grill до exit_plan_mode, без мутаций).
#   4. анализ session-логов (analyze.py) и вердикты; отчёт в stdout +
#      reports/golden-run-<ts>/ в репо.
#
# Требования к целевой машине: SSH-доступ, node+dsh 0.1.1-rc.2, python3>=3.10,
# доступ к http://127.0.0.1:8350. По умолчанию цель vmdev (GOLDEN_TARGET).
#
# Секреты: DSH_CLI_AUTH_TOKEN НЕ логируется и НЕ попадает в отчёты —
# передаётся на цель в 0600-файл через stdin SSH, удаляется после прогона.
#
# Usage:
#   bash tests/golden/run.sh                 # полный прогон (vmdev)
#   GOLDEN_TARGET=host bash tests/golden/run.sh
#   bash tests/golden/run.sh --skip-prep     # повторный прогон без rsync
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TARGET="${GOLDEN_TARGET:-vmdev}"
GOLDEN_ROOT="/tmp/dsh-golden"
GOLDEN_HOME="$GOLDEN_ROOT/dsh-home"
WORK_DIR="$GOLDEN_ROOT/work"
REPORTS_DIR="$REPO/reports"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$REPORTS_DIR/golden-run-$TS"
SKIP_PREP=0
[[ "${1:-}" == "--skip-prep" ]] && SKIP_PREP=1

log() { printf '[golden] %s\n' "$*"; }
die() { printf '[golden] FATAL: %s\n' "$*" >&2; exit 1; }

# ssh-обёртка: login shell цели может быть fish (vmdev) — fish не понимает
# bash-цитирование ($'...'), поэтому команда передаётся ЧЕРЕЗ STDIN в bash -s:
# квотинг не нужен вообще. $VAR раскрываются локально при формировании строки.
ssh_t() {
	ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" bash -s <<<"$*"
}

# tar-пайп в цель: stdin занят потоком — bash -s нельзя; удалённая команда
# простая (имя + пути), fish её исполняет напрямую без shell-синтаксиса
ssh_tar() { # $1 = каталог-цель на удалённой машине
	ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" "tar xf - -C $1"
}

# --- 1. подготовка цели -------------------------------------------------------

#: патч-слои ядра dsh в порядке применения (канон Zorin):
#: core 01-05 (dsh-overrides) + tools (B2 sort/hide/failctx + B8 caveman + synloc)
core_apply() { # $1=action (apply|--status)
	local action="${1:-}"
	ssh_t "cd '$GOLDEN_ROOT/repo' && HOME='$GOLDEN_ROOT/fake-home' \\
		PATH='$GOLDEN_ROOT/bin:/usr/bin:/bin' \\
		bash scripts/apply-dsh-core-overrides.sh $action" || true
}

tools_apply() { # $1=action (пусто|--revert)
	local action="${1:-}"
	local dsh_root_g='$HOME/.npm-global/lib/node_modules'
	# путь npm root -g может отличаться — уточним
	dsh_root_g="$(ssh_t 'npm root -g 2>/dev/null || echo $HOME/.npm-global/lib/node_modules')"
	ssh_t "cd '$GOLDEN_HOME' && \\
		DSH_TOOLS_PATCH_TARGET='$dsh_root_g/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js' \\
		DSH_SP_PATCH_TARGET='$dsh_root_g/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js' \\
		DSH_WORKER_PATCH_TARGET='$dsh_root_g/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-code-runtime-worker-thread/lib/index.js' \\
		bash '$GOLDEN_HOME/patches/apply-dsh-tools-patches.sh' $action"
}

prep_target() {
	log "prep: доставка dsh-стека -> $TARGET:$GOLDEN_HOME (tar-over-ssh)"
	# Копия стека без: sessions (логи сессий), logs, storages, backups,
	# credentials*, секретных бэкапов settings. settings.yaml содержит только
	# имена env-переменных (apiKeyEnv), не сами ключи.
	# tar, а не rsync: на цели может не быть rsync (Void/fish).
	ssh_t "rm -rf '$GOLDEN_HOME' '$GOLDEN_ROOT/fake-home' && mkdir -p '$GOLDEN_HOME' '$WORK_DIR' '$GOLDEN_ROOT/fake-home' '$GOLDEN_ROOT/bin'"
	tar -C "$HOME/.dsh" -cf - \
		--exclude='./sessions' --exclude='./logs' --exclude='./storages' \
		--exclude='./session-backups' --exclude='./code-run-failures' \
		--exclude='.credentials.yaml' --exclude='settings.yaml.bak*' \
		--exclude='AGENTS.md.orig*' \
		. | ssh_tar "$GOLDEN_HOME"

	# machine-wide cordis.patch.yml: taskgate/octa на цели недоступны
	# (пути Zorin) — гасим менеджер lazy-MCP и прямые вставки machine-wide.
	ssh_t "printf -- '- id: mcp-lazy-manager\\n  disabled: true\\n' > '$GOLDEN_HOME/cordis.patch.yml'"

	# сьют меряет кеш на cli-группе свитчера — пиним модель яво, НЕ завися
	# от слотов zorin (agent-default-model гоняется bg/cli между машинами;
	# bg-креды в golden-копии не резолвятся — MISSING_CREDENTIAL, сьют 12.09).
	ssh_t "sed -i '1,12{s/^  provider: bg\$/  provider: cli/; s/^  model: glm-5.3\$/  model: opus/}' '$GOLDEN_HOME/settings.yaml'"

	# Адаптация путей в профиле dsh-tui под цель:
	#  - mcp-stderr-to-log -> $GOLDEN_HOME/bin/...
	#  - npx (context-mode lazy-MCP) -> системный npx цели
	# npx-путь Zorin резолвим динамически (не хардкод v22.23.2 — при апгрейде
	# node паттерн молча перестал бы матчить, review MINOR)
	local npx_path npx_local
	npx_path="$(ssh_t 'command -v npx || echo /usr/bin/npx')"
	npx_local="$(command -v npx || echo /usr/bin/npx)"
	ssh_t "sed -i \\
		-e 's|$HOME/.dsh/bin/mcp-stderr-to-log|$GOLDEN_HOME/bin/mcp-stderr-to-log|g' \\
		-e 's|$npx_local|$npx_path|g' \\
		'$GOLDEN_HOME/profiles/dsh-tui/cordis.patch.yml'"

	# core-патчи 01-05: discover скрипта ждёт ~/.nvm/*/... и ~/.dsh/profiles,
	# а на цели ни nvm, ни ~/.dsh (стек в $GOLDEN_HOME) -> fake-home с:
	#   .dsh -> $GOLDEN_HOME (профильные .pnpm-цели)
	#   .nvm/versions/node/v0.0.0/lib/... (glob раскрывается, find exit 0)
	# и PATH-шим dsh с DSH_CLI= (глобальная цель на цели).
	ssh_t "ln -sfn '$GOLDEN_HOME' '$GOLDEN_ROOT/fake-home/.dsh'; \\
		mkdir -p '$GOLDEN_ROOT/fake-home/.nvm/versions/node/v0.0.0/lib/node_modules/@deepseek-ai/dsh/node_modules'"
	local real_dsh
	# настоящий бинарь dsh цели: обёртка ~/.local/bin/dsh exec'ает npm-global
	# бинарь (симлинк на node_modules/@deepseek-ai/dsh/lib/bin.js) — discovery
	# скрипта требует DSH_CLI, чей realpath матчит *node_modules/@deepseek-ai/dsh/lib/bin.js
	real_dsh="$(ssh_t "grep -oE '/[^ ]+/bin/dsh' \"\$(command -v dsh)\" | tail -1")"
	[[ -n "$real_dsh" ]] || real_dsh="$(ssh_t 'command -v dsh')"
	ssh_t "printf '%s\\n' '#!/usr/bin/env bash' 'DSH_CLI=$real_dsh' 'exec $real_dsh \"\$@\"' > '$GOLDEN_ROOT/bin/dsh' && chmod +x '$GOLDEN_ROOT/bin/dsh'"

	# репо-части для core-патчей
	ssh_t "mkdir -p '$GOLDEN_ROOT/repo'"
	tar -C "$REPO" -cf - scripts/apply-dsh-core-overrides.sh dsh-overrides/core-patches \
		| ssh_tar "$GOLDEN_ROOT/repo"

	# слои патчей в каноническом порядке на ГЛОБАЛЬНОЙ копии dsh цели:
	# revert tools -> apply core -> apply tools (= канон Zorin)
	log "prep: патчи ядра (core 01-05 + tools B2/B8) на dsh-установке $TARGET"
	tools_apply --revert >/dev/null 2>&1 || true
	core_apply >/dev/null 2>&1 || true
	tools_apply >/dev/null 2>&1 || true

	# сверка байт-идентичности ядра с каноном Zorin (md5) — все 3 таргета:
	# tools (sort/hide/failctx/caveman), sp (caveman), worker (core03+synloc).
	# Пути канона — через glob ~/.nvm/versions/node/*/... (не хардкод версии
	# node: при апгрейде сверка молча умирала бы, review MINOR)
	local z_tools z_sp z_w v_tools v_sp v_w nvm_dsh
	nvm_dsh="$(ls -d "$HOME"/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh 2>/dev/null | tail -1)"
	[[ -n "$nvm_dsh" ]] || die "канон dsh не найден в ~/.nvm/versions/node/*/"
	z_tools="$(md5sum "$nvm_dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js" | cut -d' ' -f1)"
	z_sp="$(md5sum "$nvm_dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js" | cut -d' ' -f1)"
	z_w="$(md5sum "$nvm_dsh/node_modules/@deepseek-ai/dsh-code-runtime-worker-thread/lib/index.js" | cut -d' ' -f1)"
	local dsh_root_g
	dsh_root_g="$(ssh_t 'npm root -g 2>/dev/null || echo $HOME/.npm-global/lib/node_modules')"
	v_tools="$(ssh_t "md5sum '$dsh_root_g/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'" | cut -d' ' -f1)"
	v_sp="$(ssh_t "md5sum '$dsh_root_g/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'" | cut -d' ' -f1)"
	v_w="$(ssh_t "md5sum '$dsh_root_g/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-code-runtime-worker-thread/lib/index.js'" | cut -d' ' -f1)"
	if [[ "$z_tools" != "$v_tools" || "$z_sp" != "$v_sp" || "$z_w" != "$v_w" ]]; then
		die "ядро на $TARGET не байт-идентично канону (tools $z_tools vs $v_tools; sp $z_sp vs $v_sp; worker $z_w vs $v_w) — патчи легли не полностью"
	fi
	log "prep: ядро байт-идентично канону (tools ${z_tools:0:8}, sp ${z_sp:0:8}, worker ${z_w:0:8})"

	log "prep: доставка сьюта -> $TARGET"
	tar -C "$HERE" -cf - analyze.py drive_session.py | ssh_tar "$GOLDEN_ROOT"
}

# --- 2. передача ключа (без логов/argv) ---------------------------------------

# Проба канала кеша (suite.yaml cache_probe, review MAJOR#4): ОДИН прямой
# запрос в relay (тот же endpoint+токен, что у dsh) ДО сценариев — есть ли
# кеш-поля в usage ответа. Это внешний факт, отличающий «апстрим канала не
# репортит кеш» (свойство relay, репро golden 13-14.09: bg-маршрут не отдаёт
# cache_read_input_tokens) от «dsh не записывает кеш» (регрессия → FAIL).
# max_tokens<48 — exempt от degenerate-детектора свитчера (MKS 502-страйки).
# Токен НЕ логируется; выход — $RUN_DIR/channel-probe.json + stdout-флаг.
probe_channel_cache() {
	local creds="$HOME/.dsh/.credentials.yaml"
	local base model
	base="$(python3 -c "import yaml; print(yaml.safe_load(open('$HOME/.dsh/settings.yaml'))['llm-pi-ai']['providers']['cli']['baseURL'])" 2>/dev/null)" || true
	# пин модели — из НАСТРОЕК ЦЕЛИ (prep уже положил их sed'ом bg->cli);
	# $GOLDEN_HOME — путь на ЦЕЛИ, не локальный (ловушка первой пробы)
	model="$(ssh_t "sed -n 's/^  model: //p' '$GOLDEN_HOME/settings.yaml' | head -1")" || true
	model="$(printf '%s' "$model" | head -1 | tr -d '[:space:]')"
	[[ -n "$base" && -n "$model" ]] || { log "cache-probe: конфиг cli не прочитан — проба пропущена"; CHANNEL_REPORTS_CACHE="unknown"; return 0; }
	python3 - "$creds" "$base" "$model" "$RUN_DIR/channel-probe.json" <<'PYEOF'
import json, sys, urllib.request, yaml
creds_path, base, model, out_path = sys.argv[1:5]
tok = (yaml.safe_load(open(creds_path))["refs"] or {}).get("MKS_DSH_TOKEN", "")
req = urllib.request.Request(
    base.rstrip("/") + "/v1/messages",
    data=json.dumps({"model": model, "max_tokens": 40,
                     "messages": [{"role": "user", "content": "ок"}]}).encode(),
    headers={"content-type": "application/json", "x-api-key": tok,
             "anthropic-version": "2023-06-01"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        usage = (json.loads(r.read()) or {}).get("usage") or {}
except Exception as e:
    print(json.dumps({"error": str(e)[:200]}), file=open(out_path, "w"))
    print("channel-reports-cache: unknown (probe failed)")
    sys.exit(0)  # проба — не gate; unknown => analyze работает строго
fields = sorted(usage.keys())
reports = any("cache" in k for k in fields)
json.dump({"model": model, "usage_fields": fields, "reports_cache": reports},
          open(out_path, "w"), indent=1)
print(f"channel-reports-cache: {str(reports).lower()} (usage fields: {', '.join(fields) or 'none'})")
PYEOF
	# stdout пробы: "channel-reports-cache: true|false|unknown ..." — парсим флаг
	CHANNEL_REPORTS_CACHE="$(python3 -c "
import json
try:
    d = json.load(open('$RUN_DIR/channel-probe.json'))
    print('true' if d.get('reports_cache') else ('false' if 'reports_cache' in d else 'unknown'))
except Exception:
    print('unknown')
")"
	log "cache-probe: channel_reports_cache=$CHANNEL_REPORTS_CACHE (факт в channel-probe.json)"
	return 0
}

push_token() {
	# ключи провайдеров живут в ~/.dsh/.credentials.yaml (refs/VAR_NAME);
	# в golden-стек копия НЕ входит (exclude в prep) — доставляем отдельно
	# на цель 0600, удаляем после прогона. Нигде не логируем.
	local creds="$HOME/.dsh/.credentials.yaml"
	[[ -f "$creds" ]] || die "нет $creds — источник ключей провайдеров"
	# Доставка ТОЛЬКО stdin-путём с umask в той же удалённой команде (scp
	# создал бы 0644-окно до chmod). ВАЖНО: НЕ через ssh_t — его `bash -s
	# <<<cmd` занимает stdin heredoc'ом и перекрывает pipe: удалённый cat
	# читал бы командную строку вместо creds (регрессия фикса scp→stdin,
	# 12.09: golden-прогоны падали MISSING_CREDENTIAL на cli-группе).
	# Простую команду (без fish-несовместимого синтаксиса) цель исполняет
	# напрямую: umask — НЕ fish builtin, поэтому удалённый bash -c.
	ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" \
		"bash -c 'umask 077; cat > $GOLDEN_HOME/.credentials.yaml'" < "$creds"
	ssh_t "chmod 600 '$GOLDEN_HOME/.credentials.yaml'"
	log "credentials: доставлены на $TARGET (0600, содержимое не логируется)"
}

# --- 3. сценарии ----------------------------------------------------------------

run_tui_scenario() { # $1 = имя, $2 = план на цели, $3.. = доп. опции:
	#   --analyze-args "ARGS"  — доп. флаги analyze.py (напр. --sessions-root)
	#   --extra-from-result KEY — взять KEY из RESULT-JSON драйвера и передать
	#                             в analyze.py как --extra-facts {"KEY": val}
	local name="$1" plan_remote="$2"; shift 2
	local analyze_args="" extra_key=""
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--analyze-args) analyze_args="$2"; shift 2 ;;
			--extra-from-result) extra_key="$2"; shift 2 ;;
			*) shift ;;
		esac
	done
	log "scenario $name: TUI через PTY-драйвер"
	ssh_t "cd '$WORK_DIR' && \\
		python3 '$GOLDEN_ROOT/drive_session.py' \\
		--dsh-home '$GOLDEN_HOME' --work-dir '$WORK_DIR' \\
		--scenario '$name' --plan '$plan_remote'" \
		| tee "$RUN_DIR/$name-drive.log" || true
	local sess result_json
	result_json="$(grep -o 'RESULT:.*' "$RUN_DIR/$name-drive.log" | tail -1 | sed 's/^RESULT://' || true)"
	sess="$(printf '%s' "$result_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("session",""))' 2>/dev/null || true)"
	if [[ -z "$sess" ]]; then
		log "scenario $name: session не найдена"
		return 1
	fi
	# доп. факты: из RESULT драйвера (напр. workdir_unchanged_until_exit для f)
	# + channel_reports_cache (проба канала, анти-вакуум кеша review MAJOR#4).
	# JSON берём в одинарные кавычки: ssh_t исполняет строку как bash-скрипт,
	# без квотинга word-splitting разорвёт {"key": true} на отдельные слова.
	local extra_args=""
	if [[ -n "$extra_key" || "${CHANNEL_REPORTS_CACHE:-unknown}" != "unknown" ]]; then
		extra_args="$(printf '%s' "$result_json" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
extra = {}
v = d.get('$extra_key')
if v is not None:
    extra['$extra_key'] = v
if '$CHANNEL_REPORTS_CACHE' == 'true':
    extra['channel_reports_cache'] = True
elif '$CHANNEL_REPORTS_CACHE' == 'false':
    extra['channel_reports_cache'] = False
print(json.dumps(extra) if extra else '')
" 2>/dev/null || true)"
		if [[ -n "$extra_args" ]]; then
			extra_args="--extra-facts '$extra_args'"
		fi
	fi
	if ! ssh_t "python3 '$GOLDEN_ROOT/analyze.py' '$sess' --scenario '$name' $extra_args $analyze_args --json" > "$RUN_DIR/$name-verdict.json"; then
		rm -f "$RUN_DIR/$name-verdict.json"
		log "scenario $name: analyze упал"
		return 1
	fi
	log "scenario $name: вердикт в $RUN_DIR/$name-verdict.json"
	return 0
}

# --- 4. пост-чек кеша через внешний дашборд (опционально) -----------------------

# Релейный провайдер не отдаёт кеш-поля в Anthropic-фасаде — единственный
# источник per-request cached_tokens = публичная панель кеша провайдера.
# Внешний bbgt.py читает её; окно = [старт прогона, сейчас] UTC. Смешение с чужим
# живым трафиком неизбежно — метрика агрегатная по окну. Немонотонно:
# cooldown панели 1 мин, поэтому пауза 65с после последнего сценария.
cache_check() {
	# Path to external cache-dashboard reader (override via BBGT_PATH env).
	# Defaults to ~/.dsh-tui/bbgt.py; set BBGT_PATH to your own installation.
	local bbgt="${BBGT_PATH:-$HOME/.dsh-tui/bbgt.py}"
	if [[ ! -f "$bbgt" ]]; then
		log "cache: bbgt.py не найден — пост-чек пропущен"
		return 0
	fi
	log "cache: пост-чек кеша через bbgt (cooldown панели 65с)"
	sleep 65
	if ! python3 "$bbgt" --logs --json > "$RUN_DIR/bbgt-logs.json" 2> "$RUN_DIR/bbgt-logs.err"; then
		log "cache: bbgt не смог забрать логи (см. $RUN_DIR/bbgt-logs.err) — чек пропущен"
		return 0
	fi
	python3 - "$RUN_DIR" "$TS" <<'PYEOF'
import datetime, json, sys
run_dir, ts = sys.argv[1:3]
start = datetime.datetime.strptime(ts, "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
lo = start.timestamp() - 60
hi = datetime.datetime.now(datetime.timezone.utc).timestamp() + 60
rows = json.load(open(f"{run_dir}/bbgt-logs.json"))
win = []
for r in rows:
    t = r.get("timestamp") or 0
    t = t / 1000 if t > 1e12 else t
    if lo <= t <= hi:
        win.append((t, r.get("prompt_tokens") or 0, r.get("cached_tokens") or 0))
tp = sum(p for _, p, _ in win)
tc = sum(c for _, _, c in win)
pct = round(100 * tc / tp, 2) if tp else None
json.dump(
    {"window_start_utc": start.isoformat(), "requests": len(win),
     "prompt_tokens": tp, "cached_tokens": tc, "cache_pct": pct},
    open(f"{run_dir}/cache-check.json", "w"), indent=1)
print(f"[cache] окно прогона: {len(win)} запросов, cache_pct={pct if pct is not None else 'n/a'}%")
PYEOF
	return 0
}

# --- 5. сводка --------------------------------------------------------------------

summarize() {
	# список сценариев и порог — из suite.yaml (не дублируем; review MINOR)
	python3 - "$RUN_DIR" "$TS" "$TARGET" "$HERE/suite.yaml" <<'PYEOF'
import json, os, re, sys
run_dir, ts, target, suite = sys.argv[1:5]
# лёгкий парсинг без PyYAML: ключи сценариев + pass_threshold
scenarios, threshold = [], None
# ключи сценариев — ровно 2-пробельный отступ («  a_code_mode_run_code:»);
# первая буква = имя артефактов (<sc>-verdict.json)
for m in re.finditer(r"^  ([a-z])\w*:$", open(suite).read(), re.M):
    if m.group(1) not in scenarios:
        scenarios.append(m.group(1))
mt = re.search(r"^pass_threshold:\s*(\d+)", open(suite).read(), re.M)
threshold = int(mt.group(1)) if mt else len(scenarios)
print("=" * 62)
print(f"GOLDEN SUITE RUN {ts}  target={target}")
print("=" * 62)
passed = []
for name in scenarios:
    path = os.path.join(run_dir, f"{name}-verdict.json")
    if not os.path.isfile(path):
        print(f"[scenario {name}] MISSING")
        passed.append(False)
        continue
    try:
        v = json.load(open(path))["verdict"]
    except Exception as e:
        print(f"[scenario {name}] BROKEN verdict file: {e}")
        passed.append(False)
        continue
    checks = v["checks"]
    mark = "PASS" if v["pass"] else "FAIL"
    cache = checks.get("cache_pct")
    cache_s = f"{cache:.2f}%" if isinstance(cache, (int, float)) else "n/a"
    note = ""
    if checks.get("cache_reporting") == "channel-no-report":
        note = "  [cache: канал не репортит кеш — проба, см. channel-probe.json]"
    print(
        f"[scenario {name}] {mark}  system_stable={checks.get('system_stable')} "
        f"headers={checks.get('header_count')} cache={cache_s} "
        f"({checks.get('cache_steps', 0)} steps){note}"
    )
    failed = [k for k in v.get("required", []) if not checks.get(k)]
    if failed:
        print(f"    failed checks: {', '.join(failed)}")
    passed.append(v["pass"])
ok = sum(1 for p in passed if p)
print("-" * 62)
print(f"RESULT: {ok}/{len(scenarios)} scenarios pass (threshold: {threshold})")
sys.exit(0 if ok >= threshold else 1)
PYEOF
}

main() {
	mkdir -p "$RUN_DIR"
	log "golden suite run $TS -> $RUN_DIR (target: $TARGET)"
	ssh_t "true" || die "SSH до $TARGET недоступен"
	[[ $SKIP_PREP -eq 0 ]] && prep_target
	push_token
	probe_channel_cache
	# секрет на цели живёт ровно до выхода скрипта: любой die()/set -e-сбой
	# после push_token обязан убрать .credentials.yaml с цели (review MAJOR#2)
	trap 'ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" "rm -f \"$GOLDEN_HOME/.credentials.yaml\"" 2>/dev/null || true' EXIT

	# планы TUI-сценариев (b/c/d) — из suite.yaml заморозки
	ssh_t "mkdir -p '$GOLDEN_ROOT/plans'"
	# Анти-degenerate (13.09, MKS 502-penalty): ходы вида «ответь одним словом»
	# дают output 3-5 токенов при system 15-24k — профиль degenerate-детектора
	# свитчера (3 страйка -> блок группы 15 дней). Все финальные ответы моделей
	# развернуты (>=50 токенов), проверяемые маркеры сохранены: activated (b),
	# loaded (c), run_code-задача (a), файл/компакция (d).
	cat > "$RUN_DIR/plan-a.json" <<'AEOF'
[
  {"send": "Посчитай через run_code: сумму всех простых чисел до 200 и количество таких чисел. Выведи оба числа и проверь их вторым независимым способом. После чисел кратко (3-4 предложения) объясни, как ты их считал."},
  {"send": "Скажи \"ок\", а затем двумя-тремя предложениями опиши, что ты делал в предыдущем задании."}
]
AEOF
	cat > "$RUN_DIR/plan-b.json" <<'BEOF'
[
  {"send": "Найди через MCP-инструментарий сервер context-mode, активируй его и вызови любой его инструмент. После результата опиши двумя-тремя предложениями, какой инструмент ты вызвал и что он вернул, а затем заверши ответ словом activated."},
  {"send": "Скажи \"ок\", а затем двумя-тремя предложениями опиши, что ты делал в предыдущем задании."}
]
BEOF
	cat > "$RUN_DIR/plan-c.json" <<'CEOF'
[
  {"send": "В коде run_code вызови tools.spot_search с запросом web search, посмотри результат, затем вызови tools.spot_load для найденного инструмента веб-поиска. Оба вызова обязательны. После этого опиши двумя-тремя предложениями, какой инструмент веб-поиска ты загрузил и что он умеет, и заверши ответ словом loaded."},
  {"send": "Скажи \"ок\", а затем двумя-тремя предложениями опиши, что ты делал в предыдущем задании."}
]
CEOF
	cat > "$RUN_DIR/plan-d.json" <<'DEOF'
[
  {"send": "Запиши через run_code в файл /tmp/golden-d.txt три строки: alpha, beta, gamma. Затем прочитай файл, перечисли содержимое и двумя предложениями опиши, что это за файл."},
  {"slash": "/compact"},
  {"send": "Какой файл мы только что создали и что в нём? Ответь 2-3 предложениями."}
]
DEOF
	# e: рольные субагенты (C-4) — оба вызова foreground, ответ развёрнутый
	# (анти-degenerate свитчера). Пин проверяется по ДОЧЕРНИМ сессиям
	# (request/header config.model), не по ответу тула.
	cat > "$RUN_DIR/plan-e.json" <<'EEOF'
[
  {"send": "Сначала вызови инструмент subagent_research (run_in_background: false) с задачей: «Найди в этом каталоге все файлы и кратко опиши, что здесь лежит». Дождись результата. Затем вызови инструмент subagent_exec (run_in_background: false) с задачей: «Посчитай количество строк в файле README.md и верни только число». Дождись результата. После обоих субагентов опиши двумя-тремя предложениями, какие субагенты ты вызвал и что они вернули, и заверши ответ словом delegated."}
]
EEOF
	# f: план-мод рисёч+ (C-5) — материально неоднозначная задача без деталей.
	# Промпт уходит ВНУТРИ respond-айтема (ход с вопросами не завершается —
	# отдельный send-айтем завис бы на TURN_TIMEOUT). Драйвер отвечает Enter
	# на панели вопросов (Recommended) и approve на план-ревью; стоп по
	# exit_plan_mode в логе.
	# ВАЖНО (ловушки прогонов 13-14.09):
	#  1) «ask ЧЕРЕЗ run_code не рендерит панель» — ОПРОВЕРГНУТО
	#     (TG-DSH-FIXUP-20260914 node 1): панель монтируется и на прямом
	#     tool/call, и на code-dispatch; слепота драйвера была багом
	#     детекции (contiguous-поиск маркера в raw-байтах при ink
	#     cell-skip диффе «Enter\x1b[1Csubmit»). Детекция переписана на
	#     виртуальный экран (drive_session.VirtualScreen); промпт
	#     нейтрален — оба пути вызова обязаны работать.
	#  2) слэш обязан быть «/plan on»: голый «/plan» + Enter в TUI выбирает
	#     автодополнением сабжешн «off» -> «Plan mode is already inactive»
	#     -> сессия молча не работает. «on» утекает steer-сообщением — безвредно.
	cat > "$RUN_DIR/plan-f.json" <<'FEOF'
[
  {"slash": "/plan on"},
  {"sleep": 3},
  {"respond": {"send": "Добавь кеширование в этот проект. Когда нужно уточнить что-то у пользователя — спроси через ask_user_question; финальный план подай через exit_plan_mode.", "stop_on_call": "exit_plan_mode", "workdir": true}}
]
FEOF
	for sc in a b c d e f; do
		tar -C "$RUN_DIR" -cf - "plan-$sc.json" | ssh_tar "$GOLDEN_ROOT/plans"
	done
	# cutoff «новее чем» — по ЧАСАМ ЦЕЛИ: mtime session-файлов ставит целевая
	# FS, локальный date +%s вносил межмашинный clock-skew (review MINOR).
	# 5с запас — на границы FS-тайминга.
	RUN_START_TS=$(( $(ssh_t 'date +%s') - 5 ))
	run_tui_scenario a "$GOLDEN_ROOT/plans/plan-a.json" || log "scenario a: FAILED"
	run_tui_scenario b "$GOLDEN_ROOT/plans/plan-b.json" || log "scenario b: FAILED"
	run_tui_scenario c "$GOLDEN_ROOT/plans/plan-c.json" || log "scenario c: FAILED"
	run_tui_scenario d "$GOLDEN_ROOT/plans/plan-d.json" || log "scenario d: FAILED"
	run_tui_scenario e "$GOLDEN_ROOT/plans/plan-e.json" --analyze-args "--sessions-root $GOLDEN_HOME/sessions --newer-than $RUN_START_TS" || log "scenario e: FAILED"
	run_tui_scenario f "$GOLDEN_ROOT/plans/plan-f.json" --extra-from-result workdir_unchanged_until_exit || log "scenario f: FAILED"

	# забрать session-факты для отчёта (system size/sha по каждой сессии)
	for sc in a b c d; do
		f="$RUN_DIR/$sc-verdict.json"
		[[ -f "$f" ]] || continue
	done

	cache_check
	summarize | tee "$RUN_DIR/summary.txt"
	local rc="${PIPESTATUS[0]}"
	# cleanup секрета на цели
	ssh_t "rm -f '$GOLDEN_HOME/.credentials.yaml'" || true
	log "отчёт прогона: $RUN_DIR"
	exit "$rc"
}

main "$@"
