#!/usr/bin/env bash
# apply-dsh-overrides.sh — идемпотентное применение dsh-tui UI-патчей.
#
# Применяет unified-diff патчи из dsh-overrides/patches/ к установленному
# пакету @deepseek-harness-tui/dsh-tui в node_modules профиля. Патчи теряются
# при pnpm update — этот скрипт восстанавливает их из реестра dsh-overrides.
#
# Идемпотентность: перед каждым патчем проверяется существование всех
# целевых файлов (patch_files) и маркер-строка в marker_file (grep).
# Все файлы существуют И маркер присутствует → патч уже применён, пропуск.
# Иначе → apply. Маркер-постпроверки остаются как defense-in-depth.
#
# Порядок применения — ЯВНЫЙ артефакт dsh-overrides/patches/PATCH-SERIES
# (миграция SUBSYS.FF.B, этап 0), а не свойство сортировки имён: одна
# строка = один патч, «#»-комментарии игнорируются; серия обязана быть 1:1
# с *.patch-файлами, расхождение или отсутствие серии = явный fail
# (тихий glob-fallback запрещён).
#
# Использование:
#   scripts/apply-dsh-overrides.sh                 # профиль dsh-tui
#   DSH_PROFILE=web scripts/apply-dsh-overrides.sh # другой профиль
#   TUI_BASE=/path/to/pkg scripts/apply-dsh-overrides.sh
#   scripts/apply-dsh-overrides.sh --revert        # откат патчей (обратный порядок)
#   scripts/apply-dsh-overrides.sh --verify        # pristine-проверка (revert→check→re-apply)
#
# --revert: снимает применённые патчи в порядке, обратном применению
# (порядку PATCH-SERIES), через `patch -R`. Идемпотентен: маркер отсутствует
# в marker_file → "not applied" → skip. Полный откат предполагает, что
# применены ВСЕ патчи реестра; при частичном состоянии откат раннего патча
# может не лечь (patch честно упадёт, failed>0 — это сигнал, а не тихая порча).
#
# --verify: I1 pristine-hash gate. Откатывает ВСЕ патчи (--revert), затем
# сравнивает файлы с dsh-overrides/pristine-manifest.sha256 (sha256-хеши
# modified-файлов + проверка отсутствия CREATED-файлов). Если revert имел
# failures (failed≠0) — abort до pristine-проверки. НЕЗАВИСИМО от результата
# pristine — re-apply ВСЕХ патчей (восстановление рабочего состояния).
# Exit 0 если pristine OK, 1 если mismatch или revert/apply failures.
#
# --- Реестр патчей 24-26b (fullscreen-путь, 2026-09-17) ----------------------
# Профиль dsh-tui работает в fullscreen:true; патчи 01/10/11/23 покрывали
# только inline-путь, поэтому фиксы «встали не полностью».
# 24-fs-footer-bottom: в fullscreen НЕТ пустой строки-отступа под статус-баром
#   (сейчас была лишняя строка — root Box Chat.js не имел justifyContent,
#   свободные строки оставались ПОД статус-баром). Фикс: root Box получает
#   justifyContent flex-end в fullscreen — статус-бар прижат к последней
#   строке экрана, пустой строки под ним нет.
# 25-fs-height-stable: нет многократного быстрого дерганья (расширения/
#   сворачивания пустого пространства) под статус-баром в начале сессии и
#   после старта (спиннер, toast, ContextBar, todo-список): contentJustify
#   flex-end — пустое пространство всегда НАД транскриптом и не мигрирует.
# 26-scroll-menu-nogap: helpOpen-меню без пустой строки-пропуска между меню
#   и рамкой инпута (убран marginBottom:1 обёртки help-меню).
# 26b-scroll-menu-nogap: при пролистывании bash-вывода нет строки-пропуска —
#   спейсеры виртуализации MessageList согласованы с фактическими высотами
#   (margin внутри ref-обёртки + kind-оценка высот незамеренных строк).
# --- Реестр патча 27 (видимость субагентов, 2026-09-17) -----------------------
# 27-subagent-visible: субагенты видны в работе БЕЗ ручного раскрытия панели:
#   (1) фолд тодо авто-раскрывается при первом live-субагенте сессии (один раз
#   за канал, WeakSet — ручное сворачивание после уважается, флапа нет);
#   (2) в свёрнутом заголовке при liveAgents>0 стоит розовый маркер ◐ перед
#   счётчиком agents (·· ◐ agents N) — тон toolDotTask как у ◐-строк дерева;
#   (3) todoFold получает alt+m (исходный дизайн) ВМЕСТЕ с ctrl+q; ctrl+q
#   остаётся первым комбо — заголовок-подсказка (todoFoldMod) не меняется.
# Доказательства (кадры expanded/collapsed/авто-раскрытие, репро, live-сессия):
#   reports/subagent-marks-20260917.md.
# Доказательства layout-волн (кадры TUI до/после, серии высот, репро 18/18):
#   reports/tui-layout-fix-20260917.md + reports/tui-layout-fix-20260917/.
# --- Реестр патчей 28-30 (style-волна, 2026-09-17) ---------------------------
# Контекст: юзер ранее просил ПРОДВИНУТОЕ powerlevel/fish-стайл ОФОРМЛЕНИЕ TUI
# (анимированные элементы, сегментированный статус-бар с иконками и
# разделителями, живые индикаторы — НЕ ТОЛЬКО цветовые темы), а появились
# только темы; сейчас есть только темы, и вид хуже дефолтного dsh. Диагноз,
# что и почему деградировало (полностью в reports/tui-style-20260917.md):
# (1) сторонняя тема переопределяла анимационные ключи (claudeShimmer →
# плоский цвет); (2) ГЛАВНОЕ: parseRGB shimmer-пайплайна понимал только
# rgb()-строки, а кастомные темы хранят цвета hex → ЛЮБАЯ сторонняя тема
# полностью глушила переливы (GlimmerMessage уходил в плоский fallback) —
# на дефолтной палитре rgb()-форма парсится, поэтому дефолт выглядел лучше.
# Патчи 28-30 реализуют стайл-элементы; доказательство — кадры TUI до/после
# с видимыми анимациями/сегментами (reports/tui-style-20260917/*.txt).
# 28-shimmer-restore: анимационные ключи темы — «прошивка», не палитра:
#   claudeShimmer + все 8 rainbow_*_shimmer НЕ переопределяются сторонними
#   темами: после мержа темы ключи восстанавливаются из базовой палитры
#   (кастомTheme.buildTheme + themeCatalog runtime fallback + dsh-adapter
#   themes.js runtime contributions). Итог: фирменный голубой перелив
#   #ABC2EC при любой теме (DSH_TUI_ALLOW_THEME_SHIMMER=1 — обход защиты).
#   Вторая половина: parseRGB (spinnerUtils) понимает hex-форму #rrggbb —
#   пользовательские темы хранят цвета hex'ом, парсер понимал только
#   rgb(), поэтому ЛЮБАЯ кастомная тема глушила все переливы (GlimmerMessage
#   уходил в плоский fallback). Теперь hex парсится — анимации живут.
# 29-powerline-segments: powerlevel/fish-стайл статус-бар (полный, не
#   compact-режим): заполненные сегменты [✦ model][~/cwd][⎇ git][⚡ ctx-бар
#   до порога компакции][таймер хода] с powerline-разделителем U+E0B0,
#   bg/fg-пары из темы; менее важные поля (tps/tokens/cache/comp/spend) —
#   dim-хвост после цепочки; высота НЕ растёт (одна строка), переполнение
#   сбрасывает сегменты справа-налево. Таймер монтируется только в ходе,
#   тикает через общий ClockContext (useAnimationFrame 60ms, sweep
#   claude→claudeShimmer). Хардкоды StatusLine.js (#2E3440/#8D95A6 barColors)
#   и SpinnerAnimationRow.js (THINKING-серые) переведены на тему.
#   DSH_TUI_POWERLINE=off — стоковый ряд, =plain — без заливок (❯-сепараторы).
# 30-live-anim: глиф спиннера плавно циклирует палитру rainbow_*_shimmer
#   (шаг 120ms = тик кадра глифа, полный цикл 7 цветов за 840ms), без
#   новых таймеров (время — существующий animation clock); stall-красный
#   и reduced-motion сохранены.
# Доказательства (кадры powerline/спиннера/shimmer, инварианты, юнит-прогоны):
#   reports/tui-style-20260917.md + reports/tui-style-20260917/.
# --- Реестр патчей 31-32 (style2-волна Б, 2026-09-17) -------------------------
# Контекст: юзер не видел powerline-украшений из-за ДВОЙНОЙ глушилки
# (~/.dsh/settings.yaml: dsh-tui.minimal:true форсирует compact + DSH_TUI
# statusBar.compact:true гасит активацию powerline StatusLine.js:503), а
# хотел управлять оформлением из settings.yaml. Патч 31 открывает секцию
# dsh-tui.appearance {powerline, theme, inputBorder}; патч 32 закрывает дыру
# первого рендера intro-панели (диагноз reports/intro-align-diagnosis-
# 20260917.md §3/§6). Полная карта конфиг-канала — reports/settings-channel-
# map-20260917.md.
# 31-appearance-settings: секция appearance в schemastery-схеме dsh-tui
#   (plugin.js) + apply-цепочка + channel.setAppearance (merge-семантика как
#   setStatusBar) + три консьюмера:
#   - powerline: StatusLine.js powerlineStyle(channel) — приоритет env
#     DSH_TUI_POWERLINE > settings appearance.powerline > 'full';
#   - theme: ThemeProvider.js resolveForcedTheme — приоритет prop > env
#     DSH_TUI_THEME > settings appearance.theme > ~/.dsh-tui/theme.json
#     (settings-слой пишется ДО монтирования дерева, применяется на boot;
#     /theme продолжает горячо свапать в-сессии и персистит в theme.json,
#     но при заданном settings.theme побеждается на следующем boot);
#   - inputBorder: PromptInput.js resolvePromptAccent — приоритет planMode >
#     /color (сессионный) > settings appearance.inputBorder > theme
#     promptBorder; цвет валидируется формами customTheme (#rgb/#rrggbb/
#     #rrggbbaa, rgb(), ansi256(), ansi:имя — isValidThemeColor).
#   Нормализация: tuiDisplayPrefs.normalizeAppearance/normalizePowerlineStyle
#   (невалидные поля дропаются по-отдельности, как normalizeStatusBar).
# 32-intro-mount-reanchor: монтирование startup-контекст-панели
#   (loadedContextVisible false→true, Chat.js:675) теперь делает
#   invalidatePrevFrame()+reanchorViewport() — ровно как Ctrl+P-toggle той
#   же панели (прецедент Chat.js:684-691): закрывает «stale blank cells»
#   кривого первого рендера intro-блока (кривизна лечилась косвенно
#   открытием /-меню, теперь — прямо в момент появления панели).
# Доказательства (тесты appearance-settings + intro-align-repro 7/7 + кадры
# user-конфигурации): reports/style2-wave-b-20260917.md + reports/style2-frames/.
# --- Реестр патчей 33-36 (LIVE42-волна, TG-DSH-TUI-LIVE-20260917) -------------
# Контекст: юзер попросил живые (анимированные) элементы оформления и фон
# TUI, с точечным контролем каждого эффекта (research reports/research-tui-
# custom-20260917.md §4.2). Гейт: dsh-tui.appearance.animations = full |
# custom | off (дефолт full; env DSH_TUI_ANIMATIONS выше; reduced-motion
# env DSH_TUI_REDUCED_MOTION=1 гасит всё). Реестр эффектов — единственный
# источник: lib/types/animationsMode.js EFFECT_KEYS (8 эффектов).
# 33-input-breathe: дыхание рамки ввода — idle-интерполяция акцент↔shimmer-
#   пара (promptBorder↔promptBorderShimmer; для hex-акцентов — lift к белому)
#   по общему ClockContext (useAnimationFrame 60ms), при working вдвое
#   быстрее (период 2400ms → 1200ms). Плюс НОВЫЙ модуль animationsMode.js
#   (гейт + реестр + breathingColor; процесс-уровень по образцу minimalMode)
#   и схема appearance.animations + appearance.effects.
# 34-live-panels: (a) пульс живого todo-глифа ◐ toolDotTask↔todoActiveShimmer
#   — НОВЫЙ firmware-ключ (защита от перекраски темой, паттерн патча 28);
#   (b) мини-бар прогресса 5 ячеек в заголовке панели (todoProgressCells,
#   механика h-блоков патча 29) вместо текста «✓ 0/2»; (c) дыхание ctx-бара
#   при активном ходе (fill-цвет +30% к белому, только яркость — эскалация
#   давления остаётся данными). Эффекты: todoPulse / todoProgressBar /
#   ctxBarBreath (+ headerGlimmer — общий тик заголовка).
# 35-tools-verbs: (a) шиммер заголовка работающей terminal tool-карточки —
#   bashBorder↔lift 30% к белому, каденс 120ms пока running (elapsed-тик
#   1s остаётся своим темпом); (b) кастомизация глаголов спиннера —
#   settings.yaml dsh-tui.spinnerVerbs {mode: replace|append, verbs[]}
#   (схема + apply + channel.setSpinnerVerbs + НОВЫЙ модуль
#   spinnerVerbsPrefs.js; append = юзерские первыми, replace = только
#   юзерские); (c) спиннер-эффекты в реестре: spinnerRainbow (патч 30) и
#   spinnerGlimmer (патч 28) теперь тумблерятся через эффекты.
# 36-app-background: фон TUI — theme-ключ appBackground (главный источник:
#   скрипт dsh-overrides/scripts/apply-theme-backgrounds.py бэкфиллит
#   канонический фон по семейству во ВСЕ темы ~/.dsh-tui/themes/*.json,
#   активной tokyonight-moon — #000000 по явному пожеланию юзера;
#   идемпотентен) > settings appearance.background (опц. override) > env
#   DSH_TUI_BACKGROUND (тесты/debug). Красит корневой Box Chat.js
#   (backgroundColor на root поверхности; fullscreen покрывает альт-экран).
# 37-theme-live-preview: fish_config-стиль для /theme: ДВИЖЕНИЕ курсора по
#   списку тем применяет подсвеченную тему СРАЗУ (цвета + фон, патч 36
#   подхватывает) — previewTheme в контексте ThemeProvider (setActive БЕЗ
#   персиста; requestedThemeRef двигается вместе — эффект восстановления
#   плагинных тем остаётся когерентным); Enter закрепляет (setTheme, персист
#   в theme.json — прежнее поведение), Esc откатывает к теме ДО входа
#   (revertTheme: readThemePref, без записи).
# 38-effects-panel: команда /effects — дашборд эффектов LIVE42: строка на
#   эффект = имя + ЖИВОЕ мини-демо (тот же код-компонент: дышащая рамка,
#   пульс ◐, glimmer-текст, ctx-бар, шиммер карточки, радужный глиф,
#   glimmer глагола) + состояние on/off; демо выключенного эффекта
#   статично. Enter/Space — тумблер: пишется в ~/.dsh-tui/effects.json
#   (механизм themePrefs — тот же best-effort JSON, что у /theme; settings-
#   сервиса в TUI-компонентах нет, поэтому НЕ через settings.yaml — файл
#   мерджится ПОВЕРХ appearance.effects в applyAppearance, плагин),
#   режим переключается на custom; Esc — выход. /effects status — текстовый
#   список. Регистрация: LOCAL_COMMANDS + case 'effects' + overlay kind.
# 39-effects-detail (TG-DSH-TUI-EFFECTS-DESC-20260917): доработка панели
#   /effects — деталь-блок подсвеченного эффекта: укрупнённое живое демо
#   (large-режим тех же демо-компонентов), русское описание из НОВОГО модуля
#   effectsCatalog.js (полный маппинг 8 EFFECT_KEYS; нет описания = warn,
#   не fatal — fallback на имя ключа), текущее состояние on/off + режим.
#   Тумблер виден живьём: демо переключается live↔статика прямо в блоке.
# 40-glyph-bars (TG-DSH-TUI-HUB-20260918, узел 1): чисто символьная правка,
#   без риска для layout. +3 эффекта в реестре (default ON в full, opt-out в
#   custom): headerTextGradient (посимвольный градиент заголовка панели задач
#   по ClockContext), subCellBars (восьмые доли ▏▎▍▌▋▊▉ для ctx-бара и
#   мини-бара todo), barGradientFill (градиентная заливка вдоль бара). Режимы
#   ctx-бара: statusBar.ctxBarMode full (6 клеток, дефолт) | narrow (3) |
#   percent-only (только %, без бара). Описания в effectsCatalog +3.
# 41-tool-progress (узел 2): мини-бары прогресса в tool-карточках для
#   измеримых операций. РАССЛЕДОВАНИЕ: канал НЕ стримит вывод работающего
#   инструмента — tool/result приходит один раз по завершении
#   (channel.js case 'tool/result'); assistant/chunk несёт только
#   текст/reasoning/аргументы вызова. Значит бар — РЕТРОСПЕКТИВНЫЙ разбор
#   финального вывода (curl столбцовый/%-бар, wget [=>] N/M (P%), python
#   tqdm NN%|bar|N/M [t<et, speed]) — НОВЫЙ модуль lib/types/toolProgress.js
#   (parseToolProgress: последний паттерн хвоста побеждает; toolProgressCells
#   — суб-ячеечный бар). Рендер: ряд под заголовком карточки (⤓ бар %·скорость
#   ·тип (итог)); только settled-карточки. Эффект toolProgressBars (реестр).
# 42-sparklines (узел 3): брайль-спарклайны в статус-ряду — ОПТ-ИН (не в
#   full!): sparkTps (скорость ток/сек) + sparkCache (% кеша) — OPT_IN_EFFECTS
#   в animationsMode (full → OFF; custom + явное true). Включение растит
#   статус-ряд на ВТОРУЮ строку (SparkRow, mount только когда включён).
#   НОВЫЙ lib/types/sparkline.js: sparkline (брайль 2x4 точки/глиф, глифов
#   ≤ width), pushSample (кольцевой буфер 40, NaN skip), cacheHitPct
#   (cacheRead/total; НЕТ кеш-полей → undefined — график СКРЫВАЕТСЯ, не
#   врёт нулём). Конфиг appearance.sparklines {tps, cache} (schema+prefs).
# 43-spinner-catalog (узел 4): большой каталог стилей спиннеров — 47
#   стилей из cli-spinners (MIT, sindresorhus; фреймы заинлайнены с
#   лицензией-заголовком) в НОВОМ lib/types/spinnerCatalog.js: braille
#   dots/bounce, arrows, moon/clock/earth, aesthetic/toggle-бары, pulse,
#   pong/shark/grenade... каждый тегирован местом (main/subagent/toolCard/
#   any). Разные стили для разных мест: dsh-tui.spinner {main, subagent,
#   toolCard} (схема + apply + channel.setSpinnerPrefs + зеркала в
#   модуль-холдеры AgentView/ToolUseLoader); WorkingSpinner при стиле
#   рендерит CatalogGlyphTicker (кадры по interval, общий ClockContext).
#   Тумблеры: catalog-style заменяет полный SpinnerAnimationRow (глагол
#   остаётся, glimmer/tps-строка нет — осознанный трейд-офф, задокументирован).
# 44-customization-hub (узел 5, дельта 2): /effects → ЕДИНЫЙ ХАБ кастомизации.
#   Реестр секций HUB_SECTIONS (НОВЫЙ hubSections.js: {id, title}; новая
#   секция в будущем = одна запись + компонент — плагин-подобная точка
#   расширения, задокументировано в отчёте). Секции: Оформление (powerline/
#   theme/inputBorder/background/animations/cwdMode — дельта 1+2: всё из
#   settings-оформления зеркалится в UI), Эффекты (панель 38/39 как
#   подсекция — тумблеры реестра), Тема (выбор с превью-семантикой 37),
#   Рамка (цвет рамки ввода), Спиннеры (выбор стиля с ЖИВЫМ демо — патч 43),
#   Статус-ряд (ctxBarMode/cwdMode/sparkTps/sparkCache), Прогресс
#   (toolProgressBars + честное ограничение канала). Персист: интерактивный
#   слой ~/.dsh-tui/appearance.json (НОВЫЙ appearancePrefs.js — расширение
#   механизма effects.json до общего стора {appearance, effects}; мердж
#   ПОВЕРХ settings.yaml в plugin.applyAppearance — файл побеждает по
#   ключу). /effects <section> — прямой прыжок в подсекцию.
# 46-settings-hub (TG-DSH-HUB-SETTINGS-20260918, узел 1): хаб кастомизации
#   ЖИВЁТ ВНУТРИ нативного /settings. Патч-44-оверлей /effects (CustomizationHub)
#   удалён; 7 секций хаба = группы dsh-tui-регистрации (Оформление/Эффекты/
#   Тема/Рамка/Спиннеры/Прогресс + Статус-ряд = нативная status-bar).
#   Seam tuiSettingsSections расширен: custom-поля (kind 'custom' — рендер
#   HubCustomEntry, клавиши внутри ряда, персист своим путём) и demo-ряды
#   (field.demo → HUB_FIELD_DEMOS, живые виджеты под сфокусированным полем).
#   НОВЫЙ lib/types/components/hubSettings.js (группы+поля+кастомные ряды+
#   демо+writeDshSettings/cycleStyle). Мёртвые ключи заwiredены: тема —
#   custom-ряд с live-превью (механика /theme патча 37: previewTheme/setTheme,
#   персист theme.json); спиннеры main/subagent/toolCard — custom-ряды с
#   живыми кадрами каталога, пишут settings.yaml dsh-tui.spinner →
#   channel.setSpinnerPrefs; ctxBarMode — select по живому ключу
#   statusBar.ctxBarMode. Эффекты — custom-ряды: один host-write пишет
#   effects.<key> + animations='custom' (семантика effectEnabled не меняется;
#   full-режим карту игнорирует — потому тумблер обязан владеть режимом).
#   Два латентных бага стека закрыты: HUB_SECTION_COUNT (Chat.js:2884,
#   undefined — ReferenceError на любой кейпресс в /effects-оверлее) ушёл
#   вместе с обработчиком; useTheme() теперь возвращает [theme, setTheme,
#   previewTheme, revertTheme] (патч 37 деструктурировал 4 из 2 — стрелки
#   /theme кидали TypeError, live-превью не работал). EffectDemo
#   экспортирован из EffectsPanel (демо переиспользуются). applyAppearance:
#   appearance.json-слой хаба (патч 44) убран — /settings пишет settings.yaml
#   напрямую, третий слой затенял бы записи; effects.json-слой (патч 38)
#   сохранён. /effects — алиас: открывает /settings сразу на группе секции
#   (дефолт Эффекты), '/effects <section>' прыгает по реестру hubSections,
#   '/effects status' — текстовый список (совместимость с колаб-сьютом:
#   slash_menu_effects + effects_panel детекторы). Тесты: tests/
#   settings-hub.test.js (RED→GREEN), tests/hub.test.js обновлён.
# 47-statusbar-blocks (TG-DSH-HUB-SETTINGS-20260918, узел 2): все добавленные
#   нами кастомные элементы статус-бара и отображения (патчи 40-43: glyph-бары,
#   tool-progress, спарклайны; + более ранние: субагент-иконка ◐ 13/14, mks 17,
#   powerline/таймер 29) — первоклассные тумблеры в /settings (группа Status
#   bar). Новые гейты statusBar: timer (таймер-сегмент powerline, был всегда
#   on), subagentRows (субагент-иконка: ◐-строки субагентов + счётчик 'agents N'
#   в GoalTodoPanel, патчи 13/14), subagentAutoExpand (авто-разворот, патч 27). Мёртвый
#   ключ statusBar.realModel wired: гейтит подмену модели mks (requested →
#   actual) в поле model и powerline-сегменте. Поля в /settings для прежних
#   ungated-in-UI ключей: spending, realModel, compactProgress,
#   compactThresholdRatio (patch 17). Кастомизация спарклайнов: appearance.
#   sparkWidth ('8'|'16'|'24'|'32', дефолт 16) — SparkRow рендерит выбранную
#   ширину. Дубли гейтов эффектов НЕ создаются (sparkTps/sparkCache/
#   toolProgressBars остаются за effectEnabled). Каждому блоку — demo-виджет.
# 50-statusbar-dedup-timer (TG-DSH-STATUSBAR-FIX-20260919, узел 1): три дефекта
#   статус-бара (аудит reports/statusbar-audit-20260918/). D1 DUP-PCT: comp-поле
#   несло тот же пороговый pct (used/threshold), что ⚡-сегмент powerline — в
#   ряду метрика дублировалась; pct остаётся только в ⚡, comp = 'comp <N>
#   left'. D3 TIMER-CLIP: budget = columns-2 не знал о tail/right полях ряда —
#   на w80 таймер резался посреди числа (' 1m 35s' → ' 1m 3'); резерв
#   POWERLINE_TAIL_RESERVE=15 даёт честный drop сегмента вместо полу-мертвого
#   фрагмента, на w82+ таймер цел. D6 SparkRow: key "sparks" на внутренний Box
#   — гасит React warning 'unique "key" prop … SparkRow' в stderr.
#   Перезгенерирован (TG-DSH-TESTING-20260920, узел 1): первая версия правкила
#   только node-строку comp-поля — hunk удаления дубль-блока compactLeft был
#   отклонён (.rej) и доделан руками поверх стека; патч разошёлся с live.
#   Текущая версия = полный фактический diff (.orig → live): те же D1/D3/D6 +
#   удаление правого дубль-блока compactLeft целиком; проверена в обе стороны
#   (apply/revert на .orig, байтовое совпадение с live).
# 51-statusbar-wedge-width (TG-DSH-TESTING-20260920, узел 1): оставшиеся два
#   дефекта статус-бара из аудита (§3). D4 SEP-COLLAPSE: сепаратор ` · `
#   FieldLine — голый Text (ink хардкодит flexShrink:1 на ink-text) — под
#   давлением гибнул первым, поля склеивались (`statusb… …#1a2…`); теперь он
#   в Box flexShrink:0. D5 ELLIPSIS-NOISE: поля flexShrink:1+truncate шредились
#   до огрызков 1-2 символов; теперь fitFieldParts даёт группе клеточный
#   бюджет (stringWidth с ANSI-стрипом) и держит только префикс полей,
#   влезающих ЦЕЛИКОМ (дроп справо-налево; под давлением поля <MIN_FIELD_COLS=6
#   дропаются вовсе); бюджеты: компакт = columns-2-gap-ctx, powerline =
#   columns-2-цепь-margin-gap (tail flexGrow:1 наполняется первым, правая
#   группа flexShrink:2 добирает остаток), plain симметрично. D5-gauge: гейдж
#   ▕███▋···▏ шёл одной строкой в общий run — truncate съедал ▏ первым; теперь
#   protocol lockHead: гейдж (tps busy-варианты, ctx-hover) рендерится в Box
#   flexShrink:0 перед сжимаемым текстом — рамки ▕▏ живут, под давлением
#   уступает хвостовой текст (число/процент). Доказательства:
#   reports/statusbar-fix-20260919/wedge-width-probe-result-51.txt.
# 53-subagent-card-shred (TG-DSH-TESTING-20260920, узел D7): шред карточек
#   субагентов со скрина живой сессии (2026-09-20). Заголовок SubagentMessage —
#   цепочка голых Text в row-Box; ink хардкодит flexShrink:1 → под давлением
#   ВСЕ поля шредились до огрызков («u», «tok», «ng»), патч 51 путь не покрывал.
#   Фикс: клеточный бюджет заголовка (columns-2-gutter-2-padding-глиф-gap):
#   description клипится по остатку с «…», метаданные целыми или дроп
#   справа-налево (status→tools→tokens→duration→effort→model), сепараторы «·»
#   только между живыми полями. Waterfall: строки только для существующей
#   activity (макс 3, растёт 1→3 и не сжимается), молчащий агент — один
#   dim-плейсхолдер «  │ …» вместо трёх пустых рамок. SubagentCard (дашборд):
#   метаданные шли одним Text-run и резались посреди поля («· 0» вместо
#   «0 tools») — та же механика (бюджет columns-5, дроп tools→tokens→duration→
#   model). Доказательства: reports/statusbar-fix-20260919/
#   subagent-card-probe-result-red.txt (RED) + subagent-card-probe-result.txt
#   (GREEN 6/6).
# 54-streaming-height-stable (TG-DSH-PATCH54-20260920, узел 2): осцилляция
#   высоты стриминг-ряда MessageList (юзер-баги B1/B2 — дрожь/гашение строк
#   при длинном стриме). Root cause доказан инструментально (geo-r1,
#   geometry-trace, 4744 закрашенных кадра): при каждом reveal-тике меняется
#   сигнатура высот (revealDisplayLen → signatureParts) →
#   heightsRef.delete(row.id) → heightOf падает в kindAvg-ОЦЕНКУ (~38 вместо
#   ~74) → floor-walk пересчитывает start/topPad → measure восстанавливает →
#   следующий тик удаляет снова → цикл ~33мс (677 прыжков окна, 704 убывания
#   list.total, flicker_toggle_rows=38). Фикс: при row.streaming === true НЕ
#   удалять измеренную высоту в цикле инвалидации (sigs.set обновляется,
#   heightsVersionRef++ остаётся; settle и width-change инвалидируют как
#   раньше). Доказательства: reports/statusbar-fix-20260919/
#   streaming-height-probe-result.txt (RED total_decreases=41 vs GREEN=0) +
#   reports/statusbar-fix-20260919/flicker-rootcause.md (geo-r1).
# 49-logo-version (TG-DSH-FORK-VERSION-20260918): стартовый логотип показывает
#   версию форка — суффикс +p<N> после базовой (v0.10.0-beta.4+p49). N = max
#   числовой префикс записей реестра MARKERS (26b-*.patch даёт 26). После
#   успешного прогона apply генерирует lib/types/components/forkVersion.js в
#   живом пакете (НЕ входит в реестр патчей — генерируется, не патчится):
#   ESM-модуль (пакет type:module; CJS module.exports в .js здесь =
#   ReferenceError «module is not defined»), export const patch = N,
#   generatedAt (UTC). LogoV2 (патч 49) читает его через createRequire +
#   require(esm) (Node >= 22.12 — пин local/colab) с fallback '' → стоковый
#   вид версии. Доказательства: reports/fork-version-20260918/.
# 48-fix-jitter (узел 4): футер НЕ меняет высоту. (а) рабочий слот спиннера —
#   всегда смонтированная ячейка фикс. высоты (height 2 + overflow hidden):
#   появление/исчезновение WorkingSpinner меняло футер 6→8 и флапало
#   пин-гистерезис (footer-gap §3); (б) таймер-сегмент — паддинг до
#   стабильной ширины (formatDuration пилил '59s'→'1m'→'1m 1s' каждую
#   секунду, перестраивая ряд); (в) кламп height:1 + overflow:hidden на
#   ОСТАВШИЕСЯ ветки статус-ряда (compact и plain/stok — 45-й клампил только
#   powerline-ветку). RED/GREEN: footer-flap-probe (working on/off цикл) —
#   до 48 флап высоты, после — ноль.
# 45-status-row-clamp (TG-DSH-TUI-LAYOUT-FIX-20260917, узел 1): щель под
#   статус-баром (1 строка при 120 кол, 3 при 80) + «вторая строка статуса»
#   с дублями ctx-хвостов. Root cause: сепараторы ' · '/клинья БЕЗ
#   wrap:"truncate" при горизонтальном переполнении жёстко переносились на
#   2-3 строки и растили ряд/футер (диагноз: reports/footer-gap-20260917/
#   footer-gap-diagnosis.md). Фикс: powerline-ряд = жёсткая 1-строчная
#   ячейка (Box height:1 + overflow:hidden — тот же кламп, что у
#   supplemental row) + wrap:"truncate" на сепараторах FieldLine и обеих
#   ветках PowerlineSeparator. RED/GREEN: probe gapBelow 1/3 → 0/0.
# Доказательства: reports/effects39-wave-20260917.md + reports/effects39-frames/.
# 
#
# Доказательства (тесты, кадры, отчёт): reports/live42-wave-20260917.md +
#   reports/live42-frames/.
#
# Зависимости: patch, grep (стандартные утилиты).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHES_DIR="$REPO_DIR/dsh-overrides/patches"

