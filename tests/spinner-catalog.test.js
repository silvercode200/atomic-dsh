#!/usr/bin/env node
// tests/spinner-catalog.test.js — unit-тесты патча 43 «spinner-catalog»
// (узел 4 TG-DSH-TUI-HUB-20260918): каталог стилей + выбор по местам.
//
// КОНТРАКТ (TDD red):
//   1. SPINNER_CATALOG: ≥40 стилей, каждый {frames[] (≥3), interval, place};
//      MIT-заголовок в файле;
//   2. getSpinnerStyle: известное имя → entry; '' / мусор → undefined;
//   3. spinnerNamesFor('main'/'subagent'/'toolCard') → непустые списки;
//   4. normalizeSpinnerPrefs: {main, subagent, toolCard} — валидные имена
//      каталога или '' (default); мусор → undefined;
//   5. каденс: интервалы в разумных рамках (10..500ms).
// Запуск: node --test tests/spinner-catalog.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTuiModule } from './tui-base.mjs';

const cat = await importTuiModule('lib/types/spinnerCatalog.js');
const prefs = await importTuiModule('lib/types/tuiDisplayPrefs.js');
const { readFileSync } = await import('node:fs');
const { realpathSync } = await import('node:fs');
const { TUI_BASE } = await import('./tui-base.mjs');

// --- 1. каталог ---------------------------------------------------------------
test('SPINNER_CATALOG: ≥40 стилей, валидные записи, MIT-заголовок', () => {
    const names = Object.keys(cat.SPINNER_CATALOG);
    assert.ok(names.length >= 40, `стилей ${names.length}`);
    for (const name of names) {
        const e = cat.SPINNER_CATALOG[name];
        assert.ok(Array.isArray(e.frames) && e.frames.length >= 2, `${name}: frames`); // 2-кадровые (toggle) валидны
        assert.ok(typeof e.interval === 'number' && e.interval >= 10 && e.interval <= 500, `${name}: interval ${e.interval}`);
        assert.ok(['main', 'subagent', 'toolCard', 'any'].includes(e.place), `${name}: place ${e.place}`);
    }
    const src = readFileSync(realpathSync(TUI_BASE + '/lib/types/spinnerCatalog.js'), 'utf8');
    assert.ok(src.includes('MIT License') && src.includes('Sindre Sorhus'), 'MIT-заголовок');
});

test('каталог: ключевые семейства присутствуют', () => {
    for (const name of ['dots', 'bounce', 'arrow', 'moon', 'clock', 'aesthetic', 'toggle', 'pong', 'shark', 'bouncingBar']) {
        assert.ok(name in cat.SPINNER_CATALOG, name);
    }
});

// --- 2. резолв ----------------------------------------------------------------
test('getSpinnerStyle: имя → entry; пусто/мусор → undefined', () => {
    const e = cat.getSpinnerStyle('moon');
    assert.ok(e && e.frames.length >= 3);
    assert.strictEqual(cat.getSpinnerStyle(''), undefined);
    assert.strictEqual(cat.getSpinnerStyle('no-such-style'), undefined);
});

// --- 3. места -----------------------------------------------------------------
test('spinnerNamesFor: непустые списки для всех мест', () => {
    for (const place of ['main', 'subagent', 'toolCard']) {
        const names = cat.spinnerNamesFor(place);
        assert.ok(names.length >= 5, `${place}: ${names.length}`);
    }
});

// --- 4. конфиг ----------------------------------------------------------------
test('normalizeSpinnerPrefs: имена каталога или пусто; мусор → undefined', () => {
    assert.deepStrictEqual(prefs.normalizeSpinnerPrefs({ main: 'moon', subagent: '', toolCard: 'toggle' }),
        { main: 'moon', subagent: '', toolCard: 'toggle' });
    assert.strictEqual(prefs.normalizeSpinnerPrefs(undefined), undefined);
    assert.strictEqual(prefs.normalizeSpinnerPrefs({}), undefined);
    assert.strictEqual(prefs.normalizeSpinnerPrefs({ main: 'bogus' }), undefined);
    // частичный объект: отсутствующие ключи → '' (дефолт-стиль)
    assert.deepStrictEqual(prefs.normalizeSpinnerPrefs({ main: 'pong' }), { main: 'pong', subagent: '', toolCard: '' });
});
