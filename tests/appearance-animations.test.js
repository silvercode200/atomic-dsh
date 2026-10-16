#!/usr/bin/env node
// tests/appearance-animations.test.js — unit-тесты волны LIVE42 (узел 1):
// гейт appearance.animations full|custom|off + реестр эффектов effects +
// дыхание рамки + firmware todoActiveShimmer (патчи 33/34/35),
// TG-DSH-TUI-LIVE-20260917.
//
// Контракт (зафиксирован ДО реализации — TDD red):
//   режим:  env DSH_TUI_ANIMATIONS > settings appearance.animations > 'full';
//           full = все эффекты on; off = все off;
//           custom = точечно: appearance.effects {<ключ>: bool}, незаданный
//           ключ = true (opt-out по отдельности).
//   эффекты (реестр EFFECT_KEYS): inputBorderBreath, todoPulse,
//           todoProgressBar, headerGlimmer, ctxBarBreath, toolCardShimmer,
//           spinnerRainbow, spinnerGlimmer.
//   reduce:  DSH_TUI_REDUCED_MOTION=1 гасит ВСЁ поверх любого режима.
// dsh-overrides 66 (TG-DSH-VISUAL-20260925): appearance.animations
//   принимает и boolean — легаси-форма ручки из settings.yaml юзера
//   (`animations: false`): false→'off', true→'full'; числа/null/
//   undefined остаются dead key (undefined).
// dsh-overrides 69 (TG-DSH-HANDOFF-20260926): inputBorderBreath — OPT-IN
//   (механизм 42, как sparkTps/sparkCache): full его НЕ включает, custom —
//   только явным true. Юзер просил убрать «дыхание» рамки навсегда, даже
//   при включённых анимациях («выглядит стремно»).
// Запуск: node --test tests/appearance-animations.test.js
//   (цель пакета — env TUI_BASE, по умолчанию live-профиль)

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { importTuiModule } from './tui-base.mjs';

const prefs = await importTuiModule('lib/types/tuiDisplayPrefs.js');
const anim = await importTuiModule('lib/types/animationsMode.js');
const customTheme = await importTuiModule('lib/types/customTheme.js');

beforeEach(() => {
    delete process.env.DSH_TUI_ANIMATIONS;
    delete process.env.DSH_TUI_REDUCED_MOTION;
    anim.setAnimationsMode(undefined);
    anim.setEffectsMode(undefined);
});

// --- нормализация режима + реестра эффектов из settings ----------------------

test('normalizeAnimationsStyle: enum full|custom|off; boolean-легаси 66; остальное → undefined', () => {
    assert.strictEqual(prefs.normalizeAnimationsStyle('full'), 'full');
    assert.strictEqual(prefs.normalizeAnimationsStyle('custom'), 'custom');
    assert.strictEqual(prefs.normalizeAnimationsStyle('off'), 'off');
    // dsh-overrides 66: юзер пишет `animations: false` (boolean) — это
    // легаси-форма ручки, НЕ dead key: false гасит волну, true = full.
    assert.strictEqual(prefs.normalizeAnimationsStyle(false), 'off');
    assert.strictEqual(prefs.normalizeAnimationsStyle(true), 'full');
    // остальное по-прежнему dead key (масштаб контракта 66 — только boolean)
    assert.strictEqual(prefs.normalizeAnimationsStyle('FULL'), undefined);
    assert.strictEqual(prefs.normalizeAnimationsStyle(''), undefined);
    assert.strictEqual(prefs.normalizeAnimationsStyle(undefined), undefined);
    assert.strictEqual(prefs.normalizeAnimationsStyle(null), undefined);
    assert.strictEqual(prefs.normalizeAnimationsStyle(5), undefined);
    assert.strictEqual(prefs.normalizeAnimationsStyle(0), undefined);
});

test('normalizeAppearance: принимает animations и effects в секции appearance', () => {
    const n = prefs.normalizeAppearance({
        animations: 'custom',
        effects: { inputBorderBreath: false, todoPulse: true, bogus: false },
    });
    assert.strictEqual(n.animations, 'custom');
    assert.deepStrictEqual(n.effects, { inputBorderBreath: false, todoPulse: true });
    const d = prefs.normalizeAppearance({});
    assert.strictEqual(d.animations, undefined);
    assert.deepStrictEqual(d.effects, {});
    const bad = prefs.normalizeAppearance({ animations: 'nope', effects: 'x' });
    assert.strictEqual(bad.animations, undefined);
    assert.deepStrictEqual(bad.effects, {});
});

