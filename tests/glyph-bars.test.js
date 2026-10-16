#!/usr/bin/env node
// tests/glyph-bars.test.js — unit-тесты патча 40 «glyph-bars»
// (TG-DSH-TUI-HUB-20260918, узел 1): градиент заголовков, суб-ячеечные бары,
// градиентный fill + режимы ctx-бара (узкий/percent-only).
//
// Контракт (TDD red, ДО реализации):
//   1. EFFECT_KEYS +3: headerTextGradient, subCellBars, barGradientFill
//      (default ON в full, opt-out в custom);
//   2. gradientText(word, time, base, highlight): посимвольная интерполяция
//      по времени — фаза t=0 вся base, t=period/2 вся highlight, фазы
//      различаются; ANSI-цвета меняются вдоль слова;
//   3. subCells(fraction, cells): восьмые доли ▏▎▍▌▋▊▉ — дробная ячейка на
//      конце, полнота = cells, инвариант fill+track = cells;
//   4. gradientBarFill(fillCount, cells, base, highlight, phase):
//      цвет fill меняется вдоль бара (первая ячейка ≈ base, последняя ≈
//      ближе к highlight);
//   5. normalizeCtxBarMode: 'full' (6 клеток, дефолт) | 'narrow' (3) |
//      'percent-only' (без бара) — из statusBar.ctxBarMode; невалидное
//      → undefined (дефолт full).
// Запуск: node --test tests/glyph-bars.test.js

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { importTuiModule } from './tui-base.mjs';

const anim = await importTuiModule('lib/types/animationsMode.js');
const prefs = await importTuiModule('lib/types/tuiDisplayPrefs.js');

beforeEach(() => {
    delete process.env.DSH_TUI_ANIMATIONS;
    delete process.env.DSH_TUI_REDUCED_MOTION;
    anim.setAnimationsMode(undefined);
    anim.setEffectsMode(undefined);
});

// --- 1. Реестр: +3 ключа ------------------------------------------------------

test('EFFECT_KEYS: +3 новых ключа волны glyph-bars', () => {
    for (const key of ['headerTextGradient', 'subCellBars', 'barGradientFill']) {
        assert.ok(anim.EFFECT_KEYS.includes(key), key);
    }
    assert.strictEqual(anim.EFFECT_KEYS.length, 14); // 40/41/42 расширили реестр
});

test('новые эффекты: default ON в full, opt-out в custom', () => {
    anim.setAnimationsMode('full');
    assert.strictEqual(anim.effectEnabled('headerTextGradient'), true);
    assert.strictEqual(anim.effectEnabled('subCellBars'), true);
    assert.strictEqual(anim.effectEnabled('barGradientFill'), true);
    anim.setAnimationsMode('custom');
    assert.strictEqual(anim.effectEnabled('headerTextGradient'), true); // unset = on
    anim.setEffectsMode({ headerTextGradient: false, subCellBars: false, barGradientFill: false });
    assert.strictEqual(anim.effectEnabled('headerTextGradient'), false);
    assert.strictEqual(anim.effectEnabled('subCellBars'), false);
    assert.strictEqual(anim.effectEnabled('barGradientFill'), false);
});

// --- 2. Градиент заголовков ---------------------------------------------------

test('gradientText: фазы по времени — t=0 вся base, t=P/2 вся highlight', () => {
    const fn = anim.gradientText;
    assert.strictEqual(typeof fn, 'function');
    const base = { r: 100, g: 100, b: 100 };
    const highlight = { r: 200, g: 200, b: 200 };
    const word = 'заголовок панели';
    const P = 2400;
    // t=0: каждый сегмент ≈ base
    const zero = fn(word, 0, base, highlight, P);
    assert.match(zero, /38;2;10[01];10[01];10[01]m/);
    // t=P/2: фронт прошёл слово — ПЕРВЫЙ сегмент тоже ≈ highlight
    const mid = fn(word, P / 2, base, highlight, P);
    assert.match(mid.slice(0, 24), /38;2;(19[89]|200);(19[89]|200);(19[89]|200)m/);
});

test('gradientText: ANSI-цвета различаются вдоль слова (градиент)', () => {
    const base = { r: 80, g: 80, b: 80 };
    const highlight = { r: 220, g: 220, b: 220 };
    const word = 'заголовок панели задач';
    const out = anim.gradientText(word, 600, base, highlight, 2400);
    const colors = [...out.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].map(m => +m[1]);
    assert.ok(colors.length >= 5, `сегментов ${colors.length}`);
    const uniq = new Set(colors);
    assert.ok(uniq.size >= 3, `уникальных цветов ${uniq.size}`);
});

test('gradientText: фазы кадра различаются (анимация жива)', () => {
    const base = { r: 80, g: 80, b: 80 };
    const highlight = { r: 220, g: 220, b: 220 };
    const word = 'заголовок';
    const a = anim.gradientText(word, 300, base, highlight, 2400);
    const b = anim.gradientText(word, 1500, base, highlight, 2400);
    assert.notStrictEqual(a, b);
});

// --- 3. Суб-ячеечные бары -----------------------------------------------------

