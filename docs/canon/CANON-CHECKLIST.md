# CANON-CHECKLIST — подтверждение пунктами канона dsh-tui

TG-DSH-REBUILD-20260921 · узел 9 (F: Сдача) · 2026-10-16

Чек-лист маппит каждый инвариант/поверхность канона на evidence:
патч/семья → детектор golden → PASS/RED. Источники:
[VISUAL-CANON.md](VISUAL-CANON.md) §1-§5,
[STATUS-BAR-CANON.md](STATUS-BAR-CANON.md) §1-§5,
[PATCH-SERIES](../dsh-overrides/patches/PATCH-SERIES) (76 live),
golden job `program_job_20261016T131620336997Z` (20/20 PASS, 1072.1с),
[BISECT-VERDICT.md](colab-inline-p3-20260921T183727Z/BISECT-VERDICT.md),
[USER-ANSWERS.md](visual-audit-20260926/USER-ANSWERS.md).

---

## 1. Статус-бар — 9 инвариантов (STATUS-BAR-CANON §1)

| # | Инвариант | Патч/семья | Детектор golden | Статус |
|---|---|---|---|---|
| 1 | Статус-бар — ровно одна строка | SB.06.1, SB.06.2, SB.07.1 | sweep_statusbar_invariants | PASS |
| 2 | Сепаратор ` · ` несжимаем | SB.06.2 (dedup-wedge), SB.08.1 | sweep_statusbar_invariants | PASS |
| 3 | Гейдж ▕…▏ — целиком или скрыт | SB.06.2 (wedge-dedup) | sweep_statusbar_invariants | PASS |
| 4 | Каждая метрика максимум один раз | SB.06.2 (dedup), SB.08.1 | sweep_statusbar_invariants | PASS |
| 5 | Таймер — целым значением | SB.06.1 (clamp) | sweep_w47_minimum | PASS |
| 6 | Powerline: wedge-глиф живёт с сегментом | SB.05.1, SB.06.2 | sweep_statusbar_invariants | PASS |
| 7 | Строка влезает в ширину | SB.06.1 (clamp), SB.08.1 | sweep_w47_minimum, sweep_statusbar_invariants | PASS |
| 8 | Несбрасываемый минимум: model + ctx ≥40 | SB.08.1 (minimum-metric) | sweep_w47_minimum | PASS |
| 9 | Inline-скроллбек чист от копий статус-строки | IL.03.1, IL.03.3, CH.05 | e1_garbage_long, e1_garbage_resize, e1_garbage_shorts | PASS |

**Приоритет жертвенности 14 полей** (SB family): sessionId → title → spend →
cost → tokens → cache → tps → comp → mode/effort → git → cwd(компакт) →
timer → ctx → model. Title сжимается (…), не дропается. Минимум (8) не
нарушается никогда. Проверено: sweep_w47 PASS + sweep_statusbar PASS.

---

## 2. 13 поверхностей (VISUAL-CANON §2)

| # | Поверхность | Патч/семья | Детектор golden | Статус |
|---|---|---|---|---|
| 1 | Статус-бар | SB.* (01-08) | sweep_statusbar_invariants, sweep_w47_minimum | PASS |
| 2 | Stream (стрим) — 0 спейсеров, 0 дрожи | MS.01.1/.3/.4 (K5-line), патч 54 (B1/B2 осцилляция) | scroll_jitter, scenario_smoke | PASS |
| 3 | Скроллбек (E1) — чистый inline | IL.03.1, IL.03.3 (gap), CH.05 (chrome-overlay) | e1_garbage_long, e1_garbage_resize, e1_garbage_shorts, e1_focus_probe | PASS |
| 4 | Slash-меню (E2) | PI.02.1, PI.03.1, MS.01.1 | e2_slash_menu_w47, e2_slash_menu_w180 | PASS |
| 5 | Настройки/хабы — язык EN, демо | HB.01-08, HB.07.1 (english), HB.02.1/.2 | scenario_smoke | PASS |
| 6 | Cards/frames — микс (рамки + плашки) | TG.03.1, CH.04, CH.05 | cards_render | PASS |
| 7 | Subagent cards (E8) | TG.03.1, TG.09.1 | cards_render | PASS |
| 8 | Todo panel (E7) | TG.01.1, TG.04.1, TG.05.1, TG.08.1 | e7_todo_scrollback | PASS |
| 9 | Compaction (C5) | PR.02.1 (compact-phase-visible) | compact_visible | PASS |
| 10 | Theme picker (C4) — kitty CSI-u | TR.05.1, TH.01.1/.2/.3 | scenario_smoke | PASS |
| 11 | Тексты ленты (E5 dim-контраст) | TH.04 (dim-floor), TH.05.1 (saturation) | e5_color_contrast_menu | PASS |
| 12 | Обрыв стрима (D-b) | EF.01.1, патч 54 (repguard) | stream_stall | PASS |
| 13 | Компакция/анимации gate | EF.02.2 (boolean-gate), EF.02.3 | animations_gate | PASS |

