#!/usr/bin/env node
// tests/tool-progress.test.js — unit-тесты патча 41 «tool-progress»
// (TG-DSH-TUI-HUB-20260918, узел 2): парсинг прогресса из вывода инструмента.
//
// РАССЛЕДОВАНИЕ (зафиксировано в reports/hub-wave-20260918.md §tool-progress):
// канал не стримит вывод инструмента — tool/result приходит один раз по
// завершении (channel.js case 'tool/result'); assistant/chunk несёт только
// текст/reasoning/АРГУМЕНТЫ вызова. Значит прогресс-бар в tool-карточке —
// ретроспективный разбор финального вывода (последнее известное состояние
// curl/wget/tqdm), НЕ живое обновление. Живое = elapsed-тик карточки.
//
// Контракт (TDD red, ДО реализации):
//   parseToolProgress(text) → {kind, percent?, bytes?, speed?, bar?} | undefined:
//     - curl: ' 45% 12.3M 5.67M/s' / '100 1200k 100 300k 0:00:04 0:00:03 300k' —
//       столбцовый формат: total-frac % received total speed;
//     - wget: '[=====>    ] 12,345/45,678 (27%)';
//     - tqdm: ' 57%|█████▎    | 57/100 [00:03<00:02, 19.1it/s]';
//     - посторонний текст → undefined (не выдумываем).
//   toolProgressCells(progress): {fill, track} — суб-ячеечный бар по percent.
//   Эффект-реестр: ключ 'toolProgressBars' (default ON, opt-out custom).
// Запуск: node --test tests/tool-progress.test.js

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { importTuiModule } from './tui-base.mjs';

const tp = await importTuiModule('lib/types/toolProgress.js');
const anim = await importTuiModule('lib/types/animationsMode.js');

beforeEach(() => {
    delete process.env.DSH_TUI_ANIMATIONS;
    delete process.env.DSH_TUI_REDUCED_MOTION;
    anim.setAnimationsMode(undefined);
    anim.setEffectsMode(undefined);
});

// --- curl ---------------------------------------------------------------------

test('curl: столбцовый формат с % и скоростью', () => {
    const p = tp.parseToolProgress(' 45 12.3M   0  45 5600k   0 0:00:02 0:00:02 2700k');
    assert.ok(p, 'не распознан');
    assert.strictEqual(p.kind, 'curl');
    assert.strictEqual(p.percent, 45);
    assert.match(p.speed ?? '', /2700k/);
});

test('curl: старый формат с progress bar и total %', () => {
    const p = tp.parseToolProgress('## 100%[====================================>] 12.58M  5.60MB/s');
    assert.ok(p);
    assert.strictEqual(p.percent, 100);
    assert.strictEqual(p.kind, 'curl');
});

test('curl: реальный хвост с частичной загрузкой', () => {
    const p = tp.parseToolProgress(' 57  7.2M    0  7.2M   0     0  0:00:01 0:00:01 8.1M');
    assert.ok(p);
    assert.strictEqual(p.percent, 57);
});

// --- wget ---------------------------------------------------------------------

test('wget: [=====>] N/M (P%)', () => {
    const p = tp.parseToolProgress('[=====>          ] 12,345  45.6M/s  (27%)');
    assert.ok(p);
    assert.strictEqual(p.kind, 'wget');
    assert.strictEqual(p.percent, 27);
});

// --- tqdm ---------------------------------------------------------------------

test('tqdm: проценты с баром и скоростью', () => {
    const p = tp.parseToolProgress(' 57%|██████████▎        | 57/100 [00:03<00:02, 19.1it/s]');
    assert.ok(p);
    assert.strictEqual(p.kind, 'tqdm');
    assert.strictEqual(p.percent, 57);
    assert.match(p.speed ?? '', /19\.1it\/s/);
});

// --- честность ----------------------------------------------------------------

test('посторонний текст → undefined (не выдумываем)', () => {
    assert.strictEqual(tp.parseToolProgress('hello world'), undefined);
    assert.strictEqual(tp.parseToolProgress(''), undefined);
    assert.strictEqual(tp.parseToolProgress(undefined), undefined);
    assert.strictEqual(tp.parseToolProgress('grep 100 lines'), undefined);
});

test('последнее вхождение паттерна побеждает (хвост вывода)', () => {
    const text = 'line1\n 10 1.2M 0 1.2M 0 0 0:00:01 0:00:09 500k\n...\n 90 10.8M 0 10.8M 0 0 0:00:09 0:00:01 1.2M';
    const p = tp.parseToolProgress(text);
    assert.ok(p);
    assert.strictEqual(p.percent, 90);
});

test('percent clamped 0..100', () => {
    const p = tp.parseToolProgress('[=>] 5/4 (125%)');
    assert.ok(p);
    assert.strictEqual(p.percent, 100);
});

// --- бар ----------------------------------------------------------------------

test('toolProgressCells: суб-ячеечный бар по percent', () => {
    const cells = tp.toolProgressCells({ percent: 50 }, 8);
    assert.strictEqual(cells.fill.length + cells.track.length, 8);
    const q = tp.toolProgressCells({ percent: 25 }, 8);
    assert.ok(q.fill.length >= 1 && q.fill.length <= 3, q.fill);
    const full = tp.toolProgressCells({ percent: 100 }, 8);
    assert.strictEqual(full.fill.length, 8);
    assert.strictEqual(full.track, '');
});

test('реестр: ключ toolProgressBars (default ON, opt-out custom)', () => {
    assert.ok(anim.EFFECT_KEYS.includes('toolProgressBars'));
    anim.setAnimationsMode('full');
    assert.strictEqual(anim.effectEnabled('toolProgressBars'), true);
    anim.setAnimationsMode('custom');
    assert.strictEqual(anim.effectEnabled('toolProgressBars'), true);
    anim.setEffectsMode({ toolProgressBars: false });
    assert.strictEqual(anim.effectEnabled('toolProgressBars'), false);
});
