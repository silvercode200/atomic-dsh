#!/usr/bin/env node
// tests/appearance-settings.test.js — unit-тесты патча 31 «appearance-settings»
// (dsh-overrides 31, TG-DSH-TUI-STYLE2-20260917, node settings-appearance).
//
// Тестирует НОВЫЕ экспорты живого TUI-пакета (как repetition-guard тестирует
// патч 9): normalizeAppearance / normalizePowerlineStyle (tuiDisplayPrefs),
// powerlineStyle (StatusLine), resolvePromptAccent (PromptInput),
// resolveForcedTheme (ThemeProvider), setSettingsThemePref/settingsThemePref
// (themePrefs). Запуск: node --test tests/appearance-settings.test.js
// (или весь_SUITE: node --test tests/*.test.js).
//
// TDD: ДО патча 31 файл RED (экспортов нет → TypeError/undefined на вызове),
// после применения — GREEN. Приоритеты резолва закреплены как контракт:
//   powerline:   env DSH_TUI_POWERLINE > settings appearance.powerline > 'full'
//   theme:       prop > env DSH_TUI_THEME > settings appearance.theme > theme.json
//   inputBorder: planMode > /color (session) > settings inputBorder > promptBorder

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { importTuiModule } from './tui-base.mjs';

const prefs = await importTuiModule('lib/types/tuiDisplayPrefs.js');
const statusLine = await importTuiModule('lib/types/screens/StatusLine.js');
const promptInput = await importTuiModule('lib/types/components/PromptInput.js');
const themeProvider = await importTuiModule('lib/types/components/design-system/ThemeProvider.js');
const themePrefs = await importTuiModule('lib/types/themePrefs.js');

const cleanPowerlineEnv = () => { delete process.env.DSH_TUI_POWERLINE; };
const cleanThemeEnv = () => { delete process.env.DSH_TUI_THEME; };

beforeEach(() => { cleanPowerlineEnv(); cleanThemeEnv(); });

// --- (а) appearance-дефолты читаются + нормализация -------------------------

test('normalizeAppearance: unset/garbage input yields all-undefined defaults', () => {
    const d = prefs.normalizeAppearance(undefined);
    assert.strictEqual(d.powerline, undefined);
    assert.strictEqual(d.theme, undefined);
    assert.strictEqual(d.inputBorder, undefined);
    // null / не-объект / массив — тот же контракт, что normalizeStatusBar
    for (const bad of [null, 'x', 5, [], [{ powerline: 'off' }]]) {
        const n = prefs.normalizeAppearance(bad);
        assert.strictEqual(n.powerline, undefined);
        assert.strictEqual(n.theme, undefined);
        assert.strictEqual(n.inputBorder, undefined);
    }
});

test('normalizeAppearance: valid values survive, invalid are dropped per-field', () => {
    const n = prefs.normalizeAppearance({
        powerline: 'plain',
        theme: 'tokyonight-moon',
        inputBorder: '#7aa2f7',
        bogus: 'ignored',
    });
    assert.strictEqual(n.powerline, 'plain');
    assert.strictEqual(n.theme, 'tokyonight-moon');
    assert.strictEqual(n.inputBorder, '#7aa2f7');
    // каждое поле валидируется независимо: bad powerline не роняет theme
    const p = prefs.normalizeAppearance({ powerline: 'FULL', theme: 'dark' });
    assert.strictEqual(p.powerline, undefined);
    assert.strictEqual(p.theme, 'dark');
});

test('normalizeAppearance: inputBorder accepts only customTheme color forms', () => {
    // те же формы, что isValidThemeColor (customTheme.js): #rgb/#rrggbb/
    // #rrggbbaa, rgb(r,g,b), ansi256(n), 16 ansi:-имён
    for (const ok of ['#7aa2f7', '#abc', '#112233ff', 'rgb(122,162,247)', 'ansi256(99)', 'ansi:red', 'ansi:whiteBright']) {
        assert.strictEqual(prefs.normalizeAppearance({ inputBorder: ok }).inputBorder, ok, ok);
    }
    for (const bad of ['7aa2f7', 'red', 'promptBorder', '#12345', 'rgb(1,2)', 'ansi256(999)', 'plain not a color', '']) {
        assert.strictEqual(prefs.normalizeAppearance({ inputBorder: bad }).inputBorder, undefined, bad);
    }
});

test('normalizeAppearance: theme trims, empty theme means unset', () => {
    assert.strictEqual(prefs.normalizeAppearance({ theme: '  tokyonight-moon  ' }).theme, 'tokyonight-moon');
    assert.strictEqual(prefs.normalizeAppearance({ theme: '   ' }).theme, undefined);
    assert.strictEqual(prefs.normalizeAppearance({ theme: '' }).theme, undefined);
});

test('normalizePowerlineStyle: enum full|plain|off, всё остальное → undefined', () => {
    assert.strictEqual(prefs.normalizePowerlineStyle('full'), 'full');
    assert.strictEqual(prefs.normalizePowerlineStyle('plain'), 'plain');
    assert.strictEqual(prefs.normalizePowerlineStyle('off'), 'off');
    assert.strictEqual(prefs.normalizePowerlineStyle('FULL'), undefined);
    assert.strictEqual(prefs.normalizePowerlineStyle(''), undefined);
    assert.strictEqual(prefs.normalizePowerlineStyle(undefined), undefined);
});

// --- (б) приоритет powerline: env > settings > 'full' ------------------------

