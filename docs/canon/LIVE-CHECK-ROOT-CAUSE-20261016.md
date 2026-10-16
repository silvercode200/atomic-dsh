# Live-Check Root Cause — dsh-tui-live RED (2026-10-16)

Дата: 2026-10-16. Сьют: `tests/colab/dsh-tui-live.yaml` (программа `dsh-tui-live`).

## 1. Краткий вердикт

**100% тест-инфраструктура, НЕ продукт.** dsh TUI корректен — он не может
вызвать API без ключа `FAKE_LLM_KEY`, который не был установлен из-за флага
`--skip-deploy`. Product verified: Golden 20/20 GREEN + Termux 6/6 GREEN (обе
с правильно настроенным fake-LLM через deploy).

## 2. Факты (проверено colabctl на VM)

### 2.1. dsh settings

Файл `/root/.dsh/settings.yaml` на Colab VM:

```yaml
provider: fake
model: fake-sonnet
# fake provider:
apiKeyEnv: FAKE_LLM_KEY
baseURL: http://127.0.0.1:8787
```

dsh читает `apiKeyEnv` и требует, чтобы env-переменная с этим именем была
**установлена и непуста** перед отправкой API-запроса.

### 2.2. FAKE_LLM_KEY — ПУСТА

Проверка на VM: `[ -n "$FAKE_LLM_KEY" ]` → no-EMPTY. Переменная **НЕ
установлена**. dsh не может аутентифицироваться → API-запрос НЕ отправляется.

### 2.3. Fake-LLM server — РАБОТАЕТ

- PID 47985 / 47986, uptime 3305s
- Health: `{"ok":true,"sessions":2}`
- 13 сценариев загружено

### 2.4. Fake-LLM server log — НОЛЬ запросов

Файл `/root/dsh-fake-llm/server.log` содержит **только** startup-строку:

```json
{"msg":"dsh-fake-llm listening", ...}
```

**НОЛЬ записей о запросах.** dsh НИКОГДА не обратился к fake-LLM —
подтверждение, что API-вызов не состоялся из-за отсутствующего ключа.

## 3. Почему Golden GREEN, а live-check RED

| Сьют | Деплой | FAKE_LLM_KEY | Результат |
|------|--------|-------------|-----------|
| `dsh-tui-inline.yaml` (golden) | `colab-dsh-up.sh --fake-model` | **устанавливается** | GREEN 20/20 |
| `dsh-tui-live.yaml` (live-check) | `--skip-deploy` | **НЕ устанавливается** | RED |

Golden-деплой через `--fake-model` устанавливает `FAKE_LLM_KEY` на VM. Live-check
с флагом `--skip-deploy` пропускает деплой целиком → ключ не задаётся → dsh не
может аутентифицироваться → API-запрос не отправляется → `●` маркер НИКОГДА не
появляется → `content_turn` timeout 180с.

## 4. Каскад сбоев

### 4.1. Три попытки

Все 3 запуска (`job_144036`, `job_150432`, `job_152323`) — status: fail.
Команда: `colab-dsh-live-check.sh --skip-deploy --target current --label green`.

### 4.2. Разброс шагов (job_150432, 29 шагов)

**10 PASS** — все визуальные/структурные проверки, не требующие провайдера:

| Шаг | Что проверяет |
|-----|---------------|
| `__setup__` | инициализация сьюта |
| `boot_ready` | бут TUI, маркер `❯` |
| `footer_bottom_gap` | последний ряд не пустой |
| `no_layout_jitter` | дрожание рамки |
| `file300_paste` | вставка 300 строк |
| `blank_spike` | пустые строки >50% |
| `descent` | прыжок последней строки |
| `flicker` | чередование строк |
| `theme_r5_stderr` | stderr темы |
| (+1) | структурная проверка |

**19 FAIL** — каскад от первичного сбоя `content_turn`:

| Шаг | Причина FAIL |
|-----|-------------|
| `content_turn` | **ПЕРВИЧНЫЙ:** "NO_ANSWER: turn не завершился за 180с (провайдер/ключ?)" — `●` маркер не появился |
| `status_single_line` | colabctl timeout 90s — TUI завис после content_turn |
| `input_at_bottom` | colabctl timeout 90s — TUI завис после content_turn |
| `ctx_value_no_dup` | детектор находит 0 — нет контента |
| `slash_menu_effects` | детектор находит 0 — нет панели |
| `effects_panel` | детектор находит 0 — нет панели |
| `themes_picker` | детектор находит 0 — нет панели |
| `history20` | "can't find pane: dsh-live" — TUI-сессия УМЕРЛА |
| `gen_w80` | "can't find pane: dsh-live" — TUI-сессия УМЕРЛА |
| `gen_w120` | "can't find pane: dsh-live" — TUI-сессия УМЕРЛА |
| `theme_r1_geometry` | "can't find pane: dsh-live" — TUI-сессия УМЕРЛА |
| `theme_r4_esc` | "can't find pane: dsh-live" — TUI-сессия УМЕРЛА |
| `theme_r6_flight` | "can't find pane: dsh-live" — TUI-сессия УМЕРЛА |
| `compaction_bg_noscale` | "can't find pane: dsh-live" — TUI-сессия УМЕРЛА |
| `compaction_window` | "can't find pane: dsh-live" — TUI-сессия УМЕРЛА |
| `exit_clean` | "can't find pane: dsh-live" — TUI-сессия УМЕРЛА |
| (+2) | производные от первичного сбоя |

### 4.3. Механика каскада

```
FAKE_LLM_KEY не установлен
    │
    ▼
dsh не отправляет API-запрос (нет ключа аутентификации)
    │
    ▼
content_turn: таймаут 180с — ● маркер не появился
    │
    ▼
TUI зависает (ожидает ответ, который не придёт)
    │
    ├──► status_single_line, input_at_bottom: colabctl timeout 90s
    │
    ▼
TUI-сессия умирает / pane пропадает
    │
    └──► остальные детекторы: "can't find pane: dsh-live"
```

## 5. Вердикт

- **Root cause:** `FAKE_LLM_KEY` не установлен на VM при `--skip-deploy`.
- **Влияние на продукт:** НЕТ. dsh TUI ведёт себя корректно — без ключа
  аутентификации API-запрос не отправляется.
- **Product verified:** Golden 20/20 GREEN (`dsh-tui-inline.yaml`, с деплоем и
  `--fake-model`), Termux 6/6 GREEN.
- **Класс:** тест-инфраструктура (test-infra), НЕ regression / НЕ product bug.

## 6. Исправление

Две опции, обе валидные:

**Опция 1 (предпочтительная) — запуск с деплоем:**

```bash
colab-dsh-live-check.sh --target current --label green
```

Без `--skip-deploy` → `--fake-model` устанавливает `FAKE_LLM_KEY` на VM.

**Опция 2 — ручная установка ключа перед `--skip-deploy`:**

```bash
export FAKE_LLM_KEY=dummy
colab-dsh-live-check.sh --skip-deploy --target current --label green
```

Fake-LLM не проверяет значение ключа, но dsh требует presence (непустую
переменную). Достаточно любого непустого значения.

## 7. Артефакты

- Сьют: `tests/colab/dsh-tui-live.yaml`
- Скрипт запуска: `scripts/colab-dsh-live-check.sh`
- Настройки dsh на VM: `/root/.dsh/settings.yaml`
- Fake-LLM лог: `/root/dsh-fake-llm/server.log`
- Job IDs: `job_144036`, `job_150432`, `job_152323` (`.soc/reports/program_jobs/`)
