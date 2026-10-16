#!/usr/bin/env node
// tests/app-background.test.js — unit-тесты патча 36 «app-background» (узел 2
// TG-DSH-TUI-LIVE-20260917): appearance.background / env DSH_TUI_BACKGROUND /
// тема appBackground.
//
// Контракт (TDD red, ДО реализации):
//   приоритет: env DSH_TUI_BACKGROUND > settings appearance.background >
//              theme-ключ appBackground > undefined (без окраски);
//   значение — цвет в формах isValidThemeColor (#hex/rgb()/ansi256()/ansi:);
//   невалидное значение уровня — уровень пропускается (не валит резолв);
//   normalizeAppearance принимает background той же валидацией.
// Запуск: node --test tests/app-background.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTuiModule } from './tui-base.mjs';

const prefs = await importTuiModule('lib/types/tuiDisplayPrefs.js');

test('resolveAppBackground: env DSH_TUI_BACKGROUND выше settings и темы', () => {
    assert.strictEqual(
        prefs.resolveAppBackground('#00ff00', '#000000', '#111111'),
        '#00ff00');
});

test('resolveAppBackground: settings выше темы', () => {
    assert.strictEqual(
        prefs.resolveAppBackground(undefined, '#000000', '#111111'),
        '#000000');
});

test('resolveAppBackground: тема appBackground когда env и settings не заданы', () => {
    assert.strictEqual(
        prefs.resolveAppBackground(undefined, undefined, '#1a1b26'),
        '#1a1b26');
});

test('resolveAppBackground: ничего — undefined (дефолт терминала)', () => {
    assert.strictEqual(prefs.resolveAppBackground(undefined, undefined, undefined), undefined);
});

test('resolveAppBackground: невалидный уровень пропускается', () => {
    // env мусор → settings решает
    assert.strictEqual(prefs.resolveAppBackground('not-a-color', '#000000', '#111111'), '#000000');
    // env+settings мусор → тема
    assert.strictEqual(prefs.resolveAppBackground('oops', 'rgb(1,2)', '#111111'), '#111111');
    // все мусор → undefined
    assert.strictEqual(prefs.resolveAppBackground('oops', 'nope', ''), undefined);
});

test('resolveAppBackground: принимает все формы isValidThemeColor', () => {
    for (const ok of ['#000000', '#abc', '#112233ff', 'rgb(0,0,0)', 'ansi256(0)', 'ansi:black']) {
        assert.strictEqual(prefs.resolveAppBackground(ok, undefined, undefined), ok, ok);
    }
});

test('normalizeAppearance: поле background — той же валидацией, что inputBorder', () => {
    const n = prefs.normalizeAppearance({ background: '#000000' });
    assert.strictEqual(n.background, '#000000');
    const trimmed = prefs.normalizeAppearance({ background: '  #1a1b26  ' });
    assert.strictEqual(trimmed.background, '#1a1b26');
    const bad = prefs.normalizeAppearance({ background: 'black-ish' });
    assert.strictEqual(bad.background, undefined);
    const none = prefs.normalizeAppearance({});
    assert.strictEqual(none.background, undefined);
});
