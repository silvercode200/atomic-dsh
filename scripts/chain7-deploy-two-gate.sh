#!/bin/bash
# chain-7: деплой патчей 73+74 + двухгейт (mks4 GREEN + golden v8 ноль регрессов)
# TG-DSH-MKS4-20260928 узлы 3/4/5. Запуск ПОСЛЕ коммита обоих патчей.
# RC-баг v1 пофикшен: exit-коды socctl пишутся ДО tail (пайп съедал $?).
set -u
cd $HOME/xeon-Programms/deepseek_harness
TS() { date -u +%H:%M:%SZ; }
LOG=/tmp/chain7
mkdir -p "$LOG"
echo "=== chain-7 start $(TS) ==="

# 0) таймеры стоп (конкуренция с setup — memory golden3)
systemctl --user stop gcolab-save.timer gcolab-session-guard.timer 2>/dev/null
echo "timers-stopped: $(TS)"

# 1) деплой стека HEAD (VM-бандл = git archive HEAD: 73+74 уже в коммитах)
# SKIP_DEPLOY=1 — гейты поверх уже готового деплоя (успех деплоя = rc=0 +
# строка "OK: VM" [ASCII-фрагмент]; "DEPLOY_OK"-маркера в выводе НЕТ —
# баг v1: гейты зря скипались при живом деплое).
if [ "${SKIP_DEPLOY:-0}" = "1" ]; then
  echo "SKIP_DEPLOY=1 — деплой пропущен, гейты по готовому стеку"
  MKS4_RC=-1; GOLD_RC=-1
  DEPLOY_RC=0
else
  bash scripts/colab-dsh-up.sh --target current --fake-model > "$LOG/deploy.log" 2>&1
  DEPLOY_RC=$?
  echo "deploy rc=$DEPLOY_RC $(TS)"
  tail -6 "$LOG/deploy.log"
fi
if [ $DEPLOY_RC -ne 0 ] || { [ "${SKIP_DEPLOY:-0}" != "1" ] && ! grep -aq "OK: VM" "$LOG/deploy.log"; }; then
  echo "DEPLOY_FAILED — гейты скипнуты (см. $LOG/deploy.log)"
  MKS4_RC=99; GOLD_RC=99
else
  # 2) гейт-1: mks4-сьют (narrow GREEN [73] + slash GREEN [74, порог AA 4.5])
  socctl verify --root $HOME/xeon-Programms/deepseek_harness \
    --file tests/colab/dsh-mks4-probes.yaml --lane colab --label green \
    > "$LOG/mks4.log" 2>&1
  MKS4_RC=$?
  echo "MKS4_RC=$MKS4_RC $(TS)"
  tail -25 "$LOG/mks4.log"

  # 3) гейт-2: golden v8 (ноль регрессов на закрытых багах; E7-риск ультра-коротких пейнов)
  socctl verify --root $HOME/xeon-Programms/deepseek_harness \
    --file tests/colab/dsh-tui-inline.yaml --lane colab --label green \
    > "$LOG/golden.log" 2>&1
  GOLD_RC=$?
  echo "GOLD_RC=$GOLD_RC $(TS)"
  tail -25 "$LOG/golden.log"
fi

# 4) таймеры вернуть — ВСЕГДА
systemctl --user start gcolab-save.timer gcolab-session-guard.timer 2>/dev/null
echo "timers-restored: $(TS)"
echo "=== chain-7 end: MKS4_RC=$MKS4_RC GOLD_RC=$GOLD_RC $(TS) ==="