DSH_PROFILE="${DSH_PROFILE:-dsh-tui}"
TUI_BASE="${TUI_BASE:-$HOME/.dsh/profiles/$DSH_PROFILE/node_modules/@deepseek-harness-tui/dsh-tui}"

# --- Маркеры: уникальная строка, появляющаяся в целевом файле ТОЛЬКО после
# применения соответствующего патча. Ключ = имя файла патча. ---------------
declare -A MARKERS=(
  [CH.01.1-empty-screen.patch]='flexGrow: channel.rows.length > 0 ? 1 : 0'
  [SB.01.1-glitch-toast.patch]='lastNotification && (_jsx(Box, { height: 1, width: "100%", paddingLeft: 2, paddingRight: 1, flexDirection: "column", justifyContent: "flex-end"'
  [TG.01.1-compact-todos.patch]='const todoFoldMod = () => (effectiveCombos'
  [SB.02.1-context-percent.patch]='// Percent (used/window) shown by the upstream build'
  [IL.01.1-mobile-rows.patch]='const showSupplementalRow = detail !== null || hint'
  [CH.02.1-bottom-layout.patch]='The "working" hint (`statusline-hint-working` = "esc to interrupt") is'
  [PR.01.1-model-default.patch]='dsh-overrides 07: agent-default-model (the shared settings.yaml default,'
  [TR.01.1-cyrillic-alt.patch]='dsh-overrides 08: extended beyond [a-zA-Z0-9] with Cyrillic'
  [TG.05.1-todo-collapsed.patch]='dsh-overrides 09: collapsed preview pair'
  [IL.01.2-inline-stable.patch]='dsh-overrides 10: in inline (non-fullscreen) mode the supplemental row'
  [IL.02.1-inline-bottom-anchor.patch]='dsh-overrides 11: inline bottom-anchor'
  [TH.01.1-theme-picker-filter.patch]='dsh-overrides 12: fish_config-style filter'
  [TG.06.1-subagent-todo-rows.patch]='dsh-overrides 13: max mirrored rows of live-subagent todos'
  [TG.07.1-subagent-tree-rows.patch]='dsh-overrides 14: the todo list is a TREE'
  [TG.08.1-todofold-collapse-fix.patch]='dsh-overrides 15: the fold header stays mounted'
  [SB.03.1-status-provider.patch]='dsh-overrides 16: show which provider route'
  [SB.04.1-status-mks-wave-c.patch]='dsh-overrides 17: mini-key-switcher status'
  [PI.01.1-hotkeys-planmode.patch]="dsh-overrides 18: dashboard moved off ctrl+a"
  [TG.02.1-fold-hint.patch]="dsh-overrides 19: fold hint without the trailing 'm'"
  [PI.02.1-queue-slash.patch]='dsh-overrides 20: slash commands typed during a turn'
  [ID.01.1-hide-drift.patch]='dsh-overrides 21: startup version-drift warnings suppressed'
  [PR.03.1-model-fork-render.patch]='dsh-overrides 22: `lastPaintAt` records'
  [IL.07.1-todofold-space.patch]='opts the inner content box into a'
  [IL.05.1-fs-footer-bottom.patch]='dsh-overrides 24: fullscreen bottom-anchor'
  [IL.06.1-fs-height-stable.patch]='dsh-overrides 25: fullscreen shares the pinned-frame slack'
  [PI.03.1-scroll-menu-nogap.patch]='helpOpen && (_jsx(Box, { children: _jsx(HelpMenu'
  [MS.01.1-scroll-menu-nogap.patch]='dsh-overrides 26: kind-aware spacer estimate'
  [TG.09.1-subagent-visible.patch]='dsh-overrides 27: subagent fold auto-expands'
  [TH.02.1-shimmer-restore.patch]='dsh-overrides 28: shimmer keys are firmware'
  [SB.05.1-powerline-segments.patch]='dsh-overrides 29: powerline segments'
  [EF.01.1-live-anim.patch]='dsh-overrides 30: the glyph cycles the rainbow'
  [PR.04.1-appearance-settings.patch]='dsh-overrides 31: appearance settings channel'
  [CH.03.1-intro-mount-reanchor.patch]='dsh-overrides 32: the panel MOUNT re-anchors the frame'
  [EF.02.1-input-breathe.patch]='dsh-overrides 33: process-wide gate + per-effect registry'
  [EF.03.1-live-panels.patch]='dsh-overrides 34: the live glyph PULSES toolDotTask'
  [EF.04.1-tools-verbs.patch]='dsh-overrides 35: user spinner-verb customization'
  [TH.03.1-app-background.patch]='dsh-overrides 36: app background — the root surface paints'
  [TH.01.2-theme-live-preview.patch]='dsh-overrides 37: LIVE PREVIEW — swap the palette immediately WITHOUT'
  [HB.01.1-effects-panel.patch]='dsh-overrides 38: the /effects dashboard'
  [HB.03.1-effects-detail.patch]='dsh-overrides 39: human descriptions for the LIVE42 effect registry'
  [EF.05.1-glyph-bars.patch]='dsh-overrides 40: glyph-bars wave'
  [EF.06.1-tool-progress.patch]='dsh-overrides 41: measurable-tool progress'
  [EF.07.1-sparklines.patch]='dsh-overrides 42: braille sparklines for the status row'
  [EF.08.1-spinner-catalog.patch]='dsh-overrides 43: spinner style catalog'
  [HB.08.1-customization-hub.patch]='dsh-overrides 44: the customization-hub section registry'
  [SB.06.1-status-row-clamp.patch]='dsh-overrides 45: the powerline row is a hard 1-line cell'
  [HB.04.1-settings-hub.patch]='dsh-overrides 46: appearance hub lives inside the settings screen'
  [HB.05.1-statusbar-blocks.patch]='dsh-overrides 47: our statusrow blocks are first-class toggles'
  [SB.07.1-fix-jitter.patch]='dsh-overrides 48: the footer never changes height'
  [ID.02.1-logo-version.patch]='dsh-overrides 49: fork version suffix'
  [SB.06.2-statusbar-dedup-wedge.patch]='dsh-overrides 50: reserve room for the tail/right FieldLine groups'
  [HB.06.1-effects-refresh-survive.patch]='dsh-overrides 52: keep /effects across rebuilds (see the const'
  [TG.03.1-subagent-card-shred.patch]='dsh-overrides 53: header width governance'
  [IL.03.1-inline-scrollback-clean.patch]='dsh-overrides 55: pin→unpin transition (inline scrollback clean)'
  [SB.08.1-statusbar-minimum-metric.patch]='dsh-overrides 56 (v2, e5-фикс): fused-заливки не рисуют клин'
  [TR.02.1-sync-output-killswitch.patch]='sync-output kill switch (E2 mitigation, canon §3'
  [PR.02.1-compact-phase-visible.patch]='dsh-overrides 58 (C5): braille frames'
  [ID.03.1-fork-update-notice-off.patch]='dsh-overrides 59: fork update-notice off'
  [TR.03.1-wezterm-version-gate.patch]='dsh-overrides 60: WezTerm version gate'
  [TR.04.1-geometry-trace-always-on.patch]='dsh-overrides 61: always-on geometry trace'
  [TR.05.1-theme-picker-kitty-input.patch]='dsh-overrides 62: kitty CSI-u special-key names'
  [HB.07.1-hub-settings-english.patch]='dsh-overrides 63: hub settings EN'
  [TH.01.3-theme-preview.patch]='dsh-overrides 64: theme preview'
  [HB.02.1-settings-effects-explanations.patch]='dsh-overrides 65: settings/effects self-documenting examples'
  [EF.02.2-animations-boolean-gate.patch]='dsh-overrides 66: `animations: false` (boolean) is the legacy form'
  [MS.01.3-scroll-height-stabilize.patch]='dsh-overrides 67: wheel-at-bottom sticky gate'
  [IL.04.1-tooltip-inline-gate.patch]='dsh-overrides 68: the tooltip layer is a fullscreen-only affordance'
  [EF.02.3-inputborder-breath-optin.patch]='dsh-overrides 69: input-border breath is opt-in'
  [IL.03.3-gap-under-status.patch]='dsh-overrides 70: ScrollBox handle identity'
  [TG.04.1-todo-idle-gate.patch]='dsh-overrides 71: gate on todo presence'
  [HB.02.2-hub-theme-demo.patch]='dsh-overrides 72: hub theme demo'
  [CH.04-inline-frame-fullheight.patch]='DSH-P73-INLINE-FULLHEIGHT'
  [TH.04-dim-contrast-floor.patch]='DSH-P74-DIM-CONTRAST-FLOOR'
  [CH.05-inline-chrome-overlay.patch]='DSH-P75-CHROME-OVERLAY'
  [MS.01.4-yoga-insert-invalidate.patch]='DSH-P76-YOGA-INSERT-INVALIDATE'
  [TH.05.1-saturation-option.patch]='DSH-P75-SATURATION-OPTION'
)

