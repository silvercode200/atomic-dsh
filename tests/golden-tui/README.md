# Golden smoke-сьют TUI-механик dsh (фейк-модель + запись кадров)

TG-DSH-TESTING-20260920 node 4. Замороженный минимальный E2E-набор для двух
новых тест-механик dsh: фиктивной локальной модели (dsh-fake-llm) и записи
терминальных сессий с кадровыми дифами (SOC termseer record). Обязательный
прогон после каждого изменения этих механик или ядра патч-стека TUI.

Запуск одной командой:

```bash
bash tests/golden-tui/run.sh
```

Требования: Node>=22, python3+pytest (SOC-чекаут), dsh, dsh-tui-профиль
со стеком патчей. Живой TUI-прогон идёт через SOC lane termseer (закон SOC:
Zorin/vmdev для живых TUI-проверок не используются; smoke на целевой
машине lane'ов — Colab/UbuntuMin через socctl, локальный dry-этап
ограничен бэкенд-проверками selftest/pytest без GUI).

schemaVersion: 1

## Этапы (внутри run.sh)

| # | Этап | Что доказывает (внешний наблюдаемый факт) |
|---|------|--------------------------------------------|
| 1 | selftest fake-llm | `node tools/dsh-fake-llm/selftest.mjs` → SELFTEST PASSED 6/6, exit 0 (SSE, tool-цикл, usage, health) |
| 2 | health + curl | сервер поднялся, `GET /health` → `{"ok":true}` |
| 3 | pytest SOC record | `pytest tests/test_record_frames.py` → passed, exit 0 (record_start/stop, cast v2, frames_diff, gap-метрики) |
| 4 | smoke turn | (live-этап, lane termseer) сценарий fake-model-smoke: dsh-сессия с provider fake, в кадре read_screen виден стрим ответа и живые поля статус-бара; `record start/stop` в той же сессии → recordings/<name>/cast существует, meta.jsonl ≥ 10 кадров, summary.json с blank_ratio/gap_under_status_row_max |
| 5 | frames diff | вывод `frames <name> diff` содержит структурный таймлайн (changed_rows, last_nonempty_row) без vision |

Порог зелёного: этапы 1-3 обязательны (backend, везде запускаются); 4-5 —
на целевой машине lane'ов; при недоступности lane'ов сьют завершается
DEGRADED (backend-этапы зелёные), НЕ тихим пропуском — фиксируется в отчёте
reports/golden-tui/<ts>/verdict.json.

Расширение сьюта = отдельный коммит + bump schemaVersion.