test('normalizeAppearance: boolean animations гасит/включает волну (dsh-overrides 66)', () => {
    // юзерский settings.yaml `dsh-tui.appearance.animations: false` (boolean)
    // раньше падал в undefined → режим 'full' → рамка ввода дышала (репорт
    // 2026-09-25 «рамка как мигала так и мигает»). Контракт 66: boolean
    // маппится, числа/мусор — dead key как раньше.
    assert.strictEqual(prefs.normalizeAppearance({ animations: false }).animations, 'off');
    assert.strictEqual(prefs.normalizeAppearance({ animations: true }).animations, 'full');
    // строковый канон не сломан
    assert.strictEqual(prefs.normalizeAppearance({ animations: 'off' }).animations, 'off');
    assert.strictEqual(prefs.normalizeAppearance({ animations: 'custom' }).animations, 'custom');
    // остальное — dead key (контракт меняется ТОЛЬКО для boolean)
    assert.strictEqual(prefs.normalizeAppearance({ animations: 5 }).animations, undefined);
    assert.strictEqual(prefs.normalizeAppearance({ animations: null }).animations, undefined);
});

test('animationsSetting: boolean-легаси проходит schema-границу и не роняет секцию (dsh-overrides 66)', () => {
    // Root-cause 2026-09-25 (VM-реплика golden68-run1): схема настроек
    // `Schema.union(['full','custom','off'])` БРОСАЛА ValidationError на
    // boolean → вся секция dsh-tui не резолвилась («keeps the last good
    // section») → fullscreen: false терялся → fullscreen-бут из
    // cordis.patch.yml + дефолт-статусбар. Нормализатор патча 66 не
    // выполнялся вовсе — секция умирала ДО него. Фикс: settings-поле
    // принимает boolean и маппит его НА ГРАНИЦЕ (false→'off', true→'full')
    // через тот же normalizeAnimationsStyle.
    const setting = prefs.animationsSetting;
    assert.strictEqual(typeof setting, 'function', 'settings-поле экспортировано из tuiDisplayPrefs');
    // boolean-легаси резолвится в enum (раньше: throw → секция отвергнута)
    assert.strictEqual(setting(false), 'off');
    assert.strictEqual(setting(true), 'full');
    // строковый канон не сломан
    assert.strictEqual(setting('full'), 'full');
    assert.strictEqual(setting('custom'), 'custom');
    assert.strictEqual(setting('off'), 'off');
    // мусор по-прежнему невалиден — контракт меняется ТОЛЬКО для boolean
    assert.throws(() => setting(5));
    assert.throws(() => setting('FULL'));
    assert.throws(() => setting('yes'));
});

test('EFFECT_KEYS: реестр эффектов волны (включая спиннер 28/30 + glyph-bars 40)', () => {
    assert.ok(Array.isArray(anim.EFFECT_KEYS));
    for (const key of ['inputBorderBreath', 'todoPulse', 'todoProgressBar', 'headerGlimmer',
        'ctxBarBreath', 'toolCardShimmer', 'spinnerRainbow', 'spinnerGlimmer',
        'headerTextGradient', 'subCellBars', 'barGradientFill']) {
        assert.ok(anim.EFFECT_KEYS.includes(key), key);
    }
    // dsh-overrides 40/41/42 расширили реестр 8 → 14; фиксируем текущую длину.
    assert.strictEqual(anim.EFFECT_KEYS.length, 14);
});

// --- режим: модуль animationsMode (процесс-уровень, как minimalMode) ---------

test('режим full/дефолт: обычные эффекты включены, opt-in — нет', () => {
    // dsh-overrides 69: inputBorderBreath теперь OPT-IN — full его НЕ
    // включает (юзер просил убрать «дыхание» рамки навсегда).
    assert.strictEqual(anim.effectEnabled('inputBorderBreath'), false);
    assert.strictEqual(anim.effectEnabled('spinnerRainbow'), true);
    anim.setAnimationsMode('full');
    assert.strictEqual(anim.effectEnabled('ctxBarBreath'), true);
    assert.strictEqual(anim.effectEnabled('inputBorderBreath'), false);
});