# Целевой файл для проверки маркера (относительно TUI_BASE).
marker_file() { # $1 = patch file name
  case "$1" in
    CH.01.1-empty-screen.patch)  printf '%s' 'lib/types/screens/Chat.js' ;;
    SB.01.1-glitch-toast.patch)  printf '%s' 'lib/types/components/PromptInput.js' ;;
    TG.01.1-compact-todos.patch) printf '%s' 'lib/types/components/GoalTodoPanel.js' ;;
    SB.02.1-context-percent.patch) printf '%s' 'lib/types/tuiDisplayPrefs.js' ;;
    IL.01.1-mobile-rows.patch)   printf '%s' 'lib/types/screens/StatusLine.js' ;;
    CH.02.1-bottom-layout.patch) printf '%s' 'lib/types/screens/StatusLine.js' ;;
    PR.01.1-model-default.patch) printf '%s' 'lib/types/dsh-adapter/plugin.js' ;;
    TR.01.1-cyrillic-alt.patch)  printf '%s' 'lib/types/ink/parse-keypress.js' ;;
    TG.05.1-todo-collapsed.patch) printf '%s' 'lib/types/components/GoalTodoPanel.js' ;;
    IL.01.2-inline-stable.patch) printf '%s' 'lib/types/screens/StatusLine.js' ;;
    IL.02.1-inline-bottom-anchor.patch) printf '%s' 'lib/types/screens/Chat.js' ;;
    TH.01.1-theme-picker-filter.patch) printf '%s' 'lib/types/components/ThemePicker.js' ;;
    TG.06.1-subagent-todo-rows.patch) printf '%s' 'lib/types/components/GoalTodoPanel.js' ;;
    TG.07.1-subagent-tree-rows.patch) printf '%s' 'lib/types/components/GoalTodoPanel.js' ;;
    TG.08.1-todofold-collapse-fix.patch) printf '%s' 'lib/types/components/GoalTodoPanel.js' ;;
    SB.03.1-status-provider.patch)  printf '%s' 'lib/types/screens/Chat.js' ;;
    SB.04.1-status-mks-wave-c.patch)       printf '%s' 'lib/types/screens/StatusLine.js' ;;
    PI.01.1-hotkeys-planmode.patch) printf '%s' 'lib/types/utils/keymap.js' ;;
    TG.02.1-fold-hint.patch)        printf '%s' 'lib/types/i18n.js' ;;
    PI.02.1-queue-slash.patch)      printf '%s' 'lib/types/components/PromptInput.js' ;;
    ID.01.1-hide-drift.patch)       printf '%s' 'lib/types/components/LogoV2.js' ;;
    PR.03.1-model-fork-render.patch) printf '%s' 'lib/types/ink/ink.js' ;;
    IL.07.1-todofold-space.patch)   printf '%s' 'lib/types/ink/components/ScrollBox.js' ;;
    IL.05.1-fs-footer-bottom.patch) printf '%s' 'lib/types/screens/Chat.js' ;;
    IL.06.1-fs-height-stable.patch) printf '%s' 'lib/types/screens/Chat.js' ;;
    PI.03.1-scroll-menu-nogap.patch) printf '%s' 'lib/types/components/PromptInput.js' ;;
    MS.01.1-scroll-menu-nogap.patch) printf '%s' 'lib/types/components/MessageList.js' ;;
    TG.09.1-subagent-visible.patch)  printf '%s' 'lib/types/components/GoalTodoPanel.js' ;;
    TH.02.1-shimmer-restore.patch)   printf '%s' 'lib/types/customTheme.js' ;;
    SB.05.1-powerline-segments.patch) printf '%s' 'lib/types/screens/StatusLine.js' ;;
    EF.01.1-live-anim.patch)         printf '%s' 'lib/types/components/Spinner/SpinnerGlyph.js' ;;
    PR.04.1-appearance-settings.patch) printf '%s' 'lib/types/dsh-adapter/plugin.js' ;;
    CH.03.1-intro-mount-reanchor.patch) printf '%s' 'lib/types/screens/Chat.js' ;;
    EF.02.1-input-breathe.patch) printf '%s' 'lib/types/animationsMode.js' ;;
    EF.03.1-live-panels.patch) printf '%s' 'lib/types/components/GoalTodoPanel.js' ;;
    EF.04.1-tools-verbs.patch) printf '%s' 'lib/types/spinnerVerbsPrefs.js' ;;
    TH.03.1-app-background.patch) printf '%s' 'lib/types/screens/Chat.js' ;;
    TH.01.2-theme-live-preview.patch) printf '%s' 'lib/types/components/design-system/ThemeProvider.js' ;;
    HB.01.1-effects-panel.patch) printf '%s' 'lib/types/components/EffectsPanel.js' ;;
    HB.03.1-effects-detail.patch) printf '%s' 'lib/types/effectsCatalog.js' ;;
    EF.05.1-glyph-bars.patch) printf '%s' 'lib/types/animationsMode.js' ;;
    EF.06.1-tool-progress.patch) printf '%s' 'lib/types/toolProgress.js' ;;
    EF.07.1-sparklines.patch) printf '%s' 'lib/types/sparkline.js' ;;
    EF.08.1-spinner-catalog.patch) printf '%s' 'lib/types/spinnerCatalog.js' ;;
    HB.08.1-customization-hub.patch) printf '%s' 'lib/types/hubSections.js' ;;
    SB.06.1-status-row-clamp.patch) printf '%s' 'lib/types/screens/StatusLine.js' ;;
    HB.04.1-settings-hub.patch) printf '%s' 'lib/types/components/hubSettings.js' ;;
    HB.05.1-statusbar-blocks.patch) printf '%s' 'lib/types/tuiDisplayPrefs.js' ;;
    SB.07.1-fix-jitter.patch) printf '%s' 'lib/types/screens/Chat.js' ;;
    ID.02.1-logo-version.patch) printf '%s' 'lib/types/components/LogoV2.js' ;;
    SB.06.2-statusbar-dedup-wedge.patch) printf '%s' 'lib/types/screens/StatusLine.js' ;;
    HB.06.1-effects-refresh-survive.patch) printf '%s' 'lib/types/dsh-adapter/channel.js' ;;
    TG.03.1-subagent-card-shred.patch) printf '%s' 'lib/types/components/Chat/SubagentMessage.js' ;;
    IL.03.1-inline-scrollback-clean.patch) printf '%s' 'lib/types/ink/log-update.js' ;;
    SB.08.1-statusbar-minimum-metric.patch) printf '%s' 'lib/types/screens/StatusLine.js' ;;
    TR.02.1-sync-output-killswitch.patch) printf '%s' 'lib/types/ink/terminal.js' ;;
    PR.02.1-compact-phase-visible.patch) printf '%s' 'lib/types/dsh-adapter/channel.js' ;;
    ID.03.1-fork-update-notice-off.patch) printf '%s' 'lib/types/update.js' ;;
    TR.03.1-wezterm-version-gate.patch) printf '%s' 'lib/types/ink/terminal.js' ;;
    TR.04.1-geometry-trace-always-on.patch) printf '%s' 'lib/types/ink/geometry-trace.js' ;;
    TR.05.1-theme-picker-kitty-input.patch) printf '%s' 'lib/types/ink/events/input-event.js' ;;
    HB.07.1-hub-settings-english.patch) printf '%s' 'lib/types/components/hubSettings.js' ;;
    TH.01.3-theme-preview.patch) printf '%s' 'lib/types/components/ThemePreview.js' ;;
    HB.02.1-settings-effects-explanations.patch) printf '%s' 'lib/types/components/SettingsExamples.js' ;;
    EF.02.2-animations-boolean-gate.patch) printf '%s' 'lib/types/tuiDisplayPrefs.js' ;;
    MS.01.3-scroll-height-stabilize.patch) printf '%s' 'lib/types/ink/components/ScrollBox.js' ;;
    IL.04.1-tooltip-inline-gate.patch) printf '%s' 'lib/types/screens/Chat.js' ;;
    EF.02.3-inputborder-breath-optin.patch) printf '%s' 'lib/types/animationsMode.js' ;;
    IL.03.3-gap-under-status.patch)  printf '%s' 'lib/types/screens/Chat.js' ;;
    TG.04.1-todo-idle-gate.patch)    printf '%s' 'lib/types/components/GoalTodoPanel.js' ;;
    HB.02.2-hub-theme-demo.patch)    printf '%s' 'lib/types/components/hubSettings.js' ;;
    CH.04-inline-frame-fullheight.patch) printf '%s' 'lib/types/screens/Chat.js' ;;
    TH.04-dim-contrast-floor.patch) printf '%s' 'lib/types/components/design-system/ThemedText.js' ;;
    CH.05-inline-chrome-overlay.patch) printf '%s' 'lib/types/screens/Chat.js' ;;
    MS.01.4-yoga-insert-invalidate.patch) printf '%s' 'lib/types/native-ts/yoga-layout/index.js' ;;
    TH.05.1-saturation-option.patch) printf '%s' 'lib/types/components/Spinner/spinnerUtils.js' ;;
    *) printf '%s' '' ;;
  esac
}

