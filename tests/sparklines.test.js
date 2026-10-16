#!/usr/bin/env node
// tests/sparklines.test.js — unit-тесты патча 42 «sparklines» (узел 3
// TG-DSH-TUI-HUB-20260918): braille-спарклайны скорости и % кеша.
//
// КОНТРАКТ (TDD red):
//   1. sparkline(values, width): braille-глифы ⡀⠁⠂⠄⡀⣿ (2x4 точки) —
//      миниатюрный график; пустые значения → пустая строка; все равные →
//      плоская линия; растущий ряд имеет глифы выше к концу;
//   2. pushSample(buffer, value, max): кольцевой буфер истории (N значений);
//   3. cacheHitPct(usage): (cacheRead / (input + cacheRead + cacheWrite)) * 100
//      — undefined если полей нет (не врём нулём!);
//   4. реестр: sparkTps + sparkCache ключи — OPT-OUT семантика НЕ подходит:
//      эти эффекты ОПТ-ИН (default OFF в full!) — отдельная проверка
//      sparklineEnabled(key): full → false, custom + effects {key: true} → true.
//   5. normalizeSparklines: appearance.sparklines {tps: bool, cache: bool}
//      — только custom-слой.
// Запуск: node --test tests/sparklines.test.js

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { importTuiModule } from './tui-base.mjs';

const anim = await importTuiModule('lib/types/animationsMode.js');
const prefs = await importTuiModule('lib/types/tuiDisplayPrefs.js');
const spark = await importTuiModule('lib/types/sparkline.js');

beforeEach(() => {
    delete process.env.DSH_TUI_ANIMATIONS;
    delete process.env.DSH_TUI_REDUCED_MOTION;
    anim.setAnimationsMode(undefined);
    anim.setEffectsMode(undefined);
});

// --- 1. braille-рендер ---------------------------------------------------------

test('sparkline: braille-глифы, пустые значения → пусто', () => {
    assert.strictEqual(spark.sparkline([], 10), '');
    assert.strictEqual(spark.sparkline(undefined, 10), '');
});

test('sparkline: плоский ряд — одна высота', () => {
    const out = spark.sparkline([5, 5, 5, 5, 5, 5, 5, 5], 4);
    assert.strictEqual(typeof out, 'string');
    assert.ok(out.length > 0 && out.length <= 8);
    // все глифы одинаковые
    assert.strictEqual(new Set([...out]).size, 1);
});

test('sparkline: растущий ряд — глифы становятся выше', () => {
    const rising = spark.sparkline([1, 2, 3, 4, 5, 6, 7, 8], 4);
    const falling = spark.sparkline([8, 7, 6, 5, 4, 3, 2, 1], 4);
    assert.notStrictEqual(rising, falling);
    // braille-высота глифа растёт: код первого глифа rising меньше последнего
    const cp = s => [...s].map(c => c.codePointAt(0));
    const r = cp(rising);
    assert.ok(r[0] < r[r.length - 1], `первый ${r[0].toString(16)} < последнего ${r[r.length - 1].toString(16)}`);
});

test('sparkline: ширина respected (глифов ≤ width)', () => {
    const out = spark.sparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 5);
    assert.ok([...out].length <= 5, [...out].length);
});

// --- 2. кольцевой буфер --------------------------------------------------------

test('pushSample: кольцевой буфер max N', () => {
    let buf = spark.newBuffer(4);
    for (const v of [1, 2, 3, 4, 5, 6]) buf = spark.pushSample(buf, v);
    assert.deepStrictEqual(buf.values, [3, 4, 5, 6]);
    // NaN/undefined не пушатся
    buf = spark.pushSample(buf, Number.NaN);
    assert.deepStrictEqual(buf.values, [3, 4, 5, 6]);
});

// --- 3. cache hit --------------------------------------------------------------

test('cacheHitPct: доля cacheRead; нет полей → undefined (не врём)', () => {
    const pct = spark.cacheHitPct({ input: 5200, cacheRead: 71000, cacheWrite: 10000 });
    assert.strictEqual(Math.round(pct), 82); // 71000 / 86200 ≈ 82.4
    assert.strictEqual(spark.cacheHitPct({ input: 100 }), undefined);
    assert.strictEqual(spark.cacheHitPct(undefined), undefined);
    assert.strictEqual(spark.cacheHitPct({ input: 100, cacheRead: 0, cacheWrite: 0 }), 0);
});

// --- 4. опт-ин семантика -------------------------------------------------------

test('sparkTps/sparkCache в реестре, но OPT-IN: full → OFF', () => {
    assert.ok(anim.EFFECT_KEYS.includes('sparkTps'));
    assert.ok(anim.EFFECT_KEYS.includes('sparkCache'));
    anim.setAnimationsMode('full');
    assert.strictEqual(anim.effectEnabled('sparkTps'), false);
    assert.strictEqual(anim.effectEnabled('sparkCache'), false);
});

test('custom + явное включение → ON', () => {
    anim.setAnimationsMode('custom');
    anim.setEffectsMode({ sparkTps: true, sparkCache: true });
    assert.strictEqual(anim.effectEnabled('sparkTps'), true);
    assert.strictEqual(anim.effectEnabled('sparkCache'), true);
    // без явного — OFF (opt-in!)
    anim.setEffectsMode(undefined);
    assert.strictEqual(anim.effectEnabled('sparkTps'), false);
});

// --- 5. настройка --------------------------------------------------------------

test('normalizeSparklines: {tps, cache} bools, мусор → undefined', () => {
    assert.deepStrictEqual(prefs.normalizeSparklines({ tps: true, cache: false }), { tps: true, cache: false });
    assert.strictEqual(prefs.normalizeSparklines(undefined), undefined);
    assert.strictEqual(prefs.normalizeSparklines({}), undefined);
    assert.strictEqual(prefs.normalizeSparklines({ tps: 'yes' }), undefined);
    assert.deepStrictEqual(prefs.normalizeSparklines({ tps: true }), { tps: true, cache: false });
});
