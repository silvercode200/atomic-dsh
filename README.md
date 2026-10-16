# atomic dsh — self-contained DeepSeek harness TUI

atomic dsh — self-contained, vendored terminal AI assistant built on dsh-tui 0.10.0-beta.4. Harness and TUI patched in-tree (no runtime dependency on `@deepseek-ai/*`), bundled with lazy MCP / lazy skills / spot plugins, 50+ themes, and a first-run setup wizard.

Ключевые возможности:
- **Beautiful UI**: 50+ themes with live-preview (fullscreen preview), animated powerline status bar, 58 spinners, escape overlay effects
- **Lazy MCP + lazy skills**: ~94% tool-schema token cut (9727→581 per turn), activate/deactivate MCP on-demand, skill_search/skill_load
- **Robust & stable**: answers don't get cut off, survives flaky connections / SSHFS / session restarts / stream drops, no freezes or loops
- **Recursive task tree** with subagent cards
- **Works in any terminal**: kitty, WezTerm, Termux, zellij
- **Setup wizard**: configure your own provider/key

## Требования

- **Node ≥ 22** — ниже даёт engine error при установке dsh
- **pnpm** — для `dsh plugin` (активировать: `corepack enable`)

## Быстрый старт

### 1. Установка harness CLI

```bash
npm install -g @deepseek-ai/dsh
corepack enable
```

### 2. Установка TUI

```bash
npm install -g --ignore-scripts @deepseek-harness-tui/dsh-tui
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@0.10.0-beta.4 -w
```

Флаг `--ignore-scripts` нужен из-за бага protobufjs postinstall в npm 11.

### 3. Применение патч-стека

```bash
git clone <repo-url> && cd deepseek_harness
bash scripts/apply-dsh-overrides.sh
```

Скрипт идемпотентен по маркерам — безопасно запускать повторно. Проверка целостности:

```bash
bash scripts/apply-dsh-overrides.sh --verify
```

### 4. Запуск

```bash
dsh --profile dsh-tui
```

Первый запуск авто-инициализирует конфигурацию. Провайдеры и модели настраиваются в `settings.yaml`.

## Структура

```
deepseek_harness/
├── dsh-overrides/
│   ├── patches/              # 76 .patch SUBSYS.FF.B + PATCH-SERIES
│   ├── core-patches/         # патчи на @deepseek-ai/* пакеты
│   ├── themes/               # 50+ themes (signature.json = true black)
│   ├── PATCH-MAP.md          # карта old-ID → SUBSYS.FF.B
│   └── settings/             # settings.yaml.example, appearance.json
├── scripts/
│   ├── apply-dsh-overrides.sh    # применение стека (--verify для I1)
│   ├── colab-dsh-up.sh           # деплой стека на test-VM
│   ├── dsh-drift-detect.sh       # детектор ручных правок (I2)
│   ├── patch-stack-lint.sh       # линтер шапок DEP-3
│   ├── patch-stack-regen.sh      # реген ветви из live diff
│   └── generate-pristine-manifest.sh
├── tests/
│   ├── colab/dsh-tui-inline.yaml # golden-сьют v10
│   └── patch-stack/test-series-apply.sh
├── tools/
│   └── dsh-fake-llm/             # сервер :8787, сценарии для тестов TUI
└── README.md
```

## Патч-стек SUBSYS.FF.B

Стек из 76 патчей с иерархической нумерацией: `подсистема.семья.ветвь` (например `IL.03.1`). Формат DEP-3, метаданные в шапке каждого патча.

### 12 кодов подсистем

| Код | Домен |
|---|---|
| IL | inline-рендер, скроллбек, log-update |
| SB | статус-бар / футер-слоты |
| CH | Chat-компоновка: пустой экран, интро, fs-футер |
| MS | MessageList / высоты сообщений |
| TG | тодо-панель / субагент-карточки |
| HB | хабы и панели настроек |
| EF | эффекты / анимации / спиннеры |
| TH | темы / аппеаранс / превью |
| PR | провайдер / модель / канал |
| PI | промпт-инпут |
| TR | терминал-инфра / клавиатура / трейс |
| ID | идентификация форка: лого, версия, update-notice |

### Порядок применения

Серия определена в `dsh-overrides/patches/PATCH-SERIES` — одна строка = один патч, порядок строгий. Карта маппинга old-ID → SUBSYS.FF.B — в `dsh-overrides/PATCH-MAP.md`.

### Инварианты

| # | Инвариант | Инструмент |
|---|---|---|
| I1 | Pristine-hash: sha256 upstream до/после revert-all совпадает | `apply-dsh-overrides.sh --verify` |
| I2 | Ноль ручных правок live вне патчей | `dsh-drift-detect.sh` |
| I3 | Fresh-apply: revert-all → apply-all, failed=0 | `apply-dsh-overrides.sh` |
| I4 | Golden-gate: сьют GREEN перед merge | `tests/colab/dsh-tui-inline.yaml` |
| I5 | Метаданные в шапках: DEP-3 / Family / Status / series ↔ files | `patch-stack-lint.sh` |

### Тест патч-стека

```bash
bash tests/patch-stack/test-series-apply.sh
```

13+ ассертов: порядок серии, соответствие PATCH-SERIES ↔ файлам, идемпотентность apply.

## Темы

