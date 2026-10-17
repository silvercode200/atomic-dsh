# PATCH-MAP — dsh-overrides: старый ID → SUBSYS.FF.B (этап 0, alias)

Сгенерировано этапом 0 миграции патч-стека (TG-DSH-PATCHMIG-20260928,
узел 1, компоненты а+б: DEP-3 шапки + PATCH-MAP). Имена файлов НЕ
переименованы (alias-этап): старый ID остаётся именем файла; новый ID
живёт в этой карте, Family (SUBSYS.FF) — в DEP-3-шапке патча.
Rename файлов — этап 1 (big-bang).

Источники: эскиз маппинга — reports/patchstack-research-20260924/
RESEARCH.md (Приложение 1, истина по умолчанию; компаньоны — C.7);
статусы — reports/patch-stack-revision-20260921/PATCH-STACK-REVISION.md;
патчи 66-72 моложе рисёча — классифицированы по словарю C.4
(причина — в примечаниях). Волны/TaskGate-привязки — git log,
реестр-комментарии scripts/apply-dsh-overrides.sh.

Легенда статусов: **live** — применяется и работает; **absorbed** —
поглощён позднейшим патчем (покидает серию на этапе 2); **dead** —
погашен конфигом юзера/снят (покидает серию на этапе 2).
М* (полумёртвые по ревизии) → live с пояснением живой/мёртвой части.
Инвариант: Family в DEP-3-шапке патча = SUBSYS.FF этой карты (80/80).

