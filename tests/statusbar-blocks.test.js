#!/usr/bin/env node
// tests/statusbar-blocks.test.js — unit-тесты патча 47 «statusbar-blocks»
// (узел 2 TG-DSH-HUB-SETTINGS-20260918): все добавленные нами кастомные
// элементы статус-бара и отображения (патчи 40-43: glyph-бары, tool-progress,
// спарклайны; + более ранние: субагент-иконка ◐, mks-поля, таймер) —
// первоклассные тумблеры в /settings (группа Status bar).
//
// Покрытие (по инвентарю волны: powerline-таймер, mks-поля spending/
// realModel/compactProgress/compactThresholdRatio, спарклайны, субагент-
// индикаторы ◐ в GoalTodoPanel, авто-разворот, ширина спарклайна):
//   1. DEFAULT_STATUS_BAR: timer/subagentRows/subagentAutoExpand (default
//      true) — новые гейты;
//   2. normalizeStatusBar: новые ключи проходят; ctxBarMode/spending/
//      realModel/compactProgress/compactThresholdRatio — как раньше;
//   3. normalizeAppearance: sparkWidth enum ('8'|'16'|'24'|'32');
//   4. plugin.js: schema-ключи + поля в группе status-bar с demo;
//   5. StatusLine.js: гейт таймер-сегмента (statusBar.timer), гейт
//      подмены модели mks (statusBar.realModel), ширина спарклайна из
//      channel.appearance.sparkWidth;
//   6. GoalTodoPanel.js: гейты subagentRows (строки ◐ + счётчик agents) и
//      subagentAutoExpand (авто-разворот патча 27);
//   7. Дублей гейтов эффектов НЕТ (sparkTps/sparkCache/toolProgress*
//      остаются за effectEnabled — новых эффект-ключей не добавляется).
// Запуск: node --test tests/statusbar-blocks.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';

import { importTuiModule, TUI_BASE } from './tui-base.mjs';

const live = (rel) => readFileSync(realpathSync(`${TUI_BASE}/${rel}`), 'utf8');

// --- 1-2. Гейты в дефолтах и нормализация ---------------------------------------
test('DEFAULT_STATUS_BAR: timer/subagentRows/subagentAutoExpand = true (наши блоки гейтятся)', async () => {
    const prefs = await importTuiModule('lib/types/tuiDisplayPrefs.js');
    assert.strictEqual(prefs.DEFAULT_STATUS_BAR.timer, true, 'timer');
    assert.strictEqual(prefs.DEFAULT_STATUS_BAR.subagentRows, true, 'subagentRows');
    assert.strictEqual(prefs.DEFAULT_STATUS_BAR.subagentAutoExpand, true, 'subagentAutoExpand');
    // Существующие ключи на месте (регрессия).
    assert.strictEqual(prefs.DEFAULT_STATUS_BAR.spending, true);
    assert.strictEqual(prefs.DEFAULT_STATUS_BAR.realModel, true);
    assert.strictEqual(prefs.DEFAULT_STATUS_BAR.compactProgress, true);
    assert.strictEqual(prefs.DEFAULT_STATUS_BAR.ctxBarMode, 'full');
});

test('normalizeStatusBar: новые гейты проходят, мусор дропается', async () => {
    const prefs = await importTuiModule('lib/types/tuiDisplayPrefs.js');
    const out = prefs.normalizeStatusBar({
        timer: false,
        subagentRows: false,
        subagentAutoExpand: false,
        ctxBarMode: 'narrow',
        spending: false,
        realModel: false,
        compactProgress: false,
        compactThresholdRatio: 0.5,
    });
    assert.strictEqual(out.timer, false);
    assert.strictEqual(out.subagentRows, false);
    assert.strictEqual(out.subagentAutoExpand, false);
    assert.strictEqual(out.ctxBarMode, 'narrow');
    assert.strictEqual(out.spending, false);
    assert.strictEqual(out.realModel, false);
    assert.strictEqual(out.compactProgress, false);
    assert.strictEqual(out.compactThresholdRatio, 0.5);
    // Мусор не пролезает.
    const bad = prefs.normalizeStatusBar({ timer: 'nope', subagentRows: 1 });
    assert.strictEqual(bad.timer, true, 'невалидный timer → default true');
    assert.strictEqual(bad.subagentRows, true, 'невалидный subagentRows → default true');
});

// --- 3. sparkWidth ----------------------------------------------------------------
test('normalizeAppearance: sparkWidth — enum ширины спарклайна', async () => {
    const prefs = await importTuiModule('lib/types/tuiDisplayPrefs.js');
    assert.strictEqual(prefs.normalizeAppearance({ sparkWidth: '24' }).sparkWidth, '24');
    assert.strictEqual(prefs.normalizeAppearance({ sparkWidth: '16' }).sparkWidth, '16');
    assert.strictEqual(prefs.normalizeAppearance({ sparkWidth: '99' }).sparkWidth, undefined, 'мусор дропается');
    assert.strictEqual(prefs.normalizeAppearance({ sparkWidth: 16 }).sparkWidth, undefined, 'число (не строка enum) дропается');
});

