# VISUAL-CANON — канон визуальных поверхностей dsh-tui

TG-DSH-REBUILD-20260921 · Phase 4.1 визуального оверхола.
**Решения юзера собраны 2026-09-26** (4 вопроса закрыты, см. §4); канон ожидает утверждения.

Статус-бар — отдельный канон: [STATUS-BAR-CANON.md](STATUS-BAR-CANON.md)
(9 инвариантов, приоритет жертвенности, утверждён 2026-09-21). Этот документ
**расширяет**, не дублирует: покрывает все остальные поверхности, визуальные
оси, решения юзера по палитре/темам/типографике, Termux parity и
монетизационный design constraint.

Основа: визуальный аудит 2026-09-26 (10 файлов, 8 осей), handoff-dsh-20260927
(5 open задач), STATUS-BAR-CANON.md (утверждённый канон).

---

## 1. Принципы

Шесть принципов определяют ВСЕ визуальные решения dsh. Любой патч, тема
или UI-изменение проверяется против них.

1. **Нет хардкод-порогов ширин.** Поведение = функция приоритетов,
   непрерывная на любой геометрии. Сужение окна не «переключает режим»,
   а плавно жертвует полями по приоритету. Пороги только для структурных
   развилок (split-diff ≥110, min width ≥40 для Termux).

2. **Паритет inline и fullscreen.** Рендер-путь один и тот же;fullscreen
   добавляет mouse-tracking и alt-screen, но не меняет композицию.
   Баг в одном режиме = баг в обоих. Исключения только структурные
   (supplemental-рядок только в fullscreen).

3. **True black #000000 — нативный фон.** Тема юзера (tokyonight-moon)
   единственная с appBackground=#000000. resolveAppBackground: 3 слоя
   (env > appearance.json > theme.appBackground). Патч-семья 36 —
   appBackground в 50 темах. Канон: #000000 поддерживается без артефактов.

4. **WCAG-контраст dim/inactive.** dim-режим (SGR 2, 50% смесь с фоном)
   должен давать ≥4.5:1 на #000000 — или визуально-различим через
   palette-опцию (TH.05, 3 уровня насыщенности). Сегодня: 0/97 ключей
   достигают 4.5:1 в dim; 58/97 < 3:1 (невидимы). TH.04 (floor) и TH.05
   (palette) закрывают. Цель: ни один dim-текст не невидим.

5. **Mobile/Termux parity.** dsh работает на ≥40 колонок. Glyph fallback
   для ambiguous-width и PUA-символов (U+E0B0 powerline). Key handling
   для терминалов без kitty-протокола. См. §5 Termux.

6. **Скроллбек чист в inline (E1 invariant).** Вне живого кадра —
   НИ ОДНОЙ копии хрома (статус-бар, рамки ввода, промпты). История =
   поток контента (сообщения, разделители turn'ов). Патч 55c (ED*/2J
   в inline запрещены) закрывает; регресс-чек обязателен.

---

## 2. Канон поверхностей

Каждая поверхность отмечена статусом: **[fixed]** (закрыт патчем),
**[by-patch]** (реализуется через патч-стек), **[open]** (не закрыт).

- **Статус-бар:** → [STATUS-BAR-CANON.md](STATUS-BAR-CANON.md).
  9 инвариантов, приоритет жертвенности, несбрасываемый минимум
  (model + контекст-метрика). Не дублируется здесь. [fixed]

- **Chat/транскрипт:** addMargin — единый 1 пустой ряд между всеми
  блоками (MessageList.js:228-235). Нет max-width — текст тянется на
  всю ширину контейнера. Основной текст сообщений НИКОГДА не обрезается,
  только перенос (ink wrap). [open] — нет меры строки, на широком
  терминале абзац занимает всю ширину.

- **Stream (стрим):** streaming-row поведение, sticky-скольжение легитимно.
  0 спейсер-зон, 0 дрожи, контент не «опускается». Патчи MS.01 (K5-line
  высоты) + патч 54 (B1/B2 осцилляция streaming-ряда). [by-patch]

- **Slash-меню (E2):** при вводе '/' юзер видит «пусто и первая буква» —
  меню не рендерится в среде юзера (zellij/WezTerm inline). В tmux-парити
  рендерится корректно. Гипотеза: оверлей-репейнт уходит в историю/мимо
  живого кадра (механизм-родственник E1). [open] — эскалация zellij на VM.

