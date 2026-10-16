#!/usr/bin/env node
// tests/footer-jitter.test.js — unit-тесты патча 48 «fix-jitter» (узел 4
// TG-DSH-HUB-SETTINGS-20260918): футер НЕ меняет высоту.
//
// КОНТРАКТ (TDD red):
//   1. stableTimerText (StatusLine): текст таймер-сегмента паддингится до
//      стабильной ширины — formatDuration пилил '59s'(3)→'1m'(2)→'1m 1s'(5)
//      каждую секунду и перестраивал powerline-ряд (footer-gap §3);
//   2. Chat.js: рабочий слот — всегда смонтированная ячейка фикс. высоты
//      (height 2 + overflow hidden): появление/исчезновение WorkingSpinner
//      меняло футер 6→8 и флапало пин-гистерезис;
//   3. StatusLine.js: кламп height:1 + overflow:hidden на ОСТАВШИХСЯ ветках
//      статус-ряда (compact и plain/stok — 45-й закрыл только powerline).
// Запуск: node --test tests/footer-jitter.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';

import { importTuiModule, TUI_BASE } from './tui-base.mjs';

const live = (rel) => readFileSync(realpathSync(`${TUI_BASE}/${rel}`), 'utf8');
const width = (s) => [...String(s)].length;

test('stableTimerText: экспорт + стабильная ширина через минутную границу', async () => {
    const statusLine = await importTuiModule('lib/types/screens/StatusLine.js');
    assert.ok(typeof statusLine.stableTimerText === 'function', 'экспорт stableTimerText');
    // Пила формата: '59s'(3) → '1m'(2) → '1m 1s'(5) → '2m'(2)…
    const samples = [
        statusLine.stableTimerText(1_000),
        statusLine.stableTimerText(59_000),
        statusLine.stableTimerText(60_000),
        statusLine.stableTimerText(61_000),
        statusLine.stableTimerText(119_000),
        statusLine.stableTimerText(120_000),
        statusLine.stableTimerText(3_540_000), // 59m
        statusLine.stableTimerText(3_599_000), // 59m 59s
    ];
    const widths = new Set(samples.map(width));
    assert.strictEqual(widths.size, 1, `все сэмплы одной ширины, получено: ${[...widths].join(',')} (${samples.join('|')})`);
    // Содержимое честное (не пробелы целиком): цифры присутствуют.
    assert.ok(/\d/.test(samples[1].trim()), 'текст содержит время');
});

test('StatusLine.js: таймер-сегмент рендерит stableTimerText (не сырой formatDuration)', async () => {
    const src = live('lib/types/screens/StatusLine.js');
    assert.ok(src.includes('stableTimerText(elapsed)'), 'TurnTimerSegment использует stableTimerText');
    assert.ok(src.includes('stringWidth(stableTimerText(elapsed))'), 'ширина сегмента считается от стабильного текста');
});

test('Chat.js: рабочий слот фиксированной высоты (спиннер не меняет высоту футера)', async () => {
    const src = live('lib/types/screens/Chat.js');
    // Слот всегда смонтирован, height 2 + overflow hidden; working — внутри.
    assert.ok(src.includes('height: 2, flexShrink: 0, overflow: "hidden"'), 'фикс. ячейка height:2 + overflow hidden');
    const slotIdx = src.indexOf('height: 2, flexShrink: 0, overflow: "hidden"');
    const after = src.slice(slotIdx, slotIdx + 600);
    assert.ok(after.includes('channel.working ?'), 'working-ветка внутри слота');
    assert.ok(!/channel\.working &&\s*\n?\s*\(channel\.activityEnabled/.test(src), 'старый условный монтаж спиннера удалён');
});

test('StatusLine.js: compact- и plain-ветки статус-ряда закламплены (height 1)', async () => {
    const src = live('lib/types/screens/StatusLine.js');
    // compact-ветка
    assert.ok(src.includes('statusBar.compact ? (_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", gap: 2, height: 1, overflow: "hidden"'), 'compact-ветка: height 1 + overflow hidden');
    // plain/stok-ветка (else-хвост тернарника)
    assert.ok(src.includes('(_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", gap: 2, height: 1, overflow: "hidden"'), 'plain-ветка: height 1 + overflow hidden');
});