test('subCells: восьмые доли, полнота и инвариант длины', () => {
    const fn = prefs.subCells;
    assert.strictEqual(typeof fn, 'function');
    // 0 → пусто
    assert.deepStrictEqual(fn(0, 6), { fill: '', track: '······' });
    // 1.0 → полный
    assert.deepStrictEqual(fn(1, 6), { fill: '██████', track: '' });
    // 0.5 от 6 клеток → 3 полных
    const half = fn(0.5, 6);
    assert.strictEqual(half.fill, '███');
    assert.strictEqual(half.track, '···');
    // дробная ячейка: 0.25 от 4 клеток = 1.0 ячейки → 1 полная + 0
    // 0.375 от 4 = 1.5 → 1 полная + ▌ (половина)
    const frac = fn(0.375, 4);
    assert.strictEqual(frac.fill, '█▌');
    assert.strictEqual(frac.fill.length + frac.track.length, 4);
    // 0.1 от 4 = 0.4 ячейки = 3.2/8 → ▍ (3/8)
    const small = fn(0.1, 4);
    assert.strictEqual(small.fill, '▍');
    assert.strictEqual(small.fill.length + small.track.length, 4);
    // дегенераты
    assert.deepStrictEqual(fn(-0.5, 6), { fill: '', track: '······' });
    assert.deepStrictEqual(fn(1.5, 6), { fill: '██████', track: '' });
    assert.deepStrictEqual(fn(0.5, 0), { fill: '', track: '' });
});

// --- 4. Градиентный fill бара -------------------------------------------------

test('gradientBarFill: цвета вдоль бара интерполируются base→highlight', () => {
    const fn = anim.gradientBarFill;
    assert.strictEqual(typeof fn, 'function');
    const base = { r: 100, g: 100, b: 100 };
    const highlight = { r: 200, g: 200, b: 200 };
    const cells = fn(6, base, highlight, 0.5);
    // каждая ячейка — строка-глиф с rgb-цветом
    assert.strictEqual(cells.length, 6);
    const rs = cells.map(c => { const m = /38;2;(\d+);/.exec(c); return m ? +m[1] : -1; });
    assert.ok(rs.every(r => r >= 0), 'каждая ячейка окрашена');
    // монотонный рост от base к highlight вдоль бара при фазе 0.5
    assert.ok(rs[0] < rs[rs.length - 1], `первая ${rs[0]} < последней ${rs[rs.length - 1]}`);
    assert.ok(rs.every(r => r >= 100 && r <= 200), 'внутри пары');
});

test('gradientBarFill: фаза 0 = весь base, фаза 1 = полный градиент вдоль', () => {
    const base = { r: 100, g: 100, b: 100 };
    const highlight = { r: 200, g: 200, b: 200 };
    const at0 = anim.gradientBarFill(4, base, highlight, 0);
    assert.ok(at0.every(c => /38;2;100;100;100m/.test(c)), 'фаза 0 — весь base');
    const at1 = anim.gradientBarFill(4, base, highlight, 1);
    assert.ok(/38;2;100;100;100m/.test(at1[0]), 'первая ≈ base');
    assert.ok(/38;2;200;200;200m/.test(at1[at1.length - 1]), 'последняя ≈ highlight');
});

// --- 5. Режимы ctx-бара -------------------------------------------------------

test('normalizeCtxBarMode: full | narrow | percent-only, мусор → undefined', () => {
    assert.strictEqual(prefs.normalizeCtxBarMode('full'), 'full');
    assert.strictEqual(prefs.normalizeCtxBarMode('narrow'), 'narrow');
    assert.strictEqual(prefs.normalizeCtxBarMode('percent-only'), 'percent-only');
    assert.strictEqual(prefs.normalizeCtxBarMode('bogus'), undefined);
    assert.strictEqual(prefs.normalizeCtxBarMode(''), undefined);
    assert.strictEqual(prefs.normalizeCtxBarMode(undefined), undefined);
    assert.strictEqual(prefs.normalizeCtxBarMode(5), undefined);
});

test('normalizeStatusBar: принимает ctxBarMode (с валидацией)', () => {
    const sb = prefs.normalizeStatusBar({ ctxBarMode: 'narrow' });
    assert.strictEqual(sb.ctxBarMode, 'narrow');
    const bad = prefs.normalizeStatusBar({ ctxBarMode: 'nope' });
    assert.strictEqual(bad.ctxBarMode, 'full'); // невалидное → дефолт (merge-семантика)
    const def = prefs.normalizeStatusBar({});
    assert.strictEqual(def.ctxBarMode, 'full'); // merge-дефолт
});

// --- 6. cwdMode (дельта 1) ----------------------------------------------------

test('normalizeCwdMode: full | compact, мусор → undefined', () => {
    assert.strictEqual(prefs.normalizeCwdMode('full'), 'full');
    assert.strictEqual(prefs.normalizeCwdMode('compact'), 'compact');
    assert.strictEqual(prefs.normalizeCwdMode('bogus'), undefined);
    assert.strictEqual(prefs.normalizeCwdMode(undefined), undefined);
});

test('compactCwd: последний сегмент пути', () => {
    assert.strictEqual(prefs.compactCwd('~/…/deepseek_harness'), 'deepseek_harness');
    assert.strictEqual(prefs.compactCwd('/home/user/project'), 'project');
    assert.strictEqual(prefs.compactCwd('bare'), 'bare');
    assert.strictEqual(prefs.compactCwd(''), '');
    assert.strictEqual(prefs.compactCwd(undefined), undefined);
});

test('normalizeAppearance: принимает cwdMode (дельта 1)', () => {
    const n = prefs.normalizeAppearance({ cwdMode: 'compact' });
    assert.strictEqual(n.cwdMode, 'compact');
    assert.strictEqual(prefs.normalizeAppearance({ cwdMode: 'nope' }).cwdMode, undefined);
    assert.strictEqual(prefs.normalizeAppearance({}).cwdMode, undefined);
});
