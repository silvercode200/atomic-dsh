# Golden smoke-сьют кеш-верификации dsh

TG-DSH-CACHE-20260912, node 9 (B7). Замороженный минимальный E2E-набор — по
одному прогону на поверхность исполнения кеш-механики. Обязателен после
каждого изменения ядра (dsh-tools / dsh-system-prompt / mcp-lazy / spot /
пресеты). Сьют версионирован (`suite.yaml` → `schemaVersion`); расширение =
отдельный коммит + bump версии.

## Запуск одной командой

```bash
bash tests/golden/run.sh                     # полный прогон (цель vmdev)
GOLDEN_TARGET=host bash tests/golden/run.sh  # другая SSH-цель
bash tests/golden/run.sh --skip-prep         # без пересборки стека на цели
```

Юнит-тесты парсера: `python3 tests/golden/test_analyze.py` (50 тестов) и
`python3 -m pytest tests/golden/test_drive_ansi.py` (26 тестов — VirtualScreen,
маркеры ASK/REVIEW, TestHangingAsk). Всего в tests/golden — 76 тестов
(`pytest tests/golden --collect-only`); весь репо-сьют — 118.

## Сценарии (заморожены в suite.yaml / run.sh)

| # | Сценарий | Что доказывает (внешний наблюдаемый факт) |
|---|----------|--------------------------------------------|
| a | code-mode: run_code | tool/call `run_code` (точное имя) в session log; system_stable; usage-шаги пишутся; кеш ≥ 97% если канал репортит |
| b | MCP activate + вызов | активация context-mode через ленивый слой (`schemaDelivery: message`) НЕ меняет request/header; вызван `mcp__context-mode__*` |
| c | spot cold-load | `spot_search` + `spot_load` вызовы; схемы холодных тулов приходят сообщением — header не меняется |
| d | компакция | `compaction/start`+`end` записи; ход после компакции; header по-прежнему один |
| e | рольные субагенты | спавн через запинненные тулы реально уходит на заданную модель: дочерняя сессия `role=subagent_research` → `cli/haiku`, `role=subagent_exec` → `cli/sonnet`. Маппинг по linkage (origin=subagent + parentSession + spawn-время) — своп пинов ролей FAIL-ит, а не PASS-ает по множеству моделей (TG-DSH-BACKLOG-20260914 node 2 / C-4, фиксы TG-DSH-FIXUP-20260914 node 3) |
| f | план-мод рисёч+ | на материально неоднозначной задаче `ask_user_question` вызван ДО `exit_plan_mode`, мутаций work dir до подачи плана нет (манифест драйвера), tools_stable — каталог тулов не растёт между режимами. system_stable НЕ проверяется — документированное исключение план-мода (вход штатно меняет system-секцию) |

Зелёный сьют = **минимум 5 из 6 PASS** (`suite.yaml` → `pass_threshold`;
run.sh читает список сценариев и порог оттуда).

## Механика верификации (откуда берутся факты)

- `request/header` (dsh-agent-loop/lib/index.js:731-739) пишется ПЕРВЫЙ раз
  как `initial` и далее ТОЛЬКО при изменении header как `change`. Поэтому
  **system+tools байт-идентичны между ходами ⟺ в сессии ровно 1
  request/header и нет `change`**. Это строгий критерий, не эвристика.
- usage-чанки (`assistant/chunk` → `chunk.usage`) пишутся на каждом LLM-шаге.
  Семантика inclusive: `inputTokens` = полный ввод, `cacheReadTokens` =
  кешированная часть (эмпирика: `cacheRead(N) ≈ inputTokens(N-1)`).
  `cache_pct = cacheRead/input`, среднее по кешированным шагам со 2-го
  (первый кеш-шаг — прогрев, гранулярность кеша 1024 токенов).
- **Кеш-поля зависят от апстрима relay**, не от dsh: канал `cli`
  (mini-key-switcher 127.0.0.1:8350) репортил `cacheReadTokens` 11-12.09
  (glm-relay маршрут, 99.9%), но НЕ репортил 13-14.09 (relay-via-cache-dashboard маршрут).
  Поэтому анти-вакуум кеша двухуровневый: `usage_steps_present` обязателен
  всегда; `cache_steps_present` + `cache_pct>=97` — обязательны, если канал
  репортит кеш. Репортит ли — определяет ПРОБА run.sh (один прямой запрос
  в relay до сценариев, `channel-probe.json`): проба «не репортит» —
  свойство апстрима, фиксируется в отчёте (`cache_reporting:
  channel-no-report`) и не фейлит сценарии; dsh-регрессия записи кеша при
  репортящем канале = честный FAIL.
- Агрегатный пост-чек кеша через внешний дашборд провайдера (bbgt, `cache-check.json`) —
  смешивается с чужим трафиком окна, атрибуция по сценариям невозможна
  (репро 14.09: 39 usage-шагов прогона не совпали ни с одной строкой панели).

