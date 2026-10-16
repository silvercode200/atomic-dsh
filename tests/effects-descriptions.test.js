#!/usr/bin/env node
// tests/effects-descriptions.test.js — unit-тесты патча 39 «effects-detail»
// (TG-DSH-TUI-EFFECTS-DESC-20260917): описания эффектов + деталь-блок панели.
//
// Контракт (TDD red, ДО реализации; язык описаний → EN с патча 63 — единый
// язык хаба настроек):
//   1. EFFECT_DESCRIPTIONS: полный маппинг для всех 8 EFFECT_KEYS — непустые
//      строки, описывающие ЧТО эффект делает и ГДЕ в UI живёт;
//   2. getEffectDescription(key): известный ключ → описание; неизвестный →
//      fallback имени ключа + warn (не fatal);
//   3. Деталь-блок панели: рендер EffectsPanel с focusIndex — на экране
//      описание ПОДСВЕЧЕННОЙ строки, увеличенное демо, состояние (on/off)
//      и текущий режим (full/custom/off);
//   4. Деталь-блок меняется при движении фокуса (описания разных строк).
// Запуск: node --test tests/effects-descriptions.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

import { importTuiModule, TUI_BASE } from './tui-base.mjs';

const anim = await importTuiModule('lib/types/animationsMode.js');
const catalog = await importTuiModule('lib/types/effectsCatalog.js');

// --- 1. Полнота маппинга описаний -------------------------------------------

test('EFFECT_DESCRIPTIONS: полный маппинг всех EFFECT_KEYS реестра', () => {
    assert.ok(catalog.EFFECT_DESCRIPTIONS && typeof catalog.EFFECT_DESCRIPTIONS === 'object');
    for (const key of anim.EFFECT_KEYS) {
        assert.ok(key in catalog.EFFECT_DESCRIPTIONS, `нет описания: ${key}`);
    }
    // dsh-overrides 40/41/42: реестр расширен до 14 (+ sparklines).
    assert.strictEqual(anim.EFFECT_KEYS.length, 14);
});

test('EFFECT_DESCRIPTIONS: непустые строки с содержанием (что + где)', () => {
    for (const key of anim.EFFECT_KEYS) {
        const text = catalog.EFFECT_DESCRIPTIONS[key];
        assert.strictEqual(typeof text, 'string', key);
        assert.ok(text.trim().length >= 20, `${key}: слишком коротко (${text.length})`);
        // описание говорит о месте в UI: input border / todo panel / status
        // row / card / spinner / header / context bar (EN-хаб, патч 63)
        assert.ok(/border|input|todo|status|card|spinner|verb|header|panel|context|row|bar|progress/i.test(text),
            `${key}: нет указания где живёт`);
    }
});

test('EFFECT_DESCRIPTIONS: описания различаются между ключами', () => {
    const texts = anim.EFFECT_KEYS.map(k => catalog.EFFECT_DESCRIPTIONS[k].trim());
    assert.strictEqual(new Set(texts).size, anim.EFFECT_KEYS.length);
});

// --- 2. Геттер с fallback/warn ----------------------------------------------

test('getEffectDescription: известный ключ → описание', () => {
    assert.strictEqual(
        catalog.getEffectDescription('inputBorderBreath'),
        catalog.EFFECT_DESCRIPTIONS['inputBorderBreath']);
});

test('getEffectDescription: неизвестный ключ → fallback имени + warn (не fatal)', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
        const result = catalog.getEffectDescription('nonexistent-effect');
        assert.strictEqual(result, 'nonexistent-effect');
        assert.ok(warnings.some(w => w.includes('nonexistent-effect')), 'warn не вызван');
    } finally {
        console.warn = origWarn;
    }
});

// --- 3/4. Деталь-блок панели (headless render) -------------------------------

const LIB = realpathSync(TUI_BASE + '/lib/types');
const require = createRequire(realpathSync(LIB + '/components/GoalTodoPanel.js'));
const React = require('react');
const { renderSync } = await import(LIB + '/ink/root.js');
const { ThemeProvider } = await import(LIB + '/ui.js');
const { EffectsPanel } = await importTuiModule('lib/types/components/EffectsPanel.js');

const ANSI = /(?:\x1B\][^\x07]*(?:\07|\x1B\\))|\x1B\[[0-9;?]*[a-zA-Z]|\x1B[()][0-9A-B]|\r/g;
async function renderPanel(focusIndex, ms = 250) {
    const stdout = new PassThrough();
    stdout.columns = 120; stdout.rows = 40;
    let raw = '';
    stdout.on('data', d => { raw += d.toString(); });
    const inst = renderSync(
        React.createElement(ThemeProvider, { theme: 'tokyonight-moon' },
            React.createElement(EffectsPanel, { focusIndex, onToggle: undefined })),
        { stdout, exitOnCtrlC: false, patchConsole: false });
    await new Promise(r => setTimeout(r, ms));
    inst.unmount();
    return { raw, screen: raw.replace(ANSI, '') };
}

test('деталь-блок: описание подсвеченной строки на экране', async () => {
    const { screen } = await renderPanel(0);
    const desc = catalog.EFFECT_DESCRIPTIONS['inputBorderBreath'];
    // описание может переноситься — проверяем первые 30 символов
    assert.ok(screen.includes(desc.slice(0, 30).replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ')),
        'описание inputBorderBreath не найдено на экране');
});

test('деталь-блок: описание меняется при движении фокуса', async () => {
    const first = await renderPanel(0);
    const second = await renderPanel(1);
    const d0 = catalog.EFFECT_DESCRIPTIONS['inputBorderBreath'];
    const d1 = catalog.EFFECT_DESCRIPTIONS['todoPulse'];
    assert.ok(first.screen.includes(d0.slice(0, 15)), 'desc[0] нет при focusIndex=0');
    assert.ok(second.screen.includes(d1.slice(0, 15)), 'desc[1] нет при focusIndex=1');
    assert.ok(!second.screen.includes(d0.slice(0, 15)), 'desc[0] остался при focusIndex=1');
});

test('деталь-блок: состояние и режим видны', async () => {
    const { screen } = await renderPanel(0);
    assert.ok(/режим/i.test(screen) || /mode/i.test(screen), 'режим не показан');
    assert.ok(/\bon\b|\boff\b/i.test(screen), 'on/off не показан');
});