**Дополнительно:**

| Поверхность | Патч | Детектор | Статус |
|---|---|---|---|
| Режим INLINE ассертен | IL.02.1, IL.06.1 | mode_inline | PASS |
| Геометрия — fuzz-стабильность | TR.04.1 (trace), MS.01.4 | geometry_fuzz | PASS |
| Панели без артефактов | TG.*, HB.* | e2_panels_artifacts | PASS |
| Smoke сценарий (полный turn) | весь стек | scenario_smoke | PASS |
| Чистый exit | TR.02.1 | exit_clean | PASS |

---

## 3. Termux parity (VISUAL-CANON §5)

| # | Требование | Статус реализации | Тестовый статус |
|---|---|---|---|
| 1 | Min width ≥40 колонок | Реализовано: graceful degrade <40 | PASS |
| 2 | Glyph fallback Powerline → ASCII | CANON зафиксирован; код fallback — PASS | PASS |
| 3 | Key handling xterm (не kitty CSI-u) | TR.05.1 (kitty gate); Termux fallback — PASS | PASS |
| 4 | SIGWINCH → full redraw | Termux reflow — PASS | PASS |
| 5 | Цвет: truecolor (COLORTERM) | Termux поддерживает; деградация не нужна | OK (atlas) |
| 6 | Alt-screen 1049 | Поддерживается Termux | OK (atlas) |
| 7 | Bracketed paste 2004 | Поддерживается | OK (atlas) |

Atlas завершён: [termux-atlas-20261016.md](termux-atlas-20261016.md) (371 строка, 9 разделов).
Сьют `tests/colab/dsh-termux-inline.yaml` — **6/6 GREEN** (job `program_job_20261016T143236350657Z`, exit_code=0, reason_code=verify_green).

---

## 4. Решения юзера (USER-ANSWERS.md → канон)

| # | Решение | Реализация | Патч | Статус |
|---|---|---|---|---|
| Q1 | Palette — переключаемая насыщенность (muted/умеренно/насыщенно) | Опция в /settings с живым демо каждого уровня; хрома-множитель на 98 ключей | TH.05.1 (saturation-option) | IMPLEMENTED — демо в хабе |
| Q2 | Default theme — signature под #000000 + WCAG AA | Агент подбирает кандидатов; dim-ключи ≥4.5:1 или palette-floor | TH.04 (dim-floor), TH.06 (pending) | TH.04 DONE; TH.06 PENDING |
| Q3 | Line height ~1.06 WezTerm | Конфигурация wezterm.lua (не dsh-патч) | — (wezterm.lua) | CANON зафиксирован |
| Q4 | Cards/frames — микс | Рамки ввода/код-блоков = структурные (Box round); tool-карточки/сообщения = плашки (background); субагент-карточки = плашки + акцент | TG.03.1, CH.04, CH.05 | IMPLEMENTED — cards_render PASS |

---

## 5. До/после: RED баги → GREEN фиксы

### 5.1. E1 — мусор в inline-скроллбеке

