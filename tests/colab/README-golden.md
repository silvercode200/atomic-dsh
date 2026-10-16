# Golden-сьют dsh-tui-inline — юзер-парити верификация канона статус-бара

## §0 Трассировка требования узла 6 (дословные термины → реализация)

Требование узла 6 (TG-DSH-REBUILD-20260921): «Golden-сьют на Colab: ассерт
режима inline, параметрическая геометрия (свип+случайные), юзер-конфиг,
расширенная фейк-модель (thinking-паузы, tool-циклы, subagent-волны,
usage-числа, длинный стрим, ресайз во время стрима), канон-детекторы всех
поверхностей + скроллбек-детектор E1. Прогон на каждом изменении стека.»

| Термин требования | Где реализовано |
|---|---|
| Golden-сьют на Colab | `tests/colab/dsh-tui-inline.yaml` (suite_version: 9), lane colab, драйвер `scripts/colab-dsh-live-check.sh` |
| ассерт режима inline | тест `mode_inline`: buffer>pane_h + alternate_on=0; pin=WARN на pristine |
| параметрическая геометрия (свип+случайные) | `sweep_statusbar_invariants` + `sweep_w47_minimum` (свип) и `geometry_fuzz` (3 случайные геометрии, сид `vars: seed`) |
| юзер-конфиг | setup-шаги `parity_settings` (dsh-tui-секция юзера дословно, с v6 включая `appearance.animations: false`) + `parity_marker` |
| расширенная фейк-модель | `tools/dsh-fake-llm/`: сценарии + `delayMs` + KEYWORDS compact + маркер последний |
| thinking-паузы | `SCENARIO:thinking` (delayMs 3с + thinking-стрим 6с) — тест `scenario_smoke` |
| tool-циклы | `SCENARIO:tools` (Bash→Read→Write→tool_result→текст); subagent-волны = tool-циклы — тест `cards_render` |
| subagent-волны | `SCENARIO:subagents` = 2 волны реальных спавнов — тест `cards_render` |
| usage-числа | `SCENARIO:usage` (input 42000/output 3800/cache 48000+2200, tps 47.2) — тест `scenario_smoke` |
| длинный стрим | `SCENARIO:long` (STREAM_TOTAL_MS 45с) — тесты `e1_garbage_long`, `scroll_jitter` (v6) |
| ресайз во время стрима | тест `e1_garbage_resize` (resize 120×40→80×30→47×43 во время стрима) |
| канон-детекторы всех поверхностей | таблица «канон → детектор → тест» ниже (§1 + §3 канона) |
| скроллбек-детектор E1 | тесты `e1_garbage_long/resize/shorts` (мусор хрома в capture -S -2000) |
| Прогон на каждом изменении стека | раздел «Правило процесса (канон §4.1)» ниже |

TG-DSH-REBUILD-20260921 узел 6. Сьют `tests/colab/dsh-tui-inline.yaml` (suite_version: 9) —
инструментальная реализация верификационной процедуры канона
`reports/STATUS-BAR-CANON.md` §4.1: канон-инварианты детекторами, юзер-парити
(inline АССЕРТЕН, конфиг юзера, тема, геометрия юзера + свип + случайные).

## Как запускать

```bash
bash scripts/colab-dsh-live-check.sh \
  --target current --fake-model --label golden-r6 \
  --suite tests/colab/dsh-tui-inline.yaml \
  --detectors e1_garbage_long,e1_garbage_resize,e1_garbage_shorts,e2_slash_menu_w47,sweep_w47_minimum,geometry_fuzz,scenario_smoke,cards_render,compact_visible,stream_stall,animations_gate,scroll_jitter
```

- `--target current|pristine|patches:<ref>` — бисекция: детекторы обязаны
  работать одинаково на любом таргете (режим-гейт решают buffer/alt, pin-trace
  = WARN при PIN_TRACE_ABSENT на pristine).
- `--label <tag>` — каталог отчёта `reports/colab-<tag>-<UTC>/` (result.json,
  verdict.json, frames/).
- Отчёт о прогоне: `reproduced: true` у перечисленных в `--detectors` тестов,
  упавших на прогоне = открытый канон-пункт воспроизведён.