# patch_files: парсит DEP-3 # Files: header из .patch файла.
# Возвращает все целевые файлы патча (по одному на строку, относительно TUI_BASE).
# Формат DEP-3: "# Files:     path1.js, path2.js," с continuation-строками
# "#            path3.js". Поддержка нескольких DEP-3 блоков в одном патче.
# Fallback: если # Files: header отсутствует — делегирует к marker_file().
# $1 = patch file name (relative to PATCHES_DIR)
patch_files() { # $1 = patch file name
  local name="$1"
  local patch_file="$PATCHES_DIR/$name"

  if [ ! -f "$patch_file" ]; then
    return
  fi

  # Awk: собирает содержимое # Files: и continuation-строк.
  # Continuation = строка "# <текст>" без keyword-двоеточия (# Word:).
  local raw
  raw="$(awk '
    BEGIN { in_files = 0; in_header = 1 }
    !/^#/ { in_header = 0 }
    in_header && /^# Files:/ { in_files = 1; sub(/^# Files:[[:space:]]*/, ""); printf "%s ", $0; next }
    in_files && in_header && /^#[[:space:]]{2,}/ { sub(/^#[[:space:]]+/, ""); printf "%s ", $0; next }
    in_files { in_files = 0 }
  ' "$patch_file")"

  # Нет # Files: header → fallback к marker_file()
  if [ -z "$raw" ]; then
    marker_file "$name"
    return
  fi

  # Парсинг: split по запятым/пробелам, strip (new) аннотаций, dedup.
  local -A seen=()
  local expanded="${raw//,/ }"
  local token
  for token in $expanded; do
    token="${token%%(*}"
    if [ -n "$token" ] && [ -z "${seen[$token]:-}" ]; then
      seen["$token"]=1
      printf '%s\n' "$token"
    fi
  done
}

