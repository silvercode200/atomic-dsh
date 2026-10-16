#!/bin/bash
# chain7-regression-mks4: regression run промоутнутого mks4-сценария
# (валидность копии с шапкой в .soc/scenarios + постпромоут GREEN).
# Стартует ТОЛЬКО после смерти чужих раннеров (быстрый поллинг, 5с —
# чтобы golden-ждун успел увидеть наш раннер и отложиться).
set -u
cd $HOME/xeon-Programms/deepseek_harness
TS() { date -u +%H:%M:%SZ; }
echo "=== chain7-regression-mks4 start $(TS) ==="

# ждать смерти чужих раннеров (быстрый поллинг)
while pgrep -f "autotestvm.cli program" >/dev/null 2>&1; do sleep 5; done
echo "чужих раннеров нет $(TS)"

socctl regression run --root $HOME/xeon-Programms/deepseek_harness \
  --scenario .soc/scenarios/mks4-bugs-verify.yaml > /tmp/chain7/regression-mks4.log 2>&1
REG_RC=$?
echo "REG_RC=$REG_RC $(TS)"
tail -20 /tmp/chain7/regression-mks4.log
echo "=== chain7-regression-mks4 end: REG_RC=$REG_RC $(TS) ==="