- Сид фаззинга: `vars: seed` в yaml (дата прогона). Смена сида = новая тройка
  случайных геометрий (диапазон канона w 40-240 × h 24-60), полная
  воспроизводимость внутри сида.
- Сьют считается одним прогоном ~10-12 минут (long-стримы, thinking-фаза,
  окно компакции ~50с, v6: +2 теста ~2 мин) — это осознанно: детекторы меряют
  середину окна. Драйверу `--max-wait` ≥ 2400с (бюджет golden-65).

## Правило процесса (канон §4.1)

**Прогон сьюта на КАЖДОМ изменении патч-стека dsh-tui.** Фича/патч не считается
влитой, пока golden не прогнан на `--target current` после изменения; любая
регрессия локализуется бисекцией `patches:<ref>` (pristine-базлайн p3:
`reports/colab-inline-p3-20260921T183727Z/`). Зелёный golden не отменяет
финальную сдачу глазами юзера (канон §4.3).

## Покрытие: канон → детектор → тест (v6, полный список 19 тестов)

| Канон | Детектор | Тест | Ожидание (2026-09-25) |
|---|---|---|---|
| §1.1 статус-бар одна строка | `sweep_status_single_line_<G>` | sweep_statusbar_invariants | PASS |
| §1.1 на случайных геометриях | `fuzz_geometry_<G>` | geometry_fuzz | по сиду |
| §1.8 минимум model+ctx (w≥40) | `sweep_w47_minimum` | sweep_w47_minimum | PASS (A9 закрыт патчем 56) |
| §1.9 скроллбек чист | `e1_garbage_long/resize/shorts` | e1_garbage_* | PASS (E1 закрыт 55) |
| §3 слэш-меню (E2) | `e2_slash_menu_w47/w180` | e2_slash_menu_* | PASS в tmux (локус юзера: zellij/WezTerm) |
| §3 тексты fg≠bg (E5) | `e5_color_contrast` | e5_color_contrast_menu | PASS в tmux (локус: dim у юзера) |
| §3 субагент-карточки | `cards_render` | cards_render | PASS (2 волны SCENARIO:subagents) |
| §3 компакция: фаза видима (C5) | `compact_visible` | compact_visible | PASS (C5 закрыт 58) |
| §3 стрим/thinking/usage | `scenario_smoke` | scenario_smoke | PASS |
| тихий обрыв стрима (D-b) | `stream_stall` | stream_stall | PASS после core 07 (RED до: ход умирает на max-tokens) |
| анимации: boolean off (патч 66) | `animations_gate` | animations_gate | **RED до патча 66** → PASS после |
| пила scrollHeight при скролле (патч 67) | `scroll_jitter` | scroll_jitter | **RED до патча 67** → PASS после (v7 inline-контракт) |
| §4.1 парити inline (гейт) | `mode_inline`, `mode_inline_pin` | mode_inline | PASS (фейл = блокер прогона) |
| чистый выход (гейт) | `exit_clean` | exit_clean | PASS |

Гейты инфраструктуры (`mode_inline`, `exit_clean`) в `--detectors` НЕ
включаются: их фейл = блокер транспорта/среды, не канон-пункт.

Артефактные (info, без ассерта): `e1_focus_probe` (фокус-проба юзера),
`e2_panels_artifacts` (ANSI-кадры /settings и /theme для E5).
Инварианты §1.2-1.7 (сепаратор, гейдж, метрика 1 раз, таймер, wedge, влезание)
проверены автодетекторами атласа 600 кадров (узел 1) и в live-сьют не дублируются.

## v6 (2026-09-25, TG-DSH-VISUAL-20260925 узел 5): trace-детекторы

Два новых теста читают ALWAYS-ON geometry-трейс (патч 61): на VM сьют
стартует dsh с `DSH_TUI_GEOMETRY_TRACE=$work/geo.jsonl` (boot_launch) —
детерминированный путь, глоб `geo.jsonl*` ловит ротацию 8МБ (`geo.jsonl.1`).
Общий детектор `tests/colab/trace-metrics.py` кладётся на VM setup-шагами
`trace_metrics_lib`/`trace_metrics_lib2` (два heredoc-чанка <15К по
транспорту; ast-гейт на VM; файл в репо и на VM синхронны байт-в-байт —
тело heredoc не содержит $переменных программы, executor раскрыл бы их).