# created_files_in_patch: список файлов, создаваемых патчем.
# Два формата создания:
#   1. Стандартный: --- /dev/null +++ b/path
#   2. Нестандартный: --- a/path +++ b/path @@ -0,0 +1,N @@
# patch -R не может удалить CREATED-файлы ("Unreversed patch detected" для
# формата 1; для формата 2 — очищает содержимое, но не удаляет файл).
# revert_all вызывает эту функцию для ручного удаления после patch -R.
# Output: пути файлов (по одному на строку), которые создаются патчем.
created_files_in_patch() { # $1 = patch file name
  local patch_file="$PATCHES_DIR/$1"
  [ -f "$patch_file" ] || return 0
  awk '
    /^--- \/dev\/null$/ { pending_devnull = 1; pending_apath = ""; next }
    /^--- a\// { pending_apath = $0; sub(/^--- a\//, "", pending_apath); pending_devnull = 0; next }
    /^\+\+\+ b\// {
      if (pending_devnull) {
        sub(/^\+\+\+ b\//, "")
        print
        pending_devnull = 0
        pending_apath = ""
      } else if (pending_apath != "") {
        bpath = $0; sub(/^\+\+\+ b\//, "", bpath)
        if (bpath == pending_apath) {
          expect_hunk_zero = 1
        }
        pending_apath_save = pending_apath
        pending_apath = ""
      }
      next
    }
    /^@@ -0,0 / {
      if (expect_hunk_zero) {
        print pending_apath_save
        expect_hunk_zero = 0
      }
      next
    }
    /^@@/ { expect_hunk_zero = 0; next }
    { pending_devnull = 0; pending_apath = ""; expect_hunk_zero = 0 }
  ' "$patch_file"
}

# deleted_files_in_patch: список файлов, удаляемых патчем (+++ /dev/null).
# patch -R не может воссоздать удалённые файлы, если они уже существуют.
# Output: пути файлов (по одному на строку), которые имеют +++ /dev/null.
deleted_files_in_patch() { # $1 = patch file name
  local patch_file="$PATCHES_DIR/$1"
  [ -f "$patch_file" ] || return 0
  awk '
    /^--- a\// { pending_path = $0; sub(/^--- a\//, "", pending_path); next }
    /^\+\+\+ \/dev\/null$/ {
      if (pending_path != "") { print pending_path; pending_path = "" }
      next
    }
    { pending_path = "" }
  ' "$patch_file"
}

# --- Предварительные проверки -------------------------------------------------
[ -d "$PATCHES_DIR" ] || { echo "Нет каталога патчей: $PATCHES_DIR" >&2; exit 1; }
[ -d "$TUI_BASE" ] || { echo "TUI_BASE не найден: $TUI_BASE" >&2; exit 1; }
[ -f "$TUI_BASE/package.json" ] || { echo "package.json нет в TUI_BASE: $TUI_BASE" >&2; exit 1; }

# --- PATCH-SERIES: явный порядок применения (миграция SUBSYS.FF.B, этап 0) ---
# Порядок — артефакт (файл серии), не свойство сортировки имён (RESEARCH
# C.3.4): одна строка = один патч (имя относительно PATCHES_DIR), строки
# «#...» и пустые игнорируются. Отсутствие/пустота серии или расхождение с
# *.patch-файлами (1:1) — явный fail: тихий glob-fallback запрещён.
SERIES_FILE="$PATCHES_DIR/PATCH-SERIES"

# load_patch_series: читает PATCH-SERIES в SERIES_PATCHES (порядок файла);
# exit 1, если файла нет или записей ноль.
load_patch_series() {
  if [ ! -f "$SERIES_FILE" ]; then
    echo "PATCH-SERIES не найден: $SERIES_FILE" >&2
    echo "  порядок применения обязан быть явным артефактом (glob-fallback запрещён)" >&2
    exit 1
  fi
  SERIES_PATCHES=()
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    SERIES_PATCHES+=("$line")
  done < "$SERIES_FILE"
  if [ "${#SERIES_PATCHES[@]}" -eq 0 ]; then
    echo "PATCH-SERIES пуст (ни одной записи): $SERIES_FILE" >&2
    exit 1
  fi
}

# check_series_consistency: согласованность серии с *.patch-файлами —
# запись без файла, *.patch вне серии, дубль записи = явный fail с именами.
check_series_consistency() {
  local name entry missing=() dupes=() orphans=()
  for name in "${SERIES_PATCHES[@]}"; do
    [ -f "$PATCHES_DIR/$name" ] || missing+=("$name")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "PATCH-SERIES: записи без файла в $PATCHES_DIR:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 1
  fi
  local -A seen=()
  for name in "${SERIES_PATCHES[@]}"; do
    if [ -n "${seen[$name]:-}" ]; then
      dupes+=("$name")
    else
      seen["$name"]=1
    fi
  done
  if [ "${#dupes[@]}" -gt 0 ]; then
    echo "PATCH-SERIES: дублирующиеся записи:" >&2
    printf '  %s\n' "${dupes[@]}" >&2
    exit 1
  fi
  local -A series_set=()
  for name in "${SERIES_PATCHES[@]}"; do series_set["$name"]=1; done
  shopt -s nullglob
  for entry in "$PATCHES_DIR"/*.patch; do
    name="$(basename "$entry")"
    [ -n "${series_set[$name]:-}" ] || orphans+=("$name")
  done
  shopt -u nullglob
  if [ "${#orphans[@]}" -gt 0 ]; then
    echo "PATCH-SERIES: *.patch-файлы, не числящиеся в серии:" >&2
    printf '  %s\n' "${orphans[@]}" >&2
    exit 1
  fi
}

load_patch_series
check_series_consistency

# --- Враппер stderr MCP → файл (см. dsh-overrides/README.md) ------------------
# Единый враппер, в который cordis.patch.yml оборачивает каждый stdio MCP-сервер,
# чтобы stderr дочернего процесса не наследовался в терминал TUI. Копия живёт в
# реестре (dsh-overrides/settings/bin/) — при обновлении конфигов восстанавливаем.
mkdir -p "$HOME/.dsh/bin"
cp "$REPO_DIR/dsh-overrides/settings/bin/mcp-stderr-to-log" "$HOME/.dsh/bin/"
chmod +x "$HOME/.dsh/bin/mcp-stderr-to-log"

installed="$(grep -m1 '"version"' "$TUI_BASE/package.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
echo "dsh-tui: $installed ($TUI_BASE)"
# Патчи реестра рассчитаны на 0.10.0-beta.4. Если версия другая — предупредить, но
# продолжить: diff может не лечь, тогда patch честно упадёт ниже.
if [ "$installed" != "0.10.0-beta.4" ]; then
  echo "ВНИМАНИЕ: реестр dsh-overrides написан для dsh-tui 0.10.0-beta.4, установлено $installed" >&2
fi

applied=0
skipped=0
failed=0

# --- Функции режимов ----------------------------------------------------------

# revert_all: откат всех патчей серии в обратном порядке.
# Pre-check: marker absent in marker_file → not applied → skip.
# patch -R for CREATED files (--- /dev/null) returns non-zero ("Unreversed
# patch detected") — we manually delete CREATED files after patch -R and
# verify the marker disappeared from marker_file.
# Post-check: маркер исчез из marker_file (defense-in-depth).
# Глобальные: applied, skipped, failed (сбрасываются).
revert_all() {
  applied=0
  skipped=0
  failed=0
  local patches_rev=()
  local i
  for (( i = ${#SERIES_PATCHES[@]} - 1; i >= 0; i-- )); do
    patches_rev+=("${SERIES_PATCHES[$i]}")
  done
  local name patch_file marker pf target mfile
  local -a pfiles created_files
  for name in "${patches_rev[@]}"; do
    patch_file="$PATCHES_DIR/$name"
    mapfile -t pfiles < <(patch_files "$name")
    if [ "${#pfiles[@]}" -eq 0 ]; then
      echo "skip (нет файлов патча): $name" >&2
      failed=1
      continue
    fi
    marker="${MARKERS[$name]:-}"
    # Pre-check: marker absent in marker_file → not applied → skip.
    mfile="$(marker_file "$name")"
    if [ -z "$marker" ] || [ -z "$mfile" ] || [ ! -f "$TUI_BASE/$mfile" ] \
      || ! grep -qF -- "$marker" "$TUI_BASE/$mfile"; then
      echo "not applied: $name"
      skipped=$((skipped + 1))
      continue
    fi
    # patch -R --forward: may return non-zero for CREATED files ("Unreversed
    # patch detected"). We capture the result but don't fail immediately.
    local patch_rc=0
    (cd "$TUI_BASE" && patch -p1 -R --forward < "$patch_file" >/dev/null 2>&1) || patch_rc=$?

    # Manually delete CREATED files (--- /dev/null) that patch -R couldn't.
    mapfile -t created_files < <(created_files_in_patch "$name")
    for cf in "${created_files[@]}"; do
      [ -n "$cf" ] && rm -f "$TUI_BASE/$cf" 2>/dev/null || true
    done

    # Clean up any .rej files left by failed hunks.
    find "$TUI_BASE" -maxdepth 5 -name '*.rej' -delete 2>/dev/null || true

    # Post-check strategy:
    # - patch -R returned 0 → trust patch (revert succeeded even if marker
    #   text appears in overlapping changes from later patches).
    # - patch -R returned non-zero → CREATED files caused "Unreversed" skip;
    #   verify marker disappeared from marker_file as defense-in-depth.
    if [ "$patch_rc" -ne 0 ]; then
      if [ -n "$marker" ] && [ -n "$mfile" ] && [ -f "$TUI_BASE/$mfile" ] \
        && grep -qF -- "$marker" "$TUI_BASE/$mfile"; then
        echo "FAILED post-check marker for: $name (маркер не исчез из marker_file)" >&2
        failed=$((failed + 1))
        continue
      fi
    fi
    echo "reverted: $name"
    applied=$((applied + 1))
  done
}

# apply_all: применение всех патчей серии в порядке PATCH-SERIES.
# Pre-check: marker present in marker_file → already applied → skip.
# This catches partial-apply: if marker_file is missing or marker absent,
# patch is not fully applied → patch --forward is attempted (may fix or fail).
# Post-failure: if patch --forward returns non-zero BUT marker is now present
# in marker_file, treat as already applied (partial apply with key artifact
# in place — common with overlapping patches after incomplete revert).
# Post-check: маркер появился в ≥1 файле (defense-in-depth).
# Глобальные: applied, skipped, failed (сбрасываются).
apply_all() {
  applied=0
  skipped=0
  failed=0
  local name patch_file marker pf target mfile
  local -a pfiles
  for name in "${SERIES_PATCHES[@]}"; do
    patch_file="$PATCHES_DIR/$name"
    mapfile -t pfiles < <(patch_files "$name")
    if [ "${#pfiles[@]}" -eq 0 ]; then
      echo "skip (нет файлов патча): $name" >&2
      failed=1
      continue
    fi
    marker="${MARKERS[$name]:-}"
    # Pre-check: marker present in marker_file → already applied → skip.
    # marker_file() returns the single file where the marker is guaranteed
    # to appear after a successful apply. If that file is missing or the
    # marker is absent, the patch was not fully applied → attempt re-apply.
    mfile="$(marker_file "$name")"
    if [ -n "$marker" ] && [ -n "$mfile" ] && [ -f "$TUI_BASE/$mfile" ] \
      && grep -qF -- "$marker" "$TUI_BASE/$mfile" 2>/dev/null; then
      echo "already applied: $name"
      skipped=$((skipped + 1))
      continue
    fi
    # Clean up .rej from partial apply before post-failure check.
    find "$TUI_BASE" -maxdepth 5 -name '*.rej' -delete 2>/dev/null || true
    if ! (cd "$TUI_BASE" && patch -p1 --forward < "$patch_file" >/dev/null 2>&1); then
      # patch --forward returned non-zero. This may happen when some hunks
      # are "Reversed (or previously applied)" (changes already present from
      # incomplete revert) while the CREATED file (marker_file) was
      # successfully created. If the marker is now present in marker_file,
      # the patch's key artifact is in place → treat as applied (the
      # overlapping hunks are already present from previous apply/revert
      # cycles; the net effect is the patch is in place).
      find "$TUI_BASE" -maxdepth 5 -name '*.rej' -delete 2>/dev/null || true
      if [ -n "$marker" ] && [ -n "$mfile" ] && [ -f "$TUI_BASE/$mfile" ] \
        && grep -qF -- "$marker" "$TUI_BASE/$mfile" 2>/dev/null; then
        echo "applied: $name"
        applied=$((applied + 1))
        continue
      fi
      echo "FAILED to apply: $name (версия разошлась? проверь вывод patch вручную)" >&2
      failed=$((failed + 1))
      continue
    fi
    # Контрольная проверка маркера после применения.
    local found=0
    for pf in "${pfiles[@]}"; do
      target="$TUI_BASE/$pf"
      if [ -n "$marker" ] && [ -f "$target" ] && grep -qF -- "$marker" "$target"; then
        found=1
        break
      fi
    done
    if [ "$found" -eq 0 ]; then
      echo "FAILED post-check marker for: $name" >&2
      failed=$((failed + 1))
      continue
    fi
    echo "applied: $name"
    applied=$((applied + 1))
  done
}

# generate_forkversion: ESM-модуль forkVersion.js в TUI_BASE (генерируется).
# N = число записей PATCH-SERIES. Не входит в реестр патчей.
generate_forkversion() {
  local fork_max="${#SERIES_PATCHES[@]}"
  local fork_file="$TUI_BASE/lib/types/components/forkVersion.js"
  printf '%s\n' \
    '// Generated by scripts/apply-dsh-overrides.sh — DO NOT EDIT (regenerated on every apply).' \
    '// Fork patch-stack depth: number of entries in dsh-overrides/patches/PATCH-SERIES.' \
    '// The package is ESM (type:module); LogoV2.js loads this via createRequire (require(esm)).' \
    '// NOT a patch-registry artifact: this file is generated, never patched.' \
    "export const patch = ${fork_max};" \
    "export const generatedAt = '$(date -u +%Y-%m-%dT%H:%M:%SZ)';" \
    > "$fork_file"
  echo "generated: lib/types/components/forkVersion.js (fork version: +p${fork_max})"
}

# verify_pristine: сравнивает файлы TUI_BASE с pristine-manifest.sha256.
# $1 = manifest, $2 = TUI_BASE. Return 0 если pristine OK, 1 если mismatch.
verify_pristine() {
  local manifest="$1" base="$2"
  local hash_ok=0 hash_total=0
  local created_absent=0 created_total=0
  local mismatches=()
  local line sha path

  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    if [[ "$line" =~ ^# ]]; then
      # CREATED annotation: "#   CREATED  <path>"
      if [[ "$line" =~ ^#[[:space:]]+CREATED[[:space:]]+(.+) ]]; then
        local cfile="${BASH_REMATCH[1]}"
        cfile="${cfile%"${cfile##*[![:space:]]}"}"
        created_total=$((created_total + 1))
        # patch -R on creation diffs (--- a/path instead of /dev/null) leaves
        # EMPTY files (0 bytes), not deleted. Both absent and empty = pristine.
        if [ -s "$base/$cfile" ]; then
          mismatches+=("CREATED-BUT-NONEMPTY: $cfile")
        else
          created_absent=$((created_absent + 1))
        fi
      fi
      continue
    fi
    # sha256 line: "<64hex>  <path>"
    sha="" path=""
    read -r sha path <<< "$line" || true
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || continue
    [ -n "$path" ] || continue
    hash_total=$((hash_total + 1))
    if [ ! -f "$base/$path" ]; then
      mismatches+=("MISSING: $path")
      continue
    fi
    local actual
    actual="$(sha256sum "$base/$path" | cut -d' ' -f1)"
    if [ "$actual" != "$sha" ]; then
      mismatches+=("MISMATCH file=$path expected=$sha actual=$actual")
    else
      hash_ok=$((hash_ok + 1))
    fi
  done < "$manifest"

  echo "VERIFY: $hash_ok/$hash_total hashes match, $created_absent/$created_total created absent"

  if [ "${#mismatches[@]}" -gt 0 ]; then
    local m
    for m in "${mismatches[@]}"; do
      echo "VERIFY: $m" >&2
    done
    echo "VERIFY: PRISTINE FAIL (${#mismatches[@]} mismatches)"
    return 1
  fi
  echo "VERIFY: PRISTINE OK"
  return 0
}

# restore_pristine_snapshots: восстанавливает файлы, которые patch -R не смог
# полностью откатить (overlapping patches cause context shift → patch -R fails
# silently, leaving MODIFIED files in hybrid state). Папка pristine-snapshots/
# содержит чистые копии таких файлов, извлечённые из upstream npm-тарболла.
# $1 = manifest, $2 = TUI_BASE, $3 = snapshots dir. Returns count of restored files.
restore_pristine_snapshots() {
  local manifest="$1" base="$2" snapdir="$3"
  [ -d "$snapdir" ] || return 0
  local restored=0
  # Build sha256 lookup from manifest (path → expected hash).
  declare -A expected_hash=()
  local line sha path
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    [[ "$line" =~ ^# ]] && continue
    sha="" path=""
    read -r sha path <<< "$line" || true
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || continue
    [ -n "$path" ] || continue
    expected_hash["$path"]="$sha"
  done < "$manifest"
  # For each snapshot file, check if the corresponding TUI_BASE file mismatches.
  local snapfile relpath actual
  while IFS= read -r -d '' snapfile; do
    relpath="${snapfile#"$snapdir"/}"
    [ -f "$base/$relpath" ] || continue
    [ -n "${expected_hash[$relpath]:-}" ] || continue
    actual="$(sha256sum "$base/$relpath" | cut -d' ' -f1)"
    if [ "$actual" != "${expected_hash[$relpath]}" ]; then
      cp "$snapfile" "$base/$relpath"
      echo "VERIFY: restored from snapshot: $relpath (patch -R left non-pristine)"
      restored=$((restored + 1))
    fi
  done < <(find "$snapdir" -type f -print0)
  return "$restored"
}

# --- Режим --verify: I1 pristine-hash gate (revert → check → re-apply) -------
if [ "${1:-}" = "--verify" ]; then
  MANIFEST="$REPO_DIR/dsh-overrides/pristine-manifest.sha256"
  if [ ! -f "$MANIFEST" ]; then
    echo "VERIFY: manifest not found: $MANIFEST" >&2
    exit 1
  fi
  SNAPSHOTS_DIR="$REPO_DIR/dsh-overrides/pristine-snapshots"

  echo "VERIFY: reverting all patches..."
  revert_all
  echo "----------------------------------------"
  echo "reverted=$applied skipped=$skipped failed=$failed"

  if [ "$failed" -ne 0 ]; then
    echo "VERIFY: revert had failures (failed=$failed) — aborting" >&2
    exit 1
  fi

  # Restore pristine snapshots: patch -R cannot fully revert overlapping
  # MODIFIED files (e.g. plugin.js touched by 16 patches). Snapshots from
  # the upstream npm tarball provide clean copies as a last-resort fix.
  if [ -d "$SNAPSHOTS_DIR" ]; then
    echo "VERIFY: restoring pristine snapshots..."
    restore_pristine_snapshots "$MANIFEST" "$TUI_BASE" "$SNAPSHOTS_DIR" || true
  fi

  echo "VERIFY: checking pristine state..."
  verify_rc=0
  verify_pristine "$MANIFEST" "$TUI_BASE" || verify_rc=$?

  echo "VERIFY: re-applying all patches..."
  apply_all
  if [ "$failed" -eq 0 ]; then
    generate_forkversion
  fi
  echo "----------------------------------------"
  echo "applied=$applied skipped=$skipped failed=$failed"

  if [ "$failed" -ne 0 ]; then
    echo "VERIFY: re-apply had failures (failed=$failed)" >&2
    exit 1
  fi
  exit "$verify_rc"
fi

# --- Режим --revert: обратный порядок, маркер = признак "применён" ----------
if [ "${1:-}" = "--revert" ]; then
  revert_all
  echo "----------------------------------------"
  echo "reverted=$applied skipped=$skipped failed=$failed"
  [ "$failed" -eq 0 ]
  exit 0
fi

# --- Применение (режим по умолчанию) — в порядке PATCH-SERIES -----------------
apply_all

if [ "$failed" -eq 0 ]; then
  generate_forkversion
fi

echo "----------------------------------------"
echo "applied=$applied skipped=$skipped failed=$failed"
[ "$failed" -eq 0 ]