// --- 4. plugin.js: schema + поля ---------------------------------------------------
test('plugin.js: schema-ключи timer/subagentRows/subagentAutoExpand/sparkWidth + поля в /settings', async () => {
    const src = live('lib/types/dsh-adapter/plugin.js');
    assert.ok(src.includes("timer: Schema.boolean().default(DEFAULT_STATUS_BAR.timer)"), 'schema statusBar.timer');
    assert.ok(src.includes("subagentRows: Schema.boolean().default(DEFAULT_STATUS_BAR.subagentRows)"), 'schema statusBar.subagentRows');
    assert.ok(src.includes("subagentAutoExpand: Schema.boolean().default(DEFAULT_STATUS_BAR.subagentAutoExpand)"), 'schema statusBar.subagentAutoExpand');
    assert.ok(src.includes("sparkWidth: Schema.union(['8', '16', '24', '32'])"), 'schema appearance.sparkWidth');
});

test('hubSettingsSectionParts: поля наших блоков в группе status-bar с демо', async () => {
    const hubSettings = await importTuiModule('lib/types/components/hubSettings.js');
    const parts = hubSettings.hubSettingsSectionParts();
    const byPath = new Map(parts.fields.map(f => [f.path.join('.'), f]));
    const expect = [
        'statusBar.timer',
        'statusBar.spending',
        'statusBar.realModel',
        'statusBar.compactProgress',
        'statusBar.compactThresholdRatio',
        'statusBar.subagentRows',
        'statusBar.subagentAutoExpand',
        'appearance.sparkWidth',
    ];
    for (const p of expect) {
        const field = byPath.get(p);
        assert.ok(field !== undefined, `поле ${p}`);
        assert.strictEqual(field.group, 'status-bar', `${p} в группе status-bar`);
        assert.ok(typeof field.demo === 'string', `${p} имеет demo`);
        assert.ok(typeof hubSettings.HUB_FIELD_DEMOS[field.demo] === 'function', `демо-компонент ${field.demo} зарегистрирован`);
    }
});

// --- 5. StatusLine.js: гейты таймера и realModel, ширина спарклайна ----------------
test('StatusLine.js: таймер-сегмент гейтится statusBar.timer', async () => {
    const src = live('lib/types/screens/StatusLine.js');
    assert.ok(src.includes('statusBar.timer'), 'гейт таймер-сегмента');
});

test('StatusLine.js: подмена модели mks гейтится statusBar.realModel', async () => {
    const src = live('lib/types/screens/StatusLine.js');
    assert.ok(src.includes('statusBar.realModel'), 'гейт подмены модели (мёртвый ключ wired)');
});

test('StatusLine.js: спарклайн берёт ширину из channel.appearance.sparkWidth', async () => {
    const src = live('lib/types/screens/StatusLine.js');
    assert.ok(src.includes('sparkWidth'), 'потребитель ширины спарклайна');
});

// --- 6. GoalTodoPanel.js: гейты субагент-индикаторов -------------------------------
test('GoalTodoPanel.js: subagentRows гейтит ◐-строки и счётчик agents; subagentAutoExpand — авто-разворот', async () => {
    const src = live('lib/types/components/GoalTodoPanel.js');
    assert.ok(src.includes('subagentRows'), 'гейт ◐-строк/счётчика');
    assert.ok(src.includes('subagentAutoExpand'), 'гейт авто-разворота (патч 27)');
});

// --- 7. Нет дублей гейтов эффектов --------------------------------------------------
test('EFFECT_KEYS: новых ключей нет (гейты sparkTps/sparkCache/toolProgressBars не дублируются)', async () => {
    const before = [
        'inputBorderBreath', 'todoPulse', 'todoProgressBar', 'headerGlimmer',
        'ctxBarBreath', 'toolCardShimmer', 'spinnerRainbow', 'spinnerGlimmer',
        'headerTextGradient', 'subCellBars', 'barGradientFill',
        'toolProgressBars', 'sparkTps', 'sparkCache',
    ];
    const { EFFECT_KEYS } = await importTuiModule('lib/types/animationsMode.js');
    assert.deepEqual([...EFFECT_KEYS].sort(), [...before].sort(), 'реестр эффектов не расширялся');
});

// --- 8. channel.setAppearance несёт sparkWidth (live-применение) ---------------------
test('channel.js: setAppearance реагирует на sparkWidth', async () => {
    const src = live('lib/types/dsh-adapter/channel.js');
    assert.ok(src.includes('sparkWidth'), 'sparkWidth в changed-чеке setAppearance');
});