**`animations_gate`** — двухслойный гейт animations off:
- слой 1: node-ассерт `normalizeAnimationsStyle(false)==='off'` на
  задеплоенном пакете (`/root/.dsh/profiles/<target>/node_modules/
  @deepseek-harness-tui/dsh-tui/lib/types/tuiDisplayPrefs.js`, профиль из
  `/root/.dsh-live-target`) — до патча 66 boolean из settings.yaml молча
  отбрасывался → mode 'full' (memory dsh-animations-boolean-ignored);
- слой 2: 0 кадров `cause='animation'` в IDLE-окне трейса (ClockContext.tick;
  дыхание рамки ~16 fps). Idle гарантируется: stream_stall сам ждёт конца
  хода (records=base+2), C-c гасит остатки, ●-счёт стабилен 3 тика.
  Resize-пульс (+1/-1 строка) в середине окна + `--require-frames 1` =
  гейт живости рендера (кадры обязаны быть, иначе «0 animation» вакуумен).

**`scroll_jitter`** — пила scrollHeight при ручном скролле (юзер-репорт
2026-09-25 «мигает и дёргается», memory dsh-scroll-height-saw-jitter: осцилляция
39↔42, 20 флипов/15с). Колесо мыши = SGR-байты через `tmux send-keys -H`:
wheel-up `1b 5b 3c 36 34 3b 32 34 3b 32 30 4d` (ESC [ < 64;24;20 M), wheel-down
= `...36 35...` (65); в inline без alt-screen dispatchWheelAt=false → событие
падает в legacy input-путь (parse-keypress SGR_MOUSE_RE → Chat.js wheel-ветка →
scrollBy(±3), sticky=false). Контент: SCENARIO:long ~20с + C-c + вся история
сессии. Детектор `--metric saw --expect clean --require-sticky-off`
(v9 inline-контракт, рекалибровка под патч 73 — golden
program_job_20260929T024120670464Z): патч 73 фиксирует кадр высотой
terminalRows → maxScroll>0, wheel-up легитимно скроллит историю (фича
гейта 67) → sticky_off>0 обязателен (0 = скролл не сработал, инфра exit 2);
продукт-RED = saw_flips>0 (флип = смена scrollHeight НЕ монотонным ростом —
спад/отскок при sticky=false; RED-якорь стека 77: пила 419↔418 от маунта
StickyPromptHeader in-flow, фикс = патч 75 CH.05 inline-chrome-overlay).
Ложный GREEN от мёртвого транспорта отсекают ДВА позитивных гейта: boot
DSH_TUI_DEBUG_MOUSE=1 → лог 'wheel arrive' (>=30 строк в окне [t0..t1],
mouse-debug.log processKeysInBatch) и aliveness трейса (>=50 кадров в
[t_stream..t0], report-режим require-frames). Прежний `--forbid-sticky-off`
(v7: maxScroll=0, колесо = no-op) — ЛЕГАСИ до патча 73.

Локальная валидация детектора (без VM, чистый парсинг трейса юзера —
`~/.dsh-tui/trace/geometry-2026-09-24.jsonl*`):

```bash
python3 tests/colab/trace-metrics.py \
  --trace ~/.dsh-tui/trace/geometry-2026-09-24.jsonl* \
  --from 2026-09-24T20:56:00Z --to 2026-09-24T20:57:00Z \
  --metric saw --expect dirty --detector-name saw_proof
# PASS: saw_flips=10 (пила юзера доказана)

python3 tests/colab/trace-metrics.py \
  --trace ~/.dsh-tui/trace/geometry-2026-09-24.jsonl* \
  --from 2026-09-24T20:56:00Z --to 2026-09-24T20:56:20Z \
  --metric anim --expect clean --detector-name anim_red
# FAIL exit 1: animation_frames=499 (RED-путь до патча 66 доказан)
```

Exit-коды детектора: 0 = PASS, 1 = продукт-RED (баг воспроизведён),
2 = инфра (трейс не пишется / окно без кадров / скролл не сработал —
НЕ продукт-фейл). Драйвер помечает тест reproduced по статусу fail/error;
различение продукт/инфра — по message `exit_code=1|2` и тексту DETECTOR-строки.

## Ожидаемые RED — открытые канон-пункты (честность golden)

RED — это не «сьют сломан», это воспроизведённый открытый пункт канона.
Текущее ожидание (v6, 2026-09-25):

- **`animations_gate`** — RED до патча 66: `normalizeAnimationsStyle(false)`
  → undefined ≠ 'off' + сотни кадров cause='animation' в idle-окне. После
  патча 66 — PASS ('off', 0 кадров).
- **`scroll_jitter`** — RED до патча 67: saw_flips>0 И sticky_off>0 при
  ручном скролле (юзер-трейс 24.09: 46/10). После патча 67 — PASS v7
  inline-контракта (sticky_off=0, saw_flips=0, wheel_arrive>=30,
  prewindow>=50 кадров).
- Остальные детекторы — PASS/GREEN (история закрытий: E1=55, A9=56, E5=56v2,
  C5=58, stream_stall=core 07); `geometry_fuzz` — по сиду.

Инфра-RED (блокер, НЕ канон-пункт): mode_inline, exit_clean, транспортные
таймауты (классификация по message — см. прогоны golden-65, все транспортные
фейлы node 3 разбирает по тексту DETECTOR-строк).

## Фейк-модель (tools/dsh-fake-llm, порт 8787 от деплоя шага 7f)

Сценарий выбирается маркером `SCENARIO:<name>` в последнем тексте пользователя
(берётся ПОСЛЕДНИЙ маркер — compaction-запросы инлайнят историю), затем
ключевыми словами (`compact` первым), fallback `short`.

| Маркер | Что делает |
|---|---|
| `SCENARIO:short` | дефолт: thinking + короткий текст |
| `SCENARIO:long` | длинный стрим `STREAM_TOTAL_MS` (деплой: 45с) — e1_garbage_long, scroll_jitter |
| `SCENARIO:maxtokens` | обрыв по stop_reason max_tokens + авто-продолжение (core 07) — stream_stall |
| `SCENARIO:ctx90` | usage ~90% окна (в сьюте не гоняется: выше порога авто-компакции) |
| `SCENARIO:tools` | цикл 3 tool_use (Bash→Read→Write) + финал (HTTP-уровень — в selftest) |
| `SCENARIO:waves` | 1 спавн субагента (полигон D7) |
| `SCENARIO:subagents` | **2 волны спавнов** — cards_render |
| `SCENARIO:usage` | usage-числа in 42k/cache 48k/out 3.8k (~35% окна) + tps в тексте — scenario_smoke |
| `SCENARIO:thinking` | delayMs 3с + thinking-стрим 6с — scenario_smoke |
| `SCENARIO:compact` | delayMs 4с + медленная сводка `COMPACT_TOTAL_MS` — compact_visible |

`delayMs` (поле сценария) — пауза до первого байта ответа в обоих режимах
(stream/non-stream): окно «модель думает» для детекторов фаз.

Мини-регрессия сервера: `node tools/dsh-fake-llm/selftest.mjs` (пункты (a)-(л):
протокол, tools-цикл, ctx90, long, waves, subagents×2, usage, thinking, compact).

## Ограничения и заметки

- Шаги сьюта <15К символов (чанк-канал colab exec): поэтому trace-metrics.py
  грузится двумя шагами (cat > + cat >>) с ast-гейтом; демоны в сьюте не
  поднимаются (fake-сервер стартует только деплой-скриптом `colab-dsh-up.sh`).
- Первый turn глотает SCENARIO-маркер — warmup-шаг в setup.
- Захват скроллбека: `tmux capture-pane -S -2000`; живые кадры: без `-S`.
- `SCENARIO:tools` не включён в сьют: tool-циклы E2E уже покрыты
  `cards_render` (subagents = tool_use→tool_result→continuation), а прямой
  Bash-цикл добавляет риск гейта tool-approval, не связанный с каноном.
- Прогон на VM запускает main после ревью — локально валидируются только
  yaml-парс, selftest сервера, размеры шагов и trace-metrics на юзер-трейсе.
- Трейс-путь на VM = `$work/geo.jsonl` (env `DSH_TUI_GEOMETRY_TRACE` в
  boot_launch): детерминирован, отдельен от boot-smoke (тому — дефолтный
  `~/.dsh-tui/trace/`), ротация ловится глобом `geo.jsonl*`.