- **Settings/hub:** язык — весь EN (канон, решение юзера). 7 групп, 33 поля,
  у каждого demo (1-14 рядов). 8 несогласованностей casing (lowercase/
  camelCase среди Title Case). RU-остатки только в мёртвом EffectsPanel.js
  (не импортируется). Демо-режим: полный превью при переключении темы +
  пояснения всех настроек с примерами. [open] — 8 casing несогласованностей.
  [by-patch] — хаб-группы патч-стек.

- **Cards/frames:** РЕШЕНИЕ ЮЗЕРА — микс (см. §4 Q4). Рамки ввода и
  код-блоков — структурные (Box borderStyle round). Tool-карточки и
  сообщения — приглушённые плашки (background, без полной рамки).
  Субагент-карточки — плашки + один акцентный элемент. [by-patch]

- **Subagent cards (E8):** карточки рендерятся для ВСЕХ путей спавна
  (инструмент subagent И run_code/code-dispatch). Сегодня второй путь
  не рендерит карточки. [open]

- **Todo panel (E7):** оформление стабильно, перерисовки не двоят список
  в скроллбеке. Overflow cap (footer flexShrink:0 + maxHeight). [fixed]

- **Compaction (C5):** фаза видима (спиннер/строка «Compacting…»), завершение
  строкой. Сегодня toast 4с при окне ~52с и нулевая индикация события. [open]

- **Theme picker (C4):** применение живое; клавиши не утекают. kitty CSI-u
  leak (Shift+Enter → input="return" → фриз) — патч 62. [fixed]

- **Scrollback (E1):** inline-скроллбек чист — вне живого кадра НИ ОДНОЙ
  копии хрома. Патч 55c (ED*/2J в inline запрещены). Регресс-чек обязателен
  (2J-пуш zellij grid.rs:5230 вернёт E1 при откате). [fixed]

- **Тексты ленты (E6):** все строки видимы (fg ≠ bg, dim-ряды на фоне юзера).
  Переносы без аномальных щелей между словами. Кандидат: рассинхрон ширины
  глифов ink vs шрифт WezTerm. [open]

- **Обрыв стрима (D-b):** stop_reason length/max-tokens → авто-continue.
  Сегодня: молчаливый notice «turn max-tokens» и стоп. Stall-детектор для
  тихих обрывов. [open]

---

## 3. Канон визуальных осей

Восемь осей из аудита 2026-09-26. По каждой — инварианты, факты, статус.

### BORDERS — рамки live-кода [by-patch]

- 3 стиля: **round** (основной, 6 поверхностей), **single** (1 — Chat search
  bar borderTop), **dashed** (мёртвый, объявлен но не используется).
- 8 Box-рамочных поверхностей + 3 самодельных (EffortInputBorder,
  SuggestionCard, JobCard/SubagentMessage waterfall).
- Nested-пар «рамка в рамке» НЕТ — SearchBox borderless внутри SessionBrowser,
  expanded editor поверх инпута (не вложение).
- Все Box-рамки используют theme-ключи (permission, inactive, suggestion,
  promptBorder, promptAccent) — хардкода hex нет.
- Padding внутри рамок: 1 колонка стандарт; Tooltip/меню — 0.
- Инвариант: одна рамка на контейнер; вложенные рамки запрещены.

### COLORS — палитра и темы [by-patch]

- 98 базовых ключей в 9 группах (other 26, subagent 16, rainbow 14,
  backgrounds 10, syntax 10, tool-markers 7, shimmer 6, diff 6, borders 3).
- 50 тем, все с 97 ключами (полные переопределения). 21 уникальный
  appBackground.
- Тема юзера: tokyonight-moon, appBackground=#000000 (true black),
  text=#c8d3f5, claude=#c099ff.
- background (legacy-ключ) — яркие акцентные цвета, фоном НЕ являются.
  Единственный консьюмер: HotspotView.js:87 (mix для бара).
- resolveAppBackground: 3 слоя (env > appearance.json > theme.appBackground).
  У юзера appearance.json отсутствует → фон из theme = #000000.
- Инвариант: фон приложения всегда из resolveAppBackground; хардкод hex
  в рендере запрещён.