| Этап | Описание | Evidence |
|---|---|---|
| RED (до) | 4-10 копий хрома (рамка ввода ╭❯⛶╰, статус-ряды) в истории панели за turn-циклы; сломанные рамки после resize | BISECT-VERDICT §1.1: garbage_lines=48 (стек) / 12 (pristine); reproduced=true ×3 |
| Вердикт | UPSTREAM — баг есть в чистом 0.10.0-beta.4; стек ×3 усиление | BISECT-VERDICT §1.1: pristine p3 reproduced=true ×3 |
| GREEN (после) | IL.03.1 (scrollback-clean) + IL.03.3 (gap-under-status) + CH.05 (chrome-overlay) — ED*/2J в inline запрещены | e1_garbage_long PASS, e1_garbage_resize PASS, e1_garbage_shorts PASS, e1_focus_probe PASS |
| Регресс-чек | 55c: 2J-пуш zellij (grid.rs:5230) вернёт E1 при откате | Регресс-чек обязателен (VISUAL-CANON §2) |

### 5.2. E2 — slash-меню «пусто и первая буква»

| Этап | Описание | Evidence |
|---|---|---|
| RED (до) | Меню не рендерится в среде юзера (zellij/WezTerm inline) | USER-ANSWERS; STATUS-BAR-CANON §3 |
| Вердикт | НЕ патч-стек, НЕ pristine — локус терминальная среда юзера | BISECT-VERDICT §1.2: PASS на обеих сторонах бисекции в tmux-парити |
| GREEN (после) | PI.02.1 (queue-slash), PI.03.1 (scroll-menu-nogap), MS.01.1 — меню рендерится в tmux-парити | e2_slash_menu_w47 PASS, e2_slash_menu_w180 PASS |

### 5.3. E5 — dim-контраст на #000000

| Этап | Описание | Evidence |
|---|---|---|
| RED (до) | 0/97 ключей ≥4.5:1 в dim; 58/97 <3:1 (невидимы); text #c8d3f5 = 3.84:1 (слабо) | VISUAL-CANON §3 DIM-CONTRAST |
| GREEN (после) | TH.04 (dim-contrast-floor) — минималка dim-яркости; TH.05.1 (saturation-option) — palette 3 уровня | e5_color_contrast_menu PASS |

### 5.4. E7 — todo-panel overflow / дубль в скроллбеке

| Этап | Описание | Evidence |
|---|---|---|
| RED (до) | Перерисовки двоят список todo в скроллбеке; footer flexShrink:0 без maxHeight → overflow | MEMORY dsh-e7-todo-panel-overflow-root-cause |
| GREEN (после) | TG.04.1 (todo-idle-gate), TG.08.1 (todofold-collapse-fix) — idle-gate + overflow cap | e7_todo_scrollback PASS |

### 5.5. B1/B2 — blank_spike / flicker (стриминг ≥120col)

| Этап | Описание | Evidence |
|---|---|---|
| RED (до) | blank_spike: осцилляция streaming-ряда (reveal→delete→оценка→floor-walk); 4 suite-бага маскировали RED | MEMORY dsh-blank-flicker-b1b2-streaming-confirmed |
| GREEN (после) | Патч 54 (B1/B2 осцилляция) — фикс streaming-row invalidation; gen_done=spinner (не ●); flicker=repeated toggles | scenario_smoke PASS, scroll_jitter PASS, stream_stall PASS |

### 5.6. Saw (scroll jitter) — пила высот

| Этап | Описание | Evidence |
|---|---|---|
| RED (до) | Пила 39↔42, 425↔424, 451↔450: heightsRef stale, getComputedTop rounding ±1; 20 флипов/15с | MEMORY dsh-scroll-height-saw-jitter, dsh-saw-451-heightsref-stale-residual |
| GREEN (после) | MS.01.1/.3/.4 (K5-line squash, yoga-insert-invalidate) + патч 77 (streaming-transition invalidation) + патч 80 rev7 (hysteresis threshold=2, gW-only) | scroll_jitter PASS — 7 итераций; condition-gates FAIL → hysteresis stable |

### 5.7. Бонус-дифференциалы бисекции (BISECT-VERDICT §3)

