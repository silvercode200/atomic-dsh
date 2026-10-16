#!/bin/bash
# golden-idle-rerun: ждёт idle-окно colab-транспорта (чужие autotestvm-раннеры
# молчат 3 мин) и запускает ЧИСТЫЙ golden-гейт. Дедлайн ожидания 45 мин —
# потом старт в любом случае. Таймеры остаются выключенными на весь прогон.
# Контекст: волна mks-сессии гоняет program-джобы каждые 12-31 мин на том же
# локе default/col-test; коллизия = lock wait timeout → каскад инфра-фейлов
# (горький опыт 01:22-02:13Z: scenario_smoke lock-timeout → TUI мёртв).
set -u
cd $HOME/xeon-Programms/deepseek_harness
TS() { date -u +%H:%M:%SZ; }
echo "=== golden-idle-rerun start $(TS) ==="

DEADLINE=$(( $(date +%s) + 2700 ))  # 45 мин
while true; do
  # чужие/свои раннеры живы? — ждать смерти
  while pgrep -f "autotestvm.cli program" >/dev/null 2>&1; do
    sleep 30
    [ $(date +%s) -ge $DEADLINE ] && break 2
  done
  # окно тишины 3 мин
  QUIET=1
  for i in 1 2 3 4 5 6; do
    sleep 30
    if pgrep -f "autotestvm.cli program" >/dev/null 2>&1; then QUIET=0; break; fi
  done
  [ $QUIET -eq 1 ] && { echo "idle-window CONFIRMED $(TS)"; break; }
  [ $(date +%s) -ge $DEADLINE ] && { echo "deadline hit — старт в любом случае $(TS)"; break; }
  echo "новый раннер в окне тишины — ждём дальше $(TS)"
done

echo "запуск golden: $(TS)"
socctl verify --root $HOME/xeon-Programms/deepseek_harness \
  --file tests/colab/dsh-tui-inline.yaml --lane colab --label green \
  --max-wait 4200 > /tmp/chain7/golden2.log 2>&1
GOLD_RC=$?
echo "GOLD_RC=$GOLD_RC $(TS)"
tail -30 /tmp/chain7/golden2.log

systemctl --user start gcolab-save.timer gcolab-session-guard.timer 2>/dev/null
echo "timers-restored $(TS)"
echo "=== golden-idle-rerun end: GOLD_RC=$GOLD_RC $(TS) ==="