test('режим off: ВСЕ эффекты выключены', () => {
    anim.setAnimationsMode('off');
    for (const key of anim.EFFECT_KEYS)
        assert.strictEqual(anim.effectEnabled(key), false, key);
});

test('режим custom: точечный opt-out, незаданный ключ = true', () => {
    anim.setAnimationsMode('custom');
    anim.setEffectsMode({ inputBorderBreath: false, todoPulse: false });
    assert.strictEqual(anim.effectEnabled('inputBorderBreath'), false);
    assert.strictEqual(anim.effectEnabled('todoPulse'), false);
    assert.strictEqual(anim.effectEnabled('todoProgressBar'), true);  // unset = on
    assert.strictEqual(anim.effectEnabled('spinnerRainbow'), true);
    assert.strictEqual(anim.effectEnabled('headerGlimmer'), true);
});

test('custom с мусорными ключами: bool-значения читаются, остальное игнорируется', () => {
    anim.setAnimationsMode('custom');
    anim.setEffectsMode({ ctxBarBreath: false, bogus: true, todoPulse: 'yes' });
    assert.strictEqual(anim.effectEnabled('ctxBarBreath'), false);
    assert.strictEqual(anim.effectEnabled('todoPulse'), true); // 'yes' не bool → unset
    assert.strictEqual(anim.effectEnabled('bogus' in anim.EFFECT_KEYS ? 'bogus' : 'toolCardShimmer'), true);
});

test('custom без effects-объекта: обычные эффекты on, opt-in — off', () => {
    anim.setAnimationsMode('custom');
    // dsh-overrides 69: opt-in ключ без явного true — off
    assert.strictEqual(anim.effectEnabled('inputBorderBreath'), false);
    assert.strictEqual(anim.effectEnabled('todoPulse'), true);
});

test('dsh-overrides 69: inputBorderBreath opt-in — full off, custom только явным true', () => {
    // юзер-запрос 2026-09-26: «рамка ввода мигает/дышит — выглядит стремно,
    // убрать навсегда, даже при включённых анимациях». Ключ переведён в
    // OPT_IN_EFFECTS (механизм 42): full → off; custom без ключа → off;
    // custom true → on; custom false → off.
    anim.setAnimationsMode('full');
    assert.strictEqual(anim.effectEnabled('inputBorderBreath'), false);
    anim.setAnimationsMode('custom');
    assert.strictEqual(anim.effectEnabled('inputBorderBreath'), false);
    anim.setEffectsMode({ inputBorderBreath: true });
    assert.strictEqual(anim.effectEnabled('inputBorderBreath'), true);
    anim.setEffectsMode({ inputBorderBreath: false });
    assert.strictEqual(anim.effectEnabled('inputBorderBreath'), false);
});

test('env DSH_TUI_ANIMATIONS выше settings-режима', () => {
    anim.setAnimationsMode('off');
    process.env.DSH_TUI_ANIMATIONS = 'full';
    assert.strictEqual(anim.effectEnabled('todoPulse'), true);
    process.env.DSH_TUI_ANIMATIONS = 'custom';
    anim.setEffectsMode({ toolCardShimmer: false });
    assert.strictEqual(anim.effectEnabled('toolCardShimmer'), false);
    assert.strictEqual(anim.effectEnabled('todoPulse'), true); // custom через env
    delete process.env.DSH_TUI_ANIMATIONS;
    assert.strictEqual(anim.effectEnabled('todoPulse'), false); // settings off вернулся
});

test('DSH_TUI_REDUCED_MOTION=1 гасит всё поверх любого режима', () => {
    process.env.DSH_TUI_REDUCED_MOTION = '1';
    anim.setAnimationsMode('full');
    assert.strictEqual(anim.effectEnabled('inputBorderBreath'), false);
    anim.setAnimationsMode('custom');
    assert.strictEqual(anim.effectEnabled('spinnerGlimmer'), false);
    process.env.DSH_TUI_ANIMATIONS = 'full';
    assert.strictEqual(anim.effectEnabled('todoPulse'), false); // env не пробивает reduce
});