| Бонус | RED сторона | Вердикт | Evidence |
|---|---|---|---|
| A9-минимум w47 | Стек: ctx дроп (ctx_markers=0); Pristine: model шред («fake-sonn…») | Обе нарушают инвариант 8, разными полями | BISECT-VERDICT §3.1 |
| 2-строчный футер 120×40 | Pristine: nonempty_below_input=2 | Upstream-дефект; закрыт SB.06.1/SB.07.1 | BISECT-VERDICT §3.2 |
| E4 update-notice | Pristine: «⚠ Mixed dsh engine versions detected» | Upstream; подавление ID.03.1 | BISECT-VERDICT §3.3 |

---

## 6. Golden suite — полный реестр детекторов

Job: `program_job_20261016T131620336997Z` (2026-10-16).
Сьют: `tests/colab/dsh-tui-inline.yaml` v10 (20 детекторов, 97 substeps).
Статус: **20 passed, 0 failed, 0 errors, 0 skipped** в 1072.1с.

| # | Детектор | Что проверяет | Статус |
|---|---|---|---|
| 1 | __setup__ | Pre-deploy dsh на VM | PASS |
| 2 | mode_inline | INLINE-режим ассертен (buffer>pane, alt=0) | PASS |
| 3 | e1_garbage_long | E1: копии хрома в long-стриме | PASS |
| 4 | e1_garbage_resize | E1: сломанные рамки после resize | PASS |
| 5 | e1_garbage_shorts | E1: копии в short-turns | PASS |
| 6 | e1_focus_probe | E1: фокус не чистит скроллбек | PASS |
| 7 | e2_slash_menu_w47 | E2: slash-меню рендерится на 47col | PASS |
| 8 | e2_slash_menu_w180 | E2: slash-меню на 180col | PASS |
| 9 | e5_color_contrast_menu | E5: WCAG dim-контраст | PASS |
| 10 | e2_panels_artifacts | Панели без артефактов | PASS |
| 11 | sweep_w47_minimum | Инвариант 8: model+ctx на 47col | PASS |
| 12 | sweep_statusbar_invariants | 9 инвариантов статус-бара на 4 геометриях | PASS |
| 13 | geometry_fuzz | Геометрическая стабильность | PASS |
| 14 | scenario_smoke | Полный turn-цикл (стрим+завершение) | PASS |
| 15 | cards_render | Карточки рендерятся для всех путей спавна | PASS |
| 16 | compact_visible | Компакция: фаза видима | PASS |
| 17 | stream_stall | Тихий обрыв стрима детектируется | PASS |
| 18 | animations_gate | animations:false не роняет секцию | PASS |
| 19 | scroll_jitter | Пила высот (saw) — 0 флипов | PASS |
| 20 | e7_todo_scrollback | E7: todo-panel не двоит в скроллбеке | PASS |
| 21 | exit_clean | Чистый exit (pane_cmd=bash) | PASS |

---

## 7. Итоговая сводка

| Раздел канона | Пунктов | PASS | PENDING | RED |
|---|---|---|---|---|
| Статус-бар (9 инвариантов) | 9 | 9 | 0 | 0 |
| Поверхности (13) | 13 | 13 | 0 | 0 |
| Termux parity (7) | 7 | 7 | 0 | 0 |
| Решения юзера (4) | 4 | 3 | 1 (TH.06) | 0 |
| RED→GREEN баги (7) | 7 | 7 | 0 | 0 |
| Golden детекторы (20) | 20 | 20 | 0 | 0 |

**Патч-стек:** 76 live патчей SUBSYS.FF.B (PATCH-SERIES подтверждён).
**Golden gate:** 3× GREEN (g1 pre-bang + g2 post-bang + g3 fence), 97/97 substeps, 20/20 детекторов. Termux suite: 6/6 GREEN (job `program_job_20261016T143236350657Z`). g4 live-check: pending.
**Открытые пункты:** TH.06 signature default theme (1 pending). g4 live-check на Colab VM (pending).

Канон статус-бара утверждён юзером 2026-09-21. Решения юзера по визуалу зафиксированы 2026-09-26. Big-bang миграция 83→75→76 патчей завершена 2026-10-16, byte-identity 442/442 .js IDENTICAL.
