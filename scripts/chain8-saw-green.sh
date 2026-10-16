#!/bin/bash
# chain-8: деплой патча 77 (scroll-extent streaming→false invalidation) + saw-сьют GREEN
# TG-DSH-MKS4-20260928 узел 5. HEAD=cabd037 (INVALIDATE revision, pushed origin).
# RED baseline: saw_flips=1 на стеке 76 (job program_job_20261008T000238223631Z).
# GREEN = saw_flips==0 (патч 77 invalidates stale heightsRef на streaming→false transition).
# timeout 5400 (90 мин) — транспорт contended параллельной soc-gate сессией (SOC_studio verifies).
set -u
cd $HOME/xeon-Programms/deepseek_harness
TS() { date -u +%H:%M:%SZ; }
LOG=/tmp/chain8
mkdir -p "$LOG"
echo "=== chain-8 start $(TS) ==="

# 0) таймеры стоп (конкуренция с setup — memory golden3)
systemctl --user stop gcolab-save.timer gcolab-session-guard.timer 2>/dev/null
echo "timers-stopped: $(TS)"

# 1) деплой стека HEAD (VM-бандл = git archive HEAD: патч 77 в коммите 85b5144)
#    --fake-model: dsh-fake-llm на VM (ноль реальных токенов)
if [ "${SKIP_DEPLOY:-0}" = "1" ]; then
  echo "SKIP_DEPLOY=1 — деплой пропущен, гейт по готовому стеку"
  MKS4_RC=-1
  DEPLOY_RC=0
else
  timeout 5400 bash scripts/colab-dsh-up.sh --target current --fake-model > "$LOG/deploy.log" 2>&1
  DEPLOY_RC=$?
  echo "deploy rc=$DEPLOY_RC $(TS)"
  tail -8 "$LOG/deploy.log"
fi
if [ $DEPLOY_RC -ne 0 ] || { [ "${SKIP_DEPLOY:-0}" != "1" ] && ! grep -aq "OK: VM" "$LOG/deploy.log"; }; then
  echo "DEPLOY_FAILED — saw-гейт скипнут (см. $LOG/deploy.log)"
  SAW_RC=99
else
  # 2) saw-гейт: scroll_jitter GREEN (saw_flips==0)
  socctl verify --root $HOME/xeon-Programms/deepseek_harness \
    --file tests/colab/dsh-saw-probe.yaml --lane colab --label green \
    --max-wait 4200 > "$LOG/saw.log" 2>&1
  SAW_RC=$?
  echo "SAW_RC=$SAW_RC $(TS)"
  tail -30 "$LOG/saw.log"
fi

# 3) таймеры вернуть — ВСЕГДА
systemctl --user start gcolab-save.timer gcolab-session-guard.timer 2>/dev/null
echo "timers-restored: $(TS)"
echo "=== chain-8 end: SAW_RC=$SAW_RC $(TS) ==="