## Целевая машина

Прогоны идут на **удалённой тест-машине** (SSH, LAN, relay достижим, dsh 0.1.1-rc.2): закон SOC
«тесты не на Zorin». Колаб-VM не годится для кеш-метрик: relay в приватной
сети (curl с VM = unreachable), кеш-поля не пишутся, свежая VM не содержит стека.

`run.sh` сам разворачивает на цели канонический стек:
- tar-копия `~/.dsh` (без sessions/logs/credentials) в `/tmp/dsh-golden/dsh-home`;
- адаптация путей (`mcp-stderr-to-log`, `npx`) под цель;
- патчи ядра в каноническом порядке: `--revert` tools → core 01-05 →
  tools (B2 sort/hide + B8 caveman + failctx/synloc);
- **md5-сверка ядра с каноном Zorin** — прогон не стартует, если ядро цели
  не байт-идентично;
- credentials доставляются 0600 и удаляются после прогона; в логи/отчёты
  не попадают.

## Файлы

- `suite.yaml` — заморозка сьюта (schemaVersion, промпты, пороги, expects,
  cache_probe).
- `run.sh` — оркестратор: prep → проба канала кеша → 6 сценариев →
  вердикты → summary (список сценариев и порог — из suite.yaml).
- `drive_session.py` — PTY-драйвер TUI (stdlib): boot, промпты, поллинг
  turn/end и compaction/end в session.jsonl.zstd; план-айтем `respond` —
  ответы Enter на панели вопросов (ASK_MARKERS) и план-ревью
  (REVIEW_MARKERS «quick-pick», план-мод) + манифест work dir. Детекция
  панелей — VirtualScreen (ink cell-skip диффы).
- `analyze.py` — парсер session.jsonl(.zstd) + вердикты (CLI, JSON-вывод);
  `scan_sessions` — скан дочерних сессий субагентов по linkage
  (origin=subagent, parentSession; `--sessions-root`, `--newer-than`) с
  маппингом роль→дочь по spawn-времени; `--extra-facts` — доп. факты
  драйвера (f) и пробы канала (channel_reports_cache).
- `test_analyze.py` — TDD-тесты парсера/вердиктов (unittest, 50).
- `test_drive_ansi.py` — TDD-тесты VirtualScreen/маркеров (pytest, 26).
- `fixtures/ask_panel_cuf_frame.bin` — реальный PTY-кадр ask-панели репро
  (20260914T083643Z): hint-строка порезана CUF-прыжками — маркер «Enter
  submit» есть на виртуальном экране, отсутствует в raw-байтах; регресс-тест
  детекции (TG-DSH-FIXUP-20260914 node 1).
- `soc-cache-verification.yaml` — SOC-программа (deterministic lane):
  формальный прогон сьюта с .soc-отчётом и assert'ами по критериям PASS.

## Известные ловушки

- **PTY-буфер убивает прогон**: если драйвер не читает PTY-вывод во время
  ожидания хода, kernel-буфер (~64KB) забивается спиннер-кадрами ink →
  write() dsh блокируется → ход «не завершается» вечно. Фикс: pump() на
  каждом тике wait_for (drive_session.py).
- **Детекция панелей — VirtualScreen, не raw-подстрока**: ink пишет кадры
  поячеечным диффом, пустые ячейки пропускает CUF (`\x1b[N C`) — маркер
  «Enter submit» в raw-байтах может НЕ встречаться при видимой панели
  («несуществующая гонка ask», node 1). Спиннер не значит отсутствие панели.
- **multi_select вопрос**: Enter при 0 отмеченных опций НЕ сабмитит
  (question-select-or-answer). Нужен Space (отметить Recommended) + Enter.
  Space в single-select безвреден.
- **«/plan on», не голый «/plan»**: Enter по «/plan» выбирает
  автодополнением «off» → «Plan mode is already inactive» — план-мод молча
  не включается. «on» утекает steer-сообщением — безвредно.
- **respond-айтем для f**: план-мод ход с вопросами не завершается до
  ответов — отдельный `send` зависнет на turn-таймауте; промпт живёт в
  `respond.send` (план-f).
- **Insertion-порядок open_ids**: последний открытый вызов ask — последний
  в списке вставки, не `sorted()[-1]` («d:code:9» vs «d:code:10» —
  лексикографика лжёт о хронологии).
- **ASK_CANCELLED = панель была смонтирована**: `Error: the user cancelled
  ask_user_question` эмитит только onCancel панели (Esc) — даже такой исход
  доказывает факт ask до exit_plan_mode; эскалация тактики драйвера
  (Enter → текст → Esc) важна для закрытия вопроса, не для вердикта.

## Отчёты

Прогон пишет `reports/golden-run-<UTC>/`: `{a..f}-drive.log`,
`{a..f}-verdict.json`, `channel-probe.json`, `summary.txt`. Сводка по кешу —
`reports/cache-verification-*.md`.