50+ themes в `dsh-overrides/themes/`. Signature-тема — `signature.json`:

- **True black фон**: `appBackground: #000000`
- **WCAG AA_adjusted**: цвета проверены на контраст ≥4.5:1 для текста
- **Рендеринг из темы**: фон берётся из `appBackground` (env > settings > theme)

Пикер тем — команда `/theme` в TUI:
- Фильтр-поиск по имени
- 8 свотчей быстрого выбора
- Превью темы в реальном времени

## Тестирование

### Golden-сьют

`tests/colab/dsh-tui-inline.yaml` v10 — замороженный E2E-набор: 20 детекторов, 97 substeps.

| Категория | Детекторы | Что проверяют |
|---|---|---|
| Baseline | `mode_inline` | inline-рендер базовый |
| E1 scrollback | `e1_garbage_long`, `e1_garbage_resize`, `e1_garbage_shorts`, `e1_focus_probe` | чистота скроллбека от копий хрома |
| E2 slash-menu | `e2_slash_menu_w47`, `e2_slash_menu_w180` | рендер slash-меню на узких/широких терминалах |
| E5 contrast | `e5_color_contrast` | WCAG-контраст текста |
| Status bar | `sweep_statusbar_invariants`, `sweep_w47_minimum` | инварианты статус-бара на разных ширинах |
| Geometry | `geometry_fuzz` | стресс viewport-геометрии |
| Scenario | `scenario_smoke` | end-to-end сценарий |
| Cards | `cards_render` | рендер субагент-карточек |
| Stream | `stream_stall` | обнаружение зависания стрима |
| Animations | `animations_gate` | гейт эффектов/анимаций |
| Scroll | `scroll_jitter` | дрожание высот при скролле |
| E7 todo | `e7_todo_scrollback` | todo-панель в скроллбеке |
| Compaction | `compact_visible` | видимость фазы компакта |
| Exit | `exit_clean` | чистый выход |
| Blank/flicker | `blank_spike` | обнаружение пустых зон и морганий |

### Fake-LLM

`tools/dsh-fake-llm/` — сервер на :8787, эмулирует модель для тестирования TUI без реального API. Сценарии: streaming, tool-use, субагенты, ошибки.

### Запуск golden-сьюта

```bash
# 1. Деплой стека на test-VM
bash scripts/colab-dsh-up.sh --target current

# 2. Прогон сьюта через тест-раннер с tests/colab/dsh-tui-inline.yaml
# Зелёный порог: 20/20 детекторов PASS
```

## Конфигурация

### settings.yaml

Основной конфиг TUI:
- `llm-pi-ai.providers` — роуты провайдеров (api, apiKeyEnv, baseURL, models)
- `agent-default-model` — модель по умолчанию
- `compaction-basic` — автокомпакт (`thresholdRatio`)

Пример:

```yaml
llm-pi-ai:
  providers:
    bg:
      api: anthropic-messages
      apiKeyEnv: DSH_BG_API_KEY
      baseURL: https://your-relay.example
      models:
        - id: glm-5.3
cli:
  api: anthropic-messages
  apiKeyEnv: DSH_CLI_AUTH_TOKEN
  baseURL: http://localhost:8350
  models:
    - id: opus
    - id: sonnet
agent-default-model: bg/glm-5.3
```

### appearance.json

Тумблеры эффектов и настройки тем:
- `animationsMode` — гейт эффектов (spinnerRainbow, inputBreathe, todoPulse и др.)
- `appBackground` — цвет фона (env > settings > theme)

### Переменные окружения

| Переменная | Назначение |
|---|---|
| `DSH_TUI_GEOMETRY_TRACE` | Трейс геометрии кадров (always-on); ротация 8 МБ. `=0` — kill-switch, `=<file>` — оверрайд пути лога |
| `DSH_TUI_SYNC_OUTPUT` | Синхронизированный вывод для терминалов с flicker |
| `DSH_RETRY_BUDGET_MIN` | Минимальный бюджет ретраев запросов |

Секреты (`DSH_BG_API_KEY`, `DSH_CLI_AUTH_TOKEN`) хранятся в credentials-файле, не коммитятся.

## Контрибьюторам

### Правила патч-стека

1. **Никогда не правь live-файлы вне патчей** (I2). Любое изменение upstream-файла — через новый или отредактированный `.patch`.
2. **После правки патча: revert-all → apply-all** (I3). Проверь `failed=0` в выводе `apply-dsh-overrides.sh`.
3. **Golden-gate перед merge** (I4). Сьют должен быть GREEN на test-VM.
4. **DEP-3 шапки обязательны** (I5). Каждый патч содержит: `Subsystem`, `Family`, `Status`, соответствие `PATCH-SERIES` ↔ файлам.
5. **Новый патч = новая запись** в `PATCH-SERIES` + marker в `apply-dsh-overrides.sh`.

### TDD

Нетривиальная логика (ветвление, парсинг, вычисления) — сначала тесты (red), потом реализация (green). Тесты в `tests/`. Проверка синтаксиса через `node --check` после каждого изменения.

### Git

- Коммить после каждого шага
- Не коммитить секреты, `.env`, токены, большие логи
- Push origin после завершения волны правок

---

*forkVersion: +p76 · upstream: @deepseek-harness-tui/dsh-tui@0.10.0-beta.4 · 12 подсистем SUBSYS.FF.B*