- Palette-опция (3 уровня насыщенности) → новая семья **TH.05** (см. §4 Q1).

### DIM-CONTRAST — видимость dim на #000000 [open, by-patch]

- **0 из 97 ключей достигают 4.5:1 в dim.** Максимум — success #c3e88d → 4.09.
- 58 ключей < 3:1 (НЕВИДИМ), 39 ключей 3-4.5:1 (СЛАБО).
- Основной dim-текст (text #c8d3f5) = 3.84:1 — СЛАБО; в терминалах с сильным
  dim-mixing падает ниже 3.
- error/claude/ide dim-строки — НЕВИДИМЫ (2.58-2.84).
- Уже-тёмные ключи (inactive/subtle/syntaxComment/promptBorder) невидимы
  БЕЗ dim (1.93-2.65 полной силой).
- У большинства dimColor-использований НЕТ собственного color: — fg
  наследуется от родителя.
- TH.04 (dim floor) — implemented: минималка dim-яркости. TH.05 (palette) —
  pending: 3 уровня насыщенности поднимают хром.
- Инвариант: ни один dim-текст не невидим на #000000. Цель ≥4.5:1 или
  визуально-различим через palette.

### GLYPHS — не-ASCII символы [open]

- 400 JS-файлов, 33658 вхождений, 1362 уникальных символов.
- 149 ambiguous-width символов (box-drawing, block elements, geometric
  shapes — главный кандидат разъезда ширины).
- 144 emoji-capable; 1 PUA (U+E0B0 powerline — требует Nerd Font).
- Top по вхождениям: ─ (3617), — em dash (2801), · middot (780),
  → (505), （）fullwidth (456×2).
- CJK 944 идеографа (i18n zh), Cyrillic 52 (i18n ru).
- StatusLine.js: 64 em dash, 19 middot, 24 ellipsis, 15 §, 6 ⚡, 5 ✦ —
  основная зона рисковых глифов.
- Powerline U+E0B0 (StatusLine.js:224) — без Nerd Font = tofu/ширина 0-2
  → разъезд статус-бара.
- Инвариант: fallback policy — ambiguous-width глифы должны рендериться
  предсказуемо на любом шрифте; PUA-глифы — с fallback на ASCII
  (`|` или `:`).

### MEASURE — ширина и перенос [open]

- **Твёрдой меры (max columns) для текста транскрипта НЕТ** — текст тянется
  на всю ширину контейнера.
- Источник ширины: useTerminalSize().columns (live).
- Gutter (TimelineRail/scrollbar) = 2 колонки постоянно. ScrollBox width 100%.
- Split-дифф: порог 110 колонок (SPLIT_DIFF_MIN_COLS=110), иначе unified.
- Waterfall: rowWidth = max(20, columns-4), clipLine + wrap:truncate.
- Фолд-кап: TEXT_BODY_MAX_LINES=3, DIFF_BODY_MAX_LINES=8 (до expand).
- Основной текст сообщений: НИКОГДА не обрезается — только перенос.
  truncate — только вторичные линии.
- Инвариант: на широком терминале абзац не должен занимать >оптимальной
  ширины чтения. [open] — max-width для транскрипта не реализован.

### SPACING — отступы [open, by-patch]

- Главный механизм: addMargin (MessageList.js:228-235) — каждый блок
  получает marginTop:1, кроме первого. Единый 1 пустой ряд между ВСЕМИ
  блоками транскрипта.
- Горизонтальные сдвиги тел: tool=1 (paddingLeft), thinking/subagent/
  local-output=2, demo в хабе=4.
- PromptInput root: marginTop:0 (было 1, убрано — пустой ряд читался как
  мусор между спиннером и рамкой).
- Box-рамки: paddingX:1 стандарт. EffortInputBorder: 0 по горизонтали.
- Powerline: межсегментного отступа нет (стык через U+E0B0-заливку).
- Значения захардкожены числами в каждом call-site — единого токена
  spacing нет. [open] — spacing tokens не реализованы.
- [by-patch] — addMargin патч-семья 26; marginTop:0 правка PromptInput.

### TYPOGRAPHY — веса, casing, truncate [open]

- bold: 82 вхождения — заголовки (title/name), выбранная строка пикера
  (selection), значения/бейджи.
- dimColor: 413 вхождений (195 true + 218 условных). Top: SettingsExamples
  (22), StatusLine (18), PromptInput (11), GoalTodoPanel (11).
- inverse: 48 (UI-слой) — курсор ввода, демо-свотчи, слайдер, тогл.
- truncate: 92+2, truncate-end: 80, явный wrap: 26.
- italic: 73 (hints, ErrorOverview).
- 8 несогласованных label-casing в хабе: 'ctx-bar mode', 'sparkTps',
  'mks actual model', 'mini-key-switcher spending', 'toolProgressBars' —
  lowercase/camelCase среди Title Case соседей.
- AssistantTextMessage/Markdown — wrap-проп НЕ выставлен (дефолт ink wrap).
  Корректно для транскрипта.
- Инвариант: casing меток хаба — единый Title Case. [open] — 8/42 несогласованы.

---

## 4. Решения юзера (зафиксированы как канон)

Четыре ответа юзера (TG-DSH-VISUAL-20260926) — канонические решения,
не подлежащие пересмотру без явного согласия юзера.

### Q1. Palette — переключаемая опция насыщенности [TH.05]

Юзер НЕ выбрал готовый уровень → директива: сделать переключаемой опцией
в /settings с живым демо каждого уровня.

- 3 уровня: **muted** / **умеренно** / **насыщенно**
- Дефолт: «умеренно»
- Live demo в хабе (как theme-preview)
- Новая патч-семья **TH.05** — palette saturation control
- Архитектура: не новые темы, а хрома-множожитель на существующие 98 ключей

### Q2. Default theme — signature-тема под #000000 [TH.06]

Юзер: «настраиваемо, любая топ» → агент подбирает signature-тему под
true black #000000 с учётом dim-контраста.

- Пакет тем-кандидатов с демо, юзер листает в хабе /settings
- Критерий: dim-ключи визуально-различимы на #000000 (≥4.5:1 или palette)
- Новая патч-семья **TH.06** — signature default theme
- Текущая tokyonight-moon — отправная точка; dim-контраст 0/97 → требует
  правки ключей или palette-floor

### Q3. Line height — воздух в WezTerm

Юзер: «Да, воздух (Recommended)» → line_height ~1.06 в wezterm.lua.

- Трейд-офф: 22 ряда → ~21 (потеря ~1 ряда на высоту)
- Конфигурация wezterm.lua, не dsh-патч
- Визуальный эффект: межстрочный интервал, лучшая читаемость
- Паритет: влияет на inline-геометрию юзера (47×43 → ~47×~41)

### Q4. Cards/frames — микс

Юзер: «Микс (Recommended)»:

- **Рамки ввода и код-блоков** — структурные (Box borderStyle round,
  theme-ключи promptBorder/promptAccent)
- **Tool-карточки и сообщения** — приглушённые плашки (background,
  без полной рамки)
- **Субагент-карточки** — плашки + один акцентный элемент
- Не единый стиль (не «всё в рамках» / «всё без рамок»), а функциональное
  разделение: структурное = рамка, контентное = плашка

---

## 5. Termux parity (mobile)

dsh должен работать на мобильных терминалах (Termux на Android) — канон
parity для узких экранов и ограниченных шрифтов. Atlas завершён
(исследование из исходного кода termux/termux-app v0.118.x, GitHub master,
2026-10-16) — все факты из первоисточника.

### Минимальные требования

- **Min width ≥40 колонок.** dsh рендерится корректно от 40 колонок.
  ≥40 = fully supported; <40 = graceful degradation (без краша).
  Канон статус-бара: ≥40.
- **Glyph fallback policy.** 149 ambiguous-width символов + 1 PUA
  (U+E0B0 powerline) должны рендериться предсказуемо:
  - Powerline → fallback на ASCII-сепаратор (`|` или `:`)
  - Box-drawing → моноширинный fallback
  - Ambiguous-width →clamp к ширине 1
- **Key handling.** Терминалы без kitty-протокола:
  - Shift+Enter → fallback на обычный Enter (патч 62 закрывает kitty CSI-u
    leak, но Termux не поддерживает kitty вообще)
  - Спец-клавиши — через standard CSI-последовательности
- **Цветовая поддержка.** Termux поддерживает 256-color / truecolor.
  Для терминалов без truecolor: деградация truecolor → 256 → 16.
  Termux поддерживает truecolor (COLORTERM=truecolor) — деградация
  не нужна для Termux.

### Terminal characteristics (atlas-confirmed)

- **$TERM=xterm-256color**, **COLORTERM=truecolor** → truecolor 24-bit YES,
  256 colors YES. Кастомной terminfo-записи НЕТ — XTGETTCAP отвечает «xterm»,
  стандартный xterm terminfo из ncurses.
- **Alt-screen (1049)** полностью поддерживается → fullscreen-режим dsh OK.
- **DA1**: `ESC[?64;1;2;4;6;9;15;18;21;22c` — VT420 capabilities.
- **LANG=en_US.UTF-8** → Unicode OK.
- Mouse: SGR (1006) + touch-as-mouse → CANON: touch работает как mouse.
- Bracketed paste (2004) YES → paste detection работает.

### Glyphs (CANON)

- **Typeface.MONOSPACE** (Android system font, обычно Roboto Mono / Noto Mono)
  — box-drawing (U+2500–U+257F) рендерится через шрифт, OK с дефолтным.
- **Powerline U+E0B0** требует Termux:Styling кастомный шрифт → CANON:
  dsh должен иметь ASCII-fallback для powerline (`|` или пробел) когда
  Nerd Font недоступен. Без кастомного шрифта — tofu (□).
- **Braille (U+2800–U+28FF)** — через шрифт, Noto includes braille.
  CANON: проверить рендеринг спиннеров/индикаторов на дефолтном шрифте.
- **DEC Special Graphics** (line drawing mode, `ESC(0`) — поддерживается,
  альтернатива Unicode box-drawing если шрифт проблемный.
- Ширина глифа: `Paint.measureText` определяет cell width; mismatch >1%
  → glyph scaled to expected width. Ambiguous-width → clamp к 1.

### Keyboard (CANON)

- **kitty CSI-u НЕ поддерживается** — нет кода для `CSI <codepoint>u`.
  CANON: dsh использует traditional xterm encoding на Termux.
- **modifyOtherKeys** парсится но игнорируется (`"(ignored) CSI > MODIFY RESOURCE"`).
- **Modifier codes**: Shift=2, Alt=3, Shift+Alt=4, Ctrl=5, Shift+Ctrl=6,
  Alt+Ctrl=7, Shift+Alt+Ctrl=8.
- **Shift+Enter** неотличим от Enter на soft keyboard → `\r`.
  CANON: dsh не полагается на Shift+Enter на Termux.
- **Alt key**: ESC prefix перед codepoint → readline shortcuts OK.
- **Extra Keys panel**: Ctrl, Alt, Shift, Fn, arrows, ESC, TAB как on-screen buttons.

### Geometry (CANON)

- **Portrait** ~38-42 cols × 40-44 rows (типичный 6.1" телефон).
- **Landscape** ~80-85 cols × 18-20 rows.
- **Tablet** (10"): portrait ~60-70×30-40, landscape ~90-110×40-50.
- **Min 4 columns × 4 rows** (hardcoded floor в Termux).
- CANON: dsh должен gracefully degrade на <40 cols (Termux portrait) —
  контент обрезается/переносится, статус-бар сворачивается до минимума
  (model+ctx). Не крашиться.
- CANON: при SIGWINCH (rotation) — full-redraw, не полагаться на terminal reflow.

### Sync output (DEC 2026)

- **НЕ поддерживается** — zero matches for «2026» в TerminalEmulator.java.
- dsh уже обрабатывает (`isSynchronizedOutputSupported` fallback false).
- CANON: sync output опционален, dsh работает без него. Flicker reduction
  через inline-render optimization (патч-стек SUBSYS.FF.B).

### Limitations (CANON)

- **Нет reflow при resize** → CANON: dsh делает full-redraw на SIGWINCH.
  Содержимое может быть обрезано при сужении, не восстановится при расширении.
- **Нет focus events (mode 1004)** → CANON: dsh не полагается на focus reporting.
- **Scrollback** 2000 (настраиваемый 100–50000), только main buffer.
- **Sixel graphics YES** (DCS q) — не используется dsh, но доступно.
- **Android 12+**: OS может убить phantom processes (>32) — не terminal issue.

### Канон

dsh работает на ≥40 колонок с glyph fallback. Ниже 40 — graceful degrade
(контент обрезается, статус-бар сворачивается), не краш. Powerline — ASCII
fallback. Keyboard — traditional xterm encoding (kitty CSI-u недоступен).
Sync output опционален. Full-redraw на SIGWINCH (reflow отсутствует).
Сьют: `tests/colab/dsh-termux-inline.yaml` (new — Phase 4.3c).
Полный atlas: `reports/termux-atlas-20261016.md` (371 строка, 9 разделов).

---

## 6. Монетизация design constraint

Архитектурный constraint, заложенный в визуальный канон СЕЙЧАС — чтобы
не блокировать будущую монетизацию. Не текущая фаза реализации.

### Provider-marketplace

- **Ranked/featured slot** вверху списка провайдеров в provider-picker UI.
- PR.* семьи патч-стека поддерживают ranking/featured flags.
- Affiliate/referral routing: провайдер может быть отмечен как
  partner/referral → отдельный визуальный маркер (badge/акцент).
- Визуальный канон: provider-picker UI имеет слот для ranked/featured
  провайдера вверху списка, не нарушая остальную композицию.

### Constraint сейчас

- Не реализовывать ranking UI сейчас.
- Не блокировать: provider-picker UI должен иметь расширяемую структуру
  (slot для featured-провайдера без переделки списка).
- Патчи PR.* — ranking/featured flags как metadata, без UI-рендера.
- Монетизация future: paid partner relay-API вверху списка провайдеров.

---

## 7. Верификация

Канон проверяется детекторами golden-сьюта + рантайм-пробами на
геометрии юзера.

### Golden suite

- **dsh-tui-inline.yaml v10** — 20 детекторов, 97 substeps.
- Покрытие: B1/B2 (blank_spike, streaming осцилляция), E1 (скроллбек-дубль),
  E5 (dim-контраст/WCAG), E7 (todo-panel overflow), saw (scroll jitter),
  kitty (CSI-u key leak), blank_spike (flicker).
- Прогон: `socctl verify --lane colab --label green --max-wait 4200`.
- Требует pre-deploy: `colab-dsh-up.sh --target current` ДО verify.
- Golden gate: 3× GREEN (g1 pre-bang + g2 post-bang + g3 fence), все
  97/97 substeps, 20/20 детекторов, 0 fail.

### Канон-детекторы

Каждый инвариант → детектор (где применимо):

| Инвариант | Детектор |
|---|---|
| Статус-бар 9 инвариантов | STATUS-BAR-CANON.md §4 (golden suite) |
| E1 скроллбек чист | `blank_spike` + `scrollback_dup` |
| E5 dim-контраст | `dim_invisible` (WCAG < 3:1) |
| E7 todo overflow | `panel_not_rendered` + `overflow_dup` |
| Saw (scroll jitter) | `scroll_jitter` + `saw_flips` |
| Kitty CSI-u | `key_leak` (Shift+Enter → return) |
| B1/B2 streaming | `blank_spike` + `flicker` (repeated toggles) |

### Before/after кадры

- Геометрия юзера: 47×43 inline (WezTerm + zellij).
- До/после кадры на КАЖДОМ изменении патч-стека.
- Vision-валидатор: «процитуй строку» — ответ без цитаты = галлюцинация.
- Режим (inline/fullscreen) ассертить рантайм-детектором, не промптом.

### Termux parity suite

- **tests/colab/dsh-termux-inline.yaml** (new — Phase 4.3c).
- Покрытие: min width ≥40, glyph fallback, key handling, color degradation.
- Lane: SOC android (Termux на Android-устройстве).

### Регресс-чеки

- **55c регресс:** в свежем dsh-билде 2J в inline не шлётся (трейс/прокси-эхо).
  Регресс = мгновенный возврат E1 через 2J-пуш zellij (grid.rs:5230).
- **E9-resize:** SIGWINCH/resize при сплитах — 0 дублированных рядов
  после нормализации. [open] — не гонялся ни в одном слое.
- **fullscreen-мышь:** dsh fullscreen под zellij — колесо+hover, детекторы
  saw/tooltip. [open] — mouse-tracking есть в fullscreen (Chat.js:910).
- **ANIM-RCA:** supplemental-петля анимации — детектор anim. [open] —
  свежий статус после 55c не снят.