test('невалидный setAnimationsMode → дефолт (не глушит)', () => {
    anim.setAnimationsMode('bogus');
    assert.strictEqual(anim.effectEnabled('todoPulse'), true);
    anim.setAnimationsMode(undefined);
    assert.strictEqual(anim.effectEnabled('todoPulse'), true);
});

// --- дыхание рамки: чистая функция цвета --------------------------------------

test('breathingColor: косинус-интерполяция base↔highlight по периоду', () => {
    const base = { r: 85, g: 96, b: 111 };        // promptBorder (#55606F)
    const highlight = { r: 122, g: 162, b: 247 };
    const period = 2400;
    const at = t => anim.breathingColor(base, highlight, t, period);
    const start = at(0);
    assert.match(start, /^rgb\(/);
    const parse = s => { const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s); return { r: +m[1], g: +m[2], b: +m[3] }; };
    const dist = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    // t=period/2 — на highlight
    assert.ok(dist(parse(at(period / 2)), highlight) < dist(parse(start), highlight),
        'mid ближе к highlight, чем start');
    // периодичность
    assert.strictEqual(at(period), start);
    // середина четверти — между парой
    const q = parse(at(period / 4));
    assert.ok(q.r >= base.r - 1 && q.r <= highlight.r + 1);
});

test('breathingColor: одинаковое t/period — одинаковый цвет при любом периоде', () => {
    const base = { r: 0, g: 0, b: 0 };
    const highlight = { r: 100, g: 100, b: 100 };
    assert.strictEqual(
        anim.breathingColor(base, highlight, 1200, 2400),
        anim.breathingColor(base, highlight, 600, 1200));
});

// --- firmware: todoActiveShimmer защищён от перекраски темой -----------------

test('SHIMMER_FIRMWARE_KEYS экспортирован и содержит todoActiveShimmer', () => {
    assert.ok(Array.isArray(customTheme.SHIMMER_FIRMWARE_KEYS));
    assert.ok(customTheme.SHIMMER_FIRMWARE_KEYS.includes('todoActiveShimmer'));
    assert.ok(customTheme.SHIMMER_FIRMWARE_KEYS.includes('claudeShimmer')); // патч 28 цел
});

test('buildTheme: тема НЕ может перекрасить todoActiveShimmer (прошивка)', () => {
    const spec = {
        name: 'pulse-override', displayName: 'pulse-override', base: 'dark',
        colors: { todoActiveShimmer: '#ff0000', text: '#ABCDEF' },
    };
    const merged = customTheme.buildTheme(spec);
    assert.notStrictEqual(merged.todoActiveShimmer, '#ff0000');
    assert.ok(merged.todoActiveShimmer !== undefined, 'ключ есть в базовой палитре');
    assert.strictEqual(merged.text, '#ABCDEF'); // остальное тема красит свободно
    process.env.DSH_TUI_ALLOW_THEME_SHIMMER = '1';
    try {
        assert.strictEqual(customTheme.buildTheme(spec).todoActiveShimmer, '#ff0000');
    } finally {
        delete process.env.DSH_TUI_ALLOW_THEME_SHIMMER;
    }
});

// --- мини-бар прогресса todo в заголовке --------------------------------------

test('todoProgressCells: бар 5 ячеек по done/total', async () => {
    const gtp = await importTuiModule('lib/types/components/GoalTodoPanel.js');
    assert.strictEqual(typeof gtp.todoProgressCells, 'function');
    assert.strictEqual(gtp.todoProgressCells(0, 5).fill, '');
    assert.strictEqual(gtp.todoProgressCells(0, 5).track.length, 5);
    assert.strictEqual(gtp.todoProgressCells(5, 5).fill.length, 5);
    assert.strictEqual(gtp.todoProgressCells(5, 5).track, '');
    const half = gtp.todoProgressCells(1, 4);
    assert.ok(half.fill.length >= 1 && half.fill.length <= 2, `fill=${half.fill}`);
    assert.strictEqual(half.fill.length + half.track.length, 5);
    assert.strictEqual(gtp.todoProgressCells(0, 0).fill, '');
    assert.strictEqual(gtp.todoProgressCells(0, 0).track.length, 5);
    assert.strictEqual(gtp.todoProgressCells(3, 0).fill, '');
});
