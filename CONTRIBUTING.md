# Контрибьюторам

dsh-tui — форк `@deepseek-harness-tui/dsh-tui@0.10.0-beta.4` с патч-стеком SUBSYS.FF.B (76 патчей). Этот документ описывает, как контрибьютить в проект.

## Workflow

1. **Fork** репозитория
2. Создай ветку от `main`: `git checkout -b feature/короткое-описание`
3. Внеси изменения (следуй правилам ниже)
4. Проверь: `apply-dsh-overrides.sh --verify` (pristine-hash), `patch-stack-lint.sh`
5. Golden-gate: сьют должен быть GREEN на test-VM
6. `git commit` — после каждого логического шага
7. `git push origin feature/...` — после завершения волны правок
8. Открой Pull Request в `main`

## Правила патч-стека

Патч-стек — основа проекта. Все изменения upstream-файлов идут через `.patch` файлы, никогда напрямую.

| Инвариант | Суть |
|---|---|
| **I1** pristine-hash | SHA256 upstream-файла до и после revert-all совпадает. Проверка: `apply-dsh-overrides.sh --verify` |
| **I2** Ноль ручных правок live | Любое изменение upstream-файла — через новый или отредактированный `.patch`. Прямая правка live-файла вне патча = дрейф |
| **I3** Fresh-apply failed=0 | После правки патча: revert-all → apply-all. `failed=0` обязательно. Проверка: `apply-dsh-overrides.sh` |
| **I4** Golden-gate | Сьют `dsh-tui-inline.yaml` должен быть GREEN (20/20 детекторов) перед merge |
| **I5** Метаданные в шапках | Каждый патч содержит DEP-3 шапку: `Subsystem`, `Family`, `Status`, соответствие `PATCH-SERIES` ↔ файлам |

### Новый патч

1. Создай `.patch` файл в `dsh-overrides/patches/` с DEP-3 шапкой
2. Добавь запись в `dsh-overrides/patches/PATCH-SERIES`
3. Добавь marker в `scripts/apply-dsh-overrides.sh` (MARKERS + marker_file)
4. Примени стек: `scripts/apply-dsh-overrides.sh` — проверь `failed=0`
5. Запусти `patch-stack-lint.sh` — шапки и series ↔ files соответствие
6. Golden-gate (I4)

### Правка существующего патча

1. Revert всего стека: `apply-dsh-overrides.sh --revert-all`
2. Отредактируй `.patch` файл
3. Apply всего стека: `apply-dsh-overrides.sh` — проверь `failed=0`
4. Golden-gate (I4)

**Никогда** не правь live-файл напрямую без revert-all → apply-all цикла.

### Нумерация патчей

Иерархическая: `SUBSYS.FF.B.NN-slug` (подсистема.семья.ветвь.номер-slug). 12 подсистем:

| Код | Домен |
|---|---|
| IL | inline-рендер, скроллбек, log-update |
| SB | статус-бар / футер-слоты |
| CH | Chat-компоновка |
| MS | MessageList / высоты сообщений |
| TG | тодо-панель / субагент-карточки |
| HB | хабы и панели настроек |
| EF | эффекты / анимации / спиннеры |
| TH | темы / аппеаранс / превью |
| PR | провайдер / модель / канал |
| PI | промпт-инпут |
| TR | терминал-инфра / клавиатура / трейс |
| ID | идентификация форка |

## TDD

Нетривиальная логика (ветвление, парсинг, вычисления) — **сначала тесты** (red), потом реализация (green).

- Тесты в `tests/`
- Проверка синтаксиса через `node --check` после каждого изменения
- После правки патча — revert-all → apply-all, `failed=0` обязательно

## Git

- Коммить после каждого логического шага
- Не коммитить секреты, `.env`, токены, session-файлы, большие логи
- Push origin после завершения волны правок
- Ветку от `main`; длинные волны — отдельная ветка
- Сообщения коммитов: `type(scope): описание` (conventional commits)

## Тестирование

### Golden suite

Сьют `tests/colab/dsh-tui-inline.yaml` — 20 детекторов, 97 substeps. Должен быть GREEN перед merge.

Категории детекторов:
- E1 (скроллбек), E2 (slash-меню), E5 (dim-контраст), E7 (todo-panel)
- Статус-бар (9 инвариантов, sweep по 4 геометриям)
- Геометрия (fuzz-стабильность), сценарии (smoke, cards, compact, stream)
- Scroll jitter (пила высот), animations gate, exit clean

### Termux suite

Сьют `tests/colab/dsh-termux-inline.yaml` — parity Termux (6 детекторов).

## DEP-3 шапки

Каждый патч содержит шапку в формате DEP-3:

```
Subsystem: SUBSYS.FF.B
Family: SB (или IL, CH, MS, ...)
Status: LIVE (или DEAD-DROP, ABSORBED)
```

Соответствие `PATCH-SERIES` ↔ файлам патчей проверяется `patch-stack-lint.sh`.

## Канон

- Канон статус-бара: `docs/canon/STATUS-BAR-CANON.md` — 9 инвариантов, приоритет жертвенности 14 полей
- Визуальный канон: `docs/canon/VISUAL-CANON.md` — 13 поверхностей
- Чек-лист маппинга канон → evidence: `docs/canon/CANON-CHECKLIST.md`

## Структура проекта

```
dsh-overrides/
  patches/           # .patch файлы (76 live)
  PATCH-SERIES       # реестр патчей (apply/revert по серии)
  PATCH-MAP.md       # карта old-ID → SUBSYS.FF.B
scripts/
  apply-dsh-overrides.sh    # применение стека (идемпотентно по маркерам)
  dsh-drift-detect.sh       # I2: детектор дрейфа
  patch-stack-lint.sh       # I5: шапки и series ↔ files
  patch-stack-regen.sh      # реген ветви из live-vs-pristine diff
tests/
  colab/             # SOC-сьюты (golden, termux)
  patch-stack/        # тесты series apply/revert
docs/canon/          # каноны, чек-листы, вердикты
```