test('powerlineStyle: settings appearance.powerline is the middle layer', () => {
    const fn = statusLine.powerlineStyle;
    assert.strictEqual(typeof fn, 'function');
    // settings-слой читается из channel.appearance
    assert.strictEqual(fn({ appearance: { powerline: 'off' } }), 'off');
    assert.strictEqual(fn({ appearance: { powerline: 'plain' } }), 'plain');
    // отсутствие/невалидность → дефолт 'full'
    assert.strictEqual(fn({}), 'full');
    assert.strictEqual(fn({ appearance: {} }), 'full');
    assert.strictEqual(fn({ appearance: { powerline: 'bogus' } }), 'full');
    assert.strictEqual(fn(undefined), 'full');
});

test('powerlineStyle: env DSH_TUI_POWERLINE beats settings', () => {
    process.env.DSH_TUI_POWERLINE = 'off';
    assert.strictEqual(statusLine.powerlineStyle({ appearance: { powerline: 'full' } }), 'off');
    process.env.DSH_TUI_POWERLINE = 'plain';
    assert.strictEqual(statusLine.powerlineStyle({ appearance: { powerline: 'off' } }), 'plain');
    delete process.env.DSH_TUI_POWERLINE;
    // без env settings снова решает
    assert.strictEqual(statusLine.powerlineStyle({ appearance: { powerline: 'off' } }), 'off');
});

// --- (в) inputBorder в цепочке promptAccent ----------------------------------
// Приоритет: planMode > /color (сессионный) > settings inputBorder > тема.

test('resolvePromptAccent: planMode wins over everything', () => {
    const fn = promptInput.resolvePromptAccent;
    assert.strictEqual(typeof fn, 'function');
    assert.strictEqual(fn(true, 'red', '#7aa2f7'), 'planMode');
    assert.strictEqual(fn(true, '', '#7aa2f7'), 'planMode');
});

test('resolvePromptAccent: /color session accent beats settings inputBorder', () => {
    assert.strictEqual(promptInput.resolvePromptAccent(false, 'red', '#7aa2f7'), '#E5484D');
    assert.strictEqual(promptInput.resolvePromptAccent(false, 'blue', '#7aa2f7'), '#3E63DD');
});

test('resolvePromptAccent: settings inputBorder beats theme promptBorder key', () => {
    assert.strictEqual(promptInput.resolvePromptAccent(false, '', '#7aa2f7'), '#7aa2f7');
    assert.strictEqual(promptInput.resolvePromptAccent(false, undefined, 'rgb(122,162,247)'), 'rgb(122,162,247)');
    assert.strictEqual(promptInput.resolvePromptAccent(false, '', 'ansi256(99)'), 'ansi256(99)');
});

test('resolvePromptAccent: invalid/absent inputBorder falls to theme promptBorder', () => {
    assert.strictEqual(promptInput.resolvePromptAccent(false, '', undefined), 'promptBorder');
    assert.strictEqual(promptInput.resolvePromptAccent(false, '', ''), 'promptBorder');
    assert.strictEqual(promptInput.resolvePromptAccent(false, '', 'not-a-color'), 'promptBorder');
    assert.strictEqual(promptInput.resolvePromptAccent(false, '', '  #7aa2f7  '), '#7aa2f7'); // trim
});

// --- (г) appearance.theme резолвится в ThemeProvider выше theme.json ---------

test('settingsThemePref: module-level round-trip, empty/undefined clears', () => {
    assert.strictEqual(typeof themePrefs.setSettingsThemePref, 'function');
    themePrefs.setSettingsThemePref('tokyonight-moon');
    assert.strictEqual(themePrefs.settingsThemePref(), 'tokyonight-moon');
    themePrefs.setSettingsThemePref(undefined);
    assert.strictEqual(themePrefs.settingsThemePref(), undefined);
    themePrefs.setSettingsThemePref('');
    assert.strictEqual(themePrefs.settingsThemePref(), undefined);
    themePrefs.setSettingsThemePref('   ');
    assert.strictEqual(themePrefs.settingsThemePref(), undefined);
});

test('resolveForcedTheme: settings theme sits between env and theme.json', () => {
    const fn = themeProvider.resolveForcedTheme;
    assert.strictEqual(typeof fn, 'function');
    // persisted (theme.json) — нижний слой
    assert.strictEqual(fn(undefined, undefined, 'tokyonight-moon'), 'tokyonight-moon');
    // settings theme ВЫШЕ persisted
    assert.strictEqual(fn(undefined, 'dark', 'tokyonight-moon'), 'dark');
    // env ВЫШЕ settings
    process.env.DSH_TUI_THEME = 'light';
    assert.strictEqual(fn(undefined, 'dark', 'tokyonight-moon'), 'light');
    delete process.env.DSH_TUI_THEME;
    // явный prop — выше env
    process.env.DSH_TUI_THEME = 'light';
    assert.strictEqual(fn('custom-prop', 'dark', 'tokyonight-moon'), 'custom-prop');
    delete process.env.DSH_TUI_THEME;
});

test('resolveForcedTheme: unavailable settings theme falls through to theme.json', () => {
    const fn = themeProvider.resolveForcedTheme;
    // невалидное имя из settings не должно глушить /theme-персист
    assert.strictEqual(fn(undefined, 'definitely-not-a-theme-xyz', 'tokyonight-moon'), 'tokyonight-moon');
    // и пустая строка settings theme = unset
    assert.strictEqual(fn(undefined, '', 'tokyonight-moon'), 'tokyonight-moon');
});