| Старый ID+slug | Новый ID (SUBSYS.FF.B-slug) | Status | Goal | Примечание |
|---|---|---|---|---|
| 01-empty-screen | CH.01.1-empty-screen | live | пустой экран старта: flexGrow транскрипт-ряда rows>0 | ослаблен 25 (slack всегда сверху) |
| 02-glitch-toast | SB.01.1-glitch-toast | live | тост-уведомление in-flow строкой над рамкой ввода | K: конфликт с 48 (тост не кламплен); E1-кандидат №1 |
| 03-compact-todos | TG.01.1-compact-todos | live | компакт todo-панели + fold-хинт в заголовке |  |
| 04-context-percent | SB.02.1-context-percent | live | формат контекста без вводящего в заблуждение percent |  |
| 05-mobile-rows | IL.01.1-mobile-rows | live | supplemental-строка только при контенте | live: IL.01.2 (10) зависит от контекста IL.01.1 в StatusLine.js — нельзя удалить из серии |
| 06-bottom-layout | CH.02.1-bottom-layout | live | низ экрана: убраны 3 пустые строки (hint/margins) |  |
| 07-model-default | PR.01.1-model-default | live | agent-default-model главенствует над model.json |  |
| 08-cyrillic-alt | TR.01.1-cyrillic-alt | live | Alt+кириллица: META_KEY_CODE_RE + а-яА-Я | Upstream: candidate |
| 09-todo-collapsed | TG.05.1-todo-collapsed | live | todo collapsed-дефолт, MAX_TODOS 12, truncate глифов | R→27: спрятал субагентов, чинено 27 |
| 10-inline-stable | IL.01.2-inline-stable | live | стабильный inline-футер: supplemental только fullscreen | гасит 05 в inline |
| 11-inline-bottom-anchor | IL.02.1-inline-bottom-anchor | live | inline-футер прилипает к низу (anchor + rate-limit) | E1-кандидат №2 (pin-flip); осцилляция → волна2 |
| 12-theme-picker-filter | TH.01.1-theme-picker-filter | live | пикер тем: фильтр-поиск + 8 свотчей |  |
| 13-subagent-todo-rows | TG.06.1-subagent-todo-rows | live | тодо субагентов: todo/write case + плоский хвост | М*: GoalTodoPanel-хвост поглощён 14; subagents-миррор жив |
| 14-subagent-tree-rows | TG.07.1-subagent-tree-rows | live | тодо-дерево: анкоринг children + глифы ◐/○/● |  |
| 15-todofold-collapse-fix | TG.08.1-todofold-collapse-fix | live | fold-toggle по невидимому фолду: showTodoSection+прун |  |
| 16-status-provider | SB.03.1-status-provider | live | строка provider-роута в /status |  |
| 17-status-mks + 17b-wave-c | SB.04.1-status-mks-wave-c | live | MKS спенд/реал-модель/comp-прогресс в статус-баре + Wave C statusbar-схема plugin.js | 3C squash: SB.04.1+SB.04.2; Ж*: polling жив; поля частично замьютены тумблерами |
| 18-hotkeys-planmode | PI.01.1-hotkeys-planmode | live | shift+tab=plan, ctrl+a=dashboard (keymap+PromptInput) |  |
| 19-fold-hint | TG.02.1-fold-hint | live | модификатор в fold-хинте (i18n {{mod}}) |  |
| 20-queue-slash | PI.02.1-queue-slash | live | слэш в ходе → очередь (queueSend), не литералом модели | submit-ветка, НЕ прячет меню |
| 21-hide-drift | ID.01.1-hide-drift | live | drift-баннер скрыт на старте |  |
| 22-model-fork-render | PR.03.1-model-fork-render | live | фриз после /model-форка: paint watchdog + bindAgent | E1-кандидат №3 (полнокадровый renderNow); idle-шторм чинен |
| 23-todofold-space | IL.07.1-todofold-space | live | пустая полоса свёрнутых тодо: ScrollBox contentJustify | live: IL.06.1 (25) зависит от контекста IL.07.1 в ScrollBox.js/Chat.js — нельзя удалить из серии |
| 24-fs-footer-bottom | IL.05.1-fs-footer-bottom | live | fullscreen: пустота под статус-баром (root flex-end) | С: fullscreen-синтетика w40×120; inline-среда юзера |
| 25-fs-height-stable | IL.06.1-fs-height-stable | live | slack-полоса стабильна: contentJustify (переписал 23) | С: как 24; ослабил 01 |
| 26-scroll-menu-nogap | PI.03.1-scroll-menu-nogap | live | меню помощи без пустой строки (marginBottom снят) | PromptInput.js:2422 |
| 26b-scroll-menu-nogap | MS.01.1-scroll-menu-nogap | live | спейсеры виртуализации MessageList: per-kind среднее | 3D squash: MS.01.1+2+5+7; поглощены 54/77/79 (MessageList.js exclusive) |
| 27-subagent-visible | TG.09.1-subagent-visible | live | субагенты видны: авто-раскрытие + ◐ + alt+m (чинит 09) | чинит регрессию 09 |
| 28-shimmer-restore | TH.02.1-shimmer-restore | live | прошивка shimmer-ключей тем + parseRGB hex | live: parseRGB hex fix + buildTheme restoreShimmerFirmware — инфра жива |
| 29-powerline-segments | SB.05.1-powerline-segments | live | powerline/fish-статус-ряд: сегменты, клинья, таймер | статика; на 47 кол цепь режется |
| 30-live-anim | EF.01.1-live-anim | live | радужный глиф спиннера (rainbow shimmer) | live: rainbowGlyphColor() вызывается через effectEnabled('spinnerRainbow') в SpinnerGlyph.js; эффект зарегистрирован в animationsMode/effectsCatalog/EffectsPanel |
| 31-appearance-settings | PR.04.1-appearance-settings | live | секция appearance в schemastery-схеме settings |  |
| 32-intro-mount-reanchor | CH.03.1-intro-mount-reanchor | live | intro-панель: invalidate+reanchor первого кадра | закрыл один случай stale-cells (E1-класс) |
| 33-input-breathe | EF.02.1-input-breathe | live | animationsMode.js: гейт эффектов + дыхание рамки | М*: эффект мёртв; модуль = гейт-инфра (40/41/42/46/47) |
| 34-live-panels | EF.03.1-live-panels | live | пульс todo-глифа, мини-бар, дыхание ctx-бара | М*: цвет мёртв; TodoProgressBar структурно заменил ✓ N/M |
| 35-tools-verbs | EF.04.1-tools-verbs | live | глаголы спиннера (verbs-преференсы) + шиммер карточек | М*: шиммер мёртв; verbs-кастомизация жива |
| 36-app-background | TH.03.1-app-background | live | фон TUI из темы: appBackground (env>settings>theme) | юзер #000000 — работает |
| 37-theme-live-preview | TH.01.2-theme-live-preview | live | live-превью тем в /theme (preview/revert ThemeProvider) | R→46: useTheme-квартет чинил стрелки/Esc |
| 38-effects-panel | HB.01.1-effects-panel | live | команда /effects: дашборд эффектов LIVE42 | М*: панель снята 46; entry+effectsPrefs живы; R→52 |
| 39-effects-detail | HB.03.1-effects-detail | live | описания эффектов (каталог) + large-демо | Ж*: живут в хаб-демо 46; E3-часть → 63 |
| 40-glyph-bars | EF.05.1-glyph-bars | live | бары-глифы: градиенты, суб-ячейки, ctxBarMode/cwdMode | М*: градиенты мертвы; ctxBarMode/cwdMode живы |
| 41-tool-progress | EF.06.1-tool-progress | live | ретро-мини-бары прогресса в tool-карточках | live: EF.02.3 (69) зависит от контекста EF.06.1 в animationsMode.js — нельзя удалить из серии |
| 42-sparklines | EF.07.1-sparklines | live | брайль-спарклайны tps/cache — OPT-IN | live: EF.02.3 (69) зависит от контекста EF.07.1 в animationsMode.js — нельзя удалить из серии |
| 43-spinner-catalog | EF.08.1-spinner-catalog | live | каталог 58 стилей спиннеров по местам | юзер задал arrow2 — тикер жив |
| 44-customization-hub | HB.08.1-customization-hub | live | единый хаб кастомизации /effects (hubSections) | live: hubSections.js импортируется Chat.js (hubSectionById); CustomizationHub.js снят 46, но hubSections/appearancePrefs остаются — нельзя удалить |
| 45-status-row-clamp | SB.06.1-status-row-clamp | live | powerline-ряд hard 1-line + truncate сепараторов |  |
| 46-settings-hub | HB.04.1-settings-hub | live | хаб кастомизации внутри /settings (hubSettings) | E3-источник → 63; чинил 37/44 |
| 47-statusbar-blocks | HB.05.1-statusbar-blocks | live | кастомные блоки статус-бара = first-class тумблеры | тяготеет SB; юзер активно пользуется |
| 48-fix-jitter | SB.07.1-fix-jitter | live | футер не меняет высоту: слот height:2 + клэмп веток | K: 02-тост не кламплен (инвариант дыряв) |
| 49-logo-version | ID.02.1-logo-version | live | forkVersion в стартовом логотипе (createRequire/ESM) | git archive-деплей не возил untracked (VM была 52) |
| 50-statusbar-dedup-timer + 51-statusbar-wedge-width | SB.06.2-statusbar-dedup-wedge | live | статус-бар: dedup дубль-pct, таймер-резерв, ключ sparks + D4 склейка/D5 шред — сепаратор flexShrink:0 | 3C squash: SB.06.2+SB.06.3; главный защитник ряда на 47 кол |
| 52-effects-refresh-survive | HB.06.1-effects-refresh-survive | live | /effects-entry выживает refreshCommandList (module-level) | E2 исключён кодом |
| 53-subagent-card-shred | TG.03.1-subagent-card-shred | live | шред карточек субагентов: бюджет заголовка w60 |  |
| 54-streaming-height-stable | MS.01.1-scroll-menu-nogap | absorbed | стриминг-ряды держат высоту (осцилляция B1/B2) | 3D squash → MS.01.1 (MessageList.js exclusive) |
| 55-inline-scrollback-clean + 55b-log-update-resize-inplace | IL.03.1-inline-scrollback-clean | live | inline scrollback clean: пин-флип=ложный resize (E1) + дрейф-захват log-update: resize in-place repaint | 3C squash: IL.03.1+IL.03.2; v4=«55c»: маркер уникален по версии |
| 56-statusbar-minimum-metric | SB.08.1-statusbar-minimum-metric | live | минимум-метрика статус-бара (инвариант 8 канона) |  |
| 57-sync-output-killswitch | TR.02.1-sync-output-killswitch | live | E2 kill-switch sync-пути: DSH_TUI_SYNC_OUTPUT=0 |  |
| 58-compact-phase-visible | PR.02.1-compact-phase-visible | live | компакция-фаза видима в статус-баре |  |
| 59-fork-update-notice-off | ID.03.1-fork-update-notice-off | live | update-notice форка отключён |  |
| 60-wezterm-version-gate | TR.03.1-wezterm-version-gate | live | WezTerm version gate: старые сборки → plain-путь | probe 57+60 GREEN 10/10 |
| 61-geometry-trace-always-on | TR.04.1-geometry-trace-always-on | live | geometry-trace ALWAYS-ON (~/.dsh-tui/trace/) | Upstream: candidate |
| 62-theme-picker-kitty-input | TR.05.1-theme-picker-kitty-input | live | kitty CSI-u: имена спец-клавиш не текут в input |  |
| 63-hub-settings-english | HB.07.1-hub-settings-english | live | весь /settings-хаб на английском (canon §5.4) | E3-фикс |
| 64-theme-preview | TH.01.3-theme-preview | live | живая демо-зона тем в /theme-пикере (v3: compact + FULLSCREEN manifest) | v3 (TG-DSH-PUBLIC-20261017 B): при cols≥60&&rows≥24 весь overlay = манифест темы (6 секций: chat+statusbar+effects+palette+input+code+WCAG-dim), ↑/↓ live-recolor; ниже порога — compact v2 (Termux ≥40col parity); reuse ThemePreview в 72; legacy-шапка ниже |
| 65-settings-effects-explanations | HB.02.1-settings-effects-explanations | live | self-documenting examples в /settings+/effects хабах | новая семья demo-in-hub (прецедент для 72); legacy-шапка ниже |
| 66-animations-boolean-gate | EF.02.2-animations-boolean-gate | live | animations boolean-легаси: схема+нормализатор false→off | моложе рисёча; delta к 33 (EF.02); legacy-шапка ниже |
| 67-scroll-height-stabilize | MS.01.3-scroll-height-stabilize | live | scrollHeight-пила manual-scroll: wheel-гейт у дна | моложе рисёча; K5-линия 26b→54→67; legacy-шапка ниже |
| 76-yoga-insert-invalidate | MS.01.4-yoga-insert-invalidate | live | scrollHeight-пила ±1 (451<->450): инвалидация basis-кэша при insertChild | первый движковый патч (native-ts/yoga-layout); 3D squash: MS.01.4+6+8; поглощены 78/80 (yoga+render exclusive); K5-линия 26b→54→67→76; DEP-3-шапка |
| 77-scroll-extent-streaming-clamp | MS.01.1-scroll-menu-nogap | absorbed | остаточная пила ±1 после 76: streaming→false heightsRef invalidation | 3D squash → MS.01.1 (MessageList.js exclusive); DEP-3-шапка |
| 78-scroll-saw-basis-clamp | MS.01.4-yoga-insert-invalidate | absorbed | остаточная пила 423↔422 после 76/77: extent floor max() не ловил overestimation | 3D squash → MS.01.4 (render-node-to-output.js exclusive); DEP-3-шапка |
| 79-scroll-saw-unmount-capture | MS.01.1-scroll-menu-nogap | absorbed | остаточная пила 418↔417 после 76/77/78: unmount-time height capture (measure effect читает предыдущий layout pass) | 3D squash → MS.01.1 (MessageList.js exclusive); DEP-3-шапка |
| 80-scroll-saw-top-clamp | MS.01.4-yoga-insert-invalidate | absorbed | остаточная пила 70↔69 после 76/77/78/79: getComputedTop rounding child[7] bottomPad spacer h=1 | 3D squash → MS.01.4 (render-node-to-output.js exclusive); rev7 hysteresis threshold=2 gW-only GREEN 20/20 Oct 13; DEP-3-шапка |
| 68-tooltip-inline-gate | IL.04.1-tooltip-inline-gate | live | tooltip-слой fullscreen-only (inline без дубля) | моложе рисёча; классиф. IL (inline-поверхность); legacy-шапка ниже |
| 69-inputborder-breath-optin | EF.02.3-inputborder-breath-optin | live | inputBorderBreath → OPT-IN (full→OFF, custom true→ON) | моложе рисёча; delta к 33 (OPT_IN_EFFECTS); legacy-шапка ниже |
| 70-gap-under-status | IL.03.3-gap-under-status | live | щель под статус-баром: cursor clamp + pin-latch | моложе рисёча; ветвь .3 E1-семьи; log-update-часть absorbed в 55b v2 |
| 71-todo-idle-gate | TG.04.1-todo-idle-gate | live | idle-петля пустого чата: гейт useAnimationFrame | моложе рисёча; GoalTodoPanel-домен |
| 72-hub-theme-demo | HB.02.2-hub-theme-demo | live | демо тем в хабе /settings (строка Theme, ThemePreview) | моложе рисёча; demo-in-hub (прецедент 65); reuse 64; legacy-шапка ниже |
| 73-inline-frame-fullheight | CH.04-inline-frame-fullheight | live | inline-кадр всегда height=terminalRows+flexShrink:0 (Direction A) | TG-DSH-MKS4 баг-2+баг-3; латч pin/unpin инертен к высоте; E1-мех-2 (пин-флип=ложный resize) мёртв; Family CH.04 (CH.03.1 занят 32-intro-mount-reanchor) |
| 74-dim-contrast-floor | TH.04-dim-contrast-floor | live | контраст-пол dim/inactive в ThemedText: flooredInactive ≥5.0:1 (баг-4 + E5) | TG-DSH-MKS4 баг-4: tokyonight inactive 3.47:1 < AA 4.5; dimColor-ветка + resolveColor('inactive'); дефолт-темы не меняются; Family TH.04 (TH.01-03 заняты 12/28/36) |
| 75-inline-chrome-overlay | CH.05-inline-chrome-overlay | live | StickyPromptHeader → absolute-оверлей (position:absolute top:0 + opaque, последний чайлд рут-Box): маунт хрома вне потока кадра, viewport хром-инвариантен | golden-RED scroll_jitter стек 77 (job 024120670464Z: saw_flips=3, sticky_off=75; пила scrollHeight 419↔418 от маунта хедера в фиксированном terminalRows-кадре патча 73); фикс класса «переменный хром в фиксированном кадре = viewport-трэш»; Family CH.05 (CH.01-04 заняты 01/06/32/73); latent same-class: NewMessagesPill |
| TH.05.1-saturation-option | TH.05.1-saturation-option | live | опция насыщенности палитры (muted/moderate/vivid) в /settings с живым демо | rgbToHsl/hslToRgb/adjustSaturation (spinnerUtils); saturationSetting (tuiDisplayPrefs); hub field (hubSettings); SaturationExample (SettingsExamples); buildTheme application point (customTheme); multiplier muted=0.6/moderate=1.0/vivid=1.4; Family TH.05 |
| 81-lazy-hub | HB.08-lazy-hub | live | /settings MCP & Tools section: lazy-config.json → cordis.patch.yml regeneration hub-side | lazyCordis.mjs (new: profileCordisPath/profileLazyConfigPath/readLazyConfig/writeLazyConfig/generateCordisPatch/writeProfileCordisPatch/cycleMode; reuses bin/dsh-setup.js buildCordisPatch/emitDirectEntry/emitLazyEntry logic); hubSettings.js hub-lazy group + LazyToggleEntry/LazySkillsEntry/LazyServerEntry/LazyHintEntry renderers; lazy-skills persists via presetPrefs.js (~/.dsh-tui/agent-preset.json — settings.yaml has NO agent-presets.default field); Family HB.08 |
